/**
 * 检视意见在"等决定卡"期间提交的真相(内网实锤 2026-09-04):点"提交给
 * Agent"只是登记成团队事实,正文要等责任人在卡上选返工才随决定送达。
 * 改法:决定人在抽屉里直接"提交并返工"一步到位;检视人排队,但状态和
 * 文案要说清"还没送到";卡上有未闭环意见时预选"需要调整"。静态契约。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf-8");

test("等决定期间的提交:决定人一步返工、检视人排队并说明、卡上预选返工", () => {
  const panel = read("web/src/AnnotationPanel.tsx");
  assert.match(panel, /const oneStepRework = queueable && !requirementReview && canDecide\s*&& !!reworkChoice;/,
    "只有决定人、且卡上有返工选项时才一步到位;需求确认卡另有机制");
  assert.match(panel, /oneStepRework \? `提交 \$\{drafts\.length\} 条并返工`/,
    "按钮说清按下去会返工");
  assert.match(panel, /await decide\(taskId, reworkChoice\.stateVersion,\s*\{ \[reworkChoice\.question\]: reworkChoice\.option \}/,
    "走 decide 而不是 send:和卡上手点返工同一条路");
  // 状态词已经收敛到服务端唯一判定处(feedbackPolicy),页面只渲染。
  assert.match(read("src/feedbackPolicy.ts"), /text: "已排队·等决定"/,
    "排队的意见不再冒充已提交");
  assert.match(panel, /排队，等责任人返工时送达/, "检视人的按钮说清要等责任人");
  const card = read("web/src/TaskCard.tsx");
  assert.match(card, /export function reworkChoiceOf/);
  assert.match(card, /const feedbackOption = reworkChoice\?\.option;/,
    "WaitingCard 与面板共用同一判据");
  // 卡上不预选返工:既有契约"意见未闭环只能阻止放行,不能替用户默认选择"。
  assert.doesNotMatch(card, /preselectRework/);
  const workspace = read("web/src/TaskWorkspace.tsx");
  assert.match(workspace, /reworkChoice=\{workspaceReworkChoice\}\s*canDecide=\{canOperate\}/,
    "工作台把当前卡的返工选项和决定权交给面板");
  // 服务端语义不变:等待期 send 仍只排队,决定时把排队的意见带上——这是
  // 一步到位能成立的前提。
  const service = read("src/taskService.ts");
  assert.match(service, /markSent\(\s*picked\.map\(\(item\) => item\.id\), "queued_decision", sentBy\)/);
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
