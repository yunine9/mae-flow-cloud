/**
 * 合入事实(ADR-0022):mr_green 验绿收口后逐仓盯 /mr/gates——全合入/
 * 被关闭各通知一次;归档结论按合入事实记(全部 merged 才 delivered,
 * 建了 MR 未全合=fixed 软闸不堵);归档与 merge-status 现扫带竞态兜底。
 *
 * 范式与 issueMrDiscussions 同款:ScriptedModelServer 剧本 +
 * FakeGitPlatform 假交付平台 + FakeLubanServer 假小鲁班,只走公开 API 断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
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

/** 一路开到 mr_green 验绿收口的现场:假平台+剧本+服务三件套。
 *  流水线保持默认 success:申报即走即时验绿收口路(通知+合入监听
 *  都在这一路点火)。 */
async function greenFixture() {
  const dataDir = mfcTemp("mfc-issue-merge-");
  const platform = new FakeGitPlatform();
  const sourceDir = join(dataDir, "source");
  // 问题流当前的内网交付契约缺省目标分支是 master。测试机的
  // init.defaultBranch 可能是 main；显式建 master，避免假平台拿一条
  // 根本不存在的目标 ref 做合入事实判断。
  execFileSync("git", ["init", "-q", "-b", "master", sourceDir]);
  execFileSync("git", ["-C", sourceDir, "-c", "user.name=t", "-c",
    "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "seed"]);
  const origin = platform.initBare(sourceDir, dataDir);
  await platform.start();
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
    { text: "MR 已申报,等待流水线验绿。" },
    { text: "收到,继续处理。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = new Notifier({
    endpoint: luban.endpoint, backoffMs: [0],
  });
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () =>
      ({ username: "dev", password: "git-token", email: "dev@example.com" }),
    notifier,
  });
  const created = service.create({
    account: "dev", title: "登录超时", ticket: TICKET,
    source: "dts", repoUrl: origin,
  });
  await until(() => {
    const snapshot = service.get(created.id);
    return snapshot.status === "waiting_user"
      && snapshot.gate?.kind === "analysis_confirm";
  }, "分析确认闸收口");
  const gateVersion = service.get(created.id).gate!.state_version;
  service.answer(created.id, { state_version: gateVersion, code: "confirm" });
  // 全绿之后先由用户确认真实环境结果；合入事实监听与环境验证闸并行
  // 点火。这个测试关心的是闸通过后的合入/归档，不应绕过当前流程。
  await until(() => {
    const snapshot = service.get(created.id);
    return snapshot.status === "waiting_user"
      && snapshot.gate?.kind === "env_verify";
  }, "mr_green 验绿后环境验证闸");
  const envVersion = service.get(created.id).gate!.state_version;
  service.answer(created.id, { state_version: envVersion, code: "pass" });
  await until(() => {
    const snapshot = service.get(created.id);
    // 等环境闸作答收口(idle):竞态测试要立刻 control，回合进行中
    // (turning)会被 control 正确拒绝。
    return snapshot.stage_note
      === "环境验证通过——确认 MR 合入后可归档收口"
      && snapshot.status === "idle";
  }, "环境验证通过后待合入");
  return {
    id: created.id, service, platform, luban, model,
    stop: async () => {
      await service.shutdown();
      await model.stop();
      await platform.stop();
      await luban.stop();
    },
  };
}

const lubanText = (luban: FakeLubanServer) =>
  luban.messages.map((item) => JSON.stringify(item)).join("\n");

test("合入事实:全合入通知一次,mergeStatus 现扫,归档按事实记 delivered", async () => {
  const scene = await greenFixture();
  try {
    // 尚未合入:快照 opened,不算全合。
    const before = await scene.service.mergeStatus(scene.id);
    assert.equal(before.all_merged, false);
    assert.equal(before.mrs[0].state, "opened");

    // 平台合入 → 监看一拍内记账、换 note、通知。
    const branch = scene.service.get(scene.id).mrs![0].branch;
    scene.platform.settleMr(branch, "merged");
    await until(() =>
      scene.service.get(scene.id).stage_note === "全部 MR 已合入——可归档收口",
    "合入事实入账");
    const mr = scene.service.get(scene.id).mrs![0];
    assert.ok(mr.merged_at, "记账 merged_at(首次观测)");
    assert.match(mr.merged_sha ?? "", /^[0-9a-f]{40}$/,
      "merged_sha 照平台返回记");

    // 轮询继续跑,通知不重发、账不翻倍。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const notes = lubanText(scene.luban)
      .split("\n").filter((line) => line.includes("全部 MR 已合入"));
    assert.equal(notes.length, 1, "全合入通知只发一次");

    const status = await scene.service.mergeStatus(scene.id);
    assert.equal(status.all_merged, true);
    assert.equal(status.mrs[0].state, "merged");

    // 归档(软闸):结论按合入事实记 delivered。
    const summary = await scene.service.control(scene.id,
      { action: "archive" });
    assert.equal(summary.conclusion?.kind, "delivered");
  } finally {
    await scene.stop();
  }
});

test("归档竞态核对:监看未拍先,现扫兜住刚发生的合入", async () => {
  const scene = await greenFixture();
  try {
    const branch = scene.service.get(scene.id).mrs![0].branch;
    scene.platform.settleMr(branch, "merged");
    // 不等监听循环,立刻归档——control 内的竞态核对必须兜住这次合入。
    const summary = await scene.service.control(scene.id,
      { action: "archive" });
    assert.equal(summary.conclusion?.kind, "delivered",
      "点归档瞬间发生的合入不得记成 fixed");
  } finally {
    await scene.stop();
  }
});

test("MR 被关闭:通知给出路,归档软闸不堵、结论记 fixed", async () => {
  const scene = await greenFixture();
  try {
    const branch = scene.service.get(scene.id).mrs![0].branch;
    scene.platform.settleMr(branch, "closed");
    await until(() =>
      Boolean(scene.service.get(scene.id).mrs?.[0]?.closed_at),
    "关闭事实入账");
    const mr = scene.service.get(scene.id).mrs![0];
    assert.ok(!mr.merged_at, "被关闭的 MR 不记合入");
    assert.equal(lubanText(scene.luban).includes("有 MR 被关闭"), true,
      "关闭通知带返工出路");

    const status = await scene.service.mergeStatus(scene.id);
    assert.equal(status.mrs[0].state, "closed");
    assert.equal(status.all_merged, false);

    // 软闸:人看着事实拍板归档,不堵;结论=已推送未合入。
    const summary = await scene.service.control(scene.id,
      { action: "archive" });
    assert.equal(summary.conclusion?.kind, "fixed");
  } finally {
    await scene.stop();
  }
});
