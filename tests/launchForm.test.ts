/**
 * 下单表单(口径 2026-08-18 按内网实战重定):
 * - **交付仓必填**,没有"默认仓"这回事——一个部署服务很多个仓,
 *   默认值只会让人漏看一眼就把单下错地方;
 * - **模型不给选**:管理员统一配一个,表单只显示"这单用谁跑";
 *   管理员贴完 models.json 即自动生效(不必再手打一遍 provider/model);
 * - 车道与修复轮预算仍按单可选;
 * - **配置没配齐不给下单**:服务级(模型/平台/通知)+ 个人级
 *   (Git 令牌/通知令牌)缺一样都 409,前端把缺项摆明面。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/jsonBody.ts";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { Notifier } from "../src/notifier.ts";
import { RuntimeSettings } from "../src/settings.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";

const SCRIPT: Scene[] = [{ text: "完成。" }];

test("launch-options:生效模型来自 models.json,设置层压部署层", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-lf-"));
  const settings = new RuntimeSettings(dataDir);
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1",
    modelsJson: { providers: {
      a: { models: [{ id: "a-1" }, { id: "a-2" }] },
      b: { models: [{ id: "b-1" }] },
    } },
    delivery: { platformUrl: "http://x", repairRounds: 3 },
    settings,
  });
  const before = service.launchOptions();
  assert.deepEqual(before.model, { provider: "a", model: "a-1" });
  assert.equal(before.repair_rounds, 3);

  // 设置层热改:生效模型与预算跟着走
  settings.updateModels({
    json: { providers: { c: { models: [{ id: "c-1" }] } } },
    provider: "c", model: "c-1",
  });
  settings.updateRuntime({ repair_rounds: 0 });
  const after = service.launchOptions();
  assert.deepEqual(after.model, { provider: "c", model: "c-1" });
  assert.equal(after.repair_rounds, 0);
});

test("模型默认自动派生:管理员只贴 models.json 也能直接用", () => {
  // 实测踩到:服务起来后表单是空的,人不知道还差"再手打一遍
  // provider/model"这一步。贴完就该能用——第一个 provider 的第一个
  // 模型即默认,显式配了才压过它。
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-lf-auto-"));
  const settings = new RuntimeSettings(dataDir);
  settings.updateModels({
    json: { providers: { gw: { models: [{ id: "glm-5.1" }, { id: "x" }] } } },
  });
  const service = new TaskService({
    dataDir, provider: "", model: "", modelsJson: {}, settings,
  });
  assert.deepEqual(service.launchOptions().model,
    { provider: "gw", model: "glm-5.1" });
  assert.ok(!service.launchOptions().blockers
    .some((item) => item.key === "model"), "配了就不该再报缺模型");
});

test("配置缺项:只拦真会咬人的那几样,文案说清去哪配", () => {
  // 一刀切的门禁会把用不上那件东西的部署一起挡在门外:纯会话形态
  // (不接代码仓)要什么 Git 令牌?没接通知端点要什么通知令牌?
  // 所以每条缺项都绑自己的前提。
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-lf-block-"));
  const kernel = new TaskService({
    dataDir, provider: "", model: "", modelsJson: {},
    host: { kernelRoot: "/tmp" },   // 接了仓,但没配平台
  });
  const keys = kernel.launchOptions().blockers.map((item) => item.key);
  assert.ok(keys.includes("model"), "没模型任何任务都跑不了,要拦");
  assert.ok(keys.includes("platform"), "内核模式没平台=交付不出去,要拦");
  assert.equal(kernel.launchOptions().needs.git_token, true,
    "接了代码仓就要个人 Git 令牌");
  assert.equal(kernel.launchOptions().needs.luban_token, false,
    "没接通知端点就别要通知令牌");
  // 缺项文案要说清由谁处理、以及不处理会怎样,不能只报一个字段名。
  for (const item of kernel.launchOptions().blockers) {
    assert.ok(/管理页|个人设置|部署维护/.test(item.label) && /；|;/.test(item.label),
      `缺项文案没说清去哪配/后果: ${item.label}`);
  }
  // 纯会话形态(不接仓):平台与 Git 令牌都不该被要求
  const chat = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-lf-chat-")),
    provider: "gw", model: "m",
    modelsJson: { providers: { gw: { models: [{ id: "m" }] } } },
  });
  assert.deepEqual(chat.launchOptions().blockers, []);
  assert.equal(chat.launchOptions().needs.git_token, false);
});

test("交付方式:选项与默认值都取自内核 flow.json,自造的当场打回", () => {
  // 内网实战逮住的摩擦:表单原来自造"快速/慢速车道",而内核 workflow_select
  // 的选项是 full/hotfix/tweak/review(完整开发/已定位问题修复/局部修改/
  // 处理评审意见)。两套词对不上 → 下单选过的交付方式在流程里又被问一遍。
  // 分类是内核的领地,宿主现读它的定义;这条用例就是防再抄一份的封条。
  const kernelRoot = discoverKernelRoot(process.cwd());
  if (!kernelRoot) throw new Error("找不到内核(仓内 kernel/ 快照应随仓自带)");
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-lf-lane-")),
    provider: "a", model: "a-1",
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot, repoPath: "/tmp/repo" },
  });
  const workflows = service.launchOptions().workflows;
  // review 不在新单表单里(内核 flow.json 的 new_order_choices:它仅限
  // 已交付单,新单选它必错;检视意见由 MR 修复环自动处理)。
  assert.deepEqual(workflows.map((item) => item.key),
    ["full", "hotfix", "tweak"]);
  assert.equal(workflows.find((item) => item.key === "tweak")!.label,
    "局部修改");
  assert.throws(() => service.create("新单想选评审",
    { repo: "https://x/r.git", ticket: "REQ1", lane: "处理评审意见" }),
    /交付方式只能是/);
  // 不填=内核第一项;自造词打回(免得下单选了个内核不认识的答案)
  assert.equal(service.create("默认交付方式").lane, workflows[0].label);
  assert.equal(service.create("空字符串也使用默认交付方式", { lane: "" }).lane,
    workflows[0].label,
    "旧前端 select 显示默认项却提交空串时不能阻断下单");
  assert.equal(service.create("纯空白也使用默认交付方式", { lane: "   " }).lane,
    workflows[0].label);
  assert.equal(service.create("点名交付方式", { lane: "局部修改" }).lane,
    "局部修改");
  assert.throws(() => service.create("x", { lane: "慢速车道" }),
    /交付方式只能是/);

  // 取值走的是内核**明面上的契约**(steps --json),不是扒 flow.json
  // 的内脏。这条同时兼作收编快照的新鲜度检查:快照旧到没有这个宿主口
  // 就会在这里露馅,而不是等到内网真跑时才发现表单是空的。
  const catalog = JSON.parse(execFileSync("python3",
    [join(kernelRoot, "scripts", "mae-flow.py"), "steps", "--json"],
    { encoding: "utf-8" }).trim().split("\n").pop()!);
  assert.deepEqual(
    catalog.workflows
      .filter((item: { for_new_orders: boolean }) => item.for_new_orders)
      .map((item: { key: string; answers: string[] }) =>
        ({ key: item.key, label: item.answers[0] })),
    workflows.map((item) => ({ key: item.key, label: item.label })),
    "表单选项必须与内核目录(新单可选集)逐字一致");
  // 步数/拍板数给人掂量快慢(完整开发=慢道,局部修改=快道),
  // 数字按内核 flow 现算:完整开发必然比局部修改步数多。
  const byKey = Object.fromEntries(
    workflows.map((item) => [item.key, item]));
  assert.ok(byKey.full.steps! > byKey.tweak.steps!,
    "完整开发的链应长于局部修改——快慢从数字上可见");
  assert.ok(byKey.full.acks! >= 1);
});

test("单号/基线分支:下单收齐,基线默认 master,纯会话形态不摆这些框", () => {
  // 用户 2026-08-19 拍板:这两项和交付方式一样在表单上一次给完,
  // 不让模型开工后再逐项来问。单号必填与"交付仓必填"同口径;
  // 基线分支给默认 master——多数单就交到 master,少数改一下即可。
  const kernel = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-lf-ticket-")),
    provider: "a", model: "a-1",
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: "/tmp" },
  });
  assert.deepEqual(kernel.launchOptions().ticket,
    { enabled: true, required: true });
  assert.deepEqual(kernel.launchOptions().baseline,
    { enabled: true, default: "master" });
  assert.throws(() => kernel.create("没单号", { repo: "https://x/r.git" }),
    /单号/);
  assert.throws(() => kernel.create("坏单号",
    { repo: "https://x/r.git", ticket: "REQ 123" }), /空白字符/);
  const created = kernel.create("齐活",
    { repo: "https://x/r.git", ticket: "REQ2026001" });
  assert.equal(created.ticket, "REQ2026001");
  assert.equal(created.baseline, "master", "不填基线就默认 master");
  const picked = kernel.create("点名基线",
    { repo: "https://x/r.git", ticket: "DTS9", baseline: "develop" });
  assert.equal(picked.baseline, "develop");

  // 纯会话形态:没有配置确认这回事,单号/基线的框都不该摆出来
  const chat = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-lf-chat2-")),
    provider: "a", model: "a-1",
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
  });
  assert.equal(chat.launchOptions().ticket.enabled, false);
  assert.equal(chat.create("纯会话不需要单号").ticket, undefined);
});

test("统一需求图:单仓是一个节点,多仓进入同一任务的需求分析阶段", () => {
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-lf-graph-")),
    provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: "/tmp" },
  });
  const one = service.create("单仓需求", {
    title: "订单状态接口", repos: ["https://codehub/team/api.git"], ticket: "REQ-G1",
  });
  assert.equal(one.title, "订单状态接口");
  assert.equal(one.requirement, "单仓需求", "任务名称不能覆盖需求原文");
  assert.equal(one.repo_url, "https://codehub/team/api.git");
  assert.equal(one.requirement_graph?.stage, "confirmed");
  assert.equal(one.requirement_graph?.repositories.length, 1);
  assert.deepEqual(one.requirement_graph?.dependencies, []);

  const many = service.create("多仓需求", {
    repos: [
      "https://codehub/team/api.git",
      "https://codehub/team/web.git",
      "https://codehub/team/api.git", // 重复输入只保留一个节点
    ], ticket: "REQ-G2",
  });
  assert.deepEqual(many.repositories, [
    "https://codehub/team/api.git", "https://codehub/team/web.git",
  ]);
  assert.equal(many.requirement_graph?.stage, "analysis");
  assert.deepEqual(many.requirement_graph?.repositories.map((item) => item.name),
    ["api", "web"]);
  assert.equal(many.parent_task_id, undefined,
    "多仓需求仍是一张普通需求单，不是第二套任务类型");
});

test("需求图确认:复用普通任务生成各仓交付,硬依赖保持排队", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-lf-chain-confirm-"));
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: "/tmp" },
  });
  const parent = service.create("跨仓交付", {
    title: "跨仓订单状态交付",
    repos: ["https://codehub/team/api.git", "https://codehub/team/web.git"],
    ticket: "REQ-G3",
  });
  const state = (service as any).tasks.get(parent.id);
  const root = join(dataDir, parent.id, "repositories");
  const artifacts = join(root, ".mae-flow-work", "REQ-G3");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, ".ticket-id"), "REQ-G3\n");
  writeFileSync(join(artifacts, "CHAIN-REQ-G3.md"), "# 已确认方案\n");
  writeFileSync(join(artifacts, "requirement-graph.json"), JSON.stringify({
    repositories: [
      { id: "api", name: "api", url: "https://codehub/team/api.git",
        responsibility: "提供接口" },
      { id: "web", name: "web", url: "https://codehub/team/web.git",
        responsibility: "消费接口" },
    ],
    // 历史产物的 from/to 是“api 先于 web”；升级后仍要读成 web 等 api。
    dependencies: [{ from: "api", to: "web", reason: "等待接口可用" }],
  }));
  state.cwd = root;
  (service as any).createRepositoryDeliveries(state);
  const graph = service.get(parent.id)!.requirement_graph!;
  const apiTask = service.get(graph.repositories[0].task_id!)!;
  const webTask = service.get(graph.repositories[1].task_id!)!;
  assert.equal(graph.stage, "confirmed");
  assert.equal(apiTask.parent_task_id, parent.id);
  assert.deepEqual(apiTask.blocked_by, undefined);
  assert.deepEqual(webTask.blocked_by, [apiTask.id]);
  // 方案正文落工作区文件而非内联进需求(整份方案进 prompt 会被模型
  // 当实施计划直接开写,跳过流程头部——2026-08-19 内网实锤)。
  assert.match(webTask.requirement, /\.mae-flow-chain\.md/,
    "子任务需求只指路方案文件,不再内联正文");
  assert.match(
    readFileSync(join(dataDir, webTask.id, "chain-plan.md"), "utf-8"),
    /已确认方案/,
    "人工检视过的 Chain 正文随子任务落盘,配置阶段经需求文档被读");
  assert.equal(apiTask.title, "跨仓订单状态交付 · api");
  assert.equal(webTask.title, "跨仓订单状态交付 · web");

  // 可重入:部分仓已有 task_id 时重跑,不许重复建任务(第 N 个仓
  // create 抛错/中途重启后的重试路径)。
  const before = service.list().length;
  (service as any).createRepositoryDeliveries(state);
  assert.equal(service.list().length, before, "重复确认不许再生任务");

  // 结构化确认入口:平台按钮直达,不依赖模型把选项原文写对;
  // 非分析单调用要如实拒绝。
  assert.equal((await service.confirmRequirementGraph(parent.id)).requirement_graph
    ?.repositories.every((repository) => repository.task_id), true);
  await assert.rejects(() => service.confirmRequirementGraph(apiTask.id),
    /不是多仓需求分析单/);
});

test("分析现场只读:真 push 必须在传输层死掉,不靠 prompt 嘱咐", () => {
  // 分析会话没有内核 preTool 门禁兜底,"禁止推送"若只是开场白的一句
  // 话,模型犯浑就真推上去了。用真仓验证:readonly 克隆后 push 失败,
  // 普通克隆(交付任务)push 照常。
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-lf-readonly-"));
  const origin = join(dataDir, "origin");
  execFileSync("git", ["init", "-q", "-b", "master", origin]);
  execFileSync("git", ["-C", origin, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: { ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: "/tmp" },
  });
  const guarded = (service as any).cloneRepo(
    join(dataDir, "ws1"), undefined, undefined, origin,
    undefined, "1-origin", true);
  execFileSync("git", ["-C", guarded, "commit", "-q", "--allow-empty",
    "-m", "escape"], { env: { ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.throws(() => execFileSync(
    "git", ["-C", guarded, "push", "-q", "origin", "master"],
    { stdio: "pipe" }), "只读分析现场的 push 必须失败");
  const normal = (service as any).cloneRepo(
    join(dataDir, "ws2"), undefined, undefined, origin, undefined, "repo");
  execFileSync("git", ["-C", normal, "commit", "-q", "--allow-empty",
    "-m", "deliver"], { env: { ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  execFileSync("git", ["-C", normal, "push", "-q", "origin",
    "master:deliver-check"], { stdio: "pipe" });
});

test("前置死透不许无限等:取消→子任务如实 failed;失败→留队说明", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-lf-chain-dep-"));
  const service = new TaskService({
    dataDir, provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: "/tmp" },
  });
  const parent = service.create("前置任务", {
    repos: ["https://codehub/team/api.git"], ticket: "REQ-D1",
  });
  const child = service.create("后置任务", {
    repos: ["https://codehub/team/web.git"], ticket: "REQ-D1",
    parentTaskId: "task-0", blockedBy: [parent.id],
  } as any);
  // maxConcurrent 0:两单都停在队列里,泵只做依赖清账不真启动。
  const parentState = (service as any).tasks.get(parent.id);
  parentState.summary.status = "failed";
  await (service as any).pump();
  assert.equal(service.get(child.id)!.status, "queued",
    "前置失败还有救(可重试),子任务留队");
  assert.match(service.get(child.id)!.detail ?? "", /前置任务.*失败/,
    "但必须把话写在明面上,不许静默蹲着");

  parentState.summary.status = "queued";
  await service.cancel(parent.id, "tester");
  // cancel 内部已触发泵(fire-and-forget),等它跑完。
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(service.get(child.id)!.status, "failed",
    "前置取消是终态,等它=永远等——子任务必须如实 failed");
  assert.match(service.get(child.id)!.detail ?? "", /已取消或不存在/);
});

test("假小鲁班不索个人令牌;部署切真端点后要求立刻恢复", () => {
  // 内网 agent 实测:演示形态(serve 自起假小鲁班)登进去第一件事就被
  // "先配个人通知令牌"挡住——假件收什么都行,那个令牌谁也不消费,
  // 这是一道谁也过不去也不必过的假门。判定跟着**生效端点**走:
  // 部署切成真端点后要求立刻恢复(真件确实按令牌认人)。
  let override: { endpoint?: string } = {};
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-lf-fake-luban-")),
    provider: "a", model: "a-1",
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    notifier: new Notifier({
      endpoint: "http://127.0.0.1:1/notify",
      fake: true,
      live: () => override,
    }),
  });
  assert.equal(service.launchOptions().needs.luban_token, false,
    "假件在场不该逼人配令牌");
  override = { endpoint: "http://luban.corp/notify" };
  assert.equal(service.launchOptions().needs.luban_token, true,
    "切了真端点,个人令牌的要求要立刻回来");
});

test("下单即校验:不存在的模型、负预算、带密码的仓地址,当场打回", () => {
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-lf-")),
    provider: "a", model: "a-1",
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: "/tmp", repoPath: "/tmp/repo" },
  });
  assert.throws(() =>
    service.create("x", { model: { provider: "a", model: "无此模型" } }),
    /没有模型/);
  assert.throws(() =>
    service.create("x", { repairRounds: -1 }), /≥0/);
  // 明文凭据拼 URL 是堵死的洞,下单口也不许开
  assert.throws(() =>
    service.create("x", { repo: "https://user:pass@codehub.corp/r.git" }),
    /不许携带账号密码/);
  assert.throws(() =>
    service.create("x", { repo: "https://a b/r.git" }), /空白字符/);
  // SSH 地址下单即拒(内网实锤:宿主凭据链是 HTTPS 令牌,SSH 推送必然
  // publickey 拒绝,还死在整轮流程跑完之后)。两种写法都要认得出。
  assert.throws(() =>
    service.create("x", {
      repo: "ssh://szv-y.codehub.corp:2222/MAE-M/Access/SONService.git" }),
    /请填 HTTPS 地址/);
  assert.throws(() =>
    service.create("x", { repo: "git@codehub.corp:MAE-M/r.git" }),
    /请填 HTTPS 地址/);
  // 本地路径(演练/试跑的假件形态)不能被 SSH 拦截误伤
  assert.doesNotThrow(() =>
    service.create("x", { repo: "/tmp/bare-repo.git" }));

  // 没接内核模式:仓字段整个不该出现(enabled=false),硬塞就打回
  const bald = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-lf-")),
    provider: "a", model: "a-1",
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
  });
  assert.equal(bald.launchOptions().repo.enabled, false);
  assert.throws(() => bald.create("x", { repo: "https://x/r.git" }),
    /未接内核模式/);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `mfc-lf-${name}-`));
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "config", "user.email", "bot@test");
  git(dir, "config", "user.name", "bot");
  writeFileSync(join(dir, `${name}.md`), `# ${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "init");
  return dir;
}

test("消费:任务级代码仓压过部署仓,克隆的就是下单填的那个", async () => {
  const repoA = makeRepo("aaa");
  const repoB = makeRepo("bbb");
  const kernelRoot = discoverKernelRoot(process.cwd());
  if (!kernelRoot) throw new Error("找不到内核(MAE_FLOW_HOME/../mae-flow/仓内 kernel/ 皆无)");
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-lf-repo-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: { kernelRoot, repoPath: repoA, python: "python3" },
  });
  const id = service.create("验证任务级代码仓", { repo: repoB }).id;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = service.get(id)!.status;
    if (status === "completed" || status === "failed") break;
    await new Promise((tick) => setTimeout(tick, 100));
  }
  const task = service.get(id)!;
  // 此剧本只验证 clone，不执行内核 init；clone 成功后必须由终态硬门禁
  // 如实停下，不能用模型的一句“完成”伪造 completed。
  assert.equal(task.status, "failed");
  assert.match(task.detail ?? "", /状态文件不存在|尚未初始化/);
  assert.equal(task.repo_url, repoB);
  // 克隆目录名与 origin 都指向下单填的仓,不是部署仓
  const clone = join(task.workspace, basename(repoB));
  assert.equal(git(clone, "remote", "get-url", "origin"), repoB);
  await model.stop();
});

test("消费:任务级模型选择压过服务默认(默认是打不通的网关)", async () => {
  // 服务默认 provider 指向死地址;任务点名剧本模型 → 能收口
  // = 会话真用了任务级选择。
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const scripted = (model.modelsJson() as {
    providers: Record<string, unknown>;
  }).providers;
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-lf-run-")),
    provider: "dead", model: "dead-1",
    modelsJson: { providers: {
      ...scripted,
      dead: { baseUrl: "http://127.0.0.1:1", api: "anthropic-messages",
              apiKey: "x", models: [{ id: "dead-1" }] },
    } },
  });
  const id = service.create("验证任务级模型",
    { model: { provider: "maeflow", model: "scripted-v1" } }).id;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = service.get(id)!.status;
    if (status === "completed" || status === "failed") break;
    await new Promise((tick) => setTimeout(tick, 100));
  }
  assert.equal(service.get(id)!.status, "completed",
    service.get(id)!.detail ?? "");
  assert.deepEqual(service.get(id)!.model_choice,
    { provider: "maeflow", model: "scripted-v1" });
  await model.stop();
});

test("路由:没配齐令牌 409 不给下单;补齐后放行;坏参数仍 400", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-lf-http-"));
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  auth.createUser("dev", "dev-password-11", "developer");
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    // 通知端点在场(服务级不缺),缺的只有这个人自己的两个令牌
    notifier: new Notifier({ endpoint: "http://127.0.0.1:1" }),
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const anonymous = await fetch(`${base}/launch-options`);
    assert.equal(anonymous.status, 401);

    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "dev", password: "dev-password-11" }),
    });
    const cookie = String(login.headers.get("set-cookie") ?? "").split(";")[0];
    const options = await readJson(
      await fetch(`${base}/launch-options`, { headers: { cookie } }));
    assert.deepEqual(options.model,
      { provider: "maeflow", model: "scripted-v1" });
    const keys = options.blockers.map((item: { key: string }) => item.key);
    // 这个部署接了通知端点、没接代码仓:只该要通知令牌
    assert.deepEqual(keys, ["luban_token"],
      `缺项应只有通知令牌,实际: ${keys.join(",")}`);

    // 后端硬拦:绕过界面直接打接口一样不给下单
    const blocked = await fetch(`${base}/tasks`, {
      method: "POST", headers: { cookie },
      body: JSON.stringify({ requirement: "x" }),
    });
    assert.equal(blocked.status, 409);
    assert.match((await readJson(blocked)).error, /配置未完成/);

    // 本人配上令牌 → 放行(管理员代配不了,密钥只写不读)
    auth.setLubanToken("dev", "luban-yyyy");
    const ok = await fetch(`${base}/tasks`, {
      method: "POST", headers: { cookie },
      body: JSON.stringify({ requirement: "配齐后下单" }),
    });
    assert.equal(ok.status, 201);

    // 参数校验照旧:坏模型/负预算 400(不是 409,那是配置问题)
    const bad = await fetch(`${base}/tasks`, {
      method: "POST", headers: { cookie },
      body: JSON.stringify({ requirement: "x",
        model: { provider: "maeflow", model: "不存在" } }),
    });
    assert.equal(bad.status, 400);
    const worse = await fetch(`${base}/tasks`, {
      method: "POST", headers: { cookie },
      body: JSON.stringify({ requirement: "x", repair_rounds: -2 }),
    });
    assert.equal(worse.status, 400);
  } finally {
    server.close();
    await model.stop();
  }
});
