import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBusinessModule, publishBusinessKnowledgeAsset, archiveBusinessKnowledgeAsset } from "../src/businessModuleLibrary.ts";
import { createKnowledgeCandidate, decideKnowledgeCandidate } from "../src/knowledgeCandidates.ts";
import { collectSearchableKnowledge, KnowledgeSearch, knowledgeProductVersions } from "../src/knowledgeSearch.ts";
import { createKnowledgeTool } from "../src/knowledgeTools.ts";
import { MemorySidecar } from "../src/memorySidecar.ts";
import { MemoryStore } from "../src/taskMemory.ts";

const context = { repo: "a", repositories: ["https://code.example/a.git"], moduleIds: [], productVersion: "2.7B" };
function seed(dir: string) {
  createBusinessModule(dir, { id: "alarm", name: "告警模块", description: "跨仓告警", owner: "owner",
    repositories: [context.repositories[0], "https://code.example/b.git"] }, "owner");
  publishBusinessKnowledgeAsset(dir, "alarm", { id: "dedup", title: "告警重复事件", summary: "事件去重",
    when_to_use: "处理告警重复上报时", content: "# 重复告警\n按事件 ID 和网元 ID 去重。" }, "owner");
  function document(title: string, body: string, published = true) {
    const row = createKnowledgeCandidate(dir, { source_task_id: "task-1", title, summary: title,
      when_to_use: "修改超时配置时", nature: "engineering", form: "document", technologies: ["cpp"], content: body }, "owner");
    if (published) decideKnowledgeCandidate(dir, row.id, "published", "owner");
    return `team:${row.id}`;
  }
  const old = document("2.6B 超时配置", '---\nproduct_versions: ["2.6B"]\n---\n配置 request_timeout_ms，单位毫秒。');
  const current = document("2.7B 超时配置", '---\nproduct_versions: ["2.7B"]\n---\n配置 request_timeout_seconds，单位秒。');
  const pending = document("未经确认的规范", "不要使用", false);
  return { old, current, pending };
}

test("当前模块映射可发现跨仓知识；明确产品版本先筛选；草稿不参与；无元数据不猜版本", () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-catalog-"));
  try {
    const ids = seed(dir);
    const catalog = collectSearchableKnowledge(dir, context);
    assert.ok(catalog.assets.some(a => a.id === "module:alarm:dedup"), "无需开局先选中模块");
    assert.ok(catalog.assets.some(a => a.id === ids.current));
    assert.ok(!catalog.assets.some(a => a.id === ids.old || a.id === ids.pending));
    assert.deepEqual(knowledgeProductVersions("文档修订 2.6B；不适用于 2.7B"), []);
    assert.ok(collectSearchableKnowledge(dir, { ...context, productVersion: undefined }).assets.some(a => a.id === ids.old));
    archiveBusinessKnowledgeAsset(dir, "alarm", "dedup", "owner");
    assert.ok(!collectSearchableKnowledge(dir, context).assets.some(a => a.id === "module:alarm:dedup"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("等待索引期间被停用的模块不返回；工具只回当前来源，不信旧索引正文", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-race-"));
  try {
    seed(dir);
    const fake = { ingest: async () => true, search: async () => {
      archiveBusinessKnowledgeAsset(dir, "alarm", "dedup", "owner");
      return [{ id: "module:alarm:dedup", snippet: "过期正文", score: 1 }];
    } } as unknown as MemorySidecar;
    const service = new KnowledgeSearch(dir, fake);
    assert.deepEqual((await service.search(context, "告警去重")).hits, []);
    assert.equal(service.read(context, "module:alarm:dedup"), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("统一工具提示词含明确动作示例；正文可离线读，停用后不能复用，故障不阻塞", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-tool-"));
  try {
    const ids = seed(dir);
    const service = new KnowledgeSearch(dir);
    const tool: any = createKnowledgeTool({ service: () => service, context: () => context });
    assert.match(tool.promptGuidelines!.join("\n"), /异步回调.*YAML/);
    assert.match(tool.promptGuidelines!.join("\n"), /不在每次/);
    const result = await tool.execute("read", { action: "read", id: ids.current });
    assert.match(result.content[0].text, /request_timeout_seconds/);
    assert.match(result.content[0].text, /不是产品版本/);
    const missing = await tool.execute("search", { action: "search", query: "超时配置" });
    assert.match(missing.content[0].text, /继续当前任务/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("真实统一工具串行索引、模块召回、版本筛选、经验搜索及停用；本机实测", { timeout: 60000 }, async t => {
  const python = process.env.MFC_MEMSEARCH_PYTHON;
  if (!python) { t.skip("设置 MFC_MEMSEARCH_PYTHON 运行真实模型"); return; }
  const dir = mkdtempSync(join(tmpdir(), "knowledge-real-"));
  const sidecar = new MemorySidecar({ python, script: join(process.cwd(), "harness/memsearch-sidecar.py"),
    corpusDir: join(dir, "corpus"), milvusPath: join(dir, "index.db"),
    env: { HF_HUB_OFFLINE: "1", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "corp.example", no_proxy: "internal.example" } });
  try {
    const ids = seed(dir);
    const store = new MemoryStore(dir);
    const row = store.record({ source: "agent_note", judged_by: "human", scope: "platform", repo: "other", paths: [],
      task: "task-1", evidence: "example", trigger: "C++ 异步回调访问已销毁对象", conclusion: "使用弱引用，并在访问前检查对象是否仍有效。" });
    store.review(row.id, "owner", { decision: "accepted", revision: 1 });
    assert.equal(await sidecar.start(), true);
    const service = new KnowledgeSearch(dir, sidecar);
    const tool: any = createKnowledgeTool({ service: () => service, context: () => context });
    const module = await tool.execute("module", { action: "search", query: "告警重复事件如何去重" });
    assert.ok((module.details as any).hits?.some((h: any) => h.id === "module:alarm:dedup"), JSON.stringify(module));
    const version = await service.search(context, "2.7B 超时参数的配置单位");
    assert.ok(version.hits.some(h => h.id === ids.current));
    assert.ok(!version.hits.some(h => h.id === ids.old));
    const callback = await service.search(context, "回调还没结束对象就释放了怎么办");
    assert.equal(callback.hits[0]?.id, row.id, JSON.stringify(callback));
    assert.deepEqual((await service.search(context, "办公室盆栽多久浇一次水")).hits, []);
    archiveBusinessKnowledgeAsset(dir, "alarm", "dedup", "owner");
    assert.ok(!(await service.search(context, "告警重复事件如何去重")).hits.some(h => h.id === "module:alarm:dedup"));
    const read = await tool.execute("read-old", { action: "read", id: "module:alarm:dedup" });
    assert.match(read.content[0].text, /已停用/);
  } finally { sidecar.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test("索引缓慢有时间上限且不重复排队；完成后下一次查询可正常使用", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-budget-"));
  let finish!: (value: boolean) => void;
  let calls = 0;
  const waiting = new Promise<boolean>(resolve => { finish = resolve; });
  try {
    seed(dir);
    const fake = { ingest: async () => { calls++; return waiting; }, search: async () => [] } as unknown as MemorySidecar;
    const service = new KnowledgeSearch(dir, fake), before = Date.now();
    const result = await service.search(context, "超时配置");
    assert.equal(result.available, false);
    assert.ok(Date.now() - before < 2500);
    assert.equal(calls, 1, "尚未完成的索引作业串行，不向侧车灌入大量超时请求");
    finish(true);
    assert.equal((await service.search(context, "超时配置")).available, true);
    assert.equal(calls, 2, "两个有效资产各索引一次，重复查询复用在途作业");
  } finally { finish?.(true); rmSync(dir, { recursive: true, force: true }); }
});

test("检索指引进入实际 PI 系统提示词，提供统一工具名及简短行动示例", async () => {
  const { buildSystemPrompt } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js");
  const tool = createKnowledgeTool({ service: () => undefined, context: () => context });
  const prompt = buildSystemPrompt({ cwd: "/test", selectedTools: [tool.name],
    toolSnippets: { [tool.name]: tool.promptSnippet! }, promptGuidelines: tool.promptGuidelines });
  assert.match(prompt, /knowledge\(action=search/);
  assert.match(prompt, /C\+\+ 异步回调 对象销毁 生命周期/);
  assert.match(prompt, /不在每次读文件、改代码前重复搜索/);
  assert.match(prompt, /不反复空查或等待/);
});


test("Skill 从当前生效包读取，更新和删除后不复活发布回执的旧正文", () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-skill-"));
  try {
    const record = createKnowledgeCandidate(dir, { source_task_id: "task-1", title: "构建指南", summary: "构建方法",
      when_to_use: "首次构建", nature: "engineering", form: "skill", technologies: ["cpp"], content: "旧的做法" }, "owner");
    decideKnowledgeCandidate(dir, record.id, "published", "owner", { published_target: "skills/build-guide" });
    const root = join(dir, "skills", "build-guide");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "SKILL.md"), "---\nname: build-guide\ndescription: 首次构建\nknowledge_nature: engineering\ntechnologies: [cpp]\n---\n# 构建指南\n当前正确做法\n");
    const service = new KnowledgeSearch(dir);
    assert.match(service.read(context, "skill:build-guide/SKILL.md")!.content, /当前正确做法/);
    assert.equal(service.read(context, `team:${record.id}`), undefined);
    rmSync(root, { recursive: true });
    assert.equal(service.read(context, "skill:build-guide/SKILL.md"), undefined);
    assert.equal(service.read(context, `team:${record.id}`), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("新任务只宣传统一检索，恢复的旧会话保留工具名兼容而不重复注入检索指引", async () => {
  const { TaskService } = await import("../src/taskService.ts");
  const dir = mkdtempSync(join(tmpdir(), "knowledge-session-"));
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  try {
    const api = service as any, task = api.tasks.get(service.create("检索经验").id);
    task.resume = false;
    assert.deepEqual(api.memoryTools(task).map((tool: any) => tool.name).sort(), ["corpus_write", "knowledge"]);
    task.resume = true;
    const tools = api.memoryTools(task);
    assert.ok(tools.some((tool: any) => tool.name === "knowledge"));
    for (const name of ["corpus_search", "corpus_expand"]) {
      const legacy = tools.find((tool: any) => tool.name === name);
      assert.ok(legacy);
      assert.deepEqual(legacy.promptGuidelines, []);
    }
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
