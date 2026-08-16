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

/** 修复停机(需人工):与服务端 retry 的准入同一口径——只有这时
 * verifying 的任务才给重跑按钮(在途验证点重跑=重复烧流水线)。 */
export function repairStopped(task: {
  status: TaskStatus;
  delivery?: { pipeline?: string; loop?: { state: string } };
}): boolean {
  const loop = task.delivery?.loop;
  return task.status === "verifying" && (
    loop?.state === "halted" || loop?.state === "exhausted"
    || (task.delivery?.pipeline ?? "").includes("轮询预算耗尽"));
}

/** 状态文案:修复环激活时,"机器正在自救/机器停了需要人"比伞状态
 * "验证中"更有信息量——数据全部来自服务端 loop 账本,不做推断。
 * 人工节点与出错永远压过修复环文案(等人/坏了都比修复更紧急)。 */
export function statusText(task: {
  status: TaskStatus;
  delivery?: { loop?: { round: number; max?: number; state: string } };
}): string {
  const loop = task.delivery?.loop;
  if (loop && task.status !== "waiting_for_human"
      && task.status !== "failed") {
    if (loop.state === "repairing") {
      return `流水线修复中(第 ${loop.round}${
        loop.max !== undefined ? `/${loop.max}` : ""} 轮)`;
    }
    if (loop.state === "halted") return "自动修复已停,需人工";
    if (loop.state === "exhausted") return "修复预算用完,需人工";
  }
  return STATUS_TEXT[task.status] ?? task.status;
}

export type UserRole = "admin" | "developer";

export interface AuthUser {
  username: string;
  role: UserRole;
  /** 个人 Git 令牌的掩码提示(••••末4位);没配则缺席。只写不读:
   * 明文永远不会出现在任何 API 响应里。 */
  git_token_hint?: string;
  /** 平台用户名/邮箱(commit 署名,平台按邮箱认人)。非密,可回显。 */
  git_username?: string;
  git_email?: string;
  /** 月光模式(免审批):开着时本人任务的人工节点自动放行。 */
  moonlight?: boolean;
}

/** 切换月光模式。开启时服务端会把当前已在等的卡就地代答,
 * swept=清了几张。 */
export async function putMoonlight(
  on: boolean,
): Promise<{ moonlight: boolean; swept: number }> {
  const response = await fetch("/auth/me/moonlight", {
    method: "PUT",
    body: JSON.stringify({ on }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

async function errorText(response: Response): Promise<string> {
  const body = await response.json().catch(() => ({}));
  return String(body.error ?? `HTTP ${response.status}`);
}

export async function getSession(): Promise<AuthUser | null> {
  const response = await fetch("/auth/me");
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function login(
  username: string,
  password: string,
): Promise<AuthUser> {
  const response = await fetch("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function logout(): Promise<void> {
  await fetch("/auth/logout", { method: "POST" });
}

/** 设置/更换/删除(传空串)自己的 Git 令牌。回的只有掩码+非密署名。 */
export async function putGitToken(
  token: string,
  gitUsername?: string,
  gitEmail?: string,
): Promise<{
  git_token_hint?: string;
  git_username?: string;
  git_email?: string;
}> {
  const response = await fetch("/auth/me/git-token", {
    method: "PUT",
    body: JSON.stringify({
      token,
      git_username: gitUsername,
      git_email: gitEmail,
    }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function listUsers(): Promise<AuthUser[]> {
  const response = await fetch("/auth/users");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function createUser(
  username: string,
  password: string,
  role: UserRole,
): Promise<AuthUser> {
  const response = await fetch("/auth/users", {
    method: "POST",
    body: JSON.stringify({ username, password, role }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

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
    /** 待办生成时刻:等待时长的唯一来源(服务端本来就发)。 */
    created_at?: string;
    step?: string;
    question?: { questions?: WaitingQuestion[] };
    /** 提问前模型的最后一段话:"如上表"这类指代的落点。 */
    context?: string;
  };
  notify?: { delivered: boolean; attempts: number; last_error?: string };
  delivery?: {
    mr_url?: string;
    mr_state?: string;
    pipeline?: string;
    skipped?: string;
    /** 修复环账本(服务端事实镜像,前端不推断只呈现)。 */
    loop?: {
      round: number;
      max?: number;
      state: "repairing" | "green" | "exhausted" | "halted";
      diagnosis?: string;
    };
  };
  progress?: {
    phases: string[];
    current_index: number;
    current_phase: string;
    step?: string;
    revision?: number;
  };
}

/** 历史条目(服务端 projection.ts 的 TaskHistoryEntry 镜像)。 */
export type TaskHistoryEntry = TaskSummary & {
  event_count: number;
  updated_at: string;
};

/** 历史任务投影(需服务端配 --pg)。404 时把服务端的解释原样带回。 */
export async function listHistory(): Promise<{
  entries?: TaskHistoryEntry[];
  unavailable?: string;
}> {
  const response = await fetch("/history");
  if (response.status === 401) throw new Error(await errorText(response));
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { unavailable: String(body.error ?? `HTTP ${response.status}`) };
  }
  return { entries: await response.json() };
}

export interface SemanticEvent {
  eventId: number;
  kind: string;
  ts: string;
  payload: Record<string, unknown>;
}

export async function listTasks(): Promise<TaskSummary[]> {
  const response = await fetch("/tasks");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

/** 下单表单的数据源:可选模型清单(≤1 个时不必展示下拉)与当前默认。 */
export interface LaunchOptions {
  models: Array<{ provider: string; model: string }>;
  default: { provider?: string; model?: string };
  /** 数字=手刹上限;缺席=不限轮(默认形态,靠收敛刹车兜底)。 */
  repair_rounds?: number;
  /** enabled=false 表示本部署不接代码仓(纯会话演练),表单不显示。 */
  repo: { enabled: boolean; default?: string };
}

export async function getLaunchOptions(): Promise<LaunchOptions> {
  const response = await fetch("/launch-options");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function createTask(
  requirement: string,
  account?: string,
  extras?: {
    repo?: string;
    lane?: string;
    model?: { provider: string; model: string };
    repairRounds?: number;
  },
): Promise<void> {
  const response = await fetch("/tasks", {
    method: "POST",
    body: JSON.stringify({
      requirement,
      account: account || undefined,
      repo: extras?.repo || undefined,
      lane: extras?.lane,
      model: extras?.model,
      repair_rounds: extras?.repairRounds,
    }),
  });
  if (!response.ok) throw new Error(await errorText(response));
}

/** 提交决定。409 = 先到决定已生效,把服务端的话原样带给调用方。
 * answers 的值是自由字符串——点选项和自定义答复走同一条通路;
 * notes 是整卡备注,非空才随身。 */
export async function decide(
  taskId: string,
  stateVersion: number,
  answers: Record<string, string>,
  notes?: string,
  /** 随这次决定一起提交的批注:圈过的几处就是"需要修改"的理由。
   * 渲染由服务端做——清单格式和那四条护栏只该有一份。 */
  annotationIds?: string[],
): Promise<{ conflict?: string }> {
  const response = await fetch(`/tasks/${taskId}/decision`, {
    method: "POST",
    body: JSON.stringify({
      state_version: stateVersion,
      answers,
      notes: notes?.trim() || undefined,
      annotation_ids: annotationIds?.length ? annotationIds : undefined,
    }),
  });
  if (response.status === 409) {
    const body = await response.json().catch(() => ({}));
    return { conflict: String(body.error ?? "任务状态已变化") };
  }
  if (!response.ok) return { conflict: await errorText(response) };
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

/** 跑动中插话:发送即打断,模型把手头这一轮做完就收到。
 * 服务端拒绝的理由(正等你决定 / 没有在跑的会话)原样带回,前端不改写
 * ——它比我们更清楚这一单此刻处在什么状态。 */
export async function interruptTask(
  taskId: string,
  text: string,
): Promise<{ error?: string }> {
  const response = await fetch(`/tasks/${taskId}/interrupt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return {};
}

/** 发过的补充说明 + 送达与否。delivered 是可观测事实(消息已离开
 * pi 的待送队列 = 已进入模型上下文),不是推断。 */
export interface InterruptRecord {
  text: string;
  at: string;
  delivered: boolean;
}

export async function listInterrupts(
  taskId: string,
): Promise<InterruptRecord[]> {
  const response = await fetch(`/tasks/${taskId}/interrupts`);
  if (!response.ok) return [];
  return response.json();
}

/* ---------------- 检视批注 ---------------- */

export interface Annotation {
  id: string;
  author: string;
  created_at: string;
  artifact: string;
  file: string;
  line: number;
  anchor: string;
  note: string;
  kind: "doc" | "code";
  status: "draft" | "sent" | "verified" | "dropped";
  sent_at?: string;
  sent_via?: "interrupt" | "decision";
  verified_at?: string;
  /** 第几次返工(0/缺省 = 首轮)。 */
  rework?: number;
}

export interface AnchorCheck {
  id: string;
  state: "hit" | "moved" | "gone" | "ambiguous";
  line?: number;
  now?: string;
}

export async function listAnnotations(
  taskId: string,
): Promise<{
  items: Annotation[];
  checks: AnchorCheck[];
  /** 最后一批批注送出后,AI 在主会话说的原话(未做逐条对应)。 */
  reply?: { texts: string[]; truncated: boolean };
}> {
  const response = await fetch(`/tasks/${taskId}/annotations`);
  if (!response.ok) return { items: [], checks: [] };
  return response.json();
}

export async function addAnnotation(
  taskId: string,
  input: Omit<Annotation, "id" | "author" | "created_at" | "status">,
): Promise<{ annotation?: Annotation; error?: string }> {
  const response = await fetch(`/tasks/${taskId}/annotations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return { annotation: await response.json() };
}

export async function dropAnnotation(
  taskId: string,
  annotationId: string,
): Promise<{ error?: string }> {
  const response = await fetch(
    `/tasks/${taskId}/annotations/${encodeURIComponent(annotationId)}`,
    { method: "DELETE" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return {};
}

/** 检视闭环的裁决:verdict = verify(确认通过) | reopen(返工再送一轮)。 */
export async function judgeAnnotation(
  taskId: string,
  annotationId: string,
  verdict: "verify" | "reopen",
): Promise<{ error?: string }> {
  const response = await fetch(
    `/tasks/${taskId}/annotations/${encodeURIComponent(annotationId)}/${verdict}`,
    { method: "POST" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return {};
}

/** 通过执行中补充通道发送给模型。ids 省略=全部待提交批注。 */
export async function sendAnnotations(
  taskId: string,
  ids?: string[],
): Promise<{ sent?: string[]; error?: string }> {
  const response = await fetch(`/tasks/${taskId}/annotations/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(ids ? { ids } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return await response.json();
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

/** 交付时间线条目(服务端 src/timeline.ts 的镜像)。 */
export interface TimelineEntry {
  ts: string;
  kind: "session" | "phase" | "ask" | "decision" | "agent" | "quality";
  title: string;
  detail?: string;
  tone: "info" | "attention" | "success" | "danger";
}

/** 任务的人话时间线。服务端未提供该路由(旧进程)时把解释带回,
 * 不假装"这单什么都没发生"。 */
export async function listTimeline(
  taskId: string,
): Promise<{ entries?: TimelineEntry[]; unavailable?: string }> {
  const response = await fetch(`/tasks/${taskId}/timeline`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return {
      unavailable: response.status === 404
        ? "时间线接口尚未就绪(服务重启后可用)。"
        : String(body.error ?? `HTTP ${response.status}`),
    };
  }
  return { entries: await response.json() };
}

/** 检视产物(服务端 src/artifacts.ts 的镜像):决策处要看的材料。 */
export interface ArtifactMeta {
  name: string;
  label: string;
  kind: "doc" | "diff";
  bytes: number;
  modified_at: string;
}

export async function listArtifacts(
  taskId: string,
): Promise<{ items?: ArtifactMeta[]; unavailable?: string }> {
  const response = await fetch(`/tasks/${taskId}/artifacts`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return {
      unavailable: response.status === 404
        ? "产物接口尚未就绪(服务重启后可用)。"
        : String(body.error ?? `HTTP ${response.status}`),
    };
  }
  return { items: await response.json() };
}

/** 管理页运行时设置(服务端 src/settings.ts 的镜像)。
 * 密钥只写不读:视图里只有掩码(••••末4位),明文永远不出网。 */
export interface SettingsView {
  runtime: {
    max_concurrent?: number;
    repair_rounds?: number;
    poll_interval_s?: number;
    poll_timeout_s?: number;
  };
  luban: {
    endpoint?: string;
    headers: Array<{ name: string; hint: string }>;
  };
  models: {
    configured: boolean;
    provider?: string;
    model?: string;
    providers: Array<{ name: string; models: string[]; key_hint?: string }>;
  };
}

export async function getSettings(): Promise<SettingsView> {
  const response = await fetch("/settings");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

async function putSettings(
  section: "runtime" | "luban" | "models",
  body: unknown,
): Promise<SettingsView> {
  const response = await fetch(`/settings/${section}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export function putRuntimeSettings(
  body: Record<string, unknown>,
): Promise<SettingsView> {
  return putSettings("runtime", body);
}

/** headers 语义:给值=替换,给空串=删除,不给的键服务端保留——
 * 界面只有掩码,回填明文不可能,合并责任在服务端。 */
export function putLubanSettings(body: {
  endpoint?: string;
  headers?: Record<string, string>;
}): Promise<SettingsView> {
  return putSettings("luban", body);
}

export function putModelsSettings(body: {
  json?: unknown;
  provider?: string;
  model?: string;
}): Promise<SettingsView> {
  return putSettings("models", body);
}

export async function testLuban(): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch("/settings/luban/test", { method: "POST" });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function readArtifact(
  taskId: string,
  name: string,
): Promise<{ content?: string; kind?: string; unavailable?: string }> {
  const response = await fetch(
    `/tasks/${taskId}/artifacts/${encodeURIComponent(name)}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { unavailable: String(body.error ?? `HTTP ${response.status}`) };
  }
  const body = await response.json();
  return { content: String(body.content ?? ""), kind: String(body.kind ?? "doc") };
}
