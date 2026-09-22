import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { componentRequest } from "./componentResearchApi";
import type { DomainKnowledgeJob, KnowledgeRepository } from "../../src/domainKnowledgeTypes";

const targetsOf = (job: DomainKnowledgeJob) => [job.knowledge_target, ...job.repositories];
export function DomainKnowledgeArchiveTargets({ job, disabled, onChange, onBlockedChange, onCompare }: {
  job: DomainKnowledgeJob; disabled?: boolean; onChange: (job: DomainKnowledgeJob) => void;
  onBlockedChange: (blocked: boolean) => void; onCompare: (id: string) => void;
}) {
  const [targets, setTargets] = useState(() => structuredClone(targetsOf(job)));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { setTargets(structuredClone(targetsOf(job))); setError(""); }, [job.id, job.archive_revision]);
  const selected = targets.filter(t => job.documents.some(d => d.selected && d.target_id === t.id));
  const changed = selected.some(t => {
    const old = targetsOf(job).find(o => o.id === t.id)!;
    return t.repository !== old.repository || t.branch !== old.branch || t.docs_path !== old.docs_path;
  });
  const invalid = selected.some(t => !t.repository.trim() || !t.branch.trim() || !t.docs_path.trim());
  const blocked = busy || changed || invalid || job.archive_configured === false;
  useEffect(() => { onBlockedChange(blocked); }, [blocked, onBlockedChange]);
  function change(id: string, patch: Partial<KnowledgeRepository>) { setTargets(old => old.map(t => t.id === id ? { ...t, ...patch } : t)); }
  async function prepare() {
    setBusy(true); setError("");
    try {
      let next = await componentRequest<DomainKnowledgeJob>(`/domain-extraction/${job.id}/archive-targets`, { targets: selected, base_revision: job.archive_revision ?? 0 });
      onChange(next);
      for (const doc of next.documents.filter(d => d.selected)) {
        next = await componentRequest<DomainKnowledgeJob>(`/domain-extraction/${job.id}/remote`, { document_id: doc.id });
        onChange(next);
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4 rounded-lg border border-line p-4" aria-label="领域知识归档位置">
    <div><h3 className="font-semibold">选择归档位置</h3><p className="mt-1 text-sm text-muted-foreground">默认采用知识仓配置、研究仓与 Skill 目录约定，可按需调整。更换归档位置不会改变研究源码的范围。</p></div>
    {selected.map(target => {
      const locked = [...job.publications, ...(job.publication_history ?? [])].some(p => p.target_id === target.id);
      const old = targetsOf(job).find(t => t.id === target.id)!;
      return <fieldset key={target.id} className="grid grid-cols-2 gap-3 rounded border border-line p-3" disabled={busy || disabled || locked}>
        <legend className="px-1 font-medium">{target.id === "domain" ? "领域知识" : target.name}</legend>
        <label className="col-span-2 grid gap-1 text-sm">归档仓地址<Input aria-label={`${target.id} 归档仓地址`} value={target.repository} onChange={e => change(target.id, { repository: e.target.value })} placeholder="https://…/knowledge.git" /></label>
        <label className="grid gap-1 text-sm">归档分支<Input aria-label={`${target.id} 归档分支`} value={target.branch} onChange={e => change(target.id, { branch: e.target.value })} /></label>
        <label className="grid gap-1 text-sm">归档文档目录<Input aria-label={`${target.id} 归档文档目录`} value={target.docs_path} onChange={e => change(target.id, { docs_path: e.target.value })} /></label>
        <ul className="col-span-2 break-all text-sm text-muted-foreground">{job.documents.filter(d => d.selected && d.target_id === target.id).map(doc => <li key={doc.id}>{target.docs_path.replace(/\/$/, "")}/{doc.path.slice(old.docs_path.length + 1)}</li>)}</ul>
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
