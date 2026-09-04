import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  diffReviewRows,
  type DiffCell,
  type DiffReviewRow,
} from "./diffLines";
import {
  changeTree,
  compactDirectory,
  descendantFiles,
  displayDirectoryPaths,
  fileKind,
  parseChanges,
  type ChangedFile,
  type ChangeDirectory,
  type ChangeStage,
} from "./gitDiffTree";
import {
  DEFAULT_DIFF_FONT_SIZE,
  DEFAULT_DIFF_SPLIT,
  DEFAULT_TREE_PANEL_WIDTH,
  MAX_DIFF_FONT_SIZE,
  MIN_DIFF_FONT_SIZE,
  clampDiffFontSize,
  clampDiffSplit,
  clampTreePanelWidth,
  diffSplitFromPointer,
} from "./gitDiffLayout";

const stageName: Record<ChangeStage, string> = {
  committed: "已提交",
  committed_working: "已提交后又修改",
  staged: "已暂存",
  staged_working: "已暂存后又修改",
  unstaged: "未暂存",
  untracked: "未跟踪",
};

function storedNumber(key: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

export interface GitDiffSelection {
  selectedPaths: string[];
  committedPaths: string[];
  allPaths: string[];
}

export interface GitDiffFileManifest {
  path: string;
  stage: ChangeStage;
  additions: number;
  deletions: number;
}

export interface GitDiffDirectoryManifest {
  path: string;
  stage: "untracked";
}

export interface GitDiffDirectoryEntry {
  path: string;
  kind: "file" | "directory";
  file_count: number;
  stage: "untracked";
}

export interface GitDiffDirectoryPage {
  path: string;
  entries: GitDiffDirectoryEntry[];
  total_entries: number;
  total_files: number;
  next_offset?: number;
}

interface LoadedDirectory {
  open: boolean;
  loading: boolean;
  error?: string;
  entries?: GitDiffDirectoryEntry[];
  totalEntries?: number;
  totalFiles?: number;
  nextOffset?: number;
}

/**
 * 文件树以服务端的小体积完整清单为准，正文只补当前已经读取的文件。
 * 这样前几个大文件即使触发正文上限，后面的文件仍然全部可见可点。
 */
export function filesForDiff(
  text: string,
  manifest?: readonly GitDiffFileManifest[],
): ChangedFile[] {
  const parsed = parseChanges(text);
  if (!manifest?.length) return parsed;
  const contentByPath = new Map(parsed.map((file) => [file.path, file]));
  return manifest.map((entry) => {
    const content = contentByPath.get(entry.path);
    return content
      ? {
          ...content,
          key: `${entry.stage}:${entry.path}`,
          stage: entry.stage,
        }
      : {
          ...entry,
          key: `${entry.stage}:${entry.path}`,
          kind: fileKind(entry.path),
          lines: [],
        };
  });
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
  const text = cell?.text ?? "";
  const [from, to] = cell?.emphasis ?? [0, 0];
  // 词级高亮:mark 元素不改变 textContent,批注取 [data-code] 原文
  // 与整行文本完全一致,锚定比对不受影响。
  const body = to > from
    ? <span data-code>{text.slice(0, from)}<mark>{text.slice(from, to)}</mark>{text.slice(to)}</span>
    : <span data-code>{text}</span>;
  return (
    <div className={`diff-cell ${cell?.kind ?? "empty"}`}>
      <span className="diff-line-number">{cell?.number ?? ""}</span>
      {/* data-code 圈出"纯代码文本":批注取原文只能取这一段。整行
          textContent 会把左边的行号和 +/− 标记一起抓进去,拿这种脏
          原文回头比对必然对不上,于是"这处已被改动"整片误报。
          内核面板也是分开取的(.ln 取行号、.c 取代码)。 */}
      <code><i aria-hidden>{mark}</i>{body}</code>
    </div>
  );
}

export function GitDiff({
  text,
  branch,
  manifest,
  untrackedDirectories,
  onFileSelect,
  onDirectoryLoad,
  activeFileLoading = false,
  activeFileError = "",
  hideKey,
  selectable = false,
  selectionKey = "",
  initialSelectedPaths,
  onSelectionChange,
  scopeLabel,
  focusRequest = 0,
}: {
  text: string;
  branch?: string;
  /** 完整文件目录；正文 text 可以只包含当前点开的一个文件。 */
  manifest?: readonly GitDiffFileManifest[];
  /** 未跟踪目录只给根节点，避免一次编译把数万文件灌进 React。 */
  untrackedDirectories?: readonly GitDiffDirectoryManifest[];
  onFileSelect?: (path: string) => void;
  /** 用户展开未跟踪目录时分页读取其直接子项。 */
  onDirectoryLoad?: (
    path: string,
    offset: number,
  ) => Promise<GitDiffDirectoryPage>;
  activeFileLoading?: boolean;
  activeFileError?: string;
  /** 每任务保存自己的视图隐藏项；隐藏不参与 Git 或交付判断。 */
  hideKey?: string;
  /** 仅代码检视待办开放交付勾选。 */
  selectable?: boolean;
  selectionKey?: string;
  initialSelectedPaths?: string[];
  onSelectionChange?: (selection: GitDiffSelection) => void;
  /** 当前对比范围的人话(如"本次修改 · a2f2715 → 510a5fa")。缺省
   * 沿用工作区语义。曾经硬编码"任务基线至当前工作区",HEAD→HEAD
   * 的增量也顶着这行标题(MFC-007)。 */
  scopeLabel?: string;
  /** 外部明确请求进入专注审阅；递增即可重复打开。 */
  focusRequest?: number;
}) {
  const baseFiles = useMemo(() => filesForDiff(text, manifest), [text, manifest]);
  const directoryRoots = useMemo(() => [...new Map(
    (untrackedDirectories ?? []).map((directory) =>
      [directory.path, directory] as const)).values()], [untrackedDirectories]);
  const directoryRootKey = directoryRoots.map((directory) => directory.path)
    .join("\0");
  const [loadedUntrackedFiles, setLoadedUntrackedFiles] =
    useState<Map<string, ChangedFile>>(new Map());
  const files = useMemo(() => {
    const merged = new Map(baseFiles.map((file) => [file.path, file]));
    const contentByPath = new Map(parseChanges(text)
      .map((file) => [file.path, file] as const));
    for (const file of loadedUntrackedFiles.values()) {
      const content = contentByPath.get(file.path);
      merged.set(file.path, content
        ? { ...content, key: file.key, stage: "untracked" }
        : file);
    }
    return [...merged.values()];
  }, [baseFiles, loadedUntrackedFiles, text]);
  const [loadedDirectories, setLoadedDirectories] =
    useState<Record<string, LoadedDirectory>>({});
  const [selected, setSelected] = useState(baseFiles[0]?.key ?? "");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (focusRequest > 0) setFocused(true);
  }, [focusRequest]);
  const [treePanelWidth, setTreePanelWidth] = useState(() =>
    clampTreePanelWidth(storedNumber("mae-flow:git-tree-width",
      DEFAULT_TREE_PANEL_WIDTH), 2000));
  const [diffSplit, setDiffSplit] = useState(() =>
    clampDiffSplit(storedNumber("mae-flow:git-diff-split", DEFAULT_DIFF_SPLIT)));
  const [diffFontSize, setDiffFontSize] = useState(() =>
    clampDiffFontSize(storedNumber("mae-flow:git-diff-font-size",
      DEFAULT_DIFF_FONT_SIZE)));
  // 首次渲染就折叠目录。旧实现等首屏提交后才在 effect 里折叠，数万
  // 文件会先真实生成数十万个 DOM 节点，浏览器已经卡死，effect 根本
  // 来不及执行。
  const [collapsedDirectories, setCollapsedDirectories] =
    useState<Set<string>>(() => new Set(
      displayDirectoryPaths(changeTree(baseFiles))));
  const [hiddenPaths, setHiddenPaths] = useState<Set<string>>(new Set());
  const [hiddenDirectories, setHiddenDirectories] =
    useState<Set<string>>(new Set());
  const [deliveryPaths, setDeliveryPaths] = useState<Set<string>>(new Set());
  const [localGroupOpen, setLocalGroupOpen] = useState(false);
  const [activeSelectionKey, setActiveSelectionKey] = useState("");
  const initializedSelection = useRef("");
  const initializedDirectories = useRef<Set<string>>(new Set());
  const gitBrowser = useRef<HTMLDivElement>(null);
  const diffCanvas = useRef<HTMLDivElement>(null);
  // 分栏把手是否真被拖动过:拖动收尾的 click 不算"点了一行"(MFC-034)。
  const resizerDragged = useRef(false);
  const [pathTip, setPathTip] = useState<{
    path: string;
    left: number;
    top: number;
  }>();
  const hiddenStorageKey = hideKey
    ? `mae-flow:hidden-change-files:${hideKey}` : "";
  const hiddenDirectoryStorageKey = hideKey
    ? `mae-flow:hidden-change-directories:${hideKey}` : "";
  const pathInsideDirectory = (path: string, directory: string) =>
    path.startsWith(`${directory}/`);
  const hiddenByDirectory = (path: string) => [...hiddenDirectories]
    .some((directory) => pathInsideDirectory(path, directory));
  const visibleFiles = useMemo(
    () => files.filter((file) => !hiddenPaths.has(file.path)
      && !hiddenByDirectory(file.path)),
    [files, hiddenPaths, hiddenDirectories],
  );
  const visibleDirectoryRoots = useMemo(() => directoryRoots.filter(
    (directory) => !hiddenDirectories.has(directory.path)),
  [directoryRoots, hiddenDirectories]);
  // 按需载入的未跟踪文件由下面的懒目录原位绘制，不能又塞进普通树
  // 形成两份同名节点。
  const treeFiles = useMemo(() => visibleFiles.filter((file) =>
    !directoryRoots.some((directory) =>
      pathInsideDirectory(file.path, directory.path))),
  [visibleFiles, directoryRoots]);
  const tree = useMemo(() => changeTree(treeFiles), [treeFiles]);
  // 交付检视时按语义分两组:检视的重心是"将推送"的提交增量,工作区
  // 其他改动默认不进远端——混在一棵树里,人分不清哪些必须看。
  const pushFiles = useMemo(() => treeFiles.filter((file) =>
    file.stage === "committed" || file.stage === "committed_working"),
  [treeFiles]);
  const localFiles = useMemo(() => treeFiles.filter((file) =>
    file.stage !== "committed" && file.stage !== "committed_working"),
  [treeFiles]);
  const grouped = selectable && pushFiles.length > 0
    && (localFiles.length > 0 || visibleDirectoryRoots.length > 0);
  const pushTree = useMemo(() => changeTree(pushFiles), [pushFiles]);
  const localTree = useMemo(() => changeTree(localFiles), [localFiles]);
  const allDirectories = useMemo(() => grouped
    ? [...new Set([
      ...displayDirectoryPaths(pushTree),
      ...displayDirectoryPaths(localTree),
    ])]
    : displayDirectoryPaths(tree), [grouped, tree, pushTree, localTree]);
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
    if (!hiddenDirectoryStorageKey || typeof window === "undefined") {
      setHiddenDirectories(new Set());
      return;
    }
    try {
      const saved = JSON.parse(
        localStorage.getItem(hiddenDirectoryStorageKey) ?? "[]");
      setHiddenDirectories(new Set(
        Array.isArray(saved) ? saved.map(String) : []));
    } catch {
      setHiddenDirectories(new Set());
    }
  }, [hiddenDirectoryStorageKey]);

  useEffect(() => {
    if (!hiddenStorageKey || typeof window === "undefined") return;
    localStorage.setItem(hiddenStorageKey, JSON.stringify([...hiddenPaths]));
  }, [hiddenPaths, hiddenStorageKey]);

  useEffect(() => {
    if (!hiddenDirectoryStorageKey || typeof window === "undefined") return;
    localStorage.setItem(hiddenDirectoryStorageKey,
      JSON.stringify([...hiddenDirectories]));
  }, [hiddenDirectories, hiddenDirectoryStorageKey]);

  useEffect(() => {
    setLoadedDirectories({});
    setLoadedUntrackedFiles(new Map());
  }, [directoryRootKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem("mae-flow:git-tree-width", String(treePanelWidth));
      localStorage.setItem("mae-flow:git-diff-split", String(diffSplit));
      localStorage.setItem("mae-flow:git-diff-font-size", String(diffFontSize));
    } catch {
      // 阅读偏好写不进去不影响代码检视。
    }
  }, [treePanelWidth, diffSplit, diffFontSize]);

  useEffect(() => {
    if (!focused || typeof window === "undefined") return;
    const fitTreePanel = () => {
      const width = gitBrowser.current?.getBoundingClientRect().width;
      if (width) setTreePanelWidth((current) =>
        clampTreePanelWidth(current, width));
    };
    fitTreePanel();
    window.addEventListener("resize", fitTreePanel);
    return () => window.removeEventListener("resize", fitTreePanel);
  }, [focused]);

  useEffect(() => {
    const available = new Set(files.map((file) => file.path));
    setHiddenPaths((current) => {
      const next = new Set([...current].filter((path) => available.has(path)));
      return next.size === current.size ? current : next;
    });
  }, [files.map((file) => file.path).join("\0")]);

  useEffect(() => {
    setHiddenDirectories((current) => {
      const next = new Set([...current].filter((path) => directoryRoots.some(
        (root) => path === root.path || pathInsideDirectory(path, root.path))));
      return next.size === current.size ? current : next;
    });
  }, [directoryRootKey]);

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

  const requestedDeliveryKey = initialSelectedPaths
    ?.filter((path) => files.some((file) => file.path === path))
    .sort((left, right) => left.localeCompare(right)).join("\0");
  useEffect(() => {
    // 服务端刷新后可能回送已请求的交付清单，diff 树必须原位跟上，
    // 不能只把 initialSelectedPaths 当成一次性的默认值。
    if (!selectable || initialSelectedPaths === undefined) return;
    const available = new Set(files.map((file) => file.path));
    const next = new Set(initialSelectedPaths.filter((path) =>
      available.has(path)));
    setDeliveryPaths((current) => {
      const currentKey = [...current].sort().join("\0");
      const nextKey = [...next].sort().join("\0");
      return currentKey === nextKey ? current : next;
    });
  }, [selectable, selectionKey, requestedDeliveryKey]);

  useEffect(() => {
    const key = selectionKey || "delivery";
    if (!selectable || activeSelectionKey !== key) return;
    // 外部清单刚刷新时，先等上面的同步 effect 落到树里；否则这里会
    // 用一帧前的旧值反向覆盖父层，表现成右侧点了又弹回去。
    if (requestedDeliveryKey !== undefined
        && requestedDeliveryKey !== [...deliveryPaths].sort().join("\0")) return;
    onSelectionChange?.({
      selectedPaths: [...deliveryPaths].sort((left, right) =>
        left.localeCompare(right)),
      committedPaths,
      allPaths: files.map((file) => file.path).sort((left, right) =>
        left.localeCompare(right)),
    });
  }, [selectable, selectionKey, activeSelectionKey, requestedDeliveryKey,
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
    if (active?.path) onFileSelect?.(active.path);
  }, [active?.path, onFileSelect]);
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
  // 最终检视里的统计必须与“将推送”同一口径。完整 diff 仍保留仅留本地
  // 文件供人查看，但不能把它们的行数算进完整交付，否则会与右栏清单
  // 同屏出现两套数字（MFC-056）。普通工作区浏览没有交付选择，仍统计全部。
  const countedFiles = selectable
    ? files.filter((file) => deliveryPaths.has(file.path))
    : files;
  const additions = countedFiles.reduce(
    (sum, file) => sum + file.additions, 0);
  const deletions = countedFiles.reduce(
    (sum, file) => sum + file.deletions, 0);
  const branchLabel = branch || "分支未知";
  const selectedDeliveryCount = deliveryPaths.size;
  const hasCollapsedDirectories = allDirectories.some((path) =>
    collapsedDirectories.has(path));
  const selectionChanged = selectable
    && (selectedDeliveryCount !== committedPaths.length
      || committedPaths.some((path) => !deliveryPaths.has(path)));

  function toggleDelivery(paths: string[]) {
    if (!selectable) return;
    const next = new Set(deliveryPaths);
    const add = paths.some((path) => !next.has(path));
    for (const path of paths) {
      if (add) next.add(path);
      else next.delete(path);
    }
    setDeliveryPaths(next);
    onSelectionChange?.({
      selectedPaths: [...next].sort((left, right) => left.localeCompare(right)),
      committedPaths,
      allPaths: files.map((file) => file.path).sort((left, right) =>
        left.localeCompare(right)),
    });
  }

  function replaceDelivery(paths: string[]) {
    if (!selectable) return;
    const next = new Set(paths);
    setDeliveryPaths(next);
    onSelectionChange?.({
      selectedPaths: [...next].sort((left, right) => left.localeCompare(right)),
      committedPaths,
      allPaths: files.map((file) => file.path).sort((left, right) =>
        left.localeCompare(right)),
    });
  }

  function hideFiles(paths: string[]) {
    setHiddenPaths((current) => new Set([...current, ...paths]));
  }

  function resizeTreePanel(clientX: number) {
    const box = gitBrowser.current?.getBoundingClientRect();
    if (!box) return;
    setTreePanelWidth(clampTreePanelWidth(clientX - box.left, box.width));
  }

  function resizeDiffColumns(clientX: number) {
    const box = diffCanvas.current?.getBoundingClientRect();
    if (!box) return;
    setDiffSplit(diffSplitFromPointer(clientX, box.left, box.width));
  }

  async function loadUntrackedDirectory(path: string, append = false) {
    if (!onDirectoryLoad) return;
    const current = loadedDirectories[path];
    const offset = append ? current?.nextOffset : 0;
    if (append && offset === undefined) return;
    setLoadedDirectories((directories) => ({
      ...directories,
      [path]: {
        ...directories[path],
        open: true,
        loading: true,
        error: undefined,
      },
    }));
    try {
      const page = await onDirectoryLoad(path, offset ?? 0);
      setLoadedDirectories((directories) => {
        const previous = append ? directories[path]?.entries ?? [] : [];
        const entries = [...new Map([...previous, ...page.entries]
          .map((entry) => [entry.path, entry] as const)).values()];
        return {
          ...directories,
          [path]: {
            open: true,
            loading: false,
            entries,
            totalEntries: page.total_entries,
            totalFiles: page.total_files,
            nextOffset: page.next_offset,
          },
        };
      });
      const fileEntries = page.entries.filter((entry) => entry.kind === "file");
      if (fileEntries.length) {
        setLoadedUntrackedFiles((currentFiles) => {
          const next = new Map(currentFiles);
          for (const entry of fileEntries) {
            next.set(entry.path, {
              key: `untracked:${entry.path}`,
              path: entry.path,
              stage: "untracked",
              kind: fileKind(entry.path),
              lines: [],
              additions: 0,
              deletions: 0,
            });
          }
          return next;
        });
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setLoadedDirectories((directories) => ({
        ...directories,
        [path]: {
          ...directories[path],
          open: true,
          loading: false,
          error: message,
        },
      }));
    }
  }

  function toggleUntrackedDirectory(path: string) {
    const current = loadedDirectories[path];
    if (!current?.entries && !current?.loading) {
      void loadUntrackedDirectory(path);
      return;
    }
    setLoadedDirectories((directories) => ({
      ...directories,
      [path]: { ...directories[path], open: !directories[path]?.open },
    }));
  }

  function renderFile(file: ChangedFile, depth: number, overview: boolean) {
    const included = deliveryPaths.has(file.path);
    return (
      <div className={`change-tree-file${file.key === active?.key ? " on" : ""}`}
        key={file.key} style={{ "--tree-depth": depth } as CSSProperties}>
        {selectable && (
          <button type="button" className={`delivery-check${included ? " checked" : ""}`}
            aria-pressed={included}
            aria-label={`${included ? "改为仅留本地" : "纳入交付"} ${file.path}`}
            title={included ? "改为仅留本地，不推送" : "纳入本次交付"}
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
            <small><span>{stageName[file.stage]} · {file.kind}</span>
              {(file.additions > 0 || file.deletions > 0) && (
                <i className="change-file-stats"><em>+{file.additions}</em>
                  <del>−{file.deletions}</del></i>
              )}</small></span>
        </button>
        <button type="button" className="change-hide" title="从当前视图隐藏；不改变交付清单"
          aria-label={`隐藏 ${file.path}`} onClick={() => hideFiles([file.path])}>
          <svg viewBox="0 0 18 18" aria-hidden><path d="M2.5 9s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z" /><path d="m3 3 12 12" /></svg>
        </button>
      </div>
    );
  }

  function renderUntrackedDirectory(
    directory: GitDiffDirectoryManifest | GitDiffDirectoryEntry,
    depth: number,
    overview: boolean,
  ): ReactNode {
    if (hiddenDirectories.has(directory.path)) return null;
    const state = loadedDirectories[directory.path];
    const open = state?.open === true;
    const count = state?.totalFiles
      ?? ("file_count" in directory ? directory.file_count : undefined);
    const label = depth === 0 ? directory.path
      : directory.path.split("/").at(-1) ?? directory.path;
    return (
      <div className="change-tree-directory untracked-directory"
        key={`untracked-directory:${directory.path}`}>
        <div className="change-tree-directory-row"
          style={{ "--tree-depth": depth } as CSSProperties}>
          <button type="button" className="change-directory-main"
            title={`${directory.path}（未跟踪目录，展开时按需读取）`}
            aria-expanded={open}
            onClick={() => toggleUntrackedDirectory(directory.path)}>
            <svg viewBox="0 0 16 16" aria-hidden><path d="m6 3 5 5-5 5" /></svg>
            <span aria-hidden>▰</span><strong>{label}</strong>
            <i>{count === undefined ? "按需" : count}</i>
          </button>
          <button type="button" className="change-hide"
            title="隐藏整个未跟踪目录；不改变 Git 或交付清单"
            aria-label={`隐藏目录 ${directory.path}`}
            onClick={() => setHiddenDirectories((current) =>
              new Set([...current, directory.path]))}>
            <svg viewBox="0 0 18 18" aria-hidden><path d="M2.5 9s2.4-4 6.5-4 6.5 4 6.5 4-2.4 4-6.5 4-6.5-4-6.5-4Z" /><path d="m3 3 12 12" /></svg>
          </button>
        </div>
        {open && <div className="change-tree-children">
          {state?.loading && !state.entries?.length && (
            <div className="change-tree-lazy-note">正在读取这一层…</div>
          )}
          {state?.error && (
            <div className="change-tree-lazy-note error">
              <span>{state.error}</span>
              <button type="button" onClick={() =>
                void loadUntrackedDirectory(directory.path)}>重试</button>
            </div>
          )}
          {state?.entries?.map((entry) => entry.kind === "directory"
            ? renderUntrackedDirectory(entry, depth + 1, overview)
            : hiddenPaths.has(entry.path) || hiddenByDirectory(entry.path)
              ? null
              : renderFile({
                  key: `untracked:${entry.path}`,
                  path: entry.path,
                  stage: "untracked",
                  kind: fileKind(entry.path),
                  lines: [],
                  additions: 0,
                  deletions: 0,
                }, depth + 1, overview))}
          {state?.nextOffset !== undefined && (
            <button type="button" className="change-tree-load-more"
              disabled={state.loading}
              onClick={() => void loadUntrackedDirectory(
                directory.path, true)}>
              {state.loading ? "正在加载…" : `继续加载（已显示 ${
                state.entries?.length ?? 0} / ${state.totalEntries ?? 0} 项）`}
            </button>
          )}
          {!state?.loading && !state?.error && state?.entries?.length === 0 && (
            <div className="change-tree-lazy-note">目录当前没有可展示的未跟踪文件</div>
          )}
        </div>}
      </div>
    );
  }

  function renderUntrackedDirectories(overview: boolean) {
    if (!visibleDirectoryRoots.length) return null;
    return (
      <div className="change-tree-untracked">
        <div className="change-tree-group-head local">
          <strong>未跟踪目录 · 默认折叠</strong>
          <i>{visibleDirectoryRoots.length}</i>
        </div>
        {visibleDirectoryRoots.map((directory) =>
          renderUntrackedDirectory(directory, 0, overview))}
      </div>
    );
  }

  function renderDirectory(
    directory: ChangeDirectory,
    depth: number,
    overview: boolean,
  ): ReactNode {
    const compacted = compactDirectory(directory);
    directory = compacted.directory;
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
              aria-label={`${included === paths.length ? "改为仅留本地" : "纳入交付"}目录 ${directory.path}`}
              title={included === paths.length
                ? "整个目录改为仅留本地，不推送" : "整个目录纳入本次交付"}
              onClick={() => toggleDelivery(paths)}>
              <svg viewBox="0 0 16 16" aria-hidden><path d="m3.5 8 3 3 6-6" /></svg>
            </button>
          )}
          <button type="button" className="change-directory-main"
            title={directory.path}
            aria-expanded={!collapsed}
            onClick={() => setCollapsedDirectories((current) => {
              const next = new Set(current);
              if (next.has(directory.path)) next.delete(directory.path);
              else next.add(directory.path);
              return next;
            })}>
            <svg viewBox="0 0 16 16" aria-hidden><path d="m6 3 5 5-5 5" /></svg>
            <span aria-hidden>▰</span><strong>{compacted.label}</strong><i>{directory.count}</i>
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

  function renderTreeNodes(
    source: { directories: ChangeDirectory[]; files: ChangedFile[] },
    overview: boolean,
  ) {
    return (
      <>
        {source.directories.map((directory) =>
          renderDirectory(directory, 0, overview))}
        {source.files.map((file) => renderFile(file, 0, overview))}
      </>
    );
  }

  function renderTree(overview: boolean) {
    return (
      <div className={`change-tree${overview ? " overview" : ""}`}>
        {grouped ? (
          <>
            <div className="change-tree-group">
              <div className="change-tree-group-head push">
                <strong>本次提交 · 将推送</strong><i>{pushFiles.length}</i>
              </div>
              {renderTreeNodes(pushTree, overview)}
            </div>
            <div className="change-tree-group">
              <button type="button" className="change-tree-group-head local"
                aria-expanded={localGroupOpen}
                onClick={() => setLocalGroupOpen((open) => !open)}>
                <span aria-hidden>{localGroupOpen ? "⌄" : "›"}</span>
                <strong>工作区其他改动 · 默认仅留本地</strong>
                <i>{localFiles.length + visibleDirectoryRoots.length}</i>
              </button>
              {localGroupOpen && renderTreeNodes(localTree, overview)}
              {localGroupOpen && renderUntrackedDirectories(overview)}
            </div>
          </>
        ) : <>
          {renderTreeNodes(tree, overview)}
          {renderUntrackedDirectories(overview)}
        </>}
        {!visibleFiles.length && !visibleDirectoryRoots.length && (
          <div className="change-tree-empty">全部变更已从视图隐藏</div>
        )}
      </div>
    );
  }

  if (!files.length && !directoryRoots.length) {
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
              <i>·</i>{scopeLabel ?? "任务基线至当前工作区"}</small>
          </div>
          <div className="code-review-totals" aria-label="变更统计">
            <b>+{additions}</b><i>−{deletions}</i>
          </div>
        </header>
      ) : (
        <header className="git-change-summary">
          <div>
            <span>WORKTREE</span>
            <strong>{baseFiles.length} 个文件发生变化{directoryRoots.length
              ? ` · ${directoryRoots.length} 个未跟踪目录` : ""}</strong>
            <small><code title={`当前分支：${branchLabel}`}>{branchLabel}</code>
              <i>·</i>{scopeLabel ?? "任务基线至当前工作区"}</small>
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

      {(selectable || hiddenPaths.size > 0 || hiddenDirectories.size > 0) && (
        <div className={`delivery-selection-bar${selectionChanged ? " changed" : ""}`}>
          {selectable && <div><strong>最终推送范围：{selectedDeliveryCount} / {files.length} 个文件</strong>
            <span>{selectionChanged
              ? "已调整范围；右侧只读摘要会实时同步。"
              : "勾选表示纳入交付；取消表示仅留本地。完成后在右侧提交决定。"}</span></div>}
          <div>
            {selectable && <>
              <button type="button" onClick={() =>
                replaceDelivery(files.map((file) => file.path))}>全部纳入</button>
              <button type="button" onClick={() => replaceDelivery([])}>全部仅留本地</button>
            </>}
            {(hiddenPaths.size > 0 || hiddenDirectories.size > 0) && <button type="button"
              title="隐藏只影响浏览，不影响上面的交付勾选"
              onClick={() => {
                setHiddenPaths(new Set());
                setHiddenDirectories(new Set());
              }}>
              恢复 {hiddenPaths.size + hiddenDirectories.size} 个隐藏项
            </button>}
          </div>
          {(hiddenPaths.size > 0 || hiddenDirectories.size > 0)
            && <small>隐藏仅整理视图，不会自动排除提交。</small>}
        </div>
      )}

      {focused ? (
      <div className="git-change-browser" ref={gitBrowser}
        style={{ "--change-tree-width": `${treePanelWidth}px` } as CSSProperties}>
        <nav className="change-files" aria-label="变更文件">
          <div className="change-tree-caption"><span>按目录</span><div>
            <i>{treeFiles.length}{visibleDirectoryRoots.length
              ? ` + ${visibleDirectoryRoots.length}目录` : ""}</i>
            {allDirectories.length > 0 && (
              <button type="button"
                aria-label={hasCollapsedDirectories ? "展开全部目录" : "折叠全部目录"}
                title={hasCollapsedDirectories ? "展开全部目录" : "折叠全部目录"}
                onClick={() => setCollapsedDirectories(hasCollapsedDirectories
                  ? new Set() : new Set(allDirectories))}>
                <svg viewBox="0 0 16 16" aria-hidden>
                  {hasCollapsedDirectories
                    ? <><path d="m4 3 4 4 4-4" /><path d="m4 9 4 4 4-4" /></>
                    : <><path d="m4 7 4-4 4 4" /><path d="m4 13 4-4 4 4" /></>}
                </svg>
                {hasCollapsedDirectories ? "全部展开" : "全部折叠"}
              </button>
            )}
          </div></div>
          {renderTree(false)}
        </nav>

        <div className="change-panel-resizer" role="separator" tabIndex={0}
          aria-label="调整目录树宽度" aria-orientation="vertical"
          aria-valuemin={240} aria-valuemax={560} aria-valuenow={treePanelWidth}
          title="左右拖动调整目录树；双击恢复默认"
          onDoubleClick={() => setTreePanelWidth(DEFAULT_TREE_PANEL_WIDTH)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const width = gitBrowser.current?.getBoundingClientRect().width ?? 1200;
            setTreePanelWidth(clampTreePanelWidth(
              treePanelWidth + (event.key === "ArrowLeft" ? -16 : 16), width));
          }}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            resizeTreePanel(event.clientX);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              resizeTreePanel(event.clientX);
            }
          }}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}>
          <span aria-hidden />
        </div>

        <section className="change-file-detail">
          <header>
            <div><strong title={active?.path}>{active?.path}</strong><span>{active && `${stageName[active.stage]} · ${active.kind}${lineCount ? ` · ${lineCount} 行` : ""}`}</span></div>
            <div className="change-detail-actions">
              {active && (active.additions > 0 || active.deletions > 0) && <small><b>+{active.additions}</b> <i>−{active.deletions}</i></small>}
              <div className="diff-font-zoom" aria-label="Git 字号">
                <button type="button" aria-label="缩小 Git 字号"
                  disabled={diffFontSize <= MIN_DIFF_FONT_SIZE}
                  onClick={() => setDiffFontSize(clampDiffFontSize(diffFontSize - 1))}>
                  A−
                </button>
                <button type="button" className="diff-font-reset"
                  title="恢复默认 Git 字号"
                  onClick={() => setDiffFontSize(DEFAULT_DIFF_FONT_SIZE)}>
                  {Math.round((diffFontSize / DEFAULT_DIFF_FONT_SIZE) * 100)}%
                </button>
                <button type="button" aria-label="放大 Git 字号"
                  disabled={diffFontSize >= MAX_DIFF_FONT_SIZE}
                  onClick={() => setDiffFontSize(clampDiffFontSize(diffFontSize + 1))}>
                  A+
                </button>
              </div>
              {canFold && (
                <button type="button" onClick={() => {
                  setShowAll((value) => !value);
                  if (showAll) setExpanded(new Set());
                }}>{showAll ? "折叠未改动" : "展开全文"}</button>
              )}
            </div>
          </header>
          {activeFileLoading ? (
            <div className="untracked-file-note"><strong>正在读取这个文件…</strong>
              <span>文件清单已经完整加载，正文按需打开。</span></div>
          ) : activeFileError ? (
            <div className="untracked-file-note" role="alert">
              <strong>这个文件暂时打不开</strong><span>{activeFileError}</span>
            </div>
          ) : !active && directoryRoots.length ? (
            <div className="untracked-file-note">
              <strong>未跟踪目录已折叠</strong>
              <span>从左侧展开需要查看的目录，再选择具体文件；目录内容不会一次性灌入页面。</span>
            </div>
          ) : !hasTextRows ? (
            <div className="untracked-file-note"><strong>没有可展示的文本内容</strong><span>文件可能为空、不可读或属于无法逐行比较的类型。</span></div>
          ) : (
            // data-file / data-l 是批注的锚:批注层用事件委托认它们,
            // 不需要 GitDiff 知道批注这回事(内核面板也是这么分层的)。
            <div className="ws-diff diff-review" data-file={active?.path}
              style={{ "--git-diff-font-size": `${diffFontSize}px` } as CSSProperties}>
              <div className="diff-review-canvas" ref={diffCanvas}
                style={{ "--diff-before-width": `${diffSplit}%` } as CSSProperties}>
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
                <div className="diff-column-resizer" role="separator" tabIndex={0}
                  aria-label="调整变更前后宽度" aria-orientation="vertical"
                  aria-valuemin={25} aria-valuemax={75}
                  aria-valuenow={Math.round(diffSplit)}
                  title="左右拖动调整变更前后宽度；双击恢复对半"
                  onDoubleClick={() => setDiffSplit(DEFAULT_DIFF_SPLIT)}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    event.preventDefault();
                    setDiffSplit(clampDiffSplit(
                      diffSplit + (event.key === "ArrowLeft" ? -2 : 2)));
                  }}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    resizerDragged.current = false;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    resizeDiffColumns(event.clientX);
                  }}
                  onPointerMove={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                      resizerDragged.current = true;
                      resizeDiffColumns(event.clientX);
                    }
                  }}
                  onPointerUp={(event) =>
                    event.currentTarget.releasePointerCapture(event.pointerId)}
                  onClick={(event) => {
                    // 把手压在行中心(MFC-034):真拖动过的收尾 click 不外
                    // 泄,原地单击则放行给批注层按坐标落到底下那一行。
                    if (resizerDragged.current) {
                      resizerDragged.current = false;
                      event.stopPropagation();
                    }
                  }}>
                  <span aria-hidden />
                </div>
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
