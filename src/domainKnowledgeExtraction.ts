import { componentArchiveParts, componentMetadataPath, restoreComponentArchive } from "./componentKnowledgeArchiveFormat.ts";
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
import { currentKnowledgeArchiveBatches, projectKnowledgeProduction } from "./knowledgeProductionState.ts";
import type { KnowledgeArchivePreview, KnowledgeProductionAction } from "./knowledgeProductionTypes.ts";
import { continuingReviewProposal, assertLatestReviewProposal, assertReviewRevision, assertNoPendingReviewProposals, type ReviewProposal } from "./knowledgeReviewCore.ts";

import type { KnowledgeRepository, DomainDocumentContent, DomainDocument, DomainTurn, DomainPublication, DomainArchiveBatch, DomainKnowledgeJob, DomainExecution } from "./domainKnowledgeTypes.ts";
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
function archiveRepositoryGroups(targets: KnowledgeRepository[]) {
  const groups: Array<{ target: KnowledgeRepository; ids: string[] }> = [];
  for (const target of targets) {
    const group = groups.find(group => group.target.repository === target.repository && group.target.branch === target.branch);
    if (group) group.ids.push(target.id); else groups.push({ target, ids: [target.id] });
  }
  return groups;
}

const STOP_BUDGET_MS = 60_000;
const STOP_TIMEOUT = "停止超时：执行体 60 秒内未退出，已强制释放";
const isRecord = (value: any): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
function validMrUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value) return false;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password; }
  catch { return false; }
}
function validPublication(value: any): value is DomainPublication {
  const documents = (value: any) => Array.isArray(value) && value.every(document => isRecord(document)
    && ["id", "path", "content"].every(key => typeof document[key] === "string") && Number.isSafeInteger(document.revision) && document.revision > 0
    && ["knowledge_document_id", "knowledge_revision", "metadata_for"].every(key => document[key] === undefined || typeof document[key] === "string"));
  return isRecord(value) && typeof value.target_id === "string" && typeof value.branch === "string" && ["pending", "opened", "failed"].includes(value.state)
    && documents(value.documents) && (value.attempted_documents === undefined || documents(value.attempted_documents))
    && (value.url === undefined || validMrUrl(value.url)) && (value.state !== "opened" || validMrUrl(value.url))
    && (value.mr_attempted === undefined || typeof value.mr_attempted === "boolean")
    && ["revision", "error", "updated_at"].every(key => value[key] === undefined || typeof value[key] === "string")
    && (value.mr_id === undefined || typeof value.mr_id === "string" || typeof value.mr_id === "number" && Number.isFinite(value.mr_id));
}
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
    && (doc.component_metadata === undefined || typeof doc.component_metadata === "string");
  const target = (target: any) => isRecord(target) && ["id", "repository", "branch", "docs_path"].every(key => typeof target[key] === "string");
  const research = (research: any) => isRecord(research) && typeof research.inventory_complete === "boolean"
    && ["research", "review", "complete"].includes(research.phase) && Array.isArray(research.capabilities)
    && research.capabilities.every((capability: any) => fields(capability, ["id", "title", "findings"])
      && ["pending", "researched", "blocked"].includes(capability.state) && strings(capability.repository_ids) && strings(capability.document_ids)
      && Array.isArray(capability.sources) && capability.sources.every((source: any) => fields(source, ["repository_id", "path"])));
  return isRecord(value) && value.id === id && ["title", "scope", "operator", "created_at", "stage"].every(key => typeof value[key] === "string")
    && (value.key === undefined || typeof value.key === "string")
    && ["idle", "queued", "running", "done", "failed", "cancelled"].includes(value.status) && target(value.knowledge_target)
    && Array.isArray(value.repositories) && value.repositories.every(target) && strings(value.material_ids) && strings(value.ar_codes)
    && revisionMap(value.revisions) && Array.isArray(value.evidence) && value.evidence.every(isRecord)
    && (value.source_repositories === undefined || Array.isArray(value.source_repositories) && value.source_repositories.every(target))
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
    && Array.isArray(value.publications) && value.publications.every(validPublication)
    && (value.publication_history === undefined || Array.isArray(value.publication_history) && value.publication_history.every(validPublication))
    && (value.archive_batches === undefined || Array.isArray(value.archive_batches) && value.archive_batches.every((batch: any) => isRecord(batch)
      && fields(batch, ["id", "created_at", "operator"]) && ["pending", "running", "done", "failed", "superseded"].includes(batch.state)
      && (batch.issue_no === undefined || typeof batch.issue_no === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(batch.issue_no))
      && (batch.issue_description === undefined || typeof batch.issue_description === "string" && !!batch.issue_description.trim()
        && batch.issue_description.length <= 2000 && !/[\x00-\x1f\x7f\u2028\u2029]/.test(batch.issue_description))
      && Array.isArray(batch.documents) && batch.documents.every(document) && Array.isArray(batch.targets) && batch.targets.every(target)
      && batch.documents.every((doc: any) => batch.targets.some((target: any) => target.id === doc.target_id))
      && Array.isArray(batch.publications) && batch.publications.every(validPublication)));
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
  private stopped = false;
  constructor(readonly dataDir: string, private execute: (input: DomainExecution) => Promise<string>, private options: {
    publish?: (job: DomainKnowledgeJob, target: KnowledgeRepository, previous: DomainPublication | undefined, operator: string, save: (publication: DomainPublication) => void, signal?: AbortSignal) => Promise<DomainPublication>;
    onIndexed?: () => void;
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
        for (const batch of job.archive_batches ?? []) {
          if (batch.state === "running" || batch.state === "pending" && !!batch.issue_no) {
            batch.state = "failed"; batch.error = "服务重启中断了人工归档，请手动重试";
            for (const publication of batch.publications) if (publication.state === "pending") {
              publication.state = "failed"; publication.error = batch.error;
              const current = job.publications.find(current => current.target_id === publication.target_id && current.branch === publication.branch);
              if (current) { current.state = "failed"; current.error = batch.error; }
            }
            changed = true;
          }
          if (batch.state !== "pending" || batch.issue_no || batch.publications.length) continue;
          // 仅恢复已真正落入正式库的发布，不触发 Git；未写成篇不能成为已发布知识。
          batch.documents = batch.documents.filter(document => {
            if (!document.knowledge_document_id || !document.published_revision) return false;
            let formal;
            try { formal = readKnowledgeDocument(this.dataDir, document.knowledge_document_id); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (!(error instanceof Error) || error.message !== "知识已删除")) this.readWarnings.push(`请检查损坏的知识记录：knowledge-documents/${document.knowledge_document_id}.json；其余任务照常可用`);
              return false;
            }
            if (formal.revision !== document.published_revision) return false;
            const draft = job.documents.find(draft => draft.id === document.id);
            if (draft && (draft.knowledge_document_id !== formal.id || draft.published_revision !== formal.revision)) {
              Object.assign(draft, { knowledge_document_id: formal.id, published_revision: formal.revision,
                published_document_revision: document.published_document_revision, published_at: document.published_at });
              this.indexPublished(job.id); changed = true;
            }
            return true;
          });
          changed = true;
        }
        if (job.archive_batches) job.archive_batches = job.archive_batches.filter(batch => batch.state !== "pending" || !!batch.issue_no || !!batch.publications.length || !!batch.documents.length);
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
    queueMicrotask(() => this.pump());
  }
  private root(id: string) { return join(this.dataDir, "domain-extraction", id); }
  private live(id: string) { const job = this.jobs.get(id); if (!job || job.deleted_at) throw new Error("领域萃取任务不存在或已删除"); return job; }
  private acquirePublication(id: string) {
    if (this.stopped) throw new Error("服务正在停止");
    if (this.publishing.has(id)) throw new Error("正在发布或归档，请等待当前操作完成");
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
  private indexPublished(id: string) {
    try { this.options.onIndexed?.(); }
    catch (error) { this.readWarnings.push(`知识已发布，索引更新失败：domain-extraction/${id}/job.json；${error instanceof Error ? error.message : String(error)}`); }
  }
  warnings() { return [...this.readWarnings]; }
  get(id: string): DomainKnowledgeJob {
    const job = structuredClone(this.live(id));
    const current_revisions = Object.fromEntries(this.formalArchiveDocuments(job).map(document => [document.knowledge_document_id!, document.published_revision!]));
    return { ...job, production: projectKnowledgeProduction({ kind: "domain", record: job, current_revisions }), deletion: this.deletionView(id) };
  }
  list() { return [...this.jobs.values()].filter(job => !job.component_research_id && !job.deleted_at).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(job => ({ ...this.get(job.id), documents: job.documents.map(({ content: _, history: __, base_content: ___, ...doc }) => doc), evidence: [], turns: [], publications: [], publication_history: [] })); }
  componentArchive(researchId: string) {
    const job = [...this.jobs.values()].find(job => !job.deleted_at && job.component_research_id === researchId);
    return job ? this.get(job.id) : undefined;
  }
  private formalArchiveDocuments(job: DomainKnowledgeJob, strict = false): DomainDocument[] {
    return job.documents.flatMap(document => {
      if (!document.knowledge_document_id) return [];
      let formal;
      try { formal = readKnowledgeDocument(this.dataDir, document.knowledge_document_id); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof Error && error.message === "知识已删除") return [];
        const warning = `请检查损坏的知识记录：knowledge-documents/${document.knowledge_document_id}.json；其余任务照常可用`;
        if (!this.readWarnings.includes(warning)) this.readWarnings.push(warning);
        if (strict) throw new Error(warning);
        return [];
      }
      let parts;
      try { parts = job.component_research_id ? componentArchiveParts(formal.content) : { content: formal.content, component_metadata: undefined }; }
      catch {
        const warning = `请检查损坏的组件知识结构：knowledge-documents/${document.knowledge_document_id}.json；其余任务照常可用`;
        if (!this.readWarnings.includes(warning)) this.readWarnings.push(warning);
        if (strict) throw new Error(warning);
        return [];
      }
      return [{ ...structuredClone(document), ...parts, title: formal.title, selected: true, history: [],
        knowledge_document_id: formal.id, published_revision: formal.revision,
        published_document_revision: document.revision, published_at: formal.history.at(-1)?.at }];
    });
  }
  previewComponentArchive(input: { research_id: string; knowledge_document_id: string; knowledge_revision?: string }, operator: string): KnowledgeArchivePreview {
    if (this.stopped) throw new Error("服务正在停止");
    const formal = readKnowledgeDocument(this.dataDir, input.knowledge_document_id);
    if (input.knowledge_revision !== undefined && input.knowledge_revision !== formal.revision) throw new Error("正式知识已有新版本，请刷新归档预览");
    let job = [...this.jobs.values()].find(job => !job.deleted_at && job.component_research_id === input.research_id);
    if (job && job.documents[0]?.knowledge_document_id !== formal.id) throw new Error("正式知识绑定已变化，请刷新归档预览");
    if (!job) {
      const configured = readKnowledgeRepoConfig(this.dataDir);
      const target: KnowledgeRepository = { id: "domain", name: "组件知识仓", repository: configured?.url ?? "", branch: configured?.branch ?? "master", path: "", docs_path: configured?.docs_path ?? "docs/knowledge/components" };
      const parts = componentArchiveParts(formal.content);
      const path = formal.archive_target?.repository === target.repository && formal.archive_target.branch === target.branch
        ? formal.archive_target.path : `${target.docs_path}/${formal.id}.md`;
      job = { id: `dkx-${randomUUID()}`, title: formal.title, scope: "正式组件知识手动归档", operator, created_at: new Date().toISOString(),
        component_research_id: input.research_id, technologies: formal.technologies, repositories: [], knowledge_target: target,
        archive_configured: !!target.repository, material_ids: [], ar_codes: [], use_wxdoubao: false, status: "done", stage: "已发布", revisions: {},
        documents: [{ id: "component-guide", title: formal.title, target_id: "domain", path, layer: "domain", ...parts, sources: formal.research_source?.path || "正式知识库",
          revision: 1, selected: true, base_content: null, base_revision: "", history: [], knowledge_document_id: formal.id, published_revision: formal.revision, published_document_revision: 1 }],
        turns: [], evidence: [], publications: [], archive_batches: [] };
      this.persist(job); this.jobs.set(job.id, job);
    } else if (!job.knowledge_target.repository) {
      // 后续全局设置可为占位归档任务提供位置；已有人工批次仍保留自己的固定目标。
      const configured = readKnowledgeRepoConfig(this.dataDir);
      if (configured) {
        const candidate = structuredClone(job), docs_path = configured.docs_path ?? job.knowledge_target.docs_path;
        candidate.knowledge_target = { ...job.knowledge_target, repository: configured.url, branch: configured.branch ?? "master", docs_path };
        candidate.documents[0].path = `${docs_path}/${formal.id}.md`; candidate.archive_configured = true;
        this.persist(candidate); Object.assign(job, candidate);
      }
    }
    return this.previewArchive(job.id);
  }
  private matchingManualBatch(job: DomainKnowledgeJob, documents: DomainDocument[]) {
    return currentKnowledgeArchiveBatches(job, Object.fromEntries(documents.map(document => [document.knowledge_document_id!, document.published_revision!])), documents).at(-1);
  }
  previewArchive(id: string): KnowledgeArchivePreview {
    const job = this.live(id), documents = this.formalArchiveDocuments(job, true);
    const batch = this.matchingManualBatch(job, documents);
    const action = (value: KnowledgeProductionAction) => ({ ...value, href: value.id === "configure" ? job.component_research_id ? "/configuration?tab=knowledge" : undefined
      : `?kbPage=task&kbKind=${job.component_research_id ? "component" : "domain"}&kbTask=${encodeURIComponent(job.component_research_id ?? id)}&kbStage=publish` });
    const targets = archiveRepositoryGroups([job.knowledge_target, ...job.repositories].filter(target => documents.some(document => document.target_id === target.id))).map(({ target, ids }) => {
      const publication = batch?.publications.find(publication => ids.includes(publication.target_id));
      const configured = !!target.repository.trim();
      const status_label = publication?.state === "opened" ? "已归档" : publication?.state === "failed" || batch?.state === "failed" ? "归档失败" : batch?.state === "running" ? "归档中" : "已发布（未归档）";
      const actions: KnowledgeProductionAction[] = !configured ? [action({ id: "configure", label: "Git 归档设置", view: "archive", target_id: target.id })]
        : status_label === "归档失败" ? [action({ id: "retry-archive", label: "重试此仓归档", view: "archive", target_id: target.id, batch_id: batch!.id })] : [];
      return { id: target.id, name: target.name, repository: target.repository, branch: target.branch, docs_path: target.docs_path, configured, status_label,
        message: publication?.error || (status_label === "归档失败" ? batch?.error : undefined) || (!configured ? "未配置 Git 归档仓，请联系管理员在知识仓设置中配置。" : status_label === "已归档" ? "MR 已创建，后续合入由人处理。" : "只导出当前已发布的正式知识，创建 MR 后归档结束。"),
        error: publication?.error || (status_label === "归档失败" ? batch?.error : undefined), url: publication?.url, actions,
        files: documents.filter(document => ids.includes(document.target_id)).flatMap(document => {
          const file = { id: document.id, title: document.title, path: document.archive_path ?? document.path, content: document.content,
            knowledge_document_id: document.knowledge_document_id!, knowledge_revision: document.published_revision! };
          return document.component_metadata ? [file, { ...file, id: `${document.id}-metadata`, path: componentMetadataPath(file.path), content: document.component_metadata, metadata_for: document.id }] : [file];
        }) };
    });
    const status_label = targets.some(target => target.status_label === "归档失败") || batch?.state === "failed" ? "归档失败"
      : batch?.state === "running" ? "归档中" : targets.length && targets.every(target => target.status_label === "已归档") ? "已归档" : "已发布（未归档）";
    const actions: KnowledgeProductionAction[] = status_label === "归档失败" ? [action({ id: "retry-archive", label: "重试失败归档", view: "archive", batch_id: batch!.id })]
      : status_label === "已发布（未归档）" && targets.length && targets.every(target => target.configured) ? [action({ id: "create-archive", label: "创建归档 MR", view: "archive" })]
        : !targets.length || targets.every(target => target.configured) ? [] : [action({ id: "configure", label: "Git 归档设置", view: "archive" })];
    return JSON.parse(JSON.stringify({ job_id: id, title: job.title, status_label, message: batch?.error || (status_label === "已归档" ? "MR 已创建，后续合入由人处理。" : "平台发布与 Git 归档分开；填写关联单号后手动创建 MR。"),
      issue_no: batch?.issue_no ?? job.issue_no, issue_description: batch?.issue_description ?? job.issue_description, expected_revisions: Object.fromEntries(documents.map(document => [document.knowledge_document_id!, document.published_revision!])), actions, targets })) as KnowledgeArchivePreview;
  }
  async createArchive(id: string, input: { issue_no: string; issue_description?: string; expected_revisions: Record<string, string> }, operator: string) {
    const job = structuredClone(this.live(id)), owner = this.acquirePublication(id);
    try {
      const issue_no = knowledgeIssueNumber(input.issue_no), issue_description = knowledgeIssueDescription(input.issue_description);
      if (!this.options.publish) throw new Error("未配置 Git 归档发布器");
      const documents = this.formalArchiveDocuments(job, true);
      if (!documents.length) throw new Error("没有已发布的正式知识可归档");
      if (!isRecord(input.expected_revisions) || documents.some(document => input.expected_revisions[document.knowledge_document_id!] !== document.published_revision)
        || Object.keys(input.expected_revisions).length !== new Set(documents.map(document => document.knowledge_document_id)).size) throw new Error("正式知识版本已变化，请刷新归档预览");
      if ("target_ids" in input) throw new Error("首次人工归档包含全部目标；失败后可以按目标重试");
      const targetIds = [...new Set(documents.map(document => document.target_id))];
      const targets = [job.knowledge_target, ...job.repositories].filter(target => targetIds.includes(target.id));
      const paths = new Set<string>();
      for (const target of targets) {
        if (!target.repository.trim()) throw new Error("未配置 Git 归档仓，请联系管理员在知识仓设置中配置");
        repository(target, target.id);
        for (const document of documents.filter(document => document.target_id === target.id)) {
          const path = knowledgeRelativePath(document.archive_path ?? document.path, true), key = JSON.stringify([target.repository, target.branch, path]);
          if (paths.has(key)) throw new Error("多个知识文档指向同一个归档文件，请调整设置"); paths.add(key);
        }
      }
      let batch = this.matchingManualBatch(job, documents);
      if (batch) return this.previewArchive(id);
      batch = { id: randomUUID(), created_at: new Date().toISOString(), operator, state: "pending", documents: structuredClone(documents), targets: structuredClone(targets), issue_no, issue_description, publications: [] };
      (job.archive_batches ??= []).push(batch); this.persist(job); this.live(id).archive_batches = structuredClone(job.archive_batches);
      await this.runManualArchive(job, batch, targetIds, operator, owner);
      return this.previewArchive(id);
    } finally { this.releasePublication(id, owner); }
  }
  async retryArchive(id: string, operator: string, input: { batch_id: string; target_id?: string }) {
    const job = structuredClone(this.live(id)), owner = this.acquirePublication(id);
    try {
      const batch = job.archive_batches?.find(batch => batch.id === input?.batch_id && !!batch.issue_no);
      if (!batch || batch.state === "superseded") throw new Error("人工归档记录不存在");
      if (input.target_id && !batch.targets.some(target => target.id === input.target_id)) throw new Error("归档目标不存在");
      const targets = archiveRepositoryGroups(batch.targets).filter(group => (!input.target_id || group.ids.includes(input.target_id)) && batch.publications.find(publication => group.ids.includes(publication.target_id))?.state !== "opened");
      if (targets.length) await this.runManualArchive(job, batch, targets.flatMap(group => group.ids), operator, owner);
      else if (batch.state !== "done" && batch.targets.length && archiveRepositoryGroups(batch.targets).every(group =>
        batch.publications.some(publication => group.ids.includes(publication.target_id) && publication.state === "opened" && validMrUrl(publication.url)))) {
        // MR 回执已耐久，人工重试只补最终状态；不重复 Git 或创建 MR。
        this.assertPublicationOwner(id, owner);
        const candidate = structuredClone(this.live(id)), completed = candidate.archive_batches!.find(current => current.id === batch.id)!;
        completed.state = "done"; completed.error = undefined;
        this.persist(candidate); this.live(id).archive_batches = structuredClone(candidate.archive_batches);
      }
      return this.previewArchive(id);
    } finally { this.releasePublication(id, owner); }
  }
  private async runManualArchive(job: DomainKnowledgeJob, original: DomainArchiveBatch, targetIds: string[], operator: string, owner: symbol) {
    if (!this.options.publish) throw new Error("未配置 Git 归档发布器");
    let snapshot = structuredClone(job);
    const batchId = original.id;
    const currentBatch = () => snapshot.archive_batches!.find(batch => batch.id === batchId)!;
    // 操作的私有副本与读取副本分离；耐久写成功后才替换公开记录。
    const commit = (change: (candidate: DomainKnowledgeJob, batch: DomainArchiveBatch) => void) => {
      this.assertPublicationOwner(job.id, owner);
      const candidate = structuredClone(this.live(job.id)), batch = candidate.archive_batches!.find(batch => batch.id === batchId)!;
      change(candidate, batch); this.persist(candidate); snapshot = candidate;
      // 研究执行体持有 turn/document 引用；这里只换归档字段，不能替换仍在执行的嵌套对象。
      Object.assign(this.live(job.id), { archive_batches: structuredClone(candidate.archive_batches), publications: structuredClone(candidate.publications) });
    };
    const fail = (reason: string, targetId?: string, previous?: DomainPublication) => {
      const update = (candidate: DomainKnowledgeJob, batch: DomainArchiveBatch) => {
        batch.state = "failed"; batch.error = reason;
        if (targetId) {
          const saved = batch.publications.find(publication => publication.target_id === targetId);
          batch.publications = [...batch.publications.filter(publication => publication.target_id !== targetId),
            { ...(saved ?? previous ?? { target_id: targetId, branch: "", documents: [] }), state: "failed", error: reason }];
          candidate.publications = structuredClone(batch.publications);
        }
      };
      try { commit(update); }
      catch (error) {
        this.assertPublicationOwner(job.id, owner);
        const candidate = structuredClone(this.live(job.id)); update(candidate, candidate.archive_batches!.find(batch => batch.id === batchId)!);
        Object.assign(this.live(job.id), { archive_batches: candidate.archive_batches, publications: candidate.publications });
        this.readWarnings.push(`人工归档失败记录保存失败：domain-extraction/${job.id}/job.json；${error instanceof Error ? error.message : String(error)}；请检查磁盘后手动重试`);
      }
    };
    const work = (async () => {
      try { commit((_, batch) => { batch.state = "running"; batch.error = undefined; }); }
      catch (error) { fail(error instanceof Error ? error.message : String(error)); return; }
      for (const { target, ids } of archiveRepositoryGroups(original.targets).filter(group => group.ids.some(id => targetIds.includes(id)))) {
        this.assertPublicationOwner(job.id, owner);
        const previous = currentBatch().publications.find(publication => ids.includes(publication.target_id));
        if (previous?.state === "opened") continue;
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, accepting = true;
        const save = (publication: DomainPublication) => {
          if (!accepting || controller.signal.aborted) return;
          if (!validPublication(publication)) throw new Error("MR 回执格式不正确或缺少有效链接，未记为已归档；请手动重试");
          commit((candidate, batch) => {
            batch.publications = [...batch.publications.filter(current => current.target_id !== target.id), structuredClone(publication)];
            candidate.publications = structuredClone(batch.publications);
          });
        };
        try {
          const batch = currentBatch();
          const publicationJob = { ...structuredClone(snapshot), documents: structuredClone(batch.documents.filter(document => ids.includes(document.target_id))),
            knowledge_target: structuredClone(batch.targets.find(candidate => candidate.id === "domain") ?? snapshot.knowledge_target),
            repositories: structuredClone(batch.targets.filter(candidate => candidate.id !== "domain")), issue_no: batch.issue_no, issue_description: batch.issue_description };
          const publication = await Promise.race([this.options.publish!(publicationJob, structuredClone(target), previous && structuredClone(previous), operator, save, controller.signal), new Promise<never>((_, reject) => {
            timer = setTimeout(() => { accepting = false; controller.abort(); reject(new Error("人工归档超时：此仓操作 180 秒内未完成，请手动重试")); }, 180_000);
          })]);
          this.assertPublicationOwner(job.id, owner); save(publication);
        } catch (error) {
          this.assertPublicationOwner(job.id, owner); fail(error instanceof Error ? error.message : String(error), target.id, previous);
        } finally { accepting = false; clearTimeout(timer); controller.abort(); }
      }
      try { commit((_, batch) => {
        batch.state = archiveRepositoryGroups(batch.targets).every(group => batch.publications.some(publication => group.ids.includes(publication.target_id) && publication.state === "opened")) ? "done" : "failed";
        batch.error = batch.publications.find(publication => publication.state === "failed")?.error;
      }); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    })();
    this.archiving.set(job.id, work);
    try { await work; } finally { if (this.archiving.get(job.id) === work) this.archiving.delete(job.id); }
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
      revision: 1, history: [], selected: true, human_edited: true, research_turn_id: undefined };
    const job: DomainKnowledgeJob = { ...structuredClone(original), id: `dkx-${randomUUID()}`, operator,
      created_at: new Date().toISOString(), deleted_at: undefined, deleted_by: undefined, status: "idle", stage: "准备增量研究",
      documents: [document], turns: [], evidence: [], archive_batches: [], publications: [], publication_history: [],
      revisions: { ...(published.research_source?.source_revisions ?? original.revisions) },
      material_ids: published.research_source?.material_ids ?? original.material_ids };
    this.jobs.set(job.id, job); this.persist(job);
    return this.run(job.id, { mode: "update", document_ids: [document.id], message: input.message?.trim() || "核对来源变化，更新受影响知识；保留现有人工内容，无变化时说明原因",
      material_ids: input.material_ids, ar_codes: input.ar_codes }, operator);
  }
  private createJob(input: any, operator: string) {
    if (this.stopped) throw new Error("服务正在停止");
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
      source_repositories: structuredClone(repositories), archive_configured: !!knowledge_target.repository, archive_revision: 0,
      material_ids, ar_codes, use_wxdoubao: true, status: "idle", stage: "准备研究", revisions: {}, documents: [], turns: [], evidence: [], publications: [] };
    // 请求键在创建时保存；后续维护不会改变原请求的身份。
    const requestKey = (value: DomainKnowledgeJob) => JSON.stringify([value.title, value.scope, value.instructions,
      value.issue_no, value.issue_description, value.module_id, value.source_repositories, value.knowledge_target,
      value.archive_configured, value.material_ids, value.ar_codes]);
    job.key = requestKey(job);
    const previous = [...this.jobs.values()].reverse().find(existing => !existing.component_research_id && !existing.deleted_at
      && existing.operator === operator && !["failed", "cancelled"].includes(existing.status)
      && existing.turns[0]?.mode === "extract" && existing.key === job.key);
    if (previous) return this.get(previous.id);
    if ([...this.jobs.values()].filter(job => ["queued", "running"].includes(job.status)).length >= 50) throw new Error("当前研究队列已满，请稍后创建");
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
      if (next.id === "domain") candidate.knowledge_target = next;
      else candidate.repositories = candidate.repositories.map(t => t.id === next.id ? next : t);
      if (!changed && job.archive_configured !== false) continue;
      const remap = (path: string) => {
        if (!path.startsWith(`${old.docs_path}/`)) return path;
        return `${next.docs_path}/${path.slice(old.docs_path.length + 1)}`;
      };
      for (const doc of candidate.documents.filter(d => d.target_id === old.id)) {
        if (!doc.archive_path) doc.path = remap(doc.path);
        doc.base_content = null; doc.base_revision = "";
      }
      for (const turn of candidate.turns) for (const proposal of turn.proposals.filter(p => p.document.target_id === old.id)) proposal.document.path = candidate.documents.find(d => d.id === proposal.document.id)?.path ?? remap(proposal.document.path);
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
          doc.path = path; doc.base_content = null; doc.base_revision = "";
          for (const turn of candidate.turns) for (const proposal of turn.proposals.filter(p => p.document.id === doc.id)) proposal.document.path = path;
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
  private reviewProposals(turns: readonly DomainTurn[]): ReviewProposal<DomainDocumentContent>[] {
    return turns.flatMap(turn => turn.proposals.map(proposal => ({ turn_id: turn.id, document_id: proposal.document.id,
      turn_status: turn.status, status: proposal.status, base_revision: proposal.base_revision, value: proposal.document })));
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
      const proposals = this.reviewProposals(job.turns), turnIds = job.turns.map(turn => turn.id);
      const workingDocuments = base.map(doc => {
        if (turn.mode === "extract") return doc;
        const proposal = continuingReviewProposal(proposals, doc.id, doc.revision, turn.id, turnIds);
        // 后续意见接着已完成的新稿修改，正文与发布基线仍等人工确认。
        return proposal ? { ...doc, title: proposal.value.title, content: proposal.value.content, sources: proposal.value.sources } : doc;
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
                  if (!owned || existing.human_edited || existing.knowledge_document_id || [...job.publications, ...(job.publication_history ?? [])].some(p => p.documents.some(d => d.id === existing.id))) throw new Error("该草稿已有人工修改、已归档或属于其他研究轮，请通过局部修订生成建议");
                  existing.history.push({ revision: existing.revision, title: existing.title, content: existing.content, sources: existing.sources, operator: "领域研究 Agent", at: new Date().toISOString() });
                  Object.assign(existing, input, { revision: existing.revision + 1, research_turn_id: turn.id });
                  this.persist(job); return structuredClone(input);
                }
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
  private editableDocument(id: string, input: { document: DomainDocumentContent; base_revision: number }) {
    const job = this.live(id), doc = job.documents.find(d => d.id === input.document?.id);
    this.assertEditable(job);
    if (!doc || this.publishing.has(id)) throw new Error("文档不存在或正在归档");
    assertReviewRevision(doc.revision, input.base_revision, "文档已有新版本，请比较差异后重新保存");
    this.validateDocument(job, input.document);
    if (doc.target_id !== input.document.target_id || doc.path !== input.document.path || doc.layer !== input.document.layer) throw new Error("不能通过编辑改变归档位置");
    return { job, doc };
  }
  edit(id: string, input: { document: DomainDocumentContent; base_revision: number }, operator: string) {
    const { job, doc } = this.editableDocument(id, input);
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
      const document = job.documents.find(document => document.id === documentId);
      if (!document) throw new Error("文档不存在或正在归档");
      assertLatestReviewProposal(this.reviewProposals(job.turns), turnId, documentId, document.revision, ["queued", "running"].includes(job.status));
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
        }
      } finally { this.pump(); }
    }, STOP_BUDGET_MS);
    entry.stopTimer.unref?.();
  }
  deletionView(id: string) {
    const job = this.live(id);
    const archive_batches = (job.archive_batches ?? []).filter(batch => !!batch.issue_no && ["pending", "running", "failed"].includes(batch.state))
      .map(batch => ({ id: batch.id, state: batch.state, error: batch.error,
        documents: batch.documents.map(document => ({ id: document.id, title: document.title, path: document.path })),
        publications: batch.publications.map(publication => ({ target_id: publication.target_id, branch: publication.branch,
          state: publication.state, url: publication.url, error: publication.error })) }));
    return { title: job.title, archive_batches, message: archive_batches.length
      ? "以下人工归档尚未完成。删除任务会保留已发布知识、来源记录和 MR 历史；请先在本任务完成归档或手动重试。"
      : "删除任务会保留已发布知识、来源记录和 MR 历史。MR 后续合入由人处理。" };
  }
  remove(id: string, operator: string) {
    const existing = this.jobs.get(id);
    if (existing?.deleted_at) return { deleted: true };
    const job = this.live(id);
    if (job.component_research_id) throw new Error("请在基础组件萃取中管理对应任务");
    if (this.publishing.has(id)) throw new Error("正在发布或归档，请等待当前操作完成后再删除");
    this.stop(id);
    // Keep source and MR history for published knowledge, as component task deletion does.
    job.deleted_at = new Date().toISOString(); job.deleted_by = operator;
    this.persist(job); this.pump(); return { deleted: true };
  }
  setIssueNumber(id: string, value: unknown, description?: unknown) {
    const job = this.live(id), issue = knowledgeIssueNumber(value);
    const nextDescription = knowledgeIssueDescription(description) ?? (job.issue_no === issue ? job.issue_description : undefined);
    if (this.publishing.has(id)) throw new Error("正在创建 MR，请稍后修改关联单号和描述");
    if (job.issue_no === issue && job.issue_description === nextDescription) return this.get(id);
    job.issue_no = issue; job.issue_description = nextDescription;
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
    assertNoPendingReviewProposals(this.reviewProposals(job.turns), selected.map(document => document.id));
    // Check every baseline before writing any member of this publication.
    const existing = listKnowledgeDocuments(this.dataDir);
    const prepared = selected.map(doc => {
      this.validateDocument(job, doc);
      if (input.expected_revisions) assertReviewRevision(doc.revision, input.expected_revisions[doc.id], "草稿已有新版本，请刷新后重新发布");
      const target = [job.knowledge_target, ...job.repositories].find(t => t.id === doc.target_id)!;
      const formalId = projectKnowledgeProduction({ kind: "domain", record: job }).documents.find(item => item.id === doc.id)?.knowledge_document_id;
      const previous = formalId ? readKnowledgeDocument(this.dataDir, formalId)
        : undefined;
      if (previous && doc.published_revision && previous.revision !== doc.published_revision) throw new Error("正式知识已有新版本，请比较最新内容后重新发布，未覆盖他人修改");
      const content = (doc.component_metadata ? restoreComponentArchive(doc.content, doc.component_metadata) : doc.content).replace(/\r\n/g, "\n");
      if (previous && !doc.published_revision) throw new Error("正式知识版本未绑定，请从该知识的更新入口继续");
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
        archive_target: target.repository ? { repository: target.repository, branch: target.branch, path: doc.path } : undefined,
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
    // 已有 marker 保留已发布身份；恢复快照只保留本次可能中断的精确版本，旧MR批次不改。
    const replacing = new Map(documents.map(document => [document.knowledge_document_id, document.published_revision]));
    job.archive_batches = job.archive_batches?.flatMap(batch => {
      if (batch.issue_no || batch.publications.length || batch.state !== "pending") return [batch];
      const remaining = batch.documents.filter(document => !document.knowledge_document_id || !replacing.has(document.knowledge_document_id)
        || replacing.get(document.knowledge_document_id) === document.published_revision);
      return remaining.length ? [{ ...batch, documents: remaining }] : [];
    });
    const duplicate = job.archive_batches?.find(batch => batch.documents.length === documents.length
      && documents.every(doc => batch.documents.some(old => old.knowledge_document_id === doc.knowledge_document_id && old.published_revision === doc.published_revision)));
    if (!duplicate) (job.archive_batches ??= []).push({ id: randomUUID(), created_at: new Date().toISOString(), operator,
      state: "pending", documents, targets: structuredClone([job.knowledge_target, ...job.repositories]), publications: [] });
    this.persist(job);
    for (const { doc, formal } of prepared) {
      const published = writePreparedKnowledgeDocument(this.dataDir, formal);
      doc.knowledge_document_id = published.id; doc.published_revision = published.revision;
      doc.published_document_revision = doc.revision; doc.published_at = published.history.at(-1)!.at;
      this.indexPublished(id); this.persist(job);
    }
    return this.get(id);
    } finally { this.releasePublication(id, owner); }
  }
  async shutdown() {
    this.stopped = true;
    const errors: unknown[] = [];
    for (const job of this.jobs.values()) if (!job.deleted_at && ["queued", "running"].includes(job.status)) {
      job.status = "queued"; job.stage = "等待接续原研究会话";
      for (const turn of job.turns) if (["queued", "running"].includes(turn.status)) turn.status = "queued";
      try { this.persist(job); }
      catch (error) {
        errors.push(error);
        this.readWarnings.push(`请检查关停记录保存失败：domain-extraction/${job.id}/job.json；${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const [id, entry] of this.running) this.stopExecution(this.jobs.get(id)!, entry);
    // 发布器取消 Git 与研究停止并行使用同一个预算，不能串行各等 60 秒。
    const settling = Promise.allSettled([...this.running.values()].map(r => r.released)
      .concat([...this.archiving.values()], Promise.resolve().then(() => this.options.shutdown?.())));
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
        for (const batch of active) {
          batch.state = "failed"; batch.error = reason;
          for (const publication of batch.publications) if (publication.state === "pending") {
            publication.state = "failed"; publication.error = reason;
            const current = job.publications.find(current => current.target_id === publication.target_id && current.branch === publication.branch);
            if (current) { current.state = "failed"; current.error = reason; }
          }
        }
        try { this.persist(job); }
        catch { this.readWarnings.push(`请检查归档停止记录的保存失败：domain-extraction/${job.id}/job.json`); }
      }
    }
    if (errors.length) throw new AggregateError(errors, "领域知识关停记录保存失败，执行体与发布器已停止等待");
  }
}
