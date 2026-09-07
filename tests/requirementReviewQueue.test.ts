import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnnotationStore, TASK_REQUIREMENT_ARTIFACT } from "../src/annotations.ts";
import { submitRequirementReview } from "../src/requirementReviewQueue.ts";

test("后台接收第一批立即返回；失败后回报原因并恢复全部待处理意见", async () => {
  const store = new AnnotationStore(join(mkdtempSync(join(tmpdir(), "mfc-rq-accept-")), "annotations.jsonl"));
  const add = (note: string) => store.add({ author: "guest", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "原文", note, kind: "doc" });
  const a = add("第一批"), b = add("第二批");
  const task = { summary: { status: "waiting_for_human",
    waiting: { step: "cloud_requirement_analysis_confirm" } } };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let observed!: (error: unknown) => void;
  const failed = new Promise<unknown>((resolve) => { observed = resolve; });
  let calls = 0;
  const run = async () => { calls++; await held; throw new Error("模型网关超时"); };
  try {
    await submitRequirementReview(task, store, [a], run, observed, "owner");
    assert.equal(store.list()[0].sent_via, "requirement_review");
    assert.equal(store.list()[0].sent_by, "owner", "责任人代转应保留实际提交者");
    assert.equal(store.list()[0].author, "guest");
    await submitRequirementReview(task, store, [b], run, observed);
    assert.equal(store.list()[1].sent_via, "requirement_queue");
    assert.equal(calls, 1);
    release();
    assert.match(String(await failed), /模型网关超时/);
    assert.deepEqual(store.list().map((item) => item.status), ["draft", "draft"]);
    assert.ok(store.list().every((item) => !item.returned), "系统失败不能增加作者退回次数");
    assert.ok(store.history().filter((item) => item.op === "delivery_reset").length === 2);
    assert.ok(!store.history().some((item) => item.op === "reopen"));
    await submitRequirementReview(task, store, store.drafts(), async (batch) => {
      store.markSent(batch.map((item) => item.id), "interrupt");
    });
    assert.ok(store.list().every((item) => item.sent_via === "interrupt"));
  } finally { release(); }
});

test("修订失败释放队列，未处理的意见保留为可重提草稿，不会并发写文档", async () => {
  const store = new AnnotationStore(join(mkdtempSync(join(tmpdir(), "mfc-rq-")), "annotations.jsonl"));
  const add = (note: string) => store.add({ author: "owner",
    artifact: TASK_REQUIREMENT_ARTIFACT, file: "需求原文", line: 1,
    anchor: "原文", note, kind: "doc" });
  const a = add("第一批"), b = add("第二批");
  const task = { summary: { status: "waiting_for_human",
    waiting: { step: "cloud_requirement_analysis_confirm" } } };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const run = async () => { calls++; await held; throw new Error("本轮模型失败"); };
  const first = submitRequirementReview(task, store, [a], run);
  const failed = assert.rejects(first, /本轮模型失败/);
  await submitRequirementReview(task, store, [b], run);
  assert.equal(calls, 1);
  assert.equal(new AnnotationStore(store.path).list()[1].sent_via, "requirement_queue",
    "入队事实应已落盘，不能只存在内存里");
  release();
  await failed;
  assert.deepEqual(store.list().map((item) => item.status), ["draft", "draft"]);
  assert.equal(store.list()[1].note, "第二批");
  await submitRequirementReview(task, store, store.drafts(), async (batch) => {
    store.markSent(batch.map((item) => item.id), "interrupt");
  });
  assert.ok(store.list().every((item) => item.sent_via === "interrupt"), "失败后锁已释放，可重提");
});

test("排队后撤回的意见不会被下一轮自动执行", async () => {
  const store = new AnnotationStore(join(mkdtempSync(join(tmpdir(), "mfc-rq-drop-")), "annotations.jsonl"));
  const add = (note: string) => store.add({ author: "owner",
    artifact: TASK_REQUIREMENT_ARTIFACT, file: "需求原文", line: 1,
    anchor: "原文", note, kind: "doc" });
  const a = add("第一批"), b = add("第二批");
  const task = { summary: { status: "waiting_for_human",
    waiting: { step: "cloud_requirement_analysis_confirm" } } };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const batches: string[][] = [];
  const run = async (batch: typeof a[]) => {
    batches.push(batch.map((item) => item.id));
    await held;
    store.markSent(batch.map((item) => item.id), "interrupt");
  };
  const first = submitRequirementReview(task, store, [a], run);
  await submitRequirementReview(task, store, [b], run);
  store.drop(b.id, "owner");
  release();
  await first;
  assert.deepEqual(batches, [[a.id]]);
  assert.equal(store.list()[1].status, "dropped");
});
