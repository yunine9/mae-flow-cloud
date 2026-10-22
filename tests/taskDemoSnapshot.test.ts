import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { AnnotationStore, TASK_REQUIREMENT_ARTIFACT, type Annotation } from "../src/annotations.ts";
import { LocalAuth } from "../src/auth.ts";
import { PIPELINE_EVIDENCE_GAP_FILE } from "../src/artifacts.ts";
import { createTaskServer } from "../src/server.ts";
import { readTaskDemoSnapshot, type TaskDemoSnapshot } from "../src/taskDemoSnapshot.ts";
import { TaskService } from "../src/taskService.ts";
import type { MemoryRecord } from "../src/taskMemory.ts";

function contents(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true }).map(String)
    .filter(path => statSync(join(root, path)).isFile())
    .sort().map(path => [path, readFileSync(join(root, path)).toString("base64")]));
}

test("演示批注快照复用当前状态计算，坏尾和缺少换行都不改原文件", t => {
  const root = mkdtempSync(join(tmpdir(), "mfc-demo-annotations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "annotations.jsonl");
  const store = new AnnotationStore(path, true);
  const note = store.add({ author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "原文", note: "原意见", kind: "doc" });
  const original = readFileSync(path, "utf-8");
  const edit = JSON.stringify({ op: "edit", id: note.id, note: "修改后的意见", at: "2026-10-22T01:00:00Z" });
  for (const suffix of [edit, edit + '\n{"op":']) {
    writeFileSync(path, original + suffix);
    const before = readFileSync(path);
    const snapshot = store.snapshot();
    assert.equal(snapshot.items[0].note, "修改后的意见");
    assert.equal((snapshot.history[0] as { record: Annotation }).record.note, "原意见");
    assert.equal(snapshot.skipped, suffix.endsWith(':') ? 1 : 0);
    assert.deepEqual(readFileSync(path), before);
  }
});

test("演示来源快照保留真实材料和会话，读取不修复、不推进或修改源任务", async t => {
  const root = mkdtempSync(join(tmpdir(), "mfc-demo-snapshot-"));
  const service = new TaskService({ dataDir: root, provider: "fixture", model: "fixture", modelsJson: {}, maxConcurrent: 0 });
  t.after(async () => { await service.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const task = service.create("展示需求澄清", { account: "owner", requirementAnalysisConfirmation: true });
  const note = service.addAnnotation(task.id, { author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "展示需求澄清", note: "补充验收条件", kind: "doc" });
  const annotationPath = join(task.workspace, "annotations.jsonl");
  writeFileSync(annotationPath, readFileSync(annotationPath, "utf-8") + '{"op":');
  const review = { id: "review-demo-source", task_id: task.id, task_title: "来源需求",
    requester: "owner", committer: "reviewer", status: "pending", created_at: "2026-10-22T01:00:00Z",
    delivered: true, attempts: 1 };
  writeFileSync(join(root, "reviews.jsonl"), JSON.stringify(review) + '\n{"id":');
  const event = { eventId: 1, taskId: task.id, sessionId: "main", ts: "2026-10-22T01:00:00Z",
    kind: "assistant_message", payload: { text: "已核对现有实现，请确认兼容范围。" } };
  writeFileSync(service.eventLogPath(task.id), JSON.stringify(event) + '\n{"eventId":');
  mkdirSync(join(task.workspace, "pipeline"), { recursive: true });
  writeFileSync(join(task.workspace, "pipeline", PIPELINE_EVIDENCE_GAP_FILE), "# 待补验证\n实际文档正文");
  const memory: MemoryRecord = { id: "c-demo-candidate", task: task.id, file: "candidate.md",
    at: "2026-10-22T01:00:00Z", source: "user_note", judged_by: "human", scope: "local",
    repo: "demo", paths: [], evidence: `annotation:${note.id}`, author: "owner",
    trigger: "验收条件", conclusion: "确认兼容范围", revision: 1, review: { status: "pending" } };
  const reused: MemoryRecord = { ...memory, id: "c-demo-reused", task: "prior-task", file: "reused.md" };
  const traversal: MemoryRecord = { ...memory, id: "c-demo-invalid-path", file: "../reviews.jsonl" };
  mkdirSync(join(root, "corpus", "_archive"), { recursive: true });
  writeFileSync(join(root, "corpus", "index.jsonl"), [memory, { ...memory, revision: 2 }, reused, traversal]
    .map(record => JSON.stringify(record)).join("\n") + '\n{"id":');
  writeFileSync(join(root, "corpus", "candidate.md"), "# 待采纳经验\n确认兼容范围");
  writeFileSync(join(root, "corpus", "_archive", "reused.md"), "# 已有经验\n真实正文");
  writeFileSync(join(root, "corpus", "ledger.jsonl"), JSON.stringify({
    at: memory.at, kind: "archive", id: reused.id, note: "测试归档",
  }) + '\n{"kind":');
  const usage = { ts: memory.at, moment: "launch", ids: [reused.id] };
  writeFileSync(join(task.workspace, "memory-usage.jsonl"), JSON.stringify(usage) + '\n{"ts":');
  const before = contents(root);
  const beforeSummary = structuredClone(service.storedTaskSummary(task.id));
  t.mock.method(service, "getAsync", async () => { throw new Error("不得调用可能刷新源任务的详情投影"); });
  t.mock.method(service, "listAnnotationsAsync", async () => { throw new Error("不得调用自动对账的批注读取"); });
  t.mock.method(service, "conversationAsync", async () => { throw new Error("不得调用会修复日志的会话读取"); });
  t.mock.method(service, "listTaskReviews", () => { throw new Error("不得调用可能取消邀请的读取"); });

  const snapshot = await readTaskDemoSnapshot(service, task.id);
  assert.equal(snapshot.schema, "mae-flow-demo-snapshot/1");
  assert.equal(snapshot.source_task_id, task.id);
  assert.equal(snapshot.task.luban_account, "owner");
  assert.equal(snapshot.task.progress?.phases.length, 7);
  assert.equal(snapshot.task.progress?.current_index, -1, "没有来源阶段时不虚构当前阶段");
  assert.equal(snapshot.annotations.items[0].id, note.id);
  assert.equal(snapshot.reviews[0].id, review.id);
  assert.deepEqual(snapshot.memoryUsage, [usage]);
  assert.equal(snapshot.memories.find(item => item.record.id === memory.id)?.record.revision, 2);
  assert.equal(snapshot.memories.find(item => item.record.id === memory.id)?.content, "# 待采纳经验\n确认兼容范围");
  assert.equal(snapshot.memories.find(item => item.record.id === reused.id)?.record.archived, true);
  assert.equal(snapshot.memories.find(item => item.record.id === reused.id)?.content, "# 已有经验\n真实正文");
  assert.equal(snapshot.memories.find(item => item.record.id === traversal.id)?.content, "", "不能通过经验索引读取目录之外的文件");
  assert.ok(snapshot.artifacts.some(item => item.name.endsWith(PIPELINE_EVIDENCE_GAP_FILE)));
  assert.ok(snapshot.artifacts.every(item => !("content" in item)), "正文留给按需读取");
  assert.ok(snapshot.conversation.items.some(item => item.kind === "turn"
    && item.texts.some(text => text.text === event.payload.text)));
  assert.ok(snapshot.problems.some(problem => problem.includes("批注中有 1 行")));
  assert.ok(snapshot.problems.some(problem => problem.includes("检视邀请中有 1 行")));
  assert.ok(snapshot.problems.some(problem => problem.includes("经验候选中有 1 行")));
  assert.ok(snapshot.problems.some(problem => problem.includes("经验归档记录中有 1 行")));
  assert.ok(snapshot.problems.some(problem => problem.includes("知识使用记录中有 1 行")));
  assert.deepEqual(contents(root), before, "快照前后来源全部文件字节一致");
  snapshot.task.requirement = "只改副本";
  snapshot.annotations.items[0].note = "只改副本意见";
  assert.deepEqual(service.storedTaskSummary(task.id), beforeSummary, "快照与来源内存断开引用");

  const withPhases = await readTaskDemoSnapshot({
    options: { ...service.options, host: { kernelRoot: resolve("kernel") } as NonNullable<TaskService["options"]["host"]> },
    storedTaskSummary: id => service.storedTaskSummary(id),
    artifactRoot: id => service.artifactRoot(id),
    panelFile: (id, name) => service.panelFile(id, name),
    readDisplayEvents: id => service.readDisplayEvents(id),
  }, task.id);
  const vocabulary = JSON.parse(readFileSync(resolve("kernel/flow/phases.json"), "utf-8"));
  assert.deepEqual(withPhases.phase_steps,
    Object.fromEntries(vocabulary.phases.map((phase: { name: string; steps: string[] }) => [phase.name, phase.steps])));

  const pulsePath = join(task.workspace, "demo-source-panel-pulse.js");
  const sourcePhase = vocabulary.phases[3];
  for (const phase of [sourcePhase.name, "旧版本阶段"]) {
    writeFileSync(pulsePath, `window.MAE_FLOW_PULSE = ${JSON.stringify({
      phase, step: sourcePhase.steps[0], step_title: "正在设计", revision: 11,
    })};`);
    const sourceBefore = contents(root);
    const fromPulse = await readTaskDemoSnapshot({
      options: service.options,
      storedTaskSummary: id => service.storedTaskSummary(id),
      artifactRoot: id => service.artifactRoot(id),
      panelFile: () => pulsePath,
      readDisplayEvents: id => service.readDisplayEvents(id),
    }, task.id);
    assert.deepEqual(fromPulse.task.progress?.phases, vocabulary.phases.map((entry: { name: string }) => entry.name));
    assert.equal(fromPulse.task.progress?.current_index, phase === sourcePhase.name ? 3 : -1);
    assert.equal(fromPulse.task.progress?.step_id, sourcePhase.steps[0]);
    assert.deepEqual(contents(root), sourceBefore, "旧阶段也不能触发脉冲重写");
  }
});

test("演示来源端点仅允许登录 admin，未启用认证也不提供入口", async t => {
  const root = mkdtempSync(join(tmpdir(), "mfc-demo-auth-"));
  const service = new TaskService({ dataDir: join(root, "tasks"), provider: "fixture", model: "fixture", modelsJson: {}, maxConcurrent: 0 });
  const task = service.create("只读演示来源", { account: "developer", requirementAnalysisConfirmation: true });
  const auth = new LocalAuth(join(root, "auth.json"));
  auth.bootstrapAdmin("admin", "demo-admin-fixture");
  auth.createUser("developer", "demo-developer-fixture", "developer");
  const adminCookie = `mae_flow_session=${auth.createSession({ username: "admin", role: "admin" })}`;
  const developerCookie = `mae_flow_session=${auth.createSession({ username: "developer", role: "developer" })}`;
  const servers = [createTaskServer(service, { auth }), createTaskServer(service)];
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await service.shutdown(); rmSync(root, { recursive: true, force: true });
  });
  const bases: string[] = [];
  for (const server of servers) {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    bases.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }
  const path = `/tasks/${task.id}/demo-snapshot`;
  const missing = await fetch(bases[0] + path);
  assert.equal(missing.status, 401); await missing.text();
  const forbidden = await fetch(bases[0] + path, { headers: { cookie: developerCookie } });
  assert.equal(forbidden.status, 403); await forbidden.text();
  const unauthenticated = await fetch(bases[1] + path, { headers: { cookie: adminCookie } });
  assert.equal(unauthenticated.status, 401); await unauthenticated.text();
  const allowed = await fetch(bases[0] + path, { headers: { cookie: adminCookie } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  assert.equal((await allowed.json() as TaskDemoSnapshot).source_task_id, task.id);
  const post = await fetch(bases[0] + path, { method: "POST", headers: { cookie: adminCookie } });
  assert.equal(post.status, 405); assert.equal(post.headers.get("allow"), "GET"); await post.text();
  const absent = await fetch(bases[0] + "/tasks/missing/demo-snapshot", { headers: { cookie: adminCookie } });
  assert.equal(absent.status, 404); await absent.text();
});
