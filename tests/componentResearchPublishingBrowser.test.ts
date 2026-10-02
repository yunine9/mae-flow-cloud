import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("组件任务：过程与文稿保留阅读位置，候选预检后一键确认并发布和归档", { skip: !existsSync(chrome) && "需要 Chrome" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "component-publishing-"));
  try {
    const built = await build({ entryPoints: [resolve("tests/browser/componentResearchPublishing.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(file => file.endsWith(".css")).map(file => readFileSync(join(assets, file), "utf8")).join("\n");
    const html = join(dir, "check.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="app"></div><pre id="result" style="display:none"></pre><script>' + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const dump = join(dir, `${width}.html`), fd = openSync(dump, "w");
      try {
        execFileSync(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", `--user-data-dir=${join(dir, `profile-${width}`)}`, `--window-size=${width},${height}`, "--virtual-time-budget=12000", "--dump-dom", `file://${html}`], { timeout: 25000, stdio: ["ignore", fd, "ignore"] });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw error; }
      finally { closeSync(fd); }
      const dom = readFileSync(dump, "utf8");
      const result = dom.match(/<pre[^>]*id="result"[^>]*>([^<]+)<\/pre>/)?.[1];
      assert.ok(result, `${width}: browser did not finish`);
      const value = JSON.parse(result); assert.equal(value.error, undefined, `${width}: ${value.error}`); assert.equal(value.passed, true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
