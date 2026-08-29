/**
 * 固定流程(2026-08-27 拍板)的契约测试:阶段机推进(2026-08-28 起
 * 目标驱动自报)、平台闸、UT 事实上报与 MR 验绿门、流水线监看
 * (红→修→绿)、验证回退、无单挂起→关联转正、MockDtsGateway、
 * pipelineClient、恢复续表。
 *
 * 范式提醒:固定流程的真相在宿主(state.ts 的阶段机操作),测试钉的
 * 就是"AI 想越权也越不过去、用户不确认就停"这些机械事实。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { createIssueTools, type IssueToolContext } from "../src/issueFlow/tools.ts";
import { IssueEnvironmentVault } from "../src/issueEnvironment.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import {
  FIXED_TICKET_STAGES,
  shouldNudgeFixed,
  type IssueSessionState,
} from "../src/issueFlow/state.ts";
import {
  fixedNudgeNotice,
  issueFixedOpeningPrompt,
  issueOpeningPrompt,
  issueRegistrationMeta,
  issueResumePrompt,
} from "../src/issueFlow/prompt.ts";
import {
  getPipelineStatus,
  triggerPipeline,
} from "../src/pipelineClient.ts";

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

/** 无单登记门禁(#17)要求模块+环境,各用例只关心流程本身——模块与
 * 网管环境四件套从这两个夹具取,别在每个测试里各写一遍。 */
const MODULE_ID = "pay-core";

function seedModule(dataDir: string, repoUrl: string): void {
  createBusinessModule(dataDir, {
    id: MODULE_ID, name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [repoUrl],
  }, "tester");
}

const NO_TICKET_ENV = {
  hosts: ["10.0.0.8"],
  pagePassword: "page-secret",
  backendPassword: "env-shared-secret",
};

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

const fakeOps = {
  async fetchLogs() {
    return { summary: "日志已拉取(测试假件):TranFmaWebsite 共 3 个文件,解压完成" };
  },
  async buildDeploy() {
    return { summary: "[INFO] 部署完成(测试假件)\n备份已写入 /backup" };
  },
};

const TICKET = "DTS-2026-1001";
const BRANCH = `master_dev_${TICKET}`;

/** 可剧本化的交付假件:/mr 建 MR;/pipeline/trigger 永远 running;
 * /pipeline/status 每 SHA 前两次查询 running,之后按轮次出终态
 * (firstTerminal 之后恒 success)——默认演出"红一轮修好再绿",
 * 恢复类测试可直接给 success。 */
class LoopPlatform {
  readonly seen: Array<{ method: string; url: string; body?: any }> = [];
  private terminalRound = 0;
  private readonly statusCalls = new Map<string, number>();
  private mrCount = 0;
  private server: ReturnType<typeof createServer> | undefined;
  baseUrl = "";

  constructor(private readonly firstTerminal: "failed" | "success" = "failed") {}

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        const body = chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : undefined;
        this.seen.push({ method: request.method ?? "", url: request.url ?? "", body });
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
        if (request.method === "GET" && request.url?.startsWith("/pipeline/status")) {
          const sha = new URL(request.url, "http://loop").searchParams.get("sha") ?? "";
          const calls = (this.statusCalls.get(sha) ?? 0) + 1;
          this.statusCalls.set(sha, calls);
          if (calls <= 2) {
            send({ runs: [{ status: "running" }] });
            return;
          }
          this.terminalRound += 1;
          const status = this.terminalRound === 1
            ? this.firstTerminal : "success";
          send({
            runs: [{ status: "running" }, {
              status,
              ...(status === "failed"
                ? { log: "BUILD FAILURE: 模块 notify-service 编译失败" }
                : { checks: [
                    { dimension: "COMPILE", status: "success" },
                    { dimension: "UT", status: "success" },
                    { dimension: "CODECHECK", status: "success" },
                  ] }),
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

test("固定流程有单全链:拉单→分析闸→修改→UT→MR 红转绿→换库→验证回退→二轮通过→归档", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-fixed-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform();
  await platform.start();
  const commit = (message: string) =>
    `cd repo/origin && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '${message}'`;
  const script: Scene[] = [
    // 第 1 回合:阶段门禁探针(换库部署在拉单阶段必须被拒)→ 拉单 →
    // complete_stage 自报收口(拉单不再机械推进)→ AI 自己拉仓 →
    // complete_stage 收口(拉仓不再机械推进)→ 写报告 → 提交举闸。
    { tool: { name: "build_deploy", input: { include_lib: false } } },
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n\\n现象:登录超时;根因:连接池耗尽;方案:超时回收。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽,方案=超时回收" } } },
    { text: "分析报告已提交,等待用户确认。" },
    // 第 2 回合(用户确认报告):提交修复 → 自报修改完成 → UT 上报
    // (只记账)→ 自报 UT 完成 → 推送 → 建 MR → complete_stage 申报
    // MR 清单(在跑→受理等绿)。
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 修复登录超时`) } } },
    { tool: { name: "complete_stage", input: { note: "连接池超时回收已实现" } } },
    { tool: { name: "report_ut", input: { passed: true, summary: "12/12 通过" } } },
    { tool: { name: "complete_stage", input: { note: "UT 通过" } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "MR 已申报", mrs: [origin] } } },
    { text: "MR 已创建并申报,等待流水线。" },
    // 第 3 回合(流水线红了,平台携失败项开回合):修复 → 同分支再推 →
    // 再建 MR → 重新申报。
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 补充修复告警`) } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "MR 重新申报", mrs: [origin] } } },
    { text: "已修复再推,等待流水线。" },
    // 第 4 回合(流水线全绿+已申报,平台放行):部署 → 平台举验证卡。
    { tool: { name: "build_deploy", input: { include_lib: false } } },
    { text: "部署完成,等待用户在环境验证。" },
    // 第 5 回合(用户验证发现问题,回退问题分析):二轮分析 → 重新举闸。
    { tool: { name: "bash", input: { command:
      "printf '\\n## 第二轮\\n\\n根因修正:回收策略缺竞态保护。\\n' >> issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { summary: "二轮:回收策略缺竞态保护" } } },
    { text: "第二轮分析已提交。" },
    // 第 6 回合(二轮确认):改完 → UT 上报+自报收口 → 推 → MR → 申报。
    { tool: { name: "complete_stage", input: { note: "竞态保护补丁" } } },
    { tool: { name: "report_ut", input: { passed: true, summary: "15/15 通过" } } },
    { tool: { name: "complete_stage", input: { note: "二轮 UT 通过" } } },
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 回收竞态保护`) } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "二轮 MR 已申报", mrs: [origin] } } },
    { text: "二轮修复已提交,等待流水线。" },
    // 第 7 回合(二轮流水线绿):再部署举闸。
    { tool: { name: "build_deploy", input: { include_lib: false } } },
    { text: "二轮部署完成,等待验证。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    opsTools: fakeOps,
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
  });
  try {
    const created = service.create({
      account: "dev",
      title: "登录超时",
      ticket: TICKET,
      source: "dts",
      repoUrl: origin,
      environment: {
        hosts: ["10.0.0.8"],
        pagePassword: "page-secret",
        backendPassword: "env-shared-secret",
      },
    });
    assert.equal(created.mode, "fixed", "个人偏好缺省固定流程,create 烙印");
    assert.equal(created.scenario, "ticket");
    assert.equal(created.stage, "dts_info");
    assert.deepEqual(created.stage_states, FIXED_TICKET_STAGES.map(() => "pending"));

    // ① 报告确认闸:AI 提交分析后必须停下等用户。
    const gate1 = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
        ? issue : undefined;
    }, "首轮分析确认闸");
    assert.ok(gate1.has_analysis, "submit_analysis 以报告在场为门票");
    assert.equal(gate1.stage, "analyze", "确认前必须停在分析阶段");
    // 门禁探针:换库部署在拉单阶段被拒,且说了人话。
    const events = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8");
    const probe = events.split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>)
      .find((event) => event.kind === "tool_finished"
        && event.payload?.name === "build_deploy");
    assert.ok(probe, "门禁探针调用应入事件账");
    assert.equal(probe.payload.is_error, true);
    assert.match(String(probe.payload.result), /阶段门禁/);

    // ② 确认报告 → 进问题修改;宿主在阶段2建好的分支应该在场。
    service.answer(created.id, {
      state_version: gate1.gate!.state_version,
      code: "confirm",
    });
    await until(() => {
      const issue = service.get(created.id);
      return issue.stage === "mr_green" && issue.status === "idle" ? issue : undefined;
    }, "修改+UT+推送+MR 回合收口");
    const fixing = service.get(created.id);
    assert.equal(fixing.stage_states?.[3], "done", "问题修改完成");
    assert.equal(fixing.stage_states?.[4], "done", "UT 通过记账");
    assert.equal(fixing.stage_states?.[5], "in_progress", "MR 跑绿进行中");
    assert.equal(fixing.pushes?.length, 1, "修复分支已推送(按仓记账)");
    assert.equal(fixing.pushes?.[0]?.repo, origin);
    assert.equal(fixing.mrs?.length, 1, "MR 已创建(按仓记账)");
    const branchNow = spawnSync("git",
      ["-C", join(dataDir, "issues", created.id, "repo", "origin"), "branch", "--show-current"],
      { encoding: "utf-8" });
    assert.equal(branchNow.stdout.trim(), BRANCH, "pull_repo 时宿主切的修复分支名=master_工号_单号");

    // ③ 流水线红→AI 修→再推→绿:全由宿主监看驱动,绿了自动进换库验证。
    const gate2 = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "env_verify"
        ? issue : undefined;
    }, "一轮:流水线红转绿后部署举验证闸");
    assert.equal(gate2.stage, "deploy_verify");
    assert.equal(gate2.pipelines?.[origin]?.status, "success", "监看账应记全绿");
    const failedRound = platform.seen.filter((entry) =>
      entry.method === "POST" && entry.url === "/pipeline/trigger").length;
    assert.ok(failedRound >= 2, "红过一轮就要有第二轮触发(同 MR 修复再推)");

    // ④ 验证不通过:一律回退问题分析,轮次+1,UT/监看作废,分支 MR 延用。
    const shaBefore = service.get(created.id).pushes![0].sha;
    service.answer(created.id, {
      state_version: gate2.gate!.state_version,
      code: "fail",
      notes: "并发场景仍偶发超时",
    });
    const gate3 = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
        && issue.round === 2 ? issue : undefined;
    }, "回退后二轮分析闸");
    assert.equal(gate3.stage, "analyze", "验证不通过一律回问题分析");
    assert.equal(gate3.ut, undefined, "回退作废 UT 上报");
    assert.equal(gate3.stage_states?.[3], "redo", "修改阶段标待重做");
    assert.equal(gate3.stage_states?.[5], "redo", "MR 阶段标待重做");
    assert.equal(gate3.pushes![0].sha, shaBefore, "分支与 MR 延用(不另开)");

    // ⑤ 二轮走完至验证通过:末阶段完成,待手动归档。
    service.answer(created.id, {
      state_version: gate3.gate!.state_version,
      code: "confirm",
    });
    const gate4 = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "env_verify"
        && issue.round === 2 ? issue : undefined;
    }, "二轮:验证闸");
    service.answer(created.id, {
      state_version: gate4.gate!.state_version,
      code: "pass",
    });
    const passed = await until(() => {
      const issue = service.get(created.id);
      return issue.status === "idle"
        && issue.stage_states?.[6] === "done" ? issue : undefined;
    }, "验证通过收尾");
    assert.equal(passed.stage, "deploy_verify", "固定流程留在自己的词表里");
    assert.equal(passed.pipelines?.[origin]?.status, "success");

    // ⑥ 手动归档:有 MR 记录,结论=已交付。
    const archived = service.control(created.id, { action: "archive" });
    assert.equal(archived.status, "archived");
    assert.equal(archived.conclusion?.kind, "delivered");
    assert.equal(archived.stage, "deploy_verify", "归档不改写固定流程阶段词表");
    // 登记元信息进上下文(ADR-0003):网管口令是现场公开默认值,明文
    // 随元信息块出现;平台凭据(git 令牌)的铁律不变。
    const requestText = JSON.stringify(model.requests);
    assert.match(requestText, /env-shared-secret/);
    assert.match(requestText, /page-secret/);
    assert.doesNotMatch(requestText, /git-token/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("固定流程无单闭环:结论是问题→挂起;结论非问题→直接归档留报告", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-noticket-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 初步定位\\n\\n结论:是问题(索引缺失导致全表扫描)。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "issue", summary: "是问题:索引缺失" } } },
    { text: "结论是问题,已提交等用户确认。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    issueFlowMode: () => "fixed",
  });
  try {
    seedModule(dataDir, origin);
    const created = service.create({
      account: "dev", title: "列表导出超时", repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    assert.equal(created.scenario, "no_ticket", "无单登记=无单三节点");
    assert.equal(created.stage, "prep_repo");
    const gate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "结论确认闸");
    assert.equal(gate.gate?.proposal?.conclusion, "issue");
    service.answer(created.id, {
      state_version: gate.gate!.state_version,
      code: "issue",
    });
    const suspended = await until(() => {
      const issue = service.get(created.id);
      return issue.status === "suspended" ? issue : undefined;
    }, "挂起");
    assert.equal(suspended.stage_states?.[2], "done", "确定结论节点完成");
    // 挂起不可续聊,只能关联转正或归档。
    assert.throws(() => service.reply(created.id, "继续"), /挂起中/);
    // 归档保留报告,结论=问题成立。
    const archived = service.control(created.id, { action: "archive" });
    assert.equal(archived.conclusion?.kind, "issue");
    assert.equal(archived.status, "archived");
    assert.ok(existsSync(join(dataDir, "issues", created.id, "issue-analysis.md")),
      "非交付收口也要留分析报告");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("固定流程无单闭环:结论非问题,用户确认后自动归档", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-nonissue-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 初步定位\\n\\n结论:非问题(测试环境时钟漂移)。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "non_issue", summary: "非问题:时钟漂移误报" } } },
    { text: "结论非问题,等用户确认。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    issueFlowMode: () => "fixed",
  });
  try {
    seedModule(dataDir, origin);
    const created = service.create({
      account: "dev", title: "疑似黑屏", repoUrl: origin,
      moduleId: MODULE_ID,
      environment: {
        hosts: ["10.0.0.8"],
        pagePassword: "page-secret",
        backendPassword: "env-shared-secret",
      },
    });
    assert.ok(existsSync(
      join(dataDir, ".issue-environments", `${created.id}.json`)),
      "登记即落环境凭据(闭环断言的前置)");
    const gate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "非问题结论闸");
    service.answer(created.id, {
      state_version: gate.gate!.state_version,
      code: "non_issue",
    });
    const archived = await until(() => {
      const issue = service.get(created.id);
      return issue.status === "archived" ? issue : undefined;
    }, "非问题自动闭环");
    assert.equal(archived.conclusion?.kind, "non_issue");
    assert.equal(existsSync(
      join(dataDir, ".issue-environments", `${created.id}.json`)), false,
      "闭环即清理环境凭据");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("举卡裁决协议化:闸卡带决策码,按码分派文案可变;旧文案不再是匹配键", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-verdict-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    // 会话 A:拉仓 → 自报收口 → 报告 → 举结论闸(顺序创建,不与 B 并发抢剧本)。
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 结论:非问题(时钟漂移误报)。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "non_issue", summary: "时钟漂移误报" } } },
    { text: "A 卡已举出。" },
    // 会话 B:同样举结论闸;答旧文案回流分析(续跑回合收口:补充意见
    // 回合未到出口,还有两次催办才落 idle)。
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 结论:非问题(时钟漂移误报)。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "non_issue", summary: "时钟漂移误报" } } },
    { text: "B 卡已举出。" },
    { text: "B 按补充意见继续查证。" },
    { text: "B 继续查证(催办一)。" },
    { text: "B 继续查证(催办二)。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    issueFlowMode: () => "fixed",
  });
  try {
    seedModule(dataDir, origin);
    const concludeGate = async (title: string) => {
      const created = service.create({
        account: "dev", title, repoUrl: origin,
        moduleId: MODULE_ID, environment: NO_TICKET_ENV,
      });
      return until(() => {
        const issue = service.get(created.id);
        if (issue.status === "failed") throw new Error(issue.error ?? "failed");
        return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
          ? issue : undefined;
      }, `${title} 结论闸`);
    };
    // 闸卡选项自带码+文案对:码表投影自 stageRegistry,举卡方不手写文案。
    const gateA = await concludeGate("文案可变");
    const options = gateA.gate!.question.questions[0].options;
    assert.deepEqual(options.map((option) => option.code),
      ["issue", "non_issue", "supplement"], "闸卡选项必须携带决策码");
    assert.ok(options.every((option) => option.label.length > 0),
      "每个码都要有给人看的文案");
    // 推荐协议(ADR-0004):结论闸的推荐从 AI 提案派生——本会话提交的
    // 结论是非问题,推荐就是「非问题」码(同一 wire 键,与 Agent 卡同形)。
    assert.equal(gateA.gate!.question.questions[0].recommended, "non_issue",
      "结论推荐应跟随 AI 提案(non_issue)");

    // 改文案零协议后果:decision 传任意字(显示文案本就来自 API),
    // 裁决只认 code——文案与裁决彻底解耦。
    service.answer(gateA.id, {
      state_version: gateA.gate!.state_version,
      decision: "文案被改成了任意话,裁决不该看它",
      code: "non_issue",
    });
    await until(() =>
      service.get(gateA.id).status === "archived" ? 1 : undefined, "按码闭环");
    assert.equal(service.get(gateA.id).conclusion?.kind, "non_issue");

    // 旧文案不再是匹配键:只交文案不交码 → 不闭环,按补充意见回流分析。
    const gateB = await concludeGate("旧文案失效");
    service.answer(gateB.id, {
      state_version: gateB.gate!.state_version,
      decision: "确认非问题,闭环归档",
    });
    await until(() =>
      service.get(gateB.id).status === "idle" ? 1 : undefined,
      "无码答复按补充意见回流分析,续跑回合收口");
    assert.notEqual(service.get(gateB.id).status, "archived",
      "文本不是匹配键——旧命令式文案不触发任何裁决");
    assert.match(JSON.stringify(model.requests), /确认非问题,闭环归档/,
      "人话答复仍原样进续聊提示词(显示语义保留)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("关联转正:两段式(校验过目→确认),工作区/报告/凭据继承,旧会话归档,单号唯一", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-assoc-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    // 无单会话走到挂起(先自己拉仓,自报收口后分析阶段才开门)。
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 初步定位\\n\\n结论:是问题。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "issue", summary: "是问题:死锁" } } },
    { text: "等用户确认。" },
    // 转正新会话的首轮(直接在问题修改阶段干活)。停机白名单生效后,
    // 阶段未到出口的裸文本收轮会被催办——这里以问题卡合法停机。
    { tool: { name: "bash", input: { command:
      `cd repo/origin && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '[${TICKET}][fix] 修复死锁'` } } },
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "修复已就位(继承的分析报告在案),继续跑 UT 验证?",
      options: ["继续跑 UT", "先停"],
      recommended: "继续跑 UT",
    }] } } },
    // 第二个无单会话(查重用)。
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 结论:是问题\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "issue", summary: "是问题:重复请求" } } },
    { text: "等确认。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts: new MockDtsGateway(),
    issueFlowMode: () => "fixed",
  });
  try {
    seedModule(dataDir, origin);
    const created = service.create({
      account: "dev", title: "偶发死锁", repoUrl: origin,
      moduleId: MODULE_ID,
      environment: {
        hosts: ["10.0.0.8"],
        pagePassword: "page-secret",
        backendPassword: "env-shared-secret",
      },
    });
    const gate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "无单结论闸");
    service.answer(created.id, {
      state_version: gate.gate!.state_version,
      code: "issue",
    });
    await until(() =>
      service.get(created.id).status === "suspended" ? 1 : undefined, "挂起");

    // 查无此单:直接拒。
    await assert.rejects(
      () => service.associate(created.id, { ticket: "DTS-9999" }),
      /查无此单/,
      "mock 网关只认 DTS-2026-1001~1005,乱编单号必须被拒");

    // 两段式第一段:不 confirm 只校验+回详情过目,状态不动。
    const preview = await service.associate(created.id, { ticket: TICKET });
    assert.match(preview.ticket_detail?.content ?? "", /MOCK 单据/);
    assert.equal(service.get(created.id).status, "suspended", "过目阶段不动状态");

    // 第二段:确认转正。
    const { converted } = await service.associate(created.id,
      { ticket: TICKET, confirm: true });
    assert.ok(converted, "确认后必须返回新会话");
    assert.equal(converted!.mode, "fixed");
    assert.equal(converted!.scenario, "ticket");
    assert.equal(converted!.stage, "fix", "转正直接进问题修改");
    assert.deepEqual(converted!.stage_states?.slice(0, 3),
      ["inherited", "inherited", "inherited"], "前三阶段标记继承");
    assert.equal(converted!.converted_from, created.id);
    const newRoot = join(dataDir, "issues", converted!.id);
    assert.ok(existsSync(join(newRoot, "repo", "origin", ".git")),
      "工作区(repo/origin/)继承,免二次克隆");
    assert.ok(existsSync(join(newRoot, "issue-analysis.md")), "分析报告继承");
    const branch = spawnSync("git",
      ["-C", join(newRoot, "repo", "origin"), "branch", "--show-current"],
      { encoding: "utf-8" });
    assert.equal(branch.stdout.trim(), BRANCH, "宿主已在副本上用新单号建分支");
    assert.ok(existsSync(join(dataDir, ".issue-environments", `${converted!.id}.json`)),
      "环境凭据已复制到新会话");
    // 两组凭据随后台一起转正:新会话自己的 vault 里页面、后台各自解出,
    // 页面账号与后台三账号的密码都对得上(#17)。
    const newVault = new IssueEnvironmentVault(dataDir);
    assert.equal(newVault.credential(converted!.id,
      converted!.environment!.credential_ref, "sopuser")?.password,
      "env-shared-secret", "后台凭据在新会话解出");
    assert.deepEqual(
      newVault.credentials(converted!.id,
        converted!.environment!.page_credential_ref!),
      [{ username: "admin", password: "page-secret" }],
      "页面凭据随后台一起复制,账号缺省 admin");
    const old = service.get(created.id);
    assert.equal(old.status, "archived");
    assert.equal(old.conclusion?.kind, "converted");
    assert.equal(old.converted_to, converted!.id);
    assert.equal(existsSync(
      join(dataDir, ".issue-environments", `${created.id}.json`)), false,
      "旧会话凭据在复制完成后销毁");
    // 新会话首轮在问题修改阶段干活,以问题卡合法停机(不再是裸文本收轮)。
    await until(() => {
      const issue = service.get(converted!.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" ? issue : undefined;
    }, "转正会话首轮以问题卡停机");

    // 单号唯一:第二个挂起会话再关联同单号 → 拒。
    const second = service.create({
      account: "dev", title: "重复请求", repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    const gate2 = await until(() => {
      const issue = service.get(second.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "第二个无单会话结论闸");
    service.answer(second.id, {
      state_version: gate2.gate!.state_version,
      code: "issue",
    });
    await until(() =>
      service.get(second.id).status === "suspended" ? 1 : undefined, "第二个挂起");
    await assert.rejects(
      () => service.associate(second.id, { ticket: TICKET, confirm: true }),
      /已有活跃会话/,
      "同一登录用户+同一单号只能有一个活跃会话");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("阶段门禁单点(免模型):工具只在所属阶段开放;UT 降级不再挡建 MR", async () => {
  const base: IssueSessionState = {
    id: "issue-1", account: "dev",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    title: "t", description: "", source: "dts", ticket: "T1",
    repo_url: "/tmp/x.git", repo_urls: ["/tmp/x.git"],
    mode: "fixed", scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "in_progress", "pending", "pending"],
    status: "idle", stage: "ut", stage_note: "", stage_at: new Date().toISOString(),
    pushes: [{ repo: "/tmp/x.git", branch: "master_dev_T1",
      sha: "a".repeat(40), at: new Date().toISOString() }],
  };
  const ctx: IssueToolContext = {
    state: base,
    workspace: "/tmp/ws",
    dataRoot: "/tmp/data",
    persist: () => undefined,
    platformUrl: "http://platform.test",
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(12),
    }),
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const byName = (name: string) => {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, `固定流程应注册 ${name}`);
    return tool!;
  };
  // 固定流程不注册 report_stage(阶段真相在宿主)。
  assert.equal(tools.some((tool) => tool.name === "report_stage"), false);
  assert.equal(tools.some((tool) => tool.name === "submit_analysis"), true);
  // UT 阶段:建 MR 仍被阶段门禁拒;complete_stage 已是本阶段出口。
  await assert.rejects(() => byName("create_mr").execute("x", {}),
    /阶段门禁/, "ut 阶段建 MR 必须被拒");
  // mr_green 阶段:没有 UT 记录不再挡建 MR(UT 降级为事实上报)——
  // 门禁放行,卡在机械前置(平台未配置),而不是任何 UT/阶段闸。
  base.stage = "mr_green";
  ctx.platformUrl = undefined;
  await assert.rejects(() => byName("create_mr").execute("x", {}),
    (error: Error) => !/阶段门禁|UT 门禁/.test(error.message),
    "没有 UT 记录也能建 MR(此处失败应因平台未配置)");
  // 换库部署只在 deploy_verify 开放。
  base.stage = "fix";
  await assert.rejects(() => byName("build_deploy").execute("x", { include_lib: false }),
    /阶段门禁/);
  // 自由模式:report_stage 在场,阶段自由。
  const free = createIssueTools({
    ...ctx,
    state: { ...base, mode: undefined, scenario: undefined, stage: "locate_root" },
  }) as Array<{ name: string }>;
  assert.equal(free.some((tool) => tool.name === "report_stage"), true,
    "自由模式保留 report_stage(零改动承诺)");
});

test("工读类放宽(2026-08-28):fetch_logs 全程可调,dts_get_ticket 重查不倒转阶段", async () => {
  const base: IssueSessionState = {
    id: "issue-1", account: "dev",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    title: "t", description: "", source: "dts", ticket: "DTS-2026-1001",
    repo_url: "/tmp/x.git", mode: "fixed", scenario: "ticket", round: 1,
    stage_states: ["pending", "pending", "done", "done", "in_progress", "pending", "pending"],
    status: "idle", stage: "dts_info", stage_note: "", stage_at: new Date().toISOString(),
  };
  const ctx: IssueToolContext = {
    state: base,
    workspace: "/tmp/ws",
    dataRoot: "/tmp/data",
    persist: () => undefined,
    dts: new MockDtsGateway(),
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(12),
    }),
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const byName = (name: string) => {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, `应注册 ${name}`);
    return tool!;
  };
  // fetch_logs 在第一阶段(dts_info)不再被阶段门禁拦——放宽后会因
  // 运维工具缺席而失败,而不是阶段门禁。
  await assert.rejects(
    () => byName("fetch_logs").execute("x", { services: ["TranFmaWebsite"] }),
    (error: Error) => !/阶段门禁/.test(error.message),
    "fetch_logs 应全程开放;此处缺席的是运维工具,不是阶段许可");
  // dts_get_ticket 在 ut 阶段重查:内容照回,阶段不倒转,转移账留痕。
  base.stage = "ut";
  await byName("dts_get_ticket").execute("x", { ticket: "DTS-2026-1001" });
  assert.equal(base.stage, "ut", "重查单据不得把阶段倒回 prep_repo");
  assert.ok(base.transitions?.some((entry) =>
    /详情已获取/.test(entry.note)), "重查要留转移账");
});

test("个人凭据前置门禁:这单会碰远端仓就先要令牌与邮箱,本地仓不拦", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-credgate-"));
  const origin = bareOrigin(dataDir);
  const httpsRepo = "https://codehub.test/some/repo.git";
  const script: Scene[] = [{ text: "ok" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  const base = {
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  } as const;
  const withCred = (email?: string) => ({
    ...base,
    ...(email === undefined
      ? { gitCredential: () => ({ username: "dev", password: "tok" }) }
      : { gitCredential: () => ({ username: "dev", password: "tok", email }) }),
  });
  let service: IssueFlowService | undefined;
  try {
    // 无单登记要模块+环境(#17);模块绑的是本地裸仓,不触发凭据门禁,
    // 这里钉的始终是 Git 身份这道门。
    seedModule(dataDir, origin);
    // 无凭据 + https 仓:登记直接拒,指路个人设置(门在发起前,不在克隆后)。
    service = new IssueFlowService(base);
    assert.throws(() => service!.create({
      account: "dev", title: "登录超时", ticket: "DTS-2026-1001",
      repoUrl: httpsRepo, mode: "fixed",
    }), /Git 令牌未配置.*个人设置/);
    // 自由探索同样拦:自由模式填了远端仓,克隆一样要用发起人身份。
    assert.throws(() => service!.create({
      account: "dev", title: "登录超时", repoUrl: httpsRepo, mode: "free",
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    }), /Git 令牌未配置/);
    await service.shutdown();

    // 令牌在而邮箱缺:提交署名无主,同样拦。
    service = new IssueFlowService(withCred());
    assert.throws(() => service!.create({
      account: "dev", title: "登录超时", ticket: "DTS-2026-1001",
      repoUrl: httpsRepo, mode: "fixed",
    }), /个人邮箱未配置.*个人设置/);
    await service.shutdown();

    // 令牌+邮箱齐:登记放行(克隆成败是后面回合的事,门禁只管身份在场)。
    service = new IssueFlowService(withCred("dev@example.com"));
    const created = service.create({
      account: "dev", title: "登录超时", ticket: "DTS-2026-1001",
      repoUrl: httpsRepo, mode: "fixed",
    });
    assert.equal(created.mode, "fixed");

    // file:///本地路径仓:不碰远端,无凭据也不拦(测试/裸仓形态)。
    await service.shutdown();
    service = new IssueFlowService(base);
    const local = service.create({
      account: "dev", title: "本地裸仓问题", ticket: "DTS-2026-1002",
      repoUrl: origin, mode: "fixed",
    });
    assert.ok(local.id);
    // 自由探索(有单,不带仓):纯研究形态,与凭据无关。
    const pure = service.create({
      account: "dev", title: "纯现象咨询", ticket: "DTS-2026-1003",
      moduleId: MODULE_ID, environment: NO_TICKET_ENV, mode: "free",
    });
    assert.ok(pure.id);
  } finally {
    await service?.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("MockDtsGateway:确定性单据集,已知单给罐头详情,未知单 fail-loud", async () => {
  const gateway = new MockDtsGateway();
  assert.equal(gateway.mock, true, "模拟网关必须自带 DEV 标记(列表 API 挂徽标用)");
  const list = await gateway.listByOwner("y00965296");
  assert.equal(list.length, 6, "六个测试单");
  assert.ok(list.every((item) => item.title.startsWith("【DEV·模拟】")),
    "标题打 DEV 标,列表里一眼认出模拟单");
  assert.ok(list.every((item) => item.ticket.startsWith("DTS-2026-")));
  const detail = await gateway.detail("DTS-2026-1003");
  assert.match(detail.content, /MOCK 单据/);
  assert.ok(detail.title.length > 0);
  await assert.rejects(() => gateway.detail("DTS-0000"), /查无此单/);
  const flying = await gateway.detail("DTS-2026-1006");
  assert.match(flying.content, /开局飞跑/);
  assert.match(flying.content, /行军动画/, "自带现象描述的单子用原文,不走罐头模板");
});

test("pipelineClient 公共客户端:触发/查询/契约校验/checks 解析", async () => {
  const seen: Array<{ method: string; url: string; body?: any }> = [];
  // 可切模式的假件:normal=正常回形;bad-status=未知状态;bad-checks=坏 checks。
  let mode: "normal" | "bad-status" | "bad-checks" = "normal";
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : undefined;
      seen.push({ method: request.method ?? "", url: request.url ?? "", body });
      const send = (payload: unknown, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (request.method === "POST" && request.url === "/pipeline/trigger") {
        send({ status: "running" });
      } else if (request.method === "GET"
          && request.url?.startsWith("/pipeline/status")) {
        if (mode === "bad-status") {
          send({ status: "weird" });
        } else if (mode === "bad-checks") {
          send({ runs: [{ status: "success",
            checks: [{ dimension: "??", status: "nope" }] }] });
        } else {
          send({
            runs: [
              { status: "running" },
              { status: "failed", log: "BUILD FAILURE",
                checks: [{ dimension: "COMPILE", status: "failed", job: "build" }] },
            ],
          });
        }
      } else {
        send({}, 500);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const run = await triggerPipeline({
      platformUrl: base, sha: "a".repeat(40),
      credential: { username: "dev", password: "tok" },
    });
    assert.equal(run.status, "running");
    const status = await getPipelineStatus({
      platformUrl: base, sha: "a".repeat(40),
    });
    assert.equal(status.runs.length, 2);
    assert.equal(status.status, "failed", "末位 run 是终态裁决");
    assert.equal(status.checks?.[0].dimension, "COMPILE");
    assert.equal(seen[0].body.sha, "a".repeat(40));
    // 契约状态不猜:未知状态直接报错。
    mode = "bad-status";
    await assert.rejects(
      () => getPipelineStatus({ platformUrl: base, sha: "x" }),
      /未知状态/,
    );
    // 坏 checks 整体按"没有证据"处理(不拿总体绿灯补猜)。
    mode = "bad-checks";
    const bad = await getPipelineStatus({ platformUrl: base, sha: "x" });
    assert.equal(bad.runs[0].checks, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("恢复:监看中的流水线重启后重新挂表,绿了自动推进", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-watch-recover-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("success");
  await platform.start();
  const script: Scene[] = [
    { text: "收到,准备部署。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  // 直接落一个"MR 跑绿监看中"的现场(不跑全链,聚焦恢复语义)。
  const sha = spawnSync("git", ["--git-dir", origin, "rev-parse", "HEAD"],
    { encoding: "utf-8" }).stdout.trim();
  const root = join(dataDir, "issues", "issue-1");
  mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: now, updated_at: now,
    title: "t", description: "", source: "dts", ticket: "DTS-2026-1002",
    repo_url: origin, repo_urls: [origin], mode: "fixed", scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "done", "in_progress", "pending"],
    status: "idle", stage: "mr_green", stage_note: "", stage_at: now,
    pushes: [{ repo: origin, branch: `master_dev_DTS-2026-1002`, sha, at: now }],
    mrs: [{ repo: origin, branch: `master_dev_DTS-2026-1002`,
      title: "[DTS-2026-1002] t", at: now }],
    // MR 验绿门:申报已受理(不变量——进 deploy_verify 当且仅当
    // 已申报且全绿;监看器绿了凭它在场放行)。
    mr_gate: { mrs: [origin], at: now },
    pipelines: {
      [origin]: {
        sha, status: "running", watching: true,
        started_at: now,
        deadline: new Date(Date.now() + 120_000).toISOString(),
        round: 1,
      },
    },
  }));
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
  });
  try {
    // 构造即恢复:watching=true 的监看要重新挂表,预算沿用原 deadline。
    const done = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.stage === "deploy_verify" && issue.status === "idle"
        ? issue : undefined;
    }, "恢复监看并推进到换库验证");
    assert.equal(done.pipelines?.[origin]?.status, "success");
    assert.equal(done.pipelines?.[origin]?.watching, false);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("模式烙印:个人偏好回调决定缺省;显式入参可覆盖;裸服务按自由兼容", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-mode-"));
  const script: Scene[] = [{ text: "ok" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    issueFlowMode: (account) => account === "freebird" ? "free" : "fixed",
  });
  try {
    const origin = bareOrigin(dataDir);
    seedModule(dataDir, origin);
    const fixedOne = service.create({
      account: "dev", title: "默认固定", ticket: "T1", repoUrl: origin,
      mode: undefined,
    });
    assert.equal(fixedOne.mode, "fixed");
    const freeOne = service.create({
      account: "freebird", title: "偏好自由",
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    assert.equal(freeOne.mode, "free", "偏好自由的用户烙印 free");
    assert.equal(freeOne.scenario, undefined);
    const forced = service.create({
      account: "dev", title: "显式自由", mode: "free",
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    assert.equal(forced.mode, "free", "显式入参盖过回调");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("拉仓工具化(2026-08-28 v2):fixed DTS 无仓发起,AI 拉单后自己拉仓/自报跳过 + 同单查重", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-repogate-"));
  const origin = bareOrigin(dataDir);
  // 线性剧本跨两个会话:每张单 = 拉单 → 自报收口 → AI 裁决(拉仓后
  // 再自报收口,或直接跳过)→ 分析。
  const script: Scene[] = [
    // 会话 A:拉单 → complete_stage 收口 → 自己拉仓 → complete_stage 收口
    // (拉单/拉仓都不再机械推进)。
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 分析\n\n现象已核实。\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis", input: { summary: "根因=连接池耗尽" } } },
    { text: "仓已拉好,分析已提交。" },
    // 会话 B:拉单 → 收口 → 无代码改动,complete_stage 自报跳过拉仓。
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "complete_stage", input: { note: "本单为配置问题,无需代码仓" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 分析\n\n结论:配置项漂移。\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis", input: { summary: "配置项漂移,非代码问题" } } },
    { text: "无仓跳过,分析已提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts: new MockDtsGateway(),
    issueFlowMode: () => "fixed",
  });
  try {
    // ① 无仓登记放行(repo_needed 闸已退役,缺仓不再举平台卡)。
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
    });
    assert.equal(created.repo_url, undefined);
    assert.equal(created.stage, "dts_info");

    // ② 同账号+同单号至多一个进行中的固定流程。
    assert.throws(() => service.create({
      account: "dev", title: "重复发起", ticket: TICKET, source: "dts",
    }), /已有进行中的问题会话/);

    // ③ 开场词要把"拉仓是你自己的事"讲清楚(工具化语义的引导层)。
    await until(() => model.requests.length ? 1 : undefined, "首回合请求到达模型");
    assert.match(JSON.stringify(model.requests[0]), /pull_repo/,
      "开场词要指引 pull_repo(找不到仓的 AI 会像 issue-10 一样瞎撞 git)");

    // ④ AI 拉仓路:自报收口进入分析,平台顺带切好修复分支。
    const analyzed = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm" ? issue : undefined;
    }, "拉仓后分析闸");
    assert.equal(analyzed.stage, "analyze");
    assert.equal(analyzed.stage_states?.[1], "done", "prep_repo 随自报收口完成");
    assert.equal(analyzed.stage_states?.[2], "in_progress", "分析进行中");
    assert.deepEqual(analyzed.repo_urls, [origin]);
    const root = join(dataDir, "issues", created.id);
    assert.ok(existsSync(join(root, "repo", "origin", ".git")),
      "克隆平铺在 repo/<仓名>/");
    const branch = spawnSync("git", ["-C", join(root, "repo", "origin"),
      "branch", "--show-current"], { encoding: "utf-8" });
    assert.equal(branch.stdout.trim(), BRANCH, "拉仓时宿主切好修复分支");
    assert.ok(analyzed.transitions?.some((entry) =>
      /代码仓已拉取/.test(entry.note)), "拉仓留转移账");
    // 会话 A 停在分析闸即可(拉仓路已证明);不再作答,把线性剧本让给会话 B。

    // ⑤ 跳过路:无代码改动是 AI 的合法自报,prep_repo 记 done,零克隆。
    const second = service.create({
      account: "dev", title: "纯配置问题", ticket: "DTS-2026-1002", source: "dts",
    });
    const gate2 = await until(() => {
      const issue = service.get(second.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm" ? issue : undefined;
    }, "跳过路的分析闸");
    assert.equal(gate2.stage, "analyze", "complete_stage 跳过直达分析");
    assert.equal(gate2.repo_url, undefined, "跳过=无仓继续");
    assert.equal(gate2.stage_states?.[1], "done", "prep_repo 记 done(跳过)");
    assert.equal(existsSync(join(dataDir, "issues", second.id, "repo")), false,
      "跳过路径零克隆");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("业务模块映射(2026-08-28 v2):bind_module 只登记,拉仓靠 pull_repo;lookup 未命中说无匹配;零仓模块打回", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-bindmod-"));
  const origin = bareOrigin(dataDir);
  createBusinessModule(dataDir, {
    id: "media-core", name: "媒体核心", description: "播放与转码",
    owner: "dev", repositories: [origin],
  }, "tester");
  // 登记门禁(#17)要求无单登记自带模块:给一个占位模块过门,会话内
  // 绑定 media-core 仍是首次绑定(首绑与改绑的转移账文案不同)。
  createBusinessModule(dataDir, {
    id: "entry-mod", name: "入口模块", description: "登记占位",
    owner: "dev", repositories: [origin],
  }, "tester");
  // 保存口强制模块至少绑一仓,零仓夹具只能直接落盘——这里钉的是
  // bind 侧对存量零仓数据的兜底打回。
  mkdirSync(join(dataDir, "business-modules", "empty-mod"), { recursive: true });
  writeFileSync(
    join(dataDir, "business-modules", "empty-mod", "module.json"),
    `${JSON.stringify({
      id: "empty-mod", name: "空模块", description: "没绑仓",
      owner: "dev", maintainers: [], repositories: [], status: "active",
      revision: 1, assets: [],
      created_at: new Date().toISOString(), created_by: "tester",
      updated_at: new Date().toISOString(), updated_by: "tester",
    }, null, 2)}\n`,
  );
  const script: Scene[] = [
    { tool: { name: "lookup_modules", input: { keyword: "媒体" } } },
    { tool: { name: "bind_module", input: { module_id: "media-core" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 分析\n\n转码失败已定位。\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "issue", summary: "是问题:转码线程泄漏" } } },
    { text: "模块已绑、仓已拉,分析已提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    issueFlowMode: () => "fixed",
  });
  try {
    // 无单登记带模块+环境(#17 门禁):首轮即 prep_repo,Agent 检索→
    // 绑定→拉仓→分析,全在一个回合里走完(不再有平台闸,也没有宿主代
    // 克隆);登记已带同款模块时 bind_module 重绑只做事不倒转阶段。
    const created = service.create({
      account: "dev", title: "转码失败",
      moduleId: "entry-mod",
      environment: {
        hosts: ["10.0.0.8"],
        pagePassword: "page-secret",
        backendPassword: "env-shared-secret",
      },
    });
    assert.equal(created.scenario, "no_ticket");
    const analyzed = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "conclude" ? issue : undefined;
    }, "绑定拉仓后结论闸");
    assert.equal(analyzed.module_id, "media-core");
    assert.equal(analyzed.module, "媒体核心", "模块名由模块库派生");
    assert.deepEqual(analyzed.repo_urls, [origin], "模块仓并进会话登记");
    assert.equal(analyzed.stage, "conclude", "无单场景分析结论即终点节点");
    assert.ok(existsSync(
      join(dataDir, "issues", created.id, "repo", "origin", ".git")),
      "克隆由 pull_repo 落地(repo/<仓名>/ 平铺)");
    assert.ok(analyzed.transitions?.some((entry) =>
      /已绑定业务模块「媒体核心」/.test(entry.note)));

    // 工具直调(免模型):检索命中/未命中、零仓模块打回、bind 回执
    // 给出待拉仓的 pull_repo 指令、pull_repo 只落地不推进(出口是
    // complete_stage)、后期改绑与补拉不倒转阶段。
    const state: IssueSessionState = {
      id: "issue-x", account: "dev",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      title: "t", description: "", source: "dts", ticket: TICKET,
      mode: "fixed", scenario: "ticket", round: 1,
      stage_states: FIXED_TICKET_STAGES.map(() => "pending"),
      status: "idle", stage: "prep_repo", stage_note: "", stage_at: new Date().toISOString(),
    };
    const pulled: string[] = [];
    const ctx: IssueToolContext = {
      state, workspace: "/tmp/ws", dataRoot: dataDir,
      persist: () => undefined,
      pullRepo: async (url) => {
        pulled.push(url);
        return { dir: "repo/origin", cloned: true, head: "a".repeat(12) };
      },
    };
    const tools = createIssueTools(ctx) as Array<{
      name: string;
      execute: (id: string, params: any) => Promise<unknown>;
    }>;
    const byName = (name: string) => {
      const tool = tools.find((item) => item.name === name);
      assert.ok(tool, `应注册 ${name}`);
      return tool!;
    };
    const textOf = (result: unknown) =>
      (result as { content: Array<{ text: string }> }).content[0].text;
    const hit = await byName("lookup_modules").execute("x", { keyword: "媒体" });
    assert.match(textOf(hit), /media-core/);
    assert.match(textOf(hit), /媒体核心/);
    const miss = await byName("lookup_modules").execute("x", { keyword: "不存在的词" });
    assert.match(textOf(miss), /无匹配业务模块/);
    await assert.rejects(
      () => byName("bind_module").execute("x", { module_id: "empty-mod" }),
      /没有绑定代码仓/, "零仓模块必须打回,让模型转头去问用户");
    const bindReceipt = textOf(
      await byName("bind_module").execute("x", { module_id: "media-core" }));
    assert.match(bindReceipt, /pull_repo/, "绑定回执要给出逐仓拉取指令");
    assert.equal(pulled.length, 0, "bind_module 本身不克隆");
    assert.deepEqual(state.repo_urls, [origin]);
    // 首拉只落地不再机械推进;回执带注册表简报指路 complete_stage;
    // complete_stage 才把阶段推进 analyze。此后补拉/改绑不倒转阶段。
    const pullReceipt = textOf(
      await byName("pull_repo").execute("x", { url: origin }));
    assert.equal(state.stage, "prep_repo", "拉仓只落地,不机械推进");
    assert.match(pullReceipt, /complete_stage 收口/, "拉仓回执要指路出口");
    assert.match(pullReceipt, /当前阶段「拉取代码仓·建分支」/, "回执带注册表简报");
    await byName("complete_stage").execute("x", { note: "仓已拉齐" });
    assert.equal(state.stage, "analyze", "complete_stage 自报才推进问题分析");
    assert.equal(state.stage_states?.[1], "done");
    state.stage = "fix";
    await byName("pull_repo").execute("x", { url: origin });
    await byName("bind_module").execute("x", { module_id: "media-core" });
    assert.equal(state.stage, "fix", "后期的补拉与改绑只做事,不倒转阶段");
    assert.equal(pulled.length, 2, "幂等重拉照常执行(工具不猜意图)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("网管环境闸(2026-08-28):fetch_logs 缺环境举 env_needed(scope=logs);配置走 vault 不进 issue.json,配置后重试放行", async () => {
  // 直调:env 缺席 → 举 env_needed 闸 + 工具如实失败(不再让 AI 空口
  // 向用户要密码)。
  const gateState: IssueSessionState = {
    id: "issue-g", account: "dev",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    title: "t", description: "", source: "dts", ticket: TICKET,
    repo_url: "/tmp/x.git", mode: "fixed", scenario: "ticket", round: 1,
    stage_states: ["done", "done", "in_progress", "pending", "pending", "pending", "pending"],
    status: "running", stage: "analyze", stage_note: "", stage_at: new Date().toISOString(),
  };
  const directCtx: IssueToolContext = {
    state: gateState, workspace: "/tmp/ws", dataRoot: "/tmp/data",
    persist: () => undefined,
    ops: fakeOps,
    environmentPassword: () => undefined,
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(12),
    }),
  };
  const directTools = createIssueTools(directCtx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const fetchLogs = directTools.find((tool) => tool.name === "fetch_logs")!;
  assert.ok(fetchLogs);
  await assert.rejects(
    () => fetchLogs.execute("x", { services: ["TranFmaWebsite"] }),
    /已向用户发起网管环境配置请求/);
  assert.equal(gateState.gate?.kind, "env_needed");
  assert.equal(gateState.gate?.scope, "logs", "闸带用途面,决策卡据此给表单文案");

  // 端到端:无环境发起 → fetch_logs 举闸 → attachEnvironment 配置
  // (密码只进 vault)→ 清闸开平台回合 → 重试放行。
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-envgate-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "fetch_logs", input: { services: ["TranFmaWebsite"] } } },
    { text: "等待用户配置网管环境。" },
    { tool: { name: "fetch_logs", input: { services: ["TranFmaWebsite"] } } },
    { text: "环境已配置,日志已拉取。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    opsTools: fakeOps,
    issueFlowMode: () => "fixed",
  });
  try {
    // 无单登记必须带环境(#17):要测 env_needed 现场补配,登记只能走
    // 有单路(有单不带环境放行,环境缺在会话里补)。
    const created = service.create({
      account: "dev", title: "查服务日志", repoUrl: origin,
      ticket: "DTS-2026-1001", source: "dts",
    });
    const waiting = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "env_needed"
        ? issue : undefined;
    }, "env_needed 闸");
    assert.equal(waiting.gate?.scope, "logs");

    // 配置入口(POST /issues/:id/environment 的服务本体):密码进 vault,
    // 状态只有引用;闸清掉,平台开回合让 AI 重试。
    const configured = service.attachEnvironment(created.id, {
      hosts: ["10.0.0.8"], port: 22, backendPassword: "env-shared-secret",
    });
    assert.ok(configured.environment?.credential_ref, "状态里只有凭据引用");
    assert.equal(configured.gate, undefined, "配置即清闸");
    assert.ok(existsSync(join(dataDir, ".issue-environments", `${created.id}.json`)),
      "密码落在 vault 加密文件");
    const raw = readFileSync(join(dataDir, "issues", created.id, "issue.json"), "utf-8");
    assert.ok(!raw.includes("env-shared-secret"), "issue.json 永远没有密码明文");

    await until(() =>
      service.get(created.id).status === "idle" ? 1 : undefined,
    "配置后的平台回合收口");
    // 现场账:第一次 fetch_logs 因缺环境失败,第二次放行。
    const events = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8");
    const fetches = events.split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((event) => event.kind === "tool_finished"
        && event.payload?.name === "fetch_logs");
    assert.equal(fetches.length, 2);
    assert.equal(fetches[0].payload.is_error, true, "缺环境时如实失败");
    assert.notEqual(fetches[1].payload.is_error, true, "配置后重试放行");
    // 环境是开场后才补配的:开场词渲染时元信息还没有环境,密码不借闸
    // 进上下文(ADR-0003 的明文只随登记元信息走,要查调 get_issue_meta)。
    assert.doesNotMatch(JSON.stringify(model.requests), /env-shared-secret/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 催办续跑(2026-08-28 拍板 A+B):提前收嘴被推回阶段 ----

/** 直调用最小固定会话状态。 */
function fixedState(overrides: Partial<IssueSessionState> = {}): IssueSessionState {
  const now = new Date().toISOString();
  return {
    id: "issue-nudge", account: "dev",
    created_at: now, updated_at: now,
    title: "t", description: "", source: "dts", ticket: TICKET,
    repo_url: "/tmp/x.git", mode: "fixed", scenario: "ticket", round: 1,
    stage_states: FIXED_TICKET_STAGES.map(() => "pending"),
    status: "running", stage: "analyze", stage_note: "", stage_at: now,
    ...overrides,
  };
}

test("催办续跑:模型提前收嘴被推回阶段,催办词带阶段目标与出口,举卡才准停", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-nudge-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    // 第 1 回合:拉仓 → 自报收口 → 写报告 → 提前收嘴(没举卡)。
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 分析\\n\\n现象已核实。\\n' > issue-analysis.md" } } },
    { text: "先研究到这,稍后继续。" },
    // 第 2 回合(平台催办):补交分析,举「结论确认」卡——合法停机。
    { tool: { name: "submit_analysis",
      input: { conclusion: "issue", summary: "根因=连接池耗尽" } } },
    { text: "分析已提交,等确认。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    issueFlowMode: () => "fixed",
  });
  try {
    seedModule(dataDir, origin);
    const created = service.create({
      account: "dev", title: "播放器偶发黑屏", mode: "fixed",
      repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    const waiting = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "催办后举结论卡");
    // 剧本 6 幕 = 6 个请求:第 5 个请求的用户消息就是催办词。
    assert.equal(model.requests.length, 6, "收嘴一次+催办一次,请求数要对得上");
    const nudgeRequest = JSON.stringify(model.requests[4]);
    assert.match(nudgeRequest, /平台催办\(第 1\/2 次\)/, "催办词要报次数");
    assert.match(nudgeRequest, /当前阶段「问题分析」/, "催办要带上阶段定位");
    assert.match(nudgeRequest, /出口\(到什么程度算完\)/, "催办要说清出口");
    assert.equal(waiting.nudges, 1, "催办计数要入账");
    assert.equal(waiting.stage, "conclude", "无单场景提交即推进结论节点");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("催办预算:连续收嘴只催 2 次,耗尽转人工(idle+备注),不再无限续跑", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-nudge-out-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { text: "先到这。" },
    { text: "又停了。" },
    { text: "还停。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    issueFlowMode: () => "fixed",
  });
  try {
    seedModule(dataDir, origin);
    const created = service.create({
      account: "dev", title: "播放器偶发黑屏", mode: "fixed",
      repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    const parked = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "催办耗尽落 idle");
    assert.equal(model.requests.length, 4, "首轮+两次催办,共 4 个请求");
    assert.match(JSON.stringify(model.requests[2]), /第 1\/2 次/);
    assert.match(JSON.stringify(model.requests[3]), /第 2\/2 次/);
    assert.equal(parked.nudges, 3, "第三次收嘴记账但不续跑");
    assert.match(parked.stage_note, /提前收嘴/, "转人工要说人话");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("催办预算不跨回合传染:耗尽转人工后续聊重新拿满预算,再耗尽仍走同一转人工路", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-nudge-round-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    // 第 1 轮:拉仓 → 连续三次收嘴,预算 2 次耗尽落 idle(先例场景)。
    { tool: { name: "pull_repo", input: { url: origin } } },
    { text: "先到这。" },
    { text: "又停了。" },
    { text: "还停。" },
    // 第 2 轮:用户「继续」重新点火——预算必须从头计,不能带着上轮的 3。
    { text: "又停了。" },
    { text: "还停。" },
    { text: "收工。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    issueFlowMode: () => "fixed",
  });
  try {
    seedModule(dataDir, origin);
    const created = service.create({
      account: "dev", title: "播放器偶发黑屏", mode: "fixed",
      repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    const parked1 = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "第一轮催办耗尽落 idle");
    assert.equal(model.requests.length, 4, "首轮+两次催办,共 4 个请求");
    assert.equal(parked1.nudges, 3, "第一轮耗尽记账停在 3(超预算那次也入账)");
    assert.match(parked1.stage_note, /提前收嘴/);

    // 续聊重新点火:预算清零只发生在回合入口——若预算跨回合传染,
    // 第一次收嘴就会直接落 idle,后面这些催办请求根本不会发生。
    const resumed = service.reply(created.id, "继续");
    assert.equal(resumed.status, "running");
    const parked2 = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "第二轮催办耗尽落 idle");
    assert.equal(model.requests.length, 7,
      "第二轮 = 续聊 1 次 + 催办 2 次;预算若传染,这里只会有 5 个请求");
    assert.match(JSON.stringify(model.requests[5]), /第 1\/2 次/,
      "新回合第一次催办从 1 起计,不带上一轮的账");
    assert.match(JSON.stringify(model.requests[6]), /第 2\/2 次/);
    assert.equal(parked2.nudges, 3, "第二轮耗尽同样记账到 3");
    assert.match(parked2.stage_note, /提前收嘴/,
      "耗尽转人工的出口与第一轮同一写法");
    assert.match(parked2.stage_note, /发送「继续」或补充指示/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("催办谓词:阶段未收口必催;阶段收口/流水线在途/已申报等绿/自由模式豁免", () => {
  const now = new Date().toISOString();
  // 分析阶段进行中:必催。
  assert.equal(shouldNudgeFixed(fixedState()), true);
  // 自由模式没有阶段真相,不催。
  assert.equal(
    shouldNudgeFixed(fixedState({ mode: "free", scenario: undefined })), false);
  // 当前阶段已收口(如环境验证通过待归档):不催。
  assert.equal(shouldNudgeFixed(fixedState({
    stage: "deploy_verify",
    stage_states: FIXED_TICKET_STAGES.map(() => "done"),
  })), false);
  // MR 已建、流水线在途:停等流水线是出口的一部分,不催。
  const mrGreenStates = FIXED_TICKET_STAGES.map((stage, index) =>
    index < FIXED_TICKET_STAGES.indexOf("mr_green") ? "done" : "in_progress");
  assert.equal(shouldNudgeFixed(fixedState({
    stage: "mr_green",
    stage_states: mrGreenStates,
    mrs: [{ repo: "/tmp/x.git", branch: "master_dev_DTS1",
      title: "[DTS1][fix] 修复", at: now }],
    pipelines: { "/tmp/x.git": {
      sha: "0123456789abcdef", status: "running", watching: true,
      started_at: now, deadline: now, round: 1,
    } },
  })), false);
  // MR 验绿门已受理申报(在跑→受理等绿):合法停机,同停等流水线,不催。
  assert.equal(shouldNudgeFixed(fixedState({
    stage: "mr_green",
    stage_states: mrGreenStates,
    mrs: [{ repo: "/tmp/x.git", branch: "master_dev_DTS1",
      title: "[DTS1][fix] 修复", at: now }],
    mr_gate: { mrs: ["/tmp/x.git"], at: now },
  })), false);
});

test("停机白名单与出口进了提示词(B):开局契约/自由契约/催办词三处", () => {
  const opening = issueFixedOpeningPrompt(fixedState());
  assert.match(opening, /停机白名单/, "开局契约要立停机规矩");
  assert.match(opening, /出口\(到什么程度算完\)/, "当前阶段要给出出口");
  assert.match(opening, /阶段性总结不是停机理由/);
  const free = issueOpeningPrompt(fixedState({ mode: "free", scenario: undefined }));
  assert.match(free, /停机纪律/);
  const nudge = fixedNudgeNotice(fixedState(), 1, 2);
  assert.match(nudge, /平台催办\(第 1\/2 次\)/);
  assert.match(nudge, /出口\(到什么程度算完\)/);
});

// ---- 登记元信息全量进上下文 + get_issue_meta(ADR-0003 裁定落地) ----

/** 登记元信息的完整夹具:模块带两仓 + 环境四件套(页面凭据在册)。 */
function metaState(overrides: Partial<IssueSessionState> = {}): IssueSessionState {
  return fixedState({
    title: "播放器偶发黑屏",
    description: "升级后偶发,重启恢复",
    module_id: MODULE_ID,
    module: "支付核心",
    repo_url: "/tmp/x.git",
    repo_urls: ["/tmp/x.git", "/tmp/y.git"],
    environment: {
      credential_ref: "cred-1",
      name: "10.0.0.8",
      hosts: ["10.0.0.8", "10.0.0.9"],
      port: 22,
      page_account: "admin",
      page_credential_ref: "page-1",
    },
    ...overrides,
  });
}

const META_CREDENTIALS = { backend: "env-shared-secret", page: "page-secret" };

test("登记元信息块(ADR-0003):开场/续聊词渲染环境四件套明文与模块/多仓;无环境会话整段缺席", () => {
  const fixed = issueFixedOpeningPrompt(metaState(), META_CREDENTIALS);
  // 四件套明文:密码字面量就出现在渲染结果里(不脱敏)。
  assert.match(fixed, /服务器地址: 10\.0\.0\.8, 10\.0\.0\.9/);
  assert.match(fixed, /页面账号: admin/);
  assert.match(fixed, /页面密码: page-secret/);
  assert.match(fixed, /网管后台密码.*: env-shared-secret/);
  // 模块与多仓清单随登记渲染(仓走工作区相对路径)。
  assert.match(fixed, /业务模块: 支付核心\(id: pay-core\)/);
  assert.match(fixed, /repo\/x\//);
  assert.match(fixed, /repo\/y\//);
  // 自由模式同一事实源,同样带全量。
  const free = issueOpeningPrompt(
    metaState({ mode: "free", scenario: undefined }), META_CREDENTIALS);
  assert.match(free, /页面密码: page-secret/);
  assert.match(free, /env-shared-secret/);
  // 续聊词(重启重建上下文)也不让元信息断档。
  const resume = issueResumePrompt(metaState(), "继续", META_CREDENTIALS);
  assert.match(resume, /页面密码: page-secret/);
  assert.match(resume, /业务模块: 支付核心/);

  // DTS 页签发起的会话:无模块无环境,段落整段缺席,不渲染空壳。
  const bare = issueFixedOpeningPrompt(fixedState());
  assert.doesNotMatch(bare, /业务模块/);
  assert.doesNotMatch(bare, /网管环境「/);
  assert.doesNotMatch(bare, /服务器地址/);
  assert.doesNotMatch(bare, /page-secret/);

  // env_needed 闸补配的环境只有后台凭据组:页面字段缺席,后台密码在场。
  const gateOnly = issueFixedOpeningPrompt(metaState({
    environment: {
      credential_ref: "cred-1", name: "10.0.0.8",
      hosts: ["10.0.0.8"], port: 22,
    },
  }), { backend: "env-shared-secret" });
  assert.match(gateOnly, /网管后台密码.*: env-shared-secret/);
  assert.doesNotMatch(gateOnly, /页面账号/);
  assert.doesNotMatch(gateOnly, /页面密码/);
});

test("get_issue_meta 工具(ADR-0003):元信息完整 JSON 与提示词同源、密码在返回值里;无环境缺省形", async () => {
  const state = metaState();
  const tools = createIssueTools({
    state, workspace: "/tmp/ws", dataRoot: "/tmp/data",
    persist: () => undefined,
    environmentPassword: () => META_CREDENTIALS.backend,
    pagePassword: () => META_CREDENTIALS.page,
    pullRepo: async (url) => ({ dir: url, cloned: false, head: "a".repeat(12) }),
  }) as Array<{
    name: string;
    description?: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const textOf = (result: unknown) =>
    (result as { content: Array<{ text: string }> }).content[0].text;
  const tool = tools.find((entry) => entry.name === "get_issue_meta")!;
  assert.ok(tool, "get_issue_meta 应注册在工具集里");
  assert.match(tool.description!, /dts_get_ticket/,
    "工具描述要写明与 dts_get_ticket 的分工");

  const receipt = textOf(await tool.execute("x", {}));
  // 密码在返回值里(不脱敏),且与提示词同源(issueRegistrationMeta)。
  assert.match(receipt, /page-secret/);
  assert.match(receipt, /env-shared-secret/);
  assert.deepEqual(JSON.parse(receipt), issueRegistrationMeta(state, META_CREDENTIALS));
  assert.deepEqual(JSON.parse(receipt), {
    title: "播放器偶发黑屏",
    description: "升级后偶发,重启恢复",
    module: { id: MODULE_ID, name: "支付核心" },
    repos: ["/tmp/x.git", "/tmp/y.git"],
    environment: {
      name: "10.0.0.8",
      hosts: ["10.0.0.8", "10.0.0.9"],
      page_account: "admin",
      page_password: "page-secret",
      backend_password: "env-shared-secret",
    },
  });
  // 只读:调完状态一个字没变。
  assert.equal(state.gate, undefined);
  assert.equal(state.stage, "analyze");

  // 无环境会话:environment/module 键整段缺席(与工具返回风格一致)。
  const bareTools = createIssueTools({
    state: fixedState(), workspace: "/tmp/ws", dataRoot: "/tmp/data",
    persist: () => undefined,
    pullRepo: async (url) => ({ dir: url, cloned: false, head: "a".repeat(12) }),
  }) as typeof tools;
  const bare = JSON.parse(textOf(
    await bareTools.find((entry) => entry.name === "get_issue_meta")!
      .execute("x", {})));
  assert.equal("environment" in bare, false, "无环境不造空壳");
  assert.equal("module" in bare, false);
  assert.deepEqual(bare.repos, ["/tmp/x.git"]);
});

test("登记元信息进开场上下文(service 接线):vault 解出的四件套明文进模型请求,get_issue_meta 回执同源", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-meta-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "get_issue_meta", input: {} } },
    { text: "登记信息已复核,开始研究。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    issueFlowMode: () => "fixed",
  });
  try {
    seedModule(dataDir, origin);
    const created = service.create({
      account: "dev", title: "播放器偶发黑屏", mode: "fixed",
      repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "首轮收口");
    // 开场词带着 vault 解出的四件套明文与模块行(ADR-0003)。
    const opening = JSON.stringify(model.requests[0]);
    assert.match(opening, /页面密码: page-secret/);
    assert.match(opening, /env-shared-secret/);
    assert.match(opening, /业务模块: 支付核心\(id: pay-core\)/);
    // get_issue_meta 的回执进了第二个请求(工具结果回模型),密码在场。
    const followup = JSON.stringify(model.requests[1]);
    assert.match(followup, /get_issue_meta/);
    assert.match(followup, /backend_password.*env-shared-secret/);
    assert.match(followup, /page_password.*page-secret/);
    assert.match(followup, /module.*pay-core/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
