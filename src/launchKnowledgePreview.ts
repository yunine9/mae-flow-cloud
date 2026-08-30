/** 发起任务前的权威知识匹配：与任务快照复用同一选择器和工作流并入规则。 */

import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import {
  listBusinessModules,
  readBusinessKnowledgeAsset,
} from "./businessModuleLibrary.ts";
import {
  selectBusinessModules,
  type SelectedBusinessModule,
} from "./businessModuleRuntime.ts";
import {
  ENGINEERING_KNOWLEDGE_LIMITS,
  selectEngineeringKnowledge,
  type EngineeringKnowledgeSelection,
} from "./engineeringKnowledgeRuntime.ts";
import {
  knowledgeMatchesTask,
  repositoryIdentity,
  type KnowledgeAssetMetadata,
} from "./knowledgeAssetModel.ts";
import { normalizeKnowledgeLanguages } from "./knowledgeLanguages.ts";
import {
  listHostSkillShelf,
  type HostSkillShelfEntry,
} from "./hostSkillShelf.ts";
import { validateHostSkillSnapshotPackage } from "./hostSkillRuntime.ts";
import {
  resolveRepositoryProfiles,
  type RepositoryProfile,
} from "./repositoryProfiles.ts";
import { workflowKnowledgeSelections } from "./workflowAssetResolution.ts";

export type LaunchKnowledgePreviewSource =
  | "business_modules"
  | "engineering_knowledge"
  | "team_skills"
  | "repository_profiles";

export interface LaunchKnowledgePreviewNotice {
  source: LaunchKnowledgePreviewSource;
  code: "catalog_unavailable" | "catalog_warning" | "limit_applied"
    | "selection_invalid";
  message: string;
}

interface MatchedScope {
  /** 只返回这一次真正命中的交集；空数组表示该维度没有限定条件。 */
  matched_business_module_ids: string[];
  matched_repositories: string[];
  matched_technologies: string[];
}

export interface LaunchBusinessKnowledgePreview extends MatchedScope {
  module_id: string;
  module_name: string;
  module_revision: number;
  id: string;
  title: string;
  summary: string;
  when_to_use: string;
  form: "document" | "skill" | "rule" | "example";
  repositories: string[];
  version: number;
  digest: string;
  bytes: number;
}

export interface LaunchEngineeringKnowledgePreview extends MatchedScope {
  id: string;
  title: string;
  summary: string;
  when_to_use: string;
  form: "document" | "rule" | "example";
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
  digest: string;
  bytes: number;
}

export interface LaunchTeamSkillPreview extends MatchedScope {
  name: string;
  description: string;
  form: "skill";
  nature: "business" | "engineering";
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
  /** 稳定管理定位与版本身份：GET /skills/:path首段。 */
  path: string;
  digest: string;
  package_digest: string;
  bytes: number;
  updated_at: string;
}

export interface LaunchKnowledgePreview {
  /** 当前返回清单可以被创建时为 true。可选目录降级仍可 true；只有
   * 用户/工作流明确选中的资产无法固定时才 false。 */
  complete: boolean;
  /** 任一可选目录 fail-open 或返回治理告警时为 true。 */
  degraded: boolean;
  scope: {
    repositories: string[];
    technologies: string[];
    business_module_ids: string[];
    workflow_business_module_ids: string[];
    workflow_engineering_knowledge_ids: string[];
    workflow_team_skill_ids: string[];
  };
  business_knowledge: LaunchBusinessKnowledgePreview[];
  engineering_knowledge: LaunchEngineeringKnowledgePreview[];
  team_skills: LaunchTeamSkillPreview[];
  /** 当前有序清单与版本身份的服务端指纹；创建时必须原样对拍。 */
  selection_digest: string;
  limits: {
    engineering_knowledge: EngineeringKnowledgeSelection["limits"] & {
      matched: number;
      selected: number;
      omitted: number;
    };
  };
  warnings: LaunchKnowledgePreviewNotice[];
  /** 非空表示按当前输入真正创建任务会被拒绝。 */
  errors: LaunchKnowledgePreviewNotice[];
}

export interface LaunchKnowledgePreviewInput {
  repositories?: string[];
  selectedBusinessModuleIds?: string[];
  selectedEngineeringKnowledgeIds?: string[];
  selectedHostSkillPaths?: string[];
  repositoryProfiles?: Array<Pick<RepositoryProfile,
    "repository" | "technologies" | "confirmed">>;
  workflowDefinition?: unknown;
}

/** 创建与预览共用：工作流引用必须强制并入人工选择。 */
export function effectiveLaunchKnowledgeSelections(input: {
  selectedBusinessModuleIds?: string[];
  selectedEngineeringKnowledgeIds?: string[];
  workflowDefinition?: unknown;
}): {
  businessModuleIds: string[];
  engineeringKnowledgeIds?: string[];
  workflow: ReturnType<typeof workflowKnowledgeSelections>;
} {
  const workflow = input.workflowDefinition === undefined
    ? { businessModuleIds: [], engineeringKnowledgeIds: [], teamSkillIds: [] }
    : workflowKnowledgeSelections(input.workflowDefinition);
  return {
    businessModuleIds: [...new Set([
      ...(input.selectedBusinessModuleIds ?? []),
      ...workflow.businessModuleIds,
    ].map(String).map((item) => item.trim()).filter(Boolean))],
    engineeringKnowledgeIds:
      input.selectedEngineeringKnowledgeIds === undefined
        && workflow.engineeringKnowledgeIds.length === 0 ? undefined
        : [...new Set([
            ...(input.selectedEngineeringKnowledgeIds ?? []),
            ...workflow.engineeringKnowledgeIds,
          ].map(String).map((item) => item.trim()).filter(Boolean))],
    workflow,
  };
}

function normalizedRepositories(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map(String).map((item) => item.trim())
    .filter(Boolean))];
}

function matchedScope(
  metadata: Pick<KnowledgeAssetMetadata,
    "business_module_ids" | "repositories" | "technologies">,
  context: { repositories: string[]; technologies: string[];
    businessModuleIds: string[] },
): MatchedScope {
  const scopedRepositories = new Set(
    metadata.repositories.map(repositoryIdentity));
  const scopedTechnologies = new Set(metadata.technologies);
  const scopedModules = new Set(metadata.business_module_ids);
  return {
    matched_business_module_ids: metadata.business_module_ids.length
      ? context.businessModuleIds.filter((id) => scopedModules.has(id)) : [],
    matched_repositories: metadata.repositories.length
      ? context.repositories.filter((repository) =>
        scopedRepositories.has(repositoryIdentity(repository))) : [],
    matched_technologies: metadata.technologies.length
      ? context.technologies.filter((technology) =>
        scopedTechnologies.has(technology)) : [],
  };
}

function businessPreview(
  modules: SelectedBusinessModule[],
  context: { repositories: string[]; technologies: string[];
    businessModuleIds: string[] },
): LaunchBusinessKnowledgePreview[] {
  return modules.flatMap((module) => module.assets.map((asset) => ({
    module_id: module.id,
    module_name: module.name,
    module_revision: module.revision,
    id: asset.id,
    title: asset.title,
    summary: asset.summary,
    when_to_use: asset.when_to_use,
    form: asset.form,
    repositories: [...asset.repositories],
    version: asset.version,
    digest: asset.digest,
    bytes: asset.bytes,
    // 业务资产的模块归属由所在模块提供，而不是正文元数据字段。
    ...matchedScope({
      business_module_ids: [module.id],
      repositories: asset.repositories,
      technologies: [],
    }, context),
  })));
}

function selectionDigest(input: {
  repositories: string[];
  technologies: string[];
  businessModuleIds: string[];
  businessKnowledge: LaunchBusinessKnowledgePreview[];
  engineeringKnowledge: LaunchEngineeringKnowledgePreview[];
  teamSkills: LaunchTeamSkillPreview[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    schema: "mae-flow-launch-knowledge-selection/1",
    repositories: input.repositories,
    technologies: input.technologies,
    business_module_ids: input.businessModuleIds,
    business_knowledge: input.businessKnowledge.map((item) => ({
      module_id: item.module_id,
      module_revision: item.module_revision,
      id: item.id,
      version: item.version,
      digest: item.digest,
    })),
    engineering_knowledge: input.engineeringKnowledge.map((item) => ({
      id: item.id,
      digest: item.digest,
    })),
    team_skills: input.teamSkills.map((item) => ({
      path: item.path,
      digest: item.digest,
      package_digest: item.package_digest,
    })),
  })).digest("hex");
}

export function previewLaunchKnowledge(
  dataDir: string,
  input: LaunchKnowledgePreviewInput,
): LaunchKnowledgePreview {
  const warnings: LaunchKnowledgePreviewNotice[] = [];
  const errors: LaunchKnowledgePreviewNotice[] = [];
  let degraded = false;
  const repositories = normalizedRepositories(input.repositories);
  let profiles = input.repositoryProfiles;
  if (profiles === undefined && repositories.length) {
    try {
      profiles = resolveRepositoryProfiles(dataDir, repositories)
        .flatMap((item) => item.profile ? [item.profile] : []);
    } catch (error) {
      degraded = true;
      warnings.push({ source: "repository_profiles",
        code: "catalog_unavailable",
        message: `仓库技术画像目录读取失败，已退化为按代码仓匹配：${String(error)}` });
      profiles = [];
    }
  }
  const technologies: string[] = [];
  for (const profile of profiles ?? []) {
    try {
      technologies.push(...normalizeKnowledgeLanguages(profile.technologies)
        .filter((technology) => technology !== "agnostic"));
    } catch (error) {
      degraded = true;
      warnings.push({ source: "repository_profiles",
        code: "catalog_warning",
        message: `代码仓 ${profile.repository} 的技术画像无效，已退化为按代码仓匹配：${String(error)}` });
    }
  }
  const uniqueTechnologies = [...new Set(technologies)];
  const selections = effectiveLaunchKnowledgeSelections({
    selectedBusinessModuleIds: input.selectedBusinessModuleIds,
    selectedEngineeringKnowledgeIds: input.selectedEngineeringKnowledgeIds,
    workflowDefinition: input.workflowDefinition,
  });

  // 即使当前没有选模块，也要把目录损坏摆在明面，不能把“读不到”伪装
  // 成“没有匹配项”。真正选择仍由 selectBusinessModules 执行。
  try {
    const catalog = listBusinessModules(dataDir);
    if (catalog.warnings.length) {
      degraded = true;
      warnings.push(...catalog.warnings.map((message) => ({
        source: "business_modules" as const,
        code: "catalog_warning" as const,
        message,
      })));
    }
  }
  catch (error) {
    degraded = true;
    warnings.push({ source: "business_modules", code: "catalog_unavailable",
      message: `业务模块目录读取失败：${String(error)}` });
  }
  let businessModules: SelectedBusinessModule[] = [];
  try {
    businessModules = selectBusinessModules({
      dataDir,
      moduleIds: selections.businessModuleIds,
      repositories,
    });
    // 选择器不把正文带出服务端，但预览仍要验证真正创建时会读取的固定
    // 版本，避免“目录有标题、正文已坏”直到点击创建才暴露。
    for (const module of businessModules) {
      for (const asset of module.assets) {
        readBusinessKnowledgeAsset(dataDir, module.id, asset.id, asset.version);
      }
    }
  } catch (error) {
    errors.push({ source: "business_modules", code: "selection_invalid",
      message: error instanceof Error ? error.message : String(error) });
  }
  const context = {
    repositories,
    technologies: uniqueTechnologies,
    businessModuleIds: businessModules.map((module) => module.id),
  };

  let engineeringSelection: EngineeringKnowledgeSelection = {
    items: [], matched: 0, omitted: 0, warnings: [],
    limits: { ...ENGINEERING_KNOWLEDGE_LIMITS },
  };
  try {
    engineeringSelection = selectEngineeringKnowledge({
      dataDir, ...context,
      selectedIds: selections.engineeringKnowledgeIds,
    });
    if (engineeringSelection.warnings.length) {
      degraded = true;
      const notices = engineeringSelection.warnings.map((message) => ({
        source: "engineering_knowledge" as const,
        code: selections.engineeringKnowledgeIds !== undefined
          ? "selection_invalid" as const : "catalog_warning" as const,
        message,
      }));
      if (selections.engineeringKnowledgeIds !== undefined) {
        errors.push(...notices);
      } else {
        warnings.push(...notices);
      }
    }
    if (engineeringSelection.omitted) {
      warnings.push({ source: "engineering_knowledge", code: "limit_applied",
        message: `有 ${engineeringSelection.omitted} 项匹配工程知识因 40 项 / 4 MiB 任务上限未进入本次快照` });
    }
  } catch (error) {
    degraded = true;
    const notice = { source: "engineering_knowledge" as const,
      code: selections.engineeringKnowledgeIds !== undefined
        ? "selection_invalid" as const : "catalog_unavailable" as const,
      message: selections.engineeringKnowledgeIds !== undefined
        ? `明确选择的工程知识无法固定：${String(error)}`
        : `团队工程知识目录读取失败，任务将退化为无工程知识：${String(error)}` };
    if (selections.engineeringKnowledgeIds !== undefined) errors.push(notice);
    else warnings.push(notice);
  }

  const selectedHostSkillPaths = input.selectedHostSkillPaths === undefined
      && selections.workflow.teamSkillIds.length === 0
    ? undefined : new Set((input.selectedHostSkillPaths ?? []).map(String)
      .map((item) => item.replace(/\\/g, "/").replace(/^\.\//, "")));
  let teamSkills: HostSkillShelfEntry[] = [];
  try {
    const shelf = listHostSkillShelf(dataDir);
    if (shelf.warnings.length) {
      degraded = true;
      warnings.push(...shelf.warnings.map((message) => ({
        source: "team_skills" as const,
        code: "catalog_warning" as const,
        message,
      })));
    }
    const explicitlySelectedPaths = new Set(
      (input.selectedHostSkillPaths ?? []).map(String)
        .map((item) => item.replace(/\\/g, "/").replace(/^\.\//, "")));
    for (const path of explicitlySelectedPaths) {
      const selected = shelf.skills.find((skill) => skill.path === path);
      if (!selected?.loadable) {
        errors.push({ source: "team_skills", code: "selection_invalid",
          message: `明确选择的团队 Skill ${path} 不存在或当前不可装载` });
      }
    }
    for (const id of selections.workflow.teamSkillIds) {
      const required = shelf.skills.filter((skill) =>
        (skill.source_path ?? skill.path).split("/")[0] === id);
      if (!required.some((skill) => skill.loadable)) {
        errors.push({ source: "team_skills", code: "selection_invalid",
          message: `工作流引用的团队 Skill ${id} 不存在或当前不可装载` });
      }
    }
    if (selectedHostSkillPaths && selections.workflow.teamSkillIds.length) {
      for (const skill of shelf.skills) {
        if (selections.workflow.teamSkillIds.includes(
            (skill.source_path ?? skill.path).split("/")[0])) {
          selectedHostSkillPaths.add(skill.path);
        }
      }
    }
    const matchedSkills = shelf.skills.filter((skill) => skill.loadable
      && skill.nature !== "unclassified"
      && (!selectedHostSkillPaths || selectedHostSkillPaths.has(skill.path))
      && knowledgeMatchesTask(skill, context));
    const skillsRoot = join(dataDir, "skills");
    teamSkills = matchedSkills.filter((skill) => {
      try {
        const sourceFile = join(skillsRoot, skill.path);
        const inspected = validateHostSkillSnapshotPackage({
          sourceRoot: skillsRoot,
          sourceFile,
          packageRoot: dirname(sourceFile),
        });
        if (inspected.package_digest !== skill.package_digest) {
          throw new Error("Skill 包指纹在目录读取后发生变化");
        }
        return true;
      } catch (error) {
        degraded = true;
        const explicitlyRequired = selections.workflow.teamSkillIds.includes(
          (skill.source_path ?? skill.path).split("/")[0])
          || (input.selectedHostSkillPaths ?? []).includes(skill.path);
        const notice = { source: "team_skills" as const,
          code: explicitlyRequired
            ? "selection_invalid" as const : "catalog_warning" as const,
          message: `${skill.name}：${error instanceof Error
            ? error.message : String(error)}` };
        if (explicitlyRequired) errors.push(notice);
        else warnings.push(notice);
        return false;
      }
    });
  } catch (error) {
    degraded = true;
    const required = selectedHostSkillPaths !== undefined;
    const notice = { source: "team_skills" as const,
      code: required ? "selection_invalid" as const : "catalog_unavailable" as const,
      message: required
        ? `明确选择的团队 Skill 无法固定：${String(error)}`
        : `团队 Skill 目录读取失败，任务将退化为无团队 Skill：${String(error)}` };
    if (required) errors.push(notice);
    else warnings.push(notice);
  }

  const businessKnowledge = businessPreview(businessModules, context);
  const engineeringKnowledge = engineeringSelection.items.map((item) => ({
    id: item.id,
    title: item.title,
    summary: item.summary,
    when_to_use: item.when_to_use,
    form: item.form as "document" | "rule" | "example",
    business_module_ids: [...item.business_module_ids],
    repositories: [...item.repositories],
    technologies: [...item.technologies],
    digest: item.digest,
    bytes: item.bytes,
    ...matchedScope(item, context),
  }));
  const previewSkills = teamSkills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    form: skill.form,
    nature: skill.nature as "business" | "engineering",
    business_module_ids: [...skill.business_module_ids],
    repositories: [...skill.repositories],
    technologies: [...skill.technologies],
    path: skill.path,
    digest: skill.digest,
    package_digest: skill.package_digest,
    bytes: skill.bytes,
    updated_at: skill.updated_at,
    ...matchedScope(skill, context),
  }));
  return {
    complete: errors.length === 0,
    degraded,
    scope: {
      repositories,
      technologies: uniqueTechnologies,
      business_module_ids: context.businessModuleIds,
      workflow_business_module_ids: selections.workflow.businessModuleIds,
      workflow_engineering_knowledge_ids:
        selections.workflow.engineeringKnowledgeIds,
      workflow_team_skill_ids: selections.workflow.teamSkillIds,
    },
    business_knowledge: businessKnowledge,
    engineering_knowledge: engineeringKnowledge,
    team_skills: previewSkills,
    selection_digest: selectionDigest({
      repositories,
      technologies: uniqueTechnologies,
      businessModuleIds: context.businessModuleIds,
      businessKnowledge,
      engineeringKnowledge,
      teamSkills: previewSkills,
    }),
    limits: { engineering_knowledge: {
      ...engineeringSelection.limits,
      matched: engineeringSelection.matched,
      selected: engineeringSelection.items.length,
      omitted: engineeringSelection.omitted,
    } },
    warnings,
    errors,
  };
}
