import { useEffect, useMemo, useState } from "react";
import { newFileLines } from "./diffLines";

type ChangeStage = "staged" | "unstaged" | "untracked";
type FileKind = "代码" | "文档" | "测试" | "配置" | "其他";

interface ChangedFile {
  key: string;
  path: string;
  stage: ChangeStage;
  kind: FileKind;
  lines: string[];
  /** 每一行在新文件里的行号(0 = 这行在新文件里没有对应行号)。 */
  numbers: number[];
  additions: number;
  deletions: number;
}

const stageName: Record<ChangeStage, string> = {
  staged: "已暂存",
  unstaged: "未暂存",
  untracked: "未跟踪",
};

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

function parseChanges(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let stage: ChangeStage = "unstaged";
  let current: { path: string; stage: ChangeStage; lines: string[] } | undefined;

  const finish = () => {
    if (!current) return;
    const additions = current.lines.filter((line) => /^\+[^+]/.test(line)).length;
    const deletions = current.lines.filter((line) => /^-[^-]/.test(line)).length;
    files.push({
      ...current,
      key: `${current.stage}:${current.path}`,
      kind: fileKind(current.path),
      numbers: newFileLines(current.lines),
      additions,
      deletions,
    });
    current = undefined;
  };

  for (const line of text.split("\n")) {
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
        // 未跟踪文件只有一条记录行,没有 diff 行号可推——不给锚点,
        // 页面上那一行也就不可圈注(圈了也没法告诉模型改哪儿)。
        numbers: [0],
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

function lineKind(line: string): string {
  if (/^diff --git /.test(line)) return "file";
  if (/^@@ /.test(line)) return "hunk";
  if (/^\+[^+]/.test(line)) return "added";
  if (/^-[^-]/.test(line)) return "removed";
  if (/^\?\? /.test(line)) return "untracked";
  return "context";
}

function shortPath(path: string): string {
  const parts = path.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

export function GitDiff({ text }: { text: string }) {
  const files = useMemo(() => parseChanges(text), [text]);
  const [selected, setSelected] = useState(files[0]?.key ?? "");
  useEffect(() => {
    if (!files.some((file) => file.key === selected)) setSelected(files[0]?.key ?? "");
  }, [files, selected]);
  const active = files.find((file) => file.key === selected) ?? files[0];
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const kinds = Array.from(new Set(files.map((file) => file.kind)));

  if (!files.length) {
    return <div className="worktree-clean"><strong>工作区干净</strong><span>{text}</span></div>;
  }

  return (
    <section className="git-change-view" aria-label="工作区变更">
      <header className="git-change-summary">
        <div>
          <span>WORKTREE</span>
          <strong>{files.length} 个文件发生变化</strong>
          <small>{kinds.join("、")} · 来自版本库实时状态</small>
        </div>
        <div className="change-totals" aria-label="变更统计">
          <b className="plus">+{additions}</b><b className="minus">−{deletions}</b>
        </div>
      </header>

      <div className="git-change-browser">
        <nav className="change-files" aria-label="变更文件">
          {(["staged", "unstaged", "untracked"] as ChangeStage[]).map((group) => {
            const grouped = files.filter((file) => file.stage === group);
            if (!grouped.length) return null;
            return (
              <div className="change-file-group" key={group}>
                <div className="change-file-group-head"><span>{stageName[group]}</span><i>{grouped.length}</i></div>
                {grouped.map((file) => (
                  <button key={file.key} className={file.key === active?.key ? "on" : ""} onClick={() => setSelected(file.key)} title={file.path}>
                    <span className={`file-kind kind-${file.kind}`}>{file.kind.slice(0, 1)}</span>
                    <span className="change-file-name"><strong>{shortPath(file.path)}</strong><small>{file.kind}</small></span>
                    {(file.additions > 0 || file.deletions > 0) && <i><em>+{file.additions}</em> <del>−{file.deletions}</del></i>}
                  </button>
                ))}
              </div>
            );
          })}
        </nav>

        <section className="change-file-detail">
          <header>
            <div><strong>{active?.path}</strong><span>{active && `${stageName[active.stage]} · ${active.kind}`}</span></div>
            {active && (active.additions > 0 || active.deletions > 0) && <small><b>+{active.additions}</b> <i>−{active.deletions}</i></small>}
          </header>
          {active?.stage === "untracked" ? (
            <div className="untracked-file-note"><strong>新文件尚未纳入版本控制</strong><span>当前只展示文件记录；纳入 Git 后即可查看逐行差异。</span></div>
          ) : (
            // data-file / data-l 是批注的锚:批注层用事件委托认它们,
            // 不需要 GitDiff 知道批注这回事(内核面板也是这么分层的)。
            <pre className="ws-diff" data-file={active?.path}><code>{
              active?.lines.map((line, index) => {
                const at = active.numbers[index];
                return (
                  <span
                    key={index}
                    className={`diff-line ${lineKind(line)}`}
                    {...(at ? { "data-l": at } : {})}
                  >{line || " "}</span>
                );
              })}</code></pre>
          )}
        </section>
      </div>
    </section>
  );
}
