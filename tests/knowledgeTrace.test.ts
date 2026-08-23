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
