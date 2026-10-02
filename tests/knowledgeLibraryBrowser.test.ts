import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("知识库桌面集成：模块深链接、任务进度、变化文稿批量发布、研究归属和 Skill 整包导入", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-library-browser-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/knowledgeLibrary.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(f => f.endsWith(".css")).map(f => readFileSync(join(assets, f), "utf8")).join("\n");
    const html = join(root, "check.html");
    const moduleCss = ["knowledge-library.css", "knowledge-modules.css", "knowledgeTaskCenter.css"].map(file => readFileSync(resolve("web/src", file), "utf8")).join("\n");
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>${css}\n${moduleCss} #result { display: none; }</style><aside style="position:fixed;width:180px;padding:24px">MAEFlow Cloud<br><br><strong>知识库</strong></aside><div style="margin-left:180px"><div id="app"></div></div><pre id="result"></pre><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`);
    for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const output = join(root, `${width}.html`), fd = openSync(output, "w");
      try { execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(root, String(width))}`, `--window-size=${width},${height}`, "--virtual-time-budget=15000", "--dump-dom", ...(process.env.MFC_RESEARCH_SCREENSHOT_DIR ? [`--screenshot=${join(process.env.MFC_RESEARCH_SCREENSHOT_DIR, `knowledge-library-${width}.png`)}`] : []), `file://${html}?kbPage=module&kbModule=business%3Atrade&knowledgeDocument=kd-current`], { timeout: 25000, stdio: ["ignore", fd, "ignore"] }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw error; }
      finally { closeSync(fd); }
      const result = readFileSync(output, "utf8").match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${width}: browser did not finish`); const value = JSON.parse(result); assert.equal(value.error, undefined, `${width}: ${value.error}`); assert.equal(value.passed, true);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
