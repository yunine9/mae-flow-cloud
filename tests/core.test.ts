/**
 * 核心不变式单测(整链行为由 probe + 内核裁判验收,这里钉边界)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventLog,
  EventLogError,
  type SemanticEvent,
} from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { HumanGate, StateConflictError } from "../src/humanGate.ts";
import { GateService } from "../src/gateService.ts";

function event(
  eventId: number,
  kind: SemanticEvent["kind"],
  payload: Record<string, unknown>,
  sessionId = "main",
): SemanticEvent {
  return {
    eventId, taskId: "T-1", sessionId,
    ts: "2026-08-14 12:00:00", kind, payload,
  };
}

test("事件日志:重放 no-op,倒退拒收,畸形抛错", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-"));
  const log = new EventLog(join(dir, "events.jsonl"));
  assert.equal(log.append(event(1, "user_message", { text: "开工" })), true);
  assert.equal(log.append(event(1, "user_message", { text: "开工" })), false);
  assert.equal(
    log.append(event(1, "turn_finished", { reason: "end_turn" })), false);
  assert.throws(
    () => log.append(event(2, "tool_requested", { call_id: "c1" })),
    EventLogError);
  assert.equal(new EventLog(log.path).replay().length, 1);
});

test("人工待办:同 call_id 幂等,先到决定生效", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-"));
  const gate = new HumanGate(join(dir, "waiting.json"));
  const first = gate.createWaiting({
    taskId: "T-1", step: "grill", callId: "c1",
    questionInput: { q: "通过吗" },
  });
  const again = gate.createWaiting({
    taskId: "T-1", step: "grill", callId: "c1",
    questionInput: { q: "换内容也不新建" },
  });
  assert.equal(again.waiting_id, first.waiting_id);
  assert.deepEqual(again.question, { q: "通过吗" });
  gate.resolve(first.waiting_id, {
    stateVersion: first.state_version, decision: "通过",
  });
  assert.throws(
    () => gate.resolve(first.waiting_id, {
      stateVersion: first.state_version, decision: "打回",
    }),
    StateConflictError);
  assert.equal(gate.pending().length, 0);
});

test("transcript:未绑定子会话拒收;绑定后落到确定性路径", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-"));
  const store = new TranscriptStore(join(dir, "transcript.jsonl"), "main");
  assert.throws(() => store.record(
    event(1, "assistant_message", { text: "hi" }, "S9")));
  store.record(event(1, "agent_spawned", {
    call_id: "toolu-7", agent_type: "ut-generator-agent",
    description: "编写单元测试", prompt: "只写测试", child_session_id: "S2",
  }));
  assert.match(store.childPath("S2"), /subagents\/agent-toolu-7\.jsonl$/);
  store.record(event(2, "assistant_message", { text: "UT_WRITE_RESULT: DONE" }, "S2"));
  const child = readFileSync(store.childPath("S2"), "utf-8");
  assert.match(child, /UT_WRITE_RESULT/);
});

test("门禁:路由与 fail-open", () => {
  const logged: string[] = [];
  const gate = new GateService({
    contract: () => { throw new Error("契约内部错误"); },
    log: (message) => logged.push(message),
  });
  assert.equal(gate.decide(event(1, "tool_requested", {
    call_id: "c1", name: "Bash", input: { command: "ls" },
  })).action, "allow");
  assert.ok(logged.some((line) => line.includes("fail-open")));
  assert.equal(new GateService().decide(event(1, "tool_requested", {
    call_id: "c1", name: "AskUserQuestion", input: {},
  })).action, "human");
  assert.equal(new GateService({ moonlight: true }).decide(
    event(1, "tool_requested", {
      call_id: "c1", name: "AskUserQuestion", input: {},
    })).action, "deny");
  assert.equal(new GateService().decide(event(1, "tool_requested", {
    call_id: "c1", name: "Task", input: {},
  })).action, "agent");
});

test("门禁:Pi 文件工具的 path 与旧宿主 file_path 走同一契约", () => {
  const calls: Array<{ tool: string; value: string }> = [];
  const gate = new GateService({
    contract: (tool, value) => {
      calls.push({ tool, value });
      return undefined;
    },
  });

  for (const [tool, input] of [
    ["Read", { path: "src/read.ts" }],
    ["Write", { path: ".mae-flow.json" }],
    ["Edit", { file_path: "src/legacy.ts" }],
  ] as const) {
    assert.equal(gate.decide(event(1, "tool_requested", {
      call_id: "c1", name: tool, input,
    })).action, "allow");
  }

  assert.deepEqual(calls, [
    { tool: "Read", value: "src/read.ts" },
    { tool: "Write", value: ".mae-flow.json" },
    { tool: "Edit", value: "src/legacy.ts" },
  ]);
});

test("门禁:文件工具只能访问任务工作区且不跟随软链逃逸", () => {
  const parent = mkdtempSync(join(tmpdir(), "mfc-gate-"));
  const workspace = join(parent, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  let hasOutsideLink = true;
  try {
    symlinkSync(parent, join(workspace, "outside-link"), "dir");
  } catch {
    hasOutsideLink = false;
  }
  const calls: string[] = [];
  const gate = new GateService({
    workspace,
    contract: (_tool, value) => {
      calls.push(value);
      return undefined;
    },
  });
  const decide = (tool: string, path: string) => gate.decide(
    event(1, "tool_requested", {
      call_id: "c1", name: tool, input: { path },
    }),
  );

  assert.equal(decide("Write", "src/new.ts").action, "allow");
  assert.equal(decide("Read", join(workspace, "src")).action, "allow");
  assert.equal(decide("Edit", "../outside.ts").action, "deny");
  assert.equal(decide("Read", join(parent, "secret.txt")).action, "deny");
  assert.equal(gate.decide(event(1, "tool_requested", {
    call_id: "c2", name: "Write", input: {
      path: "src/safe.ts", file_path: join(parent, "hidden.ts"),
    },
  })).action, "deny");
  if (hasOutsideLink) {
    assert.equal(decide("Write", "outside-link/new.ts").action, "deny");
  }
  assert.deepEqual(calls, ["src/new.ts", join(workspace, "src")]);
});
