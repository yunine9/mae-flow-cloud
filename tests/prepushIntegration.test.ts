/**
 * Push 前专项 Agent 的交付集成约束：
 * - 每个新 HEAD 都必须先拿到自己的 prepush 结论；
 * - prepush 已通过后，纯传输失败重试同一 SHA 不重复烧 Agent；
 * - prepush 未通过时，远端分支、MR 与流水线都不能被创建。
 *
 * 用注入 runner 只替代专项 Agent 本身；会话收口、host push、远端 SHA
 * 反查、MR 与流水线仍走 TaskService 的真实编排。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import type {
  PrePushRunRequest,
  PrePushRunner,
} from "../src/prepushAgent.ts";

const KERNEL_ROOT = (() => {
  const found = discoverKernelRoot(process.cwd());
  if (!found) {
    throw new Error("找不到内核(MAE_FLOW_HOME/../mae-flow/仓内 kernel/ 皆无)");
  }
  return found;
})();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function sourceRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-prepush-src-"));
  git(cwd, "init", "--quiet", "-b", "master");
  git(cwd, "config", "user.email", "bot@test");
  git(cwd, "config", "user.name", "bot");
  writeFileSync(join(cwd, "README.md"), "# prepush fixture\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "init");
  return cwd;
}

function deliveryScenes(brokenOrigin = false): Scene[] {
  const breakPush = brokenOrigin
    ? "git remote set-url origin /nonexistent/mfc-prepush-origin && "
    : "";
  return [
    { tool: { name: "bash", input: { command:
      breakPush
      + "git config user.email bot@test && git config user.name bot && "
      + "git checkout --quiet -b master_bot_REQ_PREPUSH && "
      + "echo first > feature.txt && git add . && "
      + 'git commit --quiet -m "feat: prepush fixture" && '
      + `cat > .mae-flow.json <<'EOF'
{"schema_version":2,"current":"end","revision":1,
 "execution_contract":{"schema":"mae-flow-execution/1","host":"cloud",
   "compile":"pipeline","ut_write":"agent","ut_run":"pipeline",
   "codecheck":"pipeline","git_push":"host"},
 "config":{"分支名":"master_bot_REQ_PREPUSH","基线分支":"master",
   "单号":"REQ_PREPUSH"},"choices":{},"history":[]}
EOF` } } },
    { text: "已提交，等待宿主交付。" },
  ];
}

function repairScenes(): Scene[] {
  return [
    { tool: { name: "bash", input: { command:
      "echo repaired >> feature.txt && git add feature.txt && "
      + 'git commit --quiet -m "fix: pipeline repair"' } } },
    { text: "修复已提交。" },
  ];
}

async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 50));
  }
}

function serviceWithRunner(
  platform: FakeGitPlatform,
  model: ScriptedModelServer,
  runner: PrePushRunner,
  timing: { pollIntervalMs?: number; pollTimeoutMs?: number } = {},
): TaskService {
  return new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-prepush-data-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: KERNEL_ROOT,
      repoPath: platform.barePath,
      python: "python3",
    },
    delivery: {
      platformUrl: platform.baseUrl,
      pollIntervalMs: timing.pollIntervalMs ?? 100,
      pollTimeoutMs: timing.pollTimeoutMs ?? 10_000,
    },
    prepush: { enabled: true, runner },
  });
}

test("每个新 SHA 都先经过 prepush，流水线修复产生的新提交不能复用旧结论", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(sourceRepo(), mkdtempSync(join(tmpdir(), "mfc-prepush-p-")));
  platform.statusQueue.push("failed");
  await platform.start();
  const model = new ScriptedModelServer(
    [...deliveryScenes(), ...repairScenes()], "scripted-v1", { linear: true });
  await model.start();
  const calls: PrePushRunRequest[] = [];
  const service = serviceWithRunner(platform, model, async (request) => {
    calls.push(request);
    return {
      status: "passed",
      sha: request.sha,
      message: "fixture compile and unit tests passed",
    };
  });
  try {
    const id = service.create("REQ_PREPUSH：两版代码都要预检", {
      ticket: "REQ_PREPUSH",
    }).id;
    await until(() => service.get(id)!.status === "await_merge",
      "第二个 SHA 通过并完成流水线核销");

    assert.equal(calls.length, 2, "首版和修复版应各调用一次 prepush");
    assert.equal(new Set(calls.map((call) => call.sha)).size, 2,
      "新提交不能复用旧 SHA 的 prepush 结论");
    assert.deepEqual(calls.map((call) => call.sha),
      platform.pipelines.map((run) => run.sha),
      "每条权威流水线绑定的 SHA 都必须先有 prepush 调用");
    assert.equal(service.get(id)!.delivery?.prepush?.state, "passed",
      "流水线/MR 现场更新不能覆盖最终 SHA 的 prepush 收据");
    assert.equal(service.get(id)!.delivery?.prepush?.receipt?.sha,
      service.get(id)!.delivery?.sha);
    assert.ok(calls.every((call) => call.taskId === id && call.workspace),
      "runner 必须拿到任务与工作区边界");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("prepush 已通过后 host push 网络重试同一 SHA 不重复调用 Agent", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(sourceRepo(), mkdtempSync(join(tmpdir(), "mfc-prepush-p-")));
  await platform.start();
  const model = new ScriptedModelServer(deliveryScenes(true));
  await model.start();
  const calls: PrePushRunRequest[] = [];
  const service = serviceWithRunner(platform, model, async (request) => {
    calls.push(request);
    return {
      status: "passed",
      sha: request.sha,
      message: "fixture compile and unit tests passed",
    };
  }, { pollIntervalMs: 800, pollTimeoutMs: 10_000 });
  try {
    const id = service.create("REQ_PREPUSH：传输抖动复用预检", {
      ticket: "REQ_PREPUSH",
    }).id;
    await until(() => (service.get(id)!.delivery?.skipped ?? "")
      .includes("宿主推送失败"), "第一次 host push 失败");
    assert.equal(calls.length, 1, "首次 push 前应完成一次 prepush");

    const saved = JSON.parse(readFileSync(
      join(service.get(id)!.workspace, "task.json"), "utf-8"));
    git(String(saved.cwd), "remote", "set-url", "origin", platform.barePath);

    await until(() => service.get(id)!.status === "await_merge",
      "同 SHA 传输自愈后完成交付");
    assert.equal(calls.length, 1,
      "纯网络重试不得为同一 SHA 再启动 prepush Agent");
    assert.equal(service.get(id)!.delivery?.sha, calls[0].sha);
    assert.equal(service.get(id)!.delivery?.prepush?.receipt?.sha, calls[0].sha,
      "网络失败前落盘的 PASS 收据应保留到重试成功后");
    assert.equal(platform.pipelines.length, 1,
      "网络重试成功后只触发一条绑定该 SHA 的流水线");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("prepush 代码验证失败时禁止 push、MR 与流水线", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(sourceRepo(), mkdtempSync(join(tmpdir(), "mfc-prepush-p-")));
  await platform.start();
  const model = new ScriptedModelServer(deliveryScenes());
  await model.start();
  let calls = 0;
  const service = serviceWithRunner(platform, model, async (request) => {
    calls += 1;
    return {
      status: "code_failure",
      sha: request.sha,
      message: "compile failed in prepush fixture",
    };
  }, { pollIntervalMs: 100, pollTimeoutMs: 250 });
  try {
    const id = service.create("REQ_PREPUSH：红灯禁止传输", {
      ticket: "REQ_PREPUSH",
    }).id;
    await until(() => calls > 0, "prepush runner 被调用");
    // 给交付自愈定时器一次机会；即使策略选择复验，红灯期间仍不能写远端。
    await new Promise((tick) => setTimeout(tick, 350));

    assert.ok(calls >= 1);
    assert.equal(git(platform.barePath, "branch", "--list",
      "master_bot_REQ_PREPUSH"), "", "prepush 红灯时远端分支必须不存在");
    assert.equal(platform.mergeRequests.length, 0, "prepush 红灯不得创建 MR");
    assert.equal(platform.pipelines.length, 0, "prepush 红灯不得触发流水线");
    assert.match(JSON.stringify(service.get(id)!.delivery ?? {}),
      /compile failed|prepush|推送前/i,
      "失败原因应留在任务交付现场");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("原生 prepush 会话修复提交后把 PASS 收据绑定最终 HEAD", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(sourceRepo(), mkdtempSync(join(tmpdir(), "mfc-prepush-p-")));
  await platform.start();
  const compile = `node -e "console.log('compile ok')"`;
  const unitTest = `node -e "console.log('unit test ok')"`;
  const prepushScenes: Scene[] = [
    { tool: { name: "write", input: {
      path: "feature.txt", content: "first\nfixed before push\n",
    } } },
    { tool: { name: "bash", input: { command:
      "git add feature.txt && git commit --quiet -m 'fix: prepush compile issue'",
    } } },
    { tool: { name: "bash", input: { command: compile } } },
    { tool: { name: "bash", input: { command: unitTest } } },
    { text: [
      "修复、编译与 UT 均已完成。",
      "<prepush-result>",
      JSON.stringify({
        status: "passed",
        compile: { command: compile, status: "passed" },
        unit_test: { command: unitTest, status: "passed" },
        summary: "native prepush passed",
      }),
      "</prepush-result>",
    ].join("\n") },
  ];
  const model = new ScriptedModelServer(
    [...deliveryScenes(), ...prepushScenes], "scripted-v1", { linear: true });
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-prepush-data-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: { kernelRoot: KERNEL_ROOT, repoPath: platform.barePath, python: "python3" },
    delivery: {
      platformUrl: platform.baseUrl,
      pollIntervalMs: 100,
      pollTimeoutMs: 10_000,
    },
    prepush: { enabled: true },
  });
  try {
    const id = service.create("REQ_PREPUSH：原生会话修复后再推送", {
      ticket: "REQ_PREPUSH",
    }).id;
    await until(() => service.get(id)!.status === "await_merge",
      "原生 prepush 修复并完成交付");
    const summary = service.get(id)!;
    const receiptSha = summary.delivery?.prepush?.receipt?.sha;
    assert.ok(receiptSha, "原生会话必须签发持久化 PASS 收据");
    assert.equal(receiptSha, summary.delivery?.sha);
    assert.equal(receiptSha, platform.pipelines[0]?.sha);
    assert.equal(summary.delivery?.prepush?.state, "passed");
    assert.equal(model.requests.length, deliveryScenes().length + prepushScenes.length,
      "专项会话应在普通编码会话之后独立消费模型回合");
  } finally {
    await model.stop();
    await platform.stop();
  }
});
