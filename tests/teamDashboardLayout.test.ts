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
    /\.delivery-breakdown-cells\.status-cells\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s,
    "状态项应是紧凑换行块，不能被单项拉成长条");
  assert.match(css,
    /\.delivery-breakdown-cells\.status-cells button\s*\{[^}]*max-width:\s*210px/s);
});
