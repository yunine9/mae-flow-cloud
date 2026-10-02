import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import type { ResearchRecord } from "../src/componentResearch.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
function publishingFixtures() {
  const record = { id: "cr-publish", topic: "文件组件使用指南", language: "cpp", status: "done", stage: "待审查", operator: "dev", created_at: "2026-09-30T00:00:00Z", evidence: [],
    document: { overview: "# 文件组件使用指南", sections: ["打开与关闭", "异步读取"].map((title, index) => ({ id: `section-${index}`, title, repository_ids: ["file"], selected: true, revision: 3, content: "由调用方负责释放句柄。", interfaces: "Open / Close", integration: "链接 file", example: "调用 Close 释放句柄。", sources: "src/file.cpp", related_ids: [] })) } } as unknown as ResearchRecord;
  record.review_turns = record.document!.sections.map((section, index) => ({ id: `proposal-${index}`, section_id: section.id, mode: "rework", message: "请明确资源释放顺序", operator: "dev", status: "done", created_at: record.created_at,
    proposal: { base_revision: index === 0 ? section.revision : section.revision - 1, status: "pending", section: { ...section, content: `${section.content}\n\n最新修改：先取消回调，再释放句柄。` } } }));
  const initial = projectKnowledgeProduction({ kind: "component", record });
  record.document!.sections.forEach(section => { section.selected = false; });
  const none = projectKnowledgeProduction({ kind: "component", record });
  record.document!.sections[0].selected = true;
  const selected = projectKnowledgeProduction({ kind: "component", record });
  record.review_turns.push({ ...structuredClone(record.review_turns[0]), id: "proposal-late" });
  const late = projectKnowledgeProduction({ kind: "component", record });
  record.review_turns[2].status = "failed";
  const failed = projectKnowledgeProduction({ kind: "component", record });
  record.review_turns[2].status = "done";
  record.document!.sections[0].revision = 4;
  record.review_turns[0].proposal!.status = "discarded";
  record.review_turns[2].proposal!.status = "accepted";
  const accepted = projectKnowledgeProduction({ kind: "component", record });
  record.document_id = "kd-published";
  const adopted = projectKnowledgeProduction({ kind: "component", record });
  const archive: DomainKnowledgeJob = { id: "archive", component_research_id: record.id, title: record.topic, status: "done", stage: "待确认", scope: "组件归档", operator: "dev", created_at: record.created_at, issue_no: "REQ-447", issue_description: "整理基础组件联合使用指南", repositories: [], revisions: {}, turns: [], evidence: [], material_ids: [], use_wxdoubao: false, ar_codes: [],
    knowledge_target: { id: "domain", name: "组件知识仓", repository: "https://example.test/file.git", branch: "master", path: "", docs_path: "docs/components" }, documents: [{ id: "component-guide", title: record.topic, target_id: "domain", layer: "domain", path: "docs/components/guide.md", content: "指南", sources: "src/file.cpp", revision: 1, history: [], selected: true, base_content: null, base_revision: "", remote_review: { id: "remote", target_content: null, target_revision: "a".repeat(40), reviewed: true } }], publications: [], archive_batches: [] };
  const prepared = projectKnowledgeProduction({ kind: "domain", record: archive });
  const openedArchive = structuredClone(archive);
  Object.assign(openedArchive.documents[0], { knowledge_document_id: "kd-published", published_revision: "b".repeat(64), published_document_revision: 1 });
  openedArchive.publications = [{ target_id: "domain", state: "opened", branch: "knowledge", mr_id: 128, url: "https://example.test/mr/128", documents: [] }];
  openedArchive.archive_batches = [{ id: "batch", created_at: record.created_at, operator: "dev", state: "done", documents: structuredClone(openedArchive.documents), targets: [openedArchive.knowledge_target], publications: structuredClone(openedArchive.publications) }];
  return { archive, openedArchive, projections: { initial, none, selected, late, failed, accepted, adopted, prepared,
    openedArchive: projectKnowledgeProduction({ kind: "domain", record: openedArchive }),
    opened: projectKnowledgeProduction({ kind: "component", record, archive: openedArchive }) } };
}
test("生产线验收8：组件任务沿用后端状态，过程与文稿保留阅读位置，候选预检后一键确认并发布和归档", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "component-publishing-"));
  try {
    const built = await build({ entryPoints: [resolve("tests/browser/componentResearchPublishing.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(file => file.endsWith(".css")).map(file => readFileSync(join(assets, file), "utf8")).join("\n");
    const html = join(dir, "check.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="app"></div><pre id="result" style="display:none"></pre><script>window.__COMPONENT_PUBLISHING_FIXTURES__=' + JSON.stringify(publishingFixtures()).replaceAll("</script", "<\\/script") + ';</script><script>' + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const dump = join(dir, `${width}.html`), fd = openSync(dump, "w");
      try {
        execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, `profile-${width}`)}`, `--window-size=${width},${height}`, "--virtual-time-budget=12000", "--dump-dom", `file://${html}`], { timeout: 25000, stdio: ["ignore", fd, "ignore"] });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw error; }
      finally { closeSync(fd); }
      const dom = readFileSync(dump, "utf8");
      const result = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${width}: browser did not finish`);
      const value = JSON.parse(result); assert.equal(value.error, undefined, `${width}: ${value.error}`); assert.equal(value.passed, true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
