/**
 * 业务仓 Skill 的只读发现器。
 *
 * 安全边界：只对远端做一次无工作树浅克隆，再通过 Git object/tree 读取
 * 固定位置的 SKILL.md。仓库里的 hook、脚本、符号链接和 submodule 都不
 * 会被执行或跟随；临时目录无论成功、失败还是超时都会删除。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

export const REPOSITORY_SKILL_ROOTS = [
  ".agents/skills",
  ".pi/skills",
  ".claude/skills",
  ".cac/skills",
] as const;

export interface RepositorySkillDescriptor {
  id: string;
  name: string;
  description: string;
  relative_path: string;
  source: (typeof REPOSITORY_SKILL_ROOTS)[number];
  digest: string;
  selectable: boolean;
  warning?: string;
}

export type RepositoryKnowledgeKind = "rules" | "document";

/** 业务知识与 Skill 共用同一次只读仓库目录。规则文件由 Pi 自动加载，
 * docs 文档可由用户在下单时明确选为“本单重点知识”。 */
export interface RepositoryKnowledgeDescriptor {
  id: string;
  title: string;
  description: string;
  relative_path: string;
  kind: RepositoryKnowledgeKind;
  digest: string;
  bytes: number;
  selectable: boolean;
  recommended: boolean;
  auto_load: boolean;
  warning?: string;
}

export interface RepositorySkillCatalog {
  repository: string;
  revision: string;
  skills: RepositorySkillDescriptor[];
  knowledge: RepositoryKnowledgeDescriptor[];
  error?: string;
}

export interface DiscoverRepositorySkillsOptions {
  repository: string;
  baseline?: string;
  /** 宿主创建的短生命周期 Git credential helper；不会写入 clone config。 */
  credentialHelper?: string;
  /** 带个人令牌时必须一起给加固环境(prepareHostGitSandbox 的 env/args)。
   * 我们的 helper 问什么答什么、不看 host,部署机全局配置里一条
   * `url.<别处>.insteadOf` 就能把这次只读发现改道到另一台主机,顺手
   * 把用户令牌带走。空 HOME/全局/系统配置让改道的配置来源不存在。 */
  credentialArgs?: readonly string[];
  credentialEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const MAX_SKILL_BYTES = 128 * 1024;
const MAX_SKILLS = 100;
const MAX_KNOWLEDGE_BYTES = 128 * 1024;
const MAX_KNOWLEDGE_FILES = 200;
const MAX_KNOWLEDGE_DEPTH = 6;
const MAX_TREE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const TEMP_PREFIX = "mae-flow-repository-skills-";

interface TreeEntry {
  mode: string;
  type: "blob" | "tree" | "commit";
  oid: string;
  name: string;
}

class DiscoveryTimeoutError extends Error {}

function cleanRepository(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // 本地路径和 scp 风格 SSH 地址必须保持原样：后续任务工作区按这个
    // repository 做归属匹配，发现阶段不能擅自换一套身份字符串。
    return raw;
  }
}

function repositoryIsSafe(raw: string): boolean {
  if (!raw || raw.startsWith("-") || /[\0\r\n]/.test(raw)) return false;
  if (/^ext::/i.test(raw) || raw.includes("::")) return false;
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  return !scheme || ["http", "https", "ssh", "git", "file"].includes(scheme);
}

function baselineIsSafe(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return raw.length > 0
    && raw.length <= 255
    && !raw.startsWith("-")
    && !/[\0\r\n\s\\]/.test(raw);
}

function helperIsSafe(raw: string | undefined): boolean {
  return raw === undefined
    || (raw.length > 0 && raw.length <= 4096 && !/[\0\r\n]/.test(raw));
}

function safePathSegment(name: string): boolean {
  return name.length > 0
    && name !== "."
    && name !== ".."
    && !name.includes("/")
    && !name.includes("\\")
    && !/[\0-\x1f\x7f]/.test(name);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseTree(output: Buffer): TreeEntry[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: TreeEntry[] = [];
  let start = 0;
  for (let index = 0; index <= output.length; index += 1) {
    if (index !== output.length && output[index] !== 0) continue;
    if (index === start) {
      start = index + 1;
      continue;
    }
    const record = output.subarray(start, index);
    start = index + 1;
    const tab = record.indexOf(9);
    if (tab < 0) continue;
    let header: string;
    let name: string;
    try {
      header = decoder.decode(record.subarray(0, tab));
      name = decoder.decode(record.subarray(tab + 1));
    } catch {
      // 非 UTF-8 文件名无法安全、稳定地送进 JSON/UI，直接拒绝。
      continue;
    }
    const match = header.match(
      /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40,64})$/,
    );
    if (!match) continue;
    entries.push({
      mode: match[1],
      type: match[2] as TreeEntry["type"],
      oid: match[3],
      name,
    });
  }
  return entries;
}

function runGit(
  args: string[],
  options: {
    cwd?: string;
    deadline: number;
    maxBuffer?: number;
    /** 带令牌时由调用方给出的加固环境;缺省沿用宿主环境。 */
    env?: NodeJS.ProcessEnv;
  },
): Promise<Buffer> {
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(new DiscoveryTimeoutError("repository skill discovery timed out"));
  }
  return new Promise<Buffer>((resolveRun, rejectRun) => {
    execFile("git", args, {
      cwd: options.cwd,
      encoding: null,
      timeout: remaining,
      killSignal: "SIGKILL",
      maxBuffer: options.maxBuffer ?? MAX_TREE_BYTES,
      env: {
        ...(options.env ?? process.env),
        GIT_TERMINAL_PROMPT: "0",
        // 禁掉 ext 等外部 remote helper；只开放平台实际会用到的传输。
        GIT_ALLOW_PROTOCOL: "file:http:https:ssh:git",
      },
    }, (error, stdout) => {
      if (!error) {
        resolveRun(stdout);
        return;
      }
      const timedOut = (error as NodeJS.ErrnoException & { killed?: boolean }).killed
        || Date.now() >= options.deadline;
      rejectRun(timedOut
        ? new DiscoveryTimeoutError("repository skill discovery timed out")
        : error);
    });
  });
}

async function listTree(
  cwd: string,
  treeish: string,
  deadline: number,
): Promise<TreeEntry[]> {
  const output = await runGit(["ls-tree", "-z", treeish], {
    cwd,
    deadline,
    maxBuffer: MAX_TREE_BYTES,
  });
  return parseTree(output);
}

async function rootTree(
  cwd: string,
  revision: string,
  root: (typeof REPOSITORY_SKILL_ROOTS)[number],
  deadline: number,
): Promise<TreeEntry | undefined> {
  const output = await runGit(["ls-tree", "-z", revision, "--", root], {
    cwd,
    deadline,
    maxBuffer: 64 * 1024,
  });
  return parseTree(output).find((entry) => entry.name === root
    && entry.mode === "040000" && entry.type === "tree");
}

function markdownSummary(content: string, fallback: string): {
  title: string;
  description: string;
} {
  const normalized = content.replace(/^---\s*[\s\S]*?\n---\s*/m, "");
  const lines = normalized.split(/\r?\n/);
  const heading = lines.find((line) => /^#{1,3}\s+\S/.test(line.trim()))
    ?.replace(/^#{1,3}\s+/, "").trim();
  const paragraph = lines
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#")
      && !line.startsWith("<!--") && !line.startsWith("```")
      && !/^[-*+]\s/.test(line));
  const clean = (value: string, limit: number) => {
    const text = value.replace(/[`*_>#\[\]]/g, "").replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  };
  return {
    title: clean(heading || fallback.replace(/\.(?:md|mdx)$/i, ""), 80),
    description: clean(paragraph || "仓库随附的业务知识文档", 180),
  };
}

async function readBlob(
  cwd: string,
  entry: TreeEntry,
  deadline: number,
  maxBytes: number,
): Promise<Buffer | undefined> {
  if (entry.type !== "blob" || !/^100(?:644|755)$/.test(entry.mode)) {
    return undefined;
  }
  const sizeText = (await runGit(["cat-file", "-s", entry.oid], {
    cwd, deadline, maxBuffer: 4096,
  })).toString("utf-8").trim();
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) return undefined;
  const content = await runGit(["cat-file", "blob", entry.oid], {
    cwd, deadline, maxBuffer: maxBytes + 1024,
  });
  return content.length === size ? content : undefined;
}

async function discoverKnowledge(
  cwd: string,
  revision: string,
  repository: string,
  deadline: number,
): Promise<RepositoryKnowledgeDescriptor[]> {
  const rootEntries = await listTree(cwd, revision, deadline);
  const ruleNames = [
    "AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD",
  ];
  const rules: RepositoryKnowledgeDescriptor[] = [];
  let ruleText = "";
  const ruleEntry = ruleNames
    .map((name) => rootEntries.find((entry) => entry.name === name))
    .find(Boolean);
  if (ruleEntry) {
    const content = await readBlob(cwd, ruleEntry, deadline, MAX_KNOWLEDGE_BYTES);
    if (content) {
      ruleText = content.toString("utf-8");
      const summary = markdownSummary(ruleText, ruleEntry.name);
      const digest = sha256(content);
      rules.push({
        id: sha256([repository, revision, ruleEntry.name, digest].join("\0")),
        ...summary,
        relative_path: ruleEntry.name,
        kind: "rules",
        digest,
        bytes: content.length,
        selectable: false,
        recommended: true,
        auto_load: true,
        warning: "项目规则由 Pi 自动加载，无需手动选择",
      });
    }
  }

  const docsEntry = rootEntries.find((entry) => entry.name === "docs"
    && entry.mode === "040000" && entry.type === "tree");
  if (!docsEntry) return rules;
  const files: Array<{ path: string; entry: TreeEntry }> = [];
  const walk = async (tree: TreeEntry, prefix: string, depth: number): Promise<void> => {
    if (depth > MAX_KNOWLEDGE_DEPTH || files.length >= MAX_KNOWLEDGE_FILES) return;
    const children = (await listTree(cwd, tree.oid, deadline))
      .filter((entry) => safePathSegment(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (files.length >= MAX_KNOWLEDGE_FILES) break;
      const path = `${prefix}/${child.name}`;
      if (child.mode === "040000" && child.type === "tree") {
        await walk(child, path, depth + 1);
      } else if (child.type === "blob" && /^100(?:644|755)$/.test(child.mode)
          && /\.(?:md|mdx)$/i.test(child.name)) {
        files.push({ path, entry: child });
      }
    }
  };
  await walk(docsEntry, "docs", 0);

  const normalizedRules = ruleText.replace(/\\/g, "/");
  const documents: RepositoryKnowledgeDescriptor[] = [];
  for (const file of files) {
    const content = await readBlob(cwd, file.entry, deadline, MAX_KNOWLEDGE_BYTES);
    if (!content) continue;
    const text = content.toString("utf-8");
    const digest = sha256(content);
    const summary = markdownSummary(text, file.path.split("/").pop() ?? file.path);
    const recommended = normalizedRules.includes(file.path)
      || normalizedRules.includes(`./${file.path}`);
    documents.push({
      id: sha256([repository, revision, file.path, digest].join("\0")),
      ...summary,
      relative_path: file.path,
      kind: "document",
      digest,
      bytes: content.length,
      selectable: true,
      recommended,
      auto_load: false,
    });
  }
  return [...rules, ...documents];
}

function gitAuthArgs(credentialHelper: string | undefined): string[] {
  return credentialHelper
    ? ["-c", "credential.helper=", "-c", `credential.helper=${credentialHelper}`]
    : [];
}

/**
 * 在指定仓库版本发现可供 Pi 消费的 Skill 元数据。
 *
 * 发现失败是页面可展示的 catalog.error，不让一次仓库故障拖垮下单页。
 */
export async function discoverRepositorySkills(
  options: DiscoverRepositorySkillsOptions,
): Promise<RepositorySkillCatalog> {
  const displayRepository = cleanRepository(options.repository);
  const failed = (message: string): RepositorySkillCatalog => ({
    repository: displayRepository,
    revision: "",
    skills: [],
    knowledge: [],
    error: message,
  });
  if (!repositoryIsSafe(options.repository)) {
    return failed("仓库地址不安全，无法发现 Skill");
  }
  if (!baselineIsSafe(options.baseline)) {
    return failed("基线版本格式不合法，无法发现 Skill");
  }
  if (!helperIsSafe(options.credentialHelper)) {
    return failed("Git 凭据辅助程序格式不合法");
  }

  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.floor(options.timeoutMs!))
    : DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const temporaryRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const cloneDir = join(temporaryRoot, "repository.git");
  const parseDir = join(temporaryRoot, "parse");
  // 只有这两条真的带着个人令牌上网,加固环境跟着它们走;后面
  // ls-tree/cat-file 都在本地临时克隆上跑,不登记 helper。
  const authArgs = options.credentialHelper
    ? [...(options.credentialArgs ?? []), ...gitAuthArgs(options.credentialHelper)]
    : [];
  const authEnv = options.credentialHelper ? options.credentialEnv : undefined;
  let revision = "";
  try {
    await runGit([
      "-c", "core.hooksPath=/dev/null",
      ...authArgs,
      "clone", "--quiet", "--no-checkout", "--no-local", "--depth=1",
      "--", options.repository, cloneDir,
    ], { deadline, maxBuffer: 256 * 1024, env: authEnv });

    if (options.baseline) {
      await runGit([
        ...authArgs,
        "fetch", "--quiet", "--depth=1", "origin", options.baseline,
      ], { cwd: cloneDir, deadline, maxBuffer: 256 * 1024, env: authEnv });
      revision = (await runGit(
        ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
        { cwd: cloneDir, deadline, maxBuffer: 4096 },
      )).toString("utf-8").trim();
    } else {
      revision = (await runGit(
        ["rev-parse", "--verify", "HEAD^{commit}"],
        { cwd: cloneDir, deadline, maxBuffer: 4096 },
      )).toString("utf-8").trim();
    }
    if (!/^[0-9a-f]{40,64}$/.test(revision)) {
      throw new Error("invalid resolved revision");
    }

    const knowledge = await discoverKnowledge(
      cloneDir, revision, displayRepository, deadline);
    const candidates: Array<{
      root: (typeof REPOSITORY_SKILL_ROOTS)[number];
      directory: TreeEntry;
    }> = [];
    for (const root of REPOSITORY_SKILL_ROOTS) {
      const rootEntry = await rootTree(cloneDir, revision, root, deadline);
      if (!rootEntry) continue;
      const children = (await listTree(cloneDir, rootEntry.oid, deadline))
        .filter((entry) => entry.mode === "040000"
          && entry.type === "tree" && safePathSegment(entry.name))
        .sort((left, right) => left.name < right.name ? -1
          : left.name > right.name ? 1 : 0);
      for (const directory of children) {
        candidates.push({ root, directory });
      }
    }

    const skills: RepositorySkillDescriptor[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const { root, directory } = candidates[index];
      const skillFile = (await listTree(cloneDir, directory.oid, deadline))
        .find((entry) => entry.name === "SKILL.md");
      // 100644/100755 是普通 blob；120000 符号链接、160000 submodule
      // 以及 tree 一律不跟随。
      if (!skillFile || skillFile.type !== "blob"
          || !/^100(?:644|755)$/.test(skillFile.mode)) continue;
      const sizeText = (await runGit(["cat-file", "-s", skillFile.oid], {
        cwd: cloneDir,
        deadline,
        maxBuffer: 4096,
      })).toString("utf-8").trim();
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SKILL_BYTES) {
        continue;
      }
      const content = await runGit(["cat-file", "blob", skillFile.oid], {
        cwd: cloneDir,
        deadline,
        maxBuffer: MAX_SKILL_BYTES + 1024,
      });
      if (content.length !== size) continue;

      // Pi SDK 自己解析并验证 name / description /
      // disable-model-invocation；我们只负责安全地给它一份普通文件。
      const staged = join(parseDir, String(index), directory.name);
      mkdirSync(staged, { recursive: true });
      writeFileSync(join(staged, "SKILL.md"), content, { mode: 0o600 });
      const parsed = loadSkillsFromDir({ dir: staged, source: "repository" });
      if (parsed.skills.length !== 1 || parsed.diagnostics.length > 0) continue;
      const skill = parsed.skills[0];
      if (typeof skill.name !== "string" || typeof skill.description !== "string"
          || !skill.name || !skill.description.trim()) continue;

      const relativePath = `${root}/${directory.name}/SKILL.md`;
      const digest = sha256(content);
      const selectable = !skill.disableModelInvocation;
      skills.push({
        id: sha256([
          displayRepository,
          revision,
          relativePath,
          digest,
        ].join("\0")),
        name: skill.name,
        description: skill.description,
        relative_path: relativePath,
        source: root,
        digest,
        selectable,
        ...(!selectable ? {
          warning: "仓库已禁止模型自动调用此 Skill",
        } : {}),
      });
      if (skills.length >= MAX_SKILLS) break;
    }

    return { repository: displayRepository, revision, skills, knowledge };
  } catch (error) {
    return {
      repository: displayRepository,
      revision,
      skills: [],
      knowledge: [],
      error: error instanceof DiscoveryTimeoutError
        ? "仓内知识与 Skill 发现超时"
        : "仓库或基线不可访问，无法发现仓内知识与 Skill",
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
