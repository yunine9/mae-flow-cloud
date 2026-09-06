/**
 * 右栏会话流的页面契约(纯渲染,不起服务):
 * - 筛选:全部 / 需要我的 / 检视意见;线程视图只留牵涉这条批注的条目;
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
    options: { filter: "all" | "mine"; thread?: string; viewer: string },
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
      { ts: T0, text: "我先核对现有实现。", truncated: false, role: "narration" },
      { ts: T0, text: "现在去跑一遍测试。", truncated: false, role: "narration" },
      { ts: T1, text: "结论:只改一处,请确认。", truncated: false, role: "handoff" },
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

test("筛选与线程:只剩全部 / 需要我的;线程只留牵涉这条批注的", () => {
  // 2026-09-06 用户:"右边的检视意见和左边的抽屉是不是重复"——第三档筛选去掉,
  // 意见类条目在流里只留一行摘要,详情只在抽屉。
  // 「需要我的」只留此刻还等我动手的:开着的卡、我提的意见收到的当前回执、
  // 收到的上下游通知。历史(已答的卡、决定、插话、我提过的意见)不算。
  const mine = visibleConversationItems(items, { filter: "mine", viewer: "zhou" });
  assert.deepEqual(mine.map((item) => item.id), ["receipts-1"],
    "zhou 的意见 a-1 有当前版本的回执在等她;已答复的卡、决定、插话都不算");
  const settled = visibleConversationItems(items,
    { filter: "mine", viewer: "zhou", settled: new Set(["a-1"]) });
  assert.deepEqual(settled, [], "意见闭环后回执不再需要我");
  const lin = visibleConversationItems(items, { filter: "mine", viewer: "lin" });
  assert.deepEqual(lin, [], "a-2 的回执是旧版本,不算 lin 的待办");
  const thread = visibleConversationItems(items, { filter: "all", thread: "a-1", viewer: "zhou" });
  assert.deepEqual(thread.map((item) => item.id), ["sent-1", "receipts-1"]);
  assert.deepEqual(itemAnnotationIds(items[5]), ["a-1", "a-2"]);
  assert.equal(conversationCardTitle(items[2] as Extract<ConversationItem, { kind: "card" }>),
    "最终检视：确认这版代码可直接推送");
});

test("回合摊开最后一段、折叠此前的,工具步骤折成一行;历史卡标出选了哪项", () => {
  const html = render();
  assert.match(html, /2 段过程说明/, "过程话折成一行");
  assert.match(html, /结论:只改一处,请确认。/, "交接语摊开");
  assert.match(html, /编辑 …\/src\/a\.ts · 运行 npm test · 共 12 步 · 1 步失败/);
  assert.match(html, /最终检视：确认这版代码可直接推送/);
  assert.match(html, /class="chosen">需要调整代码/);
  assert.match(html, /林知远/, "决定人按显示名");
  assert.match(html, /第 9 行别暴露枚举/);
  // 非线程视图:意见类条目一行摘要 + 打开检视意见,不摊开正文(抽屉里有)
  assert.match(html, /提交了 1 条意见给 Agent/);
  assert.match(html, /回了 1 条意见的处理结果：1 条需要补充说明/);
  assert.match(html, /另 1 条是旧版本回执，不算数/);
  assert.doesNotMatch(html, /按字数还是按任务\?/, "回执正文不在流里重复");
  assert.doesNotMatch(html, /class="conv-receipts"/, "逐条回执列表只在线程视图");
  assert.match(html, /CodeHub 检视/);
  assert.match(html, /提了 1 条意见，1 条还没闭环/);
  assert.doesNotMatch(html, /移动端入口别竖排/, "外部意见正文也只在抽屉");
  assert.ok((html.match(/打开检视意见/g) ?? []).length >= 3);
  assert.doesNotMatch(html, /看这条的处理记录/, "非线程视图不再逐条给入口");
  assert.match(html, /data-annotation-ids="a-1 a-2"/);
  assert.match(html, /随下一次决定送达/);
  assert.match(html, /Agent 正在写代码/, "没有待办时锚条说当前在干嘛");
  assert.doesNotMatch(html, /role="tab"[^>]*>检视意见/, "第三档筛选已去掉");
  // 线程视图:同一批条目逐条完整
  const threaded = render({ thread: "a-1" });
  assert.match(threaded, /2 条意见的处理回执/);
  assert.match(threaded, /按字数还是按任务\?/);
  assert.match(threaded, /需要补充信息/);
  assert.match(threaded, /看这条的处理记录/);
});

test("栏头一行放标题与筛选,锚条一行并入状态与责任,不再各占一行", () => {
  const html = render({ statusText: "执行中", actor: "由你负责" });
  assert.match(html, /<header class="ws-collaboration-head"><strong>与 Agent 协作<\/strong><div class="ws-stream-filters"/,
    "筛选进栏头,不再单独一行");
  assert.match(html, /<small>执行中 · 由你负责 · 写完后会举卡请你检视<\/small>/,
    "状态、责任、下一步并成锚条的一行小字");
  assert.doesNotMatch(html, /ws-focus-status/);
  const waitingTask = { ...task, status: "waiting_for_human",
    waiting: { waiting_id: "w2", state_version: 1, created_at: T3,
      question: { questions: [{ question: "确认?" }] } } } as unknown as TaskSummary;
  const attention = render({ task: waitingTask, decides: true, actor: "由你负责" });
  assert.match(attention, /<strong>等你决定<\/strong><small>等你 [^<]* · 由你负责<\/small>/);
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
  assert.match(confirm, /打开检视意见/);
  // 线程视图里当前卡照样钉在末尾:它的提交区经 portal 挂在输入框里,卡一不渲
  // 输入框就空了(用户点「看处理记录」后实锤"说给 Agent 栏没了")。
  const threaded = render({ task: waitingTask, decides: true, thread: "a-1",
    currentCard: React.createElement("div", { className: "probe-card" }, "决定卡本体") });
  assert.match(threaded, /只看这条意见的处理记录/);
  assert.match(threaded, /conv-card current"><div class="probe-card">决定卡本体/,
    "线程视图不丢当前卡");
});

test("超过一屏的历史默认折叠,给出「显示更早的 N 条」", () => {
  const many: ConversationItem[] = Array.from({ length: 60 }, (_, index) => ({
    kind: "turn", id: `turn-${index}`, ts: new Date(Date.parse(T0) + index * 60_000).toISOString(),
    end_ts: T0, open: false, texts: [{ ts: T0, text: `第 ${index} 段`, truncated: false, role: "handoff" }],
    steps: { calls: 0, errors: 0, reads: 0, edits: 0, bash: 0, agents: 0, sample: [] },
  }));
  const html = render({ items: many });
  assert.match(html, /显示更早的 10 条/);
  assert.doesNotMatch(html, /第 3 段/);
  assert.match(html, /第 59 段/);
});


test("举卡前那段话与当前卡的决策背景重复时,流里只留卡里那份;回合全是过程话时摊开最后一段", () => {
  const speech = "三条意见逐条处理如下,一条需要你补充信息:长文的边界按信息任务还是按字数?";
  const withCard = { ...task, status: "waiting_for_human",
    waiting: { waiting_id: "w3", state_version: 1, created_at: T3, context: speech,
      question: { questions: [{ question: "按哪种?" }] } } } as unknown as TaskSummary;
  const echoed: ConversationItem[] = [
    { kind: "turn", id: "turn-echo", ts: T2, end_ts: T3, open: false,
      texts: [{ ts: T2, text: "我先看一眼 spec。", truncated: false, role: "narration" },
        { ts: T3, text: speech, truncated: false, role: "handoff" }],
      steps: { calls: 1, errors: 0, reads: 1, edits: 0, bash: 0, agents: 0, sample: [] } },
  ];
  const html = render({ task: withCard, items: echoed, decides: true,
    currentCard: React.createElement("div", { className: "probe-card" }, "卡") });
  assert.doesNotMatch(html, /长文的边界按信息任务还是按字数/, "同一段字不读两遍");
  assert.match(html, /1 段过程说明/);
  const narrationOnly: ConversationItem[] = [
    { kind: "turn", id: "turn-n", ts: T2, end_ts: T3, open: true,
      texts: [{ ts: T2, text: "先读调用点。", truncated: false, role: "narration" },
        { ts: T3, text: "现在补一个条目再跑测试。", truncated: false, role: "narration" }],
      steps: { calls: 2, errors: 0, reads: 2, edits: 0, bash: 0, agents: 0, sample: [] } },
  ];
  const running = render({ items: narrationOnly });
  assert.match(running, /现在补一个条目再跑测试。/, "没有交接语时最后一段过程话摊开");
  assert.match(running, /1 段过程说明/);
  assert.match(running, /正在进行/);
});
