/** 任务知识沉淀候选与工程知识发布库。 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  normalizeKnowledgeAssetMetadata,
  type KnowledgeAssetMetadata,
  type KnowledgeForm,
  type KnowledgeNature,
} from "./knowledgeAssetModel.ts";

const ROOT = "knowledge-candidates";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_CONTENT_BYTES = 256 * 1024;

export class KnowledgeCandidateError extends Error {}
export type KnowledgeCandidateStatus = "pending" | "published" | "rejected";

export interface KnowledgeCandidateRecord extends KnowledgeAssetMetadata {
  id: string;
  source_task_id: string;
  title: string;
  summary: string;
  when_to_use: string;
  content: string;
  digest: string;
  bytes: number;
  status: KnowledgeCandidateStatus;
  submitted_at: string;
  submitted_by: string;
  decided_at?: string;
  decided_by?: string;
  decision_note?: string;
  published_target?: string;
}

export interface KnowledgeCandidateCatalog {
  candidates: KnowledgeCandidateRecord[];
  /** 单条坏记录不能混成“没有候选”；权威预览据此显式降级。 */
  warnings: string[];
}

function required(value: unknown, label: string, max: number): string {
  const result = String(value ?? "").trim();
  if (!result) throw new KnowledgeCandidateError(`${label}不能为空`);
  if (result.length > max) throw new KnowledgeCandidateError(
    `${label}不能超过 ${max} 个字符`);
  return result;
}

function root(dataDir: string): string { return join(dataDir, ROOT); }
function recordFile(dataDir: string, id: string): string {
  return join(root(dataDir), `${id}.json`);
}

function writeRecord(dataDir: string, record: KnowledgeCandidateRecord): void {
  mkdirSync(root(dataDir), { recursive: true, mode: 0o750 });
  const file = recordFile(dataDir, record.id);
  const temporary = `${file}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf-8", mode: 0o640,
    });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function parse(value: unknown): KnowledgeCandidateRecord {
  const record = value as KnowledgeCandidateRecord;
  if (!record || !ID.test(String(record.id ?? ""))
      || !["pending", "published", "rejected"].includes(record.status)
      || !record.title || !record.content) {
    throw new KnowledgeCandidateError("知识候选数据损坏");
  }
  const bytes = Buffer.byteLength(record.content, "utf-8");
  const digest = createHash("sha256").update(record.content).digest("hex");
  if (record.bytes !== bytes || record.digest !== digest) {
    throw new KnowledgeCandidateError("知识候选正文与发布指纹不一致");
  }
  const metadata = normalizeKnowledgeAssetMetadata(record,
    { allowUnclassified: false });
  return { ...record, ...metadata };
}

export function createKnowledgeCandidate(
  dataDir: string,
  input: {
    source_task_id: string;
    title: string;
    summary: string;
    when_to_use: string;
    nature: KnowledgeNature;
    form: KnowledgeForm;
    business_module_ids?: string[];
    repositories?: string[];
    technologies?: string[];
    content: string;
  },
  operator: string,
): KnowledgeCandidateRecord {
  const content = String(input.content ?? "").replace(/\r\n/g, "\n");
  if (!content.trim()) throw new KnowledgeCandidateError("知识正文不能为空");
  if (content.includes("\0")) throw new KnowledgeCandidateError("知识正文包含二进制内容");
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_CONTENT_BYTES) {
    throw new KnowledgeCandidateError("知识正文不能超过 256 KiB");
  }
  let metadata: KnowledgeAssetMetadata;
  try {
    metadata = normalizeKnowledgeAssetMetadata(input);
  } catch (error) {
    throw new KnowledgeCandidateError(
      error instanceof Error ? error.message : String(error));
  }
  const record: KnowledgeCandidateRecord = {
    id: `kc-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    source_task_id: required(input.source_task_id, "来源任务", 80),
    title: required(input.title, "标题", 120),
    summary: required(input.summary, "摘要", 500),
    when_to_use: required(input.when_to_use, "适用场景", 500),
    ...metadata,
    content,
    digest: createHash("sha256").update(content).digest("hex"),
    bytes,
    status: "pending",
    submitted_at: new Date().toISOString(),
    submitted_by: operator,
  };
  writeRecord(dataDir, record);
  return record;
}

export function readKnowledgeCandidate(
  dataDir: string,
  idValue: string,
): KnowledgeCandidateRecord {
  const id = idValue.trim();
  if (!ID.test(id)) throw new KnowledgeCandidateError("知识候选 ID 不合法");
  const file = recordFile(dataDir, id);
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()
      || !lstatSync(file).isFile()) {
    throw new KnowledgeCandidateError(`没有知识候选 ${id}`);
  }
  try { return parse(JSON.parse(readFileSync(file, "utf-8"))); }
  catch (error) {
    if (error instanceof KnowledgeCandidateError) throw error;
    throw new KnowledgeCandidateError(`知识候选 ${id} 数据损坏`);
  }
}

export function listKnowledgeCandidateCatalog(
  dataDir: string,
): KnowledgeCandidateCatalog {
  const home = root(dataDir);
  if (!existsSync(home)) return { candidates: [], warnings: [] };
  const warnings: string[] = [];
  const candidates = readdirSync(home, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.name.endsWith(".json")) return [];
    const id = entry.name.slice(0, -5);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      warnings.push(`知识候选 ${id} 不是普通文件，已跳过`);
      return [];
    }
    try { return [readKnowledgeCandidate(dataDir, id)]; }
    catch (error) {
      warnings.push(`知识候选 ${id} 读取失败：${error instanceof Error
        ? error.message : String(error)}`);
      return [];
    }
  }).sort((left, right) => right.submitted_at.localeCompare(left.submitted_at));
  return { candidates, warnings };
}

/** 兼容既有管理列表：返回类型与坏记录跳过语义不变。 */
export function listKnowledgeCandidates(dataDir: string): KnowledgeCandidateRecord[] {
  return listKnowledgeCandidateCatalog(dataDir).candidates;
}

export function decideKnowledgeCandidate(
  dataDir: string,
  id: string,
  decision: "published" | "rejected",
  operator: string,
  input: { note?: string; published_target?: string } = {},
): KnowledgeCandidateRecord {
  const current = readKnowledgeCandidate(dataDir, id);
  if (current.status !== "pending") {
    throw new KnowledgeCandidateError(
      `知识候选已处理(${current.status})，不能重复提交`);
  }
  const note = String(input.note ?? "").trim();
  if (decision === "rejected" && !note) {
    throw new KnowledgeCandidateError("暂不接纳时必须说明原因");
  }
  const updated: KnowledgeCandidateRecord = {
    ...current,
    status: decision,
    decided_at: new Date().toISOString(),
    decided_by: operator,
    ...(note ? { decision_note: note.slice(0, 1000) } : {}),
    ...(input.published_target
      ? { published_target: input.published_target.slice(0, 500) } : {}),
  };
  writeRecord(dataDir, updated);
  return updated;
}
