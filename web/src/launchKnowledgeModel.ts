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
  nature: "business" | "engineering";
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
  path: string;
}

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
 * and knowledge without mandatory governance scope are ignored: the launch
 * page must never pretend an unclassified asset will be matched.
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
    const technologies = strings(item?.technologies);
    if (!item || !id || engineeringIds.has(id) || !technologies.length) continue;
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
      technologies,
    });
  }

  const skills: LaunchTeamSkill[] = [];
  const skillPaths = new Set<string>();
  const rawSkills = Array.isArray(source?.team_skills) ? source.team_skills : [];
  for (const raw of rawSkills) {
    const item = record(raw);
    const path = string(item?.path);
    const nature = string(item?.nature);
    const businessModuleIds = strings(item?.business_module_ids);
    const technologies = strings(item?.technologies);
    if (!item || !path || skillPaths.has(path)
        || nature !== "business" && nature !== "engineering"
        || nature === "business" && !businessModuleIds.length
        || nature === "engineering" && !technologies.length) continue;
    skillPaths.add(path);
    skills.push({
      path,
      name: string(item.name) || path,
      description: string(item.description),
      nature,
      business_module_ids: businessModuleIds,
      repositories: strings(item.repositories),
      technologies,
    });
  }
  return { engineering, skills };
}
