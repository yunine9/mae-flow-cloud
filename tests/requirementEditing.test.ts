import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASK_REQUIREMENT_ARTIFACT } from "../src/annotations.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskControlError, TaskService } from "../src/taskService.ts";

const CONFIRM_STEP = "cloud_requirement_analysis_confirm";
const CONFIRM_OPTION = "需求已确认，进入需求分析";

function confirmationQuestion(task: ReturnType<TaskService["get"]>): string {
  const questions = task?.waiting?.question?.questions as
    | Array<{ question: string }> | undefined;
  assert.ok(questions?.[0]?.question);
  return questions[0].question;
}

test("新下单先在工作台确认需求，不会提前进入执行队列", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-requirement-confirm-"));
  const service = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const created = service.create("# 用户需求\n先共同核对", {
    account: "owner",
    requirementDocumentName: "业务需求.md",
    requirementAnalysisConfirmation: true,
  });

  assert.equal(created.status, "waiting_for_human");
  assert.equal(created.waiting?.step, CONFIRM_STEP);
  assert.equal(service.get(created.id)?.waiting?.recommended_view, "source");
  assert.equal(created.requirement_analysis_confirmed_at, undefined);

  const saved = JSON.parse(readFileSync(
    join(created.workspace, "task.json"), "utf-8"));
  assert.equal(saved.summary.status, "waiting_for_human");
  assert.equal(saved.summary.waiting.step, CONFIRM_STEP);
});

test("多人检视意见由 Agent 修改同一份需求，全部闭环后才能确认分析", async () => {
  const model = new ScriptedModelServer([{
    text: "===REQUIREMENT===\n# 用户需求\n已补充验收口径\n===END_REQUIREMENT===",
  }, {
    text: "===REQUIREMENT===\n# 用户需求\n已补充验收口径\n已明确异常场景\n===END_REQUIREMENT===",
  }], "scripted-v1", { linear: true });
  await model.start();
  try {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-requirement-review-"));
    const service = new TaskService({
      dataDir, provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(), maxConcurrent: 0,
    });
    const created = service.create("# 用户需求\n原始口径", {
      account: "owner", collaborators: ["reviewer"],
      requirementAnalysis: true,
      requirementAnalysisConfirmation: true,
    });
    const ownerNote = service.addAnnotation(created.id, {
      author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
      file: "需求原文", line: 2, anchor: "原始口径",
      note: "补充可核对的验收口径", kind: "doc",
    });
    const reviewerNote = service.addAnnotation(created.id, {
      author: "reviewer", artifact: TASK_REQUIREMENT_ARTIFACT,
      file: "需求原文", line: 2, anchor: "原始口径",
      note: "再明确异常场景", kind: "doc",
    });
    const question = confirmationQuestion(service.get(created.id));

    await assert.rejects(service.decide(created.id, {
      state_version: service.get(created.id)!.waiting!.state_version,
      selected_options: { [question]: CONFIRM_OPTION }, actor: "reviewer",
    }), (error) => error instanceof TaskControlError
      && /只有主责任人 owner/.test(error.message));

    await assert.rejects(service.decide(created.id, {
      state_version: service.get(created.id)!.waiting!.state_version,
      selected_options: { [question]: CONFIRM_OPTION }, actor: "owner",
    }), (error) => error instanceof TaskControlError
      && /2 条意见尚未提交/.test(error.message));

    await service.sendAnnotations(created.id, [ownerNote.id], "owner");
    assert.equal(service.get(created.id)?.requirement,
      "# 用户需求\n已补充验收口径");
    assert.equal(service.get(created.id)?.status, "waiting_for_human");
    assert.equal(service.listAnnotations(created.id).items
      .find((item) => item.id === ownerNote.id)?.status, "sent");

    await service.verifyAnnotation(created.id, ownerNote.id, "owner");
    await assert.rejects(service.decide(created.id, {
      state_version: service.get(created.id)!.waiting!.state_version,
      selected_options: { [question]: CONFIRM_OPTION }, actor: "owner",
    }), (error) => error instanceof TaskControlError
      && /1 条意见尚未提交/.test(error.message),
    "受邀参与者留下的草稿也不能被责任人越过");

    await service.sendAnnotations(created.id, [reviewerNote.id], "reviewer");
    assert.equal(service.get(created.id)?.requirement,
      "# 用户需求\n已补充验收口径\n已明确异常场景");
    await assert.rejects(service.decide(created.id, {
      state_version: service.get(created.id)!.waiting!.state_version,
      selected_options: { [question]: CONFIRM_OPTION }, actor: "owner",
    }), (error) => error instanceof TaskControlError
      && /1 条意见仍待提出人确认/.test(error.message));

    await service.verifyAnnotation(created.id, reviewerNote.id, "reviewer");
    await service.decide(created.id, {
      waiting_id: service.get(created.id)!.waiting!.waiting_id,
      state_version: service.get(created.id)!.waiting!.state_version,
      selected_options: { [question]: CONFIRM_OPTION }, actor: "owner",
    });

    const confirmed = service.get(created.id)!;
    assert.equal(confirmed.status, "queued");
    assert.equal(confirmed.waiting, undefined);
    assert.ok(confirmed.requirement_analysis_confirmed_at);
    assert.equal(confirmed.requirement,
      "# 用户需求\n已补充验收口径\n已明确异常场景");
    assert.equal(model.requests.length, 2,
      "需求确认只启动两次专用文档修改，不会提前启动主执行会话");
  } finally {
    await model.stop();
  }
});

test("服务重启会恢复被中断的需求修改，不留下永久 running", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-requirement-recover-"));
  const first = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const created = first.create("待修改需求", {
    account: "owner", requirementAnalysisConfirmation: true,
  });
  const note = first.addAnnotation(created.id, {
    author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "待修改需求",
    note: "补充验收条件", kind: "doc",
  });
  const internal = (first as any).tasks.get(created.id);
  (first as any).annotations(internal).markSent([note.id], "interrupt");
  internal.summary.requirement_revision = {
    id: "revision-before-restart", state: "running",
    annotation_ids: [note.id], started_at: new Date().toISOString(),
  };
  (first as any).persist(internal);

  const recovered = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  assert.equal(recovered.recover().restored, 1);
  const task = recovered.get(created.id)!;
  assert.equal(task.status, "waiting_for_human");
  assert.equal(task.waiting?.step, CONFIRM_STEP);
  assert.equal(task.requirement_revision?.state, "failed");
  assert.match(task.requirement_revision?.error ?? "", /重新提交/);
  assert.equal(recovered.listAnnotations(created.id).items[0].status, "draft");
});
