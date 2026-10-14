import { useEffect, useRef, useState } from "react";
import { GitBranch, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { componentRequest } from "./componentResearchApi";
import type { KnowledgeArchivePreview, KnowledgeProductionAction, KnowledgeProductionView } from "../../src/knowledgeProductionTypes";
import { mrParticipantsMessage } from "../../src/mrParticipants";

export function KnowledgeArchiveHistory({ batches, disabled, onRetry }: {
  batches: KnowledgeProductionView["archive"]["batches"]; disabled?: boolean;
  onRetry: (action: KnowledgeProductionAction) => void;
}) {
  if (!batches.length) return null;
  return <details className="space-y-3 rounded border border-line p-3">
    <summary className="cursor-pointer text-sm font-medium">归档记录（{batches.length}）</summary>
    <p className="text-sm text-muted-foreground">每批保留创建时的文稿和归档位置。重试原批次使用其原版本，不带入后续目录调整或未发布修改。</p>
    {batches.map(batch => <section key={batch.id} className="space-y-2 border-t border-line pt-3 text-sm" aria-label={batch.title}>
      <p>{batch.title} · {batch.status_label}</p>
      {batch.publications.map(publication => <div key={publication.key}><span>{publication.target} · {publication.status_label}</span>
        {publication.url && <a className="ml-3 text-primary underline" href={publication.url} target="_blank" rel="noreferrer">打开原 MR ↗</a>}
        {publication.error && <p className="whitespace-pre-wrap break-words text-danger">{publication.error}</p>}
      </div>)}
      {batch.actions?.map(action => <Button key={action.id} variant="outline" disabled={disabled} onClick={() => onRetry(action)}>{action.label}</Button>)}
    </section>)}
  </details>;
}

export function KnowledgeArchiveDialog({ endpoint, production, disabled, onConfigure, onChanged, openRequest = 0 }: {
  endpoint: string; production?: KnowledgeProductionView; disabled?: boolean; onConfigure?: () => void;
  onChanged?: () => void; openRequest?: number;
}) {
  const [open, setOpen] = useState(false), [preview, setPreview] = useState<KnowledgeArchivePreview>();
  const [issue, setIssue] = useState(""), [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submitting = useRef(false), generation = useRef(0);
  useEffect(() => { if (openRequest && production?.archive.visible) setOpen(true); }, [openRequest, production?.archive.visible]);
  useEffect(() => {
    if (!open || !production?.archive.visible) return;
    const owner = ++generation.current, controller = new AbortController();
    submitting.current = false; setBusy(false);
    setLoading(true); setError(""); setPreview(undefined);
    void componentRequest<KnowledgeArchivePreview>(`${endpoint}/preview`, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]))
      .then(result => { if (generation.current === owner) { setPreview(result); setIssue(result.issue_no ?? ""); setDescription(result.issue_description ?? ""); } })
      .catch(reason => { if (generation.current === owner) setError((reason as Error).name === "TimeoutError" ? "读取归档预览超过 30 秒，请重新打开归档后重试。" : (reason as Error).message); })
      .finally(() => { if (generation.current === owner) setLoading(false); });
    return () => { generation.current++; controller.abort(); };
  }, [open, endpoint, production?.archive.visible]);
  async function execute(action: KnowledgeProductionAction, targetId?: string) {
    const retry = action.id === "retry-archive";
    if ((!preview && !retry) || disabled || loading || submitting.current) return;
    submitting.current = true; setBusy(true); setError("");
    const owner = generation.current;
    try {
      const result = await componentRequest<KnowledgeArchivePreview>(`${endpoint}/${retry ? "retry" : "create"}`, retry
        ? { batch_id: action.batch_id, target_id: action.target_id ?? targetId }
        : { issue_no: issue.trim(), issue_description: description.trim() || undefined, expected_revisions: preview!.expected_revisions }, AbortSignal.timeout(5 * 60_000));
      if (generation.current === owner) { setPreview(result); onChanged?.(); }
    } catch (reason) { if (generation.current === owner) setError((reason as Error).name === "TimeoutError" ? "归档请求超过 5 分钟，请重新打开归档查看实际结果后重试。" : (reason as Error).message); }
    finally { if (generation.current === owner) { submitting.current = false; setBusy(false); } }
  }
  function renderAction(action: KnowledgeProductionAction, targetId?: string) {
    if (action.id === "configure") return action.href
      ? <a key={`${action.id}:${targetId ?? "all"}`} className="text-sm font-medium text-primary underline" href={action.href}>{action.label} ↗</a>
      : <Button key={`${action.id}:${targetId ?? "all"}`} variant="outline" disabled={disabled || busy} onClick={() => { setOpen(false); onConfigure?.(); }}>{action.label}</Button>;
    return <Button key={`${action.id}:${targetId ?? "all"}`} variant={action.id === "retry-archive" ? "outline" : "default"}
      disabled={disabled || busy || loading || action.id === "create-archive" && !issue.trim()} onClick={() => void execute(action, targetId)}>{action.label}</Button>;
  }
  const action = production?.archive.actions.find(item => item.id === "archive");
  if (!production?.archive.visible || !action) return null;
  return <>
    <Button size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}><GitBranch size={16} />{action.label}</Button>
    <Dialog open={open} onOpenChange={next => { if (!busy) setOpen(next); }}>
      <DialogContent className="tw-root max-h-[88dvh] overflow-auto sm:max-w-4xl">
        <DialogHeader><DialogTitle>{preview?.title ?? action.label}</DialogTitle></DialogHeader>
        {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" />正在读取正式版本…</p>}
        {error && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-danger">{error}</p>}
        <KnowledgeArchiveHistory batches={production.archive.batches} disabled={disabled || busy || loading} onRetry={item => void execute(item)} />
        {preview && <div className="space-y-4">
          <div><strong className="text-sm">{preview.status_label}</strong><p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{preview.message}</p></div>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-sm">关联单号（必填）<Input aria-label="归档关联单号" required maxLength={120} disabled={busy} value={issue} onChange={event => setIssue(event.target.value)} /></label>
            <label className="grid gap-1 text-sm">单号描述<Input aria-label="归档单号描述" maxLength={2000} disabled={busy} value={description} onChange={event => setDescription(event.target.value)} /></label>
          </div>
          {preview.targets.map(target => <section key={target.id} className="space-y-3 rounded-lg border border-line p-4" aria-label={`${target.name}归档`}>
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{target.name}</h3>{target.status_label !== preview.status_label && <span className="text-sm">{target.status_label}</span>}</div>
            <p className="break-all text-sm text-muted-foreground">{[target.repository, target.branch, target.docs_path].filter(Boolean).join(" · ")}</p>
            {target.message && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{target.message}</p>}
            {target.error && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-danger">{target.error}</p>}
            {target.url && <a className="text-sm font-medium text-primary underline" href={target.url} target="_blank" rel="noreferrer">打开 MR ↗</a>}
            {mrParticipantsMessage(target.mr_participants) && <p role="status" className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
              {mrParticipantsMessage(target.mr_participants)}</p>}
            <ul className="m-0 list-none space-y-2 p-0">{target.files.map(file => <li key={file.id} className="rounded border border-line bg-surface-2 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2"><code className="break-all">{file.path}</code><span className="text-xs text-muted-foreground" title={`${file.knowledge_document_id}@${file.knowledge_revision}`}>{file.knowledge_revision.slice(0, 12)}</span></div>
              <details className="mt-2"><summary className="cursor-pointer text-muted-foreground">{file.title}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{file.content}</pre></details>
            </li>)}</ul>
            {!!target.actions.length && <div className="flex flex-wrap items-center gap-3">{target.actions.map(item => renderAction(item, target.id))}</div>}
          </section>)}
          {/* 主动作贴底：多仓时文件清单很长，1366×768 下按钮曾落在首屏之外要滚动才能找到。 */}
          {!!preview.actions.length && <div className="sticky -bottom-4 -mx-4 -mb-4 flex flex-wrap items-center justify-end gap-3 border-t border-line bg-popover px-4 py-3">{preview.actions.map(item => renderAction(item))}</div>}
        </div>}
      </DialogContent>
    </Dialog>
  </>;
}
