import { projectKnowledgeProduction } from "./knowledgeProductionState.ts";
import { componentKnowledgeMarkdown } from "./componentKnowledgeMarkdown.ts";
import { exportComponentArtifacts, validateComponentParadigm } from "./componentParadigms.ts";
import type { ComponentPipelineState } from "./componentResearchPipeline.ts";
/** Background research is an inspectable draft, not a task or a delivery gate. */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { durableWriteFileSync } from "./durableWrite.ts";
import {
  componentKey,
  componentRepositories,
  type ComponentRepository,
} from "./componentRepositories.ts";
import { normalizeKnowledgeLanguages } from "./knowledgeLanguages.ts";
import {
  saveKnowledgeDocument,
  readKnowledgeDocument,
  readKnowledgeDocumentVersion,
  prepareKnowledgeDocument,
  writePreparedKnowledgeDocument,
  type PreparedKnowledgeDocument,
} from "./knowledgeDocuments.ts";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import { editResearchDocument, researchDocumentMarkdown, sectionReady,
  type ResearchSection, type ResearchDocument, type ResearchDocumentEdit, type ResearchReviewTurn } from "./componentResearchDocument.ts";
export interface ComponentChallenge {
  item_id: string; source_digest: string; language: string; repository_ids: string[]; claim: string;
}
export interface ResearchRecord {
  /** 服务端读取时计算，不写入 record.json。 */
  production?: import("./knowledgeProductionTypes").KnowledgeProductionView;
  /** 一次发布的耐久意图；正式库和文稿提交后清除。 */
  publication_intent?: ComponentPublicationIntent;
  challenge?: ComponentChallenge;
  id: string;
  pipeline?: ComponentPipelineState;
  skill?: { name: string; digest: string };
  use_latest_skill?: boolean;
  mode?: "topic" | "all";
  format?: "joint-document";
  document?: ResearchDocument;
  review_turns?: ResearchReviewTurn[];
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
export interface ComponentPublicationIntent {
  formal: PreparedKnowledgeDocument;
  record: Omit<ResearchRecord, "production" | "publication_intent">;
}
export interface ComponentPublishInput extends Record<string, unknown> {
  sections: Array<{ id: string; revision: number; proposal_id: string | null }>;
  document_id: string | null;
  update_document_id: string | null;
  update_document_revision?: string;
  title: string;
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

const stopBudgetMs = 60_000;
const stopTimeoutReason = "停止超时：执行体 60 秒内未退出，已强制释放";
const recordStatuses = ["queued", "running", "done", "failed", "cancelled"];
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const fields = (value: Record<string, any>, names: string[]) => names.every(name => typeof value[name] === "string");
const optionalStrings = (value: Record<string, any>, names: string[]) => names.every(name => value[name] === undefined || typeof value[name] === "string");
const revisions = (value: unknown) => object(value) && Object.values(value).every(revision => typeof revision === "string");
const skill = (value: unknown) => object(value) && fields(value, ["name", "digest"]);
function validComponent(value: unknown): boolean {
  return object(value) && fields(value, ["id", "name", "repository", "branch", "path", "description"])
    && strings(value.languages) && typeof value.enabled === "boolean";
}
function validSection(value: unknown, repositoryIds: string[]): boolean {
  const valid = object(value) && fields(value, ["id", "title", "content", "interfaces", "integration", "example", "sources"])
    && strings(value.repository_ids) && strings(value.related_ids) && typeof value.selected === "boolean"
    && Number.isSafeInteger(value.revision) && value.revision >= 0 && (value.paradigm === undefined || object(value.paradigm));
  if (valid && object(value) && value.paradigm) validateComponentParadigm(value.paradigm, repositoryIds);
  return valid;
}
function validReviewTurn(value: unknown, repositoryIds: string[]): boolean {
  return object(value) && fields(value, ["id", "section_id", "message", "operator", "created_at"])
    && ["discuss", "rework", "update"].includes(value.mode) && recordStatuses.includes(value.status)
    && optionalStrings(value, ["reply", "error", "finished_at"])
    && (value.skill === undefined || skill(value.skill))
    && (value.previous_revisions === undefined || revisions(value.previous_revisions))
    && (value.base_revision === undefined || Number.isSafeInteger(value.base_revision))
    && (value.proposal === undefined || (object(value.proposal) && ["pending", "accepted", "discarded"].includes(value.proposal.status)
      && Number.isSafeInteger(value.proposal.base_revision) && validSection(value.proposal.section, repositoryIds)));
}
function validPipeline(value: unknown): boolean {
  return object(value) && value.version === 1 && typeof value.skill === "string" && Array.isArray(value.tasks)
    && value.tasks.every(task => object(task) && fields(task, ["id", "title", "spec"])
      && ["inventory", "plan", "contracts", "paradigm", "pitfalls", "index", "synthesis"].includes(task.phase)
      && ["pending", "running", "done", "failed"].includes(task.status) && strings(task.dependencies)
      && Number.isSafeInteger(task.attempts) && task.attempts >= 0 && optionalStrings(task, ["component", "feedback"])
      && (task.result === undefined || (object(task.result) && typeof task.result.findings === "string" && strings(task.result.open_questions)
        && (task.result.components === undefined || (Array.isArray(task.result.components) && task.result.components.every(component => object(component)
          && fields(component, ["id", "title", "scope"]) && strings(component.repository_ids))))
        && (task.result.paradigms === undefined || (Array.isArray(task.result.paradigms) && task.result.paradigms.every(paradigm => object(paradigm)
          && fields(paradigm, ["id", "title", "need"])))))));
}
function validResearchRecord(value: unknown, id: string): value is ResearchRecord {
  const components = object(value) ? value.components ?? [value.component] : [];
  const repositoryIds: string[] = Array.isArray(components) ? components.filter(object).map(component => component.id).filter(id => typeof id === "string") : [];
  return object(value) && value.id === id && fields(value, ["id", "language", "topic", "operator", "key", "created_at", "stage"])
    && optionalStrings(value, ["deleted_at", "deleted_by", "finished_at", "revision", "draft", "error", "document_id", "update_document_id", "update_document_revision", "published_revision"])
    && (value.mode === undefined || ["topic", "all"].includes(value.mode)) && (value.format === undefined || value.format === "joint-document")
    && (value.use_latest_skill === undefined || typeof value.use_latest_skill === "boolean")
    && (value.skill === undefined || skill(value.skill))
    && recordStatuses.includes(value.status) && validComponent(value.component)
    && (value.components === undefined || (Array.isArray(value.components) && value.components.every(validComponent)))
    && Array.isArray(value.evidence) && value.evidence.every(object)
    && (value.revisions === undefined || revisions(value.revisions))
    && (value.material_ids === undefined || strings(value.material_ids))
    && (value.document === undefined || (object(value.document) && typeof value.document.overview === "string"
      && Array.isArray(value.document.sections) && value.document.sections.every(section => validSection(section, repositoryIds))))
    && (value.review_turns === undefined || (Array.isArray(value.review_turns) && value.review_turns.every(turn => validReviewTurn(turn, repositoryIds))))
    && (value.review_turns === undefined || value.review_turns.every(turn => !["queued", "running"].includes(turn.status)
      || (value.document !== undefined && value.document.sections.some(section => section.id === turn.section_id))))
    && (value.section_history === undefined || (Array.isArray(value.section_history) && value.section_history.every(history => object(history)
      && fields(history, ["at", "operator"]) && validSection(history.section, repositoryIds))))
    && (value.pipeline === undefined || validPipeline(value.pipeline))
    && (value.update_metadata === undefined || (object(value.update_metadata) && fields(value.update_metadata, ["title", "scope"])
      && strings(value.update_metadata.module_ids) && strings(value.update_metadata.repositories)))
    && (value.challenge === undefined || (object(value.challenge) && fields(value.challenge, ["item_id", "source_digest", "language", "claim"]) && strings(value.challenge.repository_ids)))
    && (value.publication_intent === undefined || validPublicationIntent(value.publication_intent, id));
}
function validPublicationIntent(value: unknown, id: string): value is ComponentPublicationIntent {
  if (!object(value) || !object(value.formal) || !object(value.formal.document) || !object(value.record)) return false;
  const formal = value.formal.document;
  const location = (value: unknown, names: string[]) => value === undefined || object(value) && fields(value, names);
  return /^kd-[a-f0-9-]{36}$/.test(formal.id) && fields(formal, ["id", "title", "content", "when_to_use", "revision"])
    && /^[a-f0-9]{64}$/.test(formal.revision) && ["platform", "module", "repository"].includes(formal.scope) && typeof formal.active === "boolean"
    && [formal.module_ids, formal.repositories, formal.technologies, formal.product_versions].every(strings)
    && Array.isArray(formal.history) && formal.history.length > 0 && formal.history.every(history => object(history)
      && fields(history, ["at", "operator", "action"]) && Number.isFinite(Date.parse(history.at)) && optionalStrings(history, ["revision"]))
    && location(formal.source, ["repository", "branch", "path", "revision"]) && location(formal.archive_target, ["repository", "branch", "path"])
    && location(formal.research_source, ["job_id", "repository", "branch", "path"])
    && (value.formal.previous_revision === null || typeof value.formal.previous_revision === "string" && /^[a-f0-9]{64}$/.test(value.formal.previous_revision))
    && typeof value.formal.unchanged === "boolean"
    && value.record.production === undefined && value.record.publication_intent === undefined && validResearchRecord(value.record, id)
    && value.record.status === "done" && value.record.document_id === formal.id && value.record.published_revision === formal.revision;
}
interface RunningResearch {
  controller: AbortController;
  work: Promise<void>;
  released: Promise<void>;
  release: () => void;
  stopTimer?: ReturnType<typeof setTimeout>;
  review?: ResearchReviewTurn;
}
export class ComponentResearch {
  private records = new Map<string, ResearchRecord>();
  private running = new Map<string, RunningResearch>();
  private readWarnings: string[] = [];
  private stopped = false;
  constructor(
    readonly dir: string,
    private execute: (input: ResearchExecution) => Promise<string>,
    private onAdopt: () => void = () => {},
    private archiveFor: (id: string) => import("./domainKnowledgeTypes.ts").DomainKnowledgeJob | undefined = () => undefined,
  ) {
    const root = join(dir, "component-research");
    if (existsSync(root))
      for (const name of readdirSync(root)) {
        if (!/^cr-[a-f0-9-]{36}$/.test(name)) continue;
        const path = join(root, name, "record.json");
        if (!existsSync(path)) continue;
        try {
          const record: unknown = JSON.parse(readFileSync(path, "utf8"));
          if (!validResearchRecord(record, name)) throw new Error("组件研究记录格式无效");
          if (!record.deleted_at && ["queued", "running"].includes(record.status)) {
            for (const turn of record.review_turns ?? []) if (["queued", "running"].includes(turn.status)) {
              turn.status = "queued"; turn.error = undefined;
            }
            this.update(record, {
              status: "queued",
              stage: "接续原研究会话",
              error: undefined,
              finished_at: undefined,
            });
          }
          this.records.set(record.id, record);
        } catch {
          this.readWarnings.push(`记录损坏或无法读取：component-research/${name}/record.json`);
        }
      }
    queueMicrotask(() => this.pump());
  }
  warnings(): string[] { return [...this.readWarnings]; }
  list(summaryOnly = false) {
    return [...this.records.values()]
      .filter(r => !r.deleted_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((r) =>
        structuredClone(
          summaryOnly ? { ...this.get(r.id), draft: undefined, document: undefined, review_turns: undefined, evidence: [] } : this.get(r.id),
        ),
      );
  }
  get(id: string): ResearchRecord {
    const r = this.records.get(id);
    if (!r) throw new Error("萃取记录不存在");
    let record = structuredClone(r);
    if (r.publication_intent) {
      // 意图不能代替正式事实；只有真实文件已提交精确版本，才显示已接受文稿和入库状态。
      try {
        const formal = readKnowledgeDocument(this.dir, r.publication_intent.formal.document.id);
        if (formal.revision === r.publication_intent.formal.document.revision) record = {
          ...structuredClone(r.publication_intent.record), deleted_at: r.deleted_at, deleted_by: r.deleted_by,
          publication_intent: structuredClone(r.publication_intent),
        };
      } catch { /* 正式文件缺失、损坏或已删除时保留原文稿，任务中心会点名坏文件。 */ }
    }
    const formalId = record.document_id ?? record.update_document_id;
    const current_revisions: Record<string, string> = {};
    if (formalId) {
      try { current_revisions[formalId] = readKnowledgeDocument(this.dir, formalId).revision; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof Error && error.message === "知识已删除")) {
          const warning = `请检查知识记录：knowledge-documents/${formalId}.json；${error instanceof Error ? error.message : String(error)}`;
          if (!this.readWarnings.includes(warning)) this.readWarnings.push(warning);
        }
      }
    }
    return { ...record, production: projectKnowledgeProduction({ kind: "component", record, archive: this.archiveFor(id), current_revisions }) };
  }
  private assertPublicationComplete(record?: ResearchRecord) {
    if (record?.publication_intent) throw new Error("发布还未完成，请重试发布，或显式开始新修订");
  }
  start(input: ResearchInput, operator: string) {
    if (this.stopped) throw new Error("服务正在停止");
    if (input.material_ids !== undefined && (!Array.isArray(input.material_ids) || input.material_ids.length)) throw new Error("组件萃取仅使用基础仓代码与 everycode，不接收上传资料");
    const material_ids: string[] = [];
    const language = normalizeKnowledgeLanguages([input.language])[0];
    const components = componentRepositories(this.dir).filter(c => c.enabled && c.languages.includes(language));
    if (!components.length) throw new Error("请先在配置中心启用该语言的基础组件仓");
    if (input.mode && !["all", "topic"].includes(input.mode)) throw new Error("不支持的萃取方式");
    if (input.mode === "all") return this.startAll(components, language, operator, input.refresh, material_ids);
    const component = components[0];
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
      return this.get(previous.id);
    if (
      [...this.records.values()].filter((r) => r.status === "queued").length >=
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
  startChallenge(challenge: ComponentChallenge, operator: string) {
    if (this.stopped) throw new Error("服务正在停止");
    const existing = [...this.records.values()].find(r => !r.deleted_at && r.challenge?.item_id === challenge.item_id
      && r.challenge.source_digest === challenge.source_digest && ["queued", "running"].includes(r.status));
    if (existing) return this.get(existing.id);
    const components = componentRepositories(this.dir).filter(c => c.enabled && challenge.repository_ids.includes(c.id));
    if (!components.length) throw new Error("反例研究需要源文档对应的基础仓配置，请先恢复该组件仓配置");
    if ([...this.records.values()].filter(r => r.status === "queued").length >= 50) throw new Error("研究队列已满，请稍后再试");
    const record: ResearchRecord = { id: `cr-${randomUUID()}`, challenge, component: components[0], components,
      language: challenge.language, topic: "组件规则反例研究", operator, key: JSON.stringify(challenge), status: "queued",
      created_at: new Date().toISOString(), stage: "等待独立反例研究", evidence: [] };
    this.records.set(record.id, record); this.update(record, {}); this.pump(); return this.get(record.id);
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
    durableWriteFileSync(path, JSON.stringify(record), { mode: 0o600 });
  }
  private pump() {
    if (this.stopped) return;
    for (const record of this.records.values()) {
      if (this.running.size >= 2) break;
      if (record.deleted_at || record.status !== "queued" || this.running.has(record.id)) continue;
      const controller = new AbortController();
      const review = record.review_turns?.find(turn => turn.status === "queued");
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      const entry: RunningResearch = { controller, work: Promise.resolve(), released, release, review };
      if (review) review.status = "running";
      const previousDocument = record.document ? structuredClone(record.document) : undefined;
      if (review) review.base_revision ??= review.proposal?.base_revision ?? previousDocument?.sections.find(section => section.id === review.section_id)?.revision;
      let revisedDocument = previousDocument;
      if (review && revisedDocument) {
        const earlierTurns = record.review_turns!.slice(0, record.review_turns!.indexOf(review)).reverse();
        revisedDocument = { ...revisedDocument, sections: revisedDocument.sections.map(section => {
          const resumed = section.id === review.section_id && review.proposal?.status === "pending" && review.proposal.base_revision === section.revision ? review.proposal : undefined;
          const previous = earlierTurns.find(previous => previous.status === "done" && previous.section_id === section.id && previous.proposal?.status === "pending" && previous.proposal.base_revision === section.revision);
          const proposal = resumed ?? previous?.proposal;
          // 接着已完成的候选稿修改，原章节版本与选择状态保留到确认时。
          return proposal ? { ...structuredClone(proposal.section), revision: section.revision, selected: section.selected } : section;
        }) };
      }
      this.update(record, { status: "running", error: undefined, stage: review ? (review.mode === "discuss" ? "正在回答组件问题" : "正在返工指定组件") : "准备组件源码" });
      // Defer execution until the running entry exists (also handles synchronous failures).
      const work = Promise.resolve()
        .then(async () => {
          try {
            const draft = await this.execute({
              record: { ...structuredClone(record), ...(review && revisedDocument ? { document: structuredClone(revisedDocument), draft: researchDocumentMarkdown(record.topic, revisedDocument) } : {}) },
              root: this.root(record.id),
              signal: controller.signal,
              review: review ? structuredClone(review) : undefined,
              ...{
                readDocument: () => structuredClone(review ? revisedDocument! : record.document ?? { overview: "", sections: [] }),
                editDocument: (edit: ResearchDocumentEdit) => {
                  if (controller.signal.aborted || record.deleted_at || record.status !== "running") throw new Error("本轮已停止，未修改草稿");
                  const document = editResearchDocument(review ? revisedDocument! : record.document ?? { overview: "", sections: [] }, edit, (record.components ?? [record.component]).map(c => c.id), review);
                  if (review) {
                    revisedDocument = document;
                    if (review.mode !== "discuss") review.proposal = { base_revision: review.base_revision!,
                      section: structuredClone(document.sections.find(s => s.id === review.section_id)!), status: "pending" };
                    this.update(record, {});
                  }
                  else this.update(record, { document, draft: researchDocumentMarkdown(record.topic, document) });
                  return structuredClone(document);
                },
              },
              update: (patch) => { if (!controller.signal.aborted && !record.deleted_at && record.status !== "cancelled") { if (patch.skill && review) review.skill = patch.skill; this.update(record, patch); } },
              evidence: (item) => {
                if (record.deleted_at || record.status === "cancelled" || controller.signal.aborted) return;
                record.evidence.push({ at: new Date().toISOString(), ...item });
                this.update(record, {});
              },
            });
            if (controller.signal.aborted || record.deleted_at || record.status === "cancelled") return;
            if (!draft.trim()) throw new Error("模型未产出草稿");
            scanForSecrets("组件知识草稿.md", Buffer.from(draft));
            if (review) {
              if (review.mode === "rework" && !review.proposal) {
                throw new Error("本轮没有更新指定组件，原稿已保留；请继续说明返工要求");
              }
              review.status = "done"; review.reply = draft; review.finished_at = new Date().toISOString();
            } else if (!record.challenge && record.document && (!record.document.overview.trim() || !record.document.sections.length
                || record.document.sections.some(section => !sectionReady(section)))) {
              throw new Error("联合草稿尚不完整：需要跨仓关系说明，以及每项组件的接口、集成依赖、最佳示例和来源；已写内容保留，可继续研究");
            }
            this.update(record, {
              status: "done",
              stage: record.challenge ? "反例研究已完成，请人工判断" : review ? "本轮已完成，等待专家继续审查" : "草稿待审查",
              draft: !record.challenge && record.document ? researchDocumentMarkdown(record.topic, record.document) : draft,
              finished_at: new Date().toISOString(),
            });
          } catch (error) {
            if (controller.signal.aborted || record.deleted_at || record.status === "cancelled") return;
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
          if (this.running.get(record.id) !== entry) return;
          clearTimeout(entry.stopTimer);
          this.running.delete(record.id);
          entry.release();
          this.pump();
        });
      entry.work = work;
      this.running.set(record.id, entry);
    }
  }
  private abortRunning(record: ResearchRecord) {
    const entry = this.running.get(record.id);
    if (!entry) return;
    entry.controller.abort();
    entry.stopTimer ??= setTimeout(() => {
      if (this.running.get(record.id) !== entry) return;
      if (entry.review) {
        entry.review.status = "failed"; entry.review.error = stopTimeoutReason;
        entry.review.finished_at = new Date().toISOString();
      }
      try {
        this.update(record, { status: "failed", stage: "萃取失败", error: stopTimeoutReason, finished_at: new Date().toISOString() });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        const reason = `${code ? `${code}：` : ""}${error instanceof Error ? error.message : String(error)}`;
        record.error = `${stopTimeoutReason}；状态记录保存失败：${reason}`;
        if (entry.review) entry.review.error = record.error;
        this.readWarnings.push(`记录保存失败：component-research/${record.id}/record.json；${reason}；并发槽位已释放`);
      } finally {
        if (this.running.get(record.id) === entry) {
          this.running.delete(record.id);
          entry.release();
        }
        this.pump();
      }
    }, stopBudgetMs);
  }
  stop(id: string) {
    const record = this.records.get(id);
    if (!record || record.deleted_at) throw new Error("萃取任务不存在");
    if (["queued", "running"].includes(record.status)) {
      for (const turn of record.review_turns ?? []) if (["queued", "running"].includes(turn.status)) turn.status = "cancelled";
      try { this.update(record, {status:"cancelled", stage:"已停止", finished_at:new Date().toISOString()}); }
      catch (error) { this.warnStopWrite(record, error); throw error; }
      finally { this.abortRunning(record); }
    }
    return this.get(id);
  }
  remove(id: string, operator: string) {
    this.stop(id);
    const record = this.records.get(id)!;
    // Preserve provenance of adopted knowledge; hide the task from management lists.
    this.update(record, {deleted_at:new Date().toISOString(), deleted_by:operator});
    return { deleted: true };
  }
  retry(id: string, operator: string) {
    if (this.stopped) throw new Error("服务正在停止");
    const record = this.get(id);
    this.assertPublicationComplete(record);
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
    return this.start({language:record.language, topic:record.topic, refresh:true}, operator);
  }
  selectSections(id: string, ids: string[], selected: boolean) {
    const record = this.records.get(id);
    this.assertPublicationComplete(record);
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
    this.assertPublicationComplete(record);
    if (!record?.document || record.deleted_at || record.document_id) throw new Error("当前草稿不可讨论或返工");
    if (this.running.has(id) || ["queued", "running"].includes(record.status)) throw new Error("请等待本轮完成或停止后再继续对话");
    if (!record.document.sections.some(section => section.id === input.section_id)) throw new Error("请先选择要讨论或返工的组件");
    if (record.material_ids?.length) throw new Error("历史任务含上传资料，请新建仅使用代码来源的研究后再修订");
    const message = String(input.message ?? "").trim();
    if (!["discuss", "rework", "update"].includes(input.mode) || !message || message.length > 20_000) throw new Error("请填写讨论或返工要求，最多 20000 字");
    scanForSecrets("专家讨论", Buffer.from(message));
    if (input.material_ids !== undefined && (!Array.isArray(input.material_ids) || input.material_ids.length)) throw new Error("组件萃取仅使用基础仓代码与 everycode，不接收上传资料");
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
    this.assertPublicationComplete(record);
    if (!record?.document || record.deleted_at || record.document_id || !section) throw new Error("当前章节不可修改");
    if (["queued", "running"].includes(record.status)) throw new Error("研究进行中：请先停止，或等本轮结束后再改");
    if (section.revision !== input.base_revision) throw new Error("章节已有新版本，请比较后重新保存");
    const document = editResearchDocument(record.document, { action: "section", section: input.section }, (record.components ?? [record.component]).map(c => c.id));
    const metadata = document.sections.find(s => s.id === section.id)?.paradigm;
    if (metadata) {
      if (metadata.language !== record.language) throw new Error("范式语言与研究语言不一致");
      for (const ref of metadata.evidence) if (!record.evidence.some(e => e.tool === "component_source" && e.action === "read" && e.status === "returned"
        && e.component_id === ref.repository_id && e.path === ref.path && e.revision === ref.revision
        && Number(e.start) <= ref.start && Number(e.end) >= ref.end)) throw new Error("引用必须对应本任务已读取的基础仓代码范围");
      for (const id of metadata.usage_evidence) if (!record.evidence.some(e => e.evidence_id === id && e.tool === "code_search" && e.action === "read" && e.status === "returned" && e.content)) throw new Error("调用证据必须对应本任务已取得的 everycode 原文");
    }
    record.section_history ??= [];
    record.section_history.push({ at: new Date().toISOString(), operator, section: structuredClone(section) });
    this.update(record, { document, draft: researchDocumentMarkdown(record.topic, document) });
    return this.get(id);
  }
  decideProposal(id: string, turnId: string, decision: "accept" | "discard", operator: string) {
    const record = this.records.get(id), turn = record?.review_turns?.find(t => t.id === turnId);
    this.assertPublicationComplete(record);
    if (!record || record.deleted_at || record.document_id || !turn?.proposal) throw new Error("修订建议不存在或草稿已归档");
    if (decision === "accept" && turn.status !== "done") throw new Error("本轮尚未完成独立评审，不能采纳修订建议");
    if (!["accept", "discard"].includes(decision)) throw new Error("请选择采纳或放弃");
    if (decision === "accept" && ["queued", "running"].includes(record.status)) throw new Error("当前研究仍在进行，请等待完成后再确认修改");
    if (turn.proposal.status !== "pending") return this.get(id);
    if (decision === "accept") {
      if (record.review_turns!.slice(record.review_turns!.indexOf(turn) + 1).some(later => later.section_id === turn.section_id && later.proposal?.status === "pending")) throw new Error("已有更新的修改建议，请重新检视；如需使用此建议，请先放弃后续建议");
      this.editSection(id, { section: turn.proposal.section, base_revision: turn.proposal.base_revision }, operator);
      for (const old of record.review_turns ?? []) if (old !== turn && old.section_id === turn.section_id && old.proposal?.status === "pending") old.proposal.status = "discarded";
    }
    turn.proposal.status = decision === "accept" ? "accepted" : "discarded";
    this.update(record, {}); return this.get(id);
  }
  restoreSection(id: string, sectionId: string, revision: number, baseRevision: number, operator: string) {
    const record = this.records.get(id);
    this.assertPublicationComplete(record);
    if (record && ["queued", "running"].includes(record.status)) throw new Error("研究进行中：请先停止，或等本轮结束后再改");
    const previous = this.records.get(id)?.section_history?.find(h => h.section.id === sectionId && h.section.revision === revision);
    if (!previous) throw new Error("未找到该历史版本");
    return this.editSection(id, { section: previous.section, base_revision: baseRevision }, operator);
  }
  beginUpdate(id: string, operator: string) {
    const raw = this.records.get(id);
    if (!raw?.document || raw.deleted_at) throw new Error("请选择已入库的联合文档");
    const record = this.get(id);
    if (!record.document) throw new Error("请选择已入库的联合文档");
    const formalId = projectKnowledgeProduction({ kind: "component", record, archive: this.archiveFor(id) }).knowledge_document_id;
    const published = formalId ? readKnowledgeDocument(this.dir, formalId) : undefined;
    if (!published) throw new Error("请选择已入库的联合文档");
    let baseline = researchDocumentMarkdown(published.title, record.document, true);
    if (record.published_revision) {
      if (published.revision === record.published_revision) baseline = published.content;
      else baseline = readKnowledgeDocumentVersion(this.dir, published.id, record.published_revision).document.content;
    }
    if (published.content.trim() !== baseline.trim()) throw new Error("正式文档已由其他入口修改，请先核对当前文档，避免覆盖人工更新");
    this.commitPublicationRecord({ ...record, update_document_id: published.id, update_document_revision: published.revision,
      document_id: undefined, publication_intent: undefined, update_metadata: { title: published.title, scope: published.scope, module_ids: published.module_ids, repositories: published.repositories }, stage: "选择受影响章节，生成更新建议", operator });
    return this.get(id);
  }
  markdown(id: string) {
    const record = this.get(id);
    if (record.deleted_at) throw new Error("萃取任务已删除");
    return record.document ? researchDocumentMarkdown(record.topic, record.document, true, false) : componentKnowledgeMarkdown(record.draft ?? "");
  }
  artifacts(id: string) {
    const record = this.get(id);
    if (record.deleted_at) throw new Error("萃取任务已删除");
    const exported = exportComponentArtifacts(record.document?.sections ?? []);
    const ids = new Set(exported.catalog.flatMap(p => p.usage_evidence));
    const references = [...ids].map(id => {
      const e = record.evidence.find(e => e.evidence_id === id && e.tool === "code_search" && e.action === "read" && e.content);
      if (!e) throw new Error(`缺少 everycode 原始证据：${id}`);
      return { id, repository: e.repository, path: e.path, start: e.start ?? 1, end: e.end ?? 160, content: e.content, revision: null, version_note: "原始返回未结构化提供版本，具体版本以正文为准" };
    });
    return { ...exported, files: { ...exported.files, "evidence/everycode.json": JSON.stringify(references, null, 2) + "\n" } };
  }
  /** 同一次操作预检全部已选建议，再按意图提交正式库与文稿，归档由人另行触发。 */
  publish(id: string, input: ComponentPublishInput, operator: string): ResearchRecord {
    if (this.stopped) throw new Error("服务正在停止");
    const record = this.records.get(id);
    if (!record || record.challenge || record.deleted_at || record.status !== "done") throw new Error("请等待组件草稿完成后发布");
    if (record.publication_intent) { this.finishPublication(record); return this.get(id); }
    if (!object(input) || input.document_id !== (record.document_id ?? null) || input.update_document_id !== (record.update_document_id ?? null)
      || input.update_document_revision !== record.update_document_revision) throw new Error("正式知识绑定或版本已变化，请刷新后发布");
    const accepted = structuredClone(record);
    delete accepted.production; delete accepted.publication_intent;
    const selected = record.document?.sections.filter(section => section.selected) ?? [];
    if (!Array.isArray(input.sections) || input.sections.length !== selected.length || new Set(input.sections.map(item => item?.id)).size !== selected.length
      || input.sections.some(item => !object(item) || !selected.some(section => section.id === item.id))) throw new Error("请选择完整且不重复的组件清单，刷新后重新发布");
    if (record.document && !selected.length) throw new Error("请选择至少一个已完成组件");
    for (const section of selected) {
      const viewed = input.sections.find(item => item.id === section.id)!;
      if (viewed.revision !== section.revision) throw new Error("章节已有新版本，请比较后重新发布");
      const latest = [...record.review_turns ?? []].reverse().find(turn => turn.section_id === section.id && turn.proposal?.status === "pending");
      if (!Object.hasOwn(viewed, "proposal_id") || viewed.proposal_id !== (latest?.id ?? null)) throw new Error("组件修改建议已有变化，请重新检视后发布");
      if (!latest) continue;
      if (latest.status !== "done") throw new Error("修改建议尚未完成，请等待本轮结束后发布");
      if (latest.proposal!.base_revision !== section.revision) throw new Error("修改建议基线冲突，请比较章节最新版本后发布");
      const document = editResearchDocument(accepted.document!, { action: "section", section: structuredClone(latest.proposal!.section) },
        (record.components ?? [record.component]).map(component => component.id));
      const metadata = document.sections.find(item => item.id === section.id)?.paradigm;
      if (metadata) {
        if (metadata.language !== record.language) throw new Error("范式语言与研究语言不一致");
        for (const ref of metadata.evidence) if (!record.evidence.some(evidence => evidence.tool === "component_source" && evidence.action === "read" && evidence.status === "returned"
          && evidence.component_id === ref.repository_id && evidence.path === ref.path && evidence.revision === ref.revision
          && Number(evidence.start) <= ref.start && Number(evidence.end) >= ref.end)) throw new Error("引用必须对应本任务已读取的基础仓代码范围");
        for (const evidenceId of metadata.usage_evidence) if (!record.evidence.some(evidence => evidence.evidence_id === evidenceId && evidence.tool === "code_search"
          && evidence.action === "read" && evidence.status === "returned" && evidence.content)) throw new Error("调用证据必须对应本任务已取得的 everycode 原文");
      }
      (accepted.section_history ??= []).push({ at: new Date().toISOString(), operator, section: structuredClone(section) });
      accepted.document = document;
      for (const turn of accepted.review_turns ?? []) if (turn.section_id === section.id && turn.proposal?.status === "pending") turn.proposal.status = turn.id === latest.id ? "accepted" : "discarded";
    }
    if (accepted.document?.sections.some(section => section.selected && !sectionReady(section))) throw new Error("请选择已完成且含最佳示例的组件");
    const formalId = record.document_id ?? record.update_document_id;
    const previous = formalId ? readKnowledgeDocument(this.dir, formalId) : undefined;
    const baseline = record.update_document_id ? record.update_document_revision : record.published_revision;
    if (previous && (!baseline || previous.revision !== baseline)) throw new Error("正式知识已有新版本，请比较最新内容后发布，未覆盖他人修改");
    const title = String(input.title ?? previous?.title ?? record.topic).trim();
    const content = accepted.document ? researchDocumentMarkdown(title, accepted.document, true) : String(input.content ?? accepted.draft ?? "");
    scanForSecrets("组件知识.md", Buffer.from(content));
    const research_source = { job_id: id, repository: record.component.repository, branch: record.component.branch, path: record.component.path,
      revision: record.revision, components: record.components?.map(component => ({ id: component.id, repository: component.repository,
        branch: component.branch, path: component.path, revision: record.revisions?.[component.id] })) };
    const formal = prepareKnowledgeDocument(this.dir, { ...previous, ...input, title, content, technologies: [record.language], research_source,
      when_to_use: input.when_to_use ?? previous?.when_to_use ?? `${record.language} / ${record.topic}`, active: previous?.active ?? true,
    }, operator, formalId, { expectedRevision: baseline, maxContentBytes: accepted.document ? 16 * 1024 * 1024 : undefined });
    Object.assign(accepted, { document_id: formal.document.id, published_revision: formal.document.revision, update_document_id: undefined,
      update_document_revision: undefined, update_metadata: { title: formal.document.title, scope: formal.document.scope,
        module_ids: formal.document.module_ids, repositories: formal.document.repositories },
      stage: "已入库", draft: accepted.document ? researchDocumentMarkdown(title, accepted.document) : content });
    const intent: ComponentPublicationIntent = { formal, record: accepted };
    this.commitPublicationRecord({ ...structuredClone(record), publication_intent: intent });
    this.finishPublication(this.records.get(id)!);
    return this.get(id);
  }
  recoverPublications() {
    for (const record of [...this.records.values()]) {
      if (!record.publication_intent || record.deleted_at) continue;
      try { this.finishPublication(record); }
      catch (error) {
        const warning = `组件发布未完成：component-research/${record.id}/record.json；${error instanceof Error ? error.message : "请检查发布意图"}`;
        if (!this.readWarnings.includes(warning)) this.readWarnings.push(warning);
      }
    }
  }
  private commitPublicationRecord(record: ResearchRecord) {
    const { production: _, ...raw } = record;
    mkdirSync(this.root(record.id), { recursive: true });
    durableWriteFileSync(join(this.root(record.id), "record.json"), JSON.stringify(raw), { mode: 0o600 });
    this.records.set(record.id, raw);
  }
  private finishPublication(record: ResearchRecord) {
    const intent = record.publication_intent!;
    let current: ReturnType<typeof readKnowledgeDocument> | undefined;
    try { current = readKnowledgeDocument(this.dir, intent.formal.document.id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current && current.revision !== intent.formal.document.revision && current.revision !== intent.formal.previous_revision) throw new Error("正式知识已有新版本，发布意图未覆盖其他人的修改");
    // 人工恢复旧正文会复用内容版本号，但历史已前进；不能把它误当尚未提交的原基线。
    if (current && current.revision !== intent.formal.document.revision
      && JSON.stringify(current.history) !== JSON.stringify(intent.formal.document.history.slice(0, -1))) {
      throw new Error("正式知识已有人工修改或恢复历史，发布意图未覆盖其他人的修改");
    }
    if (current?.revision !== intent.formal.document.revision) writePreparedKnowledgeDocument(this.dir, intent.formal);
    this.onAdopt();
    this.commitPublicationRecord(structuredClone(intent.record));
  }
  adopt(id: string, input: Record<string, unknown>, operator: string) {
    const record = this.records.get(id);
    this.assertPublicationComplete(record);
    if (!record || record.challenge || record.deleted_at || record.status !== "done") throw new Error("请等待组件草稿生成后采纳");
    const formalId = projectKnowledgeProduction({ kind: "component", record, archive: this.archiveFor(id) }).knowledge_document_id;
    if (formalId && !record.update_document_id) {
      const published = readKnowledgeDocument(this.dir, formalId);
      this.update(record, { document_id: formalId, published_revision: published.revision, stage: "已入库" });
      return published;
    }
    this.assertSelectedChangesConfirmed(record);
    if (record.document && (!record.document.sections.some(s => s.selected)
        || record.document.sections.some(s => s.selected && !sectionReady(s)))) throw new Error("请选择至少一个已完成且含最佳示例的组件");
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
  private assertSelectedChangesConfirmed(record: ResearchRecord) {
    if (record.review_turns?.some(turn => turn.proposal?.status === "pending" && record.document?.sections.some(section => section.id === turn.section_id && section.selected))) throw new Error("所选组件有尚未确认的修改，请先确认或放弃后发布");
  }
  private warnStopWrite(record: ResearchRecord, error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    this.readWarnings.push(`停止记录保存失败：component-research/${record.id}/record.json；${code ? `${code}：` : ""}${error instanceof Error ? error.message : String(error)}；执行已取消，请检查磁盘`);
  }
  async shutdown() {
    this.stopped = true;
    const failures: unknown[] = [];
    for (const r of this.records.values())
      if (!r.deleted_at && ["queued", "running"].includes(r.status)) {
        for (const turn of r.review_turns ?? []) if (["queued", "running"].includes(turn.status)) turn.status = "queued";
        try { this.update(r, {
          status: "queued",
          stage: "等待接续原研究会话",
          error: undefined,
        }); } catch (error) { this.warnStopWrite(r, error); failures.push(error); }
      }
    const entries = [...this.running.entries()];
    for (const [id] of entries) this.abortRunning(this.records.get(id)!);
    await Promise.all(entries.map(([, entry]) => entry.released));
    if (failures.length) throw failures[0];
  }
}
