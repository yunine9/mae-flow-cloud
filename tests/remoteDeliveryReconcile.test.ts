import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { makeSourceRepo, runTask, git, buildService, until } from "./delivery.helpers.ts";

for (const restart of [false, true]) test(`MR 和收据全部丢失，${restart ? "重启" : "主动刷新"}发现已合入并收口，不推送不派 Agent`, async t => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "remote-reconcile-")));
  await platform.start(); t.after(() => platform.stop());
  const run = await runTask(platform, true, { pollIntervalMs: 100_000 });
  let service: any = run.service; t.after(() => service.shutdown());
  service.options.maxConcurrent = 0;
  let task = service.tasks.get(run.task.id);
  const mr = platform.mergeRequests[0];
  platform.settleMr(mr.source_branch, "merged");
  // 内核已有 delivery_watch；宿主投影丢失，甚至本地还有未发布的新提交。
  writeFileSync(join(task.cwd, "a.txt"), "local unpushed change\n");
  git(task.cwd, "add", "a.txt"); git(task.cwd, "commit", "-qm", "local work");
  task.summary.delivery = restart ? { git_push: {} } : {}; task.summary.status = "waiting_for_human"; task.mission = undefined;
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
  assert.notEqual(task.summary.delivery.git_push?.sha, git(task.cwd, "rev-parse", "HEAD").trim());
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
  await assert.rejects(() => api.refreshRemoteDelivery(task.summary.id, "not-owner"), /责任人/);
});
