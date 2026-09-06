/**
 * CSS 叠层棘轮(纯文本扫描,不起 Vite)。
 *
 * 为什么要有:十天里 27 笔 fix 是"样式被别的文件压住了"——修法几乎都是再
 * 写一条更长的选择器或者加 !important,于是 16.8k 行 CSS 里覆盖式选择器
 * 只增不减,下一次改样式又踩到上一次的补丁。还没决定要不要引入 @layer
 * 之前,先把三个数钉住:只许降,不许升。要升必须来改这里的上限,并在
 * commit 里说清为什么这次非加不可。
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

const CEILING = {
  important: 55,
  studioOverride: 286,
  duplicateTopLevelClass: 23,
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
