import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve("web/src/LaunchWorkspace.tsx"), "utf-8");
const css = readFileSync(resolve("web/src/style.css"), "utf-8");
const appSource = readFileSync(resolve("web/src/App.tsx"), "utf-8");
const businessSource = readFileSync(
  resolve("web/src/BusinessModuleLibrary.tsx"), "utf-8");
const pickerSource = readFileSync(
  resolve("web/src/RepositoryTechnologyPicker.tsx"), "utf-8");

test("自动匹配知识必须展示逐项清单和匹配依据，不能退回只显示数量", () => {
  const start = source.indexOf(
    '<section className="launch-form-section launch-task-resources">');
  const end = source.indexOf("</details>}", start);
  assert.ok(start >= 0 && end > start, "找不到发起页知识区");
  const section = source.slice(start, end);

  assert.match(section, /matchingModuleKnowledge\.map/);
  assert.match(section, /matchingEngineeringKnowledge\.map/);
  assert.match(section, /matchingTeamSkills\.map/);
  assert.match(source, /命中依据/);
  assert.match(source, /查看全文/);
  assert.doesNotMatch(section, /type="checkbox"/,
    "知识名单只用于核对，不能偷偷恢复手工勾选");
});

test("知识多时清单内部滚动，不把发起页无限撑长", () => {
  assert.match(css,
    /\.launch-knowledge-list \{[\s\S]*?max-height: 410px;[\s\S]*?overflow: auto;/);
});

test("清单行是真实深链，创建时绑定权威指纹且变化后强制刷新", () => {
  assert.match(source, /<a className="launch-knowledge-row" href=\{href\}/);
  assert.match(source, /href=\{knowledgeAssetPath\(/);
  assert.match(source,
    /knowledgePreviewDigest: knowledgePreview\?\.selection_digest/);
  assert.match(source,
    /setKnowledgePreviewKey\(""\)[\s\S]*setKnowledgePreviewRefresh/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /setTimeout\([\s\S]*getLaunchKnowledgePreview/);
});

test("查看全文前保存技术画像草稿，返回根路径恢复来源视图", () => {
  assert.match(source, /repositoryTechnologies\?: RepositoryTechnologyDraft\[\]/);
  assert.match(source,
    /repositoryTechnologies: repositoryTechnologies\.map/);
  assert.match(pickerSource,
    /草稿代表“本单已经采用”的选择[\s\S]*if \(current\) return/);
  assert.match(appSource,
    /history\.replaceState\(appHistoryState\(view/);
  assert.match(appSource,
    /const restoredView = viewFromHistoryState\(event\.state\)/);
  assert.match(appSource,
    /history\.pushState\(appHistoryState\("knowledge", "workflows"\), "", "\/"\)/);
  assert.match(appSource,
    /else if \(\/\^\\\/help[\s\S]*history\.pushState\(appHistoryState\(next/,
    "从帮助页进入根视图也必须记录目标，前进不能掉回角色默认页");
});

test("历史全文使用响应版本元数据，帮助返回保留团队资产页签", () => {
  assert.match(businessSource,
    /title: value\.asset\.title, content: value\.content/,
    "历史正文不能套用当前目录行的标题");
  assert.match(businessSource,
    /value\.asset\.digest !== expected\.digest[\s\S]*value\.asset\.version !== expected\.version/,
    "正文、版本和发布指纹必须同时对拍");
  assert.match(appSource,
    /if \(next === "help"\)[\s\S]*history\.replaceState\(appHistoryState\(view,[\s\S]*history\.pushState\(appHistoryState\("help"\)/,
    "进入帮助前必须把来源视图写回当前历史项");
  assert.match(appSource,
    /if \(!knowledgeFocus\)[\s\S]*history\.replaceState\(appHistoryState\("knowledge", next\)/,
    "根路径切换团队资产页签也要更新可恢复状态");
});
