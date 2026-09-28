import { executeFile, isResearchPlatformPath } from "./componentResearchTools.ts";
import type { KnowledgeRepository } from "./domainKnowledgeTypes.ts";

export interface KnowledgeCodeSnapshot {
  repository: KnowledgeRepository; root: string; revision: string; files: string[];
  build_units: Array<{ path: string; targets: string[]; dependencies: string[] }>;
}
export async function scanKnowledgeCode(repository: KnowledgeRepository, source: { root: string; revision: string }, signal: AbortSignal) {
  const files = (await executeFile("git", ["--literal-pathspecs", "ls-tree", "-r", "-z", "--name-only", source.revision, "--", ...(repository.path ? [repository.path] : [])], source.root, signal))
    .split("\0").filter(p => p && !isResearchPlatformPath(p));
  const build_units: KnowledgeCodeSnapshot["build_units"] = [];
  for (const path of files.filter(f => /(^|\/)(CMakeLists\.txt|pom\.xml|package\.json)$/.test(f))) {
    const content = await executeFile("git", ["show", `${source.revision}:${path}`], source.root, signal);
    let targets: string[] = [], dependencies: string[] = [];
    if (path.endsWith("CMakeLists.txt")) {
      const clean = content.replace(/#[^\n]*/g, "");
      targets = [...clean.matchAll(/add_(?:library|executable)\s*\(\s*([^\s)]+)/gi)].map(m => m[1]);
      dependencies = [...clean.matchAll(/target_link_libraries\s*\(([^)]+)\)/gi)].flatMap(m => m[1].trim().split(/\s+/).slice(1)).filter(t => !/^(?:PUBLIC|PRIVATE|INTERFACE|debug|optimized|general)$/.test(t));
    } else if (path.endsWith("pom.xml")) {
      const clean = content.replace(/<!--[\s\S]*?-->/g, "");
      dependencies = [...clean.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/g)].flatMap(m => [...m[1].matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].map(a => a[1]));
      targets = [...clean.replace(/<parent>[\s\S]*?<\/parent>|<dependencies>[\s\S]*?<\/dependencies>|<build>[\s\S]*?<\/build>/g, "").matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].slice(0, 1).map(m => m[1]);
    } else {
      try { const pkg = JSON.parse(content); targets = typeof pkg.name === "string" ? [pkg.name] : []; dependencies = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }); }
      catch { /* 不完整的构建文件由盘点会话核对。 */ }
    }
    build_units.push({ path, targets: [...new Set(targets)], dependencies: [...new Set(dependencies)] });
  }
  return { repository, ...source, files, build_units } satisfies KnowledgeCodeSnapshot;
}
export function knowledgeStructure(snapshots: KnowledgeCodeSnapshot[]) {
  return snapshots.map(s => ({ repository_id: s.repository.id, revision: s.revision, files: s.files.length,
    directories: [...new Set(s.files.map(f => f.split("/").slice(0, -1).join("/")).filter(Boolean))].slice(0, 400),
    build_units: s.build_units,
    dependency_edges: s.build_units.flatMap(unit => unit.dependencies.flatMap(dependency => snapshots.flatMap(other => other.build_units.filter(candidate => candidate.targets.includes(dependency)).map(candidate => ({ from: `${s.repository.id}:${unit.path}`, to: `${other.repository.id}:${candidate.path}`, dependency }))))),
    build_files: s.files.filter(f => /(^|\/)(CMakeLists\.txt|pom\.xml|build\.gradle(?:\.kts)?|package\.json|go\.mod|Cargo\.toml)$/.test(f)),
    note: "构建依赖由 CMake/Maven/npm 文本静态提取，只作候选：不执行构建，不解析变量、条件或外部下载依赖。读取真实调用和 import/include 后核实业务模块；目录列表最多 400 项，完整目录使用 component_source 分页。" }));
}
export function codeReferences(text: string): string[] {
  const refs = [...text.matchAll(/`([\p{L}\p{N}_.-]+:[^`\s]+)`/gu)].map(m => m[1]).filter(r => !/^[a-z]+:\/\//i.test(r));
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (frontmatter) {
    let inRefs = false;
    for (const line of frontmatter.split(/\r?\n/)) {
      if (/^related_code\s*:/.test(line)) {
        inRefs = true;
        const inline = line.replace(/^related_code\s*:\s*/, "");
        if (inline && inline !== "[]") for (const item of inline.replace(/^\[|\]$/g, "").split(",")) refs.push(item.trim().replace(/^["']|["']$/g, ""));
      } else if (inRefs && /^\s*-\s*/.test(line)) refs.push(line.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, ""));
      else if (line.trim() && !/^\s/.test(line)) inRefs = false;
    }
  }
  return [...new Set(refs)];
}
export async function validateKnowledgeReferences(text: string, snapshots: KnowledgeCodeSnapshot[], signal: AbortSignal) {
  const errors: string[] = [], checked: string[] = [];
  for (const ref of codeReferences(text)) {
    signal.throwIfAborted();
    const colon = ref.indexOf(":"), repo = ref.slice(0, colon), rest = ref.slice(colon + 1);
    const matches = snapshots.filter(s => s.repository.id === repo || s.repository.name === repo);
    if (matches.length !== 1) { errors.push(`${ref}：仓编号未知或重名，请使用 repository_id`); continue; }
    const snapshot = matches[0], match = /^(.*?)(?::(\d+)(?:-(\d+))?|#(.+))?$/.exec(rest)!;
    const path = match[1];
    if (!path || path.startsWith("/") || /[\\\x00-\x1f]/.test(path) || path.split("/").some(s => s === ".." || s === ".")) { errors.push(`${ref}：路径无效`); continue; }
    const pattern = new RegExp("^" + path.split("**").map(p => p.split("*").map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*") + "$");
    const files = snapshot.files.filter(f => pattern.test(f) || (!path.includes("*") && f.startsWith(`${path}/`)));
    if (!files.length) { errors.push(`${ref}：当前版本和研究范围内没有匹配文件`); continue; }
    if (match[2] || match[4]) {
      if (!snapshot.files.includes(path)) { errors.push(`${ref}：行号或符号必须指向文件`); continue; }
      const text = await executeFile("git", ["show", `${snapshot.revision}:${path}`], snapshot.root, signal);
      if (match[2]) {
        const start = Number(match[2]), end = Number(match[3] ?? match[2]);
        if (start < 1 || end < start || end > text.split("\n").length) { errors.push(`${ref}：行号越界`); continue; }
      }
      if (match[4] && !text.includes(match[4].split("::").at(-1)!.replace(/\(\)$/, ""))) { errors.push(`${ref}：符号不存在`); continue; }
    }
    checked.push(ref);
  }
  return { checked, errors };
}
