/**
 * 用户为本单明确选择的业务知识运行时快照。
 *
 * 业务仓在 Agent 眼里是不可信输入；知识正文会在会话创建前进入系统
 * 上下文，因此必须先做路径、软链、体积与扫描 digest 校验。校验失败只
 * 跳过该文档并告警，不参与 Mae-Flow 状态迁移或质量门禁。
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

const MAX_SELECTED = 12;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;

export interface SelectedRepositoryKnowledge {
  id: string;
  repository: string;
  revision: string;
  title: string;
  description: string;
  relative_path: string;
  kind: "document";
  digest: string;
  bytes: number;
}

export interface RepositoryKnowledgeBinding {
  repository: string;
  workspace: string;
}

export interface MaterializedKnowledgeEntry {
  id: string;
  repository: string;
  title: string;
  description: string;
  relative_path: string;
  digest: string;
  path: string;
}

export interface MaterializedRepositoryKnowledge {
  entries: MaterializedKnowledgeEntry[];
  warnings: string[];
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel));
}

function assertNoSymlinkPath(root: string, target: string): void {
  if (!contained(root, target)) throw new Error("知识文档路径越出仓库");
  const rel = relative(root, target);
  let cursor = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error("知识文档路径包含软链接");
  }
  if (!contained(realpathSync(root), realpathSync(target))) {
    throw new Error("知识文档真实路径越出仓库");
  }
}

export function validRepositoryKnowledgePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0")) {
    return false;
  }
  if (!path.startsWith("docs/") || !/\.(?:md|mdx)$/i.test(path)) return false;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

function snapshotKey(item: SelectedRepositoryKnowledge): string {
  return sha256(`${item.repository}\0${item.relative_path}\0${item.id}`).slice(0, 20);
}

/** 选择只是“重点知识上下文”，不是完成条件：坏一篇跳过一篇，任务照跑。 */
export function materializeRepositoryKnowledge(options: {
  selected?: SelectedRepositoryKnowledge[];
  bindings: RepositoryKnowledgeBinding[];
  snapshotRoot: string;
}): MaterializedRepositoryKnowledge {
  const warnings: string[] = [];
  const entries: MaterializedKnowledgeEntry[] = [];
  const selected = options.selected ?? [];
  if (selected.length > MAX_SELECTED) {
    warnings.push(`最多加载 ${MAX_SELECTED} 篇重点知识，其余已跳过`);
  }
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const item of selected.slice(0, MAX_SELECTED)) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if (!validRepositoryKnowledgePath(item.relative_path)) {
      warnings.push(`${item.title}: 只支持 docs 下的 Markdown 文档`);
      continue;
    }
    const binding = options.bindings.find(
      (candidate) => candidate.repository === item.repository);
    if (!binding) {
      warnings.push(`${item.title}: 不属于当前仓库，已跳过`);
      continue;
    }
    const source = join(binding.workspace, ...item.relative_path.split("/"));
    const destination = join(options.snapshotRoot, `${snapshotKey(item)}.md`);
    const metadata = `${destination}.json`;
    try {
      assertNoSymlinkPath(binding.workspace, source);
      const stat = lstatSync(source);
      if (!stat.isFile()) throw new Error("不是普通文件");
      if (stat.size > MAX_FILE_BYTES) throw new Error("超过 128 KiB");
      if (totalBytes + stat.size > MAX_TOTAL_BYTES) {
        warnings.push(`${item.title}: 本单重点知识总量超过 256 KiB，已跳过`);
        continue;
      }
      const content = readFileSync(source);
      const digest = sha256(content);
      if (item.digest && digest !== item.digest) {
        warnings.push(`${item.title}: 仓库内容与选择时版本不一致，已跳过`);
        continue;
      }
      mkdirSync(options.snapshotRoot, { recursive: true });
      rmSync(destination, { force: true });
      rmSync(metadata, { force: true });
      copyFileSync(source, destination);
      writeFileSync(metadata, JSON.stringify({
        id: item.id,
        repository: item.repository,
        relative_path: item.relative_path,
        digest,
      }), { mode: 0o444 });
      chmodSync(destination, 0o444);
      totalBytes += content.length;
      entries.push({
        id: item.id,
        repository: item.repository,
        title: item.title,
        description: item.description,
        relative_path: item.relative_path,
        digest,
        path: destination,
      });
    } catch (error) {
      rmSync(destination, { force: true });
      rmSync(metadata, { force: true });
      warnings.push(`${item.title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { entries, warnings };
}
