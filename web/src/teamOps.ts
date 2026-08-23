import { instantMs } from "./time";

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
];
const DELIVERED_STATUSES = ["await_merge", "completed"];
const WEEK_MS = 7 * 86_400_000;

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
  return ["queued", "running", "pausing", "verifying"].includes(task.status)
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
