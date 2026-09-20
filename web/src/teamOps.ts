import { taskProgressTimestamp } from "../../src/taskProgressTime";
import { instantMs } from "./time";

/** 问题会话摘要的"自包含投影":只取适配所需的稳定字符串字段,与
 * api.ts 的 IssueSummary 结构兼容(超出这些字段的传入对象照常通过)。
 * 刻意不 import api.ts——那会把整个浏览器 fetch 客户端拖进根级
 * typecheck 的 Node 类型域,全局 fetch/Response 合并后 json() 推断
 * 翻成 unknown,契约编译全线红(2026-09-01 同步实测)。 */

/** 团队运营只依赖这些稳定字段。保持为自包含结构，根级 typecheck
 * 在测试该纯函数时不必把整个浏览器 API 客户端一并拖进 Node 类型域。 */
export interface TeamTask {
  id: string;
  requirement: string;
  parent_task_id?: string;
  status: string;
  created_at: string;
  updated_at?: string;
  last_progress_at?: string;
  completed_at?: string;
  luban_account?: string;
  progress?: {
    current_phase: string;
    phases: string[];
  };
  focus?: {
    kind: string;
    headline: string;
    next_action: string;
    needs_attention: boolean;
    priority: number;
  };
  delivery?: {
    pipeline?: string;
    loop?: { state: string };
  };
}

export type TeamScope =
  | "all"
  | "action"
  | "stale"
  | "wip"
  | "waiting"
  | "week"
  | "delivered";

const WIP_STATUSES = [
  "queued", "running", "pausing", "verifying", "waiting_for_human",
  "await_merge", "coordinating",
];
const DELIVERED_STATUSES = ["completed"];
const WEEK_MS = 7 * 86_400_000;
const DELIVERY_STATUS_GROUPS = [
  { key: "pending", label: "待开始", statuses: ["queued"] },
  { key: "progressing", label: "推进中", statuses: ["running", "pausing"] },
  {
    key: "action_required", label: "需要处理",
    statuses: ["waiting_for_human", "paused", "failed"],
  },
  { key: "verifying", label: "验证中", statuses: ["verifying"] },
  { key: "await_merge", label: "待合入", statuses: ["await_merge"] },
  { key: "coordinating", label: "子任务推进", statuses: ["coordinating"] },
] as const;

export interface TeamDeliveryBreakdown {
  /** 与交付概览口径一致：只计未取消的主任务。 */
  requirements: number;
  total: number;
  delivered: number;
  delivering: number;
  stages: Array<{ key: string; count: number }>;
  statuses: Array<{ key: string; label: string; count: number }>;
}

/** 团队现场只回答“任务是否还活着”。待合入仍会监听流水线和接收
 * 批注，所以继续留在现场；只有已合入和用户取消离开现场。 */
export function isCurrentTeamTask(task: TeamTask): boolean {
  return ![...DELIVERED_STATUSES, "canceled"].includes(task.status);
}

export function teamDeliveryStatusGroup(status: string): string {
  return DELIVERY_STATUS_GROUPS.find((group) =>
    (group.statuses as readonly string[]).includes(status))?.key ?? "other";
}

/** 团队统计只计算仍有交付意义的任务：已取消留在档案，但不伪装成
 * “交付中”。阶段和状态都必须覆盖同一批交付中任务，各自加总严格
 * 等于 delivering，避免一组算 8 条、另一组只算有 progress 的 6 条。 */
export function teamDeliveryBreakdown(
  tasks: readonly TeamTask[],
): TeamDeliveryBreakdown {
  const delivered = tasks.filter((task) =>
    DELIVERED_STATUSES.includes(task.status));
  const delivering = tasks.filter(isCurrentTeamTask);
  const longestPhases = delivering.reduce<string[]>((longest, task) =>
    (task.progress?.phases.length ?? 0) > longest.length
      ? task.progress!.phases : longest, []);
  const phaseOrder = [...new Set([
    ...longestPhases,
    ...delivering.map((task) => task.progress?.current_phase)
      .filter((phase): phase is string => Boolean(phase)),
  ])];
  const untracked = delivering.filter((task) =>
    !task.progress?.current_phase).length;
  const stages = phaseOrder.map((key) => ({
    key,
    count: delivering.filter((task) =>
      task.progress?.current_phase === key).length,
  }));
  if (untracked) stages.push({ key: "尚未进入阶段", count: untracked });

  const hasOtherStatus = delivering.some((task) =>
    teamDeliveryStatusGroup(task.status) === "other");
  const statuses: TeamDeliveryBreakdown["statuses"] = DELIVERY_STATUS_GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    count: delivering.filter((task) =>
      teamDeliveryStatusGroup(task.status) === group.key).length,
  }));
  if (hasOtherStatus) statuses.push({
    key: "other",
    label: "其他",
    count: delivering.filter((task) =>
      teamDeliveryStatusGroup(task.status) === "other").length,
  });
  return {
    requirements: tasks.filter((task) => !task.parent_task_id && task.status !== "canceled").length,
    total: delivered.length + delivering.length,
    delivered: delivered.length,
    delivering: delivering.length,
    stages,
    statuses,
  };
}

function repairStopped(task: TeamTask): boolean {
  const state = task.delivery?.loop?.state;
  return task.status === "verifying" && (
    state === "halted" || state === "exhausted"
    || (task.delivery?.pipeline ?? "").includes("轮询预算耗尽"));
}

export const STALE_AFTER_MS = 2 * 60 * 60_000;

export function responsibleOf(task: TeamTask): string | undefined {
  return task.luban_account;
}

export function isBlocked(task: TeamTask): boolean {
  return task.focus?.kind === "blocked"
    || task.status === "failed" || repairStopped(task);
}

export function needsAction(task: TeamTask): boolean {
  return task.focus?.needs_attention ?? (task.status === "waiting_for_human"
    || task.status === "paused" || isBlocked(task));
}

export function progressAgeMs(task: TeamTask, now = Date.now()): number {
  const at = instantMs(
    taskProgressTimestamp(task),
  );
  return Number.isFinite(at) ? Math.max(0, now - at) : 0;
}

export function isStale(task: TeamTask, now = Date.now()): boolean {
  return ["queued", "running", "pausing", "verifying", "coordinating"]
    .includes(task.status)
    && progressAgeMs(task, now) >= STALE_AFTER_MS;
}

/** 顶部运营指标与明细筛选共用同一把尺，避免“卡上 5 项、点开 4 项”。 */
export function matchesTeamScope(
  task: TeamTask,
  scope: TeamScope,
  now = Date.now(),
): boolean {
  if (scope === "all") return true;
  if (scope === "action") return needsAction(task);
  if (scope === "stale") return isStale(task, now);
  if (scope === "wip") return WIP_STATUSES.includes(task.status);
  if (scope === "waiting") return task.status === "waiting_for_human";
  if (scope === "delivered") return DELIVERED_STATUSES.includes(task.status);
  if (scope === "week") {
    if (!task.completed_at) return false;
    const completed = instantMs(task.completed_at);
    return Number.isFinite(completed)
      && completed >= now - WEEK_MS && completed <= now + 1_000;
  }
  return false;
}

/** 行动项在前,同类里停滞久的在前。 */
export function byTeamAttention(a: TeamTask, b: TeamTask): number {
  const priority = (b.focus?.priority ?? 0) - (a.focus?.priority ?? 0);
  if (priority) return priority;
  const action = Number(needsAction(b)) - Number(needsAction(a));
  if (action) return action;
  return progressAgeMs(b) - progressAgeMs(a);
}

export function cycleTimeMs(task: TeamTask): number | undefined {
  if (!task.completed_at) return undefined;
  const start = instantMs(task.created_at);
  const end = instantMs(task.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return undefined;
  }
  return end - start;
}

export function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

// ---- 问题域交付概览口径(团队页领域切换,与需求侧 teamDeliveryBreakdown 同构) ----

/** 阶段格展示口径(团队页概览,2026-09-20 拍板):拉单+拉仓合并为
 * 「准备中」,「待验证」(环境验证卡在场,ADR-0043:通过无需作答、合入
 * 即通过)从「提交 MR·跑绿」拆出单列。键是概览格键,不是注册表阶段词
 * ——会话进度条与列表卡仍按注册表阶段原样,只有概览格用这个合并/拆分
 * 口径;标签就地声明(格键没有注册表词表,不造第二真相源)。 */
export const ISSUE_DELIVERY_STAGE_BUCKETS = [
  { key: "prep", label: "准备中", stages: ["dts_info", "prep_repo"] },
  { key: "analyze", label: "问题分析", stages: ["analyze"] },
  { key: "fix", label: "问题修复", stages: ["fix"] },
  { key: "mr_green", label: "提交 MR·跑绿", stages: ["mr_green"] },
  { key: "verifying", label: "待验证", verifying: true },
  { key: "conclude", label: "确定结论", stages: ["conclude"] },
] as const;

/** 「待验证」判定(概览格与现场范围共用):环境验证卡在场——卡本身就
 * 是那个状态,不用猜阶段与停机说明。 */
export function isIssueVerifying(issue: {
  status: string;
  gate?: { kind?: string } | null;
}): boolean {
  return issue.status === "waiting_user"
    && issue.gate?.kind === "env_verify";
}

/** 格键 → 会话是否落格:待验证的会话只进「待验证」格,不再重复计入
 * 「提交 MR·跑绿」——阶段格加总恒等于 active。 */
export function issueStageBucketMatch(
  bucket: { stages?: readonly string[]; verifying?: boolean },
  issue: { stage?: string; status: string; gate?: { kind?: string } | null },
): boolean {
  if (isIssueVerifying(issue)) return bucket.verifying === true;
  if (bucket.verifying) return false;
  return (bucket.stages ?? []).includes(issue.stage ?? "");
}

/** 概览状态格全集(展示归一口径:idle 并入 waiting_user——2026-09-08
 * 拍板,卡片/计数/筛选同一归一;archived/canceled 是收口终态,只进
 * 档案不进概览格)。标签同样由渲染层取 ISSUE_STATUS_TEXT。 */
export const ISSUE_DELIVERY_STATUSES = [
  "queued", "running", "waiting_user", "suspended", "failed",
] as const;

export interface IssueDeliveryBreakdown {
  /** 问题总数:不含已取消(已取消只进档案,与需求侧"已取消仅保留在档案"同口径)。 */
  total: number;
  /** 处理中:再剔除已闭环(archived)。 */
  active: number;
  /** 等你答复:waiting_user+idle 归一计数。 */
  waiting: number;
  /** 异常(需介入)。 */
  failed: number;
  /** 已闭环(archived)。 */
  closed: number;
  /** 阶段格:团队页合并/拆分口径全集(ISSUE_DELIVERY_STAGE_BUCKETS),
   * 0 计数也出(渲染层置灰禁用,与需求侧"阶段格全量出、0 禁用"同一
   * 规则)——概览始终呈现问题流的完整流程形状。 */
  stages: Array<{ key: string; count: number }>;
  /** 状态格:归一后五状态,0 计数也出(同上)。 */
  statuses: Array<{ key: string; count: number }>;
}

/** 问题域交付概览口径:概览规模数字与阶段/状态格共用同一批会话,与
 * 需求侧 teamDeliveryBreakdown 同构(规模 × 阶段格 × 状态格,供概览格
 * 筛选联动)。输入是 IssueSummary 的稳定字段投影(自包含约束,根级
 * typecheck 不必拖进浏览器 fetch 客户端)——「待验证」格读 gate.kind,
 * 投影带上闸对象。 */
export function issueDeliveryBreakdown(
  issues: ReadonlyArray<{
    status: string;
    stage?: string;
    gate?: { kind?: string } | null;
  }>,
): IssueDeliveryBreakdown {
  const live = issues.filter((issue) => issue.status !== "canceled");
  const active = live.filter((issue) => issue.status !== "archived");
  const waitingOf = (items: ReadonlyArray<{ status: string }>) =>
    items.filter((issue) =>
      issue.status === "waiting_user" || issue.status === "idle").length;
  return {
    total: live.length,
    active: active.length,
    waiting: waitingOf(active),
    failed: active.filter((issue) => issue.status === "failed").length,
    closed: live.filter((issue) => issue.status === "archived").length,
    stages: ISSUE_DELIVERY_STAGE_BUCKETS.map((bucket) => ({
      key: bucket.key,
      count: active.filter((issue) => issueStageBucketMatch(bucket, issue))
        .length,
    })),
    statuses: ISSUE_DELIVERY_STATUSES.map((key) => ({
      key,
      count: key === "waiting_user"
        ? waitingOf(active)
        : active.filter((issue) => issue.status === key).length,
    })),
  };
}

/** 特性(业务模块)归类键:module 空白归「未分类」。DTS 拉单时特性/
 * 模块名经 matchDtsToModule 折算进模块,这里只认落盘的 module 标签。 */
export function issueFeatureKey(issue: { module?: string }): string {
  return issue.module?.trim() || "未分类";
}

export interface IssueFeatureRow {
  /** 特性名(业务模块标签;空白归「未分类」)。 */
  module: string;
  active: number;
  waiting: number;
  failed: number;
  closed: number;
  total: number;
}

/** 特性总账行(概览「特性总账表」,2026-09-18 原型拍板):按业务模块
 * 聚合,指标复用 issueDeliveryBreakdown(与概览总数同一口径)。排序:
 * 处理中降序 → 总数降序 → 名称,表格直接渲染不再排。 */
export function issueFeatureRows(
  issues: ReadonlyArray<{ status: string; module?: string }>,
): IssueFeatureRow[] {
  const groups = new Map<string, Array<{ status: string }>>();
  for (const issue of issues) {
    if (issue.status === "canceled") continue;
    const key = issueFeatureKey(issue);
    const bucket = groups.get(key);
    if (bucket) bucket.push(issue);
    else groups.set(key, [issue]);
  }
  return [...groups.entries()].map(([module, items]) => {
    const breakdown = issueDeliveryBreakdown(items);
    return {
      module,
      active: breakdown.active,
      waiting: breakdown.waiting,
      failed: breakdown.failed,
      closed: breakdown.closed,
      total: breakdown.total,
    };
  }).sort((a, b) => b.active - a.active || b.total - a.total
    || a.module.localeCompare(b.module, "zh-Hans-CN"));
}

export interface IssueFeatureOnceRates {
  /** 分母:该特性完成交付的会话数(与概览头部一次率同口径)。 */
  total: number;
  localization: number | null;
  repair: number | null;
}

/** 每特性一次率(特性总账表列,2026-09-18):按 stats 端点的
 * per_session 明细(服务端已滤成完成交付全集)按会话归到特性。
 * 分母 0 → null,前端显示 —。 */
export function issueFeatureOnceRates(
  issues: ReadonlyArray<{ id: string; module?: string }>,
  perSession: ReadonlyArray<{
    id: string;
    localization_pass: boolean;
    repair_pass: boolean;
  }>,
): Map<string, IssueFeatureOnceRates> {
  const moduleOfId = new Map(
    issues.map((issue) => [issue.id, issueFeatureKey(issue)]),
  );
  const acc = new Map<string, {
    total: number;
    localization: number;
    repair: number;
  }>();
  for (const row of perSession) {
    const key = moduleOfId.get(row.id);
    if (!key) continue;
    const bucket = acc.get(key) ?? { total: 0, localization: 0, repair: 0 };
    bucket.total += 1;
    if (row.localization_pass) bucket.localization += 1;
    if (row.repair_pass) bucket.repair += 1;
    acc.set(key, bucket);
  }
  const percent = (passed: number, total: number): number | null =>
    total ? Math.round((passed / total) * 1000) / 10 : null;
  return new Map([...acc.entries()].map(([key, bucket]) => [key, {
    total: bucket.total,
    localization: percent(bucket.localization, bucket.total),
    repair: percent(bucket.repair, bucket.total),
  }]));
}


