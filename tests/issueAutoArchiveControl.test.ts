/**
 * 归档门禁(ADR-0034,#290 票3):有单一律不再手动归档(合入自动归档
 * 是唯一交付出口);无单给出结论前不能归档(挂起待转正是唯一可手动
 * 归档的无单现场);取消不受影响。种子会话直调 service.control,
 * 不起长轴(门禁是纯裁决,不依赖流程推进)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { mfcTemp } from "./mfcTmp.ts";

const BASE = {
  account: "dev", created_at: "2026-09-01T08:00:00Z",
  updated_at: "2026-09-01T09:00:00Z", title: "t", description: "",
  source: "manual" as const, stage: "fix", stage_note: "",
  stage_at: "2026-09-01T09:00:00Z",
};

async function controlScene(
  seed: Record<string, unknown>,
): Promise<{ id: string; service: IssueFlowService; stop: () => Promise<void> }> {
  const dataDir = mfcTemp("mfc-issue-archgate-");
  mkdirSync(join(dataDir, "issues", "issue-1"), { recursive: true });
  writeFileSync(join(dataDir, "issues", "issue-1", "issue.json"),
    JSON.stringify({ id: "issue-1", ...BASE, ...seed }));
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  return {
    id: "issue-1", service,
    stop: () => service.shutdown().catch(() => undefined),
  };
}

test("有单会话:手动归档一律拒绝,指路自动归档与取消", async () => {
  const scene = await controlScene({
    ticket: "DTS202609000001", scenario: "ticket", status: "idle",
  });
  try {
    await assert.rejects(
      () => scene.service.control(scene.id, { action: "archive" }),
      /不再手动归档/,
    );
    const summary = await scene.service.control(scene.id,
      { action: "cancel" });
    assert.equal(summary.status, "canceled", "取消出口不受影响");
  } finally {
    await scene.stop();
  }
});

test("无单会话:给出结论前不能归档,挂起(结论已给)可归档记 issue", async () => {
  const early = await controlScene({ scenario: "no_ticket", status: "idle" });
  try {
    await assert.rejects(
      () => early.service.control(early.id, { action: "archive" }),
      /给出结论|结论.*后/,
    );
  } finally {
    await early.stop();
  }

  const suspended = await controlScene({
    scenario: "no_ticket", status: "suspended", stage: "conclude",
  });
  try {
    const summary = await suspended.service.control(suspended.id,
      { action: "archive" });
    assert.equal(summary.status, "archived");
    assert.equal(summary.conclusion?.kind, "issue",
      "挂起会话归档,结论=问题成立");
  } finally {
    await suspended.stop();
  }
});
