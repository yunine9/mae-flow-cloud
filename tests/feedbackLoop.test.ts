import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import {
  createKernelHostProof,
  openKernelFeedback,
  recordKernelFeedbackResult,
} from "../src/kernelDelivery.ts";

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

test("反馈索引的合法 JSON 也必须通过语义校验，不能伪造来源或核销未知项", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-feedback-semantic-"));
  const path = join(dir, "feedback.jsonl");
  writeFileSync(path, JSON.stringify({
    op: "upsert",
    record: record({ source: "attacker" as any }),
  }) + "\n");
  assert.throws(() => new FeedbackStore(path).list(),
    FeedbackStoreCorruptionError);

  writeFileSync(path, JSON.stringify({
    op: "resolve", id: "missing", status: "closed",
    resolution: "冒充已闭环", at: "2026-09-01T00:00:00.000Z",
  }) + "\n");
  assert.throws(() => new FeedbackStore(path).list(),
    FeedbackStoreCorruptionError);
});

test("无末尾换行的完整 JSON 仍须读完并做语义校验", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-feedback-tail-"));
  const path = join(dir, "feedback.jsonl");
  writeFileSync(path, JSON.stringify({ op: "upsert", record: record() }));
  assert.equal(new FeedbackStore(path).list().length, 1,
    "完整合法的 EOF 行不能被当成 torn tail 丢掉");

  writeFileSync(path, JSON.stringify({
    op: "upsert",
    record: { id: "x" },
  }));
  assert.throws(() => new FeedbackStore(path).list(),
    FeedbackStoreCorruptionError,
    "完整但语义非法的 EOF 行必须 fail-closed");
});

test("一张任务的反馈坏账只隔离本任务，不拖垮整个任务列表", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-feedback-isolation-"));
  const dataDir = join(root, "tasks");
  const service = new TaskService({
    dataDir, provider: "unused", model: "unused", modelsJson: {},
    maxConcurrent: 0,
  });
  const makeTask = (id: string): any => {
    const workspace = join(dataDir, id);
    mkdirSync(join(workspace, "feedback"), { recursive: true });
    return {
      summary: {
        id, requirement: id, status: "running",
        created_at: "2026-09-01T00:00:00.000Z", workspace,
      },
      humanGate: {}, controlEpoch: 0,
    };
  };
  const good = makeTask("task-good");
  const bad = makeTask("task-bad");
  new FeedbackStore(join(good.summary.workspace, "feedback", "index.jsonl"))
    .upsert([record({ id: "good", batch_id: "fb-good" })]);
  writeFileSync(join(bad.summary.workspace, "feedback", "index.jsonl"),
    "{broken json\n");
  (service as any).tasks.set(good.summary.id, good);
  (service as any).tasks.set(bad.summary.id, bad);

  const projected = service.list();
  assert.equal(projected.length, 2);
  assert.equal(projected.find((item) => item.id === "task-good")?.feedback?.length, 1);
  assert.match(projected.find((item) => item.id === "task-bad")?.feedback_error ?? "",
    /索引损坏/);
});

test("Cloud 索引缺记录时以内核批次重建，不能永久漏掉反馈", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-feedback-rebuild-"));
  const workspace = join(root, "tasks", "task-1");
  const cwd = join(workspace, "repo");
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "bot@test"], { cwd });
  execFileSync("git", ["config", "user.name", "bot"], { cwd });
  writeFileSync(join(cwd, "a.txt"), "base\n");
  execFileSync("git", ["add", "a.txt"], { cwd });
  execFileSync("git", ["commit", "-qm", "base"], { cwd });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd, encoding: "utf-8",
  }).trim();
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    current: "external_verify",
    execution_contract: {
      schema: "mae-flow-execution/1", host: "cloud",
      compile: "pipeline", ut_write: "agent", ut_run: "pipeline",
      codecheck: "pipeline", git_push: "host", continuous_review: true,
    },
    quality: { external_verification: { verdict: "PASS", sha: head } },
    history: [], step_heads: { delivery_watch: head },
  }));
  const kernelRoot = discoverKernelRoot(process.cwd());
  assert.ok(kernelRoot, "测试必须找到同步后的真实内核");
  const pipelineFacts = {
    sha: head, status: "success", source: "feedback-rebuild",
    git_push: { sha: head, ref: "refs/heads/test", remote: "origin" },
  };
  const pipelinePath = join(workspace, "pipeline-facts.json");
  writeFileSync(pipelinePath, JSON.stringify(pipelineFacts));
  const pipelineProof = createKernelHostProof({
    cwd, workspace, taskId: "task-1",
    action: "pipeline-record", payload: pipelineFacts,
  });
  try {
    execFileSync("python3", [
      join(kernelRoot, "scripts", "mae-flow.py"),
      "pipeline", "record", "--file", pipelinePath,
      "--host-proof", pipelineProof.path,
    ], { cwd, encoding: "utf-8" });
  } finally {
    pipelineProof.cleanup();
  }
  openKernelFeedback({
    host: { kernelRoot }, cwd, workspace,
    batch: {
      schema: "mae-flow-feedback-batch/1",
      batch_id: "fb-task-1-rebuild", task_id: "task-1", base_sha: head,
      opened_at: "2026-09-01T00:00:00.000Z",
      items: [{
        id: `pipeline:compile:r1@${head}`, source: "pipeline",
        source_id: "compile", source_revision: 1, kind: "quality_failure",
        summary: "编译失败", verification: "pipeline",
      }],
    },
  });
  const service = new TaskService({
    dataDir: join(root, "tasks"), provider: "unused", model: "unused",
    modelsJson: {}, maxConcurrent: 0,
    host: { kernelRoot, continuousReview: true },
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
  assert.equal(restored[0].id, `pipeline:compile:r1@${head}`);
  assert.equal(restored[0].status, "repairing");

  writeFileSync(join(cwd, "a.txt"), "base\nfixed\n");
  execFileSync("git", ["add", "a.txt"], { cwd });
  execFileSync("git", ["commit", "-qm", "fix compile"], { cwd });
  recordKernelFeedbackResult({
    host: { kernelRoot }, cwd, workspace, taskId: "task-1",
    batchId: "fb-task-1-rebuild", changed: true,
    results: [{
      id: `pipeline:compile:r1@${head}`, status: "fixed",
      summary: "编译问题已修复", evidence: "a.txt",
    }],
  });
  rmSync(join(workspace, "feedback", "index.jsonl"));
  assert.equal((service as any).recordActiveFeedbackResult(task), undefined,
    "内核 result 成功、Cloud 索引未落盘的重试必须补齐投影");
  const recovered = new FeedbackStore(
    join(workspace, "feedback", "index.jsonl")).list();
  assert.equal(recovered[0].status, "awaiting_verification");
  assert.equal(recovered[0].resolution, "编译问题已修复");

  const signedResultState = JSON.parse(readFileSync(
    join(cwd, ".mae-flow.json"), "utf-8"));
  const tampered = structuredClone(signedResultState);
  tampered.delivery_loop.active_batch_id = "attacker-batch";
  tampered.delivery_loop.batches[0].status = "closed";
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify(tampered));
  assert.equal((service as any).activeKernelFeedback(task), undefined,
    "手写 active_batch_id/status 不能派出 writer");
  (service as any).syncFeedbackStoreFromKernel(task);
  assert.match(task.summary.delivery.stalled ?? "", /缺少完整.*宿主权威收据/,
    "手写批次生命周期不能关闭或推进反馈索引");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify(signedResultState));
  (service as any).syncFeedbackStoreFromKernel(task);
  assert.equal(task.summary.delivery.stalled, undefined,
    "恢复签名现场后可继续，不形成永久停摆");
});

test("可写状态、总体回复和 HEAD 变化都不能冒充宿主批次或逐条回执", () => {
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
  assert.match(failure, /缺少 Cloud 宿主权威收据/);
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
