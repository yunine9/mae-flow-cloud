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
 *  都在这一路启动)。stopAtVerifyCard=true 时停在环境验证卡未答
 *  现场(测「未答卡+合入=自动归档」的验证通过语义)。 */
async function greenFixture(opts: { stopAtVerifyCard?: boolean } = {}) {
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
    // 当场验绿收口(#246 绿灯切换):complete_stage 回执自带举卡指引
    // ——AI 同回合经 raise_gate 举出验证卡(平台不再代举)。
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "已举卡等待用户在环境验证。" },
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
  // 启动。这个测试关心的是闸通过后的合入/归档，不应绕过当前流程。
  await until(() => {
    const snapshot = service.get(created.id);
    return snapshot.status === "waiting_user"
      && snapshot.gate?.kind === "env_verify";
  }, "mr_green 验绿后环境验证闸");
  if (opts.stopAtVerifyCard) {
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
  const envVersion = service.get(created.id).gate!.state_version;
  service.answer(created.id, { state_version: envVersion, code: "pass" });
  await until(() => {
    const snapshot = service.get(created.id);
    // 等环境闸作答收口(idle 待合入):自动归档由合入监看接管。
    return snapshot.stage_note
      === "环境验证通过——等待 MR 合入,合入后自动归档收口"
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

test("合入事实:全合入自动归档(ADR-0034),结论 delivered,通知一次", async () => {
  const scene = await greenFixture();
  try {
    // 尚未合入:快照 opened,不算全合。
    const before = await scene.service.mergeStatus(scene.id);
    assert.equal(before.all_merged, false);
    assert.equal(before.mrs[0].state, "opened");

    // 平台合入 → 监看一拍内记账、自动归档(不再等人类点归档)。
    const branch = scene.service.get(scene.id).mrs![0].branch;
    scene.platform.settleMr(branch, "merged");
    await until(() => scene.service.get(scene.id).status === "archived",
      "合入自动归档");
    const final = scene.service.get(scene.id);
    assert.equal(final.conclusion?.kind, "delivered",
      "自动归档结论=delivered");
    const mr = final.mrs![0];
    assert.ok(mr.merged_at, "记账 merged_at(首次观测)");
    assert.match(mr.merged_sha ?? "", /^[0-9a-f]{40}$/,
      "merged_sha 照平台返回记");

    // 轮询继续跑,通知不重发、账不翻倍。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const notes = lubanText(scene.luban)
      .split("\n").filter((line) => line.includes("自动归档"));
    assert.equal(notes.length, 1, "自动归档通知只发一次");
  } finally {
    await scene.stop();
  }
});

test("未答验证卡时合入:自动归档=验证通过语义,闸随终态清面", async () => {
  const scene = await greenFixture({ stopAtVerifyCard: true });
  try {
    assert.equal(scene.service.get(scene.id).gate?.kind, "env_verify",
      "现场:环境验证卡待答");
    const branch = scene.service.get(scene.id).mrs![0].branch;
    scene.platform.settleMr(branch, "merged");
    await until(() => scene.service.get(scene.id).status === "archived",
      "未答卡合入自动归档");
    const final = scene.service.get(scene.id);
    assert.equal(final.conclusion?.kind, "delivered",
      "未答卡+合入=验证通过(ADR-0034)");
    assert.equal(final.gate, undefined, "验证卡随终态清面,不残留");
  } finally {
    await scene.stop();
  }
});

test("MR 被关闭:通知给出路;有单手动归档被拒,取消仍可达", async () => {
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

    // ADR-0034:有单不再手动归档——被关闭的 MR 不算交付,人只能
    // 续聊返工或取消。
    await assert.rejects(
      () => scene.service.control(scene.id, { action: "archive" }),
      /不再手动归档/,
    );
    const canceled = await scene.service.control(scene.id,
      { action: "cancel" });
    assert.equal(canceled.status, "canceled");
  } finally {
    await scene.stop();
  }
});
