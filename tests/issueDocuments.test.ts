/**
 * 过程文档数据面的契约测试(材料页签"过程文档"子视图):
 * - 清单:分析报告固定首位,其余最近修改在前;非 .md/子目录不入列;
 * - 读取:白名单即边界(零路径拼接),缺失如实 undefined;
 * - 问答投影:消息/问答卡/用户决策成对话回合,残行与未知事件跳过,
 *   触顶截断如实标注。
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

test("问答投影:消息/问答卡/用户决策成对话回合;残行、无关工具与未知事件跳过", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-issue-dialogue-"));
  const lines = [
    { kind: "session_started", ts: "2026-08-29T08:00:00Z", payload: { resume: false } },
    { kind: "user_message", ts: "2026-08-29T08:00:01Z", payload: { text: "登录超时,帮我看看" } },
    { kind: "assistant_message", ts: "2026-08-29T08:00:05Z", payload: { text: "先拉日志看看。" } },
    // 无关工具调用不进对话
    { kind: "tool_requested", ts: "2026-08-29T08:00:06Z",
      payload: { call_id: "c1", name: "Bash", input: { command: "ls" } } },
    // 问答卡:选项是 Agent 现场给的字符串
    { kind: "tool_requested", ts: "2026-08-29T08:01:00Z",
      payload: { call_id: "c2", name: "AskUserQuestion", input: { questions: [
        { question: "超时发生在高峰期吗?", options: ["是", "否"] },
      ] } } },
    { kind: "human_decision", ts: "2026-08-29T08:02:00Z",
      payload: { waiting_id: "w1", state_version: 3,
        decision: "是", notes: "每天上午十点最明显" } },
    // 插话带 via 标记
    { kind: "user_message", ts: "2026-08-29T08:03:00Z",
      payload: { text: "补充:刚才重启过服务", via: "interrupt" } },
    // 半行 JSON(写入方还在写)必须跳过
  ];
  writeFileSync(join(root, "events.jsonl"),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n"
    + '{"kind":"user_mess\n');

  const { turns, truncated } = projectDialogue(root);
  assert.equal(truncated, false);
  assert.deepEqual(turns.map((turn) => turn.kind),
    ["user", "agent", "card", "decision", "user"]);
  // 联合类型按 kind 收窄后再断言字段。
  const byKind = (kind: string) => turns.filter((turn) => turn.kind === kind);
  const card = byKind("card")[0] as Extract<typeof turns[number], { kind: "card" }>;
  const decision = byKind("decision")[0] as Extract<typeof turns[number], { kind: "decision" }>;
  const steered = byKind("user")[1] as Extract<typeof turns[number], { kind: "user" }>;
  const first = byKind("user")[0] as Extract<typeof turns[number], { kind: "user" }>;
  assert.equal(first.text, "登录超时,帮我看看");
  assert.equal(card.questions[0]?.question, "超时发生在高峰期吗?");
  assert.deepEqual(card.questions[0]?.options, ["是", "否"]);
  assert.equal(decision.decision, "是");
  assert.equal(decision.notes, "每天上午十点最明显");
  assert.equal(steered.via, "interrupt");
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
