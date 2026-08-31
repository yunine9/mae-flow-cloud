/**
 * 批注层:把任何带 `data-l`(源行号)的材料变成可圈注的。
 *
 * 用事件委托而不是给渲染器加回调——Markdown 和 GitDiff 因此完全不需要
 * 知道"批注"这回事,只管吐出 `data-l` / `data-file`。内核面板也是这么
 * 分层的,两边语义对得上。
 *
 * 手感上只有一件事:悬停出 ✎,点一下原地展开输入框,写完收起。
 * 没有模式开关、没有工具栏、没有"提交批注"按钮——那些都是把圈注变回填表。
 */

import { useEffect, useRef, useState } from "react";
import { addAnnotation } from "./api";
import {
  anchorOf, blockedBySelection, pickRow, pickRowFromStack, type RowNode,
} from "./annotateTargets";
import "./annotate.css";

interface Draft {
  file: string;
  line: number;
  anchor: string;
  kind: "doc" | "code";
  /** 编辑框挂在哪个元素后面。 */
  host: HTMLElement;
}

export function Annotatable({
  taskId,
  artifact,
  fallbackFile,
  kind,
  items,
  enabled = true,
  onAdded,
  addDraft,
  children,
}: {
  taskId: string;
  artifact: string;
  /** 文档没有 data-file,用产物名当路径。 */
  fallbackFile: string;
  kind: "doc" | "code";
  /** 已有圈注:用来在材料上标出"这几处我圈过"。只要这三个字段——
   * 任务批注与问题域检视意见两种账都能结构兼容,不必互为类型。 */
  items: ReadonlyArray<{ artifact: string; line: number; status: string }>;
  /** 用户停止后材料仍可读但不新增；已交付任务仍可留下归档批注。 */
  enabled?: boolean;
  onAdded: () => void;
  /** 圈注落账的替代口(问题域检视,ADR-0007):给了就走它,不给走
   * 任务流 addAnnotation。交互两域同一套,只有提交端点不同。 */
  addDraft?: (input: {
    line: number;
    anchor: string;
    note: string;
  }) => Promise<{ error?: string }>;
  children: React.ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft>();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 点了但没开成框时的一句人话:功能"点不了"的投诉里,多数其实是
  // 落点没命中行,而代码原来一声不吭。
  const [hint, setHint] = useState("");
  const [hovered, setHovered] = useState<HTMLElement>();

  // 已圈过的行留一道竖杠:人扫一眼就知道自己圈到哪儿了。
  // 每次 items/内容变化都重刷——渲染器可能整块换掉。
  useEffect(() => {
    const root = host.current;
    if (!root) return;
    root.querySelectorAll(".noted").forEach((node) => {
      node.classList.remove("noted", "noted-sent");
    });
    for (const item of items) {
      if (item.artifact !== artifact) continue;
      for (const node of root.querySelectorAll<HTMLElement>("[data-l]")) {
        if (Number(node.dataset.l) !== item.line) continue;
        node.classList.add("noted");
        if (item.status === "sent") node.classList.add("noted-sent");
      }
    }
  }, [items, artifact, children]);

  function openRow(row: HTMLElement) {
    // 划词是在读,不是要批注——但只认**这块材料里**的划词:原来只要
    // 页面上任何地方残留一段选中文本,整块材料就点不动(用户看到的正是
    // "批注功能点不了"),而那段选区多半来自别处、甚至上一次搜索。
    const root = host.current;
    if (blockedBySelection(window.getSelection(), (node) =>
      !!node && !!root && root.contains(node as Node))) {
      setHint("正在划词?松开鼠标、点一下空白处取消选择,再点这一行圈注");
      return;
    }
    const line = Number(row.dataset.l);
    if (!Number.isFinite(line) || line <= 0) return;
    setError("");
    setHint("");
    setNote("");
    setDraft({
      file: row.closest<HTMLElement>("[data-file]")?.dataset.file
        ?? fallbackFile,
      line,
      // 空行/图块也允许圈:锚点退回"第 N 行"。原来空快照直接放弃,
      // 点了什么都不发生——沉默比拒绝更难查。
      anchor: anchorOf(row as unknown as RowNode, line),
      kind,
      host: row,
    });
    setHovered(undefined);
  }

  function open(event: React.MouseEvent) {
    if (!enabled) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest) return;
    const row = pickRow(
      target as unknown as RowNode,
      host.current as unknown as RowNode,
    ) as unknown as HTMLElement | undefined;
    if (row) {
      openRow(row);
      return;
    }
    // 点在交互元素上(按钮/链接)不打扰:那儿有它自己的活。
    if (target.closest("button, a, textarea, input, .annot-editor")) return;
    // 落点被覆盖层挡住(专注审阅的分栏把手正压在行中心,MFC-034):
    // 沿该坐标下的整叠元素穿透找行,不再赌事件恰好命中行节点。
    const covered = typeof document !== "undefined"
      && typeof document.elementsFromPoint === "function"
      ? pickRowFromStack(
          document.elementsFromPoint(event.clientX, event.clientY) as
            unknown as ArrayLike<RowNode>,
          host.current as unknown as RowNode,
          (node) => !!host.current
            && host.current.contains(node as unknown as Node),
        ) as unknown as HTMLElement | undefined
      : undefined;
    if (covered) {
      openRow(covered);
      return;
    }
    // Annotatable 包着整块 Git 审阅器，目录树、标题、分栏把手也都在
    // 它里面。那些控件的空隙不是“材料正文”，点它们不该冒出一条
    // 批注失败提示；只有确实落在文档或 diff 正文里时才解释为何没锚点。
    if (!target.closest(".ws-doc, .diff-review-body")) return;
    // 点在了材料上、却落不到任何一行(容器空隙、纯装饰块):**说一句**,
    // 别装作没点——"点了没反应"是这个功能最常见的投诉,而多数时候它只是
    // 差了这一句话。
    setHint("这一处没有行号可锚定,点正文那一行(标题/段落/列表项/代码行)");
  }

  function track(event: React.MouseEvent) {
    if (!enabled || draft) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest || target.closest(".annot-fab, .annot-editor")) return;
    const row = target.closest<HTMLElement>("[data-l]");
    setHovered((current) => current === row ? current : row ?? undefined);
  }

  async function save() {
    if (!draft || busy) return;
    const text = note.trim();
    if (!text) return;
    setBusy(true);
    setError("");
    try {
      const result = addDraft
        ? await addDraft({ line: draft.line, anchor: draft.anchor, note: text })
        : await addAnnotation(taskId, {
          artifact,
          file: draft.file,
          line: draft.line,
          anchor: draft.anchor,
          note: text,
          kind: draft.kind,
        });
      if (result.error) {
        setError(result.error);
        return;
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
      onClick={open}
      onMouseMove={track}
      onMouseLeave={() => setHovered(undefined)}
    >
      {children}
      {hint && !draft && (
        <div className="annot-hint" role="status" onClick={(event) => {
          event.stopPropagation();
          setHint("");
        }}>{hint}<b>知道了</b></div>
      )}
      {enabled && hovered && !draft && (
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
      {draft && (
        <div
          className="annot-editor"
          style={editorPosition(draft.host, host.current)}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="annot-editor-head">
            <span>第 {draft.line} 行</span>
            <code>{draft.anchor}</code>
          </div>
          <textarea
            autoFocus
            rows={2}
            value={note}
            placeholder="这里要改什么？例如：这个重试应该只对网关失败生效"
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDraft(undefined);
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void save();
              }
            }}
          />
          {error && <div className="alert">{error}</div>}
          <div className="annot-editor-actions">
            <span>⌘/Ctrl + Enter 记下 · Esc 取消</span>
            <button type="button" className="ghost"
                    onClick={() => setDraft(undefined)}>取消</button>
            <button type="button" className="primary"
                    disabled={busy || !note.trim()}
                    onClick={() => void save()}>
              {busy ? "记下中…" : "记下"}
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
      left: Math.min(window.innerWidth - size - 7, rowBox.right - size - 6),
    };
  }
  const rootBox = root.getBoundingClientRect();
  const size = 32;
  const rowRight = rowBox.right - rootBox.left + root.scrollLeft;
  const left = Math.max(4, Math.min(root.clientWidth - size - 6, rowRight - size - 5));
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
      top: Math.min(rowBox.bottom + 5, window.innerHeight - 190),
      left: Math.max(16, Math.min(rowBox.left, window.innerWidth - width - 16)),
    };
  }
  const rootBox = root.getBoundingClientRect();
  return {
    top: rowBox.bottom - rootBox.top + root.scrollTop + 4,
    left: 0,
    right: 0,
  };
}
