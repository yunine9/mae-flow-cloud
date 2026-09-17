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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  closeKernelDelivery,
  controlKernelFeedback,
  recordKernelPublishedPush,
  KERNEL_UNAVAILABLE,
  KernelUnavailableError,
  openKernelFeedback,
  reconcileKernelDeliverySelection,
  recordKernelFeedbackResult,
  trustedKernelHostFeedback,
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

function watchingTask(label: string, seal = true) {
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
  if (seal) sealPipelineLifecycle({ cwd, workspace, taskId, kernelRoot: KERNEL_ROOT });
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

test("内核脚本缺失是核验不可用，不冒充没有授权", () => {
  const { cwd } = watchingTask("dead");
  assert.throws(() => trustedKernelHostLifecycle({
    host: { kernelRoot: join(process.cwd(), "kernel-not-exists") },
    cwd, actions: ["pipeline-record"],
  }), KernelUnavailableError);
});

test("内核根本没答(起不来且三次重试用尽):抛 KernelUnavailableError,不是 false", () => {
  const { cwd } = watchingTask("unavailable");
  const dir = join(cwd, "..");
  const script = join(dir, "always-dies.sh");
  writeFileSync(script, "#!/bin/sh\nkill -KILL $$\n");
  chmodSync(script, 0o755);
  assert.throws(() => trustedKernelHostLifecycle({
    host: { kernelRoot: KERNEL_ROOT, python: script },
    cwd, actions: ["pipeline-record"],
  }), (error: unknown) => error instanceof KernelUnavailableError
    && error.message.startsWith(KERNEL_UNAVAILABLE)
    && /已重试 3 次仍不可用/.test(error.message));
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

test("拒绝领域归档后由内核原子重建归档、Manifest 与修复授权", () => {
  const { workspace, cwd, head, taskId } = watchingTask("selection-archive");
  const state = readState(cwd);
  state.config["单号"] = "REQ-ARCHIVE-1";
  state.domain_archive = {
    status: "applied", result: "changes", domains: [], input_sha256: "old",
    applied_paths: ["docs/specs/index.md", "docs/specs/radio.md"],
  };
  state.delivery_manifest = {
    files: ["main.ts", "docs/specs/index.md", "docs/specs/radio.md"],
    commit_message: "[REQ][fix] result", target_branch: "master",
    adopted_dirty: {}, confirmed: true,
  };
  state.delivery_repair_authorization = {
    schema: "mae-flow-feedback-repair/1", status: "ready",
    baseline_dirty: ["docs/specs/radio.md", "user.txt"],
    allowed_paths: ["docs/specs/radio.md"],
  };
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify(state));

  reconcileKernelDeliverySelection({
    host: HOST, cwd, workspace, taskId, waitingId: "review-9", head,
    paths: ["main.ts"],
    excludedPaths: ["docs/specs/index.md", "docs/specs/radio.md"],
    actor: "owner.liao",
  });
  const reconciled = readState(cwd);
  assert.equal(reconciled.domain_archive.result, "unchanged");
  assert.deepEqual(reconciled.domain_archive.applied_paths, []);
  assert.deepEqual(reconciled.domain_archive.declined_paths,
    ["docs/specs/index.md", "docs/specs/radio.md"]);
  assert.deepEqual(reconciled.delivery_manifest.files, ["main.ts"]);
  assert.equal(reconciled.delivery_manifest.confirmed, true);
  assert.deepEqual(reconciled.delivery_repair_authorization.baseline_dirty,
    ["user.txt"]);
  assert.equal(trustedKernelHostLifecycle({
    host: HOST, cwd, actions: ["selection-reconcile"], state: reconciled,
  }), true);
});

test("人工选择重排保留原确认；部分排除不把归档凭证变成内容变化", () => {
  const { workspace, cwd, head, taskId } = watchingTask("selection-replay");
  const state = readState(cwd);
  state.domain_archive = {
    status: "applied", result: "unchanged", domains: [], changed_paths: [],
    applied_paths: ["docs/specs/index.md", "docs/specs/radio.md"],
    reapply_paths: ["docs/specs/index.md", "docs/specs/radio.md"],
  };
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify(state));
  const selection = {
    host: HOST, cwd, workspace, taskId, waitingId: "review-replay", head,
    paths: ["main.ts", "docs/specs/radio.md"],
    excludedPaths: ["user.txt", "docs/specs/index.md"], actor: "owner.liao",
  };
  reconcileKernelDeliverySelection(selection);
  const first = readState(cwd);
  assert.equal(first.domain_archive.result, "unchanged");
  assert.deepEqual(first.domain_archive.changed_paths, []);
  assert.deepEqual(first.domain_archive.applied_paths, ["docs/specs/radio.md"]);
  assert.deepEqual(first.domain_archive.reapply_paths, ["docs/specs/radio.md"]);
  reconcileKernelDeliverySelection({ ...selection,
    paths: [...selection.paths].reverse(), excludedPaths: [...selection.excludedPaths].reverse(),
  });
  const replayed = readState(cwd);
  for (const key of ["delivery_selection", "delivery_manifest", "domain_archive", "history"]) {
    assert.deepEqual(replayed[key], first[key], key);
  }
  assert.equal(trustedKernelHostLifecycle({
    host: HOST, cwd, actions: ["selection-reconcile"], state: replayed,
  }), true);
});


test("重启恢复真实签名的待落盘收据；未保存的 nonce 和篡改投影不能恢复", () => {
  const { cwd, workspace } = watchingTask("recover-receipt");
  const state = readState(cwd);
  const root = join(dirname(workspace), ".host-capabilities");
  const path = join(root, readdirSync(root).find(n => n.includes(".receipt-") && n.endsWith(".json"))!);
  const staged = path + ".staged";
  renameSync(path, staged);
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({ ...state, host_capability_nonces: [] }));
  const query = () => trustedKernelHostLifecycle({ host: HOST, cwd, actions: ["pipeline-record"], state });
  assert.equal(query(), false, "内存快照不能代替落盘事实");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({ ...state, current: "end" }));
  assert.equal(query(), false, "nonce 一样但内容不同也不能补收据");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify(state));
  assert.equal(query(), true);
  assert.equal(existsSync(staged), false);
  assert.equal(query(), true, "重复核验幂等");
});

test("大任务历史与超过 512 KiB 的真实反馈生命周期均可核验", () => {
  const { cwd, workspace, taskId } = watchingTask("large-state");
  const state = readState(cwd);
  state.history = [{ detail: "h".repeat(900000) }];
  state.delivery_loop = { active_batch_id: "", batches: [{ batch_id: "old", status: "closed", summary: "x".repeat(600000) }] };
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify(state));
  sealPipelineLifecycle({ cwd, workspace, taskId, kernelRoot: KERNEL_ROOT });
  assert.equal(trustedKernelHostLifecycle({ host: HOST, cwd, actions: ["pipeline-record"] }), true);
  const changed = readState(cwd);
  changed.delivery_loop.batches[0].summary += "different";
  assert.equal(trustedKernelHostLifecycle({ host: HOST, cwd, actions: ["pipeline-record"], state: changed }), false);
});

test("核验输出格式错误不能变成否定裁决", () => {
  const { cwd } = watchingTask("malformed-attest");
  const script = join(cwd, "bad-attest.sh");
  writeFileSync(script, `#!/bin/sh\ncat >/dev/null\necho '{"schema":"mae-flow-host-attest/1","lifecycle":"false"}'\n`);
  chmodSync(script, 0o755);
  assert.throws(() => trustedKernelHostLifecycle({ host: { ...HOST, python: script }, cwd, actions: ["pipeline-record"] }), KernelUnavailableError);
});

test("task-20: 反馈开批只依赖反馈事实，不依赖步骤或其他投影", () => {
  const { cwd, workspace, taskId, head } = watchingTask("step-predecessor");
  const path = join(cwd, ".mae-flow.json");
  const initial = readState(cwd);
  initial.current = "build";
  delete initial.delivery_loop;
  writeFileSync(path, JSON.stringify(initial));
  reconcileKernelDeliverySelection({ host: HOST, cwd, workspace, taskId,
    waitingId: "selection-in-build", head, paths: ["main.ts"], excludedPaths: [] });
  const signed = readState(cwd);
  assert.equal(signed.current, "build");
  const moved = { ...signed, current: "external_verify",
    user_intervention: { updated: true },
    quality: { external_verification: { verdict: "PASS", sha: "unverified" } } };
  const batch = { schema: "mae-flow-feedback-batch/1" as const, batch_id: "task-20-regression",
    task_id: taskId, base_sha: head, opened_at: new Date().toISOString(),
    items: [{ id: "review-one", source: "mr_discussion" as const, source_id: "one",
      source_revision: 0, kind: "code_review", summary: "补齐分支", verification: "reviewer" }] };
  for (const tampered of [
    { ...moved, delivery_loop: { schema: "mae-flow-delivery-loop/1",
      batches: [{ batch_id: "forged", status: "closed" }] } },
  ]) {
    writeFileSync(path, JSON.stringify(tampered));
    assert.throws(() => openKernelFeedback({ host: HOST, cwd, workspace, batch }),
      /现有反馈事实与宿主收据不一致/);
  }
  writeFileSync(path, JSON.stringify(moved));
  assert.equal(trustedKernelHostLifecycle({ host: HOST, cwd,
    actions: ["selection-reconcile"], state: moved }), false,
    "步骤变化仍不能冒充完整就绪/终态证明");
  openKernelFeedback({ host: HOST, cwd, workspace, batch });
  const opened = readState(cwd);
  assert.equal(opened.delivery_loop.active_batch_id, batch.batch_id);
  assert.equal(opened.current, "feedback_triage");
  assert.equal(trustedKernelHostLifecycle({ host: HOST, cwd,
    actions: ["feedback-open"], state: opened }), true, "开批仍生成可恢复的新宿主收据");
  assert.equal(trustedKernelHostLifecycle({ host: HOST, cwd,
    actions: ["pipeline-record"], state: opened }), false,
    "开批收据不能替未核实的流水线结果背书");
  openKernelFeedback({ host: HOST, cwd, workspace, batch });
  assert.equal(readState(cwd).delivery_loop.batches.length, 1, "重复开批仍幂等");
  const result = { host: HOST, cwd, workspace, taskId, batchId: batch.batch_id,
    changed: false, results: [{ id: "review-one", status: "explained" as const,
      summary: "已有分支覆盖，无需改代码" }] };
  recordKernelFeedbackResult(result);
  const closed = readState(cwd);
  assert.equal(closed.delivery_loop.active_batch_id, "");
  const originalBatch = structuredClone(closed.delivery_loop.batches[0]);
  closed.current = "external_verify";
  writeFileSync(path, JSON.stringify(closed));
  recordKernelFeedbackResult(result);
  assert.deepEqual(readState(cwd).delivery_loop.batches[0], originalBatch,
    "无活动批次时的结果重放也允许正常步骤变化，不重写结果");
});

// task-26: historical close must neither lock an empty recovered task nor make
// retained, authentic feedback unusable. Exercise each first host action.
for (const seal of [false, true]) for (const reset of [false, true]) {
  for (const action of ["published", "control", "open"] as const) {
    test(`close 后恢复：${seal ? "含历史流水线" : "仅 close 收据"}/${reset ? "清空反馈" : "保留反馈"}/${action}`, () => {
      const { cwd, workspace, taskId, head } = watchingTask(`reopen-${seal}-${reset}-${action}`, seal);
      closeKernelDelivery({ host: HOST, cwd, workspace, taskId, sha: head, eventId: "old-merge" });
      const state = readState(cwd);
      assert.equal(state.current, "end");
      state.current = "delivery_review";
      if (reset) state.delivery_loop = { schema: "mae-flow-delivery-loop/1",
        batches: [], active_batch_id: "", published: null, close_events: [], delivery_round: 0 };
      writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify(state));
      if (!reset) assert.equal(trustedKernelHostFeedback({ host: HOST, cwd, state }), true,
        "close 可证明保留的反馈事实，步骤恢复不撤销事实");
      const quality = structuredClone(state.quality);
      const input = { host: HOST, cwd, workspace, taskId };
      if (action === "control") {
        controlKernelFeedback({ ...input, operationId: "new-target", target: "继续处理新要求",
          actor: "owner", requestId: "new-request", reason: "责任人恢复任务" });
        assert.equal(readState(cwd).delivery_loop.target.target, "继续处理新要求");
      } else if (action === "open") {
        openKernelFeedback({ ...input, batch: { schema: "mae-flow-feedback-batch/1",
          batch_id: "new-review", task_id: taskId, base_sha: head, opened_at: new Date().toISOString(),
          items: [{ id: "new-comment", source: "workspace", source_id: "new-comment",
            source_revision: 0, kind: "code_review", summary: "修复恢复后的问题", verification: "reviewer" }] } });
        assert.equal(readState(cwd).delivery_loop.active_batch_id, "new-review");
      }
      writeFileSync(join(cwd, "main.ts"), "export const ready = false;\n");
      execFileSync("git", ["-C", cwd, "commit", "-qam", "new revision"], { env: GIT_ENV });
      const sha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      assert.notEqual(sha, head);
      const publication = { ...input, receipt: { sha, ref: "refs/heads/feature", remote: "origin" } };
      recordKernelPublishedPush(publication);
      const published = readState(cwd);
      assert.equal(published.delivery_loop.published.sha, sha);
      assert.deepEqual(published.quality, quality, "推送不为新 SHA 制造绿灯");
      recordKernelPublishedPush(publication);
      assert.deepEqual(readState(cwd), published, "恢复/重试登记同一推送仍幂等");
    });
  }
}
