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
  delivery?: {
    pipeline?: string;
    loop?: { state: string };
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
  return task.status === "failed" || repairStopped(task);
}

export function needsAction(task: TeamTask): boolean {
  return task.status === "waiting_for_human"
    || task.status === "paused" || isBlocked(task);
}

export function progressAgeMs(task: TeamTask, now = Date.now()): number {
  const at = new Date(
    task.last_progress_at ?? task.updated_at ?? task.created_at,
  ).getTime();
  return Number.isFinite(at) ? Math.max(0, now - at) : 0;
}

export function isStale(task: TeamTask, now = Date.now()): boolean {
  return ["queued", "running", "pausing", "verifying"].includes(task.status)
    && progressAgeMs(task, now) >= STALE_AFTER_MS;
}

/** 行动项在前,同类里停滞久的在前。 */
export function byTeamAttention(a: TeamTask, b: TeamTask): number {
  const action = Number(needsAction(b)) - Number(needsAction(a));
  if (action) return action;
  return progressAgeMs(b) - progressAgeMs(a);
}

export function cycleTimeMs(task: TeamTask): number | undefined {
  if (!task.completed_at) return undefined;
  const start = new Date(task.created_at).getTime();
  const end = new Date(task.completed_at).getTime();
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
