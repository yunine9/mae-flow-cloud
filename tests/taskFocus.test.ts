import { test } from "node:test";
import assert from "node:assert/strict";
import { projectTaskFocus } from "../src/taskFocus.ts";

test("任务焦点:人工决定明确说明数量与放行后的动作", () => {
  const result = projectTaskFocus({
    status: "waiting_for_human",
    waiting: { question: { questions: [{}, {}, {}] } },
  });
  assert.deepEqual(result, {
    kind: "human_action",
    headline: "需要确认 3 个决策项",
    next_action: "提交决定后 Agent 自动继续",
    owner: "responsible",
    needs_attention: true,
    priority: 100,
  });
});

test("任务焦点:机器修复、平台验证与跨仓依赖不会冒充人工待办", () => {
  const repair = projectTaskFocus({
    status: "verifying",
    delivery: { loop: { state: "repairing", round: 2 } },
  });
  assert.match(repair.headline, /第 2 轮/);
  assert.equal(repair.owner, "agent");
  assert.equal(repair.needs_attention, false);

  const pipeline = projectTaskFocus({
    status: "verifying",
    delivery: { waiting_on: "等待权威流水线返回 UT 结果" },
  });
  assert.equal(pipeline.headline, "等待权威流水线返回 UT 结果");
  assert.equal(pipeline.owner, "platform");

  const dependency = projectTaskFocus({
    status: "queued",
    blocked_by: ["task-2", "task-3"],
  });
  assert.equal(dependency.headline, "等待 2 个前置任务完成");
  assert.equal(dependency.needs_attention, false);
});

test("任务焦点:失败、暂停和预推送环境故障诚实进入关注队列", () => {
  const failed = projectTaskFocus({ status: "failed", detail: "模型网关不可用" });
  assert.equal(failed.kind, "blocked");
  assert.equal(failed.headline, "模型网关不可用");

  const paused = projectTaskFocus({ status: "paused" });
  assert.equal(paused.needs_attention, true);
  assert.match(paused.next_action, /恢复/);

  const environment = projectTaskFocus({
    status: "running",
    delivery: { prepush: { state: "environment_error", message: "Maven 仓库不可达" } },
  });
  assert.equal(environment.kind, "blocked");
  assert.equal(environment.owner, "platform");
  assert.match(environment.next_action, /编译环境/);
});

test("任务焦点:运行态使用内核同源步骤，不自造流程阶段", () => {
  const result = projectTaskFocus({
    status: "running",
    progress: { current_phase: "编码实现", step: "实现订单校验" },
  });
  assert.equal(result.headline, "Agent 正在推进：实现订单校验");
  assert.equal(result.kind, "machine");
});

test("任务焦点:DTS 诊断与内核交接不会伪装成普通编码", () => {
  const triage = projectTaskFocus({
    status: "running",
    entry_kind: "dts",
    issue_context: { stage: "triage" },
  });
  assert.match(triage.headline, /日志、代码与问题根因/);
  assert.match(triage.next_action, /请你确认/);

  const handoff = projectTaskFocus({
    status: "queued",
    entry_kind: "dts",
    issue_context: { stage: "delivery" },
  });
  assert.match(handoff.headline, /等待代码修复接管/);
  assert.match(handoff.next_action, /Mae-Flow 问题修复/);
});
