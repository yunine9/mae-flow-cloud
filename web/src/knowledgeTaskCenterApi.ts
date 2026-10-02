import type { KnowledgeTaskCenterData, KnowledgeTaskRow } from "../../src/knowledgeTaskCenterTypes";
import { instantMs } from "./time";
export type { KnowledgeTaskCenterData, KnowledgeTaskGroup, KnowledgeTaskKind, KnowledgeTaskRow, KnowledgeTaskSummary } from "../../src/knowledgeTaskCenterTypes";

/** 后台归档不影响阅读；只有仍在研究或需要恢复执行的任务打开过程。 */
export function knowledgeTaskOpensDocument(task: Pick<KnowledgeTaskRow, "status">) {
  return !["queued", "running", "failed", "cancelled", "idle"].includes(task.status);
}

export async function getKnowledgeTasks(signal?: AbortSignal): Promise<KnowledgeTaskCenterData> {
  const response = await fetch("/knowledge-tasks", { signal });
  if (!response.ok) throw new Error("知识任务暂时无法加载，请稍后重试");
  return response.json() as Promise<KnowledgeTaskCenterData>;
}

/** 只有真实开始、结束时间或仍在运行时才可计算执行历时。 */
export function knowledgeTaskElapsed(task: Pick<KnowledgeTaskRow, "started_at" | "finished_at" | "status">, now = Date.now()): string {
  const start = instantMs(task.started_at);
  const end = task.finished_at ? instantMs(task.finished_at) : task.status === "running" ? now : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "—";
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}
