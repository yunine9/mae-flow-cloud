import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSafeWorktreeGit } from "../src/safeGit.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
}

test("安全 Git 忽略 Agent 写入的 fsmonitor 与继承 GIT_CONFIG", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-safe-git-"));
  git(cwd, "init", "--quiet");
  const marker = join(cwd, "fsmonitor-ran");
  const monitor = join(cwd, "monitor.sh");
  executable(monitor, `printf compromised > '${marker}'; exit 1`);
  git(cwd, "config", "core.fsmonitor", monitor);
  const hostileConfig = join(cwd, "hostile.gitconfig");
  writeFileSync(hostileConfig, `[core]\n\tfsmonitor = ${monitor}\n`);

  const result = runSafeWorktreeGit(cwd,
    ["status", "--porcelain=v1", "--untracked-files=all"], {
      env: { GIT_CONFIG: hostileConfig },
    });
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(existsSync(marker), false);
});

test("安全 Git diff 不执行仓库 external diff/textconv", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-safe-diff-"));
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.email", "bot@test");
  git(cwd, "config", "user.name", "bot");
  writeFileSync(join(cwd, "a.txt"), "before\n");
  git(cwd, "add", "a.txt");
  git(cwd, "commit", "--quiet", "-m", "before");
  writeFileSync(join(cwd, "a.txt"), "after\n");
  const marker = join(cwd, "external-diff-ran");
  const driver = join(cwd, "diff.sh");
  executable(driver, `printf compromised > '${marker}'; exit 1`);
  git(cwd, "config", "diff.external", driver);

  const result = runSafeWorktreeGit(cwd,
    ["diff", "--no-ext-diff", "--no-textconv", "--", "a.txt"]);
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /after/);
  assert.equal(existsSync(marker), false);
});

test("安全 Git 代理不读取 clean/smudge 配置，也拒绝外部 objects alternates", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-safe-filter-"));
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.email", "bot@test");
  git(cwd, "config", "user.name", "bot");
  writeFileSync(join(cwd, "a.txt"), "tracked\n");
  git(cwd, "add", "a.txt");
  git(cwd, "commit", "--quiet", "-m", "before");
  const marker = join(cwd, "filter-ran");
  const filter = join(cwd, "filter.sh");
  executable(filter, `printf compromised > '${marker}'; cat`);
  git(cwd, "config", "filter.owned.clean", filter);
  git(cwd, "config", "filter.owned.smudge", filter);
  writeFileSync(join(cwd, ".gitattributes"), "*.txt filter=owned\n");
  writeFileSync(join(cwd, "a.txt"), "changed\n");

  const status = runSafeWorktreeGit(cwd,
    ["status", "--porcelain=v1", "--untracked-files=all"]);
  assert.equal(status.status, 0, String(status.stderr));
  assert.equal(existsSync(marker), false,
    "宿主 status 不能执行 Agent 配置的 clean/smudge 进程");

  const outside = mkdtempSync(join(tmpdir(), "mfc-foreign-objects-"));
  const info = join(cwd, ".git", "objects", "info");
  mkdirSync(info, { recursive: true });
  writeFileSync(join(info, "alternates"), `${outside}\n`);
  assert.throws(() => runSafeWorktreeGit(cwd, ["rev-parse", "HEAD"]),
    /alternates 不允许/);
});
