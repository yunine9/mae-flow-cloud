import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { TaskService } from "../src/taskService.ts";
import { buildService, deliveryModel, walkScript, makeSourceRepo, git, until } from "./delivery.helpers.ts";
import { queueTaskHostOperation, finishTaskHostOperation } from "../src/taskHostTools.ts";
import { deliveryChangeSnapshot } from "../src/artifacts.ts";

for (const baselineStatus of ["passed", "failed"] as const) test(`基线预热 ${baselineStatus} 独立保留，交付与恢复不自动调用 Build-Fix`, async t => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "optional-buildfix-remote-")));
  await platform.start(); t.after(() => platform.stop());
  const dataDir = mkdtempSync(join(tmpdir(), "optional-buildfix-data-"));
  const model = deliveryModel(walkScript(), dataDir);
  await model.start(); t.after(() => model.stop());
  const service = buildService(platform, dataDir, model.modelsJson(), { pollIntervalMs: 100 });
  t.after(() => service.shutdown());
  const api: any = service;
  let warmups = 0, builds = 0;
  api.options.warmup = { enabled: true, runner: async () => {
    warmups++; return { status: baselineStatus, message: "基线预热结果", build_command: "baseline compile" };
  } };
  api.options.prepush = { enabled: true, runner: async (request: any) => {
    builds++; return { status: "passed", sha: request.sha, message: "主动验证通过" };
  } };
  api.options.maxConcurrent = 0;
  const created = service.create("REQ9：编码中自由验证，交付不重复编译");
  // 此夹具由模型首轮才装配流程；先在干净基线验证后台预热。
  const pending = api.tasks.get(created.id);
  pending.cwd = makeSourceRepo();
  await api.performBaselineWarmup(pending, false);
  pending.cwd = undefined;
  api.options.maxConcurrent = 1;
  api.pump();
  await until(() => service.get(created.id)?.status === "await_merge", "正常推送与权威流水线");
  const state = api.tasks.get(created.id);
  assert.equal(warmups, 1); assert.equal(builds, 0);
  assert.equal(state.summary.baseline_build.status, baselineStatus);
  assert.equal(state.summary.delivery.prepush, undefined, "不伪造 PASS 或用户跳过记录");
  assert.equal(platform.pipelines.length, 1);
  assert.match(JSON.stringify(model.requests[0]), /过程中按改动影响及时执行/);
  assert.match(JSON.stringify(model.requests[0]), /交付前不会自动补跑 Build-Fix/);

  const old = state.summary.delivery.sha;
  state.summary.delivery.prepush = { state: "passed", sha: old };
  writeFileSync(join(state.cwd, "a.txt"), "next revision\n");
  git(state.cwd, "add", "a.txt"); git(state.cwd, "commit", "-qm", "[REQ9][fix] 新版本验证");
  const head = git(state.cwd, "rev-parse", "HEAD");
  const snapshot = await deliveryChangeSnapshot(state.cwd);
  const presentation = await api.buildPushReviewPresentation(state, snapshot);
  assert.notEqual(presentation.verification, "Build-Fix 已通过", "旧 SHA 不能背书当前改动");
  state.summary.status = "verifying";
  await api.tryDeliver(state, state.controlEpoch);
  assert.equal(state.summary.delivery.git_push.sha, head, "推送绑定当前 HEAD 而不是旧编译收据");
  assert.equal(builds, 0); assert.equal(platform.pipelines.length, 2);

  await service.shutdown();
  const revived = new TaskService({ ...api.options, maxConcurrent: 0 });
  t.after(() => revived.shutdown());
  revived.recover();
  assert.equal(builds, 0); assert.equal(warmups, 1);
  assert.equal(revived.get(created.id)?.status, "await_merge");
  platform.settleMr("master_bot_REQ9", "merged");
  await until(() => revived.get(created.id)?.status === "completed", "重启后继续监听合入");
});

test("Agent 主动请求仍可独立编译和 UT，真实结果通过宿主回执返回", async t => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "requested-buildfix-remote-")));
  await platform.start(); t.after(() => platform.stop());
  const dataDir = mkdtempSync(join(tmpdir(), "requested-buildfix-data-"));
  const model = deliveryModel(walkScript(), dataDir);
  await model.start(); t.after(() => model.stop());
  const service = buildService(platform, dataDir, model.modelsJson(), { pollIntervalMs: 100_000 });
  t.after(() => service.shutdown());
  const api: any = service;
  let calls = 0;
  api.options.prepush = { enabled: true, runner: async (request: any) => {
    calls++; return { status: "passed", sha: request.sha, message: "独立编译与 UT 成功" };
  } };
  const { id } = service.create("REQ9：按需验证");
  await until(() => service.get(id)?.status === "await_merge", "首次交付");
  assert.equal(calls, 0);
  api.options.maxConcurrent = 0;
  const state = api.tasks.get(id);
  writeFileSync(join(state.cwd, "a.txt"), "new change to verify\n");
  git(state.cwd, "add", "a.txt"); git(state.cwd, "commit", "-qm", "[REQ9][fix] 待验证改动");
  const host = api.taskHostRuntime(state);
  await queueTaskHostOperation(host, "explicit-verification", { action: "retry_verification", reason: "本轮需要独立编译与 UT" });
  await finishTaskHostOperation(host);
  assert.equal(calls, 1);
  assert.equal(service.get(id)?.delivery?.prepush?.state, "passed");
  assert.equal(service.get(id)?.delivery?.prepush?.sha, git(state.cwd, "rev-parse", "HEAD"));
});
