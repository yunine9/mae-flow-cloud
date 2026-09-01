/** 历史投影优先、本服务交付结果兜底的只读档案。 */

import { useEffect, useState } from "react";
import {
  deleteHistoryTask,
  listHistory,
  rerunTaskFromStart,
  STATUS_TEXT,
  type AuthUser,
  type TaskHistoryEntry,
  type TaskSummary,
} from "./api";
import {
  historyTaskTitle,
  isDeliveryArchiveStatus,
  workspaceHistoryEntries,
} from "./historyModel";
import { confirmDialog } from "./ConfirmDialog";
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
  { label: "全部档案", tone: "neutral", match: (_status: string) => true },
  {
    label: "待合入",
    tone: "attention",
    match: (status: string) => status === "await_merge",
  },
  {
    label: "已完成",
    tone: "success",
    match: (status: string) => status === "completed",
  },
  {
    label: "异常 / 已取消",
    tone: "danger",
    match: (status: string) => ["failed", "canceled"].includes(status),
  },
] as const;

interface HistoryBoardProps {
  tasks: TaskSummary[];
  viewer: AuthUser;
  onChanged: () => void | Promise<void>;
  onOpenTask?: (task: TaskSummary) => void;
}

export function HistoryBoard({
  tasks,
  viewer,
  onChanged,
  onOpenTask,
}: HistoryBoardProps) {
  const [entries, setEntries] = useState<TaskHistoryEntry[]>();
  const [unavailable, setUnavailable] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");

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
  const allEntries = usingWorkspace ? workspaceEntries : (entries ?? []);
  const visibleEntries = allEntries.filter((entry) =>
    isDeliveryArchiveStatus(entry.status));
  const currentTasks = new Map(tasks.map((task) => [task.id, task]));

  return (
    <section className="history-board">
      <div className="history-intro">
        <div>
          <span className="section-kicker">DELIVERY ARCHIVE</span>
          <h2>交付档案</h2>
          <p>这里保存待合入、完成、失败和取消的任务；进行中的工作回到“当前现场”查看。</p>
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
            <strong>当前使用本服务保留的交付结果</strong>
            <small>历史投影暂不可用；这里只展示已经形成结果的任务，恢复后会自动切换。</small>
          </span>
        </div>
      )}

      {actionError && <div className="alert history-action-error">{actionError}</div>}

      {!loading && visibleEntries.length === 0 && (
        <div className="board-empty">
          <span className="empty-database" aria-hidden>
            <i /><i /><i />
          </span>
          <strong>{usingWorkspace ? "当前没有交付档案" : "交付档案里还没有记录"}</strong>
          <p>
            任务进入待合入、完成、失败或取消后，会在这里留下记录。
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
              <span>操作</span>
            </div>
            <div className="history-rows">
              {visibleEntries.map((entry) => {
                const currentTask = currentTasks.get(entry.id);
                const title = historyTaskTitle(entry);
                const terminal = ["completed", "failed", "canceled"]
                  .includes(entry.status);
                const canRerun = viewer.role !== "admin" && terminal
                  && currentTask?.luban_account === viewer.username;
                const canDelete = terminal && (viewer.role === "admin"
                  || entry.luban_account === viewer.username);
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
                    <div className="history-actions">
                      {canRerun && (
                        <button type="button" disabled={Boolean(busy)}
                          onClick={async () => {
                            if (!await confirmDialog({
                              title: "清空重跑",
                              message: `将清空 ${entry.id} 的旧现场并从第一步重跑。`
                                + "同一任务编号会被覆盖，此操作不可撤销。",
                              confirmLabel: "清空并重跑",
                              danger: true,
                            })) return;
                            setBusy(entry.id);
                            setActionError("");
                            try {
                              const result = await rerunTaskFromStart(entry.id);
                              if (result.error) setActionError(result.error);
                              else {
                                await onChanged();
                                await load();
                              }
                            } catch (error) {
                              setActionError(error instanceof Error
                                ? error.message : String(error));
                            } finally {
                              setBusy("");
                            }
                          }}>
                          {busy === entry.id ? "处理中…" : "清空重跑"}
                        </button>
                      )}
                      {canDelete && (
                        <button type="button" className="danger"
                          disabled={Boolean(busy)} onClick={async () => {
                            if (!await confirmDialog({
                              title: "彻底删除任务",
                              message: `将彻底删除 ${entry.id}「${title}」。`
                                + "工作区、事件、检视与数据库历史都会永久删除，"
                                + "此操作不可撤销。",
                              confirmLabel: "彻底删除",
                              danger: true,
                            })) return;
                            setBusy(entry.id);
                            setActionError("");
                            try {
                              const result = await deleteHistoryTask(entry.id);
                              if (result.error) setActionError(result.error);
                              else {
                                await onChanged();
                                await load();
                              }
                            } catch (error) {
                              setActionError(error instanceof Error
                                ? error.message : String(error));
                            } finally {
                              setBusy("");
                            }
                          }}>
                          {busy === entry.id ? "删除中…" : "彻底删除"}
                        </button>
                      )}
                      {!canRerun && !canDelete && <span>—</span>}
                    </div>
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
