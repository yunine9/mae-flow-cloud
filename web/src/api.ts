/**
 * 任务 API 的类型化镜像。前端不推断状态(主 spec §5.1):
 * 这里的类型就是 taskService.TaskSummary 的形状,文案与判断
 * 全部来自服务端镜像,前端只负责呈现与提交决定。
 */

export type TaskStatus =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "waiting_for_human"
  | "completed"
  | "verifying"
  | "await_merge"
  | "canceled"
  | "failed";

export const STATUS_TEXT: Record<TaskStatus, string> = {
  queued: "排队中",
  running: "进行中",
  pausing: "正在暂停",
  paused: "已暂停",
  waiting_for_human: "等你决定",
  completed: "已完成",
  failed: "出错了",
  verifying: "代码已提交,流水线验证中",
  await_merge: "已提合入请求,等待合入",
  canceled: "已取消",
};

/** 修复停机(需人工):与服务端 retry 的准入同一口径——只有这时
 * verifying 的任务才给重跑按钮(在途验证点重跑=重复烧流水线)。 */
export function repairStopped(task: {
  status: TaskStatus;
  delivery?: { pipeline?: string; stalled?: string; loop?: { state: string } };
}): boolean {
  const loop = task.delivery?.loop;
  return task.status === "verifying" && (
    loop?.state === "halted" || loop?.state === "exhausted"
    // stalled = 外部验证自愈预算烧完并如实停下(推送一直失败、流水线
    // 迟迟不给可核销结果)。同样是"机器停了,该人上"。
    || Boolean(task.delivery?.stalled)
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
  if (loop && ["queued", "running", "pausing", "verifying"]
    .includes(task.status)) {
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
  /** 管理员配置的可选检视人；不是角色，也不会自动收到任务通知。 */
  committer?: boolean;
  /** 个人 Git 令牌的掩码提示(••••末4位);没配则缺席。只写不读:
   * 明文永远不会出现在任何 API 响应里。 */
  git_token_hint?: string;
  /** 署名邮箱(必填,commit 归属与平台对人都按它)。git 用户名即登录
   * 账号名,不另配。非密,可回显。 */
  git_email?: string;
  /** 个人通知令牌的掩码提示;同样只写不读。通知以令牌对应的人的
   * 身份发,所以按人配——管理员配一个服务号,大家收到的都是机器人。 */
  luban_token_hint?: string;
  /** 月光模式(免审批):开着时本人任务的人工节点自动放行。 */
  moonlight?: boolean;
  /** push 前清单过目的个人默认。缺省即开:只有显式 false 是关。 */
  push_confirmation?: boolean;
}

export interface MoonlightPreview {
  waiting: number;
  eligible: number;
  blocked_annotations: number;
  blocked_other: number;
}

export async function getMoonlightPreview(): Promise<MoonlightPreview> {
  const response = await fetch("/auth/me/moonlight-preview");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

/** 默认只影响后续节点；当前待办必须在用户看过预览后显式提交。 */
export async function putMoonlight(
  on: boolean,
  includeCurrent = false,
  expectedEligible?: number,
): Promise<{ moonlight: boolean; swept: number } & MoonlightPreview> {
  const response = await fetch("/auth/me/moonlight", {
    method: "PUT",
    body: JSON.stringify({
      on,
      include_current: includeCurrent,
      expected_eligible: expectedEligible,
    }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

/** push 前清单过目的个人默认(缺省即开)。 */
export async function putPersonalPushConfirmation(
  on: boolean,
): Promise<AuthUser> {
  const response = await fetch("/auth/me/push-confirmation", {
    method: "PUT",
    body: JSON.stringify({ on }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

/** push 前人工确认开关。已推送后再开会 409,如实提示。 */
export async function putPushConfirmation(
  taskId: string,
  on: boolean,
): Promise<TaskSummary> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/push-confirmation`, {
      method: "PUT",
      body: JSON.stringify({ on }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function putTaskApprovalMode(
  taskId: string,
  mode: "inherit" | "manual" | "moonlight",
  includeCurrent = false,
): Promise<{ task: TaskSummary; swept: number; blocked_annotations: number }> {
  const response = await fetch(`/tasks/${taskId}/moonlight`, {
    method: "PUT",
    body: JSON.stringify({ mode, include_current: includeCurrent }),
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

/** 设置/更换/删除(传空串)自己的 Git 令牌+署名邮箱(必填)。
 * 回的只有掩码+邮箱;git 用户名即登录账号名,不另配。 */
export async function putGitToken(
  token: string,
  gitEmail?: string,
): Promise<{
  git_token_hint?: string;
  git_email?: string;
}> {
  const response = await fetch("/auth/me/git-token", {
    method: "PUT",
    body: JSON.stringify({ token, git_email: gitEmail }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function putLubanToken(
  token: string,
): Promise<{ luban_token_hint?: string }> {
  const response = await fetch("/auth/me/luban-token", {
    method: "PUT",
    body: JSON.stringify({ token }),
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

/** 管理员重置密码:内部平台,不验旧密码(忘了就找管理员)。 */
export async function resetUserPassword(
  username: string,
  password: string,
): Promise<void> {
  const response = await fetch(
    `/auth/users/${encodeURIComponent(username)}/password`, {
      method: "PUT",
      body: JSON.stringify({ password }),
    });
  if (!response.ok) throw new Error(await errorText(response));
}

/** 管理员删账号(物理删除;不能删自己/最后一个管理员,服务端把关)。 */
export async function deleteUser(username: string): Promise<void> {
  const response = await fetch(
    `/auth/users/${encodeURIComponent(username)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await errorText(response));
}

export async function listCommitters(): Promise<AuthUser[]> {
  const response = await fetch("/auth/committers");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function putCommitter(
  username: string,
  on: boolean,
): Promise<AuthUser> {
  const response = await fetch(
    `/auth/users/${encodeURIComponent(username)}/committer`, {
      method: "PUT",
      body: JSON.stringify({ on }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

/** 多仓需求图的结构化确认:消费同一张人工检视卡并恢复分析会话，
 * 随后幂等生成各仓交付；不是独立于审批卡之外的第二套状态。 */
export async function confirmRequirementGraph(
  taskId: string,
): Promise<TaskSummary> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/graph/confirm`, { method: "POST" });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function requestCommitterReview(
  taskId: string,
  committer: string,
): Promise<ReviewRequest> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/review-request`, {
    method: "POST",
    body: JSON.stringify({ committer }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export interface ReviewRequest {
  id: string;
  task_id: string;
  task_title: string;
  requester: string;
  committer: string;
  status: "pending" | "completed";
  created_at: string;
  completed_at?: string;
  delivered: boolean;
  attempts: number;
  last_error?: string;
}

export async function listMyReviews(): Promise<ReviewRequest[]> {
  const response = await fetch("/reviews/mine");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function listTaskReviews(taskId: string): Promise<ReviewRequest[]> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/reviews`);
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function completeReview(reviewId: string): Promise<ReviewRequest> {
  const response = await fetch(
    `/reviews/${encodeURIComponent(reviewId)}/complete`, { method: "POST" });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export interface WaitingQuestion {
  question: string;
  options?: string[];
}

export interface TaskProgress {
  phases: string[];
  current_index: number;
  current_phase: string;
  step?: string;
  revision?: number;
  /** 子任务里程碑由服务端透传；缺席时沿用原有阶段进度展示。 */
  milestone?: {
    task_id: string;
    title: string;
    event: "started" | "completed" | "blocked";
    reason?: string;
  };
}

/** Cloud 在每次 push 前运行的独立验证会话。它不属于内核流程状态，
 * 因此只作为 delivery 的可选事实镜像；旧后端不返回时前端保持原样。 */
export type PrepushState =
  | "queued"
  | "preparing"
  | "compiling"
  | "testing"
  | "repairing"
  | "blocked"
  | "environment_error"
  | "passed";

export interface PrepushVerification {
  state: PrepushState | (string & {});
  /** 自动修复轮次；只有 Cloud 启动修复 Agent 后才会出现。 */
  round?: number;
  /** 当前动作或异常摘要，由 Cloud 原样透传。 */
  message?: string;
  /** 本次验证绑定的提交；push 只能复用同一 SHA 的通过结果。 */
  sha?: string;
  updated_at?: string;
}

export interface TaskTokenUsage {
  /** 均为模型提供方真实上报；服务端不做字符数估算。 */
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** 最近 60 秒吞吐；没有新响应时会自然归零。 */
  input_tokens_per_minute: number;
  output_tokens_per_minute: number;
  rate_window_seconds: 60;
  updated_at: string;
  source: "provider";
}

export interface TaskSummary {
  id: string;
  title?: string;
  requirement: string;
  requirement_document?: {
    name: string;
    bytes: number;
    context_mode: "inline" | "file";
  };
  entry_kind?: "requirement" | "dts";
  issue_context?: {
    source: "manual";
    stage: "triage" | "delivery";
    environments: IssueEnvironmentRef[];
    adapter: { logs: boolean; deploy: boolean; rollback: boolean };
  };
  status: TaskStatus;
  /** 服务端对现有事实的唯一扫读解释；旧后端缺席时界面安全降级。 */
  focus?: {
    kind: "human_action" | "blocked" | "machine" | "external" | "done" | "inactive";
    headline: string;
    next_action: string;
    owner: "responsible" | "agent" | "platform" | "none";
    needs_attention: boolean;
    priority: number;
  };
  detail?: string;
  created_at: string;
  updated_at?: string;
  last_progress_at?: string;
  completed_at?: string;
  token_usage?: TaskTokenUsage;
  /** 现场被回收的时刻。有值 = 代码克隆等大件已删,过程记录/证据/批注仍在。
   * 页面据此如实说明,别让人对着 404 的代码差异发愣。 */
  workspace_reclaimed_at?: string;
  luban_account?: string;
  approval_mode?: "inherit" | "manual" | "moonlight";
  repo_url?: string;
  repositories?: string[];
  /** 下单或 Chain 方案确认时选中的仓内 Skill；每个子任务只继承自己仓。 */
  repository_skills?: SelectedRepositorySkill[];
  /** 本单开局明确加载的 docs 业务知识；规则文件无需手选。 */
  repository_knowledge?: SelectedRepositoryKnowledge[];
  /** Cloud 的知识消费观测，不参与内核裁决。 */
  knowledge_usage?: TaskKnowledgeUsage;
  /** 仓内 Skill 与代码交付使用同一基线。 */
  baseline?: string;
  /** 新任务复用时沿用的交付方式与修复预算。 */
  lane?: string;
  repair_rounds?: number;
  /** 业务需求/问题单号；与平台内部 task-xx 分开显示。 */
  ticket?: string;
  requirement_graph?: {
    stage: "analysis" | "confirmed";
    repositories: Array<{
      id: string; name: string; url: string; responsibility?: string; task_id?: string;
    }>;
    /** `from 依赖 to`：from 等待 to，to 是前置仓库。 */
    dependencies: Array<{ from: string; to: string; reason?: string }>;
  };
  parent_task_id?: string;
  blocked_by?: string[];
  waiting?: {
    waiting_id: string;
    state_version: number;
    /** 待办生成时刻:等待时长的唯一来源(服务端本来就发)。 */
    created_at?: string;
    step?: string;
    question?: { questions?: WaitingQuestion[] };
    /** 提问前模型的最后一段话:"如上表"这类指代的落点。 */
    context?: string;
    recommended_view?: "source" | "doc" | "chain" | "diff";
    /** 由服务端读取内核 flow 投影；前端据此识别关闭检视与继续处理意见
     * 的选项，不维护 build_review 等阶段表。 */
    choice_effects?: Array<{
      key: string;
      answers: string[];
      allows_source_edit: boolean;
      handles_feedback: boolean;
      closes_feedback: boolean;
    }>;
  };
  notify?: { delivered: boolean; attempts: number; last_error?: string };
  delivery?: {
    mr_url?: string;
    mr_state?: string;
    pipeline?: string;
    skipped?: string;
    /** Cloud 原生推送前快检；缺席表示服务端尚未开始或不支持该能力。 */
    prepush?: PrepushVerification;
    /** 卡在哪一环的人话(等审批、等某一项核销结果……)。服务端一直
     * 在写,前端一直没显示——于是"验证中"三个字后面藏着的真实原因
     * 谁也看不到,任务看着像马上要成了,其实早就停了。 */
    waiting_on?: string;
    /** 自愈已停、等人介入的原因。有它就该亮牌子给「重跑续推」。 */
    stalled?: string;
    /** 修复环账本(服务端事实镜像,前端不推断只呈现)。 */
    loop?: {
      round: number;
      max?: number;
      state: "repairing" | "green" | "exhausted" | "halted";
      diagnosis?: string;
      /** 流水线失败的平台原文(摘要)。刹车告警必须连它一起亮:诊断是
       * 会话的收口发言,可能在聊别的事(内网实锤:最后一轮会话在补文档
       * 章节,告警正文全是章节标题,流水线到底红在哪谁也看不见)。 */
      failure?: string;
    };
  };
  delivery_selection?: {
    paths: string[];
    observed_paths: string[];
    excluded_paths: string[];
    status: "requested" | "confirmed";
    waiting_id: string;
    head: string;
    baseline?: string;
    updated_at: string;
  };
  /** push 前人工确认交付清单(任务级开关,默认关)。 */
  push_confirmation?: boolean;
  progress?: TaskProgress;
  control?: {
    last_action: "pause" | "resume" | "cancel";
    actor: string;
    at: string;
    paused_from?: TaskStatus;
  };
}

export interface IssueEnvironmentRef {
  id: string;
  name: string;
  purpose: "logs" | "deploy" | "both";
  protocol: "ssh";
  host: string;
  port: number;
  accounts: Array<{
    username: string;
    credential_state: "stored";
  }>;
  /** 兼容短暂存在过的单账号任务现场。 */
  username?: string;
  credential_state?: "stored";
}

export interface IssueEnvironmentInput {
  name: string;
  purpose: "logs" | "deploy" | "both";
  host: string;
  port?: number;
  accounts: Array<{ username: string; password: string }>;
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
  /** 同一任务的主 Agent、开发助手、子 Agent 共用事件流，用它区分来源。 */
  sessionId?: string;
  payload: Record<string, unknown>;
}

export async function listTasks(): Promise<TaskSummary[]> {
  const response = await fetch("/tasks");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function getTask(taskId: string): Promise<TaskSummary> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}`);
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

/** 团队知识运营使用独立低频读接口，不扩大任务列表轮询响应。 */
export async function getKnowledgeInsights(): Promise<TeamKnowledgeInsights> {
  const response = await fetch("/knowledge-insights");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

/** 下单表单的数据源:可选模型清单(≤1 个时不必展示下拉)与当前默认。 */
export interface LaunchBlocker {
  key: string;
  label: string;
  where: "admin" | "me";
}

export interface LaunchOptions {
  /** 当前生效的模型(展示用;模型不给选,管理员统一配一个)。 */
  model?: { provider: string; model: string };
  /** 数字=手刹上限;缺席=不限轮(默认形态,靠收敛刹车兜底)。 */
  repair_rounds?: number;
  /** enabled=false 表示本部署不接代码仓(纯会话演练),表单不显示。
   * required=true 时必填——本部署不设默认仓,每单写明交到哪儿。 */
  repo: { enabled: boolean; required: boolean };
  /** 单号/基线分支:内核配置确认要的两项事实,下单一并收齐——
   * 不让模型开工后再逐项来问(和交付方式同一逻辑)。 */
  ticket: { enabled: boolean; required: boolean };
  baseline: { enabled: boolean; default: string };
  /** 没配齐的配置项:where=admin 归管理员,me 归本人。非空=不给下单。 */
  blockers: LaunchBlocker[];
  /** 交付方式:**取自内核 flow.json**(key=内核代号,label=给人看的),
   * 前端一个字都不许另抄——抄了就会出现"页面说快速/慢速、内核只认
   * 完整开发/局部修改",于是下单选过的交付方式在流程里又被问一遍。
   * 空数组=读不到内核定义,那就不预选,老老实实等流程里问。 */
  /** steps/acks:这条链多少步、要拍板几次——内核按 flow 现算,
   * 给人掂量快慢;算不出时缺席,只显示名字。 */
  workflows: Array<
    { key: string; label: string; steps?: number; acks?: number }>;
}

export async function getLaunchOptions(): Promise<LaunchOptions> {
  const response = await fetch("/launch-options");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

/** 业务仓自带的、可由本任务显式启用的 Skill。扫描只建立目录，真正
 * 读取哪个 Skill、何时读取由 Agent 按任务语义决定。 */
export interface RepositorySkill {
  id: string;
  name: string;
  description: string;
  relative_path: string;
  source: string;
  digest: string;
  selectable: boolean;
  warning?: string;
}

export interface RepositoryKnowledge {
  id: string;
  title: string;
  description: string;
  relative_path: string;
  kind: "rules" | "document";
  digest: string;
  bytes: number;
  selectable: boolean;
  recommended: boolean;
  auto_load: boolean;
  warning?: string;
}

export interface SelectedRepositoryKnowledge extends RepositoryKnowledge {
  repository: string;
  revision: string;
  kind: "document";
}

export type KnowledgeKind = "rules" | "document" | "skill";
export type KnowledgeAction = "available" | "loaded" | "read" | "searched";

export interface TaskKnowledgeResource {
  id: string;
  kind: KnowledgeKind;
  name: string;
  path: string;
  repository?: string;
  description?: string;
  digest?: string;
  selected?: boolean;
  state: "available" | "loaded" | "used";
  available_count: number;
  loaded_count: number;
  read_count: number;
  first_at?: string;
  last_at?: string;
}

export interface TaskKnowledgeUsage {
  summary: {
    resources: number;
    loaded: number;
    used: number;
    skills_used: number;
    selected_unused: number;
  };
  resources: TaskKnowledgeResource[];
  events: Array<{
    id: string;
    kind: KnowledgeKind;
    name: string;
    path: string;
    repository?: string;
    selected?: boolean;
    ts: string;
    session_id: string;
    session_role: "main" | "subagent" | "prepush" | "developer-assistant";
    step?: string;
    action: KnowledgeAction;
    observed_path?: string;
  }>;
}

export type KnowledgeRecommendationKind =
  | "coverage-gap"
  | "needs-review"
  | "selected-unused"
  | "promote";

export interface KnowledgeInsightResource {
  key: string;
  kind: KnowledgeKind;
  name: string;
  path: string;
  /** 可读性:选中资源=仓内扫描的描述;自发读取=观测时抽的首标题摘要。 */
  description?: string;
  repository?: string;
  provided_tasks: number;
  selected_tasks: number;
  loaded_tasks: number;
  accessed_tasks: number;
  access_events: number;
  completed_tasks: number;
  repair_tasks: number;
  attention_tasks: number;
  last_used_at?: string;
}

export interface KnowledgeRecommendation {
  id: string;
  kind: KnowledgeRecommendationKind;
  tone: "attention" | "info" | "positive";
  title: string;
  evidence: string;
  action: string;
  resource_key?: string;
  task_ids?: string[];
}

/** 团队 Skill 货架条目:部署数据目录 skills/ 里当前生效的资产身份。
 * 正文不进接口;digest 是版本锚。 */
/** 货架条目的效果账(飞轮第 3 步):消费率 × prepush 一次过对照。
 * 只是相关性观察,不构成对任何任务或 skill 的裁决。 */
export interface HostSkillEffect {
  provided_tasks: number;
  accessed_tasks: number;
  access_events: number;
  repair_tasks: number;
  prepush_measured: number;
  prepush_first_pass: number;
  baseline_measured: number;
  baseline_first_pass: number;
  signal?: "low-consumption" | "high-friction";
  signal_evidence?: string;
}

export interface HostSkillShelfEntry {
  name: string;
  description: string;
  digest: string;
  updated_at: string;
  path: string;
  bytes: number;
  /** false = pi 装载器不认(缺 name/description 等),放了也不进会话。 */
  loadable: boolean;
  effect?: HostSkillEffect;
  /** 待裁决的修订候选数(沉淀环起草、尚未采纳/丢弃的草稿)。 */
  candidates?: number;
}

export interface HostSkillShelf {
  root_exists: boolean;
  skills: HostSkillShelfEntry[];
  warnings: string[];
}

/** 资产库操作留痕(谁/何时/什么动作/什么指纹),服务端逐条记录。 */
export interface SkillOperationRecord {
  at: string;
  operator: string;
  action: "upload" | "update" | "offline" | "rollback";
  directory: string;
  skill_digest?: string;
  package_digest?: string;
  files?: number;
  bytes?: number;
  detail?: string;
}

export interface SkillVersionRecord {
  version_id: string;
  archived_at: string;
  action: string;
  operator: string;
  skill_digest: string;
  package_digest: string;
  files: number;
  bytes: number;
}

export interface SkillUploadFile {
  path: string;
  content_base64: string;
}

/** 货架 + 留痕一次取齐(管理面自刷新用,与 knowledge-insights 解耦)。 */
export async function getSkillLibrary(): Promise<
  HostSkillShelf & { operations: SkillOperationRecord[] }
> {
  const response = await fetch("/skills");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function uploadSkill(
  directory: string,
  files: SkillUploadFile[],
): Promise<SkillOperationRecord> {
  const response = await fetch(`/skills/${encodeURIComponent(directory)}`, {
    method: "PUT",
    body: JSON.stringify({ files }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function offlineSkill(
  directory: string,
): Promise<SkillOperationRecord> {
  const response = await fetch(`/skills/${encodeURIComponent(directory)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function listSkillVersions(
  directory: string,
): Promise<SkillVersionRecord[]> {
  const response = await fetch(
    `/skills/${encodeURIComponent(directory)}/versions`);
  if (!response.ok) throw new Error(await errorText(response));
  return (await response.json()).versions ?? [];
}

export async function rollbackSkill(
  directory: string,
  version: string,
): Promise<SkillOperationRecord> {
  const response = await fetch(
    `/skills/${encodeURIComponent(directory)}/rollback`, {
      method: "POST",
      body: JSON.stringify({ version }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

/** 修订候选(沉淀环):agent 从任务现场起草的 SKILL.md 草稿。 */
export interface SkillCandidateRecord {
  id: string;
  directory: string;
  created_at: string;
  operator: string;
  status: "drafted" | "adopted" | "discarded";
  evidence_tasks: string[];
  adopted_at?: string;
  adopted_by?: string;
}

export async function distillSkill(
  directory: string,
): Promise<SkillCandidateRecord> {
  const response = await fetch(
    `/skills/${encodeURIComponent(directory)}/distill`, { method: "POST" });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function listSkillCandidates(
  directory: string,
): Promise<SkillCandidateRecord[]> {
  const response = await fetch(
    `/skills/${encodeURIComponent(directory)}/candidates`);
  if (!response.ok) throw new Error(await errorText(response));
  return (await response.json()).candidates ?? [];
}

export async function getSkillCandidate(
  directory: string,
  id: string,
): Promise<{
  record: SkillCandidateRecord;
  skill: string;
  notes: string;
  evidence: string;
}> {
  const response = await fetch(`/skills/${encodeURIComponent(directory)}`
    + `/candidates/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function adoptSkillCandidate(
  directory: string,
  id: string,
): Promise<SkillOperationRecord> {
  const response = await fetch(`/skills/${encodeURIComponent(directory)}`
    + `/candidates/${encodeURIComponent(id)}/adopt`, { method: "POST" });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function discardSkillCandidate(
  directory: string,
  id: string,
): Promise<void> {
  const response = await fetch(`/skills/${encodeURIComponent(directory)}`
    + `/candidates/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await errorText(response));
}

export interface TeamKnowledgeInsights {
  generated_at: string;
  summary: {
    tracked_tasks: number;
    accessed_tasks: number;
    unique_resources: number;
    active_resources: number;
    selected_unused: number;
    opportunities: number;
    access_rate: number;
  };
  resources: KnowledgeInsightResource[];
  recommendations: KnowledgeRecommendation[];
  /** 团队 Skill 货架(旧服务端没有该字段,前端按缺席兼容)。 */
  host_skills?: HostSkillShelf;
}

/** 已经由服务端目录令牌验证、记在任务上的仓内 Skill。Chain 检视页
 * 只用它展示/映射当前选择，不接收浏览器自报的正文或绝对路径。 */
export interface SelectedRepositorySkill extends RepositorySkill {
  repository: string;
  revision: string;
}

export interface RepositorySkillCatalog {
  catalog_token: string;
  repositories: Array<{
    repository: string;
    revision: string;
    skills: RepositorySkill[];
    knowledge: RepositoryKnowledge[];
    error?: string;
  }>;
}

/** 明确由用户触发，不随仓库输入自动 clone/扫描。 */
export async function scanRepositorySkills(
  repositories: string[],
  baseline?: string,
  signal?: AbortSignal,
): Promise<RepositorySkillCatalog> {
  const response = await fetch("/repository-skills/scan", {
    method: "POST",
    signal,
    body: JSON.stringify({
      repositories,
      baseline: baseline?.trim() || undefined,
    }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function createTask(
  requirement: string,
  account?: string,
  extras?: {
    title?: string;
    repo?: string;
    repos?: string[];
    entryKind?: "requirement" | "dts";
    issueEnvironments?: IssueEnvironmentInput[];
    lane?: string;
    ticket?: string;
    baseline?: string;
    model?: { provider: string; model: string };
    repairRounds?: number;
    repositorySkillCatalogToken?: string;
    selectedRepositorySkillIds?: string[];
    selectedRepositoryKnowledgeIds?: string[];
    requirementDocumentName?: string;
  },
): Promise<void> {
  const response = await fetch("/tasks", {
    method: "POST",
    body: JSON.stringify({
      requirement,
      requirement_document_name: extras?.requirementDocumentName,
      title: extras?.title?.trim() || undefined,
      account: account || undefined,
      repo: extras?.repo || undefined,
      repos: extras?.repos?.length ? extras.repos : undefined,
      entry_kind: extras?.entryKind,
      issue_environments: extras?.entryKind === "dts"
        ? extras.issueEnvironments ?? [] : undefined,
      // 空白等于没选，由服务端使用内核第一项；不要把 "" 伪装成
      // 一个需要校验的交付方式。
      lane: extras?.lane?.trim() || undefined,
      ticket: extras?.ticket || undefined,
      baseline: extras?.baseline || undefined,
      model: extras?.model,
      repair_rounds: extras?.repairRounds,
      repository_skill_catalog_token:
        extras?.repositorySkillCatalogToken || undefined,
      selected_repository_skill_ids:
        extras?.selectedRepositorySkillIds,
      selected_repository_knowledge_ids:
        extras?.selectedRepositoryKnowledgeIds,
    }),
  });
  if (!response.ok) throw new Error(await errorText(response));
}

/** 提交决定。结构化选项与自由说明分开，服务端统一查询未闭环批注。 */
export async function decide(
  taskId: string,
  stateVersion: number,
  selectedOptions: Record<string, string>,
  freeResponses: Record<string, string>,
  comment?: string,
  /** 随这次决定一起提交的批注:圈过的几处就是"需要修改"的理由。
   * 渲染由服务端做——清单格式和那四条护栏只该有一份。 */
  annotationIds?: string[],
  /** Chain 方案确认与 Skill 选择共用一次提交。字段缺席=沿用父任务
   * 已有选择；目录读取成功后即使 ids 为空也必须提交，明确表示清空。 */
  repositorySkills?: {
    catalogToken: string;
    selectedIds: string[];
    selectedKnowledgeIds: string[];
  },
  /** 代码检视勾选的最终交付文件；空数组表示明确不选任何文件。 */
  deliveryPaths?: string[],
): Promise<{ conflict?: string }> {
  const response = await fetch(`/tasks/${taskId}/decision`, {
    method: "POST",
    body: JSON.stringify({
      state_version: stateVersion,
      selected_options: selectedOptions,
      free_responses: freeResponses,
      comment: comment?.trim() || undefined,
      annotation_ids: annotationIds?.length ? annotationIds : undefined,
      repository_skill_catalog_token: repositorySkills?.catalogToken,
      selected_repository_skill_ids: repositorySkills?.selectedIds,
      selected_repository_knowledge_ids:
        repositorySkills?.selectedKnowledgeIds,
      delivery_paths: deliveryPaths,
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

/** 清空同一任务的旧现场并从第一步重跑。服务端只允许责任人操作真终态。 */
export async function rerunTaskFromStart(
  taskId: string,
): Promise<{ task?: TaskSummary; error?: string }> {
  const response = await fetch(`/tasks/${taskId}/rerun`, { method: "POST" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return { task: await response.json() };
}

/** 管理员彻底删除真终态历史及 Cloud 内全部关联现场。 */
export async function deleteHistoryTask(
  taskId: string,
): Promise<{ error?: string }> {
  const response = await fetch(`/tasks/${taskId}`, { method: "DELETE" });
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

export interface DeveloperAssistantMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface DeveloperAssistantToolRun {
  call_id: string;
  name: string;
  input: string;
  result?: string;
  state: "running" | "passed" | "failed";
  started_at: string;
  finished_at?: string;
}

export interface DeveloperAssistantAvailability {
  available: boolean;
  code: "edit_window" | "user_override" | "approval_pending" | "host_wait"
    | "not_editable" | "core_unavailable" | "session_only";
  mode: "edit" | "unavailable";
  reason: string;
  core?: {
    step: string;
    title?: string;
    revision?: number;
    approval_subject_id?: string;
  };
}

export interface DeveloperAssistantHandoff {
  state: "running" | "unchanged" | "changed" | "returned" | "blocked";
  message: string;
  changed_paths?: string[];
  started_at: string;
  finished_at?: string;
  returned_at?: string;
}

export interface DeveloperAssistantView {
  state: "idle" | "running" | "completed" | "failed" | "interrupted";
  messages: DeveloperAssistantMessage[];
  tools: DeveloperAssistantToolRun[];
  availability: DeveloperAssistantAvailability;
  handoff?: DeveloperAssistantHandoff;
  updated_at?: string;
  error?: string;
}

export async function getDeveloperAssistant(
  taskId: string,
): Promise<DeveloperAssistantView> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/developer-assistant`,
  );
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function startDeveloperAssistant(
  taskId: string,
  text: string,
): Promise<DeveloperAssistantView> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/developer-assistant`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function controlTask(
  taskId: string,
  action: "pause" | "resume" | "cancel",
): Promise<{ task?: TaskSummary; error?: string }> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/${action}`, {
    method: "POST",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return { task: await response.json() };
}

/** 发过的补充说明 + 送达与否。delivered 是可观测事实(消息已离开
 * pi 的待送队列 = 已进入模型上下文),不是推断。 */
export interface InterruptRecord {
  text: string;
  at: string;
  delivered: boolean;
  /** 你说完之后它说的话(按时间切到下一条插话为止)。
   * 刻意不叫 reply:宿主没法证明哪一段是在答你,只能给时间顺序。 */
  said: Array<{ text: string; at: string }>;
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
  edited_at?: string;
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

export async function editAnnotation(
  taskId: string,
  annotationId: string,
  note: string,
): Promise<{ annotation?: Annotation; error?: string }> {
  const response = await fetch(
    `/tasks/${taskId}/annotations/${encodeURIComponent(annotationId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note }),
    });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { error: String(body.error ?? `HTTP ${response.status}`) };
  }
  return { annotation: await response.json() };
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

export type SseConnectionState = "connecting" | "live" | "reconnecting";

/** SSE 事件流:重放 + 跟进,组件卸载时调用返回的清理函数。
 * error 时不能主动 close：EventSource 自带断线重连，服务端重放再由
 * eventId 去重；主动关闭会把一次内网抖动变成永久断流。 */
export function tailEvents(
  taskId: string,
  onEvent: (event: SemanticEvent) => void,
  onState?: (state: SseConnectionState) => void,
): () => void {
  onState?.("connecting");
  const source = new EventSource(`/tasks/${taskId}/events`);
  source.onopen = () => onState?.("live");
  source.onmessage = (message) => onEvent(JSON.parse(message.data));
  source.onerror = () => onState?.("reconnecting");
  return () => source.close();
}

/** 推送前验证的实时事件流:换轮(修复后新 HEAD 再验)由服务端切文件
 * 并从头重放新一轮,前端只管渲染。 */
export function tailPrepushEvents(
  taskId: string,
  onEvent: (event: SemanticEvent) => void,
  onState?: (state: SseConnectionState) => void,
): () => void {
  onState?.("connecting");
  const source = new EventSource(`/tasks/${taskId}/prepush/events`);
  source.onopen = () => onState?.("live");
  source.onmessage = (message) => onEvent(JSON.parse(message.data));
  source.onerror = () => onState?.("reconnecting");
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
  /** 差异产物包含的真实文件数；文档产物不提供。 */
  file_count?: number;
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
    workspace_retention_days?: number;
  };
  models: {
    configured: boolean;
    provider?: string;
    model?: string;
    url?: string;
    key_hint?: string;
    providers: Array<{ name: string; models: string[]; key_hint?: string }>;
  };
  /** 未设置覆盖时实际采用的服务默认值，不让管理员猜启动参数。 */
  defaults: {
    runtime: {
      max_concurrent: number;
      repair_rounds: number | null;
      poll_interval_s: number;
      poll_timeout_s: number;
      workspace_retention_days: number;
    };
    models: {
      configured: boolean;
      url?: string;
      model?: string;
    };
  };
}

export interface SystemCheckItem {
  key: string;
  label: string;
  status: "ok" | "warning" | "error";
  detail: string;
  suggestion?: string;
}

export interface SystemCheckResult {
  checked_at: string;
  overall: "ok" | "warning" | "error";
  items: SystemCheckItem[];
}

export async function getSystemCheck(): Promise<SystemCheckResult> {
  const response = await fetch("/settings/check");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function getSettings(): Promise<SettingsView> {
  const response = await fetch("/settings");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

async function putSettings(
  section: "runtime" | "models",
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

export function putModelsSettings(body: {
  url: string;
  api_key: string;
  model?: string;
}): Promise<SettingsView> {
  return putSettings("models", body);
}

export async function readArtifact(
  taskId: string,
  name: string,
): Promise<{ content?: string; kind?: string; branch?: string; unavailable?: string }> {
  const response = await fetch(
    `/tasks/${taskId}/artifacts/${encodeURIComponent(name)}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { unavailable: String(body.error ?? `HTTP ${response.status}`) };
  }
  const body = await response.json();
  return {
    content: String(body.content ?? ""),
    kind: String(body.kind ?? "doc"),
    branch: body.branch ? String(body.branch) : undefined,
  };
}
