/**
 * 单仓拆分(docs/delivery-unit-split-design.md)端到端与门禁契约:
 * 一个仓显式要求先分析 → 剧本模型写出"同仓两个交付单元"的图 →
 * 同单号确认被撞分支校验挡下 → 分单号确认 → 平台按拓扑序补隐式
 * 串行边、机械生成单元任务书、把负责文件面下传给子任务;
 * 另测负责面交付门禁:越界提交停摆举卡,主责任人放行(记豁免)或
 * 打回(派撤出修复),邻居目录前缀(src/filterX)不被吞进面内。
 *
 * HTTP 侧 scope-decision 的"只有主任务责任人可裁决"是 server.ts
 * 路由一行 canOperate 判定,此处不起真 HTTP 服务(已知边界,README
 * 如实记录);服务层语义在这里全部真跑。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskControlError, TaskService } from "../src/taskService.ts";

const GIT_ENV = { ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

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

test("单仓拆分:分析→撞单号挡下→分单号确认→串行子任务+任务书+负责面下传", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-unit-split-e2e-"));
  const repo = join(dataDir, "svc-core");
  execFileSync("git", ["init", "-q", "-b", "master", repo]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const ticket = "REQ2026083100";
  // 同一个仓两个单元:url 都照录下单地址,靠 id + scope 区分。
  const graphJson = JSON.stringify({
    repositories: [
      { id: "unit-contract", name: "svc-core", url: repo,
        responsibility: "接口契约骨架,整体编译得过",
        scope: { name: "契约骨架", paths: ["src/contract/"] } },
      { id: "unit-filter", name: "svc-core", url: repo,
        responsibility: "过滤模块实现",
        scope: { name: "过滤实现", paths: ["src/filter/"] } },
    ],
    dependencies: [],
  });
  const artifactDir = join(".mae-flow-work", ticket);
  const script: Scene[] = [
    { text: "读仓现场,写方案与机读投影",
      tool: { name: "bash", input: { command:
        `ls 1-svc-core && ` +
        `printf '%s' '# 单仓拆分方案\n契约先行,过滤在后。\n' ` +
        `> "${join(artifactDir, `CHAIN-${ticket}.md`)}" && ` +
        `cat > "${join(artifactDir, "requirement-graph.json")}" << 'EOF'\n` +
        `${graphJson}\nEOF` } } },
    { tool: { name: "AskUserQuestion", input: { questions: [
        { question: "拆分方案是否确认?",
          options: ["确认并生成任务", "需要修改"],
          recommended: "确认并生成任务" }] } } },
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
    const parent = service.create("单仓大需求:契约先行,过滤模块化", {
      account: "cloudbot", ticket,
      repos: [repo],
      requirementAnalysis: true,
    });
    assert.equal(parent.requirement_analysis_requested, true,
      "显式分析意愿必须落盘(重启后仍是分析单)");
    assert.equal(parent.requirement_graph?.stage, "analysis",
      "单仓 + 显式要求 = 走分析前置阶段");
    const prompt = (service as any).requirementAnalysisPrompt(
      (service as any).tasks.get(parent.id), dataDir);
    // 指引契约:澄清收口、划分方向卡、契约骨架判据、scope 输出格式。
    assert.match(prompt, /每一条已识别的不确定事项都有结论/,
      "澄清必须有收口标准,TBD 即不合格");
    assert.match(prompt, /划分方向卡/, "拆分前必须固定动作问人偏好");
    assert.match(prompt, /契约骨架/, "同仓多单元第一个必须是契约骨架");
    assert.match(prompt, /已确认事项清单/, "澄清期 Q&A 必须落进方案正文");
    assert.match(prompt, /"scope":\{"name"/, "图产物格式必须含 scope 示例");
    assert.match(prompt, /同仓单元由平台自动按顺序串行/,
      "串行是平台纪律,不让模型自己写同仓边");

    const card = await until(() => {
      const now = service.get(parent.id)!;
      if (now.status === "failed") throw new Error(now.detail);
      return now.status === "waiting_for_human" ? now : undefined;
    }, "确认卡");
    const nodes = card.requirement_graph!.repositories;
    assert.equal(nodes.length, 2, "一个仓允许拆出两个单元节点");
    assert.deepEqual(nodes.map((node) => node.scope?.name),
      ["契约骨架", "过滤实现"]);

    // 两个单元此刻同责任人、同单号(都继承父单):分支名会互相覆盖,
    // 必须在确认时挡下,不能等克隆后才炸。
    await assert.rejects(
      () => service.confirmRequirementGraph(parent.id),
      (error: unknown) => error instanceof TaskControlError
        && /同仓、同责任人、同单号/.test((error as Error).message),
      "同仓同人同单号必须在确认前被撞分支校验拒绝");

    service.assignRequirementRepositories(parent.id, {
      "unit-contract": "cloudbot", "unit-filter": "cloudbot",
    }, {
      "unit-contract": "REQ2026083101", "unit-filter": "REQ2026083102",
    });
    const confirmed = await service.confirmRequirementGraph(parent.id);
    assert.equal(confirmed.status, "coordinating");

    const graph = service.get(parent.id)!.requirement_graph!;
    assert.equal(graph.stage, "confirmed");
    const contractChild = service.get(graph.repositories[0].task_id!)!;
    const filterChild = service.get(graph.repositories[1].task_id!)!;
    // 子任务交付链由别的端到端覆盖,立即取消免得误消费剧本场景。
    await service.cancel(contractChild.id, "tester");
    await service.cancel(filterChild.id, "tester");

    // 串行纪律:图里没写任何显式边,平台按拓扑序补隐式前置边。
    assert.deepEqual(filterChild.blocked_by, [contractChild.id],
      "同仓第二个单元必须等第一个合入");
    assert.equal(contractChild.blocked_by, undefined);
    // 负责面下传 + 单号/标题逐单元。
    assert.deepEqual(contractChild.delivery_scope,
      { name: "契约骨架", paths: ["src/contract/"] });
    assert.deepEqual(filterChild.delivery_scope,
      { name: "过滤实现", paths: ["src/filter/"] });
    assert.equal(contractChild.ticket, "REQ2026083101");
    assert.equal(filterChild.ticket, "REQ2026083102");
    assert.match(contractChild.title ?? "", /契约骨架/,
      "子任务标题要带单元名,列表里才分得清同仓的两单");
    // 单元任务书:位置、负责面、上下游(隐式串行边也要出现在书里)。
    assert.match(contractChild.requirement, /第 1\/2 个交付单元/);
    assert.match(filterChild.requirement, /第 2\/2 个交付单元/);
    assert.match(filterChild.requirement, /负责文件面:src\/filter\//);
    assert.match(filterChild.requirement, /依赖上游:契约骨架/,
      "隐式串行边必须写进下游任务书");
    assert.match(contractChild.requirement, /被依赖:过滤实现/,
      "隐式串行边必须让上游知道有人基于它开发");
    assert.match(filterChild.requirement, /\.mae-flow-chain\.md/,
      "方案正文不内联,只指路");
    assert.ok(!filterChild.requirement.includes("契约先行,过滤在后"),
      "方案正文不得内联进需求");
    const plan = readFileSync(
      join(dataDir, filterChild.id, "chain-plan.md"), "utf-8");
    assert.match(plan, /单仓拆分方案/, "CHAIN 正文随子任务落盘");

    // 全部子任务真实完成后父任务才收口。
    const internal = service as any;
    for (const child of [contractChild, filterChild]) {
      const state = internal.tasks.get(child.id);
      state.summary.status = "completed";
      internal.persist(state);
    }
    assert.equal(service.get(parent.id)?.status, "completed");
  } finally {
    await model.stop();
  }
});

/** 负责面门禁的真仓现场:baseline 一笔,面内一笔,越界一笔。
 * src/filterX 专门用来验前缀按路径段闭合——裸 startsWith 会把它
 * 误认成 src/filter 面内。 */
function scopedRepository() {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-scope-gate-"));
  const git = (...args: string[]) => execFileSync(
    "git", ["-C", cwd, ...args], { encoding: "utf-8", env: GIT_ENV }).trim();
  git("init", "--quiet", "-b", "master");
  writeFileSync(join(cwd, "README.md"), "baseline\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "baseline");
  const baseline = git("rev-parse", "HEAD");
  mkdirSync(join(cwd, "src", "filter"), { recursive: true });
  mkdirSync(join(cwd, "src", "filterX"), { recursive: true });
  mkdirSync(join(cwd, "src", "contract"), { recursive: true });
  writeFileSync(join(cwd, "src", "filter", "impl.ts"), "export const a = 1;\n");
  writeFileSync(join(cwd, "src", "filterX", "other.ts"), "export const b = 1;\n");
  writeFileSync(join(cwd, "src", "contract", "api.ts"), "export const c = 1;\n");
  git("add", "src");
  git("commit", "--quiet", "-m", "unit work");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    config: { "分支名": "feature", "基线分支": "master" },
    step_heads: { branch_create: baseline },
  }));
  return cwd;
}

async function scopedTask() {
  const model = new ScriptedModelServer([
    { text: "完成。" }, { text: "备用一。" }, { text: "备用二。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-scope-gate-data-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create("负责面门禁演练", { account: "worker" }).id;
  await until(() => service.get(id)?.status === "completed"
    ? true : undefined, "首轮会话收口", 20_000);
  const internal = (service as any).tasks.get(id);
  internal.cwd = scopedRepository();
  internal.summary.status = "verifying";
  internal.summary.delivery_scope = { name: "过滤实现", paths: ["src/filter/"] };
  return { service, model, id, internal };
}

test("负责面门禁:越界停摆举卡,放行记豁免续推,邻居目录不被吞进面内", async () => {
  const { service, model, id, internal } = await scopedTask();
  try {
    const gate = () => (service as any).deliveryScopeAllowsPush(internal);
    assert.equal(await gate(), false, "越界提交必须被拦下");
    const violation = internal.summary.delivery?.scope_violation;
    // src/filterX 与面内前缀 src/filter 只差一个字符:必须算越界。
    assert.deepEqual(violation?.paths,
      ["src/contract/api.ts", "src/filterX/other.ts"]);
    assert.ok(internal.summary.delivery?.stalled, "越界即停摆等裁决");
    assert.match(internal.summary.detail ?? "", /越出负责文件面/);
    assert.match(internal.summary.detail ?? "", /过滤实现/,
      "停摆原因要点名是哪个单元");

    // 没有待裁决的越界时不许裁决(误触/重放要诚实拒绝)。
    const fresh = service.create("无越界对照", { account: "worker" }).id;
    assert.throws(() => service.decideScopeViolation(fresh, "allow", "boss"),
      /当前没有待裁决的越界改动/);

    const allowed = service.decideScopeViolation(id, "allow", "boss");
    assert.equal(allowed.status, "verifying");
    assert.equal(allowed.delivery?.scope_violation, undefined);
    assert.deepEqual(allowed.delivery_scope_exemptions,
      ["src/contract/api.ts", "src/filterX/other.ts"],
      "放行的文件逐个记入豁免名单");
    assert.match(allowed.detail ?? "", /boss 放行/);
    assert.equal(await gate(), true, "豁免后同一批提交必须放行");
    await service.cancel(id, "tester");
    // fresh 是对照单,剧本一句话就自然完成了,不用也不能再取消。
  } finally {
    await model.stop();
  }
});

test("负责面门禁:打回派窄使命撤出越界文件,面内实现保留", async () => {
  const { service, model, id, internal } = await scopedTask();
  try {
    assert.equal(
      await (service as any).deliveryScopeAllowsPush(internal), false);
    const reverted = service.decideScopeViolation(id, "revert", "boss");
    assert.equal(reverted.status, "queued", "打回=排修复会话,不是终态");
    assert.match(reverted.detail ?? "", /撤出 2 个越界文件/);
    assert.match(internal.mission ?? "", /src\/contract\/api\.ts/,
      "修复使命必须逐个点名要撤出的文件");
    assert.match(internal.mission ?? "", /负责面内的实现一律保留/);
    assert.match(internal.mission ?? "", /不得 reset\/rebase/,
      "撤出不许改写历史(定格基线纪律)");
    await service.cancel(id, "tester");
  } finally {
    await model.stop();
  }
});
