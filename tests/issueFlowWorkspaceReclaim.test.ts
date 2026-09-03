/**
 * 问题会话工作区回收的契约(spec #79 第 6 项,票 #84)。
 *
 * 最重的两条:
 * 1. **台账一个字节都不许少**——归档会话的网页查看读 issue.json/反馈/
 *    事件/材料,重货清掉后这些必须原样活着;没点名的条目一律保留
 *    ("不确定属于重货还是台账的倾向保留"是红线原文)。
 * 2. **保守四保险**——非终态一概不碰;终态未过保留期不碰;容器在跑
 *    跳过;单会话翻车不扩散(fail-open)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ISSUE_RECLAIM_HEAVY,
  judgeIssueReclaim,
  reclaimIssueWorkspaces,
  reclaimIssueWorkspace,
} from "../src/issueFlowWorkspaceReclaim.ts";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-09-03T12:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

/** 造一个"什么都有"的问题会话现场:台账 + 重货各一份。 */
function sessionRoot(
  dataDir: string,
  id: string,
  state: Record<string, unknown>,
): string {
  const root = join(dataDir, "issues", id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id, account: "zhang", title: "订单模块 500",
    created_at: daysAgo(40), updated_at: daysAgo(20),
    status: "archived", stage: "done", stage_note: "", stage_at: daysAgo(20),
    ...state,
  }, null, 1));
  // —— 台账(一个字节都不许动)——
  writeFileSync(join(root, "events.jsonl"),
    '{"kind":"stage_advanced","note":"定位到根因"}\n');
  writeFileSync(join(root, "transcript.jsonl"), '{"role":"assistant"}\n');
  writeFileSync(join(root, "waiting.json"), "{}");
  writeFileSync(join(root, "issue-analysis.md"), "# 分析报告:连接池耗尽");
  writeFileSync(join(root, "reviews.jsonl"), '{"text":"这里要写清阈值"}\n');
  writeFileSync(join(root, "manual-edits.jsonl"),
    '{"path":"repo/svc/src/Main.java","size":3}\n');
  mkdirSync(join(root, "feedback"), { recursive: true });
  writeFileSync(join(root, "feedback", "index.jsonl"),
    '{"source":"pipeline","status":"closed"}\n');
  mkdirSync(join(root, "issue-images"), { recursive: true });
  writeFileSync(join(root, "issue-images", "截图.png"), "人交的材料");
  mkdirSync(join(root, "ticket-images", "DTS-2026"), { recursive: true });
  writeFileSync(join(root, "ticket-images", "DTS-2026", "p.png"), "单据附件");
  mkdirSync(join(root, "skills", "java"), { recursive: true });
  writeFileSync(join(root, "skills", "java", "SKILL.md"), "# skill");

  // —— 重货(过了保留期可以清)——
  mkdirSync(join(root, "repo", "order-service", ".git"), { recursive: true });
  writeFileSync(join(root, "repo", "order-service", "pom.xml"), "<p/>");
  mkdirSync(join(root, "ref", "legacy-repo"), { recursive: true });
  writeFileSync(join(root, "ref", "legacy-repo", "README.md"), "老布局");
  mkdirSync(join(root, "pipeline", "mr-42"), { recursive: true });
  writeFileSync(join(root, "pipeline", "mr-42", "build.log"), "BUILD FAILURE");
  mkdirSync(join(root, "local-logs", "网管A"), { recursive: true });
  writeFileSync(join(root, "local-logs", "网管A", "alarm.log"), "x".repeat(2048));
  mkdirSync(join(root, "pi-agent"), { recursive: true });
  writeFileSync(join(root, "pi-agent", "models.json"), "{}");
  mkdirSync(join(root, "vision-cache"), { recursive: true });
  writeFileSync(join(root, "vision-cache", "img.json"), "{}");
  mkdirSync(join(root, ".ops-tools"), { recursive: true });
  writeFileSync(join(root, ".ops-tools", "fetch-logs-linux-amd64"), "ELF");
  return root;
}

function newDataDir(): string {
  return mkdtempSync(join(tmpdir(), "mfc-issue-reclaim-"));
}

/** 带一个过期归档会话的 dataDir(默认场景,各用例再改状态/时间)。 */
function expiredArchivedRoot(dataDir: string, id = "issue-1"): string {
  return sessionRoot(dataDir, id, {
    status: "archived",
    conclusion: { kind: "delivered", summary: "已修复并提交 MR", at: daysAgo(20) },
  });
}

/* ---------------- 逐条验收:四保险 ---------------- */

test("过期终态会话:重货被清,台账一个字节不少", () => {
  const dataDir = newDataDir();
  const root = expiredArchivedRoot(dataDir);

  const summary = reclaimIssueWorkspaces({
    dataDir, retentionDays: 14, now: NOW,
  });

  assert.equal(summary.reclaimed, 1);
  assert.ok(summary.freed > 2048, `应释放出 local-logs 那 2KB,实际 ${summary.freed}`);
  // 重货点名清掉。
  for (const name of ISSUE_RECLAIM_HEAVY) {
    assert.equal(existsSync(join(root, name)), false, `${name} 是重货,该清`);
  }
  // 台账逐项点名:查看模式与复盘全靠它们。
  assert.equal(
    readFileSync(join(root, "issue.json"), "utf-8").slice(0, 1), "{");
  assert.match(
    readFileSync(join(root, "issue.json"), "utf-8"), /订单模块 500/);
  assert.match(
    readFileSync(join(root, "events.jsonl"), "utf-8"), /定位到根因/);
  assert.ok(existsSync(join(root, "transcript.jsonl")));
  assert.ok(existsSync(join(root, "waiting.json")));
  assert.ok(existsSync(join(root, "issue-analysis.md")));
  assert.match(
    readFileSync(join(root, "reviews.jsonl"), "utf-8"), /要写清阈值/);
  assert.ok(existsSync(join(root, "feedback", "index.jsonl")));
  assert.ok(existsSync(join(root, "manual-edits.jsonl")));
  assert.ok(existsSync(join(root, "issue-images", "截图.png")),
    "人交的材料不算重货");
  assert.ok(existsSync(join(root, "ticket-images", "DTS-2026", "p.png")));
  assert.ok(existsSync(join(root, "skills", "java", "SKILL.md")));
});

test("非终态一概不碰:running/waiting_user/idle/suspended/queued 全样", () => {
  for (const status of ["running", "waiting_user", "idle", "suspended",
                        "queued"]) {
    const dataDir = newDataDir();
    const root = sessionRoot(dataDir, "issue-1", { status });
    const before = readdirSync(root).sort();
    const summary = reclaimIssueWorkspaces({
      dataDir, retentionDays: 14, now: NOW,
    });
    assert.equal(summary.reclaimed, 0, `${status} 不该被回收`);
    assert.deepEqual(readdirSync(root).sort(), before,
      `${status} 的会话目录必须原样`);
    assert.ok(existsSync(join(root, "repo", "order-service", "pom.xml")));
  }
});

test("终态但未过保留期:原样(给查看模式/复盘留窗口)", () => {
  const dataDir = newDataDir();
  const root = sessionRoot(dataDir, "issue-1", {
    status: "archived",
    conclusion: { kind: "fixed", summary: "刚收口", at: daysAgo(3) },
  });
  const before = readdirSync(root).sort();
  const summary = reclaimIssueWorkspaces({
    dataDir, retentionDays: 14, now: NOW,
  });
  assert.equal(summary.reclaimed, 0);
  assert.deepEqual(readdirSync(root).sort(), before);
  assert.ok(existsSync(join(root, "repo", "order-service", "pom.xml")));
});

test("容器在跑 → 跳过(保险丝起作用,统计可见)", () => {
  const dataDir = newDataDir();
  const root = sessionRoot(dataDir, "issue-1", { status: "canceled" });
  const before = readdirSync(root).sort();
  const summary = reclaimIssueWorkspaces({
    dataDir, retentionDays: 14, now: NOW,
    containerRunning: (id) => id === "issue-1",
  });
  assert.equal(summary.reclaimed, 0);
  assert.equal(summary.skipped_container, 1);
  assert.deepEqual(readdirSync(root).sort(), before);
  assert.ok(existsSync(join(root, "pipeline", "mr-42", "build.log")));
});

/* ---------------- fail-open:单会话翻车不扩散 ---------------- */

test("单会话 issue.json 读爆,不影响其余会话回收", () => {
  const dataDir = newDataDir();
  const bad = expiredArchivedRoot(dataDir, "issue-1");
  // 台账坏档:JSON 解析直接抛。回收是旁路,只许这一单今天放过。
  writeFileSync(join(bad, "issue.json"), "{ Definitely Not JSON");
  const good = expiredArchivedRoot(dataDir, "issue-2");

  const summary = reclaimIssueWorkspaces({
    dataDir, retentionDays: 14, now: NOW,
    log: (message) => void message,
  });

  assert.equal(summary.failed, 1, "坏档会话计一次失败");
  assert.equal(summary.reclaimed, 1, "好会话照常回收");
  assert.equal(existsSync(join(good, "repo")), false);
  assert.ok(existsSync(join(good, "issue.json")));
  assert.ok(existsSync(join(bad, "repo", "order-service", "pom.xml")),
    "坏档会话一个字节都不许动");
});

test("回收是幂等的:第二轮没有重货可删,不再计数", () => {
  const dataDir = newDataDir();
  expiredArchivedRoot(dataDir);
  const first = reclaimIssueWorkspaces({ dataDir, retentionDays: 14, now: NOW });
  assert.equal(first.reclaimed, 1);
  const second = reclaimIssueWorkspaces({ dataDir, retentionDays: 14, now: NOW });
  assert.equal(second.reclaimed, 0);
  assert.equal(second.freed, 0);
});

/* ---------------- 边界闸与判据 ---------------- */

test("issues/ 下的软链接不许绕过边界:realpath 在外面就一个字节不删", () => {
  // 2026-08-22 同款教训:readdir 看着在 dataDir 里,realpath 一解在外面,
  // 删的是原件。删除动作必须自己验边界。
  const dataDir = newDataDir();
  const outside = mkdtempSync(join(tmpdir(), "mfc-issue-outside-"));
  writeFileSync(join(outside, "issue.json"), JSON.stringify({
    id: "issue-9", status: "archived",
    conclusion: { kind: "fixed", summary: "", at: daysAgo(20) },
    updated_at: daysAgo(20),
  }));
  mkdirSync(join(outside, "repo"), { recursive: true });
  writeFileSync(join(outside, "repo", "big.jar"), "x".repeat(4096));
  mkdirSync(join(dataDir, "issues"), { recursive: true });
  symlinkSync(outside, join(dataDir, "issues", "issue-9"));

  const summary = reclaimIssueWorkspaces({
    dataDir, retentionDays: 14, now: NOW,
  });

  assert.equal(summary.reclaimed, 0);
  assert.ok(existsSync(join(outside, "repo", "big.jar")), "越界还把重货删了");
  const result = reclaimIssueWorkspace(join(dataDir, "issues", "issue-9"),
    { dataDir });
  assert.match(String(result.refused), /拒绝删除/);
});

test("判据:保留期 0 永不、没有终态时间不下手、取消路退到 updated_at", () => {
  const base = {
    id: "issue-1", status: "archived",
    concluded_at: daysAgo(20),
  };
  const off = judgeIssueReclaim(base, { now: NOW, retentionDays: 0 });
  assert.equal(off.reclaim, false);
  assert.match(off.reason, /永不回收/);
  assert.equal(off.skip, "retention_off");

  const ageless = judgeIssueReclaim(
    { id: "issue-1", status: "failed" },
    { now: NOW, retentionDays: 14 });
  assert.equal(ageless.reclaim, false);
  assert.match(ageless.reason, /判不了年纪/);

  // canceled/failed 没有结论时刻,终态落盘就是最后一次 saveState——
  // updated_at 即收口锚。
  const canceled = judgeIssueReclaim(
    { id: "issue-1", status: "canceled", updated_at: daysAgo(30) },
    { now: NOW, retentionDays: 14 });
  assert.equal(canceled.reclaim, true);
  assert.match(canceled.reason, /超过保留期 14 天/);

  // 归档优先用 conclusion.at(它才是"结论时刻"),不猜别的字段。
  const freshConclusion = judgeIssueReclaim(
    { id: "issue-1", status: "archived", concluded_at: daysAgo(2),
      updated_at: daysAgo(40) },
    { now: NOW, retentionDays: 14 });
  assert.equal(freshConclusion.reclaim, false);
  assert.match(freshConclusion.reason, /未到保留期/);
});

test("非 issue- 前缀的目录不认(与 recover() 同一把尺子)", () => {
  const dataDir = newDataDir();
  mkdirSync(join(dataDir, "issues", "notes"), { recursive: true });
  writeFileSync(join(dataDir, "issues", "notes", "issue.json"), JSON.stringify({
    id: "notes", status: "archived", updated_at: daysAgo(40),
  }));
  mkdirSync(join(dataDir, "issues", "notes", "repo"), { recursive: true });
  const summary = reclaimIssueWorkspaces({
    dataDir, retentionDays: 14, now: NOW,
  });
  assert.equal(summary.reclaimed, 0);
  assert.ok(existsSync(join(dataDir, "issues", "notes", "repo")));
});
