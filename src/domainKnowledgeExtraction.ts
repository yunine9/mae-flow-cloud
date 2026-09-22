import { KnowledgeExtractionSkills } from "./knowledgeExtractionSkills.ts";
import { knowledgeArchiveDefaults } from "./knowledgeArchiveDefaults.ts";
import { readKnowledgeRepoConfig } from "./knowledgeRepoConfig.ts";
import { readBusinessModule } from "./businessModuleLibrary.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import { assertRepositoryCloneAddress } from "./repositoryAddress.ts";
import { readKnowledgeMaterial } from "./knowledgeMaterials.ts";

import type { KnowledgeRepository, DomainDocumentContent, DomainDocument, DomainTurn, DomainPublication, DomainKnowledgeJob, DomainExecution, DomainRemoteReview, KnowledgeCleanupPlan } from "./domainKnowledgeTypes.ts";
export type { KnowledgeRepository, DomainDocumentContent, DomainDocument, DomainTurn, DomainPublication, DomainKnowledgeJob, DomainExecution } from "./domainKnowledgeTypes.ts";

export function knowledgeIssueNumber(value: unknown): string {
  const issue = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(issue)) throw new Error("请填写一个有效的关联单号（最多 120 位字母、数字、点、下划线或短横线）");
  return issue;
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

export class DomainKnowledgeExtraction {
  private jobs = new Map<string, DomainKnowledgeJob>();
  private running = new Map<string, { controller: AbortController; work: Promise<void> }>();
  private publishing = new Set<string>();
  private stopped = false;
  constructor(readonly dataDir: string, private execute: (input: DomainExecution) => Promise<string>, private options: {
    publish?: (job: DomainKnowledgeJob, target: KnowledgeRepository, previous: DomainPublication | undefined, operator: string, save: (publication: DomainPublication) => void) => Promise<DomainPublication>;
    refresh?: (job: DomainKnowledgeJob, publication: DomainPublication, operator: string) => Promise<DomainPublication>;
    previewCleanup?: (job: DomainKnowledgeJob, target: KnowledgeRepository, input: unknown, operator: string) => Promise<KnowledgeCleanupPlan>;
    readRemote?: (job: DomainKnowledgeJob, document: DomainDocument, operator: string) => Promise<DomainRemoteReview>;
  } = {}) {
    const root = join(dataDir, "domain-extraction");
    if (existsSync(root)) for (const name of readdirSync(root).filter(n => /^dkx-[a-f0-9-]{36}$/.test(n))) {
      const path = join(root, name, "job.json");
      if (!existsSync(path)) continue;
      const job: DomainKnowledgeJob = JSON.parse(readFileSync(path, "utf8"));
      this.jobs.set(job.id, job);
      if (["queued", "running"].includes(job.status)) {
        job.status = "failed"; job.stage = "服务重启中断研究，已有草稿保留";
        for (const turn of job.turns) if (["queued", "running"].includes(turn.status)) { turn.status = "failed"; turn.error = job.stage; }
        this.persist(job);
      }
    }
  }
  private root(id: string) { return join(this.dataDir, "domain-extraction", id); }
  private live(id: string) { const job = this.jobs.get(id); if (!job) throw new Error("领域萃取任务不存在"); return job; }
  private persist(job: DomainKnowledgeJob) {
    mkdirSync(this.root(job.id), { recursive: true });
    const path = join(this.root(job.id), "job.json");
    writeFileSync(`${path}.tmp`, JSON.stringify(job), { mode: 0o600 }); renameSync(`${path}.tmp`, path);
  }
  get(id: string) { return structuredClone(this.live(id)); }
  list() { return [...this.jobs.values()].filter(job => !job.component_research_id).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(job => ({ ...structuredClone(job), documents: job.documents.map(({ content: _, history: __, base_content: ___, remote_review: ____, ...doc }) => doc), evidence: [], turns: [], publications: [], publication_history: [] })); }
  componentArchive(researchId: string) {
    const job = [...this.jobs.values()].find(job => job.component_research_id === researchId);
    return job ? this.get(job.id) : undefined;
  }
  prepareComponent(input: { research_id: string; title: string; content: string; sources: string; language: string;
    target: unknown; filename: unknown; issue_no: unknown; base_revision?: number }, operator: string) {
    if (this.stopped) throw new Error("服务正在停止");
    if (!input.content?.trim()) throw new Error("请提供非空的组件知识正文");
    const issue_no = knowledgeIssueNumber(input.issue_no), target = repository(input.target, "domain");
    const filename = knowledgeRelativePath(input.filename, true);
    if (filename.includes("/")) throw new Error("文件名不能包含目录，请在归档目录中填写路径");
    const path = `${target.docs_path}/${filename}`;
    const existing = this.componentArchive(input.research_id);
    const job: DomainKnowledgeJob = existing ? this.live(existing.id) : {
      id: `dkx-${randomUUID()}`, component_research_id: input.research_id, technologies: [input.language],
      title: input.title, scope: "基础组件知识归档", issue_no, operator, created_at: new Date().toISOString(),
      repositories: [], knowledge_target: target, material_ids: [], ar_codes: [], use_wxdoubao: false,
      status: "done", stage: "待审查提交内容", revisions: {}, documents: [], turns: [], evidence: [], publications: [],
    };
    if (this.publishing.has(job.id)) throw new Error("正在归档，请稍后准备文档");
    if (existing && input.base_revision !== job.documents[0].revision) throw new Error("归档草稿已有新版本，请刷新后重新准备");
    const changedTarget = JSON.stringify(job.knowledge_target) !== JSON.stringify(target) || job.documents[0]?.path !== path;
    if (job.publications.length && (changedTarget || job.issue_no !== issue_no)) throw new Error("已发起归档，不能更换目标仓、分支、路径或关联单号");
    const candidate = { ...job, knowledge_target: target };
    const document: DomainDocumentContent = { id: "component-guide", title: input.title, target_id: "domain", path, layer: "domain", content: `${input.content.trimEnd()}\n\n## 萃取来源\n\n${input.sources.trim()}\n`, sources: input.sources };
    this.validateDocument(candidate, document);
    const old = job.documents[0];
    const next: DomainDocument = { ...document, selected: true, revision: (old?.revision ?? 0) + 1,
      base_content: changedTarget ? null : old?.base_content ?? null, base_revision: changedTarget ? "" : old?.base_revision ?? "",
      history: old ? [...old.history, { revision: old.revision, title: old.title, content: old.content, sources: old.sources, operator, at: new Date().toISOString() }] : [],
    };
    Object.assign(job, { title: input.title, issue_no, knowledge_target: target, documents: [next], stage: "待审查提交内容" });
    this.jobs.set(job.id, job); this.persist(job); return this.get(job.id);
  }
  create(input: any, operator: string) {
    if (this.stopped) throw new Error("服务正在停止");
    if ([...this.jobs.values()].filter(job => ["queued", "running"].includes(job.status)).length >= 50) throw new Error("当前研究队列已满，请稍后创建");
    const issue_no = knowledgeIssueNumber(input.issue_no);
    const module_id = input.module_id ? String(input.module_id) : undefined;
    if (module_id) {
      const module = readBusinessModule(this.dataDir, module_id);
      if (module.status !== "active") throw new Error("业务模块已停用");
      if (!module.repositories.length) throw new Error("请先在业务模块中维护关联代码仓");
      input = { ...input, title: module.name, scope: `按照领域知识萃取 Skill，完整研究业务模块「${module.name}」及其全部关联仓。模块说明：${module.description}`,
        repositories: module.repositories.map(url => ({ repository: url, name: url.split("/").at(-1)?.replace(/\.git$/, "") || module.name, branch: input.baseline_branch || "main", path: "" })) };
    }
    const title = String(input.title ?? "").trim(), scope = String(input.scope ?? "").trim();
    if (!title || title.length > 160 || !scope || scope.length > 10000) throw new Error("请填写业务域名称及本次研究范围");
    if (!Array.isArray(input.repositories) || !input.repositories.length || input.repositories.length > 30) throw new Error("请选择 1～30 个业务仓");
    const defaults = knowledgeArchiveDefaults(new KnowledgeExtractionSkills(this.dataDir).current("domain").files, "domain");
    const repositories = input.repositories.map((r: any, i: number) => repository({ ...r, docs_path: r.docs_path || defaults.repository_directory }, `repo-${i + 1}`));
    const configured = readKnowledgeRepoConfig(this.dataDir);
    const knowledge_target = input.knowledge_target ? repository(input.knowledge_target, "domain") : {
      id: "domain", name: "领域知识仓", repository: configured?.url || "", branch: configured?.branch || "main", path: "",
      docs_path: configured?.docs_path || defaults.domain_directory,
    };
    if (new Set(repositories.map(r => r.repository)).size !== repositories.length || (input.knowledge_target && repositories.some(r => r.repository === knowledge_target.repository))) throw new Error("业务仓不能重复，领域知识仓须独立指定");
    const material_ids = this.materialIds(input.material_ids ?? []);
    const ar_codes = this.arCodes(input.ar_codes ?? []);
    scanForSecrets("业务范围", Buffer.from(JSON.stringify({ title, scope, ar_codes })));
    const job: DomainKnowledgeJob = { id: `dkx-${randomUUID()}`, title, scope, issue_no, module_id, operator, created_at: new Date().toISOString(), repositories, knowledge_target,
      source_repositories: structuredClone(repositories), archive_configured: !!input.knowledge_target, archive_revision: 0,
      material_ids, ar_codes, use_wxdoubao: input.use_wxdoubao === true, status: "idle", stage: "准备研究", revisions: {}, documents: [], turns: [], evidence: [], publications: [] };
    this.jobs.set(job.id, job); this.persist(job);
    return this.run(job.id, { mode: "extract", message: scope }, operator);
  }
  configureArchive(id: string, input: { targets: unknown; base_revision?: number }) {
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
        if (!path.startsWith(`${old.docs_path}/`)) throw new Error("草稿目录与归档目标不一致");
        return `${next.docs_path}/${path.slice(old.docs_path.length + 1)}`;
      };
      for (const doc of candidate.documents.filter(d => d.target_id === old.id)) {
        doc.path = remap(doc.path); doc.base_content = null; doc.base_revision = ""; delete doc.remote_review;
      }
      for (const turn of candidate.turns) for (const proposal of turn.proposals.filter(p => p.document.target_id === old.id)) proposal.document.path = remap(proposal.document.path);
      candidate.cleanup_plans = candidate.cleanup_plans?.filter(p => p.target_id !== old.id);
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
    const turn: DomainTurn = { id: randomUUID(), mode: input.mode, document_ids: ids, message, operator, status: "queued", created_at: new Date().toISOString(), proposals: [], use_latest_skill: input.use_latest_skill === true };
    if (input.mode === "update") { turn.previous_revisions = { ...job.revisions }; job.revisions = {}; }
    job.turns.push(turn); job.status = "queued"; job.stage = "等待研究"; job.error = undefined;
    this.persist(job); this.pump(); return this.get(id);
  }
  private validateDocument(job: DomainKnowledgeJob, input: DomainDocumentContent) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(input.id) || !input.title?.trim() || input.title.length > 160 || !input.content?.trim() || !input.sources?.trim()) throw new Error("文档需要稳定编号、标题、正文与来源");
    const maxBytes = (job.component_research_id ? 16 : 2) * 1024 * 1024;
    if (Buffer.byteLength(input.content) > maxBytes) throw new Error(`单份草稿不能超过 ${maxBytes / 1024 / 1024} MiB`);
    const target = [job.knowledge_target, ...job.repositories].find(r => r.id === input.target_id);
    if (!target || input.layer !== (target.id === "domain" ? "domain" : "repository")) throw new Error("领域文档进入知识仓，仓内文档进入对应业务仓");
    const path = knowledgeRelativePath(input.path, true);
    if (!path.startsWith(`${target.docs_path}/`)) throw new Error("文档只能写入本次指定的文档目录");
    if (job.documents.some(doc => doc.id !== input.id && doc.target_id === input.target_id && doc.path === path)) throw new Error("该目标文件已有草稿，请更新原编号");
    scanForSecrets("领域知识草稿", Buffer.from(JSON.stringify(input)));
  }
  private pump() {
    if (this.stopped) return;
    for (const job of this.jobs.values()) {
      if (this.running.size >= 2) return;
      if (job.status !== "queued" || this.running.has(job.id)) continue;
      const turn = job.turns.find(t => t.status === "queued")!;
      const controller = new AbortController(), base = structuredClone(job.documents), proposed = new Map<string, DomainDocumentContent>();
      job.status = "running"; job.stage = "研究中"; turn.status = "running"; this.persist(job);
      const work = Promise.resolve().then(async () => {
        try {
          const reply = await this.execute({ job: this.get(job.id), turn: structuredClone(turn), root: this.root(job.id), signal: controller.signal,
            read: () => structuredClone(job.documents),
            update: patch => { if (!controller.signal.aborted) { Object.assign(job, patch); if (patch.skill) turn.skill = patch.skill; this.persist(job); } },
            evidence: event => { if (!controller.signal.aborted) { scanForSecrets("研究记录", Buffer.from(JSON.stringify(event))); job.evidence.push({ at: new Date().toISOString(), ...event }); this.persist(job); } },
            save: (input, baseline) => {
              if (controller.signal.aborted) throw new Error("本轮已停止");
              if (turn.mode === "discuss") throw new Error("讨论不修改文档");
              // Model output is content only; publication and human-review fields
              // are exclusively managed by explicit service operations.
              input = { id: input.id, title: input.title, target_id: input.target_id, path: input.path, layer: input.layer, content: input.content, sources: input.sources };
              this.validateDocument(job, input);
              const existing = job.documents.find(doc => doc.id === input.id);
              if (existing && (existing.target_id !== input.target_id || existing.path !== input.path || existing.layer !== input.layer)) throw new Error("已有文档不能改变归档位置");
              if (turn.mode !== "extract") {
                if (!turn.document_ids.includes(input.id)) throw new Error("只能修订本轮选中文档");
                proposed.set(input.id, structuredClone(input));
              } else {
                // Continuing an interrupted extraction must preserve already completed or edited documents.
                if (existing) throw new Error("该文档已有草稿，修改请使用局部修订");
                if (job.archive_configured !== false && (!baseline || !/^[a-f0-9]{40,64}$/.test(baseline.revision))) throw new Error("尚未读取目标文件的归档基线");
                job.documents.push({ ...structuredClone(input), revision: 1, selected: true, base_content: baseline?.content ?? null, base_revision: baseline?.revision ?? "", history: [] });
                this.persist(job);
              }
              return structuredClone(input);
            },
          });
          if (controller.signal.aborted) return;
          if (!reply.trim()) throw new Error("本轮没有返回结果");
          scanForSecrets("研究答复", Buffer.from(reply));
          if (turn.mode === "extract" && (!job.documents.length || !job.documents.some(doc => doc.layer === "domain"))) throw new Error("尚未生成领域知识草稿，已保存内容保留");
          turn.proposals = [...proposed.values()].map(document => ({ document, base_revision: base.find(doc => doc.id === document.id)!.revision, status: "pending" }));
          turn.reply = reply; turn.status = "done"; job.status = "done"; job.stage = "本轮完成，等待审查";
        } catch (error) {
          if (controller.signal.aborted) return;
          turn.status = "failed"; job.status = "failed"; job.error = turn.error = error instanceof Error ? error.message : "研究失败"; job.stage = "本轮失败，已有文档保留";
        } finally { this.persist(job); }
      }).finally(() => { this.running.delete(job.id); this.pump(); });
      this.running.set(job.id, { controller, work });
    }
  }
  edit(id: string, input: { document: DomainDocumentContent; base_revision: number }, operator: string) {
    const job = this.live(id), doc = job.documents.find(d => d.id === input.document?.id);
    if (!doc || this.publishing.has(id)) throw new Error("文档不存在或正在归档");
    if (input.base_revision !== doc.revision) throw new Error("文档已有新版本，请比较差异后重新保存");
    this.validateDocument(job, input.document);
    if (doc.target_id !== input.document.target_id || doc.path !== input.document.path || doc.layer !== input.document.layer) throw new Error("不能通过编辑改变归档位置");
    doc.history.push({ revision: doc.revision, title: doc.title, content: doc.content, sources: doc.sources, operator, at: new Date().toISOString() });
    Object.assign(doc, { title: input.document.title, content: input.document.content, sources: input.document.sources, revision: doc.revision + 1 }); this.persist(job); return this.get(id);
  }
  decide(id: string, turnId: string, documentId: string, decision: "accept" | "discard", operator: string) {
    const job = this.live(id), proposal = job.turns.find(t => t.id === turnId)?.proposals.find(p => p.document.id === documentId);
    if (!proposal || !["accept", "discard"].includes(decision)) throw new Error("修订建议或操作无效");
    if (proposal.status !== "pending") return this.get(id);
    if (decision === "accept") this.edit(id, { document: proposal.document, base_revision: proposal.base_revision }, operator);
    proposal.status = decision === "accept" ? "accepted" : "discarded"; this.persist(job); return this.get(id);
  }
  restore(id: string, documentId: string, revision: number, baseRevision: number, operator: string) {
    const doc = this.live(id).documents.find(d => d.id === documentId), previous = doc?.history.find(h => h.revision === revision);
    if (!doc || !previous) throw new Error("历史版本不存在");
    return this.edit(id, { document: { ...doc, content: previous.content, title: previous.title, sources: previous.sources }, base_revision: baseRevision }, operator);
  }
  async readRemote(id: string, documentId: string, operator: string) {
    const job = this.live(id), doc = job.documents.find(d => d.id === documentId);
    if (job.archive_configured === false) throw new Error("请先在入库与更新中保存归档位置");
    if (!doc || !this.options.readRemote) throw new Error("无法读取该文档的远端版本");
    if (this.publishing.has(id)) throw new Error("正在归档，请稍后读取");
    this.publishing.add(id);
    try { doc.remote_review = await this.options.readRemote(this.get(id), structuredClone(doc), operator); this.persist(job); return this.get(id); }
    finally { this.publishing.delete(id); }
  }
  reconcile(id: string, input: { document: DomainDocumentContent; base_revision: number; snapshot_id: string }, operator: string) {
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
      this.running.get(id)?.controller.abort(); this.persist(job);
    }
    return this.get(id);
  }
  async previewCleanup(id: string, targetId: string, input: unknown, operator: string) {
    const job = this.live(id), target = [job.knowledge_target, ...job.repositories].find(t => t.id === targetId);
    if (job.archive_configured === false) throw new Error("请先保存归档位置再预览清理范围");
    if (!target || !this.options.previewCleanup) throw new Error("无法预览此仓的清理范围");
    if (this.publishing.has(id) || ["queued", "running"].includes(job.status)) throw new Error("请等待当前操作完成");
    this.publishing.add(id);
    try {
      const plan = await this.options.previewCleanup(this.get(id), target, input, operator);
      job.cleanup_plans = [...(job.cleanup_plans ?? []).filter(p => p.target_id !== targetId), plan];
      this.persist(job); return this.get(id);
    } finally { this.publishing.delete(id); }
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
  setIssueNumber(id: string, value: unknown) {
    const job = this.live(id), issue = knowledgeIssueNumber(value);
    if (this.publishing.has(id)) throw new Error("正在创建 MR，请稍后修改关联单号");
    if (job.issue_no === issue) return this.get(id);
    if ([...job.publications, ...(job.publication_history ?? [])].some(p => p.mr_attempted || p.url)) throw new Error("已发起 MR 创建，不能更改本任务的关联单号");
    job.issue_no = issue; this.persist(job); return this.get(id);
  }
  async publish(id: string, operator: string) {
    const job = this.live(id);
    knowledgeIssueNumber(job.issue_no);
    if (job.archive_configured === false) throw new Error("请在入库与更新中确认归档位置");
    if (!this.options.publish) throw new Error("未配置 MR 归档能力");
    if (this.publishing.has(id) || ["queued", "running"].includes(job.status)) throw new Error("本轮仍在执行");
    if (!job.documents.some(d => d.selected)) throw new Error("请至少选择一份文档");
    this.publishing.add(id);
    try {
      for (const target of [job.knowledge_target, ...job.repositories].filter(t => job.documents.some(d => d.selected && d.target_id === t.id) || job.publications.some(p => p.target_id === t.id && !["merged", "closed", "unchanged"].includes(p.state)))) {
        const save = (publication: DomainPublication) => {
          const index = job.publications.findIndex(p => p.target_id === target.id);
          if (index >= 0 && job.publications[index].branch !== publication.branch) (job.publication_history ??= []).push(structuredClone(job.publications[index]));
          if (index < 0) job.publications.push(publication); else job.publications[index] = publication;
          this.persist(job);
        };
        const previous = job.publications.find(p => p.target_id === target.id);
        try { save(await this.options.publish(this.get(id), target, previous, operator, save)); }
        catch (error) {
          const latest = job.publications.find(p => p.target_id === target.id) ?? previous ?? { target_id: target.id, branch: `codex/knowledge-${job.id}-${target.id}`, documents: [], state: "failed" as const };
          save({ ...latest, state: latest.state === "merged" ? "merged" : "failed", error: error instanceof Error ? error.message : "归档失败" });
        }
      }
      return this.get(id);
    } finally { this.publishing.delete(id); }
  }
  async refresh(id: string, operator: string) {
    const job = this.live(id);
    if (!this.options.refresh) throw new Error("未配置 MR 状态查询");
    if (this.publishing.has(id)) throw new Error("正在归档，请稍后刷新");
    this.publishing.add(id);
    try {
      for (let i = 0; i < job.publications.length; i++) if (job.publications[i].url || job.publications[i].state === "unchanged") {
        try { job.publications[i] = await this.options.refresh(this.get(id), job.publications[i], operator); }
        catch (error) { job.publications[i].error = error instanceof Error ? error.message : "MR 状态查询失败"; }
        this.persist(job);
      }
      return this.get(id);
    } finally { this.publishing.delete(id); }
  }
  async shutdown() { this.stopped = true; for (const job of this.jobs.values()) this.stop(job.id); await Promise.allSettled([...this.running.values()].map(r => r.work)); }
}
