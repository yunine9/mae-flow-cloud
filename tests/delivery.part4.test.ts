/**
 * Git 交付判定(§10):Agent 只提交，宿主释放会话后推送并反查远端 SHA。
 * 三条路:host push → MR+流水线 → 等待合入;流水线红 → 验证中;
 * host push 失败 → 明说原因,不硬造 MR。用最小剧本驱动真实闭环。
 *
 * part 4/6:部署形态(固定交付地址、归属人身份头)、Cloud 固有执行契约
 * 与停机后的回程票。共享夹具在 tests/delivery.helpers.ts;
 * 断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { MrDescriptionReplyService as TaskService } from "./support/mrDescriptionReply.ts";
import {
  KERNEL_ROOT,
  buildService,
  deliveryModel,
  makeSourceRepo,
  repairScenes,
  until,
  walkScript,
} from "./delivery.helpers.ts";

test("交付服务是部署基础设施:固定地址跑通交付", async () => {
  // MR/流水线服务与验证形态都是部署事实，不在管理员页面暴露。
  // 仓不在此列(2026-08-18 改口径):**交付仓每单必填,没有默认仓**
  // ——一个部署服务很多个仓,默认值只会让人把单下错地方。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel(walkScript(true), dataDir);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: KERNEL_ROOT,
      python: "python3",
      continuousReview: true,
      // 刻意不给 repoPath:代码仓由本单明确填写
    },
    delivery: { platformUrl: platform.baseUrl },
  });
  try {
    const id = service.create("交付 REQ9:纯界面配置",
      // 仓与单号按单填(没有默认仓;单号必填与仓同口径)
      { repo: platform.barePath, ticket: "REQ9" }).id;
    await until(() => service.get(id)!.status === "await_merge",
      "界面配置驱动交付收轮");
    const task = service.get(id)!;
    assert.equal(task.delivery?.pipeline, "success");
    assert.equal(platform.mergeRequests.length, 1, "MR 打到了部署配置的平台");
    // Cloud 固有执行契约不依赖可选旗子。
    const opening = JSON.stringify(
      ((model.requests[0] as any).messages ?? [])
        .filter((m: any) => m.role === "user")[0]?.content ?? "");
    assert.match(opening, /Cloud 执行契约/);
    assert.match(opening, /权威流水线/);
    assert.match(opening, /task_control push\/create_mr.*无需先修完所有旧问题/,
      "真实开场应告知已开放阶段性发布，不能只注册工具而仍提示禁止推送");
    assert.doesNotMatch(opening, /也不要 push|真验收有三道|每次 push 前 Cloud 另起/);
    assert.match(opening, /\.claude.*\.cac.*本地忽略.*push 前复核/s,
      "主 Agent 开场必须知道平台注入目录不属于交付");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("交付请求带任务归属人身份头:MR 发起人=本人的原料到位", async () => {
  // 令牌走请求头不走请求体——体会被外部动作台账记进投影,头不会。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel(walkScript(true), dataDir);
  await model.start();
  const service = new TaskService({
    dataDir,
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: KERNEL_ROOT,
      repoPath: platform.barePath,
      python: "python3",
      continuousReview: true,
    },
    delivery: { platformUrl: platform.baseUrl },
    gitCredential: (account) => account === "zhang"
      ? { username: "zhang.san", password: "glpat-秘密-8888" } : undefined,
  });
  try {
    const id = service.create("交付 REQ9:身份头", { account: "zhang" }).id;
    await until(() => service.get(id)!.status === "await_merge", "交付收轮");
    const mrCall = platform.seenIdentity.find((c) => c.path === "/mr");
    assert.equal(mrCall?.user, "zhang.san");
    assert.equal(decodeURIComponent(mrCall?.token ?? ""), "glpat-秘密-8888",
      "非 ASCII 令牌经 percent 编码后原样到达");
    assert.ok(platform.seenIdentity.some((c) =>
      c.path === "/pipeline/trigger" && c.token), "触发流水线也带身份");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("停机后的回程票:人工办完外部事项,重跑续推到绿灯收口", async () => {
  // "需人工"不能是死胡同:halted 的任务点重跑=人工背书"外部的事
  // 办完了",清停机账,同 SHA 重新验证——外部配置修好后同一提交的
  // 流水线就该绿。在途验证(非停机)点重跑要被拒,别重复烧流水线。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  // 停机前一跑红,之后绿。旧机械同 SHA 修复失败要再烧一条流水线才判
  // halted,MR 闭环改造后不烧(同 SHA 直接按上次结果裁),队列只需一个红。
  platform.statusQueue.push("failed");
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel([
    ...walkScript(true),
    { text: "诊断:需要在质量平台配 sonar.yaml,不是代码问题。" },
    { text: "外部配置已就绪,续推收口。" },        // 重跑的重建会话
  ], dataDir, { linear: true });
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:停机重跑").id;
    await until(() =>
      service.get(id)!.delivery?.loop?.state === "halted", "先停机");
    service.retry(id);
    await until(() => service.get(id)!.status === "await_merge",
      "重跑后绿灯收口");
    const task = service.get(id)!;
    assert.equal(task.delivery?.pipeline, "success");
    assert.equal(task.delivery?.loop?.state, "green",
      "停机态已清，但修复轮历史要保留给持续检视审计");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("Cloud 固有执行契约进每次会话开场,修复会话也不例外", async () => {
  // 恢复会保留旧上下文，但最新执行契约与修复使命仍须重新下发，
  // 检查最近的用户文本，不能把历史第一条开场当成当前输入。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed");
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel(
    [...walkScript(true), ...repairScenes(true)],
    dataDir, { linear: true });
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: KERNEL_ROOT,
      repoPath: platform.barePath,
      python: "python3",
      continuousReview: true,
    },
    delivery: { platformUrl: platform.baseUrl, repairRounds: 2 },
  });
  try {
    const id = service.create("交付 REQ9:流水线代行").id;
    await until(() => service.get(id)!.status === "await_merge", "修复后全绿");
    const latestUser = (at: number) => JSON.stringify(
      ((model.requests[at] as any).messages ?? [])
        .filter((m: any) => m.role === "user" && (typeof m.content === "string"
          || m.content?.some((block: any) => block.type === "text"))).at(-1)?.content ?? "");
    // 首跑会话(请求 0)与修复会话(请求 2)的开场都带环境事实
    assert.match(latestUser(0), /Cloud 执行契约/);
    assert.match(latestUser(2), /Cloud 执行契约/);
    assert.match(latestUser(2), /分别如实记录.*不能互相冒充/);
    assert.match(latestUser(2), /无需先修完所有旧问题/);
    assert.doesNotMatch(latestUser(2), /也不要 push/);
    assert.match(latestUser(2), /不要编造命令、结果、数量或绿灯/);
    assert.match(latestUser(2), /当前目标是处理本轮流水线失败/, "修复使命也在场");
  } finally {
    await model.stop();
    await platform.stop();
  }
});
