/**
 * 一次率二轴聚合(2026-09-17 拍板,口径唯一权威:CONTEXT「一次修复
 * 成功率」「一次定位成功率」词条)。纯分类:输入各会话的结构化判定
 * 事实,输出分母与两轴分子/比率及逐条明细;不读盘不解析自由文本——
 * 验证失败由调用方按转移账平台文案前缀计(state.ts 的
 * VERIFY_FAIL_NOTE_PREFIX),报告版本数由调用方读分析报告版本账
 * (ADR-0032 起只随修改型检视增长),检视批次由调用方按 reviews 账本
 * 的 sent/issue_review 操作计。
 */

import type { IssueConclusionKind, IssueStatus } from "./state.ts";

/** 单个会话的判定事实(结构化账,判什么列什么,不携带过程细节)。 */
export interface IssueOnceRateFacts {
  id: string;
  /** 单号:空=无单流程,不参与统计。 */
  ticket?: string;
  status: IssueStatus;
  /** 结论 kind:完成交付=delivered(全部 MR 合入的归档,ADR-0034)。 */
  conclusion_kind?: IssueConclusionKind;
  /** 环境验证卡答「验证发现问题」的次数。 */
  verify_fail_count: number;
  /** 分析报告版本数(初版=1;缺 0 按 ≤1 宽容,坏账不虚构失败)。 */
  report_version_count: number;
  /** 检视提交批次数(只记账,不参与两轴判定)。 */
  review_count: number;
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
