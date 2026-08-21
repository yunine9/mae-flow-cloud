/**
 * 容器隔离语义(容器隔离设计):
 * - bash 命令在任务专属容器里执行——宿主 Darwin 而 uname 出 Linux,
 *   这就是隔离的直接证据;
 * - 工作区同路径挂载:容器内命令产出的文件,宿主(文件工具/内核)
 *   看得见;
 * - 任务收口后容器销毁,不留孤儿。
 * 机器上没有 docker daemon 时整套跳过并明说。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { dockerAvailable, taskContainerInstance } from "../src/containerRuntime.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

const DOCKER = await dockerAvailable();
// 镜像可换:内网拉不到公网 alpine,指一个内部仓的等价小镜像即可
// (要有 sh;容器隔离验的是"真进容器",跟发行版无关)。
const IMAGE = process.env.MFC_REAL_BUILD_IMAGE ?? process.env.MFC_TEST_IMAGE ?? "";
let SKIP: false | string =
  !DOCKER ? "docker daemon 不可用;起 Colima/Docker 后重跑"
    : !IMAGE
      ? "未指定非 root 任务镜像;设置 MFC_REAL_BUILD_IMAGE 后重跑"
      : false;

if (DOCKER && IMAGE) {
  // 镜像预拉:拉取时间不算进用例。**拉不到不许炸整个文件**——内网
  // 有 docker 但没有公网仓库是常态,那是环境不具备不是代码有病,
  // 按仓里的诚实纪律显式 skip 并说清怎么补(内网首跑实测踩到:
  // 整个用例文件在顶层 throw,报成两条红灯,吓人且误导)。
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

const SCRIPT: Scene[] = [
  { text: "看看执行环境",
    tool: { name: "bash",
            input: { command: "uname -s > where.txt; cat where.txt" } } },
  { text: "执行完毕。" },
];

test("bash 进容器执行;产物宿主可见;收口后容器销毁", { skip: SKIP },
  async () => {
    // 现场必须放在 $HOME 下:macOS 的 docker VM(Colima 等)默认只
    // 挂载 $HOME,系统临时目录(/var/folders)在 VM 里是空目录——
    // 挂载"成功"但两边看到的不是同一份文件(实测)。Linux 无此坑。
    const scratch = join(homedir(), ".cache", "mae-flow-cloud-tests");
    mkdirSync(scratch, { recursive: true });
    const dataDir = mkdtempSync(join(scratch, "mfc-isolate-"));
    const model = new ScriptedModelServer(SCRIPT);
    await model.start();
    const service = new TaskService({
      dataDir,
      provider: "maeflow",
      model: "scripted-v1",
      modelsJson: model.modelsJson(),
      // 真实部署的 --isolate-cache-root 永远有值(默认 <data>/build-cache)。
      // 不给缓存挂载时统一构建镜像的 entrypoint 会因 /cache/* 不可写退 73,
      // 那是这里造出来的、线上不存在的配置——夹具必须照着真形态搭。
      isolation: { image: IMAGE, cacheRoot: join(dataDir, "build-cache") },
    });
    try {
      const created = service.create("演练:确认命令在容器里跑");
      const deadline = Date.now() + 60_000;
      while (service.get(created.id)!.status !== "completed") {
        if (Date.now() > deadline) {
          throw new Error(
            `任务未收口: ${JSON.stringify(service.get(created.id))}`);
        }
        await new Promise((tick) => setTimeout(tick, 100));
      }
      // 宿主是 Darwin,容器里 uname 必须是 Linux——隔离的直接证据。
      assert.equal(platform(), "darwin", "本用例的前提:宿主非 Linux");
      const events = readFileSync(
        service.eventLogPath(created.id), "utf-8");
      assert.match(events, /Linux/);
      // 同路径挂载:容器内写的文件,宿主看得见。
      const artifact = join(created.workspace, "where.txt");
      assert.ok(existsSync(artifact), "容器产物在宿主不可见");
      assert.match(readFileSync(artifact, "utf-8"), /Linux/);
      // 收口后容器销毁。清理是异步旁路(不许卡收口),等它一拍。
      // 容器名带 dataDir 指纹(防跨实例误杀),按同一规则拼出来查。
      const instance = taskContainerInstance(dataDir).namePrefix;
      const gone = Date.now() + 15_000;
      for (;;) {
        const leftovers = execFileSync("docker",
          ["ps", "-q", "--filter", `name=mfc-${instance}-${created.id}`],
          { encoding: "utf-8" }).trim();
        if (!leftovers) break;
        if (Date.now() > gone) {
          assert.fail("任务收口 15s 后容器仍在跑");
        }
        await new Promise((tick) => setTimeout(tick, 200));
      }
    } finally {
      await model.stop();
    }
  });
