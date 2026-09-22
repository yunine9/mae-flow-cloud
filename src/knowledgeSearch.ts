/** Unified read-only retrieval over published assets and adopted experiences.
 * Source catalogs remain authoritative; mirrors are disposable search input.
 * No workflow gates, inferred approvals, or edits to the original knowledge.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { listBusinessModules, readBusinessKnowledgeAsset } from "./businessModuleLibrary.ts";
import { listKnowledgeCandidateCatalog } from "./knowledgeCandidates.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";
import { MemoryStore, memoryAccessible, repoSlug } from "./taskMemory.ts";
import { MemorySidecar } from "./memorySidecar.ts";
import { listKnowledgeDocuments } from "./knowledgeDocuments.ts";

import { consolidateSearchCatalog, type KnowledgeApplicability } from "./knowledgeConsolidationStore.ts";

export interface KnowledgeContext {
  repo: string;
  repositories: string[];
  moduleIds: string[];
  productVersion?: string;
}
export interface SearchableKnowledge {
  id: string;
  title: string;
  kind: "experience" | "document" | "skill" | "rule" | "example";
  scope: string;
  summary: string;
  whenToUse: string;
  content: string;
  revision: string;
  productVersions: string[];
  path?: string;
  applicability?: KnowledgeApplicability;
}

/** Only explicit frontmatter metadata is machine-filtered. A version mentioned in
 * prose may be an example or exception; never infer scope from a loose regex. */
export function knowledgeProductVersions(content: string): string[] {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  const value = front && /^product_versions:\s*(\[[^\r\n]*\])\s*$/m.exec(front)?.[1];
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(v => typeof v === "string" && v.trim())
      ? [...new Set(parsed.map(v => v.trim()))] : [];
  } catch { return []; }
}

export function collectSearchableKnowledge(dataDir: string, context: KnowledgeContext, all = false, raw = false): {
  assets: SearchableKnowledge[]; warnings: string[];
} {
  const assets: SearchableKnowledge[] = [];
  const warnings: string[] = [];
  const repos = new Set(context.repositories.map(repositoryIdentity));
  const matchesRepos = (values: string[]) => all || !values.length || values.some(r => repos.has(repositoryIdentity(r)));
  const catalog = listBusinessModules(dataDir);
  warnings.push(...catalog.warnings);
  const activeModules = catalog.modules.filter(m => m.status === "active");
  const mapped = activeModules.filter(m => m.repositories.some(r => repos.has(repositoryIdentity(r))));
  const explicit = new Set(context.moduleIds);
  // A shared repository is not evidence that two business modules share rules.
  const modules = all ? activeModules : explicit.size
    ? activeModules.filter(m => explicit.has(m.id)) : mapped.length === 1 ? mapped : [];
  if (!all && !explicit.size && mapped.length > 1) warnings.push("仓库关联多个业务模块，未自动混用模块知识；请先明确本任务的业务模块。");
  const moduleIds = new Set(modules.map(m => m.id));
  for (const doc of listKnowledgeDocuments(dataDir)) {
    if (!doc.active || !matchesRepos(doc.repositories)
        || (doc.module_ids.length && !doc.module_ids.some(id => moduleIds.has(id)))) continue;
    assets.push({ id: doc.id, title: doc.title, kind: "document", scope: doc.scope === "platform" ? "平台通用"
      : doc.scope === "module" ? `业务模块：${doc.module_ids.join("、")}` : `代码仓：${doc.repositories.join("、")}`,
      summary: doc.when_to_use, whenToUse: [doc.when_to_use, doc.technologies.join("、"), doc.source ? `来源：${doc.source.repository} · ${doc.source.branch} · ${doc.source.path}` : ""].filter(Boolean).join("；"),
      content: doc.content, revision: doc.revision, productVersions: doc.product_versions,
      applicability: {modules:doc.module_ids,repositories:doc.repositories,languages:doc.technologies,versions:doc.product_versions} });
  }
  const candidates = listKnowledgeCandidateCatalog(dataDir);
  warnings.push(...candidates.warnings);
  for (const row of candidates.candidates) {
    if (row.status !== "published" || row.nature !== "engineering" || row.form === "skill"
        || !matchesRepos(row.repositories)
        || (row.business_module_ids.length && !row.business_module_ids.some(id => moduleIds.has(id)))) continue;
    // Do not hard-filter technologies based on an incomplete startup profile.
    // Preserve them in applicability text for the agent's current action.
    assets.push({ id: `team:${row.id}`, title: row.title, kind: row.form,
      scope: row.repositories.length ? `代码仓：${row.repositories.join("、")}`
        : row.business_module_ids.length ? `业务模块：${row.business_module_ids.join("、")}` : "团队通用",
      summary: row.summary, whenToUse: [row.when_to_use, row.technologies.length
        ? `适用技术：${row.technologies.join("、")}` : ""].filter(Boolean).join("；"),
      content: row.content, revision: row.digest, productVersions: knowledgeProductVersions(row.content),
      applicability:{modules:row.business_module_ids,repositories:row.repositories,languages:row.technologies,versions:knowledgeProductVersions(row.content)} });
  }
  for (const module of modules) for (const asset of module.assets) {
    if (asset.status !== "published" || asset.form === "skill" || !matchesRepos(asset.repositories)) continue;
    // Published business candidates are materialized in their module. Do not
    // offer a stale duplicate copy from the submission record.
    try {
      const doc = readBusinessKnowledgeAsset(dataDir, module.id, asset.id);
      assets.push({ id: `module:${module.id}:${asset.id}`, title: asset.title, kind: asset.form,
        scope: `业务模块：${module.name}`, summary: asset.summary, whenToUse: asset.when_to_use,
        content: doc.content, revision: String(asset.version), productVersions: knowledgeProductVersions(doc.content),
        applicability:{modules:[module.id],repositories:asset.repositories,languages:[],versions:knowledgeProductVersions(doc.content)} });
    } catch (error) { warnings.push(`模块资料 ${module.name}/${asset.title} 暂不可读：${String(error)}`); }
  }
  const store = new MemoryStore(dataDir);
  for (const row of store.list()) {
    if (all ? !memoryAccessible(row, row.repo, row.module ? [row.module] : []) : ![context.repo, ...context.repositories.map(repoSlug)].some(repo => memoryAccessible(row, repo, [...moduleIds], context.productVersion))) continue;
    const content = store.read(row.id);
    if (!content) continue;
    assets.push({ id: row.id, title: row.trigger, kind: "experience",
      scope: row.module ? `业务模块：${row.module}` : row.scope === "platform" ? "平台通用经验" : `代码仓：${row.repo}`,
      summary: row.conclusion, whenToUse: row.trigger, content,
      revision: String(row.revision ?? 1), productVersions: row.product_versions ?? knowledgeProductVersions(content),
      path: join(store.root, row.file),
      applicability:{modules:row.module?[row.module]:[],repositories:row.scope==="platform"?[]:[row.repo],languages:[],versions:row.product_versions??[],localPaths:row.scope==="local"?row.paths??[]:[]} });
  }
  // Explicit product scope narrows the current task; missing metadata remains
  // visible as unconfirmed rather than being guessed from document revisions.
  const scoped = assets.filter(a => !context.productVersion || !a.productVersions.length
    || a.productVersions.includes(context.productVersion));
  return {assets:raw ? scoped : consolidateSearchCatalog(dataDir,scoped),warnings};
}

export interface KnowledgeHit {
  id: string; title: string; kind: SearchableKnowledge["kind"]; scope: string;
  revision: string; productVersions: string[]; whenToUse: string;
  summary: string | undefined; versionNote: string;
  heading?: string;
  start_line?: number;
  end_line?: number;
}
export interface KnowledgeSearchResult { available: boolean; hits: KnowledgeHit[]; warnings: string[] }

async function within<T>(operation: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}

export class KnowledgeSearch {
  private indexed = new Map<string, string>();
  private indexing = new Map<string, Promise<boolean>>();
  private indexQueue: Promise<unknown> = Promise.resolve();
  private states = new Map<string, { key: string; state: "queued" | "indexing" | "failed"; error?: string }>();
  constructor(private dataDir: string, private sidecar?: MemorySidecar) {}

  catalog(context: KnowledgeContext) { return collectSearchableKnowledge(this.dataDir, context); }

  documentStatus(asset: SearchableKnowledge) {
    const path = this.mirror(asset), key = this.indexKey(path);
    if (this.indexed.get(path) === key) return { state: "ready", sections: this.sidecar?.indexedSections?.(path) };
    if (!this.sidecar) return { state: "failed", error: "知识检索服务未配置，原文已保存。" };
    const state = this.states.get(path);
    return state?.key === key ? state : { state: "queued" };
  }

  async searchDocument(id: string, query: string) {
    return this.search({ repo: "", repositories: [], moduleIds: [] }, query, 5, id);
  }

  async searchLibrary(query: string) {
    return this.search({ repo: "", repositories: [], moduleIds: [] }, query, 10, undefined, true);
  }

  /** Background preparation after publication/startup; search still scopes the catalog. */
  async prepare(): Promise<void> {
    if (!this.sidecar) return;
    const catalog = collectSearchableKnowledge(this.dataDir, { repo: "", repositories: [], moduleIds: [] }, true);
    const results = await Promise.all(catalog.assets.map(asset => this.ensureIndexed(this.mirror(asset))));
    const failed = results.filter(ok => !ok).length;
    if (failed) throw new Error(`${failed} 份资料未完成索引；原文仍可读取，后续查询可重试索引`);
  }

  async search(context: KnowledgeContext, query: string, limit = 5, onlyId?: string, library = false): Promise<KnowledgeSearchResult> {
    if (!this.sidecar) return { available: false as const, hits: [], warnings: ["知识检索暂不可用；继续当前任务。"] };
    const readCatalog = () => {
      const value = onlyId || library ? collectSearchableKnowledge(this.dataDir, context, true) : this.catalog(context);
      return onlyId ? { ...value, assets: value.assets.filter(a => a.id === onlyId) } : value;
    };
    const catalog = readCatalog();
    const sources = catalog.assets.map(asset => ({ id: asset.id, path: this.mirror(asset) }));
    if (!sources.length) return { available: true, hits: [], warnings: catalog.warnings };
    // One shared in-flight index per document revision; no duplicate
    // index jobs on repeated questions. The caller has a bounded wait below.
    const jobs = sources.map(source => this.ensureIndexed(source.path));
    const ready = await within(Promise.all(jobs).then(values => values.every(Boolean)), 1200);
    const searchable = sources.filter(source => this.indexed.get(source.path) === this.indexKey(source.path));
    if (!searchable.length) return { available: false as const, hits: [], warnings: ["相关知识索引正在准备或暂不可用；继续当前任务，不等待或反复重试。"] };
    const hits = await within(this.sidecar.search({ query, repo: context.repo, limit, sources: searchable }), this.sidecar.searchBudgetMs ?? 3000);
    if (!hits) return { available: false as const, hits: [], warnings: ["知识检索暂不可用；继续当前任务。"] };
    // A document may have been edited/withdrawn during asynchronous indexing.
    const current = new Map(readCatalog().assets.map(asset => [asset.id, asset]));
    const searched = new Map(catalog.assets.map(asset => [asset.id, asset]));
    return { available: true as const, warnings: [...catalog.warnings, ...(!ready || hits.pendingSources ? ["部分文档尚未索引完成，当前结果不是完整知识范围。"] : [])], hits: hits.flatMap(hit => {
      const asset = current.get(hit.id), prior = searched.get(hit.id);
      if (!asset || !prior || asset.content !== prior.content || asset.revision !== prior.revision) return [];
      const path = sources.find(source => source.id === asset.id)?.path;
      const offset = path && !asset.path ? readFileSync(path, "utf8").split("\n").length - asset.content.split("\n").length : 0;
      // Mirror metadata helps retrieval but is not a chapter in the original.
      if (hit.end_line !== undefined && hit.end_line <= offset) return [];
      const start = hit.start_line ? Math.max(1, hit.start_line - offset) : undefined;
      const end = hit.end_line ? Math.min(asset.content.split("\n").length, hit.end_line - offset) : undefined;
      return [{ id: asset.id, title: asset.title, kind: asset.kind, scope: asset.scope,
        heading: hit.heading, start_line: start, end_line: end && end >= (start ?? 1) ? end : undefined,
        revision: asset.revision, productVersions: asset.productVersions,
        whenToUse: asset.whenToUse, summary: asset.kind === "experience" ? asset.summary : hit.snippet,
        versionNote: asset.productVersions.length ? `适用产品版本：${asset.productVersions.join("、")}`
          : "未单独声明产品版本；使用前核对正文中的适用条件与例外。" }];
    }) };
  }

  read(context: KnowledgeContext, id: string) {
    return this.catalog(context).assets.find(a => a.id === id);
  }

  private mirror(asset: SearchableKnowledge): string {
    // Memory already has its authoritative Markdown; don't duplicate it.
    if (asset.path) return asset.path;
    // Metadata is already represented above the body. Blank its original lines
    // in the disposable mirror so YAML separators cannot become Setext headings.
    const body = asset.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
      block => block.replace(/[^\n]/g, ""));
    const text = `---\nknowledge_id: ${JSON.stringify(asset.id)}\nasset_status: published\n---\n`
      + `# ${asset.title}\n\n适用范围：${asset.scope}\n适用条件：${asset.whenToUse}\n${asset.summary}\n\n${body}`;
    const hash = createHash("sha256").update(asset.id).digest("hex");
    const root = join(this.dataDir, "corpus", "_knowledge");
    const path = join(root, `${hash}.md`);
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
      mkdirSync(root, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, text, { mode: 0o640 });
      renameSync(temporary, path);
    }
    return path;
  }

  private indexKey(path: string): string {
    return path + ":" + createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  private ensureIndexed(path: string): Promise<boolean> {
    // Includes contents: edits to a memory at the same path need reindexing.
    const key = this.indexKey(path);
    if (this.indexed.get(path) === key) return Promise.resolve(true);
    const existing = this.indexing.get(key);
    if (existing) return existing;
    this.states.set(path, { key, state: "queued" });
    const job = this.indexQueue.then(() => {
      this.states.set(path, { key, state: "indexing" });
      return this.sidecar!.ingest(path, 600_000);
    }).then(ok => { if (ok) this.indexed.set(path, key);
      else this.states.set(path, { key, state: "failed", error: "索引未完成，请确认检索服务可用后重试。" }); return ok; })
      .catch(() => { this.states.set(path, { key, state: "failed", error: "索引失败，原文已保存，可重试。" }); return false; })
      .finally(() => this.indexing.delete(key));
    this.indexQueue = job;
    this.indexing.set(key, job);
    return job;
  }
}
