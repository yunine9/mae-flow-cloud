import { createHash } from "node:crypto";
import { componentKnowledgeMarkdown } from "./componentKnowledgeMarkdown.ts";
import { publishedComponentParadigms } from "./componentKnowledgeDocument.ts";

const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const schema = "mfc.component-guide/v2";

/** 正文给人读、结构字段给程序：归档进 Git 只放正文，结构字段随派生产物导出。 */
export function componentArchiveParts(text: string) {
  const content = componentKnowledgeMarkdown(text) + "\n";
  const front = /^---\r?\nschema: "mfc\.component-guide\/v1"\r?\ncomponent_paradigms: ([^\r\n]+)\r?\n---/.exec(text);
  const metadata = front ? JSON.stringify({ schema, component_paradigms: JSON.parse(front[1]) }) : undefined;
  return { content, component_metadata: metadata ? componentArchiveMetadata(content, metadata) : undefined };
}

export function componentArchiveMetadata(content: string, metadata: string): string {
  const value = JSON.parse(metadata);
  if (value.schema !== schema || !Array.isArray(value.component_paradigms)) throw new Error("组件知识结构文件格式不正确");
  return JSON.stringify({ schema, content_sha256: digest(content), component_paradigms: value.component_paradigms }, null, 2) + "\n";
}

/** 派生产物里的正文与结构文件按摘要配对还原，避免错配旧规则。 */
export function restoreComponentArchive(content: string, metadata: string): string {
  const value = JSON.parse(metadata);
  if (value.schema !== schema || value.content_sha256 !== digest(content)) throw new Error("组件知识正文与结构文件不一致，请更新配套文件后同步");
  const canonical = `---\nschema: "mfc.component-guide/v1"\ncomponent_paradigms: ${JSON.stringify(value.component_paradigms)}\n---\n\n${content}`;
  publishedComponentParadigms({ id: "archive", revision: "archive", content: canonical, productVersions: [] });
  return canonical;
}

/** 一个组件一篇，按语言分目录、按知识标题（组件功能，如「文件操作」）命名；标题里不能进路径的字符换成短横线。 */
export function componentArchivePath(docsPath: string, formal: { title: string; technologies: string[] }) {
  const name = formal.title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").replace(/-{2,}/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "").slice(0, 80) || "组件知识";
  return `${docsPath}/${formal.technologies[0] ?? "agnostic"}/${name}.md`;
}
