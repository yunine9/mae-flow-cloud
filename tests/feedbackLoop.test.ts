import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  feedbackBatchId,
  feedbackCounts,
  feedbackIdentity,
} from "../src/feedbackLoop.ts";
import { FeedbackStore, type FeedbackRecord } from "../src/feedbackStore.ts";

function record(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    id: "pipeline:compile:r0@abc",
    batch_id: "fb-task-1-a",
    source: "pipeline",
    source_id: "compile",
    source_revision: 0,
    observed_sha: "abc",
    summary: "编译失败",
    verification: "pipeline",
    status: "open",
    updated_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

test("反馈身份与批次只由来源版本、HEAD 和条目集合决定", () => {
  assert.equal(feedbackIdentity({
    source: "pipeline", source_id: "compile", observed_sha: "abc",
  }), "pipeline:compile:r0@abc");
  assert.equal(
    feedbackBatchId("task-1", "abc", [{ id: "b" }, { id: "a" }]),
    feedbackBatchId("task-1", "abc", [{ id: "a" }, { id: "b" }]),
  );
});

test("反馈索引幂等追加且坏行不隐藏其余明细", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-feedback-"));
  const path = join(dir, "feedback", "index.jsonl");
  const store = new FeedbackStore(path);
  store.upsert([record()]);
  store.upsert([record()]);
  assert.equal(readFileSync(path, "utf-8").trim().split("\n").length, 1);
  writeFileSync(path, "{bad json\n", { flag: "a" });
  store.resolve("pipeline:compile:r0@abc", "awaiting_verification", "已修复");
  assert.deepEqual(store.list().map((item) => ({
    id: item.id, status: item.status, resolution: item.resolution,
  })), [{
    id: "pipeline:compile:r0@abc",
    status: "awaiting_verification",
    resolution: "已修复",
  }]);
});

test("前端状态统计覆盖待处理、修复、核验、闭环与人工停点", () => {
  const records = [
    record({ id: "a", status: "open" }),
    record({ id: "b", status: "repairing" }),
    record({ id: "c", status: "awaiting_verification" }),
    record({ id: "d", status: "closed" }),
    record({ id: "e", status: "needs_human" }),
  ];
  assert.deepEqual(feedbackCounts(records), {
    open: 1,
    repairing: 1,
    addressed: 0,
    awaiting_verification: 1,
    closed: 1,
    needs_human: 1,
  });
});
