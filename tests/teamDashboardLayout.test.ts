import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const app = readFileSync(join(process.cwd(), "web/src/App.tsx"), "utf8");
const css = readFileSync(join(process.cwd(), "web/src/style.css"), "utf8");

test("团队任务统计先展示总览公式，再用阶段和状态拆同一批交付中任务", () => {
  assert.match(app, /function TeamDeliveryOverview/);
  // 总览公式(2026-09-01 同步后文案):一行 aria-label 读出
  // 全部任务 = 交付中 + 已交付,三数同源 stats。
  assert.match(app,
    /全部任务 \$\{stats\.total\} 项，交付中 \$\{stats\.delivering\} 项，已交付 \$\{stats\.delivered\} 项/);
  assert.match(app, /已交付/);
  assert.match(app, /交付中/);
  // 阶段与状态两个拆解都在,各自渲染同一批交付中任务的分组计数。
  assert.match(app, /id="delivery-stage-title"/);
  assert.match(app, /id="delivery-status-title"/);
  assert.match(app, /stats\.stages\.map/);
  assert.match(app, /stats\.statuses\.map/);
  assert.match(css, /\.team-delivery-breakdown\s*\{/);
});
