/**
 * 终止原因前端词表唯一份(#540 复审):稳定英文值是协议(服务端
 * state.ts 的 IssueCancelReason 码表),界面渲染中文。终止确认框下拉
 * (CancelSessionDialog)与统计页终止徽标/详情(DeliveryAnalytics)
 * 原先各抄一份映射、负面判定前端复判——收口到本模块,将来新增原因
 * 只改这里,不会静默落成琥珀「其他」。
 */
import type { IssueCancelReason } from "../api";

/** 中文词表:resolved=问题已处理不会出现在统计页终止行(服务端不
 *  下发),入表只为下拉词表完整、键型对齐。 */
export const CANCEL_REASON_LABELS: Record<IssueCancelReason, string> = {
  resolved: "问题已处理", inaccurate: "分析不准确", slow: "速度太慢",
  disobedient: "指令不遵从", other: "其他原因",
};

/** 下拉选项:顺序即下拉顺序,与服务端 ISSUE_CANCEL_REASONS 同源同序。 */
export const CANCEL_REASON_OPTIONS: Array<{
  value: IssueCancelReason; label: string;
}> = (Object.keys(CANCEL_REASON_LABELS) as IssueCancelReason[])
  .map((value) => ({ value, label: CANCEL_REASON_LABELS[value] }));

/** 负面原因判定:镜像服务端 ISSUE_NEGATIVE_CANCEL_REASONS 的语义,
 *  只管呈现色系(已定类红色系、其余琥珀「其他」)——进不进统计的
 *  唯一口径在服务端,这里不复判。词表外未知值按「其他」待遇。 */
const NEGATIVE_CANCEL_REASONS: ReadonlySet<IssueCancelReason> = new Set([
  "inaccurate", "slow", "disobedient", "other",
]);

export function isNegativeCancelReason(
  reason: IssueCancelReason | undefined,
): boolean {
  return reason !== undefined && NEGATIVE_CANCEL_REASONS.has(reason);
}

/** 未知值安全的 label 回退:服务端先行发了本端不认识的新原因时,
 *  落「其他原因」而不是渲染 undefined。 */
export function cancelReasonLabel(
  reason: IssueCancelReason | undefined,
): string {
  return reason !== undefined && reason in CANCEL_REASON_LABELS
    ? CANCEL_REASON_LABELS[reason]
    : CANCEL_REASON_LABELS.other;
}
