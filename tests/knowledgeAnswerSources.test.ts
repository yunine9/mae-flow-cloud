import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeSearch } from "../src/knowledgeSearch.ts";
import type { MemorySidecar } from "../src/memorySidecar.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { createBusinessModule, publishBusinessKnowledgeAsset } from "../src/businessModuleLibrary.ts";
import { retrieveKnowledgeAnswerEvidence, knowledgeAnswerSourceCatalog } from "../src/knowledgeAnswerSources.ts";
import type { KnowledgeAnswerExecution, KnowledgeAnswerContext, KnowledgeAnswerRecord } from "../src/knowledgeAnswerTypes.ts";
import { consumptionFixture } from "./componentConsumptionFixture.ts";
import { MemoryStore } from "../src/taskMemory.ts";

function execution(context?: KnowledgeAnswerContext) {
  const record: KnowledgeAnswerRecord = { id: "qa-test", question: "条件及例外是什么？", context, owner: "owner", status: "running", stage: "researching",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), evidence: [], activity: [], warnings: [] };
  const controller = new AbortController();
  const input: KnowledgeAnswerExecution = { record, root: "/test", signal: controller.signal, progress() {}, warn(message) { record.warnings.push(message); },
    addEvidence(value) { const evidence = { ...value, id: `e${record.evidence.length + 1}`, digest: createHash("sha256").update(value.content).digest("hex"), retrieved_at: new Date().toISOString() };
      record.evidence.push(evidence); return evidence; } };
  return { input, record, controller };
}
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "qa-documents-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// 替代向量服务以核对宿主检索边界；不把候选生成视为真实模型召回质量验收。
function indexedSearch(dir: string, beforeSearch?: () => void) {
  const ingested: string[] = [], queried: string[][] = [];
  const sidecar = {
    ingest: async (path: string) => { ingested.push(path); return true; }, remove: async () => true,
    search: async ({ sources }: { sources: Array<{ id: string; path: string }> }) => {
      queried.push(sources.map(source => source.id));
      beforeSearch?.();
      return sources.map(source => {
        const lines = readFileSync(source.path, "utf8").split("\n");
        const line = lines.findIndex(line => line === "目标条件：只有完成确认才能开始。") + 1;
        return { id: source.id, snippet: "搜索摘要不能冒充正文", score: 1, start_line: line || undefined, end_line: line || undefined };
      });
    },
  } as unknown as MemorySidecar;
  const search = new KnowledgeSearch(dir, sidecar);
  return { search, ingested, queried };
}
const retrieve = (q: ReturnType<typeof execution>, dir: string, search: KnowledgeSearch, maxChars = 48_000) =>
  retrieveKnowledgeAnswerEvidence(q.input, { dataDir: dir, search, maxChars });

test("只列已发布文档；提问不建索引，准备完成后读取真实正文", async t => {
  const dir = fixture(t), f = indexedSearch(dir);
  const doc = saveKnowledgeDocument(dir, { title: "平台规则", content: "# 范围\n目标条件：只有完成确认才能开始。\n例外：撤销后不得开始。" }, "owner");
  saveKnowledgeDocument(dir, { title: "停用文档", content: "不能引用", active: false }, "owner");
  const store = new MemoryStore(dir);
  const memory = store.record({ source: "agent_note", judged_by: "human", scope: "platform", repo: "other", paths: [], task: "task-1", evidence: "example", trigger: "经验", conclusion: "不能作为此次文档问答的来源" });
  store.review(memory.id, "owner", { decision: "accepted", revision: 1 });
  const catalog = knowledgeAnswerSourceCatalog(dir, f.search);
  assert.deepEqual(catalog.documents.map(row => row.id), [doc.id]);
  assert.deepEqual(catalog.sources.map(row => row.kind), ["knowledge"]);
  assert.equal("repositories" in catalog, false);
  const waiting = execution(); await retrieve(waiting, dir, f.search);
  assert.equal(f.ingested.length, 0); assert.equal(f.queried.length, 0);
  assert.equal(waiting.record.evidence.length, 0);
  assert.match(waiting.record.warnings.join(), /索引尚未就绪/);
  await f.search.prepare(); const ingests = f.ingested.length;
  const q = execution(); await retrieve(q, dir, f.search);
  assert.equal(f.ingested.length, ingests, "问答不触发补索引");
  assert.deepEqual(f.queried.at(-1), [doc.id]);
  assert.equal(q.record.evidence[0].content, doc.content);
  assert.equal(q.record.evidence[0].revision, doc.revision);
  assert.doesNotMatch(q.record.evidence[0].content, /搜索摘要/);
});

test("文档编辑后旧索引立即排除；后台准备新版后重新可查；停用后不可查", async t => {
  const dir = fixture(t), f = indexedSearch(dir);
  const doc = saveKnowledgeDocument(dir, { title: "规则", content: "原规则" }, "owner");
  await f.search.prepare();
  const newer = saveKnowledgeDocument(dir, { content: "新规则" }, "owner", doc.id);
  const stale = execution(); await retrieve(stale, dir, f.search);
  assert.equal(stale.record.evidence.length, 0); assert.equal(f.ingested.length, 1);
  await f.search.prepare();
  const fresh = execution(); await retrieve(fresh, dir, f.search);
  assert.equal(fresh.record.evidence[0].content, "新规则"); assert.equal(fresh.record.evidence[0].revision, newer.revision);
  saveKnowledgeDocument(dir, { active: false }, "owner", doc.id);
  const disabled = execution(); await retrieve(disabled, dir, f.search); assert.equal(disabled.record.evidence.length, 0);
});

test("部分索引就绪只返回当前已就绪文档，查询期间改变修订也不能引用", async t => {
  const dir = fixture(t), f = indexedSearch(dir);
  const ready = saveKnowledgeDocument(dir, { title: "已就绪", content: "有效条件" }, "owner");
  await f.search.prepare();
  saveKnowledgeDocument(dir, { title: "新发布", content: "还未入库" }, "owner");
  const q = execution(); await retrieve(q, dir, f.search);
  assert.deepEqual(q.record.evidence.map(e => e.source_id), [ready.id]);
  assert.match(q.record.warnings.join(), /部分文档/);
  const racing = indexedSearch(dir, () => { saveKnowledgeDocument(dir, { content: "查询期间已变化" }, "owner", ready.id); });
  await racing.search.prepare();
  const changed = execution({ document_id: ready.id });
  // 使用全库查询以经过检索期间的修订核对。
  changed.record.context = undefined;
  await retrieve(changed, dir, racing.search);
  assert.ok(!changed.record.evidence.some(e => e.source_id === ready.id));
});

test("选择模块、版本和文档均限制来源；指定小文档无向量服务也可直接读取", async t => {
  const dir = fixture(t), search = new KnowledgeSearch(dir);
  for (const id of ["alpha", "beta"]) {
    createBusinessModule(dir, { id, name: id, owner: "owner", description: "规则", repositories: [`https://example.test/${id}.git`] }, "owner");
    publishBusinessKnowledgeAsset(dir, id, { id: "rule", title: `${id}规则`, summary: "条件", when_to_use: "查询规则", content: `# ${id}\n${id}条件` }, "owner");
  }
  const allowed = execution({ module_ids: ["alpha"], document_id: "module:alpha:rule" }); await retrieve(allowed, dir, search);
  assert.match(allowed.record.evidence[0].content, /alpha条件/);
  const denied = execution({ module_ids: ["alpha"], document_id: "module:beta:rule" }); await retrieve(denied, dir, search);
  assert.equal(denied.record.evidence.length, 0); assert.match(denied.record.warnings.join(), /所选模块与版本/);
  const doc = saveKnowledgeDocument(dir, { title: "V1规则", content: "仅适用V1", product_versions: ["v1"] }, "owner");
  const wrongVersion = execution({ product_version: "v2", document_id: doc.id }); await retrieve(wrongVersion, dir, search);
  assert.equal(wrongVersion.record.evidence.length, 0);
  const missing = execution({ document_id: "missing" }); await retrieve(missing, dir, search);
  assert.equal(missing.record.evidence.length, 0);
});

test("长文档读取完整命中章节并保留原文行号，围栏中的标题不切断原文", async t => {
  const dir = fixture(t), f = indexedSearch(dir);
  const first = "# 规则\n## 无关章节\n" + "其他说明。\n".repeat(3500);
  const section = "## 使用条件\n目标条件：只有完成确认才能开始。\n```md\n## 围栏内的示例标题\n```\n### 例外\n撤销后不得开始。\n";
  saveKnowledgeDocument(dir, { title: "长规则", content: first + section + "## 其他\n无关末尾" }, "owner");
  await f.search.prepare();
  const q = execution(); await retrieve(q, dir, f.search);
  assert.equal(q.record.evidence[0].content, section.trimEnd());
  assert.equal(q.record.evidence[0].start_line, first.split("\n").length);
  assert.equal(q.record.evidence[0].end_line, first.split("\n").length + section.trimEnd().split("\n").length - 1);
  const limited = execution(); await retrieve(limited, dir, f.search, 100);
  assert.equal(limited.record.evidence.length, 0); assert.match(limited.record.warnings.join(), /完整章节超出/);
});

test("组件命中读取已发布的公共配置与完整用法，不调用源码或外部服务", async () => {
  const f = consumptionFixture();
  try {
    const doc = f.publish(), indexed = indexedSearch(f.data);
    const asset = indexed.search.read({ repo: "", repositories: [], moduleIds: [] }, doc.id, true)!;
    assert.equal(indexed.search.documentStatus(asset).state, "queued");
    await indexed.search.prepare();
    assert.equal(indexed.search.documentStatus(asset).state, "ready");
    const q = execution(); await retrieve(q, f.data, indexed.search);
    assert.equal(q.record.evidence.length, 1);
    const e = q.record.evidence[0];
    assert.equal(e.source_id, doc.id); assert.match(e.content, /pool v2/); assert.match(e.content, /退出前等待任务完成/);
    assert.match(e.content, /不能释放捕获的对象/); assert.match(e.content, /TEST\(Pool/);
    assert.match(e.location!, /完整用法/);
  } finally { f.cleanup(); }
});

test("检索取消后不保存证据；服务缺失不生成无依据的原文", async t => {
  const dir = fixture(t), doc = saveKnowledgeDocument(dir, { title: "规则", content: "真实原文" }, "owner");
  const q = execution({ document_id: doc.id }); q.controller.abort();
  await assert.rejects(retrieve(q, dir, new KnowledgeSearch(dir)), /取消/);
  assert.equal(q.record.evidence.length, 0);
  const unavailable = execution(); await retrieve(unavailable, dir, new KnowledgeSearch(dir));
  assert.equal(unavailable.record.evidence.length, 0); assert.match(unavailable.record.warnings.join(), /检索服务未配置/);
});

test("文档中的公开属性引用可读，疑似密钥原文不进入回答上下文", async t => {
  const dir = fixture(t), search = new KnowledgeSearch(dir);
  const safe = saveKnowledgeDocument(dir, { title: "公开示例", content: "apiKey: args.apiKey," }, "owner");
  const denied = saveKnowledgeDocument(dir, { title: "待检查示例", content: 'password: "fixture-only-password",' }, "owner");
  const q = execution({ document_id: safe.id }); await retrieve(q, dir, search);
  assert.equal(q.record.evidence[0].content, safe.content);
  const blocked = execution({ document_id: denied.id }); await retrieve(blocked, dir, search);
  assert.equal(blocked.record.evidence.length, 0); assert.match(blocked.record.warnings.join(), /疑似敏感字段/);
  assert.doesNotMatch(blocked.record.warnings.join(), /fixture-only-password/);
});
