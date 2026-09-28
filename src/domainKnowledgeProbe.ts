import type { KnowledgeRepository } from "./domainKnowledgeTypes.ts";

/** 仅用于临时效果验证；同时处理嵌套目录、大小写及业务仓自定义文档目录。 */
export function probeExcludedPath(repositories: KnowledgeRepository[]) {
  return (path: string, repositoryId?: string) => {
    const roots = repositories.filter(r => !repositoryId || r.id === repositoryId).map(r => r.docs_path.toLowerCase().replace(/\/$/, "")).filter(Boolean);
    const value = path.replaceAll("\\", "/").toLowerCase();
    return value.split("/").some(segment => segment === "docs" || segment === "agents.md")
      || roots.some(root => value === root || value.startsWith(root + "/"));
  };
}
