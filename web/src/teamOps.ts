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
    task.last_progress_at ?? task.updated_at ?? task.created_at,
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

function mapIssueStatus(status: string): string {
  switch (status) {
    case "waiting_user": return "waiting_for_human";
    case "idle": return "running";
    case "suspended": return "paused";
    case "archived": return "completed";
    default: return status;
  }
}

/** 把 IssueSummary 适配成 TeamTask,让团队看板的过滤/排序/渲染纯函数
 * 直接复用。只填 TeamTask 的稳定字段——看板扫描态只关心 id/状态/处理人/
 * 阶段线/更新时间,不需要 IssueSummary 的决策卡/检视/流水线等重字段。 */
export function issueToTeamTask(issue: {
  id: string;
  title: string;
  status: string;
  account: string;
  created_at: string;
  updated_at: string;
  stage?: string;
  stage_note?: string;
  stage_at?: string;
}): TeamTask {
  const status = mapIssueStatus(issue.status);
  const needsAttention = issue.status === "waiting_user"
    || issue.status === "failed";
  const kind = issue.status === "failed" ? "blocked"
    : issue.status === "waiting_user" ? "waiting"
    : "progress";
  const nextAction = issue.status === "waiting_user" ? "需要答复"
    : issue.status === "failed" ? "需要介入"
    : issue.status === "idle" ? "等待续聊"
    : issue.status === "suspended" ? "已挂起"
    : "AI 推进中";
  return {
    id: issue.id,
    requirement: issue.title,
    status,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    last_progress_at: issue.stage_at || issue.updated_at,
    luban_account: issue.account,
    focus: {
      kind,
      headline: issue.stage_note || issue.stage || "",
      next_action: nextAction,
      needs_attention: needsAttention,
      priority: needsAttention ? 1 : 0,
    },
  };
}
