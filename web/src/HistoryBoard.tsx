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
import { TaskStatusBadge } from "./StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert } from "@/components/Alert";
import { Database } from "lucide-react";
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/Empty";
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

/** 指标瓦片语调(原 .history-metric.{neutral,active,attention,success,danger})。 */
const TONE = {
  neutral: "text-muted-foreground",
  active: "text-active",
  attention: "text-attention",
  success: "text-success",
  danger: "text-danger",
} as const;

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
    <section className="grid gap-4">
      <div className="flex items-center justify-between gap-6 rounded-xl border border-line
        bg-surface px-6 py-[22px] shadow-xs">
        <div>
          <h2 className="text-lg font-bold text-text-strong">成果档案</h2>
          <p className="mt-[7px] text-sm text-muted-foreground">这里保存待合入、完成、失败和取消的任务；进行中的工作回到“当前现场”查看。</p>
        </div>
        <button className="inline-flex h-[38px] cursor-pointer items-center gap-[7px] rounded-lg
          border border-line-strong bg-surface px-[13px] text-[13.5px] font-bold text-text
          hover:border-primary hover:text-primary" onClick={() => void load()}>
          <svg viewBox="0 0 20 20" aria-hidden className="size-4 fill-none stroke-current stroke-[1.6]">
            <path d="M15.5 7A6 6 0 1 0 16 12M15.5 3v4h-4" />
          </svg>
          刷新数据
        </button>
      </div>

      {loading && (
        <div className="grid gap-3" aria-label="加载中">
          {/* #218:占位形状与旧 .metric-skeleton/.table-skeleton 等价 */}
          <Skeleton className="h-[94px]" />
          <Skeleton className="h-[280px]" />
        </div>
      )}

      {!loading && usingWorkspace && visibleEntries.length > 0 && (
        <div className="-mt-2 mb-4 flex items-center gap-[11px] rounded-lg border border-primary/20
          bg-primary/5 px-3.5 py-[11px]" role="status" title={unavailable}>
          <span aria-hidden className="grid size-[26px] flex-none place-items-center rounded-lg
            bg-surface text-base font-bold text-primary shadow-[inset_0_0_0_1px_var(--line)]">◎</span>
          <span className="grid min-w-0 gap-0.5">
            <strong className="text-[13px] text-text-strong">当前使用本服务保留的交付结果</strong>
            <small className="text-[13px] leading-[1.45] text-muted-foreground">历史投影暂不可用；这里只展示已经形成结果的任务，恢复后会自动切换。</small>
          </span>
        </div>
      )}

      {actionError && <Alert variant="destructive" className="mb-3">{actionError}</Alert>}

      {!loading && visibleEntries.length === 0 && (
        <Empty className="min-h-[360px] border" role="status">
          <EmptyMedia variant="icon"><Database aria-hidden /></EmptyMedia>
          <EmptyTitle>{usingWorkspace ? "当前没有成果档案" : "成果档案里还没有记录"}</EmptyTitle>
          <EmptyDescription>
            任务进入待合入、完成、失败或取消后，会在这里留下记录。
          </EmptyDescription>
        </Empty>
      )}

      {!loading && visibleEntries.length > 0 && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2.5 min-[1081px]:grid-cols-4">
            {TILES.map((tile) => (
              <div key={tile.label}
                className={`flex min-h-[94px] flex-col justify-between rounded-lg border border-line bg-surface px-[15px] py-3.5 shadow-xs ${TONE[tile.tone]}`}>
                <span className="flex items-center gap-[7px] text-[13px] font-semibold">
                  <i aria-hidden className="size-2 rounded-full bg-current" />{tile.label}</span>
                <strong className="text-[27px] leading-none tabular-nums">
                  {visibleEntries.filter((entry) => tile.match(entry.status)).length}
                </strong>
              </div>
            ))}
          </div>

          <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-xs">
            <div aria-hidden className="grid items-center gap-4 border-b border-line bg-surface-2 px-[15px] py-2.5
              text-[13px] font-bold text-muted-foreground
              [grid-template-columns:minmax(260px,2.25fr)_minmax(140px,1fr)_minmax(120px,0.8fr)_90px_100px_minmax(100px,0.7fr)]">
              <span>任务</span>
              <span>状态</span>
              <span>交付</span>
              <span>事件</span>
              <span>最近更新</span>
              <span>操作</span>
            </div>
            <div>
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
                  <div key={entry.id} className="grid min-h-[70px] items-center gap-4 border-b border-line
                    px-[15px] py-[11px] transition-colors last:border-b-0 hover:bg-surface-2
                    [grid-template-columns:minmax(260px,2.25fr)_minmax(140px,1fr)_minmax(120px,0.8fr)_90px_100px_minmax(100px,0.7fr)]">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="w-fit rounded bg-surface-3 px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{entry.id}</span>
                      {currentTask && onOpenTask ? (
                        <button
                          className="group grid min-w-0 cursor-pointer justify-items-start gap-[3px] border-0 bg-none p-0 text-left focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-focus"
                          title={`${title} · 打开工作台`}
                          onClick={() => onOpenTask(currentTask)}
                        >
                          <strong className="max-w-full truncate text-sm font-bold text-text-strong group-hover:text-primary">{title}</strong>
                          <span className="text-[13px] font-semibold text-muted-foreground group-hover:text-primary">打开工作台 <i aria-hidden className="not-italic">→</i></span>
                        </button>
                      ) : <strong title={title} className="truncate text-sm font-bold text-text-strong">{title}</strong>}
                      <TokenUsage usage={entry.token_usage} placement="history" />
                    </div>
                    <div>
                      <TaskStatusBadge status={entry.status}>
                        {STATUS_TEXT[entry.status] ?? entry.status}
                      </TaskStatusBadge>
                    </div>
                    <div>
                      {entry.delivery?.mr_url ? (
                        <a
                          href={entry.delivery.mr_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[13px] font-bold text-primary hover:underline"
                        >
                          MR · {entry.delivery.mr_state ?? "查看"}
                          <svg viewBox="0 0 16 16" aria-hidden className="size-3.5 fill-none stroke-current stroke-[1.5]">
                            <path d="M6 3.5h6.5V10M12.25 3.75 5 11" />
                          </svg>
                        </a>
                      ) : <span className="text-faint">—</span>}
                    </div>
                    <div className="flex flex-col">
                      {usingWorkspace ? (
                        <><strong className="text-[13px] text-primary">现场</strong><span className="text-[13px] text-muted-foreground">查看详情</span></>
                      ) : (
                        <><strong className="text-[15px] text-text-strong">{entry.event_count}</strong><span className="text-[13px] text-muted-foreground">个事件</span></>
                      )}
                    </div>
                    <time dateTime={entry.updated_at} className="text-[13px] text-muted-foreground">{timeAgo(entry.updated_at)}</time>
                    <div className="flex flex-wrap justify-end gap-[5px]">
                      {canRerun && (
                        <button type="button" disabled={Boolean(busy)}
                          className="min-h-[30px] cursor-pointer rounded-[7px] border border-line-strong bg-surface px-[9px] text-[13px] font-bold text-text hover:border-primary hover:text-primary disabled:cursor-wait disabled:opacity-55"
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
                        <button type="button"
                          className="min-h-[30px] cursor-pointer rounded-[7px] border border-line-strong bg-surface px-[9px] text-[13px] font-bold text-text hover:border-danger/55 hover:text-danger disabled:cursor-wait disabled:opacity-55"
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
                      {!canRerun && !canDelete && <span className="text-[13px] text-faint">—</span>}
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
