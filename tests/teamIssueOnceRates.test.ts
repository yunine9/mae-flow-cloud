/**
 * 一次率二轴统计的前端契约(#290 票4,口径:CONTEXT「一次修复成功率」
 * 「一次定位成功率」词条)。纯文本源码锚点(同 teamDomainNav/
 * issueUiContracts 模式):钉三件事——两块统计格长在团队问题概览行、
 * hover 口径含拍板要素、数字只来自端点(前端零计算,拿不到显示 —)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const api = readFileSync(resolve("web/src/api.ts"), "utf-8");
const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");
const teamIssueWorld = readFileSync(
  resolve("web/src/TeamIssueWorld.tsx"), "utf-8");

test("api:一次率二轴走 /issues/stats,分母=完成交付,rate 可为 null", () => {
  assert.match(api, /export function getIssueOnceRates\(\): Promise<IssueOnceRate>/);
  assert.match(api, /return issueFetch\("\/issues\/stats"\);/);
  assert.match(api,
    /interface IssueOnceRate \{[\s\S]*?total: number;[\s\S]*?localization: \{ passed: number; rate: number \| null \};[\s\S]*?repair: \{ passed: number; rate: number \| null \};/);
});

test("App:一次率是独立旁栏路,失败保留上次结果并下传组件", () => {
  // 与检视/问题列表同一条 allSettled 容错纪律:统计拿不到不算同步中断。
  assert.match(app, /getIssueOnceRates\(\),/);
  assert.match(app,
    /if \(onceRatesResult\.status === "fulfilled"\) \{\n          setIssueOnceRates\(onceRatesResult\.value\);\n        \}/);
  assert.match(app,
    /<TeamIssueWorld issues=\{teamIssues\} onceRates=\{issueOnceRates\}/);
});

test("TeamIssueWorld:两块统计格在概览行,口径 tooltip 含拍板要素,前端零计算", () => {
  // 组件只渲染端点数字:rate=null(分母 0)或数据缺席都显示 —。
  assert.match(teamIssueWorld, /onceRates\?: IssueOnceRate;/);
  assert.match(teamIssueWorld,
    /const rateText = \(rate: number \| null \| undefined\): string =>\n    rate == null \? "—" : `\$\{rate\}%`;/);
  // 定位轴口径:分子/分母、版本事实、检视修改出版本。
  assert.match(teamIssueWorld, /一次定位 \$\{passed\} \/ 完成交付 \$\{onceRates\.total\}/);
  assert.match(teamIssueWorld, /分析报告只生成一版即一次定位/);
  assert.match(teamIssueWorld, /检视提出修改会生成新版本/);
  // 修复轴口径:验证未通过事实。
  assert.match(teamIssueWorld, /一次修复 \$\{passed\} \/ 完成交付 \$\{onceRates\.total\}/);
  assert.match(teamIssueWorld, /点过「验证发现问题」即非一次修复/);
  // 两块统计格与可及性描述都在概览指标行。
  assert.match(teamIssueWorld, /title=\{onceRateTitle\("localization"\)\}/);
  assert.match(teamIssueWorld, /title=\{onceRateTitle\("repair"\)\}/);
  assert.match(teamIssueWorld, /一次定位成功率<\/small>/);
  assert.match(teamIssueWorld, /一次修复成功率<\/small>/);
  // 旧单轴名字全链路退役。
  assert.doesNotMatch(teamIssueWorld, /一次通过率/);
  assert.doesNotMatch(app, /一次通过率|IssuePassRate|getIssuePassRate/);
  assert.doesNotMatch(api, /一次通过率|IssuePassRate|getIssuePassRate/);
});
