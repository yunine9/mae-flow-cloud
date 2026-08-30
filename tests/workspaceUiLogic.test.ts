import assert from "node:assert/strict";
import { after, test } from "node:test";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";

// Vite 的 SSR loader 负责消费前端的 TSX/CSS import；这样验证的是实际导出
// 的运行逻辑，而不是对源码做字符串匹配。本仓刻意不为前端测试引入 jsdom。
const vite = await createServer({
  root: "web",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const app = await vite.ssrLoadModule("/src/App.tsx");
const workspace = await vite.ssrLoadModule("/src/TaskWorkspace.tsx");
const taskCard = await vite.ssrLoadModule("/src/TaskCard.tsx");
const prepush = await vite.ssrLoadModule("/src/PrepushStatus.tsx");
const api = await vite.ssrLoadModule("/src/api.ts");
const annotationPanel = await vite.ssrLoadModule("/src/AnnotationPanel.tsx");

after(async () => {
  await vite.close();
});

function task(id: string, status = "running", owner = "alice") {
  return {
    id,
    requirement: `任务 ${id}`,
    status,
    created_at: "2026-08-30T00:00:00.000Z",
    luban_account: owner,
  };
}

function review(id: string, taskId: string) {
  return {
    id,
    task_id: taskId,
    task_title: `检视 ${taskId}`,
    requester: "alice",
    committer: "bob",
    status: "pending",
    created_at: "2026-08-30T00:00:00.000Z",
    delivered: true,
    attempts: 1,
  };
}

function annotation(overrides: Record<string, unknown> = {}) {
  return {
    id: "annotation-1",
    author: "alice",
    created_at: "2026-08-30T00:00:00.000Z",
    artifact: "diff",
    file: "src/example.ts",
    line: 12,
    anchor: "return result;",
    note: "请补测试",
    kind: "code",
    status: "sent",
    response: {
      revision: 0,
      outcome: "fixed",
      summary: "已补测试",
      evidence: ["tests/example.test.ts"],
      responded_at: "2026-08-30T00:01:00.000Z",
    },
    ...overrides,
  };
}

test("个人行动清单能关联别人归属的 Committer 检视，且缺详情也不吞角标", () => {
  const foreign = task("foreign", "waiting_for_human", "alice");
  const visible = app.buildPersonalActionItems({
    waiting: [],
    intervention: [],
    merges: [],
    reviews: [review("review-1", foreign.id)],
    tasks: [foreign],
  });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].task, foreign);
  assert.equal(visible[0].action, "开始检视");

  const temporarilyMissing = app.buildPersonalActionItems({
    waiting: [],
    intervention: [],
    merges: [],
    reviews: [review("review-2", "not-synced")],
    tasks: [],
  });
  assert.equal(temporarilyMissing.length, 1,
    "pending review 仍须占一项，不能让侧栏有角标而行动区显示已清空");
  assert.equal(temporarilyMissing[0].task, undefined);
  assert.equal(temporarilyMissing[0].action, "任务暂不可用");
});

test("空任务目录完成加载后能判定 /work 深链失效，加载中不抢跑", () => {
  assert.deepEqual(app.resolveWorkspaceTarget("gone", "", [], false),
    { kind: "pending" });
  assert.deepEqual(app.resolveWorkspaceTarget("gone", "", [], true),
    { kind: "missing" });
  const present = task("present");
  assert.deepEqual(app.resolveWorkspaceTarget("present", "", [present], true),
    { kind: "ready", task: present });
});

test("await_merge 的右栏明确给出合入行动，关闭 MR 给出异常行动", () => {
  assert.deepEqual(workspace.workspaceNextActionCopy({
    ...task("merge", "await_merge"),
    delivery: { mr_url: "https://code.example/mr/1" },
  }, false), {
    title: "等待检视与合入",
    detail: "前往 CodeHub 完成最后一步",
  });
  assert.equal(workspace.workspaceNextActionCopy({
    ...task("closed", "await_merge"),
    delivery: { mr_state: "已关闭" },
  }, false).title, "MR 已关闭，需要处理");
});

test("过期 push diff 不进入 GitDiff 内容，并撤销可提交的文件选择", () => {
  const stale = workspace.normalizePushReviewDiffResult({
    unavailable: "这张检视卡对应的代码已经变化，请刷新查看最新版本",
    status: 404,
  });
  assert.equal(stale.content, "");
  assert.deepEqual(stale.state, {
    kind: "error",
    message: "这张检视卡对应的代码已经变化，请刷新查看最新版本",
    expired: true,
  });
  const selection = {
    selectedPaths: ["src/a.ts"],
    committedPaths: ["src/a.ts"],
    allPaths: ["src/a.ts"],
  };
  assert.equal(workspace.usablePushReviewSelection(true, stale.state, selection),
    undefined);

  const fresh = workspace.normalizePushReviewDiffResult({
    content: "diff --git a/src/a.ts b/src/a.ts\n",
    branch: "feature/a",
  });
  assert.equal(fresh.state.kind, "ready");
  assert.equal(workspace.usablePushReviewSelection(true, fresh.state, selection),
    selection);
});

test("push diff API 保留 404 状态，供工作台识别版本失效", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: "代码已经变化",
  }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
  try {
    assert.deepEqual(await api.readPushReviewDiff("task/a", "changes"), {
      unavailable: "代码已经变化",
      status: 404,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("工作台面向用户只说实时执行日志和单元测试", () => {
  const html = renderToStaticMarkup(React.createElement(taskCard.ExecutionPanel, {
    task: task("live"),
  }));
  assert.match(html, /实时执行日志，自动跟随/);
  assert.doesNotMatch(html, /SSE/);

  for (const state of ["repairing", "blocked", "passed", "user_skipped"]) {
    assert.match(prepush.prepushViewOf(state).detail, /单元测试/);
    assert.doesNotMatch(prepush.prepushViewOf(state).detail, /\bUT\b/);
  }
  assert.equal(api.issueStageText({
    mode: "fixed",
    scenario: "ticket",
    stage: "ut",
  }), "单元测试验证");
});

test("最终交付决定卡本身能说明并控制每个文件的去留", () => {
  const deliveryTask = {
    ...task("delivery", "waiting_for_human"),
    waiting: {
      waiting_id: "wait-delivery",
      state_version: 1,
      step: "cloud_push_confirm",
      recommended_view: "diff",
      question: { questions: [{
        question: "是否按清单继续？",
        options: ["确认按清单推送", "按清单返工"],
      }] },
      choice_effects: [
        { key: "confirm", answers: ["确认按清单推送"], closes_feedback: true },
        { key: "revise", answers: ["按清单返工"], handles_feedback: true },
      ],
    },
  };
  const html = renderToStaticMarkup(React.createElement(taskCard.WaitingCard, {
    task: deliveryTask,
    onDecided: () => undefined,
    deliverySelection: {
      selectedPaths: ["src/emoji.ts"],
      committedPaths: ["src/emoji.ts", "test.log"],
      allPaths: ["src/emoji.ts", "test.log"],
    },
    onDeliverySelectionChange: () => undefined,
  }));
  assert.match(html, /本次交付范围/);
  assert.match(html, /1 \/ 2 个文件将推送/);
  assert.match(html, /src\/emoji\.ts[^]*纳入交付/);
  assert.match(html, /test\.log[^]*仅留本地/);
  assert.match(html, /按这 1 个文件推送/);
});

test("管理员旁路只开放给当前复检白名单中的他人待闭环意见", () => {
  const current = annotation();
  const access = (item: Record<string, unknown>, options: {
    viewerUsername?: string;
    reviewReady?: boolean;
    ids?: string[];
  } = {}) => annotationPanel.adminOverrideAccess({
    item,
    viewerUsername: options.viewerUsername ?? "admin",
    canOverride: true,
    reviewReady: options.reviewReady ?? true,
    reviewAnnotationIds: options.ids ?? ["annotation-1"],
  });

  assert.deepEqual(access(current), { canDrop: true, canVerify: true });
  assert.deepEqual(access(current, { ids: [] }),
    { canDrop: false, canVerify: false }, "历史意见不应沿用管理员入口");
  assert.deepEqual(access(current, { viewerUsername: "alice" }),
    { canDrop: false, canVerify: false }, "管理员自己的意见仍由本人裁决");
  assert.deepEqual(access(annotation({ status: "draft", response: undefined })),
    { canDrop: false, canVerify: false }, "他人草稿不属于管理员代办");
  assert.deepEqual(access(current, { reviewReady: false }),
    { canDrop: false, canVerify: false }, "非当前复检阶段必须默认关闭");
  assert.deepEqual(access(annotation({
    rework: 1,
    response: { ...current.response, revision: 0 },
  })), { canDrop: true, canVerify: false }, "旧一轮回复不能被误确认");
  assert.deepEqual(access(annotation({
    response: { ...current.response, outcome: "needs_clarification" },
  })), { canDrop: true, canVerify: false }, "仍需补充说明时不能代确认");
});

test("管理员危险动作必须连续确认同一条意见和同一动作", () => {
  const first = annotationPanel.advanceAdminOverrideArm(
    undefined, "annotation-1", "drop");
  assert.deepEqual(first, {
    execute: false,
    arm: { annotationId: "annotation-1", action: "drop" },
  });

  const switched = annotationPanel.advanceAdminOverrideArm(
    first.arm, "annotation-1", "verify");
  assert.equal(switched.execute, false, "切换动作只能重新武装，不能沿用第一次点击");
  assert.deepEqual(switched.arm,
    { annotationId: "annotation-1", action: "verify" });

  const second = annotationPanel.advanceAdminOverrideArm(
    switched.arm, "annotation-1", "verify");
  assert.deepEqual(second, { execute: true, arm: undefined });
});

test("批注面板显示受限管理员入口和实际代确认审计", () => {
  const common = {
    taskId: "task-1",
    viewerUsername: "admin",
    checks: [],
    canOperate: false,
    canOverride: true,
    taskStatus: "waiting_for_human",
    reviewReady: true,
    mergeRequestOpen: true,
    onChanged: () => undefined,
  };
  const current = annotation();
  const eligibleHtml = renderToStaticMarkup(React.createElement(
    annotationPanel.AnnotationPanel,
    { ...common, items: [current], reviewAnnotationIds: [current.id] },
  ));
  assert.match(eligibleHtml, />管理员代删<\/button>/);
  assert.match(eligibleHtml, />管理员代确认<\/button>/);
  assert.match(eligibleHtml, /第一次点击只会进入确认/);

  const historicalHtml = renderToStaticMarkup(React.createElement(
    annotationPanel.AnnotationPanel,
    { ...common, items: [current], reviewAnnotationIds: [] },
  ));
  assert.doesNotMatch(historicalHtml, />管理员代删<\/button>/);
  assert.doesNotMatch(historicalHtml, />管理员代确认<\/button>/);

  const auditedHtml = renderToStaticMarkup(React.createElement(
    annotationPanel.AnnotationPanel,
    {
      ...common,
      reviewReady: false,
      items: [annotation({ status: "verified", verified_by: "ops-admin" })],
      reviewAnnotationIds: [],
    },
  ));
  assert.match(auditedHtml, /管理员 ops-admin 代确认/);
  assert.match(auditedHtml, /批注作者 alice/);
  assert.doesNotMatch(auditedHtml, /你已确认/);
});
