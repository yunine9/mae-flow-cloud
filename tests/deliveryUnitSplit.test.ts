/**
 * 单仓拆分(docs/delivery-unit-split-design.md)端到端与门禁契约:
 * 一个仓显式要求先分析 → 剧本模型写出"同仓两个交付单元"的图 →
 * 同单号确认被撞分支校验挡下 → 分单号确认 → 平台按拓扑序补隐式
 * 串行边、机械生成单元任务书、把负责文件面下传给子任务;
 * 另测负责面交付门禁:越界提交停摆举卡,主责任人放行(记豁免)或
 * 打回(派撤出修复),邻居目录前缀(src/filterX)不被吞进面内。
 *
 * HTTP 侧也起真服务、带两个真实登录态点击 scope-decision：非主责任人
 * 必须 403，且错误正文点名真正应该联系的主责任人账号。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { deliveryChangeSnapshot } from "../src/artifacts.ts";
import { readJson } from "../src/jsonBody.ts";
import { createTaskServer } from "../src/server.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { sealPipelineLifecycle } from "./kernelHostFixture.ts";
import {
  type RequirementGraph, TaskControlError, TaskService,
} from "../src/taskService.ts";

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
    assert.match(prompt, /每个路径恰好有一个 owner/,
      "生成拆分图前必须机械核对路径唯一归属");
    assert.match(prompt, /任务书要求修改但 scope 未授权/,
      "契约单元职责与负责面必须闭合");
    assert.match(prompt, /同仓多单元的 scope 默认不得相互包含或重叠/,
      "同仓拆分不能用宽 scope 吞掉后续单元");
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

    // 宽负责面会吞掉后续单元。即使模型漏掉自查，确认入口也要机械挡住，
    // 不能等开发完成后才在越界裁决里发现拆分方案自相矛盾。
    const parentState = (service as any).tasks.get(parent.id);
    const graphPath = join(parentState.cwd, artifactDir,
      "requirement-graph.json");
    const overlappingGraph = JSON.parse(graphJson) as RequirementGraph;
    overlappingGraph.repositories[1].scope!.paths = ["src/contract/filter/"];
    writeFileSync(graphPath, JSON.stringify(overlappingGraph));
    await assert.rejects(
      () => service.confirmRequirementGraph(parent.id),
      (error: unknown) => error instanceof TaskControlError
        && /负责面.*重叠/.test((error as Error).message),
      "同仓交付单元的 scope 路径不得互相包含");
    writeFileSync(graphPath, graphJson);

    // 两个单元此刻同责任人、同单号(都继承父单):分支名会互相覆盖,
    // 必须在确认时挡下,不能等克隆后才炸。
    await assert.rejects(
      () => service.confirmRequirementGraph(parent.id),
      (error: unknown) => error instanceof TaskControlError
        && /同仓、同责任人、同单号/.test((error as Error).message),
      "同仓同人同单号必须在确认前被撞分支校验拒绝");

    // 页面在同一次“确认并生成任务”提交里改子单号。计划校验必须
    // 先按这批覆盖值判断撞分支，再原子保存分工；不能拿旧的父单号
    // 先判一次红，把用户永远卡在确认卡上。
    const confirmed = await service.confirmRequirementGraph(parent.id, {
      repository_assignees: {
        "unit-contract": "cloudbot", "unit-filter": "cloudbot",
      },
      repository_tickets: {
        "unit-contract": "REQ2026083101", "unit-filter": "REQ2026083102",
      },
    });
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
    assert.match(filterChild.requirement, /不得把同一事项换个说法再次问人/,
      "子任务必须消费主任务已拍板结论,不能重新开一轮相同澄清");
    assert.match(filterChild.requirement,
      /当前目录、remote 或 data\/ 看不到其他单元是正常现象/,
      "隔离工作区不能被 Agent 误判成其他仓或交付单元缺失");
    assert.match(filterChild.requirement, /跨单元状态与术语同步由主任务协调/,
      "跨单元同步责任必须明确落到主任务,不能重复抛给子任务用户");
    assert.match(filterChild.requirement,
      /任务书中写明的仓库名称.*CHAIN.*内部代号.*不得据此声称真实名称缺失/s,
      "仓名已在任务书落定时,不能因 CHAIN 使用内部 id 再问人");
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
function scopedRepository(target?: string) {
  const cwd = target ?? mkdtempSync(join(tmpdir(), "mfc-scope-gate-"));
  mkdirSync(cwd, { recursive: true });
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
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    current: "delivery_watch",
    revision: 3,
    execution_contract: {
      schema: "mae-flow-execution/1", host: "cloud",
      compile: "pipeline", ut_write: "agent", ut_run: "pipeline",
      codecheck: "pipeline", git_push: "host",
      continuous_review: true, source: "order",
    },
    config: { "分支名": "feature", "基线分支": "master" },
    step_heads: { branch_create: baseline, delivery_watch: head },
    quality: { external_verification: { verdict: "PASS", sha: head } },
    history: [], initial_dirty: [],
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
  // 与生产一致：代码仓必须在任务 workspace 之内，宿主 capability 根
  // 才能由不可伪造的目录关系确定。
  internal.cwd = scopedRepository(
    join(internal.summary.workspace, "scope-repo-fixture"));
  internal.summary.status = "verifying";
  internal.summary.delivery_scope = { name: "过滤实现", paths: ["src/filter/"] };
  (service as any).options.host = {
    kernelRoot: join(process.cwd(), "kernel"),
    python: "python3",
    continuousReview: true,
  };
  sealPipelineLifecycle({
    cwd: internal.cwd,
    workspace: internal.summary.workspace,
    taskId: id,
    kernelRoot: join(process.cwd(), "kernel"),
  });
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
    const fresh = service.create("无越界对照", {
      account: "worker", ticket: "REQ-SCOPE-CONTROL", repo: internal.cwd,
    }).id;
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
    if (!["completed", "failed", "canceled"].includes(
      service.get(fresh)?.status ?? "")) {
      await service.cancel(fresh, "tester");
    }
  } finally {
    await model.stop();
  }
});

test("负责面门禁:目标分支前进并合入后不把其他任务文件误报为本单元越界", async () => {
  const { service, model, id, internal } = await scopedTask();
  try {
    const cwd = internal.cwd as string;
    const git = (...args: string[]) => execFileSync(
      "git", ["-C", cwd, ...args], { encoding: "utf-8", env: GIT_ENV }).trim();
    const baseline = JSON.parse(readFileSync(
      join(cwd, ".mae-flow.json"), "utf-8")).step_heads.branch_create;
    git("switch", "--quiet", "-c", "upstream-work", baseline);
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "other-task.md"), "other task\n");
    git("add", "docs/other-task.md");
    git("commit", "--quiet", "-m", "other task");
    const upstream = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/master", upstream);
    git("switch", "--quiet", "master");
    git("merge", "--quiet", "--no-edit", "upstream-work");

    assert.equal(
      await (service as any).deliveryScopeAllowsPush(internal), false);
    assert.deepEqual(internal.summary.delivery?.scope_violation?.paths,
      ["src/contract/api.ts", "src/filterX/other.ts"],
      "目标分支自己的文档不属于本单元贡献，不能要求本单元责任人裁决");
    const snapshot = await deliveryChangeSnapshot(cwd);
    assert.ok(snapshot?.baseline);
    const presentation = await (service as any).buildPushReviewPresentation(
      internal, snapshot, false);
    assert.deepEqual(presentation.committed_paths, [
      "src/contract/api.ts", "src/filter/impl.ts", "src/filterX/other.ts",
    ], "最终交付清单同样只显示本单元 MR 净贡献");
    assert.ok(!presentation.committed_paths.includes("docs/other-task.md"));
    await service.cancel(id, "tester");
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

test("负责面门禁 HTTP:非主责任人 403 并点名应联系的账号", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-scope-http-"));
  const auth = new LocalAuth(join(root, "auth.json"));
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("main-owner", "main-owner-pass", "developer");
  auth.createUser("other-dev", "other-developer-pass", "developer");
  const service = new TaskService({
    dataDir: join(root, "tasks"), provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
  });
  const parent = service.create("跨单元主任务", { account: "main-owner" });
  const child = service.create("越界子任务", { account: "other-dev" });
  const childState = (service as any).tasks.get(child.id);
  childState.summary.parent_task_id = parent.id;
  childState.summary.delivery_scope = {
    name: "过滤实现", paths: ["src/filter/"],
  };
  childState.summary.delivery = {
    scope_violation: {
      paths: ["src/filterX/other.ts"], noted_at: new Date().toISOString(),
    },
  };
  (service as any).persist(childState);
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({
        username: "other-dev", password: "other-developer-pass",
      }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const denied = await fetch(`${base}/tasks/${child.id}/scope-decision`, {
      method: "POST", headers: { cookie },
      body: JSON.stringify({ decision: "allow" }),
    });
    assert.equal(denied.status, 403);
    const payload = await readJson(denied);
    assert.match(payload.error, /主任务责任人 main-owner.*联系该账号/);
    assert.deepEqual(service.get(child.id)?.delivery?.scope_violation?.paths,
      ["src/filterX/other.ts"], "越权点击不得改变待裁决现场");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("单号延后:勾分析拆分下单免单号,确认卡逐单元补齐后才放行", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-unit-split-noticket-"));
  const repo = join(dataDir, "svc-solo");
  execFileSync("git", ["init", "-q", "-b", "master", repo]);
  execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const graphJson = JSON.stringify({
    repositories: [
      { id: "unit-a", name: "svc-solo", url: repo, responsibility: "契约",
        scope: { name: "契约骨架", paths: ["src/a/"] } },
      { id: "unit-b", name: "svc-solo", url: repo, responsibility: "实现",
        scope: { name: "过滤实现", paths: ["src/b/"] } },
    ],
    dependencies: [],
  });
  // 没有单号时产物目录按任务 id 命名;会话 cwd 是 <任务id>/repositories,
  // 场景里从上级目录名取 id,和真模型看到的指引路径同源。
  const script: Scene[] = [
    { text: "读仓,写免单号现场的产物",
      tool: { name: "bash", input: { command:
        `tid=$(basename "$(dirname "$PWD")") && ls 1-svc-solo && ` +
        `mkdir -p ".mae-flow-work/$tid" && ` +
        `printf '%s' '# 免单号拆分方案\n契约先行。\n' ` +
        `> ".mae-flow-work/$tid/CHAIN-$tid.md" && ` +
        `cat > ".mae-flow-work/$tid/requirement-graph.json" << 'EOF'\n` +
        `${graphJson}\nEOF` } } },
    { tool: { name: "AskUserQuestion", input: { questions: [
        { question: "拆分方案是否确认?",
          options: ["确认并生成任务", "需要修改"],
          recommended: "确认并生成任务" }] } } },
    { text: "确认完毕,收口。" },
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
    // 内核模式下普通单不填单号照旧拒绝——豁免只给显式勾了分析的主任务。
    assert.throws(() => service.create("没单号的普通单", {
      account: "cloudbot", repos: [repo],
    }), /AR 单号/);
    const parent = service.create("免单号大需求:先拆再定单号", {
      account: "cloudbot", repos: [repo], requirementAnalysis: true,
    });
    assert.equal(parent.ticket, undefined, "分析主任务不再持有单号");
    const card = await until(() => {
      const now = service.get(parent.id)!;
      if (now.status === "failed") throw new Error(now.detail);
      return now.status === "waiting_for_human" ? now : undefined;
    }, "确认卡");
    assert.equal(card.requirement_graph?.repositories.length, 2);
    // 不补单号直接确认:必须收到"逐单元补齐"的人话拒绝,而不是拿
    // 任务 id 兜底后报出莫名其妙的"同单号"撞分支错。
    await assert.rejects(
      () => service.confirmRequirementGraph(parent.id),
      (error: unknown) => error instanceof TaskControlError
        && /确认拆分时逐单元补齐/.test((error as Error).message));
    const confirmed = await service.confirmRequirementGraph(parent.id, {
      repository_assignees: { "unit-a": "cloudbot", "unit-b": "cloudbot" },
      repository_tickets: {
        "unit-a": "REQ2026090201", "unit-b": "REQ2026090202",
      },
    });
    assert.equal(confirmed.status, "coordinating");
    const graph = service.get(parent.id)!.requirement_graph!;
    const first = service.get(graph.repositories[0].task_id!)!;
    const second = service.get(graph.repositories[1].task_id!)!;
    await service.cancel(first.id, "tester");
    await service.cancel(second.id, "tester");
    assert.equal(first.ticket, "REQ2026090201");
    assert.equal(second.ticket, "REQ2026090202");
    assert.match(first.requirement, /当前单元 AR 单号:REQ2026090201/);
    assert.deepEqual(second.blocked_by, [first.id],
      "免单号路径不改串行纪律");
  } finally {
    await model.stop();
  }
});

test("越界打回先登记持续检视批次；登记失败则裁决原样保留可重试", async () => {
  const { service, model, id, internal } = await scopedTask();
  try {
    // 真实主链现场:内核停在 delivery_watch，负责面门禁在推送前拦下
    // 越界。打回必须先由 feedback-open 建立精确授权，不能另开旧修复路。
    internal.summary.delivery = {
      ...(internal.summary.delivery ?? {}),
      pipeline: "passed",
      prepush: { state: "passed" },
    };
    assert.equal(
      await (service as any).deliveryScopeAllowsPush(internal), false);
    // 死内核在前:这道兜底必须在它防御的故障下被测。裁决整体失败,
    // 越界卡原样保留、停摆原因不丢、内核状态一字未动。
    (service as any).options.host = {
      kernelRoot: join(internal.cwd, "kernel-not-exists"),
      python: "python3",
      continuousReview: true,
    };
    assert.throws(() => service.decideScopeViolation(id, "revert", "boss"),
      /内核持续检视命令失败/);
    assert.ok(internal.summary.delivery?.scope_violation,
      "退不动时越界卡必须还在,主责任人才能重试");
    assert.ok(internal.summary.delivery?.stalled);
    assert.equal(internal.summary.delivery?.prepush?.state, "passed",
      "裁决失败不得作废旧证据");
    assert.equal(JSON.parse(readFileSync(
      join(internal.cwd, ".mae-flow.json"), "utf-8")).current,
      "delivery_watch");
    // 换真件内核重试同一裁决:内核进入 feedback_triage,撤出使命才派发,
    // 旧 SHA 证据此刻一并作废。
    (service as any).options.host = {
      kernelRoot: join(process.cwd(), "kernel"),
      python: "python3",
      continuousReview: true,
    };
    (service as any).runningCount = 99;
    const reverted = service.decideScopeViolation(id, "revert", "boss");
    assert.equal(JSON.parse(readFileSync(
      join(internal.cwd, ".mae-flow.json"), "utf-8")).current, "feedback_triage",
      "打回必须让内核真实打开反馈批次,撤出令才不是空话");
    assert.equal(reverted.status, "queued");
    assert.equal(reverted.delivery?.scope_violation, undefined);
    assert.equal(reverted.delivery?.prepush, undefined,
      "旧 Build-Fix 收据不得继续背书即将改变的 HEAD");
    assert.equal(reverted.delivery?.pipeline, undefined);
    await service.cancel(id, "tester");
  } finally {
    await model.stop();
  }
});

test("同仓拆多单元:新节点继承该仓下单责任人为默认,单号不继承", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-unit-inherit-"));
  const repoA = join(dataDir, "svc-a");
  const repoB = join(dataDir, "svc-b");
  for (const repo of [repoA, repoB]) {
    execFileSync("git", ["init", "-q", "-b", "master", repo]);
    execFileSync("git", ["-C", repo, "commit", "-q", "--allow-empty",
      "-m", "init"], { env: GIT_ENV });
  }
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: join(dataDir, "no-kernel") },
  });
  const parent = service.create("多仓需求,A 仓要拆", {
    account: "owner", ticket: "REQ2026090301",
    repos: [repoA, repoB],
    repositoryAssignees: { [repoA]: "alice", [repoB]: "bob" },
    repositoryTickets: {
      [repoA]: "REQ2026090301", [repoB]: "REQ2026090302",
    },
  });
  const state = (service as any).tasks.get(parent.id);
  // 模拟分析会话现场:A 仓拆成两个单元,B 仓保持一个节点。
  const cwd = join(dataDir, "analysis-cwd");
  const artifactDir = join(cwd, ".mae-flow-work", "REQ2026090301");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "requirement-graph.json"), JSON.stringify({
    repositories: [
      { id: "unit-a1", name: "svc-a", url: repoA, responsibility: "契约",
        scope: { name: "契约骨架", paths: ["src/contract/"] } },
      { id: "unit-a2", name: "svc-a", url: repoA, responsibility: "实现",
        scope: { name: "过滤实现", paths: ["src/filter/"] } },
      { id: "unit-b", name: "svc-b", url: repoB, responsibility: "消费接口" },
    ],
    dependencies: [],
  }));
  state.cwd = cwd;
  (service as any).refreshRequirementGraph(state);
  const nodes = state.summary.requirement_graph.repositories;
  assert.deepEqual(nodes.map((node: { assignee?: string }) => node.assignee),
    ["alice", "alice", "bob"],
    "拆分后单元默认继承该仓下单责任人,不得回落主责任人");
  assert.deepEqual(nodes.map((node: { ticket?: string }) => node.ticket),
    [undefined, undefined, "REQ2026090302"],
    "同仓单元的单号不继承(逐单元填,继承同号会撞分支);单节点仓照旧");
  assert.equal(nodes[2].assignee, "bob",
    "未拆分的仓经 url 兜底完整保留下单事实");
});
