/**
 * skill 圈选入口闸(ADR-0011)的契约测试:
 * - 月光关 + 已拉仓有 `.cac/skills`:complete_stage 推进进 analyze 时
 *   平台举 skill_select 多选卡,清单来自本地扫描;
 * - 勾选落台账(skill_selection)、清闸、续跑消息带必读清单,流程
 *   走到报告确认闸;清单外的 selection 一律拒绝(自报路径进不来);
 * - 空选 =「都不用,AI 自主」:台账记空集合;重走(检视意见回流)
 *   不重举;
 * - 月光开不举卡;扫描为空不举卡;
 * - 提示层:开场词在 analyze 阶段注入必读集合。
 *
 * 范式与 issueMoonlight.test.ts 同款:ScriptedModelServer 剧本,只走
 * 公开 API 断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { issueFixedOpeningPrompt } from "../src/issueFlow/prompt.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";

const TICKET = "DTS-2026-1001";
const SKILL_PATH = "repo/origin/.cac/skills/login-triage/SKILL.md";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交的裸仓远端,`withSkill` 决定仓里有没有业务 skill。 */
function bareOrigin(root: string, withSkill: boolean): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  if (withSkill) {
    const skillDir = join(seed, ".cac", "skills", "login-triage");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"),
      "---\nname: login-triage\n"
      + "description: 登录链路五步排障:定位超时环节,核对会话与网关配置\n"
      + "---\n\n# 登录链路排障\n\n先复现,再分段计时。\n");
  }
  execFileSync("git", ["-C", seed, "add", "."], { env: GIT_ENV });
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
const REPORT = "printf '# 问题分析\\n\\n现象:登录超时。\\n## 结论\\n"
  + "会话网关超时配置过小。\\n## 证据链\\n网关日志时间戳。\\n## 置信度\\n"
  + "中:缺复现环境。\\n## 下一步建议\\n调大超时阈值。\\n"
  + "' > issue-analysis.md";

/** 拉单→拉仓→收口进 analyze 的公共前半段:第 4 幕 complete_stage 会
 * 触发圈选闸(月光关且仓内有 skill 时),第 5 幕收嘴——闸在场 settle
 * 定格 waiting_user,不会被催办。 */
function frontScenes(origin: string): Scene[] {
  return [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { text: "已进入问题分析,等待用户圈选必读知识。" },
  ];
}

async function waitSkillGate(service: IssueFlowService, id: string) {
  return until(() => {
    const issue = service.get(id);
    if (issue.status === "failed") throw new Error(issue.error ?? "failed");
    return issue.status === "waiting_user" && issue.gate?.kind === "skill_select"
      ? issue : undefined;
  }, "skill 圈选闸等真人");
}

test("月光关+仓内有业务 skill:分析入口举多选圈选卡,勾选落台账并继续到报告确认", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-skill-pick-"));
  const origin = bareOrigin(dataDir, true);
  const script: Scene[] = [
    ...frontScenes(origin),
    { tool: { name: "bash", input: { command: REPORT } } },
    { tool: { name: "submit_analysis", input: { summary: "会话网关超时配置过小" } } },
    { text: "报告已提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    issueFlowMode: () => "fixed",
    moonlight: () => false,
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
      repoUrl: origin,
    });
    const gated = await waitSkillGate(service, created.id);
    // 清单来自本地扫描:path 是工作区相对路径,描述取自 frontmatter。
    assert.equal(gated.gate?.skills?.length, 1);
    const [choice] = gated.gate!.skills!;
    assert.equal(choice.path, SKILL_PATH);
    assert.equal(choice.name, "login-triage");
    assert.ok(choice.description.includes("登录链路五步排障"),
      "描述应从 SKILL.md frontmatter 解析");
    assert.deepEqual(gated.gate!.question.questions[0].options,
      [{ code: "skip", label: "都不用,AI 按取用次序自主" }],
      "码表只有「都不用」单码,勾选走 selection 专用口");
    assert.equal(gated.gate!.question.questions[0].recommended ?? undefined,
      undefined, "本卡只在月光关时举起,永远人答,没有推荐码");

    // 清单外的 selection 一律拒绝:状态不动,闸仍在。
    assert.throws(
      () => service.answer(created.id, {
        state_version: gated.gate!.state_version,
        selection: ["repo/origin/.cac/skills/evil/SKILL.md"],
      }),
      /清单之外/,
    );
    assert.equal(service.get(created.id).gate?.kind, "skill_select",
      "被拒的作答不清闸");

    // 正式勾选:落台账、清闸、续跑到报告提交(剧本后三幕)。
    const answered = service.answer(created.id, {
      state_version: gated.gate!.state_version,
      selection: [SKILL_PATH],
    });
    assert.equal(answered.gate ?? undefined, undefined, "作答即清闸");
    assert.equal(answered.skill_selection?.skills.length, 1);
    assert.equal(answered.skill_selection!.skills[0].path, SKILL_PATH);
    const confirmed = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm" ? issue : undefined;
    }, "圈选后继续走到报告确认闸");
    assert.equal(confirmed.skill_selection?.skills.length, 1,
      "必读集合随台账留存");
    // 现场账双通道:human_decision 事件落 events.jsonl(人话决策+勾选
    // 结果+续跑消息),转移账落 issue.json(作答记要)。
    const events = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8");
    assert.ok(events.includes("圈选必读 skill:login-triage"),
      "现场账的人话决策带勾选项");
    assert.ok(events.includes(SKILL_PATH),
      "续跑消息把必读路径交给了重建的上下文");
    const transitions = confirmed.transitions ?? [];
    assert.ok(
      transitions.some((entry) => entry.note.includes("用户作答(skill_select)")),
      "转移账记录圈选作答");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("空选=都不用:AI 自主,台账记空集合;检视意见回流分析不重举", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-skill-skip-"));
  const origin = bareOrigin(dataDir, true);
  const script: Scene[] = [
    ...frontScenes(origin),
    { tool: { name: "bash", input: { command: REPORT } } },
    { tool: { name: "submit_analysis", input: { summary: "会话网关超时配置过小" } } },
    { text: "报告已提交。" },
    { tool: { name: "bash", input: { command: REPORT } } },
    { tool: { name: "submit_analysis", input: { summary: "修订:补时序证据" } } },
    { text: "修订已重新提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    issueFlowMode: () => "fixed",
    moonlight: () => false,
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
      repoUrl: origin,
    });
    const gated = await waitSkillGate(service, created.id);
    const answered = service.answer(created.id, {
      state_version: gated.gate!.state_version,
      selection: [],
    });
    assert.deepEqual(answered.skill_selection?.skills ?? null, [],
      "空选也要落台账:字段在场=已作答,是重走不重举的判据");
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm" ? issue : undefined;
    }, "空选后继续走到报告确认闸");
    // 检视意见(补充意见码)回流分析:重走不重举,只有最初那一道圈选闸。
    service.answer(created.id, {
      state_version: service.get(created.id).gate!.state_version,
      code: "supplement",
      notes: "请再核对时序证据",
    });
    const again = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm" ? issue : undefined;
    }, "补充意见后重新提交,再次到报告确认闸");
    assert.ok(again.skill_selection !== undefined,
      "台账仍是那条空选记录(空数组不等于缺席)");
    assert.deepEqual(again.skill_selection!.skills, []);
    const transitions = again.transitions ?? [];
    assert.equal(
      transitions.filter((entry) => entry.note.includes("skill 圈选")).length,
      1,
      "全程只举过一次圈选闸:重走 analyze 不重举");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("月光开:分析入口不举圈选卡,AI 按取用次序自主", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-skill-moon-"));
  const origin = bareOrigin(dataDir, true);
  const script: Scene[] = [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command: REPORT } } },
    { tool: { name: "submit_analysis", input: { summary: "非问题:时钟漂移" } } },
    { text: "报告已提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    issueFlowMode: () => "fixed",
    moonlight: () => true,
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
      repoUrl: origin,
    });
    // 月光全量代答分析确认闸,一路推进到问题修改;圈选台账缺席——
    // 月光开档连举卡都不举,更没有代答一说。
    const advanced = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.stage === "fix" ? issue : undefined;
    }, "月光自动确认推进到问题修改");
    assert.equal(advanced.skill_selection ?? undefined, undefined,
      "月光开档不举圈选卡,台账缺席");
    const transitions = service.get(created.id).transitions ?? [];
    assert.equal(
      transitions.filter((entry) => entry.note.includes("skill 圈选")).length,
      0);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("扫描为空:仓里没有 .cac/skills 时不举卡,留一行转移账直接进分析", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-skill-empty-"));
  const origin = bareOrigin(dataDir, false);
  const script: Scene[] = [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command: REPORT } } },
    { tool: { name: "submit_analysis", input: { summary: "会话网关超时配置过小" } } },
    { text: "报告已提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    issueFlowMode: () => "fixed",
    moonlight: () => false,
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
      repoUrl: origin,
    });
    // 没有圈选闸,一路走到报告确认闸等真人。
    const gated = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm" ? issue : undefined;
    }, "无 skill 时直接走到报告确认闸");
    assert.equal(gated.skill_selection ?? undefined, undefined);
    const transitions = gated.transitions ?? [];
    assert.ok(
      transitions.some((entry) => entry.note.includes("未发现业务 skill")),
      "扫描为空留一行转移账,现场可查");
    assert.equal(
      transitions.filter((entry) => entry.note.includes("skill 圈选")).length,
      0);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("提示层:开场词只在 analyze 阶段注入必读集合", () => {
  const skill = {
    path: SKILL_PATH,
    repo: "http://example.com/origin.git",
    name: "login-triage",
    description: "登录链路五步排障",
  };
  const base = {
    id: "issue-1", mode: "fixed", scenario: "ticket",
    title: "登录超时", description: "", account: "dev", ticket: TICKET,
    skill_selection: { at: "2026-09-02T00:00:00Z", skills: [skill] },
  } as unknown as IssueSessionState;
  const analyze = { ...base, stage: "analyze" } as IssueSessionState;
  const prep = { ...base, stage: "prep_repo" } as IssueSessionState;
  const withSelection = issueFixedOpeningPrompt(analyze, {}, { moonlight: false });
  assert.match(withSelection, /必读 skill\(用户圈选,分析前先读;/);
  assert.match(withSelection, new RegExp(SKILL_PATH.replace(/[/.]/g, "\\$&")));
  assert.match(withSelection, /登录链路五步排障/);
  const noInjection = issueFixedOpeningPrompt(prep, {}, { moonlight: false });
  assert.doesNotMatch(noInjection, /必读 skill/, "非分析阶段不注入");
  const untouched = issueFixedOpeningPrompt(
    { ...base, stage: "analyze", skill_selection: undefined } as IssueSessionState,
    {}, { moonlight: false });
  assert.doesNotMatch(untouched, /必读 skill/, "未圈选不注入");
});
