import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationItem } from "../web/src/api";
import { createTaskDemoSandbox } from "../web/src/taskDemoSandbox";
import { hasTaskDemoPhaseCard, suggestedDemoMessage, taskDemoPhaseCard, type TaskDemoSnapshot } from "../web/src/taskDemoTypes";

const at = "2026-10-22T00:00:00Z";
const turn = (id: string): ConversationItem => ({
  kind: "turn", id, ts: at, end_ts: at, open: false,
  texts: [{ text: id, ts: at, truncated: false, role: "handoff" }],
  steps: { calls: 0, errors: 0, reads: 0, edits: 0, bash: 0, agents: 0, sample: [] },
});
const card = (id: string, step = "story"): Extract<ConversationItem, { kind: "card" }> => ({
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

test("最近卡片前没有相邻回复时定位原卡，不借用上一轮或其他阶段的回复", () => {
  assert.equal(suggestedDemoMessage(snapshot([turn("旧回复"), card("旧确认"), card("新确认")]), "写设计"), "新确认");
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


test("历史中文步骤标题匹配固定流程，真实问题、上下文和开场说明保留到副本", async () => {
  const source = snapshot([turn("设计检视回复"), { ...card("中文确认", "Story 与实施附录生成及一次设计检视"), waiting_id: "原确认记录" }]);
  source.task.workflow_profile = { schema: "mae-flow-execution-profile/2", revision: "1",
    source: { kind: "task", id: "custom" }, edits: [], diagnostics: [], asset_manifest: [],
    final_snapshot: { standard_id: "custom", standard_version: "1", catalog_digest: "abc",
      stages: [{ id: "design", title: "设计", phase: "写设计", steps: ["custom_story"], slots: [], items: [] }] } };
  source.step_titles = { custom_story: "Story 与实施附录生成及一次设计检视" };
  source.card_contexts = { "原确认记录": { context: "订单服务沿用现有幂等键，支付接口不变。", preface: "检视发现重试存在重复扣款风险，已补充去重。" } };
  assert.equal(hasTaskDemoPhaseCard(source, "写设计"), true);
  assert.equal(taskDemoPhaseCard(source, "写设计")?.id, "中文确认");
  assert.equal(suggestedDemoMessage(source, "写设计"), "设计检视回复");
  const demo = createTaskDemoSandbox({ task: source.task, actor: "admin", phaseSteps: source.phase_steps,
    stepTitles: source.step_titles, cardContexts: source.card_contexts, conversation: source.conversation.items,
    fetchRead: async () => { throw new Error("真实历史无需生成或读取其他资料"); } });
  try {
    const shown = demo.selectPhase("写设计");
    assert.equal(shown.waiting?.question?.questions?.[0]?.question, "中文确认");
    assert.equal(shown.waiting?.context, source.card_contexts["原确认记录"].context);
    assert.equal(shown.waiting?.preface, source.card_contexts["原确认记录"].preface);
    const history = await (await demo.fetch(`/tasks/${demo.taskId}/conversation`)).json() as { items: ConversationItem[] };
    assert.ok(history.items.some((item: ConversationItem) => item.id === "设计检视回复"));
  } finally { demo.dispose(); }
});

test("主任务分析的空步骤历史卡可匹配，子任务不能借用空步骤卡", () => {
  const source = snapshot([turn("拆分结果"), card("拆分确认", "")]);
  source.task.progress = { phases: ["澄清需求"], current_index: 0, current_phase: "澄清需求" };
  source.task.requirement_graph = { stage: "confirmed", repositories: [], dependencies: [] };
  assert.equal(taskDemoPhaseCard(source, "澄清需求")?.id, "拆分确认");
  assert.equal(suggestedDemoMessage(source, "澄清需求"), "拆分结果");
  source.task.parent_task_id = "主任务";
  assert.equal(taskDemoPhaseCard(source, "澄清需求"), undefined);
  assert.equal(hasTaskDemoPhaseCard(source, "澄清需求"), false);
  assert.equal(suggestedDemoMessage(source, "澄清需求"), undefined);
});

test("检视与验证包含宿主推送和 MR 说明确认，使用真实历史卡", () => {
  for (const step of ["host_push_confirm", "cloud_push_confirm", "cloud_mr_description"]) {
    const source = snapshot([turn("交付检视结果"), card("推送确认", step)]);
    assert.equal(taskDemoPhaseCard(source, "检视与验证")?.id, "推送确认", step);
    assert.equal(suggestedDemoMessage(source, "检视与验证"), "交付检视结果", step);
    assert.equal(hasTaskDemoPhaseCard(source, "写设计"), false, step);
  }
});
