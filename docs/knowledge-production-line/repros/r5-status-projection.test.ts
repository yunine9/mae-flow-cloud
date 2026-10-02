// 复现：状态投影口径不一致——合入后同步失败被算作 done；组件任务中心不看 diverged；研究失败遮住归档待处理。
import assert from "node:assert/strict";
import { test } from "node:test";
import { knowledgeArchiveState } from "../../../src/knowledgeArchiveStatus.ts";
import { domainKnowledgeTask, listKnowledgeTasks } from "../../../src/knowledgeTaskCenter.ts";
import type { DomainKnowledgeJob } from "../../../src/domainKnowledgeTypes.ts";
import type { ResearchRecord } from "../../../src/componentResearch.ts";

function domain(): DomainKnowledgeJob {
  return { id: "dkx-1", title: "结算", scope: "结算", operator: "alice", created_at: "2026-09-30T01:00:00Z", status: "done", stage: "", revisions: {}, repositories: [],
    knowledge_target: { id: "domain", name: "知识仓", repository: "https://code.example/k", branch: "main", path: "", docs_path: "docs" }, material_ids: [], ar_codes: [], use_wxdoubao: false,
    documents: [{ id: "doc", title: "规则", target_id: "domain", path: "docs/a.md", layer: "domain", content: "规则", sources: "", selected: true, revision: 2, base_content: null, base_revision: "", history: [], knowledge_document_id: "kd-1", published_document_revision: 2, published_revision: "r" }],
    turns: [], evidence: [], publications: [] };
}

test("合入后同步失败（sync_state=failed）：归档状态 done，任务中心显示已发布、归入已完成", () => {
  const job = domain();
  job.publications = [{ target_id: "domain", branch: "b", state: "merged", documents: [], sync_state: "failed", sync_error: "已合入，知识文档同步失败" }];
  const row = domainKnowledgeTask(job);
  console.log("[r5] sync failed →", knowledgeArchiveState(job), row.status_label, row.group);
  assert.equal(knowledgeArchiveState(job), "done");
  assert.deepEqual([row.status_label, row.group], ["已发布", "completed"]);
});

test("研究新一轮失败会遮住'归档待处理'：任务中心只显示执行失败", () => {
  const job = domain();
  job.archive_batches = [{ id: "a", created_at: job.created_at, operator: "alice", state: "failed", documents: [], targets: [], publications: [], error: "Git 推送失败" }];
  assert.equal(domainKnowledgeTask(job).status_label, "已发布 · 归档待处理");
  job.status = "failed";
  console.log("[r5] 新一轮失败后 →", domainKnowledgeTask(job).status_label);
  assert.equal(domainKnowledgeTask(job).status_label, "执行失败");
});

test("组件任务：归档仓合入后被改（diverged）在任务中心仍显示'已发布'（领域任务会提示远端待核对）", () => {
  const record = { id: "cr-1", topic: "组件", language: "java", operator: "alice", created_at: "2026-09-30T01:00:00Z", status: "done", stage: "", evidence: [], document_id: "kd-1",
    component: { id: "c", name: "c", repository: "r", branch: "main", path: "", languages: ["java"], description: "", enabled: true }, key: "k" } as unknown as ResearchRecord;
  const archive = { ...domain(), id: "dkx-c", component_research_id: "cr-1", publications: [{ target_id: "domain", branch: "b", state: "merged", documents: [], sync_state: "diverged", diverged_paths: ["docs/a.md"] }] } as DomainKnowledgeJob;
  const data = listKnowledgeTasks({ dataDir: "/nonexistent", domain: { list: () => [], get: () => { throw new Error(); }, componentArchive: () => archive },
    component: { list: () => [record], get: () => record }, skillExtractionJob: () => undefined });
  const row = data.tasks.find(t => t.id === "cr-1")!;
  console.log("[r5] 组件 diverged →", row.status_label, row.group, " 领域同样状态 →", domainKnowledgeTask(archive).status_label);
  assert.deepEqual([row.status_label, row.group], ["已发布", "completed"]);
  assert.equal(domainKnowledgeTask(archive).status_label, "已发布 · 远端待核对");
});
