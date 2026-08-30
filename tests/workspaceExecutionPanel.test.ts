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

test("运行中的任务默认进入执行现场，真正等人时才回到材料", () => {
  const policy = workspace.slice(
    workspace.indexOf("function defaultWorkspaceView"),
    workspace.indexOf("function sizeText"),
  );
  assert.match(policy, /status === "paused"[^]*return "collaboration"/);
  assert.match(policy,
    /task\.waiting \|\| task\.status === "waiting_for_human"[^]*return "materials"/);
  assert.match(policy,
    /"queued", "running", "pausing", "verifying", "await_merge"[^]*return "execution"/);
});

test("任务摘要卡仍按需展开，避免多张卡同时建立实时连接", () => {
  const utilities = taskCard.slice(
    taskCard.indexOf('<div className="task-utilities">'),
    taskCard.indexOf("</article>"),
  );
  assert.match(utilities, /<ExecutionPanel task=\{task\} \/>/);
  assert.doesNotMatch(utilities, /<ExecutionPanel task=\{task\} defaultOpen \/>/);
});
