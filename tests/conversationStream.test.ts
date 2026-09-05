/**
 * 右栏会话流的页面契约(纯渲染,不起服务):
 * - 筛选:全部 / 需要我的 / 意见与回执;线程视图只留牵涉这条批注的条目;
 * - 回合:最后一段话摊开、此前的折叠、工具步骤折成一行计数并可跳工作过程;
 * - 卡:历史卡是只读摘要并标出选了哪项;当前卡由父级传入渲在流末尾;
 * - 回执:逐条带结论,旧版本回执明说"不算数";
 * - 锚条:等你决定 / N 条意见等你确认 / 否则说当前在干嘛。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";
import type { ConversationItem, TaskSummary } from "../web/src/api.ts";

// 前端模块带 CSS import,走 Vite 的 SSR loader(与 workspaceUiLogic 同款);
// 本仓刻意不为前端测试引入 jsdom,只验证静态渲染出来的事实。
const vite = await createServer({
  root: "web",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
// 只按用到的形状标类型,不 typeof import 前端源码:根 tsconfig 没有 DOM lib,
// 把组件源码拉进根程序会冒出一堆"找不到 window"的假错。
type StreamModule = {
  ConversationStream: (props: Record<string, unknown>) => unknown;
  conversationCardTitle: (item: ConversationItem) => string;
  itemAnnotationIds: (item: ConversationItem) => string[];
  visibleConversationItems: (
    items: readonly ConversationItem[],
    options: { filter: "all" | "mine" | "review"; thread?: string; viewer: string },
  ) => ConversationItem[];
};
const {
  ConversationStream, conversationCardTitle, itemAnnotationIds, visibleConversationItems,
} = await vite.ssrLoadModule("/src/ConversationStream.tsx") as StreamModule;
after(() => vite.close());

const T0 = "2026-09-05T02:00:00.000Z";
const T1 = "2026-09-05T02:05:00.000Z";
const T2 = "2026-09-05T02:10:00.000Z";
const T3 = "2026-09-05T02:15:00.000Z";

const ref = { id: "a-1", author: "zhou", kind: "doc", file: "docs/spec.md", line: 7, note: "多长算长文?" };

const items: ConversationItem[] = [
  { kind: "session", id: "s1", ts: T0, phase: "started", resume: false },
  { kind: "turn", id: "turn-1", ts: T0, end_ts: T1, open: false,
    texts: [
      { ts: T0, text: "我先核对现有实现。", truncated: false },
      { ts: T1, text: "结论:只改一处,请确认。", truncated: false },
    ],
    steps: { calls: 12, errors: 1, reads: 8, edits: 2, bash: 2, agents: 0,
      sample: [{ kind: "edit", subject: "…/src/a.ts" }, { kind: "bash", subject: "npm test" }] } },
  { kind: "card", id: "card-w1", ts: T1, waiting_id: "w1", step: "cloud_push_confirm",
    purpose: "confirmation", annotation_ids: [],
    questions: [{ question: "是否推送?", options: ["确认按清单推送", "需要调整代码"] }],
    status: "resolved" },
  { kind: "decision", id: "decision-w1", ts: T2, waiting_id: "w1", by: "lin",
    decision: "需要调整代码", answers: { "是否推送?": "需要调整代码" },
    notes: "第 9 行别暴露枚举", purpose: "confirmation", annotation_ids: [] },
  { kind: "annotations_sent", id: "sent-1", ts: T2, by: "zhou", via: "decision", items: [ref] },
  { kind: "receipts", id: "receipts-1", ts: T3, items: [
    { ...ref, outcome: "needs_clarification", summary: "按字数还是按任务?", revision: 0, current: true },
    { ...ref, id: "a-2", author: "lin", note: "保留业务语气", outcome: "fixed",
      summary: "旧回执", revision: 0, current: false },
  ] },
  { kind: "steer", id: "steer-1", ts: T3, text: "别动区号", delivered: false, deferred: "decision" },
  { kind: "external", id: "ext-1", ts: T3, source: "mr_discussion", author: "周谨",
    items: [{ id: "f1", summary: "移动端入口别竖排", file: "a.css", line: 950, status: "open" }] },
];

const task = {
  id: "task-8", status: "running", luban_account: "lin",
  focus: { headline: "Agent 正在写代码", next_action: "写完后会举卡请你检视" },
} as unknown as TaskSummary;

function render(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(React.createElement(
    ConversationStream as unknown as React.FunctionComponent<Record<string, unknown>>, {
    task, items, problems: [], loaded: true, viewerUsername: "zhou",
    people: [{ username: "lin", display_name: "林知远" }],
    filter: "all", onFilterChange: () => undefined, onThreadChange: () => undefined,
    annotations: [], decides: false, awaitingYou: 0,
    fallbackHeadline: "当前无待办", fallbackDetail: "无需处理",
    takeover: false, onLocateAnnotation: () => undefined,
    onOpenReview: () => undefined, onOpenSteps: () => undefined,
    ...overrides,
  }));
}

test("筛选与线程:意见与回执只留批注类条目;线程只留牵涉这条批注的", () => {
  const review = visibleConversationItems(items, { filter: "review", viewer: "zhou" });
  assert.deepEqual(review.map((item) => item.kind), ["annotations_sent", "receipts", "external"]);
  const mine = visibleConversationItems(items, { filter: "mine", viewer: "zhou" });
  assert.ok(mine.every((item) => item.kind !== "turn" && item.kind !== "session"));
  assert.ok(mine.some((item) => item.id === "sent-1"), "我提的意见在「需要我的」里");
  const thread = visibleConversationItems(items, { filter: "all", thread: "a-1", viewer: "zhou" });
  assert.deepEqual(thread.map((item) => item.id), ["sent-1", "receipts-1"]);
  assert.deepEqual(itemAnnotationIds(items[5]), ["a-1", "a-2"]);
  assert.equal(conversationCardTitle(items[2] as Extract<ConversationItem, { kind: "card" }>),
    "最终检视：确认这版代码可直接推送");
});

test("回合摊开最后一段、折叠此前的,工具步骤折成一行;历史卡标出选了哪项", () => {
  const html = render();
  assert.match(html, /此前 1 段说明/);
  assert.match(html, /结论:只改一处,请确认。/);
  assert.match(html, /编辑 …\/src\/a\.ts · 运行 npm test · 共 12 步 · 1 步失败/);
  assert.match(html, /最终检视：确认这版代码可直接推送/);
  assert.match(html, /class="chosen">需要调整代码/);
  assert.match(html, /林知远/, "决定人按显示名");
  assert.match(html, /第 9 行别暴露枚举/);
  assert.match(html, /提交了 1 条批注给 Agent/);
  assert.match(html, /2 条意见的处理回执/);
  assert.match(html, /需要补充信息/);
  assert.match(html, /旧版本回执，不算数/);
  assert.match(html, /随下一次决定送达/);
  assert.match(html, /CodeHub 检视/);
  assert.match(html, /只看这条的往来/);
  assert.match(html, /data-annotation-ids="a-1 a-2"/);
  assert.match(html, /Agent 正在写代码/, "没有待办时锚条说当前在干嘛");
});

test("锚条:等你决定 / N 条意见等你确认;当前卡由父级传入渲在流末尾", () => {
  const waitingTask = { ...task, status: "waiting_for_human",
    waiting: { waiting_id: "w2", state_version: 1, created_at: T3,
      question: { questions: [{ question: "确认?" }] } } } as unknown as TaskSummary;
  const html = render({ task: waitingTask, decides: true,
    currentCard: React.createElement("div", { className: "probe-card" }, "决定卡本体") });
  assert.match(html, /等你决定/);
  assert.match(html, /跳到卡片/);
  assert.match(html, /conv-card current"><div class="probe-card">决定卡本体/);
  const confirm = render({ awaitingYou: 3 });
  assert.match(confirm, /3 条意见等你逐条确认/);
  assert.match(confirm, /打开批注与检视/);
});

test("超过一屏的历史默认折叠,给出「显示更早的 N 条」", () => {
  const many: ConversationItem[] = Array.from({ length: 60 }, (_, index) => ({
    kind: "turn", id: `turn-${index}`, ts: new Date(Date.parse(T0) + index * 60_000).toISOString(),
    end_ts: T0, open: false, texts: [{ ts: T0, text: `第 ${index} 段`, truncated: false }],
    steps: { calls: 0, errors: 0, reads: 0, edits: 0, bash: 0, agents: 0, sample: [] },
  }));
  const html = render({ items: many });
  assert.match(html, /显示更早的 10 条/);
  assert.doesNotMatch(html, /第 3 段/);
  assert.match(html, /第 59 段/);
});
