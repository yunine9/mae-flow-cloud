import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { componentRequest } from "./componentResearchApi";
import type { DomainKnowledgeJob, KnowledgeRepository } from "../../src/domainKnowledgeTypes";

const targetsOf = (job: DomainKnowledgeJob) => [job.knowledge_target, ...job.repositories];
const filename = (path: string) => path.split("/").at(-1)!;
const pathsOf = (job: DomainKnowledgeJob) => Object.fromEntries(job.documents.map(doc => [doc.id,
  !doc.archive_path && ![...job.publications, ...(job.publication_history ?? [])].some(p => p.target_id === doc.target_id) && /^agents\.md$/i.test(filename(doc.path)) ? "AGENTS.md" : doc.path]));
export function DomainKnowledgeArchiveTargets({ job, disabled, onChange, onBlockedChange, onCompare }: {
  job: DomainKnowledgeJob; disabled?: boolean; onChange: (job: DomainKnowledgeJob) => void;
  onBlockedChange: (blocked: boolean) => void; onCompare: (id: string) => void;
}) {
  const [targets, setTargets] = useState(() => structuredClone(targetsOf(job)));
  const [savedPaths, setPaths] = useState(() => pathsOf(job));
  const paths = { ...pathsOf(job), ...savedPaths };
  const [editing, setEditing] = useState<string>(), [custom, setCustom] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { setTargets(structuredClone(targetsOf(job))); setPaths(pathsOf(job)); setCustom([]); setEditing(undefined); setError(""); }, [job.id, job.archive_revision]);
  const selected = targets.filter(t => job.documents.some(d => d.selected && d.target_id === t.id));
  const changed = selected.some(t => {
    const old = targetsOf(job).find(o => o.id === t.id)!;
    return t.repository !== old.repository || t.branch !== old.branch || t.docs_path !== old.docs_path;
  }) || job.documents.some(doc => doc.selected && paths[doc.id] !== doc.path);
  const invalid = selected.some(t => !t.repository.trim() || !t.branch.trim() || !t.docs_path.trim()) || job.documents.some(doc => doc.selected && !paths[doc.id]?.trim());
  const blocked = busy || changed || invalid || job.archive_configured === false;
  useEffect(() => { onBlockedChange(blocked); }, [blocked, onBlockedChange]);
  function change(id: string, patch: Partial<KnowledgeRepository>) { setTargets(old => old.map(t => t.id === id ? { ...t, ...patch } : t)); }
  function changeDirectory(id: string, directory: string) {
    change(id, { docs_path: directory });
    const original = targetsOf(job).find(t => t.id === id)!;
    setPaths(previous => ({ ...previous, ...Object.fromEntries(job.documents.filter(doc => doc.target_id === id && (!doc.archive_path || doc.path.startsWith(`${original.docs_path}/`)) && !custom.includes(doc.id) && !/^agents\.md$/i.test(filename(doc.path))).map(doc => [doc.id, `${directory.replace(/\/$/, "")}/${doc.path.startsWith(`${original.docs_path}/`) ? doc.path.slice(original.docs_path.length + 1) : filename(doc.path)}`])) }));
  }
  async function prepare() {
    setBusy(true); setError("");
    try {
      let next = await componentRequest<DomainKnowledgeJob>(`/domain-extraction/${job.id}/archive-targets`, { targets: selected, documents: job.documents.filter(d => d.selected).map(d => ({ id: d.id, path: paths[d.id] })), base_revision: job.archive_revision ?? 0 });
      onChange(next);
      for (const doc of next.documents.filter(d => d.selected)) {
        next = await componentRequest<DomainKnowledgeJob>(`/domain-extraction/${job.id}/remote`, { document_id: doc.id });
        onChange(next);
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4 rounded-lg border border-line p-4" aria-label="领域知识归档位置">
    <div><h3 className="font-semibold">选择归档位置</h3><p className="mt-1 text-sm text-muted-foreground">路径已自动填好：AGENTS.md 放根目录，其他文档沿用默认目录。可按仓批量调整目录，只有例外文件需要单独改位置。</p></div>
    {selected.map(target => {
      const locked = [...job.publications, ...(job.publication_history ?? [])].some(p => p.target_id === target.id);
      return <fieldset key={target.id} className="grid grid-cols-2 gap-3 rounded border border-line p-3" disabled={busy || disabled || locked}>
        <legend className="px-1 font-medium">{target.id === "domain" ? "领域知识" : target.name}</legend>
        <label className="col-span-2 grid gap-1 text-sm">归档仓地址<Input aria-label={`${target.id} 归档仓地址`} value={target.repository} onChange={e => change(target.id, { repository: e.target.value })} placeholder="https://…/knowledge.git" /></label>
        <label className="grid gap-1 text-sm">归档分支<Input aria-label={`${target.id} 归档分支`} value={target.branch} onChange={e => change(target.id, { branch: e.target.value })} /></label>
        <label className="grid gap-1 text-sm">普通文档目录（批量设置）<Input aria-label={`${target.id} 归档文档目录`} value={target.docs_path} onChange={e => changeDirectory(target.id, e.target.value)} /></label>
        <details className="col-span-2 text-sm"><summary className="cursor-pointer">查看或调整 {job.documents.filter(d => d.selected && d.target_id === target.id).length} 个文件路径</summary>
          <ul className="mt-3 space-y-3">{job.documents.filter(d => d.selected && d.target_id === target.id).map(doc => <li key={doc.id} className="flex items-center gap-2">
            {editing === doc.id ? <Input aria-label={`${doc.id} 文件归档路径`} value={paths[doc.id] ?? doc.path} onChange={e => { setCustom(current => [...new Set([...current, doc.id])]); setPaths(current => ({ ...current, [doc.id]: e.target.value })); }} placeholder="AGENTS.md 或 docs/文件名.md" /> : <code className="min-w-0 flex-1 break-all">{paths[doc.id]}</code>}
            <Button size="sm" variant="ghost" aria-label={`调整 ${filename(doc.path)} 归档路径`} onClick={() => setEditing(editing === doc.id ? undefined : doc.id)}>{editing === doc.id ? "完成" : "改位置"}</Button>
          </li>)}</ul>
        </details>
        {locked && <p className="col-span-2 text-sm text-muted-foreground">已发起归档，后续更新沿用此位置。</p>}
      </fieldset>;
    })}
    {error && <p role="alert" className="text-danger">{error}</p>}
    <Button variant="outline" disabled={busy || disabled || invalid || !selected.length} onClick={() => void prepare()}>{busy ? "正在检查已有文档…" : "保存归档位置并检查已有文档"}</Button>
    {changed && <p className="text-sm text-muted-foreground">归档位置尚未保存，保存后重新检查已有文档和清理范围。</p>}
    {!changed && job.archive_configured !== false && <ul className="space-y-2 text-sm">{job.documents.filter(d => d.selected).map(doc => {
      const remote = doc.remote_review;
      return <li key={doc.id}>{doc.title} · {remote ? remote.reviewed ? "已核对远端" : remote.target_content !== null || remote.branch_content != null ? "目标位置已有文档，请核对差异" : "目标位置为新文档" : "尚未比较目标文档"}
        <Button size="sm" variant="link" onClick={() => onCompare(doc.id)}>核对已有文档</Button></li>;
    })}</ul>}
  </section>;
}
