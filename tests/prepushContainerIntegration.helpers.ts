/**
 * prepushContainerIntegration 拆分后的共享夹具与辅助函数(原 tests/prepushContainerIntegration.test.ts 逐字搬移;
 * 2026-09-11 负载均衡拆分——node:test 按文件并行、文件内串行,60s+ 的
 * 单文件拖累全量墙钟)。不带 .test.ts 后缀,测试运行器不会执行本文件;
 * 各 part 按需 import,断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { dockerAvailable } from "../src/containerRuntime.ts";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { FakeTaskContainerHarness } from "./support/fakeTaskContainer.ts";
import { managedFlowFixture } from "./support/managedFlowFixture.ts";

export const KERNEL_ROOT = (() => {
  const found = discoverKernelRoot(process.cwd());
  if (!found) throw new Error("找不到 mae-flow 内核");
  return found;
})();

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

export function sourceRepo(parent = tmpdir()): string {
  const cwd = mkdtempSync(join(parent, "mfc-prepush-container-src-"));
  git(cwd, "init", "--quiet", "-b", "master");
  git(cwd, "config", "user.email", "bot@test");
  git(cwd, "config", "user.name", "bot");
  writeFileSync(join(cwd, "README.md"), "# prepush container fixture\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "init");
  return cwd;
}

export const REAL_IMAGE = process.env.MFC_REAL_BUILD_IMAGE;
export const REAL_DOCKER = REAL_IMAGE ? await dockerAvailable() : false;

export function codingScenes(): Scene[] {
  return [
    { tool: { name: "bash", input: { command:
      "echo first > feature.txt" } } },
    { text: "编码提交完成。" },
  ];
}

export async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 25));
  }
}
