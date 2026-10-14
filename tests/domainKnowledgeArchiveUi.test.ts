import { after, test } from "node:test";
import assert from "node:assert/strict";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";

const vite = await createServer({ root: "web", server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
const { DomainKnowledgePublicationStatus } = await vite.ssrLoadModule("/src/DomainKnowledgePublicationStatus.tsx");
const { DomainKnowledgeArchiveTargets } = await vite.ssrLoadModule("/src/DomainKnowledgeArchiveTargets.tsx");
const { KnowledgeArchiveHistory } = await vite.ssrLoadModule("/src/KnowledgeArchiveDialog.tsx");
after(() => vite.close());

function fixture(): DomainKnowledgeJob {
  return { id: "dkx-archive-ui", title: "订单知识", scope: "订单", module_id: "orders", operator: "alice", created_at: "2026-10-14T00:00:00Z",
    repositories: [], knowledge_target: { id: "domain", name: "知识仓", repository: "https://example.test/knowledge.git", branch: "main", path: "", docs_path: "domains" },
    material_ids: [], status: "done", stage: "研究完成", revisions: {}, turns: [], evidence: [], publications: [],
    documents: [{ id: "entry", target_id: "domain", layer: "domain", title: "订单入口", path: "AGENTS.md", content: "已有业务知识", sources: "代码", revision: 1, selected: true,
      base_content: null, base_revision: "", history: [] }] };
}

test("仅有旧 AGENTS 草稿时可以进入归档设置，不要求先发布或重跑", () => {
  const job = fixture(); job.production = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(job.production.archive.visible, false);
  const html = renderToStaticMarkup(React.createElement(DomainKnowledgePublicationStatus, { job, compact: true, onConfigure() {} }));
  assert.match(html, />归档设置<\/button>/);
  assert.doesNotMatch(html, /disabled/);
});

test("旧任务设置说明确认发布会自动整理和处理重名，预览只作为可选入口", () => {
  const job = fixture();
  const html = renderToStaticMarkup(React.createElement(DomainKnowledgeArchiveTargets, { job, onChange() {} }));
  assert.match(html, /确认并发布时，平台会自动按业务模块整理目录/);
  assert.match(html, /重名时自动分配文件名、更新链接和索引/);
  assert.match(html, /无需提前设置/);
  assert.match(html, />预览模块目录<\/button>/);
  assert.doesNotMatch(html, /先按业务模块整理目录/);
});

test("已发布且配置完整的任务仍能打开归档设置；研究期间不允许改位置", () => {
  const job = fixture(); Object.assign(job.documents[0], { knowledge_document_id: "kd-order", published_revision: "formal", published_document_revision: 1 });
  job.production = projectKnowledgeProduction({ kind: "domain", record: job });
  const render = () => renderToStaticMarkup(React.createElement(DomainKnowledgePublicationStatus, { job, compact: true, onConfigure() {} }));
  assert.match(render(), />归档设置<\/button>/);
  job.status = "running"; job.production = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.match(render(), /<button[^>]*disabled[^>]*>归档设置<\/button>/);
});

test("模块归档设置明确覆盖根 AGENTS，旧正文可从 Git 历史查阅", () => {
  const job = fixture(); job.knowledge_layout = "module-v1";
  job.knowledge_target.docs_path = "domains/orders"; job.documents[0].path = "domains/orders/README.md";
  const html = renderToStaticMarkup(React.createElement(DomainKnowledgeArchiveTargets, { job, onChange() {} }));
  assert.match(html, /完整替换每个目标仓根 AGENTS.md/);
  assert.match(html, /旧正文保留在 Git 历史中/);
  assert.doesNotMatch(html, /保留原有内容/);
});

test("整理目录后保留旧失败批次的重试入口和原 MR 链接", () => {
  const job = fixture(); Object.assign(job.documents[0], { knowledge_document_id: "kd-order", published_revision: "formal", published_document_revision: 1 });
  job.archive_batches = [{ id: "old-batch", issue_no: "REQ-OLD", created_at: job.created_at, operator: "alice", state: "failed",
    documents: structuredClone(job.documents), targets: [structuredClone(job.knowledge_target)], publications: [{ target_id: "domain", branch: "codex/old", state: "failed",
      url: "https://example.test/mr/old", error: "网络中断", documents: [] }] }];
  job.knowledge_layout = "module-v1"; job.knowledge_target.docs_path = "domains/orders";
  job.documents[0].path = "domains/orders/README.md";
  const view = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(view.archive.state, "done", "旧失败批次不冒充当前版本的归档失败");
  assert.deepEqual(view.archive.batches[0].actions, [{ id: "retry-archive", label: "重试原批次", view: "archive", batch_id: "old-batch" }]);
  const html = renderToStaticMarkup(React.createElement(KnowledgeArchiveHistory, { batches: view.archive.batches, onRetry() {} }));
  assert.match(html, /REQ-OLD/); assert.match(html, />重试原批次<\/button>/);
  assert.match(html, /href="https:\/\/example.test\/mr\/old"/);
  assert.match(html, /不带入后续目录调整或未发布修改/);
});
