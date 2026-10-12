import { after, test } from "node:test";
import assert from "node:assert/strict";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";

const vite = await createServer({ root: "web", server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
const { DomainKnowledgePathChange } = await vite.ssrLoadModule("/src/DomainKnowledgeExtraction.tsx");
after(() => vite.close());

function render(originalPath: string, proposedPath: string) {
  return renderToStaticMarkup(React.createElement(DomainKnowledgePathChange, { originalPath, proposedPath }));
}

test("领域知识改名建议完整展示原路径与建议路径，沿用现有处置流程", () => {
  const html = render("domains/order.md", "domains/order-rules.md");
  assert.match(html, /aria-label="文档路径修改建议"/);
  assert.match(html, /原路径：<code[^>]*>domains\/order\.md<\/code>/);
  assert.match(html, /→/);
  assert.match(html, /建议路径：<code[^>]*>domains\/order-rules\.md<\/code>/);
  assert.doesNotMatch(html, /<button|<input|<textarea/);
});

test("路径未变化时不增加修改提示", () => {
  assert.equal(render("domains/order.md", "domains/order.md"), "");
});

test("嵌套中文路径完整显示，路径字符作为文本安全呈现", () => {
  const html = render("domains/订单/历史/旧规则.md", "domains/订单/最新/规则与边界&例外<说明>.md");
  assert.match(html, /domains\/订单\/历史\/旧规则\.md/);
  assert.match(html, /domains\/订单\/最新\/规则与边界&amp;例外&lt;说明&gt;\.md/);
  assert.doesNotMatch(html, /line-clamp|展开|<说明>/);
});
