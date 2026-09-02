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
const lubanTokenCard = await vite.ssrLoadModule("/src/LubanTokenCard.tsx");

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

test("个人小鲁班已配置时显示连通测试，未配置时只引导配置", () => {
  const ready = renderToStaticMarkup(React.createElement(
    lubanTokenCard.LubanTokenCard,
    { session: {
      username: "alice", role: "developer", luban_token_hint: "••••cret",
    } },
  ));
  assert.match(ready, />测试连通性<\/button>/);
  assert.match(ready, />更新 Token<\/button>/);

  const missing = renderToStaticMarkup(React.createElement(
    lubanTokenCard.LubanTokenCard,
    { session: { username: "bob", role: "developer" } },
  ));
  assert.doesNotMatch(missing, /测试连通性/);
  assert.match(missing, />配置小鲁班<\/button>/);
});

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

test("检视返工不把内部第 0 轮显示成流水线修复轮次", () => {
  assert.equal(api.statusText({
    status: "running",
    delivery: { loop: { state: "repairing", kind: "review", round: 0, max: 2 } },
  }), "正在按检视意见修改");
  assert.equal(api.statusText({
    status: "verifying",
    delivery: { loop: { state: "repairing", kind: "ci", round: 1, max: 2 } },
  }), "流水线修复中");
});

test("圈注权与发送权拆开，需求原文批注能回到原文视图", () => {
  assert.equal(workspace.canCreateWorkspaceAnnotation("completed"), true,
    "已交付任务仍可留下交付后记录");
  assert.equal(workspace.canCreateWorkspaceAnnotation("canceled"), false,
    "用户明确停止的任务不再新增记录");
  assert.equal(workspace.materialViewForAnnotation(
    api.TASK_REQUIREMENT_ARTIFACT, []), "source");
  assert.equal(workspace.materialViewForAnnotation("changes.diff", [
    { name: "changes.diff", label: "代码差异", kind: "diff", bytes: 1 },
  ]), "diff");
  assert.deepEqual(workspace.decisionAnnotationIds([
    annotation({ id: "mine", status: "draft", author: "alice" }),
    annotation({ id: "visitor", status: "draft", author: "visitor" }),
    annotation({ id: "sent", status: "sent", author: "alice" }),
  ], "alice"), ["mine"],
  "决定只能携带当前操作者自己的未送达草稿");
});

test("流水线证据缺口直接打开补证材料，用户切走后不被轮询抢回", () => {
  const gap = {
    name: "pipeline/流水线证据缺口.md",
    label: "流水线证据缺口.md",
    kind: "doc",
    purpose: "pipeline_evidence_gap",
    bytes: 120,
    modified_at: "2026-08-30T00:00:00.000Z",
  };
  const spec = {
    name: "REQ1/spec.md", label: "spec.md", kind: "doc", bytes: 100,
    modified_at: "2026-08-30T00:01:00.000Z",
  };
  const evidenceTask = {
    ...task("gap", "verifying"),
    delivery: { evidence_gap: {
      sha: "a".repeat(40), state: "waiting_human",
      missing_dimensions: ["COMPILE"], available_dimensions: [],
      reasons: ["日志缺失"], attempts: 3,
    } },
  };
  assert.equal(workspace.pipelineEvidenceNeedsHuman(evidenceTask), true);
  assert.equal(workspace.defaultWorkspaceView(evidenceTask), "materials",
    "补证是明确的人工作业，不能仍默认打开执行现场");
  assert.equal(workspace.preferredWorkspaceArtifact(
    [spec, gap], "", undefined, true), gap.name,
  "点名的补证材料优先于最近修改排序");
  assert.equal(workspace.preferredWorkspaceArtifact(
    [spec, gap], spec.name, undefined, true), spec.name,
  "用户主动切换后的有效选择不能被后台刷新抢走");
  assert.equal(workspace.pipelineEvidenceNeedsHuman({
    ...evidenceTask,
    delivery: { evidence_gap: {
      ...evidenceTask.delivery.evidence_gap, state: "retrying",
    } },
  }), false, "系统仍在自动重试时不冒充人工待办");
});

test("已交付批注明确是归档记录，不再冒充待提交", () => {
  const html = renderToStaticMarkup(React.createElement(
    annotationPanel.AnnotationPanel,
    {
      taskId: "task-done",
      viewerUsername: "visitor",
      items: [annotation({
        status: "draft", author: "visitor",
        artifact: api.TASK_REQUIREMENT_ARTIFACT,
        file: "需求原文",
      })],
      checks: [],
      canOperate: false,
      taskStatus: "completed",
      mergeRequestOpen: false,
      onChanged: () => undefined,
    },
  ));
  assert.match(html, /交付后记录/);
  assert.match(html, /已保存在本任务档案中/);
  assert.doesNotMatch(html, /条待提交/);
  assert.doesNotMatch(html, />提交 1 条/);
});

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

test("最终交付决定卡只显示范围摘要，文件去留统一留在左侧 diff", () => {
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
    unresolvedAnnotationCount: 3,
    onDeliverySelectionChange: () => undefined,
  }));
  assert.match(html, /本次交付范围/);
  assert.match(html, /1 \/ 2 个文件将推送/);
  assert.match(html, /文件去留在左侧代码差异中调整/);
  assert.doesNotMatch(html, /交付文件清单|全部纳入|全部仅留本地/);
  assert.doesNotMatch(html, /src\/emoji\.ts|test\.log/);
  assert.match(html, /当前有 3 条检视意见未闭环/);
  assert.match(html, /建议选择“按清单返工”/);
  assert.doesNotMatch(html, /当前卡片缺少调整选项/);
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

test("普通流程批注在 Agent 再次举卡后可由作者闭环，不依赖 MR 复检状态", () => {
  const common = {
    taskId: "task-1",
    viewerUsername: "alice",
    checks: [],
    canOperate: true,
    canOverride: false,
    taskStatus: "waiting_for_human",
    reviewReady: false,
    reviewAnnotationIds: [],
    mergeRequestOpen: false,
    onChanged: () => undefined,
  };
  const ordinary = annotation({ sent_via: "decision", response: undefined });
  assert.equal(annotationPanel.authorVerdictReady(
    ordinary, "waiting_for_human", false), true);
  const html = renderToStaticMarkup(React.createElement(
    annotationPanel.AnnotationPanel,
    { ...common, items: [ordinary] },
  ));
  assert.match(html, /Agent 已再次回到人工检视/);
  assert.match(html, />仍需调整<\/button>/);
  assert.match(html, />确认已修复<\/button>/);

  assert.equal(annotationPanel.authorVerdictReady(
    ordinary, "running", false), false,
  "Agent 仍在修改时不能提前验收");
  assert.equal(annotationPanel.authorVerdictReady(
    annotation({ sent_via: "queued_decision", response: undefined }),
    "waiting_for_human", false), false,
  "只登记、尚未真正送达 Agent 的意见不能立即验收");
  assert.equal(annotationPanel.authorVerdictReady(
    annotation({ sent_via: "review_repair" }),
    "waiting_for_human", false), false,
  "MR 修复仍必须等 Build-Fix 与复检卡");
  assert.equal(annotationPanel.authorVerdictReady(
    annotation({ sent_via: "review_repair", response: undefined }),
    "waiting_for_human", true), false,
  "MR 修复缺逐条回执时不能误开放通过");
});

test("三类检视意见显示各自责任与动作，旧意见仍按 Agent 处理", () => {
  const common = {
    taskId: "task-routing",
    checks: [],
    canOperate: true,
    canOverride: false,
    taskStatus: "running",
    reviewReady: false,
    reviewAnnotationIds: [],
    mergeRequestOpen: false,
    onChanged: () => undefined,
  };
  const waitingOwner = annotation({
    id: "owner-question", author: "reviewer", route: "owner_reply",
    assignee: "owner", sent_via: "owner_pending", response: undefined,
  });
  const ownerHtml = renderToStaticMarkup(React.createElement(
    annotationPanel.AnnotationPanel,
    { ...common, viewerUsername: "owner", items: [waitingOwner] },
  ));
  assert.match(ownerHtml, /责任人答复 · owner/);
  assert.match(ownerHtml, /等待责任人答复/);
  assert.match(ownerHtml, />回答这条意见<\/button>/);
  assert.doesNotMatch(ownerHtml, /Agent：已处理/);

  const answered = annotation({
    ...waitingOwner,
    owner_reply: {
      author: "owner", text: "旧接口不支持多通道",
      replied_at: "2026-08-30T00:02:00.000Z",
    },
  });
  assert.equal(annotationPanel.authorVerdictReady(
    answered, "running", false), true,
  "责任人已经答复时，提出人不必等任务进入人工阶段即可确认");
  const reviewerHtml = renderToStaticMarkup(React.createElement(
    annotationPanel.AnnotationPanel,
    { ...common, viewerUsername: "reviewer", items: [answered] },
  ));
  assert.match(reviewerHtml, /旧接口不支持多通道/);
  assert.match(reviewerHtml, />仍有疑问<\/button>/);
  assert.match(reviewerHtml, />确认已解答<\/button>/);

  const decisionHtml = renderToStaticMarkup(React.createElement(
    annotationPanel.AnnotationPanel,
    { ...common, viewerUsername: "owner", items: [annotation({
      id: "owner-decision", author: "reviewer", route: "owner_decision",
      assignee: "owner", sent_via: "owner_pending", response: undefined,
    })] },
  ));
  assert.match(decisionHtml, /决策后处理 · owner/);
  assert.match(decisionHtml, />作出决定<\/button>/);
});

test("MR 复检把真正可操作的意见置顶成待确认卡，缺回执时不说已有按钮", () => {
  const actionable = annotation({
    id: "review-actionable",
    file: "src/actionable.ts",
    sent_via: "review_repair",
  });
  const clarification = annotation({
    id: "review-clarification",
    file: "src/clarification.ts",
    sent_via: "review_repair",
    response: {
      revision: 0,
      outcome: "needs_clarification",
      summary: "需要补充边界",
      evidence: [],
      responded_at: "2026-08-30T00:01:00.000Z",
    },
  });
  const missing = annotation({
    id: "review-missing",
    file: "src/missing.ts",
    sent_via: "review_repair",
    response: undefined,
  });
  const history = annotation({
    id: "review-history",
    file: "src/history.ts",
    status: "verified",
    sent_via: "review_repair",
  });
  const html = renderToStaticMarkup(React.createElement(
    annotationPanel.AnnotationPanel,
    {
      taskId: "task-review",
      viewerUsername: "alice",
      items: [history, missing, actionable, clarification],
      checks: [],
      canOperate: true,
      taskStatus: "waiting_for_human",
      reviewReady: true,
      reviewAnnotationIds: [actionable.id, clarification.id, missing.id],
      mergeRequestOpen: true,
      onChanged: () => undefined,
    },
  ));
  assert.match(html, /待我确认/);
  assert.match(html, /2 项/);
  assert.match(html, /Agent 已处理你提出的 2 条意见/);
  assert.match(html, /另有 1 条意见的当前轮逐条回执尚未就绪/);
  assert.match(html, />仍需调整<\/button>/);
  assert.match(html, />确认已修复<\/button>/);
  assert.match(html, />补充说明后重提<\/button>/);
  assert.ok(html.indexOf("src/actionable.ts") < html.indexOf("src/history.ts"),
    "待确认卡必须排在历史记录前面");
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
