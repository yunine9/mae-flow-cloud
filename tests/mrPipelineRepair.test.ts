import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { MrPipelineRepairs, PipelineRepairError, type PipelineRepairRuntime } from "../src/mrPipelineRepair.ts";
import { normalizeRepairMrUrl, parseRepairMr, repairIsActive, type RepairMr } from "../src/mrPipelineRepairTypes.ts";
import type { PipelineRun } from "../src/pipelineClient.ts";

const a = "a".repeat(40), b = "b".repeat(40);
const url = "https://codehub.test/group/repo/merge_requests/12";
const mr: RepairMr = { url, iid: "12", repo: "https://codehub.test/group/repo.git", title: "修复认证配置",
  source_branch: "feature", target_branch: "main", sha: a, state: "opened" };
const green = (sha = a): PipelineRun => ({ sha, status: "success", checks: ["COMPILE", "UT", "CODECHECK"].map(dimension => ({ dimension: dimension as "COMPILE", status: "success" })) });
const red = (sha = a): PipelineRun => ({ sha, status: "failed", log: "src/main.ts:3 TypeError: bad argument", checks: [{ dimension: "COMPILE", status: "failed" }] });

function setup(t: TestContext, override: Partial<PipelineRepairRuntime> = {}, extra: Partial<ConstructorParameters<typeof MrPipelineRepairs>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mr-repair-"));
  const state = { remote: structuredClone(mr), opened: 0, pushed: 0, repaired: 0, closed: 0, queried: [] as string[] };
  const runtime: PipelineRepairRuntime = { unavailableReason: () => undefined,
    detail: async () => structuredClone(state.remote), status: async current => {
      state.queried.push(current.sha); return { status: "success", runs: [current.sha === a ? red() : green(current.sha)] };
    }, trigger: async () => undefined,
    open: async () => { state.opened++; return {
      repair: async () => { state.repaired++; return { sha: b, summary: "已修正类型错误并通过本地验证" }; },
      push: async () => { state.pushed++; state.remote.sha = b; return b; },
      close: async () => { state.closed++; },
    }; }, ...override };
  const service = new MrPipelineRepairs({ dataDir: dir, runtime, pollMs: 1, waitMs: 100, ...extra });
  t.after(async () => { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, service, state, runtime };
}
async function finished(service: MrPipelineRepairs, id: string) {
  for (let i = 0; i < 300; i++) {
    const row = service.get(id, "alice"); if (!repairIsActive(row.status)) { await delay(1); return row; }
    await delay(2);
  }
  throw new Error("修复未结束");
}

test("已有 MR 独立修复、推送并只验新 SHA；记录隔离且重复启动复用", async t => {
  const { service, state } = setup(t);
  const row = service.start(url + "?tab=pipeline#build", "alice");
  assert.equal(service.start(url, "alice").id, row.id);
  assert.throws(() => service.start(url, "bob"), (e: PipelineRepairError) => e.status === 409);
  assert.equal(service.list("bob").records.length, 0);
  assert.throws(() => service.get(row.id, "bob"), (e: PipelineRepairError) => e.status === 404);
  const done = await finished(service, row.id);
  assert.equal(done.status, "passed"); assert.equal(done.mr?.sha, b); assert.equal(done.round, 1);
  assert.deepEqual(state.queried, [a, b]); assert.equal(state.closed, 1); assert.equal(state.pushed, 1);
});

test("当前提交总体绿灯缺逐项证据时不通过", async t => {
  const { service, state } = setup(t, { status: async () => ({ status: "success", runs: [{ sha: a, status: "success" }] }) });
  const done = await finished(service, service.start(url, "alice").id);
  assert.equal(done.status, "needs_attention"); assert.match(done.message, /逐项/); assert.equal(state.opened, 0);
});

for (const run of [{ ...green(b) }, { ...green(a), is_valid: false }]) {
  test(`旧提交或无效绿灯不背书当前提交 ${run.sha?.slice(0, 1)} ${run.is_valid}`, async t => {
    const { service, state } = setup(t, { status: async () => ({ status: "success", runs: [run] }) });
    const done = await finished(service, service.start(url, "alice").id);
    assert.equal(done.status, "needs_attention"); assert.equal(state.opened, 0);
  });
}

test("已有会话管理的 MR 不启动第二个写入者", async t => {
  const { service, state } = setup(t, {}, { managedMr: () => "请在原问题会话处理" });
  const done = await finished(service, service.start(url, "alice").id);
  assert.match(done.message, /原问题会话/); assert.equal(state.opened, 0);
});

test("修复期间他人推了新提交则保留本地修改，不推送", async t => {
  const { service, state, runtime } = setup(t);
  const original = runtime.open;
  runtime.open = async (...args) => { const handle = await original(...args); return { ...handle,
    repair: async (...input) => { const result = await handle.repair(...input); state.remote.sha = "c".repeat(40); return result; } }; };
  const done = await finished(service, service.start(url, "alice").id);
  assert.equal(done.status, "needs_attention"); assert.match(done.message, /保留本地修改/); assert.equal(state.pushed, 0); assert.equal(state.closed, 1);
});

test("停止在途修复会中断执行并释放容器，不继续推送", async t => {
  const { service, state, runtime } = setup(t);
  runtime.open = async (_record, _root, signal) => { state.opened++; return {
    repair: async () => { await delay(60_000, undefined, { signal }); return { sha: b, summary: "late" }; },
    push: async () => { state.pushed++; return b; }, close: async () => { state.closed++; },
  }; };
  const row = service.start(url, "alice");
  while (!state.opened) await delay(1);
  service.stop(row.id, "alice");
  const done = await finished(service, row.id);
  assert.equal(done.status, "stopped"); assert.equal(state.pushed, 0); assert.equal(state.closed, 1);
});

test("修复次数耗尽停下；重启保留状态和工作目录", async t => {
  const { service, state, dir, runtime } = setup(t, {}, { maxRounds: () => 1 });
  runtime.status = async current => ({ status: "failed", runs: [red(current.sha)] });
  const id = service.start(url, "alice").id;
  const done = await finished(service, id);
  assert.equal(done.status, "needs_attention"); assert.equal(state.repaired, 1); assert.match(done.message, /1 轮/);
  const root = join(dir, "pipeline-repairs", id);
  writeFileSync(join(root, "preserved.txt"), "completed work");
  writeFileSync(join(root, "record.json"), JSON.stringify({ ...done, status: "repairing" }));
  const restored = new MrPipelineRepairs({ dataDir: dir, runtime });
  assert.equal(restored.get(id, "alice").status, "needs_attention");
  assert.match(restored.get(id, "alice").message, /重启/);
  assert.equal(readFileSync(join(root, "preserved.txt"), "utf8"), "completed work");
  await restored.shutdown();
});

test("未配置时明确拒绝启动；MR URL 和平台详情严格核对", t => {
  const { service } = setup(t, { unavailableReason: () => "未配置平台" });
  assert.throws(() => service.start(url, "alice"), /未配置平台/);
  assert.throws(() => normalizeRepairMrUrl("https://user:secret@codehub.test/g/r/merge_requests/1"));
  assert.equal(normalizeRepairMrUrl(url + "/?a=b#c"), url);
  assert.deepEqual(parseRepairMr(mr, url), mr);
  assert.throws(() => parseRepairMr({ ...mr, repo: "https://user:secret@other.test/repo.git" }, url));
  assert.equal(parseRepairMr({ ...mr, repo: "https://clone.codehub.test/group/repo.git" }, url).repo, "https://clone.codehub.test/group/repo.git");
  assert.throws(() => parseRepairMr({ ...mr, sha: "" }, url));
});

test("不同 MR 指向同一源分支时只允许一个修复者", async t => {
  const { service, runtime } = setup(t);
  runtime.detail = async target => ({ ...mr, url: target, iid: target.endsWith("13") ? "13" : "12" });
  runtime.status = async () => ({ status: "running", runs: [{ sha: a, status: "running" }] });
  const first = service.start(url, "alice");
  service.start(url.replace(/12$/, "13"), "alice");
  for (let i = 0; i < 50 && service.list("alice").records.every(r => r.status !== "needs_attention"); i++) await delay(2);
  const rows = service.list("alice").records;
  assert.equal(rows.filter(row => row.status === "needs_attention").length, 1);
  assert.match(rows.find(row => row.status === "needs_attention")!.message, /同一源分支/);
  service.stop(first.id, "alice");
});

test("当前流水线正在运行时持续观察，不提前判定成功或启动 Agent", async t => {
  let reads = 0, triggers = 0;
  const { service, state } = setup(t, { status: async () => ({ status: "running", runs: [++reads < 3 ? { sha: a, status: "running" } : green()] }), trigger: async () => { triggers++; } });
  const done = await finished(service, service.start(url, "alice").id);
  assert.equal(done.status, "passed"); assert.equal(state.opened, 0); assert.equal(triggers, 0); assert.equal(reads, 3);
});

test("目标分支被更改时旧目标的绿灯不能通过", async t => {
  const { service, state, runtime } = setup(t);
  runtime.status = async () => { state.remote.target_branch = "release"; return { status: "success", runs: [green()] }; };
  const done = await finished(service, service.start(url, "alice").id);
  assert.equal(done.status, "needs_attention"); assert.match(done.message, /MR 已变化/); assert.equal(state.pushed, 0);
});

test("停止与推送完成同时发生时仍记录已推送提交，并停止后续触发", async t => {
  const { service, state, runtime } = setup(t);
  const original = runtime.open;
  let triggered = 0;
  runtime.trigger = async () => { triggered++; };
  runtime.open = async (...args) => { const handle = await original(...args); return { ...handle, push: async () => {
    const sha = await handle.push(); service.stop(args[0].id, "alice"); return sha;
  } }; };
  const done = await finished(service, service.start(url, "alice").id);
  assert.equal(done.status, "stopped"); assert.equal(done.mr?.sha, b); assert.equal(state.pushed, 1); assert.equal(triggered, 0);
  assert.ok(done.logs.some(log => log.text.includes("平台已推送提交")));
});
