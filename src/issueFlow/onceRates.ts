/**
 * 一次率二轴聚合(2026-09-17 拍板,口径唯一权威:CONTEXT「一次修复
 * 成功率」「一次定位成功率」词条)。纯分类:输入各会话的结构化判定
 * 事实,输出分母与两轴分子/比率及逐条明细;不读盘。两个判定口径
 * (countVerifyFailures 验证未通过、sentReviewBatches 检视批次)收在
 * 本模块导出——service.ts 的现算与 metricsSnapshot.ts 的快照投影
 * 调同一份,口径不分家;报告版本数由调用方读分析报告版本账
 * (ADR-0032 起只随修改型检视增长)。终态会话的判定事实也可以来自
 * 冻结快照(metrics.json,ADR-0042):本模块只做纯提取与验形(见
 * onceRateFactsFromSnapshot),盘上读写仍归调用方。
 */

import {
  VERIFY_FAIL_NOTE_PREFIX,
  type IssueConclusionKind,
  type IssueStatus,
} from "./state.ts";
import {
  ISSUE_METRICS_SCHEMA_VERSION,
  type IssueMetricsSnapshot,
} from "./metricsSnapshot.ts";

/** 单个会话的判定事实(结构化账,判什么列什么,不携带过程细节)。 */
export interface IssueOnceRateFacts {
  id: string;
  /** 单号:空=无单流程,不参与统计。 */
  ticket?: string;
  status: IssueStatus;
  /** 结论 kind:完成交付=delivered(修复完成归档;合入与否不进结论,
   * ADR-0037)。 */
  conclusion_kind?: IssueConclusionKind;
  /** 环境验证卡答「验证发现问题」的次数。 */
  verify_fail_count: number;
  /** 分析报告版本数(初版=1;缺 0 按 ≤1 宽容,坏账不虚构失败)。 */
  report_version_count: number;
  /** 检视提交批次数(只记账,不参与两轴判定)。 */
  review_count: number;
}

// ---- 判定口径(现算与快照投影共用这一份,口径不分家) ----

/** 验证未通过次数:按转移账的平台文案计(#328)。生产记账是
 *  「第 N 轮:用户环境验证发现问题:…」(回退统一加轮次前缀),开头
 *  匹配永远对不上;包含匹配同时覆盖历史裸前缀旧账。 */
export function countVerifyFailures(
  transitions: ReadonlyArray<{ note: string }>,
): number {
  return transitions.filter(
    (transition) => transition.note.includes(VERIFY_FAIL_NOTE_PREFIX),
  ).length;
}

/** 检视批次:一次提交动作=一批,只认经检视通道(issue_review)送出的
 *  sent 操作。返回每批的意见号清单(意见条数=各批长度合计),批次数=
 *  数组长度。 */
export function sentReviewBatches(
  history: ReadonlyArray<{ op?: string; via?: string; ids?: string[] }>,
): string[][] {
  return history.flatMap((operation) =>
    operation.op === "sent" && operation.via === "issue_review"
      ? [operation.ids ?? []]
      : [],
  );
}

/** 从终态冻结快照(metrics.json,ADR-0042)提取一次率判定事实。
 *  快照的判定字段与现算同源(写盘时都从同一批账投影),读侧只认
 *  当前版本戳、且判定字段齐整:版本不认识、字段缺失、被手改或标了
 *  「不可得」的快照一律返回 null,由调用方回退现算——坏账不当事实,
 *  也不报错。 */
export function onceRateFactsFromSnapshot(
  snapshot: IssueMetricsSnapshot,
): IssueOnceRateFacts | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  if (snapshot.schema_version !== ISSUE_METRICS_SCHEMA_VERSION) return null;
  if (typeof snapshot.session_id !== "string" || !snapshot.session_id) {
    return null;
  }
  const status = snapshot.terminal_status;
  if (status !== "archived" && status !== "canceled" && status !== "failed") {
    return null;
  }
  // 判定字段逐个验形:metrics.json 是盘上文件,可能缺字段、半写或
  // 被标了「不可得」(unavailable 对象不是 number,过不了验形)。
  const verifyFail = snapshot.verify_fail_count;
  const reportVersions = snapshot.report_version_count;
  const reviewBatches = snapshot.reviews?.review_batches;
  if (typeof verifyFail !== "number" || !Number.isFinite(verifyFail)
    || typeof reportVersions !== "number"
    || !Number.isFinite(reportVersions)
    || typeof reviewBatches !== "number" || !Number.isFinite(reviewBatches)) {
    return null;
  }
  if (snapshot.ticket !== undefined && typeof snapshot.ticket !== "string") {
    return null;
  }
  const conclusionKind = snapshot.conclusion_kind;
  if (conclusionKind !== undefined && typeof conclusionKind !== "string") {
    return null;
  }
  return {
    id: snapshot.session_id,
    ticket: snapshot.ticket,
    status,
    conclusion_kind: conclusionKind as IssueOnceRateFacts["conclusion_kind"],
    verify_fail_count: verifyFail,
    report_version_count: reportVersions,
    review_count: reviewBatches,
  };
}

export interface IssueOnceRateRow {
  id: string;
  reviews: number;
  localization_pass: boolean;
  repair_pass: boolean;
}

export interface IssueOnceRateAxis {
  passed: number;
  /** 占分母的百分数一位小数;分母 0 = null,前端显示 —。 */
  rate: number | null;
}

export interface IssueOnceRateSummary {
  /** 分母:完成交付的会话数。 */
  total: number;
  /** 一次定位成功率:分析报告版本数 ≤1。 */
  localization: IssueOnceRateAxis;
  /** 一次修复成功率:从未验证未通过。 */
  repair: IssueOnceRateAxis;
  /** 分母会话逐条(检视次数是先行能力,呈现后议)。 */
  per_session: IssueOnceRateRow[];
}

const percent = (passed: number, total: number): number | null =>
  total ? Math.round((passed / total) * 1000) / 10 : null;

export function issueOnceRates(
  rows: ReadonlyArray<IssueOnceRateFacts>,
): IssueOnceRateSummary {
  const per_session: IssueOnceRateRow[] = [];
  let localizationPassed = 0;
  let repairPassed = 0;
  for (const row of rows) {
    if (!row.ticket?.trim()) continue;
    if (row.status !== "archived") continue;
    if (row.conclusion_kind !== "delivered") continue;
    // 两轴各测一个裁决点:定位=报告一版过(版本账);修复=环境验证
    // 一次过(验证卡零 fail;自动归档未答卡=验证通过,不进失败计数)。
    const localization_pass = row.report_version_count <= 1;
    const repair_pass = row.verify_fail_count === 0;
    if (localization_pass) localizationPassed += 1;
    if (repair_pass) repairPassed += 1;
    per_session.push({
      id: row.id, reviews: row.review_count,
      localization_pass, repair_pass,
    });
  }
  const total = per_session.length;
  return {
    total,
    localization: { passed: localizationPassed, rate: percent(localizationPassed, total) },
    repair: { passed: repairPassed, rate: percent(repairPassed, total) },
    per_session,
  };
}
