import { test } from "node:test";
import assert from "node:assert/strict";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
function project(job: DomainKnowledgeJob): DomainKnowledgeJob {
  const complete = Object.assign({ id: "test", title: "规则", scope: "规则", repositories: [], turns: [], evidence: [],
    knowledge_target: { id: "domain", name: "知识仓", repository: "https://example.test/k", branch: "main", path: "", docs_path: "docs" } }, job);
  job.production = projectKnowledgeProduction({ kind: "domain", record: complete });
  return job;
}
import { confirmDomainPublication, domainDocumentHasChanges, domainPublicationInput, domainReviewDocument } from "../web/src/domainKnowledgePublication.ts";

test("36 篇文稿只发布勾选的变化稿，随请求固定每篇当前版本", () => {
  const job = { publications: [], documents: Array.from({ length: 36 }, (_, index) => ({ id: `doc-${index}`, revision: index < 5 ? 2 : 1, published_document_revision: 1, knowledge_document_id: `kd-${index}`, selected: index !== 4 })) } as unknown as DomainKnowledgeJob;
  assert.deepEqual(domainPublicationInput(project(job)), { document_ids: ["doc-0", "doc-1", "doc-2", "doc-3"], expected_revisions: { "doc-0": 2, "doc-1": 2, "doc-2": 2, "doc-3": 2 } });
  assert.equal(domainDocumentHasChanges(project(job), job.documents[5]), false);
  for (const document of job.documents) document.published_document_revision = document.revision;
  assert.deepEqual(domainPublicationInput(project(job)), { document_ids: [], expected_revisions: {} });
});

test("生产线验收8：缺平台入库版本不从当前或历史归档MR猜版本", () => {
  const job = { publications: [{ state: "opened", documents: [{ id: "doc", revision: 3 }] }], publication_history: [{ state: "opened", documents: [{ id: "doc", revision: 2 }] }], documents: [{ id: "doc", revision: 3, knowledge_document_id: "kd-1", selected: true }] } as unknown as DomainKnowledgeJob;
  assert.equal(project(job).production?.documents[0].published_revision, undefined);
  assert.equal(domainDocumentHasChanges(project(job), job.documents[0]), true);
  job.documents[0].published_document_revision = 3;
  assert.equal(domainDocumentHasChanges(project(job), job.documents[0]), false);
});

function proposalJob(): DomainKnowledgeJob {
  return { id: "job", status: "done", publications: [], documents: ["a", "b"].map(id => ({ id, path: `${id}.md`, title: id, content: `原稿 ${id}`, revision: 2, published_document_revision: 2, knowledge_document_id: `kd-${id}`, selected: true })),
    turns: [{ id: "turn", status: "done", proposals: ["a", "b"].map(id => ({ status: "pending", base_revision: 2, document: { id, path: `${id}.md`, title: id, content: `修改结果 ${id}` } })) }] } as unknown as DomainKnowledgeJob;
}

test("已发布文稿有新修改时直接预览最新完成结果，失败和冲突仍显示原稿", () => {
  const job = proposalJob(), document = job.documents[0];
  assert.equal(domainDocumentHasChanges(project(job), document), true);
  assert.equal(domainReviewDocument(project(job), document).content, "修改结果 a");
  assert.equal(document.content, "原稿 a", "预览不能原地改写基线");
  job.turns[0].status = "failed";
  assert.equal(domainReviewDocument(project(job), document).content, "原稿 a");
  job.turns[0].status = "done";
  document.revision = 3;
  assert.equal(domainReviewDocument(project(job), document).content, "原稿 a");
});

test("整批预检先于任何确认写入，后面的文稿冲突时不能提前接受前一篇", async () => {
  const job = proposalJob(); job.turns[0].proposals[1].base_revision = 1;
  const writes: string[] = [];
  await assert.rejects(confirmDomainPublication(project(job), async action => { writes.push(action); return job; }), /b.md 的正文已变化/);
  assert.equal(writes.length, 0);
  job.turns[0].proposals[1].base_revision = 2; job.turns[0].status = "running";
  await assert.rejects(confirmDomainPublication(project(job), async action => { writes.push(action); return job; }), /修改尚未完成/);
  assert.equal(writes.length, 0);
});

test("一键确认多份修改后用返回的新版本发布，未选文稿保留", async () => {
  const job = proposalJob();
  job.documents.push({ ...job.documents[0], id: "unselected", selected: false, revision: 3 });
  const writes: Array<{ action: string; input: any }> = [];
  let server = structuredClone(job);
  const result = await confirmDomainPublication(project(job), async (action, input: any) => {
    writes.push({ action, input });
    if (action === "proposal") {
      const doc = server.documents.find(item => item.id === input.document_id)!;
      const proposal = server.turns[0].proposals.find(item => item.document.id === doc.id)!;
      Object.assign(doc, proposal.document, { revision: doc.revision + 1 }); proposal.status = "accepted";
    } else {
      for (const doc of server.documents.filter(item => input.document_ids.includes(item.id))) doc.published_document_revision = doc.revision;
    }
    return project(structuredClone(server));
  });
  assert.deepEqual(writes.map(write => write.action), ["proposal", "proposal", "publish"]);
  assert.deepEqual(writes.at(-1)?.input, { document_ids: ["a", "b"], expected_revisions: { a: 3, b: 3 } });
  assert.equal(result.documents[0].content, "修改结果 a");
  assert.equal(result.documents[2].published_document_revision, 2);
  assert.equal(job.documents[0].content, "原稿 a");
});

test("确认途中失败保留已确认草稿，不继续发布任何正式知识", async () => {
  const job = proposalJob(), writes: string[] = [];
  await assert.rejects(confirmDomainPublication(project(job), async (action, input: any) => {
    writes.push(action);
    if (input.document_id === "b") throw new Error("文稿已被其他人修改");
    const next = structuredClone(job);
    next.documents[0].revision = 3;
    next.turns[0].proposals[0].status = "accepted";
    return project(next);
  }), /文稿已被其他人修改/);
  assert.deepEqual(writes, ["proposal", "proposal"]);
});
