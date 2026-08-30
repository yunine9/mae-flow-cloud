/**
 * 业务模块与模块知识资产库。
 *
 * 模块是显式发布的团队实体，不从仓库目录或任务读过的文档推断。正文
 * 按版本保存；更新只切换当前元数据，历史任务自己的快照不受影响。
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  repositoryIdentity,
  type KnowledgeForm,
} from "./knowledgeAssetModel.ts";

const ROOT = "business-modules";
const OPERATIONS = "business-module-operations.jsonl";
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const USERNAME = /^[A-Za-z0-9._-]{2,48}$/;
const MAX_ASSET_BYTES = 256 * 1024;
const MAX_ASSETS = 60;
const MAX_REPOSITORIES = 20;

export class BusinessModuleError extends Error {}

export type BusinessModuleStatus = "active" | "archived";
export type BusinessKnowledgeAssetStatus = "published" | "archived";

export interface BusinessKnowledgeAsset {
  id: string;
  title: string;
  summary: string;
  when_to_use: string;
  /** 业务是性质；这里仅记录呈现形态。 */
  form: KnowledgeForm;
  /** 空数组表示适用于模块关联的全部仓库。 */
  repositories: string[];
  status: BusinessKnowledgeAssetStatus;
  version: number;
  digest: string;
  bytes: number;
  updated_at: string;
  updated_by: string;
}

export interface BusinessModule {
  id: string;
  name: string;
  description: string;
  owner: string;
  maintainers: string[];
  repositories: string[];
  status: BusinessModuleStatus;
  revision: number;
  assets: BusinessKnowledgeAsset[];
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface BusinessKnowledgeAssetDocument {
  module_id: string;
  module_name: string;
  asset: BusinessKnowledgeAsset;
  content: string;
}

export interface BusinessModuleOperation {
  at: string;
  operator: string;
  action: "create" | "update" | "archive" | "publish_asset"
    | "archive_asset";
  module_id: string;
  asset_id?: string;
  version?: number;
  detail?: string;
}

export interface BusinessModuleCatalog {
  modules: BusinessModule[];
  warnings: string[];
  operations: BusinessModuleOperation[];
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertId(value: string, label: string): string {
  const id = value.trim();
  if (!ID.test(id)) {
    throw new BusinessModuleError(
      `${label}只能使用字母、数字、点、下划线或短横线，最长 64 字符`,
    );
  }
  return id;
}

function required(value: string, label: string, max: number): string {
  const result = value.trim();
  if (!result) throw new BusinessModuleError(`${label}不能为空`);
  if (result.length > max) {
    throw new BusinessModuleError(`${label}不能超过 ${max} 个字符`);
  }
  return result;
}

function usernames(values: string[], owner?: string): string[] {
  const unique = [...new Set(values.map((item) => item.trim()).filter(Boolean))];
  for (const value of unique) {
    if (!USERNAME.test(value)) {
      throw new BusinessModuleError(`账号 ${value} 格式不合法`);
    }
  }
  return unique.filter((value) => value !== owner).sort();
}

function repositories(values: string[]): string[] {
  const unique = [...new Set(values.map((item) => item.trim()).filter(Boolean))];
  if (unique.length > MAX_REPOSITORIES) {
    throw new BusinessModuleError(`每个模块最多关联 ${MAX_REPOSITORIES} 个仓库`);
  }
  for (const value of unique) {
    if (value.length > 512 || /[\0\r\n]/.test(value)) {
      throw new BusinessModuleError("仓库地址不合法");
    }
  }
  return unique;
}

/** 模块是仓在登记侧的唯一来源，零仓模块没有存在价值；资产的作用域仓
 * 允许为空（表示适用全部关联仓），所以下限不放进 repositories()，
 * 只把守模块自身的保存。 */
function moduleRepositories(values: string[]): string[] {
  const unique = repositories(values);
  if (!unique.length) {
    throw new BusinessModuleError("业务模块必须至少绑定一个代码仓");
  }
  return unique;
}

function root(dataDir: string): string {
  return join(dataDir, ROOT);
}

function moduleRoot(dataDir: string, id: string): string {
  return join(root(dataDir), id);
}

function moduleFile(dataDir: string, id: string): string {
  return join(moduleRoot(dataDir, id), "module.json");
}

function assertOrdinaryDirectory(path: string): void {
  if (existsSync(path) && (lstatSync(path).isSymbolicLink()
      || !lstatSync(path).isDirectory())) {
    throw new BusinessModuleError(`模块存储路径不是普通目录：${path}`);
  }
}

function parseModule(value: unknown): BusinessModule {
  const module = value as BusinessModule;
  if (!module || !ID.test(String(module.id ?? ""))
      || !module.name || !USERNAME.test(String(module.owner ?? ""))
      || !Array.isArray(module.assets) || !Array.isArray(module.maintainers)
      || !Array.isArray(module.repositories)
      || !["active", "archived"].includes(module.status)) {
    throw new BusinessModuleError("业务模块元数据损坏");
  }
  return {
    ...module,
    assets: module.assets.map((asset) => ({
      ...asset,
      // 兼容历史资产：旧 languages 不再参与业务知识归属或匹配。
      form: ["document", "skill", "rule", "example"].includes(
        String((asset as BusinessKnowledgeAsset).form ?? ""))
        ? (asset as BusinessKnowledgeAsset).form : "document",
      repositories: Array.isArray((asset as BusinessKnowledgeAsset).repositories)
        ? repositories((asset as BusinessKnowledgeAsset).repositories) : [],
    })),
  };
}

function writeModule(dataDir: string, module: BusinessModule): void {
  const home = moduleRoot(dataDir, module.id);
  assertOrdinaryDirectory(root(dataDir));
  assertOrdinaryDirectory(home);
  mkdirSync(home, { recursive: true, mode: 0o750 });
  const file = moduleFile(dataDir, module.id);
  const temporary = `${file}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(module, null, 2)}\n`, {
      encoding: "utf-8", mode: 0o640,
    });
    chmodSync(temporary, 0o640);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function operation(dataDir: string, value: BusinessModuleOperation): void {
  mkdirSync(root(dataDir), { recursive: true, mode: 0o750 });
  const file = join(root(dataDir), OPERATIONS);
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
    throw new BusinessModuleError("业务模块操作留痕不能是软链接");
  }
  appendFileSync(file,
    `${JSON.stringify(value)}\n`, { encoding: "utf-8", mode: 0o640 });
}

function operations(dataDir: string): BusinessModuleOperation[] {
  const file = join(root(dataDir), OPERATIONS);
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()) return [];
  try {
    return readFileSync(file, "utf-8").split("\n").filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as BusinessModuleOperation;
          return value?.module_id && value?.action ? [value] : [];
        } catch { return []; }
      }).sort((left, right) => right.at.localeCompare(left.at));
  } catch { return []; }
}

export function readBusinessModule(dataDir: string, value: string): BusinessModule {
  const id = assertId(value, "模块 ID");
  const home = moduleRoot(dataDir, id);
  const file = moduleFile(dataDir, id);
  assertOrdinaryDirectory(root(dataDir));
  assertOrdinaryDirectory(home);
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()
      || !lstatSync(file).isFile()) {
    throw new BusinessModuleError(`没有业务模块 ${id}`);
  }
  try {
    return parseModule(JSON.parse(readFileSync(file, "utf-8")));
  } catch (error) {
    if (error instanceof BusinessModuleError) throw error;
    throw new BusinessModuleError(`业务模块 ${id} 元数据损坏`);
  }
}

export function listBusinessModules(dataDir: string): BusinessModuleCatalog {
  const home = root(dataDir);
  if (!existsSync(home)) return { modules: [], warnings: [], operations: [] };
  assertOrdinaryDirectory(home);
  const modules: BusinessModule[] = [];
  const warnings: string[] = [];
  for (const entry of readdirSync(home, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !ID.test(entry.name)) {
      continue;
    }
    try {
      modules.push(readBusinessModule(dataDir, entry.name));
    } catch (error) {
      warnings.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  modules.sort((left, right) => left.name.localeCompare(right.name));
  return { modules, warnings, operations: operations(dataDir) };
}

export function canManageBusinessModule(
  module: BusinessModule,
  username: string | undefined,
  admin = false,
): boolean {
  return admin || !!username
    && (module.owner === username || module.maintainers.includes(username));
}

export function createBusinessModule(
  dataDir: string,
  input: {
    id: string;
    name: string;
    description: string;
    owner: string;
    maintainers?: string[];
    repositories?: string[];
  },
  operator: string,
): BusinessModule {
  const id = assertId(input.id, "模块 ID");
  if (existsSync(moduleFile(dataDir, id))) {
    throw new BusinessModuleError(`业务模块 ${id} 已存在`);
  }
  const owner = required(input.owner, "Owner", 48);
  if (!USERNAME.test(owner)) throw new BusinessModuleError("Owner 账号格式不合法");
  const now = new Date().toISOString();
  const module: BusinessModule = {
    id,
    name: required(input.name, "模块名称", 80),
    description: required(input.description, "模块说明", 500),
    owner,
    maintainers: usernames(input.maintainers ?? [], owner),
    repositories: moduleRepositories(input.repositories ?? []),
    status: "active",
    revision: 1,
    assets: [],
    created_at: now,
    created_by: operator,
    updated_at: now,
    updated_by: operator,
  };
  writeModule(dataDir, module);
  operation(dataDir, { at: now, operator, action: "create", module_id: id });
  return module;
}

export function updateBusinessModule(
  dataDir: string,
  id: string,
  patch: {
    name?: string;
    description?: string;
    owner?: string;
    maintainers?: string[];
    repositories?: string[];
    status?: BusinessModuleStatus;
  },
  operator: string,
  allowOwnerChange = false,
  allowStatusChange = allowOwnerChange,
): BusinessModule {
  const current = readBusinessModule(dataDir, id);
  if (patch.owner !== undefined && patch.owner.trim() !== current.owner
      && !allowOwnerChange) {
    throw new BusinessModuleError("只有管理员可以转移模块 Owner");
  }
  const owner = patch.owner === undefined ? current.owner
    : required(patch.owner, "Owner", 48);
  if (!USERNAME.test(owner)) throw new BusinessModuleError("Owner 账号格式不合法");
  const status = patch.status ?? current.status;
  if (!["active", "archived"].includes(status)) {
    throw new BusinessModuleError("模块状态只能是 active 或 archived");
  }
  if (status !== current.status && !allowStatusChange) {
    throw new BusinessModuleError("只有管理员可以归档或重新启用业务模块");
  }
  const now = new Date().toISOString();
  const updated: BusinessModule = {
    ...current,
    name: patch.name === undefined ? current.name
      : required(patch.name, "模块名称", 80),
    description: patch.description === undefined ? current.description
      : required(patch.description, "模块说明", 500),
    owner,
    maintainers: patch.maintainers === undefined
      ? current.maintainers.filter((item) => item !== owner)
      : usernames(patch.maintainers, owner),
    repositories: patch.repositories === undefined
      ? current.repositories : moduleRepositories(patch.repositories),
    status,
    revision: current.revision + 1,
    updated_at: now,
    updated_by: operator,
  };
  writeModule(dataDir, updated);
  operation(dataDir, {
    at: now, operator,
    action: status === "archived" && current.status !== "archived"
      ? "archive" : "update",
    module_id: current.id,
  });
  return updated;
}

function assetVersionFile(
  dataDir: string,
  moduleId: string,
  assetId: string,
  version: number,
): string {
  return join(moduleRoot(dataDir, moduleId), "assets", assetId,
    `v${version}.md`);
}

function assetVersionManifestFile(
  dataDir: string,
  moduleId: string,
  assetId: string,
  version: number,
): string {
  return join(moduleRoot(dataDir, moduleId), "assets", assetId,
    `v${version}.json`);
}

/**
 * 每个发布版本都保存当时的治理元数据和正文指纹。只有 Markdown 文件
 * 无法证明历史 vN 仍是发布时那一版，也会错误套用当前标题/作用域。
 */
function readAssetVersionManifest(
  dataDir: string,
  moduleId: string,
  assetId: string,
  version: number,
): BusinessKnowledgeAsset | undefined {
  const file = assetVersionManifestFile(
    dataDir, moduleId, assetId, version);
  if (!existsSync(file)) return undefined;
  if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) {
    throw new BusinessModuleError("知识版本发布清单不是普通文件");
  }
  try {
    const asset = JSON.parse(readFileSync(file, "utf-8")) as
      BusinessKnowledgeAsset;
    if (!asset || asset.id !== assetId || asset.version !== version
        || !asset.title || !asset.summary || !asset.when_to_use
        || !["document", "skill", "rule", "example"].includes(asset.form)
        || !Array.isArray(asset.repositories)
        || !["published", "archived"].includes(asset.status)
        || !/^[a-f0-9]{64}$/.test(String(asset.digest ?? ""))
        || !Number.isInteger(asset.bytes) || asset.bytes < 0
        || asset.bytes > MAX_ASSET_BYTES
        || !asset.updated_at || !asset.updated_by) {
      throw new Error("invalid manifest");
    }
    return { ...asset, repositories: repositories(asset.repositories) };
  } catch (error) {
    if (error instanceof BusinessModuleError) throw error;
    throw new BusinessModuleError("知识版本发布清单损坏");
  }
}

export function publishBusinessKnowledgeAsset(
  dataDir: string,
  moduleId: string,
  input: {
    id: string;
    title: string;
    summary: string;
    when_to_use: string;
    form?: KnowledgeForm;
    repositories?: string[];
    content: string;
  },
  operator: string,
): BusinessModule {
  const module = readBusinessModule(dataDir, moduleId);
  if (module.status !== "active") {
    throw new BusinessModuleError("已归档模块不能发布知识");
  }
  const assetId = assertId(input.id, "资产 ID");
  const content = input.content.replace(/\r\n/g, "\n");
  if (!content.trim()) throw new BusinessModuleError("知识正文不能为空");
  if (content.includes("\0")) throw new BusinessModuleError("知识正文包含二进制内容");
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_ASSET_BYTES) {
    throw new BusinessModuleError("单项知识正文不能超过 256 KiB");
  }
  const previous = module.assets.find((item) => item.id === assetId);
  if (!previous && module.assets.length >= MAX_ASSETS) {
    throw new BusinessModuleError(`每个模块最多发布 ${MAX_ASSETS} 项知识`);
  }
  const now = new Date().toISOString();
  const form = input.form ?? previous?.form ?? "document";
  if (!["document", "skill", "rule", "example"].includes(form)) {
    throw new BusinessModuleError("知识形态只能是文档、Skill、规则或示例");
  }
  const applicableRepositories = input.repositories === undefined
    ? previous?.repositories ?? [] : repositories(input.repositories);
  const moduleRepositories = new Set(module.repositories.map(repositoryIdentity));
  for (const repository of applicableRepositories) {
    if (!moduleRepositories.has(repositoryIdentity(repository))) {
      throw new BusinessModuleError(
        `适用仓库 ${repository} 未关联到业务模块 ${module.name}`);
    }
  }
  const asset: BusinessKnowledgeAsset = {
    id: assetId,
    title: required(input.title, "资产标题", 120),
    summary: required(input.summary, "资产摘要", 500),
    when_to_use: required(input.when_to_use, "适用场景", 500),
    form,
    repositories: applicableRepositories,
    status: "published",
    version: (previous?.version ?? 0) + 1,
    digest: digest(content),
    bytes,
    updated_at: now,
    updated_by: operator,
  };
  const file = assetVersionFile(dataDir, module.id, asset.id, asset.version);
  const manifest = assetVersionManifestFile(
    dataDir, module.id, asset.id, asset.version);
  const home = join(moduleRoot(dataDir, module.id), "assets", asset.id);
  assertOrdinaryDirectory(join(moduleRoot(dataDir, module.id), "assets"));
  assertOrdinaryDirectory(home);
  mkdirSync(home, { recursive: true, mode: 0o750 });
  if (existsSync(file) || existsSync(manifest)) {
    throw new BusinessModuleError("知识版本文件已存在，拒绝覆盖历史版本");
  }
  try {
    writeFileSync(file, content,
      { encoding: "utf-8", mode: 0o640, flag: "wx" });
    chmodSync(file, 0o640);
    writeFileSync(manifest, `${JSON.stringify(asset, null, 2)}\n`,
      { encoding: "utf-8", mode: 0o640, flag: "wx" });
    chmodSync(manifest, 0o640);
  } catch (error) {
    rmSync(file, { force: true });
    rmSync(manifest, { force: true });
    throw error;
  }
  const updated: BusinessModule = {
    ...module,
    revision: module.revision + 1,
    assets: [...module.assets.filter((item) => item.id !== asset.id), asset]
      .sort((left, right) => left.title.localeCompare(right.title)),
    updated_at: now,
    updated_by: operator,
  };
  try {
    writeModule(dataDir, updated);
  } catch (error) {
    rmSync(file, { force: true });
    rmSync(manifest, { force: true });
    throw error;
  }
  operation(dataDir, {
    at: now, operator, action: "publish_asset", module_id: module.id,
    asset_id: asset.id, version: asset.version,
  });
  return updated;
}

export function readBusinessKnowledgeAsset(
  dataDir: string,
  moduleId: string,
  assetIdValue: string,
  version?: number,
): BusinessKnowledgeAssetDocument {
  const module = readBusinessModule(dataDir, moduleId);
  const assetId = assertId(assetIdValue, "资产 ID");
  const current = module.assets.find((item) => item.id === assetId);
  if (!current) throw new BusinessModuleError(`模块 ${module.id} 没有知识 ${assetId}`);
  const wanted = version ?? current.version;
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > current.version) {
    throw new BusinessModuleError("知识版本不存在");
  }
  const file = assetVersionFile(dataDir, module.id, assetId, wanted);
  assertOrdinaryDirectory(join(moduleRoot(dataDir, module.id), "assets"));
  assertOrdinaryDirectory(join(
    moduleRoot(dataDir, module.id), "assets", assetId));
  if (!existsSync(file) || lstatSync(file).isSymbolicLink()
      || !lstatSync(file).isFile()) {
    throw new BusinessModuleError("知识正文版本不存在或不是普通文件");
  }
  const content = readFileSync(file, "utf-8");
  const contentDigest = digest(content);
  const manifest = readAssetVersionManifest(
    dataDir, module.id, assetId, wanted);
  // 升级前的当前版本仍可由 module.json 中既有发布指纹核对；历史版本
  // 没有同等证据时必须诚实拒绝，不能现场重算后冒充原发布身份。
  if (!manifest && wanted !== current.version) {
    throw new BusinessModuleError(
      "知识历史版本缺少发布清单，无法核对发布指纹");
  }
  const published = manifest ?? current;
  if (contentDigest !== published.digest
      || Buffer.byteLength(content, "utf-8") !== published.bytes) {
    throw new BusinessModuleError("知识正文与发布指纹不一致");
  }
  if (manifest && wanted === current.version
      && JSON.stringify({
        id: current.id, title: current.title, summary: current.summary,
        when_to_use: current.when_to_use, form: current.form,
        repositories: current.repositories, version: current.version,
        digest: current.digest, bytes: current.bytes,
      }) !== JSON.stringify({
        id: manifest.id, title: manifest.title, summary: manifest.summary,
        when_to_use: manifest.when_to_use, form: manifest.form,
        repositories: manifest.repositories, version: manifest.version,
        digest: manifest.digest, bytes: manifest.bytes,
      })) {
    throw new BusinessModuleError("知识元数据与版本发布清单不一致");
  }
  const asset = wanted === current.version
    ? { ...published, status: current.status }
    : published;
  return { module_id: module.id, module_name: module.name, asset, content };
}

export function archiveBusinessKnowledgeAsset(
  dataDir: string,
  moduleId: string,
  assetIdValue: string,
  operator: string,
): BusinessModule {
  const module = readBusinessModule(dataDir, moduleId);
  const assetId = assertId(assetIdValue, "资产 ID");
  const current = module.assets.find((item) => item.id === assetId);
  if (!current) throw new BusinessModuleError(`模块 ${module.id} 没有知识 ${assetId}`);
  if (current.status === "archived") return module;
  const now = new Date().toISOString();
  const updated: BusinessModule = {
    ...module,
    revision: module.revision + 1,
    assets: module.assets.map((item) => item.id === assetId
      ? { ...item, status: "archived" as const, updated_at: now,
          updated_by: operator }
      : item),
    updated_at: now,
    updated_by: operator,
  };
  writeModule(dataDir, updated);
  operation(dataDir, {
    at: now, operator, action: "archive_asset", module_id: module.id,
    asset_id: assetId, version: current.version,
  });
  return updated;
}
