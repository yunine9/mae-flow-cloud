/**
 * 启动任务服务。默认演示模式:内置剧本假模型,浏览器打开首页即可
 * 发任务→看进度→点审批走完整环。接真模型(GLM-5.1):
 *
 *   npm run serve -- --models /path/to/models.json --provider glm --model glm-5.1
 *
 * models.json 形状见 README「接真模型」。数据目录默认 .tasks/。
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { ScriptedModelServer, type Scene } from "./scriptedModel.ts";
import { TaskService } from "./taskService.ts";
import { createTaskServer } from "./server.ts";
import { FakeLubanServer, Notifier } from "./notifier.ts";
import { FakeGitPlatform } from "./gitPlatform.ts";
import { PgProjection } from "./projection.ts";
import type { GateDecision } from "./gateService.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

const DEMO_SCRIPT: Scene[] = [
  { text: "先跑专项编译",
    tool: { name: "bash", input: { command: "echo BUILD SUCCESS" } } },
  { tool: { name: "AskUserQuestion",
            input: { questions: [{ question: "未提交 Diff 通过吗?",
                                   options: ["通过", "打回"] }] } } },
  { text: "COMPILE_RESULT: PASS 按决定继续交付" },
];

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

function demoContract(
  _tool: string,
  value: string,
): GateDecision | undefined {
  if (value.includes("rm -rf")) {
    return { action: "deny", reason: "危险命令被 mae-flow 门禁打回" };
  }
  return undefined;
}

async function main(): Promise<void> {
  const port = Number(flag("--port") ?? 8787);
  const dataDir = resolve(flag("--data") ?? join(REPO_ROOT, ".tasks"));
  // 管理旋钮(主 spec §4:最大并发由管理员配置,超出排队)。
  const maxConcurrent = Number(flag("--max-concurrent") ?? 2);

  let modelsJson: Record<string, unknown>;
  let provider = flag("--provider") ?? "maeflow";
  let model = flag("--model") ?? "scripted-v1";
  const modelsPath = flag("--models");
  if (modelsPath) {
    modelsJson = JSON.parse(readFileSync(modelsPath, "utf-8"));
    console.log(`[serve] 使用真模型配置: ${modelsPath} (${provider}/${model})`);
  } else {
    // 演示模式每次白纸起步(剧本假设新场);真模型模式保数据,
    // 重启靠 recover() 续命——先 rm 再 recover 是自相矛盾。
    rmSync(dataDir, { recursive: true, force: true });
    const scripted = new ScriptedModelServer(DEMO_SCRIPT);
    await scripted.start();
    modelsJson = scripted.modelsJson();
    console.log("[serve] 演示模式:内置剧本假模型(接真模型用 --models)");
  }

  // --repo 开启内核纵向闭环:任务=克隆该仓+内核 bootstrap+深层门禁。
  const repoPath = flag("--repo");
  let host = repoPath
    ? {
        kernelRoot: process.env.MAE_FLOW_HOME
          ?? resolve(REPO_ROOT, "..", "mae-flow"),
        repoPath: resolve(repoPath),
        python: "python3",
      }
    : undefined;
  if (host) console.log(`[serve] 内核模式:试点仓 ${host.repoPath}`);

  // Git 交付链:--platform <url> 接真件(内网 MR/流水线网关);
  // --fake-platform 本地起假件——从 --repo 灌一个裸仓当远端,
  // 推送/MR/流水线全环回,与 pilot 同款(部署手册的切换点在此落地)。
  let delivery: { platformUrl: string } | undefined;
  const platformUrl = flag("--platform");
  if (platformUrl) {
    delivery = { platformUrl };
    console.log(`[serve] 交付平台: ${platformUrl}`);
  } else if (host && process.argv.includes("--fake-platform")) {
    const platform = new FakeGitPlatform();
    platform.initBare(host.repoPath, dataDir);
    await platform.start();
    host = { ...host, repoPath: platform.barePath };
    delivery = { platformUrl: platform.baseUrl };
    console.log(`[serve] 假 Git 平台已就位(裸仓远端): ${platform.baseUrl}`);
  }

  // --pg 开启 PostgreSQL 投影(主 spec §11):看板/审计/恢复引导的
  // 读侧。纯旁路——没配一切照旧,配了写失败也不影响流程。
  const pgUrl = flag("--pg");
  const projection = pgUrl
    ? new PgProjection(pgUrl, (message) => console.log(`  ${message}`))
    : undefined;
  if (projection) console.log(`[serve] PostgreSQL 投影已接线`);

  // 小鲁班用假件模拟(内网真件就绪时换 endpoint,其余零改动)。
  const luban = new FakeLubanServer();
  await luban.start();
  console.log(`[serve] 假小鲁班已就位,消息可查: ${luban.endpoint.replace("/notify", "")}`);

  // 容器隔离:--isolate-image <镜像> 让 bash 命令进任务专属容器
  // (镜像按试点仓选,Java 仓即 maven:3.8-eclipse-temurin-8)。
  const isolateImage = flag("--isolate-image");
  if (isolateImage) console.log(`[serve] 容器隔离: ${isolateImage}`);

  const service = new TaskService({
    dataDir, provider, model, modelsJson, maxConcurrent,
    contract: demoContract,
    host,
    delivery,
    isolation: isolateImage ? { image: isolateImage } : undefined,
    notifier: new Notifier({ endpoint: luban.endpoint }),
    projection,
    linkBase: `http://127.0.0.1:${port}`,
    log: (message) => console.log(`  [task] ${message}`),
  });
  // 进程可死任务不死:重启后重建索引,在跑的任务续跑,等人的继续等。
  const recovered = service.recover();
  if (recovered.restored) {
    console.log(`[serve] 恢复任务 ${recovered.restored} 个`
      + `(重新入队 ${recovered.requeued} 个)`);
  }
  // 正式前端:--web <dist> 显式指定;web/dist 存在时自动接上
  // (构建过就用正式版,没构建就是零构建演示页,永远有页面可开)。
  const webRoot = flag("--web")
    ?? [join(REPO_ROOT, "web", "dist")].find((dir) =>
         existsSync(join(dir, "index.html")));
  if (webRoot) console.log(`[serve] 正式前端: ${webRoot}`);
  const server = createTaskServer(service, { webRoot });
  server.listen(port, "127.0.0.1", () => {
    const actual = (server.address() as AddressInfo).port;
    console.log(`[serve] http://127.0.0.1:${actual}  (数据目录 ${dataDir})`);
  });
}

main().catch((error) => {
  console.error("[serve] 启动失败:", error);
  process.exit(1);
});
