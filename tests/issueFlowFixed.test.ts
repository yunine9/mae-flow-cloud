/**
 * 固定流程(2026-08-27 拍板)的契约测试:阶段机推进、平台闸、UT/MR
 * 门禁、流水线监看(红→修→绿)、验证回退、无单挂起→关联转正、
 * MockDtsGateway、pipelineClient、恢复续表。
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
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import {
  FIXED_TICKET_STAGES,
  type IssueSessionState,
} from "../src/issueFlow/state.ts";
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
    `cd repo && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '${message}'`;
  const script: Scene[] = [
    // 第 1 回合:阶段门禁探针(换库部署在拉单阶段必须被拒)→ 拉单(机械
    // 推进 prep_repo,宿主建分支后直进 analyze)→ 写报告 → 提交举闸。
    { tool: { name: "build_deploy", input: { include_lib: false } } },
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n\\n现象:登录超时;根因:连接池耗尽;方案:超时回收。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽,方案=超时回收" } } },
    { text: "分析报告已提交,等待用户确认。" },
    // 第 2 回合(用户确认报告):提交修复 → 自报修改完成 → UT 上报 →
    // 推送 → 建 MR(流水线监看启动)。
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 修复登录超时`) } } },
    { tool: { name: "complete_stage", input: { note: "连接池超时回收已实现" } } },
    { tool: { name: "report_ut", input: { passed: true, summary: "12/12 通过" } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { text: "MR 已创建,等待流水线。" },
    // 第 3 回合(流水线红了,平台携失败项开回合):修复 → 同分支再推 →
    // 再建 MR(重新监看)。
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 补充修复告警`) } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { text: "已修复再推,等待流水线。" },
    // 第 4 回合(流水线全绿,平台推进换库验证):部署 → 平台举验证卡。
    { tool: { name: "build_deploy", input: { include_lib: false } } },
    { text: "部署完成,等待用户在环境验证。" },
    // 第 5 回合(用户验证发现问题,回退问题分析):二轮分析 → 重新举闸。
    { tool: { name: "bash", input: { command:
      "printf '\\n## 第二轮\\n\\n根因修正:回收策略缺竞态保护。\\n' >> issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { summary: "二轮:回收策略缺竞态保护" } } },
    { text: "第二轮分析已提交。" },
    // 第 6 回合(二轮确认):改完 → UT → 推 → MR。
    { tool: { name: "complete_stage", input: { note: "竞态保护补丁" } } },
    { tool: { name: "report_ut", input: { passed: true, summary: "15/15 通过" } } },
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 回收竞态保护`) } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
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
      environment: { hosts: ["10.0.0.8"], password: "env-shared-secret" },
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
      decision: "确认报告,开始问题修改",
    });
    await until(() => {
      const issue = service.get(created.id);
      return issue.stage === "mr_green" && issue.status === "idle" ? issue : undefined;
    }, "修改+UT+推送+MR 回合收口");
    const fixing = service.get(created.id);
    assert.equal(fixing.stage_states?.[3], "done", "问题修改完成");
    assert.equal(fixing.stage_states?.[4], "done", "UT 通过记账");
    assert.equal(fixing.stage_states?.[5], "in_progress", "MR 跑绿进行中");
    assert.ok(fixing.push, "修复分支已推送");
    assert.ok(fixing.mr, "MR 已创建");
    const branchNow = spawnSync("git",
      ["-C", join(dataDir, "issues", created.id, "repo"), "branch", "--show-current"],
      { encoding: "utf-8" });
    assert.equal(branchNow.stdout.trim(), BRANCH, "宿主建的修复分支名=master_工号_单号");

    // ③ 流水线红→AI 修→再推→绿:全由宿主监看驱动,绿了自动进换库验证。
    const gate2 = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "env_verify"
        ? issue : undefined;
    }, "一轮:流水线红转绿后部署举验证闸");
    assert.equal(gate2.stage, "deploy_verify");
    assert.equal(gate2.pipeline?.status, "success", "监看账应记全绿");
    const failedRound = platform.seen.filter((entry) =>
      entry.method === "POST" && entry.url === "/pipeline/trigger").length;
    assert.ok(failedRound >= 2, "红过一轮就要有第二轮触发(同 MR 修复再推)");

    // ④ 验证不通过:一律回退问题分析,轮次+1,UT/监看作废,分支 MR 延用。
    const shaBefore = service.get(created.id).push!.sha;
    service.answer(created.id, {
      state_version: gate2.gate!.state_version,
      decision: "验证发现问题(填写补充说明)",
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
    assert.equal(gate3.push!.sha, shaBefore, "分支与 MR 延用(不另开)");

    // ⑤ 二轮走完至验证通过:末阶段完成,待手动归档。
    service.answer(created.id, {
      state_version: gate3.gate!.state_version,
      decision: "确认报告,开始问题修改",
    });
    const gate4 = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "env_verify"
        && issue.round === 2 ? issue : undefined;
    }, "二轮:验证闸");
    service.answer(created.id, {
      state_version: gate4.gate!.state_version,
      decision: "验证通过",
    });
    const passed = await until(() => {
      const issue = service.get(created.id);
      return issue.status === "idle"
        && issue.stage_states?.[6] === "done" ? issue : undefined;
    }, "验证通过收尾");
    assert.equal(passed.stage, "deploy_verify", "固定流程留在自己的词表里");
    assert.equal(passed.pipeline?.status, "success");

    // ⑥ 手动归档:有 MR 记录,结论=已交付。
    const archived = service.control(created.id, { action: "archive" });
    assert.equal(archived.status, "archived");
    assert.equal(archived.conclusion?.kind, "delivered");
    assert.equal(archived.stage, "deploy_verify", "归档不改写固定流程阶段词表");
    // 秘密纪律:环境密码与 git 令牌不进模型上下文。
    const requestText = JSON.stringify(model.requests);
    assert.doesNotMatch(requestText, /env-shared-secret/);
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
    const created = service.create({
      account: "dev", title: "列表导出超时", repoUrl: origin,
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
      decision: "确认是问题,挂起等提单",
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
    const created = service.create({
      account: "dev", title: "疑似黑屏", repoUrl: origin,
      environment: { hosts: ["10.0.0.8"], password: "env-shared-secret" },
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
      decision: "确认非问题,闭环归档",
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

test("关联转正:两段式(校验过目→确认),工作区/报告/凭据继承,旧会话归档,单号唯一", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-assoc-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    // 无单会话走到挂起。
    { tool: { name: "bash", input: { command:
      "printf '# 初步定位\\n\\n结论:是问题。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "issue", summary: "是问题:死锁" } } },
    { text: "等用户确认。" },
    // 转正新会话的首轮(直接在问题修改阶段干活)。
    { tool: { name: "bash", input: { command:
      `cd repo && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '[${TICKET}][fix] 修复死锁'` } } },
    { text: "修复已就位(继承的分析报告在案)。" },
    // 第二个无单会话(查重用)。
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
    const created = service.create({
      account: "dev", title: "偶发死锁", repoUrl: origin,
      environment: { hosts: ["10.0.0.8"], password: "env-shared-secret" },
    });
    const gate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "无单结论闸");
    service.answer(created.id, {
      state_version: gate.gate!.state_version,
      decision: "确认是问题,挂起等提单",
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
    assert.ok(existsSync(join(newRoot, "repo", ".git")), "工作区(repo/)继承,免二次克隆");
    assert.ok(existsSync(join(newRoot, "issue-analysis.md")), "分析报告继承");
    const branch = spawnSync("git", ["-C", join(newRoot, "repo"), "branch", "--show-current"],
      { encoding: "utf-8" });
    assert.equal(branch.stdout.trim(), BRANCH, "宿主已在副本上用新单号建分支");
    assert.ok(existsSync(join(dataDir, ".issue-environments", `${converted!.id}.json`)),
      "环境凭据已复制到新会话");
    const old = service.get(created.id);
    assert.equal(old.status, "archived");
    assert.equal(old.conclusion?.kind, "converted");
    assert.equal(old.converted_to, converted!.id);
    assert.equal(existsSync(
      join(dataDir, ".issue-environments", `${created.id}.json`)), false,
      "旧会话凭据在复制完成后销毁");
    // 新会话首轮在问题修改阶段干活并收口。
    await until(() => {
      const issue = service.get(converted!.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "转正会话首轮收口");

    // 单号唯一:第二个挂起会话再关联同单号 → 拒。
    const second = service.create({
      account: "dev", title: "重复请求", repoUrl: origin,
    });
    const gate2 = await until(() => {
      const issue = service.get(second.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "第二个无单会话结论闸");
    service.answer(second.id, {
      state_version: gate2.gate!.state_version,
      decision: "确认是问题,挂起等提单",
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

test("阶段门禁单点(免模型):工具只在所属阶段开放,UT 没过不准建 MR", async () => {
  const base: IssueSessionState = {
    id: "issue-1", account: "dev",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    title: "t", description: "", source: "dts", ticket: "T1",
    repo_url: "/tmp/x.git", mode: "fixed", scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "in_progress", "pending", "pending"],
    status: "idle", stage: "ut", stage_note: "", stage_at: new Date().toISOString(),
    push: { branch: "master_dev_T1", sha: "a".repeat(40), at: new Date().toISOString() },
  };
  const ctx: IssueToolContext = {
    state: base,
    workspace: "/tmp/ws",
    dataRoot: "/tmp/data",
    persist: () => undefined,
    platformUrl: "http://platform.test",
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
  // UT 阶段:建 MR 被阶段门禁拒;UT 上报没过也不放行。
  await assert.rejects(() => byName("create_mr").execute("x", {}),
    /阶段门禁/, "ut 阶段建 MR 必须被拒");
  base.stage = "mr_green";
  await assert.rejects(() => byName("create_mr").execute("x", {}),
    /UT 门禁/, "没有 UT 通过记录不准建 MR");
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
    // 无凭据 + https 仓:登记直接拒,指路个人设置(门在发起前,不在克隆后)。
    service = new IssueFlowService(base);
    assert.throws(() => service!.create({
      account: "dev", title: "登录超时", ticket: "DTS-2026-1001",
      repoUrl: httpsRepo, mode: "fixed",
    }), /Git 令牌未配置.*个人设置/);
    // 自由探索同样拦:自由模式填了远端仓,克隆一样要用发起人身份。
    assert.throws(() => service!.create({
      account: "dev", title: "登录超时", repoUrl: httpsRepo, mode: "free",
    }), /Git 令牌未配置/);
    await service.shutdown();

    // 令牌在而邮箱缺:提交署名无主,同样拦。
    service = new IssueFlowService(withCred());
    assert.throws(() => service!.create({
      account: "dev", title: "登录超时", repoUrl: httpsRepo, mode: "fixed",
    }), /个人邮箱未配置.*个人设置/);
    await service.shutdown();

    // 令牌+邮箱齐:登记放行(克隆成败是后面回合的事,门禁只管身份在场)。
    service = new IssueFlowService(withCred("dev@example.com"));
    const created = service.create({
      account: "dev", title: "登录超时", repoUrl: httpsRepo, mode: "fixed",
    });
    assert.equal(created.mode, "fixed");

    // file:///本地路径仓:不碰远端,无凭据也不拦(测试/裸仓形态)。
    await service.shutdown();
    service = new IssueFlowService(base);
    const local = service.create({
      account: "dev", title: "本地裸仓问题", repoUrl: origin, mode: "fixed",
    });
    assert.ok(local.id);
    // 自由探索不填仓:纯研究形态,与凭据无关。
    const pure = service.create({ account: "dev", title: "纯现象咨询", mode: "free" });
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
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    title: "t", description: "", source: "dts", ticket: "DTS-2026-1002",
    repo_url: origin, mode: "fixed", scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "done", "in_progress", "pending"],
    status: "idle", stage: "mr_green", stage_note: "", stage_at: new Date().toISOString(),
    pipeline: {
      sha, status: "running", watching: true,
      started_at: new Date().toISOString(),
      deadline: new Date(Date.now() + 120_000).toISOString(),
      round: 1,
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
    assert.equal(done.pipeline?.status, "success");
    assert.equal(done.pipeline?.watching, false);
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
    const fixedOne = service.create({
      account: "dev", title: "默认固定", ticket: "T1", repoUrl: bareOrigin(dataDir),
      mode: undefined,
    });
    assert.equal(fixedOne.mode, "fixed");
    const freeOne = service.create({
      account: "freebird", title: "偏好自由",
    });
    assert.equal(freeOne.mode, "free", "偏好自由的用户烙印 free");
    assert.equal(freeOne.scenario, undefined);
    const forced = service.create({
      account: "dev", title: "显式自由", mode: "free",
    });
    assert.equal(forced.mode, "free", "显式入参盖过回调");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
