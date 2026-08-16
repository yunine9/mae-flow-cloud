/**
 * 检视产物(只读旁路):把内核留在工作区里的检视材料列出来、读出来,
 * 让"决策"和"证据"能同屏——审批卡问"本地 Spec 确认吗",spec.md 就
 * 该在旁边,而不是让人跳到另一套界面里翻。
 *
 * 三条自律:
 * - **只读,不判定**。"哪一步该看哪份材料"是内核的语义(CLAUDE.md
 *   红线:连阶段映射都不许抄第二份),这里不猜;只按"最近修改"排序
 *   ——那是客观信号,不是判断。
 * - **白名单即边界**。能读的只有本模块自己扫出来的那些文件:name 先
 *   在集合里核对,再用集合里存的绝对路径去读,绝不拿用户输入拼路径
 *   (路径穿越不是 404 的一种,是攻击)。
 * - **fail-open**。目录不可读、git 不在、文件半路消失,都只让那一项
 *   缺席,返回空数组或 undefined,绝不抛错——旁路不许把页面拖垮。
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join, resolve, sep } from "node:path";

const WORK_DIR = ".mae-flow-work";
/** 单个产物最多回传这么多字节:一个巨型 diff 不能把页面拖死。 */
const MAX_BYTES = 512 * 1024;
const TRUNCATED_NOTE =
  "\n\n…(内容超过 512 KB,只回传前 512 KB;完整内容见工作区文件)";
/** Git 工作区差异的固定标识:它是"虚拟产物",不对应磁盘上某个文件。 */
export const DIFF_NAME = "未提交改动";

export interface ArtifactMeta {
  /** 稳定标识,也是 URL 里的取值:文档为 `<单号目录>/<文件名>`。 */
  name: string;
  /** 给人看的短名。 */
  label: string;
  kind: "doc" | "diff";
  bytes: number;
  modified_at: string;
}

export interface ArtifactContent extends ArtifactMeta {
  content: string;
  /** 触顶截断时为 true:页面要如实告诉用户"这不是全文"。 */
  truncated?: boolean;
}

interface DocEntry {
  meta: ArtifactMeta;
  /** 集合内部保存的绝对路径:读取只走这里,不由 name 拼。 */
  path: string;
}

/** 代码工作区:调用方给了就用;没给就在任务工作区下找带
 * `.mae-flow.json` 的那一层(host 模式的克隆目录)。找不到返回
 * undefined——没有内核现场不是错误,是流程还没走到 init。 */
export function resolveArtifactRoot(
  workspace: string,
  cwd?: string,
): string | undefined {
  if (cwd && existsSync(join(cwd, WORK_DIR))) return cwd;
  if (cwd && existsSync(join(cwd, ".mae-flow.json"))) return cwd;
  try {
    for (const name of readdirSync(workspace)) {
      const candidate = join(workspace, name);
      if (!statSync(candidate).isDirectory()) continue;
      if (existsSync(join(candidate, WORK_DIR))) return candidate;
      if (existsSync(join(candidate, ".mae-flow.json"))) return candidate;
    }
  } catch {
    // 工作区不可读:当作没有现场。
  }
  return undefined;
}

/** 扫单号目录下的 markdown。
 *
 * 怎么认单号目录:内核自己在里面放了 `.ticket-id` 标记,用它最稳
 * (不是我们发明的语义,是读它的标记)。一个都没有时退化成扫所有
 * 直接子目录——宁可多列几份,也好过页面空着。 */
function collectDocs(cwd: string): DocEntry[] {
  const workRoot = join(cwd, WORK_DIR);
  let dirs: string[] = [];
  try {
    dirs = readdirSync(workRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(workRoot, entry.name));
  } catch {
    return [];
  }
  const tickets = dirs.filter((dir) => existsSync(join(dir, ".ticket-id")));
  const docs: DocEntry[] = [];
  for (const dir of tickets.length ? tickets : dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((name) =>
        name.toLowerCase().endsWith(".md"));
    } catch {
      continue;
    }
    for (const fileName of names) {
      const path = join(dir, fileName);
      try {
        const info = statSync(path);
        if (!info.isFile()) continue;
        docs.push({
          path,
          meta: {
            name: `${basename(dir)}/${fileName}`,
            label: fileName,
            kind: "doc",
            bytes: info.size,
            modified_at: info.mtime.toISOString(),
          },
        });
      } catch {
        // 文件在扫描途中消失:跳过这一项,别的照列。
      }
    }
  }
  return docs;
}

/** git 子进程:失败一律返回 undefined(不是 git 仓、git 不在、超时)。 */
function git(cwd: string, args: string[]): string | undefined {
  try {
    const run = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (run.error || run.status !== 0) return undefined;
    return run.stdout ?? "";
  } catch {
    return undefined;
  }
}

/** 未跟踪文件相对于 /dev/null 的统一 diff。
 * `git diff --no-index` 发现差异时按约定返回 1,这里的 1 是成功结果,
 * 不是执行失败。二进制文件也会由 git 给出如实提示。 */
function untrackedDiff(cwd: string, path: string): string | undefined {
  try {
    const run = spawnSync(
      "git",
      ["-C", cwd, "diff", "--no-index", "--", "/dev/null", path],
      {
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (run.error || (run.status !== 0 && run.status !== 1)) return undefined;
    return (run.stdout ?? "").trim();
  } catch {
    return undefined;
  }
}

/** porcelain 行 → 改动路径(重命名行取箭头右边的新名字)。 */
function changedPaths(status: string): string[] {
  return status.split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((path) => {
      const arrow = path.split(" -> ");
      return (arrow[1] ?? arrow[0]).replace(/^"|"$/g, "");
    });
}

type ChangeOrigin = "committed" | "committed_working" | "staged"
  | "staged_working" | "unstaged";

const ORIGIN_HEADING: Record<ChangeOrigin, string> = {
  committed: "已提交(committed)",
  committed_working: "已提交后又修改(committed-working)",
  staged: "已暂存(staged)",
  staged_working: "已暂存后又修改(staged-working)",
  unstaged: "未暂存(unstaged)",
};

/** 内核在建分支时记录的 HEAD 就是任务基线；旧现场没有该字段时，
 * 再退到配置的基线分支 / origin/HEAD。拿不到就保留旧的工作区口径。 */
function taskBaseline(cwd: string): string | undefined {
  try {
    const state = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf-8"));
    const recorded = [
      state?.step_heads?.branch_create,
      state?.step_heads?.workflow_select,
    ].find((value) => typeof value === "string" && value.trim());
    if (recorded
        && git(cwd, ["cat-file", "-e", `${recorded}^{commit}`]) !== undefined) {
      return String(recorded);
    }
    const branch = String(state?.config?.["基线分支"] ?? "").trim();
    if (branch) {
      for (const ref of [branch, `origin/${branch}`]) {
        const base = git(cwd, ["merge-base", "HEAD", ref])?.trim();
        if (base) return base;
      }
    }
  } catch {
    // 旧现场或半写 JSON:继续尝试 Git 自己的远端默认分支。
  }
  return git(cwd, ["merge-base", "HEAD", "origin/HEAD"])?.trim()
    || undefined;
}

function diffChunks(text: string): Array<{ path: string; text: string }> {
  return text.split(/(?=^diff --git )/m).map((chunk) => chunk.trim())
    .filter(Boolean)
    .flatMap((chunk) => {
      const header = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
      return header ? [{ path: header[2], text: chunk }] : [];
    });
}

function statusEntries(status: string): Map<string, { x: string; y: string }> {
  const entries = new Map<string, { x: string; y: string }>();
  for (const line of status.split("\n")) {
    if (line.length < 4 || line.startsWith("??")) continue;
    const arrow = line.slice(3).trim().split(" -> ");
    const path = (arrow[1] ?? arrow[0]).replace(/^"|"$/g, "");
    if (path) entries.set(path, { x: line[0], y: line[1] });
  }
  return entries;
}

function originOf(
  path: string,
  committed: Set<string>,
  statuses: Map<string, { x: string; y: string }>,
): ChangeOrigin {
  const status = statuses.get(path);
  const indexChanged = !!status && status.x !== " ";
  const worktreeChanged = !!status && status.y !== " ";
  if (committed.has(path) && (indexChanged || worktreeChanged)) {
    return "committed_working";
  }
  if (indexChanged && worktreeChanged) return "staged_working";
  if (indexChanged) return "staged";
  if (worktreeChanged) return "unstaged";
  return "committed";
}

/** 本任务变更快照:任务基线到当前工作区,包含已提交、未提交与未跟踪。
 * 基线不可用时退化为原有的工作区状态,旁路不因旧现场失效。 */
function collectDiff(
  cwd: string,
): { text: string; changed: string[] } | undefined {
  // 展开未跟踪目录到文件级,前端才能把其中的文档/测试/配置正确分类。
  const status = git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  if (status === undefined) return undefined;
  const worktreeChanged = changedPaths(status);
  // 把完整上下文带回前端，再由审阅器默认折叠未改动区。只取 Git 默认
  // 的三行上下文会让“展开全文”永远缺材料，也无法复现内核看板的能力。
  const fullContext = "--unified=999999";
  const untracked = status.split("\n")
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  const baseline = taskBaseline(cwd);
  const sections: string[] = [];
  let trackedPaths: string[] = [];
  if (baseline) {
    const aggregate = (git(cwd, ["diff", fullContext, baseline, "--"]) ?? "").trim();
    const committed = new Set((git(cwd,
      ["diff", "--name-only", baseline, "HEAD", "--"]) ?? "")
      .split("\n").filter(Boolean));
    const statuses = statusEntries(status);
    const grouped = new Map<ChangeOrigin, string[]>();
    for (const chunk of diffChunks(aggregate)) {
      trackedPaths.push(chunk.path);
      const origin = originOf(chunk.path, committed, statuses);
      grouped.set(origin, [...(grouped.get(origin) ?? []), chunk.text]);
    }
    for (const origin of ["committed", "committed_working", "staged",
      "staged_working", "unstaged"] as ChangeOrigin[]) {
      const chunks = grouped.get(origin);
      if (chunks?.length) {
        sections.push(`## ${ORIGIN_HEADING[origin]}\n\n${chunks.join("\n\n")}`);
      }
    }
  } else {
    const staged = (git(cwd, ["diff", "--cached", fullContext]) ?? "").trim();
    const unstaged = (git(cwd, ["diff", fullContext]) ?? "").trim();
    if (staged) sections.push(`## ${ORIGIN_HEADING.staged}\n\n${staged}`);
    if (unstaged) sections.push(`## ${ORIGIN_HEADING.unstaged}\n\n${unstaged}`);
    trackedPaths = worktreeChanged.filter((path) => !untracked.includes(path));
  }
  if (untracked.length) {
    const snapshots = untracked.map((path) =>
      untrackedDiff(cwd, path) || `?? ${path}`);
    sections.push(`## 未跟踪(untracked)\n\n${snapshots.join("\n\n")}`);
  }
  const changed = Array.from(new Set([...trackedPaths, ...untracked]));
  if (!sections.length) {
    return { text: "本任务暂无代码变更。", changed };
  }
  return { text: sections.join("\n\n"), changed };
}

/** 本任务变更的元信息。时间取"改动文件里最新的那个 mtime":
 * 工作区干净时退回目录时间,免得一个空 diff 长期霸占列表首位。 */
function diffMeta(cwd: string): ArtifactMeta | undefined {
  const diff = collectDiff(cwd);
  if (!diff) return undefined;
  let newest = 0;
  for (const path of diff.changed) {
    try {
      newest = Math.max(newest, statSync(join(cwd, path)).mtimeMs);
    } catch {
      // 改动项可能是已删除文件:取不到时间就跳过。
    }
  }
  if (!newest) {
    try {
      newest = statSync(cwd).mtimeMs;
    } catch {
      newest = 0;
    }
  }
  return {
    name: DIFF_NAME,
    label: "本任务变更",
    kind: "diff",
    bytes: Buffer.byteLength(diff.text, "utf-8"),
    modified_at: new Date(newest).toISOString(),
  };
}

/** 截断到字节上限。按字节切会把 UTF-8 多字节字符切一半,
 * 末尾的替换符直接抹掉——宁可少一个字,不给用户看乱码。 */
function cap(text: string): { content: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf-8") <= MAX_BYTES) {
    return { content: text, truncated: false };
  }
  const clipped = Buffer.from(text, "utf-8")
    .subarray(0, MAX_BYTES)
    .toString("utf-8")
    .replace(/�+$/, "");
  return { content: clipped + TRUNCATED_NOTE, truncated: true };
}

function readCapped(path: string): { content: string; truncated: boolean } | undefined {
  try {
    const info = statSync(path);
    if (info.size <= MAX_BYTES) {
      return { content: readFileSync(path, "utf-8"), truncated: false };
    }
    const handle = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(MAX_BYTES);
      const read = readSync(handle, buffer, 0, MAX_BYTES, 0);
      const content = buffer.subarray(0, read).toString("utf-8")
        .replace(/�+$/, "");
      return { content: content + TRUNCATED_NOTE, truncated: true };
    } finally {
      closeSync(handle);
    }
  } catch {
    return undefined;
  }
}

/**
 * 列出可检视的产物,最近修改的在前。
 * 任何一路出问题只让那一路缺席,永远返回数组。
 */
export function listArtifacts(cwd: string): ArtifactMeta[] {
  const items: ArtifactMeta[] = [];
  try {
    items.push(...collectDocs(cwd).map((doc) => doc.meta));
  } catch {
    // 文档一路塌了,还有 diff 一路。
  }
  try {
    const diff = diffMeta(cwd);
    if (diff) items.push(diff);
  } catch {
    // git 一路塌了,文档照出。
  }
  // ISO 串的字典序即时间序,倒序 = 最近修改在前。
  return items.sort((left, right) =>
    right.modified_at.localeCompare(left.modified_at));
}

/**
 * 读一份产物。name 必须出现在 listArtifacts 的结果里,否则一律
 * undefined——白名单是这里唯一的安全边界。
 */
export function readArtifact(
  cwd: string,
  name: string,
): ArtifactContent | undefined {
  const wanted = String(name ?? "").trim();
  if (!wanted) return undefined;
  try {
    if (wanted === DIFF_NAME) {
      const meta = diffMeta(cwd);
      const diff = collectDiff(cwd);
      if (!meta || !diff) return undefined;
      const { content, truncated } = cap(diff.text);
      return { ...meta, content, truncated };
    }
    const doc = collectDocs(cwd).find((entry) => entry.meta.name === wanted);
    if (!doc) return undefined;
    // 双保险:即便集合本身出了岔子,路径也必须仍在 .mae-flow-work 之下。
    const root = resolve(join(cwd, WORK_DIR));
    const target = resolve(doc.path);
    if (target !== root && !target.startsWith(root + sep)) return undefined;
    const read = readCapped(doc.path);
    if (!read) return undefined;
    return { ...doc.meta, content: read.content, truncated: read.truncated };
  } catch {
    return undefined;
  }
}
