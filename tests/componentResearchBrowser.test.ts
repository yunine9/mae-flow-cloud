import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
test("桌面审核：默认全选、单项排除、专家对话和局部返工、单篇完整预览", {
  skip: !existsSync(chrome) && "需要真实 Chrome；设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(),"mfc-component-review-"));
  try {
    const built = await build({entryPoints:[resolve("tests/browser/componentResearchReview.tsx")],bundle:true,write:false,
      format:"iife",jsx:"automatic",loader:{".css":"empty"},jsxImportSource:resolve("web/node_modules/react"),
      define:{"process.env.NODE_ENV":'"production"'}});
    const assets = resolve("web/dist/assets");
    assert.ok(existsSync(assets),"请先构建 web，以真实桌面样式验证布局");
    const css = readdirSync(assets).filter(name => name.endsWith(".css")).map(name => readFileSync(join(assets,name),"utf8")).join("\n");
    const html = join(dir,"check.html");
    writeFileSync(html,'<!doctype html><meta charset="utf-8"><style>'+css+'</style><div id="app" style="padding:24px"></div><pre id="result"></pre><script>'
      +built.outputFiles[0].text.replaceAll("</script","<\\/script")+"</script>");
    for (const [width,height] of [[1920,1080],[1366,768]]) {
      const dump = join(dir,`${width}.html`), fd = openSync(dump,"w");
      try {
        execFileSync(chrome,["--headless=new","--disable-gpu","--no-first-run","--disable-extensions",`--user-data-dir=${join(dir,String(width))}`,
          `--window-size=${width},${height}`,"--virtual-time-budget=7000","--dump-dom",
          ...(process.env.MFC_RESEARCH_SCREENSHOT_DIR ? [`--screenshot=${join(process.env.MFC_RESEARCH_SCREENSHOT_DIR,`research-${width}.png`)}`] : []),
          `file://${html}?componentResearch=cr-browser`],{timeout:25000,stdio:["ignore",fd,"ignore"]});
      } catch (error) {if ((error as NodeJS.ErrnoException).code !== "ETIMEDOUT") throw error;}
      finally {closeSync(fd);}
      const result = readFileSync(dump,"utf8").match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
      assert.ok(result,`${width}: browser did not finish`);
      const value = JSON.parse(result);assert.equal(value.error,undefined,`${width}: ${value.error}`);assert.equal(value.passed,true);
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
