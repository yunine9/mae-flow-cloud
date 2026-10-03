import assert from "node:assert/strict";
import { test } from "node:test";
import fs, { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { listKnowledgeDocuments, listKnowledgeDocumentVersions } from "../src/knowledgeDocuments.ts";
import { createBusinessModule, updateBusinessModule } from "../src/businessModuleLibrary.ts";
import type { DomainKnowledgeJob, DomainPublication } from "../src/domainKnowledgeTypes.ts";

async function within<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

// repros/r2 实测：模块状态须在首篇写入前统一校验，不能先写仓内篇再拒绝领域篇。
test("生产线验收4：跨文档发布遇到停用模块，预检失败且全部正式知识不生效", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-publish-precheck-"));
  createBusinessModule(dir, { id: "orders", name: "订单", description: "订单域", owner: "alice", repositories: ["https://example.test/orders.git"] }, "admin");
  let archiveCalls = 0;
  const service = new DomainKnowledgeExtraction(dir, async input => {
    const repo = input.job.repositories[0];
    input.save({ id: "repo-doc", title: "仓内", target_id: repo.id, path: `${repo.docs_path}/repo.md`, layer: "repository", content: "仓内规则", sources: "源码" }, { revision: "b".repeat(40), content: null });
    input.save({ id: "domain-doc", title: "领域", target_id: "domain", path: "domains/domain.md", layer: "domain", content: "领域规则", sources: "源码" }, { revision: "b".repeat(40), content: null });
    return "完成";
  }, { publish: async (_job, target) => { archiveCalls++; return { target_id: target.id, branch: "b", state: "opened", documents: [] }; } });
  try {
    const job = service.create({ issue_no: "REQ-1", module_id: "orders", knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } }, "alice");
    await until(() => service.get(job.id).status === "done", "本地研究未在5秒内完成");
    assert.deepEqual(service.get(job.id).documents.map(doc => doc.id), ["repo-doc", "domain-doc"]);
    updateBusinessModule(dir, "orders", { status: "archived" }, "admin");
    const path = join(dir, "domain-extraction", job.id, "job.json"), before = readFileSync(path, "utf8");
    await assert.rejects(service.publish(job.id, "alice"), /所选业务模块已停用/);
    assert.deepEqual(listKnowledgeDocuments(dir), []);
    assert.equal(readFileSync(path, "utf8"), before);
    assert.ok(service.get(job.id).documents.every(doc => doc.knowledge_document_id === undefined));
    assert.equal(service.get(job.id).archive_batches, undefined);
    assert.equal(archiveCalls, 0);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收4/F6：全部预检通过后第二篇正式 rename 遇到 EIO，已生效第一篇落盘且仅可人工归档", { timeout: 20_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-partial-publish-"));
  const seen: DomainPublication["documents"][] = [];
  let indexed = 0;
  let release!: () => void, restarted: DomainKnowledgeExtraction | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = new DomainKnowledgeExtraction(dir, async input => {
    for (const id of ["one", "two"]) input.save({ id, title: id === "one" ? "第一篇领域规则" : "第二篇领域规则", target_id: "domain", path: `domains/${id}.md`, layer: "domain", content: `# ${id}\r\n有效规则正文`, sources: "固定版本源码" }, { revision: "a".repeat(40), content: null });
    return "研究完成";
  }, {
    onIndexed: () => { indexed++; },
    publish: async (job, target) => {
      const documents: DomainPublication["documents"] = job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision, knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision }));
      seen.push(documents);
      await within(gate, 5000, "测试归档阻塞超过5秒预算");
      return { target_id: target.id, branch: "codex/partial-io", state: "opened", url: "https://example.test/mr/1", mr_id: 1, documents };
    },
  });
  try {
    const job = service.create({ title: "订单域", scope: "核对订单规则", issue_no: "REQ-PARTIAL", issue_description: "订单领域知识归档", repositories: [], knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } }, "alice");
    await until(() => service.get(job.id).status === "done", "测试研究未在5秒内完成");
    const rename = fs.renameSync;
    let formalRenames = 0;
    // 只在真正写正式主记录时注入故障，版本文件与 job.json 都照常耐久写。
    const intercepted = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (/[\\/]knowledge-documents[\\/]kd-[a-f0-9-]{36}\.json$/.test(String(args[1])) && ++formalRenames === 2) {
        throw Object.assign(new Error("测试磁盘 EIO：第二篇正式记录未写成"), { code: "EIO" });
      }
      return rename(...args);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(service.publish(job.id, "alice"), (error: any) => error?.code === "EIO");
    } finally { intercepted.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(formalRenames, 2, "故障必须发生在预检已通过后的第二次正式写入");
    assert.equal(indexed, 1, "部分发布成功的第一篇也必须更新既有知识索引");
    const formal = listKnowledgeDocuments(dir);
    assert.equal(formal.length, 1); assert.equal(formal[0].research_source?.document_id, "one");
    const disk = JSON.parse(readFileSync(join(dir, "domain-extraction", job.id, "job.json"), "utf8")) as DomainKnowledgeJob;
    const first = disk.documents.find(document => document.id === "one")!, second = disk.documents.find(document => document.id === "two")!;
    assert.equal(first.knowledge_document_id, formal[0].id, "第一篇已生效的正式编号必须落盘");
    assert.equal(first.published_revision, formal[0].revision, "第一篇已生效的正式版本必须落盘");
    assert.equal(first.content, formal[0].content, "换行归一化后研究、正式库与归档必须保持同一正文");
    assert.ok(!formal[0].content.includes("\r"));
    assert.equal(second.knowledge_document_id, undefined, "第二篇未写成，不能显示已发布");
    assert.equal(second.published_revision, undefined);
    const pending = disk.archive_batches?.filter(batch => ["pending", "running"].includes(batch.state)) ?? [];
    assert.ok(pending.some(batch => batch.documents.some(document => document.knowledge_document_id === formal[0].id && document.published_revision === formal[0].revision)), "第一篇必须关联精确版本的待归档批次");
    const failed = disk.archive_batches?.flatMap(batch => batch.documents).find(document => document.id === "two");
    if (failed?.knowledge_document_id) assert.equal(existsSync(join(dir, "knowledge-documents", `${failed.knowledge_document_id}.json`)), false);
    assert.equal(seen.length, 0, "部分平台发布失败也不能自动归档");
    const preview = service.previewArchive(job.id);
    const archiving = service.createArchive(job.id, { issue_no: "REQ-PARTIAL", expected_revisions: preview.expected_revisions }, "alice");
    await until(() => seen.length === 1, "人工归档没有在5秒预算内开始");
    assert.deepEqual(seen[0].map(document => [document.id, document.knowledge_document_id, document.knowledge_revision, document.content]), [["one", formal[0].id, formal[0].revision, formal[0].content]], "归档只能使用实际写成的第一篇");
    const versions = listKnowledgeDocumentVersions(dir, formal[0].id).map(version => version.document.revision);
    assert.deepEqual(versions, [formal[0].revision]);

    release();
    await within(archiving, 5000, "人工归档未在5秒预算内完成");
    const manual = service.get(job.id).archive_batches!.find(batch => !!batch.issue_no)!;
    await assert.doesNotReject(service.retryArchive(job.id, "alice", { batch_id: manual.id }), "归档完成后必须释放本任务的操作锁");
    await within(service.shutdown(), 5000, "原管理器未在5秒内关停");
    let repeated = 0;
    restarted = new DomainKnowledgeExtraction(dir, async () => { repeated++; throw new Error("重启不应重新研究"); }, { publish: async () => { repeated++; throw new Error("已归档版本不应重复归档"); } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(repeated, 0);
    assert.equal(restarted.get(job.id).documents.find(document => document.id === "two")!.published_revision, undefined);
    assert.deepEqual(listKnowledgeDocuments(dir), formal, "重启不能自动补写第二篇或丢失第一篇");
    assert.deepEqual(listKnowledgeDocumentVersions(dir, formal[0].id).map(version => version.document.revision), versions, "重启不能生成重复正式版本");
  } finally {
    release();
    await within(service.shutdown(), 5000, "测试清理期间原管理器未关停");
    if (restarted) await within(restarted.shutdown(), 5000, "测试清理期间重启管理器未关停");
    rmSync(dir, { recursive: true, force: true });
  }
});
