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
import { recordArray, recordCheck, recordFields, recordObject, recordReadReason, recordStrings, KnowledgeRecordFormatError } from "./knowledgeRecordValidation.ts";
import {
  componentKey,
  componentRepositories,
  type ComponentRepository,
} from "./componentRepositories.ts";
import { normalizeKnowledgeLanguages } from "./knowledgeLanguages.ts";
import {
  readKnowledgeDocument,
  readKnowledgeDocumentVersion,
  prepareKnowledgeDocument,
  writePreparedKnowledgeDocument,
  type PreparedKnowledgeDocument,
} from "./knowledgeDocuments.ts";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import { editResearchDocument, isWholeResearchReview, researchDocumentMarkdown, sectionReady,
  type ResearchSection, type ResearchDocument, type ResearchDocumentEdit, type ResearchReviewTurn } from "./componentResearchDocument.ts";
import { assertLatestReviewProposal, assertNoPendingReviewProposals, assertReviewRevision,
  continuingReviewProposal, type ReviewProposal } from "./knowledgeReviewCore.ts";
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
  /** 新研究覆盖一个组件的全部能力；component 是旧记录中的方式，读取时保留。 */
  mode?: "all" | "component";
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
  /** 最近一次实际开跑；任务中心按它和 finished_at 算运行时长，不含排队。 */
  started_at?: string;
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
function reviewProposals(record: ResearchRecord): ReviewProposal<ResearchSection>[] {
  return (record.review_turns ?? []).flatMap(turn => turn.proposal ? [{
    turn_id: turn.id, document_id: turn.section_id, turn_status: turn.status,
    status: turn.proposal.status, base_revision: turn.proposal.base_revision, value: turn.proposal.section,
  }] : []);
}
export interface ResearchInput {
  component_id?: string;
  language: string;
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
function recordRevisions(value: unknown, path: string) {
  recordObject(value, path);
  recordCheck(Object.values(value).every(revision => typeof revision === "string"), path, "版本必须是文本");
}
function recordSkill(value: unknown, path: string) {
  recordObject(value, path); recordFields(value, ["name", "digest"], `${path}.`);
}
function checkComponent(value: unknown, path: string) {
  recordObject(value, path);
  recordFields(value, ["id", "name", "repository", "branch", "path", "description"], `${path}.`);
  recordStrings(value.languages, `${path}.languages`);
  recordCheck(typeof value.enabled === "boolean", `${path}.enabled`, "必须是布尔值");
}
function checkSection(value: unknown, repositoryIds: string[], path: string) {
  recordObject(value, path);
  recordFields(value, ["id", "title", "content", "interfaces", "integration", "example", "sources"], `${path}.`);
  recordStrings(value.repository_ids, `${path}.repository_ids`); recordStrings(value.related_ids, `${path}.related_ids`);
  recordCheck(typeof value.selected === "boolean", `${path}.selected`, "必须是布尔值");
  recordCheck(Number.isSafeInteger(value.revision) && value.revision >= 0, `${path}.revision`, "必须是非负整数");
  if (value.paradigm !== undefined) {
    recordObject(value.paradigm, `${path}.paradigm`);
    try { validateComponentParadigm(value.paradigm as Parameters<typeof validateComponentParadigm>[0], repositoryIds); }
    catch { throw new KnowledgeRecordFormatError(`${path}.paradigm 不符合当前组件规则或来源范围`); }
  }
}
function checkReviewTurn(value: unknown, repositoryIds: string[], path: string) {
  recordObject(value, path);
  recordFields(value, ["id", "section_id", "message", "operator", "created_at"], `${path}.`);
  recordCheck(["discuss", "rework", "update", "supplement"].includes(value.mode), `${path}.mode`, "不是受支持的研究操作");
  recordCheck(recordStatuses.includes(value.status), `${path}.status`, "不是受支持的任务状态");
  if (value.added_section_ids !== undefined) recordStrings(value.added_section_ids, `${path}.added_section_ids`);
  recordFields(value, ["reply", "error", "finished_at"], `${path}.`, true);
  if (value.skill !== undefined) recordSkill(value.skill, `${path}.skill`);
  if (value.previous_revisions !== undefined) recordRevisions(value.previous_revisions, `${path}.previous_revisions`);
  if (value.base_revision !== undefined) recordCheck(Number.isSafeInteger(value.base_revision), `${path}.base_revision`, "必须是整数");
  if (value.proposal !== undefined) {
    recordObject(value.proposal, `${path}.proposal`);
    recordCheck(["pending", "accepted", "discarded"].includes(value.proposal.status), `${path}.proposal.status`, "不是受支持的建议状态");
    recordCheck(Number.isSafeInteger(value.proposal.base_revision), `${path}.proposal.base_revision`, "必须是整数");
    checkSection(value.proposal.section, repositoryIds, `${path}.proposal.section`);
  }
}
function checkPipeline(value: unknown, path: string) {
  recordObject(value, path);
  recordCheck(value.version === 1, `${path}.version`, "不是受支持的研究版本");
  recordFields(value, ["skill"], `${path}.`);
  recordArray(value.tasks, `${path}.tasks`, (task, path) => {
    recordObject(task, path); recordFields(task, ["id", "title", "spec"], `${path}.`);
    recordCheck(["inventory", "plan", "contracts", "paradigm", "pitfalls", "index", "synthesis"].includes(task.phase), `${path}.phase`, "不是受支持的研究步骤");
    recordCheck(["pending", "running", "done", "failed"].includes(task.status), `${path}.status`, "不是受支持的步骤状态");
    recordStrings(task.dependencies, `${path}.dependencies`);
    recordCheck(Number.isSafeInteger(task.attempts) && task.attempts >= 0, `${path}.attempts`, "必须是非负整数");
    recordFields(task, ["component", "feedback"], `${path}.`, true);
    if (task.result === undefined) return;
    recordObject(task.result, `${path}.result`); recordFields(task.result, ["findings"], `${path}.result.`);
    recordStrings(task.result.open_questions, `${path}.result.open_questions`);
    if (task.result.components !== undefined) recordArray(task.result.components, `${path}.result.components`, (component, path) => {
      recordObject(component, path); recordFields(component, ["id", "title", "scope"], `${path}.`);
      recordStrings(component.repository_ids, `${path}.repository_ids`);
    });
    if (task.result.paradigms !== undefined) recordArray(task.result.paradigms, `${path}.result.paradigms`, (paradigm, path) => {
      recordObject(paradigm, path); recordFields(paradigm, ["id", "title", "need"], `${path}.`);
    });
  });
}
function validResearchRecord(value: unknown, id: string, path = ""): value is ResearchRecord {
  recordObject(value, path || "组件研究记录");
  const field = (name: string) => `${path}${name}`;
  recordCheck(value.id === id, field("id"), "与任务目录不一致");
  recordFields(value, ["id", "language", "topic", "operator", "key", "created_at", "stage"], path);
  recordFields(value, ["deleted_at", "deleted_by", "started_at", "finished_at", "revision", "draft", "error", "document_id", "update_document_id", "update_document_revision", "published_revision"], path, true);
  if (value.mode !== undefined) recordCheck(["all", "component"].includes(value.mode), field("mode"), "不是受支持的组件研究方式");
  if (value.format !== undefined) recordCheck(value.format === "joint-document", field("format"), "不是当前组件文稿格式");
  if (value.use_latest_skill !== undefined) recordCheck(typeof value.use_latest_skill === "boolean", field("use_latest_skill"), "必须是布尔值");
  if (value.skill !== undefined) recordSkill(value.skill, field("skill"));
  recordCheck(recordStatuses.includes(value.status), field("status"), "不是受支持的任务状态");
  checkComponent(value.component, field("component"));
  if (value.components !== undefined) recordArray(value.components, field("components"), checkComponent);
  const components = value.components ?? [value.component], repositoryIds = components.map((component: Record<string, any>) => component.id);
  recordArray(value.evidence, field("evidence"), recordObject);
  if (value.revisions !== undefined) recordRevisions(value.revisions, field("revisions"));
  if (value.material_ids !== undefined) recordStrings(value.material_ids, field("material_ids"));
  if (value.document !== undefined) {
    recordObject(value.document, field("document")); recordFields(value.document, ["overview"], field("document."));
    recordArray(value.document.sections, field("document.sections"), (section, path) => checkSection(section, repositoryIds, path));
  }
  if (value.review_turns !== undefined) recordArray(value.review_turns, field("review_turns"), (turn, path) => {
    checkReviewTurn(turn, repositoryIds, path);
    if (["queued", "running"].includes(turn.status)) recordCheck(value.document !== undefined && (turn.mode === "supplement" || isWholeResearchReview(turn as ResearchReviewTurn) || value.document.sections.some((section: ResearchSection) => section.id === turn.section_id)), `${path}.section_id`, "正在执行的研究操作缺少对应文稿或能力项");
  });
  if (value.section_history !== undefined) recordArray(value.section_history, field("section_history"), (history, path) => {
    recordObject(history, path); recordFields(history, ["at", "operator"], `${path}.`); checkSection(history.section, repositoryIds, `${path}.section`);
  });
  if (value.pipeline !== undefined) checkPipeline(value.pipeline, field("pipeline"));
  if (value.update_metadata !== undefined) {
    recordObject(value.update_metadata, field("update_metadata")); recordFields(value.update_metadata, ["title", "scope"], field("update_metadata."));
    for (const name of ["module_ids", "repositories"]) recordStrings(value.update_metadata[name], field(`update_metadata.${name}`));
  }
  if (value.challenge !== undefined) {
    recordObject(value.challenge, field("challenge")); recordFields(value.challenge, ["item_id", "source_digest", "language", "claim"], field("challenge.")); recordStrings(value.challenge.repository_ids, field("challenge.repository_ids"));
  }
  if (value.publication_intent !== undefined) recordCheck(validPublicationIntent(value.publication_intent, id), field("publication_intent"), "发布记录格式不完整");
  return true;
}
function validPublicationIntent(value: unknown, id: string): value is ComponentPublicationIntent {
  if (!object(value) || !object(value.formal) || !object(value.formal.document) || !object(value.record)) return false;
  const formal = value.formal.document;
  const location = (value: unknown, names: string[]) => value === undefined || object(value) && fields(value, names);
  return /^kd-[a-f0-9-]{36}$/.test(formal.id) && fields(formal, ["id", "title", "content", "when_to_use", "revision"])
    && /^[a-f0-9]{64}$/.test(formal.revision) && ["platform", "module", "repository"].includes(formal.scope) && typeof formal.active === "boolean"
    && [formal.module_ids, formal.repositories, formal.technologies, formal.product_versions].every(strings)
    && Array.isArray(formal.history) && formal.history.length > 0 && formal.history.every(history => object(history)
      && fields(history, ["at", "operator", "action"]) && Number.isFinite(Date.parse(history.at)) && (history.revision === undefined || typeof history.revision === "string"))
    && location(formal.source, ["repository", "branch", "path", "revision"]) && location(formal.archive_target, ["repository", "branch", "path"])
    && location(formal.research_source, ["job_id", "repository", "branch", "path"])
    && (value.formal.previous_revision === null || typeof value.formal.previous_revision === "string" && /^[a-f0-9]{64}$/.test(value.formal.previous_revision))
    && typeof value.formal.unchanged === "boolean"
    && value.record.production === undefined && value.record.publication_intent === undefined && validResearchRecord(value.record, id, "publication_intent.record.")
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
        let record: ResearchRecord;
        try {
          const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
          if (!validResearchRecord(parsed, name)) throw new Error("组件研究记录格式无效");
          record = parsed;
        } catch (error) {
          this.readWarnings.push(`记录损坏或无法读取：component-research/${name}/record.json；${recordReadReason(error)}`);
          continue;
        }
        this.records.set(record.id, record);
        try {
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
        } catch (error) {
          // 记录已经读对，恢复保存失败不能把它藏起来，也不能在未保存状态时自动开跑。
          const reason = recordReadReason(error);
          Object.assign(record, { status: "failed", stage: "恢复研究记录失败", error: reason });
          this.readWarnings.push(`恢复研究记录保存失败：component-research/${name}/record.json；${reason}`);
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
  /** 一个组件一次研究一篇知识（2026-10-08 用户）：同组件已有研究就打开它，补充与刷新走「补充遗漏能力」「更新知识」。 */
  start(input: ResearchInput, operator: string) {
    if (this.stopped) throw new Error("服务正在停止");
    if (input.material_ids !== undefined && (!Array.isArray(input.material_ids) || input.material_ids.length)) throw new Error("组件萃取仅使用基础仓代码与 everycode，不接收上传资料");
    // 一个组件只有一次研究：主题、全量模式与强制重做都已取消，旧字段明确拒绝，免得调用方以为生效了。
    const unknown = Object.keys(input ?? {}).filter(key => !["component_id", "language", "material_ids"].includes(key));
    if (unknown.length) throw new Error(`组件研究不支持参数：${unknown.join("、")}；按组件发起，修改已有知识请用更新知识`);
    const language =normalizeKnowledgeLanguages([input.language])[0];
    const candidates = componentRepositories(this.dir).filter(c => c.enabled && c.languages.includes(language));
    if (!candidates.length) throw new Error("请先在配置中心启用该语言的基础组件仓");
    const component = input.component_id ? candidates.find(c => c.id === input.component_id) : candidates.length === 1 ? candidates[0] : undefined;
    if (!component) throw new Error(input.component_id ? "所选组件不存在，或未登记该语言" : "该语言登记了多个组件，请选择要研究的组件");
    const key = JSON.stringify(["component", language, componentKey(component)]);
    const previous = [...this.records.values()].reverse().find(r => r.key === key && !r.deleted_at && !r.challenge);
    if (previous) return this.get(previous.id);
    if ([...this.records.values()].filter(r => r.status === "queued").length >= 50) throw new Error("待萃取队列已满，请稍后再试");
    const record: ResearchRecord = { id: `cr-${randomUUID()}`, mode: "all", component, components: [component], material_ids: [],
      language, topic: component.name, operator, key, status: "queued", created_at: new Date().toISOString(),
      format: "joint-document", document: { overview: "", sections: [] }, review_turns: [], stage: "等待组件研究", evidence: [] };
    this.records.set(record.id, record); this.update(record, {});
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
  private root(id: string) {
    return join(this.dir, "component-research", id);
  }
  private update(record: ResearchRecord, patch: Partial<ResearchRecord>) {
    Object.assign(record, patch);
    const root = this.root(record.id);
    mkdirSync(root, { recursive: true });
    const path = join(root, "record.json");
    durableWriteFileSync(path, JSON.stringify(record), { mode: 0o600 });
    this.readWarnings = this.readWarnings.filter(warning => !warning.startsWith(`恢复研究记录保存失败：component-research/${record.id}/record.json；`));
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
        const proposals = reviewProposals(record);
        revisedDocument = { ...revisedDocument, sections: revisedDocument.sections.map(section => {
          const proposal = continuingReviewProposal(proposals, section.id, section.revision, review.id,
            record.review_turns!.map(turn => turn.id));
          // 接着已完成的候选稿修改，原章节版本与选择状态保留到确认时。
          return proposal ? { ...structuredClone(proposal.value), revision: section.revision, selected: section.selected } : section;
        }) };
      }
      this.update(record, { status: "running", error: undefined, started_at: new Date().toISOString(), finished_at: undefined, stage: review ? isWholeResearchReview(review) ? "正在修订全部文稿" : ({ discuss: "正在回答组件问题", supplement: "正在补充遗漏能力" } as Record<string, string>)[review.mode] ?? "正在返工指定组件" : "准备组件源码" });
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
                    if (review.mode === "supplement") {
                      if (edit.action === "outline") review.added_section_ids = [...review.added_section_ids ?? [], ...edit.entries!.map(entry => entry.id)];
                    } else if (review.mode !== "discuss" && !isWholeResearchReview(review)) review.proposal = { base_revision: review.base_revision!,
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
              if (review.mode === "rework" && !isWholeResearchReview(review) && !review.proposal) {
                throw new Error("本轮没有更新指定组件，原稿已保留；请继续说明返工要求");
              }
              if (review.mode === "supplement") {
                // 新项整体通过才并入：半份补充混进人审过的文稿，比没补更难收拾。
                const added = revisedDocument!.sections.filter(section => review.added_section_ids?.includes(section.id));
                if (!added.length) throw new Error("本轮没有找到可补充的能力，原稿已保留；请具体说明遗漏的能力、接口或场景");
                const unfinished = added.filter(section => !sectionReady(section)).map(section => section.title);
                if (unfinished.length) throw new Error(`补充的能力尚不完整（${unfinished.join("、")}），需要接口、集成依赖、最佳示例和来源；原稿已保留，可重试`);
                record.document = { ...record.document!, sections: [...record.document!.sections, ...structuredClone(added).map(section => ({ ...section, selected: true }))] };
              }
              if (isWholeResearchReview(review)) {
                if (!revisedDocument?.overview.trim() || !revisedDocument.sections.length || revisedDocument.sections.some(section => !sectionReady(section))) {
                  throw new Error("整体修订尚不完整，原稿已保留，请补充后重试");
                }
                record.section_history ??= [];
                for (const section of record.document!.sections) {
                  const changed = revisedDocument.sections.find(item => item.id === section.id);
                  if (changed && JSON.stringify(changed) !== JSON.stringify(section)) record.section_history.push({ at: new Date().toISOString(), operator: review.operator, section: structuredClone(section) });
                }
                record.document = structuredClone(revisedDocument);
                // 整体修订从当前候选稿继续，旧候选内容已纳入这份草稿；发布仍由人单独确认。
                for (const previous of record.review_turns ?? []) if (previous.proposal?.status === "pending") previous.proposal.status = "accepted";
              }
              // Agent 按仓库编号引用代码，程序据此校验；给人看的回复换成组件名，路径与行号保留。
              const named = (record.components ?? [record.component]).reduce((text, component) => text.split(`${component.id}:`).join(`${component.name}:`), draft);
              review.status = "done"; review.reply = named; review.finished_at = new Date().toISOString();
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
              if (review.mode === "supplement") review.added_section_ids = undefined;
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
      if (record.document_id) throw new Error("已发布的知识保留原样；需要修改请用「更新知识」");
      if (this.running.has(id)) throw new Error("上一轮正在停止，请稍后重试");
      const lastTurn = record.review_turns?.at(-1);
      if (lastTurn && ["failed", "cancelled"].includes(lastTurn.status)) {
        return this.review(id, { section_id: lastTurn.section_id, mode: lastTurn.mode, message: lastTurn.message }, operator);
      }
      const live = this.records.get(id)!;
      this.update(live, { status: "queued", error: undefined, finished_at: undefined, stage: "继续联合研究，保留已有组件" });
      this.pump(); return this.get(id);
    }
    throw new Error("该研究记录不支持重试，请重新发起");
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
  review(id: string, input: { section_id: string; mode: ResearchReviewTurn["mode"]; message: string; use_latest_skill?: boolean; material_ids?: string[] }, operator: string) {
    if (this.stopped) throw new Error("服务正在停止");
    const record = this.records.get(id);
    this.assertPublicationComplete(record);
    if (!record?.document || record.deleted_at || record.document_id) throw new Error("当前草稿不可讨论或返工");
    if (this.running.has(id) || ["queued", "running"].includes(record.status)) throw new Error("请等待本轮完成或停止后再继续对话");
    const supplement = input.mode === "supplement";
    if (supplement ? input.section_id : !isWholeResearchReview(input) && !record.document.sections.some(section => section.id === input.section_id)) throw new Error(supplement ? "补充遗漏能力不针对已有能力项" : "请先选择要讨论或返工的组件");
    if (record.material_ids?.length) throw new Error("历史任务含上传资料，请新建仅使用代码来源的研究后再修订");
    const message = String(input.message ?? "").trim();
    if (!["discuss", "rework", "update", "supplement"].includes(input.mode) || !message || message.length > 20_000) throw new Error(supplement ? "请说明遗漏了哪些能力、接口或场景，最多 20000 字" : "请填写讨论或返工要求，最多 20000 字");
    scanForSecrets("专家讨论", Buffer.from(message));
    if (input.material_ids !== undefined && (!Array.isArray(input.material_ids) || input.material_ids.length)) throw new Error("组件萃取仅使用基础仓代码与 everycode，不接收上传资料");
    record.review_turns ??= [];
    record.review_turns.push({ id: `review-${randomUUID()}`, section_id: input.section_id,
      mode: input.mode, message, operator, status: "queued", created_at: new Date().toISOString(),
      ...(input.mode === "update" ? { previous_revisions: { ...record.revisions } } : {}) });
    if (input.mode === "update") record.revisions = {};
    this.update(record, { use_latest_skill: input.use_latest_skill === true, status: "queued", stage: isWholeResearchReview(input) ? "等待整体文稿修订" : ({ discuss: "等待回答组件问题", supplement: "等待补充遗漏能力" } as Record<string, string>)[input.mode] ?? "等待指定组件返工", error: undefined, finished_at: undefined });
    this.pump(); return this.get(id);
  }
  editSection(id: string, input: { section: ResearchSection; base_revision: number }, operator: string) {
    const record = this.records.get(id), section = record?.document?.sections.find(s => s.id === input.section?.id);
    this.assertPublicationComplete(record);
    if (!record?.document || record.deleted_at || record.document_id || !section) throw new Error("当前章节不可修改");
    if (["queued", "running"].includes(record.status)) throw new Error("研究进行中：请先停止，或等本轮结束后再改");
    assertReviewRevision(section.revision, input.base_revision, "章节已有新版本，请比较后重新保存");
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
      const section = record.document?.sections.find(section => section.id === turn.section_id);
      if (!section) throw new Error("当前章节不可修改");
      assertLatestReviewProposal(reviewProposals(record), turn.id, turn.section_id, section.revision,
        ["queued", "running"].includes(record.status));
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
    // 正式文档在阅读页编辑或恢复过时，研究稿是分章节结构，无法吸收那份 Markdown 改动。
    // 以前直接拒绝，人就再也发不起更新（死路）；现在照常开始，如实提示别处的修改不会带入，
    // 旧版本仍在版本历史里可对比，发布前由人审查决定。
    const manualChanged = published.content.trim() !== baseline.trim();
    this.commitPublicationRecord({ ...record, update_document_id: published.id, update_document_revision: published.revision,
      document_id: undefined, publication_intent: undefined, update_metadata: { title: published.title, scope: published.scope, module_ids: published.module_ids, repositories: published.repositories },
      stage: manualChanged ? "选择受影响章节，生成更新建议。注意：正式文档在别处改过，本次更新以研究稿为基础，别处的修改不会自动带入，可在版本历史中对比" : "选择受影响章节，生成更新建议", operator });
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
      assertReviewRevision(section.revision, viewed.revision, "章节已有新版本，请比较后重新发布");
      const latest = [...record.review_turns ?? []].reverse().find(turn => turn.section_id === section.id && turn.proposal?.status === "pending");
      if (!Object.hasOwn(viewed, "proposal_id") || viewed.proposal_id !== (latest?.id ?? null)) throw new Error("组件修改建议已有变化，请重新检视后发布");
      if (!latest) continue;
      assertLatestReviewProposal(reviewProposals(record), latest.id, section.id, section.revision, false,
        "修改建议基线冲突，请比较章节最新版本后发布");
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
    assertNoPendingReviewProposals(reviewProposals(accepted), selected.map(section => section.id));
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
    // 相同正式版本的重复发布不应重复触发正式库变更回调。
    if (!intent.formal.unchanged) this.onAdopt();
    this.commitPublicationRecord(structuredClone(intent.record));
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
