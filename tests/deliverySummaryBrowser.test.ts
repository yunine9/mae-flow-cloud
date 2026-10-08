import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";

const chrome = process.env.MFC_TEST_CHROME
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("交付摘要完成提醒不抢焦点，小鲁班链接直接打开含图文档", {
  skip: !existsSync(chrome) && "需要真实 Chrome；设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-delivery-summary-"));
  try {
    const built = await build({
      entryPoints: [resolve("tests/browser/deliverySummary.tsx")],
      bundle: true, write: false, format: "iife", jsx: "automatic",
      loader: { ".css": "empty" },
      jsxImportSource: resolve("web/node_modules/react"),
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const html = join(dir, "check.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><div id="app"></div><pre id="result"></pre><script>'
      + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    for (const mode of ["notice", "link"]) {
      const dump = join(dir, `${mode}.html`);
      
      await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run",
          "--disable-extensions", `--user-data-dir=${join(dir, mode)}`,
          "--window-size=1920,1080", "--virtual-time-budget=6000", "--dump-dom",
          `file://${html}${mode === "link" ? "?deliverySummary=1" : ""}`], dump);
      const result = readFileSync(dump, "utf8").match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${mode}: browser did not finish`);
      const value = JSON.parse(result);
      assert.equal(value.error, undefined, `${mode}: ${value.error}`);
      assert.equal(value.passed, true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
