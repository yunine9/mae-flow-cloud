/**
 * 【原型·随时可扔】按特性分类原型三变体的静态截图场景:把
 * .prototype-issue-fixtures 的种子会话喂给 TeamIssueWorld,按
 * window.location.search 桩分别渲染 默认/A/B/C 四个场景成静态页,
 * 内联构建产物 CSS,无头 Edge/Chrome 在 1920 宽截图。
 *
 * 用法(截图输出必须在 /mnt/<盘> 下——Windows 浏览器看不见 Linux 路径):
 *   npx tsx scripts/prototype-issue-overview-scenes.ts \
 *     --out /mnt/c/Users/ning/AppData/Local/Temp/proto-issue-visual
 * 机制与 scripts/visual-scenes.ts 同源,只为原型验收临时服务。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";

/** 浏览器可执行文件(与 visual-scenes 同款约定)。 */
const CHROME = process.env.MFC_VISUAL_BROWSER
  ?? "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const WIN_BROWSER = /\.exe$/i.test(CHROME);

function toBrowserPath(path: string): string {
  return WIN_BROWSER
    ? execFileSync("wslpath", ["-w", path], { encoding: "utf-8" }).trim()
    : path;
}

function toBrowserFileUrl(path: string): string {
  if (!WIN_BROWSER) return `file://${path}`;
  return `file:///${toBrowserPath(path).replace(/\\/g, "/")}`;
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const out = flag("--out");
if (!out) throw new Error("缺 --out <目录>(Windows 浏览器需在 /mnt/<盘> 下)");

function bundledCss(): string {
  const dir = resolve("web/dist/assets");
  const file = readdirSync(dir).find((name) => /^index-.*\.css$/.test(name));
  if (!file) throw new Error("web/dist 里没有 index-*.css,先 cd web && npm run build");
  return readFileSync(join(dir, file), "utf-8");
}

/** 种子会话(与列表接口同投影:直接读 issue.json)。 */
function loadSeedIssues(): Array<Record<string, unknown>> {
  const root = resolve(".prototype-issue-fixtures/issues");
  if (!existsSync(root)) {
    throw new Error("先运行 npx tsx scripts/prototype-issue-overview-fixtures.ts");
  }
  return readdirSync(root).filter((name) => name.startsWith("issue-"))
    .sort().map((name) =>
      JSON.parse(readFileSync(join(root, name, "issue.json"), "utf-8")) as Record<string, unknown>);
}

function page(body: string, css: string): string {
  return `<!doctype html><html lang="zh-CN" data-theme="light" data-density="comfortable">`
    + `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<style>${css}</style>`
    + `<style>*,*::before,*::after{animation:none!important;transition:none!important}</style>`
    + `</head><body><div id="root"><div style="padding:24px 28px">${body}</div></div></body></html>`;
}

/** SSR 桩:原型变体从 window.location.search 读,SSR 里手动指认。 */
function stubWindow(search: string): void {
  const listeners: unknown[] = [];
  (globalThis as Record<string, unknown>).window = {
    location: { search, href: `http://localhost:5180/${search}` },
    addEventListener: () => listeners.push(1),
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    history: { replaceState: () => undefined },
  };
}

async function main(): Promise<void> {
  const css = bundledCss();
  const issues = loadSeedIssues();
  const onceRates = {
    total: 5,
    localization: { passed: 4, rate: 80 },
    repair: { passed: 5, rate: 100 },
    per_session: [],
  };
  mkdirSync(out!, { recursive: true });
  const vite = await createServer({
    root: "web", server: { middlewareMode: true }, appType: "custom", logLevel: "silent",
  });
  const scenes: Array<{ name: string; html: string }> = [];
  try {
    const { TeamIssueWorld } = await vite.ssrLoadModule("/src/TeamIssueWorld.tsx");
    const {
      PrototypeVariantCells, PrototypeVariantDrilldown, PrototypeVariantLedger,
    } = await vite.ssrLoadModule("/src/TeamIssueWorld.prototype.tsx");
    const { issueDeliveryBreakdown } = await vite.ssrLoadModule("/src/teamOps.ts");
    const noop = () => undefined;
    const focusFeature = "无线特性-漫游切换";
    const stats = issueDeliveryBreakdown(issues);
    for (const variant of ["default", "A", "B", "C"]) {
      stubWindow(variant === "default" ? "" : `?variant=${variant}`);
      const markup = renderToStaticMarkup(React.createElement(TeamIssueWorld, {
        issues, onceRates,
      }));
      scenes.push({
        name: `overview-${variant}`,
        html: page(markup, css),
      });
    }
    // 交互态补充:变体 A 选中特性格、变体 C 钻取到某特性(SSR 点不了,
    // 直接按受控 props 渲染)。
    stubWindow("?variant=A");
    scenes.push({ name: "overview-A-selected", html: page(renderToStaticMarkup(
      React.createElement(PrototypeVariantCells, {
        issues, onceRates, stats, cell: `f:${focusFeature}`,
        onSelectCell: noop,
      })), css) });
    stubWindow("?variant=C");
    scenes.push({ name: "overview-C-drilled", html: page(renderToStaticMarkup(
      React.createElement(PrototypeVariantDrilldown, {
        issues, onceRates, feature: focusFeature, onSelectFeature: noop,
        cell: "", onSelectCell: noop,
      })), css) });
    // 变体 D:默认收起(只有总账行)与展开(全部特性行)两态。
    stubWindow("?variant=D");
    scenes.push({ name: "overview-D", html: page(renderToStaticMarkup(
      React.createElement(PrototypeVariantLedger, {
        issues, onceRates, stats, cell: "", onSelectCell: noop,
      })), css) });
    scenes.push({ name: "overview-D-expanded", html: page(renderToStaticMarkup(
      React.createElement(PrototypeVariantLedger, {
        issues, onceRates, stats, cell: "", onSelectCell: noop,
        initialExpanded: true,
      })), css) });
  } finally {
    await vite.close();
  }
  for (const scene of scenes) writeFileSync(join(out!, `${scene.name}.html`), scene.html);
  console.log(`[prototype-scenes] ${scenes.length} 个场景写入 ${out}`);
  const names = scenes.map((s) => s.name);
  const png = (name: string) => join(out!, `${name}@1920.png`);
  await Promise.all(names.map((name) => new Promise<void>((done) => {
    const child = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
      "--force-device-scale-factor=1", "--window-size=1920,1500",
      "--virtual-time-budget=1500", `--screenshot=${toBrowserPath(png(name))}`,
      toBrowserFileUrl(join(out!, `${name}.html`)),
    ], { stdio: "ignore" });
    child.on("exit", () => done());
    child.on("error", () => done());
  })));
  console.log(`[prototype-scenes] 截图完成:${names.map((n) => png(n)).join(", ")}`);
}

await main();
