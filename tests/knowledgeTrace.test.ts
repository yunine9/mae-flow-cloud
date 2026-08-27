import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KnowledgeTrace,
  knowledgeUsageSnapshot,
} from "../src/knowledgeTrace.ts";

test("按会话与阶段记录规则、文档和 Skill 的真实消费", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-knowledge-trace-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "docs"), { recursive: true });
  mkdirSync(join(root, "skill"), { recursive: true });
  const rules = join(repo, "AGENTS.md");
  const document = join(repo, "docs", "orders.md");
  const skill = join(root, "skill", "SKILL.md");
  writeFileSync(rules, "规则\n");
  writeFileSync(document, "订单知识\n");
  writeFileSync(skill, "Skill\n");
  const trace = new KnowledgeTrace(
    join(root, "knowledge-events.jsonl"), "task-1", repo,
    () => "build", undefined,
  );
  trace.register(skill, {
    id: "skill-1", kind: "skill", name: "order-helper",
    path: ".agents/skills/order-helper/SKILL.md", selected: true,
  }, true);
  const documentResource = {
    id: "doc-1", kind: "document", name: "订单知识",
    path: "docs/orders.md", selected: true,
  } as const;
  trace.register(document, documentResource);
  trace.record("loaded", "main", documentResource);
  trace.observeTool("child-ut", "Read", { path: skill }, false);
  trace.observeTool("main", "Read", { file_path: rules }, false);
  trace.observeTool("main", "Grep", { path: "docs/orders.md" }, false);

  const usage = knowledgeUsageSnapshot({ workspace: root })!;
  assert.equal(usage.summary.used, 3);
  assert.equal(usage.summary.skills_used, 1);
  assert.ok(usage.events.some((event) => event.session_role === "subagent"
    && event.name === "order-helper" && event.action === "read"));
  assert.ok(usage.events.some((event) => event.kind === "rules"
    && event.step === "build"));
  assert.ok(usage.resources.every((item) => !item.path.startsWith(root)),
    "读侧不能暴露宿主绝对路径");
});

test("坏足迹行和不可写观测旁路不会影响任务读侧", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-knowledge-trace-bad-"));
  writeFileSync(join(root, "knowledge-events.jsonl"), "bad json\n");
  assert.equal(knowledgeUsageSnapshot({ workspace: root }), undefined);
});

test("自发读取的文档带首标题摘要:排行可读性来自观测那一刻", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-knowledge-summary-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "gateway.md"),
    "<!-- 头注 -->\n\n# 支付网关对接指南\n\n所有渠道必须走统一网关重试与对账。\n\n## 细节\n");
  // 没有标题也没有正文头的文件:摘要缺席,不许编。
  writeFileSync(join(repo, "docs", "raw.md"), "| a | b |\n|---|---|\n");
  const trace = new KnowledgeTrace(
    join(root, "knowledge-events.jsonl"), "task-1", repo,
    () => "build", undefined,
  );
  trace.observeTool("main", "Read", {
    file_path: join(repo, "docs", "gateway.md") }, false);
  trace.observeTool("main", "Read", {
    file_path: join(repo, "docs", "raw.md") }, false);

  const usage = knowledgeUsageSnapshot({ workspace: root })!;
  const guide = usage.resources.find((item) => item.path === "docs/gateway.md")!;
  assert.equal(guide.description,
    "支付网关对接指南 — 所有渠道必须走统一网关重试与对账。");
  const raw = usage.resources.find((item) => item.path === "docs/raw.md")!;
  assert.equal(raw.description, undefined, "抽不出摘要就空着,不拿表格行凑数");
});
