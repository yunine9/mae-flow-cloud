/**
 * 转移账与检视账的事实投影(ADR-0044,一次生成归属的共享地基):
 * 推送账逐笔、红灯三种处置结局、外部头观测、回退轮、验证失败、检视
 * 批次送出、反馈事件归并——判定键与解析集中在此单一来源,写账文案
 * 要改就连这里一起改(归档冻结快照 metricsSnapshot、一次率 onceRates
 * 与一次生成归属层都消费这一份,不许各写一份漂移)。纯投影:只读
 * 账面结构,不碰 Git、不落盘。
 */

import { VERIFY_FAIL_NOTE_PREFIX } from "./state.ts";

/** 推送账:push_branch 每笔一条「分支已推送 <仓> <分支> @ <提交号>」。 */
export const PUSH_NOTE = /^分支已推送 (\S+) (\S+) @ ([0-9a-f]{7,40})/;

// ---- 红灯处置结局(三分互斥,转移账文案计) ----

/** 红灯按失败处理(进入修复分诊/停机)。 */
const RED_FAILED_NOTE = "流水线失败(";
/** 红灯随合入取消(9a4d5f75 加的处置结局)。 */
const MERGE_CANCELED_NOTE = "MR 已合入,旧提交";
/** 红灯随头变丢弃(9a4d5f75 加的处置结局)。 */
const HEAD_DISCARDED_NOTE = "旧提交";

/** 外部头观测(c12c1cf0 加的检查目标跟随条目):文案是「分支头已被
 * 平台外提交 <短码> 取代,检查目标跟随切换(<仓>)」。 */
export const EXTERNAL_HEAD_COMMIT =
  /^分支头已被平台外提交 ([0-9a-f]{7,40}) 取代/;

/** 回退轮次(fixedRollback 的「第 N 轮:原因」)。 */
export const ROLLBACK_NOTE = /^第 \d+ 轮:(.*)$/s;

/** 转移账逐笔推送(仓、分支、提交号、时刻),账面顺序即推送顺序。 */
export interface LedgerPush {
  repo: string;
  branch: string;
  /** 提交号(账面记前 12 位,照录)。 */
  sha: string;
  at: string;
}

export function ledgerPushes(
  transitions: ReadonlyArray<{ note: string; at: string }>,
): LedgerPush[] {
  const pushes: LedgerPush[] = [];
  for (const transition of transitions) {
    const match = PUSH_NOTE.exec(transition.note);
    if (match) {
      pushes.push({
        repo: match[1]!, branch: match[2]!, sha: match[3]!, at: transition.at,
      });
    }
  }
  return pushes;
}

export function isRedLightRepaired(note: string): boolean {
  return note.startsWith(RED_FAILED_NOTE);
}

export function isRedLightCanceledByMerge(note: string): boolean {
  return note.startsWith(MERGE_CANCELED_NOTE) && note.includes("随合入取消");
}

export function isRedLightDiscardedOnHeadMove(note: string): boolean {
  return note.startsWith(HEAD_DISCARDED_NOTE)
    && note.includes("结果丢弃,不作失败处理");
}

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

/** 外部头观测明细(分支头被平台外推送取代的每一次发现:短码+时刻)。 */
export function externalHeadObservations(
  transitions: ReadonlyArray<{ note: string; at: string }>,
): Array<{ sha: string; at: string }> {
  const records: Array<{ sha: string; at: string }> = [];
  for (const transition of transitions) {
    const match = EXTERNAL_HEAD_COMMIT.exec(transition.note);
    if (match) records.push({ sha: match[1]!, at: transition.at });
  }
  return records;
}

// ---- 检视账与反馈事件(ADR-0044 口径) ----

/** 检视账里一次提交动作=一批:只认经检视通道(issue_review)送出的
 *  sent 操作,带时刻(反馈事件归并用)。 */
export function sentReviewOperations(
  history: ReadonlyArray<{
    op?: string; via?: string; ids?: string[]; at?: string;
  }>,
): Array<{ at: string; ids: string[] }> {
  return history.flatMap((operation) =>
    operation.op === "sent" && operation.via === "issue_review"
      ? [{ at: operation.at ?? "", ids: operation.ids ?? [] }]
      : [],
  );
}

/** 反馈事件三触发源(ADR-0044):检视批次送出、红灯仅「按失败处理」
 *  结局、环境验证发现问题。红灯随合入取消/随头变丢弃不算反馈(不是
 *  对当前代码的返工要求),人工回退轮不算(重做不是修反馈)——它们
 *  都不推进一次生成归属的返工边界。输出按时刻升序。 */
export type FeedbackEventKind =
  | "review_sent"
  | "pipeline_repaired"
  | "verify_fail";

export interface FeedbackEvent {
  kind: FeedbackEventKind;
  at: string;
}

export function feedbackEvents(input: {
  transitions: ReadonlyArray<{ note: string; at: string }>;
  reviewOperations: ReadonlyArray<{ at: string }>;
}): FeedbackEvent[] {
  const events: FeedbackEvent[] = [];
  for (const transition of input.transitions) {
    if (isRedLightRepaired(transition.note)) {
      events.push({ kind: "pipeline_repaired", at: transition.at });
    } else if (transition.note.includes(VERIFY_FAIL_NOTE_PREFIX)) {
      events.push({ kind: "verify_fail", at: transition.at });
    }
  }
  for (const operation of input.reviewOperations) {
    if (operation.at) events.push({ kind: "review_sent", at: operation.at });
  }
  return events.sort((a, b) => a.at.localeCompare(b.at));
}
