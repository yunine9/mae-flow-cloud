/**
 * 推送前验证领域契约：
 * - receipt 精确绑定 SHA + workspace fingerprint，只覆盖 compile/UT；
 * - 同快照 push 重试复用，任何内容变化或新 SHA 都立即清票；
 * - 代码失败交 Agent 修，基础设施失败停在环境侧，二者不能混淆；
 * - 无进展显式停机；状态 JSON 化后可从中断点安全恢复。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginPrePushAttempt,
  canPushRevision,
  createPrePushVerification,
  getReusablePushReceipt,
  markPrePushNoProgress,
  nextPrePushAction,
  observePrePushRevision,
  recordPrePushCheck,
  recordPrePushReport,
  restorePrePushVerification,
  retryPrePushVerification,
  transitionPrePush,
  type PrePushRevision,
  type PrePushVerificationState,
} from "../src/prePushVerification.ts";

const REVISION: PrePushRevision = {
  sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  workspace_fingerprint: "tree+worktree:111",
};

function at(second: number): string {
  return new Date(Date.parse("2026-08-21T02:00:00Z") + second * 1000)
    .toISOString();
}

function begin(
  state: PrePushVerificationState,
  second: number,
): { state: PrePushVerificationState; attempt: string } {
  const started = beginPrePushAttempt(state, at(second));
  assert.ok(started.active_attempt);
  return { state: started, attempt: started.active_attempt.id };
}

function pass(
  state: PrePushVerificationState,
  second: number,
): PrePushVerificationState {
  const started = begin(state, second);
  return recordPrePushReport(started.state, started.attempt, {
    compile: { outcome: "passed" },
    unit_test: { outcome: "passed" },
  }, at(second + 1));
}

test("新 revision 默认 fail-closed；只有 compile + UT 都过才签 receipt", () => {
  let state = createPrePushVerification(REVISION, at(0));
  assert.equal(state.state, "preparing");
  assert.equal(state.round, 0);
  assert.equal(nextPrePushAction(state), "start_agent");
  assert.equal(canPushRevision(state, REVISION), false);

  const started = begin(state, 1);
  state = started.state;
  assert.equal(state.round, 1);
  assert.equal(nextPrePushAction(state), "wait_for_agent");

  state = recordPrePushCheck(
    state, started.attempt, "unit_test", "passed", at(2));
  assert.equal(state.checks.unit_test.state, "pending",
    "UT 不能越过 compile 单独签绿");
  state = recordPrePushCheck(
    state, started.attempt, "compile", "passed", at(3));
  assert.equal(state.state, "preparing");
  assert.equal(state.receipt, undefined);
  state = recordPrePushCheck(
    state, started.attempt, "unit_test", "passed", at(4));

  assert.equal(state.state, "passed");
  assert.equal(nextPrePushAction(state), "push");
  assert.equal(canPushRevision(state, REVISION), true);
  assert.deepEqual(Object.keys(state.receipt!.checks).sort(),
    ["compile", "unit_test"], "CodeCheck 不属于 pre-push receipt");
  assert.equal(state.receipt!.sha, REVISION.sha);
  assert.equal(
    state.receipt!.workspace_fingerprint, REVISION.workspace_fingerprint);
});

test("push 网络失败后，同 SHA + 同 fingerprint 原样复用 PASS", () => {
  const passed = pass(createPrePushVerification(REVISION, at(0)), 1);
  const receipt = getReusablePushReceipt(passed, REVISION);
  assert.ok(receipt);

  const observed = observePrePushRevision(passed, { ...REVISION }, at(10));
  assert.equal(observed, passed, "同一现场对账不制造新轮次或新 receipt");
  assert.equal(getReusablePushReceipt(observed, REVISION), receipt);

  const recovered = restorePrePushVerification(
    JSON.parse(JSON.stringify(observed)), REVISION, at(20));
  assert.equal(recovered.state, "passed");
  assert.equal(recovered.round, 1);
  assert.deepEqual(getReusablePushReceipt(recovered, REVISION), receipt,
    "进程重启也能复用已经落盘的同快照 receipt");
});

test("同 SHA 文件变化立即失效；旧 attempt 的迟到绿灯不能复活旧票", () => {
  const initial = createPrePushVerification(REVISION, at(0));
  const started = begin(initial, 1);
  const changedRevision = {
    ...REVISION,
    workspace_fingerprint: "tree+worktree:222",
  };
  let changed = transitionPrePush(started.state, {
    type: "workspace_changed",
    workspace_fingerprint: changedRevision.workspace_fingerprint,
    at: at(2),
  });
  assert.equal(changed.state, "preparing");
  assert.equal(changed.round, 1, "同 SHA 修代码仍保留轮数");
  assert.equal(changed.last_invalidation?.reason, "workspace_changed");
  assert.equal(changed.active_attempt, undefined);
  assert.equal(changed.receipt, undefined);

  const beforeLateResult = changed;
  changed = recordPrePushCheck(
    changed, started.attempt, "compile", "passed", at(3));
  assert.equal(changed, beforeLateResult, "旧快照迟到结果被丢弃");
  assert.equal(canPushRevision(changed, changedRevision), false);

  const reverified = pass(changed, 4);
  assert.equal(canPushRevision(reverified, changedRevision), true);
});

test("新 SHA 即使内容指纹相同也清票并重新计轮", () => {
  const passed = pass(createPrePushVerification(REVISION, at(0)), 1);
  const nextRevision = {
    sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    workspace_fingerprint: REVISION.workspace_fingerprint,
  };
  const next = observePrePushRevision(passed, nextRevision, at(10));
  assert.equal(next.state, "preparing");
  assert.equal(next.round, 0);
  assert.equal(next.last_invalidation?.reason, "new_sha");
  assert.equal(next.receipt, undefined);
  assert.equal(canPushRevision(next, nextRevision), false);
  assert.equal(canPushRevision(next, REVISION), false);
});

test("代码失败进入 repairing；可在同一快照继续修复直至两项通过", () => {
  const initial = createPrePushVerification(REVISION, at(0));
  const first = begin(initial, 1);
  let state = recordPrePushReport(first.state, first.attempt, {
    compile: { outcome: "code_failure", message: "类型错误 TS2322" },
    // runner 的矛盾/多余结果不能覆盖 compile 红灯。
    unit_test: { outcome: "passed" },
  }, at(2));
  assert.equal(state.state, "repairing");
  assert.equal(state.issue?.kind, "code");
  assert.equal(state.issue?.check, "compile");
  assert.match(state.message, /TS2322/);
  assert.equal(state.checks.unit_test.state, "pending");
  assert.equal(nextPrePushAction(state), "repair_code");
  assert.equal(canPushRevision(state, REVISION), false);

  const second = begin(state, 3);
  assert.equal(second.state.round, 2, "无硬编码最大修复轮数");
  state = recordPrePushReport(second.state, second.attempt, {
    compile: { outcome: "passed" },
    unit_test: { outcome: "passed" },
  }, at(4));
  assert.equal(state.state, "passed");
  assert.equal(canPushRevision(state, REVISION), true);
});

test("基础设施失败进入 environment_error，不误派代码修复", () => {
  const initial = createPrePushVerification(REVISION, at(0));
  const first = begin(initial, 1);
  let state = recordPrePushReport(first.state, first.attempt, {
    compile: {
      outcome: "infrastructure_failure",
      message: "构建容器启动超时",
    },
    unit_test: { outcome: "not_run" },
  }, at(2));
  assert.equal(state.state, "environment_error");
  assert.equal(state.issue?.kind, "infrastructure");
  assert.equal(nextPrePushAction(state), "restore_environment");
  assert.equal(beginPrePushAttempt(state, at(3)), state,
    "环境未显式恢复前不自动拉 Agent 空转");

  state = retryPrePushVerification(state, at(4), "环境恢复，重新验证");
  assert.equal(state.state, "preparing");
  assert.equal(state.issue, undefined);
  assert.equal(state.checks.compile.state, "pending");
  state = pass(state, 5);
  assert.equal(state.state, "passed");
});

test("runner 没跑完整质量动作会 blocked，显式恢复后才继续", () => {
  const initial = createPrePushVerification(REVISION, at(0));
  const first = begin(initial, 1);
  let state = recordPrePushReport(first.state, first.attempt, {
    compile: { outcome: "passed" },
    unit_test: { outcome: "not_run", message: "没有找到 UT 命令" },
  }, at(2));
  assert.equal(state.state, "blocked");
  assert.equal(state.issue?.kind, "no_progress");
  assert.match(state.message, /没有找到 UT/);
  assert.equal(nextPrePushAction(state), "request_attention");
  assert.equal(beginPrePushAttempt(state, at(3)), state);

  state = retryPrePushVerification(state, at(4));
  assert.equal(state.state, "preparing");
  assert.equal(state.checks.compile.state, "passed",
    "同一快照已完成的编译事实可在恢复后继续使用");
  assert.equal(nextPrePushAction(state), "start_agent");
});

test("无进展事件要求匹配当前 attempt，迟到事件不误停新一轮", () => {
  const initial = createPrePushVerification(REVISION, at(0));
  const first = begin(initial, 1);
  const unchanged = markPrePushNoProgress(
    first.state, at(2), "旧会话说没有进展", "wrong-attempt");
  assert.equal(unchanged, first.state);

  const blocked = markPrePushNoProgress(
    first.state, at(3), "修改前后指纹没有变化", first.attempt);
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.active_attempt, undefined);
  assert.equal(canPushRevision(blocked, REVISION), false);
});

test("崩在 UT 前可恢复：保留同快照 compile PASS，丢掉在途 attempt", () => {
  let state = createPrePushVerification(REVISION, at(0));
  const first = begin(state, 1);
  state = recordPrePushCheck(
    first.state, first.attempt, "compile", "passed", at(2));
  assert.ok(state.active_attempt);
  assert.equal(state.checks.compile.state, "passed");

  state = restorePrePushVerification(
    JSON.parse(JSON.stringify(state)), REVISION, at(10));
  assert.equal(state.state, "preparing");
  assert.equal(state.active_attempt, undefined);
  assert.equal(state.checks.compile.state, "passed");
  assert.match(state.message, /服务恢复/);

  const second = begin(state, 11);
  assert.notEqual(second.attempt, first.attempt);
  // 恢复前 attempt 的迟到结果不属于当前活动轮次。
  const unchanged = recordPrePushCheck(
    second.state, first.attempt, "unit_test", "passed", at(12));
  assert.equal(unchanged, second.state);

  state = recordPrePushReport(second.state, second.attempt, {
    compile: { outcome: "passed" },
    unit_test: { outcome: "passed" },
  }, at(13));
  assert.equal(state.state, "passed");
  assert.equal(state.round, 2);
  assert.equal(canPushRevision(state, REVISION), true);
});

test("恢复遇到坏账或伪造 receipt 时 fail-closed 重新验证", () => {
  const bad = {
    schema: "mae-flow-cloud/prepush-verification/1",
    state: "passed",
    round: 99,
    message: "我自称过了",
    sha: REVISION.sha,
    workspace_fingerprint: REVISION.workspace_fingerprint,
    updated_at: at(1),
    checks: {
      compile: { state: "pending" },
      unit_test: { state: "pending" },
    },
    receipt: {
      schema: "mae-flow-cloud/prepush-pass/1",
      sha: REVISION.sha,
      workspace_fingerprint: REVISION.workspace_fingerprint,
      issued_at: at(1),
      checks: {},
    },
  };
  const restored = restorePrePushVerification(bad, REVISION, at(2));
  assert.equal(getReusablePushReceipt(bad as never, REVISION), undefined,
    "即使调用方跳过 restore，push 入口也不接收畸形 receipt");
  assert.equal(restored.state, "preparing");
  assert.equal(restored.round, 0);
  assert.equal(restored.receipt, undefined);
  assert.equal(canPushRevision(restored, REVISION), false);
});
