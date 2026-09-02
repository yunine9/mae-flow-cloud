/**
 * 宿主能力链的"别把自己锁在门外"契约(2026-09-02 实测事故复现)。
 *
 * 这三条原来都是**一次失败=永久失败、无命令可救**:
 * - 权威收据封整份 delivery_loop,一轮量大但完全合法的检视就把它
 *   撑过读取上限,之后反馈、流水线登记、连 MR 合入后的 close 全死;
 * - 凭据路径不解引用,<data> 经过一层软链(macOS 的 /var、容器挂载)
 *   就报"不在信任根内",一条宿主命令都过不去;
 * - Cloud 从不写内核强制要求的宿主任务绑定,收编新内核当天全线报
 *   "无法读取宿主任务绑定"。
 *
 * 全部用真件:真 git 仓、真内核 CLI、真 RSA 签名。工作区**故意**放在
 * tmpdir 下——macOS 上它就是一条 /var → /private/var 的软链。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import { KernelHost } from "../src/kernelHost.ts";
import { migrateContinuousReviewTask } from "../src/continuousReviewMigration.ts";
import {
  closeKernelDelivery,
  createKernelHostProof,
  openKernelFeedback,
  recordKernelFeedbackResult,
} from "../src/kernelDelivery.ts";

const KERNEL_ROOT = discoverKernelRoot(process.cwd());
assert.ok(KERNEL_ROOT, "发布件必须包含 vendored Mae-Flow 内核");
const HOST = { kernelRoot: KERNEL_ROOT!, python: "python3" };
const TICKET = "REQ2026090201";
const REQUIREMENT = "交付宿主能力链契约测试，并批准测试宿主进入外部验证。";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "host-capability", GIT_AUTHOR_EMAIL: "hc@example.com",
  GIT_COMMITTER_NAME: "host-capability", GIT_COMMITTER_EMAIL: "hc@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf-8" }).trim();
}

function kernel(cwd: string, ...args: string[]): string {
  return execFileSync("python3",
    [join(KERNEL_ROOT!, "scripts", "mae-flow.py"), ...args],
    { cwd, env: { ...process.env, MAE_FLOW_HOST: "cloud" }, encoding: "utf-8" });
}

function readState(cwd: string): Record<string, any> {
  return JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf-8"));
}

function messageId(cwd: string, contains: string): string {
  const line = kernel(cwd, "messages").split(/\r?\n/)
    .find((row) => row.includes(contains));
  const id = line?.trim().split(/\s+/)[0] ?? "";
  assert.ok(id, `messages 中找不到包含“${contains}”的真实用户消息`);
  return id;
}

interface Scene { workspace: string; cwd: string; taskId: string }

/** 生产目录形态:<data>/<task>/<repo>,信任根在 <data>/.host-capabilities。 */
async function watchingTask(label: string): Promise<Scene> {
  const data = mkdtempSync(join(tmpdir(), "mfc-host-capability-"));
  const workspace = join(data, `task-${label}`);
  const cwd = join(workspace, "repo");
  mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "--quiet", "-b", "master");
  git(cwd, "config", "user.email", "hc@test");
  git(cwd, "config", "user.name", "hc-test");
  writeFileSync(join(cwd, "main.ts"), "export const ready = true;\n");
  git(cwd, "add", "main.ts");
  git(cwd, "commit", "--quiet", "-m", "initial");
  writeFileSync(join(cwd, ".mae-flow-order.json"), JSON.stringify({
    execution_contract: {
      schema: "mae-flow-execution/1", host: "cloud", compile: "pipeline",
      ut_write: "agent", ut_run: "pipeline", codecheck: "pipeline",
      git_push: "host",
    },
    "UT生成方式": "仓内写法",
  }, null, 2));

  const host = new KernelHost({
    kernelRoot: KERNEL_ROOT!, workspace: cwd,
    transcriptPath: join(cwd, "transcript.jsonl"),
    taskId: `host-capability-${label}`, python: "python3",
  });
  await host.bootstrapManaged(REQUIREMENT);
  kernel(cwd, "requirement-record",
    "--message-id", messageId(cwd, "宿主能力链契约测试"), "--ticket", TICKET);
  kernel(cwd, "config-review",
    "--set", "工号=hc-test", "--set", "基线分支=master",
    "--set", `单号=${TICKET}`, "--set", "单号类型=REQ",
    "--set", `需求文档=docs/req/REQ-${TICKET}.md`,
    "--set", "UT生成方式=仓内写法");
  await host.postTool({
    eventId: 1, taskId: `host-capability-${label}`, sessionId: "main",
    ts: new Date().toISOString(), kind: "tool_finished",
    payload: {
      call_id: "config-confirm", name: "AskUserQuestion",
      input: { questions: [{ question: "上述完整配置是否正确?",
        options: ["确认以上全部配置", "需要修改"] }] },
      answers: { "上述完整配置是否正确?": "确认以上全部配置" },
    },
  } as any);
  kernel(cwd, "done");
  await host.bootstrap("批准契约测试宿主切换到 external_verify。\n");
  kernel(cwd, "goto", "external_verify", "--force",
    "--message-id", messageId(cwd, "external_verify"));
  const sha = git(cwd, "rev-parse", "HEAD");
  const facts = join(cwd, "pipeline-pass.json");
  writeFileSync(facts, JSON.stringify({
    sha, status: "success", source: "host-capability",
    git_push: { sha, ref: "refs/heads/master", remote: "origin" },
  }, null, 2));
  kernel(cwd, "pipeline", "record", "--file", facts);
  assert.equal(readState(cwd).current, "end");
  kernel(cwd, "init");
  const archived = JSON.parse(
    readFileSync(join(cwd, ".mae-flow.json.last"), "utf-8"));
  const taskId = `task-${label}`;
  migrateContinuousReviewTask({
    host: HOST, cwd, workspace, taskId, status: "queued", ticket: TICKET,
    baseline: "master", sourceBranch: archived.config?.["分支名"],
    reviewRepair: true,
  } as any);
  assert.equal(readState(cwd).current, "delivery_watch");
  return { workspace, cwd, taskId };
}

function trustRoot(workspace: string): string {
  return join(dirname(workspace), ".host-capabilities");
}

function receiptSizes(workspace: string): number[] {
  const root = trustRoot(workspace);
  return readdirSync(root).filter((name) => name.includes(".receipt-"))
    .map((name) => statSync(join(root, name)).size);
}

test("量大但合法的一轮检视不得锁死任务：反馈、回执、下一批、合入收口全通", async () => {
  const { workspace, cwd, taskId } = await watchingTask("volume");
  // 一条 350 字的意见,一轮 12 条。内核自己允许单条 4000 字,这远没到顶;
  // 旧实现在这个量级就把收据撑过 32 KiB,此后一条宿主命令都执行不了。
  const body = "这里的空值分支没有覆盖上游返回空值的情况，请补一条单测并说明预期语义。"
    .repeat(11).slice(0, 350);
  const items = Array.from({ length: 12 }, (_, index) => ({
    id: `mr:d-${index}`, source: "mr_discussion", source_id: `d-${index}`,
    source_revision: 0, kind: "code_review",
    summary: `${body}（第 ${index + 1} 条）`,
    material: "../reviews/discussions.json",
    verification: "reviewer", file: "main.ts", line: 3 + index,
  }));
  const batch = {
    schema: "mae-flow-feedback-batch/1" as const,
    batch_id: "fb-volume-1", task_id: taskId,
    base_sha: git(cwd, "rev-parse", "HEAD"),
    opened_at: new Date().toISOString(), items,
  };
  assert.equal(
    openKernelFeedback({ host: HOST, cwd, workspace, batch }).status,
    "repairing");

  // 逐条回执同样量大。这里刻意走"解释清楚、不改代码"那一支:改了代码
  // 就要重新走一轮流水线才能 close,而本用例要钉的是收据体积,不是
  // 重新验证链。
  assert.equal(recordKernelFeedbackResult({
    host: HOST, cwd, workspace, taskId, batchId: batch.batch_id, changed: false,
    results: items.map((item) => ({
      id: item.id, status: "explained" as const,
      summary: `${body}（回执 ${item.id}）`, evidence: "main.ts:3",
    })),
  }).status, "closed");

  // 检视人又提了一条:同一任务必须还能接。
  assert.ok(openKernelFeedback({
    host: HOST, cwd, workspace,
    batch: {
      ...batch, batch_id: "fb-volume-2",
      base_sha: git(cwd, "rev-parse", "HEAD"),
      items: [{ id: "mr:d-new", source: "mr_discussion", source_id: "d-new",
        source_revision: 0, kind: "code_review", summary: "再看一眼命名",
        verification: "reviewer" }],
    },
  }));

  // 最痛的一条:MR 真合入了,任务必须收得掉。
  closeKernelDelivery({
    host: HOST, cwd, workspace, taskId,
    sha: readState(cwd).quality.external_verification.sha,
    eventId: "mr-merged-volume",
  });
  assert.equal(readState(cwd).current, "end");

  const biggest = Math.max(...receiptSizes(workspace));
  assert.ok(biggest < 8 * 1024,
    `收据体积必须与反馈数量无关，实际最大 ${biggest} 字节`);
});

test("宿主凭据链在软链信任根下可用，且绑定由宿主写在工作区之外", async () => {
  const { workspace, cwd, taskId } = await watchingTask("binding");
  // tmpdir 在 macOS 上就是 /var → /private/var 的软链。上面的
  // migrate + feedback-open 已经真的跑通过内核，这里再把两条不变量钉死。
  const root = trustRoot(workspace);
  const bindings = readdirSync(root).filter((n) => n.startsWith("binding-"));
  assert.equal(bindings.length, 1, "宿主必须写且只写一份任务绑定");
  const binding = JSON.parse(readFileSync(join(root, bindings[0]), "utf-8"));
  assert.equal(binding.schema, "mae-flow-host-binding/1");
  assert.equal(binding.task_id, taskId);
  assert.equal(binding.continuous_review, true);
  assert.equal(statSync(join(root, bindings[0])).mode & 0o777, 0o600);
  // 绑定与私钥都必须在 Agent 工作区之外。
  assert.ok(!root.startsWith(cwd), "信任根不能落在代码仓内");
  assert.ok(!root.startsWith(workspace), "信任根不能落在任务工作区内");
});

test("continuous_review 下的流水线登记必须带宿主凭据，且凭据绑定这份事实原文", async () => {
  const { workspace, cwd, taskId } = await watchingTask("pipeline");
  const sha = git(cwd, "rev-parse", "HEAD");
  const facts = {
    sha, status: "success", source: "host-capability",
    git_push: { sha, ref: "refs/heads/master", remote: "origin" },
  };
  const path = join(workspace, "pipeline-facts.json");
  writeFileSync(path, JSON.stringify(facts, null, 2));

  // 裸调 = 内核拒收。这正是 Cloud 之前的调用形态。
  assert.throws(() => kernel(cwd, "pipeline", "record", "--file", path),
    /必须携带 Cloud 宿主凭据/);

  // 换一份事实、拿旧凭据顶账,同样不认。
  const proof = createKernelHostProof({
    cwd, workspace, taskId, action: "pipeline-record", payload: facts,
  });
  try {
    writeFileSync(path, JSON.stringify({ ...facts, status: "failed" }, null, 2));
    assert.throws(() => kernel(cwd, "pipeline", "record", "--file", path,
      "--host-proof", proof.path), /载荷摘要不匹配/);
    // 原样的事实 + 配套凭据:放行。
    writeFileSync(path, JSON.stringify(facts, null, 2));
    kernel(cwd, "pipeline", "record", "--file", path,
      "--host-proof", proof.path);
  } finally {
    proof.cleanup();
  }
  assert.equal(readState(cwd).quality.external_verification.verdict, "PASS");
});
