import { instantMs } from "./time";

interface HistoryTaskFields {
  id: string;
  title?: string;
  requirement: string;
  created_at: string;
  updated_at?: string;
  last_progress_at?: string;
}

/**
 * PostgreSQL 未启用时，用当前服务已经恢复的任务提供可用但不冒充历史的读侧。
 * event_count=0 只是类型占位；界面在现场模式下不会把它展示成历史事件数。
 */
export function workspaceHistoryEntries<T extends HistoryTaskFields>(
  tasks: T[],
): Array<T & { event_count: number; updated_at: string }> {
  return tasks
    .map((task) => ({
      ...task,
      event_count: 0,
      updated_at: task.updated_at ?? task.last_progress_at ?? task.created_at,
    }))
    .sort((left, right) => {
      const leftAt = instantMs(left.updated_at);
      const rightAt = instantMs(right.updated_at);
      return (Number.isFinite(rightAt) ? rightAt : 0)
        - (Number.isFinite(leftAt) ? leftAt : 0);
    });
}

export function historyTaskTitle(task: Pick<HistoryTaskFields, "id" | "title" | "requirement">): string {
  const title = task.title?.trim();
  if (title) return title;
  const firstLine = task.requirement.split(/\r?\n/, 1)[0]?.trim();
  return firstLine || task.id;
}
