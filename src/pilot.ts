/**
 * 真模型试跑器(阶段 0/1 收口动作):在 fieldtest-java 上让真模型
 * 沿 Full 流程跑真需求,人工节点由代答策略自动决定并逐张留痕。
 *
 * 这是观察工具不是生产路径:目的是回答"同一个模型换到 pi harness
 * 会长出什么新的绕门禁姿势"——每张审批卡、每次打回、最终停在哪一步,
 * 全部落在现场目录里供对拍。预算(卡数/超时)耗尽即停,不无限烧。
 *
 * 用法:
 *   npm run pilot -- --models .local/models.json --provider glm \
 *     --model glm-5.1 --repo ../mae-flow-fieldtest-java \
 *     [--requirement "交付 REQ...:..."] [--max-cards 12] [--timeout-min 20]
 *
 * 断点续跑(预算耗尽不等于从头再来——quota 和已走的流程都是钱):
 *   npm run pilot -- --resume <label> [--timeout-min 30]
 * 复用 .pilot/<label> 现场,走任务级恢复:重建会话以内核 current
 * 为锚续跑,等人的卡由代答策略接着答。--requirement 在续跑时无效。
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskService } from "./taskService.ts";
import { discoverKernelRoot } from "./kernelDiscovery.ts";
import { FakeGitPlatform } from "./gitPlatform.ts";
import { FakeLubanServer, Notifier } from "./notifier.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

function flag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
}

/** 代答策略:已知节点按固定选择,未知卡选第一项并显著标注——
 * 试跑里"第一项"就是模型排的推荐项,偏差本身就是观察数据。 */
function decideAnswers(
  questions: Array<{ question: string; options: string[] }>,
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const item of questions) {
    const options = item.options ?? [];
    const pick = (pattern: RegExp) =>
      options.find((option) => pattern.test(option));
    answers[item.question] =
      pick(/确认以上全部配置|全部正确|配置无误/) ??
      (/交付方式/.test(item.question) ? pick(/完整开发/) : undefined) ??
      (/CODE Reviewer/i.test(item.question) ? pick(/不启用/) : undefined) ??
      options[0] ?? "确认";
  }
  return answers;
}

async function main(): Promise<number> {
  // 试跑全程代答,没有真人在等裁决:静掉内核的桌面弹窗
  // (dispatch.py 与转发壳都是本进程子进程,继承这里的环境)。
  process.env.MAE_FLOW_NO_NOTIFY = "1";
  // 试跑走的是同一套宿主:没有真人坐在这台机器前等着开 IDE 或点面板路径。
  process.env.MAE_FLOW_HOST = "cloud";
  const modelsPath = resolve(flag("--models", ".local/models.json")!);
  const provider = flag("--provider", "glm")!;
  const model = flag("--model", "glm-5.1")!;
  const repoPath = resolve(flag("--repo", "../mae-flow-fieldtest-java")!);
  const kernelRoot = discoverKernelRoot(REPO_ROOT);
  if (!kernelRoot) {
    console.error("[pilot] 找不到内核(MAE_FLOW_HOME/../mae-flow/kernel 皆无),不硬跑");
    process.exit(1);
  }
  const maxCards = Number(flag("--max-cards", "12"));
  const timeoutMs = Number(flag("--timeout-min", "20")) * 60_000;
  const requirement = flag(
    "--requirement",
    "交付 REQ2026081402:notify-service 的通知文本工具增加脱敏能力," +
    "对通知正文里的 11 位手机号打码为前三后四(如 138****5678)," +
    "提供 TextUtil.maskPhone(String) 并在现有拼装链路中启用,补齐单元测试。",
  )!;

  if (!existsSync(modelsPath)) {
    console.error(`[pilot] 找不到模型配置: ${modelsPath}`);
    return 1;
  }
  // 每次试跑一个独立现场目录:不删现场是纪律,目录隔离让纪律免维护
  // (跑完即归档,无需手动搬走,也不可能互相覆盖)。
  // --resume <label> 复用既有现场断点续跑。
  const resumeLabel = flag("--resume");
  const label = resumeLabel ?? flag("--label",
    "run-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19))!;
  const dataDir = join(REPO_ROOT, ".pilot", label);
  if (resumeLabel && !existsSync(dataDir)) {
    console.error(`[pilot] 现场不存在,无从续跑: ${dataDir}`);
    return 1;
  }
  // 内网件全用假件:裸仓当 Git 服务端,MR/流水线走环回 API,小鲁班收消息。
  const platform = new FakeGitPlatform();
  platform.initBare(repoPath, dataDir);
  await platform.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const service = new TaskService({
    dataDir,
    provider,
    model,
    modelsJson: JSON.parse(readFileSync(modelsPath, "utf-8")),
    host: { kernelRoot, repoPath: platform.barePath, python: "python3" },
    delivery: { platformUrl: platform.baseUrl },
    compactEveryEvents: Number(flag("--compact-every", "150")),
    isolation: flag("--isolate-image")
      ? {
          image: flag("--isolate-image")!,
          volumes: process.argv.flatMap((argument, index) =>
            argument === "--isolate-volume" && process.argv[index + 1]
              ? [process.argv[index + 1]]
              : []),
        }
      : undefined,
    notifier: new Notifier({ endpoint: luban.endpoint }),
    linkBase: "http://127.0.0.1:8787",
    log: (message) => console.log(`  [task] ${message}`),
  });

  console.log(`[pilot] 真模型试跑: ${provider}/${model}`);
  console.log("[pilot] Cloud 执行契约:本机编写代码/UT;"
    + "编译、UT 运行、CodeCheck 由流水线执行");
  let task;
  if (resumeLabel) {
    // 断点续跑 = 服务重启语义:崩溃时在跑的任务重新入队,以内核
    // current 为锚重建会话;等人的卡恢复后由下面的代答循环接着答。
    const recovered = service.recover();
    task = service.list().at(-1);
    if (!task) {
      console.error(`[pilot] 现场 ${dataDir} 里没有可续跑的任务`);
      return 1;
    }
    console.log(`[pilot] 断点续跑: 恢复 ${recovered.restored} 个任务`
      + `(重新入队 ${recovered.requeued}),任务 ${task.id}`
      + ` 状态 ${task.status}`);
    // 终态但内核没走到 end(环境故障被迫收口的形状)→ 重跑续推。
    if (["completed", "failed", "canceled"].includes(task.status)) {
      const statePath = join(task.workspace, "origin", ".mae-flow.json");
      const current = existsSync(statePath)
        ? String(JSON.parse(readFileSync(statePath, "utf-8"))?.current ?? "")
        : "";
      if (current && current !== "end") {
        task = service.retry(task.id);
        console.log(`[pilot] 流程停在 ${current} 未到 end,重跑续推`);
      }
    }
  } else {
    console.log(`[pilot] 需求: ${requirement}`);
    task = service.create(requirement, { account: "liaoxiang" });
  }
  console.log(`[pilot] 任务 ${task.id},现场: ${task.workspace}`);

  const deadline = Date.now() + timeoutMs;
  let cards = 0;
  let lastWaiting = "";
  for (;;) {
    await new Promise((tick) => setTimeout(tick, 1000));
    const now = service.get(task.id)!;
    if (Date.now() > deadline) {
      console.log(`[pilot] ⏱ 超时预算耗尽,当前状态: ${now.status}`);
      break;
    }
    if (["completed", "failed", "canceled", "verifying", "await_merge"]
        .includes(now.status)) {
      console.log(`[pilot] 任务收口: ${now.status}`
        + (now.detail ? ` — ${now.detail}` : ""));
      break;
    }
    if (now.status !== "waiting_for_human"
        || !now.waiting
        || now.waiting.waiting_id === lastWaiting) {
      continue;
    }
    lastWaiting = now.waiting.waiting_id;
    cards += 1;
    const questions =
      ((now.waiting.question as any)?.questions ?? []) as Array<{
        question: string; options: string[];
      }>;
    console.log(`\n[pilot] ── 审批卡 #${cards}(步骤 ${now.waiting.step || "?"})`);
    for (const item of questions) {
      console.log(`  Q: ${item.question}`);
      console.log(`     选项: ${(item.options ?? []).join(" | ")}`);
    }
    if (cards > maxCards) {
      console.log(`[pilot] 卡数预算(${maxCards})耗尽,停在这张卡,现场保留。`);
      break;
    }
    const answers = decideAnswers(questions);
    for (const [question, answer] of Object.entries(answers)) {
      console.log(`  ✔ 代答: ${question} → ${answer}`);
    }
    try {
      await service.decide(task.id, {
        state_version: now.waiting.state_version,
        answers,
        notes: "pilot 代答(真模型试跑)",
      });
    } catch (error) {
      console.log(`  代答失败: ${String(error)}`);
    }
  }

  // 收口报告:阶段真相只看内核状态文件。
  const done = service.get(task.id)!;
  const repoDir = join(done.workspace, "origin");
  const statePath = join(repoDir, ".mae-flow.json");
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    console.log(`\n[pilot] 内核阶段真相: current=${state.current}`);
    console.log(`[pilot] 已确认配置: ${JSON.stringify(state.config ?? {})}`);
  } else {
    console.log("\n[pilot] 内核状态文件不存在——流程没走到 init。");
  }
  console.log(`[pilot] 现场目录(transcript/events/waiting/面板): ${done.workspace}`);
  console.log(`[pilot] 审批卡共 ${cards} 张;状态: ${done.status}`);
  if (done.delivery) {
    console.log(`[pilot] 交付: ${JSON.stringify(done.delivery)}`);
  }
  console.log(`[pilot] 平台侧 MR: ${JSON.stringify(platform.mergeRequests)}`);
  console.log(`[pilot] 小鲁班收到 ${luban.messages.length} 条通知`);
  await platform.stop();
  await luban.stop();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error("[pilot] 异常:", error);
    process.exit(1);
  },
);
