/**
 * 问题流 v2 的契约测试:会话多轮闭环、非问题归档、单号门禁与宿主
 * 推送、重启续聊、MCP 网关客户端。真假件语义都在这里钉死。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  execFileSync,
  spawnSync,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { IssueEnvironmentVault } from "../src/issueEnvironment.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import {
  buildIssueTimeline,
} from "../src/issueFlow/sessionView.ts";
import {
  handleIssueRoutes,
} from "../src/issueFlow/routes.ts";
import { cloneFailureMessage, GIT_AUTH_ERROR_TAG } from "../src/issueFlow/issueGit.ts";
import { loadState, type IssueSessionState } from "../src/issueFlow/state.ts";
import { buildWorksiteRecord } from "../src/issueFlow/worksiteExport.ts";
import type { SemanticEvent } from "../src/semanticEvents.ts";

test("旧词表阶段读取时迁移:在途问题不因换词表而丢阶段", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-issue-stage-"));
  const base = {
    id: "is-1", account: "dev", created_at: "2026-08-26T00:00:00Z",
    updated_at: "2026-08-26T00:00:00Z", title: "t", description: "d",
    source: "manual", status: "idle", stage_note: "", stage_at: "2026-08-26T00:00:00Z",
  };
  // 2026-08-27 换词表前的在途落盘形状(旧键直接写进 issue.json)
  const cases: Array<[string, string]> = [
    ["analyzing", "locate_root"],
    ["concluded", "done"],
    ["submitting_mr", "submit_mr"],
    ["deploying", "switch_db"],
  ];
  for (const [legacy, expected] of cases) {
    mkdirSync(join(dir, legacy), { recursive: true });
    writeFileSync(join(dir, legacy, "issue.json"),
      JSON.stringify({ ...base, stage: legacy }));
    assert.equal(loadState(join(dir, legacy))?.stage, expected,
      `旧阶段 ${legacy} 应迁移到 ${expected}`);
  }
  // 完全不认识的值:回到已登记,显示层不猜
  mkdirSync(join(dir, "strange"), { recursive: true });
  writeFileSync(join(dir, "strange", "issue.json"),
    JSON.stringify({ ...base, stage: "什么玩意" }));
  assert.equal(loadState(join(dir, "strange"))?.stage, "registered");
});

test("克隆认证失败说人话:引导去个人设置配令牌,其余保留 git 原文", () => {
  // 内网实测原文:沙箱拒绝 askpass → git 要不到用户名
  const realStderr = [
    "error: unable to read askpass response from",
    " '/home/y/code/mae-flow-cloud/.tasks/.runtime/issue-git/operation-x/reject-askpass.sh'",
    "fatal: could not read Username for 'https://szv-y.codehub.huawei.com':",
    " terminal prompts disabled",
  ].join("\n");
  const missing = cloneFailureMessage(undefined, realStderr);
  assert.ok(missing.startsWith(GIT_AUTH_ERROR_TAG),
    "认证类失败必须以机器标记打头——这是前端跳转锚(协议),人话改字不动它");
  assert.match(missing, /Git 令牌/, "必须给出去哪配的引导");
  assert.match(missing, /个人设置/);
  assert.match(missing, /重新发起/, "failed 是终态,引导只能是重新发起");
  assert.match(missing, /could not read Username/, "关键事实不吞");
  assert.ok(!missing.includes("askpass"), "沙箱内部路径不该再吓人");

  // 已配凭据但被平台拒绝 → 引导核对,并报出实际认证账号
  const rejected = cloneFailureMessage(
    { username: "y00965296", password: "wrong" },
    "fatal: Authentication failed for 'https://szv-y.codehub.huawei.com/a.git/'",
  );
  assert.ok(rejected.startsWith(GIT_AUTH_ERROR_TAG), "拒绝类同样带机器标记");
  assert.match(rejected, /拒绝/);
  assert.match(rejected, /y00965296/);
  assert.match(rejected, /Git 令牌/);

  // 非认证错误:保留 git 原文,不乱引导(也不带跳转锚)
  const other = cloneFailureMessage(undefined,
    "fatal: repository 'https://git/x.git/' not found");
  assert.match(other, /not found/);
  assert.ok(!other.includes("Git 令牌"));
  assert.ok(!other.includes(GIT_AUTH_ERROR_TAG));
});

/** 走一遍真路由(/issues/*),拿到 {status, body}——视图旁路的端到端
 * 断言都用它,免得测试里养一个 HTTP 服务器。 */
function issueGet(
  parts: string[],
  service?: IssueFlowService,
  query = "",
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    let status = 0;
    void handleIssueRoutes(
      { method: "GET", url: `/${parts.join("/")}${query}` } as any,
      {
        writeHead: (code: number) => {
          status = code;
        },
        end: (payload?: string) => {
          try {
            resolve({
              status,
              body: JSON.parse(payload ?? "{}"),
            });
          } catch (error) {
            reject(error);
          }
        },
      } as any,
      parts,
      { issueFlow: service, authEnabled: false },
    ).catch(reject);
  });
}

/** POST 版(带 JSON 体):readBody 在 request 上挂 data/end 监听,
 * 所以假请求得是个 EventEmitter。 */
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

test("问题时间线归纳(纯函数):AI 陈述→人开口配成等待段,连续 AI 消息并作一段", () => {
  const timeline = buildIssueTimeline({
    state: {
      created_at: "2026-08-26T08:00:00Z",
      updated_at: "2026-08-26T09:00:00Z",
      status: "idle",
      stage_note: "",
      transitions: [
        { at: "2026-08-26T08:10:00Z", source: "agent",
          stage: "locate_root", note: "初步定位" },
        { at: "2026-08-26T08:40:00Z", source: "platform",
          stage: "submit_mr", note: "推送成功" },
      ],
    },
    messages: [
      { role: "user", text: "播放器偶发黑屏", ts: "2026-08-26T08:00:00Z" },
      { role: "assistant", text: "先查日志与代码", ts: "2026-08-26T08:05:00Z" },
      { role: "assistant", text: "需要确认:现象必现还是偶发?",
        ts: "2026-08-26T08:06:00Z" },
      { role: "decision", text: "用户决定: 必现", ts: "2026-08-26T08:16:00Z" },
      { role: "assistant", text: "结论为非问题", ts: "2026-08-26T08:30:00Z" },
    ],
  });
  // 尾部 assistant 后没有回应,状态也不是 waiting_user:不算等待段。
  assert.equal(timeline.human_waits.length, 1);
  const wait = timeline.human_waits[0];
  assert.equal(wait.start, "2026-08-26T08:05:00Z",
    "等待起点取连续 AI 陈述的首条");
  assert.equal(wait.end, "2026-08-26T08:16:00Z");
  assert.equal(wait.ms, 11 * 60_000);
  assert.match(wait.question, /偶发\?$/,
    "问句节选取末条 AI 消息(人作答前看到的最后一句话)");
  assert.equal(wait.open_ended, undefined);

  assert.equal(timeline.decisions, 1, "decision 角色消息计一次决策");
  assert.equal(timeline.human_wait_ms, 11 * 60_000);
  assert.equal(timeline.longest_waits.length, 1);
  // 区间 = 开场 08:00 → 最近活动(updated_at 09:00);占比四舍五入
  assert.equal(timeline.span.ms, 60 * 60_000);
  assert.equal(timeline.human_wait_share, 18);

  // 关键事件 = 结论节选 + 决策 + 阶段切换(带来源标记),按时间正序
  assert.deepEqual(timeline.events.map((event) => event.kind),
    ["assistant", "assistant", "stage", "decision", "assistant", "stage"]);
  const stageAgent = timeline.events.find((event) =>
    event.kind === "stage")!;
  assert.equal(stageAgent.source, "agent");
  assert.equal(stageAgent.detail, "初步定位");
  const stagePlatform = timeline.events.at(-1)!;
  assert.equal(stagePlatform.source, "platform");
});

test("问题时间线归纳(纯函数):waiting_user 未决段以 now 封口;坏数据一律空表不炸", () => {
  const timeline = buildIssueTimeline({
    state: {
      status: "waiting_user",
      created_at: "2026-08-26T08:00:00Z",
      updated_at: "2026-08-26T08:20:00Z",
      stage_note: "等你确认换库方案",
    },
    messages: [{ role: "assistant", text: "是否同意切换数据库?",
      ts: "2026-08-26T08:15:00Z" }],
    waiting: { created_at: "2026-08-26T08:14:00Z" },
    now: "2026-08-26T08:24:00Z",
  });
  assert.equal(timeline.human_waits.length, 1);
  const wait = timeline.human_waits[0];
  assert.equal(wait.open_ended, true, "问题卡还开着就是此刻仍在等");
  assert.equal(wait.start, "2026-08-26T08:14:00Z",
    "卡片 created_at 是权威起点,不退回 AI 消息时间");
  assert.equal(wait.end, undefined);
  assert.equal(wait.ms, 10 * 60_000);
  assert.equal(timeline.human_wait_ms, 10 * 60_000);
  // 未决等待以 now 封口 → 区间同样延伸到 now(08:00→08:24)
  assert.equal(timeline.span.ms, 24 * 60_000);
  assert.ok(timeline.span.end.startsWith("2026-08-26T08:24"),
    "区间终点字符串与毫秒数同一口径(延伸到 now)");
  assert.equal(timeline.human_wait_share, 42);
  assert.match(timeline.blocker, /切换数据库/, "卡点=还在等的问句");
  assert.deepEqual(timeline.longest_waits, [wait]);
  // 无 stage 的转移账条目不上关键事件墙
  assert.deepEqual(timeline.events.map((event) => event.kind),
    ["assistant"]);

  // 极端输入:空对象 → 空形状,绝不抛错(fail-open 红线)
  assert.deepEqual(buildIssueTimeline({}), {
    span: { start: "", end: "", ms: 0 },
    human_waits: [],
    human_wait_ms: 0,
    human_wait_share: 0,
    longest_waits: [],
    decisions: 0,
    blocker: "",
    events: [],
  });

  // 坏时间戳:配不成对的等待放弃、坏时刻的事件缺席,区间归零
  const odd = buildIssueTimeline({
    state: { created_at: "不是时间", updated_at: "", status: "idle" },
    messages: [
      { role: "assistant", text: "", ts: "昨天" },
      { role: "user", text: "哦", ts: "明天吧" },
    ],
  });
  assert.equal(odd.human_waits.length, 0);
  assert.equal(odd.events.length, 0);
  assert.equal(odd.span.ms, 0);
});

test("视图旁路路由:过程文档缺失是 200 {unavailable};残缺现场问答投影 fail-open", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-view-"));
  mkdirSync(join(dataDir, "issues", "issue-1"), { recursive: true });
  writeFileSync(join(dataDir, "issues", "issue-1", "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: "2026-08-26T08:00:00Z",
    updated_at: "2026-08-26T09:00:00Z",
    title: "t", description: "", source: "manual",
    status: "idle", stage: "locate_root", stage_note: "",
    stage_at: "2026-08-26T09:00:00Z",
    // 没有 stage 的转移条目不上关键事件墙
    transitions: [{ at: "2026-08-26T08:30:00Z", source: "agent",
      note: "只是备注,不是阶段切换" }],
  }));
  // 半行 JSON(写入方还在写)必须被跳过,不能让视图接口 5xx。
  writeFileSync(join(dataDir, "issues", "issue-1", "events.jsonl"),
    '{"kind":"user_mess\n'
    + JSON.stringify({ kind: "user_message", ts: "2026-08-26T08:00:00Z",
      payload: { text: "开场" } }) + "\n");
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  return (async () => {
    try {
      const docs = await issueGet(["issues", "issue-1", "documents"], service);
      assert.equal(docs.status, 200, "清单 fail-open:没有 .md 给空清单,不报错");
      assert.deepEqual(docs.body.documents, []);

      const missing = await issueGet(
        ["issues", "issue-1", "documents", "read"], service,
        "?name=issue-analysis.md");
      assert.equal(missing.status, 200,
        "问题号存在但文档缺失=200 {unavailable},不是 404");
      assert.equal(missing.body.unavailable, "文档不存在");

      const dialogue = await issueGet(["issues", "issue-1", "dialogue"], service);
      assert.equal(dialogue.status, 200);
      assert.equal(dialogue.body.turns.length, 1,
        "残行跳过,有效的 user_message 照投影");
      assert.equal(dialogue.body.turns[0].kind, "user");
      assert.equal(dialogue.body.turns[0].text, "开场");

      const timeline = await issueGet(
        ["issues", "issue-1", "timeline"], service);
      assert.equal(timeline.status, 200);
      assert.deepEqual(timeline.body.human_waits, []);
      assert.equal(timeline.body.decisions, 0);
      assert.deepEqual(timeline.body.events, [],
        "无 stage 的转移与残行都不上关键事件");
      assert.ok(timeline.body.span.start.includes("2026-08-26"));
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  })();
});
import { TaskService } from "../src/taskService.ts";
import { createGoOpsTools } from "../src/issueFlow/opsTools.ts";
import {
  McpGateway,
  UnconfiguredDtsGateway,
} from "../src/issueFlow/gateways.ts";

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
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("问题会话多轮闭环:研究→提问卡→作答→非问题归档(无内核参与)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-flow2-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "report_stage",
      input: { stage: "locate_root", note: "从日志与代码初步定位" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 根因分析\\n\\n结论:非问题(测试环境时钟漂移导致的误报)。\\n' > issue-analysis.md" } } },
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "分析结论是非问题(误报),确认归档收口?",
      options: ["确认归档", "继续研究"],
      recommended: "确认归档",
    }] } } },
    { tool: { name: "report_stage",
      input: { stage: "done", note: "非问题:误报" } } },
    { text: "研究完成:结论为非问题,证据已写入 issue-analysis.md,建议归档。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    createBusinessModule(dataDir, {
      id: "pay-core", name: "支付核心", description: "收单与清结算",
      owner: "dev", repositories: [origin],
    }, "tester");
    const created = service.create({
      account: "dev",
      title: "播放器偶发黑屏",
      description: "测试环境偶发黑屏,疑似新版本引入",
      repoUrl: origin,
      moduleId: "pay-core",
      environment: {
        hosts: ["10.0.0.8"],
        pagePassword: "page-secret",
        backendPassword: "env-shared-secret",
      },
    });
    // create() 即刻排入首轮研究(并发额度内同步点火,状态直奔 running)。
    assert.equal(created.status, "running");
    assert.equal(created.ticket, undefined, "先研究后补单:创建时单号可空");
    // 四件套落盘形状:页面账号是非密的登记元信息,回执可见;密码本体
    // 只在 vault,状态文件与回执都搜不到。
    assert.equal(created.environment?.page_account, "admin",
      "页面账号未传缺省 admin");
    assert.ok(created.environment?.page_credential_ref);
    assert.ok(!JSON.stringify(created).includes("page-secret"));
    assert.ok(!existsSync(join(dataDir, "issues", created.id, "repo", ".mae-flow.json")),
      "问题会话不初始化内核(与需求流分属两个范式)");

    // vault 两组凭据各自成组、可分别解出:后台三账号同密码,页面单账号。
    const vault = new IssueEnvironmentVault(dataDir);
    assert.deepEqual(
      vault.credentials(created.id, created.environment!.credential_ref)
        .map((account) => account.username),
      ["sopuser", "ossuser", "ossadm"]);
    assert.equal(vault.credential(created.id,
      created.environment!.credential_ref, "sopuser")?.password,
      "env-shared-secret");
    assert.deepEqual(vault.credential(created.id,
      created.environment!.page_credential_ref!),
      { username: "admin", password: "page-secret" });

    const waiting = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" ? issue : undefined;
    }, "根因确认问题卡");
    assert.equal(waiting.stage, "locate_root");
    assert.ok(waiting.waiting, "问题卡应来自 AskUserQuestion");
    assert.ok(waiting.has_analysis, "分析报告应已产出");

    // 登记元信息进上下文(ADR-0003):网管口令明文随元信息块出现。
    const requestText = JSON.stringify(model.requests);
    assert.match(requestText, /env-shared-secret/);
    assert.match(requestText, /页面密码: page-secret/);
    assert.match(requestText, /10\.0\.0\.8/, "环境地址是现场材料,应该可见");
    const stateFile = readFileSync(
      join(dataDir, "issues", created.id, "issue.json"), "utf-8");
    assert.doesNotMatch(stateFile, /env-shared-secret/);
    assert.doesNotMatch(stateFile, /page-secret/);

    service.answer(created.id, {
      state_version: waiting.waiting!.state_version,
      decision: "确认归档",
    });
    const idle = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "作答后回合收口");
    assert.equal(idle.stage, "done", "作答后应继续推进到结论阶段");
    const thread = service.messages(created.id);
    assert.ok(thread.some((message) =>
      message.role === "user" && message.text.includes("黑屏")),
    "开场问题应作为用户消息入账");
    assert.ok(thread.some((message) => message.role === "decision"),
    "用户决定应入账");

    // 续聊通道:idle 后用户还能继续说话。
    const resumed = service.reply(created.id, "补充:同类现象上周也出现过");
    assert.equal(resumed.status, "running");
    await until(() => {
      const issue = service.get(created.id);
      return issue.status === "idle" || issue.status === "failed" ? issue : undefined;
    }, "续聊回合收口", 10_000).then((issue) => {
      assert.notEqual(issue.status, "failed", issue.error);
    });

    // 视图旁路(真路由形状):多轮闭环完成后,「耗时与卡点」与过程文档
    // 都应能直接出结论——等待段配对、决策计数、issue-analysis.md 全文。
    const timelineResponse = await issueGet(
      ["issues", created.id, "timeline"], service);
    assert.equal(timelineResponse.status, 200);
    assert.ok(timelineResponse.body.human_waits.length >= 1,
      `研究→提问→作答的多轮应配出至少一段人等待(实际 ${
        JSON.stringify(timelineResponse.body.human_waits)})`);
    assert.ok(timelineResponse.body.decisions >= 1, "用户决定要计入决策次数");
    assert.ok((timelineResponse.body.events ?? []).some(
      (event: Record<string, unknown>) => event.kind === "decision"),
    "关键事件里要有用户决策条目");
    assert.ok(typeof timelineResponse.body.span?.ms === "number"
      && timelineResponse.body.span.ms >= 0,
    "耗时区间必须是有限的非负毫秒数");
    const docResponse = await issueGet(
      ["issues", created.id, "documents", "read"], service,
        "?name=issue-analysis.md");
    assert.equal(docResponse.status, 200,
      "文档存在时读取必须是 200,不是 404");
    assert.match(String(docResponse.body.content), /非问题/,
      "issue-analysis.md 的内容应原样可读");
    // 问题号未知才是 404;文档缺失的对照路在下方独立测试里钉死。
    assert.equal((await issueGet(
      ["issues", "issue-999", "documents"], service)).status, 404);

    const archived = service.control(created.id, {
      action: "archive", kind: "non_issue", summary: "误报,时钟漂移",
    });
    assert.equal(archived.status, "archived");
    assert.equal(archived.conclusion?.kind, "non_issue");
    // 阶段转移账:agent 声明与平台事实同账,归档是最后一条平台事实。
    const sources = archived.transitions?.map((entry) => entry.source) ?? [];
    assert.ok(sources.includes("agent"), "agent 阶段声明要入转移账");
    assert.ok(sources.includes("platform"), "平台动作要入转移账");
    assert.equal(archived.transitions?.at(-1)?.stage, "done");
    assert.deepEqual(
      archived.transitions
        ?.filter((entry) => entry.source === "agent")
        .map((entry) => entry.stage),
      ["locate_root", "done"]);
    assert.equal(existsSync(
      join(dataDir, ".issue-environments", `${created.id}.json`)), false,
    "归档后环境凭据必须清理");
    assert.throws(() => service.reply(created.id, "再看看"),
      /已归档/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("单号门禁:未绑定单号时 push_branch 被机械拒绝", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-gate-"));
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "bash", input: { command:
      "cd repo/origin && git checkout -q -b master_dev_DTS1 && "
      + "git -c user.name=test -c user.email=t@e commit -q --allow-empty "
      + "-m '[DTS1][fix] 修复测试问题'" } } },
    { tool: { name: "push_branch", input: { branch: "master_dev_DTS1" } } },
    { text: "推送被单号门禁拒绝,已如实报告用户。" },
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
      account: "dev", title: "无单号问题", repoUrl: origin,
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
      return issue.status === "idle" ? issue : undefined;
    }, "无单号回合收口");
    assert.equal(created.ticket, undefined);
    assert.equal(service.get(created.id).pushes, undefined,
      "没有单号就不该有任何推送记录");
    const events = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8");
    const pushFinished = events.split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>)
      .find((event) => event.kind === "tool_finished"
        && event.payload?.name === "push_branch");
    assert.ok(pushFinished, "push_branch 调用应入事件账");
    assert.equal(pushFinished.payload.is_error, true);
    assert.match(String(pushFinished.payload.result), /单号门禁/,
      "拒绝理由必须说人话");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("宿主推送与提 MR:门禁、真推送、公共 mrClient(与需求交付同格式)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-push-"));
  const origin = bareOrigin(dataDir);
  const branch = "master_dev_DTS2026082001317";
  // 假交付平台:记录请求形状,回 MR 链接——与适配层 POST /mr 同构。
  const seen: Array<{ headers: Record<string, string>; body: any }> = [];
  const platform = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      seen.push({
        headers: request.headers as Record<string, string>,
        body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        url: `http://codehub.test/mr/1024`, id: 1024,
      }));
    });
  });
  await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
  const platformUrl = `http://127.0.0.1:${(platform.address() as { port: number }).port}`;
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "bash", input: { command:
      `cd repo/origin && git checkout -q -b ${branch} && `
      + "git -c user.name=test -c user.email=t@e commit -q --allow-empty "
      + "-m '[DTS2026082001317][fix] 修复登录超时'" } } },
    { tool: { name: "push_branch", input: { branch } } },
    { tool: { name: "create_mr", input: {} } },
    { text: "已推送并提 MR。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    platformUrl,
    gitCredential: () => ({ username: "dev", password: "git-token" }),
  });
  try {
    const created = service.create({
      account: "dev",
      title: "登录超时",
      ticket: "DTS2026082001317",
      source: "dts",
      repoUrl: origin,
    });
    assert.equal(created.ticket, "DTS2026082001317");
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "推送+提MR回合收口");
    const final = service.get(created.id);
    const push = final.pushes?.[0];
    assert.ok(push, "推送应记录在案");
    assert.equal(push.branch, branch);
    // 远端真实状态(不信任务自述):裸仓里分支应指向同一 SHA。
    const remote = spawnSync("git",
      ["--git-dir", origin, "rev-parse", `refs/heads/${branch}`],
      { encoding: "utf-8" });
    assert.equal(remote.status, 0, remote.stderr);
    assert.equal(remote.stdout.trim(), push.sha);
    // Agent 侧推送被焊死:克隆的 pushurl 指向必失败地址。
    const pushurl = spawnSync("git",
      ["-C", join(dataDir, "issues", created.id, "repo", "origin"),
        "config", "--get", "remote.origin.pushurl"],
      { encoding: "utf-8" });
    assert.match(pushurl.stdout, /\/dev\/null/);
    // MR:走公共客户端,单号关联与身份头同需求交付一个格式。
    assert.ok(final.mrs?.length, "MR 应记录在案");
    assert.equal(final.mrs![0].url, "http://codehub.test/mr/1024");
    assert.equal(final.mrs![0].iid, "1024");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.source_branch, branch);
    assert.equal(seen[0].body.target_branch, "master");
    assert.equal(seen[0].body.dts_no, "DTS2026082001317", "单号要走 dts_no 关联");
    assert.match(String(seen[0].body.title), /^\[DTS2026082001317\]/);
    assert.equal(seen[0].headers["x-mfc-git-user"], "dev");
    assert.equal(seen[0].headers["x-mfc-git-token"], "git-token");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await new Promise<void>((resolve) => platform.close(() => resolve()));
  }
});

test("重启续聊:等待问题卡期间服务重启,作答仍能续上现场", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-recover-"));
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "现象是必现还是偶发?", options: ["必现", "偶发"],
      recommended: "偶发",
    }] } } },
    { text: "已收到答复,继续分析。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const first = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  let second: IssueFlowService | undefined;
  try {
    // 无单登记门禁要模块+环境(#17):夹具模块绑一个不存在的本地路径
    // 仓即可——本测试不拉仓,只要登记过门。
    createBusinessModule(dataDir, {
      id: "pay-core", name: "支付核心", description: "收单与清结算",
      owner: "dev", repositories: ["/tmp/fixture.git"],
    }, "tester");
    const created = first.create({
      account: "dev", title: "重启续聊",
      moduleId: "pay-core",
      environment: {
        hosts: ["10.0.0.8"],
        pagePassword: "page-secret",
        backendPassword: "env-shared-secret",
      },
    });
    const waiting = await until(() => {
      const issue = first.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" ? issue : undefined;
    }, "重启前问题卡");
    await first.shutdown();

    second = new IssueFlowService({
      dataDir, provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(),
    });
    const recovered = second.get(created.id);
    assert.equal(recovered.status, "waiting_user",
      "重启不吞等待中的问题卡");
    second.answer(created.id, {
      state_version: waiting.waiting!.state_version,
      decision: "偶发",
    });
    await until(() => {
      const issue = second!.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "重启后作答复跑");
    assert.ok(second.messages(created.id).some((message) =>
      message.role === "decision" && message.text.includes("偶发")),
    "决定应作为消息入账");
  } finally {
    await first.shutdown().catch(() => undefined);
    await second?.shutdown().catch(() => undefined);
    await model.stop();
  }
});

/** 落一个最小可恢复的问题现场(自由模式:收口不牵催办/阶段机)。 */
function seedRecoverableIssue(
  dataDir: string,
  id: string,
  patch: Record<string, unknown>,
): void {
  const now = "2026-08-29T00:00:00Z";
  const root = join(dataDir, "issues", id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id, account: "dev", created_at: now, updated_at: now,
    title: `标题-${id}`, description: "", source: "manual",
    mode: "free", status: "idle",
    stage: "locate_root", stage_note: "正在核对日志时序", stage_at: now,
    ...patch,
  }));
}

test("重启恢复翻转:running/旧 interrupted 重新入队自动续跑,queued 原样开跑,waiting/suspended 不动", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-recover2-"));
  // 五个现场直接落盘(状态各一,不跑全链,聚焦恢复语义)。旧版
  // interrupted 已不在词表里,夹具按盘上原样写(旧版本盖的戳)。
  seedRecoverableIssue(dataDir, "issue-1", { status: "running" });
  seedRecoverableIssue(dataDir, "issue-2", {
    status: "queued", stage: "registered",
    stage_note: "已登记,准备开始首轮研究",
  });
  seedRecoverableIssue(dataDir, "issue-3", {
    status: "interrupted", stage: "align_issue",
    stage_note: "对齐方案讨论中",
  });
  seedRecoverableIssue(dataDir, "issue-4", { status: "waiting_user" });
  seedRecoverableIssue(dataDir, "issue-5", { status: "suspended" });
  const script: Scene[] = [{ text: "收到,继续推进。" }];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const logs: string[] = [];
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    log: (message) => logs.push(message),
  });
  try {
    // 构造即恢复:重排队的在默认额度(2)内点火,剩下的坐额度队列;
    // 等家人与挂起的原样不动。目录遍历序不定,按集合断言。
    const active = ["issue-1", "issue-2", "issue-3"]
      .map((id) => service.get(id).status).sort();
    assert.deepEqual(active, ["queued", "running", "running"],
      "running/旧 interrupted/queued 都进泵,但受并发额度约束");
    assert.equal(service.get("issue-4").status, "waiting_user");
    assert.equal(service.get("issue-5").status, "suspended");
    assert.ok(logs.some((line) => /重启恢复: 续跑 2 个、排队 1 个/.test(line)),
      "恢复台账行要报续跑/排队数");
    await until(() => {
      const statuses = ["issue-1", "issue-2", "issue-3"]
        .map((id) => service.get(id).status);
      if (statuses.some((s) => s === "failed")) {
        throw new Error(service.get("issue-1").error
          ?? service.get("issue-2").error ?? "failed");
      }
      return statuses.every((s) => s === "idle") ? statuses : undefined;
    }, "重排队的会话逐个续跑收口");
    assert.equal(service.get("issue-4").status, "waiting_user", "全程未动");
    assert.equal(service.get("issue-5").status, "suspended", "全程未动");
    // 按标题认领各会话的请求:重启续跑的收到平台通知开场;原样排队
    // 的是登记首轮,仍走开场词——两条入口不混。
    const requests = model.requests.map((request) => JSON.stringify(request));
    for (const id of ["issue-1", "issue-3"]) {
      assert.ok(requests.some((r) => r.includes(`标题-${id}`)
        && r.includes("服务重启,平台自动续跑")),
        `${id} 的续跑回合开场是平台通知口径`);
    }
    assert.ok(requests.some((r) => r.includes("标题-issue-2")
      && r.includes("研究与处理 Agent")), "queued 原样走开场词");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("续跑点火:开场是重启平台通知,续聊提示词带当前阶段上下文,事件流留痕", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-resume-"));
  seedRecoverableIssue(dataDir, "issue-1", {
    title: "登录超时", status: "running",
  });
  const script: Scene[] = [{ text: "收到,接着当前阶段继续排查。" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const idle = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "续跑回合收口");
    assert.equal(idle.stage, "locate_root", "续跑不重置阶段");
    // 开场词:平台通知口径 + 续聊提示词的现场块(最近阶段/登记元信息)。
    const prompt = JSON.stringify(model.requests[0]);
    assert.ok(prompt.includes(
      "服务重启,平台自动续跑,接着当前阶段继续,不重复已完成的工作"));
    assert.ok(prompt.includes("服务重启/续聊后继续同一问题会话"));
    assert.ok(prompt.includes("最近阶段: 分析根因(正在核对日志时序)"),
      "阶段语境原样交给重建的上下文");
    assert.ok(prompt.includes("- 标题: 登录超时"), "登记元信息随现场重给");
    // 重启通知以用户消息落事件流,时间线可查。
    assert.ok(service.messages("issue-1").some((message) =>
      message.role === "user"
      && message.text.includes("服务重启,平台自动续跑")));
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("恢复续跑受并发额度约束:超出 maxConcurrentTurns 的会话排队逐个跑,不瞬时打满", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-quota-"));
  for (const id of ["issue-1", "issue-2", "issue-3"]) {
    seedRecoverableIssue(dataDir, id, { status: "running" });
  }
  const script: Scene[] = [{ text: "继续。" }];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    maxConcurrentTurns: 2,
  });
  try {
    // 构造同步段即断言:额度内点火两个,第三个还在排队。
    const statuses = ["issue-1", "issue-2", "issue-3"]
      .map((id) => service.get(id).status);
    assert.equal(statuses.filter((s) => s === "running").length, 2);
    assert.equal(statuses.filter((s) => s === "queued").length, 1);
    await until(() => {
      const now = ["issue-1", "issue-2", "issue-3"]
        .map((id) => service.get(id).status);
      if (now.includes("failed")) throw new Error("续跑回合失败");
      return now.every((s) => s === "idle") ? now : undefined;
    }, "额度排队逐个收口");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("Agent 问题卡归码:投影派码(码+文案对),按码作答还原原文,AI 看到的仍是自己的措辞", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-agentcode-"));
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
    createBusinessModule(dataDir, {
      id: "pay-core", name: "支付核心", description: "收单与清结算",
      owner: "dev", repositories: ["/tmp/fixture.git"],
    }, "tester");
    const created = service.create({
      account: "dev", title: "归码还原",
      moduleId: "pay-core",
      environment: {
        hosts: ["10.0.0.8"],
        pagePassword: "page-secret",
        backendPassword: "env-shared-secret",
      },
    });
    const waiting = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" ? issue : undefined;
    }, "Agent 问题卡");
    // 投影派码:选项是码+文案对,码按「题号-序号」机械派发(AskUserQuestion
    // 的选项措辞是 Agent 现场自由给的,没有领域码表)。
    const questions = (waiting.waiting!.question as {
      questions: Array<{ options: Array<{ code: string; label: string }> }>;
    }).questions;
    assert.deepEqual(questions[0].options.map((option) => option.code),
      ["opt-0-0", "opt-0-1"], "Agent 卡选项同样携带决策码");
    assert.deepEqual(questions[0].options.map((option) => option.label),
      ["必现", "偶发"], "文案仍是 Agent 的原话(只作显示)");

    // 按码作答:decision 是前端显示文案,answers 携带码;服务端按自己的
    // 码表还原原文再入账——协议与平台闸同构(码是裁决/传递的身份)。
    service.answer(created.id, {
      state_version: waiting.waiting!.state_version,
      decision: "偶发",
      answers: { "0": "opt-0-1" },
    });
    await until(() =>
      service.get(created.id).status === "idle" ? 1 : undefined, "作答后收口");
    const replay = JSON.stringify(model.requests.at(-1));
    assert.match(replay, /偶发/, "AI 收到的是还原后的选项原文");
    assert.doesNotMatch(replay, /opt-0-1/, "决策码是平台协议,不得漏进模型上下文");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("Agent 卡推荐投影:推荐原文换算成命中选项的投影码,多题各自独立,开放题不带", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-recommend-"));
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: { questions: [
      { question: "影响范围?", options: ["仅 SMS ", "全部渠道"],
        recommended: " 全部渠道" },
      { question: "复现步骤是什么?(自由作答)" },
      { question: "重试次数?", options: ["三次", "四次"],
        recommended: "三次" },
    ] } } },
    { text: "已收到答复,继续分析。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    createBusinessModule(dataDir, {
      id: "pay-core", name: "支付核心", description: "收单与清结算",
      owner: "dev", repositories: ["/tmp/fixture.git"],
    }, "tester");
    const created = service.create({
      account: "dev", title: "推荐投影",
      moduleId: "pay-core",
      environment: {
        hosts: ["10.0.0.8"],
        pagePassword: "page-secret",
        backendPassword: "env-shared-secret",
      },
    });
    const waiting = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" ? issue : undefined;
    }, "Agent 问题卡");
    // 推荐协议(ADR-0004):推荐原文换算成命中选项的投影码随 questions[]
    // 下发,前端按码标「AI 推荐」——与选项同一条码表,文案改字零协议后果。
    const questions = (waiting.waiting!.question as {
      questions: Array<{
        options?: Array<{ code: string; label: string }>;
        recommended?: string;
      }>;
    }).questions;
    assert.equal(questions[0].recommended, "opt-0-1",
      "推荐原文两侧的空白不参与比对(trim 语义),命中即换码");
    assert.equal("recommended" in questions[1], false,
      "自由作答题没有推荐,投影不带该键");
    assert.equal(questions[2].recommended, "opt-2-0",
      "多题各自独立:推荐码带各自题号");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("问题流专用部署(--issue-only):需求流程停用,问题流不受影响", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-only-"));
  const service = new TaskService({
    dataDir, provider: "p", model: "m", modelsJson: {}, maxConcurrent: 1,
    requirementDisabled: true,
  });
  // 发起需求任务:API 层直接拒绝,文案指路问题处理。
  assert.throws(() => service.create("新需求", { account: "dev" }),
    /问题流专用.*需求流程未启用/);
  // 下单表单的 blockers 把停用状态摆在明面上(前端现有渲染复用它)。
  const blockers = service.launchOptions().blockers
    .map((item) => item.key);
  assert.ok(blockers.includes("requirement_disabled"));
  // 问题流服务自身零依赖 TaskService:同数据目录并行构造,互不拖累。
  const issueFlow = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  assert.deepEqual(issueFlow.list(), []);
});

test("ops 运维工具:真二进制冒烟,诚实失败且不泄密码", async (t) => {
  const toolsDir = join(process.cwd(), "assets", "ops-tools");
  const binary = process.platform === "win32"
    ? "fetch-logs.exe"
    : process.arch === "arm64"
      ? "fetch-logs-linux-arm64" : "fetch-logs-linux-amd64";
  // 仓里只带 Linux ELF(和 Windows exe),macOS 上文件在场也跑不起来——
  // spawn 直接 ENOEXEC。光查 existsSync 会让开发机上这条恒红,红着的
  // 用例等于没有用例(实测:macOS 上断言拿到的是 "spawn ENOEXEC")。
  const runnable = process.platform === "win32" || process.platform === "linux";
  if (!runnable) {
    // 纪律:没条件就显式 skip 并说清为什么。裸 return 在 node:test 里
    // 算 pass,那才是"假装测过"。
    t.skip(`${process.platform} 跑不了 ${binary}(Linux/Windows 专用二进制)`);
    return;
  }
  if (!existsSync(join(toolsDir, binary))) {
    t.skip(`裁剪部署未随带 ${binary}`);
    return;
  }
  const ops = createGoOpsTools({ toolsDir });
  const localDir = join(tmpdir(), `mfc-issue-ops-${Date.now()}`);
  await assert.rejects(
    () => ops.fetchLogs({
      hosts: ["127.0.0.1"],   // 必拒环回:真 SSH 立刻 refused
      services: ["TranFmaWebsite"],
      password: "probe-pass",
      localDir,
    }),
    (error: Error) => {
      assert.match(error.message, /拉取日志失败/);
      assert.ok(!error.message.includes("probe-pass"),
        "密码绝不能出现在错误文本里");
      return true;
    },
  );
});

test("MCP 网关客户端:握手、token 头、工具调用与未配置 fail-loud", async () => {
  const seen: Array<{ token?: string; session?: string; body: any }> = [];
  const fake = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
      seen.push({
        token: String(request.headers["x-auth-token"] ?? ""),
        session: String(request.headers["mcp-session-id"] ?? ""),
        body,
      });
      const reply = body.method === "initialize"
        ? {
            jsonrpc: "2.0", id: body.id,
            result: { protocolVersion: "2025-03-26", capabilities: {} },
          }
        : body.method === "tools/call"
          ? {
              jsonrpc: "2.0", id: body.id,
              result: {
                content: [{ type: "text", text: JSON.stringify([
                  { ticket: "DTS1", title: "登录超时" },
                ]) }],
              },
            }
          : { jsonrpc: "2.0", id: body.id ?? null, result: {} };
      response.writeHead(200, {
        "content-type": "application/json",
        ...(body.method === "initialize"
          ? { "mcp-session-id": "sess-1" } : {}),
      });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const port = (fake.address() as { port: number }).port;
  try {
    const gateway = new McpGateway({
      url: `http://127.0.0.1:${port}/mcp`,
      token: "secret-token",
      toolNames: { list: "list_issues" },
    });
    const result = await gateway.call("list_issues", { owner: "dev" });
    const text = (result as any).content[0].text;
    assert.match(text, /DTS1/);
    assert.equal(seen[0].token, "secret-token", "token 只在头里");
    assert.ok(seen.length >= 2);
    assert.equal(seen[1].session, "sess-1", "会话头要回带");

    const unconfigured = new UnconfiguredDtsGateway();
    await assert.rejects(() => unconfigured.listByOwner("dev"),
      /未配置/);
  } finally {
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
});

test("网管环境配置路由(2026-08-28):POST /issues/:id/environment 密码进 vault 不进 issue.json;缺地址/缺密码打回", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-envroute-"));
  mkdirSync(join(dataDir, "issues", "issue-1"), { recursive: true });
  writeFileSync(join(dataDir, "issues", "issue-1", "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: "2026-08-28T00:00:00Z", updated_at: "2026-08-28T00:00:00Z",
    title: "t", description: "", source: "manual", mode: "fixed",
    scenario: "no_ticket", status: "idle", stage: "analyze",
    stage_note: "", stage_at: "2026-08-28T00:00:00Z",
  }));
  const script: Scene[] = [{ text: "环境已配置,重试日志。" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    // 校验打回:缺地址 / 缺后台密码都是 409 带人话,不产生任何落盘。
    const noHosts = await issuePost(["issues", "issue-1", "environment"],
      { hosts: [], backend_password: "x" }, service);
    assert.equal(noHosts.status, 409);
    assert.match(noHosts.body.error, /至少要有一个服务器地址/);
    const noPassword = await issuePost(["issues", "issue-1", "environment"],
      { hosts: ["10.0.0.8"], backend_password: "   " }, service);
    assert.equal(noPassword.status, 409);
    assert.match(noPassword.body.error, /网管后台密码/);

    // 正常配置:状态只有 credential_ref,密码在 vault 加密文件里,
    // issue.json 原文永远搜不到明文;闸只收地址+后台密码,body 里即便
    // 递了页面凭据也不认(env_needed 现场补配碰不到网管页面)。
    const ok = await issuePost(["issues", "issue-1", "environment"],
      { hosts: ["10.0.0.8", "10.0.0.9"], port: 2222,
        backend_password: "env-shared-secret",
        page_password: "should-be-ignored" }, service);
    assert.equal(ok.status, 200);
    assert.ok(ok.body.environment?.credential_ref, "状态里只有凭据引用");
    assert.equal(ok.body.gate ?? undefined, undefined, "没有闸在场就不凭空造闸");
    assert.deepEqual(ok.body.environment?.hosts, ["10.0.0.8", "10.0.0.9"]);
    assert.equal(ok.body.environment?.port, 2222);
    assert.equal(ok.body.environment?.page_account, undefined,
      "闸内补配没有页面凭据,消费面按缺席优雅处理");
    assert.ok(existsSync(join(dataDir, ".issue-environments", "issue-1.json")),
      "密码落在 vault 加密文件");
    const raw = readFileSync(join(dataDir, "issues", "issue-1", "issue.json"), "utf-8");
    assert.ok(!raw.includes("env-shared-secret"), "issue.json 永远没有密码明文");
    await until(() => service.get("issue-1").status === "idle"
      ? 1 : undefined, "配置后的平台回合收口");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("现场记录导出·纯构建器:工具命令/结果/决策逐字保真,未知事件兜底", () => {
  const state = {
    id: "issue-9", account: "dev",
    created_at: "2026-08-28T08:00:00Z", updated_at: "2026-08-28T09:00:00Z",
    title: "超长标题验证", description: "", source: "manual",
    status: "idle", stage: "locate_root", stage_note: "对照代码核对时序",
    stage_at: "2026-08-28T09:00:00Z", ticket: "DTS-2026-1006",
    transitions: [
      { at: "2026-08-28T08:10:00Z", source: "agent", stage: "align_issue",
        note: "对齐现象" },
      { at: "2026-08-28T08:20:00Z", source: "platform", note: "单号已绑定" },
    ],
  } as unknown as IssueSessionState;
  const events = [
    { eventId: 1, taskId: "issue-9", sessionId: "s",
      ts: "2026-08-28T08:00:00Z", kind: "session_started", payload: {} },
    { eventId: 2, taskId: "issue-9", sessionId: "s",
      ts: "2026-08-28T08:01:00Z", kind: "user_message",
      payload: { text: "开场指令" } },
    { eventId: 3, taskId: "issue-9", sessionId: "s",
      ts: "2026-08-28T08:02:00Z", kind: "tool_requested",
      payload: { call_id: "c1", name: "Bash",
        input: { command: "grep -rn 网元树 src/" } } },
    { eventId: 4, taskId: "issue-9", sessionId: "s",
      ts: "2026-08-28T08:03:00Z", kind: "tool_finished",
      payload: { call_id: "c1", name: "Bash", is_error: true,
        result: "grep: no match" } },
    { eventId: 5, taskId: "issue-9", sessionId: "s",
      ts: "2026-08-28T08:04:00Z", kind: "human_decision",
      payload: { decision: "确认根因", notes: "以日志为准" } },
    { eventId: 6, taskId: "issue-9", sessionId: "s",
      ts: "2026-08-28T08:05:00Z", kind: "mystery_kind", payload: { odd: 1 } },
  ] as unknown as SemanticEvent[];
  const record = buildWorksiteRecord(
    { state, events, now: "2026-08-28T10:00:00Z" });
  assert.match(record.filename, /^issue-9-现场记录-20260828\.md$/);
  assert.match(record.markdown, /# 现场记录:超长标题验证/);
  assert.match(record.markdown, /DTS-2026-1006/);
  assert.match(record.markdown, /grep -rn 网元树 src\//, "工具命令逐字");
  assert.match(record.markdown, /✗ 异常/, "失败工具要标异常");
  assert.match(record.markdown, /确认根因/, "用户决策逐字");
  assert.match(record.markdown, /mystery_kind/, "未知事件兜底不丢");
  assert.match(record.markdown, /\[AI 上报\] 对齐问题/, "阶段转移入账");
  assert.match(record.markdown, /\[平台\]/, "平台事实入账");
});

test("现场记录导出·路由:markdown 直出、坏行跳过、未知问题 404", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-export-"));
  mkdirSync(join(dataDir, "issues", "issue-1"), { recursive: true });
  writeFileSync(join(dataDir, "issues", "issue-1", "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: "2026-08-28T08:00:00Z", updated_at: "2026-08-28T09:00:00Z",
    title: "t", description: "", source: "manual",
    status: "idle", stage: "locate_root", stage_note: "",
    stage_at: "2026-08-28T09:00:00Z",
  }));
  // 半行(写入方还在写)+ 好行:导出必须跳过坏行而不是 5xx。
  writeFileSync(join(dataDir, "issues", "issue-1", "events.jsonl"),
    '{"kind":"user_mess\n'
    + JSON.stringify({ eventId: 2, kind: "user_message",
      ts: "2026-08-28T08:00:00Z", payload: { text: "开场" } }) + "\n");
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  return (async () => {
    try {
      const captured = await new Promise<{
        status: number; headers: Record<string, string>; body: string;
      }>((resolve, reject) => {
        let status = 0;
        let headers: Record<string, string> = {};
        void handleIssueRoutes(
          { method: "GET" } as any,
          {
            writeHead: (code: number, heads: Record<string, string>) => {
              status = code; headers = heads;
            },
            end: (payload?: string) => {
              resolve({ status, headers, body: payload ?? "" });
            },
          } as any,
          ["issues", "issue-1", "export"],
          { issueFlow: service, authEnabled: false },
        ).catch(reject);
      });
      assert.equal(captured.status, 200);
      assert.match(captured.headers["content-type"] ?? "", /text\/markdown/);
      assert.match(captured.headers["content-disposition"] ?? "", /attachment/);
      assert.match(captured.body, /# 现场记录:t/);
      assert.match(captured.body, /开场/, "好行入账");
      assert.ok(!captured.body.includes("user_mess"), "坏行不入账");

      const missing = await new Promise<{ status: number }>((resolve, reject) => {
        let status = 0;
        void handleIssueRoutes(
          { method: "GET" } as any,
          {
            writeHead: (code: number) => { status = code; },
            end: () => resolve({ status }),
          } as any,
          ["issues", "issue-404", "export"],
          { issueFlow: service, authEnabled: false },
        ).catch(reject);
      });
      assert.equal(missing.status, 404);
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  })();
});
