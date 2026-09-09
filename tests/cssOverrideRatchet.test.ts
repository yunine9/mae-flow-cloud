/**
 * CSS 叠层棘轮(纯文本扫描,不起 Vite)。
 *
 * 为什么要有:十天里 27 笔 fix 是"样式被别的文件压住了"——修法几乎都是再
 * 写一条更长的选择器或者加 !important,于是 16.8k 行 CSS 里覆盖式选择器
 * 只增不减,下一次改样式又踩到上一次的补丁。三个数钉住:只许降,不许升。
 * 要升必须来改这里的上限,并在 commit 里说清为什么这次非加不可。
 * 2026-09-06 起叠层有了正式出口(见文末用例):覆盖写进 @layer fixes,
 * 无条件赢——再往上限里加数就没有借口了。
 *
 * 数字是 2026-09-06 main@338d662 的实测。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("../web/src/", import.meta.url).pathname;
const files = readdirSync(dir).filter((name) => name.endsWith(".css"));
const css = Object.fromEntries(files.map((name) => [name, readFileSync(join(dir, name), "utf-8")]));

// 2026-09-06 晚拧到当前实测值(删死 CSS 后):要升必须来改这里并说清为什么。
const CEILING = {
  important: 55,
  studioOverride: 285,
  duplicateTopLevelClass: 23,
  // 组件统一化(2026-09-08)的三根新钉: primitives(ui.css + <Modal>)
  // 落地后,存量页面逐页迁移时这三个数只许降——
  // accentRecipe:css 里 --accent-fg 的引用数(主色按钮配方按容器复制
  //   的代理指标,recipe 归一到 .ui-btn 后应持续下降);
  // zIndexLiteral:z-index 字面量的去重个数(手搓弹层各养各的层级,
  //   新弹层一律取 tokens 的层叠阶梯,var() 引用不算字面量);
  // fixedOverlay:position: fixed 的规则数(手搓 backdrop/overlay 的
  //   代理指标,迁 <Modal> 后应减少)。
  // 数字是 2026-09-08 main@0c10f9a 工作区的实测。
  accentRecipe: 37,
  zIndexLiteral: 25,
  fixedOverlay: 18,
};

test("CSS 棘轮:!important 只许减少", () => {
  const count = Object.values(css).reduce((sum, text) => sum + (text.match(/!important/g) ?? []).length, 0);
  assert.ok(count <= CEILING.important,
    `!important 从 ${CEILING.important} 涨到 ${count};先看能不能靠调整叠层顺序解决`);
});

test("CSS 棘轮:.workspace-studio.task-workspace-v2 压制选择器只许减少", () => {
  const count = Object.values(css).reduce((sum, text) =>
    sum + (text.match(/\.workspace-studio\.task-workspace-v2/g) ?? []).length, 0);
  assert.ok(count <= CEILING.studioOverride,
    `(0,4,0) 压制选择器从 ${CEILING.studioOverride} 涨到 ${count};这是叠层顺序问题的症状,不是修法`);
});

test("CSS 棘轮:同名顶层类规则跨文件重复只许减少", () => {
  const seen = new Map<string, Set<string>>();
  for (const [name, text] of Object.entries(css)) {
    for (const match of text.matchAll(/^\.([a-zA-Z0-9_-]+)\s*\{/gm)) {
      const set = seen.get(match[1]) ?? new Set<string>();
      set.add(name);
      seen.set(match[1], set);
    }
  }
  const duplicated = [...seen.entries()].filter(([, owners]) => owners.size > 1);
  assert.ok(duplicated.length <= CEILING.duplicateTopLevelClass,
    `跨文件重复定义的顶层类从 ${CEILING.duplicateTopLevelClass} 涨到 ${duplicated.length}:`
    + duplicated.slice(0, 8).map(([cls, owners]) => `.${cls}(${[...owners].join(",")})`).join(" "));
});

test("CSS 棘轮:accent 按钮配方引用只许减少(归一到 .ui-btn)", () => {
  const count = Object.values(css).reduce((sum, text) =>
    sum + (text.match(/--accent-fg/g) ?? []).length, 0);
  assert.ok(count <= CEILING.accentRecipe,
    `--accent-fg 引用从 ${CEILING.accentRecipe} 涨到 ${count};`
    + "新按钮一律 .ui-btn(ui.css),别再按容器复制主色配方");
});

test("CSS 棘轮:z-index 字面量去重个数只许减少(新弹层取 tokens 层叠阶梯)", () => {
  const values = new Set<string>();
  for (const text of Object.values(css)) {
    for (const match of text.matchAll(/z-index:\s*([^;}\n]+)/g)) {
      const value = match[1].trim();
      if (!value.startsWith("var(")) values.add(value);
    }
  }
  assert.ok(values.size <= CEILING.zIndexLiteral,
    `z-index 字面量去重从 ${CEILING.zIndexLiteral} 涨到 ${values.size}:`
    + `新弹层的层级一律用 var(--z-*)(${[...values].slice(0, 8).join(",")}…)`);
});

test("CSS 棘轮:fixed 弹层规则只许减少(手搓 backdrop 迁 <Modal>)", () => {
  const count = Object.values(css).reduce((sum, text) =>
    sum + (text.match(/position: fixed/g) ?? []).length, 0);
  assert.ok(count <= CEILING.fixedOverlay,
    `position: fixed 规则从 ${CEILING.fixedOverlay} 涨到 ${count};`
    + "新的表单/面板弹层用 <Modal>,别再手搓 backdrop");
});

test("CSS 叠层:现有样式全在 legacy 一层,覆盖只走 fixes 层,不再新开层", () => {
  // 2026-09-06 决定:按文件分层被五档宽度截图裁判(scripts/visual-scenes.ts)
  // 否掉——480 张里 209 张变了,后面文件里被长选择器压住的规则一夜全赢,那是
  // 没人审过的改版。现有样式整体进 legacy 一层(与不分层逐像素一致);以后
  // 的覆盖写进 `@layer fixes { … }`,无条件赢,不用再堆长选择器或 !important。
  const declarations = Object.values(css)
    .flatMap((text) => text.match(/^@layer [^{;]+;$/gm) ?? []);
  assert.deepEqual(declarations, ["@layer legacy, fixes;"],
    "层顺序只在 tokens.css 声明一次,且只有 legacy、fixes 两层");
  for (const [name, text] of Object.entries(css)) {
    const body = text.replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^@layer [^{;]+;$/m, "").trim();
    assert.ok(body.startsWith("@layer legacy {"),
      `${name} 的样式必须整体包在 @layer legacy { … } 里(新文件也一样)`);
    assert.ok(body.endsWith("}"), `${name} 的 legacy 层没有闭合`);
    const layers = [...text.matchAll(/@layer\s+([a-zA-Z-]+)\s*\{/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(layers)].filter((layer) => layer !== "legacy" && layer !== "fixes"), [],
      `${name} 用了未登记的层;要新开层先过一遍截图裁判再来改这里`);
  }
});
