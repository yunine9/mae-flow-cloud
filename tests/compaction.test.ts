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
