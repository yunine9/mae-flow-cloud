/**
 * 运行时设置(管理页后端)的契约:
 * - 密钥只写不读:view() 永远掩码,API 不回明文——这是后面 Git token
 *   等一切密钥的模板,这里破例一次,后面全线泄漏;
 * - 覆盖语义:设置压过部署值,消费点即时读(并发/修复轮/模型);
 * - 读坏 fail-open 回部署值(它是旁路覆盖,不许挡服务);
 * - 路由权限:admin 才能改,开发成员 403。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { RuntimeSettings, SettingsError } from "../src/settings.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";

function store(): RuntimeSettings {
  return new RuntimeSettings(mkdtempSync(join(tmpdir(), "mfc-set-")));
}

test("模型密钥只写不读:视图永远掩码,明文只进 0600 的文件", () => {
  const settings = store();
  settings.updateModels({
    url: "http://gw", api_key: "sk-live-abcd4321", model: "glm-5.1",
  });

  const view = JSON.stringify(settings.view());
  assert.ok(!view.includes("sk-live-abcd4321"), "apiKey 明文漏进视图");
  assert.match(view, /••••4321/);
  // 明文在文件里(权限 600),消费点读得到
  const provider = (settings.models().json as any).providers.maeflow;
  assert.equal(provider.api, "anthropic-messages", "三项表单应转换为内部模型协议");
  assert.equal(provider.models[0].id, "glm-5.1");
  settings.updateModels({ url: "http://gw-v2", api_key: "", model: "glm-5.2" });
  assert.equal((settings.models().json as any).providers.maeflow.apiKey,
    "sk-live-abcd4321", "编辑时 API Key 留空应保留原密钥");
});

test("数值校验:无限等待没有语法;models 必须真实存在才能选", () => {
  const settings = store();
  assert.throws(() => settings.updateRuntime({ repair_rounds: -1 }),
    SettingsError);
  assert.throws(() => settings.updateRuntime({ poll_interval_s: "abc" }),
    SettingsError);
  assert.throws(() => settings.updateModels({ provider: "gpt" }),
    /先提供 models.json/);
  assert.throws(() => settings.updateModels({
    json: { providers: { glm: { models: [{ id: "glm-5.1" }] } } },
    provider: "glm", model: "no-such",
  }), /没有模型 no-such/);
});

test("旧版服务形态配置自动忽略:部署链路不再从管理页覆盖", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-set-old-repo-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    service: { default_repo: "https://codehub/old.git", platform_url: "http://git" },
  }));
  const settings = new RuntimeSettings(dir);
  assert.ok(!JSON.stringify(settings.view()).includes("service"));
});

test("读坏 fail-open:settings.json 损坏按无覆盖处理,不挡服务", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-set-"));
  writeFileSync(join(dir, "settings.json"), "{ 坏掉的");
  const settings = new RuntimeSettings(dir);
  assert.deepEqual(settings.runtime(), {});
  // 坏文件之上还能正常写入恢复
  settings.updateRuntime({ repair_rounds: 3 });
  assert.equal(settings.runtime().repair_rounds, 3);
});

const SCRIPT: Scene[] = [{ text: "完成。" }];

test("模型热改:下一个新会话用设置里的网关,部署值退位", async () => {
  // 部署给的是一个连不上的假地址;设置覆盖成真剧本服务器。
  // 任务能收口 = launch 写 agentDir/models.json 时读的是设置。
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-set-run-"));
  const settings = new RuntimeSettings(dataDir);
  settings.updateModels({
    json: model.modelsJson(),
    provider: "maeflow",
    model: "scripted-v1",
  });
  const service = new TaskService({
    dataDir,
    provider: "maeflow", model: "scripted-v1",
    modelsJson: { providers: { maeflow: {
      baseUrl: "http://127.0.0.1:1", api: "anthropic-messages",
      apiKey: "dead", models: [{ id: "scripted-v1" }],
    } } },
    settings,
  });
  const id = service.create("验证模型热改").id;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = service.get(id)!.status;
    if (status === "completed" || status === "failed") break;
    await new Promise((tick) => setTimeout(tick, 100));
  }
  assert.equal(service.get(id)!.status, "completed",
    service.get(id)!.detail ?? "");
  await model.stop();
});

test("路由权限:admin 可读改,开发成员 403,密钥不出网", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-set-http-"));
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password-1");
  auth.createUser("dev", "dev-password-11", "developer");
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  const settings = new RuntimeSettings(dataDir);
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), settings,
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function login(username: string, password: string): Promise<string> {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    return String(response.headers.get("set-cookie") ?? "").split(";")[0];
  }

  try {
    const admin = await login("admin", "admin-password-1");
    const dev = await login("dev", "dev-password-11");

    const denied = await fetch(`${base}/settings`, {
      headers: { cookie: dev } });
    assert.equal(denied.status, 403);
    const deniedCheck = await fetch(`${base}/settings/check`, {
      headers: { cookie: dev } });
    assert.equal(deniedCheck.status, 403, "部署自检也只允许管理员查看");

    const checked = await fetch(`${base}/settings/check`, {
      headers: { cookie: admin },
    });
    assert.equal(checked.status, 200);
    const checkBody = await checked.json() as {
      overall: string;
      items: Array<{ key: string; status: string }>;
    };
    assert.ok(["ok", "warning", "error"].includes(checkBody.overall));
    assert.deepEqual(checkBody.items.map((item) => item.key),
      ["data", "model", "notify", "postgres", "git", "container"]);
    assert.equal(checkBody.items.find((item) => item.key === "model")?.status,
      "ok");

    const put = await fetch(`${base}/settings/models`, {
      method: "PUT", headers: { cookie: admin },
      body: JSON.stringify({
        url: "http://model.internal",
        api_key: "secret-9999",
        model: "glm-5.1",
      }),
    });
    assert.equal(put.status, 200);
    const body = await fetch(`${base}/settings`, {
      headers: { cookie: admin } }).then((r) => r.text());
    assert.ok(!body.includes("secret-9999"), "明文密钥出网了");
    assert.match(body, /••••9999/);

    const bad = await fetch(`${base}/settings/runtime`, {
      method: "PUT", headers: { cookie: admin },
      body: JSON.stringify({ repair_rounds: -5 }),
    });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
    await model.stop();
  }
});
