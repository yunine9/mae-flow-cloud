import type { DomainKnowledgeJob, KnowledgeRepository } from "./domainKnowledgeTypes.ts";

/** 模块目录由平台确定；已经带模块编号的目录不会重复追加。 */
export function moduleKnowledgeDirectory(base: string, moduleId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(moduleId)) throw new Error("业务模块编号不能用作知识目录");
  const directory = base.trim().replace(/\/$/, "");
  if (!directory || directory.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || /[\\\x00-\x1f]/.test(part))) throw new Error("请使用仓内知识目录的相对路径");
  const result = directory.endsWith(`/${moduleId}`) ? directory : `${directory}/${moduleId}`;
  if (result.length > 1000) throw new Error("模块知识目录过长");
  return result;
}

/** 显式整理旧文稿时保留目录结构；根 AGENTS 的模块内容移入模块说明。 */
export function moduleKnowledgePath(oldDirectory: string, newDirectory: string, path: string): string {
  oldDirectory = oldDirectory.replace(/\/$/, "");
  newDirectory = newDirectory.replace(/\/$/, "");
  if (path.toLowerCase() === "agents.md") return `${newDirectory}/README.md`;
  const mapped = path.startsWith(`${newDirectory}/`) ? path : path.startsWith(`${oldDirectory}/`)
    ? `${newDirectory}/${path.slice(oldDirectory.length + 1)}` : `${newDirectory}/${path}`;
  return /\/agents\.md$/i.test(mapped) ? mapped.replace(/[^/]+$/, "index.md") : mapped;
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
