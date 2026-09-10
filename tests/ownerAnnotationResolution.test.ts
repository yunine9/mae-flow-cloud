import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnnotationStore, AnnotationPermissionError, TASK_REQUIREMENT_ARTIFACT } from "../src/annotations.ts";
import { annotationClosure, blockingAnnotations } from "../src/feedbackPolicy.ts";
import { buildConversation } from "../src/conversation.ts";
import { TaskService } from "../src/taskService.ts";

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), "mfc-owner-resolution-")), "annotations.jsonl");
  const store = new AnnotationStore(path);
  const item = store.add({ author: "reviewer", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "同步接口返回值", note: "外部接口超时后应如何处理", kind: "doc" });
  store.markSent([item.id], "interrupt", "reviewer");
  return { path, store, item };
}

test("责任人逐条处置保留原始回执与理由，重放和迟到回执不伪造修复", () => {
  for (const outcome of ["not_adopted", "deferred", "accepted_risk"] as const) {
    const { path, store, item } = fixture();
    store.respond(item.id, { outcome: "not_fixed", summary: "缺少环境，无法完成接口验证", evidence: [] });
    assert.throws(() => store.resolveAsOwner(item.id, "owner", { revision: 0, outcome, reason: " " }), /理由/);
    const decided = store.resolveAsOwner(item.id, "owner", { revision: 0, outcome, reason: "环境缺失已评估，跟踪后续补验" });
    assert.equal(decided.response?.outcome, "not_fixed");
    store.markSent([item.id], "review_repair");
    // 已在路上的模型回执仍可落账，但不得改变人工决定或它参考的回执。
    store.respond(item.id, { outcome: "fixed", summary: "迟到的处理结果", evidence: ["spec.md:1"] });
    const replayed = new AnnotationStore(path).list()[0];
    assert.equal(replayed.status, "verified");
    assert.equal(replayed.resolution?.outcome, outcome);
    assert.equal(replayed.response?.outcome, "not_fixed");
    assert.equal(blockingAnnotations([replayed], "owner").length, 0);
    const history = buildConversation({ events: [], waiting: [], feedback: [],
      annotations: store.list(), annotationHistory: store.history() });
    const closure = history.items.find((row) => row.kind === "verified");
    assert.equal(closure?.resolution?.outcome, outcome);
    assert.equal(closure?.by, "owner");
    const lastReceipt = history.items.filter((row) => row.kind === "receipts").at(-1);
    assert.equal(lastReceipt?.items[0].current, false, "迟到回执不能再次背书人工结论");
  }
});

test("已提交意见改字、申请撤回和退回仍待责任人闭环；旧版本处置被拒", () => {
  const { path, store, item } = fixture();
  store.requestWithdrawal(item.id, "reviewer");
  assert.equal(blockingAnnotations(store.list(), "owner").length, 1);
  assert.throws(() => store.requestWithdrawal(item.id, "owner"), AnnotationPermissionError);
  const edited = store.edit(item.id, "超时应重试并记录原因", "reviewer", true);
  assert.equal(edited.status, "draft");
  assert.equal(edited.needs_owner_closure, true);
  assert.equal(edited.withdrawal_requested, undefined);
  assert.equal(blockingAnnotations(new AnnotationStore(path).list(), "owner").length, 1);
  assert.throws(() => store.resolveAsOwner(item.id, "owner", { revision: 0, outcome: "deferred", reason: "旧页面操作" }), /版本/);
  store.edit(item.id, "超时应重试并记录原因和次数", "reviewer", true);
  store.markSent([item.id], "interrupt");
  store.respond(item.id, { outcome: "fixed", summary: "按新文字补充重试次数", evidence: ["spec.md:1"] });
  store.reopen(item.id, "owner", undefined, true);
  assert.equal(blockingAnnotations(store.list(), "owner").length, 1);
  assert.equal(store.list()[0].rework, 3);
  const stream = buildConversation({ events: [], waiting: [], feedback: [], annotations: store.list(), annotationHistory: store.history() });
  assert.equal(stream.items.find((row) => row.kind === "reopened")?.by, "owner");
  assert.equal(stream.items.filter((row) => row.kind === "withdrawal_requested").length, 1);
  assert.equal(stream.items.find((row) => row.kind === "receipts")?.items[0].current, true, "连续改字后的版本投影须与台账一致");
  store.resolveAsOwner(item.id, "owner", { revision: 3, outcome: "deferred", reason: "后续迭代处理" });
  assert.equal(blockingAnnotations(store.list(), "owner").length, 0);
});

test("闭环权限随当前子任务责任人变化，不继承主任务或管理员代签", async () => {
  const service = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "mfc-owner-change-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const task = service.create("子模块", { account: "child-owner" });
  const state = (service as any).tasks.get(task.id);
  const store = (service as any).annotations(state) as AnnotationStore;
  const item = service.addAnnotation(task.id, { author: "reviewer", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "子模块", note: "说明幂等策略", kind: "doc" });
  store.markSent([item.id], "interrupt");
  state.summary.luban_account = "new-owner";
  for (const actor of ["child-owner", "parent-owner", "reviewer", "admin"]) {
    assert.throws(() => service.verifyAnnotation(task.id, item.id, actor, true, {
      revision: 0, outcome: "not_adopted", reason: "直接请求 API",
    }), AnnotationPermissionError);
  }
  const viewer = { username: "new-owner", can_override: false, can_route_others: true };
  assert.equal((await service.listAnnotationsAsync(task.id, viewer)).closures[0].can_resolve, true);
  assert.equal((await service.listAnnotationsAsync(task.id, { ...viewer, username: "reviewer" })).closures[0].can_resolve, false);
  const resolved = service.verifyAnnotation(task.id, item.id, "new-owner", false, {
    revision: 0, outcome: "not_adopted", reason: "接口已经声明相同约定",
  });
  assert.equal(resolved.resolution?.by, "new-owner");
  await assert.rejects(service.reopenAnnotation(task.id, item.id, "new-owner", 0), /已处置/);
  assert.throws(() => service.editAnnotation(task.id, item.id, "改掉已闭环的原话", "reviewer"), /保留历史/);
});

test("当前 owner 可以明确处置缺回执意见，旧闭环保持原操作者语义", () => {
  const { store, item } = fixture();
  const facts = { task_status: "waiting_for_human", task_owner: "owner", owner_controlled: true,
    review_ready: true, review_annotation_ids: [item.id], archival: false };
  const viewer = { username: "owner", can_override: false, can_route_others: true };
  const pending = annotationClosure(store.list()[0], facts, viewer);
  assert.equal(pending.can_resolve, true);
  assert.equal(pending.can_verify, false);
  assert.throws(() => store.resolveAsOwner(item.id, "owner", { revision: 0, outcome: "fixed", reason: "" }), /依据/);
  store.verify(item.id, "reviewer"); // 旧账只记录作者确认。
  const closed = annotationClosure(store.list()[0], facts, viewer);
  assert.equal(closed.can_resolve, undefined);
  assert.equal(closed.can_override_verify, false);
  assert.equal(store.list()[0].resolution, undefined);
});


test("责任人作出实现决策不等于 Agent 已执行；无修复回执仍需明确依据", () => {
  const { store } = fixture();
  const decision = store.add({ author: "reviewer", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "同步", note: "决定超时策略", kind: "doc", route: "owner_decision", assignee: "owner" });
  store.replyAsOwner(decision.id, "owner", "超时重试两次");
  assert.throws(() => store.resolveAsOwner(decision.id, "owner", { revision: 0, outcome: "fixed", reason: "" }), /依据/);
  store.resolveAsOwner(decision.id, "owner", { revision: 0, outcome: "accepted_risk", reason: "尚未执行，接受当前风险并记录后续安排" });
  assert.equal(store.list().find((a) => a.id === decision.id)?.response, undefined);
});


test("需求侧旧返工草稿仍需责任人处置，兼容读取不改写旧账或 Issue 语义", () => {
  const { path, store, item } = fixture();
  store.reopen(item.id, "reviewer");
  assert.equal(store.list()[0].needs_owner_closure, undefined);
  const historyLength = store.history().length;
  const migrated = new AnnotationStore(path, true);
  assert.equal(migrated.list()[0].needs_owner_closure, true);
  assert.equal(migrated.history().length, historyLength, "兼容读取不改账");
  assert.equal(migrated.requestWithdrawal(item.id, "reviewer").status, "draft");
  assert.equal(blockingAnnotations(migrated.list(), "owner").length, 1);
  migrated.resolveAsOwner(item.id, "owner", { revision: 1, outcome: "not_adopted", reason: "核对原意见后不再调整" });
  assert.equal(migrated.list()[0].status, "verified");
});


test("责任人直接确认当前 fixed 回执，无需重复填写理由，重读后保持闭环", () => {
  const { path, store, item } = fixture();
  store.respond(item.id, { outcome: "fixed", summary: "已补超时处理", evidence: ["requirement.md:1"] });
  const decision = { revision: 0, outcome: "fixed" as const, reason: "" };
  store.resolveAsOwner(item.id, "owner", decision);
  store.resolveAsOwner(item.id, "owner", decision);
  const saved = new AnnotationStore(path).list()[0];
  assert.equal(saved.status, "verified");
  assert.equal(saved.resolution?.by, "owner");
  assert.equal(saved.response?.summary, "已补超时处理");
  assert.equal(blockingAnnotations([saved], "owner").length, 0);
});


for (const artifact of [TASK_REQUIREMENT_ARTIFACT, "diff", "design.md"]) {
  test(`${artifact}：提出人可提交自己的意见，但管理员和提出人都不能代责任人闭环`, async () => {
    const service = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "owner-policy-")),
      provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
    const task = service.create("核对接口", { account: "owner" });
    const state = (service as any).tasks.get(task.id);
    state.summary.status = "waiting_for_human";
    const store = (service as any).annotations(state) as AnnotationStore;
    const own = service.addAnnotation(task.id, { author: "reviewer", artifact,
      file: "spec.md", line: 1, anchor: "核对接口", note: "补充重试说明", kind: "doc" });
    const foreign = service.addAnnotation(task.id, { author: "another", artifact,
      file: "spec.md", line: 1, anchor: "核对接口", note: "补充超时说明", kind: "doc" });
    const sent = await service.sendAnnotations(task.id, [own.id], "reviewer");
    assert.deepEqual(sent.sent, [own.id]);
    await assert.rejects(service.sendAnnotations(task.id, [foreign.id], "reviewer"));
    assert.equal(store.list().find((one) => one.id === foreign.id)?.status, "draft");
    for (const actor of ["reviewer", "admin", "another"]) {
      for (const outcome of ["fixed", "not_adopted", "deferred", "accepted_risk"] as const) {
        assert.throws(() => service.verifyAnnotation(task.id, own.id, actor, true,
          { revision: 0, outcome, reason: "直接调用接口" }), AnnotationPermissionError);
      }
      await assert.rejects(service.reopenAnnotation(task.id, own.id, actor, 0), AnnotationPermissionError);
    }
    service.dropAnnotation(task.id, own.id, "reviewer");
    assert.equal(store.list().find((one) => one.id === own.id)?.status, "sent", "撤回表达不是闭环");
    assert.equal(blockingAnnotations(store.list(), "owner").length, 1);
    const resolved = service.verifyAnnotation(task.id, own.id, "owner", false,
      { revision: 0, outcome: "not_adopted", reason: "重试策略已在接口约定中说明" });
    assert.equal(resolved.status, "verified");
    assert.equal(resolved.resolution?.by, "owner");
  });
}
