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
const apiSource = readFileSync(resolve("web/src/api.ts"), "utf-8");

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

test("发起页只展示 Mae-Flow 平台管理的三类知识，不把仓库内容列成知识条目", () => {
  assert.match(source, /平台管理的本任务知识/);
  assert.match(source,
    /仅展示业务知识、工程知识与平台团队 Skill/);
  assert.match(source, /<header><strong>业务知识<\/strong>/);
  assert.match(source, /<header><strong>工程知识<\/strong>/);
  assert.match(source, /<header><strong>平台团队 Skill<\/strong>/);

  assert.match(source,
    /className="business-module-picker-note launch-knowledge-boundary-note"/);
  assert.match(source,
    /下单页只展示 Mae-Flow 平台管理的业务知识、工程知识和 Skill/);
  assert.match(source,
    /AGENTS\.md[\s\S]*仓内文档、项目规则[\s\S]*Agent 运行时自行读取[\s\S]*不在下单界面列出或包装成“本任务知识”/);
  assert.equal(source.match(/AGENTS\.md/g)?.length, 1,
    "AGENTS.md 只能出现在低强调边界说明中，不能成为清单项或独立卡片");
  assert.doesNotMatch(source, /仓库原生能力/);
  assert.doesNotMatch(source, /className="launch-git-context"/);
  assert.doesNotMatch(source, /RepositorySkillPicker/);

  const contractStart = apiSource.indexOf(
    "export interface LaunchKnowledgePreview {");
  const contractEnd = apiSource.indexOf("\n}\n\nexport async function", contractStart);
  assert.ok(contractStart >= 0 && contractEnd > contractStart,
    "找不到发起页知识预览契约");
  const contract = apiSource.slice(contractStart, contractEnd);
  assert.match(contract, /business_knowledge:/);
  assert.match(contract, /engineering_knowledge:/);
  assert.match(contract, /team_skills:/);
  assert.doesNotMatch(contract, /repository_skills|platform_capabilit/,
    "仓库原生 Skill 与运行时平台能力不能混入可见知识清单");

  // MFC-033 后仓库输入按 repo.enabled 裁字段:固定仓部署不许把草稿
  // 旧仓暗带进预览/提交。匹配条件语义不变,但表达式带了开关。
  assert.match(source, /repos: repoFieldsEnabled\s*\n?\s*\? repos\.map/,
    "仓库仍须保留为平台知识的匹配条件(按 repo.enabled 裁剪)");
  assert.match(source, /repositoryProfiles:/,
    "语言技术画像仍须保留为平台工程知识的匹配条件");
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
