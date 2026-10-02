// r5 翻转：任务中心与详情都使用后端投影，优先显示需要人处理的归档事实。
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { knowledgeArchiveState } from "../src/knowledgeArchiveStatus.ts";
import { componentKnowledgeTask, domainKnowledgeTask, listKnowledgeTasks } from "../src/knowledgeTaskCenter.ts";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import type { ResearchRecord } from "../src/componentResearch.ts";

function domain(): DomainKnowledgeJob {
  return { id: "dkx-1", title: "结算", scope: "结算", operator: "alice", created_at: "2026-09-30T01:00:00Z", status: "done", stage: "", revisions: {}, repositories: [],
    knowledge_target: { id: "domain", name: "知识仓", repository: "https://code.example/k", branch: "main", path: "", docs_path: "docs" }, material_ids: [], ar_codes: [], use_wxdoubao: false,
    documents: [{ id: "doc", title: "规则", target_id: "domain", path: "docs/a.md", layer: "domain", content: "规则", sources: "", selected: true, revision: 2, base_content: null, base_revision: "", history: [], knowledge_document_id: "kd-1", published_document_revision: 2, published_revision: "r" }],
    turns: [], evidence: [], publications: [] };
}

test("生产线验收8（r5/F10）：合入后同步失败显示已入库 · 同步失败，归入需要处理", () => {
  const job = domain();
  job.publications = [{ target_id: "domain", branch: "b", state: "merged", documents: [], sync_state: "failed", sync_error: "已合入，知识文档同步失败" }];
  const row = domainKnowledgeTask(job);
  assert.equal(knowledgeArchiveState(job), "failed");
  assert.deepEqual([row.status_label, row.group], ["已入库 · 同步失败", "attention"]);
});

test("生产线验收8（r5/F12）：研究失败不会遮住归档待处理", () => {
  const job = domain();
  job.archive_batches = [{ id: "a", created_at: job.created_at, operator: "alice", state: "failed", documents: [], targets: [], publications: [], error: "Git 推送失败" }];
  assert.equal(domainKnowledgeTask(job).status_label, "已入库 · 归档待处理");
  job.status = "failed";
  assert.equal(domainKnowledgeTask(job).status_label, "已入库 · 归档待处理");
});

test("生产线验收8（r5/F11）：组件与领域远端待核对使用相同文案和分组", () => {
  const record = { id: "cr-1", topic: "组件", language: "java", operator: "alice", created_at: "2026-09-30T01:00:00Z", status: "done", stage: "", evidence: [], document_id: "kd-1",
    component: { id: "c", name: "c", repository: "r", branch: "main", path: "", languages: ["java"], description: "", enabled: true }, key: "k" } as unknown as ResearchRecord;
  const archive = { ...domain(), id: "dkx-c", component_research_id: "cr-1", publications: [{ target_id: "domain", branch: "b", state: "merged", documents: [], sync_state: "diverged", diverged_paths: ["docs/a.md"] }] } as DomainKnowledgeJob;
  const data = listKnowledgeTasks({ dataDir: "/nonexistent", domain: { list: () => [], get: () => { throw new Error(); }, componentArchive: () => archive },
    component: { list: () => [record], get: () => record }, skillExtractionJob: () => undefined });
  const row = data.tasks.find(t => t.id === "cr-1")!;
  assert.deepEqual([row.status_label, row.group], ["已入库 · 远端待核对", "attention"]);
  assert.equal(domainKnowledgeTask(archive).status_label, "已入库 · 远端待核对");
});

function component(id = "cr-matrix"): ResearchRecord {
  return { id, component: { id: "files", name: "文件", repository: "https://example.test/files.git", branch: "main", path: "src", languages: ["java"], description: "", enabled: true },
    language: "java", topic: "文件规则", operator: "alice", key: id, status: "done", stage: "已完成", created_at: "2026-10-03T00:00:00Z", evidence: [], document_id: "kd-1" };
}

test("生产线验收8：同步失败、远端差异、MR关闭与归档失败组合按后端唯一优先级压过研究失败", () => {
  for (const research of ["done", "failed", "cancelled"] as const) {
    const job = domain(), record = component(); job.status = record.status = research;
    job.archive_batches = [{ id: "batch", state: "failed", operator: "alice", created_at: job.created_at, documents: [], targets: [job.knowledge_target], publications: [], error: "推送失败" }];
    const cases = [
      { publication: { target_id: "domain", branch: "sync", state: "merged" as const, documents: [], sync_state: "failed" as const, sync_error: "同步失败" }, label: "同步失败", action: "compare" },
      { publication: { target_id: "domain", branch: "diff", state: "merged" as const, documents: [], sync_state: "diverged" as const, diverged_paths: ["docs/a.md"] }, label: "远端待核对", action: "compare" },
      { publication: { target_id: "domain", branch: "closed", state: "closed" as const, documents: [] }, label: "MR 已关闭", action: "archive-retry" },
    ];
    job.publications = cases.map(item => item.publication);
    for (const item of cases) {
      const projected = projectKnowledgeProduction({ kind: "domain", record: job });
      assert.equal(projected.status_label, `已入库 · ${item.label}`);
      assert.equal(projected.group, "attention");
      assert.equal(projected.next_action.id, item.action);
      assert.equal(projected.archive.state, "failed");
      assert.deepEqual(componentKnowledgeTask(record, job).production, projectKnowledgeProduction({ kind: "component", record, archive: job }));
      assert.equal(componentKnowledgeTask(record, job).status_label, projected.status_label);
      assert.equal(componentKnowledgeTask(record, job).group, projected.group);
      job.publications.shift();
    }
    const projected = projectKnowledgeProduction({ kind: "domain", record: job });
    assert.equal(projected.status_label, "已入库 · 归档待处理"); assert.equal(projected.group, "attention");
    assert.equal(projected.next_action.id, "archive-retry");
  }
});

for (const paths of [undefined, []] as const) {
  test(`生产线验收8：远端待核对的路径${paths === undefined ? "未提供" : "为空"}时仍给出逐篇核对动作，确认后可以推进归档`, () => {
    const job = domain();
    job.publications = [{ target_id: "domain", branch: "diverged", state: "merged", sync_state: "diverged", documents: [], diverged_paths: paths === undefined ? undefined : [...paths] }];
    const projected = projectKnowledgeProduction({ kind: "domain", record: job });
    assert.equal(projected.status_label, "已入库 · 远端待核对");
    assert.equal(projected.next_action.id, "compare");
    assert.equal(projected.next_action.document_id, job.documents[0].id);
    assert.deepEqual(projected.archive.actions.filter(action => action.id === "compare").map(action => action.document_id), [job.documents[0].id]);
  });
}

test("生产线验收8：共用Git仓与分支的多个归档目标，差异动作仍绑定原目标文稿，不能丢失核对入口", () => {
  const job = domain();
  job.repositories = [{ ...job.knowledge_target, id: "repo-alias", name: "相同源码仓" }];
  job.documents[0].target_id = "repo-alias";
  job.publications = [{ target_id: "domain", branch: "diverged", state: "merged", documents: [], sync_state: "diverged", diverged_paths: [job.documents[0].path] }];
  const projected = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(projected.next_action.id, "compare");
  assert.equal(projected.next_action.document_id, job.documents[0].id);
  assert.equal(projected.archive.publications[0].comparisons[0]?.document_id, job.documents[0].id);
  job.repositories[0].branch = "another-branch";
  const isolated = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(isolated.archive.publications[0].comparisons.length, 0, "不能把另一个分支的文稿当作本次待核对对象");
});

test("生产线验收8：缺少明确的草稿发布版本不从正式哈希、MR或时间猜测已审查，仍显示待审查", () => {
  const job = domain();
  delete job.documents[0].published_document_revision;
  job.documents[0].published_at = "2026-10-03T00:00:00Z";
  job.publications = [{ target_id: "domain", branch: "merged", state: "merged", documents: [] }];
  const projected = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(projected.documents[0].published_revision, undefined);
  assert.equal(projected.documents[0].changed, true);
  assert.equal(projected.status_label, "待审查"); assert.equal(projected.group, "attention");
  assert.equal(projected.next_action.id, "review");
});

async function within<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

test("生产线验收8：真实磁盘与TaskService启动后，任务中心、领域和组件列表详情的状态分组下一步及归档字段完全一致", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-production-http-state-"));
  const cases = [
    { name: "同步失败", research: "failed" as const, publication: { target_id: "domain", branch: "sync", state: "merged" as const, documents: [], sync_state: "failed" as const, sync_error: "远端同步失败" }, label: "已入库 · 同步失败", group: "attention", action: "archive-retry" },
    { name: "远端差异", research: "failed" as const, publication: { target_id: "domain", branch: "diff", state: "merged" as const, documents: [], sync_state: "diverged" as const, diverged_paths: ["docs/a.md"] }, label: "已入库 · 远端待核对", group: "attention", action: "compare" },
    { name: "MR关闭", research: "failed" as const, publication: { target_id: "domain", branch: "closed", state: "closed" as const, documents: [] }, label: "已入库 · MR 已关闭", group: "attention", action: "archive-retry" },
    { name: "归档失败", research: "failed" as const, failedBatch: true, label: "已入库 · 归档待处理", group: "attention", action: "archive-retry" },
    { name: "只有研究失败", research: "failed" as const, label: "执行失败", group: "attention", action: "resume" },
    { name: "未配置归档", research: "done" as const, unconfigured: true, label: "已入库 · 未配置 Git 归档", group: "attention", action: "configure" },
    { name: "全部完成", research: "done" as const, publication: { target_id: "domain", branch: "completed", state: "unchanged" as const, documents: [] }, label: "已入库", group: "completed", action: "knowledge" },
  ];
  const identities: Array<{ case: typeof cases[number]; kind: "domain" | "component"; id: string; archiveId: string }> = [];
  for (const item of cases) for (const kind of ["domain", "component"] as const) {
    const id = `${kind === "domain" ? "dkx" : "cr"}-${randomUUID()}`, archiveId = kind === "domain" ? id : `dkx-${randomUUID()}`;
    const formal = saveKnowledgeDocument(dir, { title: `${kind}-${item.name}`, content: "已入库规则", scope: "platform", technologies: kind === "component" ? ["java"] : [] }, "alice");
    const job = domain(); job.id = archiveId; job.title = `${kind}-${item.name}`; job.status = item.research;
    job.documents[0] = { ...job.documents[0], knowledge_document_id: formal.id, content: formal.content, published_revision: formal.revision };
    job.publications = item.publication ? [item.publication] : [];
    if (item.unconfigured) job.archive_configured = false;
    if (kind === "component") job.component_research_id = id;
    if (item.publication || item.failedBatch) job.archive_batches = [{ id: `batch-${randomUUID()}`, operator: "alice", created_at: job.created_at,
      state: item.failedBatch ? "failed" : "done", error: item.failedBatch ? "Git推送失败" : undefined,
      targets: [job.knowledge_target], documents: structuredClone(job.documents), publications: structuredClone(job.publications) }];
    const jobPath = join(dir, "domain-extraction", archiveId, "job.json"); mkdirSync(dirname(jobPath), { recursive: true }); writeFileSync(jobPath, JSON.stringify(job));
    if (kind === "component") {
      const record = component(id); record.status = item.research; record.document_id = formal.id; record.published_revision = formal.revision;
      const recordPath = join(dir, "component-research", id, "record.json"); mkdirSync(dirname(recordPath), { recursive: true }); writeFileSync(recordPath, JSON.stringify(record));
    }
    identities.push({ case: item, kind, id, archiveId });
  }
  const service = new TaskService({ dataDir: dir, provider: "", model: "", modelsJson: {}, maxConcurrent: 0 });
  const server = createTaskServer(service);
  try {
    await within(new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }), 5_000, "HTTP测试服务启动超过5秒预算");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    async function read(path: string) {
      const response = await fetch(base + path, { signal: AbortSignal.timeout(5_000) });
      assert.equal(response.status, 200, `${path} ${await response.clone().text()}`);
      return await response.json() as any;
    }
    const [center, domains, components] = await Promise.all([read("/knowledge-tasks"), read("/domain-extraction"), read("/component-research")]);
    assert.deepEqual(center.warnings, []);
    for (const identity of identities) {
      const path = `/${identity.kind === "domain" ? "domain-extraction" : "component-research"}/${identity.id}`;
      const detail = await read(path), row = center.tasks.find((row: any) => row.id === identity.id);
      assert.ok(row, identity.case.name);
      assert.equal(row.status_label, identity.case.label); assert.equal(row.group, identity.case.group);
      assert.equal(row.next_action.id, identity.case.action);
      assert.deepEqual(row.production, detail.production, `${identity.kind} ${identity.case.name} 的中心与详情必须来自同一投影`);
      assert.deepEqual(row.next_action, detail.production.next_action);
      const listed = (identity.kind === "domain" ? domains : components).records.find((record: any) => record.id === identity.id);
      assert.deepEqual(listed.production, detail.production, "摘要删正文也不能重新推断状态");
      if (identity.kind === "component") {
        const archive = await read(`/component-research/${identity.id}/archive`);
        assert.deepEqual(archive.archive.production.archive, detail.production.archive, "组件归档详情与组件任务的归档事实必须一致");
      }
    }
    assert.equal(center.summary.running, 0);
    assert.equal(center.summary.attention, identities.filter(identity => identity.case.group === "attention").length);
    assert.equal(center.summary.total, identities.length);
  } finally {
    await within(service.shutdown(), 5_000, "状态测试TaskService关停超过5秒预算");
    await within(new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }), 5_000, "状态测试HTTP关停超过5秒预算");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("生产线验收8：组件已有正式ID及已准备归档文稿，但尚无批次或publication时明确未归档并给出补建归档", () => {
  const record = component(), archive = domain();
  archive.component_research_id = record.id;
  archive.documents[0].knowledge_document_id = record.document_id;
  archive.archive_batches = []; archive.publications = [];
  const projected = projectKnowledgeProduction({ kind: "component", record, archive });
  assert.equal(projected.knowledge_document_id, record.document_id);
  assert.equal(projected.status_label, "已入库 · 未归档"); assert.equal(projected.group, "attention");
  assert.equal(projected.archive.status_label, projected.status_label); assert.equal(projected.archive.group, "attention");
  assert.equal(projected.next_action.id, "build-archive"); assert.equal(projected.next_action.view, "archive");
  assert.ok(projected.archive.actions.some(action => action.id === "build-archive"));
  const href = new URLSearchParams(projected.next_action.href);
  assert.equal(href.get("kbKind"), "component"); assert.equal(href.get("kbTask"), record.id);
  assert.equal(href.get("kbStage"), "publish");
});

test("生产线验收8：组件已绑定更新基线且修订章节有内容，研究动作应确认发布当前草稿而非再发起更新", () => {
  const record = component();
  record.update_document_id = record.document_id; record.update_document_revision = "a".repeat(64); delete record.document_id;
  record.document = { overview: "修订后的组件说明", sections: [{ id: "files", title: "文件处理", repository_ids: [record.component.id], selected: true, revision: 2,
    content: "补充失败时的资源释放", interfaces: "Close(handle)", integration: "链接文件组件库", example: "```cpp\nClose(handle);\n```", sources: "src/file.cpp:1", related_ids: [] }] };
  const projected = projectKnowledgeProduction({ kind: "component", record });
  assert.equal(projected.status_label, "待审查"); assert.equal(projected.group, "attention");
  assert.equal(projected.next_action.id, "review");
  assert.deepEqual(projected.research_actions.map(action => action.id), ["publish"]);
  assert.ok(projected.research_actions.every(action => /发布/.test(action.label)));
  assert.equal(projected.knowledge_document_id, record.update_document_id);
  assert.match(projected.platform_message ?? "", /继续使用已入库知识/);
});

const deterministicArchiveErrors = [
  { name: "401", reason: "MR 创建失败：HTTP 401：个人令牌已过期；请到个人设置 → CodeHub更新令牌" },
  { name: "400", reason: "MR 创建失败：HTTP 400：缺少 mr_create_knowledge 配置；请联系管理员" },
  { name: "403", reason: "MR 创建失败：HTTP 403：账号缺少目标仓权限；请联系仓库管理员" },
  { name: "404", reason: "MR 状态查询失败：HTTP 404：目标MR不存在；请联系管理员检查平台地址" },
  { name: "非快进", reason: "Git 非快进：远端分支已有新提交；请先拉取并核对远端更新后再发布" },
];
for (const failure of deterministicArchiveErrors) {
  test(`生产线验收8/9：确定性归档${failure.name}保留具体原因，不提供无效重试，下一步打开原因处理`, () => {
    const archive = domain(), record = component();
    archive.status = record.status = "failed";
    archive.publications = [{ target_id: "domain", branch: "deterministic", state: "failed", documents: [], error: failure.reason }];
    archive.archive_batches = [{ id: "failed-batch", operator: "alice", created_at: archive.created_at, state: "failed", documents: structuredClone(archive.documents),
      targets: [archive.knowledge_target], publications: structuredClone(archive.publications), error: failure.reason }];
    for (const projected of [projectKnowledgeProduction({ kind: "domain", record: archive }), projectKnowledgeProduction({ kind: "component", record, archive })]) {
      assert.equal(projected.status_label, "已入库 · 归档待处理"); assert.equal(projected.group, "attention");
      assert.equal(projected.archive.message, failure.reason);
      assert.equal(projected.archive.state, "failed");
      assert.ok(projected.archive.actions.every(action => action.id !== "archive-retry" && !/重试/.test(action.label)));
      assert.notEqual(projected.next_action.id, "archive-retry"); assert.equal(projected.next_action.view, "archive");
      assert.match(projected.next_action.label, /原因/);
      const href = new URLSearchParams(projected.next_action.href);
      assert.equal(href.get("kbPage"), "task"); assert.equal(href.get("kbStage"), "publish");
    }
  });
}

test("生产线验收5/8（F2/D5）：未核对的远端差异先比较，已核对且平台正文未变时下一步重试既有归档批次", () => {
  const job = domain();
  job.publications = [{ target_id: "domain", branch: "reviewed-divergence", state: "merged", documents: [],
    sync_state: "diverged", diverged_paths: [job.documents[0].path], sync_error: "请核对远端差异" }];
  job.archive_batches = [{ id: "same-version", created_at: job.created_at, operator: "alice", state: "done",
    documents: structuredClone(job.documents), targets: [job.knowledge_target], publications: structuredClone(job.publications) }];
  job.documents[0].remote_review = { id: "review-snapshot", target_revision: "c".repeat(40), target_content: "远端直接修改的规则", reviewed: false };
  const unreviewed = projectKnowledgeProduction({ kind: "domain", record: job });
  assert.equal(unreviewed.next_action.id, "compare");
  assert.ok(unreviewed.archive.actions.every(action => action.id !== "archive-retry"), "未核对不能绕过远端差异");
  job.documents[0].remote_review.reviewed = true;
  for (const projected of [projectKnowledgeProduction({ kind: "domain", record: job }), projectKnowledgeProduction({ kind: "component", record: component(), archive: job })]) {
    assert.equal(projected.next_action.id, "archive-retry", "已核对且保留平台版本应直接推进原批次，不能继续只叫人重复核对");
    assert.equal(projected.next_action.view, "archive");
    assert.ok(projected.archive.actions.some(action => action.id === "archive-retry"));
    assert.equal(new URLSearchParams(projected.next_action.href).get("kbStage"), "publish");
  }
});

test("生产线验收5/8（F2/D5）：真实领域核对保留平台版本不制造修订，组件archiveFor与中心均给出能推进的重试动作", { timeout: 15_000 }, async () => {
  const { DomainKnowledgeExtraction } = await import("../src/domainKnowledgeExtraction.ts");
  const { ComponentResearch } = await import("../src/componentResearch.ts");
  const { readKnowledgeDocument } = await import("../src/knowledgeDocuments.ts");
  const dir = mkdtempSync(join(tmpdir(), "knowledge-reviewed-divergence-status-"));
  const path = "docs/retry.md";
  let publishCalls = 0;
  const domains = new DomainKnowledgeExtraction(dir, async input => {
    input.save({ id: "retry", title: "已核对的规则", target_id: "domain", path, layer: "domain", content: "保留平台规则", sources: "固定源码" },
      { revision: "b".repeat(40), content: null });
    return "研究完成";
  }, {
    publish: async (job, target) => ({ target_id: target.id, state: "opened", branch: `codex/reviewed-${++publishCalls}`,
      url: `https://example.test/merge_requests/${publishCalls}`, mr_id: publishCalls,
      documents: job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision,
        knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision })) }),
    refresh: async (_job, publication) => ({ ...publication, state: "merged", sync_state: "diverged", diverged_paths: [path], sync_error: "请核对远端差异" }),
    readRemote: async () => ({ id: "live-review-snapshot", target_revision: "c".repeat(40), target_content: "业务方直接改过的规则", reviewed: false }),
  });
  let components: InstanceType<typeof ComponentResearch> | undefined;
  const settled = async (check: () => boolean, message: string) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(message);
  };
  try {
    const { id } = domains.create({ title: "核对归档后的下一步", scope: "验证核对后可继续", issue_no: "REQ-actions", issue_description: "核对归档动作",
      repositories: [], knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "docs" } }, "alice");
    await settled(() => domains.get(id).status === "done", "研究未在5秒内结束");
    await domains.publish(id, "alice");
    await settled(() => domains.get(id).archive_batches?.[0].state === "done", "归档未在5秒内完成");
    await domains.refresh(id, "alice");
    const before = domains.get(id), baseline = before.documents[0], formalId = baseline.knowledge_document_id!;
    const formalRevision = readKnowledgeDocument(dir, formalId).revision;
    assert.equal(before.production?.next_action.id, "compare");
    const reading = await domains.readRemote(id, baseline.id, "alice");
    assert.equal(reading.production?.next_action.id, "compare");
    assert.equal(reading.documents[0].remote_review?.reviewed, false);
    const reviewed = domains.reconcile(id, { document: baseline, base_revision: baseline.revision,
      snapshot_id: reading.documents[0].remote_review!.id }, "alice");
    assert.equal(reviewed.documents[0].content, baseline.content);
    assert.equal(reviewed.documents[0].revision, baseline.revision, "只核对并保留同一正文不能制造尚未发布的假修订");
    assert.equal(readKnowledgeDocument(dir, formalId).revision, formalRevision);
    assert.equal(reviewed.documents[0].remote_review?.reviewed, true);
    const componentRecord = component(`cr-${randomUUID()}`);
    componentRecord.document_id = formalId; componentRecord.published_revision = formalRevision;
    const recordPath = join(dir, "component-research", componentRecord.id, "record.json");
    mkdirSync(dirname(recordPath), { recursive: true }); writeFileSync(recordPath, JSON.stringify(componentRecord));
    components = new ComponentResearch(dir, async () => { throw new Error("已完成的组件记录不应再次研究"); }, undefined, undefined,
      () => domains.get(id));
    const projections = [reviewed.production, domainKnowledgeTask(reviewed).production,
      components.get(componentRecord.id).production, componentKnowledgeTask(components.get(componentRecord.id), domains.get(id)).production];
    for (const projected of projections) {
      assert.equal(projected?.next_action.id, "archive-retry", "中心与两类详情须提供实际可以推动归档的下一步");
      assert.ok(projected?.archive.actions.some(action => action.id === "archive-retry"));
    }
    domains.retryArchive(id, "alice");
    await settled(() => publishCalls === 2 && domains.get(id).archive_batches?.[0].state === "done", "重试动作未在5秒内推进原批次");
    assert.equal(domains.get(id).archive_batches?.length, before.archive_batches?.length, "重试只接续既有批次");
    assert.ok(domains.get(id).publications.every(publication => publication.sync_state !== "diverged"));
    assert.equal(readKnowledgeDocument(dir, formalId).revision, formalRevision);
  } finally {
    await within(Promise.all([domains.shutdown(), components?.shutdown()]), 5_000, "状态契约测试关停超过5秒预算");
    rmSync(dir, { recursive: true, force: true });
  }
});
