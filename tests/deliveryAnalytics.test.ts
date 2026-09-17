import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { calculateDeliveryCode } from "../src/deliveryAnalyticsGit.ts";
import { collectDeliveryCode, buildDeliveryAnalysis, observeDeliveryCode, awaitDeliveryAnalytics, repairOrigin } from "../src/deliveryAnalytics.ts";
import { aggregateDelivery } from "../src/deliveryAnalyticsSummary.ts";
import { TaskService, type TaskSummary } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "delivery-analysis-")), cwd = join(dir, "repo"), workspace = join(dir, "task-1");
  mkdirSync(cwd); mkdirSync(workspace);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  const write = (path: string, content: string) => writeFileSync(join(cwd, path), content);
  const commit = (subject: string) => { git("add", "--all"); git("commit", "-m", subject); return git("rev-parse", "HEAD"); };
  write("existing.cpp", "int baseline = 1;\n");
  const base = commit("baseline"); git("update-ref", "refs/remotes/origin/main", base); git("checkout", "-b", "task");
  write(".mae-flow.json", JSON.stringify({ step_heads: { branch_create: base } }));
  const summary = { id: "task-1", title: "真实 Git 统计测试", requirement: "test", status: "await_merge", workspace,
    created_at: new Date().toISOString(), delivery: { target_branch: "main" } } as TaskSummary;
  const publish = (sha: string) => { summary.delivery!.git_push = { sha, ref: "refs/heads/task", remote: "origin" }; };
  return { dir, cwd, workspace, git, write, commit, base, summary, publish };
}

test("真实 Git：首次保留、CI、检视、反复修改分别计数；最终比率不是累计提交量", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "int a = 1;\nint b = 2;\nint c = 3;\n"); const first = f.commit("first");
  f.publish(first); await collectDeliveryCode(f.summary, f.cwd, first);
  f.summary.delivery!.loop = { round: 1, state: "repairing", kind: "ci", last_sha: first };
  f.write("feature.cpp", "int a = 10;\nint b = 2;\nint c = 3;\n"); const ci = f.commit("not inferred from subject");
  f.publish(ci); await collectDeliveryCode(f.summary, f.cwd, ci);
  f.summary.delivery!.loop = { round: 1, state: "repairing", kind: "review", last_sha: ci };
  f.write("feature.cpp", "int a = 20;\nint b = 2;\nint c = 3;\n"); const head = f.commit("review");
  f.publish(head); const result = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.deepEqual(result.retained, { first: 2, pipeline: 0, review: 1, other: 0 });
  assert.deepEqual(result.rework, { first: 0, pipeline: 2, review: 2, other: 0 });
  f.summary.status = "completed"; f.summary.delivery!.mr_state = "已合入"; f.summary.delivery!.merged_sha = head;
  f.git("update-ref", "refs/remotes/origin/main", head);
  rmSync(f.cwd, { recursive: true });
  const report = buildDeliveryAnalysis([f.summary]);
  assert.equal(report.rows[0].metric!.head, head, "workspace reclamation preserves numbers");
  assert.equal(aggregateDelivery(report.rows).firstPercent, 2 / 3 * 100);
});

test("目标分支的外来修改与合并提交不算任务首次提交或返工", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "int own = 1;\n"); const first = f.commit("own");
  f.git("checkout", "main"); f.write("existing.cpp", "int upstream = 2;\n"); const upstream = f.commit("someone else");
  f.git("update-ref", "refs/remotes/origin/main", upstream); f.git("checkout", "task"); f.git("merge", "--no-ff", "main", "-m", "sync target");
  const head = f.git("rev-parse", "HEAD"); f.publish(head);
  const metric = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(metric.first, first); assert.equal(metric.base, upstream);
  assert.deepEqual(metric.retained, { first: 1, pipeline: 0, review: 0, other: 0 });
  assert.equal(metric.commits.length, 1); assert.equal(aggregateDelivery([{ metric } as any]).total, 1);
});

test("纯重命名不增加返工；包含空格和换行的路径可追溯", async t => {
  const f = fixture(t), original = "new space\nfile.cpp", renamed = "renamed file.cpp";
  f.write(original, "int a = 1;\nint b = 2;\n"); const first = f.commit("first");
  f.git("mv", original, renamed); const head = f.commit("rename");
  const metric = await calculateDeliveryCode({ cwd: f.cwd, base: f.base, head });
  assert.equal(metric.retained.first, 2); assert.equal(metric.first, first);
  assert.equal(metric.commits[1].additions, 0); assert.equal(metric.commits[1].deletions, 0);
});

test("修改已存在文件后重命名只计真实变化；删除、文档、生成物不会虚增最终代码", async t => {
  const f = fixture(t);
  f.write("existing.cpp", "int baseline = 2;\n"); f.write("README.md", "docs\n");
  mkdirSync(join(f.cwd, "generated")); f.write("generated/a.cpp", "ignore\n"); const first = f.commit("first");
  f.git("mv", "existing.cpp", "renamed.cpp"); const head = f.commit("rename");
  const metric = await calculateDeliveryCode({ cwd: f.cwd, base: f.base, head });
  assert.equal(metric.retained.first, 1); assert.ok(metric.excluded_files >= 2);
  f.git("rm", "renamed.cpp"); const deleted = f.commit("remove");
  const final = await calculateDeliveryCode({ cwd: f.cwd, base: f.base, head: deleted, first });
  assert.equal(aggregateDelivery([{ metric: final } as any]).total, 0);
  assert.equal(final.deleted, 1);
});

test("混合修复或缺少前轮证据不猜归因；首个文档提交不会被换成首个代码提交", async t => {
  const f = fixture(t); f.write("README.md", "first docs\n"); const first = f.commit("docs");
  f.publish(first); await collectDeliveryCode(f.summary, f.cwd, first);
  f.summary.delivery!.loop = { round: 1, state: "repairing", kind: "ci", last_sha: first, workspace_review_pending: true };
  f.write("feature.cpp", "int a = 1;\n"); const head = f.commit("CI fix but really mixed"); f.publish(head);
  const metric = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(metric.first, first); assert.equal(metric.retained.other, 1); assert.equal(metric.retained.first, 0);
  assert.equal(repairOrigin({ round: 1, state: "repairing", kind: "conflict" }), "other");
});

test("历史改写不重定义首次提交；缺少合入前快照不造零值；采集失败不改变任务", async t => {
  const f = fixture(t); f.write("feature.cpp", "int a = 1;\n"); const first = f.commit("first");
  f.publish(first); await collectDeliveryCode(f.summary, f.cwd, first);
  f.git("reset", "--soft", f.base); const head = f.commit("rewritten first"); f.publish(head);
  const before = JSON.stringify(f.summary); observeDeliveryCode(f.summary, f.cwd, head); await awaitDeliveryAnalytics();
  assert.equal(JSON.stringify(f.summary), before);
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].metric, undefined);
  const other = { ...f.summary, id: "task-2", workspace: join(f.dir, "task-2") };
  f.git("update-ref", "refs/remotes/origin/main", head);
  await assert.rejects(collectDeliveryCode(other, f.cwd, head), /缺少合入前/);
});

test("父任务和问题单不重复纳入；缺失证据不参与平均；汇总按代码行加权", async t => {
  const f = fixture(t); f.write("feature.cpp", "int a = 1;\n"); const head = f.commit("first"); f.publish(head);
  await collectDeliveryCode(f.summary, f.cwd, head);
  f.summary.parent_task_id = "task-parent"; f.summary.status = "completed";
  Object.assign(f.summary.delivery!, { mr_state: "merged", merged_sha: head });
  const report = buildDeliveryAnalysis([f.summary, { ...f.summary, id: "task-parent", parent_task_id: undefined },
    { ...f.summary, id: "issue-task", origin: "issue" }, { ...f.summary, id: "task-missing" }]);
  assert.deepEqual(report.rows.map(r => r.id), ["task-1", "task-missing"]);
  const total = aggregateDelivery(report.rows); assert.equal(total.available, 1); assert.equal(total.tasks, 2); assert.equal(total.firstPercent, 100);
  f.summary.delivery!.merged_sha = f.base;
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].metric, undefined, "a different final source must not reuse stale statistics");
});

test("API 需登录，普通团队成员可读，响应与程序化统计一致", async t => {
  const f = fixture(t), auth = new LocalAuth(join(f.dir, "auth.json"));
  auth.bootstrapAdmin("admin", "analytics-test-pass"); auth.createUser("developer", "analytics-test-pass", "developer");
  const expected = buildDeliveryAnalysis([f.summary]);
  const service = new TaskService({ dataDir: f.dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  service.deliveryAnalysis = () => expected;
  const server = createTaskServer(service, { auth });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${url}/delivery-analytics`)).status, 401);
  const response = await fetch(`${url}/auth/login`, { method: "POST", body: JSON.stringify({ username: "developer", password: "analytics-test-pass" }) });
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const result = await fetch(`${url}/delivery-analytics`, { headers: { cookie } });
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), JSON.parse(JSON.stringify(expected)));
});
