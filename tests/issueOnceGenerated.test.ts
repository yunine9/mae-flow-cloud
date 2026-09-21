/**
 * 一次生成达标率读侧与呈现(工单 #338/#340,ADR-0044):
 * 1. GET /issues/once-generated 分母三态——有数据(伴生在场且留存
 *    源码行>0)/待算(支持期内终态、伴生缺席)/不支持期(起算日期前
 *    终态,永不回填);达标线缺省与逐会话明细;非完成交付(取消/误报)
 *    一律不进;
 * 2. GET /issues/:id/code-origin 伴生原样返回,缺席如实 404;
 * 3. web 侧特性聚合纯函数 onceGeneratedFeatureRows:归组/加权占比/
 *    达标率/排序/空白归「未分类」。
 *
 * 范式:issueOnceRates 的种子现场直写 issue.json + 服务构造恢复路径,
 * 只走公开路由断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { onceGeneratedFeatureRows } from "../web/src/teamOps.ts";

const BASE_STATE = {
  account: "dev", created_at: "2026-09-20T08:00:00Z",
  updated_at: "2026-09-20T09:00:00Z", title: "t", description: "",
  source: "dts", scenario: "ticket", stage: "mr_green",
  stage_note: "", stage_at: "2026-09-20T09:00:00Z",
};

const DELIVERED_SINCE = {
  status: "archived",
  conclusion: { kind: "delivered", summary: "s", at: "2026-09-20T10:00:00Z" },
};

function seedSession(dataDir: string, state: Record<string, unknown>): void {
  const id = String(state.id);
  mkdirSync(join(dataDir, "issues", id), { recursive: true });
  writeFileSync(join(dataDir, "issues", id, "issue.json"),
    JSON.stringify({ ticket: "DTS202609000001", ...BASE_STATE, ...state }));
}

/** 手工冻结一份伴生快照(行数可指定;head/base 造假无妨——读侧不碰
 *  Git,只做投影聚合)。 */
function seedCompanion(dataDir: string, id: string, lines: {
  first: number; rework: number; external: number;
}): void {
  writeFileSync(join(dataDir, "issues", id, "code-origin.json"),
    JSON.stringify({
      schema_version: 2,
      generated_at: "2026-09-20T11:00:00.000Z",
      session_id: id,
      by_repo: [{
        repo: "https://git/example.git", branch: "master_dev_DTS1",
        head: "a".repeat(40), head_basis: "merged_sha", base: "b".repeat(40),
        boundary: null, lines, commits: [],
      }],
    }, null, 1));
}

async function callRoute(service: IssueFlowService, url: string,
  parts: string[]): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let body: Record<string, unknown> = {};
  await handleIssueRoutes(
    { method: "GET", url } as never,
    {
      writeHead: (code: number) => { status = code; },
      end: (output?: string | Buffer) => {
        body = JSON.parse(Buffer.isBuffer(output)
          ? output.toString("utf-8") : output ?? "{}");
      },
    } as never,
    parts,
    { issueFlow: service, authEnabled: false },
  );
  return { status, body };
}

test("路由 once-generated:分母三态与达标判定,非完成交付不进", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-oncegen-"));
  // 有数据:占比 90(线 90,恰达标)与 50(不达标)。
  seedSession(dataDir, { id: "issue-a", ...DELIVERED_SINCE });
  seedCompanion(dataDir, "issue-a",
    { first: 90, rework: 5, external: 5 });
  seedSession(dataDir, { id: "issue-b", ...DELIVERED_SINCE,
    conclusion: { kind: "delivered", summary: "s", at: "2026-09-20T12:00:00Z" } });
  seedCompanion(dataDir, "issue-b",
    { first: 50, rework: 40, external: 10 });
  // 待算:支持期内终态、伴生缺席(通道在途或曾丢失)。
  seedSession(dataDir, { id: "issue-c", ...DELIVERED_SINCE });
  // 不支持期:起算日期前终态的存量会话,永不回填。
  seedSession(dataDir, { id: "issue-d", status: "archived",
    conclusion: { kind: "delivered", summary: "s", at: "2026-09-19T23:00:00Z" } });
  // 无源码交付:伴生在场但留存源码行 0,不进分母。
  seedSession(dataDir, { id: "issue-e", ...DELIVERED_SINCE });
  seedCompanion(dataDir, "issue-e", { first: 0, rework: 0, external: 0 });
  // 非完成交付:取消/误报一律不进(伴生在场也不进)。
  seedSession(dataDir, { id: "issue-f", status: "canceled",
    ticket: undefined });
  seedSession(dataDir, { id: "issue-g", status: "archived",
    conclusion: { kind: "non_issue", summary: "误报", at: "2026-09-20T10:00:00Z" } });

  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const { status, body } = await callRoute(service,
      "/issues/once-generated", ["issues", "once-generated"]);
    assert.equal(status, 200);
    assert.equal(body.threshold_percent, 90, "达标线缺省 90(参数)");
    assert.equal(body.supported_since, "2026-09-20");
    assert.equal(body.total, 2, "分母=issue-a/b(issue-e 无源码行不进)");
    assert.equal(body.passed, 1, "占比恰 90 判达标,50 不达标");
    assert.equal(body.rate, 50);
    assert.equal(body.pending, 1, "issue-c 待算");
    assert.equal(body.unsupported, 1, "issue-d 早于起算日");
    assert.equal(body.no_code, 1, "issue-e 无源码交付");
    // 三根过程率轴与 /issues/stats 同源:分母=完成交付全集(a/b/c/d/e,
    // 不随伴生在缺漂移);种子都没有报告账与验证失败 → 双轴满分、解决满分。
    assert.deepEqual(body.localization, { passed: 5, total: 5, rate: 100 });
    assert.deepEqual(body.verify, { passed: 5, total: 5, rate: 100 });
    assert.deepEqual(body.solved, { passed: 5, total: 5, rate: 100 });
    const repoRows = body.by_repo as Array<{
      repo: string; sessions: number; first: number; total: number; share: number | null;
    }>;
    assert.equal(repoRows.length, 1, "同仓跨会话归组");
    const repoRow = repoRows[0]!;
    assert.equal(repoRow.sessions, 2, "多会话按仓各计一次");
    assert.equal(repoRow.first, 140);
    assert.equal(repoRow.total, 200);
    assert.equal(repoRow.share, 70);
    const rows = body.per_session as Array<{
      id: string; state: string; module: string; share?: number; pass?: boolean;
      localization_pass: boolean; verify_pass: boolean; solved_pass: boolean;
    }>;
    assert.deepEqual(rows.map((row) => row.id), ["issue-b", "issue-a", "issue-c", "issue-e", "issue-d"],
      "per_session 覆盖范围内全部完成交付会话,按收口时刻倒序");
    assert.deepEqual(rows.map((row) => row.state),
      ["ok", "ok", "pending", "no_code", "unsupported"]);
    assert.equal(rows.find((row) => row.id === "issue-a")?.module, "未分类",
      "模块标签空白归「未分类」");
    assert.equal(rows.find((row) => row.id === "issue-a")?.pass, true);
    assert.equal(rows.find((row) => row.id === "issue-a")?.solved_pass, true);
    assert.equal(rows.find((row) => row.id === "issue-b")?.solved_pass, true);
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("路由 code-origin:伴生原样返回;缺席如实 404", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-oncegen-"));
  seedSession(dataDir, { id: "issue-a", ...DELIVERED_SINCE });
  seedCompanion(dataDir, "issue-a", { first: 90, rework: 5, external: 5 });
  seedSession(dataDir, { id: "issue-c", ...DELIVERED_SINCE });
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const ok = await callRoute(service, "/issues/issue-a/code-origin",
      ["issues", "issue-a", "code-origin"]);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.session_id, "issue-a");
    const byRepo = ok.body.by_repo as Array<{ lines: { first: number } }>;
    assert.equal(byRepo[0]!.lines.first, 90);

    const missing = await callRoute(service, "/issues/issue-c/code-origin",
      ["issues", "issue-c", "code-origin"]);
    assert.equal(missing.status, 404, "伴生缺席(未算完)不猜不补");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("onceGeneratedFeatureRows:归组/加权占比/达标率/排序/空白归未分类", () => {
  const rows = onceGeneratedFeatureRows([
    { module: "网关", share: 95, pass: true, localization_pass: false,
      verify_pass: true, solved_pass: false,
      lines: { first: 90, rework: 5, external: 5 } },
    { module: "网关", share: 50, pass: false, localization_pass: true,
      verify_pass: true, solved_pass: false,
      lines: { first: 50, rework: 50, external: 0 } },
    { module: "  ", share: 100, pass: true, localization_pass: true,
      verify_pass: true, solved_pass: true,
      lines: { first: 40, rework: 0, external: 0 } },
    { module: "计费", share: 30, pass: false, localization_pass: true,
      verify_pass: false, solved_pass: false,
      lines: { first: 30, rework: 60, external: 10 } },
  ]);
  assert.deepEqual(rows, [
    {
      module: "网关", sessions: 2, pass_rate: 50,
      solved_rate: 0, localization_rate: 50, verify_rate: 100,
      share: 70, total_lines: 200,
    },
    {
      module: "计费", sessions: 1, pass_rate: 0,
      solved_rate: 0, localization_rate: 100, verify_rate: 0,
      share: 30, total_lines: 100,
    },
    {
      module: "未分类", sessions: 1, pass_rate: 100,
      solved_rate: 100, localization_rate: 100, verify_rate: 100,
      share: 100, total_lines: 40,
    },
  ], "排序:会话数降序 → 工作行降序(计费 100 行在未分类 40 行前)→ 名称;解决率=定位∧验证");
  assert.deepEqual(onceGeneratedFeatureRows([]), []);
});

test("onceGeneratedFeatureRows:share/lines 缺失的行不崩不进聚合(#353)", () => {
  // 真实形状:state 非 ok 的行(pending/no_code/unsupported)不带
  // share/lines;旧前端把它们喂进聚合曾是白屏崩溃点。两个守卫分支
  // (share 缺席、lines 缺席)都必须整行跳过,不计会话数。
  const rows = onceGeneratedFeatureRows([
    { module: "网关", share: 95, pass: true, localization_pass: true,
      verify_pass: true, solved_pass: true,
      lines: { first: 90, rework: 5, external: 5 } },
    { module: "网关", localization_pass: false, verify_pass: false,
      solved_pass: false },
    { module: "计费", share: 40, pass: false, localization_pass: true,
      verify_pass: false, solved_pass: false },
  ]);
  assert.deepEqual(rows, [{
    module: "网关", sessions: 1, solved_rate: 100, pass_rate: 100,
    localization_rate: 100, verify_rate: 100,
    share: 90, total_lines: 100,
  }], "只聚合 share 与 lines 都在场的行;share 由工作行重算(90/100),不取入参");
});
