import type { DomainKnowledgeJob, KnowledgeRepository } from "./domainKnowledgeTypes.ts";

export function needsModuleKnowledgeLayout(job: Pick<DomainKnowledgeJob, "module_id" | "knowledge_layout" | "component_research_id">): boolean {
  return !!job.module_id && !job.component_research_id && job.knowledge_layout !== "module-v1";
}

/** 模块目录由平台确定；已经带模块编号的目录不会重复追加。 */
export function moduleKnowledgeDirectory(base: string, moduleId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(moduleId)) throw new Error("业务模块编号不能用作知识目录");
  const directory = base.trim().replace(/\/$/, "");
  if (!directory || directory.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || /[\\\x00-\x1f]/.test(part))) throw new Error("请使用仓内知识目录的相对路径");
  const result = directory.endsWith(`/${moduleId}`) ? directory : `${directory}/${moduleId}`;
  if (result.length > 1000) throw new Error("模块知识目录过长");
  return result;
}

/** 整理旧文稿时保留目录结构；根 AGENTS 的模块内容移入模块说明。 */
export function moduleKnowledgePath(oldDirectory: string, newDirectory: string, path: string): string {
  oldDirectory = oldDirectory.replace(/\/$/, "");
  newDirectory = newDirectory.replace(/\/$/, "");
  if (path.toLowerCase() === "agents.md") return `${newDirectory}/README.md`;
  const mapped = path.startsWith(`${newDirectory}/`) ? path : path.startsWith(`${oldDirectory}/`)
    ? `${newDirectory}/${path.slice(oldDirectory.length + 1)}` : `${newDirectory}/${path}`;
  return /\/agents\.md$/i.test(mapped) ? mapped.replace(/[^/]+$/, "index.md") : mapped;
}

/** 一次整理全部文稿；同仓同分支使用相同 collision_group，未配置仓库时使用目标编号。 */
export function moduleKnowledgePaths(
  documents: ReadonlyArray<{ id: string; target_id: string; path: string; desired_path?: string }>,
  targets: ReadonlyArray<{ id: string; old_directory: string; new_directory: string; collision_group: string }>,
  occupiedPaths: ReadonlyArray<{ collision_group: string; path: string; document_id?: string }> = [],
): { paths: Map<string, string>; renamed: Array<{ id: string; target_id: string; path: string; desired_path: string }> } {
  const targetById = new Map(targets.map(target => [target.id, target]));
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const key = (group: string, path: string) => JSON.stringify([group, path.toLowerCase()]);
  const entries = documents.map(document => {
    const target = targetById.get(document.target_id);
    if (!target) throw new Error("文稿的归档目标不存在");
    const directory = target.new_directory.replace(/\/$/, "");
    const desired = moduleKnowledgePath(target.old_directory, directory, document.desired_path ?? document.path);
    if (!desired.startsWith(`${directory}/`) || !desired.endsWith(".md") || desired.length > 1000
      || desired.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || /[\\\x00-\x1f]/.test(part))) {
      throw new Error("文稿整理后的路径须为模块目录内的 Markdown 文件");
    }
    // 原根入口优先占用 README；其他碰撞先保留已经位于目标路径的文稿。
    const priority = document.path.toLowerCase() === "agents.md" && desired === `${directory}/README.md` ? 0 : document.path === desired ? 1 : 2;
    return { document, target, desired, priority };
  }).sort((a, b) => a.priority - b.priority || compare(a.document.id, b.document.id));
  if (new Set(entries.map(entry => entry.document.id)).size !== entries.length) throw new Error("文稿编号不能重复");
  // 正式位置只允许唯一对应的原文稿复用；未发布的其他篇也不能让出已有正式位置。
  const occupied = new Map<string, Set<string | undefined>>();
  for (const location of occupiedPaths) {
    const locationKey = key(location.collision_group, location.path), owners = occupied.get(locationKey) ?? new Set<string | undefined>();
    owners.add(location.document_id); occupied.set(locationKey, owners);
  }
  const belongsToOther = (locationKey: string, documentId: string) => {
    const owners = occupied.get(locationKey);
    return !!owners && (owners.size !== 1 || !owners.has(documentId));
  };
  // 所有期望名先预留，自动避让也保护仅大小写不同的文件名。
  const claimed = new Set<string>();
  const reserved = new Set(entries.map(entry => key(entry.target.collision_group, entry.desired)));
  const result = new Map<string, string>();
  const renamed: Array<{ id: string; target_id: string; path: string; desired_path: string }> = [];
  for (const { document, target, desired } of entries) {
    const desiredKey = key(target.collision_group, desired);
    let path = desired;
    if (claimed.has(desiredKey) || belongsToOther(desiredKey, document.id)) {
      const suffixId = document.id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "document";
      const slash = desired.lastIndexOf("/"), directory = desired.slice(0, slash + 1), stem = desired.slice(slash + 1, -3);
      for (let attempt = 1; ; attempt++) {
        const suffix = `-${suffixId}${attempt === 1 ? "" : `-${attempt}`}.md`;
        const available = Math.min(255, 1000 - directory.length) - suffix.length;
        if (available < 1) throw new Error("模块知识目录过长，无法保留文稿文件名");
        path = `${directory}${stem.slice(0, available)}${suffix}`;
        const pathKey = key(target.collision_group, path);
        if (!reserved.has(pathKey) && !claimed.has(pathKey) && !belongsToOther(pathKey, document.id)) break;
      }
      renamed.push({ id: document.id, target_id: document.target_id, path, desired_path: desired });
    }
    claimed.add(key(target.collision_group, path)); reserved.add(key(target.collision_group, path)); result.set(document.id, path);
  }
  return { paths: new Map([...result].sort(([a], [b]) => compare(a, b))), renamed: renamed.sort((a, b) => compare(a.id, b.id)) };
}

/** 历史任务沿用原布局；新模块任务只能维护本模块目录里的文稿。 */
export function assertModuleKnowledgePath(
  job: Pick<DomainKnowledgeJob, "module_id" | "knowledge_layout">,
  target: Pick<KnowledgeRepository, "docs_path">,
  path: string,
): void {
  if (job.knowledge_layout !== "module-v1") return;
  if (!job.module_id || moduleKnowledgeDirectory(target.docs_path, job.module_id) !== target.docs_path) throw new Error("模块知识目录缺少业务模块编号，请重新设置归档位置");
  if (!path.startsWith(`${target.docs_path}/`) || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || /[\\\x00-\x1f]/.test(part))) {
    throw new Error(`本模块文稿须保存在 ${target.docs_path}/ 内；仓库根目录 AGENTS.md 由平台维护入口`);
  }
  if (/\/agents\.md$/i.test(path)) throw new Error("本模块文稿不生成 AGENTS.md；请使用 README.md 或 index.md，仓库只保留根目录统一入口");
}
