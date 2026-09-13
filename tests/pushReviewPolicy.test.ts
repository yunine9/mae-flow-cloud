import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pushReviewCallId,
  pushReviewReceiptCovers,
} from "../src/pushReviewPolicy.ts";

test("push 确认保留文件范围，不因 SHA 变化作废", () => {
  const receipt = {
    status: "confirmed" as const,
    head: "head-a",
    paths: ["src/a.ts"],
  };
  assert.equal(pushReviewReceiptCovers(receipt, {
    head: "head-a", paths: ["src/a.ts"],
  }), true);
  assert.equal(pushReviewReceiptCovers(receipt, {
    head: "head-b", paths: ["src/a.ts"],
  }), true, "同一批文件的新提交沿用确认");
  assert.equal(pushReviewReceiptCovers(receipt, {
    head: "head-a", paths: ["src/a.ts", "src/b.ts"],
  }), false);
  assert.equal(pushReviewReceiptCovers({ ...receipt, status: "requested" }, {
    head: "head-a", paths: ["src/a.ts"],
  }), false);
});

test("同范围的卡键不因 HEAD 换卡，明确返工才开新轮", () => {
  const snapshot = { head: "head-a", paths: ["src/a.ts"] };
  assert.equal(pushReviewCallId(snapshot), pushReviewCallId(snapshot));
  assert.equal(pushReviewCallId(snapshot), pushReviewCallId({
    ...snapshot, head: "head-b",
  }));
  assert.notEqual(pushReviewCallId(snapshot, "round-1"),
    pushReviewCallId(snapshot, "round-2"));
});

// ── 2026-09-06 绞杀第三块:push 前确认与交付范围的决策表 ──────────────
import {
  deliveryScopeViolations, describeDirtyPaths, listedPaths, pathWithinScope,
  pushReviewPolicyFor, pushWaitingDetail, recardDetail, scopeDeltaLine,
  scopeViolationDetail, selectionPushDecision,
} from "../src/pushReviewPolicy.ts";

const policyInput = {
  reviewSource: undefined, workspaceRecheckRequired: undefined,
  unresolvedAnnotations: 0, taskSetting: undefined,
  accountDefault: () => undefined, hasSelection: false,
} as const;

test("要不要人过目:三个来源任一成立;任务级设置压过个人默认,且在时不查个人默认", () => {
  assert.equal(pushReviewPolicyFor({ ...policyInput }).required, false);
  assert.deepEqual(pushReviewPolicyFor({ ...policyInput, hasSelection: true }), {
    required: true, ordinaryReviewEnabled: true, recheckRequired: false, hasHumanFeedback: false,
  }, "没有任何设置但已有交付清单:维持保守复检");
  assert.equal(pushReviewPolicyFor({ ...policyInput, accountDefault: () => true }).ordinaryReviewEnabled, true);
  let asked = 0;
  const p = pushReviewPolicyFor({ ...policyInput, taskSetting: false,
    accountDefault: () => { asked += 1; return true; }, hasSelection: true });
  assert.equal(p.ordinaryReviewEnabled, false, "任务级关掉就是关掉");
  assert.equal(asked, 0, "任务级设置在时不查个人默认(保住原来的短路)");
  assert.equal(pushReviewPolicyFor({ ...policyInput, taskSetting: false, unresolvedAnnotations: 2 }).required, true,
    "未闭环人工意见是安全例外,全自动吞不掉");
  const recheck = pushReviewPolicyFor({ ...policyInput, taskSetting: false,
    reviewSource: "workspace", workspaceRecheckRequired: true });
  assert.equal(recheck.recheckRequired, true);
  assert.equal(pushReviewPolicyFor({ ...policyInput, reviewSource: "platform", workspaceRecheckRequired: true }).recheckRequired,
    false, "只有工作台意见返工才算复检");
});

test("到了推送点:精确授权放行；同范围依既定设置续推，不依赖独立编译收据", () => {
  const off = () => ({ required: false, ordinaryReviewEnabled: false, recheckRequired: false, hasHumanFeedback: false });
  const on = () => ({ required: true, ordinaryReviewEnabled: true, recheckRequired: false, hasHumanFeedback: false });
  const base = {
    selectionStatus: "confirmed", selectionHead: "h1", expected: ["a.ts", "b.ts"], current: ["a.ts", "b.ts"],
    head: "h1", policy: on,
  };
  assert.deepEqual(selectionPushDecision(base), { kind: "allow" }, "同 HEAD 同集合的确认收据:幂等放行");
  let policyAsked = 0;
  selectionPushDecision({ ...base, policy: () => { policyAsked += 1; return on(); } });
  assert.equal(policyAsked, 0, "精确收据放行时不算策略(原来也不读批注)");
  assert.deepEqual(selectionPushDecision({ ...base, head: "h2", policy: off }),
    { kind: "allow" },
    "同范围沿用真实确认，不把编译收据当授权，也不伪报编译通过");
  const grown = selectionPushDecision({ ...base, head: "h2", current: ["a.ts", "b.ts", "c.ts"], policy: off });
  assert.deepEqual(grown, { kind: "recard", reason: "新增了未确认文件 c.ts" }, "范围变了:全自动也必须出卡,月光不能代答");
  assert.deepEqual(selectionPushDecision({ ...base, head: "h2", current: ["a.ts"], policy: off }),
    { kind: "recard", reason: "已确认文件不再提交 b.ts" });
  assert.deepEqual(selectionPushDecision({ ...base, selectionStatus: "requested", head: "h2" }),
    { kind: "recard", reason: "交付文件清单已整理完成，等待确认当前改动" });
  assert.deepEqual(selectionPushDecision({ ...base, head: "h2" }),
    { kind: "allow" }, "常规过目开着也不因新 SHA 重问");
  assert.match(recardDetail("x"), /^需要核对交付范围：x。.*不用重跑任务。$/);
});

test("给人看的话:范围变化一行、等待文案、脏路径与越界清单的截断", () => {
  assert.equal(scopeDeltaLine(undefined, ["a"]), undefined, "第一次确认没有'上次'");
  assert.equal(scopeDeltaLine(["a", "b"], ["a", "b"]), undefined, "范围没变不说");
  assert.equal(scopeDeltaLine(["a", "b"], ["a", "c"]),
    "**文件范围变化：新增 c;移除 b;其余 1 个文件与上次确认一致,可只检视变化部分。**");
  assert.equal(pushWaitingDetail(false, 3), "等待确认最终交付范围");
  assert.equal(pushWaitingDetail(true, 2), "等待 2 条检视意见由提出人确认");
  assert.equal(pushWaitingDetail(true, 0), "检视意见已闭环，等待责任人确认推送");
  assert.equal(describeDirtyPaths(["a", "b"]), "a、b");
  assert.equal(describeDirtyPaths(["1", "2", "3", "4", "5", "6", "7"]), "1、2、3、4、5 等 7 个路径");
  const many = Array.from({ length: 23 }, (_, i) => `f${i}`);
  assert.ok(listedPaths(many).endsWith(" 等 23 个"));
  assert.equal(listedPaths(["x"]), "x");
});

test("越界判定:前缀按路径段闭合、豁免与流程规格不算;裁决话术点名外来提交", () => {
  assert.ok(pathWithinScope("src/filter/A.java", ["src/filter"]));
  assert.ok(pathWithinScope("src/filter", ["src/filter/"]), "尾斜杠不影响");
  assert.ok(!pathWithinScope("src/filterX/B.java", ["src/filter"]), "裸 startsWith 会把邻居目录错认成面内");
  const violations = deliveryScopeViolations({
    committed: ["docs/specs/index.md", "src/filter/A.java", "src/filterX/B.java", "pom.xml"],
    scopePaths: ["src/filter"], exempt: new Set(["pom.xml"]),
    processArtifact: (path) => path.startsWith("docs/specs/"),
  });
  assert.deepEqual(violations, ["src/filterX/B.java"]);
  const detail = scopeViolationDetail("接口模块", "src/filterX/B.java", 2);
  assert.match(detail, /^本单元\(接口模块\)的提交改动越出负责文件面:src\/filterX\/B\.java。/);
  assert.match(detail, /本分支上有 2 条别人直接推的提交/);
  assert.doesNotMatch(scopeViolationDetail("接口模块", "x", 0), /别人直接推/);
});
