import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve("web/src/HelpCenter.tsx"), "utf-8");
const appSource = readFileSync(resolve("web/src/App.tsx"), "utf-8");
const markdownSource = readFileSync(resolve("web/src/markdown.tsx"), "utf-8");
const cssSource = readFileSync(resolve("web/src/help.css"), "utf-8");

test("使用帮助覆盖所有主功能，文章 id 和截图地址不会互相打架", () => {
  const ids = [...source.matchAll(/^\s{4}id: "([a-z-]+)",$/gm)]
    .map((match) => match[1]);
  assert.ok(ids.length >= 12);
  assert.equal(new Set(ids).size, ids.length);
  for (const group of ["快速开始", "需求与问题", "团队协作", "团队资产", "设置与排障"]) {
    assert.match(source, new RegExp(`group: "${group}"`));
  }
  const screenshots = [...source.matchAll(/src: `\$\{SHOT_ROOT\}\/([^`]+\.png)`/g)]
    .map((match) => match[1]);
  assert.equal(screenshots.length, 13);
  assert.equal(new Set(screenshots).size, screenshots.length);
  for (const screenshot of screenshots) assert.match(screenshot, /^\d{2}-[a-z-]+\.png$/);
});

test("帮助文章能搜动作和提示，不要求用户记住内部功能名", () => {
  for (const phrase of ["/mfc", "编译超时", "自动匹配", "自由回复", "PlantUML"]) {
    assert.ok(source.includes(phrase), `缺少用户会直接搜索的词：${phrase}`);
  }
  assert.match(source, /article\.title, article\.summary, article\.group, article\.body/);
  assert.match(source, /article\.steps\.flatMap/);
});

test("角色保护覆盖目录、直链、快捷卡和相关推荐", () => {
  assert.match(source, /filterVisibleHelpItems\(HELP_ARTICLES, audience\)/);
  assert.match(source,
    /findHelpArticle\(initialArticleId, viewer\.role\)/);
  assert.match(source,
    /QUICK_LINKS\.filter\([\s\S]*canViewHelpItem\(target, viewer\.role\)/);
  assert.match(source,
    /visibleHelpItemsById\(\s*HELP_ARTICLES, article\.related \?\? \[\], viewer\.role\)/);
});

test("外部路径变化会同步文章，点击文章会留下可前进后退的历史", () => {
  assert.match(source,
    /useEffect\(\(\) => \{[\s\S]*findHelpArticle\(initialArticleId, viewer\.role\)[\s\S]*setSelectedId\(next\.id\)[\s\S]*\}, \[initialArticleId, viewer\.role\]\)/);
  assert.match(appSource,
    /onArticleChange=\{\(articleId\) => \{[\s\S]*history\.pushState\(\{\}, "", `\/help\/\$\{encodeURIComponent\(articleId\)\}`\)/);
});

test("帮助说大白话，重点色只使用蓝绿红三种固定意思", () => {
  assert.match(source, /\{\{blue\|/);
  assert.match(source, /\{\{green\|/);
  assert.match(source, /\{\{red\|/);
  assert.match(markdownSource, /blue\|green\|red/);
  assert.doesNotMatch(source,
    /\b(?:revision|copied_from|Playbook|snapshot)\b|轻量索引|人工节点|生命周期|深链/);
});

test("真实截图可用键盘打开，并能通过关闭按钮、背景和 Esc 退出", () => {
  assert.match(source,
    /className="help-shot-frame"[\s\S]*onClick=\{\(\) => setExpanded\(true\)\}[\s\S]*aria-label=\{`放大查看：/);
  assert.match(source,
    /className="help-lightbox" role="dialog" aria-modal="true"/);
  assert.match(source, /aria-label="关闭图片预览"/);
  assert.match(source,
    /if \(event\.target === event\.currentTarget\) setExpanded\(false\)/);
  assert.match(source,
    /event\.key === "Escape"[\s\S]*setExpanded\(false\)/);
  assert.match(source, /closeButtonRef\.current\?\.focus\(\)/);
  assert.match(source, /openButtonRef\.current\?\.focus\(\)/);
});

test("截图预览锁住背景且限制在视口内，加载失败不留下破图", () => {
  assert.match(source, /document\.body\.style\.overflow = "hidden"/);
  assert.match(source,
    /function hideOnError\(\) \{[\s\S]*setExpanded\(false\);[\s\S]*setFailed\(true\)/);
  assert.equal((source.match(/onError=\{hideOnError\}/g) ?? []).length, 2);
  assert.match(cssSource,
    /\.help-lightbox-backdrop \{[\s\S]*max-width: 100vw;[\s\S]*height: 100dvh;[\s\S]*overflow: hidden;/);
  assert.match(cssSource,
    /\.help-lightbox-image img \{[\s\S]*width: 100%;[\s\S]*max-width: 100%;[\s\S]*height: 100%;[\s\S]*max-height: 100%;[\s\S]*object-fit: contain;/);
});
