import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { durableWriteFileSync } from "./durableWrite.ts";
import { listBusinessModules } from "./businessModuleLibrary.ts";
import { resolveModuleKnowledgeLocation } from "./businessModuleKnowledge.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";
import type { KnowledgeDocument } from "./knowledgeDocuments.ts";
import type { FrozenGitKnowledgeDocumentResources, FrozenGitKnowledgeResources } from "./knowledgeRepositoryTypes.ts";
export type { FrozenGitKnowledgeDocumentResources, FrozenGitKnowledgeResources } from "./knowledgeRepositoryTypes.ts";

export interface KnowledgeRepositoryLocation { repository: string; branch: string; docs_path: string }
export interface ModuleKnowledgeSync {
  module_id: string;
  state: "syncing" | "ready" | "partial" | "failed";
  location: KnowledgeRepositoryLocation;
  attempted_at: string;
  synced_at?: string;
  commit?: string;
  document_count: number;
  error?: string;
  warnings?: string[];
  repositories?: Array<{ repository: string; branch: string; revision: string; synced_at?: string; scope?: "module" | "repository" }>;
}
export interface GitKnowledgeSnapshot {
  module_id: string;
  location: KnowledgeRepositoryLocation;
  synced_at: string;
  documents: KnowledgeDocument[];
  /** 只保存文稿实际引用的资源；共享图片按摘要只存一份。 */
  resources: Record<string, { digest: string; content_type: string }>;
  repositories: NonNullable<ModuleKnowledgeSync["repositories"]>;
}
export const gitKnowledgeRoot = (dataDir: string) => join(dataDir, "knowledge-git");
const moduleKey = (id: string) => createHash("sha256").update(id).digest("hex");
const snapshotPath = (dataDir: string, moduleId: string) => join(gitKnowledgeRoot(dataDir), "modules", `${moduleKey(moduleId)}.json`);
const statusPath = (dataDir: string, moduleId: string) => join(gitKnowledgeRoot(dataDir), "status", `${moduleKey(moduleId)}.json`);
const snapshotCache = new Map<string, { signature: string; bytes: number; value: GitKnowledgeSnapshot }>();
const corruptFiles = new Set<string>();
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const text = (value: unknown): value is string => typeof value === "string";
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const validLocation = (value: unknown): value is KnowledgeRepositoryLocation => record(value)
  && [value.repository, value.branch, value.docs_path].every(text);
function validSnapshot(value: unknown, moduleId: string): value is GitKnowledgeSnapshot {
  return record(value) && value.module_id === moduleId && validLocation(value.location) && text(value.synced_at)
    && Number.isFinite(Date.parse(value.synced_at)) && Array.isArray(value.documents) && value.documents.every(document => record(document)
      && /^kg-[a-f0-9]{64}$/.test(document.id) && [document.title, document.content, document.revision, document.when_to_use].every(text)
      && ["module", "repository"].includes(document.scope) && [document.module_ids, document.repositories, document.technologies, document.product_versions].every(strings)
      && typeof document.active === "boolean" && Array.isArray(document.history) && record(document.source)
      && [document.source.repository, document.source.branch, document.source.path, document.source.revision].every(text))
    && Array.isArray(value.repositories) && value.repositories.every(source => record(source) && [source.repository, source.branch, source.revision].every(text))
    && record(value.resources) && Object.entries(value.resources).every(([key, resource]) => {
      try { const parts = JSON.parse(key); return Array.isArray(parts) && parts.length === 4 && parts.every(text)
        && record(resource) && /^[a-f0-9]{64}$/.test(resource.digest) && text(resource.content_type); } catch { return false; }
    });
}
function preserveCorruptFile(path: string) {
  if (!corruptFiles.has(path) || !existsSync(path)) return;
  const backup = `${path}.corrupt-${randomUUID()}`;
  copyFileSync(path, backup); chmodSync(backup, 0o640);
  corruptFiles.delete(path);
}
function cachedSnapshot(path: string): GitKnowledgeSnapshot {
  const stat = statSync(path), signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = snapshotCache.get(path);
  snapshotCache.delete(path);
  if (cached?.signature === signature) { snapshotCache.set(path, cached); return cached.value; }
  const value = JSON.parse(readFileSync(path, "utf8")) as GitKnowledgeSnapshot;
  // 业务模块越多也不能把全部文稿长期留在进程内；超大快照按需读盘。
  if (stat.size <= MAX_CACHE_BYTES / 2) {
    snapshotCache.set(path, { signature, bytes: stat.size, value });
    let total = [...snapshotCache.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [key, entry] of snapshotCache) {
      if (total <= MAX_CACHE_BYTES) break;
      snapshotCache.delete(key); total -= entry.bytes;
    }
  }
  return value;
}
const runningSyncs = new Set<string>();
export function setModuleKnowledgeSyncActive(dataDir: string, moduleId: string, active: boolean) {
  const key = JSON.stringify([dataDir, moduleId]);
  if (active) runningSyncs.add(key); else runningSyncs.delete(key);
}
export const gitKnowledgeResourceKey = (repository: string, branch: string, path: string, revision: string) => JSON.stringify([repositoryIdentity(repository), branch, revision, path]);

function sameLocation(a: KnowledgeRepositoryLocation, b: KnowledgeRepositoryLocation) {
  return repositoryIdentity(a.repository) === repositoryIdentity(b.repository) && a.branch === b.branch && a.docs_path === b.docs_path;
}
export function readModuleKnowledgeSync(dataDir: string, moduleId: string): ModuleKnowledgeSync | undefined {
  const binding = resolveModuleKnowledgeLocation(dataDir, moduleId);
  if (!binding) return undefined;
  const path = statusPath(dataDir, moduleId);
  if (!existsSync(path)) return undefined;
  let value: ModuleKnowledgeSync;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
    if (!record(value) || value.module_id !== moduleId || !validLocation(value.location) || !["syncing", "ready", "partial", "failed"].includes(value.state)
      || !text(value.attempted_at) || !Number.isFinite(Date.parse(value.attempted_at)) || !Number.isSafeInteger(value.document_count) || value.document_count < 0
      || value.repositories !== undefined && (!Array.isArray(value.repositories) || !value.repositories.every(source => record(source)
        && [source.repository, source.branch, source.revision].every(text)))) throw new Error("同步记录格式不正确");
    corruptFiles.delete(path);
  } catch {
    corruptFiles.add(path);
    const snapshot = readGitKnowledgeSnapshot(dataDir, moduleId);
    return { module_id: moduleId, state: "failed", location: binding, attempted_at: statSync(path).mtime.toISOString(),
      document_count: snapshot?.documents.length ?? 0, ...(snapshot ? { synced_at: snapshot.synced_at, repositories: snapshot.repositories,
        commit: snapshot.repositories.find(source => source.repository === binding.repository && source.branch === binding.branch)?.revision } : {}),
      error: "本地同步记录损坏，原文件将保留备份；重新同步可从正式 Git 重建" };
  }
  if (!sameLocation(value.location, binding)) return undefined;
  if (value.synced_at && value.state !== "syncing" && !readGitKnowledgeSnapshot(dataDir, moduleId)) {
    return { ...value, state: "failed", error: "本地正式知识快照缺失或损坏，原文件将保留备份；重新同步可从正式 Git 重建" };
  }
  return value.state === "syncing" && !runningSyncs.has(JSON.stringify([dataDir, moduleId]))
    ? { ...value, state: "failed", error: "上次知识同步已中断，保留上次成功内容，可重新同步" } : value;
}
export function writeModuleKnowledgeSync(dataDir: string, status: ModuleKnowledgeSync) {
  mkdirSync(join(gitKnowledgeRoot(dataDir), "status"), { recursive: true });
  preserveCorruptFile(statusPath(dataDir, status.module_id));
  durableWriteFileSync(statusPath(dataDir, status.module_id), JSON.stringify(status), { mode: 0o640 });
}
export function writeGitKnowledgeSnapshot(dataDir: string, snapshot: GitKnowledgeSnapshot) {
  mkdirSync(join(gitKnowledgeRoot(dataDir), "modules"), { recursive: true });
  preserveCorruptFile(snapshotPath(dataDir, snapshot.module_id));
  durableWriteFileSync(snapshotPath(dataDir, snapshot.module_id), JSON.stringify(snapshot), { mode: 0o640 });
}
export function readGitKnowledgeSnapshot(dataDir: string, moduleId: string): GitKnowledgeSnapshot | undefined {
  const path = snapshotPath(dataDir, moduleId);
  if (!existsSync(path)) return undefined;
  let snapshot: GitKnowledgeSnapshot;
  try {
    snapshot = cachedSnapshot(path);
    if (!validSnapshot(snapshot, moduleId)) throw new Error("正式快照格式不正确");
    corruptFiles.delete(path);
  } catch { corruptFiles.add(path); return undefined; }
  const binding = resolveModuleKnowledgeLocation(dataDir, moduleId);
  if (!binding || !sameLocation(snapshot.location, binding)) return undefined;
  return snapshot;
}
function liveSnapshots(dataDir: string): GitKnowledgeSnapshot[] {
  const snapshots: GitKnowledgeSnapshot[] = [];
  for (const module of listBusinessModules(dataDir).modules.filter(module => module.status === "active")) {
    try {
      const snapshot = readGitKnowledgeSnapshot(dataDir, module.id);
      const repositories = new Set(module.repositories.map(repositoryIdentity));
      if (snapshot) snapshots.push({ ...snapshot, documents: snapshot.documents.filter(document => document.scope !== "repository"
        || document.repositories.some(repository => repositories.has(repositoryIdentity(repository)))) });
    }
    catch { /* 单模块坏记录不影响其余模块；同步状态入口负责报告和重试。 */ }
  }
  return snapshots.sort((a, b) => b.synced_at.localeCompare(a.synced_at));
}
export function listGitKnowledgeDocuments(dataDir: string): KnowledgeDocument[] {
  const documents = new Map<string, KnowledgeDocument>();
  const snapshots = liveSnapshots(dataDir);
  const latestSources = new Map<string, { revision: string; at: string }>();
  for (const snapshot of snapshots) for (const repository of snapshot.repositories) {
    if (repository.scope === "module") continue;
    const key = JSON.stringify([repositoryIdentity(repository.repository), repository.branch]);
    const at = repository.synced_at ?? snapshot.synced_at, previous = latestSources.get(key);
    if (!previous || at > previous.at) latestSources.set(key, { revision: repository.revision, at });
  }
  for (const snapshot of snapshots) for (const document of snapshot.documents) {
    if (document.scope === "repository" && document.source) {
      const latest = latestSources.get(JSON.stringify([repositoryIdentity(document.source.repository), document.source.branch]));
      // 同一公共仓只展示最新成功提交，其他模块的旧快照不能复活已删除文件。
      if (latest && latest.revision !== document.source.revision) continue;
    }
    const previous = documents.get(document.id);
    if (!previous) documents.set(document.id, { ...document, module_ids: [...document.module_ids], repositories: [...document.repositories], source: document.source ? { ...document.source } : undefined });
    else if (document.scope === "module") previous.module_ids = [...new Set([...previous.module_ids, ...document.module_ids])];
  }
  return [...documents.values()];
}
export function readGitKnowledgeDocument(dataDir: string, id: string): KnowledgeDocument {
  if (!/^kg-[a-f0-9]{64}$/.test(id)) throw new Error("仓库知识文档编号无效");
  const document = listGitKnowledgeDocuments(dataDir).find(document => document.id === id);
  if (!document) throw new Error("仓库知识不存在或已从正式分支删除");
  return document;
}
/** 旧业务正文保留在原记录中；正式消费只使用 Git，不因模块尚未配置而退回本地。 */
export function withoutBoundModuleDrafts(_dataDir: string, documents: KnowledgeDocument[]): KnowledgeDocument[] {
  return documents.filter(document => document.scope !== "module" && !document.module_ids.length
    && !(document.research_source?.job_id && (document.research_source.job_id.startsWith("dkx-")
      || ["domain", "repository"].includes(document.research_source.layer ?? ""))));
}
function gitResourcePath(sourcePath: string, href: string): string | undefined {
  if (!href || href.length > 2048 || /^[a-z][a-z\d+.-]*:|^\/\/|^\//i.test(href) || /[\0\\]/.test(href)) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(href.split(/[?#]/)[0]); } catch { return undefined; }
  if (!decoded || /[\0\\]/.test(decoded) || decoded.startsWith("/")) return undefined;
  const path = posix.normalize(posix.join(posix.dirname(sourcePath), decoded));
  return path === ".." || path.startsWith("../") ? undefined : path;
}
/** 同步与冻结使用同一套相对链接解析，正文未引用的其他图片不进入该篇任务快照。 */
export function referencedGitResourcePaths(content: string, sourcePath: string): string[] {
  const paths = new Set<string>();
  for (const match of content.matchAll(/!?\[[^\]\n]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) {
    const path = gitResourcePath(sourcePath, match[1]);
    if (path) paths.add(path);
  }
  return [...paths];
}
function readResource(dataDir: string, resource: { digest: string; content_type: string } | undefined): { content: Buffer; content_type: string } | undefined {
  if (!resource || !/^[a-f0-9]{64}$/.test(resource.digest) || !/^[\w.+-]+\/[\w.+-]+(?:;\s*charset=[\w-]+)?$/i.test(resource.content_type)) return undefined;
  return { content: Buffer.from(readFileSync(join(gitKnowledgeRoot(dataDir), "resources", `${resource.digest}.b64`), "utf8"), "base64"), content_type: resource.content_type };
}
/** 检视任务只保存原图摘要与来源位置；二进制文件按摘要共享，不随正式快照切换而改变。 */
export function freezeGitKnowledgeResources(dataDir: string, documents: Array<Pick<KnowledgeDocument, "id" | "source">>): FrozenGitKnowledgeResources {
  const frozen: FrozenGitKnowledgeResources = {}, originals = new Map<string, KnowledgeDocument>();
  const resourcesByLocation = new Map<string, { digest: string; content_type: string }>();
  const documentKey = (id: string, source: NonNullable<KnowledgeDocument["source"]>) => JSON.stringify([id, repositoryIdentity(source.repository), source.branch, source.path, source.revision]);
  for (const snapshot of liveSnapshots(dataDir)) {
    for (const document of snapshot.documents) if (document.source) originals.set(documentKey(document.id, document.source), document);
    for (const [key, resource] of Object.entries(snapshot.resources)) resourcesByLocation.set(key, resource);
  }
  for (const document of documents) {
    if (!document.source || !document.id.startsWith("kg-")) continue;
    const source = document.source;
    const original = originals.get(documentKey(document.id, source));
    if (!original) throw new Error("正式文档版本已变化，请刷新文稿后开始检视，未混用新版本图片");
    const resources: FrozenGitKnowledgeDocumentResources["resources"] = {};
    for (const path of referencedGitResourcePaths(original.content, source.path)) {
      const resource = resourcesByLocation.get(gitKnowledgeResourceKey(source.repository, source.branch, path, source.revision));
      if (resource) resources[path] = { ...resource };
    }
    frozen[document.id] = { source: { ...source }, resources };
  }
  return frozen;
}
export function readFrozenGitKnowledgeResource(dataDir: string, refs: FrozenGitKnowledgeDocumentResources | undefined, href: string): { content: Buffer; content_type: string } | undefined {
  if (!refs?.source?.path || !record(refs.resources)) return undefined;
  const path = gitResourcePath(refs.source.path, href);
  return path ? readResource(dataDir, refs.resources[path]) : undefined;
}
export function readGitKnowledgeResource(dataDir: string, id: string, href: string): { content: Buffer; content_type: string } | undefined {
  if (!/^kg-[a-f0-9]{64}$/.test(id)) return undefined;
  let current: KnowledgeDocument;
  try { current = readGitKnowledgeDocument(dataDir, id); } catch { return undefined; }
  for (const snapshot of liveSnapshots(dataDir)) {
    const document = snapshot.documents.find(document => document.id === id);
    if (!document?.source || document.source.revision !== current.source?.revision) continue;
    const path = gitResourcePath(document.source.path, href);
    if (!path) return undefined;
    const resource = snapshot.resources[gitKnowledgeResourceKey(document.source.repository, document.source.branch, path, document.source.revision)];
    if (resource) return readResource(dataDir, resource);
  }
  return undefined;
}
