import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import {
  buildTeamKnowledgeInsights,
  type KnowledgeInsightTask,
} from "../src/knowledgeInsights.ts";
import type { TaskKnowledgeUsage } from "../src/knowledgeTrace.ts";
import type { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

function usage(options: {
  id: string;
  name: string;
  path: string;
  kind?: "document" | "skill" | "rules";
  selected?: boolean;
  loaded?: number;
  reads?: number;
}): TaskKnowledgeUsage {
  const loaded = options.loaded ?? 1;
  const reads = options.reads ?? 0;
  return {
    summary: {
      resources: 1,
      loaded: loaded > 0 ? 1 : 0,
      used: loaded > 0 || reads > 0 ? 1 : 0,
      skills_used: options.kind === "skill" && reads > 0 ? 1 : 0,
      selected_unused: options.selected && options.kind === "skill" && !reads ? 1 : 0,
    },
    resources: [{
      id: options.id,
      kind: options.kind ?? "document",
      name: options.name,
      path: options.path,
      repository: "https://code.example/team/orders.git",
      selected: options.selected,
      state: reads > 0 ? "used" : loaded > 0 ? "loaded" : "available",
      available_count: 0,
      loaded_count: loaded,
      read_count: reads,
      last_at: "2026-08-24T08:00:00.000Z",
    }],
    events: [],
  };
}

test("团队知识聚合按仓库/类型/路径合并并关联交付结果", () => {
  const tasks: KnowledgeInsightTask[] = [
    { id: "task-1", status: "completed", repository_skills: [],
      knowledge_usage: usage({ id: "v1", name: "订单构建", path: "docs/build.md", reads: 2 }) },
    { id: "task-2", status: "verifying", repository_skills: [],
      delivery: { loop: { round: 1, kind: "ci", state: "repairing" } },
      knowledge_usage: usage({ id: "v2", name: "订单构建指南", path: "docs/build.md", reads: 1 }) },
    { id: "legacy", status: "completed" },
  ];
  const result = buildTeamKnowledgeInsights(tasks, new Date("2026-08-24T09:00:00Z"));
  assert.equal(result.summary.tracked_tasks, 2, "老任务不稀释新口径");
  assert.equal(result.summary.access_rate, 100);
  assert.equal(result.resources.length, 1);
  assert.deepEqual(result.resources[0], {
    key: "https://code.example/team/orders.git\0document\0docs/build.md",
    kind: "document",
    name: "订单构建指南",
    path: "docs/build.md",
    repository: "https://code.example/team/orders.git",
    provided_tasks: 2,
    selected_tasks: 0,
    loaded_tasks: 2,
    accessed_tasks: 2,
    access_events: 3,
    completed_tasks: 1,
    repair_tasks: 1,
    attention_tasks: 0,
    last_used_at: "2026-08-24T08:00:00.000Z",
  });
  assert.ok(result.recommendations.some((item) =>
    item.kind === "needs-review" && item.evidence.includes("相关性") === false));
});

test("飞轮给出覆盖缺口、选而未用和正向沉淀建议", () => {
  const unused = usage({ id: "skill", kind: "skill", name: "发布助手",
    path: ".cac/skills/release/SKILL.md", selected: true, reads: 0 });
  const proven = usage({ id: "rules", kind: "rules", name: "AGENTS.md",
    path: "AGENTS.md", reads: 1 });
  const tasks: KnowledgeInsightTask[] = [
    { id: "gap", status: "paused", repository_skills: [], knowledge_usage: {
      summary: { resources: 0, loaded: 0, used: 0, skills_used: 0, selected_unused: 0 },
      resources: [], events: [],
    } },
    { id: "unused-1", status: "running", repository_skills: [{}], knowledge_usage: unused },
    { id: "unused-2", status: "running", repository_skills: [{}], knowledge_usage: unused },
    ...[1, 2, 3].map((index): KnowledgeInsightTask => ({
      id: `done-${index}`, status: "completed", repository_knowledge: [],
      knowledge_usage: proven,
    })),
  ];
  const result = buildTeamKnowledgeInsights(tasks);
  assert.equal(result.summary.tracked_tasks, 6);
  assert.equal(result.summary.accessed_tasks, 3);
  assert.equal(result.summary.selected_unused, 1);
  assert.ok(result.recommendations.some((item) =>
    item.kind === "coverage-gap" && item.task_ids?.includes("gap")));
  assert.ok(result.recommendations.some((item) => item.kind === "selected-unused"));
  assert.ok(result.recommendations.some((item) => item.kind === "promote"));
});

test("小样本只展示事实，不强行生成资源优劣结论", () => {
  const result = buildTeamKnowledgeInsights([{
    id: "task-1", status: "running", repository_knowledge: [],
    knowledge_usage: usage({ id: "one", name: "单次知识", path: "docs/one.md", reads: 1 }),
  }]);
  assert.equal(result.summary.opportunities, 0);
  assert.deepEqual(result.recommendations, []);
});

test("团队知识效能使用独立只读 HTTP 接口", async () => {
  const expected = buildTeamKnowledgeInsights([],
    new Date("2026-08-24T09:00:00Z"));
  const service = { knowledgeInsights: () => expected } as TaskService;
  const server = createTaskServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/knowledge-insights`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
});
