/**
 * 检视意见在"等决定卡"期间提交的真相(内网实锤 2026-09-04):点"提交给
 * Agent"只是登记成团队事实,正文要等责任人在卡上选返工才随决定送达。
 * 改法:抽屉只登记待送意见，决定卡是唯一送达口；第一条意见入队时
 * 卡上预选"需要调整"，责任人仍可改选。静态契约。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf-8");

test("等决定期间的提交:抽屉登记，决定卡统一送达并预选返工", () => {
  const panel = read("web/src/AnnotationPanel.tsx");
  assert.doesNotMatch(panel, /oneStepRework|await decide\(/,
    "抽屉不应再绕过当前决定卡自己代答");
  // 状态词已经收敛到服务端唯一判定处(feedbackPolicy),页面只渲染。
  assert.match(read("src/feedbackPolicy.ts"), /text: "已排队·等决定"/,
    "排队的意见不再冒充已提交");
  assert.match(panel, /排队，等责任人返工时送达/, "检视人的按钮说清要等责任人");
  const card = read("web/src/TaskCard.tsx");
  assert.match(card, /export function reworkChoiceOf/);
  assert.match(card, /const feedbackOption = reworkChoice\?\.option;/,
    "WaitingCard 与面板共用同一判据");
  assert.match(card, /const queuedKey = queuedAnnotationIds\.join\("\\0"\)/);
  assert.match(card, /setPicked\(current => Object\.values\(current\)\.some\(Boolean\) \? current/,
    "只在用户还没做选择时预选返工，不覆盖人的决定");
  const workspace = read("web/src/TaskWorkspace.tsx");
  assert.match(workspace, /queuedAnnotationIds=\{queuedIds\}/,
    "工作台要把已入队意见交给当前决定卡");
  assert.match(workspace, /pendingReviewAnnotationIds=\{pendingReviewIds\}/,
    "决定卡要展示本次会一并送达的意见");
  // 服务端语义不变:等待期 send 仍只排队,决定时把排队的意见带上——这是
  // 一步到位能成立的前提。
  const service = read("src/taskService.ts");
  assert.match(service, /markSentFor\(\s*picked, "queued_decision", sentBy\)/);
  // 回执登记前不再写"已提交/已被改动·请你确认":那时确认按钮根本不在。
  // 这些状态词现在只有服务端一份(feedbackPolicy),页面照抄。
  const policy = read("src/feedbackPolicy.ts");
  assert.match(policy, /text: viaRepair \? "等待 Agent 回执" : "已交给 Agent"/,
    "没回执时统一等回执,原文在不在只进提示不当进度");
  assert.doesNotMatch(policy, /text: "Agent 已改动这处/);
  assert.match(policy, /text: `Agent 回执：\$\{outcome\}·等复检`/,
    "有回执按回执结论显示");
  assert.match(service, /const reviewNode = await this\.workspaceReviewNodeAnswer\(task\);/,
    "修复轮中途举卡先读回执并由平台过内部节点");
  assert.match(policy, /text: "已被改动·等作者确认"/,
    "到点了但不是作者:说清裁决权在谁");
  assert.doesNotMatch(policy, /text: "已被改动·请你确认"/);
  // 收敛的硬约束:状态词只有服务端一份,页面里不许再出现。
  assert.doesNotMatch(panel, /"待你确认"|"等待 Agent 回执"|"已交给 Agent"/,
    "状态词只有服务端一份,页面不许再拼");
  assert.match(service, /pushConfirmCard \|\| item\.sent_via !== "review_repair"\)/,
    "修复轮意见只在最终推送卡上拦关闭");
  assert.match(service, /item\.status === "sent" && item\.sent_via === "queued_decision"/);
});
