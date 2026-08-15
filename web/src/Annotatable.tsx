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
import { addAnnotation, type Annotation } from "./api";
import "./annotate.css";

/** 原文快照的长度上限,和内核面板一致:够定位,又不至于把整段搬走。 */
const ANCHOR_MAX = 90;

interface Draft {
  file: string;
  line: number;
  anchor: string;
  kind: "doc" | "code";
  /** 编辑框挂在哪个元素后面。 */
  host: HTMLElement;
}

function anchorOf(node: HTMLElement): string {
  const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.length > ANCHOR_MAX ? text.slice(0, ANCHOR_MAX) : text;
}

export function Annotatable({
  taskId,
  artifact,
  fallbackFile,
  kind,
  items,
  onAdded,
  children,
}: {
  taskId: string;
  artifact: string;
  /** 文档没有 data-file,用产物名当路径。 */
  fallbackFile: string;
  kind: "doc" | "code";
  /** 已有批注:用来在材料上标出"这几处我圈过"。 */
  items: Annotation[];
  onAdded: () => void;
  children: React.ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft>();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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

  function open(event: React.MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (!target?.closest) return;
    // 划词是在读,不是要批注——有选区就别弹编辑框(内核那条经验)。
    if (String(window.getSelection() ?? "").trim()) return;
    if (target.closest("button, a, textarea, input, .annot-editor")) return;
    const row = target.closest<HTMLElement>("[data-l]");
    if (!row) return;
    const line = Number(row.dataset.l);
    if (!Number.isFinite(line) || line <= 0) return;
    const anchor = anchorOf(row);
    if (!anchor) return;
    setError("");
    setNote("");
    setDraft({
      file: row.closest<HTMLElement>("[data-file]")?.dataset.file
        ?? fallbackFile,
      line,
      anchor,
      kind,
      host: row,
    });
  }

  async function save() {
    if (!draft || busy) return;
    const text = note.trim();
    if (!text) return;
    setBusy(true);
    const result = await addAnnotation(taskId, {
      artifact,
      file: draft.file,
      line: draft.line,
      anchor: draft.anchor,
      note: text,
      kind: draft.kind,
    });
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setDraft(undefined);
    setNote("");
    onAdded();
  }

  return (
    <div className="annotatable" ref={host} onClick={open}>
      {children}
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

/** 编辑框贴在被圈那一行下面。用绝对定位而不是插进 DOM:插进去会打乱
 * 渲染器的结构(列表里塞进两个 li 之间就是坏结构),而且 React 下次
 * 重渲染会把它抹掉。 */
function editorPosition(
  row: HTMLElement,
  root: HTMLElement | null,
): React.CSSProperties {
  if (!root) return {};
  const rowBox = row.getBoundingClientRect();
  const rootBox = root.getBoundingClientRect();
  return {
    top: rowBox.bottom - rootBox.top + root.scrollTop + 4,
    left: 0,
    right: 0,
  };
}
