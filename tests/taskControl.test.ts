import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

test("任务控制:排队任务可暂停、恢复并取消，取消不可被陈旧队列项启动", async () => {
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-control-queued-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const created = service.create("排队控制演练");
  assert.equal(service.get(created.id)?.status, "queued");
  assert.equal((await service.pause(created.id, "alice")).status, "paused");
  assert.equal(service.resume(created.id, "alice").status, "queued");
  assert.equal((await service.cancel(created.id, "alice")).status, "canceled");
  assert.equal(service.get(created.id)?.control?.actor, "alice");
});

test("任务控制:人工节点暂停后恢复到原决定卡", async () => {
  const model = new ScriptedModelServer([
    { tool: { name: "AskUserQuestion", input: {
      questions: [{ question: "继续吗?", options: ["继续", "停止"] }],
    } } },
    { text: "完成。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-control-waiting-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const created = service.create("等待节点控制演练");
    await until(() => service.get(created.id)?.status === "waiting_for_human",
      "进入人工节点");
    const waitingId = service.get(created.id)?.waiting?.waiting_id;
    const paused = await service.pause(created.id, "alice");
    assert.equal(paused.status, "paused");
    assert.equal(paused.waiting?.waiting_id, waitingId, "暂停不丢决定卡");
    const resumed = service.resume(created.id, "alice");
    assert.equal(resumed.status, "waiting_for_human");
    assert.equal(resumed.waiting?.waiting_id, waitingId);
    assert.equal((await service.cancel(created.id, "alice")).status, "canceled");
  } finally {
    await model.stop();
  }
});

test("选择题选项都不合适时，自定义答复作为主答案继续而非强迫选错", async () => {
  const question = "如何处理平台生成的本地文件?";
  const model = new ScriptedModelServer([
    { tool: { name: "AskUserQuestion", input: {
      questions: [{ question, options: ["提交到业务仓", "暂停等用户处理"] }],
    } } },
    { text: "已按用户给出的第三种方式继续。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-control-custom-answer-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const created = service.create("不完整选项自由回复演练");
    await until(() => service.get(created.id)?.status === "waiting_for_human",
      "进入不完整选项卡");
    const waiting = service.get(created.id)!.waiting!;
    await service.decide(created.id, {
      state_version: waiting.state_version,
      selected_options: {},
      free_responses: {
        [question]: "都不提交；写入 .git/info/exclude 后继续",
      },
    });
    await until(() => service.get(created.id)?.status === "completed",
      "自由主答案回注后继续");
  } finally {
    await model.stop();
  }
});

test("任务控制:执行中安全暂停后可续跑，取消后旧回调不能改写终态", async () => {
  const model = new ScriptedModelServer([
    { tool: { name: "bash", input: { command: "sleep 0.35" } } },
    { text: "完成。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-control-running-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), maxConcurrent: 1,
  });
  try {
    const resumable = service.create("执行中暂停演练");
    await until(() => model.requests.length > 0, "模型开始执行");
    const requested = await service.pause(resumable.id, "alice");
    assert.ok(["pausing", "paused"].includes(requested.status));
    await until(() => service.get(resumable.id)?.status === "paused", "安全暂停");
    service.resume(resumable.id, "alice");
    await until(() => service.get(resumable.id)?.status === "completed", "恢复后收口");

    const cancelModel = new ScriptedModelServer([
      { tool: { name: "bash", input: { command: "sleep 0.5" } } },
      { text: "本不应覆盖取消。" },
    ]);
    await cancelModel.start();
    const cancelService = new TaskService({
      dataDir: mkdtempSync(join(tmpdir(), "mfc-control-cancel-")),
      provider: "maeflow", model: "scripted-v1",
      modelsJson: cancelModel.modelsJson(), maxConcurrent: 1,
    });
    try {
      const canceled = cancelService.create("执行中取消演练");
      await until(() => cancelModel.requests.length > 0, "取消任务开始执行");
      assert.equal((await cancelService.cancel(canceled.id, "alice")).status,
        "canceled");
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(cancelService.get(canceled.id)?.status, "canceled",
        "旧的模型回调不得把取消覆盖成完成或失败");
    } finally {
      await cancelModel.stop();
    }
  } finally {
    await model.stop();
  }
});

test("推送前构建暂停先返回处理中，慢容器清理不阻塞控制请求", async () => {
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-control-prepush-pause-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const created = service.create("慢构建暂停反馈");
  const task = (service as any).tasks.get(created.id);
  task.summary.status = "running";
  task.summary.delivery = { prepush: { active_attempt: { id: "attempt-1" } } };
  let releaseStop!: () => void;
  const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
  task.container = { stop: async () => stopGate };

  const requested = await service.pause(created.id, "alice");
  assert.equal(requested.status, "pausing",
    "容器清理仍在等待时，控制请求应立即确认正在暂停");
  assert.equal(service.get(created.id)?.status, "pausing");

  releaseStop();
  await until(() => service.get(created.id)?.status === "paused", "后台安全暂停收口");
});
