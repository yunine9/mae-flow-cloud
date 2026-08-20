import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudSession } from "../src/sessionDriver.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { EventLog } from "../src/semanticEvents.ts";
import type { SemanticEvent } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";


test("回合收口先 flush Hook，证据登记失败只让当前任务失败", async () => {
  const model = new ScriptedModelServer([{
    text: "执行一次工具。",
    tool: { name: "bash", input: { command: "echo done" } },
  }, { text: "完成。" }]);
  await model.start();
  const root = mkdtempSync(join(tmpdir(), "mfc-hook-flush-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  let finished = false;
  const session = await CloudSession.create({
    taskId: "T-flush", workspace: root, agentDir,
    provider: "maeflow", model: "scripted-v1",
    eventLog: new EventLog(join(root, "events.jsonl")),
    transcript: new TranscriptStore(join(root, "transcript.jsonl"), "main"),
    gate: new GateService(),
    humanGate: new HumanGate(join(root, "waiting.json")),
    hostHooks: {
      preTool: async () => undefined,
      postTool: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        finished = true;
        throw new Error("disk full while recording evidence");
      },
    },
  });
  try {
    const outcome = await session.start("开始");
    assert.equal(finished, true, "收口前必须等登记 Promise 真正结束");
    assert.equal(outcome.status, "session_ended");
    assert.match(outcome.detail ?? "", /证据登记未可靠落盘/);
  } finally {
    session.dispose();
    await model.stop();
  }
});

test("恢复会先把无返回的子 Agent 登记为 interrupted 再续跑", async () => {
  const model = new ScriptedModelServer([{ text: "按内核断点继续。" }]);
  await model.start();
  const root = mkdtempSync(join(tmpdir(), "mfc-child-reconcile-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  const log = new EventLog(join(root, "events.jsonl"));
  const transcript = new TranscriptStore(join(root, "transcript.jsonl"), "main");
  const spawned: SemanticEvent = {
    eventId: 1, taskId: "T-reconcile", sessionId: "main",
    ts: new Date().toISOString(), kind: "agent_spawned",
    payload: {
      call_id: "call-old", agent_type: "ut-generator-agent",
      description: "补 UT", prompt: "任务卡", child_session_id: "child-7",
    },
  };
  log.append(spawned);
  transcript.record(spawned);
  const post: SemanticEvent[] = [];
  const session = await CloudSession.create({
    taskId: "T-reconcile", workspace: root, agentDir,
    provider: "maeflow", model: "scripted-v1", eventLog: log, transcript,
    gate: new GateService(),
    humanGate: new HumanGate(join(root, "waiting.json")),
    hostHooks: {
      preTool: async () => undefined,
      postTool: async (event) => { post.push(event); },
    },
  });
  try {
    const outcome = await session.startResume("继续");
    assert.equal(outcome.status, "turn_finished");
    const finished = log.replay().find((event) =>
      event.kind === "agent_finished"
      && event.payload.call_id === "call-old");
    assert.equal(finished?.payload.lifecycle, "interrupted");
    assert.ok(post.some((event) =>
      event.payload.name === "Task"
      && event.payload.call_id === "call-old"
      && event.payload.is_error === true));
  } finally {
    session.dispose();
    await model.stop();
  }
});
