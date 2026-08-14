/**
 * 任务级恢复(§11):进程可死,任务不能死。
 *
 * pi 会话是 inMemory 的,恢复靠的是盘上事实:task.json(概要)、
 * waiting.json(待办)、events.jsonl(事件连续性)、transcript.jsonl
 * (工具行按 call_id join)。剧本:服务 A 把任务带到等待人工,
 * "崩溃"(丢弃服务 A);服务 B 在同一数据目录上 recover(),
 * 决定走重建会话续跑到完成。断言恢复语义,不是断言模型行为。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService, type TaskSummary } from "../src/taskService.ts";

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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const LIFE_A: Scene[] = [
  { tool: { name: "AskUserQuestion",
            input: { questions: [{ question: "方案确认吗?",
                                   options: ["确认", "打回"] }] } } },
  { text: "不该走到这里:决定应由重建会话消费" },
];

const LIFE_B: Scene[] = [
  { text: "已收到用户答复,继续并完成任务。" },
];

test("恢复:等待人工的任务跨进程存活,决定走重建会话续跑", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-recover-"));
  // ---- 前世:走到等待人工,然后"崩溃"----
  const modelA = new ScriptedModelServer(LIFE_A);
  await modelA.start();
  const serviceA = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: modelA.modelsJson(),
  });
  const created = serviceA.create("演练:恢复语义");
  const waiting = await until(
    () => {
      const task = serviceA.get(created.id);
      return task?.status === "waiting_for_human" ? task.waiting : undefined;
    }, "任务进入等待人工");
  await modelA.stop(); // 崩溃:旧模型、旧会话全部消失,只剩盘上事实

  // ---- 今生:同一数据目录上恢复 ----
  const modelB = new ScriptedModelServer(LIFE_B);
  await modelB.start();
  const serviceB = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: modelB.modelsJson(),
  });
  const recovered = serviceB.recover();
  assert.equal(recovered.restored, 1);
  assert.equal(recovered.requeued, 0); // 等人的任务原地等,不烧模型

  const restored = serviceB.get(created.id);
  assert.equal(restored?.status, "waiting_for_human");
  assert.equal(restored?.waiting?.waiting_id, waiting!.waiting_id);

  // 决定到来:无活会话可回注 → 入队重建会话续跑
  await serviceB.decide(created.id, {
    state_version: waiting!.state_version,
    decision: "确认",
    notes: "恢复测试",
  });
  const done: TaskSummary = await until(
    () => {
      const task = serviceB.get(created.id);
      return task?.status === "completed" ? task : undefined;
    }, "重建会话续跑到完成");
  assert.equal(done.status, "completed");

  // 盘上事实闭环:决定补登记的 tool_result 与前世的 tool_use 同 id join,
  // 事件 id 跨进程严格递增,重建会话以 resume:true 留痕。
  const workspace = join(dataDir, created.id);
  const rows = readFileSync(join(workspace, "transcript.jsonl"), "utf-8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const blocks = rows.flatMap((row) =>
    Array.isArray(row.message?.content) ? row.message.content : []);
  const ask = blocks.find((block: any) =>
    block.type === "tool_use" && block.name === "AskUserQuestion");
  const result = blocks.find((block: any) =>
    block.type === "tool_result" && block.tool_use_id === ask?.id);
  assert.ok(ask, "前世的 tool_use 行还在");
  assert.ok(result, "决定的 tool_result 与前世 tool_use 按 call_id join");
  const events = readFileSync(join(workspace, "events.jsonl"), "utf-8")
    .trim().split("\n").map((line) => JSON.parse(line));
  const ids = events.map((event) => Number(event.eventId));
  assert.ok(ids.every((id, i) => i === 0 || id > ids[i - 1]),
    "事件 id 跨进程严格递增");
  assert.ok(events.some((event) =>
    event.kind === "session_started" && event.payload?.resume === true),
    "重建会话以 resume:true 留痕");
  assert.ok(events.some((event) => event.kind === "human_decision"),
    "人工决定进事件日志");
  await modelB.stop();
});
