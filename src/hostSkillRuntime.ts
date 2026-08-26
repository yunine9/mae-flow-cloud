/**
 * Materialize deployment-wide Skills into the current task repository.
 *
 * Pi exposes each Skill's absolute SKILL.md location and explicitly tells the
 * model to Read it. The deployment source lives beside task workspaces, so
 * handing that source path to the model conflicts with both Cloud and kernel
 * file boundaries. This module freezes each discovered package under the
 * task-local .mae-flow-work directory, preserving relative resources without
 * widening access to the deployment data directory.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";

const MAX_SKILL_BYTES = 128 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 400;
const MAX_DEPTH = 8;

interface SnapshotMetadata {
  source_path: string;
  package_digest: string;
}

export interface MaterializedHostSkills {
  paths: string[];
  names: string[];
  warnings: string[];
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function contained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`)
    && !isAbsolute(path));
}

function assertNoSymlinkPath(root: string, target: string): void {
  const path = relative(root, target);
  if (!contained(root, target)) throw new Error("Skill 路径越出宿主 Skill 根");
  let cursor = root;
  for (const part of path.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new Error("Skill 路径包含软链接");
    }
  }
}

function secureSnapshotRoot(workspaceRoot: string, requested: string): string {
  const declaredWorkspace = resolve(workspaceRoot);
  const workspace = realpathSync(declaredWorkspace);
  const requestedAbsolute = resolve(requested);
  const requestedRelative = relative(declaredWorkspace, requestedAbsolute);
  if (requestedRelative === "" || requestedRelative === ".."
      || requestedRelative.startsWith(`..${sep}`)
      || isAbsolute(requestedRelative)) {
    throw new Error("宿主 Skill 快照目录必须位于任务工作区内");
  }
  const target = resolve(workspace, requestedRelative);
  let cursor = workspace;
  for (const part of requestedRelative.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) break;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new Error("宿主 Skill 快照路径包含软链接");
    }
    if (!stat.isDirectory()) {
      throw new Error("宿主 Skill 快照路径被普通文件占用");
    }
  }
  return target;
}

function validatePackage(
  sourceRoot: string,
  current: string,
  depth: number,
  budget: { files: number; bytes: number },
): void {
  if (depth > MAX_DEPTH) throw new Error(`Skill 包目录深度超过 ${MAX_DEPTH}`);
  assertNoSymlinkPath(sourceRoot, current);
  if (!contained(realpathSync(sourceRoot), realpathSync(current))) {
    throw new Error("Skill 包越出宿主 Skill 根");
  }
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Skill 包含软链接: ${entry.name}`);
    if (entry.isDirectory()) {
      validatePackage(sourceRoot, path, depth + 1, budget);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Skill 包含非普通文件: ${entry.name}`);
    const size = lstatSync(path).size;
    budget.files += 1;
    budget.bytes += size;
    if (budget.files > MAX_FILES || budget.bytes > MAX_PACKAGE_BYTES) {
      throw new Error("Skill 包体积超限");
    }
  }
}

/** 整包指纹(路径+内容序):快照对拍与管理面版本痕共用同一算法,
 * 两边各算一套的话"同 digest"就不再意味着"同内容"。 */
export function packageDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Skill 包含软链接: ${rel}`);
      if (stat.isDirectory()) {
        hash.update(`D\0${rel}\0`);
        visit(path);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Skill 包含非普通文件: ${rel}`);
      const content = readFileSync(path);
      hash.update(`F\0${rel}\0${content.length}\0`);
      hash.update(content);
    }
  };
  visit(root);
  return hash.digest("hex");
}

function copyPackage(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) {
      throw new Error(`Skill 包复制期间出现软链接: ${entry.name}`);
    }
    if (stat.isDirectory()) copyPackage(from, to);
    else if (stat.isFile()) copyFileSync(from, to);
    else throw new Error(`Skill 包复制期间出现非普通文件: ${entry.name}`);
  }
}

function makeReadonly(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      makeReadonly(child);
      chmodSync(child, 0o555);
    } else {
      chmodSync(child, 0o444);
    }
  }
  chmodSync(path, 0o555);
}

/** 快照正常是只读的；若宿主崩溃留下半包或高权限容器篡改了它，重建前
 * 需要先恢复可删除权限。遍历坚持 lstat，遇到软链接只删链接本身，绝不
 * chmod/跟随它指向的任务外目标。清理本身必须 best-effort，坏 Skill 不应
 * 把整个会话启动拖死。 */
function removeSnapshot(
  destination: string | undefined,
  metadataPath: string | undefined,
): void {
  const makeRemovable = (path: string): void => {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path)) {
        makeRemovable(join(path, entry));
      }
    } else {
      chmodSync(path, 0o600);
    }
  };
  if (destination) {
    try {
      makeRemovable(destination);
      rmSync(destination, { recursive: true, force: true });
    } catch {
      // 调用方随后跳过该 Skill；其他健康 Skill 仍继续装载。
    }
  }
  if (metadataPath) {
    try {
      if (existsSync(metadataPath)) chmodSync(metadataPath, 0o600);
      rmSync(metadataPath, { force: true });
    } catch {
      // 同上，诊断由触发清理的原始错误负责。
    }
  }
}

function existingSnapshot(
  destination: string,
  targetFile: string,
  metadataPath: string,
  sourcePath: string,
  digest: string,
): string | undefined {
  if (!existsSync(destination) || !existsSync(metadataPath)) return undefined;
  try {
    const destinationStat = lstatSync(destination);
    const metadataStat = lstatSync(metadataPath);
    if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()
        || metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
      return undefined;
    }
    if (!existsSync(targetFile) || lstatSync(targetFile).isSymbolicLink()) {
      return undefined;
    }
    const metadata = JSON.parse(
      readFileSync(metadataPath, "utf-8")) as SnapshotMetadata;
    if (metadata.source_path === sourcePath
        && metadata.package_digest === digest
        && packageDigest(destination) === digest) {
      return targetFile;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function materializeHostSkills(options: {
  sourceRoot?: string;
  workspaceRoot: string;
  snapshotRoot: string;
}): MaterializedHostSkills {
  const warnings: string[] = [];
  if (!options.sourceRoot || !existsSync(options.sourceRoot)) {
    return { paths: [], names: [], warnings };
  }
  let sourceRoot: string;
  let snapshotRoot: string;
  try {
    sourceRoot = realpathSync(resolve(options.sourceRoot));
    snapshotRoot = secureSnapshotRoot(
      options.workspaceRoot, options.snapshotRoot);
  } catch (error) {
    warnings.push(`宿主 Skill 装配路径无效: ${String(error)}`);
    return { paths: [], names: [], warnings };
  }
  let discovered: ReturnType<typeof loadSkills>;
  try {
    discovered = loadSkills({
      cwd: sourceRoot,
      agentDir: sourceRoot,
      skillPaths: [sourceRoot],
      includeDefaults: false,
    });
  } catch (error) {
    warnings.push(`宿主 Skill 发现失败: ${String(error)}`);
    return { paths: [], names: [], warnings };
  }
  for (const diagnostic of discovered.diagnostics) {
    warnings.push(
      `${diagnostic.path ?? sourceRoot}: ${diagnostic.message}`);
  }
  const paths: string[] = [];
  const names: string[] = [];
  for (const skill of discovered.skills) {
    const sourceFile = resolve(skill.filePath);
    const packageRoot = resolve(skill.baseDir ?? dirname(sourceFile));
    let destination: string | undefined;
    let metadataPath: string | undefined;
    try {
      assertNoSymlinkPath(sourceRoot, sourceFile);
      assertNoSymlinkPath(sourceRoot, packageRoot);
      const stat = lstatSync(sourceFile);
      if (!stat.isFile()) throw new Error("SKILL.md 不是普通文件");
      if (stat.size > MAX_SKILL_BYTES) {
        throw new Error("SKILL.md 超过 128 KiB");
      }
      validatePackage(
        sourceRoot, packageRoot, 0, { files: 0, bytes: 0 });
      const digest = packageDigest(packageRoot);
      const sourcePath = relative(sourceRoot, sourceFile).split(sep).join("/");
      const key = sha256(`${skill.name}\0${sourcePath}\0${digest}`).slice(0, 20);
      destination = join(snapshotRoot, key);
      metadataPath = `${destination}.snapshot.json`;
      const targetFile = join(destination, relative(packageRoot, sourceFile));
      const reused = existingSnapshot(
        destination, targetFile, metadataPath, sourcePath, digest);
      if (!reused) {
        removeSnapshot(destination, metadataPath);
        if (existsSync(destination) || existsSync(metadataPath)) {
          throw new Error("旧 Skill 快照无法安全清理");
        }
        mkdirSync(snapshotRoot, { recursive: true });
        copyPackage(packageRoot, destination);
        if (packageDigest(destination) !== digest) {
          throw new Error("Skill 包复制后整体校验不一致");
        }
        writeFileSync(metadataPath, JSON.stringify({
          source_path: sourcePath,
          package_digest: digest,
        } satisfies SnapshotMetadata));
        chmodSync(metadataPath, 0o444);
        makeReadonly(destination);
      }
      paths.push(reused ?? targetFile);
      names.push(skill.name);
    } catch (error) {
      removeSnapshot(destination, metadataPath);
      warnings.push(
        `${skill.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { paths, names, warnings };
}
