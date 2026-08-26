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

/** 飞轮第 3 步:货架效果账。宿主 skill 按 name 跨版本关联(path 带
 * 版本 key 不能当键);prepush 口径:passed 首轮=一次过,repairing/
 * blocked=首轮失败,environment_error 不计任何 skill 的账。 */
function hostSkillTask(options: {
  id: string;
  skills: Array<{ name: string; reads: number }>;
  prepush?: { state: string; round: number };
  repairRound?: number;
}): KnowledgeInsightTask {
  return {
    id: options.id,
    status: "completed",
    knowledge_usage: {
      summary: {
        resources: options.skills.length,
        loaded: 0,
        used: options.skills.filter((item) => item.reads > 0).length,
        skills_used: options.skills.filter((item) => item.reads > 0).length,
        selected_unused: 0,
      },
      resources: options.skills.map((skill) => ({
        id: `skill:${skill.name}`,
        kind: "skill" as const,
        name: skill.name,
        path: `.mae-flow-work/host-skills/deadbeef1234/SKILL.md`,
        state: skill.reads > 0 ? "used" as const : "available" as const,
        available_count: 1,
        loaded_count: 0,
        read_count: skill.reads,
      })),
      events: [],
    },
    delivery: {
      ...(options.prepush ? { prepush: options.prepush } : {}),
      ...(options.repairRound ? { loop: { round: options.repairRound } } : {}),
    },
  };
}

test("货架效果账:消费率、prepush 一次过对照与修订信号", async () => {
  const { buildHostSkillEffects } = await import("../src/knowledgeInsights.ts");
  const effects = buildHostSkillEffects([
    // java-autout:读了且首轮一次过。
    hostSkillTask({ id: "t1", skills: [{ name: "java-autout", reads: 2 }],
      prepush: { state: "passed", round: 1 } }),
    // 读了,修了三轮才过,且有修复环记录。
    hostSkillTask({ id: "t2", skills: [{ name: "java-autout", reads: 1 }],
      prepush: { state: "passed", round: 3 }, repairRound: 1 }),
    // 没读但一次过:进对照组。
    hostSkillTask({ id: "t3", skills: [{ name: "java-autout", reads: 0 }],
      prepush: { state: "passed", round: 1 } }),
    // 基础设施故障:不计任何账。
    hostSkillTask({ id: "t4", skills: [{ name: "java-autout", reads: 0 }],
      prepush: { state: "environment_error", round: 1 } }),
    // ghost 上架 3 单无人读:低消费信号。
    hostSkillTask({ id: "t5", skills: [{ name: "ghost", reads: 0 }] }),
    hostSkillTask({ id: "t6", skills: [{ name: "ghost", reads: 0 }] }),
    hostSkillTask({ id: "t7", skills: [{ name: "ghost", reads: 0 }] }),
    // flaky 读 2 单全返修:高摩擦信号。
    hostSkillTask({ id: "t8", skills: [{ name: "flaky", reads: 1 }],
      prepush: { state: "blocked", round: 2 }, repairRound: 2 }),
    hostSkillTask({ id: "t9", skills: [{ name: "flaky", reads: 1 }],
      repairRound: 1 }),
  ]);

  const autout = effects.get("java-autout")!;
  assert.equal(autout.provided_tasks, 4);
  assert.equal(autout.accessed_tasks, 2);
  assert.equal(autout.access_events, 3);
  assert.equal(autout.repair_tasks, 1);
  assert.deepEqual(
    [autout.prepush_first_pass, autout.prepush_measured], [1, 2],
    "读过的:t1 一次过,t2 三轮过;t4 环境故障不计账");
  assert.deepEqual(
    [autout.baseline_first_pass, autout.baseline_measured], [1, 2],
    "对照组=没读它但有结论的:t3 一次过 + t8(blocked=首轮失败)");
  assert.equal(autout.signal, undefined, "有人读且不高摩擦,不出信号");

  const ghost = effects.get("ghost")!;
  assert.equal(ghost.signal, "low-consumption");
  assert.match(String(ghost.signal_evidence), /3 个任务装载/);

  const flaky = effects.get("flaky")!;
  assert.equal(flaky.signal, "high-friction");
  assert.equal(flaky.repair_tasks, 2);
});
