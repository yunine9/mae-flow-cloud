import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  feedbackBatchId,
  feedbackCounts,
  feedbackIdentity,
} from "../src/feedbackLoop.ts";
import {
  FeedbackStore,
  FeedbackStoreCorruptionError,
  type FeedbackRecord,
} from "../src/feedbackStore.ts";
import { TaskService } from "../src/taskService.ts";

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

test("反馈索引幂等追加，崩溃留下的末行会在续写前修复", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-feedback-"));
  const path = join(dir, "feedback", "index.jsonl");
  const store = new FeedbackStore(path);
  store.upsert([record()]);
  store.upsert([record()]);
  assert.equal(readFileSync(path, "utf-8").trim().split("\n").length, 1);
  writeFileSync(path, "{\"op\":\"resolve\"", { flag: "a" });
  store.resolve("pipeline:compile:r0@abc", "awaiting_verification", "已修复");
  assert.deepEqual(store.list().map((item) => ({
    id: item.id, status: item.status, resolution: item.resolution,
  })), [{
    id: "pipeline:compile:r0@abc",
    status: "awaiting_verification",
    resolution: "已修复",
  }]);
});

test("反馈索引中间或完整坏账必须点名失败，不能静默隐藏后续反馈", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-feedback-corrupt-"));
  const path = join(dir, "feedback.jsonl");
  const store = new FeedbackStore(path);
  store.upsert([record()]);
  writeFileSync(path, "{bad json\n", { flag: "a" });
  writeFileSync(path, JSON.stringify({
    op: "upsert",
    record: record({ id: "pipeline:test:r0@abc", source_id: "test" }),
  }) + "\n", { flag: "a" });
  assert.throws(() => store.list(), FeedbackStoreCorruptionError);
  assert.throws(() => store.upsert([record({
    id: "pipeline:lint:r0@abc", source_id: "lint",
  })]), FeedbackStoreCorruptionError);
});

test("Cloud 索引缺记录时以内核批次重建，不能永久漏掉反馈", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-feedback-rebuild-"));
  const workspace = join(root, "tasks", "task-1");
  const cwd = join(workspace, "repo");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    current: "feedback_triage",
    delivery_loop: { batches: [{
      batch_id: "fb-task-1-rebuild", base_sha: "abc",
      opened_at: "2026-09-01T00:00:00.000Z", status: "repairing",
      items: [{
        id: "pipeline:compile:r1@abc", source: "pipeline",
        source_id: "compile", source_revision: 1,
        summary: "编译失败", verification: "pipeline",
      }],
    }] },
  }));
  const service = new TaskService({
    dataDir: join(root, "tasks"), provider: "unused", model: "unused",
    modelsJson: {}, maxConcurrent: 0,
  });
  const task = { summary: {
    id: "task-1", requirement: "恢复反馈索引", status: "verifying",
    created_at: "2026-09-01T00:00:00.000Z", workspace,
    delivery: { mr_state: "验证中" },
  }, cwd } as any;
  (service as any).syncFeedbackStoreFromKernel(task);
  const restored = new FeedbackStore(
    join(workspace, "feedback", "index.jsonl")).list();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, "pipeline:compile:r1@abc");
  assert.equal(restored[0].status, "repairing");
});

test("总体回复和 HEAD 变化不能冒充非工作台来源的逐条回执", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-feedback-receipt-"));
  const workspace = join(root, "tasks", "task-1");
  const cwd = join(workspace, "repo");
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "bot@test"], { cwd });
  execFileSync("git", ["config", "user.name", "bot"], { cwd });
  writeFileSync(join(cwd, "a.txt"), "fixed\n");
  execFileSync("git", ["add", "a.txt"], { cwd });
  execFileSync("git", ["commit", "-qm", "fix"], { cwd });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd, encoding: "utf-8",
  }).trim();
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    current: "feedback_triage",
    delivery_loop: {
      active_batch_id: "fb-task-1-pipeline",
      batches: [{
        batch_id: "fb-task-1-pipeline", base_sha: "0".repeat(40),
        status: "repairing", items: [{
          id: `pipeline:compile:r0@${head}`, source: "pipeline",
          source_id: "compile", source_revision: 0,
          summary: "编译失败", verification: "pipeline",
        }],
      }],
    },
  }));
  const service = new TaskService({
    dataDir: join(root, "tasks"), provider: "unused", model: "unused",
    modelsJson: {}, maxConcurrent: 0,
    host: { kernelRoot: join(root, "kernel"), continuousReview: true },
  });
  const task = {
    summary: {
      id: "task-1", requirement: "修流水线", status: "running",
      created_at: "2026-09-01T00:00:00.000Z", workspace,
    },
    cwd, lastReply: "所有问题都修好了", humanGate: {}, controlEpoch: 0,
  } as any;
  const failure = (service as any).recordActiveFeedbackResult(task);
  assert.match(failure, /没有留下本批逐条反馈回执/);
  const state = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf-8"));
  assert.equal(state.delivery_loop.batches[0].result_digest, undefined,
    "不能用总体收口发言或 HEAD 变化替 Agent 逐条代填");
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
