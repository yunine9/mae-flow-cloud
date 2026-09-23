import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainResearchProgress, IncompleteDomainResearch } from "../src/domainResearchProgress.ts";
import type { DomainExecution, DomainDocument, DomainResearch } from "../src/domainKnowledgeTypes.ts";

function fixture() {
  const documents: DomainDocument[] = [{ id: "rule", title: "规则", target_id: "domain", path: "domains/rule.md", layer: "domain", content: "业务规则", sources: "repo-1 src/rule.ts", revision: 1, selected: true, base_content: null, base_revision: "", history: [] }];
  let saved: DomainResearch | undefined;
  const input = { job: { scope: "研究完整业务", repositories: [{ id: "repo-1" }], evidence: [] }, turn: {},
    signal: new AbortController().signal, read: () => structuredClone(documents), update: (patch: { research?: DomainResearch }) => { if (patch.research) saved = structuredClone(patch.research); },
  } as unknown as DomainExecution;
  const progress = new DomainResearchProgress(input, { "repo-1": "current" });
  const use = async (params: object) => {
    const result = await progress.tool().execute("test", params as never, undefined, undefined, {} as never);
    return result as typeof result & { isError?: boolean };
  };
  const capability: DomainResearch["capabilities"][number] = { id: "rules", title: "订单规则", repository_ids: [], state: "researched", findings: "月底结算不能立即取消的业务原因来自历史评审", evidence_ids: ["biz-1"], sources: [], document_ids: ["rule"] };
  return { documents, input, progress, use, capability, saved: () => saved };
}
test("源码和平台文件不能替代业务资料，真实业务来源仍需最终全文核对", async () => {
  const f = fixture();
  await f.use({ action: "upsert", capability: f.capability }); await f.use({ action: "inventory_complete" });
  f.progress.observe({ tool: "component_source", action: "read", status: "returned", component_id: "repo-1", path: "src/rule.ts", revision: "old" });
  assert.equal((await f.use({ action: "complete" })).isError, true);
  f.progress.observe({ tool: "component_source", action: "read", status: "returned", component_id: "repo-1", path: ".cac/mae-flow/rule.ts", revision: "current" });
  await f.use({ action: "upsert", capability: { ...f.capability, repository_ids: ["repo-1"], sources: [{ repository_id: "repo-1", path: ".cac/mae-flow/rule.ts" }] } });
  assert.equal((await f.use({ action: "complete" })).isError, true);
  await f.use({ action: "upsert", capability: f.capability });
  f.progress.observe({ tool: "component_source", action: "read", status: "returned", component_id: "repo-1", path: "src/rule.ts", revision: "current" });
  assert.equal((await f.use({ action: "complete" })).isError, true, "读完源码仍不能声称查清了业务原因");
  f.progress.observe({ tool: "business_knowledge", action: "knowledge_search", status: "available", evidence_id: "biz-1", result: "历史评审的业务背景" });
  assert.ok(!(await f.use({ action: "complete" })).isError);
  assert.match(f.progress.next()!, /最终证据核对/);
  assert.equal((await f.use({ action: "complete" })).isError, true);
  f.progress.readDocument("rule"); f.documents[0].revision++;
  assert.equal((await f.use({ action: "complete" })).isError, true, "人工修改后旧核对无效");
  f.progress.readDocument("rule"); await f.use({ action: "complete" });
  assert.equal(f.progress.next(), undefined); assert.equal(f.saved()?.phase, "complete");
});
test("发现遗漏后恢复研究，进度可持久恢复；重复扫描不能冒充新进展", async () => {
  const f = fixture();
  await f.use({ action: "upsert", capability: { ...f.capability, state: "pending" } });
  assert.match(f.progress.next()!, /尚未完成研究/);
  const event = { tool: "knowledge_material", status: "returned", evidence_id: "biz-1", material_id: "material-1" };
  f.progress.observe(event); const count = f.progress.progress; f.progress.observe(event);
  assert.equal(f.progress.progress, count);
  f.input.turn.research = f.saved();
  const resumed = new DomainResearchProgress(f.input, { "repo-1": "current" });
  assert.equal(resumed.state.capabilities[0].state, "pending"); assert.match(resumed.anchor(), /订单规则/);
});
test("真实资料缺失保留未完成状态，失败和空检索不能当业务依据", async () => {
  const f = fixture();
  await f.use({ action: "inventory_complete" });
  await f.use({ action: "upsert", capability: { ...f.capability, state: "blocked", findings: "接口规格需要外部团队提供" } });
  assert.throws(() => f.progress.next(), IncompleteDomainResearch);
  await f.use({ action: "upsert", capability: { ...f.capability, checks: undefined } });
  assert.equal((await f.use({ action: "complete" })).isError, true);
  f.progress.observe({ tool: "business_knowledge", status: "failed", evidence_id: "biz-1" });
  f.progress.observe({ tool: "business_knowledge", status: "empty", evidence_id: "biz-1" });
  assert.equal((await f.use({ action: "complete" })).isError, true);
  assert.match(f.progress.next()!, /业务资料证据/);
});

test("有业务资料的知识主题无需仓库映射或源码阅读即可完成", async () => {
  const f = fixture();
  f.progress.observe({ tool: "knowledge_material", status: "returned", evidence_id: "biz-1", material_id: "material-1" });
  await f.use({ action: "upsert", capability: f.capability }); await f.use({ action: "inventory_complete" });
  assert.ok(!(await f.use({ action: "complete" })).isError); f.progress.next();
  f.progress.readDocument("rule"); await f.use({ action: "complete" });
  assert.equal(f.progress.next(), undefined);
});
