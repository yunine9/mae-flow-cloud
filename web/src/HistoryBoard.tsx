/** 历史投影优先、当前任务现场兜底的只读回望。 */

import { useEffect, useState } from "react";
import {
  listHistory,
  STATUS_TEXT,
  type TaskHistoryEntry,
  type TaskSummary,
} from "./api";
import { historyTaskTitle, workspaceHistoryEntries } from "./historyModel";
import { formatLocalDate, instantMs } from "./time";
import { TokenUsage } from "./TokenUsage";

function timeAgo(iso: string): string {
  const minutes = Math.max(0,
    Math.floor((Date.now() - instantMs(iso)) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return formatLocalDate(iso);
}

const TILES = [
  { label: "全部任务", tone: "neutral", match: (_status: string) => true },
  {
    label: "推进中",
    tone: "active",
    match: (status: string) => ["queued", "running", "pausing", "verifying"]
      .includes(status),
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
    label: "异常 / 已取消",
    tone: "danger",
    match: (status: string) => ["failed", "canceled"].includes(status),
  },
] as const;

interface HistoryBoardProps {
  tasks: TaskSummary[];
  onOpenTask?: (task: TaskSummary) => void;
}

export function HistoryBoard({ tasks, onOpenTask }: HistoryBoardProps) {
  const [entries, setEntries] = useState<TaskHistoryEntry[]>();
  const [unavailable, setUnavailable] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setUnavailable("");
    try {
      const result = await listHistory();
      if (result.unavailable) setUnavailable(result.unavailable);
      else setEntries(result.entries ?? []);
    } catch (error) {
      setUnavailable(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  const workspaceEntries = workspaceHistoryEntries(tasks);
  const usingWorkspace = Boolean(unavailable);
  const visibleEntries = usingWorkspace ? workspaceEntries : (entries ?? []);
  const currentTasks = new Map(tasks.map((task) => [task.id, task]));

  return (
    <section className="history-board">
      <div className="history-intro">
        <div>
          <span className="section-kicker">DELIVERY HISTORY</span>
          <h2>任务与交付记录</h2>
          <p>优先回看跨生命周期历史；未启用投影时仍可浏览当前任务现场。</p>
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

      {!loading && usingWorkspace && visibleEntries.length > 0 && (
        <div className="history-source-note" role="status" title={unavailable}>
          <span className="history-source-icon" aria-hidden>◎</span>
          <span>
            <strong>当前使用任务现场</strong>
            <small>历史投影暂不可用；这里展示本服务仍保留的任务，恢复后会自动切换。</small>
          </span>
        </div>
      )}

      {!loading && visibleEntries.length === 0 && (
        <div className="board-empty">
          <span className="empty-database" aria-hidden>
            <i /><i /><i />
          </span>
          <strong>{usingWorkspace ? "当前没有可回看的任务" : "历史里还没有任务"}</strong>
          <p>
            {usingWorkspace
              ? "发起第一项工作后，这里就能直接进入任务现场。"
              : "发起第一项工作后，这里会留下跨生命周期的完整轨迹。"}
          </p>
        </div>
      )}

      {!loading && visibleEntries.length > 0 && (
        <>
          <div className="history-metrics">
            {TILES.map((tile) => (
              <div className={`history-metric ${tile.tone}`} key={tile.label}>
                <span><i aria-hidden />{tile.label}</span>
                <strong>
                  {visibleEntries.filter((entry) => tile.match(entry.status)).length}
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
              {visibleEntries.map((entry) => {
                const currentTask = currentTasks.get(entry.id);
                const title = historyTaskTitle(entry);
                return (
                  <div className="history-row" key={entry.id}>
                    <div className="history-task">
                      <span className="task-id">{entry.id}</span>
                      {currentTask && onOpenTask ? (
                        <button
                          className="history-task-button"
                          title={`${title} · 打开工作台`}
                          onClick={() => onOpenTask(currentTask)}
                        >
                          <strong>{title}</strong>
                          <span>打开工作台 <i aria-hidden>→</i></span>
                        </button>
                      ) : <strong title={title}>{title}</strong>}
                      <TokenUsage usage={entry.token_usage} placement="history" />
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
                    <div className={`history-events${usingWorkspace ? " current" : ""}`}>
                      {usingWorkspace ? (
                        <><strong>现场</strong><span>查看详情</span></>
                      ) : (
                        <><strong>{entry.event_count}</strong><span>个事件</span></>
                      )}
                    </div>
                    <time dateTime={entry.updated_at}>{timeAgo(entry.updated_at)}</time>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
