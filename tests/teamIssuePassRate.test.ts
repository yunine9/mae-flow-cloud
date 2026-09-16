/**
 * 一次通过率统计的前端契约(spec #274,口径:CONTEXT「一次通过率」
 * 词条)。纯文本源码锚点(同 teamDomainNav/issueUiContracts 模式):
 * 钉三件事——统计格长在团队问题概览行、hover 口径含拍板要素、数字只
 * 来自端点(前端零计算,拿不到显示 —)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const api = readFileSync(resolve("web/src/api.ts"), "utf-8");
const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");
const teamIssueWorld = readFileSync(
  resolve("web/src/TeamIssueWorld.tsx"), "utf-8");

test("api:一次通过率走 /issues/stats,rate 可为 null(分母 0)", () => {
  assert.match(api, /export function getIssuePassRate\(\): Promise<IssuePassRate>/);
  assert.match(api, /return issueFetch\("\/issues\/stats"\);/);
  assert.match(api,
    /interface IssuePassRate \{[\s\S]*?passed: number;[\s\S]*?total: number;[\s\S]*?rate: number \| null;/);
});

test("App:一次通过率是独立旁栏路,失败保留上次结果并下传组件", () => {
  // 与检视/问题列表同一条 allSettled 容错纪律:统计拿不到不算同步中断。
  assert.match(app, /getIssuePassRate\(\),/);
  assert.match(app,
    /if \(passRateResult\.status === "fulfilled"\) \{\n          setIssuePassRate\(passRateResult\.value\);\n        \}/);
  assert.match(app,
    /<TeamIssueWorld issues=\{teamIssues\} passRate=\{issuePassRate\}/);
});

test("TeamIssueWorld:统计格在概览行,口径 tooltip 含拍板要素,前端零计算", () => {
  // 组件只渲染端点数字:rate=null(分母 0)或数据缺席都显示 —。
  assert.match(teamIssueWorld, /passRate\?: IssuePassRate;/);
  assert.match(teamIssueWorld,
    /const passRateText = passRate\?\.rate == null \? "—" : `\$\{passRate\.rate\}%`;/);
  // 口径一句话钉拍板要素:分子/分母、验证未过/取消/失败、检视不算、
  // 无单与进行中不参与。
  assert.match(teamIssueWorld, /一次通过 \$\{passRate\.passed\} \/ 有单终态 \$\{passRate\.total\}/);
  assert.match(teamIssueWorld, /验证卡答过「验证发现问题」、取消或失败的会话不算一次通过/);
  assert.match(teamIssueWorld, /检视回退不影响/);
  assert.match(teamIssueWorld, /无单与进行中会话不参与统计/);
  assert.match(teamIssueWorld, /title=\{passRateTitle\}/);
  // 统计格标签与可及性描述都在概览指标行。
  assert.match(teamIssueWorld, /一次通过率<\/small>/);
  assert.match(teamIssueWorld, /一次通过率 \$\{passRateText\}/);
});
