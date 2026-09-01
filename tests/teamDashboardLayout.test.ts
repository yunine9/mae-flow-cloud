import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const app = readFileSync(join(process.cwd(), "web/src/App.tsx"), "utf8");
const css = readFileSync(join(process.cwd(), "web/src/style.css"), "utf8");

test("团队任务统计先展示总览公式，再用阶段和状态拆同一批交付中任务", () => {
  assert.match(app, /function TeamDeliveryOverview/);
  assert.match(app, /任务总计/);
  assert.match(app, /已交付/);
  assert.match(app, /交付中/);
  assert.match(app, /按阶段/);
  assert.match(app, /按任务状态/);
  assert.equal((app.match(/合计 \{stats\.delivering\} 项/g) ?? []).length, 2,
    "阶段和状态必须明确显示同一个交付中合计");
  assert.match(css, /\.team-delivery-equation\s*\{/);
  assert.match(css, /\.team-delivery-breakdown\s*\{/);
  assert.match(css,
    /\.delivery-breakdown-cells\.status-cells\s*\{[^}]*display:\s*grid[^}]*repeat\(3,/s,
    "状态项应收进连续的 3×3 矩阵，不能堆成随意排列的白卡");
  assert.match(css,
    /\.delivery-breakdown-cells\.status-cells button\s*\{[^}]*border-radius:\s*0/s);
  assert.match(app, /const TEAM_STATUS_LABEL/);
  assert.match(css,
    /\.delivery-breakdown-cells\.status-cells button:disabled\s*\{[^}]*opacity:\s*1/s,
    "零状态数字也必须清晰可读，不能沿用半透明禁用态");
  assert.match(css,
    /\.delivery-breakdown-cells\.status-cells button:not\(:disabled\),[^}]*background:\s*var\(--accent\)/s,
    "有任务的状态应使用实色强调，不能浅底叠浅字");
});
