/**
 * Push 前专项 Agent 的交付集成约束：
 * - 每个新 HEAD 都必须先拿到自己的 prepush 结论；
 * - prepush 已通过后，纯传输失败重试同一 SHA 不重复烧 Agent；
 * - prepush 未通过时，远端分支、MR 与流水线都不能被创建。
 *
 * 用注入 runner 只替代专项 Agent 本身；会话收口、host push、远端 SHA
 * 反查、MR 与流水线仍走 TaskService 的真实编排。
 *
 * 拆分后的共享夹具(原 tests/prepushIntegration.test.ts 逐字搬移;
 * 2026-09-11 拆成 part1/2 做负载均衡,单文件 141s 是全量墙钟地板之一
 * ——node:test 按文件并行、文件内串行)。不带 .test.ts 后缀,测试
 * 运行器不会执行本文件;各 part 按需 import,断言与测试行为零变化。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { RequestedBuildFixService as TaskService } from "./support/requestedBuildFix.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import type {
  PrePushRunRequest,
  PrePushRunner,
} from "../src/prepushAgent.ts";
import { PRE_PUSH_STATE_SCHEMA } from "../src/prePushVerification.ts";
import { FakeTaskContainerHarness } from "./support/fakeTaskContainer.ts";
import { managedFlowFixture } from "./support/managedFlowFixture.ts";

export const KERNEL_ROOT = (() => {
  const found = discoverKernelRoot(process.cwd());
  if (!found) {
    throw new Error("找不到内核(MAE_FLOW_HOME/../mae-flow/仓内 kernel/ 皆无)");
  }
  return found;
})();

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

export function sourceRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-prepush-src-"));
  git(cwd, "init", "--quiet", "-b", "master");
  git(cwd, "config", "user.email", "bot@test");
  git(cwd, "config", "user.name", "bot");
  writeFileSync(join(cwd, "README.md"), "# prepush fixture\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "init");
  return cwd;
}

export function deliveryScenes(breakTransport = false, authoritativeRepo?: string): Scene[] {
  void breakTransport;
  void authoritativeRepo;
  return [
    { tool: { name: "bash", input: { command:
      "echo first > feature.txt" } } },
    { text: "已提交，等待宿主交付。" },
  ];
}

/** 模拟修复 Agent 按持续检视契约为本批每条反馈留下精确回执。 */
export function feedbackReceiptCommand(summary: string): string {
  const safeSummary = JSON.stringify(summary);
  return "node -e 'const fs=require(\"fs\"),c=require(\"crypto\");"
    + "const d=\"../kernel-delivery\";const ps=fs.readdirSync(d)"
    + ".filter(x=>x.startsWith(\"feedback-open-\"));"
    + "fs.mkdirSync(\"../feedback\",{recursive:true});"
    + `const summary=${safeSummary};`
    + "for(const p of ps){const b=JSON.parse(fs.readFileSync(d+\"/\"+p,\"utf8\"));"
    + "const id=b.batch_id;const name=\"result-\"+c.createHash(\"sha256\")"
    + ".update(id).digest(\"hex\").slice(0,24)+\".json\";"
    + "fs.writeFileSync(\"../feedback/\"+name,JSON.stringify({schema:"
    + "\"mae-flow-feedback-results/1\",batch_id:id,results:b.items.map(x=>({"
    + "id:x.id,status:\"fixed\",summary,evidence:\"feature.txt\"}))}));}'";
}

export function repairScenes(): Scene[] {
  return [
    { tool: { name: "bash", input: { command:
      `echo repaired >> feature.txt; ${feedbackReceiptCommand("流水线问题已修复")}` } } },
    { text: "修复已提交。" },
  ];
}

export async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 50));
  }
}

export function serviceWithRunner(
  platform: FakeGitPlatform,
  model: ScriptedModelServer,
  runner: PrePushRunner,
  dataDir: string,
  timing: { pollIntervalMs?: number; pollTimeoutMs?: number;
            continuousReview?: boolean } = {},
): TaskService {
  return new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    log: process.env.DEBUG_CONTINUOUS_REVIEW ? console.error : undefined,
    host: {
      kernelRoot: KERNEL_ROOT,
      repoPath: platform.barePath,
      python: "python3",
      continuousReview: timing.continuousReview ?? false,
    },
    delivery: {
      platformUrl: platform.baseUrl,
      pollIntervalMs: timing.pollIntervalMs ?? 100,
      pollTimeoutMs: timing.pollTimeoutMs ?? 10_000,
    },
    prepush: { enabled: true, runner },
  });
}