/**
 * 启动任务服务。默认演示模式:内置剧本假模型,浏览器打开首页即可
 * 发任务→看进度→点审批走完整环。接真模型(GLM-5.1):
 *
 *   npm run serve -- --models /path/to/models.json --provider glm --model glm-5.1
 *
 * models.json 形状见 README「接真模型」。数据目录默认 .tasks/。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { ScriptedModelServer, type Scene } from "./scriptedModel.ts";
import { discoverKernelRoot } from "./kernelDiscovery.ts";
import {
  DEFAULT_WORKSPACE_RETENTION_DAYS,
  TaskService,
} from "./taskService.ts";
import { humanBytes } from "./workspaceReclaim.ts";
import { createTaskServer } from "./server.ts";
import { FakeLubanServer, Notifier } from "./notifier.ts";
import {
  loadLubanPluginToken,
  lubanApprovalCode,
  LubanApprovalGateway,
} from "./lubanApproval.ts";
import { FakeGitPlatform } from "./gitPlatform.ts";
import { IssueFlowService } from "./issueFlow/service.ts";
import { createGoOpsTools } from "./issueFlow/opsTools.ts";
import {
  McpDtsGateway,
  McpGateway,
  UnconfiguredDtsGateway,
  type DtsGateway,
} from "./issueFlow/gateways.ts";
import { PgProjection } from "./projection.ts";
import type { GateDecision } from "./gateService.ts";
import { LocalAuth } from "./auth.ts";
import { RuntimeSettings } from "./settings.ts";
import { resolveContainerUser } from "./containerRuntime.ts";
import {
  acquireInstanceLock,
  INSTANCE_LOCK_FILE,
  InstanceLockedError,
} from "./instanceLock.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

// 断管免疫要装在**第一行输出之前**(下面 CONFIG 的模块级初始化就会
// console.log):装晚一步,启动期的日志就有机会成为死因。
muzzleBrokenPipes();

const DEMO_SCRIPT: Scene[] = [
  { text: "先确认工作区状态",
    tool: { name: "bash", input: { command: "git status --short" } } },
  { tool: { name: "AskUserQuestion",
            input: { questions: [{ question: "当前改动可以继续交付吗?",
                                   options: ["通过", "打回"] }] } } },
  { text: "已按你的决定继续交付。" },
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

/** 内核解释器选择:MAE_FLOW_PYTHON 显式指定 > 启动时真跑一次探测。
 * Windows 的 python3 常是应用商店的执行别名桩——`--version` 有回显、
 * 真执行却无输出直接失败(2026-08-25 本机实测 rc=49),内核 dispatch
 * 挂上去整条链都起不来。坏桩回落到 python;都探测不动就保留缺省值,
 * 内核链失败会带着原始报错如实报告,不静默换解释器。 */
function resolveKernelPython(): string {
  const override = process.env.MAE_FLOW_PYTHON;
  if (override?.trim()) return override.trim();
  const candidates = process.platform === "win32"
    ? ["python3", "python"] : ["python3"];
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ["-c", "print(1)"],
        { encoding: "utf-8", timeout: 15_000 });
      if (probe.status === 0 && probe.stdout.toString().trim() === "1") {
        return candidate;
      }
    } catch {
      // 超时/找不到都继续试下一个候选。
    }
  }
  return "python3";
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

/** 选中的模型有没有声明上下文窗口(pi 的 models.json 原样透传,
 * contextWindow 是它自己的字段)。读不动一律当"没声明"——这只是
 * 一句启动提醒,不许因为配置形状意外把服务拦下。 */
function declaresContextWindow(
  modelsJson: Record<string, unknown>,
  provider: string,
  model: string,
): boolean {
  try {
    const providers = (modelsJson as { providers?: Record<string, any> })
      .providers ?? {};
    const models = (providers[provider]?.models ?? []) as Array<
      { id?: string; contextWindow?: number }>;
    const entry = models.find((item) => item?.id === model) ?? models[0];
    return typeof entry?.contextWindow === "number" && entry.contextWindow > 0;
  } catch {
    return false;
  }
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
  const bindHost = flag("--host") ?? "127.0.0.1";
  const publicUrlFlag = flag("--public-url")?.trim();
  let publicUrl: string | undefined;
  if (publicUrlFlag) {
    try {
      const parsed = new URL(publicUrlFlag);
      if (!/https?:/.test(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error("只接受不含账号密码的 http/https 地址");
      }
      publicUrl = publicUrlFlag.replace(/\/+$/, "");
    } catch (error) {
      console.error(`[serve] --public-url 无效:${String(error)}`);
      process.exit(2);
    }
  }
  const dataDir = resolve(flag("--data") ?? join(REPO_ROOT, ".tasks"));
  mkdirSync(dataDir, { recursive: true });
  // 独占锁必须在碰这个目录的任何东西之前拿到:实例身份就是 dataDir
  // 指纹,起服会按它清扫"本实例"的遗留容器——第二个实例起来的瞬间
  // 就会杀掉第一个正在跑的编译/prepush 容器。这不是抢资源,是踩现场。
  let instanceLock;
  try {
    instanceLock = acquireInstanceLock(dataDir,
      { log: (message) => console.log(`[serve] ${message}`) });
  } catch (error) {
    if (error instanceof InstanceLockedError) {
      console.error(`[serve] 拒绝启动:${error.message}`);
      process.exit(2);
    }
    throw error;
  }
  guardProcess(dataDir);   // 旁路异常不许带走整个服务(见函数注释)
  // 管理旋钮(主 spec §4:最大并发由管理员配置,超出排队)。
  const maxConcurrent = Number(flag("--max-concurrent") ?? 2);
  // 主动压缩节奏(事件量为代理,回合间隙以内核锚点压缩;0=关,
  // 被动保底 pi 自动压缩始终在)。
  const compactEvery = Number(flag("--compact-every") ?? 150);

  // 管理页运行时设置先立起来:模型网关与运行参数
  // 都可能已在界面配过——boot 判定要读它。
  const settings = new RuntimeSettings(
    dataDir, (message) => console.log(`  [settings] ${message}`));

  let modelsJson: Record<string, unknown>;
  let provider = flag("--provider") ?? "maeflow";
  let model = flag("--model") ?? "scripted-v1";
  const modelsPath = flag("--models");
  const settingsModels = settings.models();
  // 演示判定是三态:--models > 管理页配过模型网关 > 才算演示。
  // 曾经"无 --models 即演示"会让最小启动(--data --port)每次重启
  // 清空数据目录——界面配的一切陪葬(用户要 UI 优先形态时逮住)。
  const demoMode = !modelsPath && !settingsModels.json;
  if (modelsPath) {
    modelsJson = JSON.parse(readFileSync(modelsPath, "utf-8"));
    console.log(`[serve] 使用真模型配置: ${modelsPath} (${provider}/${model})`);
  } else if (settingsModels.json) {
    // 模型网关来自管理页:真模式,保数据。launch 时设置层还会现读,
    // 这里只是给部署层一个兜底值。
    modelsJson = settingsModels.json;
    provider = settingsModels.provider ?? provider;
    model = settingsModels.model ?? model;
    console.log(`[serve] 模型网关来自管理页设置 (${provider}/${model})`);
  } else {
    // 演示模式曾经**每次启动静默删光数据目录**(理由:剧本假设新场)。
    // 用户实测踩到:随手起个演示实例指到真数据目录,一条 await_merge
    // 的真单当场没了——"要不要清"这种事不该靠人记住命令的副作用。
    // 现在:清场必须显式 --fresh,且清之前把要删的东西数出来告诉人;
    // 不加 --fresh 就沿用现有数据(演示剧本照跑,顶多列表里有旧单)。
    if (has("--fresh")) {
      const doomed = existsSync(dataDir)
        ? readdirSync(dataDir).filter((name) => name.startsWith("task-")).length
        : 0;
      console.log(`[serve] --fresh:清空数据目录 ${dataDir}`
        + (doomed ? `(含 ${doomed} 个任务现场,不可恢复)` : ""));
      // 逐项删,跳过本进程刚拿到的独占锁。整目录 rmSync 会把锁一起
      // 带走,等于清场期间大门敞开——那正是并发实例踩进来的窗口。
      for (const name of readdirSync(dataDir)) {
        if (name === INSTANCE_LOCK_FILE) continue;
        rmSync(join(dataDir, name), { recursive: true, force: true });
      }
    } else if (existsSync(dataDir)
        && readdirSync(dataDir).some((name) => name.startsWith("task-"))) {
      console.log("[serve] 演示模式沿用现有数据目录(要白纸起步加 --fresh)");
    }
    const scripted = new ScriptedModelServer(DEMO_SCRIPT);
    await scripted.start();
    modelsJson = scripted.modelsJson();
    console.log("[serve] 演示模式:内置剧本假模型(接真模型用 --models)");
  }
  // 窗口没声明就提醒一句(内网实测:网关上限 169984,pi 按自己估的
  // 窗口做自动压缩,估大了就撞硬报错——宿主有一次压缩自愈,但那已经
  // 白跑一轮。声明了 pi 会提前压,根本不撞墙)。只提醒不拦路。
  if (!demoMode && !declaresContextWindow(modelsJson, provider, model)) {
    console.log(
      `[serve] 提示:models.json 里 ${provider}/${model} 没声明 contextWindow`
      + ";网关窗口若小于 pi 的默认估计会撞\"input too long\"硬报错。"
      + "建议按网关真实上限留出余量声明(如上限 169984 → 写 160000)");
  }

  // 本地账号是控制台身份源。生产首次启动必须从环境变量注入管理员
  // 密码；演示模式给固定演示密码并醒目标注，避免把随机密码藏在日志里。
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  if (!auth.hasUsers()) {
    const adminUser = process.env.MAE_FLOW_ADMIN_USER ?? "admin";
    const adminPassword = process.env.MAE_FLOW_ADMIN_PASSWORD
      ?? (demoMode ? "mae-flow-demo" : "");
    if (!adminPassword) {
      throw new Error(
        "首次启动需设置 MAE_FLOW_ADMIN_PASSWORD(至少 10 个字符)",
      );
    }
    auth.bootstrapAdmin(adminUser, adminPassword);
    if (demoMode) {
      // 管理员不发起任务(用户拍板:管理平台与干活是两个角色),
      // 演示必须再给一个开发者账号——只有 admin 的演示是发不了单的。
      auth.createUser("dev", "mae-flow-demo", "developer");
      console.log("[serve] 演示登录: dev / mae-flow-demo(下单用)"
        + "; admin / mae-flow-demo(管理平台,不发起任务)");
    } else {
      console.log(`[serve] 已创建管理员账号: ${adminUser}`
        + "(管理员不发起任务,请为成员建开发者账号)");
    }
  }

  // 内核自动发现:链的语义与顺序见 kernelDiscovery.ts(serve/pilot/
  // 测试共用一条链,不许各写各的)。
  const kernelRoot = discoverKernelRoot(REPO_ROOT);

  // 问题流专用部署(--issue-only):需求流程的重依赖(内核/交付平台/
  // prepush/容器镜像守卫)整体不加载——它们缺配时也不再拒绝启动,
  // 问题处理照常服务。这是对"需求侧配置问题不许拖死问题流"的正面
  // 回答;反过来,没加 --issue-only 的内核模式部署仍按宪法 fail-loud。
  const issueOnly = has("--issue-only");

  // 内核模式开启条件:找得到内核,且用 --repo 钉死单仓(演示/测试)
  // 或明确 --kernel-mode(正式形态,代码仓由开发逐单必填)。
  // --issue-only 压过内核模式:给了两者就按问题流专用跑,并说清楚。
  const repoFlag = flag("--repo");
  const kernelRequested = !!kernelRoot
    && (!!repoFlag || has("--kernel-mode"));
  if (issueOnly && kernelRequested) {
    console.log("[serve] --issue-only 与内核模式同时给出:按问题流专用跑,"
      + "内核/交付平台/prepush 本次不加载(需求流程停用)");
  }
  const kernelMode = !issueOnly && kernelRequested;
  // URL 仓不许过 resolve(会被拼成本地路径,实测毁 URL);本地路径才归一化。
  const repoPath = repoFlag
    ? (/^(https?|ssh|git):\/\//i.test(repoFlag)
        ? repoFlag : resolve(repoFlag))
    : undefined;
  let host = kernelMode
    ? { kernelRoot: kernelRoot!, repoPath, python: resolveKernelPython() }
    : undefined;
  if (host) {
    console.log(`[serve] 内核模式:内核 ${host.kernelRoot}`
      + `,代码仓 ${repoPath ?? "(下单时逐单填写)"}`
      + `,内核 python: ${host.python}`);
  } else if (kernelRoot) {
    console.log("[serve] 内核在场但未开内核模式:演示形态。"
      + "正式部署请加 --kernel-mode；--repo 仅用于钉死单仓的试跑");
  }

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
  // --resolve-discussions:发布检视回复时顺手代点"已解决"。默认不开
  // ——内网既有框架的实证(能力核对报告 D3):resolve 归检视人,
  // 代点是越权;平台/团队明确允许的部署才加这个 flag。
  const resolveDiscussions = has("--resolve-discussions");
  if (platformUrl) {
    delivery = { platformUrl, ...pace,
                 ...(resolveDiscussions ? { resolveDiscussions } : {}) };
    console.log(`[serve] 交付平台: ${platformUrl}`);
  } else if (host && has("--fake-platform")) {
    // 假平台从 --repo 的本地仓灌裸仓;URL 仓/无仓没得灌,如实拒绝。
    if (!host.repoPath || /^(https?|ssh|git):\/\//i.test(host.repoPath)) {
      console.error("[serve] --fake-platform 需要 --repo 指向本地仓(灌裸仓用)");
      process.exit(2);
    }
    const platform = new FakeGitPlatform();
    platform.initBare(host.repoPath, dataDir);
    await platform.start();
    host = { ...host, repoPath: platform.barePath };
    delivery = { platformUrl: platform.baseUrl, ...pace,
                 ...(resolveDiscussions ? { resolveDiscussions } : {}) };
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
  let lubanIsFake = false;
  if (lubanEndpoint) {
    console.log(`[serve] 小鲁班真件: ${lubanEndpoint}`);
  } else if (issueOnly) {
    // 问题流专用部署:通知假件起不来也不许挡住问题处理(需求流程
    // 反正停用,没人消费通知)。完整部署保持 fail-loud 不变。
    try {
      const luban = new FakeLubanServer();
      await luban.start();
      lubanEndpoint = luban.endpoint;
      lubanIsFake = true;
      console.log("[serve] 假小鲁班已就位(问题流专用部署)");
    } catch (error) {
      console.log(`[serve] 假小鲁班启动失败,问题流专用模式继续(通知不可用): ${String(error)}`);
    }
  } else {
    const luban = new FakeLubanServer();
    await luban.start();
    lubanEndpoint = luban.endpoint;
    lubanIsFake = true;  // 假件不索个人令牌(配置门禁据此放行)
    console.log("[serve] 假小鲁班已就位,消息可查: " + luban.endpoint.replace("/notify", ""));
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
  // 手机审批是入站回调，与上面的出站通知令牌是两套身份。Token 只从
  // 0600 文件读，不允许塞进命令行或 JSON 配置的明文字段。
  const lubanPluginTokenFile = flag("--luban-plugin-token-file");
  // Token 只让 Cloud 的接收端点就绪；真实小鲁班是否会把回复送进来是
  // 另一项部署事实。未完成端到端验收时绝不能在通知里承诺“直接回复”。
  const lubanPluginReplies = has("--luban-plugin-replies");
  let lubanPluginToken: string | undefined;
  if (lubanPluginTokenFile) {
    try {
      lubanPluginToken = loadLubanPluginToken(
        resolve(lubanPluginTokenFile));
      console.log("[serve] 小鲁班 Cloud 回调端点已就绪: "
        + "/integrations/luban/plugin");
    } catch (error) {
      console.error(`[serve] 小鲁班插件 Token 无效，拒绝启动: ${String(error)}`);
      process.exit(2);
    }
  }
  if (lubanPluginReplies && !lubanPluginToken) {
    console.error("[serve] --luban-plugin-replies 需要同时配置 "
      + "--luban-plugin-token-file；只有真实入站插件验收通过后才能开启");
    process.exit(2);
  }
  if (lubanPluginToken && !lubanPluginReplies) {
    console.log("[serve] 小鲁班回调端点已就绪，但尚未声明入站回复已接通；"
      + "通知不会提示直接回复序号");
  } else if (lubanPluginReplies) {
    console.log("[serve] 小鲁班入站回复已由部署显式启用；通知将提供手机审批指令");
  }

  // 统一任务执行面:普通编码/修复/子 Agent/推送前编译与 UT 的 Bash
  // 全部进入同一类加固容器。Cloud 控制面、Git 凭据、MR/通知仍留宿主。
  const isolateImage = flag("--isolate-image");
  const isolateMemory = flag("--isolate-memory") ?? "8g";
  const isolateCpus = flag("--isolate-cpus") ?? "8";
  const hostAvailableCpus = availableParallelism();
  const isolatePids = Number(flag("--isolate-pids") ?? "512");
  const isolateNetwork = flag("--isolate-network") ?? "bridge";
  const isolateUser = flag("--isolate-user");
  const isolateCacheRoot = resolve(
    flag("--isolate-cache-root") ?? join(dataDir, "build-cache"),
  );
  const buildSlots = Number(flag("--build-slots") ?? "1");
  const prepushAttemptTimeoutValue = flag("--prepush-attempt-timeout-minutes");
  const prepushAttemptTimeoutMinutes = prepushAttemptTimeoutValue !== undefined
    ? Number(prepushAttemptTimeoutValue) : undefined;
  const prepushBuildTimeoutValue = flag("--prepush-build-timeout-minutes");
  const prepushBuildTimeoutMinutes = prepushBuildTimeoutValue !== undefined
    ? Number(prepushBuildTimeoutValue) : undefined;
  // 现场保留期:终态任务过期后回收克隆等重货,台账原样留下。
  // 以前一条回收策略都没有,dataDir 只涨不消(2026-08-22 查出来的)。
  const retentionDays = Number(
    flag("--workspace-retention-days") ?? String(DEFAULT_WORKSPACE_RETENTION_DAYS));
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    console.error("[serve] --workspace-retention-days 必须是 ≥0 的数字"
      + "(0 = 永不回收),拒绝启动");
    process.exit(2);
  }
  if (!Number.isInteger(isolatePids) || isolatePids <= 0) {
    console.error("[serve] --isolate-pids 必须是正整数,拒绝启动");
    process.exit(2);
  }
  if (!Number.isFinite(Number(isolateCpus)) || Number(isolateCpus) <= 0) {
    console.error("[serve] --isolate-cpus 必须是正数,拒绝启动");
    process.exit(2);
  }
  if (!Number.isInteger(buildSlots) || buildSlots <= 0) {
    console.error("[serve] --build-slots 必须是正整数,拒绝启动");
    process.exit(2);
  }
  for (const [name, value] of [
    ["--prepush-attempt-timeout-minutes", prepushAttemptTimeoutMinutes],
    ["--prepush-build-timeout-minutes", prepushBuildTimeoutMinutes],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      console.error(`[serve] ${name} 必须是正数,拒绝启动`);
      process.exit(2);
    }
  }
  if (/^(?:host|container(?::.*)?)$/i.test(isolateNetwork)) {
    console.error("[serve] --isolate-network 不能使用 host/container 模式,拒绝启动");
    process.exit(2);
  }
  if (isolateUser !== undefined
      && (!isolateUser.trim()
        || /^(?:root|0)(?::|$)/i.test(isolateUser.trim())
        || /:0$/i.test(isolateUser.trim()))) {
    console.error("[serve] --isolate-user 禁止使用 root/0 或空值,拒绝启动");
    process.exit(2);
  }
  // 容器用户在 Linux 上决定工作区文件的宿主属主,配错要到 push 前才炸。
  let containerUser;
  try {
    containerUser = resolveContainerUser({
      configured: isolateUser,
      platform: process.platform,
      uid: process.getuid?.(),
      gid: process.getgid?.(),
    });
  } catch (error) {
    console.error(`[serve] 拒绝启动:${String((error as Error).message)}`);
    process.exit(2);
  }
  if (isolateImage) {
    console.log(`[serve] 统一任务容器: ${isolateImage}`
      + `;memory=${isolateMemory},cpus=${isolateCpus},pids=${isolatePids}`
      + `,network=${isolateNetwork},build-slots=${buildSlots}`
      + `,host-available-cpus=${hostAvailableCpus}`);
    if (Number(isolateCpus) > hostAvailableCpus) {
      console.warn(`[serve] 容器 CPU 上限 ${isolateCpus} 超过服务可用的`
        + ` ${hostAvailableCpus} 个逻辑 CPU；不会获得额外算力，建议按宿主调整`);
    }
    console.log(`[serve] 任务容器用户: ${containerUser.user ?? "镜像默认"}`
      + `(${containerUser.reason})`);
    console.log(`[serve] 分仓构建缓存: ${isolateCacheRoot}`);
  }

  // 历史开关仅保留命令行兼容。内核的最终验证契约仍只有一种：三项
  // 由流水线核销；push 前的服务器编译/UT Agent 是 Cloud 加速层，
  // 不改变该契约，也不让内核新增步骤。
  if (has("--verify-via-pipeline")) {
    console.warn("[serve] --verify-via-pipeline 已弃用并被忽略:"
      + "最终编译、UT 与 CodeCheck 仍固定由流水线核销");
  }
  if (host) {
    // 内核模式下执行契约固定为"三项交流水线",流程必然停在 external_verify
    // 等宿主递事实。没有平台就没人递,每一单都会走到等待点后无人核销——
    // 起服=每单必卡。这条守卫是 --verify-via-pipeline 时代就有的,退役那个
    // 开关时被一并删掉了;契约固定之后它反而更该在,因为现在没有"不走
    // 流水线"的形态可退。宁可拒绝启动,也不要起一台每单都废的服务。
    if (!delivery) {
      console.error(
        "[serve] 内核模式需要交付平台在场:请加 --platform <url> 接真件,"
        + "或 --fake-platform 起本地假件。\n"
        + "        原因:云端执行契约把编译/UT/CodeCheck 交给权威流水线,"
        + "流程会停在 external_verify 等平台事实;没有平台就没人核销,"
        + "每一单都会卡在验证中且无法自愈。");
      process.exit(2);
    }
    if (!isolateImage) {
      console.error(
        "[serve] 内核模式要求统一任务容器:请加 --isolate-image <构建镜像>。\n"
        + "        原因:编码、修复、子 Agent 及 push 前编译/UT 的业务命令"
        + "必须隔离执行；缺少镜像时拒绝静默回退宿主机。\n"
        + "        镜像构建见 deploy/build-image/README.md。",
      );
      process.exit(2);
    }
    console.log("[serve] Cloud 执行契约:所有任务 Bash 进入加固容器;每次 push 前"
      + "由独立 Agent 在新构建容器完成编译与 UT，CodeCheck 和最终复核仍由流水线执行");
  }

  // 提交信息规范:平台 pre-receive 钩子按正则拒收不合规提交(内网
  // 实测),规矩要开场就进提示词。部署级给一句,管理页可热改覆盖。
  const commitConvention = flag("--commit-convention");
  if (commitConvention) {
    console.log(`[serve] 提交信息规范已上膛: ${commitConvention.slice(0, 60)}`
      + (commitConvention.length > 60 ? "…" : ""));
  }

  // 问题流(与需求内核完全分离的会话域):MCP 网关按需接线。
  // token 只从文件读(/etc/mae-flow-cloud/mcp-token,可用
  // --mcp-token-file 覆盖)——命令行/JSON 配置里不许出现明文密钥。
  // 【遗留】DTS MCP 的 URL/工具名待用户提供后对拍;没配就 fail-loud,
  // 页面拉单会如实报"网关未配置",不静默降级。
  const dtsMcpUrl = flag("--dts-mcp-url");
  const mcpTokenFile = flag("--mcp-token-file")
    ?? (existsSync("/etc/mae-flow-cloud/mcp-token")
      ? "/etc/mae-flow-cloud/mcp-token" : undefined);
  let mcpToken: string | undefined;
  if (mcpTokenFile) {
    try {
      mcpToken = readFileSync(mcpTokenFile, "utf-8").trim();
      if (!mcpToken) throw new Error("token 文件为空");
      console.log(`[serve] MCP token 已装载: ${mcpTokenFile}`);
    } catch (error) {
      console.error(`[serve] MCP token 读取失败,拒绝启动: ${String(error)}`);
      process.exit(2);
    }
  }
  if (dtsMcpUrl && !mcpToken) {
    console.error("[serve] 配置了 MCP 网关地址但没有 token:"
      + "请配置 --mcp-token-file(正式服务器为 /etc/mae-flow-cloud/mcp-token)");
    process.exit(2);
  }
  let issueDts: DtsGateway | undefined;
  if (dtsMcpUrl && mcpToken) {
    issueDts = new McpDtsGateway(new McpGateway({
      url: dtsMcpUrl, token: mcpToken,
      log: (message) => console.log(`  [issue-dts] ${message}`),
    }));
    console.log(`[serve] 问题流 DTS 网关: ${dtsMcpUrl}`);
  }
  // 运维工具(拉日志/换库):在场即接上,凭据由保险箱解密后经环境
  // 变量注入子进程(见 src/issueFlow/opsTools.ts)。
  const goToolsDir = join(REPO_ROOT, "assets", "ops-tools");
  const issueFlow = new IssueFlowService({
    dataDir, provider, model, modelsJson, settings,
    gitCredential: (account) => auth.gitCredential(account),
    opsTools: existsSync(join(goToolsDir, process.platform === "win32"
      ? "fetch-logs.exe" : "fetch-logs-linux-amd64"))
      ? createGoOpsTools({
          toolsDir: goToolsDir,
          log: (message) => console.log(`  ${message}`),
        })
      : undefined,
    dts: issueDts ?? new UnconfiguredDtsGateway(),
    // MR 与需求交付共用同一交付平台适配层(--platform)。
    ...(platformUrl ? { platformUrl } : {}),
    maxConcurrentTurns: Number(flag("--issue-max-turns") ?? "2"),
    ...(isolateImage
      ? {
          isolation: {
            image: isolateImage,
            volumes: flags("--isolate-volume"),
            memory: isolateMemory,
            cpus: isolateCpus,
            ...(containerUser.user ? { user: containerUser.user } : {}),
            pidsLimit: isolatePids,
            network: isolateNetwork,
          },
        }
      : {}),
    log: (message) => console.log(`  [issue] ${message}`),
  });

  if (issueOnly) {
    console.log("[serve] 问题流专用模式(--issue-only):需求流程停用"
      + "(发起任务入口会被拦截,在途需求任务不拉起);"
      + "「问题处理」全功能可用");
  }

  // issue-only 下假小鲁班起不来时 endpoint 缺席:通知器整个不接
  // (notifier 是可选项),不让它变成问题流的启动依赖。
  const notifier = lubanEndpoint
    ? new Notifier({
        endpoint: lubanEndpoint,
        headers: lubanHeaders,
        fake: lubanIsFake,
        mobileApproval: lubanPluginReplies,
        approvalCode: lubanPluginReplies && lubanPluginToken
          ? (input) => lubanApprovalCode({ token: lubanPluginToken, ...input })
          : undefined,
        // 发起人的通知令牌:普通任务提醒是自己发给自己；主动邀请检视时，
        // 用责任人的令牌向所选 Committer 工号发送，不要求收件人配令牌。
        personalToken: (account) => auth.lubanToken(account),
      })
    : undefined;

  const service = new TaskService({
    dataDir, provider, model, modelsJson, maxConcurrent, settings,
    ...(issueOnly ? { requirementDisabled: true } : {}),
    // 个人 Git 令牌(界面只写不读):任务启动时按归属人取,经
    // credential helper 注入;没配的用户走部署级访问方式。
    gitCredential: (account) => auth.gitCredential(account),
    // 月光模式:每张卡到达时现读——开着的直行,关了的恢复审批。
    moonlight: (account) => auth.moonlightEnabled(account),
    // push 前清单过目:同样现读个人默认(真人缺省即开)。
    pushConfirmation: (account) => auth.pushConfirmationEnabled(account),
    compactEveryEvents: compactEvery,
    contract: demoContract,
    host,
    delivery,
    // 环境预热编译:隔离模式显式开启(缺席即关,测试形态零意外会话)。
    warmup: host && isolateImage ? { enabled: true } : undefined,
    prepush: host ? {
      enabled: true,
      buildSlots,
      ...(prepushAttemptTimeoutMinutes !== undefined
        ? { attemptTimeoutMs: prepushAttemptTimeoutMinutes * 60_000 } : {}),
      ...(prepushBuildTimeoutMinutes !== undefined
        ? { buildCommandTimeoutMs: prepushBuildTimeoutMinutes * 60_000 } : {}),
    } : undefined,
    workspaceRetentionDays: retentionDays,
    commitConvention,
    isolation: isolateImage
      ? {
          image: isolateImage,
          volumes: flags("--isolate-volume"),
          cacheRoot: isolateCacheRoot,
          memory: isolateMemory,
          cpus: isolateCpus,
          user: containerUser.user,
          pidsLimit: isolatePids,
          network: isolateNetwork,
        }
      : undefined,
    ...(notifier ? { notifier } : {}),
    projection,
    // 正式部署建议固定 public-url；未配置时，服务会从已登录用户的
    // 实际请求 Host 学到内网入口，绝不再默认写死 127.0.0.1。
    linkBase: publicUrl,
    log: (message) => console.log(`  [task] ${message}`),
  });
  // 先清理本 dataDir 实例上次崩溃遗留的 coding/prepush/system-check
  // 容器，再恢复任务。顺序不能反：recover 一旦入队就可能撞上旧容器。
  const swept = await service.sweepOrphanContainers();
  if (swept.removed.length) {
    console.log(`[serve] 已清理遗留任务容器 ${swept.removed.length} 个: `
      + swept.removed.join(", "));
  }
  // 进程可死任务不死:重启后重建索引,在跑的任务续跑,等人的继续等。
  const recovered = service.recover();
  if (recovered.restored) {
    console.log(`[serve] 恢复任务 ${recovered.restored} 个`
      + `(重新入队 ${recovered.requeued} 个)`);
  }
  const lubanApproval = lubanPluginToken
    ? new LubanApprovalGateway(service, {
        token: lubanPluginToken,
        accountEnabled: (account) => !!auth.sessionView(account),
        ...(notifier ? {
          recentNotification: (account) => notifier.latestApproval(account),
        } : {}),
        log: (message) => console.log(`  [luban-plugin] ${message}`),
      })
    : undefined;
  // 现场回收:启动扫一次(服务可能停了很久),之后每天一次。
  // 纯旁路 fail-open——回收失败只是磁盘没省下来,不许它拖住服务。
  // unref():这个定时器不该成为进程不肯退出的理由。
  const sweepWorkspaces = () => {
    try {
      const swept = service.reclaimIdleWorkspaces();
      if (swept.reclaimed) {
        console.log(`[serve] 现场回收 ${swept.reclaimed} 个任务,`
          + `释放 ${humanBytes(swept.freed)}(保留期 `
          + `${service.workspaceRetentionDays()} 天;台账与证据保留)`);
      }
    } catch (error) {
      console.log(`[serve] 现场回收失败(不影响服务): ${String(error)}`);
    }
  };
  if (retentionDays > 0) {
    sweepWorkspaces();
    setInterval(sweepWorkspaces, 24 * 60 * 60_000).unref();
  } else {
    console.log("[serve] 现场保留期配置为 0:永不回收,dataDir 需自行看管");
  }

  // 正式前端:--web <dist> 显式指定;web/dist 存在时自动接上
  // (构建过就用正式版,没构建就是零构建演示页,永远有页面可开)。
  const webRoot = flag("--web")
    ?? [join(REPO_ROOT, "web", "dist")].find((dir) =>
         existsSync(join(dir, "index.html")));
  if (webRoot) console.log(`[serve] 正式前端: ${webRoot}`);
  warnStaleWeb(webRoot);
  // --host 0.0.0.0 = 暴露给内网同事用(默认只听本机回环——不声明
  // 就不上网,是姿态不是疏忽)。暴露时登录/权限本来就在,但要认两条:
  // 内网是明文 http(会话 cookie 可被同网段嗅探,正式部署前加反代
  // TLS);工作机合盖=全员断线,它是工作站不是服务器。
  const server = createTaskServer(service, {
    webRoot, auth, lubanApproval, issueFlow,
  });
  let terminating = false;
  const terminate = async (signal: "SIGTERM" | "SIGINT") => {
    if (terminating) return;
    terminating = true;
    console.log(`[serve] 收到 ${signal}，停止接单并清理会话/任务容器...`);
    const closed = new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
    let exitCode = 0;
    try {
      await service.shutdown();
      await issueFlow.shutdown();
      console.log("[serve] 所有任务会话与容器已确认释放；业务状态保持不变，"
        + "下次启动将继续恢复");
    } catch (error) {
      exitCode = 1;
      console.error(`[serve] 优雅关闭未完全成功: ${String(error)}`);
      if (error instanceof AggregateError) {
        error.errors.forEach((cause, index) => {
          console.error(`[serve] 关闭失败 ${index + 1}: ${String(cause)}`);
        });
      }
    }
    // SSE/keep-alive 连接不会自行让 server.close 回调；业务资源清完后
    // 再断开这些纯读连接，保证 systemd stop 不悬挂。
    server.closeAllConnections?.();
    await closed;
    await projection?.close().catch((error) => {
      exitCode = 1;
      console.error(`[serve] PostgreSQL 投影关闭失败: ${String(error)}`);
    });
    // 最后才撒手:锁在容器确认释放之前松开,下一个实例会去清扫还没
    // 死透的容器。释放本身不许把退出码带坏——留个陈旧锁下次能接管,
    // 但拿不到退出码会让 systemd 误判。
    try {
      instanceLock.release();
    } catch (error) {
      console.error(`[serve] 释放数据目录锁失败(下次启动会自动接管): ${String(error)}`);
    }
    process.exit(exitCode);
  };
  process.once("SIGTERM", () => { void terminate("SIGTERM"); });
  process.once("SIGINT", () => { void terminate("SIGINT"); });
  // 监听失败要说人话就退。没有这个处理器时 EADDRINUSE 会作为未捕获的
  // error 事件把进程炸掉,现场只剩一段栈——实战里表现为"服务莫名其妙
  // 挂了",而真相往往只是上一次的进程还占着端口。
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`[serve] 端口 ${port} 已被占用:上一次的服务可能还在跑。`
        + `\n  查:lsof -i :${port} 或 ss -lptn 'sport = :${port}'`
        + `\n  然后停掉它,或换一个 --port 重启`);
    } else {
      console.error(`[serve] 监听失败(${error.code ?? "未知"}): ${error.message}`);
    }
    process.exit(2);
  });
  server.listen(port, bindHost, () => {
    const actual = (server.address() as AddressInfo).port;
    console.log(`[serve] http://${bindHost}:${actual}  (数据目录 ${dataDir})`);
    if (publicUrl) console.log(`[serve] 通知访问地址:${publicUrl}`);
    if (bindHost !== "127.0.0.1") {
      console.log("[serve] 已对外监听:同事经内网 IP 访问;明文 http,"
        + "正式部署前套反代 TLS");
    }
    console.log("[serve] 前台进程:关掉这个终端/断开 SSH 服务就没了。"
      + "长期跑请用 tmux 或 systemd(部署手册「启动与守护」)");
  });
}

/** 前端构建过期就明说。
 *
 * `web/dist` 是 gitignore 的(构建产物不进仓),所以**拉了新代码不重新
 * 构建,页面就还是旧的**——而页面不会自己声明版本,人只会觉得"这个功能
 * 坏了/点不了",其实是他手上那份前端根本没有这段代码(内网实测:界面
 * 是 25 个提交之前构建的)。零构建是本仓的原则,但 web/ 是唯一例外,
 * 这一句提醒就是那个例外的守卫。
 *
 * fail-open:读不到时间戳(权限/文件系统怪)就不说话,绝不挡启动。 */
function warnStaleWeb(webRoot: string | undefined): void {
  if (!webRoot) return;
  try {
    const built = statSync(join(webRoot, "index.html")).mtimeMs;
    const srcDir = join(REPO_ROOT, "web", "src");
    if (!existsSync(srcDir)) return;   // 只带 dist 的发布件:没源码可比
    let newest = 0;
    for (const name of readdirSync(srcDir)) {
      const at = statSync(join(srcDir, name)).mtimeMs;
      if (at > newest) newest = at;
    }
    if (newest > built) {
      console.log("[serve] ⚠ 前端构建比源码旧:页面上看到的是上一次构建的"
        + "版本(新功能会像\"坏了/点不了\")。修:cd web && npm run build,"
        + "然后刷新浏览器(强制刷新 Cmd/Ctrl+Shift+R)");
    }
  } catch { /* 比不出来就不说话:提醒是旁路,不许挡启动 */ }
}

/** 进程级兜底:**一条旁路的异常不许带走整个服务**。
 *
 * Node 从 15 起,未处理的 Promise rejection 默认直接终止进程。而本仓
 * 到处是 `void this.某个旁路()` 的即发即忘(通知、投影、门禁查询、
 * 合入监控)——其中任何一条抖一下,整台服务连着所有在跑的任务一起
 * 没,这正是"旁路一律 fail-open、agent 不能因 harness 卡死"红线要
 * 禁止的事。所以:**记下来,继续服务**。
 *
 * 崩溃现场同时落盘一份(终端会滚没,而人往往只记得"它挂了"),
 * 让人能把原文带回来——诊断不该靠回忆。
 *
 * 勘误(2026-08-18 内网实测,crash.log 实锤):这个兜底的第一版
 * **自己就是一次事故**。stdout/stderr 的管道断掉后(后台起服,读端
 * 进程先退了),每一次 console 写都抛 EPIPE;record 里的 console.error
 * 又写 → 又 EPIPE → 又进 uncaughtException → 又 record——无限递归把
 * 事件循环吃死,症状是 API 全部超时、crash.log 同一毫秒刷出成对的
 * "write EPIPE",栈指向 record 自己。三层修法,缺一不可:
 * - **流上装 error 监听**(muzzleBrokenPipes):EPIPE 在源头吞掉,
 *   输出没了服务还在——这才是治本;
 * - **先落盘后上屏**:crash.log 是给人的,console 只是顺手;
 * - **重入保险**:记账过程自己出的事不再记,递归到此为止。
 */
function guardProcess(dataDir: string): void {
  let recording = false;
  const record = (kind: string, error: unknown) => {
    if (recording) return; // 兜底自己出事不再兜:递归在这儿断
    recording = true;
    try {
      const detail = error instanceof Error
        ? `${error.message}\n${error.stack ?? ""}` : String(error);
      const line = `[${new Date().toISOString()}] ${kind}: ${detail}\n`;
      try {
        appendFileSync(join(dataDir, "crash.log"), line);
      } catch { /* 落盘失败不能再抛,否则就成了兜底自己把服务弄挂 */ }
      try {
        console.error(`[serve] ${kind}(服务继续运行,请把这段发回外网):\n`
          + detail);
      } catch { /* 管道断了:输出丢弃,crash.log 已经有了 */ }
    } finally {
      recording = false;
    }
  };
  process.on("unhandledRejection", (reason) => record("未处理的异步异常", reason));
  process.on("uncaughtException", (error) => record("未捕获异常", error));
}

/** stdout/stderr 断管免疫:管道读端没了(后台起服、tmux 分离、日志
 * 采集进程先退),写日志不许变成服务的死因。
 *
 * 机理:对已断管道的 write,错误以流的 error **事件**回报——没有监听
 * 器的 error 事件就是 uncaughtException。也就是说,不装这个监听,
 * 任何一行 console.log 都可能杀进程(或进 guardProcess 的记账递归)。
 * 装了:那次输出静静丢掉,服务照跑——日志是旁路,旁路 fail-open。 */
function muzzleBrokenPipes(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", () => { /* 断管即丢弃:输出是旁路,不许反噬 */ });
  }
}

main().catch((error) => {
  console.error("[serve] 启动失败:", error);
  process.exit(1);
});
