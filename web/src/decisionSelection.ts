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
