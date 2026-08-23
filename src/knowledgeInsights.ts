/**
 * 团队知识飞轮的只读聚合。
 *
 * 输入只来自任务摘要与知识足迹，输出只用于运营观察。这里不修改仓库、
 * 不评价某个内核步骤是否通过，也不把相关性包装成因果关系。
 */

import type {
  KnowledgeKind,
  TaskKnowledgeUsage,
} from "./knowledgeTrace.ts";

export type KnowledgeRecommendationKind =
  | "coverage-gap"
  | "needs-review"
  | "selected-unused"
  | "promote";

export type KnowledgeRecommendationTone = "attention" | "info" | "positive";

export interface KnowledgeInsightResource {
  key: string;
  kind: KnowledgeKind;
  name: string;
  path: string;
  repository?: string;
  provided_tasks: number;
  selected_tasks: number;
  loaded_tasks: number;
  accessed_tasks: number;
  access_events: number;
  completed_tasks: number;
  repair_tasks: number;
  attention_tasks: number;
  last_used_at?: string;
}

export interface KnowledgeRecommendation {
  id: string;
  kind: KnowledgeRecommendationKind;
  tone: KnowledgeRecommendationTone;
  title: string;
  evidence: string;
  action: string;
  resource_key?: string;
  task_ids?: string[];
}

export interface TeamKnowledgeInsights {
  generated_at: string;
  summary: {
    tracked_tasks: number;
    accessed_tasks: number;
    unique_resources: number;
    active_resources: number;
    selected_unused: number;
    opportunities: number;
    access_rate: number;
  };
  resources: KnowledgeInsightResource[];
  recommendations: KnowledgeRecommendation[];
}

export interface KnowledgeInsightTask {
  id: string;
  status: string;
  repository_skills?: unknown[];
  repository_knowledge?: unknown[];
  knowledge_usage?: TaskKnowledgeUsage;
  focus?: { needs_attention?: boolean };
  delivery?: {
    loop?: {
      round?: number;
      kind?: string;
      state?: string;
    };
  };
}

function resourceKey(resource: {
  kind: KnowledgeKind;
  path: string;
  repository?: string;
}): string {
  return [resource.repository ?? "", resource.kind, resource.path].join("\0");
}

function completed(task: KnowledgeInsightTask): boolean {
  return task.status === "completed" || task.status === "await_merge";
}

function repaired(task: KnowledgeInsightTask): boolean {
  const loop = task.delivery?.loop;
  return !!loop && ((loop.round ?? 0) > 0 || !!loop.kind
    || loop.state === "halted" || loop.state === "exhausted");
}

function needsAttention(task: KnowledgeInsightTask): boolean {
  return task.focus?.needs_attention === true
    || task.status === "failed" || task.status === "paused";
}

function tracked(task: KnowledgeInsightTask): boolean {
  return !!task.knowledge_usage
    || task.repository_knowledge !== undefined
    || task.repository_skills !== undefined;
}

function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function recommendations(
  resources: KnowledgeInsightResource[],
  frictionWithoutAccess: string[],
): KnowledgeRecommendation[] {
  const result: KnowledgeRecommendation[] = [];
  if (frictionWithoutAccess.length) {
    result.push({
      id: "coverage-gap",
      kind: "coverage-gap",
      tone: "attention",
      title: "返工或关注任务缺少主动知识访问",
      evidence: `${frictionWithoutAccess.length} 个任务出现修复或人工关注信号，`
        + "但没有观察到 Agent 主动读取业务知识。",
      action: "回看这些任务的共同问题，判断应补充仓库文档、项目规则还是专项 Skill。",
      task_ids: frictionWithoutAccess.slice(0, 8),
    });
  }

  for (const resource of resources.filter((item) => item.accessed_tasks >= 2
      && item.repair_tasks * 2 >= item.accessed_tasks).slice(0, 3)) {
    result.push({
      id: `review:${resource.key}`,
      kind: "needs-review",
      tone: "attention",
      title: `建议复核「${resource.name}」`,
      evidence: `${resource.accessed_tasks} 个任务主动访问，其中 `
        + `${resource.repair_tasks} 个随后出现修复信号。`,
      action: "核对内容是否过期、是否缺少关键命令或容易被误解；这里只表示相关性。",
      resource_key: resource.key,
    });
  }

  for (const resource of resources.filter((item) => item.selected_tasks >= 2
      && item.accessed_tasks === 0).slice(0, 3)) {
    result.push({
      id: `unused:${resource.key}`,
      kind: "selected-unused",
      tone: "info",
      title: `「${resource.name}」多次入选但未被主动访问`,
      evidence: `${resource.selected_tasks} 个任务选择了它，尚未观察到读取或检索。`,
      action: "检查名称和描述是否足够明确；若长期无用，可降低推荐优先级。",
      resource_key: resource.key,
    });
  }

  for (const resource of resources.filter((item) => item.accessed_tasks >= 3
      && item.completed_tasks >= 2 && item.repair_tasks === 0).slice(0, 2)) {
    result.push({
      id: `promote:${resource.key}`,
      kind: "promote",
      tone: "positive",
      title: `「${resource.name}」值得提升可见性`,
      evidence: `${resource.accessed_tasks} 个任务主动访问，`
        + `${resource.completed_tasks} 个已经交付，暂未观察到修复信号。`,
      action: "可考虑在 AGENTS.md 或任务推荐中更明确地指向它。",
      resource_key: resource.key,
    });
  }
  return result.slice(0, 8);
}

/** 聚合同一批任务的知识使用趋势。重复资源按 仓库+类型+路径 合并，
 * 不按内容 digest 拆散，便于观察同一文档跨版本的长期表现。 */
export function buildTeamKnowledgeInsights(
  tasks: KnowledgeInsightTask[],
  now = new Date(),
): TeamKnowledgeInsights {
  const observed = tasks.filter(tracked);
  const aggregate = new Map<string, KnowledgeInsightResource>();
  const taskAccess = new Set<string>();
  const frictionWithoutAccess: string[] = [];

  for (const task of observed) {
    const usage = task.knowledge_usage;
    const accessed = usage?.resources.some((item) => item.read_count > 0) ?? false;
    if (accessed) taskAccess.add(task.id);
    if (!accessed && (repaired(task) || needsAttention(task))) {
      frictionWithoutAccess.push(task.id);
    }
    for (const resource of usage?.resources ?? []) {
      const key = resourceKey(resource);
      const item = aggregate.get(key) ?? {
        key,
        kind: resource.kind,
        name: resource.name,
        path: resource.path,
        repository: resource.repository,
        provided_tasks: 0,
        selected_tasks: 0,
        loaded_tasks: 0,
        accessed_tasks: 0,
        access_events: 0,
        completed_tasks: 0,
        repair_tasks: 0,
        attention_tasks: 0,
      };
      item.name = resource.name || item.name;
      item.provided_tasks += 1;
      if (resource.selected) item.selected_tasks += 1;
      if (resource.loaded_count > 0) item.loaded_tasks += 1;
      if (resource.read_count > 0) {
        item.accessed_tasks += 1;
        item.access_events += resource.read_count;
        if (completed(task)) item.completed_tasks += 1;
        if (repaired(task)) item.repair_tasks += 1;
        if (needsAttention(task)) item.attention_tasks += 1;
      }
      if (resource.last_at
          && (!item.last_used_at || resource.last_at > item.last_used_at)) {
        item.last_used_at = resource.last_at;
      }
      aggregate.set(key, item);
    }
  }

  const resources = [...aggregate.values()].sort((left, right) =>
    right.accessed_tasks - left.accessed_tasks
      || right.access_events - left.access_events
      || right.loaded_tasks - left.loaded_tasks
      || left.name.localeCompare(right.name));
  const advice = recommendations(resources, frictionWithoutAccess);
  return {
    generated_at: now.toISOString(),
    summary: {
      tracked_tasks: observed.length,
      accessed_tasks: taskAccess.size,
      unique_resources: resources.length,
      active_resources: resources.filter((item) => item.accessed_tasks > 0).length,
      selected_unused: resources.filter((item) => item.selected_tasks > 0
        && item.accessed_tasks === 0).length,
      opportunities: advice.filter((item) => item.tone !== "positive").length,
      access_rate: percent(taskAccess.size, observed.length),
    },
    resources,
    recommendations: advice,
  };
}
