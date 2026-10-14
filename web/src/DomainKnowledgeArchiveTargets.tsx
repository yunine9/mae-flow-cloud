import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { componentRequest } from "./componentResearchApi";
import type { DomainKnowledgeJob, KnowledgeRepository, DomainArchiveTargetsPreview } from "../../src/domainKnowledgeTypes";
import { directoryKnowledgeDirectory, hasOpaqueModuleDirectory } from "../../src/domainKnowledgeLayout";

const targetsOf = (job: DomainKnowledgeJob) => [job.knowledge_target, ...job.repositories];
const confirmedDeletion = (document: DomainKnowledgeJob["documents"][number]) => !!document.deleted && !!document.knowledge_document_id && document.published_document_revision === document.revision;
function initialTargets(job: DomainKnowledgeJob) {
  const title = job.module_name || job.title;
  return targetsOf(job).map(target => {
    if (job.component_research_id || job.documents.length > 0 && job.documents.every(confirmedDeletion)) return { ...target };
    const isDomain = target.id === job.knowledge_target.id;
    if (job.knowledge_layout === "directory-v1" && target.docs_path && target.docs_path !== "." && !hasOpaqueModuleDirectory(target.docs_path)
      && (isDomain || target.docs_path.startsWith("docs/"))) return { ...target };
    return { ...target, docs_path: directoryKnowledgeDirectory(target.docs_path, title, job.module_id, isDomain) };
  });
}
export function DomainKnowledgeArchivePathPreview({ preview, deletedDocumentIds = [] }: { preview: DomainArchiveTargetsPreview; deletedDocumentIds?: string[] }) {
  const deletingOnly = preview.documents.length > 0 && preview.documents.every(document => deletedDocumentIds.includes(document.id));
  return <section aria-label="文档路径预览" className="space-y-3">
    <h3 className="text-sm font-semibold">文档路径预览</h3>
    {preview.targets.filter(target => preview.documents.some(document => document.target_id === target.id)).map(target => <div key={target.id} className="space-y-2 rounded border border-line p-3">
      <h4 className="text-sm font-medium">{target.id === "domain" ? "领域知识仓" : target.name}</h4>
      {!deletingOnly && <p className="break-all text-xs text-muted-foreground">平台维护入口：<code>{target.id === "domain" ? `${target.docs_path}/AGENTS.md` : "AGENTS.md"}</code></p>}
      <ul className="m-0 list-none space-y-2 p-0">{preview.documents.filter(document => document.target_id === target.id).map(document => <li key={document.id} className="text-sm">
        <span className="text-muted-foreground">{document.title}{deletedDocumentIds.includes(document.id) ? " · 删除原文件" : ""}</span>
        <code className="block break-all">{document.path}</code>
      </li>)}</ul>
    </div>)}
  </section>;
}
export function DomainKnowledgeArchiveTargets({ job, disabled, onChange, onBusy, onConfirmArchive, replaceExisting = false }: {
  job: DomainKnowledgeJob; disabled?: boolean; onChange: (job: DomainKnowledgeJob) => void; onBusy?: (busy: boolean) => void;
  onConfirmArchive?: (job: DomainKnowledgeJob) => void | Promise<void>; replaceExisting?: boolean;
}) {
  const [targets, setTargets] = useState(() => initialTargets(job));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [preview, setPreview] = useState<{ key: string; data: DomainArchiveTargetsPreview }>();
  const [previewing, setPreviewing] = useState(true);
  const [previewRetry, setPreviewRetry] = useState(0);
  useEffect(() => { setTargets(initialTargets(job)); setError(""); }, [job.id, job.archive_revision]);
  const deletingOnly = job.documents.length > 0 && job.documents.every(confirmedDeletion);
  const invalid = targets.some(target => !target.branch.trim() || !target.docs_path.trim()
    || job.documents.some(document => document.target_id === target.id) && !target.repository.trim());
  const input = { targets: targets.filter(target => !!target.repository.trim() || job.documents.some(document => document.target_id === target.id)),
    documents: [], use_directory_layout: !job.component_research_id, base_revision: job.archive_revision ?? 0 };
  const previewKey = JSON.stringify({ input, revisions: job.documents.map(document => [document.id, document.revision, document.published_revision]),
    proposals: job.turns.flatMap(turn => turn.proposals.map(proposal => [proposal.document.id, proposal.status, proposal.base_revision])) });
  useEffect(() => {
    const controller = new AbortController();
    setPreview(undefined); setError(""); setPreviewing(!invalid && !disabled);
    if (invalid || disabled) return () => controller.abort();
    const timer = setTimeout(() => {
      void componentRequest<DomainArchiveTargetsPreview>(`/domain-extraction/${job.id}/archive-targets/preview`, input,
        AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]))
        .then(candidate => { if (!controller.signal.aborted) setPreview({ key: previewKey, data: candidate }); })
        .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).name === "TimeoutError" ? "计算文档路径超时，请调整目录后重试。" : (reason as Error).message); })
        .finally(() => { if (!controller.signal.aborted) setPreviewing(false); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [job.id, previewKey, invalid, disabled, previewRetry]);
  function change(id: string, patch: Partial<KnowledgeRepository>) { setTargets(previous => previous.map(target => target.id === id ? { ...target, ...patch } : target)); }
  async function confirm() {
    if (preview?.key !== previewKey || previewing) return;
    setBusy(true); onBusy?.(true); setError("");
    try {
      const next = await componentRequest<DomainKnowledgeJob>(`/domain-extraction/${job.id}/archive-targets`, input, AbortSignal.timeout(30_000));
      onChange(next);
      await onConfirmArchive?.(next);
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); onBusy?.(false); }
  }
  return <section className="space-y-4" aria-label="确认 Git 归档路径">
    <p className="text-sm text-muted-foreground">确认每个仓的相对目录，下方实时预览文档路径。代码仓知识统一放在 docs 下的业务目录；领域知识及其 AGENTS.md 放在选定的领域目录。确认后自动创建 MR。</p>
    {deletingOnly && <p className="text-sm text-muted-foreground">删除沿用原归档位置。</p>}
    {targets.map(target => <fieldset key={target.id} className="grid grid-cols-2 gap-3 rounded border border-line p-3" disabled={busy || disabled || deletingOnly}>
      <legend className="px-1 font-medium">{target.id === job.knowledge_target.id ? "领域知识仓" : `代码仓 · ${target.name}`}</legend>
      <label className="col-span-2 grid gap-1 text-sm">归档仓地址<Input aria-label={`${target.id} 归档仓地址`} value={target.repository} onChange={event => change(target.id, { repository: event.target.value })} placeholder="https://…/knowledge.git" /></label>
      <label className="grid gap-1 text-sm">归档分支<Input aria-label={`${target.id} 归档分支`} value={target.branch} onChange={event => change(target.id, { branch: event.target.value })} /></label>
      <label className="grid gap-1 text-sm">仓内相对目录<Input aria-label={`${target.id} 归档文档目录`} value={target.docs_path} onChange={event => change(target.id, { docs_path: event.target.value })} placeholder="docs/业务目录" /></label>
    </fieldset>)}
    {previewing && <p role="status" className="text-sm text-muted-foreground">正在计算各文档的最终路径…</p>}
    {preview?.key === previewKey && <DomainKnowledgeArchivePathPreview preview={preview.data} deletedDocumentIds={job.documents.filter(confirmedDeletion).map(document => document.id)} />}
    {error && <p role="alert" className="whitespace-pre-wrap text-sm text-danger">{error}</p>}
    {error && !preview && <Button size="sm" variant="outline" disabled={busy || disabled} onClick={() => setPreviewRetry(value => value + 1)}>重新预览路径</Button>}
    <div className="sticky -bottom-4 -mx-4 -mb-4 flex justify-end border-t border-line bg-popover px-4 py-3">
      <Button disabled={busy || disabled || invalid || previewing || preview?.key !== previewKey || !targets.length} onClick={() => void confirm()}>{busy ? "正在准备 MR…" : replaceExisting ? "确认并重新创建 MR" : "确认并创建 MR"}</Button>
    </div>
  </section>;
}
