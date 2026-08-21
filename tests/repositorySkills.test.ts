import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverRepositorySkills,
  REPOSITORY_SKILL_ROOTS,
} from "../src/repositorySkills.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mfc-repository-skills-src-"));
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "config", "user.email", "bot@test");
  git(dir, "config", "user.name", "bot");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  commit(dir, "init");
  return dir;
}

function commit(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function writeSkill(
  repo: string,
  root: string,
  directory: string,
  name: string,
  description: string,
  extra = "",
): void {
  const skillDir = join(repo, root, directory);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    extra,
    "---",
    "",
    "只在任务匹配时读取并执行这些指引。",
    "",
  ].filter((line) => line !== "").join("\n"));
}

test("固定四根、只扫直接子目录，并生成绑定仓库版本与内容的稳定 id", async () => {
  const repo = makeRepo();
  writeSkill(repo, ".agents/skills", "java-review", "java-review",
    "检查 Java 代码约束");
  writeSkill(repo, ".pi/skills", "api-contract", "api-contract",
    "读取接口契约并指导实现");
  writeSkill(repo, ".claude/skills", "db-migrate", "db-migrate",
    "数据库迁移规范");
  writeSkill(repo, ".cac/skills", "cac-review", "cac-review",
    "CAC 随仓检视规范");
  // 根目录 markdown 与二级嵌套都不属于“直接子目录/SKILL.md”。
  writeFileSync(join(repo, ".pi/skills/loose.md"),
    "---\nname: loose\ndescription: 不应发现\n---\n");
  const nested = join(repo, ".agents/skills/container/nested");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "SKILL.md"),
    "---\nname: nested\ndescription: 不应递归发现\n---\n");
  const revision = commit(repo, "skills");

  const first = await discoverRepositorySkills({ repository: repo });
  const again = await discoverRepositorySkills({ repository: repo });
  assert.equal(first.error, undefined);
  assert.equal(first.revision, revision);
  assert.deepEqual(REPOSITORY_SKILL_ROOTS,
    [".agents/skills", ".pi/skills", ".claude/skills", ".cac/skills"]);
  assert.deepEqual(first.skills.map((skill) => skill.name),
    ["java-review", "api-contract", "db-migrate", "cac-review"]);
  assert.deepEqual(first.skills.map((skill) => skill.source),
    REPOSITORY_SKILL_ROOTS);
  assert.ok(first.skills.every((skill) => /^[0-9a-f]{64}$/.test(skill.digest)));
  assert.deepEqual(first.skills.map((skill) => skill.id),
    again.skills.map((skill) => skill.id), "同仓同版本 id 必须稳定");
  assert.ok(!first.skills.some((skill) => /loose|nested/.test(skill.name)));
});

test("仓库没有 Skill 时成功返回空目录，不把可选能力变成下单故障", async () => {
  const repo = makeRepo();
  const catalog = await discoverRepositorySkills({ repository: repo });
  assert.equal(catalog.error, undefined);
  assert.equal(catalog.skills.length, 0);
  assert.equal(catalog.revision, git(repo, "rev-parse", "HEAD"));
});

test("disable-model-invocation 仍展示，但不可被自动选择", async () => {
  const repo = makeRepo();
  writeSkill(repo, ".pi/skills", "manual-only", "manual-only",
    "只允许人显式调用", "disable-model-invocation: true");
  commit(repo, "manual skill");

  const catalog = await discoverRepositorySkills({ repository: repo });
  assert.equal(catalog.skills.length, 1);
  assert.equal(catalog.skills[0].selectable, false);
  assert.match(catalog.skills[0].warning ?? "", /禁止模型自动调用/);
});

test("拒绝符号链接、submodule、超大文件、非法路径和非法 frontmatter", async () => {
  const repo = makeRepo();

  const target = join(repo, "target-skill.md");
  writeFileSync(target,
    "---\nname: linked\ndescription: 不得跟随软链\n---\n");
  const linkDir = join(repo, ".agents/skills/linked");
  mkdirSync(linkDir, { recursive: true });
  symlinkSync("../../../target-skill.md", join(linkDir, "SKILL.md"));

  const hugeDir = join(repo, ".pi/skills/huge");
  mkdirSync(hugeDir, { recursive: true });
  writeFileSync(join(hugeDir, "SKILL.md"),
    "---\nname: huge\ndescription: 太大\n---\n" + "x".repeat(128 * 1024));

  const unsafeDir = join(repo, ".claude/skills/bad\\path");
  mkdirSync(unsafeDir, { recursive: true });
  writeFileSync(join(unsafeDir, "SKILL.md"),
    "---\nname: unsafe\ndescription: 非法路径\n---\n");

  const emptyDir = join(repo, ".claude/skills/empty");
  mkdirSync(emptyDir, { recursive: true });
  writeFileSync(join(emptyDir, "SKILL.md"),
    "---\nname: empty\ndescription: ''\n---\n");

  const yamlDir = join(repo, ".claude/skills/broken-yaml");
  mkdirSync(yamlDir, { recursive: true });
  writeFileSync(join(yamlDir, "SKILL.md"),
    "---\nname: [broken\ndescription: nope\n---\n");

  const invalidNameDir = join(repo, ".claude/skills/invalid-name");
  mkdirSync(invalidNameDir, { recursive: true });
  writeFileSync(join(invalidNameDir, "SKILL.md"),
    "---\nname: INVALID_NAME\ndescription: 名字不合规范\n---\n");
  const parent = commit(repo, "unsafe candidates");

  // 直接向 index 写 gitlink；它不会被当目录深入，也不会触发 submodule。
  git(repo, "update-index", "--add", "--cacheinfo",
    `160000,${parent},.agents/skills/a-submodule`);
  git(repo, "commit", "--quiet", "-m", "gitlink");

  const catalog = await discoverRepositorySkills({ repository: repo });
  assert.equal(catalog.error, undefined);
  assert.deepEqual(catalog.skills, []);
});

test("最多返回 100 项，超出的目录不再读取", async () => {
  const repo = makeRepo();
  for (let index = 0; index < 101; index += 1) {
    const name = `skill-${String(index).padStart(3, "0")}`;
    writeSkill(repo, ".agents/skills", name, name, `第 ${index} 个能力`);
  }
  commit(repo, "many skills");
  const catalog = await discoverRepositorySkills({ repository: repo });
  assert.equal(catalog.error, undefined);
  assert.equal(catalog.skills.length, 100);
  assert.equal(catalog.skills[0].name, "skill-000");
  assert.equal(catalog.skills.at(-1)?.name, "skill-099");
});

test("baseline 精确读取对应分支版本，不拿默认分支的新内容冒充", async () => {
  const repo = makeRepo();
  writeSkill(repo, ".pi/skills", "release-guide", "release-guide",
    "稳定分支旧版说明");
  const stableRevision = commit(repo, "stable skill");
  git(repo, "branch", "stable");
  writeSkill(repo, ".pi/skills", "release-guide", "release-guide",
    "主分支新版说明");
  const mainRevision = commit(repo, "main skill");

  const stable = await discoverRepositorySkills({
    repository: repo,
    baseline: "stable",
  });
  const main = await discoverRepositorySkills({
    repository: repo,
    baseline: "main",
  });
  assert.equal(stable.revision, stableRevision);
  assert.equal(main.revision, mainRevision);
  assert.equal(stable.skills[0].description, "稳定分支旧版说明");
  assert.equal(main.skills[0].description, "主分支新版说明");
  assert.notEqual(stable.skills[0].id, main.skills[0].id);
});

test("克隆失败也清理临时目录，错误不泄露成未处理异常", async () => {
  const prefix = "mae-flow-repository-skills-";
  const before = new Set(readdirSync(tmpdir()).filter((name) =>
    name.startsWith(prefix)));
  const missing = join(tmpdir(), `missing-repo-${Date.now()}-${Math.random()}`);
  const catalog = await discoverRepositorySkills({
    repository: missing,
    timeoutMs: 5_000,
  });
  assert.match(catalog.error ?? "", /不可访问/);
  assert.deepEqual(catalog.skills, []);
  const after = new Set(readdirSync(tmpdir()).filter((name) =>
    name.startsWith(prefix)));
  assert.deepEqual(after, before);
});
