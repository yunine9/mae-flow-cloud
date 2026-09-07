/**
 * 任务工作台:决策发生在哪里,证据就在哪里。
 *
 * 用户实测的摩擦:审批卡问"本地 Spec 确认",spec.md 却只在内核
 * 现场面板(另一套 UI 的 iframe)里能看——读材料要跳出决策上下文。
 * 左侧完整阅读原文、文档、代码与活动；右侧统一承接反馈与决定。
 * 批注原位写、原位看回执；同一记录也出现在协作区，回复入口固定在底部。
 *
 * 内核面板不再暴露给业务用户：它是内核为“人坐在终端旁”生成的
 * 单文件 HTML，工作台自己承接材料、决策与过程观察，避免形成两套入口。
 */

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Markdown } from "./markdown";
import { GitDiff, type GitDiffSelection } from "./GitDiff";
import { RequirementDiff } from "./RequirementDiff";
import { QuickWishButton } from "./WishQuickCreate";
import { ConversationStream, type StreamFilter } from "./ConversationStream";
import { Composer, takeoverActiveOf } from "./Composer";
import { Annotatable } from "./Annotatable";
import { AnnotationPanel, type ReviewFilter } from "./AnnotationPanel";
import { RequirementGraph } from "./RequirementGraph";
import { requirementGraphVisible } from "./taskHierarchy";
import { PrepushBadge } from "./PrepushStatus";
import { StagePlanDialog } from "./StagePlanDialog";
import { OverlayDialog, WarmupBadge, WarmupPanel } from "./WarmupPanel";
import { KnowledgeFootprint } from "./KnowledgeFootprint";
import { TaskJourney } from "./TaskJourney";
import { TaskInspector, type TaskInspectorKind } from "./TaskInspector";
import { taskHealthFacts } from "./taskHealth";
import { relativeTime } from "./time";
import { startVisiblePolling } from "./visiblePolling";
import {
  EMPTY_REPOSITORY_ASSIGNEE_SELECTION,
  RepositoryAssigneePicker,
  type RepositoryAssigneeSelection,
} from "./RepositoryAssigneePicker";
import { RequirementTeamPicker } from "./RequirementTeamPicker";
import { UserPicker } from "./UserPicker";
import {
  addAnnotation,
  completeReview,
  controlTask,
  getConversation,
  decideScopeViolation,
  deleteHistoryTask,
  listAnnotations,
  listArtifactChangeDirectory,
  listArtifacts,
  listCommitters,
  listPeople,
  listTaskReviews,
  putRepositoryAssignees,
  readArtifact,
  readArtifactFileDiff,
  readPushReviewDiff,
  readRequirementRevision,
  repairStopped,
  requestCommitterReview,
  sendAnnotations,
  statusText,
  TASK_REQUIREMENT_ARTIFACT,
  type AnchorCheck,
  type AnnotationClosure,
  type Annotation,
  type ArtifactMeta,
  type AuthUser,
  type ConversationItem,
  type DeveloperAssistantView,
  type FeedbackRecord,
  type FeedbackSource,
  type FeedbackStatus,
  type ReviewRequest,
  type TaskSummary,
} from "./api";
import {
  isChainReviewWaiting,
  isClarificationWaiting,
  isOwnerOnlyWaiting,
  reworkChoiceOf,
  RetryButton,
  TaskProgress,
  WaitBadge,
  WaitingCard,
} from "./TaskCard";

type WorkspaceView = "focus" | "materials" | "execution" | "knowledge";

/** 右栏宽度:人拖过就记住(浏览器本地),没拖过走样式表的默认档。 */
const SIDE_WIDTH_KEY = "mae-flow:ws-side-w";
const SIDE_WIDTH_MIN = 360;
type MaterialView = "source" | "doc" | "chain" | "diff";

const WORKSPACE_VIEW_SHORTCUTS: Partial<Record<string, WorkspaceView>> = {
  Digit1: "focus",
  Digit2: "materials",
  Digit3: "execution",
};
/** 三个视图的中文名:⌥1/2/3 的提示与无障碍标签共用。"当前"是左栏,
 *  "产物/活动"是右侧工作区的两种内容。 */
const WORKSPACE_VIEW_LABELS: Array<[WorkspaceView, string]> = [
  ["focus", "当前"],
  ["materials", "材料"],
  ["execution", "工作过程"],
];
function viewShortcutHint(view: WorkspaceView): string {
  const index = WORKSPACE_VIEW_LABELS.findIndex(([candidate]) => candidate === view);
  return `⌥${index + 1}`;
}

/** 圈注和“把意见送给 Agent”是两种权限；只有停止的任务禁止再记。 */
export function canCreateWorkspaceAnnotation(
  status: TaskSummary["status"],
): boolean {
  return status !== "canceled";
}

/** 批注定位必须能回到虚拟的需求原文，而不是把它误当产出文档。 */
export function materialViewForAnnotation(
  artifact: string,
  artifacts: readonly ArtifactMeta[] = [],
): MaterialView {
  if (artifact === TASK_REQUIREMENT_ARTIFACT) return "source";
  if (artifact === "__workspace_diff__") return "diff";
  return artifacts.find((item) => item.name === artifact)?.kind === "diff"
    ? "diff" : "doc";
}

/** 这是显式的人工作业，不等同于普通 verifying。partial 时 Agent 可以
 * 先修已有证据，但缺失维度仍需要人并行补原文。 */
export function pipelineEvidenceNeedsHuman(task: TaskSummary): boolean {
  const state = task.delivery?.evidence_gap?.state;
  return (state === "waiting_human" || state === "partial")
    && Boolean(task.delivery?.evidence_gap?.missing_dimensions.length);
}

/** 首次进入工作台时，系统点名要求处理的补证材料必须胜过“最近修改”
 * 排序；用户已经主动切到别的有效材料后则不抢回焦点。 */
export function preferredWorkspaceArtifact(
  items: readonly ArtifactMeta[],
  current: string,
  recommendedView: "source" | "doc" | "chain" | "diff" | undefined,
  evidenceGapActive: boolean,
): string {
  if (current && items.some((item) => item.name === current)) return current;
  if (evidenceGapActive) {
    const gap = items.find((item) => item.purpose === "pipeline_evidence_gap");
    if (gap) return gap.name;
  }
  if (recommendedView === "doc") {
    const brief = items.find((item) =>
      item.purpose === "delivery_unit_brief");
    if (brief) return brief.name;
  }
  const preferredKind = recommendedView === "diff" ? "diff" : "doc";
  return items.find((item) => item.kind === preferredKind)?.name
    ?? items[0]?.name ?? "";
}

/** 决定只能携带当前操作者自己尚未送达的草稿；别人的草稿只是其记录。 */
export function decisionAnnotationIds(
  items: readonly Annotation[],
  viewerUsername: string,
): string[] {
  return items.filter((item) => item.status === "draft"
    && item.author === viewerUsername).map((item) => item.id);
}

/** 当前材料搜索只认正文行，不搜索页签、按钮等界面文案。 */
export function matchingMaterialRowIndexes(
  rows: ReadonlyArray<{ textContent: string | null }>,
  query: string,
): number[] {
  const needle = query.trim().toLocaleLowerCase("zh-CN");
  if (!needle) return [];
  const matches: number[] = [];
  rows.forEach((row, index) => {
    if ((row.textContent ?? "").toLocaleLowerCase("zh-CN").includes(needle)) {
      matches.push(index);
    }
  });
  return matches;
}

export interface WorkspaceNextActionCopy {
  title: string;
  detail: string;
}

/** 右栏标题和真正渲染的行动卡共用这一套阶段解释，避免卡片明明要求去
 * 合入，标题却还说“当前无待办”。 */
export function workspaceNextActionCopy(
  task: TaskSummary,
  waiting: boolean,
): WorkspaceNextActionCopy {
  if (waiting) return { title: "当前需要处理", detail: "完成后流程继续" };
  if (task.status === "failed") {
    return { title: "任务已失败", detail: "看原因，决定重跑或接手" };
  }
  if (task.status === "verifying") {
    return { title: "交付验证中", detail: "流水线与自动修复由系统跟进" };
  }
  if (task.status === "await_merge") {
    return task.delivery?.mr_state === "已关闭"
      ? { title: "MR 已关闭，需要处理", detail: "查看合入状态并决定后续处理" }
      : { title: "等待检视与合入", detail: "前往 CodeHub 完成最后一步" };
  }
  if (task.status === "coordinating") {
    return { title: "子任务进行中", detail: "全部子任务完成后主任务自动完成" };
  }
  return { title: "当前无待办", detail: "无需处理" };
}

/** 问题定位一键采集:任务出事(failed/交付停摆)时把全部可定位事实
 * 现采成一个 markdown 下载。服务端在出事瞬间也会自动留档一份到任务
 * 目录 diagnostics/,这里是给人手动再拿最新现场的口。 */
function DiagnosticsLink({ taskId }: { taskId: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");

  async function downloadDiagnostics() {
    setState("loading");
    try {
      const response = await fetch(
        `/tasks/${encodeURIComponent(taskId)}/diagnostics`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const matched = disposition.match(/filename="?([^";]+)"?/i);
      const filename = matched?.[1] ?? `${taskId}-diagnostics.md`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setState("done");
    } catch {
      setState("error");
    }
  }

  return (
    <span className="diagnostics-action">
      <button type="button" className="diagnostics-link"
        disabled={state === "loading"} onClick={downloadDiagnostics}
        title="把任务状态、内核现场、Git/容器事实、会话事件与服务日志汇成一个文件">
        {state === "loading" ? "正在生成诊断包…" : "导出诊断包"}
      </button>
      {state === "done" && <small role="status">已开始下载</small>}
      {state === "error" && <small role="alert">生成失败，请重试</small>}
    </span>
  );
}

/** 越界裁决卡(单仓拆分):交付单元的提交越出负责文件面时停摆留痕,
 * 这里给主责任人两个出口——放行(记豁免续推)或打回(派修复撤出)。
 * 卡对所有能看到任务的人可见(方便一起看现场),裁决权在服务端钉死为
 * 主任务责任人,403 的解释原样露出。 */
function ScopeViolationCard({ task, onChanged }: {
  task: TaskSummary;
  onChanged: () => void;
}) {
  const violation = task.delivery?.scope_violation;
  const [busy, setBusy] = useState<"allow" | "revert" | null>(null);
  const [error, setError] = useState("");
  if (!violation?.paths.length) return null;
  async function decide(decision: "allow" | "revert") {
    setBusy(decision);
    setError("");
    const result = await decideScopeViolation(task.id, decision);
    setBusy(null);
    if (result.error) setError(result.error);
    else onChanged();
  }
  return (
    <div className="scope-violation-card" role="alert">
      <strong>请裁决越界改动</strong>
      <p>
        本单元{task.delivery_scope?.name ? `(${task.delivery_scope.name})` : ""}
        的提交改动越出了负责文件面。可能是实现确有需要(比如动到接口契约),
        也可能是拆分方案有误。
      </p>
      <ul className="scope-violation-paths">
        {violation.paths.map((path) => <li key={path}><code>{path}</code></li>)}
      </ul>
      <div className="scope-violation-actions">
        <button type="button" disabled={busy !== null}
          onClick={() => decide("allow")}
          title="这些文件记入豁免名单,改动随本单元 MR 一起检视">
          {busy === "allow" ? "正在放行…" : "放行,随本单元交付"}
        </button>
        <button type="button" className="scope-violation-revert"
          disabled={busy !== null} onClick={() => decide("revert")}
          title="派修复把这些文件从提交中撤出,负责面内的实现保留">
          {busy === "revert" ? "正在下发撤出令…" : "打回,撤出越界改动"}
        </button>
      </div>
      <small>裁决人是主任务责任人；其他成员点击后会提示应联系的具体账号。</small>
      {error && <small role="alert" className="scope-violation-error">{error}</small>}
    </div>
  );
}

/** await_merge 的右栏行:默认一行状态,点开只展开一句说明 + MR 链接
 * (MFC-039 用户拍板:去掉与右栏标题重复的大卡)。MR 被关闭是需要人
 * 处理的例外,直接展示不折叠。 */
function MergeWaitLine({ task, canOperate }: {
  task: TaskSummary;
  canOperate: boolean;
}) {
  const [open, setOpen] = useState(false);
  const mrLink = task.delivery?.mr_url
    ? <a href={task.delivery.mr_url} target="_blank" rel="noreferrer">
        打开合入请求 ↗
      </a>
    : <em>平台尚未返回 MR 链接，请稍后刷新。</em>;
  if (task.delivery?.mr_state === "已关闭") {
    return (
      <div className="ws-merge-line is-closed" role="alert">
        <strong>MR 已关闭，任务还没有结束</strong>
        <p>{task.delivery?.waiting_on
          || "重新打开 MR 后系统自动恢复监听；不再继续可用右上角“取消”。"}
          {mrLink}</p>
      </div>
    );
  }
  return (
    <div className="ws-merge-line">
      <button type="button" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}>
        <span className="ws-merge-line-dot" aria-hidden />
        等待合入
        <svg viewBox="0 0 16 16" aria-hidden
          className={open ? "is-open" : undefined}>
          <path d="m5 6.5 3 3 3-3" /></svg>
      </button>
      {open && (
        <p>{task.delivery?.waiting_on
          || "流水线与门禁已通过，请前往 MR 完成检视与合入。"}{mrLink}
          {canOperate && <small>
            不再继续这项任务时，可用右上角“取消”明确停止监听。
          </small>}
        </p>
      )}
    </div>
  );
}

export type PushReviewDiffLoadState =
  | { kind: "idle" | "checking" | "ready" }
  | { kind: "error"; message: string; expired: boolean };

export function normalizePushReviewDiffResult(result: {
  content?: string;
  branch?: string;
  unavailable?: string;
  status?: number;
}): {
  content: string;
  branch: string;
  state: PushReviewDiffLoadState;
} {
  const message = result.unavailable?.trim();
  if (message) {
    return {
      content: "",
      branch: "",
      state: { kind: "error", message, expired: result.status === 404 },
    };
  }
  return {
    content: result.content ?? "",
    branch: result.branch ?? "",
    state: { kind: "ready" },
  };
}

export function usablePushReviewSelection(
  pushReviewActive: boolean,
  state: PushReviewDiffLoadState,
  selection: GitDiffSelection | undefined,
): GitDiffSelection | undefined {
  return pushReviewActive && state.kind !== "ready" ? undefined : selection;
}

export function defaultWorkspaceView(_task: TaskSummary): WorkspaceView {
  // 状态变化只改「当前」画布里的内容，不再把人自动甩到另一套导航。
  return "focus";
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const FEEDBACK_SOURCE_LABEL: Record<FeedbackSource, string> = {
  workspace: "工作台批注",
  mr_discussion: "MR 检视",
  build_fix: "Build-Fix",
  pipeline: "流水线",
  conflict: "合并冲突",
  scope: "负责范围",
  push_confirmation: "推送前复检",
};

const FEEDBACK_STATUS_LABEL: Record<FeedbackStatus, string> = {
  open: "待处理",
  repairing: "处理中",
  addressed: "已处理",
  awaiting_verification: "待核验",
  closed: "已完成",
  needs_human: "需要你决定",
};

/** 状态文案按来源说人话:同一个 awaiting_verification,对 CodeHub 意见
 * 是"Agent 已回复、等检视人在 MR 里确认",对工作台批注是"等批注作者
 * 确认"。状态本身仍来自任务 API,这里只挑措辞,不推断。 */
function feedbackStatusLabel(item: FeedbackRecord): string {
  if (item.source === "mr_discussion") {
    if (item.status === "awaiting_verification") return "已回复，等检视人确认";
    if (item.status === "closed") return "检视人已确认";
  }
  if (item.source === "workspace" && item.status === "awaiting_verification") {
    return "等批注作者确认";
  }
  return FEEDBACK_STATUS_LABEL[item.status];
}

function groupFeedback(feedback: FeedbackRecord[]) {
  const grouped = new Map<FeedbackSource, FeedbackRecord[]>();
  for (const item of feedback) {
    grouped.set(item.source, [...(grouped.get(item.source) ?? []), item]);
  }
  return [...grouped];
}

/** 一份来源的意见列表,竖排、正文原样换行、Agent 的回复单独成块——
 * 和批注卡片同一套版式,放进「检视意见」里不违和。 */
export function FeedbackList({ kicker, title, hint, items, mrUrl, onConvert }: {
  kicker: string;
  title: string;
  hint?: string;
  items: FeedbackRecord[];
  /** CodeHub 意见给一个回到 MR 的入口;讨论级链接平台不给,只到 MR。 */
  mrUrl?: string;
  /** 把一条外部意见转成工作台批注草稿(走现有批注链路补充给 Agent)。
   * 返回错误文案;成功返回 undefined。 */
  onConvert?: (item: FeedbackRecord) => Promise<string | undefined>;
}) {
  const active = items.filter((item) => item.status !== "closed").length;
  const [converting, setConverting] = useState("");
  const [notices, setNotices] = useState<Record<string, string>>({});
  async function convert(item: FeedbackRecord) {
    if (!onConvert || converting) return;
    setConverting(item.id);
    try {
      const error = await onConvert(item);
      setNotices((current) => ({
        ...current,
        [item.id]: error ?? "已生成工作台批注草稿，在上方「来自 Cloud 工作台的检视意见」里补充后提交。",
      }));
    } finally {
      setConverting("");
    }
  }
  return <section className="feedback-list" aria-label={title}>
    <header>
      <div>
        <span>{kicker}</span>
        <strong>{title}</strong>
        {hint && <p>{hint}</p>}
      </div>
      <div className="feedback-list-side">
        <i>{items.length} 条</i>
        {active > 0 && <em>{active} 进行中</em>}
        {mrUrl && <a href={mrUrl} target="_blank" rel="noreferrer">打开 MR</a>}
      </div>
    </header>
    <ol>
      {items.map((item) => <li key={item.id} className={`feedback-item ${item.status}`}>
        <div className="feedback-item-head">
          {item.file
            ? <code>{item.file}{item.line !== undefined ? `:${item.line}` : ""}</code>
            : <code className="feedback-item-nofile">未指向具体文件</code>}
          <span className={`feedback-state ${item.status}`}>
            {feedbackStatusLabel(item)}
          </span>
        </div>
        <p className="feedback-body">{item.summary}</p>
        {item.resolution && <div className="feedback-response">
          <strong>{item.source === "mr_discussion" ? "Agent 回复" : "处理结果"}</strong>
          <p>{item.resolution}</p>
        </div>}
        <div className="feedback-item-foot">
          <small>
            {FEEDBACK_SOURCE_LABEL[item.source]}
            {item.author && ` · 检视人 ${item.author}`}
            {` · ${relativeTime(item.updated_at) || item.updated_at}`}
          </small>
          {onConvert && item.status !== "closed" && !notices[item.id] && (
            <button type="button" className="feedback-convert"
              disabled={converting === item.id}
              title="把这条意见变成你的工作台批注草稿,可以补一句自己的话再提交给 Agent"
              onClick={() => void convert(item)}>
              {converting === item.id ? "生成中…" : "转成工作台批注"}
            </button>
          )}
        </div>
        {notices[item.id] && <p className="feedback-convert-notice" role="status">
          {notices[item.id]}
        </p>}
      </li>)}
    </ol>
  </section>;
}

/** 缺陷单等没有「检视意见」弹层的页面用:按来源分节的完整列表。 */
export function FeedbackPanel({ feedback }: { feedback: FeedbackRecord[] }) {
  const active = feedback.filter((item) => item.status !== "closed").length;
  return <section className="feedback-panel" aria-label="持续检视反馈明细">
    <header>
      <span><strong>持续检视</strong><small>同一个任务、分支和 MR</small></span>
      <em className={active ? "active" : "done"}>
        {active ? `${active} 条进行中` : "全部已闭环"}
      </em>
    </header>
    {groupFeedback(feedback).map(([source, items]) => (
      <FeedbackList key={source} kicker="持续检视"
        title={FEEDBACK_SOURCE_LABEL[source]} items={items} />
    ))}
  </section>;
}

/** 进度只有一个来源:任务 API 的 progress(服务端按内核 flow/phases.json
 * 一份词表给出,没有内核脉冲时也由服务端按状态占位)。前端不再自带任何
 * 阶段名——原来这里有三套(协调中五段、持续检视五段、无内核七段),和内核
 * 看板各说各话,老任务停在哪套显示哪套,点阶段名去内核方案词表里按名字
 * 找也必然落空(2026-09-02 用户实锤)。服务端也没给时只画一个"尚未进入
 * 阶段"的空轨道,绝不自造名字。 */
/** 抽屉快捷键的显示文案:Mac 键帽是 ⌥,其他平台叫 Alt。 */
const REVIEW_SHORTCUT = typeof navigator !== "undefined"
  && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌥R" : "Alt+R";

/** 焦点在能打字的地方时不抢快捷键:Mac 上 ⌥R 本来就会打出 ®。 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function workspaceProgress(task: TaskSummary): NonNullable<TaskSummary["progress"]> {
  if (task.progress) {
    // 内核进度记录的是自动流程最后停在哪；举卡后人真正面对的当前步骤
    // 已经变成“检视/确认”。工作台大标题继续写“等待权威流水线”会与
    // 旁边的下一步自相矛盾。这里只改只读标题，不动阶段与证据账。
    return task.status === "waiting_for_human"
      ? { ...task.progress,
          step: task.focus?.headline ?? task.waiting?.step ?? "等待你的决定" }
      : task.progress;
  }
  return {
    phases: [],
    current_index: -1,
    current_phase: "尚未进入阶段",
    step: task.focus?.headline ?? statusText(task),
  };
}

export function TaskWorkspace({
  task,
  viewerUsername,
  viewerDisplayName,
  canOverride,
  canOperate,
  canCollaborate,
  canRequestReview,
  reviewAssignment,
  onChanged,
  onClose,
  onOpenTask,
  onExecutionPlanFeedback,
  onOpenFeedbackWall,
}: {
  task: TaskSummary;
  viewerUsername: string;
  viewerDisplayName?: string;
  /** 管理员仅可代删或代确认别人的批注；默认裁决权仍归作者。 */
  canOverride: boolean;
  canOperate: boolean;
  /** 主任务责任人或已被逐仓分工邀请的协作者。最终决定仍看 canOperate。 */
  canCollaborate: boolean;
  canRequestReview: boolean;
  reviewAssignment?: ReviewRequest;
  onChanged: () => void;
  onClose: () => void;
  onOpenFeedbackWall?: () => void;
  onOpenTask?: (taskId: string) => void;
  onExecutionPlanFeedback?: (draft: { title: string; detail: string }) => void;
}) {
  // 旧任务、纯会话和非内核提问没有 approval_subject 元数据；此时需求
  // 原文是唯一保证存在的证据，不能默认打开一个空的产出文档面板。
  const recommendedMaterialView = task.waiting?.recommended_view
    ?? (task.parent_task_id ? "doc"
      : task.requirement_graph?.stage === "confirmed" ? "chain" : "source");
  // push_review 是一份绑定 HEAD 的阅读导航，不是 cloud_push_confirm
  // 私有组件。流水线/批注返工的持续检视卡同样会把 recommended_view
  // 指向 diff；把它按中文/步骤名挡掉，会退回普通产物并把真实变更显示
  // 成 0。审批权仍由 waiting + delivery_selection 单独判断。
  const pushReview = (task.waiting?.recommended_view === "diff"
      || task.waiting?.step === "cloud_push_confirm")
    ? task.delivery?.push_review : undefined;
  const [items, setItems] = useState<ArtifactMeta[]>();
  const [unavailable, setUnavailable] = useState("");
  const [active, setActive] = useState("");
  const [materialView, setMaterialView] =
    useState<MaterialView>(recommendedMaterialView);
  const [content, setContent] = useState("");
  const [branch, setBranch] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedDiffPath, setSelectedDiffPath] = useState("");
  const [diffFileLoading, setDiffFileLoading] = useState(false);
  const [diffFileError, setDiffFileError] = useState("");
  const [notes, setNotes] = useState<Annotation[]>([]);
  const [checks, setChecks] = useState<AnchorCheck[]>([]);
  // 闭环结论由服务端算好(feedbackPolicy 唯一判定处),这里只搬运。
  const [closures, setClosures] = useState<AnnotationClosure[]>([]);
  const [reply, setReply] =
    useState<{ texts: string[]; truncated: boolean } | undefined>();
  const [notesPulse, setNotesPulse] = useState(0);
  const [livePulse, setLivePulse] = useState(0);
  const [committers, setCommitters] = useState<AuthUser[]>([]);
  const [reviewPeople, setReviewPeople] = useState<Array<{
    username: string; display_name?: string;
  }>>([]);
  const [reviewer, setReviewer] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewResult, setReviewResult] = useState("");
  const [taskReviews, setTaskReviews] = useState<ReviewRequest[]>([]);
  const [completeBusy, setCompleteBusy] = useState(false);
  const [completeError, setCompleteError] = useState("");
  const [locationNotice, setLocationNotice] = useState("");
  const [controlBusy, setControlBusy] =
    useState<"pause" | "resume" | "cancel" | "delete" | "">("");
  const [controlError, setControlError] = useState("");
  const [cancelArmed, setCancelArmed] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [repositoryAssignees, setRepositoryAssignees] =
    useState<RepositoryAssigneeSelection>(EMPTY_REPOSITORY_ASSIGNEE_SELECTION);
  const [repositoryAssigneeSave, setRepositoryAssigneeSave] =
    useState<"idle" | "saving" | "saved" | "error">("idle");
  const [deliverySelection, setDeliverySelection] =
    useState<GitDiffSelection>();
  const [pushDiffState, setPushDiffState] = useState<PushReviewDiffLoadState>(
    pushReview ? { kind: "checking" } : { kind: "idle" },
  );
  const [diffScope, setDiffScope] = useState<"changes" | "full">(
    pushReview?.has_focused_changes ? "changes" : "full");
  const [diffReviewRequest, setDiffReviewRequest] = useState(0);
  /** 点进度条阶段名弹该阶段执行方案;空串=不显示。 */
  const [planPhase, setPlanPhase] = useState("");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(
    defaultWorkspaceView(task),
  );
  const [materialsFullscreen, setMaterialsFullscreen] = useState(false);
  const [materialSearchOpen, setMaterialSearchOpen] = useState(false);
  const [materialSearchQuery, setMaterialSearchQuery] = useState("");
  const [materialSearchCount, setMaterialSearchCount] = useState(0);
  const [materialSearchIndex, setMaterialSearchIndex] = useState(-1);
  const [documentsDownloading, setDocumentsDownloading] = useState(false);
  const [documentsDownloadError, setDocumentsDownloadError] = useState("");
  const [taskInspector, setTaskInspector] = useState<TaskInspectorKind>();
  const [warmupOpen, setWarmupOpen] = useState(false);
  const [reviewPanelOpen, setReviewPanelOpen] = useState(false);
  const [reviewRevealRequest, setReviewRevealRequest] = useState(0);
  const [reviewFocus, setReviewFocus] = useState<{
    ids: string[]; request: number;
  }>();
  const [reviewInviteOpen, setReviewInviteOpen] = useState(false);
  /** 需求原文页签上"这一轮改了什么"的对比;null = 看全文。 */
  const [revisionDiff, setRevisionDiff] = useState<{
    id: string; text: string; unavailable?: string;
  } | null>(null);
  const artifactTask = useRef("");
  const openedEvidenceGap = useRef("");
  const [decisionFooterTarget, setDecisionFooterTarget] = useState<HTMLDivElement | null>(null);
  // 右栏会话流:服务端投影(事件账/决定账/批注账/反馈索引拼成的回合)。
  // 每 4 秒一拍,决定/插话/批注落账后立刻补取一次,不等下一拍。
  const [conversation, setConversation] = useState<{
    items: ConversationItem[]; problems: string[]; loaded: boolean; unavailable?: string;
  }>({ items: [], problems: [], loaded: false });
  const [streamFilter, setStreamFilter] = useState<StreamFilter>("all");
  const [streamThread, setStreamThread] = useState<string>();
  const [assistantView, setAssistantView] = useState<DeveloperAssistantView>();
  const [sideWidth, setSideWidth] = useState<number | undefined>(() => {
    try {
      const saved = Number(localStorage.getItem(SIDE_WIDTH_KEY));
      return saved >= SIDE_WIDTH_MIN ? saved : undefined;
    } catch {
      return undefined;
    }
  });
  function startSideResize(event: React.PointerEvent<HTMLDivElement>) {
    const body = bodyRef.current;
    if (!body || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    // 捕获失败(比如合成事件没有真实 pointerId)也照常拖:只是指针滑出拖柄时会掉
    try { handle.setPointerCapture(event.pointerId); } catch { /* 退化为无捕获拖动 */ }
    const bounds = body.getBoundingClientRect();
    const maxWidth = Math.max(SIDE_WIDTH_MIN, Math.floor(bounds.width * 0.6));
    const move = (pointer: PointerEvent) => {
      setSideWidth(Math.round(Math.min(maxWidth,
        Math.max(SIDE_WIDTH_MIN, bounds.right - pointer.clientX))));
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      setSideWidth((current) => {
        try {
          if (current) localStorage.setItem(SIDE_WIDTH_KEY, String(current));
        } catch { /* 私密模式也能用 */ }
        return current;
      });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }
  const conversationRequest = useRef(0);
  const loadConversation = (taskId: string) => {
    const sequence = ++conversationRequest.current;
    return getConversation(taskId).then((result) => {
      if (sequence !== conversationRequest.current) return;
      if (result.view) {
        setConversation({ items: result.view.items, problems: result.view.problems, loaded: true });
      } else {
        setConversation((current) => ({ ...current, loaded: true, unavailable: result.unavailable }));
      }
    }).catch(() => {
      if (sequence === conversationRequest.current) {
        setConversation((current) => ({ ...current, loaded: true, unavailable: "会话流暂时读不到,稍后自动重试。" }));
      }
    });
  };
  useEffect(() => {
    setConversation({ items: [], problems: [], loaded: false });
    setStreamFilter("all");
    setStreamThread(undefined);
    setAssistantView(undefined);
    const stop = startVisiblePolling(() => void loadConversation(task.id), 4000, document);
    return () => { stop(); conversationRequest.current += 1; };
  }, [task.id]);
  useEffect(() => {
    if (!livePulse && !notesPulse) return;
    void loadConversation(task.id);
  }, [livePulse, notesPulse, task.status, task.waiting?.waiting_id]);
  // 深链:#thread=<批注 id> 打开时直接落到那条意见的往来(通知里带的链接)。
  useEffect(() => {
    const match = /(?:^#|&)thread=([^&]+)/.exec(window.location.hash);
    if (match) {
      setStreamThread(decodeURIComponent(match[1]));
    }
  }, [task.id]);
  function showThread(id?: string) {
    setStreamThread(id);
    const base = window.location.pathname + window.location.search;
    window.history.replaceState(null, "", id ? `${base}#thread=${encodeURIComponent(id)}` : base);
  }
  const workspaceRoot = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const materialSearchInput = useRef<HTMLInputElement>(null);
  const materialSearchRows = useRef<HTMLElement[]>([]);
  const viewScroll = useRef<Partial<Record<WorkspaceView, number>>>({});
  const reviewFocusRequest = useRef(0);
  // 逐次串行落盘，避免用户连续输入单号时较慢的旧请求反过来覆盖新值。
  // 切走工作台不会取消这条队列，最后一次输入仍会写回服务端。
  const repositoryAssigneeSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const repositoryAssigneeSaveTask = useRef(task.id);
  const repositoryAssigneeSaveRevision = useRef(0);

  function changeRepositoryAssignees(next: RepositoryAssigneeSelection) {
    const clean = next.error ? next : { ...next, error: undefined };
    setRepositoryAssignees(clean);
    if (next.loading) return;
    const taskId = task.id;
    const revision = ++repositoryAssigneeSaveRevision.current;
    setRepositoryAssigneeSave("saving");
    repositoryAssigneeSaveQueue.current = repositoryAssigneeSaveQueue.current
      .catch(() => undefined)
      .then(async () => {
        await putRepositoryAssignees(taskId, clean.assignments, clean.tickets);
        if (repositoryAssigneeSaveTask.current === taskId
          && repositoryAssigneeSaveRevision.current === revision) {
          setRepositoryAssigneeSave("saved");
        }
      })
      .catch((cause) => {
        if (repositoryAssigneeSaveTask.current !== taskId
          || repositoryAssigneeSaveRevision.current !== revision) return;
        const message = cause instanceof Error ? cause.message : "分工草稿保存失败";
        setRepositoryAssigneeSave("error");
        setRepositoryAssignees((current) => ({ ...current, error: message }));
      });
  }

  // 工作区内切换材料、检视和运行记录；右栏只承接决定与回复。
  function openMaterial(view: MaterialView) {
    if (workspaceView === "execution" || workspaceView === "knowledge") selectWorkspaceView("materials");
    setMaterialView(view);
  }
  function materialTabOn(view: MaterialView): boolean {
    return (workspaceView === "focus" || workspaceView === "materials") && materialView === view;
  }

  function selectWorkspaceView(next: WorkspaceView) {
    if (next === workspaceView) return;
    const currentScroll = workspaceRoot.current?.querySelector<HTMLElement>(
      ".ws-primary-scroll");
    if (currentScroll) viewScroll.current[workspaceView] = currentScroll.scrollTop;
    setWorkspaceView(next);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const nextScroll = workspaceRoot.current?.querySelector<HTMLElement>(
        ".ws-primary-scroll");
      if (nextScroll) nextScroll.scrollTop = viewScroll.current[next] ?? 0;
    }));
  }

  useEffect(() => {
    artifactTask.current = "";
    openedEvidenceGap.current = "";
    setItems(undefined);
    setActive("");
    setContent("");
    setSelectedDiffPath("");
    setDiffFileLoading(false);
    setDiffFileError("");
    setMaterialView(task.waiting?.recommended_view
      ?? (task.parent_task_id ? "doc"
        : task.requirement_graph?.stage === "confirmed" ? "chain" : "source"));
    setWorkspaceView(defaultWorkspaceView(task));
    setMaterialsFullscreen(false);
    setMaterialSearchOpen(false);
    setMaterialSearchQuery("");
    setMaterialSearchCount(0);
    setMaterialSearchIndex(-1);
    setDocumentsDownloading(false);
    setDocumentsDownloadError("");
    setReviewPanelOpen(false);
    setTaskInspector(undefined);
    setWarmupOpen(false);
    setReviewFocus(undefined);
    repositoryAssigneeSaveTask.current = task.id;
    setRepositoryAssigneeSave("idle");
    setRepositoryAssignees(EMPTY_REPOSITORY_ASSIGNEE_SELECTION);
    setRevisionDiff(null);
    setDeliverySelection(undefined);
    setPushDiffState(pushReview ? { kind: "checking" } : { kind: "idle" });
    setDiffScope(pushReview?.has_focused_changes ? "changes" : "full");
    setDiffReviewRequest(0);
  }, [task.id]);

  useEffect(() => {
    if (!pushReview) {
      setDeliverySelection(undefined);
      setPushDiffState({ kind: "idle" });
      setDiffScope("full");
      return;
    }
    const selected = task.delivery_selection?.status === "requested"
      ? task.delivery_selection.paths : pushReview.committed_paths;
    setDeliverySelection({
      selectedPaths: [...selected],
      committedPaths: [...pushReview.committed_paths],
      allPaths: [...pushReview.all_paths],
    });
    setPushDiffState({ kind: "checking" });
    setContent("");
    setDiffScope(pushReview.has_focused_changes ? "changes" : "full");
  }, [task.waiting?.waiting_id, pushReview?.head_sha]);

  useEffect(() => {
    const waitingId = task.waiting?.waiting_id;
    if (!waitingId || task.status === "paused") return;

    // 新决定回到「当前」；需要核对哪份材料由决定卡和证据入口精确打开。
    setWorkspaceView("focus");
    const recommended = task.waiting?.recommended_view;
    if (!recommended) return;
    setMaterialView(recommended);
    if (recommended === "diff") {
      const first = items?.find((item) => item.kind === "diff");
      if (first) setActive(first.name);
    } else if (recommended === "doc") {
      const first = items?.find((item) => item.kind === "doc");
      if (first) setActive(first.name);
    }
  }, [task.status, task.waiting?.waiting_id, task.waiting?.recommended_view]);

  useEffect(() => {
    setWorkspaceView("focus");
  }, [task.status, task.waiting?.waiting_id,
    task.delivery?.evidence_gap?.state,
    task.delivery?.evidence_gap?.sha]);

  useEffect(() => {
    let alive = true;
    void listPeople().then((people) => {
      if (alive) setReviewPeople(people);
    }).catch(() => {
      // 姓名只是显示增强；读取失败退回账号，不能挡住检视主流程。
      if (alive) setReviewPeople([]);
    });
    return () => { alive = false; };
  }, [task.id]);

  useEffect(() => {
    if (!canRequestReview) return;
    let alive = true;
    void listCommitters().then((users) => {
      if (!alive) return;
      setCommitters(users);
      setReviewer((current) => current || users[0]?.username || "");
    }).catch((reason) => {
      if (alive) setReviewResult(reason instanceof Error
        ? reason.message : "Committer 名单读取失败");
    });
    return () => { alive = false; };
  }, [canRequestReview, task.id]);

  useEffect(() => {
    if (!canRequestReview) return;
    let alive = true;
    void listTaskReviews(task.id).then((reviews) => {
      if (alive) setTaskReviews(reviews);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [canRequestReview, task.id]);

  async function inviteReview() {
    if (!reviewer || reviewBusy) return;
    setReviewBusy(true); setReviewResult("");
    try {
      const result = await requestCommitterReview(task.id, reviewer);
      setReviewResult(result.delivered
        ? `已通知 ${reviewer}`
        : `未送达：${result.last_error || "通知服务暂无回执"}`);
      setTaskReviews((current) => [
        result,
        ...current.filter((item) => item.id !== result.id),
      ]);
    } catch (reason) {
      setReviewResult(reason instanceof Error ? reason.message : "邀请发送失败");
    } finally { setReviewBusy(false); }
  }

  async function finishReview() {
    if (!reviewAssignment || completeBusy) return;
    setCompleteBusy(true); setCompleteError("");
    try {
      await completeReview(reviewAssignment.id);
      await onChanged();
    } catch (reason) {
      setCompleteError(reason instanceof Error ? reason.message : "完成检视失败");
    } finally { setCompleteBusy(false); }
  }

  // 它在跑的时候材料是活的:界面上写着"材料会随进展刷新",那就得真刷。
  // 原来只在 task.id/status 变化时取一次,于是整段编码期页面一动不动,
  // 批注的"这处已被改动"也永远停在旧结论上。
  // 只在 running 时轮询,5 秒一次;拿到一样的内容就不 setState,免得
  // 正在写批注时被重渲染打断。
  useEffect(() => {
    if (task.status !== "running" && task.status !== "pausing") return;
    return startVisiblePolling(
      () => setLivePulse((tick) => tick + 1),
      5000,
      document,
      { runOnStart: false },
    );
  }, [task.status]);

  // 任务头实测高度写进 --ws-head-h(task-workspace.css 用它做 .ws-head 的
  // min-height 底线)。头高不是常量:标题换行、窄屏都会撑高,写死迟早出缝。
  // 原来还喂固定定位的检视抽屉,抽屉 2026-09-05 改成材料区内画布后只剩
  // 这一个消费者。ResizeObserver 缺席就退回默认值——旁路不该让人卡住。
  useEffect(() => {
    const head = headRef.current;
    const root = workspaceRoot.current;
    if (!head || !root) return;
    const publish = () => root.style.setProperty(
      "--ws-head-h", `${Math.round(head.getBoundingClientRect().height)}px`);
    publish();
    // 窄屏那档任务头是 66px 不是 70px(min-height 被媒体查询改小),差 4px
    // 就是抽屉和头之间一道背景缝。ResizeObserver 管标题换行这种"窗口没动
    // 头却变高"的情况,window.resize 兜住它不投递回调的场合(页面不渲染时
    // 观察器回调随帧一起停,实测过)——两条都只是重算一个数,重复无害。
    window.addEventListener("resize", publish);
    const observer = typeof ResizeObserver === "undefined"
      ? undefined : new ResizeObserver(publish);
    observer?.observe(head);
    return () => {
      window.removeEventListener("resize", publish);
      observer?.disconnect();
    };
  }, []);


  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (warmupOpen) { setWarmupOpen(false); return; }
      if (taskInspector) {
        if (!document.querySelector(".warmup-overlay")) setTaskInspector(undefined);
        return;
      }
      if (materialSearchOpen) {
        setMaterialSearchOpen(false);
        setMaterialSearchQuery("");
      } else if (reviewInviteOpen) setReviewInviteOpen(false);
      else if (reviewPanelOpen) setReviewPanelOpen(false);
      else if (materialsFullscreen) setMaterialsFullscreen(false);
      else onClose();
    };
    window.addEventListener("keydown", escape);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", escape);
      document.body.style.overflow = previous;
    };
  }, [taskInspector, warmupOpen, materialSearchOpen, materialsFullscreen, reviewInviteOpen,
    reviewPanelOpen, onClose]);

  // ⌥/Alt+R 在任何布局下切换批注 Inspector:按 code 不按
  // key——Mac 上 ⌥R 的 key 是 "®";焦点在输入框里不抢,输入法合成中不抢。
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
          || event.code !== "KeyR" || event.isComposing) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      setReviewPanelOpen((open) => !open);
    };
    window.addEventListener("keydown", toggle);
    return () => window.removeEventListener("keydown", toggle);
  }, []);

  // 熟练用户可以不离开键盘切换三块稳定画布；输入区与输入法合成期间
  // 永远不抢键。快捷键只改变呈现，不触碰任何任务状态。
  useEffect(() => {
    const switchView = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
          || event.isComposing || isEditableTarget(event.target)) return;
      const next = WORKSPACE_VIEW_SHORTCUTS[event.code];
      if (!next) return;
      event.preventDefault();
      selectWorkspaceView(next);
    };
    window.addEventListener("keydown", switchView);
    return () => window.removeEventListener("keydown", switchView);
  }, [workspaceView]);

  // 搜索范围就是当前渲染出来的这一份材料。普通文档取带 data-l 的最深
  // 正文行；两种差异视图取各自的真实内容行，删除行没有新行号也能搜到。
  useEffect(() => {
    for (const row of materialSearchRows.current) {
      row.classList.remove("material-search-hit", "material-search-current");
    }
    materialSearchRows.current = [];
    setMaterialSearchCount(0);
    setMaterialSearchIndex(-1);
    if (!materialSearchOpen || !materialSearchQuery.trim()
        || workspaceView === "execution" || materialView === "chain"
        || loading) return;
    const timer = window.setTimeout(() => {
      const root = workspaceRoot.current?.querySelector<HTMLElement>(".ws-doc");
      if (!root) return;
      const diffRows = root.querySelectorAll<HTMLElement>(
        ".diff-review-row, .requirement-diff-row");
      const rows = diffRows.length
        ? [...diffRows]
        : [...root.querySelectorAll<HTMLElement>("[data-l]")]
          .filter((row) => !row.querySelector("[data-l]"));
      const matches = matchingMaterialRowIndexes(rows, materialSearchQuery)
        .map((index) => rows[index]);
      materialSearchRows.current = matches;
      for (const row of matches) row.classList.add("material-search-hit");
      setMaterialSearchCount(matches.length);
      if (!matches.length) return;
      matches[0].classList.add("material-search-current");
      setMaterialSearchIndex(0);
      matches[0].scrollIntoView({ block: "center", behavior: "smooth" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [active, content, loading, materialSearchOpen, materialSearchQuery,
    materialView, revisionDiff, task.requirement, workspaceView]);

  function moveMaterialSearch(step: -1 | 1) {
    const rows = materialSearchRows.current;
    if (!rows.length) return;
    rows[materialSearchIndex]?.classList.remove("material-search-current");
    const next = materialSearchIndex < 0
      ? 0 : (materialSearchIndex + step + rows.length) % rows.length;
    rows[next].classList.add("material-search-current");
    rows[next].scrollIntoView({ block: "center", behavior: "smooth" });
    setMaterialSearchIndex(next);
  }

  function toggleMaterialSearch() {
    if (materialSearchOpen) {
      setMaterialSearchOpen(false);
      setMaterialSearchQuery("");
      return;
    }
    setMaterialSearchOpen(true);
    window.requestAnimationFrame(() => materialSearchInput.current?.focus());
  }

  // 产物列表按最近修改倒序(服务端排好),默认打开第一份——
  // "哪一步该看哪个文件"是内核语义,前端不复刻,只用修改时间定位。
  useEffect(() => {
    let alive = true;
    void listArtifacts(task.id).then((result) => {
      if (!alive) return;
      setUnavailable(result.unavailable ?? "");
      setItems(result.items);
      // 列表可能随任务轮询/状态切换重新读取。默认项只用于首次进入；
      // 用户已经切到代码改动时绝不能被后台刷新拽回最近文档。
      const evidenceKey = pipelineEvidenceNeedsHuman(task)
        ? `${task.id}:${task.delivery?.evidence_gap?.sha ?? ""}` : "";
      const newlyActionable = Boolean(evidenceKey
        && openedEvidenceGap.current !== evidenceKey);
      const current = artifactTask.current === task.id && !newlyActionable
        ? active : "";
      const next = preferredWorkspaceArtifact(
        result.items ?? [], current, recommendedMaterialView,
        pipelineEvidenceNeedsHuman(task));
      artifactTask.current = task.id;
      openedEvidenceGap.current = evidenceKey;
      setActive(next);
      if (next !== current && ["pipeline_evidence_gap", "delivery_unit_brief",
        "delivery_plan"].includes(result.items?.find((item) => item.name === next)
          ?.purpose ?? "")) {
        setMaterialView("doc");
      }
    });
    return () => { alive = false; };
  }, [task.id, livePulse, task.delivery?.evidence_gap?.state,
    task.delivery?.evidence_gap?.sha, recommendedMaterialView]);

  const activeArtifactForRead = items?.find((item) => item.name === active);
  const activeChangeFiles = activeArtifactForRead?.change_files;
  const activeUntrackedDirectories =
    activeArtifactForRead?.untracked_directories ?? [];
  const activeUntrackedDirectoryKey = activeUntrackedDirectories
    .map((directory) => directory.path).join("\0");
  const selectedFromUntrackedDirectory = activeUntrackedDirectories.some(
    (directory) => selectedDiffPath.startsWith(`${directory.path}/`));
  const requestedDiffPath = activeChangeFiles?.some((file) =>
    file.path === selectedDiffPath) || selectedFromUntrackedDirectory
    ? selectedDiffPath
    : activeChangeFiles?.[0]?.path ?? "";

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setLoading((was) => was || !content);
    const pushDiffActive = Boolean(pushReview
      && items?.find((item) => item.name === active)?.kind === "diff");
    const lazyWorkspaceDiff = !pushDiffActive
      && activeArtifactForRead?.kind === "diff"
      && Boolean(requestedDiffPath);
    setDiffFileLoading(lazyWorkspaceDiff);
    setDiffFileError("");
    if (pushDiffActive) setPushDiffState({ kind: "checking" });
    const directoryOnlyWorkspaceDiff = !pushDiffActive
      && activeArtifactForRead?.kind === "diff"
      && !requestedDiffPath
      && activeUntrackedDirectories.length > 0;
    const reading = pushDiffActive
      ? readPushReviewDiff(task.id, diffScope)
      : lazyWorkspaceDiff
        ? readArtifactFileDiff(task.id, requestedDiffPath)
        : directoryOnlyWorkspaceDiff
          ? Promise.resolve({
              content: "未跟踪目录已折叠；展开目录后再按需读取文件。",
              branch: undefined,
              unavailable: undefined,
            })
        : readArtifact(task.id, active);
    void reading.then((result) => {
      if (!alive) return;
      if (pushDiffActive) {
        const normalized = normalizePushReviewDiffResult(result);
        setPushDiffState(normalized.state);
        setContent((current) => current === normalized.content
          ? current : normalized.content);
        setBranch(normalized.branch);
        setLoading(false);
        setDiffFileLoading(false);
        return;
      }
      const next = result.content ?? result.unavailable ?? "";
      // 内容没变就别 setState:轮询期间无谓重渲染会把正在写的批注打断。
      setContent((current) => current === next ? current : next);
      setBranch(result.branch ?? "");
      setDiffFileError(lazyWorkspaceDiff ? result.unavailable ?? "" : "");
      setLoading(false);
      setDiffFileLoading(false);
    }).catch((reason) => {
      if (!alive) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      if (pushDiffActive) {
        setPushDiffState({ kind: "error", message, expired: false });
        setContent("");
        setBranch("");
      } else {
        setContent(message);
        setBranch("");
        if (lazyWorkspaceDiff) setDiffFileError(message);
      }
      setLoading(false);
      setDiffFileLoading(false);
    });
    return () => { alive = false; };
  }, [task.id, active, livePulse, diffScope, pushReview?.head_sha,
    activeArtifactForRead?.kind, requestedDiffPath,
    activeUntrackedDirectoryKey]);

  // 批注随任务加载,也随"圈了一条/送出一批/任务状态变了"重取——
  // 进展(那处动没动)和闭环结论都是服务端现算的,前端不自己推断。
  // 结论的输入还有当前卡和复检标记:两张人工卡背靠背换、status 不变时,
  // 只盯 status 会让结论停在上一张卡上(收敛后才有的时序,原来前端按
  // props 现推没这个问题),所以卡版本与复检标记也要触发重取。
  useEffect(() => {
    let alive = true;
    void listAnnotations(task.id).then((result) => {
      if (!alive) return;
      setNotes(result.items);
      setChecks(result.checks);
      setClosures(result.closures);
      setReply(result.reply);
    });
    return () => { alive = false; };
  }, [task.id, task.status, task.waiting?.state_version,
    task.delivery?.loop?.workspace_review_recheck_required,
    notesPulse, livePulse]);

  const requirementAnalysisConfirmation = task.status === "waiting_for_human"
    && task.waiting?.step === "cloud_requirement_analysis_confirm";
  // 决定卡只展示会阻塞团队流转的事实：已送达意见，以及责任人自己的
  // 未送达草稿。需求确认是多人共同检视，已经留下的任何草稿都必须先
  // 处理，不能被主责任人的确认按钮越过。
  const unresolvedNotes = notes.filter((item) =>
    item.status === "sent" || (item.status === "draft"
      && (requirementAnalysisConfirmation
        || !task.luban_account || item.author === task.luban_account)));
  // sent 仍是“未闭环”，要继续展示并阻止误放行；但它已经主动送给
  // Agent，不能再冒充本次决定要附带的草稿。两组 ID 混用会让决定接口
  // 按 draft 校验时拒绝整次提交，连人刚写的补充说明也一起被挡住。
  const draftIds = decisionAnnotationIds(notes, viewerUsername);

  /** 回到被圈的那一行:换页签→等它渲染出来→滚过去并闪一下。
   * 改批注前人几乎总要再看一眼上下文,只报"第 23 行"等于让他自己找。
   * 等待有预算(2 秒封顶),找不到就算了——旁路不许把界面卡住。 */
  function locate(item: Annotation) {
    setWorkspaceView("materials");
    const source = item.artifact === TASK_REQUIREMENT_ARTIFACT;
    const targetArtifact = item.artifact === "__workspace_diff__"
      ? items?.find((artifact) => artifact.kind === "diff")?.name : item.artifact;
    if (!source && targetArtifact && targetArtifact !== active) setActive(targetArtifact);
    const targetView = materialViewForAnnotation(item.artifact, items);
    setMaterialView(targetView);
    if (targetView === "diff" && item.file) setSelectedDiffPath(item.file);
    const check = checks.find((candidate) => candidate.id === item.id);
    const currentLine = check?.line ?? item.line;
    if (check?.state === "gone") {
      setLocationNotice(
        `“${item.anchor.slice(0, 46)}${item.anchor.length > 46 ? "…" : ""}”`
        + " 已不在当前版本；左侧已打开最新材料，请结合差异和 Agent 回应核对。",
      );
    } else if (check?.state === "ambiguous") {
      setLocationNotice("这段原文在当前材料中出现多次，已打开对应材料，请结合文件路径核对。");
    } else {
      setLocationNotice("");
    }
    let tries = 0;
    const seek = () => {
      const node = document.querySelector<HTMLElement>(
        `.ws-doc [data-l="${currentLine}"]`);
      if (!node) {
        if (tries++ < 20) {
          window.setTimeout(seek, 100);
        } else if (check?.state !== "gone") {
          setLocationNotice(
            `已打开 ${item.file}，但原第 ${item.line} 行已无法直接定位；请在当前材料中核对。`,
          );
        }
        return;
      }
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      node.classList.add("annot-flash");
      window.setTimeout(() => node.classList.remove("annot-flash"), 1700);
    };
    window.setTimeout(seek, source || item.artifact === active ? 0 : 120);
  }
  const activeMeta = items?.find((item) => item.name === active);
  const materialPriority = (item: ArtifactMeta): number =>
    item.purpose === "delivery_unit_brief" ? 0
      : item.purpose === "delivery_plan" ? 1 : 2;
  const documents = (items?.filter((item) => item.kind === "doc") ?? [])
    .sort((left, right) => materialPriority(left) - materialPriority(right));
  const primaryDocument = task.parent_task_id
    ? documents.find((item) => item.purpose === "delivery_unit_brief")
      ?? documents[0]
    : documents[0];
  const changes = items?.filter((item) => item.kind === "diff") ?? [];
  const evidenceGapArtifact = documents.find((item) =>
    item.purpose === "pipeline_evidence_gap");
  const evidenceGapActionable = pipelineEvidenceNeedsHuman(task);

  async function downloadDocuments() {
    if (!documents.length || documentsDownloading) return;
    setDocumentsDownloading(true);
    setDocumentsDownloadError("");
    try {
      const response = await fetch(
        `/tasks/${encodeURIComponent(task.id)}/artifacts/archive`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        throw new Error(String(body.error ?? `打包下载失败(${response.status})`));
      }
      const blobUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = `${task.id}-产出文档-`
        + `${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    } catch (reason) {
      setDocumentsDownloadError(
        String(reason instanceof Error ? reason.message : reason));
    } finally {
      setDocumentsDownloading(false);
    }
  }

  // 服务端只生成一份聚合 diff，因此 changes.length 几乎永远是 1，
  // 它表示“产物份数”而不是用户关心的“变更文件数”。旧服务尚未提供
  // file_count 时保留原回退，避免滚动升级期间把入口误判为空。
  const changeCountKnown = changes.every((item) =>
    typeof item.file_count === "number");
  const changeFileCount = changeCountKnown
    ? changes.reduce((sum, item) => sum + (item.file_count ?? 0), 0)
    : changes.length;
  const untrackedDirectoryCount = changes.reduce((sum, item) =>
    sum + (item.untracked_directories?.length ?? 0), 0);
  // 与 RequirementGraph 组件同一个判定:页签露出而组件返回 null 就是空白面板。
  const hasRequirementGraph = requirementGraphVisible(task);
  const materialHeading = materialView === "source"
    ? { kicker: "REQUEST SOURCE", title: "需求原文" }
    : materialView === "chain"
    ? { kicker: "DELIVERY PLAN", title: "模块拆分与依赖" }
    : materialView === "diff"
      ? pushReview
        ? { kicker: "PUSH REVIEW", title: diffScope === "changes"
            ? pushReview.title : "完整交付内容" }
        : { kicker: "WORKTREE CHANGES", title: "代码改动" }
      : activeMeta?.purpose === "delivery_unit_brief"
        ? { kicker: "CURRENT DELIVERY UNIT", title: "当前单元任务书" }
        : activeMeta?.purpose === "delivery_plan"
          ? { kicker: "REVIEWED DELIVERY PLAN", title: "整体拆分方案" }
          : { kicker: "WORK DOCUMENTS", title: "产出文档" };
  const waiting = task.status === "waiting_for_human" && task.waiting;
  const workspaceReviewReady = task.status === "waiting_for_human"
    && task.waiting?.step === "cloud_push_confirm"
    && task.delivery?.loop?.review_source === "workspace"
    && task.delivery.loop.workspace_review_recheck_required === true;
  const workspaceReviewAnnotationIds = workspaceReviewReady
    ? task.delivery?.loop?.workspace_review_annotation_ids ?? []
    : [];
  // 检视意见里除了工作台批注,还列 CodeHub 检视意见与机器检视结果。
  // 工作台来源的反馈已经以批注卡片的身份在场(带作者裁决权),不重复列。
  const codehubFeedback = (task.feedback ?? [])
    .filter((item) => item.source === "mr_discussion");
  const machineFeedback = (task.feedback ?? [])
    .filter((item) => item.source !== "mr_discussion" && item.source !== "workspace");
  const reviewRecordCount = notes.length + codehubFeedback.length
    + machineFeedback.length;
  // 抽屉顶部筛选条:三节共用一套档位。批注按作者/裁决就绪归档,反馈按
  // 状态归档(needs_human 压在人这;closed 已闭环;其余在 Agent 或门禁手里)。
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  // 服务端已经把移动过的原文重锚到当前行。材料标记必须使用这个当前
  // 行号；原文已删除则不在别的内容上制造一个同号假标记。
  const locatableNotes = notes.flatMap((item) => {
    if (item.status === "dropped") return [];
    const check = checks.find((candidate) => candidate.id === item.id);
    if (check?.state === "gone") return [];
    return [{ ...item, line: check?.line ?? item.line }];
  });
  const openAnnotationReview = (ids: string[]) => {
    if (!ids.length) return;
    reviewFocusRequest.current += 1;
    setReviewFilter("all");
    setReviewFocus({ ids, request: reviewFocusRequest.current });
    setReviewPanelOpen(true);
  };
  const feedbackCategory = (item: FeedbackRecord): Exclude<ReviewFilter, "all"> =>
    item.status === "closed" ? "closed"
      : item.status === "needs_human" ? "mine" : "agent";
  // 归档也照服务端结论:页面不再按 status/sent_via 自己分档。
  const closureOf = (id: string) => closures.find((one) => one.id === id);
  const noteCategory = (item: Annotation): Exclude<ReviewFilter, "all"> =>
    closureOf(item.id)?.bucket ?? "agent";
  const reviewCounts = { all: reviewRecordCount, mine: 0, agent: 0, closed: 0 };
  for (const item of notes) reviewCounts[noteCategory(item)] += 1;
  for (const item of [...codehubFeedback, ...machineFeedback]) {
    reviewCounts[feedbackCategory(item)] += 1;
  }
  const filteredCodehub = reviewFilter === "all" ? codehubFeedback
    : codehubFeedback.filter((item) => feedbackCategory(item) === reviewFilter);
  const filteredMachine = reviewFilter === "all" ? machineFeedback
    : machineFeedback.filter((item) => feedbackCategory(item) === reviewFilter);
  /** CodeHub 意见转成工作台批注草稿:锚点用意见编号(平台不给原文快照),
   * 定位靠文件行号;正文带上出处,人可以再补一句自己的话。 */
  async function convertFeedbackToAnnotation(
    item: FeedbackRecord,
  ): Promise<string | undefined> {
    const materials = items ?? [];
    const diffArtifact = materials.find((artifact) => artifact.kind === "diff")?.name;
    const artifact = materials.find((artifact) => artifact.name === item.file)?.name
      ?? diffArtifact ?? item.file ?? materials[0]?.name;
    if (!artifact) return "当前任务还没有可批注的材料，暂时转不成批注。";
    const origin = `CodeHub 检视意见 #${item.source_id}${
      item.author ? `（${item.author}）` : ""}`;
    const result = await addAnnotation(task.id, {
      artifact,
      file: item.file ?? artifact,
      line: item.line ?? 0,
      anchor: origin,
      note: `【转自 ${origin}】\n${item.summary}`,
      kind: "code",
    });
    if (result.error) return `转成批注失败：${result.error}`;
    setNotesPulse((tick) => tick + 1);
    onChanged();
    return undefined;
  }
  useEffect(() => {
    if (reviewPanelOpen) {
      const feedback = workspaceRoot.current?.querySelector<HTMLElement>("#ws-review-canvas");

      feedback?.focus({ preventScroll: true });
    }
  }, [reviewPanelOpen, materialsFullscreen, reviewFocus?.request, reviewRevealRequest]);

  const nextAction = workspaceNextActionCopy(task, Boolean(waiting));
  const decisionDeliverySelection = usablePushReviewSelection(
    Boolean(pushReview),
    pushDiffState,
    deliverySelection,
  );
  const canContributeReview = canOperate || canCollaborate || !!reviewAssignment;
  const canCreateAnnotation = canCreateWorkspaceAnnotation(task.status);
  const annotationQueueWithDecision = task.status === "waiting_for_human"
    && !requirementAnalysisConfirmation
    && !(task.delivery?.mr_url
      && task.delivery.mr_state !== "已关闭"
      && !String(task.delivery.mr_state ?? "").startsWith("已合入"));
  const annotationCanSend = canContributeReview
    && (task.status === "running" || task.status === "waiting_for_human"
      || Boolean(task.delivery?.evidence_gap?.missing_dimensions.length)
      || (Boolean(task.delivery?.mr_url)
        && task.delivery?.mr_state !== "已关闭"
        && !String(task.delivery?.mr_state ?? "").startsWith("已合入")
        && ["queued", "verifying", "await_merge", "failed"].includes(task.status)));
  // 多仓分析过程中的普通澄清也处于 analysis；分工只应在最终 Chain 方案
  // 检视卡出现。判据和卡片标题共用 isChainReviewWaiting,别两处各抄一份。
  const chainReview = !!waiting && isChainReviewWaiting(task);
  // 受邀参与讨论的人在分析期能答卡(2026-09-04 用户拍板:邀请了就得能
  // 回答);拍板类卡只认责任人。服务端 decide 是同一口径的硬闸。
  // 澄清卡问的是意见作者:被追问的人即使不是责任人也能答(服务端同口径)。
  const clarificationRespondent = !!waiting && isClarificationWaiting(task)
    && notes.some((item) => item.author === viewerUsername
      && (task.waiting?.question?.annotation_ids ?? []).includes(item.id));
  const decides = canOperate
    || (canCollaborate && !isOwnerOnlyWaiting(task))
    || clarificationRespondent;
  // 检视卡上的返工选项,交给批注面板做"提交并返工"一步到位。
  const reworkChoiceRaw = waiting ? reworkChoiceOf(task) : undefined;
  const workspaceReworkChoice = reworkChoiceRaw && task.waiting
    ? { ...reworkChoiceRaw, waitingId: task.waiting.waiting_id,
        stateVersion: task.waiting.state_version }
    : undefined;
  const controllable = canOperate && [
    "queued", "running", "pausing", "paused", "waiting_for_human", "verifying",
    "await_merge",
  ].includes(task.status);
  const deletable = canOperate && ["completed", "failed", "canceled"]
    .includes(task.status);
  const health = taskHealthFacts(task, viewerUsername);
  const visibleProgress = workspaceProgress(task);
  const pauseFeedback = task.status === "pausing"
    ? {
        state: "pending",
        title: "正在安全暂停",
        detail: task.detail
          || "系统正在结束当前操作并保存现场；完成后会自动变为“已暂停”，无需重复点击。",
      }
    : controlBusy === "pause"
        ? {
            state: "pending",
            title: "暂停请求已提交",
            detail: "正在登记暂停请求，随后会结束当前操作并保存现场。",
          }
        : undefined;

  async function runControl(action: "pause" | "resume" | "cancel") {
    if (controlBusy) return;
    setControlBusy(action);
    setControlError("");
    try {
      const result = await controlTask(task.id, action);
      if (result.error) setControlError(result.error);
      else {
        setCancelArmed(false);
        await onChanged();
      }
    } catch (reason) {
      setControlError(reason instanceof Error
        ? reason.message : `${action === "pause" ? "暂停" : action === "resume"
          ? "恢复" : "取消"}请求失败，请重试`);
    } finally {
      setControlBusy("");
    }
  }

  async function deleteTask() {
    if (controlBusy) return;
    setControlBusy("delete");
    setControlError("");
    try {
      const result = await deleteHistoryTask(task.id);
      if (result.error) setControlError(result.error);
      else {
        await onChanged();
        onClose();
      }
    } catch (reason) {
      setControlError(reason instanceof Error
        ? reason.message : "删除任务失败，请重试");
    } finally {
      setControlBusy("");
    }
  }

  const streamPeople = [
    ...(viewerDisplayName ? [{ username: viewerUsername, display_name: viewerDisplayName }] : []),
    ...reviewPeople.filter((person) => person.username !== viewerUsername),
  ];
  // 非决定态的收口块:失败原因与重跑、验证中卡在哪、等合入、子任务清单。
  // 它们是流的"最后一条",不是第二个面板。
  const streamTailVisible = Boolean(task.delivery?.scope_violation)
    || ["failed", "canceled"].includes(task.status)
    || (!waiting && ["await_merge", "verifying", "coordinating"].includes(task.status))
    || Boolean(task.parent_task_id);
  const streamTail = streamTailVisible ? (
    <>
      {task.delivery?.scope_violation && (
        <ScopeViolationCard task={task} onChanged={onChanged} />
      )}
      {task.status === "failed" && (
        <>
          {task.detail && (
            <div className="alert">
              <strong>任务执行失败</strong>
              <span>{task.detail}</span>
            </div>
          )}
          {canOperate && !waiting && (
            <div className="ws-failed-actions">
              <RetryButton taskId={task.id} onDone={onChanged} allowFromStart />
              <DiagnosticsLink taskId={task.id} />
            </div>
          )}
        </>
      )}
      {task.status === "canceled" && (
        <div className="task-canceled-note">
          <strong>任务已取消</strong>
          <span>执行已停止；此前产生的文档、代码和过程记录仍可查看。</span>
          {canOperate && <RetryButton taskId={task.id} onDone={onChanged} allowFromStart />}
        </div>
      )}
      {!waiting && task.status === "await_merge" && (
        <MergeWaitLine task={task} canOperate={canOperate} />
      )}
      {!waiting && task.status === "verifying" && (
        <div className="ws-verify-focus">
          <strong>交付验证进行中</strong>
          {task.delivery?.waiting_on ? (
            <p className="ws-verify-focus-waiting">{task.delivery.waiting_on}</p>
          ) : (
            <p>{task.detail || "流水线运行与自动修复由系统跟进；需要人时会在这里出卡。"}</p>
          )}
          {canOperate && repairStopped(task) && (
            <RetryButton taskId={task.id} onDone={onChanged}
              label={task.delivery?.stalled && !task.delivery?.loop
                  && !task.delivery?.evidence_gap
                ? "重新尝试交付" : undefined} />
          )}
          {task.delivery?.stalled && <DiagnosticsLink taskId={task.id} />}
        </div>
      )}
      {!waiting && task.status === "coordinating" && (
        <div className="ws-child-focus">
          <strong>{task.focus?.needs_attention ? "有子任务需要处理" : "子任务正在推进"}</strong>
          <p>{task.detail ?? "全部子任务完成后，主任务会自动完成。"}</p>
          <div>{task.requirement_graph?.repositories.map((repository) => (
            <button type="button" key={repository.id}
              disabled={!repository.task_id || !onOpenTask}
              onClick={() => repository.task_id && onOpenTask?.(repository.task_id)}>
              <span><strong>{repository.name}</strong>
                <small>{repository.assignee ?? "未指定负责人"}</small></span>
              <em className={repository.task_status ?? "queued"}>
                {statusText({ status: repository.task_status ?? "queued" })}
              </em>
            </button>
          ))}</div>
        </div>
      )}
    </>
  ) : undefined;

  const renderAnnotations = (selectedNotes: Annotation[], inline = false) => (
        <AnnotationPanel
          taskId={task.id}
          viewerUsername={viewerUsername}
          items={selectedNotes}
          checks={checks}
          closures={closures}
          reply={inline ? undefined : reply}
          canOperate={canContributeReview}
          taskStatus={task.status}
          reviewReady={workspaceReviewReady}
          reviewAnnotationIds={workspaceReviewAnnotationIds}
          requirementReview={requirementAnalysisConfirmation}
          requirementRevisionRunning={task.requirement_revision?.state === "running"}
          mergeRequestOpen={Boolean(task.delivery?.mr_url)
            && !["completed", "canceled"].includes(task.status)
            && !String(task.delivery?.mr_state ?? "").startsWith("已合入")
            && task.delivery?.mr_state !== "已关闭"}
          evidenceAwaiting={Boolean(
            task.delivery?.evidence_gap?.missing_dimensions.length)}
          filter={inline ? "all" : reviewFilter}
          focus={inline ? undefined : reviewFocus}
          people={[
            ...(viewerDisplayName ? [{
              username: viewerUsername, display_name: viewerDisplayName,
            }] : []),
            ...reviewPeople.filter((person) => person.username !== viewerUsername),
          ]}
          reworkChoice={materialsFullscreen && !inline ? workspaceReworkChoice : undefined}
          canDecide={materialsFullscreen && !inline && canOperate}
          onLocate={locate}
          onShowThread={showThread}
          onChanged={() => { setNotesPulse((tick) => tick + 1); onChanged(); }}
        />
  );

  const reviewWorkspaceContent = (
    <div className="workspace-review-notes">
      {reviewRecordCount > 0 && <div className="review-filter" role="tablist" aria-label="按处理归属筛选">
        {([
          ["all", "全部"],
          ["mine", "等我确认"],
          ["agent", "Agent 处理中"],
          ["closed", "已完成"],
        ] as const).map(([key, label]) => (
          <button type="button" key={key} role="tab"
            className={`${reviewFilter === key ? "active" : ""}${
              key === "mine" && reviewCounts.mine > 0 ? " attention" : ""}`}
            aria-selected={reviewFilter === key}
            onClick={() => setReviewFilter(key)}>
            {label}<i>{reviewCounts[key]}</i>
          </button>
        ))}
      </div>}
      {reviewAssignment && (
        <section className="review-assignment" aria-labelledby="review-assignment-title">
          <div className="review-assignment-mark" aria-hidden>审</div>
          <div>
            <span>COMMITTER REVIEW</span>
            <strong id="review-assignment-title">
              {reviewPeople.find((person) =>
                person.username === reviewAssignment.requester)
                ?.display_name ?? reviewAssignment.requester} 邀请你检视
            </strong>
            <p>看完材料并留下必要批注后即可完成；这不会代替任务责任人提交决定。</p>
            {completeError && <small className="review-assignment-error">
              {completeError}
            </small>}
          </div>
          <button type="button" disabled={completeBusy}
            onClick={() => void finishReview()}>
            {completeBusy ? "正在完成…" : "完成检视"}
          </button>
        </section>
      )}
      <section className="workspace-review-opinions" aria-label="检视意见">
        {renderAnnotations(notes)}
        {!notes.length && (
          <div className="ws-insight-empty">
            在原文、产出文档或代码上圈选，即可原位写下反馈。
          </div>
        )}
        {filteredCodehub.length > 0 && <FeedbackList
          kicker="CODEHUB REVIEW"
          title="来自 CodeHub 的检视意见"
          hint="MR 检视人在 CodeHub 留下的讨论。Agent 逐条修改或说明后把回复发回 MR，由检视人在 MR 里确认闭环。"
          items={filteredCodehub}
          mrUrl={task.delivery?.mr_url}
          onConvert={canContributeReview && canCreateAnnotation
            ? convertFeedbackToAnnotation : undefined} />}
        {filteredMachine.length > 0 && <FeedbackList
          kicker="AUTOMATED GATES"
          title="来自流水线与机器门禁的告警"
          hint="流水线红灯、Build-Fix、合并冲突、推送前复检等不是人提的意见，由对应机器门禁核验；内核判定通过即闭环。"
          items={filteredMachine} />}
      </section>
    </div>
  );

  return (
    <main
      className={`workspace-overlay task-workspace-v2 workspace-studio${materialsFullscreen
        ? " materials-fullscreen" : ""}`}
      ref={workspaceRoot}
      aria-label={`任务工作台：${task.title ?? task.requirement}`}
      style={sideWidth ? { ["--ws-side-w" as string]: `${sideWidth}px` } as CSSProperties : undefined}
    >
      <header className="ws-head" ref={headRef}>
        <button type="button" className="ws-back" aria-label="返回列表"
          onClick={onClose} autoFocus>
          <svg viewBox="0 0 20 20" aria-hidden><path d="m12.5 5-5 5 5 5" /></svg>
          <span>返回列表</span>
        </button>
        <div className="ws-identity">
          {task.ticket && <span className="ws-business-id">{task.ticket}</span>}
          <strong id="task-workspace-title" title={task.title ?? task.requirement}>
            {task.title ?? task.requirement}
          </strong>
          <div className="ws-identity-line">
            <code title="平台内部编号">{task.id}</code>
            <span className={`pill ${task.status}`}>
              <i aria-hidden />{statusText(task)}
            </span>
            <button type="button" className="ws-task-details-trigger" aria-haspopup="dialog"
              onClick={() => setTaskInspector("details")}>任务详情 <span aria-hidden>↗</span></button>
            <WaitBadge task={task} personal={canOperate} />
            <PrepushBadge task={task} canOperate={canOperate}
              onChanged={onChanged} />
          </div>
          {task.parent_task_id && <button type="button" className="ws-parent-task"
            onClick={() => onOpenTask?.(task.parent_task_id!)}>
            <span>返回主任务</span>
            <strong>{task.parent_task?.title ?? "跨仓大任务"}</strong>
            <code>{task.parent_task?.ticket ?? task.parent_task_id}</code>
          </button>}
        </div>
        <div className={`ws-progress${task.progress ? "" : " is-fallback"}`
          + `${health?.needs_attention ? " attention" : ""}`
          + `${task.status === "completed" ? " is-done" : task.status === "failed" ? " is-failed" : ""}`}>
          {/* 阶段名可点:当前阶段弹内核编译的活方案,其他阶段弹标准
              方案底版(用户拍板:方案入口收进进度条,执行页签让位给
              SSE 现场)。需求受理/DTS 等云端词表任务的阶段名与内核
              六阶段完全不同,弹出来必然落底版兜底属误导(审计 P0-3)
              ——这些任务不提供弹层。 */}
          {/* 刻度旁只放阶段名:步骤说明已经是主画布的标题,这里再写一遍
              会把 44px 的视图条撑成一行长文。 */}
          <TaskProgress progress={visibleProgress} showDetailedStep={false} status={task.status}
            preparation={<WarmupBadge task={task} onOpen={() => setWarmupOpen(true)} />}
            onPhaseClick={task.execution_plan || task.workflow_profile
              ? setPlanPhase : undefined}
            context={health && <>
            <span title={health.next}><i>下一步</i>{health.next}</span>
            <span><i>责任</i>{health.actor}</span>
            <span title={health.last_progress_at}><i>更新</i>
              {relativeTime(health.last_progress_at) || "暂无记录"}</span>
          </>} />
          {planPhase && <StagePlanDialog
            phase={planPhase}
            currentPhase={visibleProgress.current_phase}
            plan={task.execution_plan}
            planWarning={task.workflow_profile_warning}
            profile={task.workflow_profile}
            onSuggest={onExecutionPlanFeedback}
            onClose={() => setPlanPhase("")} />}
        </div>
        {(controllable || deletable || canRequestReview || onOpenFeedbackWall) && (
          <div className="ws-head-controls" aria-label="任务控制">
            {canRequestReview && <button type="button" className="workspace-review-invite-button"
              aria-haspopup="dialog" aria-expanded={reviewInviteOpen}
              title="选择 Committer 参与代码检视"
              onClick={() => setReviewInviteOpen(true)}>邀请他人检视</button>}
            {onOpenFeedbackWall && <QuickWishButton inline onOpenWall={onOpenFeedbackWall} />}
            {controllable && (task.status === "await_merge" ? null : task.status === "paused" ? (
              <button type="button" className="primary" disabled={!!controlBusy}
                title="沿用当前工作区和流程进度继续执行"
                onClick={() => void runControl("resume")}>
                {controlBusy === "resume" ? "恢复中…" : "恢复"}
              </button>
            ) : task.status === "pausing" ? (
              <button type="button" disabled title="当前操作结束后自动暂停">
                正在暂停
              </button>
            ) : (
              <button type="button" disabled={!!controlBusy}
                title={task.status === "verifying"
                  ? "停止平台跟踪；外部流水线仍会继续" : "当前操作结束后安全暂停"}
                onClick={() => void runControl("pause")}>
                {controlBusy === "pause" ? "暂停中…" : "暂停"}
              </button>
            ))}
            {controllable && (!cancelArmed ? (
              <button type="button" className="cancel" disabled={!!controlBusy}
                title="取消后不可恢复，已有文件和记录仍会保留"
                onClick={() => setCancelArmed(true)}>取消</button>
            ) : (
              <div className="ws-cancel-confirm">
                <span>取消后不可恢复</span>
                <button type="button" disabled={!!controlBusy}
                  onClick={() => void runControl("cancel")}>
                  {controlBusy === "cancel" ? "取消中…" : "确认"}
                </button>
                <button type="button" disabled={!!controlBusy}
                  onClick={() => setCancelArmed(false)}>返回</button>
              </div>
            ))}
            {deletable && (!deleteArmed ? (
              <button type="button" className="delete" disabled={!!controlBusy}
                title="永久删除工作区、事件、批注与历史记录"
                onClick={() => setDeleteArmed(true)}>删除任务</button>
            ) : (
              <div className="ws-delete-confirm">
                <span>工作区和记录将永久删除</span>
                <button type="button" disabled={!!controlBusy}
                  onClick={() => void deleteTask()}>
                  {controlBusy === "delete" ? "删除中…" : "确认删除"}
                </button>
                <button type="button" disabled={!!controlBusy}
                  onClick={() => setDeleteArmed(false)}>返回</button>
              </div>
            ))}
          </div>
        )}
      </header>

      {taskInspector && <TaskInspector task={task} kind={taskInspector} onClose={() => setTaskInspector(undefined)}
        onInspect={setTaskInspector} onOpenProcess={() => { setTaskInspector(undefined); selectWorkspaceView("execution"); }} />}
      {warmupOpen && <OverlayDialog ariaLabel="开工前编译详情" title="开工前编译与准备状态" onClose={() => setWarmupOpen(false)}>
        <WarmupPanel task={task} />
      </OverlayDialog>}

      {task.feedback_error && (
        <section className="feedback-panel feedback-panel-error" role="alert">
          <h3>持续检视明细暂不可用</h3>
          <p>{task.feedback_error}</p>
        </section>
      )}
      {/* 主区两栏(参照 Devin / Codex / Jules 的会话页):左边是"对话与决定"
          ——状态、决定卡、给 Agent 的输入框;右边是"工作区"——需求、文档、
          代码、活动的页签阅读器,批注检查器停靠在它右缘。上两版的左导航、
          三视图页签、"决定前建议核对"预览都是中间层,用户实锤"都是些啥,
          平铺在这""力度不够",这次去掉。 */}
      <div className="ws-body" ref={bodyRef}>
        <section className="ws-evidence" aria-label="工作区">
          <div className="ws-pane-head" aria-label="任务工作台视图">
            <div>
              <strong>{materialHeading.title}</strong>
            </div>
            <div className="ws-material-toolbar">
              <div className="ws-source-switch" role="tablist" aria-label="工作区内容">
                {task.parent_task_id ? <>
                  {/* 子任务的文档树里任务书只是默认选中的第一份(还有整体拆分方案、
                      spec/decisions/grill……),页签名得说整体,不能拿其中一项当名字
                      (2026-09-06 实战用户实锤"这里不应该叫当前任务书")。 */}
                  <button type="button" role="tab" aria-selected={materialTabOn("doc")} className={materialTabOn("doc") ? "on" : ""}
                    onClick={() => { openMaterial("doc"); if (primaryDocument) setActive(primaryDocument.name); }}>
                    <span>文档</span><i>{documents.length}</i>
                  </button>
                  <button type="button" role="tab" aria-selected={materialTabOn("source")} className={materialTabOn("source") ? "on" : ""}
                    onClick={() => openMaterial("source")}>
                    <span>原始需求</span>
                  </button>
                </> : <>
                  <button type="button" role="tab" aria-selected={materialTabOn("source")} className={materialTabOn("source") ? "on" : ""}
                    onClick={() => openMaterial("source")}>
                    <span>需求原文</span>
                  </button>
                  <button type="button" role="tab" aria-selected={materialTabOn("doc")} className={materialTabOn("doc") ? "on" : ""}
                    onClick={() => { openMaterial("doc"); if (documents[0]) setActive(documents[0].name); }}>
                    <span>产出文档</span><i>{documents.length}</i>
                  </button>
                </>}
                {hasRequirementGraph && <button type="button" role="tab" aria-selected={materialTabOn("chain")} className={materialTabOn("chain") ? "on" : ""}
                  onClick={() => openMaterial("chain")}>
                  <span>模块与依赖</span><i>{task.requirement_graph!.projection_state === "ready"
                    || task.requirement_graph!.stage === "confirmed"
                    ? task.requirement_graph!.repositories.length : "…"}</i>
                </button>}
                <button type="button" role="tab" aria-selected={materialTabOn("diff")}
                  className={materialTabOn("diff") ? "on" : ""}
                  title={untrackedDirectoryCount
                    ? `${changeFileCount} 个文件，另有 ${untrackedDirectoryCount} 个未跟踪目录`
                    : `${changeFileCount} 个文件`}
                  onClick={() => { openMaterial("diff"); if (changes[0]) setActive(changes[0].name); }}
                  disabled={!changeFileCount && !untrackedDirectoryCount}>
                  <span>代码改动</span>{Boolean(changeFileCount || untrackedDirectoryCount) && <i>{changeFileCount}{untrackedDirectoryCount
                    ? ` + ${untrackedDirectoryCount}目录` : ""}</i>}
                </button>
                <button type="button" role="tab" className={workspaceView === "knowledge" ? "on" : ""}
                  aria-selected={workspaceView === "knowledge"} onClick={() => selectWorkspaceView("knowledge")}>
                  <span>用到的知识</span>{Boolean(task.knowledge_usage?.resources.length) && <i>{task.knowledge_usage!.resources.length}</i>}
                </button>
                <button type="button" role="tab" className={`ws-activity-tab${
                    workspaceView === "execution" ? " on" : ""}`}
                  aria-selected={workspaceView === "execution"}
                  title={`查看 Agent 的进展、决定与验证结果（${viewShortcutHint("execution")}）`}
                  onClick={() => selectWorkspaceView("execution")}>
                  <span>工作过程</span>
                </button>
              </div>
              <div className="ws-material-tools" role="group" aria-label="阅读与检视工具">
                <button type="button"
                  className={`ws-review-launch${reviewPanelOpen ? " on" : ""}`}
                  aria-label="检视意见" aria-expanded={reviewPanelOpen} aria-controls="ws-review-canvas"
                  title={`查看意见、Agent 回应并复检（${REVIEW_SHORTCUT}）`}
                  onClick={() => {
                    setReviewPanelOpen((open) => !open);
                    setReviewRevealRequest((request) => request + 1);
                  }}>
                  <svg viewBox="0 0 20 20" aria-hidden><path d="M4 3.5h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9l-5 3v-3H3v-9a1 1 0 0 1 1-1Z" /><path d="M6.5 7h7M6.5 10h4" /></svg>
                  <span className="ws-review-label">检视意见</span>
                  {Boolean(reviewCounts.mine || reviewRecordCount) && <em>{reviewCounts.mine || reviewRecordCount}</em>}
                </button>
                {workspaceView !== "execution" && <button type="button" className="materials-fullscreen-toggle"
                  aria-pressed={materialsFullscreen}
                  title={materialsFullscreen ? "返回检视与决定同屏" : "让当前交付材料占满工作台"}
                  onClick={() => setMaterialsFullscreen((current) => !current)}>
                  <svg viewBox="0 0 20 20" aria-hidden>{materialsFullscreen
                    ? <path d="M7 3v4H3M13 3v4h4M7 17v-4H3M13 17v-4h4" />
                    : <path d="M7 3H3v4M13 3h4v4M3 13v4h4M17 13v4h-4" />}</svg>
                  <span>{materialsFullscreen ? "退出全屏" : "全屏查看"}</span>
                </button>}
                {materialView !== "chain" && workspaceView !== "execution" && workspaceView !== "knowledge" && <button type="button"
                  className={`material-search-toggle${materialSearchOpen ? " on" : ""}`}
                  aria-expanded={materialSearchOpen}
                  title="只搜索当前打开的这份内容"
                  onClick={toggleMaterialSearch}>
                  <svg viewBox="0 0 20 20" aria-hidden><circle cx="8.5" cy="8.5" r="5" /><path d="m12.5 12.5 4 4" /></svg><span>搜索</span>
                </button>}
              </div>
            </div>
          </div>
          <div className="ws-material-stage">
          <section className="ws-review-canvas" id="ws-review-canvas" role="complementary"
            aria-label="检视意见" tabIndex={-1} hidden={!reviewPanelOpen}>
            <header className="ws-view-intro">
              <div><h2>检视意见</h2><p>对照材料查看意见和回应，点击位置即可定位。</p></div>
              <button type="button" aria-label="收起检视意见" onClick={() => setReviewPanelOpen(false)}>×</button>
            </header>
            {reviewWorkspaceContent}
          </section>
          <div className="ws-material-content">
          {workspaceView === "knowledge" ? (
            <div className="ws-primary-scroll ws-knowledge-view">
              <KnowledgeFootprint usage={task.knowledge_usage} utMethod={task.ut_generation_method}
                taskId={task.id} taskStatus={task.status} />
            </div>
          ) : workspaceView === "execution" ? (
            <div className="ws-primary-scroll ws-execution-view">
              <TaskJourney task={task} onLogs={() => setTaskInspector("logs")}
                onTiming={() => setTaskInspector("timing")}
                />
            </div>
          ) : <>
          {materialSearchOpen && materialView !== "chain" && (
            <div className="material-search-bar" role="search">
              <span className="material-search-icon" aria-hidden>⌕</span>
              <input ref={materialSearchInput}
                value={materialSearchQuery}
                aria-label="搜索当前内容"
                placeholder={materialView === "diff"
                  ? "搜索当前代码变更"
                  : materialView === "source"
                    ? "搜索当前需求原文"
                    : `搜索 ${activeMeta?.label ?? "当前文档"}`}
                onChange={(event) => setMaterialSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    moveMaterialSearch(event.shiftKey ? -1 : 1);
                  }
                }} />
              <span className={`material-search-count${materialSearchQuery.trim()
                  && !materialSearchCount ? " empty" : ""}`}
                aria-live="polite">
                {!materialSearchQuery.trim() ? "输入关键词"
                  : materialSearchCount
                    ? `${materialSearchIndex + 1} / ${materialSearchCount}`
                    : "没有找到"}
              </span>
              <button type="button" title="上一处（Shift + Enter）"
                aria-label="上一个搜索结果" disabled={!materialSearchCount}
                onClick={() => moveMaterialSearch(-1)}>↑</button>
              <button type="button" title="下一处（Enter）"
                aria-label="下一个搜索结果" disabled={!materialSearchCount}
                onClick={() => moveMaterialSearch(1)}>↓</button>
              <button type="button" className="material-search-close"
                aria-label="关闭搜索" onClick={toggleMaterialSearch}>×</button>
            </div>
          )}
          {evidenceGapActionable && evidenceGapArtifact && (
            <section className="ws-evidence-gap-callout" role="status">
              <div>
                <span>流水线需要补充原文</span>
                <strong>打开《流水线证据缺口》，圈选说明并粘贴平台报错</strong>
                <p>保存批注后会自动记入待处理反馈，点击“贴回报错”即可让 Agent 继续。</p>
              </div>
              <button type="button"
                className={active === evidenceGapArtifact.name
                    && materialView === "doc" ? "on" : ""}
                onClick={() => {
                  setMaterialView("doc");
                  setActive(evidenceGapArtifact.name);
                }}>
                {active === evidenceGapArtifact.name && materialView === "doc"
                  ? "正在查看" : "打开材料"}
              </button>
            </section>
          )}
          <div className={`ws-material-reader${materialView === "doc" && documents.length > 0 ? " with-documents" : ""}`}>
          {materialView === "doc" && documents.length > 0 && (
            <div className="ws-tabs ws-document-tabs">
              {documents.map((item) => (
                <button key={item.name} className={"ws-tab" + (item.name === active ? " on" : "")} onClick={() => setActive(item.name)}>
                  <span>{item.label}</span><i>{item.purpose === "delivery_unit_brief"
                    ? "主任务书" : item.purpose === "delivery_plan"
                      ? "参考" : sizeText(item.bytes)}</i>
                </button>
              ))}
              <button type="button" className="ws-document-download"
                disabled={documentsDownloading}
                title={`下载全部 ${documents.length} 份产出文档(完整原文件)`}
                onClick={() => void downloadDocuments()}>
                <span aria-hidden>⇩</span>
                {documentsDownloading ? "打包中…" : "打包下载"}
              </button>
            </div>
          )}
          {documentsDownloadError && <div className="utility-note" role="alert">
            打包下载失败：{documentsDownloadError}
          </div>}
          <div className={`ws-doc${materialView === "diff" ? " is-diff" : ""}`}>
            {locationNotice && (
              <div className="annotation-location-notice" role="status">
                <div><strong>批注位置已变化</strong><span>{locationNotice}</span></div>
                <button type="button" aria-label="关闭定位提示"
                  onClick={() => setLocationNotice("")}>×</button>
              </div>
            )}
            {materialView === "source" ? (
              <Annotatable
                taskId={task.id}
                artifact={TASK_REQUIREMENT_ARTIFACT}
                fallbackFile="需求原文"
                kind="doc"
                items={locatableNotes}
                enabled={canContributeReview && canCreateAnnotation}
                onAdded={() => setNotesPulse((tick) => tick + 1)}
                onOpenAnnotations={openAnnotationReview}
                renderInlineReview={(ids) => renderAnnotations(notes.filter((note) => ids.includes(note.id)), true)}
                onSendDraft={annotationCanSend ? (id) => sendAnnotations(task.id, [id]) : undefined}
                queueWithDecision={annotationQueueWithDecision}
              >
                <article className="requirement-source">
                  <div className="requirement-source-label">
                    <span>{task.requirement_document?.bundle_name
                      ?? task.requirement_document?.name
                      ?? "用户提交的完整内容"}
                      {task.requirement_document?.context_mode === "file"
                        && <em>Agent 分段读取</em>}</span>
                    <small>{task.requirement.split(/\r?\n/).length} 行 · {task.requirement.length} 字符</small>
                  </div>
                  {/* 上一轮修改被拒收或失败时,原来只有 API 里有原因,页面上人
                      只看到"文档没变"——这里把原因摆在正文上方。 */}
                  {task.requirement_revision?.state === "failed" && (
                    <div className="requirement-revision-error" role="alert">
                      <strong>上一轮修改没有生效</strong>
                      <span>{task.requirement_revision.error ?? "Agent 没有给出原因"}</span>
                      <small>意见仍在待提交，修正后可以重新提交</small>
                    </div>
                  )}
                  {/* Agent 每改一轮都留了改前全文和 diff。复检的人原来只能靠
                      锚点猜"改了什么",要真核对得把整篇重读——这里直接给对比。 */}
                  {(task.requirement_revisions?.length ?? 0) > 0 && (() => {
                    const revisions = task.requirement_revisions!;
                    const latest = revisions[revisions.length - 1];
                    const showing = revisionDiff?.id === latest.id;
                    return (
                      <div className="requirement-revision-bar" role="status">
                        <span>
                          Agent 已修改 {revisions.length} 轮 · 最近一轮
                          <b className="added">+{latest.additions}</b>
                          <b className="deleted">-{latest.deletions}</b>
                          <small>{relativeTime(latest.at)}</small>
                        </span>
                        <button type="button" className={showing ? "on" : ""}
                          onClick={() => {
                            if (showing) { setRevisionDiff(null); return; }
                            setRevisionDiff({ id: latest.id, text: "" });
                            void readRequirementRevision(task.id, latest.id)
                              .then((result) => setRevisionDiff({
                                id: latest.id,
                                text: result.diff ?? "",
                                unavailable: result.unavailable,
                              }));
                          }}>
                          {showing ? "回到全文" : "看这一轮改了什么"}
                        </button>
                      </div>
                    );
                  })()}
                  {revisionDiff ? (
                    revisionDiff.unavailable
                      ? <p className="requirement-revision-missing">{revisionDiff.unavailable}</p>
                      : revisionDiff.text
                        ? <RequirementDiff text={revisionDiff.text} />
                        : <p className="requirement-revision-missing">正在读取对比…</p>
                  ) : (
                    <Markdown text={task.requirement} resolveImage={(path) =>
                      task.requirement_document?.assets?.some(
                        (asset) => asset.path === path)
                        ? `/tasks/${encodeURIComponent(task.id)}/requirement-asset?path=${encodeURIComponent(path)}`
                        : undefined} />
                  )}
                </article>
              </Annotatable>
            ) : materialView === "chain" ? (
              <>
                {/* 结构意见直接在图上按整体/模块/依赖批注；需要引用详细措辞
                    时仍可直达 CHAIN 文档逐行圈选。两种入口共用一套批注账。 */}
                {canCreateAnnotation && task.requirement_graph?.stage === "analysis"
                  && (() => {
                    const chainDoc = documents.find((item) =>
                      /(^|\/)CHAIN-[^/]*\.md$/.test(item.name));
                    return (
                      <div className="chain-review-entry" role="note">
                        <div>
                          <strong>需要针对方案文字提意见？</strong>
                          <small>{chainDoc
                            ? "整体切法、模块和依赖可直接在下方图上批注；具体文字可打开方案文档圈选。"
                            : "方案文档还没生成，生成后可在产出文档里圈选批注。"}</small>
                        </div>
                        <button type="button" disabled={!chainDoc}
                          onClick={() => {
                            if (!chainDoc) return;
                            setMaterialView("doc");
                            setActive(chainDoc.name);
                          }}>
                          打开方案文档逐行批注
                        </button>
                      </div>
                    );
                  })()}
                {/* 讨论参与人是澄清期的事,不是确认拆分时要定的:原来到了
                    方案确认卡它整块搬进右栏,和"拆分后怎么执行"摞成 730px,
                    卡里还多出一个绿色"保存并邀请"按钮和紫色"提交决定"打架。
                    现在长在图里"主任务团队"那一块的按钮后面,想拉人就点开。 */}
                <RequirementGraph task={task} onOpenTask={onOpenTask}
                  annotationEnabled={canCreateAnnotation
                    && task.requirement_graph?.stage === "analysis"}
                  annotations={notes}
                  onAnnotationAdded={() => setNotesPulse((tick) => tick + 1)}
                  teamInvite={canOperate && task.requirement_graph?.stage === "analysis"
                    ? <RequirementTeamPicker
                        taskId={task.id}
                        owner={task.luban_account}
                        collaborators={task.collaborators}
                        onSaved={onChanged}
                      />
                    : undefined} />
                {!chainReview && canOperate
                  && task.requirement_graph?.stage === "analysis"
                  && task.requirement_graph.projection_state === "ready"
                  && task.requirement_graph.repositories.length > 0 && (
                    <RepositoryAssigneePicker
                      taskId={task.id}
                      repositories={task.requirement_graph.repositories}
                      defaultAssignee={task.luban_account}
                      defaultTicket={task.ticket}
                      selection={repositoryAssignees}
                      onSelectionChange={changeRepositoryAssignees}
                      saveState={repositoryAssigneeSave}
                    />
                )}
              </>
            ) : <>
              {materialView === "diff" && pushReview && (
                <div className="push-review-scope" aria-label="代码检视范围">
                  {pushReview.has_focused_changes ? <>
                    <button type="button"
                      className={diffScope === "changes" ? "on" : ""}
                      onClick={() => {
                        if (diffScope === "changes") return;
                        setContent("");
                        setPushDiffState({ kind: "checking" });
                        setDiffScope("changes");
                      }}>
                      <strong>这次改的</strong>
                      <span>{pushReview.title}</span>
                    </button>
                    <button type="button"
                      className={diffScope === "full" ? "on" : ""}
                      onClick={() => {
                        if (diffScope === "full") return;
                        setContent("");
                        setPushDiffState({ kind: "checking" });
                        setDiffScope("full");
                      }}>
                      <strong>全部改动</strong>
                      <span>从任务起点到当前待推送代码</span>
                    </button>
                  </> : (
                    // 只有一个范围时不是"可切换":按钮外观点了没反应,
                    // 用户会当成坏了(MFC-035)。老实渲染成状态标签。
                    <div className="on scope-single" role="note">
                      <strong>全部改动</strong>
                      <span>从任务起点到当前待推送代码;本轮没有可单看的增量修改</span>
                    </div>
                  )}
                  <p>{diffScope === "changes"
                    ? "这里只看这次处理产生的变化，方便快速复检；最终授权仍绑定当前完整待推送版本。"
                    : "这里可以调整最终交付文件；取消勾选的文件不会进入本次推送。"}</p>
                </div>
              )}
              {unavailable && <div className="utility-note">{unavailable}</div>}
              {!unavailable && !items && <div className="utility-note">正在读取现场…</div>}
              {items?.length === 0 && (
                <div className="utility-note">这一单还没有可检视的产物。</div>
              )}
              {materialView === "diff" && pushReview
                && pushDiffState.kind === "error" && (
                <div className="utility-note" role="alert">
                  <strong>{pushDiffState.expired
                    ? "这版代码已失效，暂不能确认推送"
                    : "代码检视暂不可用，暂不能确认推送"}</strong>
                  <span>{pushDiffState.message}</span>
                  <button type="button" onClick={() => {
                    setContent("");
                    setPushDiffState({ kind: "checking" });
                    setLivePulse((tick) => tick + 1);
                    onChanged();
                  }}>刷新任务并重新读取</button>
                </div>
              )}
              {loading && <div className="utility-note">正在打开 {activeMeta?.label}…</div>}
              {!loading && content && (
              <Annotatable
                taskId={task.id}
                artifact={active}
                fallbackFile={activeMeta?.label ?? active}
                kind={activeMeta?.kind === "diff" ? "code" : "doc"}
                items={locatableNotes}
                enabled={canContributeReview && canCreateAnnotation}
                onAdded={() => setNotesPulse((tick) => tick + 1)}
                onOpenAnnotations={openAnnotationReview}
                renderInlineReview={(ids) => renderAnnotations(notes.filter((note) => ids.includes(note.id)), true)}
                onSendDraft={annotationCanSend ? (id) => sendAnnotations(task.id, [id]) : undefined}
                queueWithDecision={annotationQueueWithDecision}
              >
                {materialView === "diff"
                  ? <GitDiff text={content} branch={branch} embeddedBrowser
                      manifest={!pushReview ? activeMeta?.change_files : undefined}
                      untrackedDirectories={!pushReview
                        ? activeMeta?.untracked_directories : undefined}
                      onDirectoryLoad={!pushReview
                        ? (path, offset) => listArtifactChangeDirectory(
                            task.id, path, offset)
                        : undefined}
                      onFileSelect={!pushReview ? setSelectedDiffPath : undefined}
                      activeFileLoading={diffFileLoading}
                      activeFileError={diffFileError}
                      hideKey={task.id}
                      scopeLabel={pushReview
                        ? diffScope === "changes"
                          ? `本次修改 · ${(pushReview.base_sha ?? "").slice(0, 7)}`
                            + ` → ${(pushReview.head_sha ?? "").slice(0, 7)}`
                          : `完整交付 · ${(pushReview.baseline_sha
                              ?? pushReview.base_sha ?? "").slice(0, 7)}`
                            + ` → ${(pushReview.head_sha ?? "").slice(0, 7)}`
                        : undefined}
                      selectable={canOperate
                        // waiting 残留(如 await_merge 后列表快照没带
                        // waiting 键)不得再开勾选:必须真的在等这张卡
                        // (MFC-009)。
                        && task.status === "waiting_for_human"
                        && task.waiting?.recommended_view === "diff"
                        && (!pushReview || diffScope === "full")}
                      selectionKey={task.waiting?.waiting_id}
                      initialSelectedPaths={deliverySelection?.selectedPaths
                        ?? (task.delivery_selection?.status === "requested"
                          ? task.delivery_selection.paths : undefined)}
                      onSelectionChange={setDeliverySelection}
                      focusRequest={diffReviewRequest} />
                  : <Markdown text={content} />}
              </Annotatable>
              )}
            </>}
          </div>
          </div>
          </>}
          </div>
          </div>
        </section>
        <section className="ws-side" aria-label="与 Agent 协作">
          {/* 栏宽可拖(双击复位),记在浏览器里:默认 36vw 封顶 640px 仍嫌窄的话
              人自己拉(用户 2026-09-05:"占据的面积太小了")。 */}
          <div className="ws-side-resizer" role="separator" aria-orientation="vertical"
            aria-label="拖动调整协作栏宽度" title="拖动调整宽度，双击恢复默认"
            onPointerDown={startSideResize}
            onDoubleClick={() => {
              setSideWidth(undefined);
              try { localStorage.removeItem(SIDE_WIDTH_KEY); } catch { /* 私密模式 */ }
            }} />
          <div className="ws-side-notices">
      {(pauseFeedback || controlError) && (
        <div className="task-control-feedback" aria-live="polite">
          {pauseFeedback && (
            <div className={`task-control-state ${pauseFeedback.state}`}
              role="status">
              <i aria-hidden />
              <span><strong>{pauseFeedback.title}</strong>
                <small>{pauseFeedback.detail}</small></span>
            </div>
          )}
          {controlError && <div className="task-control-error" role="alert">
            <strong>操作没有完成</strong>
            <span>{controlError}</span>
          </div>}
        </div>
      )}

            {(task.execution_plan_alerts ?? []).length > 0 && (
              <section className="ws-focus-alert" role="alert">
                <strong>执行方案与当前现场不一致</strong>
                {task.execution_plan_alerts!.map((line, index) => (
                  <p key={index}>{line.replace(/^⚠\s*/, "")}</p>
                ))}
              </section>
            )}

            {task.baseline_build?.status === "failed" && <div className="alert" role="status">
              <strong>开工前编译失败</strong><span>开工前编译未通过，查看环境或上游问题。</span>
              <button type="button" onClick={() => setWarmupOpen(true)}>查看编译失败原因</button>
            </div>}
            {task.delivery?.skipped && <div className="alert" role="alert">
              <strong>交付已阻止</strong><span>{task.delivery.skipped}</span>
            </div>}
            {task.notify?.settled && !task.notify.delivered && task.notify.attempts > 0 && (
              <div className="alert" role="status"><strong>小鲁班通知未送达</strong>
                <span>已尝试 {task.notify.attempts} 次{task.notify.last_error?.match(/HTTP\s+\d{3}/)?.[0]
                  ? `（${task.notify.last_error.match(/HTTP\s+\d{3}/)![0]}）` : ""}；待办仍然有效，请在本页处理。</span>
              </div>
            )}
            {task.status === "queued" && Boolean(task.blocked_by?.length) && (
              <div className="ws-focus-note"><strong>等待前置任务完成后自动开始</strong>
                <div className="ws-dependency-links">{task.blocked_by!.map((id) => (
                  <button type="button" key={id} disabled={!onOpenTask}
                    onClick={() => onOpenTask?.(id)}>{id}</button>
                ))}</div>
              </div>
            )}
          </div>
          {/* 右栏 = 一条会话流 + 一个输入框(2026-09-05 用户拍板):卡上的选项就是
              动作,输入框只写附言/自定义/插话;工具步骤留在「工作过程」,流里只有
              回合。批注挂在提交按钮正上方(WaitingCard 内部)的原则不变——选项
              标签是内核的,前端改写会让记账对不上(2026-08-09 实战事故)。 */}
          <ConversationStream
            task={task}
            items={conversation.items}
            problems={conversation.problems}
            loaded={conversation.loaded}
            unavailable={conversation.unavailable}
            viewerUsername={viewerUsername}
            people={streamPeople}
            filter={streamFilter}
            onFilterChange={setStreamFilter}
            thread={streamThread}
            onThreadChange={showThread}
            annotations={notes}
            decides={Boolean(waiting) && decides}
            awaitingYou={reviewCounts.mine}
            fallbackHeadline={nextAction.title}
            fallbackDetail={nextAction.detail}
            currentCard={waiting ? (decides ? (
                <WaitingCard
                  task={task}
                  presentation="studio"
                  footerTarget={decisionFooterTarget}
                  participant={!canOperate}
                  onDecided={() => { setNotesPulse((tick) => tick + 1); onChanged(); }}
                  annotationIds={requirementAnalysisConfirmation ? undefined : draftIds}
                  unresolvedAnnotationCount={unresolvedNotes.length}
                  repositoryAssigneeSelection={chainReview && canOperate
                    && task.requirement_graph?.projection_state === "ready"
                    && task.requirement_graph.repositories.length > 0
                    ? repositoryAssignees : undefined}
                  deliverySelection={task.waiting?.recommended_view === "diff"
                    ? decisionDeliverySelection : undefined}
                  pushReview={pushReview}
                  onLocateDelivery={task.waiting?.recommended_view === "diff"
                    ? (scope) => {
                        setWorkspaceView("materials");
                        setMaterialView("diff");
                        setContent("");
                        setPushDiffState({ kind: "checking" });
                        const nextScope = scope
                          ?? (pushReview?.has_focused_changes ? "changes" : "full");
                        if (nextScope === diffScope) {
                          setLivePulse((tick) => tick + 1);
                        } else {
                          setDiffScope(nextScope);
                        }
                        setDiffReviewRequest((request) => request + 1);
                        const first = items?.find((item) => item.kind === "diff");
                        if (first) setActive(first.name);
                      }
                    : undefined}
                  activeDeliveryScope={task.waiting?.recommended_view === "diff"
                    ? diffScope : undefined}
                  attachment={requirementAnalysisConfirmation ? undefined :
                    <>
                      {/* 卡上只放这次决定真正要填的:每个单元谁执行、用哪个
                          单号。讨论参与人留在左侧图下面。 */}
                      {chainReview && canOperate
                        && task.requirement_graph?.projection_state === "ready"
                        && task.requirement_graph.repositories.length > 0 && (
                        <RepositoryAssigneePicker
                          taskId={task.id}
                          repositories={task.requirement_graph!.repositories}
                          defaultAssignee={task.luban_account}
                          defaultTicket={task.ticket}
                          selection={repositoryAssignees}
                          onSelectionChange={changeRepositoryAssignees}
                          saveState={repositoryAssigneeSave}
                        />
                      )}
                      {draftIds.length > 0 && <div className="ws-attached-feedback" role="note">
                        本次决定将附带你的 {draftIds.length} 条未发送反馈；已发送意见不重复附带。
                      </div>}
                    </>
                  }
                />
              ) : (
                <div className="read-only-notice">
                  {canCollaborate
                    ? `这一步由责任人 ${task.luban_account ?? "其他成员"} 拍板；你可以继续在材料上批注插话，意见会随卡送到 Agent。`
                    : `该事项由 ${task.luban_account ?? "其他成员"} 核对；你可以查看全部材料，但不能代为提交决定。`}
                </div>
              )) : undefined}
            tail={streamTail}
            assistantTools={assistantView?.tools}
            takeover={assistantView ? takeoverActiveOf(assistantView) : false}
            statusText={waiting && !decides ? "等待负责人决定" : statusText(task)}
            actor={health?.actor?.startsWith("你 · ")
              ? "由你负责" : health?.actor ?? `责任 · ${task.luban_account ?? "系统"}`}
            onLocateAnnotation={(id) => {
              const item = notes.find((note) => note.id === id);
              if (!item) return;
              locate(item);
              openAnnotationReview([id]);
            }}
            onOpenReview={(ids) => {
              if (ids.length) { openAnnotationReview(ids); return; }
              setReviewFilter("mine");
              setReviewPanelOpen(true);
            }}
            onOpenSteps={() => selectWorkspaceView("execution")}
          />
          {canCollaborate || decides ? (
            <Composer task={task}
              crossRepository={Boolean(task.parent_task_id)}
              steerOnly={task.requirement_graph?.stage === "analysis"}
              decisionDock={Boolean(waiting) && decides}
              dockContext={draftIds.length > 0 && !requirementAnalysisConfirmation
                ? `这里写的说明和你的 ${draftIds.length} 条排队批注会随选项一起送给 Agent`
                : isClarificationWaiting(task)
                  ? "答复只把缺的信息给 Agent，它接着处理；这不是最终验收"
                  : "这里写的说明会随选项一起送给 Agent"}
              dockRef={setDecisionFooterTarget}
              onChanged={() => {
                setLivePulse((value) => value + 1);
                onChanged();
              }}
              onAssistant={setAssistantView} />
          ) : (
            <div className="ws-composer-readonly">
              你可以查看全部记录与材料；提交决定和插话由责任人 {task.luban_account ?? "或协作者"} 处理。
            </div>
          )}
        </section>
      </div>
      {reviewInviteOpen && <div className="workspace-review-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setReviewInviteOpen(false);
        }}>
        <section className="workspace-invite-dialog" role="dialog" aria-modal="true"
          aria-labelledby="workspace-invite-title">
          <header>
            <div><strong id="workspace-invite-title">邀请 Committer 检视</strong>
              <p>选择一位 Committer 参与检视；邀请不会代替任务责任人的最终决定。</p>
            </div>
            <button type="button" aria-label="关闭邀请检视"
              autoFocus onClick={() => setReviewInviteOpen(false)}>×</button>
          </header>
          <div className="workspace-invite-content">
            {committers.length > 0 ? (
              <div className="workspace-review-invite-action">
                <UserPicker ariaLabel="选择 Committer" value={reviewer}
                  emptyLabel="请选择 Committer"
                  options={committers} onChange={setReviewer} />
                <button type="button" disabled={!reviewer || reviewBusy}
                  onClick={() => void inviteReview()}>
                  {reviewBusy ? "发送中…" : "发送邀请"}
                </button>
              </div>
            ) : <div className="committer-empty">
              管理员尚未配置 Committer 名单
            </div>}
            {reviewResult && <small className="committer-result">
              {reviewResult}
            </small>}
            {taskReviews.length > 0 && (
              <div className="workspace-review-invite-history">
                {taskReviews.slice(0, 3).map((review) => (
                  <span key={review.id}>
                    <i className={review.status} aria-hidden />
                    <strong>{committers.find((user) =>
                      user.username === review.committer)?.display_name
                      ?? review.committer}</strong>
                    <small>{review.status === "completed" ? "已完成检视"
                      : review.delivered ? "等待检视" : "通知未送达"}</small>
                  </span>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>}
    </main>
  );
}
