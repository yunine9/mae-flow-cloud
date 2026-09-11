import { useEffect, useId, useRef, useState } from "react";
import { Alert } from "@/components/Alert";
import { Empty, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/Empty";
import { listTimeline, type TaskSummary, type TimelineEntry } from "./api";
import { formatLocalDateTime, formatLocalDate, formatLocalClock } from "./time";
import { Markdown } from "./markdown";
import { startVisiblePolling } from "./visiblePolling";
import { journeyCurrent, recentJourney } from "./journeyModel";
import { PrepushLiveLog, prepushActive } from "./PrepushLiveLog";

const labels: Record<TimelineEntry["kind"], string> = {
  session: "执行", phase: "阶段", ask: "请求确认", decision: "人的决定",
  agent: "Agent 回应", quality: "验证结果", memory: "记录经验",
};

/** Keep complete Markdown intact; collapse by rendered height instead of cutting syntax. */
export function JourneyDetail({ text }: { text: string }) {
  const body = useRef<HTMLDivElement>(null);
  const contentId = useId();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const node = body.current;
    if (!node) return;
    const measure = () => setOverflows(node.scrollHeight > 240);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);
  return <div className={`journey-detail${overflows && !expanded ? " is-collapsed" : ""}`}>
    <div className="journey-detail-window" id={contentId} onFocusCapture={() => setExpanded(true)}>
      <div className="journey-detail-body" ref={body}><Markdown text={text} /></div></div>
    {overflows && <button type="button" className="journey-expand" aria-expanded={expanded} aria-controls={contentId}
      onClick={() => setExpanded((value) => !value)}>{expanded ? "收起内容 ↑" : "展开完整内容 ↓"}</button>}
  </div>;
}

export function TaskJourney({ task, onLogs, onTiming }: {
  task: TaskSummary; onLogs: () => void; onTiming: () => void;
}) {
  const [entries, setEntries] = useState<TimelineEntry[]>();
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(12);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    let pending = false;
    setEntries(undefined); setError(""); setLimit(12);
    const stop = startVisiblePolling(() => {
      if (pending) return;
      pending = true;
      void listTimeline(task.id).then((result) => {
        if (!alive) return;
        if (result.unavailable) setError(result.unavailable);
        else { setEntries(result.entries ?? []); setError(""); }
      }).catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : "进展暂时无法读取");
      }).finally(() => { pending = false; });
    }, 8000, document);
    return () => { alive = false; stop(); };
  }, [task.id, reload]);
  const current = journeyCurrent(task);
  // Agent 的话、举卡与人的决定已经在右栏会话流里;这一页只留"它具体干了什么":
  // 阶段推进、验证结论、记忆落账,以及执行日志入口(2026-09-05 用户拍板的分工:
  // 流回答"谁对谁说了什么",工作过程回答"它具体干了什么")。
  const ordered = recentJourney(entries ?? [])
    .filter((entry) => !["ask", "decision"].includes(entry.kind)
      && !(entry.kind === "agent" && ["Agent 的进展说明", "开发助手的进展说明"].includes(entry.title)));
  const days: Array<{ date: string; entries: Array<{ entry: TimelineEntry; key: string }> }> = [];
  const keys = new Map<string, number>();
  for (const entry of ordered.slice(0, limit)) {
    const date = formatLocalDate(entry.ts) || "时间未记录";
    if (days.at(-1)?.date !== date) days.push({ date, entries: [] });
    const identity = JSON.stringify([entry.ts, entry.kind, entry.title, entry.detail]);
    const occurrence = keys.get(identity) ?? 0;
    keys.set(identity, occurrence + 1);
    days.at(-1)!.entries.push({ entry, key: `${identity}:${occurrence}` });
  }
  return <section className="task-journey" aria-label="Agent 工作过程">
    <header className="journey-heading">
      <div><h2>Agent 的工作过程</h2><p>阶段推进、验证结论与经验记录；Agent 的话、卡片和你的决定在右栏会话流。</p></div>
      <div className="journey-tools"><button type="button" onClick={onTiming}>耗时分析</button>
        <button type="button" onClick={onLogs}>查看执行日志 ↗</button></div>
    </header>
    <div className={`journey-live-state ${current.tone}`}><i aria-hidden /><strong>{current.title}</strong>
      <span>{task.progress?.current_phase}</span></div>
    {(task.execution_plan_alerts ?? []).length > 0 && <Alert variant="warning" className="mb-2">
      {(task.execution_plan_alerts ?? []).map((line, index) => <p className="m-0" key={index}>{line}</p>)}
    </Alert>}
    {task.delivery?.prepush && <PrepushLiveLog taskId={task.id}
      active={prepushActive(task.delivery.prepush.state, task.delivery.prepush_runtime)}
      title={`Build-Fix · 编译与测试${task.delivery.prepush.round ? ` · 当前第 ${task.delivery.prepush.round} 轮` : ""}`}
      onLogs={onLogs} />}
    <div className="journey-history-heading"><h3>过程记录</h3><span>自动刷新 · 最近的在前</span></div>
    {error && <div className="journey-empty" role="status"><strong>暂时无法更新进展</strong><p>{error}</p>
      {entries && <p>下方保留上次读取的记录。</p>}<button type="button" onClick={() => setReload((value) => value + 1)}>重新读取</button></div>}
    {!entries && !error && <p className="journey-empty" role="status">正在读取进展…</p>}
    {entries?.length === 0 && ordered.length === 0 && <Empty className="py-5"><EmptyTitle>还没有形成阶段记录</EmptyTitle>
      <EmptyDescription>当前状态见上方；需要查看启动或工具调用细节时，可以打开执行日志。</EmptyDescription>
      <EmptyContent><button type="button" onClick={onLogs}>查看执行日志</button></EmptyContent></Empty>}
    <div className="journey-days">{days.map((day) => <section className="journey-day-group" key={day.date} aria-label={day.date}>
      <header className="journey-day-heading"><span>{day.date}</span><i aria-hidden /></header>
      <ol className="journey-events">{day.entries.map(({ entry, key }) => {
        return <li key={key} className={`journey-entry ${entry.tone}`}>
          <span className="journey-entry-mark" aria-hidden>•</span>
          <article>
            <header className="journey-event-meta">
              <strong>{labels[entry.kind]}</strong>
              <time dateTime={entry.ts} title={formatLocalDateTime(entry.ts, { seconds: true, year: true })}>{formatLocalClock(entry.ts)}</time>
            </header>
            <h4>{entry.title}</h4>
            {entry.detail && <JourneyDetail text={entry.detail} />}
          </article>
        </li>;
      })}</ol>
    </section>)}</div>
    {ordered.length > limit && <button type="button" className="journey-more" onClick={() => setLimit((value) => value + 20)}>查看更早的进展（还有 {ordered.length - limit} 条）</button>}
  </section>;
}
