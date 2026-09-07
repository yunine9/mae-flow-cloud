import { AnnotationStore, TASK_REQUIREMENT_ARTIFACT, type Annotation } from "./annotations.ts";
import { TaskControlError } from "./errors.ts";

// 锁只管同进程串行；队列以批注账里的 requirement_queue 持久化。
const writers = new WeakMap<object, Set<string>>();

export function resetQueuedRequirementReviews(store: AnnotationStore): void {
  for (const item of store.list()) {
    if (item.status === "sent"
        && ["requirement_queue", "requirement_review"].includes(item.sent_via ?? "")) {
      store.reopen(item.id, item.author);
    }
  }
}

export async function submitRequirementReview(
  task: { summary: { status: string; waiting?: { step?: string } } },
  store: AnnotationStore,
  annotations: Annotation[],
  run: (batch: Annotation[]) => Promise<void>,
  onBackgroundError?: (error: unknown) => void,
): Promise<void> {
  if (!annotations.length || annotations.some((item) =>
    item.artifact !== TASK_REQUIREMENT_ARTIFACT)) {
    throw new TaskControlError("需求确认阶段只能提交需求文档上的检视意见");
  }
  if (task.summary.status !== "waiting_for_human"
      || task.summary.waiting?.step !== "cloud_requirement_analysis_confirm") {
    throw new TaskControlError("当前已经不在需求确认阶段");
  }
  // 页面尚未刷新或网络重试：已接收的当前版本只回执，不重复执行。
  annotations = annotations.filter((item) => item.status === "draft"
    || item.sent_via === "owner_pending");
  if (!annotations.length) return;
  const active = writers.get(task);
  if (active) {
    // 重复点击同一批不重跑；新意见先持久化，HTTP 无需等待当前 Agent。
    store.markSent(annotations.filter((item) => !active.has(item.id))
      .map((item) => item.id), "requirement_queue");
    return;
  }
  const current = new Set<string>();
  writers.set(task, current);
  const processing = drainRequirementReviews(task, store, annotations, current, run);
  // HTTP 只等接收和落盘；Agent 的整轮执行不能占住提交请求。
  if (onBackgroundError) {
    void processing.catch(onBackgroundError);
    return;
  }
  await processing;
}

async function drainRequirementReviews(
  task: object,
  store: AnnotationStore,
  annotations: Annotation[],
  current: Set<string>,
  run: (batch: Annotation[]) => Promise<void>,
): Promise<void> {
  let batch = annotations;
  try {
    while (batch.length) {
      current.clear();
      batch.forEach((item) => current.add(item.id));
      // 第一批也必须先登记“处理中”，否则页面仍把它当草稿反复提交。
      store.markSent(batch.map((item) => item.id), "requirement_review");
      await run(batch);
      // 每轮重新读账，撤回/改写为草稿的意见不能被自动带入下一轮。
      batch = store.list().filter((item) => item.status === "sent"
        && item.sent_via === "requirement_queue");
    }
  } catch (error) {
    // 失败不把尚未处理的意见留成假“处理中”；保留正文，允许显式重提。
    resetQueuedRequirementReviews(store);
    throw error;
  } finally {
    writers.delete(task);
  }
}
