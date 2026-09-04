/**
 * prepush 进程恢复：持久化阶段不是活性证明。serve 重启会失去 Promise、
 * driver 和 container，新进程必须把旧 attempt 当作中断并启动新一轮。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrePushRunRequest, PrePushRunResult } from "../src/prepushAgent.ts";
import { PRE_PUSH_STATE_SCHEMA } from "../src/prePushVerification.ts";
import { TaskService, type TaskStatus } from "../src/taskService.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function interruptedTask(
  status: TaskStatus,
  activeAttempt = true,
  staleReviewLoop = false,
): { dataDir: string; cwd: string; oldAttempt?: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-prepush-recover-"));
  const workspace = join(dataDir, "task-1");
  const cwd = join(workspace, "origin");
  mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "--quiet", "-b", "master");
  git(cwd, "config", "user.name", "bot");
  git(cwd, "config", "user.email", "bot@test");
  writeFileSync(join(cwd, "README.md"), "recovery fixture\n");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    current: "external_verify",
    config: {
      "单号": "REQ_PREPUSH_RECOVERY",
      "分支名": "master_bot_REQ_PREPUSH_RECOVERY",
      "基线分支": "master",
    },
  }));
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "fixture");
  const sha = git(cwd, "rev-parse", "HEAD");
  const oldAttempt = activeAttempt ? "attempt-from-dead-serve" : undefined;
  writeFileSync(join(workspace, "task.json"), JSON.stringify({
    cwd,
    summary: {
      id: "task-1",
      requirement: "恢复被部署中断的 prepush",
      workspace,
      status,
      created_at: "2026-08-29T00:00:00.000Z",
      delivery: {
        ...(staleReviewLoop ? {
          loop: {
            state: "halted",
            kind: "review",
            round: 0,
            max: 20,
            diagnosis: "部署前的旧停机结论",
            workspace_review_pending: true,
            workspace_review_recheck_required: true,
            workspace_review_annotation_ids: ["an-await-author"],
          },
        } : {}),
        prepush: {
          schema: PRE_PUSH_STATE_SCHEMA,
          state: "preparing",
          round: 2,
          message: "旧 serve 正在准备编译",
          sha,
          workspace_fingerprint: "dead-process-snapshot",
          updated_at: "2026-08-29T00:01:00.000Z",
          checks: {
            compile: { state: "pending" },
            unit_test: { state: "pending" },
          },
          ...(oldAttempt ? {
            active_attempt: {
              id: oldAttempt,
              started_at: "2026-08-29T00:01:00.000Z",
            },
          } : {}),
        },
      },
    },
  }, null, 2));
  return { dataDir, cwd, oldAttempt };
}

test("恢复 Build-Fix 会撤销旧停机态，但保留待作者复核的检视账", async () => {
  const fixture = interruptedTask("verifying", true, true);
  const control = controlledRunner();
  const current = service(fixture.dataDir, control.runner);
  assert.equal(current.recover().requeued, 1);
  const request = await control.request;
  const live = current.get("task-1")!;
  assert.equal(live.delivery?.loop?.state, "verifying");
  assert.equal(live.delivery?.loop?.workspace_review_pending, true);
  assert.equal(live.delivery?.loop?.workspace_review_recheck_required, true);
  assert.deepEqual(live.delivery?.loop?.workspace_review_annotation_ids,
    ["an-await-author"]);
  assert.notEqual(live.focus?.kind, "blocked");

  control.finish({
    status: "infrastructure_failure",
    sha: request.sha,
    message: "测试主动收口恢复轮",
  });
  await until(() => current.get("task-1")?.status === "failed", "恢复轮收口");
});

function controlledRunner() {
  let started!: (request: PrePushRunRequest) => void;
  let finish!: (result: PrePushRunResult) => void;
  const request = new Promise<PrePushRunRequest>((resolve) => { started = resolve; });
  const runner = (input: PrePushRunRequest): Promise<PrePushRunResult> => {
    started(input);
    return new Promise<PrePushRunResult>((resolve) => { finish = resolve; });
  };
  return { runner, request, finish: (result: PrePushRunResult) => finish(result) };
}

function service(dataDir: string, runner: ReturnType<typeof controlledRunner>["runner"]) {
  return new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: {},
    host: { kernelRoot: dataDir, python: "python3" },
    // 地址只需存在：本用例用环境失败在 host push 前收口。
    delivery: { platformUrl: "http://127.0.0.1:1" },
    prepush: { enabled: true, runner },
  });
}

async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

for (const [status, activeAttempt] of [
  ["running", true],
  ["verifying", true],
  ["verifying", false],
  ["failed", true],
] as const) {
  test(`自动恢复 ${status}+preparing${activeAttempt ? "+active_attempt" : ""}`,
    async () => {
      const fixture = interruptedTask(status, activeAttempt);
      const control = controlledRunner();
      const current = service(fixture.dataDir, control.runner);
      const recovered = current.recover();
      assert.equal(recovered.requeued, 1);
      const request = await control.request;
      assert.equal(request.taskId, "task-1");
      const live = current.get("task-1")!;
      assert.equal(live.status, "running");
      assert.equal(live.delivery?.prepush_runtime?.state, "running");
      assert.notEqual(live.delivery?.prepush?.active_attempt?.id,
        fixture.oldAttempt, "新 serve 不得复用死进程的 attempt");

      control.finish({
        status: "infrastructure_failure",
        sha: request.sha,
        message: "测试主动收口恢复轮",
      });
      await until(() => current.get("task-1")?.status === "failed", "恢复轮收口");
      const stopped = current.get("task-1")!;
      assert.equal(stopped.delivery?.prepush?.state, "environment_error");
      assert.equal(stopped.delivery?.prepush_runtime?.state, "stopped");
    });
}

test("连续两次部署重启：每个新 serve 都重新取得 prepush 所有权", async () => {
  const fixture = interruptedTask("running");
  const firstControl = controlledRunner();
  const first = service(fixture.dataDir, firstControl.runner);
  first.recover();
  const firstRequest = await firstControl.request;
  const firstAttempt = first.get("task-1")!.delivery?.prepush?.active_attempt?.id;
  assert.ok(firstAttempt);

  // 模拟进程被部署直接杀死：旧回调仍留在测试进程里，但 epoch/current
  // 已失效，之后即使返回也不得再改 task.json。
  (first as any).shuttingDown = true;
  const secondControl = controlledRunner();
  const second = service(fixture.dataDir, secondControl.runner);
  assert.equal(second.recover().requeued, 1);
  const secondRequest = await secondControl.request;
  const secondSnapshot = second.get("task-1")!;
  assert.equal(secondSnapshot.delivery?.prepush_runtime?.state, "running");
  assert.notEqual(secondSnapshot.delivery?.prepush?.active_attempt?.id,
    firstAttempt, "第二次部署必须收口第一台 serve 的 attempt 并另起一轮");

  secondControl.finish({
    status: "infrastructure_failure",
    sha: secondRequest.sha,
    message: "第二台 serve 测试收口",
  });
  await until(() => second.get("task-1")?.status === "failed", "第二轮收口");
  firstControl.finish({
    status: "infrastructure_failure",
    sha: firstRequest.sha,
    message: "迟到的旧进程结果",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(second.get("task-1")!.delivery?.prepush?.message ?? "", /第二台/);
});

test("恢复时代码现场丢失：明确停成环境异常而不是 preparing 僵尸", () => {
  const fixture = interruptedTask("running");
  const taskPath = join(fixture.dataDir, "task-1", "task.json");
  const missing = join(fixture.dataDir, "missing-origin");
  const saved = JSON.parse(readFileSync(taskPath, "utf-8"));
  saved.cwd = missing;
  writeFileSync(taskPath, JSON.stringify(saved, null, 2));
  let calls = 0;
  const current = service(fixture.dataDir, async (request) => {
    calls += 1;
    return { status: "passed", sha: request.sha, message: "不应执行" };
  });
  const recovered = current.recover();
  assert.equal(recovered.requeued, 0);
  assert.equal(calls, 0);
  const task = current.get("task-1")!;
  assert.equal(task.status, "failed");
  assert.equal(task.delivery?.prepush?.state, "environment_error");
  assert.equal(task.delivery?.prepush_runtime?.state, "stopped");
  assert.match(task.detail ?? "", /代码现场不存在/);
});
