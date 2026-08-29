/**
 * 人工重跑推送前编译(用户 2026-08-27 拍板)。实锤场景:部署重启杀掉
 * 在途编译轮,任务停在 verifying、prepush 停在 preparing+active_attempt,
 * 而「重跑续推」按 verifying 在途拒绝——人对着僵尸现场没有任何出路。
 * 契约:真在跑(prepushActive)拒绝并明说,兼作活性探针;passed 不许
 * 重跑(那是绕收据);僵尸现场接受后由交付链的 recovered 转移收口旧
 * attempt 并起新轮。停止是合并语义(用户拍板"把停止变为停止并直推
 * 流水线"):中止收口后立刻绑 HEAD 跳过续跑。另验:编译槽位排队真相
 * 要写进 prepush.message,不能只活在任务 detail 里(实锤被当成卡死)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskControlError, TaskService } from "../src/taskService.ts";
import { PRE_PUSH_STATE_SCHEMA } from "../src/prePushVerification.ts";

async function until<T>(probe: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-prepush-retry-"));
  const git = (...args: string[]) => execFileSync(
    "git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
  git("init", "--quiet", "-b", "master");
  git("config", "user.name", "bot");
  git("config", "user.email", "bot@test");
  writeFileSync(join(cwd, "README.md"), "baseline\n");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    current: "external_verify",
    config: { "分支名": "master_bot", "基线分支": "master" },
  }));
  git("add", "README.md", ".mae-flow.json");
  git("commit", "--quiet", "-m", "baseline");
  return { cwd, git };
}

/** 重启杀掉在途轮留下的现场:preparing + active_attempt,进程内无锁。 */
function zombiePrepush(sha: string) {
  return {
    schema: PRE_PUSH_STATE_SCHEMA,
    state: "preparing" as const,
    round: 4,
    message: "正在为最终工作区准备编译与单元测试",
    sha,
    workspace_fingerprint: "stale",
    updated_at: new Date().toISOString(),
    checks: {
      compile: { state: "pending" },
      unit_test: { state: "pending" },
    },
    active_attempt: {
      id: "attempt-killed-by-restart",
      started_at: new Date().toISOString(),
    },
  };
}

async function taskWithRepo() {
  const model = new ScriptedModelServer([
    { text: "首轮完成。" }, { text: "备用。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-prepush-retry-data-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create("prepush 人工重跑演练").id;
  await until(() => service.get(id)?.status === "completed"
    ? true : undefined, "首轮会话收口");
  const repo = repository();
  const internal = (service as any).tasks.get(id);
  internal.cwd = repo.cwd;
  return { service, model, id, internal, repo };
}

test("僵尸现场可重跑:收口旧 attempt 后新轮真验证到 passed", async () => {
  const { service, model, id, internal, repo } = await taskWithRepo();
  try {
    const head = repo.git("rev-parse", "HEAD");
    internal.summary.status = "verifying";
    internal.summary.delivery = { prepush: zombiePrepush(head) };

    const summary = await service.retryPrePush(id);
    assert.equal(summary.status, "verifying");
    assert.match(summary.detail ?? "", /人工重跑推送前编译/);

    // retryPrePush 踢的 tryDeliver 在无平台配置下会早退(测试环境无
    // host);这里直接走 preparePush 验证交付链对僵尸现场的收口语义:
    // recovered 清掉死 attempt,新 attempt 真跑 runner 并收口 passed。
    let ran = 0;
    (service as any).options.prepush = {
      enabled: true,
      runner: async (request: { sha: string }) => {
        ran += 1;
        return { status: "passed", sha: request.sha, message: "编译与 UT 通过" };
      },
    };
    assert.equal(await (service as any).preparePush(
      internal, "master_bot", "master", internal.controlEpoch ?? 0), true);
    assert.equal(ran, 1, "僵尸现场必须重新起真验证,不许复用死 attempt");
    const prepush = internal.summary.delivery.prepush;
    assert.equal(prepush.state, "passed");
    assert.equal(prepush.active_attempt, undefined, "收口后不许残留在途 attempt");
  } finally {
    await model.stop();
  }
});

test("真在跑拒绝(活性探针);passed/无现场/状态不符都拒", async () => {
  const { service, model, id, internal, repo } = await taskWithRepo();
  try {
    const head = repo.git("rev-parse", "HEAD");
    internal.summary.status = "verifying";
    internal.summary.delivery = { prepush: zombiePrepush(head) };

    // 进程内有在途轮:拒绝,并把"正在进行"说破——这句拒绝就是活性答案。
    internal.prepushActive = Promise.resolve(false);
    await assert.rejects(service.retryPrePush(id), (error: Error) => {
      assert.ok(error instanceof TaskControlError);
      assert.match(error.message, /正在进行/);
      return true;
    });
    internal.prepushActive = undefined;

    // passed 是收据,不许用"重跑"绕掉。
    internal.summary.delivery.prepush.state = "passed";
    await assert.rejects(service.retryPrePush(id), TaskControlError);
    internal.summary.delivery.prepush.state = "preparing";

    // running 的任务(编码会话在跑)不许从旁路重启 prepush。
    internal.summary.status = "running";
    await assert.rejects(service.retryPrePush(id), TaskControlError);
    internal.summary.status = "verifying";

    // 没有 prepush 现场就没有可重跑的对象。
    internal.summary.delivery = undefined;
    await assert.rejects(service.retryPrePush(id), TaskControlError);
  } finally {
    await model.stop();
  }
});

test("停止并直推:排队中的轮出队收口,随即绑 HEAD 跳过续跑", async () => {
  const { service, model, id, internal, repo } = await taskWithRepo();
  try {
    const head = repo.git("rev-parse", "HEAD");
    internal.summary.status = "verifying";
    internal.summary.delivery = {
      prepush: { ...zombiePrepush(head), active_attempt: undefined },
    };

    // 没有在途轮时停止要拒绝——那种局面走重跑/跳过,不走停止。
    await assert.rejects(service.stopPrePush(id), TaskControlError);

    // 占满槽位让本轮排队,runner 永远不该被执行。
    let ran = 0;
    (service as any).options.prepush = {
      enabled: true,
      runner: async (request: { sha: string }) => {
        ran += 1;
        return { status: "passed", sha: request.sha, message: "不该跑到这" };
      },
    };
    (service as any).activePrePushBuilds =
      (service as any).prePushBuildSlotCount();
    const pending = (service as any).preparePush(
      internal, "master_bot", "master", internal.controlEpoch ?? 0);
    await until(() => internal.prepushActive ? true : undefined, "在途锁挂上");

    const summary = await service.stopPrePush(id);
    assert.equal(await pending, false, "被停止的轮本身不许放行");
    assert.equal(ran, 0, "排队即停,runner 不许执行");
    // 合并语义:停机账落完立刻走跳过链路——绑当下 HEAD 的
    // user_skipped,任务回队续跑,交付走到 preparePush 时放行给流水线。
    const prepush = internal.summary.delivery.prepush;
    assert.equal(prepush.state, "user_skipped");
    assert.equal(prepush.sha, head, "跳过必须绑停止拍板时刻的 HEAD");
    assert.equal(prepush.active_attempt, undefined);
    // retry 落队后任务泵立刻接手,queued 窗口极短——只断言"在续跑",
    // 不钉具体瞬时状态。
    assert.ok(["queued", "running", "completed"].includes(summary.status),
      `跳过后任务应回队续跑而不是躺平,实际 ${summary.status}`);
    (service as any).activePrePushBuilds = 0;
    // 续跑会话收口,别让后台泵在测试退出后裸奔。
    await until(() => service.get(id)?.status === "completed"
      ? true : undefined, "停止并直推后的续跑收口");
  } finally {
    await model.stop();
  }
});

test("编译槽位排队真相进 prepush.message,出队后换成启动文案", async () => {
  const { service, model, id, internal, repo } = await taskWithRepo();
  try {
    const head = repo.git("rev-parse", "HEAD");
    internal.summary.status = "verifying";
    internal.summary.delivery = {
      prepush: { ...zombiePrepush(head), active_attempt: undefined },
    };

    // 占满唯一槽位再排队:气泡读的是 prepush.message,排队必须写进去。
    (service as any).activePrePushBuilds =
      (service as any).prePushBuildSlotCount();
    const waiting = (service as any).acquirePrePushBuildSlot(
      internal, internal.controlEpoch ?? 0) as Promise<(() => void) | undefined>;
    assert.match(internal.summary.delivery.prepush.message,
      /排队等待编译槽位/);

    // 释放一个槽位:排队者拿到资源,文案换成"已获得…启动",不再挂排队。
    (service as any).activePrePushBuilds -= 1;
    (service as any).releasePrePushBuildSlot()();
    const release = await waiting;
    assert.ok(release, "排队者必须拿到槽位");
    assert.match(internal.summary.delivery.prepush.message,
      /已获得编译槽位/);
    release!();
  } finally {
    await model.stop();
  }
});
