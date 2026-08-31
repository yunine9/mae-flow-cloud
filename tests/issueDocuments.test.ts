/**
 * 过程文档数据面的契约测试(材料页签"过程文档"子视图):
 * - 清单:分析报告固定首位,其余最近修改在前;非 .md/子目录不入列;
 * - 读取:白名单即边界(零路径拼接),缺失如实 undefined;
 * - 问答投影:ADR-0008 口径(问答卡/用户决策/用户输入/检视意见,
 *   agent 发言不进;闸问句随决策合成),残行与未知事件跳过,触顶
 *   截断如实标注。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANALYSIS_DOC_NAME,
  listSessionDocuments,
  projectDialogue,
  readSessionDocument,
} from "../src/issueFlow/documents.ts";

test("过程文档清单:分析报告固定首位,其余最近修改在前;非顶层 .md 不入列", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-issue-docs-"));
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 分析报告");
  writeFileSync(join(root, "extra-notes.md"), "# 笔记");
  writeFileSync(join(root, "ignore.txt"), "不是文档");
  mkdirSync(join(root, "skills", "demo"), { recursive: true });
  writeFileSync(join(root, "skills", "demo", "SKILL.md"), "技能不是过程文档");
  // extra-notes 比分析报告新:mtime 排序不能把分析报告从首位挤下去。
  utimesSync(join(root, ANALYSIS_DOC_NAME), new Date(0), new Date(0));

  const docs = listSessionDocuments(root);
  assert.deepEqual(docs.map((doc) => doc.name),
    [ANALYSIS_DOC_NAME, "extra-notes.md"]);
  assert.equal(docs[0].label, "分析报告", "分析报告的页签名是服务端给的");
  assert.equal(docs[1].label, "extra-notes.md");
});

test("过程文档读取:白名单即边界,路径拼接零容忍;缺失返回 undefined", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-issue-doc-read-"));
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 分析报告\n\n根因在此。");

  const read = readSessionDocument(root, ANALYSIS_DOC_NAME);
  assert.ok(read);
  assert.equal(read.meta.label, "分析报告");
  assert.match(read.content, /根因在此/);
  assert.equal(read.truncated, false);

  assert.equal(readSessionDocument(root, "missing.md"), undefined,
    "不在清单里的名字一律 undefined");
  assert.equal(readSessionDocument(root, "../issue.json"), undefined,
    "带路径分隔的名字直接打回(读的是清单,不拼路径)");
  assert.equal(readSessionDocument(root, ""), undefined);
});

test("问答投影(ADR-0008 口径):问答卡/用户决策/用户输入/检视意见进,agent 发言不进;闸问句随决策合成", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-issue-dialogue-"));
  const lines = [
    { kind: "session_started", ts: "2026-08-29T08:00:00Z", payload: { resume: false } },
    { kind: "user_message", ts: "2026-08-29T08:00:01Z", payload: { text: "登录超时,帮我看看" } },
    // agent 的过程性发言:不进复盘投影(ADR-0008)
    { kind: "assistant_message", ts: "2026-08-29T08:00:05Z", payload: { text: "先拉日志看看。" } },
    // 无关工具调用不进对话
    { kind: "tool_requested", ts: "2026-08-29T08:00:06Z",
      payload: { call_id: "c1", name: "Bash", input: { command: "ls" } } },
    // 问答卡:选项是 Agent 现场给的字符串
    { kind: "tool_requested", ts: "2026-08-29T08:01:00Z",
      payload: { call_id: "c2", name: "AskUserQuestion", input: { questions: [
        { question: "超时发生在高峰期吗?", options: ["是", "否"] },
      ] } } },
    // Agent 卡的作答:问在上一张卡里,决策不带问句
    { kind: "human_decision", ts: "2026-08-29T08:02:00Z",
      payload: { waiting_id: "w1", state_version: 3,
        decision: "是", notes: "每天上午十点最明显" } },
    // 插话带 via 标记
    { kind: "user_message", ts: "2026-08-29T08:03:00Z",
      payload: { text: "补充:刚才重启过服务", via: "interrupt" } },
    // 检视提交(ADR-0007):意见清单整体进一条检视回合
    { kind: "review_submitted", ts: "2026-08-29T08:04:00Z",
      payload: { count: 2, text: "这是我人工检视《登录超时》分析报告的结果…" } },
    // 平台闸的作答:问句快照随事件落账(闸答完即从 issue.json 消失)
    { kind: "human_decision", ts: "2026-08-29T08:05:00Z",
      payload: { waiting_id: "gate-1", state_version: 5,
        decision: "确认报告,开始问题修改", notes: "",
        gate: { kind: "analysis_confirm", questions: [
          { question: "问题分析报告已产出,请查阅 issue-analysis.md 后确认",
            options: ["确认报告,开始问题修改", "有补充意见(填写补充说明)"] },
        ] } } },
    // 半行 JSON(写入方还在写)必须跳过
  ];
  writeFileSync(join(root, "events.jsonl"),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n"
    + '{"kind":"user_mess\n');

  const { turns, truncated } = projectDialogue(root);
  assert.equal(truncated, false);
  assert.deepEqual(turns.map((turn) => turn.kind),
    ["user", "card", "decision", "user", "review", "decision"]);
  // 联合类型按 kind 收窄后再断言字段。
  const byKind = (kind: string) => turns.filter((turn) => turn.kind === kind);
  const card = byKind("card")[0] as Extract<typeof turns[number], { kind: "card" }>;
  const decisions = byKind("decision") as Array<
    Extract<typeof turns[number], { kind: "decision" }>>;
  const steered = byKind("user")[1] as Extract<typeof turns[number], { kind: "user" }>;
  const first = byKind("user")[0] as Extract<typeof turns[number], { kind: "user" }>;
  const review = byKind("review")[0] as Extract<typeof turns[number], { kind: "review" }>;
  assert.equal(first.text, "登录超时,帮我看看");
  assert.equal(card.questions[0]?.question, "超时发生在高峰期吗?");
  assert.deepEqual(card.questions[0]?.options, ["是", "否"]);
  assert.equal(decisions[0].decision, "是");
  assert.equal(decisions[0].notes, "每天上午十点最明显");
  assert.equal(decisions[0].questions, undefined,
    "Agent 卡的问在卡里,决策不重复带问句");
  assert.equal(steered.via, "interrupt");
  assert.equal(review.count, 2);
  assert.match(review.text, /检视《登录超时》分析报告/);
  assert.equal(decisions[1].questions?.[0]?.question,
    "问题分析报告已产出,请查阅 issue-analysis.md 后确认",
    "平台闸的问句从事件快照合成,问答对不缺半边");
  assert.deepEqual(decisions[1].questions?.[0]?.options,
    ["确认报告,开始问题修改", "有补充意见(填写补充说明)"],
    "闸选项投影成人话文案,码不上对话面");
});

test("问答投影:事件文件缺失给空;触顶截断保留最新并如实标注", () => {
  const empty = mkdtempSync(join(tmpdir(), "mfc-issue-dialogue-empty-"));
  assert.deepEqual(projectDialogue(empty), { turns: [], truncated: false });

  const root = mkdtempSync(join(tmpdir(), "mfc-issue-dialogue-cap-"));
  const lines: string[] = [];
  for (let index = 0; index < 501; index += 1) {
    lines.push(JSON.stringify({
      kind: "user_message", ts: `2026-08-29T${String(index % 24).padStart(2, "0")}:00:00Z`,
      payload: { text: `第 ${index} 句` },
    }));
  }
  writeFileSync(join(root, "events.jsonl"), lines.join("\n") + "\n");
  const { turns, truncated } = projectDialogue(root);
  assert.equal(truncated, true);
  assert.equal(turns.length, 500);
  assert.equal((turns[0] as { text?: string }).text, "第 1 句", "触顶丢的是最旧的");
  assert.equal((turns.at(-1) as { text?: string }).text, "第 500 句");
});
