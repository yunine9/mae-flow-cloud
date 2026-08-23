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
import { GitDiff } from "./GitDiff";
import { SteerBox } from "./SteerBox";
import { Annotatable } from "./Annotatable";
import { AnnotationPanel } from "./AnnotationPanel";
import { AttachedNotes } from "./AttachedNotes";
import { RequirementGraph } from "./RequirementGraph";
import { PrepushStatus } from "./PrepushStatus";
import { TokenUsage } from "./TokenUsage";
import { taskHealthFacts } from "./taskHealth";
import { relativeTime } from "./time";
import { startVisiblePolling } from "./visiblePolling";
import {
  EMPTY_REPOSITORY_SKILL_PICKER_STATE,
  RepositorySkillPicker,
  type RepositorySkillPickerState,
} from "./RepositorySkillPicker";
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
  canRequestReview,
  reviewAssignment,
  onChanged,
  onClose,
  onOpenTask,
}: {
  task: TaskSummary;
  viewerUsername: string;
  canOperate: boolean;
  canRequestReview: boolean;
  reviewAssignment?: ReviewRequest;
  onChanged: () => void;
  onClose: () => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const [items, setItems] = useState<ArtifactMeta[]>();
  const [unavailable, setUnavailable] = useState("");
  const [active, setActive] = useState("");
  const [materialView, setMaterialView] =
    useState<"source" | "doc" | "chain" | "diff">("doc");
  const [content, setContent] = useState("");
  const [branch, setBranch] = useState("");
  const [loading, setLoading] = useState(false);
  const [notes, setNotes] = useState<Annotation[]>([]);
  const [checks, setChecks] = useState<AnchorCheck[]>([]);
  const [reply, setReply] =
    useState<{ texts: string[]; truncated: boolean } | undefined>();
  const [notesPulse, setNotesPulse] = useState(0);
  const [attachNotes, setAttachNotes] = useState(true);
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
  const [chainSkillPicker, setChainSkillPicker] =
    useState<RepositorySkillPickerState>(EMPTY_REPOSITORY_SKILL_PICKER_STATE);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(
    task.status === "paused" ? "collaboration" : "materials",
  );

  useEffect(() => {
    setMaterialView("doc");
    setWorkspaceView(task.status === "paused" ? "collaboration" : "materials");
    setChainSkillPicker(EMPTY_REPOSITORY_SKILL_PICKER_STATE);
  }, [task.id]);

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
      setActive((current) => result.items?.some((item) => item.name === current)
        ? current
        : result.items?.[0]?.name ?? "");
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
  const hasRequirementGraph = (task.requirement_graph?.repositories.length ?? 0) > 1;
  const materialHeading = materialView === "source"
    ? { kicker: "REQUEST SOURCE", title: "需求原文" }
    : materialView === "chain"
    ? { kicker: "CHAIN OVERVIEW", title: "仓间依赖" }
    : materialView === "diff"
      ? { kicker: "WORKTREE CHANGES", title: "工作区变更" }
      : { kicker: "WORK DOCUMENTS", title: "过程文档" };
  const waiting = task.status === "waiting_for_human" && task.waiting;
  const collaborationVisible = canOperate && [
    "running", "pausing", "paused", "waiting_for_human", "verifying",
  ].includes(task.status);
  const chainReview = !!waiting
    && task.requirement_graph?.stage === "analysis"
    && (task.requirement_graph.repositories.length ?? 0) > 1
    // 多仓分析过程中的普通澄清也处于 analysis；仓内能力只应在最终
    // Chain 方案检视卡出现，避免尚未定案时就让人误以为即将下发。
    && (waiting.question?.questions?.some((question) =>
      question.options?.some((option) => option.includes("确认并生成任务"))) ?? false);
  const chainRepositories = task.repositories?.length
    ? task.repositories
    : task.requirement_graph?.repositories.map((repository) => repository.url) ?? [];
  const controllable = canOperate && [
    "queued", "running", "pausing", "paused", "waiting_for_human", "verifying",
  ].includes(task.status);
  const health = taskHealthFacts(task, viewerUsername);
  const visibleProgress = workspaceProgress(task);

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
        <button type="button" className="ws-back" onClick={onClose} autoFocus>
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
          </div>
          <strong id="task-workspace-title">{task.title ?? task.requirement}</strong>
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
        <TaskProgress progress={visibleProgress} showDetailedStep context={health && <>
          <span title={health.next}><i>下一步</i>{health.next}</span>
          <span><i>责任</i>{health.actor}</span>
          <span title={health.last_progress_at}><i>更新</i>
            {relativeTime(health.last_progress_at) || "暂无记录"}</span>
        </>} />
      </div>
      <PrepushStatus prepush={task.delivery?.prepush} placement="workspace" />

      <nav className="ws-workspace-nav" aria-label="任务工作台视图">
        {([
          ["materials", "交付材料", "文档、依赖与代码变更"],
          ["insights", "批注与检视", drafts.length
            ? `${drafts.length} 条批注待提交` : notes.length
              ? `${notes.length} 条批注` : "圈选原文、协作检视"],
          ["collaboration", "开发协作", collaborationVisible
            ? "补充主任务或主动接管" : assistantUnavailableReason(task)],
          ["execution", "执行现场", task.focus?.headline ?? "心流与原始事件"],
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
                onClick={() => { setMaterialView("diff"); if (changes[0]) setActive(changes[0].name); }} disabled={!changes.length}>
                <span>工作区变更</span><i>{changes.length}</i>
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
                  <span>用户提交的完整内容</span>
                  <small>{task.requirement.split(/\r?\n/).length} 行 · {task.requirement.length} 字符</small>
                </div>
                <Markdown text={task.requirement} />
              </article>
            ) : materialView === "chain" ? (
              <RequirementGraph task={task} onOpenTask={onOpenTask}
              />
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
                onAdded={() => setNotesPulse((tick) => tick + 1)}
              >
                {materialView === "diff"
                  ? <GitDiff text={content} branch={branch} />
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
                <SteerBox task={task} onChanged={() => {
                  setLivePulse((value) => value + 1);
                  onChanged();
                }} />
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
              <small>日常看心流，需要取证时切原始 SSE</small>
            </div>
            <div className="ws-primary-scroll ws-execution-view">
              <ExecutionPanel task={task} defaultOpen />
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
                    running={task.status === "running"}
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
                  <TaskTimeline taskId={task.id} defaultOpen />
                  {task.token_usage ? (
                    <div className="ws-usage-summary ws-usage-expanded" title="来自模型提供方的真实用量统计">
                      <span>模型用量</span>
                      <TokenUsage usage={task.token_usage} placement="history" />
                    </div>
                  ) : <div className="ws-insight-empty">模型提供方暂未返回 Token 用量。</div>}
                </section>
              </div>
            </div>
          </>}
        </section>

        <aside className={`ws-decision${chainReview ? " has-chain-skills" : ""}`}
          aria-label="当前决策与关键操作">
          <div className="ws-pane-head ws-pane-head-side">
            <div><span>NEXT ACTION</span><strong>{waiting ? "当前需要处理" : "当前无待办"}</strong></div>
            <small>{waiting ? "完成后流程继续" : "无需处理"}</small>
          </div>
          {waiting && canOperate && (
            /* 批注挂在提交按钮正上方(WaitingCard 内部),不放卡片外面:
               选项标签是内核的——它按标签给这次选择记账,前端改写会让
               记下的选择对不上用户点的(2026-08-09 实战事故)。所以
               "这次会带上哪几处"只能摆进人按下提交的那一眼里。 */
            <WaitingCard
              task={task}
              onDecided={() => { setNotesPulse((tick) => tick + 1); onChanged(); }}
              annotationIds={attachNotes ? draftIds : undefined}
              repositorySkillSelection={chainReview
                ? chainSkillPicker.selection : undefined}
              attachment={
                <>
                  {chainReview && (
                    <RepositorySkillPicker
                      repositories={chainRepositories}
                      baseline={task.baseline}
                      initialSkills={task.repository_skills}
                      presentation="decision"
                      state={chainSkillPicker}
                      onStateChange={setChainSkillPicker}
                    />
                  )}
                  <AttachedNotes items={drafts} attached={attachNotes}
                                 onToggle={setAttachNotes} onLocate={locate} />
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
          {!waiting && (
            <div className="ws-idle">
              <strong>当前没有待你决定的事项</strong>
              <p>
                {task.status === "running"
                  ? "模型正在推进；需要时可切到执行现场查看。"
                  : "材料、协作和运行记录都在左侧主视图。"}
              </p>
              {canOperate && (task.status === "failed"
                || task.status === "completed" || repairStopped(task)) && (
                <RetryButton taskId={task.id} onDone={onChanged} />
              )}
            </div>
          )}
          {controlError && <div className="task-control-error">{controlError}</div>}
          {task.status === "canceled" && (
            <div className="task-canceled-note">
              <strong>任务已取消</strong>
              <span>执行已停止；此前产生的文档、代码和过程记录仍可查看。</span>
            </div>
          )}
          {task.status === "failed" && task.detail && (
            <div className="alert">
              <strong>任务执行失败</strong>
              <span>{task.detail}</span>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
