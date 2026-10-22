import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationItem } from "../web/src/api";
import { createTaskDemoSandbox } from "../web/src/taskDemoSandbox";
import { suggestedDemoMessage, type TaskDemoSnapshot } from "../web/src/taskDemoTypes";

const at = "2026-10-22T00:00:00Z";
const turn = (id: string): ConversationItem => ({
  kind: "turn", id, ts: at, end_ts: at, open: false,
  texts: [{ text: id, ts: at, truncated: false, role: "handoff" }],
  steps: { calls: 0, errors: 0, reads: 0, edits: 0, bash: 0, agents: 0, sample: [] },
});
const card = (id: string, step = "story"): ConversationItem => ({
  kind: "card", id, ts: at, waiting_id: id, step, purpose: "confirmation",
  annotation_ids: [], questions: [{ question: id, options: ["确认", "调整"] }], status: "resolved",
});
const snapshot = (items: ConversationItem[]): TaskDemoSnapshot => ({
  schema: "mae-flow-demo-snapshot/1", captured_at: at, source_task_id: "source",
  task: { id: "source", requirement: "设计演示", created_at: at, status: "completed", luban_account: "owner",
    progress: { phases: ["写设计"], current_index: 0, current_phase: "写设计" } },
  phase_steps: { "写设计": ["story"] }, conversation: { items }, artifacts: [], annotations: { items: [] }, problems: [],
});

test("多轮设计确认：高亮回复与演示提问使用同一轮历史卡片", () => {
  const source = snapshot([turn("第一版方案"), card("第一轮确认"), turn("修改后的方案"), card("第二轮确认")]);
  const demo = createTaskDemoSandbox({ task: source.task, actor: "admin", phaseSteps: source.phase_steps,
    conversation: source.conversation.items, fetchRead: async () => { throw new Error("此测试不应访问来源"); } });
  try {
    assert.equal(suggestedDemoMessage(source, "写设计"), "修改后的方案");
    assert.equal(demo.selectPhase("写设计").waiting?.question?.questions?.[0]?.question, "第二轮确认");
  } finally { demo.dispose(); }
});

test("最近卡片前没有相邻回复时留空，不借用上一轮或其他阶段的回复", () => {
  assert.equal(suggestedDemoMessage(snapshot([turn("旧回复"), card("旧确认"), card("新确认")]), "写设计"), undefined);
  assert.equal(suggestedDemoMessage(snapshot([turn("spec说明"), card("spec确认", "open")]), "写设计"), undefined);
});

test("定制流程按任务固定的阶段步骤匹配，与演示问题一致", () => {
  const source = snapshot([turn("定制设计说明"), card("定制确认", "custom_story")]);
  source.task.workflow_profile = { schema: "mae-flow-execution-profile/2", revision: "1",
    source: { kind: "task", id: "custom" }, edits: [], diagnostics: [], asset_manifest: [],
    final_snapshot: { standard_id: "custom", standard_version: "1", catalog_digest: "abc",
      stages: [{ id: "design", title: "设计", phase: "写设计", steps: ["custom_story"], slots: [], items: [] }] } };
  assert.equal(suggestedDemoMessage(source, "写设计"), "定制设计说明");
});
