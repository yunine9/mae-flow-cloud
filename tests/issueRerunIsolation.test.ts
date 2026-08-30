/**
 * 同单重跑的隔离与遗留分支(2026-08-28 事故回归)。
 *
 * 事故:会话 A 跑得不对被取消,重跑同单的会话 B 执行到中途,AI 说了句
 * "仓库已存在本地且修复分支已经存在"让人摸不着头脑。诊断结论:
 * - 目录隔离本身成立——每次登记都开新目录 issue-<N>,仓落在各自
 *   repo/<仓名>/,取消不清现场。这里把这条机械事实钉死。
 * - 真正的缺口:修复分支名烧死 master_工号_单号,A 停止前推过的话,
 *   B 的新克隆把旧分支带成 origin/<branch>,本地却从基线另起同名
 *   分支——分叉要一路憋到 push 才以非快进炸掉,中途 AI 只能即兴
 *   描述。修复后:pull_repo 回执必须把分叉事实带给 Agent(让它向
 *   用户报告处置),push 被拒时也要点名原因。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { pushFromIssueWorkspace } from "../src/issueFlow/issueGit.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function bareOrigin(root: string): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
}

async function until(
  probe: () => unknown,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function git(dir: string, ...args: string[]): string {
  const run = spawnSync("git", ["-C", dir, ...args],
    { encoding: "utf-8", env: GIT_ENV });
  assert.equal(run.status, 0, `git ${args.join(" ")} 失败: ${run.stderr}`);
  return run.stdout.trim();
}

const TICKET = "DTS-2026-1006";
const BRANCH = `master_dev_${TICKET}`;

test("取消后重跑同单:新会话新目录全新克隆,远端遗留同名分支必须作为事实回执", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-rerun-"));
  const origin = bareOrigin(dataDir);
  const model = new ScriptedModelServer([
    // ---- 会话 A:拉单(自报收口)→ 拉仓 → 自报收口 → 修复分支上落一笔
    // 提交(模拟跑到中途)→ 举分析闸。
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "cd repo/origin && git -c user.name=test -c user.email=t@e commit -q"
      + " --allow-empty -m halfway" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n\\n根因:演示。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis", input: { summary: "根因=演示" } } },
    { text: "分析已提交,等待确认。" },
    // ---- 会话 B(重跑):拉单 → 拉仓必须拿到遗留警报,照常举闸收口。
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n\\n根因:演示(重跑)。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis", input: { summary: "根因=演示(重跑)" } } },
    { text: "重跑分析已提交。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts: new MockDtsGateway(),
    opsTools: {
      async fetchLogs() { return { summary: "测试假件" }; },
      async buildDeploy() { return { summary: "测试假件" }; },
    },
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
  });
  try {
    const first = service.create({
      account: "dev", title: "开局飞跑", ticket: TICKET,
      source: "dts", repoUrl: origin,
    });
    await until(() => service.get(first.id).status === "waiting_user",
      "会话 A 举分析闸");

    // 用户停掉 A 之前,上次运行已把修复分支推上远端(显式 URL 绕开
    // 工作区 pushurl 加固——模拟宿主 push 的结果状态)。
    const repoA = join(dataDir, "issues", first.id, "repo", "origin");
    const leftoverSha = git(repoA, "rev-parse", "HEAD");
    execFileSync("git",
      ["-C", repoA, "push", "-q", origin, `HEAD:refs/heads/${BRANCH}`],
      { env: GIT_ENV });

    service.control(first.id, { action: "cancel" });
    assert.equal(service.get(first.id).status, "canceled");

    // 取消是终态,单号查重放行:同账号新会话必须开新目录。
    const second = service.create({
      account: "dev", title: "开局飞跑(重跑)", ticket: TICKET,
      source: "dts", repoUrl: origin,
    });
    assert.notEqual(second.id, first.id, "重跑同单 = 全新会话");
    await until(() => service.get(second.id).status === "waiting_user",
      "会话 B 举分析闸");

    // 隔离事实:B 有自己的全新克隆;本地修复分支从基线另起,不包含
    // A 的遗留提交(遗留只作为 origin/<branch> 旁挂在远端跟踪上)。
    const repoB = join(dataDir, "issues", second.id, "repo", "origin");
    assert.ok(existsSync(join(repoB, ".git")), "B 是全新克隆");
    assert.ok(existsSync(join(repoA, ".git")), "取消不清 A 的现场");
    assert.equal(git(repoB, "branch", "--show-current"), BRANCH,
      "B 的修复分支仍按 master_工号_单号 切好");
    assert.equal(git(repoB, "rev-parse", "HEAD"), git(repoB, "rev-parse", "master"),
      "B 本地分支起点=基线(master),不是远端遗留分支");
    const containsLeftover = spawnSync(
      "git", ["-C", repoB, "merge-base", "--is-ancestor", leftoverSha, "HEAD"],
      { encoding: "utf-8", env: GIT_ENV });
    assert.notEqual(containsLeftover.status, 0,
      "A 的遗留提交不能混进 B 的本地分支历史");

    // 回执契约:遗留分支作为事实进入对话与阶段台账——AI 拿着事实
    // 向用户报告处置,而不是即兴一句"分支已存在"。
    assert.match(JSON.stringify(model.requests), /遗留警报/,
      "pull_repo 回执必须带远端遗留分支警报");
    const trail = (service.get(second.id).transitions ?? [])
      .map((item) => item.note).join("\n");
    assert.match(trail, /远端同名修复分支遗留/,
      "阶段台账要记下遗留分支事实");
  } finally {
    await service.shutdown();
    await model.stop();
  }
});

test("推送撞远端遗留同名分支:失败信息点名非快进与处置建议", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-push-"));
  const origin = bareOrigin(dataDir);
  // x:上次运行——同名分支带一笔提交推上远端。
  const x = join(dataDir, "x");
  execFileSync("git", ["clone", "-q", origin, x], { env: GIT_ENV });
  execFileSync("git", ["-C", x, "checkout", "-q", "-b", BRANCH], { env: GIT_ENV });
  execFileSync("git", ["-C", x, "commit", "-q", "--allow-empty",
    "-m", "old"], { env: GIT_ENV });
  execFileSync("git",
    ["-C", x, "push", "-q", origin, `HEAD:refs/heads/${BRANCH}`], { env: GIT_ENV });
  // y:重跑——从基线另起同名分支再推,必然非快进。
  const y = join(dataDir, "y");
  execFileSync("git", ["clone", "-q", origin, y], { env: GIT_ENV });
  execFileSync("git", ["-C", y, "checkout", "-q", "-b", BRANCH], { env: GIT_ENV });
  execFileSync("git", ["-C", y, "commit", "-q", "--allow-empty",
    "-m", "new"], { env: GIT_ENV });
  await assert.rejects(
    pushFromIssueWorkspace({ dataDir, repoDir: y, repoUrl: origin, branch: BRANCH }),
    (error: Error) => {
      assert.match(error.message, /非快进/);
      assert.match(error.message, /上次运行|同单重跑/);
      assert.match(error.message, /删除远端旧分支|沿用旧分支/);
      return true;
    },
    "非快进失败要带人话:原因(同单重跑遗留)+ 处置方向");
});
