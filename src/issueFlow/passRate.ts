/**
 * 一次通过率聚合(2026-09-16 拍板,口径唯一权威:CONTEXT「一次通过率」
 * 词条)。纯分类:输入各会话的结构化判定事实,输出分子/分母/比率与
 * 逐条明细;不读盘不解析自由文本——验证事实由调用方按转移账平台文案
 * 前缀计得(state.ts 的 VERIFY_FAIL_NOTE_PREFIX),检视批次由调用方按
 * reviews 账本的 sent/issue_review 操作计得。
 */

import type { IssueStatus } from "./state.ts";

/** 单个会话的判定事实(结构化账,判什么列什么,不携带过程细节)。 */
export interface IssuePassRateFacts {
  id: string;
  /** 单号:空=无单流程,不参与统计。 */
  ticket?: string;
  status: IssueStatus;
  /** 环境验证卡答「验证发现问题」的次数。 */
  verify_fail_count: number;
  /** 检视提交批次数(只记账,不参与一次判定:检视考的是分析报告)。 */
  review_count: number;
}

export interface IssuePassRateRow {
  id: string;
  reviews: number;
  first_pass: boolean;
}

export interface IssuePassRateSummary {
  /** 一次通过会话数(分子)。 */
  passed: number;
  /** 有单终态会话数(分母)。 */
  total: number;
  /** 一次通过率(百分数一位小数);分母 0 = null,前端显示 —。 */
  rate: number | null;
  /** 分母会话逐条(检视次数是先行能力,呈现后议)。 */
  per_session: IssuePassRateRow[];
}

const TERMINAL_STATUSES: ReadonlySet<IssueStatus> = new Set([
  "archived", "canceled", "failed",
]);

export function issuePassRate(
  rows: ReadonlyArray<IssuePassRateFacts>,
): IssuePassRateSummary {
  const per_session: IssuePassRateRow[] = [];
  let passed = 0;
  for (const row of rows) {
    if (!row.ticket?.trim()) continue;
    if (!TERMINAL_STATUSES.has(row.status)) continue;
    // 一次通过 = 归档且验证卡从未答过 fail。未答卡就归档的会话在此
    // 与"答过 pass 再归档"同形,刻意:归档即用户认可收口。取消/失败
    // 一律非一次——没解决就是没解决,答过 pass 但没走到归档收口同理。
    const first_pass = row.status === "archived"
      && row.verify_fail_count === 0;
    if (first_pass) passed += 1;
    per_session.push({
      id: row.id, reviews: row.review_count, first_pass,
    });
  }
  const total = per_session.length;
  return {
    passed,
    total,
    rate: total ? Math.round((passed / total) * 1000) / 10 : null,
    per_session,
  };
}
