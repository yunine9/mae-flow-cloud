/**
 * 问题流 × 人工介入程度(月光轴,ADR-0006)的契约测试:
 * - 机械层:analysis_confirm 月光全量代答;conclude 仅 non_issue+高置信
 *   代答(闭环无下游闸,分级保守);缺省(回调缺席)一律等真人;
 * - Agent 卡(AskUserQuestion):月光开 + 纯选项题卡按推荐项整卡代答,
 *   开放题/混卡/检视回合/月光关整卡等人(T2,ADR-0006 口径扩展);
 * - 作答走 answer() 同一裁决通道:现场账、阶段推进与真人作答同款;
 * - 提示层:开场词/续聊词按月光现值渲染「介入节奏」。
 *
 * 范式与 issueFlowNotify.test.ts 同款:ScriptedModelServer 剧本,
 * 只走公开 API 断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import {
  issueFixedOpeningPrompt,
  issueResumePrompt,
} from "../src/issueFlow/prompt.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";

const TICKET = "DTS-2026-1001";
const MODULE_ID = "pay-core";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交的裸仓远端(拉仓目标),返回其路径。 */
function bareOrigin(root: string): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
}

function seedModule(dataDir: string, repoUrl: string): void {
  createBusinessModule(dataDir, {
    id: MODULE_ID, name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [repoUrl],
  }, "tester");
}

const NO_TICKET_ENV = {
  hosts: ["10.0.0.8"],
  pagePassword: "page-secret",
  backendPassword: "env-shared-secret",
};

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function baseOptions(dataDir: string, model: ScriptedModelServer) {
  return {
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts: new MockDtsGateway(),
  };
}

/** 四要素合规的分析报告(门票校验过得了)。 */
const REPORT = "printf '# 问题分析\\n\\n现象:登录超时。\\n## 问题现象\\n演示现象。\\n## 问题根因\\n"
  + "非问题(测试环境时钟漂移)。\\n## 证据链\\n时钟偏差记录。\\n## 置信度\\n"
  + "高:偏差可复现。\\n## 修改方案\\n校时后观察,建议归档。\\n"
  + "' > issue-analysis.md";

test("月光开:有单分析闸全量代答,自动确认进问题修改", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-moon-ticket-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command: REPORT } } },
    { tool: { name: "submit_analysis",
      input: { summary: "非问题:时钟漂移" } } },
    { text: "报告已提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    moonlight: () => true,
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
      repoUrl: origin,
    });
    // 自动确认后推进到「问题修改」;脚本耗尽的修改回合催办耗尽转
    // idle,最终停在 fix 阶段——从没等过人。
    const advanced = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.stage === "fix" ? issue : undefined;
    }, "月光自动确认推进到问题修改");
    assert.equal(advanced.gate ?? undefined, undefined,
      "确认闸已被代答清掉,不再等用户");
    await until(() => service.get(created.id).status === "idle"
      ? true : undefined, "修改回合收口");
    const events = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8");
    assert.ok(events.includes("月光免审批自动确认"),
      "现场账必须记录这是系统代答,不是用户作答");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("月光开:无单 non_issue 且自报高置信,自动闭环归档", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-moon-close-"));
  const origin = bareOrigin(dataDir);
  seedModule(dataDir, origin);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command: REPORT } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "non_issue", confidence: "high",
        summary: "非问题:时钟漂移" } } },
    { text: "结论已提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    moonlight: () => true,
  });
  try {
    const created = service.create({
      account: "dev", title: "列表导出超时", repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    const archived = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "archived" ? issue : undefined;
    }, "月光自动闭环归档");
    assert.equal(archived.conclusion?.kind, "non_issue");
    const events = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8");
    assert.ok(events.includes("月光免审批自动确认"), "现场账记录代答");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("月光开但分级不满足:issue 结论、缺置信度、月光关,一律等真人", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-moon-guard-"));
  const origin = bareOrigin(dataDir);
  seedModule(dataDir, origin);
  // 三种都不代答:是问题(挂起后果重)/没自报置信度(宁人工勿猜)/
  // 月光关(缺省行为,向后兼容)。
  const cases: Array<{ label: string; moonlight?: boolean; conclusion:
    "issue" | "non_issue"; confidence?: "high" | "medium" | "low" }> = [
    { label: "是问题必人工", moonlight: true, conclusion: "issue",
      confidence: "high" },
    { label: "缺置信度不代答", moonlight: true, conclusion: "non_issue" },
    { label: "月光关不代答", conclusion: "non_issue", confidence: "high" },
  ];
  for (const item of cases) {
    const script: Scene[] = [
      { tool: { name: "pull_repo", input: { url: origin } } },
      { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
      { tool: { name: "bash", input: { command: REPORT } } },
      { tool: { name: "submit_analysis",
        input: { conclusion: item.conclusion, summary: "结论:演示",
          ...(item.confidence ? { confidence: item.confidence } : {}) } } },
      { text: "结论已提交。" },
    ];
    const model = new ScriptedModelServer(script, "scripted-v1",
      { linear: true });
    await model.start();
    const service = new IssueFlowService({
      ...baseOptions(dataDir, model),
      ...(item.moonlight === undefined
        ? {} : { moonlight: () => item.moonlight }),
    });
    try {
      const created = service.create({
        account: "dev", title: "列表导出超时", repoUrl: origin,
        moduleId: MODULE_ID, environment: NO_TICKET_ENV,
      });
      const gate = await until(() => {
        const issue = service.get(created.id);
        if (issue.status === "failed") {
          throw new Error(issue.error ?? "failed");
        }
        return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
          ? issue : undefined;
      }, `结论闸等真人(${item.label})`);
      assert.equal(gate.gate?.proposal?.conclusion, item.conclusion);
      assert.equal(gate.status, "waiting_user", item.label);
      await new Promise((resolve) => setTimeout(resolve, 200),
      );
      assert.equal(service.get(created.id).status, "waiting_user",
        `${item.label}: settled 后仍必须等真人,不被代答`);
    } finally {
      await service.shutdown().catch(() => undefined);
      await model.stop();
    }
  }
});

test("提示层:开场词与续聊词按月光现值渲染介入节奏", () => {
  const state = {
    id: "issue-1", scenario: "ticket", stage: "analyze",
    title: "登录超时", description: "", account: "dev", ticket: TICKET,
  } as unknown as IssueSessionState;
  const on = issueFixedOpeningPrompt(state, {}, { moonlight: true });
  const off = issueFixedOpeningPrompt(state, {}, { moonlight: false });
  assert.match(on, /介入节奏\(月光免审批,开\)/,
    "月光档:少问、不中间简报、报告会被自动确认");
  assert.match(on, /无需补充即可执行/);
  assert.match(off, /介入节奏\(高把关\)/, "把关档:主动问与对齐");
  assert.doesNotMatch(off, /月光免审批/);
  const resumeOn = issueResumePrompt(state, "继续", {}, { moonlight: true });
  const resumeOff = issueResumePrompt(state, "继续", {}, { moonlight: false });
  assert.match(resumeOn, /月光免审批\(开\)/);
  assert.match(resumeOff, /高把关——证据不足主动问/);
});

// ---- Agent 卡代答(T2,ADR-0006 口径扩展) ----

const LINK_BASE = "https://mfc.example.com";

function makeNotifier(luban: FakeLubanServer): Notifier {
  return new Notifier({
    endpoint: luban.endpoint,
    backoffMs: [0],
  });
}

/** waiting.json 原始记录(磁盘态:选项是字符串原文,无投影码)。 */
function waitingRecords(
  dataDir: string,
  issueId: string,
): Array<Record<string, unknown>> {
  const raw = JSON.parse(readFileSync(
    join(dataDir, "issues", issueId, "waiting.json"), "utf-8")) as {
    records: Record<string, Record<string, unknown>>;
  };
  return Object.values(raw.records);
}

function eventsFile(dataDir: string, issueId: string): string {
  return readFileSync(
    join(dataDir, "issues", issueId, "events.jsonl"), "utf-8");
}

test("月光开:纯选项题 Agent 卡按推荐项整卡代答,续跑+留痕+通知照发", async () => {
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: {
      context: "已对齐两个候选修复方案",
      questions: [{
        question: "采用哪个修复方案?",
        options: ["方案A:超时回收", "方案B:扩容连接池"],
        recommended: "方案A:超时回收",
      }, {
        question: "是否同步更新运行手册?",
        options: ["更新", "暂不更新"],
        recommended: "暂不更新",
      }],
    } } },
    { text: "两题都按推荐处理完毕,本回合到此。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = makeNotifier(luban);
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-moon-card-"));
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    notifier,
    linkBase: LINK_BASE,
    // 固定流程同享:有单登记不拦,开场即举 Agent 卡,代答牙齿照硬。
    moonlight: () => true,
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
    });
    // 卡落地即被代答:两题各按推荐项的决策码作答,续跑收口 idle——
    // 从没等过人。
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "月光代答 Agent 卡后续跑收口");
    assert.equal(service.get(created.id).waiting ?? undefined, undefined,
      "卡已被 resolve,不再等用户");
    // 入账与真人页面作答同形:决策码还原成选项原文(decision),
    // 机器代答留痕在 notes——过程问答与现场导出都投影它。
    const records = waitingRecords(dataDir, created.id);
    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record.status, "resolved");
    assert.equal(record.decision, "方案A:超时回收\n暂不更新",
      "决策码还原成选项原文,与真人作答时代一致");
    assert.equal(
      record.notes,
      "月光免审批自动作答(推荐项:方案A:超时回收、暂不更新)");
    const events = eventsFile(dataDir, created.id);
    assert.ok(events.includes("月光免审批自动作答"),
      "现场账必须记录这是系统代答,不是用户作答");
    assert.ok(events.includes("两题都按推荐处理完毕"),
      "作答后走 resumeWithDecision 续跑,剧本下一幕真的执行了");
    // 小鲁班 outcome 通知照发:台账记录人话摘要,投递载荷带工作台链接。
    const outcome = await until(() =>
      notifier.list().find((item) => item.summary.includes("月光免审批")),
      "代答 outcome 通知落台账");
    assert.ok(outcome.summary.includes("按推荐项自动作答"));
    assert.equal(outcome.link, `${LINK_BASE}/issues/${created.id}`);
    const delivered = await until(() =>
      luban.messages.find((message) =>
        String(message.link ?? "") === `${LINK_BASE}/issues/${created.id}`
        && String(message.text ?? "").includes("月光免审批")),
      "代答 outcome 通知投递到假小鲁班");
    assert.ok(delivered, "投递载荷带链接与代答说明");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await luban.stop();
  }
});

test("月光开:开放题卡与混卡整卡等人,不做半卡代答;月光关同样等人", async () => {
  const cases: Array<{
    label: string;
    moonlight?: boolean;
    questions: Array<Record<string, unknown>>;
  }> = [
    {
      label: "开放题卡",
      moonlight: true,
      questions: [{ question: "复现步骤具体是什么?" }],
    },
    {
      label: "混卡(选项题+开放题)",
      moonlight: true,
      questions: [{
        question: "采用哪个修复方案?",
        options: ["方案A:超时回收", "方案B:扩容连接池"],
        recommended: "方案A:超时回收",
      }, { question: "补充说明?" }],
    },
    {
      label: "月光关",
      questions: [{
        question: "采用哪个修复方案?",
        options: ["方案A:超时回收", "方案B:扩容连接池"],
        recommended: "方案A:超时回收",
      }],
    },
  ];
  for (const item of cases) {
    const script: Scene[] = [
      { tool: { name: "AskUserQuestion", input: {
        questions: item.questions,
      } } },
    ];
    const model = new ScriptedModelServer(script, "scripted-v1",
      { linear: true });
    await model.start();
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-moon-hold-"));
    const service = new IssueFlowService({
      ...baseOptions(dataDir, model),
      ...(item.moonlight === undefined
        ? {} : { moonlight: () => item.moonlight }),
    });
    try {
      const created = service.create({
        account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
      });
      const issue = await until(() => {
        const current = service.get(created.id);
        if (current.status === "failed") {
          throw new Error(current.error ?? "failed");
        }
        return current.status === "waiting_user" && current.waiting
          ? current : undefined;
      }, `卡落地等真人(${item.label})`);
      assert.ok(issue.waiting, item.label);
      // 代答是收口后的 setTimeout 旁路:等过这个窗口还在等,就是真等人。
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(service.get(created.id).status, "waiting_user",
        `${item.label}:整卡等人,不被代答`);
      const [record] = waitingRecords(dataDir, created.id);
      assert.equal(record.status, "waiting", `${item.label}:卡未被碰`);
      assert.equal(record.decision, "", `${item.label}:没有任何代答入账`);
      assert.doesNotMatch(
        eventsFile(dataDir, created.id), /月光免审批自动作答/,
        `${item.label}:不落代答留痕`);
    } finally {
      await service.shutdown().catch(() => undefined);
      await model.stop();
    }
  }
});

test("月光开:检视回合中的 Agent 卡永不代答(ADR-0007 口径延伸)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-moon-review-"));
  const origin = bareOrigin(dataDir);
  seedModule(dataDir, origin);
  // 线性剧本按请求数推进幕:cardA(代答续跑)→ 三幕文本(两次催办耗尽
  // 转 idle)→ 第 5 个请求正好落在检视回合的续聊上,举出 cardB。
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: {
      questions: [{
        question: "先查登录网关还是先查会话服务?",
        options: ["先查登录网关", "先查会话服务"],
        recommended: "先查登录网关",
      }],
    } } },
    { text: "第一轮按推荐项处理。" },
    { text: "继续推进。" },
    { text: "第一轮收尾。" },
    { tool: { name: "AskUserQuestion", input: {
      questions: [{
        question: "检视回合:修订按哪个方向落?",
        options: ["方向一:收紧超时阈值", "方向二:改用重试"],
        recommended: "方向一:收紧超时阈值",
      }],
    } } },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    moonlight: () => true,
  });
  try {
    const created = service.create({
      account: "dev", title: "列表导出超时", repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "第一轮卡被代答后催办耗尽转 idle");
    const [firstCard] = waitingRecords(dataDir, created.id);
    assert.equal(firstCard.status, "resolved",
      "前置事实:检视前的纯选项题卡确实被月光代答了");
    // 提交检视 = 整体回退,review_active 置位;续跑回合里 Agent 举 cardB。
    service.addReview(created.id, {
      line: 1, anchor: "第一轮按推荐项处理。",
      note: "请补充日志时间窗的证据",
    });
    service.submitReviews(created.id);
    const reviewCard = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.waiting ? issue : undefined;
    }, "检视回合的 Agent 卡落地等真人");
    assert.ok(
      JSON.stringify(reviewCard.waiting?.question ?? "").includes("检视回合"),
      "在场的是检视回合举的新卡");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(service.get(created.id).status, "waiting_user",
      "检视回合的卡整段跳过代答");
    const records = waitingRecords(dataDir, created.id);
    const secondCard = records.find((record) =>
      String((record.question as { questions?: Array<{ question?: string }> })
        ?.questions?.[0]?.question ?? "").includes("检视回合"));
    assert.ok(secondCard, "检视回合的卡在场");
    assert.equal(secondCard!.status, "waiting", "卡未被代答");
    assert.equal(
      records.filter((record) =>
        String(record.notes ?? "").includes("月光免审批自动作答")).length,
      1,
      "全程只有检视前那一卡被代答,检视回合的卡不追溯");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("月光开:盘上有平台闸走闸代答,Agent 卡不被碰(闸优先)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-moon-gate-"));
  // 同一回合先举 env_needed 闸(拉日志缺网管环境,工具如实失败),
  // 再举 Agent 卡:收口时闸与卡同时在盘。env 闸月光永不代答,Agent 卡
  // 又因闸在场轮不到——两者都必须原地等真人。
  const script: Scene[] = [
    { tool: { name: "fetch_logs", input: { services: ["TranFmaWebsite"] } } },
    { tool: { name: "AskUserQuestion", input: {
      questions: [{
        question: "先按哪个思路排查?",
        options: ["先看线程池", "先看连接池"],
        recommended: "先看连接池",
      }],
    } } },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    // opsTools 在场才会走到「缺网管环境举 env_needed 闸」这一步。
    opsTools: {
      async fetchLogs() { return { summary: "测试假件" }; },
      async buildDeploy() { return { summary: "测试假件" }; },
    },
    moonlight: () => true,
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "env_needed"
        ? issue : undefined;
    }, "同回合举闸又举卡后收口等真人");
    // 通知与人话口径:闸在场时只 notifyWaitingCard 闸卡,无任何代答
    // (env 闸永不代、Agent 卡闸优先不代)——代答与不代都现读现判。
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(service.get(created.id).gate?.kind, "env_needed",
      "env 闸原地等人(月光永不代)");
    const [record] = waitingRecords(dataDir, created.id);
    assert.equal(record.status, "waiting", "Agent 卡未被代答(闸优先)");
    assert.equal(record.decision, "");
    assert.doesNotMatch(
      eventsFile(dataDir, created.id), /月光免审批自动作答/,
      "Agent 卡没有落代答留痕");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("月光中途打开:已挂起的卡不追溯代答(只在卡落地时判定)", async () => {
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: {
      questions: [{
        question: "采用哪个修复方案?",
        options: ["方案A:超时回收", "方案B:扩容连接池"],
        recommended: "方案A:超时回收",
      }],
    } } },
    { text: "按推荐处理完毕,本回合到此。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-moon-retro-"));
  // 月光开成可翻转的:卡落地时关,落地后再开——追溯与否看这张测试。
  let moon = false;
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    moonlight: () => moon,
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" ? issue : undefined;
    }, "月光关:卡落地等真人");
    // 现读现判的边界:设置翻转只对后续到达的卡生效,已挂起的卡不追溯
    // 代答(与需求流同口径——代答只发生在卡到达的那一刻)。
    moon = true;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const [record] = waitingRecords(dataDir, created.id);
    assert.equal(record.status, "waiting", "已挂起的卡不被追溯代答");
    assert.equal(record.decision, "", "没有任何答案被冒名提交");
    assert.doesNotMatch(
      eventsFile(dataDir, created.id), /月光免审批自动作答/,
      "追溯代答会留痕,现场账必须干净");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
