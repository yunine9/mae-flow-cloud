import { createHash } from "node:crypto";
import { componentKnowledgeMarkdown } from "./componentKnowledgeMarkdown.ts";
import { publishedComponentParadigms } from "./componentKnowledgeDocument.ts";

const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const schema = "mfc.component-guide/v2";

/** 上库正文与程序字段分开存放；旧联合文档可直接转换。 */
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

/** 只用同一 Git 版本中的正文和结构文件恢复程序消费，避免错配旧规则。 */
export function restoreComponentArchive(content: string, metadata: string): string {
  const value = JSON.parse(metadata);
  if (value.schema !== schema || value.content_sha256 !== digest(content)) throw new Error("组件知识正文与结构文件不一致，请更新配套文件后同步");
  const canonical = `---\nschema: "mfc.component-guide/v1"\ncomponent_paradigms: ${JSON.stringify(value.component_paradigms)}\n---\n\n${content}`;
  publishedComponentParadigms({ id: "archive", revision: "archive", content: canonical, productVersions: [] });
  return canonical;
}

export const componentMetadataPath = (path: string) => path.replace(/\.md$/, ".metadata.json");
