/**
 * 跑动中插话(本地 CLI 的 ESC 在云端的等价物)。
 *
 * 契约只有一条,但它是硬的:**人说的话一定会送到模型**。
 * 无论插话撞上的是"模型正在跑工具"(pi 的 steer 直送)还是"回合刚好
 * 收口"(steer 队列没人取,由宿主取回来补发),结果必须一样——这两条
 * 路都在这里用同一个断言收口,免得哪天只剩一条还以为都好着。
 *
 * 为什么不能只靠 try/catch 兜底:读 pi 源码才发现 steer 从不抛错,
 * 它只是把消息压进内部队列;撞在间隙就静静躺着永远没人送。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";

/** 第一幕故意跑一条慢命令,给插话留出"模型正忙"的窗口。 */
const SCRIPT: Scene[] = [
  { text: "先看一眼现场",
    tool: { name: "bash", input: { command: "sleep 2; echo LOOKED" } } },
  { text: "收到,按你说的办,完成。" },
];

const WAITING_SCRIPT: Scene[] = [
  { tool: { name: "AskUserQuestion",
            input: { questions: [{ question: "通过吗?",
                                   options: ["通过", "打回"] }] } } },
  { text: "完成。" },
];

async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 模型收到的全部用户消息文本(跨请求、跨回合)。 */
function userTexts(model: ScriptedModelServer): string {
  return model.requests
    .flatMap((request) => (request as any).messages ?? [])
    .filter((message: any) => message?.role === "user")
    .map((message: any) => typeof message.content === "string"
      ? message.content
      : (message.content ?? [])
        .map((block: any) => block?.text ?? "").join(" "))
    .join("\n");
}

test("空档期插话会被 pi 悄悄收下不送——宿主必须取得回来", async () => {
  // 这条钉的是坑本身,不是流程:steer 从不抛错,没有回合在跑时它只是
  // 把消息压进内部队列,再也没人送。靠 try/catch 兜底是空想,所以宿主
  // 必须能在收口时把它取回来,而且取走即归我(pi 不会事后又送一遍,
  // 否则模型会收到两遍同一句话)。
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const dir = mkdtempSync(join(tmpdir(), "mfc-steer-unit-"));
  const agentDir = join(dir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"),
                JSON.stringify(model.modelsJson()));
  const session = await CloudSession.create({
    taskId: "T-steer", workspace: dir, agentDir,
    provider: "maeflow", model: "scripted-v1",
    eventLog: new EventLog(join(dir, "events.jsonl")),
    transcript: new TranscriptStore(join(dir, "transcript.jsonl"), "main"),
    gate: new GateService(),
    humanGate: new HumanGate(join(dir, "waiting.json")),
  });
  try {
    // 一个回合都没起过,直接插话——最纯粹的"撞在间隙"。
    await session.steer("插一句:掩码要保留后四位");
    assert.deepEqual(session.takeUndeliveredSteers(),
                     ["插一句:掩码要保留后四位"]);
    assert.deepEqual(session.takeUndeliveredSteers(), [],
                     "取走即归宿主,不能留在 pi 队列里被二次投递");
  } finally {
    session.dispose();
    await model.stop();
  }
});

test("插话与接管边界:暂停不得伪造已读，恢复后必须补送", async () => {
  // 这是“补充给主任务”与“我接管主现场”正面相撞的边界：
  // steer 刚进 Pi 内存队列，主会话就因接管被暂停。队列必须先取回
  // 且持久化；否则旧会话一销毁，读侧还会错把“队列没了”当成“模型已读”。
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-steer-takeover-"));
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), maxConcurrent: 0,
  });
  const id = service.create("接管前的补充不能丢").id;
  const internal = (service as unknown as {
    tasks: Map<string, {
      cwd?: string;
      driver?: CloudSession;
      summary: { id: string; workspace: string; status: string };
      humanGate: HumanGate;
    }>;
  }).tasks.get(id)!;
  internal.cwd = internal.summary.workspace;
  internal.summary.status = "running";
  const agentDir = join(internal.summary.workspace, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"),
    JSON.stringify(model.modelsJson()));
  internal.driver = await CloudSession.create({
    taskId: id,
    workspace: internal.summary.workspace,
    agentDir,
    provider: "maeflow",
    model: "scripted-v1",
    eventLog: new EventLog(join(internal.summary.workspace, "events.jsonl")),
    transcript: new TranscriptStore(
      join(internal.summary.workspace, "transcript.jsonl"), "main"),
    gate: new GateService(),
    humanGate: internal.humanGate,
  });

  try {
    await service.interrupt(id, "这条补充必须在交还后继续处理");
    assert.equal(service.listInterrupts(id)[0]?.delivered, false);
    assert.equal((await service.pause(id, "alice")).status, "pausing");
    await (service as unknown as {
      finishPause(task: unknown, from: "running"): Promise<void>;
    }).finishPause(internal, "running");

    assert.equal(service.get(id)?.status, "paused");
    assert.equal(service.listInterrupts(id)[0]?.delivered, false,
      "旧主会话销毁后，取回的补充仍必须显示待读");
    const saved = JSON.parse(readFileSync(
      join(dataDir, id, "task.json"), "utf-8"));
    assert.deepEqual(saved.pending_main_steers,
      ["这条补充必须在交还后继续处理"]);

    await service.shutdown();
    const recovered = new TaskService({
      dataDir, provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(),
    });
    try {
      assert.equal(recovered.recover().restored, 1);
      assert.equal(recovered.listInterrupts(id)[0]?.delivered, false,
        "服务重启也不得把待读补充变成假回执");
      recovered.resume(id, "alice");
      await until(() => recovered.get(id)?.status === "completed",
        "主任务恢复并消费暂停前补充");
      assert.match(userTexts(model), /这条补充必须在交还后继续处理/);
      assert.equal(recovered.listInterrupts(id)[0]?.delivered, true);
    } finally {
      await recovered.shutdown();
    }
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("插话:发送即打断,话一定送到模型", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-steer-"));
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  // 收尾必须进 finally:断言一旦失败,model.stop() 被跳过,假模型
  // 服务的监听句柄就吊住事件循环——测试子进程退不出去,整个套件就地
  // 挂死且永不超时(2026-08-27 实测挂 46 分钟那种)。失败也要干净退场。
  try {
    const id = service.create("给手机号打码").id;

    // 等模型真的开跑再插话:此刻它正卡在那条慢命令上。
    await until(() => model.requests.length >= 1, "模型收到第一轮请求");
    const summary = await service.interrupt(id, "插一句:掩码要保留后四位");
    assert.equal(summary.id, id);

    await until(() => service.get(id)?.status === "completed", "任务收口");
    assert.match(userTexts(model), /掩码要保留后四位/);
  } finally {
    await service.shutdown();
    await model.stop();
  }
});

test("插话:回合已收口时发出的也不丢(宿主取回来补发)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-steer-late-"));
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const id = service.create("给手机号打码").id;

    // 不等窗口,开跑就插:撞上直送还是撞上间隙由赛跑决定,这里不假装
    // 能控制它——钉的是"无论哪条路,话都得送到"。间隙那条路本身由上面
    // 那条确定性用例单独钉死。
    await until(() => service.get(id) !== undefined, "任务已建");
    let sent = false;
    for (let attempt = 0; attempt < 200 && !sent; attempt += 1) {
      try {
        await service.interrupt(id, "插一句:掩码要保留后四位");
        sent = true;
      } catch {
        // 任务还没进 running,或者已经收口了——前者重试,后者退出。
        if (service.get(id)?.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(sent, "插话应当在任务运行期间被接受");

    await until(() => service.get(id)?.status === "completed", "任务收口");
    assert.match(userTexts(model), /掩码要保留后四位/);
  } finally {
    await service.shutdown();
    await model.stop();
  }
});

test("插话:等人决定时走决定卡,不许开第二个入口", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-steer-wait-"));
  const model = new ScriptedModelServer(WAITING_SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const id = service.create("给手机号打码").id;
    await until(
      () => service.get(id)?.status === "waiting_for_human", "任务等人");

    // 同一件事有两个入口,内核台账上却只认决定那一个——这里必须拒。
    await assert.rejects(
      () => service.interrupt(id, "顺便说一句"),
      /决定卡/);

    const waiting = service.get(id)!.waiting!;
    await service.decide(id, {
      state_version: waiting.state_version, decision: "通过",
    });
    await until(() => service.get(id)?.status === "completed", "任务收口");

    // 收口之后也没有会话可插:如实拒绝,不假装收下。
    await assert.rejects(() => service.interrupt(id, "马后炮"), /没有在跑的会话/);
  } finally {
    await service.shutdown();
    await model.stop();
  }
});

test("插话:空内容与不存在的任务如实拒绝", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-steer-bad-"));
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const id = service.create("给手机号打码").id;
    await assert.rejects(() => service.interrupt(id, "   "), /不能为空/);
    await assert.rejects(() => service.interrupt("task-404", "在吗"), /不存在/);
    await until(() => service.get(id)?.status === "completed", "任务收口");
  } finally {
    await service.shutdown();
    await model.stop();
  }
});

test("插话回执:发过什么、读到没有,都要能查", async () => {
  // "我发了然后就没了,咋知道它消费了没"——发出去没有回执等于对着空气
  // 说话。送达是可观测事实:消息离开 pi 的待送队列 = 已进入模型上下文。
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-steer-log-"));
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const id = service.create("给手机号打码").id;
    await until(() => model.requests.length >= 1, "模型开跑");

    assert.deepEqual(service.listInterrupts(id), [], "没发过就是空的");
    await service.interrupt(id, "掩码保留后四位");
    const logged = service.listInterrupts(id);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].text, "掩码保留后四位");

    assert.deepEqual(logged[0].said, [], "还没说下文就是空的,不许硬凑");

    await until(() => service.get(id)?.status === "completed", "任务收口");
    // 收口之后队列必然空了 = 已读取。落账和收口同拍完成,但立即读会
    // 踩到"已送达未落账"的中间态——那是读的竞态,不是契约破坏,轮询掉。
    await until(() => service.listInterrupts(id)[0]?.delivered === true,
                "插话回执落账");
    await until(() => (service.listInterrupts(id)[0]?.said?.length ?? 0) > 0,
                "下文落账");
    const done = service.listInterrupts(id)[0];
    assert.equal(done.delivered, true);

    // "有时我是问了个问题…我看不到 agent 的回复"(用户 2026-08-22 原话):
    // 只报"已读取"而不给下文,提问就永远没有答案。这里给的是时间顺序上的
    // 下文——刻意不叫"回复",宿主证明不了哪一段是在答你。
    assert.deepEqual(done.said.map((item) => item.text),
      ["收到,按你说的办,完成。"]);
    // 边界:你开口之前它说过的话,不许算到你这条账上。
    assert.ok(!done.said.some((item) => item.text.includes("先看一眼现场")),
      "第一幕的说明发生在插话之前,不是你说完之后的下文");
  } finally {
    await service.shutdown();
    await model.stop();
  }
});
