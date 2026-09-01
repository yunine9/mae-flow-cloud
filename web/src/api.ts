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
  | "coordinating"
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
  coordinating: "子任务进行中",
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
  delivery?: {
    loop?: { round: number; max?: number; state: string; kind?: string };
  };
}): string {
  const loop = task.delivery?.loop;
  if (loop && ["queued", "running", "pausing", "verifying"]
    .includes(task.status)) {
    if (loop.state === "repairing") {
      // 人工检视刚触发返工时，round=0 表示尚未消耗任何流水线修复
      // 轮次。它是内部状态，不应作为“第 0 轮”暴露给用户；此时用户
      // 真正关心的是 Agent 正在处理检视意见。只有进入真实 CI 修复轮后
      // 才展示轮次。
      if (loop.kind === "review" || loop.round <= 0) {
        return "正在按检视意见修改";
      }
      return "流水线修复中";
    }
    if (loop.state === "verifying") return "修复结果验证中";
    if (loop.state === "halted") return "自动修复已停,需人工";
    if (loop.state === "exhausted") return "修复预算用完,需人工";
  }
  return STATUS_TEXT[task.status] ?? task.status;
}

export type UserRole = "admin" | "developer";

export interface AuthUser {
  username: string;
  display_name?: string;
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
  /** 问题处理探索方式:"fixed" 固定流程(缺省)/"free" 自由探索。
   * 只烙印新会话,进行中会话不迁移。 */
  issue_flow?: "fixed" | "free";
}

export interface CollaborationAssignee {
  username: string;
  display_name?: string;
  ready: boolean;
  missing: string[];
}

export type WishKind = "wish" | "issue";
export type WishStatus = "open" | "accepted" | "done" | "declined";

export interface WishWallImage {
  id: string;
  mime_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  bytes: number;
  url: string;
}

export interface WishWallItem {
  id: string;
  kind: WishKind;
  title: string;
  detail?: string;
  author: string;
  created_at: string;
  status: WishStatus;
  decision_note?: string;
  decided_by?: string;
  decided_at?: string;
  images: WishWallImage[];
  votes: number;
  viewer_voted: boolean;
  can_delete: boolean;
  can_manage: boolean;
}

export interface WishImageUpload {
  mime_type: string;
  content_base64: string;
}

export async function listWishes(): Promise<WishWallItem[]> {
  const response = await fetch("/wishes");
  if (!response.ok) throw new Error(await errorText(response));
  return (await response.json() as { wishes: WishWallItem[] }).wishes;
}

export async function createWish(input: {
  kind: WishKind;
  title: string;
  detail?: string;
  images: WishImageUpload[];
}): Promise<WishWallItem> {
  const response = await fetch("/wishes", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function setWishVote(
  id: string,
  voted: boolean,
): Promise<WishWallItem> {
  const response = await fetch(`/wishes/${encodeURIComponent(id)}/vote`, {
    method: "POST",
    body: JSON.stringify({ voted }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function setWishStatus(
  id: string,
  status: WishStatus,
  note?: string,
): Promise<WishWallItem> {
  const response = await fetch(`/wishes/${encodeURIComponent(id)}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status, note }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function deleteWish(id: string): Promise<void> {
  const response = await fetch(`/wishes/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error(await errorText(response));
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

/** 问题处理探索方式(固定流程/自由探索)。缺省固定流程;只影响
 * 新建的问题会话。 */
export async function putIssueFlowMode(
  mode: "fixed" | "free",
): Promise<AuthUser> {
  const response = await fetch("/auth/me/issue-flow", {
    method: "PUT",
    body: JSON.stringify({ mode }),
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

/** 用已保存的个人 Token 走一遍正式小鲁班投递链路。 */
export async function testLubanConnection(): Promise<{
  ok: true;
  message: string;
}> {
  const response = await fetch("/auth/me/luban-test", { method: "POST" });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function listUsers(): Promise<AuthUser[]> {
  const response = await fetch("/auth/users");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function listCollaborationAssignees(): Promise<CollaborationAssignee[]> {
  const response = await fetch("/auth/collaboration-assignees");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function createUser(
  username: string,
  password: string,
  role: UserRole,
  displayName?: string,
): Promise<AuthUser> {
  const response = await fetch("/auth/users", {
    method: "POST",
    body: JSON.stringify({ username, password, role, display_name: displayName }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function putUserDisplayName(
  username: string,
  displayName: string,
): Promise<AuthUser> {
  const response = await fetch(
    `/auth/users/${encodeURIComponent(username)}/display-name`, {
      method: "PUT",
      body: JSON.stringify({ display_name: displayName }),
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
  repositoryAssignees?: Record<string, string>,
  repositoryTickets?: Record<string, string>,
): Promise<TaskSummary> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/graph/confirm`, {
      method: "POST",
      body: JSON.stringify({ repository_assignees: repositoryAssignees,
        repository_tickets: repositoryTickets }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function putRepositoryAssignees(
  taskId: string,
  repositoryAssignees: Record<string, string>,
  repositoryTickets?: Record<string, string>,
): Promise<TaskSummary> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/repository-assignees`, {
      method: "PUT",
      body: JSON.stringify({ repository_assignees: repositoryAssignees,
        repository_tickets: repositoryTickets }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function putTaskCollaborators(
  taskId: string,
  collaborators: string[],
): Promise<TaskSummary> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/collaborators`, {
      method: "PUT",
      body: JSON.stringify({ collaborators }),
    });
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
  /** 稳定内核步骤 ID；界面仍展示 step 人话标题。 */
  step_id?: string;
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

/** 当前 serve 对 Build-Fix 的真实执行所有权；与可持久化领域阶段分开。 */
export interface PrepushRuntime {
  state: "running" | "recovering" | "interrupted" | "stopped" | "idle";
  message: string;
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

export interface WorkflowPlanItem {
  id: string;
  kind: "activity" | "knowledge" | "skill" | "agent" | "tool" | "instruction";
  title: string;
  description?: string;
  locked: boolean;
  editable: boolean;
  source: "platform" | "workflow" | "task";
  slot?: string;
  asset_ref?: WorkflowAssetRef;
  instructions?: string;
  use?: { mode: "available" | "when_needed" | "on_stage_enter" | "before_item";
    anchor?: string };
}

export interface WorkflowAssetRef {
  registry: "business_knowledge" | "engineering_knowledge" | "team_skill"
    | "repository_skill" | "platform_capability";
  id: string;
  version: string;
  digest: string;
  nature?: "business" | "engineering";
  form?: "document" | "skill" | "rule" | "example";
  business_module_id?: string;
  repository?: string;
  revision?: string;
  relative_path?: string;
}

export type WorkflowEdit =
  | { edit_id: string; stage_id: string; op: "add";
      item: WorkflowPlanItem; position?: { before?: string; after?: string } }
  | { edit_id: string; stage_id: string; op: "remove"; target_id: string }
  | { edit_id: string; stage_id: string; op: "replace"; target_id: string;
      item: WorkflowPlanItem }
  | { edit_id: string; stage_id: string; op: "move"; target_id: string;
      position: { before?: string; after?: string } }
  | { edit_id: string; stage_id: string; op: "configure"; target_id: string;
      use?: WorkflowPlanItem["use"]; instructions?: string };

export interface WorkflowDefinition {
  schema: "mae-flow-workflow-definition/1";
  base: { standard_id: string; standard_version: string;
    catalog_digest: string };
  applicability: {
    business_module_ids: string[];
    repositories: string[];
    technologies: string[];
  };
  edits: WorkflowEdit[];
}

export interface WorkflowDiagnostic {
  code: string;
  severity: "warning" | "error";
  message: string;
  fallback?: string;
  stage_id?: string;
  item_id?: string;
}

export interface WorkflowStagePlan {
  id: string;
  title: string;
  phase: string;
  steps: string[];
  slots: Array<{ id: string; cardinality: "one" | "many" }>;
  items: WorkflowPlanItem[];
}

export interface WorkflowExecutionProfile {
  schema: "mae-flow-execution-profile/2";
  revision: string;
  source: { kind: "platform" | "workflow" | "task";
    id: string; label?: string; version?: string; digest?: string };
  /** 两快照可整体缺席(supplement-only:只写了文字补充、没选工作流
   * 的任务),此时按平台默认方案执行、只叠 supplements。 */
  base_snapshot?: { standard_id: string; standard_version: string;
    catalog_digest: string; stages: WorkflowStagePlan[] };
  final_snapshot?: { standard_id: string; standard_version: string;
    catalog_digest: string; stages: WorkflowStagePlan[] };
  edits: WorkflowEdit[];
  asset_manifest: Array<WorkflowAssetRef & {
    state: "available" | "unavailable" | "incompatible";
    snapshot_path?: string;
    diagnostic?: string;
  }>;
  diagnostics: WorkflowDiagnostic[];
  /** 文字建议层(v1 执行补充退役并入,2026-08-29)。 */
  supplements?: Array<{
    scope: "team" | "business_module" | "repository" | "task";
    source_id: string;
    title: string;
    instructions: string;
  }>;
}

/** 资产库/编辑器语境的标准快照(必有结构);任务档上的
 * base/final 才可能缺席(supplement-only)。 */
export type WorkflowStandardBase =
  NonNullable<WorkflowExecutionProfile["base_snapshot"]>;

export type WorkflowAssetStatus =
  | "draft" | "pending_review" | "published" | "archived";

export interface WorkflowAssetSummary {
  id: string;
  name: string;
  description?: string;
  scope: "personal" | "team";
  owner: string;
  maintainers: string[];
  status: WorkflowAssetStatus;
  latest_version: number;
  draft_revision: number;
  copied_from?: WorkflowExecutionProfile["source"];
  selectable_for_tasks: boolean;
  /** 最新已知适用范围;缺席=旧资产未声明,列表按"未限定"展示。 */
  applicability?: {
    business_module_ids: string[];
    repositories: string[];
    technologies: string[];
  };
  updated_at: string;
  permissions: {
    can_view: boolean;
    can_edit: boolean;
    can_submit: boolean;
    can_publish: boolean;
    can_archive: boolean;
  };
}

export interface WorkflowDraftRecord {
  schema: "mae-flow-workflow-draft/1";
  revision: number;
  definition: WorkflowDefinition;
  digest: string;
  updated_at: string;
  updated_by: string;
}

export interface WorkflowAssetDetail {
  asset: WorkflowAssetSummary;
  draft: WorkflowDraftRecord;
  versions: Array<{ version: number; digest: string;
    published_at: string; published_by: string }>;
}

export interface WorkflowAssetCatalogItem {
  ref: WorkflowAssetRef;
  type: "knowledge" | "skill" | "agent" | "tool" | "capability";
  title: string;
  summary: string;
  when_to_use?: string;
  nature?: "business" | "engineering";
  form?: "document" | "skill" | "rule" | "example";
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
  availability: "available" | "unavailable";
  warning?: string;
}

export interface ExecutionPlan {
  schema: "mae-flow-execution-plan/1";
  plan_id: string;
  plan_revision: string;
  step: {
    id: string;
    title: string;
    phase: string;
    state_revision?: number;
  };
  strategy: {
    id: string;
    version: string;
    title: string;
    summary: string;
    source: "platform_default" | "workflow" | "task";
    selection_reason: string;
  };
  contract: {
    human_decision: boolean;
    evidence: Array<{ type: string; label: string }>;
    outputs: string[];
  };
  activities: Array<{
    id: string;
    title: string;
    description: string;
    required: boolean;
    source?: "platform_default" | "customized";
  }>;
  resources: Array<{
    id: string;
    kind: "guidance" | "standard" | "agent" | "platform" | "knowledge"
      | "skill" | "tool";
    name: string;
    ref?: string;
    usage: "required" | "when_needed" | "on_demand";
    preferred?: boolean;
  }>;
  workflow_items: WorkflowPlanItem[];
  knowledge: {
    loading: "indexed_on_demand";
    explanation: string;
  };
  customization: {
    mode: "bounded" | "structural";
    customizable: string[];
    locked: string[];
    effective_source: "platform_default" | "platform_default+overrides"
      | "compiled_final_plan";
    /** 文字建议层(v2 supplements;plan 契约沿用 layers 旧名)。 */
    layers: Array<{
      scope: "team" | "business_module" | "repository" | "task";
      source_id: string;
      title: string;
      instructions: string;
    }>;
    workflow_source?: { kind: "platform" | "workflow" | "task";
      id: string; version?: string; digest?: string };
    diagnostics?: WorkflowDiagnostic[];
  };
}

export interface ExecutionPlaybookOption {
  id: string;
  version: string;
  title: string;
  summary: string;
  phase: string;
  activities: ExecutionPlan["activities"];
  resources: ExecutionPlan["resources"];
}

export interface PushReviewPresentation {
  kind: "delivery" | "feedback" | "pipeline" | "conflict" | "rework";
  title: string;
  description: string;
  base_sha: string;
  baseline_sha: string;
  head_sha: string;
  has_focused_changes: boolean;
  file_count: number;
  additions: number;
  deletions: number;
  /** 设置时 additions/deletions 是占位 0,界面必须显示原因而不是 +0/−0。 */
  stats_unavailable_reason?: string;
  commits: Array<{ sha: string; subject: string }>;
  all_paths: string[];
  committed_paths: string[];
  agent_note?: string;
  verification?: string;
}

export interface TaskSummary {
  id: string;
  title?: string;
  requirement: string;
  requirement_document?: {
    name: string;
    bytes: number;
    context_mode: "inline" | "file";
    bundle_name?: string;
    assets?: Array<{
      path: string;
      source_path: string;
      mime_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      bytes: number;
      digest: string;
    }>;
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
  /** 执行队列位次(1 起,服务端投影):排队的单要能回答"排到哪了"。 */
  queue_position?: number;
  /** 开发助手正占有主现场(paused 期间):恢复入口是"交还主任务"。 */
  assistant_engaged?: boolean;
  /** 环境预热编译收据(服务端镜像):基线红=环境/上游的锅,与本单
   * 增量无关;不构成任何交付证据。 */
  baseline_build?: {
    status: "running" | "passed" | "failed" | "infrastructure_failure";
    sha: string;
    detail?: string;
    build_command?: string;
    started_at: string;
    finished_at?: string;
  };
  /** 下单事实「UT生成方式」的镜像。"仓内既有写法"= 没指向团队 Skill,
   * skill 不被读取是正确行为——这句话要在界面上说破,别让人翻内核文件。 */
  ut_generation_method?: string;
  /** 现场被回收的时刻。有值 = 代码克隆等大件已删,过程记录/证据/批注仍在。
   * 页面据此如实说明,别让人对着 404 的代码差异发愣。 */
  workspace_reclaimed_at?: string;
  luban_account?: string;
  /** 跨仓主任务共同开发者；主责任人仍是唯一的 luban_account。 */
  collaborators?: string[];
  approval_mode?: "inherit" | "manual" | "moonlight";
  repo_url?: string;
  repositories?: string[];
  repository_profiles?: RepositoryProfile[];
  /** 首次进入 Git 现场后固定的仓库原生 Skill；平台只消费，不管理。 */
  repository_skills?: SelectedRepositorySkill[];
  /** 从团队资产固定的 Skill 形态知识。 */
  team_skills?: HostSkillShelfEntry[];
  /** 创建任务时固定的业务模块与知识版本；正文不进入任务摘要。 */
  business_modules?: SelectedBusinessModule[];
  engineering_knowledge?: Array<EngineeringKnowledgeLaunchOption & {
    digest: string; bytes: number; snapshot_path: string;
  }>;
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
      id: string; name: string; url: string; responsibility?: string;
      /** 交付单元的文件面(单仓拆分):缺席=整仓一个单元。 */
      scope?: { name: string; paths: string[] };
      assignee?: string; ticket?: string; task_id?: string;
      task_status?: TaskStatus; current_phase?: string;
    }>;
    /** `from 依赖 to`：from 等待 to，to 是前置仓库。 */
    dependencies: Array<{ from: string; to: string; reason?: string }>;
  };
  parent_task_id?: string;
  parent_task?: {
    id: string; title?: string; ticket?: string; status: TaskStatus;
  };
  blocked_by?: string[];
  /** 本任务作为交付单元的负责文件面;缺席=整仓无边界。 */
  delivery_scope?: { name: string; paths: string[] };
  /** 单仓下单时显式要求先分析拆分。 */
  requirement_analysis_requested?: boolean;
  cross_repository_updates?: CrossRepositoryUpdate[];
  waiting?: {
    waiting_id: string;
    state_version: number;
    /** 待办生成时刻:等待时长的唯一来源(服务端本来就发)。 */
    created_at?: string;
    step?: string;
    question?: { questions?: WaitingQuestion[] };
    /** 提问前模型的最后一段话:"如上表"这类指代的落点。 */
    context?: string;
    /** 举卡前 Agent 刚展示的上文(完整清单/确认单),随卡呈现防盲签。 */
    preface?: string;
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
  notify?: {
    delivered: boolean;
    settled?: boolean;
    attempts: number;
    last_error?: string;
  };
  delivery?: {
    mr_url?: string;
    mr_state?: string;
    pipeline?: string;
    skipped?: string;
    /** Cloud 原生 Build-Fix；缺席表示服务端尚未开始或不支持该能力。 */
    prepush?: PrepushVerification;
    /** 进程活性只看这里，不能再由旧存储字段 prepush.state=preparing 推断。 */
    prepush_runtime?: PrepushRuntime;
    /** 当前 push 检视的阅读导航；授权仍由 delivery_selection 决定。 */
    push_review?: PushReviewPresentation;
    /** 越界改动待主责任人裁决(单仓拆分负责面门禁)。 */
    scope_violation?: { paths: string[]; noted_at: string };
    /** 卡在哪一环的人话(等审批、等某一项核销结果……)。服务端一直
     * 在写,前端一直没显示——于是"验证中"三个字后面藏着的真实原因
     * 谁也看不到,任务看着像马上要成了,其实早就停了。 */
    waiting_on?: string;
    /** 自愈已停、等人介入的原因。有它就该亮牌子给「重跑续推」。 */
    stalled?: string;
    /** 红灯维度缺少可修复原文；工作台据此开放“批注回灌”入口。 */
    evidence_gap?: {
      sha: string;
      state: "retrying" | "waiting_human" | "partial";
      missing_dimensions: Array<"COMPILE" | "UT" | "CODECHECK">;
      available_dimensions: Array<"COMPILE" | "UT" | "CODECHECK">;
      reasons: string[];
      attempts: number;
      notified_at?: string;
    };
    /** 修复环账本(服务端事实镜像,前端不推断只呈现)。 */
    loop?: {
      round: number;
      max?: number;
      state: "repairing" | "verifying" | "green" | "exhausted" | "halted";
      kind?: "ci" | "review" | "conflict";
      review_source?: "platform" | "workspace";
      /** true=人工意见已修复，push 前必须回到意见作者逐条复检。 */
      workspace_review_recheck_required?: boolean;
      workspace_review_annotation_ids?: string[];
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
  /** push 前人工确认交付范围(任务级显式开关,缺省继承个人设置)。 */
  push_confirmation?: boolean;
  progress?: TaskProgress;
  /** 当前阶段采用什么做法的只读说明；状态与完成条件仍以内核为准。 */
  execution_plan?: ExecutionPlan;
  /** 活方案对拍告警:定制链任何一环退化(定格文件损坏、阶段失配、
   * 活方案没吃到定格)都在这里,有值必须标红——不许界面展示定格副本
   * 而 Agent 实际跑平台默认。 */
  execution_plan_alerts?: string[];
  workflow_profile?: WorkflowExecutionProfile;
  workflow_profile_warning?: string;
  host_skills_pinned?: boolean;
  host_skill_snapshot_warnings?: string[];
  control?: {
    last_action: "pause" | "resume" | "cancel";
    actor: string;
    at: string;
    paused_from?: TaskStatus;
  };
}

export interface CrossRepositoryUpdate {
  id: string;
  parent_task_id: string;
  source_task_id: string;
  source_repository?: string;
  author: string;
  text: string;
  target_task_ids: string[];
  created_at: string;
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

export interface KnowledgeCandidateRecord {
  id: string;
  source_task_id: string;
  title: string;
  summary: string;
  when_to_use: string;
  nature: Exclude<KnowledgeNature, "unclassified">;
  form: KnowledgeForm;
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
  content: string;
  digest: string;
  bytes: number;
  status: "pending" | "published" | "rejected";
  submitted_at: string;
  submitted_by: string;
  decided_at?: string;
  decided_by?: string;
  decision_note?: string;
  published_target?: string;
}

export async function createKnowledgeCandidate(taskId: string, input: {
  title: string;
  summary: string;
  when_to_use: string;
  nature: Exclude<KnowledgeNature, "unclassified">;
  form: KnowledgeForm;
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
  content: string;
}): Promise<KnowledgeCandidateRecord> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/knowledge-candidates`, {
    method: "POST", body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function listKnowledgeCandidates(): Promise<KnowledgeCandidateRecord[]> {
  const response = await fetch("/knowledge-candidates");
  if (!response.ok) throw new Error(await errorText(response));
  return (await response.json()).candidates;
}

export async function publishKnowledgeCandidate(
  id: string,
  input: { asset_id?: string; directory?: string; note?: string } = {},
): Promise<KnowledgeCandidateRecord> {
  const response = await fetch(`/knowledge-candidates/${encodeURIComponent(id)}/publish`, {
    method: "POST", body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function rejectKnowledgeCandidate(
  id: string,
  reason: string,
): Promise<KnowledgeCandidateRecord> {
  const response = await fetch(`/knowledge-candidates/${encodeURIComponent(id)}/reject`, {
    method: "POST", body: JSON.stringify({ reason }),
  });
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
  /** description 只说适用场景；steps/acks 是内核目录的兼容字段，
   * 下单页不用它们解释交付方式。 */
  workflows: Array<
    { key: string; label: string; description?: string;
      steps?: number; acks?: number }>;
  execution_playbooks: ExecutionPlaybookOption[];
  workflow_standard?: WorkflowStandardBase;
  /** 已发布的可选业务模块摘要；知识正文不会随目录接口返回。 */
  business_modules: BusinessModuleLaunchOption[];
  engineering_knowledge: EngineeringKnowledgeLaunchOption[];
  team_skills: HostSkillShelfEntry[];
}

export interface LaunchKnowledgeMatchedScope {
  matched_business_module_ids: string[];
  matched_repositories: string[];
  matched_technologies: string[];
}

export interface LaunchBusinessKnowledgePreview
  extends LaunchKnowledgeMatchedScope {
  module_id: string;
  module_name: string;
  module_revision: number;
  id: string;
  title: string;
  summary: string;
  when_to_use: string;
  form: KnowledgeForm;
  repositories: string[];
  version: number;
  digest: string;
  bytes: number;
}

export interface LaunchEngineeringKnowledgePreview
  extends EngineeringKnowledgeLaunchOption, LaunchKnowledgeMatchedScope {
  digest: string;
  bytes: number;
}

export interface LaunchTeamSkillPreview
  extends HostSkillShelfEntry, LaunchKnowledgeMatchedScope {
  package_digest: string;
}

export interface LaunchKnowledgePreviewNotice {
  source: "business_modules" | "engineering_knowledge" | "team_skills"
    | "repository_profiles";
  code: "catalog_unavailable" | "catalog_warning" | "limit_applied"
    | "selection_invalid";
  message: string;
}

export interface LaunchKnowledgePreview {
  complete: boolean;
  degraded: boolean;
  scope: {
    repositories: string[];
    technologies: string[];
    business_module_ids: string[];
    workflow_business_module_ids: string[];
    workflow_engineering_knowledge_ids: string[];
    workflow_team_skill_ids: string[];
  };
  business_knowledge: LaunchBusinessKnowledgePreview[];
  engineering_knowledge: LaunchEngineeringKnowledgePreview[];
  team_skills: LaunchTeamSkillPreview[];
  selection_digest: string;
  limits: { engineering_knowledge: {
    max_assets: number;
    max_total_bytes: number;
    matched: number;
    selected: number;
    omitted: number;
  } };
  warnings: LaunchKnowledgePreviewNotice[];
  errors: LaunchKnowledgePreviewNotice[];
}

export async function getLaunchKnowledgePreview(input: {
  repos: string[];
  selectedBusinessModuleIds: string[];
  repositoryProfiles?: Array<Pick<RepositoryProfile,
    "repository" | "technologies" | "confirmed">>;
  workflowSelection?: { id: string; version?: number | string };
}, signal?: AbortSignal): Promise<LaunchKnowledgePreview> {
  const response = await fetch("/launch-knowledge-preview", {
    method: "POST",
    signal,
    body: JSON.stringify({
      repos: input.repos,
      selected_business_module_ids: input.selectedBusinessModuleIds,
      repository_profiles: input.repositoryProfiles,
      workflow_selection: input.workflowSelection,
    }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export interface EngineeringKnowledgeLaunchOption {
  id: string;
  title: string;
  summary: string;
  when_to_use: string;
  form: Exclude<KnowledgeForm, "skill">;
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
}

export interface RepositoryProfile {
  repository: string;
  technologies: string[];
  confirmed: boolean;
  updated_at: string;
  updated_by: string;
}

export async function resolveRepositoryProfiles(
  repositories: string[],
): Promise<Array<{ repository: string; profile?: RepositoryProfile }>> {
  const response = await fetch("/repository-profiles/resolve", {
    method: "POST",
    body: JSON.stringify({ repositories }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return (await response.json()).repositories;
}

export interface RepositoryProbeResult {
  repository: string;
  reachable: boolean;
  message: string;
}

export async function probeRepositories(
  repositories: string[],
  signal?: AbortSignal,
): Promise<RepositoryProbeResult[]> {
  const response = await fetch("/repositories/probe", {
    method: "POST",
    signal,
    body: JSON.stringify({ repositories }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return (await response.json()).repositories;
}

export async function saveRepositoryProfile(input: {
  repository: string;
  technologies: string[];
  confirmed?: boolean;
}): Promise<RepositoryProfile> {
  const response = await fetch("/repository-profiles", {
    method: "PUT",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export interface BusinessModuleLaunchOption {
  id: string;
  name: string;
  description: string;
  owner: string;
  repositories: string[];
  revision: number;
  assets: number;
  /** 可核对的已发布知识目录，不含正文；可选以兼容滚动升级中的旧服务。 */
  knowledge?: Array<{
    id: string;
    title: string;
    summary: string;
    when_to_use: string;
    form: KnowledgeForm;
    repositories: string[];
    version: number;
  }>;
  updated_at: string;
}

export type KnowledgeNature = "business" | "engineering" | "unclassified";
export type KnowledgeForm = "document" | "skill" | "rule" | "example";

export interface BusinessKnowledgeAsset {
  id: string;
  title: string;
  summary: string;
  when_to_use: string;
  form: KnowledgeForm;
  repositories: string[];
  status: "published" | "archived";
  version: number;
  digest: string;
  bytes: number;
  updated_at: string;
  updated_by: string;
}

export interface BusinessModule {
  id: string;
  name: string;
  description: string;
  owner: string;
  maintainers: string[];
  repositories: string[];
  status: "active" | "archived";
  revision: number;
  assets: BusinessKnowledgeAsset[];
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
  can_manage: boolean;
}

export interface SelectedBusinessModule {
  id: string;
  name: string;
  description: string;
  owner: string;
  revision: number;
  assets: Array<{
    id: string;
    title: string;
    summary: string;
    when_to_use: string;
    form: KnowledgeForm;
    repositories: string[];
    version: number;
    digest: string;
    bytes: number;
    snapshot_path: string;
  }>;
}

export interface BusinessModuleOperation {
  at: string;
  operator: string;
  action: "create" | "update" | "archive" | "publish_asset" | "archive_asset";
  module_id: string;
  asset_id?: string;
  version?: number;
  detail?: string;
}

export interface BusinessModuleCatalog {
  modules: BusinessModule[];
  warnings: string[];
  operations: BusinessModuleOperation[];
}

export async function getBusinessModules(): Promise<BusinessModuleCatalog> {
  const response = await fetch("/business-modules");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function createBusinessModule(input: {
  id: string;
  name: string;
  description: string;
  owner: string;
  maintainers: string[];
  repositories: string[];
}): Promise<BusinessModule> {
  const response = await fetch("/business-modules", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function updateBusinessModule(
  id: string,
  patch: Partial<Pick<BusinessModule,
    "name" | "description" | "owner" | "maintainers" | "repositories" | "status">>,
): Promise<BusinessModule> {
  const response = await fetch(`/business-modules/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function getBusinessKnowledgeAsset(
  moduleId: string,
  assetId: string,
  version?: number,
): Promise<{
  module_id: string;
  module_name: string;
  asset: BusinessKnowledgeAsset;
  content: string;
}> {
  const query = version === undefined ? ""
    : `?version=${encodeURIComponent(String(version))}`;
  const response = await fetch(`/business-modules/${encodeURIComponent(moduleId)}`
    + `/assets/${encodeURIComponent(assetId)}${query}`);
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function publishBusinessKnowledgeAsset(
  moduleId: string,
  assetId: string,
  input: Pick<BusinessKnowledgeAsset, "title" | "summary" | "when_to_use">
    & { form: KnowledgeForm; repositories: string[]; content: string },
): Promise<BusinessModule> {
  const response = await fetch(`/business-modules/${encodeURIComponent(moduleId)}`
    + `/assets/${encodeURIComponent(assetId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function archiveBusinessKnowledgeAsset(
  moduleId: string,
  assetId: string,
): Promise<BusinessModule> {
  const response = await fetch(`/business-modules/${encodeURIComponent(moduleId)}`
    + `/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export class WorkflowApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = "WorkflowApiError";
  }
}

async function workflowResponse<T>(response: Response): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;
  const body = await response.json().catch(() => ({})) as {
    error?: unknown; code?: unknown; current_revision?: unknown };
  throw new WorkflowApiError(
    String(body.error ?? `HTTP ${response.status}`),
    body.code === undefined ? undefined : String(body.code),
    body.current_revision === undefined
      ? undefined : Number(body.current_revision),
  );
}

export async function listWorkflowAssets(): Promise<{
  items: WorkflowAssetSummary[];
  warnings: string[];
}> {
  return workflowResponse(await fetch("/workflow-assets"));
}

export async function getWorkflowAssetCatalog(): Promise<{
  items: WorkflowAssetCatalogItem[];
  warnings: string[];
}> {
  return workflowResponse(await fetch("/workflow-assets/catalog"));
}

export async function getWorkflowStandard(): Promise<
WorkflowStandardBase> {
  return workflowResponse(await fetch("/workflow-assets/standard"));
}

export async function getWorkflowAsset(id: string): Promise<WorkflowAssetDetail> {
  return workflowResponse(await fetch(
    `/workflow-assets/${encodeURIComponent(id)}`));
}

export async function createWorkflowAsset(input: {
  id?: string;
  name: string;
  description?: string;
  scope: "personal" | "team";
  maintainers?: string[];
  definition: WorkflowDefinition;
}): Promise<WorkflowAssetSummary> {
  return workflowResponse(await fetch("/workflow-assets", {
    method: "POST", body: JSON.stringify(input),
  }));
}

export async function saveWorkflowDraft(
  id: string,
  definition: WorkflowDefinition,
  expectedRevision: number,
): Promise<WorkflowAssetDetail> {
  return workflowResponse(await fetch(
    `/workflow-assets/${encodeURIComponent(id)}/draft`, {
      method: "PUT",
      body: JSON.stringify({
        definition, expected_revision: expectedRevision,
      }),
    }));
}

export async function copyWorkflowAsset(
  id: string,
  input: {
    source_version?: number | string;
    name: string;
    description?: string;
    scope: "personal" | "team";
    maintainers?: string[];
  },
): Promise<WorkflowAssetSummary> {
  return workflowResponse(await fetch(
    `/workflow-assets/${encodeURIComponent(id)}/copy`, {
      method: "POST", body: JSON.stringify(input),
    }));
}

export async function workflowAssetAction(
  id: string,
  action: "submit" | "withdraw" | "approve" | "reject" | "archive",
  input: { reason?: string } = {},
): Promise<WorkflowAssetSummary> {
  return workflowResponse(await fetch(
    `/workflow-assets/${encodeURIComponent(id)}/${action}`, {
      method: "POST", body: JSON.stringify(input),
    }));
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
  scope?: "task" | "repository" | "team" | "module";
  module_id?: string;
  module_name?: string;
  asset_version?: number;
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
    scope?: "task" | "repository" | "team" | "module";
    module_id?: string;
    module_name?: string;
    asset_version?: number;
    ts: string;
    session_id: string;
    session_role: "main" | "subagent" | "prepush" | "developer-assistant" | "warmup";
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
  scope?: "task" | "repository" | "team" | "module";
  module_id?: string;
  module_name?: string;
  asset_version?: number;
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
  nature: KnowledgeNature;
  form: "skill";
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
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

export interface SkillKnowledgeMetadataInput {
  nature: Exclude<KnowledgeNature, "unclassified">;
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
}

/** 资产库操作留痕(谁/何时/什么动作/什么指纹),服务端逐条记录。 */
export interface SkillOperationRecord {
  at: string;
  operator: string;
  action: "upload" | "update" | "offline" | "rollback"
    | "submit" | "approve" | "reject";
  directory: string;
  skill_digest?: string;
  package_digest?: string;
  files?: number;
  bytes?: number;
  detail?: string;
}

/** 开发者提交的待审 skill 包:人人可提交,管理员审核上架。 */
export interface SkillSubmissionRecord {
  id: string;
  directory: string;
  operator: string;
  created_at: string;
  status: "pending" | "approved" | "rejected";
  skill_digest: string;
  package_digest: string;
  files: number;
  bytes: number;
  nature?: KnowledgeNature;
  business_module_ids?: string[];
  repositories?: string[];
  technologies?: string[];
  decided_at?: string;
  decided_by?: string;
  reject_reason?: string;
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

export interface HostSkillDocument {
  directory: string;
  path: string;
  content: string;
  digest: string;
  package_digest: string;
  bytes: number;
}

/** 货架 + 留痕一次取齐(管理面自刷新用,与 knowledge-insights 解耦)。 */
export async function getSkillLibrary(): Promise<
  HostSkillShelf & { operations: SkillOperationRecord[] }
> {
  const response = await fetch("/skills");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function getSkillDocument(
  directory: string,
): Promise<HostSkillDocument> {
  const response = await fetch(`/skills/${encodeURIComponent(directory)}`);
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function uploadSkill(
  directory: string,
  files: SkillUploadFile[],
  metadata?: SkillKnowledgeMetadataInput,
): Promise<SkillOperationRecord> {
  const response = await fetch(`/skills/${encodeURIComponent(directory)}`, {
    method: "PUT",
    body: JSON.stringify({ files, ...metadata }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

/** 开发者提交待审:与上架同一道验收闸,通过后进待审区等管理员裁决。 */
export async function submitSkill(
  directory: string,
  files: SkillUploadFile[],
  metadata?: SkillKnowledgeMetadataInput,
): Promise<SkillSubmissionRecord> {
  const response = await fetch(
    `/skills/${encodeURIComponent(directory)}/submissions`, {
      method: "POST",
      body: JSON.stringify({ files, ...metadata }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function updateSkillLanguages(
  directory: string,
  languages: string[],
): Promise<SkillOperationRecord> {
  const response = await fetch(
    `/skills/${encodeURIComponent(directory)}/languages`, {
      method: "PATCH",
      body: JSON.stringify({ languages }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function updateSkillKnowledgeMetadata(
  directory: string,
  metadata: SkillKnowledgeMetadataInput,
): Promise<SkillOperationRecord> {
  const response = await fetch(
    `/skills/${encodeURIComponent(directory)}/classification`, {
      method: "PATCH",
      body: JSON.stringify(metadata),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function listSkillSubmissions(): Promise<SkillSubmissionRecord[]> {
  const response = await fetch("/skills/submissions");
  if (!response.ok) throw new Error(await errorText(response));
  return (await response.json()).submissions ?? [];
}

export async function approveSkillSubmission(
  directory: string,
  id: string,
): Promise<SkillOperationRecord> {
  const response = await fetch(
    `/skills/${encodeURIComponent(directory)}/submissions/`
    + `${encodeURIComponent(id)}/approve`, { method: "POST" });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function rejectSkillSubmission(
  directory: string,
  id: string,
  reason?: string,
): Promise<SkillSubmissionRecord> {
  const response = await fetch(
    `/skills/${encodeURIComponent(directory)}/submissions/`
    + `${encodeURIComponent(id)}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason: reason ?? "" }),
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
    /** 以仓库地址为键的逐仓 AR 单号；多仓发起时和仓库同一行填写。 */
    repositoryTickets?: Record<string, string>;
    /** 以仓库地址为键的逐仓责任人；单仓默认当前下单人。 */
    repositoryAssignees?: Record<string, string>;
    lane?: string;
    ticket?: string;
    baseline?: string;
    model?: { provider: string; model: string };
    repairRounds?: number;
    taskInstructions?: string;
    workflowDefinition?: unknown;
    workflowSelection?: { id: string; version?: number | string };
    repositorySkillCatalogToken?: string;
    selectedRepositorySkillIds?: string[];
    selectedBusinessModuleIds?: string[];
    knowledgePreviewDigest?: string;
    repositoryProfiles?: Array<Pick<RepositoryProfile,
      "repository" | "technologies" | "confirmed">>;
    requirementDocumentName?: string;
    requirementBundle?: { name: string; contentBase64: string };
    /** 单仓大需求:先走分析拆分(交付单元拆分),多仓天然分析。 */
    requirementAnalysis?: boolean;
  },
  // 返回创建结果:调用方靠它把新任务当场打开/高亮。原来丢弃 201 响应
  // 体,下单成功零反馈,人会怀疑没提交成功再点一次(2026-08-30 审计)。
): Promise<TaskSummary> {
  const response = await fetch("/tasks", {
    method: "POST",
    body: JSON.stringify({
      requirement,
      requirement_document_name: extras?.requirementDocumentName,
      requirement_bundle: extras?.requirementBundle
        ? {
            name: extras.requirementBundle.name,
            content_base64: extras.requirementBundle.contentBase64,
          }
        : undefined,
      title: extras?.title?.trim() || undefined,
      account: account || undefined,
      repo: extras?.repo || undefined,
      repos: extras?.repos?.length ? extras.repos : undefined,
      repository_tickets: extras?.repositoryTickets,
      repository_assignees: extras?.repositoryAssignees,
      // 空白等于没选，由服务端使用内核第一项；不要把 "" 伪装成
      // 一个需要校验的交付方式。
      lane: extras?.lane?.trim() || undefined,
      ticket: extras?.ticket || undefined,
      baseline: extras?.baseline || undefined,
      model: extras?.model,
      repair_rounds: extras?.repairRounds,
      task_instructions: extras?.taskInstructions?.trim() || undefined,
      workflow_definition: extras?.workflowDefinition,
      workflow_selection: extras?.workflowSelection,
      repository_skill_catalog_token:
        extras?.repositorySkillCatalogToken || undefined,
      selected_repository_skill_ids:
        extras?.selectedRepositorySkillIds,
      selected_business_module_ids: extras?.selectedBusinessModuleIds,
      knowledge_preview_digest: extras?.knowledgePreviewDigest,
      repository_profiles: extras?.repositoryProfiles,
      requirement_analysis: extras?.requirementAnalysis || undefined,
    }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return await response.json() as TaskSummary;
}

export interface RequirementBundlePreview {
  bundle_name: string;
  document_name: string;
  requirement: string;
  assets: Array<{
    path: string;
    source_path: string;
    mime_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    bytes: number;
    content_base64: string;
  }>;
}

export async function previewRequirementBundle(
  name: string,
  contentBase64: string,
): Promise<RequirementBundlePreview> {
  const response = await fetch("/requirement-bundles/preview", {
    method: "POST",
    body: JSON.stringify({ name, content_base64: contentBase64 }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
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
  },
  /** Chain 图上的逐仓责任人；只在“确认并生成任务”时发送。 */
  repositoryAssignees?: Record<string, string>,
  /** Chain 图上的逐仓 AR 单号；与责任人同一次确认提交。 */
  repositoryTickets?: Record<string, string>,
  /** 代码检视勾选的最终交付文件；空数组表示明确不选任何文件。 */
  deliveryPaths?: string[],
  /** 当前卡的稳定身份；用于把成功请求的网络重放识别为幂等成功。 */
  waitingId?: string,
): Promise<{ conflict?: string }> {
  const response = await fetch(`/tasks/${taskId}/decision`, {
    method: "POST",
    body: JSON.stringify({
      waiting_id: waitingId,
      state_version: stateVersion,
      selected_options: selectedOptions,
      free_responses: freeResponses,
      comment: comment?.trim() || undefined,
      annotation_ids: annotationIds?.length ? annotationIds : undefined,
      repository_skill_catalog_token: repositorySkills?.catalogToken,
      selected_repository_skill_ids: repositorySkills?.selectedIds,
      repository_assignees: repositoryAssignees,
      repository_tickets: repositoryTickets,
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

/** 越界改动裁决:allow=豁免这些路径继续交付,revert=下修复令撤出改动。
 * 服务端只认主任务责任人;403 的解释原样带回给界面展示。 */
export async function decideScopeViolation(
  taskId: string,
  decision: "allow" | "revert",
): Promise<{ error?: string }> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/scope-decision`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
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

/** 责任人可删除自己的真终态历史；管理员可删除任意真终态历史。 */
export async function deleteHistoryTask(
  taskId: string,
): Promise<{ error?: string }> {
  const response = await fetch(`/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
  });
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

export async function publishCrossRepositoryUpdate(
  taskId: string,
  text: string,
): Promise<CrossRepositoryUpdate> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/cross-repository-update`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
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
  state: "idle" | "acquiring" | "working" | "ready" | "returning"
    | "running" | "completed" | "failed" | "interrupted";
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

export async function stopDeveloperAssistant(
  taskId: string,
): Promise<DeveloperAssistantView> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/developer-assistant/interrupt`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function returnDeveloperAssistant(
  taskId: string,
): Promise<TaskSummary> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/developer-assistant/return`,
    { method: "POST" },
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

/** 需求原文来自任务快照；这个保留标识与服务端 annotations.ts 同合同。 */
export const TASK_REQUIREMENT_ARTIFACT = "__task_requirement__";

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
  sent_via?: "interrupt" | "decision" | "pipeline_evidence" | "review_repair"
    | "queued_decision";
  response?: {
    revision: number;
    outcome: "fixed" | "not_fixed" | "needs_clarification";
    summary: string;
    evidence: string[];
    fixed_sha?: string;
    responded_at: string;
  };
  verified_at?: string;
  /** 非作者代确认时的实际操作者；缺席表示由意见作者本人确认。 */
  verified_by?: string;
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

/** Build-Fix 的实时事件流:换轮(修复后新 HEAD 再验)由服务端切文件
 * 并从头重放新一轮,前端只管渲染。 */
/** Build-Fix 失败停机后,人拍板跳过本地验证、直推流水线裁决。 */
export async function skipBuildFix(taskId: string): Promise<void> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/build-fix/skip`, { method: "POST" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String(body.error ?? `HTTP ${response.status}`));
  }
}

/** 人工重跑 Build-Fix:僵尸现场(重启杀掉在途轮)的出路;真在跑时
 * 服务端拒绝并明说"正在进行",等于一次活性探测。 */
export async function retryBuildFix(taskId: string): Promise<void> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/build-fix/retry`, { method: "POST" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String(body.error ?? `HTTP ${response.status}`));
  }
}

/** 停止在途的 Build-Fix 并直推流水线(用户拍板的合并语义):中止本轮、
 * 如实收口停机账,随即绑当下 HEAD 跳过,编译与单元测试交由权威流水线裁决。
 * 停止瞬间恰好通过的按通过继续;暂停中的任务只停不推。 */
export async function stopBuildFix(taskId: string): Promise<void> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/build-fix/stop`, { method: "POST" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String(body.error ?? `HTTP ${response.status}`));
  }
}

/** 环境预热编译的实时事件流,与 Build-Fix 同一套 SSE 语义。 */
export function tailWarmupEvents(
  taskId: string,
  onEvent: (event: SemanticEvent) => void,
  onState?: (state: SseConnectionState) => void,
): () => void {
  onState?.("connecting");
  const source = new EventSource(`/tasks/${taskId}/warmup/events`);
  source.onopen = () => onState?.("live");
  source.onmessage = (message) => onEvent(JSON.parse(message.data));
  source.onerror = () => onState?.("reconnecting");
  return () => source.close();
}

export function tailBuildFixEvents(
  taskId: string,
  onEvent: (event: SemanticEvent) => void,
  onState?: (state: SseConnectionState) => void,
): () => void {
  onState?.("connecting");
  const source = new EventSource(`/tasks/${taskId}/build-fix/events`);
  source.onopen = () => onState?.("live");
  source.onmessage = (message) => onEvent(JSON.parse(message.data));
  source.onerror = () => onState?.("reconnecting");
  return () => source.close();
}

/** @deprecated 兼容尚未升级的内部调用；新代码使用 Build-Fix 命名。 */
export const skipPrepushVerification = skipBuildFix;
/** @deprecated 兼容尚未升级的内部调用；新代码使用 Build-Fix 命名。 */
export const retryPrepushVerification = retryBuildFix;
/** @deprecated 兼容尚未升级的内部调用；新代码使用 Build-Fix 命名。 */
export const stopPrepushVerification = stopBuildFix;
/** @deprecated 兼容尚未升级的内部调用；新代码使用 Build-Fix 命名。 */
export const tailPrepushEvents = tailBuildFixEvents;

/** 问题会话的实时事件流:服务端从头重放 events.jsonl 后持续跟进
 * (300ms 增量),与任务侧 /tasks/:id/events 同一套 SSE 语义。 */
export function tailIssueEvents(
  issueId: string,
  onEvent: (event: SemanticEvent) => void,
  onState?: (state: SseConnectionState) => void,
): () => void {
  onState?.("connecting");
  const source = new EventSource(`/issues/${encodeURIComponent(issueId)}/events`);
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
  /** Cloud 生成材料的稳定用途；页面不应靠文件名猜业务语义。 */
  purpose?: "pipeline_evidence_gap";
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
    build_cache_retention_days?: number;
    build_cache_max_gb?: number;
  };
  execution_policy: {
    /** 只影响保存后新建任务；每单会固定快照(编译为 team 层补充)。 */
    team_instructions?: string;
  };
  execution_playbooks: ExecutionPlaybookOption[];
  models: {
    configured: boolean;
    provider?: string;
    model?: string;
    url?: string;
    /** 接口格式(openai-completions | anthropic-messages);未配置过时
     * 由表单默认值接手。 */
    api?: string;
    key_hint?: string;
    providers: Array<{ name: string; models: string[]; key_hint?: string }>;
    vision: {
      configured: boolean;
      provider?: string;
      model?: string;
      url?: string;
      api?: string;
      key_hint?: string;
    };
  };
  /** 未设置覆盖时实际采用的服务默认值，不让管理员猜启动参数。 */
  defaults: {
    runtime: {
      max_concurrent: number;
      repair_rounds: number | null;
      poll_interval_s: number;
      poll_timeout_s: number;
      workspace_retention_days: number;
      build_cache_retention_days: number;
      build_cache_max_gb: number;
    };
    models: {
      configured: boolean;
      url?: string;
      model?: string;
      /** 部署默认协议;健康检查与真实调用必须同协议(MFC-011)。 */
      api?: "openai-completions" | "anthropic-messages";
      vision: {
        configured: boolean;
        provider?: string;
        model?: string;
        url?: string;
        api?: string;
      };
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

export interface BuildCacheEntry {
  key: string;
  repository_hint?: string;
  last_used_at: string;
  size_bytes: number;
  active: boolean;
  tracked: boolean;
}

export interface BuildCacheStatus {
  configured: boolean;
  root?: string;
  caches: number;
  active: number;
  total_bytes: number;
  entries: BuildCacheEntry[];
  policy: { retention_days: number; max_bytes: number };
}

export interface BuildCacheReclaimResult {
  reclaimed: number;
  freed_bytes: number;
  skipped_active: number;
  failed: Array<{ key: string; error: string }>;
  status: BuildCacheStatus;
}

export async function getBuildCacheStatus(): Promise<BuildCacheStatus> {
  const response = await fetch("/settings/build-cache");
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export async function reclaimUnusedBuildCaches(): Promise<BuildCacheReclaimResult> {
  const response = await fetch("/settings/build-cache/reclaim", {
    method: "POST",
    body: JSON.stringify({ all_unused: true }),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

async function putSettings(
  section: "runtime" | "models" | "vision" | "execution-policy",
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

export function putExecutionPolicySettings(body: {
  team_instructions: string;
}): Promise<SettingsView> {
  return putSettings("execution-policy", body);
}

export function putModelsSettings(body: {
  url: string;
  api_key: string;
  model?: string;
  api?: string;
}): Promise<SettingsView> {
  return putSettings("models", body);
}

/** 模型网关连通性测试:发送一条真实问答请求,返回网络连通/模型问答
 * 两项结论。字段留空 = 服务端沿用已存配置(密钥不回传明文)。 */
export async function postModelsCheck(body: {
  url?: string;
  api_key?: string;
  model?: string;
  api?: string;
}): Promise<SystemCheckResult> {
  const response = await fetch("/settings/models/check", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
}

export function putVisionSettings(body: {
  url: string;
  api_key: string;
  model: string;
  api: string;
}): Promise<SettingsView> {
  return putSettings("vision", body);
}

export interface VisionProbeResult {
  status: "ready" | "failed";
  provider: string;
  model: string;
  latency_ms: number;
  response?: string;
  error?: string;
}

export async function testVisionCapability(): Promise<VisionProbeResult> {
  const response = await fetch("/settings/vision/test", { method: "POST" });
  if (!response.ok) throw new Error(await errorText(response));
  return response.json();
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

/** push 检视只允许二选一：看这次处理，或看从任务基线起的完整交付。
 * Git revision 都由服务端从当前卡片取，页面不传 ref。 */
export async function readPushReviewDiff(
  taskId: string,
  scope: "changes" | "full",
): Promise<{
  content?: string;
  branch?: string;
  unavailable?: string;
  /** HTTP 状态只在不可用时返回，供工作台区分“版本已失效”和暂时故障。 */
  status?: number;
}> {
  const response = await fetch(
    `/tasks/${encodeURIComponent(taskId)}/push-review-diff?scope=${scope}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return {
      unavailable: String(body.error ?? `HTTP ${response.status}`),
      status: response.status,
    };
  }
  const body = await response.json();
  return {
    content: String(body.content ?? ""),
    branch: body.branch ? String(body.branch) : undefined,
  };
}

// ---- 问题流(与需求任务平行的独立会话域) ----

/** 后端认证类报错的机器标记(src/issueFlow/issueGit.ts 的
 * GIT_AUTH_ERROR_TAG 手工镜像,#10 契约护栏未做,双端要同步):
 * 会话页的错误横幅命中它才给「去个人设置配置令牌」跳转——人话改字
 * 不再破坏跳转(旧锚是文案里嵌「Git 令牌」字样)。 */
export const GIT_AUTH_ERROR_TAG = "[git-auth]";

export type IssueStatus =
  | "queued"
  | "running"
  | "waiting_user"
  | "idle"
  | "suspended"
  | "archived"
  | "canceled"
  | "failed";

export const ISSUE_STATUS_TEXT: Record<IssueStatus, string> = {
  queued: "排队启动中",
  running: "AI 处理中",
  waiting_user: "等你答复",
  idle: "等你继续",
  suspended: "挂起(待关联单号)",
  archived: "已归档",
  canceled: "已取消",
  failed: "出错了",
};

export type IssueStage =
  | "registered"
  | "fetch_detail"
  | "align_issue"
  | "locate_root"
  | "align_solution"
  | "modify_code"
  | "switch_db"
  | "verify"
  | "submit_mr"
  | "done";

export const ISSUE_STAGE_TEXT: Record<IssueStage, string> = {
  registered: "已登记",
  fetch_detail: "获取 DTS 详情",
  align_issue: "对齐问题",
  locate_root: "分析根因",
  align_solution: "对齐方案",
  modify_code: "实施修改",
  switch_db: "换库",
  verify: "验证",
  submit_mr: "提交 MR",
  done: "问题闭环",
};

// ---- 固定流程(2026-08-27 拍板;自由探索那套词表原样保留) ----

export type IssueFlowMode = "fixed" | "free";
export type IssueScenario = "ticket" | "no_ticket";
export type FixedIssueStage =
  | "dts_info"
  | "prep_repo"
  | "analyze"
  | "fix"
  | "ut"
  | "mr_green"
  | "deploy_verify"
  | "conclude";

export type AnyIssueStage = IssueStage | FixedIssueStage;

export const FIXED_TICKET_STAGES: FixedIssueStage[] = [
  "dts_info", "prep_repo", "analyze", "fix", "ut", "mr_green", "deploy_verify",
];
export const FIXED_NO_TICKET_STAGES: FixedIssueStage[] = [
  "prep_repo", "analyze", "conclude",
];

const FIXED_STAGE_TEXT: Record<FixedIssueStage, string> = {
  dts_info: "获取 DTS 单信息",
  prep_repo: "拉取代码仓",
  analyze: "问题分析",
  fix: "问题修改",
  ut: "单元测试验证",
  mr_green: "提交 MR·跑绿",
  deploy_verify: "换库环境验证",
  conclude: "确定结论",
};

/** 按会话模式取阶段中文名(fixed 词表/自由词表各认各的;对不上
 * (旧现场/异键)原样示人——前端不猜)。 */
export function issueStageText(issue: {
  mode?: IssueFlowMode;
  scenario?: IssueScenario;
  stage: AnyIssueStage;
}): string {
  return FIXED_STAGE_TEXT[issue.stage as FixedIssueStage]
    ?? ISSUE_STAGE_TEXT[issue.stage as IssueStage]
    ?? String(issue.stage);
}

/** 固定流程场景的阶段序列(进度条用)。 */
export function fixedStageList(
  scenario: IssueScenario | undefined,
): FixedIssueStage[] {
  return scenario === "no_ticket"
    ? FIXED_NO_TICKET_STAGES : FIXED_TICKET_STAGES;
}

/** 单阶段执行状态:inherited=转正继承,redo=验证回退待重做。 */
export type IssueStageState =
  | "pending"
  | "in_progress"
  | "done"
  | "inherited"
  | "redo";

/** 平台问题卡(固定流程的人工硬闸):形状与 Agent 问题卡同构,
 * IssueDecisionCard 直接复用渲染。 */
export type IssueGateKind =
  | "analysis_confirm"
  | "conclude"
  | "env_verify"
  // 2026-08-28:代码仓缺口不再走平台闸(pull_repo 工具化);
  // 网管环境缺配置(拉日志/换库现场补配)仍由工具现场举。
  | "env_needed"
  // 推送前过目闸(ADR-0009):push_branch 的交付轴硬闸,不绑阶段;
  // 卡带服务端生成的变更摘要(context 字段),确认产一次性令牌。
  | "push_confirm";

/** 闸卡选项 = 决策码 + 文案对(服务端 src/issueFlow/stageRegistry.ts
 * 的 GateOption 镜像):渲染 label,提交 code——文案改字零协议后果。 */
export interface IssueGateOption {
  code: string;
  label: string;
}

export interface IssueGateCard {
  id: string;
  kind: IssueGateKind;
  state_version: number;
  question: { questions?: Array<{
    question: string;
    options: IssueGateOption[];
    /** 推荐项的码(ADR-0004,只标注不预选):分析确认闸在码表里定死,
     * 无单结论闸从 AI 提案派生;换库验证宿主定不了,不硬给。 */
    recommended?: string;
  }> };
  context?: string;
  /** 仅 env_needed:闸为哪类动作而举(logs=拉日志 / deploy=换库部署)。 */
  scope?: "logs" | "deploy";
  proposal?: {
    conclusion?: "issue" | "non_issue";
    summary?: string;
    report?: string;
  };
  created_at: string;
}

export interface IssueSummary {
  id: string;
  account: string;
  created_at: string;
  updated_at: string;
  title: string;
  description: string;
  source: "manual" | "dts";
  ticket?: string;
  repo_url?: string;
  /** 全部关联仓(彼此平等;与 repo_url 由服务端 dual-write 保持一致)。 */
  repo_urls?: string[];
  module?: string;
  /** 登记选定的业务模块 ID(module 标签的来源留痕)。 */
  module_id?: string;
  /** 登记基线(分支/tag 等起点说明;问题流登记表单未暴露)。 */
  baseline?: string;
  /** 登记时带的网管环境(地址列表与 vault 引用;密码只存服务端,永不上线)。
   * page_account/page_credential_ref 只在登记配了页面凭据时在场——env_needed
   * 闸现场补配的环境没有页面凭据,两键一并缺席。 */
  environment?: {
    credential_ref: string;
    name: string;
    hosts: string[];
    port: number;
    page_account?: string;
    page_credential_ref?: string;
  };
  mode?: IssueFlowMode;
  scenario?: IssueScenario;
  stage_states?: IssueStageState[];
  round?: number;
  /** 检视回合进行中(ADR-0007):意见已提交、整体回退到分析重跑,
   * 期间检视入口置灰;新一轮 submit_analysis 时清除。 */
  review_active?: boolean;
  gate?: IssueGateCard;
  ut?: { passed: boolean; summary: string; log_path?: string; round: number; at: string };
  /** 流水线监看(按仓,键=仓地址;一仓一 MR 一流水线)。 */
  pipelines?: Record<string, {
    sha: string;
    status: "running" | "success" | "failed";
    watching: boolean;
    started_at: string;
    deadline: string;
    last_error?: string;
    round: number;
    /** 终态落账的检查项(服务端 settlePipeline 存);失败项据此呈现。 */
    checks?: Array<{ dimension: string; status: string; job?: string; url?: string }>;
  }>;
  converted_from?: string;
  converted_to?: string;
  /** 转正继承的交付账引用(#31 只读引用):指向转正前的旧会话,仓卡
   * 渲染时按它经详情接口读旧账并标注「转正前」;旧会话被物理清理时
   * 静默缺省(仓卡退回现状)。 */
  inherited_accounts?: { issue: string };
  status: IssueStatus;
  stage: AnyIssueStage;
  stage_note: string;
  /** 当前阶段的进入时刻(ISO)。 */
  stage_at: string;
  /** 网管环境是否已配置(服务端 summarize 派生)。 */
  has_environment: boolean;
  /** 本回合已用催办次数(服务端催办预算账;前端暂不消费)。 */
  nudges?: number;
  conclusion?: {
    kind: "non_issue" | "fixed" | "delivered" | "issue" | "converted";
    summary: string;
    at: string;
  };
  /** 推送账(按仓,一仓一分支)。 */
  pushes?: Array<{ repo: string; branch: string; sha: string; at: string }>;
  /** MR 账(按仓,一仓一 MR)。 */
  mrs?: Array<{ repo: string; branch: string; title: string; url?: string; iid?: string; at: string }>;
  /** 阶段转移审计:agent 声明与 platform 机械事实同账。 */
  transitions?: Array<{
    at: string; source: "agent" | "platform"; stage?: AnyIssueStage; note: string;
  }>;
  error?: string;
  last_reply?: string;
}

export interface IssueWaitingCard {
  waiting_id: string;
  state_version: number;
  /** 选项一律是码+文案对:平台闸的码出自服务端注册表码表,Agent 卡
   * 的码由服务端投影时按题号/序号派发(opt-题-序)。渲染 label,
   * 提交 code。 */
  question: { questions?: Array<{
    question: string;
    options: IssueGateOption[];
    /** 推荐项的投影码(ADR-0004,只标注不预选):Agent 卡由服务端把
     * 推荐原文对回 opt-题-序 码,平台闸码表定死/提案派生;前端按码
     * 标徽标,渲染 label、提交 code 的既有约定不变。 */
    recommended?: string;
  }> };
  context?: string;
  created_at: string;
  /** 平台闸专用(会话视图从 detail.gate 带过来):闸的种类与用途面。
   * env_needed 据此渲染专用环境表单,其余闸仍走通用选项卡。 */
  gate_kind?: IssueGateKind;
  gate_scope?: "logs" | "deploy";
  /** 以下为服务端 humanGate 记录随线携带的内部账(卡片只渲染上面的
   * 子集):契约测试(issueFlowContract)钉整卡形状,服务端加字段先
   * 来这里补镜再让测试转绿。 */
  task_id?: string;
  step?: string;
  call_id?: string;
  status?: "waiting" | "resolved" | "superseded";
  decision?: string;
  answers?: Record<string, string>;
  notes?: string;
  resolved_at?: string;
  reminders?: number;
}

export interface IssueDetail extends IssueSummary {
  waiting?: IssueWaitingCard;
  has_analysis: boolean;
}

export interface DtsTicketBrief {
  ticket: string;
  title: string;
  status?: string;
  version?: string;
  severity?: string;
  submitter?: string;
  url?: string;
  description?: string;
}

/** 单张问题单详情(页签展开用):列表字段优先,详情接口补齐描述全文。
 * content = mcpResultText 原文(兜底展示),description = detailDesc 全文。 */
export interface DtsTicketDetail {
  ticket: string;
  title: string;
  content: string;
  description?: string;
  severity?: string;
  version?: string;
  url?: string;
  submitter?: string;
  /** 状态名:远程查单入列要靠它过"开发人员实施修改"可拉取判定。 */
  status?: string;
}

/** env_needed 闸的环境表单 wire 形(POST /issues/:id/environment 请求体,
 * 与服务端 routes 的读取一一对应):地址 + 端口 + 网管后台密码。闸只收
 * 这三样——现场补配的流程(拉日志/换库)碰不到网管页面,没有页面凭据
 * 的位置;密码只进服务端 vault,不落状态/事件。 */
export interface IssueEnvironmentForm {
  hosts: string[];
  port?: number;
  backend_password: string;
}

async function issueFetch(
  path: string,
  init?: RequestInit,
): Promise<any> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(String(body.error ?? `HTTP ${response.status}`));
  }
  return response.json();
}

export function listIssues(): Promise<IssueSummary[]> {
  return issueFetch("/issues").then((body) => body.issues ?? []);
}

export function getIssue(id: string): Promise<IssueDetail> {
  return issueFetch(`/issues/${encodeURIComponent(id)}`);
}

/** 登记侧网管环境四件套(wire 形,与服务端 service.ts 的
 * normalizeEnvironmentInput 同一把尺):hosts 支持多台;页面账号缺省
 * admin 由服务端归一;两个密码只进服务端 vault,任何接口不回显。
 * 无单登记服务端强制 module_id + 环境(spec #15 的 wire 无兼容包袱)。 */
export interface IssueRegistrationEnvironment {
  hosts: string[];
  page_account?: string;
  page_password: string;
  backend_password: string;
}

export function createIssue(input: {
  title: string;
  description?: string;
  source?: "manual" | "dts";
  ticket?: string;
  repo_url?: string;
  /** 多仓登记(模块带仓是常态):全部关联仓彼此平等,哪些交付由 AI 裁决。 */
  repo_urls?: string[];
  baseline?: string;
  module?: string;
  /** 登记选定的业务模块 ID:后端校验存在且 active,名称派生 module。
   * 无单号登记服务端强制必带,并按模块绑定整表带出仓。 */
  module_id?: string;
  environment?: IssueRegistrationEnvironment;
}): Promise<IssueSummary> {
  return issueFetch("/issues", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function replyIssue(id: string, text: string): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

/** 问题卡作答:decision 是人话文本(显示/自由作答);平台闸另带决策码
 * code(裁决按它分派,文案不是匹配键);Agent 卡带逐题作答 answers
 * (键=题号,值=决策码或自由文本)。 */
export function answerIssue(id: string, input: {
  state_version: number;
  decision: string;
  code?: string;
  answers?: Record<string, string>;
  notes?: string;
}): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function steerIssue(id: string, text: string): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/interrupt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

/** 网管环境配置(env_needed 闸的作答口):登记时没配环境,拉日志/
 * 换库现场举闸后在这里补地址与网管后台密码。密码只进服务端 vault,不落
 * 状态/事件;成功即清闸,平台会开回合让 AI 重试刚才的操作。 */
export function attachIssueEnvironment(
  id: string,
  input: IssueEnvironmentForm,
): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/environment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function bindIssueTicket(id: string, ticket: string): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticket }),
  });
}

/** 挂起会话关联 DTS 单号转正(固定流程无单场景的收口)。两段式:
 * 不带 confirm → 校验单号存在并回单据详情过目;带 confirm → 转正生成
 * 新会话(继承分析报告直接进问题修改),返回 converted。 */
export function associateIssueTicket(id: string, input: {
  ticket: string;
  confirm?: boolean;
}): Promise<{ ticket_detail?: DtsTicketDetail; converted?: IssueSummary }> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/associate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function controlIssue(id: string, input: {
  action: "cancel" | "archive";
  kind?: "non_issue" | "fixed" | "delivered" | "issue" | "converted";
  summary?: string;
}): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/control`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function listDtsTickets(): Promise<{
  tickets: DtsTicketBrief[];
  /** 外部开发模式(--dts-mock):单据为模拟数据,页面要挂 DEV 徽标。 */
  mock: boolean;
}> {
  const body = await issueFetch("/issues/dts");
  return { tickets: body.tickets ?? [], mock: body.mock === true };
}

export function getDtsTicketDetail(ticket: string): Promise<DtsTicketDetail> {
  return issueFetch(`/issues/dts/${encodeURIComponent(ticket)}`);
}

// ---- 会话材料(交付材料页签;全部旁路,失败给空态) ----

export interface IssueWorkspaceChange {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
}

/** 拉取日志条目(#47):local-logs 相对路径,type=dir 的 size 恒 0,
 * archive 按扩展名标注(压缩包行才有解压按钮)。 */
export interface IssueLogEntry {
  path: string;
  type: "file" | "dir";
  size: number;
  mtime: string;
  archive: boolean;
}

export interface IssueLogListing {
  entries: IssueLogEntry[];
  truncated: boolean;
}

export interface IssueManualEdit {
  ts: string;
  path: string;
  size: number;
}

export interface IssueMaterials {
  ticket?: string;
  pushes: Array<{ repo: string; branch: string; sha: string; at: string }>;
  mrs: Array<{ repo: string; branch: string; title: string; url?: string; iid?: string; at: string }>;
  changes: IssueWorkspaceChange[];
  logs: IssueLogListing;
  manual_edits: IssueManualEdit[];
}

export interface IssueRawEvent {
  eventId?: number;
  ts?: string;
  kind?: string;
  payload?: Record<string, unknown>;
}

export function getIssueMaterials(id: string): Promise<IssueMaterials> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/materials`);
}

export function getIssueFileDiff(
  id: string, path?: string, repo?: string,
): Promise<{ diff: string }> {
  // path = 单文件;repo = 单仓切片(服务端只回该仓,无分段标记,#32)。
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (repo) params.set("repo", repo);
  const query = params.toString();
  return issueFetch(`/issues/${encodeURIComponent(id)}/materials/diff${query ? `?${query}` : ""}`);
}

export function getIssueWorkspaceFile(
  id: string, path: string,
): Promise<{ content: string; truncated: boolean }> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/materials/file?path=${encodeURIComponent(path)}`);
}

export function saveIssueWorkspaceFile(
  id: string, path: string, content: string,
): Promise<{ ok: true; size: number }> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/materials/file`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
}

export function getIssueMaterialLog(
  id: string, path: string,
): Promise<{ content: string; truncated: boolean }> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/materials/log?name=${encodeURIComponent(path)}`);
}

/** 解压压缩包日志(#47):服务端解到同目录 <去扩展名>-extracted/,
 * 目录已在时幂等返回(reused=true,不重解)。 */
export function extractIssueLog(
  id: string, path: string,
): Promise<{ ok: true; path: string; reused: boolean }> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/materials/log-extract`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
}

export function getIssueRawEvents(
  id: string, limit = 200,
): Promise<{ events: IssueRawEvent[] }> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/materials/events?limit=${limit}`);
}

// ---- 问题会话的视图旁路(服务端 src/issueFlow/sessionView.ts 的镜像) ----

/** 一段"等人"的时长:closed = 有下一条人话封口;open_ended = 问题卡
 * 还开着,ms 以查询时刻截止。 */
export interface IssueTimelineWait {
  start: string;
  end?: string;
  ms: number;
  open_ended?: boolean;
  question: string;
}

/** 关键事件(消息节选级别,不是整段聊天):assistant=结论文节选、
 * decision=用户决策节选、stage=阶段切换(source 标记 AI 上报/平台事实)。 */
export interface IssueTimelineEvent {
  ts: string;
  kind: "assistant" | "decision" | "stage";
  source?: string;
  title: string;
  detail?: string;
}

/** 「耗时与卡点」视图:问题域的消息账 + 转移账归纳结论。 */
export interface IssueTimeline {
  span: { start: string; end: string; ms: number };
  human_waits: IssueTimelineWait[];
  human_wait_ms: number;
  human_wait_share: number;
  longest_waits: IssueTimelineWait[];
  decisions: number;
  blocker: string;
  events: IssueTimelineEvent[];
}

/** 时间线接口尚未就绪(旧进程)时把解释带回,不假装"什么都没发生"。 */
export async function getIssueTimeline(
  id: string,
): Promise<{ timeline?: IssueTimeline; unavailable?: string }> {
  const response = await fetch(`/issues/${encodeURIComponent(id)}/timeline`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return { unavailable: String(body.error ?? `HTTP ${response.status}`) };
  }
  return { timeline: await response.json() };
}

// ---- 过程文档(材料页签的过程文档子视图;数据面 documents.ts) ----

export interface IssueDocMeta {
  name: string;
  label: string;
  bytes: number;
  modified_at: string;
}

export interface IssueDialogueQuestion {
  question: string;
  options: string[];
}

/** 过程问答的一回合(ADR-0008 口径):问答卡、用户决策、用户主动
 * 输入、检视意见;agent 的过程性发言不进投影。 */
export interface IssueDialogueTurn {
  kind: "user" | "card" | "decision" | "review";
  ts?: string;
  text?: string;
  via?: string;
  questions?: IssueDialogueQuestion[];
  decision?: string;
  notes?: string;
  /** 检视回合专有:意见条数(正文 text 是提交的意见清单)。 */
  count?: number;
}

/** 过程文档清单(分析报告固定首位 + Agent 落的其他 .md)。 */
export function getIssueDocuments(id: string): Promise<{
  documents: IssueDocMeta[];
}> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/documents`);
}

/** 读一份过程文档。缺失为 200 {unavailable}(还没生成),404 只在
 * 问题号未知时出现。 */
export async function getIssueDocument(
  id: string,
  name: string,
): Promise<{ content?: string; truncated?: boolean; unavailable?: string }> {
  const body = await issueFetch(
    `/issues/${encodeURIComponent(id)}/documents/read?name=${encodeURIComponent(name)}`);
  return {
    content: body.content ? String(body.content) : undefined,
    truncated: body.truncated === true ? true : undefined,
    unavailable: body.unavailable ? String(body.unavailable) : undefined,
  };
}

/** 过程问答:事件账本投影的对话。 */
export function getIssueDialogue(id: string): Promise<{
  turns: IssueDialogueTurn[];
  truncated?: boolean;
}> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/dialogue`);
}

// ---- 检视(材料页签的检视子视图;ADR-0007,服务端 reviews.ts) ----

/** 服务端 Annotation 的 wire 镜像(问题域只用 doc 一类;response/
 * verified 等逐条闭环字段是需求流闭环的,问题域不出,故不镜)。 */
export interface IssueReview {
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
  sent_via?: string;
  edited_at?: string;
}

/** 锚点检测(送出后原文还在吗):gone = 已被改动(唯一判据),
 * moved = 仅漂移,ambiguous = 多处命中。 */
export interface IssueReviewCheck {
  id: string;
  state: "hit" | "moved" | "gone" | "ambiguous";
  line?: number;
  now?: string;
}

export function getIssueReviews(id: string): Promise<{
  reviews: IssueReview[];
  checks: IssueReviewCheck[];
  review_active: boolean;
}> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/reviews`);
}

export function addIssueReview(id: string, input: {
  line: number;
  anchor: string;
  note: string;
}): Promise<IssueReview> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/reviews`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function dropIssueReview(id: string, reviewId: string): Promise<IssueReview> {
  return issueFetch(
    `/issues/${encodeURIComponent(id)}/reviews/${encodeURIComponent(reviewId)}`,
    { method: "DELETE" });
}

/** 提交检视:整体回退到问题分析(有后果,页面层先轻量确认)。 */
export function sendIssueReviews(id: string): Promise<IssueSummary> {
  return issueFetch(`/issues/${encodeURIComponent(id)}/reviews/send`, {
    method: "POST",
  });
}
