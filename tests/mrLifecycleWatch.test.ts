import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { TaskService } from "../src/taskService.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.ok(check(), "监听应及时发现远端合入，不等 Agent 收轮");
}
async function fixture(t: TestContext) {
  const remote = { state: "opened", requests: [] as string[] };
  const server = createServer((req, res) => {
    remote.requests.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ mr_state: remote.state, sha: "human-merged-sha",
      gates: [{ name: "ci_state_passed", passed: false }] }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const options = {
    dataDir: mkdtempSync(join(tmpdir(), "mfc-mr-lifecycle-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    delivery: { platformUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, pollIntervalMs: 30 },
  };
  const services: TaskService[] = [];
  const create = () => { const s = new TaskService(options); services.push(s); return s; };
  const service = create();
  const id = service.create("持续修复中的人工合入").id;
  const task = (service as any).tasks.get(id);
  task.summary.status = "verifying";
  task.summary.delivery = { mr_id: 420, mr_url: "https://codehub.test/repo/merge_requests/420",
    source_branch: "feature", target_branch: "main", sha: "old-failed-sha",
    pipeline: "failed", loop: { state: "repairing", round: 3 } };
  t.after(async () => {
    for (const s of services) await s.shutdown();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  });
  return { service, task, remote, create, id };
}

test("旧 MR 未绿也启动监听：后续修复和 epoch 换轮期间人工合入立即抢占", async t => {
  const { service, task, remote } = await fixture(t);
  // 走真正的交付入口，不能在测试中手工调用 watchMerge 来掩盖漏启动。
  await (service as any).tryDeliver(task, task.controlEpoch);
  task.summary.status = "running";
  task.controlEpoch += 1;
  const stopped: string[] = [];
  task.driver = { abort: async () => { stopped.push("agent"); }, dispose() {} };
  task.container = { stop: async () => { stopped.push("container"); } };
  task.prepushActive = new Promise<void>(resolve => {
    task.prepushAbort = { abort: () => { stopped.push("build-fix"); resolve(); } };
  });
  remote.state = "merged";
  await until(() => task.summary.status === "completed");
  assert.deepEqual(stopped.sort(), ["agent", "build-fix", "container"]);
  assert.equal(task.summary.delivery.pipeline, "failed");
  assert.equal(task.summary.delivery.sha, "old-failed-sha");
  assert.equal(task.summary.delivery.merged_sha, "human-merged-sha");
  assert.equal(task.summary.delivery.loop.state, "merged");
  assert.ok(remote.requests.every(r => r.startsWith("GET /mr/gates?") && r.includes("mr=420")));
});

for (const status of ["running", "queued", "verifying", "waiting_for_human", "failed", "paused"]) {
  test(`重启恢复 ${status} 的红灯 MR，只有 MR id 也能发现人工合入`, async t => {
    const { service, task, remote, create, id } = await fixture(t);
    task.summary.status = status;
    task.summary.delivery.stalled = "旧流水线未通过";
    delete task.summary.delivery.mr_url;
    delete task.summary.delivery.source_branch;
    delete task.summary.delivery.target_branch;
    (service as any).persist(task);
    await service.shutdown();
    const revived = create();
    assert.equal(revived.recover().restored, 1);
    const restored = (revived as any).tasks.get(id);
    await until(() => remote.requests.length > 0);
    assert.notEqual(restored.summary.status, "completed", "红灯本身不自动完成或派重复修复");
    remote.state = "merged";
    await until(() => restored.summary.status === "completed");
    assert.equal(restored.summary.delivery.pipeline, "failed");
    assert.equal(restored.summary.delivery.merged_sha, "human-merged-sha");
  });
}

for (const status of ["completed", "canceled"]) {
  test(`恢复 ${status} 任务不启动 MR 监听`, async t => {
    const { service, task, remote, create } = await fixture(t);
    task.summary.status = status;
    (service as any).persist(task);
    await service.shutdown();
    const revived = create();
    revived.recover();
    await new Promise(r => setTimeout(r, 100));
    assert.equal(remote.requests.length, 0);
  });
}

test("交付检查与监听同时发现 merged，只停止和登记一次", async t => {
  const { service, task, remote } = await fixture(t);
  await (service as any).tryDeliver(task, task.controlEpoch);
  let stopCount = 0;
  let release!: () => void;
  task.driver = { abort: () => { stopCount += 1; return new Promise<void>(r => { release = r; }); }, dispose() {} };
  remote.state = "merged";
  const closing = (service as any).existingMergeRequestAllowsDelivery(task, task.controlEpoch);
  await until(() => stopCount === 1 && remote.requests.length >= 3);
  assert.equal(task.summary.status, "verifying");
  assert.equal(stopCount, 1);
  release();
  await closing;
  await until(() => task.summary.status === "completed");
  assert.equal(stopCount, 1);
});

test("真实 Git/内核：首轮流水线失败且自动修复关闭，人工合入仍完成 close", async t => {
  const { FakeGitPlatform } = await import("../src/gitPlatform.ts");
  const { makeSourceRepo, runTask } = await import("./delivery.helpers.ts");
  const { readFileSync } = await import("node:fs");
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-mr-red-")));
  platform.nextPipelineStatus = "failed";
  await platform.start();
  t.after(() => platform.stop());
  const { service, task } = await runTask(platform, true, { pollIntervalMs: 30, repairRounds: 0 });
  t.after(() => service.shutdown());
  assert.equal(task.status, "verifying");
  assert.match(task.delivery?.pipeline ?? "", /failed/);
  const oldSha = task.delivery!.sha;
  platform.settleMr("master_bot_REQ9", "merged");
  await until(() => service.get(task.id)?.status === "completed");
  const completed = service.get(task.id)!;
  assert.equal(completed.delivery!.sha, oldSha);
  assert.equal(completed.delivery!.merged_sha, oldSha);
  assert.match(completed.delivery!.pipeline ?? "", /failed/);
  const internal = (service as any).tasks.get(task.id);
  const kernelState = JSON.parse(readFileSync(join(internal.cwd, ".mae-flow.json"), "utf8"));
  assert.equal(kernelState.current, "end", "必须由可信 close 完成内核登记");
});

for (const action of ["cancel", "replace"] as const) {
  test(`MR 查询在途时 ${action}，迟到的合入结果不能改写取消或重跑任务`, async t => {
    const { service, task, id } = await fixture(t);
    await (service as any).tryDeliver(task, task.controlEpoch);
    let reply!: (view: unknown) => void;
    (service as any).fetchGates = () => new Promise(r => { reply = r; });
    await until(() => Boolean(reply));
    if (action === "cancel") task.summary.status = "canceled";
    else (service as any).tasks.set(id, { ...task, summary: { ...task.summary, delivery: undefined, status: "queued" } });
    reply({ mrState: "merged", sourceSha: "human-merged-sha", gates: [] });
    await until(() => !task.mergeWatchActive);
    assert.notEqual(task.summary.status, "completed");
    assert.equal((service as any).tasks.get(id).summary.status, action === "cancel" ? "canceled" : "queued");
  });
}

for (const status of ['running', 'paused', 'await_merge']) {
  test(`${status} 持续收集远端意见，门禁绿灯也不能掩盖未解决讨论`, async t => {
    const { service, task, remote } = await fixture(t);
    const { FeedbackStore } = await import('../src/feedbackStore.ts');
    task.summary.status = status;
    task.summary.delivery.sha = 'human-merged-sha';
    (service as any).fetchGates = async () => ({ mrState: remote.state, sourceSha: 'human-merged-sha',
      gates: [{ name: 'resolve_discussion_passed', passed: true }] });
    (service as any).fetchDiscussions = async () => ({ kind: 'available', items: [
      { id: 'd1', body: '补齐实现' }, { id: 'd2', body: '实现下载接口' }] });
    let dispatched = 0;
    (service as any).dispatchReviewRepair = async (_task: unknown, _max: unknown, _epoch: unknown, snapshot: any) => {
      assert.equal(snapshot.items.length, 2);
      dispatched++;
      task.summary.status = 'running';
      return 'dispatched';
    };
    (service as any).ensureMergeWatch(task);
    const store = new FeedbackStore(join(task.summary.workspace, 'feedback', 'index.jsonl'));
    await until(() => store.list().length === 2);
    assert.ok(store.list().every(r => r.status === 'open'));
    assert.equal(dispatched, status === 'await_merge' ? 1 : 0);
    remote.state = 'merged';
    await until(() => task.summary.status === 'completed');
  });
}

test('监听一拍抛异常后仍继续，下一拍外部合入能正常收口', async t => {
  const { service, task, remote } = await fixture(t);
  let attempts = 0;
  (service as any).flushReviewReplyOutbox = async () => {
    if (++attempts === 1) throw new Error('临时投递异常');
    return true;
  };
  (service as any).ensureMergeWatch(task);
  await until(() => attempts >= 2);
  assert.equal(task.mergeWatchActive, true);
  remote.state = 'merged';
  await until(() => task.summary.status === 'completed');
});

test('自动修复关闭仍同步新讨论；不派 Agent，也不停止合入监听', async t => {
  const { service, task, remote } = await fixture(t);
  const { FeedbackStore } = await import('../src/feedbackStore.ts');
  task.summary.status = 'await_merge';
  task.summary.delivery.sha = 'human-merged-sha';
  (service as any).repairBudget = () => 0;
  (service as any).fetchGates = async () => ({ mrState: remote.state, sourceSha: 'human-merged-sha', gates: [] });
  (service as any).fetchDiscussions = async () => ({ kind: 'available', items: [{ id: 'disabled', body: '补实现' }] });
  (service as any).dispatchReviewRepair = () => { assert.fail('关闭自动修复时不能派单'); };
  (service as any).ensureMergeWatch(task);
  await until(() => new FeedbackStore(join(task.summary.workspace, 'feedback', 'index.jsonl')).list().length === 1);
  assert.equal(task.summary.status, 'await_merge');
  assert.match(task.summary.delivery.waiting_on, /自动/);
  remote.state = 'merged';
  await until(() => task.summary.status === 'completed');
});
