import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import type { DomainWorkDocument } from "./domainKnowledgeTypes.ts";

export class IncompleteDomainResearch extends Error {}
export type SkillWorkDocument = DomainWorkDocument;
export interface SkillWorkResult { summary: string; document_ids: string[]; work_document_ids?: string[]; data?: unknown; status?: "complete" | "paused" }
function validWorkDocument(value: any): value is SkillWorkDocument {
  return value && typeof value.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(value.id)
    && typeof value.title === "string" && !!value.title.trim() && value.title.length <= 160
    && typeof value.content === "string" && !!value.content.trim() && Buffer.byteLength(value.content) <= 2 * 1024 * 1024;
}
export function readSkillWorkDocuments(file: string): SkillWorkDocument[] {
  if (!existsSync(file)) return [];
  const state = JSON.parse(readFileSync(file, "utf8"));
  const documents = state.documents ?? [];
  if (!Array.isArray(documents) || !documents.every(validWorkDocument)) throw new Error("过程文稿记录形状无效");
  return documents;
}
export interface SkillWorkStep {
  id: string; title: string; instructions: string; depends_on: string[]; readonly: boolean;
  status: "pending" | "running" | "done" | "failed" | "discarded";
  result?: SkillWorkResult; error?: string; attempts: number;
}
/** 只保存 Skill 自己安排的工作；不解释模块、阶段或文档类型。 */
export class DomainSkillWork {
  readonly state: { version: 1; skill: string; steps: SkillWorkStep[]; documents?: SkillWorkDocument[]; result?: SkillWorkResult; previous_results?: SkillWorkResult[]; continued?: number };
  constructor(private file: string, skill: string, continued = 0) {
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, skill, steps: [] };
    if (this.state.version !== 1) throw new Error("不支持的 Skill 执行记录版本");
    for (const step of this.state.steps) if (step.status === "running") { step.status = "failed"; step.error = "执行中断，可按原编号接续"; }
    if (this.state.result && (this.state.skill !== skill || continued > (this.state.continued ?? 0))) {
      (this.state.previous_results ??= []).push(this.state.result); delete this.state.result;
    }
    this.state.continued = continued; this.state.skill = skill; this.persist();
  }
  private persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".tmp", JSON.stringify(this.state), { mode: 0o600 }); renameSync(this.file + ".tmp", this.file);
  }
  saveDocument(document: SkillWorkDocument) {
    if (!validWorkDocument(document)) throw new Error("过程文稿需要有效编号、标题和完整正文，单篇最多 2 MiB");
    scanForSecrets("过程文稿", Buffer.from(JSON.stringify(document)));
    const documents = this.state.documents ?? [];
    if (!documents.some(item => item.id === document.id) && documents.length >= 5000) throw new Error("过程文稿数量已达到上限");
    this.state.documents = [...documents.filter(item => item.id !== document.id), structuredClone(document)];
    this.persist();
  }
  schedule(steps: Array<Pick<SkillWorkStep, "id" | "title" | "instructions" | "depends_on" | "readonly">>) {
    if (!steps.length || steps.length > 100 || this.state.steps.length + steps.length > 5000) throw new Error("请分批保存工作步骤，单批最多 100 项，总计最多 5000 项");
    scanForSecrets("Skill 工作步骤", Buffer.from(JSON.stringify(steps)));
    const next = structuredClone(this.state.steps);
    for (const step of steps) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/.test(step.id) || !step.title.trim() || !step.instructions.trim() || typeof step.readonly !== "boolean") throw new Error("步骤需要有效编号、标题、执行说明和读写权限");
      const old = next.find(s => s.id === step.id);
      if (old) {
        if (["title", "instructions", "depends_on", "readonly"].some(k => JSON.stringify(old[k as keyof SkillWorkStep]) !== JSON.stringify(step[k as keyof typeof step]))) throw new Error("已有步骤不能改写，请使用新编号保存修订工作");
      } else next.push({ ...step, status: "pending", attempts: 0 });
    }
    const visited = new Set<string>(), visiting = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error("工作步骤存在循环依赖");
      const step = next.find(s => s.id === id); if (!step) throw new Error("依赖步骤不存在");
      visiting.add(id); step.depends_on.forEach(visit); visiting.delete(id); visited.add(id);
    };
    next.forEach(s => visit(s.id)); this.state.steps = next; delete this.state.result; this.persist();
  }
  discard(id: string, reason: string) {
    const step = this.state.steps.find(s => s.id === id);
    if (!step || step.status === "running" || !reason.trim()) throw new Error("请选择未在执行的步骤并说明不再执行的原因");
    step.status = "discarded"; step.error = reason; this.persist();
  }
  async run(id: string, execute: (step: SkillWorkStep) => Promise<SkillWorkResult>, signal: AbortSignal) {
    const step = this.state.steps.find(s => s.id === id);
    if (!step || ["running", "discarded"].includes(step.status)) throw new Error("步骤不存在、已放弃或正在执行");
    if (step.status === "done") return step.result!;
    if (step.depends_on.some(id => this.state.steps.find(s => s.id === id)?.status !== "done")) throw new Error("依赖步骤尚未完成");
    signal.throwIfAborted(); step.status = "running"; step.attempts++; delete step.error; this.persist();
    try {
      const result = await execute(structuredClone(step)); signal.throwIfAborted();
      step.result = result; step.status = "done"; this.persist(); return result;
    } catch (error) { step.status = "failed"; step.error = error instanceof Error ? error.message : String(error); this.persist(); throw error; }
  }
  finish(result: SkillWorkResult) {
    if (result.status !== "paused" && this.state.steps.some(s => !["done", "discarded"].includes(s.status))) throw new Error("还有未完成的步骤，请继续处理、说明放弃原因或保存暂停结果");
    // 没有另存文稿的简单方法也能让人阅读全文，不把等待说明仅留在错误栏。
    if (result.status === "paused" && !result.work_document_ids?.length) {
      const id = `input-${randomUUID()}`;
      this.saveDocument({ id, title: "待确认说明", content: result.summary });
      result = { ...result, work_document_ids: [id] };
    }
    this.state.result = result; this.persist();
    return result;
  }
}
