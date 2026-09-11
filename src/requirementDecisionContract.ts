/** 拆单动作只认平台选项。模型自由文案在展示之前归一，不改写人的历史答复。 */
export const REQUIREMENT_GRAPH_CONFIRM = "确认并生成任务";
export const REQUIREMENT_GRAPH_NO_CHANGE_CONFIRM = "确认分析结论";
export function confirmsRequirementGraph(answer: string): boolean {
  return [REQUIREMENT_GRAPH_CONFIRM, REQUIREMENT_GRAPH_NO_CHANGE_CONFIRM].includes(answer.trim());
}

export function requirementDecisionContract(question: Record<string, unknown>, analysis: boolean): Record<string, unknown> {
  const items = question.questions as Array<{ question: string; options?: string[]; recommended?: string }> | undefined;
  if (!analysis || question.purpose === "clarification" || !Array.isArray(items) || items.length !== 1 || !Array.isArray(items[0]?.options)) return question;
  const canonical = (option: string) => {
    if (confirmsRequirementGraph(option)) return option.trim();
    // 这里只识别举卡意图，不用于裁决用户答复。否定、暂缓和澄清不升级为确认。
    if (!/^确认/.test(option) || /不|暂|取消|拒绝/.test(option)) return option;
    if (/生成任务/.test(option)) return REQUIREMENT_GRAPH_CONFIRM;
    if (/分析结论/.test(option)) return REQUIREMENT_GRAPH_NO_CHANGE_CONFIRM;
    return option;
  };
  const item = items[0];
  return { ...question, questions: [{ ...item,
    options: [...new Set(item.options!.map(canonical))],
    ...(item.recommended ? { recommended: canonical(item.recommended) } : {}),
  }] };
}
