import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// 2026-09-02 用户点名的三处易用性(批注与检视是核心竞争力,易用性优先):
// 批注编辑框能拉大、任务列表最新在上(带开关)、决策选项原文可复制。
const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const annotatable = read("web/src/Annotatable.tsx");
const annotationPanel = read("web/src/AnnotationPanel.tsx");
const annotateCss = read("web/src/annotate.css");
const app = read("web/src/App.tsx");
const taskCard = read("web/src/TaskCard.tsx");
const css = read("web/src/style.css");
const taskTime = read("web/src/taskTime.ts");
const taskHierarchy = read("web/src/taskHierarchy.ts");

test("批注编辑框默认更高,且能竖向拖到大半屏", () => {
  assert.match(annotatable, /<textarea\s+autoFocus\s+rows=\{4\}/);
  assert.match(annotationPanel, /<textarea value=\{editingNote\} autoFocus rows=\{5\}/);
  assert.match(annotateCss,
    /\.annot-editor textarea \{[^}]*min-height:\s*108px[^}]*max-height:\s*70vh[^}]*resize:\s*vertical/s);
  assert.match(annotateCss,
    /\.annot-inline-editor textarea \{[^}]*min-height:\s*132px[^}]*max-height:\s*70vh[^}]*resize:\s*vertical/s);
});

test("任务列表默认最新在上,开关可切回待核对在前并记在本机", () => {
  assert.match(taskTime, /export function byNewest/);
  assert.match(app, /localStorage\.getItem\("mae-flow-task-order"\) === "attention"\s*\? "attention" : "newest"/);
  assert.match(app, /const visibleMyWork = taskOrder === "newest"\s*\? \[\.\.\.scopedMyWork\]\.sort\(byNewest\) : scopedMyWork/);
  assert.match(app, /tasks=\{visibleMyDelivered\}/, "等待合入分组也跟着同一个开关");
  assert.match(app, /className="task-order-toggle"/);
  assert.match(app, /最新在上/);
  assert.match(app, /待核对在前/);
  assert.match(css, /\.task-order-toggle\s*\{/);
  assert.match(taskHierarchy, /export function orderHierarchyBy/,
    "时间只排序任务组，主任务与子任务必须随后恢复成树形顺序");
  assert.match(app, /orderHierarchyBy\(visible,[\s\S]*item\.task\?\.parent_task_id/,
    "团队任务列表也必须恢复主子层级，不能只修我的需求");
});

test("决策选项原文可拖选复制,拖选松手不选中选项", () => {
  // 用户拍板:不要复制按钮,能选中就行。
  assert.match(css, /\.option-body \{[^}]*user-select:\s*text/s);
  assert.doesNotMatch(taskCard, /option-copy/);
  assert.match(taskCard,
    /const selection = window\.getSelection\(\);\s*if \(selection && !selection\.isCollapsed[\s\S]{0,200}return;\s*\}\s*pickOption\(item\.question, option\);/,
    "拖选松手浏览器照样派 click,不拦一下就把选项选上了");
});

test("任务决策卡选项可取消，自定义答复入口不会在打开后消失", () => {
  assert.match(taskCard,
    /setPicked\(\(current\) => toggleDecisionChoice\(current, question, option\)\)/);
  assert.match(taskCard,
    /className=\{`option custom-entry\$\{customActive \? " picked" : ""\}`\}/);
  assert.match(taskCard, /\? "自定义答复"/);
  assert.doesNotMatch(taskCard, /\{!customOpen\[item\.question\] && \(/,
    "打开编辑框后入口也必须保留，才能再次点击取消");
  assert.match(taskCard,
    /const explanation = customOpen\[item\.question\][\s\S]{0,100}\? custom\[item\.question\]\?\.trim\(\)/,
    "收起的自定义草稿不能偷偷随另一选项提交");
});
