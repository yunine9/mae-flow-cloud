/**
 * Git 交付判定(§10):事实来自远端真实状态,不信任务自述。
 * 三条路:分支已推 → MR+流水线 → 等待合入;流水线红 → 验证中;
 * 分支未推 → 明说原因,不硬造 MR。不需要模型:预焙工作区直接测
 * tryDeliver 的判定(经 TaskService 的私有路径,用最小任务壳驱动)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { RuntimeSettings } from "../src/settings.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";

// bootstrap 会真跑内核(INACTIVE 全放行),所以内核必须真找得到——
// worktree 里 cwd()/../mae-flow 不存在,手写路径曾让整批用例超时。
function kernelRootOrDie(): string {
  const found = discoverKernelRoot(process.cwd());
  if (!found) throw new Error("找不到内核(MAE_FLOW_HOME/../mae-flow/仓内 kernel/ 皆无)");
  return found;
}
const KERNEL_ROOT = kernelRootOrDie();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeSourceRepo(knowledge?: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mfc-dsrc-"));
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "config", "user.email", "bot@test");
  git(dir, "config", "user.name", "bot");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  // 知识块随仓走(不是平台配置),克隆下来就在工作区里
  if (knowledge) {
    const kdir = join(dir, ".mae-flow", "knowledge");
    mkdirSync(kdir, { recursive: true });
    for (const [name, text] of Object.entries(knowledge)) {
      writeFileSync(join(kdir, name), text);
    }
  }
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "init");
  return dir;
}

/** 剧本:在克隆里预焙一笔提交并推送,再伪造内核状态收轮——
 * 交付判定只看远端与状态文件,这样测的就是判定本身。 */
function walkScript(push: boolean): Scene[] {
  const doPush = push
    ? " && git push --quiet origin master_bot_REQ9"
    : "";
  return [
    { tool: { name: "bash", input: { command:
        "git config user.email bot@test && git config user.name bot && " +
        "git checkout --quiet -b master_bot_REQ9 && " +
        "echo change > a.txt && git add . && " +
        'git commit --quiet -m "feat: REQ9"' + doPush + " && " +
        `cat > .mae-flow.json <<'EOF'
{"schema_version": 2, "current": "end", "revision": 1,
 "config": {"分支名": "master_bot_REQ9", "基线分支": "master",
            "单号": "REQ9"}, "choices": {}, "history": []}
EOF` } } },
    { text: "交付完成。" },
  ];
}

function buildService(
  platform: FakeGitPlatform,
  dataDir: string,
  modelsJson: Record<string, unknown>,
  poll?: { pollIntervalMs?: number; pollTimeoutMs?: number;
           repairRounds?: number },
  settings?: RuntimeSettings,
) {
  return new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson,
    settings,
    // host 指向裸仓:克隆即从"服务端"取码。kernelRoot 不参与本测
    // (bootstrap 会跑,INACTIVE 全放行;状态文件由剧本伪造)。
    host: {
      kernelRoot: KERNEL_ROOT,
      repoPath: platform.barePath,
      python: "python3",
    },
    delivery: { platformUrl: platform.baseUrl, ...poll },
  });
}

async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 100));
  }
}

async function runTask(
  platform: FakeGitPlatform,
  push: boolean,
  poll?: { pollIntervalMs?: number; pollTimeoutMs?: number;
           repairRounds?: number },
  dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-")),
  extraScenes: Scene[] = [],
  settings?: RuntimeSettings,
  createExtras?: { repairRounds?: number; ticket?: string },
) {
  const model = new ScriptedModelServer([...walkScript(push), ...extraScenes]);
  await model.start();
  const service = buildService(
    platform, dataDir, model.modelsJson(), poll, settings);
  const created = service.create("交付 REQ9:演练交付链",
    { ticket: "REQ9", ...createExtras });
  await until(() =>
    ["completed", "failed", "verifying", "await_merge"]
      .includes(service.get(created.id)!.status), "任务收口");
  await model.stop();
  return { task: service.get(created.id)!, service, dataDir };
}

test("分支已推+流水线绿 → MR 等待合入", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  try {
    const { task } = await runTask(platform, true);
    assert.equal(task.status, "await_merge", JSON.stringify(task.delivery));
    assert.equal(task.delivery?.mr_state, "等待合入");
    assert.equal(task.delivery?.pipeline, "success");
    assert.match(task.delivery?.mr_url ?? "", /\/mr\/\d+$/);
    assert.equal(platform.mergeRequests.length, 1);
    assert.equal(platform.mergeRequests[0].target_branch, "master");
    // 单号以独立字段递到平台(--e2e-issues 的原料),不许只活在 title
    assert.equal(platform.mergeRequests[0].e2e_issues, "REQ9");
  } finally {
    await platform.stop();
  }
});

test("流水线红(修复环关闭) → 验证中留痕,不标完成", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "failed";
  await platform.start();
  try {
    const { task } = await runTask(platform, true, { repairRounds: 0 });
    assert.equal(task.status, "verifying");
    assert.equal(task.delivery?.mr_state, "验证中");
    assert.equal(task.delivery?.pipeline, "failed");
  } finally {
    await platform.stop();
  }
});

test("运行时设置压过部署值:界面把修复轮改 0,红灯不再触发修复", async () => {
  // 管理页热改的消费证明:部署给 repairRounds=2,设置层写 0,
  // 生效在下一次红灯——结果应与"修复环关闭"的路径一字不差。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "failed";
  await platform.start();
  try {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
    const settings = new RuntimeSettings(dataDir);
    settings.updateRuntime({ repair_rounds: 0 });
    const { task } = await runTask(
      platform, true, { repairRounds: 2 }, dataDir, [], settings);
    assert.equal(task.status, "verifying", JSON.stringify(task.delivery));
    assert.equal(task.delivery?.loop, undefined,
      "设置层的 0 没压过部署的 2,修复环被触发了");
  } finally {
    await platform.stop();
  }
});

test("任务级修复轮压过部署值:下单填 0,这一单红灯不修", async () => {
  // 覆盖链的最上层:任务 > 设置 > 部署。部署 2 轮,这单点了 0。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "failed";
  await platform.start();
  try {
    const { task } = await runTask(
      platform, true, { repairRounds: 2 },
      mkdtempSync(join(tmpdir(), "mfc-deliver-")), [], undefined,
      { repairRounds: 0 });
    assert.equal(task.status, "verifying", JSON.stringify(task.delivery));
    assert.equal(task.delivery?.loop, undefined,
      "任务级的 0 没压过部署的 2,修复环被触发了");
  } finally {
    await platform.stop();
  }
});

test("异步流水线:running 验证中,绿灯后轮询收敛到等待合入", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "running";
  await platform.start();
  try {
    const { task, service } = await runTask(
      platform, true, { pollIntervalMs: 100 });
    assert.equal(task.status, "verifying");
    assert.equal(task.delivery?.pipeline, "running");
    platform.finishPipeline(task.delivery!.sha!, "success");
    await until(() =>
      service.get(task.id)!.status === "await_merge", "轮询收敛绿灯");
    const settled = service.get(task.id)!;
    assert.equal(settled.delivery?.pipeline, "success");
    assert.equal(settled.delivery?.mr_state, "等待合入");
  } finally {
    await platform.stop();
  }
});

test("异步流水线:红灯留痕(修复环关闭),任务停在验证中不标完成", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "running";
  await platform.start();
  try {
    const { task, service } = await runTask(
      platform, true, { pollIntervalMs: 100, repairRounds: 0 });
    platform.finishPipeline(task.delivery!.sha!, "failed");
    await until(() =>
      service.get(task.id)!.delivery?.pipeline === "failed", "轮询看到红灯");
    assert.equal(service.get(task.id)!.status, "verifying");
  } finally {
    await platform.stop();
  }
});

test("进程可死轮询不死:重启 recover 后继续收敛流水线", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "running";
  await platform.start();
  try {
    // 第一进程:走到 verifying+running 后"死掉"(直接弃用实例)。
    const { task, dataDir } = await runTask(
      platform, true, { pollIntervalMs: 100_000 });
    assert.equal(task.delivery?.pipeline, "running");
    // 第二进程:recover 续轮,绿灯后收敛。
    const revived = buildService(
      platform, dataDir, {}, { pollIntervalMs: 100 });
    assert.equal(revived.recover().restored, 1);
    platform.finishPipeline(task.delivery!.sha!, "success");
    await until(() =>
      revived.get(task.id)!.status === "await_merge", "重启后轮询收敛");
  } finally {
    await platform.stop();
  }
});

/** 修复环剧本:一幕修复提交(可选推送)+ 一幕收口。 */
function repairScenes(push: boolean): Scene[] {
  const doPush = push ? " && git push --quiet origin master_bot_REQ9" : "";
  return [
    { text: "流水线红了,我来修。",
      tool: { name: "bash", input: { command:
        "echo fixed >> a.txt && git add . && " +
        'git commit --quiet -m "fix: 流水线修复"' + doPush } } },
    { text: "修复完成。" },
  ];
}

test("交付服务是部署基础设施:固定地址跑通交付", async () => {
  // MR/流水线服务与验证形态都是部署事实，不在管理员页面暴露。
  // 仓不在此列(2026-08-18 改口径):**交付仓每单必填,没有默认仓**
  // ——一个部署服务很多个仓,默认值只会让人把单下错地方。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const model = new ScriptedModelServer(walkScript(true));
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: KERNEL_ROOT,
      python: "python3",
      // 刻意不给 repoPath:代码仓由本单明确填写
    },
    delivery: { platformUrl: platform.baseUrl },
    verifyViaPipeline: true,
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
    // 免编译环境事实来自部署形态
    const opening = JSON.stringify(
      ((model.requests[0] as any).messages ?? [])
        .filter((m: any) => m.role === "user")[0]?.content ?? "");
    assert.match(opening, /交流水线/);
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
  const model = new ScriptedModelServer(walkScript(true));
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-deliver-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: KERNEL_ROOT,
      repoPath: platform.barePath,
      python: "python3",
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

test("修复环:红→专职会话修复→推新提交→新流水线绿→等待合入", async () => {
  // "流水线直至全绿是最终目标"(用户拍板)。修复本身是纯提示词:
  // 专职会话拿失败日志干活;宿主只做等待(带预算)、事实(绑 SHA)、
  // 刹车(轮数/新提交)三件提示词干不了的事。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed");        // 第一跑红,之后默认绿
  platform.nextPipelineLog = "BUILD FAILURE: NotifyServiceTest 断言失败";
  await platform.start();
  const model = new ScriptedModelServer(
    [...walkScript(true), ...repairScenes(true)],
    "scripted-v1", { linear: true });
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
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
  const model = new ScriptedModelServer([
    ...walkScript(true),
    { text: "诊断:流水线要求 sonar.yaml,需在质量平台为本仓开通配置;"
        + "配好后重跑即可。这不是本仓代码能修的,我不做无关改动。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
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
  const model = new ScriptedModelServer([
    ...walkScript(true),
    { text: "诊断:需要在质量平台配 sonar.yaml,不是代码问题。" },
    { text: "外部配置已就绪,续推收口。" },        // 重跑的重建会话
  ], "scripted-v1", { linear: true });
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
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
    assert.equal(task.delivery?.loop, undefined, "停机账本已清");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("修复环默认不限轮:三连红一路修到绿,没有人为断头", async () => {
  // 用户拍板"不应该有最大轮数限制,都该尽力修好"。老默认 2 轮在
  // 第三轮红时就 exhausted 了;现在不配就是不限,修到绿为止。
  const platform = new FakeGitPlatform();
  // 顺带证明知识块:仓里两篇,失败日志里的"覆盖率"该召唤出对应那篇,
  // 另一篇(前端)不该到场——知识在仓不在平台,命中才占上下文。
  platform.initBare(makeSourceRepo({
    "coverage.md": "---\ntriggers: 覆盖率, coverage\n---\n覆盖率补齐要写真断言,"
      + "本仓禁止用 @Generated 排除。",
    "frontend.md": "---\ntriggers: 前端, React\n---\n组件一律函数式。",
  }), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed", "failed", "failed");
  platform.nextPipelineLog = "BUILD FAILURE: 覆盖率 62% 未达标";
  await platform.start();
  const model = new ScriptedModelServer(
    [...walkScript(true), ...repairScenes(true),
     ...repairScenes(true), ...repairScenes(true)],
    "scripted-v1", { linear: true });
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:不限轮修复").id;
    await until(() => service.get(id)!.status === "await_merge",
      "三轮修复后全绿", 120_000);
    const task = service.get(id)!;
    assert.equal(task.delivery?.loop?.round, 3, "第三轮才绿,老默认早断头了");
    assert.equal(task.delivery?.loop?.max, undefined, "不限轮不记假上限");
    assert.equal(task.delivery?.loop?.state, "green");
    // 使命升级在场:分诊、专职分派、诊断出口;第 2 轮起带上一轮失败对比
    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    assert.match(seen, /先分诊再动手/);
    assert.match(seen, /定位先于修改/, "定位这一步必须写死在使命里");
    assert.match(seen, /定位依据/, "定位要交依据,不许凭猜改");
    assert.match(seen, /专职子 agent/);
    assert.match(seen, /诊断出口/);
    assert.match(seen, /上一轮修复后流水线仍红/);
    // 知识块:失败日志里的"覆盖率"召唤出对应那篇,前端那篇不该到场
    assert.match(seen, /禁止用 @Generated 排除/, "命中的知识块要进开场白");
    assert.ok(!seen.includes("组件一律函数式"), "没命中的不占上下文");
    // 仓库地图同场证明:开场白里有地图标题
    assert.match(seen, /仓库地图/, "地图该在会话开场");
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
  const model = new ScriptedModelServer(
    [...walkScript(true), ...repairScenes(true)],
    "scripted-v1", { linear: true });
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
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

test("流水线代行验证:环境事实进每次会话的开场,修复会话也不例外", async () => {
  // "先不编译了,直接上流水线"(用户拍板)。旗子只做一件事:把环境事实
  // 告诉模型,别让它在没有构建链的机器上白撞。重建/修复会话没有旧上下文,
  // 漏带一次它就会再去撞一遍编译——所以断言两个会话都看到了。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed");
  await platform.start();
  const model = new ScriptedModelServer(
    [...walkScript(true), ...repairScenes(true)],
    "scripted-v1", { linear: true });
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: KERNEL_ROOT,
      repoPath: platform.barePath,
      python: "python3",
    },
    delivery: { platformUrl: platform.baseUrl, repairRounds: 2 },
    verifyViaPipeline: true,
  });
  try {
    const id = service.create("交付 REQ9:流水线代行").id;
    await until(() => service.get(id)!.status === "await_merge", "修复后全绿");
    const firstUser = (at: number) => JSON.stringify(
      ((model.requests[at] as any).messages ?? [])
        .filter((m: any) => m.role === "user")[0]?.content ?? "");
    // 首跑会话(请求 0)与修复会话(请求 2)的开场都带环境事实
    assert.match(firstUser(0), /交流水线/);
    assert.match(firstUser(2), /交流水线/);
    assert.match(firstUser(2), /没跑就不许报数字/, "免编译形态下不许编数字");
    assert.match(firstUser(2), /唯一的使命/, "修复使命也在场");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("分支没推 → 不硬造 MR,原因明说", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  try {
    const { task } = await runTask(platform, false);
    assert.equal(task.status, "completed");
    assert.match(task.delivery?.skipped ?? "", /未推送/);
    assert.equal(platform.mergeRequests.length, 0);
  } finally {
    await platform.stop();
  }
});
