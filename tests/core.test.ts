/**
 * 核心不变式单测(整链行为由 probe + 内核裁判验收,这里钉边界)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
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
    call_id: "toolu-7", agent_type: "compile-agent",
    description: "编译", prompt: "去编译", child_session_id: "S2",
  }));
  assert.match(store.childPath("S2"), /subagents\/agent-toolu-7\.jsonl$/);
  store.record(event(2, "assistant_message", { text: "COMPILE_RESULT: PASS" }, "S2"));
  const child = readFileSync(store.childPath("S2"), "utf-8");
  assert.match(child, /COMPILE_RESULT/);
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
