/**
 * 问题流 × 人工介入程度(月光轴,ADR-0006)的契约测试:
 * - 机械层:analysis_confirm 月光全量代答;conclude 仅 non_issue+高置信
 *   代答(闭环无下游闸,分级保守);缺省(回调缺席)一律等真人;
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
const REPORT = "printf '# 问题分析\\n\\n现象:登录超时。\\n## 结论\\n"
  + "非问题(测试环境时钟漂移)。\\n## 证据链\\n时钟偏差记录。\\n## 置信度\\n"
  + "高:偏差可复现。\\n## 下一步建议\\n校时后观察,建议归档。\\n"
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
    issueFlowMode: () => "fixed",
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
    issueFlowMode: () => "fixed",
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
      issueFlowMode: () => "fixed",
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
    id: "issue-1", mode: "fixed", scenario: "ticket", stage: "analyze",
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
