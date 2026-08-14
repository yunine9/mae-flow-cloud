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
import { dockerAvailable } from "../src/containerRuntime.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

const DOCKER = await dockerAvailable();
const SKIP = DOCKER ? false : "docker daemon 不可用;起 Colima/Docker 后重跑";
const IMAGE = "alpine";

if (DOCKER) {
  // 镜像预拉:拉取时间不算进用例,拉不下来在这里就炸清楚。
  execFileSync("docker", ["pull", "-q", IMAGE], { stdio: "ignore" });
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
      isolation: { image: IMAGE },
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
      const gone = Date.now() + 15_000;
      for (;;) {
        const leftovers = execFileSync("docker",
          ["ps", "-q", "--filter", `name=mfc-${created.id}`],
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
