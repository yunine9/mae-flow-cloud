import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("组件知识工作台桌面操作：启用、限定路径、样本反馈、反例研究、源文档、停用", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-component-consume-browser-"));
  try {
    const built = await build({ entryPoints: [resolve("tests/browser/componentKnowledgeGovernance.tsx")], bundle: true, write: false,
      format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(n => n.endsWith(".css")).map(n => readFileSync(join(assets, n), "utf8")).join("\n");
    const html = join(dir, "check.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="app" style="padding:32px;max-width:1500px;margin:auto"></div><pre id="result"></pre><script>' + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const dump = join(dir, `${width}.html`), fd = openSync(dump, "w");
      try { execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, String(width))}`,
        `--window-size=${width},${height}`, "--virtual-time-budget=2500", "--dump-dom",
        ...(process.env.MFC_GOVERNANCE_SCREENSHOTS ? [`--screenshot=${join(process.env.MFC_GOVERNANCE_SCREENSHOTS, `governance-${width}.png`)}`] : []),
        `file://${html}?knowledgePage=component`], { timeout: 15000, stdio: ["ignore", fd, "ignore"] }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw e; } finally { closeSync(fd); }
      const result = readFileSync(dump, "utf8").match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${width}: 页面未完成`); const value = JSON.parse(result); assert.equal(value.error, undefined, `${width}: ${value.error}`); assert.equal(value.passed, true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
