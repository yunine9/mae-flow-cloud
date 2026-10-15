import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { TaskWorkspace } from "../../web/src/TaskWorkspace";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const linked = new URL(location.href).searchParams.has("deliverySummary");
const manual = new URL(location.href).searchParams.has("manual");
const name = "task-materials/交付报告.md";
let published = linked;
let requests = 0, revision = 0;
const errors: string[] = [];
window.addEventListener("error", e => errors.push(e.message));
window.addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
window.fetch = async input => {
  const path = String(input);
  let value: unknown;
  if (path.endsWith("/delivery-report")) {
    requests++;
    if (requests === 1) return new Response(JSON.stringify({ error: "暂不可用，请重试" }), { status: 409 });
    task.delivery_report = { status: "running", message: "交付报告正在生成", available: published };
    value = task;
  }
  else if (/\/artifacts(?:\?|$)/.test(path)) value = published ? [{ name, kind: "doc", label: "交付报告.md", bytes: 100, modified_at: "2026-09-19" }] : [];
  else if (path.includes("/artifacts/")) value = { content: "# 交付报告\n本次版本的交付报告\n```plantuml\n@startuml\nA -> B: 查询\n@enduml\n```\n## 测试情况\n空结果：未确认" };
  else if (/\/conversation(?:\?|$)/.test(path)) value = { items: [], problems: [] };
  else if (path.endsWith("/developer-assistant")) value = { state: "idle", messages: [], tools: [], availability: { available: false, code: "host_wait", mode: "unavailable", reason: "等待合入" } };
  else if (path.endsWith("/annotations")) value = { items: [], checks: [], closures: [] };
  else if (path === "/diagrams/plantuml") value = { svg: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200"><text y="40">查询调用图</text></svg>' };
  else return new Response("{}", { status: 404 });
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
};
const task: any = { id: "task-summary", requirement: "查询需求", title: "交付报告验收", status: "verifying", created_at: "2026-09-19", updated_at: "1", delivery: { mr_url: "https://example.com/mr/1" } };
const root = createRoot(document.getElementById("app")!);
function render() {
  task.updated_at = String(++revision);
  if (manual) {
    task.status = "await_merge";
    task.luban_account = "owner";
    task.delivery.pipeline = "success";
    task.delivery.git_push = { sha: "a".repeat(40) };
  }
  root.render(<TaskWorkspace task={{ ...task }} viewerUsername="owner" canOperate={manual} canOverride={false} canCollaborate={false} canRequestReview={false} onChanged={render} onClose={() => {}} />);
}
async function run() {
  render(); await pause(250);
  const action = (text: string) => [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(row => row.textContent === text);
  const openMenu = async () => {
    if (!document.querySelector('[aria-label="交付报告操作"]')) {
      const docs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(row => row.textContent?.includes("产出文档"));
      if (!docs) throw new Error("缺少产出文档入口");
      docs.click(); await pause(100);
    }
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="交付报告操作"]');
    if (!trigger?.closest('.ws-material-tools')) throw new Error("报告操作未收在文档工具栏");
    if (trigger.getAttribute('aria-expanded') !== 'true') { trigger.click(); await pause(100); }
  };
  const isDisabled = (text: string) => action(text)?.getAttribute("aria-disabled") === "true";
  if (document.querySelector('[aria-label="交付报告提醒"]')) throw new Error("报告仍单独占据顶部提示条");
  if (manual) {
    if (action("生成报告")) throw new Error("报告操作在菜单外展开");
    await openMenu();
    if (!action("生成报告")) throw new Error("历史任务缺少生成入口");
    action("生成报告")!.click(); await pause(100);
    if (![...document.querySelectorAll('[role="alert"]')].some(row => row.textContent?.includes("暂不可用"))) throw new Error("没有展示生成错误");
    action("生成报告")!.click(); await pause(100);
    if (!isDisabled("生成中…")) throw new Error("生成期间可重复触发");
    task.delivery_report = { status: "completed", message: "交付报告已更新", available: true }; published = true; render(); await pause(100);
    if (!action("查看交付报告") || !action("更新报告")) throw new Error("报告完成后缺少查看或更新入口");
    action("查看交付报告")!.click();
    for (let i = 0; i < 40 && !document.querySelector(".plantuml-viewport img"); i++) await pause(50);
    if (!document.querySelector(".ws-doc")?.textContent?.includes("本次版本的交付报告") || !document.querySelector(".plantuml-viewport img")) throw new Error("绿灯任务未在工作区打开含图报告");
    task.delivery_report = { status: "failed", message: "生成失败，仍可查看上份报告", available: true }; render(); await pause(100);
    await openMenu();
    if (!action("查看交付报告") || !action("重试生成")) throw new Error("失败后旧报告或重试入口丢失");
    action("重试生成")!.click(); await pause(100);
    if (!isDisabled("生成中…") || requests !== 3) throw new Error("重试未生效");
    if (errors.length) throw new Error(errors.join(";"));
    return { passed: true };
  }
  if (!linked) {
    published = true; task.updated_at = "2"; render();
    await pause(100);
  }
  if (!linked) {
    if (document.querySelector(".ws-doc")?.textContent?.includes("本次版本的交付报告")) throw new Error("抢占了阅读页面");
    await openMenu();
    if (action("生成报告") || action("更新报告")) throw new Error("只读用户出现生成操作");
    action("查看交付报告")!.click();
  }
  for (let i = 0; i < 40 && !document.querySelector(".plantuml-viewport img"); i++) await pause(50);
  if (!document.querySelector(".ws-doc")?.textContent?.includes("本次版本的交付报告")) throw new Error("没有打开摘要");
  if (!document.querySelector(".plantuml-viewport img")) throw new Error("图没有渲染");
  if (errors.length) throw new Error(errors.join(";"));
  return { passed: true };
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
