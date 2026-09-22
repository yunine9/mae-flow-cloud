import { readKnowledgeMaterial } from "./knowledgeMaterials.ts";
/** Background research is an inspectable draft, not a task or a delivery gate. */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  componentKey,
  componentRepositories,
  type ComponentRepository,
} from "./componentRepositories.ts";
import { normalizeKnowledgeLanguages } from "./knowledgeLanguages.ts";
import {
  saveKnowledgeDocument,
  readKnowledgeDocument,
  listKnowledgeDocuments,
} from "./knowledgeDocuments.ts";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import { editResearchDocument, researchDocumentMarkdown, sectionReady,
  type ResearchSection, type ResearchDocument, type ResearchDocumentEdit, type ResearchReviewTurn } from "./componentResearchDocument.ts";
export interface ResearchRecord {
  id: string;
  skill?: { name: string; digest: string };
  use_latest_skill?: boolean;
  mode?: "topic" | "all" | "component";
  format?: "joint-document";
  document?: ResearchDocument;
  review_turns?: ResearchReviewTurn[];
  parent_id?: string;
  child_ids?: string[];
  children?: ResearchRecord[];
  progress?: { total: number; done: number; failed: number; cancelled: number; running: number; queued: number; adopted: number };
  component: ComponentRepository;
  components?: ComponentRepository[];
  revisions?: Record<string, string>;
  material_ids?: string[];
  language: string;
  topic: string;
  operator: string;
  key: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  deleted_at?: string;
  deleted_by?: string;
  created_at: string;
  finished_at?: string;
  stage: string;
  revision?: string;
  draft?: string;
  error?: string;
  document_id?: string;
  update_document_id?: string;
  update_document_revision?: string;
  published_revision?: string;
  update_metadata?: { title: string; scope: string; module_ids: string[]; repositories: string[] };
  section_history?: Array<{ at: string; operator: string; section: ResearchSection }>;
  evidence: Array<Record<string, unknown>>;
}
export interface ResearchInput {
  mode?: "topic" | "all";
  component_id?: string;
  language: string;
  topic?: string;
  refresh?: boolean;
  material_ids?: string[];
}
export interface ResearchExecution {
  record: ResearchRecord;
  root: string;
  signal: AbortSignal;
  update: (patch: Partial<ResearchRecord>) => void;
  evidence: (item: Record<string, unknown>) => void;
  review?: ResearchReviewTurn;
  readDocument?: () => ResearchDocument;
  editDocument?: (edit: ResearchDocumentEdit) => ResearchDocument;
}
export class ComponentResearch {
  private records = new Map<string, ResearchRecord>();
  private running = new Map<
    string,
    { controller: AbortController; work: Promise<void> }
  >();
  private stopped = false;
  constructor(
    readonly dir: string,
    private execute: (input: ResearchExecution) => Promise<string>,
    private onAdopt: () => void = () => {},
  ) {
    const root = join(dir, "component-research");
    if (existsSync(root))
      for (const name of readdirSync(root)) {
        if (!/^cr-[a-f0-9-]{36}$/.test(name)) continue;
        const path = join(root, name, "record.json");
        if (!existsSync(path)) continue;
        const record: ResearchRecord = JSON.parse(readFileSync(path, "utf8"));
        this.records.set(record.id, record);
        if ((record.mode !== "all" || record.format === "joint-document") && ["queued", "running"].includes(record.status)) {
          for (const turn of record.review_turns ?? []) if (["queued", "running"].includes(turn.status)) {
            turn.status = "failed"; turn.error = "服务重启中断了本轮，可保留原稿重新发送";
          }
          this.update(record, {
            status: "failed",
            stage: "已中断",
            error: "服务重启中断了萃取，请重新发起",
            finished_at: new Date().toISOString(),
          });
        }
      }
  }
  list(summaryOnly = false) {
    return [...this.records.values()]
      .filter(r => !r.deleted_at && !r.parent_id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((r) =>
        structuredClone(
          summaryOnly ? { ...this.get(r.id), draft: undefined, document: undefined, review_turns: undefined, evidence: [], children: undefined } : this.get(r.id),
        ),
      );
  }
  get(id: string) {
    const r = this.records.get(id);
    if (!r) throw new Error("萃取记录不存在");
    if (r.mode === "all" && r.format !== "joint-document") {
      const children = (r.child_ids ?? []).map(id => this.records.get(id)).filter((c): c is ResearchRecord => !!c);
      const progress = { total: r.child_ids?.length ?? 0, done: 0, failed: 0, cancelled: 0, running: 0, queued: 0, adopted: 0 };
      for (const child of children) { progress[child.status]++; if (child.document_id) progress.adopted++; }
      progress.failed += progress.total - children.length;
      const active = progress.running + progress.queued;
      const status = active ? (progress.running ? "running" : "queued")
        : progress.failed ? "failed" : progress.cancelled ? "cancelled" : "done";
      return structuredClone({ ...r, status, progress,
        stage: `已完成 ${progress.done}/${progress.total} 个组件${progress.failed ? `，${progress.failed} 个失败` : ""}${progress.cancelled ? `，${progress.cancelled} 个已停止` : ""}`,
        children: children.map(c => ({ ...c, draft: undefined, evidence: [] })),
      } satisfies ResearchRecord);
    }
    return structuredClone(r);
  }
  start(input: ResearchInput, operator: string) {
    if (this.stopped) throw new Error("服务正在停止");
    const material_ids = [...new Set(input.material_ids ?? [])];
    if (material_ids.length > 30 || material_ids.reduce((bytes, id) => bytes + readKnowledgeMaterial(join(this.dir, "knowledge-materials"), id).bytes, 0) > 100 * 1024 * 1024) throw new Error("最多关联 30 份资料，总容量 100 MiB");
    const language = normalizeKnowledgeLanguages([input.language])[0];
    const components = componentRepositories(this.dir).filter(c => c.enabled && c.languages.includes(language));
    if (!components.length) throw new Error("请先在配置中心启用该语言的基础组件仓");
    if (input.mode && !["all", "topic"].includes(input.mode)) throw new Error("不支持的萃取方式");
    if (input.mode === "all") return this.startAll(components, language, operator, input.refresh, material_ids);
    const component = components[0]; // Legacy records retain their single component; new jobs cover the language registry.
    const topic = String(input.topic ?? "").trim();
    if (!topic || topic.length > 1000)
      throw new Error("请填写具体萃取主题，最多 1000 字");
    const key = JSON.stringify([
      components.map(componentKey).sort(),
      language,
      topic.replace(/\s+/g, " ").toLowerCase(), material_ids,
    ]);
    const previous = [...this.records.values()]
      .reverse()
      .find(
        (r) =>
          r.key === key && r.operator === operator && !r.deleted_at && !["failed", "cancelled"].includes(r.status),
      );
    if (previous && (!input.refresh || previous.status !== "done"))
      return structuredClone(previous);
    if (
      [...this.records.values()].filter((r) => r.mode !== "all" && r.status === "queued").length >=
      50
    )
      throw new Error("待萃取队列已满，请稍后再试");
    const record: ResearchRecord = {
      id: `cr-${randomUUID()}`,
      component,
      components,
      material_ids,
      language,
      topic,
      operator,
      key,
      status: "queued",
      created_at: new Date().toISOString(),
      stage: "等待萃取",
      evidence: [],
    };
    this.records.set(record.id, record);
    this.update(record, {});
    this.pump();
    return this.get(record.id);
  }
  private componentJob(component: ComponentRepository, parent: ResearchRecord): ResearchRecord {
    return { id: `cr-${randomUUID()}`, mode: "component", parent_id: parent.id,
      component, components: [component], language: parent.language,
      topic: `${component.name} · 开发范式`, operator: parent.operator,
      key: `${parent.key}:${componentKey(component)}`, status: "queued",
      created_at: new Date().toISOString(), stage: "等待自动分析组件", evidence: [] };
  }
  private startAll(components: ComponentRepository[], language: string, operator: string, refresh = false, material_ids: string[] = []) {
    const key = JSON.stringify(["joint-document", language, components.map(componentKey).sort(), material_ids]);
    const previous = [...this.records.values()].reverse().find(r => r.mode === "all" && r.key === key && r.operator === operator && !r.deleted_at);
    if (previous && (!refresh || ["queued", "running"].includes(this.get(previous.id).status))) return this.get(previous.id);
    const parent: ResearchRecord = { id: `cr-${randomUUID()}`, mode: "all", component: components[0], components, material_ids,
      language, topic: "基础组件联合使用指南", operator, key, status: "queued", created_at: new Date().toISOString(),
      format: "joint-document", document: { overview: "", sections: [] }, review_turns: [],
      stage: "等待跨仓联合萃取", evidence: [] };
    this.records.set(parent.id, parent); this.update(parent, {});
    this.pump();
    return this.get(parent.id);
  }
  private root(id: string) {
    return join(this.dir, "component-research", id);
  }
  private update(record: ResearchRecord, patch: Partial<ResearchRecord>) {
    Object.assign(record, patch);
    const root = this.root(record.id);
    mkdirSync(root, { recursive: true });
    const path = join(root, "record.json");
    writeFileSync(path + ".tmp", JSON.stringify(record), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  }
  private pump() {
    if (this.stopped) return;
    for (const record of this.records.values()) {
      if (this.running.size >= 2) break;
      if ((record.mode === "all" && record.format !== "joint-document") || record.status !== "queued" || this.running.has(record.id)) continue;
      const controller = new AbortController();
      const review = record.review_turns?.find(turn => turn.status === "queued");
      if (review) review.status = "running";
      const previousDocument = record.document ? structuredClone(record.document) : undefined;
      let revisedDocument = previousDocument;
      this.update(record, { status: "running", error: undefined, stage: review ? (review.mode === "discuss" ? "正在回答组件问题" : "正在返工指定组件") : "准备组件源码" });
      // Defer execution until the running entry exists (also handles synchronous failures).
      const work = Promise.resolve()
        .then(async () => {
          try {
            const draft = await this.execute({
              record: structuredClone(record),
              root: this.root(record.id),
              signal: controller.signal,
              review: review ? structuredClone(review) : undefined,
              ...(record.document ? {
                readDocument: () => structuredClone(review ? revisedDocument! : record.document!),
                editDocument: (edit: ResearchDocumentEdit) => {
                  if (controller.signal.aborted || record.deleted_at || record.status !== "running") throw new Error("本轮已停止，未修改草稿");
                  const document = editResearchDocument(review ? revisedDocument! : record.document!, edit, (record.components ?? [record.component]).map(c => c.id), review);
                  if (review) revisedDocument = document;
                  else this.update(record, { document, draft: researchDocumentMarkdown(record.topic, document) });
                  return structuredClone(document);
                },
              } : {}),
              update: (patch) => { if (!record.deleted_at && record.status !== "cancelled") { if (patch.skill && review) review.skill = patch.skill; this.update(record, patch); } },
              evidence: (item) => {
                if (record.deleted_at || record.status === "cancelled" || controller.signal.aborted) return;
                record.evidence.push({ at: new Date().toISOString(), ...item });
                this.update(record, {});
              },
            });
            if (record.deleted_at || record.status === "cancelled") return;
            if (controller.signal.aborted) throw new Error("萃取已停止");
            if (!draft.trim()) throw new Error("模型未产出草稿");
            scanForSecrets("组件知识草稿.md", Buffer.from(draft));
            if (review) {
              if (review.mode === "rework" && revisedDocument?.sections.find(s => s.id === review.section_id)?.revision
                  === previousDocument?.sections.find(s => s.id === review.section_id)?.revision) {
                throw new Error("本轮没有更新指定组件，原稿已保留；请继续说明返工要求");
              }
              if (review.mode !== "discuss" && revisedDocument!.sections.find(s => s.id === review.section_id)!.revision !== previousDocument!.sections.find(s => s.id === review.section_id)!.revision) {
                review.proposal = { base_revision: previousDocument!.sections.find(s => s.id === review.section_id)!.revision,
                  section: structuredClone(revisedDocument!.sections.find(s => s.id === review.section_id)!), status: "pending" };
              }
              review.status = "done"; review.reply = draft; review.finished_at = new Date().toISOString();
            } else if (record.document && (!record.document.overview.trim() || !record.document.sections.length
                || record.document.sections.some(section => !sectionReady(section)))) {
              throw new Error("联合草稿尚不完整：需要跨仓关系说明，以及每项组件的接口、集成依赖、最佳示例和来源；已写内容保留，可继续研究");
            }
            this.update(record, {
              status: "done",
              stage: review ? "本轮已完成，等待专家继续审查" : "草稿待审查",
              draft: record.document ? researchDocumentMarkdown(record.topic, record.document) : draft,
              finished_at: new Date().toISOString(),
            });
          } catch (error) {
            if (record.deleted_at || record.status === "cancelled") return;
            if (review) {
              review.status = "failed"; review.error = error instanceof Error ? error.message : "本轮失败";
              review.finished_at = new Date().toISOString();
              // 返工失败不能把半份修订覆盖专家原稿。
              record.draft = researchDocumentMarkdown(record.topic, record.document!);
            }
            this.update(record, {
              status: "failed",
              stage: "萃取失败",
              error: error instanceof Error ? error.message : "萃取失败",
              finished_at: new Date().toISOString(),
            });
          }
        })
        .finally(() => {
          this.running.delete(record.id);
          this.pump();
        });
      this.running.set(record.id, { controller, work });
    }
  }
  stop(id: string) {
    const record = this.records.get(id);
    if (!record || record.deleted_at) throw new Error("萃取任务不存在");
    if (record.mode === "all" && record.format !== "joint-document") {
      for (const child of record.child_ids ?? []) if (this.records.has(child)) this.stop(child);
      return this.get(id);
    }
    if (["queued", "running"].includes(record.status)) {
      for (const turn of record.review_turns ?? []) if (["queued", "running"].includes(turn.status)) turn.status = "cancelled";
      this.update(record, {status:"cancelled", stage:"已停止", finished_at:new Date().toISOString()});
      this.running.get(id)?.controller.abort();
    }
    return this.get(id);
  }
  remove(id: string, operator: string) {
    if (this.records.get(id)?.parent_id) throw new Error("请在全部组件任务中删除整批记录；可单独停止或重试组件");
    this.stop(id);
    const record = this.records.get(id)!;
    for (const child of record.child_ids ?? []) {
      const r = this.records.get(child);
      if (r) this.update(r, {deleted_at:new Date().toISOString(), deleted_by:operator});
    }
    // Preserve provenance of adopted knowledge; hide the task from management lists.
    this.update(record, {deleted_at:new Date().toISOString(), deleted_by:operator});
    return { deleted: true };
  }
  retry(id: string, operator: string) {
    if (this.stopped) throw new Error("服务正在停止");
    const record = this.get(id);
    if (record.deleted_at) throw new Error("萃取任务已删除");
    if (record.format === "joint-document") {
      if (["queued", "running"].includes(record.status)) return record;
      if (record.document_id) throw new Error("已采纳的草稿保留原样；请新建联合萃取任务");
      if (this.running.has(id)) throw new Error("上一轮正在停止，请稍后重试");
      const lastTurn = record.review_turns?.at(-1);
      if (lastTurn && ["failed", "cancelled"].includes(lastTurn.status)) {
        return this.review(id, { section_id: lastTurn.section_id, mode: lastTurn.mode, message: lastTurn.message }, operator);
      }
      const live = this.records.get(id)!;
      this.update(live, { status: "queued", error: undefined, finished_at: undefined, stage: "继续联合研究，保留已有组件" });
      this.pump(); return this.get(id);
    }
    if (record.mode === "all") {
      if (record.status === "done") return this.start({ mode: "all", language: record.language, refresh: true }, operator);
      for (const child of record.children ?? []) if (["failed", "cancelled"].includes(child.status)) this.retry(child.id, operator);
      return this.get(id);
    }
    if (record.parent_id) {
      if (["queued", "running"].includes(record.status)) return record;
      const parent = this.records.get(record.parent_id);
      if (!parent || parent.deleted_at) throw new Error("萃取任务已删除");
      if (!parent.child_ids?.includes(id)) throw new Error("该组件已重新萃取，请查看最新记录");
      const next = this.componentJob(record.component, parent);
      next.operator = operator;
      this.records.set(next.id, next); this.update(next, {});
      this.update(parent, { child_ids: parent.child_ids.map(child => child === id ? next.id : child) });
      this.pump();
      return this.get(next.id);
    }
    return this.start({language:record.language, topic:record.topic, refresh:true}, operator);
  }
  selectSections(id: string, ids: string[], selected: boolean) {
    const record = this.records.get(id);
    if (!record?.document || record.deleted_at || record.document_id) throw new Error("当前草稿不可修改");
    if (["queued", "running"].includes(record.status)) throw new Error("请等待本轮完成再调整采纳清单");
    if (!Array.isArray(ids) || !ids.length || typeof selected !== "boolean"
        || ids.some(id => !record.document!.sections.some(section => section.id === id))) throw new Error("请指定有效的组件清单与勾选状态");
    for (const section of record.document.sections) if (ids.includes(section.id)) section.selected = selected;
    this.update(record, {}); return this.get(id);
  }
  review(id: string, input: { section_id: string; mode: "discuss" | "rework" | "update"; message: string; use_latest_skill?: boolean; material_ids?: string[] }, operator: string) {
    if (this.stopped) throw new Error("服务正在停止");
    const record = this.records.get(id);
    if (!record?.document || record.deleted_at || record.document_id) throw new Error("当前草稿不可讨论或返工");
    if (this.running.has(id) || ["queued", "running"].includes(record.status)) throw new Error("请等待本轮完成或停止后再继续对话");
    if (!record.document.sections.some(section => section.id === input.section_id)) throw new Error("请先选择要讨论或返工的组件");
    const message = String(input.message ?? "").trim();
    if (!["discuss", "rework", "update"].includes(input.mode) || !message || message.length > 20_000) throw new Error("请填写讨论或返工要求，最多 20000 字");
    scanForSecrets("专家讨论", Buffer.from(message));
    if (input.material_ids) {
      if (!Array.isArray(input.material_ids) || input.material_ids.length > 30 || input.material_ids.some(id => typeof id !== "string")) throw new Error("最多关联 30 份资料");
      const ids = [...new Set(input.material_ids)];
      if (ids.reduce((bytes, id) => bytes + readKnowledgeMaterial(join(this.dir, "knowledge-materials"), id).bytes, 0) > 100 * 1024 * 1024) throw new Error("资料总容量不能超过 100 MiB");
      record.material_ids = ids;
    }
    record.review_turns ??= [];
    record.review_turns.push({ id: `review-${randomUUID()}`, section_id: input.section_id,
      mode: input.mode, message, operator, status: "queued", created_at: new Date().toISOString(),
      ...(input.mode === "update" ? { previous_revisions: { ...record.revisions } } : {}) });
    if (input.mode === "update") record.revisions = {};
    this.update(record, { use_latest_skill: input.use_latest_skill === true, status: "queued", stage: input.mode === "discuss" ? "等待回答组件问题" : "等待指定组件返工", error: undefined, finished_at: undefined });
    this.pump(); return this.get(id);
  }
  editSection(id: string, input: { section: ResearchSection; base_revision: number }, operator: string) {
    const record = this.records.get(id), section = record?.document?.sections.find(s => s.id === input.section?.id);
    if (!record?.document || record.deleted_at || record.document_id || !section) throw new Error("当前章节不可修改");
    if (["queued", "running"].includes(record.status) && !record.review_turns?.some(t => ["queued", "running"].includes(t.status))) throw new Error("首次萃取正在写入，请等待完成");
    if (section.revision !== input.base_revision) throw new Error("章节已有新版本，请比较后重新保存");
    const document = editResearchDocument(record.document, { action: "section", section: input.section }, (record.components ?? [record.component]).map(c => c.id));
    record.section_history ??= [];
    record.section_history.push({ at: new Date().toISOString(), operator, section: structuredClone(section) });
    this.update(record, { document, draft: researchDocumentMarkdown(record.topic, document) });
    return this.get(id);
  }
  decideProposal(id: string, turnId: string, decision: "accept" | "discard", operator: string) {
    const record = this.records.get(id), turn = record?.review_turns?.find(t => t.id === turnId);
    if (!record || record.deleted_at || record.document_id || !turn?.proposal) throw new Error("修订建议不存在或草稿已归档");
    if (!["accept", "discard"].includes(decision)) throw new Error("请选择采纳或放弃");
    if (turn.proposal.status !== "pending") return this.get(id);
    if (decision === "accept") this.editSection(id, { section: turn.proposal.section, base_revision: turn.proposal.base_revision }, operator);
    turn.proposal.status = decision === "accept" ? "accepted" : "discarded";
    this.update(record, {}); return this.get(id);
  }
  restoreSection(id: string, sectionId: string, revision: number, baseRevision: number, operator: string) {
    const previous = this.records.get(id)?.section_history?.find(h => h.section.id === sectionId && h.section.revision === revision);
    if (!previous) throw new Error("未找到该历史版本");
    return this.editSection(id, { section: previous.section, base_revision: baseRevision }, operator);
  }
  beginUpdate(id: string, operator: string) {
    const record = this.records.get(id);
    if (!record?.document || !record.document_id || record.deleted_at) throw new Error("请选择已入库的联合文档");
    const published = readKnowledgeDocument(this.dir, record.document_id);
    if (!published.source && (record.published_revision ? published.revision !== record.published_revision : published.content !== researchDocumentMarkdown(published.title, record.document, true))) throw new Error("正式文档已由其他入口修改，请先核对当前文档，避免覆盖人工更新");
    this.update(record, { update_document_id: record.document_id, update_document_revision: published.revision,
      document_id: undefined, update_metadata: { title: published.title, scope: published.scope, module_ids: published.module_ids, repositories: published.repositories }, stage: "选择受影响章节，生成更新建议", operator });
    return this.get(id);
  }
  markdown(id: string) {
    const record = this.get(id);
    if (record.deleted_at) throw new Error("萃取任务已删除");
    return record.document ? researchDocumentMarkdown(record.topic, record.document, true) : record.draft ?? "";
  }
  archiveDraft(id: string, input: { title?: string; content?: string }) {
    const record = this.get(id);
    if (record.deleted_at || record.status !== "done" || (record.mode === "all" && record.format !== "joint-document")) throw new Error("请等待组件草稿完成后归档");
    if (record.document && (!record.document.sections.some(s => s.selected) || record.document.sections.some(s => s.selected && !sectionReady(s)))) throw new Error("请选择至少一个已完成且含最佳示例的组件");
    const title = String(input.title ?? record.topic).trim();
    const content = record.document ? researchDocumentMarkdown(title, record.document, true) : String(input.content ?? record.draft ?? "");
    return { research_id: id, title, content, language: record.language,
      sources: (record.components ?? [record.component]).map(c => `${c.name}：${c.repository} · ${c.branch} · ${c.path || "全仓"} @ ${record.revisions?.[c.id] ?? record.revision ?? "版本未记录"}`).join("\n") };
  }
  adopt(id: string, input: Record<string, unknown>, operator: string) {
    const record = this.records.get(id);
    if (!record || (record.mode === "all" && record.format !== "joint-document") || record.deleted_at || record.status !== "done") throw new Error("请等待组件草稿生成后采纳");
    if (record.document_id)
      return readKnowledgeDocument(this.dir, record.document_id);
    if (record.document && (!record.document.sections.some(s => s.selected)
        || record.document.sections.some(s => s.selected && !sectionReady(s)))) throw new Error("请选择至少一个已完成且含最佳示例的组件");
    if (listKnowledgeDocuments(this.dir).some(doc => doc.source && doc.research_source?.job_id === id)) throw new Error("该组件知识已由 Git 归档管理，请通过提交到代码仓更新 MR");
    const content = record.document ? researchDocumentMarkdown(String(input.title ?? record.topic), record.document, true)
      : String(input.content ?? record.draft ?? "");
    scanForSecrets("组件知识.md", Buffer.from(content));
    const previous = record.update_document_id ? readKnowledgeDocument(this.dir, record.update_document_id) : undefined;
    if (previous && previous.revision !== record.update_document_revision) throw new Error("正式文档已发生变化，请先比较最新版本，未覆盖他人修改");
    const document = saveKnowledgeDocument(
      this.dir,
      {
        ...previous,
        ...input,
        title:
          input.title ??
          `${record.language} · ${record.topic}`.slice(0, 160),
        content,
        technologies: [record.language],
        research_source: {
          job_id: id,
          repository: record.component.repository,
          branch: record.component.branch,
          path: record.component.path,
          revision: record.revision,
          components: record.components?.map(c => ({id:c.id, repository:c.repository, branch:c.branch, path:c.path, revision:record.revisions?.[c.id]})),
        },
        when_to_use:
          input.when_to_use ??
          `${record.language} / ${record.topic}`,
        active: true,
      },
      operator,
      record.update_document_id,
      record.document ? { maxContentBytes: 16 * 1024 * 1024 } : {},
    );
    this.update(record, { document_id: document.id, published_revision: document.revision, stage: "已采纳为知识" });
    this.onAdopt();
    return document;
  }
  async shutdown() {
    this.stopped = true;
    for (const r of this.records.values())
      if ((r.mode !== "all" || r.format === "joint-document") && r.status === "queued")
        this.update(r, {
          status: "failed",
          stage: "已中断",
          error: "服务停止，请重新发起",
        });
    for (const r of this.running.values()) r.controller.abort();
    await Promise.allSettled([...this.running.values()].map((r) => r.work));
  }
}
