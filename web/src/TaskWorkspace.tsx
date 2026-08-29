/**
 * 任务工作台:决策发生在哪里,证据就在哪里。
 *
 * 用户实测的摩擦:审批卡问"本地 Spec 确认",spec.md 却只在内核
 * 现场面板(另一套 UI 的 iframe)里能看——读材料要跳出决策上下文。
 * 这里把两半合成一屏:主画布一次只承载材料、开发协作、执行现场或
 * 分析检视中的一种；右侧只保留此刻必须处理的决定。
 *
 * 内核面板不再暴露给业务用户：它是内核为“人坐在终端旁”生成的
 * 单文件 HTML，工作台自己承接材料、决策与过程观察，避免形成两套入口。
 */

import { useEffect, useState } from "react";
import { Markdown } from "./markdown";
import { GitDiff, type GitDiffSelection } from "./GitDiff";
import { SteerBox } from "./SteerBox";
import { Annotatable } from "./Annotatable";
import { AnnotationPanel } from "./AnnotationPanel";
import { AttachedNotes } from "./AttachedNotes";
import { RequirementGraph } from "./RequirementGraph";
import { PrepushBadge } from "./PrepushStatus";
import { TokenUsage } from "./TokenUsage";
import { KnowledgeFootprint } from "./KnowledgeFootprint";
import { StagePlanDialog } from "./StagePlanDialog";
import { WorkflowProfileCard } from "./WorkflowProfileCard";
import { CrossRepositorySync } from "./CrossRepositorySync";
import { WarmupPanel, WarmupBadge } from "./WarmupPanel";
import { taskHealthFacts } from "./taskHealth";
import { relativeTime } from "./time";
import { startVisiblePolling } from "./visiblePolling";
import {
  EMPTY_REPOSITORY_ASSIGNEE_SELECTION,
  RepositoryAssigneePicker,
  type RepositoryAssigneeSelection,
} from "./RepositoryAssigneePicker";
import { RequirementTeamPicker } from "./RequirementTeamPicker";
import {
  completeReview,
  controlTask,
  listAnnotations,
  listArtifacts,
  listCommitters,
  listTaskReviews,
  readArtifact,
  repairStopped,
  requestCommitterReview,
  statusText,
  type AnchorCheck,
  type Annotation,
  type ArtifactMeta,
  type ReviewRequest,
  type TaskSummary,
} from "./api";
import {
  ExecutionPanel,
  RetryButton,
  TaskProgress,
  TaskTimeline,
  WaitBadge,
  WaitingCard,
} from "./TaskCard";

type WorkspaceView = "materials" | "collaboration" | "execution" | "insights";

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 内核现场始终优先；旧任务、分析任务或纯会话模式没有 panel 文件时，
 * 仍给人一条 Cloud 生命周期轨道，避免工作台最重要的“走到哪了”整块消失。
 * 这只是只读展示兜底，不参与流程判断或任务迁移。 */
function workspaceProgress(task: TaskSummary): NonNullable<TaskSummary["progress"]> {
  if (task.progress) return task.progress;
  const phases = [
    "已受理", "需求理解", "开发实现", "人工确认", "交付验证", "等待合入", "完成",
  ];
  const inAnalysis = task.requirement_graph?.stage === "analysis";
  const currentIndex = task.status === "queued" ? 0
    : task.status === "waiting_for_human" ? (inAnalysis ? 1 : 3)
    : task.status === "verifying" ? 4
    : task.status === "await_merge" ? 5
    : task.status === "completed" ? 6
    : inAnalysis ? 1 : 2;
  return {
    phases,
    current_index: currentIndex,
    current_phase: phases[currentIndex],
    step: task.focus?.headline ?? statusText(task),
  };
}

function assistantUnavailableReason(task: TaskSummary): string {
  if (["waiting_for_human", "verifying"].includes(task.status)) {
    return "先暂停主任务即可接管当前代码现场";
  }
  if (task.status === "completed") {
    return "任务已经结束；运行中的开发实现阶段可直接查代码、跑命令和修改";
  }
  if (task.status === "canceled" || task.status === "failed") {
    return "任务已经停止；重跑并进入可编辑阶段后开放";
  }
  return "代码现场就绪后即可使用";
}

export function TaskWorkspace({
  task,
  viewerUsername,
  canOperate,
  canCollaborate,
  canRequestReview,
  reviewAssignment,
  onChanged,
  onClose,
  onOpenTask,
  onExecutionPlanFeedback,
}: {
  task: TaskSummary;
  viewerUsername: string;
  canOperate: boolean;
  /** 主任务责任人或已被逐仓分工邀请的协作者。最终决定仍看 canOperate。 */
  canCollaborate: boolean;
  canRequestReview: boolean;
  reviewAssignment?: ReviewRequest;
  onChanged: () => void;
  onClose: () => void;
  onOpenTask?: (taskId: string) => void;
  onExecutionPlanFeedback?: (draft: { title: string; detail: string }) => void;
}) {
  // 旧任务、纯会话和非内核提问没有 approval_subject 元数据；此时需求
  // 原文是唯一保证存在的证据，不能默认打开一个空的过程文档面板。
  const recommendedMaterialView = task.waiting?.recommended_view ?? "source";
  const [items, setItems] = useState<ArtifactMeta[]>();
  const [unavailable, setUnavailable] = useState("");
  const [active, setActive] = useState("");
  const [materialView, setMaterialView] =
    useState<"source" | "doc" | "chain" | "diff">(recommendedMaterialView);
  const [content, setContent] = useState("");
  const [branch, setBranch] = useState("");
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState<Annotation[]>([]);
  const [checks, setChecks] = useState<AnchorCheck[]>([]);
  const [reply, setReply] =
    useState<{ texts: string[]; truncated: boolean } | undefined>();
  const [notesPulse, setNotesPulse] = useState(0);
  const [livePulse, setLivePulse] = useState(0);
  const [committers, setCommitters] = useState<Array<{ username: string }>>([]);
  const [reviewer, setReviewer] = useState("");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewResult, setReviewResult] = useState("");
  const [taskReviews, setTaskReviews] = useState<ReviewRequest[]>([]);
  const [completeBusy, setCompleteBusy] = useState(false);
  const [completeError, setCompleteError] = useState("");
  const [controlBusy, setControlBusy] =
    useState<"pause" | "resume" | "cancel" | "">("");
  const [controlError, setControlError] = useState("");
  const [cancelArmed, setCancelArmed] = useState(false);
  const [repositoryAssignees, setRepositoryAssignees] =
    useState<RepositoryAssigneeSelection>(EMPTY_REPOSITORY_ASSIGNEE_SELECTION);
  const [deliverySelection, setDeliverySelection] =
    useState<GitDiffSelection>();
  /** 点进度条阶段名弹该阶段执行方案;空串=不显示。 */
  const [planPhase, setPlanPhase] = useState("");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(
    task.status === "paused" ? "collaboration" : "materials",
  );

  useEffect(() => {
    setMaterialView(task.waiting?.recommended_view ?? "source");
    setWorkspaceView(task.status === "paused" ? "collaboration" : "materials");
    setRepositoryAssignees(EMPTY_REPOSITORY_ASSIGNEE_SELECTION);
    setDeliverySelection(undefined);
  }, [task.id]);

  useEffect(() => {
    setDeliverySelection(undefined);
  }, [task.waiting?.waiting_id]);

  useEffect(() => {
    const waitingId = task.waiting?.waiting_id;
    if (!waitingId || task.status === "paused") return;

    // 暂停时工作台会主动切到“开发协作”，方便用户接管现场。恢复后若
    // Agent 立即举出新问题，不能继续把左侧留在开发控制台——此刻人的
    // 首要任务是对照证据做决定。每张新决策卡都回到材料视图；有明确的
    // recommended_view 时再精确定位到文档或 diff。
    setWorkspaceView("materials");
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
    if (task.status === "paused") setWorkspaceView("collaboration");
  }, [task.status]);

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

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", escape);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", escape);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  // 产物列表按最近修改倒序(服务端排好),默认打开第一份——
  // "哪一步该看哪个文件"是内核语义,前端不复刻,只用修改时间定位。
  useEffect(() => {
    let alive = true;
    void listArtifacts(task.id).then((result) => {
      if (!alive) return;
      setUnavailable(result.unavailable ?? "");
      setItems(result.items);
      // 列表可能随任务轮询/状态切换重新读取。默认项只用于首次进入；
      // 用户已经切到工作区变更时绝不能被后台刷新拽回最近文档。
      setActive((current) => {
        if (result.items?.some((item) => item.name === current)) return current;
        const preferredKind = task.waiting?.recommended_view === "diff"
          ? "diff" : "doc";
        return result.items?.find((item) => item.kind === preferredKind)?.name
          ?? result.items?.[0]?.name ?? "";
      });
    });
    return () => { alive = false; };
  }, [task.id, livePulse]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setLoading((was) => was || !content);
    void readArtifact(task.id, active).then((result) => {
      if (!alive) return;
      const next = result.content ?? result.unavailable ?? "";
      // 内容没变就别 setState:轮询期间无谓重渲染会把正在写的批注打断。
      setContent((current) => current === next ? current : next);
      setBranch(result.branch ?? "");
      setLoading(false);
    });
    return () => { alive = false; };
  }, [task.id, active, livePulse]);

  // 批注随任务加载,也随"圈了一条/送出一批/任务状态变了"重取——
  // 进展(那处动没动)是服务端现算的,前端不自己推断。
  useEffect(() => {
    let alive = true;
    void listAnnotations(task.id).then((result) => {
      if (!alive) return;
      setNotes(result.items);
      setChecks(result.checks);
      setReply(result.reply);
    });
    return () => { alive = false; };
  }, [task.id, task.status, notesPulse, livePulse]);

  const drafts = notes.filter((item) => item.status === "draft");
  const unresolvedNotes = notes.filter((item) =>
    item.status === "draft" || item.status === "sent");
  // sent 仍是“未闭环”，要继续展示并阻止误放行；但它已经主动送给
  // Agent，不能再冒充本次决定要附带的草稿。两组 ID 混用会让决定接口
  // 按 draft 校验时拒绝整次提交，连人刚写的补充说明也一起被挡住。
  const draftIds = drafts.map((item) => item.id);

  /** 回到被圈的那一行:换页签→等它渲染出来→滚过去并闪一下。
   * 改批注前人几乎总要再看一眼上下文,只报"第 23 行"等于让他自己找。
   * 等待有预算(2 秒封顶),找不到就算了——旁路不许把界面卡住。 */
  function locate(item: Annotation) {
    setWorkspaceView("materials");
    if (item.artifact !== active) setActive(item.artifact);
    setMaterialView(items?.find((artifact) => artifact.name === item.artifact)
      ?.kind === "diff" ? "diff" : "doc");
    let tries = 0;
    const seek = () => {
      const node = document.querySelector<HTMLElement>(
        `.ws-doc [data-l="${item.line}"]`);
      if (!node) {
        if (tries++ < 20) window.setTimeout(seek, 100);
        return;
      }
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      node.classList.add("annot-flash");
      window.setTimeout(() => node.classList.remove("annot-flash"), 1700);
    };
    window.setTimeout(seek, item.artifact === active ? 0 : 120);
  }
  const activeMeta = items?.find((item) => item.name === active);
  const documents = items?.filter((item) => item.kind === "doc") ?? [];
  const changes = items?.filter((item) => item.kind === "diff") ?? [];
  // 服务端只生成一份聚合 diff，因此 changes.length 几乎永远是 1，
  // 它表示“产物份数”而不是用户关心的“变更文件数”。旧服务尚未提供
  // file_count 时保留原回退，避免滚动升级期间把入口误判为空。
  const changeCountKnown = changes.every((item) =>
    typeof item.file_count === "number");
  const changeFileCount = changeCountKnown
    ? changes.reduce((sum, item) => sum + (item.file_count ?? 0), 0)
    : changes.length;
  const hasRequirementGraph = (task.requirement_graph?.repositories.length ?? 0) > 1;
  const materialHeading = materialView === "source"
    ? { kicker: "REQUEST SOURCE", title: "需求原文" }
    : materialView === "chain"
    ? { kicker: "CHAIN OVERVIEW", title: "仓间依赖" }
    : materialView === "diff"
      ? { kicker: "WORKTREE CHANGES", title: "工作区变更" }
      : { kicker: "WORK DOCUMENTS", title: "过程文档" };
  const waiting = task.status === "waiting_for_human" && task.waiting;
  const collaborationVisible = canCollaborate && [
    "running", "pausing", "paused", "waiting_for_human", "verifying",
  ].includes(task.status);
  const chainReview = !!waiting
    && task.requirement_graph?.stage === "analysis"
    && (task.requirement_graph.repositories.length ?? 0) > 1
    // 多仓分析过程中的普通澄清也处于 analysis；分工只应在最终
    // Chain 方案检视卡出现，避免尚未定案时就让人误以为即将下发。
    && (waiting.question?.questions?.some((question) =>
      question.options?.some((option) => option.includes("确认并生成任务"))) ?? false);
  const controllable = canOperate && [
    "queued", "running", "pausing", "paused", "waiting_for_human", "verifying",
  ].includes(task.status);
  const health = taskHealthFacts(task, viewerUsername);
  const visibleProgress = workspaceProgress(task);
  const pauseFeedback = task.status === "pausing"
    ? {
        state: "pending",
        title: "正在安全暂停",
        detail: task.detail
          || "系统正在结束当前操作并保存现场；完成后会自动变为“已暂停”，无需重复点击。",
      }
    : task.status === "paused"
      ? {
          state: "done",
          title: "已安全暂停",
          detail: task.detail
            || "现场和进度已经保留，需要继续时点击右上角“恢复”。",
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

  return (
    <section
      className="workspace-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="task-workspace-title"
    >
      <header className="ws-head">
        <button type="button" className="ws-back" aria-label="返回列表"
          onClick={onClose} autoFocus>
          <svg viewBox="0 0 20 20" aria-hidden><path d="m12.5 5-5 5 5 5" /></svg>
          <span>返回列表</span>
        </button>
        <div className="ws-identity">
          <div className="ws-identity-line">
            {task.ticket && <span className="ws-business-id">{task.ticket}</span>}
            <code title="平台内部编号">{task.id}</code>
            <span className={`pill ${task.status}`}>
              <i aria-hidden />{statusText(task)}
            </span>
            <WaitBadge task={task} personal={canOperate} />
            <WarmupBadge task={task} />
            <PrepushBadge task={task} canOperate={canOperate}
              onChanged={onChanged} />
          </div>
          <strong id="task-workspace-title">{task.title ?? task.requirement}</strong>
          {task.parent_task_id && <button type="button" className="ws-parent-task"
            onClick={() => onOpenTask?.(task.parent_task_id!)}>
            <span>隶属跨仓大任务</span><code>{task.parent_task_id}</code>
          </button>}
        </div>
        {controllable && (
          <div className="ws-head-controls" aria-label="任务控制">
            {task.status === "paused" ? (
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
            )}
            {!cancelArmed ? (
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
            )}
          </div>
        )}
      </header>

      <div className={`ws-progress${task.progress ? "" : " is-fallback"}`
        + `${health?.needs_attention ? " attention" : ""}`}>
        {/* 阶段名可点:当前阶段弹内核编译的活方案,其他阶段弹标准
            方案底版(用户拍板:方案入口收进进度条,执行页签让位给
            SSE 现场)。需求受理/DTS 等云端词表任务的阶段名与内核
            六阶段完全不同,弹出来必然落底版兜底属误导(审计 P0-3)
            ——这些任务不提供弹层。 */}
        <TaskProgress progress={visibleProgress} showDetailedStep
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
      <nav className="ws-workspace-nav" aria-label="任务工作台视图">
        {([
          ["materials", "交付材料", "文档、依赖与代码变更"],
          ["insights", "批注与检视", drafts.length
            ? `${drafts.length} 条批注待提交` : notes.length
              ? `${notes.length} 条批注` : "圈选原文、协作检视"],
          ["collaboration", "开发协作", collaborationVisible
            ? "补充主任务或主动接管" : assistantUnavailableReason(task)],
          ["execution", "执行现场", task.focus?.headline ?? "原始 SSE 事件流"],
        ] as Array<[WorkspaceView, string, string]>).map(([view, label, hint]) => (
          <button type="button" role="tab" key={view}
            aria-selected={workspaceView === view}
            className={`${workspaceView === view ? "active" : ""}`
              + `${view === "insights" && drafts.length ? " attention" : ""}`}
            onClick={() => setWorkspaceView(view)}>
            <strong>
              {label}
              {view === "insights" && notes.length > 0 && (
                <em>{drafts.length > 0 ? `${drafts.length} 待提交` : notes.length}</em>
              )}
            </strong>
            <small>{hint}</small>
          </button>
        ))}
      </nav>

      <div className={`ws-body${waiting ? " has-decision" : ""}`}>
        <section className="ws-evidence" aria-label="待检视材料">
          {workspaceView === "materials" ? <>
          <div className="ws-pane-head">
            <div>
              <span>{materialHeading.kicker}</span>
              <strong>{materialHeading.title}</strong>
            </div>
            <div className="ws-source-switch" aria-label="材料类型">
              <button className={materialView === "source" ? "on" : ""}
                onClick={() => setMaterialView("source")}>
                <span>需求原文</span><i>原始</i>
              </button>
              <button className={materialView === "doc" ? "on" : ""}
                onClick={() => { setMaterialView("doc"); if (documents[0]) setActive(documents[0].name); }}>
                <span>过程文档</span><i>{documents.length}</i>
              </button>
              {hasRequirementGraph && <button className={materialView === "chain" ? "on" : ""}
                onClick={() => setMaterialView("chain")}>
                <span>仓间依赖</span><i>{task.requirement_graph!.dependencies.length}</i>
              </button>}
              <button className={materialView === "diff" ? "on" : ""}
                onClick={() => { setMaterialView("diff"); if (changes[0]) setActive(changes[0].name); }} disabled={!changeFileCount}>
                <span>工作区变更</span><i>{changeFileCount}</i>
              </button>
            </div>
          </div>
          {materialView === "doc" && documents.length > 1 && (
            <div className="ws-tabs">
              {documents.map((item) => (
                <button key={item.name} className={"ws-tab" + (item.name === active ? " on" : "")} onClick={() => setActive(item.name)}>
                  <span>{item.label}</span><i>{sizeText(item.bytes)}</i>
                </button>
              ))}
            </div>
          )}
          <div className="ws-doc">
            {materialView === "source" ? (
              <article className="requirement-source">
                <div className="requirement-source-label">
                  <span>{task.requirement_document?.name ?? "用户提交的完整内容"}
                    {task.requirement_document?.context_mode === "file"
                      && <em>Agent 分段读取</em>}</span>
                  <small>{task.requirement.split(/\r?\n/).length} 行 · {task.requirement.length} 字符</small>
                </div>
                <Markdown text={task.requirement} />
              </article>
            ) : materialView === "chain" ? (
              <>
                <RequirementGraph task={task} onOpenTask={onOpenTask} />
                {!chainReview && canOperate
                  && task.requirement_graph?.stage === "analysis" && <>
                    <RequirementTeamPicker
                      taskId={task.id}
                      owner={task.luban_account}
                      collaborators={task.collaborators}
                      onSaved={onChanged}
                    />
                    <RepositoryAssigneePicker
                      taskId={task.id}
                      repositories={task.requirement_graph.repositories}
                      defaultAssignee={task.luban_account}
                      selection={repositoryAssignees}
                      onSelectionChange={setRepositoryAssignees}
                      onSaved={onChanged}
                    />
                  </>}
              </>
            ) : <>
              {unavailable && <div className="utility-note">{unavailable}</div>}
              {!unavailable && !items && <div className="utility-note">正在读取现场…</div>}
              {items?.length === 0 && (
                <div className="utility-note">这一单还没有可检视的产物。</div>
              )}
              {loading && <div className="utility-note">正在打开 {activeMeta?.label}…</div>}
              {!loading && content && (
              <Annotatable
                taskId={task.id}
                artifact={active}
                fallbackFile={activeMeta?.label ?? active}
                kind={activeMeta?.kind === "diff" ? "code" : "doc"}
                items={notes}
                enabled={canOperate
                  && !["completed", "canceled"].includes(task.status)}
                onAdded={() => setNotesPulse((tick) => tick + 1)}
              >
                {materialView === "diff"
                  ? <GitDiff text={content} branch={branch}
                      hideKey={task.id}
                      selectable={canOperate
                        && task.waiting?.recommended_view === "diff"}
                      selectionKey={task.waiting?.waiting_id}
                      initialSelectedPaths={task.delivery_selection?.status === "requested"
                        ? task.delivery_selection.paths : undefined}
                      onSelectionChange={setDeliverySelection} />
                  : <Markdown text={content} />}
              </Annotatable>
              )}
            </>}
          </div>
          </> : workspaceView === "collaboration" ? <>
            <div className="ws-pane-head">
              <div><span>DEVELOPER CONSOLE</span><strong>开发协作</strong></div>
              <small>完整回复、命令结果与交还操作</small>
            </div>
            <div className="ws-primary-scroll ws-collaboration-view">
              {collaborationVisible ? (
                <>
                  {task.parent_task_id && <CrossRepositorySync
                    taskId={task.id}
                    updates={task.cross_repository_updates}
                    onChanged={onChanged} />}
                  <SteerBox task={task}
                    steerOnly={task.requirement_graph?.stage === "analysis"}
                    onChanged={() => {
                    setLivePulse((value) => value + 1);
                    onChanged();
                  }} />
                </>
              ) : (
                <section className="ws-view-empty" aria-label="开发助手状态">
                  <span aria-hidden>›_</span>
                  <strong>当前没有可接管的代码现场</strong>
                  <p>{assistantUnavailableReason(task)}</p>
                </section>
              )}
            </div>
          </> : workspaceView === "execution" ? <>
            <div className="ws-pane-head">
              <div><span>LIVE EXECUTION</span><strong>执行现场</strong></div>
              <small>实时事件流；各阶段执行方案点上方进度条的阶段名查看</small>
            </div>
            <div className="ws-primary-scroll ws-execution-view">
              {/* 定制链对拍告警必须压在现场之上:呈现与实际不一致是
                  最高级事故(用户红线),比事件流本身更优先。 */}
              {(task.execution_plan_alerts ?? []).length > 0 && (
                <section className="ws-alert ws-plan-alert" role="alert">
                  <strong>执行方案与定格不一致</strong>
                  {task.execution_plan_alerts!.map((line, index) => (
                    <p key={index}>{line.replace(/^⚠\s*/, "")}</p>
                  ))}
                </section>
              )}
              {/* SSE 实时现场是这个页签的主角(用户拍板),置顶;
                  执行方案卡整体撤出堆叠——各阶段方案点上方进度条的
                  阶段名查看(StagePlanDialog)。 */}
              {/* 摘要卡里的执行现场默认收起，避免多张卡同时拉实时流；
                  但这里已经是独立的“执行现场”页签，打开页签就该直接
                  看见现场，不能再让用户做一次没有意义的展开。 */}
              <ExecutionPanel task={task} defaultOpen />
              <WarmupPanel task={task} />
              {task.workflow_profile && <WorkflowProfileCard
                profile={task.workflow_profile}
                warning={task.workflow_profile_warning} />}
              <KnowledgeFootprint usage={task.knowledge_usage}
                utMethod={task.ut_generation_method}
                taskId={task.id} taskStatus={task.status}
                repositories={task.repositories ?? []}
                repositoryTechnologies={[...new Set(
                  (task.repository_profiles ?? []).flatMap((item) =>
                    item.technologies))]}
                businessModules={(task.business_modules ?? []).map((module) => ({
                  id: module.id, name: module.name,
                }))} />
            </div>
          </> : <>
            <div className="ws-pane-head">
              <div><span>REVIEW NOTES</span><strong>批注与检视</strong></div>
              <small>管理批注意见、检视协作与处理进展</small>
            </div>
            <div className="ws-primary-scroll ws-insights-view">
              <div className="ws-insights-grid">
                <section className="ws-insight-column">
                  <header><span>ANNOTATIONS</span><strong>批注意见</strong></header>
                  <AnnotationPanel
                    taskId={task.id}
                    viewerUsername={viewerUsername}
                    items={notes}
                    checks={checks}
                    reply={reply}
                    canOperate={canOperate}
                    taskStatus={task.status}
                    reviewReady={task.waiting?.step === "cloud_push_confirm"
                      && task.delivery?.loop?.review_source === "workspace"
                      && task.delivery.loop.workspace_review_recheck_required === true}
                    mergeRequestOpen={Boolean(task.delivery?.mr_url)
                      && !["completed", "canceled"].includes(task.status)
                      && !String(task.delivery?.mr_state ?? "").startsWith("已合入")
                      && task.delivery?.mr_state !== "已关闭"}
                    evidenceAwaiting={Boolean(
                      task.delivery?.evidence_gap?.missing_dimensions.length)}
                    onLocate={locate}
                    onChanged={() => { setNotesPulse((tick) => tick + 1); onChanged(); }}
                  />
                  {!notes.length && (
                    <div className="ws-insight-empty">
                      在“交付材料”中圈选原文或代码，即可创建批注。
                    </div>
                  )}
                </section>
                <section className="ws-insight-column">
                  <header><span>REVIEW & OPERATIONS</span><strong>检视协作与进展</strong></header>
                  {reviewAssignment && (
                    <section className="review-assignment" aria-labelledby="review-assignment-title">
                      <div className="review-assignment-mark" aria-hidden>审</div>
                      <div>
                        <span>COMMITTER REVIEW</span>
                        <strong id="review-assignment-title">{reviewAssignment.requester} 邀请你检视</strong>
                        <p>看完材料并留下必要批注后即可完成；这不会代替任务责任人提交决定。</p>
                        {completeError && <small className="review-assignment-error">{completeError}</small>}
                      </div>
                      <button type="button" disabled={completeBusy} onClick={() => void finishReview()}>{completeBusy ? "正在完成…" : "完成检视"}</button>
                    </section>
                  )}
                  {canRequestReview && (
                    <section className="committer-review" aria-labelledby="committer-review-title">
                      <div>
                        <span>OPTIONAL REVIEW</span>
                        <strong id="committer-review-title">邀请 Committer 检视</strong>
                        <p>仅在你主动邀请后通知，不影响任务责任人的最终决定。</p>
                      </div>
                      {committers.length > 0 ? <div className="committer-review-action">
                        <select aria-label="选择 Committer" value={reviewer} onChange={(event) => setReviewer(event.target.value)}>
                          {committers.map((user) => <option key={user.username} value={user.username}>{user.username}</option>)}
                        </select>
                        <button type="button" disabled={!reviewer || reviewBusy} onClick={() => void inviteReview()}>{reviewBusy ? "发送中…" : "邀请检视"}</button>
                      </div> : <div className="committer-empty">管理员尚未配置 Committer 名单</div>}
                      {reviewResult && <small className="committer-result">{reviewResult}</small>}
                      {taskReviews.length > 0 && <div className="committer-review-history">
                        {taskReviews.slice(0, 3).map((review) => <span key={review.id}>
                          <i className={review.status} aria-hidden />
                          <strong>{review.committer}</strong>
                          <small>{review.status === "completed" ? "已完成检视" : review.delivered ? "等待检视" : "通知未送达"}</small>
                        </span>)}
                      </div>}
                    </section>
                  )}
                  {!reviewAssignment && !canRequestReview && (
                    <div className="ws-insight-empty">当前没有 Committer 检视事项。</div>
                  )}
                  {task.token_usage ? (
                    <TokenUsage usage={task.token_usage} placement="detail" />
                  ) : <div className="ws-insight-empty">模型提供方暂未返回 Token 用量。</div>}
                  <TaskTimeline taskId={task.id} />
                </section>
              </div>
            </div>
          </>}
        </section>

        <aside className="ws-decision"
          aria-label="当前决策与关键操作">
          <div className="ws-pane-head ws-pane-head-side">
            {/* 右栏标题按阶段说实话:failed 时喊"无待办"是误导——
                此刻的待办就是看失败原因、决定重跑还是接手。 */}
            <div><span>NEXT ACTION</span><strong>{waiting ? "当前需要处理"
              : task.status === "failed" ? "任务已失败"
              : task.status === "verifying" ? "交付验证中"
              : "当前无待办"}</strong></div>
            <small>{waiting ? "完成后流程继续"
              : task.status === "failed" ? "看原因，决定重跑或接手"
              : task.status === "verifying" ? "流水线与自动修复由系统跟进"
              : "无需处理"}</small>
          </div>
          {waiting && canOperate && (
            /* 批注挂在提交按钮正上方(WaitingCard 内部),不放卡片外面:
               选项标签是内核的——它按标签给这次选择记账,前端改写会让
               记下的选择对不上用户点的(2026-08-09 实战事故)。所以
               "这次会带上哪几处"只能摆进人按下提交的那一眼里。 */
            <WaitingCard
              task={task}
              onDecided={() => { setNotesPulse((tick) => tick + 1); onChanged(); }}
              annotationIds={draftIds}
              unresolvedAnnotationCount={unresolvedNotes.length}
              repositoryAssigneeSelection={chainReview
                ? repositoryAssignees : undefined}
              deliverySelection={task.waiting?.recommended_view === "diff"
                ? deliverySelection : undefined}
              onLocateDelivery={task.waiting?.recommended_view === "diff"
                ? () => {
                    setWorkspaceView("materials");
                    setMaterialView("diff");
                    const first = items?.find((item) => item.kind === "diff");
                    if (first) setActive(first.name);
                  }
                : undefined}
              attachment={
                <>
                  {chainReview && (
                    <>
                      <RequirementTeamPicker
                        taskId={task.id}
                        owner={task.luban_account}
                        collaborators={task.collaborators}
                        onSaved={onChanged}
                      />
                      <RepositoryAssigneePicker
                        taskId={task.id}
                        repositories={task.requirement_graph!.repositories}
                        defaultAssignee={task.luban_account}
                        selection={repositoryAssignees}
                        onSelectionChange={setRepositoryAssignees}
                        onSaved={onChanged}
                      />
                    </>
                  )}
                  <AttachedNotes items={unresolvedNotes} onLocate={locate} />
                </>
              }
            />
          )}
          {waiting && !canOperate && (
            <div className="read-only-notice">
              该事项由 {task.luban_account ?? "其他成员"} 核对；
              你可以查看全部材料，但不能代为提交决定。
            </div>
          )}
          {/* failed 的重点是"为什么失败":原因置顶,重跑按钮紧随其后,
              不再先渲一段"当前没有待你决定的事项"把它压到最底。 */}
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
                  <RetryButton taskId={task.id} onDone={onChanged} />
                </div>
              )}
            </>
          )}
          {task.status === "canceled" && (
            <div className="task-canceled-note">
              <strong>任务已取消</strong>
              <span>执行已停止；此前产生的文档、代码和过程记录仍可查看。</span>
            </div>
          )}
          {!waiting && task.status !== "failed" && task.status !== "canceled" && (
            task.status === "verifying" ? (
              /* 验证中右栏不再空转:此刻用户最想知道的是"卡在哪/等谁",
                 waiting_on 有值就点名;修复停机时直接给重试入口。 */
              <div className="ws-verify-focus">
                <strong>交付验证进行中</strong>
                {task.delivery?.waiting_on ? (
                  <p className="ws-verify-focus-waiting">
                    {task.delivery.waiting_on}
                  </p>
                ) : (
                  <p>{task.detail
                    || "流水线运行与自动修复由系统跟进；需要人时会在这里出卡。"}</p>
                )}
                {canOperate && repairStopped(task) && (
                  <RetryButton taskId={task.id} onDone={onChanged} />
                )}
              </div>
            ) : (
              <div className="ws-idle">
                <strong>当前没有待你决定的事项</strong>
                <p>
                  {task.status === "running"
                    ? "模型正在推进；需要时可切到执行现场查看。"
                    : "材料、协作和运行记录都在左侧主视图。"}
                </p>
                {canOperate && task.status === "completed" && (
                  <RetryButton taskId={task.id} onDone={onChanged} />
                )}
              </div>
            )
          )}
        </aside>
      </div>
    </section>
  );
}
