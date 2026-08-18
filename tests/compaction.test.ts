/**
 * 主动压缩语义(用户关切:长编码阶段注意力漂移):
 * - 事件量过阈值后,回合间隙触发 compact,摘要请求真实走到模型
 *   (剧本假模型扮演摘要方,回合链不断);
 * - 阈值未到不压;压缩失败 fail-open 流程照走(红线);
 * - 触发点只在 turn_finished——等待人工时绝不压(会打断挂起节点)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { looksLikeContextOverflow } from "../src/sessionDriver.ts";
import { TaskService } from "../src/taskService.ts";

async function until(
  probe: () => boolean, what: string, timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 50));
  }
}

test("事件量过阈值 → 回合间隙触发压缩;小会话被拒也不伤流程", async () => {
  // 剧本会话很小,pi 会以 "session too small" 拒压——这不是失败,
  // 是 fail-open 语义的一部分:触发点必须对(turn_finished),
  // 拒压必须无害(任务照常收口)。压缩真正生效的验证在真模型
  // 试跑里(pilot --compact-every,现场日志可见"主动压缩完成")。
  const script: Scene[] = [
    { text: "干了一堆活",
      tool: { name: "bash", input: { command: "echo 干活" } } },
    { text: "收工。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const logs: string[] = [];
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-compact-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    compactEveryEvents: 1,          // 一到间隙就该触发
    log: (message) => logs.push(message),
  });
  try {
    const created = service.create("演练:压缩不打断流程");
    await until(() =>
      service.get(created.id)!.status === "completed", "任务收口");
    assert.ok(
      logs.some((line) => line.includes("主动压缩")),
      `压缩没被触发,日志: ${logs.join(" | ")}`);
  } finally {
    await model.stop();
  }
});

test("超限判据:认内网/各家网关的原文,别的错误一概不认", () => {
  // 判据宁可漏判也不许误判:把普通错误当超限去压缩,等于拿真错误
  // 当噪声吞掉。内网网关的原文是这条链上唯一见过的真样本,钉死。
  assert.ok(looksLikeContextOverflow(
    "CREATE INFERENCE REQ FAILED: Exception('input too long, exceed max "
    + "input length, max input length is 169984, current input length is "
    + "171308')"), "内网网关原文必须认");
  assert.ok(looksLikeContextOverflow("prompt is too long: 210000 tokens"));
  assert.ok(looksLikeContextOverflow(
    "This model's maximum context length is 128000 tokens"));
  assert.ok(looksLikeContextOverflow("context_length_exceeded"));
  for (const other of [
    "429 Too Many Requests: quota exhausted",
    "connect ECONNREFUSED 127.0.0.1:8080",
    "401 invalid api key",
    "500 internal server error",
  ]) {
    assert.ok(!looksLikeContextOverflow(other), `误判了: ${other}`);
  }
});

test("上下文撑爆:先压一次再重发;压不动如实失败并说清是哪种大", async () => {
  // 内网网关窗口 169984,而 pi 的自动压缩按它自己估的窗口走——网关比
  // 它以为的小,硬报错就漏到宿主,原来当场判死任务。现在先压一次再
  // 原样重发(该轮零活动,重发不会重做已完成的事)。
  //
  // 假件会话很小,pi 会以 "session too small" 拒压(同本文件第一条
  // 用例的老现象)——所以这里能裁的是:①自愈被触发;②压不动时如实
  // 失败且把"多半是单轮输入过大"讲给人;③补救有上限不空转。
  // **压缩成功后重试收口**只在真模型的大会话上成立,假件裁不了,
  // README 已知边界如实记着,别把这条当已验证。
  const model = new ScriptedModelServer([{ text: "一步完成。" }]);
  await model.start();
  model.failWith(
    "CREATE INFERENCE REQ FAILED: Exception('input too long, exceed max "
    + "input length, max input length is 169984, current input length is "
    + "171308')", 5);            // 给足配额,看它会不会无限重试
  const logs: string[] = [];
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-overflow-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    log: (message) => logs.push(message),
  });
  try {
    const created = service.create("演练:上下文撑爆");
    await until(() =>
      service.get(created.id)!.status === "failed", "压不动即如实失败");
    assert.ok(logs.some((line) => line.includes("上下文超限")),
      `没走自愈路径,日志: ${logs.join(" | ")}`);
    const detail = service.get(created.id)!.detail ?? "";
    assert.match(detail, /input too long/, "网关原文要留给人");
    assert.match(detail, /单轮输入过大/, "压不动的原因要说成人话");
    // 补救只许一次:一次原始请求 + 一次重发,远少于 5 次配额。
    assert.ok(model.requests.length <= 3,
      `补救次数失控,发了 ${model.requests.length} 次请求`);
  } finally {
    await model.stop();
  }
});

test("阈值未到不压;压缩失败也不影响收口(fail-open)", async () => {
  const quiet = new ScriptedModelServer([{ text: "一步完成。" }]);
  await quiet.start();
  const logs: string[] = [];
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-compact2-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: quiet.modelsJson(),
    compactEveryEvents: 999,        // 永远到不了
    log: (message) => logs.push(message),
  });
  try {
    const created = service.create("演练:不压也要正常收口");
    await until(() =>
      service.get(created.id)!.status === "completed", "任务收口");
    assert.ok(!logs.some((line) => line.includes("主动压缩")),
      "阈值未到不该压");
  } finally {
    await quiet.stop();
  }
});
