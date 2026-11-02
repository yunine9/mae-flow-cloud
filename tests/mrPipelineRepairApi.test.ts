import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAuth } from "../src/auth.ts";
import { createTaskServer } from "../src/server.ts";
import { MrPipelineRepairs } from "../src/mrPipelineRepair.ts";
import type { TaskService } from "../src/taskService.ts";

test("独立修复 API：登录、本人记录、管理员边界与停止/重试", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mr-repair-api-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  const alice = auth.createUser("alice", "password123!", "developer"), bob = auth.createUser("bob", "password123!", "developer");
  const admin = auth.createUser("admin", "password123!", "admin");
  const headers = (user: typeof alice) => ({ cookie: `mae_flow_session=${auth.createSession(user)}`, "content-type": "application/json" });
  const a = headers(alice), b = headers(bob), root = headers(admin);
  const repairs = new MrPipelineRepairs({ dataDir: dir, runtime: {
    unavailableReason: () => undefined, detail: async () => { throw new Error("平台暂不可用"); },
    status: async () => ({ status: "not_found", runs: [] }), trigger: async () => {}, open: async () => { throw new Error("not reached"); },
  } });
  const taskService = { options: { dataDir: dir }, observeLinkBase: () => {} } as unknown as TaskService;
  const server = createTaskServer(taskService, { auth, pipelineRepairs: repairs });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(base + "/pipeline-repairs")).status, 401);
    assert.equal((await fetch(base + "/pipeline-repairs", { headers: root })).status, 403);
    const response = await fetch(base + "/pipeline-repairs", { method: "POST", headers: a, body: JSON.stringify({ mr_url: "https://codehub.test/g/r/merge_requests/1" }) });
    assert.equal(response.status, 202, await response.clone().text());
    const record = await response.json() as { id: string };
    const other = await fetch(base + "/pipeline-repairs", { headers: b });
    assert.deepEqual((await other.json() as { records: unknown[] }).records, []);
    assert.equal((await fetch(`${base}/pipeline-repairs/${record.id}`, { headers: b })).status, 404);
    assert.equal((await fetch(`${base}/pipeline-repairs/${record.id}/stop`, { method: "POST", headers: b })).status, 404);
    assert.equal((await fetch(`${base}/pipeline-repairs/${record.id}/stop`, { method: "POST", headers: a })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await fetch(`${base}/pipeline-repairs/${record.id}/retry`, { method: "POST", headers: a })).status, 202);
  } finally { await repairs.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
