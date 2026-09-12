import { OVERALL_STORY_ARTIFACT } from "./overallStoryStore.ts";
import { AnnotationPermissionError, type Annotation, TASK_REQUIREMENT_ARTIFACT } from "./annotations.ts";
import { NotFoundError } from "./errors.ts";

/** 返回 true 表示调用者是任务责任人，可在落账时标记 owner_controlled。 */
export function annotationMutationAccess(
  item: Annotation, actor: string, owner: string,
): boolean {
  const ownerControlled = actor === owner;
  const authorControlled = item.author === actor
    && (item.route ?? "agent") === "agent" && !item.needs_owner_closure;
  if (!ownerControlled && !authorControlled) {
    throw new AnnotationPermissionError(
      `这条意见只能由提出人 ${item.author} 或当前任务责任人处理`);
  }
  return ownerControlled;
}

/** 计算提交权限与第一份稳定快照。allowForeign 只是调用意图，不能越过责任人身份。 */
export function annotationSubmissionPlan(input: {
  items: Annotation[]; ids?: string[]; sender: string; owner: string;
  allowForeign: boolean; requirementReview: boolean;
}): { selected: Annotation[]; maySendForeign: boolean } {
  const ownerSubmitting = input.sender === input.owner;
  const maySendForeign = ownerSubmitting && (input.allowForeign || !!input.ids?.length);
  const requested = input.ids?.length
    ? input.items.filter((item) => input.ids!.includes(item.id)) : [];
  if (!ownerSubmitting && requested.some((item) =>
    !["agent", "memory"].includes(item.route ?? "agent")
    && item.artifact !== OVERALL_STORY_ARTIFACT && !input.requirementReview)) {
    throw new AnnotationPermissionError(
      `这条意见需要当前任务责任人 ${input.owner} 处理`);
  }
  return { maySendForeign, selected: pickAnnotationSubmission(
    input.items, input.ids, input.sender, maySendForeign, input.requirementReview) };
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
