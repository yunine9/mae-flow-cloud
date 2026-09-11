/**
 * 回合前压缩(.scratch/issue-stage-compact 两张票)的契约测试。
 *
 * 钉的机械事实:
 * - analysis_confirm 确认进 fix 的续聊前必压一次,锚点钉住分析报告
 *   落盘路径与「修改方案」章节要点(不受阈值管辖);
 * - 其余续聊回合只看事件量阈值旋钮 issue_compact_every_events:
 *   缺省 0=关,行为与现状全等;到阈值压通用锚(不带报告指针);
 * - 压缩 fail-open:模型端压不动,回合照走,单子不判死。
 *
 * 挂起通道(resumeWithDecision)与重启重建(startResume)结构性不
 * 经过咽喉(resumeTurnBody 的 continueWith 之前),这里不再单测。
 * 观测面:pi 的 compact 是一次不带工具表的真实模型请求(回合内的
 * 模型调用都带 tools)——linear 剧本要为每次压缩留一幕。
 * vendor 边界(pi 1.x 实测):单回合历史的手动压缩走 split-turn 路,
 * customInstructions 不进摘要请求——边界指针因此同时钉进确认推进
 * 通知词(必达),测试分别钉这两条通道。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { mfcTemp } from "./mfcTmp.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
} as NodeJS.ProcessEnv;

/** 带初始提交的裸仓远端(pull_repo 的拉取目标)。 */
function bareOrigin(root: string): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
}

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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const TICKET = "DTS-2026-2001";

/** 压缩请求的识别:pi 的压缩不带工具表;回合内的模型调用都带。
 *  这些剧本里没有第二个无工具请求(无子会话/无视觉旁路)。 */
function compactionRequests(model: ScriptedModelServer) {
  return model.requests.filter((request) => !("tools" in request));
}

/** 首轮七幕:拉单→收口→拉仓→收口→写报告→提交举闸→回合结束。
 *  末幕是一大段排查全记录(~160KB):pi 的手动压缩有"会话太小不压"
 *  的前置(keepRecentTokens≈2 万估算 token),小会话会在
 *  prepareCompaction 就被拒——喂大末幕让压缩真正走到模型端,这也
 *  正是边界压缩要对抗的真实形态(过程性长输出撑爆上下文)。 */
function firstRoundScenes(origin: string): Scene[] {
  return [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n\\n现象:登录超时。\\n## 问题现象\\n演示现象。\\n## 问题根因\\n连接池耗尽。\\n## 证据链\\n日志:连接池耗尽。\\n## 置信度\\n高:日志直接指向。\\n## 修改方案\\n超时回收:web/src/auth/reclaim.ts 超时回调改双检。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽,方案=超时回收" } } },
    { text: "排查过程全记录(测试填充,替真实长日志):\n"
      + "排查日志行 x".repeat(14_000) },
  ];
}

/** 修复回合两幕:提交一笔修复→回合结束。 */
const fixScenes: Scene[] = [
  { tool: { name: "bash", input: { command: "echo fix-round" } } },
  { text: "修复回合完成。" },
];

/** 二轮修订三幕:补报告→重新提交→回合结束(闸再举)。 */
const revisionScenes: Scene[] = [
  { tool: { name: "bash", input: { command:
    "printf '\\n## 第二轮补充\\n\\n按补充意见修订。\\n' >> issue-analysis.md" } } },
  { tool: { name: "submit_analysis",
    input: { summary: "二轮:按补充意见修订" } } },
  { text: "二轮分析已提交。" },
];

const noKnob = () => ({});

interface Harness {
  service: IssueFlowService;
  model: ScriptedModelServer;
  id: string;
  gateVersion: number;
}

/** 走到首轮分析确认闸的公共现场:建服务→登记→等闸。 */
async function atAnalysisGate(
  dataDir: string,
  runtime: () => Record<string, number | undefined>,
  scriptOf: (origin: string) => Scene[],
): Promise<Harness> {
  const origin = bareOrigin(dataDir);
  const model = new ScriptedModelServer(scriptOf(origin), "scripted-v1",
    { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: { models: () => ({}), runtime },
    dts: new MockDtsGateway(),
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  const created = service.create({
    account: "dev",
    title: "登录超时",
    ticket: TICKET,
    source: "dts",
    repoUrl: origin,
    environment: { hosts: ["10.0.0.8"], backendPassword: "env-shared-secret" },
  });
  const gate = await until(() => {
    const issue = service.get(created.id);
    if (issue.status === "failed") throw new Error(issue.error ?? "failed");
    return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
      ? issue : undefined;
  }, "首轮分析确认闸");
  assert.equal(gate.stage, "analyze");
  return { service, model, id: created.id, gateVersion: gate.gate!.state_version };
}

/** 等下一个分析确认闸(二轮),失败态如实抛。 */
async function nextAnalysisGate(h: Harness) {
  return until(() => {
    const issue = h.service.get(h.id);
    if (issue.status === "failed") throw new Error(issue.error ?? "failed");
    return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
      && issue.gate.state_version > h.gateVersion ? issue : undefined;
  }, "二轮分析确认闸");
}

test("分析→修复边界:确认后的续聊前必压一次,锚点钉住报告路径与修改方案要点", async () => {
  const dataDir = mfcTemp("mfc-issue-compact-boundary-");
  // 阈值旋钮缺席(缺省关):边界必压不受阈值管辖,恰好证明这一点。
  // 压缩摘要占一幕,其后是修复回合。
  const h = await atAnalysisGate(dataDir, noKnob,
    (origin) => [...firstRoundScenes(origin),
      { text: "上下文已按锚点压缩。" }, ...fixScenes]);
  const { service, model, id } = h;
  try {
    service.answer(id, { state_version: h.gateVersion, code: "confirm" });
    assert.equal(service.get(id).stage, "fix", "确认即推进到修复段");
    await until(() => {
      const issue = service.get(id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" && issue.stage === "fix" ? issue : undefined;
    }, "边界压缩后的修复回合收口");
    const compactions = compactionRequests(model);
    assert.equal(compactions.length, 1, "确认后的续聊前恰压一次");
    // 指针走必达通道:压缩后的第一个回合请求携带推进通知词,钉住
    // 报告路径与方案要点——单回合历史上 pi 的摘要请求不带自定义锚
    // (split-turn 路),指针不能指望摘要。
    const compactAt = model.requests.findIndex((r) => !("tools" in r));
    assert.ok(compactAt >= 0, "压缩请求在场");
    const continuation = JSON.stringify(model.requests[compactAt + 1]);
    assert.match(continuation, /报告: [^"]*issue-analysis\.md/,
      "推进通知词钉住报告落盘路径");
    assert.ok(continuation.includes("修改方案要点"), "通知词含方案章节标目");
    assert.ok(continuation.includes("超时回调改双检"), "通知词含方案要点原文");
  } finally {
    await model.stop();
  }
});

test("边界压缩 fail-open:模型端压不动,推进照常,单子不判死", async () => {
  const dataDir = mfcTemp("mfc-issue-compact-failopen-");
  const h = await atAnalysisGate(dataDir, noKnob,
    (origin) => [...firstRoundScenes(origin),
      { text: "(被 failWith 吞掉的压缩摘要幕)" }, ...fixScenes]);
  const { service, model, id } = h;
  try {
    // 让下一次模型请求(恰是边界压缩)以网关错误告终。
    model.failWith("compact gateway exploded", 1);
    service.answer(id, { state_version: h.gateVersion, code: "confirm" });
    const settled = await until(() => {
      const issue = service.get(id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" && issue.stage === "fix" ? issue : undefined;
    }, "压缩失败后的修复回合照常收口");
    assert.equal(settled.stage, "fix");
    assert.equal(compactionRequests(model).length, 1, "压缩尝试确实发出过");
  } finally {
    await model.stop();
  }
});

test("阈值旋钮:非边界续聊到阈值压通用锚,不带报告指针", async () => {
  const dataDir = mfcTemp("mfc-issue-compact-threshold-");
  // 两段补充意见回流把历史铺成多回合:第一次的补充意见带一大段日志
  // (用户侧大输入,让历史值得压);第二次回流时历史已是多回合,pi 的
  // 压缩走带 customInstructions 的路——通用锚("Additional focus")
  // 应出现在第二次压缩请求里。阈值 1:两段续聊各压一次。
  const bigNotes = "补充:核对连接池监控曲线。附网管日志摘录(测试填充):\n"
    + "日志行 x".repeat(20_000);
  const h = await atAnalysisGate(dataDir,
    () => ({ issue_compact_every_events: 1 }),
    (origin) => [
      ...firstRoundScenes(origin),
      { text: "(单回合压缩摘要幕,split 路无锚)" },
      ...revisionScenes,
      { text: "(多回合压缩摘要幕,带 Additional focus 锚)" },
      ...revisionScenes,
    ]);
  const { service, model, id } = h;
  try {
    service.answer(id, {
      state_version: h.gateVersion,
      code: "supplement",
      notes: bigNotes,
    });
    const gate2 = await nextAnalysisGate(h);
    service.answer(id, {
      state_version: gate2.gate!.state_version,
      code: "supplement",
      notes: "补充:二轮意见,核对回收阈值。",
    });
    const waitGate3 = () => until(() => {
      const issue = service.get(id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
        && issue.gate.state_version > gate2.gate!.state_version ? issue : undefined;
    }, "三轮分析确认闸");
    await waitGate3();
    const compactions = compactionRequests(model);
    assert.equal(compactions.length, 2, "两段续聊各压一次(阈值 1)");
    const bodies = compactions.map((r) => JSON.stringify(r));
    const anchored = bodies.find((body) => body.includes("Additional focus"));
    assert.ok(anchored, "多回合历史的压缩请求携带自定义锚");
    assert.ok(anchored.includes("问题会话「登录超时」"), "通用锚含标题");
    for (const body of bodies) {
      assert.ok(!body.includes("分析报告落盘"),
        "阈值路不带边界专用锚(报告指针是边界路专属)");
    }
    assert.equal(service.get(id).stage, "analyze", "补充意见留在分析阶段");
  } finally {
    await model.stop();
  }
});

test("缺省关:旋钮缺席时续聊回合不产生任何压缩请求(行为与现状全等)", async () => {
  const dataDir = mfcTemp("mfc-issue-compact-off-");
  // 无压缩干预的剧本:补充意见回流后直接演二轮修订。
  const h = await atAnalysisGate(dataDir, noKnob,
    (origin) => [...firstRoundScenes(origin), ...revisionScenes]);
  const { service, model, id } = h;
  try {
    service.answer(id, {
      state_version: h.gateVersion,
      code: "supplement",
      notes: "补充:核对连接池监控曲线",
    });
    await nextAnalysisGate(h);
    assert.equal(compactionRequests(model).length, 0,
      "旋钮缺席:一个压缩请求都不许有");
  } finally {
    await model.stop();
  }
});

test("阈值未到:事件增量没越线的续聊不压", async () => {
  const dataDir = mfcTemp("mfc-issue-compact-below-");
  const h = await atAnalysisGate(dataDir,
    () => ({ issue_compact_every_events: 1_000_000 }),
    (origin) => [...firstRoundScenes(origin), ...revisionScenes]);
  const { service, model, id } = h;
  try {
    service.answer(id, {
      state_version: h.gateVersion,
      code: "supplement",
      notes: "补充:核对连接池监控曲线",
    });
    await nextAnalysisGate(h);
    assert.equal(compactionRequests(model).length, 0);
  } finally {
    await model.stop();
  }
});
