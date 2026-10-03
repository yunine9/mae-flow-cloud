import { KnowledgeArchiveDialog } from "./KnowledgeArchiveDialog";
import type { DomainKnowledgeJob } from "../../src/domainKnowledgeTypes";

export function DomainKnowledgePublicationStatus({ job, disabled, onConfigure, onChanged, compact = false, openRequest = 0 }: {
  job: DomainKnowledgeJob; disabled?: boolean; onConfigure?: () => void; onChanged?: () => void; compact?: boolean; openRequest?: number;
}) {
  const view = job.production?.archive;
  if (!view?.visible) return null;
  const action = <KnowledgeArchiveDialog endpoint={`/domain-extraction/${encodeURIComponent(job.id)}/archive`}
    production={job.production} disabled={disabled} onConfigure={onConfigure} onChanged={onChanged} openRequest={openRequest} />;
  if (compact) return action;
  return <section className="space-y-3 rounded-lg border border-line p-4" aria-label="知识 Git 归档" data-status-group={view.group}>
    <div className="flex flex-wrap items-center justify-between gap-3"><strong className="text-sm">{view.status_label}</strong>{action}</div>
    <p className="whitespace-pre-wrap text-sm text-muted-foreground">{view.message}</p>
    {view.publications.map(item => <div key={item.key} className="text-sm"><span>{item.target} · {item.status_label}</span>
      {item.url && <a className="ml-3 text-primary underline" href={item.url} target="_blank" rel="noreferrer">打开 MR ↗</a>}
      {item.error && <p className="mt-1 whitespace-pre-wrap break-words text-danger">{item.error}</p>}
    </div>)}
  </section>;
}
