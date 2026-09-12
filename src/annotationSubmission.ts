import { OVERALL_STORY_ARTIFACT } from "./overallStoryStore.ts";
import { AnnotationStore, AnnotationPermissionError, type Annotation, TASK_REQUIREMENT_ARTIFACT } from "./annotations.ts";
import { NotFoundError, TaskControlError } from "./errors.ts";

/** 记下即为团队意见。旧 route、作者身份和管理员身份均不代替当前责任人。 */
export function assertAnnotationOwnerAccess(actor: string, owner: string, status: string): void {
  if (actor !== owner) throw new AnnotationPermissionError(`只有当前任务责任人 ${owner} 可以处理检视意见`);
  if (status === "canceled") throw new TaskControlError("任务已停止，检视记录保留，不再处置");
}

/** 计算提交权限与第一份稳定快照。allowForeign 只是调用意图，不能越过责任人身份。 */
export function annotationSubmissionPlan(input: {
  items: Annotation[]; ids?: string[]; sender: string; owner: string;
  allowForeign: boolean; requirementReview: boolean;
}): { selected: Annotation[]; maySendForeign: boolean } {
  assertAnnotationOwnerAccess(input.sender, input.owner, "active");
  const maySendForeign = !!input.ids?.length;
  return { maySendForeign, selected: pickAnnotationSubmission(
    input.items, input.ids, input.sender, maySendForeign, input.requirementReview) };
}

// TaskService 每次读取会新建 Store，锁按同一个账本路径共享。
const submitting = new Map<string, Set<string>>();

/** 先登记当前版本交接再做异步发送。失败只退回尚未送出的版本，不能撤销真回执。 */
export async function submitAnnotationSnapshot<T>(store: AnnotationStore, selected: Annotation[],
  sender: string, context: string, deliver: (snapshot: Annotation[]) => Promise<T>): Promise<T> {
  if (context.trim().length > 4000) throw new TaskControlError("补充说明最多 4000 字");
  const active = submitting.get(store.path) ?? new Set<string>();
  if (selected.some(item => active.has(item.id))) throw new TaskControlError("这些意见正在发送，请等待本次提交完成");
  submitting.set(store.path, active);
  selected.forEach(item => active.add(item.id));
  try {
    for (const item of selected) {
      if (item.status === "draft" || (item.status === "sent" && item.sent_via === "owner_pending")) {
        store.assignToAgent(item.id, sender, context);
      }
    }
    const current = new Map(store.list().map(item => [item.id, item]));
    return await deliver(selected.map(item => current.get(item.id)!));
  } catch (error) {
    store.resetUnsentAssignments(selected);
    throw error;
  } finally {
    selected.forEach(item => active.delete(item.id));
    if (!active.size) submitting.delete(store.path);
  }
}

export function pickAnnotationSubmission(
  items: Annotation[], ids?: string[], actor?: string,
  allowForeign = false, acceptRequirementSubmitted = false,
): Annotation[] {
  const eligible = items.filter((item) => item.status === "draft"
    || (!!ids?.length && item.artifact === OVERALL_STORY_ARTIFACT
      && ["sent", "verified"].includes(item.status)
      && ["overall_story_queue", "overall_story_processing", "overall_story"].includes(item.sent_via ?? ""))
    || (acceptRequirementSubmitted && !!ids?.length
      && item.artifact === TASK_REQUIREMENT_ARTIFACT
      && (item.route ?? "agent") === "agent"
      && ["sent", "verified"].includes(item.status)
      && (["requirement_queue", "requirement_review"].includes(item.sent_via ?? "")
        || (item.sent_via === "interrupt" && !!item.response))));
  // 省略 ID 时只能提交本人草稿，不能顺手带上他人的私人意见。
  const available = actor && (!allowForeign || !ids?.length)
    ? eligible.filter((item) => item.author === actor) : eligible;
  if (!ids?.length) {
    if (!available.length) throw new NotFoundError("没有待送出的批注");
    return available;
  }
  const wanted = new Set(ids);
  const picked = available.filter((item) => wanted.has(item.id));
  if (picked.length !== wanted.size) {
    throw new NotFoundError(actor
      ? "有批注不存在、已经送出，或不是你写的"
      : "有批注不存在或已经送出去了");
  }
  return picked;
}

export function requirementSubmissionReceipt(items: Annotation[], ids: string[]): string {
  const picked = items.filter((item) => ids.includes(item.id));
  const processing = picked.filter((item) => item.sent_via === "requirement_review").length;
  const queued = picked.filter((item) => item.sent_via === "requirement_queue").length;
  const processed = picked.filter((item) => item.sent_via === "interrupt" && !!item.response).length;
  if (!processing && !queued && !processed) {
    return "处理未启动或已失败，意见仍在待提交；请查看任务失败原因后重试。";
  }
  return [
    processing ? `${processing} 条正在由 Agent 处理` : "",
    queued ? `${queued} 条已排队，当前一批完成后自动处理` : "",
    processed ? `${processed} 条已有处理回执，请逐条复检` : "",
  ].filter(Boolean).join("；") + "。无需重复提交。";
}
