import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { buildService, makeSourceRepo, git, until, walkScript } from "./delivery.helpers.ts";
import { managedFlowFixture } from "./support/managedFlowFixture.ts";

test("真实会话收口先持久化宿主交接，已有推送无需再派 Agent 即创建 MR 并验证", async t => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-handoff-remote-")));
  await platform.start(); t.after(() => platform.stop());
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-handoff-"));
  const prepare = managedFlowFixture(dataDir, { continuousReview: true });
  let service: ReturnType<typeof buildService>, task: any, stopping = false;
  let release!: () => void;
  const stopped = new Promise<void>(resolve => { release = resolve; });
  const model = new ScriptedModelServer(walkScript(), "scripted-v1", {
    beforeScene(context) {
      prepare(context);
      if (context.index !== 1) return;
      task = [...(service as any).tasks.values()][0];
      const branch = git(task.cwd, "branch", "--show-current");
      const sha = git(task.cwd, "rev-parse", "HEAD");
      // 可信夹具准备“用户已通过另一入口实际推送”的现场；后续不调用
      // tryDeliver，也不替生产代码预设 verifying，由真实回合结束接续。
      git(task.cwd, "push", platform.barePath, `HEAD:refs/heads/${branch}`);
      task.summary.delivery = { git_push: { sha, ref: `refs/heads/${branch}`, remote: "origin", url: platform.barePath }, sha };
      task.container = { stop: () => { stopping = true; return stopped; } };
    },
  });
  await model.start(); t.after(() => model.stop());
  service = buildService(platform, dataDir, model.modelsJson());
  t.after(async () => { release(); await service.shutdown(); });
  const created = service.create("task-5 已推送后接续验证", { ticket: "REQ9" });
  await until(() => stopping, "真实回合结束并开始容器回收");
  const file = join(task.summary.workspace, "task.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.summary.status, "verifying", "容器停机的等待期间不能继续显示 Agent 正在运行");
  assert.match(saved.summary.detail, /交接宿主/);
  assert.match(readFileSync(join(task.summary.workspace, "events.jsonl"), "utf8"), /turn_finished/);
  release();
  await until(() => service.get(created.id)?.status === "await_merge", "自动创建 MR 并核销流水线");
  assert.equal(platform.mergeRequests.length, 1); assert.equal(platform.pipelines.length, 1);
  assert.equal(service.get(created.id)?.delivery?.git_push?.sha, platform.pipelines[0].sha);
});

test("恢复 external_verify + running 旧现场直接接续交付，不重新启动编码会话", async t => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-handoff-recovery-remote-")));
  await platform.start(); t.after(() => platform.stop());
  const { runTask } = await import("./delivery.helpers.ts");
  const original = await runTask(platform, true);
  await original.service.shutdown();
  const path = join(original.task.workspace, "task.json");
  const disk = JSON.parse(readFileSync(path, "utf8"));
  const statePath = join(disk.cwd, ".mae-flow.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.current = "external_verify";
  writeFileSync(statePath, JSON.stringify(state));
  disk.summary.status = "running"; disk.summary.detail = "决定已收到，Agent 正在继续处理";
  disk.summary.waiting = undefined;
  disk.summary.delivery = { sha: disk.summary.delivery.git_push.sha, git_push: disk.summary.delivery.git_push };
  writeFileSync(path, JSON.stringify(disk));
  const recovered = buildService(platform, original.dataDir, {});
  (recovered as any).options.maxConcurrent = 0;
  t.after(() => recovered.shutdown());
  recovered.recover();
  await until(() => recovered.get(original.task.id)?.status === "await_merge", "旧 running 快照恢复宿主验证");
  assert.equal(platform.mergeRequests.length, 1);
  assert.equal(platform.pipelines.length, 1, "复用真实同 SHA 流水线，不重复触发");
  assert.equal((recovered as any).queue.includes(original.task.id), false);
  await recovered.shutdown();
  // 当前内核仍可能停在外部验证，但责任人已换了目标：不能借恢复交付
  // 清掉新使命。只对无待办使命的旧 running 快照做自动交接。
  disk.summary.status = "queued";
  disk.mission = "先按责任人新要求调整查询接口，暂不继续交付";
  writeFileSync(path, JSON.stringify(disk));
  writeFileSync(statePath, JSON.stringify(state));
  const redirected = buildService(platform, original.dataDir, {});
  (redirected as any).options.maxConcurrent = 0;
  t.after(() => redirected.shutdown());
  redirected.recover();
  assert.equal(redirected.get(original.task.id)?.status, "queued");
  assert.equal((redirected as any).tasks.get(original.task.id).mission, disk.mission);
  assert.equal((redirected as any).queue.includes(original.task.id), true);
});
