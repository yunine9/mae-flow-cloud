import { useEffect, useRef, useState } from "react";
import { Markdown } from "./markdown";
import { knowledgeAnchorLine, knowledgeHeadings } from "./knowledgeStructure";
export interface KnowledgeFocus { line?: number; anchor?: string; token: number }
export function KnowledgeMarkdown({ text, focus, onReference }: { text: string; focus?: KnowledgeFocus; onReference?: (href: string) => boolean }) {
  const root = useRef<HTMLDivElement>(null), [notice, setNotice] = useState("");
  function navigate(line?: number, anchor?: string) {
    const number = anchor ? knowledgeAnchorLine(text, anchor) : line;
    const target = number ? [...(root.current?.querySelectorAll<HTMLElement>("[data-l]") ?? [])].find(el => Number(el.dataset.l) === number) : root.current;
    if (!target) { setNotice("当前知识中未找到这个章节。"); return; }
    setNotice("");
    let panel = root.current?.parentElement;
    while (panel && !/(auto|scroll)/.test(getComputedStyle(panel).overflowY)) panel = panel.parentElement;
    if (panel) panel.scrollTo({ top: !number && !panel.classList.contains("research-full-document") ? 0 : panel.scrollTop + target.getBoundingClientRect().top - panel.getBoundingClientRect().top - 12, behavior: "instant" });
    target.tabIndex = -1; target.focus({ preventScroll: true });
  }
  useEffect(() => { setNotice(""); if (focus) navigate(focus.line, focus.anchor); }, [focus?.token]);
  return <div ref={root} className="knowledge-markdown">
    <details className="knowledge-document-outline"><summary>本文目录 · {knowledgeHeadings(text).length} 个章节</summary><nav aria-label="本文目录">{knowledgeHeadings(text).map(h => <button key={h.line} style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }} onClick={() => navigate(h.line)}>{h.title}</button>)}</nav></details>
    {notice && <p role="status" className="mb-3 text-sm text-muted-foreground">{notice}</p>}
    <Markdown text={text} onOpenKnowledgeLink={href => {
      if (href.startsWith("#")) { try { navigate(undefined, decodeURIComponent(href.slice(1))); } catch { setNotice("章节链接格式无效。"); } }
      else if (!onReference?.(href)) setNotice("这个链接对应的内容尚未包含在本次萃取成果中。");
    }} />
  </div>;
}
