import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { componentRequest } from "./componentResearchApi";
import type { KnowledgeReviewNote, KnowledgeReviewKind } from "../../src/knowledgeReviewNoteTypes";

/** 意见针对整篇文档保存，研究草稿可交给已有 Agent 修订流程。 */
export function KnowledgeReviewNotes({ kind, jobId, documentId, children, toolbarTarget, commentOnly = false, onEdit, working = false, openRequest = 0 }: {
  kind: KnowledgeReviewKind; jobId: string; documentId: string; revision?: number | string; children: ReactNode;
  toolbarTarget?: HTMLElement | null; commentOnly?: boolean; onEdit?: (message: string) => void; working?: boolean; openRequest?: number;
}) {
  const comments = kind === "published" || kind === "skill" || commentOnly;
  const [notes, setNotes] = useState<KnowledgeReviewNote[]>([]), [open, setOpen] = useState(false), [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const path = `/knowledge-review/${kind}/${encodeURIComponent(jobId)}`;
  useEffect(() => {
    let live = true; setNotes([]); setOpen(false); setMessage(""); setError("");
    void componentRequest<{ notes: KnowledgeReviewNote[] }>(path).then(result => { if (live) setNotes(result.notes); }).catch(error => { if (live) setError(error.message); });
    return () => { live = false; };
  }, [path, documentId]);
  useEffect(() => { if (openRequest) setOpen(true); }, [openRequest]);
  const current = notes.filter(note => note.document_id === documentId), pending = current.filter(note => note.status === "open");
  async function save(): Promise<KnowledgeReviewNote[] | undefined> {
    if (!message.trim()) return notes;
    try {
      const result = await componentRequest<{ notes: KnowledgeReviewNote[] }>(path, { document_id: documentId, scope: "document", note: message });
      setNotes(result.notes); setMessage(""); setError(""); return result.notes;
    } catch (error) { setError((error as Error).message); }
  }
  async function resolve(id: string) {
    setBusy(true); setError("");
    try { const result = await componentRequest<{ notes: KnowledgeReviewNote[] }>(`${path}/resolve`, { note_ids: [id] }); setNotes(result.notes); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (working || busy) return;
    setBusy(true); setError("");
    try {
      const saved = await save();
      if (!saved) return;
      const result = await componentRequest<{ notes: KnowledgeReviewNote[] }>(`${path}/apply`, { note_ids: saved.filter(note => note.document_id === documentId && note.status === "open").map(note => note.id) });
      setNotes(result.notes);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  const toggle = <Button size="sm" variant="ghost" onClick={() => setOpen(value => !value)} aria-expanded={open}><MessageSquare size={15} />提意见{current.length ? ` · ${current.length}` : ""}</Button>;
  return <div className="knowledge-review-notes is-commenting">
    {toolbarTarget ? createPortal(toggle, toolbarTarget) : toolbarTarget === undefined && toggle}
    {children}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="tw-root max-h-[85dvh] overflow-auto sm:max-w-[640px]">
      <DialogHeader><DialogTitle>修改意见</DialogTitle></DialogHeader>
      <section className="space-y-3" aria-label="文稿修改意见">
        <Textarea aria-label="整体修改意见" rows={3} disabled={busy} value={message} onChange={event => setMessage(event.target.value)} placeholder={comments ? "希望怎样调整这份文档？" : "希望怎样调整这份文档？Agent 会结合全文修改。"} />
        <div className="flex justify-end gap-2">{(comments || working) && <Button size="sm" variant="outline" disabled={busy || !message.trim()} onClick={async () => { setBusy(true); await save(); setBusy(false); }}>保存意见</Button>}
          {comments ? onEdit && <Button size="sm" disabled={busy} onClick={() => { setOpen(false); onEdit([...pending.map(note => note.note), message].map(text => text.trim()).filter(Boolean).join("\n\n")); }}>去修改</Button> : <Button size="sm" disabled={busy || working || !message.trim() && !pending.length} onClick={() => void submit()}>交给 Agent 修改</Button>}
        </div>
        {!comments && working && <p className="text-sm text-muted-foreground">本轮正在执行，可先保存意见，完成后再提交。</p>}
        <div className="knowledge-review-note-list">{current.map(note => <article key={note.id} className="border-b border-line py-3 text-sm">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><span>{note.operator}</span><span>{note.status === "resolved" ? "已处理" : note.status === "submitted" ? "已交给 Agent" : "待处理"}</span>{note.status !== "resolved" && <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={() => void resolve(note.id)}>标记已处理</Button>}</div><p className="mt-2 whitespace-pre-wrap">{note.note}</p>
        </article>)}{!current.length && <p className="py-4 text-sm text-muted-foreground">暂无意见</p>}</div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </section>
    </DialogContent></Dialog>
    {error && !open && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
  </div>;
}
