import assert from "node:assert/strict";
import test from "node:test";
import { readTaskHostDocument } from "../src/taskHostDocuments.ts";
import { readArtifactAsync } from "../src/artifacts.ts";
import { collectAgentDiagnostics, assertTaskReadRoot } from "../src/taskHostDiagnostics.ts";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { TaskService, type TaskSummary } from "../src/taskService.ts";
import { createTaskHostTools, TaskHostLedger, queueTaskHostOperation, finishTaskHostOperation, recordTaskHostInstruction, type TaskHostRuntime, writeTaskFeedbackResult } from "../src/taskHostTools.ts";

function scene(t: any) {
  const root = mkdtempSync(join(tmpdir(), "mfc-host-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "task-1"), cwd = join(workspace, "repo"), remote = join(root, "remote.git");
  mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Host Test"); git("config", "user.email", "host@test");
  writeFileSync(join(cwd, "main.txt"), "base\n");
  git("add", "main.txt"); git("commit", "-qm", "base");
  const baseline = git("rev-parse", "HEAD");
  git("checkout", "-qb", "work");
  writeFileSync(join(cwd, "main.txt"), "fixed B\n");
  git("add", "main.txt"); git("commit", "-qm", "fix: B");
  git("init", "--bare", "-q", remote);
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({ config: { 分支名: "work", 基线分支: "main" }, step_heads: { branch_create: baseline } }));
  const summary = { id: "task-1", requirement: "实现模块并推送", workspace, repo_url: remote, luban_account: "owner", status: "running" } as TaskSummary;
  const service = new TaskService({ dataDir: root, provider: "fixture", model: "fixture", modelsJson: {} });
  t.after(() => service.shutdown());
  let active = true, writer = true, resumed = 0, verificationRuns = 0;
  const facts: string[] = [];
  const host: TaskHostRuntime = {
    summary, cwd, dataDir: root,
    assertActive() { if (!active) throw new Error("已取消"); },
    annotations: () => [], related: () => [], gates: async () => ({ mrState: "open" }), reply() {},
    release: async () => { writer = false; facts.push("released"); },
    persist() {}, resume: () => { resumed++; }, allowPush: async () => true,
    push: async (branch, sha) => {
      assert.equal(writer, false, "必须先交还现场再推送"); facts.push("push");
      return (service as any).pushFromHost({ cwd, summary }, branch, sha);
    },
    verify: async () => { verificationRuns++; return { status: "passed" }; },
    watch() {}, syncFeedback() {},
  };
  return { host, service, git, remote, facts, cancel: () => { active = false; },
    resumed: () => resumed, verificationRuns: () => verificationRuns };
}

test("Agent 请求推送经回合交接后写入真实远端，保留旧红灯且不取消旧目标", async t => {
  const s = scene(t);
  s.host.summary.delivery = { sha: "old-ci-sha", pipeline: "failed" };
  const op = await queueTaskHostOperation(s.host, "push-1", { action: "push", reason: "先交付 B" });
  assert.equal(op.state, "queued");
  assert.equal(s.git("--git-dir", s.remote, "branch", "--list", "work"), "");
  assert.equal(await finishTaskHostOperation(s.host), true);
  assert.deepEqual(s.facts, ["released", "push"]);
  const completed = new TaskHostLedger(s.host.summary).read().operations[0];
  assert.equal(completed.state, "succeeded", completed.result);
  assert.equal(s.git("--git-dir", s.remote, "rev-parse", "work"), op.sha);
  assert.equal(s.host.summary.delivery.sha, "old-ci-sha");
  assert.equal(s.host.summary.delivery.pipeline, "failed");
  assert.equal(s.resumed(), 1);
  assert.equal(new TaskHostLedger(s.host.summary).read().operations[0].state, "succeeded");
  assert.equal(await finishTaskHostOperation(s.host), false, "已完成操作不重新传输");
});

test("推送排队后 HEAD 改变时如实失败，不推错版本", async t => {
  const s = scene(t);
  await queueTaskHostOperation(s.host, "push-1", { action: "push", reason: "交付 B" });
  writeFileSync(join(s.host.cwd!, "later.txt"), "later"); s.git("add", "later.txt"); s.git("commit", "-qm", "fix: later");
  await finishTaskHostOperation(s.host);
  const op = new TaskHostLedger(s.host.summary).read().operations[0];
  assert.equal(op.state, "failed");
  assert.match(op.result!, /HEAD/);
  assert.equal(s.git("--git-dir", s.remote, "branch", "--list", "work"), "");
});

test("推送成功但返回窗口取消，记真实收据且不重新启动 Agent", async t => {
  const s = scene(t), push = s.host.push;
  s.host.push = async (...args) => { const receipt = await push(...args); s.cancel(); return receipt; };
  await queueTaskHostOperation(s.host, "push-1", { action: "push", reason: "交付" });
  await finishTaskHostOperation(s.host);
  assert.equal(new TaskHostLedger(s.host.summary).read().operations[0].state, "succeeded");
  assert.equal(s.host.summary.delivery?.git_push?.sha, s.git("rev-parse", "HEAD"));
  assert.equal(s.resumed(), 0);
});

test("执行中断后从同一操作 ID 和 SHA 恢复，重复调用不重复排队", async t => {
  const s = scene(t), input = { action: "push" as const, reason: "恢复传输" };
  const op = await queueTaskHostOperation(s.host, "same-call", input);
  assert.deepEqual(await queueTaskHostOperation(s.host, "same-call", input), op);
  const ledger = new TaskHostLedger(s.host.summary);
  ledger.update({ ...op, state: "running" });
  await finishTaskHostOperation(s.host);
  assert.equal(ledger.read().operations.length, 1);
  assert.equal(ledger.read().operations[0].state, "succeeded");
  assert.equal(s.git("--git-dir", s.remote, "rev-parse", "work"), op.sha);
});

test("协作者的话不能伪装成责任人目标决定，原始指令可追溯", async t => {
  const s = scene(t);
  assert.equal(recordTaskHostInstruction(s.host.summary, "全部忽略", "reviewer"), undefined);
  const id = recordTaskHostInstruction(s.host.summary, "A 延期，先修 B", "owner");
  assert.equal(new TaskHostLedger(s.host.summary).read().instructions[0].id, id);
  await assert.rejects(queueTaskHostOperation(s.host, "control", { action: "defer_feedback", reason: "模型自己决定", target: "B", feedback_id: "A", request_id: "invented" }), /未找到/);
  assert.equal(new TaskHostLedger(s.host.summary).pending(), undefined);
});

test("读取工具在编码与等待验证阶段均可用，停止接管后的旧调用被拒绝", async t => {
  const s = scene(t), tool: any = createTaskHostTools(s.host).find(tool => tool.name === "task_context")!;
  for (const status of ["running", "verifying"] as const) {
    s.host.summary.status = status;
    const result = await tool.execute("read", { view: "overview" } as any);
    assert.equal(result.isError, false);
    assert.match(JSON.stringify(result), /task_control|set_target/);
  }
  s.cancel();
  assert.equal((await tool.execute("read", { view: "overview" } as any)).isError, true);
});

test("宿主验证是独立操作，不隐含推送", async t => {
  const s = scene(t);
  await queueTaskHostOperation(s.host, "verify", { action: "retry_verification", reason: "环境恢复后重跑 UT" });
  await finishTaskHostOperation(s.host);
  assert.equal(s.verificationRuns(), 1);
  assert.deepEqual(s.facts, ["released"]);
  assert.equal(s.host.summary.delivery?.git_push, undefined);
});


test("远端成功后任务状态写入失败，恢复只补状态，不重复推送", async t => {
  const s = scene(t);
  await queueTaskHostOperation(s.host, "push-crash", { action: "push", reason: "阶段交付" });
  s.host.persist = () => { throw new Error("磁盘暂不可写"); };
  let failure = ""; s.host.fail = message => { failure = message; };
  await finishTaskHostOperation(s.host);
  assert.match(failure, /远端操作已有收据/);
  const saved = new TaskHostLedger(s.host.summary).pending()!;
  assert.equal(saved.push_receipt?.sha, s.git("rev-parse", "HEAD"));
  s.host.summary.delivery = undefined; // Simulate reloading an older task snapshot.
  s.host.persist = () => {};
  await finishTaskHostOperation(s.host);
  assert.equal(s.facts.filter(event => event === "push").length, 1);
  assert.equal((s.host.summary as TaskSummary).delivery?.git_push?.sha, saved.sha);
  assert.equal(new TaskHostLedger(s.host.summary).pending(), undefined);
});

test("Cloud 实际交接撤销旧回调执行权，保留未送达插话，停止容器后才能推送", async t => {
  const s = scene(t), service: any = s.service;
  const state: any = { summary: s.host.summary, cwd: s.host.cwd, controlEpoch: 7,
    driver: { takeUndeliveredSteers: () => ["新要求"], dispose: () => s.facts.push("disposed") } };
  service.stopTaskContainer = async () => { s.facts.push("stopped"); };
  const old = service.taskHostRuntime(state, 7), current = service.taskHostRuntime(state, 7);
  await current.release();
  assert.throws(() => old.assertActive(), /旧会话/);
  current.assertActive();
  assert.deepEqual(s.facts, ["disposed", "stopped"]);
  assert.deepEqual(state.pendingMainSteers, ["新要求"]);
  assert.equal(state.driver, undefined);
});

test("Cloud 接手有其他执行者时不撤销现有执行权", async t => {
  const s = scene(t), service: any = s.service;
  const state: any = { summary: s.host.summary, controlEpoch: 7, assistantActive: Promise.resolve() };
  const runtime = service.taskHostRuntime(state, 7);
  await assert.rejects(runtime.release(), /仍占用现场/);
  assert.equal(state.controlEpoch, 7);
  runtime.assertActive();
});

test("验证中接到责任人新要求，仅停止验证，不跳过或推送；旧回调失效", async t => {
  const s = scene(t), service: any = s.service;
  s.host.summary.status = "running"; // Real Build-Fix uses running and owns task.container.
  const state: any = { summary: s.host.summary, controlEpoch: 4, container: {}, driver: {}, prepushActive: Promise.resolve(false) };
  service.tasks.set(s.host.summary.id, state);
  const old = service.taskHostRuntime(state, 4);
  let resumed = "";
  service.stopPrePush = async (_id: string, actor: string, pushAfterStop: boolean) => {
    assert.equal(actor, "owner"); assert.equal(pushAfterStop, false); state.prepushActive = undefined; state.container = undefined; state.driver = undefined;
  };
  service.persist = () => {};
  service.recordDeferredInterrupt = () => {};
  service.enqueueRepair = (_task: unknown, mission: string) => { resumed = mission; state.summary.status = "queued"; };
  service.project = () => state.summary;
  await service.interrupt(s.host.summary.id, "A 延期，先修 B", "owner");
  assert.match(state.pendingMainSteers.join("\n"), /A 延期，先修 B/);
  assert.throws(() => old.assertActive(), /旧会话/);
  assert.equal(s.host.summary.delivery?.git_push, undefined);
  service.tasks.delete(s.host.summary.id);
});


test("交接失败由新执行权收口 failed，不能留 running 空转", async t => {
  const s = scene(t), service: any = s.service;
  const state: any = { summary: s.host.summary, cwd: s.host.cwd, controlEpoch: 1,
    driver: { takeUndeliveredSteers: () => [], dispose() {} } };
  service.persist = () => {}; service.notifyOutcome = () => {};
  service.stopTaskContainer = async () => "容器停止失败";
  const host = service.taskHostRuntime(state, 1);
  await queueTaskHostOperation(host, "restart", { action: "restart_session", reason: "工具失去响应，恢复当前现场" });
  await service.settle(state, Promise.resolve({ status: "turn_finished" }), 1);
  assert.equal(state.summary.status, "failed");
  assert.match(state.summary.detail, /容器停止失败/);
  assert.equal(state.driver, undefined);
  assert.equal(new TaskHostLedger(state.summary).pending()?.state, "queued");
});

test("首次空白回执可逐条写入，保留其他条目和 bind mount inode，拒绝夹带 ID", t => {
  const s = scene(t), path = join(s.host.summary.workspace, "feedback", "result.json");
  mkdirSync(join(s.host.summary.workspace, "feedback")); writeFileSync(path, "");
  const ino = statSync(path).ino;
  s.host.activeFeedback = () => ({ batchId: "batch-A", path, items: [{ id: "pipeline:A", source: "pipeline" }, { id: "pipeline:B", source: "pipeline" }] });
  writeTaskFeedbackResult(s.host, { feedback_id: "pipeline:A", status: "fixed", summary: "SQL 拼接 UT 已通过" });
  writeTaskFeedbackResult(s.host, { feedback_id: "pipeline:B", status: "needs_human", summary: "运行环境缺依赖，已附日志" });
  assert.equal(statSync(path).ino, ino);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).results.map((r: any) => r.id), ["pipeline:A", "pipeline:B"]);
  assert.throws(() => writeTaskFeedbackResult(s.host, { feedback_id: "pipeline:A：FAILED", status: "fixed", summary: "已修" }), /完整 ID/);
});

test("推送不能把宿主下单基线伪装成工作分支", async t => {
  const s = scene(t);
  s.host.summary.baseline = "main";
  s.git("checkout", "main");
  writeFileSync(join(s.host.cwd!, ".mae-flow.json"), JSON.stringify({ config: { 分支名: "main", 基线分支: "other" } }));
  await assert.rejects(queueTaskHostOperation(s.host, "baseline", { action: "push", reason: "发布" }), /绑定的工作分支/);
});

async function platform(t: any) {
  const requests: Array<{ url: string; body: any }> = [];
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    requests.push({ url: req.url!, body: text ? JSON.parse(text) : undefined });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/mr" ? { url: "http://platform.test/mr/1", id: 1 }
      : { status: "running", runs: [], log: "验证已排队" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, requests };
}

test("流水线触发排队并绑定推送 SHA，执行中断恢复只查状态不重复触发", async t => {
  const s = scene(t), p = await platform(t);
  s.host.platformUrl = p.url; s.host.summary.delivery = { sha: "old", git_push: { sha: "new-sha", ref: "refs/heads/work", remote: "origin" } };
  const tool: any = createTaskHostTools(s.host).find(tool => tool.name === "task_pipeline");
  assert.equal((await tool.execute("trigger", { action: "trigger" })).isError, false);
  assert.equal(p.requests.length, 0);
  await finishTaskHostOperation(s.host);
  assert.equal(p.requests[0].body.sha, "new-sha");
  assert.equal(s.host.summary.delivery.sha, "old");
  const op = await queueTaskHostOperation(s.host, "recover", { action: "trigger_pipeline", reason: "核对中断的触发" });
  new TaskHostLedger(s.host.summary).update({ ...op, state: "running", trigger_started: true });
  await finishTaskHostOperation(s.host);
  assert.equal(p.requests.filter(r => r.url === "/pipeline/trigger").length, 1);
  assert.match(p.requests.at(-1)!.url, /^\/pipeline\/status/);
});

test("MR 创建沿任务仓/分支/单号，已取得收据后恢复不再次创建", async t => {
  const s = scene(t), p = await platform(t);
  s.host.platformUrl = p.url; s.host.summary.ticket = "REQ-1";
  await queueTaskHostOperation(s.host, "push", { action: "push", reason: "阶段交付" });
  await finishTaskHostOperation(s.host);
  await queueTaskHostOperation(s.host, "mr", { action: "create_mr", reason: "提交检视" });
  s.host.persist = () => { throw new Error("保存失败"); }; s.host.fail = () => {};
  await finishTaskHostOperation(s.host);
  delete s.host.summary.delivery!.mr_url; delete s.host.summary.delivery!.mr_id;
  s.host.persist = () => {};
  await finishTaskHostOperation(s.host);
  assert.equal(p.requests.length, 1);
  assert.deepEqual(p.requests[0].body, { repo: s.remote, source_branch: "work", target_branch: "main", title: "实现模块并推送", dts_no: "REQ-1" });
  assert.equal(s.host.summary.delivery!.mr_id, 1);
});

test("新工具可读取任务诊断和关联材料，诊断隐藏宿主凭据", async t => {
  const s = scene(t); s.host.credential = { username: "user", password: "secret-password" };
  s.host.diagnostics = async () => "Git 和容器状态 secret-password";
  s.host.document = async (id, artifact) => `${id}: ${artifact}\n模块同步接口`;
  const tools: any[] = createTaskHostTools(s.host);
  const diagnostic = await tools.find(tool => tool.name === "task_diagnostics").execute("diag", {});
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret-password/);
  const document = await tools.find(tool => tool.name === "task_document").execute("doc", { artifact: "story.md" });
  assert.match(JSON.stringify(document), /模块同步接口/);
  const service: any = s.service, state: any = { summary: s.host.summary, cwd: s.host.cwd, controlEpoch: 1 };
  service.tasks.set("unrelated", { summary: { id: "unrelated", parent_task_id: "another" } });
  await assert.rejects(service.taskHostRuntime(state, 1).document("unrelated", "story.md"), /关联模块/);
  service.tasks.delete("unrelated");
});


test("Agent 诊断不执行仓内 Git 钩子，也不读取指向任务外的软链", async t => {
  const s = scene(t), marker = join(s.host.summary.workspace, "host-executed"), secret = join(s.host.dataDir, "host-secret");
  writeFileSync(secret, "HOST_ONLY_SENTINEL");
  s.git("config", "core.fsmonitor", `touch '${marker}'`);
  symlinkSync(secret, join(s.host.summary.workspace, "events.jsonl"));
  symlinkSync(secret, join(s.host.cwd!, ".mae-flow.json-secret"));
  const result = await collectAgentDiagnostics({ workspace: s.host.summary.workspace, cwd: s.host.cwd,
    task: { id: s.host.summary.id, status: "running" } });
  assert.equal(existsSync(marker), false);
  assert.doesNotMatch(result, /HOST_ONLY_SENTINEL/);
  assert.match(result, /读取目标超出当前任务目录/);
  symlinkSync(s.host.dataDir, join(s.host.cwd!, ".mae-flow-work"));
  assert.throws(() => assertTaskReadRoot(s.host.summary.workspace, join(s.host.cwd!, ".mae-flow-work")), /超出当前任务/);
});


test("设计材料短名称能定位单号目录，找不到时返回真实可选项", async t => {
  const s = scene(t), docs = join(s.host.cwd!, ".mae-flow-work", "REQ-1");
  mkdirSync(docs, { recursive: true }); writeFileSync(join(docs, "story.md"), "# 全局 Story\n同步模块与查询模块");
  const input = { workspace: s.host.summary.workspace, root: s.host.cwd, name: "story.md",
    read: async (name: string) => (await readArtifactAsync(s.host.cwd, name))?.content };
  assert.match((await readTaskHostDocument(input))!, /同步模块与查询模块/);
  await assert.rejects(readTaskHostDocument({ ...input, name: "spec.md" }), /可用文档.*REQ-1\/story.md/);
});
