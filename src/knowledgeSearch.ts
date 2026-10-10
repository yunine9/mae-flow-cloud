import { isComponentKnowledge, componentCards, componentCardHit, localComponentCards, componentQueryLanguage } from "./componentKnowledgeCards.ts";
import { componentIndexDocuments, componentIndexSources, saveComponentIndexSources, removeComponentIndexSources } from "./componentCardIndex.ts";
/** Unified read-only retrieval over published assets and adopted experiences.
 * Source catalogs remain authoritative; mirrors are disposable search input.
 * No workflow gates, inferred approvals, or edits to the original knowledge.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { retryKnowledgeDeletions } from "./componentKnowledgeDeletion.ts";
import { join } from "node:path";
import { listBusinessModules, readBusinessKnowledgeAsset } from "./businessModuleLibrary.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";
import { MemoryStore, memoryAccessible, repoSlug } from "./taskMemory.ts";
import { MemorySidecar } from "./memorySidecar.ts";
import { listKnowledgeDocuments } from "./knowledgeDocuments.ts";

export interface KnowledgeApplicability {
  modules: string[];
  repositories: string[];
  languages: string[];
  versions: string[];
  localPaths?: string[];
}

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

/** 明确选择优先；只有仓库唯一对应一个模块时才自动使用该模块。 */
export function resolveKnowledgeModules(dataDir: string, context: Pick<KnowledgeContext, "repositories" | "moduleIds">, all = false) {
  const repos = new Set(context.repositories.map(repositoryIdentity));
  const warnings: string[] = [];
  const catalog = listBusinessModules(dataDir);
  warnings.push(...catalog.warnings);
  const activeModules = catalog.modules.filter(m => m.status === "active");
  const mapped = activeModules.filter(m => m.repositories.some(r => repos.has(repositoryIdentity(r))));
  const explicit = new Set(context.moduleIds);
  // A shared repository is not evidence that two business modules share rules.
  const modules = all ? activeModules : explicit.size
    ? activeModules.filter(m => explicit.has(m.id)) : mapped.length === 1 ? mapped : [];
  if (!all && !explicit.size && mapped.length > 1) warnings.push("仓库关联多个业务模块，未自动混用模块知识；请先明确本任务的业务模块。");
  return { modules, warnings };
}

export function collectSearchableKnowledge(dataDir: string, context: KnowledgeContext, all = false): {
  assets: SearchableKnowledge[]; warnings: string[];
} {
  const assets: SearchableKnowledge[] = [];
  const warnings: string[] = [];
  const repos = new Set(context.repositories.map(repositoryIdentity));
  const matchesRepos = (values: string[]) => all || !values.length || values.some(r => repos.has(repositoryIdentity(r)));
  const selection = resolveKnowledgeModules(dataDir, context, all);
  const modules = selection.modules;
  warnings.push(...selection.warnings);
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
  for (const module of modules) for (const asset of module.assets) {
    if (asset.status !== "published" || asset.form === "skill" || !matchesRepos(asset.repositories)) continue;
    // 模块库是业务资产的正文来源，检索只读取已发布的当前版本。
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
  return {assets: scoped,warnings};
}

export interface KnowledgeHit {
  id: string; title: string; kind: SearchableKnowledge["kind"]; scope: string;
  revision: string; productVersions: string[]; whenToUse: string;
  summary: string | undefined; versionNote: string;
  card_id?: string; paradigm_id?: string; retrieval?: "memsearch" | "local" | "full";
  contracts?: Array<{ id: string; revision: string; start_line: number; end_line: number }>;
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
    if (isComponentKnowledge(asset)) {
      const result = componentCards([asset]);
      return result.warnings.length ? { state: "failed", error: result.warnings.join("；") } : { state: "ready", sections: result.cards.length };
    }
    const path = this.mirror(asset), key = this.indexKey(path);
    if (this.indexed.get(path) === key) return { state: "ready", sections: this.sidecar?.indexedSections?.(path) };
    if (!this.sidecar) return { state: "failed", error: "知识检索服务未配置，原文已保存。" };
    const state = this.states.get(path);
    return state?.key === key ? state : { state: "queued" };
  }

  componentContext(context: KnowledgeContext, offset = 0) {
    const catalog = this.catalog(context), derived = componentCards(catalog.assets);
    // 固定顺序避免文档更新时间变化打乱下一页；每次仍重新核对当前适用范围与版本。
    const cards = derived.cards.sort((a, b) => a.asset.id < b.asset.id ? -1 : a.asset.id > b.asset.id ? 1 : 0);
    const validOffset = Number.isSafeInteger(offset) && offset >= 0;
    const start = validOffset ? Math.min(offset, cards.length) : 0, pageSize = 12, maxChars = 12_000;
    const hits: KnowledgeHit[] = [];
    for (const card of cards.slice(start, start + pageSize)) {
      const hit = componentCardHit(card, "full");
      if (JSON.stringify([...hits, hit]).length > maxChars) break;
      hits.push(hit);
    }
    return { mode: start === 0 && hits.length === cards.length ? "full" : "paged", count: cards.length, offset: start, page_size: pageSize,
      next_offset: start + hits.length < cards.length ? start + hits.length : null, hits,
      warnings: [...catalog.warnings, ...derived.warnings, ...(!validOffset ? ["目录 offset 无效，已从第一页返回。"] : [])] };
  }

  private registerCards(assets: SearchableKnowledge[]) {
    const derived = componentCards(assets);
    for (const asset of assets.filter(isComponentKnowledge)) {
      const before = componentIndexSources(this.dataDir, asset.id);
      const sources = [...new Set([...(before ?? [asset.id]), ...derived.cards.filter(c => c.source.id === asset.id).map(c => c.asset.id)])];
      if (JSON.stringify(before) !== JSON.stringify(sources)) saveComponentIndexSources(this.dataDir, asset.id, sources);
    }
    return derived;
  }

  /** 组件索引包含正式用法和接入配置；对外命中仍只返回短卡片及原文位置。 */
  async prepare(): Promise<void> {
    if (!this.sidecar) return;
    await retryKnowledgeDeletions(this.dataDir, this);
    const catalog = collectSearchableKnowledge(this.dataDir, { repo: "", repositories: [], moduleIds: [] }, true);
    const derived = this.registerCards(catalog.assets);
    for (const id of componentIndexDocuments(this.dataDir)) {
      const live = derived.cards.filter(c => c.source.id === id).map(c => c.asset.id), retained = [...live];
      for (const retired of (componentIndexSources(this.dataDir, id) ?? []).filter(source => !live.includes(source))) {
        if (!await this.removeIndexSource(retired)) retained.push(retired);
      }
      if (retained.length) saveComponentIndexSources(this.dataDir, id, retained);
      else removeComponentIndexSources(this.dataDir, id);
    }
    const inputs = [...catalog.assets.filter(asset => !isComponentKnowledge(asset)), ...derived.cards.map(c => c.asset)];
    const results = await Promise.all(inputs.map(asset => this.ensureIndexed(this.mirror(asset))));
    const failed = results.filter(ok => !ok).length;
    if (failed) throw new Error(`${failed} 份资料未完成索引；原文仍可读取，后续查询可重试索引`);
  }

  async search(context: KnowledgeContext, query: string, limit = 5, componentsOnly = false): Promise<KnowledgeSearchResult> {
    const readCatalog = () => {
      const value = this.catalog(context);
      return { ...value, assets: value.assets.filter(a => !componentsOnly || isComponentKnowledge(a)) };
    };
    const catalog = readCatalog(), derived = this.sidecar ? this.registerCards(catalog.assets) : componentCards(catalog.assets);
    const language = componentQueryLanguage(query);
    if (language) derived.cards = derived.cards.filter(c => c.paradigm.language === language);
    const ordinary = catalog.assets.filter(a => !isComponentKnowledge(a));
    const warnings = [...catalog.warnings, ...derived.warnings];
    const fresh = (hits: KnowledgeHit[]) => {
      const current = new Map(readCatalog().assets.map(a => [a.id, a]));
      return hits.filter(h => current.get(h.id)?.revision === h.revision);
    };
    const fallback = (extra: string[]): KnowledgeSearchResult => ({ available: derived.cards.length > 0 || !ordinary.length,
      hits: fresh(localComponentCards(derived.cards, query, limit)), warnings: [...warnings, ...extra] });
    if (!this.sidecar) return fallback(["memsearch 暂不可用；组件改用本地正式用法检索，普通文档仍可按 ID 读取。继续当前任务，不反复等待。"]);
    const inputs = [...ordinary, ...derived.cards.map(c => c.asset)];
    if (!inputs.length) return { available: true, hits: [], warnings };
    const sources = inputs.map(a => ({ id: a.id, path: this.mirror(a) }));
    const jobs = sources.map(source => this.ensureIndexed(source.path));
    const ready = await within(Promise.all(jobs).then(values => values.every(Boolean)), 1200);
    const searchable = sources.filter(source => this.indexed.get(source.path) === this.indexKey(source.path));
    if (!searchable.length) return fallback(["索引尚未就绪，组件使用本地正式用法检索。"]);
    const hits = await within(this.sidecar.search({ query, repo: context.repo, limit, sources: searchable }), this.sidecar.searchBudgetMs ?? 3000).catch(() => undefined);
    if (!hits) return fallback(["memsearch 查询未完成，组件使用本地正式用法检索。"]);
    const byCard = new Map(derived.cards.map(c => [c.asset.id, c]));
    const found: KnowledgeHit[] = hits.flatMap(hit => {
      const card = byCard.get(hit.id);
      if (card) return [componentCardHit(card, "memsearch")];
      const asset = ordinary.find(a => a.id === hit.id);
      if (!asset) return [];
      const path = sources.find(s => s.id === asset.id)?.path;
      if (!path || !existsSync(path)) return [];
      const offset = !asset.path ? readFileSync(path, "utf8").split("\n").length - asset.content.split("\n").length : 0;
      if (hit.end_line !== undefined && hit.end_line <= offset) return [];
      const start = hit.start_line ? Math.max(1, hit.start_line - offset) : undefined;
      const end = hit.end_line ? Math.min(asset.content.split("\n").length, hit.end_line - offset) : undefined;
      return [{ id: asset.id, title: asset.title, kind: asset.kind, scope: asset.scope, heading: hit.heading,
        start_line: start, end_line: end && end >= (start ?? 1) ? end : undefined, revision: asset.revision,
        productVersions: asset.productVersions, whenToUse: asset.whenToUse, summary: asset.kind === "experience" ? asset.summary : hit.snippet,
        versionNote: asset.productVersions.length ? `适用产品版本：${asset.productVersions.join("、")}` : "未单独声明产品版本；使用前核对正文中的适用条件与例外。" }];
    });
    if (!ready || hits.pendingSources) {
      warnings.push("部分索引尚未就绪，组件补充本地卡片结果，当前结果不是完整知识范围。");
      found.push(...localComponentCards(derived.cards, query, limit).filter(local => !found.some(hit => hit.id === local.id && hit.paradigm_id === local.paradigm_id)));
    }
    const unique = [...new Map(found.map(hit => [`${hit.id}:${hit.paradigm_id ?? hit.start_line ?? ""}`, hit])).values()];
    return { available: true, hits: fresh(unique).slice(0, limit), warnings };
  }

  read(context: KnowledgeContext, id: string) {
    return this.catalog(context).assets.find(a => a.id === id);
  }

  async removeFromIndex(id: string): Promise<boolean> {
    const ids = [...new Set([id, ...(componentIndexSources(this.dataDir, id) ?? [])])];
    const results = await Promise.all(ids.map(source => this.removeIndexSource(source)));
    if (results.every(Boolean)) removeComponentIndexSources(this.dataDir, id);
    return results.every(Boolean);
  }

  private async removeIndexSource(id: string): Promise<boolean> {
    const path = this.mirrorPath(id);
    rmSync(path, { force: true });
    this.indexed.delete(path); this.states.delete(path);
    try { return await this.sidecar?.remove(path) ?? false; }
    catch { return false; }
  }

  private mirrorPath(id: string) {
    return join(this.dataDir, "corpus", "_knowledge", `${createHash("sha256").update(id).digest("hex")}.md`);
  }

  private mirror(asset: SearchableKnowledge): string {
    // Memory already has its authoritative Markdown; don't duplicate it.
    if (asset.path) return asset.path;
    // Metadata is already represented above the body. Blank its original lines
    // in the disposable mirror so YAML separators cannot become Setext headings.
    const body = asset.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
      block => block.replace(/[^\n]/g, ""));
    const text = asset.id.startsWith("component-card:") ? `---\nknowledge_id: ${JSON.stringify(asset.id)}\nasset_status: published\n---\n${asset.content}` : `---\nknowledge_id: ${JSON.stringify(asset.id)}\nasset_status: published\n---\n`
      + `# ${asset.title}\n\n适用范围：${asset.scope}\n适用条件：${asset.whenToUse}\n${asset.summary}\n\n${body}`;
    const root = join(this.dataDir, "corpus", "_knowledge");
    const path = this.mirrorPath(asset.id);
    if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
      mkdirSync(root, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, text, { mode: 0o640 });
      renameSync(temporary, path);
    }
    return path;
  }

  private indexKey(path: string): string {
    if (!existsSync(path)) return "";
    return path + ":" + createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  private ensureIndexed(path: string): Promise<boolean> {
    // Includes contents: edits to a memory at the same path need reindexing.
    const key = this.indexKey(path);
    if (!key) return Promise.resolve(false);
    if (this.indexed.get(path) === key) return Promise.resolve(true);
    const existing = this.indexing.get(key);
    if (existing) return existing;
    this.states.set(path, { key, state: "queued" });
    const job = this.indexQueue.then(() => {
      if (!existsSync(path)) return false;
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
