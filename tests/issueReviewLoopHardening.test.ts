/**
 * 检视回执闭环加固(2026-09-10 对齐清单 ②,六条拍板):
 * - 重启续挂:recover() 补挂检视监看;待注入标志落盘化(mr-review-notify.json),
 *   重启后已落账未注入的意见重新交给 AI;
 * - 漂移终态:版本对不上的回复条目标 failed 并重挂注入(自愈重写),
 *   不再永远 pending;
 * - 记账分家:投递成功→addressed(Agent 已回复,待检视人核验);讨论
 *   消失按投递账归因(AI resolve=true 不许记成"检视人已解决");
 * - 追问:同讨论版本号变化且未了结=新触发;
 * - 信箱损坏:记日志不崩,下一份草稿自愈重写。
 *
 * 范式与 issueMrDiscussions 同款:ScriptedModelServer 剧本 +
 * FakeGitPlatform(流水线保持 running,把发现窗口稳稳撑开),只走公开 API 断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS-2026-1001";
const fastPoll = {
  models: () => ({}),
  runtime: () => ({
    poll_interval_s: 1, poll_timeout_s: 300,
    evidence_retry_minutes: 0,
  }),
};

async function until(probe: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`超时:${what}`);
}

const report = () =>
  `printf '%s\\n' '# 问题分析:登录超时' '一句话总结:连接池耗尽,扩容并回收。' \\
    '## 问题现象' '登录超时。' '## 问题根因' '连接池耗尽。' \\
    '## 修改方案' '超时回收。' '## 证据链' '日志:连接池耗尽。' \\
    '## 置信度' '高:日志直接指向。' > issue-analysis.md`;

/** 开到 mr_green 申报停等(流水线保持 running=发现窗口常开)的现场。
 *  seedDiscussion 在申报前种下首条意见。 */
async function reviewFixture(options: {
  seed: { id: string; body: string; file?: string; line?: number };
  resolveDiscussions?: boolean;
  modelSpares?: number;
}) {
  const dataDir = mfcTemp("mfc-issue-review-loop-");
  const platform = new FakeGitPlatform();
  platform.nextPipelineStatus = "running";
  const sourceDir = join(dataDir, "source");
  execFileSync("git", ["init", "-q", sourceDir]);
  execFileSync("git", ["-C", sourceDir, "-c", "user.name=t", "-c",
    "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "seed"]);
  const origin = platform.initBare(sourceDir, dataDir);
  await platform.start();
  platform.seedDiscussion({
    id: options.seed.id, file: options.seed.file ?? "src/LoginService.java",
    line: options.seed.line ?? 42, severity: "major", author: "检视人老王",
    body: options.seed.body,
  });
  const commit = (message: string) =>
    `cd repo/origin && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '${message}'`;
  const script: Scene[] = [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command: report() } } },
    { tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽,方案=超时回收" } } },
    { text: "分析报告已提交,等待用户确认。" },
    { tool: { name: "complete_stage", input: { note: "修复完成,UT 15/15" } } },
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 修复登录超时`) } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "MR 已申报", mrs: [origin] } } },
    { text: "MR 已申报,等待流水线与检视。" },
    // 注入回合与备用:测试里 AI 多数时候只回一句不写草稿,意见留 open。
    ...Array.from({ length: options.modelSpares ?? 5 },
      (): Scene => ({ text: "收到,继续处理。" })),
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const serviceOptions = {
    dataDir,
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () =>
      ({ username: "dev", password: "git-token", email: "dev@example.com" }),
    ...(options.resolveDiscussions !== undefined
      ? { resolveDiscussions: options.resolveDiscussions } : {}),
  };
  const service = new IssueFlowService(serviceOptions);
  const created = service.create({
    account: "dev", title: "登录超时", ticket: TICKET,
    source: "dts", repoUrl: origin,
  });
  await until(() => {
    const snapshot = service.get(created.id);
    return snapshot.status === "waiting_user"
      && snapshot.gate?.kind === "analysis_confirm";
  }, "分析确认闸收口");
  service.answer(created.id, {
    state_version: service.get(created.id).gate!.state_version,
    code: "confirm",
  });
  const issueDir = join(dataDir, "issues", created.id);
  return {
    id: created.id, issueDir, origin, platform, model, service,
    serviceOptions,
    seedDiscussion: platform.seedDiscussion.bind(platform),
    recordOf: (sourceId: string) =>
      (service.get(created.id).feedback ?? [])
        .find((item) => item.source_id === sourceId),
    stop: async () => {
      await service.shutdown();
      await model.stop();
      await platform.stop();
    },
  };
}

test("重启续挂:检视监听复活,落盘的待注入标志把 open 意见重新交给 AI", async () => {
  const scene = await reviewFixture({
    seed: { id: "R1", body: "这里的连接池没有超时回收,存在泄漏风险" },
  });
  try {
    // 意见落账 → 注入 #1 到达模型;AI 只回一句,记录保持 open。
    await until(() => Boolean(scene.recordOf("R1")), "R1 落反馈账");
    await until(() =>
      JSON.stringify(scene.model.requests).includes("连接池没有超时回收"),
    "注入 #1 到达模型");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(scene.recordOf("R1")!.status, "open", "AI 未回复,记录留 open");

    // 重启:监看全部死亡(进程内模拟=shutdown+新实例)。
    await scene.service.shutdown();
    // 待注入标志落盘(等价于崩溃窗口里"已落账未注入"的持久状态)。
    writeFileSync(join(scene.issueDir, "mr-review-notify.json"),
      JSON.stringify({ at: new Date().toISOString() }) + "\n");
    const restarted = new IssueFlowService(scene.serviceOptions);
    // 恢复的监看读到标志 → 注入 #2 再达模型(监看复活的可观察证明)。
    const hits = () =>
      JSON.stringify(scene.model.requests)
        .split("连接池没有超时回收").length - 1;
    await until(() => hits() >= 2, "重启后注入 #2 再达模型");
    const after = (restarted.get(scene.id).feedback ?? [])
      .find((item) => item.source_id === "R1");
    assert.equal(after!.status, "open", "未回复的意见重启后仍是 open");
    await restarted.shutdown();
  } finally {
    await scene.stop();
  }
});

test("漂移终态:版本对不上直接标失败并重挂注入,重写草稿自愈投递", async () => {
  const scene = await reviewFixture({
    seed: { id: "F1", body: "日志级别建议降为 debug" },
  });
  try {
    await until(() => Boolean(scene.recordOf("F1")), "F1 落反馈账");
    const outboxPath = join(scene.issueDir, "mr-review-outbox.json");
    const currentSha = scene.service.get(scene.id).pushes!.at(-1)!.sha;
    // 直写信箱构造"绑定旧提交"的 pending(与真实漂移同构)。
    writeFileSync(outboxPath, JSON.stringify({ items: [{
      id: "mrr-drift-1", repo: scene.origin, discussion_id: "F1",
      body: "已调整为 debug", resolve: false,
      expected_sha: "0".repeat(40), status: "pending", attempts: 0,
      created_at: new Date().toISOString(),
    }] }));
    const f1 = scene.platform.discussions.find((item) => item.id === "F1")!;
    await until(() => {
      const item = JSON.parse(readFileSync(outboxPath, "utf-8"))
        .items.find((entry: any) => entry.discussion_id === "F1");
      return item?.status === "failed"
        && /代码已更新|重写/.test(String(item.last_error ?? ""));
    }, "漂移条目标 failed(不再永远 pending)");
    assert.equal(f1.replies.length, 0, "漂移条目绝不投递");
    // 漂移失败 → 重挂注入(AI 收到清单会重写);这里直接替 AI 重写草稿:
    // failed 不挡新草稿,新条目绑当前收据 → 投递成功 → 记录转 addressed。
    writeFileSync(join(scene.issueDir, "mr-review-replies.json"),
      JSON.stringify([{ discussion_id: "F1", body: "已调整为 debug(重写)" }]));
    await until(() => f1.replies.length > 0, "重写草稿自愈投递");
    await until(() =>
      (scene.recordOf("F1")?.status ?? "") === "addressed",
    "投递成功转 addressed(Agent 已回复,待检视人核验)");
    assert.equal(currentSha.length, 40);
  } finally {
    await scene.stop();
  }
});

test("归因分家:AI resolve 的讨论记『Agent 回复并解决』,检视人解决的记检视人", async () => {
  const scene = await reviewFixture({
    seed: { id: "A1", body: "建议补充单元测试覆盖超时分支" },
    resolveDiscussions: true,
  });
  try {
    await until(() => Boolean(scene.recordOf("A1")), "A1 落反馈账");
    const a1 = scene.platform.discussions.find((item) => item.id === "A1")!;
    // AI 回复(AI 视角写草稿;回合已收口,stage 绑当前收据)。
    writeFileSync(join(scene.issueDir, "mr-review-replies.json"),
      JSON.stringify([{ discussion_id: "A1", body: "已补充 3 个用例" }]));
    await until(() => a1.replies.length > 0, "AI 回复投递(resolve=true)");
    await until(() =>
      (scene.recordOf("A1")?.status ?? "") === "addressed",
    "投递成功先转 addressed");
    // resolve=true → 平台讨论被 AI 标解决 → 下一拍从清单消失 → 闭环,
    // 归因必须是 Agent,不得冒充"检视人已解决"。
    await until(() =>
      (scene.recordOf("A1")?.status ?? "") === "closed", "讨论消失后闭环");
    const resolution = scene.recordOf("A1")!.resolution ?? "";
    assert.match(resolution, /Agent 回复并解决/);
    assert.doesNotMatch(resolution, /检视人已/);
    await scene.service.shutdown();
  } finally {
    await scene.stop();
  }
});

test("追问:同讨论版本号变化且未了结=新触发,追问正文进注入清单", async () => {
  const scene = await reviewFixture({
    seed: { id: "Q1", body: "这里建议加监控埋点" },
  });
  try {
    await until(() => Boolean(scene.recordOf("Q1")), "Q1 落反馈账");
    await until(() =>
      JSON.stringify(scene.model.requests).includes("监控埋点"),
    "首轮注入到达模型");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    // 检视人在同一线程追问:讨论 id 不变,revision 变,正文更新。
    const q1 = scene.platform.discussions.find((item) => item.id === "Q1")!;
    q1.revision = (q1.revision ?? 0) + 1;
    q1.body = "追问:埋点名字要带前缀";
    await until(() =>
      (scene.recordOf("Q1")?.source_revision ?? 0) > 0,
    "追问刷新账上的版本号");
    await until(() =>
      JSON.stringify(scene.model.requests).includes("追问:埋点名字要带前缀"),
    "追问进入注入清单(再次通知 AI)");
  } finally {
    await scene.stop();
  }
});

test("信箱损坏:监看不崩,下一份草稿自愈重写信箱并照常投递", async () => {
  const scene = await reviewFixture({
    seed: { id: "C1", body: "异常分支没有日志" },
  });
  try {
    await until(() => Boolean(scene.recordOf("C1")), "C1 落反馈账");
    // 信箱损坏(fail-open:不崩,读不动按空箱继续)。
    writeFileSync(join(scene.issueDir, "mr-review-outbox.json"),
      "{ this is not json");
    const c1 = scene.platform.discussions.find((item) => item.id === "C1")!;
    // AI 写草稿 → stage 用读到的空箱重建信箱(损坏文件被覆盖)→ 投递。
    writeFileSync(join(scene.issueDir, "mr-review-replies.json"),
      JSON.stringify([{ discussion_id: "C1", body: "已补充异常日志" }]));
    await until(() => c1.replies.length > 0, "损坏后草稿照常投递(自愈)");
    assert.equal(existsSync(join(scene.issueDir, "mr-review-replies.json")),
      false, "草稿即消费");
  } finally {
    await scene.stop();
  }
});
