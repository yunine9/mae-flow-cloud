/**
 * 本地登录契约：密码不落明文、账号持久化、角色登录，
 * 开发可看全局但只能操作自己的任务。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/jsonBody.ts";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

test("账号库:scrypt 哈希落盘且重启后仍可登录", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-auth-"));
  const file = join(dir, "auth.json");
  const auth = new LocalAuth(file);
  auth.bootstrapAdmin("admin", "correct-horse-battery");
  auth.createUser("alice", "developer-password", "developer");

  const raw = readFileSync(file, "utf-8");
  assert.doesNotMatch(raw, /correct-horse-battery|developer-password/);
  assert.match(raw, /scrypt\$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const restored = new LocalAuth(file);
  assert.deepEqual(
    restored.authenticate("alice", "developer-password", "test").user,
    { username: "alice", role: "developer" },
  );
  assert.equal(
    restored.authenticate("alice", "wrong-password", "test").user,
    undefined,
  );
});

test("HTTP 登录:开发看全部任务,创建归自己,不能操作别人任务", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-auth-http-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("alice", "alice-password-1", "developer");
  auth.createUser("bob", "bob-password-123", "developer");
  const service = new TaskService({
    dataDir: join(dir, "tasks"),
    provider: "test",
    model: "test",
    modelsJson: {},
    maxConcurrent: 0,
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  async function login(username: string, password: string): Promise<string> {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  }

  try {
    const bob = await login("bob", "bob-password-123");
    const createdResponse = await fetch(`${base}/tasks`, {
      method: "POST",
      headers: { cookie: bob },
      body: JSON.stringify({
        requirement: "Bob 的任务",
        account: "alice",
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await readJson(createdResponse) as {
      id: string;
      luban_account: string;
    };
    assert.equal(created.luban_account, "bob", "开发不能把任务冒领给别人");

    const alice = await login("alice", "alice-password-1");
    const list = await fetch(`${base}/tasks`, {
      headers: { cookie: alice },
    });
    assert.equal(list.status, 200, "开发可查看团队全部任务");
    assert.equal((await readJson(list) as unknown[]).length, 1);

    const forbidden = await fetch(
      `${base}/tasks/${created.id}/decision`,
      {
        method: "POST",
        headers: { cookie: alice },
        body: JSON.stringify({ state_version: 1, decision: "通过" }),
      },
    );
    assert.equal(forbidden.status, 403);

    const users = await fetch(`${base}/auth/users`, {
      headers: { cookie: alice },
    });
    assert.equal(users.status, 403, "普通开发不能管理账号");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
