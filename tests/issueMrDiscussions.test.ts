/**
 * 问题流 × CodeHub 检视意见:发现与落账(票 01,2026-09-08 立项)。
 *
 * mr_green 监看期内随流水线监看节奏逐仓拉检视讨论,新意见落问题域
 * 反馈账(工作台反馈面板可见,来源标 mr_discussion)。纪律:
 * - 增量按 discussion id,已落账的不重复;
 * - fail-open:适配层未配置/拉取失败等下一轮,绝不拖垮流水线主监看;
 * - 生命周期:stage=mr_green 且会话未终态,关停即止。
 *
 * 范式与 issueFlowFixed 同款:ScriptedModelServer 剧本 + FakeGitPlatform
 * 假交付平台(seedDiscussion 注入意见),只走公开 API 断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { fetchMrDiscussions } from "../src/issueFlow/mrDiscussions.ts";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS-2026-1001";
const fastPoll = {
  models: () => ({}),
  runtime: () => ({
    poll_interval_s: 1, poll_timeout_s: 120,
    evidence_retry_minutes: 0,
  }),
};

async function until(probe: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`超时:${what}`);
}

/** 五章节报告(submit_analysis 的机械门票)。 */
const report = () =>
  `printf '%s\\n' '# 问题分析:登录超时' '一句话总结:连接池耗尽,扩容并回收。' \\
    '## 问题现象' '登录超时。' '## 问题根因' '连接池耗尽。' \\
    '## 修改方案' '超时回收。' '## 证据链' '日志:连接池耗尽。' \\
    '## 置信度' '高:日志直接指向。' > issue-analysis.md`;

test("检视意见发现与落账:mr_green 期内新意见进反馈账,增量不重复,失败容忍", async () => {
  const dataDir = mfcTemp("mfc-issue-disc-");
  const platform = new FakeGitPlatform();
  // 流水线先挂 running:把"意见发现/增量/失败容忍"的断言窗稳稳放在
  // 验绿收口之前,收口用 finishPipeline 显式裁定。
  platform.nextPipelineStatus = "running";
  // 假平台的多仓路由要求 origin 在它的目录辖内:用 initBare 建仓(它
  // 会从源仓灌历史并登记 barePath)。
  const sourceDir = join(dataDir, "source");
  execFileSync("git", ["init", "-q", sourceDir]);
  execFileSync("git", ["-C", sourceDir, "-c", "user.name=t", "-c",
    "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "seed"]);
  const origin = platform.initBare(sourceDir, dataDir);
  await platform.start();
  // 开演前就种下第一条意见:申报即监看,首轮拉取就该落账。
  platform.seedDiscussion({
    id: "D1", file: "src/LoginService.java", line: 42,
    severity: "major", author: "检视人老王",
    body: "这里的连接池没有超时回收,存在泄漏风险",
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
    // ── 用户确认后平台回合继续:修复 → 推 → MR → 申报。 ──
    { tool: { name: "complete_stage", input: { note: "修复完成,UT 15/15" } } },
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 修复登录超时`) } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "MR 已申报", mrs: [origin] } } },
    { text: "MR 已申报,等待流水线与检视。" },
    // ── 检视意见注入(票 02)后的修复回合:写回复草稿 → 修 → 推 → 重建 MR → 重新申报。 ──
    { tool: { name: "bash", input: { command:
      "printf '%s' '[{\"discussion_id\":\"D1\",\"body\":\"已修复:补充了连接池超时回收逻辑\"}]' > mr-review-replies.json" } } },
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 检视意见修复:超时回收`) } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "检视意见已修复,重新申报", mrs: [origin] } } },
    { text: "检视意见已修复,重新申报完成。" },
    // 备用回合(增量意见 D2/D3 各触发一次注入,一回合一句收嘴)。
    { text: "收到,继续处理。" },
    { text: "收到,继续处理。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET,
      source: "dts", repoUrl: origin,
    });
    // 推进到分析确认闸并确认,让剧本继续走到申报。等待条件必须是
    // "已收口到 waiting_user"——闸对象在 submit_analysis 当下就进状态,
    // 但 answer() 只受理收口后的会话(并发下先答会被打回)。
    await until(() => {
      const snapshot = service.get(created.id);
      return snapshot.status === "waiting_user"
        && snapshot.gate?.kind === "analysis_confirm";
    }, "分析确认闸收口");
    const gateVersion = service.get(created.id).gate!.state_version;
    service.answer(created.id, { state_version: gateVersion, code: "confirm" });
    // 申报后监看启动,首轮拉取:D1 落反馈账(工作台可见,来源标明)。
    await until(() => {
      const feedback = service.get(created.id).feedback ?? [];
      return feedback.some((record) =>
        record.source === "mr_discussion" && record.source_id === "D1");
    }, "D1 落反馈账");
    const d1 = (service.get(created.id).feedback ?? [])
      .find((record) => record.source_id === "D1")!;
    assert.match(d1.summary, /连接池没有超时回收/);
    assert.equal(d1.file, "src/LoginService.java");
    assert.equal(d1.line, 42);
    assert.equal(d1.author, "检视人老王");
    assert.match(d1.id, /^mr-discussion:/);

    // 增量:第二条意见下一拍落账;D1 仍是恰好一条,不重复。
    platform.seedDiscussion({
      id: "D2", file: "src/Pool.java", line: 7,
      author: "检视人老李", body: "这里建议加监控埋点",
    });
    await until(() => {
      const feedback = service.get(created.id).feedback ?? [];
      return feedback.some((record) => record.source_id === "D2");
    }, "D2 落反馈账");
    // 再等一拍:轮询继续跑,D1/D2 都不翻倍。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const feedback = service.get(created.id).feedback ?? [];
    assert.equal(feedback.filter((record) => record.source_id === "D1").length, 1,
      "已落账的意见不得重复");
    assert.equal(feedback.filter((record) => record.source_id === "D2").length, 1);

    // 失败容忍:适配层抖一次 503,监看不炸;下一拍恢复后新意见照落。
    platform.discussionListFailures = 1;
    platform.seedDiscussion({
      id: "D3", file: "src/Pool.java", line: 19,
      author: "检视人老李", body: "日志级别建议降为 debug",
    });
    await until(() => {
      const feedback = service.get(created.id).feedback ?? [];
      return feedback.some((record) => record.source_id === "D3");
    }, "抖动恢复后 D3 落账");
    assert.equal(service.get(created.id).status !== "failed", true,
      "拉取失败不拖垮会话");

    // ── 票 02:注入。平台通知把意见清单喂给 AI(不举卡),修复回合照剧本跑。 ──
    await until(() =>
      JSON.stringify(model.requests).includes("mr-review-replies.json"),
    "注入通知到达模型");
    assert.match(JSON.stringify(model.requests), /连接池没有超时回收/,
      "通知携带意见正文清单");

    // ── 票 03:草稿 → 出站信箱 → 投递 CodeHub。 ──
    const d1Discussion = platform.discussions.find((item) => item.id === "D1")!;
    await until(() => d1Discussion.replies.length > 0, "D1 回复已投递 CodeHub");
    assert.match(d1Discussion.replies[0], /已修复/);
    // 幂等:继续轮询几拍,已投递的不重发。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(d1Discussion.replies.length, 1, "重放不得产生第二条回复");

    // 检视人解决讨论 → 意见闭环标注(投递未带 resolve,归因=检视人)。
    d1Discussion.resolved = true;
    await until(() => {
      const record = (service.get(created.id).feedback ?? [])
        .find((item) => item.source_id === "D1");
      return record?.status === "closed";
    }, "D1 闭环标注");
    assert.match(
      (service.get(created.id).feedback ?? [])
        .find((item) => item.source_id === "D1")!.resolution ?? "",
      /检视人已在 CodeHub 解决/);

    // SHA 漂移终态(检视闭环 ② 改语义):直写信箱构造"绑定旧提交"的
    // pending——版本对不上直接标失败("请重写"),不再永远 pending;
    // 失败不挡新草稿,重写后照常投递。
    const issueDir = join(dataDir, "issues", created.id);
    const outboxPath = join(issueDir, "mr-review-outbox.json");
    writeFileSync(outboxPath, JSON.stringify({ items: [{
      id: "mrr-drift-test", repo: origin, discussion_id: "D2",
      body: "已补监控埋点", resolve: false,
      expected_sha: "0".repeat(40), status: "pending", attempts: 0,
      created_at: new Date().toISOString(),
    }] }));
    const d2 = platform.discussions.find((item) => item.id === "D2")!;
    await until(() => {
      const outbox = JSON.parse(readFileSync(outboxPath, "utf-8"));
      const item = outbox.items.find((entry: any) =>
        entry.discussion_id === "D2");
      return item?.status === "failed"
        && /代码已更新|重写/.test(String(item.last_error ?? ""));
    }, "SHA 漂移直接标失败(不再永远 pending)");
    assert.equal(d2.replies.length, 0, "漂移条目绝不投递");
    // 失败不挡新草稿:AI 重写 D2 回复 → 新条目入箱绑当前收据 → 投递。
    writeFileSync(join(issueDir, "mr-review-replies.json"),
      JSON.stringify([{ discussion_id: "D2", body: "已补监控埋点(重写)" }]));
    await until(() => d2.replies.length > 0, "重写草稿后 D2 投递");
    assert.match(d2.replies.at(-1)!, /重写/);

    // 收口即停(票 01 范围边界):验绿收口后监看退出,收口后的新意见
    // 不再追——修它的责任在 T2 的门禁注入,不在发现器。
    const pushedSha = service.get(created.id).pushes!.at(-1)!.sha;
    platform.finishPipeline(pushedSha, "success");
    await until(() => {
      const transitions = service.get(created.id).transitions ?? [];
      return transitions.some((entry) => /验绿收口/.test(entry.note));
    }, "验绿收口");
    platform.seedDiscussion({
      id: "D4", file: "src/Late.java", line: 1,
      author: "迟到检视人", body: "收口后才提的意见",
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(
      (service.get(created.id).feedback ?? [])
        .filter((record) => record.source_id === "D4").length, 0,
      "收口后监看应已退出,不再落账");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("关自动修(repair_rounds=0):检视意见标待人工,不注入模型", async () => {
  const dataDir = mfcTemp("mfc-issue-disc-ro-");
  const platform = new FakeGitPlatform();
  platform.nextPipelineStatus = "running";
  const sourceDir = join(dataDir, "source");
  execFileSync("git", ["init", "-q", sourceDir]);
  execFileSync("git", ["-C", sourceDir, "-c", "user.name=t", "-c",
    "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "seed"]);
  const origin = platform.initBare(sourceDir, dataDir);
  await platform.start();
  platform.seedDiscussion({
    id: "D1", author: "检视人老王", body: "这里的连接池没有超时回收",
  });
  const script: Scene[] = [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command: report() } } },
    { tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽" } } },
    { text: "分析报告已提交,等待用户确认。" },
    { tool: { name: "complete_stage", input: { note: "修复完成" } } },
    { tool: { name: "bash", input: { command:
      `cd repo/origin && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '[${TICKET}][fix] 修复'` } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "MR 已申报", mrs: [origin] } } },
    { text: "MR 已申报。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: {
      models: () => ({}),
      runtime: () => ({
        poll_interval_s: 1, poll_timeout_s: 120,
        evidence_retry_minutes: 0, repair_rounds: 0,
      }),
    },
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  try {
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
    await until(() => {
      const record = (service.get(created.id).feedback ?? [])
        .find((item) => item.source_id === "D1");
      return record?.status === "needs_human";
    }, "意见标待人工");
    const record = (service.get(created.id).feedback ?? [])
      .find((item) => item.source_id === "D1")!;
    assert.match(record.resolution ?? "", /repair_rounds=0/);
    // 不注入:模型从未收到检视意见通知(以草稿文件指引为标记——开场词
    // 与简报里"检视意见"一词本就常见,不能当注入证据)。
    assert.equal(
      JSON.stringify(model.requests).includes("mr-review-replies.json"),
      false, "关自动修时不得把意见清单喂给模型");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("discussions 客户端:可用/未配置/坏响应/网络失败四态,fail-open 上浮原因", async () => {
  // 200 正常形状 → available。
  const ok = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ discussions: [
      { id: "D9", body: "意见正文", file: "a.java", line: 3 },
      { not_an_id: true }, // 坏行跳过,不炸整包
    ] }));
  });
  await new Promise<void>((done) => ok.listen(0, "127.0.0.1", done));
  const okPort = (ok.address() as { port: number }).port;
  const good = await fetchMrDiscussions({
    platformUrl: `http://127.0.0.1:${okPort}`, repo: "http://r.git", mr: 7,
  });
  assert.equal(good.kind, "available");
  assert.deepEqual(good.kind === "available" && good.items.map((item) => item.id),
    ["D9"]);
  ok.close();

  // 404(适配层未配置 discussions)→ unavailable。
  const notFound = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "未配置 mr_discussions" }));
  });
  await new Promise<void>((done) => notFound.listen(0, "127.0.0.1", done));
  const missing = await fetchMrDiscussions({
    platformUrl: `http://127.0.0.1:${(notFound.address() as { port: number }).port}`,
    repo: "http://r.git",
  });
  assert.equal(missing.kind, "unavailable");
  assert.match(missing.kind === "unavailable" ? missing.reason : "", /404/);
  notFound.close();

  // 坏 JSON → unavailable,不抛。
  const garbage = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("<html>not json</html>");
  });
  await new Promise<void>((done) => garbage.listen(0, "127.0.0.1", done));
  const bad = await fetchMrDiscussions({
    platformUrl: `http://127.0.0.1:${(garbage.address() as { port: number }).port}`,
    repo: "http://r.git",
  });
  assert.equal(bad.kind, "unavailable");
  garbage.close();

  // 网络不通(连接拒绝)→ unavailable,不抛。
  const down = await fetchMrDiscussions({
    platformUrl: "http://127.0.0.1:9", repo: "http://r.git",
  });
  assert.equal(down.kind, "unavailable");
});
