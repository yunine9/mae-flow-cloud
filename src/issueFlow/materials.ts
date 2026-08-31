/**
 * 问题会话工作区材料(交付材料页签的数据面)。
 *
 * 边界纪律(与 readAnalysisFile 同款,双保险):
 * - 一切相对路径先 join 再 resolve,解析结果必须仍落在会话工作区内,
 *   越界一律拒绝——path 来自浏览器查询串,不可信。
 * - "快速修改"只放开 repo/ 内的已有文件:.git 与会话元数据
 *   (issue.json/events.jsonl/…)是宿主账本,永不可写。
 * - git 只读视图走 safeGit(仓库 clone 时 repo_url 来自用户输入,git
 *   配置里可能埋 external diff/credential helper,不能裸跑 git)。
 * - 全部旁路 fail-open:材料生成失败返回空态,不拖垮会话。
 */

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep, basename } from "node:path";
import { createSafeGitView } from "../safeGit.ts";
import { issueRepoWorkspaces, type IssueSessionState } from "./state.ts";

export interface WorkspaceChange {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
}

export interface MaterialFileMeta {
  name: string;
  size: number;
  mtime: string;
}

export interface ManualEditRecord {
  ts: string;
  path: string;
  size: number;
}

const READ_CAP_BYTES = 512 * 1024;
const WRITE_CAP_BYTES = 2 * 1024 * 1024;
const TAIL_BYTES = 512 * 1024;

/** 相对路径 → 工作区内绝对路径;越界/绝对路径/含 .. 一律 undefined。 */
function insideRoot(root: string, rel: string): string | undefined {
  if (!rel || resolve(rel) === rel) return undefined;
  const abs = resolve(join(root, rel));
  const boundary = resolve(root);
  if (abs !== boundary && !abs.startsWith(boundary + sep)) return undefined;
  return abs;
}

/** 读文件前 max 字节(超长截断)。 */
function readHead(path: string, max: number): string {
  const buffer = Buffer.alloc(max);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buffer, 0, max, 0);
    return buffer.subarray(0, read).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

/** 读文件末尾 max 字节(日志排障最关心"最后发生了什么")。 */
function readTail(path: string, max: number): string {
  const size = statSync(path).size;
  const buffer = Buffer.alloc(max);
  const fd = openSync(path, "r");
  try {
    const read = readSync(fd, buffer, 0, max, Math.max(0, size - max));
    return buffer.subarray(0, read).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

function gitIn(repoDir: string, env: NodeJS.ProcessEnv, args: string[]): string {
  const run = spawnSync("git", args, {
    cwd: repoDir,
    env,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return run.status === 0 ? String(run.stdout ?? "") : "";
}

/** 材料专用的只读 git:优先 safeGit 视图(仓库配置零信任);Windows
 * 无符号链接权限时 safeGit 起不来,降级普通 git(禁 pager)。降级的
 * 残余风险(repo 本地配置可挂 diff driver)与"AI 会话本就能在该工作区
 * 跑任意 bash"同权,材料页签没有放大它——任务侧内核闸不受影响。 */
function gitRead(repoDir: string, args: string[]): string {
  let view: ReturnType<typeof createSafeGitView> | undefined;
  try {
    view = createSafeGitView(repoDir);
    return gitIn(repoDir, view.environment(), args);
  } catch {
    return gitIn(repoDir, {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
    }, ["--no-pager", ...args]);
  } finally {
    view?.cleanup();
  }
}

/** 工作区变更清单:tracked 改动(diff HEAD)+ 未跟踪新文件。 */
export function listWorkspaceChanges(repoDir: string): WorkspaceChange[] {
  if (!existsSync(join(repoDir, ".git"))) return [];
  try {
    const rows = gitRead(repoDir, ["status", "--porcelain=v1", "-uall"])
      .split("\n").filter(Boolean);
    const statByName = new Map<string, { additions?: number; deletions?: number }>();
    for (const line of gitRead(repoDir, ["diff", "HEAD", "--numstat"])
      .split("\n")) {
      if (!line.trim()) continue;
      const [add, del, ...rest] = line.split("\t");
      // 重命名行形如 "a\tb\told => new",取尾段主干对齐 status 输出。
      const name = (rest.join("\t").split(" => ").at(-1) ?? "").trim();
      if (!name) continue;
      statByName.set(name, {
        ...(add === "-" ? {} : { additions: Number(add) }),
        ...(del === "-" ? {} : { deletions: Number(del) }),
      });
    }
    return rows.map((row) => {
      const status = row.slice(0, 2).trim() || "M";
      const path = row.slice(3).replace(/^"|"$/g, "");
      const stat = statByName.get(path);
      return {
        path,
        status,
        ...(stat?.additions !== undefined ? { additions: stat.additions } : {}),
        ...(stat?.deletions !== undefined ? { deletions: stat.deletions } : {}),
      };
    });
  } catch {
    // git 视图起不来(坏配置/竞态):给空清单,fail-open 不拖垮页面。
    return [];
  }
}

/** 聚合 diff(对 HEAD,未跟踪新文件补全文 diff)——对齐任务侧"服务端
 * 只出一份聚合 diff"的形态,前端交给 GitDiff 渲染文件树。 */
export function workspaceDiffAll(repoDir: string): string {
  if (!existsSync(join(repoDir, ".git"))) return "";
  const parts: string[] = [];
  const tracked = gitRead(repoDir, ["diff", "HEAD"]);
  if (tracked.trim()) parts.push(tracked.trim());
  const status = gitRead(repoDir, ["status", "--porcelain=v1", "-uall"]);
  for (const row of status.split("\n").filter(Boolean)) {
    if (!row.slice(0, 2).includes("?")) continue;
    const rel = row.slice(3).replace(/^"|"$/g, "");
    const abs = insideRoot(repoDir, rel);
    if (!abs || !existsSync(abs) || !statSync(abs).isFile()) continue;
    try {
      const body = readFileSync(abs, "utf-8")
        .split("\n").map((line) => `+${line}`).join("\n");
      parts.push(`diff --git a/${rel} b/${rel}\nnew file mode 100644\n`
        + `--- /dev/null\n+++ b/${rel}\n${body}`);
    } catch {
      // 二进制等读不了的文件跳过,不拖垮整份聚合 diff。
    }
  }
  return parts.join("\n").slice(0, READ_CAP_BYTES);
}

/** 单文件 diff(对 HEAD;新文件给全文 + 前缀)。 */
export function workspaceFileDiff(repoDir: string, rel: string): string {
  const abs = insideRoot(repoDir, rel);
  if (!abs || rel.split(/[\\/]/).includes(".git")) {
    throw new Error("路径越界");
  }
  const diff = gitRead(repoDir, ["diff", "HEAD", "--", rel]);
  if (diff.trim()) return diff.slice(0, READ_CAP_BYTES);
  if (existsSync(abs)) {
    // HEAD 里没有的(新文件):diff 为空,给带 + 前缀的全文冒充新文件 diff。
    const body = readFileSync(abs, "utf-8")
      .split("\n").map((line) => `+${line}`).join("\n");
    return `--- /dev/null\n+++ b/${rel}\n${body.slice(0, READ_CAP_BYTES)}`;
  }
  return "(文件已删除,仅剩删除记录)";
}

/** 读工作区文件(编辑器回填)。 */
export function readWorkspaceFile(
  repoDir: string,
  rel: string,
): { content: string; truncated: boolean } {
  const abs = insideRoot(repoDir, rel);
  if (!abs) throw new Error("路径越界或文件不在代码仓内");
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new Error("文件不存在");
  }
  if (resolve(abs).startsWith(resolve(join(repoDir, ".git")))) {
    throw new Error(".git 内部不可读写");
  }
  if (statSync(abs).size > READ_CAP_BYTES) {
    return { content: readHead(abs, READ_CAP_BYTES), truncated: true };
  }
  return { content: readFileSync(abs, "utf-8"), truncated: false };
}

/** 快速修改唯一写口:仅 repo/ 内已有文件,.git 不可碰。 */
export function writeWorkspaceFile(
  repoDir: string,
  rel: string,
  content: string,
): { ok: true; size: number } {
  const abs = insideRoot(repoDir, rel);
  if (!abs) throw new Error("路径越界");
  const repoBoundary = resolve(repoDir) + sep;
  if (!abs.startsWith(repoBoundary)) {
    throw new Error("快速修改只开放代码仓内文件");
  }
  if (abs.startsWith(resolve(join(repoDir, ".git")))) {
    throw new Error(".git 内部不可读写");
  }
  if (!existsSync(abs)) throw new Error("只允许修改已有文件,新建文件请交给 AI");
  if (statSync(abs).isDirectory()) throw new Error("目标是目录");
  if (Buffer.byteLength(content, "utf-8") > WRITE_CAP_BYTES) {
    throw new Error("文件超过 2MB,请拆分后修改");
  }
  writeFileSync(abs, content, "utf-8");
  return { ok: true, size: Buffer.byteLength(content, "utf-8") };
}

/** 人工修改台账(会话私有文件,与需求侧语义事件账完全无关)。 */
export function recordManualEdit(root: string, rel: string, size: number): void {
  const row: ManualEditRecord = {
    ts: new Date().toISOString(),
    path: rel,
    size,
  };
  appendFileSync(join(root, "manual-edits.jsonl"),
    JSON.stringify(row) + "\n", "utf-8");
}

export function listManualEdits(root: string): ManualEditRecord[] {
  const path = join(root, "manual-edits.jsonl");
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8").split("\n")
      .filter(Boolean).map((line) => JSON.parse(line) as ManualEditRecord)
      .slice(-100);
  } catch {
    return [];
  }
}

/** local-logs/ 目录清单(新→旧)。 */
export function listLogs(root: string): MaterialFileMeta[] {
  const dir = join(root, "local-logs");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .map((name) => {
        const abs = join(dir, name);
        const info = statSync(abs);
        return { name, size: info.size, mtime: info.mtime.toISOString() };
      })
      .filter((item) => item.size > 0)
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch {
    return [];
  }
}

/** 读单份日志(basename 防穿越,超长读尾部)。 */
export function readLog(
  root: string,
  name: string,
): { content: string; truncated: boolean } {
  const abs = join(root, "local-logs", basename(name));
  if (!existsSync(abs)) throw new Error("日志不存在");
  if (statSync(abs).size > READ_CAP_BYTES) {
    return { content: readTail(abs, READ_CAP_BYTES), truncated: true };
  }
  return { content: readFileSync(abs, "utf-8"), truncated: false };
}

/** 原始事件流尾随(现场页签):只读尾窗,解析不动的行跳过。 */
export function recentEvents(
  root: string,
  limit = 200,
): Array<Record<string, unknown>> {
  const path = join(root, "events.jsonl");
  if (!existsSync(path)) return [];
  let text = statSync(path).size <= TAIL_BYTES
    ? readFileSync(path, "utf-8")
    : readTail(path, TAIL_BYTES);
  if (text.length >= TAIL_BYTES) {
    // 尾窗第一行多半是残行,弃掉。
    text = text.slice(text.indexOf("\n") + 1);
  }
  text = text.trim();
  if (!text) return [];
  return text.split("\n")
    .map((line) => {
      try { return JSON.parse(line) as Record<string, unknown>; }
      catch { return undefined; }
    })
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .slice(-limit);
}

// ---- 会话级材料(/issues/:id/materials 路由直连的数据面;收窄票 #7
// 把 service 上的 require+路由+委托三行透传挪到这里,服务不再转手) ----

/** 多仓材料聚合的公共底座:repo/ 下每个已克隆仓 → (仓名, 目录)。 */
function materialRepos(
  state: IssueSessionState,
  root: string,
): Array<{ name: string; dir: string }> {
  return issueRepoWorkspaces(state, root)
    .filter((repo) => existsSync(join(repo.dir, ".git")))
    .map((repo) => ({
      name: repo.dir.split(/[\\/]/).at(-1) ?? "repo",
      dir: repo.dir,
    }));
}

/** 路径路由:rel 首段是仓名(repo/<仓名>/ 的平铺约定);对不上时
 * 兜底首仓(老路径/手工输入),保证读写不因前缀缺席而砸。 */
function routeMaterialPath(
  state: IssueSessionState,
  root: string,
  rel: string,
): { repo: { name: string; dir: string }; rel: string } | undefined {
  const repos = materialRepos(state, root);
  if (!repos.length) return undefined;
  const head = rel.split(/[\\/]/)[0];
  const match = repos.find((repo) => repo.name === head);
  if (match) return { repo: match, rel: rel.slice(head.length + 1) };
  return { repo: repos[0], rel };
}

/** 材料清单:变更按仓聚合,路径带 <仓名>/ 前缀(与 routeMaterialPath
 * 对得上)。 */
export function listMaterials(state: IssueSessionState, root: string) {
  const changes = materialRepos(state, root).flatMap((repo) =>
    listWorkspaceChanges(repo.dir)
      .map((change) => ({ ...change, path: `${repo.name}/${change.path}` })));
  return {
    ticket: state.ticket,
    pushes: state.pushes ?? [],
    mrs: state.mrs ?? [],
    changes,
    logs: listLogs(root),
    manual_edits: listManualEdits(root),
  };
}

/** 会话内读工作区文件(先按仓名路由,再进单仓读)。 */
export function readSessionWorkspaceFile(
  state: IssueSessionState,
  root: string,
  rel: string,
): { content: string; truncated: boolean } {
  const routed = routeMaterialPath(state, root, rel);
  if (!routed) throw new Error("会话还没有已克隆的代码仓");
  return readWorkspaceFile(routed.repo.dir, routed.rel);
}

/** 快速修改(会话级):路由到仓 → 写文件 → 入人工台账,写与账不分家。
 * 控制台留痕归路由层(它知道会话号与日志口径),台账(manual-edits
 * .jsonl)在这里——这是账本,不是日志。 */
export function saveSessionWorkspaceFile(
  state: IssueSessionState,
  root: string,
  rel: string,
  content: string,
): { ok: true; size: number } {
  const routed = routeMaterialPath(state, root, rel);
  if (!routed) throw new Error("会话还没有已克隆的代码仓");
  const result = writeWorkspaceFile(routed.repo.dir, routed.rel, content);
  recordManualEdit(root, rel, result.size);
  return result;
}

/** 单文件 diff(会话级,对 HEAD)。 */
export function sessionWorkspaceFileDiff(
  state: IssueSessionState,
  root: string,
  rel: string,
): string {
  const routed = routeMaterialPath(state, root, rel);
  if (!routed) throw new Error("会话还没有已克隆的代码仓");
  return workspaceFileDiff(routed.repo.dir, routed.rel);
}

/** 聚合 diff(会话级):按仓分段,段间加"仓库"分隔行,前端 diff 视图
 * 按元信息行呈现。 */
export function sessionWorkspaceDiffAll(
  state: IssueSessionState,
  root: string,
): string {
  const parts = materialRepos(state, root)
    .map((repo) => ({ name: repo.name, diff: workspaceDiffAll(repo.dir) }))
    .filter((part) => part.diff.trim());
  if (!parts.length) return "";
  return parts.map((part) =>
    `===== 仓库 ${part.name} =====\n${part.diff}`).join("\n\n");
}

/** 单仓 diff(会话级,#32):?repo= 服务端切片,逐仓审阅不再靠前端
 * 解析聚合里的「===== 仓库 =====」标记。仓名按 materialRepos 的取名
 * 匹配(与变更清单的 <仓名>/ 前缀同源);对不上不兜底——兜底到首仓
 * 会让"看 A 仓"静默变成"看 B 仓",宁可让调用方拿到明确的错。 */
export function sessionWorkspaceRepoDiff(
  state: IssueSessionState,
  root: string,
  repo: string,
): string {
  const match = materialRepos(state, root).find((item) => item.name === repo);
  if (!match) throw new Error(`仓 ${repo} 不在本会话的关联仓里`);
  return workspaceDiffAll(match.dir);
}
