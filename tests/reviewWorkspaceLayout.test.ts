import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const css = readFileSync(join(process.cwd(), "web/src/style.css"), "utf8");
const workspace = readFileSync(
  join(process.cwd(), "web/src/TaskWorkspace.tsx"), "utf8");
const userPicker = readFileSync(
  join(process.cwd(), "web/src/UserPicker.tsx"), "utf8");
const reviewPane = readFileSync(
  join(process.cwd(), "web/src/ResizableReviewPane.tsx"), "utf8");

test("内容页签与阅读检视工具是独立区域，检视仍随时可开关", () => {
  const tabsStart = workspace.indexOf('className="ws-source-switch" role="tablist"');
  const toolsStart = workspace.indexOf('className="ws-material-tools"');
  assert.ok(tabsStart > 0 && toolsStart > tabsStart);
  const tabs = workspace.slice(tabsStart, toolsStart);
  assert.doesNotMatch(tabs, /ws-review-launch|materials-fullscreen-toggle|material-search-toggle/);
  const tools = workspace.slice(toolsStart, workspace.indexOf('<div className="ws-material-stage"'));
  assert.match(tools, /aria-label="检视意见" aria-expanded=\{reviewPanelOpen\}/);
  assert.match(tools, /setReviewPanelOpen\(\(open\) => !open\)/);
  assert.match(tools, /materials-fullscreen-toggle/);
});

test("长批注在工作区侧栏滚动，材料持续挂载可见", () => {
  const studio = readFileSync(join(process.cwd(), "web/src/workspace-studio.css"), "utf8");
  // 检视画布已抽成 ResizableReviewPane(可拖宽),类名与滚动语义随组件走。
  assert.match(workspace, /<ResizableReviewPane open=\{reviewPanelOpen\}>/);
  assert.match(reviewPane, /className="ws-review-canvas"/);
  assert.match(workspace, /className="ws-material-stage"/);
  assert.match(workspace, /className="ws-material-content">/);
  assert.match(studio, /\.ws-review-canvas \{[^}]*overflow: auto/s);
});

test("嵌入工作台的文件树和代码变更各自独立滚动", () => {
  const studio = readFileSync(join(process.cwd(), "web/src/workspace-studio.css"), "utf8");
  assert.match(studio,
    /\.workspace-studio\.task-workspace-v2 \.ws-doc\.is-diff\s*\{[^}]*display:\s*flex[^}]*overflow:\s*hidden/s);
  assert.match(studio,
    /\.workspace-studio :where\(\.ws-doc\.is-diff > \.annotatable\)\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s,
    "高度链使用低权重选择器，不再增加工作台覆盖债务");
  assert.match(studio,
    /\.workspace-studio \.is-embedded \.git-change-browser\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
  assert.match(studio,
    /\.workspace-studio \.is-embedded \.change-files\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s,
    "左侧文件树应拥有自己的纵向滚动区域");
  assert.match(studio,
    /\.workspace-studio \.is-embedded \.change-file-detail\s*\{[^}]*display:\s*flex[^}]*overflow:\s*hidden/s);
  assert.match(studio,
    /\.workspace-studio \.is-embedded \.diff-review\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*overflow:\s*auto/s,
    "右侧代码区应独立滚动，不再带动文件树");
});

test("Markdown 全屏使用宽画布，PlantUML 保留独立滚动视口", () => {
  assert.match(css,
    /\.workspace-overlay\.materials-fullscreen \.ws-doc \.md\s*\{[^}]*width:\s*min\(1600px, 100%\)/s);
  assert.doesNotMatch(css,
    /\.plantuml-figure[^{}]*\{[^}]*overflow-x:\s*hidden/s);
  assert.match(css, /\.plantuml-viewport\s*\{[^}]*overflow:\s*auto/s);
  assert.match(css,
    /\.workspace-overlay\.materials-fullscreen \.puml-diagram,[^}]*width:\s*100%[^}]*max-width:\s*100%/s);
  assert.match(css,
    /\.issue-thread\.issue-doc\.is-fullscreen \.issue-doc-body\s*\{[^}]*max-width:\s*1760px/s);
});

test("快速提问题常驻右下角且使用横向小按钮", () => {
  const trigger = css.indexOf(".wish-quick-trigger {");
  assert.ok(trigger >= 0);
  const rule = css.slice(trigger, trigger + 700);
  assert.match(rule, /right:\s*18px;/);
  assert.match(rule, /bottom:\s*18px;/);
  assert.match(rule, /top:\s*auto;/);
  assert.match(rule, /display:\s*inline-flex;/);
  assert.match(rule, /border-radius:\s*999px;/);
  assert.match(css, /\.wish-quick-trigger strong[^}]*writing-mode:\s*horizontal-tb;/s);
});

test("邀请他人检视在任务头独立可见，不依赖打开批注面板", () => {
  const controls = workspace.slice(workspace.indexOf('className="ws-head-controls"'),
    workspace.indexOf('{task.feedback_error &&'));
  assert.match(controls, /canRequestReview && task\.status !== "canceled" && <button/,
    "邀请入口只对有权限者可见,且已取消任务不再提供");
  assert.match(controls, /workspace-review-invite-button/);
  assert.match(controls, /aria-haspopup="dialog" aria-expanded=\{reviewInviteOpen\}/);
  assert.match(controls, /setReviewInviteOpen\(true\)/);
  assert.doesNotMatch(controls, /reviewPanelOpen/);
  const panel = workspace.slice(workspace.indexOf('className="ws-review-canvas"'),
    workspace.indexOf('<div className="ws-material-content"'));
  assert.doesNotMatch(panel, /workspace-review-invite-button/);
  assert.match(workspace, /className="workspace-invite-dialog" role="dialog"/);
  assert.match(workspace, /<UserPicker ariaLabel="选择 Committer"/);
  assert.match(workspace, /reviewBusy \? "发送中…" : "发送邀请"/);
});

test("人员下拉保持紧凑并原位展开，不遮住邀请和交付信息", () => {
  assert.match(userPicker, /const searchable = options\.length > 6/,
    "成员很少时不应再用搜索框占掉一整行");
  assert.match(css,
    /\.user-picker-options\s*\{[^}]*max-height:\s*min\(176px, 32vh\)/s);
  assert.match(css,
    /\.workspace-review-invite-action \.user-picker-popover,[\s\S]*?\.repository-assignee-editable \.user-picker-popover\s*\{[^}]*position:\s*static/s,
    "当前选人场景应由名单撑开当前区域，而不是悬浮遮挡下面的信息");
  assert.match(css,
    /\.workspace-review-invite-action\s*\{[^}]*grid-template-columns:\s*minmax\(180px, 260px\) auto/s,
    "Committer 选择框不应横向吞满整个邀请弹层");
});

test("检视意见使用整幅宽画布，人的意见与 Agent 回应横向对应", () => {
  assert.match(workspace, /className="workspace-review-notes"/);
  assert.match(workspace, /className="workspace-review-opinions"/);
  assert.match(css, /\.workspace-review-notes\s*\{[^}]*width:\s*min\(1220px, 100%\)/s);
  const annotate = readFileSync(join(process.cwd(), "web/src/annotate.css"), "utf8");
  assert.match(annotate,
    /\.workspace-review-notes \.annot-item:has\(\.annot-response\)[^{]*\{[^}]*grid-template-columns:/s);
});

test("交付失败长文本在右侧行动栏内换行，不横向冲出工作台", () => {
  assert.match(workspace, /className="ws-verify-focus-waiting"/);
  assert.match(css,
    /\.ws-verify-focus\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*calc\(100% - 28px\)/s);
  assert.match(css,
    /\.ws-verify-focus p\s*\{[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/s,
    "远端 Hook 正则、commit SHA 和英文错误都必须在卡片内断行");
});
