import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consumptionFixture } from "./componentConsumptionFixture.ts";
import { ComponentKnowledgeConsumption } from "../src/componentKnowledgeConsumption.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";
import type { MemoryUsageEvent } from "../src/memoryUsage.ts";

const CONTEXT_TYPE = "mae-component-context";

function requestMessages(request: Record<string, unknown>) {
  return JSON.stringify(request.messages ?? []);
}

async function runSession(script: Scene[]) {
  const fixture = consumptionFixture();
  const document = fixture.publish();
  const usage: MemoryUsageEvent[] = [];
  const consumer = new ComponentKnowledgeConsumption({
    dataDir: fixture.data, cwd: fixture.cwd, context: () => fixture.context,
    languages: () => ["cpp"], baseline: () => "main",
    onContextUse: event => usage.push(event),
  });
  const contexts: Array<Array<Array<{ customType: string; content: string }>>> = [];
  const previousContextCounts: number[][] = [];
  const createContext = consumer.createContext.bind(consumer);
  consumer.createContext = sessionId => {
    const prepare = createContext(sessionId);
    const calls: Array<Array<{ customType: string; content: string }>> = [];
    const previous: number[] = [];
    contexts.push(calls);
    previousContextCounts.push(previous);
    return async messages => {
      previous.push(messages.filter(message => message.customType === CONTEXT_TYPE).length);
      const result = await prepare(messages);
      calls.push(result.filter(message => message.customType === CONTEXT_TYPE)
        .map(message => ({ customType: message.customType, content: String(message.content) })));
      return result;
    };
  };
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  let session: CloudSession | undefined;
  try {
    await model.start();
    const agentDir = join(fixture.dir, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
    const events = new EventLog(join(fixture.dir, "events.jsonl"));
    session = await CloudSession.create({
      taskId: "component-auto-context", workspace: fixture.cwd, agentDir,
      provider: "maeflow", model: "scripted-v1", eventLog: events,
      transcript: new TranscriptStore(join(fixture.dir, "transcript.jsonl"), "main"),
      gate: new GateService({ cwd: fixture.cwd, workspace: fixture.cwd }),
      humanGate: new HumanGate(join(fixture.dir, "waiting.json")),
      componentKnowledge: consumer,
    });
    const outcome = await session.start("核对现有实现，按任务需要调查或修改代码。");
    assert.equal(outcome.status, "turn_finished");
    assert.equal(model.requests.length, script.length, "每个脚本动作都实际经过模型和工具循环");
    const toolCalls = events.replay().filter(event => event.kind === "tool_requested");
    assert.ok(!toolCalls.some(event => event.payload.name === "knowledge"), "组件资料自动提供，不依赖主动调用 knowledge");
    return { document, contexts, previousContextCounts, requests: model.requests, events: events.replay(), usage };
  } finally {
    session?.dispose();
    await model.stop();
    fixture.cleanup();
  }
}

function assertComponentMaterial(text: string, document: { id: string; revision: string }) {
  assert.match(text, /组件资料/);
  assert.ok(text.includes(document.id), "资料包含正式文档 ID");
  assert.ok(text.includes(document.revision), "资料包含本次读取的文档版本");
  assert.match(text, /Pool\.submit/);
  assert.match(text, /使用 pool v2 并保持统一生命周期/, "全局接入配置与具体用法一起提供");
  assert.match(text, /任务结束前不能释放捕获的对象/, "不能只提供接口名而丢掉使用约束");
  assert.match(text, /候选|可能相关|可选/, "匹配结果是候选，仍需核对当前场景");
  assert.doesNotMatch(text, /必须使用|必须采用|强制使用|必须替换/, "观测到原生线程不等于当前场景必须替换");
}

const codeActions: Array<{ name: string; tool: NonNullable<Scene["tool"]> }> = [
  { name: "Read", tool: { name: "read", input: { path: "existing.cpp" } } },
  { name: "Write", tool: { name: "write", input: { path: "added.cpp", content: "void run() { std::thread worker; }\n" } } },
  { name: "Edit", tool: { name: "edit", input: { path: "existing.cpp", oldText: "void unrelated() {}", newText: "void unrelated() { std::thread worker; }" } } },
];

for (const action of codeActions) test(`真实 Pi 主会话在成功 ${action.name} 后自动获得组件资料，不要求知识工具或记忆上下文`, async () => {
  const result = await runSession([{ tool: action.tool }, { text: "已核对当前实现。" }]);
  assert.ok(!requestMessages(result.requests[0]).includes(result.document.id), "首次请求没有代码观测，不能仅凭原始任务注入组件推荐");
  assertComponentMaterial(requestMessages(result.requests[1]), result.document);
  assert.equal(result.contexts.length, 1);
  assert.deepEqual(result.contexts[0][0], []);
  const injected = result.contexts[0].flat();
  assert.ok(injected.length > 0);
  assert.ok(injected.every(message => message.customType === CONTEXT_TYPE));
  assertComponentMaterial(injected.at(-1)!.content, result.document);
});

test("连续读取同一文件时组件资料每轮仅一份，自动上下文不写入真实会话历史", async () => {
  const result = await runSession([
    { tool: { name: "read", input: { path: "existing.cpp" } } },
    { tool: { name: "read", input: { path: "existing.cpp" } } },
    { text: "已完成再次核对。" },
  ]);
  assert.deepEqual(result.previousContextCounts, [[0, 0, 0]], "临时资料不应回到下一轮的持久消息输入");
  assert.deepEqual(result.contexts[0].map(messages => messages.length), [0, 1, 1]);
  for (const request of result.requests.slice(1)) {
    const messages = requestMessages(request);
    assert.equal((messages.match(/【当前组件资料】/g) ?? []).length, 1);
    assertComponentMaterial(messages, result.document);
  }
});

test("普通 Task 子会话自动获得组件资料，父会话仅根据自己的实际代码观测匹配", async () => {
  const result = await runSession([
    { tool: { name: "Task", input: { subagent_type: "story-generator-agent", description: "核对现有代码", prompt: "读取 existing.cpp；只返回调查是否完成。" } } },
    { tool: { name: "read", input: { path: "existing.cpp" } } },
    { text: "调查完成。" },
    { tool: { name: "read", input: { path: "existing.cpp" } } },
    { text: "主会话也已核对。" },
  ]);
  assert.equal(result.contexts.length, 2, "主会话和子会话分别创建上下文处理器");
  assert.ok(!requestMessages(result.requests[0]).includes(result.document.id));
  assert.ok(!requestMessages(result.requests[1]).includes(result.document.id), "子会话首次请求也没有代码观测");
  assertComponentMaterial(requestMessages(result.requests[2]), result.document);
  assert.ok(!requestMessages(result.requests[3]).includes(result.document.id), "子会话未转述代码，父会话不能把子会话读取当作自己的观测");
  assertComponentMaterial(requestMessages(result.requests[4]), result.document);
  assert.equal(new Set(result.usage.filter(event => event.assets?.length).map(event => event.session_id)).size, 2,
    "消费记录能区分主、子会话");
  assert.ok(result.usage.every(event => event.session_id));
  assert.deepEqual(result.contexts[0][0], []);
  assert.deepEqual(result.contexts[1][0], []);
  assert.equal(result.events.find(event => event.kind === "agent_finished")?.payload.lifecycle, "returned");
});
