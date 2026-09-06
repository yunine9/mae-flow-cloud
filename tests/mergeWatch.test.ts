/**
 * 合入监控的决策表(src/mergeWatch.ts):门禁怎么分类、每一拍往哪走、
 * 合入/关闭/等人写什么。真平台上的整环语义仍由 mrLoop 等集成用例兜着。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLOSED_MR_WRITE, REOPENED_MR_WRITE, autoRepairDisabledText, classifyGates,
  mergedCompletionDetail, mergedPendingAttestationWrite, mergedShaMismatchReason,
  nextWatchStep, openMrDriftReason, sourceShaDrift, stopFailures, waitingWrite,
} from "../src/mergeWatch.ts";

const gate = (name: string, passed = false, detail?: string) => ({ name, passed, detail });

test("门禁分类:三类可修按优先级排、全部返回;其余等人并翻成人话;认不出=等人留名", () => {
  const sorted = classifyGates([
    gate("ci_state_passed"), gate("approvers_passed"), gate("conflict_passed"),
    gate("resolve_discussion_passed"), gate("codequality_passed"),
    gate("vote_passed", true), gate("mystery_gate_passed"),
  ]);
  assert.deepEqual(sorted.repairs.map((item) => [item.kind, item.gate.name, item.priority]), [
    ["review", "resolve_discussion_passed", 10],
    ["conflict", "conflict_passed", 15],
    ["ci", "ci_state_passed", 20],
    ["ci", "codequality_passed", 25],
  ], "冲突不解 CI 白跑,检视优先于代码问题;质量门禁与 CI 同一路排其后");
  assert.deepEqual(sorted.waiting, ["等审批", "等 mystery_gate_passed"],
    "过了的不算;认不出的名字按等人处理并留痕——瞎修比不修危险");
  assert.deepEqual(classifyGates([]), { repairs: [], waiting: [] });
});

test("源提交漂移(MFC-038):两侧都有且不同才算;缺一侧无法核对不算", () => {
  assert.equal(sourceShaDrift("abc1234", "abc1234").drifted, false);
  assert.equal(sourceShaDrift(" abc1234 ", "abc1234").drifted, false, "空白不算差异");
  assert.equal(sourceShaDrift("abc1234", "def5678").drifted, true);
  assert.equal(sourceShaDrift(undefined, "def5678").drifted, false, "旧平台契约没有源 SHA:保持旧行为");
  assert.equal(sourceShaDrift("abc1234", "").drifted, false);
  assert.match(mergedShaMismatchReason("def5678abcd", "abc1234abcd"),
    /合入的提交 def5678 与本任务验证过的 abc1234 不一致.*不能标记完成/);
  assert.match(openMrDriftReason("def5678abcd", "abc1234abcd"),
    /指向未经本任务验证的提交 def5678.*已验证的是 abc1234.*已停止自动合入/);
});

test("监控环每一拍:merged 任何状态下都收口;writer 在途只看 merged;关闭/漂移/看门禁", () => {
  const gates = [gate("approvers_passed")];
  assert.deepEqual(nextWatchStep({ view: { mrState: "merged", gates, sourceSha: "a" }, status: "running", verifiedSha: "a" }),
    { kind: "settle_merged", sourceSha: "a" }, "反馈修复期间 MR 仍可能被合入,merged 是唯一被消费的终态");
  assert.deepEqual(nextWatchStep({ view: { mrState: "opened", gates }, status: "running", verifiedSha: "a" }),
    { kind: "wait" }, "writer 在途:门禁派单归它收口后的 await_merge,监听器不抢方向盘");
  assert.deepEqual(nextWatchStep({ view: { mrState: "closed", gates }, status: "await_merge", verifiedSha: "a" }),
    { kind: "settle_closed" });
  const drift = nextWatchStep({ view: { mrState: "opened", gates, sourceSha: "b" }, status: "await_merge", verifiedSha: "a" });
  assert.equal(drift.kind, "stall_drift", "MR 还开着但源提交已不是验证过的那个:旧绿灯不背书新代码");
  assert.deepEqual(nextWatchStep({ view: { mrState: "opened", gates, sourceSha: "a" }, status: "await_merge", verifiedSha: "a" }),
    { kind: "inspect_gates" });
  assert.deepEqual(nextWatchStep({ view: { mrState: "opened", gates }, status: "await_merge", verifiedSha: "a" }),
    { kind: "inspect_gates" }, "平台没给源 SHA:无法核对,照旧看门禁");
});

test("合入收口的文案与写盘:在途执行者没停住要点名;未推送内容如实说;关/重开/待对账各有一句", () => {
  assert.deepEqual(stopFailures([
    { status: "fulfilled", value: undefined },
    { status: "rejected", reason: new Error("abort timeout") },
    { status: "rejected", reason: "docker rm 失败" },
  ]), ["Agent停止失败:Error: abort timeout", "容器停止失败:docker rm 失败"]);
  assert.equal(mergedCompletionDetail(0, 0), "MR 已合入,交付完成");
  assert.match(mergedCompletionDetail(2, 1), /另有 2 个未推送提交、1 个未提交路径.*未冒充交付/);
  assert.match(mergedCompletionDetail(0, 3), /0 个未推送提交、3 个未提交路径/);
  assert.equal(CLOSED_MR_WRITE.mr_state, "已关闭");
  assert.match(CLOSED_MR_WRITE.waiting_on, /重新打开|主动停止/);
  assert.equal(REOPENED_MR_WRITE.mr_state, "等待合入");
  assert.equal(REOPENED_MR_WRITE.waiting_on, undefined);
  assert.deepEqual(mergedPendingAttestationWrite("内核尚未到 terminal"), {
    mr_state: "已合入（内核终态待对账）", waiting_on: "内核尚未到 terminal",
    detail: "MR 已合入，但不能标记完成：内核尚未到 terminal",
  });
});

test("等人名单:自动修关闭时红项交给人且去重;等待文案与通知幂等键按集合算", () => {
  assert.equal(autoRepairDisabledText([
    { kind: "ci", priority: 20, gate: gate("ci_state_passed") },
    { kind: "ci", priority: 25, gate: gate("codequality_passed") },
    { kind: "review", priority: 10, gate: gate("resolve_discussion_passed") },
  ]), "自动修复已关闭，请人工处理流水线红灯、检视意见");
  assert.deepEqual(waitingWrite([], "https://mr/1"),
    { waiting_on: undefined, detail: "门禁全绿,等待合入" }, "没人可等就不发通知");
  const w = waitingWrite(["等投票", "等审批"], "https://mr/1");
  assert.equal(w.waiting_on, "等投票、等审批");
  assert.equal(w.detail, "门禁与流水线已过,MR 在等投票、等审批");
  assert.equal(w.notice?.status, "waiting:等审批+等投票", "键按排序后的集合,顺序不同不算新一批");
  assert.equal(w.notice?.summary, "MR 在等投票、等审批,需要相关人处理:https://mr/1");
  assert.equal(waitingWrite(["等审批"], undefined).notice?.summary, "MR 在等审批,需要相关人处理");
});
