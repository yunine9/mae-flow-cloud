import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workspace = readFileSync(resolve("web/src/TaskWorkspace.tsx"), "utf-8");
const taskCard = readFileSync(resolve("web/src/TaskCard.tsx"), "utf-8");
const gitDiff = readFileSync(resolve("web/src/GitDiff.tsx"), "utf-8");
const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");

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

test("等待人工检视时工作台标题显示人的当前事项，不沿用自动阶段旧步骤", () => {
  const policy = workspace.slice(
    workspace.indexOf("function workspaceProgress"),
    workspace.indexOf("function assistantUnavailableReason"),
  );
  assert.match(policy, /status === "waiting_for_human"/);
  assert.match(policy, /step: task\.focus\?\.headline/);
});

test("任务摘要卡仍按需展开，避免多张卡同时建立实时连接", () => {
  const utilities = taskCard.slice(
    taskCard.indexOf('<div className="task-utilities">'),
    taskCard.indexOf("</article>"),
  );
  assert.match(utilities, /<ExecutionPanel task=\{task\} \/>/);
  assert.doesNotMatch(utilities, /<ExecutionPanel task=\{task\} defaultOpen \/>/);
});

test("push 检视先给这次修改入口，同时保留完整交付与文件选择", () => {
  assert.match(taskCard, />\s*查看这次修改\s*</);
  assert.match(taskCard, />\s*查看完整交付\s*</);
  assert.match(taskCard, /activeDeliveryScope === "full"[^]*完整交付已显示/,
    "已经摆在左侧的完整交付必须是状态，不得保留成点击无反馈的假按钮");
  assert.match(workspace, /activeDeliveryScope=\{task\.waiting[^]*diffScope/,
    "决策卡必须知道左侧当前显示的范围，不能只拿到一个盲跳回调");
  assert.match(workspace,
    /readPushReviewDiff\(task\.id, diffScope\)/,
    "跳转后必须读取服务端固化的比较锚，不能在浏览器猜 Git revision");
  assert.match(workspace,
    /pushReview\.committed_paths[^]*pushReview\.all_paths/,
    "快速复检不能丢掉完整交付清单，确认仍要覆盖当前全部待推送文件");
  assert.match(workspace,
    /!pushReview \|\| diffScope === "full"/,
    "只有完整交付视图能调整文件范围，这次修改视图保持纯阅读");
});

test("Agent 长说明与提交记录默认折叠，避免挤满窄决策栏", () => {
  assert.match(taskCard, /<details className="push-review-evidence">/);
  assert.match(taskCard, /<strong>Agent 交付说明<\/strong>/);
  assert.doesNotMatch(taskCard,
    /<p className="push-review-agent-note">\s*<strong>Agent 说明<\/strong>/,
    "长篇内部回复不能继续与标题、提交记录全挤在一个段落里");
});

test("最终交付范围只在 diff 树调整，决策卡保留摘要和直达入口", () => {
  assert.doesNotMatch(taskCard, /className="delivery-scope-files"/);
  assert.match(taskCard, /文件去留在左侧代码差异中调整/);
  assert.match(taskCard, /打开代码差异并调整文件/);
  assert.match(taskCard, /按这 \$\{deliverySelection\.selectedPaths\.length\} 个文件推送/);
  assert.match(taskCard, /提交返工意见/);
  assert.doesNotMatch(workspace, /onDeliverySelectionChange=\{task\.waiting/);
  assert.match(workspace, /focusRequest=\{diffReviewRequest\}/);
  assert.match(gitDiff, /if \(focusRequest > 0\) setFocused\(true\)/);
  assert.match(gitDiff, /requestedDeliveryKey[^]*setDeliveryPaths/);
});

test("工作台打开后列表卡只保留待办信号，不重复渲染整张决定表单", () => {
  assert.match(app,
    /decisionMode=\{artifactTaskId === task\.id \? "signal" : "form"\}/);
});

test("工作区其他改动默认折叠但不隐藏事实", () => {
  assert.match(gitDiff, /const \[localGroupOpen, setLocalGroupOpen\]/);
  assert.match(gitDiff, /工作区其他改动 · 默认仅留本地/);
  assert.match(gitDiff, /localGroupOpen && renderTreeNodes\(localTree/);
});

test("已完成任务的进度展示收口到完成，不沿用合入前最后一步", () => {
  assert.match(taskCard, /const completed = status === "completed"/);
  assert.match(taskCard, /\[\.\.\.progress\.phases, "完成"\]/);
  assert.match(taskCard, /const currentLabel = completed \? "完成"/);
  assert.match(taskCard, /status=\{task\.status\}/,
    "列表卡和工作台都要把任务终态交给同一进度组件");
  assert.match(workspace, /showDetailedStep status=\{task\.status\}/);
});

test("诊断包导出给出生成、成功与失败反馈，不再静默下载", () => {
  assert.match(workspace, /正在生成诊断包/);
  assert.match(workspace, /已开始下载/);
  assert.match(workspace, /生成失败，请重试/);
  assert.match(workspace, /response\.blob\(\)/,
    "只有服务端真实返回诊断包后才能提示已开始下载");
});
