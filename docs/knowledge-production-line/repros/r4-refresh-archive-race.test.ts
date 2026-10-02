// 复现："publishing" 不是互斥：刷新进行中仍可重试归档（scheduleArchive 不检查 publishing），
// 刷新拿的是 await 前的旧快照，回写时整体覆盖归档刚写入的记录（lost update）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction, type DomainExecution, type DomainPublication, type DomainKnowledgeJob } from "../../../src/domainKnowledgeExtraction.ts";

const config = { title: "订单", scope: "订单规则", issue_no: "REQ-1", issue_description: "订单知识", repositories: [{ repository: "https://example.test/orders.git", branch: "main" }],
  knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } };
async function until(check: () => boolean) {
  for (let n = 0; n < 400; n++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error("timeout");
}
function extract(input: DomainExecution) {
  input.update({ revisions: { "repo-1": "a".repeat(40) } });
  input.save({ id: "orders", title: "orders", target_id: "domain", path: "domains/orders.md", layer: "domain", content: "订单规则 v1", sources: "源码" }, { revision: "b".repeat(40), content: null });
  return "完成";
}
const docs = (job: DomainKnowledgeJob) => job.documents.map(d => ({ id: d.id, path: d.path, content: d.content, revision: d.revision, knowledge_document_id: d.knowledge_document_id }));

test("刷新与重试归档并发：刷新回写旧快照，覆盖刚推送的版本记录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r4-race-"));
  let calls = 0, release!: () => void; const gate = new Promise<void>(r => release = r); let gated = false;
  const service = new DomainKnowledgeExtraction(dir, async i => extract(i), {
    publish: async (job, target, previous, _op, save) => {
      calls++;
      if (calls === 1) return { target_id: target.id, state: "opened", branch: "codex/k-1", url: "https://x/mr/1", mr_id: 1, revision: "sha-v1", documents: docs(job) };
      if (calls === 2) { save({ ...previous!, state: "pending", attempted_documents: docs(job) }); throw new Error("Git 网络抖动"); }
      return { ...previous!, state: "opened", revision: "sha-v2", documents: docs(job), attempted_documents: undefined };
    },
    refresh: async (_job, publication) => { if (gated) await gate; return { ...publication, state: "opened" }; },   // 平台如实返回 opened
  });
  try {
    const job = service.create(config, "alice"); await until(() => service.get(job.id).status === "done");
    await service.publish(job.id, "alice"); await until(() => service.get(job.id).archive_batches?.[0].state === "done");
    const doc = service.get(job.id).documents[0];
    service.edit(job.id, { document: { id: doc.id, title: doc.title, target_id: doc.target_id, path: doc.path, layer: doc.layer, content: "订单规则 v2", sources: doc.sources }, base_revision: doc.revision }, "alice");
    await service.publish(job.id, "alice"); await until(() => service.get(job.id).archive_batches?.[1]?.state === "failed");
    gated = true;
    const refreshing = service.refresh(job.id, "alice");                 // A：刷新 MR 状态（慢）
    assert.doesNotThrow(() => service.retryArchive(job.id, "bob"));       // B：同时重试——未被拦
    await until(() => service.get(job.id).archive_batches?.[1].state === "done");
    const pushed = service.get(job.id).publications[0];
    release(); await refreshing;
    const after = service.get(job.id).publications[0];
    console.log("[r4] 重试归档写入:", pushed.revision, pushed.documents.map(d => d.content), "→ 刷新回写后:", after.revision, after.documents.map(d => d.content), "error=", after.error);
    assert.equal(pushed.revision, "sha-v2");
    assert.equal(after.revision, "sha-v1", "刷新用旧快照覆盖了刚推送的版本记录");
    assert.deepEqual(after.documents.map(d => d.content), ["订单规则 v1"]);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
