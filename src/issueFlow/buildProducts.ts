import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// 仓根 build 是构建脚本，不能按名字清理；链接库采用更长的冷却期。
const PRODUCT_DIRS = ["target/build", "target/obj", "target/classes", "target/test-classes"];
const LIBRARY_DIRS = ["target/dev_lib", "target/lib"];
export const BUILD_LIBRARIES_COOLDOWN_MS = 7 * 24 * 3_600_000;

function isDirectory(root: string, relative: string): boolean {
  try {
    let current = root;
    for (const part of ["", ...relative.split("/")]) {
      current = join(current, part);
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
    }
    return true;
  } catch { return false; }
}

/** 不跟随软链；目录里仍有新写入或不可读文件时，留到下次扫描。 */
function coldSize(path: string, cutoff: number): number | undefined {
  try {
    const info = lstatSync(path);
    if (info.mtimeMs > cutoff) return;
    if (info.isSymbolicLink()) return 0;
    if (!info.isDirectory()) return info.size;
    let bytes = 0;
    for (const name of readdirSync(path)) {
      const size = coldSize(join(path, name), cutoff);
      if (size === undefined) return;
      bytes += size;
    }
    return bytes;
  } catch { return undefined; }
}

/** 调用方先确认会话闲置；全程同步，删除不会与同一进程的新回合交错。 */
export function reclaimBuildProducts(repoRoot: string, cutoff: number, libraryCutoff?: number): { bytes: number; directories: number } {
  const result = { bytes: 0, directories: 0 };
  if (!isDirectory(repoRoot, "")) return result;
  for (const entry of readdirSync(repoRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const repo = join(repoRoot, entry.name);
    const paths = PRODUCT_DIRS.map(path => ({ path, cutoff }));
    if (libraryCutoff !== undefined) {
      paths.push(...LIBRARY_DIRS.map(path => ({ path, cutoff: libraryCutoff })));
    }
    const candidates = paths.flatMap(({ path, cutoff }) => {
      if (!isDirectory(repo, path)) return [];
      const bytes = coldSize(join(repo, path), cutoff);
      return bytes === undefined ? [] : [{ path, bytes }];
    });
    if (!candidates.length) continue;
    // 删产物前先失效首编准备记录，续跑时不能误判成可增量编译。
    const work = join(repo, ".mae-flow-work");
    try {
      const info = lstatSync(work);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      rmSync(join(work, "mae-first-build.json"), { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
    for (const candidate of candidates) {
      try {
        rmSync(join(repo, candidate.path), { recursive: true, force: true });
      } catch { continue; }
      result.bytes += candidate.bytes;
      result.directories += 1;
    }
  }
  return result;
}
