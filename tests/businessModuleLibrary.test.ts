import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/** 落一份公共组件仓登记表(组件知识研究线与问题流共用的数据文件)。 */
function writeComponentRepositories(
  dataDir: string,
  rows: Array<Record<string, unknown>>,
): void {
  writeFileSync(join(dataDir, "component-repositories.json"),
    JSON.stringify(rows));
}

test("业务模块全员维护；知识正文按版本发布且归档不删除历史", () => {
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
  assert.equal(updateBusinessModule(dataDir, created.id, {
    owner: "owner-b",
  }, "member-a").owner, "owner-b");
  assert.equal(updateBusinessModule(dataDir, created.id, {
    status: "archived",
  }, "member-a").status, "archived");
  updateBusinessModule(dataDir, created.id, { status: "active" }, "member-b");

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
    title: "支付发布清单（新版）",
    summary: "第二版支付服务上线检查项",
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
  const historical = readBusinessKnowledgeAsset(
    dataDir, created.id, "release-checklist", 1);
  assert.match(historical.content, /第一版/);
  assert.equal(historical.asset.version, 1,
    "按版本读全文时，返回身份也必须对应该历史正文");
  assert.equal(historical.asset.digest, v1.assets[0].digest);
  assert.notEqual(historical.asset.digest, v2.assets[0].digest);
  assert.equal(historical.asset.title, "支付发布清单",
    "历史全文必须带发布当时的元数据，不能套用当前标题");
  assert.equal(historical.asset.summary, "支付服务上线前的固定检查项");

  const archived = archiveBusinessKnowledgeAsset(
    dataDir, created.id, "release-checklist", "owner-a");
  assert.equal(archived.assets[0].status, "archived");
  assert.match(readBusinessKnowledgeAsset(
    dataDir, created.id, "release-checklist", 1).content, /第一版/,
  "归档只停止新任务选用，历史版本仍可追溯");
  assert.equal(listBusinessModules(dataDir).operations.length, 7);
  writeFileSync(join(dataDir, "business-modules", created.id, "assets",
    "release-checklist", "v1.md"), "# 被篡改的历史正文\n");
  assert.throws(() => readBusinessKnowledgeAsset(
    dataDir, created.id, "release-checklist", 1), /发布指纹不一致/,
  "历史文件变化后必须拒绝展示，不能现场重算成同一个 v1");
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

test("模块参考组件仓订阅:存登记表条目引用,悬空引用拒绝,失效后保存打回", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-business-module-refcomp-"));
  writeComponentRepositories(dataDir, [
    { id: "comp-ui", name: "公共UI库",
      repository: "https://code.example/ui.git", branch: "master",
      path: "", languages: ["TypeScript"],
      description: "公共表格组件源码;排查表格渲染问题时读取", enabled: true },
    { id: "comp-old", name: "停用组件",
      repository: "https://code.example/old.git", branch: "master",
      path: "", languages: ["Java"],
      description: "已停用的旧组件源码", enabled: false },
  ]);
  const created = createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "统一支付边界",
    owner: "owner-a", repositories: ["https://code.example/pay.git"],
    reference_component_repos: ["comp-ui", "comp-old"],
  }, "admin-a");
  assert.deepEqual(created.reference_component_repos, ["comp-ui", "comp-old"],
    "订阅存条目引用(含停用条目——停用只是暂不注入,不是删除)");
  // 引用去重;悬空引用保存打回。
  assert.deepEqual(createBusinessModule(dataDir, {
    id: "pay-edge", name: "边界模块", description: "重复订阅去重",
    owner: "owner-a", repositories: ["https://code.example/edge.git"],
    reference_component_repos: ["comp-ui", "comp-ui", " "],
  }, "admin-a").reference_component_repos, ["comp-ui"]);
  assert.throws(() => createBusinessModule(dataDir, {
    id: "pay-ghost", name: "悬空模块", description: "引用不存在的条目",
    owner: "owner-a", repositories: ["https://code.example/ghost.git"],
    reference_component_repos: ["comp-ui", "ghost"],
  }, "admin-a"), /引用的组件仓条目不存在：ghost/);
  // 更新可改订阅、可清空;清空语义 = 显式传空数组(不传 = 维持现状)。
  assert.deepEqual(updateBusinessModule(dataDir, created.id, {
    reference_component_repos: [],
  }, "owner-a").reference_component_repos, []);
  updateBusinessModule(dataDir, created.id, {
    reference_component_repos: ["comp-ui"],
  }, "owner-a");
  // 登记表条目事后被删:存量订阅标失效由展示层处理,但任何再保存
  // 都会打回,迫使先清理悬空引用(失效不静默滞留)。
  writeComponentRepositories(dataDir, []);
  assert.throws(() => updateBusinessModule(dataDir, created.id, {
    description: "顺手改说明",
  }, "owner-a"), /引用的组件仓条目不存在：comp-ui/);
  assert.equal(updateBusinessModule(dataDir, created.id, {
    reference_component_repos: [],
    description: "清理订阅后正常保存",
  }, "owner-a").description, "清理订阅后正常保存");
});

test("模块编辑对话框:参考组件仓多选订阅,失效订阅提示,组件说明带填写指引", () => {
  const dialog = readFileSync(
    new URL("../web/src/ConfigurationCenter.tsx", import.meta.url), "utf-8");
  // 多选选择器:选项来自公共组件仓登记表,勾选即订阅;停用条目可
  // 订阅可取消(停用只是暂不注入,不是删除)。
  assert.match(dialog, /参考组件仓（可选）/);
  assert.match(dialog, /问题会话开场只注入这里勾选组件的「何时需要读取」描述/);
  assert.match(dialog, /reference_component_repos: edit\.refs \?\? \[\]/);
  assert.match(dialog, /components\.map\(c => <label key=\{c\.id\}/);
  assert.match(dialog, /\(edit\.refs \?\? \[\]\)\.filter\(id => !components\.some\(c => c\.id === id\)\)\.length > 0/);
  assert.match(dialog, /已失效订阅（条目已删除，保存前请取消勾选）/);
  // 登记表页签:组件说明的填写指引面向问题会话的拉取决策。
  const registry = readFileSync(
    new URL("../web/src/ComponentRepositories.tsx", import.meta.url), "utf-8");
  assert.match(registry, /写何时需要读取：问题会话的 AI 据此决定是否拉取源码/);
  assert.match(registry, /业务模块也可在这里订阅「参考组件仓」/);
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

test("HTTP 权限：所有登录成员维护模块映射与知识；匿名不可访问", async () => {
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
    const memberCreate = await fetch(`${base}/business-modules`, {
      method: "POST", headers: { cookie: owner },
      body: JSON.stringify({ id: "member-pay", name: "支付", description: "支付域",
        repositories: ["https://code.example/pay.git"] }),
    });
    assert.equal(memberCreate.status, 201);
    assert.equal((await memberCreate.json() as { owner: string }).owner, "owner");
    // 内网 HTTP 页面无需浏览器 crypto.randomUUID，省略 ID 由服务端生成。
    const generatedIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const generated = await fetch(`${base}/business-modules`, {
        method: "POST", headers: { cookie: owner },
        body: JSON.stringify({ name: "配置中心模块", description: "HTTP 创建",
          repositories: ["https://code.example/pay.git"] }),
      });
      assert.equal(generated.status, 201);
      const module = await generated.json() as { id: string; owner: string };
      assert.match(module.id, /^module-[0-9a-f-]{36}$/);
      assert.equal(module.owner, "owner");
      generatedIds.push(module.id);
      assert.equal((await fetch(`${base}/business-modules/${module.id}`,
        { headers: { cookie: owner } })).status, 200);
    }
    assert.notEqual(generatedIds[0], generatedIds[1]);
    const created = await fetch(`${base}/business-modules`, {
      method: "POST", headers: { cookie: boss },
      body: JSON.stringify({ id: "pay", name: "支付", description: "支付域",
        owner: "owner", repositories: ["https://code.example/pay.git"] }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json() as { owner: string }).owner, "owner");

    const memberAsset = await fetch(`${base}/business-modules/pay/assets/member-rules`, {
      method: "PUT", headers: { cookie: viewer }, body: JSON.stringify({
        title: "规则", summary: "摘要", when_to_use: "改支付时", content: "正文",
      }),
    });
    assert.equal(memberAsset.status, 200);
    const published = await fetch(`${base}/business-modules/pay/assets/rules`, {
      method: "PUT", headers: { cookie: owner }, body: JSON.stringify({
        title: "规则", summary: "摘要", when_to_use: "改支付时",
        form: "rule", repositories: ["https://code.example/pay.git"], content: "正文",
      }),
    });
    assert.equal(published.status, 200);
    const publishedView = await published.json() as {
      assets: Array<{ id: string; form: string; repositories: string[] }> };
    assert.equal(publishedView.assets.find(a => a.id === "rules")!.form, "rule");
    assert.deepEqual(publishedView.assets.find(a => a.id === "rules")!.repositories,
      ["https://code.example/pay.git"]);
    const readable = await fetch(`${base}/business-modules/pay/assets/rules`,
      { headers: { cookie: viewer } });
    assert.equal(readable.status, 200);
    assert.equal((await readable.json() as { content: string }).content, "正文");
    const republished = await fetch(
      `${base}/business-modules/pay/assets/rules`, {
        method: "PUT", headers: { cookie: owner }, body: JSON.stringify({
          title: "规则", summary: "摘要", when_to_use: "改支付时",
          content: "第二版正文",
        }),
      });
    assert.equal(republished.status, 200);
    const historicalResponse = await fetch(
      `${base}/business-modules/pay/assets/rules?version=1`,
      { headers: { cookie: viewer } });
    assert.equal(historicalResponse.status, 200);
    const historicalView = await historicalResponse.json() as {
      asset: { version: number }; content: string };
    assert.equal(historicalView.asset.version, 1);
    assert.equal(historicalView.content, "正文");
    const invalidVersion = await fetch(
      `${base}/business-modules/pay/assets/rules?version=latest`,
      { headers: { cookie: viewer } });
    assert.equal(invalidVersion.status, 400);

    const ownerTransfer = await fetch(`${base}/business-modules/pay`, {
      method: "PUT", headers: { cookie: owner },
      body: JSON.stringify({ owner: "next-owner" }),
    });
    assert.equal(ownerTransfer.status, 200, "普通成员同样可以维护模块元数据");
    const adminTransfer = await fetch(`${base}/business-modules/pay`, {
      method: "PUT", headers: { cookie: boss },
      body: JSON.stringify({ owner: "next-owner" }),
    });
    assert.equal(adminTransfer.status, 200);
    const memberArchive = await fetch(`${base}/business-modules/pay`, {
      method: "PUT", headers: { cookie: viewer }, body: JSON.stringify({ status: "archived" }),
    });
    assert.equal(memberArchive.status, 200);
    const archivedView = await memberArchive.json() as { status: string; updated_by: string; can_manage: boolean };
    assert.equal(archivedView.status, "archived");
    assert.equal(archivedView.updated_by, "viewer");
    assert.equal(archivedView.can_manage, true);
    assert.equal((await adminTransfer.json() as { owner: string }).owner,
      "next-owner");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
});
