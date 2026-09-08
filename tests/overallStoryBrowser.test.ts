import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";

const chrome = process.env.MFC_TEST_CHROME
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("整体 Story 浏览器：生成、阅读、版本对比、确认和待同步提示", {
  skip: !existsSync(chrome) && "需要真实 Chrome；设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-overall-browser-"));
  try {
    const built = await build({
      entryPoints: [resolve("tests/browser/overallStory.tsx")],
      bundle: true, write: false, format: "iife", jsx: "automatic",
      loader: { ".css": "empty" },
      jsxImportSource: resolve("web/node_modules/react"),
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const html = join(dir, "check.html");
    const { readdirSync } = await import("node:fs");
    const css = readdirSync("web/dist/assets").filter((p) => p.endsWith(".css")).map((p) => readFileSync(join("web/dist/assets", p), "utf8")).join("\n");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="app"></div><pre id="result"></pre><script>'
      + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    for (const mode of ["doc"]) {
      const dump = join(dir, `${mode}.html`);
      const fd = openSync(dump, "w");
      try {
        execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-first-run",
          "--disable-extensions", `--user-data-dir=${join(dir, mode)}`,
          "--window-size=1920,1080", "--screenshot=/tmp/overall-story-workbench.png", "--virtual-time-budget=16000", "--dump-dom",
          `file://${html}?mode=${mode}`], { timeout: 20000, stdio: ["ignore", fd, "ignore"] });
      } catch (error) {
        // macOS Chrome 有时已输出结果但清理未退出；下面必须拿到完整断言结果。
        if ((error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw error;
      } finally { closeSync(fd); }
      const result = readFileSync(dump, "utf8").match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${mode}: browser did not finish`);
      const value = JSON.parse(result);
      assert.equal(value.error, undefined, `${mode}: ${value.error}`);
      assert.equal(value.childEntryHidden, true);
      assert.equal(value.readerStable, true);
      assert.equal(value.stale, true);
      assert.equal(value.confirmed, true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
