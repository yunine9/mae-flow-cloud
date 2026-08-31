import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { Markdown } from "../web/src/markdown.tsx";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("Markdown 有序列表兼容混合文本换行，不因单个任务的脏正文炸掉整页", () => {
  const text = [
    "处理步骤：",
    "1. 第一项\r2. 裸 CR 后的第二项",
    "3) Unicode 行分隔\u20284) Unicode 段落分隔\u20295. 收尾",
  ].join("\n");

  const html = renderToStaticMarkup(
    React.createElement(Markdown, { text }),
  );

  assert.equal((html.match(/<li/g) ?? []).length, 5);
  for (const content of ["第一项", "裸 CR 后的第二项", "Unicode 行分隔", "Unicode 段落分隔", "收尾"]) {
    assert.match(html, new RegExp(content));
  }
});

test("Markdown 不把解析失败的疑似列表当成可强取分组的结果", () => {
  const html = renderToStaticMarkup(
    React.createElement(Markdown, { text: "1. 正常项\u2028不是列表的下一行" }),
  );

  assert.match(html, /<li[^>]*>正常项<\/li>/);
  assert.match(html, /<p[^>]*>不是列表的下一行<\/p>/);
});
