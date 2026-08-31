/**
 * 环境凭据保险箱的原子能力单测(src/issueEnvironment.ts)。
 *
 * 保险箱是需求/问题两个会话域共享的基建:任务侧已不存凭据(旧 DTS
 * triage 流已下线),问题流(src/issueFlow/)按 playbook 契约存
 * "单一共用密码"(三账号同密)。这里钉死:API 引用无密码、宿主可解密、
 * 落盘不是明文、清理干净。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueEnvironmentVault } from "../src/issueEnvironment.ts";
import {
  materializeIssueSkills,
  SKILL_SOURCE_DIR,
} from "../src/issueFlow/prompt.ts";

test("技能源目录:标准 skill 形态齐全,物化幂等且内容一致", () => {
  const expected = [
    "issue-analysis", "issue-delivery", "issue-ops", "issue-playbook",
    "issue-research",
  ];
  const workspace = mkdtempSync(join(tmpdir(), "mfc-issue-skills-"));
  const first = materializeIssueSkills(workspace);
  assert.deepEqual(first.map((path) => path.split("/").at(-2)), expected,
    "五个改编技能必须齐装;少一个等于 Agent 少一条行为规矩");
  for (const path of first) {
    const body = readFileSync(path, "utf-8");
    assert.match(body, /^---\nname: [^\n]+\ndescription: [^\n]+\n/,
      "SKILL.md 必须带 name+description frontmatter(pi 靠它进系统提示词)");
  }
  const second = materializeIssueSkills(workspace);
  assert.deepEqual(first, second, "幂等重写:路径稳定,重复物化不漂移");
  for (const name of expected) {
    assert.equal(
      readFileSync(join(workspace, "skills", name, "SKILL.md"), "utf-8"),
      readFileSync(join(SKILL_SOURCE_DIR, name, "SKILL.md"), "utf-8"),
      `${name} 物化内容必须与仓内源文件逐字节一致`);
  }
  assert.equal(readdirSync(join(workspace, "skills")).length, expected.length);
});

test("环境保险箱:API 引用无密码、宿主可解密、文件不是明文", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-vault-"));
  const vault = new IssueEnvironmentVault(dataDir);
  const refs = vault.store("issue-1", [{
    name: "灰度 A",
    purpose: "both",
    host: "10.0.0.8",
    port: 22,
    accounts: [
      { username: "sopuser", password: "shared-secret" },
      { username: "ossuser", password: "shared-secret" },
      { username: "ossadm", password: "shared-secret" },
    ],
  }]);
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0].accounts.map((account) => account.username),
    ["sopuser", "ossuser", "ossadm"]);
  assert.equal(refs[0].accounts.some((account) => "password" in account), false);
  assert.deepEqual(vault.credential("issue-1", refs[0].id, "sopuser"), {
    username: "sopuser",
    password: "shared-secret",
  });
  assert.equal(vault.credentials("issue-1", refs[0].id).length, 3);
  const ciphertext = readFileSync(
    join(dataDir, ".issue-environments", "issue-1.json"), "utf8");
  assert.doesNotMatch(ciphertext, /shared-secret|sopuser|10\.0\.0\.8/);
  vault.remove("issue-1");
  assert.equal(existsSync(join(dataDir, ".issue-environments", "issue-1.json")), false);
});

test("环境保险箱:混合用途(both)按 playbook 契约放行,任务号与问题号同区不碰撞", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-vault-both-"));
  const vault = new IssueEnvironmentVault(dataDir);
  const refs = vault.store("issue-2", [{
    name: "共用环境",
    purpose: "both",
    host: "60.14.46.16",
    accounts: [
      { username: "sopuser", password: "p" },
      { username: "ossuser", password: "p" },
      { username: "ossadm", password: "p" },
    ],
  }]);
  assert.equal(refs[0].purpose, "both");
  assert.throws(() => vault.store("bad", []),
    /任务编号格式不合法/);
});
