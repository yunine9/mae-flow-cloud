import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { PipelineRun } from "../src/pipelineClient.ts";
import type { IssuePipelineWatch } from "../src/issueFlow/state.ts";
import { seedMrGreenWatch, until } from "./issueFlowFixed.helpers.ts";
import { mfcTemp } from "./mfcTmp.ts";

const repo = "https://example.test/son.git";
const sha = "c".repeat(40);
const red: PipelineRun = { status: "failed", log: "DT=1(期望=0)",
  checks: [{ dimension: "UT", status: "failed", tool: "CPP_UT" }] };
const coverage = { name: "codecheck_detail.json", text: JSON.stringify({ defects: [
  { indicatorName: "clike diff coverage rate(%)", actualValue: "0.0", threshold: 70 },
] }) };

async function fixture(reply: (attempt: number) => { status?: number; files?: typeof coverage[] },
  budgetMs = 500, watch: Partial<IssuePipelineWatch> = {}) {
  const dataDir = mfcTemp("mfc-issue-evidence-retry-");
  seedMrGreenWatch(dataDir, repo, { watching: false, ...watch });
  let attempts = 0;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const body = request.url?.startsWith("/pipeline/artifacts") ? reply(++attempts) : {};
    response.writeHead("status" in body ? body.status ?? 200 : 200,
      { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const service: any = new IssueFlowService({ dataDir, provider: "fixture", model: "fixture",
    modelsJson: {}, deferRecovery: true,
    platformUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    settings: { models: () => ({}), runtime: () => ({ poll_timeout_s: budgetMs / 1000 }) },
  });
  const prompts: string[] = [];
  service.watchMergeStates = () => {};
  service.watchMrDiscussions = () => {};
  service.startPlatformTurn = (_live: unknown, prompt: string) => prompts.push(prompt);
  service.pipelineEvidenceDelayMs = () => 5;
  service.start();
  const live = service.live.get("issue-1");
  return { service, live, prompts, requests, attempts: () => attempts,
    settle: (run = red) => service.settlePipeline(live, repo, sha, run),
    disk: () => JSON.parse(readFileSync(join(live.root, "issue.json"), "utf8")),
    async stop() { await service.shutdown(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test("#578 瞬时产物失败后自动重试，取证期间不发回合、不扣轮次", async () => {
  let observedRetry = false;
  const f = await fixture(attempt => {
    if (attempt === 1) return { status: 502 };
    observedRetry = true;
    assert.equal(f.prompts.length, 0);
    assert.equal(f.live.state.pipelines[repo].reds ?? 0, 0);
    assert.equal(f.disk().pipelines[repo].watching, true, "重启可继续取证");
    return { files: [coverage] };
  });
  try {
    await f.settle();
    assert.equal(observedRetry, true, "一次失败不能直接交给用户贴报错");
    assert.equal(f.attempts(), 2);
    assert.equal(f.prompts.length, 1);
    assert.equal(f.live.state.pipelines[repo].reds, 1);
    assert.match(f.prompts[0], /clike diff coverage rate/);
    assert.match(f.prompts[0], /0\.0/);
    assert.match(f.prompts[0], /70/);
    assert.equal(f.live.state.gate, undefined);
  } finally { await f.stop(); }
});

test("#578 持续缺证到期才交 Agent 举卡，提供缺失维度和上游原因", async () => {
  const f = await fixture(() => ({ files: [{ name: "pipeline_log_summary.json",
    text: JSON.stringify({ strategies: { coverage: { status: "failed", note: "coverage HTTP 502" } } }),
  }] }), 100);
  try {
    await f.settle();
    assert.ok(f.attempts() > 1);
    assert.equal(f.prompts.length, 1);
    assert.match(f.prompts[0], /取证重试已到期/);
    assert.match(f.prompts[0], /UT\/覆盖率.*coverage HTTP 502/s);
    assert.match(f.prompts[0], /pipeline_evidence/);
  } finally { await f.stop(); }
});

test("#578 部分维度有证据立即交付，缺失维度单独说明", async () => {
  const f = await fixture(() => ({ files: [coverage] }));
  try {
    await f.settle({ ...red, checks: [...red.checks!, { dimension: "COMPILE", status: "failed" }] });
    assert.equal(f.attempts(), 1);
    assert.match(f.prompts[0], /编译\/构建 红灯，但没有可定位的具体报错/);
    assert.match(f.prompts[0], /UT\/覆盖率.*codecheck_detail/s);
  } finally { await f.stop(); }
});

for (const change of ["cancel", "replace", "epoch", "merged"] as const) {
  test(`#578 镜像请求期间 ${change}，旧结果不得发回合或消耗轮次`, async () => {
    const f = await fixture(() => {
      if (change === "cancel") f.live.state.status = "canceled";
      if (change === "replace") f.live.state.pipelines[repo] = {
        ...f.live.state.pipelines[repo], sha: "d".repeat(40), reds: 0,
      };
      if (change === "epoch") f.live.controlEpoch++;
      if (change === "merged") f.live.state.mrs[0].merged_at = new Date().toISOString();
      return { files: [coverage] };
    });
    try {
      await f.settle();
      assert.equal(f.prompts.length, 0);
      assert.equal(f.live.state.pipelines[repo].reds ?? 0, 0);
    } finally { await f.stop(); }
  });
}

test("#578 进程恢复保留取证截止时间，到期直接发送缺口且不触发流水线", async () => {
  const deadline = new Date(Date.now() - 1000).toISOString();
  let seenDeadline: string | undefined;
  const f = await fixture(() => {
    seenDeadline = f.disk().pipelines[repo].evidence_retry_deadline;
    return { files: [] };
  }, 500, { status: "failed", watching: true, checks: red.checks,
    evidence_retry_deadline: deadline, evidence_retry_attempts: 2, evidence_failure_log: red.log });
  try {
    await until(() => f.prompts.length || undefined, "恢复取证到期后发送缺口", 2000);
    assert.equal(seenDeadline, deadline);
    assert.equal(f.attempts(), 1, "已到期不能重开重试预算");
    assert.equal(f.requests.some(url => url.startsWith("/pipeline/trigger")), false);
    assert.match(f.prompts[0], /取证重试已到期/);
    assert.equal(f.live.state.pipelines[repo].reds, 1);
  } finally { await f.stop(); }
});

test("#578 摘要已有编译错误时不等待产物，直接进入修复", async () => {
  const f = await fixture(() => ({ status: 502 }));
  try {
    await f.settle({ status: "failed", log: "src/main.cpp:12: error: missing member",
      checks: [{ dimension: "COMPILE", status: "failed" }] });
    assert.equal(f.attempts(), 1);
    assert.equal(f.prompts.length, 1);
    assert.match(f.prompts[0], /流水线终态失败摘要/);
  } finally { await f.stop(); }
});
