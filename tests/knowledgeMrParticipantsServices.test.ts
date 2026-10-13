import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { KnowledgeSourceCleanup } from "../src/knowledgeSourceCleanup.ts";
import type { KnowledgeMrPublisher } from "../src/knowledgeMrPublisher.ts";
import type { KnowledgeCleanupPublication } from "../src/domainKnowledgeTypes.ts";
import type { MrParticipantsResult } from "../src/mrParticipants.ts";

const requested = { reviewers: ["reviewer"], approval_approvers: ["approver"] };
const failed: MrParticipantsResult = { status: "failed", requested, message: "人员服务暂不可用" };
const config = { issue_no: "REQ-479", issue_description: "归档订单知识", title: "订单", scope: "订单规则",
  repositories: [{ name: "订单仓", repository: "https://example.test/orders.git", branch: "main", docs_path: "docs/business" }],
  knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains/orders" } };
const document = { id: "orders", title: "订单", target_id: "domain", path: "domains/orders/orders.md", layer: "domain" as const,
  content: "订单规则", sources: "repo-1 / order.ts" };
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error("任务未完成");
}

test("归档人员失败保持已归档，重启后按仓补设；异常保留 MR，成功后不重复同步", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-archive-people-")), calls: string[] = [];
  let retryFails = true, service: DomainKnowledgeExtraction;
  const publish: NonNullable<ConstructorParameters<typeof DomainKnowledgeExtraction>[2]>["publish"] = async (_job, target, previous) => {
    calls.push(target.id);
    if (previous) {
      assert.equal(previous.url, "https://example.test/mr/domain");
      assert.deepEqual(previous.mr_participants?.requested, requested, "重试沿用 MR 保存的名单");
      assert.equal(service.get(_job.id).archive_batches!.find(batch => !!batch.issue_no)!.state, "done", "仅补人员不重新进入归档中");
      assert.deepEqual(previous.documents, [], "补人员不要求再有文件改动");
      if (retryFails) { retryFails = false; throw new DOMException("人员补设已取消", "AbortError"); }
      return { ...previous, mr_participants: { status: "applied", requested } };
    }
    return { target_id: target.id, branch: `main_fixture_${target.id}`, state: "opened", url: `https://example.test/mr/${target.id}`,
      documents: [], mr_participants: target.id === "domain" ? failed : { status: "applied", requested } };
  };
  service = new DomainKnowledgeExtraction(dir, async input => {
    input.save(document, { content: null, revision: "a".repeat(40) });
    input.save({ ...document, id: "implementation", layer: "repository", target_id: "repo-1", path: "docs/business/orders.md" }, { content: null, revision: "a".repeat(40) });
    return "已完成";
  }, { publish });
  try {
    const job = service.create(config, "alice"); await until(() => service.get(job.id).status === "done");
    await service.publish(job.id, "alice");
    await service.createArchive(job.id, { issue_no: config.issue_no, expected_revisions: service.previewArchive(job.id).expected_revisions }, "alice");
    const batchId = service.get(job.id).archive_batches!.find(batch => !!batch.issue_no)!.id;
    assert.equal(service.get(job.id).production!.status_label, "已归档");
    const preview = service.previewArchive(job.id);
    assert.equal(preview.status_label, "已归档");
    assert.deepEqual(preview.targets[0].mr_participants, failed);
    assert.equal(preview.targets[0].actions[0].label, "重试设置人员");
    assert.equal(preview.targets[1].actions.length, 0);
    await service.shutdown(); service = new DomainKnowledgeExtraction(dir, async () => { throw new Error("补人员不能执行研究"); }, { publish });
    assert.deepEqual(service.get(job.id).publications[0].mr_participants, failed);
    await service.retryArchive(job.id, "alice", { batch_id: batchId, target_id: "domain" });
    const retained = service.get(job.id);
    assert.equal(retained.archive_batches!.find(batch => batch.id === batchId)!.state, "done");
    assert.equal(retained.production!.status_label, "已归档");
    assert.equal(retained.publications.find(publication => publication.target_id === "domain")!.state, "opened");
    assert.equal(retained.publications.find(publication => publication.target_id === "domain")!.url, "https://example.test/mr/domain");
    assert.equal(retained.publications.find(publication => publication.target_id === "domain")!.mr_participants?.message, "人员补设已取消");
    await service.retryArchive(job.id, "alice", { batch_id: batchId, target_id: "domain" });
    assert.deepEqual(calls, ["domain", "repo-1", "domain", "domain"]);
    assert.equal(service.previewArchive(job.id).targets[0].mr_participants?.status, "applied");
    assert.equal(service.previewArchive(job.id).targets[0].actions.length, 0);
    await service.retryArchive(job.id, "alice", { batch_id: batchId });
    assert.equal(calls.length, 4, "成功的 MR 人员不持续同步");
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("归档回执校验人员结果，拒绝损坏的状态、名单和说明并保留旧格式兼容", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-archive-people-validation-"));
  const service = new DomainKnowledgeExtraction(dir, async input => {
    input.save(document, { content: null, revision: "a".repeat(40) }); return "已完成";
  }, { publish: async (_job, target) => ({ target_id: target.id, branch: "main_fixture", state: "opened", url: "https://example.test/mr/1", documents: [] }) });
  const reopened: DomainKnowledgeExtraction[] = [];
  try {
    const job = service.create(config, "alice"); await until(() => service.get(job.id).status === "done");
    await service.publish(job.id, "alice");
    await service.createArchive(job.id, { issue_no: config.issue_no, expected_revisions: service.previewArchive(job.id).expected_revisions }, "alice");
    await service.shutdown();
    const path = join(dir, "domain-extraction", job.id, "job.json"), original = JSON.parse(readFileSync(path, "utf8"));
    for (const result of [undefined, failed, { status: "skipped", requested, message: "已有 MR" }]) {
      const stored = structuredClone(original); stored.publications[0].mr_participants = result;
      writeFileSync(path, JSON.stringify(stored));
      const reader = new DomainKnowledgeExtraction(dir, async () => "unused"); reopened.push(reader);
      assert.equal(reader.get(job.id).publications[0].state, "opened"); await reader.shutdown();
    }
    for (const result of [null, { ...failed, status: "unknown" }, { ...failed, requested: [] },
      { ...failed, requested: { reviewers: ["bad account"], approval_approvers: [] } }, { ...failed, message: 123 }]) {
      const stored = structuredClone(original); stored.publications[0].mr_participants = result;
      writeFileSync(path, JSON.stringify(stored));
      const reader = new DomainKnowledgeExtraction(dir, async () => "unused"); reopened.push(reader);
      assert.throws(() => reader.get(job.id), /不存在/); await reader.shutdown();
    }
  } finally { await service.shutdown(); await Promise.all(reopened.map(reader => reader.shutdown())); rmSync(dir, { recursive: true, force: true }); }
});

function cleanupPublisher(calls: string[], retry: (previous: KnowledgeCleanupPublication) => Promise<KnowledgeCleanupPublication>): Pick<KnowledgeMrPublisher, "previewCleanup" | "publishCleanup"> {
  return {
    async previewCleanup(target) {
      return { id: `plan-${target.id}`, target_id: target.id, paths: ["docs/old"], target_revision: "a".repeat(40),
        entries: [{ path: "docs/old/orders.md", mode: "100644", oid: "b".repeat(40) }], selected_paths: ["docs/old/orders.md"] };
    },
    async publishCleanup(_job, target, plan, paths, previous) {
      calls.push(target.id);
      if (previous?.url) return retry(previous);
      if (target.id === "repo-2") throw new Error("第二仓尚未创建 MR");
      return { target_id: target.id, cleanup_plan_id: plan.id, removed_paths: paths as string[], branch: "main_fixture_REQ479", revision: "c".repeat(40),
        state: "opened", url: "https://example.test/mr/cleanup", documents: [], mr_participants: failed };
    },
  };
}

test("清理人员按仓重试只调用已建 MR；异常保留删除范围和链接，不创建其他待处理仓", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-cleanup-people-")), calls: string[] = [];
  let retryFails = true;
  const manager = new DomainKnowledgeExtraction(dir, async () => "已完成", { sourceCleanup: new KnowledgeSourceCleanup(cleanupPublisher(calls, async previous => {
    assert.deepEqual(previous.mr_participants?.requested, requested);
    assert.deepEqual(previous.removed_paths, ["docs/old/orders.md"]);
    if (retryFails) { retryFails = false; throw new Error("暂时无法补设人员"); }
    return { ...previous, mr_participants: { status: "applied", requested } };
  })) });
  try {
    const job = manager.create({ ...config, knowledge_target: undefined, prepare_cleanup: true, repositories: [...config.repositories, { ...config.repositories[0], repository: "https://example.test/payments.git" }] }, "alice");
    await manager.sourceCleanupAction(job.id, "preview", { paths_by_target: { "repo-1": ["docs/old"], "repo-2": ["docs/old"] } }, "alice");
    const selected_paths_by_target = { "repo-1": ["docs/old/orders.md"], "repo-2": ["docs/old/orders.md"] };
    await manager.sourceCleanupAction(job.id, "publish", { selected_paths_by_target }, "alice");
    assert.deepEqual(calls, ["repo-1", "repo-2"]);
    await assert.rejects(manager.sourceCleanupAction(job.id, "publish", { selected_paths_by_target, target_id: "repo-2" }, "alice"), /没有待重试的人员/);
    await assert.rejects(manager.sourceCleanupAction(job.id, "publish", { selected_paths_by_target: { ...selected_paths_by_target, "repo-1": [] }, target_id: "repo-1" }, "alice"), /原范围/);
    await manager.sourceCleanupAction(job.id, "publish", { selected_paths_by_target, target_id: "repo-1" }, "alice");
    const retained = manager.get(job.id).source_cleanup!.publications.find(publication => publication.target_id === "repo-1")!;
    assert.equal(retained.state, "opened"); assert.equal(retained.url, "https://example.test/mr/cleanup");
    assert.equal(retained.revision, "c".repeat(40)); assert.deepEqual(retained.removed_paths, ["docs/old/orders.md"]);
    assert.equal(retained.mr_participants?.message, "暂时无法补设人员");
    await manager.sourceCleanupAction(job.id, "publish", { selected_paths_by_target, target_id: "repo-1" }, "alice");
    assert.deepEqual(calls, ["repo-1", "repo-2", "repo-1", "repo-1"]);
    assert.equal(manager.get(job.id).source_cleanup!.publications.find(publication => publication.target_id === "repo-1")!.mr_participants?.status, "applied");
    await assert.rejects(manager.sourceCleanupAction(job.id, "publish", { selected_paths_by_target, target_id: "repo-1" }, "alice"), /没有待重试的人员/);
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("清理人员失败不阻止开始萃取；补设取消后保留原 MR 和名单", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-cleanup-people-cancel-")), calls: string[] = [], controller = new AbortController();
  const cleanup = new KnowledgeSourceCleanup(cleanupPublisher(calls, async () => { controller.abort(); controller.signal.throwIfAborted(); throw new Error("unreachable"); }));
  let executions = 0;
  const manager = new DomainKnowledgeExtraction(dir, async () => { executions++; return "已完成"; }, { sourceCleanup: cleanup });
  try {
    const job = manager.create({ ...config, knowledge_target: undefined, prepare_cleanup: true }, "alice");
    await manager.sourceCleanupAction(job.id, "preview", { paths_by_target: { "repo-1": ["docs/old"] } }, "alice");
    const selected_paths_by_target = { "repo-1": ["docs/old/orders.md"] };
    await manager.sourceCleanupAction(job.id, "publish", { selected_paths_by_target }, "alice");
    assert.equal(manager.get(job.id).production!.status_label, "待开始萃取");
    const candidate = manager.get(job.id), original = structuredClone(candidate.source_cleanup!.publications[0]);
    await assert.rejects(cleanup.action(candidate, "publish", { selected_paths_by_target, target_id: "repo-1" }, "alice", () => {}, controller.signal), /abort/i);
    assert.deepEqual(candidate.source_cleanup!.publications[0], original);
    await manager.sourceCleanupAction(job.id, "start", {}, "alice");
    await until(() => executions === 1);
    assert.equal(manager.get(job.id).source_cleanup!.started, true);
  } finally { await manager.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
