import { useState } from "react";
import {
  publishCrossRepositoryUpdate,
  type CrossRepositoryUpdate,
} from "./api";
import { formatLocalDateTime } from "./time";

export function CrossRepositorySync({
  taskId,
  updates = [],
  onChanged,
}: {
  taskId: string;
  updates?: CrossRepositoryUpdate[];
  onChanged?: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  async function publish() {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setFeedback("");
    try {
      const result = await publishCrossRepositoryUpdate(taskId, message);
      setText("");
      setFeedback(result.target_task_ids.length
        ? `已回流大任务，并同步给 ${result.target_task_ids.length} 个直接上下游任务`
        : "已回流大任务；当前依赖图没有直接相邻任务");
      onChanged?.();
    } catch (cause) {
      setFeedback(cause instanceof Error ? cause.message : "跨仓同步失败");
    } finally {
      setBusy(false);
    }
  }

  return <section className="cross-repository-sync">
    <header><div><span>IMPACT SYNC</span><strong>同步跨仓影响</strong></div>
      <small>回流大任务，并提醒依赖图上的直接上下游</small></header>
    <textarea value={text} disabled={busy} rows={3}
      placeholder="说清楚：哪个接口/契约变了，影响什么，哪里还需要谁确认…"
      onChange={(event) => setText(event.target.value)} />
    <div className="cross-repository-sync-actions">
      <span>{feedback || "这不是聊天广播；相关 Agent 会把它作为待核对的协作事实。"}</span>
      <button type="button" disabled={busy || !text.trim()}
        onClick={() => void publish()}>{busy ? "正在同步…" : "同步给上下游"}</button>
    </div>
    {updates.length > 0 && <details>
      <summary>收到的跨仓同步 <b>{updates.length}</b></summary>
      <ol>{updates.slice(-8).reverse().map((update) => <li key={update.id}>
        <div><strong>{update.source_repository ?? update.source_task_id}</strong>
          <span>{update.author} · {formatLocalDateTime(update.created_at)}</span></div>
        <p>{update.text}</p>
      </li>)}</ol>
    </details>}
  </section>;
}
