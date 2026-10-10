// r5 翻转：任务中心与详情都使用后端投影，优先显示需要人处理的归档事实。
import assert from "node:assert/strict";
import { componentGuideOverview, componentGuideSection, componentGuideEvidence } from "./fixtures/componentGuide.ts";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { knowledgeArchiveState } from "../src/knowledgeArchiveStatus.ts";
import { componentKnowledgeTask, domainKnowledgeTask } from "../src/knowledgeTaskCenter.ts";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import type { ResearchRecord } from "../src/componentResearch.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";

function domain(): DomainKnowledgeJob {
  return { id: "dkx-1", title: "结算", scope: "结算", operator: "alice", created_at: "2026-09-30T01:00:00Z", status: "done", stage: "", revisions: {}, repositories: [],
    knowledge_target: { id: "domain", name: "知识仓", repository: "https://code.example/k", branch: "main", path: "", docs_path: "docs" }, material_ids: [],
    documents: [{ id: "doc", title: "规则", target_id: "domain", path: "docs/a.md", layer: "domain", content: "规则", sources: "", selected: true, revision: 2, base_content: null, base_revision: "", history: [], knowledge_document_id: "kd-1", published_document_revision: 2, published_revision: "r" }],
    turns: [], evidence: [], publications: [] };
}

function component(id = "cr-matrix"): ResearchRecord {
  return { id, component: { id: "files", name: "文件", repository: "https://example.test/files.git", branch: "main", path: "src", languages: ["java"], description: "", enabled: true },
    language: "java", topic: "文件规则", operator: "alice", key: id, status: "done", stage: "已完成", created_at: "2026-10-03T00:00:00Z", evidence: [], document_id: "kd-1" };
}
function manualBatch(job: DomainKnowledgeJob, state: "running" | "done" | "failed") {
  const publication = { target_id: "domain", branch: "codex/manual", state: state === "done" ? "opened" as const : state === "failed" ? "failed" as const : "pending" as const,
    url: state === "done" ? "https://example.test/mr/1" : undefined, error: state === "failed" ? "Git推送失败" : undefined, documents: [] };
  return { id: "batch", issue_no: "REQ-MANUAL", state, created_at: job.created_at, operator: "alice", documents: structuredClone(job.documents), targets: [job.knowledge_target], publications: [publication], error: publication.error };
}
for (const state of [undefined, "running", "failed", "done"] as const) test(`生产线验收8：领域组件人工归档${state ?? "未创建"}使用同一后端文案分组和唯一归档入口`, () => {
  const job = domain(), record = component(); if (state) { job.archive_batches = [manualBatch(job, state)]; job.publications = job.archive_batches[0].publications; }
  const label = state === "running" ? "归档中" : state === "failed" ? "归档失败" : state === "done" ? "已归档" : "已发布（未归档）";
  const projected = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(projected.archive.status_label, label); assert.equal(projected.status_label, label);
  assert.equal(projected.group, state === "failed" ? "attention" : state === "running" ? "running" : "completed");
  assert.deepEqual(projected.archive.actions.map(action => action.id), ["archive"]);
  const componentView = componentKnowledgeTask(record, job).production!;
  assert.equal(componentView.archive.status_label, label); assert.equal(componentView.group, projected.group);
  if (state === "failed") { job.status = "failed"; assert.equal(domainKnowledgeTask(job).status_label, "归档失败"); }
});

test("生产线验收8：明确提供当前正式版本时，旧MR不代表新版本已归档；已删除正式版本不提供归档动作", () => {
  const job = domain(), record = component(); job.archive_batches = [manualBatch(job, "done")];
  for (const kind of ["domain", "component"] as const) {
    const input = kind === "domain" ? { kind, record: job } : { kind, record, archive: job };
    assert.equal(projectKnowledgeProduction({ ...input, current_revisions: { "kd-1": "new" } }).archive.status_label, "已发布（未归档）");
    const missing = projectKnowledgeProduction({ ...input, current_revisions: {} });
    assert.equal(missing.archive.visible, false); assert.deepEqual(missing.archive.actions, []);
  }
});

test("生产线验收8：旧平台恢复pending没有人工单号，不显示正在归档也不制造归档失败", () => {
  const job = domain(); job.archive_batches = [{ ...manualBatch(job, "running"), issue_no: undefined, state: "pending", publications: [] }];
  assert.equal(knowledgeArchiveState(job), "done"); assert.equal(domainKnowledgeTask(job).status_label, "已发布（未归档）");
});

test("生产线验收5/8：增加新的正式文稿后，旧MR只保留历史链接，不能把未归档新篇显示为全任务已归档", () => {
  const job = domain(); job.archive_batches = [manualBatch(job, "done")];
  job.documents.push({ ...structuredClone(job.documents[0]), id: "new-doc", title: "新正式文稿", path: "docs/new.md", knowledge_document_id: "kd-2", published_revision: "new" });
  const projected = projectKnowledgeProduction({ kind: "domain", record: job, current_revisions: { "kd-1": "r", "kd-2": "new" } });
  assert.equal(projected.archive.status_label, "已发布（未归档）");
  assert.equal(projected.status_label, "已发布（未归档）");
  assert.equal(projected.archive.batches[0].publications[0].url, "https://example.test/mr/1");
});

for (const change of ["仓库", "分支", "目录", "文件路径"] as const) test(`生产线验收5/8：归档${change}变化后历史MR保留，但新输出位置不显示已归档`, () => {
  const job = domain(); job.archive_batches = [manualBatch(job, "done")];
  // 目标快照与任务设置必须独立，真实批次通过耐久序列化保存。
  job.archive_batches[0].targets = structuredClone(job.archive_batches[0].targets);
  if (change === "仓库") job.knowledge_target.repository = "https://example.test/other.git";
  else if (change === "分支") job.knowledge_target.branch = "other";
  else if (change === "目录") job.knowledge_target.docs_path = "other";
  else job.documents[0].archive_path = "other/rules.md";
  const projected = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(projected.archive.status_label, "已发布（未归档）");
  assert.equal(projected.archive.batches[0].publications[0].url, "https://example.test/mr/1");
});

test("生产线验收8：缺少明确草稿发布版本不从正式哈希、MR或时间猜测已审查", () => {
  const job = domain(); delete job.documents[0].published_document_revision; job.documents[0].published_at = job.created_at; job.archive_batches = [manualBatch(job, "done")];
  const projected = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(projected.documents[0].published_revision, undefined); assert.equal(projected.documents[0].changed, true);
  assert.equal(projected.status_label, "待审查"); assert.equal(projected.group, "attention"); assert.equal(projected.next_action.id, "review");
});

async function within<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

test("生产线验收8：真实磁盘与TaskService启动后，任务中心、领域和组件列表详情的状态分组下一步及归档字段完全一致", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-production-http-state-"));
  seedTechnologyStacks(dir, ["java"]);
  const cases = [
    { name: "归档失败", research: "failed" as const, archiveState: "failed" as const, label: "归档失败", group: "attention", action: "archive" },
    { name: "只有研究失败", research: "failed" as const, label: "执行失败", group: "attention", action: "resume" },
    { name: "未创建归档", research: "done" as const, label: "已发布（未归档）", group: "completed", action: "knowledge" },
    { name: "MR已创建", research: "done" as const, archiveState: "done" as const, label: "已归档", group: "completed", action: "knowledge" },
  ];
  const identities: Array<{ case: typeof cases[number]; kind: "domain" | "component"; id: string; archiveId: string }> = [];
  for (const item of cases) for (const kind of ["domain", "component"] as const) {
    const id = `${kind === "domain" ? "dkx" : "cr"}-${randomUUID()}`, archiveId = kind === "domain" ? id : `dkx-${randomUUID()}`;
    const formal = saveKnowledgeDocument(dir, { title: `${kind}-${item.name}`, content: "已入库规则", scope: "platform", technologies: kind === "component" ? ["java"] : [] }, "alice");
    const job = domain(); job.id = archiveId; job.title = `${kind}-${item.name}`; job.status = item.research;
    job.documents[0] = { ...job.documents[0], knowledge_document_id: formal.id, content: formal.content, published_revision: formal.revision };
    if (kind === "component") job.component_research_id = id;
    if (item.archiveState) { job.archive_batches = [manualBatch(job, item.archiveState)]; job.publications = job.archive_batches[0].publications; }
    const jobPath = join(dir, "domain-extraction", archiveId, "job.json"); mkdirSync(dirname(jobPath), { recursive: true }); writeFileSync(jobPath, JSON.stringify(job));
    if (kind === "component") {
      const record = component(id); record.status = item.research; record.document_id = formal.id; record.published_revision = formal.revision;
      const recordPath = join(dir, "component-research", id, "record.json"); mkdirSync(dirname(recordPath), { recursive: true }); writeFileSync(recordPath, JSON.stringify(record));
    }
    identities.push({ case: item, kind, id, archiveId });
  }
  const service = new TaskService({ dataDir: dir, provider: "", model: "", modelsJson: {}, maxConcurrent: 0 });
  const server = createTaskServer(service);
  try {
    await within(new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }), 5_000, "HTTP测试服务启动超过5秒预算");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    async function read(path: string) {
      const response = await fetch(base + path, { signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 200, `${path} ${await response.clone().text()}`);
      return await response.json() as any;
    }
    const [center, domains, components] = await Promise.all([read("/knowledge-tasks"), read("/domain-extraction"), read("/component-research")]);
    assert.deepEqual(center.warnings, []);
    for (const identity of identities) {
      const path = `/${identity.kind === "domain" ? "domain-extraction" : "component-research"}/${identity.id}`;
      const detail = await read(path), row = center.tasks.find((row: any) => row.id === identity.id);
      assert.ok(row, identity.case.name);
      assert.equal(row.status_label, identity.case.label); assert.equal(row.group, identity.case.group);
      assert.equal(row.next_action.id, identity.case.action);
      assert.deepEqual(row.production, detail.production, `${identity.kind} ${identity.case.name} 的中心与详情必须来自同一投影`);
      assert.deepEqual(row.next_action, detail.production.next_action);
      const listed = (identity.kind === "domain" ? domains : components).records.find((record: any) => record.id === identity.id);
      assert.deepEqual(listed.production, detail.production, "摘要删正文也不能重新推断状态");
      if (identity.kind === "component") {
        const preview = await read(`/component-research/${identity.id}/archive/preview`);
        assert.equal(preview.status_label, detail.production.archive.status_label, "组件归档预览与组件任务事实一致");
      }
    }
    assert.equal(center.summary.running, 0);
    assert.equal(center.summary.attention, identities.filter(identity => identity.case.group === "attention").length);
    assert.equal(center.summary.total, identities.length);
  } finally {
    await within(service.shutdown(), 5_000, "状态测试TaskService关停超过5秒预算");
    await within(new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }), 5_000, "状态测试HTTP关停超过5秒预算");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("生产线验收8：组件已绑定更新基线且修订章节有内容，研究动作应确认发布当前草稿而非再发起更新", () => {
  const record = component();
  record.update_document_id = record.document_id; record.update_document_revision = "a".repeat(64); delete record.document_id;
  record.evidence = componentGuideEvidence(record.language, [record.component.id]);
  record.document = { overview: componentGuideOverview("修订后的组件说明", "使用 JDK 11 或更新版本。"), sections: [{
    ...componentGuideSection("files", [record.component.id], { title: "文件处理", content: "补充失败时的资源释放", language: record.language }), selected: true, revision: 2,
  }] };
  const projected = projectKnowledgeProduction({ kind: "component", record });
  assert.equal(projected.status_label, "待审查"); assert.equal(projected.group, "attention");
  assert.equal(projected.next_action.id, "review");
  assert.deepEqual(projected.research_actions.map(action => action.id), ["publish"]);
  assert.ok(projected.research_actions.every(action => /发布/.test(action.label)));
  assert.equal(projected.knowledge_document_id, record.update_document_id);
  assert.match(projected.platform_message ?? "", /继续使用已入库知识/);
});
