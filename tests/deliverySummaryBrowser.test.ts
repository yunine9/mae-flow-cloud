import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";

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
      const fd = openSync(dump, "w");
      try {
        execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-first-run",
          "--disable-extensions", `--user-data-dir=${join(dir, mode)}`,
          "--window-size=1920,1080", "--virtual-time-budget=6000", "--dump-dom",
          `file://${html}${mode === "link" ? "?deliverySummary=1" : ""}`], { timeout: 20000, stdio: ["ignore", fd, "ignore"] });
      } catch (error) {
        // macOS Chrome 有时已输出结果但清理未退出；下面必须拿到完整断言结果。
        if ((error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw error;
      } finally { closeSync(fd); }
      const result = readFileSync(dump, "utf8").match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${mode}: browser did not finish`);
      const value = JSON.parse(result);
      assert.equal(value.error, undefined, `${mode}: ${value.error}`);
      assert.equal(value.passed, true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
