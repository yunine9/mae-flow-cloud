import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { runDomainKnowledge } from "../src/domainKnowledgeAgent.ts";
import { runDomainResearchWorker } from "../src/domainResearchWorkerAgent.ts";
import { bundledExtractionSkill } from "../src/knowledgeExtractionSkills.ts";
import { businessKnowledgeEvidenceId } from "../src/domainResearchEvidence.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import type { DomainExecution, DomainResearch } from "../src/domainKnowledgeTypes.ts";
import type { DomainResearchReport, DomainResearchWorker } from "../src/domainResearchWorkers.ts";
import { useReturnedEvidence } from "./domainKnowledgeEvidenceFixture.ts";

test("无线豆包独立支撑主子研究：复用概览、追查需求设计与历史，再调查新的例外", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-doubao-")), executable = join(root, "cli");
  const values = { MAE_FLOW_WXDOUBAO_BIN: executable, WXDOUBAO_USERID: "fixture-user", WXDOUBAO_TOKEN: "fixture-credential" };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  writeFileSync(executable, `#!${process.execPath}
const action = process.argv[process.argv.indexOf("call") + 1];
const query = JSON.parse(process.argv[process.argv.indexOf("--json") + 1]);
const results = {
  ar_fur_info: { text: "取消需求的背景是避免已结算账务再次扣减", ar_code: "AR20260001" },
  ar_idp_docs: { text: "设计选择冲正而非直接删除，以保留审计链。冲正失败需要人工核对。", ar_code: "AR20260001" },
  ar_history_similar: { text: "AR20250002 曾处理类似问题；旧版本由一线团队核账，不能直接套用到现行流程。", ar_code: "AR20250002" },
  knowledge_search: (query.question ?? "").includes("人工")
    ? { text: "现行例外流程：冲正失败转财务核对，完成对账前不能重复取消。", url: "https://example.test/settlement-exceptions" }
    : { text: "结算后取消需要冲正；需求和历史原因见 AR20260001。", ar_code: "AR20260001", url: "https://example.test/settlement" }
};
console.log(JSON.stringify({result:{structuredContent:results[action]}}));`, { mode: 0o700 });
  const cap: DomainResearch["capabilities"][number] = { id: "settlement", title: "取消为何需要冲正", state: "pending", repository_ids: [],
    findings: "概览提到 AR20260001，继续查需求、设计取舍与例外", sources: [], document_ids: [], evidence_ids: [] };
  const report: DomainResearchReport = { findings: "为避免重复扣减并保留审计链，采用冲正；现行失败流程由财务核对，历史一线处理约定不直接沿用。",
    checks: { history: "区分历史约定与现行例外" }, evidence_ids: [], sources: [], open_questions: [] };
  const doc = { id: "settlement", title: "取消的业务原因与例外", target_id: "domain", path: "domains/settlement.md", layer: "domain",
    content: "# 取消与冲正\n" + report.findings, sources: "AR20260001 需求与设计；AR20250002 仅为历史参考；https://example.test/settlement-exceptions" };
  const main: Scene[] = [
    { tool: { name: "business_knowledge", input: { tool: "knowledge_search", question: "结算业务的主要场景与取消约束" } } },
    { tool: { name: "knowledge_research", input: { action: "upsert", capability: cap } } },
    { tool: { name: "knowledge_delegate", input: { action: "start", assignments: [{ capability_id: cap.id, question: "沿已检索到的 AR20260001 查原因、取舍与历史例外" }] } } },
    { text: "MAIN_PRIVATE_CONTEXT 等待子研究并继续整理问题" },
    { tool: { name: "knowledge_delegate", input: { action: "read", capability_id: cap.id } } },
    { tool: { name: "knowledge_draft", input: { action: "save", document: doc } } },
    { tool: { name: "knowledge_research", input: { action: "upsert", capability: { ...cap, ...report, state: "researched", document_ids: [doc.id] } } } },
    { tool: { name: "knowledge_research", input: { action: "inventory_complete" } } },
    { tool: { name: "knowledge_research", input: { action: "complete" } } },
    { text: "进入最终核对" },
    { tool: { name: "knowledge_draft", input: { action: "read", id: doc.id } } },
    { tool: { name: "knowledge_research", input: { action: "complete" } } },
    { text: "知识研究完成" },
  ];
  const readShared: Scene = { tool: { name: "knowledge_evidence", input: { action: "read", evidence_id: "由实际响应填充" } } };
  const child: Scene[] = [
    { tool: { name: "knowledge_evidence", input: { action: "list", query: "AR20260001" } } },
    { tool: { name: "knowledge_research_result", input: { action: "save", report: structuredClone(report) } } }, // 仅看摘要必须拒绝
    readShared,
    { tool: { name: "business_knowledge", input: { tool: "ar_fur_info", ar_code: "AR20260001" } } },
    { tool: { name: "business_knowledge", input: { tool: "ar_idp_docs", ar_code: "AR20260001" } } },
    { tool: { name: "business_knowledge", input: { tool: "ar_history_similar", ar_code: "AR20260001" } } },
    { tool: { name: "business_knowledge", input: { tool: "knowledge_search", question: "结算冲正失败目前由谁人工核对，与 AR20250002 的历史流程有什么变化" } } },
    { tool: { name: "knowledge_research_result", input: { action: "save", report } } },
    { text: "子研究报告已保存" },
  ];
  let mainIndex = 0, childIndex = 0;
  const model = new ScriptedModelServer(Array.from({ length: 50 }, () => ({ text: "未预期请求" })), "scripted-v1", { linear: true,
    beforeScene: ({ request, index }) => {
      if (request.tools?.some((t: { name: string }) => t.name === "knowledge_research_result")) {
        useReturnedEvidence(request, child);
        readShared.tool!.input.evidence_id = JSON.stringify(request.messages).match(/knowledge-evidence-[a-f0-9]{24}/)?.[0] ?? "尚未返回资料";
        model.script[index] = child[childIndex++] ?? { text: "子研究已完成" };
      } else { useReturnedEvidence(request, main); model.script[index] = main[mainIndex++] ?? { text: "主研究已完成" }; }
    } });
  const noSource = async () => { throw new Error("本次研究无需准备源码"); };
  const service = new DomainKnowledgeExtraction(root, input => runDomainKnowledge(input, { dataDir: root,
    model: () => ({ provider: "maeflow", model: "scripted-v1", json: model.modelsJson() }), source: noSource }));
  try {
    await model.start();
    const job = service.create({ issue_no: "REQ1", title: "结算知识", scope: "结算业务", material_ids: [], repositories: [{ repository: "https://example.test/business.git", branch: "master" }] }, "expert");
    for (let i = 0; i < 1000 && !["done", "failed"].includes(service.get(job.id).status); i++) await new Promise(r => setTimeout(r, 10));
    const result = service.get(job.id); assert.equal(result.status, "done", result.error);
    assert.equal(result.turns[0].research?.phase, "complete");
    assert.equal(result.evidence.filter(e => e.tool === "component_source" || e.tool === "knowledge_material").length, 0);
    const queries = result.evidence.filter(e => e.tool === "business_knowledge");
    assert.deepEqual(queries.map(e => e.action), ["knowledge_search", "ar_fur_info", "ar_idp_docs", "ar_history_similar", "knowledge_search"]);
    assert.ok(queries.every(e => e.status === "available" && e.evidence_id), JSON.stringify(queries));
    assert.equal(result.evidence.filter(e => e.tool === "knowledge_evidence" && e.worker_id === cap.id).length, 1);
    const childRequests = model.requests.filter((r: any) => r.tools?.some((t: { name: string }) => t.name === "knowledge_research_result"));
    assert.match(JSON.stringify(childRequests), /报告引用了该子研究未实际读取的业务资料/);
    assert.doesNotMatch(JSON.stringify(childRequests), /MAIN_PRIVATE_CONTEXT/);
    assert.match(result.documents[0].content, /财务核对/);

    // 新实例从持久记录恢复共享资料的读取，无需再次调用外部 CLI。
    const turn = result.turns[0], taskRoot = join(root, "domain-extraction", job.id);
    const worker: DomainResearchWorker = JSON.parse(readFileSync(join(taskRoot, "research-workers", turn.id, `${cap.id}.json`), "utf8"));
    const savedReport = structuredClone(worker.report!); worker.report = undefined;
    child.splice(childIndex, child.length, { tool: { name: "knowledge_research_result", input: { action: "save", report: savedReport } } }, { text: "原业务来源与结论仍可复用" });
    const input = { root: taskRoot, job: result, turn } as DomainExecution;
    await runDomainResearchWorker({ input, worker, signal: new AbortController().signal, capability: cap, skill: bundledExtractionSkill("domain"), dataDir: root,
      model: { provider: "maeflow", model: "scripted-v1", json: model.modelsJson() }, revisions: {}, source: noSource,
      evidence: row => { const id = businessKnowledgeEvidenceId(row); result.evidence.push({ ...row, evidence_id: id }); return id; }, save: value => { worker.report = value; } });
    assert.deepEqual(worker.report, savedReport);
    assert.equal(result.evidence.filter(e => e.tool === "business_knowledge").length, 5);
  } finally {
    await service.shutdown(); await model.stop();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});
