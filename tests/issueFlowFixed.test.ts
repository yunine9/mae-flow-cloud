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
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import { JEST_LOG, issue28Artifacts } from "./pipelineSamples.ts";
import {
  FIXED_TICKET_STAGES,
  shouldNudgeFixed,
  type IssuePipelineWatch,
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

/** 快速轮询的运行参数(流水线监看测试用:1s 一轮,预算 2 分钟)。
 *  evidence_retry_minutes: 0 = 关闭证据重试窗(票 82)——既有红灯系列
 *  (全缺/盲输入举卡)钉的就是"0=关,立即举卡"的现状行为;重试窗的
 *  正窗用例各自带 settings 覆盖(见下方 retryWindow 等构造)。 */
const fastPoll = {
  models: () => ({}),
  runtime: () => ({
    poll_interval_s: 1, poll_timeout_s: 120,
    evidence_retry_minutes: 0,
  }),
};

/** 证据重试窗的正窗运行参数(票 82 测试用):窗口为分钟小数(亚分钟
 *  窗口是旋钮的正当形态),节拍=窗口的 1/5,测试不等真实的 15 分钟。 */
function retryWindow(minutes: number) {
  return {
    models: () => ({}),
    runtime: () => ({
      poll_interval_s: 1, poll_timeout_s: 120,
      evidence_retry_minutes: minutes,
    }),
  };
}

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
  private readonly mergeRequests = new Map<string, { url: string; id: number }>();
  private mrCount = 0;
  private server: ReturnType<typeof createServer> | undefined;
  baseUrl = "";
  /** 首个终态为 failed 时的剧本覆盖(红灯分诊/证据分级测试用):
   *  给出 failed run 的 log 与 checks。缺省 undefined 维持原演出
   *  (log=BUILD FAILURE,无 checks——盲修复路径的回归锚)。 */
  firstFailure: { log?: string; checks?: unknown } | undefined;
  /** /pipeline/artifacts 的剧本覆盖(证据评估测试用):红灯修复链会
   *  把它镜像进会话工作区 pipeline/。缺省演一份编译失败的 build.log。 */
  firstFailureArtifacts: Array<{ name: string; text: string }> | undefined;

  constructor(
    private readonly firstTerminal: "failed" | "success" = "failed",
    /** firstTerminal 之后的终态:缺省 success(红一轮修好再绿);
     *  "failed" = 红到底(修复轮预算耗尽类测试用)。 */
    private readonly subsequentTerminal: "failed" | "success" = "success") {}

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
          const key = JSON.stringify({
            repo: body?.repo,
            source_branch: body?.source_branch,
            target_branch: body?.target_branch,
          });
          let receipt = this.mergeRequests.get(key);
          if (!receipt) {
            this.mrCount += 1;
            receipt = { url: `http://loop.test/mr/${this.mrCount}`, id: this.mrCount };
            this.mergeRequests.set(key, receipt);
          }
          send(receipt);
          return;
        }
        if (request.method === "POST" && request.url === "/pipeline/trigger") {
          send({ status: "running" });
          return;
        }
        if (request.method === "GET" && request.url?.startsWith("/pipeline/artifacts")) {
          // 失败产物假件:红灯修复链会把它镜像进会话工作区 pipeline/。
          send({ files: this.firstFailureArtifacts ?? [{
            name: "build.log",
            text: "BUILD FAILURE: 模块 notify-service 编译失败(全文堆栈省略)",
          }] });
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
            ? this.firstTerminal : this.subsequentTerminal;
          send({
            runs: [{ status: "running" }, {
              status,
              ...(status === "failed"
                ? (this.firstFailure ?? {
                    log: "BUILD FAILURE: 模块 notify-service 编译失败",
                  })
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

test("固定流程有单全链:拉单→分析闸→修改→UT→MR 红转绿收口→续聊返工→再申报→归档", async () => {
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
      "printf '# 问题分析\\n\\n现象:登录超时。\\n## 问题现象\\n演示现象。\\n## 问题根因\\n连接池耗尽。\\n## 证据链\\n日志:连接池耗尽。\\n## 置信度\\n高:日志直接指向。\\n## 修改方案\\n超时回收。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽,方案=超时回收" } } },
    { text: "分析报告已提交,等待用户确认。" },
    // 第 2 回合(用户确认报告):提交修复 → UT 上报(只记账,仍在
    // 修复段)→ 自报修复完成(UT 并入本阶段)→ 推送 → 建 MR →
    // complete_stage 申报 MR 清单(在跑→受理等绿)。
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 修复登录超时`) } } },
    { tool: { name: "report_ut", input: { passed: true, summary: "12/12 通过" } } },
    { tool: { name: "complete_stage", input: { note: "连接池超时回收已实现,UT 12/12 通过" } } },
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
    // 第 6 回合(二轮确认):改完 → UT 上报 → 自报修复完成 → 推 → MR → 申报。
    { tool: { name: "report_ut", input: { passed: true, summary: "15/15 通过" } } },
    { tool: { name: "complete_stage", input: { note: "竞态保护补丁,二轮 UT 15/15 通过" } } },
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
    // 首阶段登记即 in_progress(进度条当前节点必须亮),其余 pending。
    assert.deepEqual(created.stage_states,
      FIXED_TICKET_STAGES.map((_, index) =>
        index === 0 ? "in_progress" : "pending"));

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
    // 闸作答补记 human_decision 入事件账:CONTEXT 对"现场记录"的定义含
    // 用户决策,过程问答(事件投影)里固定流程的关键问答不能缺用户半句。
    const eventsAfterAnswer = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8");
    const gateDecision = eventsAfterAnswer.split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((event) => event.kind === "human_decision").at(-1);
    assert.ok(gateDecision, "闸作答应补记 human_decision 入事件账");
    assert.match(String(gateDecision.payload?.decision), /确认报告/);
    await until(() => {
      const issue = service.get(created.id);
      return issue.stage === "mr_green" && issue.status === "idle" ? issue : undefined;
    }, "修改+UT+推送+MR 回合收口");
    const fixing = service.get(created.id);
    assert.equal(fixing.stage_states?.[3], "done", "问题修复完成(UT 并入)");
    assert.equal(fixing.stage_states?.[4], "in_progress", "MR 跑绿进行中");
    assert.equal(fixing.pushes?.length, 1, "修复分支已推送(按仓记账)");
    assert.equal(fixing.pushes?.[0]?.repo, origin);
    assert.equal(fixing.mrs?.length, 1, "MR 已创建(按仓记账)");
    const firstMrUrl = fixing.mrs?.[0]?.url;
    const firstPushSha = fixing.pushes?.[0]?.sha;
    const branchNow = spawnSync("git",
      ["-C", join(dataDir, "issues", created.id, "repo", "origin"), "branch", "--show-current"],
      { encoding: "utf-8" });
    assert.equal(branchNow.stdout.trim(), BRANCH, "pull_repo 时宿主切的修复分支名=master_工号_单号");

    // ③ 流水线红→AI 修→再推→绿:全由宿主监看驱动,绿了自动收口
    // (ADR-0013:流程终点=MR 跑绿,收口后等用户归档)。
    const closed1 = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" && issue.stage_states?.[4] === "done"
        ? issue : undefined;
    }, "一轮:流水线红转绿后收口待归档");
    assert.equal(closed1.stage, "mr_green", "收口在终点阶段");
    assert.match(closed1.stage_note ?? "", /确认合入后可归档/);
    assert.equal(closed1.pipelines?.[origin]?.status, "success", "监看账应记全绿");
    assert.equal(closed1.mrs?.[0]?.url, firstMrUrl,
      "流水线反馈修复后必须更新同一个 MR，不能另建一张");
    assert.deepEqual(closed1.feedback?.map((item) => ({
      source: item.source,
      status: item.status,
      observed_sha: item.observed_sha,
    })), [{
      source: "pipeline",
      status: "closed",
      observed_sha: firstPushSha,
    }], "Issue Flow 建 MR 后也用统一反馈索引，并由新 HEAD 流水线闭环");
    const failedRound = platform.seen.filter((entry) =>
      entry.method === "POST" && entry.url === "/pipeline/trigger").length;
    assert.ok(failedRound >= 2, "红过一轮就要有第二轮触发(同 MR 修复再推)");
    // 红灯取证:平台失败产物已镜像进会话工作区 pipeline/,修复回合的
    // 指令里点名了它——AI 读全文修,不是只啃 1500 字摘要。
    assert.ok(existsSync(join(dataDir, "issues", created.id,
      "pipeline", "build.log")), "红灯产物应镜像到会话工作区");
    assert.match(JSON.stringify(model.requests), /失败产物全文已镜像/,
      "修复回合指令应指引 AI 读镜像产物");

    // ④ 收口后返工(ADR-0013):用户续聊说没修好,重开 mr_green 继续修
    // ——不是回退,轮次账不动;修完重推,同 MR 更新后再申报再收口。
    const shaBefore = closed1.pushes![0].sha;
    const reopened = service.reply(created.id, "并发场景仍偶发超时,继续修");
    assert.equal(reopened.stage_states?.[4], "in_progress", "收口态续聊重开本阶段");
    assert.equal(reopened.round, 1, "返工不是回退,轮次账不动");
    const reopenedRound2 = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" && issue.stage_states?.[4] === "done"
        ? issue : undefined;
    }, "返工再申报后再次收口");
    assert.equal(reopenedRound2.round, 1, "第二轮仍是返工,无回退轮次");
    assert.equal(reopenedRound2.mrs?.[0]?.url, firstMrUrl,
      "返工修复仍延用同一 MR");
    assert.ok(reopenedRound2.pushes![0].sha !== shaBefore,
      "返工产生新推送(同分支追加)");

    // ⑤ 手动归档:有 MR 记录,结论=已交付。
    const archived = await service.control(created.id, { action: "archive" });
    assert.equal(archived.status, "archived");
    assert.equal(archived.conclusion?.kind, "delivered");
    assert.equal(archived.stage, "mr_green", "归档不改写固定流程阶段词表");
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
      "printf '# 初步定位\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n是问题(索引缺失导致全表扫描)。\\n## 证据链\\n执行计划:全表扫描。\\n## 置信度\\n高:执行计划直接指向。\\n## 修改方案\\n补索引。\\n' > issue-analysis.md" } } },
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
    const archived = await service.control(created.id, { action: "archive" });
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
      "printf '# 初步定位\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n非问题(测试环境时钟漂移)。\\n## 证据链\\n时钟偏差记录。\\n## 置信度\\n高:偏差可复现。\\n## 修改方案\\n校时后观察,建议归档。\\n' > issue-analysis.md" } } },
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
      "printf '# 问题分析\\n## 问题现象\\n演示现象。\\n## 问题根因:非问题(时钟漂移误报)。\\n## 证据链\\n时钟偏差记录。\\n## 置信度\\n高。\\n## 修改方案\\n校时后观察,建议归档。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "non_issue", summary: "时钟漂移误报" } } },
    { text: "A 卡已举出。" },
    // 会话 B:同样举结论闸;答旧文案回流分析(续跑回合收口:补充意见
    // 回合未到出口,还有两次催办才落 idle)。
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n## 问题现象\\n演示现象。\\n## 问题根因:非问题(时钟漂移误报)。\\n## 证据链\\n时钟偏差记录。\\n## 置信度\\n高。\\n## 修改方案\\n校时后观察,建议归档。\\n' > issue-analysis.md" } } },
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
      "printf '# 初步定位\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n是问题(死锁)。\\n## 证据链\\n日志:死锁栈。\\n## 置信度\\n高。\\n## 修改方案\\n调整加锁顺序。\\n' > issue-analysis.md" } } },
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
      "printf '# 问题分析\\n## 问题现象\\n演示现象。\\n## 问题根因:是问题(重复请求)\\n## 证据链\\n日志:重复入账。\\n## 置信度\\n高。\\n## 修改方案\\n幂等去重。\\n' > issue-analysis.md" } } },
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
    assert.equal(converted!.stage_states?.[3], "in_progress",
      "转正后 fix 阶段必须立即点亮为当前阶段");
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

test("阶段门禁单点(免模型):工具只在所属阶段开放;UT 并入修复不挡建 MR", async () => {
  const base: IssueSessionState = {
    id: "issue-1", account: "dev",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    title: "t", description: "", source: "dts", ticket: "T1",
    repo_url: "/tmp/x.git", repo_urls: ["/tmp/x.git"],
    mode: "fixed", scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "in_progress", "pending", "pending"],
    status: "idle", stage: "fix", stage_note: "", stage_at: new Date().toISOString(),
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
  // fix 阶段:建 MR 仍被阶段门禁拒;report_ut 在本阶段开放,complete_stage 是出口。
  await assert.rejects(() => byName("create_mr").execute("x", {}),
    /阶段门禁/, "fix 阶段建 MR 必须被拒");
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
    stage_states: ["pending", "pending", "done", "done", "in_progress", "pending"],
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
  // dts_get_ticket 在 fix 阶段重查:内容照回,阶段不倒转,转移账留痕。
  base.stage = "fix";
  await byName("dts_get_ticket").execute("x", { ticket: "DTS-2026-1001" });
  assert.equal(base.stage, "fix", "重查单据不得把阶段倒回 prep_repo");
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
  assert.equal(list.length, 7, "七个测试单");
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
  // 1007 号带内嵌截图(#42):描述与正文都含 img,proxyFile 按路径回
  // 罐头 PNG,dts_get_ticket 的下载改写全链在 --dts-mock 下可演示。
  const withImage = await gateway.detail("DTS-2026-1007");
  assert.match(withImage.description ?? "", /<img src="\/v1\/nfs\/mock\//);
  assert.match(withImage.content, /<img src="\/v1\/nfs\/mock\//,
    "正文同样带 img,改写才有 URL 可换");
  const png = await gateway.proxyFile("/v1/nfs/mock/2026-1007/topology.png");
  assert.equal(png.data.subarray(0, 4).toString("latin1"), "\x89PNG",
    "罐头图必须是真图片字节,落盘后才能被识图");
  await assert.rejects(() => gateway.proxyFile("/v1/nfs/mock/404.png"), /没有这个/);
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
    stage_states: ["done", "done", "done", "done", "in_progress"],
    status: "idle", stage: "mr_green", stage_note: "", stage_at: now,
    pushes: [{ repo: origin, branch: `master_dev_DTS-2026-1002`, sha, at: now }],
    mrs: [{ repo: origin, branch: `master_dev_DTS-2026-1002`,
      title: "[DTS-2026-1002] t", at: now }],
    // MR 验绿门:申报已受理(不变量——收口当且仅当已申报且全绿;
    // 监看器绿了凭它在场收口)。
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
      return issue.stage === "mr_green"
        && issue.stage_states?.[4] === "done" && issue.status === "idle"
        ? issue : undefined;
    }, "恢复监看并在跑绿后收口待归档");
    assert.equal(done.pipelines?.[origin]?.status, "success");
    assert.equal(done.pipelines?.[origin]?.watching, false);
    assert.match(done.stage_note ?? "", /确认合入后可归档/);
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
      "printf '# 分析\n\n现象已核实。\n## 问题现象\n演示现象。\n## 问题根因\n连接池耗尽。\n## 证据链\n日志:pool exhausted。\n## 置信度\n高。\n## 修改方案\n超时回收。\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis", input: { summary: "根因=连接池耗尽" } } },
    { text: "仓已拉好,分析已提交。" },
    // 会话 B:拉单 → 收口 → 无代码改动,complete_stage 自报跳过拉仓。
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "complete_stage", input: { note: "本单为配置问题,无需代码仓" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 分析\n\n## 问题现象\n演示现象。\n## 问题根因\n配置项漂移(非代码问题)。\n## 证据链\n配置比对:超时阈值不一致。\n## 置信度\n高。\n## 修改方案\n恢复配置。\n' > issue-analysis.md" } } },
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
      "printf '# 分析\n\n转码失败已定位。\n## 问题现象\n演示现象。\n## 问题根因\n转码线程泄漏。\n## 证据链\n日志:线程数持续增长。\n## 置信度\n高。\n## 修改方案\n释放泄漏线程。\n' > issue-analysis.md" } } },
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
      "printf '# 分析\\n\\n现象已核实。\\n## 问题现象\\n演示现象。\\n## 问题根因\\n连接池耗尽。\\n## 证据链\\n日志:pool exhausted。\\n## 置信度\\n高。\\n## 修改方案\\n超时回收。\\n' > issue-analysis.md" } } },
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
  // 当前阶段已收口(如 MR 跑绿收口待归档,ADR-0013):不催。
  assert.equal(shouldNudgeFixed(fixedState({
    stage: "mr_green",
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

test("红灯修复轮预算:0=关掉自动修复,红灯留痕请人工不再开回合", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-budget0-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  await platform.start();
  const script: Scene[] = [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n连接池耗尽。\\n## 证据链\\n日志。\\n## 置信度\\n高。\\n## 修改方案\\n超时回收。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽" } } },
    { text: "分析报告已提交,等待用户确认。" },
    { tool: { name: "bash", input: { command:
      `cd repo/origin && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '[${TICKET}][fix] 修复'` } } },
    { tool: { name: "report_ut", input: { passed: true, summary: "3/3" } } },
    { tool: { name: "complete_stage", input: { note: "修复完成(UT 3/3)" } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "MR 已申报", mrs: [origin] } } },
    { text: "MR 已创建并申报,等待流水线。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: {
      models: () => ({}),
      // 预算 0 = 关掉自动修复:第一次红灯就留痕请人工(需求侧同语义)。
      runtime: () => ({ poll_interval_s: 1, poll_timeout_s: 120, repair_rounds: 0 }),
    },
    dts: new MockDtsGateway(),
    opsTools: fakeOps,
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
  });
  try {
    const created = service.create({
      account: "dev",
      title: "预算关断验收",
      ticket: TICKET,
      source: "dts",
      repoUrl: origin,
    });
    // ① 分析确认闸放行 → 走到 MR 提交,回合收口(idle 等流水线)。
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
        ? issue : undefined;
    }, "分析确认闸");
    service.answer(created.id, {
      state_version: service.get(created.id).gate!.state_version,
      code: "confirm",
    });
    await until(() => {
      const issue = service.get(created.id);
      return issue.stage === "mr_green" && issue.status === "idle" ? issue : undefined;
    }, "MR 提交回合收口");
    const requestsAfterMr = model.requests.length;

    // ② 流水线红结算:预算 0 → 不开修复回合,留痕请人工。
    await until(() => {
      const issue = service.get(created.id);
      return issue.pipelines?.[origin]?.last_error?.includes("修复轮预算耗尽")
        ? issue : undefined;
    }, "红灯预算耗尽停表");
    const exhausted = service.get(created.id);
    assert.equal(exhausted.status, "idle", "不开回合,会话停机等人");
    assert.match(exhausted.stage_note ?? "", /修复轮预算/);
    assert.equal(exhausted.pipelines?.[origin]?.watching, false);
    assert.equal(exhausted.pipelines?.[origin]?.reds, 1, "红灯计数入账");
    assert.equal(exhausted.feedback?.at(-1)?.status, "repairing",
      "红灯仍要留痕(反馈账本 repairing),人工处理后可闭环");
    // 取证照做:产物镜像不因预算关断而缺席。
    assert.ok(existsSync(join(dataDir, "issues", created.id,
      "pipeline", "build.log")), "预算关断不影响取证镜像");
    assert.equal(model.requests.length, requestsAfterMr,
      "预算耗尽后不得再有平台回合");
    // ③ 用户人工介入后发消息仍能继续(闸门不锁死会话)。
    await service.reply(created.id, "我已在平台豁免告警,请重跑确认");
    assert.equal(service.get(created.id).status, "running");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

// ---- 红灯分诊与证据分级(2026-09-01,票 02;票 03 起两条停机路 ----
// ---- 升级为平台闸):先判改代码有没有用,再评证据够不够修。    ----

/** 落一个「MR 已申报、流水线监看中」的最小现场:构造服务即恢复,
 *  监看器重挂表直奔红灯结算——分诊/分级测试不用重走全链(拉单→
 *  分析→修→推→MR 三回合),聚焦结算判定本身。watch 覆盖项供停机
 *  通知类测试预置 reds/过期 deadline(票 81),缺省维持原演出。 */
function seedMrGreenWatch(
  dataDir: string,
  repo: string,
  watch: Partial<IssuePipelineWatch> = {},
): void {
  const sha = "c".repeat(40);
  const root = join(dataDir, "issues", "issue-1");
  mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: now, updated_at: now,
    title: "红灯分诊夹具", description: "", source: "dts",
    ticket: "DTS-2026-1002",
    repo_url: repo, repo_urls: [repo],
    mode: "fixed", scenario: "ticket", round: 1,
    stage_states: [
      "done", "done", "done", "done", "done", "in_progress", "pending",
    ],
    status: "idle", stage: "mr_green", stage_note: "", stage_at: now,
    pushes: [{ repo, branch: "master_dev_DTS-2026-1002", sha, at: now }],
    mrs: [{ repo, branch: "master_dev_DTS-2026-1002",
      title: "[DTS-2026-1002] 红灯分诊夹具",
      url: "http://loop.test/mr/1", at: now }],
    pipelines: {
      [repo]: {
        sha, status: "running", watching: true,
        started_at: now,
        deadline: new Date(Date.now() + 120_000).toISOString(),
        round: 1,
        ...watch,
      },
    },
  }));
}

/** 停机通知幂等测试用:把已停表的监看账重挂(watching=true),再构造
 *  服务即走恢复路径重看同一提交——模拟"恢复重放再停机"的场景。 */
function rearmMrGreenWatch(dataDir: string, repo: string): void {
  const path = join(dataDir, "issues", "issue-1", "issue.json");
  const state = JSON.parse(readFileSync(path, "utf-8")) as {
    pipelines: Record<string, { watching: boolean }>;
  };
  state.pipelines[repo].watching = true;
  writeFileSync(path, JSON.stringify(state));
}

test("红灯分诊:失败项全在不可修名单→举卡不派回合不耗预算,作答后重置监看重看同 SHA", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-unfixable-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "CodeCheck 阶段失败",
    checks: [{
      dimension: "CODECHECK", status: "failed", tool: "SuperChecker",
      details: [{ tool: "SuperChecker", file: "src/A.java", line: 0,
        message: "规则 R1 命中" }],
    }],
  };
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const luban = new FakeLubanServer();
  await luban.start();
  // 剧本只服务作答后的续跑(全绿→complete_stage 申报提醒的 platform 回合);
  // 分诊停机路本身不许开任何平台回合。
  const model = new ScriptedModelServer([
    { text: "收到,重新申报 MR 清单。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    unfixableTools: ["SuperChecker"],
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
    notifier: new Notifier({ endpoint: luban.endpoint, fake: true }),
    linkBase: "http://work.test",
  });
  try {
    const sha = "c".repeat(40);
    const gated = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "pipeline_unfixable"
        ? issue : undefined;
    }, "不可修闸举卡");
    const gate = gated.gate!;
    // 卡面:失败摘要、逐维度明细(含工具名)、产物位置、处置指引
    // (题面+决策背景合起来看)。
    assert.equal(gate.pipeline?.repo, origin, "闸要带归属仓");
    assert.equal(gate.pipeline?.sha, sha, "闸要带归属提交(作答重看同一 SHA)");
    assert.deepEqual(gate.question.questions[0].options,
      [{ code: "resume", label: "已在平台处理/豁免,重新监看" }]);
    assert.equal(gate.question.questions[0].recommended, undefined,
      "人工事实卡不派推荐(宿主核验不了平台侧处理)");
    const face = `${gate.question.questions[0].question}\n${gate.context ?? ""}`;
    assert.match(face, /不可自动修复的工具告警\(SuperChecker\)/);
    assert.match(face, /SuperChecker\/R1\]? ?规则 R1 命中|规则 R1 命中/,
      "逐维度明细带缺陷条目");
    assert.match(face, /pipeline\/ 目录/, "镜像产物位置上卡");
    assert.match(face, /交付平台/, "处置指引点名交付平台");
    // 停表留痕照旧:不派回合、不耗预算、反馈账本 repairing、镜像照做。
    assert.equal(gated.pipelines?.[origin]?.watching, false, "监看停表");
    assert.equal(gated.pipelines?.[origin]?.reds, undefined,
      "未派修复回合就不消耗预算(需求侧同口径)");
    assert.equal(gated.feedback?.at(-1)?.status, "repairing",
      "红灯反馈账本留痕(人在平台处理后由新绿灯闭环)");
    assert.equal(model.requests.length, 0, "不得有平台回合(改代码没用)");
    assert.ok(existsSync(join(dataDir, "issues", "issue-1",
      "pipeline", "build.log")), "取证镜像照做(不因停机缺席)");
    // 小鲁班通知改走等待卡通道:说清卡在哪、要人做什么。
    const messages = await until(() =>
      luban.messages.length ? luban.messages : undefined, "小鲁班通知");
    assert.match(JSON.stringify(messages), /不可自动修复的工具\(SuperChecker\)/);
    assert.match(JSON.stringify(messages), /交付平台/);
    // 认不得的答复打回(状态未动,闸还在)。
    assert.throws(() =>
      service.answer("issue-1", { state_version: gate.state_version,
        code: "hold" }), /无法识别的验证答复/);
    assert.equal(service.get("issue-1").gate?.kind, "pipeline_unfixable",
      "打回后闸仍在场");
    // 作答:重置监看账(deadline 重置、watching=true)并重新监看同一 SHA。
    const deadlineBefore = gated.pipelines?.[origin]?.deadline ?? "";
    service.answer("issue-1", {
      state_version: gate.state_version,
      code: "resume",
      notes: "已在平台豁免规则 R1",
    });
    const rearmed = await until(() => {
      const issue = service.get("issue-1");
      const watch = issue.pipelines?.[origin];
      return issue.gate === undefined && issue.status === "idle"
        && watch?.watching && watch.status === "running"
        && watch.deadline > deadlineBefore
        ? issue : undefined;
    }, "作答后重置监看账重新挂表");
    assert.equal(rearmed.pipelines?.[origin]?.sha, sha, "同一 SHA 重新监看");
    assert.equal(rearmed.pipelines?.[origin]?.last_error, undefined,
      "上一轮红灯留痕清掉");
    // 平台侧已处理(假件第二轮终态即 success):绿了走既有结算——
    // 提醒 AI 重新申报 MR 清单(申报账在红灯时已打回)。
    await until(() => {
      const issue = service.get("issue-1");
      return issue.pipelines?.[origin]?.status === "success" ? issue : undefined;
    }, "重新监看后跑绿");
    assert.equal(service.get("issue-1").pipelines?.[origin]?.reds, 0,
      "绿灯清零红灯计数");
    const requestText = await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
    "全绿后的申报提醒回合");
    assert.match(requestText, /complete_stage/, "提醒重新申报 MR 清单");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

test("红灯分诊回归:名单在场但工具不在名单→照常派修,证据齐时点名维度", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-unfixable-miss-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "流水线运行失败",
    checks: [{
      dimension: "CODECHECK", status: "failed", tool: "SuperChecker",
      details: [{ tool: "SuperChecker", file: "src/Order.java", line: 88,
        message: "命名不规范[1002]" }],
    }],
  };
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const script: Scene[] = [{ text: "收到,按证据修。" }];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    // 名单配的是别的工具:SuperChecker 不在名单 → 拿不准宁可派修。
    unfixableTools: ["OtherChecker"],
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
  });
  try {
    await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return model.requests.length ? issue : undefined;
    }, "红灯修复回合派出");
    const requestText = JSON.stringify(model.requests);
    assert.match(requestText, /第 1\/20 次红灯/, "照常派修,文案带红灯计数");
    assert.match(requestText, /本次红灯维度\(CodeCheck\)/, "证据齐:点名维度");
    assert.match(requestText, /都有可定位的具体报错/);
    assert.doesNotMatch(requestText, /不许猜改/,
      "没有缺口维度时不该出现猜改警告");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "修复回合收口");
    assert.equal(settled.pipelines?.[origin]?.reds, 1,
      "实际派出修复回合才 reds+1");
    assert.equal(settled.feedback?.at(-1)?.status, "repairing");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("红灯证据分级:部分维度缺证据→派修但点名缺口维度不许猜改,并请人补原文", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-evidence-partial-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    // 编译有结构化明细(可修),CodeCheck 只有汇总没定位(缺口)。
    log: "流水线运行失败",
    checks: [
      { dimension: "COMPILE", status: "failed",
        details: [{ file: "src/service/Order.java", line: 88,
          message: "cannot find symbol: orderCache" }] },
      { dimension: "CODECHECK", status: "failed", tool: "SuperChecker",
        details: [{ tool: "SuperChecker", message: "规则 1002:方法超长" }] },
    ],
  };
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const script: Scene[] = [{ text: "先修有证据的维度。" }];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
  });
  try {
    await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return model.requests.length ? issue : undefined;
    }, "部分缺证据的修复回合派出");
    const requestText = JSON.stringify(model.requests);
    assert.match(requestText, /有证据的维度\(编译\/构建\)\s*照常修复/);
    assert.match(requestText, /缺口维度\(CodeCheck\)/, "缺口维度要点名");
    assert.match(requestText, /不许猜改/);
    assert.match(requestText, /CodeCheck 红灯，但没有可定位的具体报错/,
      "缺口原因(assess 的 reasons)要随回合下发");
    assert.match(requestText, /直接粘贴到会话/, "同时请人补报错原文");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "修复回合收口");
    assert.equal(settled.pipelines?.[origin]?.reds, 1,
      "部分缺也派了回合,预算照记");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("红灯证据全缺:有失败维度但零证据→举卡请人贴原文,作答回灌证据并消耗预算", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-evidence-none-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    // 只有总体失败:checks 无明细,摘要与镜像产物都不构成逐维度证据。
    log: "流水线运行失败",
    checks: [{ dimension: "COMPILE", status: "failed" }],
  };
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  // 剧本只服务作答后的修复回合;证据全缺的停机路本身不许开回合。
  const model = new ScriptedModelServer([
    { text: "收到,按回灌的原文修。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
  });
  try {
    const gated = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "pipeline_evidence"
        ? issue : undefined;
    }, "证据回灌闸举卡");
    const gate = gated.gate!;
    assert.equal(gate.pipeline?.repo, origin, "闸要带归属仓");
    assert.deepEqual(gate.question.questions[0].options,
      [{ code: "supply", label: "已粘贴报错原文,继续修复" }]);
    const face = `${gate.context ?? ""}`;
    assert.match(face, /编译\/构建/, "卡面点名失败维度");
    assert.match(face, /编译\/构建 红灯，但没有可定位的具体报错/,
      "缺口原因(assess 兜底)上卡");
    assert.match(face, /粘贴/, "指引人把原文贴进作答");
    assert.equal(gated.status, "waiting_user", "举闸即等作答");
    assert.equal(gated.pipelines?.[origin]?.watching, false, "监看停表");
    assert.equal(gated.pipelines?.[origin]?.reds, undefined,
      "举卡停机不消耗修复轮预算");
    assert.equal(gated.pipelines?.[origin]?.evidence_retry_deadline, undefined,
      "旋钮 0=关(票 82):不进证据重试窗,立即举卡");
    assert.equal(gated.feedback?.at(-1)?.status, "repairing", "留痕照记");
    assert.equal(model.requests.length, 0, "不得有平台回合(派了只会猜改)");
    // 镜像产物在场(build.log)也不给维度背书:证据评估按维度对齐,
    // 不拿"材料包非空"替代具体报错。
    assert.ok(existsSync(join(dataDir, "issues", "issue-1",
      "pipeline", "build.log")));
    // 空答复打回:码到了但原文没贴,选项标签不能冒充证据。
    assert.throws(() =>
      service.answer("issue-1", { state_version: gate.state_version,
        code: "supply" }), /报错原文/);
    assert.equal(service.get("issue-1").gate?.kind, "pipeline_evidence",
      "打回后闸仍在场");
    // 作答(自由文本主通道,只给文本不带码也受理——码从文本在场归码):
    // 原文作为人工证据注入修复回合,该轮才消耗修复轮预算(reds+1)。
    const pasted = "BUILD FAILURE: src/service/Order.java:88 "
      + "cannot find symbol: orderCache(人工从平台复制的原文)";
    service.answer("issue-1", { state_version: gate.state_version,
      decision: pasted });
    const requestText = await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
    "带着回灌证据的修复回合派出");
    assert.match(requestText, /人工从平台回灌的报错原文/,
      "回合文案带人工证据段");
    assert.match(requestText, /Order\.java:88/, "粘贴的原文随回合下发");
    assert.match(requestText, /不许猜改/);
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "修复回合收口");
    assert.equal(settled.gate, undefined, "闸随作答清场");
    assert.equal(settled.pipelines?.[origin]?.reds, 1,
      "回灌后的修复回合消耗修复轮预算(reds+1)");
    assert.equal(settled.feedback?.at(-1)?.status, "repairing");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("红灯证据分级:UT 红灯+镜像日志有 Jest 失败原文→照常派修点名维度,不举卡", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-ut-jest-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "流水线运行失败",
    checks: [{ dimension: "UT", status: "failed", tool: "build2.0" }],
  };
  // 镜像产物是前端测试失败原文:内容嗅探把它背书给 UT 维,证据评估
  // 全有→照常派修(修复回合能读到全文),不再举卡要人贴报错。
  platform.firstFailureArtifacts = [{
    name: "build_log_ut-1.txt",
    text: JEST_LOG,
  }];
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const model = new ScriptedModelServer([
    { text: "收到,按 UT 原文修。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
  });
  try {
    const requestText = await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
    "UT 红灯修复回合派出");
    assert.match(requestText, /第 1\/20 次红灯/);
    assert.match(requestText, /本次红灯维度\(UT\/覆盖率\)/,
      "UT 维有证据,点名维度照常修");
    assert.match(requestText, /都有可定位的具体报错/);
    assert.doesNotMatch(requestText, /不许猜改/,
      "证据全有时不出现猜改警告");
    assert.equal(service.get("issue-1").gate, undefined,
      "可修的红灯不得举卡");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "修复回合收口");
    assert.equal(settled.pipelines?.[origin]?.reds, 1,
      "实际派出修复回合才 reds+1");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("红灯证据 issue-28 形态:维度错配的质量门红灯从举卡变派修,兜底备注回合可见", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-issue28-"));
  const origin = bareOrigin(dataDir);
  // 真实脱敏样例:构建 record 全 SUCCESS(errorInfo 拒答),红的是质量门
  // 指标(js pass rate 99.78%<100、DT 缺陷 1),Jest 原文在 build_log 里;
  // 平台把失败维度报成 CODECHECK,缺陷归属工具 build2.0 被归类到编译维。
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "CodeCCP2.0 质量门未达标: js pass rate 99.7778 < 100, DT 缺陷 1",
    checks: [{ dimension: "CODECHECK", status: "failed",
      tool: "CodeCCP2.0" }],
  };
  platform.firstFailureArtifacts = issue28Artifacts();
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const model = new ScriptedModelServer([
    { text: "收到,按 Jest 原文修。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
  });
  try {
    // 旧行为:CodeCheck 维零证据→举 pipeline_evidence 卡要人贴原文。
    // 兜底后:镜像日志内容含可定位报错,自动派修并把错配说清。
    const requestText = await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
    "维度错配红灯自动派修(不再举卡)");
    assert.match(requestText, /本次红灯维度\(CodeCheck\)/);
    assert.match(requestText, /都有可定位的具体报错/);
    assert.match(requestText, /跨维度兜底/,
      "兜底备注回合可见,修复侧按日志原文定位");
    assert.match(requestText, /build_log_/);
    assert.equal(service.get("issue-1").gate, undefined,
      "有可修原文的质量门红灯不得举卡");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "修复回合收口");
    assert.equal(settled.pipelines?.[origin]?.reds, 1,
      "兜底派出的修复回合照常计预算");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("红灯分诊回归:名单未配置→不分诊照常派修(与需求侧空名单恒 false 同口径)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-unfixable-none-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "CodeCheck 阶段失败",
    checks: [{
      dimension: "CODECHECK", status: "failed", tool: "SuperChecker",
      details: [{ tool: "SuperChecker", file: "src/A.java", line: 0,
        message: "规则 R1 命中" }],
    }],
  };
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const script: Scene[] = [{ text: "收到,按证据修。" }];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    // 不配置名单:判定函数对空名单恒 false——照常派修(部署没表态就不拦)。
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
  });
  try {
    await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return model.requests.length ? issue : undefined;
    }, "红灯修复回合派出");
    assert.equal(service.get("issue-1").gate, undefined,
      "无名单不分诊,不得举卡");
    const requestText = JSON.stringify(model.requests);
    assert.match(requestText, /第 1\/20 次红灯/, "照常派修,文案带红灯计数");
    assert.match(requestText, /本次红灯维度\(CodeCheck\)/);
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "修复回合收口");
    assert.equal(settled.pipelines?.[origin]?.reds, 1);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

// ---- 停机通知 + 盲输入闸(票 81):放弃点主动喊人(需求侧 ----
// ---- notifyRepairStopped 同语义),盲输入并入证据回灌举卡路。 ----

test("红灯修复轮预算耗尽→小鲁班停机通知(标题/单号/原因/轮次/建议动作);同因恢复重放不重发", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-budget-notify-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed", "failed");
  platform.firstFailure = {
    log: "流水线运行失败",
    checks: [{ dimension: "COMPILE", status: "failed",
      details: [{ file: "src/service/Order.java", line: 88,
        message: "cannot find symbol: orderCache" }] }],
  };
  await platform.start();
  // 预算 1、reds 已 1:第一次红灯结算就到顶——停机喊人,不派回合。
  seedMrGreenWatch(dataDir, origin, { reds: 1 });
  const luban = new FakeLubanServer();
  await luban.start();
  // 幂等键在通知器实例内记账:两次构造服务共用同一实例(与 serve
  // 同形——通知器是进程级单例),恢复重放才验的是真幂等。
  const notifier = new Notifier({ endpoint: luban.endpoint, fake: true });
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  const buildService = () => new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: {
      models: () => ({}),
      runtime: () => ({ poll_interval_s: 1, poll_timeout_s: 120, repair_rounds: 1 }),
    },
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
    notifier,
    linkBase: "http://work.test",
  });
  const service = buildService();
  try {
    const stopped = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.pipelines?.[origin]?.last_error?.includes("修复轮预算耗尽")
        ? issue : undefined;
    }, "红灯预算耗尽停机");
    assert.equal(stopped.pipelines?.[origin]?.watching, false, "监看停表");
    assert.equal(stopped.pipelines?.[origin]?.reds, 2, "停机前记了一轮");
    assert.equal(model.requests.length, 0, "预算耗尽不开平台回合");
    // 通知到达:问题标题/单号、放弃原因、轮次(x/max)、建议动作。
    const messages = await until(() =>
      luban.messages.length ? luban.messages : undefined, "停机通知到达");
    assert.equal(messages.length, 1, "同因只发一条");
    const text = JSON.stringify(messages);
    assert.match(text, /红灯分诊夹具/, "问题标题入文案");
    assert.match(text, /DTS-2026-1002/, "单号入文案");
    assert.match(text, /连续 2 次红灯/, "轮次(x)入文案");
    assert.match(text, /1 轮\)已耗尽,自动修复已放弃/, "轮次(max)与放弃原因入文案");
    assert.match(text, /请人工查看 MR\/流水线/, "建议动作入文案");
    assert.match(text, /发消息继续/, "建议动作含续跑指引");
    // 幂等键落在 outcome 通道既有机制:会话:原因:仓:提交。
    const key = `issue-1:outcome:pipeline_repair_exhausted:${origin}:`
      + "c".repeat(40);
    assert.ok(notifier.list().some((record) => record.waiting_id === key),
      "幂等键=会话 id+原因+提交(outcome 通道 waiting_id)");
    // 同因再停机不重发:恢复重放(监看账重挂同一提交)再次停机,
    // outcome 通道凭同键幂等,用户只收一条。
    await service.shutdown().catch(() => undefined);
    rearmMrGreenWatch(dataDir, origin);
    const revived = buildService();
    try {
      await until(() => {
        const issue = revived.get("issue-1");
        return issue.pipelines?.[origin]?.watching === false ? issue : undefined;
      }, "恢复重放后再次停机");
      // 第二次停机的通知调用在停表同一同步段内完成,留一拍再对账。
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(luban.messages.length, 1, "同因恢复重放不重发");
    } finally {
      await revived.shutdown().catch(() => undefined);
    }
  } finally {
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

test("流水线轮询预算耗尽→小鲁班停机通知(过期 deadline 直落停表路);同因恢复重放不重发", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-watch-notify-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  await platform.start();
  // deadline 已过期:恢复重挂表后循环条件立刻为假,直奔停表路。
  seedMrGreenWatch(dataDir, origin, {
    deadline: new Date(Date.now() - 60_000).toISOString(),
  });
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = new Notifier({ endpoint: luban.endpoint, fake: true });
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  const buildService = () => new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
    notifier,
    linkBase: "http://work.test",
  });
  const service = buildService();
  try {
    const stopped = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.pipelines?.[origin]?.last_error === "轮询预算耗尽,请人工查看流水线"
        ? issue : undefined;
    }, "轮询预算耗尽停表");
    assert.equal(stopped.pipelines?.[origin]?.watching, false, "监看停表");
    assert.match(stopped.stage_note ?? "", /轮询预算耗尽/);
    assert.equal(model.requests.length, 0, "停表不开平台回合");
    // 通知到达:标题/单号、放弃原因、轮次、建议动作。
    const messages = await until(() =>
      luban.messages.length ? luban.messages : undefined, "停机通知到达");
    assert.equal(messages.length, 1, "同因只发一条");
    const text = JSON.stringify(messages);
    assert.match(text, /红灯分诊夹具/, "问题标题入文案");
    assert.match(text, /DTS-2026-1002/, "单号入文案");
    assert.match(text, /轮询预算耗尽/, "放弃原因入文案");
    assert.match(text, /第 1 轮验证/, "监看轮次入文案");
    assert.match(text, /请人工查看 MR\/流水线/, "建议动作入文案");
    assert.match(text, /发消息继续/, "建议动作含续跑指引");
    const key = `issue-1:outcome:pipeline_watch_timeout:${origin}:`
      + "c".repeat(40);
    assert.ok(notifier.list().some((record) => record.waiting_id === key),
      "幂等键=会话 id+原因+提交(outcome 通道 waiting_id)");
    // 同因再停机不重发:恢复重放(deadline 依旧过期)再次停表,同键幂等。
    await service.shutdown().catch(() => undefined);
    rearmMrGreenWatch(dataDir, origin);
    const revived = buildService();
    try {
      await until(() => {
        const issue = revived.get("issue-1");
        return issue.pipelines?.[origin]?.watching === false ? issue : undefined;
      }, "恢复重放后再次停表");
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(luban.messages.length, 1, "同因恢复重放不重发");
    } finally {
      await revived.shutdown().catch(() => undefined);
    }
  } finally {
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

test("盲输入闸:checks 缺席+链接式摘要+零产物→举 pipeline_evidence 卡,不派回合不耗预算", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-blind-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  // 内网实锤形态:摘要=标签+链接(会话没登录态打不开),checks 缺席,
  // 产物零镜像——三条件同时成立才拦(票 81 红线:触发面收窄)。
  platform.firstFailure = {
    log: "FAILED stage=CodeCCP2.0 job=CodeCCP2.0  detail: "
      + "https://loop.test/pipeline/1",
  };
  platform.firstFailureArtifacts = [];
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const luban = new FakeLubanServer();
  await luban.start();
  // 空剧本当金丝雀:盲输入停机路不许开任何平台回合。
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
    notifier: new Notifier({ endpoint: luban.endpoint, fake: true }),
    linkBase: "http://work.test",
  });
  try {
    const gated = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "pipeline_evidence" ? issue : undefined;
    }, "盲输入闸举卡");
    const gate = gated.gate!;
    assert.equal(gate.pipeline?.repo, origin, "闸要带归属仓");
    assert.equal(gate.pipeline?.sha, "c".repeat(40), "闸要带归属提交");
    assert.deepEqual(gate.question.questions[0].options,
      [{ code: "supply", label: "已粘贴报错原文,继续修复" }],
      "与证据全缺同一条回灌卡路");
    const face = `${gate.question.questions[0].question}\n${gate.context ?? ""}`;
    assert.match(face, /摘要只有链接且无产物/, "卡面点明盲因");
    assert.match(face, /粘贴/, "指引人把报错原文贴进作答");
    assert.match(face, /平台未返回本次失败产物/, "零产物如实说明");
    assert.doesNotMatch(face, /缺口维度/, "无 checks 就没有维度可点名");
    assert.equal(gated.status, "waiting_user", "举闸即等作答");
    assert.equal(gated.pipelines?.[origin]?.watching, false, "监看停表");
    assert.equal(gated.pipelines?.[origin]?.reds, undefined,
      "举卡停机不消耗修复轮预算");
    assert.equal(gated.pipelines?.[origin]?.evidence_retry_deadline, undefined,
      "旋钮 0=关(票 82):不进证据重试窗,立即举卡");
    assert.equal(gated.feedback?.at(-1)?.status, "repairing", "留痕照记");
    assert.equal(model.requests.length, 0, "不得有平台回合(派了只会猜改)");
    assert.equal(existsSync(join(dataDir, "issues", "issue-1",
      "pipeline", "build.log")), false, "零产物前提成立");
    // 小鲁班等待卡通知也点明盲因,人不用开网页就知道要贴原文。
    const messages = await until(() =>
      luban.messages.length ? luban.messages : undefined, "等待卡通知");
    assert.match(JSON.stringify(messages), /摘要只有链接且无产物/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

/** 盲输入闸的"能修"对照组(票 81 红线):三种情形必须照常派修零影响。
 *  各起一个独立现场,断言回合派出、无闸、reds 记一轮。 */
async function assertRepairDispatched(input: {
  what: string;
  firstFailure: { log?: string; checks?: unknown };
  /** undefined=默认演 build.log 产物在场;[]=平台零产物。 */
  artifacts?: Array<{ name: string; text: string }>;
  expect?: RegExp[];
}): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-dispatch-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = input.firstFailure;
  if (input.artifacts) platform.firstFailureArtifacts = input.artifacts;
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const model = new ScriptedModelServer([
    { text: "收到,按证据修。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
  });
  try {
    const requestText = await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
    `${input.what}:红灯修复回合派出`);
    for (const pattern of input.expect ?? []) {
      assert.match(requestText, pattern);
    }
    assert.equal(service.get("issue-1").gate, undefined,
      `${input.what}:不得举卡`);
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, `${input.what}:修复回合收口`);
    assert.equal(settled.pipelines?.[origin]?.reds, 1,
      `${input.what}:派出即记一轮预算`);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
}

test("盲输入闸不误伤:摘要有真实内容/产物在场/checks 明细三种情形照常派修", async () => {
  // ① checks 缺席但摘要有真实内容(零产物):既有默认路径,显式钉死。
  await assertRepairDispatched({
    what: "checks 缺席但摘要有真实内容",
    firstFailure: { log: "BUILD FAILURE: 模块 notify-service 编译失败" },
    artifacts: [],
    expect: [/第 1\/20 次红灯/],
  });
  // ② 产物在场(哪怕摘要只是链接):镜像产物比链接可信,放行派修。
  await assertRepairDispatched({
    what: "产物在场(摘要只是链接)",
    firstFailure: { log: "流水线失败详情: https://loop.test/pipeline/1" },
    expect: [/第 1\/20 次红灯/, /失败产物全文已镜像/],
  });
  // ③ checks 有结构化明细:失败维度在场,盲输入闸根本不进判定。
  await assertRepairDispatched({
    what: "checks 有结构化明细",
    firstFailure: {
      log: "流水线运行失败",
      checks: [{ dimension: "COMPILE", status: "failed",
        details: [{ file: "src/service/Order.java", line: 88,
          message: "cannot find symbol: orderCache" }] }],
    },
    expect: [/第 1\/20 次红灯/, /本次红灯维度\(编译\/构建\)/],
  });
});

// ---- 证据重试窗 + 同提交刹车(票 82):防假卡、防原地打转。 ----
// ---- 重试窗三不:不耗 reds、不重复通知、不白等(落盘续算)。 ----

test("证据重试窗:产物晚到自愈——先零产物进窗不举卡,窗口内补出自动派修", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-retry-heal-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "流水线运行失败",
    checks: [{ dimension: "UT", status: "failed", tool: "build2.0" }],
  };
  // 晚到剧本:红灯结算时平台还没有产物(零镜像),进重试窗;
  // 窗口内产物补出(UT 失败原文),下一拍重评应读到并自动派修。
  platform.firstFailureArtifacts = [];
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const model = new ScriptedModelServer([
    { text: "收到,按 UT 原文修。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  // 窗口 0.1 分钟=6 秒,节拍 1.2 秒一评:测试不等真实的 15 分钟。
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: retryWindow(0.1),
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
  });
  try {
    // 进窗:不举卡、不开回合、不耗预算;截止时间落盘。
    const windowed = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      const watch = issue.pipelines?.[origin];
      return watch?.evidence_retry_deadline && !watch.watching
        ? issue : undefined;
    }, "证据重试窗落盘");
    assert.equal(windowed.gate, undefined, "窗内不举卡(防假卡)");
    assert.equal(model.requests.length, 0, "窗内不开修复回合");
    assert.equal(windowed.pipelines?.[origin]?.reds, undefined,
      "重试不消耗修复轮预算");
    assert.equal(windowed.pipelines?.[origin]?.evidence_retry_attempts, 0);
    assert.ok(windowed.pipelines?.[origin]?.evidence_failure_log,
      "失败摘要落盘(重启续算的重评输入)");
    // 产物补出:下一拍重评拉到证据 → 走正常派修路径(既有分级文案)。
    platform.firstFailureArtifacts = [{
      name: "build_log_ut-1.txt",
      text: JEST_LOG,
    }];
    const requestText = await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
    "产物补出后自动派修");
    assert.match(requestText, /本次红灯维度\(UT\/覆盖率\)/,
      "证据出现走既有分级文案");
    assert.match(requestText, /失败产物全文已镜像/);
    assert.equal(service.get("issue-1").gate, undefined,
      "自愈路全程不举卡");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "修复回合收口");
    const watch = settled.pipelines?.[origin];
    assert.equal(watch?.reds, 1, "派了回合才 reds+1");
    assert.equal(watch?.evidence_retry_deadline, undefined,
      "证据出现即清重试窗字段");
    assert.equal(watch?.last_repair_sha, "c".repeat(40),
      "派修写入刹车账(上次派修提交)");
    assert.match(watch?.last_failure_summary ?? "", /UT\/覆盖率/,
      "派修写入本轮红灯摘要");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

/** "到点仍缺举卡"的双场景对照组(普通全缺 vs 盲输入):卡面必须区分
 *  两种情形,通知只发一次,全程零回合、零预算消耗。 */
async function assertCardAfterWindow(input: {
  what: string;
  firstFailure: { log?: string; checks?: unknown };
  artifacts?: Array<{ name: string; text: string }>;
  facePatterns: RegExp[];
  faceAntiPatterns?: RegExp[];
}): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-retry-card-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = input.firstFailure;
  if (input.artifacts) platform.firstFailureArtifacts = input.artifacts;
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const luban = new FakeLubanServer();
  await luban.start();
  // 空剧本当金丝雀:重试窗停机路不许开任何平台回合。
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  // 窗口 0.05 分钟=3 秒,节拍 600ms 一评。
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: retryWindow(0.05),
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
    notifier: new Notifier({ endpoint: luban.endpoint, fake: true }),
    linkBase: "http://work.test",
  });
  try {
    const windowed = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.pipelines?.[origin]?.evidence_retry_deadline
        ? issue : undefined;
    }, `${input.what}:先进重试窗(不立即举卡)`);
    assert.equal(windowed.gate, undefined, `${input.what}:窗内不举卡`);
    const gated = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "pipeline_evidence" ? issue : undefined;
    }, `${input.what}:到点举卡`);
    assert.ok((windowed.pipelines?.[origin]?.evidence_retry_attempts ?? 0) >= 0);
    const watch = gated.pipelines?.[origin];
    assert.equal(watch?.watching, false, "监看停表");
    assert.equal(watch?.reds, undefined, "到点举卡仍不耗预算");
    assert.equal(watch?.evidence_retry_deadline, undefined,
      "举卡即清重试窗字段");
    assert.match(watch?.last_error ?? "", /重评 .* 次/,
      "留痕带上已试次数");
    const face = `${gated.gate!.question.questions[0].question}`
      + `\n${gated.gate!.context ?? ""}`;
    for (const pattern of input.facePatterns) assert.match(face, pattern);
    for (const pattern of input.faceAntiPatterns ?? []) {
      assert.doesNotMatch(face, pattern);
    }
    assert.equal(model.requests.length, 0, "全程零平台回合");
    // 通知只此一次:举卡走等待卡通道,等一拍确认不重发。
    await until(() => luban.messages.length ? luban.messages : undefined,
      `${input.what}:等待卡通知`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(luban.messages.length, 1,
      `${input.what}:整个重试窗生命周期只通知一次`);
    assert.match(JSON.stringify(luban.messages), /粘贴/,
      "通知指引人贴报错原文");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
}

test("证据重试窗:到点仍缺举卡——通知一次,卡面区分普通全缺与盲输入", async () => {
  // 场景一(普通全缺):checks 有失败维度但零明细,卡面点名缺口维度。
  await assertCardAfterWindow({
    what: "普通全缺",
    firstFailure: {
      log: "流水线运行失败",
      checks: [{ dimension: "COMPILE", status: "failed" }],
    },
    facePatterns: [/缺口维度与原因/, /编译\/构建/, /粘贴/],
    faceAntiPatterns: [/盲输入原因/],
  });
  // 场景二(盲输入):checks 缺席+链接式摘要+零产物,卡面点明盲因。
  await assertCardAfterWindow({
    what: "盲输入",
    firstFailure: {
      log: "FAILED stage=CodeCCP2.0 job=CodeCCP2.0  detail: "
        + "https://loop.test/pipeline/1",
    },
    artifacts: [],
    facePatterns: [/盲输入原因/, /摘要只有链接且无产物/, /粘贴/],
    faceAntiPatterns: [/缺口维度/],
  });
});

test("证据重试窗:会话取消后循环收手——到点不举卡、不通知,字段清账", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-retry-cancel-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "流水线运行失败",
    checks: [{ dimension: "COMPILE", status: "failed" }],
  };
  platform.firstFailureArtifacts = [];
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const luban = new FakeLubanServer();
  await luban.start();
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: retryWindow(0.05),
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
    notifier: new Notifier({ endpoint: luban.endpoint, fake: true }),
    linkBase: "http://work.test",
  });
  try {
    await until(() => {
      const issue = service.get("issue-1");
      return issue.pipelines?.[origin]?.evidence_retry_deadline
        ? issue : undefined;
    }, "进窗");
    // 窗中途取消会话:终态。下一拍重评必须收手(清字段、不举卡)。
    await service.control("issue-1", { action: "cancel" });
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.pipelines?.[origin]?.evidence_retry_deadline === undefined
        ? issue : undefined;
    }, "取消后重试循环收手清账");
    assert.equal(settled.status, "canceled");
    // 熬过原截止时间:不得再举卡,也不得有任何通知。
    const deadline = new Date(Date.now() + 4_000).getTime();
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(service.get("issue-1").gate, undefined,
      "取消后到点不举卡");
    assert.equal(luban.messages.length, 0, "取消后无任何通知");
    assert.equal(model.requests.length, 0, "取消后无平台回合");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

test("证据重试窗重启续算:窗口中途重启不重置 deadline,到点仍缺才举卡", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-retry-restart-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "流水线运行失败",
    checks: [{ dimension: "COMPILE", status: "failed" }],
  };
  platform.firstFailureArtifacts = [];
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const luban = new FakeLubanServer();
  await luban.start();
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  const statePath = join(dataDir, "issues", "issue-1", "issue.json");
  const buildService = () => new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: retryWindow(0.1),
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
    notifier: new Notifier({ endpoint: luban.endpoint, fake: true }),
    linkBase: "http://work.test",
  });
  const service = buildService();
  try {
    await until(() => {
      const issue = service.get("issue-1");
      return issue.pipelines?.[origin]?.evidence_retry_deadline
        ? issue : undefined;
    }, "第一世进窗");
    const onDisk = JSON.parse(readFileSync(statePath, "utf-8")) as {
      pipelines: Record<string, { evidence_retry_deadline?: string }>;
    };
    const deadlineBefore = onDisk.pipelines[origin].evidence_retry_deadline!;
    // 窗口中途"重启":关停第一世,1.5 秒(不足 6 秒窗)后重建服务。
    await service.shutdown().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const revived = buildService();
    try {
      const onDiskAfter = JSON.parse(readFileSync(statePath, "utf-8")) as {
        pipelines: Record<string, { evidence_retry_deadline?: string }>;
      };
      assert.equal(onDiskAfter.pipelines[origin].evidence_retry_deadline,
        deadlineBefore, "重启不重置截止时间(不白等也不白送)");
      // 到点(原 deadline)行为正确:举卡一次,通知一条,零回合。
      const gated = await until(() => {
        const issue = revived.get("issue-1");
        return issue.status === "waiting_user"
          && issue.gate?.kind === "pipeline_evidence" ? issue : undefined;
      }, "续算到点举卡");
      assert.equal(gated.pipelines?.[origin]?.reds, undefined,
        "续算全程不耗预算");
      assert.equal(model.requests.length, 0, "续算不开平台回合");
      await until(() => luban.messages.length ? luban.messages : undefined,
        "续算到点通知");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.equal(luban.messages.length, 1, "跨重启仍只通知一次");
    } finally {
      await revived.shutdown().catch(() => undefined);
    }
  } finally {
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

test("重试窗守卫:已举卡的会话重启后不续算重试窗", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-retry-guard-"));
  const origin = bareOrigin(dataDir);
  // 盘上直接种"窗到点已举卡"的现场:重试窗字段已清是对的吗——不是,
  // 这里钉的是另一条守卫:闸在场时恢复路径不得把窗重新挂上再举一次。
  seedMrGreenWatch(dataDir, origin, { watching: false });
  const statePath = join(dataDir, "issues", "issue-1", "issue.json");
  const seed = JSON.parse(readFileSync(statePath, "utf-8")) as {
    pipelines: Record<string, Record<string, unknown>>;
    gate?: Record<string, unknown>;
  };
  seed.pipelines[origin].evidence_retry_deadline =
    new Date(Date.now() - 60_000).toISOString();
  seed.pipelines[origin].evidence_retry_attempts = 2;
  seed.gate = {
    id: "gate-seeded", kind: "pipeline_evidence", state_version: 0,
    question: { questions: [{ question: "请贴报错原文",
      options: [{ code: "supply", label: "已粘贴报错原文,继续修复" }] }] },
    pipeline: { repo: origin, sha: "c".repeat(40) },
    created_at: new Date().toISOString(),
  };
  writeFileSync(statePath, JSON.stringify(seed));
  // 无 platformUrl:恢复路径的续算分支与定时器照走(守卫与平台无关)。
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: { scripted: {} },
    settings: retryWindow(0.05),
    dts: new MockDtsGateway(),
    issueFlowMode: () => "fixed",
  });
  try {
    // 熬过期窗的定时器节拍:守卫必须让一切保持原样。
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const after = JSON.parse(readFileSync(statePath, "utf-8")) as {
      pipelines: Record<string, Record<string, unknown>>;
      gate?: Record<string, unknown>;
    };
    assert.equal(after.gate?.kind, "pipeline_evidence", "已举的卡不动");
    assert.equal(after.pipelines[origin].evidence_retry_deadline,
      seed.pipelines[origin].evidence_retry_deadline,
      "闸在场:恢复路径不续算重试窗(字段原样)");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("同提交刹车:修了没出新提交再红灯→停机带 AI 诊断+通知,reds 不变", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-brake-"));
  const origin = bareOrigin(dataDir);
  // 红到底:第一轮派修后,同一提交再红(重推无新提交)触发刹车。
  const platform = new LoopPlatform("failed", "failed");
  platform.firstFailure = {
    log: "流水线运行失败",
    checks: [{ dimension: "COMPILE", status: "failed",
      details: [{ file: "src/service/Order.java", line: 88,
        message: "cannot find symbol: orderCache" }] }],
  };
  await platform.start();
  // 工作区:真实克隆+交付分支(push_branch 要求克隆在场)。种子夹具的
  // sha 是假串,而 push_branch 会把台账更新为工作区真实 HEAD——把种子
  // 的提交统一改成真实 HEAD,"同 SHA 重推"才真的同 SHA。
  const clone = join(dataDir, "issues", "issue-1", "repo", "origin");
  execFileSync("git", ["clone", "-q", origin, clone], { env: GIT_ENV });
  execFileSync("git", ["-C", clone, "checkout", "-q", "-b", BRANCH],
    { env: GIT_ENV });
  execFileSync("git", ["-C", clone, "commit", "-q", "--allow-empty",
    "-m", "red commit"], { env: GIT_ENV });
  const head = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"])
    .toString().trim();
  seedMrGreenWatch(dataDir, origin, { sha: head });
  const statePath = join(dataDir, "issues", "issue-1", "issue.json");
  const seeded = JSON.parse(readFileSync(statePath, "utf-8")) as {
    pushes: Array<{ sha: string }>;
    pipelines: Record<string, { sha: string }>;
  };
  seeded.pushes[0].sha = head;
  seeded.pipelines[origin].sha = head;
  writeFileSync(statePath, JSON.stringify(seeded));
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = new Notifier({ endpoint: luban.endpoint, fake: true });
  // 第一轮派修的剧本:重推同一提交+重建 MR(没有新 commit),收口
  // 发言=诊断。
  const model = new ScriptedModelServer([
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { text: "对比了报错,这个编译告警改不动,需要平台侧处理。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
    notifier,
    linkBase: "http://work.test",
  });
  try {
    // 第一轮:照常派修并落刹车账。
    await until(() => model.requests.length ? model.requests : undefined,
      "第一轮派修");
    const dispatched = await until(() => {
      const issue = service.get("issue-1");
      return issue.pipelines?.[origin]?.last_repair_sha === head
        ? issue : undefined;
    }, "派修写入刹车账");
    assert.equal(dispatched.pipelines?.[origin]?.reds, 1);
    // 同 SHA 再红:刹车停机——不再派第二轮,reds 不变,诊断进留痕。
    const braked = await until(() => {
      const issue = service.get("issue-1");
      return issue.pipelines?.[origin]?.last_error?.includes("同一提交")
        ? issue : undefined;
    }, "同提交刹车停机");
    assert.equal(braked.pipelines?.[origin]?.reds, 1,
      "刹车不消耗修复轮预算(reds 不变)");
    assert.match(braked.stage_note ?? "", /AI 最后诊断/, "诊断写进留痕");
    assert.match(braked.stage_note ?? "", /改不动/, "诊断是会话原话");
    await until(() => luban.messages.length ? luban.messages : undefined,
      "刹车停机通知");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    // 线性剧本按场景计请求(3 场景=3 请求):判"没有第二轮派修"要看
    // 请求里有没有第二轮红灯的平台通知词。
    assert.doesNotMatch(JSON.stringify(model.requests), /第 2\/20 次红灯/,
      "刹车后不再派修复回合");
    assert.equal(luban.messages.length, 1, "同因只发一条");
    const text = JSON.stringify(luban.messages);
    assert.match(text, /红灯分诊夹具/, "问题标题入文案");
    assert.match(text, /DTS-2026-1002/, "单号入文案");
    assert.match(text, /同一提交/, "刹车原因入文案");
    assert.match(text, /改不动/, "AI 诊断入通知");
    assert.match(text, /请人工查看/, "建议动作入文案");
    const key = `issue-1:outcome:pipeline_repair_brake:${origin}:${head}`;
    assert.ok(notifier.list().some((record) => record.waiting_id === key),
      "幂等键=会话+刹车原因+仓+提交");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

test("同提交刹车对照:换新提交红灯照常派修,回合文案含上轮报错段与换思路纪律", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-brake-miss-"));
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "流水线运行失败",
    checks: [{ dimension: "COMPILE", status: "failed",
      details: [{ file: "src/service/Order.java", line: 88,
        message: "cannot find symbol: orderCache" }] }],
  };
  await platform.start();
  // 上次派修的是另一个提交("d" 串):本次红灯=新提交,不刹车照常派;
  // 盘上预置上轮报错摘要,断言它拼进回合提示词。
  seedMrGreenWatch(dataDir, origin, {
    reds: 1,
    last_repair_sha: "d".repeat(40),
    last_failure_summary: "失败维度: 编译/构建;"
      + "BUILD FAILURE: 模块 notify-service 编译失败(上一轮原文)",
  });
  const model = new ScriptedModelServer([
    { text: "收到,先对比上轮报错再修。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
    issueFlowMode: () => "fixed",
  });
  try {
    const requestText = await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
    "换新提交照常派修");
    assert.match(requestText, /第 2\/20 次红灯/, "reds 跨 SHA 累计,照常派");
    assert.match(requestText, /本次红灯维度\(编译\/构建\)/);
    assert.match(requestText,
      new RegExp(`上一轮\\(提交 ${"d".repeat(12)}\\)红灯的报错摘要`),
      "上轮报错段随回合下发");
    assert.match(requestText, /先对比是否同一处/);
    assert.match(requestText, /notify-service 编译失败/, "上轮摘要在场");
    assert.match(requestText, /同一处必须换思路/, "换思路纪律入文案");
    assert.match(requestText, /直说修不了/, "修不了出口入文案");
    assert.match(requestText, /不许重复同样的修改/, "反重复纪律入文案");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "修复回合收口");
    const watch = settled.pipelines?.[origin];
    assert.equal(watch?.reds, 2, "新提交红灯照常 reds+1");
    assert.equal(watch?.last_repair_sha, "c".repeat(40),
      "刹车账更新为本轮提交");
    assert.match(watch?.last_failure_summary ?? "", /编译\/构建/,
      "本轮红灯摘要落账");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});
