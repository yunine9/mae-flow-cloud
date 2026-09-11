/**
 * 磁盘治理(.scratch/issue-disk-hygiene 票 01/03)的契约测试:终态
 * (canceled/archived)repo 整仓回收 + idle 单构建产物冷却清理。
 *
 * 钉的机械事实:
 * - 终态(canceled/archived)→ repo/ 整树消失,repo_reclaimed_at 落
 *   state,事件账有 repo_reclaimed(bytes/scope),其余文件原样;
 * - failed 不在回收范围(可恢复态,用户拍板);
 * - idle 单构建产物:mtime 冷却过期才删(源码保留),没冷却的不动,
 *   build_products_reclaimed_at + 事件(scope=products)落账;
 * - 旋钮 issue_repo_reclaim=0 时一切不动(行为与现状全等);
 * - running/waiting_user 的状态守卫:在途单子绝不清理。
 *
 * 清扫是纯盘面操作(不跑会话),issue 目录直接伪造,服务只当扫描器。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { mfcTemp } from "./mfcTmp.ts";

/** 伪造一个 issue 目录:issue.json + repo/ 树(源码/产物可各自带
 * mtime),返回其根路径。 */
function fabricateIssue(
  root: string,
  id: string,
  status: string,
  opts?: { oldProducts?: boolean },
): string {
  const dir = join(root, id);
  mkdirSync(join(dir, "repo", "demo", "target"), { recursive: true });
  mkdirSync(join(dir, "repo", "demo", "src"), { recursive: true });
  writeFileSync(join(dir, "issue.json"), JSON.stringify({
    id, account: "dev",
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
    title: `t-${id}`, description: "d", source: "manual", status,
  }));
  writeFileSync(join(dir, "repo", "demo", "src", "a.ts"), "export {}");
  writeFileSync(join(dir, "repo", "demo", "target", "x.o"), "binary");
  writeFileSync(join(dir, "report.md"), "分析报告(必须保留)");
  if (opts?.oldProducts) {
    const old = new Date(Date.now() - 72 * 3_600_000);
    utimesSync(join(dir, "repo", "demo", "target"), old, old);
    utimesSync(join(dir, "repo", "demo", "target", "x.o"), old, old);
  }
  return dir;
}

function makeService(runtime?: Record<string, number>) {
  const dataDir = mfcTemp("mfc-issue-reclaim-");
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: {},
    settings: { models: () => ({}), runtime: () => runtime ?? {} },
  });
  return { service, dataDir, issuesRoot: join(dataDir, "issues") };
}

test("终态回收:canceled/archived 的 repo 整树消失,标记与事件账落盘,报告保留", async () => {
  const { service, issuesRoot } = makeService();
  const canceled = fabricateIssue(issuesRoot, "issue-1", "canceled");
  const archived = fabricateIssue(issuesRoot, "issue-2", "archived");
  const failed = fabricateIssue(issuesRoot, "issue-3", "failed");

  const result = await service.sweepTerminalRepos();
  assert.equal(result.reclaimed, 2, "canceled+archived 各回收一单");

  assert.ok(!existsSync(join(canceled, "repo")), "canceled repo 已删");
  assert.ok(!existsSync(join(archived, "repo")), "archived repo 已删");
  assert.ok(existsSync(join(canceled, "report.md")), "报告保留");
  assert.ok(existsSync(join(canceled, "issue.json")), "状态文件保留");
  assert.ok(existsSync(join(failed, "repo")), "failed 不在回收范围(用户拍板)");

  const state = JSON.parse(
    readFileSync(join(canceled, "issue.json"), "utf-8"));
  assert.ok(state.repo_reclaimed_at, "repo_reclaimed_at 落 state");

  const events = readFileSync(join(canceled, "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const reclaim = events.find((event) => event.kind === "repo_reclaimed");
  assert.ok(reclaim, "回收事件入账");
  assert.equal(reclaim.payload.scope, "repo");
  assert.ok(reclaim.payload.bytes > 0);
});

test("构建产物冷却:idle 单过期产物删、新鲜不动、源码保留、failed 免清理", async () => {
  const { service, issuesRoot } = makeService();
  const stale = fabricateIssue(issuesRoot, "issue-1", "idle",
    { oldProducts: true });
  const fresh = fabricateIssue(issuesRoot, "issue-2", "idle");
  const failedStale = fabricateIssue(issuesRoot, "issue-3", "failed",
    { oldProducts: true });

  const result = await service.sweepTerminalRepos();
  assert.ok(result.bytes > 0, "有产物被回收");

  assert.ok(!existsSync(join(stale, "repo", "demo", "target")),
    "冷却过期的 target 已删");
  assert.ok(existsSync(join(stale, "repo", "demo", "src", "a.ts")),
    "源码保留");
  assert.ok(existsSync(join(stale, "report.md")), "报告保留");
  assert.ok(existsSync(join(fresh, "repo", "demo", "target")),
    "未冷却的产物不动");
  assert.ok(existsSync(join(failedStale, "repo", "demo", "target")),
    "failed 单连产物也不清(用户拍板)");

  const state = JSON.parse(readFileSync(join(stale, "issue.json"), "utf-8"));
  assert.ok(state.build_products_reclaimed_at, "标记落 state");
  const events = readFileSync(join(stale, "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const reclaim = events.find((event) => event.kind === "repo_reclaimed");
  assert.equal(reclaim.payload.scope, "products", "事件 scope=products");
});

test("旋钮关:issue_repo_reclaim=0 时一切不动(行为与现状全等)", async () => {
  const { service, issuesRoot } = makeService({ issue_repo_reclaim: 0 });
  const canceled = fabricateIssue(issuesRoot, "issue-1", "canceled",
    { oldProducts: true });
  const idle = fabricateIssue(issuesRoot, "issue-2", "idle",
    { oldProducts: true });

  const result = await service.sweepTerminalRepos();
  assert.deepEqual(result, { reclaimed: 0, bytes: 0 });
  assert.ok(existsSync(join(canceled, "repo")), "终态现场保留");
  assert.ok(existsSync(join(idle, "repo", "demo", "target")), "产物保留");
});

test("状态守卫:running 与 waiting_user 的单子即使产物冷却也不清理", async () => {
  const { service, issuesRoot } = makeService();
  const running = fabricateIssue(issuesRoot, "issue-1", "running",
    { oldProducts: true });
  const waiting = fabricateIssue(issuesRoot, "issue-2", "waiting_user",
    { oldProducts: true });

  await service.sweepTerminalRepos();
  assert.ok(existsSync(join(running, "repo", "demo", "target")));
  assert.ok(existsSync(join(waiting, "repo", "demo", "target")));
});

test("幂等:已回收(repo/ 不在场)的单子重扫不炸、不重复记账", async () => {
  const { service, issuesRoot } = makeService();
  fabricateIssue(issuesRoot, "issue-1", "canceled");
  await service.sweepTerminalRepos();
  const second = await service.sweepTerminalRepos();
  assert.equal(second.reclaimed, 0, "重扫无新回收");
  const events = readFileSync(
    join(issuesRoot, "issue-1", "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean)
    .filter((line) => JSON.parse(line).kind === "repo_reclaimed");
  assert.equal(events.length, 1, "事件只记一次");
});
