/**
 * Git 交付判定(§10):Agent 只提交，宿主释放会话后推送并反查远端 SHA。
 * 三条路:host push → MR+流水线 → 等待合入;流水线红 → 验证中;
 * host push 失败 → 明说原因,不硬造 MR。用最小剧本驱动真实闭环。
 *
 * part 3/6:修复环(红→专职会话修复→新 SHA 再验、诊断喊人、默认 20 轮
 * 兜底、轮数预算耗尽)。共享夹具在 tests/delivery.helpers.ts;
 * 断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
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

test("修复环:红→专职会话修复→推新提交→新流水线绿→等待合入", async () => {
  // "流水线直至全绿是最终目标"(用户拍板)。修复本身是纯提示词:
  // 专职会话拿失败日志干活;宿主只做等待(带预算)、事实(绑 SHA)、
  // 刹车(轮数/新提交)三件提示词干不了的事。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed");        // 第一跑红,之后默认绿
  platform.nextPipelineLog = "BUILD FAILURE: NotifyServiceTest 断言失败";
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel(
    [...walkScript(true), ...repairScenes(true)],
    dataDir, { linear: true });
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson(),
    { repairRounds: 2 });
  try {
    const id = service.create("交付 REQ9:演练修复环").id;
    await until(() => service.get(id)!.status === "await_merge",
      "修复后收敛到等待合入");
    const task = service.get(id)!;
    assert.equal(task.delivery?.loop?.round, 1, "用了一轮修复");
    assert.equal(task.delivery?.loop?.state, "green");
    assert.equal(task.delivery?.pipeline, "success");
    // 第二次流水线绑的是修复后的新提交,不是旧 SHA 的旧绿灯
    assert.equal(platform.pipelines.length, 2);
    assert.notEqual(platform.pipelines[1].sha, platform.pipelines[0].sha,
      "新流水线必须绑修复后的新 SHA");
    // 修复会话拿到的是使命 + 平台失败原文
    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    assert.match(seen, /唯一的使命/);
    assert.match(seen, /NotifyServiceTest 断言失败/);
    // 反向守卫:短但真实的失败原文(平台就给这么多,没有链接)不许被
    // "无证据"判据误伤——那条判据是给"链接替内容站岗"准备的。
    assert.match(seen, /失败详情\(平台原文\)/,
      "有真内容时必须走正常分支");
    assert.ok(!seen.includes("没有给出"), "短原文不是无证据");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("修复环:会话没新提交 → 带诊断停下,主动喊人", async () => {
  // 修复会话自己判断"这红灯不该由改码解决"是合法结局(你说的
  // "要去别的平台配 yaml"就是这类)——它的收口发言就是给人的诊断,
  // 必须跟着刹车走到人面前,不能让人拿着一句"已停"去翻日志猜。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed", "failed");
  await platform.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel([
    ...walkScript(true),
    { text: "诊断:流水线要求 sonar.yaml,需在质量平台为本仓开通配置;"
        + "配好后重跑即可。这不是本仓代码能修的,我不做无关改动。" },
  ], dataDir, { linear: true });
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: KERNEL_ROOT,
      repoPath: platform.barePath,
      python: "python3",
    },
    delivery: { platformUrl: platform.baseUrl },
    notifier: new Notifier({ endpoint: luban.endpoint }),
  });
  try {
    const id = service.create("交付 REQ9:修复环刹车",
      { account: "liaoxiang" }).id;
    await until(() =>
      service.get(id)!.delivery?.loop?.state === "halted", "刹车落账");
    const task = service.get(id)!;
    assert.equal(task.status, "verifying", "如实停在验证中,不假装有结论");
    assert.match(task.delivery?.pipeline ?? "", /自动修复已停/);
    assert.equal(task.delivery?.loop?.round, 1, "只烧了一轮");
    // 诊断原文上浮:环账、任务详情都有"缺什么、去哪配"
    assert.match(task.delivery?.loop?.diagnosis ?? "", /sonar\.yaml/);
    assert.match(task.detail ?? "", /质量平台/);
    // 而且主动喊了人,不是等人来看页面
    await until(() => luban.messages.some((message) =>
      String(message.text ?? "").includes("需要你介入")), "停机通知送达");
    assert.ok(luban.messages.some((message) =>
      String(message.text ?? "").includes("sonar.yaml")),
      "通知里没带诊断,人还得自己猜");
  } finally {
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

test("修复环默认 20 轮兜底:三连红仍一路修到绿", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed", "failed", "failed");
  platform.nextPipelineLog = "BUILD FAILURE: 覆盖率 62% 未达标";
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel(
    [...walkScript(true), ...repairScenes(true),
     ...repairScenes(true), ...repairScenes(true)],
    dataDir, { linear: true });
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:默认预算修复").id;
    await until(() => service.get(id)!.status === "await_merge",
      "三轮修复后全绿", 120_000);
    const task = service.get(id)!;
    assert.equal(task.delivery?.loop?.round, 3, "第三轮才绿,老默认早断头了");
    assert.equal(task.delivery?.loop?.max, 20, "默认预算必须真实进入修复账");
    assert.equal(task.delivery?.loop?.state, "green");
    // 使命升级在场:分诊、专职分派、诊断出口;第 2 轮起带上一轮失败对比
    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    assert.match(seen, /先分诊再动手/);
    assert.match(seen, /定位先于修改/, "定位这一步必须写死在使命里");
    assert.match(seen, /定位依据/, "定位要交依据,不许凭猜改");
    assert.match(seen, /专职质量子 agent/);
    assert.match(seen, /诊断出口/);
    assert.match(seen, /上一轮修复后流水线仍红/);
    // 本夹具只有 README/a.txt，没有可提取符号的源码；
    // 空地图按产品契约不上桌，不能用这条交付测试强造一张假地图。
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("修复环:轮数预算耗尽 → 如实停下请人工", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed", "failed");
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel(
    [...walkScript(true), ...repairScenes(true)],
    dataDir, { linear: true });
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson(),
    { repairRounds: 1 });
  try {
    const id = service.create("交付 REQ9:修复环预算").id;
    await until(() =>
      service.get(id)!.delivery?.loop?.state === "exhausted", "预算耗尽落账");
    const task = service.get(id)!;
    assert.equal(task.status, "verifying");
    assert.match(task.delivery?.pipeline ?? "", /预算用完/);
  } finally {
    await model.stop();
    await platform.stop();
  }
});
