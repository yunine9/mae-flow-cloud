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

test("CHAIN 的共同修订标记参与摘要但不显示给检视人", () => {
  const html = renderToStaticMarkup(React.createElement(Markdown, {
    text: "<!-- mae-flow-plan-revision: r2 -->\n# 模块拆分方案\n正文",
  }));
  assert.doesNotMatch(html, /mae-flow-plan-revision/);
  assert.match(html, /<div class="md-heading md-h1" data-l="2">模块拆分方案<\/div>/);
  assert.match(html, />正文</);
});


test("代码块和引用内部原文行可定位；表格头部优先定位到行而非整表", () => {
  const text = "```ts\nconst a = 1;\nconst b = 2;\n```\n> 第一行\n> 第二行\n\n    代码甲\n    代码乙";
  const html = renderToStaticMarkup(React.createElement(Markdown, { text }));
  assert.match(html, /class="md-block-code" data-l="1" data-line-end="4"/);
  assert.match(html, /class="md-block-code" data-l="8" data-line-end="9"/);
  assert.match(html, /class="md-p" data-l="6">第二行/);
});

test("Story 图源收起仍保留源码行号与原文，标题不执行 HTML", () => {
  const source = JSON.stringify({ diagram_type: "architecture", meta: { title: "<script>图标题</script>" } });
  const text = `前文\n\`\`\`archify\n${source}\n\`\`\`\n后文`;
  const html = renderToStaticMarkup(React.createElement(Markdown, { text, onOpenArchitecture: () => {} }));
  assert.match(html, /class="md-architecture-reference" data-l="2" data-line-end="4"/);
  assert.match(html, /<details><summary>技术信息（排障）<\/summary>/);
  assert.match(html, /title="在当前任务的架构图页签中打开这张图"/);
  assert.match(html, /打开大图 ↗<\/button>/);
  assert.match(html, /查看这个模块包含什么、依赖谁，以及它们如何连接。/);
  assert.match(html, /&lt;script&gt;图标题&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /data-l="5">后文/);
  const malformed = renderToStaticMarkup(React.createElement(Markdown, { text: "```archify\n{broken\n```" }));
  assert.match(malformed, /\{broken/);
  assert.doesNotMatch(malformed, /查看架构图<\/button>/);
});

test("Story 架构入口用业务语言解释常见图，不把图名直接甩给用户", () => {
  const render = (title: string) => renderToStaticMarkup(React.createElement(Markdown, {
    text: `\`\`\`archify\n${JSON.stringify({ meta: { title } })}\n\`\`\``,
    onOpenArchitecture: () => {},
  }));
  assert.match(render("存储事务互斥时序"), /并发操作如何避免互相覆盖/);
  assert.match(render("订单领域类图"), /核心对象各自负责什么/);
  assert.match(render("订单服务部署图"), /服务运行在哪里/);
});
