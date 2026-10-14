import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DomainKnowledgeExtraction, type DomainKnowledgeJob } from "../src/domainKnowledgeExtraction.ts";
import { assertModuleKnowledgePath, repositoryKnowledgeDirectory, repositoryKnowledgePath } from "../src/domainKnowledgeLayout.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { readKnowledgeDocument } from "../src/knowledgeDocuments.ts";

const source = { repository: "https://example.test/FMProductFrontendService.git", name: "FMProductFrontendService", branch: "master", docs_path: "docs" };
const domain = { repository: "https://example.test/knowledge.git", branch: "master", docs_path: "领域资料" };
async function done(service: DomainKnowledgeExtraction, id: string) {
  for (let i = 0; i < 200; i++) { const job = service.get(id); if (job.status === "done") return job; if (job.status === "failed") throw new Error(job.error); await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("研究未完成");
}

test("仓内相对路径只去已知模块包装和准确仓名前缀，不折叠真实 docs 结构", () => {
  assert.equal(repositoryKnowledgeDirectory("无线/产品管理"), "无线-产品管理");
  assert.equal(repositoryKnowledgePath("docs/knowledge/module-uuid", ".", "docs/knowledge/module-uuid/FMProductFrontendService/docs/module-map.md", [source.name], true), "docs/module-map.md");
  assert.equal(repositoryKnowledgePath("docs", ".", "docs/module-map.md", [source.name]), "docs/module-map.md");
  assert.equal(repositoryKnowledgePath("docs", ".", "OtherService/docs/module-map.md", [source.name]), "OtherService/docs/module-map.md");
  assert.equal(repositoryKnowledgePath("domain", "domain", "domain/domain/a.md", [], true), "domain/domain/a.md");
  assert.equal(repositoryKnowledgePath("A", "B", "A/B/a.md", [], true), "B/B/a.md");
  assert.equal(repositoryKnowledgePath("docs/knowledge/orders", "docs", "docs/knowledge/orders/FMProductFrontendService/docs/a.md", [source.name], true), "docs/a.md");
  assert.equal(repositoryKnowledgePath("archive", ".", "archive/docs/module-map.md", [], true), "docs/module-map.md");
  assert.equal(repositoryKnowledgePath("archive", "new", "archive/docs/module-map.md", [], true), "new/docs/module-map.md");
  assert.equal(repositoryKnowledgePath("docs", ".", "README.md"), "README.md");
  assert.equal(repositoryKnowledgePath("docs", ".", "AGENTS.md"), "docs/README.md");
  assert.equal(repositoryKnowledgePath("docs", ".", "docs/AGENTS.md"), "docs/index.md");
  const job = { knowledge_layout: "repository-v1" as const };
  assertModuleKnowledgePath(job, { docs_path: "." }, "README.md");
  assertModuleKnowledgePath(job, { docs_path: "." }, "docs/module-map.md");
  assert.throws(() => assertModuleKnowledgePath(job, { docs_path: "." }, "docs/../secret.md"), /相对路径/);
  assert.throws(() => assertModuleKnowledgePath(job, { docs_path: "." }, "AGENTS.md"), /不生成 AGENTS/);
});

test("新模块使用可读领域目录和仓根相对文稿，同仓多模块按文件避让且保留归属", async () => {
  const root = mkdtempSync(join(tmpdir(), "repository-layout-new-"));
  const service = new DomainKnowledgeExtraction(root, async input => {
    input.save({ id: "entry", title: "入口", target_id: "repo-1", path: "docs/README.md", layer: "repository", content: `# ${input.job.title}`, sources: "源码" });
    return "完成";
  });
  try {
    const jobs: DomainKnowledgeJob[] = [];
    for (const [id, name] of [["orders", "订单管理"], ["shipping", "配送管理"]]) {
      createBusinessModule(root, { id, name, description: name, owner: "user", repositories: [source.repository] }, "user");
      let job = await done(service, service.create({ module_id: id, issue_no: `REQ-${id}` }, "user").id);
      assert.equal(job.knowledge_layout, "repository-v1"); assert.equal(job.repositories[0].docs_path, "."); assert.equal(job.knowledge_target.docs_path, name);
      await service.publish(job.id, "user"); job = service.get(job.id); jobs.push(job);
      assert.deepEqual(readKnowledgeDocument(root, job.documents[0].knowledge_document_id!).module_ids, [id]);
    }
    assert.equal(jobs[0].documents[0].path, "docs/README.md");
    assert.equal(jobs[1].documents[0].path, "docs/README-entry.md");
    const before = jobs[1].documents[0].revision;
    await service.publish(jobs[1].id, "user");
    assert.equal(service.get(jobs[1].id).documents[0].revision, before, "原正式位置可复用，不重复迁移或加后缀");
    let current = service.get(jobs[1].id);
    current = service.configureArchive(current.id, { base_revision: current.archive_revision, use_repository_layout: true,
      targets: [current.repositories[0]], documents: [{ id: "entry", path: "FMProductFrontendService/docs/custom.md" }] });
    await service.publish(current.id, "user");
    assert.equal(service.get(current.id).documents[0].path, "FMProductFrontendService/docs/custom.md", "已选的合法真实目录不再当工作区前缀剥离");
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("已完成旧稿整理为仓内路径，保留工作记录与正式ID并冻结旧批次布局", async () => {
  const root = mkdtempSync(join(tmpdir(), "repository-layout-migrate-"));
  let executions = 0;
  let service = new DomainKnowledgeExtraction(root, async input => {
    executions++;
    input.save({ id: "map", title: "功能索引", target_id: "repo-1", path: "docs/knowledge/orders/FMProductFrontendService/docs/module-map.md", layer: "repository", content: "# 功能索引\n[规则](rules.md)", sources: "源码" });
    input.save({ id: "rules", title: "规则", target_id: "repo-1", path: "docs/knowledge/orders/FMProductFrontendService/docs/rules.md", layer: "repository", content: "# 规则\n[索引](module-map.md)", sources: "源码" });
    input.save({ id: "readme", title: "原项目说明", target_id: "repo-1", path: "README.md", layer: "repository", content: "# 原说明", sources: "源码" });
    input.save({ id: "domain", title: "领域", target_id: "domain", path: "domain-docs/orders/README.md", layer: "domain", content: "# 领域", sources: "源码" });
    return "完成";
  });
  try {
    createBusinessModule(root, { id: "orders", name: "订单管理", description: "订单管理", owner: "user", repositories: [source.repository] }, "user");
    let job = await done(service, service.create({ title: "旧任务", scope: "订单", issue_no: "REQ-old", repositories: [source], knowledge_target: domain }, "user").id);
    await service.publish(job.id, "user"); job = service.get(job.id); await service.shutdown();
    const file = join(root, "domain-extraction", job.id, "job.json"), stored: DomainKnowledgeJob = JSON.parse(readFileSync(file, "utf8"));
    stored.module_id = "orders"; stored.knowledge_layout = "module-v1"; stored.repositories[0].docs_path = "docs/knowledge/orders"; stored.knowledge_target.docs_path = "domain-docs/orders";
    const frozen = { id: "old-batch", state: "failed" as const, created_at: new Date().toISOString(), operator: "user", knowledge_layout: "module-v1" as const,
      issue_no: "REQ-old", documents: structuredClone(stored.documents), targets: structuredClone([stored.knowledge_target, ...stored.repositories]), publications: [] };
    (stored.archive_batches ??= []).push(frozen); writeFileSync(file, JSON.stringify(stored));
    const work = join(root, "domain-extraction", job.id, "skill-runs", job.turns[0].id); mkdirSync(work, { recursive: true });
    writeFileSync(join(work, "work.json"), '{"steps":[{"id":"completed-research","status":"done"}]}');
    const bytes = readFileSync(join(work, "work.json"), "utf8"), ids = stored.documents.map(doc => doc.knowledge_document_id);
    service = new DomainKnowledgeExtraction(root, async () => { throw new Error("目录整理不研究"); });
    job = service.configureArchive(job.id, { base_revision: 0, use_repository_layout: true,
      targets: [{ ...stored.knowledge_target, docs_path: "团队知识/订单" }, { ...stored.repositories[0], docs_path: "." }] });
    assert.equal(job.knowledge_layout, "repository-v1");
    assert.deepEqual(job.documents.map(doc => doc.path), ["docs/module-map.md", "docs/rules.md", "README.md", "团队知识/订单/README.md"]);
    assert.equal(job.status, "done"); assert.equal(job.turns.length, stored.turns.length); assert.equal(executions, 1);
    assert.equal(readFileSync(join(work, "work.json"), "utf8"), bytes); assert.deepEqual(job.archive_batches!.find(batch => batch.id === frozen.id), frozen);
    await service.publish(job.id, "user"); job = service.get(job.id);
    assert.deepEqual(job.documents.map(doc => doc.knowledge_document_id), ids);
    assert.ok(job.documents.every(doc => readKnowledgeDocument(root, doc.knowledge_document_id!).module_ids.includes("orders")));
    job = service.configureArchive(job.id, { base_revision: job.archive_revision, use_repository_layout: true, targets: [{ ...job.repositories[0], docs_path: "archive" }] });
    assert.equal(job.documents[0].path, "archive/docs/module-map.md");
    job = service.configureArchive(job.id, { base_revision: job.archive_revision, use_repository_layout: true, targets: [{ ...job.repositories[0], docs_path: "." }] });
    assert.equal(job.documents[0].path, "docs/module-map.md");
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
