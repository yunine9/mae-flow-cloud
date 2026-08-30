/**
 * 外部交付动作的 append-only outbox。
 *
 * Agent 产出的回复先入账，代码 push 成功后才允许投递。进程可以死在
 * 任意一条回复前后：已成功的不会从本地账上消失，失败的保持 pending，
 * 重启继续。外部端同时收到稳定 idempotency_key，用来封住“远端成功、
 * 本地来不及记成功”这个最后的重复窗口。
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export interface ReviewReplyPayload {
  discussion_id: string;
  body: string;
  repo: string;
  mr?: string | number;
  resolve: boolean;
  expected_sha?: string;
}

export interface DeliveryOutboxItem {
  id: string;
  kind: "review_reply";
  payload: ReviewReplyPayload;
  state: "pending" | "delivered";
  attempts: number;
  created_at: string;
  delivered_at?: string;
  last_error?: string;
}

type Operation =
  | { op: "enqueue"; item: DeliveryOutboxItem }
  | { op: "attempt"; id: string; at: string }
  | { op: "failed"; id: string; at: string; error: string }
  | { op: "delivered"; id: string; at: string };

export interface ParsedReviewReplies {
  replies: Array<{ id: string; body: string }>;
  missing_ids: string[];
}

/** 模型常把正文写在 [id] 同一行，解析器同时接受单独行与同行正文。
 * knownIds 存在时只认本批讨论，避免正文里的普通 [foo] 被误切。 */
export function parseReviewReplies(
  text: string,
  knownIds?: Iterable<string>,
): ParsedReviewReplies {
  const known = knownIds ? new Set(knownIds) : undefined;
  const replies: Array<{ id: string; body: string }> = [];
  let current: { id: string; body: string[] } | undefined;
  for (const line of String(text ?? "").split("\n")) {
    const head = line.trim().match(/^\[([^\]\s]+)\]\s*(.*)$/);
    if (head && (!known || known.has(head[1]))) {
      if (current) {
        replies.push({ id: current.id, body: current.body.join("\n").trim() });
      }
      current = { id: head[1], body: head[2] ? [head[2]] : [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) {
    replies.push({ id: current.id, body: current.body.join("\n").trim() });
  }
  const byId = new Map<string, string>();
  for (const reply of replies) {
    if (reply.body) byId.set(reply.id, reply.body);
  }
  const normalized = [...byId].map(([id, body]) => ({ id, body }));
  return {
    replies: normalized,
    missing_ids: known
      ? [...known].filter((id) => !byId.has(id)) : [],
  };
}

function replyId(payload: ReviewReplyPayload): string {
  const digest = createHash("sha256").update(JSON.stringify({
    discussion_id: payload.discussion_id,
    body: payload.body,
    repo: payload.repo,
    mr: payload.mr,
    resolve: payload.resolve,
    expected_sha: payload.expected_sha,
  })).digest("hex");
  return `review-reply-${digest.slice(0, 24)}`;
}

export class DeliveryOutbox {
  constructor(readonly path: string) {}

  list(): DeliveryOutboxItem[] {
    if (!existsSync(this.path)) return [];
    let text = "";
    try { text = readFileSync(this.path, "utf-8"); } catch { return []; }
    const items = new Map<string, DeliveryOutboxItem>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let operation: Operation;
      try { operation = JSON.parse(line) as Operation; } catch { continue; }
      if (operation.op === "enqueue") {
        if (operation.item?.id && !items.has(operation.item.id)) {
          items.set(operation.item.id, structuredClone(operation.item));
        }
        continue;
      }
      const item = items.get(operation.id);
      if (!item) continue;
      if (operation.op === "attempt") {
        item.attempts += 1;
        item.last_error = undefined;
      } else if (operation.op === "failed") {
        item.last_error = operation.error;
      } else if (operation.op === "delivered") {
        item.state = "delivered";
        item.delivered_at = operation.at;
        item.last_error = undefined;
      }
    }
    return [...items.values()];
  }

  enqueueReviewReply(
    payload: ReviewReplyPayload,
    at = new Date().toISOString(),
  ): DeliveryOutboxItem {
    const normalized: ReviewReplyPayload = {
      ...payload,
      discussion_id: String(payload.discussion_id).trim(),
      body: String(payload.body).trim(),
      repo: String(payload.repo),
    };
    if (!normalized.discussion_id || !normalized.body) {
      throw new Error("检视回复缺少 discussion_id 或正文");
    }
    const id = replyId(normalized);
    const existing = this.list().find((item) => item.id === id);
    if (existing) return existing;
    const item: DeliveryOutboxItem = {
      id,
      kind: "review_reply",
      payload: normalized,
      state: "pending",
      attempts: 0,
      created_at: at,
    };
    this.append({ op: "enqueue", item });
    return item;
  }

  pendingReviewReplies(): DeliveryOutboxItem[] {
    return this.list().filter((item) =>
      item.kind === "review_reply" && item.state === "pending");
  }

  markAttempt(id: string, at = new Date().toISOString()): void {
    this.requirePending(id);
    this.append({ op: "attempt", id, at });
  }

  markFailed(id: string, error: string, at = new Date().toISOString()): void {
    this.requirePending(id);
    this.append({ op: "failed", id, at, error: String(error).slice(0, 1000) });
  }

  markDelivered(id: string, at = new Date().toISOString()): void {
    this.requirePending(id);
    this.append({ op: "delivered", id, at });
  }

  private requirePending(id: string): void {
    const item = this.list().find((one) => one.id === id);
    if (!item) throw new Error(`outbox 项不存在: ${id}`);
    if (item.state === "delivered") throw new Error(`outbox 项已投递: ${id}`);
  }

  private append(operation: Operation): void {
    // 写侧 fail-closed：调用方只有成功返回后才能删除 Agent 草稿。
    appendFileSync(this.path, JSON.stringify(operation) + "\n", "utf-8");
  }
}
