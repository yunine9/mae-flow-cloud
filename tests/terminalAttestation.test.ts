import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectKernelCompletion,
  inspectKernelDeliveryReady,
  inspectKernelTaskCompletion,
} from "../src/terminalAttestation.ts";
import { TaskService } from "../src/taskService.ts";

function fixture(current: string, external = false): {
  root: string; cwd: string; kernelRoot: string; head: string;
} {
  const root = mkdtempSync(join(tmpdir(), "mfc-terminal-"));
  const cwd = join(root, "repo");
  const kernelRoot = join(root, "kernel");
  mkdirSync(cwd);
  mkdirSync(join(kernelRoot, "flow"), { recursive: true });
  writeFileSync(join(kernelRoot, "flow", "flow.json"), JSON.stringify({
    steps: {
      grill: { terminal: false },
      build: { terminal: false },
      external_verify: { terminal: false },
      delivery_watch: { terminal: false },
      end: { terminal: true },
    },
  }));
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "bot@test"], { cwd });
  execFileSync("git", ["config", "user.name", "bot"], { cwd });
  writeFileSync(join(cwd, "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd, encoding: "utf-8",
  }).trim();
  const state: any = {
    current,
    execution_contract: external ? {
      schema: "mae-flow-execution/1", host: "cloud",
      compile: "pipeline", ut_write: "agent",
      ut_run: "pipeline", codecheck: "pipeline",
    } : {
      schema: "mae-flow-execution/1", host: "local",
      compile: "local", ut_write: "agent",
      ut_run: "local", codecheck: "local",
    },
  };
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify(state));
  return { root, cwd, kernelRoot, head };
}

function serviceFor(root: string, kernelRoot: string, maxConcurrent = 0): TaskService {
  const dataDir = join(root, "tasks");
  mkdirSync(dataDir, { recursive: true });
  return new TaskService({
    dataDir,
    provider: "unused",
    model: "unused",
    modelsJson: {},
    maxConcurrent,
    host: { kernelRoot },
  });
}

function taskState(root: string, cwd: string, id = "task-1"): any {
  const workspace = join(root, "tasks", id);
  mkdirSync(workspace, { recursive: true });
  return {
    summary: {
      id,
      requirement: "终态不变式反例",
      status: "running",
      created_at: new Date().toISOString(),
      workspace,
    },
    cwd,
    humanGate: {},
    controlEpoch: 0,
    driver: undefined,
  };
}

test("非终态步骤永远不能为 completed 背书", () => {
  for (const current of ["grill", "build", "external_verify"]) {
    const { cwd, kernelRoot } = fixture(current, true);
    const result = inspectKernelCompletion(cwd, kernelRoot);
    assert.equal(result.complete, false, current);
    assert.equal(result.terminal, false, current);
    assert.equal(result.kind,
      current === "external_verify" ? "external_verify" : "active");
  }
});

test("本地执行契约只需 flow terminal", () => {
  const { cwd, kernelRoot } = fixture("end");
  const result = inspectKernelCompletion(cwd, kernelRoot);
  assert.equal(result.complete, true, result.reason);
  assert.equal(result.external_required, false);
});

test("流水线契约:总体 end 也必须逐项 PASS 且绑定当前 HEAD", () => {
  const { cwd, kernelRoot, head } = fixture("end", true);
  let result = inspectKernelCompletion(cwd, kernelRoot);
  assert.equal(result.complete, false, "缺核销不能完成");

  const statePath = join(cwd, ".mae-flow.json");
  const checks = Object.fromEntries(["COMPILE", "UT", "CODECHECK"].map(
    (dimension) => [dimension, { status: "passed", sha: head }],
  ));
  writeFileSync(statePath, JSON.stringify({
    current: "end",
    execution_contract: {
      schema: "mae-flow-execution/1", host: "cloud",
      compile: "pipeline", ut_write: "agent",
      ut_run: "pipeline", codecheck: "pipeline",
    },
    quality: { external_verification: {
      verdict: "PASS", sha: head,
      required: ["COMPILE", "UT", "CODECHECK"], checks,
    } },
  }));
  result = inspectKernelCompletion(cwd, kernelRoot);
  assert.equal(result.complete, true, result.reason);

  execFileSync("git", ["commit", "--allow-empty", "-qm", "new head"], { cwd });
  result = inspectKernelCompletion(cwd, kernelRoot);
  assert.equal(result.complete, false, "旧 SHA 的绿灯不能背书新 HEAD");
});

test("持续检视就绪与任务完成使用两把不同的证明", () => {
  const { cwd, kernelRoot, head } = fixture("delivery_watch", true);
  const state = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf-8"));
  const checks = Object.fromEntries(["COMPILE", "UT", "CODECHECK"].map(
    (dimension) => [dimension, { status: "passed", sha: head }],
  ));
  state.execution_contract.continuous_review = true;
  state.quality = { external_verification: {
    verdict: "PASS", sha: head,
    required: ["COMPILE", "UT", "CODECHECK"], checks,
  } };
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify(state));
  assert.equal(inspectKernelDeliveryReady(cwd, kernelRoot).complete, true);
  assert.equal(inspectKernelTaskCompletion(cwd, kernelRoot).complete, false,
    "MR 未合入、内核未 close 时绝不能 completed");
  state.current = "end";
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify(state));
  assert.equal(inspectKernelDeliveryReady(cwd, kernelRoot).complete, false);
  assert.equal(inspectKernelTaskCompletion(cwd, kernelRoot).complete, false,
    "持续检视任务不能拿旧 end 冒充 MR 已合入");
  state.delivery_loop = { close_events: [{
    event_id: "merge-1", reason: "merged", sha: head, local_head: head,
  }] };
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify(state));
  assert.equal(inspectKernelTaskCompletion(cwd, kernelRoot).complete, true);

  execFileSync("git", ["commit", "--allow-empty", "-qm", "local after merge"], { cwd });
  assert.equal(inspectKernelTaskCompletion(cwd, kernelRoot).complete, true,
    "MR 合入竞态中的本地未推送提交只留痕，不能让终态死锁");
});

test("flow 未声明 terminal 时，状态文件自称 end 也不能绕过", () => {
  const { cwd, kernelRoot } = fixture("end");
  writeFileSync(join(kernelRoot, "flow", "flow.json"), JSON.stringify({
    steps: { end: { terminal: false } },
  }));
  const result = inspectKernelCompletion(cwd, kernelRoot);
  assert.equal(result.complete, false);
  assert.equal(result.terminal, false);
});

test("grill/build 多次 end_turn 只会停机，绝不能强行完成或交付", async () => {
  for (const current of ["grill", "build"]) {
    const { root, cwd, kernelRoot } = fixture(current, false);
    const service = serviceFor(root, kernelRoot);
    const task = taskState(root, cwd);
    let continues = 0;
    task.driver = {
      takeUndeliveredSteers: () => [],
      continueWith: async () => {
        continues += 1;
        return { status: "turn_finished", reason: "end_turn" };
      },
      finalReply: () => "我先停在这里",
      dispose: () => undefined,
    };
    await (service as any).settleTurn(
      task,
      Promise.resolve({ status: "turn_finished", reason: "end_turn" }),
      0,
    );
    assert.equal(continues, 5, `${current} 只有有界催办`);
    assert.equal(task.summary.status, "failed", current);
    assert.match(task.summary.detail, new RegExp(current));
    assert.equal(task.summary.delivery, undefined, "不得触发交付旁路");
  }
});

test("external_verify 的 end_turn 是宿主等待，不催 Agent 也不 completed", async () => {
  const { root, cwd, kernelRoot } = fixture("external_verify", true);
  const service = serviceFor(root, kernelRoot);
  const task = taskState(root, cwd);
  let continues = 0;
  task.driver = {
    takeUndeliveredSteers: () => [],
    continueWith: async () => {
      continues += 1;
      return { status: "turn_finished", reason: "end_turn" };
    },
    finalReply: () => "代码侧已完成",
    dispose: () => undefined,
  };
  await (service as any).settleTurn(
    task,
    Promise.resolve({ status: "turn_finished", reason: "end_turn" }),
    0,
  );
  assert.equal(continues, 0, "宿主等待点不许催 Agent 本地跑质量动作");
  assert.equal(task.summary.status, "verifying");
  assert.match(task.summary.detail, /权威流水线|尚未到 terminal/);
});

test("blocked_by 不信伪 completed：前置内核未终态时下游不能出队", async () => {
  const { root, cwd, kernelRoot } = fixture("build", false);
  const service = serviceFor(root, kernelRoot, 1);
  const upstream = taskState(root, cwd, "task-1");
  upstream.summary.status = "completed";
  const downstream = taskState(root, undefined as any, "task-2");
  downstream.cwd = undefined;
  downstream.summary.status = "queued";
  downstream.summary.blocked_by = ["task-1"];
  (service as any).tasks.set("task-1", upstream);
  (service as any).tasks.set("task-2", downstream);
  (service as any).queue.push("task-2");

  await (service as any).pump();

  assert.equal(downstream.summary.status, "queued");
  assert.deepEqual((service as any).queue, ["task-2"]);
  assert.match(downstream.summary.detail, /等待前置任务 task-1/);
});

test("恢复会对账伪 completed，并从内核 current 重新排队", () => {
  const { root, cwd, kernelRoot } = fixture("build", false);
  const service = serviceFor(root, kernelRoot, 0);
  const saved = taskState(root, cwd);
  saved.summary.status = "completed";
  saved.summary.completed_at = new Date().toISOString();
  writeFileSync(join(saved.summary.workspace, "task.json"), JSON.stringify({
    summary: saved.summary,
    cwd,
  }));

  const result = service.recover();

  assert.equal(result.restored, 1);
  assert.equal(result.requeued, 1);
  const restored = service.get("task-1")!;
  assert.equal(restored.status, "queued");
  assert.equal(restored.completed_at, undefined);
  assert.match(restored.detail ?? "", /伪终态.*build/);
});
