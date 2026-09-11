import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { makeSourceRepo, runTask, git } from "./delivery.helpers.ts";
import { queueTaskHostOperation, finishTaskHostOperation, hostResumeMission } from "../src/taskHostTools.ts";
import { CI_MISSION_END, remainingCiMission, shouldVerifyCiPush } from "../src/ciMission.ts";
import { historicalPipelineFeedback } from "../src/pipelineHandoff.ts";

test("发布后立即撤出旧 CI 使命，保留追加的人工目标，同 SHA 和失败推送保持原意", () => {
  const old = "a".repeat(40), fresh = "b".repeat(40);
  const summary: any = { delivery: { sha: fresh, git_push: { sha: fresh }, loop: { kind: "ci", last_sha: old } } };
  const prefix = `当前目标是处理本轮流水线失败(第 1 轮修复)\n- 分支上提交 ${old} 的权威流水线结果是 failed。\n旧的报错\n`;
  for (const end of [CI_MISSION_END, '流水线"及原因,不许拿无关的汇报顶替诊断。']) {
    assert.equal(shouldVerifyCiPush(prefix + end, summary), true);
    assert.equal(remainingCiMission(prefix + end + "\n\n责任人：继续补查询测试", summary), "责任人：继续补查询测试");
  }
  assert.equal(historicalPipelineFeedback(summary, { source: "pipeline", source_id: `${old}:COMPILE` }), true,
    "新流水线尚无状态时，旧 SHA 已经是历史");
  assert.equal(historicalPipelineFeedback(summary, { source: "workspace", observed_sha: old }), false);
  const mission = prefix + CI_MISSION_END;
  assert.equal(remainingCiMission("责任人要求重查旧日志", summary), "责任人要求重查旧日志");
  const failed: any = { state: "failed", input: { action: "push" }, push_receipt: { sha: fresh } };
  assert.match(hostResumeMission(mission, "失败", undefined, failed, summary), /旧的报错/);
  summary.delivery.git_push.sha = old;
  assert.equal(remainingCiMission(mission, summary), mission);
});

for (const status of ["running", "success", "failed"] as const) test(`真实 CI 修复 push 后直接处理新 SHA ${status}，不把旧告警交回 Agent`, async t => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "fresh-ci-remote-")));
  await platform.start(); t.after(() => platform.stop());
  const { service, task } = await runTask(platform, true, { pollIntervalMs: 100_000 });
  t.after(() => service.shutdown());
  const api: any = service;
  api.options.maxConcurrent = 0;
  const state = api.tasks.get(task.id), old = state.summary.delivery.sha;
  state.summary.delivery.checks = undefined;
  state.summary.delivery.pipeline = "failed";
  await api.dispatchCiRepair(state, old, "BUILD FAILURE: OLD_ONLY 已修复的旧问题", 20, state.controlEpoch);
  assert.match(state.mission, /OLD_ONLY/);
  writeFileSync(join(state.cwd, "a.txt"), "new fix\n");
  git(state.cwd, "add", "a.txt"); git(state.cwd, "commit", "-qm", "[REQ9][fix] 本轮修复");
  state.summary.push_confirmation = false;
  platform.nextPipelineStatus = status;
  platform.nextPipelineLog = "BUILD FAILURE: NEW_ONLY 新版本具体报错";
  const host = api.taskHostRuntime(state);
  const operation = await queueTaskHostOperation(host, "publish-ci-fix", { action: "push", reason: "发布本轮 CI 修复并继续验证" });
  await finishTaskHostOperation(host);
  assert.equal(state.summary.delivery.git_push.sha, operation.sha);
  assert.equal(state.summary.delivery.sha, operation.sha);
  assert.doesNotMatch(state.mission ?? "", /OLD_ONLY/);
  const kernel = JSON.parse(readFileSync(join(state.cwd, ".mae-flow.json"), "utf8"));
  const original = kernel.delivery_loop.batches.find((b: any) => b.base_sha === old);
  assert.equal(original.status, "superseded");
  assert.equal(original.verified_sha, undefined, "新推送不是旧反馈已通过");
  assert.match(JSON.stringify(original.items), /OLD_ONLY/, "旧失败原文仍可追溯");
  assert.equal(platform.pipelines.filter(run => run.sha === operation.sha).length, 1);
  if (status === "failed") {
    assert.match(state.mission, /NEW_ONLY/);
    assert.equal(state.summary.delivery.loop.last_sha, operation.sha);
    const active = kernel.delivery_loop.batches.find((b: any) => b.batch_id === kernel.delivery_loop.active_batch_id);
    assert.equal(active.base_sha, operation.sha, "新失败不会排在旧批次后面等旧绿灯");
  } else {
    assert.equal(state.mission, undefined);
    assert.equal(state.summary.status, status === "success" ? "await_merge" : "verifying");
  }
});
