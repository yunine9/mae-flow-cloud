import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { IncompleteDomainResearch } from "./domainResearchProgress.ts";
import { scanForSecrets } from "./hostSkillLibrary.ts";

export type KnowledgePhase = "inventory" | "plan" | "hop" | "common" | "assemble" | "wrap" | "cross-plan" | "cross" | "synthesis";
export interface KnowledgeWork {
  id: string; phase: KnowledgePhase; title: string; depends_on: string[];
  module?: string; spec: string; status: "pending" | "running" | "done" | "failed";
  document_ids?: string[];
  attempts: number; result?: KnowledgeWorkResult; feedback?: string;
}
export interface KnowledgeWorkResult {
  findings: string; document_ids: string[]; open_questions: string[];
  modules?: Array<{ id: string; title: string; kind: "public" | "business"; depends_on: string[]; scope: string }>;
  subfeatures?: Array<{ id: string; title: string; hops: Array<{ id: string; title: string; questions: string }> }>;
  cross_items?: Array<{ id: string; title: string; questions: string }>;
}
export interface KnowledgePipelineState {
  probe_module?: string;
  version: 1; skill: string; tasks: KnowledgeWork[];
  calibration: "pending" | "waiting" | "accepted";
  calibration_continue?: number;
}
const validId = (id: string) => /^[a-z0-9][a-z0-9-]{0,59}$/.test(id);
const work = (id: string, phase: KnowledgePhase, title: string, depends_on: string[], spec = "", module?: string): KnowledgeWork =>
  ({ id, phase, title, depends_on, spec, module, status: "pending", attempts: 0 });

/** 进度属于宿主；模型每次只完成一个小任务，普通回复不作为完成信号。 */
export class DomainKnowledgePipeline {
  readonly state: KnowledgePipelineState;
  private changed?: (state: KnowledgePipelineState) => void;
  constructor(private file: string, skill: string, private continued = 0, private probeModule?: string) {
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {
      version: 1, skill, probe_module: probeModule, calibration: "pending", tasks: [work("inventory", "inventory", "盘点业务模块与公共组件", [])],
    };
    if (this.state.version !== 1) throw new Error("不支持的领域研究进度版本");
    if (this.state.probe_module !== probeModule) throw new Error("不能改变已开始验证的模块范围，请新建验证任务");
    // 显式接续才恢复失败任务；已通过的任务和历史意见保留。
    for (const task of this.state.tasks) if (task.status === "running" || task.status === "failed") { task.status = "pending"; task.attempts = 0; }
    if (this.state.calibration === "waiting" && continued > (this.state.calibration_continue ?? 0)) this.state.calibration = "accepted";
    this.state.skill = skill;
    this.persist();
  }
  private persist() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state), { mode: 0o600 }); renameSync(`${this.file}.tmp`, this.file);
    this.changed?.(structuredClone(this.state));
  }
  recordDocument(taskId: string, id: string) {
    const task = this.state.tasks.find(t => t.id === taskId);
    if (!task) throw new Error("研究任务不存在");
    task.document_ids = [...new Set([...(task.document_ids ?? []), id])]; this.persist();
  }
  private expand(task: KnowledgeWork, result: KnowledgeWorkResult): KnowledgeWork[] {
    const tasks: KnowledgeWork[] = [];
    const unique = (ids: string[]) => ids.every(validId) && new Set(ids).size === ids.length;
    if (task.phase === "inventory") {
      const modules = result.modules;
      if (!modules?.length || modules.length > 100 || !unique(modules.map(m => m.id))) throw new Error("盘点需要 1～100 个唯一模块编号");
      if (this.probeModule && (modules.length !== 1 || modules[0].id !== "probe" || modules[0].title !== this.probeModule || modules[0].depends_on.length)) throw new Error("本次仅验证指定模块：modules 只能有 id=probe、title=" + this.probeModule + " 的一项，depends_on 必须为空；依赖只在该模块内按需查证");
      const ordered: typeof modules = [], remaining = [...modules];
      while (remaining.length) {
        const ready = remaining.filter(m => m.depends_on.every(id => ordered.some(row => row.id === id)))
          .sort((a, b) => Number(a.kind === "business") - Number(b.kind === "business"));
        if (!ready.length) throw new Error("模块依赖不存在或形成循环，请合并互相依赖的模块并说明边界");
        const m = ready[0]; ordered.push(m); remaining.splice(remaining.indexOf(m), 1);
      }
      for (const m of ordered) tasks.push(work(`plan-${m.id}`, "plan", m.title, ["inventory", ...m.depends_on.map(id => `wrap-${id}`)], JSON.stringify(m), m.id));
      if (!this.probeModule) tasks.push(work("cross-plan", "cross-plan", "识别跨模块链路与跨仓契约", ordered.map(m => `wrap-${m.id}`)));
    } else if (task.phase === "plan") {
      const features = result.subfeatures;
      if (!features?.length || features.length > 50 || !unique(features.map(f => f.id))) throw new Error("模块规划需要唯一的子功能清单");
      const hops: string[] = [];
      for (const f of features) {
        if (!f.hops.length || f.hops.length > 50 || !unique(f.hops.map(h => h.id))) throw new Error("每个子功能需要唯一的链路分段");
        for (const h of f.hops) {
          if (!h.questions.trim()) throw new Error("每段链路必须说明待回答的具体问题");
          const id = `hop-${task.module}-${f.id}-${h.id}`; hops.push(id);
          tasks.push(work(id, "hop", h.title, [task.id], JSON.stringify({ feature: f.title, ...h }), task.module));
        }
      }
      if (hops.length > 200) throw new Error("模块超过 200 段，请重新划分模块或明确未覆盖范围");
      const common = `common-${task.module}`;
      tasks.push(work(common, "common", `${task.title}：公共链路`, hops, "", task.module));
      for (const f of features) tasks.push(work(`assemble-${task.module}-${f.id}`, "assemble", f.title, [common, ...f.hops.map(h => `hop-${task.module}-${f.id}-${h.id}`)], JSON.stringify(f), task.module));
      tasks.push(work(`wrap-${task.module}`, "wrap", `${task.title}：导航、交互与仓内设计`, features.map(f => `assemble-${task.module}-${f.id}`), "", task.module));
    } else if (task.phase === "wrap" && this.probeModule) {
      for (const name of ["glossary", "questions", "index"]) tasks.push(work(`synthesis-${name}`, "synthesis", `${this.probeModule}：${name === "glossary" ? "术语" : name === "questions" ? "待确认问题" : "验证范围与索引"}`, [task.id], name));
    } else if (task.phase === "cross-plan") {
      if (!result.cross_items || result.cross_items.length > 100 || !unique(result.cross_items.map(c => c.id))) throw new Error("跨模块规划需要 cross_items，可为空，但须在 findings 说明依据");
      for (const c of result.cross_items) tasks.push(work(`cross-${c.id}`, "cross", c.title, [task.id], c.questions));
      for (const name of ["glossary", "questions", "index"]) tasks.push(work(`synthesis-${name}`, "synthesis", { glossary: "术语表", questions: "待专家确认问题", index: "知识导航与覆盖报告" }[name]!, [task.id, ...result.cross_items.map(c => `cross-${c.id}`)], name));
    }
    return tasks;
  }
  async run(options: {
    signal: AbortSignal;
    execute: (task: KnowledgeWork, state: KnowledgePipelineState) => Promise<KnowledgeWorkResult>;
    review: (task: KnowledgeWork, result: KnowledgeWorkResult) => Promise<string | undefined>;
    stage: (message: string) => void;
    changed?: (state: KnowledgePipelineState) => void;
  }) {
    this.changed = options.changed; this.changed?.(structuredClone(this.state));
    if (this.state.calibration === "waiting") throw new IncompleteDomainResearch("等待前两个业务模块的质量检查，请在工作台确认后点击接续研究");
    for (;;) {
      options.signal.throwIfAborted();
      const task = this.state.tasks.find(t => t.status === "pending" && t.depends_on.every(id => this.state.tasks.some(d => d.id === id && d.status === "done")));
      if (!task) break;
      task.status = "running"; task.attempts++; this.persist();
      options.stage(`${task.title}（第 ${task.attempts}/3 轮）`);
      try {
        const result = await options.execute(structuredClone(task), structuredClone(this.state));
        options.signal.throwIfAborted();
        if (!result.findings.trim()) throw new Error("任务没有保存研究结论");
        scanForSecrets("领域研究结果", Buffer.from(JSON.stringify(result)));
        const additions = this.expand(task, result);
        if (!["inventory", "plan", "cross-plan"].includes(task.phase) && !result.document_ids.length && task.phase !== "hop") throw new Error("写作任务没有保存草稿");
        task.result = result; this.persist();
        const feedback = await options.review(task, result);
        options.signal.throwIfAborted();
        if (feedback) throw new Error(feedback);
        task.result = result; task.status = "done"; delete task.feedback;
        this.state.tasks.push(...additions.filter(t => !this.state.tasks.some(old => old.id === t.id)));
        this.persist();
        const modules = this.state.tasks.find(t => t.id === "inventory")?.result?.modules ?? [];
        const doneBusiness = modules.filter(m => m.kind === "business" && this.state.tasks.some(t => t.id === `wrap-${m.id}` && t.status === "done"));
        if (this.state.calibration === "pending" && doneBusiness.length >= 2) {
          this.state.calibration = "waiting"; this.state.calibration_continue = this.continued; this.persist();
          throw new IncompleteDomainResearch("前两个业务模块已完成独立评审。请在现有草稿工作台检查质量，满意后点击接续研究；进度已保存，不会因等待超时自动视为同意。");
        }
      } catch (error) {
        if (options.signal.aborted || error instanceof IncompleteDomainResearch) throw error;
        task.feedback = error instanceof Error ? error.message : String(error);
        task.status = task.attempts >= 3 ? "failed" : "pending"; this.persist();
      }
    }
    const unfinished = this.state.tasks.filter(t => t.status !== "done");
    if (unfinished.length) throw new IncompleteDomainResearch(`研究尚未完成，${unfinished.length} 项失败或依赖受阻；已通过的结果保留。${unfinished.filter(t => t.status === "failed").map(t => `${t.title}：${t.feedback}`).join("；")}`);
    if (this.probeModule) return `单模块效果验证完成：${this.probeModule}，${this.state.tasks.length} 个任务已完成独立评审。结果仅作为验证草稿，未入库或发布。`;
    return `领域知识研究完成：${this.state.tasks.length} 个任务均已完成独立评审。草稿等待人工审查与归档，未确认问题见问题清单。`;
  }
}
