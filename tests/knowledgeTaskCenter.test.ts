import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { componentKnowledgeTask, domainKnowledgeTask, latestKnowledgeResearchNote, listKnowledgeTasks, skillExtractionTask, skillSubmissionTask } from "../src/knowledgeTaskCenter.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import type { ResearchRecord } from "../src/componentResearch.ts";
import type { SkillSubmissionRecord } from "../src/hostSkillLibrary.ts";
import { knowledgeTaskElapsed, knowledgeTaskOpensDocument } from "../web/src/knowledgeTaskCenterApi.ts";

function domain(): DomainKnowledgeJob {
  return { id: "domain-1", title: "结算", scope: "结算模块", operator: "alice", created_at: "2026-09-30T01:00:00Z", status: "done", stage: "本轮完成，等待审查", revisions: {}, repositories: [], knowledge_target: { id: "domain", name: "知识仓", repository: "https://code.example/knowledge", branch: "main", path: "", docs_path: "docs" }, material_ids: [], ar_codes: [], use_wxdoubao: false, documents: [{ id: "doc", title: "结算规则", target_id: "domain", path: "docs/a.md", layer: "domain", content: "规则", sources: "", selected: true, revision: 2, base_content: null, base_revision: "", history: [] }], turns: [], evidence: [], publications: [] };
}

test("研究动态只取最新公开研究文字，保留真实时间，跳过工具原文", () => {
  const note = latestKnowledgeResearchNote([
    { tool: "research_note", preview: "旧分析", at: "2026-09-30T01:00:00Z" },
    { tool: "research_note", preview: "## 新分析\n**已核对**调用关系", at: "2026-09-30T01:02:00Z" },
    { tool: "component_source", preview: "原始工具输出", at: "2026-09-30T01:03:00Z" },
  ]);
  assert.deepEqual(note, { text: "新分析 已核对调用关系", at: "2026-09-30T01:02:00Z" });
  assert.equal(latestKnowledgeResearchNote([{ tool: "read", preview: "不能变成思考" }]), undefined);
  assert.equal(latestKnowledgeResearchNote([{ tool: "research_note", preview: "a".repeat(300), at: "bad" }])?.text.length, 180);
});

test("领域研究完成不等于发布；发布后新稿与归档失败仍可处理", () => {
  const job = domain();
  assert.equal(domainKnowledgeTask(job).status_label, "待检视");
  job.documents[0].knowledge_document_id = "kd-1";
  job.documents[0].published_document_revision = 2;
  assert.equal(domainKnowledgeTask(job).status_label, "已发布");
  job.publications = [{ target_id: "domain", branch: "b", state: "merged", documents: [], sync_state: "diverged", diverged_paths: ["a.md"] }];
  assert.deepEqual([domainKnowledgeTask(job).status_label, domainKnowledgeTask(job).group], ["已发布 · 远端待核对", "attention"], "合入后归档仓被改须提醒人核对");
  job.publications = [];
  job.archive_batches = [{ id: "archive", created_at: job.created_at, operator: "alice", state: "failed", documents: [], targets: [], publications: [] }];
  assert.equal(domainKnowledgeTask(job).status_label, "已发布 · 归档待处理");
  job.documents[0].revision = 3;
  assert.equal(domainKnowledgeTask(job).status_label, "待检视");
  job.status = "running";
  assert.equal(domainKnowledgeTask(job).group, "running");
  assert.equal(domainKnowledgeTask(job).started_at, undefined);
  job.status = "done"; job.probe = { module: "结算" };
  assert.equal(domainKnowledgeTask(job).group, "completed");
});

test("组件研究保留执行结束，但不把创建当开始；发布与待审稿分开", () => {
  const record = { id: "component-1", language: "cpp", topic: "线程池", operator: "bob", status: "done", created_at: "2026-09-30T01:00:00Z", finished_at: "2026-09-30T01:10:00Z", stage: "待审查", draft: "# 线程池", evidence: [] } as unknown as ResearchRecord;
  assert.equal(componentKnowledgeTask(record).group, "attention");
  assert.equal(knowledgeTaskElapsed(componentKnowledgeTask(record)), "—");
  record.document_id = "kd-1";
  assert.equal(componentKnowledgeTask(record).status_label, "已发布");
});

test("Skill 审核等待不能作为运行时长，重启中断无结束时间不继续计时", () => {
  const submission = { id: "submission-1", directory: "review-skill", operator: "alice", created_at: "2026-09-30T01:00:00Z", decided_at: "2026-09-30T06:00:00Z", status: "approved", business_module_ids: [], technologies: [] } as unknown as SkillSubmissionRecord;
  assert.equal(skillSubmissionTask(submission).id, "review-skill/submission-1");
  assert.equal(knowledgeTaskElapsed(skillSubmissionTask(submission)), "—");
  const extraction = skillExtractionTask({ id: "ke-1", status: "failed", repo: "repo", intent: "重启中断", operator: "alice", started_at: "2026-09-30T01:00:00Z" });
  assert.equal(knowledgeTaskElapsed(extraction, Date.parse("2026-09-30T02:00:00Z")), "—");
  extraction.status = "running";
  assert.equal(knowledgeTaskElapsed(extraction, Date.parse("2026-09-30T01:03:05Z")), "3 分 5 秒");
  extraction.status = "done"; extraction.finished_at = "2026-09-30T01:04:10Z";
  assert.equal(knowledgeTaskElapsed(extraction), "4 分 10 秒");
});

test("中心读取既有记录与重启状态，来源不可用会显示警告而不隐藏其他任务", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "knowledge-task-center-"));
  try {
    mkdirSync(join(dataDir, "knowledge-extract", "ke-123"), { recursive: true });
    writeFileSync(join(dataDir, "knowledge-extract", "not-a-job"), "");
    const job = domain();
    const result = listKnowledgeTasks({ dataDir,
      domain: { list: probes => probes ? [] : [{ id: job.id }], get: () => job },
      component: { list: () => { throw new Error("unavailable"); }, get: () => { throw new Error("missing"); } },
      skillExtractionJob: id => ({ id, status: "failed", repo: "repo", intent: "参考仓制作", operator: "alice", started_at: "2026-09-30T02:00:00Z", error: "服务重启中断" }),
    });
    assert.equal(result.tasks.length, 2);
    assert.equal(result.tasks[0].id, "ke-123");
    assert.deepEqual(result.summary, { running: 0, attention: 2, total: 2 });
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /基础组件萃取/);
    assert.equal("documents" in result.tasks[1], false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});


test("归档在后台进行时任务仍直接打开文稿，旧归档失败不覆盖新版本状态", () => {
  const job = domain();
  Object.assign(job.documents[0], { knowledge_document_id: "kd-1", published_document_revision: 2, published_revision: "new" });
  job.archive_batches = [
    { id: "old", created_at: job.created_at, operator: "alice", state: "failed", documents: [{ ...job.documents[0], published_revision: "old" }], targets: [], publications: [] },
    { id: "new", created_at: job.created_at, operator: "alice", state: "running", documents: [{ ...job.documents[0] }], targets: [], publications: [] },
  ];
  assert.equal(domainKnowledgeTask(job).status_label, "已发布 · 归档中");
  assert.equal(domainKnowledgeTask(job).group, "completed");
  assert.equal(knowledgeTaskOpensDocument(domainKnowledgeTask(job)), true);
  job.archive_batches[1].state = "done";
  assert.equal(domainKnowledgeTask(job).status_label, "已发布");
  job.status = "running";
  assert.equal(knowledgeTaskOpensDocument(domainKnowledgeTask(job)), false);
  job.status = "cancelled";
  assert.equal(domainKnowledgeTask(job).group, "attention");
});

test("组件归档失败仍打开已发布文稿，和领域任务一样保留处理入口", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "knowledge-task-archive-"));
  try {
    const record = { id: "component-1", status: "done", topic: "线程池", document_id: "kd-1", evidence: [] } as unknown as ResearchRecord;
    const archive = domain();
    archive.archive_batches = [{ id: "failed", created_at: archive.created_at, operator: "alice", state: "failed", documents: [], targets: [], publications: [] }];
    const result = listKnowledgeTasks({ dataDir, domain: { list: () => [], get: () => archive, componentArchive: () => archive }, component: { list: () => [record], get: () => record }, skillExtractionJob: () => undefined });
    assert.equal(result.tasks[0].status_label, "已发布 · 归档待处理");
    assert.equal(result.summary.attention, 1);
    assert.equal(knowledgeTaskOpensDocument(result.tasks[0]), true);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
