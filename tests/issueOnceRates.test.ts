/**
 * 一次率二轴统计(#290 票4,口径:CONTEXT「一次修复成功率」「一次定位
 * 成功率」词条,2026-09-17)。两层钉死:
 * 1. 分类纯函数:分母=完成交付(有单+已归档+结论 delivered)——无单、
 *    非归档、归档但结论非 delivered(取消/失败/误报)一律不进;定位轴=报告版本数 ≤1(ADR-0032 起版本只随修改型检视
 *    增长,与检视批次数脱钩);修复轴=从未验证未通过(转移账平台文案
 *    前缀计数);检视批次逐条记账、不影响两轴判定。
 * 2. 真路由直调:GET /issues/stats 从服务台账聚合出同一口径(手搓
 *    响应对象,同 issueFlowErrors 的 seam 评审口径);报告版本数从
 *    分析报告版本账(初版=live 文件,修订版=reviews/ 快照)实读。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueOnceRates } from "../src/issueFlow/onceRates.ts";
import { VERIFY_FAIL_NOTE_PREFIX } from "../src/issueFlow/state.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { IssueOnceRateFacts } from "../src/issueFlow/onceRates.ts";

function facts(overrides: Partial<IssueOnceRateFacts> = {}): IssueOnceRateFacts {
  return {
    id: "issue-x", ticket: "DTS202609000001", status: "archived",
    conclusion_kind: "delivered",
    verify_fail_count: 0, report_version_count: 1, review_count: 0,
    ...overrides,
  };
}

test("纯函数:完成交付基线=两轴皆过(一版报告+零验证失败)", () => {
  const summary = issueOnceRates([facts()]);
  assert.equal(summary.total, 1);
  assert.equal(summary.localization.passed, 1);
  assert.equal(summary.repair.passed, 1);
  assert.equal(summary.localization.rate, 100);
});

test("纯函数:定位轴看版本数——多版本即非一次,与检视批次无关", () => {
  const reworked = issueOnceRates([facts({ report_version_count: 2 })]);
  assert.equal(reworked.localization.passed, 0);
  assert.equal(reworked.repair.passed, 1, "修复轴不受报告版本影响");
  assert.equal(issueOnceRates([facts({ report_version_count: 5 })])
    .localization.passed, 0);
  // 版本账缺席(0)按 ≤1 宽容:完成交付的会话理应有初版,坏账不虚构失败。
  assert.equal(issueOnceRates([facts({ report_version_count: 0 })])
    .localization.passed, 1);
});

test("纯函数:修复轴看验证失败——答过一次「验证发现问题」即非一次", () => {
  const summary = issueOnceRates([facts({ verify_fail_count: 1 })]);
  assert.equal(summary.repair.passed, 0);
  assert.equal(summary.localization.passed, 1, "定位轴不受验证回退影响");
});

test("纯函数:分母=完成交付;无单/非归档/结论非 delivered 全部排除", () => {
  const summary = issueOnceRates([
    facts({ id: "no-ticket", ticket: undefined }),
    facts({ id: "blank-ticket", ticket: "  " }),
    facts({ id: "canceled", status: "canceled" }),
    facts({ id: "failed", status: "failed" }),
    facts({ id: "idle", status: "idle" }),
    facts({ id: "no-conclusion", conclusion_kind: undefined }),
    facts({ id: "non-issue", conclusion_kind: "non_issue" }),
    facts({ id: "keep", review_count: 2 }),
  ]);
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.per_session.map((row) => row.id), ["keep"]);
});

test("纯函数:逐会话明细携带检视批次与两轴判定;空集比率 null", () => {
  const summary = issueOnceRates([
    facts({ id: "a", review_count: 2, report_version_count: 3,
      verify_fail_count: 1 }),
    facts({ id: "b" }),
  ]);
  assert.deepEqual(summary.per_session.map((row) => [
    row.id, row.reviews, row.localization_pass, row.repair_pass,
  ]), [["a", 2, false, false], ["b", 0, true, true]]);
  assert.deepEqual(issueOnceRates([]), {
    total: 0,
    localization: { passed: 0, rate: null },
    repair: { passed: 0, rate: null },
    per_session: [],
  });
});

// ---- 真路由:GET /issues/stats 从服务台账聚合 ----

const BASE_STATE = {
  account: "dev", created_at: "2026-09-01T08:00:00Z",
  updated_at: "2026-09-01T09:00:00Z", title: "t", description: "",
  source: "dts", scenario: "ticket", stage: "env_verify",
  stage_note: "", stage_at: "2026-09-01T09:00:00Z",
};

function seedSession(dataDir: string, state: Record<string, unknown>): void {
  const id = String(state.id);
  mkdirSync(join(dataDir, "issues", id), { recursive: true });
  writeFileSync(join(dataDir, "issues", id, "issue.json"),
    JSON.stringify({ ...BASE_STATE, ...state }));
}

function seedReport(dataDir: string, id: string, versions: number): void {
  const root = join(dataDir, "issues", id);
  mkdirSync(root, { recursive: true });
  // live 报告=初版;reviews/ 快照内容互不相同且与 live 不同,才各成一版。
  writeFileSync(join(root, "issue-analysis.md"), `# v${versions} live\n`);
  for (let index = 0; index < versions - 1; index += 1) {
    const dir = join(root, "reviews");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `issue-analysis@r${(index + 1).toString(36)}.md`),
      `# snapshot ${index}\n`);
  }
}

function seedReviews(dataDir: string, id: string, batches: number): void {
  if (!batches) return;
  const root = join(dataDir, "issues", id);
  mkdirSync(root, { recursive: true });
  // 检视账本住会话根(reviews.jsonl),与 reviews/ 快照目录是两回事。
  const lines = Array.from({ length: batches }, (_, index) =>
    JSON.stringify({ op: "sent", ids: [`an-${index}`],
      via: "issue_review", at: "2026-09-01T09:00:00Z", by: "dev" }));
  writeFileSync(join(root, "reviews.jsonl"), lines.join("\n") + "\n");
}

test("路由 GET /issues/stats:二轴聚合,分母只认完成交付", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-oncerate-"));
  const failTransition = (reason: string) => ({
    at: "2026-09-01T09:00:00Z", source: "platform",
    note: `${VERIFY_FAIL_NOTE_PREFIX}:${reason}`,
  });
  const delivered = { conclusion: { kind: "delivered",
    summary: "s", at: "2026-09-01T10:00:00Z" } };
  seedSession(dataDir, { id: "issue-a", ticket: "DTS202609000001",
    status: "archived", ...delivered });
  seedReport(dataDir, "issue-a", 1);
  seedSession(dataDir, { id: "issue-b", ticket: "DTS202609000002",
    status: "archived", ...delivered,
    transitions: [failTransition("仍复现")] });
  seedReport(dataDir, "issue-b", 2);
  seedReviews(dataDir, "issue-b", 2);
  seedSession(dataDir, { id: "issue-c", ticket: "DTS202609000003",
    status: "archived", ...delivered });
  seedReport(dataDir, "issue-c", 3);
  seedSession(dataDir, { id: "issue-d", ticket: "DTS202609000004",
    status: "canceled" });
  seedSession(dataDir, { id: "issue-e", ticket: "DTS202609000005",
    status: "archived",
    conclusion: { kind: "non_issue", summary: "误报",
      at: "2026-09-01T10:00:00Z" } });
  // 存量未合入的手动归档:旧账记 fixed(ADR-0022 时代的口径),读侧
  // 归一为 delivered(ADR-0037)——修复完成即交付,照进分母。
  seedSession(dataDir, { id: "issue-g", ticket: "DTS202609000006",
    status: "archived",
    conclusion: { kind: "fixed", summary: "已推送未合入",
      at: "2026-09-01T10:00:00Z" } });
  seedReport(dataDir, "issue-g", 1);
  seedSession(dataDir, { id: "issue-f", status: "archived", ...delivered });

  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    let status = 0;
    let body: Record<string, unknown> = {};
    await handleIssueRoutes(
      { method: "GET", url: "/issues/stats" } as never,
      {
        writeHead: (code: number) => { status = code; },
        end: (output?: string | Buffer) => {
          body = JSON.parse(Buffer.isBuffer(output)
            ? output.toString("utf-8") : output ?? "{}");
        },
      } as never,
      ["issues", "stats"],
      { issueFlow: service, authEnabled: false },
    );
    assert.equal(status, 200);
    assert.equal(body.total, 4,
      "分母=a/b/c/g;g 的存量 fixed 旧账读侧归一为 delivered,取消 d、"
      + "误报 e、无单 f 不进");
    assert.deepEqual(body.localization, { passed: 2, rate: 50 },
      "一版报告的 issue-a/g 一次定位;b 两版、c 三版不是");
    assert.deepEqual(body.repair, { passed: 3, rate: 75 },
      "a/c/g 零验证失败;b 答过一次验证未通过");
    const rows = body.per_session as Array<
      { id: string; reviews: number }>;
    assert.equal(rows.find((row) => row.id === "issue-b")?.reviews, 2,
      "检视批次从 reviews 账本 sent/issue_review 计,能力不回退");
    assert.equal(rows.length, 4, "逐会话明细只含分母会话");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});
