/**
 * Git 平台与流水线模拟的契约(主 spec §7.3/§10/§14.5):
 * 裸仓是唯一远端真相、MR 幂等、流水线结果绑 SHA、
 * MR 状态"验证中→等待合入"由流水线通过驱动。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/jsonBody.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeSourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mfc-src-"));
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "config", "user.email", "bot@test");
  git(dir, "config", "user.name", "bot");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "init");
  return dir;
}

test("裸仓灌历史 → 克隆 → 推分支 → MR 幂等 → 流水线绑 SHA", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-git-"));
  const source = makeSourceRepo();
  const platform = new FakeGitPlatform();
  const bare = platform.initBare(source, dataDir);
  await platform.start();
  try {
    // 任务视角:从裸仓克隆、切需求分支、改代码、推回。
    const work = join(dataDir, "work");
    git(dataDir, "clone", "--quiet", bare, "work");
    git(work, "config", "user.email", "bot@test");
    git(work, "config", "user.name", "bot");
    git(work, "checkout", "--quiet", "-b", "master_bot_REQ1");
    writeFileSync(join(work, "a.txt"), "change\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "feat: REQ1");
    git(work, "push", "--quiet", "origin", "master_bot_REQ1");
    const sha = git(work, "rev-parse", "HEAD");

    // MR:创建 → 幂等(恢复重放不翻倍)→ 初始状态"验证中"。
    const create = () => fetch(`${platform.baseUrl}/mr`, {
      method: "POST",
      body: JSON.stringify({
        source_branch: "master_bot_REQ1",
        target_branch: "master",
        title: "feat: REQ1",
      }),
    }).then((r) => readJson(r));
    const mr = await create();
    const replay = await create();
    assert.equal(replay.id, mr.id);
    assert.equal(mr.sha, sha);
    assert.equal(mr.state, "验证中");

    // 旧 SHA 没有任何流水线记录可背书。
    const empty = await fetch(
      `${platform.baseUrl}/pipeline/status?sha=${sha}`)
      .then((r) => readJson(r));
    assert.equal(empty.runs.length, 0);

    // 流水线通过 → 同 SHA 的 MR 变"等待合入";系统不自动合并。
    const run = await fetch(`${platform.baseUrl}/pipeline/trigger`, {
      method: "POST", body: JSON.stringify({ sha }),
    }).then((r) => readJson(r));
    assert.equal(run.status, "success");
    assert.deepEqual(
      run.checks.map((item: { dimension: string }) => item.dimension),
      ["COMPILE", "UT", "CODECHECK"],
      "总体绿灯之外必须给内核三项独立事实");
    assert.ok(run.checks.every((item: { status: string }) =>
      item.status === "success"));
    const after = (await fetch(`${platform.baseUrl}/mr`)
      .then((r) => readJson(r)))[0];
    assert.equal(after.state, "等待合入");

    // 新提交出现:旧绿灯不背书新代码。
    writeFileSync(join(work, "b.txt"), "more\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "fix: 补一刀");
    const newSha = git(work, "rev-parse", "HEAD");
    const stale = await fetch(
      `${platform.baseUrl}/pipeline/status?sha=${newSha}`)
      .then((r) => readJson(r));
    assert.equal(stale.runs.length, 0);
  } finally {
    await platform.stop();
  }
});

test("流水线失败:MR 停在验证中;失败结果同样绑 SHA 留痕", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-git-"));
  const source = makeSourceRepo();
  const platform = new FakeGitPlatform();
  platform.initBare(source, dataDir);
  await platform.start();
  try {
    const sha = platform.branchSha("master");
    const mr = await fetch(`${platform.baseUrl}/mr`, {
      method: "POST",
      body: JSON.stringify({
        source_branch: "master", target_branch: "master", title: "t",
      }),
    }).then((r) => readJson(r));
    platform.nextPipelineStatus = "failed";
    const run = await fetch(`${platform.baseUrl}/pipeline/trigger`, {
      method: "POST", body: JSON.stringify({ sha }),
    }).then((r) => readJson(r));
    assert.equal(run.status, "failed");
    const after = (await fetch(`${platform.baseUrl}/mr`)
      .then((r) => readJson(r)))[0];
    assert.equal(after.state, "验证中");
    assert.equal(mr.id, after.id);
  } finally {
    await platform.stop();
  }
});
