/**
 * 并发×隔离语义(2026-08-14 容器误杀事故的钉子):
 * - 跨实例不误杀:两个 TaskService(不同 dataDir)的任务都叫 task-1,
 *   容器名靠 dataDir 指纹区分——一方启动时的 rm -f 清孤儿绝不能
 *   碰到另一方活着的容器。事故形态:同名 mfc-task-1 撞名被清,
 *   容器内命令中途死掉;所以"sleep 后产物仍写出来"就是存活证明,
 *   光看任务 completed 不够(容器被杀剧本照样收口,实测语义)。
 * - 同实例串行复用:先后两个任务容器名不同,收口后无残留。
 * 机器上没有 docker daemon 时整套跳过并明说。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { dockerAvailable, taskContainerInstance } from "../src/containerRuntime.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

const DOCKER = await dockerAvailable();
const IMAGE = process.env.MFC_REAL_BUILD_IMAGE ?? process.env.MFC_TEST_IMAGE ?? "";
let SKIP: false | string =
  !DOCKER ? "docker daemon 不可用;起 Colima/Docker 后重跑"
    : !IMAGE
      ? "未指定非 root 任务镜像;设置 MFC_REAL_BUILD_IMAGE 后重跑"
      : false;

if (DOCKER && IMAGE) {
  // 拉不到不许炸整个文件(同 isolation.test.ts 的注):内网有 docker
  // 却上不了公网仓库是常态,显式 skip 说清怎么补,别报成代码红灯。
  try {
    try {
      execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
    } catch {
      execFileSync("docker", ["pull", "-q", IMAGE], { stdio: "ignore" });
    }
    const user = execFileSync("docker", [
      "image", "inspect", "--format", "{{.Config.User}}", IMAGE,
    ], { encoding: "utf-8" }).trim();
    if (!user || /^(?:root|0)(?::|$)/i.test(user)) {
      SKIP = `镜像 ${IMAGE} 的 Config.User=${user || "<空>"}，不满足非 root 隔离契约`;
    }
  } catch {
    SKIP = `镜像 ${IMAGE} 本地不存在且拉不到(内网通常上不了公网仓库):`
      + "用 MFC_TEST_IMAGE 指一个本地已有/内部仓的镜像后重跑";
  }
}

/** 现场必须放在 $HOME 下(isolation.test.ts 同款坑注):macOS 的
 * docker VM 默认只挂载 $HOME,/var/folders 在 VM 里是空目录。 */
function makeDataDir(prefix: string): string {
  const scratch = join(homedir(), ".cache", "mae-flow-cloud-tests");
  mkdirSync(scratch, { recursive: true });
  return mkdtempSync(join(scratch, prefix));
}

function fingerprint(dataDir: string): string {
  return taskContainerInstance(dataDir).namePrefix;
}

/** 存活证明剧本:sleep 横跨对方启动窗口,产物在 sleep 之后才落盘
 * ——容器中途被杀,产物必然缺席。 */
function survivalScript(artifact: string): Scene[] {
  return [
    { text: "睡一觉再留证",
      tool: { name: "bash",
              input: { command: `sleep 3; echo alive > ${artifact}` } } },
    { text: "执行完毕。" },
  ];
}

async function untilDone(
  service: TaskService, id: string, timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (service.get(id)!.status !== "completed") {
    if (Date.now() > deadline) {
      throw new Error(`任务未收口: ${JSON.stringify(service.get(id))}`);
    }
    await new Promise((tick) => setTimeout(tick, 100));
  }
}

async function untilNoContainers(
  instance: string, timeoutMs = 15_000,
): Promise<void> {
  const gone = Date.now() + timeoutMs;
  for (;;) {
    const leftovers = execFileSync("docker",
      ["ps", "-q", "--filter", `name=mfc-${instance}-`],
      { encoding: "utf-8" }).trim();
    if (!leftovers) return;
    if (Date.now() > gone) {
      assert.fail(`收口 ${timeoutMs / 1000}s 后实例 ${instance} 仍有容器在跑`);
    }
    await new Promise((tick) => setTimeout(tick, 200));
  }
}

test("跨实例不误杀:两个实例的 task-1 并发跑,互不清对方容器",
  { skip: SKIP }, async () => {
    const dataDirA = makeDataDir("mfc-conc-a-");
    const dataDirB = makeDataDir("mfc-conc-b-");
    // 各实例各配各的剧本假模型:场景消费是有状态的,不共用。
    const modelA = new ScriptedModelServer(survivalScript("a.txt"));
    const modelB = new ScriptedModelServer(survivalScript("b.txt"));
    await modelA.start();
    await modelB.start();
    const serviceA = new TaskService({
      dataDir: dataDirA, provider: "maeflow", model: "scripted-v1",
      modelsJson: modelA.modelsJson(),
      isolation: { image: IMAGE, cacheRoot: join(dataDirA, "build-cache") },
    });
    const serviceB = new TaskService({
      dataDir: dataDirB, provider: "maeflow", model: "scripted-v1",
      modelsJson: modelB.modelsJson(),
      isolation: { image: IMAGE, cacheRoot: join(dataDirB, "build-cache") },
    });
    try {
      // 背靠背发起:B 的容器启动(含 rm -f 清孤儿)落在 A 的
      // sleep 窗口里——事故要复发,这里必炸。
      const taskA = serviceA.create("演练:实例 A 的任务");
      const taskB = serviceB.create("演练:实例 B 的任务");
      assert.equal(taskA.id, "task-1");
      assert.equal(taskB.id, "task-1", "两实例任务同名才构成撞名场景");
      // 指纹必须不同——同名任务的容器名由它区分。
      const instanceA = fingerprint(dataDirA);
      const instanceB = fingerprint(dataDirB);
      assert.notEqual(instanceA, instanceB, "dataDir 指纹撞了");
      await Promise.all([
        untilDone(serviceA, taskA.id),
        untilDone(serviceB, taskB.id),
      ]);
      // 存活证明:sleep 之后写的产物都在=谁也没被谁清掉。
      const aliveA = join(taskA.workspace, "a.txt");
      const aliveB = join(taskB.workspace, "b.txt");
      assert.ok(existsSync(aliveA), "实例 A 的容器中途死了(产物缺席)");
      assert.ok(existsSync(aliveB), "实例 B 的容器中途死了(产物缺席)");
      assert.match(readFileSync(aliveA, "utf-8"), /alive/);
      assert.match(readFileSync(aliveB, "utf-8"), /alive/);
      // 收口后各自无残留。
      await untilNoContainers(instanceA);
      await untilNoContainers(instanceB);
    } finally {
      await modelA.stop();
      await modelB.stop();
    }
  });

test("同实例串行复用:task-1/task-2 容器名不同,先后收口无残留",
  { skip: SKIP }, async () => {
    const dataDir = makeDataDir("mfc-serial-");
    // 剧本按"会话内位置"选场景,新会话从头重放(实测:两任务排
    // 四幕戏,第二单只会又演一遍第一幕)。所以用自相似剧本:
    // 每个任务重放同一幕,在各自工作区留证。
    const model = new ScriptedModelServer([
      { text: "留证",
        tool: { name: "bash", input: { command: "echo mark > proof.txt" } } },
      { text: "完毕。" },
    ]);
    await model.start();
    const service = new TaskService({
      dataDir, provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(),
      isolation: { image: IMAGE, cacheRoot: join(dataDir, "build-cache") },
    });
    try {
      const first = service.create("演练:第一单");
      await untilDone(service, first.id);
      const second = service.create("演练:第二单");
      await untilDone(service, second.id);
      assert.notEqual(first.id, second.id, "同实例任务号必须递增");
      assert.ok(existsSync(join(first.workspace, "proof.txt")));
      assert.ok(existsSync(join(second.workspace, "proof.txt")));
      await untilNoContainers(fingerprint(dataDir));
    } finally {
      await model.stop();
    }
  });
