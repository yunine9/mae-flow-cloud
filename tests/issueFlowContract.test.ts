/**
 * 前后端契约快照(票 #10):服务端真实投影与 web/src/api.ts 的手工
 * 镜像类型逐字段对账。实锤债务:repo_urls 与 pipeline checks 曾在
 * 服务端长期返回而前端类型缺失,后端改字段前端零报错。
 *
 * 机制(维护成本最低的双层钉法):
 * - 期望侧 = 按 web/src/api.ts 前端类型手写的样例字面量。字面量带
 *   类型注解:前端类型加/删/改字段而样例没跟上,tsc(typecheck 与
 *   `web && npx tsc -b` 都会带上这份镜像)直接红;
 * - 实际侧 = 真起最小 IssueFlowService 会话、走 handleIssueRoutes 拿
 *   到的过线 JSON(与浏览器看到的字节同源)。assertWireShape 递归
 *   对比:对象键集合必须一致(服务端加/删/改名字段→npm test 红);
 *   原始值 typeof 必须一致(改型→红);数组用样例首元素做逐元素模板。
 * - 值本身不比对:值是运行时数据;枚举值域由类型层与语义测试守,
 *   决策卡文案可自由改字(按码裁决,文案不是协议)。
 * - 样例里显式 `undefined` 的键 = 可选字段:实际侧可缺席,不设限;
 *   键集合仍受约束(实际侧多出的键一律红)。
 * - Record 形状(如 pipelines)用单键 "*":样例值即每个条目的模板。
 *
 * 覆盖:IssueSummary(闸卡/逐仓账/流水线账/环境)、IssueDetail、
 * IssueGateCard(conclude 与 pipeline_unfixable 等)、IssueWaitingCard
 * (Agent 卡+机械派码)、pipeline_unfixable 闸卡(票 03:带 pipeline
 * 定位字段的新形状)、DtsTicketBrief/DtsTicketDetail 与列表包装。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway, type DtsGateway } from "../src/issueFlow/gateways.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import type {
  DtsTicketBrief,
  DtsTicketDetail,
  IssueDetail,
  IssueGateCard,
  IssueSummary,
  IssueWaitingCard,
} from "../web/src/api.ts";

// ---- 契约对比器 ----

/** 递归形状断言:sample 是"前端类型的手写样例",actual 是服务端过线
 * 投影。服务端字段增/删/改名/改型都在这里红;前端类型漂移在 tsc 红。 */
function assertWireShape(sample: unknown, actual: unknown, path: string): void {
  if (sample === undefined) return; // 可选字段:缺席合法,不设限
  if (Array.isArray(sample)) {
    assert.ok(Array.isArray(actual), `${path}: 服务端投影应是数组`);
    if (sample.length === 0) return; // 空模板不校验元素形状
    for (const [index, element] of (actual as unknown[]).entries()) {
      assertWireShape(sample[0], element, `${path}[${index}]`);
    }
    return;
  }
  if (typeof sample === "object" && sample !== null) {
    assert.ok(typeof actual === "object" && actual !== null
      && !Array.isArray(actual), `${path}: 服务端投影应是对象`);
    const sampleKeys = Object.keys(sample as object).sort();
    const actualKeys = Object.keys(actual as object).sort();
    // Record 模板(单键 "*"):每个实际条目都按模板比形状。
    if (sampleKeys.length === 1 && sampleKeys[0] === "*") {
      for (const key of actualKeys) {
        assertWireShape((sample as Record<string, unknown>)["*"],
          (actual as Record<string, unknown>)[key], `${path}.${key}`);
      }
      return;
    }
    for (const key of actualKeys) {
      assert.ok(sampleKeys.includes(key),
        `${path}.${key}: 服务端投影多出的字段——web/src/api.ts 镜像缺它`
        + "(repo_urls/checks 缺席的旧剧本重演)。先补镜像与样例再转绿");
    }
    for (const key of sampleKeys) {
      const expected = (sample as Record<string, unknown>)[key];
      if (expected === undefined) continue; // 可选:实际可缺席
      assert.ok(key in (actual as object),
        `${path}.${key}: 服务端投影缺字段(前端类型声明了它)`);
      assertWireShape(expected, (actual as Record<string, unknown>)[key],
        `${path}.${key}`);
    }
    return;
  }
  assert.strictEqual(typeof actual, typeof sample,
    `${path}: 字段类型漂移(样例 ${typeof sample},服务端 ${typeof actual})`);
}

/** 走一遍真路由拿到过线 JSON——契约的"实际侧"永远取这条路径,
 * 不直调服务方法(直调绕过了 JSON 序列化边界,不算过线形状)。 */
function issueGet(
  parts: string[],
  service?: IssueFlowService,
  extraRouteOptions?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    let status = 0;
    void handleIssueRoutes(
      { method: "GET" } as any,
      {
        writeHead: (code: number) => {
          status = code;
        },
        end: (payload?: string) => {
          try {
            resolve({ status, body: JSON.parse(payload ?? "{}") });
          } catch (error) {
            reject(error);
          }
        },
      } as any,
      parts,
      { issueFlow: service, authEnabled: false, ...extraRouteOptions },
    ).catch(reject);
  });
}

// ---- 会话fixture基建(与 issueFlowService/Fixed 测试同款假件) ----

/** POST 版(带 JSON 体):与浏览器同一 readBody 协议过线,登记 wire 的
 * 契约测试用——直调 service.create 绕过了 JSON 序列化边界。 */
function issuePost(
  parts: string[],
  payload: unknown,
  service?: IssueFlowService,
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const request = new EventEmitter() as any;
    request.method = "POST";
    let status = 0;
    void handleIssueRoutes(
      request,
      {
        writeHead: (code: number) => {
          status = code;
        },
        end: (output?: string) => {
          try {
            resolve({ status, body: JSON.parse(output ?? "{}") });
          } catch (error) {
            reject(error);
          }
        },
      } as any,
      parts,
      { issueFlow: service, authEnabled: false },
    ).catch(reject);
    request.emit("data", Buffer.from(JSON.stringify(payload)));
    request.emit("end");
  });
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

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

const fastPoll = {
  models: () => ({}),
  runtime: () => ({ poll_interval_s: 1, poll_timeout_s: 120 }),
};

const fakeOps = {
  async fetchLogs() {
    return { summary: "日志已拉取(测试假件)" };
  },
  async buildDeploy() {
    return { summary: "[INFO] 部署完成(测试假件)\n备份已写入 /backup" };
  },
};

const TICKET = "DTS-2026-1001";

/** 交付假件:首轮流水线即绿(带 checks 终态)——契约 fixture 只需要
 * "走到账齐"的最短路径,不演红转绿。 */
class GreenPlatform {
  private mrCount = 0;
  private statusCalls = new Map<string, number>();
  private server: ReturnType<typeof createServer> | undefined;
  baseUrl = "";

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
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
          send({
            runs: [{ status: "running" }, {
              status: "success",
              checks: [
                { dimension: "COMPILE", status: "success" },
                { dimension: "UT", status: "success" },
                { dimension: "CODECHECK", status: "success" },
              ],
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

// ---- 期望侧样例:每个字段都对照 web/src/api.ts 手写(漂移 tsc 红) ----

test("契约快照:固定流程全链的 IssueSummary/IssueDetail(终点=MR 跑绿收口)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-contract-"));
  const origin = bareOrigin(dataDir);
  const platform = new GreenPlatform();
  await platform.start();
  const commit = (message: string) =>
    `cd repo/origin && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '${message}'`;
  const script: Scene[] = [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n连接池耗尽。\\n## 证据链\\n日志:连接池耗尽。\\n## 置信度\\n高。\\n## 修改方案\\n超时回收。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis", input: { summary: "根因=连接池耗尽" } } },
    { text: "分析报告已提交,等待用户确认。" },
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 修复登录超时`) } } },
    { tool: { name: "report_ut", input: { passed: true, summary: "12/12 通过" } } },
    { tool: { name: "complete_stage", input: { note: "超时回收已实现,UT 12/12 通过" } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "MR 已申报", mrs: [origin] } } },
    { text: "MR 已创建并申报,等流水线跑绿后平台收口。" },
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
  });
  try {
    const created = service.create({
      account: "dev",
      title: "登录超时",
      description: "压测环境登录超时,疑似连接池耗尽",
      ticket: TICKET,
      source: "dts",
      repoUrl: origin,
      environment: {
        hosts: ["10.0.0.8"],
        pagePassword: "page-secret",
        backendPassword: "env-shared-secret",
      },
    });
    // 中途闸照实走:报告确认后平台才继续修(UT 在修复段)→推→MR→申报→
    // 全绿收口(ADR-0013:流程终点=MR 跑绿,归档等用户)。
    const analysisGate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
        ? issue : undefined;
    }, "首轮分析确认闸");
    // 推荐协议(ADR-0004):分析确认闸的推荐在码表里定死为放行码。
    assert.equal(analysisGate.gate!.question.questions[0].recommended,
      "confirm", "分析确认卡必须携带码表定死的推荐码");
    service.answer(created.id, {
      state_version: analysisGate.gate!.state_version,
      code: "confirm",
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" && issue.stage === "mr_green"
        && issue.stage_states?.[4] === "done"
        ? issue : undefined;
    }, "全链跑到 MR 跑绿收口(账齐的终点)");

    // 期望侧:按 web/src/api.ts 的 IssueSummary 手写,undefined 键 = 可选;
    // 环境对象也直接写成镜像类型的字面量——页面凭据两键让 tsc 的多属性
    // 检查与 assertWireShape 的逐键对账都全量生效。
    const summarySample: IssueSummary = {
      id: created.id,
      account: "dev",
      created_at: "2026-08-28T00:00:00Z",
      updated_at: "2026-08-28T00:00:00Z",
      title: "登录超时",
      description: "压测环境登录超时,疑似连接池耗尽",
      source: "dts",
      ticket: TICKET,
      repo_url: origin,
      repo_urls: [origin],
      module: undefined,
      module_id: undefined,
      baseline: undefined,
      environment: {
        credential_ref: "vault-ref",
        name: "10.0.0.8",
        hosts: ["10.0.0.8"],
        port: 22,
        page_account: "admin",
        page_credential_ref: "vault-page-ref",
      },
      scenario: "ticket",
      stage_states: ["done", "done", "done", "done", "done"],
      round: 1,
      review_active: undefined,
      // 圈选闸未举未答(skill 圈选缺席);业务知识在进 analyze 时定格,
      // 本会话没绑模块 → 空台账(字段在场=已定格,entries 空=无资产)。
      skill_selection: undefined,
      business_knowledge: { at: "2026-08-28T00:00:00Z", entries: [] },
      // 收口态没有闸:MR 验绿门放行即清,换库验证闸已封存(ADR-0013)。
      gate: undefined,
      ut: {
        passed: true, summary: "12/12 通过",
        log_path: undefined, round: 1, at: "2026-08-28T00:00:00Z",
      },
      pipelines: {
        "*": {
          sha: "a".repeat(40),
          status: "success",
          watching: false,
          started_at: "2026-08-28T00:00:00Z",
          deadline: "2026-08-28T00:10:00Z",
          checks: [{ dimension: "UT", status: "success", job: undefined, url: undefined }],
          last_error: undefined,
          round: 1,
          reds: 1,
        },
      },
      feedback: undefined,
      converted_from: undefined,
      converted_to: undefined,
      inherited_accounts: undefined,
      status: "idle",
      stage: "mr_green",
      stage_note: "全部 MR 流水线已跑绿——确认合入后可归档收口",
      stage_at: "2026-08-28T00:00:00Z",
      has_environment: true,
      nudges: undefined,
      conclusion: undefined,
      pushes: [{ repo: origin, branch: `master_dev_${TICKET}`, sha: "a".repeat(40), at: "2026-08-28T00:00:00Z" }],
      mrs: [{
        repo: origin, branch: `master_dev_${TICKET}`, title: `[${TICKET}] 修复登录超时`,
        url: "http://loop.test/mr/1", iid: "1", at: "2026-08-28T00:00:00Z",
      }],
      transitions: [{
        at: "2026-08-28T00:00:00Z", source: "platform",
        // stage 可选(fixedComplete 带、其余转移不带),模板按缺席对账。
        stage: undefined, note: "MR 验绿通过(1 个 MR 全绿):MR 已申报",
      }],
      error: undefined,
      last_reply: undefined,
    };

    const list = await issueGet(["issues"], service);
    assert.equal(list.status, 200);
    assert.ok(list.body.issues.length >= 1);
    assertWireShape(summarySample, list.body.issues[0], "GET /issues [].issues[0]");

    const detail = await issueGet(["issues", created.id], service);
    assert.equal(detail.status, 200);
    // 收口态没有等待卡(humanGate 空、闸已清):waiting 不在场。
    const detailSample: IssueDetail = { ...summarySample, waiting: undefined, has_analysis: true };
    assertWireShape(detailSample, detail.body, "GET /issues/:id");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("契约快照:无单结论闸带机器可读提案(conclude 卡的 proposal)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-contract2-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 初步定位\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n是问题(索引缺失导致全表扫描)。\\n## 证据链\\n执行计划:全表扫描。\\n## 置信度\\n高:执行计划直接指向。\\n## 修改方案\\n补索引。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis", input: { conclusion: "issue", summary: "是问题:索引缺失" } } },
    { text: "结论已提交,等待用户确认。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    createBusinessModule(dataDir, {
      id: "pay-core", name: "支付核心", description: "收单与清结算",
      owner: "dev", repositories: [origin],
    }, "tester");
    const created = service.create({
      account: "dev", title: "列表导出超时", repoUrl: origin,
      moduleId: "pay-core",
      environment: {
        hosts: ["10.0.0.8"],
        pagePassword: "page-secret",
        backendPassword: "env-shared-secret",
      },
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "结论确认闸");
    const detail = await issueGet(["issues", created.id], service);
    assert.equal(detail.status, 200);

    const gateSample: IssueGateCard = {
      id: "gate-x",
      kind: "conclude",
      state_version: 1,
      question: { questions: [{
        question: "分析结论:是问题——是问题:索引缺失",
        options: [
          { code: "issue", label: "确认是问题,挂起等提单" },
          { code: "non_issue", label: "确认非问题,闭环归档" },
          { code: "supplement", label: "有补充意见(填写补充说明)" },
        ],
        // 结论闸的推荐从 AI 提案派生(提案是问题→推荐「是问题」码)。
        recommended: "issue",
      }] },
      context: undefined,
      scope: undefined,
      skills: undefined,
      pipeline: undefined,
      proposal: {
        conclusion: "issue",
        summary: "是问题:索引缺失",
        report: join(dataDir, "issues", created.id, "issue-analysis.md"),
      },
      created_at: "2026-08-28T00:00:00Z",
    };
    assertWireShape(gateSample, detail.body.gate, "conclude 闸 .gate");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("契约快照:流水线不可修闸卡(pipeline_unfixable,带 pipeline 定位字段)", async () => {
  /** 红灯假件:状态查询首轮即终态 failed(带不可修工具的 checks 明细),
   * 产物端点回空清单——走最短路径触达分诊停机路的举闸。 */
  class RedPlatform {
    private server: ReturnType<typeof createServer> | undefined;
    baseUrl = "";
    async start(): Promise<void> {
      this.server = createServer((request, response) => {
        const send = (payload: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };
        if (request.method === "POST" && request.url === "/pipeline/trigger") {
          send({ status: "running" });
          return;
        }
        if (request.method === "GET"
            && request.url?.startsWith("/pipeline/artifacts")) {
          send({ files: [] });
          return;
        }
        if (request.method === "GET"
            && request.url?.startsWith("/pipeline/status")) {
          send({ runs: [{
            status: "failed",
            log: "CodeCheck 阶段失败",
            checks: [{
              dimension: "CODECHECK", status: "failed", tool: "SuperChecker",
              details: [{ tool: "SuperChecker", file: "src/A.java", line: 0,
                message: "规则 R1 命中" }],
            }],
          }] });
          return;
        }
        response.writeHead(404);
        response.end("{}");
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
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-contract-gate-"));
  const origin = bareOrigin(dataDir);
  const platform = new RedPlatform();
  await platform.start();
  // 「MR 已申报、流水线监看中」的最小现场:构造服务即恢复,监看器重挂
  // 表直奔红灯结算的不可修分诊举闸(与 issueFlowFixed 的夹具同款)。
  const repo = origin;
  const sha = "c".repeat(40);
  const root = join(dataDir, "issues", "issue-1");
  mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: now, updated_at: now,
    title: "不可修闸卡契约夹具", description: "", source: "dts",
    ticket: "DTS-2026-1003",
    repo_url: repo, repo_urls: [repo],
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "done", "pending"],
    status: "idle", stage: "mr_green", stage_note: "", stage_at: now,
    pushes: [{ repo, branch: "master_dev_DTS-2026-1003", sha, at: now }],
    mrs: [{ repo, branch: "master_dev_DTS-2026-1003",
      title: "[DTS-2026-1003] 不可修闸卡契约夹具",
      url: "http://loop.test/mr/1", at: now }],
    pipelines: {
      [repo]: {
        sha, status: "running", watching: true,
        started_at: now,
        deadline: new Date(Date.now() + 120_000).toISOString(),
        round: 1,
      },
    },
  }));
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    unfixableTools: ["SuperChecker"],
    gitCredential: () => ({ username: "dev", password: "git-token" }),
  });
  try {
    const gated = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "pipeline_unfixable"
        ? issue : undefined;
    }, "不可修闸举卡");
    const detail = await issueGet(["issues", "issue-1"], service);
    assert.equal(detail.status, 200);

    const gateSample: IssueGateCard = {
      id: gated.gate!.id,
      kind: "pipeline_unfixable",
      state_version: gated.gate!.state_version,
      question: { questions: [{
        question: "流水线红灯(CodeCheck)全部来自不可自动修复的工具告警"
          + "(SuperChecker)——请在交付平台处理/豁免后作答,平台会重新监看同一提交",
        options: [{ code: "resume", label: "已在平台处理/豁免,重新监看" }],
        // 人工事实卡不派推荐:宿主核验不了平台侧是否真的处理过。
        recommended: undefined,
      }] },
      context: "失败摘要/逐维度明细/镜像产物位置/处置指引(人话全文)",
      scope: undefined,
      skills: undefined,
      // 票 03 新形状:闸归属的仓与提交(作答续跑按它重置监看账)。
      pipeline: { repo: origin, sha },
      proposal: undefined,
      created_at: gated.gate!.created_at,
    };
    assertWireShape(gateSample, detail.body.gate, "pipeline_unfixable 闸 .gate");
    assert.equal(detail.body.gate.pipeline.repo, origin);
    assert.equal(detail.body.gate.pipeline.sha, sha);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("契约快照:Agent 问题卡 waiting 投影(整卡形状+机械派码+推荐码)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-contract3-"));
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "现象是必现还是偶发?", options: ["必现", "偶发"],
      recommended: "偶发",
    }] } } },
    { text: "已收到答复,继续分析。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    // 无单登记门禁(#17):要模块+环境;夹具仓不参与本测试的断言,
    // 绑个占位本地路径即可。
    createBusinessModule(dataDir, {
      id: "pay-core", name: "支付核心", description: "收单与清结算",
      owner: "dev", repositories: ["/tmp/fixture.git"],
    }, "tester");
    const created = service.create({
      account: "dev", title: "偶发黑屏",
      moduleId: "pay-core",
      environment: {
        hosts: ["10.0.0.8"],
        pagePassword: "page-secret",
        backendPassword: "env-shared-secret",
      },
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.waiting ? issue : undefined;
    }, "Agent 问题卡");
    const detail = await issueGet(["issues", created.id], service);
    assert.equal(detail.status, 200);

    const waitingSample: IssueWaitingCard = {
      waiting_id: `${created.id}:call-1`,
      state_version: 1,
      question: { questions: [{
        question: "现象是必现还是偶发?",
        options: [
          { code: "opt-0-0", label: "必现" },
          { code: "opt-0-1", label: "偶发" },
        ],
        // 推荐原文「偶发」投影成命中选项的码(Agent 卡推荐随卡下发)。
        recommended: "opt-0-1",
      }] },
      context: undefined,
      created_at: "2026-08-28T00:00:00Z",
      // gate_kind/gate_scope 是前端从 detail.gate 拼装的字段,服务端
      // waiting 投影永不携带——样例按过线实况不写这两个键。
      task_id: created.id,
      step: "AskUserQuestion",
      call_id: "call-1",
      status: "waiting",
      decision: "",
      answers: undefined,
      notes: "",
      resolved_at: "",
      reminders: 0,
    };
    assertWireShape(waitingSample, detail.body.waiting, "Agent 卡 .waiting");

    // 固定流程(无单三节点)的 summary 形状,登记转移账带首阶段。
    const summarySample: IssueSummary = {
      id: created.id,
      account: "dev",
      created_at: "2026-08-28T00:00:00Z",
      updated_at: "2026-08-28T00:00:00Z",
      title: "偶发黑屏",
      description: "",
      source: "manual",
      ticket: undefined,
      repo_url: undefined,
      repo_urls: undefined,
      module: undefined,
      module_id: undefined,
      baseline: undefined,
      environment: undefined,
      scenario: "no_ticket",
      stage_states: ["in_progress", "pending", "pending"],
      round: 1,
      review_active: undefined,
      gate: undefined,
      ut: undefined,
      pipelines: undefined,
      feedback: undefined,
      converted_from: undefined,
      converted_to: undefined,
      inherited_accounts: undefined,
      status: "waiting_user",
      stage: "prep_repo",
      stage_note: "已登记,固定流程启动",
      stage_at: "2026-08-28T00:00:00Z",
      has_environment: false,
      nudges: undefined,
      conclusion: undefined,
      pushes: undefined,
      mrs: undefined,
      transitions: [{
        at: "2026-08-28T00:00:00Z", source: "platform",
        stage: "prep_repo", note: "固定流程会话已登记(无单三节点)",
      }],
      error: undefined,
      last_reply: undefined,
    };
    const detailSample: IssueDetail = { ...summarySample, waiting: waitingSample, has_analysis: false };
    assertWireShape(detailSample, detail.body, "固定流程 GET /issues/:id");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("契约快照:DTS 列表与单据详情投影(全字段假网关)", async () => {
  /** MockDtsGateway 的罐头单缺大部分 optional 字段,钉不全契约形状;
   * 契约要的是"服务端会投影出的字段全集",假网关直接给满字段。 */
  class FullFieldDtsGateway implements DtsGateway {
    readonly mock = true;
    async listByOwner() {
      return [{
        ticket: "DTS-2026-2001",
        title: "订单列表导出超时",
        status: "开发人员实施修改",
        version: "R25C10",
        severity: "严重",
        submitter: "zhang3",
        url: "https://dts.test/t/2001",
        description: "数据量大时导出必现超时",
      }];
    }
    async detail() {
      return {
        ticket: "DTS-2026-2001",
        title: "订单列表导出超时",
        content: "【单据原文】mcpResultText 兜底展示",
        description: "<p>完整描述(detailDesc 全文)</p>",
        severity: "严重",
        version: "R25C10",
        url: "https://dts.test/t/2001",
        submitter: "zhang3",
      };
    }
    async proxyFile(): Promise<{ data: Buffer; contentType: string }> {
      throw new Error("契约测试用不到文件代理");
    }
  }
  const service = new IssueFlowService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-issue-contract4-")),
    provider: "p", model: "m", modelsJson: {},
  });
  const briefSample: DtsTicketBrief = {
    ticket: "DTS-2026-2001",
    title: "订单列表导出超时",
    status: "开发人员实施修改",
    version: "R25C10",
    severity: "严重",
    submitter: "zhang3",
    url: "https://dts.test/t/2001",
    description: "数据量大时导出必现超时",
  };
  const detailSample: DtsTicketDetail = {
    ticket: "DTS-2026-2001",
    title: "订单列表导出超时",
    content: "【单据原文】mcpResultText 兜底展示",
    description: "<p>完整描述(detailDesc 全文)</p>",
    severity: "严重",
    version: "R25C10",
    url: "https://dts.test/t/2001",
    submitter: "zhang3",
  };
  try {
    const list = await issueGet(["issues", "dts"],
      service, { dts: new FullFieldDtsGateway() });
    assert.equal(list.status, 200);
    assertWireShape({ tickets: [briefSample], mock: true },
      list.body, "GET /issues/dts");

    const detail = await issueGet(["issues", "dts", "DTS-2026-2001"],
      service, { dts: new FullFieldDtsGateway() });
    assert.equal(detail.status, 200);
    assertWireShape(detailSample, detail.body, "GET /issues/dts/:ticket");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("契约快照:POST /issues 登记新 wire 形(四件套过线,页面账号回执、密码只回引用)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-contract5-"));
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: ["/tmp/fixture.git"],
  }, "tester");
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    // 门禁过线:无单缺模块 / 缺后台密码,409 带人话直出。
    const noModule = await issuePost(
      ["issues"], { account: "dev", title: "下单超时" }, service);
    assert.equal(noModule.status, 409);
    assert.match(noModule.body.error, /必须指定业务模块/);
    const noBackend = await issuePost(["issues"], {
      account: "dev", title: "下单超时", module_id: "pay-core",
      environment: {
        hosts: ["10.0.0.8"],
        page_password: "page-pw",
        backend_password: "",
      },
    }, service);
    assert.equal(noBackend.status, 409);
    assert.match(noBackend.body.error, /网管后台密码/);

    // 全量过线:页面账号显式传入,环境回执只有引用与非密账号,两个
    // 密码本体永不过线。
    const created = await issuePost(["issues"], {
      account: "dev", title: "下单超时", module_id: "pay-core",
      environment: {
        hosts: ["10.0.0.8"],
        page_account: "ops",
        page_password: "page-pw",
        backend_password: "backend-pw",
      },
    }, service);
    assert.equal(created.status, 201);
    assert.equal(created.body.module_id, "pay-core", "模块留痕上投影");
    assert.equal(created.body.module, "支付核心", "模块名由服务端派生");
    assert.equal(created.body.environment?.page_account, "ops");
    assertWireShape({
      credential_ref: "vault-ref",
      name: "10.0.0.8",
      hosts: ["10.0.0.8"],
      port: 22,
      page_account: "ops",
      page_credential_ref: "vault-page-ref",
    }, created.body.environment, "POST /issues .environment");
    const receipt = JSON.stringify(created.body);
    assert.ok(!receipt.includes("page-pw"), "页面密码本体不过线");
    assert.ok(!receipt.includes("backend-pw"), "后台密码本体不过线");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});
