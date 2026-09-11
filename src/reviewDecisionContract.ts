import type { StepChoiceEffect } from "./kernelChoices.ts";

export const REVIEW_ADJUST = "需要调整，按检视意见继续处理";
export const REVIEW_HOLD = "暂不确认，我先核对";

/** 识别明确要求继续修改的检视选项。内核可让 Agent 按材料生成具体文案；
 * 暂缓、核对和提问不算返工。服务端与网页共用此判据。 */
export function isReviewAdjustmentAnswer(answer: string): boolean {
  const value = answer.replace(/\s+/g, "");
  return /先调整|仍需(?:调整|修改)|需要.*(?:调整|修改)|按(?:当前)?检视意见.*(?:调整|修改|处理)|返工/.test(value);
}

/** 正式单题检视由流程契约提供动作。澄清、多题和已有分支保持原样。
 * 只修正完全对不上契约的模型选项，绝不把历史回答翻译成“同意”。 */
export function reviewDecisionContract(
  question: Record<string, unknown>, effects: StepChoiceEffect[],
): { question: Record<string, unknown>; effects: StepChoiceEffect[] } {
  const items = question.questions as Array<{ question: string; options?: string[]; recommended?: string }> | undefined;
  const confirmation = effects.find(effect => effect.key === "confirm"
    && effect.closesFeedback);
  if (!confirmation || question.purpose === "clarification" || !Array.isArray(items)
      || items.length !== 1 || !Array.isArray(items[0]?.options) || !items[0].options.length) return { question, effects };
  const item = items[0];
  const canonical = confirmation.answers[0];
  if (!canonical) return { question, effects };
  const matched = item.options!.some(option => confirmation.answers.includes(option));
  const normalized = matched ? question : { ...question, questions: [{
    ...item, options: [canonical, REVIEW_ADJUST, REVIEW_HOLD], recommended: undefined,
  }] };
  const options = (normalized.questions as typeof items)[0].options!;
  const covered = new Set(effects.filter(effect => effect.handlesFeedback)
    .flatMap(effect => effect.answers));
  const adjustmentAnswers = options.filter(option =>
    isReviewAdjustmentAnswer(option) && !covered.has(option));
  return { question: normalized, effects: adjustmentAnswers.length
    ? [...effects, { key: "review_adjust", answers: adjustmentAnswers,
      allowsSourceEdit: true, handlesFeedback: true, closesFeedback: false }]
    : effects };
}

/** 整卡“按检视意见修复”接手全部尚未处置的意见。owner_reply 只是记下
 * 时的默认责任人队列；责任人尚未答复时，同样可随检视卡改交 Agent。 */
export function unassignedReviewDraft(item: { status: string; route?: string; owner_reply?: unknown; resolution?: unknown }): boolean {
  return item.status === "draft"
    && !item.owner_reply && !item.resolution
    && ["agent", "owner_decision", "owner_reply"].includes(item.route ?? "agent");
}
