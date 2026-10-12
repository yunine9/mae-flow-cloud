import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CloudSession } from "../src/sessionDriver.ts";
import { runDomainKnowledge } from "../src/domainKnowledgeAgent.ts";
import { DomainKnowledgeExtraction, type DomainDocumentContent, type DomainKnowledgeJob, type DomainPublication } from "../src/domainKnowledgeExtraction.ts";
import { listKnowledgeDocuments, readKnowledgeDocument } from "../src/knowledgeDocuments.ts";

async function finished(service: DomainKnowledgeExtraction, id: string) {
  for (let i = 0; i < 600; i++) {
    const job = service.get(id);
    if (!["queued", "running"].includes(job.status)) {
      assert.equal(job.status, "done", job.error);
      await new Promise(resolve => setTimeout(resolve, 0));
      return service.get(id);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("领域研究未在 6 秒内结束");
}

function document(job: DomainKnowledgeJob, id: string) {
  const found = job.documents.find(document => document.id === id);
  assert.ok(found, `文档 ${id} 应当保留供审查`);
  return found;
}

test("#466 真实 knowledge_draft 可新增和删除未选文档，删除待人工发布，重复删除与恢复不破坏正式身份及归档证据", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-document-crud-")), repo = join(root, "repo");
  const common = { target_id: "repo-1", layer: "repository" as const, sources: "repo-1:src/transfer.ts:1-1" };
  const focus: DomainDocumentContent = { ...common, id: "focus", title: "选中的文档", path: "docs/business/重点.md", content: "# 重点规则\n\n保留该业务的规则。" };
  const unselected: DomainDocumentContent = { ...common, id: "unselected", title: "未选中的文档", path: "maintenance/未选.md", content: "# 待整理规则\n\n本任务已有的其他文档。" };
  const created: DomainDocumentContent = { ...common, id: "created", title: "新增业务入口", path: "新建未选文档.md", content: "# 新入口\n\n新增文档可以保存在当前任务目标仓的根目录。" };
  for (const entry of [focus, unselected]) { mkdirSync(dirname(join(repo, entry.path)), { recursive: true }); writeFileSync(join(repo, entry.path), entry.content); }
  mkdirSync(join(repo, "src")); writeFileSync(join(repo, "src/transfer.ts"), "export function transfer() { return 'completed'; }\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test"); git("add", "."); git("commit", "-qm", "fixture");
  const revision = git("rev-parse", "HEAD");
  let phase: "extract" | "crud" | "delete-for-publish" = "extract", readonlyChecks = 0, archiveCalls = 0;
  const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
    start: async (prompt: string) => {
      const context = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
      const call = async (name: string, args: unknown, error = false) => {
        const tool = config.extraTools.find((tool: any) => tool.name === name); assert.ok(tool, name);
        const response = await tool.execute("fixture", args, new AbortController().signal);
        assert.equal(!!response.isError, error, JSON.stringify(response));
        try { return JSON.parse(response.content[0].text); } catch { return response.content[0].text; }
      };
      if (context.step) {
        readonlyChecks++;
        const deletion = await call("knowledge_draft", { action: "read", id: unselected.id });
        assert.equal(deletion.deleted, true);
        await call("knowledge_draft", { action: "delete", id: focus.id }, true);
        await call("knowledge_draft", { action: "delete", id: unselected.id }, true);
        await call("knowledge_draft", { action: "save", document: { ...created, id: "readonly-new", path: "只读不应新增.md" } }, true);
        await call("knowledge_work_result", { summary: "只读步骤已核对删除草稿", document_ids: [focus.id, created.id] });
      } else if (phase === "extract") {
        await call("component_source", { action: "read", component_id: "repo-1", path: "src/transfer.ts" });
        for (const entry of [focus, unselected]) await call("knowledge_draft", { action: "save", document: entry });
        await call("knowledge_work_result", { summary: "业务文稿已保存", document_ids: [focus.id, unselected.id] });
      } else if (phase === "crud") {
        assert.deepEqual(context.selected_document_ids, [focus.id], "用户当前选择不限制同任务的文稿增删改");
        await call("knowledge_draft", { action: "save", document: created });
        const added = await call("knowledge_draft", { action: "read", id: created.id });
        assert.equal(added.path, created.path); assert.equal(added.content, created.content); assert.notEqual(added.deleted, true);
        const existing = await call("knowledge_draft", { action: "read", id: unselected.id });
        await call("knowledge_draft", { action: "save", document: { ...existing, content: "未选文档的修改建议" } });
        await call("knowledge_draft", { action: "delete", id: unselected.id });
        const first = await call("knowledge_draft", { action: "read", id: unselected.id });
        assert.equal(first.deleted, true); assert.equal(first.revision, 2);
        await call("knowledge_draft", { action: "delete", id: unselected.id });
        const repeated = await call("knowledge_draft", { action: "read", id: unselected.id });
        assert.deepEqual(repeated, first, "重复删除不改变文稿或追加版本");
        assert.match(await call("knowledge_draft", { action: "delete", id: "missing" }, true), /不存在/);
        await call("knowledge_work", { action: "schedule", steps: [{ id: "readonly-crud", title: "独立回读删除标记", instructions: "只读核对草稿", depends_on: [], readonly: true }] });
        await call("knowledge_work", { action: "run", id: "readonly-crud" });
        await call("knowledge_work_result", { summary: "新增和删除草稿已保存，等待人工发布", document_ids: [focus.id, created.id] });
      } else {
        await call("knowledge_draft", { action: "delete", id: unselected.id });
        await call("knowledge_work_result", { summary: "删除草稿再次准备完成", document_ids: [focus.id, created.id] });
      }
      return { status: "turn_finished" };
    }, dispose() {}, abort: async () => {}, startResume: async () => { throw new Error("已保存结果不应补充会话"); },
  }) as any);
  const service = new DomainKnowledgeExtraction(root, input => runDomainKnowledge(input, { dataDir: root,
    model: () => ({ provider: "fixture", model: "fixture", json: {} }), source: async () => ({ root: repo, revision }) }), {
    publish: async (job, target, _previous, _operator, save) => {
      archiveCalls++;
      const publication: DomainPublication = { target_id: target.id, branch: "codex/knowledge-466-before-delete", revision, state: "opened", url: "https://example.test/mr/466-crud",
        documents: job.documents.filter(document => document.selected && document.target_id === target.id).map(document => ({ id: document.id,
          path: document.path, content: document.content, revision: document.revision, knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision })) };
      save(publication); return publication;
    },
  });
  try {
    let job = await finished(service, service.create({ issue_no: "466-crud", title: "完整文档维护", scope: "当前任务的文档增删改", knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" },
      repositories: [{ name: "业务仓", repository: "https://example.test/business.git", branch: "main", docs_path: "docs/business" }] }, "expert").id);
    job = await service.publish(job.id, "expert");
    const focusId = document(job, focus.id).knowledge_document_id!, deletedId = document(job, unselected.id).knowledge_document_id!;
    const originalFormal = readKnowledgeDocument(root, deletedId);
    await service.createArchive(job.id, { issue_no: "466-crud", expected_revisions: service.previewArchive(job.id).expected_revisions }, "expert");
    job = service.get(job.id);
    const fixed = structuredClone(job.archive_batches!.find(batch => batch.publications.some(publication => publication.state === "opened"))!);
    assert.ok(fixed); assert.equal(fixed.publications[0].documents.find(document => document.id === unselected.id)!.content, unselected.content);
    phase = "crud";
    service.run(job.id, { mode: "revise", document_ids: [focus.id], message: "新增一篇根入口，并删除当前任务另一篇未选文档" }, "expert");
    job = await finished(service, job.id);
    assert.equal(readonlyChecks, 1);
    assert.equal(document(job, unselected.id).deleted, true); assert.equal(document(job, unselected.id).revision, 2);
    assert.equal(document(job, unselected.id).history.length, 1); assert.equal(document(job, unselected.id).history[0].path, unselected.path);
    assert.equal(document(job, unselected.id).history[0].content, unselected.content);
    assert.equal(job.turns.at(-1)!.proposals.some(proposal => proposal.document.id === unselected.id && proposal.status === "pending"), false, "删除清除同编号的旧待确认建议");
    assert.equal(document(job, created.id).path, created.path); assert.equal(document(job, created.id).selected, true);
    assert.deepEqual(readKnowledgeDocument(root, deletedId), originalFormal, "尚未人工发布的删除不改变正式知识");
    assert.equal(listKnowledgeDocuments(root).length, 2);
    assert.deepEqual(job.archive_batches!.find(batch => batch.id === fixed.id), fixed, "研究中的增删改不改变归档证据");
    assert.equal(git("show", `${revision}:${unselected.path}`), unselected.content); assert.equal(archiveCalls, 1);
    job = service.restore(job.id, unselected.id, 1, 2, "expert");
    assert.notEqual(document(job, unselected.id).deleted, true); assert.equal(document(job, unselected.id).revision, 3);
    assert.equal(document(job, unselected.id).knowledge_document_id, deletedId, "未正式删除前恢复草稿沿用原正式身份");
    assert.equal(document(job, unselected.id).content, unselected.content);
    phase = "delete-for-publish";
    service.run(job.id, { mode: "revise", document_ids: [focus.id], message: "删除已审查的另一篇文稿" }, "expert");
    job = await finished(service, job.id);
    assert.equal(document(job, unselected.id).revision, 4);
    job = await service.publish(job.id, "expert");
    assert.throws(() => readKnowledgeDocument(root, deletedId), /已删除/);
    assert.equal(document(job, focus.id).knowledge_document_id, focusId);
    assert.equal(listKnowledgeDocuments(root).length, 2, "正式库保留重点及新入口，删除旧文档");
    assert.deepEqual(job.archive_batches!.find(batch => batch.id === fixed.id), fixed, "正式删除仍保留旧路径的精确归档快照供后续 Git 清理");
    assert.equal(git("show", `${revision}:${unselected.path}`), unselected.content, "发布正式库删除不直接改 Git");
    assert.equal(archiveCalls, 1);
    job = service.restore(job.id, unselected.id, 3, document(job, unselected.id).revision, "expert");
    assert.notEqual(document(job, unselected.id).deleted, true); assert.equal(document(job, unselected.id).knowledge_document_id, undefined);
    assert.throws(() => readKnowledgeDocument(root, deletedId), /已删除/, "恢复草稿不会复活已删除的正式身份");
    const restarted = new DomainKnowledgeExtraction(root, async () => "unused");
    assert.equal(document(restarted.get(job.id), unselected.id).knowledge_document_id, undefined, "旧删除批次不能给恢复草稿重新绑定已删除编号");
    await restarted.shutdown();
    job = await service.publish(job.id, "expert");
    const restoredId = document(job, unselected.id).knowledge_document_id!;
    assert.ok(restoredId); assert.notEqual(restoredId, deletedId);
    assert.equal(readKnowledgeDocument(root, restoredId).content, unselected.content);
    assert.throws(() => readKnowledgeDocument(root, deletedId), /已删除/);
    assert.equal(listKnowledgeDocuments(root).length, 3);
    assert.equal(git("status", "--porcelain"), "");
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});
