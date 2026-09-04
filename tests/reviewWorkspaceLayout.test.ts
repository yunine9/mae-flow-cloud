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

test("邀请 Committer 收进批注 Inspector 标题栏，不占用主导航", () => {
  const navigation = workspace.slice(
    workspace.indexOf('aria-label="任务工作台视图"'),
    workspace.indexOf('<div className={`ws-body'),
  );
  assert.match(navigation, /ws-review-launch/);
  assert.doesNotMatch(navigation, /邀请检视/,
    "低频邀请动作不应和当前、产物、活动争抢一级空间");
  assert.match(workspace, /className="workspace-invite-dialog" role="dialog"/);
  assert.match(workspace, /<UserPicker ariaLabel="选择 Committer"/);
  assert.match(workspace, /reviewBusy \? "发送中…" : "发送邀请"/);
  assert.match(workspace,
    /className="workspace-review-invite-button"[\s\S]*邀请检视/);
  assert.match(css, /\.workspace-invite-dialog\s*\{[^}]*width:\s*min\(460px, 100%\)/s);

  const reviewDialog = workspace.slice(
    workspace.indexOf('className="workspace-review-drawer"'),
    workspace.indexOf('{reviewInviteOpen &&'),
  );
  assert.match(reviewDialog, /workspace-review-invite-button/,
    "邀请属于检视上下文，应在 Inspector 内一步可达");
  assert.doesNotMatch(reviewDialog, /<UserPicker|发送邀请/,
    "选人表单仍应留在独立对话框，避免挤压意见正文");
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
