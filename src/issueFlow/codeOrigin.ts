/**
 * 一次生成归属层(ADR-0044,工单 #335/#336/#337):会话终态后,对代码
 * 现场一次算清「最终留存的源码行里,多少行是首轮生成且存活到合入的」,
 * 冻结成会话目录下的伴生文件 code-origin.json(独立于 metrics.json,
 * 自带 schema 版本,只写一次、永不重写)。
 *
 * 三条纪律(与 ADR-0042 的快照同构):
 * - **零新记账**:输入全是现有账(转移账推送账、检视账、MR 账、外部
 *   头观测)+ 代码现场,不新增任何流程记账。
 * - **降级总则**:单仓取不到(fetch 失败/分支已删/对象缺失/超预算)
 *   只把该仓标「不可得」并说明原因,其余仓照算;绝不阻塞归档收口。
 * - **宁缺勿假**:算不出就「不可得」,绝不按首轮暂计——指标当 KPI
 *   用,坏账不虚构达标(需求侧的宽容档明确不搬)。
 *
 * 执行模型(工单 #335/#336):归档响应不等计算——任务挂后台串行通道
 * (一次一个会话),Git 一律走异步口(同步 spawn 阻塞 Node 事件循环,
 * safeGit.ts 有明文纪律);终态现场回收为通道任务让路;进程崩溃的
 * 缺口由每日清扫器兜底(回收前伴生缺失且属支持期的先补算一次)。
 * 超时只作挂死保险:单命令分钟级、整层十分钟级,慢不算失败,真挂死
 * 才降级。
 *
 * 归属口径(逐提交三分类,行级 blame):
 * - 首轮:落在平台推送区间内、且该推送不晚于返工边界的提交;
 * - 返工:落在平台推送区间内、晚于返工边界的提交;
 * - 平台外:不在任何平台推送区间内的提交(含末笔推送之后的尾部、
 *   被外部头观测记录在案的提交)。
 * 返工边界=首个反馈事件(ledgerFacts.feedbackEvents:检视批次送出/
 * 红灯按失败处理/验证发现问题)所回应的那笔推送(会话级全局边界,
 * 多仓共用)。区间归属把平台一次推送携带的多个提交都算平台——与
 * 提交归属层(commit_attribution,只认推送头)的语义差异是拍板过的:
 * 行级占比要的是「谁交付的这批代码」,不是「哪笔提交在账」。
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { durableWriteFileSync } from "../durableWrite.ts";
import { createSafeGitView, type SafeGitView } from "../safeGit.ts";
import { prepareSandbox, type GitCredential, type GitSandbox } from "./issueGit.ts";
import {
  externalHeadObservations,
  feedbackEvents,
  ledgerPushes,
  sentReviewOperations,
  type FeedbackEventKind,
} from "./ledgerFacts.ts";
import { isSourcePath, type IssueMetricsUnavailable } from "./metricsSnapshot.ts";
import { reviewStore } from "./reviews.ts";
import { issueRepoWorkspaces, type IssueSessionState } from "./state.ts";

/** 伴生文件名(会话目录根,与 issue.json/metrics.json 同层)。 */
export const ISSUE_CODE_ORIGIN_FILE = "code-origin.json";

/** 伴生结构的版本号:归属口径(工作量/触发集/白名单/区间规则)换版时 +1。
 *  v2(2026-09-20):占比改工作量口径(每提交增删行均计),提交明细带
 *  adds/dels;v1 为留存行 blame 口径,读侧按缺失处理。 */
export const ISSUE_CODE_ORIGIN_SCHEMA_VERSION = 2;

/** 起算日期(支持期起点,ISO 日期):此前终态的会话永不试算、不进
 *  统计分母——清扫器判定与界面文案共用这一处常量(ADR-0044)。 */
export const ISSUE_CODE_ORIGIN_SINCE = "2026-09-20";

/** 达标线缺省(参数,部署可经 settings.runtime 的
 *  issue_once_generated_threshold_percent 调整;调线不动统计逻辑)。 */
export const ISSUE_CODE_ORIGIN_THRESHOLD_DEFAULT = 90;

/** 挂死保险(非性能约束,ADR-0044):单命令与整层的宽松上限。 */
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const SESSION_BUDGET_MS = 10 * 60_000;
const LINE_BUDGET = 200_000;
const PUSH_BUDGET = 200;

export interface IssueCodeOriginCommit {
  sha: string;
  subject: string;
  at: string;
  origin: "first" | "rework" | "external";
  /** 该提交的源码新增行数。 */
  adds: number;
  /** 该提交的源码删除行数(与新增同权,均为正向工作量)。 */
  dels: number;
}

export interface IssueCodeOriginRepoOk {
  repo: string;
  branch: string;
  head: string;
  /** head 取得口径:merged_sha=账面合入头(非 squash 时即源分支头);
   *  mr_branch=fetch 到的 MR 分支头;local_push=本地末笔平台推送头
   *  (缺平台外尾部,如实标注)。 */
  head_basis: "merged_sha" | "mr_branch" | "local_push";
  base: string;
  /** 返工边界:首个反馈事件与其回应的推送;null=全程无反馈,全部
   *  提交计首轮。 */
  boundary:
    | { kind: FeedbackEventKind; at: string; push_sha: string }
    | null;
  /** 最终留存源码行三分类(平台外行计入分母,不计入分子)。 */
  lines: { first: number; rework: number; external: number };
  /** 拥有留存行的提交(证据面:每行数从哪来)。 */
  commits: IssueCodeOriginCommit[];
}

/** 单仓段:降级时 unavailable 说明原因,repo/branch 仍在。 */
export type IssueCodeOriginRepo =
  | IssueCodeOriginRepoOk
  | (IssueMetricsUnavailable & { repo: string; branch: string });

export interface IssueCodeOriginSnapshot {
  schema_version: number;
  generated_at: string;
  session_id: string;
  by_repo: IssueCodeOriginRepo[];
}

export interface IssueCodeOriginOptions {
  /** fetch MR 分支用的 Git 凭据(与推送工具同源;缺省匿名尝试)。 */
  fetchCredential?: GitCredential;
}

// ---- 读侧聚合形状(统计端点与详情端点;web/src/api.ts 有同源镜像) ----

/** 达标率分母里的一行(伴生在场且留存源码行 >0 的完成交付会话)。 */
export interface IssueOnceGeneratedSession {
  id: string;
  title: string;
  /** 特性(业务模块名标签;空白归「未分类」,与需求侧特性口径同构)。 */
  module: string;
  concluded_at: string;
  /** 首次生成占比(百分数一位小数);终态会话分母>0,不会是 null。 */
  share: number;
  pass: boolean;
  lines: { first: number; rework: number; external: number };
  /** 一次定位:分析报告一版过(与 /issues/stats 同源判定)。 */
  localization_pass: boolean;
  /** 一次验证:环境验证零失败(未答卡=通过)。 */
  verify_pass: boolean;
  /** 一次解决:定位与验证双一次。 */
  solved_pass: boolean;
}

/** 一根比率轴:分子与占比(分母=各自口径的会话数)。 */
export interface IssueOnceGeneratedAxis {
  passed: number;
  /** 百分数一位小数;分母 0 = null(前端显示 —)。 */
  rate: number | null;
}

/** 按代码仓的跨会话聚合行(只出代码衍生指标;一次定位/验证/解决是
 *  会话级裁决,不设仓维度)。 */
export interface IssueOnceGeneratedRepoRow {
  repo: string;
  /** 涉及会话数(多仓会话按仓各计一次,合计可大于会话总数)。 */
  sessions: number;
  /** 首轮工作行(增+删,跨会话求和)。 */
  first: number;
  rework: number;
  external: number;
  /** 工作行合计 = 首轮+返工+平台外。 */
  total: number;
  /** 加权占比(首轮 ÷ 全部,百分数一位小数)。 */
  share: number | null;
}

export interface IssueOnceGeneratedStats {
  /** 达标线(参数;settings.runtime 可调,缺省 90)。 */
  threshold_percent: number;
  /** 起算日期(此前后终态的会话不进统计,界面说明用)。 */
  supported_since: string;
  /** 分母:有数据(伴生在场且留存源码行>0)的完成交付会话数。 */
  total: number;
  passed: number;
  /** 达标会话占比;分母 0 = null(前端显示 —)。 */
  rate: number | null;
  /** 一次定位率(报告一版过):分母=完成交付会话,与 /issues/stats 同源。 */
  localization: IssueOnceGeneratedAxis;
  /** 一次验证率(验证不通过次数=0;未答卡=通过)。 */
  verify: IssueOnceGeneratedAxis;
  /** 一次解决率(定位与验证双一次)。 */
  solved: IssueOnceGeneratedAxis;
  /** 按代码仓跨会话聚合,工作行降序。 */
  by_repo: IssueOnceGeneratedRepoRow[];
  /** 支持期内已终态、伴生还没算出来(通道在途或曾丢失,清扫器会兜底)。 */
  pending: number;
  /** 起算日期前终态的存量会话,永不回填。 */
  unsupported: number;
  /** 伴生在场但没有留存源码行(无源码交付),不进分母。 */
  no_code: number;
  per_session: IssueOnceGeneratedSession[];
}

// ---- 纯函数:聚合与判定(读侧消费,冻结文件只存事实) ----

export interface IssueCodeOriginAggregate {
  first: number;
  rework: number;
  external: number;
  /** 分母=三类行数合计(留存源码行总数)。 */
  total: number;
  /** 一次生成占比(百分数一位小数);total=0 → null(前端显示 —)。 */
  share: number | null;
  /** 是否达到达标线;total=0 → null(不进分母)。 */
  pass: boolean | null;
}

/** 聚合(行数加权):只吃「可得」仓;全部降级/无源码行时 total=0,
 *  读侧据此把该会话排除出分母。 */
export function aggregateCodeOrigin(
  snapshot: IssueCodeOriginSnapshot | undefined,
  thresholdPercent = ISSUE_CODE_ORIGIN_THRESHOLD_DEFAULT,
): IssueCodeOriginAggregate {
  const lines = { first: 0, rework: 0, external: 0 };
  if (snapshot && snapshot.schema_version === ISSUE_CODE_ORIGIN_SCHEMA_VERSION) {
    for (const repo of snapshot.by_repo) {
      if ("unavailable" in repo) continue;
      lines.first += repo.lines.first;
      lines.rework += repo.lines.rework;
      lines.external += repo.lines.external;
    }
  }
  const total = lines.first + lines.rework + lines.external;
  const share = total
    ? Math.round((lines.first / total) * 1000) / 10
    : null;
  return {
    ...lines,
    total,
    share,
    pass: share === null ? null : share >= thresholdPercent,
  };
}

/** 支持期判定:终态时刻(结论时刻,缺省台账更新时刻)不早于起算日期。 */
export function codeOriginSupported(
  state: Pick<IssueSessionState, "conclusion" | "updated_at">,
): boolean {
  const at = state.conclusion?.at ?? state.updated_at ?? "";
  return at.slice(0, 10) >= ISSUE_CODE_ORIGIN_SINCE;
}

// ---- 异步 Git 会话(通道专用;同步 spawn 禁入) ----

interface GitOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** 会话工作区某仓的异步 Git 会话:受信视图建一次贯穿多次命令;需要
 *  fetch 时叠凭据沙箱(与推送工具同一套加固)。每命令带挂死保险
 *  超时;调用方再握整层预算。 */
class AsyncWorktreeGitSession {
  private constructor(
    private readonly cwd: string,
    private readonly view: SafeGitView,
    private readonly sandbox?: GitSandbox,
  ) {}

  static open(repoDir: string, fetch?: {
    dataDir: string; credential?: GitCredential;
  }): AsyncWorktreeGitSession | undefined {
    if (!existsSync(join(repoDir, ".git"))) return undefined;
    return new AsyncWorktreeGitSession(
      repoDir,
      createSafeGitView(repoDir),
      fetch ? prepareSandbox(fetch.dataDir, fetch.credential, repoDir) : undefined,
    );
  }

  run(args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<GitOutcome> {
    return new Promise((resolve) => {
      execFile("git", [...(this.sandbox?.args ?? []), ...args], {
        cwd: this.cwd,
        env: this.view.environment(this.sandbox?.env),
        encoding: "utf-8",
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        resolve({
          code: error && typeof (error as { code?: number }).code === "number"
            ? (error as { code: number }).code
            : error ? -1 : 0,
          stdout: stdout ?? "",
          stderr: stderr
            || (error ? String((error as Error & { message?: string }).message) : ""),
        });
      });
    });
  }

  /** fetch 之后的 FETCH_HEAD 全文(记在受信代理 gitdir 里)。 */
  fetchHeadText(): string {
    try {
      return readFileSync(join(this.view.proxyGitDir, "FETCH_HEAD"), "utf-8");
    } catch {
      return "";
    }
  }

  close(): void {
    this.sandbox?.cleanup();
    this.view.cleanup();
  }
}

function firstErrorLine(text: string): string {
  return (text.trim().split(/\r?\n/)[0] ?? "").slice(0, 200);
}

async function resolveCommit(
  session: AsyncWorktreeGitSession,
  ref: string,
): Promise<string | undefined> {
  const outcome = await session.run(
    ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 30_000);
  const sha = outcome.stdout.trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
}

/** fetch 远端单分支(显式地址+分支名,不吃仓配置)。失败返回人话理由。 */
async function fetchBranchTip(
  session: AsyncWorktreeGitSession,
  url: string,
  branch: string,
): Promise<{ sha?: string; error?: string }> {
  const outcome = await session.run(["fetch", "--quiet", "--no-tags", url, branch]);
  if (outcome.code !== 0) {
    const detail = firstErrorLine(outcome.stderr || outcome.stdout);
    const missing = /couldn'?t find remote ref|could not find remote branch/i
      .test(detail);
    return {
      error: missing
        ? `远端没有分支 ${branch}(可能已被删除)`
        : `fetch ${branch} 失败:${detail || "远端不可达"}`,
    };
  }
  const sha = (session.fetchHeadText().split(/\r?\n/)[0] ?? "").trim()
    .split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{40}$/i.test(sha)
    ? { sha: sha.toLowerCase() }
    : { error: `fetch ${branch} 后读不到分支头` };
}

// ---- 逐文件行级归属 ----

/** numstat 的 -z 解析(重命名项带两个路径字段,新名在前)。 */
function parseNumstatZ(raw: string): Array<{ added: number; removed: number; path: string; old?: string }> {
  const fields = raw.split("\0");
  const entries: ReturnType<typeof parseNumstatZ> = [];
  for (let i = 0; i < fields.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i] ?? "");
    if (!match) continue;
    const old = match[3] ? undefined : fields[++i];
    const path = match[3] || fields[++i];
    if (match[1] !== "-" && match[2] !== "-") {
      entries.push({ added: Number(match[1]), removed: Number(match[2]), path, old });
    }
  }
  return entries;
}

/** 文件路径去 C 风格引号(特殊字符路径)。 */
function unquoteGitPath(path: string): string {
  return path.startsWith('"') && path.endsWith('"') && path.length >= 2
    ? path.slice(1, -1)
    : path;
}

/** 一个提交的工作量(源码白名单内):新增行数、删除行数(与新增同权,
 *  均为正向工作量——删除烂代码也是活)。纯改名/纯非源码提交工作为 0。 */
async function commitWork(
  session: AsyncWorktreeGitSession,
  budget: () => void,
  sha: string,
): Promise<{ adds: number; dels: number }> {
  budget();
  // show 对根提交原生按空树起算;--format= 只出 diff;增删行按扩展名
  // 白名单过滤(与统计口径同源),二进制 numstat 记 "-" 自然不计。
  const outcome = await session.run([
    "--literal-pathspecs", "show", "--numstat", "--format=",
    "--find-renames", "-z", sha]);
  if (outcome.code !== 0) {
    throw new Error(`读取提交 ${sha.slice(0, 12)} 工作量失败:${
      firstErrorLine(outcome.stderr || outcome.stdout)}`);
  }
  let adds = 0;
  let dels = 0;
  for (const entry of parseNumstatZ(outcome.stdout)) {
    if (!isSourcePath(unquoteGitPath(entry.path))) continue;
    adds += entry.added;
    dels += entry.removed;
  }
  return { adds, dels };
}

// ---- 单仓归属 ----

interface RepoGroup {
  repo: string;
  branch: string;
  shas: string[];
  /** 与 shas 平行的推送时刻(转移账时刻,边界按时刻应用用)。 */
  ats: string[];
}

function groupPushes(pushes: Array<{ repo: string; branch: string; sha: string; at: string }>): RepoGroup[] {
  const groups = new Map<string, RepoGroup>();
  for (const push of pushes) {
    const key = `${push.repo}\u0000${push.branch}`;
    const group = groups.get(key)
      ?? { repo: push.repo, branch: push.branch, shas: [], ats: [] };
    group.shas.push(push.sha);
    group.ats.push(push.at);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** 返工边界(会话级全局):首个「前面有推送」的反馈事件,与它回应的
 *  末笔推送。反馈先于一切推送(如对分析报告的检视)不构成代码返工
 *  边界——那是对报告的反馈,不是对已交付代码的返工要求。 */
export function reworkBoundary(
  pushes: ReadonlyArray<{ repo: string; branch: string; sha: string; at: string }>,
  events: ReadonlyArray<{ kind: FeedbackEventKind; at: string }>,
): { kind: FeedbackEventKind; at: string; push_sha: string } | null {
  if (!pushes.length) return null;
  const firstPushAt = pushes[0]!.at;
  for (const event of events) {
    if (event.at < firstPushAt) continue;
    const responded = [...pushes].reverse()
      .find((push) => push.at <= event.at);
    if (responded) {
      return { kind: event.kind, at: event.at, push_sha: responded.sha };
    }
  }
  return null;
}

async function attributeOneRepo(
  session: AsyncWorktreeGitSession,
  group: RepoGroup,
  boundary: ReturnType<typeof reworkBoundary>,
  externalShas: ReadonlySet<string>,
  budget: () => void,
  fetchUrl?: string,
  mergedSha?: string,
  targetBranch: string = "master",
): Promise<IssueCodeOriginRepoOk> {
  // 1) head 四级优先级(ADR-0044):账面合入头(非 squash 时即源分支
  //    头;对象可由 fetch 带回)> fetch 到的 MR 分支头 > 本地末笔平台
  //    推送头(缺平台外尾部)。fetch 把平台外提交的对象拿进本地——
  //    不 fetch 等于变相把平台外行剔出分母。
  let head: string | undefined;
  let headBasis: IssueCodeOriginRepoOk["head_basis"] | undefined;
  let fetchError: string | undefined;
  let fetchedTip: string | undefined;
  if (fetchUrl) {
    const fetched = await fetchBranchTip(session, fetchUrl, group.branch);
    fetchedTip = fetched.sha;
    fetchError = fetched.error;
  }
  if (mergedSha) {
    const resolved = await resolveCommit(session, mergedSha);
    if (resolved) {
      head = resolved;
      headBasis = "merged_sha";
    }
  }
  if (!head && fetchedTip) {
    head = fetchedTip;
    headBasis = "mr_branch";
  }
  if (!head) {
    const local = await resolveCommit(session, group.shas[group.shas.length - 1]!);
    if (local) {
      head = local;
      headBasis = "local_push";
    }
  }
  if (!head) {
    throw new Error(fetchError ?? "取不到可统计的分支头(合入头/远端分支/本地推送都不可得)");
  }

  // 2) base:与目标分支(本地远端跟踪引用,会话生命周期短,漂移可
  //    忽略)的分叉点;没有 MR 的仓退缺省远端分支。
  budget();
  const baseRefSha = await resolveCommit(session, `refs/remotes/origin/${targetBranch}`)
    ?? await resolveCommit(session, "refs/remotes/origin/HEAD");
  if (!baseRefSha) {
    throw new Error(`目标分支 ${targetBranch} 的本地引用取不到,算不出统计区间`);
  }
  const merged = await session.run(["merge-base", baseRefSha, head]);
  const baseCut = merged.code === 0 ? merged.stdout.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(baseCut)) {
    throw new Error(`算不出统计区间(与目标分支 ${targetBranch} 没有共同祖先)`);
  }

  // 3) 平台推送区间:每笔推送的区间=(上一笔..本笔],首笔从 base
  //    起算。区间内的提交都算平台交付(一次推送可携带多个提交);
  //    被外部头观测记录在案的提交例外,按平台外计。区间外的提交
  //    (末笔之后等)按平台外计。
  //    边界按时刻应用(ADR-0045):推送时刻晚于首个反馈事件时刻的
  //    推送整笔计返工——多仓会话所有仓一致,不再按提交号匹配。
  if (group.shas.length > PUSH_BUDGET) {
    throw new Error(`推送笔数超过统计预算(${group.shas.length})`);
  }
  const tips: string[] = [];
  for (const sha of group.shas) {
    const resolved = await resolveCommit(session, sha);
    if (resolved) tips.push(resolved);
  }
  if (!tips.length) throw new Error("推送账里的提交对象在工作区都取不到");
  const classify = new Map<string, "first" | "rework">();
  for (let index = 0; index < tips.length; index += 1) {
    const tip = tips[index]!;
    budget();
    const range = index === 0
      ? `${baseCut}..${tip}`
      : `${tips[index - 1]!}..${tip}`;
    const listed = await session.run([
      "rev-list", "--reverse", "--no-merges", range]);
    if (listed.code !== 0) continue; // 单笔对象缺失跳过,不废整仓
    const phase: "first" | "rework" =
      boundary && group.ats[index]! > boundary.at ? "rework" : "first";
    for (const sha of listed.stdout.trim().split("\n").filter(Boolean)) {
      classify.set(sha.toLowerCase(), phase);
    }
    classify.set(tip, phase);
  }

  const originOf = (sha: string): "first" | "rework" | "external" => {
    if (externalShas.has(sha.slice(0, 12))) return "external";
    return classify.get(sha) ?? "external";
  };

  // 4) 工作量归属(ADR-0045):枚举统计区间内全部非合并提交,逐提交
  //    累计 源码新增行+删除行(增删均计正向工作量),按提交桶求和;
  //    不在任何平台推送区间内的提交(末笔尾部等)按平台外计。
  const listed = await session.run([
    "rev-list", "--reverse", "--no-merges", `${baseCut}..${head}`]);
  if (listed.code !== 0) {
    throw new Error(`读取统计区间提交失败:${
      firstErrorLine(listed.stderr || listed.stdout)}`);
  }
  const allShas = listed.stdout.trim().split("\n").filter(Boolean);
  if (!allShas.length) throw new Error("统计区间内没有任何非合并提交");
  const lines = { first: 0, rework: 0, external: 0 };
  const commits = new Map<string, IssueCodeOriginCommit>();
  let workTotal = 0;
  for (const sha of allShas) {
    budget();
    const origin = originOf(sha);
    const { adds, dels } = await commitWork(session, budget, sha);
    const work = adds + dels;
    if (work <= 0) continue; // 纯改名/纯非源码提交不占统计
    lines[origin] += work;
    workTotal += work;
    if (workTotal > LINE_BUDGET) {
      throw new Error(`代码规模超过统计预算(${workTotal} 行)`);
    }
    const show = await session.run(
      ["show", "-s", "--format=%cI%x1f%s", sha], 30_000);
    const [at, subject] = show.stdout.trim().split("\x1f");
    commits.set(sha, {
      sha, at: at ?? "", subject: subject ?? "",
      origin, adds, dels,
    });
  }
  return {
    repo: group.repo,
    branch: group.branch,
    head,
    head_basis: headBasis!,
    base: baseCut,
    boundary,
    lines,
    commits: [...commits.values()].sort((a, b) =>
      (b.adds + b.dels) - (a.adds + a.dels)),
  };
}

// ---- 伴生文件读写(只写一次) ----

export function readCodeOriginSnapshot(
  root: string,
  sessionId: string,
): IssueCodeOriginSnapshot | undefined {
  const path = join(root, ISSUE_CODE_ORIGIN_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const snapshot = JSON.parse(readFileSync(path, "utf-8")) as IssueCodeOriginSnapshot;
    if (snapshot?.schema_version !== ISSUE_CODE_ORIGIN_SCHEMA_VERSION) return undefined;
    if (snapshot.session_id !== sessionId) return undefined;
    return snapshot;
  } catch {
    return undefined;
  }
}

/** 从现有账与代码现场现算整份伴生快照(纯算不落盘;单仓失败单仓降级)。
 *  异步 Git、整层十分钟预算;任何仓的失败都不抛出整体。 */
export async function buildCodeOriginSnapshot(
  root: string,
  state: IssueSessionState,
  options: IssueCodeOriginOptions = {},
): Promise<IssueCodeOriginSnapshot> {
  const startedAt = Date.now();
  const budget = () => {
    if (Date.now() - startedAt > SESSION_BUDGET_MS) {
      throw new Error("一次生成归属超过十分钟预算,该仓暂不计入");
    }
  };
  const pushes = ledgerPushes(state.transitions ?? []);
  const events = feedbackEvents({
    transitions: state.transitions ?? [],
    reviewOperations: sentReviewOperations(reviewStore(root).history()),
  });
  const boundary = reworkBoundary(pushes, events);
  const externalShas = new Set(
    externalHeadObservations(state.transitions ?? []).map((record) => record.sha.toLowerCase()),
  );
  const dataDir = join(root, "..", "..");
  const byRepo: IssueCodeOriginRepo[] = [];
  for (const group of groupPushes(pushes)) {
    const workspace = issueRepoWorkspaces(state, root).find(
      (entry) => entry.url === group.repo)?.dir;
    const session = workspace
      ? AsyncWorktreeGitSession.open(workspace, {
        dataDir, credential: options.fetchCredential,
      })
      : undefined;
    if (!session) {
      byRepo.push({
        repo: group.repo, branch: group.branch,
        unavailable: "工作区没有该仓的克隆(repo/ 子树),现场可能已回收",
      });
      continue;
    }
    const mr = (state.mrs ?? []).find(
      (record) => record.repo === group.repo && record.branch === group.branch);
    try {
      byRepo.push(await attributeOneRepo(
        session, group, boundary, externalShas, budget,
        group.repo,
        mr?.merged_sha,
        mr?.target ?? "master",
      ));
    } catch (error) {
      byRepo.push({
        repo: group.repo, branch: group.branch,
        unavailable: `不可得:${
          error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      session.close();
    }
  }
  return {
    schema_version: ISSUE_CODE_ORIGIN_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    session_id: state.id,
    by_repo: byRepo,
  };
}

/** 只写一次地落伴生文件:已存在即跳过;现场回收让路的窗口内调用。 */
export async function writeCodeOriginSnapshot(
  root: string,
  state: IssueSessionState,
  options: IssueCodeOriginOptions = {},
): Promise<{ written: boolean; degraded: string[] }> {
  const path = join(root, ISSUE_CODE_ORIGIN_FILE);
  if (existsSync(path)) return { written: false, degraded: [] };
  if (!codeOriginSupported(state)) return { written: false, degraded: [] };
  const snapshot = await buildCodeOriginSnapshot(root, state, options);
  if (existsSync(path)) return { written: false, degraded: [] };
  const degraded: string[] = [];
  for (const [index, repo] of snapshot.by_repo.entries()) {
    if ("unavailable" in repo) degraded.push(`by_repo[${index}](${repo.repo})`);
  }
  durableWriteFileSync(path, JSON.stringify(snapshot, null, 1));
  return { written: true, degraded };
}

// ---- 后台串行通道(归档响应不等计算;现场回收让路) ----

const pending = new Map<string, Promise<void>>();
let lane: Promise<void> = Promise.resolve();

/** 等待通道排空(测试与服务停机前收尾用)。 */
export async function awaitCodeOriginLane(): Promise<void> {
  await lane;
}

export function codeOriginPending(root: string): boolean {
  return pending.has(join(root, ISSUE_CODE_ORIGIN_FILE));
}

/** 归档后入队:伴生已在/不支持期/无仓=不入队(返回 false,调用方立即
 *  回收现场);入队则任务收尾(成败皆算)后回调 onSettled——调用方把
 *  现场回收挂在它后面。写盘失败只记日志,绝不阻塞收口。 */
export function enqueueCodeOrigin(
  root: string,
  state: IssueSessionState,
  options: IssueCodeOriginOptions,
  hooks: { onSettled?: () => void; log?: (message: string) => void } = {},
): boolean {
  const key = join(root, ISSUE_CODE_ORIGIN_FILE);
  if (pending.has(key)) return true;
  if (existsSync(key)) return false;
  if (!codeOriginSupported(state)) return false;
  const repoUrls = state.repo_urls?.length
    ? state.repo_urls
    : state.repo_url ? [state.repo_url] : [];
  if (!repoUrls.length) return false;
  const job = lane.then(async () => {
    try {
      const result = await writeCodeOriginSnapshot(root, state, options);
      if (result.written) {
        hooks.log?.(`[issue-flow] ${state.id} 一次生成归属已冻结`
          + (result.degraded.length ? `(缺项:${result.degraded.join("、")})` : ""));
      }
    } catch (error) {
      hooks.log?.(`[issue-flow] ${state.id} 一次生成归属生成失败`
        + `(不阻塞收口,清扫器兜底): `
        + String(error instanceof Error ? error.message : error));
    }
  }).finally(() => {
    pending.delete(key);
    hooks.onSettled?.();
  });
  pending.set(key, job);
  lane = job;
  return true;
}

/** 清扫器兜底(工单 #336):现场还在而伴生缺失(进程曾在归档与算完
 *  之间退出),回收前补算一次。通道在途的让路(等它跑完);支持期
 *  外的返回 false 不试算。 */
export async function backfillCodeOrigin(
  root: string,
  state: IssueSessionState,
  options: IssueCodeOriginOptions,
  log: (message: string) => void = () => {},
): Promise<boolean> {
  const key = join(root, ISSUE_CODE_ORIGIN_FILE);
  if (existsSync(key) || !codeOriginSupported(state)) return false;
  if (pending.has(key)) {
    await pending.get(key);
    return false;
  }
  const repoUrls = state.repo_urls?.length
    ? state.repo_urls
    : state.repo_url ? [state.repo_url] : [];
  if (!repoUrls.length) return false;
  try {
    const result = await writeCodeOriginSnapshot(root, state, options);
    if (result.written) {
      log(`[issue-flow] ${state.id} 一次生成归属补算已冻结`
        + (result.degraded.length ? `(缺项:${result.degraded.join("、")})` : ""));
    }
    return result.written;
  } catch (error) {
    log(`[issue-flow] ${state.id} 一次生成归属补算失败(不阻塞回收): `
      + String(error instanceof Error ? error.message : error));
    return false;
  }
}
