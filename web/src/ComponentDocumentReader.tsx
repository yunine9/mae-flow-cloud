import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { knowledgeAnchorLine, knowledgeHeadingTree, resolveKnowledgeReference, type KnowledgeHeading } from "./knowledgeStructure";
import { Markdown } from "./markdown";

export interface ComponentReaderFile { id: string; path: string[]; content?: string; searchText?: string; metadata?: string }

/** 文件路径只用于阅读导航，保留原始 Markdown 与程序化产物，不重新生成知识。 */
export function ComponentDocumentReader({ files, selected, onSelect, actions, message, contentLabel = "知识正文", treeLabel = "文档目录", height = "calc(100dvh - 240px)", allowRaw = false }: {
  files: ComponentReaderFile[]; selected: string; onSelect: (id: string) => void; actions?: ReactNode; message?: ReactNode;
  contentLabel?: string; treeLabel?: string; height?: string; allowRaw?: boolean;
}) {
  const [fullscreen, setFullscreen] = useState(false), [showTree, setShowTree] = useState(true);
  const [query, setQuery] = useState(""), [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [raw, setRaw] = useState(false), [linkError, setLinkError] = useState("");
  const [outlines, setOutlines] = useState<Set<string>>(new Set());
  const [jump, setJump] = useState<{ id: string; line: number }>();
  const scroll = useRef(0), reader = useRef<HTMLDivElement>(null);
  const file = files.find(f => f.id === selected);
  const needle = query.trim().toLowerCase();
  const visible = files.filter(f => !needle || `${f.path.join("/")} ${f.searchText ?? ""}`.toLowerCase().includes(needle));
  useEffect(() => { setLinkError(""); scroll.current = 0; reader.current?.scrollTo(0, 0); }, [selected]);
  useEffect(() => {
    if (!jump || jump.id !== selected || file?.content === undefined) return;
    const target = reader.current?.querySelector<HTMLElement>(`[data-l="${jump.line}"]`);
    if (target && reader.current) { reader.current.scrollTop += target.getBoundingClientRect().top - reader.current.getBoundingClientRect().top - 20; target.tabIndex = -1; target.focus({ preventScroll: true }); }
  }, [jump, selected, file?.content]);
  function openReference(href: string) {
    if (!href.startsWith("#")) {
      if (!file) return;
      const entries = files.map(f => ({ ...f, path: f.path.join("/"), target_id: "files" }));
      const reference = resolveKnowledgeReference(entries, entries.find(f => f.id === file.id)!, href);
      if (!reference || (reference.anchor && !knowledgeAnchorLine(reference.item.content ?? "", reference.anchor))) { setLinkError("当前文件包中未找到这个文件或章节。"); return; }
      setLinkError(""); setRaw(false); onSelect(reference.item.id); setJump({ id: reference.item.id, line: knowledgeAnchorLine(reference.item.content ?? "", reference.anchor) ?? 1 }); return;
    }
    let anchor: string;
    try { anchor = decodeURIComponent(href.slice(1)); } catch { setLinkError("章节链接格式无效。"); return; }
    const target = [file, ...files.filter(f => f !== file)].find(f => f && (f.id === anchor || `component-${f.id}` === anchor || knowledgeAnchorLine(f.content ?? "", anchor)));
    if (!target) { setLinkError("当前文档中未找到这个章节。"); return; }
    setLinkError(""); onSelect(target.id); setJump({ id: target.id, line: knowledgeAnchorLine(target.content ?? "", anchor) ?? 1 });
  }
  function headings(nodes: KnowledgeHeading[], id: string): ReactNode {
    return <ul className="list-none space-y-1 pl-3">{nodes.map(node => <li key={node.line} className="list-none">{node.children.length ? <details><summary className="cursor-pointer truncate py-1" title={node.title}>{node.title}</summary>{headings([ { ...node, children: [] }, ...node.children ], id)}</details> : <button className="block w-full truncate rounded px-2 py-1 text-left text-muted-foreground hover:bg-surface-2 hover:text-primary" title={node.title} onClick={() => { setRaw(false); onSelect(id); setJump({ id, line: node.line }); }}>{node.title}</button>}</li>)}</ul>;
  }
  function toggleFolder(key: string) { setCollapsed(old => { const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next; }); }
  function tree(rows: ComponentReaderFile[], depth = 0, parent: string[] = []): ReactNode {
    const folders = [...new Set(rows.filter(f => f.path.length > depth + 1).map(f => f.path[depth]))];
    return <ul className="m-0 list-none space-y-1 p-0">{folders.map(folder => {
      const key = JSON.stringify([...parent, folder]), expanded = !!needle || !collapsed.has(key);
      return <li key={key} className="list-none"><button className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-surface-2" aria-expanded={expanded} onClick={() => toggleFolder(key)} title={folder}>
        {expanded ? <ChevronDown size={15} className="shrink-0" /> : <ChevronRight size={15} className="shrink-0" />}<Folder size={16} className="shrink-0 text-muted-foreground" /><span className="truncate font-medium">{folder}</span>
      </button>{expanded && <div className="ml-3 border-l border-line pl-2">{tree(rows.filter(f => f.path[depth] === folder), depth + 1, [...parent, folder])}</div>}</li>;
    })}{rows.filter(f => f.path.length === depth + 1).map(f => {
      const outline = f.content !== undefined && /\.md$/i.test(f.path.at(-1) ?? "") ? knowledgeHeadingTree(f.content) : [];
      return <li key={f.id} className="list-none"><div className={`flex items-start rounded-md ${f.id === selected ? "bg-primary/10 text-primary" : "hover:bg-surface-2"}`}>
        {!!outline.length && <button className="shrink-0 py-3 pl-1" aria-label={`${outlines.has(f.id) ? "收起" : "展开"}章节 ${f.path.at(-1)}`} aria-expanded={outlines.has(f.id)} onClick={() => setOutlines(old => { const next = new Set(old); if (next.has(f.id)) next.delete(f.id); else next.add(f.id); return next; })}>{outlines.has(f.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>}
        <button title={f.path.at(-1)} aria-current={f.id === selected ? "page" : undefined} className="flex min-w-0 flex-1 items-start gap-2 px-2 py-2.5 text-left" onClick={() => { setJump(undefined); onSelect(f.id); }}><FileText size={16} className="mt-0.5 shrink-0" /><span className="line-clamp-2 break-words">{f.path.at(-1)}</span></button></div>
        {outlines.has(f.id) && headings(outline, f.id)}
      </li>;
    })}</ul>;
  }
  const body = <div className="flex h-full min-h-0 flex-col overflow-hidden bg-surface text-base">
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-3">
      <Button size="icon" variant="ghost" aria-label={showTree ? "收起目录" : "展开目录"} title={showTree ? "收起目录" : "展开目录"} onClick={() => setShowTree(!showTree)}>{showTree ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}</Button>
      <span className="min-w-0 flex-1 truncate font-medium" title={file?.path.join(" / ")}>{file?.path.at(-1) ?? "文档"}</span>
      {allowRaw && /\.md$/i.test(file?.path.at(-1) ?? "") && <Button variant="ghost" onClick={() => setRaw(!raw)}>{raw ? "阅读" : "原文"}</Button>}
      {actions}
      <Button size="icon" variant="ghost" aria-label={fullscreen ? "退出全屏" : "全屏阅读"} title={fullscreen ? "退出全屏" : "全屏阅读"} onClick={() => setFullscreen(!fullscreen)}>{fullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</Button>
    </header>
    <div className="flex min-h-0 flex-1">
      {showTree && <nav className="flex w-[260px] shrink-0 flex-col border-r border-line bg-surface-2/30" aria-label={treeLabel}>
        <div className="relative p-3"><Search size={16} className="absolute left-6 top-6 text-muted-foreground" /><Input aria-label="搜索文档" placeholder="搜索文档" className="pl-9" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2 text-sm">{tree(visible)}{!visible.length && <p className="p-3 text-muted-foreground">{query ? "没有匹配的文档" : "暂无文档"}</p>}</div>
      </nav>}
      <div ref={node => { reader.current = node; if (node) node.scrollTop = scroll.current; }} onScroll={e => { scroll.current = e.currentTarget.scrollTop; }} tabIndex={0} aria-label={contentLabel} className="min-w-0 flex-1 overflow-auto overscroll-contain px-8 py-7 outline-none">
        {linkError && <p role="status" className="mb-4 text-attention">{linkError}</p>}
        {message ?? (file?.content === undefined ? <p className="text-muted-foreground">{file ? "正在读取文档…" : "选择一篇文档开始阅读"}</p> : /\.md$/i.test(file.path.at(-1) ?? "") && !raw ? <>
          {/^---\r?\n/.test(file.content) && <details className="mb-5"><summary className="cursor-pointer text-sm text-muted-foreground">文档元数据</summary><pre className="overflow-auto whitespace-pre p-3 text-sm">{file.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]}</pre></details>}
          <Markdown text={file.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, frontmatter => frontmatter.replace(/[^\r\n]/g, ""))} onOpenKnowledgeLink={openReference} />
        </> : <pre className="whitespace-pre text-sm leading-relaxed">{file.content}</pre>)}
        {file?.metadata && <details className="mt-8 border-t border-line pt-4"><summary className="cursor-pointer text-sm text-muted-foreground">结构化字段</summary><pre className="mt-3 overflow-auto whitespace-pre-wrap break-words text-sm">{file.metadata}</pre></details>}
      </div>
    </div>
  </div>;
  return <>
    {!fullscreen && <div className="min-h-[360px] overflow-hidden rounded-lg border border-line" style={{ height }}>{body}</div>}
    <Dialog open={fullscreen} onOpenChange={setFullscreen}><DialogContent showCloseButton={false} style={{ animation: "none" }} className="tw-root h-[100dvh] w-[100vw] max-w-none gap-0 overflow-hidden rounded-none p-0 sm:max-w-none"><DialogTitle className="sr-only">文档全屏阅读</DialogTitle>{fullscreen && body}</DialogContent></Dialog>
  </>;
}
