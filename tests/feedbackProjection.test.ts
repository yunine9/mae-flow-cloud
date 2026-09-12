import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FeedbackStore, type FeedbackRecord, type FeedbackStatus } from "../src/feedbackStore.ts";
import { projectKernelFeedback } from "../src/feedbackProjection.ts";
import { feedbackCategory, feedbackEnded, feedbackStatusLabel, feedbackSummary } from "../web/src/feedbackPresentation.ts";

const old = "a".repeat(40), fresh = "b".repeat(40);
function record(id: string, source: FeedbackRecord["source"] = "pipeline", sha = old): FeedbackRecord {
  return { id, source, source_id: `${sha}:COMPILE`, source_revision: 0, observed_sha: sha,
    batch_id: "batch", status: "repairing", summary: `${id}: 原始失败`, verification: "pipeline",
    updated_at: "2026-09-12T00:00:00Z" };
}
function state(status: string, items: FeedbackRecord[]) {
  return { delivery_loop: { published: { sha: fresh }, batches: [
    { batch_id: "batch", base_sha: old, status, items, opened_at: "2026-09-12T00:00:00Z" },
  ], deferred_feedback: {} as Record<string, { reason: string }> } };
}

for (const status of ["superseded", "superseded_by_merge"]) {
  test(`${status} 更新陈旧索引、重建丢失索引，重复同步不追加，原始失败不变`, t => {
    const dir = mkdtempSync(join(tmpdir(), "feedback-projection-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const store = new FeedbackStore(join(dir, "index.jsonl"));
    const row = record("old-ci");
    const kernel = state(status, [row]);
    const original = structuredClone(kernel);
    store.upsert([row]);
    projectKernelFeedback(kernel, store, store.list());
    const result = store.list()[0];
    assert.equal(result.status, status);
    assert.equal(result.summary, row.summary);
    assert.equal(result.verification, row.verification);
    assert.match(result.resolution!, /不代表验证通过/);
    assert.equal(feedbackEnded(result), true);
    assert.equal(feedbackCategory(result), "closed");
    assert.doesNotMatch(feedbackSummary([result]), /进行中|处理中|待闭环|全部已闭环/);
    const log = readFileSync(store.path, "utf8");
    projectKernelFeedback(kernel, store, store.list());
    assert.equal(readFileSync(store.path, "utf8"), log);
    rmSync(store.path);
    projectKernelFeedback(kernel, store, []);
    assert.equal(store.list()[0].status, status);
    assert.equal(store.list()[0].resolution, result.resolution);
    assert.deepEqual(kernel, original, "Cloud 投影不能改写内核事实或伪造回执");
  });
}

test("混合批次逐条投影：旧 CI 归档，人工、同 SHA、未知 SHA 和 Build-Fix 保持原状态", t => {
  const dir = mkdtempSync(join(tmpdir(), "feedback-mixed-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FeedbackStore(join(dir, "index.jsonl"));
  const rows = [record("old"), record("current", "pipeline", fresh), record("unknown", "pipeline", "unknown"),
    record("human", "workspace"), record("build", "build_fix"), record("mr", "mr_discussion"), record("push", "push_confirmation")];
  const kernel = state("repairing", rows);
  projectKernelFeedback(kernel, store, []);
  assert.deepEqual(rows.map(row => store.list().find(r => r.id === row.id)!.status), ["superseded", ...Array(6).fill("repairing")]);
  assert.equal(feedbackSummary(store.list()), "6 条待闭环");
  kernel.delivery_loop.batches[0].status = "superseded_by_merge";
  projectKernelFeedback(kernel, store, store.list());
  assert.deepEqual(rows.map(row => store.list().find(r => r.id === row.id)!.status), ["superseded_by_merge", "superseded_by_merge", "superseded_by_merge",
    "repairing", "superseded_by_merge", "repairing", "repairing"], "合入不替人工意见验收");
});

test("明确暂缓与真正 PASS 分开显示，历史归档不把已闭环记录复活", t => {
  const dir = mkdtempSync(join(tmpdir(), "feedback-deferred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FeedbackStore(join(dir, "index.jsonl"));
  const rows = [record("deferred"), { ...record("closed"), status: "closed" as const, resolution: "真实核验通过" }, record("new", "pipeline", fresh)];
  const kernel = state("repairing", rows);
  kernel.delivery_loop.deferred_feedback.deferred = { reason: "责任人暂缓这条" };
  store.upsert(rows);
  projectKernelFeedback(kernel, store, store.list());
  assert.deepEqual(rows.map(row => store.list().find(r => r.id === row.id)!.status), ["deferred", "closed", "repairing"]);
  assert.equal(feedbackSummary(store.list()), "1 条待闭环，1 条已暂缓");
  kernel.delivery_loop.batches[0].status = "closed";
  projectKernelFeedback(kernel, store, store.list());
  assert.deepEqual(rows.map(row => store.list().find(r => r.id === row.id)!.status), ["deferred", "closed", "closed"]);
  assert.equal(store.list().find(r => r.id === "closed")!.resolution, "真实核验通过");
  assert.match(store.list().find(r => r.id === "new")!.resolution!, /权威核验已通过/);
});

test("反馈面板与会话流的每种状态都有中文标签，结束和暂缓不称为处理中", () => {
  const statuses: FeedbackStatus[] = ["open", "repairing", "addressed", "awaiting_verification", "closed", "needs_human", "deferred", "superseded", "superseded_by_merge"];
  for (const status of statuses) assert.ok(feedbackStatusLabel({ source: "pipeline", status }));
  assert.equal(feedbackStatusLabel({ source: "pipeline", status: "superseded" }), "已被新版本替代");
  assert.equal(feedbackStatusLabel({ source: "build_fix", status: "superseded_by_merge" }), "随合入结束");
  assert.equal(feedbackStatusLabel({ source: "mr_discussion", status: "awaiting_verification" }), "已回复，等检视人确认");
  assert.equal(feedbackSummary([{ status: "deferred" }]), "1 条已暂缓");
});
