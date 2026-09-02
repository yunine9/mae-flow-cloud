/**
 * 问题会话接入小鲁班手机审批的契约测试(与需求侧同一网关、同一审批码):
 * - 等待卡(平台闸卡与 Agent 问题卡)经适配层进网关,手机纯文本回复
 *   (裸序号/审批码)能落账到问题会话,后续回合照常续跑;
 * - 通知里的审批码与网关侧派码同源(同 token、同四元组),回复即达;
 * - 卡被抢先作答/状态漂移回"审批码已过期"(stale),不是 500;
 * - 码表标注「填写补充说明」的选项,手机必须带说明(与页面同纪律)。
 *
 * 范式与 issueFlowNotify.test.ts 同款:ScriptedModelServer 剧本 +
 * FakeLubanServer 假小鲁班,只走公开 API 断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { IssueFlowLubanApproval } from "../src/issueFlow/lubanApproval.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import {
  lubanApprovalCode,
  LubanApprovalGateway,
  type LubanApprovalService,
} from "../src/lubanApproval.ts";
import type { TaskSummary } from "../src/taskService.ts";

const TICKET = "DTS-2026-1001";
const TOKEN = "test-luban-plugin-token-32-bytes-minimum";

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

/** 与 serve.ts 同一条派码路:通知与网关共用同一 token,审批码才对得上。 */
function makeNotifier(luban: FakeLubanServer): Notifier {
  return new Notifier({
    endpoint: luban.endpoint,
    mobileApproval: true,
    approvalCode: (input) => lubanApprovalCode({ token: TOKEN, ...input }),
    backoffMs: [0],
  });
}

function makeGateway(
  sources: LubanApprovalService | LubanApprovalService[],
  notifier: Notifier,
): LubanApprovalGateway {
  return new LubanApprovalGateway(sources, {
    token: TOKEN,
    accountEnabled: () => true,
    recentNotification: (account) => notifier.latestApproval(account),
  });
}

function reply(gateway: LubanApprovalGateway, content: string) {
  return gateway.handle({
    rawBody: JSON.stringify({
      message_id: `msg-${Math.random().toString(36).slice(2)}`,
      sender: "dev",
      content,
    }),
    token: TOKEN,
  });
}

async function makeService(
  model: ScriptedModelServer,
  notifier: Notifier,
  mode: "fixed" | "free",
) {
  const service = new IssueFlowService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-issue-luban-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts: new MockDtsGateway(),
    notifier,
    linkBase: "https://mfc.example.com",
    issueFlowMode: () => mode,
  });
  const created = service.create({
    account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
  });
  return { service, id: created.id };
}

const ANALYZE_SCRIPT: Scene[] = [
  { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
  { tool: { name: "complete_stage", input: { note: "本单无需代码仓" } } },
  { tool: { name: "bash", input: { command:
    "printf '# 问题分析\\n\\n现象:登录超时。\\n## 结论\\n连接池耗尽。\\n## 证据链\\n日志:连接池耗尽。\\n## 置信度\\n高:日志直接指向。\\n## 下一步建议\\n超时回收。\\n' > issue-analysis.md" } } },
  { tool: { name: "submit_analysis",
    input: { summary: "根因=连接池耗尽,方案=超时回收" } } },
  { text: "分析报告已提交,等待用户确认。" },
];

test("Agent 问题卡:通知审批码同源,手机裸序号回复落账并续跑", async () => {
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: {
      context: "已对齐两个候选修复方案",
      questions: [{
        question: "采用哪个修复方案?",
        options: ["方案A:超时回收", "方案B:扩容连接池"],
        recommended: "方案A:超时回收",
      }],
    } } },
    { text: "收到,按方案A处理完毕,本回合到此。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = makeNotifier(luban);
  let service: IssueFlowService | undefined;
  try {
    const made = await makeService(model, notifier, "free");
    service = made.service;
    const { id } = made;
    await until(() => service!.get(id).status === "waiting_user"
      ? service!.get(id) : undefined, "Agent 卡举卡");
    // 通知出卡,审批码与网关侧派码同源(同 token 同四元组)。
    const approval = await until(() => notifier.latestApproval("dev"),
      "等待卡通知");
    const gateway = makeGateway(new IssueFlowLubanApproval(service), notifier);
    const list = await reply(gateway, "mae-flow 待审批");
    assert.ok(list.text.includes(`mae-flow 选择 ${approval.code}`),
      "待办详情带审批码,用户可按码定位");
    // 裸序号回复(唯一待办):适配层 decide → answer → 续跑。
    const answer = await reply(gateway, "1");
    assert.equal(answer.status, 200);
    assert.match(answer.text, /已提交/);
    const done = await until(() => {
      const issue = service!.get(id);
      return issue.status === "idle" ? issue : undefined;
    }, "作答后续跑收口");
    assert.equal(done.waiting, undefined, "卡已消费");
    // 落的是用户选中的选项原文(Agent 看到自己的措辞)。
    assert.ok((done.last_reply ?? "").length > 0);
  } finally {
    await service?.shutdown().catch(() => undefined);
    await model.stop();
    await luban.stop();
  }
});

test("平台闸卡:手机回复确认落账,闸清阶段走;卡换了回审批码过期", async () => {
  const model = new ScriptedModelServer(ANALYZE_SCRIPT, "scripted-v1",
    { linear: true });
  await model.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = makeNotifier(luban);
  let service: IssueFlowService | undefined;
  try {
    const made = await makeService(model, notifier, "fixed");
    service = made.service;
    const { id } = made;
    const gated = await until(() => {
      const issue = service!.get(id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind
        === "analysis_confirm" ? issue : undefined;
    }, "分析确认闸");
    const approval = await until(() => notifier.latestApproval("dev"),
      "闸卡通知");
    assert.equal(approval.waitingId, gated.gate!.id,
      "闸卡审批码绑 gate.id(与通知同锚)");
    const gateway = makeGateway(new IssueFlowLubanApproval(service), notifier);
    const answer = await reply(gateway, "mae-flow 选择 "
      + `${approval.code} 1`);
    assert.equal(answer.status, 200);
    const cleared = await until(() => {
      const issue = service!.get(id);
      return issue.gate === undefined ? issue : undefined;
    }, "闸已清");
    assert.equal(cleared.gate, undefined);
    assert.ok((cleared.transitions ?? []).some((item) =>
      item.note.includes("用户作答(analysis_confirm)")),
    "闸作答进转移账");

    // 同一张码再答:卡已消费 → stale,不是 500。
    const stale = await reply(gateway, "mae-flow 选择 "
      + `${approval.code} 1`);
    assert.equal(stale.status, 409);
    assert.match(stale.text, /已更新或审批码已过期/);
  } finally {
    await service?.shutdown().catch(() => undefined);
    await model.stop();
    await luban.stop();
  }
});

test("「填写补充说明」类选项:空补充打回并指引;带说明的补充回流分析", async () => {
  const model = new ScriptedModelServer(ANALYZE_SCRIPT, "scripted-v1",
    { linear: true });
  await model.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = makeNotifier(luban);
  let service: IssueFlowService | undefined;
  try {
    const made = await makeService(model, notifier, "fixed");
    service = made.service;
    const { id } = made;
    await until(() => {
      const issue = service!.get(id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind
        === "analysis_confirm" ? issue : undefined;
    }, "分析确认闸");
    const gateway = makeGateway(new IssueFlowLubanApproval(service), notifier);
    // 选项 2 = 有补充意见(填写补充说明),不带说明打回。
    const rejected = await reply(gateway, "2");
    assert.equal(rejected.status, 409);
    assert.match(rejected.text, /需要附上说明/);
    assert.equal(service.get(id).gate?.kind, "analysis_confirm",
      "打回不动闸,卡还等着");
    // 序号+说明:受理,回流分析(补充意见不推进)。
    const accepted = await reply(gateway, "2: 先补登录日志再下结论");
    assert.equal(accepted.status, 200);
    const cleared = await until(() => {
      const issue = service!.get(id);
      return issue.gate === undefined ? issue : undefined;
    }, "补充后闸已清");
    const transition = (cleared.transitions ?? []).at(-1);
    assert.ok(transition?.note.includes("先补登录日志再下结论"),
      "补充说明进现场账");
  } finally {
    await service?.shutdown().catch(() => undefined);
    await model.stop();
    await luban.stop();
  }
});

test("多来源合并:需求任务与问题卡同册,回复各归各家", async () => {
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: {
      questions: [{
        question: "继续还是停止?",
        options: ["继续", "停止"],
        recommended: "继续",
      }],
    } } },
    { text: "收到,继续处理完毕。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = makeNotifier(luban);
  let service: IssueFlowService | undefined;
  const decided: string[] = [];
  const fakeTasks: TaskSummary[] = [{
    id: "T-99",
    title: "需求任务",
    requirement: "需求任务",
    status: "waiting_for_human",
    luban_account: "dev",
    workspace: "/tmp/T-99",
    created_at: "2026-09-02T00:00:00.000Z",
    waiting: {
      waiting_id: "T-99:call-1", task_id: "T-99", step: "delivery_review",
      call_id: "call-1",
      question: { questions: [{ question: "Diff 通过吗?", options: ["通过", "打回"] }] },
      state_version: 1, status: "waiting", decision: "", notes: "",
      created_at: "2026-09-02T00:00:00.000Z", resolved_at: "", reminders: 0,
    },
  }];
  const fakeService: LubanApprovalService = {
    list: () => fakeTasks,
    decide: async (id) => {
      decided.push(id);
      fakeTasks[0].status = "completed";
      return fakeTasks[0];
    },
  };
  try {
    const made = await makeService(model, notifier, "free");
    service = made.service;
    const { id } = made;
    await until(() => service!.get(id).status === "waiting_user"
      ? service!.get(id) : undefined, "Agent 卡举卡");
    const gateway = makeGateway(
      [fakeService, new IssueFlowLubanApproval(service)], notifier);
    const list = await reply(gateway, "mae-flow 待审批");
    assert.match(list.text, /你有 2 项待审批/);
    assert.match(list.text, /需求任务/, "需求任务在册");
    assert.match(list.text, /问题 DTS-2026-1001/, "问题卡在册,称呼带「问题」");
    // 先答需求任务(序号 1 → T-99 详情 → 选「通过」):路由到需求侧。
    await reply(gateway, "1");
    const task = await reply(gateway, "1");
    assert.equal(task.status, 200);
    assert.deepEqual(decided, ["T-99"], "决定路由到需求任务来源");
    // 问题卡仍在册,单卡可继续裸序号作答:路由到问题适配层。
    const issueReply = await reply(gateway, "mae-flow 待审批");
    assert.doesNotMatch(issueReply.text, /需求任务/, "需求任务已收口");
    const answer = await reply(gateway, "1");
    assert.equal(answer.status, 200);
    await until(() => service!.get(id).status === "idle"
      ? service!.get(id) : undefined, "问题卡作答后续跑收口");
  } finally {
    await service?.shutdown().catch(() => undefined);
    await model.stop();
    await luban.stop();
  }
});
