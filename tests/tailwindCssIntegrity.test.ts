/**
 * tailwind.css 结构完整性棘轮(2026-09-13 视觉修复事故后立):
 * #233 归并时丢过一个收括号,@media (prefers-reduced-motion) 把
 * 3,270 行存量皮(task-workspace-v2/conversation/task-overview 等)
 * 吞进「仅在减弱动效时生效」的分支——构建零报错、普通用户整站裸奔,
 * 靠真机截图审计才炸出来。本测试钉两条不变量:
 * 1. 全文件花括号配平,且扫描深度永不为负;
 * 2. 一组「已知活」选择器必须至少出现一次在**非 @media 作用域**——
 *    @layer legacy 包裹是合法的(utilities 恒压 legacy 是分层本意),
 *    被 @media 独占才是事故形态。选择器随重构演进同票维护(锚点纪律)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = join(here, "..", "web", "src", "tailwind.css");
const css = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const SMOKE_SELECTORS = [
  ".ws-head", // 工作台头部布局(SessionView/工作台在用)
  ".ws-progress", // 相位轨
  ".task-overview", // 团队任务队列行
  ".module-location-retry", // 架构图引用卡重试钮(#233 事故点位)
  ".md-architecture-reference", // Markdown 架构引用卡
];

type BlockKind = "media" | "layer" | "other-at" | "plain";

/** 扫描全文件:每个字符下标 → 是否处于任一 @media 块内 + 括号深度。 */
function scan(): { inMedia: boolean[]; depths: number[] } {
  const inMedia: boolean[] = new Array(css.length).fill(false);
  const depths: number[] = new Array(css.length).fill(0);
  const stack: BlockKind[] = [];
  let prelude = ""; // 自上一个 { 或 } 以来的文本,{ 前按它分块
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === "{") {
      const trimmed = prelude.trim();
      const kind: BlockKind = trimmed.startsWith("@media") ? "media"
        : trimmed.startsWith("@layer") ? "layer"
        : trimmed.startsWith("@") ? "other-at"
        : "plain";
      stack.push(kind);
      prelude = "";
    } else if (ch === "}") {
      stack.pop();
      prelude = "";
    } else {
      prelude += ch;
    }
    inMedia[i] = stack.includes("media");
    depths[i] = stack.length;
  }
  return { inMedia, depths };
}

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

test("tailwind.css:已知活选择器必须至少一次活在非 @media 作用域", () => {
  const { inMedia } = scan();
  for (const selector of SMOKE_SELECTORS) {
    const positions: number[] = [];
    let from = 0;
    for (;;) {
      const index = css.indexOf(selector, from);
      if (index < 0) break;
      positions.push(index);
      from = index + 1;
    }
    assert.ok(positions.length > 0,
      `活选择器 ${selector} 不在 tailwind.css 里了——若为有意删除,同票更新本测试的 SMOKE_SELECTORS`);
    assert.ok(
      positions.some((index) => !inMedia[index]),
      `${selector} 只出现在 @media 作用域里(基础皮被媒体查询吞掉?)——历史事故形态,见本文件头注释`,
    );
  }
});
