import assert from "node:assert/strict";
import test from "node:test";
import type { Annotation } from "../src/annotations.ts";
import {
  blockingAnnotations,
  parseWorkspaceReviewReceipts,
  unansweredAnnotations,
} from "../src/feedbackPolicy.ts";

function annotation(id: string, author: string, status: Annotation["status"],
  rework = 0): Annotation {
  return {
    id, author, status, rework, created_at: "2026-08-30T00:00:00.000Z",
    artifact: "diff", file: "a.ts", line: 1, anchor: "before",
    note: "改好", kind: "code",
  };
}

test("反馈闸门:路人草稿不锁任务，责任人草稿提醒，已提交意见必须闭环", () => {
  const ownerDraft = annotation("owner-draft", "alice", "draft");
  const visitorDraft = annotation("visitor-draft", "bob", "draft");
  const submitted = annotation("sent", "bob", "sent");
  assert.deepEqual(
    blockingAnnotations([ownerDraft, visitorDraft, submitted], "alice")
      .map((item) => item.id),
    ["owner-draft", "sent"],
  );
  assert.deepEqual(blockingAnnotations([visitorDraft], undefined)
    .map((item) => item.id), ["visitor-draft"], "无账号旧任务保持单用户语义");
});

test("逐条回执按 id+revision 对拍，缺失/重复/旧轮都明确点名", () => {
  const first = annotation("A", "alice", "sent");
  const second = annotation("B", "bob", "sent", 1);
  const result = parseWorkspaceReviewReceipts({ receipts: [
    { annotation_id: "A", revision: 0, outcome: "fixed",
      summary: "已补空值判断", evidence: ["src/a.ts:12"] },
    { annotation_id: "B", revision: 0, outcome: "fixed", summary: "旧回执" },
    { annotation_id: "A", revision: 0, outcome: "fixed", summary: "重复" },
    { annotation_id: "C", revision: 0, outcome: "fixed", summary: "越界" },
  ] }, [first, second]);
  assert.deepEqual(result.receipts.map((item) => item.annotation_id), ["A"]);
  assert.deepEqual(result.missing_ids, ["B"]);
  assert.deepEqual(result.unexpected_ids, ["C"]);
  assert.ok(result.errors.some((line) => line.includes("revision")));
  assert.ok(result.errors.some((line) => line.includes("重复")));
});

test("只有当前轮没有结构化回应的 sent 意见算未回应", () => {
  const answered = annotation("A", "alice", "sent");
  answered.response = {
    revision: 0, outcome: "fixed", summary: "完成", evidence: [],
    responded_at: "2026-08-30T00:01:00.000Z",
  };
  const old = annotation("B", "bob", "sent", 1);
  old.response = { ...answered.response, revision: 0 };
  assert.deepEqual(unansweredAnnotations([answered, old], ["A", "B"])
    .map((item) => item.id), ["B"]);
});
