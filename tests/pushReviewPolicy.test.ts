import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pushReviewCallId,
  pushReviewReceiptCovers,
} from "../src/pushReviewPolicy.ts";

test("push 检视收据同时绑定 HEAD 与文件集合", () => {
  const receipt = {
    status: "confirmed" as const,
    head: "head-a",
    paths: ["src/a.ts"],
  };
  assert.equal(pushReviewReceiptCovers(receipt, {
    head: "head-a", paths: ["src/a.ts"],
  }), true);
  assert.equal(pushReviewReceiptCovers(receipt, {
    head: "head-b", paths: ["src/a.ts"],
  }), false, "同一批文件的新提交也必须重新检视");
  assert.equal(pushReviewReceiptCovers(receipt, {
    head: "head-a", paths: ["src/a.ts", "src/b.ts"],
  }), false);
  assert.equal(pushReviewReceiptCovers({ ...receipt, status: "requested" }, {
    head: "head-a", paths: ["src/a.ts"],
  }), false);
});

test("同一 HEAD 的卡键幂等，HEAD 或明确返工轮次变化就换卡", () => {
  const snapshot = { head: "head-a", paths: ["src/a.ts"] };
  assert.equal(pushReviewCallId(snapshot), pushReviewCallId(snapshot));
  assert.notEqual(pushReviewCallId(snapshot), pushReviewCallId({
    ...snapshot, head: "head-b",
  }));
  assert.notEqual(pushReviewCallId(snapshot, "round-1"),
    pushReviewCallId(snapshot, "round-2"));
});
