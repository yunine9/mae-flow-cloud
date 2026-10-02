import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GitPullRequest } from "lucide-react";
import { useState } from "react";
import type { DomainKnowledgeJob } from "../../src/domainKnowledgeTypes";
import type { KnowledgeProductionAction, KnowledgePublicationState } from "../../src/knowledgeProductionTypes";
import { formatLocalDateTime } from "./time";

export function DomainKnowledgePublicationStatus({ job, disabled, onConfigure, onAction, onViewKnowledge, onCompare, compact = false }: {
  job: DomainKnowledgeJob; disabled?: boolean; onConfigure: () => void;
  onAction: (name: string) => Promise<boolean>;
  onViewKnowledge?: (id: string) => void;
  onCompare?: (documentId: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const view = job.production?.archive;
  if (!view?.visible) return null;
  const run = (action: KnowledgeProductionAction) => {
    if (action.id === "configure") { setOpen(false); onConfigure(); }
    else if (action.id === "compare" && action.document_id) { setOpen(false); onCompare?.(action.document_id); }
    else void onAction(action.id);
  };
  const publication = (item: KnowledgePublicationState) => <div key={item.key} className="mt-2">
    <p>{item.target} · {item.status_label}{item.url && <a className="ml-3 text-primary underline" href={item.url} target="_blank" rel="noreferrer">查看 MR ↗</a>}</p>
    {item.error && <p className="mt-2 whitespace-pre-wrap break-words text-danger">{item.error}</p>}
    {!!item.comparisons.length && <div className="mt-2 flex flex-wrap gap-2">{item.comparisons.map(action => <Button key={action.document_id} size="sm" variant="outline" disabled={disabled} onClick={() => run(action)}>{action.label}</Button>)}</div>}
  </div>;
  const status = <section className={compact ? "space-y-4" : "mb-4 rounded-lg border border-line bg-muted/20 px-4 py-3"} aria-label="知识发布与 Git 归档状态" data-status-group={job.production?.group}>
    <div className="flex flex-wrap items-center gap-3"><strong className="text-sm">{view.title}</strong>
      <span className={`text-xs ${view.group === "attention" ? "text-amber-700" : "text-muted-foreground"}`}>{view.status_label}</span>
      {onViewKnowledge && job.documents[0]?.knowledge_document_id && <Button size="sm" variant="ghost" onClick={() => onViewKnowledge(job.documents[0].knowledge_document_id!)}>查看正式知识</Button>}
    </div>
    <p className="mt-2 whitespace-pre-wrap break-words text-sm" role={view.group === "attention" ? "alert" : "status"}>{view.message}</p>
    <details className="mt-2 text-sm" open={compact || undefined}><summary className="cursor-pointer text-muted-foreground">Git 归档状态与 MR</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">发布后知识即可使用。归档按目标仓创建或更新 MR；未合入时后续批次复用同一 MR。</p>
        {view.batches.map(batch => <div key={batch.id} className="rounded border border-line p-3">
          <p><strong>{batch.title}</strong><span className="ml-3 text-muted-foreground">{batch.status_label} · {formatLocalDateTime(job.archive_batches?.find(item => item.id === batch.id)?.created_at)}</span></p>
          {job.archive_batches?.find(item => item.id === batch.id)?.error && <p className="mt-2 whitespace-pre-wrap break-words text-danger">{job.archive_batches.find(item => item.id === batch.id)?.error}</p>}
          {!!batch.superseded.length && <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{batch.superseded.map(item => <li key={item.id}>{item.label}</li>)}</ul>}
          {batch.publications.map(publication)}
        </div>)}
        {!view.batches.length && view.publications.map(publication)}
        <div className="flex flex-wrap gap-2">{view.actions.map((action, index) => <Button key={`${action.id}:${index}`} size="sm" variant="outline" disabled={disabled} onClick={() => run(action)}>{action.label}</Button>)}</div>
      </div>
    </details>
  </section>;
  return compact ? <>
    <Button size="sm" variant="outline" aria-label="发布记录与 Git 归档状态" onClick={() => setOpen(true)}><GitPullRequest size={16} />{view.status_label}</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="tw-root max-h-[88dvh] overflow-y-auto sm:max-w-[720px]"><DialogHeader><DialogTitle>发布记录与 Git 归档</DialogTitle></DialogHeader>{status}</DialogContent></Dialog>
  </> : status;
}
