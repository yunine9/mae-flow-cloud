/**
 * 小鲁班通知语义(主 spec §9/§14.4):待办投递、失败退避重试且
 * 不改流程状态、同待办不重复通知。假小鲁班收什么记什么。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 50));
  }
}

test("投递成功:待办事实与审批链接送达账号;同待办幂等", async () => {
  const luban = new FakeLubanServer();
  await luban.start();
  try {
    const notifier = new Notifier({ endpoint: luban.endpoint });
    const first = await notifier.notifyWaiting({
      waitingId: "T-1:c1", taskId: "T-1", account: "liaoxiang",
      step: "build_review", summary: "Diff 通过吗?",
      link: "http://x/tasks/T-1",
    });
    await until(() => (first.delivered ? true : undefined), "投递完成");
    const again = await notifier.notifyWaiting({
      waitingId: "T-1:c1", taskId: "T-1", account: "liaoxiang",
      step: "build_review", summary: "重复投递不应发生",
      link: "http://x/tasks/T-1",
    });
    assert.equal(again, first);
    assert.equal(luban.messages.length, 1);
    const message = luban.messages[0] as Record<string, string>;
    assert.equal(message.account, "liaoxiang");
    assert.match(message.text, /等你决定/);
    assert.match(message.text, /Diff 通过吗/);
    assert.equal(message.link, "http://x/tasks/T-1");
  } finally {
    await luban.stop();
  }
});

test("投递失败:有限退避后成功;首败期间不阻塞", async () => {
  const luban = new FakeLubanServer();
  await luban.start();
  luban.failFirst = 2;
  try {
    const notifier = new Notifier({
      endpoint: luban.endpoint, backoffMs: [0, 50, 50],
    });
    const record = await notifier.notifyWaiting({
      waitingId: "T-2:c1", taskId: "T-2", account: "a",
      step: "grill", summary: "问题", link: "http://x/tasks/T-2",
    });
    assert.equal(record.delivered, false); // 返回即未送达:投递在后台
    await until(() => (record.delivered ? true : undefined), "重试后送达");
    assert.equal(record.attempts, 3);
  } finally {
    await luban.stop();
  }
});

test("端到端:任务进入等待即通知;通知死透不改流程,页面可见事实", async () => {
  const SCRIPT: Scene[] = [
    { tool: { name: "AskUserQuestion",
              input: { questions: [{ question: "通过吗?",
                                     options: ["通过", "打回"] }] } } },
    { text: "收口" },
  ];
  const luban = new FakeLubanServer();
  await luban.start();
  luban.failFirst = 99; // 永远失败:验证 §14.4 通知失败不改变流程状态
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  try {
    const notifier = new Notifier({
      endpoint: luban.endpoint, backoffMs: [0, 30],
    });
    const service = new TaskService({
      dataDir: mkdtempSync(join(tmpdir(), "mfc-notify-")),
      provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(),
      notifier,
      linkBase: "http://127.0.0.1:8787",
    });
    const created = service.create("交付 NT-1", { account: "liaoxiang" });
    const waiting = await until(() => {
      const task = service.get(created.id)!;
      return task.status === "waiting_for_human" ? task : undefined;
    }, "进入等待");
    const waitingNotice = await until(
      () => notifier.list()[0],
      "待办通知入账",
    );
    assert.equal(
      waitingNotice.link,
      `http://127.0.0.1:8787/work/${created.id}`,
      "通知应直达有稳定地址的任务工作台",
    );
    // 通知死透:流程仍在等待,决定照常可提交,页面拿得到失败事实。
    const failed = await until(() => {
      const task = service.get(created.id)!;
      return task.notify && task.notify.attempts >= 2
        && !task.notify.delivered ? task : undefined;
    }, "通知重试耗尽");
    assert.equal(failed.status, "waiting_for_human");
    assert.match(failed.notify!.last_error, /HTTP 500/);
    await service.decide(created.id, {
      state_version: waiting.waiting!.state_version,
      decision: "通过",
    });
    const done = await until(() => {
      const task = service.get(created.id)!;
      return task.status === "completed" ? task : undefined;
    }, "收口");
    assert.equal(done.luban_account, "liaoxiang");
  } finally {
    await model.stop();
    await luban.stop();
  }
});

test("收口通知:完成/交付说人话送达;同任务同状态幂等", async () => {
  const luban = new FakeLubanServer();
  await luban.start();
  try {
    const notifier = new Notifier({ endpoint: luban.endpoint });
    const first = await notifier.notifyOutcome({
      taskId: "T-2", account: "liaoxiang", status: "await_merge",
      summary: "已提合入请求,流水线通过,等待合入:http://git/mr/1",
      link: "http://x/tasks/T-2",
    });
    await until(() => (first.delivered ? true : undefined), "投递完成");
    const again = await notifier.notifyOutcome({
      taskId: "T-2", account: "liaoxiang", status: "await_merge",
      summary: "重复收轮不应重复通知",
      link: "http://x/tasks/T-2",
    });
    assert.equal(again, first);
    assert.equal(luban.messages.length, 1);
    const message = luban.messages[0] as Record<string, string>;
    assert.match(message.text, /任务 T-2/);
    assert.match(message.text, /等待合入/);
    assert.match(message.text, /http:\/\/git\/mr\/1/);
  } finally {
    await luban.stop();
  }
});
