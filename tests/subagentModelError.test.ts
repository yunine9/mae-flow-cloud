/**
 * 子 Agent 死于模型层错误时,宿主必须如实返回失败,而不是把最后一句旁白当结果。
 *
 * 实锤:cross-glm53-20260906c task-2 写设计阶段,Story 子 Agent 两次在 300s
 * 沉默后被 undici 掐线(errorMessage="terminated"),宿主报 lifecycle=returned、
 * final_text="现在勘察真实代码…",主 Agent 当成"中途话术"再派一次,再死一次。
 *
 * 裁判用真 pi 会话 + 剧本假模型:子 Agent 的那次请求由网关吐一个不可重试的
 * 错误(pi 对 insufficient_quota 不重试,测试不用等退避)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene, type ScriptedModelOptions } from "../src/scriptedModel.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";

const DISPATCH: Scene = {
  text: "交给子 Agent 写 Story 卡。",
  tool: {
    name: "Task",
    input: { subagent_type: "story-agent", description: "写 Story 卡", prompt: "CHILD-PROMPT" },
  },
};

async function run(
  script: Scene[],
  beforeScene?: (model: ScriptedModelServer, requestNumber: number) => void,
) {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-child-error-"));
  const options: ScriptedModelOptions = { linear: true };
  const model = new ScriptedModelServer(script, "scripted-v1", options);
  options.beforeScene = ({ requestNumber }) => beforeScene?.(model, requestNumber);
  await model.start();
  const agentDir = join(workspace, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  const eventLog = new EventLog(join(workspace, "events.jsonl"));
  const logs: string[] = [];
  const session = await CloudSession.create({
    taskId: "T-child-error",
    workspace,
    agentDir,
    provider: "maeflow",
    model: "scripted-v1",
    eventLog,
    transcript: new TranscriptStore(join(workspace, "transcript.jsonl"), "main"),
    gate: new GateService({ workspace, cwd: workspace }),
    humanGate: new HumanGate(join(workspace, "waiting.json")),
    log: (line) => logs.push(line),
  });
  try {
    const outcome = await session.start("开始");
    return { outcome, events: eventLog.replay(), requests: model.requests, logs, model };
  } finally {
    session.dispose();
    await model.stop();
  }
}

test("子 Agent 的模型请求失败:按 failed 返回并带错误原文,主 Agent 看到的是失败不是旁白", async () => {
  // 顺演剧本:第 1 请求主 Agent 派发;第 2 请求(子 Agent)由网关吐错;第 3 请求主 Agent 收口。
  const result = await run(
    [DISPATCH, { text: "(子 Agent 这幕不会被演到)" }, { text: "子 Agent 失败,如实上报。" }],
    (model, requestNumber) => {
      if (requestNumber === 1) model.failWith("insufficient_quota: 账户额度已用尽", 1);
    },
  );
  assert.equal(result.outcome.status, "turn_finished", result.outcome.detail ?? "");
  const finished = result.events.find((event) => event.kind === "agent_finished");
  assert.ok(finished, "应有 agent_finished 事件");
  assert.equal(finished.payload.lifecycle, "failed",
    "模型层错误必须按 failed 返回,不能冒充 returned");
  assert.match(String(finished.payload.final_text), /insufficient_quota/,
    "失败原因原文必须带给主 Agent");
  // Task 的收口只走内核 posttooluse(pi 的回声被丢弃),事件流里没有它;
  // 主 Agent 的下一轮请求里,工具结果是失败原文——这才是它决定重派或停下的依据。
  assert.match(JSON.stringify(result.requests.at(-1)), /insufficient_quota/);
  assert.ok(result.logs.some((line) => /模型层错误/.test(line)),
    "错误原文必须进日志,以后再出沉默返回有据可查");
});

test("子 Agent 正常返回:lifecycle 仍是 returned,最终报告原样交回", async () => {
  const result = await run(
    [DISPATCH, { text: "CHILD-REPORT 三张 Story 卡已落盘。" }, { text: "收到子 Agent 报告,完成。" }],
  );
  assert.equal(result.outcome.status, "turn_finished", result.outcome.detail ?? "");
  const finished = result.events.find((event) => event.kind === "agent_finished");
  assert.ok(finished);
  assert.equal(finished.payload.lifecycle, "returned");
  assert.equal(finished.payload.final_text, "CHILD-REPORT 三张 Story 卡已落盘。");
  assert.match(JSON.stringify(result.requests.at(-1)), /CHILD-REPORT/,
    "主 Agent 下一轮应拿到子 Agent 的报告原文");
});
