import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OverallStoryCoordinator, collectStoryInput, type StoryRun } from "../src/overallStory.ts";
import { OVERALL_STORY_ARTIFACT, readStoryState, writeStoryState, currentStoryFile, readCurrentStory, readCurrentStoryArchitecture } from "../src/overallStoryStore.ts";
import { AnnotationStore, reanchor } from "../src/annotations.ts";
import { annotationClosure } from "../src/feedbackPolicy.ts";
import { readArtifact, listArtifactDocuments } from "../src/artifacts.ts";
import { TaskService, type TaskSummary } from "../src/taskService.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { overallStoryGate, overallStoryMission, runOverallStorySession } from "../src/overallStoryAgent.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { KERNEL_ROOT } from "./kernelFixture.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mfc-overall-story-"));
  const task = { summary: { id: "parent", workspace: join(root, "parent"), requirement: "# 整体需求\n跨模块验收", status: "completed",
    requirement_graph: { stage: "confirmed", repositories: [
      { id: "web", name: "用户界面", task_id: "child", ticket: "REQ-1" },
      { id: "api", name: "服务接口", task_id: "missing" },
    ], dependencies: [{ from: "web", to: "api", reason: "调用接口" }] },
  } as TaskSummary };
  const child = { summary: { id: "child", workspace: join(root, "child") } as TaskSummary };
  mkdirSync(task.summary.workspace); mkdirSync(join(child.summary.workspace, ".mae-flow-work/REQ-1"), { recursive: true });
  const childDoc = join(child.summary.workspace, ".mae-flow-work/REQ-1/story.md");
  writeFileSync(childDoc, "# Story\n原始场景");
  const store = new AnnotationStore(join(task.summary.workspace, "annotations.jsonl"));
  let calls = 0;
  let runner: (t: typeof task, job: StoryRun) => Promise<void> = async (_t, job) => {
    mkdirSync(job.root, { recursive: true });
    writeFileSync(join(job.root, "story.md"), job.before ? `${job.before}\n新增说明` : "# 整体 Story\n\n验收口径\n待补充接口 Story");
    writeFileSync(join(job.root, "receipts.json"), JSON.stringify(job.annotations.map((a) => ({
      annotation_id: a.id, outcome: "fixed", summary: "已补充验收说明", evidence: ["story.md:5"],
    }))));
  };
  const options = { task: (id: string) => id === "parent" ? task : id === "child" ? child : undefined,
    artifactRoot: (id: string) => id === "child" ? child.summary.workspace : undefined,
    ready() {}, run: async (t: typeof task, job: StoryRun) => { calls++; await runner(t, job); } };
  const coordinator = new OverallStoryCoordinator(options);
  const note = (text = "补充口径") => store.add({ author: "reviewer", artifact: OVERALL_STORY_ARTIFACT,
    file: OVERALL_STORY_ARTIFACT, kind: "doc", anchor: "验收口径", line: 3, note: text });
  return { task, child, childDoc, root, store, coordinator, options, note, calls: () => calls,
    runner: (next: typeof runner) => { runner = next; }, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test("架构图可从无到有并更新，失败保留旧图，正文和确认不变", async () => {
  const f = fixture();
  try {
    f.coordinator.adoptAnalysis("parent", "# Story\n完整设计\n```archify\n{}\n```", "owner");
    const before = readCurrentStory(f.task.summary.workspace);
    const confirmed = readStoryState(f.task.summary.workspace).confirmed;
    let title = "首版模块";
    f.runner(async (_task, job) => {
      assert.equal(job.architectureOnly, true);
      assert.equal(job.before, before);
      const event = {} as import("../src/semanticEvents.ts").SemanticEvent;
      assert.equal(overallStoryGate(job.root, true)("Write", "story.md", event)?.action, "deny");
      assert.equal(overallStoryGate(job.root, true)("Write", "architecture.json", event)?.action, "allow");
      assert.match(overallStoryMission(job), /整个 story.md/);
      writeFileSync(join(job.root, "architecture.json"), JSON.stringify({ schema_version: 1, diagrams: [{
        id: "module", view: "logical", source: { schema_version: 1, diagram_type: "architecture", meta: { title },
          components: [{ id: "api", type: "backend", label: title, pos: [40, 40], size: [180, 64] }], connections: [] },
      }] }));
    });
    f.coordinator.generateArchitecture("parent", "owner");
    assert.throws(() => f.coordinator.generateArchitecture("parent", "owner"), /正在更新/);
    await f.coordinator.settled("parent");
    assert.equal(f.coordinator.status("parent").error, undefined);
    assert.match(readCurrentStoryArchitecture(f.task.summary.workspace)!, /首版模块/);
    title = "更新模块";
    f.coordinator.generateArchitecture("parent", "owner"); await f.coordinator.settled("parent");
    const updated = readCurrentStoryArchitecture(f.task.summary.workspace)!;
    assert.match(updated, /更新模块/);
    f.runner(async () => { throw new Error("模型暂时不可用"); });
    f.coordinator.generateArchitecture("parent", "owner"); await f.coordinator.settled("parent");
    assert.match(f.coordinator.status("parent").error!, /模型暂时不可用/);
    assert.equal(readCurrentStoryArchitecture(f.task.summary.workspace), updated);
    assert.equal(readCurrentStory(f.task.summary.workspace), before);
    assert.deepEqual(readStoryState(f.task.summary.workspace).confirmed, confirmed);
  } finally { await f.coordinator.shutdown(); f.dispose(); }
});

test("新 Story 输入跟踪模块职责；升级不改变历史汇总稿的摘要形态", () => {
  const f = fixture();
  try {
    const old = collectStoryInput(f.task, f.options).fingerprint;
    f.task.summary.requirement_graph!.repositories[0].responsibility = "查询模块的完整功能与测试";
    assert.equal(collectStoryInput(f.task, f.options).fingerprint, old);
    f.task.summary.requirement_graph!.source_document = "story.md";
    const current = collectStoryInput(f.task, f.options).fingerprint;
    f.task.summary.requirement_graph!.repositories[0].responsibility = "查询模块增加分页契约";
    assert.notEqual(collectStoryInput(f.task, f.options).fingerprint, current);
  } finally { f.dispose(); }
});

test("发布后的子任务同步失败保留文档和已处理回执，不把意见重新送回草稿", async () => {
  const f = fixture();
  const coordinator = new OverallStoryCoordinator({ ...f.options,
    published() { throw new Error("子任务材料暂时不可写"); } });
  try {
    coordinator.generate("parent", "owner");
    await coordinator.settled("parent");
    const first = readStoryState(f.task.summary.workspace).current;
    const note = f.note();
    coordinator.submit("parent", [note], "reviewer");
    await coordinator.settled("parent");
    assert.notEqual(readStoryState(f.task.summary.workspace).current, first);
    const updated = f.store.list().find((item) => item.id === note.id)!;
    assert.equal(updated.sent_via, "overall_story");
    assert.equal(updated.response?.outcome, "fixed");
    assert.match(coordinator.status("parent").error!, /子任务材料暂时不可写/);
  } finally { await coordinator.shutdown(); f.dispose(); }
});

test("子任务即使携带已确认拆分方案也不能生成、更新、确认或派送整体 Story 意见", () => {
  const f = fixture();
  try {
    f.child.summary.parent_task_id = f.task.summary.id;
    f.child.summary.requirement_graph = f.task.summary.requirement_graph;
    assert.equal(f.coordinator.status("parent").eligible, true);
    const status = f.coordinator.status("child");
    assert.equal(status.eligible, false);
    assert.equal(status.can_confirm, false);
    assert.throws(() => f.coordinator.generate("child", "owner"), /请在主任务/);
    assert.throws(() => f.coordinator.confirm("child", "revision", "owner"), /请在主任务/);
    assert.throws(() => f.coordinator.submit("child", [], "owner"), /请在主任务/);
    assert.equal(f.calls(), 0);
  } finally { f.dispose(); }
});

test("整体 Story 来源、缺失、版本与确认：只认文件变化，主任务完成后仍可使用", async () => {
  const f = fixture();
  try {
    assert.equal(f.coordinator.status("parent").sources[1].missing, "子任务 Story 尚不可读");
    f.coordinator.generate("parent", "owner"); f.coordinator.generate("parent", "owner");
    await f.coordinator.settled("parent");
    assert.equal(f.calls(), 1, "重复请求不启动第二个写者");
    const first = f.coordinator.status("parent");
    assert.ok(first.current); assert.equal(first.can_confirm, false);
    assert.equal(f.task.summary.status, "completed");
    const doc = readArtifact(undefined, OVERALL_STORY_ARTIFACT, { taskMaterialRoot: f.task.summary.workspace });
    assert.match(doc!.content, /验收口径/);
    assert.equal(listArtifactDocuments(undefined, { taskMaterialRoot: f.task.summary.workspace })[0].purpose, "overall_story");
    f.child.summary.updated_at = new Date().toISOString();
    assert.equal(f.coordinator.status("parent").stale, false);
    writeFileSync(f.childDoc, "# Story\n新的场景");
    assert.equal(f.coordinator.status("parent").stale, true);
    assert.equal(f.calls(), 1, "源变化不自动生成");
    f.task.summary.requirement_graph!.repositories.pop();
    f.coordinator.generate("parent", "owner"); await f.coordinator.settled("parent");
    const second = f.coordinator.status("parent");
    assert.equal(second.can_confirm, true); assert.notEqual(second.current, first.current);
    assert.match(f.coordinator.revision("parent", second.current!).diff, /新增说明/);
    assert.match(f.coordinator.revision("parent", first.current!).content, /验收口径/);
    assert.throws(() => f.coordinator.confirm("parent", first.current!, "owner"), /已变化/);
    assert.equal(f.coordinator.confirm("parent", second.current!, "owner").confirmed!.by, "owner");
    f.note(); assert.equal(f.coordinator.status("parent").can_confirm, false);
    assert.throws(() => f.coordinator.revision("parent", "../../etc/passwd"), /不存在/);
  } finally { f.dispose(); }
});

test("受邀意见立即持久化排队、串行处理，复检属于作者；处理意见不偷偷同步新来源", async () => {
  const f = fixture();
  try {
    f.coordinator.generate("parent", "owner"); await f.coordinator.settled("parent");
    writeFileSync(f.childDoc, "# Story\n后来改变的设计");
    let release!: () => void;
    const pause = new Promise<void>((r) => { release = r; });
    let runs = 0;
    f.runner(async (_t, job) => {
      runs++;
      assert.match(job.input.files["children/1.md"], /原始场景/, "反馈只修改当前版本来源");
      if (runs === 1) await pause;
      mkdirSync(job.root, { recursive: true });
      writeFileSync(join(job.root, "story.md"), "新增开头\n" + job.before);
      writeFileSync(join(job.root, "receipts.json"), JSON.stringify(job.annotations.map((a) => ({
        annotation_id: a.id, outcome: "fixed", summary: "已在文档开头补充整体场景说明", evidence: ["story.md:1"],
      }))));
    });
    const a = f.note(), b = f.note("第二条");
    f.coordinator.submit("parent", [a], "reviewer");
    await Promise.resolve();
    assert.equal(f.store.list()[0].sent_via, "overall_story_processing");
    assert.throws(() => f.store.verify(a.id, "reviewer"), /排队或处理中/);
    f.coordinator.submit("parent", [b], "reviewer");
    assert.equal(f.store.list()[1].sent_via, "overall_story_queue");
    release(); await f.coordinator.settled("parent");
    assert.equal(f.coordinator.status("parent").error, undefined); assert.equal(runs, 2); assert.equal(f.coordinator.status("parent").stale, true);
    const processed = f.store.list()[0];
    const facts = { task_status: "completed", archival: true, review_ready: false, review_annotation_ids: [] };
    assert.equal(annotationClosure(processed, facts, { username: "reviewer", can_override: false, can_route_others: false }).can_verify, true);
    assert.equal(annotationClosure(processed, facts, { username: "owner", can_override: false, can_route_others: true }).can_verify, false);
    const checks = reanchor(f.store.list(), () => readCurrentStory(f.task.summary.workspace));
    assert.equal(checks[0].state, "moved"); assert.equal(checks[0].line, 5);
    assert.throws(() => f.store.verify(a.id, "owner"), /只能由他裁决/);
    f.store.verify(a.id, "reviewer"); assert.equal(f.store.list()[0].status, "verified");
  } finally { f.dispose(); }
});

test("失败、停止、重启不会覆盖正本，失败不计入人工退回", async () => {
  const f = fixture();
  try {
    f.coordinator.generate("parent", "owner"); await f.coordinator.settled("parent");
    const before = readCurrentStory(f.task.summary.workspace), first = readStoryState(f.task.summary.workspace).current;
    f.runner(async (_t, job) => { mkdirSync(job.root, { recursive: true }); writeFileSync(join(job.root, "story.md"), "半份文档"); throw new Error("模型断开"); });
    const a = f.note(); f.coordinator.submit("parent", [a]); await f.coordinator.settled("parent");
    assert.match(f.coordinator.status("parent").error!, /模型断开/);
    assert.equal(readCurrentStory(f.task.summary.workspace), before);
    assert.equal(f.store.list()[0].status, "draft"); assert.equal(f.store.list()[0].returned ?? 0, 0);
    f.runner(async (_t, job) => { await new Promise<void>((r) => job.signal.addEventListener("abort", () => r(), { once: true })); });
    f.coordinator.generate("parent", "owner"); await Promise.resolve();
    await f.coordinator.stop("parent");
    assert.equal(readStoryState(f.task.summary.workspace).current, first);
    const state = readStoryState(f.task.summary.workspace); state.job = { id: "interrupted", by: "owner", started_at: "yesterday" };
    writeStoryState(f.task.summary.workspace, state); f.store.markSent([a.id], "overall_story_processing");
    const recovered = new OverallStoryCoordinator(f.options);
    assert.match(recovered.status("parent").error!, /中断/);
    assert.equal(f.store.list()[0].status, "draft"); assert.equal(readCurrentStory(f.task.summary.workspace), before);
  } finally { f.dispose(); }
});

test("发布指针已写入、回执尚未登记时重启，恢复已有回执而非重复修改", async () => {
  const f = fixture();
  try {
    f.coordinator.generate("parent", "owner"); await f.coordinator.settled("parent");
    const a = f.note(); f.coordinator.submit("parent", [a]); await f.coordinator.settled("parent");
    f.store.markSent([a.id], "overall_story_processing");
    const recovered = new OverallStoryCoordinator(f.options);
    recovered.status("parent");
    assert.equal(f.store.list()[0].sent_via, "overall_story");
    assert.equal(f.store.list()[0].response!.outcome, "fixed");
  } finally { f.dispose(); }
});

test("文件边界禁止链接逃逸；缺失或歧义的子任务 Story 不被猜测", () => {
  const f = fixture();
  try {
    rmSync(f.childDoc); symlinkSync("/etc/hosts", f.childDoc);
    assert.ok(collectStoryInput(f.task, f.options).sources[0].missing);
    mkdirSync(join(f.root, "other")); symlinkSync(join(f.root, "other"), join(f.task.summary.workspace, "overall-story"));
    assert.throws(() => currentStoryFile(f.task.summary.workspace), /越界/);
    const contract = overallStoryGate("/workspace");
    const gate = (tool: string, value: string) => contract(tool, value, {} as import("../src/semanticEvents.ts").SemanticEvent);
    assert.equal(gate("Write", "story.md")?.action, "allow");
    assert.equal(gate("Write", "architecture.json")?.action, "allow");
    for (const path of ["inputs/requirement.md", "../story.md", "/tmp/escape"]) assert.equal(gate("Write", path)?.action, "deny");
    assert.equal(gate("Bash", "pwd")?.action, "deny");
  } finally { f.dispose(); }
});

test("真实文档会话沿用内核 Story 模板并单独生成平台图源，无需主 Agent 或 Bash", async () => {
  const f = fixture();
  const model = new ScriptedModelServer([
    { tool: { name: "read", input: { path: "inputs/template.md" } } },
    { tool: { name: "write", input: { path: "story.md", content: "# 整体 Story\n待补充接口 Story" } } },
    { tool: { name: "write", input: { path: "architecture.json", content: '{"schema_version":1,"diagrams":[]}' } } },
    { text: "整理完成，缺少接口子任务 Story。" },
  ]);
  await model.start();
  try {
    f.runner(async (task, job) => {
      await runOverallStorySession(task, job, { taskId: "parent", workspace: task.summary.workspace,
        kernelRoot: KERNEL_ROOT, model: { provider: "maeflow", model: "scripted-v1" }, models: model.modelsJson() });
      assert.equal(readFileSync(join(job.root, "inputs/template.md"), "utf8"), readFileSync(join(KERNEL_ROOT, "skills/mae-flow/assets/STORY-TEMPLATE.md"), "utf8"));
      assert.match(overallStoryMission(job), /无权修改子任务/);
      assert.match(overallStoryMission(job), /不得把 Archify JSON 写进 story\.md/);
    });
    f.coordinator.generate("parent", "owner"); await f.coordinator.settled("parent");
    assert.equal(f.coordinator.status("parent").error, undefined);
    assert.match(readCurrentStory(f.task.summary.workspace), /整体 Story/);
    const architecture = JSON.parse(readCurrentStoryArchitecture(f.task.summary.workspace)!);
    assert.match(architecture.story_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(architecture.diagrams, []);
    assert.ok(new EventLog(join(f.task.summary.workspace, "events.jsonl")).replay().some((e) => e.kind === "tool_requested"));
  } finally { await model.stop(); f.dispose(); }
});

test("TaskService 转交整体 Story：completed 可提交，普通原文仍禁止、重复提交幂等", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-story-service-"));
  const service = new TaskService({ dataDir: root, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  try {
    const task = service.create("需求", { account: "owner", collaborators: ["reviewer"], requirementAnalysis: true });
    const internal = (service as any).tasks.get(task.id);
    internal.summary.status = "completed";
    internal.summary.requirement_graph = { stage: "confirmed", repositories: [{ id: "x", name: "x" }], dependencies: [] };
    const coordinator = new OverallStoryCoordinator({ task: () => internal, artifactRoot: () => undefined, ready() {},
      run: async (_t, job) => {
        mkdirSync(job.root, { recursive: true }); writeFileSync(join(job.root, "story.md"), "# Story\n说明");
        writeFileSync(join(job.root, "receipts.json"), JSON.stringify(job.annotations.map((a) => ({ annotation_id: a.id,
          outcome: "not_fixed", summary: "需要子任务先修改设计", evidence: [] }))));
      } });
    (service as any).overallStories = coordinator;
    coordinator.generate(task.id, "owner"); await coordinator.settled(task.id);
    const note = service.addAnnotation(task.id, { author: "reviewer", artifact: OVERALL_STORY_ARTIFACT,
      file: OVERALL_STORY_ARTIFACT, line: 2, anchor: "说明", note: "改设计", kind: "doc" });
    assert.deepEqual((await service.sendAnnotations(task.id, [note.id], "reviewer")).sent, [note.id]);
    await coordinator.settled(task.id);
    assert.deepEqual((await service.sendAnnotations(task.id, [note.id], "owner", true)).sent, [note.id]);
    const ordinary = service.addAnnotation(task.id, { author: "reviewer", artifact: "__task_requirement__",
      file: "需求原文", line: 1, anchor: "需求", note: "修改原文", kind: "doc" });
    await assert.rejects(service.sendAnnotations(task.id, [ordinary.id], "reviewer"), /已经结束/);
    await assert.rejects(service.sendAnnotations(task.id, [note.id], "stranger"), /不是你写的/);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("HTTP：受邀检视人能读整体 Story，只有责任人能生成和确认", async () => {
  const { createTaskServer } = await import("../src/server.ts");
  const { LocalAuth } = await import("../src/auth.ts");
  const root = mkdtempSync(join(tmpdir(), "mfc-story-auth-"));
  const auth = new LocalAuth(join(root, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password");
  auth.createUser("owner", "owner-password", "developer");
  auth.createUser("reviewer", "reviewer-password", "developer");
  const service = new TaskService({ dataDir: join(root, "tasks"), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const task = service.create("需求", { account: "owner", collaborators: ["reviewer"], requirementAnalysis: true });
  let generated = 0, confirmed = 0, architecture = 0;
  (service as any).overallStories = { status: () => ({ current: "one", label: "待检视" }),
    generate: () => { generated++; return {}; }, generateArchitecture: () => { architecture++; return {}; }, confirm: () => { confirmed++; return {}; }, shutdown: async () => {} };
  const server = createTaskServer(service, { auth });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  try {
    const login = async (name: string) => (await fetch(base + "/auth/login", { method: "POST", body: JSON.stringify({ username: name, password: name + "-password" }) })).headers.get("set-cookie")!.split(";")[0];
    const reviewer = await login("reviewer"), owner = await login("owner");
    const url = `${base}/tasks/${task.id}/overall-story`;
    assert.equal((await fetch(url, { headers: { cookie: reviewer } })).status, 200);
    assert.equal((await fetch(url, { method: "POST", headers: { cookie: reviewer }, body: "{}" })).status, 403);
    assert.equal((await fetch(url + "/architecture", { method: "POST", headers: { cookie: reviewer } })).status, 403);
    assert.equal((await fetch(url + "/architecture", { method: "POST", headers: { cookie: owner } })).status, 202);
    assert.equal(architecture, 1);
    assert.equal((await fetch(url + "/confirm", { method: "POST", headers: { cookie: reviewer }, body: '{"revision":"one"}' })).status, 403);
    assert.equal((await fetch(url, { method: "POST", headers: { cookie: owner }, body: "{}" })).status, 202);
    assert.equal((await fetch(url + "/confirm", { method: "POST", headers: { cookie: owner }, body: '{"revision":"one"}' })).status, 200);
    assert.equal(generated, 1); assert.equal(confirmed, 1);
  } finally { await new Promise<void>((r) => server.close(() => r())); await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

for (const action of ["reopen", "resubmit", "edit", "resolve"] as const) {
 test(`整体 Story 旧轮完成保留人工 ${action}，不污染新版本`, async () => {
  const f = fixture();
  let release!: () => void;
  try {
    f.coordinator.generate("parent", "owner");
    await f.coordinator.settled("parent");
    const note = f.note();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    f.runner(async (_task, job) => {
      entered(); await hold;
      mkdirSync(job.root, { recursive: true });
      writeFileSync(join(job.root, "story.md"), `${job.before}\n旧轮完成的改动`);
      writeFileSync(join(job.root, "receipts.json"), JSON.stringify(job.annotations.map((a) => ({
        annotation_id: a.id, revision: a.rework ?? 0, outcome: "fixed", summary: "已在整体 Story 中补充本轮要求的验收说明", evidence: ["story.md:5"],
      }))));
    });
    f.coordinator.submit("parent", [note], "reviewer");
    await started;
    if (action === "edit") f.store.edit(note.id, "新的验收口径说明", "reviewer", true);
    else if (action === "resolve") f.store.resolveAsOwner(note.id, "owner",
      { revision: 0, outcome: "deferred", reason: "下一轮补充约定" });
    else {
      f.store.reopen(note.id, "owner", undefined, true);
      if (action === "resubmit") f.coordinator.submit("parent", f.store.drafts(), "owner");
    }
    release();
    await f.coordinator.settled("parent");
    const saved = f.store.list()[0];
    assert.equal(saved.status, action === "resolve" ? "verified" : action === "resubmit" ? "sent" : "draft");
    assert.equal(saved.rework ?? 0, action === "resolve" ? 0 : 1);
    if (action === "resubmit") {
      assert.equal(saved.response?.revision, 1);
      assert.equal(f.calls(), 3, "生成、旧轮修订、新轮修订分别执行");
    } else assert.equal(saved.response, undefined);
    assert.equal(f.coordinator.status("parent").error, undefined, "旧回执不适用不代表已发布的文档修订失败");
  } finally { release?.(); await f.coordinator.shutdown(); f.dispose(); }
});

}
