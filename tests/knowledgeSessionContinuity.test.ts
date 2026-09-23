import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { runDomainKnowledge } from "../src/domainKnowledgeAgent.ts";
import { ComponentResearch } from "../src/componentResearch.ts";
import { runComponentResearch } from "../src/componentResearchAgent.ts";
import { saveComponentRepository } from "../src/componentRepositories.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { businessMaterial, useReturnedEvidence } from "./domainKnowledgeEvidenceFixture.ts";

async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("等待会话超时");
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-continuity-")), source = join(dir, "source"); mkdirSync(source);
  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "master"); writeFileSync(join(source, "code.ts"), "const ORIGINAL_CONTEXT = true;\n"); git("add", ".");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
  return { dir, source, revision: git("rev-parse", "HEAD"), git };
}
const document = { id: "rules", title: "规则", target_id: "domain", path: "docs/knowledge/rules.md", layer: "domain", content: "规则正文", sources: "repo-1 code.ts" };

test("领域萃取重启沿用原轮次和 Pi 上下文，不重读源码、不重复保存草稿", async () => {
  const f = fixture(); let paused = false, release!: () => void;
  const hold = new Promise<void>(resolve => release = resolve);
  const material = await businessMaterial(f.dir);
  const model = new ScriptedModelServer([
    { tool: { name: "knowledge_material", input: { id: material.id } } },
    { tool: { name: "component_source", input: { action: "read", component_id: "repo-1", path: "code.ts" } } },
    { tool: { name: "knowledge_draft", input: { action: "save", document } } },
    { tool: { name: "knowledge_research", input: { action: "upsert", capability: { id: "rules", title: "规则", repository_ids: ["repo-1"], state: "researched", findings: "ORIGINAL_CONTEXT 常量定义", checks: { implementation: "code.ts 中的常量", callers: "最小仓无调用方", scenarios: "常量读取", tests: "最小仓无测试", materials: "未上传资料" }, sources: [{ repository_id: "repo-1", path: "code.ts" }], document_ids: ["rules"] } } } },
    { tool: { name: "knowledge_research", input: { action: "upsert", capability: { id: "rules", title: "规则", repository_ids: ["repo-1"], state: "researched", findings: "ORIGINAL_CONTEXT 常量定义", checks: { implementation: "code.ts 中的常量", callers: "最小仓无调用方", scenarios: "常量读取", tests: "最小仓无测试", materials: "未上传资料" }, sources: [{ repository_id: "repo-1", path: "code.ts" }], document_ids: ["rules"] } } } },
    { tool: { name: "knowledge_research", input: { action: "inventory_complete" } } },
    { tool: { name: "knowledge_research", input: { action: "complete" } } },
    { text: "等待证据核对" },
    { tool: { name: "knowledge_draft", input: { action: "read", id: "rules" } } },
    { tool: { name: "knowledge_research", input: { action: "complete" } } },
    { text: "沿用原研究结果完成" },
  ], "scripted-v1", { linear: true, beforeScene: async ({ request, index }) => { useReturnedEvidence(request, model.script); if (index === 3 && !paused) { paused = true; await hold; } } });
  await model.start();
  const options = { dataDir: f.dir, model: () => ({ provider: "maeflow", model: "scripted-v1", json: model.modelsJson() }), source: async () => ({ root: f.source, revision: f.revision }) };
  let service = new DomainKnowledgeExtraction(f.dir, input => runDomainKnowledge(input, options));
  try {
    const job = service.create({ issue_no: "REQ1", title: "业务", scope: "提取业务规则", material_ids: [material.id], repositories: [{ name: "业务", repository: "https://example.test/business.git", branch: "master" }], knowledge_target: { repository: "https://example.test/knowledge.git", branch: "master", docs_path: "docs/knowledge" } }, "expert");
    await until(() => paused);
    const turnId = service.get(job.id).turns[0].id;
    await service.shutdown(); release();
    assert.equal(service.get(job.id).status, "queued");
    service = new DomainKnowledgeExtraction(f.dir, input => runDomainKnowledge(input, options));
    await until(() => ["done", "failed"].includes(service.get(job.id).status));
    const result = service.get(job.id);
    assert.equal(result.status, "done", result.error);
    assert.equal(result.turns.length, 1); assert.equal(result.turns[0].id, turnId);
    assert.equal(result.documents.length, 1); assert.equal(result.documents[0].revision, 1);
    assert.equal(result.evidence.filter(e => e.tool === "component_source" && e.action === "read").length, 1);
    assert.match(JSON.stringify(model.requests.at(-1)), /ORIGINAL_CONTEXT/);
    assert.match(readFileSync(join(f.dir, "domain-extraction", job.id, "events.jsonl"), "utf8"), /"context_restored":true/);
  } finally { release(); await service.shutdown(); await model.stop(); rmSync(f.dir, { recursive: true, force: true }); }
});

test("组件萃取重启接续原 Pi 会话；用户明确停止的任务不会被复活", async () => {
  const f = fixture(); let paused = false, release!: () => void;
  const hold = new Promise<void>(resolve => release = resolve), oldEc = process.env.MAE_FLOW_EC_BIN;
  const ec = join(f.dir, "ec"); writeFileSync(ec, "#!/bin/sh\necho '[]'\n", { mode: 0o700 }); process.env.MAE_FLOW_EC_BIN = ec;
  const row = saveComponentRepository(f.dir, { name: "组件", repository: "https://example.test/component.git", branch: "master", path: "", languages: ["cpp"] }, "expert");
  const model = new ScriptedModelServer([
    { tool: { name: "component_source", input: { action: "read", component_id: row.id, path: "code.ts" } } },
    { text: "原组件研究已完成" },
  ], "scripted-v1", { beforeScene: async ({ index }) => { if (index === 1 && !paused) { paused = true; await hold; } } });
  await model.start();
  const options = { dataDir: f.dir, model: () => ({ provider: "maeflow", model: "scripted-v1", json: model.modelsJson() }), source: async () => ({ root: f.source, revision: f.revision }) };
  let service = new ComponentResearch(f.dir, input => runComponentResearch(input, options));
  try {
    const job = service.start({ component_id: row.id, language: "cpp", topic: "接口规则" }, "expert");
    await until(() => paused); await service.shutdown(); release();
    assert.equal(service.get(job.id).status, "queued");
    service = new ComponentResearch(f.dir, input => runComponentResearch(input, options));
    await until(() => ["done", "failed"].includes(service.get(job.id).status));
    assert.equal(service.get(job.id).status, "done", service.get(job.id).error);
    assert.equal(service.get(job.id).evidence.filter(e => e.tool === "component_source" && e.action === "read").length, 1);
    assert.match(JSON.stringify(model.requests.at(-1)), /ORIGINAL_CONTEXT/);
    assert.match(readFileSync(join(f.dir, "component-research", job.id, "events.jsonl"), "utf8"), /"context_restored":true/);
    const stopped = service.start({ component_id: row.id, language: "cpp", topic: "停止用例" }, "expert");
    service.stop(stopped.id); await service.shutdown();
    service = new ComponentResearch(f.dir, async () => { throw new Error("不应执行已停止任务"); });
    assert.equal(service.get(stopped.id).status, "cancelled");
  } finally {
    release(); await service.shutdown(); await model.stop();
    if (oldEc === undefined) delete process.env.MAE_FLOW_EC_BIN; else process.env.MAE_FLOW_EC_BIN = oldEc;
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("领域修订建议在重启前落盘，接续保留原文版本并保护期间的人工修改", async () => {
  const f = fixture(); let saved = false;
  let service = new DomainKnowledgeExtraction(f.dir, async input => {
    if (input.turn.mode === "extract") { input.save({ ...document, layer: "domain" }, { content: null, revision: f.revision }); return "首次完成"; }
    input.save({ ...document, layer: "domain", content: "待审查建议" }); saved = true;
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    return "迟到答复";
  });
  try {
    const job = service.create({ issue_no: "REQ1", title: "业务", scope: "规则", repositories: [{ repository: "https://example.test/business.git", branch: "master" }], knowledge_target: { repository: "https://example.test/knowledge.git", branch: "master", docs_path: "docs/knowledge" } }, "expert");
    await until(() => service.get(job.id).status === "done");
    service.run(job.id, { mode: "revise", document_ids: [document.id], message: "补充规则" }, "expert");
    await until(() => saved); await service.shutdown();
    const turn = service.get(job.id).turns.at(-1)!;
    assert.equal(turn.proposals[0].document.content, "待审查建议");
    service.edit(job.id, { document: { ...document, layer: "domain", content: "人工新版本" }, base_revision: 1 }, "editor");
    // 模拟强制退出留下的 running 状态，仍接续同一轮。
    const path = join(f.dir, "domain-extraction", job.id, "job.json");
    const disk = JSON.parse(readFileSync(path, "utf8")); disk.status = "running"; disk.turns.at(-1).status = "running";
    writeFileSync(path, JSON.stringify(disk));
    service = new DomainKnowledgeExtraction(f.dir, async input => {
      assert.equal(input.turn.id, turn.id);
      assert.equal(input.turn.proposals[0].document.content, "待审查建议");
      input.save({ ...document, layer: "domain", content: "接续后的建议" });
      return "修订完成";
    });
    await until(() => service.get(job.id).status === "done");
    assert.equal(service.get(job.id).turns.at(-1)!.proposals[0].base_revision, 1);
    assert.throws(() => service.decide(job.id, turn.id, document.id, "accept", "expert"), /新版本/);
    assert.equal(service.get(job.id).documents[0].content, "人工新版本");
  } finally { await service.shutdown(); rmSync(f.dir, { recursive: true, force: true }); }
});
