import { componentArchiveParts, restoreComponentArchive } from "./componentKnowledgeArchiveFormat.ts";
import { listKnowledgeDocuments, readKnowledgeDocument, prepareKnowledgeDocument, writePreparedKnowledgeDocument } from "./knowledgeDocuments.ts";
import { KnowledgeExtractionSkills } from "./knowledgeExtractionSkills.ts";
import { knowledgeArchiveDefaults } from "./knowledgeArchiveDefaults.ts";
import { readKnowledgeRepoConfig } from "./knowledgeRepoConfig.ts";
import { readBusinessModule } from "./businessModuleLibrary.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import { assertRepositoryCloneAddress } from "./repositoryAddress.ts";
import { readKnowledgeMaterial } from "./knowledgeMaterials.ts";
import { IncompleteDomainResearch } from "./domainSkillWork.ts";
import { durableWriteFileSync } from "./durableWrite.ts";
import { knowledgeDeleted } from "./knowledgeDeletionStore.ts";

import type { KnowledgeRepository, DomainDocumentContent, DomainDocument, DomainTurn, DomainPublication, DomainArchiveBatch, DomainKnowledgeJob, DomainExecution, DomainRemoteReview, KnowledgeCleanupPlan } from "./domainKnowledgeTypes.ts";
export type { KnowledgeRepository, DomainDocumentContent, DomainDocument, DomainTurn, DomainPublication, DomainKnowledgeJob, DomainExecution } from "./domainKnowledgeTypes.ts";

export function knowledgeIssueNumber(value: unknown): string {
  const issue = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(issue)) throw new Error("请填写一个有效的关联单号（最多 120 位字母、数字、点、下划线或短横线）");
  return issue;
}

export function knowledgeIssueDescription(value: unknown, options: { required?: boolean } = {}): string | undefined {
  if (value === undefined && !options.required) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error("请填写关联单号对应的准确描述，将原样用作 MR 标题");
  const description = value.trim();
  if (description.length > 2000 || /[\x00-\x1f\x7f\u2028\u2029]/.test(description)) throw new Error("单号描述须为单行文本，最多 2000 字");
  return description;
}

export function knowledgeRelativePath(value: unknown, markdown = false): string {
  const path = String(value ?? "").trim().replace(/\/$/, "");
  if (!path || path.length > 1000 || path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git" || /[\\\x00-\x1f]/.test(p)) || (markdown && !path.endsWith(".md"))) throw new Error("请使用仓内文档相对路径，文档必须为 .md");
  return path;
}
function repository(input: any, id: string): KnowledgeRepository {
  const url = String(input?.repository ?? "").trim(), branch = String(input?.branch ?? "").trim();
  if (!/^https?:\/\//.test(url) || new URL(url).username || new URL(url).password) throw new Error("请填写不带凭据的 HTTP/HTTPS 仓库地址");
  assertRepositoryCloneAddress(url);
  if (!branch || branch.length > 255 || branch.startsWith("-") || /[\s\\~^:?*\[\x00-\x1f]|\.\.|@\{|\/\/|\.$|\/$|\.lock(?:\/|$)/.test(branch)) throw new Error("请填写有效的目标分支");
  return { id, name: String(input.name ?? "").trim().slice(0, 100) || id, repository: url, branch,
    path: input.path ? knowledgeRelativePath(input.path) : "", docs_path: knowledgeRelativePath(input.docs_path || "docs/knowledge") };
}

const STOP_BUDGET_MS = 60_000;
const STOP_TIMEOUT = "停止超时：执行体 60 秒内未退出，已强制释放";
const isRecord = (value: any): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
function validStoredJob(value: any, id: string): value is DomainKnowledgeJob {
  const strings = (values: any) => Array.isArray(values) && values.every(value => typeof value === "string");
  const fields = (value: any, keys: string[]) => isRecord(value) && keys.every(key => typeof value[key] === "string");
  const revisionMap = (value: any) => isRecord(value) && Object.values(value).every(revision => typeof revision === "string");
  const nullableText = (value: any) => value === null || typeof value === "string";
  const content = (doc: any) => isRecord(doc) && ["id", "title", "target_id", "path", "content", "sources"].every(key => typeof doc[key] === "string") && ["domain", "repository"].includes(doc.layer);
  const document = (doc: any) => content(doc) && Number.isSafeInteger(doc.revision) && doc.revision > 0
    && typeof doc.selected === "boolean" && nullableText(doc.base_content) && typeof doc.base_revision === "string"
    && Array.isArray(doc.history) && doc.history.every((history: any) => fields(history, ["content", "sources", "title", "operator", "at"])
      && Number.isSafeInteger(history.revision) && history.revision > 0)
    && (doc.remote_review === undefined || fields(doc.remote_review, ["id", "target_revision"])
      && nullableText(doc.remote_review.target_content) && typeof doc.remote_review.reviewed === "boolean")
    && (doc.component_metadata === undefined || typeof doc.component_metadata === "string");
  const target = (target: any) => isRecord(target) && ["id", "repository", "branch", "docs_path"].every(key => typeof target[key] === "string");
  const publishedDocument = (doc: any) => fields(doc, ["id", "path", "content"]) && Number.isSafeInteger(doc.revision) && doc.revision > 0;
  const publication = (p: any) => isRecord(p) && typeof p.target_id === "string" && typeof p.branch === "string"
    && ["pending", "opened", "merged", "failed", "closed", "unchanged"].includes(p.state) && Array.isArray(p.documents) && p.documents.every(publishedDocument)
    && (p.attempted_documents === undefined || Array.isArray(p.attempted_documents) && p.attempted_documents.every(publishedDocument))
    && (p.diverged_paths === undefined || strings(p.diverged_paths))
    && (p.sync_state === undefined || ["pending", "done", "failed", "diverged"].includes(p.sync_state));
  const research = (research: any) => isRecord(research) && typeof research.inventory_complete === "boolean"
    && ["research", "review", "complete"].includes(research.phase) && Array.isArray(research.capabilities)
    && research.capabilities.every((capability: any) => fields(capability, ["id", "title", "findings"])
      && ["pending", "researched", "blocked"].includes(capability.state) && strings(capability.repository_ids) && strings(capability.document_ids)
      && Array.isArray(capability.sources) && capability.sources.every((source: any) => fields(source, ["repository_id", "path"])));
  const entry = (entry: any) => fields(entry, ["path", "mode", "oid"]);
  const cleanup = (plan: any) => fields(plan, ["id", "target_id", "target_revision"]) && typeof plan.confirmed === "boolean"
    && strings(plan.directories) && strings(plan.document_versions) && Array.isArray(plan.target_entries) && plan.target_entries.every(entry)
    && (plan.branch_entries === undefined || Array.isArray(plan.branch_entries) && plan.branch_entries.every(entry))
    && (plan.preserve_paths === undefined || strings(plan.preserve_paths));
  return isRecord(value) && value.id === id && ["title", "scope", "operator", "created_at", "stage"].every(key => typeof value[key] === "string")
    && ["idle", "queued", "running", "done", "failed", "cancelled"].includes(value.status) && target(value.knowledge_target)
    && Array.isArray(value.repositories) && value.repositories.every(target) && strings(value.material_ids) && strings(value.ar_codes)
    && revisionMap(value.revisions) && Array.isArray(value.evidence) && value.evidence.every(isRecord)
    && (value.source_repositories === undefined || Array.isArray(value.source_repositories) && value.source_repositories.every(target))
    && (value.cleanup_plans === undefined || Array.isArray(value.cleanup_plans) && value.cleanup_plans.every(cleanup))
    && (value.technologies === undefined || strings(value.technologies))
    && Array.isArray(value.documents) && value.documents.every((doc: any) => document(doc)
      && [value.knowledge_target, ...value.repositories].some(target => target.id === doc.target_id))
    && Array.isArray(value.turns) && value.turns.every((turn: any) => isRecord(turn)
      && fields(turn, ["id", "message", "operator", "created_at"]) && ["extract", "discuss", "revise", "update"].includes(turn.mode) && strings(turn.document_ids)
      && ["queued", "running", "done", "failed", "cancelled"].includes(turn.status) && Array.isArray(turn.proposals)
      && (turn.research === undefined || research(turn.research))
      && (turn.revisions === undefined || revisionMap(turn.revisions)) && (turn.previous_revisions === undefined || revisionMap(turn.previous_revisions))
      && turn.proposals.every((proposal: any) => isRecord(proposal) && content(proposal.document) && Number.isSafeInteger(proposal.base_revision)
        && ["pending", "accepted", "discarded"].includes(proposal.status)))
    && (!["queued", "running"].includes(value.status) || value.turns.some((turn: any) => ["queued", "running"].includes(turn.status)))
    && Array.isArray(value.publications) && value.publications.every(publication)
    && (value.publication_history === undefined || Array.isArray(value.publication_history) && value.publication_history.every(publication))
    && (value.archive_batches === undefined || Array.isArray(value.archive_batches) && value.archive_batches.every((batch: any) => isRecord(batch)
      && fields(batch, ["id", "created_at", "operator"]) && ["pending", "running", "done", "failed", "superseded"].includes(batch.state)
      && Array.isArray(batch.documents) && batch.documents.every(document) && Array.isArray(batch.targets) && batch.targets.every(target)
      && batch.documents.every((doc: any) => batch.targets.some((target: any) => target.id === doc.target_id))
      && Array.isArray(batch.publications) && batch.publications.every(publication)));
}

interface DomainRunning {
  controller: AbortController;
  work: Promise<void>;
  released: Promise<void>;
  release: () => void;
  turn: DomainTurn;
  stopTimer?: ReturnType<typeof setTimeout>;
}

export class DomainKnowledgeExtraction {
  private jobs = new Map<string, DomainKnowledgeJob>();
  private running = new Map<string, DomainRunning>();
  private readWarnings: string[] = [];
  private publishing = new Map<string, symbol>();
  private archiving = new Map<string, Promise<void>>();
  private archiveQueue: Promise<void> = Promise.resolve();
  private stopped = false;
  constructor(readonly dataDir: string, private execute: (input: DomainExecution) => Promise<string>, private options: {
    publish?: (job: DomainKnowledgeJob, target: KnowledgeRepository, previous: DomainPublication | undefined, operator: string, save: (publication: DomainPublication) => void) => Promise<DomainPublication>;
    refresh?: (job: DomainKnowledgeJob, publication: DomainPublication, operator: string) => Promise<DomainPublication>;
    previewCleanup?: (job: DomainKnowledgeJob, target: KnowledgeRepository, input: unknown, operator: string) => Promise<KnowledgeCleanupPlan>;
    readRemote?: (job: DomainKnowledgeJob, document: DomainDocument, operator: string) => Promise<DomainRemoteReview>;
    onStopTimeout?: (job: DomainKnowledgeJob) => void;
    shutdown?: () => Promise<void>;
  } = {}) {
    const root = join(dataDir, "domain-extraction");
    if (existsSync(root)) for (const name of readdirSync(root).filter(n => /^dkx-[a-f0-9-]{36}$/.test(n))) {
      const path = join(root, name, "job.json");
      if (!existsSync(path)) continue;
      try {
        const job: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!validStoredJob(job, name)) throw new Error("记录形状无效");
        let changed = false;
        for (const batch of job.archive_batches ?? []) if (batch.state === "running") { batch.state = "pending"; changed = true; }
        if (!job.deleted_at && ["queued", "running"].includes(job.status)) {
          job.status = "queued"; job.stage = "接续原研究会话"; changed = true;
          for (const turn of job.turns) if (["queued", "running"].includes(turn.status)) { turn.status = "queued"; turn.error = undefined; }
        }
        if (changed) this.persist(job);
        this.jobs.set(job.id, job);
      } catch {
        // repros/r8 实测：单条坏文件不能阻断其他记录，不删除或重写现场。
        this.readWarnings.push(`请检查损坏的知识记录：domain-extraction/${name}/job.json；其余任务照常可用`);
      }
    }
    queueMicrotask(() => { this.pump(); for (const job of this.jobs.values()) this.scheduleArchive(job.id); });
  }
  private root(id: string) { return join(this.dataDir, "domain-extraction", id); }
  private live(id: string) { const job = this.jobs.get(id); if (!job || job.deleted_at) throw new Error("领域萃取任务不存在或已删除"); return job; }
  private acquirePublication(id: string) {
    if (this.stopped) throw new Error("服务正在停止");
    if (this.publishing.has(id)) throw new Error("正在归档或核对远端，请等待当前操作完成");
    const owner = Symbol(id);
    this.publishing.set(id, owner);
    return owner;
  }
  private releasePublication(id: string, owner: symbol) {
    if (this.publishing.get(id) !== owner) return false;
    this.publishing.delete(id);
    return true;
  }
  private assertPublicationOwner(id: string, owner: symbol) {
    if (this.publishing.get(id) !== owner) throw new Error("服务已停止，迟到结果未保存");
  }
  private persist(job: DomainKnowledgeJob) {
    mkdirSync(this.root(job.id), { recursive: true });
    const path = join(this.root(job.id), "job.json");
    durableWriteFileSync(path, JSON.stringify(job), { mode: 0o600 });
  }
  warnings() { return [...this.readWarnings]; }
  get(id: string) { return structuredClone(this.live(id)); }
  list() { return [...this.jobs.values()].filter(job => !job.component_research_id && !job.deleted_at).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(job => ({ ...structuredClone(job), documents: job.documents.map(({ content: _, history: __, base_content: ___, remote_review: ____, ...doc }) => doc), evidence: [], turns: [], publications: [], publication_history: [] })); }
  componentArchive(researchId: string) {
    const job = [...this.jobs.values()].find(job => job.component_research_id === researchId);
    return job ? this.get(job.id) : undefined;
  }
  prepareComponent(input: { research_id: string; title: string; content: string; sources: string; language: string;
    target: unknown; filename: unknown; issue_no: unknown; issue_description?: unknown; base_revision?: number; knowledge_revision?: string;
    research_source?: DomainKnowledgeJob["component_source"] }, operator: string) {
    if (this.stopped) throw new Error("服务正在停止");
    if (!input.content?.trim()) throw new Error("请提供非空的组件知识正文");
    const issue_no = knowledgeIssueNumber(input.issue_no), issue_description = knowledgeIssueDescription(input.issue_description), target = repository(input.target, "domain");
    const filename = knowledgeRelativePath(input.filename, true);
    if (filename.includes("/")) throw new Error("文件名不能包含目录，请在归档目录中填写路径");
    const path = `${target.docs_path}/${filename}`;
    const existing = this.componentArchive(input.research_id);
    const job: DomainKnowledgeJob = existing ? this.live(existing.id) : {
      id: `dkx-${randomUUID()}`, component_research_id: input.research_id, technologies: [input.language],
      title: input.title, scope: "基础组件知识归档", issue_no, issue_description, operator, created_at: new Date().toISOString(),
      repositories: [], knowledge_target: target, material_ids: [], ar_codes: [], use_wxdoubao: false,
      status: "done", stage: "待审查提交内容", revisions: {}, documents: [], turns: [], evidence: [], publications: [],
    };
    this.assertEditable(job);
    const owner = this.acquirePublication(job.id);
    try {
    if (existing && input.base_revision !== job.documents[0].revision) throw new Error("归档草稿已有新版本，请刷新后重新准备");
    const changedTarget = JSON.stringify(job.knowledge_target) !== JSON.stringify(target) || job.documents[0]?.path !== path;
    if (job.publications.length && (changedTarget || job.issue_no !== issue_no)) throw new Error("已发起归档，不能更换目标仓、分支、路径或关联单号");
    if (issue_description !== undefined && job.issue_description && job.issue_description !== issue_description && this.hasAttemptedMr(job)) throw new Error("已发起 MR 创建，不能更改本任务的单号描述");
    const candidate = { ...job, knowledge_target: target };
    const parts = componentArchiveParts(input.content);
    const document: DomainDocumentContent = { id: "component-guide", title: input.title, target_id: "domain", path, layer: "domain", content: parts.content, sources: input.sources };
    this.validateDocument(candidate, document);
    const old = job.documents[0];
    const formal = old?.knowledge_document_id ? readKnowledgeDocument(this.dataDir, old.knowledge_document_id)
      : listKnowledgeDocuments(this.dataDir).find(doc => doc.research_source?.job_id === input.research_id);
    const formalRevision = input.knowledge_revision === formal?.revision ? input.knowledge_revision : old?.published_revision ?? input.knowledge_revision;
    if (formal && (formalRevision ? formal.revision !== formalRevision : formal.content !== input.content)) throw new Error("正式知识已有其他修改，请核对当前知识后再准备归档，未覆盖人工修改");
    const next: DomainDocument = { ...document, component_metadata: parts.component_metadata, selected: true, revision: (old?.revision ?? 0) + 1,
      knowledge_document_id: old?.knowledge_document_id ?? formal?.id, published_revision: formalRevision ?? formal?.revision,
      published_document_revision: old?.published_document_revision, published_at: old?.published_at,
      base_content: changedTarget ? null : old?.base_content ?? null, base_revision: changedTarget ? "" : old?.base_revision ?? "",
      history: old ? [...old.history, { revision: old.revision, title: old.title, content: old.content, component_metadata: old.component_metadata, sources: old.sources, operator, at: new Date().toISOString() }] : [],
    };
    Object.assign(job, { title: input.title, issue_no, issue_description: issue_description ?? (job.issue_no === issue_no ? job.issue_description : undefined), knowledge_target: target, documents: [next],
      component_source: input.research_source ?? job.component_source, stage: "待审查提交内容" });
    this.jobs.set(job.id, job); this.persist(job); return this.get(job.id);
    } finally { this.releasePublication(job.id, owner); this.scheduleArchive(job.id); }
  }
  create(input: any, operator: string) { return this.createJob(input, operator); }
  beginUpdate(documentId: string, input: { message?: string; expected_revision?: string; material_ids?: string[]; ar_codes?: string[] }, operator: string) {
    const published = readKnowledgeDocument(this.dataDir, documentId);
    if (input.expected_revision && input.expected_revision !== published.revision) throw new Error("知识已有新版本，请刷新后发起更新");
    const original = this.jobs.get(published.research_source?.job_id ?? "");
    if (!original || original.component_research_id) throw new Error("此知识不属于领域研究，请使用其原有维护入口");
    const source = original.documents.find(d => d.knowledge_document_id === documentId
      || d.id === published.research_source?.document_id || d.path === published.research_source?.path);
    if (!source) throw new Error("找不到知识的研究来源，不能猜测更新基线");
    const document: DomainDocument = { ...structuredClone(source), title: published.title, content: published.content,
      knowledge_document_id: published.id, published_revision: published.revision, published_document_revision: 1,
      revision: 1, history: [], selected: true, human_edited: true, research_turn_id: undefined, remote_review: undefined };
    const job: DomainKnowledgeJob = { ...structuredClone(original), id: `dkx-${randomUUID()}`, operator,
      created_at: new Date().toISOString(), deleted_at: undefined, deleted_by: undefined, status: "idle", stage: "准备增量研究",
      documents: [document], turns: [], evidence: [], archive_batches: [], publication_history: [],
      revisions: { ...(published.research_source?.source_revisions ?? original.revisions) },
      material_ids: published.research_source?.material_ids ?? original.material_ids, cleanup_plans: undefined };
    this.jobs.set(job.id, job); this.persist(job);
    return this.run(job.id, { mode: "update", document_ids: [document.id], message: input.message?.trim() || "核对来源变化，更新受影响知识；保留现有人工内容，无变化时说明原因",
      material_ids: input.material_ids, ar_codes: input.ar_codes }, operator);
  }
  private createJob(input: any, operator: string) {
    if (this.stopped) throw new Error("服务正在停止");
    if ([...this.jobs.values()].filter(job => ["queued", "running"].includes(job.status)).length >= 50) throw new Error("当前研究队列已满，请稍后创建");
    const issue_no = knowledgeIssueNumber(input.issue_no), issue_description = knowledgeIssueDescription(input.issue_description);
    const module_id = input.module_id ? String(input.module_id) : undefined;
    if (module_id) {
      const module = readBusinessModule(this.dataDir, module_id);
      if (module.status !== "active") throw new Error("业务模块已停用");
      input = { ...input, title: module.name, scope: `业务模块：${module.name}。模块说明：${module.description}`,
        repositories: module.repositories.map(url => ({ repository: url, name: url.split("/").at(-1)?.replace(/\.git$/, "") || module.name, branch: input.baseline_branch || "master", path: "" })) };
    }
    const title = String(input.title ?? "").trim(), scope = String(input.scope ?? "").trim();
    if (input.instructions !== undefined && typeof input.instructions !== "string") throw new Error("本次要求须为文本");
    const instructions = input.instructions?.trim() || undefined;
    if (instructions && instructions.length > 20000) throw new Error("本次要求最多 20000 字");
    if (!title || title.length > 160 || !scope || scope.length > 10000) throw new Error("请填写业务域名称及本次研究范围");
    if (!Array.isArray(input.repositories) || input.repositories.length > 30) throw new Error("业务仓须为数组，最多 30 个；无源码时可传空数组");
    const defaults = knowledgeArchiveDefaults(new KnowledgeExtractionSkills(this.dataDir).current("domain").files, "domain");
    const repositories = input.repositories.map((r: any, i: number) => repository({ ...r, docs_path: r.docs_path || defaults.repository_directory }, `repo-${i + 1}`));
    const configured = readKnowledgeRepoConfig(this.dataDir);
    const knowledge_target = input.knowledge_target ? repository(input.knowledge_target, "domain") : {
      id: "domain", name: "领域知识仓", repository: configured?.url || "", branch: configured?.branch || "master", path: "",
      docs_path: configured?.docs_path || defaults.domain_directory,
    };
    if (new Set(repositories.map(r => r.repository)).size !== repositories.length || (input.knowledge_target && repositories.some(r => r.repository === knowledge_target.repository))) throw new Error("业务仓不能重复，领域知识仓须独立指定");
    const material_ids = this.materialIds(input.material_ids ?? []);
    const ar_codes = this.arCodes(input.ar_codes ?? []);
    scanForSecrets("业务范围", Buffer.from(JSON.stringify({ title, scope, instructions, ar_codes })));
    const job: DomainKnowledgeJob = { id: `dkx-${randomUUID()}`, title, scope, instructions, issue_no, issue_description, module_id, operator, created_at: new Date().toISOString(), repositories, knowledge_target,
      source_repositories: structuredClone(repositories), archive_configured: !!input.knowledge_target, archive_revision: 0,
      material_ids, ar_codes, use_wxdoubao: true, status: "idle", stage: "准备研究", revisions: {}, documents: [], turns: [], evidence: [], publications: [] };
    this.jobs.set(job.id, job); this.persist(job);
    return this.run(job.id, { mode: "extract", message: scope }, operator);
  }
  configureArchive(id: string, input: { targets: unknown; documents?: unknown; base_revision?: number }) {
    const job = this.live(id);
    if (job.component_research_id) throw new Error("请使用组件归档设置");
    if (this.publishing.has(id) || ["queued", "running"].includes(job.status)) throw new Error("请等待当前操作完成再设置归档位置");
    if (input.base_revision !== (job.archive_revision ?? 0)) throw new Error("归档位置已被修改，请刷新后重新设置");
    if (!Array.isArray(input.targets) || !input.targets.length) throw new Error("请提供归档目标");
    const previous = [job.knowledge_target, ...job.repositories], candidate = structuredClone(job);
    const ids = new Set<string>();
    for (const value of input.targets) {
      const old = previous.find(t => t.id === value?.id);
      if (!old || ids.has(old.id)) throw new Error("归档目标无效或重复");
      ids.add(old.id);
      const next = repository({ ...value, path: old.path, name: old.name }, old.id);
      const changed = next.repository !== old.repository || next.branch !== old.branch || next.docs_path !== old.docs_path;
      if (changed && [...job.publications, ...(job.publication_history ?? [])].some(p => p.target_id === old.id)) throw new Error("此仓已发起归档，不能更换位置；后续更新继续使用原 MR 目标");
      if (next.id === "domain") candidate.knowledge_target = next;
      else candidate.repositories = candidate.repositories.map(t => t.id === next.id ? next : t);
      if (!changed && job.archive_configured !== false) continue;
      const remap = (path: string) => {
        if (!path.startsWith(`${old.docs_path}/`)) return path;
        return `${next.docs_path}/${path.slice(old.docs_path.length + 1)}`;
      };
      for (const doc of candidate.documents.filter(d => d.target_id === old.id)) {
        if (!doc.archive_path) doc.path = remap(doc.path);
        doc.base_content = null; doc.base_revision = ""; delete doc.remote_review;
      }
      for (const turn of candidate.turns) for (const proposal of turn.proposals.filter(p => p.document.target_id === old.id)) proposal.document.path = candidate.documents.find(d => d.id === proposal.document.id)?.path ?? remap(proposal.document.path);
      candidate.cleanup_plans = candidate.cleanup_plans?.filter(p => p.target_id !== old.id);
    }
    if (input.documents !== undefined) {
      if (!Array.isArray(input.documents)) throw new Error("请提供各文件的归档路径");
      const documentIds = new Set<string>();
      for (const value of input.documents) {
        const doc = candidate.documents.find(d => d.id === value?.id);
        if (!doc || documentIds.has(doc.id)) throw new Error("归档文件无效或重复");
        documentIds.add(doc.id);
        const path = knowledgeRelativePath(value.path, true);
        if (path !== doc.path) {
          if ([...job.publications, ...(job.publication_history ?? [])].some(p => p.target_id === doc.target_id)) throw new Error("此仓已发起归档，不能更换文件路径；后续更新继续使用原路径");
          doc.path = path; doc.base_content = null; doc.base_revision = ""; delete doc.remote_review;
          for (const turn of candidate.turns) for (const proposal of turn.proposals.filter(p => p.document.id === doc.id)) proposal.document.path = path;
          candidate.cleanup_plans = candidate.cleanup_plans?.filter(p => p.target_id !== doc.target_id);
        }
        doc.archive_path = path;
      }
    }
    const targets = [candidate.knowledge_target, ...candidate.repositories], paths = new Set<string>();
    for (const doc of candidate.documents.filter(d => d.selected)) {
      const target = targets.find(t => t.id === doc.target_id)!;
      repository(target, target.id);
      const key = JSON.stringify([target.repository, target.branch, doc.path]);
      if (paths.has(key)) throw new Error("多个知识文档指向同一个目标文件，请调整归档目录");
      paths.add(key);
    }
    candidate.source_repositories ??= structuredClone(job.repositories);
    candidate.archive_configured = true; candidate.archive_revision = (job.archive_revision ?? 0) + 1;
    Object.assign(job, candidate); this.persist(job); return this.get(id);
  }
  private materialIds(ids: unknown): string[] {
    if (!Array.isArray(ids) || ids.length > 30 || ids.some(id => typeof id !== "string")) throw new Error("最多关联 30 份资料");
    const unique = [...new Set(ids)] as string[];
    const bytes = unique.reduce((sum, id) => sum + readKnowledgeMaterial(join(this.dataDir, "knowledge-materials"), id).bytes, 0);
    if (bytes > 100 * 1024 * 1024) throw new Error("本次资料总容量不能超过 100 MiB");
    return unique;
  }
  private arCodes(codes: unknown): string[] {
    if (!Array.isArray(codes) || codes.length > 30 || codes.some(code => typeof code !== "string" || !/^[A-Za-z0-9_.-]{1,120}$/.test(code))) throw new Error("AR 编号格式无效，最多 30 项");
    return [...new Set(codes)] as string[];
  }
  run(id: string, input: { mode: DomainTurn["mode"]; document_ids?: string[]; message?: string; use_latest_skill?: boolean; material_ids?: string[]; ar_codes?: string[] }, operator: string) {
    if (this.stopped) throw new Error("服务正在停止");
    const job = this.live(id);
    if (job.component_research_id) throw new Error("请在基础组件萃取任务中生成修订建议");
    if (this.running.has(id) || this.publishing.has(id) || ["queued", "running"].includes(job.status)) throw new Error("请等待本轮完成或停止后继续");
    if (!["extract", "discuss", "revise", "update"].includes(input.mode)) throw new Error("未知研究操作");
    const ids = [...new Set(input.document_ids ?? [])], message = String(input.message ?? "").trim();
    if (input.mode !== "extract" && (!ids.length || ids.some(docId => !job.documents.some(doc => doc.id === docId)))) throw new Error("请选择本轮处理的文档");
    if (!message || message.length > 20000) throw new Error("请填写本轮问题或修订要求，最多 20000 字");
    scanForSecrets("研究意见", Buffer.from(message));
    if (input.material_ids) job.material_ids = this.materialIds(input.material_ids);
    if (input.ar_codes) job.ar_codes = this.arCodes(input.ar_codes);
    job.use_wxdoubao = true;
    const turn: DomainTurn = { id: randomUUID(), mode: input.mode, document_ids: ids, message, operator, status: "queued", created_at: new Date().toISOString(), proposals: [], use_latest_skill: input.use_latest_skill === true };
    if (input.mode === "update") { turn.previous_revisions = { ...job.revisions }; job.revisions = {}; }
    job.turns.push(turn); job.status = "queued"; job.stage = "等待研究"; job.error = undefined;
    this.persist(job); this.pump(); return this.get(id);
  }
  resume(id: string, operator: string, useLatestSkill = false) {
    if (this.stopped) throw new Error("服务正在停止");
    const job = this.live(id), turn = job.turns.at(-1);
    if (job.component_research_id || this.running.has(id) || this.publishing.has(id) || !turn
        || !["failed", "cancelled", "done"].includes(job.status)) throw new Error("当前任务不能接续");
    if (job.status === "done" && turn.mode !== "extract") throw new Error("请选择文档发起新的修订");
    turn.pipeline_continue = (turn.pipeline_continue ?? 0) + 1;
    turn.status = "queued"; turn.operator = operator; turn.error = undefined;
    if (useLatestSkill) { turn.use_latest_skill = true; turn.skill = undefined; }
    if (turn.research) { turn.research.phase = "research"; turn.research.finish_requested = false; }
    job.status = "queued"; job.stage = "接续原研究会话"; job.error = undefined;
    this.persist(job); this.pump(); return this.get(id);
  }
  private validateDocument(job: DomainKnowledgeJob, input: DomainDocumentContent) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(input.id) || !input.title?.trim() || input.title.length > 160 || !input.content?.trim() || !input.sources?.trim()) throw new Error("文档需要稳定编号、标题、正文与来源");
    const maxBytes = (job.component_research_id ? 16 : 2) * 1024 * 1024;
    if (Buffer.byteLength(input.content) > maxBytes) throw new Error(`单份草稿不能超过 ${maxBytes / 1024 / 1024} MiB`);
    const target = [job.knowledge_target, ...job.repositories].find(r => r.id === input.target_id);
    if (!target || input.layer !== (target.id === "domain" ? "domain" : "repository")) throw new Error("领域文档进入知识仓，仓内文档进入对应业务仓");
    const path = knowledgeRelativePath(input.path, true);
    const approved = job.documents.find(doc => doc.id === input.id && doc.target_id === input.target_id)?.archive_path;
    if (!path.startsWith(`${target.docs_path}/`) && path !== approved) throw new Error("文档只能写入默认目录或已设置的文件归档路径");
    if (job.documents.some(doc => doc.id !== input.id && doc.target_id === input.target_id && doc.path === path)) throw new Error("该目标文件已有草稿，请更新原编号");
    scanForSecrets("领域知识草稿", Buffer.from(JSON.stringify(input)));
  }
  private pump() {
    if (this.stopped) return;
    for (const job of this.jobs.values()) {
      if (this.running.size >= 2) return;
      if (job.deleted_at || job.status !== "queued" || this.running.has(job.id)) continue;
      const turn = job.turns.find(t => t.status === "queued")!;
      const controller = new AbortController(), base = structuredClone(job.documents);
      let release!: () => void;
      const entry: DomainRunning = { controller, turn, work: Promise.resolve(), released: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
      turn.document_revisions ??= Object.fromEntries(base.map(doc => [doc.id, doc.revision]));
      const earlierTurns = job.turns.slice(0, job.turns.indexOf(turn)).reverse();
      const workingDocuments = base.map(doc => {
        if (turn.mode === "extract") return doc;
        const resumed = turn.proposals.find(proposal => proposal.document.id === doc.id && proposal.status === "pending" && proposal.base_revision === doc.revision);
        const previous = earlierTurns.find(previous => previous.status === "done" && previous.proposals.some(proposal => proposal.document.id === doc.id && proposal.status === "pending" && proposal.base_revision === doc.revision));
        const proposal = resumed ?? previous?.proposals.find(proposal => proposal.document.id === doc.id && proposal.status === "pending" && proposal.base_revision === doc.revision);
        // 后续意见接着已完成的新稿修改，正文与发布基线仍等人工确认。
        return proposal ? { ...doc, title: proposal.document.title, content: proposal.document.content, sources: proposal.document.sources } : doc;
      });
      job.status = "running"; job.stage = "研究中"; turn.status = "running"; this.persist(job);
      const work = Promise.resolve().then(async () => {
        try {
          if (controller.signal.aborted) return;
          const reply = await this.execute({ job: { ...this.get(job.id), documents: structuredClone(workingDocuments) }, turn: structuredClone(turn), root: this.root(job.id), signal: controller.signal,
            read: () => structuredClone(turn.mode === "extract" ? job.documents : workingDocuments),
            update: patch => { if (!controller.signal.aborted && !job.deleted_at) { const { research, ...rest } = patch; Object.assign(job, rest); if (research) turn.research = structuredClone(research); if (patch.skill) turn.skill = patch.skill; if (patch.revisions) turn.revisions = { ...turn.revisions, ...patch.revisions }; this.persist(job); } },
            evidence: event => { if (!controller.signal.aborted && !job.deleted_at) { scanForSecrets("研究记录", Buffer.from(JSON.stringify(event))); job.evidence.push({ at: new Date().toISOString(), ...event }); this.persist(job); } },
            save: (input, baseline) => {
              if (controller.signal.aborted || job.deleted_at) throw new Error("本轮已停止");
              if (turn.mode === "discuss") throw new Error("讨论不修改文档");
              // Model output is content only; publication and human-review fields
              // are exclusively managed by explicit service operations.
              input = { id: input.id, title: input.title, target_id: input.target_id, path: input.path, layer: input.layer, content: input.content, sources: input.sources };
              this.validateDocument(job, input);
              const existing = job.documents.find(doc => doc.id === input.id);
              if (existing && (existing.target_id !== input.target_id || existing.path !== input.path || existing.layer !== input.layer)) throw new Error("已有文档不能改变归档位置");
              if (turn.mode !== "extract") {
                if (!turn.document_ids.includes(input.id)) throw new Error("只能修订本轮选中文档");
                const previous = turn.proposals.find(p => p.document.id === input.id);
                turn.proposals = [...turn.proposals.filter(p => p.document.id !== input.id), { document: structuredClone(input), base_revision: previous?.base_revision ?? turn.document_revisions![input.id], status: "pending" }];
                Object.assign(workingDocuments.find(doc => doc.id === input.id)!, structuredClone(input));
                this.persist(job);
              } else {
                // Continuing an interrupted extraction must preserve already completed or edited documents.
                if (existing) {
                  if (Object.entries(input).every(([key, value]) => existing[key as keyof DomainDocument] === value)) return structuredClone(input);
                  const owned = existing.research_turn_id === turn.id || (!existing.research_turn_id && existing.revision === 1 && !existing.history.length);
                  if (!owned || existing.human_edited || [...job.publications, ...(job.publication_history ?? [])].some(p => p.documents.some(d => d.id === existing.id))) throw new Error("该草稿已有人工修改、已归档或属于其他研究轮，请通过局部修订生成建议");
                  existing.history.push({ revision: existing.revision, title: existing.title, content: existing.content, sources: existing.sources, operator: "领域研究 Agent", at: new Date().toISOString() });
                  Object.assign(existing, input, { revision: existing.revision + 1, research_turn_id: turn.id });
                  this.persist(job); return structuredClone(input);
                }
                if (job.archive_configured !== false && (!baseline || !/^[a-f0-9]{40,64}$/.test(baseline.revision))) throw new Error("尚未读取目标文件的归档基线");
                job.documents.push({ ...structuredClone(input), revision: 1, research_turn_id: turn.id, selected: true, base_content: baseline?.content ?? null, base_revision: baseline?.revision ?? "", history: [] });
                this.persist(job);
              }
              return structuredClone(input);
            },
          });
          if (controller.signal.aborted || job.deleted_at) return;
          if (!reply.trim()) throw new Error("本轮没有返回结果");
          scanForSecrets("研究答复", Buffer.from(reply));
          if (turn.mode === "extract" && !job.documents.length) throw new Error("尚未生成领域知识草稿，已保存内容保留");
          turn.reply = reply; turn.status = "done"; job.status = "done"; job.stage = "本轮完成，等待审查";
        } catch (error) {
          if (controller.signal.aborted || job.deleted_at) return;
          turn.status = "failed"; job.status = "failed"; job.error = turn.error = error instanceof Error ? error.message : "研究失败"; job.stage = error instanceof IncompleteDomainResearch ? "研究尚未完成，草稿与进度保留" : "本轮失败，已有文档保留";
        } finally { if (!controller.signal.aborted && this.running.get(job.id) === entry) this.persist(job); }
      }).finally(() => {
        // 强制释放后可能已有新一轮，旧 finally 不能释放新一轮的槽位或再落旧盘。
        if (this.running.get(job.id) !== entry) return;
        clearTimeout(entry.stopTimer); this.running.delete(job.id); entry.release(); this.pump();
      });
      entry.work = work; this.running.set(job.id, entry);
    }
  }
  private assertEditable(job: DomainKnowledgeJob) {
    let status = job.status;
    if (job.component_research_id) {
      const path = join(this.dataDir, "component-research", job.component_research_id, "record.json");
      if (existsSync(path)) {
        try { status = JSON.parse(readFileSync(path, "utf8")).status; }
        catch { throw new Error(`请检查损坏的知识记录：component-research/${job.component_research_id}/record.json`); }
      }
    }
    if (["queued", "running"].includes(status)) throw new Error("研究进行中：请先停止，或等本轮结束后再改");
  }
  edit(id: string, input: { document: DomainDocumentContent; base_revision: number }, operator: string) {
    const job = this.live(id), doc = job.documents.find(d => d.id === input.document?.id);
    this.assertEditable(job);
    if (!doc || this.publishing.has(id)) throw new Error("文档不存在或正在归档");
    if (input.base_revision !== doc.revision) throw new Error("文档已有新版本，请比较差异后重新保存");
    this.validateDocument(job, input.document);
    if (doc.target_id !== input.document.target_id || doc.path !== input.document.path || doc.layer !== input.document.layer) throw new Error("不能通过编辑改变归档位置");
    doc.history.push({ revision: doc.revision, title: doc.title, content: doc.content, component_metadata: doc.component_metadata, sources: doc.sources, operator, at: new Date().toISOString() });
    Object.assign(doc, { title: input.document.title, content: input.document.content, sources: input.document.sources, revision: doc.revision + 1, human_edited: true }); this.persist(job); return this.get(id);
  }
  decide(id: string, turnId: string, documentId: string, decision: "accept" | "discard", operator: string) {
    const job = this.live(id), turn = job.turns.find(t => t.id === turnId), proposal = turn?.proposals.find(p => p.document.id === documentId);
    if (turn && ["queued", "running"].includes(turn.status)) throw new Error("本轮仍在生成修订建议，请等待完成");
    if (!proposal || !["accept", "discard"].includes(decision)) throw new Error("修订建议或操作无效");
    if (decision === "accept" && ["queued", "running"].includes(job.status)) throw new Error("当前研究仍在进行，请等待完成后再确认修改");
    if (proposal.status !== "pending") return this.get(id);
    if (decision === "accept") {
      if (turn!.status !== "done") throw new Error("本轮修改尚未完成，请重试完成后再确认");
      if (job.turns.slice(job.turns.indexOf(turn!) + 1).some(later => later.proposals.some(item => item.document.id === documentId && item.status === "pending"))) throw new Error("已有更新的修改建议，请重新检视；如需使用此建议，请先放弃后续建议");
      this.edit(id, { document: proposal.document, base_revision: proposal.base_revision }, operator);
      for (const old of job.turns.flatMap(item => item.proposals)) if (old !== proposal && old.document.id === documentId && old.status === "pending") old.status = "discarded";
    }
    proposal.status = decision === "accept" ? "accepted" : "discarded"; this.persist(job); return this.get(id);
  }
  restore(id: string, documentId: string, revision: number, baseRevision: number, operator: string) {
    this.assertEditable(this.live(id));
    const doc = this.live(id).documents.find(d => d.id === documentId), previous = doc?.history.find(h => h.revision === revision);
    if (!doc || !previous) throw new Error("历史版本不存在");
    this.edit(id, { document: { ...doc, content: previous.content, title: previous.title, sources: previous.sources }, base_revision: baseRevision }, operator);
    doc.component_metadata = previous.component_metadata;
    this.persist(this.live(id)); return this.get(id);
  }
  async readRemote(id: string, documentId: string, operator: string) {
    const job = this.live(id), doc = job.documents.find(d => d.id === documentId);
    if (job.archive_configured === false) throw new Error("请先在入库与更新中保存归档位置");
    if (!doc || !this.options.readRemote) throw new Error("无法读取该文档的远端版本");
    const owner = this.acquirePublication(id);
    try {
      const review = await this.options.readRemote(this.get(id), structuredClone(doc), operator);
      this.assertPublicationOwner(id, owner);
      doc.remote_review = review; this.persist(job); return this.get(id);
    }
    catch (error) { this.assertPublicationOwner(id, owner); throw error; }
    finally { this.releasePublication(id, owner); this.scheduleArchive(id); }
  }
  reconcile(id: string, input: { document: DomainDocumentContent; base_revision: number; snapshot_id: string }, operator: string) {
    this.assertEditable(this.live(id));
    const doc = this.live(id).documents.find(d => d.id === input.document?.id);
    if (!doc?.remote_review || doc.remote_review.id !== input.snapshot_id) throw new Error("远端比较版本已变化，请重新读取并核对");
    this.edit(id, input, operator);
    doc.remote_review.reviewed = true;
    this.persist(this.live(id)); return this.get(id);
  }
  select(id: string, ids: string[], selected: boolean) {
    const job = this.live(id);
    if (this.publishing.has(id) || !Array.isArray(ids) || typeof selected !== "boolean" || ids.some(docId => !job.documents.some(d => d.id === docId))) throw new Error("请选择有效文档，归档时不能调整清单");
    job.documents.forEach(doc => { if (ids.includes(doc.id)) doc.selected = selected; }); this.persist(job); return this.get(id);
  }
  stop(id: string) {
    const job = this.live(id);
    if (["queued", "running"].includes(job.status)) {
      job.status = "cancelled"; job.stage = "已停止，草稿保留";
      job.turns.filter(t => ["queued", "running"].includes(t.status)).forEach(t => t.status = "cancelled");
      const entry = this.running.get(id);
      if (entry) this.stopExecution(job, entry);
      this.persist(job);
    }
    return this.get(id);
  }
  private stopExecution(job: DomainKnowledgeJob, entry: DomainRunning) {
    entry.controller.abort();
    if (entry.stopTimer) return;
    entry.stopTimer = setTimeout(() => {
      if (this.running.get(job.id) !== entry) return;
      this.running.delete(job.id); entry.release();
      try {
        if (!job.deleted_at) {
          job.status = "failed"; job.stage = STOP_TIMEOUT; job.error = STOP_TIMEOUT;
          entry.turn.status = "failed"; entry.turn.error = STOP_TIMEOUT;
          try { this.persist(job); }
          catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            const reason = `${code ? `${code}：` : ""}${error instanceof Error ? error.message : String(error)}`;
            job.error = `${STOP_TIMEOUT}；状态记录保存失败：${reason}`;
            entry.turn.error = job.error;
            this.readWarnings.push(`请检查状态记录保存失败：domain-extraction/${job.id}/job.json；${reason}；并发槽位已释放`);
          }
          try { this.options.onStopTimeout?.(this.get(job.id)); }
          catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.readWarnings.push(`请检查停止超时通知失败：domain-extraction/${job.id}/job.json；${reason}；并发槽位已释放`);
          }
        }
      } finally { this.pump(); }
    }, STOP_BUDGET_MS);
    entry.stopTimer.unref?.();
  }
  remove(id: string, operator: string) {
    const existing = this.jobs.get(id);
    if (existing?.deleted_at) return { deleted: true };
    const job = this.live(id);
    if (job.component_research_id) throw new Error("请在基础组件萃取中管理对应任务");
    if (this.publishing.has(id)) throw new Error("正在归档或核对远端，请等待当前操作完成后再删除");
    this.stop(id);
    // Keep source and MR history for published knowledge, as component task deletion does.
    job.deleted_at = new Date().toISOString(); job.deleted_by = operator;
    this.persist(job); this.pump(); return { deleted: true };
  }
  async previewCleanup(id: string, targetId: string, input: unknown, operator: string) {
    const job = this.live(id), target = [job.knowledge_target, ...job.repositories].find(t => t.id === targetId);
    if (job.archive_configured === false) throw new Error("请先保存归档位置再预览清理范围");
    if (!target || !this.options.previewCleanup) throw new Error("无法预览此仓的清理范围");
    if (["queued", "running"].includes(job.status)) throw new Error("请等待当前操作完成");
    const owner = this.acquirePublication(id);
    try {
      const plan = await this.options.previewCleanup(this.get(id), target, input, operator);
      this.assertPublicationOwner(id, owner);
      job.cleanup_plans = [...(job.cleanup_plans ?? []).filter(p => p.target_id !== targetId), plan];
      this.persist(job); return this.get(id);
    } catch (error) { this.assertPublicationOwner(id, owner); throw error; }
    finally { this.releasePublication(id, owner); this.scheduleArchive(id); }
  }
  confirmCleanup(id: string, planId: string, confirmed: boolean, preservePaths?: unknown) {
    const job = this.live(id), plan = job.cleanup_plans?.find(p => p.id === planId);
    if (!plan || typeof confirmed !== "boolean") throw new Error("清理预览已变化，请重新预览");
    if (this.publishing.has(id)) throw new Error("正在归档，不能改变清理选项");
    if ([...job.publications, ...(job.publication_history ?? [])].some(p => p.cleanup_id === planId)) throw new Error("清理变更已提交，请在 MR 中核对");
    if (preservePaths !== undefined) {
      const files = new Set([...plan.target_entries, ...(plan.branch_entries ?? [])].map(e => e.path));
      if (!Array.isArray(preservePaths) || preservePaths.some(path => typeof path !== "string" || !files.has(path) || job.documents.some(d => d.selected && d.target_id === plan.target_id && d.path === path))) throw new Error("请选择清单中的旧文件；本次新增文档请在文档选择区调整");
      plan.preserve_paths = [...new Set(preservePaths)] as string[];
    }
    plan.confirmed = confirmed; this.persist(job); return this.get(id);
  }
  private hasAttemptedMr(job: DomainKnowledgeJob) {
    return [...job.publications, ...(job.publication_history ?? []), ...(job.archive_batches ?? []).flatMap(batch => batch.publications)]
      .some(p => p.mr_attempted || p.url || p.mr_id !== undefined);
  }
  setIssueNumber(id: string, value: unknown, description?: unknown) {
    const job = this.live(id), issue = knowledgeIssueNumber(value);
    const nextDescription = knowledgeIssueDescription(description) ?? (job.issue_no === issue ? job.issue_description : undefined);
    if (this.publishing.has(id)) throw new Error("正在创建 MR，请稍后修改关联单号和描述");
    if (job.issue_no === issue && job.issue_description === nextDescription) return this.get(id);
    if (this.hasAttemptedMr(job) && (job.issue_no !== issue || (job.issue_description && job.issue_description !== nextDescription))) throw new Error("已发起 MR 创建，不能更改本任务的关联单号或描述");
    job.issue_no = issue; job.issue_description = nextDescription;
    for (const batch of job.archive_batches ?? []) if (!["done", "superseded"].includes(batch.state)) {
      if (!batch.publications.some(p => p.mr_attempted || p.url || p.mr_id !== undefined)) {
        batch.issue_no = issue; batch.issue_description = nextDescription;
      } else if (!batch.issue_description) batch.issue_description = nextDescription;
    }
    this.persist(job); return this.get(id);
  }
  async publish(id: string, operator: string, input: { document_ids?: string[]; expected_revisions?: Record<string, number> } = {}) {
    const job = this.live(id);
    if (this.stopped) throw new Error("服务正在停止");
    const owner = this.acquirePublication(id);
    try {
    if (["queued", "running"].includes(job.status)) throw new Error("请等待本轮研究完成或停止后发布");
    if (input.document_ids && (!Array.isArray(input.document_ids) || input.document_ids.some(id => !job.documents.some(d => d.id === id)))) throw new Error("请选择本次发布的知识文档");
    const selected = job.documents.filter(d => input.document_ids ? input.document_ids.includes(d.id) : d.selected);
    if (!selected.length) throw new Error("请至少选择一份文档");
    if (job.turns.some(turn => turn.proposals.some(proposal => proposal.status === "pending" && selected.some(doc => doc.id === proposal.document.id)))) throw new Error("所选文档有尚未确认的修改，请先确认或放弃后发布");
    // Check every baseline before writing any member of this publication.
    const existing = listKnowledgeDocuments(this.dataDir);
    const prepared = selected.map(doc => {
      this.validateDocument(job, doc);
      if (input.expected_revisions && input.expected_revisions[doc.id] !== doc.revision) throw new Error("草稿已有新版本，请刷新后重新发布");
      const target = [job.knowledge_target, ...job.repositories].find(t => t.id === doc.target_id)!;
      const origin = existing.filter(d => d.research_source?.job_id === (job.component_research_id ?? job.id));
      const previous = doc.knowledge_document_id ? readKnowledgeDocument(this.dataDir, doc.knowledge_document_id)
        : origin.find(d => d.research_source?.document_id === doc.id)
          ?? origin.find(d => {
            if (d.research_source?.document_id) return false;
            if (job.component_research_id) return true;
            const location = d.archive_target ?? d.research_source;
            return location?.repository === target.repository && location.branch === target.branch && location.path === doc.path;
          });
      if (previous && doc.published_revision && previous.revision !== doc.published_revision) throw new Error("正式知识已有新版本，请比较最新内容后重新发布，未覆盖他人修改");
      const content = (doc.component_metadata ? restoreComponentArchive(doc.content, doc.component_metadata) : doc.content).replace(/\r\n/g, "\n");
      if (previous && !doc.published_revision && previous.content !== content) throw new Error("旧研究尚未绑定当前正式知识版本，请从正式知识的更新入口继续，保留已有人工修改");
      if (!previous && target.repository && existing.some(d => {
        const location = d.archive_target ?? d.source;
        return location?.repository === target.repository && location.branch === target.branch && location.path === doc.path;
      })) throw new Error(`${doc.path} 已有正式知识，请从该知识的更新入口继续，避免重复发布`);
      const source = job.source_repositories?.find(repository => repository.id === doc.target_id) ?? target;
      const formal = prepareKnowledgeDocument(this.dataDir, { ...previous, title: doc.title, content,
        scope: previous?.scope ?? (job.component_research_id ? "platform" : doc.layer === "domain" && job.module_id ? "module" : doc.layer === "repository" ? "repository" : "platform"),
        module_ids: previous?.module_ids ?? (doc.layer === "domain" && job.module_id ? [job.module_id] : []),
        repositories: previous?.repositories ?? (doc.layer === "repository" ? [source.repository] : []),
        technologies: previous?.technologies ?? job.technologies, active: previous?.active ?? true,
        archive_target: { repository: target.repository, branch: target.branch, path: doc.path },
        research_source: job.component_research_id && (job.component_source || previous?.research_source) ? job.component_source ?? previous?.research_source : { job_id: job.component_research_id ?? job.id, document_id: doc.id,
          repository: target.repository, branch: target.branch, path: doc.path,
          source_revisions: { ...job.revisions }, material_ids: [...job.material_ids], skill: job.skill },
      }, operator, previous?.id, { expectedRevision: previous?.revision, maxContentBytes: job.component_research_id ? 16 * 1024 * 1024 : undefined });
      const archive = doc.component_metadata ? componentArchiveParts(formal.document.content) : { content: formal.document.content, component_metadata: undefined };
      return { doc, target, formal, archive };
    });
    const destinations = new Set<string>();
    for (const { doc, target } of prepared) if (target.repository) {
      const destination = JSON.stringify([target.repository, target.branch, doc.path]);
      if (destinations.has(destination)) throw new Error(`${doc.path} 在本批次指向同一归档仓和分支，请调整路径后发布，未写入正式知识`);
      destinations.add(destination);
    }
    // 真 kill -9 可发生在正式文件 rename 与下一次 job 写盘之间，先用现有批次保存精确版本。
    // 重启按实际正式版本过滤批次，再补齐已写成功篇的发布字段，不把未写成篇当作已发布。
    // 正式库会归一化换行；批次和研究记录必须保存同一正文，避免崩溃恢复归档旧字节。
    for (const { doc, archive } of prepared) Object.assign(doc, archive);
    const documents = prepared.map(({ doc, formal }) => ({ ...structuredClone(doc), selected: true,
      knowledge_document_id: formal.document.id, published_revision: formal.document.revision,
      published_document_revision: doc.revision, published_at: formal.document.history.at(-1)!.at }));
    const duplicate = job.archive_batches?.find(batch => batch.documents.length === documents.length
      && documents.every(doc => batch.documents.some(old => old.knowledge_document_id === doc.knowledge_document_id && old.published_revision === doc.published_revision)));
    if (!duplicate) (job.archive_batches ??= []).push({ id: randomUUID(), created_at: new Date().toISOString(), operator,
      state: "pending", documents, targets: structuredClone([job.knowledge_target, ...job.repositories]), issue_no: job.issue_no, issue_description: job.issue_description, publications: [] });
    else this.requeueContinuableBatch(job, duplicate, operator);
    this.persist(job);
    for (const { doc, formal } of prepared) {
      const published = writePreparedKnowledgeDocument(this.dataDir, formal);
      doc.knowledge_document_id = published.id; doc.published_revision = published.revision;
      doc.published_document_revision = doc.revision; doc.published_at = published.history.at(-1)!.at;
      this.persist(job);
    }
    return this.get(id);
    } finally { this.releasePublication(id, owner); this.scheduleArchive(id); }
  }
  private currentBatchDocuments(batch: DomainArchiveBatch) {
    return batch.documents.filter(doc => {
      if (!doc.knowledge_document_id || !doc.published_revision) return true;
      try { return readKnowledgeDocument(this.dataDir, doc.knowledge_document_id).revision === doc.published_revision; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof Error && error.message === "知识已删除") return false;
        throw error;
      }
    });
  }
  /** 关闭 MR 与已核对的远端差异共用同一继续条件，历史版本不重新推送。 */
  private archiveCanContinue(job: DomainKnowledgeJob, batch: DomainArchiveBatch) {
    if (batch.state === "superseded" || ["pending", "running"].includes(batch.state)) return false;
    const documents = this.currentBatchDocuments(batch);
    if (!documents.length) return false;
    const publications = batch.publications.map(saved => job.publications.find(current => current.target_id === saved.target_id && current.branch === saved.branch) ?? saved);
    const diverged = publications.filter(publication => publication.state === "merged" && publication.sync_state === "diverged");
    for (const publication of diverged) {
      const target = batch.targets.find(target => target.id === publication.target_id);
      const targetIds = new Set(batch.targets.filter(candidate => candidate.repository === target?.repository && candidate.branch === target?.branch).map(candidate => candidate.id));
      const affected = documents.filter(doc => targetIds.has(doc.target_id)
        && (!publication.diverged_paths?.length || publication.diverged_paths.includes(doc.path) || publication.diverged_paths.includes(doc.archive_path ?? doc.path)));
      if (!affected.length || affected.some(doc => {
        const current = job.documents.find(current => current.id === doc.id);
        return !current?.remote_review?.reviewed || current.content !== doc.content || current.component_metadata !== doc.component_metadata;
      })) return false;
    }
    return batch.state === "failed" || publications.some(publication => ["failed", "closed"].includes(publication.state) || publication.sync_state === "failed") || diverged.length > 0;
  }
  private requeueContinuableBatch(job: DomainKnowledgeJob, batch: DomainArchiveBatch, operator: string) {
    if (!this.archiveCanContinue(job, batch)) return false;
    batch.state = "pending"; batch.error = undefined; batch.operator = operator;
    if (!batch.publications.some(publication => publication.mr_attempted || publication.url || publication.mr_id !== undefined)) {
      batch.issue_no = job.issue_no; batch.issue_description = job.issue_description;
      batch.targets = structuredClone([job.knowledge_target, ...job.repositories]);
      batch.documents = batch.documents.map(doc => { const current = job.documents.find(current => current.id === doc.id); return current ? { ...doc, path: current.path, archive_path: current.archive_path } : doc; });
    } else if (!batch.issue_description) batch.issue_description = job.issue_description;
    batch.documents = batch.documents.map(doc => {
      const current = job.documents.find(current => current.id === doc.id);
      return current?.remote_review?.reviewed && current.content === doc.content && current.component_metadata === doc.component_metadata
        ? { ...doc, remote_review: structuredClone(current.remote_review) } : doc;
    });
    return true;
  }
  private supersedeUnavailableFailure(job: DomainKnowledgeJob, batch: DomainArchiveBatch) {
    if (batch.state !== "failed" || this.currentBatchDocuments(batch).length) return false;
    batch.superseded_documents = batch.documents.flatMap(doc => {
      if (!doc.knowledge_document_id || !doc.published_revision) return [];
      let current: ReturnType<typeof readKnowledgeDocument> | undefined;
      try { current = readKnowledgeDocument(this.dataDir, doc.knowledge_document_id); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (!(error instanceof Error) || error.message !== "知识已删除")) throw error;
      }
      const draft = job.documents.find(draft => draft.id === doc.id);
      if (!current && draft?.knowledge_document_id !== doc.knowledge_document_id && !knowledgeDeleted(this.dataDir, doc.knowledge_document_id)) return [];
      return [{ document_id: doc.id, knowledge_document_id: doc.knowledge_document_id, published_revision: doc.published_revision,
        current_revision: current?.revision, reason: current ? "newer_version" as const : "deleted" as const }];
    });
    batch.state = "superseded"; batch.error = undefined;
    return true;
  }
  retryArchive(id: string, operator: string) {
    const job = this.live(id), owner = this.acquirePublication(id);
    try {
      let changed = false;
      for (const batch of job.archive_batches ?? []) if (this.requeueContinuableBatch(job, batch, operator)) changed = true;
      if (changed) this.persist(job);
      return this.get(id);
    } finally { this.releasePublication(id, owner); this.scheduleArchive(id); }
  }
  private scheduleArchive(id: string) {
    if (this.stopped || this.archiving.has(id) || this.publishing.has(id)) return;
    const job = this.jobs.get(id);
    if (!job || job.deleted_at) return;
    const owner = this.acquirePublication(id);
    let changed = false;
    for (const batch of job.archive_batches ?? []) {
      try { if (this.supersedeUnavailableFailure(job, batch)) changed = true; }
      catch { /* 正式知识损坏会单独告警，不能把它当成已删除而跳过失败批次。 */ }
    }
    if (changed) {
      try { this.persist(job); }
      catch (error) { this.releasePublication(id, owner); throw error; }
    }
    const first = job.archive_batches?.find(batch => !["done", "superseded"].includes(batch.state));
    if (!first || first.state === "failed") { this.releasePublication(id, owner); return; }
    const work = this.archiveQueue.then(async () => {
      try {
        if (this.stopped) return;
        for (const batch of job.archive_batches ?? []) {
          if (this.stopped) break;
          if (batch.state === "failed") {
            try { if (this.supersedeUnavailableFailure(job, batch)) this.persist(job); }
            catch { /* 保留需要人检查的失败记录，不推断损坏知识的版本。 */ }
            if (batch.state === "failed") break;
          }
          if (["done", "superseded"].includes(batch.state)) continue;
          batch.state = "running"; this.persist(job);
          try {
            batch.superseded_documents = [];
            let restored = false;
            const documents = batch.documents.filter(doc => {
              if (!doc.knowledge_document_id || !doc.published_revision) return true;
              let current: ReturnType<typeof readKnowledgeDocument> | undefined;
              try { current = readKnowledgeDocument(this.dataDir, doc.knowledge_document_id); }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (!(error instanceof Error) || error.message !== "知识已删除")) throw error;
              }
              if (current?.revision === doc.published_revision) {
                const draft = job.documents.find(draft => draft.id === doc.id);
                if (draft && draft.revision === doc.revision && draft.content === doc.content && draft.component_metadata === doc.component_metadata
                  && (draft.knowledge_document_id !== current.id || draft.published_revision !== current.revision || draft.published_document_revision !== doc.revision)) {
                  draft.knowledge_document_id = current.id; draft.published_revision = current.revision;
                  draft.published_document_revision = doc.revision; draft.published_at = current.history.at(-1)!.at;
                  restored = true;
                }
                return true;
              }
              const draft = job.documents.find(draft => draft.id === doc.id);
              if (!current && draft?.knowledge_document_id !== doc.knowledge_document_id && !knowledgeDeleted(this.dataDir, doc.knowledge_document_id)) return false;
              batch.superseded_documents!.push({ document_id: doc.id, knowledge_document_id: doc.knowledge_document_id,
                published_revision: doc.published_revision, current_revision: current?.revision, reason: current ? "newer_version" : "deleted" });
              return false;
            });
            if (restored) this.persist(job);
            if (!documents.length) { batch.state = "superseded"; batch.error = undefined; this.persist(job); continue; }
            if (!this.options.publish) throw new Error("知识已发布；尚未配置 Git 归档能力");
            knowledgeIssueNumber(batch.issue_no);
            const snapshot: DomainKnowledgeJob = { ...structuredClone(job), documents: structuredClone(documents), issue_no: batch.issue_no, issue_description: batch.issue_description,
              knowledge_target: batch.targets.find(t => t.id === "domain")!, repositories: batch.targets.filter(t => t.id !== "domain") };
            const groups = new Map<string, KnowledgeRepository[]>();
            for (const target of batch.targets.filter(t => documents.some(d => d.target_id === t.id))) {
              const key = JSON.stringify([target.repository, target.branch]);
              groups.set(key, [...(groups.get(key) ?? []), target]);
            }
            for (const targets of groups.values()) {
              const target = targets[0];
              repository(target, target.id);
              if (targets.length > 1 && snapshot.cleanup_plans?.some(plan => plan.confirmed && targets.some(t => t.id === plan.target_id))) throw new Error("同仓多目标的清理计划须先通过独立清理完成，再归档本批知识；正式知识已生效");
              const grouped = { ...snapshot, documents: snapshot.documents.filter(d => targets.some(t => t.id === d.target_id))
                .map(d => ({ ...d, target_id: target.id, archive_path: d.archive_path ?? d.path })) };
              const save = (publication: DomainPublication) => {
                this.assertPublicationOwner(id, owner);
                publication = { ...publication, updated_at: new Date().toISOString() };
                const index = job.publications.findIndex(p => p.target_id === target.id);
                if (index >= 0 && job.publications[index].branch !== publication.branch) (job.publication_history ??= []).push(structuredClone(job.publications[index]));
                if (index < 0) job.publications.push(publication); else job.publications[index] = publication;
                const found = batch.publications.findIndex(p => p.target_id === target.id);
                if (found < 0) batch.publications.push(structuredClone(publication)); else batch.publications[found] = structuredClone(publication);
                this.persist(job);
              };
              const ids = new Set(documents.map(d => d.knowledge_document_id).filter(Boolean));
              const related = [...this.jobs.values()].flatMap(other => other.publications.filter(p => {
                const location = [other.knowledge_target, ...other.repositories].find(t => t.id === p.target_id);
                return location?.repository === target.repository && location.branch === target.branch
                  && p.documents.some(d => d.knowledge_document_id && ids.has(d.knowledge_document_id));
              })).sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
              const previous = related[0] ? { ...related[0], target_id: target.id } : job.publications.find(p => p.target_id === target.id);
              try {
                const publication = await this.options.publish(grouped, target, previous, batch.operator, save);
                this.assertPublicationOwner(id, owner); save(publication);
              }
              catch (error) {
                this.assertPublicationOwner(id, owner);
                const latest = job.publications.find(p => p.target_id === target.id) ?? { target_id: target.id, branch: `codex/knowledge-${job.id}-${target.id}`, documents: [], state: "failed" as const };
                save({ ...latest, state: latest.state === "merged" ? "merged" : "failed", error: error instanceof Error ? error.message : "归档失败" });
                throw error;
              }
            }
            this.assertPublicationOwner(id, owner);
            batch.state = "done"; batch.error = undefined;
          } catch (error) {
            this.assertPublicationOwner(id, owner);
            batch.state = "failed"; batch.error = error instanceof Error ? error.message : "归档失败";
          }
          this.persist(job);
        }
      } finally { this.releasePublication(id, owner); }
    }).finally(() => {
      this.releasePublication(id, owner);
      if (this.archiving.get(id) === work) this.archiving.delete(id);
      this.scheduleArchive(id);
    });
    this.archiveQueue = work.catch(() => undefined);
    this.archiving.set(id, work);
  }
  async refresh(id: string, operator: string) {
    const job = this.live(id);
    if (!this.options.refresh) throw new Error("未配置 MR 状态查询");
    const owner = this.acquirePublication(id);
    try {
      for (let i = 0; i < job.publications.length; i++) if (job.publications[i].url || job.publications[i].state === "unchanged") {
        const publication = job.publications[i];
        let result: DomainPublication;
        try { result = await this.options.refresh(this.get(id), structuredClone(publication), operator); }
        catch (error) { this.assertPublicationOwner(id, owner); result = { ...publication, error: error instanceof Error ? error.message : "MR 状态查询失败" }; }
        this.assertPublicationOwner(id, owner);
        const fields = { state: result.state, error: result.error, sync_state: result.sync_state, sync_error: result.sync_error,
          diverged_paths: result.diverged_paths, target_revision: result.target_revision, updated_at: result.updated_at };
        Object.assign(publication, fields);
        for (const batch of job.archive_batches ?? []) for (const saved of batch.publications) {
          if (saved.target_id === publication.target_id && saved.branch === publication.branch) Object.assign(saved, structuredClone(fields));
        }
        this.persist(job);
      }
      return this.get(id);
    } finally { this.releasePublication(id, owner); this.scheduleArchive(id); }
  }
  async shutdown() {
    this.stopped = true;
    for (const job of this.jobs.values()) if (!job.deleted_at && ["queued", "running"].includes(job.status)) {
      job.status = "queued"; job.stage = "等待接续原研究会话";
      for (const turn of job.turns) if (["queued", "running"].includes(turn.status)) turn.status = "queued";
      this.persist(job);
    }
    for (const [id, entry] of this.running) this.stopExecution(this.jobs.get(id)!, entry);
    // 发布器取消 Git 与研究停止并行使用同一个预算，不能串行各等 60 秒。
    const settling = Promise.allSettled([...this.running.values()].map(r => r.released)
      .concat([...this.archiving.values()], this.options.shutdown?.() ?? Promise.resolve()));
    let timer: ReturnType<typeof setTimeout> | undefined, expired = false;
    try { await Promise.race([settling, new Promise<void>(resolve => { timer = setTimeout(() => { expired = true; resolve(); }, STOP_BUDGET_MS); timer.unref?.(); })]); }
    finally {
      clearTimeout(timer);
      // 已关停的管理器不再拥有这些异步操作；迟到回调须按原 owner 丢弃，不能覆盖新实例。
      this.publishing.clear(); this.archiving.clear();
      if (expired) for (const job of this.jobs.values()) {
        const active = job.archive_batches?.filter(batch => batch.state === "running") ?? [];
        if (!active.length) continue;
        const reason = "知识归档停止超时：操作 60 秒内未退出，已停止等待";
        for (const batch of active) { batch.state = "failed"; batch.error = reason; }
        try { this.persist(job); }
        catch { this.readWarnings.push(`请检查归档停止记录的保存失败：domain-extraction/${job.id}/job.json`); }
        this.options.onStopTimeout?.({ ...this.get(job.id), error: reason });
      }
    }
  }
}
