import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "web/src/style.css"), "utf8");
const workspace = readFileSync(
  join(process.cwd(), "web/src/TaskWorkspace.tsx"), "utf8");
const taskCard = readFileSync(
  join(process.cwd(), "web/src/TaskCard.tsx"), "utf8");

test("决策背景展开后由外层真实占位，不能与后续问题重叠", () => {
  const legacyWorkspaceRule = css.indexOf(".ws-decision .waiting-context {");
  const layoutOverride = css.lastIndexOf(".ws-decision .waiting-context {");
  assert.ok(legacyWorkspaceRule >= 0, "应覆盖工作台原有的决策背景规则");
  assert.ok(layoutOverride > legacyWorkspaceRule,
    "解除高度上限的规则必须位于旧工作台规则之后，才能赢得层叠");

  const overrideBody = css.slice(layoutOverride, layoutOverride + 120);
  assert.match(overrideBody, /max-height:\s*none/);
  assert.match(overrideBody, /overflow:\s*visible/);
});

test("长检视内容在独立弹层内滚动，不挤压材料和决定栏", () => {
  assert.match(workspace, /className="workspace-review-dialog" role="dialog"/);
  assert.match(css, /\.workspace-review-dialog\s*\{[^}]*max-height:/s);
  assert.match(css, /\.workspace-review-dialog\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.workspace-review-content\s*\{[^}]*overflow:\s*auto/s);
});

test("交付材料提供统一全屏入口且 Escape 先退出全屏", () => {
  assert.match(workspace, /materialsFullscreen/);
  assert.match(workspace, /全屏查看/);
  assert.match(workspace, /退出全屏/);
  assert.match(workspace,
    /if \(materialsFullscreen\) setMaterialsFullscreen\(false\)/);
  assert.match(css, /\.workspace-overlay\.materials-fullscreen \.ws-decision/);
  assert.match(css, /grid-template-columns:\s*minmax\(0, 1fr\)/);
});

test("待闭环检视通过常驻按钮提示，但不自动接管当前工作面", () => {
  assert.match(workspace, /pendingWorkspaceReviewIds/);
  assert.match(workspace, /className=\{`ws-review-launch/);
  assert.match(workspace, /\$\{reviewActionCount\} 待处理/);
  assert.match(workspace, /onClick=\{\(\) => setReviewPanelOpen\(true\)\}/);
  assert.doesNotMatch(workspace, /openedReviewAttention|previousReviewActionCount/,
    "批注出现时只亮入口，不应自动弹出并抢走当前任务");
});

test("批注弹层与 Agent 决定卡互不接管，也绝不自动代选", () => {
  assert.match(workspace, /waiting && canOperate && \(/,
    "Grill、方案确认和 push 确认都必须持续渲染决定卡");
  assert.doesNotMatch(workspace, /finalDecisionDeferred|reviewTakesFocus/,
    "打开批注不能卸载或改写当前决定卡");
  assert.match(workspace, /aria-label="关闭批注与检视"/);
  assert.match(workspace, /if \(reviewPanelOpen\) setReviewPanelOpen\(false\)/,
    "Escape 应先关闭批注弹层，再退出整个工作台");
  assert.doesNotMatch(taskCard, /setPicked\(\(current\) =>[\s\S]{0,900}feedbackAnswers/,
    "意见未闭环只能阻止放行，不能替用户默认选择返工或确认推送");
});

test("旧代码锚点消失时在材料侧给出明确反馈", () => {
  assert.match(workspace, /check\?\.state === "gone"/);
  assert.match(workspace, /批注位置已变化/);
  assert.match(workspace, /已不在当前版本/);
  assert.match(css, /\.annotation-location-notice\s*\{/);
});

test("批注弹层关闭后回到原工作位置", () => {
  assert.match(workspace, /关闭后回到原工作位置/);
  assert.match(workspace, /if \(event\.target === event\.currentTarget\) setReviewPanelOpen\(false\)/);
  assert.doesNotMatch(workspace, /setWorkspaceView\("insights"\)/,
    "打开弹层不能改掉交付材料、开发协作或执行现场的当前页签");
});

test("进度词表只在内核一份,前端不再自带阶段名;反馈按来源逐条展示", () => {
  // 原来前端有三套阶段字面量(协调中、持续检视、无内核兜底),与内核看板
  // 各说各话,老任务停在哪套显示哪套。现在一律吃任务 API 的 progress。
  assert.doesNotMatch(workspace,
    /\["配置与需求", "方案", "开发", "持续检视", "已合入"\]/);
  assert.doesNotMatch(workspace, /"已受理", "需求理解"/);
  assert.match(workspace, /current_phase: "尚未进入阶段"/);
  assert.match(workspace, /function FeedbackPanel/);
  assert.match(workspace, /FEEDBACK_SOURCE_LABEL/);
  assert.match(workspace, /item\.summary/,
    "界面必须展示反馈正文，不能只给数量");
  assert.match(workspace, /FEEDBACK_STATUS_LABEL/);
});

test("持续检视意见:进度条下只报数,正文按来源竖排列进批注与检视", () => {
  // 原来所有意见塞在进度条下横向滚动的小卡片里(9–11px、单行省略),MR
  // 检视人一段话被压成一行,用户实锤"排版太丑",并要求在批注与检视里
  // 给 CodeHub 检视意见一个列表。摘要只报数;列表和批注卡片同版式。
  assert.match(workspace, /function FeedbackSummary/);
  assert.match(workspace, /<FeedbackSummary feedback=\{task\.feedback\}/);
  assert.match(workspace, /onOpenReview=\{\(\) => setReviewPanelOpen\(true\)\}/,
    "摘要要能直接打开批注与检视");
  assert.match(workspace, /function FeedbackList/);
  assert.match(workspace, /title="来自 CodeHub 的检视意见"/);
  assert.match(workspace, /item\.source === "mr_discussion"\)/);
  assert.match(workspace, /mrUrl=\{task\.delivery\?\.mr_url\}/,
    "CodeHub 意见列表要给回到 MR 的入口");
  assert.match(workspace, /title="流水线与机器检视"/);
  assert.match(workspace, /item\.source !== "mr_discussion" && item\.source !== "workspace"/,
    "工作台批注已由批注卡片承载,不重复列");
  assert.match(workspace, /已回复，等检视人确认/);
  assert.match(workspace, /检视人 \$\{item\.author\}/);
  assert.match(workspace, /className="feedback-body"/);
  assert.match(css, /\.feedback-summary\s*\{/);
  assert.match(css, /\.feedback-list\s*\{/);
  assert.match(css, /\.feedback-body\s*\{[^}]*white-space:\s*pre-wrap/,
    "意见正文原样换行,不再单行省略");
  assert.doesNotMatch(css, /\.feedback-groups\s*\{/,
    "横向卡片墙已删,不许悄悄回来");
});

test("批注与检视弹层里的批注面板默认展开", () => {
  // 弹层是人主动点开的,正文再折叠一层等于让人点两次(用户实锤)。
  const panel = readFileSync(
    join(process.cwd(), "web/src/AnnotationPanel.tsx"), "utf8");
  assert.match(panel, /const \[open, setOpen\] = useState\(true\)/);
  assert.doesNotMatch(panel, /useState\(drafts\.length > 0/);
  // Agent 对批注的回应也是多行正文,换行要保住(用户实锤"只显示一行")。
  const annotateCss = readFileSync(
    join(process.cwd(), "web/src/annotate.css"), "utf8");
  assert.match(annotateCss,
    /\.annot-response p \{[^}]*white-space:\s*pre-wrap/);
});

test("执行中的任务默认打开执行现场", () => {
  assert.match(workspace,
    /\["queued", "running", "pausing", "verifying", "await_merge"\]/);
  assert.match(workspace, /\.includes\(task\.status\)\) return "execution"/);
});
