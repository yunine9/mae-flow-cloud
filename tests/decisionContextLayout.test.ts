import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "web/src/style.css"), "utf8");
const workspace = readFileSync(
  join(process.cwd(), "web/src/TaskWorkspace.tsx"), "utf8");

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

test("桌面态长检视清单形成独立滚动区", () => {
  const desktopRule = css.lastIndexOf("@media (min-width: 901px)");
  assert.ok(desktopRule >= 0, "长检视清单应有桌面态高度约束");
  const body = css.slice(desktopRule, desktopRule + 850);
  assert.match(body, /\.ws-decision\.review-mode\s*\{\s*overflow:\s*hidden/);
  assert.match(body, /\.ws-decision\.review-mode \.ws-review-drawer\.open\s*\{\s*overflow:\s*hidden/);
  assert.match(body, /\.ws-decision\.review-mode \.ws-review-drawer-body\s*\{/);
  assert.match(body, /height:\s*0/);
  assert.match(body, /flex:\s*1 1 0/);
  assert.match(body, /overflow-y:\s*auto/);
  assert.match(body, /scrollbar-gutter:\s*stable/);
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

test("待闭环检视清单不是可随意折叠的展示盒", () => {
  assert.match(workspace, /pendingWorkspaceReviewIds/);
  assert.match(workspace, /reviewActionCount > 0 \? \(/);
  assert.match(workspace,
    /className="ws-review-drawer-toggle is-locked" role="status"/);
  assert.match(workspace, /previousReviewActionCount\.current > 0/);
  assert.match(workspace, /setReviewPanelOpen\(false\)/);
  assert.match(workspace, /<strong>检视记录<\/strong>/);
});

test("检视栏支持拖拽、键盘微调和双击复位", () => {
  assert.match(workspace, /aria-label="调整检视栏宽度"/);
  assert.match(workspace, /onPointerMove/);
  assert.match(workspace, /onDoubleClick=\{resetReviewPanelWidth\}/);
  assert.match(workspace, /event\.key === "ArrowLeft"/);
  assert.match(workspace, /mae-flow:review-panel-width/);
  assert.match(css, /\.ws-review-resizer\s*\{/);
  assert.match(css, /cursor:\s*col-resize/);
});

test("持续检视固定高层进度并按来源展示每条反馈", () => {
  assert.match(workspace,
    /\["配置与需求", "方案", "开发", "持续检视", "已合入"\]/);
  assert.match(workspace, /function FeedbackPanel/);
  assert.match(workspace, /FEEDBACK_SOURCE_LABEL/);
  assert.match(workspace, /item\.summary/,
    "界面必须展示反馈正文，不能只给数量");
  assert.match(workspace, /FEEDBACK_STATUS_LABEL/);
  assert.match(css, /\.feedback-groups\s*\{/);
  assert.match(css, /overflow-x:\s*auto/,
    "来源多时应横向收纳，不把页面纵向铺成卡片墙");
});

test("执行中的任务默认打开执行现场", () => {
  assert.match(workspace,
    /\["queued", "running", "pausing", "verifying", "await_merge"\]/);
  assert.match(workspace, /\.includes\(task\.status\)\) return "execution"/);
});
