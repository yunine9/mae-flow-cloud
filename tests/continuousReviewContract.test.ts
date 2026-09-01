/**
 * 持续检视闭环的批 0 契约。
 *
 * 本文件故意不使用 managedFlowFixture，也不写 `.mae-flow.json`。事故
 * 复现中的每一次状态变化都由 vendored Mae-Flow 的 Hook/CLI 产生：
 * init → config-review/done → goto external_verify → pipeline record → end，
 * 然后调用生产代码 KernelHost.bootstrapManaged(rolloverTerminal)。
 *
 * 目标断言先以 TODO-RED 落地；批 1/3 接通目标生命周期后去掉 todo。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import { KernelHost } from "../src/kernelHost.ts";

const KERNEL_ROOT = discoverKernelRoot(process.cwd());
assert.ok(KERNEL_ROOT, "发布件必须包含 vendored Mae-Flow 内核");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "continuous-review-contract",
  GIT_AUTHOR_EMAIL: "continuous-review-contract@example.com",
  GIT_COMMITTER_NAME: "continuous-review-contract",
  GIT_COMMITTER_EMAIL: "continuous-review-contract@example.com",
};

const TICKET = "REQ2026090101";
const REQUIREMENT = "交付持续检视契约测试，并批准测试宿主进入外部验证。";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf-8",
  }).trim();
}

function kernel(cwd: string, ...args: string[]): string {
  return execFileSync(
    "python3",
    [join(KERNEL_ROOT!, "scripts", "mae-flow.py"), ...args],
    {
      cwd,
      env: { ...process.env, MAE_FLOW_HOST: "cloud" },
      encoding: "utf-8",
    },
  );
}

function readState(cwd: string, suffix = ""): Record<string, any> {
  return JSON.parse(readFileSync(
    join(cwd, `.mae-flow.json${suffix}`), "utf-8"));
}

function messageId(cwd: string, contains: string): string {
  const line = kernel(cwd, "messages")
    .split(/\r?\n/)
    .find((row) => row.includes(contains));
  const id = line?.trim().split(/\s+/)[0] ?? "";
  assert.ok(id, `messages 中找不到包含“${contains}”的真实用户消息`);
  return id;
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-continuous-review-"));
  git(cwd, "init", "--quiet", "-b", "master");
  git(cwd, "config", "user.email", "contract@test");
  git(cwd, "config", "user.name", "contract-test");
  writeFileSync(join(cwd, "main.ts"), "export const ready = true;\n");
  git(cwd, "add", "main.ts");
  git(cwd, "commit", "--quiet", "-m", "initial");
  writeFileSync(join(cwd, ".mae-flow-order.json"), JSON.stringify({
    execution_contract: {
      schema: "mae-flow-execution/1",
      host: "cloud",
      compile: "pipeline",
      ut_write: "agent",
      ut_run: "pipeline",
      codecheck: "pipeline",
      git_push: "host",
    },
    "UT生成方式": "仓内写法",
  }, null, 2));
  return cwd;
}

async function reproduceTerminalRollover(): Promise<{
  before: Record<string, any>;
  after: Record<string, any>;
  archived?: Record<string, any>;
  guidance: string;
}> {
  const cwd = repository();
  const host = new KernelHost({
    kernelRoot: KERNEL_ROOT!,
    workspace: cwd,
    transcriptPath: join(cwd, "transcript.jsonl"),
    taskId: "continuous-review-contract",
    python: "python3",
  });

  await host.bootstrapManaged(REQUIREMENT);
  const requirementMessage = messageId(cwd, "持续检视契约测试");
  kernel(cwd, "requirement-record", "--message-id", requirementMessage,
    "--ticket", TICKET);
  kernel(cwd, "config-review",
    "--set", "工号=contract-test",
    "--set", "基线分支=master",
    "--set", `单号=${TICKET}`,
    "--set", "单号类型=REQ",
    "--set", `需求文档=docs/req/REQ-${TICKET}.md`,
    "--set", "UT生成方式=仓内写法");
  await host.postTool({
    eventId: 1,
    taskId: "continuous-review-contract",
    sessionId: "main",
    ts: new Date().toISOString(),
    kind: "tool_finished",
    payload: {
      call_id: "config-confirm",
      name: "AskUserQuestion",
      input: { questions: [{
        question: "上述完整配置是否正确?",
        options: ["确认以上全部配置", "需要修改"],
      }] },
      answers: { "上述完整配置是否正确?": "确认以上全部配置" },
    },
  });
  kernel(cwd, "done");

  // 这里只用 goto 缩短无关的方案/编码链；goto 本身也由真实内核验真并
  // 落盘。关键的 terminal 则必须由真实 pipeline PASS 路由产生。
  await host.bootstrap("批准契约测试宿主切换到 external_verify。\n");
  const gotoMessage = messageId(cwd, "external_verify");
  kernel(cwd, "goto", "external_verify", "--force",
    "--message-id", gotoMessage);
  assert.equal(readState(cwd).current, "external_verify");

  const sha = git(cwd, "rev-parse", "HEAD");
  const facts = join(cwd, "pipeline-pass.json");
  writeFileSync(facts, JSON.stringify({
    sha,
    status: "success",
    source: "continuous-review-contract",
    git_push: { sha, ref: "refs/heads/master", remote: "origin" },
  }, null, 2));
  kernel(cwd, "pipeline", "record", "--file", facts);

  const before = readState(cwd);
  assert.equal(before.current, "end",
    "事故前置必须由真实 pipeline PASS 把真实内核推进到 end");
  assert.equal(before.config?.["单号"], TICKET,
    "终态必须带着真实 config-review/done 产生的配置，不能是空壳状态");
  assert.equal(existsSync(join(cwd, ".mae-flow.json.last")), false);

  const guidance = await host.bootstrapManaged(
    "处理 MR 检视意见：请修复空值场景。",
    { rolloverTerminal: true },
  );
  const after = readState(cwd);
  const archived = existsSync(join(cwd, ".mae-flow.json.last"))
    ? readState(cwd, ".last")
    : undefined;
  return { before, after, archived, guidance };
}

test("内核来源契约：Cloud 专属分支和分叉基线必须同时写进 VENDORED", () => {
  const metadata = readFileSync(join(KERNEL_ROOT!, "VENDORED"), "utf-8");
  assert.match(metadata, /^来源: mae-flow@[0-9a-f]{40}$/m);
  assert.match(metadata, /^分支: cloud\/continuous-review$/m);
  assert.match(metadata,
    /^基线: mae-flow@ad5b92af3e19766558dbca476389dda5cd80d076$/m);
  assert.match(metadata, /更新跑 harness\/sync-kernel\.sh/,
    "快照必须保留禁止手改、只从源仓同步的纪律");
});

test("批0真实失败复现：end 收到平台检视意见后必须续原单，不能 init 回 config_confirm", {
  todo: "批 1/3 接通 delivery_watch + feedback-open 后移除 TODO",
}, async () => {
  const scene = await reproduceTerminalRollover();
  const actual = {
    current: scene.after.current,
    ticket: scene.after.config?.["单号"] ?? null,
    archivedCurrent: scene.archived?.current ?? null,
    createdLastSnapshot: Boolean(scene.archived),
    asksConfigAgain: /config_confirm|配置确认|交付方式/.test(scene.guidance),
  };
  assert.deepEqual(actual, {
    current: "feedback_triage",
    ticket: TICKET,
    archivedCurrent: null,
    createdLastSnapshot: false,
    asksConfigAgain: false,
  });
});

// 下面这些名称就是设计文档 §2.2 的产品不变量。批 0 先把契约钉在
// 默认测试清单里；对应批次实现后逐条补正文并去掉 todo。
test.todo("契约：一个 Cloud 任务从创建到 MR 合入只能执行一次 init");
test.todo("契约：MR 未合入前的反馈不得重问配置、交付方式或原需求");
test.todo("契约：反馈修复始终沿用任务号、仓库、基线、分支、MR、责任人与资产快照");
test.todo("契约：push、MR 创建和流水线变绿都不是任务终态");
test.todo("契约：新 HEAD 让旧质量证据失效，同一 HEAD 的幂等重试可复用证据");
test.todo("契约：同一任务最多一个代码 writer，人工反馈优先于机器修复");
test.todo("契约：每条反馈都有来源、处理回执和权威核验，不以总体回复冒充闭环");
test.todo("契约：模糊或无法处理时明确停点，不猜、不糊弄、不无限空转");
test.todo("契约：只有 MR 合入或用户主动停止，Cloud 与内核才一起终止");
