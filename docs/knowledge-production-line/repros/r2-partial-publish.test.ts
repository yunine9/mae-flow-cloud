// 复现：多篇发布时，第 2 篇写正式库失败 → 第 1 篇已生效，但 job.json 未落盘、没有归档批次、接口返回失败。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction, type DomainExecution } from "../../../src/domainKnowledgeExtraction.ts";
import { listKnowledgeDocuments } from "../../../src/knowledgeDocuments.ts";
import { createBusinessModule, updateBusinessModule } from "../../../src/businessModuleLibrary.ts";
import { knowledgeArchiveState } from "../../../src/knowledgeArchiveStatus.ts";
import { domainKnowledgeTask } from "../../../src/knowledgeTaskCenter.ts";

async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error("timeout");
}

test("跨文档发布中途失败：先写的正式知识已生效，但无归档批次、任务记录未落盘、接口报错", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r2-partial-"));
  createBusinessModule(dir, { id: "orders", name: "订单", description: "订单域", owner: "owner-a", repositories: ["https://example.test/orders.git"] }, "admin");
  let archiveCalls = 0;
  const service = new DomainKnowledgeExtraction(dir, async (input: DomainExecution) => {
    input.update({ revisions: { "repo-1": "a".repeat(40) } });
    const repo = input.job.repositories[0];
    // 先保存仓内文档（适用范围=repository，不校验业务模块），再保存领域文档（适用范围=module）
    input.save({ id: "repo-doc", title: "仓内", target_id: "repo-1", path: `${repo.docs_path}/repo.md`, layer: "repository", content: "仓内规则", sources: "源码" }, { revision: "b".repeat(40), content: null });
    input.save({ id: "domain-doc", title: "领域", target_id: "domain", path: "domains/domain.md", layer: "domain", content: "领域规则", sources: "源码" }, { revision: "b".repeat(40), content: null });
    return "完成";
  }, { publish: async (job, target) => { archiveCalls++; return { target_id: target.id, branch: "b", state: "opened", url: "https://x/mr/1", documents: [] }; } });
  try {
    const job = service.create({ issue_no: "REQ-1", module_id: "orders", knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } }, "alice");
    await until(() => service.get(job.id).status === "done");
    assert.deepEqual(service.get(job.id).documents.map(d => d.id), ["repo-doc", "domain-doc"]);
    updateBusinessModule(dir, "orders", { status: "archived" }, "admin");   // 发布前业务模块被停用
    await assert.rejects(service.publish(job.id, "alice"), /所选业务模块已停用/);
    const formal = listKnowledgeDocuments(dir);
    console.log("[r2] 正式库文档数=", formal.length, formal.map(d => `${d.title}/${d.scope}/active=${d.active}`));
    assert.equal(formal.length, 1, "第 1 篇已写入正式库并生效");
    const disk = JSON.parse(readFileSync(join(dir, "domain-extraction", job.id, "job.json"), "utf8"));
    assert.equal(disk.documents[0].knowledge_document_id, undefined, "job.json 没有记录第 1 篇已发布");
    assert.equal(disk.archive_batches, undefined, "没有归档批次");
    const memory = service.get(job.id);
    assert.ok(memory.documents[0].knowledge_document_id, "内存态却已记录发布（磁盘/内存分叉）");
    assert.equal(knowledgeArchiveState(memory), "done", "归档状态显示 done——已生效的知识永远不会归档，也无提示");
    console.log("[r2] 内存 doc0.knowledge_document_id=", memory.documents[0].knowledge_document_id, " 任务中心=", domainKnowledgeTask(memory).status_label, " 归档状态=", knowledgeArchiveState(memory), " archiveCalls=", archiveCalls);
    assert.equal(archiveCalls, 0);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
