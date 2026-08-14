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
  poll?: { pollIntervalMs?: number; pollTimeoutMs?: number },
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
  poll?: { pollIntervalMs?: number; pollTimeoutMs?: number },
  dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-")),
) {
  const model = new ScriptedModelServer(walkScript(push));
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

test("流水线红 → 验证中,不标完成", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "failed";
  await platform.start();
  try {
    const { task } = await runTask(platform, true);
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

test("异步流水线:红灯留痕,任务停在验证中不标完成", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "running";
  await platform.start();
  try {
    const { task, service } = await runTask(
      platform, true, { pollIntervalMs: 100 });
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
