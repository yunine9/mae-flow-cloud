export const TASK_KNOWLEDGE_PAGE_SIZE = 40;

export interface LaunchEngineeringKnowledge {
  id: string;
  title: string;
  summary: string;
  when_to_use: string;
  form: "document" | "rule" | "example";
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
}

export interface LaunchTeamSkill {
  name: string;
  description: string;
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
  path: string;
}

export type TaskKnowledgeChoice =
  | { kind: "engineering"; key: string; item: LaunchEngineeringKnowledge }
  | { kind: "skill"; key: string; item: LaunchTeamSkill };

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord : undefined;
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim()).filter(Boolean))];
}

/**
 * launch-options is a deployment boundary: an older service or one legacy
 * asset must not be able to take down the whole launch screen. Invalid rows
 * without a stable identity are ignored; optional matching metadata degrades
 * to an empty list (meaning generally applicable).
 */
export function normalizeLaunchKnowledgeCatalog(value: unknown): {
  engineering: LaunchEngineeringKnowledge[];
  skills: LaunchTeamSkill[];
} {
  const source = record(value);
  const engineering: LaunchEngineeringKnowledge[] = [];
  const engineeringIds = new Set<string>();
  const rawEngineering = Array.isArray(source?.engineering_knowledge)
    ? source.engineering_knowledge : [];
  for (const raw of rawEngineering) {
    const item = record(raw);
    const id = string(item?.id);
    if (!item || !id || engineeringIds.has(id)) continue;
    const rawForm = string(item.form);
    const form = rawForm === "rule" || rawForm === "example"
      ? rawForm : "document";
    engineeringIds.add(id);
    engineering.push({
      id,
      title: string(item.title) || id,
      summary: string(item.summary),
      when_to_use: string(item.when_to_use),
      form,
      business_module_ids: strings(item.business_module_ids),
      repositories: strings(item.repositories),
      technologies: strings(item.technologies),
    });
  }

  const skills: LaunchTeamSkill[] = [];
  const skillPaths = new Set<string>();
  const rawSkills = Array.isArray(source?.team_skills) ? source.team_skills : [];
  for (const raw of rawSkills) {
    const item = record(raw);
    const path = string(item?.path);
    if (!item || !path || skillPaths.has(path)) continue;
    skillPaths.add(path);
    skills.push({
      path,
      name: string(item.name) || path,
      description: string(item.description),
      business_module_ids: strings(item.business_module_ids),
      repositories: strings(item.repositories),
      technologies: strings(item.technologies),
    });
  }
  return { engineering, skills };
}

export function buildTaskKnowledgeChoices(
  engineering: LaunchEngineeringKnowledge[],
  skills: LaunchTeamSkill[],
  query: string,
): TaskKnowledgeChoice[] {
  const choices: TaskKnowledgeChoice[] = [
    ...engineering.map((item): TaskKnowledgeChoice => ({
      kind: "engineering", key: `engineering:${item.id}`, item,
    })),
    ...skills.map((item): TaskKnowledgeChoice => ({
      kind: "skill", key: `skill:${item.path}`, item,
    })),
  ];
  const wanted = query.trim().toLocaleLowerCase();
  if (!wanted) return choices;
  return choices.filter((choice) => {
    const fields = choice.kind === "engineering"
      ? [choice.item.title, choice.item.summary, choice.item.when_to_use,
        ...choice.item.repositories, ...choice.item.technologies]
      : [choice.item.name, choice.item.description, choice.item.path,
        ...choice.item.repositories, ...choice.item.technologies];
    return fields.some((field) => field.toLocaleLowerCase().includes(wanted));
  });
}

export function paginateTaskKnowledgeChoices(
  choices: TaskKnowledgeChoice[],
  requestedPage: number,
  pageSize = TASK_KNOWLEDGE_PAGE_SIZE,
): { items: TaskKnowledgeChoice[]; page: number; pages: number; total: number } {
  const safePageSize = Number.isSafeInteger(pageSize) && pageSize > 0
    ? pageSize : TASK_KNOWLEDGE_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(choices.length / safePageSize));
  const page = Math.min(Math.max(0, Math.trunc(requestedPage) || 0), pages - 1);
  return {
    items: choices.slice(page * safePageSize, (page + 1) * safePageSize),
    page,
    pages,
    total: choices.length,
  };
}
