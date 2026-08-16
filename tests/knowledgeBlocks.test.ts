/**
 * 知识块的契约:
 * - 命中触发词才注入,不命中不占上下文;无触发词=常驻知识;
 * - 触发词匹配大小写不敏感、认中文子串(中文没词边界);
 * - 预算帽超了如实 truncated;
 * - fail-open:没有知识目录(绝大多数仓的常态)返回空,不炸。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectKnowledge } from "../src/knowledgeBlocks.ts";

function makeRepo(blocks: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mfc-kb-"));
  const kdir = join(dir, ".mae-flow", "knowledge");
  mkdirSync(kdir, { recursive: true });
  for (const [name, text] of Object.entries(blocks)) {
    writeFileSync(join(kdir, name), text);
  }
  return dir;
}

test("命中触发词才注入;无触发词的常驻知识每次都在", () => {
  const repo = makeRepo({
    "db.md": "---\ntriggers: 数据库, Flyway\n---\n改表必须配回滚脚本。",
    "front.md": "---\ntriggers: 前端, React\n---\n组件一律函数式。",
    "team.md": "团队规范:提交信息写中文一句话。",
  });

  const hit = collectKnowledge(repo, "给订单表加字段,记得走 flyway 迁移");
  assert.deepEqual(hit.used, ["db.md", "team.md"], "命中的+常驻的在场");
  assert.match(hit.markdown, /改表必须配回滚脚本/);
  assert.match(hit.markdown, /团队规范/);
  assert.ok(!hit.markdown.includes("组件一律函数式"), "没命中的不占上下文");

  const none = collectKnowledge(repo, "修个后端空指针");
  assert.deepEqual(none.used, ["team.md"], "只剩常驻知识");
});

test("预算帽:注入总字符超了如实截断并明说", () => {
  const long = "x".repeat(3000);
  const repo = makeRepo({
    "a.md": `常驻甲\n${long}`,
    "b.md": `常驻乙\n${long}`,
  });
  const tight = collectKnowledge(repo, "随便什么需求", { maxOutputChars: 3200 });
  assert.equal(tight.truncated, true);
  assert.deepEqual(tight.used, ["a.md"], "装得下几篇是几篇");
  assert.match(tight.markdown, /按预算截断/, "截断要明说");
});

test("fail-open:没有知识目录返回空,不炸也不算错", () => {
  const bare = mkdtempSync(join(tmpdir(), "mfc-kb-bare-"));
  const empty = collectKnowledge(bare, "任意需求");
  assert.equal(empty.markdown, "");
  assert.deepEqual(empty.used, []);
  assert.equal(empty.truncated, false);
});

test("头没闭合/格式怪的当常驻知识收下,不吞正文", () => {
  const repo = makeRepo({ "weird.md": "---\ntriggers: 只有开头没结尾\n正文还在这里。" });
  const got = collectKnowledge(repo, "无关需求");
  assert.deepEqual(got.used, ["weird.md"]);
  assert.match(got.markdown, /正文还在这里/);
});
