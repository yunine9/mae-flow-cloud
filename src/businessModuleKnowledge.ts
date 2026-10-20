import { BusinessModuleError, listBusinessModules, normalizeModuleKnowledgeLocation, readBusinessModule, updateBusinessModule, type BusinessModuleKnowledgeLocation } from "./businessModuleLibrary.ts";
import { readKnowledgeRepoConfig } from "./knowledgeRepoConfig.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";

/** 只有用户保存的绑定才能作为读写位置，建议值不能悄悄改变正式知识来源。 */
export function resolveModuleKnowledgeLocation(dataDir: string, moduleId: string): BusinessModuleKnowledgeLocation | undefined {
  const location = readBusinessModule(dataDir, moduleId).knowledge_location;
  return location ? { ...location } : undefined;
}

export function suggestModuleKnowledgeLocation(dataDir: string, moduleId: string): BusinessModuleKnowledgeLocation | undefined {
  const module = readBusinessModule(dataDir, moduleId);
  if (module.knowledge_location) return { ...module.knowledge_location };
  const config = readKnowledgeRepoConfig(dataDir);
  if (!config?.url) return undefined;
  const name = module.name.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/^[.\s]+|[.\s]+$/g, "") || "领域知识";
  const base = `${config.docs_path || "docs/knowledge"}/${name}`;
  const used = listBusinessModules(dataDir).modules.flatMap(item => item.knowledge_location && item.id !== module.id ? [item.knowledge_location] : []);
  for (let suffix = 1; suffix <= used.length + 1; suffix++) {
    const candidate = normalizeModuleKnowledgeLocation({ repository: config.url, branch: config.branch || "main", docs_path: suffix === 1 ? base : `${base}-${suffix}` })!;
    if (!used.some(other => repositoryIdentity(other.repository) === repositoryIdentity(candidate.repository) && other.branch === candidate.branch
        && (other.docs_path === candidate.docs_path || other.docs_path.startsWith(`${candidate.docs_path}/`) || candidate.docs_path.startsWith(`${other.docs_path}/`)))) return candidate;
  }
  return undefined;
}

export function saveModuleKnowledgeLocation(dataDir: string, moduleId: string, input: unknown, operator: string, expectedRevision?: number) {
  const current = readBusinessModule(dataDir, moduleId);
  if (current.id !== moduleId || current.status !== "active") throw new BusinessModuleError("业务模块已迁移或停用，请刷新列表");
  if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new BusinessModuleError("模块配置已变化，请刷新后再保存领域知识目录");
  const location = normalizeModuleKnowledgeLocation(input);
  if (!location) throw new BusinessModuleError("请填写领域知识仓库、分支和相对目录");
  return updateBusinessModule(dataDir, moduleId, { knowledge_location: location }, operator);
}
