import type { StepChoiceEffect } from "./kernelChoices.ts";

export const REVIEW_ADJUST = "需要调整，按检视意见继续处理";
export const REVIEW_HOLD = "暂不确认，我先核对";

/** 正式单题检视由流程契约提供动作。澄清、多题和已有分支保持原样。
 * 只修正完全对不上契约的模型选项，绝不把历史回答翻译成“同意”。 */
export function reviewDecisionContract(
  question: Record<string, unknown>, effects: StepChoiceEffect[],
): { question: Record<string, unknown>; effects: StepChoiceEffect[] } {
  const items = question.questions as Array<{ question: string; options?: string[]; recommended?: string }> | undefined;
  const confirmation = effects.length === 1 && effects[0].key === "confirm"
    && effects[0].closesFeedback ? effects[0] : undefined;
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
  return { question: normalized, effects: options.includes(REVIEW_ADJUST)
    ? [...effects, { key: "review_adjust", answers: [REVIEW_ADJUST],
      allowsSourceEdit: true, handlesFeedback: true, closesFeedback: false }]
    : effects };
}
