/**
 * 反馈闭环的纯领域规则。
 *
 * 这里不认识 TaskService、HTTP、MR 或页面。调用方只给“意见事实”，它
 * 回答哪些意见会阻塞、Agent 的逐条回执是否完整。把这把尺从 1.3 万行
 * 编排器里抽出来，服务端、恢复与测试才能永远使用同一口径。
 */

import type { Annotation, AnnotationResponse } from "./annotations.ts";

/** 草稿不是团队事实。例外仅是任务责任人自己的草稿：他在最终确认时
 * 很可能只是忘了点“提交”，此时明确提醒比静默丢意见更安全。其他人的
 * 草稿既不能指挥 Agent，也不能成为锁死别人任务的暗门。 */
export function blockingAnnotations(
  items: Annotation[],
  taskOwner: string | undefined,
): Annotation[] {
  return items.filter((item) => item.status === "sent"
    // 无认证/旧任务没有 owner 时维持单用户语义：它的草稿就是当前
    // 操作者自己的草稿。只有明确知道“这是别人的任务”时才排除路人草稿。
    || (item.status === "draft" && (!taskOwner || item.author === taskOwner)));
}

export function submittedAnnotations(items: Annotation[]): Annotation[] {
  return items.filter((item) => item.status === "sent");
}

export interface WorkspaceReviewReceipt {
  annotation_id: string;
  revision: number;
  outcome: AnnotationResponse["outcome"];
  summary: string;
  evidence?: string[];
}

export interface ParsedWorkspaceReceipts {
  receipts: WorkspaceReviewReceipt[];
  missing_ids: string[];
  unexpected_ids: string[];
  errors: string[];
}

/** Agent 写出的文件是不可信输入：逐项校验、按当前 revision 对拍，绝不
 * 用数组顺序猜对应关系。重复 id 也是错误，否则后写者会静默覆盖前者。 */
export function parseWorkspaceReviewReceipts(
  value: unknown,
  expected: Annotation[],
): ParsedWorkspaceReceipts {
  const expectedById = new Map(expected.map((item) => [item.id, item]));
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      && Array.isArray((value as { receipts?: unknown }).receipts)
      ? (value as { receipts: unknown[] }).receipts : [];
  const receipts: WorkspaceReviewReceipt[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const unexpected = new Set<string>();
  for (const [at, raw] of rows.entries()) {
    if (!raw || typeof raw !== "object") {
      errors.push(`第 ${at + 1} 条回执不是对象`);
      continue;
    }
    const item = raw as Record<string, unknown>;
    const id = String(item.annotation_id ?? "").trim();
    if (!id) {
      errors.push(`第 ${at + 1} 条回执缺 annotation_id`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`批注 ${id} 出现重复回执`);
      continue;
    }
    seen.add(id);
    const target = expectedById.get(id);
    if (!target) {
      unexpected.add(id);
      continue;
    }
    const revision = Number(item.revision ?? 0);
    if (!Number.isInteger(revision) || revision !== (target.rework ?? 0)) {
      errors.push(`批注 ${id} 回执 revision=${String(item.revision ?? 0)}`
        + `，当前应为 ${target.rework ?? 0}`);
      continue;
    }
    const outcome = String(item.outcome ?? "");
    if (!["fixed", "not_fixed", "needs_clarification"].includes(outcome)) {
      errors.push(`批注 ${id} 的 outcome 不合法`);
      continue;
    }
    const summary = String(item.summary ?? "").trim();
    if (!summary) {
      errors.push(`批注 ${id} 缺少逐条说明`);
      continue;
    }
    receipts.push({
      annotation_id: id,
      revision,
      outcome: outcome as WorkspaceReviewReceipt["outcome"],
      summary,
      evidence: Array.isArray(item.evidence)
        ? item.evidence.map(String).map((one) => one.trim()).filter(Boolean)
        : [],
    });
  }
  const accepted = new Set(receipts.map((item) => item.annotation_id));
  return {
    receipts,
    missing_ids: expected.filter((item) => !accepted.has(item.id))
      .map((item) => item.id),
    unexpected_ids: [...unexpected],
    errors,
  };
}

export function unansweredAnnotations(
  items: Annotation[],
  ids: Iterable<string>,
): Annotation[] {
  const wanted = new Set(ids);
  return items.filter((item) => wanted.has(item.id)
    && item.status === "sent"
    && item.response?.revision !== (item.rework ?? 0));
}

export function workspaceReviewReceiptInstructions(items: Annotation[]): string {
  if (!items.length) return "";
  const revisions = items.map((item) =>
    `- ${item.id}: revision ${item.rework ?? 0}`).join("\n");
  return [
    "逐条处理后必须把机器可核对的回执写到 ../reviews/local-receipts.json。",
    "文件格式必须是 JSON 对象，不要写 Markdown 围栏：",
    '{"receipts":[{"annotation_id":"an-...","revision":0,'
      + '"outcome":"fixed|not_fixed|needs_clarification",'
      + '"summary":"改了什么，或为什么不改","evidence":["path:line"]}]}',
    "每个 annotation_id 恰好一条；缺失、重复或旧 revision 都不会进入 push。",
    "本轮清单：",
    revisions,
  ].join("\n");
}
