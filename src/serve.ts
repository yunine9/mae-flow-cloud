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
import { LocalAuth } from "./auth.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

const DEMO_SCRIPT: Scene[] = [
  { text: "先跑专项编译",
    tool: { name: "bash", input: { command: "echo BUILD SUCCESS" } } },
  { tool: { name: "AskUserQuestion",
            input: { questions: [{ question: "未提交 Diff 通过吗?",
                                   options: ["通过", "打回"] }] } } },
  { text: "COMPILE_RESULT: PASS 按决定继续交付" },
];

/**
 * 配置文件(--config <file.json>):键 = 去掉 "--" 的 flag 名,
 * 值 = 字符串/数字/布尔/数组。命令行永远压过文件——排障时临时改一个
 * 参数不必动文件。文件坏了直接拒启,不静默忽略:带着一半配置起服,
 * 比不起服更害人(你以为切了真件,其实还在假件上)。
 *
 * 为什么不用环境变量堆:十几个 MAE_FLOW_* 散在 systemd 单元里没法
 * review;一个 JSON 文件即配置面清单,git 里能 diff(密钥除外——
 * apiKey 类仍走 secrets.env / models.json,权限 600,永不进仓)。
 */
const CONFIG: Record<string, unknown> = (() => {
  const index = process.argv.indexOf("--config");
  if (index < 0) return {};
  const path = process.argv[index + 1];
  if (!path) {
    console.error("[serve] --config 需要文件路径");
    process.exit(2);
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("顶层必须是对象");
    }
    console.log(`[serve] 配置文件: ${resolve(path)}`);
    return parsed as Record<string, unknown>;
  } catch (error) {
    console.error(`[serve] 配置文件读取失败,拒绝启动: ${String(error)}`);
    process.exit(2);
  }
})();

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index > 0 && process.argv[index + 1] !== undefined) {
    return process.argv[index + 1];
  }
  const fromFile = CONFIG[name.replace(/^--/, "")];
  return fromFile === undefined ? undefined : String(fromFile);
}

/** 开关参数(无值);配置文件里写布尔 true。 */
function has(name: string): boolean {
  return process.argv.includes(name)
    || CONFIG[name.replace(/^--/, "")] === true;
}

/** 可重复参数(如 --isolate-volume a:b --isolate-volume c:d);
 * 配置文件里写数组。命令行给了就整组压过文件,不做合并——半边文件
 * 半边命令行的挂载列表没人能排障。 */
function flags(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((argument, index) => {
    if (argument === name && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
    }
  });
  if (values.length) return values;
  const fromFile = CONFIG[name.replace(/^--/, "")];
  return Array.isArray(fromFile) ? fromFile.map(String) : [];
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
  // 云端服务默认静音内核桌面弹窗:该被叫的是控制台前的人,不是跑服务的
  // 那台机器。内核默认开弹窗,是为"人坐在终端旁"的单机场景设计的;放到
  // 服务里,同一台机器上跑几单就弹几倍的通知,而真正的送达通道是待办与
  // 小鲁班。要恢复单机手感就加 --desktop-notify。
  if (has("--desktop-notify")) {
    // TaskService 默认闸静音(防的是测试/probe 把用户 mac 弹一串),
    // 这里显式声明"人就在这台机器旁",闸才放行。
    process.env.MAE_FLOW_DESKTOP_NOTIFY = "1";
  } else {
    process.env.MAE_FLOW_NO_NOTIFY = "1";
  }
  // 告诉内核:用户不在这台机器上。内核的提示词默认"用户就坐在这里"——
  // 会让他去 IDE 里检视代码、把现场面板的本机绝对路径念给他听。这些话
  // 是被模型原样转述给用户的(内核为面板路径专门加过转述义务),而在
  // 控制台里那个路径他打不开、IDE 也不存在,材料本来就在页面上。
  // 用户实测撞到这个:"还让去 ide 检视代码,明显不对了"。
  process.env.MAE_FLOW_HOST = "cloud";
  const port = Number(flag("--port") ?? 8787);
  const dataDir = resolve(flag("--data") ?? join(REPO_ROOT, ".tasks"));
  // 管理旋钮(主 spec §4:最大并发由管理员配置,超出排队)。
  const maxConcurrent = Number(flag("--max-concurrent") ?? 2);
  // 主动压缩节奏(事件量为代理,回合间隙以内核锚点压缩;0=关,
  // 被动保底 pi 自动压缩始终在)。
  const compactEvery = Number(flag("--compact-every") ?? 150);

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

  // 本地账号是控制台身份源。生产首次启动必须从环境变量注入管理员
  // 密码；演示模式给固定演示密码并醒目标注，避免把随机密码藏在日志里。
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  if (!auth.hasUsers()) {
    const adminUser = process.env.MAE_FLOW_ADMIN_USER ?? "admin";
    const adminPassword = process.env.MAE_FLOW_ADMIN_PASSWORD
      ?? (modelsPath ? "" : "mae-flow-demo");
    if (!adminPassword) {
      throw new Error(
        "首次启动需设置 MAE_FLOW_ADMIN_PASSWORD(至少 10 个字符)",
      );
    }
    auth.bootstrapAdmin(adminUser, adminPassword);
    if (!modelsPath) {
      console.log("[serve] 演示登录: admin / mae-flow-demo");
    } else {
      console.log(`[serve] 已创建管理员账号: ${adminUser}`);
    }
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
  // 交付链的三个预算旋钮:修复轮(默认 2,0=关)、轮询间隔(默认 10s,
  // 内网按 CLI 开销放宽)、轮询预算(默认 30 分钟)。只暴露数值,
  // "无限等待"这种取值不存在——预算的存在性不是配置项。
  const pace = {
    repairRounds: flag("--repair-rounds") !== undefined
      ? Number(flag("--repair-rounds")) : undefined,
    pollIntervalMs: flag("--poll-interval") !== undefined
      ? Number(flag("--poll-interval")) * 1000 : undefined,
    pollTimeoutMs: flag("--poll-timeout") !== undefined
      ? Number(flag("--poll-timeout")) * 1000 : undefined,
  };
  for (const [key, value] of Object.entries(pace)) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      console.error(`[serve] ${key} 必须是非负数字,拒绝启动`);
      process.exit(2);
    }
  }
  if (platformUrl) {
    delivery = { platformUrl, ...pace };
    console.log(`[serve] 交付平台: ${platformUrl}`);
  } else if (host && has("--fake-platform")) {
    const platform = new FakeGitPlatform();
    platform.initBare(host.repoPath, dataDir);
    await platform.start();
    host = { ...host, repoPath: platform.barePath };
    delivery = { platformUrl: platform.baseUrl, ...pace };
    console.log(`[serve] 假 Git 平台已就位(裸仓远端): ${platform.baseUrl}`);
  }

  // --pg 开启 PostgreSQL 投影(主 spec §11):看板/审计/恢复引导的
  // 读侧。纯旁路——没配一切照旧,配了写失败也不影响流程。
  const pgUrl = flag("--pg");
  const projection = pgUrl
    ? new PgProjection(pgUrl, (message) => console.log(`  ${message}`))
    : undefined;
  if (projection) console.log(`[serve] PostgreSQL 投影已接线`);

  // 通知端点:--luban <endpoint> 接真件;不配则起假小鲁班。原来这里
  // 永远起假件——部署手册写着"换 endpoint 零改动",代码里却没有那个
  // 口子,真件根本切不过去(盘配置面时逮住的缺口)。
  // --luban-header "Name: value"(可重复)带鉴权头;头的值是密钥,
  // 建议放配置文件并把文件权限设 600,别写进 systemd 单元。
  let lubanEndpoint = flag("--luban");
  if (lubanEndpoint) {
    console.log(`[serve] 小鲁班真件: ${lubanEndpoint}`);
  } else {
    const luban = new FakeLubanServer();
    await luban.start();
    lubanEndpoint = luban.endpoint;
    console.log(`[serve] 假小鲁班已就位,消息可查: ${luban.endpoint.replace("/notify", "")}`);
  }
  const lubanHeaders: Record<string, string> = {};
  for (const header of flags("--luban-header")) {
    const at = header.indexOf(":");
    if (at <= 0) {
      console.error(`[serve] --luban-header 需要 "名字: 值" 形状,拿到: ${header}`);
      process.exit(2);
    }
    lubanHeaders[header.slice(0, at).trim()] = header.slice(at + 1).trim();
  }

  // 容器隔离:--isolate-image <镜像> 让 bash 命令进任务专属容器
  // (镜像按试点仓选,Java 仓即 maven:3.8-eclipse-temurin-8)。
  const isolateImage = flag("--isolate-image");
  if (isolateImage) console.log(`[serve] 容器隔离: ${isolateImage}`);

  // --verify-via-pipeline:本地不做编译/UT,流水线是唯一裁判。
  // 适用于宿主没有构建链、也不想供养容器镜像的部署形态——慢的代价
  // 由修复环扛(红灯自动派修复会话),不占人的时间。
  const verifyViaPipeline = has("--verify-via-pipeline");
  if (verifyViaPipeline) {
    if (!delivery) {
      console.error("[serve] --verify-via-pipeline 需要流水线在场:"
        + "请同时配 --platform 或 --fake-platform,否则没人裁判。");
      process.exit(2);
    }
    console.log("[serve] 本地验证关闭:编译/UT 交由流水线,红灯走修复环");
  }

  const service = new TaskService({
    dataDir, provider, model, modelsJson, maxConcurrent,
    compactEveryEvents: compactEvery,
    contract: demoContract,
    host,
    delivery,
    verifyViaPipeline,
    isolation: isolateImage
      ? {
          image: isolateImage,
          volumes: flags("--isolate-volume"),
          memory: flag("--isolate-memory"),
          cpus: flag("--isolate-cpus"),
          user: flag("--isolate-user"),
        }
      : undefined,
    notifier: new Notifier({ endpoint: lubanEndpoint, headers: lubanHeaders }),
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
  const server = createTaskServer(service, { webRoot, auth });
  server.listen(port, "127.0.0.1", () => {
    const actual = (server.address() as AddressInfo).port;
    console.log(`[serve] http://127.0.0.1:${actual}  (数据目录 ${dataDir})`);
  });
}

main().catch((error) => {
  console.error("[serve] 启动失败:", error);
  process.exit(1);
});
