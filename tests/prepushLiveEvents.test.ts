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
import { ExecutionEventReader } from "../src/executionEvents.ts";
import { buildTimeline } from "../src/timeline.ts";

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
  const round1 = join(workspace, "prepush", "round-1-aaa");
  const round2 = join(workspace, "prepush", "round-2-bbb");
  mkdirSync(round1, { recursive: true });
  writeFileSync(join(round1, "events.jsonl"),
    eventLine(1, "mvn -q compile"));
  let status = "verifying";
  const service = {
    get: (id: string) => (id === "t1" ? { status, workspace } : undefined),
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
      for (const raw of seen.split("\n")) {
        if (!raw.startsWith("data: ")) continue;
        const line = raw.slice(6);
        const command = JSON.parse(line).payload?.input?.command;
        if (command && !commands.includes(command)) commands.push(command);
      }
      if (commands.includes("mvn -q compile") && !switched) {
        switched = true;
        mkdirSync(round2, { recursive: true });
        writeFileSync(join(round2, "events.jsonl"), eventLine(1, "mvn -q test"));
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
    status = "verifying"; // Build-Fix 已结束，但任务还在等后续交付；回放也必须结束。
    const history = await fetch(`http://127.0.0.1:${address.port}/tasks/t1/build-fix/events?follow=false`,
      { signal: AbortSignal.timeout(5000) });
    const replay = await history.text();
    assert.match(replay, /mvn -q compile/);
    assert.match(replay, /mvn -q test -pl service/);
    assert.match(replay, /event: end/);
    writeFileSync(join(workspace, "events.jsonl"), eventLine(1, "git status"));
    const merged = await fetch(`http://127.0.0.1:${address.port}/tasks/t1/execution/events?follow=false`);
    const all = await merged.text();
    assert.match(all, /git status/);
    assert.match(all, /mvn -q compile/);
    assert.match(all, /"source":"main"/);
    assert.match(all, /"source":"build_fix"/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
});

test("汇总读取保留跨会话同号事件、同轮不同 SHA、半行与损坏行，不重复增量", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-execution-reader-"));
  const first = join(workspace, "prepush", "round-1-aaa");
  const second = join(workspace, "prepush", "round-1-bbb");
  mkdirSync(first, { recursive: true }); mkdirSync(second, { recursive: true });
  writeFileSync(join(workspace, "events.jsonl"), eventLine(1, "git status"));
  writeFileSync(join(first, "events.jsonl"), eventLine(1, "编译甲") + "bad json\n");
  const line = Buffer.from(eventLine(1, "编译乙"));
  const cut = line.indexOf(Buffer.from("乙")) + 1;
  writeFileSync(join(second, "events.jsonl"), line.subarray(0, cut));
  const reader = new ExecutionEventReader(workspace);
  assert.equal(reader.read().length, 2);
  assert.equal(reader.read().length, 0);
  appendFileSync(join(second, "events.jsonl"), line.subarray(cut));
  const added = reader.read();
  assert.equal(added.length, 1);
  assert.equal((added[0].payload.input as any).command, "编译乙");
  assert.equal(added[0].execution.attempt, "round-1-bbb");
  assert.equal(reader.read().length, 0);
  appendFileSync(join(first, "events.jsonl"), JSON.stringify({ eventId: 2, sessionId: "prepush-1",
    ts: "2026-09-08T10:30:00Z", kind: "session_started", payload: { resume: false } }) + "\n");
  const timeline = buildTimeline(workspace);
  assert.ok(timeline.some((entry) => entry.title === "Build-Fix · 第 1 轮开始"));
});
