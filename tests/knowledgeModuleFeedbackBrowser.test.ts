import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("知识整体意见：保存与处理、文档及 Skill 文件隔离、一键交给 Agent 修改", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-module-feedback-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/knowledgeModuleFeedback.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(file => file.endsWith(".css")).map(file => readFileSync(join(assets, file), "utf8")).join("\n");
    const html = join(dir, "check.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="app"></div><pre id="result" style="display:none"></pre><script>' + bundle.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const output = join(dir, `${width}.html`), fd = openSync(output, "w");
      try { execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, `profile-${width}`)}`, `--window-size=${width},${height}`, "--virtual-time-budget=15000", "--dump-dom", `file://${html}`], { timeout: 25000, stdio: ["ignore", fd, "ignore"] }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw error; }
      finally { closeSync(fd); }
      const result = readFileSync(output, "utf8").match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${width}: browser did not finish`); const value = JSON.parse(result); assert.equal(value.error, undefined, `${width}: ${value.error}`); assert.equal(value.passed, true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
