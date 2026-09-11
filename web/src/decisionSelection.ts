/**
 * 决策卡的选项不是一次性锁死的：再次点击当前选项即取消，点击别的
 * 选项则切换。返回新对象，便于 React 状态更新，也不改写旧快照。
 */
export function toggleDecisionChoice(
  current: Readonly<Record<string, string>>,
  question: string | number,
  choice: string,
): Record<string, string> {
  const key = String(question);
  const next = { ...current };
  if (next[key] === choice) delete next[key];
  else next[key] = choice;
  return next;
}

/** 从某道题退出既有选项；没有选中时保留原对象，避免无意义刷新。 */
export function clearDecisionChoice(
  current: Readonly<Record<string, string>>,
  question: string | number,
): Record<string, string> {
  const key = String(question);
  if (!(key in current)) return current as Record<string, string>;
  const next = { ...current };
  delete next[key];
  return next;
}

/** One reply field: preserve an explicit branch; otherwise the text is the answer. */
export function unifiedDecisionReply(selected: string | undefined, text: string): {
  freeResponse: string; notes: string;
} {
  const reply = text.trim();
  return selected ? { freeResponse: "", notes: reply } : { freeResponse: reply, notes: "" };
}

/** 新旧推送卡的调整选项均走返工，不因清单加载或变化切回推送按钮。 */
export function isAdjustmentAnswer(answer: string): boolean {
  return /先调整|需要.*(?:调整|修改)|返工|补充/.test(answer);
}

/** 宿主确认只批准当前提交，不消费文件勾选；兼容旧服务遗留的 diff 投影。 */
export function needsDeliverySelection(waiting?: { step?: string; recommended_view?: string }): boolean {
  return waiting?.step !== "host_push_confirm" && waiting?.recommended_view === "diff";
}
