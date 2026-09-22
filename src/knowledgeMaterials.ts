import { createHash, randomUUID } from "node:crypto";
import { runKnowledgeCommand } from "./knowledgeProcess.ts";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { scanForSecrets } from "./hostSkillLibrary.ts";

export interface KnowledgeMaterial {
  id: string; name: string; scope: string; version: string; bytes: number; digest: string;
  state: "ready" | "failed"; error?: string; sections: Array<{ location: string; text: string }>;
}
const supported = new Set([".md", ".txt", ".docx", ".pdf", ".xlsx", ".pptx"]);
export async function saveKnowledgeMaterial(root: string, input: { name: string; content_base64: string; scope?: string; version?: string }, signal?: AbortSignal): Promise<KnowledgeMaterial> {
  if (!input || typeof input.name !== "string" || input.name.length > 180 || /[\x00-\x1f/\\]/.test(input.name) || !supported.has(extname(input.name).toLowerCase()))
    throw new Error("支持 Markdown、文本、DOCX、PDF、XLSX、PPTX，请使用有效文件名");
  if (typeof input.content_base64 !== "string" || input.content_base64.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content_base64)) throw new Error("资料编码无效或超过 20 MiB");
  const bytes = Buffer.from(input.content_base64, "base64");
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("资料不能为空且不能超过 20 MiB");
  const record: KnowledgeMaterial = { id: `material-${randomUUID()}`, name: input.name, scope: String(input.scope ?? "本次研究").slice(0, 500), version: String(input.version ?? "未标注").slice(0, 100), bytes: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"), state: "failed", sections: [] };
  const folder = join(root, record.id); mkdirSync(folder, { recursive: true });
  const file = join(folder, `source${extname(input.name).toLowerCase()}`);
  writeFileSync(file, bytes, { mode: 0o600 });
  try {
    const raw = await runKnowledgeCommand(process.env.MAE_FLOW_PYTHON_BIN || "python3", [fileURLToPath(new URL("../scripts/parse-knowledge-material.py", import.meta.url)), file],
      { signal, timeoutMs: 60_000, maxBytes: 8 * 1024 * 1024 }).catch(() => { throw new Error("资料解析失败，请检查文件格式与解析器；PDF 需要 pdftotext，扫描件需要先做 OCR"); });
    scanForSecrets(input.name, Buffer.from(raw));
    record.sections = JSON.parse(raw);
    if (!record.sections.length || !record.sections.some(s => s.text.trim())) throw new Error("未提取到可读文本，请补充可检索文档或 OCR 结果");
    record.state = "ready";
  } catch (error) { record.error = signal?.aborted ? "资料解析已取消" : error instanceof Error ? error.message : "资料解析失败"; }
  finally { for (const entry of readdirSync(folder)) if (entry.startsWith("parse-pdf-")) rmSync(join(folder, entry), { recursive: true, force: true }); }
  writeFileSync(join(folder, "material.json"), JSON.stringify(record), { mode: 0o600 });
  return record;
}
export function readKnowledgeMaterial(root: string, id: string): KnowledgeMaterial {
  if (!/^material-[a-f0-9-]{36}$/.test(id) || !existsSync(join(root, id, "material.json"))) throw new Error("资料不存在");
  return JSON.parse(readFileSync(join(root, id, "material.json"), "utf8"));
}
export function knowledgeMaterialTool(materials: KnowledgeMaterial[]) {
  return defineTool({
    name: "knowledge_material", label: "读取上传资料",
    description: "列出本任务上传资料的范围、版本、解析状态与章节；按资料编号和章节序号读取正文。保留原始定位，不把解析片段冒充全文。",
    parameters: Type.Object({ id: Type.Optional(Type.String()), start: Type.Optional(Type.Integer({ minimum: 1 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }),
    async execute(_id: string, input: { id?: string; start?: number; count?: number }) {
      const material = materials.find(m => m.id === input.id);
      let data: unknown;
      if (!input.id) data = materials.map(({ sections, ...rest }) => ({ ...rest, sections: sections.map((s, i) => ({ index: i + 1, location: s.location, characters: s.text.length })) }));
      else if (!material) return { content: [{ type: "text" as const, text: "资料不在本次研究范围" }], details: {}, isError: true };
      else data = { ...material, sections: material.sections.slice((input.start ?? 1) - 1, (input.start ?? 1) - 1 + Math.min(input.count ?? 1, 10)) };
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: {} };
    },
  });
}
