/**
 * 收据核对只在内核:Cloud 把刚读到的状态送去问 `delivery attest`。
 *
 * 这里原来是一份 TypeScript 镜像(收据归属、签名、投影形状、活动批次
 * 摘要)。2026-09-02 内核一改投影契约,镜像没跟上,三个 fail-closed 门
 * 恒假、整条持续检视链静默锁死——"同一契约两份实现"的实锤。收敛之后,
 * 本仓再没有一行可以和内核不一致的核对逻辑;这组用例证明的是:真内核
 * 真收据下,Cloud 问出来的答案和它原来自己算的一样,而且核对的是
 * 送去的快照而不是现场文件。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openKernelFeedback,
  trustedKernelHostActiveBatch,
  trustedKernelHostLifecycle,
} from "../src/kernelDelivery.ts";
import { sealPipelineLifecycle } from "./kernelHostFixture.ts";

const KERNEL_ROOT = join(process.cwd(), "kernel");
const HOST = { kernelRoot: KERNEL_ROOT };
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "attest", GIT_AUTHOR_EMAIL: "attest@example.com",
  GIT_COMMITTER_NAME: "attest", GIT_COMMITTER_EMAIL: "attest@example.com",
};

function watchingTask(label: string) {
  const data = mkdtempSync(join(tmpdir(), "mfc-attest-"));
  const workspace = join(data, `task-${label}`);
  const cwd = join(workspace, "repo");
  mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) => execFileSync(
    "git", ["-C", cwd, ...args], { encoding: "utf-8", env: GIT_ENV }).trim();
  git("init", "--quiet", "-b", "master");
  writeFileSync(join(cwd, "main.ts"), "export const ready = true;\n");
  git("add", "main.ts");
  git("commit", "--quiet", "-m", "baseline");
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    current: "delivery_watch", revision: 3,
    execution_contract: {
      schema: "mae-flow-execution/1", host: "cloud",
      compile: "pipeline", ut_write: "agent", ut_run: "pipeline",
      codecheck: "pipeline", git_push: "host",
      continuous_review: true, source: "order",
    },
    config: { "分支名": "feature", "基线分支": "master" },
    step_heads: { branch_create: head, delivery_watch: head },
    quality: { external_verification: { verdict: "PASS", sha: head } },
    history: [], initial_dirty: [],
  }));
  const taskId = `task-${label}`;
  sealPipelineLifecycle({ cwd, workspace, taskId, kernelRoot: KERNEL_ROOT });
  return { workspace, cwd, head, taskId };
}

const readState = (cwd: string) =>
  JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf-8"));

test("真收据背书的生命周期:内核说是;快照改一个字段:内核说不是", () => {
  const { cwd } = watchingTask("lifecycle");
  const state = readState(cwd);
  assert.equal(trustedKernelHostLifecycle({
    host: HOST, cwd, actions: ["pipeline-record"], state,
  }), true);
  // 问别的动作:没有那张收据,不拿流水线收据充数。
  assert.equal(trustedKernelHostLifecycle({
    host: HOST, cwd, actions: ["close"], state,
  }), false);
  // 核对的是送去的快照——现场文件没动,只改内存里这份,答案就变。
  const tampered = { ...state, current: "end" };
  assert.equal(trustedKernelHostLifecycle({
    host: HOST, cwd, actions: ["pipeline-record"], state: tampered,
  }), false);
  // 不传快照就读现场文件,和显式传一致。
  assert.equal(trustedKernelHostLifecycle({
    host: HOST, cwd, actions: ["pipeline-record"],
  }), true);
});

test("活动批次:批次正文一字不差才算,current 合法移动不影响", () => {
  const { workspace, cwd, head, taskId } = watchingTask("batch");
  openKernelFeedback({
    host: HOST, cwd, workspace,
    batch: {
      schema: "mae-flow-feedback-batch/1",
      batch_id: "fb-1", task_id: taskId, base_sha: head,
      opened_at: new Date().toISOString(),
      items: [{ id: "mr:d-1", source: "mr_discussion", source_id: "d-1",
        source_revision: 0, kind: "code_review", summary: "请补空值分支",
        verification: "reviewer" }],
    },
  });
  const opened = readState(cwd);
  assert.equal(opened.current, "feedback_triage");
  const moved = { ...opened, current: "build" };
  assert.equal(trustedKernelHostActiveBatch({
    host: HOST, cwd, actions: ["feedback-open"], state: moved,
  }), true, "Agent 合法推进 current 不影响活动批次背书");
  assert.equal(trustedKernelHostLifecycle({
    host: HOST, cwd, actions: ["feedback-open"], state: moved,
  }), false, "但整份生命周期就不再精确匹配");
  const rewritten = JSON.parse(JSON.stringify(moved));
  rewritten.delivery_loop.batches[0].items[0].summary = "改成别的意见";
  assert.equal(trustedKernelHostActiveBatch({
    host: HOST, cwd, actions: ["feedback-open"], state: rewritten,
  }), false, "批次正文被改:不再背书");
});

test("拿不到内核裁决(内核不存在)一律 false,不抛、不放行", () => {
  const { cwd } = watchingTask("dead");
  assert.equal(trustedKernelHostLifecycle({
    host: { kernelRoot: join(process.cwd(), "kernel-not-exists") },
    cwd, actions: ["pipeline-record"],
  }), false);
});

test("Cloud 源码里不再有一行收据核对逻辑", () => {
  const source = readFileSync(join(process.cwd(), "src", "kernelDelivery.ts"), "utf-8");
  for (const forbidden of [
    "mae-flow-host-lifecycle/", ".receipt-", "projection_digest",
    "kernelHostLifecycleProjection", "trustedKernelHostProjection",
  ]) {
    assert.equal(source.includes(forbidden), false,
      `kernelDelivery.ts 不该再出现 ${forbidden}:核对只在内核 delivery attest`);
  }
});
