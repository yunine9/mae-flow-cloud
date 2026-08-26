import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  diffReviewRows,
  type DiffCell,
  type DiffReviewRow,
} from "./diffLines";

type ChangeStage = "committed" | "committed_working" | "staged"
  | "staged_working" | "unstaged" | "untracked";
type FileKind = "代码" | "文档" | "测试" | "配置" | "其他";

interface ChangedFile {
  key: string;
  path: string;
  stage: ChangeStage;
  kind: FileKind;
  lines: string[];
  additions: number;
  deletions: number;
}

const stageName: Record<ChangeStage, string> = {
  committed: "已提交",
  committed_working: "已提交后又修改",
  staged: "已暂存",
  staged_working: "已暂存后又修改",
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

interface ChangeDirectory {
  name: string;
  path: string;
  directories: ChangeDirectory[];
  files: ChangedFile[];
  count: number;
}

function changeTree(files: ChangedFile[]): ChangeDirectory {
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

function directoryPaths(directory: ChangeDirectory): string[] {
  return directory.directories.flatMap((child) => [
    child.path,
    ...directoryPaths(child),
  ]);
}

function descendantFiles(directory: ChangeDirectory): ChangedFile[] {
  return [
    ...directory.files,
    ...directory.directories.flatMap(descendantFiles),
  ];
}

export interface GitDiffSelection {
  selectedPaths: string[];
  committedPaths: string[];
  allPaths: string[];
}

type ReviewEntry = DiffReviewRow | {
  type: "fold";
  key: string;
  count: number;
};

function contextRow(row: DiffReviewRow): boolean {
  return row.type === "line"
    && row.old?.kind === "context"
    && row.next?.kind === "context";
}

/** 默认只露出改动附近；被藏的上下文仍在页面数据里，可逐段或一次展开。 */
function foldedRows(
  rows: DiffReviewRow[],
  expanded: Set<string>,
  showAll: boolean,
): { entries: ReviewEntry[]; hidden: number } {
  if (showAll) return { entries: rows, hidden: 0 };
  const entries: ReviewEntry[] = [];
  let hidden = 0;
  let cursor = 0;
  while (cursor < rows.length) {
    if (!contextRow(rows[cursor])) {
      entries.push(rows[cursor]);
      cursor += 1;
      continue;
    }
    let end = cursor + 1;
    while (end < rows.length && contextRow(rows[end])) end += 1;
    const count = end - cursor;
    if (count <= 8) {
      entries.push(...rows.slice(cursor, end));
    } else {
      const foldStart = cursor + 3;
      const foldEnd = end - 3;
      const key = `${foldStart}:${foldEnd}`;
      entries.push(...rows.slice(cursor, foldStart));
      if (expanded.has(key)) {
        entries.push(...rows.slice(foldStart, foldEnd));
      } else {
        const folded = foldEnd - foldStart;
        hidden += folded;
        entries.push({ type: "fold", key, count: folded });
      }
      entries.push(...rows.slice(foldEnd, end));
    }
    cursor = end;
  }
  return { entries, hidden };
}

function DiffCellView({ cell }: { cell?: DiffCell }) {
  const mark = cell?.kind === "added" ? "+"
    : cell?.kind === "removed" ? "−" : "";
  return (
    <div className={`diff-cell ${cell?.kind ?? "empty"}`}>
      <span className="diff-line-number">{cell?.number ?? ""}</span>
      {/* data-code 圈出"纯代码文本":批注取原文只能取这一段。整行
          textContent 会把左边的行号和 +/− 标记一起抓进去,拿这种脏
          原文回头比对必然对不上,于是"这处已被改动"整片误报。
          内核面板也是分开取的(.ln 取行号、.c 取代码)。 */}
      <code><i aria-hidden>{mark}</i><span data-code>{cell?.text ?? ""}</span></code>
    </div>
  );
}

export function GitDiff({
  text,
  branch,
  hideKey,
  selectable = false,
  selectionKey = "",
  initialSelectedPaths,
  onSelectionChange,
}: {
  text: string;
  branch?: string;
  /** 每任务保存自己的视图隐藏项；隐藏不参与 Git 或交付判断。 */
  hideKey?: string;
  /** 仅代码检视待办开放交付勾选。 */
  selectable?: boolean;
  selectionKey?: string;
  initialSelectedPaths?: string[];
  onSelectionChange?: (selection: GitDiffSelection) => void;
}) {
  const files = useMemo(() => parseChanges(text), [text]);
  const [selected, setSelected] = useState(files[0]?.key ?? "");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [focused, setFocused] = useState(false);
  const [collapsedDirectories, setCollapsedDirectories] =
    useState<Set<string>>(new Set());
  const [hiddenPaths, setHiddenPaths] = useState<Set<string>>(new Set());
  const [deliveryPaths, setDeliveryPaths] = useState<Set<string>>(new Set());
  const [activeSelectionKey, setActiveSelectionKey] = useState("");
  const initializedSelection = useRef("");
  const initializedDirectories = useRef<Set<string>>(new Set());
  const [pathTip, setPathTip] = useState<{
    path: string;
    left: number;
    top: number;
  }>();
  const hiddenStorageKey = hideKey
    ? `mae-flow:hidden-change-files:${hideKey}` : "";
  const visibleFiles = useMemo(
    () => files.filter((file) => !hiddenPaths.has(file.path)),
    [files, hiddenPaths],
  );
  const tree = useMemo(() => changeTree(visibleFiles), [visibleFiles]);
  const allDirectories = useMemo(() => directoryPaths(tree), [tree]);
  const committedPaths = useMemo(() => files
    .filter((file) => file.stage === "committed"
      || file.stage === "committed_working")
    .map((file) => file.path).sort((left, right) => left.localeCompare(right)),
  [files]);

  useEffect(() => {
    if (!hiddenStorageKey || typeof window === "undefined") {
      setHiddenPaths(new Set());
      return;
    }
    try {
      const saved = JSON.parse(localStorage.getItem(hiddenStorageKey) ?? "[]");
      setHiddenPaths(new Set(Array.isArray(saved) ? saved.map(String) : []));
    } catch {
      setHiddenPaths(new Set());
    }
  }, [hiddenStorageKey]);

  useEffect(() => {
    if (!hiddenStorageKey || typeof window === "undefined") return;
    localStorage.setItem(hiddenStorageKey, JSON.stringify([...hiddenPaths]));
  }, [hiddenPaths, hiddenStorageKey]);

  useEffect(() => {
    const available = new Set(files.map((file) => file.path));
    setHiddenPaths((current) => {
      const next = new Set([...current].filter((path) => available.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [files.map((file) => file.path).join("\0")]);

  useEffect(() => {
    const known = initializedDirectories.current;
    const added = allDirectories.filter((path) => !known.has(path));
    if (added.length) {
      setCollapsedDirectories((current) => new Set([...current, ...added]));
    }
    initializedDirectories.current = new Set(allDirectories);
  }, [allDirectories.join("\0")]);

  useEffect(() => {
    if (!selectable || !files.length) {
      if (!selectable) {
        initializedSelection.current = "";
        setActiveSelectionKey("");
      }
      return;
    }
    const key = selectionKey || "delivery";
    const available = new Set(files.map((file) => file.path));
    if (initializedSelection.current !== key) {
      const initial = initialSelectedPaths ?? committedPaths;
      setDeliveryPaths(new Set(initial.filter((path) => available.has(path))));
      initializedSelection.current = key;
      setActiveSelectionKey(key);
      return;
    }
    setDeliveryPaths((current) => new Set(
      [...current].filter((path) => available.has(path)),
    ));
  }, [selectable, selectionKey, files.map((file) => file.path).join("\0")]);

  useEffect(() => {
    const key = selectionKey || "delivery";
    if (!selectable || activeSelectionKey !== key) return;
    onSelectionChange?.({
      selectedPaths: [...deliveryPaths].sort((left, right) =>
        left.localeCompare(right)),
      committedPaths,
      allPaths: files.map((file) => file.path).sort((left, right) =>
        left.localeCompare(right)),
    });
  }, [selectable, selectionKey, activeSelectionKey,
    [...deliveryPaths].sort().join("\0"), committedPaths.join("\0"),
    files.map((file) => file.path).join("\0")]);

  useEffect(() => {
    if (!visibleFiles.some((file) => file.key === selected)) {
      setSelected(visibleFiles[0]?.key ?? "");
    }
  }, [visibleFiles, selected]);
  const active = visibleFiles.find((file) => file.key === selected)
    ?? visibleFiles[0];
  useEffect(() => {
    setExpanded(new Set());
    setShowAll(false);
    setPathTip(undefined);
  }, [active?.key]);
  const reviewRows = useMemo(
    () => diffReviewRows(active?.lines ?? []),
    [active],
  );
  const folded = useMemo(
    () => foldedRows(reviewRows, expanded, showAll),
    [reviewRows, expanded, showAll],
  );
  const lineCount = reviewRows.reduce((largest, row) => row.type === "line"
    ? Math.max(largest, row.next?.number ?? row.old?.number ?? 0)
    : largest, 0);
  const hasTextRows = reviewRows.some((row) => row.type === "line");
  const canFold = showAll || folded.hidden > 0 || expanded.size > 0;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const kinds = Array.from(new Set(files.map((file) => file.kind)));
  const branchLabel = branch || "分支未知";
  const selectedDeliveryCount = deliveryPaths.size;
  const selectionChanged = selectable
    && (selectedDeliveryCount !== committedPaths.length
      || committedPaths.some((path) => !deliveryPaths.has(path)));

  function toggleDelivery(paths: string[]) {
    if (!selectable) return;
    setDeliveryPaths((current) => {
      const next = new Set(current);
      const add = paths.some((path) => !next.has(path));
      for (const path of paths) {
        if (add) next.add(path);
        else next.delete(path);
      }
      return next;
    });
  }

  function hideFiles(paths: string[]) {
    setHiddenPaths((current) => new Set([...current, ...paths]));
  }

  function renderFile(file: ChangedFile, depth: number, overview: boolean) {
    const included = deliveryPaths.has(file.path);
    return (
      <div className={`change-tree-file${file.key === active?.key ? " on" : ""}`}
        key={file.key} style={{ "--tree-depth": depth } as CSSProperties}>
        {selectable && (
          <button type="button" className={`delivery-check${included ? " checked" : ""}`}
            aria-pressed={included}
            aria-label={`${included ? "不提交" : "提交"} ${file.path}`}
            title={included ? "从交付清单移除" : "加入交付清单"}
            onClick={() => toggleDelivery([file.path])}>
            <svg viewBox="0 0 16 16" aria-hidden><path d="m3.5 8 3 3 6-6" /></svg>
          </button>
        )}
        <button type="button" className="change-tree-file-main" title={file.path}
          onClick={() => {
            setSelected(file.key);
            if (overview) setFocused(true);
          }}
          onPointerEnter={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setPathTip({ path: file.path, left: box.right + 9,
              top: box.top + box.height / 2 });
          }}
          onPointerLeave={() => setPathTip(undefined)}
          onFocus={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setPathTip({ path: file.path, left: box.right + 9,
              top: box.top + box.height / 2 });
          }}
          onBlur={() => setPathTip(undefined)}>
          <span className={`file-kind kind-${file.kind}`}>{file.kind.slice(0, 1)}</span>
          <span className="change-file-name"><strong>{file.path.split("/").at(-1)}</strong>
            <small>{stageName[file.stage]} · {file.kind}</small></span>
          {(file.additions > 0 || file.deletions > 0) && (
            <i><em>+{file.additions}</em> <del>−{file.deletions}</del></i>
          )}
        </button>
        <button type="button" className="change-hide" title="从当前视图隐藏；不改变交付清单"
          aria-label={`隐藏 ${file.path}`} onClick={() => hideFiles([file.path])}>
          <svg viewBox="0 0 18 18" aria-hidden><path d="M2.5 9s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z" /><path d="m3 3 12 12" /></svg>
        </button>
      </div>
    );
  }

  function renderDirectory(
    directory: ChangeDirectory,
    depth: number,
    overview: boolean,
  ): ReactNode {
    const descendants = descendantFiles(directory);
    const paths = descendants.map((file) => file.path);
    const included = paths.filter((path) => deliveryPaths.has(path)).length;
    const collapsed = collapsedDirectories.has(directory.path);
    return (
      <div className="change-tree-directory" key={directory.path}>
        <div className="change-tree-directory-row"
          style={{ "--tree-depth": depth } as CSSProperties}>
          {selectable && (
            <button type="button"
              className={`delivery-check${included === paths.length ? " checked" : ""}${
                included > 0 && included < paths.length ? " partial" : ""}`}
              aria-pressed={included === paths.length}
              aria-label={`${included === paths.length ? "不提交" : "提交"}目录 ${directory.path}`}
              onClick={() => toggleDelivery(paths)}>
              <svg viewBox="0 0 16 16" aria-hidden><path d="m3.5 8 3 3 6-6" /></svg>
            </button>
          )}
          <button type="button" className="change-directory-main"
            aria-expanded={!collapsed}
            onClick={() => setCollapsedDirectories((current) => {
              const next = new Set(current);
              if (next.has(directory.path)) next.delete(directory.path);
              else next.add(directory.path);
              return next;
            })}>
            <svg viewBox="0 0 16 16" aria-hidden><path d="m6 3 5 5-5 5" /></svg>
            <span aria-hidden>▰</span><strong>{directory.name}</strong><i>{directory.count}</i>
          </button>
          <button type="button" className="change-hide"
            title="隐藏整个目录；不改变交付清单"
            aria-label={`隐藏目录 ${directory.path}`}
            onClick={() => hideFiles(paths)}>
            <svg viewBox="0 0 18 18" aria-hidden><path d="M2.5 9s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z" /><path d="m3 3 12 12" /></svg>
          </button>
        </div>
        {!collapsed && (
          <div className="change-tree-children">
            {directory.directories.map((child) =>
              renderDirectory(child, depth + 1, overview))}
            {directory.files.map((file) => renderFile(file, depth + 1, overview))}
          </div>
        )}
      </div>
    );
  }

  function renderTree(overview: boolean) {
    return (
      <div className={`change-tree${overview ? " overview" : ""}`}>
        {tree.directories.map((directory) =>
          renderDirectory(directory, 0, overview))}
        {tree.files.map((file) => renderFile(file, 0, overview))}
        {!visibleFiles.length && (
          <div className="change-tree-empty">全部变更已从视图隐藏</div>
        )}
      </div>
    );
  }

  if (!files.length) {
    return <div className="worktree-clean"><strong>暂无代码变更</strong><span>{text}</span></div>;
  }

  return (
    <section className={`git-change-view${focused ? " is-focused" : ""}`}
      aria-label={focused ? "专注代码审阅" : "工作区变更"}
      role={focused ? "dialog" : undefined}
      aria-modal={focused ? "true" : undefined}
      onKeyDown={(event) => {
        if (focused && event.key === "Escape") {
          event.stopPropagation();
          setFocused(false);
        }
      }}>
      {focused ? (
        <header className="code-review-head">
          <button type="button" className="code-review-back" autoFocus
            onClick={() => setFocused(false)}>
            <svg viewBox="0 0 20 20" aria-hidden><path d="m12.5 5-5 5 5 5" /></svg>
            返回工作台
          </button>
          <div className="code-review-title">
            <span>CODE REVIEW</span>
            <strong>代码审阅</strong>
            <small><code title={`当前分支：${branchLabel}`}>{branchLabel}</code>
              <i>·</i>{files.length} 个文件 · {kinds.join("、")}</small>
          </div>
          <div className="code-review-totals" aria-label="变更统计">
            <b>+{additions}</b><i>−{deletions}</i>
          </div>
        </header>
      ) : (
        <header className="git-change-summary">
          <div>
            <span>WORKTREE</span>
            <strong>{files.length} 个文件发生变化</strong>
            <small><code title={`当前分支：${branchLabel}`}>{branchLabel}</code>
              <i>·</i>{kinds.join("、")} · 任务基线至当前工作区</small>
          </div>
          <div className="change-summary-actions">
            <div className="change-totals" aria-label="变更统计">
              <b className="plus">+{additions}</b><b className="minus">−{deletions}</b>
            </div>
            <button type="button" className="focus-review"
              onClick={() => setFocused(true)}>
              <svg viewBox="0 0 18 18" aria-hidden><path d="M6.5 3H3v3.5M11.5 3H15v3.5M6.5 15H3v-3.5M11.5 15H15v-3.5" /></svg>
              专注审阅
            </button>
          </div>
        </header>
      )}

      {(selectable || hiddenPaths.size > 0) && (
        <div className={`delivery-selection-bar${selectionChanged ? " changed" : ""}`}>
          {selectable && <div><strong>交付清单：已勾选 {selectedDeliveryCount} / {files.length}</strong>
            <span>{selectionChanged
              ? "清单与当前 commit 不同，提交“需要调整”后由 Agent 整理并重新检视"
              : "当前勾选与 commit 一致；最终 push 前服务端会再次核对"}</span></div>}
          <div>
            {selectable && <>
              <button type="button" onClick={() =>
                setDeliveryPaths(new Set(files.map((file) => file.path)))}>全选</button>
              <button type="button" onClick={() => setDeliveryPaths(new Set())}>清空</button>
            </>}
            {hiddenPaths.size > 0 && <button type="button"
              title="隐藏只影响浏览，不影响上面的交付勾选"
              onClick={() => setHiddenPaths(new Set())}>
              恢复 {hiddenPaths.size} 个隐藏项
            </button>}
          </div>
          {hiddenPaths.size > 0 && <small>隐藏仅整理视图，不会自动排除提交。</small>}
        </div>
      )}

      {focused ? (
      <div className="git-change-browser">
        <nav className="change-files" aria-label="变更文件">
          <div className="change-tree-caption"><span>按目录</span><i>{visibleFiles.length}</i></div>
          {renderTree(false)}
        </nav>

        <section className="change-file-detail">
          <header>
            <div><strong title={active?.path}>{active?.path}</strong><span>{active && `${stageName[active.stage]} · ${active.kind}${lineCount ? ` · ${lineCount} 行` : ""}`}</span></div>
            <div className="change-detail-actions">
              {active && (active.additions > 0 || active.deletions > 0) && <small><b>+{active.additions}</b> <i>−{active.deletions}</i></small>}
              {canFold && (
                <button type="button" onClick={() => {
                  setShowAll((value) => !value);
                  if (showAll) setExpanded(new Set());
                }}>{showAll ? "折叠未改动" : "展开全文"}</button>
              )}
            </div>
          </header>
          {!hasTextRows ? (
            <div className="untracked-file-note"><strong>没有可展示的文本内容</strong><span>文件可能为空、不可读或属于无法逐行比较的类型。</span></div>
          ) : (
            // data-file / data-l 是批注的锚:批注层用事件委托认它们,
            // 不需要 GitDiff 知道批注这回事(内核面板也是这么分层的)。
            <div className="ws-diff diff-review" data-file={active?.path}>
              <div className="diff-review-head"><span>变更前</span><span>变更后</span></div>
              <div className="diff-review-body">
                {folded.entries.map((row, index) => {
                  if (row.type === "fold") {
                    return (
                      <button className="diff-fold" type="button" key={row.key}
                        onClick={() => setExpanded((current) => new Set(current).add(row.key))}>
                        <span>···</span>展开 {row.count} 行未改动内容
                      </button>
                    );
                  }
                  if (row.type !== "line") {
                    return <div className={`diff-review-${row.type}`} key={`${row.type}:${index}`}>{row.text}</div>;
                  }
                  const at = row.next?.number;
                  return (
                    <div className="diff-review-row" key={`line:${index}`}
                      {...(at ? { "data-l": at } : {})}>
                      <DiffCellView cell={row.old} />
                      <DiffCellView cell={row.next} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </div>
      ) : (
        <section className="change-overview" aria-label="变更文件概览">
          <div className="change-overview-intro">
            <span className="change-overview-icon" aria-hidden>
              <svg viewBox="0 0 20 20"><path d="M6 3.5H3.5V6M14 3.5h2.5V6M6 16.5H3.5V14M14 16.5h2.5V14M7 7h6v6H7z" /></svg>
            </span>
            <div>
              <strong>代码差异在专注审阅中查看</strong>
              <span>点击文件直接进入宽屏双栏视图；工作台只保留变更概览。</span>
            </div>
          </div>
          {renderTree(true)}
        </section>
      )}
      {pathTip && createPortal(
        <div className="change-path-tooltip" role="tooltip"
          style={{ left: pathTip.left, top: pathTip.top }}>
          {pathTip.path}
        </div>,
        document.body,
      )}
    </section>
  );
}
