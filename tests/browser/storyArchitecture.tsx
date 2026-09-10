import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { StoryArchitecture } from "../../web/src/StoryArchitecture";
import { storyViewCoverage } from "../../src/storyViewCoverage";

declare const PLANTUML_SVG: string;
declare const ARCHIFY_HTML_ONE: string;
declare const ARCHIFY_HTML_TWO: string;
let revision = "one", mode = "ready", opened = false, requests = 0;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
window.fetch = async (input) => {
  const url = String(input);
  if (url.includes("?revision=")) {
    requests++;
    if (mode === "render-error") return new Response(JSON.stringify({ error: "layout validation failed: label overlaps module" }), { status: 422 });
    if (url.includes("diagram-2?")) return new Response(JSON.stringify({ revision, svg: PLANTUML_SVG, syntax_error: mode === "syntax-error" }));
    const old = url.endsWith("one");
    // 故意模拟无法及时取消的旧请求；回包顺序与发起顺序相反。
    if (old) await pause(600);
    return new Response(JSON.stringify({ revision: old ? "one" : "two", html: old ? ARCHIFY_HTML_ONE : ARCHIFY_HTML_TWO }));
  }
  if (mode === "error") return new Response(JSON.stringify({ error: "Story 读取失败" }), { status: 500 });
  return new Response(JSON.stringify({ revision, renderer: "10722002", warnings: [],
    views: storyViewCoverage("| 物理视图 | 不涉及 | 沿用现有部署，本次无部署变更 |\n## 逻辑视图\n```plantuml\nclass Order\n```"),
    diagrams: mode === "empty" ? [] : [{ id: "diagram-1", title: `版本 ${revision}`, type: "architecture", line: 7 }, { id: "diagram-2", title: "订单类关系", type: "plantuml", renderer: "plantuml", line: 3 }] }));
};
function Harness() {
  const [line, setLine] = React.useState<number>();
  return <><button id="jump-class" onClick={() => setLine(3)}>Story 类图跳转</button>
    <StoryArchitecture taskId="task" requestedLine={line} onOpenStory={() => { opened = true; }} /></>;
}
createRoot(document.getElementById("app")!).render(<Harness />);
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 80; i++) { if (check()) return; await pause(20); }
  throw Error(label);
}
function refresh() { document.querySelector<HTMLButtonElement>('button[aria-label="刷新图源"]')!.click(); }
async function run() {
  await until(() => requests > 0, "首版图未请求");
  revision = "two"; refresh();
  await until(() => !!document.querySelector("iframe"), "新版图未显示");
  await pause(800);
  const frame = document.querySelector("iframe")!;
  if (!frame.srcdoc.includes("新版订单模块") || frame.srcdoc.includes("旧版订单模块")) throw Error("迟到的旧图覆盖新图");
  if (frame.getAttribute("sandbox") !== "allow-scripts allow-downloads") throw Error("iframe 隔离丢失");
  if (document.querySelectorAll(".story-view-entry").length !== 5) throw Error("4+1 视图被静默省略");
  document.querySelector<HTMLButtonElement>(".story-view-status.omitted")!.closest("button")!.click();
  await until(() => document.body.textContent!.includes("沿用现有部署"), "不涉及的原因未知会用户");
  if (document.querySelector("iframe")) throw Error("未涉及的视图错用了其他视图的图");
  document.querySelector<HTMLButtonElement>(".story-view-entry")!.click();
  await until(() => !!document.querySelector("iframe"), "切回逻辑视图无法恢复图");
  document.getElementById("jump-class")!.click();
  await until(() => !!document.querySelector('.architecture-uml img'), "Story 类图无法跳转至图片页签");
  const image = document.querySelector<HTMLImageElement>('.architecture-uml img')!;
  if (!image.src.startsWith("data:image/svg+xml;base64,") || image.alt !== "订单类关系") throw Error("类图未安全显示");
  if (document.querySelector("iframe")) throw Error("切换类图仍残留 Archify");
  document.querySelector<HTMLButtonElement>('button[aria-label="放大图片"]')!.click();
  await until(() => image.style.width === "125%", "类图不能放大");
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "演示 ⛶")!.click();
  await until(() => !!document.querySelector('.architecture-uml.is-presenting'), "类图不能全屏演示");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  await until(() => !document.querySelector('.architecture-uml.is-presenting'), "Escape 无法退出类图演示");
  mode = "syntax-error"; refresh();
  await until(() => document.body.textContent!.includes("图源有语法错误"), "错误图冒充正常类图");
  mode = "render-error"; refresh();
  await until(() => !!document.querySelector(".story-architecture-failure"), "渲染失败没有反馈入口");
  if (document.querySelector("iframe")) throw Error("渲染失败仍展示旧图");
  const details = document.querySelector<HTMLDetailsElement>(".story-architecture-failure details")!;
  if (details.open || !details.textContent!.includes("label overlaps module")) throw Error("失败详情未保留或默认展开挤占页面");
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "打开 Story 提意见")!.click();
  if (!opened) throw Error("失败状态无法回到 Story 提意见");
  opened = false;
  mode = "error"; refresh();
  await until(() => document.body.textContent!.includes("Story 读取失败"), "读取错误未呈现");
  if (document.querySelector("iframe")) throw Error("读取失败仍展示旧图");
  mode = "empty"; revision = "three"; refresh();
  await until(() => document.body.textContent!.includes("尚无可展示"), "旧 Story 空态未呈现");
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith("阅读完整 Story"))!.click();
  if (!opened) throw Error("无法返回完整 Story");
  mode = "ready"; revision = "four"; refresh();
  await until(() => !!document.querySelector('.architecture-uml img'), "类图无法恢复");
  return { umlNavigable: true, umlFullscreen: true, raceProtected: true, staleRemoved: true, failureReadable: true, emptyReadable: true, opened };
}
run().then((result) => document.getElementById("result")!.textContent = JSON.stringify(result))
  .catch((error) => document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }));
