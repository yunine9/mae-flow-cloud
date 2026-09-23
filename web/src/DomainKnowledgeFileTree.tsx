import { useState } from "react";
import { FileText, Folder, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { DomainKnowledgeJob } from "../../src/domainKnowledgeTypes";

export function DomainKnowledgeFileTree({ job, currentId, disabled, onNavigate, onSelection }: {
  job: DomainKnowledgeJob; currentId?: string; disabled?: boolean;
  onNavigate: (id: string) => void; onSelection: (id: string, selected: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const targets = [job.knowledge_target, ...job.repositories];
  return <aside className="research-capabilities" aria-label="领域知识文件导航">
    <div className="research-capabilities-header"><strong>知识文件 <span>{job.documents.length} 个文件</span></strong>
      <div className="research-capability-search"><Search size={16} /><Input aria-label="搜索知识文件" placeholder="搜索仓库、文件名…" value={query} onChange={e => setQuery(e.target.value)} /></div>
    </div>
    <nav className="research-capability-list" aria-label="知识仓库与文件"><ul className="space-y-3 p-3">{targets.map(target => {
      const docs = job.documents.filter(doc => doc.target_id === target.id && (!needle || `${target.name} ${doc.path}`.toLocaleLowerCase().includes(needle))).sort((a, b) => a.path.localeCompare(b.path));
      if (!docs.length) return null;
      return <li key={target.id}><details open><summary className="cursor-pointer py-2 font-medium" title={target.repository}><Folder size={15} className="mr-2 inline" />{target.name || "知识仓"}<span className="ml-2 text-xs text-muted-foreground">{docs.length}</span></summary>
        <ul className="ml-3 border-l border-line pl-2">{docs.map(doc => {
          const filename = doc.path.split("/").at(-1)!;
          const label = docs.some(other => other.id !== doc.id && other.path.split("/").at(-1) === filename) ? doc.path : filename;
          return <li key={doc.id} className="flex min-w-0 items-center gap-2 py-1">
            <input type="checkbox" aria-label={`归档 ${doc.path}`} checked={doc.selected} disabled={disabled} onChange={e => onSelection(doc.id, e.target.checked)} />
            <button className={`flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2 text-left text-sm ${currentId === doc.id ? "bg-primary/10 text-primary" : "hover:bg-muted"}`} title={doc.path} aria-current={currentId === doc.id ? "page" : undefined} onClick={() => onNavigate(doc.id)}><FileText size={15} className="shrink-0" /><span className="truncate">{label}</span></button>
          </li>;
        })}</ul>
      </details></li>;
    })}</ul>{!job.documents.length && <p className="p-3 text-sm text-muted-foreground">生成的知识文件会显示在这里。</p>}</nav>
  </aside>;
}
