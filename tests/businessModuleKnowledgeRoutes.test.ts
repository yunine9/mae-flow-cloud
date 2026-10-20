import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createBusinessModule, readBusinessModule } from "../src/businessModuleLibrary.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

test("编辑模块一次保存领域目录并启动后台同步，普通编辑保留目录，知识页读取同一绑定", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-module-knowledge-api-"));
  createBusinessModule(dir, { id: "orders", name: "交易业务", description: "交易业务", owner: "owner", repositories: ["https://git.example/code.git"] }, "owner");
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const syncs: string[] = [];
  const sync = (moduleId: string) => { syncs.push(moduleId); };
  const mocked = Object.assign(service, { startModuleKnowledgeSync: sync });
  const server = createTaskServer(mocked);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/business-modules/orders`;
    const location = { repository: "https://git.example/knowledge.git", branch: "release/2026", docs_path: "domains/交易业务" };
    const update = async (body: object) => fetch(base, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const saved = await update({ knowledge_location: location });
    assert.equal(saved.status, 200); assert.deepEqual((await saved.json() as any).knowledge_location, location);
    assert.deepEqual(syncs, ["orders"], "保存即启动后台同步，不要求用户再点一次发布");
    const renamed = await update({ name: "交易中心" });
    assert.equal(renamed.status, 200);
    assert.deepEqual(readBusinessModule(dir, "orders").knowledge_location, location);
    const view = await (await fetch(`${base}/knowledge-location`)).json() as any;
    assert.equal(view.configured, true); assert.deepEqual(view.location, location);
    const stale = await fetch(`${base}/knowledge-location`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...location, docs_path: "wrong", expected_revision: 1 }) });
    assert.equal(stale.status, 400);
    assert.deepEqual(readBusinessModule(dir, "orders").knowledge_location, location);
    const invalid = await update({ knowledge_location: { ...location, docs_path: "../other" } });
    assert.equal(invalid.status, 400); assert.deepEqual(syncs, ["orders"]);
  } finally {
    await service.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
