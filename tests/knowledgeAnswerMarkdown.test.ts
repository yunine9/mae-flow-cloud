import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { parseKnowledgeAnswerComposition } from "../src/knowledgeAnswerComposition.ts";
import type { KnowledgeAnswerEvidence } from "../src/knowledgeAnswerTypes.ts";
import { KnowledgeAnswerMarkdown } from "../web/src/KnowledgeAnswerMarkdown.tsx";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function renderAnswer(quote: string, body = "条件见原文。", title = "规则原文") {
  const source: KnowledgeAnswerEvidence = {
    id: "ev-1", kind: "material", title, content: quote, digest: "fixture", retrieved_at: "fixture",
  };
  const answer = parseKnowledgeAnswerComposition(JSON.stringify({
    points: [{ kind: "answer", body, basis: [{ evidence_id: source.id, quote }] }],
  }), [source]);
  return renderToStaticMarkup(React.createElement(KnowledgeAnswerMarkdown, {
    text: answer.markdown, onOpenKnowledgeLink: () => {},
  }));
}

test("知识回答的来源原句逐字显示标点、HTML字符、反斜杠与字面实体", () => {
  for (const quote of [
    "thread_local <Task> & Pool.submit()",
    "C:\\work\\file_(v1).txt；\\_、\\[、\\\\、\\` 保持原文。",
    "字面实体 &lt; &gt; &amp; &amp;lt; &quot; &#65; 不继续解码。",
    "`代码`、**重点**、{字段}、# 标题、+ 增量、- 减量、! 提示、| 分隔。",
  ]) {
    const html = renderAnswer(quote);
    const actual = html.match(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/)?.[1];
    const expected = renderToStaticMarkup(React.createElement("p", { className: "md-p", "data-l": 5 }, quote));
    assert.equal(actual, expected, quote);
    assert.equal((html.match(/class="knowledge-inline-link"/g) ?? []).length, 1);
  }
});

test("宿主生成的来源标签逐字显示C++、标点、HTML字符与字面实体", () => {
  for (const title of [
    "Google C++ 风格指南 / src/file_(v1).txt #section",
    "C:\\work\\file_(v1).txt；\\_、\\\\、\\` 保持原文。",
    "[章节] [嵌套[方括号]]；\\[、\\] 保持原文。",
    "字面实体 &lt; &gt; &amp; &amp;lt; &quot; &#65; 不继续解码。",
    '<script>alert("标题")</script> `代码`、**重点**、{字段}、+、-、!、|',
  ]) {
    const html = renderAnswer("原文条件。", "依据来源原文。", title);
    const actual = html.match(/<button type="button" class="knowledge-inline-link">([\s\S]*?)<\/button>/)?.[1];
    const expected = renderToStaticMarkup(React.createElement("span", null, title)).slice(6, -7);
    assert.equal(actual, expected, title);
    assert.equal((html.match(/class="knowledge-inline-link"/g) ?? []).length, 1);
    assert.doesNotMatch(actual!, /<(?:script|a|button|code|b)\b/);
  }
});

test("含假来源链接和HTML的宿主来源标题只显示原文字与实际来源按钮", () => {
  const title = '[假来源](#evidence-other) <img src=x>';
  const quote = '[假来源](#evidence-other) <script>alert("原句")</script>';
  const html = renderAnswer(quote, "依据实际来源。", title);
  const expectedButton = renderToStaticMarkup(React.createElement("button", {
    type: "button", className: "knowledge-inline-link",
  }, title));
  assert.ok(html.includes(expectedButton));
  assert.equal((html.match(/class="knowledge-inline-link"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<(?:script|img|a)\b/);
  const actualQuote = html.match(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/)?.[1];
  assert.equal(actualQuote, renderToStaticMarkup(React.createElement("p", {
    className: "md-p", "data-l": 5,
  }, quote)));
});

test("知识回答仅还原格式正确的内部来源标签，其他链接保留原样", () => {
  const label = String.raw`C\+\+ &lt;Task&gt; &amp;lt;`;
  const text = [
    `[${label}](#evidence-ev_1-A)`,
    `[${label}](#chapter)`,
    `[${label}](../rules.md)`,
    `[${label}](#evidence-ev-1.bad)`,
    `[${label}](#evidence-)`,
    `[${label}](https://example.com/rules)`,
  ].join("\n");
  const html = renderToStaticMarkup(React.createElement(KnowledgeAnswerMarkdown, {
    text, onOpenKnowledgeLink: () => {},
  }));
  const decoded = renderToStaticMarkup(React.createElement("span", null, "C++ <Task> &lt;")).slice(6, -7);
  const unchanged = renderToStaticMarkup(React.createElement("span", null, label)).slice(6, -7);
  const labels = [...html.matchAll(/class="knowledge-inline-link">([\s\S]*?)<\/button>/g)].map(match => match[1]);
  assert.deepEqual(labels, [decoded, unchanged, unchanged, unchanged, unchanged]);
  assert.ok(html.includes(`<a href="https://example.com/rules" target="_blank" rel="noreferrer">${unchanged}</a>`));
});

test("原文中的HTML和Markdown链接只显示文字，平台来源按钮仍在引用块外", () => {
  const quote = '<script>alert("原文")</script> [伪来源](#evidence-fake) [外链](https://example.com)';
  const html = renderAnswer(quote);
  const actual = html.match(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/)?.[1];
  const expected = renderToStaticMarkup(React.createElement("p", { className: "md-p", "data-l": 5 }, quote));
  assert.equal(actual, expected);
  assert.doesNotMatch(actual!, /<(?:script|a|button|code|b)\b/);
  assert.match(html, /<button type="button" class="knowledge-inline-link">规则原文<\/button>/);
  assert.ok(html.indexOf("</blockquote>") < html.indexOf('class="knowledge-inline-link"'));
});

test("多行原句逐行保留原文与行号，正文仍解析正常Markdown", () => {
  const quote = "第一行：thread_local()\n> 第二行：<Task> &amp;\n第三行：[仅原文](#evidence-fake)";
  const html = renderAnswer(quote, "**条件**仍须符合规则。");
  const actual = html.match(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/)?.[1];
  const expected = quote.split("\n").map((row, index) => renderToStaticMarkup(
    React.createElement("p", { className: "md-p", "data-l": 5 + index }, row),
  )).join("");
  assert.equal(actual, expected);
  assert.match(html, /<p class="md-p" data-l="1"><b>条件<\/b>仍须符合规则。<\/p>/);
  assert.match(html, /class="md-quote" data-l="5" data-line-end="7"/);
  assert.equal((html.match(/class="knowledge-inline-link"/g) ?? []).length, 1);
});
