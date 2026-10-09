import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validComponentId } from "./componentParadigms.ts";

export interface ComponentWorkResult {
  findings: string; open_questions: string[];
  components?: Array<{ id: string; title: string; repository_ids: string[]; scope: string }>;
  paradigms?: Array<{ id: string; title: string; need: string }>;
}
export interface ComponentWork {
  id: string; phase: "inventory" | "plan" | "contracts" | "paradigm" | "pitfalls" | "index" | "synthesis";
  title: string; component?: string; spec: string; dependencies: string[];
  status: "pending" | "running" | "done" | "failed"; attempts: number;
  result?: ComponentWorkResult; feedback?: string;
}
export interface ComponentPipelineState { version: 1; skill: string; tasks: ComponentWork[] }
const task = (id: string, phase: ComponentWork["phase"], title: string, dependencies: string[], spec = "", component?: string): ComponentWork =>
  ({ id, phase, title, dependencies, spec, component, status: "pending", attempts: 0 });
export class ComponentResearchPipeline {
  readonly state: ComponentPipelineState;
  constructor(private file: string, skill: string, private repositoryIds: string[]) {
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, skill,
      tasks: [task("inventory", "inventory", "盘点组件能力", [])] };
    if (this.state.version !== 1 || this.state.skill !== skill) throw new Error("研究方法版本已变化，请新建研究；已完成任务保留原版本");
    for (const t of this.state.tasks) if (["running", "failed"].includes(t.status)) { t.status = "pending"; t.attempts = 0; }
    this.persist();
  }
  private persist() { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file + ".tmp", JSON.stringify(this.state), { mode: 0o600 }); renameSync(this.file + ".tmp", this.file); }
  private expand(t: ComponentWork, r: ComponentWorkResult) {
    const unique = (ids: string[]) => ids.every(validComponentId) && new Set(ids).size === ids.length;
    if (t.phase === "inventory") {
      const cs = r.components;
      if (!cs?.length || cs.length > 100 || !unique(cs.map(c => c.id)) || cs.some(c => !c.title?.trim() || !c.scope?.trim()
        || !c.repository_ids?.length || c.repository_ids.some(id => !this.repositoryIds.includes(id)))) throw new Error("盘点需提供 1～100 个唯一能力、范围与有效基础仓编号");
      return [...cs.map(c => task(`plan-${c.id}`, "plan", c.title, [t.id], JSON.stringify(c), c.id)),
        task("synthesis", "synthesis", "汇总选型指南与待确认问题", cs.map(c => `index-${c.id}`))];
    }
    if (t.phase === "plan") {
      const ps = r.paradigms;
      if (!ps?.length || ps.length > 50 || !unique(ps.map(p => p.id)) || ps.some(p => !p.title?.trim() || !p.need?.trim())) throw new Error("规划需提供 1～50 个唯一范式及需求；超出范围请重新划分，不能静默截断");
      const contract = `contracts-${t.component}`, pit = `pitfalls-${t.component}`;
      return [task(contract, "contracts", `${t.title}：使用契约`, [t.id], t.spec, t.component),
        ...ps.map(p => task(`paradigm-${t.component}-${p.id}`, "paradigm", p.title, [contract], JSON.stringify(p), t.component)),
        task(pit, "pitfalls", `${t.title}：误用陷阱`, ps.map(p => `paradigm-${t.component}-${p.id}`), t.spec, t.component),
        task(`index-${t.component}`, "index", `${t.title}：使用导航`, [pit], t.spec, t.component)];
    }
    return [];
  }
  async run(options: { signal: AbortSignal; execute: (t: ComponentWork) => Promise<ComponentWorkResult>;
    review: (t: ComponentWork, r: ComponentWorkResult) => Promise<string | undefined>; changed: (s: ComponentPipelineState) => void }) {
    const changed = () => { this.persist(); options.changed(structuredClone(this.state)); };
    changed();
    for (;;) {
      options.signal.throwIfAborted();
      const t = this.state.tasks.find(t => t.status === "pending" && t.dependencies.every(id => this.state.tasks.some(d => d.id === id && d.status === "done")));
      if (!t) break;
      t.status = "running"; t.attempts++; changed();
      try {
        const result = await options.execute(structuredClone(t)); options.signal.throwIfAborted();
        if (!result.findings?.trim() || !Array.isArray(result.open_questions) || result.open_questions.some(q => typeof q !== "string")) throw new Error("任务必须保存具体结论和待确认问题");
        const additions = this.expand(t, result);
        if (additions.some(a => this.state.tasks.some(old => old.id === a.id))) throw new Error("任务编号与已有产物重复，请调整组件或范式编号");
        t.result = result; changed();
        const feedback = await options.review(structuredClone(t), result); options.signal.throwIfAborted();
        if (feedback) throw new Error(feedback);
        t.status = "done"; delete t.feedback;
        this.state.tasks.push(...additions); changed();
      } catch (error) {
        if (options.signal.aborted) throw error;
        t.feedback = error instanceof Error ? error.message : String(error);
        t.status = t.attempts >= 3 ? "failed" : "pending"; changed();
      }
    }
    const unfinished = this.state.tasks.filter(t => t.status !== "done");
    if (unfinished.length) throw new Error(`组件研究未完成，已通过的任务保留，可重试接续。${unfinished.filter(t => t.status === "failed").map(t => `${t.title}：${t.feedback}`).join("；")}`);
    return "组件范式研究与独立评审完成，草稿等待人工审查，派生规则尚未启用。";
  }
}
