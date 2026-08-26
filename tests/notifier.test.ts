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
      step: "delivery_review", summary: "Diff 通过吗?",
      link: "http://x/tasks/T-1",
    });
    await until(() => (first.delivered ? true : undefined), "投递完成");
    const again = await notifier.notifyWaiting({
      waitingId: "T-1:c1", taskId: "T-1", account: "liaoxiang",
      step: "delivery_review", summary: "重复投递不应发生",
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

test("清空重跑会同时清除旧通知审批上下文", async () => {
  const notifier = new Notifier({
    endpoint: "http://127.0.0.1:1/unused",
    mobileApproval: true,
    approvalCode: () => "A1B2C3D4E5",
    backoffMs: [],
  });
  await notifier.notifyWaiting({
    waitingId: "T-purge:c1", stateVersion: 1,
    taskId: "T-purge", account: "alice", step: "delivery_review",
    questions: [{ question: "Diff 通过吗？", options: ["通过", "打回"] }],
    link: "http://x/tasks/T-purge",
  });
  assert.equal(notifier.latestApproval("alice")?.waitingId, "T-purge:c1");

  notifier.purgeTask("T-purge");

  assert.equal(notifier.latestApproval("alice"), undefined);
});

test("配置确认通知带出被确认内容；缺内容时禁止裸序号审批", async () => {
  const notifier = new Notifier({
    endpoint: "http://127.0.0.1:1/unused",
    mobileApproval: true,
    approvalCode: () => "A1B2C3D4E5",
    backoffMs: [],
  });
  const complete = await notifier.notifyWaiting({
    waitingId: "T-config:complete", stateVersion: 1,
    taskId: "T-config", account: "alice", step: "config_confirm",
    context: [
      "需求单：REQ-20260826-01",
      "基线：master",
      "交付方式：完整开发 full",
    ].join("\n"),
    questions: [{
      question: "上述完整配置是否正确？",
      options: ["确认以上全部配置", "需要修改"],
    }],
    link: "http://x/work/T-config",
  });
  assert.match(complete.text, /待确认内容：/);
  assert.match(complete.text, /需求单：REQ-20260826-01/);
  assert.match(complete.text, /基线：master/);
  assert.match(complete.text, /交付方式：完整开发 full/);
  assert.match(complete.text, /可直接回复选项序号/);
  assert.equal(notifier.latestApproval("alice")?.waitingId,
    "T-config:complete");

  const missing = await notifier.notifyWaiting({
    waitingId: "T-config:missing", stateVersion: 1,
    taskId: "T-config-2", account: "bob", step: "config_confirm",
    questions: [{
      question: "上述完整配置是否正确？",
      options: ["确认以上全部配置", "需要修改"],
    }],
    link: "http://x/work/T-config-2",
  });
  assert.match(missing.text, /被确认的具体内容没有随审批卡提供/);
  assert.match(missing.text, /已禁止裸序号审批/);
  assert.doesNotMatch(missing.text, /可直接回复选项序号/);
  assert.equal(notifier.latestApproval("bob"), undefined,
    "缺少被确认内容时不能建立裸回复审批上下文");
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
    { text: "待确认配置：兼容旧接口；灰度关闭；观察窗口 30 分钟。",
      tool: { name: "AskUserQuestion", input: { questions: [
      { question: "兼容旧接口吗?", options: ["兼容", "不兼容"] },
      { question: "需要灰度吗?", options: ["需要", "不需要"] },
      { question: "灰度观察多久?", options: ["30 分钟", "2 小时"] },
    ] } } },
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
    assert.match(waitingNotice.text,
      /待确认内容：\n待确认配置：兼容旧接口；灰度关闭；观察窗口 30 分钟/);
    assert.match(waitingNotice.text, /共 3 个问题/);
    assert.match(waitingNotice.text, /问题 1：兼容旧接口吗/);
    assert.match(waitingNotice.text, /问题 2：需要灰度吗/);
    assert.match(waitingNotice.text, /问题 3：灰度观察多久/);
    assert.match(waitingNotice.text, /选项：1\. 30 分钟；2\. 2 小时/);
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
      answers: {
        "兼容旧接口吗?": "兼容",
        "需要灰度吗?": "不需要",
        "灰度观察多久?": "30 分钟",
      },
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
