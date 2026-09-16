/** Unified read-only retrieval over published assets and adopted experiences.
 * Source catalogs remain authoritative; mirrors are disposable search input.
 * No workflow gates, inferred approvals, or edits to the original knowledge.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { listBusinessModules, readBusinessKnowledgeAsset } from "./businessModuleLibrary.ts";
import { listKnowledgeCandidateCatalog } from "./knowledgeCandidates.ts";
import { listHostSkillShelf } from "./hostSkillShelf.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";
import { MemoryStore, memoryAccessible } from "./taskMemory.ts";
import { MemorySidecar } from "./memorySidecar.ts";

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

export function collectSearchableKnowledge(dataDir: string, context: KnowledgeContext): {
  assets: SearchableKnowledge[]; warnings: string[];
} {
  const assets: SearchableKnowledge[] = [];
  const warnings: string[] = [];
  const repos = new Set(context.repositories.map(repositoryIdentity));
  const matchesRepos = (values: string[]) => !values.length || values.some(r => repos.has(repositoryIdentity(r)));
  const catalog = listBusinessModules(dataDir);
  warnings.push(...catalog.warnings);
  // Module relationships can be discovered from current repository mapping even
  // if the task did not know the module at creation time.
  const modules = catalog.modules.filter(m => m.status === "active"
    && (context.moduleIds.includes(m.id) || m.repositories.some(r => repos.has(repositoryIdentity(r)))));
  const moduleIds = new Set(modules.map(m => m.id));
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
      content: row.content, revision: row.digest, productVersions: knowledgeProductVersions(row.content) });
  }
  // A skill candidate is a publication receipt, not the live package. Read the
  // current shelf so edits/removal cannot resurrect the old submitted contents.
  const shelf = listHostSkillShelf(dataDir);
  warnings.push(...shelf.warnings);
  for (const skill of shelf.skills) {
    if (!skill.loadable || skill.nature === "unclassified" || !matchesRepos(skill.repositories)
        || (skill.business_module_ids.length && !skill.business_module_ids.some(id => moduleIds.has(id)))) continue;
    try {
      const content = readFileSync(join(dataDir, "skills", skill.path), "utf8");
      assets.push({ id: `skill:${skill.path}`, title: skill.name, kind: "skill", scope: "团队 Skill",
        summary: skill.description, whenToUse: [skill.description, skill.technologies.length
          ? `适用技术：${skill.technologies.join("、")}` : ""].filter(Boolean).join("；"),
        content, revision: skill.package_digest, productVersions: knowledgeProductVersions(content) });
    } catch { warnings.push(`团队 Skill ${skill.name} 暂不可读`); }
  }
  for (const module of modules) for (const asset of module.assets) {
    if (asset.status !== "published" || !matchesRepos(asset.repositories)) continue;
    // Published business candidates are materialized in their module. Do not
    // offer a stale duplicate copy from the submission record.
    try {
      const doc = readBusinessKnowledgeAsset(dataDir, module.id, asset.id);
      assets.push({ id: `module:${module.id}:${asset.id}`, title: asset.title, kind: asset.form,
        scope: `业务模块：${module.name}`, summary: asset.summary, whenToUse: asset.when_to_use,
        content: doc.content, revision: String(asset.version), productVersions: knowledgeProductVersions(doc.content) });
    } catch (error) { warnings.push(`模块资料 ${module.name}/${asset.title} 暂不可读：${String(error)}`); }
  }
  const store = new MemoryStore(dataDir);
  for (const row of store.list()) {
    if (!memoryAccessible(row, context.repo)) continue;
    const content = store.read(row.id);
    if (!content) continue;
    assets.push({ id: row.id, title: row.trigger, kind: "experience",
      scope: row.scope === "platform" ? "平台通用经验" : `代码仓：${row.repo}`,
      summary: row.conclusion, whenToUse: row.trigger, content,
      revision: String(row.revision ?? 1), productVersions: knowledgeProductVersions(content),
      path: join(store.root, row.file) });
  }
  // Explicit product scope narrows the current task; missing metadata remains
  // visible as unconfirmed rather than being guessed from document revisions.
  return { assets: assets.filter(a => !context.productVersion || !a.productVersions.length
    || a.productVersions.includes(context.productVersion)), warnings };
}

export interface KnowledgeHit {
  id: string; title: string; kind: SearchableKnowledge["kind"]; scope: string;
  revision: string; productVersions: string[]; whenToUse: string;
  summary: string | undefined; versionNote: string;
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
  constructor(private dataDir: string, private sidecar?: MemorySidecar) {}

  catalog(context: KnowledgeContext) { return collectSearchableKnowledge(this.dataDir, context); }

  async search(context: KnowledgeContext, query: string, limit = 5): Promise<KnowledgeSearchResult> {
    if (!this.sidecar) return { available: false as const, hits: [], warnings: ["知识检索暂不可用；继续当前任务。"] };
    const catalog = this.catalog(context);
    const sources = catalog.assets.map(asset => ({ id: asset.id, path: this.mirror(asset) }));
    if (!sources.length) return { available: true, hits: [], warnings: catalog.warnings };
    // One shared in-flight index per document revision; no duplicate
    // index jobs on repeated questions. The caller has a bounded wait below.
    const jobs = sources.map(source => this.ensureIndexed(source.path));
    const ready = await within(Promise.all(jobs).then(values => values.every(Boolean)), 1200);
    if (!ready) return { available: false as const, hits: [], warnings: ["相关知识索引正在准备或暂不可用；继续当前任务，不等待或反复重试。"] };
    const hits = await within(this.sidecar.search({ query, repo: context.repo, limit, sources }), 1500);
    if (!hits) return { available: false as const, hits: [], warnings: ["知识检索暂不可用；继续当前任务。"] };
    // A document may have been edited/withdrawn during asynchronous indexing.
    const current = new Map(this.catalog(context).assets.map(asset => [asset.id, asset]));
    const searched = new Map(catalog.assets.map(asset => [asset.id, asset]));
    return { available: true as const, warnings: catalog.warnings, hits: hits.flatMap(hit => {
      const asset = current.get(hit.id), prior = searched.get(hit.id);
      if (!asset || !prior || asset.content !== prior.content || asset.revision !== prior.revision) return [];
      return [{ id: asset.id, title: asset.title, kind: asset.kind, scope: asset.scope,
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
    const text = `---\nknowledge_id: ${JSON.stringify(asset.id)}\nasset_status: published\n---\n`
      + `# ${asset.title}\n\n适用范围：${asset.scope}\n适用条件：${asset.whenToUse}\n${asset.summary}\n\n${asset.content}`;
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

  private ensureIndexed(path: string): Promise<boolean> {
    // Includes contents: edits to a memory at the same path need reindexing.
    const key = path + ":" + createHash("sha256").update(readFileSync(path)).digest("hex");
    if (this.indexed.get(path) === key) return Promise.resolve(true);
    const existing = this.indexing.get(key);
    if (existing) return existing;
    const job = this.indexQueue.then(() => this.sidecar!.ingest(path)).then(ok => { if (ok) this.indexed.set(path, key); return ok; })
      .catch(() => false).finally(() => this.indexing.delete(key));
    this.indexQueue = job;
    this.indexing.set(key, job);
    return job;
  }
}
