import React, { useState } from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import { KnowledgeTaskCenter } from "../../web/src/KnowledgeTaskCenter";
import type { KnowledgeTaskCenterData, KnowledgeTaskKind } from "../../src/knowledgeTaskCenterTypes";

const fixture = JSON.parse(document.getElementById("fixture")!.textContent!) as {
  populated: KnowledgeTaskCenterData; warningsOnly: KnowledgeTaskCenterData; badPaths: string[];
  runningId: string; completedId: string; attentionId: string;
};
const opened: Array<{ kind: KnowledgeTaskKind; id: string; review?: boolean }> = [], errors: string[] = [];
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
  const [onlyWarnings, setOnlyWarnings] = useState(false);
  return <><button id="only-warnings" onClick={() => setOnlyWarnings(true)}>仅坏文件场景</button><KnowledgeTaskCenter
    data={onlyWarnings ? fixture.warningsOnly : fixture.populated} onBack={() => {}}
    onOpen={(kind, id, review) => opened.push({ kind, id, review })} /></>;
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
    check(opened.at(-1)?.kind === "domain" && opened.at(-1)?.id === fixture.completedId && opened.at(-1)?.review === true, "正常已完成研究仍能打开文稿");
    await select("待处理"); assertWarnings(fixture.populated.warnings);
    check(rows().length === 1, "坏文件不让其他有效待处理任务消失");
    rows()[0].click();
    check(opened.at(-1)?.kind === "component" && opened.at(-1)?.id === fixture.attentionId && opened.at(-1)?.review === false, "正常失败研究仍能打开研究过程");
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
    check(!errors.length, errors.join("；"));
    check(document.documentElement.scrollWidth <= innerWidth, "1366桌面不横向溢出");
    return { passed: true, width: innerWidth, height: innerHeight };
  } finally { root.unmount(); }
}
run().then(value => { document.getElementById("result")!.textContent = JSON.stringify(value); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error) }); });
