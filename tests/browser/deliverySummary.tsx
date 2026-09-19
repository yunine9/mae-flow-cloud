import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { TaskWorkspace } from "../../web/src/TaskWorkspace";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const linked = new URL(location.href).searchParams.has("deliverySummary");
const name = "task-materials/交付摘要.md";
let published = linked;
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
window.fetch = async input => {
  const path = String(input);
  let value: unknown;
  if (path.endsWith("/artifacts")) value = published ? [{ name, kind: "doc", label: "交付摘要.md", bytes: 100, modified_at: "2026-09-19" }] : [];
  else if (path.includes("/artifacts/")) value = { content: "# 交付摘要\n首次交付快照\n```plantuml\n@startuml\nA -> B: 查询\n@enduml\n```\n## 测试情况\n空结果：未确认" };
  else if (path.endsWith("/conversation")) value = { items: [], problems: [] };
  else if (path.endsWith("/annotations")) value = { items: [], checks: [], closures: [] };
  else if (path === "/diagrams/plantuml") value = { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200"><text y="40">查询调用图</text></svg>' };
  else return new Response("{}", { status: 404 });
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
};
const task: any = { id: "task-summary", requirement: "查询需求", title: "交付摘要验收", status: "verifying", created_at: "2026-09-19", updated_at: "1", delivery: { mr_url: "https://example.com/mr/1" } };
const root = createRoot(document.getElementById("app")!);
function render() { root.render(<TaskWorkspace task={{ ...task }} viewerUsername="owner" canOperate={false} canOverride={false} canCollaborate={false} canRequestReview={false} onChanged={() => {}} onClose={() => {}} />); }
async function run() {
  render(); await pause(250);
  if (!linked) {
    if (document.querySelector('[aria-label="交付摘要提醒"]')) throw new Error("提前出现提醒");
    published = true; task.updated_at = "2"; render();
  }
  let banner: Element | null = null;
  for (let i = 0; i < 40 && !banner; i++) { await pause(50); banner = document.querySelector('[aria-label="交付摘要提醒"]'); }
  if (!banner) throw new Error("摘要完成后没有提醒");
  if (!linked) {
    if (document.querySelector(".ws-doc")?.textContent?.includes("首次交付快照")) throw new Error("抢占了阅读页面");
    (banner.querySelector("button") as HTMLButtonElement).click();
  }
  for (let i = 0; i < 40 && !document.querySelector(".plantuml-viewport img"); i++) await pause(50);
  if (!document.querySelector(".ws-doc")?.textContent?.includes("首次交付快照")) throw new Error("没有打开摘要");
  if (!document.querySelector(".plantuml-viewport img")) throw new Error("图没有渲染");
  if (errors.length) throw new Error(errors.join(";"));
  return { passed: true };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
