import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DomainKnowledgeExtraction, type DomainKnowledgeJob, type DomainPublication } from "../src/domainKnowledgeExtraction.ts";

const target = { repository: "https://example.test/knowledge.git", branch: "master", docs_path: "domains" };
async function done(service: DomainKnowledgeExtraction, id: string) {
  for (let i = 0; i < 200; i++) { const job = service.get(id); if (job.status === "done") return job; if (job.status === "failed") throw new Error(job.error); await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("研究未完成");
}
function receipt(job: DomainKnowledgeJob, targetId: string, sequence: number): DomainPublication {
  return { target_id: targetId, state: "opened", branch: `master_user_REQ_${sequence}`, mr_id: sequence, url: `https://example.test/mr/${sequence}`,
    documents: job.documents.map(doc => ({ id: doc.id, path: doc.path, revision: doc.revision, content: doc.content, knowledge_document_id: doc.knowledge_document_id, knowledge_revision: doc.published_revision })) };
}
async function initial(service: DomainKnowledgeExtraction) {
  const job = await done(service, service.create({ issue_no: "REQ-489", title: "知识", scope: "规则", repositories: [], knowledge_target: target }, "user").id);
  await service.publish(job.id, "user");
  await service.createArchive(job.id, { issue_no: "REQ-489", expected_revisions: service.previewArchive(job.id).expected_revisions }, "user");
  return service.get(job.id);
}
const execute: ConstructorParameters<typeof DomainKnowledgeExtraction>[1] = async input => {
  input.save({ id: "rules", title: "规则", target_id: "domain", path: "domains/rules.md", layer: "domain", content: "# 规则", sources: "源码" }); return "完成";
};

test("替换先创建新MR，撤销失败重启后只重试撤销并保留新旧链接", async () => {
  const root = mkdtempSync(join(tmpdir(), "archive-replacement-"));
  let published = 0, closed = 0, deny = true;
  const events: string[] = [];
  const options: ConstructorParameters<typeof DomainKnowledgeExtraction>[2] = {
    publish: async (job, target, previous) => { assert.equal(previous, undefined); events.push(`create:${++published}`); return receipt(job, target.id, published); },
    closePublication: async (_job, _target, publication, operator) => { assert.equal(operator, "reviewer"); events.push(`close:${publication.mr_id}`); closed++; if (deny) throw new Error("撤销服务暂不可用"); },
  };
  let service = new DomainKnowledgeExtraction(root, execute, options);
  try {
    let job = await initial(service);
    assert.ok(service.previewArchive(job.id).actions.some(action => action.id === "replace-archive"));
    const failed = await service.createArchive(job.id, { issue_no: "REQ-489", replace_existing: true, expected_revisions: service.previewArchive(job.id).expected_revisions }, "reviewer");
    assert.equal(failed.status_label, "归档失败"); assert.match(failed.message, /暂不可用/);
    job = service.get(job.id); const batch = job.archive_batches!.filter(batch => batch.issue_no).at(-1)!;
    assert.equal(batch.publications[0].url, "https://example.test/mr/2"); assert.equal(batch.replacements![0].publication.url, "https://example.test/mr/1");
    assert.equal(batch.replacements![0].state, "failed"); assert.equal(job.archive_batches!.find(old => old.id === batch.replacements![0].batch_id)!.state, "superseded");
    assert.deepEqual(events, ["create:1", "create:2", "close:1"]);
    await service.shutdown(); deny = false;
    service = new DomainKnowledgeExtraction(root, async () => { throw new Error("不得重新研究"); }, options);
    await service.retryArchive(job.id, "reviewer", { batch_id: batch.id });
    const restored = service.get(job.id).archive_batches!.find(current => current.id === batch.id)!;
    assert.equal(restored.state, "done"); assert.equal(restored.replacements![0].state, "closed"); assert.ok(restored.replacements![0].closed_at);
    assert.equal(published, 2); assert.equal(closed, 2);
    await service.retryArchive(job.id, "reviewer", { batch_id: batch.id }); assert.equal(closed, 2);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("重新创建采用本次单号和描述，失败批次重试保留本次输入而非下单信息", async () => {
  const root = mkdtempSync(join(tmpdir(), "archive-current-issue-"));
  const calls: Array<{ issue_no?: string; issue_description?: string }> = [];
  const service = new DomainKnowledgeExtraction(root, execute, {
    publish: async (job, target) => {
      calls.push({ issue_no: job.issue_no, issue_description: job.issue_description });
      if (calls.length === 2) throw new Error("临时连接故障");
      return receipt(job, target.id, calls.length);
    }, closePublication: async () => {},
  });
  try {
    const job = await initial(service);
    const preview = service.previewArchive(job.id);
    await service.createArchive(job.id, { issue_no: "REQ-NOW", issue_description: "新归档描述", replace_existing: true, expected_revisions: preview.expected_revisions }, "reviewer");
    const batch = service.get(job.id).archive_batches!.at(-1)!;
    assert.equal(service.get(job.id).issue_no, "REQ-489", "研究下单信息保持原样");
    service.setIssueNumber(job.id, "REQ-LATER", "下一次描述");
    await service.retryArchive(job.id, "reviewer", { batch_id: batch.id });
    assert.deepEqual(calls, [{ issue_no: "REQ-489", issue_description: undefined }, { issue_no: "REQ-NOW", issue_description: "新归档描述" }, { issue_no: "REQ-NOW", issue_description: "新归档描述" }]);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("修正目标仓和分支后普通新归档自动撤销旧目标MR，失败新MR不撤销旧MR", async () => {
  const root = mkdtempSync(join(tmpdir(), "archive-replacement-location-"));
  let calls = 0, fail = false; const closed: string[] = [];
  const service = new DomainKnowledgeExtraction(root, execute, {
    publish: async (job, target) => { calls++; if (fail) throw new Error("新 MR 创建失败"); return receipt(job, target.id, calls); },
    closePublication: async (_job, oldTarget, publication) => { closed.push(`${oldTarget.repository}:${oldTarget.branch}:${publication.mr_id}`); },
  });
  try {
    let job = await initial(service);
    job = service.configureArchive(job.id, { base_revision: job.archive_revision ?? 0, use_repository_layout: true,
      targets: [{ ...job.knowledge_target, repository: "https://example.test/correct.git", branch: "release", docs_path: "团队知识" }] });
    await service.publish(job.id, "user"); fail = true;
    const preview = await service.createArchive(job.id, { issue_no: "REQ-489", expected_revisions: service.previewArchive(job.id).expected_revisions }, "user");
    assert.equal(preview.status_label, "归档失败"); assert.deepEqual(closed, []);
    const batch = service.get(job.id).archive_batches!.filter(batch => batch.issue_no).at(-1)!;
    fail = false; await service.retryArchive(job.id, "user", { batch_id: batch.id });
    assert.deepEqual(closed, [`${target.repository}:master:1`]);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("相同新旧MR链接不会撤销，未完成旧批次不能被另一个版本丢弃", async () => {
  const root = mkdtempSync(join(tmpdir(), "archive-replacement-identity-")); let closes = 0;
  const service = new DomainKnowledgeExtraction(root, execute, {
    publish: async (job, target) => receipt(job, target.id, 1), closePublication: async () => { closes++; },
  });
  try {
    let job = await initial(service);
    await service.createArchive(job.id, { issue_no: "REQ-489", replace_existing: true, expected_revisions: service.previewArchive(job.id).expected_revisions }, "user");
    assert.equal(closes, 0); assert.match(service.previewArchive(job.id).message, /新旧 MR 链接相同/);
    job = service.get(job.id);
    service.edit(job.id, { document: { ...job.documents[0], content: "# 新规则" }, base_revision: job.documents[0].revision }, "user");
    await service.publish(job.id, "user");
    await assert.rejects(service.createArchive(job.id, { issue_no: "REQ-489", expected_revisions: service.previewArchive(job.id).expected_revisions }, "user"), /未完成的归档批次/);
    assert.equal(service.get(job.id).archive_batches!.filter(batch => batch.issue_no).length, 2);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});


test("旧 MR 已合入单独记录为 merged，新版本归档继续成功且下次可再归档", async () => {
  const root = mkdtempSync(join(tmpdir(), "archive-replacement-merged-")); let calls = 0;
  const service = new DomainKnowledgeExtraction(root, execute, {
    publish: async (job, target) => receipt(job, target.id, ++calls), closePublication: async () => "merged",
  });
  try {
    let job = await initial(service);
    await service.createArchive(job.id, { issue_no: "REQ-489", replace_existing: true, expected_revisions: service.previewArchive(job.id).expected_revisions }, "user");
    job = service.get(job.id); let batch = job.archive_batches!.filter(batch => batch.issue_no).at(-1)!;
    assert.equal(batch.state, "done"); assert.equal(batch.replacements![0].state, "merged");
    assert.ok(batch.replacements![0].merged_at); assert.equal(batch.replacements![0].closed_at, undefined);
    service.edit(job.id, { document: { ...job.documents[0], content: "# 后续更新" }, base_revision: job.documents[0].revision }, "user");
    await service.publish(job.id, "user");
    await service.createArchive(job.id, { issue_no: "REQ-489", expected_revisions: service.previewArchive(job.id).expected_revisions }, "user");
    batch = service.get(job.id).archive_batches!.filter(batch => batch.issue_no).at(-1)!;
    assert.equal(batch.state, "done"); assert.equal(calls, 3); assert.deepEqual(batch.replacements!.map(item => item.publication.mr_id), [2]);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});


test("分批迁移只归档A时保留包含A和B的旧MR，B发布后才一起替换", async () => {
  const root = mkdtempSync(join(tmpdir(), "archive-replacement-partial-")); let calls = 0; const closed: Array<string | number | undefined> = [];
  const service = new DomainKnowledgeExtraction(root, async input => {
    for (const id of ["a", "b"]) input.save({ id, title: id, target_id: "domain", path: `domains/${id}.md`, layer: "domain", content: `# ${id}`, sources: "源码" });
    return "完成";
  }, { publish: async (job, target) => receipt(job, target.id, ++calls), closePublication: async (_job, _target, publication) => { closed.push(publication.mr_id); } });
  try {
    let job = await initial(service);
    job = service.configureArchive(job.id, { base_revision: job.archive_revision ?? 0, use_repository_layout: true, targets: [{ ...job.knowledge_target, docs_path: "业务" }] });
    await service.publish(job.id, "user", { document_ids: ["a"], expected_revisions: { a: job.documents[0].revision } });
    await service.createArchive(job.id, { issue_no: "REQ-489", expected_revisions: service.previewArchive(job.id).expected_revisions }, "user");
    job = service.get(job.id); const old = job.archive_batches!.filter(batch => batch.issue_no)[0];
    assert.equal(old.state, "done"); assert.deepEqual(closed, []); assert.equal(calls, 2);
    assert.equal(job.archive_batches!.filter(batch => batch.issue_no).at(-1)!.documents.length, 1);
    await service.publish(job.id, "user", { document_ids: ["b"], expected_revisions: { b: job.documents[1].revision } });
    await service.createArchive(job.id, { issue_no: "REQ-489", expected_revisions: service.previewArchive(job.id).expected_revisions }, "user");
    assert.deepEqual(closed, [1, 2]); assert.equal(calls, 3);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
