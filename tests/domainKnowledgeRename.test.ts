import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CloudSession } from "../src/sessionDriver.ts";
import { runDomainKnowledge } from "../src/domainKnowledgeAgent.ts";
import { DomainKnowledgeExtraction, type DomainDocumentContent, type DomainKnowledgeJob, type DomainPublication } from "../src/domainKnowledgeExtraction.ts";
import { KnowledgeExtractionSkills } from "../src/knowledgeExtractionSkills.ts";
import { listKnowledgeDocuments, readKnowledgeDocument } from "../src/knowledgeDocuments.ts";

async function finished(service: DomainKnowledgeExtraction, id: string) {
  for (let i = 0; i < 600; i++) {
    const job = service.get(id);
    if (!["queued", "running"].includes(job.status)) {
      assert.equal(job.status, "done", job.error);
      await new Promise(resolve => setTimeout(resolve, 0));
      return service.get(id);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("领域研究未在 6 秒内结束");
}

const businessRepository = (number: number) => ({ name: `业务仓 ${number}`, repository: `https://example.test/business-${number}.git`, branch: "main", docs_path: "docs/business" });
const knowledgeTarget = { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" };
const originalPath = "docs/business/30/transport.md";
const renamedPath = "docs/business/文件传输管理/传输任务.md";
const originalBody = "# 传输任务\n\n传输完成后记录业务结果。";
const originalMap = "# 模块目录\n\n[传输任务](30/transport.md)";
const originalAgents = "# 业务知识入口\n\n阅读 docs/business/30/transport.md。";

function businessDocuments(number: number): DomainDocumentContent[] {
  const common = { target_id: `repo-${number}`, layer: "repository" as const, sources: `repo-${number}:src/transfer.ts:1-1` };
  return [
    { ...common, id: `guide-${number}`, title: "传输任务", path: originalPath, content: originalBody },
    { ...common, id: `map-${number}`, title: "模块目录", path: "docs/business/module-map.md", content: originalMap },
    { ...common, id: `agents-${number}`, title: "业务知识入口", path: "docs/business/AGENTS.md", content: originalAgents },
  ];
}

function document(job: DomainKnowledgeJob, id: string) {
  const found = job.documents.find(document => document.id === id);
  assert.ok(found, `文档 ${id} 应当存在`);
  return found;
}

test("#466 Agent 用原编号改业务路径并更新三仓目录与 AGENTS：建议、重启、采纳、恢复和正式身份一致", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-rename-agent-")), repo = join(root, "repo");
  mkdirSync(repo);
  const files = { "src/transfer.ts": "export function transfer() { return 'completed'; }\n", [originalPath]: originalBody,
    "docs/business/module-map.md": originalMap, "docs/business/AGENTS.md": originalAgents, "AGENTS.md": originalAgents };
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); }
  execFileSync("git", ["init", "-q", repo]); execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"]);
  const revision = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const skills = new KnowledgeExtractionSkills(root);
  await skills.save("domain", { "SKILL.md": "---\nname: business-paths\ndescription: 按业务概念组织文稿。\n---\n使用稳定文档编号维护正文与路径，更新相关目录和阅读入口。" }, skills.current("domain").digest, "expert");
  let phase: "extract" | "rename" | "refine" | "discard" = "extract", readonlyChecks = 0;
  const allIds = [1, 2, 3].flatMap(number => businessDocuments(number).map(document => document.id));
  const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
    start: async (prompt: string) => {
      const context = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
      const call = async (name: string, args: unknown, error = false) => {
        const tool = config.extraTools.find((tool: any) => tool.name === name); assert.ok(tool, name);
        const response = await tool.execute("fixture", args, new AbortController().signal);
        assert.equal(!!response.isError, error, JSON.stringify(response));
        try { return JSON.parse(response.content[0].text); } catch { return response.content[0].text; }
      };
      if (context.step) {
        readonlyChecks++;
        const proposed = await call("knowledge_draft", { action: "read", id: "guide-1" });
        assert.equal(proposed.path, renamedPath);
        await call("knowledge_draft", { action: "save", document: { ...proposed, path: "docs/business/不能写.md" } }, true);
        await call("knowledge_work_result", { summary: "已回读业务路径与引用", document_ids: ["guide-1"] });
      } else if (phase === "extract") {
        await call("component_source", { action: "read", component_id: "repo-1", path: "src/transfer.ts" });
        for (const number of [1, 2, 3]) for (const draft of businessDocuments(number)) await call("knowledge_draft", { action: "save", document: draft });
        await call("knowledge_work_result", { summary: "已保存三仓业务文稿", document_ids: allIds });
      } else if (phase === "rename" || phase === "refine") {
        assert.deepEqual(context.selected_document_ids, allIds);
        for (const number of [1, 2, 3]) {
          const guide = await call("knowledge_draft", { action: "read", id: `guide-${number}` });
          assert.equal(guide.path, phase === "rename" ? originalPath : renamedPath, "后续轮读取前一轮未采纳的新路径");
          const map = await call("knowledge_draft", { action: "read", id: `map-${number}` });
          const agents = await call("knowledge_draft", { action: "read", id: `agents-${number}` });
          assert.equal(agents.path, "AGENTS.md", "原人工授权完整路径可继续更新内容");
          const content = phase === "rename" ? originalBody : `${originalBody}\n\n核对失败任务的重试边界。`;
          await call("knowledge_draft", { action: "save", document: { ...guide, path: renamedPath, content } });
          await call("knowledge_draft", { action: "save", document: { ...map, content: "# 模块目录\n\n[传输任务](文件传输管理/传输任务.md)" } });
          await call("knowledge_draft", { action: "save", document: { ...agents, content: `# 业务知识入口\n\n阅读 ${renamedPath}。` } });
          assert.equal((await call("knowledge_draft", { action: "read", id: guide.id })).path, renamedPath);
        }
        if (phase === "rename") {
          await call("knowledge_work", { action: "schedule", steps: [{ id: "verify-paths", title: "回读关联文稿", instructions: "核对新路径与关联入口", depends_on: [], readonly: true }] });
          await call("knowledge_work", { action: "run", id: "verify-paths" });
        }
        await call("knowledge_work_result", { summary: "改名与关联入口修改已保存，等待审查", document_ids: allIds });
      } else {
        const guide = await call("knowledge_draft", { action: "read", id: "guide-1" });
        assert.equal(guide.path, originalPath);
        await call("knowledge_draft", { action: "save", document: { ...guide, path: "docs/business/放弃的名称.md" } });
        await call("knowledge_work_result", { summary: "另一改名建议，等待审查", document_ids: [guide.id] });
      }
      return { status: "turn_finished" };
    }, dispose() {}, abort: async () => {}, startResume: async () => { throw new Error("已保存结果不应再次补充会话"); },
  }) as any);
  const execute = (input: Parameters<typeof runDomainKnowledge>[0]) => runDomainKnowledge(input, { dataDir: root,
    model: () => ({ provider: "fixture", model: "fixture", json: {} }), source: async () => ({ root: repo, revision }) });
  let service = new DomainKnowledgeExtraction(root, execute);
  try {
    let job = await finished(service, service.create({ issue_no: "466", title: "文件传输", scope: "业务文档命名和目录入口", knowledge_target: knowledgeTarget,
      repositories: [1, 2, 3].map(businessRepository) }, "expert").id);
    job = service.configureArchive(job.id, { base_revision: 0, targets: [job.knowledge_target, ...job.repositories], documents: [
      { id: "guide-1", path: originalPath }, ...[1, 2, 3].map(number => ({ id: `agents-${number}`, path: "AGENTS.md" })),
    ] });
    job = await service.publish(job.id, "expert");
    const originals = structuredClone(job.documents), formalIds = Object.fromEntries(job.documents.map(document => [document.id, document.knowledge_document_id]));
    assert.equal(listKnowledgeDocuments(root).length, 9);
    phase = "rename";
    service.run(job.id, { mode: "revise", document_ids: allIds, message: "按业务概念改名，并更新三仓的 module-map 和 AGENTS 引用" }, "expert");
    job = await finished(service, job.id);
    assert.equal(readonlyChecks, 1);
    assert.deepEqual(job.documents, originals, "改名只生成建议，旧正文与归档路径没有直接改变");
    assert.equal(job.turns.at(-1)!.proposals.length, 9);
    assert.equal(job.turns.at(-1)!.proposals.find(proposal => proposal.document.id === "guide-1")!.document.path, renamedPath);
    await assert.rejects(() => service.publish(job.id, "expert"), /尚未确认/);
    await service.shutdown(); service = new DomainKnowledgeExtraction(root, execute);
    job = service.get(job.id);
    assert.deepEqual(job.documents, originals);
    assert.equal(job.turns.at(-1)!.proposals.find(proposal => proposal.document.id === "guide-1")!.document.path, renamedPath, "重启不丢改名建议");
    phase = "refine";
    service.run(job.id, { mode: "revise", document_ids: allIds, message: "沿用业务名称，再补充失败任务的重试边界" }, "expert");
    job = await finished(service, job.id);
    const latest = job.turns.at(-1)!;
    for (const proposal of latest.proposals) service.decide(job.id, latest.id, proposal.document.id, "accept", "expert");
    job = service.get(job.id);
    for (const number of [1, 2, 3]) {
      assert.equal(document(job, `guide-${number}`).path, renamedPath);
      assert.match(document(job, `guide-${number}`).content, /重试边界/);
      assert.match(document(job, `map-${number}`).content, /文件传输管理\/传输任务\.md/);
      assert.equal(document(job, `agents-${number}`).path, "AGENTS.md");
      assert.match(document(job, `agents-${number}`).content, /文件传输管理\/传输任务\.md/);
    }
    assert.equal(document(job, "guide-1").archive_path, renamedPath, "已有逐文件归档设置跟随人工采纳的新名称");
    assert.equal(document(job, "guide-2").base_path, originalPath, "首次改名保留原 Git 基线所在路径");
    assert.equal(document(job, "guide-2").base_content, originalBody);
    assert.equal(document(job, "guide-2").history[0].path, originalPath);
    job = await service.publish(job.id, "expert");
    assert.equal(listKnowledgeDocuments(root).length, 9, "改名更新原正式知识，没有新增重复知识");
    for (const draft of job.documents) assert.equal(draft.knowledge_document_id, formalIds[draft.id]);
    assert.equal(readKnowledgeDocument(root, formalIds["guide-1"]!).archive_target!.path, renamedPath);
    job = service.restore(job.id, "guide-1", 1, document(job, "guide-1").revision, "expert");
    assert.equal(document(job, "guide-1").path, originalPath);
    assert.equal(document(job, "guide-1").archive_path, originalPath);
    assert.equal(document(job, "guide-1").content, originalBody);
    assert.equal(document(job, "guide-1").revision, 3);
    assert.equal(document(job, "guide-1").knowledge_document_id, formalIds["guide-1"]);
    phase = "discard";
    service.run(job.id, { mode: "revise", document_ids: ["guide-1"], message: "试一个其他名称" }, "expert");
    job = await finished(service, job.id);
    const discarded = job.turns.at(-1)!;
    job = service.decide(job.id, discarded.id, "guide-1", "discard", "expert");
    assert.equal(document(job, "guide-1").path, originalPath);
    assert.equal(document(job, "guide-1").revision, 3, "放弃不会改变当前草稿版本");
    assert.equal(discarded.proposals[0].document.path, "docs/business/放弃的名称.md");
    assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }), "", "研究工具没有直接搬动源码仓的文件");
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});

test("#466 Agent 可新增文档及修改未选文档，改名保留首次基线，非法路径与归档目标和候选冲突仍受保护", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-rename-boundaries-"));
  const guide = businessDocuments(1)[0], second = { ...guide, id: "second", path: "docs/business/other.md", title: "另一业务" },
    unselected = { ...guide, id: "unselected", path: "docs/business/unselected.md" };
  const initialPath = "docs/business/萃取时修正的业务名.md", proposedPath = "docs/business/共同业务名.md";
  const service = new DomainKnowledgeExtraction(root, async input => {
    if (input.turn.mode === "extract") {
      input.save(guide, { content: originalBody, revision: "a".repeat(40) });
      input.save({ ...guide, path: initialPath });
      input.save({ ...guide, path: originalPath });
      input.save(second); input.save(unselected);
      return "同轮自有草稿可修正业务名称";
    }
    const current = input.read().find(document => document.id === guide.id)!;
    input.save({ ...current, id: "new-id", path: "guides/新业务文档.md", title: "新增业务文档", content: "新文档完整正文" });
    input.save({ ...unselected, content: "本任务未选文档也可以生成修订建议" });
    assert.throws(() => input.save({ ...current, target_id: "domain", layer: "domain", path: "domains/rename.md" }), /归档位置|归档目标|归档仓|目标与层级/);
    assert.throws(() => input.save({ ...current, layer: "domain" }), /领域文档|层级/);
    for (const path of ["../outside.md", ".git/rename.md", "docs/business/../outside.md", "docs/business/code.ts"]) {
      assert.throws(() => input.save({ ...current, path }), /路径|目录|\.md/);
    }
    assert.throws(() => input.save({ ...current, path: second.path }), /已有草稿|同一个目标|路径.*冲突/);
    input.save({ ...current, path: "AGENTS.md" });
    assert.equal(input.read().find(document => document.id === guide.id)!.path, "AGENTS.md", "可在本任务目标仓的根目录维护 Markdown 文档");
    input.save({ ...current, path: proposedPath });
    assert.equal(input.read().find(document => document.id === guide.id)!.path, proposedPath);
    assert.throws(() => input.save({ ...second, path: proposedPath }), /已有草稿|同一个目标|路径.*冲突/);
    return "仅保存合法改名建议";
  });
  try {
    let job = await finished(service, service.create({ issue_no: "466-boundary", title: "业务名称", scope: "维护已有业务文档", knowledge_target: knowledgeTarget, repositories: [businessRepository(1)] }, "expert").id);
    const draft = document(job, guide.id);
    assert.equal(draft.path, originalPath); assert.equal(draft.revision, 3);
    assert.equal(draft.base_path, originalPath); assert.equal(draft.base_content, originalBody);
    assert.deepEqual(draft.history.map(history => history.path), [originalPath, initialPath]);
    const before = structuredClone(job.documents);
    service.run(job.id, { mode: "revise", document_ids: [guide.id, second.id], message: "只为选中业务改名" }, "expert");
    job = await finished(service, job.id);
    assert.deepEqual(job.documents.filter(document => document.id !== "new-id"), before, "已有文档只生成待确认建议");
    assert.equal(document(job, "new-id").path, "guides/新业务文档.md");
    assert.equal(document(job, "new-id").content, "新文档完整正文");
    assert.equal(document(job, "new-id").selected, true, "新增文档直接成为待审查草稿");
    assert.deepEqual(job.turns.at(-1)!.proposals.map(proposal => proposal.document.id).sort(), [guide.id, unselected.id].sort());
    assert.equal(job.turns.at(-1)!.proposals.find(proposal => proposal.document.id === unselected.id)!.document.content, "本任务未选文档也可以生成修订建议");
    const turnId = job.turns.at(-1)!.id;
    job = service.edit(job.id, { document: { ...document(job, guide.id), content: "人工补充的业务规则" }, base_revision: 3 }, "editor");
    assert.throws(() => service.decide(job.id, turnId, guide.id, "accept", "expert"), /新版本|差异/);
    assert.equal(document(service.get(job.id), guide.id).path, originalPath);
    assert.equal(document(service.get(job.id), guide.id).content, "人工补充的业务规则");
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("#466 已发布文档改名不能占用另一任务的正式知识路径，拒绝后双方正式身份和正文保持原样", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-rename-formal-collision-")), guide = businessDocuments(1)[0];
  const service = new DomainKnowledgeExtraction(root, async input => {
    if (input.turn.mode === "extract") {
      input.save(input.job.title === "原文档" ? guide : { ...guide, id: "occupied", path: renamedPath, title: "独立业务规则", content: "# 独立业务规则\n\n其他任务已经维护的正式内容。" });
      return "已保存业务文档";
    }
    const current = input.read().find(document => document.id === guide.id)!;
    input.save({ ...current, path: renamedPath, content: "# 修改后的规则\n\n尝试使用已占用业务名称。" });
    return "改名建议已保存";
  });
  try {
    const config = { issue_no: "466-formal", scope: "正式知识路径检查", knowledge_target: knowledgeTarget, repositories: [businessRepository(1)] };
    let original = await finished(service, service.create({ ...config, title: "原文档" }, "expert").id);
    original = await service.publish(original.id, "expert");
    let occupied = await finished(service, service.create({ ...config, title: "占用目的路径的文档" }, "expert").id);
    occupied = await service.publish(occupied.id, "expert");
    const originalId = document(original, guide.id).knowledge_document_id, occupiedId = document(occupied, "occupied").knowledge_document_id;
    assert.ok(originalId); assert.ok(occupiedId); assert.notEqual(originalId, occupiedId);
    const originalFormal = readKnowledgeDocument(root, originalId), occupiedFormal = readKnowledgeDocument(root, occupiedId);
    service.run(original.id, { mode: "revise", document_ids: [guide.id], message: "将原文档改为新的业务路径" }, "expert");
    original = await finished(service, original.id);
    const turn = original.turns.at(-1)!;
    original = service.decide(original.id, turn.id, guide.id, "accept", "expert");
    assert.equal(document(original, guide.id).path, renamedPath, "同范围的改名可先成为已确认草稿");
    assert.equal(document(original, guide.id).knowledge_document_id, originalId);
    await assert.rejects(() => service.publish(original.id, "expert"), /已有正式知识/);
    assert.deepEqual(readKnowledgeDocument(root, originalId), originalFormal, "被拒绝的改名没有重写原正式知识");
    assert.deepEqual(readKnowledgeDocument(root, occupiedId), occupiedFormal, "目的路径对应的其他正式知识没有被覆盖");
    assert.deepEqual(listKnowledgeDocuments(root).map(document => document.id).sort(), [originalId, occupiedId].sort());
    assert.equal(document(service.get(original.id), guide.id).knowledge_document_id, originalId);
    assert.equal(document(service.get(occupied.id), "occupied").knowledge_document_id, occupiedId);
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("#466 根目录文档改名后人工历史恢复原路径，Agent 可维护当前任务目标内的其他 Markdown 路径", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-rename-root-restore-"));
  const initial = businessDocuments(1)[2], renamed = "docs/business/业务阅读入口.md";
  const service = new DomainKnowledgeExtraction(root, async input => {
    if (input.turn.mode === "extract") { input.save(initial); return "阅读入口已保存"; }
    const current = input.read().find(document => document.id === initial.id)!;
    if (input.turn.message === "将根阅读入口改到业务文档目录") input.save({ ...current, path: renamed });
    else {
      assert.equal(current.path, renamed);
      assert.ok(current.history.some(history => history.path === "AGENTS.md"));
      for (const path of ["AGENTS.md", "OTHER.md"]) input.save({ ...current, path });
    }
    return "本轮检查完成";
  });
  try {
    let job = await finished(service, service.create({ issue_no: "466-restore-root", title: "阅读入口", scope: "维护本篇入口路径", knowledge_target: knowledgeTarget, repositories: [businessRepository(1)] }, "expert").id);
    job = service.configureArchive(job.id, { base_revision: 0, targets: [job.knowledge_target, ...job.repositories], documents: [{ id: initial.id, path: "AGENTS.md" }] });
    service.run(job.id, { mode: "revise", document_ids: [initial.id], message: "将根阅读入口改到业务文档目录" }, "expert");
    job = await finished(service, job.id);
    job = service.decide(job.id, job.turns.at(-1)!.id, initial.id, "accept", "expert");
    assert.equal(document(job, initial.id).path, renamed); assert.equal(document(job, initial.id).archive_path, renamed);
    assert.equal(document(job, initial.id).history[0].path, "AGENTS.md");
    service.run(job.id, { mode: "revise", document_ids: [initial.id], message: "检查 Agent 可维护当前任务目标内的根文档" }, "expert");
    job = await finished(service, job.id);
    assert.equal(job.turns.at(-1)!.proposals.length, 1);
    assert.equal(job.turns.at(-1)!.proposals[0].document.path, "OTHER.md");
    job = service.restore(job.id, initial.id, 1, document(job, initial.id).revision, "expert");
    assert.equal(document(job, initial.id).path, "AGENTS.md", "恢复历史路径和正文，新的未采纳建议不改变当前文稿");
    assert.equal(document(job, initial.id).archive_path, "AGENTS.md");
    assert.equal(document(job, initial.id).revision, 3);
    assert.equal(document(job, initial.id).content, initial.content);
    job = service.edit(job.id, { document: { ...document(job, initial.id), path: "OTHER.md" }, base_revision: 3 }, "expert");
    assert.equal(document(job, initial.id).path, "OTHER.md"); assert.equal(document(job, initial.id).archive_path, "OTHER.md");
  } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("#466 从正式知识发起更新保留已发生的归档快照，原编号改名后仍使用同一正式知识", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-rename-begin-update-")), repo = join(root, "repo"), guide = businessDocuments(1)[0];
  mkdirSync(dirname(join(repo, originalPath)), { recursive: true }); mkdirSync(join(repo, "src"));
  const sourceBaseline = "# 最初已有的文稿\n\n尚未整理的旧内容。";
  writeFileSync(join(repo, originalPath), sourceBaseline); writeFileSync(join(repo, "src/transfer.ts"), "export function transfer() { return 'completed'; }\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  git("add", "."); git("commit", "-qm", "initial source");
  let sourceRevision = git("rev-parse", "HEAD"), archiveCalls = 0;
  const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
    start: async (prompt: string) => {
      const context = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
      const call = async (name: string, args: unknown) => {
        const tool = config.extraTools.find((tool: any) => tool.name === name); assert.ok(tool, name);
        const response = await tool.execute("fixture", args, new AbortController().signal);
        assert.equal(!!response.isError, false, JSON.stringify(response));
        try { return JSON.parse(response.content[0].text); } catch { return response.content[0].text; }
      };
      await call("component_source", { action: "read", component_id: "repo-1", path: "src/transfer.ts" });
      if (context.mode === "extract") await call("knowledge_draft", { action: "save", document: guide });
      else {
        assert.equal(context.mode, "update"); assert.deepEqual(context.selected_document_ids, [guide.id]);
        const current = await call("knowledge_draft", { action: "read", id: guide.id });
        assert.equal(current.path, originalPath); assert.equal(current.content, originalBody);
        await call("knowledge_draft", { action: "save", document: { ...current, path: renamedPath, content: `${originalBody}\n\n补充任务失败后的重试规则。` } });
      }
      await call("knowledge_work_result", { summary: "业务文稿已保存", document_ids: [guide.id] });
      return { status: "turn_finished" };
    }, dispose() {}, abort: async () => {}, startResume: async () => { throw new Error("已保存结果不应追加模型会话"); },
  }) as any);
  const service = new DomainKnowledgeExtraction(root, input => runDomainKnowledge(input, { dataDir: root,
    model: () => ({ provider: "fixture", model: "fixture", json: {} }), source: async () => ({ root: repo, revision: sourceRevision }) }), {
    publish: async (job, target, _previous, _operator, save) => {
      archiveCalls++;
      const documents = job.documents.filter(document => document.selected && document.target_id === target.id);
      git("checkout", "-qb", "codex/knowledge-466-original");
      for (const document of documents) writeFileSync(join(repo, document.path), document.content);
      git("add", "."); git("commit", "-qm", "archive original knowledge"); sourceRevision = git("rev-parse", "HEAD");
      const publication: DomainPublication = { target_id: target.id, branch: "codex/knowledge-466-original", revision: sourceRevision, state: "opened", url: "https://example.test/mr/466", documents: documents.map(document => ({ id: document.id,
        path: document.path, content: document.content, revision: document.revision, knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision })) };
      save(publication); return publication;
    },
  });
  try {
    let original = await finished(service, service.create({ issue_no: "466-update", title: "传输规则", scope: "读取已维护知识并改名", knowledge_target: knowledgeTarget, repositories: [businessRepository(1)] }, "expert").id);
    assert.equal(document(original, guide.id).base_content, sourceBaseline);
    original = await service.publish(original.id, "expert");
    const formalId = document(original, guide.id).knowledge_document_id!;
    await service.createArchive(original.id, { issue_no: "466-update", expected_revisions: service.previewArchive(original.id).expected_revisions }, "expert");
    original = service.get(original.id);
    const snapshots = structuredClone(original.archive_batches!);
    const fixed = snapshots.find(batch => batch.publications.some(publication => publication.state === "opened"))!;
    assert.ok(fixed); assert.equal(fixed.publications[0].documents[0].path, originalPath);
    assert.equal(fixed.publications[0].documents[0].content, originalBody);
    assert.notEqual(fixed.publications[0].documents[0].content, sourceBaseline, "已归档版本与最初 Git 基线不同，不能只靠旧 base_content 改名");
    assert.equal(git("show", `${fixed.publications[0].revision}:${originalPath}`), originalBody);
    let update = await finished(service, service.beginUpdate(formalId, { expected_revision: document(original, guide.id).published_revision, message: "沿用原文稿编号改为业务目录名称" }, "expert").id);
    assert.notEqual(update.id, original.id); assert.equal(document(update, guide.id).knowledge_document_id, formalId);
    assert.deepEqual(update.archive_batches, [], "新任务不接管旧任务的归档批次操作");
    assert.deepEqual(update.publication_history?.find(publication => publication.branch === fixed.publications[0].branch && publication.revision === fixed.publications[0].revision), fixed.publications[0], "已推送的精确文档快照作为历史证据保留");
    assert.deepEqual(update.publications, [], "旧 MR 不冒充新任务已经归档");
    assert.deepEqual(service.get(original.id).archive_batches, snapshots, "旧任务的归档批次未被新更新流程改写");
    update = service.decide(update.id, update.turns.at(-1)!.id, guide.id, "accept", "expert");
    update = await service.publish(update.id, "expert");
    assert.equal(document(update, guide.id).path, renamedPath); assert.equal(document(update, guide.id).knowledge_document_id, formalId);
    assert.equal(listKnowledgeDocuments(root).length, 1);
    assert.equal(readKnowledgeDocument(root, formalId).archive_target!.path, renamedPath);
    assert.deepEqual(update.publication_history?.find(publication => publication.branch === fixed.publications[0].branch && publication.revision === fixed.publications[0].revision), fixed.publications[0], "新的正式版本没有修改原归档证据");
    assert.deepEqual(service.get(original.id).archive_batches, snapshots);
    assert.equal(archiveCalls, 1, "更新与发布不推进旧 MR，也不自动开始新 Git 归档");
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});
