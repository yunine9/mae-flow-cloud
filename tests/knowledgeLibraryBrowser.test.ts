import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("知识库桌面交互：独立页签、人工编辑保护、建议采纳和统一平台 Skill 上传和在线查看", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-library-browser-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/knowledgeLibrary.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(f => f.endsWith(".css")).map(f => readFileSync(join(assets, f), "utf8")).join("\n");
    const html = join(root, "check.html");
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>${css} #result { display: none; }</style><aside style="position:fixed;width:180px;padding:24px">MAEFlow Cloud<br><br><strong>知识库</strong><br><br>团队资产</aside><div style="margin-left:180px;padding:24px"><h1 style="font-size:28px;margin-bottom:20px">知识库</h1><div id="app"></div></div><pre id="result"></pre><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`);
    for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const output = join(root, `${width}.html`), fd = openSync(output, "w");
      try { execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(root, String(width))}`, `--window-size=${width},${height}`, "--virtual-time-budget=15000", "--dump-dom", ...(process.env.MFC_RESEARCH_SCREENSHOT_DIR ? [`--screenshot=${join(process.env.MFC_RESEARCH_SCREENSHOT_DIR, `knowledge-library-${width}.png`)}`] : []), `file://${html}?knowledgePage=domain&domainExtraction=dkx-browser`], { timeout: 25000, stdio: ["ignore", fd, "ignore"] }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw error; }
      finally { closeSync(fd); }
      const result = readFileSync(output, "utf8").match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${width}: browser did not finish`); const value = JSON.parse(result); assert.equal(value.error, undefined, `${width}: ${value.error}`); assert.equal(value.passed, true);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
