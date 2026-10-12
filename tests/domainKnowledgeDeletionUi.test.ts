import { after, test } from "node:test";
import assert from "node:assert/strict";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import { domainPublicationInput } from "../web/src/domainKnowledgePublication.ts";

const vite = await createServer({ root: "web", server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
const { DomainKnowledgeDeletionNotice } = await vite.ssrLoadModule("/src/DomainKnowledgeExtraction.tsx");
const { DomainKnowledgeFileTree } = await vite.ssrLoadModule("/src/DomainKnowledgeFileTree.tsx");
after(() => vite.close());

function fixture(confirmed = false, mixed = false): DomainKnowledgeJob {
  const removed = { id: "old-rules", title: "旧规则", target_id: "domain", path: "domains/old-rules.md", layer: "domain",
    content: "# 旧规则\n\n原正文继续保留用于删除审查。", sources: "原证据", revision: 2, selected: true, deleted: true,
    base_content: "# 旧规则", base_revision: "source-sha", history: [], knowledge_document_id: "kd-old",
    published_revision: confirmed ? "tombstone-sha" : "original-sha", published_document_revision: confirmed ? 2 : 1 };
  const record = { id: "dkx-delete-review", title: "知识调整", scope: "规则", status: "done", documents: [removed], turns: [],
    repositories: [], publications: [], archive_batches: [],
    knowledge_target: { id: "domain", name: "知识仓", repository: "https://example.test/knowledge.git", branch: "main", path: "", docs_path: "docs" },
  } as unknown as DomainKnowledgeJob;
  if (mixed) record.documents.push({ ...record.documents[0], id: "current-rules", path: "domains/current-rules.md", deleted: false,
    knowledge_document_id: "kd-current", published_revision: "current-sha", published_document_revision: 2 });
  record.production = projectKnowledgeProduction({ kind: "domain", record,
    current_revisions: { "kd-old": removed.published_revision, ...(mixed ? { "kd-current": "current-sha" } : {}) } });
  return record;
}
function tree(job: DomainKnowledgeJob) {
  return renderToStaticMarkup(React.createElement(DomainKnowledgeFileTree, { job,
    onNavigate() {}, onSelection() {}, onSelections() {} }));
}

test("待删除文稿仍计入现有确认发布，目录明确标记并保留原正文", () => {
  const job = fixture();
  assert.equal(job.production!.documents[0].changed, true);
  assert.equal(job.production!.documents[0].status_label, "待删除");
  assert.ok(job.production!.research_actions.some(action => action.id === "publish"));
  assert.deepEqual(domainPublicationInput(job), { document_ids: ["old-rules"], expected_revisions: { "old-rules": 2 } });
  assert.match(tree(job), /待删除/);
  assert.match(tree(job), /aria-label="确认删除 domains\/old-rules\.md"/);
  const notice = renderToStaticMarkup(React.createElement(DomainKnowledgeDeletionNotice, { deleted: true, pending: true }));
  assert.match(notice, /知识文稿待删除/);
  assert.match(notice, /确认并发布后从正式知识库移除/);
  assert.match(notice, /保留原正文供审查/);
  assert.doesNotMatch(notice, /<button|<input|删除任务/);
  assert.equal(job.documents[0].content, "# 旧规则\n\n原正文继续保留用于删除审查。");
});

test("删除确认后按原版本投影结束待发布状态，保留手工归档入口", () => {
  const job = fixture(true);
  assert.equal(job.production!.documents[0].changed, false);
  assert.equal(job.production!.documents[0].status_label, "已删除");
  assert.deepEqual(domainPublicationInput(job).document_ids, []);
  assert.match(tree(job), /已删除/);
  assert.equal(job.production!.archive.visible, true);
  assert.ok(job.production!.archive.actions.some(action => action.id === "archive"));
  assert.equal(job.production!.archive.title, "文档删除已确认，可手工归档");
  assert.doesNotMatch(job.production!.archive.message, /平台立即可读|知识已发布/);
  const notice = renderToStaticMarkup(React.createElement(DomainKnowledgeDeletionNotice, { deleted: true, pending: false }));
  assert.match(notice, /知识文稿已删除/);
  assert.match(notice, /历史恢复/);
  assert.doesNotMatch(notice, /<button|<input|删除任务/);
});

test("混合确认的正文与删除统一显示已确认变更，普通文稿不加删除提示", () => {
  const job = fixture(true, true);
  assert.match(job.production!.archive.title, /2 份文稿变更已确认/);
  assert.match(job.production!.archive.message, /文稿变更已确认/);
  assert.doesNotMatch(job.production!.archive.title, /平台立即可读/);
  assert.equal(renderToStaticMarkup(React.createElement(DomainKnowledgeDeletionNotice, { pending: false })), "");
});
