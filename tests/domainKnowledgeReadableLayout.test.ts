import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DomainKnowledgeExtraction, type DomainKnowledgeJob, type DomainPublication } from "../src/domainKnowledgeExtraction.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { readKnowledgeDocument, saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { saveKnowledgeRepoConfig } from "../src/knowledgeRepoConfig.ts";

const moduleId = "module-12345678-1234-1234-1234-123456789abc", moduleName = "无线产品管理";
const repo = { name: "FMProductFrontendService", repository: "https://example.test/FMProductFrontendService.git", branch: "master", docs_path: "docs" };
const domain = { repository: "https://example.test/knowledge.git", branch: "master", docs_path: "domains" };
async function done(service: DomainKnowledgeExtraction, id: string) {
  for (let i = 0; i < 200; i++) { const job = service.get(id); if (job.status === "done") return job; if (job.status === "failed") throw new Error(job.error); await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("研究未完成");
}
function receipt(job: DomainKnowledgeJob, targetId: string, number: number): DomainPublication {
  return { target_id: targetId, state: "opened", url: `https://example.test/mr/${number}`, mr_id: number, branch: `master_user_REQ_${number}`,
    documents: job.documents.filter(document => document.target_id === targetId).map(document => ({ id: document.id, path: document.path, content: document.content,
      revision: document.revision, knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision })) };
}
async function legacy(root: string, options: { batch?: "failed" | "done"; dirty?: boolean; pending?: boolean } = {}) {
  createBusinessModule(root, { id: moduleId, name: moduleName, description: "无线产品规则", owner: "user", repositories: [repo.repository] }, "user");
  const domainPath = `domains/${moduleId}/README.md`, repoPath = `docs/knowledge/${moduleId}/${repo.name}/docs/module-map.md`;
  const initial = new DomainKnowledgeExtraction(root, async input => {
    input.save({ id: "domain", title: moduleId, target_id: "domain", path: domainPath, layer: "domain", content: "# 已完成领域研究", sources: "已确认资料" });
    input.save({ id: "map", title: "模块索引", target_id: "repo-1", path: repoPath, layer: "repository", content: "# 已完成仓内研究", sources: "源码" });
    return "完成";
  });
  const created = await done(initial, initial.create({ issue_no: "REQ-readable", title: "旧研究任务", scope: "业务规则", repositories: [repo], knowledge_target: domain }, "user").id);
  await initial.shutdown();
  const file = join(root, "domain-extraction", created.id, "job.json"), stored: DomainKnowledgeJob = JSON.parse(readFileSync(file, "utf8"));
  stored.module_id = moduleId; stored.knowledge_layout = options.dirty ? "repository-v1" : "module-v1";
  stored.knowledge_target.docs_path = options.dirty ? `domains/${moduleName}` : `domains/${moduleId}`;
  stored.repositories[0].docs_path = options.dirty ? "." : `docs/knowledge/${moduleId}`;
  for (const document of stored.documents) {
    const target = document.target_id === "domain" ? stored.knowledge_target : stored.repositories[0];
    const formal = saveKnowledgeDocument(root, { title: document.title, content: document.content, scope: "module", module_ids: [moduleId],
      archive_target: { repository: target.repository, branch: target.branch, path: document.path },
      research_source: { job_id: stored.id, document_id: document.id, repository: target.repository, branch: target.branch, path: document.path } }, "user");
    document.knowledge_document_id = formal.id; document.published_revision = formal.revision; document.published_document_revision = document.revision;
  }
  if (options.pending) stored.turns[0].proposals.push({ status: "pending", base_revision: stored.documents[0].revision, document: { ...stored.documents[0], content: "# 待确认修改" } });
  if (options.batch) stored.archive_batches = [{ id: "old-frozen", state: options.batch, knowledge_layout: stored.knowledge_layout, created_at: new Date().toISOString(), operator: "user",
    issue_no: "REQ-readable", targets: structuredClone([stored.knowledge_target, ...stored.repositories]), documents: structuredClone(stored.documents),
    publications: options.batch === "done" ? [receipt(stored, "domain", 1), receipt(stored, "repo-1", 2)] : [] }];
  writeFileSync(file, JSON.stringify(stored));
  const workDirectory = join(root, "domain-extraction", stored.id, "skill-runs", stored.turns[0].id); mkdirSync(workDirectory, { recursive: true });
  const workFile = join(workDirectory, "work.json"), work = '{"version":1,"steps":[],"documents":[]}'; writeFileSync(workFile, work);
  const skillFile = join(root, "domain-extraction", stored.id, "skill.json"), skill = '{"name":"old-fixed-method","digest":"fixed","files":{"SKILL.md":"已完成的旧方法"}}'; writeFileSync(skillFile, skill);
  return { stored, file, workFile, work, skillFile, skill };
}

test("旧 module-v1 发布自动按真实业务名整理，不重做研究且旧失败批次仍精确重试", async () => {
  const root = mkdtempSync(join(tmpdir(), "readable-publish-")); const original = await legacy(root, { batch: "failed" });
  const archived: DomainKnowledgeJob[] = [];
  const service = new DomainKnowledgeExtraction(root, async () => { throw new Error("不能重新研究"); }, { publish: async (job, target) => { archived.push(structuredClone(job)); return receipt(job, target.id, archived.length); } });
  try {
    const before = service.get(original.stored.id);
    assert.equal(before.module_name, moduleName); assert.equal(JSON.parse(readFileSync(original.file, "utf8")).module_name, undefined);
    await service.publish(before.id, "user", { expected_revisions: { domain: 1, map: 1 } });
    const job = service.get(before.id);
    assert.equal(job.knowledge_layout, "repository-v1"); assert.equal(job.knowledge_target.docs_path, `domains/${moduleName}`); assert.equal(job.repositories[0].docs_path, ".");
    assert.deepEqual(job.documents.map(document => document.path), [`domains/${moduleName}/README.md`, "docs/module-map.md"]);
    assert.equal(job.documents[0].title, moduleName); assert.equal(job.documents[0].content, "# 已完成领域研究");
    assert.deepEqual(job.documents.map(document => document.knowledge_document_id), before.documents.map(document => document.knowledge_document_id));
    assert.deepEqual(job.turns, before.turns); assert.equal(job.status, "done");
    assert.deepEqual(job.archive_batches!.find(batch => batch.id === "old-frozen"), original.stored.archive_batches![0]);
    assert.equal(readFileSync(original.workFile, "utf8"), original.work); assert.equal(readFileSync(original.skillFile, "utf8"), original.skill);
    await service.retryArchive(job.id, "user", { batch_id: "old-frozen" });
    assert.ok(archived.every(snapshot => snapshot.knowledge_layout === "module-v1"));
    assert.ok(archived.flatMap(snapshot => snapshot.documents).every(document => document.path.includes(moduleId)));
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

for (const batch of [undefined, "done"] as const) test(`旧已发布任务直接归档自动整理并保留旧MR记录（${batch ?? "尚未归档"}）`, async () => {
  const root = mkdtempSync(join(tmpdir(), "readable-archive-")); const original = await legacy(root, { batch });
  const archived: DomainKnowledgeJob[] = [], closed: string[] = [];
  const service = new DomainKnowledgeExtraction(root, async () => { throw new Error("不能重新研究"); }, {
    publish: async (job, target) => { archived.push(structuredClone(job)); return receipt(job, target.id, archived.length + 2); },
    closePublication: async (_job, _target, publication) => { closed.push(publication.url!); },
  });
  try {
    const preview = service.previewArchive(original.stored.id), before = service.get(original.stored.id);
    assert.ok(preview.actions.some(action => action.id === "create-archive"));
    assert.match(preview.message, /归档时会把已发布文稿整理/);
    assert.deepEqual(service.get(before.id), before, "预览不持久化迁移");
    await assert.rejects(service.createArchive(before.id, { issue_no: "REQ-readable", expected_revisions: {} }, "user"), /正式知识版本已变化/);
    assert.deepEqual(service.get(before.id), before);
    for (const document of before.documents) assert.equal(readKnowledgeDocument(root, document.knowledge_document_id!).revision, document.published_revision);
    await service.createArchive(before.id, { issue_no: "REQ-readable", expected_revisions: preview.expected_revisions }, "user");
    const job = service.get(before.id);
    assert.equal(job.knowledge_layout, "repository-v1"); assert.equal(archived.length, 2);
    assert.ok(archived.every(snapshot => snapshot.knowledge_layout === "repository-v1"));
    assert.ok(job.documents.every(document => !document.path.includes(moduleId) && document.published_document_revision === document.revision));
    assert.deepEqual(job.turns, before.turns); assert.equal(readFileSync(original.workFile, "utf8"), original.work);
    assert.equal(closed.length, batch ? 2 : 0);
    if (batch) assert.deepEqual(job.archive_batches!.find(item => item.id === "old-frozen")!.documents, original.stored.documents);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

for (const pending of [false, true]) test(`归档不自动发布${pending ? "待确认建议" : "人工修改"}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "readable-unconfirmed-")); const original = await legacy(root, { pending });
  let archives = 0;
  const service = new DomainKnowledgeExtraction(root, async () => { throw new Error("不能重新研究"); }, { publish: async (job, target) => { archives++; return receipt(job, target.id, archives); } });
  try {
    let job = service.get(original.stored.id);
    if (!pending) job = service.edit(job.id, { document: { ...job.documents[0], content: "# 未确认人工修改" }, base_revision: 1 }, "user");
    const before = service.get(job.id), formal = readKnowledgeDocument(root, job.documents[0].knowledge_document_id!), preview = service.previewArchive(job.id);
    assert.ok(preview.actions.some(action => action.id === "review"));
    await assert.rejects(service.createArchive(job.id, { issue_no: "REQ-readable", expected_revisions: preview.expected_revisions }, "user"), /先确认并发布/);
    assert.deepEqual(service.get(job.id), before); assert.deepEqual(readKnowledgeDocument(root, formal.id), formal); assert.equal(archives, 0);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("目标已可读但旧正文路径仍有编号时继续修复，二次发布幂等，重新萃取不继承旧包装", async () => {
  const root = mkdtempSync(join(tmpdir(), "readable-dirty-layout-")); const original = await legacy(root, { dirty: true });
  const service = new DomainKnowledgeExtraction(root, async () => "重新萃取完成");
  try {
    await service.publish(original.stored.id, "user"); const job = service.get(original.stored.id);
    assert.deepEqual(job.documents.map(document => document.path), [`domains/${moduleName}/README.md`, "docs/module-map.md"]);
    await service.publish(job.id, "user"); assert.deepEqual(service.get(job.id).documents, job.documents);
    const next = await done(service, service.reextract(job.id, "user").id);
    assert.equal(next.knowledge_layout, "repository-v1"); assert.equal(next.knowledge_target.docs_path, `domains/${moduleName}`); assert.equal(next.repositories[0].docs_path, ".");
    assert.deepEqual(next.source_repositories, original.stored.source_repositories);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("直接重新萃取旧 module-v1 及新任务继承的全局编号目录都改为可读目录", async () => {
  const root = mkdtempSync(join(tmpdir(), "readable-create-layout-")); const original = await legacy(root);
  const service = new DomainKnowledgeExtraction(root, async () => "完成");
  try {
    const next = await done(service, service.reextract(original.stored.id, "user").id);
    assert.equal(next.knowledge_layout, "repository-v1"); assert.equal(next.knowledge_target.docs_path, `domains/${moduleName}`); assert.equal(next.repositories[0].docs_path, ".");
    saveKnowledgeRepoConfig(root, domain.repository, { branch: "master", docs_path: `domains/${moduleId}` });
    const global = service.create({ title: "全局知识", scope: "资料", repositories: [], issue_no: "REQ-global" }, "user");
    assert.equal(global.knowledge_target.docs_path, "domains/全局知识"); assert.equal(global.knowledge_layout, "repository-v1");
    const explicit = service.create({ module_id: moduleId, knowledge_target: { ...domain, docs_path: `teams/${moduleId}` }, issue_no: "REQ-explicit" }, "user");
    assert.equal(explicit.knowledge_target.docs_path, `teams/${moduleName}`);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

for (const explicit of [false, true]) test(`旧页面${explicit ? "传模块整理参数" : "未传布局参数"}也只生成可读目录，正常自定义仓内目录保持不变`, async () => {
  const root = mkdtempSync(join(tmpdir(), "readable-compatibility-")); const original = await legacy(root);
  const service = new DomainKnowledgeExtraction(root, async () => { throw new Error("不能重新研究"); });
  try {
    let job = service.get(original.stored.id);
    job = service.configureArchive(job.id, { base_revision: job.archive_revision ?? 0, ...(explicit ? { use_module_layout: true } : {}),
      targets: explicit ? [job.knowledge_target, ...job.repositories] : [{ ...job.repositories[0], branch: "release" }] });
    assert.equal(job.knowledge_layout, "repository-v1"); assert.equal(job.knowledge_target.docs_path, `domains/${moduleName}`);
    assert.deepEqual(job.documents.map(document => document.path), [`domains/${moduleName}/README.md`, "docs/module-map.md"]);
    job = service.configureArchive(job.id, { base_revision: job.archive_revision, use_repository_layout: true, targets: [{ ...job.repositories[0], docs_path: "custom" }] });
    await service.publish(job.id, "user");
    assert.equal(service.get(job.id).repositories[0].docs_path, "custom"); assert.equal(service.get(job.id).documents[1].path, "custom/docs/module-map.md");
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
