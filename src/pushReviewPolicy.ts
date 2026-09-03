/**
 * push 前最终检视的纯领域规则。
 *
 * 它不认识 TaskService、Git 或页面，只判断一张授权收据是否精确覆盖
 * 此刻准备推送的 HEAD 与文件集合。第一次 push、流水线修复后的第二次
 * push、检视返工后的第三次 push 都用同一把尺：HEAD 变了就重新检视；
 * 完全相同的 HEAD 重试则幂等复用，不重复打扰人。
 */

import { createHash } from "node:crypto";

export interface PushReviewSnapshot {
  head: string;
  paths: string[];
}

export interface PushReviewReceipt {
  status: "requested" | "confirmed";
  head: string;
  paths: string[];
}

function sameOrderedValues(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/** 调用方先按自己的安全规则归一化路径；这里刻意只做精确对拍。 */
export function pushReviewReceiptCovers(
  receipt: PushReviewReceipt | undefined,
  snapshot: PushReviewSnapshot,
): boolean {
  return receipt?.status === "confirmed"
    && receipt.head === snapshot.head
    && sameOrderedValues(receipt.paths, snapshot.paths);
}

/** 卡身份绑定最终 HEAD。cycleToken 只用来区分同一 HEAD 上明确打回后
 * 的下一轮复检，避免 HumanGate 复活上一张已经 resolved 的卡。 */
export function pushReviewCallId(
  snapshot: PushReviewSnapshot,
  cycleToken?: string,
): string {
  const digest = createHash("sha256")
    .update(snapshot.head)
    .update("\0")
    .update(snapshot.paths.join("\0"))
    .update(cycleToken ? `\0cycle:${cycleToken}` : "")
    .digest("hex");
  return `push-confirm-${digest.slice(0, 12)}`;
}
