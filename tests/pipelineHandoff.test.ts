import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";
import { confirmedPipelineRun, historicalPipelineFeedback } from "../src/pipelineHandoff.ts";

test("流水线触发和恢复查询只采信指定 SHA，拒绝陈灯及空查询", () => {
  assert.equal(confirmedPipelineRun("new", { status: "failed", runs: [
    { sha: "new", status: "running" }, { sha: "old", status: "failed" },
  ] }).status, "running");
  for (const result of [ { status: "failed", sha: "old" }, { status: "success", sha: "new", is_valid: false }, { status: "running", runs: [] } ] as const) {
    assert.throws(() => confirmedPipelineRun("new", result as any), /有效流水线/);
  }
});

for (const status of ["running", "success", "failed"] as const) test(`宿主接收新 SHA ${status}：旧使命退出，事实保留，交给现有验证裁决`, async () => {
  const service: any = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "pipeline-handoff-")), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const task = service.create("验证新修复", { account: "owner" });
  const state = service.tasks.get(task.id);
  state.mission = "修复 old 的告警";
  state.summary.status = "running";
  state.summary.delivery = { sha: "old", pipeline: "failed", checks: [{ dimension: "COMPILE", status: "failed" }],
    loop: { kind: "ci", round: 1, state: "repairing", last_sha: "old", failure: "旧失败原文" },
    git_push: { sha: "new", ref: "refs/heads/work", remote: "origin" } };
  const routed: unknown[] = [];
  service.ensureMergeWatch = () => {};
  service.pollPipeline = async (_task: unknown, epoch: number) => { routed.push(["poll", epoch]); };
  service.pipelineVerdict = async (_task: unknown, sha: string, status: string, log: string) => { routed.push([sha, status, log]); };
  await service.acceptPipelineRun(state, "new", { status, log: "新运行记录" }, state.controlEpoch);
  assert.equal(state.mission, undefined);
  assert.equal(state.summary.delivery.sha, "new");
  assert.equal(state.summary.delivery.pipeline, status);
  assert.equal(state.summary.delivery.checks, undefined, "不能把旧检查结果挂到新 SHA");
  assert.equal(state.summary.delivery.loop.last_sha, "old");
  assert.equal(state.summary.delivery.loop.failure, "旧失败原文");
  assert.equal(state.summary.delivery.loop.state, "verifying");
  assert.deepEqual(routed, status === "running" ? [["poll", state.controlEpoch]] : [["new", status, "新运行记录"]]);
  assert.equal(JSON.parse(readFileSync(join(task.workspace, "task.json"), "utf8")).mission, undefined);
  assert.equal(historicalPipelineFeedback(state.summary, { source: "pipeline", observed_sha: "old" }), true);
  assert.equal(historicalPipelineFeedback(state.summary, { source: "pipeline", observed_sha: "new" }), false);
  assert.equal(historicalPipelineFeedback(state.summary, { source: "workspace", observed_sha: "old" }), false);
});

test("同 SHA 会话换代后新轮询接棒，旧轮询退出不能清掉新标记", async t => {
  const { createServer } = await import("node:http");
  let queries = 0;
  const server = createServer((_req, res) => { queries++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ runs: [{ sha: "new", status: "running" }] })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const service: any = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "pipeline-epoch-")), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    delivery: { platformUrl: `http://127.0.0.1:${(server.address() as any).port}`, pollIntervalMs: 5 } });
  const task = service.create("验证", { account: "owner" });
  const state = service.tasks.get(task.id);
  state.summary.status = "verifying"; state.summary.delivery = { sha: "new", pipeline: "running" };
  const oldPoll = service.pollPipeline(state, state.controlEpoch);
  state.controlEpoch++;
  const newPoll = service.pollPipeline(state, state.controlEpoch);
  await oldPoll;
  assert.equal(state.pipelinePollEpoch, state.controlEpoch);
  const deadline = Date.now() + 2000;
  while (!queries && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(queries > 0);
  state.summary.status = "completed";
  await newPoll;
  assert.equal(state.pipelinePollSha, undefined);
});

test("新验证接棒后，旧流水线批次不再生成回执补交任务；历史原文不改写", async () => {
  const { writeFileSync } = await import("node:fs");
  const service: any = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "pipeline-history-")), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const summary = service.create("处理补充要求");
  const state = service.tasks.get(summary.id);
  state.cwd = summary.workspace;
  service.options.host = { continuousReview: true };
  state.summary.delivery = { sha: "new", pipeline: "running", git_push: { sha: "new", ref: "work", remote: "origin" } };
  const file = join(summary.workspace, ".mae-flow.json");
  const original = JSON.stringify({ delivery_loop: { active_batch_id: "old-batch", batches: [{ batch_id: "old-batch", base_sha: "old", items: [{ id: "pipeline:old:COMPILE", source: "pipeline", source_id: "old:COMPILE", summary: "旧告警" }] }] } });
  writeFileSync(file, original);
  assert.equal(service.activeFeedbackResult(state), undefined);
  assert.equal(service.recordActiveFeedbackResult(state), undefined);
  assert.equal(readFileSync(file, "utf8"), original);
});
