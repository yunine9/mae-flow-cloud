import { after, test } from "node:test";
import assert from "node:assert/strict";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import { archiveRequest } from "../web/src/knowledgeArchiveAction.ts";
import type { KnowledgeArchivePreview } from "../src/knowledgeProductionTypes.ts";

const vite = await createServer({ root: "web", server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
const { DomainKnowledgePublicationStatus } = await vite.ssrLoadModule("/src/DomainKnowledgePublicationStatus.tsx");
const { DomainKnowledgeArchiveTargets } = await vite.ssrLoadModule("/src/DomainKnowledgeArchiveTargets.tsx");
const { KnowledgeArchiveHistory } = await vite.ssrLoadModule("/src/KnowledgeArchiveDialog.tsx");
after(() => vite.close());

test("Issue488：一次归档动作使用已有单号和最新正式版本直接创建MR", () => {
  const preview = { issue_no: "DTS-488", issue_description: "归档知识", expected_revisions: { "kd-1": "published-v2" },
    actions: [{ id: "create-archive" }] } as KnowledgeArchivePreview;
  assert.deepEqual(archiveRequest(preview), { action: "create", input: { issue_no: "DTS-488", issue_description: "归档知识", expected_revisions: { "kd-1": "published-v2" } } });
  assert.equal(archiveRequest({ ...preview, issue_no: " " }), undefined);
  for (const id of ["configure", "review"]) assert.equal(archiveRequest({ ...preview, actions: [{ id, label: id, view: "review" }] }), undefined);
  assert.equal(archiveRequest({ ...preview, actions: [] }), undefined, "已有MR只展示记录，不重复创建");
  assert.equal(archiveRequest({ ...preview, actions: [{ id: "replace-archive", label: "重新归档", view: "archive" }] }), undefined,
    "查看已有MR不会自动撤销，替换须点击明确动作");
  assert.deepEqual(archiveRequest({ ...preview, actions: [{ id: "retry-archive", label: "重试", view: "archive", batch_id: "original" }] }),
    { action: "retry", input: { batch_id: "original", target_id: undefined } });
});

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

test("Issue489：旧任务展示最终仓内目录，模块ID不进入归档目录", () => {
  const job = fixture();
  const html = renderToStaticMarkup(React.createElement(DomainKnowledgeArchiveTargets, { job, onChange() {} }));
  assert.match(html, /不追加模块编号或仓库名/);
  assert.match(html, /重名会自动分配文件名、更新链接和索引/);
  assert.match(html, /不重新萃取/);
  assert.match(html, /value="domains\/订单知识"/);
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

test("Issue488：65篇已发布且只有恢复占位批次时，详情和归档页明确显示创建MR入口", () => {
  const job = fixture(); job.knowledge_layout = "module-v1";
  job.documents = Array.from({ length: 65 }, (_, index) => ({ ...job.documents[0], id: `doc-${index}`,
    path: `domains/orders/doc-${index}.md`, knowledge_document_id: `kd-${index}`, published_revision: `formal-${index}`, published_document_revision: 1 }));
  job.archive_batches = [{ id: "recovery", created_at: job.created_at, operator: "alice", state: "pending", knowledge_layout: "module-v1",
    documents: structuredClone(job.documents), targets: [job.knowledge_target], publications: [] }];
  job.production = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(job.production.next_action.label, "创建归档 MR");
  for (const compact of [true, false]) {
    const html = renderToStaticMarkup(React.createElement(DomainKnowledgePublicationStatus, { job, compact }));
    assert.match(html, /创建归档 MR<\/button>/);
    assert.doesNotMatch(html, /disabled/);
    if (!compact) assert.match(html, /平台知识已发布/);
  }
  assert.equal(job.archive_batches.length, 1);
  assert.equal(job.archive_batches[0].issue_no, undefined, "展示入口不会自动创建MR或替人确认单号");
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

test("Issue489：旧 UUID 和工作区仓名从预览去除，仓内 docs 路径保留", () => {
  const job = fixture();
  job.module_id = "module-5d312e96-7b1f-4a75-b3f4-ab4624a831ce"; job.knowledge_layout = "module-v1";
  const repo = { id: "repo-1", name: "FMProductFrontendService", repository: "https://example.test/FMProductFrontendService.git", branch: "master", path: "", docs_path: `docs/knowledge/${job.module_id}` };
  job.repositories = [repo];
  job.documents = [{ ...job.documents[0], target_id: repo.id, layer: "repository", path: `${repo.docs_path}/${repo.name}/docs/module-map.md` }];
  const html = renderToStaticMarkup(React.createElement(DomainKnowledgeArchiveTargets, { job, onChange() {} }));
  assert.match(html, /value="\."/);
  assert.match(html, /value="docs\/module-map.md"/);
  assert.doesNotMatch(html, /module-5d312e96/);
});

test("Issue489：旧MR撤销失败保留新旧链接及重试入口，已撤销不误报已归档", () => {
  const job = fixture(); job.knowledge_layout = "repository-v1";
  Object.assign(job.documents[0], { path: "domains/README.md", knowledge_document_id: "kd", published_revision: "v1", published_document_revision: 1 });
  const old = { target_id: "domain", branch: "old", state: "opened" as const, url: "https://example.test/mr/old", documents: [] };
  const current = { ...old, branch: "new", url: "https://example.test/mr/new" };
  job.archive_batches = [
    { id: "old", created_at: job.created_at, operator: "alice", issue_no: "DTS489", state: "superseded", knowledge_layout: "repository-v1", documents: job.documents, targets: [job.knowledge_target], publications: [old] },
    { id: "new", created_at: job.created_at, operator: "alice", issue_no: "DTS489", state: "failed", knowledge_layout: "repository-v1", documents: job.documents, targets: [job.knowledge_target], publications: [current],
      replacements: [{ batch_id: "old", target: job.knowledge_target, publication: old, state: "failed", error: "旧 MR 关闭失败" }] },
  ];
  const view = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(view.archive.state, "failed");
  const html = renderToStaticMarkup(React.createElement(KnowledgeArchiveHistory, { batches: view.archive.batches, onRetry() {} }));
  assert.match(html, /已被新归档替换/); assert.match(html, /旧 MR 撤销失败，可重试/);
  assert.match(html, /href="https:\/\/example.test\/mr\/new"/); assert.match(html, /href="https:\/\/example.test\/mr\/old"/);
  job.archive_batches[1].replacements![0].state = "closed"; job.archive_batches[1].state = "done";
  const recovered = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(recovered.archive.state, "opened");
  assert.equal(recovered.archive.batches[0].publications[0].status_label, "旧 MR 已撤销");
  job.archive_batches[1].replacements![0].state = "merged";
  const merged = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(merged.archive.state, "opened");
  assert.equal(merged.archive.batches[0].publications[0].status_label, "已合入，保留原提交");
});
