import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isResearchPlatformPath } from "./componentResearchTools.ts";
import type { DomainExecution, DomainResearch } from "./domainKnowledgeTypes.ts";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import { isBusinessKnowledgeEvidence } from "./domainResearchEvidence.ts";

export class IncompleteDomainResearch extends Error {}
export const businessSource = (path: string) => !isResearchPlatformPath(path)
  && !/(^|\/)(?:AGENTS|agent|module-map)\.md$/i.test(path);

/** 研究方法由 Skill 决定；宿主保存进度并核对所引用的文件确实读过。 */
export class DomainResearchProgress {
  state: DomainResearch;
  private reads: Array<Record<string, unknown>>;
  private reviewed = new Map<string, number>();
  private seenReads = new Set<string>();
  private changes = 0;
  private workers?: { gaps: () => string[]; anchor: () => string };
  attachWorkers(workers: { gaps: () => string[]; anchor: () => string }) { this.workers = workers; }
  constructor(private input: DomainExecution, private revisions: Record<string, string>) {
    this.state = structuredClone(input.turn.research ?? { capabilities: [], inventory_complete: false, phase: "research" });
    this.reads = [...input.job.evidence];
    for (const event of this.reads) this.seenReads.add(this.readKey(event));
  }
  private readKey(event: Record<string, unknown>) { return String(event.evidence_id ?? JSON.stringify([event.component_id, event.revision, event.path, event.start, event.end])); }
  observe(event: Record<string, unknown>) {
    this.reads.push(event);
    const key = this.readKey(event);
    if ((isBusinessKnowledgeEvidence(event) || (event.tool === "component_source" && event.action === "read" && event.status === "returned" && businessSource(String(event.path)))) && !this.seenReads.has(key)) { this.seenReads.add(key); this.changes++; }
  }
  readDocument(id?: string) {
    const doc = this.input.read().find(d => d.id === id);
    if (doc && this.state.phase === "review" && this.reviewed.get(doc.id) !== doc.revision) { this.reviewed.set(doc.id, doc.revision); this.changes++; }
  }
  documentChanged() { this.changes++; this.state.finish_requested = false; this.persist(); }
  get progress() { return this.changes; }
  private persist() { this.input.update({ research: this.state }); }
  anchor() {
    const pending = this.state.capabilities.filter(c => c.state !== "researched");
    return `业务范围：${this.input.job.scope}\n研究阶段：${this.state.phase}；共 ${this.state.capabilities.length} 项知识主题，${pending.length} 项未完成。\n未完成主题摘要（最多 20 项）：${JSON.stringify(pending.slice(0, 20).map(c => ({ id: c.id, title: c.title, state: c.state, repository_ids: c.repository_ids })))}\n目标是补全代码不能表达的业务背景、规则原因、隐含约束与历史经验。完整计划用 knowledge_research read 分页读取，指定 id 读取结论与证据；knowledge_evidence list 检索主、子 Agent 已查资料，read 回查正文；knowledge_draft read 读取草稿。无线豆包与上传资料同为主力，无上传资料也主动检索。方法通过 extraction_skill 读取 SKILL.md、references/domain.md 和 references/materials.md。源码仅按需核对，不按仓扫描。\n${this.workers?.anchor() ?? ""}`;
  }
  gaps(): string[] {
    const gaps: string[] = this.workers?.gaps() ?? [], docs = this.input.read();
    if (!this.state.inventory_complete) gaps.push("尚未完成业务资料与知识问题的梳理，请补充计划后调用 inventory_complete");
    if (!this.state.capabilities.length) gaps.push("尚未建立业务知识研究计划");
    for (const capability of this.state.capabilities) {
      if (capability.state !== "researched") { gaps.push(`${capability.title}：${capability.state === "blocked" ? "受阻，" + capability.findings : "尚未完成研究"}`); continue; }
      if (!capability.findings.trim()) gaps.push(`${capability.title} 缺少有业务内容的研究结论`);
      if (!capability.evidence_ids?.length || capability.evidence_ids.some(id => !this.reads.some(e => e.evidence_id === id && isBusinessKnowledgeEvidence(e)))) gaps.push(`${capability.title} 缺少实际读取的业务资料证据；源码不能替代业务意图或历史决策的依据`);
      if (!capability.document_ids.length || capability.document_ids.some(id => !docs.some(d => d.id === id))) gaps.push(`${capability.title} 尚无对应的已保存文档`);
      if (capability.sources.some(s => !businessSource(s.path) || !this.reads.some(e => e.tool === "component_source"
          && e.action === "read" && e.status === "returned" && e.component_id === s.repository_id && e.path === s.path && e.revision === this.revisions[s.repository_id]))) gaps.push(`${capability.title} 引用的辅助源码尚未按本轮版本实际读取`);
    }
    if (!docs.some(d => d.layer === "domain")) gaps.push("缺少领域知识草稿");
    if (this.state.phase === "review") {
      for (const id of new Set(this.state.capabilities.flatMap(c => c.document_ids))) if (this.reviewed.get(id) !== docs.find(d => d.id === id)?.revision) gaps.push(`最终核对尚未读取文档 ${id} 当前版本全文`);
    }
    return gaps;
  }
  next(): string | undefined {
    const gaps = this.gaps();
    if (gaps.length) {
      if (this.state.capabilities.length && this.state.inventory_complete
          && this.state.capabilities.every(c => c.state !== "pending")
          && gaps.every(gap => gap === "缺少领域知识草稿" || this.state.capabilities.some(c => c.state === "blocked" && gap.startsWith(`${c.title}：受阻`)))) {
        throw new IncompleteDomainResearch(`研究部分完成，存在外部阻塞：${gaps.join("；")}。已有草稿与进度保留。`);
      }
      this.state.finish_requested = false; this.persist();
      return `研究尚未完成，继续处理具体缺口，不要仅回复总结（显示 ${Math.min(gaps.length, 20)}/${gaps.length} 项）：\n${gaps.slice(0, 20).join("\n")}\n${this.anchor()}`;
    }
    if (!this.state.finish_requested) return "请按 Skill 核对业务知识主题，补充遗漏的问题和资料。确认当前研究可交付后调用 knowledge_research 的 complete，不要把一段最终回复作为完成信号。";
    if (this.state.phase === "research") {
      this.state.phase = "review"; this.state.finish_requested = false; this.reviewed.clear(); this.persist();
      return `进入最终证据核对。逐份读取关联文档全文，核对业务背景、规则原因、隐含约束与历史经验是否有原始资料支持，是否误把源码行为推断成业务意图；处理来源冲突、版本和适用范围，删除仅复述代码的内容。发现缺口就更新主题为 pending 并继续调查、修正草稿；核对后再次调用 knowledge_research complete。\n${this.anchor()}`;
    }
    this.state.phase = "complete"; this.persist(); return undefined;
  }
  tool() {
    const source = Type.Object({ repository_id: Type.String(), path: Type.String() });
    const capability = Type.Object({ id: Type.String(), title: Type.String(), repository_ids: Type.Array(Type.String()),
      state: Type.Union([Type.Literal("pending"), Type.Literal("researched"), Type.Literal("blocked")]),
      findings: Type.String(), checks: Type.Optional(Type.Record(Type.String(), Type.String())), evidence_ids: Type.Array(Type.String()),
      sources: Type.Array(source), document_ids: Type.Array(Type.String()) });
    return defineTool({ name: "knowledge_research", label: "记录业务知识研究进度",
      description: "read 列持久主题摘要，id 读取全文，start/count 翻页；upsert 更新独立的业务知识问题（其余保留）。findings 记录代码无法表达的业务事实与原因，evidence_ids 引用实际检索或读取的业务资料编号，sources 仅记录按需核对的源码，可为空；repository_ids 表示适用仓，可为空。资料与问题梳理完成后 inventory_complete。complete 申请最终核对，核对后再次 complete 才完成。blocked 表示实际缺失业务资料或依赖外部回答，不从代码编造业务意图。",
      parameters: Type.Object({ action: Type.Union([Type.Literal("read"), Type.Literal("upsert"), Type.Literal("inventory_complete"), Type.Literal("complete")]), capability: Type.Optional(capability),
        id: Type.Optional(Type.String()), start: Type.Optional(Type.Integer({ minimum: 1 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }),
      execute: async (_id: string, params: { action: string; capability?: DomainResearch["capabilities"][number]; id?: string; start?: number; count?: number }) => {
        try {
          if (this.input.signal.aborted) throw new Error("研究已停止");
          if (params.action === "upsert") {
            const c = params.capability, repos = this.input.job.source_repositories ?? this.input.job.repositories;
            if (!c || !/^[a-zA-Z0-9_-]{1,100}$/.test(c.id) || !c.title.trim()
                || c.repository_ids.some(id => !repos.some(r => r.id === id)) || c.sources.some(s => !c.repository_ids.includes(s.repository_id))
                || JSON.stringify(c).length > 40000) throw new Error("主题编号、归属或内容无效，请填写本次业务范围的知识问题");
            scanForSecrets("业务知识主题研究结论", Buffer.from(JSON.stringify(c)));
            const old = this.state.capabilities.find(row => row.id === c.id);
            if (JSON.stringify(old) !== JSON.stringify(c)) {
              this.state.capabilities = [...this.state.capabilities.filter(row => row.id !== c.id), structuredClone(c)];
              this.state.finish_requested = false; this.changes++;
              if (c.state === "pending") { this.state.phase = "research"; this.reviewed.clear(); }
            }
          } else if (params.action === "inventory_complete") { this.state.inventory_complete = true; }
          else if (params.action === "complete") {
            const gaps = this.gaps(); if (gaps.length) throw new Error(gaps.join("；"));
            this.state.finish_requested = true;
          }
          this.persist();
          const start = Math.max(1, params.start ?? 1), count = Math.min(50, params.count ?? 25), gaps = this.gaps();
          const result = { phase: this.state.phase, inventory_complete: this.state.inventory_complete,
            finish_requested: this.state.finish_requested, total: this.state.capabilities.length,
            researched: this.state.capabilities.filter(c => c.state === "researched").length,
            gaps: gaps.slice(0, 20), remaining_gaps: Math.max(0, gaps.length - 20),
            ...(params.action === "read" ? params.id ? { capability: this.state.capabilities.find(c => c.id === params.id) ?? null }
              : { capabilities: this.state.capabilities.slice(start - 1, start - 1 + count).map(({ id, title, state, repository_ids }) => ({ id, title, state, repository_ids })), next_start: start + count <= this.state.capabilities.length ? start + count : undefined }
              : { saved: params.capability?.id }) };
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: {} };
        } catch (error) { return { content: [{ type: "text" as const, text: String(error) }], details: {}, isError: true }; }
      },
    });
  }
}
