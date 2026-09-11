import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { triggerPipeline } from "../src/pipelineClient.ts";
import { queueTaskHostOperation, finishTaskHostOperation } from "../src/taskHostTools.ts";
import { makeSourceRepo, runTask, git, buildService, until } from "./delivery.helpers.ts";

for (const restart of [false, true]) test(`真实内核：宿主推送后${restart ? "恢复旧快照" : "直接续接"}已绿流水线，不重复推送或派旧批次`, async t => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "host-recovery-platform-")));
  await platform.start();
  t.after(() => platform.stop());
  const { service, task, dataDir } = await runTask(platform, true, { pollIntervalMs: 100_000 });
  t.after(() => service.shutdown());
  let internal: any = service;
  internal.options.maxConcurrent = 0;
  let state = internal.tasks.get(task.id);
  const old = state.summary.delivery.sha;
  internal.openFeedbackBatch(state, "pipeline", [{ id: `pipeline:${old}:COMPILE`, source: "pipeline",
    source_id: `${old}:COMPILE`, source_revision: 0, kind: "quality_failure", summary: "旧提交编译错误", verification: "pipeline" }]);
  assert.equal(JSON.parse(readFileSync(join(state.cwd, ".mae-flow.json"), "utf8")).current, "feedback_triage");
  writeFileSync(join(state.cwd, "a.txt"), "fixed after old feedback\n");
  git(state.cwd, "add", "a.txt"); git(state.cwd, "commit", "-qm", "[REQ9][fix] 修复旧失败");
  state.summary.status = "running"; state.summary.push_confirmation = false;
  const host = internal.taskHostRuntime(state);
  const operation = await queueTaskHostOperation(host, "publish-new", { action: "push", reason: "先交付本轮修复" });
  await finishTaskHostOperation(host);
  assert.equal(state.summary.delivery.git_push.sha, operation.sha);
  assert.equal(state.summary.delivery.sha, operation.sha);
  assert.equal(state.summary.delivery.pipeline, undefined);
  await triggerPipeline({ platformUrl: platform.baseUrl, repo: platform.barePath, sha: operation.sha! });
  const runs = platform.pipelines.length;
  state.mission = undefined; state.summary.status = "verifying";
  if (restart) {
    // 模拟旧版本只写 git_push，验证 SHA 和红灯仍停在第一次失败。
    state.summary.delivery.sha = old;
    state.summary.delivery.pipeline = "failed";
    state.summary.delivery.prepush = { state: "preparing", sha: old,
      active_attempt: { id: "interrupted-old-attempt", started_at: new Date().toISOString() } };
    internal.persist(state);
    await service.shutdown();
    internal = buildService(platform, dataDir, {}, { pollIntervalMs: 100_000 });
    internal.options.maxConcurrent = 0;
    t.after(() => internal.shutdown());
  }
  let replayedPush = 0, repair = 0;
  internal.pushFromHost = async () => { replayedPush++; throw new Error("不应重复推送"); };
  internal.enqueueRepair = () => { repair++; };
  if (restart) {
    internal.recover();
    state = internal.tasks.get(task.id);
    await until(() => state.summary.status === "await_merge", "重启后核销旧批次", 15_000);
  } else await internal.tryDeliver(state, state.controlEpoch);
  assert.equal(replayedPush, 0);
  assert.equal(platform.pipelines.length, runs);
  assert.equal(repair, 0);
  assert.equal(state.summary.status, "await_merge", JSON.stringify(state.summary.delivery));
  assert.match(state.summary.delivery.attested, /^PASS/);
});
