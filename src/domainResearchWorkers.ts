import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import type { DomainResearch } from "./domainKnowledgeTypes.ts";

export interface DomainResearchReport {
  findings: string;
  checks: NonNullable<DomainResearch["capabilities"][number]["checks"]>;
  evidence_ids: string[];
  sources: Array<{ repository_id: string; path: string }>;
  open_questions: string[];
}
export interface DomainResearchWorker {
  capability_id: string;
  question: string;
  status: "queued" | "running" | "done" | "failed";
  report?: DomainResearchReport;
  read?: boolean;
  error?: string;
}
interface WorkerOptions {
  root: string;
  signal: AbortSignal;
  capability: (id: string) => DomainResearch["capabilities"][number] | undefined;
  run: (worker: DomainResearchWorker, signal: AbortSignal, save: (report: DomainResearchReport) => void) => Promise<void>;
  evidence: (event: Record<string, unknown>) => void;
}

/** 子研究单独落盘；最多两个并行会话，主 Agent 统一维护知识草稿。 */
export class DomainResearchWorkers {
  private records = new Map<string, DomainResearchWorker>();
  private running = new Map<string, Promise<void>>();
  private controller = new AbortController();
  readonly signal: AbortSignal;
  progress = 0;
  constructor(private options: WorkerOptions) {
    this.signal = AbortSignal.any([options.signal, this.controller.signal]);
    if (existsSync(options.root)) for (const file of readdirSync(options.root).filter(f => /^[a-zA-Z0-9_-]{1,100}\.json$/.test(f))) {
      const record: DomainResearchWorker = JSON.parse(readFileSync(join(options.root, file), "utf8"));
      if (`${record.capability_id}.json` !== file) throw new Error("子研究记录与文件不一致");
      if (record.status === "running") record.status = "queued";
      this.records.set(record.capability_id, record);
    }
  }
  private persist(record: DomainResearchWorker) {
    mkdirSync(this.options.root, { recursive: true });
    const file = join(this.options.root, `${record.capability_id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 }); renameSync(`${file}.tmp`, file);
  }
  private note(record: DomainResearchWorker, text: string) {
    this.options.evidence({ tool: "research_note", worker_id: record.capability_id, preview: `${this.options.capability(record.capability_id)?.title ?? record.capability_id}：${text}` });
  }
  start(assignments: Array<{ capability_id: string; question: string }>) {
    this.signal.throwIfAborted();
    if (new Set(assignments.map(a => a.capability_id)).size !== assignments.length) throw new Error("同一次分工不能重复指定知识主题");
    for (const a of assignments) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(a.capability_id) || !this.options.capability(a.capability_id)
          || !a.question.trim() || a.question.length > 12000) throw new Error("请先建立知识主题计划，再指定具体研究问题");
      scanForSecrets("子研究问题", Buffer.from(a.question));
      const old = this.records.get(a.capability_id);
      if (old && ["queued", "running"].includes(old.status) && old.question !== a.question) throw new Error("该主题已有子研究进行中，请先读取结果");
    }
    for (const a of assignments) {
      const old = this.records.get(a.capability_id);
      if (old && old.status !== "failed" && old.question === a.question) continue;
      const record: DomainResearchWorker = { ...a, status: "queued" };
      this.records.set(a.capability_id, record); this.persist(record);
      this.note(record, "子 Agent 已排入研究队列");
    }
    this.restore();
    return this.list();
  }
  restore() {
    if (this.signal.aborted) return;
    for (const record of this.records.values()) {
      if (this.running.size >= 2) break;
      if (record.status !== "queued" || this.running.has(record.capability_id)) continue;
      record.status = "running"; this.persist(record);
      const work = Promise.resolve().then(async () => {
        try {
          this.signal.throwIfAborted();
          this.note(record, "子 Agent 正在查证，沿用已保存的独立会话");
          await this.options.run(record, this.signal, report => {
            this.signal.throwIfAborted();
            if (JSON.stringify(report).length > 40000) throw new Error("子研究结论过长，请保存具体结论与证据位置，不复制大段源码");
            scanForSecrets("子研究结论", Buffer.from(JSON.stringify(report)));
            record.report = structuredClone(report); record.read = false; this.progress++; this.persist(record);
          });
          this.signal.throwIfAborted();
          if (!record.report) throw new Error("子研究未保存可复核的结论");
          record.status = "done"; delete record.error; this.persist(record);
          this.note(record, "子 Agent 已保存结论，等待主 Agent 核对和整合");
        } catch (error) {
          // 关闭或人工停止时保留 running，恢复服务后继续同一个子会话。
          if (this.signal.aborted) return;
          record.status = "failed"; record.error = error instanceof Error ? error.message : String(error); this.persist(record);
          this.note(record, `子研究未完成：${record.error}`);
        }
      }).finally(() => { this.running.delete(record.capability_id); this.restore(); });
      this.running.set(record.capability_id, work);
    }
  }
  list() {
    return [...this.records.values()].map(({ capability_id, question, status, report, read, error }) => ({
      capability_id, question: question.slice(0, 240), status, has_report: !!report, read, error: error?.slice(0, 500),
    }));
  }
  read(id: string) {
    this.signal.throwIfAborted();
    const record = this.records.get(id); if (!record) throw new Error("子研究不存在");
    if (record.status === "done" && !record.read) { record.read = true; this.progress++; this.persist(record); }
    return structuredClone(record);
  }
  gaps() {
    return [...this.records.values()].flatMap(r => ["queued", "running"].includes(r.status)
      ? [`${r.capability_id} 子研究尚未完成`]
      : r.status === "done" && !r.read ? [`${r.capability_id} 子研究结论尚未读取，请用 knowledge_delegate read 指定主题编号核对并整合`] : []);
  }
  anchor() { return `子研究状态：${JSON.stringify(this.list().filter(r => r.status !== "done" || !r.read).slice(0, 20))}；完整清单和结论用 knowledge_delegate read 按需读取。`; }
  async waitForIdle() {
    while (!this.signal.aborted && this.running.size) await Promise.allSettled([...this.running.values()]);
  }
  async shutdown() { this.controller.abort(); await Promise.allSettled([...this.running.values()]); }
  tool() {
    return defineTool({ name: "knowledge_delegate", label: "分工研究业务知识主题",
      description: "start 将已建计划中的独立知识主题交给子 Agent，可一次提交多项；最多两个并行，其他排队，立即返回后主 Agent 可继续跨仓调查。相同主题/问题复用原会话和已有结果，不重复启动。read 列状态，capability_id 读取持久结论；wait 最多等待 30 秒有结果。子 Agent 只读来源并保存研究结论，不能改草稿或发布。主 Agent 必须核对、整合结论并继续发现遗漏。",
      parameters: Type.Object({ action: Type.Union([Type.Literal("start"), Type.Literal("read"), Type.Literal("wait")]),
        assignments: Type.Optional(Type.Array(Type.Object({ capability_id: Type.String(), question: Type.String() }), { minItems: 1, maxItems: 8 })), capability_id: Type.Optional(Type.String()),
        start: Type.Optional(Type.Integer({ minimum: 1 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
      execute: async (_id: string, params: { action: string; assignments?: Array<{ capability_id: string; question: string }>; capability_id?: string; start?: number; count?: number }) => {
        try {
          this.signal.throwIfAborted();
          if (params.action === "start") { if (!params.assignments?.length) throw new Error("缺少分工问题"); this.start(params.assignments); }
          if (params.action === "wait" && this.running.size) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try { await Promise.race([...this.running.values(), new Promise<void>(resolve => { timer = setTimeout(resolve, 30000); timer.unref(); })]); }
            finally { clearTimeout(timer); }
          }
          const rows = this.list(), start = params.start ?? 1, count = params.count ?? 25;
          const result = params.action === "read" && params.capability_id ? this.read(params.capability_id)
            : { workers: rows.slice(start - 1, start - 1 + count), total: rows.length, next_start: start + count <= rows.length ? start + count : undefined };
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (error) { return { content: [{ type: "text" as const, text: String(error) }], details: {}, isError: true }; }
      },
    });
  }
}
