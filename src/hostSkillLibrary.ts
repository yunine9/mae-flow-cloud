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
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { packageDigest } from "./hostSkillRuntime.ts";

/** 与快照器同预算:管理面收下的包必须是运行时装得动的包。 */
const MAX_SKILL_BYTES = 128 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 400;
const MAX_DEPTH = 8;
/** 版本痕不设上限会无限吃盘;超过后修剪最老的(操作留痕永不修剪)。 */
const MAX_VERSIONS_PER_SKILL = 20;

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
  status: "pending" | "approved" | "rejected";
  skill_digest: string;
  package_digest: string;
  files: number;
  bytes: number;
  decided_at?: string;
  decided_by?: string;
  reject_reason?: string;
}

/** 疑似密钥的形态清单。宁可错杀让人改个写法,不可放一个真令牌进
 * 权限全开的目录;占位符(<token>/{TOKEN}/$VAR)由值形态排除。 */
const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "密钥赋值",
    pattern: /(?:api[_-]?key|secret|token|passwd|password|access[_-]?key)["']?\s*[:=]\s*["']?(?=[A-Za-z0-9_\-./+]*[A-Za-z])[A-Za-z0-9_\-./+]{8,}/i,
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
  return {
    directory,
    path: `${directory}/SKILL.md`,
    content: raw.toString("utf-8"),
    digest: sha256(raw),
    bytes: raw.byteLength,
  };
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
  const text = content.toString("utf-8");
  for (const { label, pattern } of SECRET_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
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
  const versionId = `${stamp}-${digest.slice(0, 12)}`;
  const versionRoot = join(dataDir, VERSIONS_DIR, directory);
  mkdirSync(versionRoot, { recursive: true });
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
): SkillOperationRecord {
  const liveRoot = join(dataDir, LIVE_DIR);
  mkdirSync(liveRoot, { recursive: true });
  chmodSync(liveRoot, 0o755);
  const live = join(liveRoot, directory);
  if (existsSync(live)) {
    archiveLive(dataDir, directory,
      action === "rollback" ? "rollback" : "update", operator);
  }
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

function stageDirectory(dataDir: string, directory: string): string {
  const root = join(
    dataDir, STAGING_DIR, `${directory}-${Date.now().toString(36)}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, directory), { recursive: true });
  return root;
}

/** 上传/更新一个 skill 包。任何一步失败都不碰生效位,暂存整目录清掉。 */
export function uploadHostSkill(
  dataDir: string,
  directory: string,
  files: SkillUploadFile[],
  operator: string,
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
      const staged = materializeToStaging(stagingRoot, directory, files);
      const exists = existsSync(join(dataDir, LIVE_DIR, directory));
      return installStaged(dataDir, stagingRoot, directory, operator,
        exists ? "update" : "upload", staged);
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
): ReturnType<typeof validateStaged> {
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
  writeFileSync(
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
      const staged = materializeToStaging(stagingRoot, directory, files);
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
        files: staged.files,
        bytes: staged.bytes,
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

/** 全部提交记录(含已裁决的:审核史也是台账)。读侧 fail-open。 */
export function listSkillSubmissions(
  dataDir: string,
): SkillSubmissionRecord[] {
  const root = join(dataDir, SUBMISSIONS_DIR);
  if (!existsSync(root)) return [];
  const records: SkillSubmissionRecord[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const entry of readdirSync(join(root, dir.name),
      { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        records.push(JSON.parse(readFileSync(
          join(root, dir.name, entry.name, "submission.json"), "utf-8")));
      } catch {
        // 坏记录跳过:待审区读侧不硬崩。
      }
    }
  }
  return records.sort((left, right) => right.id.localeCompare(left.id));
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
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** 审核通过 → 上架。重走完整验收(与回退同纪律),操作留痕记提交人
 * 与审核人两个名字。 */
export function approveSkillSubmission(
  dataDir: string,
  directory: string,
  id: string,
  approver: string,
): Promise<SkillOperationRecord> {
  return serialized(() => {
    assertDirectoryName(directory);
    const record = readSubmission(dataDir, directory, id);
    if (record.status !== "pending") {
      throw new SkillLibraryError(
        `提交 ${id} 已经裁决过(${record.status}),不能重复审核`);
    }
    const stagingRoot = stageDirectory(dataDir, directory);
    try {
      cpSync(join(submissionRoot(dataDir, directory), id, "package"),
        join(stagingRoot, directory), { recursive: true });
      normalizePermissions(join(stagingRoot, directory));
      const staged = validateStaged(stagingRoot, directory);
      const exists = existsSync(join(dataDir, LIVE_DIR, directory));
      const installed = installStaged(dataDir, stagingRoot, directory,
        approver, exists ? "update" : "upload", staged,
        `审核通过 ${record.operator} 的提交 ${id}`);
      const decided: SkillSubmissionRecord = {
        ...record,
        status: "approved",
        decided_at: new Date().toISOString(),
        decided_by: approver,
      };
      writeSubmissionRecord(dataDir, decided);
      appendOperation(dataDir, {
        at: decided.decided_at!,
        operator: approver,
        action: "approve",
        directory,
        skill_digest: record.skill_digest,
        package_digest: record.package_digest,
        detail: `通过 ${record.operator} 的提交 ${id}`,
      });
      return installed;
    } finally {
      rmSync(stagingRoot, { recursive: true, force: true });
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
    if (!/^[0-9TZ]+-[0-9a-f]{12}$/.test(versionId)) {
      throw new SkillLibraryError(`版本号不合法: ${versionId}`);
    }
    const versionDir = join(dataDir, VERSIONS_DIR, directory, versionId);
    if (!existsSync(versionDir) || !lstatSync(versionDir).isDirectory()) {
      throw new SkillLibraryError(`没有这个归档版本: ${versionId}`);
    }
    const stagingRoot = stageDirectory(dataDir, directory);
    try {
      const copy = (from: string, to: string): void => {
        mkdirSync(to, { recursive: true });
        for (const entry of readdirSync(from, { withFileTypes: true })) {
          const source = join(from, entry.name);
          const target = join(to, entry.name);
          if (lstatSync(source).isSymbolicLink()) {
            throw new SkillLibraryError(`归档版本包含软链接: ${entry.name}`);
          }
          if (entry.isDirectory()) copy(source, target);
          else writeFileSync(target, readFileSync(source));
        }
      };
      copy(versionDir, join(stagingRoot, directory));
      normalizePermissions(join(stagingRoot, directory));
      const staged = validateStaged(stagingRoot, directory);
      return installStaged(dataDir, stagingRoot, directory, operator,
        "rollback", staged, `回退到 ${versionId}`);
    } finally {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  });
}
