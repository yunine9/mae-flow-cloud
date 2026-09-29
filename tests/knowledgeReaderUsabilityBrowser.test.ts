import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const pause = (ms = 120) => new Promise(r => setTimeout(r, ms));
async function until(check: () => Promise<boolean> | boolean) { for (let i = 0; i < 100; i++) { if (await check()) return; await pause(50); } throw new Error("浏览器未就绪"); }

test("知识阅读可用性：全屏、目录、长文、跨文件链接、失败重试与桌面窄面板", { skip: !existsSync(chrome), timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-reader-usability-"));
  const child = spawn(chrome, ["--headless=new", "--window-size=1920,1080", "--disable-gpu", "--no-first-run", "--disable-extensions", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${join(root, "profile")}`], { stdio: "ignore" });
  let socket: WebSocket | undefined, nextId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: any) => void; timer: ReturnType<typeof setTimeout> }>();
  try {
    await until(() => existsSync(join(root, "profile", "DevToolsActivePort")));
    const [port, endpoint] = readFileSync(join(root, "profile", "DevToolsActivePort"), "utf8").trim().split("\n");
    socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject; });
    socket.onmessage = message => { const data = JSON.parse(String(message.data)), entry = pending.get(data.id); if (entry) { clearTimeout(entry.timer); pending.delete(data.id); data.error ? entry.reject(data.error) : entry.resolve(data.result); } };
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
      const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const bundle = await build({ entryPoints: [resolve("tests/browser/knowledgeReaderUsability.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(f => f.endsWith(".css")).map(f => readFileSync(join(assets, f), "utf8")).join("\n");
    const html = join(root, "check.html");
    writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>${css} #result {display:none}</style><div id="app"></div><pre id="result"></pre><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`);
    for (const [width, height] of [[1920, 1080], [1366, 768]]) {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const evaluate = async (expression: string) => { const result = await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
      await send("Page.navigate", { url: String(pathToFileURL(html)) }, sessionId);
      let result = "";
      for (let i = 0; i < 150; i++) { result = await evaluate("document.getElementById('result')?.textContent || ''"); if (result) break; await pause(100); }
      if (process.env.MFC_RESEARCH_SCREENSHOT_DIR) {
        const screenshot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
        writeFileSync(join(process.env.MFC_RESEARCH_SCREENSHOT_DIR, `knowledge-reader-${width}.png`), Buffer.from(screenshot.data, "base64"));
      }
      assert.ok(result, `${width}: browser did not finish`);
      const value = JSON.parse(result); assert.equal(value.error, undefined, `${width}: ${value.error}`); assert.equal(value.passed, true);
      await send("Target.closeTarget", { targetId });
    }
  } finally {
    socket?.close(); for (const entry of pending.values()) clearTimeout(entry.timer);
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "exit"); child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000); await closed; clearTimeout(timer);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
