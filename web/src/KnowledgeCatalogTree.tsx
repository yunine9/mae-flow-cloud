import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FileText, Folder } from "lucide-react";
import type { KnowledgeDocument } from "./knowledgeDocumentsApi";

export function knowledgeDocumentPath(doc: KnowledgeDocument): string[] {
  if (doc.source) {
    let repository = doc.source.repository;
    try { const url = new URL(repository); repository = `${url.host}${url.pathname}`; } catch { /* 保留非 URL 仓库名称。 */ }
    return [`${repository.replace(/\.git$/, "") || "知识仓"} · ${doc.source.branch}`, ...doc.source.path.split("/").filter(Boolean)];
  }
  return [doc.scope_label || "上传文档", /\.md$/i.test(doc.title) ? doc.title : `${doc.title}.md`];
}

export function KnowledgeCatalogTree({ documents, selected, onSelect }: {
  documents: KnowledgeDocument[]; selected: string; onSelect: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const rows = documents.map(doc => ({ doc, path: knowledgeDocumentPath(doc) }));
  useEffect(() => {
    const row = rows.find(row => row.doc.id === selected);
    if (row) setCollapsed(old => { const next = new Set(old); row.path.slice(0, -1).forEach((_, index) => next.delete(JSON.stringify(row.path.slice(0, index + 1)))); return next; });
  }, [selected]);
  function tree(items: typeof rows, depth = 0, parent: string[] = []): ReactNode {
    const folders = [...new Set(items.filter(row => row.path.length > depth + 1).map(row => row.path[depth]))].sort();
    return <ul>{folders.map(folder => {
      const key = JSON.stringify([...parent, folder]), open = !collapsed.has(key);
      return <li key={key}><button aria-expanded={open} title={folder} onClick={() => setCollapsed(old => { const next = new Set(old); open ? next.add(key) : next.delete(key); return next; })}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}<Folder size={17} /><span>{folder}</span>
      </button>{open && tree(items.filter(row => row.path[depth] === folder), depth + 1, [...parent, folder])}</li>;
    })}{items.filter(row => row.path.length === depth + 1).map(({ doc, path }) => <li key={doc.id}>
      <button title={path.join("/")} aria-current={selected === doc.id ? "page" : undefined} onClick={() => onSelect(doc.id)}><FileText size={17} /><span>{path.at(-1)}</span></button>
    </li>)}</ul>;
  }
  return <nav className="knowledge-catalog-tree" aria-label="知识文件目录">{tree(rows)}</nav>;
}
