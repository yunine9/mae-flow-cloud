import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DomainResearchWorkers, type DomainResearchReport } from "../src/domainResearchWorkers.ts";
import { runDomainResearchWorker } from "../src/domainResearchWorkerAgent.ts";
import { bundledExtractionSkill } from "../src/knowledgeExtractionSkills.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import type { DomainExecution, DomainResearch } from "../src/domainKnowledgeTypes.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { runDomainKnowledge } from "../src/domainKnowledgeAgent.ts";
import type { Scene } from "../src/scriptedModel.ts";
import { businessMaterial, useReturnedEvidence } from "./domainKnowledgeEvidenceFixture.ts";
import { businessKnowledgeEvidenceId } from "../src/domainResearchEvidence.ts";

const report: DomainResearchReport = { findings: "月底结算限制来自历史重复扣款问题", checks: { background: "业务评审记录说明不能直接取消的原因" }, evidence_ids: [], sources: [], open_questions: [] };
const capability = (id: string): DomainResearch["capabilities"][number] => ({ id, title: `知识主题 ${id}`, repository_ids: [], state: "pending", findings: "", evidence_ids: [], sources: [], document_ids: [] });
async function until(check: () => boolean) { for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error("等待研究超时"); }

test("子研究最多两个并行，重复调用复用结果，未读报告阻止整体完成", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-workers-")), release = new Map<string, () => void>();
  const calls: string[] = []; let active = 0, maximum = 0;
  const workers = new DomainResearchWorkers({ root, signal: new AbortController().signal, capability,
    evidence: () => {}, run: async (record, signal, save) => {
      calls.push(record.capability_id); active++; maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => { release.set(record.capability_id, resolve); signal.addEventListener("abort", () => resolve(), { once: true }); });
      active--; signal.throwIfAborted(); save(report);
    } });
  try {
    const assignments = ["a", "b", "c"].map(id => ({ capability_id: id, question: "核对状态" }));
    workers.start(assignments); await until(() => release.size === 2);
    assert.deepEqual(calls, ["a", "b"]); workers.start([assignments[0]]); assert.equal(calls.length, 2);
    release.get("a")!(); await until(() => release.has("c"));
    release.get("b")!(); release.get("c")!(); await workers.waitForIdle();
    assert.equal(maximum, 2); assert.equal(workers.gaps().length, 3);
    for (const a of assignments) assert.equal(workers.read(a.capability_id).report?.findings, report.findings);
    assert.equal(workers.gaps().length, 0); workers.start(assignments); await workers.waitForIdle();
    assert.equal(calls.length, 3, "已经完成的问题不会重新调用模型");
  } finally { await workers.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("停止取消全部子研究，重启恢复未完成项并保留已完成报告", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-worker-restart-")), controller = new AbortController();
  const calls: string[] = [];
  let workers = new DomainResearchWorkers({ root, signal: controller.signal, capability, evidence: () => {}, run: async (record, signal, save) => {
    calls.push(record.capability_id);
    if (record.capability_id === "a") { save(report); return; }
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); signal.throwIfAborted();
  } });
  try {
    workers.start(["a", "b", "c"].map(id => ({ capability_id: id, question: "核对状态" })));
    await until(() => calls.length === 3 && workers.list()[0].status === "done");
    controller.abort(); await workers.shutdown();
    assert.equal(JSON.parse(readFileSync(join(root, "b.json"), "utf8")).status, "running");
    const resumed: string[] = [];
    workers = new DomainResearchWorkers({ root, signal: new AbortController().signal, capability, evidence: () => {}, run: async (record, _signal, save) => { resumed.push(record.capability_id); save(report); } });
    workers.restore(); await workers.waitForIdle();
    assert.deepEqual(resumed, ["b", "c"]); assert.equal(workers.read("a").report?.findings, report.findings);
  } finally { await workers.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("真实子 Agent 重启恢复独立上下文，不能写主草稿，来源和报告可复用", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-worker-pi-")), source = join(root, "source"); mkdirSync(source);
  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "master"); writeFileSync(join(source, "code.ts"), "const ORIGINAL_CONTEXT = true;\n"); git("add", "."); git("-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
  const revision = git("rev-parse", "HEAD"); let paused = false, release!: () => void;
  const hold = new Promise<void>(resolve => release = resolve);
  const material = await businessMaterial(root);
  const model = new ScriptedModelServer([
    { tool: { name: "knowledge_material", input: { id: material.id } } },
    { tool: { name: "knowledge_research_result", input: { action: "save", report } } },
    { tool: { name: "knowledge_research_result", input: { action: "save", report } } },
    { text: "该能力调查完成，供主 Agent 核对" },
  ], "scripted-v1", { linear: true, beforeScene: async ({ request, index }) => { useReturnedEvidence(request, model.script); if (index === 1 && !paused) { paused = true; await hold; } } });
  await model.start();
  const evidence: Array<Record<string, unknown>> = [], revisions = { "repo-1": revision };
  const input = { root, turn: { id: "turn-1" }, job: { id: "job-1", scope: "状态研究", material_ids: [material.id], ar_codes: [], evidence,
    repositories: [{ id: "repo-1", repository: "https://example.test/business.git", branch: "master", path: "", name: "业务" }] } } as unknown as DomainExecution;
  const make = () => new DomainResearchWorkers({ root: join(root, "research-workers", "turn-1"), signal: new AbortController().signal,
    capability, evidence: row => evidence.push(row), run: (worker, signal, save) => runDomainResearchWorker({ input, worker, signal, save, dataDir: root,
      capability: capability(worker.capability_id), skill: bundledExtractionSkill("domain"), model: { provider: "maeflow", model: "scripted-v1", json: model.modelsJson() },
      revisions, source: async () => { throw new Error("本例无需源码"); }, evidence: row => { const id = businessKnowledgeEvidenceId(row); evidence.push({ ...row, evidence_id: id }); return id; } }) });
  let workers = make();
  try {
    workers.start([{ capability_id: "states", question: "核对初始状态" }]); await until(() => paused);
    await workers.shutdown(); release(); workers = make(); workers.restore(); await workers.waitForIdle();
    const result = workers.read("states"); assert.equal(result.status, "done", result.error); assert.deepEqual(result.report, report);
    assert.equal(evidence.filter(e => e.tool === "knowledge_material" && e.action === "read").length, 1);
    assert.equal(evidence.filter(e => e.tool === "component_source").length, 0);
    assert.match(JSON.stringify(model.requests.at(-1)), /ORIGINAL_BUSINESS_CONTEXT/);
    assert.match(readFileSync(join(root, "research-workers", "turn-1", "states", "events.jsonl"), "utf8"), /"context_restored":true/);
    const tools = (model.requests[0].tools as Array<{ name: string }>).map(t => t.name);
    assert.ok(tools.includes("knowledge_research_result"));
    for (const name of ["knowledge_draft", "knowledge_delegate", "knowledge_research", "Task", "bash", "write"]) assert.ok(!tools.includes(name), `${name} 不属于子研究权限`);
  } finally { release(); await workers.shutdown(); await model.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("业务资料驱动主子研究：上下文压缩后交回证据，完全不读源码也能完成", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-delegation-")), source = join(root, "source"); mkdirSync(source);
  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "master"); writeFileSync(join(source, "code.ts"), "const ORIGINAL_CONTEXT = true;\n// " + "业务状态与失败约束".repeat(3000));
  git("add", "."); git("-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
  const revision = git("rev-parse", "HEAD"), cap = capability("states");
  const material = await businessMaterial(root, "历史评审：月底结算限制来自历史重复扣款问题。" + "业务原因和例外条件".repeat(4000));
  const doc = { id: "states", title: "结算约束的业务原因", target_id: "domain", path: "domains/states.md", layer: "domain", content: "# 结算约束\n月底取消必须冲正，源于重复扣款问题", sources: "business-decisions.txt 历史评审" };
  const main: Scene[] = [
    { tool: { name: "knowledge_research", input: { action: "upsert", capability: cap } } },
    { tool: { name: "knowledge_delegate", input: { action: "start", assignments: [{ capability_id: cap.id, question: "核对初始状态和边界" }] } } },
    { text: "MAIN_ONLY_HISTORY 主会话等待独立调查" },
    { tool: { name: "knowledge_delegate", input: { action: "read", capability_id: cap.id } } },
    { tool: { name: "knowledge_draft", input: { action: "save", document: doc } } },
    { tool: { name: "knowledge_research", input: { action: "upsert", capability: { ...cap, ...report, state: "researched", document_ids: [doc.id] } } } },
    { tool: { name: "knowledge_research", input: { action: "inventory_complete" } } },
    { tool: { name: "knowledge_research", input: { action: "complete" } } },
    { text: "准备最终核对" },
    { tool: { name: "knowledge_draft", input: { action: "read", id: doc.id } } },
    { tool: { name: "knowledge_research", input: { action: "complete" } } },
    { text: "主子研究完成并核对" },
  ];
  const child: Scene[] = [
    { tool: { name: "knowledge_material", input: { id: material.id, count: 10 } } },
    { tool: { name: "knowledge_research_result", input: { action: "save", report } } },
    { text: "保存子研究结论" },
  ];
  let mainIndex = 0, childIndex = 0, summaries = 0;
  const model = new ScriptedModelServer(Array.from({ length: 70 }, () => ({ text: "未预期请求" })), "scripted-v1", { linear: true,
    beforeScene: ({ request, index }) => {
      if (JSON.stringify(request.system).includes("你在整理 Coding Agent")) { summaries++; model.script[index] = { text: "已读取业务评审：月底结算限制来自历史重复扣款问题。继续保存研究报告，不重复读取。资料证据编号：" + (JSON.stringify(request.messages).match(/knowledge-evidence-[a-f0-9]{24}/g) ?? []).join(",") }; }
      else if (request.tools?.some((t: { name: string }) => t.name === "knowledge_research_result")) { useReturnedEvidence(request, child); model.script[index] = child[childIndex++] ?? { text: "子研究已完成" }; }
      else { useReturnedEvidence(request, main); model.script[index] = main[mainIndex++] ?? { text: "主研究已完成" }; }
    } });
  await model.start();
  const json = model.modelsJson() as any; json.providers.maeflow.models[0] = { id: "scripted-v1", contextWindow: 32000, maxTokens: 2048 };
  const service = new DomainKnowledgeExtraction(root, input => runDomainKnowledge(input, { dataDir: root,
    model: () => ({ provider: "maeflow", model: "scripted-v1", json }), source: async () => { throw new Error("业务资料足够，本例不得准备代码仓"); } }));
  try {
    const job = service.create({ issue_no: "REQ1", title: "结算知识", scope: "研究结算业务背景", material_ids: [material.id], repositories: [{ repository: "https://example.test/business.git", branch: "master" }] }, "expert");
    await until(() => ["done", "failed"].includes(service.get(job.id).status));
    const result = service.get(job.id); assert.equal(result.status, "done", result.error);
    assert.equal(result.turns[0].research?.phase, "complete"); assert.equal(result.documents.length, 1);
    assert.equal(result.evidence.filter(e => e.tool === "component_source").length, 0);
    assert.ok(summaries > 0, "子会话大业务资料触发真实上下文压缩");
    const childRequests = model.requests.filter((r: any) => r.tools?.some((t: { name: string }) => t.name === "knowledge_research_result"));
    assert.doesNotMatch(JSON.stringify(childRequests), /MAIN_ONLY_HISTORY/);
    assert.match(JSON.stringify(result.evidence), /主动压缩完成/);
    assert.match(JSON.stringify(model.requests.at(-1)), /月底结算限制来自历史重复扣款问题/);
  } finally { await service.shutdown(); await model.stop(); rmSync(root, { recursive: true, force: true }); }
});
