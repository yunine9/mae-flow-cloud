/**
 * 检视回执闭环加固(2026-09-10 对齐清单 ②,六条拍板):
 * - 重启续挂:recover() 补挂检视监看;待注入标志落盘化(mr-review-notify.json),
 *   重启后已落账未注入的意见重新交给 AI;
 * - 漂移终态:版本对不上的回复条目标 failed 并重挂注入(自愈重写),
 *   不再永远 pending;
 * - 记账分家:发送成功→addressed(Agent 已回复,待检视人核验);讨论
 *   消失按发送账归因(AI resolve=true 不许记成"检视人已解决");
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
import { reviewStore } from "../src/issueFlow/reviews.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS-2026-1001";
const fastPoll = {
  models: () => ({}),
  runtime: () => ({
    poll_interval_s: 1, poll_timeout_s: 300,
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
    '## 修改方案' '超时回收。' \\
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

test("重启继续同步外部批注，旧待注入标志不再自动派发修复", async () => {
  const scene = await reviewFixture({ seed: { id: "R1", body: "这里的连接池没有超时回收,存在泄漏风险" } });
  try {
    await until(() => reviewStore(scene.issueDir).list().some(item => item.external_review), "外部意见同步为批注");
    const note = reviewStore(scene.issueDir).list().find(item => item.external_review)!;
    assert.equal(note.agent_assigned, undefined);
    await scene.service.shutdown();
    writeFileSync(join(scene.issueDir, "mr-review-notify.json"), JSON.stringify({ at: new Date().toISOString() }));
    const restarted = new IssueFlowService(scene.serviceOptions);
    try {
      scene.platform.seedDiscussion({ id: "R2", body: "重启后的新报告", file: "a.cpp", line: 1, author: "数字人" });
      await until(() => reviewStore(scene.issueDir).list().some(item => item.external_review?.discussion_id === "R2"), "重启后发现新报告");
      assert.equal(reviewStore(scene.issueDir).list().filter(item => item.external_review?.discussion_id === "R1").length, 1);
      assert.doesNotMatch(JSON.stringify(scene.model.requests), /连接池没有超时回收|重启后的新报告/);
    } finally { await restarted.shutdown(); }
  } finally { await scene.stop(); }
});

test("漂移终态:版本对不上直接标失败并重挂注入,重写草稿自愈发送", async () => {
  const scene = await reviewFixture({
    seed: { id: "F1", body: "日志级别建议降为 debug" },
  });
  try {
    await until(() => Boolean(scene.recordOf("F1")), "F1 落反馈账");
    const outboxPath = join(scene.issueDir, "mr-review-outbox.json");
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
    assert.equal(f1.replies.length, 0, "漂移条目绝不发送");
    // 漂移失败 → 重挂注入(AI 收到清单会重写);这里直接替 AI 重写草稿:
    // failed 不挡新草稿,新条目绑当前收据 → 发送成功 → 记录转 addressed。
    writeFileSync(join(scene.issueDir, "mr-review-replies.json"),
      JSON.stringify([{ discussion_id: "F1", body: "已调整为 debug(重写)" }]));
    await until(() => f1.replies.length > 0, "重写草稿自愈发送");
    await until(() =>
      (scene.recordOf("F1")?.status ?? "") === "addressed",
    "发送成功转 addressed(Agent 已回复,待检视人核验)");
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
    await until(() => a1.replies.length > 0, "AI 回复发送(resolve=true)");
    await until(() =>
      (scene.recordOf("A1")?.status ?? "") === "addressed",
    "发送成功先转 addressed");
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

test("追问作为新待判断批注，原意见本地闭环后不复活，也不自动注入", async () => {
  const scene = await reviewFixture({ seed: { id: "Q1", body: "这里建议加监控埋点" } });
  try {
    const store = reviewStore(scene.issueDir);
    await until(() => store.list().some(item => item.external_review), "首条同步");
    const first = store.list().find(item => item.external_review)!;
    store.drop(first.id, "owner", true);
    const q1 = scene.platform.discussions.find(item => item.id === "Q1")!;
    q1.revision = (q1.revision ?? 0) + 1;
    q1.body = "追问:埋点名字要带前缀";
    await until(() => store.list().filter(item => item.external_review).length === 2, "追问作为新待判断批注");
    assert.equal(store.list().find(item => item.id === first.id)!.status, "dropped");
    assert.doesNotMatch(JSON.stringify(scene.model.requests), /追问:埋点名字要带前缀/);
  } finally { await scene.stop(); }
});

test("信箱损坏:监看不崩,下一份草稿自愈重写信箱并照常发送", async () => {
  const scene = await reviewFixture({
    seed: { id: "C1", body: "异常分支没有日志" },
  });
  try {
    await until(() => Boolean(scene.recordOf("C1")), "C1 落反馈账");
    // 信箱损坏(fail-open:不崩,读不动按空箱继续)。
    writeFileSync(join(scene.issueDir, "mr-review-outbox.json"),
      "{ this is not json");
    const c1 = scene.platform.discussions.find((item) => item.id === "C1")!;
    // AI 写草稿 → stage 用读到的空箱重建信箱(损坏文件被覆盖)→ 发送。
    writeFileSync(join(scene.issueDir, "mr-review-replies.json"),
      JSON.stringify([{ discussion_id: "C1", body: "已补充异常日志" }]));
    await until(() => c1.replies.length > 0, "损坏后草稿照常发送(自愈)");
    assert.equal(existsSync(join(scene.issueDir, "mr-review-replies.json")),
      false, "草稿即消费");
  } finally {
    await scene.stop();
  }
});

test("责任人答复直达 CodeHub:入信箱不绑版本,发送后转 addressed 归因责任人", async () => {
  const scene = await reviewFixture({
    seed: { id: "O1", body: "建议补充单元测试覆盖超时分支" },
  });
  try {
    const store = reviewStore(scene.issueDir);
    await until(() => store.list().some(item => item.external_review),
      "外部意见同步为批注");
    const note = store.list().find(item => item.external_review)!;
    // 当前推送收据存在:答复不绑它(不主张代码已改),重推也不作废。
    assert.equal(scene.service.get(scene.id).pushes!.length > 0, true);
    scene.service.updateExternalReview(scene.id, note.id,
      { reply: "这条按设计如此,已补充说明文档" });
    const o1 = scene.platform.discussions.find((item) => item.id === "O1")!;
    await until(() => JSON.stringify(o1.replies).includes("按设计如此"),
      "责任人答复发布到平台讨论");
    await until(() =>
      (scene.recordOf("O1")?.status ?? "") === "addressed",
    "发送成功转 addressed");
    assert.match(scene.recordOf("O1")!.resolution ?? "", /责任人 dev 已回复/);
    assert.doesNotMatch(scene.recordOf("O1")!.resolution ?? "", /Agent 已回复/);
    const outbox = JSON.parse(
      readFileSync(join(scene.issueDir, "mr-review-outbox.json"), "utf-8"));
    const item = outbox.items.find((entry: any) =>
      entry.discussion_id === "O1");
    assert.equal(item.author, "dev");
    assert.equal(item.expected_sha ?? "", "", "答复不绑推送收据");
  } finally {
    await scene.stop();
  }
});

test("责任人答复勾选代点已解决:远端讨论标 resolved(2026-09-18 拍板)", async () => {
  const scene = await reviewFixture({
    seed: { id: "O1", body: "建议补充单元测试覆盖超时分支" },
  });
  try {
    const store = reviewStore(scene.issueDir);
    await until(() => store.list().some(item => item.external_review),
      "外部意见同步为批注");
    const note = store.list().find(item => item.external_review)!;
    scene.service.updateExternalReview(scene.id, note.id,
      { reply: "已按建议补充超时分支的单元测试", resolve_remote: true });
    const o1 = scene.platform.discussions.find((item) => item.id === "O1")!;
    await until(() => o1.resolved, "讨论在 CodeHub 标记已解决");
    await until(() =>
      (scene.recordOf("O1")?.status ?? "") === "addressed",
      "发送成功本地转 addressed");
    const outbox = JSON.parse(
      readFileSync(join(scene.issueDir, "mr-review-outbox.json"), "utf-8"));
    const item = outbox.items.find((entry: any) =>
      entry.discussion_id === "O1");
    assert.equal(item.resolve, true, "信箱记录勾选了代点已解决");
    assert.equal(item.author, "dev");
  } finally {
    await scene.stop();
  }
});

test("忽略意见:本地软删,远端讨论代点已解决(2026-09-18 拍板)", async () => {
  const scene = await reviewFixture({
    seed: { id: "O1", body: "建议补充单元测试覆盖超时分支" },
  });
  try {
    const store = reviewStore(scene.issueDir);
    await until(() => store.list().some(item => item.external_review),
      "外部意见同步为批注");
    const note = store.list().find(item => item.external_review)!;
    scene.service.dropReview(scene.id, note.id);
    const o1 = scene.platform.discussions.find((item) => item.id === "O1")!;
    await until(() => o1.resolved, "讨论在 CodeHub 标记已解决");
    assert.equal(store.visible().some(item => item.id === note.id), false,
      "忽略后本地不再露面");
    const outbox = JSON.parse(
      readFileSync(join(scene.issueDir, "mr-review-outbox.json"), "utf-8"));
    const item = outbox.items.find((entry: any) =>
      entry.discussion_id === "O1");
    assert.equal(item.resolve_only, true, "信箱记录仅标已解决,不跟帖");
    assert.equal(item.status, "delivered");
  } finally {
    await scene.stop();
  }
});

test("全部合入后停止追踪新意见,在途回复照常发送", async () => {
  const scene = await reviewFixture({
    seed: { id: "M1", body: "建议增加重试" },
  });
  try {
    const store = reviewStore(scene.issueDir);
    await until(() => store.list().some(item => item.external_review),
      "首条同步");
    // 在途回复:直写信箱一条绑当前收据的 pending(与 AI 装箱同构)。
    const currentSha = scene.service.get(scene.id).pushes!.at(-1)!.sha;
    writeFileSync(join(scene.issueDir, "mr-review-outbox.json"),
      JSON.stringify({ items: [{
        id: "mrr-m1", repo: scene.origin, discussion_id: "M1",
        body: "已增加重试", resolve: false, expected_sha: currentSha,
        status: "pending", attempts: 0,
        created_at: new Date().toISOString(),
      }] }));
    scene.platform.settleMr(
      scene.service.get(scene.id).mrs![0]!.branch, "merged");
    // fixture 按住流水线 running,mr_green 不收口,合入监看未启动——
    // 用归档核对同款的现扫通道完成首次观测,merged_at 才进账。
    assert.equal((await scene.service.mergeStatus(scene.id)).all_merged,
      true, "合入事实已观测");
    const m1 = scene.platform.discussions.find((item) => item.id === "M1")!;
    await until(() => m1.replies.length > 0, "合入后在途回复仍发送");
    // 合入后到达的意见不再追踪(账保留,监看不再拉新)。
    scene.platform.seedDiscussion({
      id: "M2", body: "合入后的新报告", file: "b.cpp", line: 2,
      severity: "major", author: "检视人老王",
    });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(store.list().filter(item =>
      item.external_review?.discussion_id === "M2").length, 0,
      "合入后新意见不追踪");
  } finally {
    await scene.stop();
  }
});
