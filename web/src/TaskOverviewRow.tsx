import { PersonName } from "./People";
import { formatLocalDateTime, relativeTime } from "./time";

/** Overview navigation only: task details and actions live in the workspace. */
export function TaskOverviewRow({ id, ticket, title, status, statusLabel, owner,
  updatedAt, detail, child = false, focused = false, issue = false, onOpen,
  attention = false, childCount = 0, parentId, parentLabel, parentTitle, onOpenParent,
}: {
  id: string; ticket?: string; title: string; status: string; statusLabel: string;
  owner?: string; updatedAt: string; detail?: string; child?: boolean;
  focused?: boolean; issue?: boolean; onOpen: () => void;
  attention?: boolean;
  childCount?: number; parentId?: string; parentLabel?: string; parentTitle?: string; onOpenParent?: () => void;
}) {
  const tone = status === "failed" ? "danger"
    : attention || ["waiting_for_human", "waiting_user", "idle", "paused", "suspended"].includes(status) ? "attention"
    : ["completed", "archived"].includes(status) ? "done"
    : status === "await_merge" ? "merge"
    : ["running", "verifying", "coordinating", "pausing"].includes(status) ? "active" : "quiet";
  return <article data-status-tone={tone} id={`${issue ? "issue" : "task"}-${id}`}
    className={`task-overview-row status-${status}${child ? " is-child" : ""}${focused ? " focused" : ""}`}>
    <button type="button" className="task-overview-open" onClick={onOpen}
      aria-label={`打开${issue ? "问题" : "任务"}工作台：${title}`}>
      <span className="task-overview-id" title={`${ticket ?? ""} ${id}`}>{ticket || id}</span>
      <strong className="task-overview-title" title={title}>{child && <small>子任务 · </small>}{issue && <small>问题 · </small>}{title}</strong>
      <span className={`task-overview-status ${status}`} title={detail || statusLabel}><i aria-hidden />{statusLabel}</span>
      <span className="task-overview-owner" title={`负责人：$<PersonName account={owner} />`}><PersonName account={owner} /></span>
      <time className="task-overview-time" dateTime={updatedAt} title={formatLocalDateTime(updatedAt)}>{relativeTime(updatedAt) || "刚刚"}</time>
      <span className="task-overview-arrow" aria-hidden>›</span>
    </button>
    <span className="task-overview-relation">
      {parentId ? <button type="button" disabled={!onOpenParent} onClick={onOpenParent}
        aria-label={`返回主任务：${parentTitle || parentId}`}
        title={`主任务：${parentTitle || parentId}（${parentLabel || parentId}）${!onOpenParent ? "；当前无可打开的主任务" : ""}`}>
        <span aria-hidden>↳ </span>{parentLabel || parentId}
      </button> : childCount > 0 ? <span title={`主任务，共 ${childCount} 个子任务；进入工作台查看全部`}>
        主任务 · {childCount}<span className="task-overview-children-word"> 子任务</span>
      </span> : null}
      {parentId && childCount > 0 && <small title={`${childCount} 个下级任务`}> · {childCount} 子</small>}
    </span>
  </article>;
}
