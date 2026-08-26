/**
 * 等人期间释放任务容器的语义契约。
 *
 * 要解决的真问题:一张审批卡挂一晚上,8g 内存和 pids 名额就被占一
 * 晚上;10~20 人共用一台机器时这会把后面排队的单堵死。
 *
 * 但"省资源"不能换来任何一条静默降级,所以下面这些判据一条都不能少:
 * - 真等人才释放,自动交卷不做"停了再开"的无用功;
 * - 释放只影响容器,会话(pi 停在工具调用里)必须原封不动;
 * - 重开必须用同一套挂载/限额/label,不能悄悄换隔离参数;
 * - 释放失败只记不抛(旁路 fail-open),重开失败必须抛(不许回宿主)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService, type TaskContainerFactoryInput } from "../src/taskService.ts";
import { FakeTaskContainerHarness } from "./support/fakeTaskContainer.ts";

function newService(containerFactory: any, log?: (message: string) => void) {
  return new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-idle-")),
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
    maxConcurrent: 0,
    log,
    isolation: { image: "fixture/builder:test", containerFactory },
  });
}

/** 造一个"已在跑、容器已起"的任务,不经过真会话。 */
async function runningTask(service: any, requirement = "等人释放容器") {
  const created = service.create(requirement);
  const task = service.tasks.get(created.id);
  task.containerWorkspace = created.workspace;
  task.container = await service.startCodingContainer(task);
  return { created, task };
}

function waitingRecord(taskId: string, questions: unknown[]) {
  return {
    waiting_id: `${taskId}-w1`,
    task_id: taskId,
    step: "coding",
    call_id: "call-1",
    question: { questions },
    state_version: 1,
    status: "waiting" as const,
    decision: "",
    notes: "",
    created_at: new Date().toISOString(),
    resolved_at: "",
    reminders: 0,
  };
}

test("真·等人时释放容器,但会话句柄原封不动", async () => {
  const containers = new FakeTaskContainerHarness();
  const service: any = newService(containers.factory);
  const { created, task } = await runningTask(service);
  // 会话是活的:pi 停在 AskUserQuestion 的 execute 里等决定。
  const driver = {
    marker: "live-session",
    abort: async () => undefined,
    dispose: () => undefined,
  };
  task.driver = driver;

  await service.settleTurn(task, Promise.resolve({
    status: "waiting_for_human",
    // 没有 questions ⇒ autoAnswerFor 返回 undefined ⇒ 走真等人分支。
    waiting: waitingRecord(created.id, []),
  }));

  assert.equal(service.get(created.id)?.status, "waiting_for_human");
  assert.equal(containers.records[0]?.stopped, true, "等人期间容器必须停掉");
  assert.equal(task.container, undefined);
  assert.equal(task.driver, driver, "释放容器不能顺手把会话也拆了");
  await service.shutdown();
});

test("自动交卷不释放容器:马上就要接着跑,别做停了再开的无用功", async () => {
  const containers = new FakeTaskContainerHarness();
  const service: any = newService(containers.factory);
  const { created, task } = await runningTask(service);
  // 有 questions + 下单预选答案 ⇒ autoAnswerFor 命中。
  service.autoAnswerFor = () => ({ why: "下单预选", answers: {}, notes: "" });
  service.autoDecide = async () => undefined;

  await service.settleTurn(task, Promise.resolve({
    status: "waiting_for_human",
    waiting: waitingRecord(created.id, [{ question: "选哪个", options: ["A"] }]),
  }));

  assert.equal(containers.records[0]?.stopped, false,
    "自动交卷路径不该释放容器");
  assert.equal(task.container !== undefined, true);
  await service.shutdown();
});

test("释放后第一条 Bash 把容器重新开起来,挂载与限额和第一次一致", async () => {
  const seen: TaskContainerFactoryInput[] = [];
  const containers = new FakeTaskContainerHarness();
  const service: any = newService((input: TaskContainerFactoryInput) => {
    seen.push(input);
    return containers.factory(input);
  });
  const { task } = await runningTask(service);

  await service.releaseIdleContainer(task, "等待人工决定");
  assert.equal(task.container, undefined);

  const reopened = await service.activeTaskContainer(task);
  assert.equal(task.container, reopened);
  assert.equal(seen.length, 2);
  assert.deepEqual(
    { name: seen[1].name, workspace: seen[1].workspace, limits: seen[1].limits,
      volumes: seen[1].volumes, labels: seen[1].options.labels },
    { name: seen[0].name, workspace: seen[0].workspace, limits: seen[0].limits,
      volumes: seen[0].volumes, labels: seen[0].options.labels },
    "重开必须用同一套隔离参数,不能悄悄换掉");
  await service.shutdown();
});

test("快速审批撞上容器回收时,第一条 Bash 等旧实例删净再重开", async () => {
  let releaseStop!: () => void;
  let markStopStarted!: () => void;
  const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
  const stopStarted = new Promise<void>((resolve) => { markStopStarted = resolve; });
  let creations = 0;
  const service: any = newService(() => {
    creations += 1;
    const first = creations === 1;
    return {
      start: async () => undefined,
      exec: async () => ({ exitCode: 0 }),
      stop: async () => {
        if (!first) return;
        markStopStarted();
        await stopGate;
      },
    };
  });
  const { task } = await runningTask(service);

  const releasing = service.releaseIdleContainer(task, "等待人工决定");
  await stopStarted;
  const reopening = service.activeTaskContainer(task);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(creations, 1,
    "旧容器仍在回收时不得创建同名新实例");

  releaseStop();
  await releasing;
  const reopened = await reopening;
  assert.equal(creations, 2);
  assert.equal(task.container, reopened);
  await service.shutdown();
});

test("一个回合里并发的多条 Bash 只开一个容器", async () => {
  let creations = 0;
  const containers = new FakeTaskContainerHarness();
  const service: any = newService((input: TaskContainerFactoryInput) => {
    creations += 1;
    return containers.factory(input);
  });
  const { task } = await runningTask(service);
  await service.releaseIdleContainer(task, "等待人工决定");
  creations = 0;

  const all = await Promise.all([
    service.activeTaskContainer(task),
    service.activeTaskContainer(task),
    service.activeTaskContainer(task),
  ]);
  assert.equal(creations, 1, "并发重开只能创建一个容器");
  assert.equal(new Set(all).size, 1);
  await service.shutdown();
});

test("重开落定时任务已被暂停/取消,新容器就地回收不挂到任务上", async () => {
  const containers = new FakeTaskContainerHarness();
  const service: any = newService(containers.factory);
  const { task } = await runningTask(service);
  await service.releaseIdleContainer(task, "等待人工决定");

  const pending = service.activeTaskContainer(task);
  task.controlEpoch += 1;          // 用户此刻按下暂停
  await assert.rejects(pending, /已暂停或取消/);
  assert.equal(task.container, undefined, "暂停后不许把容器挂回任务");
  assert.equal(containers.records.at(-1)?.stopped, true, "落单的容器必须自毁");
  await service.shutdown();
});

test("释放失败只记不抛(旁路 fail-open),容器句柄照样清掉", async () => {
  const logs: string[] = [];
  const service: any = newService(
    () => ({
      start: async () => undefined,
      exec: async () => ({ exitCode: 0 }),
      stop: async () => { throw new Error("docker daemon 抽风"); },
    }),
    (message) => logs.push(message));
  const { task } = await runningTask(service);

  await service.releaseIdleContainer(task, "等待人工决定");
  assert.equal(task.container, undefined);
  assert.match(logs.join("\n"), /释放容器失败.*下次执行会重新开/);
  await service.shutdown().catch(() => undefined);
});

test("重开失败必须抛给这条 Bash,绝不落回宿主执行", async () => {
  let first = true;
  const service: any = newService(() => {
    if (first) {
      first = false;
      return { start: async () => undefined, exec: async () => ({ exitCode: 0 }),
        stop: async () => undefined };
    }
    return {
      start: async () => { throw new Error("镜像拉不到"); },
      exec: async () => ({ exitCode: 0 }),
      stop: async () => undefined,
    };
  });
  const { task } = await runningTask(service);
  await service.releaseIdleContainer(task, "等待人工决定");

  await assert.rejects(service.activeTaskContainer(task), /镜像拉不到/);
  assert.equal(task.container, undefined);
  // 失败不能把重入锁焊死:环境恢复后下一条命令还得能再试。
  assert.equal(task.containerReopen, undefined);
  await service.shutdown();
});
