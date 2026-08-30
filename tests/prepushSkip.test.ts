/**
 * 跳过推送前验证(用户 2026-08-27 拍板):失败停机后由人显式拍板
 * 直推流水线裁决——本地验证是省流水线的前闸,权威在绑 SHA 流水线。
 * 契约:仅失败停机可跳;跳过绑当下 HEAD;同 HEAD 放行不起验证 Agent;
 * 新提交后跳过失效;通过态不许跳(那是绕收据,不是接手)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskControlError, TaskService } from "../src/taskService.ts";
import {
  PRE_PUSH_STATE_SCHEMA,
  sameRevision,
} from "../src/prePushVerification.ts";

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
  const cwd = mkdtempSync(join(tmpdir(), "mfc-prepush-skip-"));
  const git = (...args: string[]) => execFileSync(
    "git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
  git("init", "--quiet", "-b", "master");
  git("config", "user.name", "bot");
  git("config", "user.email", "bot@test");
  writeFileSync(join(cwd, "README.md"), "baseline\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "baseline");
  return { cwd, git };
}

function blockedPrepush(sha: string) {
  return {
    schema: PRE_PUSH_STATE_SCHEMA,
    state: "blocked" as const,
    round: 2,
    message: "编译失败:符号未定义",
    sha,
    workspace_fingerprint: "stale",
    updated_at: new Date().toISOString(),
    checks: {
      compile: { state: "failed" },
      unit_test: { state: "pending" },
    },
  };
}

async function failedTask() {
  const model = new ScriptedModelServer([
    { text: "首轮完成。" }, { text: "重跑完成。" }, { text: "备用。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-prepush-skip-data-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create("prepush 跳过演练").id;
  await until(() => service.get(id)?.status === "completed"
    ? true : undefined, "首轮会话收口");
  const repo = repository();
  const internal = (service as any).tasks.get(id);
  internal.cwd = repo.cwd;
  internal.summary.status = "failed";
  internal.summary.delivery = { prepush: blockedPrepush("f".repeat(40)) };
  return { service, model, id, internal, repo };
}

test("失败停机可跳:绑当下 HEAD,同 HEAD 放行不起验证 Agent", async () => {
  const { service, model, id, internal, repo } = await failedTask();
  try {
    await service.skipPrePushVerification(id, "zhangsan");
    const prepush = service.get(id)!.delivery!.prepush!;
    assert.equal(prepush.state, "user_skipped");
    assert.equal(prepush.sha, repo.git("rev-parse", "HEAD"),
      "跳过必须绑拍板时刻的 HEAD");
    assert.match(prepush.message, /流水线裁决/);
    // 跳过是三道闸里最重的人工拍板,现场必须答得出"谁点的"。
    assert.equal(prepush.skipped_by, "zhangsan");
    assert.match(prepush.message, /zhangsan/);

    // retry 链路已把任务送回队列续跑;等它收口(重跑会话会把 cwd
    // 换成剧本工作区,测试仓要重新指回)。
    await until(() => service.get(id)?.status === "completed"
      ? true : undefined, "跳过后的重跑收口");
    internal.cwd = repo.cwd;

    // 同 HEAD:preparePush 放行,绝不该调用验证执行器。
    (service as any).options.prepush = {
      enabled: true,
      runner: async () => {
        throw new Error("同 HEAD 跳过后不该再起验证 Agent");
      },
    };
    assert.equal(
      await (service as any).preparePush(
        internal, "master_bot", "master", internal.controlEpoch ?? 0),
      true);

    // 新提交:跳过失效(旧拍板不背书新代码)。
    writeFileSync(join(repo.cwd, "src.txt"), "new\n");
    repo.git("add", "src.txt");
    repo.git("commit", "--quiet", "-m", "new code");
    const revision = await (service as any).prePushRevision(internal);
    assert.equal(sameRevision(prepush, revision), false,
      "HEAD 变化后 sameRevision 必须失配,preparePush 会走真验证");
  } finally {
    await model.stop();
  }
});

test("没有失败停机就不许跳:通过态/无验证都拒", async () => {
  const { service, model, id, internal } = await failedTask();
  try {
    internal.summary.delivery.prepush.state = "passed";
    await assert.rejects(
      service.skipPrePushVerification(id), TaskControlError);
    internal.summary.delivery = undefined;
    await assert.rejects(
      service.skipPrePushVerification(id), TaskControlError);
  } finally {
    await model.stop();
  }
});
