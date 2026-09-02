import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TASK_REQUIREMENT_ARTIFACT } from "../src/annotations.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskControlError, TaskService } from "../src/taskService.ts";
import { unanchoredRequirementChanges } from "../src/requirementDocument.ts";

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
  // 剧本按请求顺序演:第 1 幕回执缺了 id → 整轮拒收;第 2 幕合格。
  const model = new ScriptedModelServer([{
    text: "===RECEIPTS===\n[]\n===REQUIREMENT===\n# 用户需求\n瞎改\n===END_REQUIREMENT===",
  }, {
    text: "===RECEIPTS===\n[{\"annotation_id\":\"__OWNER__\",\"outcome\":\"fixed\",\"summary\":\"补了验收口径\"}]\n"
      + "===REQUIREMENT===\n# 用户需求\n已补充验收口径\n===END_REQUIREMENT===",
  }, {
    text: "===RECEIPTS===\n[{\"annotation_id\":\"__REVIEWER__\",\"outcome\":\"not_fixed\",\"summary\":\"异常场景已在验收口径里覆盖,未另起段落\"}]\n"
      + "===REQUIREMENT===\n# 用户需求\n已补充验收口径\n已明确异常场景\n===END_REQUIREMENT===",
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

    // 剧本里的占位 id 换成真实 id:回执必须能指回同一条意见。
    for (const scene of model.script) {
      scene.text = scene.text!
        .replace("__OWNER__", ownerNote.id).replace("__REVIEWER__", reviewerNote.id);
    }
    // 第 1 幕:回执缺了这条意见 → 整轮拒收,文档一个字不动,意见还是草稿。
    await assert.rejects(
      service.sendAnnotations(created.id, [ownerNote.id], "owner"),
      (error) => error instanceof TaskControlError && /回执不完整/.test(error.message));
    assert.equal(service.get(created.id)?.requirement, "# 用户需求\n原始口径");
    assert.equal(service.listAnnotations(created.id).items
      .find((item) => item.id === ownerNote.id)?.status, "draft");
    assert.equal(service.get(created.id)?.requirement_revision?.state, "failed");

    await service.sendAnnotations(created.id, [ownerNote.id], "owner");
    assert.equal(service.get(created.id)?.requirement,
      "# 用户需求\n已补充验收口径");
    assert.equal(service.get(created.id)?.status, "waiting_for_human");
    const ownerSent = service.listAnnotations(created.id).items
      .find((item) => item.id === ownerNote.id)!;
    assert.equal(ownerSent.status, "sent");
    assert.equal(ownerSent.response?.outcome, "fixed",
      "逐条回执要落到意见上,页面才有'Agent:已处理'可看");
    assert.equal(ownerSent.response?.summary, "补了验收口径");
    // 改前全文和 diff 留了底,页面按 id 取对比。
    const revisions = service.get(created.id)?.requirement_revisions ?? [];
    assert.equal(revisions.length, 1);
    assert.deepEqual(revisions[0].annotation_ids, [ownerNote.id]);
    assert.equal(revisions[0].additions, 1);
    assert.equal(revisions[0].deletions, 1);
    const stored = service.requirementRevision(created.id, revisions[0].id)!;
    assert.equal(stored.before, "# 用户需求\n原始口径");
    assert.match(stored.diff, /^diff --git a\/需求原文\.md b\/需求原文\.md/m);
    assert.match(stored.diff, /^-原始口径$/m);
    assert.match(stored.diff, /^\+已补充验收口径$/m);
    assert.equal(service.requirementRevision(created.id, "../etc"), undefined);

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
    assert.equal(service.listAnnotations(created.id).items
      .find((item) => item.id === reviewerNote.id)?.response?.outcome, "not_fixed");
    assert.equal(model.requests.length, 3,
      "需求确认只启动专用文档修改(含被拒收的一轮)，不会提前启动主执行会话");
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

test("逐段比对:没有意见指向的段落被改就整轮拒收", () => {
  const before = "# 用户需求\n\n登录后记住账号。\n\n密码错误三次锁定十分钟。\n\n支持手机号登录。";
  const notes = [{ anchor: "记住账号", line: 3 }];
  // 只改被指向的段、在中间插新段、挪位置:都放行。
  assert.deepEqual(unanchoredRequirementChanges(before,
    "# 用户需求\n\n登录后记住账号,刷新不必重输。\n\n新增:记住时长 30 天。\n\n支持手机号登录。\n\n密码错误三次锁定十分钟。",
    notes), []);
  // 顺手润色没被指向的段:拒。
  assert.deepEqual(unanchoredRequirementChanges(before,
    "# 用户需求\n\n登录后记住账号,刷新不必重输。\n\n密码错误三次锁定 10 分钟。\n\n支持手机号登录。",
    notes), ["密码错误三次锁定十分钟。"]);
  // 悄悄删掉一段:拒。
  assert.deepEqual(unanchoredRequirementChanges(before,
    "# 用户需求\n\n登录后记住账号,刷新不必重输。\n\n密码错误三次锁定十分钟。",
    notes), ["支持手机号登录。"]);
  // 锚点原文已被上一轮改掉时,按行号兜住这一段。
  assert.deepEqual(unanchoredRequirementChanges(before,
    "# 用户需求\n\n登录后自动填充账号。\n\n密码错误三次锁定十分钟。\n\n支持手机号登录。",
    [{ anchor: "早就不在了", line: 3 }]), []);
});

test("Agent 改了没被指向的段落,回执再合格也拒收,文档一个字不动", async () => {
  const model = new ScriptedModelServer([{
    text: "===RECEIPTS===\n[{\"annotation_id\":\"__NOTE__\",\"outcome\":\"fixed\",\"summary\":\"补了时长\"}]\n"
      + "===REQUIREMENT===\n# 用户需求\n\n登录后记住账号,30 天内免登录。\n\n密码错误三次锁定 10 分钟。\n===END_REQUIREMENT===",
  }, {
    text: "===RECEIPTS===\n[{\"annotation_id\":\"__NOTE__\",\"outcome\":\"fixed\",\"summary\":\"补了时长\"}]\n"
      + "===REQUIREMENT===\n# 用户需求\n\n登录后记住账号,30 天内免登录。\n\n密码错误三次锁定十分钟。\n===END_REQUIREMENT===",
  }], "scripted-v1", { linear: true });
  await model.start();
  try {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-requirement-drift-"));
    const service = new TaskService({
      dataDir, provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(), maxConcurrent: 0,
    });
    const original = "# 用户需求\n\n登录后记住账号。\n\n密码错误三次锁定十分钟。";
    const created = service.create(original, {
      account: "owner", requirementAnalysis: true,
      requirementAnalysisConfirmation: true,
    });
    const note = service.addAnnotation(created.id, {
      author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
      file: "需求原文", line: 3, anchor: "记住账号",
      note: "写明记住多久", kind: "doc",
    });
    for (const scene of model.script) {
      scene.text = scene.text!.replace("__NOTE__", note.id);
    }
    // 第 1 幕:回执合格,但顺手把锁定时长那段也润色了 → 拒。
    await assert.rejects(
      service.sendAnnotations(created.id, [note.id], "owner"),
      (error) => error instanceof TaskControlError
        && /没有意见指向的段落/.test(error.message)
        && /密码错误三次锁定十分钟/.test(error.message));
    assert.equal(service.get(created.id)?.requirement, original);
    assert.equal(service.get(created.id)?.requirement_revision?.state, "failed");
    assert.match(service.get(created.id)?.requirement_revision?.error ?? "",
      /没有意见指向的段落/, "拒收原因要留在任务上,页面才有得显示");
    assert.equal(service.get(created.id)?.requirement_revisions?.length ?? 0, 0,
      "拒收的一轮不留底,不算一轮修改");
    // 第 2 幕:只动被指向的段 → 收。
    await service.sendAnnotations(created.id, [note.id], "owner");
    assert.equal(service.get(created.id)?.requirement,
      "# 用户需求\n\n登录后记住账号,30 天内免登录。\n\n密码错误三次锁定十分钟。");
    assert.equal(service.get(created.id)?.requirement_revision, undefined);
  } finally {
    await model.stop();
  }
});
