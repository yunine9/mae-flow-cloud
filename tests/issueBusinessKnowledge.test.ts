/**
 * 业务知识地图(ADR-0012)的契约测试:
 * - 资产库定格:进入 analyze 时按绑定模块从发布库选取并只读投影,
 *   台账落账;月光开档照样定格(地图不分介入档);未绑定模块静默缺席;
 * - 仓内 docs/ 索引:一层扫描、40 条上限超限折叠、缺席静默;
 * - 注入点:开场词在 analyze 阶段注入业务知识地图。
 *
 * 范式与 issueMoonlight.test.ts 同款:ScriptedModelServer 剧本,只走
 * 公开 API 断言;地图渲染为纯函数单元断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { createBusinessModule, publishBusinessKnowledgeAsset } from "../src/businessModuleLibrary.ts";
import {
  businessKnowledgeLines,
  REPO_DOCS_INDEX_LIMIT,
} from "../src/issueFlow/businessKnowledge.ts";
import { issueFixedOpeningPrompt } from "../src/issueFlow/prompt.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";

const MODULE_ID = "pay-core";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交与 docs/ 业务总结的裸仓远端。 */
function bareOrigin(root: string, docFiles: number): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  const docs = join(seed, "docs");
  mkdirSync(join(docs, "领域手册"), { recursive: true });
  writeFileSync(join(docs, "领域手册", "对账流程.md"), "# 对账流程\n");
  for (let index = 0; index < docFiles; index += 1) {
    writeFileSync(join(docs, `业务说明-${index}.md`), `# 业务 ${index}\n`);
  }
  execFileSync("git", ["-C", seed, "add", "."], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
}

function seedModuleWithAsset(
  dataDir: string,
  origin: string,
  content: string,
): void {
  createBusinessModule(dataDir, {
    id: MODULE_ID, name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [origin],
  }, "tester");
  publishBusinessKnowledgeAsset(dataDir, MODULE_ID, {
    id: "settlement-faq", title: "清结算 FAQ",
    summary: "对账差异的常见成因与排查顺序",
    when_to_use: "排查对账差异时",
    content,
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

const REPORT = "printf '# 问题分析\\n\\n现象:对账差异。\\n## 问题现象\\n演示现象。\\n## 问题根因\\n"
  + "非问题(测试数据问题)。\\n## 证据链\\n对账记录。\\n## 置信度\\n"
  + "高。\\n## 修改方案\\n修正数据。\\n"
  + "' > issue-analysis.md";

test("绑定模块+仓内 docs:进 analyze 定格资产并投影,台账/文件/转移账齐全", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-biz-know-"));
  const origin = bareOrigin(dataDir, 2);
  seedModuleWithAsset(dataDir, origin, "# 清结算 FAQ\n\n对账差异先查时窗。\n");
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command: REPORT } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "non_issue", confidence: "high",
        summary: "非问题:测试数据" } } },
    { text: "结论已提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    // 月光开:自动闭环归档,顺便证明定格/地图不分介入档。
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
    // 台账:资产按绑定模块定格,字段在场,条目带元数据与相对路径。
    const frozen = archived.business_knowledge;
    assert.ok(frozen, "进入 analyze 必须定格业务知识台账");
    assert.equal(frozen!.entries.length, 1);
    const [entry] = frozen!.entries;
    assert.equal(entry.title, "清结算 FAQ");
    assert.equal(entry.module_name, "支付核心");
    assert.equal(entry.relative_path,
      ".mae-flow-work/business-modules/pay-core/settlement-faq.md");
    // 投影:正文与 INDEX.md 只读落盘。
    assert.ok(existsSync(join(dataDir, "issues", created.id,
      entry.relative_path)), "知识正文只读投影在工作区");
    assert.ok(existsSync(join(dataDir, "issues", created.id,
      ".mae-flow-work", "business-modules", "INDEX.md")),
      "INDEX.md 目录在工作区");
    const transitions = archived.transitions ?? [];
    assert.ok(
      transitions.some((entry) => entry.note.includes("业务知识资产已定格")),
      "定格留转移账");
    // 月光开档不举圈选闸,但资产定格照常——地图不分介入档。
    assert.equal(archived.skill_selection ?? undefined, undefined);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("模块没有已发布资产:台账为空,流程照走(旁路不卡会话)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-biz-nomod-"));
  const origin = bareOrigin(dataDir, 0);
  createBusinessModule(dataDir, {
    id: MODULE_ID, name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [origin],
  }, "tester");
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command: REPORT } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "non_issue", confidence: "high",
        summary: "非问题:测试数据" } } },
    { text: "结论已提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
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
    }, "无发布资产也会走完流程(旁路不卡会话)");
    assert.equal(archived.business_knowledge?.entries.length ?? 0, 0,
      "模块没有已发布资产,台账为空");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("docs 索引:一层扫描、40 条上限折叠、缺席静默、多仓分组", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-issue-biz-docs-"));
  const repoDir = join(workspace, "repo", "origin");
  mkdirSync(join(repoDir, "docs", "手册"), { recursive: true });
  writeFileSync(join(repoDir, "docs", "总览.md"), "# 总览\n");
  writeFileSync(join(repoDir, "docs", "手册", "细节.md"), "# 细节\n");
  const state = {
    mode: "fixed", scenario: "no_ticket", stage: "analyze",
    repo_urls: ["http://example.com/origin.git"],
  } as unknown as IssueSessionState;
  const lines = businessKnowledgeLines(state, workspace);
  assert.ok(lines.some((line) => line.includes("业务知识地图")));
  assert.ok(lines.some((line) => line.includes("repo/origin/docs/总览.md")));
  assert.ok(lines.some((line) => line.includes("repo/origin/docs/手册/")),
    "一级子目录折叠为 dir/ 形式");
  assert.doesNotMatch(lines.join("\n"), /细节\.md/,
    "子目录内容不进地图,交给按需自查");

  // 超限折叠:45 个文件超过 40 条上限,只保留 40 条并注明折叠。
  const big = mkdtempSync(join(tmpdir(), "mfc-issue-biz-big-"));
  const bigDocs = join(big, "repo", "origin", "docs");
  mkdirSync(bigDocs, { recursive: true });
  for (let index = 0; index < 45; index += 1) {
    writeFileSync(join(bigDocs, `f${index}.md`), "# x\n");
  }
  const bigLines = businessKnowledgeLines(
    { ...state, business_knowledge: undefined } as IssueSessionState, big);
  const pathLines = bigLines.filter((line) => line.includes("repo/origin/docs/f"));
  assert.equal(pathLines.length, REPO_DOCS_INDEX_LIMIT);
  assert.ok(bigLines.some((line) => line.includes("已折叠")));

  // 缺席静默:没有 docs/ 也没有台账 → 整段缺席。
  const empty = mkdtempSync(join(tmpdir(), "mfc-issue-biz-empty-"));
  assert.deepEqual(businessKnowledgeLines(
    { ...state, business_knowledge: undefined } as IssueSessionState, empty), []);
});

test("提示层:开场词只在 analyze 阶段注入业务知识地图", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-issue-biz-prompt-"));
  const repoDir = join(workspace, "repo", "origin", "docs");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "对账流程.md"), "# 对账流程\n");
  const base = {
    id: "issue-1", mode: "fixed", scenario: "no_ticket", stage: "analyze",
    title: "对账差异", description: "", account: "dev",
    repo_urls: ["http://example.com/origin.git"],
  } as unknown as IssueSessionState;
  const prompt = issueFixedOpeningPrompt(base, {},
    { moonlight: false, workspace });
  assert.match(prompt, /业务知识地图/);
  assert.match(prompt, /repo\/origin\/docs\/对账流程\.md/);
  // 非 analyze 阶段不注入(地图跟着 analyze 简报走)。
  const prep = { ...base, stage: "prep_repo" } as IssueSessionState;
  assert.doesNotMatch(
    issueFixedOpeningPrompt(prep, {}, { moonlight: false, workspace }),
    /业务知识地图/);
});
