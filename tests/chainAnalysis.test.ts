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
    { tool: { name: "AskUserQuestion", input: { questions: [
        { question: "跨仓方案是否确认?",
          options: ["确认并生成任务", "需要修改"] }] } } },
    { text: "方案已确认,分析收口。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    maxConcurrent: 1,
    host: { kernelRoot: join(dataDir, "no-kernel") },
  });
  try {
    const parent = service.create("跨仓交付:api 出接口,web 消费", {
      account: "cloudbot", ticket,
      repos: [apiRepo, webRepo],
    });
    assert.equal(parent.requirement_graph?.stage, "analysis");
    const card = await until(() => {
      const now = service.get(parent.id)!;
      if (now.status === "failed") throw new Error(now.detail);
      return now.status === "waiting_for_human" ? now : undefined;
    }, "确认卡");
    // 卡到手时投影应已能从产物读出依赖(面板据此画图)。
    assert.equal(card.requirement_graph?.dependencies.length, 1);
    const confirmed = await service.confirmRequirementGraph(parent.id);
    // 确认即硬收口(用户拍板:拆单后父单使命结束):不等模型自觉写
    // 收尾,状态同步落 completed,再举卡的窗口彻底不存在。
    assert.equal(confirmed.status, "completed",
      "确认必须同步收口父分析单,不许留假等/假跑");
    assert.equal(confirmed.waiting, undefined);
    const graph = service.get(parent.id)!.requirement_graph!;
    assert.equal(graph.stage, "confirmed");
    const apiChild = service.get(graph.repositories[0].task_id!)!;
    const webChild = service.get(graph.repositories[1].task_id!)!;
    // 子任务立即取消:它们的交付链(内核)由别的端到端覆盖,这里不跑
    // (父单收口会放出并发槽,晚一步取消子会话就会去误消费剧本场景)。
    await service.cancel(apiChild.id, "tester");
    await service.cancel(webChild.id, "tester");

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
  }
});
