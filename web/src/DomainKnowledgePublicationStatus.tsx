import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GitPullRequest } from "lucide-react";
import { useState } from "react";
import type { DomainKnowledgeJob } from "../../src/domainKnowledgeTypes";
import { knowledgeArchiveState } from "../../src/knowledgeArchiveStatus";
import { formatLocalDateTime } from "./time";

export function DomainKnowledgePublicationStatus({ job, disabled, onConfigure, onAction, onViewKnowledge, onCompare, compact = false }: {
  job: DomainKnowledgeJob; disabled?: boolean; onConfigure: () => void;
  onAction: (name: string) => Promise<boolean>;
  onViewKnowledge?: (id: string) => void;
  /** 打开该文稿的远端合并页，读取远端版本核对差异。 */
  onCompare?: (documentId: string) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const published = job.documents.filter(document => document.knowledge_document_id);
  const batches = job.archive_batches ?? [];
  if (!published.length && !batches.length && !job.publications.length) return null;
  const archiveState = knowledgeArchiveState(job);
  const failed = archiveState === "failed";
  const pending = archiveState === "running";
  const superseded = batches.some(batch => batch.state === "superseded");
  const publications = [...job.publications, ...(job.publication_history ?? [])];
  // 合入后归档仓被直接修改：后端给出状态与文案，这里只列出并提供核对入口。
  const diverged = job.publications.filter(publication => publication.sync_state === "diverged");
  const status = <section className={compact ? "space-y-4" : "mb-4 rounded-lg border border-line bg-muted/20 px-4 py-3"} aria-label="知识发布与 Git 归档状态">
    <div className="flex flex-wrap items-center gap-3"><strong className="text-sm">{published.length ? `${published.length} 份知识已发布，本地已生效` : "Git 归档记录"}</strong>
      <span className={`text-xs ${failed || diverged.length ? "text-amber-700" : "text-muted-foreground"}`}>{diverged.length ? "归档仓文档在合入后被修改，待核对" : failed ? "Git 归档待处理，正式知识仍可使用" : pending ? "Git 正在后台归档" : archiveState === "opened" ? "Git MR 待合入" : superseded ? "旧版批次无需再归档，见下方记录" : "可查看 Git 归档记录"}</span>
      {onViewKnowledge && published[0]?.knowledge_document_id && <Button size="sm" variant="ghost" onClick={() => onViewKnowledge(published[0].knowledge_document_id!)}>查看正式知识</Button>}
    </div>
    {diverged.map(publication => <div key={`${publication.target_id}:${publication.branch}`} role="alert" className="mt-3 rounded border border-amber-600/40 bg-amber-500/10 p-3 text-sm">
      <p className="whitespace-pre-wrap break-words">{publication.sync_error}</p>
      <div className="mt-2 flex flex-wrap gap-2">{(publication.diverged_paths ?? []).map(path => {
        const document = job.documents.find(item => item.target_id === publication.target_id && item.path === path);
        return document && onCompare ? <Button key={path} size="sm" variant="outline" onClick={() => { setOpen(false); onCompare(document.id); }}>核对 {path.split("/").at(-1)} 的远端差异</Button> : null;
      })}</div>
    </div>)}
    <details className="mt-2 text-sm" open={compact || undefined}><summary className="cursor-pointer text-muted-foreground">Git 归档状态与 MR</summary>
      <div className="mt-3 space-y-3">
        <p className="text-xs text-muted-foreground">发布后知识即可使用。归档按目标仓创建或更新 MR；未合入时后续批次复用同一 MR。</p>
        {batches.map((batch, index) => <div key={batch.id} className="rounded border border-line p-3">
          <p><strong>第 {index + 1} 批 · {batch.documents.length} 份</strong><span className="ml-3 text-muted-foreground">{{ pending: "等待归档", running: "归档中", done: "归档已提交", failed: "归档失败", superseded: "无需归档" }[batch.state]} · {formatLocalDateTime(batch.created_at)}</span></p>
          {batch.error && <p className="mt-2 whitespace-pre-wrap break-words text-danger">{batch.error}</p>}
          {!!batch.superseded_documents?.length && <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{batch.superseded_documents.map(document => <li key={document.document_id}>{batch.documents.find(old => old.id === document.document_id)?.path ?? document.document_id} · {document.reason === "deleted" ? "正式知识已删除，本版不再归档" : "已有新版正式知识，本版不再归档"}</li>)}</ul>}
          {batch.publications.map(publication => <p key={`${publication.target_id}:${publication.branch}`} className="mt-2">{batch.targets.find(target => target.id === publication.target_id)?.name ?? publication.target_id} · {{ pending: "准备中", opened: "MR 待合入", merged: "MR 已合入", failed: "归档失败", closed: "MR 已关闭", unchanged: "目标仓无变化" }[publication.state]}{publication.url && <a className="ml-3 text-primary underline" href={publication.url} target="_blank" rel="noreferrer">查看 MR ↗</a>}{publication.error && <span className="ml-2 text-danger">{publication.error}</span>}</p>)}
        </div>)}
        {!batches.length && publications.map(publication => <article key={`${publication.target_id}:${publication.branch}`} className="rounded border border-line p-3"><strong>{[job.knowledge_target, ...job.repositories].find(target => target.id === publication.target_id)?.name}</strong><span className="ml-3">{{ pending: "归档准备中", opened: "MR 待合入", merged: "MR 已合入", failed: "归档失败", closed: "MR 已关闭", unchanged: "目标仓无变化" }[publication.state]}</span>{publication.url && <a href={publication.url} target="_blank" rel="noreferrer" className="ml-3 text-primary underline">查看 MR ↗</a>}{publication.error && <p className="mt-2 text-danger">{publication.error}</p>}</article>)}
        <div className="flex gap-2"><Button size="sm" variant="outline" disabled={disabled} onClick={() => void onAction("refresh")}>刷新 MR 状态</Button><Button size="sm" variant="ghost" onClick={() => { setOpen(false); onConfigure(); }}>Git 归档设置</Button>{failed && <Button size="sm" variant="outline" disabled={disabled} onClick={() => void onAction("archive-retry")}>重试失败归档</Button>}</div>
      </div>
    </details>
  </section>;
  return compact ? <>
    <Button size="sm" variant="outline" aria-label="发布记录与 Git 归档状态" onClick={() => setOpen(true)}><GitPullRequest size={16} />{diverged.length ? "远端待核对" : failed ? "归档待处理" : pending ? "归档中" : archiveState === "opened" ? "MR 待合入" : "发布记录"}</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="tw-root max-h-[88dvh] overflow-y-auto sm:max-w-[720px]"><DialogHeader><DialogTitle>发布记录与 Git 归档</DialogTitle></DialogHeader>{status}</DialogContent></Dialog>
  </> : status;
}
