// 复现：任一条记录文件损坏（空文件/截断），整个子系统不可用，而不是隔离坏记录。
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DomainKnowledgeExtraction } from "../../../src/domainKnowledgeExtraction.ts";
import { ComponentResearch } from "../../../src/componentResearch.ts";
import { listKnowledgeDocuments, saveKnowledgeDocument } from "../../../src/knowledgeDocuments.ts";

test("一个 job.json 截断 → 领域萃取管理器构造失败（所有领域/组件归档接口 400）", () => {
  const dir = mkdtempSync(join(tmpdir(), "r8-"));
  try {
    const id = `dkx-${randomUUID()}`; mkdirSync(join(dir, "domain-extraction", id), { recursive: true });
    writeFileSync(join(dir, "domain-extraction", id, "job.json"), "{\"id\":");
    let error = ""; try { new DomainKnowledgeExtraction(dir, async () => ""); } catch (e) { error = (e as Error).message; }
    console.log("[r8] domain:", error); assert.ok(error);
    const cr = `cr-${randomUUID()}`; mkdirSync(join(dir, "component-research", cr), { recursive: true });
    writeFileSync(join(dir, "component-research", cr, "record.json"), "");
    error = ""; try { new ComponentResearch(dir, async () => ""); } catch (e) { error = (e as Error).message; }
    console.log("[r8] component:", error); assert.ok(error);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("一份正式知识 JSON 截断 → 正式库列表与任何发布都失败", () => {
  const dir = mkdtempSync(join(tmpdir(), "r8-docs-"));
  try {
    saveKnowledgeDocument(dir, { title: "好文档", content: "正文" }, "alice");
    writeFileSync(join(dir, "knowledge-documents", `kd-${randomUUID()}.json`), "");
    let error = ""; try { listKnowledgeDocuments(dir); } catch (e) { error = (e as Error).message; }
    console.log("[r8] list:", error); assert.ok(error);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
