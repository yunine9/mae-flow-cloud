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

test("Markdown 只渲染调用方明确解析过的需求图片路径", () => {
  const text = "前文\n\n![架构图](.mae-flow-work/requirement-assets/a.png)\n\n![外图](https://example.com/a.png)";
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    text,
    resolveImage: (path: string) => path.startsWith(".mae-flow-work/requirement-assets/")
      ? `/tasks/task-1/requirement-asset?path=${encodeURIComponent(path)}`
      : undefined,
  }));

  assert.match(html, /<img[^>]+alt="架构图"/);
  assert.match(html, /requirement-asset\?path=/);
  assert.doesNotMatch(html, /<img[^>]+example\.com/);
});

test("Markdown 表格每一行保留自己的原文行号供逐行批注", () => {
  const text = [
    "表格前文",
    "",
    "| 模块 | 责任人 |",
    "| --- | --- |",
    "| 过滤模块 | 张三 |",
    "| 通知模块 | 李四 |",
  ].join("\n");
  const html = renderToStaticMarkup(React.createElement(Markdown, { text }));

  assert.match(html, /<thead><tr data-l="3">/);
  assert.match(html, /<tbody><tr data-l="5">/);
  assert.match(html, /<tr data-l="6"><td>通知模块<\/td>/);
});
