/**
 * 历史看板:PG 投影的跨生命周期回望(只读)。
 *
 * 统计瓦片遵循 dataviz 契约:label(无冒号)+ value(半粗、比例
 * 数字),身份由「色点 + 文字标签」共同承载——状态色从不裸用
 * (红绿相邻对色弱不友好,标签是兜底通道,这是 status 与
 * categorical 的规则分野;对比度两种模式均 ≥3:1,验证器跑过)。
 * 没配 --pg 的空态是设计过的:说清楚为什么没有、怎么开启,
 * 服务端解释原样呈现——不装作"没有历史"。
 */

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

/** 瓦片定义:计数口径与语义色调。已完成含 await_merge(流水线绿了
 * 只差人合入);进行中含 verifying(流水线还在跑)。 */
const TILES = [
  { label: "总数", tone: "neutral",
    match: (_status: string) => true },
  { label: "进行中", tone: "acc",
    match: (status: string) =>
      ["queued", "running", "verifying"].includes(status) },
  { label: "等待人工", tone: "warn",
    match: (status: string) => status === "waiting_for_human" },
  { label: "已完成", tone: "ok",
    match: (status: string) =>
      ["completed", "await_merge"].includes(status) },
  { label: "出错", tone: "danger",
    match: (status: string) => status === "failed" },
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
    <section className="board">
      <div className="board-head">
        <h2 className="board-title">历史看板</h2>
        <span className="board-tag">投影 · 跨生命周期 · 只读</span>
        <button className="board-refresh" onClick={() => void load()}>
          ↻ 刷新
        </button>
      </div>

      {loading && (
        <div className="board-skeleton" aria-label="加载中">
          <div className="skeleton tile-skeleton" />
          <div className="skeleton row-skeleton" />
          <div className="skeleton row-skeleton" />
          <div className="skeleton row-skeleton" />
        </div>
      )}

      {!loading && unavailable && (
        <div className="board-empty">
          <span className="glyph">▦</span>
          <div className="board-empty-title">历史看板需要 PostgreSQL 投影</div>
          <div className="board-empty-body">{unavailable}</div>
          <code className="board-empty-hint">
            npm run serve -- --pg postgresql://&lt;用户&gt;@&lt;地址&gt;/&lt;库名&gt;
          </code>
          <div className="board-empty-note">
            投影只是读侧:文件即真相,开启后历史自动补齐,不需要迁移。
          </div>
        </div>
      )}

      {!loading && entries && entries.length === 0 && !unavailable && (
        <div className="board-empty">
          <span className="glyph">▦</span>
          <div className="board-empty-title">投影里还没有任务</div>
          <div className="board-empty-note">
            发起第一单后,这里会留下跨生命周期的完整轨迹。
          </div>
        </div>
      )}

      {!loading && entries && entries.length > 0 && (
        <>
          <div className="tiles">
            {TILES.map((tile) => (
              <div className="tile" key={tile.label}>
                <span className="tile-head">
                  <span className={`tile-dot ${tile.tone}`} aria-hidden />
                  <span className="tile-label">{tile.label}</span>
                </span>
                <span className="tile-value">
                  {entries.filter((entry) => tile.match(entry.status)).length}
                </span>
              </div>
            ))}
          </div>
          <div className="board-rows">
            {entries.map((entry) => (
              <div className="board-row" key={entry.id}>
                <span className="task-id">{entry.id}</span>
                <span className={`pill ${entry.status}`}>
                  {STATUS_TEXT[entry.status] ?? entry.status}
                </span>
                <span className="board-row-title" title={entry.requirement}>
                  {entry.requirement}
                </span>
                {entry.delivery?.mr_url && (
                  <a
                    className="board-row-mr"
                    href={entry.delivery.mr_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    MR ↗
                  </a>
                )}
                <span className="board-row-meta">
                  {entry.event_count} 事件 · {timeAgo(entry.updated_at)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
