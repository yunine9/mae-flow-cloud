import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("知识问答桌面：资料上传与草稿恢复、账号隔离、后台继续、引用快照、停止重问及反馈", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "knowledge-answer-browser-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/knowledgeAnswers.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets");
    const css = readdirSync(assets).filter(file => file.endsWith(".css")).map(file => readFileSync(join(assets, file), "utf8")).join("\n");
    const html = join(directory, "check.html");
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>${css}\n${readFileSync(resolve("web/src/KnowledgeAnswers.css"), "utf8")}\n#result{display:none}</style><aside style="position:fixed;width:180px;padding:24px">MAEFlow Cloud<br><br><strong>知识库</strong></aside><div style="margin-left:180px"><div id="app"></div></div><pre id="result"></pre><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`);
    for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const output = join(directory, `${width}.html`);
      const result = await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(directory, `profile-${width}`)}`, `--window-size=${width},${height}`, "--virtual-time-budget=25000", "--dump-dom", ...(process.env.MFC_KNOWLEDGE_ANSWER_SCREENSHOT_DIR ? [`--screenshot=${join(process.env.MFC_KNOWLEDGE_ANSWER_SCREENSHOT_DIR, `knowledge-answer-${width}.png`)}`] : []), `file://${html}?kbPage=ask${process.env.MFC_KNOWLEDGE_ANSWER_PREVIEW === "materials" ? "&preview=materials" : ""}`], output);
      const content = result.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(content, `${width}: browser did not finish`);
      const value = JSON.parse(content); assert.equal(value.error, undefined, `${width}: ${value.error}`); assert.equal(value.passed, true);
    }
  } finally { stop(); rmSync(directory, { recursive: true, force: true }); }
});
