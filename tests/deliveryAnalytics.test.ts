import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { inferCommitOrigin } from "../src/deliveryOriginInference.ts";
import { calculateDeliveryCode } from "../src/deliveryAnalyticsGit.ts";
import { collectDeliveryCode, buildDeliveryAnalysis, observeDeliveryCode, awaitDeliveryAnalytics, repairOrigin, recordDeliveryPublication } from "../src/deliveryAnalytics.ts";
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

test("并行流水线与检视有明确CI依据归流水线；首个文档提交不会被换成首个代码提交", async t => {
  const f = fixture(t); f.write("README.md", "first docs\n"); const first = f.commit("docs");
  f.publish(first); await collectDeliveryCode(f.summary, f.cwd, first);
  f.summary.delivery!.loop = { round: 1, state: "repairing", kind: "ci", last_sha: first, workspace_review_pending: true };
  f.write("feature.cpp", "int a = 1;\n"); const head = f.commit("CI fix but really mixed"); f.publish(head);
  const metric = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(metric.first, first); assert.equal(metric.retained.pipeline, 1); assert.equal(metric.retained.first, 0);
  assert.equal(repairOrigin({ round: 1, state: "repairing", kind: "conflict" }), "review");
});

test("历史改写不重定义首次提交；合入后可用任务基线补算；采集失败不改变任务", async t => {
  const f = fixture(t); f.write("feature.cpp", "int a = 1;\n"); const first = f.commit("first");
  f.publish(first); await collectDeliveryCode(f.summary, f.cwd, first);
  f.git("reset", "--soft", f.base); const head = f.commit("rewritten first"); f.publish(head);
  const before = JSON.stringify(f.summary); observeDeliveryCode(f.summary, f.cwd, head); await awaitDeliveryAnalytics();
  assert.equal(JSON.stringify(f.summary), before);
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].metric, undefined);
  const other = { ...f.summary, id: "task-2", workspace: join(f.dir, "task-2") };
  f.git("update-ref", "refs/remotes/origin/main", head);
  const recovered = await collectDeliveryCode(other, f.cwd, head);
  assert.equal(recovered.base, f.base); assert.equal(recovered.retained.first, 1);
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
  f.publish(f.base);
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].metric, undefined, "a different pushed source must not reuse stale statistics");
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

test("漏采推送仍按修复起点归因，不把更早的未知提交归入本轮", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "int a = 1;\n"); const first = f.commit("first");
  f.publish(first); await collectDeliveryCode(f.summary, f.cwd, first);
  f.write("feature.cpp", "int a = 2;\n"); const unsampled = f.commit("unknown");
  f.summary.delivery!.loop = { round: 2, state: "repairing", kind: "review", last_sha: unsampled };
  f.write("feature.cpp", "int a = 3;\n"); const head = f.commit("change"); f.publish(head);
  const result = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(result.commits.find(c => c.sha === unsampled)?.origin, "first");
  assert.equal(result.commits.find(c => c.sha === head)?.origin, "review");
  assert.deepEqual(result.rework, { first: 0, pipeline: 0, review: 2, other: 0 });
  const fresh = { ...f.summary, id: "task-fresh" };
  const withoutSnapshot = await collectDeliveryCode(fresh, f.cwd, head);
  assert.deepEqual(withoutSnapshot.retained, result.retained, "归因不要求曾采集上轮快照");
});

test("同一源版本的新证据自动更新缓存，合入后仍沿用采集基线，刷新不重复计数", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "int a = 1;\n"); const first = f.commit("first");
  f.write("feature.cpp", "int a = 2;\n"); const head = f.commit("change"); f.publish(head);
  observeDeliveryCode(f.summary, f.cwd, head); await awaitDeliveryAnalytics();
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].metric?.retained.first, 1);
  f.git("update-ref", "refs/remotes/origin/main", head);
  f.summary.delivery!.loop = { round: 1, state: "merged", kind: "ci", last_sha: first };
  observeDeliveryCode(f.summary, f.cwd, head); await awaitDeliveryAnalytics();
  const corrected = buildDeliveryAnalysis([f.summary]).rows[0].metric!;
  assert.equal(corrected.retained.pipeline, 1); assert.equal(corrected.rework.pipeline, 2);
  assert.equal(corrected.base, f.base);
  const cacheDir = join(f.dir, ".delivery-analysis");
  const cachePath = join(cacheDir, readdirSync(cacheDir).find(name => name.endsWith(".json"))!);
  const legacy = JSON.parse(readFileSync(cachePath, "utf8"));
  delete legacy.attribution;
  legacy.metric.commits.find((c: { sha: string }) => c.sha === head).origin = "other";
  legacy.metric.retained = { first: 0, pipeline: 0, review: 0, other: 1 };
  writeFileSync(cachePath, JSON.stringify(legacy));
  observeDeliveryCode(f.summary, f.cwd, head); await awaitDeliveryAnalytics();
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].metric!.retained.pipeline, 1, "旧版缓存自动升级");
  observeDeliveryCode(f.summary, f.cwd, head, true); await awaitDeliveryAnalytics();
  const refreshed = buildDeliveryAnalysis([f.summary]).rows[0].metric!;
  assert.deepEqual(refreshed.rework, corrected.rework);
  assert.equal(refreshed.commits.length, 2);
});

test("无效修复锚不使统计失败，已识别的历史原因不被后来轮次覆盖", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "int a = 1;\n"); const first = f.commit("first");
  f.write("feature.cpp", "int a = 2;\n"); const ci = f.commit("change"); f.publish(ci);
  f.summary.delivery!.loop = { round: 1, state: "repairing", kind: "ci", last_sha: first };
  await collectDeliveryCode(f.summary, f.cwd, ci);
  f.write("feature.cpp", "int a = 3;\n"); const head = f.commit("change again"); f.publish(head);
  f.summary.delivery!.loop = { round: 2, state: "repairing", kind: "review", last_sha: first };
  const result = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(result.commits.find(c => c.sha === ci)?.origin, "pipeline");
  assert.equal(result.commits.find(c => c.sha === head)?.origin, "review");
  f.git("checkout", "main"); f.write("other.cpp", "int other = 1;\n"); const unrelated = f.commit("unrelated");
  f.git("checkout", "task");
  for (const anchor of [unrelated, "a".repeat(40), "not-a-sha"]) {
    f.summary.delivery!.loop!.last_sha = anchor;
    const isolated = await collectDeliveryCode({ ...f.summary, id: `task-${anchor}` }, f.cwd, head);
    assert.equal(isolated.retained.first, 1);
  }
});

test("真实 squash 合入目标 SHA 不等于源 SHA，仍计入汇总；旧源快照不冒充新推送", async t => {
  const f = fixture(t);
  f.write("feature.cpp", "int a = 1;\n"); f.commit("first");
  f.write("feature.cpp", "int a = 2;\n"); const head = f.commit("second"); f.publish(head);
  await collectDeliveryCode(f.summary, f.cwd, head);
  f.git("checkout", "main"); f.git("merge", "--squash", "task"); const merged = f.commit("squashed delivery");
  assert.notEqual(merged, head);
  f.summary.status = "completed";
  Object.assign(f.summary.delivery!, { mr_state: "merged", merged_sha: merged });
  assert.equal(aggregateDelivery(buildDeliveryAnalysis([f.summary]).rows).available, 1);
  rmSync(f.cwd, { recursive: true });
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].metric!.head, head);
  f.publish(merged);
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].metric, undefined);
});


test("15 个提交：仅最后轮次在 loop 中，历史批次仍完整恢复前几轮分类", async t => {
  const f = fixture(t), commits: string[] = [];
  for (let i = 0; i < 15; i++) {
    f.write("feature.cpp", `int a = ${i};\n`); commits.push(f.commit(`commit ${i}`));
  }
  const head = commits[14]; f.publish(head);
  f.summary.delivery!.loop = { round: 3, state: "merged", kind: "review", last_sha: commits[13] };
  const before = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(before.commits.filter(c => c.origin === "first").length, 14);
  const batch = (id: string, base: string, end: string, source: string) => ({
    task_id: f.summary.id, batch_id: id, base_sha: base, result_head: end,
    result_digest: "recorded", items: [{ source }], status: "closed",
  });
  f.write(".mae-flow.json", JSON.stringify({ step_heads: { branch_create: f.base }, delivery_loop: { batches: [
    batch("review-1", commits[0], commits[3], "mr_discussion"),
    batch("ci-1", commits[3], commits[10], "pipeline"),
    batch("review-2", commits[10], commits[13], "workspace"),
  ] } }));
  observeDeliveryCode(f.summary, f.cwd, head); await awaitDeliveryAnalytics();
  const result = buildDeliveryAnalysis([f.summary]).rows[0].metric!;
  assert.deepEqual(result.commits.map(c => c.origin), ["first", ...Array(3).fill("review"), ...Array(7).fill("pipeline"), ...Array(4).fill("review")]);
  assert.deepEqual(result.rework, { first: 0, pipeline: 14, review: 14, other: 0 });
  assert.match(result.commits[1].origin_evidence!.join(" "), /review-1/);
});

test("推送时先保存区间，Git 采集失败后仍能恢复多轮；重复登记不重复计数", async t => {
  const f = fixture(t); f.write("feature.cpp", "int a = 1;\n"); const first = f.commit("first");
  f.write("feature.cpp", "int a = 2;\n"); const ci = f.commit("ci"); f.publish(ci);
  f.summary.delivery!.loop = { round: 1, state: "repairing", kind: "ci", last_sha: first };
  recordDeliveryPublication(f.summary, join(f.dir, "missing"), ci); await awaitDeliveryAnalytics();
  f.write("feature.cpp", "int a = 3;\n"); const review = f.commit("review"); f.publish(review);
  f.summary.delivery!.loop = { round: 2, state: "repairing", kind: "review", last_sha: ci };
  recordDeliveryPublication(f.summary, undefined, review);
  recordDeliveryPublication(f.summary, undefined, review);
  delete f.summary.delivery!.loop;
  const result = await collectDeliveryCode(f.summary, f.cwd, review);
  assert.deepEqual(result.commits.map(c => c.origin), ["first", "pipeline", "review"]);
  assert.deepEqual(result.rework, { first: 0, pipeline: 2, review: 2, other: 0 });
});

test("反馈区间交叠有明确CI依据归流水线；其他任务、仅验证通过、未处理批次不能冒充修复证据", async t => {
  const f = fixture(t); f.write("feature.cpp", "int a = 1;\n"); const first = f.commit("first");
  f.write("feature.cpp", "int a = 2;\n"); const head = f.commit("change"); f.publish(head);
  f.summary.delivery!.loop = { round: 1, state: "repairing", kind: "review", last_sha: first };
  const batch = { task_id: f.summary.id, batch_id: "ci", base_sha: first, result_head: head,
    result_digest: "recorded", items: [{ source: "pipeline" }], status: "closed" };
  const writeBatches = (batches: unknown[]) => f.write(".mae-flow.json", JSON.stringify({
    step_heads: { branch_create: f.base }, delivery_loop: { batches } }));
  writeBatches([batch, { ...batch, batch_id: "review", items: [{ source: "workspace" }] }]);
  const mixed = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(mixed.retained.pipeline, 1); assert.equal(mixed.commits[1].origin_evidence!.length, 2);
  writeBatches([{ ...batch, task_id: "another-task" },
    { ...batch, result_digest: undefined, result_head: undefined, verified_sha: head },
    { ...batch, result_digest: undefined, status: "queued" }]);
  const ignored = await collectDeliveryCode({ ...f.summary, workspace: join(f.dir, "fresh-task") }, f.cwd, head);
  assert.equal(ignored.retained.review, 1);
  writeBatches([{ ...batch, result_digest: undefined, result_head: undefined, superseded_by_push: head }]);
  const published = await collectDeliveryCode({ ...f.summary, workspace: join(f.dir, "published-task") }, f.cwd, head);
  assert.equal(published.retained.pipeline, 1, "被本次发布替代的流水线反馈保留修复区间");
});


test("缺少历史记录时按提交说明推断，最终代码来源与累计修改同步更新", async t => {
  const f = fixture(t);
  f.write("a.cpp", "int a = 1;\n"); const first = f.commit("first");
  f.write("a.cpp", "int a = 2;\n"); f.commit("按检视意见删除IR接口token");
  f.write("b.cpp", "int b = 1;\n"); f.commit("修复CodeCheck行宽");
  f.write("c.cpp", "int c = 1;\n"); f.commit("补单测修复DT覆盖率");
  f.write("d.cpp", "int d = 1;\n"); f.commit("调整实现\n\nAddress review feedback and fix CodeCheck warnings");
  f.write("e.cpp", "int e = 1;\n"); const head = f.commit("新增功能"); f.publish(head);
  const result = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(result.first, first);
  assert.deepEqual(result.commits.map(c => c.origin), ["first", "review", "pipeline", "pipeline", "pipeline", "review"]);
  assert.deepEqual(result.retained, { first: 0, review: 2, pipeline: 3, other: 0 });
  assert.deepEqual(result.rework, { first: 0, review: 3, pipeline: 3, other: 0 });
  assert.match(result.commits[1].origin_evidence!.join(" "), /推断/);
  const again = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.deepEqual(again.retained, result.retained); assert.deepEqual(again.rework, result.rework);
  assert.match(again.commits[1].origin_evidence!.join(" "), /推断/);
});


test("提交推断识别明确修复线索；普通修正默认归检视，两类线索有明确CI依据归流水线", () => {
  for (const text of ["按检视意见删除IR接口token", "address review feedback", "fix", "调整实现", "补单测"]) {
    assert.equal(inferCommitOrigin(text)?.origin, "review", text);
  }
  for (const text of ["按评审意见修复CodeCheck", "移除GTEST_SKIP", "修复CodeCheck行宽", "补单测修复DT覆盖率", "fix build failure"]) {
    assert.equal(inferCommitOrigin(text)?.origin, "pipeline", text);
  }
  for (const text of ["新增CodeCheck报告展示", "新增业务功能"]) {
    assert.equal(inferCommitOrigin(text)?.origin, "review", text);
  }
});


test("task-6：配置先提交、多次实现和文档整理均为首轮，仅末次CodeCheck为修复", async t => {
  const f = fixture(t);
  f.write("app_define.json", "{}\n"); const first = f.commit("配置订阅");
  f.write("service.java", "class A {}\nclass B {}\nclass C {}\n"); f.commit("实现接口与分页");
  f.write("docs.md", "knowledge\n"); f.commit("归档知识");
  f.write("urls.java", "class URLs {}\n"); f.commit("跨仓通知同步");
  f.write("docs.md", "more knowledge\n"); f.commit("归档跨仓知识");
  f.write("delivery.md", "checklist\n"); f.commit("交付清单整理");
  f.git("rm", "delivery.md"); const initialEnd = f.commit("撤出越界文件");
  f.write("service.java", "class A { /* fixed */ }\nclass B {}\nclass C {}\n");
  const head = f.commit("修复CodeCheck告警"); f.publish(head);
  const result = await collectDeliveryCode(f.summary, f.cwd, head);
  assert.equal(result.first, first);
  assert.deepEqual(result.initial_implementation, { end: initialEnd, basis: "commit_message" });
  assert.deepEqual(result.commits.map(c => c.origin), [...Array(7).fill("first"), "pipeline"]);
  assert.deepEqual(result.retained, { first: 3, pipeline: 1, review: 0, other: 0 });
  assert.equal(aggregateDelivery(buildDeliveryAnalysis([f.summary]).rows).firstPercent, 75);
});

test("无修复迹象暂计首轮；正式反馈记录优先；单纯收到意见不切断首轮", async t => {
  const f = fixture(t);
  f.write("a.cpp", "int a = 1;\n"); const first = f.commit("新增接口");
  f.write("b.cpp", "int b = 1;\n"); const second = f.commit("补单测"); f.publish(second);
  let result = await collectDeliveryCode(f.summary, f.cwd, second);
  assert.equal(result.retained.first, 2); assert.equal(result.initial_implementation?.basis, "no_repair_found");
  const batch = { task_id: f.summary.id, batch_id: "review", base_sha: first,
    items: [{ source: "workspace" }], status: "queued" };
  const writeState = (record: unknown) => f.write(".mae-flow.json", JSON.stringify({
    step_heads: { branch_create: f.base }, delivery_loop: { batches: [record] } }));
  writeState(batch);
  result = await collectDeliveryCode(f.summary, f.cwd, second);
  assert.equal(result.retained.first, 2);
  writeState({ ...batch, status: "closed", result_digest: "recorded", result_head: second });
  result = await collectDeliveryCode(f.summary, f.cwd, second);
  assert.deepEqual(result.initial_implementation, { end: first, basis: "repair_record" });
  assert.deepEqual(result.retained, { first: 1, review: 1, pipeline: 0, other: 0 });
});


test("task-5：首次取样已有责任人直接推送，合入后仍计算真实分支交付", async t => {
  const f = fixture(t);
  f.write("service.cpp", "int a = 1;\nint b = 2;\n"); const published = f.commit("主体实现");
  f.publish(published);
  f.write("service.cpp", "int a = 3;\nint b = 2;\n"); const ownerHead = f.commit("修改静态清理");
  Object.assign(f.summary.delivery!, { foreign_commits: { base_sha: ownerHead, count: 46 }, merged_sha: ownerHead, mr_state: "merged" });
  f.summary.status = "completed";
  f.git("update-ref", "refs/remotes/origin/main", ownerHead);
  const metric = await collectDeliveryCode(f.summary, f.cwd, published);
  assert.equal(metric.head, ownerHead); assert.equal(metric.published_head, published);
  assert.deepEqual(metric.retained, { first: 1, review: 1, pipeline: 0, other: 0 });
  assert.equal(aggregateDelivery(buildDeliveryAnalysis([f.summary]).rows).firstPercent, 50);
  const again = await collectDeliveryCode(f.summary, f.cwd, published);
  assert.deepEqual(again.retained, metric.retained);
  f.publish(f.base);
  assert.equal(buildDeliveryAnalysis([f.summary]).rows[0].metric, undefined);
});
