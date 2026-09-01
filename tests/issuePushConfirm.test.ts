/**
 * 问题流 × 推送前过目(交付轴,push_confirm 平台闸,ADR-0009)的契约测试:
 * - push_branch 现读现判个人设置:过目开且无一次性令牌 → 拒绝执行 git
 *   push,举 push_confirm 闸(卡带服务端生成的变更摘要);关/缺席=直推;
 * - 用户确认 → 令牌入会话状态 → 重试成功且令牌消费 → 再推重新被拦;
 * - 答「暂不推送」→ 不产令牌,原阶段续跑,决策与意见入账;
 * - 月光开着也不代这张闸(显式守卫);令牌随 issue.json 持久化,
 *   服务重启后未消费的令牌仍放行下一次推送。
 *
 * 范式与 issueMoonlight.test.ts / issueFlowService.test.ts 同款:
 * ScriptedModelServer 剧本 + 本地裸仓,只走公开 API 断言。推送用例走
 * 自由模式(单号门禁照在,阶段门禁不掺和——与本闸正交)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { IssueFlowOptions } from "../src/issueFlow/service.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";

const TICKET = "DTS2026082001317";
const BRANCH = `master_dev_${TICKET}`;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交的裸仓远端(推送目标),返回其路径。 */
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function baseOptions(dataDir: string, model: ScriptedModelServer): IssueFlowOptions {
  return {
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  };
}

/** 建分支并落一笔真实改动(过目卡上的 diff --stat 才有东西可看)。 */
const COMMIT = `cd repo/origin && git checkout -q -b ${BRANCH} && `
  + "printf 'fixed\\n' > fix.txt && git add -A && "
  + "git -c user.name=test -c user.email=t@e commit -q "
  + `-m '[${TICKET}][fix] 修复登录超时'`;

function readStateFile(dataDir: string, id: string): IssueSessionState {
  return JSON.parse(readFileSync(
    join(dataDir, "issues", id, "issue.json"), "utf-8")) as IssueSessionState;
}

/** push_branch 的工具回执(事件账里的是错误还是成功、说了什么)。 */
function pushReceipts(dataDir: string, id: string): Array<{
  is_error?: boolean;
  result?: string;
}> {
  return readFileSync(join(dataDir, "issues", id, "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>)
    .filter((event) => event.kind === "tool_finished"
      && event.payload?.name === "push_branch")
    .map((event) => event.payload);
}

test("过目开:首推被拒举卡(带变更摘要),确认→令牌→重试成功→令牌消费→再推重新被拦", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-pushconfirm-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "bash", input: { command: COMMIT } } },
    { tool: { name: "push_branch", input: { branch: BRANCH } } },
    { text: "推送被过目闸拦下,已举卡等待用户过目。" },
    // 确认后的续跑回合:重试成功,紧接着的第二次推送重新被拦。
    { tool: { name: "push_branch", input: { branch: BRANCH } } },
    { tool: { name: "push_branch", input: { branch: BRANCH } } },
    { text: "第二次推送又被拦,重新等过目。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    pushConfirmation: () => true,
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
      repoUrl: origin,
    });
    const gated = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "push_confirm"
        ? issue : undefined;
    }, "推送过目卡");
    // 卡面:码表选项+推荐(ADR-0004 徽标依据)+服务端生成的变更摘要。
    const question = gated.gate!.question.questions[0];
    assert.deepEqual(question.options.map((option) => option.code),
      ["push", "hold"]);
    assert.deepEqual(question.options.map((option) => option.label),
      ["确认推送", "暂不推送"]);
    assert.equal(question.recommended, "push");
    assert.ok(gated.gate!.context?.includes("fix.txt"),
      `变更摘要应带 diff --stat(实际:${gated.gate!.context})`);
    assert.ok(gated.gate!.context?.includes(`[${TICKET}][fix] 修复登录超时`),
      "变更摘要应带最近提交题");
    // 拒收回执引导 Agent 停回合等过目;远端此时不应有任何推送。
    const rejected = pushReceipts(dataDir, created.id);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].is_error, true);
    assert.match(String(rejected[0].result), /推送确认卡/);
    assert.equal(service.get(created.id).pushes?.length ?? 0, 0,
      "被拦的推送不该有台账");
    // 用户确认:令牌入会话状态(带确认时刻与决策留痕)。
    service.answer(created.id, {
      state_version: gated.gate!.state_version,
      code: "push", decision: "确认推送",
    });
    const tokened = await until(() => {
      const state = readStateFile(dataDir, created.id);
      return state.push_token ?? undefined;
    }, "确认令牌落盘");
    assert.ok(tokened.at);
    assert.ok(tokened.decision.includes("确认推送"));
    // 重试成功:台账落账、远端真实到位、令牌消费(盘上清除)。
    const pushed = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return (issue.pushes?.length ?? 0) > 0 ? issue : undefined;
    }, "确认后重试推送成功");
    assert.equal(pushed.pushes![0].branch, BRANCH);
    const remote = spawnSync("git",
      ["--git-dir", origin, "rev-parse", `refs/heads/${BRANCH}`],
      { encoding: "utf-8" });
    assert.equal(remote.status, 0, remote.stderr);
    assert.equal(remote.stdout.trim(), pushed.pushes![0].sha);
    const consumed = await until(() => {
      const state = readStateFile(dataDir, created.id);
      return state.push_token === undefined ? state : undefined;
    }, "令牌消费(成功后清除)");
    assert.ok(consumed.transitions?.some((entry) =>
      entry.note.includes("推送过目令牌已消费")), "消费要留痕");
    // 第三次推送重新被拦:每次过目,防盲签。
    const regated = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "push_confirm"
        ? issue : undefined;
    }, "下一次推送重新过目");
    assert.equal(readStateFile(dataDir, created.id).push_token, undefined,
      "新闸未作答前不应有令牌");
    assert.equal(pushReceipts(dataDir, created.id).at(-1)?.is_error, true);

    // 答「暂不推送」:不产令牌,原阶段续跑,决策与意见入账。
    service.answer(created.id, {
      state_version: regated.gate!.state_version,
      code: "hold", decision: "暂不推送",
      notes: "先补 UT 再推",
    });
    const settled = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "暂不推送后续跑收口");
    assert.equal(settled.pushes?.length, 1, "未放行的推送不得记账");
    assert.equal(readStateFile(dataDir, created.id).push_token, undefined,
      "「暂不推送」不产令牌");
    const thread = service.messages(created.id);
    assert.ok(thread.some((message) => message.role === "decision"
      && message.text.includes("暂不推送")), "决策应入账");
    // 意见(notes)随 human_decision 事件入账(过程问答投影与现场导出
    // 都渲染它);messages() 的时间线投影只带决策文本,不含补充说明。
    const decisionEvents = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8")
      .split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((event) => event.kind === "human_decision");
    assert.ok(decisionEvents.some((event) =>
      String(event.payload?.decision ?? "").includes("暂不推送")
      && String(event.payload?.notes ?? "").includes("先补 UT")),
    "用户意见应随决策入账");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("过目开:答「暂不推送」不产令牌、续跑、决策入账(独立卡面)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-pushhold-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "bash", input: { command: COMMIT } } },
    { tool: { name: "push_branch", input: { branch: BRANCH } } },
    { text: "已举卡等待用户过目。" },
    { text: "收到,按用户意见先不推了。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    pushConfirmation: () => true,
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
      repoUrl: origin,
    });
    const gated = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "push_confirm"
        ? issue : undefined;
    }, "推送过目卡");
    service.answer(created.id, {
      state_version: gated.gate!.state_version,
      code: "hold", decision: "暂不推送",
    });
    const settled = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "续跑收口");
    assert.equal(settled.gate ?? undefined, undefined, "闸已落");
    assert.equal(settled.pushes?.length ?? 0, 0, "未放行不得记账");
    assert.equal(readStateFile(dataDir, created.id).push_token, undefined);
    assert.ok(service.messages(created.id).some((message) =>
      message.role === "decision" && message.text.includes("暂不推送")));
    const remote = spawnSync("git",
      ["--git-dir", origin, "for-each-ref", `refs/heads/${BRANCH}`],
      { encoding: "utf-8" });
    assert.equal(remote.stdout.trim(), "", "远端不该出现被否决的分支");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("过目关/回调缺席:push_branch 直推,行为与现状一致", async () => {
  for (const label of ["回调缺席", "显式关"] as const) {
    const dataDir = mkdtempSync(join(tmpdir(), `mfc-issue-pushoff-${label}-`));
    const origin = bareOrigin(dataDir);
    const script: Scene[] = [
      { tool: { name: "pull_repo", input: { url: origin } } },
      { tool: { name: "bash", input: { command: COMMIT } } },
      { tool: { name: "push_branch", input: { branch: BRANCH } } },
      { text: "已推送。" },
    ];
    const model = new ScriptedModelServer(script, "scripted-v1",
      { linear: true });
    await model.start();
    const service = new IssueFlowService({
      ...baseOptions(dataDir, model),
      ...(label === "显式关" ? { pushConfirmation: () => false } : {}),
    });
    try {
      const created = service.create({
        account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
        repoUrl: origin,
      });
      const idle = await until(() => {
        const issue = service.get(created.id);
        if (issue.status === "failed") throw new Error(issue.error ?? "failed");
        return issue.status === "idle" ? issue : undefined;
      }, `直推回合收口(${label})`);
      assert.equal(idle.gate ?? undefined, undefined, `${label}:不该举卡`);
      assert.equal(idle.pushes?.length, 1, `${label}:应直接推送成功`);
      const receipt = pushReceipts(dataDir, created.id)[0];
      assert.equal(receipt.is_error, false, `${label}:push_branch 应成功`);
    } finally {
      await service.shutdown().catch(() => undefined);
      await model.stop();
    }
  }
});

test("月光开:push_confirm 闸不被自动作答(显式守卫,永等真人)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-pushmoon-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "bash", input: { command: COMMIT } } },
    { tool: { name: "push_branch", input: { branch: BRANCH } } },
    { text: "已举卡等待用户过目。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    moonlight: () => true,
    pushConfirmation: () => true,
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
      repoUrl: origin,
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "push_confirm"
        ? issue : undefined;
    }, "推送过目卡");
    // 月光代答 defer 到回合收口之后(setTimeout):等过它再验。
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(service.get(created.id).status, "waiting_user",
      "推送过目是用户显式开启的意志,月光不代,必须仍等真人");
    assert.equal(readStateFile(dataDir, created.id).push_token, undefined,
      "被代答就会产令牌——盘上无令牌即证明没被代答");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("重启:举卡后销毁服务重建,确认后令牌持久,重试推送成功", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-pushrestart-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "bash", input: { command: COMMIT } } },
    { tool: { name: "push_branch", input: { branch: BRANCH } } },
    { text: "已举卡等待用户过目。" },
    // 重启后的续跑回合:重试推送成功。
    { tool: { name: "push_branch", input: { branch: BRANCH } } },
    { text: "重启后确认仍有效,推送完成。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const first = new IssueFlowService({
    ...baseOptions(dataDir, model),
    pushConfirmation: () => true,
  });
  let second: IssueFlowService | undefined;
  try {
    const created = first.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
      repoUrl: origin,
    });
    const gated = await until(() => {
      const issue = first.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "push_confirm"
        ? issue : undefined;
    }, "重启前推送过目卡");
    await first.shutdown();

    // 重建(recover 不清闸、不清令牌):卡原样等家人。
    second = new IssueFlowService({
      ...baseOptions(dataDir, model),
      pushConfirmation: () => true,
    });
    const recovered = second.get(created.id);
    assert.equal(recovered.status, "waiting_user", "重启不吞推送过目卡");
    assert.equal(recovered.gate?.kind, "push_confirm");
    assert.equal(readStateFile(dataDir, created.id).push_token, undefined);

    // 重启后确认:令牌持久生效,重试推送成功并消费。
    second.answer(created.id, {
      state_version: gated.gate!.state_version,
      code: "push", decision: "确认推送",
    });
    const pushed = await until(() => {
      const issue = second!.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return (issue.pushes?.length ?? 0) > 0 ? issue : undefined;
    }, "重启后重试推送成功");
    assert.equal(pushed.pushes![0].branch, BRANCH);
    const state = readStateFile(dataDir, created.id);
    assert.equal(state.push_token, undefined, "令牌消费后清除");
    const remote = spawnSync("git",
      ["--git-dir", origin, "rev-parse", `refs/heads/${BRANCH}`],
      { encoding: "utf-8" });
    assert.equal(remote.stdout.trim(), pushed.pushes![0].sha);
  } finally {
    await first.shutdown().catch(() => undefined);
    await second?.shutdown().catch(() => undefined);
    await model.stop();
  }
});
