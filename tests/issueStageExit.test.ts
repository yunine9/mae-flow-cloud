/**
 * 目标驱动阶段机(2026-08-28 拍板,issue #14)的出口回归:
 * - 拉单/拉仓不再机械推进,回执带注册表生成的阶段简报;
 * - 五阶段出口 = complete_stage 自报;三个举卡阶段没有它可绕;
 * - report_ut 降级为事实上报(不推进、不再是建 MR 前置);
 * - MR 验绿门三态(全绿当场放行 / 有红当场打回 / 在跑受理由监看器
 *   等绿放行)与"清单=台账"(少报/多报打回,空=空合法)。
 *
 * 范式与 issueFlowFixed.test.ts 同款:ScriptedModelServer 剧本 +
 * 本地裸仓 + 可编程假交付平台,只走公开 API 与工具回执/事件流断言;
 * 工具直调(免模型)仅用于门禁矩阵与回执文案(与既有"阶段门禁
 * 单点"测试同一形态)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { createIssueTools, type IssueToolContext } from "../src/issueFlow/tools.ts";
import {
  fixedStages,
  loadState,
  type FixedStage,
  type IssueScenario,
  type IssueSessionState,
} from "../src/issueFlow/state.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交的裸仓远端(推送目标),返回其路径。 */
function bareOrigin(root: string): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
}

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** 快速轮询的运行参数(流水线监看测试用:1s 一轮,预算 2 分钟)。 */
const fastPoll = {
  models: () => ({}),
  runtime: () => ({ poll_interval_s: 1, poll_timeout_s: 120 }),
};

/** 可编程验绿假件:MR 链接确定性(http://loop.test/mr/<n>);每个 SHA
 * 的流水线状态可配可改(status.get(sha) ?? defaultStatus)——中途改
 * defaultStatus 就演"在跑→绿",监看器下一轮询吃到新值。 */
class GatePlatform {
  readonly seen: Array<{ method: string; url: string }> = [];
  readonly status = new Map<string, "running" | "success" | "failed">();
  defaultStatus: "running" | "success" | "failed" = "running";
  /** 模拟同一 SHA 已有旧终态、随后重跑仍在进行的真实返回顺序。 */
  historicalStatus?: "success" | "failed";
  private mrCount = 0;
  private server: ReturnType<typeof createServer> | undefined;
  baseUrl = "";

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        this.seen.push({ method: request.method ?? "", url: request.url ?? "" });
        const send = (payload: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };
        if (request.method === "POST" && request.url === "/mr") {
          this.mrCount += 1;
          send({ url: `http://loop.test/mr/${this.mrCount}`, id: this.mrCount });
          return;
        }
        if (request.method === "POST" && request.url === "/pipeline/trigger") {
          send({ status: "running" });
          return;
        }
        if (request.method === "GET"
            && request.url?.startsWith("/pipeline/status")) {
          const sha = new URL(request.url, "http://loop")
            .searchParams.get("sha") ?? "";
          const run = this.status.get(sha) ?? this.defaultStatus;
          send({
            runs: [{ status: this.historicalStatus ?? "running" }, {
              status: run,
              ...(run === "failed"
                ? { log: "BUILD FAILURE: 模块 notify-service 编译失败" }
                : {}),
            }],
          });
          return;
        }
        response.writeHead(404);
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl =
      `http://127.0.0.1:${(this.server!.address() as { port: number }).port}`;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }
}

const TICKET = "DTS-2026-1002";

/** 走到 mr_green 的最小剧本:确认前七幕 + 确认后的 修改→自报→自报→
 * 推送→建MR(刻意不跑 report_ut:没有 UT 记录也能建 MR)→逐次申报
 * (declarations 即每次 complete_stage 带的 mrs 清单,可含错报演出)。 */
function chainScenes(origin: string, declarations: string[][]): Scene[] {
  const commit = (message: string) =>
    `cd repo/origin && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '${message}'`;
  return [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n\\n根因:演示。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis", input: { summary: "根因=演示" } } },
    { text: "分析报告已提交,等待确认。" },
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 修复`) } } },
    { tool: { name: "complete_stage", input: { note: "修改完成" } } },
    { tool: { name: "complete_stage", input: { note: "UT 通过" } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    ...declarations.map((mrs): Scene => ({
      tool: { name: "complete_stage", input: { note: "MR 已申报", mrs } },
    })),
    { text: "MR 已建,本回合到此。" },
  ];
}

interface Chain {
  dataDir: string;
  origin: string;
  platform: GatePlatform;
  model: ScriptedModelServer;
  service: IssueFlowService;
  id: string;
  events(): Array<Record<string, any>>;
  saved(): IssueSessionState;
  okReceipts(): string;
  errorReceipts(): string[];
  trail(): string;
}

async function stopChain(chain: Chain): Promise<void> {
  await chain.service.shutdown().catch(() => undefined);
  await chain.model.stop();
  await chain.platform.stop();
}

/** 登记有单会话,等分析闸并确认,把剧本推进到提交MR回合。
 * declarations 回调在拿到 origin 后生成申报演出(仓地址/错报清单)。 */
async function startChain(options: {
  platformStatus?: "running" | "success" | "failed";
  historicalStatus?: "success" | "failed";
  declarations?: (origin: string) => string[][];
}): Promise<Chain> {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-exit-"));
  const origin = bareOrigin(dataDir);
  const platform = new GatePlatform();
  platform.defaultStatus = options.platformStatus ?? "running";
  platform.historicalStatus = options.historicalStatus;
  await platform.start();
  const model = new ScriptedModelServer(
    chainScenes(origin, options.declarations?.(origin) ?? []),
    "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
  });
  const created = service.create({
    account: "dev", title: "出口回归", ticket: TICKET, source: "dts",
    repoUrl: origin,
  });
  const gate = await until(() => {
    const issue = service.get(created.id);
    if (issue.status === "failed") throw new Error(issue.error ?? "failed");
    return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
      ? issue : undefined;
  }, "分析确认闸");
  service.answer(created.id, {
    state_version: gate.gate!.state_version,
    code: "confirm",
  });
  const eventsRoot = join(dataDir, "issues", created.id);
  const readEvents = () => readFileSync(join(eventsRoot, "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
  const completeStage = () => readEvents().filter((event) =>
    event.kind === "tool_finished" && event.payload?.name === "complete_stage");
  return {
    dataDir,
    origin,
    platform,
    model,
    service,
    id: created.id,
    events: readEvents,
    saved: () => loadState(eventsRoot)!,
    okReceipts: () => completeStage()
      .filter((event) => !event.payload.is_error)
      .map((event) => String(event.payload.result)).join("\n"),
    errorReceipts: () => completeStage()
      .filter((event) => event.payload.is_error)
      .map((event) => String(event.payload.result)),
    trail: () => (loadState(eventsRoot)!.transitions ?? [])
      .map((entry) => entry.note).join("\n"),
  };
}

// ---- 免模型直调:出口动作的门禁矩阵与回执文案 ----

function directTools(state: IssueToolContext["state"], dataDir: string): {
  byName: (name: string) => {
    execute: (id: string, params: any) => Promise<unknown>;
  };
  textOf: (result: unknown) => string;
} {
  const ctx: IssueToolContext = {
    state,
    workspace: dataDir,
    dataRoot: dataDir,
    persist: () => undefined,
    dts: new MockDtsGateway(),
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(40),
    }),
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  return {
    byName: (name) => {
      const tool = tools.find((item) => item.name === name);
      assert.ok(tool, `应注册 ${name}`);
      return tool!;
    },
    textOf: (result) =>
      (result as { content: Array<{ text: string }> }).content[0].text,
  };
}

function directState(
  dataDir: string, scenario: IssueScenario, stage: FixedStage,
): IssueSessionState {
  const now = new Date().toISOString();
  return {
    id: "issue-exit", account: "dev",
    created_at: now, updated_at: now,
    title: "t", description: "", source: "dts", ticket: TICKET,
    mode: "fixed", scenario, round: 1,
    stage_states: fixedStages(scenario).map(() => "pending"),
    status: "idle", stage, stage_note: "", stage_at: now,
  };
}

test("出口回归(免模型):拉单/拉仓不再机械推进,回执带注册表简报,complete_stage 才收口", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-exit-advance-"));
  const origin = bareOrigin(dataDir);
  const state = directState(dataDir, "ticket", "dts_info");
  const { byName, textOf } = directTools(state, dataDir);
  // a. 拉单:阶段原地不动;回执 = 单据详情 + 注册表生成的下一阶段简报。
  const ticketReceipt = textOf(await byName("dts_get_ticket").execute("x", {}));
  assert.equal(state.stage, "dts_info", "拉单成功不再机械推进");
  assert.match(ticketReceipt, /MOCK 单据/);
  assert.match(ticketReceipt, /complete_stage 收口本阶段/);
  assert.match(ticketReceipt, /当前阶段「拉取代码仓·建分支」/,
    "回执的交接文案出自注册表简报");
  assert.match(ticketReceipt, /出口\(到什么程度算完\)/);
  // complete_stage 才进 prep_repo,收口回执同样出自注册表。
  const enterPrep = textOf(
    await byName("complete_stage").execute("x", { note: "单据已通读" }));
  assert.equal(state.stage, "prep_repo");
  assert.equal(state.stage_states?.[0], "done");
  assert.match(enterPrep, /当前阶段「拉取代码仓·建分支」/);

  // b. 拉仓:落地不推进,回执指路 complete_stage;收口才进 analyze。
  const pullReceipt = textOf(
    await byName("pull_repo").execute("x", { url: origin }));
  assert.equal(state.stage, "prep_repo", "拉仓落地不再机械推进");
  assert.match(pullReceipt, /代码仓就绪/);
  assert.match(pullReceipt, /都拉齐了就调 complete_stage 收口/);
  assert.match(pullReceipt, /当前阶段「拉取代码仓·建分支」/);
  const enterAnalyze = textOf(
    await byName("complete_stage").execute("x", { note: "仓已拉齐" }));
  assert.equal(state.stage, "analyze", "complete_stage 自报才进问题分析");
  assert.equal(state.stage_states?.[1], "done");
  assert.match(enterAnalyze, /当前阶段「问题分析」/);
});

test("出口回归(免模型):三个举卡阶段调 complete_stage 被门禁拒绝", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-exit-gate-"));
  // 分析(有单)与结论(无单)的出口是 submit_analysis;换库验证的
  // 出口是 build_deploy——卡即出口,没有 complete_stage 可绕。
  const analyze = directTools(directState(dataDir, "ticket", "analyze"), dataDir);
  await assert.rejects(
    () => analyze.byName("complete_stage").execute("x", { note: "n" }),
    /阶段门禁/, "分析阶段的出口是 submit_analysis,不是 complete_stage");
  const conclude = directTools(directState(dataDir, "no_ticket", "conclude"), dataDir);
  await assert.rejects(
    () => conclude.byName("complete_stage").execute("x", { note: "n" }),
    /阶段门禁/, "无单结论节点的出口是 submit_analysis(带结论)");
  const deploy = directTools(directState(dataDir, "ticket", "deploy_verify"), dataDir);
  await assert.rejects(
    () => deploy.byName("complete_stage").execute("x", { note: "n" }),
    /阶段门禁/, "换库验证阶段的出口是 build_deploy");
});

test("出口回归(免模型):report_ut 降级为事实上报——只记账不推进", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-exit-ut-"));
  const state = directState(dataDir, "ticket", "ut");
  const { byName, textOf } = directTools(state, dataDir);
  const receipt = textOf(await byName("report_ut").execute("x", {
    passed: true, summary: "12/12 通过",
  }));
  assert.equal(state.stage, "ut", "report_ut 不再推进阶段");
  assert.equal(state.ut?.passed, true, "结果照常记账(现场记录可查)");
  assert.match(receipt, /只记账不推进/);
  assert.match(receipt, /complete_stage/);
  const failReceipt = textOf(await byName("report_ut").execute("x", {
    passed: false, summary: "2 个用例失败",
  }));
  assert.equal(state.stage, "ut", "未通过同样原地不动");
  assert.match(failReceipt, /已记账/);
});

// ---- MR 验绿门三态(service 驱动,假交付平台) ----

test("MR 验绿门·全绿当场放行:申报即核验,全绿当场进换库验证", async () => {
  const chain = await startChain({
    platformStatus: "success",
    declarations: (origin) => [[origin]],
  });
  try {
    const done = await until(() => {
      const issue = chain.service.get(chain.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.stage === "deploy_verify" ? issue : undefined;
    }, "全绿当场放行进换库验证");
    assert.equal(done.stage_states?.[5], "done", "mr_green 随申报收口");
    assert.equal(done.stage_states?.[6], "in_progress", "换库验证进行中");
    assert.equal(done.mrs?.length, 1, "MR 台账在场");
    assert.equal(done.ut, undefined, "没有 UT 记录也能建 MR(UT 已降级)");
    // 当场放行没有停等:受理账不在场。
    assert.equal(chain.saved().mr_gate, undefined);
    // 回执与台账:验绿通过 + deploy_verify 注册表简报进现场。
    assert.match(chain.okReceipts(), /MR 验绿通过/);
    assert.match(chain.okReceipts(), /当前阶段「换库环境验证」/);
    assert.match(chain.trail(), /MR 验绿通过/, "验绿裁决要进台账");
  } finally {
    await stopChain(chain);
  }
});

test("MR 验绿门·有红当场打回:fail 带失败项详情与处置指引", async () => {
  const chain = await startChain({
    platformStatus: "failed",
    declarations: (origin) => [[origin]],
  });
  try {
    // 与台账一致的清单申报,但平台流水线是红的:当场打回带失败项。
    const errors = await until(() => {
      const list = chain.errorReceipts();
      return list.length >= 1 ? list : undefined;
    }, "申报被打回");
    assert.match(errors[0], /MR 验绿门/);
    assert.match(errors[0], /BUILD FAILURE/, "失败项详情要带回现场");
    assert.match(errors[0], /push_branch/);
    assert.match(errors[0], /重新申报/);
    await until(() =>
      chain.service.get(chain.id).status === "idle" ? 1 : undefined, "回合收口");
    const issue = chain.service.get(chain.id);
    assert.equal(issue.stage, "mr_green", "有红打回,阶段不动");
    assert.equal(issue.stage_states?.[5], "in_progress");
    assert.equal(chain.saved().mr_gate, undefined, "打回不记申报账");
  } finally {
    await stopChain(chain);
  }
});

test("MR 验绿门·在跑受理:记申报账停等,监看器绿后自动放行", async () => {
  const chain = await startChain({
    platformStatus: "running",
    declarations: (origin) => [[origin]],
  });
  try {
    await until(() =>
      chain.service.get(chain.id).status === "idle" ? 1 : undefined, "回合收口");
    // 受理:阶段不动、申报账在场(仓地址申报,验绿门归一接受)、
    // 回执与台账都留痕。
    const saved = chain.saved();
    assert.equal(saved.stage, "mr_green", "在跑受理,阶段不动");
    assert.deepEqual(saved.mr_gate?.mrs, [chain.origin], "受理要记申报账");
    assert.match(chain.okReceipts(), /已受理/);
    assert.match(chain.trail(), /MR 清单已申报/, "申报要进台账");
    // 平台转绿:监看器等绿后凭申报账放行(不变量:已申报且全绿)。
    chain.platform.defaultStatus = "success";
    const done = await until(() => {
      const issue = chain.service.get(chain.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.stage === "deploy_verify" ? issue : undefined;
    }, "监看器等绿后放行");
    assert.equal(done.stage_states?.[6], "in_progress");
    assert.equal(chain.saved().mr_gate, undefined, "放行即清申报账");
  } finally {
    await stopChain(chain);
  }
});

test("MR 验绿门·只认最新 run:历史绿/红后最新 running 均不得提前裁决", async () => {
  for (const historicalStatus of ["success", "failed"] as const) {
    const chain = await startChain({
      platformStatus: "running",
      historicalStatus,
      declarations: (origin) => [[origin]],
    });
    try {
      await until(() =>
        chain.service.get(chain.id).status === "idle" ? 1 : undefined,
      `历史 ${historicalStatus} + 最新 running 的申报回合收口`);
      const saved = chain.saved();
      assert.equal(saved.stage, "mr_green",
        `历史 ${historicalStatus} 不能越过最新 running 推进或打回`);
      assert.deepEqual(saved.mr_gate?.mrs, [chain.origin],
        "最新 run 仍在跑时应按受理停等处理");
      assert.equal(chain.errorReceipts().length, 0,
        "历史红灯不能让最新重跑被误判失败");

      // 再等一次监看轮询，监看器也必须保持相同的“最新 run”口径。
      await until(() => chain.platform.seen.filter((item) =>
        item.method === "GET" && item.url.startsWith("/pipeline/status"))
        .length >= 2 ? 1 : undefined, "监看器再次读取流水线");
      assert.equal(chain.service.get(chain.id).stage, "mr_green");
      assert.equal(chain.saved().pipelines?.[chain.origin]?.status, "running");
    } finally {
      await stopChain(chain);
    }
  }
});

test("MR 验绿门·清单=台账:少报/多报都打回且点名差异", async () => {
  const chain = await startChain({
    platformStatus: "running",
    declarations: (origin) => [
      [],                                        // 少报:台账 1 个,清单空。
      ["https://code.test/ghost.git"],           // 多报:编造不存在的 MR。
      [origin],                                  // 正确申报:在跑受理。
    ],
  });
  try {
    const errors = await until(() => {
      const list = chain.errorReceipts();
      return list.length >= 2 ? list : undefined;
    }, "少报与多报两次打回");
    assert.ok(errors[0].includes("少报"), "第一错=少报");
    assert.ok(errors[0].includes(chain.origin), "少报点名台账里的 MR");
    assert.ok(errors[1].includes("多报"), "第二错=多报");
    assert.ok(errors[1].includes("ghost"), "多报点名不存在的 MR");
    await until(() =>
      chain.service.get(chain.id).status === "idle" ? 1 : undefined, "回合收口");
    const saved = chain.saved();
    assert.equal(saved.stage, "mr_green", "错报都不得收口");
    assert.deepEqual(saved.mr_gate?.mrs, [chain.origin],
      "第三次(正确)申报在跑受理,记申报账");
  } finally {
    await stopChain(chain);
  }
});

test("MR 验绿门·空=空合法通过:无码修改路径零 MR 进换库验证", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-exit-empty-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    // 跳过拉仓:研究结论不涉及代码改动(complete_stage 两跳)。
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "complete_stage", input: { note: "本单为配置问题,无需代码仓" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 分析\\n\\n结论:配置项漂移。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis", input: { summary: "配置项漂移" } } },
    { text: "分析已提交。" },
    // 确认后:修改 → UT → 提交MR 段零 MR,空清单=空台账直接放行。
    { tool: { name: "complete_stage", input: { note: "无需改码" } } },
    { tool: { name: "complete_stage", input: { note: "无需 UT" } } },
    { tool: { name: "complete_stage", input: { note: "无 MR 交付", mrs: [] } } },
    { text: "收口完成。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  // 刻意不配 platformUrl:空=空路径不需要交付平台。
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts: new MockDtsGateway(),
    issueFlowMode: () => "fixed",
  });
  try {
    const created = service.create({
      account: "dev", title: "配置漂移", ticket: TICKET, source: "dts",
      repoUrl: origin,
    });
    const gate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
        ? issue : undefined;
    }, "分析确认闸");
    service.answer(created.id, {
      state_version: gate.gate!.state_version,
      code: "confirm",
    });
    const done = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.stage === "deploy_verify" && issue.status === "idle"
        ? issue : undefined;
    }, "空=空放行进换库验证");
    assert.equal(done.mrs, undefined, "零 MR 交付");
    assert.equal(done.stage_states?.[5], "done", "mr_green 收口(空=空)");
    const saved = loadState(join(dataDir, "issues", created.id))!;
    const trail = (saved.transitions ?? []).map((entry) => entry.note).join("\n");
    assert.match(trail, /空清单=空台账/);
    const receipts = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8")
      .split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((event) => event.kind === "tool_finished"
        && event.payload?.name === "complete_stage" && !event.payload.is_error)
      .map((event) => String(event.payload.result)).join("\n");
    assert.match(receipts, /空清单=空台账/);
    assert.match(receipts, /当前阶段「换库环境验证」/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("MR 验绿门·未申报不放行:监看器全绿只提醒申报,阶段原地", async () => {
  const chain = await startChain({ platformStatus: "success" });
  try {
    // 建完 MR 不申报:监看器看到全绿,但只开"请申报"回合,不推进。
    // (匹配串取平台回合独有开头——complete_stage 的工具描述每条请求
    // 都在,不能当匹配键。)
    await until(() =>
      chain.model.requests.some((request) =>
        JSON.stringify(request).includes("请调 complete_stage(带 mrs 参数"))
        ? 1 : undefined, "申报提醒回合抵达模型");
    const issue = chain.service.get(chain.id);
    assert.equal(issue.stage, "mr_green", "未申报不推进");
    assert.equal(issue.pipelines?.[chain.origin]?.status, "success",
      "流水线确实全绿");
    assert.equal(issue.stage_states?.[5], "in_progress");
    assert.equal(chain.saved().mr_gate, undefined);
  } finally {
    await stopChain(chain);
  }
});
