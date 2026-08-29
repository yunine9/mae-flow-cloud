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
import { FakeLubanServer, Notifier } from "../src/notifier.ts";

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

test("个人配置:退出重登与账号库重载后仍在,且不同用户严格隔离", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-auth-profile-"));
  const file = join(dir, "auth.json");
  const original = new LocalAuth(file);
  original.bootstrapAdmin("admin", "administrator-pass");
  original.createUser("alice", "alice-password-1", "developer");
  original.createUser("bob", "bob-password-123", "developer");
  original.setGitToken("alice", "alice-codehub-secret", "alice@example.com");
  original.setLubanToken("alice", "alice-luban-secret");
  original.setMoonlight("alice", true);
  original.setGitToken("bob", "bob-codehub-secret", "bob@example.com");
  original.setLubanToken("bob", "bob-luban-secret");
  original.createUser("carol", "carol-password-123", "developer");

  // 用新的 LocalAuth 模拟服务重启，证明事实来自账号文件而非前端内存。
  const auth = new LocalAuth(file);
  const service = new TaskService({
    dataDir: join(dir, "tasks"), provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  async function login(username: string, password: string) {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST", body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return {
      cookie: response.headers.get("set-cookie")!.split(";")[0],
      text: await response.text(),
    };
  }

  try {
    const alice = await login("alice", "alice-password-1");
    const aliceView = JSON.parse(alice.text) as Record<string, unknown>;
    assert.deepEqual(aliceView, {
      username: "alice",
      role: "developer",
      git_token_hint: "••••cret",
      git_email: "alice@example.com",
      luban_token_hint: "••••cret",
      moonlight: true,
      // push 前清单过目:真人缺省即开(2026-08-26 拍板)。
      push_confirmation: true,
      // 问题处理探索方式:缺省固定流程(2026-08-27 拍板)。
      issue_flow: "fixed",
    });
    assert.doesNotMatch(alice.text,
      /alice-codehub-secret|alice-luban-secret|bob-codehub-secret|bob@example/,
      "登录响应不得泄露本人明文或他人配置");

    const logout = await fetch(`${base}/auth/logout`, {
      method: "POST", headers: { cookie: alice.cookie },
    });
    assert.equal(logout.status, 200);
    const aliceAgain = await login("alice", "alice-password-1");
    assert.deepEqual(JSON.parse(aliceAgain.text), aliceView,
      "退出再登录后个人配置视图必须完整恢复");

    const bob = await login("bob", "bob-password-123");
    const bobView = JSON.parse(bob.text) as Record<string, unknown>;
    assert.deepEqual(bobView, {
      username: "bob",
      role: "developer",
      git_token_hint: "••••cret",
      git_email: "bob@example.com",
      luban_token_hint: "••••cret",
      moonlight: false,
      push_confirmation: true,
      issue_flow: "fixed",
    });
    assert.equal(bobView.git_email, "bob@example.com");
    assert.notEqual(bobView.git_email, aliceView.git_email);

    const me = await fetch(`${base}/auth/me`, {
      headers: { cookie: aliceAgain.cookie },
    });
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), aliceView,
      "登录响应与 /auth/me 不得再出现字段漂移");

    const users = await fetch(`${base}/auth/users`, {
      headers: { cookie: bob.cookie },
    });
    assert.equal(users.status, 403,
      "普通开发不能借账号管理接口读取其他用户信息");

    const candidates = await fetch(`${base}/auth/collaboration-assignees`, {
      headers: { cookie: bob.cookie },
    });
    assert.equal(candidates.status, 200);
    const candidateText = await candidates.text();
    const candidateRows = JSON.parse(candidateText) as Array<{
      username: string; ready: boolean; missing: string[];
    }>;
    assert.deepEqual(candidateRows.find((row) => row.username === "alice"), {
      username: "alice", ready: true, missing: [],
    });
    assert.deepEqual(candidateRows.find((row) => row.username === "carol"), {
      username: "carol", ready: true, missing: [],
    }, "纯会话部署不需要 Git/通知令牌，不能造一道假门");
    assert.doesNotMatch(candidateText,
      /alice@example\.com|alice-codehub-secret|alice-luban-secret|cret/,
      "委派候选接口只能暴露就绪状态，不能带邮箱或任何令牌提示");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

    // 这个权限测试用的是纯会话部署（按产品约束不能从 HTTP 下代码仓单），
    // 因而直接种一张跨仓摘要，只验证多人协作的 HTTP 权限边界。
    const cross = service.create("Bob 发起的跨仓主任务", { account: "bob" });
    const crossState = (service as any).tasks.get(cross.id);
    crossState.summary.repositories = [
      "https://codehub/team/api.git", "https://codehub/team/web.git",
    ];
    crossState.summary.requirement_graph = {
      stage: "analysis",
      repositories: [
        { id: "api", name: "api", url: "https://codehub/team/api.git" },
        { id: "web", name: "web", url: "https://codehub/team/web.git" },
      ],
      dependencies: [],
    };
    const invite = await fetch(`${base}/tasks/${cross.id}/collaborators`, {
      method: "PUT",
      headers: { cookie: bob },
      body: JSON.stringify({ collaborators: ["alice"] }),
    });
    assert.equal(invite.status, 200);
    assert.deepEqual((await readJson(invite) as { collaborators: string[] })
      .collaborators, ["alice"]);
    crossState.summary.status = "running";
    let steered = "";
    crossState.driver = { steer: async (text: string) => { steered = text; } };
    const collaborate = await fetch(`${base}/tasks/${cross.id}/interrupt`, {
      method: "POST",
      headers: { cookie: alice },
      body: JSON.stringify({ text: "接口字段还需要一起确认" }),
    });
    assert.equal(collaborate.status, 200,
      "受邀开发者可以进入同一个主任务和 AI 讨论");
    assert.match(steered, /跨仓协作 · alice.*接口字段还需要一起确认/);
    const collaboratorCannotInvite = await fetch(
      `${base}/tasks/${cross.id}/collaborators`, {
        method: "PUT", headers: { cookie: alice },
        body: JSON.stringify({ collaborators: [] }),
      });
    assert.equal(collaboratorCannotInvite.status, 403,
      "共同开发者不能改写主任务团队边界");

    const forbidden = await fetch(
      `${base}/tasks/${created.id}/decision`,
      {
        method: "POST",
        headers: { cookie: alice },
        body: JSON.stringify({ state_version: 1, decision: "通过" }),
      },
    );
    assert.equal(forbidden.status, 403);

    const forbiddenPause = await fetch(
      `${base}/tasks/${created.id}/pause`, {
        method: "POST", headers: { cookie: alice },
      });
    assert.equal(forbiddenPause.status, 403,
      "普通开发不能暂停别人的任务");
    const ownerPause = await fetch(
      `${base}/tasks/${created.id}/pause`, {
        method: "POST", headers: { cookie: bob },
      });
    assert.equal(ownerPause.status, 200);
    assert.equal((await ownerPause.json() as { status: string }).status, "paused");
    const admin = await login("admin", "administrator-pass");
    const adminResume = await fetch(
      `${base}/tasks/${created.id}/resume`, {
        method: "POST", headers: { cookie: admin },
      });
    assert.equal(adminResume.status, 200, "管理员可兜底恢复任务");

    const users = await fetch(`${base}/auth/users`, {
      headers: { cookie: alice },
    });
    assert.equal(users.status, 403, "普通开发不能管理账号");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("管理员特权:免旧密码重置 + 删号;底线是删自己/末位管理员/越权", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-auth-admin-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("alice", "alice-password-1", "developer");
  auth.createUser("bob", "bob-password-123", "developer");
  const service = new TaskService({
    dataDir: join(dir, "tasks"),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
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
    assert.equal(response.status, 200, `${username} 登录该成功`);
    return response.headers.get("set-cookie")!.split(";")[0];
  }

  try {
    const alice = await login("alice", "alice-password-1");
    const admin = await login("admin", "administrator-pass");

    // 越权先堵死:开发既不能重置别人密码,也不能删号。
    const stolen = await fetch(`${base}/auth/users/bob/password`, {
      method: "PUT", headers: { cookie: alice },
      body: JSON.stringify({ password: "hacked-password-1" }),
    });
    assert.equal(stolen.status, 403);
    const stab = await fetch(`${base}/auth/users/bob`, {
      method: "DELETE", headers: { cookie: alice },
    });
    assert.equal(stab.status, 403);

    // 管理员免旧密码重置:旧密码作废、旧会话下线、新密码可登录。
    const reset = await fetch(`${base}/auth/users/alice/password`, {
      method: "PUT", headers: { cookie: admin },
      body: JSON.stringify({ password: "alice-new-pass-9" }),
    });
    assert.equal(reset.status, 200);
    const staleSession = await fetch(`${base}/auth/me`, {
      headers: { cookie: alice },
    });
    assert.equal(staleSession.status, 401, "重置后旧会话必须下线");
    const oldLogin = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "alice", password: "alice-password-1" }),
    });
    assert.equal(oldLogin.status, 401, "旧密码必须作废");
    await login("alice", "alice-new-pass-9");
    // 弱密码照旧被同一套校验拦住,特权不豁免长度底线。
    const weak = await fetch(`${base}/auth/users/alice/password`, {
      method: "PUT", headers: { cookie: admin },
      body: JSON.stringify({ password: "short" }),
    });
    assert.equal(weak.status, 400);

    // 删号:人没了,登录当然也没了;名单如实收缩。
    const removed = await fetch(`${base}/auth/users/bob`, {
      method: "DELETE", headers: { cookie: admin },
    });
    assert.equal(removed.status, 200);
    const ghost = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "bob", password: "bob-password-123" }),
    });
    assert.equal(ghost.status, 401);
    const reused = await fetch(`${base}/auth/users`, {
      method: "POST", headers: { cookie: admin },
      body: JSON.stringify({
        username: "bob", password: "different-person-1", role: "developer",
      }),
    });
    assert.equal(reused.status, 400,
      "删除后的同名账号不能重建，否则会继承旧任务操作权");
    assert.match(await reused.text(), /不能同名重建/);
    const restoredAfterDelete = new LocalAuth(join(dir, "auth.json"));
    assert.throws(() => restoredAfterDelete.createUser(
      "bob", "different-person-1", "developer"), /不能同名重建/,
    "用户名墓碑必须跨服务重启保留");
    const roster = await fetch(`${base}/auth/users`, {
      headers: { cookie: admin },
    });
    assert.deepEqual(
      (await readJson(roster) as Array<{ username: string }>)
        .map((user) => user.username).sort(),
      ["admin", "alice"]);

    // 两条底线:不能删自己;不能删掉最后一个管理员。
    const suicide = await fetch(`${base}/auth/users/admin`, {
      method: "DELETE", headers: { cookie: admin },
    });
    assert.equal(suicide.status, 400, "不能删除自己");
    auth.createUser("admin2", "second-admin-pass", "admin");
    const admin2 = await login("admin2", "second-admin-pass");
    const removeAdmin = await fetch(`${base}/auth/users/admin`, {
      method: "DELETE", headers: { cookie: admin2 },
    });
    assert.equal(removeAdmin.status, 200, "还有别的管理员时可以删管理员");
    const lastStand = await fetch(`${base}/auth/users/admin2`, {
      method: "DELETE", headers: { cookie: admin2 },
    });
    assert.equal(lastStand.status, 400, "最后一个管理员必须删不掉");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Committer 检视:管理员只配名单,仅任务责任人主动邀请后才通知", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-review-http-"));
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("alice", "alice-password-1", "developer");
  auth.createUser("bob", "bob-password-123", "developer");
  // 接了通知端点的部署,下单前要求本人配过通知令牌(消息以本人身份
  // 发,管理员代配不了)——这里是走产品面下单,规矩照吃。
  auth.setLubanToken("alice", "luban-alice");
  const luban = new FakeLubanServer();
  await luban.start();
  const tokenLookups: string[] = [];
  const service = new TaskService({
    dataDir: join(dir, "tasks"), provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
    notifier: new Notifier({
      endpoint: luban.endpoint,
      backoffMs: [0],
      personalToken: (account) => {
        tokenLookups.push(account);
        return auth.lubanToken(account);
      },
    }),
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  async function login(username: string, password: string): Promise<string> {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST", body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  }

  try {
    const admin = await login("admin", "administrator-pass");
    const alice = await login("alice", "alice-password-1");
    const bob = await login("bob", "bob-password-123");
    const configured = await fetch(`${base}/auth/users/bob/committer`, {
      method: "PUT", headers: { cookie: admin }, body: JSON.stringify({ on: true }),
    });
    assert.equal(configured.status, 200);
    assert.equal((await configured.json() as { committer?: boolean }).committer, true);

    const committers = await fetch(`${base}/auth/committers`, {
      headers: { cookie: alice },
    });
    assert.equal(committers.status, 200, "普通开发可读取可选检视人");
    assert.deepEqual(await committers.json(), [
      { username: "bob", role: "developer", committer: true },
    ]);

    const createdResponse = await fetch(`${base}/tasks`, {
      method: "POST", headers: { cookie: alice },
      body: JSON.stringify({ requirement: "实现订单检索" }),
    });
    const created = await createdResponse.json() as { id: string };
    assert.equal(luban.messages.length, 0,
      "配置 Committer 后创建任务仍不会自动通知他");

    const adminCannotInvite = await fetch(
      `${base}/tasks/${created.id}/review-request`, {
        method: "POST", headers: { cookie: admin },
        body: JSON.stringify({ committer: "bob" }),
      });
    assert.equal(adminCannotInvite.status, 403,
      "管理员不能替责任人主动发起检视");
    const otherDeveloperCannotInvite = await fetch(
      `${base}/tasks/${created.id}/review-request`, {
        method: "POST", headers: { cookie: bob },
        body: JSON.stringify({ committer: "bob" }),
      });
    assert.equal(otherDeveloperCannotInvite.status, 403);

    const invalid = await fetch(
      `${base}/tasks/${created.id}/review-request`, {
        method: "POST", headers: { cookie: alice },
        body: JSON.stringify({ committer: "admin" }),
      });
    assert.equal(invalid.status, 400, "只能选择管理员配置的 Committer");
    assert.equal(luban.messages.length, 0);

    const invited = await fetch(
      `${base}/tasks/${created.id}/review-request`, {
        method: "POST", headers: {
          cookie: alice,
          // 后端 Host 即使是回环地址，也必须以浏览器实际访问的内网
          // Origin 为准；部署无需把某台机器 IP 硬编码进代码或启动项。
          origin: "http://mae-flow.intra:8787",
          "x-forwarded-host": "127.0.0.1:8787",
        },
        body: JSON.stringify({ committer: "bob" }),
    });
    assert.equal(invited.status, 200);
    const review = await invited.json() as {
      id: string; delivered: boolean; status: string;
    };
    assert.equal(review.delivered, true);
    assert.equal(review.status, "pending");
    assert.equal(luban.messages.length, 1);
    assert.equal(luban.messages[0].account, "bob");
    assert.deepEqual(tokenLookups, ["alice"],
      "用责任人的发送 Token 投给 Committer 工号，收件人无需配置 Token");
    assert.equal(luban.messages[0].text,
      `【Mae-Flow】任务 ${created.id} 邀请你检视：实现订单检索\n`
      + "手机端操作：先输入“/mfc”激活 Mae-Flow 插件；"
      + "未激活时，直接回复本消息不会进入 Mae-Flow。");
    assert.equal(luban.messages[0].link,
      `http://mae-flow.intra:8787/work/${created.id}/review/${review.id}`,
      "未配置 public-url 时按浏览器实际访问的内网 Origin 生成链接");

    // 回环地址不许污染学到的入口:管理员在服务器本机(或 SSH 隧道,
    // Host 就是 127.0.0.1)登录一次,不能把之后所有人的通知链接带沟里
    // ——内网实锤过"邀请检视发的是 127.0.0.1,别人点不开"。
    await fetch(`${base}/tasks`, {
      headers: { cookie: admin, origin: "http://127.0.0.1:8787" },
    });
    const reinvited = await fetch(
      `${base}/tasks/${created.id}/review-request`, {
        method: "POST", headers: { cookie: alice },
        body: JSON.stringify({ committer: "bob" }),
      });
    assert.equal(reinvited.status, 200);
    assert.match(String(luban.messages[1].link),
      /^http:\/\/mae-flow\.intra:8787\//,
      "回环访问之后,通知链接仍是此前学到的内网地址");

    const inbox = await fetch(`${base}/reviews/mine`, {
      headers: { cookie: bob },
    });
    assert.equal(inbox.status, 200);
    assert.equal((await inbox.json() as Array<{ id: string }>)[0].id, review.id,
      "通知之外还有持久化的待我检视收件箱");
    const adminCannotComplete = await fetch(
      `${base}/reviews/${review.id}/complete`, {
        method: "POST", headers: { cookie: admin },
      });
    assert.equal(adminCannotComplete.status, 403);
    const completed = await fetch(
      `${base}/reviews/${review.id}/complete`, {
        method: "POST", headers: { cookie: bob },
      });
    assert.equal(completed.status, 200);
    assert.equal((await completed.json() as { status: string }).status, "completed");

    const afterRestart = new TaskService({
      dataDir: join(dir, "tasks"), provider: "test", model: "test",
      modelsJson: {}, maxConcurrent: 0,
    });
    assert.equal(afterRestart.listReviewsFor("bob")[0]?.status, "completed",
      "检视记录与完成状态跨进程保留");

    const restored = new LocalAuth(join(dir, "auth.json"));
    assert.equal(restored.listUsers().find((user) => user.username === "bob")
      ?.committer, true, "Committer 名单持久化");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await luban.stop();
  }
});
