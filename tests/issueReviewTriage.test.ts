/**
 * 检视分诊的长轴集成(ADR-0035,脚本化模型+真服务;先例
 * tests/issueFlowContract.test.ts / issueFlowFixed.helpers.ts):
 * - 提交检视只送出+递分诊,不再整体回退、不再置 review_active、不再
 *   冻结版本快照(快照时机迁到修改型申报);
 * - 纯回复型批次:respond_review 逐条落账,原地闭环——阶段/轮次不变、
 *   版本数不变、analysis_confirm 闸保持原样(不是二次确认)、流程照常
 *   可推进;
 * - 含修改型批次:declare_review_rework 触发原回退链路(轮次+1、
 *   reviews/ 出新快照、意见清单重注入、submit_analysis 后确认卡照旧);
 * - 混合批次:按修改型处理,回复型意见也逐条 respond。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { ANALYSIS_DOC_NAME } from "../src/issueFlow/documents.ts";
import {
  addReview,
  renderReviewNotes,
  snapshotAnalysisVersion,
  submitReviews,
} from "../src/issueFlow/reviews.ts";
import { listAnalysisVersions } from "../src/issueFlow/analysisVersions.ts";
import { mfcTemp } from "./mfcTmp.ts";
import {
  bareOrigin,
  fastPoll,
  TICKET,
  until,
} from "./issueFlowFixed.helpers.ts";

const REPORT_V1 = "# 问题分析\n\n## 问题现象\n压测登录超时。\n"
  + "## 问题根因\n连接池耗尽。\n## 修改方案\n超时回收。\n"
  + "## 证据链\n日志:连接池耗尽。\n## 置信度\n高。\n";

/** 开一局跑到「分析确认闸」挂起的真服务:剧本前七幕与全链契约测试
 * 同款(拉单→拉仓→写报告→submit_analysis);后续幕由各用例续写。 */
async function bootToConfirmGate() {
  const dataDir = mfcTemp("mfc-issue-triage-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      `cat > issue-analysis.md <<'EOF'\n${REPORT_V1}EOF` } } },
    { tool: { name: "submit_analysis", input: { summary: "根因=连接池耗尽" } } },
    { text: "分析报告已提交,等待用户确认。" },
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
  });
  const created = service.create({
    account: "dev",
    title: "登录超时",
    description: "压测环境登录超时,疑似连接池耗尽",
    ticket: TICKET,
    source: "dts",
    repoUrl: origin,
    environment: {
      hosts: ["10.0.0.8"],
      backendPassword: "env-shared-secret",
    },
  });
  await until(() => {
    const issue = service.get(created.id);
    if (issue.status === "failed") throw new Error(issue.error ?? "failed");
    return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
      ? issue : undefined;
  }, "首轮分析确认闸");
  const root = join(dataDir, "issues", created.id);
  return { service, model, id: created.id, root, script };
}

/** 等一个状态谓词成立,失败时把服务错误带出来。 */
async function waitIssue(
  service: IssueFlowService,
  id: string,
  what: string,
  predicate: (issue: ReturnType<IssueFlowService["get"]>) => boolean,
) {
  return until(() => {
    const issue = service.get(id);
    if (issue.status === "failed") throw new Error(issue.error ?? "failed");
    return predicate(issue) ? issue : undefined;
  }, what);
}

function snapshotCount(root: string): number {
  const dir = join(root, "reviews");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((name) => name.startsWith("issue-analysis@")).length;
}

test("纯回复型批次:提交后原地分诊——不回退、版本数不变、逐条 respond 落账、确认卡原样保留、流程照常可推进", async () => {
  const { service, model, id, root } = await bootToConfirmGate();
  try {
    const before = service.get(id);
    const gateBefore = before.gate!;
    service.addReview(id, {
      line: 4, anchor: "连接池耗尽。", note: "为什么断定是连接池而不是带宽?",
    });
    service.addReview(id, {
      line: 5, anchor: "超时回收。", note: "这个方案已在线上验证过吗?",
    });
    // 分诊回合的剧本先就位(linear 模式按请求序取幕,幕到晚了会重放
    // 旧幕):AI 逐条 respond 后收嘴。
    model.script.push({ tool: { name: "respond_review", input: {
      items: [
        { review: 1, reply: "压测日志显示连接等待超时,带宽利用率仅 40%,已排除带宽。",
          outcome: "not_fixed" },
        { review: 2, reply: "尚未线上验证,需要你确认是否接受仿真环境结论。",
          outcome: "needs_clarification" },
      ],
    } } });
    model.script.push({ text: "已逐条回复两条意见,报告无需改动。" });
    const result = service.submitReviews(id);
    assert.match(result.stage_note, /已接收 2 条/);

    // 分诊回合:意见清单+分诊准则进模型。
    const triageRequest = await until(() => model.requests[7]
      ? JSON.stringify(model.requests[7]) : undefined, "分诊回合派出");
    assert.match(triageRequest, /回复型/);
    assert.match(triageRequest, /修改型/);
    assert.match(triageRequest, /意见1/);
    assert.match(triageRequest, /respond_review/);

    // 回合收口:回到同一张确认卡(不是重举的新卡,也不是二次确认)。
    const settled = await waitIssue(service, id, "分诊回合收口回确认卡",
      (issue) => issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm");
    assert.equal(settled.gate!.id, gateBefore.id,
      "analysis_confirm 闸保持原样:用户只是插了问话,待确认状态保留");
    assert.equal(settled.gate!.state_version, gateBefore.state_version);

    // 不回退:阶段/轮次/段状态原地不动;不置 review_active。
    assert.equal(settled.stage, "analyze");
    assert.equal(settled.round, 1);
    assert.deepEqual(settled.stage_states, before.stage_states);
    assert.equal(settled.review_active, undefined,
      "纯回复型不置 review_active(不进入检视重写态)");

    // 不出版本:reviews/ 无快照,版本投影只有 live 一版。
    assert.equal(snapshotCount(root), 0, "纯回复型批次不冻结版本快照");
    const versions = listAnalysisVersions(root);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].snapshot, undefined);

    // respond 逐条落账:回复原文在 summary,outcome 按语义。
    const reviews = service.listReviews(id).reviews;
    const answered = reviews.filter((item) => item.response);
    assert.equal(answered.length, 2, "两条意见都有 AI 回复");
    assert.match(answered[0].response!.summary, /带宽利用率仅 40%/);
    assert.equal(answered[0].response!.outcome, "not_fixed");
    assert.equal(answered[1].response!.outcome, "needs_clarification");

    // 流程照常可推进:确认后照旧进问题修复。
    service.answer(id, {
      state_version: settled.gate!.state_version, code: "confirm",
    });
    await waitIssue(service, id, "确认后进入问题修复",
      (issue) => issue.stage === "fix");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("含修改型批次:declare_review_rework 触发整体回退重写——轮次+1、此刻才快照出版本、确认卡照旧", async () => {
  const { service, model, id, root, script } = await bootToConfirmGate();
  try {
    const gateBefore = service.get(id).gate!;
    service.addReview(id, {
      line: 4, anchor: "连接池耗尽。", note: "补上连接池打满的监控证据,并修订方案",
    });
    model.script.push({ tool: { name: "declare_review_rework", input: {
      reviews: [{ seq: 1 }],
      reason: "证据链缺口必须补测,方案要连带修订",
    } } });
    model.script.push({ tool: { name: "bash", input: { command:
      "cat > issue-analysis.md <<'EOF'\n"
      + "# 检视意见回应\n意见1:已补连接池监控证据并修订方案。\n"
      + REPORT_V1.replace("连接池耗尽。", "连接池耗尽(已补监控证据)。")
      + "EOF" } } });
    model.script.push({ tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽(已补证据)" } } });
    model.script.push({ text: "修订版已重新提交,等待确认。" });
    service.submitReviews(id);
    assert.match(JSON.stringify(script[8]), /issue-analysis\.md/,
      "申报后平台注入意见清单,AI 据此整份重写");

    const settled = await waitIssue(service, id, "重写后重举确认卡",
      (issue) => issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm"
        && issue.gate!.id !== gateBefore.id);

    // 原回退链路照旧:回退问题分析、轮次+1。
    assert.equal(settled.stage, "analyze");
    assert.equal(settled.round, 2, "修改型回退,分析轮次+1");
    assert.match(settled.stage_note ?? "", /用户检视分析报告,提交 1 条修订意见/,
      "回退措辞沿用「用户检视分析报告…」措辞族");
    // 申报时刻才快照:reviews/ 出新快照,版本账 +1(初版=冻结版)。
    assert.equal(snapshotCount(root), 1, "版本快照随修改型申报落账");
    const versions = listAnalysisVersions(root);
    assert.ok(versions.length >= 2, "冻结版+最新版两版在账");
    assert.ok(versions[0].snapshot, "初版带 reviews/ 快照");
    // 回退轮次账进转移账(第 N 轮)。
    const state = JSON.parse(readFileSync(join(root, "issue.json"), "utf-8"));
    assert.ok((state.transitions as Array<{ note: string }>).some((item) =>
      /第 2 轮:用户检视分析报告/.test(item.note)),
      "回退转移账带轮次与措辞族");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("混合批次:按修改型回退重写,回复型意见也逐条 respond 落账", async () => {
  const { service, model, id, root } = await bootToConfirmGate();
  try {
    service.addReview(id, {
      line: 4, anchor: "连接池耗尽。", note: "连接池配的是多大?",
    });
    service.addReview(id, {
      line: 5, anchor: "超时回收。", note: "方案改成连接池扩容+超时回收双管齐下",
    });
    model.script.push({ tool: { name: "respond_review", input: {
      items: [{ review: 1, reply: "当前连接池 50,压测并发 200。", outcome: "not_fixed" }],
    } } });
    model.script.push({ tool: { name: "declare_review_rework", input: {
      reviews: [{ seq: 2 }], reason: "方案本身要改,须整份重写",
    } } });
    model.script.push({ tool: { name: "bash", input: { command:
      "cat > issue-analysis.md <<'EOF'\n"
      + "# 检视意见回应\n意见1:已答复连接池规格。\n意见2:方案已改为扩容+回收。\n"
      + REPORT_V1.replace("超时回收。", "连接池扩容+超时回收。")
      + "EOF" } } });
    model.script.push({ tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽,方案已扩容" } } });
    model.script.push({ text: "混合批处理完,等待确认。" });
    service.submitReviews(id);

    const settled = await waitIssue(service, id, "混合批次重写收口",
      (issue) => issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm" && issue.round === 2);
    assert.equal(settled.stage, "analyze");
    assert.equal(snapshotCount(root), 1, "混合批次出版本");
    const reviews = service.listReviews(id).reviews;
    assert.equal(reviews.find((item) => item.seq === 1)?.response?.outcome,
      "not_fixed", "回复型意见在混合批次里也逐条 respond");
    assert.equal(reviews.find((item) => item.seq === 2)?.response, undefined,
      "修改型意见走回应段与版本,不在分诊回合冒充已回复");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("提交检视不再即时快照:两批提交零快照;申报时刻冻结的批次窗口仍把意见对回它锚定的版本", () => {
  const root = mfcTemp("mfc-issue-triage-snapshot-");
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 报告 v1\n\n根因一。\n");
  addReview(root, { author: "dev", line: 3, anchor: "根因一", note: "问一句" });
  submitReviews(root);
  assert.equal(snapshotCount(root), 0, "提交检视不冻结快照(ADR-0035)");
  assert.deepEqual(listAnalysisVersions(root).map((entry) => entry.name), ["初版"]);
  assert.equal(listAnalysisVersions(root)[0].snapshot, undefined);

  // 第二批照旧只送出:提交与快照彻底脱钩。
  addReview(root, { author: "dev", line: 3, anchor: "根因一", note: "再补证据" });
  submitReviews(root);
  assert.equal(snapshotCount(root), 0);

  // 修改型申报时刻才冻结:两批意见都锚在这份未被改动的报告上。
  snapshotAnalysisVersion(root);
  assert.equal(snapshotCount(root), 1);
  let versions = listAnalysisVersions(root);
  assert.deepEqual(versions.map((entry) => entry.name), ["初版"],
    "快照与 live 同文时由快照条代表(修订版尚不存在)");
  assert.equal(versions[0].review_ids.length, 2,
    "批次窗口接得住新时机:两批意见都对回冻结版");

  // AI 重写后:修订1=live,初版锚两批意见,存量口径不变。
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 报告 v2\n\n根因已修订。\n");
  versions = listAnalysisVersions(root);
  assert.deepEqual(versions.map((entry) => entry.name), ["初版", "修订1"]);
  assert.equal(versions[0].review_ids.length, 2);
  assert.deepEqual(versions[1].review_ids, [], "最新版是干净纸面");
});

test("分诊渲染:triage 版意见清单不再预设重写(无回应段/无 submit_analysis 收尾),修改版契约原文不变", () => {
  const root = mfcTemp("mfc-issue-triage-render-");
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 报告\n\n根因:重试无上限。\n");
  const first = addReview(root, {
    author: "dev", line: 3, anchor: "根因:重试无上限", note: "加重试上限",
  });
  const second = addReview(root, {
    author: "dev", line: 5, anchor: "方案:直接重试", note: "先说清重试策略",
  });
  const sent = submitReviews(root);
  assert.equal(sent.length, 2);

  // 修改版(默认):回应段护栏与 submit_analysis 收尾在——修改型重写的
  // 正式通道不删(ADR-0035 红线)。
  const rework = renderReviewNotes([second, first], "登录超时", 2);
  assert.match(rework, /「检视意见回应」/);
  assert.match(rework, /重新 submit_analysis/);
  assert.match(rework, /第 2 轮/);

  // 分诊版:清单与定位护栏在,重写契约让位分诊准则(在提示词资产里)。
  const triage = renderReviewNotes([second, first], "登录超时", 1, "triage");
  assert.match(triage, new RegExp(`意见1\\. \\[${first.id}\\]`));
  assert.match(triage, /要求:加重试上限/);
  assert.match(triage, /以原文为准定位/, "定位护栏两版共用");
  assert.doesNotMatch(triage, /请按意见修订报告与方案/, "分诊版不预设整批重写");
  assert.doesNotMatch(triage, /「检视意见回应」/);
  assert.doesNotMatch(triage, /重新 submit_analysis/);
});
