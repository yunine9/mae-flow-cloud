import { useState } from "react";
import {
  publishCrossRepositoryUpdate,
  type CrossRepositoryUpdate,
} from "./api";

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

  return <details className="cross-repository-sync">
    <summary>
      <div><span>按需使用</span><strong>通知上下游仓库</strong></div>
      <small>接口或约定变了，需要告诉依赖你或你依赖的仓库时再展开
        {updates.length > 0 && <b>{updates.length} 条往来在上面的流里</b>}
      </small>
      <i aria-hidden />
    </summary>
    <div className="cross-repository-sync-body">
      <p>写清楚哪个接口或约定变了、影响什么。它会回流给大任务，并送到依赖图上直接相邻的仓库；对方 Agent 会当成待核对的事实，不是聊天广播。</p>
      <textarea value={text} disabled={busy} rows={3}
        placeholder="说清楚：哪个接口/契约变了，影响什么，哪里还需要谁确认…"
        onChange={(event) => setText(event.target.value)} />
      <div className="cross-repository-sync-actions">
        <span>{feedback || "收到和发出的通知都按时间出现在上面的流里。"}</span>
        <button type="button" disabled={busy || !text.trim()}
          onClick={() => void publish()}>{busy ? "正在发送…" : "通知上下游"}</button>
      </div>
    </div>
  </details>;
}
