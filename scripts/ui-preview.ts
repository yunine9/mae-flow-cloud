/**
 * 临时脚本:把 ui primitives(组件统一化波次 0)渲染成展示页并截图,
 * 给"现在啥样"一个直观答案。用法:
 *   MFC_VISUAL_BROWSER=<浏览器> npx tsx scripts/ui-preview.ts <输出目录>
 * 截 light/dark 两张;样式取 web/dist 构建产物(先 cd web && npm run build)。
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { ModalSurface } from "../web/src/ui/Modal.tsx";

const CHROME = process.env.MFC_VISUAL_BROWSER
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIN_BROWSER = /\.exe$/i.test(CHROME);
const toBrowserPath = (path: string): string => WIN_BROWSER
  ? execFileSync("wslpath", ["-w", path], { encoding: "utf-8" }).trim() : path;
const toBrowserFileUrl = (path: string): string => WIN_BROWSER
  ? `file:///${toBrowserPath(path).replace(/\\/g, "/")}` : `file://${path}`;

(globalThis as typeof globalThis & { React: typeof React }).React = React;
const h = React.createElement;

const out = resolve(process.argv[2] ?? ".ui-preview");
mkdirSync(out, { recursive: true });
const assets = resolve("web/dist/assets");
const css = readFileSync(join(assets,
  readdirSync(assets).find((name) => /^index-.*\.css$/.test(name))!), "utf-8");

const field = (label: string, control: React.ReactNode, opts: {
  note?: string; span2?: boolean;
} = {}) => h("label", { className: `ui-field${opts.span2 ? " span-2" : ""}` },
  h("span", null, label), control,
  opts.note ? h("small", { className: "knob-note" }, opts.note) : null);

const modalForm = h("form", null,
  h("header", { className: "ui-modal-head" },
    h("div", null,
      h("small", null, "快速反馈"),
      h("h2", { id: "wish-quick-title" }, "快速提个问题")),
    h("button", { className: "ui-btn ghost sm", type: "button" }, "×")),
  field("一句话说明问题",
    h("input", { placeholder: "哪里不好用，或者哪里不符合预期？" })),
  field("补充现场（可选）",
    h("textarea", { rows: 3, placeholder: "刚才做了什么、希望变成什么样" })),
  h("footer", { className: "ui-modal-foot" },
    h("button", { className: "ui-btn", type: "button" }, "查看许愿墙"),
    h("button", { className: "ui-btn primary", type: "button" }, "提交问题")));

const board = h("div",
  { style: { display: "grid", gap: 28, padding: "36px 32px", maxWidth: 860, margin: "0 auto" } },
  h("section", { className: "ui-card", style: { padding: 24 } },
    h("span", { className: "section-kicker" }, "RUNTIME"),
    h("h2", { style: { margin: "6px 0 4px" } }, "运行参数"),
    h("p", { style: { margin: "0 0 16px", color: "var(--muted)", fontSize: "var(--fs-13)" } },
      "SettingsView 迁移后的表单样子:字段走 .ui-field,按钮走 .ui-btn。"),
    h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 15 } },
      field("并发任务数", h("input", { placeholder: "使用默认值：3 个" }),
        { note: "生效于下一次调度决策" }),
      field("流水线检查间隔（秒）", h("input", { placeholder: "使用默认值：30 秒" }),
        { note: "生效于下一轮检查" }),
      field("团队执行约定",
        h("textarea", { rows: 3, placeholder: "例如：涉及存量接口时先核对兼容性…" }),
        { note: "留空表示不设置团队补充", span2: true })),
    h("div", { style: { display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" } },
      h("button", { className: "ui-btn primary" }, "保存运行参数"),
      h("button", { className: "ui-btn" }, "测试连通"),
      h("button", { className: "ui-btn", disabled: true }, "清理未使用缓存"),
      h("button", { className: "ui-btn danger" }, "危险动作"),
      h("button", { className: "ui-btn ghost sm" }, "幽灵·小号")),
    h("div", { style: { display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" } },
      h("span", { className: "ui-badge" }, "未配置"),
      h("span", { className: "ui-badge active" }, "进行中"),
      h("span", { className: "ui-badge success" }, "已跑绿"),
      h("span", { className: "ui-badge danger" }, "红灯"),
      h("span", { className: "ui-badge attention" }, "待完善"),
      h("span", { className: "ui-badge merge" }, "已合入")),
    h("div", { className: "ui-empty", style: { marginTop: 18, border: "1px dashed var(--line)", borderRadius: "var(--radius)" } },
      h("strong", null, "还没有任何记录"),
      h("span", null, "空态基座:.ui-empty(图标槽 + 文案)"))),
  h("section", { style: { position: "relative", height: 430, transform: "translateZ(0)" } },
    h("div", { style: { position: "absolute", inset: 0, display: "grid", placeItems: "center" } },
      h(ModalSurface, { open: true, onClose: () => undefined, labelledBy: "wish-quick-title" },
        modalForm)),
    h("p", { style: { position: "absolute", bottom: 0, left: 0, right: 0,
      textAlign: "center", color: "var(--faint)", fontSize: "var(--fs-12)", margin: 0 } },
      "↑ WishQuickCreate 迁移后的打开态:<Modal> 组件 + .ui-field/.ui-btn")));

function page(theme: string, body: string): string {
  return `<!doctype html><html lang="zh-CN" data-theme="${theme}" data-density="comfortable">`
    + `<head><meta charset="utf-8"><style>${css}</style>`
    + `<style>*,*::before,*::after{animation:none!important;transition:none!important}</style>`
    + `</head><body style="background:var(--canvas)"><div id="root">${body}</div></body></html>`;
}

for (const theme of ["light", "dark"]) {
  const htmlFile = join(out, `preview-${theme}.html`);
  writeFileSync(htmlFile, page(theme, renderToStaticMarkup(board)));
  const png = join(out, `preview-${theme}.png`);
  execFileSync("wslpath", ["-w", png]); // 预热 wslpath,报错提前
  await new Promise<void>((done) => {
    const child = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
      "--force-device-scale-factor=1", "--window-size=960,1150",
      "--virtual-time-budget=1200", `--screenshot=${toBrowserPath(png)}`,
      toBrowserFileUrl(htmlFile),
    ], { stdio: "ignore" });
    child.on("exit", () => done());
    child.on("error", () => done());
  });
  console.log(`[ui-preview] ${png}`);
}
