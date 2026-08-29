/**
 * 单任务处置台：摘要适合扫读，展开后集中承载审批、交付事实、
 * 外部动作与事件现场。服务端镜像是唯一事实来源。
 */

import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Markdown } from "./markdown";
import {
  decide,
  listActions,
  rerunTaskFromStart,
  listTimeline,
  retryTask,
  repairStopped,
  statusText,
  tailEvents,
  type ExternalAction,
  type SemanticEvent,
  type SseConnectionState,
  type TaskSummary,
  type TimelineEntry,
} from "./api";
import { formatWait, URGENT_MINUTES, waitedMs } from "./taskTime";
import { responsibleOf } from "./teamOps";
import { useStickyBottom } from "./stickyBottom";
import {
  eventFilterCounts,
  eventWindow,
  filterEvents,
  isErrorEvent,
  type EventFilter,
} from "./eventView";
import type { RepositorySkillSelection } from "./RepositorySkillPicker";
import type { RepositoryAssigneeSelection } from "./RepositoryAssigneePicker";
import type { GitDiffSelection } from "./GitDiff";
import { PrepushStatus } from "./PrepushStatus";
import { TokenUsage } from "./TokenUsage";
import {
  formatLocalClock,
  formatLocalDateTime,
  instantMs,
} from "./time";

export function TaskCard({
  task,
  onChanged,
  focused = false,
  canOperate = true,
  decisionMode = "form",
  onOpenArtifacts,
}: {
  task: TaskSummary;
  onChanged: () => void;
  focused?: boolean;
  canOperate?: boolean;
  decisionMode?: "form" | "signal";
  onOpenArtifacts?: () => void;
}) {
  const showDecisionForm = decisionMode === "form";
  const [expanded, setExpanded] = useState(
    (showDecisionForm && task.status === "waiting_for_human") || focused,
  );

  useEffect(() => {
    if ((showDecisionForm && task.status === "waiting_for_human") || focused) {
      setExpanded(true);
    }
  }, [task.status, focused, showDecisionForm]);

  const waitingQuestions = task.waiting?.question?.questions?.length ?? 0;
  const chainReview = showDecisionForm
    && task.status === "waiting_for_human"
    && (task.requirement_graph?.repositories.length ?? 0) > 1;

  return (
    <article
      id={`task-${task.id}`}
      className={`task-card status-${task.status}${expanded ? " expanded" : ""}${focused ? " focused" : ""}`}
    >
      <button
        type="button"
        className="task-summary"
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
      >
        <span className="task-status-rail" aria-hidden />
        <span className="task-summary-body">
          <span className="task-overline">
            {task.ticket && <span className="task-ticket">{task.ticket}</span>}
            <span className="task-id" title="平台内部编号">{task.id}</span>
            <span className={`pill ${task.status}${decisionMode === "signal" && task.status === "waiting_for_human" ? " team-signal" : ""}`}>
              <i aria-hidden />
              {decisionMode === "signal" && task.status === "waiting_for_human"
                ? "待拍板"
                : statusText(task)}
            </span>
            <WaitBadge task={task} personal={showDecisionForm} />
            <span className="task-created">{formatLocalDateTime(task.created_at)}</span>
          </span>
          <strong className="task-title">{task.title ?? task.requirement}</strong>
          <span className="task-ownership">
            <span>责任人 · {responsibleOf(task) ?? "未指定"}</span>
          </span>
          {task.focus && (
            <span className={`task-focus task-focus-${task.focus.kind}`}>
              <i aria-hidden />
              <strong>{task.focus.headline}</strong>
              <span>下一步 · {task.focus.next_action}</span>
            </span>
          )}
          {/* 收起态也要说清"为什么停/在等什么":原来失败原因和等待
              项都藏在展开区,列表上只剩一颗红/灰 pill,任务看着像在
              正常推进。一行摘要,点开看全文。 */}
          {!expanded && task.status === "failed" && task.detail && (
            <span className="task-key-line danger">{task.detail}</span>
          )}
          {!expanded && task.status === "verifying"
            && (repairStopped(task) || task.delivery?.waiting_on) && (
            <span className="task-key-line attention">
              {repairStopped(task)
                ? `自动修复已停，需要你介入：${task.delivery?.stalled
                  ?? task.delivery?.loop?.diagnosis ?? task.detail ?? ""}`
                : `正在等：${task.delivery!.waiting_on}`}
            </span>
          )}
          {(task.requirement_graph?.repositories.length ?? 0) > 1 && (
            <span className="task-chain-overview">
              <span className="task-graph-summary">
                <b>{task.requirement_graph!.repositories.length} 个仓库</b>
                <i aria-hidden>·</i>
                <span>{task.requirement_graph!.stage === "analysis"
                  ? task.status === "waiting_for_human"
                    ? task.requirement_graph!.dependencies.length > 0
                      ? `${task.requirement_graph!.dependencies.length} 条硬依赖待检视`
                      : "仓间可并行，方案待检视"
                    : "正在核对职责与依赖"
                  : `${task.requirement_graph!.dependencies.length} 条开发依赖`}</span>
              </span>
              <span className="task-repo-list" aria-label="涉及仓库">
                {task.requirement_graph!.repositories.map((repository) => (
                  <span key={repository.id} title={repository.url}>
                    <i aria-hidden />{repository.name}
                    {repository.assignee && <b>· {repository.assignee}</b>}
                  </span>
                ))}
              </span>
            </span>
          )}
          {(task.blocked_by?.length ?? 0) > 0 && task.status === "queued" && (
            <span className="task-dependency-wait">等待前置任务完成后自动开始</span>
          )}
          {task.progress && (
            <TaskProgress
              progress={task.progress}
              showDetailedStep={decisionMode === "form"}
            />
          )}
          <PrepushStatus prepush={task.delivery?.prepush} />
          <TokenUsage usage={task.token_usage} />
        </span>
        <span className="task-chevron" aria-hidden>
          <svg viewBox="0 0 20 20">
            <path d="m7.5 5 5 5-5 5" />
          </svg>
        </span>
      </button>

      {decisionMode === "signal" && task.status === "waiting_for_human" && (
        <div className="team-decision-signal">
          <i aria-hidden />
          <strong>等待负责人拍板</strong>
          <span>
            {task.luban_account ?? "未分配负责人"}
            {waitingQuestions > 0 ? ` · ${waitingQuestions} 个决策项` : ""}
          </span>
        </div>
      )}

      <div className="task-meta">
        {onOpenArtifacts && !chainReview && (
          <button type="button" className="panel-link" onClick={onOpenArtifacts}>
            <span>{chainReview ? "检视方案与依赖图" : "进入任务工作台"}</span>
            <svg viewBox="0 0 16 16" aria-hidden>
              <path d="M6 3.5h6.5V10M12.25 3.75 5 11" />
            </svg>
          </button>
        )}
        {task.delivery?.mr_url && (
          <a href={task.delivery.mr_url} target="_blank" rel="noreferrer">
            <span>合入请求 · {task.delivery.mr_state}</span>
            <svg viewBox="0 0 16 16" aria-hidden>
              <path d="M6 3.5h6.5V10M12.25 3.75 5 11" />
            </svg>
          </a>
        )}
        {task.delivery?.pipeline && (
          <span className="meta-fact">流水线 · {task.delivery.pipeline}</span>
        )}
        {/* 百字诊断不塞 meta chip(最重要的原因不该用最弱的视觉级):
            这里只留结论,全文在展开区的 alert 里。 */}
        {task.delivery?.skipped && (
          <span className="meta-fact" title={task.delivery.skipped}>
            交付已阻止
          </span>
        )}
        {task.luban_account && (
          <span className="meta-fact">责任人 · {responsibleOf(task)}</span>
        )}
      </div>

      {expanded && (
        <div className="task-detail-body">
          {task.status === "failed" && task.detail && (
            <div className="alert">
              <strong>任务执行失败</strong>
              <span>{task.detail}</span>
            </div>
          )}
          {task.delivery?.skipped && task.detail !== task.delivery.skipped && (
            <div className="alert">
              <strong>交付已阻止</strong>
              <span>{task.delivery.skipped}</span>
            </div>
          )}
          {task.notify && !task.notify.delivered && task.notify.attempts > 0 && (
            <div className="alert">
              <strong>小鲁班通知未送达</strong>
              <span>
                已尝试 {task.notify.attempts} 次，待办仍然有效，请在本页处理。
              </span>
            </div>
          )}
          {task.baseline_build?.status === "failed" && (
            <div className="alert">
              <strong>基线编译失败(环境预热)</strong>
              <span>
                环境或上游问题,与本单增量无关;详情在工作台执行现场。
                {task.baseline_build.detail
                  ? ` ${task.baseline_build.detail.slice(0, 160)}` : ""}
              </span>
            </div>
          )}
          {repairStopped(task) && (
            <div className="alert">
              <strong>
                {task.delivery?.stalled ? "自动验证已停，需要你介入"
                  : "自动修复已停，需要你介入"}
              </strong>
              <span>
                {task.delivery?.stalled ?? task.delivery?.loop?.diagnosis
                  ?? task.detail ?? "请查看流水线日志确认原因。"}
                {" "}办完之后点「重跑续推」，机器接着干。
              </span>
              {/* 诊断是会话的收口发言,可能在聊别的事(实锤:最后一轮在补
                  文档章节)。流水线到底红在哪必须单独亮,不靠诊断捎带。 */}
              {task.delivery?.loop?.failure && (
                <span className="alert-failure">
                  流水线失败原文:{task.delivery.loop.failure}
                </span>
              )}
            </div>
          )}
          {/* 还在等的时候也要说清在等什么。这行原来根本不渲染:页面只有
              "验证中"三个字,底下藏着的"某一项流水线结果一直没给"谁都
              看不到,任务看着像马上要成了。 */}
          {!repairStopped(task) && task.status === "verifying"
            && task.delivery?.waiting_on && (
            <div className="verify-waiting">
              <strong>正在等</strong>
              <span>{task.delivery.waiting_on}</span>
            </div>
          )}
          {canOperate && (task.status === "failed"
            || task.status === "completed" || task.status === "canceled"
            || repairStopped(task)) && (
            <RetryButton
              taskId={task.id}
              onDone={onChanged}
              allowFromStart={["completed", "failed", "canceled"]
                .includes(task.status)}
            />
          )}
          {chainReview && canOperate && (
            <div className="chain-review-entry">
              <span>CHAIN REVIEW</span>
              <strong>跨仓方案已经生成，先看依赖再确认</strong>
              <p>仓库职责、硬依赖和交付顺序都在任务工作台中；确认后才会拆成各仓交付任务。</p>
              <button type="button" onClick={onOpenArtifacts}>检视方案与依赖图</button>
            </div>
          )}
          {showDecisionForm && canOperate && !chainReview
            && task.status === "waiting_for_human" && task.waiting && (
            task.waiting.recommended_view === "diff" ? (
              /* 交付清单必须对着真实 diff 勾选,而勾选面板只在工作台的
                 「本任务变更」里。列表页若直接渲决策表单,提交键会永远
                 停在"正在读取交付文件清单"(push 确认卡实锤死锁),
                 所以这里只给入口不给表单。 */
              <div className="chain-review-entry">
                <span>DELIVERY REVIEW</span>
                <strong>推送前请检视代码</strong>
                <p>本次全部代码增量等待你检视;请到任务工作台逐文件检视 diff,核对交付清单后提交决定。</p>
                {onOpenArtifacts && (
                  <button type="button" onClick={onOpenArtifacts}>
                    去检视代码
                  </button>
                )}
              </div>
            ) : (
              <WaitingCard task={task} onDecided={onChanged} />
            )
          )}
          {showDecisionForm && !canOperate && task.status === "waiting_for_human" && (
            <div className="read-only-notice">
              该事项由 {task.luban_account ?? "其他成员"} 核对；你可以查看进展，但不能代为提交决定。
            </div>
          )}
          <div className="task-utilities">
            {/* 现场回收后代码差异那类面板会空着,不说清楚人会以为坏了。
                说明里必须点名"什么还在"——只写"已回收"像是历史没了。 */}
            {task.workspace_reclaimed_at && (
              <div className="read-only-notice">
                任务现场已于 {formatLocalDateTime(task.workspace_reclaimed_at)} 回收
                （超过保留期，释放代码克隆等可再生的大件）。
                过程记录、交付账本、流水线证据与批注都还在，代码差异不再可看。
              </div>
            )}
            <ExecutionPanel task={task} />
            <TaskTimeline taskId={task.id} />
            {/* 外部动作台账(ActionLedger)不再上页面:一屏四块信息密度
                过载,而它是排障口不是日常口。组件与 GET /tasks/:id/actions
                都还在,要查幂等键/绑定 SHA 时直接调接口。 */}
          </div>
        </div>
      )}
    </article>
  );
}

/** 等待时长:久等升红。父层每 1.5 秒刷新任务列表,这里跟着重算,
 * 不用自己挂计时器。 */
export function WaitBadge({ task, personal }: { task: TaskSummary; personal: boolean }) {
  const waited = waitedMs(task);
  if (waited < 0) return null;
  const urgent = waited >= URGENT_MINUTES * 60_000;
  return (
    <span className={"wait-badge" + (urgent ? " urgent" : "")}>
      <i aria-hidden />
      {personal ? "等你" : "已等待"} {formatWait(waited)}
    </span>
  );
}

export function TaskProgress({
  progress,
  showDetailedStep,
  context,
  onPhaseClick,
}: {
  progress: NonNullable<TaskSummary["progress"]>;
  showDetailedStep: boolean;
  context?: ReactNode;
  /** 工作台传入:点阶段名弹该阶段执行方案。列表页不传,保持纯展示。 */
  onPhaseClick?: (phase: string) => void;
}) {
  const currentLabel = showDetailedStep
    ? progress.step ?? progress.current_phase
    : progress.current_phase;
  const milestone = progress.milestone;
  const milestoneEvent = milestone
    ? ({
        started: "开始",
        completed: "完成",
        blocked: "受阻",
        start: "开始",
        complete: "完成",
        block: "受阻",
      } as Record<string, string>)[milestone.event]
    : undefined;
  const showMilestone = Boolean(
    milestone?.task_id && milestone.title && milestoneEvent,
  );
  return <span className="task-progress" aria-label={`当前阶段：${currentLabel}`}>
    <span className="task-progress-caption">
      <span>当前进度</span>
      {context && <span className="task-progress-caption-context">{context}</span>}
      <strong>{currentLabel}</strong>
    </span>
    {showMilestone && milestone && (
      <span className={`task-milestone ${milestone.event}`}>
        <i aria-hidden />
        <span className="task-milestone-summary">
          任务 {milestone.task_id} · {milestone.title} · {milestoneEvent}
        </span>
        {milestone.reason && (
          <span className="task-milestone-reason">· {milestone.reason}</span>
        )}
      </span>
    )}
    <span className="task-phase-track">
      {progress.phases.map((phase, index) => {
        const state = index < progress.current_index
          ? "past" : index === progress.current_index ? "current" : "future";
        return <span className={`task-phase ${state}`} key={phase}
          {...(onPhaseClick ? {
            role: "button" as const,
            tabIndex: 0,
            title: "查看该阶段执行方案",
            style: { cursor: "pointer" },
            onClick: () => onPhaseClick(phase),
            onKeyDown: (event: ReactKeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onPhaseClick(phase);
              }
            },
          } : {})}>
          <i aria-hidden />
          <span>{phase}</span>
        </span>;
      })}
    </span>
  </span>;
}

/** 决策卡类型标题。只映射云端原生步骤(名字是本仓定的);内核步骤
 * id 不猜译——猜错比不译更糟,通用标题足够,正文会说明这是什么决定。 */
function waitingStepTitle(task: TaskSummary): string | undefined {
  const step = task.waiting?.step ?? "";
  if (step === "cloud_push_confirm") return "推送前确认：检视代码与交付范围";
  if (task.waiting?.recommended_view === "diff") return "代码检视";
  return undefined;
}

export function WaitingCard({
  task,
  onDecided,
  annotationIds,
  unresolvedAnnotationCount,
  attachment,
  repositorySkillSelection,
  repositoryAssigneeSelection,
  deliverySelection,
  onLocateDelivery,
}: {
  task: TaskSummary;
  onDecided: () => void;
  /** 本次仍待发送的 draft 批注；sent 已经送达，不能重复附带。 */
  annotationIds?: string[];
  /** 尚未闭环的 draft + sent 数量，用于检视引导和关闭分支门禁提示。 */
  unresolvedAnnotationCount?: number;
  /** 批注块。挂在提交按钮正上方而不是卡片外面:选项标签是内核的
   * (它按标签给这次选择记账,前端改写会让记下的选择对不上用户点的),
   * 所以"这次会带上哪几处"只能摆在人按下提交的那一眼里。 */
  attachment?: ReactNode;
  /** 仅 Chain 的“确认并生成任务”消费；未扫描/需要修改都不发送。 */
  repositorySkillSelection?: RepositorySkillSelection;
  /** Chain 的逐仓分工；确认拆单前必须全部指向已就绪成员。 */
  repositoryAssigneeSelection?: RepositoryAssigneeSelection;
  /** 代码检视里的文件级交付清单；由工作区变更面板的真实勾选产生。 */
  deliverySelection?: GitDiffSelection;
  /** 跳到勾选面板(工作台的「本任务变更」)。列表页没有勾选面板,
   * 不传即不渲跳转钮。 */
  onLocateDelivery?: () => void;
}) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  useEffect(() => setContextOpen(false), [task.waiting?.waiting_id]);
  const [conflict, setConflict] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const questions = task.waiting?.question?.questions ?? [];
  const choiceEffects = task.waiting?.choice_effects ?? [];
  const feedbackAnswers = new Set(choiceEffects
    .filter((effect) => effect.handles_feedback)
    .flatMap((effect) => effect.answers));
  const closingAnswers = new Set(choiceEffects
    .filter((effect) => effect.closes_feedback)
    .flatMap((effect) => effect.answers));
  const allChoiceAnswers = new Set(choiceEffects.flatMap((effect) => effect.answers));
  const feedbackOption = questions.flatMap((item) => {
    const options = item.options ?? [];
    if (!options.some((option) => allChoiceAnswers.has(option))) return [];
    const exact = options.find((option) => feedbackAnswers.has(option));
    if (exact) return [exact];
    const nonClosing = options.filter((option) => !closingAnswers.has(option));
    return [nonClosing.find((option) =>
      /需要.*(?:调整|修改)|返工|补充/.test(option)) ?? nonClosing[0]].filter(Boolean);
  })[0];
  const feedbackLabel = feedbackOption?.replace(/[（(].*$/, "") ?? "需要调整";
  const attachmentCount = unresolvedAnnotationCount
    ?? annotationIds?.length ?? 0;
  const requiresDeliverySelection = task.waiting?.recommended_view === "diff";
  const deliverySelectionChanged = !!deliverySelection
    && (deliverySelection.selectedPaths.length
      !== deliverySelection.committedPaths.length
      || deliverySelection.committedPaths.some((path) =>
        !deliverySelection.selectedPaths.includes(path)));

  const answerOf = (question: string) => picked[question] ?? "";
  const optional = (question: string) =>
    /可忽略|若上题|如无|可跳过|可不填/.test(question);
  const confirmsChainChoice = Object.values(picked).some((answer) =>
    answer.includes("确认并生成任务"));
  // 勾选与 commit 不同不再算冲突(2026-08-28 用户拍板易用性):服务端
  // 会按勾选机械整理提交并直推,"通过"就是一键走完。只有未闭环批注
  // 仍然拦"通过"——那是真有意见没处理。
  const reviewChoiceConflict = attachmentCount > 0
    && questions.some((item) => {
    const options = item.options ?? [];
    if (!options.some((option) => allChoiceAnswers.has(option))) return false;
    const answer = answerOf(item.question);
    return Boolean(answer) && closingAnswers.has(answer);
  });
  const selectedReviewAnswer = questions
    .filter((item) => (item.options ?? []).some((option) =>
      allChoiceAnswers.has(option)))
    .map((item) => answerOf(item.question))
    .find(Boolean);
  const selectedEffect = choiceEffects.find((effect) =>
    effect.answers.includes(selectedReviewAnswer ?? ""));
  const hasCustomPrimaryAnswer = questions.some((item) =>
    (item.options?.length ?? 0) > 0
    && !picked[item.question]
    && !!custom[item.question]?.trim());
  const isReviewDecision = choiceEffects.some((effect) =>
    effect.closes_feedback);
  const ready = questions.every((item) => {
    const options = item.options ?? [];
    const answered = options.length
      ? picked[item.question] || custom[item.question]?.trim()
      : custom[item.question]?.trim();
    return optional(item.question) || Boolean(answered);
  }) && (!requiresDeliverySelection || !!deliverySelection)
    && !repositorySkillSelection?.scanning
    && (!repositorySkillSelection?.scanned
      || !!repositorySkillSelection.catalogToken)
    && (!confirmsChainChoice || !repositoryAssigneeSelection
      || repositoryAssigneeSelection.ready)
    && !reviewChoiceConflict
    && !submitting;

  const annotationKey = annotationIds?.join("\0") ?? "";
  const choiceKey = [...feedbackAnswers, ...closingAnswers].join("\0");
  useEffect(() => {
    // 只有未闭环批注才把默认选项扳向"需要调整";纯勾选差异不劫持
    // 用户的选择(它已经能一键"通过"机械整理直推)。
    if (!attachmentCount
        || !choiceEffects.some((effect) =>
      effect.closes_feedback)) return;
    setPicked((current) => {
      let changed = false;
      const next = { ...current };
      for (const item of questions) {
        if (current[item.question]) continue;
        const options = item.options ?? [];
        if (!options.some((option) => allChoiceAnswers.has(option))) continue;
        const revision = options.find((option) => feedbackAnswers.has(option))
          ?? options.find((option) =>
            !closingAnswers.has(option)
            && /需要.*(?:调整|修改)|返工|补充/.test(option))
          ?? options.find((option) => !closingAnswers.has(option));
        if (revision) {
          next[item.question] = revision;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [task.waiting?.waiting_id, annotationKey, choiceKey,
    deliverySelectionChanged]);

  function pickOption(question: string, option: string) {
    setPicked({ ...picked, [question]: option });
  }

  function openCustom(question: string) {
    setCustomOpen({ ...customOpen, [question]: true });
  }

  async function submit() {
    if (!ready || submitting) return;
    const selectedOptions: Record<string, string> = {};
    const freeResponses: Record<string, string> = {};
    for (const item of questions) {
      const options = item.options ?? [];
      if (options.length && picked[item.question]) {
        selectedOptions[item.question] = picked[item.question];
      }
      const explanation = custom[item.question]?.trim();
      if (explanation) freeResponses[item.question] = explanation;
    }
    const confirmsChain = Object.values(selectedOptions).some((answer) =>
      answer.includes("确认并生成任务"));
    const repositorySkills = confirmsChain
      && repositorySkillSelection?.scanned
      && repositorySkillSelection.catalogToken
      ? {
          catalogToken: repositorySkillSelection.catalogToken,
          // 空数组有业务含义：明确清空父任务的预选，不能转成 undefined。
          selectedIds: repositorySkillSelection.selectedIds,
        }
      : undefined;
    setSubmitting(true);
    setConflict("");
    try {
      const result = await decide(
        task.id,
        task.waiting!.state_version,
        selectedOptions,
        freeResponses,
        notes,
        annotationIds,
        repositorySkills,
        confirmsChain ? repositoryAssigneeSelection?.assignments : undefined,
        requiresDeliverySelection ? deliverySelection?.selectedPaths : undefined,
      );
      if (result.conflict) setConflict(result.conflict);
      onDecided();
    } catch (reason) {
      setConflict(reason instanceof Error ? reason.message : "决定提交失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  const submitLabel = submitting ? "正在提交…"
    : repositorySkillSelection?.scanning ? "等待能力读取"
      : hasCustomPrimaryAnswer ? "提交自定义处理方式"
        : selectedEffect?.handles_feedback
          ? "交给 Agent 调整后再检视"
          : requiresDeliverySelection && deliverySelectionChanged
            ? "按此范围自动整理并继续"
            : requiresDeliverySelection
              ? "确认推送范围并继续"
              : "提交决定";

  return (
    <section className="decision-card" aria-labelledby={`decision-${task.id}`}>
      <header className="decision-head">
        <div>
          <span className="decision-kicker">ACTION REQUIRED</span>
          {/* 标题按卡类型说话,原始步骤 id(cloud_push_confirm 之类)
              不再印给人看——认不出的类型就只保留通用标题,卡的正文
              自会说明这是什么决定。 */}
          <h3 id={`decision-${task.id}`}>{waitingStepTitle(task) ?? "需要你的决策"}</h3>
        </div>
        {/* 几乎恒为 1 题:徽标只在真有多题时才有信息量。 */}
        {questions.length > 1 && (
          <span className="decision-count">{questions.length} 个问题</span>
        )}
      </header>

      {task.waiting?.context && (() => {
        /* 长背景(推送确认的文件清单动辄上百行)默认折叠只露开头——
           重点(要我做什么、较上次变了什么)在前几行,整版清单是
           留档不是必读;需要时一键展开。 */
        const contextText = rewritePanelPath(task.waiting.context, task.id);
        const contextLines = contextText.split("\n").length;
        const collapsible = contextLines > 16;
        return (
          <div className="waiting-context">
            <div className="context-label">决策背景</div>
            <div className={`waiting-context-body${
              collapsible && !contextOpen ? " clamped" : ""}`}>
              <Markdown text={contextText} />
            </div>
            {collapsible && (
              <button type="button" className="context-toggle"
                onClick={() => setContextOpen((value) => !value)}>
                {contextOpen ? "收起背景" : `展开全部背景（共 ${contextLines} 行）`}
              </button>
            )}
          </div>
        );
      })()}

      <div className="question-list">
        {questions.map((item, index) => {
          const options = item.options ?? [];
          const compact = options.length <= 4
            && options.every((option) => option.length <= 14);
          const customActive =
            !!customOpen[item.question] && !!custom[item.question]?.trim();
          const skippable = optional(item.question);
          const reviewQuestion = options.some((option) =>
            allChoiceAnswers.has(option));
          return (
            <fieldset className="question" key={item.question}>
              <legend>
                <span className="question-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="question-text">
                  {item.question || "需要你确认"}
                </span>
                {skippable && <span className="q-optional">可跳过</span>}
              </legend>
              <div className={`options ${compact ? "compact" : "cards"}`}>
                {options.map((option) => {
                  const chosen = picked[item.question] === option;
                  const split = option.match(/^([^（(]+)[（(](.+)[）)]\s*$/);
                  const effect = choiceEffects.find((candidate) =>
                    candidate.answers.includes(option));
                  const inferredAdjustment = reviewQuestion
                    && !closingAnswers.has(option);
                  const consequence = effect?.closes_feedback
                    ? "将关闭本轮检视并进入下一步"
                    : effect?.handles_feedback && effect.allows_source_edit
                      ? "将进入返工，处理意见后重新检视"
                      : effect?.handles_feedback || inferredAdjustment
                        ? "将留在本轮，处理意见后重新检视"
                        : "";
                  const [title, hint] = split
                    ? [split[1].trim(), split[2].trim()]
                    : [option, consequence];
                  return (
                    <button
                      type="button"
                      key={option}
                      className={`option${chosen ? " picked" : ""}`}
                      role="radio"
                      aria-checked={chosen}
                      onClick={() => pickOption(item.question, option)}
                    >
                      <span className={`radio${chosen ? " on" : ""}`} />
                      <span className="option-body">
                        <span className="option-title">{title}</span>
                        {hint && <span className="option-hint">{hint}</span>}
                      </span>
                    </button>
                  );
                })}
                {!customOpen[item.question] && (
                  <button
                    type="button"
                    className="option custom-entry"
                    onClick={() => openCustom(item.question)}
                  >
                      <span className="radio" />
                      <span className="option-body">
                        <span className="option-title">{options.length
                          ? picked[item.question]
                            ? "补充说明"
                            : "以上都不合适，直接回答"
                          : "填写答复"}</span>
                        <span className="option-hint">{options.length
                          ? picked[item.question]
                            ? "说明会随决定提交，但不会改变所选流程分支"
                            : "你的文字将作为本题主答案，不会套用任一选项"
                          : "填写本题的具体答案"}</span>
                      </span>
                  </button>
                )}
              </div>
              {customOpen[item.question] && (
                <div className="custom-answer">
                  <textarea
                    className={`custom-input${customActive ? " picked" : ""}`}
                    placeholder={options.length
                      ? picked[item.question]
                        ? "补充原因、修改点或约束…"
                        : "写下选项之外的正确处理方式…"
                      : "写下你的答复…"}
                    value={custom[item.question] ?? ""}
                    autoFocus
                    onChange={(change) => setCustom({
                      ...custom,
                      [item.question]: change.target.value,
                    })}
                  />
                  <span>{options.length
                    ? picked[item.question]
                      ? "这段文字仅作为补充说明；流程走向以上方选项为准。"
                      : "这段文字将作为主答案直接交给 Agent；系统不会替你选择错误分支。"
                    : "这段文字将作为开放题答案提交。"}</span>
                </div>
              )}
            </fieldset>
          );
        })}
      </div>

      {attachment && (
        <fieldset className="decision-attachment" disabled={submitting}>
          {attachment}
        </fieldset>
      )}

      {attachmentCount > 0 && isReviewDecision && (
        <div className={`review-decision-guidance${
          reviewChoiceConflict ? " conflict" : ""
        }`} role={reviewChoiceConflict ? "alert" : "status"}>
          <strong>当前有 {attachmentCount} 条检视意见未闭环</strong>
          <span>{!feedbackOption
            ? "当前卡片缺少调整选项，请用“自定义答复”明确要求继续调整。"
            : reviewChoiceConflict
            ? `建议选择“${feedbackLabel}”。当前选项会关闭本轮检视，不会处理这些意见。`
            : selectedReviewAnswer === feedbackOption
              ? `已选择“${feedbackLabel}”，提交后会继续处理这些意见。`
              : `建议选择“${feedbackLabel}”，提交后会继续处理这些意见。`}</span>
        </div>
      )}

      {requiresDeliverySelection && (
        <div className={`delivery-decision-guidance${
          deliverySelectionChanged ? " changed" : ""}`} role="status">
          <strong>{deliverySelection
            ? `交付文件 ${deliverySelection.selectedPaths.length} / ${deliverySelection.allPaths.length}`
            : "代码待检视"}</strong>
          <span>{!deliverySelection
            /* 重心是"请检视代码":这里就是编排瘦身后唯一的人审代码点,
               只提清单会让人以为对对文件名就行。原文案"正在读取…"是
               误导:没在读,是检视面板还没打开过(实锤用户干等)。 */
            ? "本任务全部代码增量在「本任务变更」——请逐文件检视 diff;"
              + "勾选框默认全选,检视后这里才能提交。"
            : deliverySelectionChanged
              ? selectedEffect?.handles_feedback
                ? "提交后：Agent 按这个范围调整代码与清单，完成后重新给你检视；本次不会推送。"
                : `提交后：Cloud 自动整理一个清单提交（移出 ${deliverySelection!.committedPaths
                  .filter((path) => !deliverySelection!.selectedPaths
                    .includes(path)).length} 个，补入 ${deliverySelection!
                  .selectedPaths.filter((path) => !deliverySelection!
                    .committedPaths.includes(path)).length} 个）；未选内容保留在本地但不推送；`
                + "不会让 Agent 猜着重改，也不重跑本地编译，最终由绑定新 SHA 的权威流水线裁决。"
              : "提交后：保持当前提交不变；服务端复核同一文件集合，然后继续推送前验证与交付。"}</span>
          {onLocateDelivery && (
            <button type="button" className="delivery-locate"
              onClick={onLocateDelivery}>
              {deliverySelection ? "回到代码检视" : "去检视代码"}
            </button>
          )}
        </div>
      )}

      <footer className="decision-footer">
        <div className="decision-notes">
          {!notesOpen ? (
            <button type="button" onClick={() => setNotesOpen(true)}>
              {isReviewDecision ? "+ 补充检视说明" : "+ 添加整卡备注"}
            </button>
          ) : (
            <label>
              <span>{isReviewDecision
                ? "检视说明（可选，不改变上方分支）"
                : "决策备注（可选）"}</span>
              <input
                type="text"
                placeholder={isReviewDecision
                  ? "补充修改原因或处理要求；流程走向以上方选项为准"
                  : "随本次决定一起记录"}
                value={notes}
                autoFocus
                onChange={(change) => setNotes(change.target.value)}
              />
            </label>
          )}
        </div>
        {/* 报错紧贴提交按钮上方(role=alert 读屏即播):原来渲在整卡
            最底沿,长卡时落在视口外,人以为点了没反应。 */}
        {conflict && <div className="alert" role="alert">{conflict}</div>}
        <button
          type="button"
          className="submit-decision"
          disabled={!ready}
          onClick={submit}
        >
          {submitLabel}
          <svg viewBox="0 0 20 20" aria-hidden>
            <path d="m4 10 3.2 3.2L16 5.5" />
          </svg>
        </button>
      </footer>
    </section>
  );
}

function rewritePanelPath(context: string, taskId: string): string {
  return context.replace(
    /`?\/[^\s`]*\.mae-flow-work\/panel\.html`?/g,
    `[在本页打开现场面板](/tasks/${taskId}/panel)`,
  );
}

export function RetryButton({
  taskId,
  onDone,
  allowFromStart = false,
}: {
  taskId: string;
  onDone: () => void;
  allowFromStart?: boolean;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"retry" | "rerun" | "">("");
  return (
    <div className="retry-row">
      <button type="button" disabled={Boolean(busy)} onClick={async () => {
        setBusy("retry");
        try {
          const result = await retryTask(taskId);
          setError(result.error ?? "");
          if (!result.error) onDone();
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          setBusy("");
        }
      }}>
        <svg viewBox="0 0 20 20" aria-hidden>
          <path d="M15.5 7A6 6 0 1 0 16 12M15.5 3v4h-4" />
        </svg>
        {busy === "retry" ? "正在续推…" : "重跑续推"}
      </button>
      {allowFromStart && (
        <button className="destructive" type="button" disabled={Boolean(busy)}
          onClick={async () => {
            if (!window.confirm(
              `确认清空 ${taskId} 的旧工作区、流程、事件和交付记录，`
              + "并用同一任务编号从第一步重跑？此操作不可撤销。",
            )) return;
            setBusy("rerun");
            try {
              const result = await rerunTaskFromStart(taskId);
              setError(result.error ?? "");
              if (!result.error) onDone();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy("");
            }
          }}>
          <svg viewBox="0 0 20 20" aria-hidden>
            <path d="M4 5h12M7 5V3h6v2m-7 3 .7 8h6.6L14 8M8.5 9.5v4m3-4v4" />
          </svg>
          {busy === "rerun" ? "正在清空重跑…" : "清空并从头重跑"}
        </button>
      )}
      {error && <div className="alert">{error}</div>}
    </div>
  );
}

export function ActionLedger({ taskId }: { taskId: string }) {
  const [rows, setRows] = useState<ExternalAction[]>();
  const [unavailable, setUnavailable] = useState("");

  async function load() {
    const result = await listActions(taskId);
    if (result.unavailable) setUnavailable(result.unavailable);
    else setRows(result.actions ?? []);
  }

  return (
    <details className="utility-panel" onToggle={(toggle) => {
      if ((toggle.target as HTMLDetailsElement).open) void load();
    }}>
      <summary>
        <span>
          <strong>外部动作台账</strong>
          <small>MR、流水线与幂等记录</small>
        </span>
        <i aria-hidden />
      </summary>
      {unavailable && <div className="utility-note">{unavailable}</div>}
      {rows && rows.length === 0 && (
        <div className="utility-note">还没有外部动作。</div>
      )}
      {rows && rows.length > 0 && (
        <div className="ledger-list">
          {rows.map((row) => (
            <div className="ledger-row" key={row.idemKey}>
              <div className="ledger-head">
                <strong>{row.kind}</strong>
                <span className={row.finishedAt ? "done" : "running"}>
                  {row.finishedAt ? "已完成" : "进行中"}
                </span>
              </div>
              <code>{row.idemKey}</code>
              {row.sha && <small>SHA · {row.sha.slice(0, 8)}</small>}
              <pre>{JSON.stringify(row.result ?? "(未回填)", null, 2)}</pre>
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

/** 交付时间线:这单经历了什么(人话)。展开才查——原始事件流留给
 * EventTail,这里只呈现服务端归纳好的条目,前端不二次解读。 */
export function TaskTimeline({
  taskId,
  defaultOpen = false,
}: {
  taskId: string;
  defaultOpen?: boolean;
}) {
  const [entries, setEntries] = useState<TimelineEntry[]>();
  const [unavailable, setUnavailable] = useState("");
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(defaultOpen);

  async function load() {
    setLoading(true);
    const result = await listTimeline(taskId);
    setUnavailable(result.unavailable ?? "");
    setEntries(result.entries);
    setLoading(false);
  }

  useEffect(() => {
    setExpanded(defaultOpen);
    setEntries(undefined);
    setUnavailable("");
    if (defaultOpen) void load();
  }, [taskId, defaultOpen]);

  return (
    <section className={`utility-panel${expanded ? " is-open" : ""}`}>
      <button type="button" className="utility-toggle"
        aria-expanded={expanded}
        onClick={() => {
          const next = !expanded;
          setExpanded(next);
          if (next) void load();
        }}>
        <span>
          <strong>耗时与卡点</strong>
          <small>时间去哪了 · 卡在谁身上</small>
        </span>
        <i aria-hidden />
      </button>
      {expanded && <>
        {loading && <div className="utility-note">正在读取现场…</div>}
        {unavailable && <div className="utility-note">{unavailable}</div>}
        {entries && entries.length === 0 && (
          <div className="utility-note">现场还没有可归纳的记录。</div>
        )}
        {entries && entries.length > 0 && <CostBreakdown entries={entries} />}
      </>}
    </section>
  );
}

/** 耗时与卡点:同一份现场,回答"时间去哪了、卡在谁身上"。
 * 倒放流水账没有信息量(用户实测原话),这里只留结论与关键节点。 */
function timelineInstant(value: string): number {
  const timestamp = instantMs(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function CostBreakdown({ entries }: { entries: TimelineEntry[] }) {
  const [showAll, setShowAll] = useState(false);
  const first = timelineInstant(entries[0].ts);
  const last = Math.max(timelineInstant(entries[entries.length - 1].ts), first);
  // 审批卡 → 下一条决定 = 一段人工等待;没等到决定的就是此刻还在等。
  const waits: Array<{ ask: TimelineEntry; ms: number; answer?: string }> = [];
  entries.forEach((entry, index) => {
    if (entry.kind !== "ask") return;
    const answered = entries.slice(index + 1).find((it) => it.kind === "decision");
    const until = answered ? timelineInstant(answered.ts) : Date.now();
    waits.push({
      ask: entry,
      ms: Math.max(0, until - timelineInstant(entry.ts)),
      answer: answered?.title.replace(/^你的决定[:：]/, ""),
    });
  });
  const waitedTotal = waits.reduce((sum, item) => sum + item.ms, 0);
  const total = Math.max(last - first, waitedTotal);
  const machine = Math.max(0, total - waitedTotal);
  const share = total > 0 ? Math.round((waitedTotal / total) * 100) : 0;
  const rebuilds = entries.filter((it) => it.title.includes("重建会话")).length;
  const problems = entries.filter((it) => it.tone === "danger");
  const longest = [...waits].sort((a, b) => b.ms - a.ms).slice(0, 2);
  const pending = [...waits].reverse().find((item) => !item.answer);
  const latest = entries.at(-1)!;

  return (
    <div className="cost">
      <section className={`cost-focus ${pending ? "blocked" : "clear"}`}>
        <div className="cost-focus-copy">
          <span>{pending ? "CURRENT BLOCKER" : "CURRENT STATUS"}</span>
          <strong>{pending
            ? pending.ask.title.replace(/^请你决定[:：]/, "")
            : "当前没有人工卡点"}</strong>
          <p>{pending
            ? "流程正在等待负责人完成决策"
            : `最近进展 · ${latest.title}`}</p>
        </div>
        <div className="cost-focus-number">
          <strong>{pending ? formatWait(pending.ms) : `${share}%`}</strong>
          <span>{pending ? "已等待" : "时间用于等决策"}</span>
        </div>
      </section>

      <section className="cost-composition">
        <header><strong>时间构成</strong><span>总历时 {formatWait(total)}</span></header>
        <div className="cost-bar" aria-label={`人工等待 ${share}%，机器执行 ${100 - share}%`}>
          <span className="human" style={{ width: `${share}%` }} />
          <span className="machine" style={{ width: `${100 - share}%` }} />
        </div>
        <div className="cost-legend">
          <span><i className="human" />人工等待 <strong>{formatWait(waitedTotal)}</strong></span>
          <span><i className="machine" />机器执行 <strong>{formatWait(machine)}</strong></span>
        </div>
      </section>

      <div className="cost-metrics">
        <div><span>决策次数</span><strong>{waits.length}</strong></div>
        <div><span>会话重建</span><strong>{rebuilds}</strong></div>
      </div>

      {problems.length > 0 && (
        <div className="cost-problems">
          <strong className="cost-section-title">异常记录</strong>
          {problems.map((item, index) => (
            <div key={index}><strong>{item.title}</strong>{item.detail && <span>{item.detail}</span>}</div>
          ))}
        </div>
      )}

      {longest.length > 0 && (
        <section className="cost-history">
          <header><strong>历史等待</strong><span>耗时最长的 {longest.length} 次</span></header>
          <ol className="cost-list">
            {longest.map((item, index) => (
              <li key={index} className={item.answer ? "" : "pending"}>
                <span className="cost-rank">{String(index + 1).padStart(2, "0")}</span>
                <span className="cost-body">
                  <strong>{item.ask.title.replace(/^请你决定[:：]/, "")}</strong>
                  <span>{item.answer ? item.answer : "仍在等待负责人决定"}</span>
                </span>
                <span className="cost-wait">{formatWait(item.ms)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="cost-footer">
        <span>{entries.length} 个关键节点</span>
        <button type="button" className="cost-toggle" onClick={() => setShowAll((open) => !open)}>
          {showAll ? "收起明细" : "查看完整时间线"}
        </button>
      </div>
      {showAll && (
        <ol className="timeline">
          {entries.map((entry, index) => (
            <li className={`timeline-item ${entry.tone}`} key={index}>
              <span className="timeline-dot" aria-hidden />
              <time className="timeline-time" dateTime={entry.ts}
                title={formatLocalDateTime(entry.ts, { seconds: true, year: true })}>
                {formatLocalClock(entry.ts)}
              </time>
              <span className="timeline-body">
                <strong>{entry.title}</strong>
                {entry.detail && <span>{entry.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** 「已暂停跟随」的角标。停下来看东西时,人需要知道两件事:
 * 它没停(还在收),以及积压了多少。 */
function FollowPaused({ behind, onResume }: {
  behind: number; onResume: () => void;
}) {
  return (
    <button type="button" className="follow-resume" onClick={onResume}>
      {behind > 0 ? `↓ ${behind} 条新的` : "↓ 回到最新"}
    </button>
  );
}

interface EventDetailSelection {
  key: string;
  eventId: number;
  eventLabel: string;
  fieldLabel: string;
  content: string;
  structured: boolean;
  timestamp: string;
}

function EventTail({ taskId, active }: { taskId: string; active: boolean }) {
  const PAGE_SIZE = 120;
  const [events, setEvents] = useState<SemanticEvent[]>([]);
  const [connection, setConnection] = useState<SseConnectionState>("connecting");
  const [filter, setFilter] = useState<EventFilter>("all");
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const [detail, setDetail] = useState<EventDetailSelection>();
  const filtered = filterEvents(events, filter);
  const visible = eventWindow(filtered, visibleLimit);
  const counts = eventFilterCounts(events);
  const follow = useStickyBottom<HTMLDivElement>(filtered.length);

  useEffect(() => {
    setEvents([]);
    setConnection("connecting");
    setFilter("all");
    setVisibleLimit(PAGE_SIZE);
    setDetail(undefined);
  }, [taskId]);

  useEffect(() => setVisibleLimit(PAGE_SIZE), [filter]);

  useEffect(() => {
    if (!active) return;
    const stop = tailEvents(
      taskId,
      (event: SemanticEvent) => {
        setEvents((previous) => previous.some((item) => (
          item.eventId === event.eventId
        )) ? previous : [...previous, event]);
      },
      setConnection,
    );
    return stop;
  }, [active, taskId]);

  return (
    <div className="event-panel-body">
      <div className={`event-live-state ${connection}`}>
        <i aria-hidden />
        <span>{!active ? "实时连接已暂停"
          : connection === "live" ? "实时接收中"
            : connection === "reconnecting" ? "连接中断，正在自动重连"
              : "正在连接任务现场"} · {events.length} 条
          {follow.paused ? " · 已暂停跟随" : ""}</span>
      </div>
      <div className="event-filters" role="group" aria-label="筛选原始事件">
        {([
          ["all", "全部"],
          ["messages", "消息"],
          ["tools", "工具"],
          ["errors", "异常"],
        ] as Array<[EventFilter, string]>).map(([value, label]) => (
          <button type="button" key={value}
            className={filter === value ? "active" : ""}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}>
            {label}<span>{counts[value]}</span>
          </button>
        ))}
      </div>
      {follow.paused && (
        <div className="event-follow">
          <span>已暂停跟随,你正在往回看——新事件仍在接收。</span>
          <FollowPaused behind={follow.behind} onResume={follow.toBottom} />
        </div>
      )}
      <div className={`event-workspace${detail ? " has-detail" : ""}`}>
        <div ref={follow.ref} className="event-stream"
             onScroll={follow.onScroll}
             /* aria-live 去掉了:一个每秒刷新的流对读屏软件是灾难,
                而且"暂停跟随"之后再朗读最新内容,与人的意图正好相反。 */>
          {visible.hidden > 0 && (
            <button type="button" className="event-load-earlier"
              onClick={() => setVisibleLimit((current) => current + PAGE_SIZE)}>
              查看更早的 {Math.min(PAGE_SIZE, visible.hidden)} 条
              <small>仍有 {visible.hidden} 条未挂载</small>
            </button>
          )}
          {events.length === 0 && (
            <div className="event-empty">
              <span aria-hidden />
              <strong>正在连接任务现场</strong>
              <small>新的执行动作会实时出现在这里。</small>
            </div>
          )}
          {events.length > 0 && filtered.length === 0 && (
            <div className="event-empty filtered">
              <strong>这个筛选下没有事件</strong>
              <small>原始事件没有丢失，可以切回“全部”继续查看。</small>
            </div>
          )}
          {visible.items.map((event) => (
            <EventRecord event={event} key={event.eventId}
              selectedDetail={detail?.key}
              onInspect={setDetail} />
          ))}
        </div>
        {detail && (
          <aside className="event-detail" aria-label="事件完整内容">
            <header>
              <div>
                <span>#{detail.eventId} · {detail.eventLabel}</span>
                <strong>{detail.fieldLabel}</strong>
                <time dateTime={detail.timestamp}>
                  {formatLocalDateTime(detail.timestamp, { seconds: true })}
                </time>
              </div>
              <button type="button" onClick={() => setDetail(undefined)}
                aria-label="关闭事件详情" title="关闭详情">×</button>
            </header>
            <pre className={detail.structured ? "structured" : ""}>
              {detail.content}
            </pre>
          </aside>
        )}
      </div>
    </div>
  );
}

/** 执行现场=原始 SSE 事件流,一种读法(2026-08-26 用户拍板:心流
 * 摘要定位不清晰,干掉;筛选器 + 贴底跟随已足够扫读与取证)。
 * 展开才建立实时连接。 */
export function ExecutionPanel({
  task,
  defaultOpen = false,
}: {
  task: TaskSummary;
  defaultOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);

  useEffect(() => {
    setExpanded(defaultOpen);
  }, [task.id, defaultOpen]);

  return (
    <section className={`utility-panel execution-panel${expanded ? " is-open" : ""}`}>
      <button type="button" className="utility-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}>
        <span>
          <strong>执行现场</strong>
          <small>{task.focus?.headline ?? "SSE 原始事件流,实时跟随"}</small>
        </span>
        <i aria-hidden />
      </button>
      {expanded && (
        <div className="execution-body">
          <EventTail taskId={task.id} active={expanded} />
        </div>
      )}
    </section>
  );
}

const EVENT_KIND_LABEL: Record<string, string> = {
  session_started: "会话开始",
  user_message: "用户指令",
  assistant_message: "Agent 回复",
  tool_requested: "调用工具",
  tool_finished: "工具结果",
  turn_finished: "本轮结束",
  task_status_changed: "状态变化",
};

const EVENT_FIELD_LABEL: Record<string, string> = {
  text: "内容",
  name: "工具",
  input: "输入",
  result: "结果",
  reason: "原因",
  answers: "答复",
  is_error: "执行异常",
  resume: "恢复会话",
  call_id: "调用编号",
};

function eventTone(event: SemanticEvent): string {
  if (isErrorEvent(event)) return "danger";
  if (event.kind === "tool_finished" || event.kind === "turn_finished") {
    return "success";
  }
  if (event.kind === "assistant_message") return "agent";
  if (event.kind === "user_message") return "user";
  return "neutral";
}

function EventValue({ value, onInspect }: {
  value: unknown;
  onInspect: (content: string, structured: boolean) => void;
}) {
  if (typeof value === "string") {
    if (value.length > 480) {
      return <button type="button" className="event-value-preview"
        onClick={() => onInspect(value, false)}>
        <span>
          <span>{value.slice(0, 180).trim()}…</span>
          <small>{value.length} 字</small>
        </span>
        <strong>右侧查看 <i aria-hidden>→</i></strong>
      </button>;
    }
    return <span className="event-value-text">{value || "（空）"}</span>;
  }
  if (typeof value === "boolean") {
    return <code className="event-value-atom">{value ? "是" : "否"}</code>;
  }
  if (value === null || value === undefined || typeof value === "number") {
    return <code className="event-value-atom">{String(value)}</code>;
  }
  const structured = JSON.stringify(value, null, 2);
  return <button type="button" className="event-value-preview structured"
    onClick={() => onInspect(structured, true)}>
    <span>
      <span>结构化内容</span>
      <small>{structured.split("\n").length} 行</small>
    </span>
    <strong>右侧查看 <i aria-hidden>→</i></strong>
  </button>;
}

function EventRecord({ event, selectedDetail, onInspect }: {
  event: SemanticEvent;
  selectedDetail?: string;
  onInspect: (selection: EventDetailSelection) => void;
}) {
  const fields = Object.entries(event.payload);
  return (
    <article className={`event-record ${eventTone(event)}${selectedDetail
      ?.startsWith(`${event.eventId}:`) ? " selected" : ""}`}>
      <header>
        <span className="event-record-dot" aria-hidden />
        <strong>{EVENT_KIND_LABEL[event.kind] ?? event.kind}</strong>
        {event.sessionId === "developer-assistant" && (
          <span className="event-session-label">开发助手</span>
        )}
        <code>#{event.eventId}</code>
        <time dateTime={event.ts}
          title={formatLocalDateTime(event.ts, { seconds: true, year: true })}>
          {formatLocalDateTime(event.ts, { seconds: true })}
        </time>
      </header>
      {fields.length === 0 ? (
        <div className="event-record-empty">本事件没有附加内容</div>
      ) : (
        <dl>
          {fields.map(([field, value]) => {
            const key = `${event.eventId}:${field}`;
            return (
              <div key={field}>
                <dt>{EVENT_FIELD_LABEL[field] ?? field}</dt>
                <dd><EventValue value={value} onInspect={(content, structured) =>
                  onInspect({
                    key,
                    eventId: event.eventId,
                    eventLabel: EVENT_KIND_LABEL[event.kind] ?? event.kind,
                    fieldLabel: EVENT_FIELD_LABEL[field] ?? field,
                    content,
                    structured,
                    timestamp: event.ts,
                  })} /></dd>
              </div>
            );
          })}
        </dl>
      )}
    </article>
  );
}
