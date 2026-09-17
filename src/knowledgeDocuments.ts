/** Human-maintained manuals. One atomic record holds original text and its audit trail. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readBusinessModule } from "./businessModuleLibrary.ts";
import { normalizeKnowledgeLanguages } from "./knowledgeLanguages.ts";
export interface KnowledgeDocument {
  id: string; title: string; content: string; scope: "platform" | "module" | "repository";
  module_ids: string[]; repositories: string[]; technologies: string[]; product_versions: string[];
  when_to_use: string; active: boolean; revision: string;
  source?: { repository: string; branch: string; path: string; revision: string };
  history: Array<{ at: string; operator: string; action: string }>;
}
const root = (dir: string) => join(dir, "knowledge-documents");
function file(dir: string, id: string) {
  if (!/^kd-[a-f0-9-]{36}$/.test(id)) throw new Error("文档不存在");
  return join(root(dir), `${id}.json`);
}
export function readKnowledgeDocument(dir: string, id: string): KnowledgeDocument {
  return JSON.parse(readFileSync(file(dir, id), "utf8"));
}
export function listKnowledgeDocuments(dir: string): KnowledgeDocument[] {
  if (!existsSync(root(dir))) return [];
  return readdirSync(root(dir)).filter(name => /^kd-[a-f0-9-]{36}\.json$/.test(name))
    .map(name => readKnowledgeDocument(dir, name.slice(0, -5)))
    .sort((a, b) => b.history.at(-1)!.at.localeCompare(a.history.at(-1)!.at));
}
function strings(value: unknown, max = 20): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== "string" || v.length > 512)) throw new Error("适用范围格式不正确");
  return [...new Set(value.map(v => v.trim()).filter(Boolean))];
}
export function saveKnowledgeDocument(dir: string, input: Record<string, unknown>, operator: string, id?: string): KnowledgeDocument {
  const previous = id ? readKnowledgeDocument(dir, id) : undefined;
  const merged = { ...previous, ...input };
  const title = String(merged.title ?? "").trim();
  const content = String(merged.content ?? "").replace(/\r\n/g, "\n");
  if (!title || title.length > 160) throw new Error("请填写文档名称（最多 160 字）");
  if (!content.trim() || content.includes("\0") || Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error("请上传非空 UTF-8 Markdown 文档，最大 2 MiB");
  const scope = merged.scope ?? "platform";
  if (!["platform", "module", "repository"].includes(String(scope))) throw new Error("请选择适用范围");
  const module_ids = scope === "module" ? strings(merged.module_ids ?? [], 8) : [];
  const repositories = scope === "repository" ? strings(merged.repositories ?? []) : [];
  if (scope === "module" && !module_ids.length) throw new Error("请选择业务模块");
  for (const moduleId of module_ids) if (readBusinessModule(dir, moduleId).status !== "active") throw new Error("所选业务模块已停用");
  if (scope === "repository" && !repositories.length) throw new Error("请填写适用代码仓地址");
  if (merged.active !== undefined && typeof merged.active !== "boolean") throw new Error("文档状态不正确");
  const fields = { title, content, scope: scope as KnowledgeDocument["scope"], module_ids, repositories,
    technologies: normalizeKnowledgeLanguages(merged.technologies ?? []), product_versions: strings(merged.product_versions ?? []),
    when_to_use: String(merged.when_to_use ?? "").trim().slice(0, 1000), active: merged.active !== false,
    source: merged.source as KnowledgeDocument["source"] };
  const revision = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
  if (previous?.revision === revision) return previous;
  const action = !previous ? "上传文档" : previous.active !== fields.active ? fields.active ? "启用文档" : "停用文档"
    : previous.source?.revision !== fields.source?.revision && fields.source ? "从仓库更新"
    : previous.content !== content ? "替换文档" : "修改适用范围";
  const doc: KnowledgeDocument = { ...fields, id: previous?.id ?? `kd-${randomUUID()}`, revision,
    history: [...(previous?.history ?? []), { at: new Date().toISOString(), operator, action }] };
  mkdirSync(root(dir), { recursive: true });
  const target = file(dir, doc.id), temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(doc), { mode: 0o640 });
  renameSync(temporary, target);
  return doc;
}
