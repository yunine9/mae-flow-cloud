/**
 * prepush 交付集成 part 1/2:失败与重试出口:网络重试不重烧 Agent、验证失败禁推禁 MR、人工跳过留台账。
 * 共享夹具在 tests/prepushIntegration.helpers.ts(拆分背景见其头注);
 * 断言与测试行为零变化。
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
import { MrDescriptionReplyService as TaskService } from "./support/mrDescriptionReply.ts";
import type {
  PrePushRunRequest,
  PrePushRunner,
} from "../src/prepushAgent.ts";
import { PRE_PUSH_STATE_SCHEMA } from "../src/prePushVerification.ts";
import { FakeTaskContainerHarness } from "./support/fakeTaskContainer.ts";
import { managedFlowFixture } from "./support/managedFlowFixture.ts";
import {
  KERNEL_ROOT,
  git,
  sourceRepo,
  deliveryScenes,
  feedbackReceiptCommand,
  repairScenes,
  until,
  serviceWithRunner,
} from "./prepushIntegration.helpers.ts";


test("prepush 已通过后交付传输重试同一 SHA 不重复调用 Agent", async () => {
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
    await until(() => /远端交付核验未完成|宿主推送失败/.test(
      JSON.stringify(service.get(id)!.delivery ?? {})), "第一次交付传输失败");
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

test("失败后人工跳过的交付：MR 标题仍精确匹配 AR 描述，跳过事实留在台账", async () => {
  // 标题匹配 AR 描述；不能再用附加后缀破坏平台的合入要求。
  const platform = new FakeGitPlatform();
  platform.initBare(sourceRepo(), mkdtempSync(join(tmpdir(), "mfc-prepush-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-prepush-data-"));
  const model = new ScriptedModelServer(deliveryScenes(), "scripted-v1", {
    beforeScene: managedFlowFixture(dataDir, {
      branch: "master_bot_REQ_SKIPMARK", ticket: "REQ_SKIPMARK",
    }),
  });
  await model.start();
  // 标记逻辑只读 delivery.prepush 的落账状态,与 prepush 开关无关;
  // 直接注入失败跳过的收据,免得测试为凑 blocked 驱动整个修复环。
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: { kernelRoot: KERNEL_ROOT, repoPath: platform.barePath,
            python: "python3" },
    delivery: { platformUrl: platform.baseUrl, pollIntervalMs: 100,
                pollTimeoutMs: 10_000 },
  });
  try {
    const id = service.create("REQ_SKIPMARK：跳过要留痕", {
      ticket: "REQ_SKIPMARK",
    }).id;
    (service as any).tasks.get(id).summary.delivery = {
      prepush: {
        schema: PRE_PUSH_STATE_SCHEMA,
        state: "user_skipped",
        skipped_by: "zhangsan",
        round: 2,
        message: "zhangsan选择跳过本地验证,编译与 UT 交由权威流水线裁决",
        sha: "f".repeat(40),
        workspace_fingerprint: "stale",
        updated_at: new Date().toISOString(),
        checks: {
          compile: { state: "pending" },
          unit_test: { state: "pending" },
        },
      },
    };
    await until(() => platform.mergeRequests.length > 0, "跳过后照常建 MR");
    assert.equal(platform.mergeRequests[0].title, "测试 AR 单的准确描述");
    assert.equal(service.get(id)!.delivery?.prepush?.skipped_by, "zhangsan");
  } finally {
    await model.stop();
    await platform.stop();
  }
});
