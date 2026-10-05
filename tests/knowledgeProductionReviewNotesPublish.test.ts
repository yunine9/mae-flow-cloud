import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ComponentResearch } from "../src/componentResearch.ts";
import { saveComponentRepository } from "../src/componentRepositories.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { listKnowledgeDocuments, readKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import {
  applyKnowledgeReviewNotes,
  listKnowledgeReviewNotes,
  resolveKnowledgeReviewNotes,
  saveKnowledgeReviewNote,
  type KnowledgeReviewSources,
} from "../src/knowledgeReviewNotes.ts";
import { componentPublishInput } from "./fixtures/componentPublish.ts";
import { componentPublicationExecute } from "./fixtures/componentPublicationWorker.ts";

type Kind = "domain" | "component";
async function within<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
/** B5：修改意见与发布的关系（领域、组件同一口径）。 */
async function fixture(kind: Kind) {
  const dataDir = mkdtempSync(join(tmpdir(), "knowledge-opinion-barrier-"));
  const domain = new DomainKnowledgeExtraction(dataDir, async input => {
    if (input.turn.mode === "extract") {
      for (const id of ["rules", "api"]) input.save({ id, title: `订单 ${id}`, target_id: "domain", path: `domains/${id}.md`, layer: "domain",
        content: `# ${id}\n当前规则与失败边界。`, sources: "src/orders.ts:1 @ 测试固定版本" }, { content: null, revision: "a".repeat(40) });
    } else {
      for (const document of input.read().filter(document => input.turn.document_ids.includes(document.id))) input.save({ ...document,
        content: `${document.content}\n已核对意见：${input.turn.message}` });
    }
    return "文稿已保存";
  });
  const component = new ComponentResearch(dataDir, componentPublicationExecute);
  const sources: KnowledgeReviewSources = { dataDir, domain, component };
  const cleanup = async () => {
    await within(Promise.all([domain.shutdown(), component.shutdown()]), 2_000, "意见测试管理器关停超过2秒预算");
    rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    let jobId: string, selectedId: string, otherId: string;
    if (kind === "domain") {
      const job = domain.create({ title: "订单意见发布", scope: "订单规则", issue_no: "REQ-opinion", repositories: [],
        knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } }, "alice");
      jobId = job.id; selectedId = "rules"; otherId = "api";
      await until(() => domain.get(jobId).status === "done", "领域意见测试草稿未在3秒内完成");
      domain.select(jobId, [otherId], false);
    } else {
      saveComponentRepository(dataDir, { name: "文件组件", repository: "https://example.test/component.git", branch: "main", path: "src", languages: ["cpp"] }, "alice");
      const job = component.start({ mode: "all", language: "cpp", topic: "组件意见发布" }, "alice");
      jobId = job.id; selectedId = "cap-0"; otherId = "cap-1";
      await until(() => component.get(jobId).status === "done", "组件意见测试草稿未在3秒内完成");
      component.selectSections(jobId, [otherId, "cap-2"], false);
    }
    const documents = () => kind === "domain" ? domain.get(jobId).documents : component.get(jobId).document!.sections;
    const select = (ids: string[], selected: boolean) => kind === "domain" ? domain.select(jobId, ids, selected) : component.selectSections(jobId, ids, selected);
    const saveNote = (documentId: string) => saveKnowledgeReviewNote(sources, kind, jobId,
      { document_id: documentId, scope: "document", note: `请补充 ${documentId} 的失败边界` }, "reviewer").notes.at(-1)!;
    const submitAndConfirm = async (noteId: string, documentId: string) => {
      const submitted = applyKnowledgeReviewNotes(sources, kind, jobId, { note_ids: [noteId] }, "reviewer");
      assert.equal(submitted.notes.find(note => note.id === noteId)!.status, "submitted");
      assert.ok(submitted.turn_id, "意见须绑定真实研究轮次");
      await until(() => (kind === "domain" ? domain.get(jobId) : component.get(jobId)).status === "done", "意见修订未在3秒内完成");
      if (kind === "domain") domain.decide(jobId, submitted.turn_id!, documentId, "accept", "reviewer");
      else component.decideProposal(jobId, submitted.turn_id!, "accept", "reviewer");
      assert.equal(listKnowledgeReviewNotes(sources, kind, jobId).notes.find(note => note.id === noteId)!.status, "submitted",
        "确认正文建议不会冒充人工已处理意见");
    };
    const publish = async () => {
      if (kind === "domain") {
        const current = domain.get(jobId), selected = current.documents.filter(document => document.selected);
        await domain.publish(jobId, "reviewer", { document_ids: selected.map(document => document.id),
          expected_revisions: Object.fromEntries(selected.map(document => [document.id, document.revision])) });
      } else component.publish(jobId, componentPublishInput(component.get(jobId), { scope: "platform" }), "reviewer");
      return listKnowledgeDocuments(dataDir);
    };
    return { dataDir, sources, jobId, selectedId, otherId, documents, select, saveNote, submitAndConfirm, publish, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

// 2026-10-05 用户"一定要搞简单" + CLAUDE.md"质量缺失如实提示、不阻断"：意见是给人的提示，
// 不是发布闸门。未处理意见不拦发布，发布也不替人处理、吞掉意见。
for (const kind of ["domain", "component"] as const) {
  for (const status of ["open", "submitted"] as const) {
    test(`B5验收3/生产线验收11/14：${kind} 选中稿有 ${status} 意见时照常发布，意见保持原状`, { timeout: 15_000 }, async () => {
      const f = await fixture(kind);
      try {
        const note = f.saveNote(f.selectedId);
        if (status === "submitted") await f.submitAndConfirm(note.id, f.selectedId);
        const formal = await f.publish();
        assert.equal(formal.length, 1);
        assert.equal(readKnowledgeDocument(f.dataDir, formal[0].id).revision, formal[0].revision);
        assert.match(formal[0].content, kind === "domain" ? /当前规则与失败边界/ : /能力 0 的边界与失败处理/);
        if (status === "submitted") assert.match(formal[0].content, kind === "domain" ? /已核对意见：/ : /本轮修订：/,
          "已明确确认的修订确实进入正式正文");
        assert.equal(listKnowledgeReviewNotes(f.sources, kind, f.jobId).notes.find(current => current.id === note.id)!.status, status,
          "发布不替人处理意见");
        const resolved = resolveKnowledgeReviewNotes(f.sources, kind, f.jobId, { note_ids: [note.id] }, "reviewer");
        assert.equal(resolved.notes[0].status, "resolved", "发布后仍可由人标为已处理");
      } finally { await f.cleanup(); }
    });

    test(`B5验收3/生产线验收11/14：${kind} 未选稿的 ${status} 意见与正文保留`, { timeout: 15_000 }, async () => {
      const f = await fixture(kind);
      try {
        const note = f.saveNote(f.otherId);
        if (status === "submitted") await f.submitAndConfirm(note.id, f.otherId);
        const other = structuredClone(f.documents().find(document => document.id === f.otherId)!);
        assert.equal(other.selected, false);
        const formal = await f.publish();
        assert.equal(formal.length, 1);
        assert.doesNotMatch(formal[0].content, kind === "domain" ? /# api/ : /能力 1 的边界与失败处理/);
        assert.deepEqual(f.documents().find(document => document.id === f.otherId), other);
        assert.equal(listKnowledgeReviewNotes(f.sources, kind, f.jobId).notes.find(current => current.id === note.id)!.status, status,
          "发布别的稿不能处理或吞掉未选稿的意见");
      } finally { await f.cleanup(); }
    });
  }
}
