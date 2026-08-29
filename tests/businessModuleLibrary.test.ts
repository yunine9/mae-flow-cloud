import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import {
  BusinessModuleError,
  archiveBusinessKnowledgeAsset,
  createBusinessModule,
  listBusinessModules,
  publishBusinessKnowledgeAsset,
  readBusinessModule,
  readBusinessKnowledgeAsset,
  updateBusinessModule,
} from "../src/businessModuleLibrary.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

test("业务模块由管理员指定 Owner；知识正文按版本发布且归档不删除历史", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-business-module-"));
  const created = createBusinessModule(dataDir, {
    id: "payment-core",
    name: "支付核心",
    description: "统一支付、退款和对账边界",
    owner: "owner-a",
    maintainers: ["maintainer-a", "owner-a"],
    repositories: ["https://code.example/pay.git"],
  }, "admin-a");
  assert.equal(created.owner, "owner-a");
  assert.deepEqual(created.maintainers, ["maintainer-a"]);
  assert.throws(() => updateBusinessModule(dataDir, created.id, {
    owner: "owner-b",
  }, "owner-a"), /只有管理员可以转移/);
  assert.throws(() => updateBusinessModule(dataDir, created.id, {
    status: "archived",
  }, "owner-a"), /只有管理员可以归档/);

  const v1 = publishBusinessKnowledgeAsset(dataDir, created.id, {
    id: "release-checklist",
    title: "支付发布清单",
    summary: "支付服务上线前的固定检查项",
    when_to_use: "修改支付链路、渠道配置或账务逻辑时",
    form: "rule",
    repositories: ["https://code.example/pay.git"],
    content: "# 支付发布清单\n\n第一版正文。\n",
  }, "owner-a");
  assert.equal(v1.assets[0].version, 1);
  assert.equal(v1.assets[0].form, "rule");
  assert.deepEqual(v1.assets[0].repositories,
    ["https://code.example/pay.git"]);
  const v2 = publishBusinessKnowledgeAsset(dataDir, created.id, {
    id: "release-checklist",
    title: "支付发布清单",
    summary: "支付服务上线前的固定检查项",
    when_to_use: "修改支付链路、渠道配置或账务逻辑时",
    content: "# 支付发布清单\n\n第二版正文。\n",
  }, "owner-a");
  assert.equal(v2.assets[0].version, 2);
  assert.equal(v2.assets[0].form, "rule");
  assert.deepEqual(v2.assets[0].repositories,
    ["https://code.example/pay.git"],
    "只更新正文不能静默抹掉形态与仓库作用域");
  assert.match(readBusinessKnowledgeAsset(
    dataDir, created.id, "release-checklist").content, /第二版/);
  assert.match(readBusinessKnowledgeAsset(
    dataDir, created.id, "release-checklist", 1).content, /第一版/);

  const archived = archiveBusinessKnowledgeAsset(
    dataDir, created.id, "release-checklist", "owner-a");
  assert.equal(archived.assets[0].status, "archived");
  assert.match(readBusinessKnowledgeAsset(
    dataDir, created.id, "release-checklist", 1).content, /第一版/,
  "归档只停止新任务选用，历史版本仍可追溯");
  assert.equal(listBusinessModules(dataDir).operations.length, 4);
  assert.throws(() => publishBusinessKnowledgeAsset(dataDir, created.id, {
    id: "bad-repository", title: "坏作用域", summary: "摘要",
    when_to_use: "任何时候", repositories: ["https://code.example/other.git"],
    content: "正文",
  }, "owner-a"), /未关联到业务模块/);
  assert.throws(() => createBusinessModule(dataDir, {
    id: "../escape", name: "坏模块", description: "越界",
    owner: "owner-a",
  }, "admin-a"), BusinessModuleError);
});

test("业务模块保存与更新强制至少绑定一个代码仓", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-business-module-min-repo-"));
  assert.throws(() => createBusinessModule(dataDir, {
    id: "empty-repos", name: "零仓模块", description: "没绑任何仓",
    owner: "owner-a", repositories: [],
  }, "admin-a"), /业务模块必须至少绑定一个代码仓/);
  assert.throws(() => createBusinessModule(dataDir, {
    id: "blank-repos", name: "空白仓模块", description: "仓列表全是空白项",
    owner: "owner-a", repositories: ["  ", "\t"],
  }, "admin-a"), /业务模块必须至少绑定一个代码仓/);
  assert.equal(listBusinessModules(dataDir).modules.length, 0,
    "被拦截的零仓模块不能落盘");

  const created = createBusinessModule(dataDir, {
    id: "payment-core", name: "支付核心", description: "统一支付边界",
    owner: "owner-a",
    repositories: ["https://code.example/pay.git",
      "https://code.example/refund.git"],
  }, "admin-a");
  assert.deepEqual(created.repositories,
    ["https://code.example/pay.git", "https://code.example/refund.git"],
    "多仓正常保存不受下限拦截影响");
  assert.throws(() => updateBusinessModule(dataDir, created.id, {
    repositories: [],
  }, "owner-a"), /业务模块必须至少绑定一个代码仓/);
  assert.throws(() => updateBusinessModule(dataDir, created.id, {
    repositories: [" "],
  }, "owner-a"), /业务模块必须至少绑定一个代码仓/);
  assert.deepEqual(readBusinessModule(dataDir, created.id).repositories,
    ["https://code.example/pay.git", "https://code.example/refund.git"],
    "清空仓的更新被拦后存量绑定原样保留");
});

test("HTTP 权限：admin 创建/转移 Owner；Owner 管资产；其他开发者只读", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-business-module-route-"));
  const auth = new LocalAuth(join(root, "auth.json"));
  auth.bootstrapAdmin("boss", "administrator-pass");
  auth.createUser("owner", "developer-pass-1", "developer");
  auth.createUser("next-owner", "developer-pass-2", "developer");
  auth.createUser("viewer", "developer-pass-3", "developer");
  const service = new TaskService({
    dataDir: join(root, "data"), provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (username: string, password: string) => {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST", body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  };
  try {
    assert.equal((await fetch(`${base}/business-modules`)).status, 401);
    const boss = await login("boss", "administrator-pass");
    const owner = await login("owner", "developer-pass-1");
    const viewer = await login("viewer", "developer-pass-3");
    const deniedCreate = await fetch(`${base}/business-modules`, {
      method: "POST", headers: { cookie: owner },
      body: JSON.stringify({ id: "pay", name: "支付", description: "支付域",
        owner: "owner" }),
    });
    assert.equal(deniedCreate.status, 403);
    const created = await fetch(`${base}/business-modules`, {
      method: "POST", headers: { cookie: boss },
      body: JSON.stringify({ id: "pay", name: "支付", description: "支付域",
        owner: "owner", repositories: ["https://code.example/pay.git"] }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json() as { owner: string }).owner, "owner");

    const deniedAsset = await fetch(`${base}/business-modules/pay/assets/rules`, {
      method: "PUT", headers: { cookie: viewer }, body: JSON.stringify({
        title: "规则", summary: "摘要", when_to_use: "改支付时", content: "正文",
      }),
    });
    assert.equal(deniedAsset.status, 403);
    const published = await fetch(`${base}/business-modules/pay/assets/rules`, {
      method: "PUT", headers: { cookie: owner }, body: JSON.stringify({
        title: "规则", summary: "摘要", when_to_use: "改支付时",
        form: "rule", repositories: ["https://code.example/pay.git"], content: "正文",
      }),
    });
    assert.equal(published.status, 200);
    const publishedView = await published.json() as {
      assets: Array<{ form: string; repositories: string[] }> };
    assert.equal(publishedView.assets[0].form, "rule");
    assert.deepEqual(publishedView.assets[0].repositories,
      ["https://code.example/pay.git"]);
    const readable = await fetch(`${base}/business-modules/pay/assets/rules`,
      { headers: { cookie: viewer } });
    assert.equal(readable.status, 200);
    assert.equal((await readable.json() as { content: string }).content, "正文");

    const ownerTransfer = await fetch(`${base}/business-modules/pay`, {
      method: "PUT", headers: { cookie: owner },
      body: JSON.stringify({ owner: "next-owner" }),
    });
    assert.equal(ownerTransfer.status, 400, "Owner 不能自行转移责任人");
    const adminTransfer = await fetch(`${base}/business-modules/pay`, {
      method: "PUT", headers: { cookie: boss },
      body: JSON.stringify({ owner: "next-owner" }),
    });
    assert.equal(adminTransfer.status, 200);
    assert.equal((await adminTransfer.json() as { owner: string }).owner,
      "next-owner");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
});
