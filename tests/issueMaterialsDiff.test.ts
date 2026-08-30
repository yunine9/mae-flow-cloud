/**
 * 工作区 diff 接口的 ?repo= 服务端切片契约(#32)。
 *
 * 三条路径钉死(方案拍板 2026-08-30:合并视图保留标记,逐仓视图走参数):
 * - 无参数 = 聚合 diff,带「===== 仓库 <名> =====」分段标记(合并视图现状);
 * - ?repo=<仓名> = 只回该仓,无标记——前端逐仓审阅不再解析文本标记;
 * - 仓名不匹配任何关联仓 = 400 带人话(材料读类 fail-open 的既有错误
 *   风格;未知会话仍是 404,见 issueFlowErrors)。
 *
 * 走真路由 + 真git工作区(手搓请求对象,不养 HTTP 服务器;仓是本地
 * 裸仓克隆,不碰网络)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 走一遍真路由拿 {status, body}——手搓响应对象,与 issueFlowErrors
 * 同款;url 带 query,路由从 request.url 解析 ?repo=/?path=。 */
function issueGet(
  parts: string[],
  url: string,
  service: IssueFlowService,
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    let status = 0;
    void handleIssueRoutes(
      { method: "GET", url } as any,
      {
        writeHead: (code: number) => {
          status = code;
        },
        end: (payload?: string) => {
          try {
            resolve({ status, body: JSON.parse(payload ?? "{}") });
          } catch (error) {
            reject(error);
          }
        },
      } as any,
      parts,
      { issueFlow: service, authEnabled: false },
    ).catch(reject);
  });
}

/** 双仓会话夹具:登记两个关联仓(裸仓远端),工作区 repo/a、repo/b
 * 各克隆一份并各留一改一增——聚合与单仓切片都有内容可断言。 */
function seedTwoRepoSession(dataDir: string): { id: string; service: IssueFlowService } {
  const bare = (name: string) => {
    const seed = join(dataDir, `seed-${name}`);
    execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
    writeFileSync(join(seed, "base.txt"), `v1-${name}\n`);
    execFileSync("git", ["-C", seed, "add", "."], { env: GIT_ENV });
    execFileSync("git", ["-C", seed, "commit", "-q", "-m", "init"], { env: GIT_ENV });
    const origin = join(dataDir, `${name}.git`);
    execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
    return origin;
  };
  const originA = bare("a");
  const originB = bare("b");
  const id = "issue-diff";
  const root = join(dataDir, "issues", id);
  execFileSync("git", ["clone", "-q", originA, join(root, "repo", "a")],
    { env: GIT_ENV });
  execFileSync("git", ["clone", "-q", originB, join(root, "repo", "b")],
    { env: GIT_ENV });
  // 各仓一改一增:tracked 改动走 git diff HEAD,新文件走聚合接口的
  // 补文逻辑——两条来源都要落进各自仓的切片里。
  writeFileSync(join(root, "repo", "a", "base.txt"), "v2-alpha\n");
  writeFileSync(join(root, "repo", "a", "new-a.txt"), "alpha fresh\n");
  writeFileSync(join(root, "repo", "b", "base.txt"), "v2-beta\n");
  writeFileSync(join(root, "repo", "b", "new-b.txt"), "beta fresh\n");
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id, account: "dev",
    created_at: "2026-08-30T08:00:00Z", updated_at: "2026-08-30T09:00:00Z",
    title: "t", description: "", source: "manual",
    mode: "fixed", scenario: "no_ticket",
    status: "suspended", stage: "conclude", stage_note: "",
    stage_at: "2026-08-30T09:00:00Z",
    repo_urls: [originA, originB],
  }));
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  return { id, service };
}

test("材料 diff 契约:无参数聚合带仓库分段标记,内容跨仓齐", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-diff-all-"));
  const { id, service } = seedTwoRepoSession(dataDir);
  try {
    const got = await issueGet(["issues", id, "materials", "diff"],
      `/issues/${id}/materials/diff`, service);
    assert.equal(got.status, 200);
    const diff = String(got.body.diff);
    assert.match(diff, /===== 仓库 a =====/, "聚合形态:段标记是契约的一部分");
    assert.match(diff, /===== 仓库 b =====/);
    assert.match(diff, /v2-alpha/, "a 仓 tracked 改动在聚合里");
    assert.match(diff, /v2-beta/, "b 仓 tracked 改动在聚合里");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("材料 diff 契约:?repo= 只回该仓,无分段标记", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-diff-repo-"));
  const { id, service } = seedTwoRepoSession(dataDir);
  try {
    const got = await issueGet(["issues", id, "materials", "diff"],
      `/issues/${id}/materials/diff?repo=a`, service);
    assert.equal(got.status, 200);
    const diff = String(got.body.diff);
    assert.doesNotMatch(diff, /===== 仓库 /, "切片不带聚合分段标记");
    assert.match(diff, /v2-alpha/);
    assert.match(diff, /new-a\.txt/, "未跟踪新文件的补文 diff 同在切片里");
    assert.doesNotMatch(diff, /v2-beta/, "别仓的变更不串仓");
    assert.doesNotMatch(diff, /beta fresh/);

    // 换一仓同样成立:切片按仓名走,不是恒取首仓。
    const other = await issueGet(["issues", id, "materials", "diff"],
      `/issues/${id}/materials/diff?repo=b`, service);
    assert.equal(other.status, 200);
    assert.match(String(other.body.diff), /v2-beta/);
    assert.doesNotMatch(String(other.body.diff), /v2-alpha/);
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("材料 diff 契约:仓名不匹配关联仓 → 400 带人话,不兜底到首仓", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-diff-bad-"));
  const { id, service } = seedTwoRepoSession(dataDir);
  try {
    const got = await issueGet(["issues", id, "materials", "diff"],
      `/issues/${id}/materials/diff?repo=nope`, service);
    assert.equal(got.status, 400, "材料读类错误的既有风格:400 带人话");
    assert.match(got.body.error, /nope/);
    assert.match(got.body.error, /关联仓/);
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});
