import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";
test("说给 Agent 上传、重试、发送和历史下载，1920×1080 桌面布局", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-attachment-browser-"));
  try {
    const bundle = await build({ entryPoints: [resolve("tests/browser/taskAttachments.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic",
      loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets");
    const css = readdirSync(assets).filter(name => name.startsWith("index-") && name.endsWith(".css")).map(name => readFileSync(join(assets, name), "utf8")).join("\n");
    const html = "/tmp/mfc-task-attachments-preview.html";
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + ' #result{display:none}</style><div class="tw-root" id="app"></div><pre id="result"></pre><script>' + bundle.outputFiles[0].text.replaceAll("</script", "<\\/script") + '</script>');
    const dom = await browserResultDump(process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${dir}/profile`, "--window-size=1920,1080", "--virtual-time-budget=10000", "--screenshot=/tmp/mfc-task-attachments-1920.png", "--dump-dom", `file://${html}`], join(dir, "result.html"));
    const result = JSON.parse(dom.match(/<pre id="result">([^<]+)<\/pre>/)?.[1] ?? '{}');
    assert.equal(result.error, undefined, result.error);
    assert.equal(result.passed, true);
  } finally { stop(); rmSync(dir, { recursive: true, force: true }); }
});
