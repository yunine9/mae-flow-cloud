import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/semanticEvents.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { FakeTaskContainerHarness } from "./support/fakeTaskContainer.ts";

async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

test("开发助手:安全暂停主任务后执行真实命令，回复/工具结果可见且不推进主状态", async () => {
  const model = new ScriptedModelServer([
    { tool: { name: "AskUserQuestion", input: {
      questions: [{ question: "主任务要继续吗?", options: ["继续"] }],
    } } },
    { tool: { name: "bash", input: { command:
      "printf 'assistant-ok\\n' > assistant-proof.txt && printf 'command-ok\\n'",
    } } },
    { text: "已创建 assistant-proof.txt，命令执行成功；没有提交或推送。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const containers = new FakeTaskContainerHarness();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-developer-assistant-flow-"));
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    isolation: {
      image: "fixture/developer-assistant:test",
      containerFactory: containers.factory,
    },
  });

  try {
    const id = service.create("旁路助手集成演练").id;
    await until(() => service.get(id)?.status === "waiting_for_human",
      "主任务进入人工节点");
    const paused = await service.pause(id, "alice");
    assert.equal(paused.status, "paused");

    const started = service.startDeveloperAssistant(
      id, "直接跑命令并留下一个证明文件", "alice");
    assert.equal(started.state, "running");
    assert.throws(() => service.resume(id, "alice"), /开发助手仍在处理/);

    await until(() => service.developerAssistant(id).state === "completed",
      "开发助手返回结果");
    const summary = service.get(id)!;
    const view = service.developerAssistant(id);
    const proof = join(summary.workspace, "assistant-proof.txt");

    assert.equal(summary.status, "paused",
      "助手完成后主任务必须保持暂停，等待用户明确交还");
    assert.equal(existsSync(proof), true);
    assert.equal(readFileSync(proof, "utf-8"), "assistant-ok\n");
    assert.match(view.messages.at(-1)?.text ?? "", /命令执行成功/);
    assert.equal(view.tools.some((tool) => tool.name.toLowerCase() === "bash"
      && tool.state === "passed" && /command-ok/.test(tool.result ?? "")), true,
    "侧栏应直接拿到真实工具结果，不只展示 Agent 自述");

    const events = new EventLog(join(summary.workspace, "events.jsonl")).replay();
    assert.equal(events.some((event) =>
      event.sessionId === "developer-assistant"
      && event.kind === "tool_finished"), true,
    "开发助手完整工具轨迹应进入任务 SSE 正本");
    assert.equal(events.filter((event) =>
      event.sessionId === "developer-assistant").every((event) =>
        event.taskId === id), true);

    const assistantContainer = containers.records.at(-1)!;
    assert.equal(assistantContainer.stopped, true,
      "助手回合结束必须释放任务容器");
    assert.equal(assistantContainer.commands.some((command) =>
      command.includes("assistant-proof.txt")), true);

    const resumed = service.resume(id, "alice");
    assert.equal(resumed.status, "waiting_for_human",
      "交还后应回到原来的 Mae-Flow/主任务状态，而不是由助手越级推进");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
