import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyKnowledgeReviewNotes, listKnowledgeReviewNotes, resolveKnowledgeReviewNotes, saveKnowledgeReviewNote, type KnowledgeReviewSources } from "../src/knowledgeReviewNotes.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { uploadHostSkill } from "../src/hostSkillLibrary.ts";
import { createBusinessModule, publishBusinessKnowledgeAsset } from "../src/businessModuleLibrary.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import type { ResearchRecord } from "../src/componentResearch.ts";

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "knowledge-review-notes-"));
  const domainJob = { id: "dkx-1", documents: [{ id: "rules", title: "业务规则", content: "第一行\n第二行", revision: 3 }, { id: "api", title: "接口规则", content: "正文", revision: 2 }], turns: [] } as unknown as DomainKnowledgeJob;
  const componentJob = { id: "cr-1", document: { overview: "总览", sections: [{ id: "pool", title: "连接池", content: "第一行\n第二行", revision: 4 }, { id: "cache", title: "缓存", revision: 1 }] }, review_turns: [] } as unknown as ResearchRecord;
  const calls: Array<{ kind: string; input: unknown; operator: string }> = [];
  const sources: KnowledgeReviewSources = { dataDir,
    domain: { get: () => structuredClone(domainJob), run: (_id, input, operator) => {
      calls.push({ kind: "domain", input, operator });
      domainJob.turns.push({ id: "turn-domain", mode: "revise", document_ids: input.document_ids!, message: input.message!, operator, created_at: new Date().toISOString(), status: "queued", proposals: [] });
      return structuredClone(domainJob);
    } },
    component: { get: () => structuredClone(componentJob), review: (_id, input, operator) => {
      calls.push({ kind: "component", input, operator });
      componentJob.review_turns!.push({ ...input, id: "turn-component", operator, created_at: new Date().toISOString(), status: "queued" });
      return structuredClone(componentJob);
    } },
  };
  return { dataDir, sources, domainJob, componentJob, calls, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

test("批注按文稿持久化并保留选中位置，不要求版本；非法路径不能写入", () => {
  const f = fixture();
  try {
    const result = saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: "rules", scope: "line", line: 2, line_end: 2, quote: "第二行", context_before: "第一行", note: "补充失败处理" }, "alice");
    assert.equal(result.notes[0].status, "open");
    assert.equal(result.notes[0].operator, "alice");
    assert.equal(result.notes[0].document_title, "业务规则");
    assert.deepEqual(listKnowledgeReviewNotes({ ...f.sources }, "domain", "dkx-1"), JSON.parse(JSON.stringify(result)));
    assert.throws(() => listKnowledgeReviewNotes(f.sources, "domain", "../dkx-1"), /编号无效/);
    assert.equal(listKnowledgeReviewNotes(f.sources, "domain", "dkx-1").notes.length, 1);
  } finally { f.cleanup(); }
});

test("文稿更新后仍把所选意见交给原领域修订入口，并记录该轮；不能重复提交", () => {
  const f = fixture();
  try {
    saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: "rules", scope: "document", note: "补充失败处理" }, "alice");
    const notes = saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: "api", scope: "document", note: "增加示例" }, "bob").notes;
    f.domainJob.documents[0].revision = 4; f.domainJob.documents[0].content = "已调整后的正文";
    const result = applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [notes[0].id] }, "reviewer");
    assert.equal(result.notes[0].status, "submitted");
    assert.equal(result.notes[1].status, "open");
    assert.equal(result.turn_id, "turn-domain");
    assert.equal(result.notes[0].submitted_by, "reviewer");
    const input = f.calls[0].input as { mode: string; document_ids: string[]; message: string };
    assert.equal(input.mode, "revise");
    assert.deepEqual(input.document_ids, ["rules"]);
    assert.match(input.message, /补充失败处理/);
    assert.match(input.message, /核对最新正文/);
    assert.doesNotMatch(input.message, /草稿版本/);
    assert.doesNotMatch(input.message, /增加示例/);
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [notes[0].id] }, "reviewer"), /已经提交/);
    assert.equal(f.calls.length, 1);
  } finally { f.cleanup(); }
});

test("文稿删除或原修订入口拒绝时保留未处理意见，不假装成功", () => {
  const f = fixture();
  try {
    const { notes } = saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: "rules", scope: "document", note: "补充边界" }, "alice");
    const removed = f.domainJob.documents.shift()!;
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [notes[0].id] }, "alice"), /不存在/);
    f.domainJob.documents.unshift({ ...removed, revision: 4 });
    f.sources.domain.run = () => { throw new Error("本轮仍在进行"); };
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [notes[0].id] }, "alice"), /仍在进行/);
    assert.equal(listKnowledgeReviewNotes(f.sources, "domain", "dkx-1").notes[0].status, "open");
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test("组件批注按现有单章节返工边界提交，跨章节不会部分执行", () => {
  const f = fixture();
  try {
    saveKnowledgeReviewNote(f.sources, "component", "cr-1", { document_id: "pool", scope: "line", line: 1, note: "说明回收时机" }, "alice");
    const { notes } = saveKnowledgeReviewNote(f.sources, "component", "cr-1", { document_id: "cache", scope: "document", note: "增加失效示例" }, "alice");
    f.componentJob.document!.sections[0].revision = 5;
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "component", "cr-1", { note_ids: notes.map(note => note.id) }, "alice"), /一个章节/);
    assert.equal(f.calls.length, 0);
    const result = applyKnowledgeReviewNotes(f.sources, "component", "cr-1", { note_ids: [notes[0].id] }, "alice");
    assert.equal(result.turn_id, "turn-component");
    const input = f.calls[0].input as { mode: string; section_id: string; message: string };
    assert.equal(input.mode, "rework");
    assert.equal(input.section_id, "pool");
    assert.match(input.message, /第 1 行/);
  } finally { f.cleanup(); }
});

test("正式文档意见保存后可刷新查看，修改正文后直接标为已处理，不绑定版本", () => {
  const f = fixture();
  try {
    const doc = saveKnowledgeDocument(f.dataDir, { title: "订单规则", content: "第一行\n第二行" }, "alice");
    const other = saveKnowledgeDocument(f.dataDir, { title: "其他规则", content: "其他文档" }, "alice");
    const input = { document_id: doc.id, scope: "line" as const, line: 2, quote: "第二行", note: "补充异常处理" };
    const saved = saveKnowledgeReviewNote(f.sources, "published", doc.id, input, "alice");
    assert.deepEqual(listKnowledgeReviewNotes({ ...f.sources }, "published", doc.id), JSON.parse(JSON.stringify(saved)));
    assert.throws(() => saveKnowledgeReviewNote(f.sources, "published", doc.id, { ...input, document_id: other.id }, "alice"), /不存在/);
    assert.throws(() => listKnowledgeReviewNotes(f.sources, "published", `../${doc.id}`), /编号无效/);
    assert.throws(() => resolveKnowledgeReviewNotes(f.sources, "published", other.id, { note_ids: [saved.notes[0].id] }, "alice"), /不存在/);
    assert.deepEqual(listKnowledgeReviewNotes(f.sources, "published", other.id), { notes: [], submissions: {} });
    saveKnowledgeDocument(f.dataDir, { content: "改后的正文\n已补充异常处理" }, "bob", doc.id);
    const resolved = resolveKnowledgeReviewNotes(f.sources, "published", doc.id, { note_ids: [saved.notes[0].id] }, "bob");
    assert.equal(resolved.notes[0].status, "resolved"); assert.equal(resolved.notes[0].resolved_by, "bob");
    assert.equal(resolved.notes[0].quote, "第二行", "正文更新不抹掉原意见引用");
    assert.deepEqual(resolveKnowledgeReviewNotes(f.sources, "published", doc.id, { note_ids: [saved.notes[0].id] }, "alice"), resolved, "重复处理不改写处理人");
    assert.deepEqual(listKnowledgeReviewNotes({ ...f.sources }, "published", doc.id), resolved);
    const next = saveKnowledgeReviewNote(f.sources, "published", doc.id, { ...input, note: "再次补充" }, "alice");
    assert.equal(next.notes.length, 2);
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "published", doc.id, { note_ids: [next.notes[1].id] }, "alice"), /先更新文档/);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test("Skill Markdown 意见按包和文件隔离，更新包后仍可处理，拒绝越界路径与其他文件", async () => {
  const f = fixture();
  const skill = "---\nname: review-skill\ndescription: 审阅测试\n---\n\n# Skill\n查看参考文档。";
  const metadata = { nature: "engineering" as const, business_module_ids: [], repositories: [], technologies: ["java"] };
  const files = (text: string) => [{ path: "SKILL.md", content_base64: Buffer.from(skill).toString("base64") },
    { path: "references/guide.md", content_base64: Buffer.from(text).toString("base64") },
    { path: "scripts/run.txt", content_base64: Buffer.from("不属于Markdown").toString("base64") }];
  try {
    await uploadHostSkill(f.dataDir, "review_skill.v1", files("使用说明"), "alice", metadata);
    await uploadHostSkill(f.dataDir, "another-skill", files("其他包说明"), "alice", metadata);
    const input = { document_id: "references/guide.md", scope: "document" as const, note: "补充使用示例" };
    const saved = saveKnowledgeReviewNote(f.sources, "skill", "review_skill.v1", input, "alice");
    assert.equal(saved.notes[0].document_id, input.document_id);
    assert.throws(() => saveKnowledgeReviewNote(f.sources, "skill", "review_skill.v1", { ...input, document_id: "../SKILL.md" }, "alice"), /不存在/);
    assert.throws(() => saveKnowledgeReviewNote(f.sources, "skill", "review_skill.v1", { ...input, document_id: "scripts/run.txt" }, "alice"), /不存在/);
    assert.throws(() => listKnowledgeReviewNotes(f.sources, "skill", "../review_skill.v1"), /编号无效/);
    assert.deepEqual(listKnowledgeReviewNotes(f.sources, "skill", "another-skill"), { notes: [], submissions: {} });
    assert.throws(() => resolveKnowledgeReviewNotes(f.sources, "skill", "another-skill", { note_ids: [saved.notes[0].id] }, "alice"), /不存在/);
    await uploadHostSkill(f.dataDir, "review_skill.v1", files("已补充使用示例"), "bob", metadata);
    assert.deepEqual(listKnowledgeReviewNotes({ ...f.sources }, "skill", "review_skill.v1"), JSON.parse(JSON.stringify(saved)));
    const resolved = resolveKnowledgeReviewNotes(f.sources, "skill", "review_skill.v1", { note_ids: [saved.notes[0].id] }, "bob");
    assert.equal(resolved.notes[0].status, "resolved"); assert.equal(resolved.notes[0].resolved_by, "bob");
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "skill", "review_skill.v1", { note_ids: [saved.notes[0].id] }, "bob"), /先更新文档/);
    assert.equal(f.calls.length, 0);
  } finally { f.cleanup(); }
});

test("组件章节的意见可在人工修改后标为已处理，不触发新研究", () => {
  const f = fixture();
  try {
    const { notes } = saveKnowledgeReviewNote(f.sources, "component", "cr-1", { document_id: "pool", scope: "line", line: 1, note: "补充连接释放时机" }, "alice");
    f.componentJob.document!.sections[0].revision = 5;
    const resolved = resolveKnowledgeReviewNotes(f.sources, "component", "cr-1", { note_ids: [notes[0].id] }, "bob");
    assert.equal(resolved.notes[0].status, "resolved"); assert.equal(f.calls.length, 0);
    assert.throws(() => applyKnowledgeReviewNotes(f.sources, "component", "cr-1", { note_ids: [notes[0].id] }, "bob"), /已经提交/);
  } finally { f.cleanup(); }
});

test("目录里的业务模块资料沿用稳定 ID 保存批注，文件名安全且与其他资料隔离", () => {
  const f = fixture();
  try {
    createBusinessModule(f.dataDir, { id: "orders", name: "订单", description: "订单模块", owner: "alice", repositories: ["https://example.test/orders.git"] }, "alice");
    const asset = { id: "rules", title: "订单规则", summary: "订单规则摘要", when_to_use: "研究订单时", content: "# 规则\n原有业务资料" };
    publishBusinessKnowledgeAsset(f.dataDir, "orders", asset, "alice");
    publishBusinessKnowledgeAsset(f.dataDir, "orders", { ...asset, id: "other", title: "其他规则" }, "alice");
    publishBusinessKnowledgeAsset(f.dataDir, "orders", { ...asset, id: "legacy-skill", form: "skill", title: "模块 Skill" }, "alice");
    const id = "module:orders:rules", otherId = "module:orders:other";
    const result = saveKnowledgeReviewNote(f.sources, "published", id, { document_id: id, scope: "line", line: 2, note: "补充失败条件" }, "alice");
    assert.equal(result.notes[0].document_id, id); assert.equal(result.notes[0].document_title, "订单规则");
    assert.deepEqual(listKnowledgeReviewNotes({ ...f.sources }, "published", id), JSON.parse(JSON.stringify(result)));
    assert.deepEqual(listKnowledgeReviewNotes(f.sources, "published", otherId), { notes: [], submissions: {} });
    assert.throws(() => resolveKnowledgeReviewNotes(f.sources, "published", otherId, { note_ids: [result.notes[0].id] }, "alice"), /不存在/);
    assert.match(readdirSync(join(f.dataDir, "knowledge-review", "published"))[0], /^asset-[a-f0-9]{64}\.json$/);
    for (const bad of ["module:orders:../rules", "module:orders:rules\0", "module:orders:" + "a".repeat(512)]) assert.throws(() => listKnowledgeReviewNotes(f.sources, "published", bad), /编号无效/);
    publishBusinessKnowledgeAsset(f.dataDir, "orders", { ...asset, content: "# 规则\n已补充失败条件" }, "bob");
    const resolved = resolveKnowledgeReviewNotes(f.sources, "published", id, { note_ids: [result.notes[0].id] }, "bob");
    assert.equal(resolved.notes[0].status, "resolved");
    assert.deepEqual(listKnowledgeReviewNotes({ ...f.sources }, "published", id), resolved);
    const skillId = "module:orders:legacy-skill";
    assert.equal(saveKnowledgeReviewNote(f.sources, "published", skillId, { document_id: skillId, scope: "document", note: "补充模块 Skill 示例" }, "alice").notes[0].document_title, "模块 Skill");
  } finally { f.cleanup(); }
});

test("#457 整体意见不绑定某一文档，领域覆盖全部文稿，组件交给整体返工", () => {
  const f = fixture();
  try {
    const domain = saveKnowledgeReviewNote(f.sources, "domain", "dkx-1", { document_id: "", scope: "study", note: "缺少异常恢复，几份文稿介绍重复" }, "alice");
    f.domainJob.documents.shift();
    const applied = applyKnowledgeReviewNotes(f.sources, "domain", "dkx-1", { note_ids: [domain.notes[0].id] }, "alice");
    assert.deepEqual((f.calls[0].input as any).document_ids, ["api"]);
    assert.match((f.calls[0].input as any).message, /本次任务的全部文稿/);
    assert.equal(applied.submissions[applied.turn_id!].working, true);
    assert.match(applied.submissions[applied.turn_id!].status_label, /等待 Agent/);
    f.domainJob.turns[0].status = "done";
    assert.match(listKnowledgeReviewNotes(f.sources, "domain", "dkx-1").submissions[applied.turn_id!].status_label, /修改完成/);
    const component = saveKnowledgeReviewNote(f.sources, "component", "cr-1", { document_id: "", scope: "study", note: "补充缺失内容，删除重复介绍" }, "alice");
    const result = applyKnowledgeReviewNotes(f.sources, "component", "cr-1", { note_ids: [component.notes[0].id] }, "alice");
    assert.equal((f.calls[1].input as any).section_id, "");
    f.componentJob.review_turns![0].status = "failed"; f.componentJob.review_turns![0].error = "来源读取失败";
    const failed = listKnowledgeReviewNotes(f.sources, "component", "cr-1");
    assert.equal(failed.notes[0].status, "open");
    assert.equal(failed.submissions[result.turn_id!].working, false);
    assert.equal(failed.submissions[result.turn_id!].error, "来源读取失败");
  } finally { f.cleanup(); }
});
