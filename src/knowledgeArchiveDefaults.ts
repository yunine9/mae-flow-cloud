import type { ExtractionKind } from "./knowledgeExtractionSkills.ts";

export interface KnowledgeArchiveDefaults {
  domain_directory: string; repository_directory: string; component_directory: string; component_filename: string;
}
/** 旧方法包缺少此引用时沿用原默认值；新包可通过上传更新这份约定。 */
export function knowledgeArchiveDefaults(files: Record<string, string>, kind: ExtractionKind): KnowledgeArchiveDefaults {
  const defaults = { domain_directory: "domains", repository_directory: "docs/knowledge", component_directory: "docs/components", component_filename: "component-guide.md" };
  const text = files["references/archive-defaults.md"];
  if (text === undefined) return defaults;
  const block = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!block) throw new Error("归档默认位置需要一个 JSON 配置块");
  const value = JSON.parse(block[1]);
  const keys = kind === "domain" ? ["domain_directory", "repository_directory"] : ["component_directory", "component_filename"];
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("归档默认位置包含未知字段");
  for (const key of keys) {
    const path = value[key];
    if (typeof path !== "string" || !path || path !== path.trim() || path.length > 1000 || path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git" || /[\\\x00-\x1f]/.test(p)) || (key === "component_filename" && (path.includes("/") || !path.endsWith(".md")))) throw new Error(`归档默认位置无效：${key}`);
  }
  return { ...defaults, ...value };
}
