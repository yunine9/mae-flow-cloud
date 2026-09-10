import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HumanGate } from "../src/humanGate.ts";
import { TaskService } from "../src/taskService.ts";
import { askMrDescription, savedMrDescription, MR_DESCRIPTION_STEP } from "../src/mrDescription.ts";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { makeSourceRepo, deliveryModel, walkScript, until, KERNEL_ROOT } from "./delivery.helpers.ts";

test("AR 描述按单号保存：换 HEAD 不重问，换 AR 不复用；重启从人工决定恢复", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mfc-ar-desc-")), "waiting.json");
  const gate = new HumanGate(path);
  const waiting = askMrDescription(gate, "task-1", "REQ123");
  assert.match(waiting.context!, /合入时要求 MR 标题与关联 AR 单的描述一致/);
  assert.equal(savedMrDescription(gate, "task-1", "REQ123"), undefined);
  gate.resolve(waiting.waiting_id, { stateVersion: 1, decision: "跨制式自侦测接口优化", decidedBy: "owner" });
  assert.equal(savedMrDescription(new HumanGate(path), "task-1", "REQ123"), "跨制式自侦测接口优化");
  assert.equal(savedMrDescription(gate, "task-1", "REQ456"), undefined);
});

test("首次 MR 创建前人工填写开放题：空值/非责任人不通过，准确标题随单号送到平台", async t => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-ar-platform-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-ar-service-"));
  const model = deliveryModel(walkScript(), dataDir);
  await model.start();
  const service = new TaskService({ dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: { kernelRoot: KERNEL_ROOT, repoPath: platform.barePath, python: "python3", continuousReview: true },
    delivery: { platformUrl: platform.baseUrl, pollIntervalMs: 100 },
  });
  t.after(async () => { await service.shutdown(); await model.stop(); await platform.stop(); });
  const id = service.create("Agent 自动生成的任务标题", { ticket: "REQ9" }).id;
  const task = (service as any).tasks.get(id);
  task.summary.luban_account = "owner";
  await until(() => service.get(id)?.waiting?.step === MR_DESCRIPTION_STEP, "等待 AR 描述");
  const waiting = service.get(id)!.waiting!;
  assert.equal(waiting.recommended_view, "source", "开放题不能误入文件勾选卡");
  assert.equal(platform.mergeRequests.length, 0);
  assert.equal(platform.pipelines.length, 0);
  assert.equal((service as any).autoAnswerFor(task, true), undefined, "月光模式不能编造 AR 描述");
  const base = { waiting_id: waiting.waiting_id, state_version: waiting.state_version, actor: "owner" };
  await assert.rejects(service.decide(id, { ...base, decision: " " }), /不能为空/);
  await assert.rejects(service.decide(id, { ...base, actor: "reviewer", decision: "错误提交" }), /只有主责任人/);
  const text = "跨制式 KPI 自侦测需求（优化版）";
  const question = (waiting.question as any).questions[0].question;
  await service.decide(id, { ...base, free_responses: { [question]: text } });
  await until(() => service.get(id)?.status === "await_merge", "填写后继续交付");
  assert.equal(platform.mergeRequests[0].title, text, "不拼单号、任务名或状态后缀");
  assert.equal(platform.mergeRequests[0].e2e_issues, "REQ9");
  assert.equal(savedMrDescription(task.humanGate, id, "REQ9"), text);
  assert.equal(task.humanGate.all().filter((r: any) => r.step === MR_DESCRIPTION_STEP).length, 1);
});

test("答复已落盘但继续交付前进程退出：恢复不再举卡、不重启 Agent", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-ar-recover-"));
  const options = { dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 };
  const service = new TaskService(options);
  const id = service.create("AR 描述断点恢复", { ticket: "REQ9" }).id;
  const task = (service as any).tasks.get(id);
  task.summary.waiting = askMrDescription(task.humanGate, id, "REQ9");
  task.summary.status = "waiting_for_human";
  (service as any).persist(task);
  task.humanGate.resolve(task.summary.waiting.waiting_id, { stateVersion: 1, decision: "原样描述" });
  await service.shutdown();
  const revived = new TaskService(options);
  t.after(() => revived.shutdown());
  const titles: string[] = [];
  (revived as any).tryDeliver = async (restored: any) => {
    titles.push(savedMrDescription(restored.humanGate, id, "REQ9")!);
  };
  revived.recover();
  await until(() => titles.length === 1, "恢复交付");
  assert.deepEqual(titles, ["原样描述"]);
  assert.equal(revived.get(id)!.status, "verifying");
  assert.equal(revived.get(id)!.waiting, undefined);
});
