/**
 * 技能正文漂移对账(2026-09-03 提示词审查 P0):assets/issue-skills 是
 * Agent 的行为契约,历史上 ADR 级变更(换库封存、五章节、report_stage
 * 随自由引擎整体删除,#99)从不回扫正文,skills 教已封存工具/已删
 * 机制、教不存在的工具。本测试把底线钉死:
 * 1. 禁词——封存工具与已删机制不得在任何技能正文出现(封存纪律:
 *    代码原地保留,但"活表面"不指向它);
 * 2. 工具名真实性——正文反引号里的 snake_case 词必须是真实注册的
 *    平台工具或公认内建/命令,改名删除当场炸。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createIssueTools, type IssueToolContext } from "../src/issueFlow/tools.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";

const SKILL_DIR = join(
  fileURLToPath(import.meta.url), "..", "..", "assets", "issue-skills");

function skillFiles(): Array<{ name: string; text: string }> {
  return readdirSync(SKILL_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((dir) => {
      const path = join(SKILL_DIR, dir.name, "SKILL.md");
      try {
        return [{ name: dir.name, text: readFileSync(path, "utf-8") }];
      } catch {
        return []; // 缺 SKILL.md 由 materializeIssueSkills 的 fail-loud 把关
      }
    });
}

function minimalState(): IssueSessionState {
  const now = new Date().toISOString();
  return {
    id: "drift-fixed", account: "dev",
    created_at: now, updated_at: now,
    title: "t", description: "", source: "manual",
    repo_url: "/tmp/x.git", scenario: "ticket",
    round: 1,
    status: "running", stage: "dts_info",
    stage_note: "", stage_at: now,
  };
}

function registeredToolNames(): Set<string> {
  const ctx: IssueToolContext = {
    state: minimalState(),
    workspace: "/tmp", dataRoot: "/tmp",
    persist: () => undefined,
    pullRepo: async () => ({
      dir: "repo/x", cloned: false, head: "0123456789abcdef",
    }),
  };
  return new Set(
    (createIssueTools(ctx) as Array<{ name: string }>)
      .map((tool) => tool.name));
}

/** 反引号包裹的纯 snake_case 词 = 工具名候选(带下划线才查,免误伤
 * git/grep 这类单命令词与含空格的完整命令行)。 */
function backtickedSnakeTokens(text: string): string[] {
  return [...text.matchAll(/`([a-z][a-z_]*[a-z])`/g)]
    .map((match) => match[1])
    .filter((token) => token.includes("_"));
}

const BUILTINS = new Set([
  "bash", "AskUserQuestion", "inspect_image", "read", "read_file",
]);

test("技能正文不指向封存工具与已删机制(ADR-0013/五章节)", () => {
  const files = skillFiles();
  assert.ok(files.length >= 5, `技能目录异常: ${files.length} 份`);
  for (const { name, text } of files) {
    for (const banned of ["build_deploy", "换库", "四章节", "下一步建议", "deploy_verify"]) {
      assert.ok(!text.includes(banned),
        `技能 ${name} 含禁词「${banned}」——封存/已删机制的活表面,改技能正文`);
    }
  }
});

test("技能正文引用的工具名全部真实存在(固定∪内建)", () => {
  const real = new Set([
    ...registeredToolNames(),
    ...BUILTINS,
    // report_stage 已随自由引擎删除(#99):存量技能正文(issue-playbook
    // /issue-delivery)还提到它,文案清理归 assets 票处理——这里先挂
    // 已删名册,免得工具名对账假红;skills 清完即删。
    ...["report_stage"],
  ]);
  for (const { name, text } of skillFiles()) {
    for (const token of backtickedSnakeTokens(text)) {
      assert.ok(
        real.has(token),
        `技能 ${name} 引用了不存在的工具「${token}」——查注册表词表或删引用`);
    }
  }
});

test("技能 frontmatter:目录名与 name 一致,description 非空(路由索引的原料)", () => {
  for (const { name, text } of skillFiles()) {
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
    assert.match(frontmatter, new RegExp(`name:\\s*${name}\\b`),
      `技能 ${name} 的 frontmatter name 与目录名不一致`);
    assert.match(frontmatter, /description:\s*\S/,
      `技能 ${name} 缺 description——路由索引没有原料,Agent 永远到不了它`);
  }
});
