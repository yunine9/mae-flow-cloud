import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { componentRequest } from "./componentResearchApi";
import type { DomainKnowledgeJob, KnowledgeRepository } from "../../src/domainKnowledgeTypes";

const targetsOf = (job: DomainKnowledgeJob) => [job.knowledge_target, ...job.repositories];
const pathsOf = (job: DomainKnowledgeJob) => Object.fromEntries(job.documents.map(document => [document.id, document.archive_path ?? document.path]));
export function DomainKnowledgeArchiveTargets({ job, disabled, onChange }: {
  job: DomainKnowledgeJob; disabled?: boolean; onChange: (job: DomainKnowledgeJob) => void;
}) {
  const [targets, setTargets] = useState(() => structuredClone(targetsOf(job))), [paths, setPaths] = useState(() => pathsOf(job));
  const [customPaths, setCustomPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { setTargets(structuredClone(targetsOf(job))); setPaths(pathsOf(job)); setCustomPaths([]); setError(""); }, [job.id, job.archive_revision]);
  const usedTargets = targets.filter(target => job.documents.some(document => document.target_id === target.id));
  const invalid = usedTargets.some(target => !target.repository.trim() || !target.branch.trim() || !target.docs_path.trim())
    || job.documents.some(document => !paths[document.id]?.trim());
  function change(id: string, patch: Partial<KnowledgeRepository>) { setTargets(previous => previous.map(target => target.id === id ? { ...target, ...patch } : target)); }
  function changeDirectory(id: string, directory: string) {
    change(id, { docs_path: directory });
    const original = targetsOf(job).find(target => target.id === id)!;
    setPaths(previous => ({ ...previous, ...Object.fromEntries(job.documents.filter(document => document.target_id === id
      && !customPaths.includes(document.id) && !/^agents\.md$/i.test(document.path.split("/").at(-1) ?? "")
      && (!document.archive_path || document.path.startsWith(`${original.docs_path}/`))).map(document => [document.id,
        `${directory.replace(/\/$/, "")}/${document.path.startsWith(`${original.docs_path}/`) ? document.path.slice(original.docs_path.length + 1) : document.path.split("/").at(-1)}`])) }));
  }
  async function save() {
    setBusy(true); setError("");
    try { onChange(await componentRequest<DomainKnowledgeJob>(`/domain-extraction/${job.id}/archive-targets`, { targets: usedTargets,
      documents: job.documents.map(document => ({ id: document.id, path: paths[document.id] })), base_revision: job.archive_revision ?? 0 }, AbortSignal.timeout(30_000))); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4 rounded-lg border border-line p-4" aria-label="领域知识归档位置">
    {usedTargets.map(target => <fieldset key={target.id} className="grid grid-cols-2 gap-3 rounded border border-line p-3" disabled={busy || disabled}>
      <legend className="px-1 font-medium">{target.name}</legend>
      <label className="col-span-2 grid gap-1 text-sm">归档仓地址<Input aria-label={`${target.id} 归档仓地址`} value={target.repository} onChange={event => change(target.id, { repository: event.target.value })} placeholder="https://…/knowledge.git" /></label>
      <label className="grid gap-1 text-sm">归档分支<Input aria-label={`${target.id} 归档分支`} value={target.branch} onChange={event => change(target.id, { branch: event.target.value })} /></label>
      <label className="grid gap-1 text-sm">文档目录<Input aria-label={`${target.id} 归档文档目录`} value={target.docs_path} onChange={event => changeDirectory(target.id, event.target.value)} /></label>
      <div className="col-span-2 space-y-2">{job.documents.filter(document => document.target_id === target.id).map(document => <label key={document.id} className="grid gap-1 text-sm">{document.title}
        <Input aria-label={`${document.id} 文件归档路径`} value={paths[document.id] ?? document.path} onChange={event => { setCustomPaths(previous => [...new Set([...previous, document.id])]); setPaths(previous => ({ ...previous, [document.id]: event.target.value })); }} />
      </label>)}</div>
    </fieldset>)}
    {error && <p role="alert" className="whitespace-pre-wrap text-sm text-danger">{error}</p>}
    <Button variant="outline" disabled={busy || disabled || invalid || !usedTargets.length} onClick={() => void save()}>{busy ? "正在保存…" : "保存 Git 归档设置"}</Button>
  </section>;
}
