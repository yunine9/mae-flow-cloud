/**
 * 团队 Skill 资产库(可写管理面):货架的写半边。
 *
 * 货架(hostSkillShelf)回答"现在生效的是什么",这里回答"怎么换货":
 * 上传/更新/下线/回退都写进部署数据目录 skills/,快照器每任务从源目录
 * 重造,所以写进即对下一单生效——不用运维、不用重启,"内置 skill"由此
 * 消失。设计期钉死的三条纪律(docs/roadmap-references.md §8):
 *
 * - 写路径 fail-closed:装载器不认、含疑似密钥、越出边界的包一律拒收,
 *   一个字节都不落盘。只读货架可以展示历史坏件,管理面不能新造坏件。
 * - 权限显式归一(文件 0644/目录 0755),不依赖上传时的 umask——skill
 *   是公开指南谁都该读得到;正因为权限全开,内容里永远不许出现令牌,
 *   上传入口的掩码扫描就是这条的兜底。
 * - 版本痕留在 skill-versions/,每次覆盖/下线先归档,回退=把归档重新
 *   走一遍完整验收装回去;操作(谁/何时/什么动作/什么指纹)逐条追加
 *   进 skill-operations.jsonl,与批注同纪律:留痕才查得清。
 *
 * 并发口径:同进程内所有写操作串行(锁在模块级);任务快照器与写操作
 * 赛跑时靠它自己的 digest 复核兜底——换货瞬间开始的会话最多损失该
 * skill 一次装载(出警告、fail-open),绝不装到半新半旧的包。
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { packageDigest } from "./hostSkillRuntime.ts";
import { durableWriteFileSync } from "./durableWrite.ts";
import {
  normalizeKnowledgeAssetMetadata,
  readSkillKnowledgeMetadata,
  writeSkillKnowledgeMetadata,
  type KnowledgeAssetMetadata,
} from "./knowledgeAssetModel.ts";

/** 与快照器同预算:管理面收下的包必须是运行时装得动的包。 */
const MAX_SKILL_BYTES = 128 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 400;
const MAX_DEPTH = 8;
/** 版本痕不设上限会无限吃盘;超过后修剪最老的(操作留痕永不修剪)。 */
const MAX_VERSIONS_PER_SKILL = 20;
const APPROVAL_BUDGET_MS = 60_000;

const LIVE_DIR = "skills";
const VERSIONS_DIR = "skill-versions";
const STAGING_DIR = "skill-staging";
const SUBMISSIONS_DIR = "skill-submissions";
const OPERATIONS_LOG = "skill-operations.jsonl";
/** 与 /skills/:dir 子路由撞名的目录名不许当 skill 目录用。 */
const RESERVED_DIRECTORY_NAMES = new Set(["submissions"]);

/** 目录名保持 ASCII:它进 URL 路径、「UT生成方式」配置值和开场
 * prompt,放开 Unicode 的收益扛不住编码歧义的风险。 */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** 包内文件名放开到 Unicode 字母数字(实锤:references/
 * 0010_如何使用Kernel.md 被拒——中文团队的参考资料本来就叫中文名)。
 * 首字符必须是字母/数字:点开头(.env/.git)与 ".." 遍历依旧没门。 */
const PACKAGE_SEGMENT_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,79}$/u;

export class SkillLibraryError extends Error {}

export interface SkillUploadFile {
  /** 包内相对路径(POSIX 斜杠),如 "SKILL.md"、"templates/case.md"。 */
  path: string;
  content_base64: string;
}

export interface HostSkillDocument {
  directory: string;
  path: string;
  content: string;
  digest: string;
  /** 正文与附件组成的当前整包指纹；深链必须与正文一起对拍。 */
  package_digest: string;
  bytes: number;
}

export interface SkillVersionRecord {
  version_id: string;
  archived_at: string;
  /** 归档动作:update=被新版本顶替,offline=下线,rollback=被回退顶替。 */
  action: string;
  operator: string;
  skill_digest: string;
  package_digest: string;
  files: number;
  bytes: number;
}

export interface SkillOperationRecord {
  at: string;
  operator: string;
  action: "upload" | "update" | "offline" | "rollback"
    | "submit" | "approve" | "reject";
  directory: string;
  skill_digest?: string;
  package_digest?: string;
  files?: number;
  bytes?: number;
  detail?: string;
}

/** 开发者提交的待审包(2026-08-27 用户拍板:人人可提交,管理员审核
 * 上架)。提交时就走完整验收闸(路径/密钥/装载器),不合格的包连
 * 待审区都进不去;审核通过时再走一遍同一道闸(与回退同纪律:
 * "理论上验收过"不配跳过闸门)。 */
export interface SkillSubmissionRecord {
  id: string;
  directory: string;
  operator: string;
  created_at: string;
  status: "pending" | "approving" | "approved" | "rejected";
  skill_digest: string;
  package_digest: string;
  /** 提交时生效整包的版本；null 表示尚未上架，缺失不能证明审查基线。 */
  base_package_digest: string | null;
  files: number;
  bytes: number;
  nature: KnowledgeAssetMetadata["nature"];
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
  decided_at?: string;
  decided_by?: string;
  reject_reason?: string;
}

/** 仅识别已知头名的完整常量值，不凭连字符外形豁免密码或配置值。 */
function isHeaderNameConstant(match: RegExpMatchArray): boolean {
  const before = match.input!.slice(0, match.index);
  const name = (before.match(/[\p{L}\p{N}_$-]*$/u)?.[0] ?? "") + match[1];
  const headers: Record<string, string> = {
    X_ACCESS_TOKEN: "x-access-token", X_API_KEY: "x-api-key", API_KEY: "x-api-key",
  };
  if (!Object.hasOwn(headers, name) || headers[name] !== match[2].toLowerCase()) return false;
  const quote = match[0].match(/[:=]\s*(["'])[^"']*$/)?.[1];
  const after = match.input!.slice(match.index! + match[0].length);
  // 必须是完整字面量；后缀字符、拼接表达式、未加引号的配置值都不豁免。
  return !!quote && after[0] === quote
    && /^[ \t]*(?:$|\r?\n|[,;)}\]`]|\/\/|#|\/\*)/.test(after.slice(1));
}

/** 疑似密钥的形态清单。占位符和已识别的 HTTP 头名常量不作为凭据；
 * 跳过这些匹配后，仍继续检查同一文件中的其他内容。 */
const SECRET_PATTERNS: Array<{
  label: string; pattern: RegExp; skip?: (match: RegExpMatchArray) => boolean;
}> = [
  {
    label: "密钥赋值",
    pattern: /(api[_-]?key|secret|token|passwd|password|access[_-]?key)["']?\s*[:=]\s*["']?((?=[A-Za-z0-9_\-./+]*[A-Za-z])[A-Za-z0-9_\-./+]{8,})/i,
    skip: isHeaderNameConstant,
  },
  { label: "Bearer 凭据", pattern: /Bearer\s+(?=[A-Za-z0-9\-._~+/]*[A-Za-z])[A-Za-z0-9\-._~+/]{16,}/ },
  { label: "私钥块", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/** 这些文件名本身就是密钥容器,不看内容直接拒。 */
const FORBIDDEN_FILENAMES = /(?:^|\/)(?:\.env[^/]*|id_rsa[^/]*|id_ed25519[^/]*|[^/]*\.pem|[^/]*\.p12|[^/]*\.pfx|credentials(?:\.json)?)$/i;

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 掩码展示:••••+末4位,与令牌回显同纪律——报错信息也不许带明文。 */
function maskedExcerpt(match: string): string {
  return `••••${match.slice(-4)}`;
}

function assertDirectoryName(directory: string): void {
  if (!SEGMENT_PATTERN.test(directory) || directory.includes("..")) {
    throw new SkillLibraryError(
      `目录名不合法(字母数字开头,仅限字母数字与 . _ -): ${directory}`);
  }
  if (RESERVED_DIRECTORY_NAMES.has(directory)) {
    throw new SkillLibraryError(`目录名与接口保留字冲突: ${directory}`);
  }
}

/** 货架详情只开放当前生效包的根 SKILL.md。目录名先走与写入口相同的
 * 白名单，且 lstat 拒绝目录/文件软链接；浏览器永远拿不到数据目录的
 * 绝对路径，也不能借查看入口遍历宿主文件。 */
export function readHostSkillDocument(
  dataDir: string,
  directory: string,
): HostSkillDocument {
  assertDirectoryName(directory);
  const packageRoot = join(dataDir, LIVE_DIR, directory);
  const file = join(packageRoot, "SKILL.md");
  if (!existsSync(packageRoot) || !lstatSync(packageRoot).isDirectory()
      || !existsSync(file) || !lstatSync(file).isFile()) {
    throw new SkillLibraryError(`没有这个生效中的 skill: ${directory}`);
  }
  const raw = readFileSync(file);
  if (raw.byteLength > MAX_SKILL_BYTES) {
    throw new SkillLibraryError("SKILL.md 超过 128 KiB，拒绝展示");
  }
  let packageDigestValue: string;
  try {
    // 正文读取与整包计算都在同一个同步请求中完成；同进程的换包写操作
    // 无法插进两者之间，前端也不必拿先前的货架摘要冒充当前包身份。
    packageDigestValue = packageDigest(packageRoot);
  } catch (error) {
    throw new SkillLibraryError(`Skill 包无法完整核对：${
      error instanceof Error ? error.message : String(error)}`);
  }
  return {
    directory,
    path: `${directory}/SKILL.md`,
    content: raw.toString("utf-8"),
    digest: sha256(raw),
    package_digest: packageDigestValue,
    bytes: raw.byteLength,
  };
}

/** 只读当前包，所有路径仍按上传规则校验；不跟随软链接。 */
export function readHostSkillPackage(dataDir: string, directory: string) {
  const document = readHostSkillDocument(dataDir, directory);
  const files = readSkillPackageFiles(join(dataDir, LIVE_DIR, directory));
  return { ...document, files };
}

function readSkillPackageFiles(packageRoot: string) {
  if (!lstatSync(packageRoot).isDirectory()) throw new SkillLibraryError("Skill 包目录无效");
  const files: Array<{ path: string; bytes: number; content?: string }> = [];
  let total = 0;
  function visit(relative: string, depth: number) {
    if (depth > 16) throw new SkillLibraryError("Skill 目录层级过深");
    for (const entry of readdirSync(join(packageRoot, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      assertPackagePath(path);
      if (entry.isSymbolicLink()) throw new SkillLibraryError("Skill 包不能包含软链接");
      if (entry.isDirectory()) { visit(path, depth + 1); continue; }
      if (!entry.isFile()) throw new SkillLibraryError("Skill 包包含不支持的文件类型");
      if (files.length >= 500) throw new SkillLibraryError("Skill 包文件数量过多");
      const raw = readFileSync(join(packageRoot, path)); total += raw.byteLength;
      if (total > 20 * 1024 * 1024) throw new SkillLibraryError("Skill 包超过 20 MiB");
      let content: string | undefined;
      if (raw.byteLength <= 128 * 1024 && !raw.includes(0)) {
        try { content = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { /* 二进制附件保留文件信息。 */ }
      }
      files.push({ path, bytes: raw.byteLength, ...(content === undefined ? {} : { content }) });
    }
  }
  visit("", 0);
  files.sort((a,b) => a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path));
  return files;
}

export function readSkillSubmissionPackage(dataDir: string, directory: string, id: string) {
  assertDirectoryName(directory);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new SkillLibraryError("提交编号无效");
  const record = readSubmission(dataDir, directory, id);
  const root = join(submissionRoot(dataDir, directory), id, "package");
  const files = readSkillPackageFiles(root);
  if (packageDigest(root) !== record.package_digest) throw new SkillLibraryError("提交包已变化，请重新提交后审查");
  return { record, files };
}

function assertPackagePath(path: string): void {
  const segments = path.split("/");
  if (segments.length > MAX_DEPTH) {
    throw new SkillLibraryError(`包内路径超过 ${MAX_DEPTH} 层: ${path}`);
  }
  for (const segment of segments) {
    if (!PACKAGE_SEGMENT_PATTERN.test(segment)) {
      throw new SkillLibraryError(
        `包内路径段不合法(须以字母/数字开头,可含中文,`
        + `不收点开头与空格): ${path}`);
    }
  }
}

function looksTextual(content: Buffer): boolean {
  return !content.subarray(0, 8192).includes(0);
}

export function scanForSecrets(path: string, content: Buffer): void {
  if (FORBIDDEN_FILENAMES.test(path)) {
    throw new SkillLibraryError(
      `文件名即密钥容器,skill 是权限全开的公开指南,不能收: ${path}`);
  }
  if (!looksTextual(content)) return;
  const pending = [{ path, text: content.toString("utf-8") }];
  while (pending.length) {
    const item = pending.pop()!;
    scanSecretText(item.path, item.text);
    // 研究工具传入 JSON 文档。检查解码后的正文，不能让转义引号掩盖赋值。
    let value: unknown;
    try { value = JSON.parse(item.text); } catch { continue; }
    const fields: unknown[] = [value];
    const fieldPath = `${path}（JSON 文本字段）`;
    while (fields.length) {
      const field = fields.pop();
      if (typeof field === "string") pending.push({ path: fieldPath, text: field });
      else if (Array.isArray(field)) {
        for (const child of field) fields.push(child);
      } else if (field && typeof field === "object") {
        for (const [key, child] of Object.entries(field)) {
          // 同时检查解码后的键值关系，例如值中用 Unicode 转义书写的密码。
          if (typeof child === "string") {
            scanSecretText(fieldPath, `${JSON.stringify(key)}: ${JSON.stringify(child)}`);
          }
          fields.push(child);
        }
      }
    }
  }
}

function scanSecretText(path: string, text: string): void {
  for (const { label, pattern, skip } of SECRET_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
      if (skip?.(match)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      throw new SkillLibraryError(
        `疑似${label}(${path}:${line} ${maskedExcerpt(match[0])})。`
        + `skill 文件权限全开、人人可读,任何令牌/密码都不能出现;`
        + `请改成 <token> 之类的占位符再上传`);
    }
  }
}

/** 上传即归一权限:文件 0644/目录 0755。显式 chmod 而不是信 umask,
 * 内网容器 uid 与服务账号对不上是已知事实,只有权限位救得了它。 */
function normalizePermissions(root: string): void {
  chmodSync(root, 0o755);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const child = join(root, entry.name);
    if (entry.isDirectory()) normalizePermissions(child);
    else chmodSync(child, 0o644);
  }
}

function packageStats(root: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) visit(child);
      else {
        files += 1;
        bytes += lstatSync(child).size;
      }
    }
  };
  visit(root);
  return { files, bytes };
}

function appendOperation(dataDir: string, record: SkillOperationRecord): void {
  appendFileSync(
    join(dataDir, OPERATIONS_LOG), `${JSON.stringify(record)}\n`,
    { mode: 0o644 });
}

export function listSkillOperations(
  dataDir: string,
  limit = 30,
): SkillOperationRecord[] {
  const path = join(dataDir, OPERATIONS_LOG);
  if (!existsSync(path)) return [];
  const records: SkillOperationRecord[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as SkillOperationRecord);
    } catch {
      // 半行(进程被杀时可能出现)跳过,留痕读侧永远 fail-open。
    }
  }
  return records.slice(-limit).reverse();
}

export function listSkillVersions(
  dataDir: string,
  directory: string,
): SkillVersionRecord[] {
  assertDirectoryName(directory);
  const root = join(dataDir, VERSIONS_DIR, directory);
  if (!existsSync(root)) return [];
  const versions: SkillVersionRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(
        readFileSync(join(root, entry.name), "utf-8")) as SkillVersionRecord;
      if (existsSync(join(root, record.version_id))) versions.push(record);
    } catch {
      // 元数据坏了就当没有这个版本,读侧不硬崩。
    }
  }
  return versions.sort((left, right) =>
    right.version_id.localeCompare(left.version_id));
}

/** 归档当前生效版本并返回版本痕;超出上限修剪最老的归档。 */
function archiveLive(
  dataDir: string,
  directory: string,
  action: string,
  operator: string,
): SkillVersionRecord {
  const live = join(dataDir, LIVE_DIR, directory);
  const digest = packageDigest(live);
  const skillFile = join(live, "SKILL.md");
  const skillDigest = existsSync(skillFile)
    ? sha256(readFileSync(skillFile)) : "";
  const { files, bytes } = packageStats(live);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  let versionId = `${stamp}-${digest.slice(0, 12)}`;
  const versionRoot = join(dataDir, VERSIONS_DIR, directory);
  mkdirSync(versionRoot, { recursive: true });
  // 同一秒可被多位成员连续维护；相同正文仍需分别保留操作快照。
  let sequence = 0;
  while (existsSync(join(versionRoot, versionId))) versionId = `${stamp}-${digest.slice(0, 12)}-${++sequence}`;
  const record: SkillVersionRecord = {
    version_id: versionId,
    archived_at: new Date().toISOString(),
    action,
    operator,
    skill_digest: skillDigest,
    package_digest: digest,
    files,
    bytes,
  };
  renameSync(live, join(versionRoot, versionId));
  writeFileSync(
    join(versionRoot, `${versionId}.json`), JSON.stringify(record),
    { mode: 0o644 });
  const all = listSkillVersions(dataDir, directory);
  for (const stale of all.slice(MAX_VERSIONS_PER_SKILL)) {
    rmSync(join(versionRoot, stale.version_id),
      { recursive: true, force: true });
    rmSync(join(versionRoot, `${stale.version_id}.json`), { force: true });
  }
  return record;
}

/** 对暂存包做完整验收:预算、密钥扫描、pi 装载器裁决。装载性以 pi 为
 * 唯一判据(与货架同纪律)——装载器不认的包收进来就是"放了没生效"。 */
function validateStaged(stagingRoot: string, directory: string): {
  skillDigest: string;
  packageDigestValue: string;
  files: number;
  bytes: number;
  nature: KnowledgeAssetMetadata["nature"];
  businessModuleIds: string[];
  repositories: string[];
  technologies: string[];
} {
  const packageRoot = join(stagingRoot, directory);
  const skillFile = join(packageRoot, "SKILL.md");
  if (!existsSync(skillFile)) {
    throw new SkillLibraryError("包根目录必须有 SKILL.md");
  }
  const skillContent = readFileSync(skillFile);
  if (skillContent.byteLength > MAX_SKILL_BYTES) {
    throw new SkillLibraryError("SKILL.md 超过 128 KiB");
  }
  let metadata: KnowledgeAssetMetadata;
  try {
    metadata = readSkillKnowledgeMetadata(skillContent.toString("utf-8"));
  } catch (error) {
    throw new SkillLibraryError(
      error instanceof Error ? error.message : String(error));
  }
  if (metadata.nature === "unclassified") {
    throw new SkillLibraryError(
      "Skill 必须明确标为业务知识或工程知识，并补齐对应作用域标签");
  }
  const { files, bytes } = packageStats(packageRoot);
  if (files > MAX_FILES) {
    throw new SkillLibraryError(`包内文件数超过 ${MAX_FILES}`);
  }
  if (bytes > MAX_PACKAGE_BYTES) {
    throw new SkillLibraryError("包体积超过 16 MiB");
  }
  const discovered = loadSkills({
    cwd: stagingRoot,
    agentDir: stagingRoot,
    skillPaths: [stagingRoot],
    includeDefaults: false,
  });
  const mine = discovered.skills.filter((skill) =>
    resolve(skill.filePath) === resolve(skillFile));
  if (mine.length !== 1) {
    const reasons = discovered.diagnostics
      .map((item) => item.message).join("; ");
    throw new SkillLibraryError(
      `pi 装载器不接受这个包(检查 SKILL.md frontmatter 的 `
      + `name/description)${reasons ? `: ${reasons}` : ""}`);
  }
  return {
    skillDigest: sha256(skillContent),
    packageDigestValue: packageDigest(packageRoot),
    files,
    bytes,
    nature: metadata.nature,
    businessModuleIds: metadata.business_module_ids,
    repositories: metadata.repositories,
    technologies: metadata.technologies,
  };
}

/** 把验收过的暂存包换进生效位:旧版先归档,再原子换名。 */
function installStaged(
  dataDir: string,
  stagingRoot: string,
  directory: string,
  operator: string,
  action: "upload" | "update" | "rollback",
  staged: ReturnType<typeof validateStaged>,
  detail?: string,
  checkBudget: () => void = () => {},
): SkillOperationRecord {
  checkBudget();
  const liveRoot = join(dataDir, LIVE_DIR);
  mkdirSync(liveRoot, { recursive: true });
  chmodSync(liveRoot, 0o755);
  const live = join(liveRoot, directory);
  if (existsSync(live)) {
    archiveLive(dataDir, directory,
      action === "rollback" ? "rollback" : "update", operator);
  }
  checkBudget();
  renameSync(join(stagingRoot, directory), live);
  const record: SkillOperationRecord = {
    at: new Date().toISOString(),
    operator,
    action,
    directory,
    skill_digest: staged.skillDigest,
    package_digest: staged.packageDigestValue,
    files: staged.files,
    bytes: staged.bytes,
    ...(detail ? { detail } : {}),
  };
  checkBudget();
  appendOperation(dataDir, record);
  return record;
}

/** 写操作全局串行:两个管理员同时换同一个包,后到的等前一个换完再验。 */
let writeQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => T): Promise<T> {
  const next = writeQueue.then(work);
  writeQueue = next.catch(() => undefined);
  return next;
}

/** 等待写队列也计入预算；过期请求不能在调用人收到失败后继续安装。 */
function approvalWithinBudget<T>(work: (checkBudget: () => void) => T): Promise<T> {
  const deadline = Date.now() + APPROVAL_BUDGET_MS;
  let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = () => new SkillLibraryError("Skill 审批超过60秒预算，已停止；已保存的审核通过意图将在服务启动时接续，请检查提交记录");
  const checkBudget = () => { if (expired || Date.now() >= deadline) throw timeout(); };
  const queued = serialized(() => { checkBudget(); return work(checkBudget); });
  const budget = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(timeout()); }, APPROVAL_BUDGET_MS);
  });
  return Promise.race([queued, budget]).finally(() => clearTimeout(timer));
}

function stageDirectory(dataDir: string, directory: string): string {
  const root = join(
    dataDir, STAGING_DIR, `${directory}-${Date.now().toString(36)}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, directory), { recursive: true });
  return root;
}

/** 复制已验收包时仍逐项拒绝软链接；生效位可能被部署侧人工碰过，
 * “曾经安全”不能当作当前安全。 */
function copyOrdinaryDirectory(from: string, to: string): void {
  if (lstatSync(from).isSymbolicLink() || !lstatSync(from).isDirectory()) {
    throw new SkillLibraryError("Skill 包路径不是普通目录");
  }
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (lstatSync(source).isSymbolicLink()) {
      throw new SkillLibraryError(`Skill 包包含软链接: ${entry.name}`);
    }
    if (entry.isDirectory()) copyOrdinaryDirectory(source, target);
    else if (entry.isFile()) writeFileSync(target, readFileSync(source));
    else throw new SkillLibraryError(`Skill 包包含非常规文件: ${entry.name}`);
  }
}

/** 上传/更新一个 skill 包。任何一步失败都不碰生效位,暂存整目录清掉。 */
export function uploadHostSkill(
  dataDir: string,
  directory: string,
  files: SkillUploadFile[],
  operator: string,
  metadata?: Partial<KnowledgeAssetMetadata>,
): Promise<SkillOperationRecord> {
  return serialized(() => {
    assertDirectoryName(directory);
    if (!Array.isArray(files) || files.length === 0) {
      throw new SkillLibraryError("上传内容为空");
    }
    if (files.length > MAX_FILES) {
      throw new SkillLibraryError(`包内文件数超过 ${MAX_FILES}`);
    }
    const stagingRoot = stageDirectory(dataDir, directory);
    try {
      const staged = materializeToStaging(
        stagingRoot, directory, files, metadata);
      const exists = existsSync(join(dataDir, LIVE_DIR, directory));
      return installStaged(dataDir, stagingRoot, directory, operator,
        exists ? "update" : "upload", staged);
    } finally {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  });
}

/** 调整知识属性也走完整版本纪律；正文与配套文件一个都不能被 UI 丢掉。 */
export function updateHostSkillKnowledgeMetadata(
  dataDir: string,
  directory: string,
  metadata: Partial<KnowledgeAssetMetadata>,
  operator: string,
): Promise<SkillOperationRecord> {
  return serialized(() => {
    assertDirectoryName(directory);
    const live = join(dataDir, LIVE_DIR, directory);
    if (!existsSync(live)) {
      throw new SkillLibraryError(`没有这个生效中的 skill: ${directory}`);
    }
    const stagingRoot = stageDirectory(dataDir, directory);
    try {
      copyOrdinaryDirectory(live, join(stagingRoot, directory));
      const skillFile = join(stagingRoot, directory, "SKILL.md");
      let tagged: string;
      try {
        tagged = writeSkillKnowledgeMetadata(
          readFileSync(skillFile, "utf-8"), metadata as KnowledgeAssetMetadata);
      } catch (error) {
        throw new SkillLibraryError(
          error instanceof Error ? error.message : String(error));
      }
      const content = Buffer.from(tagged, "utf-8");
      scanForSecrets("SKILL.md", content);
      writeFileSync(skillFile, content);
      normalizePermissions(join(stagingRoot, directory));
      const staged = validateStaged(stagingRoot, directory);
      const selected = readSkillKnowledgeMetadata(tagged);
      return installStaged(dataDir, stagingRoot, directory, operator,
        "update", staged,
        `更新知识属性：${selected.nature}`);
    } finally {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  });
}

/** 上传载荷 → 暂存目录 + 完整验收(路径/密钥/预算/装载器)。上架与
 * 提交待审共用同一道闸:待审区也是可读区,不合格的包一步都不许进。 */
function materializeToStaging(
  stagingRoot: string,
  directory: string,
  files: SkillUploadFile[],
  metadata?: Partial<KnowledgeAssetMetadata>,
): ReturnType<typeof validateStaged> {
  if (metadata === undefined) {
    throw new SkillLibraryError(
      "上传或提交 Skill 时必须设置知识性质与作用域标签");
  }
  const seen = new Set<string>();
  for (const file of files) {
    const path = String(file.path ?? "");
    assertPackagePath(path);
    if (seen.has(path)) {
      throw new SkillLibraryError(`包内路径重复: ${path}`);
    }
    seen.add(path);
    const content = Buffer.from(String(file.content_base64 ?? ""), "base64");
    scanForSecrets(path, content);
    const target = join(stagingRoot, directory, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  if (metadata !== undefined) {
    const skillFile = join(stagingRoot, directory, "SKILL.md");
    if (!existsSync(skillFile)) {
      throw new SkillLibraryError("包根目录必须有 SKILL.md");
    }
    try {
      const tagged = writeSkillKnowledgeMetadata(
        readFileSync(skillFile, "utf-8"), metadata as KnowledgeAssetMetadata);
      const buffer = Buffer.from(tagged, "utf-8");
      scanForSecrets("SKILL.md", buffer);
      writeFileSync(skillFile, buffer);
    } catch (error) {
      if (error instanceof SkillLibraryError) throw error;
      throw new SkillLibraryError(
        error instanceof Error ? error.message : String(error));
    }
  }
  normalizePermissions(join(stagingRoot, directory));
  return validateStaged(stagingRoot, directory);
}

function submissionRoot(dataDir: string, directory: string): string {
  return join(dataDir, SUBMISSIONS_DIR, directory);
}

function writeSubmissionRecord(
  dataDir: string,
  record: SkillSubmissionRecord,
): void {
  durableWriteFileSync(
    join(submissionRoot(dataDir, record.directory), record.id,
      "submission.json"),
    JSON.stringify(record), { mode: 0o644 });
}

/** 开发者提交待审包:验收全过才进待审区,绝不自动上架。 */
export function submitHostSkill(
  dataDir: string,
  directory: string,
  files: SkillUploadFile[],
  operator: string,
  metadata?: Partial<KnowledgeAssetMetadata>,
): Promise<SkillSubmissionRecord> {
  return serialized(() => {
    assertDirectoryName(directory);
    if (!Array.isArray(files) || files.length === 0) {
      throw new SkillLibraryError("提交内容为空");
    }
    if (files.length > MAX_FILES) {
      throw new SkillLibraryError(`包内文件数超过 ${MAX_FILES}`);
    }
    const stagingRoot = stageDirectory(dataDir, directory);
    try {
      const staged = materializeToStaging(
        stagingRoot, directory, files, metadata);
      const live = join(dataDir, LIVE_DIR, directory);
      const basePackageDigest = existsSync(live) ? packageDigest(live) : null;
      const duplicate = listSkillSubmissions(dataDir).find(record =>
        record.directory === directory && ["pending", "approving"].includes(record.status)
        && record.package_digest === staged.packageDigestValue
        && record.base_package_digest === basePackageDigest);
      if (duplicate) {
        // 只复用仍待处理且基线相同的提交，退回与正式版本变化后都能重新提交。
        readSkillSubmissionPackage(dataDir, directory, duplicate.id);
        return duplicate;
      }
      const stamp = new Date().toISOString().replace(/[-:.]/g, "");
      let id = stamp;
      for (let seq = 1;
        existsSync(join(submissionRoot(dataDir, directory), id)); seq += 1) {
        id = `${stamp}${seq}`;
      }
      const home = join(submissionRoot(dataDir, directory), id);
      mkdirSync(home, { recursive: true });
      renameSync(join(stagingRoot, directory), join(home, "package"));
      const record: SkillSubmissionRecord = {
        id,
        directory,
        operator,
        created_at: new Date().toISOString(),
        status: "pending",
        skill_digest: staged.skillDigest,
        package_digest: staged.packageDigestValue,
        base_package_digest: basePackageDigest,
        files: staged.files,
        bytes: staged.bytes,
        nature: staged.nature,
        business_module_ids: staged.businessModuleIds,
        repositories: staged.repositories,
        technologies: staged.technologies,
      };
      writeSubmissionRecord(dataDir, record);
      appendOperation(dataDir, {
        at: record.created_at,
        operator,
        action: "submit",
        directory,
        skill_digest: record.skill_digest,
        package_digest: record.package_digest,
        files: record.files,
        bytes: record.bytes,
        detail: `提交待审 ${id}`,
      });
      return record;
    } finally {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  });
}

/** 逐条读取台账；坏件保留原字节，并通过现有告警渠道点名。 */
export function listSkillSubmissions(
  dataDir: string,
  warnings?: string[],
): SkillSubmissionRecord[] {
  const root = join(dataDir, SUBMISSIONS_DIR);
  if (!existsSync(root)) return [];
  const records: SkillSubmissionRecord[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    let entries: Dirent[];
    try { entries = readdirSync(join(root, dir.name), { withFileTypes: true }); }
    catch {
      warnings?.push(`记录损坏：${SUBMISSIONS_DIR}/${dir.name}，无法读取提交目录`);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        records.push(readSubmission(dataDir, dir.name, entry.name));
      } catch {
        warnings?.push(`记录损坏：${SUBMISSIONS_DIR}/${dir.name}/${entry.name}/submission.json`);
      }
    }
  }
  return records.sort((left, right) => right.id.localeCompare(left.id));
}

function validSubmission(value: unknown, directory: string, id: string): value is SkillSubmissionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const text = (key: string) => typeof record[key] === "string" && !!record[key];
  const time = (key: string) => text(key) && Number.isFinite(Date.parse(record[key] as string));
  const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const strings = (key: string) => Array.isArray(record[key]) && (record[key] as unknown[]).every(value => typeof value === "string");
  if (record.id !== id || !/^[A-Za-z0-9_-]{1,100}$/.test(id) || record.directory !== directory
      || !text("operator") || !time("created_at") || !digest(record.skill_digest) || !digest(record.package_digest)
      || !Object.hasOwn(record, "base_package_digest") || !(record.base_package_digest === null || digest(record.base_package_digest))
      || !["pending", "approving", "approved", "rejected"].includes(String(record.status))
      || !Number.isInteger(record.files) || (record.files as number) < 1 || (record.files as number) > MAX_FILES
      || !Number.isInteger(record.bytes) || (record.bytes as number) < 1 || (record.bytes as number) > MAX_PACKAGE_BYTES
      || !["business", "engineering"].includes(String(record.nature))
      || !["business_module_ids", "repositories", "technologies"].every(strings)
      || (record.reject_reason !== undefined && typeof record.reject_reason !== "string")) return false;
  if (record.status !== "pending" && (!time("decided_at") || !text("decided_by"))) return false;
  if (record.decided_at !== undefined && !time("decided_at")) return false;
  if (record.decided_by !== undefined && !text("decided_by")) return false;
  try {
    assertDirectoryName(directory);
    normalizeKnowledgeAssetMetadata({ nature: record.nature, form: "skill", business_module_ids: record.business_module_ids,
      repositories: record.repositories, technologies: record.technologies });
  } catch { return false; }
  return true;
}

function readSubmission(
  dataDir: string,
  directory: string,
  id: string,
): SkillSubmissionRecord {
  const path = join(submissionRoot(dataDir, directory), id, "submission.json");
  if (!existsSync(path)) {
    throw new SkillLibraryError(`没有这份提交: ${directory}/${id}`);
  }
  try {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("审核记录不是普通文件");
    const record: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!validSubmission(record, directory, id)) throw new Error("审核记录形状不完整或基线缺失");
    return record;
  } catch (error) {
    throw new SkillLibraryError(`记录损坏：${SUBMISSIONS_DIR}/${directory}/${id}/submission.json；${error instanceof Error ? error.message : String(error)}`);
  }
}

function stageSubmission(dataDir: string, record: SkillSubmissionRecord, checkBudget: () => void) {
  checkBudget();
  const stagingRoot = stageDirectory(dataDir, record.directory);
  try {
    copyOrdinaryDirectory(join(submissionRoot(dataDir, record.directory), record.id, "package"), join(stagingRoot, record.directory));
    checkBudget();
    normalizePermissions(join(stagingRoot, record.directory));
    const staged = validateStaged(stagingRoot, record.directory);
    if (staged.packageDigestValue !== record.package_digest || staged.skillDigest !== record.skill_digest) {
      throw new SkillLibraryError("提交包已变化，请重新提交后审查");
    }
    checkBudget();
    return { stagingRoot, staged };
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

/** 意图是安装权限的依据；若安装已完成，只补审核结果，不能再次归档或覆盖。 */
function finishApproval(dataDir: string, record: SkillSubmissionRecord, prepared: ReturnType<typeof stageSubmission>, checkBudget: () => void): SkillOperationRecord {
  checkBudget();
  const live = join(dataDir, LIVE_DIR, record.directory);
  const currentDigest = existsSync(live) ? packageDigest(live) : null;
  const installDetail = `审核通过 ${record.operator} 的提交 ${record.id}`;
  const installationRecorded = listSkillOperations(dataDir, Number.MAX_SAFE_INTEGER).some(operation => operation && typeof operation === "object" && !Array.isArray(operation)
    && operation.directory === record.directory
    && operation.package_digest === record.package_digest && operation.detail === installDetail && ["upload", "update"].includes(operation.action));
  checkBudget();
  let installed: SkillOperationRecord;
  // 精确安装台账证明这次审批已生效；后来下线或回退不撤销历史裁决，只补终态。
  if (installationRecorded || currentDigest === record.package_digest) {
    installed = {
      at: record.decided_at!, operator: record.decided_by!, action: record.base_package_digest === null ? "upload" : "update",
      directory: record.directory, skill_digest: record.skill_digest, package_digest: record.package_digest,
      files: record.files, bytes: record.bytes, detail: installDetail,
    };
    // kill 可能发生在换包 rename 后、操作留痕前；按原意图补足，不重复换包。
    checkBudget();
    if (!installationRecorded) appendOperation(dataDir, installed);
  } else {
    if (currentDigest !== null && currentDigest !== record.base_package_digest) {
      throw new SkillLibraryError("当前 Skill 包在审核通过后又发生变化，未覆盖正式包；请核对提交包与当前版本");
    }
    installed = installStaged(dataDir, prepared.stagingRoot, record.directory, record.decided_by!,
      record.base_package_digest === null ? "upload" : "update", prepared.staged, installDetail, checkBudget);
  }
  const approvalDetail = `通过 ${record.operator} 的提交 ${record.id}`;
  const decided = { ...record, status: "approved" as const };
  const recorded = listSkillOperations(dataDir, Number.MAX_SAFE_INTEGER).some(operation => operation && typeof operation === "object" && !Array.isArray(operation)
    && operation.action === "approve"
    && operation.directory === record.directory && operation.package_digest === record.package_digest && operation.detail === approvalDetail);
  checkBudget();
  if (!recorded) appendOperation(dataDir, {
    at: record.decided_at!, operator: record.decided_by!, action: "approve", directory: record.directory,
    skill_digest: record.skill_digest, package_digest: record.package_digest, detail: approvalDetail,
  });
  checkBudget();
  writeSubmissionRecord(dataDir, decided);
  return installed;
}

/** 审核结果先耐久保存为意图，换包中断后仍知道原审核人和精确内容。 */
export function approveSkillSubmission(
  dataDir: string, directory: string, id: string, approver: string,
): Promise<SkillOperationRecord> {
  return approvalWithinBudget(checkBudget => {
    assertDirectoryName(directory);
    const record = readSubmission(dataDir, directory, id);
    if (record.status !== "pending") throw new SkillLibraryError(`提交 ${id} 已经裁决过(${record.status}),不能重复审核`);
    const live = join(dataDir, LIVE_DIR, directory);
    const currentDigest = existsSync(live) ? packageDigest(live) : null;
    if (currentDigest !== record.base_package_digest) {
      throw new SkillLibraryError("当前 Skill 包在提交后已发生变化，请基于最新版本重新提交；本次仍保持待审核，未覆盖已发布内容");
    }
    const prepared = stageSubmission(dataDir, record, checkBudget);
    try {
      const intent = { ...record, status: "approving" as const, decided_at: new Date().toISOString(), decided_by: approver };
      checkBudget();
      writeSubmissionRecord(dataDir, intent);
      return finishApproval(dataDir, intent, prepared, checkBudget);
    } finally { rmSync(prepared.stagingRoot, { recursive: true, force: true }); }
  });
}

/** 服务启动只接续已审批的意图；单条失败保留原记录并点名，不能阻挡邻居。 */
export function recoverSkillSubmissions(dataDir: string, warnings: string[] = []): Promise<void> {
  return approvalWithinBudget(checkBudget => {
    const records = listSkillSubmissions(dataDir, warnings);
    for (const record of records) {
      if (record.status !== "approving") continue;
      const path = `${SUBMISSIONS_DIR}/${record.directory}/${record.id}/submission.json`;
      try {
        checkBudget();
        const prepared = stageSubmission(dataDir, record, checkBudget);
        try { finishApproval(dataDir, record, prepared, checkBudget); }
        finally { rmSync(prepared.stagingRoot, { recursive: true, force: true }); }
      } catch (error) {
        warnings.push(`审核通过尚未完成：${path}；${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
}

/** 驳回:包留在待审区做台账,只改状态、记原因。 */
export function rejectSkillSubmission(
  dataDir: string,
  directory: string,
  id: string,
  approver: string,
  reason?: string,
): Promise<SkillSubmissionRecord> {
  return serialized(() => {
    assertDirectoryName(directory);
    const record = readSubmission(dataDir, directory, id);
    if (record.status !== "pending") {
      throw new SkillLibraryError(
        `提交 ${id} 已经裁决过(${record.status}),不能重复审核`);
    }
    const decided: SkillSubmissionRecord = {
      ...record,
      status: "rejected",
      decided_at: new Date().toISOString(),
      decided_by: approver,
      ...(reason?.trim() ? { reject_reason: reason.trim() } : {}),
    };
    writeSubmissionRecord(dataDir, decided);
    appendOperation(dataDir, {
      at: decided.decided_at!,
      operator: approver,
      action: "reject",
      directory,
      skill_digest: record.skill_digest,
      package_digest: record.package_digest,
      detail: `驳回 ${record.operator} 的提交 ${id}`
        + (decided.reject_reason ? `:${decided.reject_reason}` : ""),
    });
    return decided;
  });
}

/** 下线:从生效位撤走并归档,随时可回退。 */
export function offlineHostSkill(
  dataDir: string,
  directory: string,
  operator: string,
): Promise<SkillOperationRecord> {
  return serialized(() => {
    assertDirectoryName(directory);
    if (!existsSync(join(dataDir, LIVE_DIR, directory))) {
      throw new SkillLibraryError(`没有这个生效中的 skill: ${directory}`);
    }
    const archived = archiveLive(dataDir, directory, "offline", operator);
    const record: SkillOperationRecord = {
      at: new Date().toISOString(),
      operator,
      action: "offline",
      directory,
      skill_digest: archived.skill_digest,
      package_digest: archived.package_digest,
      detail: `归档为 ${archived.version_id},可回退`,
    };
    appendOperation(dataDir, record);
    return record;
  });
}

/** 回退到某个归档版本:归档不动(复制装回),回退本身也重走完整验收
 * ——归档里的东西理论上都是验收过的,但"理论上"不配跳过闸门。 */
export function rollbackHostSkill(
  dataDir: string,
  directory: string,
  versionId: string,
  operator: string,
): Promise<SkillOperationRecord> {
  return serialized(() => {
    assertDirectoryName(directory);
    if (!/^[0-9TZ]+-[0-9a-f]{12}(?:-[1-9][0-9]*)?$/.test(versionId)) {
      throw new SkillLibraryError(`版本号不合法: ${versionId}`);
    }
    const versionDir = join(dataDir, VERSIONS_DIR, directory, versionId);
    if (!existsSync(versionDir) || !lstatSync(versionDir).isDirectory()) {
      throw new SkillLibraryError(`没有这个归档版本: ${versionId}`);
    }
    const stagingRoot = stageDirectory(dataDir, directory);
    try {
      copyOrdinaryDirectory(versionDir, join(stagingRoot, directory));
      normalizePermissions(join(stagingRoot, directory));
      const staged = validateStaged(stagingRoot, directory);
      return installStaged(dataDir, stagingRoot, directory, operator,
        "rollback", staged, `回退到 ${versionId}`);
    } finally {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  });
}
