/**
 * 问题会话工作区回收(纯旁路):终态会话过了保留期,删掉能再生的重货,
 * 台账原样留下。需求流 reclaimIdleWorkspaces(src/workspaceReclaim.ts,
 * 2026-08-22)的问题流对应物——问题单的仓克隆/ref/pipeline 镜像此前
 * 永不回收,服务器磁盘只涨不降。
 *
 * 与需求流先例刻意不同的两点,都是拍板(2026-09-03,spec #79 第 6 项):
 *
 * 1. **用"删什么"点名清单,不用"留什么"白名单。** 需求流现场以克隆为
 *    主体,白名单(留台账、清其余)才点得全;问题会话的现场根目录下
 *    台账条目又碎又多(issue.json/events/transcript/waiting/feedback/
 *    reviews/issue-images/...),白名单漏一条就是烧台账。所以这里反着
 *    来:只删下面点名的重货目录,没点名的——包括以后新增的未知条目
 *    ——一律保留。"不确定属于重货还是台账的倾向保留"是红线原文。
 *
 * 2. **保守四保险,一票否决**:状态终态(归档/取消/失败,isTerminal)×
 *    终态时间过保留期 × 容器探活不在跑 × 路径边界在本 dataDir 内。
 *    非终态一概不碰;保留期 0 = 永不回收;判不了年纪(没有可信终态
 *    时间)不下手。回收纯旁路 fail-open:单会话失败不影响其他会话,
 *    更不影响服务。
 *
 * 解耦纪律:本模块不 import IssueFlowService/TaskService——扫盘自己来,
 * 容器探活由调用方注入谓词,保留期由调用方传入(serve 复用需求流的
 * workspaceRetentionDays(),两流同一旋钮,不新增配置项)。
 */

import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { isTerminal, loadState } from "./issueFlow/state.ts";
import { humanBytes, withinDataDir } from "./workspaceReclaim.ts";

/**
 * 回收时点名的重货目录(会话根一级)。加条目就是在说"这东西确认是
 * 能再生的重货",请连证据一起写;拿不准就别加——留着只占地方,删错
 * 烧的是复盘现场。
 */
export const ISSUE_RECLAIM_HEAVY: readonly string[] = [
  "repo",         // 平铺的全部代码仓克隆(2026-08-28 后唯一布局),最大重货
  "ref",          // 平铺前的老布局参考仓,存量终态会话可能还留着
  "pipeline",     // 流水线镜像产物(红灯日志、构建输出)。需求流把这类
                  // 日志当交付证据保留,问题流仍可删:权威裁决在平台流水
                  // 线本身,且本回收只对终态+过保留期的会话动手——到那
                  // 时本地留档的复盘价值已被平台侧取代,留着只剩占盘。
  "local-logs",   // 网管抓取的现场日志(转正路径明确不带:新一轮要拉新日志)
  "pi-agent",     // Agent 运行时目录(需求流同款回收:models.json 躺着密钥)
  "vision-cache", // 图片分析缓存(名字即语义,inspect_image 时可重建)
  ".ops-tools",   // 分发进会话的 ops 二进制(每次开容器 stageOpsBinaries 重放)
];

/** 回收扫描的会话目录名约定(与 IssueFlowService.recover() 同一把尺子)。 */
const ISSUE_DIR_PREFIX = "issue-";

const DAY_MS = 24 * 60 * 60_000;

function instant(value: unknown): number {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : NaN;
}

export type IssueReclaimSkipCode =
  | "retention_off"      // 保留期 0 = 永不回收
  | "not_terminal"       // 非终态(running/waiting_user/idle/suspended/queued)
  | "container_running"  // 容器探活为真(belt-and-suspenders)
  | "no_timestamp"       // 判不了年纪:没有可信的终态时间
  | "not_expired";       // 终态但未过保留期

export interface IssueReclaimVerdict {
  reclaim: boolean;
  /** 说人话的理由,直接进日志——回收不可逆,得说清凭什么。 */
  reason: string;
  /** 机器可读的跳过原因(调用方统计"容器在跑跳过"这类数字用)。 */
  skip?: IssueReclaimSkipCode;
}

/** 判据的输入面:只取 issue.json 里裁决要用的字段(纯函数,好测)。 */
export interface IssueReclaimCandidate {
  id: string;
  status: string;
  /** 结论时刻(归档/转正收口必写,归档路的终态锚)。 */
  concluded_at?: string;
  /** 最后一次落盘时刻(saveState 盖章;取消/失败路的终态锚)。 */
  updated_at?: string;
}

/**
 * 判不判得回收(纯函数,好测)。四保险里的前三个在这里,边界闸在删除
 * 动作自己身上(删除必须自证,不信调用方)。
 *
 * 终态时间锚的选取:归档/转正三条路都写 conclusion.at(结论时刻,语义
 * 就叫"收口");取消/失败没有专门的终态字段,但它们的终态落盘就是最后
 * 一次 saveState——updated_at 即收口时刻。所以 [conclusion.at,
 * updated_at] 取第一个读得动的;两个都读不出来**不回收**,宁可留着占
 * 地方,也不许猜着删(与需求流 judgeReclaim 同一纪律)。
 */
export function judgeIssueReclaim(
  issue: IssueReclaimCandidate,
  options: {
    now: number;
    retentionDays: number;
    containerRunning?: boolean;
  },
): IssueReclaimVerdict {
  const { now, retentionDays } = options;
  if (!(retentionDays > 0)) {
    return { reclaim: false, reason: "保留期配置为 0,永不回收", skip: "retention_off" };
  }
  if (!isTerminal(issue.status as Parameters<typeof isTerminal>[0])) {
    return {
      reclaim: false,
      reason: `状态 ${issue.status} 不是终态(还在运行、等人或待续聊),不碰`,
      skip: "not_terminal",
    };
  }
  if (options.containerRunning) {
    return {
      reclaim: false,
      reason: "容器探活为真,保险丝起作用了,不碰",
      skip: "container_running",
    };
  }
  const settled = [issue.concluded_at, issue.updated_at]
    .map(instant).find((ms) => !Number.isNaN(ms));
  if (settled === undefined) {
    return {
      reclaim: false,
      reason: "没有可信的终态时间,判不了年纪",
      skip: "no_timestamp",
    };
  }
  const ageDays = (now - settled) / DAY_MS;
  if (ageDays < retentionDays) {
    return {
      reclaim: false,
      reason: `收口 ${ageDays.toFixed(1)} 天,未到保留期 ${retentionDays} 天`,
      skip: "not_expired",
    };
  }
  return {
    reclaim: true,
    reason: `收口 ${ageDays.toFixed(1)} 天,超过保留期 ${retentionDays} 天`,
  };
}

function sizeOf(path: string): number {
  try {
    const info = statSync(path);
    if (!info.isDirectory()) return info.size;
    let total = 0;
    for (const name of readdirSync(path)) total += sizeOf(join(path, name));
    return total;
  } catch {
    return 0;       // 量不出来不影响删,日志少个数字而已
  }
}

export interface IssueReclaimResult {
  removed: string[];
  freed: number;
  /** 被边界拦下时的原因;有值 = 一个字节都没删。 */
  refused?: string;
}

/**
 * 真删单个会话的重货。只动 ISSUE_RECLAIM_HEAVY 点名的目录,其余一律
 * 不碰(台账与未知条目天然保留)。
 *
 * 删除前自证边界(2026-08-22 的血泪:issues/ 下若被人换了软链接,
 * readdir 看着在 dataDir 里,realpath 一解在外面——删的是原件)。
 * 越界 fail-closed:一个字节都不许删。单条目删失败不中断,继续下一条。
 */
export function reclaimIssueWorkspace(
  root: string,
  options: { dataDir: string },
): IssueReclaimResult {
  const removed: string[] = [];
  let freed = 0;
  if (!withinDataDir(root, options.dataDir)) {
    return {
      removed, freed,
      refused: `会话现场 ${root} 不在本服务的数据目录 `
        + `${options.dataDir} 内,拒绝删除`,
    };
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return { removed, freed };
  }
  const heavy = new Set(ISSUE_RECLAIM_HEAVY);
  for (const name of entries) {
    if (!heavy.has(name)) continue;
    const target = join(root, name);
    const size = sizeOf(target);
    try {
      rmSync(target, { recursive: true, force: true });
      removed.push(name);
      freed += size;
    } catch {
      // 单个条目删不动(权限/占用)不中断,下一个接着来。
    }
  }
  return { removed, freed };
}

export interface IssueReclaimOptions {
  /** 服务数据目录(会话现场在 <dataDir>/issues/<id>/)。 */
  dataDir: string;
  /** 保留期(天);与需求流同一旋钮,0 = 永不回收。 */
  retentionDays: number;
  /** 容器探活谓词(注入,解耦):真 = 该会话容器还在跑,跳过。 */
  containerRunning?: (issueId: string) => boolean;
  now?: number;
  /** 旁路日志通道(单会话动作与失败;fail-open 的出口)。 */
  log?: (message: string) => void;
}

export interface IssueReclaimSummary {
  /** 真删到了东西的会话数(判了该删但已无重货的不计,日志不注水)。 */
  reclaimed: number;
  freed: number;
  /** 因容器在跑跳过的会话数(保险丝工作记录)。 */
  skipped_container: number;
  /** 单会话失败数(fail-open:失败不影响其余会话,只计数留痕)。 */
  failed: number;
}

/**
 * 扫 <dataDir>/issues/*,对满足全部条件的终态会话回收重货。
 *
 * 纯旁路 fail-open:读不动的 issue.json、删不动的目录、单个会话的任何
 * 异常,都只 log + 计数,绝不扩散到其他会话,更不许把调用方(serve 的
 * 每日清扫)带下水。保留期 0 直接短路,连盘都不扫。
 */
export function reclaimIssueWorkspaces(
  options: IssueReclaimOptions,
): IssueReclaimSummary {
  const summary: IssueReclaimSummary = {
    reclaimed: 0, freed: 0, skipped_container: 0, failed: 0,
  };
  if (!(options.retentionDays > 0)) return summary;
  const now = options.now ?? Date.now();
  const issuesRoot = join(options.dataDir, "issues");
  if (!existsSync(issuesRoot)) return summary;
  let names: string[] = [];
  try {
    names = readdirSync(issuesRoot);
  } catch (error) {
    options.log?.(`问题现场回收扫描失败(不影响服务): ${String(error)}`);
    return summary;
  }
  for (const name of names) {
    if (!name.startsWith(ISSUE_DIR_PREFIX)) continue;
    const root = join(issuesRoot, name);
    try {
      // loadState 读 issue.json 并做旧词表迁移;读不到/读坏了当没有,
      // 这个会话今天先放过(台账可能正在被人写,第二天再看)。
      const state = loadState(root);
      if (!state) continue;
      const verdict = judgeIssueReclaim({
        id: state.id,
        status: state.status,
        concluded_at: state.conclusion?.at,
        updated_at: state.updated_at,
      }, {
        now,
        retentionDays: options.retentionDays,
        containerRunning: options.containerRunning?.(state.id) ?? false,
      });
      if (verdict.skip === "container_running") summary.skipped_container += 1;
      if (!verdict.reclaim) continue;
      const result = reclaimIssueWorkspace(root, { dataDir: options.dataDir });
      if (result.refused) {
        options.log?.(`回收问题现场 ${state.id} 被边界拦下: ${result.refused}`);
        continue;
      }
      if (!result.removed.length) continue; // 已是干净现场,不计不吵
      summary.reclaimed += 1;
      summary.freed += result.freed;
      options.log?.(`回收问题现场 ${state.id}(${verdict.reason}):释放 `
        + `${humanBytes(result.freed)},删除 ${result.removed.join("、")}`
        + `;台账、材料元数据与未知条目保留`);
    } catch (error) {
      // 回收是旁路:单个会话翻车绝不影响其他会话,更不影响服务。
      summary.failed += 1;
      options.log?.(`回收问题现场 ${name} 失败(跳过,不影响其余): `
        + `${String(error)}`);
    }
  }
  return summary;
}
