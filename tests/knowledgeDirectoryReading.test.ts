import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { knowledgeDocumentCatalog, knowledgeDocumentDirectory, readCatalogKnowledgeDocument } from "../src/knowledgeDocumentCatalog.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { createTaskServer } from "../src/server.ts";
import type { TaskService } from "../src/taskService.ts";
import { MemoryStore } from "../src/taskMemory.ts";
import { gitKnowledgeDocument } from "./fixtures/gitKnowledge.ts";

test("轻量目录保留正式知识与经验的展示口径，读取单篇不装配全库正文", () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-directory-"));
  const original = fs.readFileSync;
  try {
    createBusinessModule(dir, { id: "access", name: "接入", description: "接入模块", owner: "owner", repositories: ["https://example.test/access.git"] }, "owner");
    const git = gitKnowledgeDocument(dir, "access", { title: "接入说明.md", content: "# 接入\n正文\n" });
    const manual = saveKnowledgeDocument(dir, { title: "工程手册", content: "# 工程\n约定" }, "owner");
    const draft = saveKnowledgeDocument(dir, { title: "旧业务草稿", content: "不要作为正式知识", scope: "module", module_ids: ["access"] }, "owner");
    const store = new MemoryStore(dir);
    const memory = store.record({ source: "agent_note", judged_by: "human", scope: "platform", repo: "r", paths: [],
      task: "task-1", evidence: "fixture", trigger: "读取文件", conclusion: "检查句柄" });
    store.review(memory.id, "owner", { decision: "accepted", revision: 1 });
    const full = knowledgeDocumentCatalog(dir).documents.map(({ content, ...document }) =>
      ({ ...document, lines: content.split("\n").length }));
    assert.deepEqual(knowledgeDocumentDirectory(dir), full);
    assert.ok(!full.some(document => document.id === draft.id));
    const reads: string[] = [];
    fs.readFileSync = ((path: any, ...args: any[]) => {
      if (String(path).includes("/knowledge-git/modules/") || String(path).includes("/knowledge-documents/")) reads.push(String(path));
      return (original as any)(path, ...args);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    const lightweight = knowledgeDocumentDirectory(dir);
    assert.equal(reads.length, 0, "已有目录缓存时不再读正式快照及旧文稿正文");
    assert.equal(readCatalogKnowledgeDocument(dir, git.id)?.content, git.content);
    assert.equal(reads.length, 0, "单篇 Git 正文也不能重新扫描全部快照或旧文稿");
    assert.equal(lightweight.find(document => document.id === git.id)?.lines, 3);
    assert.ok(lightweight.every(document => !("content" in document)));
    const changed = saveKnowledgeDocument(dir, { content: "# 工程\n新规则\n" }, "owner", manual.id);
    reads.length = 0;
    const next = knowledgeDocumentDirectory(dir).find(document => document.id === manual.id)!;
    assert.equal(next.revision, changed.revision);
    assert.equal(next.lines, 3);
    assert.equal(reads.filter(path => path.endsWith(`${manual.id}.json`)).length, 1,
      "变更后只读取这篇正文以更新目录");
    assert.equal(readCatalogKnowledgeDocument(dir, draft.id), undefined);
  } finally {
    fs.readFileSync = original; syncBuiltinESMExports();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("知识目录 HTTP 不计算全文索引或需求任务效果，任务摘要不返回文稿清单", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-directory-http-"));
  let effects = 0, domainLists = 0;
  const service = {
    options: { dataDir: dir },
    getKnowledgeSearch: () => { throw new Error("轻量目录不应读取索引状态"); },
    hostSkillShelf: () => { effects++; return { root_exists: false, skills: [], warnings: [] }; },
    getDomainKnowledgeExtraction: () => ({ taskRows: () => { domainLists++; return []; }, warnings: () => [] }),
    getComponentResearch: () => ({ taskRows: () => [], warnings: () => [] }),
    skillExtractionJob: () => undefined,
    knowledgeRecordWarnings: () => [],
  } as unknown as TaskService;
  const server = createTaskServer(service);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = async (path: string) => {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    return response.json() as Promise<any>;
  };
  try {
    const doc = saveKnowledgeDocument(dir, { title: "工程手册", content: "# 规则\n正文" }, "owner");
    const list = await get("/knowledge-documents?view=directory");
    assert.equal(list.documents[0].id, doc.id);
    assert.equal(list.documents[0].content, undefined);
    assert.equal((await get(`/knowledge-documents/${doc.id}`)).content, doc.content);
    await get("/skills?view=directory"); await get("/skills?view=directory");
    assert.equal(effects, 0, "目录请求不能投影需求任务");
    await get("/skills");
    assert.equal(effects, 1, "管理页仍保留原效果统计");
    assert.deepEqual(await get("/knowledge-tasks?summary=1"), { summary: { running: 0, attention: 0, total: 0 } });
    await get("/knowledge-tasks?summary=1");
    assert.equal(domainLists, 1, "多个页面的短时间摘要读取共用结果");
    assert.ok(Array.isArray((await get("/knowledge-tasks")).tasks));
    assert.equal(domainLists, 2, "任务中心完整列表始终读取当前状态");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
