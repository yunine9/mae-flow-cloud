/**
 * 跨仓需求的分析会话端到端(真会话,不是把产物直接写盘绕过去):
 * 两个真 git 仓下单 → 分析会话把仓克隆成只读现场 → 剧本模型读仓、
 * 写 CHAIN 文档和机读需求图、举确认卡 → 用户答「确认并生成任务」→
 * 平台按依赖生成两个子任务(后者等前者)→ 分析单收口。
 *
 * 不需要内核:分析阶段本来就在内核流程之外(平台前置阶段),各仓的
 * 内核交付链在子任务里跑,那条链由 orderFacts/rejectionPaths 端到端
 * 覆盖。这里专门验"分析会话→确认→拆单"这一段此前没人真跑过的路。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";

const GIT_ENV = { ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function makeRepo(root: string, name: string): string {
  const path = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "master", path]);
  execFileSync("git", ["-C", path, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  return path;
}

async function until<T>(
  probe: () => T | undefined, what: string, timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("跨仓分析会话:克隆只读现场→写产物→举卡→确认拆单→收口", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-chain-e2e-"));
  const apiRepo = makeRepo(dataDir, "svc-api");
  const webRepo = makeRepo(dataDir, "svc-web");
  const ticket = "REQ2026081930";
  // 机读需求图:url 必须原样照录下单地址(投影按白名单全等过滤)。
  const graphJson = JSON.stringify({
    repositories: [
      { id: "repo-1", name: "svc-api", url: apiRepo, responsibility: "提供接口" },
      { id: "repo-2", name: "svc-web", url: webRepo, responsibility: "消费接口" },
    ],
    dependencies: [
      { dependent: "repo-2", prerequisite: "repo-1",
        reason: "svc-web 依赖 svc-api，接口没就绪前端无从联调" },
    ],
  });
  const artifactDir = join(".mae-flow-work", ticket);
  const script: Scene[] = [
    { text: "读两仓现场,写方案与机读投影",
      tool: { name: "bash", input: { command:
        `ls 1-svc-api 2-svc-web && ` +
        `printf '%s' '# 跨仓方案\n先 api 后 web,接口契约见正文。\n' ` +
        `> "${join(artifactDir, `CHAIN-${ticket}.md`)}" && ` +
        `cat > "${join(artifactDir, "requirement-graph.json")}" << 'EOF'\n` +
        `${graphJson}\nEOF` } } },
    // 模型照抄清单序号提问(内网实锤):卡上必须已经换成仓库名。
    { tool: { name: "AskUserQuestion", input: { questions: [
        { question: "repo-1 与 repo-2 的接口契约方案是否确认?",
          options: ["确认并生成任务", "需要修改"],
          recommended: "确认并生成任务" }] } } },
    { text: "方案已确认,分析收口。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = new Notifier({ endpoint: luban.endpoint });
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    maxConcurrent: 1,
    host: { kernelRoot: join(dataDir, "no-kernel") },
    notifier,
  });
  try {
    const parent = service.create("跨仓交付:api 出接口,web 消费", {
      account: "cloudbot", ticket,
      repos: [apiRepo, webRepo],
    });
    // 受邀参与讨论的人:能答卡、要收通知;拆单仍只认责任人。
    service.setRequirementCollaborators(parent.id, ["alice"]);
    const prompt = (service as any).requirementAnalysisPrompt(
      (service as any).tasks.get(parent.id), dataDir);
    assert.match(prompt, /- svc-api \| /, "清单第一列是仓库名,模型照抄它去提问");
    assert.doesNotMatch(prompt, /repo-\d+ \|/, "序号不再出现在清单里");
    assert.match(prompt, /称呼仓库一律用仓库名/);
    assert.match(prompt, /生产者、转换者、消费者和责任系统/,
      "跨仓分析必须在拆单前追清新增数据由谁产生");
    assert.match(prompt, /仓库清单之外.*外部系统/,
      "外部生产系统不能拖到某个子任务质询时才发现");
    assert.equal(parent.requirement_graph?.stage, "analysis");
    const card = await until(() => {
      const now = service.get(parent.id)!;
      if (now.status === "failed") throw new Error(now.detail);
      return now.status === "waiting_for_human" ? now : undefined;
    }, "确认卡");
    // 卡到手时投影应已能从产物读出依赖(面板据此画图)。
    assert.equal(card.requirement_graph?.dependencies.length, 1);
    // 卡上不能出现 repo-1/repo-2(内网实锤"完全看不懂是哪个仓"):prompt
    // 改按名称呼,举卡文本再机械替换一道兜底。
    const asked = String(
      (card.waiting?.question as any)?.questions?.[0]?.question ?? "");
    assert.match(asked, /svc-api 与 svc-web/, `卡上要用仓库名:${asked}`);
    assert.doesNotMatch(asked, /repo-\d/);
    // 参与人过得了 HTTP 权限闸,但"确认并生成任务"改任务形状,只认责任人。
    await assert.rejects(service.decide(parent.id, {
      actor: "alice", state_version: card.waiting!.state_version,
      decision: "确认并生成任务",
    }), /只有主责任人 cloudbot 可以确认并生成任务/);
    assert.equal(service.get(parent.id)?.status, "waiting_for_human",
      "被拒的拍板不消费卡");
    // 问题卡通知责任人和受邀参与人各一条(通知键按人分开)。
    const recipients = await until(() => {
      const accounts = notifier.list()
        .filter((record) => record.waiting_id.startsWith(card.waiting!.waiting_id))
        .map((record) => record.account).sort();
      return accounts.length >= 2 ? accounts : undefined;
    }, "参与人通知");
    assert.deepEqual(recipients, ["alice", "cloudbot"]);
    const confirmed = await service.confirmRequirementGraph(parent.id);
    // 分析会话同步收口，但跨仓主任务要继续汇总各仓交付；不能把
    // “拆单成功”冒充为“整个需求完成”。
    assert.equal(confirmed.status, "coordinating",
      "确认后主任务应进入子任务进行中");
    assert.equal(confirmed.waiting, undefined);
    const graph = service.get(parent.id)!.requirement_graph!;
    assert.equal(graph.stage, "confirmed");
    const apiChild = service.get(graph.repositories[0].task_id!)!;
    const webChild = service.get(graph.repositories[1].task_id!)!;
    // 子任务立即取消:它们的交付链(内核)由别的端到端覆盖,这里不跑
    // (父单收口会放出并发槽,晚一步取消子会话就会去误消费剧本场景)。
    await service.cancel(apiChild.id, "tester");
    await service.cancel(webChild.id, "tester");
    assert.equal(service.get(parent.id)?.status, "coordinating",
      "子任务取消后父任务仍应留在当前现场并提示处理");
    const internal = service as any;
    for (const child of [apiChild, webChild]) {
      const state = internal.tasks.get(child.id);
      state.summary.status = "completed";
      internal.persist(state);
    }
    assert.equal(service.get(parent.id)?.status, "completed",
      "全部子任务真实完成后父任务才完成");

    // 现场:两仓按序克隆成只读(pushurl 已改指死路)。
    const root = join(dataDir, parent.id, "repositories");
    for (const name of ["1-svc-api", "2-svc-web"]) {
      assert.ok(existsSync(join(root, name)), `${name} 该被克隆`);
      const pushurl = execFileSync("git",
        ["-C", join(root, name), "config", "remote.origin.pushurl"],
        { encoding: "utf-8" }).trim();
      assert.match(pushurl, /mae-flow-readonly/, "分析现场必须只读");
    }
    // 拆单事实:职责、依赖、继承(单号/归属)、方案正文随子任务走。
    assert.equal(apiChild.repo_url, apiRepo);
    assert.equal(webChild.repo_url, webRepo);
    assert.deepEqual(webChild.blocked_by, [apiChild.id]);
    assert.equal(apiChild.blocked_by, undefined);
    assert.equal(apiChild.parent_task_id, parent.id);
    assert.equal(apiChild.ticket, ticket);
    assert.equal(apiChild.luban_account, "cloudbot");
    // 方案正文不进需求原文(整份方案塞 prompt 会被模型当实施计划直接
    // 开写,跳过流程头部——内网实锤):落成工作区文件,需求里只指路,
    // launch 再把它带进克隆并经下单事实指给「需求文档」。
    assert.match(apiChild.requirement, /\.mae-flow-chain\.md/,
      "需求原文只指路,不内联方案正文");
    assert.ok(!apiChild.requirement.includes("先 api 后 web"),
      "方案正文不得内联进需求");
    assert.match(apiChild.requirement, /提供接口/);
    const plan = readFileSync(
      join(dataDir, apiChild.id, "chain-plan.md"), "utf-8");
    assert.match(plan, /跨仓方案/, "人工检视过的 CHAIN 正文随子任务落盘");
    assert.match(plan, /提供接口/, "方案文件带当前仓职责");
  } finally {
    await model.stop();
    await luban.stop();
  }
});
