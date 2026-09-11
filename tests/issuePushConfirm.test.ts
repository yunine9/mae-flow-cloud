/**
 * 问题流 × 推送前过目(交付轴,push_confirm 平台闸,ADR-0009)的契约测试:
 * - push_branch 现读现判个人设置:过目开且无一次性令牌 → 拒绝执行 git
 *   push,举 push_confirm 闸(卡带服务端生成的变更摘要);关/缺席=直推;
 * - 用户确认 → 令牌入会话状态 → 重试成功且令牌消费 → 再推重新被拦;
 * - 答「暂不推送」→ 不产令牌,原阶段续跑,决策与意见入账;
 * - 月光开着也不代这张闸(显式守卫);令牌随 issue.json 持久化,
 *   服务重启后未消费的令牌仍放行下一次推送。
 *
 * 范式与 issueInterventionTiers.test.ts / issueFlowService.test.ts 同款:
 * ScriptedModelServer 剧本 + 本地裸仓,只走公开 API 断言。推送用例走
 * 固定流程种子(fix 阶段收口后的返工续推:阶段门禁放行 push_branch,
 * 收口态不牵催办——与本闸正交)。
 *
 * 强制覆盖(同单重跑,2026-09-11 增补)契约:force=true 与普通推送
 * 同权跟随「推送前过目」设置——开着时举强制覆盖卡(卡面带远端旧
 * 分支指向),令牌带 force/remote 才放行(重推不必再带参);关着时
 * 直推。普通卡确认过的令牌放不了强制覆盖(防降级错位);确认后
 * 远端又动了,租赁式核对拒绝并自动重举强制卡(覆盖对象变了,确认
 * 作废)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { IssueFlowOptions } from "../src/issueFlow/service.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import { createIssueTools, type IssueToolContext } from "../src/issueFlow/tools.ts";
import { mfcTemp } from "./mfcTmp.ts";

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
    await new Promise((resolve) => setTimeout(resolve, 10));
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

/** 推送过目闸的回归现场:盘上种子一个固定流程会话(fix 阶段已收口
 * 的返工续推,阶段门禁放行 push_branch,收口态不牵催办),恢复管线
 * 点火。必须在构造服务**之前**调用。 */
function seedFixedIssue(dataDir: string, repoUrl: string): { id: string } {
  const now = new Date().toISOString();
  mkdirSync(join(dataDir, "issues", "issue-1"), { recursive: true });
  writeFileSync(join(dataDir, "issues", "issue-1", "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev", created_at: now, updated_at: now,
    title: "登录超时", description: "", source: "dts",
    ticket: TICKET,
    repo_url: repoUrl, repo_urls: [repoUrl],
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "pending"],
    status: "running",
    stage: "fix", stage_note: "正在排查", stage_at: now,
  }));
  return { id: "issue-1" };
}

/** 落一笔真实改动(修复分支由宿主在 pull_repo 时切好,过目卡上的
 * diff --stat 才有东西可看)。 */
const COMMIT = `cd repo/origin && `
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

test("三档把控(过目):首推被拒举卡(带变更摘要),确认→令牌→重试成功→令牌消费→再推重新被拦", async () => {
  const dataDir = mfcTemp("mfc-issue-pushconfirm-");
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
  const created = seedFixedIssue(dataDir, origin);
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    interventionTier: () => "3",
  });
  try {
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
      entry.note.includes("推送确认令牌已用掉")), "消费要留痕");
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

test("三档把控(过目):答「暂不推送」不产令牌、续跑、决策入账(独立卡面)", async () => {
  const dataDir = mfcTemp("mfc-issue-pushhold-");
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
  const created = seedFixedIssue(dataDir, origin);
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    interventionTier: () => "3",
  });
  try {
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

test("一/二档直推:push_branch 不过目直接推(ADR-0019 过目并进三档)", async () => {
  for (const label of ["二档缺省", "一档全自动"] as const) {
    const dataDir = mfcTemp(`mfc-issue-pushoff-${label}-`);
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
    const created = seedFixedIssue(dataDir, origin);
    const service = new IssueFlowService({
      ...baseOptions(dataDir, model),
      ...(label === "一档全自动" ? { interventionTier: () => "1" } : {}),
    });
    try {
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

test("三档把控:push_confirm 闸等真人(档位守卫永不代答)", async () => {
  const dataDir = mfcTemp("mfc-issue-pushmoon-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "bash", input: { command: COMMIT } } },
    { tool: { name: "push_branch", input: { branch: BRANCH } } },
    { text: "已举卡等待用户过目。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const created = seedFixedIssue(dataDir, origin);
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    interventionTier: () => "3",
  });
  try {
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
  const dataDir = mfcTemp("mfc-issue-pushrestart-");
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
  const created = seedFixedIssue(dataDir, origin);
  const first = new IssueFlowService({
    ...baseOptions(dataDir, model),
    interventionTier: () => "3",
  });
  let second: IssueFlowService | undefined;
  try {
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
      interventionTier: () => "3",
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

test("三档把控(过目):确认后又有新提交,重推对不上过目 tip 即作废重举(防盲签完整形态)", async () => {
  const dataDir = mfcTemp("mfc-issue-pushstale-");
  const origin = bareOrigin(dataDir);
  // 第二笔提交:不再建分支(首笔已建),直接在 BRANCH 上加新文件。
  const COMMIT2 = `cd repo/origin && printf 'more\\n' > second.txt && `
    + "git add -A && git -c user.name=test -c user.email=t@e commit -q "
    + `-m '[${TICKET}][fix] 补充第二处修改'`;
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "bash", input: { command: COMMIT } } },
    { tool: { name: "push_branch", input: { branch: BRANCH } } },
    { text: "推送被过目闸拦下,等待用户过目。" },
    // 确认后续跑:Agent 又提交了一笔,然后重推——tip 变了,重新举卡。
    { tool: { name: "bash", input: { command: COMMIT2 } } },
    { tool: { name: "push_branch", input: { branch: BRANCH } } },
    { text: "过目后有新提交,已重新举卡等待再次过目。" },
    // 二次确认后重推:tip 对上,放行。
    { tool: { name: "push_branch", input: { branch: BRANCH } } },
    { text: "推送完成。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const created = seedFixedIssue(dataDir, origin);
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    interventionTier: () => "3",
  });
  try {
    const gated = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "push_confirm"
        ? issue : undefined;
    }, "第一张推送过目卡");
    assert.ok(gated.gate!.context?.includes("fix.txt"));
    service.answer(created.id, {
      state_version: gated.gate!.state_version,
      code: "push", decision: "确认推送",
    });
    const tokened = await until(() => {
      const state = readStateFile(dataDir, created.id);
      return state.push_token ?? undefined;
    }, "确认令牌落盘");
    assert.ok(tokened.head, "令牌绑定过目那一刻的分支 tip");

    // 确认后又有新提交:重推对不上 tip,旧令牌作废,重新举卡(带新摘要)。
    const regated = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "push_confirm"
        ? issue : undefined;
    }, "tip 变化后重新举卡");
    assert.notEqual(regated.gate!.id, gated.gate!.id, "是新举的卡,不是旧卡");
    assert.match(regated.gate!.question.questions[0].question, /又有新提交/);
    assert.ok(regated.gate!.context?.includes("second.txt"),
      `新摘要应带第二笔提交的文件(实际:${regated.gate!.context})`);
    assert.equal(readStateFile(dataDir, created.id).push_token, undefined,
      "作废的令牌不留盘");
    const staleRejected = pushReceipts(dataDir, created.id).at(-1);
    assert.equal(staleRejected?.is_error, true);
    assert.match(String(staleRejected?.result), /又有新提交/);

    // 二次确认后重推:tip 对上,放行成功。
    service.answer(created.id, {
      state_version: regated.gate!.state_version,
      code: "push", decision: "确认推送",
    });
    const pushed = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return (issue.pushes?.length ?? 0) > 0 ? issue : undefined;
    }, "二次确认后推送成功");
    const remote = spawnSync("git",
      ["--git-dir", origin, "rev-parse", `refs/heads/${BRANCH}`],
      { encoding: "utf-8" });
    assert.equal(remote.status, 0, remote.stderr);
    assert.equal(remote.stdout.trim(), pushed.pushes![0].sha);
    assert.equal(readStateFile(dataDir, created.id).push_token, undefined,
      "成功即消费");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- issue-14 收口(2026-09-10):并发竞态与连环举卡(免模型直调) ----
// 生产事故形态:AI 同毫秒并发调两个仓的 push_branch——一次性令牌是
// 会话级单例,交错读删要么 TypeError 崩溃(reading 'head')、要么一次
// 确认放行两次推送(过目闸被绕过);同回合连环重调则反复顶掉用户还
// 没答的卡(单卡槽重举)。收口:在途互斥 + 已举卡快速打回 + 令牌快照。

/** 双仓直调现场:两个裸仓远端 + 各自克隆(修复分支上各一笔提交)。 */
function seedTwinRepos(dataDir: string): { alpha: string; beta: string } {
  const make = (name: string): string => {
    const seed = join(dataDir, `seed-${name}`);
    execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
    execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
      "-m", "init"], { env: GIT_ENV });
    const origin = join(dataDir, `${name}.git`);
    execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
    const clone = join(dataDir, "repo", name);
    execFileSync("git", ["clone", "-q", origin, clone], { env: GIT_ENV });
    execFileSync("git", ["-C", clone, "checkout", "-q", "-b", BRANCH],
      { env: GIT_ENV });
    execFileSync("git", ["-C", clone, "commit", "-q", "--allow-empty",
      "-m", `[${TICKET}][fix] ${name}`], { env: GIT_ENV });
    return origin;
  };
  return { alpha: make("alpha"), beta: make("beta") };
}

/** 过目开着(三档)的直调工具上下文 + push_branch。 */
function directPushTools(state: IssueSessionState, dataDir: string): {
  push: { execute: (id: string, params: any) => Promise<unknown> };
} {
  const ctx: IssueToolContext = {
    state,
    workspace: dataDir,
    dataRoot: dataDir,
    persist: () => undefined,
    pushConfirmation: () => true,
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(40),
    }),
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const push = tools.find((tool) => tool.name === "push_branch");
  assert.ok(push, "应注册 push_branch");
  return { push: push! };
}

function raceState(alpha: string, beta: string, now: string): IssueSessionState {
  return {
    id: "issue-race", account: "dev", created_at: now, updated_at: now,
    title: "推送竞态", description: "", source: "dts", ticket: TICKET,
    repo_url: alpha, repo_urls: [alpha, beta],
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "pending"],
    status: "idle", stage: "fix", stage_note: "", stage_at: now,
  };
}

test("issue-14 收口:同毫秒双 push_branch——一个举卡一个在途打回,不崩溃不绕过", async () => {
  const dataDir = mfcTemp("mfc-issue-pushrace-");
  const { alpha, beta } = seedTwinRepos(dataDir);
  const state = raceState(alpha, beta, new Date().toISOString());
  const { push } = directPushTools(state, dataDir);
  // 并发双调(生产同毫秒形态):无论谁先拿到在途锁,恰好一个走举卡
  // 路径、一个收"一次只推一个仓";谁都不许读空令牌崩溃。
  const settled = await Promise.allSettled([
    push.execute("a", { branch: BRANCH, repo: alpha }),
    push.execute("b", { branch: BRANCH, repo: beta }),
  ]);
  const reasons = settled.map((item) => item.status === "rejected"
    ? String((item.reason as Error)?.message ?? item.reason) : "");
  assert.equal(reasons.filter((reason) => reason.length > 0).length, 2,
    `并发双调都应被拒(一个举卡一个在途打回),实际:${reasons}`);
  assert.equal(reasons.filter((reason) => /一次只推一个仓/.test(reason)).length, 1,
    `恰一个收在途打回:${reasons}`);
  assert.equal(reasons.filter((reason) => /推送确认卡/.test(reason)).length, 1,
    `恰一个走举卡路径:${reasons}`);
  for (const reason of reasons) {
    assert.ok(!/Cannot read properties/.test(reason),
      `并发不得读空令牌崩溃(实际:${reason})`);
  }
  const raised = reasons.find((reason) => /推送确认卡/.test(reason))!;
  assert.match(raised, /逐仓/, "举卡回执要教多仓串行节奏");
  assert.equal(state.gate?.kind, "push_confirm", "过目卡在场");
  assert.equal(state.pushes, undefined, "被拦的推送不得有台账");
  assert.equal((state.transitions ?? []).filter((entry) =>
    /平台举闸/.test(entry.note ?? "")).length, 1,
    "只举了一次卡(并发另一个没有再举)");
});

test("issue-14 收口:卡已在等作答时连环重调——快速打回,不顶掉旧卡", async () => {
  const dataDir = mfcTemp("mfc-issue-pushchain-");
  const { alpha, beta } = seedTwinRepos(dataDir);
  const state = raceState(alpha, beta, new Date().toISOString());
  const { push } = directPushTools(state, dataDir);
  // 第一调:正常举卡收尾。
  await assert.rejects(
    () => push.execute("a", { branch: BRANCH, repo: alpha }),
    /推送确认卡/);
  const firstGate = state.gate!;
  assert.equal(firstGate.kind, "push_confirm");
  // 同回合连环重调(另一仓与同仓形态相同):不再重举,快速打回教节奏。
  const second = await push.execute("b", { branch: BRANCH, repo: beta })
    .then(() => "", (error: Error) => error.message);
  assert.match(second, /已在等用户作答/, "连环调要收等作答回执");
  assert.match(second, /逐仓/, "回执要教多仓串行节奏");
  await assert.rejects(
    () => push.execute("c", { branch: BRANCH, repo: alpha }),
    /已在等用户作答/);
  assert.equal(state.gate?.id, firstGate.id, "旧卡不被顶掉(单卡槽)");
  assert.equal((state.transitions ?? []).filter((entry) =>
    /平台举闸/.test(entry.note ?? "")).length, 1, "全程只举一次卡");
});

// ---- 强制覆盖(同单重跑,2026-09-11 增补)----

/** 同单重跑现场:远端已有上次运行推过的同名分支(与本次重跑历史
 * 分叉,普通推送必被 non-fast-forward 拒)。返回克隆目录与遗留 tip,
 * 供"确认后远端又动"的用例续推。 */
function seedLeftoverBranch(
  root: string,
  origin: string,
): { dir: string; tip: string } {
  const dir = join(root, "leftover");
  execFileSync("git", ["clone", "-q", origin, dir], { env: GIT_ENV });
  execFileSync("git", ["-C", dir, "checkout", "-q", "-b", BRANCH],
    { env: GIT_ENV });
  execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty",
    "-m", `[${TICKET}][fix] 上次运行遗留提交`], { env: GIT_ENV });
  execFileSync("git", ["-C", dir, "push", "-q", "origin", BRANCH],
    { env: GIT_ENV });
  const tip = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"],
    { encoding: "utf-8", env: GIT_ENV }).trim();
  return { dir, tip };
}

function remoteBranchSha(origin: string): string {
  return execFileSync("git",
    ["--git-dir", origin, "rev-parse", `refs/heads/${BRANCH}`],
    { encoding: "utf-8", env: GIT_ENV }).trim();
}

test("强制覆盖(三档):举强制卡带远端指向,确认→令牌带 force/remote→重推覆盖成功(不必再带参)", async () => {
  const dataDir = mfcTemp("mfc-issue-pushforce-");
  const origin = bareOrigin(dataDir);
  const leftover = seedLeftoverBranch(dataDir, origin);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "bash", input: { command: COMMIT } } },
    { tool: { name: "push_branch", input: { branch: BRANCH, force: true } } },
    { text: "已举强制覆盖卡等待用户确认。" },
    // 确认后重推不带 force:覆盖语义随令牌走。
    { tool: { name: "push_branch", input: { branch: BRANCH } } },
    { text: "强制覆盖完成。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const created = seedFixedIssue(dataDir, origin);
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    interventionTier: () => "3",
  });
  try {
    const gated = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "push_confirm"
        ? issue : undefined;
    }, "强制覆盖过目卡");
    const question = gated.gate!.question.questions[0].question;
    assert.match(question, /强制覆盖/);
    assert.match(question, new RegExp(leftover.tip.slice(0, 8)),
      `卡面要带远端旧分支指向(覆盖对象身份,实际:${question})`);
    assert.equal(pushReceipts(dataDir, created.id).length, 1);
    assert.match(String(pushReceipts(dataDir, created.id)[0].result),
      /强制覆盖确认卡/);
    assert.equal(remoteBranchSha(origin), leftover.tip, "举卡阶段远端不动");

    service.answer(created.id, {
      state_version: gated.gate!.state_version,
      code: "push", decision: "确认推送",
    });
    const tokened = await until(() => {
      const state = readStateFile(dataDir, created.id);
      return state.push_token ?? undefined;
    }, "确认令牌落盘");
    assert.equal(tokened.force, true, "令牌带强制覆盖语义");
    assert.equal(tokened.remote, leftover.tip, "令牌绑定确认时的远端旧 tip");

    const pushed = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return (issue.pushes?.length ?? 0) > 0 ? issue : undefined;
    }, "确认后强制覆盖成功");
    assert.notEqual(remoteBranchSha(origin), leftover.tip, "远端旧 tip 被覆盖");
    assert.equal(remoteBranchSha(origin), pushed.pushes![0].sha);
    const receipts = pushReceipts(dataDir, created.id);
    assert.equal(receipts.at(-1)?.is_error, false);
    assert.match(String(receipts.at(-1)?.result), /强制覆盖/);
    assert.ok(readStateFile(dataDir, created.id).transitions?.some((entry) =>
      entry.note.includes("强制覆盖远端同名分支")), "覆盖要留痕(转移账)");
    assert.equal(readStateFile(dataDir, created.id).push_token, undefined,
      "令牌成功即消费");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("强制覆盖(一/二档直推):过目关着 force 与普通推送同权——直推覆盖,不举卡", async () => {
  const dataDir = mfcTemp("mfc-issue-pushforce-off-");
  const origin = bareOrigin(dataDir);
  const leftover = seedLeftoverBranch(dataDir, origin);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "bash", input: { command: COMMIT } } },
    { tool: { name: "push_branch", input: { branch: BRANCH, force: true } } },
    { text: "已直推强制覆盖。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const created = seedFixedIssue(dataDir, origin);
  const service = new IssueFlowService({ ...baseOptions(dataDir, model) });
  try {
    const idle = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "直推覆盖回合收口");
    assert.equal(idle.gate ?? undefined, undefined, "不举卡(跟随过目设置)");
    assert.equal(idle.pushes?.length, 1);
    assert.notEqual(remoteBranchSha(origin), leftover.tip, "遗留分支被覆盖");
    assert.equal(remoteBranchSha(origin), idle.pushes![0].sha);
    const receipt = pushReceipts(dataDir, created.id)[0];
    assert.equal(receipt.is_error, false);
    assert.match(String(receipt.result), /强制覆盖/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("防降级错位:普通卡确认过的令牌放不了强制覆盖——带 force 重推即作废旧令牌重举强制卡", async () => {
  const dataDir = mfcTemp("mfc-issue-pushforce-down-");
  const origin = bareOrigin(dataDir);
  seedLeftoverBranch(dataDir, origin);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "bash", input: { command: COMMIT } } },
    { tool: { name: "push_branch", input: { branch: BRANCH } } },
    { text: "已举普通推送过目卡。" },
    // 普通确认后带 force 重推:令牌不含强制语义,作废重举强制卡。
    { tool: { name: "push_branch", input: { branch: BRANCH, force: true } } },
    { text: "普通确认不含强制语义,已重举强制覆盖卡。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const created = seedFixedIssue(dataDir, origin);
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    interventionTier: () => "3",
  });
  try {
    const gated = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "push_confirm"
        ? issue : undefined;
    }, "普通过目卡");
    assert.doesNotMatch(gated.gate!.question.questions[0].question, /强制覆盖/);
    service.answer(created.id, {
      state_version: gated.gate!.state_version,
      code: "push", decision: "确认推送",
    });
    const tokened = await until(() => {
      const state = readStateFile(dataDir, created.id);
      return state.push_token ?? undefined;
    }, "普通确认令牌落盘");
    assert.equal(tokened.force, undefined, "普通卡令牌不带强制语义");

    const regated = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "push_confirm"
        && issue.gate.id !== gated.gate!.id
        ? issue : undefined;
    }, "重举强制覆盖卡");
    assert.match(regated.gate!.question.questions[0].question,
      /上次确认未含强制覆盖/);
    assert.match(regated.gate!.question.questions[0].question, /强制覆盖/);
    assert.equal(readStateFile(dataDir, created.id).push_token, undefined,
      "旧令牌作废不留盘");
    assert.equal(regated.pushes?.length ?? 0, 0, "未放行不得记账");
    const last = pushReceipts(dataDir, created.id).at(-1);
    assert.equal(last?.is_error, true);
    assert.match(String(last?.result), /强制覆盖确认卡/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("覆盖对象变了:确认后远端分支又被推送——租赁核对拒绝,自动重举强制卡", async () => {
  const dataDir = mfcTemp("mfc-issue-pushforce-stale-");
  const origin = bareOrigin(dataDir);
  const leftover = seedLeftoverBranch(dataDir, origin);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "bash", input: { command: COMMIT } } },
    { tool: { name: "push_branch", input: { branch: BRANCH, force: true } } },
    { text: "已举强制覆盖卡。" },
    // 确认后重推:远端已被他人推进,租赁核对应拒并重举。
    { tool: { name: "push_branch", input: { branch: BRANCH } } },
    { text: "远端又动了,已重举强制覆盖卡。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const created = seedFixedIssue(dataDir, origin);
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    interventionTier: () => "3",
  });
  try {
    const gated = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "push_confirm"
        ? issue : undefined;
    }, "强制覆盖过目卡");
    // 确认前把远端旧分支再推一笔(他人/另一会话形态):用户确认的
    // 覆盖对象与推送时的实际对象分叉。
    execFileSync("git", ["-C", leftover.dir, "commit", "-q", "--allow-empty",
      "-m", "他人又推了一笔"], { env: GIT_ENV });
    execFileSync("git", ["-C", leftover.dir, "push", "-q", "origin", BRANCH],
      { env: GIT_ENV });
    service.answer(created.id, {
      state_version: gated.gate!.state_version,
      code: "push", decision: "确认推送",
    });
    const regated = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "push_confirm"
        && issue.gate.id !== gated.gate!.id
        ? issue : undefined;
    }, "覆盖对象变了重举强制卡");
    const question = regated.gate!.question.questions[0].question;
    assert.match(question, /又有变动/);
    assert.match(question, /强制覆盖/);
    assert.equal(readStateFile(dataDir, created.id).push_token, undefined,
      "对不上确认对象的令牌作废");
    assert.equal(regated.pushes?.length ?? 0, 0, "没推成不得记账");
    assert.notEqual(remoteBranchSha(origin), leftover.tip,
      "远端保持他人那笔(未被盲盖)");
    const last = pushReceipts(dataDir, created.id).at(-1);
    assert.equal(last?.is_error, true);
    assert.match(String(last?.result), /又有变动/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
