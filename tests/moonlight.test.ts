/**
 * 两种"现成答案"的自动交卷(都走人工决定同一条通路,内核台账不缺账):
 * - 交付方式预答:下单就选好,内核举卡时对得上就交卷——送达用户早给的
 *   答案,不是宿主代做判断;对不上退回真等人;
 * - 月光模式(免审批):默认关;开=本人任务的卡一律代答直行,且对
 *   已在等的卡立刻清场;关=之后恢复审批。
 *
 * 假件说假话的教训(2026-08-18 内网实战):这里原来假的卡问"请选择本单
 * 的工作流车道",选项"快速车道/慢速车道"——内核压根没有这套词。用例
 * 于是只证明了宿主自言自语:预答按"车道"二字匹配,永远命中假卡、永远
 * 命中不了真卡,用户在真跑里被重复问一遍交付方式。现在假卡的选项**从
 * 内核 flow.json 现取**,内核改措辞用例跟着变,再没有自说自话的余地。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/jsonBody.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { createTaskServer } from "../src/server.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { workflowChoices } from "../src/kernelChoices.ts";
import { KERNEL_ROOT } from "./kernelFixture.ts";

// 内核的真选项(缺内核则空数组)。模型出卡时惯例在标签后带上代号,
// 内网实测就是"局部修改(tweak)"这种形状——假件照这个形状造。
const LANES = workflowChoices(KERNEL_ROOT);
const LANE_CARD: Scene = {
  tool: { name: "AskUserQuestion", input: { questions: [{
    question: "本单采用哪种交付方式?",
    options: LANES.map((item) => `${item.label}(${item.key})`),
  }] } },
};
const REVIEW_CARD: Scene = {
  tool: { name: "AskUserQuestion", input: { questions: [{
    question: "Diff 通过吗?", options: ["通过", "打回"],
  }] } },
};

async function settle(
  service: TaskService,
  id: string,
  accept: string[],
): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const status = service.get(id)!.status;
    if (accept.includes(status)) return status;
    await new Promise((tick) => setTimeout(tick, 100));
  }
  return service.get(id)!.status;
}

function allSeen(model: ScriptedModelServer): string {
  return model.requests
    .flatMap((request) => (request as any).messages ?? [])
    .map((message: any) => JSON.stringify(message.content ?? ""))
    .join("\n");
}

test("交付方式预答:内核举卡,下单选定的那项自动交卷,不等人", async (t) => {
  if (!LANES.length) {
    t.skip("缺内核 flow.json 的 workflow_select:仓内 kernel/ 快照不完整,"
      + "这条要停下来查(harness/sync-kernel.sh 刷新)");
    return;
  }
  const choice = LANES.find((item) => item.key === "tweak") ?? LANES[0];
  const lane = choice.label;
  const model = new ScriptedModelServer([LANE_CARD, { text: "收口。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-moon-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create("交付方式预答演练", { lane }).id;
  assert.equal(service.get(id)!.lane, lane);
  assert.equal(await settle(service, id, ["completed", "failed"]),
    "completed");
  // 交上去的必须是**内核选项原样**(它按选项文本对账,"approve"这种
  // 自造词会被判"没有检测到本步骤的真实选项回答"),且标明非人工答复
  assert.match(allSeen(model), new RegExp(`${lane}\\(${choice.key}\\)`));
  assert.match(allSeen(model), /非人工现场答复/);
  await model.stop();
});

test("选项卡上交自造词:放行但留明账(内核随后不认账时能对上因果)", async () => {
  // 内网实战:有人绕开界面直接打接口,交了个自造的 "approve",真正的
  // 选择写在备注里 → 内核按选项原文对账,判"没有检测到本步骤的真实选项
  // 回答",报错落在几步之后的 done 上,现场看着像流程卡死。
  // 宿主不替内核判定(界面允许自定义答复,那是合法用法),只把因果记明白。
  const logs: string[] = [];
  const model = new ScriptedModelServer([REVIEW_CARD, { text: "收口。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-offmenu-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    log: (line) => logs.push(line),
  });
  const id = service.create("自造词演练").id;
  await settle(service, id, ["waiting_for_human"]);
  await service.decide(id, {
    state_version: service.get(id)!.waiting!.state_version,
    decision: "approve",
    notes: "其实我想选通过",
  });
  assert.equal(await settle(service, id, ["completed", "failed"]), "completed",
    "只是提醒,不拦——拦下去就是在 TS 侧复刻内核判定");
  const warned = logs.filter((line) => line.includes("不在选项原文里"));
  assert.equal(warned.length, 1, `没留下明账,日志:\n${logs.join("\n")}`);
  assert.match(warned[0], /通过 \/ 打回/, "要把本卡的选项一并写出来");
  await model.stop();
});

test("月光关着:非车道卡真等人;月光开着:代答直行,答复带复盘要求", async () => {
  let moonlight = false;
  const model = new ScriptedModelServer([REVIEW_CARD, { text: "收口。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-moon-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    moonlight: (account) => account === "liao" && moonlight,
  });
  const id = service.create("月光演练", { account: "liao" }).id;
  assert.equal(await settle(service, id, ["waiting_for_human"]),
    "waiting_for_human", "默认关:该等人还是等人");

  // 随时开启:对已经在等的卡立刻生效
  moonlight = true;
  assert.equal(service.sweepMoonlight("liao"), 1);
  assert.equal(await settle(service, id, ["completed", "failed"]),
    "completed");
  assert.match(allSeen(model), /月光模式代答/);
  assert.match(allSeen(model), /事后人工复盘/);
  await model.stop();
});

test("月光开着到达的卡直接放行;别人的任务不受影响", async () => {
  const model = new ScriptedModelServer([REVIEW_CARD, { text: "收口。" }]);
  const other = new ScriptedModelServer([REVIEW_CARD, { text: "收口。" }]);
  await model.start();
  await other.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-moon-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    moonlight: (account) => account === "liao",
  });
  const mine = service.create("我的月光单", { account: "liao" }).id;
  assert.equal(await settle(service, mine, ["completed"]), "completed",
    "月光开着,卡到即放行");

  const others = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-moon-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: other.modelsJson(),
    moonlight: (account) => account === "liao",
  });
  const theirs = others.create("别人的单", { account: "wang" }).id;
  assert.equal(await settle(others, theirs, ["waiting_for_human"]),
    "waiting_for_human", "月光是个人开关,不放行别人的卡");
  await model.stop();
  await other.stop();
});

test("路由:开关落账、开启即清场、/auth/me 回显;账号库重启后记得住", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-moon-http-"));
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password-1");
  auth.createUser("dev", "dev-password-11", "developer");
  const model = new ScriptedModelServer([REVIEW_CARD, { text: "收口。" }]);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    moonlight: (account) => auth.moonlightEnabled(account),
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "dev", password: "dev-password-11" }),
    });
    const cookie = String(login.headers.get("set-cookie") ?? "").split(";")[0];

    // 先有一张在等的卡
    const id = service.create("路由月光单", { account: "dev" }).id;
    await settle(service, id, ["waiting_for_human"]);

    const on = await fetch(`${base}/auth/me/moonlight`, {
      method: "PUT", headers: { cookie },
      body: JSON.stringify({ on: true }),
    }).then((r) => readJson(r));
    assert.deepEqual(on, { moonlight: true, swept: 1 }, "开启即清场");
    assert.equal(await settle(service, id, ["completed"]), "completed");

    const me = await fetch(`${base}/auth/me`, { headers: { cookie } })
      .then((r) => readJson(r));
    assert.equal(me.moonlight, true);
    // 状态持久:重新加载账号库还开着
    assert.equal(new LocalAuth(join(dataDir, "auth.json"))
      .moonlightEnabled("dev"), true);

    const off = await fetch(`${base}/auth/me/moonlight`, {
      method: "PUT", headers: { cookie },
      body: JSON.stringify({ on: false }),
    }).then((r) => readJson(r));
    assert.equal(off.moonlight, false);
  } finally {
    server.close();
    await model.stop();
  }
});

test("管理员不填账号下单,任务仍归自己——月光与个人令牌都按归属人走", async () => {
  // 界面实走逮住的真 bug:下单表单的"小鲁班账号"是可选的,原来管理员
  // 不填就归属人为空,于是月光模式对自己下的单毫无反应、个人 Git 令牌
  // 也取不到。而部署后第一个账号正是管理员——最先踩坑的就是他。
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-ml-admin-"));
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  auth.createUser("boss", "boss-password-11", "admin");
  const model = new ScriptedModelServer([REVIEW_CARD, { text: "收口。" }]);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    moonlight: (account) => auth.moonlightEnabled(account),
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "boss", password: "boss-password-11" }),
    });
    const cookie = String(login.headers.get("set-cookie") ?? "").split(";")[0];

    const created = await fetch(`${base}/tasks`, {
      method: "POST", headers: { cookie },
      body: JSON.stringify({ requirement: "管理员自己的单" }),
    }).then((r) => readJson(r));
    assert.equal(created.luban_account, "boss", "不填账号就该归自己");
    await settle(service, created.id, ["waiting_for_human"]);

    const on = await fetch(`${base}/auth/me/moonlight`, {
      method: "PUT", headers: { cookie },
      body: JSON.stringify({ on: true }),
    }).then((r) => readJson(r));
    assert.deepEqual(on, { moonlight: true, swept: 1 },
      "月光开启要清掉管理员自己在等的卡");
    assert.equal(await settle(service, created.id, ["completed"]), "completed");

    // 替别人下单仍按填的账号走(管理员的正当用法,别被这条修改压掉)
    const forOther = await fetch(`${base}/tasks`, {
      method: "POST", headers: { cookie },
      body: JSON.stringify({ requirement: "替小张下的单", account: "zhang" }),
    }).then((r) => readJson(r));
    assert.equal(forOther.luban_account, "zhang");
  } finally {
    server.close();
    await model.stop();
  }
});
