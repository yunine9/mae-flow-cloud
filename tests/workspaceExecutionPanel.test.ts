import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workspace = readFileSync(resolve("web/src/TaskWorkspace.tsx"), "utf-8");
const taskCard = readFileSync(resolve("web/src/TaskCard.tsx"), "utf-8");

test("进入独立执行现场页签后直接展开，不要求用户再点一次", () => {
  const executionView = workspace.slice(
    workspace.indexOf('workspaceView === "execution"'),
    workspace.indexOf('ws-insights-view'),
  );
  assert.match(executionView, /<ExecutionPanel task=\{task\} defaultOpen \/>/);
});

test("任务摘要卡仍按需展开，避免多张卡同时建立实时连接", () => {
  const utilities = taskCard.slice(
    taskCard.indexOf('<div className="task-utilities">'),
    taskCard.indexOf("</article>"),
  );
  assert.match(utilities, /<ExecutionPanel task=\{task\} \/>/);
  assert.doesNotMatch(utilities, /<ExecutionPanel task=\{task\} defaultOpen \/>/);
});
