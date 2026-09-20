/**
 * 一次生成归属层(工单 #335/#336/#337,ADR-0044):返工边界纯函数、
 * 行级三分类归属(真仓夹具)、head 四级优先级、平台外行进分母、
 * 只写一次与后台通道/清扫器兜底的落盘语义。
 *
 * 覆盖:
 * 1. 纯函数:返工边界(反馈先于一切推送不算;无反馈=全程首轮)、
 *    聚合(降级仓跳过;分母 0 → null;达标线判定)、支持期日期;
 * 2. 单推送无反馈:全部留存行计首轮,占比 100%;
 * 3. 两推送夹一次验证失败:边界前的行首轮、边界后的行返工,
 *    边界与回应推送如实入档;md 文件不进分母(白名单);
 * 4. 平台外尾部提交(fetch 路径):MR 未合入、分支仍在——fetch 把
 *    平台外对象拿进本地,其行进分母不计分子,head 口径=mr_branch;
 * 5. 外部头观测:平台外提交夹在两笔平台推送之间,区间归属本会吸收
 *    它,观测账在场则按平台外计;
 * 6. 非 squash 合入:head 口径=merged_sha,数字与分支路径一致;
 * 7. squash 合入+分支已删:合入头对象不在本地、fetch 不可得,退
 *    本地末笔推送(head 口径=local_push,缺平台外尾部如实标注);
 * 8. 降级:工作区缺失→单仓「不可得」,不抛出;
 * 9. 落盘语义:只写一次(重复写跳过);enqueue 入队算完落盘、
 *    onSettled 收尾;backfill 对缺失补算、对在场跳过;支持期外
 *    (起算日期前终态)不入队不试算。
 *
 * 范式:issueMetricsAttribution 的假远端(bareOrigin)+ 种子现场直写
 * issue.json;归属层纯构建函数直测(async)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import {
  aggregateCodeOrigin,
  awaitCodeOriginLane,
  backfillCodeOrigin,
  buildCodeOriginSnapshot,
  enqueueCodeOrigin,
  ISSUE_CODE_ORIGIN_FILE,
  readCodeOriginSnapshot,
  reworkBoundary,
  writeCodeOriginSnapshot,
  type IssueCodeOriginRepoOk,
  type IssueCodeOriginSnapshot,
} from "../src/issueFlow/codeOrigin.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS-2026-3341";
const ACCOUNT = "dev";
const BRANCH = `master_${ACCOUNT}_${TICKET}`;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "agent",
  GIT_AUTHOR_EMAIL: "agent@example.com",
  GIT_COMMITTER_NAME: "agent",
  GIT_COMMITTER_EMAIL: "agent@example.com",
};

function rawGit(args: string[]): void {
  execFileSync("git", args, { env: GIT_ENV });
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    env: GIT_ENV, encoding: "utf-8",
  }).trim();
}

function bareOrigin(root: string, name = "origin",
  seedFiles: Record<string, string> = {}): string {
  const seed = join(root, `seed-${name}`);
  rawGit(["init", "-q", "-b", "master", seed]);
  writeFileSync(join(seed, "readme.md"), "基线\n");
  for (const [path, content] of Object.entries(seedFiles)) {
    const target = join(seed, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "基线:master 起点");
  const origin = join(root, `${name}.git`);
  rawGit(["clone", "-q", "--bare", seed, origin]);
  return origin;
}

function seedWorkspace(sessionRoot: string, origin: string): string {
  const dir = join(sessionRoot, "repo", "origin");
  rawGit(["clone", "-q", origin, dir]);
  git(dir, "checkout", "-q", "-b", BRANCH);
  return dir;
}

function commitFiles(dir: string, message: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

function pushPlatform(dir: string): string {
  git(dir, "push", "-q", "origin", BRANCH);
  return git(dir, "rev-parse", "HEAD");
}

interface SeedEvent {
  at: string;
  note: string;
}

interface SeedOptions {
  /** 转移账事件(推送账/反馈/外部头观测),按时间序。 */
  events: SeedEvent[];
  /** MR 账(合入头/目标分支;缺席=不建 MR 账)。 */
  mr?: { merged_sha?: string; target?: string };
  status?: IssueSessionState["status"];
}

function seedState(root: string, origin: string, options: SeedOptions)
  : IssueSessionState {
  const now = new Date().toISOString();
  const state: IssueSessionState = {
    id: "issue-1", account: ACCOUNT, reporter: ACCOUNT,
    created_at: now, updated_at: now,
    title: "一次生成归属夹具", description: "", source: "dts", ticket: TICKET,
    repo_url: origin, repo_urls: [origin],
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "pending"],
    status: options.status ?? "archived",
    stage: "mr_green", stage_note: "", stage_at: now,
    ...(options.mr
      ? {
        mrs: [{
          repo: origin, branch: BRANCH,
          target: options.mr.target ?? "master",
          title: `[${TICKET}] 夹具`, at: now,
          ...(options.mr.merged_sha
            ? { merged_at: now, merged_sha: options.mr.merged_sha }
            : {}),
        }],
      }
      : {}),
    conclusion: { kind: "delivered", summary: "修复完成", at: now },
    transitions: options.events.map((event) => ({
      at: event.at, source: "platform" as const, note: event.note,
    })),
  };
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "issue.json"), JSON.stringify(state, null, 1));
  return state;
}

const pushNote = (origin: string, sha: string) =>
  `分支已推送 ${origin} ${BRANCH} @ ${sha.slice(0, 12)}`;

const repoOk = (snapshot: IssueCodeOriginSnapshot): IssueCodeOriginRepoOk => {
  const repo = snapshot.by_repo[0]!;
  if ("unavailable" in repo) {
    assert.fail(`仓段不该降级:${repo.unavailable}`);
  }
  return repo;
};

const lines = (n: number) => Array.from(
  { length: n }, (_, index) => `第 ${index + 1} 行`).join("\n") + "\n";

// ---- 纯函数 ----

test("返工边界:反馈先于一切推送不算边界;无反馈=全程首轮", () => {
  const pushes = [
    { repo: "r", branch: "b", sha: "aaaaaaaaaaaa", at: "2026-09-20T02:00:00.000Z" },
    { repo: "r", branch: "b", sha: "bbbbbbbbbbbb", at: "2026-09-20T03:00:00.000Z" },
  ];
  // 反馈早于首笔推送(如对分析报告的检视):不构成代码返工边界。
  assert.equal(reworkBoundary(pushes, [
    { kind: "review_sent", at: "2026-09-20T01:00:00.000Z" },
  ]), null);
  // 无反馈:全程首轮。
  assert.equal(reworkBoundary(pushes, []), null);
  // 反馈落在两笔推送之间:回应的是它之前最近一笔(首笔)。
  assert.deepEqual(reworkBoundary(pushes, [
    { kind: "verify_fail", at: "2026-09-20T02:30:00.000Z" },
  ]), {
    kind: "verify_fail",
    at: "2026-09-20T02:30:00.000Z",
    push_sha: "aaaaaaaaaaaa",
  });
});

test("聚合:降级仓跳过;分母 0 → null;达标线按占比判", () => {
  const snapshot: IssueCodeOriginSnapshot = {
    schema_version: 2,
    generated_at: "now",
    session_id: "issue-1",
    by_repo: [
      { repo: "a", branch: "b",
        lines: { first: 60, rework: 20, external: 20 } },
      { repo: "c", branch: "d", unavailable: "不可得:现场已回收" },
    ],
  } as unknown as IssueCodeOriginSnapshot;
  const aggregate = aggregateCodeOrigin(snapshot, 60);
  assert.equal(aggregate.total, 100);
  assert.equal(aggregate.share, 60);
  assert.equal(aggregate.pass, true);
  assert.equal(aggregateCodeOrigin(snapshot, 90).pass, false);
  const empty = aggregateCodeOrigin({
    schema_version: 2, generated_at: "now", session_id: "x",
    by_repo: [{ repo: "c", branch: "d", unavailable: "不可得" }],
  } as unknown as IssueCodeOriginSnapshot);
  assert.equal(empty.total, 0);
  assert.equal(empty.share, null);
  assert.equal(empty.pass, null);
});

// ---- 真仓夹具 ----

test("单推送无反馈:全部工作行计首轮,占比 100;md 不进分母", async () => {
  const tmp = mfcTemp("mfc-codeorigin-");
  const root = join(tmp, "issues", "issue-1");
  const origin = bareOrigin(tmp);
  const dir = seedWorkspace(root, origin);
  const sha = pushPlatformAfter(dir, {
    "src/a.ts": lines(10),
    "notes.md": "说明文档不进分母\n",
  });
  const state = seedState(root, origin, {
    events: [{ at: "2026-09-20T02:00:00.000Z", note: pushNote(origin, sha) }],
  });
  const snapshot = await buildCodeOriginSnapshot(root, state);
  const repo = repoOk(snapshot);
  assert.equal(repo.boundary, null);
  assert.deepEqual(repo.lines, { first: 10, rework: 0, external: 0 });
  const aggregate = aggregateCodeOrigin(snapshot, 90);
  assert.equal(aggregate.share, 100);
  assert.equal(aggregate.pass, true);
});

/** 工作区落文件提交并推送(返回完整提交号)。 */
function pushPlatformAfter(dir: string, files: Record<string, string>, message = "修复"): string {
  commitFiles(dir, message, files);
  return pushPlatform(dir);
}

test("两推送夹一次验证失败:边界前工作行首轮、边界后行返工", async () => {
  const tmp = mfcTemp("mfc-codeorigin-");
  const root = join(tmp, "issues", "issue-1");
  const origin = bareOrigin(tmp);
  const dir = seedWorkspace(root, origin);
  const first = pushPlatformAfter(dir, { "src/a.ts": lines(10) }, "首轮实现");
  const verifyFail = "第 1 轮:用户环境验证发现问题:页面仍然白屏";
  const second = pushPlatformAfter(dir, { "src/b.ts": lines(10) }, "返工修复");
  const state = seedState(root, origin, {
    events: [
      { at: "2026-09-20T02:00:00.000Z", note: pushNote(origin, first) },
      { at: "2026-09-20T02:30:00.000Z", note: verifyFail },
      { at: "2026-09-20T03:00:00.000Z", note: pushNote(origin, second) },
    ],
  });
  const snapshot = await buildCodeOriginSnapshot(root, state);
  const repo = repoOk(snapshot);
  assert.ok(repo.boundary);
  assert.equal(repo.boundary!.kind, "verify_fail");
  assert.equal(repo.boundary!.push_sha, first.slice(0, 12));
  assert.deepEqual(repo.lines, { first: 10, rework: 10, external: 0 });
  const aggregate = aggregateCodeOrigin(snapshot, 90);
  assert.equal(aggregate.share, 50);
  assert.equal(aggregate.pass, false);
});

test("平台外尾部提交:fetch 拿到对象,行进分母不计分子,口径=mr_branch", async () => {
  const tmp = mfcTemp("mfc-codeorigin-");
  const root = join(tmp, "issues", "issue-1");
  const origin = bareOrigin(tmp);
  const dir = seedWorkspace(root, origin);
  const first = pushPlatformAfter(dir, { "src/a.ts": lines(10) }, "平台首轮");
  // 平台外:另一个克隆直接往同分支续推一笔(平台推送账没有它)。
  const outsider = join(root, "outsider");
  rawGit(["clone", "-q", origin, outsider]);
  git(outsider, "checkout", "-q", BRANCH);
  commitFiles(outsider, "人工在平台外改的", { "src/human.ts": lines(10) });
  git(outsider, "push", "-q", "origin", BRANCH);
  const state = seedState(root, origin, {
    events: [{ at: "2026-09-20T02:00:00.000Z", note: pushNote(origin, first) }],
    mr: {},
  });
  const snapshot = await buildCodeOriginSnapshot(root, state);
  const repo = repoOk(snapshot);
  // MR 未合入:head 取 fetch 到的分支头(含平台外提交),对象由
  // fetch 带进本地——不 fetch 这行 blame 不到,等于变相剔除平台外。
  assert.equal(repo.head_basis, "mr_branch");
  assert.deepEqual(repo.lines, { first: 10, rework: 0, external: 10 });
  const aggregate = aggregateCodeOrigin(snapshot, 90);
  assert.equal(aggregate.share, 50);
  assert.equal(aggregate.pass, false);
});

test("外部头观测:平台外提交夹在两笔平台推送之间,观测账在场按平台外计", async () => {
  const tmp = mfcTemp("mfc-codeorigin-");
  const root = join(tmp, "issues", "issue-1");
  const origin = bareOrigin(tmp);
  const dir = seedWorkspace(root, origin);
  const first = pushPlatformAfter(dir, { "src/a.ts": lines(10) }, "平台首轮");
  const outsider = join(root, "outsider");
  rawGit(["clone", "-q", origin, outsider]);
  git(outsider, "checkout", "-q", BRANCH);
  const external = git(outsider, "rev-parse", "HEAD");
  commitFiles(outsider, "人工插入", { "src/e1.ts": lines(10) });
  git(outsider, "push", "-q", "origin", BRANCH);
  const externalTip = git(outsider, "rev-parse", "HEAD");
  // 平台把外部提交拉回来接着推(区间归属本会把它吸收成平台)。
  git(dir, "fetch", "-q", "origin");
  git(dir, "merge", "-q", "--ff-only", `origin/${BRANCH}`);
  const second = pushPlatformAfter(dir, { "src/b.ts": lines(10) }, "平台续推");
  const state = seedState(root, origin, {
    events: [
      { at: "2026-09-20T02:00:00.000Z", note: pushNote(origin, first) },
      { at: "2026-09-20T02:10:00.000Z",
        note: `分支头已被平台外提交 ${externalTip.slice(0, 12)} 取代,检查目标跟随切换(origin)` },
      { at: "2026-09-20T02:20:00.000Z", note: pushNote(origin, second) },
    ],
    mr: { merged_sha: second },
  });
  assert.notEqual(external, externalTip);
  const snapshot = await buildCodeOriginSnapshot(root, state);
  const repo = repoOk(snapshot);
  // 区间(P1..P2] 含平台外提交,但观测账点名它:按平台外计。
  assert.equal(repo.head_basis, "merged_sha");
  assert.deepEqual(repo.lines, { first: 20, rework: 0, external: 10 });
  const aggregate = aggregateCodeOrigin(snapshot, 60);
  assert.equal(aggregate.share, 66.7);
});

test("非 squash 合入:head 口径=merged_sha,数字与分支路径一致", async () => {
  const tmp = mfcTemp("mfc-codeorigin-");
  const root = join(tmp, "issues", "issue-1");
  const origin = bareOrigin(tmp);
  const dir = seedWorkspace(root, origin);
  const first = pushPlatformAfter(dir, { "src/a.ts": lines(10) }, "首轮");
  // 真合入:第三个克隆把修复分支 merge --no-ff 进 master(新克隆只有
  // 远端跟踪引用,合 origin/BRANCH)。
  const merger = join(root, "merger");
  rawGit(["clone", "-q", origin, merger]);
  git(merger, "checkout", "-q", "master");
  git(merger, "merge", "-q", "--no-ff", `origin/${BRANCH}`, "-m", "合入修复分支");
  git(merger, "push", "-q", "origin", "master");
  const state = seedState(root, origin, {
    events: [{ at: "2026-09-20T02:00:00.000Z", note: pushNote(origin, first) }],
    mr: { merged_sha: first },
  });
  const snapshot = await buildCodeOriginSnapshot(root, state);
  const repo = repoOk(snapshot);
  assert.equal(repo.head_basis, "merged_sha");
  assert.deepEqual(repo.lines, { first: 10, rework: 0, external: 0 });
});

test("squash 合入+分支已删:退本地末笔推送,口径=local_push", async () => {
  const tmp = mfcTemp("mfc-codeorigin-");
  const root = join(tmp, "issues", "issue-1");
  const origin = bareOrigin(tmp);
  const dir = seedWorkspace(root, origin);
  const first = pushPlatformAfter(dir, { "src/a.ts": lines(10) }, "首轮");
  // squash 合入:产物在目标分支上;随后删除远端修复分支。
  const merger = join(root, "merger");
  rawGit(["clone", "-q", origin, merger]);
  git(merger, "checkout", "-q", "master");
  git(merger, "merge", "-q", "--squash", `origin/${BRANCH}`);
  commitFiles(merger, "squash 合入修复分支", {});
  git(merger, "push", "-q", "origin", "master");
  git(merger, "push", "-q", "origin", "--delete", BRANCH);
  const squashSha = git(merger, "rev-parse", "HEAD");
  const state = seedState(root, origin, {
    events: [{ at: "2026-09-20T02:00:00.000Z", note: pushNote(origin, first) }],
    // merged_sha 记的是平台观测到的合入产物(squash 提交,在目标分支
    // 上);平台克隆没拉过合入后的 master,该对象不在本地。
    mr: { merged_sha: squashSha },
  });
  const snapshot = await buildCodeOriginSnapshot(root, state);
  const repo = repoOk(snapshot);
  assert.equal(repo.head_basis, "local_push");
  assert.deepEqual(repo.lines, { first: 10, rework: 0, external: 0 });
});

test("降级:工作区缺失→单仓「不可得」不抛出;读侧聚合跳过", async () => {
  const tmp = mfcTemp("mfc-codeorigin-");
  const root = join(tmp, "issues", "issue-1");
  const origin = bareOrigin(tmp);
  const state = seedState(join(root, "issue-1"), origin, {
    events: [{ at: "2026-09-20T02:00:00.000Z",
      note: pushNote(origin, "0123456789ab") }],
  });
  // 现场没有 repo/ 子树(已回收):整仓降级。
  const snapshot = await buildCodeOriginSnapshot(join(root, "issue-1"), state);
  const repo = snapshot.by_repo[0]!;
  assert.ok("unavailable" in repo);
  assert.match(repo.unavailable, /现场可能已回收/);
  assert.equal(aggregateCodeOrigin(snapshot).total, 0);
});

// ---- 落盘语义(只写一次/通道/兜底/支持期) ----

async function seedComputableSession(root: string): Promise<string> {
  const origin = bareOrigin(root);
  const dir = seedWorkspace(root, origin);
  const sha = pushPlatformAfter(dir, { "src/a.ts": lines(10) });
  const state = seedState(root, origin, {
    events: [{ at: "2026-09-20T02:00:00.000Z", note: pushNote(origin, sha) }],
  });
  // 结论时刻钉在起算日期之后(测试机真实时钟可能仍在 UTC 前一天,
  // 不能拿 new Date() 赌支持期判定)。
  state.conclusion = { kind: "delivered", summary: "", at: "2026-09-20T12:00:00.000Z" };
  writeFileSync(join(root, "issue.json"), JSON.stringify(state, null, 1));
  return origin;
}

test("只写一次:重复写跳过;读侧验 session_id 与版本", async () => {
  const tmp = mfcTemp("mfc-codeorigin-");
  const root = join(tmp, "issues", "issue-1");
  await seedComputableSession(root);
  const first = await writeCodeOriginSnapshot(root,
    JSON.parse(readFileSyncForState(root)));
  assert.equal(first.written, true);
  const again = await writeCodeOriginSnapshot(root,
    JSON.parse(readFileSyncForState(root)));
  assert.equal(again.written, false);
  const snapshot = readCodeOriginSnapshot(root, "issue-1");
  assert.ok(snapshot);
  assert.equal(snapshot!.session_id, "issue-1");
  // 会话号对不上(盘上文件挪用)不认。
  assert.equal(readCodeOriginSnapshot(root, "issue-2"), undefined);
});

function readFileSyncForState(root: string): string {
  return readFileSync(join(root, "issue.json"), "utf-8");
}

test("enqueue:入队算完落盘,onSettled 收尾;再入队返回 false", async () => {
  const tmp = mfcTemp("mfc-codeorigin-");
  const root = join(tmp, "issues", "issue-1");
  await seedComputableSession(root);
  const state = JSON.parse(readFileSyncForState(root)) as IssueSessionState;
  let settled = 0;
  const queued = enqueueCodeOrigin(root, state, {},
    { onSettled: () => { settled += 1; }, log: () => {} });
  assert.equal(queued, true);
  assert.equal(settled, 0); // 归档不等计算
  await awaitCodeOriginLane();
  assert.equal(settled, 1);
  assert.ok(existsSync(join(root, ISSUE_CODE_ORIGIN_FILE)));
  // 伴生已在:不再入队(调用方立即回收现场)。
  assert.equal(enqueueCodeOrigin(root, state, {},
    { onSettled: () => { settled += 1; }, log: () => {} }), false);
  assert.equal(settled, 1);
});

test("backfill:缺失补算;在场跳过;支持期外不试算", async () => {
  const tmp = mfcTemp("mfc-codeorigin-");
  const root = join(tmp, "issues", "issue-1");
  await seedComputableSession(root);
  const state = JSON.parse(readFileSyncForState(root)) as IssueSessionState;
  const logs: string[] = [];
  assert.equal(await backfillCodeOrigin(root, state, {},
    (message) => logs.push(message)), true);
  assert.ok(existsSync(join(root, ISSUE_CODE_ORIGIN_FILE)));
  assert.equal(await backfillCodeOrigin(root, state, {},
    (message) => logs.push(message)), false);
  // 起算日期前终态的存量会话:不试算、不入队。
  const staleRoot = join(tmp, "issues", "stale");
  const staleOrigin = bareOrigin(tmp, "stale-origin");
  {
    const dir = seedWorkspace(staleRoot, staleOrigin);
    const sha = pushPlatformAfter(dir, { "src/a.ts": lines(5) });
    const staleSeed = seedState(staleRoot, staleOrigin, {
      events: [{ at: "2026-09-19T23:00:00.000Z", note: pushNote(staleOrigin, sha) }],
    });
    staleSeed.conclusion = {
      kind: "delivered", summary: "", at: "2026-09-19T23:59:00.000Z",
    };
    writeFileSync(join(staleRoot, "issue.json"),
      JSON.stringify(staleSeed, null, 1));
  }
  const staleState = JSON.parse(
    readFileSyncForState(staleRoot)) as IssueSessionState;
  assert.equal(await backfillCodeOrigin(staleRoot, staleState, {}, () => {}), false);
  assert.equal(enqueueCodeOrigin(staleRoot, staleState, {}, {}), false);
  assert.ok(!existsSync(join(staleRoot, ISSUE_CODE_ORIGIN_FILE)));
});

// ---- 工作量口径新增边界(T1,#343) ----

test("纯删除修复正常计分:删除行计正向工作量,占比 100", async () => {
  const tmp = mfcTemp("mfc-codeorigin-");
  const root = join(tmp, "issues", "issue-1");
  // 基线里预置 30 行源码,会话唯一动作是把它删掉(纯删除交付)。
  const origin = bareOrigin(tmp, "origin", {
    "src/legacy.ts": Array.from({ length: 30 }, (_, i) => `旧代码 ${i}`).join("\n") + "\n",
  });
  const dir = seedWorkspace(root, origin);
  git(dir, "rm", "-q", "src/legacy.ts");
  git(dir, "commit", "-q", "-m", "清理:删除废弃的 legacy 模块");
  const sha = pushPlatform(dir);
  const state = seedState(root, origin, {
    events: [{ at: "2026-09-20T02:00:00.000Z", note: pushNote(origin, sha) }],
  });
  const snapshot = await buildCodeOriginSnapshot(root, state);
  const repo = repoOk(snapshot);
  // 删除行计正向工作量:首轮 30,占比 100%——留存口径下这里是「—」。
  assert.deepEqual(repo.lines, { first: 30, rework: 0, external: 0 });
  assert.equal(aggregateCodeOrigin(snapshot, 90).share, 100);
});

test("多仓时点边界:边界事件后两仓的推送都计返工", async () => {
  const tmp = mfcTemp("mfc-codeorigin-");
  const rootA = join(tmp, "issues", "issue-1");
  const originA = bareOrigin(tmp, "origin-a");
  const dirA = seedWorkspaceNamed(rootA, originA, "origin-a");
  const firstA = pushPlatformAfter(dirA, { "src/a.ts": lines(10) }, "A 仓首轮");
  const originB = bareOrigin(tmp, "origin-b");
  const dirB = seedWorkspaceNamed(rootA, originB, "origin-b");
  // 反馈事件之后:A 仓修复推送与 B 仓首笔交付都晚于事件——两仓都计返工。
  const reworkA = pushPlatformAfter(dirA, { "src/a2.ts": lines(5) }, "A 仓按意见返工");
  const reworkB = pushPlatformAfter(dirB, { "src/b.ts": lines(5) }, "B 仓首笔交付");
  const state = seedState(rootA, originA, {
    events: [
      { at: "2026-09-20T02:00:00.000Z", note: pushNote(originA, firstA) },
      { at: "2026-09-20T03:00:00.000Z", note: pushNote(originA, reworkA) },
      { at: "2026-09-20T03:30:00.000Z", note: pushNote(originB, reworkB) },
    ],
    mr: {},
  });
  // 检视批次送出住在检视账(reviews.jsonl),带时刻——反馈事件的来源之一。
  writeFileSync(join(rootA, "reviews.jsonl"),
    JSON.stringify({ op: "sent", ids: ["an-1"], via: "issue_review",
      at: "2026-09-20T02:30:00.000Z", by: ACCOUNT }) + "\n");
  // 多仓登记:B 仓也要进 repo_urls,工作区映射才找得到它的克隆。
  state.repo_urls = [originA, originB];
  writeFileSync(join(rootA, "issue.json"), JSON.stringify(state, null, 1));
  // 边界=首个反馈事件(02:30 检视)之前最近的一笔推送(02:00 A 仓);
  // 之后两仓的推送(03:00 A、03:30 B)按时刻一律计返工——多仓不留
  // 「另一个仓全算首轮」的角落。
  const snapshot = await buildCodeOriginSnapshot(rootA, state);
  const byRepo = new Map(snapshot.by_repo.map((repo) => [repo.repo, repo]));
  const repoA = byRepo.get(originA)!;
  if ("unavailable" in repoA) assert.fail(repoA.unavailable);
  assert.deepEqual(repoA.lines, { first: 10, rework: 5, external: 0 });
  const repoB = byRepo.get(originB)!;
  if ("unavailable" in repoB) assert.fail(repoB.unavailable);
  // B 仓首笔推送(03:30)晚于首个反馈事件(02:30) → 整笔计返工:
  // 时点规则下多仓不留「另一个仓全算首轮」的角落。
  assert.deepEqual(repoB.lines, { first: 0, rework: 5, external: 0 });
});

/** 指定仓名的多仓工作区(目录名=仓名,避免两仓同名互踩)。 */
function seedWorkspaceNamed(sessionRoot: string, origin: string, name: string)
  : string {
  const dir = join(sessionRoot, "repo", name);
  rawGit(["clone", "-q", origin, dir]);
  git(dir, "checkout", "-q", "-b", BRANCH);
  return dir;
}
