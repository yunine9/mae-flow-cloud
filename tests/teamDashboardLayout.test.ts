import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const app = readFileSync(join(process.cwd(), "web/src/App.tsx"), "utf8");
const css = readFileSync(join(process.cwd(), "web/src/style.css"), "utf8");

test("团队任务统计以紧凑摘要展示规模，并用轻量筛选拆分交付中任务", () => {
  assert.match(app, /function TeamDeliveryOverview/);
  assert.match(app, /全部任务/);
  assert.match(app, /已交付/);
  assert.match(app, /交付中/);
  assert.match(app, />阶段</);
  assert.match(app, />任务状态</);
  assert.match(css, /\.team-delivery-summary\s*\{/);
  assert.match(css, /\.team-delivery-breakdown\s*\{/);
  assert.match(css,
    /\.delivery-breakdown-cells\s*\{[^}]*display:\s*grid[^}]*repeat\(auto-fit,/s,
    "阶段和状态应共用可自适应的紧凑筛选网格");
  assert.match(css,
    /\.delivery-breakdown-cells button\s*\{[^}]*min-height:\s*38px[^}]*border-radius:\s*8px/s);
  assert.match(app, /teamDeliveryStatusGroup\(task\.status\)/);
  assert.match(css,
    /\.delivery-breakdown-cells button:disabled\s*\{[^}]*opacity:\s*\.56/s,
    "零状态要保留口径，但应从视觉层级中退后");
  assert.match(css,
    /\.delivery-breakdown-cells button\.selected\s*\{[^}]*background:\s*var\(--accent-soft\)/s,
    "只有当前筛选项使用强调色，不能把所有非零项都铺成实色块");
  assert.match(css,
    /\.team-delivery-summary \.summary-complete strong\s*\{[^}]*var\(--success\)/s,
    "已交付只用语义色点到为止，不再重复堆卡片");
});
