/** PostgreSQL 投影的跨生命周期读侧：用于管理视角的整体回望。 */

import { useEffect, useState } from "react";
import { listHistory, STATUS_TEXT, type TaskHistoryEntry } from "./api";

function timeAgo(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

const TILES = [
  { label: "全部任务", tone: "neutral", match: (_status: string) => true },
  {
    label: "推进中",
    tone: "active",
    match: (status: string) => ["queued", "running", "verifying"].includes(status),
  },
  {
    label: "等待决策",
    tone: "attention",
    match: (status: string) => status === "waiting_for_human",
  },
  {
    label: "待合入 / 完成",
    tone: "success",
    match: (status: string) => ["completed", "await_merge"].includes(status),
  },
  {
    label: "异常",
    tone: "danger",
    match: (status: string) => status === "failed",
  },
] as const;

export function HistoryBoard() {
  const [entries, setEntries] = useState<TaskHistoryEntry[]>();
  const [unavailable, setUnavailable] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setUnavailable("");
    const result = await listHistory();
    if (result.unavailable) setUnavailable(result.unavailable);
    else setEntries(result.entries ?? []);
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  return (
    <section className="history-board">
      <div className="history-intro">
        <div>
          <span className="section-kicker">DELIVERY HISTORY</span>
          <h2>跨生命周期任务</h2>
          <p>以 PostgreSQL 投影快速浏览，现场文件仍是阶段事实源。</p>
        </div>
        <button className="refresh-button" onClick={() => void load()}>
          <svg viewBox="0 0 20 20" aria-hidden>
            <path d="M15.5 7A6 6 0 1 0 16 12M15.5 3v4h-4" />
          </svg>
          刷新数据
        </button>
      </div>

      {loading && (
        <div className="history-skeleton" aria-label="加载中">
          <div className="skeleton metric-skeleton" />
          <div className="skeleton table-skeleton" />
        </div>
      )}

      {!loading && unavailable && (
        <div className="board-empty">
          <span className="empty-database" aria-hidden>
            <i /><i /><i />
          </span>
          <strong>历史看板需要 PostgreSQL 投影</strong>
          <p>{unavailable}</p>
          <code>
            npm run serve -- --pg postgresql://&lt;用户&gt;@&lt;地址&gt;/&lt;库名&gt;
          </code>
          <small>开启后历史会自动补齐，不改变现场文件这一事实源。</small>
        </div>
      )}

      {!loading && entries && entries.length === 0 && !unavailable && (
        <div className="board-empty">
          <span className="empty-database" aria-hidden>
            <i /><i /><i />
          </span>
          <strong>投影里还没有任务</strong>
          <p>发起第一项工作后，这里会留下跨生命周期的完整轨迹。</p>
        </div>
      )}

      {!loading && entries && entries.length > 0 && (
        <>
          <div className="history-metrics">
            {TILES.map((tile) => (
              <div className={`history-metric ${tile.tone}`} key={tile.label}>
                <span><i aria-hidden />{tile.label}</span>
                <strong>
                  {entries.filter((entry) => tile.match(entry.status)).length}
                </strong>
              </div>
            ))}
          </div>

          <div className="history-table">
            <div className="history-table-head" aria-hidden>
              <span>任务</span>
              <span>状态</span>
              <span>交付</span>
              <span>事件</span>
              <span>最近更新</span>
            </div>
            <div className="history-rows">
              {entries.map((entry) => (
                <div className="history-row" key={entry.id}>
                  <div className="history-task">
                    <span className="task-id">{entry.id}</span>
                    <strong title={entry.requirement}>{entry.requirement}</strong>
                  </div>
                  <div>
                    <span className={`pill ${entry.status}`}>
                      <i aria-hidden />
                      {STATUS_TEXT[entry.status] ?? entry.status}
                    </span>
                  </div>
                  <div className="history-delivery">
                    {entry.delivery?.mr_url ? (
                      <a
                        href={entry.delivery.mr_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        MR · {entry.delivery.mr_state ?? "查看"}
                        <svg viewBox="0 0 16 16" aria-hidden>
                          <path d="M6 3.5h6.5V10M12.25 3.75 5 11" />
                        </svg>
                      </a>
                    ) : <span>—</span>}
                  </div>
                  <div className="history-events">
                    <strong>{entry.event_count}</strong>
                    <span>个事件</span>
                  </div>
                  <time dateTime={entry.updated_at}>{timeAgo(entry.updated_at)}</time>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
