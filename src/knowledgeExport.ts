import { createHash } from "node:crypto";
import { knowledgeDocumentCatalog } from "./knowledgeDocumentCatalog.ts";
import { listBusinessModules } from "./businessModuleLibrary.ts";
import { createZipArchive } from "./zipArchive.ts";

/** Export the same adopted/enabled shelf shown in the UI, never research drafts or Skill packages. */
export function exportKnowledge(dir: string, ids?: unknown): Buffer {
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== "string")))
    throw new Error("请选择要导出的文档，每次最多 1000 篇");
  const eligible = knowledgeDocumentCatalog(dir).documents.filter(d => d.active && d.form !== "skill");
  const chosen = ids === undefined ? eligible : [...new Set(ids as string[])].map(id => {
    const doc = eligible.find(d => d.id === id);
    if (!doc) throw new Error("所选文档已停用或不存在，请刷新列表后重试");
    return doc;
  });
  if (!chosen.length) throw new Error("没有可导出的已启用文档");
  if (chosen.length > 1000) throw new Error("每次最多导出 1000 篇，请分批勾选");
  const modules = new Map(listBusinessModules(dir).modules.map(m => [m.id, m.name]));
  let bytes = 0;
  return createZipArchive(chosen.map(doc => {
    // Prefix and limited basename are Windows-safe; digest preserves identity across same-name sources.
    const title = [...doc.title.replace(/\.md$/i, "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")].slice(0, 45).join("").replace(/[. ]+$/, "") || "知识";
    const key = createHash("sha256").update(doc.id).digest("hex").slice(0, 24);
    const metadata = {
      id: doc.id, title: doc.title, revision: doc.revision,
      scope: doc.scope_label || doc.scope,
      modules: doc.module_ids.map(id => ({id, name: modules.get(id) ?? id})),
      repositories: doc.repositories, languages: doc.technologies,
      product_versions: doc.product_versions, when_to_use: doc.when_to_use,
      ...("source" in doc && doc.source ? {source: doc.source} : {}),
      ...("research_source" in doc && doc.research_source ? {research_source: doc.research_source} : {}),
    };
    // Keep original frontmatter, examples and relative structure of the body intact.
    const content = Buffer.from(doc.content + "\n\n---\n\n## 平台导出信息\n\n```json\n" + JSON.stringify(metadata, null, 2) + "\n```\n", "utf8");
    bytes += content.length;
    if (bytes > 64 * 1024 * 1024) throw new Error("文档总大小超过 64 MiB，请分批导出");
    return {name: `knowledge/doc-${title}--${key}.md`, content};
  }));
}
