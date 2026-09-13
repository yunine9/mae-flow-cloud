/**
 * tailwind.css 结构完整性棘轮(2026-09-13 视觉修复事故后立):
 * #233 归并时丢过一个收括号,@media (prefers-reduced-motion) 把
 * 3,270 行存量皮吞进「仅在减弱动效时生效」的分支——构建零报错、
 * 普通用户整站裸奔,靠截图审计才炸出来。本测试钉两条不变量:
 * 1. 全文件花括号配平,且扫描深度永不为负(吞段必现负深度或残留);
 * 2. 一组「已知活」选择器必须出现在顶层(depth=0)——被 media/layer
 *    吞掉时它们的深度必 >0。选择器随重构演进要同票维护(锚点纪律)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cssPath = join(import.meta.dirname, "..", "web", "src", "tailwind.css");
const css = readFileSync(cssPath, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, ""); // 先剥注释,防注释里的花括号干扰

const SMOKE_SELECTORS = [
  ".ws-head", // 工作台头部布局(SessionView/工作台在用)
  ".ws-progress", // 相位轨
  ".task-overview", // 团队任务队列行
  ".module-location-retry", // 架构图引用卡重试钮(#233 事故点位)
  ".md-architecture-reference", // Markdown 架构引用卡
];

test("tailwind.css:花括号全文件配平且深度不为负", () => {
  let depth = 0;
  let line = 1;
  for (const ch of css) {
    if (ch === "\n") line += 1;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      assert.ok(depth >= 0,
        `tailwind.css:${line} 出现多余的 }\n(历史事故:#233 归并丢括号,3,270 行皮肤被吞进媒体查询)`);
    }
  }
  assert.equal(depth, 0, `tailwind.css 花括号不配平,缺 ${depth} 个 }(扫到文件尾)`);
});

test("tailwind.css:已知活选择器必须在顶层(depth=0),不许被媒体查询/层吞掉", () => {
  const depthAt = (index: number): number => {
    let depth = 0;
    for (let i = 0; i < index; i += 1) {
      if (css[i] === "{") depth += 1;
      if (css[i] === "}") depth -= 1;
    }
    return depth;
  };
  for (const selector of SMOKE_SELECTORS) {
    const index = css.indexOf(selector);
    assert.ok(index >= 0, `活选择器 ${selector} 不在 tailwind.css 里了——若为有意删除,同票更新本测试的 SMOKE_SELECTORS`);
    assert.equal(depthAt(index), 0,
      `${selector} 出现在 depth>0 的作用域里(被 @media/@layer 吞掉?)——历史事故形态,见 tailwind.css 头部注释`);
  }
});
