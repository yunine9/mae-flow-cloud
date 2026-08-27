/**
 * 环境预热编译(观测旁路,用户 2026-08-26 拍板"开始就爆红是好事"):
 * 现场就绪即并行编译基线。契约:收据绑起跑 SHA;runner 抛错=按基础
 * 设施故障记账,绝不碰任务状态(fail-open);收过口的收据不重跑;
 * 结果绝不构成交付证据——那是 prepush 与流水线的领地。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import {
  parseWarmupReport,
  warmupMission,
  WARMUP_NOTES_PATH,
  type WarmupRunRequest,
} from "../src/warmupAgent.ts";

async function until<T>(probe: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-warmup-"));
  const git = (...args: string[]) => execFileSync(
    "git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
  git("init", "--quiet", "-b", "master");
  git("config", "user.name", "bot");
  git("config", "user.email", "bot@test");
  writeFileSync(join(cwd, "README.md"), "baseline\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "baseline");
  return { cwd, git };
}

async function completedTask() {
  const model = new ScriptedModelServer([{ text: "会话完成。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-warmup-data-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create("环境预热演练").id;
  await until(() => service.get(id)?.status === "completed"
    ? true : undefined, "首轮会话收口");
  const repo = repository();
  const internal = (service as any).tasks.get(id);
  internal.cwd = repo.cwd;
  return { service, model, id, internal, repo };
}

test("收据绑起跑 SHA;收过口不重跑;fail-open 不碰任务状态", async () => {
  const { service, model, id, internal, repo } = await completedTask();
  try {
    const calls: WarmupRunRequest[] = [];
    (service as any).options.warmup = {
      runner: async (request: WarmupRunRequest) => {
        calls.push(request);
        return {
          status: "passed",
          message: "基线编译通过",
          build_command: "mvn -q compile",
        };
      },
    };
    (service as any).startBaselineWarmup(internal, 0);
    const receipt = await until(() => {
      const current = service.get(id)?.baseline_build;
      return current?.finished_at ? current : undefined;
    }, "预热收据落账");
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.sha, repo.git("rev-parse", "HEAD"),
      "收据必须绑起跑 SHA——责任切分靠它");
    assert.equal(receipt.build_command, "mvn -q compile");
    assert.equal(service.get(id)?.status, "completed",
      "预热是旁路,任务状态一个字都不许动");

    (service as any).startBaselineWarmup(internal, 0);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(calls.length, 1, "收过口的收据不重跑(缓存已经热了)");
  } finally {
    await model.stop();
  }
});

test("runner 抛错按基础设施故障记账,任务照常", async () => {
  const { service, model, id, internal } = await completedTask();
  try {
    (service as any).options.warmup = {
      runner: async () => { throw new Error("容器起不来"); },
    };
    (service as any).startBaselineWarmup(internal, 0);
    const receipt = await until(() => {
      const current = service.get(id)?.baseline_build;
      return current?.finished_at ? current : undefined;
    }, "失败收据落账");
    assert.equal(receipt.status, "infrastructure_failure");
    assert.match(String(receipt.detail), /容器起不来/);
    assert.equal(service.get(id)?.status, "completed");
  } finally {
    await model.stop();
  }
});

test("恢复续跑与脏工作区都不预热:预热只评判基线,不出冤案", async () => {
  // 内网实锤:恢复单的预热把 Agent 写了一半的类编了,报"基线缺
  // import"——责任切分反向误导。
  const { service, model, id, internal, repo } = await completedTask();
  try {
    let calls = 0;
    (service as any).options.warmup = {
      runner: async () => {
        calls += 1;
        return { status: "passed", message: "不该跑到这" };
      },
    };
    internal.resume = true;
    (service as any).startBaselineWarmup(internal, 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(calls, 0, "恢复续跑不预热");
    assert.equal(service.get(id)?.baseline_build, undefined);

    internal.resume = false;
    writeFileSync(join(repo.cwd, "wip.java"), "class Wip {}\n");
    (service as any).startBaselineWarmup(internal, 0);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(calls, 0, "脏工作区不预热——那不再是基线");
    assert.equal(service.get(id)?.baseline_build, undefined,
      "没跑就是没跑,不落收据不伪装");
  } finally {
    await model.stop();
  }
});

test("使命写清三件事与红线;报告解析只认合法结构、后写者胜", () => {
  const mission = warmupMission({
    taskId: "t1", workspace: "/tmp/repo", sha: "a".repeat(40),
  });
  assert.match(mission, /只做编译,不跑 UT/);
  assert.ok(mission.includes(WARMUP_NOTES_PATH),
    "构建入口沉淀路径必须写进使命——编码期子 Agent 与 prepush 靠它复用");
  assert.match(mission, /不执行任何 git 写操作/);
  assert.match(mission, /warmup-result/);

  assert.equal(parseWarmupReport("没有报告"), undefined);
  assert.equal(parseWarmupReport(
    '<warmup-result>{"status":"unknown","message":"x"}</warmup-result>'),
    undefined, "status 白名单外一律不认,交给基础设施故障处理");
  const last = parseWarmupReport([
    '<warmup-result>{"status":"failed","message":"first"}</warmup-result>',
    '<warmup-result>{"status":"passed","message":"编译通过",'
    + '"build_command":"npm run build"}</warmup-result>',
  ].join("\n"));
  assert.equal(last?.status, "passed");
  assert.equal(last?.build_command, "npm run build");
});
