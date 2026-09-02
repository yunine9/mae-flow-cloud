import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workspace = readFileSync(resolve("web/src/TaskWorkspace.tsx"), "utf-8");
const taskCard = readFileSync(resolve("web/src/TaskCard.tsx"), "utf-8");
const gitDiff = readFileSync(resolve("web/src/GitDiff.tsx"), "utf-8");
const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");
const steerBox = readFileSync(resolve("web/src/SteerBox.tsx"), "utf-8");
const historyBoard = readFileSync(resolve("web/src/HistoryBoard.tsx"), "utf-8");
const crossRepositorySync = readFileSync(
  resolve("web/src/CrossRepositorySync.tsx"), "utf-8");

test("进入独立执行现场页签后直接展开，不要求用户再点一次", () => {
  assert.match(workspace, /<ExecutionPanel task=\{task\} defaultOpen \/>/);
});

test("批注与检视是常驻按钮，点击展开右侧抽屉且不替换主工作面", () => {
  const navigation = workspace.slice(
    workspace.indexOf('aria-label="任务工作台视图"'),
    workspace.indexOf('<div ref={workspaceBody'),
  );
  assert.match(navigation, /ws-review-launch/);
  assert.match(navigation, /批注与检视/);
  assert.match(navigation, /aria-haspopup="dialog"/);
  // 2026-09-02 弹层改抽屉:挤进正文右栏,主工作面(材料/协作/执行)不动。
  assert.match(workspace,
    /className="workspace-review-drawer"\s+role="complementary"/);
  assert.match(workspace, /\{reviewWorkspaceContent\}/,
    "抽屉应承载完整批注、回应和 Committer 检视工作面");
  assert.doesNotMatch(workspace, /aria-label="本轮检视清单"/,
    "批注不应以旧的'本轮检视清单'形态接管 Agent 当前问题");
});

test("Token 用量是执行现场独立页签，不混入实时事件或批注检视", () => {
  assert.match(workspace, /type ExecutionView = "events" \| "knowledge" \| "tokens"/);
  assert.match(workspace, /onClick=\{\(\) => setExecutionView\("tokens"\)\}/);
  assert.match(workspace, /<strong>Token 使用<\/strong>/);
  assert.match(workspace, /hidden=\{executionView !== "tokens"\}/);

  const reviewContent = workspace.slice(
    workspace.indexOf("const reviewWorkspaceContent"),
    workspace.indexOf("return (", workspace.indexOf("const reviewWorkspaceContent")),
  );
  assert.doesNotMatch(reviewContent, /<TokenUsage|<TaskTimeline/,
    "检视弹层只应承载意见和检视动作");

  const eventContent = workspace.slice(
    workspace.indexOf('hidden={executionView !== "events"}'),
    workspace.indexOf('hidden={executionView !== "knowledge"}'),
  );
  assert.doesNotMatch(eventContent, /<TokenUsage/,
    "实时事件页不应继续重复显示 Token 卡");
});

test("低频跨仓同步下沉到开发协作底部并默认折叠", () => {
  const collaboration = workspace.slice(
    workspace.indexOf('workspaceView === "collaboration"'),
    workspace.indexOf('</> : <>', workspace.indexOf('workspaceView === "collaboration"')),
  );
  assert.ok(collaboration.indexOf("<SteerBox")
    < collaboration.indexOf("<CrossRepositorySync"),
  "主协作操作必须在前，低频跨仓工具放在底部");
  assert.match(crossRepositorySync,
    /return <details className="cross-repository-sync">/,
    "跨仓同步默认折叠，不能继续占据整块首屏");
  assert.match(crossRepositorySync, /OPTIONAL TOOL/);
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

test("补充给主任务置灰时明确解释原因，而不是只留一个灰输入框", () => {
  assert.match(steerBox, /steerDisabledReason/);
  assert.match(steerBox, /主任务正在等待人工决定/);
  assert.match(steerBox, /主任务已暂停/);
  assert.match(steerBox, /当前正在验证交付结果/);
  assert.match(steerBox, /当前正在等待合入/);
  assert.match(steerBox, /className="steer-disabled-reason"/);
});

test("责任人能在终态任务上看到删除入口，并必须二次确认", () => {
  assert.match(workspace,
    /const deletable = canOperate && \["completed", "failed", "canceled"\]/);
  assert.match(workspace, />删除任务<\/button>/);
  assert.match(workspace, /工作区和记录将永久删除/);
  assert.match(workspace, /确认删除/);
  assert.match(historyBoard,
    /viewer\.role === "admin"[^]*entry\.luban_account === viewer\.username/,
    "档案页应同时允许管理员和任务责任人删除真终态");
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
  assert.match(taskCard,
    /const deliveryReady = !requiresDeliverySelection\s*\|\| selectedHandlesFeedback/,
    "返工不能被 diff/文件清单加载失败卡死；只有确认推送需要当前清单");
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

test("最终代码审阅统计只计算将推送文件，不混入仅留本地改动", () => {
  assert.match(gitDiff,
    /const countedFiles = selectable[^]*deliveryPaths\.has\(file\.path\)/,
    "交付检视标题的加减行数必须跟随最终推送勾选集合");
  assert.match(gitDiff, /const additions = countedFiles\.reduce/);
  assert.match(gitDiff, /const deletions = countedFiles\.reduce/);
});

test("已完成任务的进度展示收口到末段，不沿用合入前最后一步", () => {
  assert.match(taskCard, /const completed = status === "completed"/);
  // 末段的名字来自任务 API(内核 flow/phases.json),前端不再自己追加
  // "完成"、也不把"交付"改写成"验证与交付"——那是第二套词表,和内核
  // 方案词表对不上就点不动(2026-09-02 用户实锤)。
  assert.doesNotMatch(taskCard, /\[\.\.\.progress\.phases, "完成"\]/);
  assert.doesNotMatch(taskCard, /验证与交付/);
  assert.match(taskCard,
    /const currentLabel = completed\s*\? \(phases\.at\(-1\) \?\? progress\.current_phase\)/);
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

test("需求原文接入圈注层，终态只把已停止任务设为只读", () => {
  const sourceBranch = workspace.slice(
    workspace.indexOf('materialView === "source" ?'),
    workspace.indexOf(') : materialView === "chain"'),
  );
  assert.match(sourceBranch, /<Annotatable/);
  assert.match(sourceBranch, /artifact=\{TASK_REQUIREMENT_ARTIFACT\}/);
  assert.match(sourceBranch, /fallbackFile="需求原文"/);
  assert.match(sourceBranch, /<Markdown text=\{task\.requirement\} resolveImage=/,
    "需求原文应原样进入 Markdown，并为包内图片提供受控解析入口");
  assert.match(sourceBranch, /requirement_document\?\.assets\?\.some/,
    "只有任务元数据登记过的图片才能渲染，不能开放任意地址");
  assert.match(workspace, /return status !== "canceled"/,
    "已交付任务可归档批注，只有明确停止后才关闭新增入口");
  assert.match(workspace,
    /const check = checks\.find\(\(candidate\) => candidate\.id === item\.id\)/,
    "定位应读取当前批注的重锚定结果");
  assert.match(workspace, /const currentLine = check\?\.line \?\? item\.line/,
    "定位应优先使用重锚定后的当前行号");
});

test("需求确认复用标准决定卡，并收成一个明确的通过按钮", () => {
  assert.match(taskCard,
    /requirementAnalysisConfirmation[^]*<section className="decision-card"/,
    "需求确认应沿用现有决定卡，不另造一套布局");
  assert.match(taskCard, /需求已确认，进入需求分析/);
  assert.match(taskCard,
    /requirementAnalysisConfirmation[^]*attachmentCount === 0[^]*requirement_revision\?\.state !== "running"/,
    "Agent 修改中或检视意见未闭环时不能放行");
  assert.match(workspace,
    /requirementAnalysisConfirmation \? undefined : draftIds/,
    "确认按钮不应再次夹带批注，批注要先独立交给文档 Agent 闭环");
  assert.doesNotMatch(workspace, /编辑需求原文|保存修改/,
    "人工只提检视意见，不与 Agent 同时编辑需求正本");
});
