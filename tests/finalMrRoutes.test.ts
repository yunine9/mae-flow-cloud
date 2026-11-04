import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { LocalAuth } from "../src/auth.ts";
import { createTaskServer } from "../src/server.ts";
import { TaskService, type TaskSummary } from "../src/taskService.ts";

test("最终 MR 路由沿用任务可读权限，只有责任人和管理员可关联，只接受合法 MR 地址", async t => {
  const dir = mkdtempSync(join(tmpdir(), "final-mr-http-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  const password = "test-final-mr-pass";
  auth.bootstrapAdmin("admin", password);
  for (const name of ["owner", "other"]) auth.createUser(name, password, "developer");
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const task = { id: "task-1", workspace: dir, luban_account: "owner" } as TaskSummary;
  service.storedTaskSummary = id => id === task.id ? task : undefined;
  const calls: string[] = [];
  service.linkFinalMr = async (_id, url) => { calls.push(url); return task; };
  const server = createTaskServer(service, { auth });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.close(); server.closeAllConnections(); await service.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const login = async (username: string) => {
    const r = await fetch(base + "/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
    assert.equal(r.status, 200);
    return r.headers.get("set-cookie")!.split(";")[0]!;
  };
  const link = (cookie: string, url: string) => fetch(base + "/tasks/task-1/final-mr", {
    method: "POST", headers: {cookie}, body: JSON.stringify({url}),
  });
  const mr = "https://code.example/team/repo/-/merge_requests/4";
  assert.equal((await link("", mr)).status, 401);
  assert.equal((await link(await login("other"), mr)).status, 403);
  const owner = await login("owner");
  assert.equal((await link(owner, "https://code.example/team/repo")).status, 400);
  assert.equal((await link(owner, mr + "?tab=changes#L12")).status, 200);
  assert.equal((await link(await login("admin"), mr)).status, 200);
  assert.deepEqual(calls, [mr, mr]);
  const detail = base + "/tasks/task-1/final-mr-comparison";
  assert.equal((await fetch(detail)).status, 401);
  assert.equal((await fetch(detail + "?generation=missing", {headers:{cookie:owner}})).status, 404);
});
