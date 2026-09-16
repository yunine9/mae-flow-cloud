import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { makeSourceRepo, runTask, git, buildService, deliveryModel, until } from "./delivery.helpers.ts";

for (const restart of [false, true]) test(`MR 投影丢失但保留本任务推送收据，${restart ? "重启" : "主动刷新"}发现已合入并收口，不推送不派 Agent`, async t => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "remote-reconcile-")));
  await platform.start(); t.after(() => platform.stop());
  const run = await runTask(platform, true, { pollIntervalMs: 100_000 });
  let service: any = run.service; t.after(() => service.shutdown());
  service.options.maxConcurrent = 0;
  let task = service.tasks.get(run.task.id);
  const mr = platform.mergeRequests[0];
  platform.settleMr(mr.source_branch, "merged");
  // 本任务确已推送此版本；恢复不能仅凭同名分支认领。
  const receipt = task.summary.delivery.git_push;
  task.summary.delivery = { git_push: receipt }; task.summary.status = "waiting_for_human"; task.mission = undefined;
  const waiting = task.humanGate.createWaiting({ taskId: task.summary.id, step: "cloud_push_confirm", callId: "stale-push", questionInput: {
    questions: [{ question: "是否推送？", options: ["确认", "先调整"], recommended: "先调整" }] } });
  task.summary.waiting = waiting;
  service.persist(task);
  let pushes = 0;
  if (restart) {
    await service.shutdown(); service = buildService(platform, run.dataDir, {}, { pollIntervalMs: 100_000 });
    service.options.maxConcurrent = 0;
    service.pushFromHost = async () => { pushes++; throw new Error("不应推送"); };
    service.recover(); task = service.tasks.get(run.task.id);
    await until(() => task.summary.status === "completed", "恢复后按平台合入收口", 15_000);
  } else {
    service.pushFromHost = async () => { pushes++; throw new Error("不应推送"); };
    await service.refreshRemoteDelivery(task.summary.id, task.summary.luban_account);
  }
  assert.equal(task.summary.status, "completed"); assert.equal(pushes, 0);
  assert.equal(task.summary.delivery.mr_url, mr.url);
  assert.equal(task.summary.delivery.merged_sha, mr.sha);
  assert.equal(task.summary.waiting, undefined);
  assert.equal(task.humanGate.get(waiting.waiting_id).status, "superseded");
  assert.equal(task.summary.delivery.git_push?.sha, git(task.cwd, "rev-parse", "HEAD").trim());
  assert.equal(JSON.parse(readFileSync(join(task.cwd, ".mae-flow.json"), "utf8")).current, "end");
});

test("已发布当前 HEAD 可补收据；本地新 HEAD 不冒充发布，多 MR 不猜选", async t => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "remote-push-")));
  await platform.start(); t.after(() => platform.stop());
  const { service, task: summary } = await runTask(platform, true, { pollIntervalMs: 100_000 });
  t.after(() => service.shutdown()); const api: any = service;
  const task = api.tasks.get(summary.id); api.options.maxConcurrent = 0;
  const sha = task.summary.delivery.sha; task.summary.delivery = {}; task.summary.status = "paused";
  const first = await api.refreshRemoteDelivery(task.summary.id, task.summary.luban_account);
  assert.match(first.message, /已在远端/); assert.equal(task.summary.delivery.git_push.sha, sha);
  assert.equal(task.summary.status, "paused", "查到 opened 不自动恢复暂停任务");
  writeFileSync(join(task.cwd, "a.txt"), "not pushed\n"); git(task.cwd, "add", "a.txt"); git(task.cwd, "commit", "-qm", "new local");
  task.summary.delivery = {};
  assert.match((await api.refreshRemoteDelivery(task.summary.id, task.summary.luban_account)).message, /不同/);
  assert.equal(task.summary.delivery.git_push, undefined);
  task.summary.delivery = {};
  platform.mergeRequests.push({ ...platform.mergeRequests[0], id: 999, url: platform.baseUrl + "/mr/999" });
  const multiple = await api.refreshRemoteDelivery(task.summary.id, task.summary.luban_account);
  assert.equal(multiple.candidates.length, 2); assert.equal(task.summary.delivery.mr_url, undefined);
  await assert.rejects(() => api.refreshRemoteDelivery(task.summary.id, "not-owner"), /责任人.*管理员/);
  const admin = await api.refreshRemoteDelivery(task.summary.id, "team-admin", undefined, { administrator: true });
  assert.equal(admin.candidates.length, 2, "管理员可以为任意责任人的任务触发远端核验");
});

test("同分支兄弟任务的历史 MR 不被继承；已污染 MR 标识也不能关闭本地新提交", async t => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "remote-sibling-")));
  await platform.start(); t.after(() => platform.stop());
  const { service, task: summary } = await runTask(platform, true, { pollIntervalMs: 100_000 });
  t.after(() => service.shutdown()); const api: any = service;
  api.options.maxConcurrent = 0;
  const task = api.tasks.get(summary.id);
  const mr = platform.mergeRequests[0];
  platform.settleMr(mr.source_branch, "merged");
  writeFileSync(join(task.cwd, "a.txt"), "new sibling delivery\n");
  git(task.cwd, "add", "a.txt"); git(task.cwd, "commit", "-qm", "new sibling delivery");
  task.summary.delivery = {}; task.summary.status = "paused";
  await api.refreshRemoteDelivery(task.summary.id, task.summary.luban_account);
  assert.equal(task.summary.delivery.mr_id, undefined, "同名分支不是本任务归属证据");
  assert.notEqual(task.summary.status, "completed");
  task.summary.delivery = { mr_id: mr.id, mr_url: mr.url, source_branch: mr.source_branch, target_branch: mr.target_branch };
  await api.refreshRemoteDelivery(task.summary.id, task.summary.luban_account);
  assert.notEqual(task.summary.status, "completed", "旧版本已经误绑的 MR 也不能关闭新代码");
  assert.match(task.summary.detail, /未确认包含当前本地提交/);
  assert.notEqual(JSON.parse(readFileSync(join(task.cwd, ".mae-flow.json"), "utf8")).current, "end");
  assert.equal(readFileSync(join(task.cwd, "a.txt"), "utf8"), "new sibling delivery\n");
});


test("同仓同 AR 串行接力：第二轮独立推送并创建新 MR，不能复用上一轮合入结果", async t => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "remote-serial-")));
  await platform.start(); t.after(() => platform.stop());
  const first = await runTask(platform, true, { pollIntervalMs: 100_000 });
  t.after(() => first.service.shutdown());
  const oldMr = platform.mergeRequests[0];
  git(platform.barePath, "update-ref", "refs/heads/master", oldMr.sha);
  oldMr.merge_state = "merged";
  await first.service.refreshRemoteDelivery(first.task.id);
  assert.equal(first.service.get(first.task.id)!.status, "completed");
  await first.service.shutdown();

  const dataDir = mkdtempSync(join(tmpdir(), "remote-serial-next-"));
  const model = deliveryModel([
    { tool: { name: "bash", input: { command: "echo second-unit > second.txt" } } },
    { text: "第二个串行单元完成。" },
  ], dataDir);
  await model.start(); t.after(() => model.stop());
  const service = buildService(platform, dataDir, model.modelsJson(), { pollIntervalMs: 100_000 });
  t.after(() => service.shutdown());
  const next = service.create("交付 REQ9:第二个串行单元", { ticket: "REQ9" });
  await until(() => service.get(next.id)!.status === "await_merge", "第二轮独立 MR 等待合入");
  assert.equal(platform.mergeRequests.length, 2);
  const mr = platform.mergeRequests[1];
  assert.equal(mr.source_branch, oldMr.source_branch);
  assert.notEqual(mr.id, oldMr.id);
  assert.notEqual(mr.sha, oldMr.sha);
  assert.equal(service.get(next.id)!.delivery?.mr_id, mr.id);
  assert.equal(git(platform.barePath, "show", `${mr.sha}:second.txt`), "second-unit");
  mr.merge_state = "merged";
  git(platform.barePath, "update-ref", "refs/heads/master", mr.sha);
  await service.refreshRemoteDelivery(next.id);
  assert.equal(service.get(next.id)!.status, "completed");
  assert.equal(service.get(next.id)!.delivery?.merged_sha, mr.sha);
});
