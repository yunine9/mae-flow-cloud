import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const css = readFileSync(join(process.cwd(), "web/src/style.css"), "utf8");
const workspace = readFileSync(
  join(process.cwd(), "web/src/TaskWorkspace.tsx"), "utf8");

test("长批注在独立检视弹层内滚动", () => {
  assert.match(workspace, /className="workspace-review-dialog" role="dialog"/);
  assert.match(css, /\.workspace-review-dialog\s*\{[^}]*max-height:/s);
  assert.match(css, /\.workspace-review-dialog\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.workspace-review-content\s*\{[^}]*overflow:\s*auto/s,
    "长批注应由弹层内容区统一滚动，不能挤压主工作台");
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
  assert.match(css, /\.workspace-invite-dialog\s*\{[^}]*width:\s*min\(520px, 100%\)/s);

  const reviewDialog = workspace.slice(
    workspace.indexOf('className="workspace-review-dialog"'),
    workspace.indexOf('{reviewInviteOpen &&'),
  );
  assert.doesNotMatch(reviewDialog, /选择 Committer|发送邀请/,
    "邀请动作不能继续占据检视意见弹层");
});

test("检视意见使用整幅宽画布，人的意见与 Agent 回应横向对应", () => {
  assert.match(workspace, /className="workspace-review-notes"/);
  assert.match(workspace, /className="workspace-review-opinions"/);
  assert.match(css, /\.workspace-review-notes\s*\{[^}]*width:\s*min\(1220px, 100%\)/s);
  const annotate = readFileSync(join(process.cwd(), "web/src/annotate.css"), "utf8");
  assert.match(annotate,
    /\.workspace-review-notes \.annot-item:has\(\.annot-response\)[^{]*\{[^}]*grid-template-columns:/s);
});
