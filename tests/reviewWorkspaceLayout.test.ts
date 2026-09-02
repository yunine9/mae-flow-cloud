import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const css = readFileSync(join(process.cwd(), "web/src/style.css"), "utf8");
const workspace = readFileSync(
  join(process.cwd(), "web/src/TaskWorkspace.tsx"), "utf8");
const userPicker = readFileSync(
  join(process.cwd(), "web/src/UserPicker.tsx"), "utf8");

test("长批注在右侧抽屉内滚动,不挤压主工作台", () => {
  // 2026-09-02 弹层改抽屉(用户定调易用性优先):滚动仍由抽屉内容区兜住。
  assert.match(workspace,
    /className="workspace-review-drawer"\s+role="complementary"/);
  assert.match(css, /\.workspace-review-drawer\s*\{[^}]*min-height:\s*0/s);
  assert.match(css, /\.workspace-review-drawer\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.workspace-review-content\s*\{[^}]*overflow:\s*auto/s,
    "长批注应由抽屉内容区统一滚动，不能挤压主工作台");
});

test("Markdown 全屏使用宽画布且图表优先缩放到一屏", () => {
  assert.match(css,
    /\.workspace-overlay\.materials-fullscreen \.ws-doc \.md\s*\{[^}]*width:\s*min\(1600px, 100%\)/s);
  assert.match(css,
    /\.workspace-overlay\.materials-fullscreen \.plantuml-figure,[^}]*overflow-x:\s*hidden/s);
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

test("邀请 Committer 是批注与检视旁的常驻协作入口", () => {
  const navigation = workspace.slice(
    workspace.indexOf('aria-label="任务工作台视图"'),
    workspace.indexOf('<div className={`ws-body'),
  );
  assert.match(navigation,
    /ws-review-launch[\s\S]*ws-review-invite-launch/,
    "邀请检视应紧挨批注与检视，而不是藏在意见弹层里");
  assert.match(navigation, /<strong><span aria-hidden>＋<\/span>邀请检视<\/strong>/);
  assert.match(workspace, /className="workspace-invite-dialog" role="dialog"/);
  assert.match(workspace, /<UserPicker ariaLabel="选择 Committer"/);
  assert.match(workspace, /reviewBusy \? "发送中…" : "发送邀请"/);
  assert.match(css, /\.ws-workspace-nav \.ws-review-invite-launch\s*\{/);
  assert.match(css, /\.workspace-invite-dialog\s*\{[^}]*width:\s*min\(460px, 100%\)/s);

  const reviewDialog = workspace.slice(
    workspace.indexOf('className="workspace-review-dialog"'),
    workspace.indexOf('{reviewInviteOpen &&'),
  );
  assert.doesNotMatch(reviewDialog, /选择 Committer|发送邀请/,
    "邀请动作不能继续占据检视意见弹层");
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
