import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const css = readFileSync(join(process.cwd(), "web/src/style.css"), "utf8");
const workspace = readFileSync(
  join(process.cwd(), "web/src/TaskWorkspace.tsx"), "utf8");

test("长批注保持自然高度并由检视栏统一滚动", () => {
  const baseDrawer = css.indexOf(".ws-review-drawer-body {");
  const baseBody = css.slice(baseDrawer, baseDrawer + 500);
  assert.match(baseBody, /display:\s*flex/);
  assert.match(baseBody, /flex-direction:\s*column/);
  assert.match(css, /\.ws-review-drawer-body > \*\s*\{\s*flex:\s*none/,
    "长批注必须保持自然高度，不能被 Grid 压扁后裁掉");
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

test("邀请 Committer 收成标题小按钮并在弹窗中完成", () => {
  assert.match(workspace, /className="review-invite-trigger"/);
  assert.match(workspace, /＋ 邀请检视/);
  assert.match(workspace, /className="review-invite-dialog" role="dialog"/);
  assert.match(workspace, /aria-label="关闭邀请检视窗口"/);
  assert.doesNotMatch(workspace,
    /className="committer-review compact"/,
    "检视栏底部不应再堆整张邀请卡");
  assert.match(css, /\.review-invite-trigger\s*\{/);
  assert.match(css, /\.review-invite-backdrop\s*\{/);
});
