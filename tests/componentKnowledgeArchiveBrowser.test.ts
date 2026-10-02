import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import type { ResearchRecord } from "../src/componentResearch.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
function archiveProductionFixtures() {
  const record = { id: "cr-browser", status: "done", language: "cpp", topic: "组件指南", draft: "新组件规则" } as ResearchRecord;
  const prepared: DomainKnowledgeJob = { id: "dkx-component", component_research_id: record.id, title: "组件指南", issue_no: "REQ-component", issue_description: "组件指南归档到知识仓", scope: "组件归档", operator: "用户", created_at: "2026-10-03T00:00:00Z", repositories: [], knowledge_target: { id: "domain", name: "组件知识归档仓", repository: "https://example.test/knowledge.git", branch: "main", path: "", docs_path: "docs/components" }, material_ids: [], use_wxdoubao: false, ar_codes: [], status: "done", stage: "待确认", revisions: {}, turns: [], evidence: [], publications: [], documents: [{ id: "guide", title: "组件指南", target_id: "domain", layer: "domain", path: "docs/components/guide.md", content: "# 新组件指南\n新组件规则\n", sources: "源码", selected: true, revision: 1, base_content: null, base_revision: "", history: [], remote_review: { id: "snapshot", target_content: "# 仓内原文\n人工项目规范\n", target_revision: "a".repeat(40), reviewed: false } }] };
  const reconciled = structuredClone(prepared);
  Object.assign(reconciled.documents[0], { content: reconciled.documents[0].remote_review!.target_content, revision: 2 });
  reconciled.documents[0].remote_review!.reviewed = true;
  const unchanged = structuredClone(reconciled);
  Object.assign(unchanged.documents[0], { knowledge_document_id: "kd-browser", published_revision: "b".repeat(64), published_document_revision: 2 });
  unchanged.publications = [{ target_id: "domain", state: "unchanged", branch: "codex/component", documents: [] }];
  const preparedAgain = structuredClone(prepared);
  preparedAgain.documents[0].revision = 3; preparedAgain.publications = structuredClone(unchanged.publications);
  const reconciledAgain = structuredClone(preparedAgain);
  reconciledAgain.documents[0].revision = 4; reconciledAgain.documents[0].remote_review!.reviewed = true;
  const opened = structuredClone(reconciledAgain);
  Object.assign(opened.documents[0], { knowledge_document_id: "kd-browser", published_revision: "b".repeat(64), published_document_revision: 4 });
  opened.publications = [{ target_id: "domain", state: "opened", branch: "codex/component", documents: [], cleanup_id: "clean-1", url: "https://example.test/mr/1" }];
  return { record: projectKnowledgeProduction({ kind: "component", record }),
    prepared: projectKnowledgeProduction({ kind: "domain", record: prepared }),
    reconciled: projectKnowledgeProduction({ kind: "domain", record: reconciled }),
    unchanged: projectKnowledgeProduction({ kind: "domain", record: unchanged }),
    preparedAgain: projectKnowledgeProduction({ kind: "domain", record: preparedAgain }),
    reconciledAgain: projectKnowledgeProduction({ kind: "domain", record: reconciledAgain }),
    opened: projectKnowledgeProduction({ kind: "domain", record: opened }) };
}
test("生产线验收8：组件归档使用后端状态文案，同名文件核对、可选清理与单次 MR 提交仍可达", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "component-archive-browser-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/componentKnowledgeArchive.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(f => f.endsWith(".css")).map(f => readFileSync(join(assets, f), "utf8")).join("\n");
    const html = join(root, "check.html");
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>${css} #result { display: none; }</style><aside style="position:fixed;width:180px;padding:24px">MAEFlow Cloud<br><br><strong>知识库</strong><br><br>团队资产</aside><div style="margin-left:180px;padding:24px"><h1 style="font-size:28px;margin-bottom:20px">知识库</h1><div id="app"></div></div><pre id="result"></pre><script>window.__COMPONENT_ARCHIVE_PRODUCTIONS__=${JSON.stringify(archiveProductionFixtures()).replaceAll("</script", "<\\/script")};</script><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`);
    for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const output = join(root, `${width}.html`), fd = openSync(output, "w");
      try { execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(root, String(width))}`, `--window-size=${width},${height}`, "--virtual-time-budget=10000", "--dump-dom", ...(process.env.MFC_RESEARCH_SCREENSHOT_DIR ? [`--screenshot=${join(process.env.MFC_RESEARCH_SCREENSHOT_DIR, `component-archive-${width}.png`)}`] : []), `file://${html}`], { timeout: 25000, stdio: ["ignore", fd, "ignore"] }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw error; }
      finally { closeSync(fd); }
      const result = readFileSync(output, "utf8").match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${width}: browser did not finish`); const value = JSON.parse(result); assert.equal(value.error, undefined, `${width}: ${value.error}`); assert.equal(value.passed, true);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
