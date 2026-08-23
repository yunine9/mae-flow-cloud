import { test } from "node:test";
import assert from "node:assert/strict";
import {
  byTeamAttention,
  cycleTimeMs,
  isBlocked,
  isStale,
  median,
  needsAction,
  responsibleOf,
  type TeamTask,
} from "../web/src/teamOps.ts";

function task(patch: Partial<TeamTask> = {}): TeamTask {
  return {
    id: "task-1",
    requirement: "修复通知降级",
    status: "running",
    created_at: "2026-08-16T00:00:00.000Z",
    ...patch,
  };
}

test("团队行动口径:任务只有一个责任人,人工节点和机器停机进入关注", () => {
  assert.equal(responsibleOf(task({ luban_account: "alice" })), "alice");
  assert.equal(needsAction(task({ status: "waiting_for_human" })), true);
  assert.equal(isBlocked(task({ status: "failed" })), true);
});

test("停滞只认有效进展时间,完成任务不误报", () => {
  const now = Date.parse("2026-08-16T04:00:00.000Z");
  assert.equal(isStale(task({
    last_progress_at: "2026-08-16T01:00:00.000Z",
  }), now), true);
  assert.equal(isStale(task({
    status: "completed",
    last_progress_at: "2026-08-16T01:00:00.000Z",
  }), now), false);
});

test("团队排序先行动项,再看停滞时长;交付周期中位数可解释", () => {
  const rows = [
    task({ id: "recent", last_progress_at: "2026-08-16T03:00:00.000Z" }),
    task({ id: "old", last_progress_at: "2026-08-16T00:00:00.000Z" }),
    task({ id: "blocked", status: "failed" }),
  ].sort(byTeamAttention);
  assert.equal(rows[0].id, "blocked");
  assert.equal(cycleTimeMs(task({
    created_at: "2026-08-16T00:00:00.000Z",
    completed_at: "2026-08-16T03:00:00.000Z",
  })), 3 * 60 * 60_000);
  assert.equal(median([1, 9, 3, 5]), 4);
});

test("团队排序优先使用服务端焦点,环境故障不会藏在普通运行态里", () => {
  const rows = [
    task({ id: "running" }),
    task({
      id: "environment",
      focus: {
        kind: "blocked",
        headline: "Maven 仓库不可达",
        next_action: "等待平台恢复编译环境",
        needs_attention: true,
        priority: 85,
      },
    }),
    task({
      id: "decision",
      focus: {
        kind: "human_action",
        headline: "需要确认 2 个决策项",
        next_action: "提交决定后 Agent 自动继续",
        needs_attention: true,
        priority: 100,
      },
    }),
  ].sort(byTeamAttention);
  assert.deepEqual(rows.map((row) => row.id), [
    "decision", "environment", "running",
  ]);
  assert.equal(needsAction(rows[1]), true);
  assert.equal(isBlocked(rows[1]), true);
});
