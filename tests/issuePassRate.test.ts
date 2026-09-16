/**
 * 一次通过率统计(spec #274,口径:CONTEXT「一次通过率」词条
 * 2026-09-16)。两层钉死:
 * 1. 分类纯函数:判定矩阵(终态×验证作答)全分支直跑——分母=有单+
 *    终态(归档/取消/失败);一次通过=归档且验证卡从未答过 fail
 *    (未答卡归档=用户认可收口,与答过 pass 归档在事实层同形,刻意);
 *    取消/失败一律非一次(答过 pass 再取消也按取消口径);无单与非
 *    终态不进分母;检视批次只记账不参与判定。
 * 2. 真路由直调:GET /issues/stats 从服务台账聚合出同一口径(手搓
 *    响应对象,同 issueFlowErrors 的 seam 评审口径);转移账种子用
 *    state.ts 的平台文案常量,钉住"聚合按前缀取验证事实"的接线。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issuePassRate } from "../src/issueFlow/passRate.ts";
import { VERIFY_FAIL_NOTE_PREFIX } from "../src/issueFlow/state.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { IssuePassRateFacts } from "../src/issueFlow/passRate.ts";

function facts(overrides: Partial<IssuePassRateFacts> = {}): IssuePassRateFacts {
  return {
    id: "issue-x", ticket: "DTS202609000001", status: "archived",
    verify_fail_count: 0, review_count: 0, ...overrides,
  };
}

test("纯函数:归档且零验证失败=一次通过,含从未答卡的归档(归档即认可)", () => {
  assert.equal(issuePassRate([facts()]).passed, 1);
  assert.equal(issuePassRate([facts()]).total, 1);
  assert.equal(issuePassRate([facts()]).rate, 100);
});

test("纯函数:验证卡答过 fail(哪怕后来过了再归档)=非一次", () => {
  const summary = issuePassRate([facts({ verify_fail_count: 1 })]);
  assert.equal(summary.passed, 0);
  assert.equal(summary.per_session[0].first_pass, false);
  assert.equal(issuePassRate([facts({ verify_fail_count: 3 })]).passed, 0);
});

test("纯函数:取消与失败一律非一次(答过 pass 未归档就取消同理)", () => {
  assert.equal(issuePassRate([facts({ status: "canceled" })]).passed, 0);
  assert.equal(issuePassRate([facts({ status: "failed" })]).passed, 0);
  const canceled = issuePassRate([facts({ status: "canceled" })]);
  assert.equal(canceled.per_session[0].first_pass, false);
});

test("纯函数:无单不进分母,非终态不进分母", () => {
  const summary = issuePassRate([
    facts({ id: "a", ticket: undefined }),
    facts({ id: "b", ticket: "" }),
    facts({ id: "c", ticket: "   " }),
    facts({ id: "d", status: "running" }),
    facts({ id: "e", status: "queued" }),
    facts({ id: "f", status: "waiting_user" }),
    facts({ id: "g", status: "idle" }),
    facts({ id: "h", status: "suspended" }),
    facts({ id: "keep", status: "canceled" }),
  ]);
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.per_session.map((row) => row.id), ["keep"]);
});

test("纯函数:检视批次逐条记账、不影响一次判定", () => {
  const summary = issuePassRate([
    facts({ id: "a", review_count: 2, verify_fail_count: 1 }),
    facts({ id: "b", review_count: 0 }),
  ]);
  assert.deepEqual(
    summary.per_session.map((row) => [row.id, row.reviews, row.first_pass]),
    [["a", 2, false], ["b", 0, true]]);
});

test("纯函数:空集与全排除=分母 0、rate 为 null(前端显示 —)", () => {
  assert.deepEqual(issuePassRate([]),
    { passed: 0, total: 0, rate: null, per_session: [] });
  const excluded = issuePassRate([facts({ ticket: "" })]);
  assert.equal(excluded.total, 0);
  assert.equal(excluded.rate, null);
});

// ---- 真路由:GET /issues/stats 从服务台账聚合 ----

/** 最小 issue.json 种子(字段同 issueFlowErrors.seedSuspendedSession)。 */
function seedSession(dataDir: string, state: Record<string, unknown>): void {
  const id = String(state.id);
  mkdirSync(join(dataDir, "issues", id), { recursive: true });
  writeFileSync(join(dataDir, "issues", id, "issue.json"),
    JSON.stringify({
      account: "dev", created_at: "2026-09-01T08:00:00Z",
      updated_at: "2026-09-01T09:00:00Z", title: "t", description: "",
      source: "dts", scenario: "ticket", stage: "env_verify",
      stage_note: "", stage_at: "2026-09-01T09:00:00Z",
      ...state,
    }));
}

function seedReviews(dataDir: string, id: string, batches: number): void {
  if (!batches) return;
  mkdirSync(join(dataDir, "issues", id), { recursive: true });
  const lines = Array.from({ length: batches }, (_, index) =>
    JSON.stringify({ op: "sent", ids: [`an-${index}`],
      via: "issue_review", at: "2026-09-01T09:00:00Z", by: "dev" }));
  writeFileSync(join(dataDir, "issues", id, "reviews.jsonl"),
    lines.join("\n") + "\n");
}

test("路由 GET /issues/stats:全台账聚合一次通过率与检视批次数", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-passrate-"));
  const failTransition = (reason: string) => ({
    at: "2026-09-01T09:00:00Z", source: "platform",
    note: `${VERIFY_FAIL_NOTE_PREFIX}:${reason}`,
  });
  seedSession(dataDir, { id: "issue-a", ticket: "DTS202609000001",
    status: "archived" });
  seedSession(dataDir, { id: "issue-b", ticket: "DTS202609000002",
    status: "archived",
    transitions: [failTransition("仍复现"), failTransition("新问题")] });
  seedReviews(dataDir, "issue-b", 2);
  seedSession(dataDir, { id: "issue-c", ticket: "DTS202609000003",
    status: "canceled" });
  seedSession(dataDir, { id: "issue-d", ticket: "DTS202609000004",
    status: "failed" });
  seedSession(dataDir, { id: "issue-e", scenario: "no_ticket",
    status: "archived" });
  seedSession(dataDir, { id: "issue-f", ticket: "DTS202609000005",
    status: "idle" });
  seedReviews(dataDir, "issue-f", 1);

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
    assert.equal(body.passed, 1, "只有零验证失败且归档的 issue-a 一次通过");
    assert.equal(body.total, 4, "分母=有单终态(a/b/c/d);无单 e、非终态 f 不进");
    assert.equal(body.rate, 25);
    const rows = body.per_session as Array<
      { id: string; first_pass: boolean; reviews: number }>;
    assert.deepEqual(rows.map((row) => [row.id, row.first_pass]), [
      ["issue-a", true], ["issue-b", false],
      ["issue-c", false], ["issue-d", false],
    ]);
    assert.equal(rows.find((row) => row.id === "issue-b")?.reviews, 2,
      "检视批次从 reviews 账本 sent/issue_review 计");
    assert.equal(rows.find((row) => row.id === "issue-f"), undefined,
      "非终态会话不进逐条明细");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});
