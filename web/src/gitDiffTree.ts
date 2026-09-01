export type ChangeStage = "committed" | "committed_working" | "staged"
  | "staged_working" | "unstaged" | "untracked";
export type FileKind = "代码" | "文档" | "测试" | "配置" | "其他";

export interface ChangedFile {
  key: string;
  path: string;
  stage: ChangeStage;
  kind: FileKind;
  lines: string[];
  additions: number;
  deletions: number;
}

function fileKind(path: string): FileKind {
  const lower = path.toLowerCase();
  const name = lower.split("/").at(-1) ?? lower;
  if (/(^|\/)(test|tests|__tests__)\//.test(lower)
    || /(?:test|spec)\.[^.]+$/.test(name)) return "测试";
  if (/\.(?:md|mdx|rst|adoc|txt|docx?|pdf)$/.test(lower)
    || /(^|\/)(?:readme|changelog|license)(?:\.|$)/.test(lower)) return "文档";
  if (/\.(?:json|ya?ml|toml|ini|conf|xml|properties|lock)$/.test(lower)
    || /(?:^|\/)(?:\.gitignore|dockerfile|makefile)$/.test(lower)) return "配置";
  if (/\.(?:[cm]?[jt]sx?|py|java|kt|kts|go|rs|rb|php|swift|scala|cs|c|cc|cpp|h|hpp|sh|sql|vue|svelte|css|scss|less|html)$/.test(lower)) return "代码";
  return "其他";
}

export function parseChanges(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let stage: ChangeStage = "unstaged";
  let current: { path: string; stage: ChangeStage; lines: string[] } | undefined;

  const finish = () => {
    if (!current) return;
    // 空白新增/删除行在 unified diff 里分别就是单个 "+" / "-"。
    // 旧正则要求标记后还得有字符，导致代码审阅统计系统性少算空行；
    // 只需排除文件头 +++ / ---，其余带标记的行都是真实变化。
    const additions = current.lines
      .filter((line) => /^\+(?!\+\+)/.test(line)).length;
    const deletions = current.lines
      .filter((line) => /^-(?!--)/.test(line)).length;
    files.push({
      ...current,
      key: `${current.stage}:${current.path}`,
      kind: fileKind(current.path),
      additions,
      deletions,
    });
    current = undefined;
  };

  for (const line of text.split("\n")) {
    if (/^## 已提交后又修改/.test(line)) { finish(); stage = "committed_working"; continue; }
    if (/^## 已提交/.test(line)) { finish(); stage = "committed"; continue; }
    if (/^## 已暂存后又修改/.test(line)) { finish(); stage = "staged_working"; continue; }
    if (/^## 已暂存/.test(line)) { finish(); stage = "staged"; continue; }
    if (/^## 未暂存/.test(line)) { finish(); stage = "unstaged"; continue; }
    if (/^## 未跟踪/.test(line)) { finish(); stage = "untracked"; continue; }
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) {
      finish();
      current = { path: header[2], stage, lines: [line] };
      continue;
    }
    const untracked = line.match(/^\?\?\s+(.+)$/);
    if (untracked) {
      finish();
      const path = untracked[1];
      files.push({
        key: `untracked:${path}`,
        path,
        stage: "untracked",
        kind: fileKind(path),
        lines: [line],
        additions: 0,
        deletions: 0,
      });
      continue;
    }
    if (current) current.lines.push(line);
  }
  finish();
  return files;
}

export interface ChangeDirectory {
  name: string;
  path: string;
  directories: ChangeDirectory[];
  files: ChangedFile[];
  count: number;
}

export function changeTree(files: ChangedFile[]): ChangeDirectory {
  type MutableDirectory = Omit<ChangeDirectory, "directories"> & {
    children: Map<string, MutableDirectory>;
  };
  const root: MutableDirectory = {
    name: "", path: "", children: new Map(), files: [], count: 0,
  };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let directory = root;
    for (const name of parts.slice(0, -1)) {
      const path = directory.path ? `${directory.path}/${name}` : name;
      let child = directory.children.get(name);
      if (!child) {
        child = { name, path, children: new Map(), files: [], count: 0 };
        directory.children.set(name, child);
      }
      directory = child;
    }
    directory.files.push(file);
  }
  const freeze = (directory: MutableDirectory): ChangeDirectory => {
    const directories = [...directory.children.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(freeze);
    const ownFiles = [...directory.files].sort((left, right) =>
      left.path.localeCompare(right.path));
    return {
      name: directory.name,
      path: directory.path,
      directories,
      files: ownFiles,
      count: ownFiles.length + directories.reduce((sum, item) =>
        sum + item.count, 0),
    };
  };
  return freeze(root);
}

export function descendantFiles(directory: ChangeDirectory): ChangedFile[] {
  return [
    ...directory.files,
    ...directory.directories.flatMap(descendantFiles),
  ];
}

/**
 * Git 客户端常见的 compact folders：连续只有一个子目录、且本层没有
 * 文件时合成一行。`src/main/java/com/acme` 只占一级缩进，深目录不会
 * 把真正要看的文件名挤出侧栏；目录的真实 path 与后代集合保持不变。
 */
export function compactDirectory(directory: ChangeDirectory): {
  directory: ChangeDirectory;
  label: string;
} {
  const names = [directory.name];
  let compacted = directory;
  while (compacted.files.length === 0 && compacted.directories.length === 1) {
    compacted = compacted.directories[0];
    names.push(compacted.name);
  }
  return { directory: compacted, label: names.join("/") };
}

/** 只返回界面真正画出的目录行，供“一键展开/折叠”与初始状态共用。 */
export function displayDirectoryPaths(directory: ChangeDirectory): string[] {
  return directory.directories.flatMap((child) => {
    const compacted = compactDirectory(child).directory;
    return [compacted.path, ...displayDirectoryPaths(compacted)];
  });
}
