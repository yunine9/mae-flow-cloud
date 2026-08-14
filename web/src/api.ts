/**
 * 任务 API 的类型化镜像。前端不推断状态(主 spec §5.1):
 * 这里的类型就是 taskService.TaskSummary 的形状,文案与判断
 * 全部来自服务端镜像,前端只负责呈现与提交决定。
 */

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_for_human"
  | "completed"
  | "verifying"
  | "await_merge"
  | "failed";

export const STATUS_TEXT: Record<TaskStatus, string> = {
  queued: "排队中",
  running: "进行中",
  waiting_for_human: "等你决定",
  completed: "已完成",
  failed: "出错了",
  verifying: "代码已提交,流水线验证中",
  await_merge: "已提合入请求,等待合入",
};

export interface WaitingQuestion {
  question: string;
  options?: string[];
}

export interface TaskSummary {
  id: string;
  requirement: string;
  status: TaskStatus;
  detail?: string;
  created_at: string;
  luban_account?: string;
  waiting?: {
    waiting_id: string;
    state_version: number;
    step?: string;
    question?: { questions?: WaitingQuestion[] };
  };
  notify?: { delivered: boolean; attempts: number; last_error?: string };
  delivery?: {
    mr_url?: string;
    mr_state?: string;
    pipeline?: string;
    skipped?: string;
  };
}

export interface SemanticEvent {
  eventId: number;
  kind: string;
  ts: string;
  payload: Record<string, unknown>;
}

export async function listTasks(): Promise<TaskSummary[]> {
  return fetch("/tasks").then((r) => r.json());
}

export async function createTask(
  requirement: string,
  account?: string,
): Promise<void> {
  await fetch("/tasks", {
    method: "POST",
    body: JSON.stringify({ requirement, account: account || undefined }),
  });
}

/** 提交决定。409 = 先到决定已生效,把服务端的话原样带给调用方。 */
export async function decide(
  taskId: string,
  stateVersion: number,
  answers: Record<string, string>,
): Promise<{ conflict?: string }> {
  const response = await fetch(`/tasks/${taskId}/decision`, {
    method: "POST",
    body: JSON.stringify({ state_version: stateVersion, answers }),
  });
  if (response.status === 409) {
    const body = await response.json().catch(() => ({}));
    return { conflict: String(body.error ?? "任务状态已变化") };
  }
  return {};
}

export interface ExternalAction {
  idemKey: string;
  kind: string;
  request: Record<string, unknown>;
  result?: Record<string, unknown>;
  sha?: string;
  startedAt: string;
  finishedAt?: string;
}

/** 重跑一单:终态任务续接内核当前步骤。非终态时服务端会拒绝,
 * 把它的解释原样带回。 */
export async function retryTask(
  taskId: string,
): Promise<{ error?: string }> {
  const response = await fetch(`/tasks/${taskId}/retry`, { method: "POST" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return {};
}

/** 外部动作台账(需服务端配 --pg)。404 时把服务端的解释原样带回。 */
export async function listActions(
  taskId: string,
): Promise<{ actions?: ExternalAction[]; unavailable?: string }> {
  const response = await fetch(`/tasks/${taskId}/actions`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { unavailable: String(body.error ?? `HTTP ${response.status}`) };
  }
  return { actions: await response.json() };
}

/** SSE 事件流:重放 + 跟进,组件卸载时调用返回的清理函数。 */
export function tailEvents(
  taskId: string,
  onEvent: (event: SemanticEvent) => void,
): () => void {
  const source = new EventSource(`/tasks/${taskId}/events`);
  source.onmessage = (message) => onEvent(JSON.parse(message.data));
  source.onerror = () => source.close();
  return () => source.close();
}
