import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction, type DomainExecution, type DomainPublication } from "../src/domainKnowledgeExtraction.ts";
import { runDomainKnowledge } from "../src/domainKnowledgeAgent.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { businessMaterial, useReturnedEvidence } from "./domainKnowledgeEvidenceFixture.ts";

const config = { issue_no: "REQ-knowledge-123", title: "订单", scope: "状态与取消规则", repositories: [{ name: "交易仓", repository: "https://example.test/orders.git", branch: "main", docs_path: "docs/business" }], knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains/orders" } };
const document = { id: "states", title: "订单状态", target_id: "domain", path: "domains/orders/states.md", layer: "domain" as const, content: "# 订单\n原始规则", sources: "repo-1 / src/state.ts @ 123" };
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("任务未完成"); }
function extract(input: DomainExecution) { input.save(document, { content: null, revision: "a".repeat(40) }); return "草稿已保存"; }

test("工作草稿持续修正，手动重试保留原轮次；人工修改不能被 Agent 覆盖", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-working-draft-")); let first = true, turnId = "";
  const service = new DomainKnowledgeExtraction(dir, async input => {
    if (first) {
      first = false; turnId = input.turn.id; extract(input);
      input.save({ ...document, content: "补证后修正" });
      await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    } else {
      assert.equal(input.turn.id, turnId);
      assert.throws(() => input.save({ ...document, content: "覆盖人工内容" }), /人工修改/);
    }
    return "研究结束";
  });
  try {
    const job = service.create(config, "expert"); await until(() => service.get(job.id).documents[0]?.revision === 2);
    service.stop(job.id); await new Promise(resolve => setTimeout(resolve, 20));
    service.edit(job.id, { document: { ...document, content: "人工修改" }, base_revision: 2 }, "editor");
    service.resume(job.id, "expert"); await until(() => service.get(job.id).status === "done");
    assert.equal(service.get(job.id).turns.length, 1); assert.equal(service.get(job.id).documents[0].content, "人工修改");
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("领域修订建议不覆盖人工编辑，版本冲突、恢复和重启保留真实状态", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-extraction-"));
  let release: () => void = () => {};
  const service = new DomainKnowledgeExtraction(dir, async input => {
    if (input.turn.mode === "extract") return extract(input);
    if (input.turn.mode === "discuss") { assert.throws(() => input.save(document), /讨论/); return "只回答问题"; }
    await new Promise<void>(resolve => release = resolve);
    input.save({ ...document, content: "AI 修订" }); return "建议已保存";
  });
  try {
    for (const issue_no of [undefined, "", "  ", "REQ-1,REQ-2", "REQ-1\nREQ-2", "x".repeat(121)]) assert.throws(() => service.create({ ...config, issue_no }, "expert"), /关联单号/);
    const job = service.create({ ...config, issue_no: "  REQ-knowledge-123  " }, "expert");
    assert.equal(job.issue_no, "REQ-knowledge-123");
    await until(() => service.get(job.id).status === "done");
    service.run(job.id, { mode: "discuss", document_ids: [document.id], message: "依据是什么" }, "expert");
    await until(() => service.get(job.id).status === "done");
    assert.equal(service.get(job.id).documents[0].revision, 1);
    service.run(job.id, { mode: "revise", document_ids: [document.id], message: "核对取消" }, "expert");
    await until(() => service.get(job.id).status === "running"); await new Promise(resolve => setTimeout(resolve, 5));
    service.edit(job.id, { document: { ...document, content: "人工修订" }, base_revision: 1 }, "editor");
    release(); await until(() => service.get(job.id).status === "done");
    const turn = service.get(job.id).turns.at(-1)!;
    assert.equal(turn.proposals[0].base_revision, 1);
    assert.equal(service.get(job.id).documents[0].content, "人工修订");
    assert.throws(() => service.decide(job.id, turn.id, document.id, "accept", "expert"), /新版本/);
    service.decide(job.id, turn.id, document.id, "discard", "expert");
    const restored = service.restore(job.id, document.id, 1, 2, "editor");
    assert.equal(restored.documents[0].revision, 3); assert.equal(restored.documents[0].content, document.content);
    const restart = new DomainKnowledgeExtraction(dir, async () => "unused");
    assert.deepEqual(restart.get(job.id), JSON.parse(JSON.stringify(restored))); await restart.shutdown();
  } finally { release(); await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
test("停止后迟到结果不复活；路径和归档目标不能通过模型或人工编辑越界", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-extraction-"));
  const service = new DomainKnowledgeExtraction(dir, async input => {
    assert.throws(() => input.save({ ...document, path: "../../README.md" }), /路径/);
    assert.throws(() => input.save({ ...document, target_id: "repo-1" }), /领域文档/);
    extract(input);
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    assert.throws(() => input.save(document), /停止/); return "迟到答复";
  });
  try {
    const job = service.create(config, "expert"); await until(() => service.get(job.id).documents.length > 0);
    service.stop(job.id); await service.shutdown();
    const stopped = service.get(job.id); assert.equal(stopped.status, "cancelled"); assert.equal(stopped.documents.length, 1); assert.equal(stopped.turns[0].reply, undefined);
    assert.throws(() => service.edit(job.id, { document: { ...document, path: "domains/orders/new.md" }, base_revision: 1 }, "editor"), /归档位置/);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
test("MR 部分失败保存已经发生的分支事实，重试复用分支且不影响其他仓", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-extraction-"));
  let calls = 0;
  const service = new DomainKnowledgeExtraction(dir, async input => extract(input), {
    publish: async (_job, target, previous, _operator, save) => {
      calls++;
      const publication: DomainPublication = previous ?? { target_id: target.id, branch: "codex/knowledge-persisted", state: "pending", documents: [] };
      save(publication);
      if (calls === 1) throw new Error("MR 响应丢失");
      assert.equal(previous?.branch, "codex/knowledge-persisted");
      return { ...publication, state: "opened", url: "https://example.test/mr/1", mr_id: 1 };
    },
  });
  try {
    const job = service.create(config, "expert"); await until(() => service.get(job.id).status === "done");
    assert.equal((await service.publish(job.id, "expert")).publications[0].state, "failed");
    assert.equal((await service.publish(job.id, "expert")).publications[0].state, "opened");
    assert.equal(calls, 2);
    assert.throws(() => service.setIssueNumber(job.id, "REQ-other"), /不能更改/);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("领域 Skill 在真实 Pi 会话中读取固定源码和引用，保存两层草稿且无发布权限", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-agent-")), source = join(dir, "source");
  mkdirSync(source); const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "fixture"); git("config", "user.email", "fixture@example.test");
  writeFileSync(join(source, "state.ts"), "export const initial = 'pending';\n"); git("add", "."); git("commit", "-m", "fixture");
  const staleRevision = git("rev-parse", "HEAD");
  writeFileSync(join(source, "state.ts"), "export const initial = 'latest-ready';\n"); git("add", "."); git("commit", "-m", "latest business change");
  const revision = git("rev-parse", "HEAD");
  const material = await businessMaterial(dir);
  const model = new ScriptedModelServer([
    { tool: { name: "knowledge_material", input: { id: material.id } } },
    { tool: { name: "extraction_skill", input: { path: "references/domain.md" } } },
    { tool: { name: "component_source", input: { component_id: "repo-1", action: "read", path: "state.ts" } } },
    { tool: { name: "knowledge_draft", input: { action: "save", document } } },
    { tool: { name: "knowledge_draft", input: { action: "save", document: { ...document, id: "implementation", target_id: "repo-1", path: "docs/business/states.md", layer: "repository" } } } },
    { text: "这里只完成了初步草稿。" },
    { tool: { name: "knowledge_research", input: { action: "upsert", capability: { id: "states", title: "状态规则", repository_ids: ["repo-1"], state: "researched", findings: "初始状态 latest-ready，调用方受此状态约束", checks: { implementation: "state.ts 中的初始状态", callers: "该最小仓无调用方", scenarios: "初始状态读取", tests: "最小仓无测试文件", materials: "未上传资料" }, sources: [{ repository_id: "repo-1", path: "state.ts" }], document_ids: ["states", "implementation"] } } } },
    { tool: { name: "knowledge_research", input: { action: "inventory_complete" } } },
    { tool: { name: "knowledge_research", input: { action: "complete" } } },
    { text: "研究完成，准备核对证据。" },
    { tool: { name: "knowledge_draft", input: { action: "read", id: "states" } } },
    { tool: { name: "knowledge_draft", input: { action: "read", id: "implementation" } } },
    { tool: { name: "knowledge_research", input: { action: "complete" } } },
    { text: "已保存领域规则及仓内实现知识，等待审查。" },
  ], "scripted-v1", { linear: true, beforeScene: ({ request }) => useReturnedEvidence(request, model.script) });
  await model.start();
  const service = new DomainKnowledgeExtraction(dir, input => { input.job.revisions = { "repo-1": staleRevision }; return runDomainKnowledge(input, { dataDir: dir, model: () => ({ provider: "maeflow", model: "scripted-v1", json: model.modelsJson() }), source: async repository => { assert.equal(repository.id, "repo-1", "归档前只读取研究仓"); return { root: source, revision }; } }); });
  try {
    const { knowledge_target: _, ...researchOnly } = config;
    const job = service.create({ ...researchOnly, material_ids: [material.id] }, "expert");
    await until(() => ["done", "failed"].includes(service.get(job.id).status));
    const result = service.get(job.id); assert.equal(result.status, "done", result.error);
    assert.equal(result.turns[0].research?.phase, "complete"); assert.match(JSON.stringify(model.requests), /研究尚未完成/);
    assert.equal(result.documents.length, 2); assert.equal(result.documents[0].base_revision, ""); assert.equal(result.archive_configured, false); assert.equal(result.revisions["repo-1"], revision);
    assert.match(JSON.stringify(result.evidence), /latest-ready/); assert.notEqual(revision, staleRevision);
    assert.equal(result.turns[0].skill?.name, "domain-knowledge-extraction");
    const tools = (model.requests[0].tools as Array<{ name: string }>).map(t => t.name);
    assert.ok(tools.includes("extraction_skill")); assert.ok(tools.includes("knowledge_material"));
    assert.ok(!tools.includes("bash") && !tools.includes("write") && tools.includes("business_knowledge"));
    assert.match(JSON.stringify(model.requests.at(-1)), /业务知识/);
    assert.equal(git("rev-parse", "HEAD"), revision); assert.equal(result.publications.length, 0);
  } finally { await service.shutdown(); await model.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("远端核对须绑定最新快照和人工稿版本，保存后保留历史", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-reconcile-")); let snapshot = 0;
  const service = new DomainKnowledgeExtraction(dir, async input => extract(input), {
    readRemote: async () => ({ id: String(++snapshot), target_content: "人工远端内容", target_revision: "b".repeat(40), reviewed: false }),
  });
  try {
    const job = service.create(config, "expert"); await until(() => service.get(job.id).status === "done");
    await service.readRemote(job.id, document.id, "expert");
    await service.readRemote(job.id, document.id, "expert");
    assert.throws(() => service.reconcile(job.id, { document, base_revision: 1, snapshot_id: "1" }, "expert"), /远端比较版本/);
    const result = service.reconcile(job.id, { document: { ...document, content: "人工远端内容\n新的核对依据" }, base_revision: 1, snapshot_id: "2" }, "expert");
    assert.equal(result.documents[0].remote_review?.reviewed, true); assert.equal(result.documents[0].revision, 2);
    assert.equal(result.documents[0].history[0].content, document.content);
    assert.throws(() => service.reconcile(job.id, { document, base_revision: 1, snapshot_id: "2" }, "expert"), /新版本/);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("研究 Harness 连续推进多项能力，超过四轮仍接续原上下文，最终核对才结束", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-long-research-")), source = join(dir, "source"); mkdirSync(source);
  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "master"); writeFileSync(join(source, "rule.ts"), "export const initial = 'pending';\n"); git("add", ".");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
  const revision = git("rev-parse", "HEAD");
  const material = await businessMaterial(dir);
  const script: ConstructorParameters<typeof ScriptedModelServer>[0] = [
    { tool: { name: "knowledge_material", input: { id: material.id } } },
    { tool: { name: "component_source", input: { action: "read", component_id: "repo-1", path: "rule.ts" } } },
    { tool: { name: "knowledge_draft", input: { action: "save", document } } },
  ];
  for (let i = 0; i < 12; i++) script.push(
    { tool: { name: "knowledge_research", input: { action: "upsert", capability: { id: `cap-${i}`, title: `能力 ${i}`, repository_ids: ["repo-1"], state: "researched", findings: `能力 ${i} 的实际业务结论`, checks: { implementation: "状态初始化", callers: "最小仓无调用方", scenarios: "初始状态", tests: "最小仓无测试", materials: "无资料" }, sources: [{ repository_id: "repo-1", path: "rule.ts" }], document_ids: [document.id] } } } },
    { text: `阶段性报告 ${i}，其余能力还需研究` },
  );
  script.push({ tool: { name: "knowledge_research", input: { action: "inventory_complete" } } },
    { tool: { name: "knowledge_research", input: { action: "complete" } } }, { text: "申请证据核对" },
    { tool: { name: "knowledge_draft", input: { action: "read", id: document.id } } },
    { tool: { name: "knowledge_research", input: { action: "complete" } } }, { text: "证据核对完成" });
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true, beforeScene: ({ request }) => useReturnedEvidence(request, script) }); await model.start();
  const service = new DomainKnowledgeExtraction(dir, input => runDomainKnowledge(input, { dataDir: dir,
    model: () => ({ provider: "maeflow", model: "scripted-v1", json: model.modelsJson() }), source: async () => ({ root: source, revision }) }));
  try {
    const job = service.create({ ...config, material_ids: [material.id] }, "expert");
    for (let i = 0; i < 1000 && !["done", "failed"].includes(service.get(job.id).status); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const result = service.get(job.id); assert.equal(result.status, "done", result.error);
    assert.equal(result.turns.length, 1); assert.equal(result.turns[0].research?.capabilities.length, 12);
    assert.equal(result.turns[0].research?.phase, "complete"); assert.equal(result.turns[0].reply, "证据核对完成");
    assert.equal(result.evidence.filter(e => e.tool === "component_source" && e.action === "read").length, 1);
    assert.match(JSON.stringify(model.requests.at(-1)), /阶段性报告 0/);
  } finally { await service.shutdown(); await model.stop(); rmSync(dir, { recursive: true, force: true }); }
});


test("旧草稿可补填单号，创建 MR 前拦截缺失单号且重启保留补填结果", async () => {
  const dir = mkdtempSync(join(tmpdir(), "domain-legacy-issue-"));
  const original = new DomainKnowledgeExtraction(dir, async input => extract(input));
  let service: DomainKnowledgeExtraction | undefined;
  try {
    const job = original.create(config, "expert"); await until(() => original.get(job.id).status === "done");
    await original.shutdown();
    const path = join(dir, "domain-extraction", job.id, "job.json"), stored = JSON.parse(readFileSync(path, "utf8"));
    delete stored.issue_no; writeFileSync(path, JSON.stringify(stored));
    service = new DomainKnowledgeExtraction(dir, async () => "unused", { publish: async () => { throw new Error("不应执行发布"); } });
    await assert.rejects(service.publish(job.id, "expert"), /关联单号/);
    assert.equal(service.setIssueNumber(job.id, "  REQ-legacy  ").issue_no, "REQ-legacy");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).issue_no, "REQ-legacy");
  } finally { await original.shutdown(); await service?.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
