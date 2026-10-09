import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DomainKnowledgeExtraction } from "./domainKnowledgeExtraction.ts";
import type { ComponentResearch } from "./componentResearch.ts";
import { readHostSkillPackage, scanForSecrets } from "./hostSkillLibrary.ts";
import { readKnowledgeDocument } from "./knowledgeDocuments.ts";
import { knowledgeDocumentCatalog } from "./knowledgeDocumentCatalog.ts";
import { durableWriteFileSync } from "./durableWrite.ts";

import type { KnowledgeReviewKind, KnowledgeReviewNote, KnowledgeReviewNoteInput, KnowledgeReviewNotesResult } from "./knowledgeReviewNoteTypes.ts";
export type { KnowledgeReviewKind, KnowledgeReviewNote, KnowledgeReviewNoteInput } from "./knowledgeReviewNoteTypes.ts";

export interface KnowledgeReviewSources {
  dataDir: string;
  domain: Pick<DomainKnowledgeExtraction, "get" | "run">;
  component: Pick<ComponentResearch, "get" | "review">;
}

function file(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string) {
  const validId = typeof jobId === "string" && (kind === "published"
    ? /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,511}$/.test(jobId) && !jobId.split(/[/:]/).some(part => !part || part === "." || part === "..")
    : kind === "skill" ? /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(jobId) && !jobId.includes("..") : /^[a-zA-Z0-9-]{1,100}$/.test(jobId));
  if (!["domain", "component", "published", "skill"].includes(kind) || !validId) throw new Error("知识任务编号无效");
  const name = kind === "published" && !/^kd-[a-f0-9-]{36}$/.test(jobId) ? `asset-${createHash("sha256").update(jobId).digest("hex")}` : jobId;
  return join(sources.dataDir, "knowledge-review", kind, `${name}.json`);
}
function documents(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string) {
  // 先校验路径和类型，再查原研究任务，已删除任务不能继续写入批注。
  file(sources, kind, jobId);
  if (kind === "published") {
    if (/^kd-[a-f0-9-]{36}$/.test(jobId)) return [readKnowledgeDocument(sources.dataDir, jobId)];
    const document = knowledgeDocumentCatalog(sources.dataDir).documents.find(document => document.id === jobId);
    if (!document) throw new Error("批注对应的文档已不存在，请刷新后重新选择");
    return [document];
  }
  if (kind === "skill") return readHostSkillPackage(sources.dataDir, jobId).files.filter(file => /\.md$/i.test(file.path) && file.content !== undefined)
    .map(file => ({ id: file.path, title: file.path, content: file.content! }));
  if (kind === "domain") return sources.domain.get(jobId).documents;
  const record = sources.component.get(jobId);
  if (record.deleted_at) throw new Error("组件研究已删除");
  return record.document?.sections ?? [];
}
function read(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string): KnowledgeReviewNote[] {
  const path = file(sources, kind, jobId);
  if (!existsSync(path)) return [];
  const notes = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(notes)) throw new Error("批注记录无法读取，请检查存储文件");
  if (kind === "domain" || kind === "component") {
    const domain = kind === "domain" ? sources.domain.get(jobId) : undefined;
    const component = kind === "component" ? sources.component.get(jobId) : undefined;
    let changed = false;
    for (const note of notes as KnowledgeReviewNote[]) {
      if (note.status !== "submitted" || !note.turn_id) continue;
      const domainTurn = domain?.turns.find(turn => turn.id === note.turn_id);
      const componentTurn = component?.review_turns?.find(turn => turn.id === note.turn_id);
      const turn = domainTurn ?? componentTurn;
      if (!turn) continue;
      const discarded = domainTurn?.proposals.some(proposal => proposal.document.id === note.document_id && proposal.status === "discarded")
        || componentTurn?.section_id === note.document_id && componentTurn.proposal?.section.id === note.document_id && componentTurn.proposal.status === "discarded";
      if (["failed", "cancelled"].includes(turn.status) || discarded) {
        note.status = "open";
        changed = true;
      }
    }
    if (changed) save(sources, kind, jobId, notes);
  }
  return notes;
}
function save(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string, notes: KnowledgeReviewNote[]) {
  const path = file(sources, kind, jobId);
  mkdirSync(dirname(path), { recursive: true });
  durableWriteFileSync(path, JSON.stringify(notes), { mode: 0o600 });
}
function string(value: unknown, label: string, limit: number, required = false): string | undefined {
  if (value == null && !required) return undefined;
  if (typeof value !== "string" || value.length > limit || (required && !value.trim()) || value.includes("\0")) throw new Error(`${label}格式无效，最多 ${limit} 字`);
  return value.trim() || undefined;
}
function currentDocument(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string, input: Pick<KnowledgeReviewNoteInput, "document_id"> & { scope?: KnowledgeReviewNoteInput["scope"] }) {
  const items = documents(sources, kind, jobId);
  if (input.scope === "study" && (kind === "domain" || kind === "component")) return { id: "", title: "全部文稿" };
  const doc = items.find(doc => doc.id === input.document_id);
  if (!doc) throw new Error("批注对应的文稿已不存在，请刷新后重新选择");
  return doc;
}

function response(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string, notes: KnowledgeReviewNote[]): KnowledgeReviewNotesResult {
  const turns = kind === "domain" ? sources.domain.get(jobId).turns : kind === "component" ? sources.component.get(jobId).review_turns ?? [] : [];
  const submissions: KnowledgeReviewNotesResult["submissions"] = {};
  for (const turn of turns) if (notes.some(note => note.turn_id === turn.id)) {
    submissions[turn.id] = { working: turn.status === "queued" || turn.status === "running", status_label: ({
      queued: "意见已发送，等待 Agent 开始修改", running: "Agent 正在修改文稿", paused: "修改已暂停，等待你确认",
      done: "修改完成，请审阅文稿", failed: "修改失败，意见已保留，可重试", cancelled: "修改已停止，意见已保留",
    } as Record<string, string>)[turn.status] ?? "请查看任务详情", error: turn.error };
  }
  return { notes, submissions };
}

export function listKnowledgeReviewNotes(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string): KnowledgeReviewNotesResult {
  documents(sources, kind, jobId);
  return response(sources, kind, jobId, read(sources, kind, jobId));
}

export function saveKnowledgeReviewNote(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string, input: KnowledgeReviewNoteInput, operator: string): KnowledgeReviewNotesResult {
  const doc = currentDocument(sources, kind, jobId, input);
  if (!["line", "document", "study"].includes(input.scope)) throw new Error("请选择行批注、文稿意见或研究方向意见");
  if ((kind === "published" || kind === "skill") && input.scope === "study") throw new Error("请选择行批注或整篇文档意见");
  if (input.scope === "line" && (!Number.isSafeInteger(input.line) || input.line! < 1)) throw new Error("行批注需要有效的正文行号");
  if (input.line_end !== undefined && (!Number.isSafeInteger(input.line_end) || input.line_end < (input.line ?? 1))) throw new Error("批注结束行无效");
  const note: KnowledgeReviewNote = {
    id: randomUUID(), kind, job_id: jobId, document_id: doc.id, document_title: doc.title,
    scope: input.scope, ...(input.scope === "line" ? { line: input.line, line_end: input.line_end ?? input.line } : {}),
    anchor: string(input.anchor, "批注位置", 1000), quote: string(input.quote, "引用正文", 4000),
    context_before: string(input.context_before, "前文", 2000), context_after: string(input.context_after, "后文", 2000),
    note: string(input.note, "批注意见", 10_000, true)!, operator, created_at: new Date().toISOString(), status: "open",
  };
  scanForSecrets("知识文稿批注", Buffer.from(JSON.stringify(note)));
  const notes = read(sources, kind, jobId);
  notes.push(note); save(sources, kind, jobId, notes);
  return response(sources, kind, jobId, notes);
}

function reviewMessage(notes: KnowledgeReviewNote[]): string {
  return ["请根据以下人工审阅意见提出文稿修订建议。先核对最新正文、涉及的来源与上下文；引用的位置可能已变化，已经解决的意见不必重复修改。保留没有被要求修改的内容。",
    ...notes.map((note, index) => [
      `\n${index + 1}. ${note.document_title}（${note.document_id}）`,
      `范围：${note.scope === "line" ? `第 ${note.line}${note.line_end !== note.line ? `–${note.line_end}` : ""} 行` : note.scope === "study" ? "本次任务的全部文稿" : "整篇文稿"}`,
      note.anchor ? `位置：${note.anchor}` : "", note.quote ? `引用正文：\n${note.quote}` : "",
      note.context_before ? `前文：\n${note.context_before}` : "", note.context_after ? `后文：\n${note.context_after}` : "",
      `意见：${note.note}`,
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

export function applyKnowledgeReviewNotes(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string, input: { note_ids: string[] }, operator: string): KnowledgeReviewNotesResult {
  documents(sources, kind, jobId);
  if (kind === "published" || kind === "skill") throw new Error("请先更新文档，修改完成后将意见标为已处理");
  if (!Array.isArray(input.note_ids) || !input.note_ids.length || input.note_ids.some(id => typeof id !== "string")) throw new Error("请选择未处理的审阅意见");
  const notes = read(sources, kind, jobId), ids = [...new Set(input.note_ids)];
  const selected = ids.map(id => {
    const note = notes.find(note => note.id === id);
    if (!note) throw new Error("所选批注已不存在，请刷新");
    if (note.status !== "open") throw new Error("所选意见已经提交修订或标为已处理，请刷新查看");
    currentDocument(sources, kind, jobId, note);
    return note;
  });
  const documentIds = [...new Set(selected.map(note => note.document_id))];
  const wholeStudy = selected.some(note => note.scope === "study");
  if (kind === "component" && !wholeStudy && documentIds.length !== 1) throw new Error("组件研究每轮修订一个章节，请按章节分别提交意见");
  const message = reviewMessage(selected);
  if (message.length > 20_000) throw new Error("本批意见与引用超过 20000 字，请减少本次选中的意见");
  let turnId: string | undefined;
  if (kind === "domain") {
    const job = sources.domain.run(jobId, { mode: "revise", document_ids: selected.some(note => note.scope === "study")
      ? documents(sources, kind, jobId).map(doc => doc.id) : documentIds, message }, operator);
    turnId = job.turns.at(-1)?.id;
  } else {
    const job = sources.component.review(jobId, { mode: "rework", section_id: wholeStudy ? "" : documentIds[0], message }, operator);
    turnId = job.review_turns?.at(-1)?.id;
  }
  const submittedAt = new Date().toISOString();
  for (const note of selected) Object.assign(note, { status: "submitted", submitted_at: submittedAt, submitted_by: operator, turn_id: turnId });
  save(sources, kind, jobId, notes);
  return { ...response(sources, kind, jobId, notes), turn_id: turnId };
}

export function resolveKnowledgeReviewNotes(sources: KnowledgeReviewSources, kind: KnowledgeReviewKind, jobId: string, input: { note_ids: string[] }, operator: string): KnowledgeReviewNotesResult {
  documents(sources, kind, jobId);
  if (!Array.isArray(input.note_ids) || !input.note_ids.length || input.note_ids.some(id => typeof id !== "string")) throw new Error("请选择需要标为已处理的意见");
  const notes = read(sources, kind, jobId);
  const selected = [...new Set(input.note_ids)].map(id => {
    const note = notes.find(note => note.id === id);
    if (!note) throw new Error("所选批注已不存在，请刷新");
    return note;
  });
  const resolvedAt = new Date().toISOString();
  for (const note of selected) if (note.status !== "resolved") Object.assign(note, { status: "resolved", resolved_at: resolvedAt, resolved_by: operator });
  save(sources, kind, jobId, notes);
  return response(sources, kind, jobId, notes);
}
