/**
 * 推送前验证的实时可观测性(用户点名:编译过程、执行命令必须看得见):
 * prepush 会话的事件一直落在轮目录里,但此前没有任何接口流出去,页面
 * 只有粗粒度 state。契约:独立 SSE 端点流出最新一轮事件;修复后新
 * HEAD 开新一轮时,服务端切文件并从头重放新一轮,客户端无需自己发现。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createTaskServer } from "../src/server.ts";
import { TaskService } from "../src/taskService.ts";

function eventLine(eventId: number, command: string): string {
  return JSON.stringify({
    eventId, taskId: "t1", sessionId: "prepush-1",
    ts: "2026-08-26 10:00:00", kind: "tool_requested",
    payload: { call_id: `c${eventId}`, name: "bash", input: { command } },
  }) + "\n";
}

test("最新轮目录解析:取轮号最大者,没有轮目录时如实缺席", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-prepush-path-"));
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-prepush-path-data-")),
    provider: "fixture", model: "fixture", modelsJson: {},
  });
  (service as any).tasks.set("t1", { summary: { workspace } });
  assert.equal(service.prePushEventLogPath("t1"), undefined,
    "prepush/ 尚未出现时不硬造路径");
  mkdirSync(join(workspace, "prepush", "round-2-abcdef123456"),
    { recursive: true });
  mkdirSync(join(workspace, "prepush", "round-10-fedcba654321"),
    { recursive: true });
  assert.equal(service.prePushEventLogPath("t1"),
    join(workspace, "prepush", "round-10-fedcba654321", "events.jsonl"),
    "轮号按数值比较,round-10 大于 round-2");
  assert.equal(service.prePushEventLogPath("missing"), undefined);
});

test("Build-Fix SSE 流出事件;换轮切文件并从头放新一轮", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-prepush-sse-"));
  const round1 = join(workspace, "round-1");
  const round2 = join(workspace, "round-2");
  mkdirSync(round1, { recursive: true });
  mkdirSync(round2, { recursive: true });
  writeFileSync(join(round1, "events.jsonl"),
    eventLine(1, "mvn -q compile"));
  writeFileSync(join(round2, "events.jsonl"),
    eventLine(1, "mvn -q test"));

  let activePath = join(round1, "events.jsonl");
  let status = "verifying";
  const service = {
    get: (id: string) => (id === "t1" ? { status } : undefined),
    prePushEventLogPath: () => activePath,
    options: {},
  } as unknown as TaskService;
  const server = createTaskServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/tasks/t1/build-fix/events`);
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get("content-type")),
      /text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const commands: string[] = [];
    const deadline = Date.now() + 15_000;
    let switched = false;
    let appended = false;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
      for (const block of seen.split("\n\n")) {
        const line = block.replace(/^data: /, "").trim();
        if (!line) continue;
        const command = JSON.parse(line).payload?.input?.command;
        if (command && !commands.includes(command)) commands.push(command);
      }
      if (commands.includes("mvn -q compile") && !switched) {
        switched = true;
        activePath = join(round2, "events.jsonl"); // 修复后新一轮
      }
      if (commands.includes("mvn -q test") && !appended) {
        appended = true;
        // 新一轮的后续追加也要实时到达,而不是只有换轮时的整文件重放。
        appendFileSync(join(round2, "events.jsonl"),
          eventLine(2, "mvn -q test -pl service"));
      }
      if (commands.includes("mvn -q test -pl service")) {
        status = "completed"; // 任务收口 → 服务端主动收流
      }
    }
    assert.deepEqual(commands, [
      "mvn -q compile", "mvn -q test", "mvn -q test -pl service",
    ], "旧轮→新一轮整放→新一轮增量,顺序与内容都不能漂");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
});
