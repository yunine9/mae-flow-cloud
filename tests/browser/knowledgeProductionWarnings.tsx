import React, { useState } from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeTaskCenter } from "../../web/src/KnowledgeTaskCenter";
import type { KnowledgeTaskCenterData, KnowledgeTaskKind } from "../../src/knowledgeTaskCenterTypes";
import type { KnowledgeProductionAction } from "../../src/knowledgeProductionTypes";

const fixture = JSON.parse(document.getElementById("fixture")!.textContent!) as {
  populated: KnowledgeTaskCenterData; warningsOnly: KnowledgeTaskCenterData; matrix: KnowledgeTaskCenterData; badPaths: string[];
  runningId: string; completedId: string; attentionId: string;
};
const opened: Array<{ kind: KnowledgeTaskKind; id: string; action: KnowledgeProductionAction }> = [], errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
async function until(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`等待超过1秒预算：${message}`);
}
function Fixture() {
  const [scene, setScene] = useState<"populated" | "warningsOnly" | "matrix">("populated");
  return <><button id="only-warnings" onClick={() => setScene("warningsOnly")}>仅坏文件场景</button><button id="production-matrix" onClick={() => setScene("matrix")}>后端组合状态场景</button><KnowledgeTaskCenter
    data={fixture[scene]} onBack={() => {}}
    onOpen={(kind, id, action) => opened.push({ kind, id, action: structuredClone(action) })} /></>;
}
const warnings = () => [...document.querySelectorAll<HTMLElement>(".knowledge-task-table .knowledge-task-warning")].map(node => node.textContent!);
const rows = () => [...document.querySelectorAll<HTMLButtonElement>(".knowledge-task-row")];
const tab = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="按任务状态筛选"] button')].find(button => button.textContent!.startsWith(label));
async function select(label: string) {
  const button = tab(label); check(button, `缺少${label}分组`);
  button!.click();
  await until(() => button!.getAttribute("aria-pressed") === "true", `${label}分组切换`);
}
async function search(value: string) {
  const input = document.querySelector<HTMLInputElement>('[aria-label="搜索知识任务"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await until(() => input.value === value && (value ? warnings().length === 1 : warnings().length === fixture.populated.warnings.length), "按坏文件名筛选");
}
function assertWarnings(expected: string[]) {
  check(JSON.stringify(warnings()) === JSON.stringify(expected), `告警必须沿用后端原文：${JSON.stringify(warnings())}`);
}
async function run() {
  const root = createRoot(document.getElementById("app")!);
  root.render(<Fixture />);
  try {
    await until(() => !!tab("当前任务"), "任务中心首次渲染");
    assertWarnings(fixture.populated.warnings);
    check(tab("当前任务")!.querySelector("span")?.textContent === String(fixture.populated.summary.running + fixture.populated.summary.attention), "当前数量来自后端统计，包含告警");
    check(tab("待处理")!.querySelector("span")?.textContent === String(fixture.populated.summary.attention), "待处理数量来自后端统计");
    for (const path of fixture.badPaths) check(warnings().some(warning => warning.includes(path)), `告警点名坏文件 ${path}`);
    await select("进行中"); assertWarnings([]);
    check(rows().length === 1 && rows()[0].textContent!.includes("正在进行的正常研究"), "进行中保留有效研究且不显示坏文件告警");
    await select("已完成"); assertWarnings([]);
    check(rows().length === 1 && rows()[0].textContent!.includes("已完成的正常领域研究"), "已完成保留历史研究且不显示坏文件告警");
    rows()[0].click();
    check(opened.at(-1)?.kind === "domain" && opened.at(-1)?.id === fixture.completedId && opened.at(-1)?.action.view === "review", "正常已完成研究仍能打开文稿");
    await select("待处理"); assertWarnings(fixture.populated.warnings);
    check(rows().length === 1, "坏文件不让其他有效待处理任务消失");
    rows()[0].click();
    check(opened.at(-1)?.kind === "component" && opened.at(-1)?.id === fixture.attentionId && opened.at(-1)?.action.view === "progress", "正常失败研究仍能打开研究过程");
    await search("RECORD.JSON");
    assertWarnings(fixture.populated.warnings.filter(warning => warning.toLocaleLowerCase().includes("record.json")));
    check(rows().length === 0, "按文件名查找只显示匹配告警");
    await search("");
    await select("当前任务"); assertWarnings(fixture.populated.warnings);
    document.getElementById("only-warnings")!.click();
    await until(() => rows().length === 0 && tab("待处理")!.querySelector("span")?.textContent === String(fixture.warningsOnly.summary.attention), "只有坏文件的场景");
    assertWarnings(fixture.warningsOnly.warnings);
    check(!document.querySelector(".knowledge-task-empty"), "只有告警时不能误报还没有知识任务");
    await select("待处理"); assertWarnings(fixture.warningsOnly.warnings);
    check(!document.querySelector(".knowledge-task-empty"), "只有告警的待处理组也不是空态");
    await select("进行中"); assertWarnings([]);
    await select("已完成"); assertWarnings([]);
    document.getElementById("production-matrix")!.click();
    await until(() => tab("待处理")!.querySelector("span")?.textContent === String(fixture.matrix.summary.attention), "后端组合状态场景");
    await select("待处理"); assertWarnings([]);
    check(rows().length === fixture.matrix.tasks.length, "全部领域/组件组合状态都在后端指定待处理组");
    for (const task of fixture.matrix.tasks) {
      const production = task.production!;
      check(production, `${task.title} 缺少后台详情投影`);
      const row = rows().find(row => row.querySelector(".knowledge-task-title")?.textContent === task.title)!;
      check(row, `缺少组合状态任务 ${task.title}`);
      const label = row.querySelector<HTMLElement>(".knowledge-task-status")!;
      check(label.textContent === production.status_label, `${task.title} 状态文案必须沿用详情后台投影`);
      check(label.classList.contains(`is-${production.group}`), `${task.title} 颜色分组必须沿用详情后台投影`);
      row.click();
      const selected = opened.at(-1)!;
      check(selected.kind === task.kind && selected.id === task.id, `${task.title} 点击保留对象身份`);
      check(JSON.stringify(selected.action) === JSON.stringify(production.next_action), `${task.title} 点击必须保留完整后端动作（view、href、document_id）`);
    }
    await select("当前任务");
    check(rows().length === fixture.matrix.tasks.length, "组合状态不会误归已完成而从当前任务消失");
    await select("进行中"); check(rows().length === 0, "研究已失败的组合任务不能前端改推为进行中");
    await select("已完成"); check(rows().length === 0, "等待处理的组合任务不能前端改推为已完成");
    check(!errors.length, errors.join("；"));
    check(document.documentElement.scrollWidth <= innerWidth, "1366桌面不横向溢出");
    return { passed: true, width: innerWidth, height: innerHeight };
  } finally { root.unmount(); }
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
