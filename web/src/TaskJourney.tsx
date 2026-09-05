import { useEffect, useState } from "react";
import { listTimeline, tailEvents, type TaskSummary, type TimelineEntry } from "./api";
import { formatLocalDateTime } from "./time";
import { startVisiblePolling } from "./visiblePolling";
import { journeyCurrent, recentJourney, journeyMessage } from "./journeyModel";

const labels: Record<TimelineEntry["kind"], string> = {
  session: "执行", phase: "阶段", ask: "请求确认", decision: "人的决定",
  agent: "Agent 回应", quality: "验证结果", memory: "记录经验",
};

export function TaskJourney({ task, onLogs, onTiming }: {
  task: TaskSummary; onLogs: () => void; onTiming: () => void;
}) {
  const [entries, setEntries] = useState<TimelineEntry[]>();
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<Record<number, TimelineEntry>>({});
  const [connection, setConnection] = useState("connecting");
  useEffect(() => {
    setMessages({});
    let stop: (() => void) | undefined;
    const connect = () => {
      stop?.(); stop = undefined;
      if (document.visibilityState !== "visible") return;
      stop = tailEvents(task.id, (event) => {
        const message = journeyMessage(event);
        if (message) setMessages((previous) => previous[event.eventId] ? previous : { ...previous, [event.eventId]: message });
      }, setConnection);
    };
    connect(); document.addEventListener("visibilitychange", connect);
    return () => { stop?.(); document.removeEventListener("visibilitychange", connect); };
  }, [task.id]);
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
  const ordered = recentJourney([...(entries ?? []), ...Object.values(messages)]);
  return <section className="task-journey" aria-label="Agent 工作过程">
    <header className="journey-heading">
      <div><h2>Agent 的工作过程</h2><p>查看 Agent 的说明、阶段结果和你的历史决定。</p></div>
      <div className="journey-tools"><button type="button" onClick={onTiming}>耗时分析</button>
        <button type="button" onClick={onLogs}>查看执行日志 ↗</button></div>
    </header>
    <div className={`journey-live-state ${current.tone}`}><i aria-hidden /><strong>{current.title}</strong>
      <span>{task.progress?.current_phase}</span></div>
    {(task.execution_plan_alerts ?? []).map((line, index) => <p className="journey-warning" key={index}>{line}</p>)}
    <div className="journey-history-heading"><h3>过程记录</h3><span>{connection === "live" ? "自动更新 · 最近的在前" : "进展连接中，保留已收到的记录"}</span></div>
    {error && <div className="journey-empty" role="status"><strong>暂时无法更新进展</strong><p>{error}</p>
      {entries && <p>下方保留上次读取的记录。</p>}<button type="button" onClick={() => setReload((value) => value + 1)}>重新读取</button></div>}
    {!entries && !error && <p className="journey-empty" role="status">正在读取进展…</p>}
    {entries?.length === 0 && ordered.length === 0 && <div className="journey-empty"><strong>还没有形成阶段记录</strong>
      <p>当前状态见上方；需要查看启动或工具调用细节时，可以打开执行日志。</p><button type="button" onClick={onLogs}>查看执行日志</button></div>}
    <ol className="journey-events">{ordered.slice(0, limit).map((entry, index) => <li key={`${entry.ts}:${entry.kind}:${index}`} className={entry.tone}>
      <div className="journey-event-meta"><span>{labels[entry.kind]}</span><time dateTime={entry.ts}>{formatLocalDateTime(entry.ts)}</time></div>
      <h4>{entry.title}</h4>
      {entry.detail && (entry.detail.length > 200 ? <details><summary>{entry.detail.slice(0, 120)}… 查看完整内容</summary><p>{entry.detail}</p></details> : <p>{entry.detail}</p>)}
    </li>)}</ol>
    {ordered.length > limit && <button type="button" className="journey-more" onClick={() => setLimit((value) => value + 20)}>查看更早的进展（还有 {ordered.length - limit} 条）</button>}
  </section>;
}
