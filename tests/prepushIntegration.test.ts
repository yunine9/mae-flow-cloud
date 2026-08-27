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
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
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
import { FakeTaskContainerHarness } from "./support/fakeTaskContainer.ts";
import { managedFlowFixture } from "./support/managedFlowFixture.ts";

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

function deliveryScenes(breakTransport = false, authoritativeRepo?: string): Scene[] {
  void breakTransport;
  void authoritativeRepo;
  return [
    { tool: { name: "bash", input: { command:
      "echo first > feature.txt" } } },
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
  dataDir: string,
  timing: { pollIntervalMs?: number; pollTimeoutMs?: number } = {},
): TaskService {
  return new TaskService({
    dataDir,
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
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-prepush-data-"));
  const model = new ScriptedModelServer(
    [...deliveryScenes(), ...repairScenes()], "scripted-v1", {
      linear: true,
      beforeScene: managedFlowFixture(dataDir, {
        branch: "master_bot_REQ_PREPUSH", ticket: "REQ_PREPUSH",
      }),
    });
  await model.start();
  const calls: PrePushRunRequest[] = [];
  const service = serviceWithRunner(platform, model, async (request) => {
    calls.push(request);
    return {
      status: "passed",
      sha: request.sha,
      message: "fixture compile and unit tests passed",
    };
  }, dataDir);
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
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-prepush-data-"));
  const model = new ScriptedModelServer(
    deliveryScenes(true, platform.barePath), "scripted-v1", {
      beforeScene: managedFlowFixture(dataDir, {
        branch: "master_bot_REQ_PREPUSH", ticket: "REQ_PREPUSH",
        takeRepositoryOffline: platform.barePath,
      }),
    });
  await model.start();
  const calls: PrePushRunRequest[] = [];
  const service = serviceWithRunner(platform, model, async (request) => {
    calls.push(request);
    return {
      status: "passed",
      sha: request.sha,
      message: "fixture compile and unit tests passed",
    };
  }, dataDir, { pollIntervalMs: 800, pollTimeoutMs: 10_000 });
  try {
    const id = service.create("REQ_PREPUSH：传输抖动复用预检", {
      ticket: "REQ_PREPUSH",
    }).id;
    await until(() => (service.get(id)!.delivery?.skipped ?? "")
      .includes("宿主推送失败"), "第一次 host push 失败");
    assert.equal(calls.length, 1, "首次 push 前应完成一次 prepush");

    renameSync(`${platform.barePath}.offline`, platform.barePath);

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
    if (!existsSync(platform.barePath)
        && existsSync(`${platform.barePath}.offline`)) {
      renameSync(`${platform.barePath}.offline`, platform.barePath);
    }
    await model.stop();
    await platform.stop();
  }
});

test("prepush 代码验证失败时禁止 push、MR 与流水线", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(sourceRepo(), mkdtempSync(join(tmpdir(), "mfc-prepush-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-prepush-data-"));
  const model = new ScriptedModelServer(deliveryScenes(), "scripted-v1", {
    beforeScene: managedFlowFixture(dataDir, {
      branch: "master_bot_REQ_PREPUSH", ticket: "REQ_PREPUSH",
    }),
  });
  await model.start();
  let calls = 0;
  const service = serviceWithRunner(platform, model, async (request) => {
    calls += 1;
    return {
      status: "code_failure",
      sha: request.sha,
      message: "compile failed in prepush fixture",
    };
  }, dataDir, { pollIntervalMs: 100, pollTimeoutMs: 250 });
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

test("prepush 通过后允许构建产物留在工作区，push 仍只传 HEAD", async () => {
  // git push 传提交对象而不是工作区。构建自然留下未跟踪产物时，不能
  // 为追求空 status 拒绝 PASS，更不能诱导 Agent 把产物提交进去。
  const platform = new FakeGitPlatform();
  platform.initBare(sourceRepo(), mkdtempSync(join(tmpdir(), "mfc-prepush-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-prepush-data-"));
  const model = new ScriptedModelServer(deliveryScenes(), "scripted-v1", {
    beforeScene: managedFlowFixture(dataDir, {
      branch: "master_bot_REQ_DIRTY", ticket: "REQ_DIRTY",
    }),
  });
  await model.start();
  const service = serviceWithRunner(platform, model, async (request) => {
    // 模拟真实构建:验证命令真跑了,但顺手把产物写进了挂载的工作区。
    mkdirSync(join(request.workspace, "build"), { recursive: true });
    writeFileSync(join(request.workspace, "build", "lib.o"), "artifact\n");
    return { status: "passed", sha: request.sha, message: "compile+ut ok" };
  }, dataDir, { pollIntervalMs: 100, pollTimeoutMs: 250 });
  try {
    const id = service.create("REQ_DIRTY：产物渗进工作区", {
      ticket: "REQ_DIRTY",
    }).id;
    await until(() => service.get(id)!.status === "await_merge",
      "工作区有编译产物仍完成交付");
    assert.equal(git(platform.barePath, "branch", "--list",
      "master_bot_REQ_DIRTY"), "master_bot_REQ_DIRTY");
    assert.equal(platform.mergeRequests.length, 1);
    assert.equal(existsSync(join((service as any).tasks.get(id).cwd,
      "build", "lib.o")), true, "push 不应要求删除本地构建产物");
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
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-prepush-data-"));
  const model = new ScriptedModelServer(
    [...deliveryScenes(), ...prepushScenes], "scripted-v1", {
      linear: true,
      beforeScene: managedFlowFixture(dataDir, {
        branch: "master_bot_REQ_PREPUSH", ticket: "REQ_PREPUSH",
      }),
    });
  await model.start();
  const containers = new FakeTaskContainerHarness();
  const service = new TaskService({
    dataDir,
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
    isolation: {
      image: "fixture/build-toolchain:test",
      containerFactory: containers.factory,
    },
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
    const prepushContainer = containers.records.find((record) =>
      record.name.endsWith("-prepush"));
    assert.ok(prepushContainer, "prepush 必须使用任务级稳定名称的独立容器");
    assert.ok(prepushContainer.commands.includes(compile));
    assert.ok(prepushContainer.commands.includes(unitTest));
    assert.equal(prepushContainer.stopped, true,
      "签发收据并 push 前必须等 prepush 容器退出");
    const ordinary = containers.records.find((record) =>
      !record.name.endsWith("-prepush"));
    assert.ok(ordinary?.stopped, "普通编码容器必须先停止");
    assert.ok(containers.events.indexOf(`stop:${ordinary!.name}`)
      < containers.events.indexOf(`start:${prepushContainer.name}`),
    "prepush 不得与普通编码容器同时写同一工作区");
  } finally {
    await model.stop();
    await platform.stop();
  }
});
