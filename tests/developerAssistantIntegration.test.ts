import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

function coreFixture(root: string): { repo: string; kernel: string } {
  const repo = join(root, "repo");
  const kernel = join(root, "kernel");
  mkdirSync(repo);
  mkdirSync(join(kernel, "flow"), { recursive: true });
  writeFileSync(join(kernel, "flow", "flow.json"), JSON.stringify({
    steps: {
      build: { title: "编码实现", allow_source_edit: true },
      build_review: {
        title: "用户检视代码",
        user_ack: true,
        approval_subject: { kind: "worktree" },
      },
    },
  }));
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "fixture"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "fixture@example.com"]);
  writeFileSync(join(repo, "source.ts"), "export const value = 1;\n");
  execFileSync("git", ["-C", repo, "add", "source.ts"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "fixture"]);
  writeFileSync(join(repo, ".mae-flow.json"), JSON.stringify({
    current: "build", revision: 3,
  }));
  return { repo, kernel };
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

test("开发助手:仅在内核修改窗口启动，并把变更/命令结果一次性交给主会话", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-developer-assistant-core-"));
  const { repo, kernel } = coreFixture(root);
  const model = new ScriptedModelServer([
    { tool: { name: "bash", input: { command:
      "printf 'export const fixed = true;\\n' > fixed.ts && printf 'unit-ok\\n'",
    } } },
    { text: "已修复 fixed.ts，并完成定向检查。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const containers = new FakeTaskContainerHarness();
  const dataDir = join(root, "data");
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    maxConcurrent: 0,
    host: { kernelRoot: kernel, repoPath: repo },
    isolation: {
      image: "fixture/developer-assistant:test",
      containerFactory: containers.factory,
    },
  });

  try {
    const id = service.create("修复代码并交还").id;
    await service.pause(id, "alice");
    const internal = (service as unknown as {
      tasks: Map<string, { cwd?: string }>;
    }).tasks.get(id)!;
    internal.cwd = repo;

    assert.equal(service.developerAssistant(id).availability.code, "edit_window");
    service.startDeveloperAssistant(id, "修复并运行检查", "alice");
    await until(() => service.developerAssistant(id).state === "completed",
      "内核窗口中的助手完成");

    const view = service.developerAssistant(id);
    assert.equal(view.handoff?.state, "changed");
    assert.deepEqual(view.handoff?.changed_paths, ["fixed.ts"]);

    const resumed = service.resume(id, "alice");
    assert.equal(resumed.status, "queued");
    const saved = JSON.parse(readFileSync(
      join(dataDir, id, "task.json"), "utf-8"));
    assert.match(saved.assistant_handoff, /fixed\.ts/);
    assert.match(saved.assistant_handoff, /unit-ok/);
    assert.match(saved.assistant_handoff, /不是 Mae-Flow 步骤、批准或质量证据/);
    assert.equal(service.developerAssistant(id).handoff?.state, "returned");

    const reviewId = service.create("审批阶段不可旁路修改").id;
    await service.pause(reviewId, "alice");
    const reviewTask = (service as unknown as {
      tasks: Map<string, { cwd?: string }>;
    }).tasks.get(reviewId)!;
    reviewTask.cwd = repo;
    writeFileSync(join(repo, ".mae-flow.json"), JSON.stringify({
      current: "build_review", revision: 4,
      approval_subject: { id: "subject-a" },
    }));
    assert.equal(service.developerAssistant(reviewId).availability.code,
      "approval_pending");
    assert.throws(
      () => service.startDeveloperAssistant(reviewId, "顺手再改一下", "alice"),
      /先选择“需要调整”进入返工阶段/,
    );
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
