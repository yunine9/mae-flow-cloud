/**
 * 单任务处置台：摘要适合扫读，展开后集中承载审批、交付事实、
 * 外部动作与事件现场。服务端镜像是唯一事实来源。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Markdown } from "./markdown";
import {
  decide,
  listActions,
  listTimeline,
  retryTask,
  repairStopped,
  statusText,
  tailEvents,
  type ExternalAction,
  type SemanticEvent,
  type TaskSummary,
  type TimelineEntry,
} from "./api";
import { formatWait, URGENT_MINUTES, waitedMs } from "./taskTime";
import { responsibleOf } from "./teamOps";

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

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
            <span className="task-id">{task.id}</span>
            <span className={`pill ${task.status}${decisionMode === "signal" && task.status === "waiting_for_human" ? " team-signal" : ""}`}>
              <i aria-hidden />
              {decisionMode === "signal" && task.status === "waiting_for_human"
                ? "待拍板"
                : statusText(task)}
            </span>
            <WaitBadge task={task} personal={showDecisionForm} />
            <span className="task-created">{formatTime(task.created_at)}</span>
          </span>
          <strong className="task-title">{task.title ?? task.requirement}</strong>
          <span className="task-ownership">
            <span>责任人 · {responsibleOf(task) ?? "未指定"}</span>
          </span>
          {task.progress && (
            <TaskProgress
              progress={task.progress}
              showDetailedStep={decisionMode === "form"}
            />
          )}
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
        {task.status !== "queued" && (
          <button type="button" className="panel-link" onClick={onOpenArtifacts}>
            <span>进入过程工作台</span>
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
              <strong>自动修复已停，需要你介入</strong>
              <span>
                {task.delivery?.loop?.diagnosis ?? task.detail
                  ?? "请查看流水线日志确认原因。"}
                {" "}办完之后点「重跑续推」，机器接着干。
              </span>
            </div>
          )}
          {canOperate && (task.status === "failed"
            || task.status === "completed" || repairStopped(task)) && (
            <RetryButton taskId={task.id} onDone={onChanged} />
          )}
          {showDecisionForm && canOperate && task.status === "waiting_for_human" && task.waiting && (
            <WaitingCard task={task} onDecided={onChanged} />
          )}
          {showDecisionForm && !canOperate && task.status === "waiting_for_human" && (
            <div className="read-only-notice">
              该事项由 {task.luban_account ?? "其他成员"} 核对；你可以查看进展，但不能代为提交决定。
            </div>
          )}
          <div className="task-utilities">
            <TaskTimeline taskId={task.id} />
            {task.delivery && <ActionLedger taskId={task.id} />}
            <EventTail taskId={task.id} />
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
  return <span className="task-progress" aria-label={`当前阶段：${currentLabel}`}>
    <span className="task-progress-caption">
      <span>当前进度</span>
      <strong>{currentLabel}</strong>
    </span>
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
}: {
  task: TaskSummary;
  onDecided: () => void;
  /** 待提交批注:提交审批时可作为修改说明一并带上。 */
  annotationIds?: string[];
  /** 批注块。挂在提交按钮正上方而不是卡片外面:选项标签是内核的
   * (它按标签给这次选择记账,前端改写会让记下的选择对不上用户点的),
   * 所以"这次会带上哪几处"只能摆在人按下提交的那一眼里。 */
  attachment?: ReactNode;
}) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  const [conflict, setConflict] = useState("");
  const questions = task.waiting?.question?.questions ?? [];

  const answerOf = (question: string) =>
    customOpen[question] && custom[question]?.trim()
      ? custom[question].trim()
      : picked[question];
  const optional = (question: string) =>
    /可忽略|若上题|如无|可跳过|可不填/.test(question);
  const ready = questions.every(
    (item) => optional(item.question) || answerOf(item.question),
  );

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
    const answers: Record<string, string> = {};
    for (const item of questions) {
      const answer = answerOf(item.question);
      if (answer) answers[item.question] = answer;
    }
    const result = await decide(
      task.id,
      task.waiting!.state_version,
      answers,
      notes,
      annotationIds,
    );
    if (result.conflict) setConflict(result.conflict);
    onDecided();
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

      {attachment}

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
          提交决定
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
      className="utility-block"
      onToggle={(toggle) => {
        if ((toggle.target as HTMLDetailsElement).open) void load();
      }}
    >
      <summary>
        <strong>耗时与卡点</strong>
        <span>时间去哪了 · 卡在谁身上</span>
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

/** 现场时间戳是 "YYYY-MM-DD HH:mm:ss"(内核格式,不是 ISO):
 * Safari 对非 ISO 串解析不保证,补上 T 再交给 Date。 */
function stamp(ts: string): number {
  const value = new Date(ts.replace(" ", "T")).getTime();
  return Number.isNaN(value) ? 0 : value;
}

/** 耗时与卡点:同一份现场,回答"时间去哪了、卡在谁身上"。
 * 倒放流水账没有信息量(用户实测原话),这里只留结论与关键节点。 */
function CostBreakdown({ entries }: { entries: TimelineEntry[] }) {
  const [showAll, setShowAll] = useState(false);
  const first = stamp(entries[0].ts);
  const last = Math.max(stamp(entries[entries.length - 1].ts), first);
  // 审批卡 → 下一条决定 = 一段人工等待;没等到决定的就是此刻还在等。
  const waits: Array<{ ask: TimelineEntry; ms: number; answer?: string }> = [];
  entries.forEach((entry, index) => {
    if (entry.kind !== "ask") return;
    const answered = entries.slice(index + 1).find((it) => it.kind === "decision");
    const until = answered ? stamp(answered.ts) : Date.now();
    waits.push({
      ask: entry,
      ms: Math.max(0, until - stamp(entry.ts)),
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
              <span className="timeline-time">{entry.ts.slice(-8, -3)}</span>
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

function EventTail({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!open) return;
    const stop = tailEvents(taskId, (event: SemanticEvent) => {
      setLines((prev) => [
        ...prev,
        `${event.kind}  ${JSON.stringify(event.payload).slice(0, 160)}`,
      ]);
    });
    return stop;
  }, [open, taskId]);

  useEffect(() => {
    pre.current?.scrollTo(0, pre.current.scrollHeight);
  }, [lines]);

  return (
    <details
      className="utility-panel"
      onToggle={(toggle) => setOpen(
        (toggle.target as HTMLDetailsElement).open,
      )}
    >
      <summary>
        <span>
          <strong>过程记录</strong>
          <small>SSE 实时事件流</small>
        </span>
        <i aria-hidden />
      </summary>
      <pre ref={pre} className="event-log">
        {lines.length > 0 ? lines.join("\n") : "等待新的过程事件…"}
      </pre>
    </details>
  );
}
