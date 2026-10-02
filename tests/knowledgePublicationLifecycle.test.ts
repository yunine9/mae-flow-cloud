import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction, type DomainExecution, type DomainPublication, type DomainKnowledgeJob } from "../src/domainKnowledgeExtraction.ts";
import { listKnowledgeDocuments, listKnowledgeDocumentVersions, readKnowledgeDocument, readKnowledgeDocumentVersion, saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";

const config = { title: "订单", scope: "订单规则", issue_no: "REQ-update", repositories: [{ repository: "https://example.test/orders.git", branch: "main" }],
  knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } };
async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("等待知识操作超时");
}
function extract(input: DomainExecution) {
  input.update({ revisions: { "repo-1": "a".repeat(40) } });
  for (const id of ["orders", "refunds"]) input.save({ id, title: id, target_id: "domain", path: `domains/${id}.md`, layer: "domain", content: `${id} 原始规则`, sources: "固定源码" }, { revision: "b".repeat(40), content: null });
  return "完成";
}
const receipt = (job: DomainKnowledgeJob, targetId: string, previous?: DomainPublication): DomainPublication => ({
  target_id: targetId, state: "opened", branch: previous?.branch ?? "codex/knowledge-test", url: "https://example.test/mr/1", mr_id: 1,
  documents: job.documents.map(d => ({ id: d.id, path: d.path, content: d.content, revision: d.revision, knowledge_document_id: d.knowledge_document_id, knowledge_revision: d.published_revision })),
});

test("生产线验收14：发布先保存正式版本，归档失败及重试不撤销知识、不重复发布", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-local-publish-")); let calls = 0;
  const service = new DomainKnowledgeExtraction(dir, async input => extract(input), { publish: async (job, target, previous, _operator, save) => {
    calls++; assert.ok(readKnowledgeDocument(dir, job.documents[0].knowledge_document_id!).content);
    const publication = receipt(job, target.id, previous); save(publication);
    if (calls === 1) throw new Error("Git 暂时不可用");
    return publication;
  } });
  try {
    const job = service.create(config, "author"); await until(() => service.get(job.id).status === "done");
    const published = await service.publish(job.id, "author", { document_ids: ["orders"], expected_revisions: { orders: 1 } });
    const id = published.documents[0].knowledge_document_id!;
    assert.equal(listKnowledgeDocuments(dir).length, 1);
    const version = readKnowledgeDocument(dir, id);
    await until(() => service.get(job.id).archive_batches?.[0].state === "failed");
    assert.equal(readKnowledgeDocument(dir, id).revision, version.revision);
    await service.publish(job.id, "author", { document_ids: ["orders"] });
    assert.equal(service.get(job.id).archive_batches!.length, 1, "重按发布不追加相同批次");
    await until(() => service.get(job.id).archive_batches?.[0].state === "done");
    service.retryArchive(job.id, "author");
    assert.equal(calls, 2); assert.equal(listKnowledgeDocumentVersions(dir, id).length, 1);
    const second = await service.publish(job.id, "author", { document_ids: ["refunds"], expected_revisions: { refunds: 1 } });
    assert.equal(second.archive_batches!.length, 2); assert.equal(listKnowledgeDocuments(dir).length, 2);
    assert.equal(second.archive_batches![0].documents[0].published_revision, version.revision);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收14：正式知识发起增量研究固定身份和来源基线，人工修改使旧建议无法发布", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-incremental-"));
  const service = new DomainKnowledgeExtraction(dir, async input => {
    if (input.turn.mode === "extract") return extract(input);
    assert.equal(input.turn.previous_revisions?.["repo-1"], "a".repeat(40));
    input.update({ revisions: { "repo-1": "c".repeat(40) } });
    input.save({ ...input.read()[0], content: "增量研究的新规则" }); return "更新完成";
  });
  try {
    const job = service.create(config, "author"); await until(() => service.get(job.id).status === "done");
    const published = await service.publish(job.id, "author", { document_ids: ["orders"] });
    await until(() => service.get(job.id).archive_batches?.[0].state === "failed");
    const id = published.documents[0].knowledge_document_id!, original = readKnowledgeDocument(dir, id);
    const update = service.beginUpdate(id, { expected_revision: original.revision, message: "核对新代码" }, "researcher");
    await until(() => service.get(update.id).status === "done");
    const researched = service.get(update.id);
    service.decide(update.id, researched.turns[0].id, "orders", "accept", "reviewer");
    await service.publish(update.id, "reviewer", { expected_revisions: { orders: 2 } });
    const changed = readKnowledgeDocument(dir, id);
    assert.equal(changed.content, "增量研究的新规则"); assert.equal(listKnowledgeDocuments(dir).length, 1);
    assert.equal(changed.research_source?.source_revisions?.["repo-1"], "c".repeat(40));
    assert.equal(readKnowledgeDocumentVersion(dir, id, original.revision).document.content, original.content);
    await until(() => service.get(update.id).archive_batches?.[0].state === "failed");
    const manual = saveKnowledgeDocument(dir, { content: "专家刚补充的规则" }, "expert", id, { expectedRevision: changed.revision });
    await assert.rejects(service.publish(update.id, "reviewer"), /正式知识已有新版本/);
    assert.equal(readKnowledgeDocument(dir, id).revision, manual.revision);
    assert.equal(listKnowledgeDocumentVersions(dir, id).length, 3);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收14：服务重启接续持久归档批次，始终使用已发布快照", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-archive-resume-"));
  const initial = new DomainKnowledgeExtraction(dir, async input => extract(input)); let resumed: DomainKnowledgeExtraction | undefined;
  try {
    const job = initial.create(config, "author"); await until(() => initial.get(job.id).status === "done");
    await initial.publish(job.id, "author", { document_ids: ["orders"] });
    await until(() => initial.get(job.id).archive_batches?.[0].state === "failed"); await initial.shutdown();
    const path = join(dir, "domain-extraction", job.id, "job.json"), saved = JSON.parse(readFileSync(path, "utf8"));
    saved.archive_batches[0].state = "running"; saved.documents[0].content = "发布后新写的未发布草稿"; writeFileSync(path, JSON.stringify(saved));
    resumed = new DomainKnowledgeExtraction(dir, async () => "unused", { publish: async (snapshot, target) => {
      assert.equal(snapshot.documents[0].content, "orders 原始规则"); return receipt(snapshot, target.id);
    } });
    await until(() => resumed!.get(job.id).archive_batches?.[0].state === "done");
    assert.equal(readKnowledgeDocument(dir, saved.documents[0].knowledge_document_id).content, "orders 原始规则");
  } finally { await initial.shutdown(); await resumed?.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("同仓同分支的多目标合成一个 MR，正式知识的新研究复用该 MR", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-batch-target-")); let calls = 0;
  const service = new DomainKnowledgeExtraction(dir, async input => {
    if (input.turn.mode === "extract") {
      for (const target of [input.job.knowledge_target, ...input.job.repositories]) input.save({ id: target.id, title: target.id,
        target_id: target.id, path: `${target.docs_path}/rules.md`, layer: target.id === "domain" ? "domain" : "repository", content: "原始知识", sources: "代码" });
    } else input.save({ ...input.read()[0], content: "更新知识" });
    return "完成";
  }, { publish: async (job, target, previous) => {
    calls++;
    if (calls === 1) assert.equal(job.documents.length, 2, "逻辑目标不同但归档仓分支相同，应合成一批");
    else assert.equal(previous?.url, "https://example.test/mr/1", "新研究沿用同一正式知识的开放 MR");
    return receipt(job, target.id, previous);
  } });
  try {
    const { knowledge_target: _, ...initial } = config;
    const created = service.create(initial, "author"); await until(() => service.get(created.id).status === "done");
    let job = service.get(created.id);
    job = service.configureArchive(job.id, { base_revision: 0, targets: [job.knowledge_target, ...job.repositories].map(t => ({ ...t, repository: config.knowledge_target.repository, branch: "main" })) });
    await service.publish(job.id, "author"); await until(() => service.get(job.id).archive_batches?.[0].state === "done");
    assert.equal(calls, 1); assert.equal(service.get(job.id).publications.length, 1);
    const formal = readKnowledgeDocument(dir, service.get(job.id).documents[0].knowledge_document_id!);
    const update = service.beginUpdate(formal.id, { expected_revision: formal.revision }, "author");
    await until(() => service.get(update.id).status === "done");
    const turn = service.get(update.id).turns[0]; service.decide(update.id, turn.id, "domain", "accept", "author");
    await service.publish(update.id, "author"); await until(() => service.get(update.id).archive_batches?.[0].state === "done");
    assert.equal(calls, 2); assert.equal(listKnowledgeDocuments(dir).length, 2);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("不同仓同路径分批发布保留独立正式身份，同仓同路径同批发布先拒绝冲突", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-path-identity-"));
  let service = new DomainKnowledgeExtraction(dir, async input => {
    for (const target of input.job.repositories) input.save({ id: target.id, title: target.name, target_id: target.id,
      path: "docs/rules.md", layer: "repository", content: "相同正文也属于不同仓库", sources: target.repository }, { content: null, revision: "a".repeat(40) });
    return "完成";
  });
  try {
    const job = service.create({ ...config, repositories: [
      { repository: "https://example.test/a.git", branch: "main", docs_path: "docs" },
      { repository: "https://example.test/b.git", branch: "main", docs_path: "docs" },
    ] }, "author");
    await until(() => { const current = service.get(job.id); assert.notEqual(current.status, "failed", current.error); return current.status === "done"; });
    await service.publish(job.id, "author", { document_ids: ["repo-1"] });
    await until(() => service.get(job.id).archive_batches?.[0].state === "failed");
    const second = await service.publish(job.id, "author", { document_ids: ["repo-2"] });
    const documents = second.documents.map(d => readKnowledgeDocument(dir, d.knowledge_document_id!));
    assert.notEqual(documents[0].id, documents[1].id);
    assert.deepEqual(documents.map(d => d.archive_target?.repository), ["https://example.test/a.git", "https://example.test/b.git"]);
    assert.deepEqual(documents.map(d => d.research_source?.document_id), ["repo-1", "repo-2"]);

    const collision = service.create({ ...config, repositories: [
      { repository: "https://example.test/c.git", branch: "main", docs_path: "docs" },
      { repository: "https://example.test/d.git", branch: "main", docs_path: "docs" },
    ] }, "author");
    await until(() => service.get(collision.id).status === "done");
    const current = service.get(collision.id);
    assert.throws(() => service.configureArchive(collision.id, { base_revision: 0, targets: [current.knowledge_target,
      ...current.repositories.map(t => ({ ...t, repository: "https://example.test/shared.git" }))] }), /同一个目标文件/);
    // 历史持久记录也必须在发布时校验，不能只依赖当前配置表单。
    await service.shutdown();
    const file = join(dir, "domain-extraction", collision.id, "job.json"), saved = JSON.parse(readFileSync(file, "utf8"));
    for (const target of saved.repositories) target.repository = "https://example.test/shared.git";
    writeFileSync(file, JSON.stringify(saved));
    service = new DomainKnowledgeExtraction(dir, async () => "unused");
    await assert.rejects(service.publish(collision.id, "author"), /同一归档仓和分支/);
    assert.equal(listKnowledgeDocuments(dir).length, 2, "批次碰撞须在保存任一正式知识前拒绝");
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("旧归档失败后新版已归档，重试旧批次跳过过时正文并保留仍有效的项", async () => {
  for (const partial of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-obsolete-archive-"));
    let calls = 0; const remote = new Map<string, string>();
    const service = new DomainKnowledgeExtraction(dir, async input => {
      if (input.turn.mode === "extract") return extract(input);
      input.save({ ...input.read()[0], content: "orders 新正式版本" }); return "完成";
    }, { publish: async (job, target, previous, _operator, save) => {
      calls++;
      if (calls === 3) assert.deepEqual(job.documents.map(d => d.id), ["refunds"], "部分过时批次只归档仍为正式版的项");
      for (const doc of job.documents) remote.set(doc.knowledge_document_id!, doc.content);
      const publication = receipt(job, target.id, previous); save(publication);
      if (calls === 1) throw new Error("MR 回执失败");
      return publication;
    } });
    try {
      const initial = service.create(config, "author"); await until(() => service.get(initial.id).status === "done");
      const v1 = await service.publish(initial.id, "author", { document_ids: partial ? ["orders", "refunds"] : ["orders"] });
      await until(() => service.get(initial.id).archive_batches?.[0].state === "failed");
      const id = v1.documents[0].knowledge_document_id!;
      const update = service.beginUpdate(id, {}, "author"); await until(() => service.get(update.id).status === "done");
      service.decide(update.id, service.get(update.id).turns[0].id, "orders", "accept", "author");
      await service.publish(update.id, "author"); await until(() => service.get(update.id).archive_batches?.[0].state === "done");
      assert.equal(remote.get(id), "orders 新正式版本");
      service.retryArchive(initial.id, "author");
      await until(() => service.get(initial.id).archive_batches?.[0].state === (partial ? "done" : "superseded"));
      const old = service.get(initial.id).archive_batches![0];
      assert.equal(calls, partial ? 3 : 2, "全批过时不能再次调用 Git 发布");
      assert.equal(remote.get(id), "orders 新正式版本", "旧重试不能让开放 MR 回退正文");
      assert.equal(old.superseded_documents?.[0].knowledge_document_id, id);
      assert.equal(old.superseded_documents?.[0].current_revision, readKnowledgeDocument(dir, id).revision);
    } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test("仓内知识改到其他仓归档后，正式适用范围仍归属原业务源码仓", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-source-scope-"));
  const original = "https://example.test/business-a.git", archive = "https://example.test/archive-b.git";
  const service = new DomainKnowledgeExtraction(dir, async input => {
    const repository = input.job.repositories[0];
    input.save({ id: "repository-rules", title: "仓内规则", target_id: repository.id,
      path: `${repository.docs_path}/rules.md`, layer: "repository", content: "业务仓 A 的调用规则", sources: original });
    return "完成";
  });
  try {
    const created = service.create({ title: "业务规则", scope: "业务仓 A 的实现约定", issue_no: "REQ-scope",
      repositories: [{ repository: original, branch: "main", docs_path: "docs" }] }, "author");
    await until(() => service.get(created.id).status === "done");
    const initial = service.get(created.id);
    const configured = service.configureArchive(created.id, { base_revision: 0,
      targets: [{ ...initial.repositories[0], repository: archive, branch: "knowledge", docs_path: "docs/business-a" }] });
    assert.equal(configured.source_repositories?.[0].repository, original);
    const published = await service.publish(created.id, "author");
    const formal = readKnowledgeDocument(dir, published.documents[0].knowledge_document_id!);
    assert.equal(formal.scope, "repository");
    assert.deepEqual(formal.repositories, [original]);
    assert.deepEqual(formal.archive_target, { repository: archive, branch: "knowledge", path: "docs/business-a/rules.md" });
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
