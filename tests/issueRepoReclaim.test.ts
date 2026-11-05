/**
 * 磁盘治理(.scratch/issue-disk-hygiene 票 01/03)的契约测试:终态
 * (canceled/archived)repo 整仓回收 + idle 单构建产物冷却清理。
 *
 * 钉的机械事实:
 * - 终态(canceled/archived)→ repo/ 整树消失,repo_reclaimed_at 落
 *   state,事件账有 workspace_reclaimed(bytes/scope),其余文件原样;
 * - failed 不在回收范围(可恢复态,用户拍板);
 * - idle 单构建产物:mtime 冷却过期才删(源码保留),没冷却的不动,
 *   build_products_reclaimed_at + 事件(scope=products)落账;
 * - 旋钮 issue_repo_reclaim=0 时一切不动(行为与现状全等);
 * - waiting_user 与 idle 都按冷却期清理，在途单子绝不清理。
 *
 * 清扫是纯盘面操作(不跑会话),issue 目录直接伪造,服务只当扫描器。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { mfcTemp } from "./mfcTmp.ts";
import { auxiliarySessionEpoch, trackAuxiliarySession } from "../src/auxiliarySessions.ts";

/** 伪造一个 issue 目录:issue.json + repo/ 树(源码/产物可各自带
 * mtime),返回其根路径。 */
function fabricateIssue(
  root: string,
  id: string,
  status: string,
  opts?: { oldProducts?: boolean },
): string {
  const dir = join(root, id);
  mkdirSync(join(dir, "repo", "demo", "target", "build"), { recursive: true });
  mkdirSync(join(dir, "repo", "demo", "src"), { recursive: true });
  writeFileSync(join(dir, "issue.json"), JSON.stringify({
    id, account: "dev",
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
    title: `t-${id}`, description: "d", source: "manual", status,
  }));
  writeFileSync(join(dir, "repo", "demo", "src", "a.ts"), "export {}");
  writeFileSync(join(dir, "repo", "demo", "target", "build", "x.o"), "binary");
  writeFileSync(join(dir, "issue-analysis.md"), "分析报告(必须保留)");
  if (opts?.oldProducts) {
    const old = new Date(Date.now() - 30 * 3_600_000);
    utimesSync(join(dir, "repo", "demo", "target", "build"), old, old);
    utimesSync(join(dir, "repo", "demo", "target", "build", "x.o"), old, old);
  }
  return dir;
}

/** 在会话现场造一份 2026-11 现网同款的名单外堆积(codecheck 变体、
 * 技能物化、AI 倾倒、Agent 运行时),供存量清理用例使用。 */
function fabricateLooseHeavy(root: string): void {
  for (const name of [".codecheck-home", ".codecheck-tmp", "cc-home",
                      "skills", ".mae-flow-work", "pi-agent"]) {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "payload.bin"), "h".repeat(2048));
  }
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
  assert.ok(existsSync(join(canceled, "issue-analysis.md")), "报告保留");
  assert.ok(existsSync(join(canceled, "issue.json")), "状态文件保留");
  assert.ok(existsSync(join(failed, "repo")), "failed 不在回收范围(用户拍板)");

  const state = JSON.parse(
    readFileSync(join(canceled, "issue.json"), "utf-8"));
  assert.ok(state.repo_reclaimed_at, "repo_reclaimed_at 落 state");

  const events = readFileSync(join(canceled, "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const reclaim = events.find((event) => event.kind === "workspace_reclaimed");
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
  assert.ok(result.productBytes > 0, "有产物被回收");

  assert.ok(!existsSync(join(stale, "repo", "demo", "target", "build")),
    "冷却过期的 target/build 已删");
  assert.ok(existsSync(join(stale, "repo", "demo", "src", "a.ts")),
    "源码保留");
  assert.ok(existsSync(join(stale, "issue-analysis.md")), "报告保留");
  assert.ok(existsSync(join(fresh, "repo", "demo", "target")),
    "未冷却的产物不动");
  assert.ok(existsSync(join(failedStale, "repo", "demo", "target")),
    "failed 单连产物也不清(用户拍板)");

  const state = JSON.parse(readFileSync(join(stale, "issue.json"), "utf-8"));
  assert.ok(state.build_products_reclaimed_at, "标记落 state");
  const events = readFileSync(join(stale, "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const reclaim = events.find((event) => event.kind === "workspace_reclaimed");
  assert.equal(reclaim.payload.scope, "products", "事件 scope=products");
});

test("旋钮解耦:issue_repo_reclaim=0 只关整仓回收,产物清理与名单外清理按自己的旋钮走", async () => {
  const { service, issuesRoot } = makeService({ issue_repo_reclaim: 0 });
  const canceled = fabricateIssue(issuesRoot, "issue-1", "canceled");
  fabricateLooseHeavy(canceled);
  const idleStale = fabricateIssue(issuesRoot, "issue-2", "idle",
    { oldProducts: true });

  const result = await service.sweepTerminalRepos();
  assert.equal(result.reclaimed, 0, "整仓回收被旋钮关掉");
  assert.ok(existsSync(join(canceled, "repo")), "终态现场保留(开关语义)");
  assert.ok(!existsSync(join(canceled, ".codecheck-home")),
    "名单外清理不受整仓开关连带(ADR-0073 只认保留期旋钮)");
  assert.ok(!existsSync(join(idleStale, "repo", "demo", "target", "build")),
    "产物清理独立生效(自己的冷却旋钮,不被整仓旋钮连带)");
  assert.equal(result.productBytes > 0, true, "产物回收字节照记");
});

test("存量欠账清扫:终态会话的名单外堆积见一个清一个,不等保留期;留痕落事件账", async () => {
  const { service, issuesRoot } = makeService();
  const stale = fabricateIssue(issuesRoot, "issue-1", "archived");
  fabricateLooseHeavy(stale);
  mkdirSync(join(stale, "local-logs"), { recursive: true });
  writeFileSync(join(stale, "local-logs", "alarm.log"), "现场日志");
  mkdirSync(join(stale, "attachments"), { recursive: true });
  writeFileSync(join(stale, "attachments", "a3f.log"), "登记附件");

  const result = await service.sweepTerminalRepos();

  for (const name of [".codecheck-home", ".codecheck-tmp", "cc-home",
                      "skills", ".mae-flow-work", "pi-agent"]) {
    assert.ok(!existsSync(join(stale, name)), `${name} 存量欠账被清`);
  }
  assert.ok(existsSync(join(stale, "local-logs", "alarm.log")),
    "现场日志在保留名单,原样");
  assert.ok(existsSync(join(stale, "attachments", "a3f.log")),
    "登记附件在保留名单,原样");
  assert.ok(existsSync(join(stale, "issue-analysis.md")), "报告保留");
  assert.ok(result.looseBytes > 0, "名单外回收字节照记");
  const events = readFileSync(join(stale, "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const loose = events.find((event) => event.kind === "workspace_reclaimed"
    && event.payload.scope === "loose");
  assert.ok(loose, "名单外清理落事件账");
  assert.ok(Array.isArray(loose.payload.entries)
    && loose.payload.entries.includes(".codecheck-home"),
  "逐条目留痕(条目名)");
});

test("保留期旋钮 0 = 整体禁运:终态会话的名单外堆积也不碰", async () => {
  const { service, issuesRoot } = makeService({ workspace_retention_days: 0 });
  const stale = fabricateIssue(issuesRoot, "issue-1", "archived");
  fabricateLooseHeavy(stale);

  const result = await service.sweepTerminalRepos();

  assert.equal(result.reclaimed, 0);
  assert.equal(result.looseBytes, 0);
  assert.ok(existsSync(join(stale, "repo")), "repo 原样");
  assert.ok(existsSync(join(stale, ".codecheck-home")),
    "0 = 永不回收,名单外也原样(诚实的关掉)");
});

test("流水线修复会话的存量:mr-repair- 前缀同尺扫描,名单外同规则清理", async () => {
  const dataDir = mfcTemp("mfc-mr-repair-reclaim-");
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1", modelsJson: {},
    settings: { models: () => ({}), runtime: () => ({}) },
    purpose: "pipeline_repair",
  });
  try {
    const root = fabricateIssue(join(dataDir, "pipeline-repairs"),
      "mr-repair-1", "archived");
    fabricateLooseHeavy(root);

    const result = await service.sweepTerminalRepos();

    assert.ok(!existsSync(join(root, "repo")), "修复会话 repo 照清");
    assert.ok(!existsSync(join(root, ".codecheck-home")),
      "修复会话名单外照清");
    assert.ok(existsSync(join(root, "issue-analysis.md")), "报告保留");
    assert.ok(result.looseBytes > 0);
  } finally { await service.shutdown(); }
});

test("部署后扫描存量:waiting_user 冷却后释放编译目录，running 保留", async () => {
  const { service, issuesRoot } = makeService();
  const running = fabricateIssue(issuesRoot, "issue-1", "running",
    { oldProducts: true });
  const waiting = fabricateIssue(issuesRoot, "issue-2", "waiting_user",
    { oldProducts: true });

  await service.sweepTerminalRepos();
  assert.ok(existsSync(join(running, "repo", "demo", "target")));
  assert.ok(!existsSync(join(waiting, "repo", "demo", "target", "build")));
});

test("启动恢复旧等待单后立即按原闲置时间清理，不重新计算24小时", async () => {
  const dataDir = mfcTemp("mfc-stored-issue-reclaim-");
  const root = fabricateIssue(join(dataDir, "issues"), "issue-1", "waiting_user", { oldProducts: true });
  const before = JSON.parse(readFileSync(join(root, "issue.json"), "utf8")).updated_at;
  const service = new IssueFlowService({ dataDir, provider: "maeflow", model: "scripted-v1", modelsJson: {} });
  try {
    assert.equal(service.get("issue-1").status, "waiting_user");
    assert.equal(JSON.parse(readFileSync(join(root, "issue.json"), "utf8")).updated_at, before);
    assert.ok((await service.sweepTerminalRepos()).productBytes > 0);
    assert.ok(!existsSync(join(root, "repo/demo/target/build")));
    assert.equal(service.get("issue-1").status, "waiting_user");
  } finally { await service.shutdown(); }
});

test("只删编译目录，保留构建脚本、依赖、报告、库；首编记录失效且通知可重启续用", async () => {
  const { service, issuesRoot } = makeService();
  const root = fabricateIssue(issuesRoot, "issue-1", "waiting_user", { oldProducts: true });
  const repo = join(root, "repo", "demo");
  const kept = ["build/build.sh", "depend/dep.a", "node_modules/module/index.js",
    "target/gtest_ut_report/report.xml", "target/surefire-reports/test.xml", "target/lib/libdemo.so"];
  for (const path of [...kept, ".mae-flow-work/mae-first-build.json"]) {
    const absolute = join(repo, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, "keep");
  }
  await service.sweepTerminalRepos();
  for (const path of kept) assert.ok(existsSync(join(repo, path)), path);
  assert.ok(!existsSync(join(repo, ".mae-flow-work/mae-first-build.json")));
  const state = JSON.parse(readFileSync(join(root, "issue.json"), "utf8"));
  assert.ok(state.build_products_reclaimed_at);
  assert.equal(state.parked_notices.length, 1);
  const restarted = makeService().service;
  let replay = "";
  await (restarted as any).withParkedNotices({ root, state }, async (message: string) => { replay = message; });
  assert.match(replay, /编译|构建/);
  assert.equal(JSON.parse(readFileSync(join(root, "issue.json"), "utf8")).parked_notices, undefined);
});

test("问题单预热默认关闭，具备预热执行器也不会自行启动", () => {
  for (const runtime of [{}, { issue_warmup_enabled: 0 }]) {
    const service = new IssueFlowService({
      dataDir: mfcTemp("mfc-warmup-disabled-"), provider: "maeflow", model: "scripted-v1", modelsJson: {},
      settings: { models: () => ({}), runtime: () => runtime },
      warmup: { enabled: true, runner: async () => { throw new Error("不应调用"); } },
    });
    const live: any = { state: { status: "idle" } };
    (service as any).startBaselineWarmup(live);
    assert.equal(live.warmupActive, undefined);
    assert.equal(live.state.warmup, undefined);
  }
});

test("24小时默认值与动态配置：近期交互不删，0关闭，调小后下一轮生效", async () => {
  const runtime = { issue_build_products_cooldown_hours: 24 };
  const { service, issuesRoot } = makeService(runtime);
  const root = fabricateIssue(issuesRoot, "issue-1", "waiting_user", { oldProducts: true });
  const file = join(root, "issue.json");
  const state = JSON.parse(readFileSync(file, "utf8"));
  state.updated_at = new Date(Date.now() - 2 * 3_600_000).toISOString();
  writeFileSync(file, JSON.stringify(state));
  const product = join(root, "repo/demo/target/build");
  await service.sweepTerminalRepos();
  assert.ok(existsSync(product));
  runtime.issue_build_products_cooldown_hours = 0;
  await service.sweepTerminalRepos();
  assert.ok(existsSync(product));
  runtime.issue_build_products_cooldown_hours = 1;
  await service.sweepTerminalRepos();
  assert.ok(!existsSync(product));
});

test("主回合、预热、辅助会话、容器命令、人工接管期间均不清理", async () => {
  for (const busy of ["turn", "warmup", "auxiliary", "exec", "takeover"]) {
    const { service, issuesRoot } = makeService();
    const root = fabricateIssue(issuesRoot, "issue-1", "waiting_user", { oldProducts: true });
    const state = JSON.parse(readFileSync(join(root, "issue.json"), "utf8"));
    const live: any = { root, id: state.id, state };
    (service as any).live.set(state.id, live);
    if (busy === "turn") (service as any).turning.add(state.id);
    if (busy === "warmup") live.warmupActive = true;
    if (busy === "exec") live.container = { hasActiveProcesses: true };
    if (busy === "takeover") state.takeover = {};
    if (busy === "auxiliary") trackAuxiliarySession(live, {} as any, auxiliarySessionEpoch(live));
    await service.sweepTerminalRepos();
    assert.ok(existsSync(join(root, "repo/demo/target/build")), busy);
  }
});

test("不沿符号链接删除工作区外内容", async () => {
  const { service, issuesRoot } = makeService();
  const root = fabricateIssue(issuesRoot, "issue-1", "waiting_user", { oldProducts: true });
  const external = mfcTemp("mfc-build-outside-");
  writeFileSync(join(external, "keep"), "external");
  symlinkSync(external, join(root, "repo/demo/target/obj"));
  await service.sweepTerminalRepos();
  assert.ok(existsSync(join(external, "keep")));
  assert.ok(existsSync(join(root, "repo/demo/target/obj")));
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
    .filter((line) => JSON.parse(line).kind === "workspace_reclaimed");
  assert.equal(events.length, 1, "事件只记一次");
});
