/**
 * 下单表单的任务级可配项(用户拍板只有两个):模型选择、修复轮预算。
 * - /launch-options 是表单数据源:模型清单来自当前生效的 models.json,
 *   设置层热改即时反映;
 * - 下单即校验:不存在的模型、负的预算,400 打回,不许晚到会话才炸;
 * - 消费:任务级选择压过服务默认,记在 summary 上重启不漂移。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { RuntimeSettings } from "../src/settings.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

const SCRIPT: Scene[] = [{ text: "完成。" }];

test("launch-options:清单来自生效 models.json,设置层压部署层", () => {
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
  assert.deepEqual(before.models, [
    { provider: "a", model: "a-1" },
    { provider: "a", model: "a-2" },
    { provider: "b", model: "b-1" },
  ]);
  assert.deepEqual(before.default, { provider: "a", model: "a-1" });
  assert.equal(before.repair_rounds, 3);

  // 设置层热改:清单、默认、预算全部跟着走
  settings.updateModels({
    json: { providers: { c: { models: [{ id: "c-1" }] } } },
    provider: "c", model: "c-1",
  });
  settings.updateRuntime({ repair_rounds: 0 });
  const after = service.launchOptions();
  assert.deepEqual(after.models, [{ provider: "c", model: "c-1" }]);
  assert.deepEqual(after.default, { provider: "c", model: "c-1" });
  assert.equal(after.repair_rounds, 0);
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
  const kernelRoot = process.env.MAE_FLOW_HOME
    ?? join(process.cwd(), "..", "mae-flow");
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
  assert.equal(task.status, "completed", task.detail ?? "");
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

test("路由:/launch-options 登录可看;POST /tasks 带坏参数 400", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-lf-http-"));
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  auth.createUser("dev", "dev-password-11", "developer");
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
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
    const options = await fetch(`${base}/launch-options`,
      { headers: { cookie } });
    assert.equal(options.status, 200);
    assert.deepEqual((await options.json()).models,
      [{ provider: "maeflow", model: "scripted-v1" }]);

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
