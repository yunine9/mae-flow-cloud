/**
 * 现场回收(纯旁路):终态任务过了保留期,删掉能再生的重货,台账原样留下。
 *
 * 为什么需要它:每个任务把整个仓克隆进自己的现场,只涨不消。本机那个
 * 五模块玩具仓单任务就 3.7MB,其中克隆占 2.2MB;换成真实业务仓,10-20 个人
 * 用下去磁盘是按周算的。以前**一条回收策略都没有**——不是策略宽松,是压根
 * 没有(2026-08-22 查出来的)。
 *
 * 两条口径,都是有意的:
 *
 * 1. **只清编译环境,交付历史一个字节都不动。** 用户 2026-08-22 的原话是
 *    "可以清除编译环境啥的,但是交付历史数据啥的不要清除"。
 *    删的只有:代码克隆(多仓时还有 repositories/ 下那一堆)、pi 会话
 *    临时目录。留的是:task.json(含交付账本 delivery——MR 地址、
 *    流水线结论都在里面)、事件账本、transcript(含子 Agent 证据)、
 *    prepush 各轮收据、流水线事实与日志、批注和检视意见——
 *    **那是人自己写的字**。这条保证有用例钉死(tests/workspaceReclaim)。
 *
 * 2. **用"留什么"白名单,不用"删什么"黑名单。** 克隆目录名是按仓库地址
 *    算出来的(cloneRepo:`basename(source)` 去掉 `.git`),多仓需求还会
 *    在 repositories/ 下再克隆若干个——黑名单天生点不全名字,漏一个就等于
 *    没回收,而且以后每加一种现场目录都得记得回来补。白名单反过来:
 *    以后新增的东西默认被回收,**要留就必须显式写进 KEEP 并说清为什么**。
 *
 * 只碰真终态(completed/failed/canceled)。await_merge 和 verifying 还等着
 * 人合入或等着流水线,现场可能还要看,不碰——代价是这两种状态的单不会被
 * 回收,已如实记进 README 已知边界。
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";

/** 克隆被删之前,把内核阶段真相抄一份留档。
 *
 * 红线说"阶段真相只在工作区 .mae-flow.json"——那说的是**在跑的时候**谁
 * 说了算。回收之后原件已经不存在了,这份副本不构成第二个状态机,只是
 * 让两周后还答得上"这单最后停在哪一步"。名字里带 reclaimed,不许被当成
 * 活状态读。 */
export const KERNEL_STATE_SNAPSHOT = "kernel-state.reclaimed.json";

/** 回收后必须留下的现场条目(工作区根一级)。
 * 加条目就是在说"这东西删不得",请连理由一起写。 */
export const RECLAIM_KEEP: readonly string[] = [
  "task.json",           // 没它 recover() 认不出这个任务,历史整个消失
  "events.jsonl",        // 事件账本
  "transcript.jsonl",    // 质量契约证据
  "transcript",          // 子 Agent transcript(内核 hook 绑定的那套布局)
  "prepush",             // 推送前验证各 attempt 的 events/transcript
  "waiting.json",        // 等待卡留痕
  "annotations.jsonl",   // 批注:人自己写的字,永远不回收
  "reviews",             // 检视意见:同上
  "review_replies.md",   // 同上
  "pipeline-facts.json", // 流水线事实(绑 SHA 的结论)
  "pipeline",            // 流水线日志:平台上两周后可能也没了,它是交付证据
  "chain-plan.md",       // 多仓链方案,几 KB
  KERNEL_STATE_SNAPSHOT,
];

/** 只有真终态才回收:还等着人或等着流水线的单,现场可能还要看。 */
export const RECLAIMABLE_STATUS: readonly string[] = [
  "completed", "failed", "canceled",
];

export interface ReclaimCandidate {
  id: string;
  status: string;
  workspace: string;
  completed_at?: string;
  updated_at?: string;
  created_at?: string;
  workspace_reclaimed_at?: string;
}

export interface ReclaimVerdict {
  reclaim: boolean;
  /** 说人话的理由,直接进日志——回收是不可逆动作,得说清凭什么。 */
  reason: string;
}

const DAY_MS = 24 * 60 * 60_000;

function instant(value: unknown): number {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * 判不判得回收(纯函数,好测)。
 *
 * @param busy 这单此刻还有活的会话/容器句柄。哪怕状态写着终态也不碰——
 *   状态是收口那一刻写的,清理进程和收尾流程可能正擦肩而过。
 */
export function judgeReclaim(
  task: ReclaimCandidate,
  options: { now: number; retentionDays: number; busy?: boolean },
): ReclaimVerdict {
  const { now, retentionDays } = options;
  if (!(retentionDays > 0)) {
    return { reclaim: false, reason: "保留期配置为 0,永不回收" };
  }
  if (task.workspace_reclaimed_at) {
    return { reclaim: false, reason: "已经回收过" };
  }
  if (!RECLAIMABLE_STATUS.includes(task.status)) {
    return {
      reclaim: false,
      reason: `状态 ${task.status} 不是真终态(还等着人或等着流水线)`,
    };
  }
  if (options.busy) {
    return { reclaim: false, reason: "还有活的会话或容器句柄,不碰" };
  }
  // 时间锚:优先收口时刻,退到最后一次事实变更。两个都读不出来时**不回收**
  // ——判不了年纪就不许下手,宁可留着占地方,也不许猜着删。
  const settled = [task.completed_at, task.updated_at]
    .map(instant).find((ms) => !Number.isNaN(ms));
  if (settled === undefined) {
    return { reclaim: false, reason: "没有可信的收口时间,判不了年纪" };
  }
  const ageDays = (now - settled) / DAY_MS;
  if (ageDays < retentionDays) {
    return {
      reclaim: false,
      reason: `收口 ${ageDays.toFixed(1)} 天,未到保留期 ${retentionDays} 天`,
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

export function humanBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let at = 0;
  while (value >= 1024 && at < units.length - 1) { value /= 1024; at += 1; }
  return `${value >= 10 || at === 0 ? Math.round(value) : value.toFixed(1)}${units[at]}`;
}

export interface ReclaimResult {
  removed: string[];
  freed: number;
  /** 删之前把内核阶段真相抄下来了没有(抄不到不算失败:老单可能就没有)。 */
  snapshotted: boolean;
  /** 被边界拦下时的原因;有值 = 一个字节都没删。 */
  refused?: string;
}

/**
 * 删除前的边界闸:现场必须真的在本服务的 dataDir 底下。
 *
 * 这不是理论洁癖,是实测踩出来的(2026-08-22)。`summary.workspace` 是
 * 任务创建时写进 task.json 的**绝对路径**,而 `recover()` 是按
 * `dataDir/task-N` 扫目录认任务的——两者在正常情况下相等,但只要现场
 * 目录被**拷走或搬走**(备份、复制一份出来排障、换挂载点),恢复出来的
 * 任务就会带着老路径,而删除动作会照着老路径下手。
 *
 * 我自己就这么干了一次:把 .pilot 现场拷到临时目录跑回收验证,结果删的是
 * **原件**。读侧按老路径读只是读不到,删侧按老路径删是真没了。
 *
 * 所以这里 fail-closed:越界一律拒绝,不"尽力而为"。realpath 比对而不是
 * 字符串前缀比对——软链接能让字符串看着在里面、实际指到外面。
 */
export function withinDataDir(workspace: string, dataDir: string): boolean {
  try {
    const root = realpathSync(dataDir);
    const target = realpathSync(workspace);
    return target !== root && target.startsWith(root + sep);
  } catch {
    // 解不出真实路径(不存在/权限)就当越界:删除动作宁可不做。
    return false;
  }
}

/**
 * 真删。KEEP 之外的一级条目全清。
 *
 * 整个过程 fail-open:回收是纯旁路,删不动就少释放一点磁盘,绝不许它
 * 把任务读写或服务启动带下水。单个条目删失败也不中断,继续删下一个。
 */
export function reclaimWorkspace(
  workspace: string,
  options: { cwd?: string; dataDir: string },
): ReclaimResult {
  const removed: string[] = [];
  let freed = 0;
  let snapshotted = false;

  // 边界先过。越界不是"少删一点",是**一个字节都不许删**。
  if (!withinDataDir(workspace, options.dataDir)) {
    return {
      removed, freed, snapshotted,
      refused: `现场 ${workspace} 不在本服务的数据目录 ${options.dataDir} 内,拒绝删除`,
    };
  }

  // 先抄内核阶段真相,再删克隆——顺序反了就永远抄不到了。
  const statePath = options.cwd ? join(options.cwd, ".mae-flow.json") : "";
  if (statePath && existsSync(statePath)) {
    try {
      writeFileSync(
        join(workspace, KERNEL_STATE_SNAPSHOT),
        readFileSync(statePath, "utf-8"));
      snapshotted = true;
    } catch {
      // 抄不下来就算了:少一份留档,不值得为它中止回收。
    }
  }

  const keep = new Set(RECLAIM_KEEP);
  let entries: string[] = [];
  try {
    entries = readdirSync(workspace);
  } catch {
    return { removed, freed, snapshotted };
  }
  for (const name of entries) {
    if (keep.has(name)) continue;
    const target = join(workspace, name);
    const size = sizeOf(target);
    try {
      rmSync(target, { recursive: true, force: true });
      removed.push(name);
      freed += size;
    } catch {
      // 单个条目删不动(权限/占用)不中断,下一个接着来。
    }
  }
  return { removed, freed, snapshotted };
}
