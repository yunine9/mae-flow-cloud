// 复现：批注交给 Agent 后，该轮失败/停止/建议被放弃，批注永远停在"已交给 Agent"，不能再次提交。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction, type DomainExecution } from "../../../src/domainKnowledgeExtraction.ts";
import { ComponentResearch } from "../../../src/componentResearch.ts";
import { applyKnowledgeReviewNotes, listKnowledgeReviewNotes, saveKnowledgeReviewNote } from "../../../src/knowledgeReviewNotes.ts";

const config = { title: "订单", scope: "订单规则", issue_no: "REQ-1", repositories: [{ repository: "https://example.test/orders.git", branch: "main" }],
  knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } };
async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error("timeout");
}

test("修订轮失败后批注锁死在 submitted，再次提交被拒", async () => {
  const dir = mkdtempSync(join(tmpdir(), "r6-notes-"));
  const service = new DomainKnowledgeExtraction(dir, async (input: DomainExecution) => {
    if (input.turn.mode !== "extract") throw new Error("模型服务当前限流（429）");
    input.update({ revisions: { "repo-1": "a".repeat(40) } });
    input.save({ id: "orders", title: "orders", target_id: "domain", path: "domains/orders.md", layer: "domain", content: "第一行\n第二行", sources: "源码" }, { revision: "b".repeat(40), content: null });
    return "完成";
  });
  const sources = { dataDir: dir, domain: service, component: new ComponentResearch(dir, async () => "") };
  try {
    const job = service.create(config, "alice"); await until(() => service.get(job.id).status === "done");
    const { notes } = saveKnowledgeReviewNote(sources, "domain", job.id, { document_id: "orders", scope: "document", note: "补充退款规则" }, "alice");
    applyKnowledgeReviewNotes(sources, "domain", job.id, { note_ids: [notes[0].id] }, "alice");
    await until(() => service.get(job.id).status === "failed");
    const state = listKnowledgeReviewNotes(sources, "domain", job.id).notes[0].status;
    let error = "";
    try { applyKnowledgeReviewNotes(sources, "domain", job.id, { note_ids: [notes[0].id] }, "alice"); } catch (e) { error = (e as Error).message; }
    console.log("[r6] 本轮失败后批注状态=", state, " 再次提交=", error);
    assert.equal(state, "submitted");
    assert.match(error, /已经提交修订或标为已处理/);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
