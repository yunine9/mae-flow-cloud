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
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeSourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mfc-dsrc-"));
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "config", "user.email", "bot@test");
  git(dir, "config", "user.name", "bot");
  writeFileSync(join(dir, "README.md"), "# demo\n");
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
) {
  return new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson,
    // host 指向裸仓:克隆即从"服务端"取码。kernelRoot 不参与本测
    // (bootstrap 会跑,INACTIVE 全放行;状态文件由剧本伪造)。
    host: {
      kernelRoot: process.env.MAE_FLOW_HOME
        ?? join(process.cwd(), "..", "mae-flow"),
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
) {
  const model = new ScriptedModelServer([...walkScript(push), ...extraScenes]);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson(), poll);
  const created = service.create("交付 REQ9:演练交付链");
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

test("修复环:会话没产生新提交 → 停下请人工,不再烧轮", async () => {
  // 修复会话自己判断"这红灯不该由改码解决"是合法结局——但同一 SHA
  // 修过一轮还红,再派就是无人看管的烧钱环,必须刹车。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed", "failed");
  await platform.start();
  const model = new ScriptedModelServer([
    ...walkScript(true),
    { text: "失败原因是平台配置,不是代码问题,我不做无关改动。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const service = buildService(platform, dataDir, model.modelsJson(),
    { repairRounds: 2 });
  try {
    const id = service.create("交付 REQ9:修复环刹车").id;
    await until(() =>
      service.get(id)!.delivery?.loop?.state === "halted", "刹车落账");
    const task = service.get(id)!;
    assert.equal(task.status, "verifying", "如实停在验证中,不假装有结论");
    assert.match(task.delivery?.pipeline ?? "", /未产生新提交/);
    assert.equal(task.delivery?.loop?.round, 1, "只烧了一轮");
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
