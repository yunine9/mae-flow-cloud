/**
 * 批注层:把任何带 `data-l`(源行号)的材料变成可圈注的。
 *
 * 用事件委托而不是给渲染器加回调——Markdown 和 GitDiff 因此完全不需要
 * 知道"批注"这回事,只管吐出 `data-l` / `data-file`。内核面板也是这么
 * 分层的,两边语义对得上。
 *
 * 正文默认用于阅读与复制。悬停行后点批注图标，或选中文字后点
 * “批注选中内容”，才展开编辑框；点击、双击和拖选本身不创建批注。
 */

import { useEffect, useRef, useState } from "react";
import { addAnnotation, uploadAnnotationAsset, type AnnotationImage } from "./api";
import {
  anchorOf, annotationsAtRow, quoteOfSelection,
  type MaterialAnnotation, type RowNode, type SelectionQuote,
} from "./annotateTargets";
import "./annotate.css";

interface Draft {
  file: string;
  line: number;
  anchor: string;
  /** 划选了一块时的整块原文与末行;按行点的没有。 */
  quote?: string;
  lineEnd?: number;
  kind: "doc" | "code";
  /** 编辑框挂在哪个元素后面。 */
  host: HTMLElement;
}

type SelectedBlock = SelectionQuote & { focusRow: HTMLElement };

export function Annotatable({
  taskId,
  artifact,
  fallbackFile,
  kind,
  items,
  enabled = true,
  onAdded,
  onOpenAnnotations,
  renderInlineReview,
  onSendDraft,
  queueWithDecision = false,
  addDraft,
  children,
}: {
  taskId: string;
  artifact: string;
  /** 文档没有 data-file,用产物名当路径。 */
  fallbackFile: string;
  kind: "doc" | "code";
  /** 已有圈注:精确到产物、文件与当前行，避免聚合 diff 的同号行串台。 */
  items: ReadonlyArray<MaterialAnnotation>;
  /** 用户停止后材料仍可读但不新增；已交付任务仍可留下归档批注。 */
  enabled?: boolean;
  onAdded: () => void;
  /** 已圈过的行通过图标查看意见；正文仍然只用于阅读。 */
  onOpenAnnotations?: (ids: string[]) => void;
  /** Same live feedback component as the collaboration feed, scoped to this location. */
  renderInlineReview?: (ids: string[]) => React.ReactNode;
  /** Explicit submit; saving alone never authorizes a workflow decision. */
  onSendDraft?: (id: string) => Promise<{ error?: string; receipt?: string }>;
  /** 普通人工决定窗口只能登记，正文随当前决定送达。 */
  queueWithDecision?: boolean;
  /** 圈注落账的替代口(问题域检视,ADR-0007):给了就走它,不给走
   * 任务流 addAnnotation。交互两域同一套,只有提交端点不同。 */
  addDraft?: (input: {
    line: number;
    anchor: string;
    note: string;
    quote?: string;
    line_end?: number;
  }) => Promise<{ error?: string }>;
  children: React.ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft>();
  const [thread, setThread] = useState<{ ids: string[]; host: HTMLElement }>();
  const [receipt, setReceipt] = useState("");
  useEffect(() => {
    setThread(undefined);
    setDraft(undefined);
    setReceipt("");
  }, [taskId, artifact]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 附图是给 Agent 看的(设计稿、期望效果):先上传成检视图片资产拿路径,
  // 记下时随批注引用。粘贴截图与选文件同一条路。
  const [images, setImages] = useState<Array<AnnotationImage & { preview: string }>>([]);
  const [uploading, setUploading] = useState(0);
  const fileInput = useRef<HTMLInputElement | null>(null);

  async function attachFiles(files: Iterable<File>) {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      setUploading((count) => count + 1);
      try {
        const stored = await uploadAnnotationAsset(taskId, file);
        if (stored.error || !stored.path) {
          setError(stored.error ?? "图片上传失败");
          continue;
        }
        const path = stored.path;
        setImages((current) => current.some((image) => image.path === path) ? current
          : [...current, { path, label: file.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 80),
              preview: URL.createObjectURL(file) }]);
      } finally {
        setUploading((count) => count - 1);
      }
    }
  }
  const [hovered, setHovered] = useState<HTMLElement>();
  const [selected, setSelected] = useState<SelectedBlock>();
  const draftRef = useRef<Draft | undefined>(undefined);
  draftRef.current = draft;

  // 保留选区只为显示显式操作；选择、复制文字不打开编辑框也不抢焦点。
  useEffect(() => {
    setSelected(undefined);
    setHovered(undefined);
    if (!enabled) return;
    function selectionChanged() {
      if (draftRef.current) return;
      const block = selectedBlock();
      setSelected((current) => current?.startRow === block?.startRow
        && current?.focusRow === block?.focusRow
        && current?.lineEnd === block?.lineEnd && current?.quote === block?.quote
        ? current : block);
    }
    document.addEventListener("selectionchange", selectionChanged);
    return () => document.removeEventListener("selectionchange", selectionChanged);
  }, [taskId, artifact, enabled]);

  // 已圈过的行留一道竖杠:人扫一眼就知道自己圈到哪儿了。
  // 每次 items/内容变化都重刷——渲染器可能整块换掉。
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    root.querySelectorAll(".noted").forEach((node) => {
      node.classList.remove("noted", "noted-sent");
    });
    for (const node of root.querySelectorAll<HTMLElement>("[data-l]")) {
      const line = Number(node.dataset.l);
      const file = node.closest<HTMLElement>("[data-file]")?.dataset.file
        ?? fallbackFile;
      const attached = annotationsAtRow(items, { artifact, file, line });
      if (attached.length) {
        node.classList.add("noted");
        if (attached.some((item) => item.status === "sent")) {
          node.classList.add("noted-sent");
        }
      }
    }
  }, [items, artifact, fallbackFile, children]);

  /** 这块材料里划选的那一块(没有就 undefined)。只认落在本材料行里的
   * 选区:别处残留的选中文本不算,也不再让材料"点不动"。 */
  function selectedBlock(): SelectedBlock | undefined {
    const root = host.current;
    if (!root || typeof window === "undefined") return undefined;
    const selection = window.getSelection();
    const rowOf = (node: unknown) => {
      if (!(node instanceof Node) || !root.contains(node)) return undefined;
      const element = node instanceof Element ? node : node.parentElement;
      return element?.closest<HTMLElement>("[data-l]");
    };
    const block = quoteOfSelection(selection, (node) => rowOf(node) as unknown as RowNode | undefined);
    const focusRow = rowOf(selection?.focusNode);
    // 操作跟着拖选结束的位置；跨多段选择时，起始行可能已经滚出屏幕。
    return block && focusRow ? { ...block, focusRow } : undefined;
  }

  function openRow(row: HTMLElement, block = selectedBlock()) {
    // 划选了一块就圈这一块:编辑框与锚点挂在靠前那一行,整块原文另带。
    // 原来"材料里有选区就不开框"——按行圈不够用,记为记忆常常要带一整段
    // 语境(用户拍板)。
    if (block) row = block.startRow as unknown as HTMLElement;
    const line = Number(row.dataset.l);
    if (!Number.isFinite(line) || line <= 0) return;
    setError("");
    setThread(undefined);
    setReceipt("");
    setSelected(undefined);
    setNote("");
    setDraft({
      file: row.closest<HTMLElement>("[data-file]")?.dataset.file
        ?? fallbackFile,
      line,
      // 空行/图块也允许圈:锚点退回"第 N 行"。原来空快照直接放弃,
      // 点了什么都不发生——沉默比拒绝更难查。
      anchor: anchorOf(row as unknown as RowNode, line),
      ...(block ? { quote: block.quote, lineEnd: block.lineEnd } : {}),
      kind,
      host: row,
    });
    setHovered(undefined);
  }

  function track(event: React.MouseEvent) {
    if (draft) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest || target.closest(".annot-fab, .annot-editor")) return;
    const row = target.closest<HTMLElement>("[data-l]");
    setHovered((current) => current === row ? current : row ?? undefined);
  }

  const hoveredAnnotations = hovered ? annotationsAtRow(items, {
    artifact,
    file: hovered.closest<HTMLElement>("[data-file]")?.dataset.file
      ?? fallbackFile,
    line: Number(hovered.dataset.l),
  }) : [];

  async function save() {
    if (!draft || busy) return;
    const text = note.trim();
    if (!text) return;
    setBusy(true);
    setError("");
    try {
      const result = addDraft
        ? await addDraft({ line: draft.line, anchor: draft.anchor, note: text,
            quote: draft.quote, line_end: draft.lineEnd })
        : await addAnnotation(taskId, {
          artifact,
          file: draft.file,
          line: draft.line,
          anchor: draft.anchor,
          note: text,
          kind: draft.kind,
          route: "owner_reply",
          ...(draft.quote ? { quote: draft.quote, line_end: draft.lineEnd } : {}),
          ...(images.length ? { images: images.map(({ path, label }) => ({ path, ...(label ? { label } : {}) })) } : {}),
        });
      if (result.error) {
        setError(result.error);
        return;
      }
      const annotation = "annotation" in result ? result.annotation : undefined;
      if (annotation && typeof annotation === "object" && "id" in annotation) {
        const id = String(annotation.id);
        if (renderInlineReview) setThread({ ids: [id], host: draft.host });
        setReceipt("已记下，责任人可在待处理中查看。");
      }
      setDraft(undefined);
      setNote("");
      onAdded();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "批注保存失败，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`annotatable${enabled ? "" : " is-readonly"}`}
      ref={host}
      onMouseMove={track}
      onMouseLeave={() => setHovered(undefined)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setSelected(undefined);
      }}
    >
      {children}
      {enabled && selected && !draft ? (
        <button type="button" className="annot-fab annot-selection-fab"
          style={fabPosition(selected.focusRow, host.current, 132)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => openRow(selected.startRow as unknown as HTMLElement, selected)}>
          <svg viewBox="0 0 20 20" aria-hidden>
            <path d="M4.25 5.25A2.25 2.25 0 0 1 6.5 3h7A2.25 2.25 0 0 1 15.75 5.25v5.5A2.25 2.25 0 0 1 13.5 13h-4l-3.25 2.5V13A2.25 2.25 0 0 1 4 10.75v-5.5Z" />
            <path d="M10 6v4M8 8h4" />
          </svg>
          批注选中内容
        </button>
      ) : hovered && !draft && hoveredAnnotations.length > 0
          && onOpenAnnotations ? (
        <button
          type="button"
          className="annot-fab annot-review-fab"
          aria-label={`查看这行的 ${hoveredAnnotations.length} 条检视意见`}
          data-tip={`查看 ${hoveredAnnotations.length} 条检视意见`}
          style={fabPosition(hovered, host.current)}
          onClick={(event) => {
            event.stopPropagation();
            const ids = hoveredAnnotations.map((item) => item.id);
            if (renderInlineReview) {
              setReceipt("");
              setThread({ ids, host: hovered });
            } else onOpenAnnotations(ids);
          }}
        >
          <svg viewBox="0 0 20 20" aria-hidden>
            <path d="M4.25 5.25A2.25 2.25 0 0 1 6.5 3h7A2.25 2.25 0 0 1 15.75 5.25v5.5A2.25 2.25 0 0 1 13.5 13h-4l-3.25 2.5V13A2.25 2.25 0 0 1 4 10.75v-5.5Z" />
          </svg>
          <b>{hoveredAnnotations.length}</b>
        </button>
      ) : enabled && hovered && !draft && (
        <button
          type="button"
          className="annot-fab"
          aria-label={`给第 ${hovered.dataset.l} 行添加批注`}
          style={fabPosition(hovered, host.current)}
          onClick={(event) => {
            event.stopPropagation();
            openRow(hovered);
          }}
        >
          <svg viewBox="0 0 20 20" aria-hidden>
            <path d="M4.25 5.25A2.25 2.25 0 0 1 6.5 3h7A2.25 2.25 0 0 1 15.75 5.25v5.5A2.25 2.25 0 0 1 13.5 13h-4l-3.25 2.5V13A2.25 2.25 0 0 1 4 10.75v-5.5Z" />
            <path d="M10 6v4M8 8h4" />
          </svg>
        </button>
      )}
      {thread && renderInlineReview && !draft && (
        <section className="workspace-inline-review annot-editor"
          aria-label="当前位置的反馈与回应"
          onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setThread(undefined); } }}
          style={editorPosition(thread.host, host.current)}
          onClick={(event) => event.stopPropagation()}>
          <header className="workspace-inline-review-head">
            <strong>此处的反馈与回应</strong>
            {enabled && <button type="button" onClick={() => openRow(thread.host)}>补充批注</button>}
            <button type="button" aria-label="收起当前位置反馈" onClick={() => setThread(undefined)}>×</button>
          </header>
          {receipt && <p className="annotation-delivery-receipt" role="status">{receipt}</p>}
          {renderInlineReview(thread.ids)}
        </section>
      )}
      {draft && (
        <div
          className="annot-editor"
          style={editorPosition(draft.host, host.current)}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="annot-editor-head">
            <span>{draft.lineEnd && draft.lineEnd > draft.line
              ? `第 ${draft.line}–${draft.lineEnd} 行` : `第 ${draft.line} 行`}
              {draft.quote ? ` · 选中 ${draft.quote.length} 字` : ""}</span>
            {!draft.quote && <code>{draft.anchor}</code>}
          </div>
          {draft.quote && <blockquote className="annot-editor-quote">
            {draft.quote}</blockquote>}
          <textarea
            autoFocus
            rows={2}
            className="min-h-16"
            value={note}
            placeholder="写下检视意见…"
            onChange={(event) => setNote(event.target.value)}
            onPaste={(event) => {
              const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
              if (!files.length) return;
              event.preventDefault();
              void attachFiles(files);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDraft(undefined);
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void save();
              }
            }}
          />
            <div className="annot-editor-images">
              {images.map((image) => (
                <span key={image.path} className="annot-image-chip" title={image.path}>
                  <img src={image.preview} alt={image.label ?? "附图"} />
                  <button type="button" aria-label="移除这张图"
                    onClick={() => setImages((current) => current.filter((item) => item.path !== image.path))}>×</button>
                </span>
              ))}
              <button type="button" className="annot-image-add" title="添加参考图片，也可以直接粘贴截图" disabled={busy}
                onClick={() => fileInput.current?.click()}>
                {uploading > 0 ? "上传中…" : images.length ? "继续添加图片" : "添加图片"}
              </button>
              <input ref={fileInput} type="file" accept="image/*" multiple hidden
                onChange={(event) => {
                  void attachFiles(event.target.files ?? []);
                  event.target.value = "";
                }} />
            </div>
          {error && <div className="alert">{error}</div>}
          <div className="annot-editor-actions">
            <span>⌘/Ctrl + Enter 记下 · Esc 取消</span>
            <button type="button" className="ghost"
                    onClick={() => { setDraft(undefined); setImages([]); }}>取消</button>
            <button type="button" className="primary"
                    disabled={busy || !note.trim()}
                    onClick={() => void save()}>
              {busy ? "保存中…" : "记下"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 图标跟着行尾,但永远夹在可视内容宽度内；长 diff 不会把按钮甩到横向
 * 滚动区之外。 */
function fabPosition(
  row: HTMLElement,
  root: HTMLElement | null,
  width = 32,
): React.CSSProperties {
  if (!root) return {};
  const rowBox = row.getBoundingClientRect();
  // 专注审阅器是 fixed 全屏层,脱离了外层材料区的排版流。此时按钮也
  // 必须按视口定位并抬到审阅器上方,否则会算到原来那块 639px 容器里。
  if (row.closest(".git-change-view.is-focused")) {
    const size = 32;
    return {
      position: "fixed",
      zIndex: 260,
      top: rowBox.top + Math.max(2, (rowBox.height - size) / 2),
      left: Math.max(7, Math.min(window.innerWidth - width - 7, rowBox.right - width - 6)),
    };
  }
  const rootBox = root.getBoundingClientRect();
  const size = 32;
  const rowRight = rowBox.right - rootBox.left + root.scrollLeft;
  const left = Math.max(4, Math.min(root.clientWidth - width - 6, rowRight - width - 5));
  const top = rowBox.top - rootBox.top + root.scrollTop
    + Math.max(2, Math.min(8, (rowBox.height - size) / 2));
  return { top, left };
}

/** 编辑框贴在被圈那一行下面。用绝对定位而不是插进 DOM:插进去会打乱
 * 渲染器的结构(列表里塞进两个 li 之间就是坏结构),而且 React 下次
 * 重渲染会把它抹掉。 */
function editorPosition(
  row: HTMLElement,
  root: HTMLElement | null,
): React.CSSProperties {
  if (!root) return {};
  const rowBox = row.getBoundingClientRect();
  if (row.closest(".git-change-view.is-focused")) {
    const width = Math.min(540, window.innerWidth - 32);
    return {
      position: "fixed",
      zIndex: 270,
      width,
      top: Math.max(16, Math.min(rowBox.bottom + 5, window.innerHeight - 270)),
      left: Math.max(16, Math.min(rowBox.left, window.innerWidth - width - 16)),
    };
  }
  const rootBox = root.getBoundingClientRect();
  return {
    top: Math.max(0, Math.min(rowBox.bottom + 4,
      window.innerHeight - Math.min(380, window.innerHeight * .65))
      - rootBox.top + root.scrollTop),
    left: 0,
    right: 0,
  };
}
