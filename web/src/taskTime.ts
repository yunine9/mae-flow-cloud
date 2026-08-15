/**
 * 时间维度:领导判断阻塞看的是"等了多久",不是"有几项在等"。
 * 等待时长全部由 waiting.created_at 算出——服务端本来就发,
 * 前端只做呈现,不推断状态。
 */

import type { TaskSummary } from "./api";

/** 超过这个分钟数视为久等:徽章升级为红色,排序也靠它。 */
export const URGENT_MINUTES = 30;

/** 等待中的任务已等毫秒数;不在等待或没有时间戳返回 -1。 */
export function waitedMs(task: TaskSummary): number {
  if (task.status !== "waiting_for_human") return -1;
  const iso = task.waiting?.created_at;
  if (!iso) return -1;
  const started = new Date(iso).getTime();
  if (Number.isNaN(started)) return -1;
  return Math.max(0, Date.now() - started);
}

export function formatWait(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}

/** 排序:等人的排最前(等最久的第一),其余按创建时间倒序。
 * "谁在等我、等了多久"是这块屏幕最该先回答的问题。 */
export function byUrgency(a: TaskSummary, b: TaskSummary): number {
  const left = waitedMs(a);
  const right = waitedMs(b);
  if (left >= 0 && right >= 0) return right - left;
  if (left >= 0) return -1;
  if (right >= 0) return 1;
  return b.created_at.localeCompare(a.created_at);
}
