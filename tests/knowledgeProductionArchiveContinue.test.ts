// repros/r3 实测：closed 与已核对的 merged/diverged 必须共用继续判定，不能停在永久待处理。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction, type DomainExecution, type DomainPublication, type DomainKnowledgeJob } from "../src/domainKnowledgeExtraction.ts";
import { knowledgeArchiveState } from "../src/knowledgeArchiveStatus.ts";
import { domainKnowledgeTask } from "../src/knowledgeTaskCenter.ts";

const config = { title: "订单", scope: "订单规则", issue_no: "REQ-1", issue_description: "订单知识", repositories: [{ repository: "https://example.test/orders.git", branch: "main" }],
  knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } };
async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error("timeout");
}
function extract(input: DomainExecution) {
  input.update({ revisions: { "repo-1": "a".repeat(40) } });
  input.save({ id: "orders", title: "orders", target_id: "domain", path: "domains/orders.md", layer: "domain", content: "订单规则", sources: "源码" }, { revision: "b".repeat(40), content: null });
  return "完成";
}
const receipt = (job: DomainKnowledgeJob, targetId: string, n: number): DomainPublication => ({ target_id: targetId, state: "opened", branch: `codex/k-${n}`, url: `https://x/mr/${n}`, mr_id: n,
  documents: job.documents.map(d => ({ id: d.id, path: d.path, content: d.content, revision: d.revision, knowledge_document_id: d.knowledge_document_id, knowledge_revision: d.published_revision })) });

test("生产线验收5：MR关闭后重试重排现有批次，重新发布不再被去重挡住", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r3-closed-")); let publishCalls = 0;
  const service = new DomainKnowledgeExtraction(dir, async i => extract(i), {
    publish: async (job, target) => receipt(job, target.id, ++publishCalls),
    refresh: async (_job, publication) => ({ ...publication, state: "closed" }),
  });
  try {
    const job = service.create(config, "alice"); await until(() => service.get(job.id).status === "done");
    await service.publish(job.id, "alice"); await until(() => service.get(job.id).archive_batches?.[0].state === "done");
    await service.refresh(job.id, "alice");   // 平台上有人关闭了 MR
    const closed = service.get(job.id);
    assert.equal(knowledgeArchiveState(closed), "failed");
    console.log("[r3] 关闭后：任务中心=", domainKnowledgeTask(closed).status_label, " 归档状态=", knowledgeArchiveState(closed));
    service.retryArchive(job.id, "alice"); await new Promise(r => setTimeout(r, 100));
    await service.publish(job.id, "alice"); await new Promise(r => setTimeout(r, 100));
    assert.equal(publishCalls, 2, "关闭的MR允许重试创建新MR，同版重新发布去重不重复创建");
    assert.notEqual(knowledgeArchiveState(service.get(job.id)), "failed", "重试后归档恢复到可推进状态");
    console.log("[r3] 重试+重发后 publishCalls=", publishCalls, " 状态仍=", knowledgeArchiveState(service.get(job.id)));
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收5：刷新发现合入后远端差异，核对保留平台版本后可继续归档", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r3-diverged-")); let publishCalls = 0;
  const service = new DomainKnowledgeExtraction(dir, async i => extract(i), {
    publish: async (job, target) => receipt(job, target.id, ++publishCalls),
    refresh: async (_job, publication) => ({ ...publication, state: "merged", sync_state: "diverged", diverged_paths: ["domains/orders.md"], sync_error: "请核对远端差异" }),
    readRemote: async () => ({ id: "snap-1", target_revision: "c".repeat(40), target_content: "远端被人改过", reviewed: false }),
  });
  try {
    const job = service.create(config, "alice"); await until(() => service.get(job.id).status === "done");
    await service.publish(job.id, "alice"); await until(() => service.get(job.id).archive_batches?.[0].state === "done");
    await service.refresh(job.id, "alice");
    assert.equal(domainKnowledgeTask(service.get(job.id)).status_label, "已入库 · 远端待核对");
    await service.readRemote(job.id, "orders", "alice");
    const doc = service.get(job.id).documents[0];
    // 保留平台版本：正文不变，确认核对
    service.reconcile(job.id, { document: { id: doc.id, title: doc.title, target_id: doc.target_id, path: doc.path, layer: doc.layer, content: doc.content, sources: doc.sources }, base_revision: doc.revision, snapshot_id: "snap-1" }, "alice");
    await service.publish(job.id, "alice"); await new Promise(r => setTimeout(r, 100));
    service.retryArchive(job.id, "alice"); await new Promise(r => setTimeout(r, 100));
    const after = service.get(job.id);
    console.log("[r3] 保留平台版本后 publishCalls=", publishCalls, " 批次数=", after.archive_batches?.length, " 任务中心=", domainKnowledgeTask(after).status_label);
    assert.equal(publishCalls, 2, "核对后同版重新发布或重试应推动归档，去重避免重复MR");
    assert.ok(after.publications.every(p => p.sync_state !== "diverged"));
    assert.equal(after.archive_batches?.at(-1)?.state, "done");
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
