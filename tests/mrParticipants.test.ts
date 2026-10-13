import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { normalizeMrParticipants } from "../src/mrParticipants.ts";
import { readModuleMrParticipants, resolveModuleMrParticipants } from "../src/moduleMrParticipants.ts";
import { createBusinessModule, updateBusinessModule } from "../src/businessModuleLibrary.ts";
import { createMergeRequest, updateMergeRequestParticipants } from "../src/mrClient.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";

const people = { reviewers: ["alice"], approval_approvers: ["carol"] };
const repo = "https://git.example/team/a.git", repo2 = "https://git.example/team/b.git";

test("MR 人员按角色规范化，拒绝未知角色、null、分隔符和非账号值", () => {
  assert.deepEqual(normalizeMrParticipants({ reviewers: [" alice ", "alice", ""] }), { ...people, reviewers: ["alice"], approval_approvers: [] });
  for (const value of [null, [], "alice", { reviewers: null }, { reviewers: [1] }, { reviewers: ["alice,bob"] }, { assignees: [] }, { approval_reviewers: ["bob"] }]) {
    assert.throws(() => normalizeMrParticipants(value));
  }
});

test("模块全部关联仓共用一份人员，其他仓与知识模块不参与推导", t => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-mr-people-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  createBusinessModule(dir, { id: "orders", name: "订单", owner: "owner", description: "订单模块", repositories: [repo, repo2], mr_participants: people }, "owner");
  assert.deepEqual(resolveModuleMrParticipants(dir, "orders", repo), people);
  assert.deepEqual(resolveModuleMrParticipants(dir, "orders", repo2), people);
  assert.equal(resolveModuleMrParticipants(dir, "orders", "https://git.example/reference.git"), undefined);
  assert.equal(resolveModuleMrParticipants(dir, undefined, repo), undefined);
  assert.deepEqual(readModuleMrParticipants(dir, "orders"), people);
  assert.equal(readModuleMrParticipants(dir, undefined), undefined);
  updateBusinessModule(dir, "orders", { mr_participants: { reviewers: ["new-reviewer"] } }, "owner");
  assert.deepEqual(resolveModuleMrParticipants(dir, "orders", repo2)?.reviewers, ["new-reviewer"]);
});

test("MR 已创建但人员失败仍保留链接；旧适配器不回结果不能伪报成功", async t => {
  const calls: Array<{ path: string; body: any; token: string | string[] | undefined }> = [];
  let legacy = false;
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ path: req.url!, body, token: req.headers["x-mfc-git-token"] });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/mr/participants" ? { status: "applied" }
      : { id: 4, url: "https://code.example/merge_requests/4", ...(!legacy ? { participants: { status: "failed", message: "未配置读取字段" } } : {}) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const platformUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = { platformUrl, repo, sourceBranch: "feature", targetBranch: "main", title: "test", participants: people, credential: { username: "owner", password: "private-token" } };
  const receipt = await createMergeRequest(call);
  assert.equal(receipt.id, 4); assert.equal(receipt.participants?.status, "failed");
  assert.deepEqual(receipt.participants?.requested, people);
  assert.deepEqual(calls[0].body.participants, people);
  assert.equal(calls[0].token, "private-token");
  assert.ok(!JSON.stringify(calls[0].body).includes("private-token"));
  assert.equal((await updateMergeRequestParticipants({ ...call, mr: 4 })).status, "applied");
  assert.equal(calls[1].path, "/mr/participants");
  legacy = true;
  assert.equal((await createMergeRequest(call)).participants?.status, "failed");
});

test("需求子任务继承主模块；人员失败重试只更新同一 MR，普通成员无权代重试", async t => {
  const calls: Array<{ path: string; body: any }> = [];
  const platform = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push({ path: req.url!, body });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/mr/participants" ? { status: "applied" }
      : { id: 5, url: "https://code.example/merge_requests/5", participants: { status: "failed", message: "test" } }));
  });
  await new Promise<void>(resolve => platform.listen(0, "127.0.0.1", resolve));
  t.after(() => { platform.close(); platform.closeAllConnections(); });
  const platformUrl = `http://127.0.0.1:${(platform.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), "mfc-task-mr-people-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  createBusinessModule(dir, { id: "orders", name: "订单", owner: "owner", description: "订单模块", repositories: [repo, repo2], mr_participants: people }, "owner");
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0, delivery: { platformUrl } });
  const parent = service.create("需求", { account: "owner", businessModuleId: "orders", deferQueue: true });
  const child = service.create("子任务", { account: "owner", parentTaskId: parent.id, deferQueue: true });
  const state = (service as any).tasks.get(child.id);
  state.summary.repo_url = repo2;
  const receipt = await (service as any).createDeliveryMr(state, { platformUrl, repo: repo2, sourceBranch: "feature", targetBranch: "main", title: "test" });
  assert.deepEqual(calls[0].body.participants, people);
  assert.deepEqual((service as any).taskHostRuntime(state).mrParticipants(), people);
  state.summary.delivery = { mr_url: receipt.url, mr_id: receipt.id, source_branch: "feature", target_branch: "main", mr_participants: receipt.participants };
  updateBusinessModule(dir, "orders", { mr_participants: { reviewers: ["later"] } }, "owner");
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("owner", "test-password"); auth.createUser("member", "test-password", "developer");
  const server = createTaskServer(service, { auth });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const account of ["member", "owner"]) {
    const login = await fetch(`${base}/auth/login`, { method: "POST", body: JSON.stringify({ username: account, password: "test-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const response = await fetch(`${base}/tasks/${child.id}/mr-participants`, { method: "POST", headers: { cookie } });
    assert.equal(response.status, account === "owner" ? 200 : 403);
  }
  assert.deepEqual(calls.map(item => item.path), ["/mr", "/mr/participants"]);
  assert.deepEqual(calls[1].body.participants, people, "重试沿用失败时名单，不改用后来配置");
  assert.equal(service.get(child.id)?.delivery?.mr_participants?.status, "applied");
  const repeated = await (service as any).createDeliveryMr(state, { platformUrl, repo: repo2, sourceBranch: "feature", targetBranch: "main", title: "test" });
  assert.deepEqual(calls.at(-1)!.body.participants, { reviewers: ["later"], approval_approvers: [] });
  assert.equal(repeated.participants.status, "applied", "复用同一 MR 保留已经设置成功的事实");
});

test("需求同一分支对创建不同 MR 时仍带当前模块人员，不能借用旧 MR 的成功结果", async t => {
  const calls: any[] = [];
  const platform = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    calls.push(JSON.parse(raw));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: 6, url: "https://code.example/merge_requests/6",
      participants: { status: "failed", message: "新 MR 人员尚未设置" } }));
  });
  await new Promise<void>(resolve => platform.listen(0, "127.0.0.1", resolve));
  t.after(() => { platform.close(); platform.closeAllConnections(); });
  const platformUrl = `http://127.0.0.1:${(platform.address() as { port: number }).port}`;
  const dir = mkdtempSync(join(tmpdir(), "mfc-task-new-mr-people-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const currentPeople = { reviewers: ["later"], approval_approvers: ["new-approver"] };
  createBusinessModule(dir, { id: "orders", name: "订单", owner: "owner", description: "订单模块",
    repositories: [repo], mr_participants: currentPeople }, "owner");
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0, delivery: { platformUrl } });
  const task = service.create("需求", { account: "owner", businessModuleId: "orders", deferQueue: true });
  const state = (service as any).tasks.get(task.id);
  state.summary.repo_url = repo;
  state.summary.delivery = { mr_url: "https://code.example/merge_requests/5", mr_id: 5,
    source_branch: "feature", target_branch: "main", mr_state: "closed",
    mr_participants: { status: "applied", requested: people } };
  const receipt = await (service as any).createDeliveryMr(state, {
    platformUrl, repo, sourceBranch: "feature", targetBranch: "main", title: "test",
  });
  assert.deepEqual(calls[0].participants, currentPeople);
  assert.equal(receipt.url, "https://code.example/merge_requests/6");
  assert.deepEqual(receipt.participants, {
    status: "failed", requested: currentPeople, message: "新 MR 人员尚未设置",
  });
});
