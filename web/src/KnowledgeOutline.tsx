import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { knowledgeHeadingTree, type KnowledgeHeading } from "./knowledgeStructure";

export interface KnowledgeOutlineItem { id: string; title: string; content: string; selected?: boolean; status?: string }
export function KnowledgeOutline({ title, items, currentId, onNavigate, onSelection, disabled, selectionPrefix = "纳入", actions, label = "知识结构导航" }: {
  title: string; items: KnowledgeOutlineItem[]; currentId?: string; onNavigate: (id: string, line?: number) => void;
  onSelection?: (id: string, selected: boolean) => void; disabled?: boolean; selectionPrefix?: string;
  actions?: ReactNode; label?: string;
}) {
  const [query, setQuery] = useState(""), [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const needle = query.trim().toLocaleLowerCase();
  const entries = items.map(item => ({ ...item, headings: knowledgeHeadingTree(item.content) }));
  function match(nodes: KnowledgeHeading[]): boolean { return nodes.some(n => n.title.toLocaleLowerCase().includes(needle) || match(n.children)); }
  const visible = entries.filter(item => !needle || item.title.toLocaleLowerCase().includes(needle) || match(item.headings));
  function headings(nodes: KnowledgeHeading[], id: string) {
    return <ul className="knowledge-outline-headings">{nodes.map(node => <li key={node.line}><button title={node.title} onClick={() => onNavigate(id, node.line)}>{node.title}</button>{!!node.children.length && headings(node.children, id)}</li>)}</ul>;
  }
  return <aside className="research-capabilities knowledge-outline" aria-label={label}>
    <div className="research-capabilities-header"><strong>知识结构 <span>{items.length} 个主题</span></strong><p className="knowledge-outline-root">{title}</p>
      <div className="research-capability-search"><Search size={16} /><Input aria-label="搜索知识主题或章节" placeholder="搜索主题、章节…" value={query} onChange={e => setQuery(e.target.value)} /></div>
      {actions && <div className="research-selection-actions">{actions}</div>}
    </div>
    <nav className="research-capability-list" aria-label="知识主题与章节"><ul className="knowledge-outline-topics">{visible.map(item => {
      const open = !!needle || (expanded[item.id] ?? item.id === currentId);
      return <li key={item.id} className={item.id === currentId ? "is-current" : ""}>
        <div className="knowledge-outline-topic">
          <button className="knowledge-outline-expand" aria-label={`${open ? "收起" : "展开"} ${item.title}`} aria-expanded={open} disabled={!item.headings.length} onClick={() => setExpanded(old => ({ ...old, [item.id]: !open }))}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
          {onSelection && <input type="checkbox" aria-label={`${selectionPrefix} ${item.title}`} checked={item.selected} disabled={disabled} onChange={e => onSelection(item.id, e.target.checked)} />}
          <button className="knowledge-outline-title" aria-current={item.id === currentId ? "page" : undefined} onClick={() => { setExpanded(old => ({ ...old, [item.id]: true })); onNavigate(item.id); }}><strong>{item.title}</strong>{item.status && <small>{item.status}</small>}</button>
        </div>
        {open && headings(item.headings, item.id)}
      </li>;
    })}</ul>{!visible.length && <p className="p-3 text-sm text-muted-foreground">{items.length ? "没有匹配的知识主题或章节。" : "萃取结果会逐步出现在这里。"}</p>}</nav>
  </aside>;
}
