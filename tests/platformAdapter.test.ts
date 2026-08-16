/**
 * CodeHub 适配层的契约:配置模板→CLI→三端点 JSON,进内网只填命令行。
 * 裁判用真件:假 CLI 是真的子进程(node 脚本),模板套值、JSON/正则
 * 抽取、状态映射、诚实 502 全部走真调用链。
 *
 * 三条不许破的纪律:
 * - 映射不到的状态 502,拒绝猜(猜 running 白轮询,猜 failed 白烧修复);
 * - 个人令牌头优先于服务账号,谁的任务谁署名;
 * - CLI 失败带 stderr 原文上浮,不吞。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformAdapter } from "../src/platformAdapter.ts";

/** 假 codehubcli:把收到的 argv 原样回显进 JSON,行为按子命令走——
 * 测的就是"模板套了什么值、适配层怎么消化输出"。 */
function fakeCli(dir: string): string {
  const path = join(dir, "fake-codehubcli.mjs");
  writeFileSync(path, `
    import { writeFileSync } from "node:fs";
    const args = process.argv.slice(2);
    // argv 落盘:测试要断言"CLI 究竟收到了哪个令牌"
    writeFileSync(new URL("./last-argv.json", import.meta.url),
      JSON.stringify(args));
    const sub = args[0];
    if (sub === "mr") {
      console.log(JSON.stringify({ data: { web_url:
        "https://codehub.corp/mr/42", argv: args } }));
    } else if (sub === "trigger") {
      console.log(JSON.stringify({ data: { state: "RUNNING", argv: args } }));
    } else if (sub === "status") {
      console.log(JSON.stringify({ data: { runs: [
        { state: "RUNNING" },
        { state: "FAILED", fail_log: "BUILD FAILURE: 覆盖率 61%" },
      ], argv: args } }));
    } else if (sub === "weird") {
      console.log(JSON.stringify({ data: { state: "SUSPENDED" } }));
    } else if (sub === "boom") {
      console.error("CLI 炸了: token 无效");
      process.exit(3);
    }
  `);
  return path;
}

function makeAdapter(dir: string, cli: string): PlatformAdapter {
  const configPath = join(dir, "adapter.json");
  writeFileSync(configPath, JSON.stringify({
    token: "svc-token-0000",
    mr_create: {
      command: ["node", cli, "mr", "--repo", "{repo}",
        "--source", "{source_branch}", "--target", "{target_branch}",
        "--title", "{title}", "--token", "{token}"],
      url: { json: "data.web_url" },
    },
    pipeline_trigger: {
      command: ["node", cli, "trigger", "--repo", "{repo}",
        "--sha", "{sha}", "--token", "{token}"],
      status: { json: "data.state" },
      status_map: { RUNNING: "running", SUCCESS: "success", FAILED: "failed" },
    },
    pipeline_status: {
      command: ["node", cli, "status", "--sha", "{sha}", "--token", "{token}"],
      runs: { json: "data.runs" },
      status: { json: "state" },
      log: { json: "fail_log" },
      status_map: { RUNNING: "running", SUCCESS: "success", FAILED: "failed" },
    },
  }));
  chmodSync(configPath, 0o600);
  return new PlatformAdapter(configPath, () => {});
}

test("三端点走真 CLI:模板套值、抽取、状态映射、多 run 全对", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-"));
  const adapter = makeAdapter(dir, fakeCli(dir));

  const mr = await adapter.handle("POST", "/mr", new URLSearchParams(), {
    repo: "https://codehub.corp/g/demo.git",
    source_branch: "master_bot_REQ9", target_branch: "master",
    title: "REQ9: 修复通知模板 变量缺失",   // 带空格,argv 直传不走 shell
  }, {});
  assert.equal(mr.status, 201);
  assert.equal((mr.payload as any).url, "https://codehub.corp/mr/42");

  const trigger = await adapter.handle("POST", "/pipeline/trigger",
    new URLSearchParams(), { repo: "r", sha: "abc123" }, {});
  assert.equal((trigger.payload as any).status, "running", "RUNNING 映射到契约词");

  const status = await adapter.handle("GET", "/pipeline/status",
    new URLSearchParams("sha=abc123&repo=r"), {}, {});
  const runs = (status.payload as any).runs;
  assert.equal(runs.length, 2);
  assert.equal(runs[1].status, "failed");
  assert.match(runs[1].log, /覆盖率 61%/, "失败日志是修复环的口粮");
});

test("身份:个人令牌头压过服务账号;没带头回落服务账号", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-"));
  const adapter = makeAdapter(dir, fakeCli(dir));
  const lastArgv = () => JSON.parse(
    readFileSync(join(dir, "last-argv.json"), "utf-8")) as string[];

  // 带个人令牌头:CLI 收到的必须是个人的,不是服务账号的
  const personal = await adapter.handle("POST", "/mr", new URLSearchParams(), {
    repo: "r", source_branch: "s", target_branch: "t", title: "x",
  }, { "x-mfc-git-token": encodeURIComponent("glpat-personal-7777"),
       "x-mfc-git-user": "zhang.san" });
  assert.equal(personal.status, 201);
  assert.ok(lastArgv().includes("glpat-personal-7777"), "个人令牌没到 CLI");
  assert.ok(!lastArgv().includes("svc-token-0000"),
    "个人令牌在场时不该动服务账号");

  // 不带头:回落服务账号,MR 还能建(只是署名是服务号)
  const fallback = await adapter.handle("POST", "/pipeline/trigger",
    new URLSearchParams(), { repo: "r", sha: "abc" }, {});
  assert.equal(fallback.status, 201);
  assert.ok(lastArgv().includes("svc-token-0000"), "服务账号回落没生效");
});

test("诚实 502:未映射状态拒绝猜;CLI 非零退出带 stderr 上浮", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-"));
  const cli = fakeCli(dir);
  const configPath = join(dir, "adapter.json");
  writeFileSync(configPath, JSON.stringify({
    mr_create: { command: ["node", cli, "boom"], url: { regex: "https\\S+" } },
    pipeline_trigger: {
      command: ["node", cli, "weird"],
      status: { json: "data.state" },
      status_map: { RUNNING: "running" },   // SUSPENDED 故意不配
    },
    pipeline_status: {
      command: ["node", cli, "status"],
      runs: { json: "data.runs" }, status: { json: "state" },
      status_map: { RUNNING: "running", FAILED: "failed" },
    },
  }));
  const adapter = new PlatformAdapter(configPath, () => {});

  await assert.rejects(
    adapter.handle("POST", "/pipeline/trigger",
      new URLSearchParams(), { repo: "r", sha: "x" }, {}),
    /SUSPENDED.*拒绝猜测/s);
  await assert.rejects(
    adapter.handle("POST", "/mr", new URLSearchParams(),
      { repo: "r", source_branch: "s", target_branch: "t", title: "x" }, {}),
    /token 无效/);
});

test("配置坏了拒绝启动;引用 {token} 但两头都没有=502", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ mr_create: { command: [] } }));
  assert.throws(() => new PlatformAdapter(bad, () => {}), /command/);

  const cli = fakeCli(dir);
  const noToken = join(dir, "no-token.json");
  writeFileSync(noToken, JSON.stringify({
    // 没配 token/token_file
    mr_create: {
      command: ["node", cli, "mr", "--token", "{token}"],
      url: { json: "data.web_url" },
    },
    pipeline_trigger: { command: ["node", cli, "trigger"],
      status: { const: "running" } },
    pipeline_status: { command: ["node", cli, "status"],
      runs: { json: "data.runs" }, status: { json: "state" },
      status_map: { RUNNING: "running", FAILED: "failed" } },
  }));
  const adapter = new PlatformAdapter(noToken, () => {});
  await assert.rejects(
    adapter.handle("POST", "/mr", new URLSearchParams(),
      { repo: "r", source_branch: "s", target_branch: "t", title: "x" }, {}),
    /个人令牌没带、服务账号也没配/);
  // const 抽取:CLI 不回状态的触发型命令,固定 running 交给宿主轮询
  const trigger = await adapter.handle("POST", "/pipeline/trigger",
    new URLSearchParams(), { repo: "r", sha: "x" }, {});
  assert.equal((trigger.payload as any).status, "running");
});
