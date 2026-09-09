/**
 * Modal(通用弹层)的 node 冒烟:portal 会把开着的弹层送进 document.body,
 * SSR 渲染器不支持 portal——所以"开着的渲染"走无 portal 的 ModalSurface,
 * "关着返回 null"走完整 Modal。Esc/焦点困笼是客户端行为,没有 DOM 环境
 * 验证不了,与 RootErrorBoundary 的边界一样如实记在这里,别当它测过。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { Modal, ModalSurface } from "../web/src/ui/Modal.tsx";

// 根测试运行器按 classic JSX 装载 web 组件(rootErrorBoundary 用例同款)。
(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("Modal:关着的时候一个字都不渲染(open=false 返回 null)", () => {
  const html = renderToStaticMarkup(
    React.createElement(Modal, { open: false, onClose: () => {} }, "内容"));
  assert.equal(html, "");
});

test("ModalSurface:role/aria/背板结构与标题关联齐全", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModalSurface, {
      open: true, onClose: () => {}, labelledBy: "demo-title",
      width: "min(460px, 100%)",
    }, React.createElement("h2", { id: "demo-title" }, "演示标题")));
  assert.match(html, /ui-modal-backdrop/, "背板类要挂上(fixes 层的 ui.css 管样式)");
  assert.match(html, /ui-modal-dialog/, "弹层卡片类要挂上");
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-modal="true"/);
  assert.match(html, /aria-labelledby="demo-title"/, "标题关联要走 labelledBy");
  assert.match(html, /演示标题/, "children 原样进弹层");
  assert.match(html, /width:\s*min\(460px, 100%\)/, "宽度覆盖要生效");
});

test("ModalSurface:没有 labelledBy 时用 ariaLabel,宽度缺省不带 style", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModalSurface, {
      open: true, onClose: () => {}, ariaLabel: "移动到回收站",
    }, "确认内容"));
  assert.match(html, /aria-label="移动到回收站"/);
  assert.ok(!html.includes("aria-labelledby"), "没给 labelledBy 就别挂空关联");
  assert.ok(!html.includes("style"), "缺省宽度不该产出空 style 属性");
});
