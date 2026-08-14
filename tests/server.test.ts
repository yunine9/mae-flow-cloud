/**
 * 任务 API 端到端:真 pi 会话(进程内)+ 剧本假模型,经 HTTP 走完
 * 创建 → 等待人工 → 决定冲突(409)→ 决定生效 → 完成,并核对
 * SSE 事件流与现场文件。整链证据判定由 probe 的内核裁判负责,
 * 这里钉的是 API 语义。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

const SCRIPT: Scene[] = [
  { text: "先编译",
    tool: { name: "bash", input: { command: "echo BUILD SUCCESS" } } },
  { tool: { name: "ask_user_question",
            input: { question: "Diff 通过吗?", options: ["通过", "打回"] } } },
  { text: "COMPILE_RESULT: PASS 收口" },
];

async function until<T>(
  probe: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function sseKinds(url: string, ms: number): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    const kinds = new Set<string>();
    const request = get(url, (response) => {
      response.setEncoding("utf-8");
      response.on("data", (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          kinds.add(String(JSON.parse(line.slice(6)).kind));
        }
      });
      response.on("end", () => resolve(kinds));
    });
    request.on("error", reject);
    setTimeout(() => {
      request.destroy();
      resolve(kinds);
    }, ms);
  });
}

test("任务 API 整链:等待人工/409 冲突/决定生效/SSE 镜像", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-api-"));
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const server = createTaskServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const created = await fetch(`${base}/tasks`, {
      method: "POST",
      body: JSON.stringify({ requirement: "交付 API-1:编译并检视" }),
    }).then((r) => r.json());
    // 并发额度未满时队列泵在 create 返回前就已起跑,两种都合法。
    assert.ok(["queued", "running"].includes(created.status));

    const waiting = await until(async () => {
      const task = await fetch(`${base}/tasks/${created.id}`)
        .then((r) => r.json());
      return task.status === "waiting_for_human" ? task : undefined;
    }, "任务进入等待人工");
    assert.equal(waiting.waiting.question.question, "Diff 通过吗?");

    // 后到决定(错误版本)必须 409,不覆盖先到。
    const conflict = await fetch(`${base}/tasks/${created.id}/decision`, {
      method: "POST",
      body: JSON.stringify({ state_version: 99, decision: "打回" }),
    });
    assert.equal(conflict.status, 409);

    const decided = await fetch(`${base}/tasks/${created.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        state_version: waiting.waiting.state_version,
        decision: "通过",
        notes: "API 测试决定",
      }),
    });
    assert.equal(decided.status, 200);

    // 决定已消费:重复提交没有待办可决,404 而不是再走一遍。
    const replay = await fetch(`${base}/tasks/${created.id}/decision`, {
      method: "POST",
      body: JSON.stringify({
        state_version: waiting.waiting.state_version, decision: "通过",
      }),
    });
    assert.equal(replay.status, 404);

    const done = await until(async () => {
      const task = await fetch(`${base}/tasks/${created.id}`)
        .then((r) => r.json());
      return task.status === "completed" ? task : undefined;
    }, "任务完成");
    assert.ok(existsSync(join(done.workspace, "transcript.jsonl")));

    const kinds = await sseKinds(`${base}/tasks/${created.id}/events`, 2000);
    for (const expected of
         ["user_message", "tool_finished", "human_decision", "turn_finished"]) {
      assert.ok(kinds.has(expected), `SSE 缺少 ${expected}`);
    }

    const listed = await fetch(`${base}/tasks`).then((r) => r.json());
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, "completed");
  } finally {
    server.close();
    await model.stop();
  }
});
