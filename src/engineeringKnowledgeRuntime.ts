/** 已发布团队工程知识的任务快照与运行时投影。 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  knowledgeMatchesTask,
  type KnowledgeForm,
} from "./knowledgeAssetModel.ts";
import {
  listKnowledgeCandidates,
  type KnowledgeCandidateRecord,
} from "./knowledgeCandidates.ts";

const SNAPSHOT_DIR = "engineering-knowledge-snapshot";
const RUNTIME_DIR = ".mae-flow-work/team-engineering-knowledge";
const MAX_ASSETS = 40;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

export interface SelectedEngineeringKnowledge {
  id: string;
  title: string;
  summary: string;
  when_to_use: string;
  form: Exclude<KnowledgeForm, "skill">;
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
  digest: string;
  bytes: number;
  snapshot_path: string;
}

export interface MaterializedEngineeringKnowledgeEntry
  extends Omit<SelectedEngineeringKnowledge, "snapshot_path"> {
  relative_path: string;
  path: string;
}

export interface MaterializedEngineeringKnowledge {
  entries: MaterializedEngineeringKnowledgeEntry[];
  warnings: string[];
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel));
}

function safe(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (!contained(resolve(root), absolute)) throw new Error("知识路径越出任务现场");
  return absolute;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function publishedEngineeringKnowledge(
  dataDir: string,
): KnowledgeCandidateRecord[] {
  return listKnowledgeCandidates(dataDir).filter((item) =>
    item.status === "published" && item.nature === "engineering"
    && item.form !== "skill");
}

export function snapshotEngineeringKnowledge(options: {
  dataDir: string;
  taskWorkspace: string;
  repositories: string[];
  technologies: string[];
  businessModuleIds: string[];
  selectedIds?: string[];
}): SelectedEngineeringKnowledge[] {
  const selected = options.selectedIds === undefined ? undefined
    : new Set(options.selectedIds);
  const matched = publishedEngineeringKnowledge(options.dataDir)
    .filter((item) => knowledgeMatchesTask(item, options)
      && (!selected || selected.has(item.id)))
    .slice(0, MAX_ASSETS);
  const result: SelectedEngineeringKnowledge[] = [];
  let totalBytes = 0;
  for (const item of matched) {
    if (totalBytes + item.bytes > MAX_TOTAL_BYTES) break;
    const snapshotPath = `${SNAPSHOT_DIR}/${item.id}.md`;
    const destination = safe(options.taskWorkspace, snapshotPath);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o750 });
    writeFileSync(destination, item.content, { encoding: "utf-8", mode: 0o440 });
    chmodSync(destination, 0o440);
    totalBytes += item.bytes;
    result.push({
      id: item.id,
      title: item.title,
      summary: item.summary,
      when_to_use: item.when_to_use,
      form: item.form as Exclude<KnowledgeForm, "skill">,
      business_module_ids: [...item.business_module_ids],
      repositories: [...item.repositories],
      technologies: [...item.technologies],
      digest: item.digest,
      bytes: item.bytes,
      snapshot_path: snapshotPath,
    });
  }
  return result;
}

export function copyEngineeringKnowledgeSnapshots(options: {
  selected?: SelectedEngineeringKnowledge[];
  sourceTaskWorkspace: string;
  targetTaskWorkspace: string;
  repository?: string;
}): SelectedEngineeringKnowledge[] {
  return (options.selected ?? []).filter((item) => !options.repository
    || !item.repositories.length || item.repositories.includes(options.repository))
    .flatMap((item) => {
      try {
        const source = safe(options.sourceTaskWorkspace, item.snapshot_path);
        const content = readFileSync(source);
        if (content.byteLength !== item.bytes || sha256(content) !== item.digest) {
          return [];
        }
        const destination = safe(options.targetTaskWorkspace, item.snapshot_path);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o750 });
        writeFileSync(destination, content, { mode: 0o440 });
        chmodSync(destination, 0o440);
        return [{ ...item }];
      } catch { return []; }
    });
}

/** 坏快照逐项跳过，工程知识永远不能卡任务。 */
export function materializeEngineeringKnowledge(options: {
  selected?: SelectedEngineeringKnowledge[];
  taskWorkspace: string;
  runtimeWorkspace: string;
}): MaterializedEngineeringKnowledge {
  const root = resolve(options.runtimeWorkspace, RUNTIME_DIR);
  const entries: MaterializedEngineeringKnowledgeEntry[] = [];
  const warnings: string[] = [];
  try {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true, mode: 0o750 });
  } catch (error) {
    return { entries, warnings: [`团队工程知识目录准备失败：${String(error)}`] };
  }
  for (const item of options.selected ?? []) {
    try {
      const source = safe(options.taskWorkspace, item.snapshot_path);
      if (!existsSync(source) || lstatSync(source).isSymbolicLink()
          || !lstatSync(source).isFile()) throw new Error("任务快照不存在");
      const content = readFileSync(source);
      if (content.byteLength !== item.bytes || sha256(content) !== item.digest) {
        throw new Error("任务快照与发布指纹不一致");
      }
      const relativePath = `${RUNTIME_DIR}/${item.id}.md`;
      const destination = safe(options.runtimeWorkspace, relativePath);
      writeFileSync(destination, content, { mode: 0o440 });
      chmodSync(destination, 0o440);
      entries.push({ ...item, relative_path: relativePath, path: destination });
    } catch (error) {
      warnings.push(`${item.title}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { entries, warnings };
}
