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
      console.log(JSON.stringify({ data: { state: "RUNNING", jobs: [
        { quality: "COMPILE", state: "RUNNING", name: "compile" },
        { quality: "UT", state: "PENDING", name: "unit-test" },
        { quality: "CODECHECK", state: "PENDING", name: "codecheck" },
      ], argv: args } }));
    } else if (sub === "status") {
      console.log(JSON.stringify({ data: { runs: [
        { id: 101, state: "RUNNING", jobs: [
          { quality: "COMPILE", state: "RUNNING", name: "compile" },
        ] },
        { id: 102, state: "FAILED", fail_log: "BUILD FAILURE: 覆盖率 61%", jobs: [
          { quality: "COMPILE", state: "SUCCESS", name: "compile" },
          { quality: "UT", state: "FAILED", name: "unit-test" },
          { quality: "CODECHECK", state: "SKIPPED", name: "codecheck" },
        ] },
      ], argv: args } }));
    } else if (sub === "weird") {
      console.log(JSON.stringify({ data: { state: "SUSPENDED" } }));
    } else if (sub === "boom") {
      const tokenAt = args.indexOf("--token");
      console.error("CLI 炸了: token 无效 "
        + (tokenAt >= 0 ? args[tokenAt + 1] : ""));
      process.exit(3);
    } else if (sub === "mergeable") {
      // CodeHub mergeable_state 的真实形状(能力核对报告 B 节):
      // 平铺布尔 + reason 文案对象 + merge_request_switch 总开关。
      console.log(JSON.stringify({ data: {
        state: "opened",
        conflict_passed: true,
        ci_state_passed: false,
        resolve_discussion_passed: true,
        approvers_passed: false,
        merge_request_switch: true,
        reason: { ci_state_passed: "pipeline #88 failed" },
      } }));
    } else if (sub === "mrlist") {
      console.log(JSON.stringify({ data: args.includes("--found")
        ? [{ web_url: "https://codehub.corp/mr/7", iid: 7 }] : [] }));
    } else if (sub === "listnotes") {
      console.log(JSON.stringify({ data: { items: [{
        id: "discussion-9", revision: 3,
        updated_at: "2026-09-01T09:30:00Z", body: "编辑后的意见",
      }] } }));
    } else if (sub === "note") {
      console.log(JSON.stringify({ result: { id: 555 } }));
    } else if (sub === "resolvecmd") {
      console.log("{}");
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
        "--project", "{repo_path}",   // 从仓 URL 自动派生,人不填 id
        "--source", "{source_branch}", "--target", "{target_branch}",
        "--title", "{title}", "--e2e-issues", "{dts_no}",
        "--token", "{token}"],
      url: { json: "data.web_url" },
    },
    pipeline_trigger: {
      command: ["node", cli, "trigger", "--repo", "{repo}",
        "--sha", "{sha}", "--token", "{token}"],
      status: { json: "data.state" },
      checks: { json: "data.jobs" },
      check_dimension: { json: "quality" },
      check_status: { json: "state" },
      check_job: { json: "name" },
      status_map: { RUNNING: "running", SUCCESS: "success", FAILED: "failed" },
      check_status_map: {
        RUNNING: "running", PENDING: "pending", SUCCESS: "success",
        FAILED: "failed", SKIPPED: "skipped",
      },
    },
    pipeline_status: {
      command: ["node", cli, "status", "--sha", "{sha}", "--token", "{token}"],
      runs: { json: "data.runs" },
      status: { json: "state" },
      pipeline_id: { json: "id" },
      log: { json: "fail_log" },
      checks: { json: "jobs" },
      check_dimension: { json: "quality" },
      check_status: { json: "state" },
      check_job: { json: "name" },
      status_map: { RUNNING: "running", SUCCESS: "success", FAILED: "failed" },
      check_status_map: {
        RUNNING: "running", PENDING: "pending", SUCCESS: "success",
        FAILED: "failed", SKIPPED: "skipped",
      },
    },
    mr_discussions: {
      command: ["node", cli, "listnotes", "--mr", "{mr}"],
      items: { json: "data.items" },
      fields: {
        id: { json: "id" }, revision: { json: "revision" },
        updated_at: { json: "updated_at" }, body: { json: "body" },
      },
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
    // E2E 单号关联(内网诉求):单号必须以独立参数走 --e2e-issues,
    // 只拼进 title 平台看不见。REQ/DTS 同一个参数,平台不分型。
    dts_no: "DTS2026081800001",
  }, {});
  assert.equal(mr.status, 201);
  assert.equal((mr.payload as any).url, "https://codehub.corp/mr/42");
  // {repo_path}:从 https://codehub.corp/g/demo.git 自动派生
  // URL 编码路径 g%2Fdemo——CodeHub REST 按路径定位仓,不用手抄项目 id
  const argv = JSON.parse(
    readFileSync(join(dir, "last-argv.json"), "utf-8")) as string[];
  assert.ok(argv.includes("g%2Fdemo"), "repo_path 没从仓 URL 派生出来");
  assert.equal(argv[argv.indexOf("--e2e-issues") + 1], "DTS2026081800001",
    "单号要走 --e2e-issues 递到平台,不许只活在 title 里");

  const trigger = await adapter.handle("POST", "/pipeline/trigger",
    new URLSearchParams(), { repo: "r", sha: "abc123" }, {});
  assert.equal((trigger.payload as any).status, "running", "RUNNING 映射到契约词");
  assert.deepEqual((trigger.payload as any).checks.map(
    (item: { dimension: string }) => item.dimension),
  ["COMPILE", "UT", "CODECHECK"]);

  const status = await adapter.handle("GET", "/pipeline/status",
    new URLSearchParams("sha=abc123&repo=r"), {}, {});
  const runs = (status.payload as any).runs;
  assert.equal(runs.length, 2);
  assert.equal(runs[1].status, "failed");
  assert.equal(runs[1].checks[1].dimension, "UT");
  assert.equal(runs[1].checks[1].status, "failed");
  assert.equal(runs[1].checks[2].status, "skipped");
  assert.match(runs[1].log, /覆盖率 61%/, "失败日志是修复环的口粮");

  const discussions = await adapter.handle("GET", "/mr/discussions",
    new URLSearchParams("repo=r&mr=42"), {}, {});
  assert.deepEqual((discussions.payload as any).discussions, [{
    id: "discussion-9", revision: 3,
    updated_at: "2026-09-01T09:30:00Z", body: "编辑后的意见",
  }], "评论修订号和更新时间必须穿透适配层，编辑后才能形成新反馈");
});

test("身份:个人令牌头压过服务账号;没带头回落服务账号", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-"));
  const adapter = makeAdapter(dir, fakeCli(dir));
  const lastArgv = () => JSON.parse(
    readFileSync(join(dir, "last-argv.json"), "utf-8")) as string[];

  // 带个人令牌头:CLI 收到的必须是个人的,不是服务账号的
  const personal = await adapter.handle("POST", "/mr", new URLSearchParams(), {
    repo: "https://codehub.corp/g/demo.git",
    source_branch: "s", target_branch: "t", title: "x", dts_no: "REQ1",
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
    token: "svc-secret-do-not-leak",
    mr_create: {
      command: ["node", cli, "boom", "--token", "{token}"],
      url: { regex: "https\\S+" },
    },
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
    (error: Error) => {
      assert.match(error.message, /token 无效/);
      assert.match(error.message, /<token>/);
      assert.doesNotMatch(error.message, /svc-secret-do-not-leak/);
      return true;
    });
});

test("报告后新口子:平铺布尔门禁、先查后建、两步回复/解决", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-rpt-"));
  const cli = fakeCli(dir);
  const lastArgv = () => JSON.parse(
    readFileSync(join(dir, "last-argv.json"), "utf-8")) as string[];
  const makeConfig = (lookupFound: boolean) => {
    const configPath = join(dir, `adapter-${lookupFound}.json`);
    writeFileSync(configPath, JSON.stringify({
      token: "svc-token-0000",
      mr_create: {
        command: ["node", cli, "mr", "--source", "{source_branch}",
          "--target", "{target_branch}", "--token", "{token}"],
        url: { json: "data.web_url" },
      },
      mr_lookup: {
        command: lookupFound
          ? ["node", cli, "mrlist", "--found", "--source",
             "{source_branch}", "--token", "{token}"]
          : ["node", cli, "mrlist", "--source", "{source_branch}",
             "--token", "{token}"],
        url: { json: "data.0.web_url" },
        id: { json: "data.0.iid" },
      },
      pipeline_trigger: { command: ["node", cli, "trigger"],
        status: { const: "running" } },
      pipeline_status: { command: ["node", cli, "status"],
        runs: { json: "data.runs" }, status: { json: "state" },
        status_map: { RUNNING: "running", FAILED: "failed" } },
      mr_gates: {
        command: ["node", cli, "mergeable", "--mr", "{mr}",
          "--token", "{token}"],
        bools: { json: "data" },
        reason: { json: "data.reason" },
        ignore_fields: ["merge_request_switch"],
        mr_state: { json: "data.state" },
      },
      discussion_reply: {
        command: ["node", cli, "note", "--id", "{id}",
          "--body", "{body}", "--idempotency-key", "{idempotency_key}",
          "--token", "{token}"],
        note_id: { json: "result.id" },
      },
      discussion_resolve: {
        command: ["node", cli, "resolvecmd", "--note", "{note_id}",
          "--token", "{token}"],
      },
    }));
    return new PlatformAdapter(configPath, () => {});
  };

  // 平铺布尔模式:布尔字段即门禁;reason 同名文案进 detail;
  // 非布尔(state/reason)与 ignore_fields(总开关)不冒充门禁。
  const adapter = makeConfig(true);
  const gates = await adapter.handle("GET", "/mr/gates",
    new URLSearchParams("repo=r&mr=42"), {}, {});
  const list = (gates.payload as any).gates as
    Array<{ name: string; passed: boolean; detail?: string }>;
  const byName = Object.fromEntries(list.map((g) => [g.name, g]));
  assert.equal((gates.payload as any).mr_state, "opened");
  assert.equal(byName.ci_state_passed.passed, false);
  assert.match(byName.ci_state_passed.detail ?? "", /pipeline #88/,
    "reason 文案要进 detail 给修复使命用");
  assert.equal(byName.conflict_passed.passed, true);
  assert.equal(byName.merge_request_switch, undefined,
    "总开关不是门禁,不许上报");
  assert.equal(byName.state, undefined);
  assert.equal(byName.reason, undefined);

  // 先查后建:查到已开 MR 直接复用(创建命令根本不跑),iid 一并带回
  const reused = await adapter.handle("POST", "/mr", new URLSearchParams(),
    { repo: "r", source_branch: "s", target_branch: "t", title: "x" }, {});
  assert.equal((reused.payload as any).url, "https://codehub.corp/mr/7");
  assert.equal((reused.payload as any).id, "7");
  assert.ok(lastArgv().includes("mrlist"), "复用时不该执行创建命令");

  // 查不到 → 走创建
  const created = await makeConfig(false).handle("POST", "/mr",
    new URLSearchParams(),
    { repo: "r", source_branch: "s", target_branch: "t", title: "x" }, {});
  assert.equal((created.payload as any).url, "https://codehub.corp/mr/42");

  // 回复默认一步:resolve 未带/false 时只跑 reply 命令
  await adapter.handle("POST", "/mr/discussions/d-1/reply",
    new URLSearchParams(), {
      repo: "r", body: "回复正文", idempotency_key: "body-idem-1",
    }, {});
  assert.ok(lastArgv().includes("note"), "只回复时最后一跳是 reply 命令");
  assert.ok(lastArgv().includes("body-idem-1"),
    "请求体 idempotency_key 必须进入真实 CLI 模板");

  // HTTP 头优先于 body（真实宿主两处都会带）：大小写不敏感读取，
  // 避免 Node 归一成小写后模板拿不到稳定动作键。
  await adapter.handle("POST", "/mr/discussions/d-1/reply",
    new URLSearchParams(), {
      repo: "r", body: "回复正文", idempotency_key: "body-fallback",
    }, { "Idempotency-Key": "header-idem-2" });
  assert.ok(lastArgv().includes("header-idem-2"));
  assert.ok(!lastArgv().includes("body-fallback"));

  // resolve:true → 第二跳执行,note id 从 reply 输出抽出来传进去
  const two = await adapter.handle("POST", "/mr/discussions/d-1/reply",
    new URLSearchParams(), {
      repo: "r", body: "回复正文", resolve: true,
      idempotency_key: "body-idem-3",
    }, {});
  assert.equal((two.payload as any).resolved, true);
  assert.ok(lastArgv().includes("resolvecmd"));
  assert.ok(lastArgv().includes("555"), "note id 没接力到 resolve 命令");

  // 旧真实模板吞掉稳定动作键时必须 fail-closed；否则远端成功而本地
  // 未落 delivered 的重放会重复发言。无 idempotency_key 的旧调用仍
  // 保持兼容，收到了宿主 outbox 键才启用硬闸。
  const legacyPath = join(dir, "adapter-legacy-reply.json");
  writeFileSync(legacyPath, JSON.stringify({
    token: "svc-token-0000",
    mr_create: { command: ["node", cli, "mr"],
      url: { json: "data.web_url" } },
    pipeline_trigger: { command: ["node", cli, "trigger"],
      status: { const: "running" } },
    pipeline_status: { command: ["node", cli, "status"],
      runs: { json: "data.runs" }, status: { json: "state" },
      status_map: { RUNNING: "running", FAILED: "failed" } },
    discussion_reply: {
      command: ["node", cli, "note", "--id", "{id}",
        "--body", "{body}", "--token", "{token}"],
    },
  }));
  const legacy = new PlatformAdapter(legacyPath, () => {});
  await assert.rejects(() => legacy.handle(
    "POST", "/mr/discussions/d-legacy/reply", new URLSearchParams(),
    { repo: "r", body: "回复正文", idempotency_key: "stable-action-key" },
    {}), /模板未引用 \{idempotency_key\}.*拒绝非幂等投递/s);
  const compatible = await legacy.handle(
    "POST", "/mr/discussions/d-legacy/reply", new URLSearchParams(),
    { repo: "r", body: "旧调用无幂等键" }, {});
  assert.equal(compatible.status, 200, "无动作键的旧调用保持兼容");
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

test("降级链+contract 直通:首路挂了走次路,回显 sha/is_valid 透传", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-"));
  const cli = fakeCli(dir);
  // contract 模式脚本:输出就是宿主契约(仓内编排脚本的形态)。
  const bridge = join(dir, "fake-bridge.mjs");
  writeFileSync(bridge, `
    console.log(JSON.stringify({ runs: [
      { status: "success", is_valid: false, sha: "${"c".repeat(40)}" },
      { status: "failed", sha: "${"a".repeat(40)}", is_valid: true,
        pipeline_id: "88", web_url: "https://ci/88",
        log: "BUILD FAILURE",
        checks: [{ dimension: "COMPILE", status: "failed",
                   stage: "build", tool: "maven",
                   details: [{ file: "src/A.java", line: 7,
                               message: "找不到符号" }] }] },
    ] }));
  `);
  const configPath = join(dir, "chain.json");
  writeFileSync(configPath, JSON.stringify({
    token: "svc-token-0000",
    mr_create: { command: ["node", cli, "mr"],
      url: { json: "data.web_url" } },
    pipeline_trigger: { command: ["node", cli, "trigger"],
      status: { const: "running" } },
    pipeline_status: { candidates: [
      // 首路必炸(exit 3):降级链要接住,不算端点失败。
      { command: ["node", cli, "boom"], status: { json: "state" } },
      { command: ["node", bridge], contract: true },
    ] },
  }));
  const adapter = new PlatformAdapter(configPath, () => {});
  const result = await adapter.handle("GET", "/pipeline/status",
    new URLSearchParams({ sha: "a".repeat(40), repo: "r" }), {}, {});
  assert.equal(result.status, 200);
  const runs = (result.payload as any).runs;
  assert.equal(runs.length, 2);
  // 陈灯标记与 SHA 回显原样透传——机械核验在宿主(selectTerminalRun)。
  assert.equal(runs[0].is_valid, false);
  assert.equal(runs[1].sha, "a".repeat(40));
  assert.equal(runs[1].pipeline_id, "88");
  assert.equal(runs[1].checks[0].stage, "build");
  assert.equal(runs[1].checks[0].details[0].line, 7);
});

test("contract 模式不放松诚实:非契约状态词=这一路失败;全败聚合上报", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-"));
  const cli = fakeCli(dir);
  const liar = join(dir, "liar.mjs");
  writeFileSync(liar,
    `console.log(JSON.stringify({ runs: [{ status: "GREEN" }] }));`);
  const configPath = join(dir, "liar.json");
  writeFileSync(configPath, JSON.stringify({
    token: "svc-token-0000",
    mr_create: { command: ["node", cli, "mr"],
      url: { json: "data.web_url" } },
    pipeline_trigger: { command: ["node", cli, "trigger"],
      status: { const: "running" } },
    pipeline_status: { candidates: [
      { command: ["node", liar], contract: true },
      { command: ["node", cli, "boom"], status: { json: "state" } },
    ] },
  }));
  const adapter = new PlatformAdapter(configPath, () => {});
  await assert.rejects(
    adapter.handle("GET", "/pipeline/status",
      new URLSearchParams({ sha: "x", repo: "r" }), {}, {}),
    (error: Error) => /候选\[0\].*不是契约词/s.test(error.message)
      && /候选\[1\]/.test(error.message));
});

test("模板模式的 run 级回显:run_sha/is_valid/pipeline_id 逐字段抽取", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-"));
  const cli = fakeCli(dir);
  const rest = join(dir, "rest.mjs");
  writeFileSync(rest, `
    console.log(JSON.stringify({ data: { runs: [
      { state: "SUCCESS", commit_sha: "${"d".repeat(40)}",
        id: 91, valid: "false" },
    ] } }));
  `);
  const configPath = join(dir, "rest.json");
  writeFileSync(configPath, JSON.stringify({
    token: "svc-token-0000",
    mr_create: { command: ["node", cli, "mr"],
      url: { json: "data.web_url" } },
    pipeline_trigger: { command: ["node", cli, "trigger"],
      status: { const: "running" } },
    pipeline_status: {
      command: ["node", rest],
      runs: { json: "data.runs" },
      status: { json: "state" },
      run_sha: { json: "commit_sha" },
      pipeline_id: { json: "id" },
      is_valid: { json: "valid" },
      status_map: { SUCCESS: "success", FAILED: "failed",
                    RUNNING: "running" },
    },
  }));
  const adapter = new PlatformAdapter(configPath, () => {});
  const result = await adapter.handle("GET", "/pipeline/status",
    new URLSearchParams({ sha: "x", repo: "r" }), {}, {});
  const run = (result.payload as any).runs[0];
  assert.equal(run.sha, "d".repeat(40));
  assert.equal(run.pipeline_id, "91");
  assert.equal(run.is_valid, false);
});

test("pipeline_status 兼容旧 desc 配置并对无顺序键的多 run fail-closed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-adapter-"));
  const cli = fakeCli(dir);
  const desc = join(dir, "desc.mjs");
  writeFileSync(desc, `
    console.log(JSON.stringify([
      { state: "RUNNING", id: 93 },
      { state: "FAILED", id: 92 },
      { state: "SUCCESS", id: 91 }
    ]));
  `);
  const orderedPath = join(dir, "ordered.json");
  writeFileSync(orderedPath, JSON.stringify({
    token: "svc-token-0000",
    mr_create: { command: ["node", cli, "mr"],
      url: { json: "data.web_url" } },
    pipeline_trigger: { command: ["node", cli, "trigger"],
      status: { const: "running" } },
    pipeline_status: {
      command: ["node", desc],
      status: { json: "state" },
      pipeline_id: { json: "id" },
      status_map: { SUCCESS: "success", FAILED: "failed",
                    RUNNING: "running" },
    },
  }));
  const ordered = new PlatformAdapter(orderedPath, () => {});
  const result = await ordered.handle("GET", "/pipeline/status",
    new URLSearchParams({ sha: "x", repo: "r" }), {}, {});
  assert.deepEqual((result.payload as any).runs.map((run: any) =>
    run.pipeline_id), ["91", "92", "93"]);
  assert.equal((result.payload as any).runs.at(-1).status, "running");

  const ambiguous = join(dir, "ambiguous.mjs");
  writeFileSync(ambiguous, `console.log(JSON.stringify([
    { state: "SUCCESS" }, { state: "RUNNING" }
  ]));`);
  const ambiguousPath = join(dir, "ambiguous.json");
  writeFileSync(ambiguousPath, JSON.stringify({
    token: "svc-token-0000",
    mr_create: { command: ["node", cli, "mr"],
      url: { json: "data.web_url" } },
    pipeline_trigger: { command: ["node", cli, "trigger"],
      status: { const: "running" } },
    pipeline_status: {
      command: ["node", ambiguous],
      status: { json: "state" },
      status_map: { SUCCESS: "success", RUNNING: "running" },
    },
  }));
  const unsafe = new PlatformAdapter(ambiguousPath, () => {});
  await assert.rejects(() => unsafe.handle("GET", "/pipeline/status",
    new URLSearchParams({ sha: "x", repo: "r" }), {}, {}),
  /多条 run.*pipeline_id.*无法可靠判断最新流水线/s);
});
