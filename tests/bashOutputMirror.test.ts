import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import {
  createWorkspaceBashToolDefinition,
  withWorkspaceBashLogs,
} from "../src/bashOutputMirror.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";

const FIXED_TIME = new Date("2026-08-21T03:04:05.000Z");

function wrapped(
  workspace: string,
  operations: BashOperations,
  nonce = "fixed",
): BashOperations {
  return withWorkspaceBashLogs(operations, {
    workspace,
    taskId: "REQ/42",
    sessionId: "child:1",
    now: () => FIXED_TIME,
    nonce: () => nonce,
  });
}

function hintedPath(output: string): string {
  const matched = output.match(/完整命令输出：([^（\n]+)（可用 Read 打开）/);
  assert.ok(matched, `缺少工作区日志提示: ${output.slice(-500)}`);
  return matched[1];
}

test("大输出只给 Pi 有界首尾预览，全文可从工作区相对路径逐字读取", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-bash-log-large-"));
  const full = Buffer.from(Array.from({ length: 5_000 }, (_, index) =>
    `line-${String(index).padStart(4, "0")}-${"x".repeat(24)}\n`).join(""));
  const operations: BashOperations = {
    exec: async (_command, _cwd, options) => {
      // 故意用不规则 chunk，覆盖 UTF-8/预算边界不是一块输出一块算的情况。
      for (let offset = 0; offset < full.length; offset += 7_333) {
        options.onData(full.subarray(offset, offset + 7_333));
      }
      return { exitCode: 0 };
    },
  };
  const definition = createWorkspaceBashToolDefinition(
    workspace,
    operations,
    {
      workspace,
      taskId: "REQ/42",
      sessionId: "child:1",
      now: () => FIXED_TIME,
      nonce: () => "fixed",
    },
  );
  const result = await (definition.execute as any)(
    "call-large", { command: "fixture" }, undefined, undefined, undefined,
  );
  const output = String(result.content[0].text);
  const relativePath = hintedPath(output);

  assert.equal(readFileSync(join(workspace, relativePath)).compare(full), 0,
    "日志必须是未截断、未改写的原始字节流");
  assert.match(output, /line-0000/);
  assert.match(output, /line-4999/);
  assert.match(output, /中段已省略/);
  assert.ok(Buffer.byteLength(output) < 50 * 1024,
    "交给 Pi 的预览必须低于其 50KB 临时文件阈值");
  assert.ok(output.split("\n").length < 2_000,
    "交给 Pi 的预览必须低于其 2000 行临时文件阈值");
  assert.equal(result.details, undefined,
    "Pi 不应再生成宿主 /tmp/pi-bash 全文路径");
  assert.doesNotMatch(output, /\/tmp\/pi-bash/);
  assert.equal(lstatSync(join(workspace, relativePath)).mode & 0o777, 0o600);
});

test("非零退出、Abort 与执行器异常都把可读路径作为最终错误行", async () => {
  for (const scenario of ["nonzero", "abort", "infrastructure"] as const) {
    const workspace = mkdtempSync(join(tmpdir(), `mfc-bash-log-${scenario}-`));
    const operations: BashOperations = {
      exec: async (_command, _cwd, options) => {
        options.onData(Buffer.from(`${scenario}-diagnostic\n`));
        if (scenario === "abort") throw new Error("aborted");
        if (scenario === "infrastructure") {
          throw new Error("container disappeared");
        }
        return { exitCode: 17 };
      },
    };
    const definition = createWorkspaceBashToolDefinition(
      workspace,
      operations,
      {
        workspace,
        taskId: "REQ/42",
        sessionId: "child:1",
        now: () => FIXED_TIME,
        nonce: () => scenario,
      },
    );
    let output = "";
    await assert.rejects(
      () => (definition.execute as any)(
        `call-${scenario}`, { command: "fixture" }, undefined,
        undefined,
        undefined,
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        output = error.message;
        return true;
      },
    );
    const relativePath = hintedPath(output);
    assert.equal(readFileSync(join(workspace, relativePath), "utf-8"),
      `${scenario}-diagnostic\n`);
    assert.match(output.trimEnd(), /\[完整命令输出：.*（可用 Read 打开）\]$/,
      "失败/中断也必须以可定位路径收尾");
    if (scenario === "nonzero") assert.match(output, /exited with code 17/);
    if (scenario === "abort") assert.match(output, /Command aborted/);
    if (scenario === "infrastructure") {
      assert.match(output, /container disappeared/);
    }
  }
});

test("日志根被业务软链到仓外时先拒绝，绝不执行命令或越界落盘", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-bash-log-boundary-"));
  const outside = mkdtempSync(join(tmpdir(), "mfc-bash-log-outside-"));
  mkdirSync(dirname(join(workspace, ".mae-flow-work")), { recursive: true });
  symlinkSync(outside, join(workspace, ".mae-flow-work"), "dir");
  let executed = false;
  const operations: BashOperations = {
    exec: async () => {
      executed = true;
      return { exitCode: 0 };
    },
  };
  await assert.rejects(
    wrapped(workspace, operations).exec("fixture", workspace, {
      onData: () => undefined,
    }),
    /不是受控目录/,
  );
  assert.equal(executed, false, "日志边界不可靠时必须在命令前 fail-closed");
  assert.deepEqual(readdirSync(outside), []);
});

function filesBelow(path: string): string[] {
  if (!lstatSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => filesBelow(join(path, name)));
}

async function runSession(
  taskId: string,
  script: Scene[],
  allowHumanQuestions = true,
): Promise<{ workspace: string; transcript: string; commands: string[] }> {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-bash-log-session-"));
  const agentDir = join(workspace, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const commands: string[] = [];
  const operations: BashOperations = {
    exec: async (command, _cwd, options) => {
      commands.push(command);
      options.onData(Buffer.from(`ran:${command}\n`));
      return { exitCode: 0 };
    },
  };
  const transcript = join(workspace, "transcript.jsonl");
  const models = join(agentDir, "models.json");
  writeFileSync(models, JSON.stringify(model.modelsJson()));
  let session: CloudSession | undefined;
  try {
    session = await CloudSession.create({
      taskId,
      workspace,
      agentDir,
      provider: "maeflow",
      model: "scripted-v1",
      eventLog: new EventLog(join(workspace, "events.jsonl")),
      transcript: new TranscriptStore(transcript, "main"),
      gate: new GateService({ workspace, cwd: workspace }),
      humanGate: new HumanGate(join(workspace, "waiting.json")),
      allowHumanQuestions,
      bashOperations: operations,
    });
    const outcome = await session.start("开始");
    assert.equal(outcome.status, "turn_finished", outcome.detail ?? "");
  } finally {
    session?.dispose();
    await model.stop();
  }
  return { workspace, transcript, commands };
}

test("CloudSession 给普通、子 Agent 与 prepush 三类 Bash 会话统一装配日志", async () => {
  const ordinary = await runSession("REQ-LOG", [
    { tool: { name: "bash", input: { command: "main-command" } } },
    { tool: { name: "Task", input: {
      subagent_type: "reviewer-agent",
      description: "检查日志",
      prompt: "执行子命令",
    } } },
    { tool: { name: "bash", input: { command: "child-command" } } },
    { text: "子 Agent 完成。" },
    { text: "主 Agent 完成。" },
  ]);
  assert.deepEqual(ordinary.commands, ["main-command", "child-command"]);
  const ordinaryLogs = filesBelow(
    join(ordinary.workspace, ".mae-flow-work", "bash-logs"));
  assert.equal(ordinaryLogs.length, 2);
  assert.ok(ordinaryLogs.some((path) => path.includes("main-")));
  assert.ok(ordinaryLogs.some((path) => path.includes("child-1-")));
  const ordinaryTranscript = readFileSync(ordinary.transcript, "utf-8");
  const childTranscripts = filesBelow(
    ordinary.transcript.replace(/\.jsonl$/, "/subagents"));
  const allTranscripts = [ordinaryTranscript, ...childTranscripts.map((path) =>
    readFileSync(path, "utf-8"))].join("\n");
  assert.equal((allTranscripts.match(/完整命令输出：/g) ?? []).length, 2);
  assert.doesNotMatch(allTranscripts, /\/tmp\/pi-bash/);

  const prepush = await runSession("REQ-LOG:prepush:1", [
    { tool: { name: "bash", input: { command: "prepush-command" } } },
    { text: "prepush 完成。" },
  ], false);
  assert.deepEqual(prepush.commands, ["prepush-command"]);
  const prepushLogs = filesBelow(
    join(prepush.workspace, ".mae-flow-work", "bash-logs"));
  assert.equal(prepushLogs.length, 1);
  assert.match(readFileSync(prepushLogs[0], "utf-8"), /ran:prepush-command/);
  assert.match(readFileSync(prepush.transcript, "utf-8"), /完整命令输出：/);
});
