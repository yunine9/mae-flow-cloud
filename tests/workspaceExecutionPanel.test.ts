import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workspace = readFileSync(resolve("web/src/TaskWorkspace.tsx"), "utf-8");
const taskCard = readFileSync(resolve("web/src/TaskCard.tsx"), "utf-8");
const gitDiff = readFileSync(resolve("web/src/GitDiff.tsx"), "utf-8");
const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");
const composer = readFileSync(resolve("web/src/Composer.tsx"), "utf-8");
const stream = readFileSync(resolve("web/src/ConversationStream.tsx"), "utf-8");
const historyBoard = readFileSync(resolve("web/src/HistoryBoard.tsx"), "utf-8");

test("任务进展只展示过程，日志在用户主动打开时加载", () => {
  const activity = workspace.slice(workspace.indexOf('<div className="ws-primary-scroll ws-execution-view">'),
    workspace.indexOf('          ) : <>', workspace.indexOf('<div className="ws-primary-scroll ws-execution-view">')));
  assert.match(activity, /<TaskJourney task=\{task\}/);
  assert.doesNotMatch(activity, /<ExecutionPanel|<TaskTimeline|<TokenUsage|<KnowledgeFootprint|<WarmupPanel/);
  assert.match(workspace, /taskInspector && <TaskInspector/);
  const inspector = readFileSync(resolve("web/src/TaskInspector.tsx"), "utf8");
  assert.match(inspector, /kind === "logs" && <ExecutionPanel task=\{task\} defaultOpen/);
});

test("批注检视停靠工作区，材料保持可见，决定栏不承载意见", () => {
  assert.match(workspace, /aria-controls="ws-review-canvas"/);
  const reviewPane = readFileSync(resolve("web/src/ResizableReviewPane.tsx"), "utf8");
  assert.match(reviewPane, /className="ws-review-canvas"[\s\S]*?role="complementary"/);
  assert.match(reviewPane, /hidden=\{!open\}/);
  assert.match(workspace, /<ResizableReviewPane open=\{reviewPanelOpen\}>/);
  assert.doesNotMatch(workspace, /className="workspace-review-drawer"/);
  const side = workspace.slice(workspace.indexOf('<section className="ws-side"'),
    workspace.indexOf('{reviewInviteOpen &&'));
  assert.doesNotMatch(side, /reviewWorkspaceContent|ws-feedback-home/);
  const locate = workspace.slice(workspace.indexOf("function locate(item: Annotation)"), workspace.indexOf("const activeMeta"));
  assert.doesNotMatch(locate, /setReviewPanelOpen\(false\)/);
  assert.doesNotMatch(workspace, /className="ws-material-content" hidden/);
});

test("低频资料集中在任务详情，暂停成功不重复占据通栏", () => {
  const identity = workspace.slice(workspace.indexOf('<div className="ws-identity">'), workspace.indexOf('<div className={`ws-progress'));
  assert.match(identity, /aria-haspopup="dialog"[\s\S]*?setTaskInspector\("details"\)/);
  assert.doesNotMatch(workspace, /ws-task-facts/);
  const inspector = readFileSync(resolve("web/src/TaskInspector.tsx"), "utf8");
  for (const kind of ["usage", "workflow"]) assert.ok(inspector.includes(`onInspect("${kind}")`));
  assert.match(workspace, /preparation=\{<WarmupBadge task=\{task\}/);
  assert.doesNotMatch(inspector, /WarmupPanel|环境与执行配置/);
  for (const fact of ["luban_account", "mr_url", "pipeline", "milestone", "workspace_reclaimed_at"]) assert.ok(inspector.includes(fact));
  assert.match(workspace, /selectWorkspaceView\("knowledge"\)/);
  assert.match(workspace, /className="ws-primary-scroll ws-knowledge-view"/);
  assert.doesNotMatch(workspace, /ws-task-resources|已安全暂停/);
  const body = workspace.indexOf('<div className="ws-body"');
  assert.ok(workspace.indexOf('className="task-control-feedback"') > body);
});

test("右栏是一条会话流加一个输入框:卡在流里、提交区在输入框、接管是输入框的一档", () => {
  // 2026-09-05 用户拍板:右栏承载太多功能——改成会话流 + 单一输入框。
  // 选项在卡上就是动作;输入框只写附言/自定义/插话;工具步骤留在工作过程。
  const side = workspace.slice(workspace.indexOf('<section className="ws-side"'),
    workspace.indexOf('{reviewInviteOpen &&'));
  assert.ok(side.indexOf("<ConversationStream") < side.indexOf("<Composer"),
    "流在上、输入框在下");
  assert.doesNotMatch(side, /ws-focus-collaboration|<SteerBox|ws-decision|ws-idle/);
  assert.match(side, /currentCard=\{waiting \? \(decides \? \(\s*<WaitingCard/,
    "当前决定卡渲在流里");
  assert.match(side, /footerTarget=\{chainReview \? undefined : decisionFooterTarget\}/,
    "决定卡的提交区经 portal 挂到输入框(链式检视留在卡内由卡自己收口)");
  assert.match(composer, /className="ws-reply-dock" ref=\{dockRef\}/,
    "决定卡的提交区经 portal 挂到输入框");
  assert.match(composer, /说给 Agent/);
  assert.match(composer, /我来接手/);
  assert.match(composer, /交回给 Agent/);
  assert.match(side, /tail=\{streamTail\}/);
  // 2026-09-05 用户:"占据的面积太小了,都没空间显示文字了"——栏头、状态行、
  // 锚条、筛选四行摞着吃掉 180px。现在栏头(标题+筛选)与锚条(轮到谁·状态·
  // 责任)各一行,都由 ConversationStream 自己渲;栏宽可拖并记在浏览器里。
  assert.doesNotMatch(side, /ws-collaboration-head|ws-focus-hero|ws-focus-status/,
    "工作台不再自己摞栏头与状态行");
  assert.match(side, /className="ws-side-resizer" role="separator"/);
  assert.match(side, /statusText=\{waiting && !decides \? "等待负责人决定" : statusText\(task\)\}/);
  assert.match(workspace, /localStorage\.setItem\(SIDE_WIDTH_KEY, String\(current\)\)/);
  assert.match(workspace, /\["--ws-side-w" as string\]: `\$\{sideWidth\}px`/,
    "拖过的宽度以内联变量覆盖样式表默认档");
  // 2026-09-06 用户:"通知上下游仓库为什么不放在下面那个里面平行?"——原来是
  // 流末尾一个独立折叠工具块,和输入区两套皮。现在是输入区的第三档,只有
  // 跨仓子任务(有 parent_task_id)才出现;收到/发出的通知仍作为 sync 条目进流。
  assert.doesNotMatch(workspace, /CrossRepositorySync/, "独立的跨仓同步块已并入输入区");
  assert.match(workspace, /crossRepository=\{Boolean\(task\.parent_task_id\)\}/);
  assert.match(composer, /通知所有子任务\n/, "第三档页签");
  assert.match(composer,
    /const showSync = mode === "sync" && crossRepository && !steerOnly && !compactDecision;/);
  assert.match(composer, /publishCrossRepositoryUpdate\(task\.id, message\)/);
  assert.match(composer, /hidden=\{!decisionDock \|\| takeoverActive\}/,
    "决定卡提交区只在接管时让位;通知档经 showSync 走自己的渲染分支");
  // 定位靠 id 双向跳:抽屉 → 流线程,流 → 材料原位 + 抽屉那条卡。
  assert.match(workspace, /onShowThread=\{showThread\}/);
  assert.match(stream, /onThreadChange\(id\)/);
  assert.match(stream, /data-annotation-ids=/);
  assert.match(workspace, /#thread=\$\{encodeURIComponent\(id\)\}/, "深链带批注 id");
  // 工作过程只留步骤:Agent 的话、卡与决定不再重复出现。
  const journey = readFileSync(resolve("web/src/TaskJourney.tsx"), "utf8");
  assert.match(journey, /!\["ask", "decision"\]\.includes\(entry\.kind\)/);
  assert.doesNotMatch(journey, /tailEvents/);
});

test("任何状态都稳定落在当前视图，由内容而不是自动跳页表达变化", () => {
  const policy = workspace.slice(
    workspace.indexOf("function defaultWorkspaceView"),
    workspace.indexOf("function sizeText"),
  );
  assert.match(policy, /return "focus"/);
  assert.doesNotMatch(policy, /task\.status|task\.waiting/,
    "轮询更新不能把用户从正在阅读的工作面自动甩走");
  assert.match(workspace, /\["focus", "当前"\]/);
  assert.match(workspace, /\["materials", "材料"\]/);
  assert.match(workspace, /\["execution", "工作过程"\]/);
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
  // 原因写在输入框上方的语境条里(模式词 + 一句解释),不再是灰框下面的告示。
  assert.match(composer, /steerDisabledReason/);
  assert.match(composer, /主任务正在等待人工决定/);
  assert.match(composer, /主任务已暂停/);
  assert.match(composer, /当前正在验证交付结果/);
  assert.match(composer, /当前正在等待合入/);
  assert.match(composer, /steerDisabledReason\?\.title \?\? "主任务当前未运行"/);
  assert.match(composer, /: steerDisabledReason\?\.detail\}/);
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
  assert.match(taskCard, />\s*看这次改的\s*</);
  assert.match(taskCard, />\s*看全部改动\s*</);
  assert.match(taskCard, /activeDeliveryScope === "full"[^]*正在看全部改动/,
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
  assert.match(taskCard, /文件去留在左侧「代码改动」里调整/);
  assert.match(taskCard, /去代码改动里选文件/);
  assert.match(taskCard, /按这 \$\{deliverySelection\.selectedPaths\.length\} 个文件推送/);
  assert.match(taskCard, /重新编译后提交/);
  assert.match(taskCard, /不再编译，直接提交/);
  assert.match(taskCard, /提交返工意见/);
  assert.match(taskCard,
    /const deliveryReady = !requiresDeliverySelection\s*\|\| selectedHandlesFeedback/,
    "返工不能被 diff/文件清单加载失败卡死；只有确认推送需要当前清单");
  assert.doesNotMatch(workspace, /onDeliverySelectionChange=\{task\.waiting/);
  assert.match(workspace, /focusRequest=\{diffReviewRequest\}/);
  assert.match(gitDiff, /if \(focusRequest > 0 && !embeddedBrowser\) setFocused\(true\)/);
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
  assert.match(workspace, /showDetailedStep=\{false\} status=\{task\.status\}/);
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
  assert.match(sourceBranch, /<Markdown showLineNumbers text=\{task\.requirement\} resolveImage=/,
    "需求原文应原样进入 Markdown，并为包内图片提供受控解析入口");
  assert.match(sourceBranch, /requirement_document\?\.assets\?\.some/,
    "只有任务元数据登记过的图片才能渲染，不能开放任意地址");
  assert.match(workspace, /return status !== "canceled"/,
    "已交付任务可归档批注，只有明确停止后才关闭新增入口");
  assert.match(workspace,
    /const check = checks\.find\(\(candidate\) => candidate\.id === item\.id\)/,
    "定位应读取当前批注的重锚定结果");
  assert.match(workspace, /const range = resolvedAnnotationRange\(item, check\)/,
    "定位应优先使用重锚定后的当前行号(区间解析统一走 annotateTargets)");
});

test("需求确认复用标准决定卡，并收成一个明确的通过按钮", () => {
  assert.match(taskCard,
    /requirementAnalysisConfirmation[^]*<section className=\{\`decision-card/,
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
