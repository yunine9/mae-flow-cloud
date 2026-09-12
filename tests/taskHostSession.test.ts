/** Actual model tool call → turn handoff → host Git → resumed model context. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { TaskHostLedger } from "../src/taskHostTools.ts";
import { managedFlowFixture } from "./support/managedFlowFixture.ts";
import { KERNEL_ROOT, makeSourceRepo, until } from "./delivery.helpers.ts";

test("真实主会话在 build 阶段调用宿主推送，交接后收到远端收据且流程仍未完成", async t => {
  const root = mkdtempSync(join(tmpdir(), "mfc-host-session-"));
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), join(root, "platform"));
  await platform.start();
  const dataDir = join(root, "tasks");
  const prepare = managedFlowFixture(dataDir, { continuousReview: true });
  let service: TaskService, id = "";
  const model = new ScriptedModelServer([
    { tool: { name: "bash", input: { command: "echo stage-B > a.txt" } } },
    { tool: { name: "task_control", input: { action: "push", reason: "先推送 B 的已提交部分" } } },
    { text: "已排队，交还现场执行。" },
    { tool: { name: "task_context", input: { view: "operations" } } },
    { text: "已读到宿主真实结果，继续当前目标。" },
  ], "scripted-v1", { linear: true, beforeScene: context => {
    if (context.index > 1) return;
    prepare(context);
    if (context.index === 1) {
      const task = (service as any).tasks.get(id);
      const path = join(task.cwd, ".mae-flow.json");
      const state = JSON.parse(readFileSync(path, "utf8"));
      state.current = "build"; // Deliberately publish before ordinary delivery completion.
      writeFileSync(path, JSON.stringify(state));
    }
  } });
  await model.start();
  service = new TaskService({ dataDir, provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson(),
    host: { kernelRoot: KERNEL_ROOT, python: "python3", continuousReview: true },
    delivery: { platformUrl: platform.baseUrl } });
  t.after(async () => { await service.shutdown(); await model.stop(); await platform.stop(); rmSync(root, { recursive: true, force: true }); });
  id = service.create("实现并按需阶段性推送 B", { repo: platform.barePath, ticket: "REQ9" }).id;
  await until(() => {
    const task = service.get(id)!;
    return new TaskHostLedger(task).read().operations.some(op => op.state === "succeeded")
      && model.requests.some(request => JSON.stringify(request).includes("已核验远端"));
  }, "主会话收到阶段性推送结果", 30000);
  const task = service.get(id)!;
  const op = new TaskHostLedger(task).read().operations[0];
  assert.equal(op.input.action, "push");
  assert.equal(op.state, "succeeded", op.result);
  assert.equal(execFileSync("git", ["--git-dir", platform.barePath, "rev-parse", op.branch!], { encoding: "utf8" }).trim(), op.sha);
  assert.equal(task.delivery?.git_push?.sha, op.sha);
  assert.notEqual(task.status, "completed");
  assert.equal(task.delivery?.sha, op.sha, "实际推送必须同步交付版本，两条入口一致");
  assert.ok(["待查询", "not_found"].includes(task.delivery?.pipeline ?? ""), "推送后只启动观察，不冒充运行或通过");
  const active = (service as any).tasks.get(id);
  assert.equal(JSON.parse(readFileSync(join(active.cwd, ".mae-flow.json"), "utf8")).current, "build",
    "阶段性推送不擅自推进内核");
  assert.equal(platform.mergeRequests.length, 0, "push 不隐含 MR 创建");
  assert.equal(new TaskHostLedger(task).read().operations.length, 1);
});

test("真实 Agent 推送后触发新流水线，不携带旧 CI 使命再次入场", async t => {
  const root = mkdtempSync(join(tmpdir(), "mfc-host-session-"));
  const platform = new FakeGitPlatform();
  platform.nextPipelineStatus = "running";
  platform.initBare(makeSourceRepo(), join(root, "platform"));
  await platform.start();
  const dataDir = join(root, "tasks");
  const prepare = managedFlowFixture(dataDir, { continuousReview: true });
  let service: TaskService, id = "";
  const model = new ScriptedModelServer([
    { tool: { name: "bash", input: { command: "echo stage-B > a.txt" } } },
    { tool: { name: "task_control", input: { action: "push", reason: "先推送 B 的已提交部分" } } },
    { text: "已排队，交还现场执行。" },
    { tool: { name: "task_pipeline", input: { action: "trigger" } } },
    { text: "已读到宿主真实结果，继续当前目标。" },
  ], "scripted-v1", { linear: true, beforeScene: async context => {
    if (context.index === 3) {
      const task = (service as any).tasks.get(id);
      const { createMergeRequest } = await import("../src/mrClient.ts");
      const mr = await createMergeRequest({ platformUrl: platform.baseUrl, sourceBranch: "master_bot_REQ9", targetBranch: "master", title: "已进入 CI 的既有 MR" });
      task.summary.delivery = { ...task.summary.delivery, mr_url: mr.url, mr_id: mr.id };
      task.mission = "当前目标是处理本轮流水线失败(1)。分支上提交 old-sha 的权威流水线结果是 failed。[本轮流水线修复目标结束]";
      task.summary.delivery = { ...task.summary.delivery, sha: "old-sha", pipeline: "failed",
        loop: { kind: "ci", round: 1, state: "repairing", last_sha: "old-sha", failure: "旧 SHA 告警" } };
    }
    if (context.index > 1) return;
    prepare(context);
    if (context.index === 1) {
      const task = (service as any).tasks.get(id);
      const path = join(task.cwd, ".mae-flow.json");
      const state = JSON.parse(readFileSync(path, "utf8"));
      state.current = "build"; // Deliberately publish before ordinary delivery completion.
      writeFileSync(path, JSON.stringify(state));
    }
  } });
  await model.start();
  service = new TaskService({ dataDir, provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson(),
    host: { kernelRoot: KERNEL_ROOT, python: "python3", continuousReview: true },
    delivery: { platformUrl: platform.baseUrl } });
  t.after(async () => { await service.shutdown(); await model.stop(); await platform.stop(); rmSync(root, { recursive: true, force: true }); });
  id = service.create("实现并按需阶段性推送 B", { repo: platform.barePath, ticket: "REQ9" }).id;
  await until(() => service.get(id)?.status === "verifying"
    && new TaskHostLedger(service.get(id)!).read().operations.some(op => op.input.action === "trigger_pipeline" && op.state === "succeeded"),
  "新流水线接棒", 30000);
  const snapshot = service.get(id)!;
  const requests = model.requests.length;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(model.requests.length, requests, "等待新流水线期间不再召回 Agent 修旧告警");
  assert.equal(snapshot.delivery?.sha, snapshot.delivery?.git_push?.sha);
  assert.equal(snapshot.delivery?.pipeline, "running");
  assert.equal(snapshot.delivery?.loop?.state, "verifying");
  assert.equal(snapshot.delivery?.loop?.last_sha, "old-sha");
  assert.equal(snapshot.delivery?.loop?.failure, "旧 SHA 告警");
  assert.equal(JSON.parse(readFileSync(join(snapshot.workspace, "task.json"), "utf8")).mission, undefined);
  assert.equal(platform.pipelines.length, 1);
});

test("真实会话提前验绿继续编码，正式交付补建 MR 并复用流水线，随后监听合入", async t => {
  const { MrDescriptionReplyService } = await import("./support/mrDescriptionReply.ts");
  const root = mkdtempSync(join(tmpdir(), "mfc-early-mr-"));
  const platform = new FakeGitPlatform(); platform.nextPipelineStatus = "success";
  platform.initBare(makeSourceRepo(), join(root, "platform")); await platform.start();
  const dataDir = join(root, "tasks"), prepare = managedFlowFixture(dataDir, { continuousReview: true });
  let service: TaskService, id = "", continued = false;
  const model = new ScriptedModelServer([
    { tool: { name: "bash", input: { command: "echo stage-B > a.txt" } } },
    { tool: { name: "task_control", input: { action: "push", reason: "先发布当前进展" } } },
    { text: "交还现场执行。" },
    { tool: { name: "task_pipeline", input: { action: "trigger" } } },
    { text: "提前验证，然后继续当前工作。" },
    { tool: { name: "task_context", input: { view: "overview" } } },
    { text: "已完成当前目标，交给宿主交付。" },
  ], "scripted-v1", { linear: true, beforeScene: context => {
    if (context.index <= 1) {
      prepare(context);
      if (context.index === 1) {
        const task = (service as any).tasks.get(id), path = join(task.cwd, ".mae-flow.json");
        const state = JSON.parse(readFileSync(path, "utf8")); state.current = "build";
        writeFileSync(path, JSON.stringify(state));
      }
    }
    if (context.index === 5) {
      const task = (service as any).tasks.get(id);
      assert.equal(task.summary.delivery.pipeline, "success");
      assert.equal(task.summary.delivery.mr_url, undefined);
      assert.notEqual(task.summary.status, "await_merge"); continued = true;
      // 与托管交付夹具相同：测试控制器只准备内核阶段，真实宿主仍负责交付。
      const path = join(task.cwd, ".mae-flow.json"), state = JSON.parse(readFileSync(path, "utf8"));
      state.current = "external_verify"; writeFileSync(path, JSON.stringify(state));
    }
  } });
  await model.start();
  service = new MrDescriptionReplyService({ dataDir, provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson(),
    host: { kernelRoot: KERNEL_ROOT, python: "python3", continuousReview: true },
    delivery: { platformUrl: platform.baseUrl, pollIntervalMs: 20 } });
  t.after(async () => { await service.shutdown(); await model.stop(); await platform.stop(); rmSync(root, { recursive: true, force: true }); });
  id = service.create("阶段发布后继续完成需求", { repo: platform.barePath, ticket: "REQ9" }).id;
  await until(() => service.get(id)?.status === "await_merge", "正式交付复用已绿提交并建立 MR", 30000);
  assert.ok(continued); assert.equal(platform.mergeRequests.length, 1); assert.equal(platform.pipelines.length, 1);
  assert.equal(service.get(id)?.delivery?.sha, service.get(id)?.delivery?.git_push?.sha);
  platform.settleMr(platform.mergeRequests[0].source_branch, "merged");
  await until(() => service.get(id)?.status === "completed", "平台合入事实被持续监听收口", 10000);
  assert.equal(platform.pipelines.length, 1);
});
