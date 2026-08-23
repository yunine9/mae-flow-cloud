/**
 * 单任务处置台：摘要适合扫读，展开后集中承载审批、交付事实、
 * 外部动作与事件现场。服务端镜像是唯一事实来源。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Markdown } from "./markdown";
import {
  decide,
  fetchActivity,
  listActions,
  listTimeline,
  retryTask,
  repairStopped,
  statusText,
  tailEvents,
  type ActivityView,
  type ExternalAction,
  type SemanticEvent,
  type SseConnectionState,
  type TaskSummary,
  type TimelineEntry,
} from "./api";
import { formatWait, URGENT_MINUTES, waitedMs } from "./taskTime";
import { responsibleOf } from "./teamOps";
import { atBottom, backlog } from "./follow";
import {
  eventFilterCounts,
  eventWindow,
  filterEvents,
  isErrorEvent,
  type EventFilter,
} from "./eventView";
import type { RepositorySkillSelection } from "./RepositorySkillPicker";
import { PrepushStatus } from "./PrepushStatus";
import { TokenUsage } from "./TokenUsage";
import { startVisiblePolling } from "./visiblePolling";
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
        {task.delivery?.skipped && (
          <span className="meta-fact">交付 · {task.delivery.skipped}</span>
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
          {task.notify && !task.notify.delivered && task.notify.attempts > 0 && (
            <div className="alert">
              <strong>小鲁班通知未送达</strong>
              <span>
                已尝试 {task.notify.attempts} 次，待办仍然有效，请在本页处理。
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
            || task.status === "completed" || repairStopped(task)) && (
            <RetryButton taskId={task.id} onDone={onChanged} />
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
            <WaitingCard task={task} onDecided={onChanged} />
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
}: {
  progress: NonNullable<TaskSummary["progress"]>;
  showDetailedStep: boolean;
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
        return <span className={`task-phase ${state}`} key={phase}>
          <i aria-hidden />
          <span>{phase}</span>
        </span>;
      })}
    </span>
  </span>;
}

export function WaitingCard({
  task,
  onDecided,
  annotationIds,
  attachment,
  repositorySkillSelection,
}: {
  task: TaskSummary;
  onDecided: () => void;
  /** 待提交批注:提交审批时可作为修改说明一并带上。 */
  annotationIds?: string[];
  /** 批注块。挂在提交按钮正上方而不是卡片外面:选项标签是内核的
   * (它按标签给这次选择记账,前端改写会让记下的选择对不上用户点的),
   * 所以"这次会带上哪几处"只能摆在人按下提交的那一眼里。 */
  attachment?: ReactNode;
  /** 仅 Chain 的“确认并生成任务”消费；未扫描/需要修改都不发送。 */
  repositorySkillSelection?: RepositorySkillSelection;
}) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [conflict, setConflict] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const questions = task.waiting?.question?.questions ?? [];

  const answerOf = (question: string) =>
    customOpen[question] && custom[question]?.trim()
      ? custom[question].trim()
      : picked[question];
  const optional = (question: string) =>
    /可忽略|若上题|如无|可跳过|可不填/.test(question);
  const ready = questions.every(
    (item) => optional(item.question) || answerOf(item.question),
  ) && !repositorySkillSelection?.scanning
    && (!repositorySkillSelection?.scanned
      || !!repositorySkillSelection.catalogToken)
    && !submitting;

  function pickOption(question: string, option: string) {
    setPicked({ ...picked, [question]: option });
    setCustomOpen({ ...customOpen, [question]: false });
    setCustom({ ...custom, [question]: "" });
  }

  function openCustom(question: string) {
    setCustomOpen({ ...customOpen, [question]: true });
    setPicked({ ...picked, [question]: "" });
  }

  async function submit() {
    if (!ready || submitting) return;
    const answers: Record<string, string> = {};
    for (const item of questions) {
      const answer = answerOf(item.question);
      if (answer) answers[item.question] = answer;
    }
    const confirmsChain = Object.values(answers).some((answer) =>
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
        answers,
        notes,
        annotationIds,
        repositorySkills,
      );
      if (result.conflict) setConflict(result.conflict);
      onDecided();
    } catch (reason) {
      setConflict(reason instanceof Error ? reason.message : "决定提交失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="decision-card" aria-labelledby={`decision-${task.id}`}>
      <header className="decision-head">
        <div>
          <span className="decision-kicker">ACTION REQUIRED</span>
          <h3 id={`decision-${task.id}`}>需要你的决策</h3>
          {task.waiting?.step && <p>{task.waiting.step}</p>}
        </div>
        <span className="decision-count">{questions.length} 个问题</span>
      </header>

      {task.waiting?.context && (
        <div className="waiting-context">
          <div className="context-label">决策背景</div>
          <Markdown text={rewritePanelPath(task.waiting.context, task.id)} />
        </div>
      )}

      <div className="question-list">
        {questions.map((item, index) => {
          const options = item.options ?? [];
          const compact = options.length <= 4
            && options.every((option) => option.length <= 14);
          const customActive =
            !!customOpen[item.question] && !!custom[item.question]?.trim();
          const skippable = optional(item.question);
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
                  const [title, hint] = split
                    ? [split[1].trim(), split[2].trim()]
                    : [option, ""];
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
                      <span className="option-title">自定义答复</span>
                      <span className="option-hint">输入精确的修改点或决策内容</span>
                    </span>
                  </button>
                )}
              </div>
              {customOpen[item.question] && (
                <div className="custom-answer">
                  <textarea
                    className={`custom-input${customActive ? " picked" : ""}`}
                    placeholder="写下你的自定义答复…"
                    value={custom[item.question] ?? ""}
                    autoFocus
                    onChange={(change) => setCustom({
                      ...custom,
                      [item.question]: change.target.value,
                    })}
                  />
                  <span>这段文字将作为本题的最终答案提交。</span>
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

      <footer className="decision-footer">
        <div className="decision-notes">
          {!notesOpen ? (
            <button type="button" onClick={() => setNotesOpen(true)}>
              + 添加整卡备注
            </button>
          ) : (
            <label>
              <span>决策备注（可选）</span>
              <input
                type="text"
                placeholder="随本次决定一起记录"
                value={notes}
                autoFocus
                onChange={(change) => setNotes(change.target.value)}
              />
            </label>
          )}
        </div>
        <button
          type="button"
          className="submit-decision"
          disabled={!ready}
          onClick={submit}
        >
          {submitting ? "正在提交…" : repositorySkillSelection?.scanning
            ? "等待能力读取" : "提交决定"}
          <svg viewBox="0 0 20 20" aria-hidden>
            <path d="m4 10 3.2 3.2L16 5.5" />
          </svg>
        </button>
      </footer>
      {conflict && <div className="alert">{conflict}</div>}
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
}: {
  taskId: string;
  onDone: () => void;
}) {
  const [error, setError] = useState("");
  return (
    <div className="retry-row">
      <button type="button" onClick={async () => {
        const result = await retryTask(taskId);
        setError(result.error ?? "");
        onDone();
      }}>
        <svg viewBox="0 0 20 20" aria-hidden>
          <path d="M15.5 7A6 6 0 1 0 16 12M15.5 3v4h-4" />
        </svg>
        重跑续推
      </button>
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
export function TaskTimeline({ taskId }: { taskId: string }) {
  const [entries, setEntries] = useState<TimelineEntry[]>();
  const [unavailable, setUnavailable] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    const result = await listTimeline(taskId);
    setUnavailable(result.unavailable ?? "");
    setEntries(result.entries);
    setLoading(false);
  }

  return (
    <details
      className="utility-panel"
      onToggle={(toggle) => {
        if ((toggle.target as HTMLDetailsElement).open) void load();
      }}
    >
      <summary>
        <span>
          <strong>耗时与卡点</strong>
          <small>时间去哪了 · 卡在谁身上</small>
        </span>
        <i aria-hidden />
      </summary>
      {loading && <div className="utility-note">正在读取现场…</div>}
      {unavailable && <div className="utility-note">{unavailable}</div>}
      {entries && entries.length === 0 && (
        <div className="utility-note">现场还没有可归纳的记录。</div>
      )}
      {entries && entries.length > 0 && <CostBreakdown entries={entries} />}
    </details>
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

/** 心流的持续时间:分钟级就够,精确到秒反而制造焦虑。 */
function sinceText(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - instantMs(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 60_000) return "刚刚开始";
  return `已持续 ${Math.round(ms / 60_000)} 分钟`;
}

const SEGMENT_ICON: Record<string, string> = {
  read: "读", edit: "改", bash: "跑", tool: "具",
  talk: "说", agent: "派", ask: "决", steer: "嘱",
};

/** 贴底跟随,但**人一往上翻就撒手**。判据见 follow.ts(纯函数,有用例)。 */
function useStickyBottom<T extends HTMLElement>(count: number) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  const mark = useRef(count);
  const [behind, setBehind] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (pinned.current) {
      node.scrollTo({ top: node.scrollHeight });
      mark.current = count;
      setBehind(0);
    } else {
      setBehind(backlog(count, mark.current));
    }
  }, [count]);

  const onScroll = () => {
    const node = ref.current;
    if (!node) return;
    const bottom = atBottom(node);
    if (bottom === pinned.current) return;
    pinned.current = bottom;
    if (bottom) { mark.current = count; setBehind(0); }
  };

  const toBottom = () => {
    const node = ref.current;
    if (!node) return;
    pinned.current = true;
    mark.current = count;
    setBehind(0);
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  };

  return { ref, behind, paused: !pinned.current, onScroll, toBottom };
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

/** 行为摘要:原始 SSE 人盯不过来(用户原话"一直在刷"),这里呈现
 * 服务端折叠好的心流——此刻在干嘛、干了什么、有什么值得看一眼。
 * 前端不二次解读,条目全部来自 /activity 镜像;在跑时轮询跟进。 */
function ActivityFlow({ task }: { task: TaskSummary }) {
  const [view, setView] = useState<ActivityView>();
  const [unavailable, setUnavailable] = useState("");
  const running = task.status === "running";
  const follow = useStickyBottom<HTMLOListElement>(view?.segments.length ?? 0);

  useEffect(() => {
    let alive = true;
    async function load() {
      const result = await fetchActivity(task.id);
      if (!alive) return;
      setUnavailable(result.unavailable ?? "");
      if (result.view) setView(result.view);
    }
    // 在跑才有心流可追；隐藏页签停轮询，回来立即补一次。停了页面上
    // 留最后一份摘要即可，不空转请求。
    if (!running) {
      void load();
      return () => { alive = false; };
    }
    const stop = startVisiblePolling(() => void load(), 5000, document);
    return () => { alive = false; stop(); };
  }, [task.id, running]);

  if (unavailable) {
    return <div className="utility-note">心流摘要暂不可用，可切换到原始事件查看现场。</div>;
  }
  if (!view || (!view.segments.length && !view.alerts.length)) {
    return <div className="utility-note">还没有可折叠的执行动作；原始事件仍会完整保留。</div>;
  }
  const alerts = view.alerts;

  return (
    <div className="activity-panel-body">
      <div className="activity-current">
        <span className="activity-current-label">此刻</span>
        <strong>{view.now || (running ? "Agent 正在准备下一步" : "本轮执行已经收口")}</strong>
        {view.now && <span>{sinceText(view.now_since)}</span>}
        {alerts.length > 0 && (
          <em className="activity-alert-badge">{alerts.length} 个信号</em>
        )}
      </div>
      {alerts.length > 0 && (
        <div className="activity-alerts">
          {alerts.map((alert, index) => (
            <div key={index} className="activity-alert">
              <strong>{alert.title}</strong>
              {alert.detail && <span>{alert.detail}</span>}
              <time dateTime={alert.ts}>{formatLocalClock(alert.ts)}</time>
            </div>
          ))}
        </div>
      )}

      <ol ref={follow.ref} className="activity-segments"
          onScroll={follow.onScroll}>
        {view.truncated && (
          <li className="activity-truncated">更早的动作已折叠,只保留最近部分。</li>
        )}
        {view.segments.map((segment, index) => (
          <li key={index}
              className={`activity-segment ${segment.kind}${segment.errors ? " has-error" : ""}`}>
            <i aria-hidden>{SEGMENT_ICON[segment.kind] ?? "·"}</i>
            <span className="activity-segment-body">
              <strong>
                <time dateTime={segment.start}
                      title={formatLocalDateTime(segment.start, { seconds: true })}>
                  {formatLocalClock(segment.start)}
                </time>
                {segment.title}
              </strong>
              {segment.detail && <span>{segment.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
      <div className="activity-foot">
        {follow.paused && (
          <FollowPaused behind={follow.behind} onResume={follow.toBottom} />
        )}
        共 {view.events_seen} 条原始事件,折叠为 {view.segments.length} 段;
        原始内容可切换到「原始事件」查看。
      </div>
    </div>
  );
}

function EventTail({ taskId, active }: { taskId: string; active: boolean }) {
  const PAGE_SIZE = 120;
  const [events, setEvents] = useState<SemanticEvent[]>([]);
  const [connection, setConnection] = useState<SseConnectionState>("connecting");
  const [filter, setFilter] = useState<EventFilter>("all");
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const filtered = filterEvents(events, filter);
  const visible = eventWindow(filtered, visibleLimit);
  const counts = eventFilterCounts(events);
  const follow = useStickyBottom<HTMLDivElement>(filtered.length);

  useEffect(() => {
    setEvents([]);
    setConnection("connecting");
    setFilter("all");
    setVisibleLimit(PAGE_SIZE);
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
          <EventRecord event={event} key={event.eventId} />
        ))}
      </div>
    </div>
  );
}

/** 同一份事件账的两种读法：心流用于日常扫读，SSE 用于完整取证。
 * 两者不再平铺成重复面板；切到原始事件时才建立实时连接。 */
export function ExecutionPanel({ task }: { task: TaskSummary }) {
  const running = task.status === "running";
  const [expanded, setExpanded] = useState(running);
  const [mode, setMode] = useState<"flow" | "events">("flow");

  useEffect(() => {
    setExpanded(running);
  }, [task.id, running]);

  useEffect(() => {
    setMode("flow");
  }, [task.id]);

  return (
    <section className={`utility-panel execution-panel${expanded ? " is-open" : ""}`}>
      <button type="button" className="utility-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}>
        <span>
          <strong>执行现场</strong>
          <small>{task.focus?.headline
            ?? "心流摘要与 SSE 原始事件共用同一份现场记录"}</small>
        </span>
        <i aria-hidden />
      </button>
      {expanded && <>
        <div className="execution-tabs" role="tablist" aria-label="执行现场视图">
          <button type="button" role="tab" aria-selected={mode === "flow"}
            className={mode === "flow" ? "active" : ""}
            onClick={() => setMode("flow")}>执行心流</button>
          <button type="button" role="tab" aria-selected={mode === "events"}
            className={mode === "events" ? "active" : ""}
            onClick={() => setMode("events")}>原始事件 · SSE</button>
        </div>
        <div className="execution-body">
          <div hidden={mode !== "flow"}><ActivityFlow task={task} /></div>
          <div hidden={mode !== "events"}>
            <EventTail taskId={task.id} active={mode === "events"} />
          </div>
        </div>
      </>}
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

function EventValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    if (value.length > 480) {
      return <details className="event-value-expand">
        <summary>
          <span>{value.slice(0, 180).trim()}…</span>
          <small>展开完整内容 · {value.length} 字</small>
        </summary>
        <pre>{value}</pre>
      </details>;
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
  return <details className="event-value-expand structured">
    <summary>
      <span>结构化内容</span>
      <small>展开查看 · {structured.split("\n").length} 行</small>
    </summary>
    <pre className="event-value-structured">{structured}</pre>
  </details>;
}

function EventRecord({ event }: { event: SemanticEvent }) {
  const fields = Object.entries(event.payload);
  return (
    <article className={`event-record ${eventTone(event)}`}>
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
          {fields.map(([field, value]) => (
            <div key={field}>
              <dt>{EVENT_FIELD_LABEL[field] ?? field}</dt>
              <dd><EventValue value={value} /></dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}
