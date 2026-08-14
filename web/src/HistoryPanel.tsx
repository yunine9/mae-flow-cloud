/**
 * 历史(投影):跨生命周期的只读任务列表,数据来自 PG 投影。
 * 与上方活任务区分明:这里不是操作入口,只是看板/审计的回望——
 * 数据目录清理或换机后,历史只活在投影里。展开才查;没配 --pg
 * 时把服务端的解释原样呈现。
 */

import { useState } from "react";
import { listHistory, STATUS_TEXT, type TaskHistoryEntry } from "./api";

function timeAgo(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

export function HistoryPanel() {
  const [entries, setEntries] = useState<TaskHistoryEntry[]>();
  const [unavailable, setUnavailable] = useState("");

  async function load() {
    const result = await listHistory();
    if (result.unavailable) setUnavailable(result.unavailable);
    else setEntries(result.entries ?? []);
  }

  return (
    <details className="history" onToggle={(toggle) => {
      if ((toggle.target as HTMLDetailsElement).open) void load();
    }}>
      <summary>
        历史(投影)
        <span className="history-hint">跨生命周期,只读</span>
      </summary>
      {unavailable && <div className="note">{unavailable}</div>}
      {entries && entries.length === 0 && (
        <div className="note">投影里还没有任务。</div>
      )}
      {entries && entries.map((entry) => (
        <div className="history-row" key={entry.id}>
          <span className="task-id">{entry.id}</span>
          <span className={`pill ${entry.status}`}>
            {STATUS_TEXT[entry.status] ?? entry.status}
          </span>
          <span className="history-title">{entry.requirement}</span>
          <span className="history-meta">
            {entry.event_count} 条事件 · {timeAgo(entry.updated_at)}
          </span>
        </div>
      ))}
    </details>
  );
}
