import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { ComponentResearch, type ResearchRecord } from "../src/componentResearch.ts";
import { listKnowledgeDocuments, prepareKnowledgeDocument, readKnowledgeDocument, saveKnowledgeDocument, writePreparedKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { createBusinessModule, updateBusinessModule } from "../src/businessModuleLibrary.ts";
import { writeKnowledgeDeletion } from "../src/knowledgeDeletionStore.ts";
import { listKnowledgeTasks } from "../src/knowledgeTaskCenter.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";

const repository = { id: "orders", name: "订单", repository: "https://example.test/orders.git", branch: "main", path: "", docs_path: "domains" };
function domainRecord(): DomainKnowledgeJob {
  return { id: `dkx-${randomUUID()}`, title: "正常领域研究", scope: "订单规则", operator: "alice", created_at: "2026-10-02T00:00:00Z", repositories: [repository], knowledge_target: { ...repository, id: "domain" }, material_ids: [], status: "done", stage: "等待审查", revisions: {}, documents: [], turns: [], evidence: [], publications: [] };
}
function componentRecord(): ResearchRecord {
  return { id: `cr-${randomUUID()}`, component: { id: "orders", name: "订单", repository: repository.repository, branch: "main", path: "", languages: ["java"], enabled: true, description: "" }, language: "java", topic: "正常组件研究", operator: "alice", key: "fixture", status: "done", created_at: "2026-10-02T00:00:00Z", stage: "等待审查", evidence: [] };
}
function write(dir: string, relative: string, content: string) { const path = join(dir, relative); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path; }
function assertWarnings(warnings: string[], paths: string[]) { for (const path of paths) assert.ok(warnings.some(warning => warning.includes(path)), `告警应点名 ${path}`); }

// 从 r8 搬入：每个读取器必须隔离单条坏记录，不能让正常邻居消失。
test("生产线验收3：领域与组件隔离语法坏及合法 JSON 坏形状记录，正常邻居可用且原坏文件不变", async () => {
  const dir = mkdtempSync(join(tmpdir(), "production-corrupt-records-"));
  const goodDomain = domainRecord(), goodComponent = componentRecord();
  const malformedDomain = domainRecord(), malformedComponent = componentRecord();
  const bad = [
    { relative: `domain-extraction/dkx-${randomUUID()}/job.json`, content: '{"id":' },
    { relative: `domain-extraction/${malformedDomain.id}/job.json`, content: JSON.stringify({ ...malformedDomain, documents: {}, turns: [] }) },
    { relative: `component-research/cr-${randomUUID()}/record.json`, content: "" },
    { relative: `component-research/${malformedComponent.id}/record.json`, content: JSON.stringify({ ...malformedComponent, evidence: {}, document: { sections: {} } }) },
  ];
  let domain: DomainKnowledgeExtraction | undefined, component: ComponentResearch | undefined;
  try {
    write(dir, `domain-extraction/${goodDomain.id}/job.json`, JSON.stringify(goodDomain));
    write(dir, `component-research/${goodComponent.id}/record.json`, JSON.stringify(goodComponent));
    for (const item of bad) write(dir, item.relative, item.content);
    domain = new DomainKnowledgeExtraction(dir, async () => "unused");
    component = new ComponentResearch(dir, async () => "unused");
    assert.deepEqual(domain.list().map(record => record.id), [goodDomain.id]);
    assert.deepEqual(component.list().map(record => record.id), [goodComponent.id]);
    assert.equal(domain.get(goodDomain.id).title, goodDomain.title); assert.equal(component.get(goodComponent.id).topic, goodComponent.topic);
    assertWarnings(domain.warnings(), bad.slice(0, 2).map(item => item.relative));
    assertWarnings(component.warnings(), bad.slice(2).map(item => item.relative));
    for (const item of bad) assert.equal(readFileSync(join(dir, item.relative), "utf8"), item.content, "不自动移动、改写或删除坏文件");
  } finally { await domain?.shutdown(); await component?.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收3：正式库隔离坏 JSON 与坏形状文档，列表和新发布仍可用且告警点名文件", () => {
  const dir = mkdtempSync(join(tmpdir(), "production-corrupt-documents-"));
  try {
    const good = saveKnowledgeDocument(dir, { title: "好文档", content: "正文" }, "alice");
    const malformedId = `kd-${randomUUID()}`;
    const bad = [
      { relative: `knowledge-documents/kd-${randomUUID()}.json`, content: "" },
      { relative: `knowledge-documents/${malformedId}.json`, content: JSON.stringify({ ...good, id: malformedId, history: {}, content: null }) },
    ];
    for (const item of bad) write(dir, item.relative, item.content);
    const warnings: string[] = [];
    assert.deepEqual(listKnowledgeDocuments(dir, warnings).map(document => document.id), [good.id]);
    assertWarnings(warnings, bad.map(item => item.relative));
    const next = saveKnowledgeDocument(dir, { title: "新发布", content: "新正文" }, "alice");
    assert.deepEqual(new Set(listKnowledgeDocuments(dir).map(document => document.id)), new Set([good.id, next.id]));
    for (const item of bad) assert.equal(readFileSync(join(dir, item.relative), "utf8"), item.content);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收3：知识任务需要处理计数包含领域、组件和正式库坏记录告警", async () => {
  const dir = mkdtempSync(join(tmpdir(), "production-corrupt-center-"));
  const goodDomain = domainRecord(), goodComponent = componentRecord();
  const bad = [`domain-extraction/dkx-${randomUUID()}/job.json`, `component-research/cr-${randomUUID()}/record.json`, `knowledge-documents/kd-${randomUUID()}.json`];
  let domain: DomainKnowledgeExtraction | undefined, component: ComponentResearch | undefined;
  try {
    write(dir, `domain-extraction/${goodDomain.id}/job.json`, JSON.stringify(goodDomain));
    write(dir, `component-research/${goodComponent.id}/record.json`, JSON.stringify(goodComponent));
    for (const path of bad) write(dir, path, "{");
    domain = new DomainKnowledgeExtraction(dir, async () => "unused"); component = new ComponentResearch(dir, async () => "unused");
    const center = listKnowledgeTasks({ dataDir: dir, domain, component, skillExtractionJob: () => undefined });
    assert.deepEqual(new Set(center.tasks.map(task => task.id)), new Set([goodDomain.id, goodComponent.id]));
    assertWarnings(center.warnings, bad);
    assert.equal(center.summary.attention, center.tasks.filter(task => task.group === "attention").length + center.warnings.length);
    for (const path of bad) assert.equal(readFileSync(join(dir, path), "utf8"), "{");
  } finally { await domain?.shutdown(); await component?.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收4：正式库准备只读并确定精确版本，提交原子写入且 unchanged 不增版本", () => {
  const dir = mkdtempSync(join(tmpdir(), "production-prepared-document-"));
  try {
    const prepared = prepareKnowledgeDocument(dir, { title: "订单规则", content: "第一版" }, "alice");
    assert.match(prepared.document.id, /^kd-[a-f0-9-]{36}$/); assert.match(prepared.document.revision, /^[a-f0-9]{64}$/);
    assert.equal(prepared.previous_revision, null); assert.equal(prepared.unchanged, false);
    assert.equal(existsSync(join(dir, "knowledge-documents")), false); assert.equal(existsSync(join(dir, "knowledge-document-versions")), false);
    const committed = writePreparedKnowledgeDocument(dir, prepared);
    assert.deepEqual(committed, prepared.document); assert.deepEqual(readKnowledgeDocument(dir, committed.id), JSON.parse(JSON.stringify(prepared.document)));
    const versions = join(dir, "knowledge-document-versions", committed.id);
    const before = readdirSync(versions).sort(), original = readFileSync(join(dir, "knowledge-documents", `${committed.id}.json`), "utf8");
    const unchanged = prepareKnowledgeDocument(dir, { content: committed.content }, "bob", committed.id, { expectedRevision: committed.revision });
    assert.equal(unchanged.unchanged, true); assert.equal(unchanged.previous_revision, committed.revision);
    writePreparedKnowledgeDocument(dir, unchanged);
    assert.deepEqual(readdirSync(versions).sort(), before); assert.equal(readFileSync(join(dir, "knowledge-documents", `${committed.id}.json`), "utf8"), original);
    assert.ok(readdirSync(join(dir, "knowledge-documents")).every(path => !path.endsWith(".tmp")));
    assert.ok(readdirSync(versions).every(path => !path.endsWith(".tmp")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收4：准备后基线前进或知识被删除，提交拒绝且不覆盖正式版本", () => {
  const dir = mkdtempSync(join(tmpdir(), "production-prepared-conflict-"));
  try {
    const original = saveKnowledgeDocument(dir, { title: "订单规则", content: "第一版" }, "alice");
    const prepared = prepareKnowledgeDocument(dir, { content: "待提交修改" }, "alice", original.id, { expectedRevision: original.revision });
    const newer = saveKnowledgeDocument(dir, { content: "他人刚发布" }, "bob", original.id, { expectedRevision: original.revision });
    assert.throws(() => writePreparedKnowledgeDocument(dir, prepared), /已有新版本/);
    assert.equal(readKnowledgeDocument(dir, original.id).revision, newer.revision);
    const deleted = prepareKnowledgeDocument(dir, { content: "删除前准备的修改" }, "alice", original.id, { expectedRevision: newer.revision });
    const bytes = readFileSync(join(dir, "knowledge-documents", `${original.id}.json`), "utf8");
    writeKnowledgeDeletion(dir, { id: original.id, title: original.title, revision: newer.revision, at: new Date().toISOString(), operator: "bob", index_ids: [], index_state: "pending" });
    assert.throws(() => writePreparedKnowledgeDocument(dir, deleted), /已删除/);
    assert.equal(readFileSync(join(dir, "knowledge-documents", `${original.id}.json`), "utf8"), bytes);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收4：准备后模块停用或研究知识删除，提交重验后不产生正式知识及版本", () => {
  const dir = mkdtempSync(join(tmpdir(), "production-prepared-validation-"));
  try {
    createBusinessModule(dir, { id: "orders", name: "订单", description: "订单规则", owner: "alice", repositories: [repository.repository] }, "alice");
    const prepared = prepareKnowledgeDocument(dir, { title: "模块规则", content: "正文", scope: "module", module_ids: ["orders"] }, "alice");
    updateBusinessModule(dir, "orders", { status: "archived" }, "bob");
    assert.throws(() => writePreparedKnowledgeDocument(dir, prepared), /业务模块已停用/);
    assert.equal(existsSync(join(dir, "knowledge-documents")), false); assert.equal(existsSync(join(dir, "knowledge-document-versions")), false);
    const research = prepareKnowledgeDocument(dir, { title: "研究规则", content: "研究正文", research_source: { job_id: "dkx-deleted", repository: repository.repository, branch: "main", path: "domains/rules.md" } }, "alice");
    writeKnowledgeDeletion(dir, { id: `kd-${randomUUID()}`, title: "已删除研究规则", revision: "a".repeat(64), at: new Date().toISOString(), operator: "bob", research_job_id: "dkx-deleted", index_ids: [], index_state: "pending" });
    assert.throws(() => writePreparedKnowledgeDocument(dir, research), /本次萃取的知识已删除/);
    assert.equal(existsSync(join(dir, "knowledge-documents")), false); assert.equal(existsSync(join(dir, "knowledge-document-versions")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收3（F5）：活动组件讨论缺少文稿或对应章节时逐条隔离，坏字节不改且正常邻居可读", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-component-active-shape-"));
  const good = componentRecord();
  const bad = ["missing-document", "missing-section"].map(kind => {
    const record = componentRecord();
    record.status = "running";
    record.review_turns = [{ id: "review-original", section_id: "orders", mode: "discuss", message: "讨论订单组件", operator: "alice", status: "running", created_at: record.created_at }];
    if (kind === "missing-section") record.document = { overview: "已有总览", sections: [] };
    return { path: `component-research/${record.id}/record.json`, bytes: JSON.stringify(record) };
  });
  let research: ComponentResearch | undefined;
  try {
    write(dir, `component-research/${good.id}/record.json`, JSON.stringify(good));
    for (const entry of bad) write(dir, entry.path, entry.bytes);
    let executions = 0;
    research = new ComponentResearch(dir, async () => { executions++; throw new Error("损坏记录不应进入执行"); });
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    assert.deepEqual(research.list().map(record => record.id), [good.id]);
    assert.equal(research.get(good.id).topic, good.topic);
    assert.equal(executions, 0);
    assertWarnings(research.warnings(), bad.map(entry => entry.path));
    for (const entry of bad) assert.equal(readFileSync(join(dir, entry.path), "utf8"), entry.bytes);
  } finally {
    await research?.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("生产线验收3（F5）：范式证据只认本组件仓，引用其他组件仓的研究如实失败；重启读取与写入口一致", async () => {
  const { saveComponentRepository } = await import("../src/componentRepositories.ts");
  const dir = mkdtempSync(join(tmpdir(), "mfc-component-multi-repository-read-"));
  const first = saveComponentRepository(dir, { name: "订单组件", repository: "https://example.test/orders.git", branch: "main", path: "src", languages: ["java"] }, "alice");
  const second = saveComponentRepository(dir, { name: "公共文件组件", repository: "https://example.test/files.git", branch: "main", path: "src", languages: ["java"] }, "alice");
  const evidence = { repository_id: first.id, path: "src/Orders.java", revision: "a".repeat(40), start: 1, end: 3 };
  let cited = evidence;
  let initial: ComponentResearch | undefined, restarted: ComponentResearch | undefined;
  try {
    initial = new ComponentResearch(dir, async input => {
      input.editDocument!({ action: "overview", overview: "订单组件通过公共文件组件保存数据。" });
      input.editDocument!({ action: "outline", entries: [{ id: "orders", title: "订单保存", repository_ids: [first.id] }] });
      input.editDocument!({ action: "section", section: { id: "orders", title: "订单保存", repository_ids: [first.id], content: "订单保存约束。", interfaces: "save(order)", integration: "依赖公共文件组件。",
        example: "```java\nFiles.save(order);\n```", sources: "公共文件实现", related_ids: [],
        paradigm: { kind: "contracts", component: "orders", language: "java", status: "unverified", need: "保存订单", api: ["Files.save"], applicability: "公共文件组件可用。",
          replaces: { identifiers: [], imports: [], patterns: [] }, evidence: [cited], usage_evidence: [], open_questions: [] } } });
      return "草稿已保存";
    });
    // 一个组件一次研究：依赖组件的用法走 everycode 调用证据，不能冒充本组件的实现依据。
    cited = { ...evidence, repository_id: second.id };
    const misplaced = initial.start({ language: "java", component_id: first.id }, "alice");
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    assert.equal(initial.get(misplaced.id).status, "failed");
    assert.match(initial.get(misplaced.id).error!, /基础仓固定版本/);
    initial.remove(misplaced.id, "alice");
    cited = evidence;
    const job = initial.start({ language: "java", component_id: first.id }, "alice");
    for (let turn = 0; turn < 20; turn++) await Promise.resolve();
    assert.equal(initial.get(job.id).status, "done", initial.get(job.id).error);
    const before = initial.get(job.id);
    const path = join(dir, "component-research", job.id, "record.json"), bytes = readFileSync(path, "utf8");
    await initial.shutdown();
    restarted = new ComponentResearch(dir, async () => { throw new Error("已完成研究无需再执行"); });
    assert.deepEqual(restarted.warnings(), []);
    assert.deepEqual(restarted.get(job.id), JSON.parse(JSON.stringify(before)));
    assert.deepEqual(restarted.get(job.id).document!.sections[0].paradigm!.evidence, [evidence]);
    assert.equal(readFileSync(path, "utf8"), bytes, "合法旧记录无需改写");
  } finally {
    await initial?.shutdown(); await restarted?.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
