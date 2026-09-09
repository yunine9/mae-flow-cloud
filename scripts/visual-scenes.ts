/**
 * 五档宽度静态截图:把工作台夹具任务(.ui-fixtures)用真组件 SSR 成静态页,
 * 内联构建产物 CSS,用无头 Chrome 在 1440/1200/900/600/390 五档宽度截图;
 * 再用 --compare 逐像素比对两次截图。2026-09-06 为 CSS 分层立的裁判:改叠层
 * 不能靠眼睛扫,得有"改前改后哪张图变了、变了多少像素"。
 *
 * 用法:
 *   npx tsx scripts/visual-scenes.ts --out <目录> [--themes light,dark]
 *     [--widths 1440,1200,900,600,390] [--css web/dist/assets/index-*.css]
 *   npx tsx scripts/visual-scenes.ts --compare <目录A> <目录B>
 * 先 `cd web && npm run build`,截的是构建产物里的 CSS(和线上同一份)。
 * 边界:静态标记,没有 hover/弹层/滚动状态;字体退回系统字体(file:// 下
 * 取不到 woff2)——前后一致,比对仍成立。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";
import {
  projectRepairStopped, projectStatusLabel, projectTaskFocus,
} from "../src/taskFocus.ts";

/** 浏览器可执行文件:缺省沿用 macOS 老路径;别的机器用环境变量指,
 * 如 WSL: MFC_VISUAL_BROWSER="/mnt/c/Program Files (x86)/Microsoft/
 * Edge/Application/msedge.exe"(Edge 同为 Chromium,无头参数通用)。 */
const CHROME = process.env.MFC_VISUAL_BROWSER
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** Windows 浏览器(经 WSL 互操作调用)看不见 /home 路径:场景目录必须
 * 放在 /mnt/<盘> 下,且传给浏览器的路径/URL 要转成 Windows 形式。 */
const WIN_BROWSER = /\.exe$/i.test(CHROME);

function toBrowserPath(path: string): string {
  return WIN_BROWSER
    ? execFileSync("wslpath", ["-w", path], { encoding: "utf-8" }).trim()
    : path;
}

function toBrowserFileUrl(path: string): string {
  if (!WIN_BROWSER) return `file://${path}`;
  // C:\Users\...\a.html → file:///C:/Users/.../a.html
  return `file:///${toBrowserPath(path).replace(/\\/g, "/")}`;
}

// 时间冻结:页面上的"x 分钟前"随真实时钟走,前后两次截图隔了几分钟就会
// 在几百个像素上假报差异(首轮实测 111 张"差异"全是它)。SSR 是同步的,
// 换掉全局 Date 就够;截图里看到的相对时间因此永远是同一个。
const FROZEN_NOW = Date.parse("2026-09-06T12:00:00+08:00");
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args: ConstructorParameters<typeof RealDate>) {
    super(...(args.length ? args : [FROZEN_NOW] as unknown as ConstructorParameters<typeof RealDate>));
  }
  static now(): number { return FROZEN_NOW; }
} as DateConstructor;
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

function bundledCss(): string {
  const explicit = flag("--css");
  if (explicit) return readFileSync(explicit, "utf-8");
  const dir = resolve("web/dist/assets");
  const file = readdirSync(dir).find((name) => /^index-.*\.css$/.test(name));
  if (!file) throw new Error("web/dist 里没有 index-*.css,先 cd web && npm run build");
  return readFileSync(join(dir, file), "utf-8");
}

function loadFixtures(): Array<{ id: string; summary: Record<string, unknown> }> {
  const root = resolve(".ui-fixtures");
  return readdirSync(root).filter((name) => /^task-\d+$/.test(name))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .flatMap((name) => {
      const file = join(root, name, "task.json");
      if (!existsSync(file)) return [];
      const summary = JSON.parse(readFileSync(file, "utf-8")).summary;
      // 页面只认服务端投影字段:和 project() 一样现算。
      return [{ id: name, summary: {
        ...summary,
        focus: projectTaskFocus(summary),
        status_label: projectStatusLabel(summary),
        repair_stopped: projectRepairStopped(summary),
      } }];
    });
}

function page(theme: string, body: string, css: string): string {
  return `<!doctype html><html lang="zh-CN" data-theme="${theme}" data-density="comfortable">`
    + `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<style>${css}</style>`
    // 截图裁判要的是布局与颜色,不是动画的某一帧:脉冲圆点、过渡动画在两次
    // 截图里相位不同就会假报差异(冻结时间后仍剩 110 张 ≤150px 的"差异")。
    + `<style>*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}</style>`
    + `</head><body><div id="root">${body}</div></body></html>`;
}

async function render(out: string): Promise<void> {
  const themes = (flag("--themes") ?? "light,dark").split(",");
  const widths = (flag("--widths") ?? "1440,1200,900,600,390").split(",").map(Number);
  const css = bundledCss();
  mkdirSync(out, { recursive: true });
  const vite = await createServer({
    root: "web", server: { middlewareMode: true }, appType: "custom", logLevel: "silent",
  });
  try {
    const { TaskWorkspace } = await vite.ssrLoadModule("/src/TaskWorkspace.tsx");
    const { TaskCard } = await vite.ssrLoadModule("/src/TaskCard.tsx");
    const noop = () => undefined;
    const scenes: Array<{ name: string; html: string }> = [];
    const failures: string[] = [];
    for (const fixture of loadFixtures()) {
      const task = fixture.summary;
      const variants: Array<[string, () => React.ReactElement]> = [
        ["workspace", () => React.createElement(TaskWorkspace, {
          task, viewerUsername: "dev", viewerDisplayName: "开发者",
          canOverride: false, canOperate: true, canCollaborate: true,
          canRequestReview: true, onChanged: noop, onClose: noop,
        })],
        ["card", () => React.createElement("div", { style: { maxWidth: 1100, margin: "0 auto", padding: 24 } },
          React.createElement(TaskCard, { task, onChanged: noop, focused: true }))],
        ["row", () => React.createElement("div", { style: { maxWidth: 1100, margin: "0 auto", padding: 24 } },
          React.createElement(TaskCard, { task, onChanged: noop, compact: true, onOpenArtifacts: noop }))],
      ];
      for (const [variant, make] of variants) {
        let markup: string;
        try {
          markup = renderToStaticMarkup(make());
        } catch (error) {
          failures.push(`${fixture.id}/${variant}: ${String(error).split("\n")[0]}`);
          continue;
        }
        for (const theme of themes) {
          scenes.push({ name: `${fixture.id}-${variant}-${theme}`, html: page(theme, markup, css) });
        }
      }
    }
    for (const scene of scenes) writeFileSync(join(out, `${scene.name}.html`), scene.html);
    writeFileSync(join(out, "scenes.json"), JSON.stringify({ widths, scenes: scenes.map((s) => s.name), failures }, null, 2));
    console.log(`[visual] ${scenes.length} 个场景写入 ${out}${failures.length ? `;${failures.length} 个渲染失败` : ""}`);
    for (const failure of failures) console.log(`  ! ${failure}`);
    if (args.includes("--no-shoot")) return;
    await shoot(out, scenes.map((s) => s.name), widths);
  } finally {
    await vite.close();
  }
}

async function shoot(out: string, names: string[], widths: number[]): Promise<void> {
  if (WIN_BROWSER && !out.startsWith("/mnt/")) {
    throw new Error(`Windows 浏览器看不见 Linux 路径:${out}。`
      + "请把 --out 放到 /mnt/<盘> 下(如 /mnt/c/Users/<你>/AppData/Local/Temp/mfc-visual)");
  }
  const jobs = names.flatMap((name) => widths.map((width) => ({ name, width })));
  let next = 0; let done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const png = join(out, `${job.name}@${job.width}.png`);
      await new Promise<void>((resolveJob) => {
        const child = spawn(CHROME, [
          "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
          "--force-device-scale-factor=1", `--window-size=${job.width},1800`,
          "--virtual-time-budget=1500", `--screenshot=${toBrowserPath(png)}`,
          toBrowserFileUrl(join(out, `${job.name}.html`)),
        ], { stdio: "ignore" });
        child.on("exit", () => resolveJob());
        child.on("error", () => resolveJob());
      });
      done += 1;
      if (done % 50 === 0) console.log(`[visual] 已截 ${done}/${jobs.length}`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log(`[visual] 截图完成:${jobs.length} 张`);
}

/** 最小 PNG 解码:只认 Chromium 系截图的产出形态(8-bit RGB/RGBA,
 * 非隔行)。逐像素比对要同尺寸同布局的字节阵;原先转 BMP 用的是
 * macOS 独有的 sips,WSL/Linux 上没有——zlib 是 node 内置,直接解。 */
function decodePng(file: string): { width: number; height: number; bpp: number; bytes: Buffer } {
  const data = readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!data.subarray(0, 8).equals(signature)) throw new Error(`不是 PNG: ${file}`);
  let at = 8;
  let width = 0; let height = 0; let bitDepth = 0; let colorType = 0; let interlace = 0;
  const idat: Buffer[] = [];
  while (at + 8 <= data.length) {
    const length = data.readUInt32BE(at);
    const type = data.toString("ascii", at + 4, at + 8);
    const body = data.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      bitDepth = body[8]; colorType = body[9]; interlace = body[12];
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`不支持的 PNG 形态(位深 ${bitDepth}, 隔行 ${interlace}): ${file}`);
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}(只认 RGB/RGBA): ${file}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const bytes = Buffer.alloc(height * stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor++];
    const line = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const out = bytes.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = y > 0 ? bytes[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? bytes[(y - 1) * stride + x - channels] : 0;
      const value = line[x];
      out[x] = filter === 0 ? value
        : filter === 1 ? (value + left) & 0xff
        : filter === 2 ? (value + up) & 0xff
        : filter === 3 ? (value + ((left + up) >> 1)) & 0xff
        : (() => {
          const estimate = left + up - upLeft;
          const pa = Math.abs(estimate - left);
          const pb = Math.abs(estimate - up);
          const pc = Math.abs(estimate - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          return (value + predictor) & 0xff;
        })();
    }
  }
  return { width, height, bpp: channels, bytes };
}

function pixels(png: string): { width: number; height: number; bytes: Buffer; bpp: number } {
  return decodePng(png);
}

function compare(a: string, b: string): void {
  const names = readdirSync(a).filter((name) => name.endsWith(".png")).sort();
  const rows: Array<[string, number, string]> = [];
  for (const name of names) {
    const other = join(b, name);
    if (!existsSync(other)) { rows.push([name, -1, "B 里没有"]); continue; }
    const pa = pixels(join(a, name)); const pb = pixels(other);
    if (pa.width !== pb.width || pa.height !== pb.height || pa.bpp !== pb.bpp) {
      rows.push([name, -1, `尺寸不同 ${pa.width}x${pa.height} vs ${pb.width}x${pb.height}`]); continue;
    }
    let diff = 0;
    const stride = pa.bpp;
    for (let i = 0; i + stride <= pa.bytes.length; i += stride) {
      for (let k = 0; k < stride; k += 1) {
        if (pa.bytes[i + k] !== pb.bytes[i + k]) { diff += 1; break; }
      }
    }
    rows.push([name, diff, diff ? `${(diff * 100 / (pa.width * pa.height)).toFixed(3)}%` : "一致"]);
  }
  const changed = rows.filter(([, diff]) => diff !== 0);
  console.log(`[visual] 比对 ${rows.length} 张:${rows.length - changed.length} 张一致,${changed.length} 张有差异`);
  for (const [name, diff, note] of changed.sort((x, y) => y[1] - x[1])) {
    console.log(`  ${String(diff).padStart(8)} px  ${note.padStart(8)}  ${name}`);
  }
  process.exitCode = changed.length ? 1 : 0;
}

const compareA = flag("--compare");
if (compareA) {
  const compareB = args[args.indexOf("--compare") + 2];
  if (!compareB) throw new Error("--compare 需要两个目录");
  compare(resolve(compareA), resolve(compareB));
} else {
  const out = flag("--out");
  if (!out) throw new Error("需要 --out <目录>");
  await render(resolve(out));
}
