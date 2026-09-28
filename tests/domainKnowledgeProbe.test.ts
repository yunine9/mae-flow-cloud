import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { probeExcludedPath } from "../src/domainKnowledgeProbe.ts";
import { componentSourceTool } from "../src/componentResearchTools.ts";
import { scanKnowledgeCode, validateKnowledgeReferences } from "../src/domainKnowledgeCode.ts";
import { DomainKnowledgePipeline, type KnowledgeWorkResult } from "../src/domainKnowledgePipeline.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";

const signal = () => new AbortController().signal;

test("临时验证在列表、搜索、直接读取和引用校验中屏蔽全部旧文档，不受 include_platform 绕过", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-probe-source-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const blocked = ["docs/old.md", "nested/DOCS/旧知识.md", "AGENTS.md", "nested/agents.MD", "handbook/rules.md"];
    for (const path of [...blocked, "src/rule.ts"]) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), blocked.includes(path) ? "OLD_KNOWLEDGE_SENTINEL" : "export const current = true;\n"); }
    execFileSync("git", ["-C", root, "add", "."]); execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"]);
    const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const repo = { id: "repo-1", name: "repo-1", repository: "fixture", branch: "main", path: "", docs_path: "handbook" };
    const exclude = probeExcludedPath([repo]), evidence: any[] = [];
    const tool = componentSourceTool(root, revision, "", event => evidence.push(event), "repo-1", exclude);
    const execute = (args: any) => (tool as any).execute("test", args, signal());
    const list = await execute({ action: "list", recursive: true, include_platform: true });
    assert.match(list.content[0].text, /src\/rule.ts/);
    for (const path of blocked) assert.ok(!list.content[0].text.includes(path));
    const search = await execute({ action: "search", query: "OLD_KNOWLEDGE_SENTINEL", include_platform: true });
    assert.doesNotMatch(search.content[0].text, /OLD_KNOWLEDGE_SENTINEL|旧知识/);
    for (const path of blocked) assert.equal((await execute({ action: "read", path, include_platform: true })).isError, true, path);
    assert.doesNotMatch(JSON.stringify(evidence.map(e => e.preview)), /OLD_KNOWLEDGE_SENTINEL/);
    const snapshot = await scanKnowledgeCode(repo, { root, revision }, signal(), exclude);
    assert.deepEqual(snapshot.files, ["src/rule.ts"]);
    assert.equal((await validateKnowledgeReferences("`repo-1:docs/old.md`", [snapshot], signal())).errors.length, 1);
    const normal = componentSourceTool(root, revision, "", () => {});
    assert.match((await (normal as any).execute("normal", { action: "read", path: "docs/old.md" }, signal())).content[0].text, /OLD_KNOWLEDGE_SENTINEL/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("单模块验证拒绝扩展其他模块，无全域跨模块任务，重启保留同一范围", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-probe-plan-"));
  try {
    const file = join(root, "state.json"), pipeline = new DomainKnowledgePipeline(file, "skill", 0, "邻区发现");
    let rejected = false;
    await pipeline.run({ signal: signal(), stage: () => {}, review: async () => undefined, execute: async task => {
      const result: KnowledgeWorkResult = { findings: "只验证邻区发现，其他模块仅按需核对依赖", open_questions: [], document_ids: [task.id] };
      if (task.phase === "inventory") {
        if (task.attempts === 1) result.modules = [{ id: "other", title: "其他模块", kind: "business", depends_on: [], scope: "all" }];
        else { assert.match(task.feedback!, /本次仅验证指定模块/); rejected = true; result.modules = [{ id: "probe", title: "邻区发现", kind: "business", depends_on: [], scope: "repo-1/src" }]; }
      }
      if (task.phase === "plan") result.subfeatures = [{ id: "discovery", title: "发现", hops: [{ id: "entry", title: "输入边界", questions: "哪些条件触发发现？" }] }];
      return result;
    } });
    assert.equal(rejected, true);
    assert.equal(pipeline.state.tasks.filter(t => t.phase === "plan").length, 1);
    assert.ok(!pipeline.state.tasks.some(t => ["cross", "cross-plan"].includes(t.phase)));
    assert.equal(pipeline.state.tasks.filter(t => t.phase === "synthesis").length, 3);
    assert.throws(() => new DomainKnowledgePipeline(file, "skill", 0, "其他"), /不能改变/);
    assert.equal(new DomainKnowledgePipeline(file, "skill", 0, "邻区发现").state.tasks.every(t => t.status === "done"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("验证任务独立列出、直接启动并阻止清理发布及旧归档读取，资料保留", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-probe-job-"));
  createBusinessModule(root, { id: "wireless", name: "无线", description: "无线领域", owner: "dev", repositories: ["https://example.test/radio.git"] }, "dev");
  const manager = new DomainKnowledgeExtraction(root, async () => "测试未生成文档", { sourceCleanup: { create() { throw new Error("验证不应清理仓库"); } } as any });
  try {
    assert.throws(() => manager.createProbe({ module_id: "wireless" }, "dev"), /单个模块/);
    const job = manager.createProbe({ module_id: "wireless", probe_module: "邻区发现", baseline_branch: "release", ar_codes: ["AR123"], knowledge_target: { repository: "https://example.test/docs.git" } }, "dev");
    assert.equal(job.probe?.module, "邻区发现"); assert.equal(job.source_cleanup, undefined);
    assert.equal(job.archive_configured, false); assert.equal(job.use_wxdoubao, true); assert.deepEqual(job.ar_codes, ["AR123"]);
    assert.equal(job.repositories[0].branch, "release"); assert.equal(job.turns.length, 1);
    assert.equal(manager.list().length, 0); assert.equal(manager.list(true).length, 1);
    await assert.rejects(manager.publish(job.id, "dev"), /临时效果验证/);
    await assert.rejects(manager.readRemote(job.id, "doc", "dev"), /临时效果验证/);
    await assert.rejects(manager.sourceCleanupAction(job.id, "start", {}, "dev"), /临时效果验证/);
    assert.throws(() => manager.configureArchive(job.id, { targets: [] }), /临时效果验证/);
    assert.throws(() => manager.run(job.id, { mode: "discuss", message: "旧文档是什么" }, "dev"), /首次萃取/);
  } finally { await manager.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("验证会话确实不把自动发现及显式传入的 AGENTS 发送给模型，普通会话保持原行为", async () => {
  const { CloudSession } = await import("../src/sessionDriver.ts");
  const { ScriptedModelServer } = await import("../src/scriptedModel.ts");
  const { EventLog } = await import("../src/semanticEvents.ts");
  const { TranscriptStore } = await import("../src/transcriptStore.ts");
  const { GateService } = await import("../src/gateService.ts");
  const { HumanGate } = await import("../src/humanGate.ts");
  const root = mkdtempSync(join(tmpdir(), "probe-agents-")), model = new ScriptedModelServer([{ text: "完成" }]);
  try {
    await model.start();
    for (const excludeAgentFiles of [false, true]) {
      const workspace = join(root, String(excludeAgentFiles)), agentDir = join(workspace, "agent"); mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(workspace, "AGENTS.md"), "AUTO_OLD_AGENT_SENTINEL");
      writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
      const session = await CloudSession.create({ taskId: `probe-${excludeAgentFiles}`, workspace, agentDir, provider: "maeflow", model: "scripted-v1",
        allowedTools: [], allowSubagents: false, allowHumanQuestions: false, excludeAgentFiles,
        repoContextFiles: [{ path: join(workspace, "repo/AGENTS.md"), content: "EXPLICIT_OLD_AGENT_SENTINEL" }],
        eventLog: new EventLog(join(workspace, "events.jsonl")), transcript: new TranscriptStore(join(workspace, "transcript.jsonl"), "main"),
        gate: new GateService({ workspace, cwd: workspace }), humanGate: new HumanGate(join(workspace, "waiting.json")) });
      try { assert.equal((await session.start("只回答完成")).status, "turn_finished"); }
      finally { session.dispose(); }
      const request = JSON.stringify(model.requests.at(-1));
      if (excludeAgentFiles) assert.doesNotMatch(request, /AUTO_OLD_AGENT_SENTINEL|EXPLICIT_OLD_AGENT_SENTINEL/);
      else { assert.match(request, /AUTO_OLD_AGENT_SENTINEL/); assert.match(request, /EXPLICIT_OLD_AGENT_SENTINEL/); }
    }
  } finally { await model.stop(); rmSync(root, { recursive: true, force: true }); }
});
