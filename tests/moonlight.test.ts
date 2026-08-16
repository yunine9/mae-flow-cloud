/**
 * 两种"现成答案"的自动交卷(都走人工决定同一条通路,内核台账不缺账):
 * - 车道预答:下单就选好(默认慢速),内核 Q2 举卡时对得上就交卷——
 *   送达用户早给的答案,不是宿主代做判断;对不上退回真等人;
 * - 月光模式(免审批):默认关;开=本人任务的卡一律代答直行,且对
 *   已在等的卡立刻清场;关=之后恢复审批。
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

const LANE_CARD: Scene = {
  tool: { name: "AskUserQuestion", input: { questions: [{
    question: "请选择本单的工作流车道",
    options: ["快速车道", "慢速车道"],
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

test("车道预答:内核举卡问车道,下单预选的慢速自动交卷,不等人", async () => {
  const model = new ScriptedModelServer([LANE_CARD, { text: "收口。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-moon-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create("车道预答演练").id;   // 默认慢速
  assert.equal(service.get(id)!.lane, "慢速");
  assert.equal(await settle(service, id, ["completed", "failed"]),
    "completed");
  // 交上去的是选项原样标签(内核按标签记账),且标明非人工现场答复
  assert.match(allSeen(model), /慢速车道/);
  assert.match(allSeen(model), /非人工现场答复/);
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
