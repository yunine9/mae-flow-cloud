import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve("web/src/LaunchWorkspace.tsx"), "utf-8");
const css = readFileSync(resolve("web/src/style.css"), "utf-8");

test("自动匹配知识必须展示逐项清单和匹配依据，不能退回只显示数量", () => {
  const start = source.indexOf(
    '<section className="launch-form-section launch-task-resources">');
  const end = source.indexOf("</details>}", start);
  assert.ok(start >= 0 && end > start, "找不到发起页知识区");
  const section = source.slice(start, end);

  assert.match(section, /matchingModuleKnowledge\.map/);
  assert.match(section, /matchingEngineeringKnowledge\.map/);
  assert.match(section, /matchingTeamSkills\.map/);
  assert.match(source, /匹配依据/);
  assert.doesNotMatch(section, /type="checkbox"/,
    "知识名单只用于核对，不能偷偷恢复手工勾选");
});

test("知识多时清单内部滚动，不把发起页无限撑长", () => {
  assert.match(css,
    /\.launch-knowledge-list \{[\s\S]*?max-height: 410px;[\s\S]*?overflow: auto;/);
});
