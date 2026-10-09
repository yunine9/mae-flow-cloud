import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { componentRequest } from "./componentResearchApi";
import { Annotatable } from "./Annotatable";
import type { KnowledgeReviewNote, KnowledgeReviewKind, KnowledgeReviewNotesResult } from "../../src/knowledgeReviewNoteTypes";

/** 行意见先保存，读完后与整篇意见一起交给已有修订流程。 */
export function KnowledgeReviewNotes({ kind, jobId, documentId, children, toolbarTarget, commentOnly = false, onEdit, working = false, openRequest = 0, scope = "document", refreshToken, blockedReason }: {
  kind: KnowledgeReviewKind; jobId: string; documentId: string; children?: ReactNode; scope?: "document" | "study"; refreshToken?: unknown; blockedReason?: string;
  toolbarTarget?: HTMLElement | null; commentOnly?: boolean; onEdit?: (message: string) => void; working?: boolean; openRequest?: number;
}) {
  const comments = kind === "published" || kind === "skill" || commentOnly;
  const [notes, setNotes] = useState<KnowledgeReviewNote[]>([]), [open, setOpen] = useState(false), [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [submissions, setSubmissions] = useState<KnowledgeReviewNotesResult["submissions"]>({});
  const version = useRef(0);
  function receive(result: KnowledgeReviewNotesResult) { version.current++; setNotes(result.notes); setSubmissions(result.submissions); }
  const path = `/knowledge-review/${kind}/${encodeURIComponent(jobId)}`;
  useEffect(() => {
    setNotes([]); setSubmissions({}); setOpen(false); setMessage(""); setError("");
  }, [path, documentId, scope]);
  useEffect(() => {
    let live = true; const requestedVersion = version.current;
    void componentRequest<KnowledgeReviewNotesResult>(path).then(result => { if (live && version.current === requestedVersion) receive(result); }).catch(error => { if (live) setError(error.message); });
    return () => { live = false; };
  }, [path, documentId, refreshToken]);
  useEffect(() => { if (openRequest) setOpen(true); }, [openRequest]);
  const matches = (note: KnowledgeReviewNote) => scope === "study" ? note.scope === "study" : note.scope !== "study" && note.document_id === documentId;
  const current = notes.filter(matches), pending = current.filter(note => note.status === "open");
  const submission = [...current].sort((a, b) => (b.submitted_at ?? "").localeCompare(a.submitted_at ?? "")).map(note => note.turn_id ? submissions?.[note.turn_id] : undefined).find(Boolean);
  const modifying = working || !!submission?.working;
  const lineNotes = !comments && scope === "document";
  async function save(): Promise<KnowledgeReviewNote[] | undefined> {
    if (!message.trim()) return notes;
    try {
      const result = await componentRequest<KnowledgeReviewNotesResult>(path, { document_id: documentId, scope, note: message });
      receive(result); setMessage(""); setError(""); return result.notes;
    } catch (error) { setError((error as Error).message); }
  }
  async function resolve(id: string) {
    setBusy(true); setError("");
    try { const result = await componentRequest<KnowledgeReviewNotesResult>(`${path}/resolve`, { note_ids: [id] }); receive(result); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (modifying || busy || blockedReason) return;
    setBusy(true); setError("");
    try {
      const saved = await save();
      if (!saved) return;
      const result = await componentRequest<KnowledgeReviewNotesResult>(`${path}/apply`, { note_ids: saved.filter(note => matches(note) && note.status === "open").map(note => note.id) });
      receive(result);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  const toggle = <Button size="sm" variant="ghost" onClick={() => setOpen(value => !value)} aria-expanded={open}>{modifying ? <LoaderCircle size={15} className="animate-spin" /> : <MessageSquare size={15} />}{scope === "study" ? "整体文稿意见" : "提意见"}{pending.length ? ` · ${pending.length}` : ""}</Button>;
  return <div className="knowledge-review-notes is-commenting">
    {toolbarTarget ? createPortal(toggle, toolbarTarget) : toolbarTarget === undefined && toggle}
    {submission && <p role="status" aria-live="polite" className="my-2 flex items-center gap-2 text-sm text-muted-foreground">{submission.working && <LoaderCircle size={15} className="shrink-0 animate-spin" />}{submission.status_label}{submission.error && <span className="text-danger">：{submission.error}</span>}</p>}
    {lineNotes ? <Annotatable key={`${path}:${documentId}`} taskId={jobId} artifact={documentId} fallbackFile={documentId} kind="doc" allowImages={false}
      savedMessage="意见已记下，审阅完这份文档后在「提意见」中统一发送。"
      items={current.filter(note => note.scope === "line" && note.status !== "resolved").map(note => ({ id: note.id, artifact: documentId, file: documentId, line: note.line!, status: note.status === "submitted" ? "sent" : "open" }))}
      onAdded={() => {}} onOpenAnnotations={() => setOpen(true)} addDraft={async input => {
        try {
          const result = await componentRequest<KnowledgeReviewNotesResult>(path, { ...input, quote: input.quote ?? input.anchor, document_id: documentId, scope: "line" });
          receive(result); return {};
        } catch (error) { return { error: (error as Error).message }; }
      }}>{children}</Annotatable> : children}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="tw-root max-h-[85dvh] overflow-auto sm:max-w-[640px]">
      <DialogHeader><DialogTitle>{scope === "study" ? "整体文稿意见" : "修改意见"}</DialogTitle></DialogHeader>
      <section className="space-y-3" aria-label="文稿修改意见">
        {scope === "study" && <p className="text-sm text-muted-foreground">针对本次任务的全部文稿说明缺失、重复或需要调整的内容。</p>}
        <Textarea aria-label="整体修改意见" rows={3} disabled={busy} value={message} onChange={event => setMessage(event.target.value)} placeholder={scope === "study" ? "例如：缺少异常恢复说明，几份文档里的接口介绍有重复。" : comments ? "希望怎样调整这份文档？" : "补充整篇意见，或直接发送下方已记下的行意见。"} />
        <div className="flex justify-end gap-2"><Button size="sm" variant="outline" disabled={busy || !message.trim()} onClick={async () => { setBusy(true); await save(); setBusy(false); }}>保存意见</Button>
          {comments ? onEdit && <Button size="sm" disabled={busy} onClick={() => { setOpen(false); onEdit([...pending.map(note => note.note), message].map(text => text.trim()).filter(Boolean).join("\n\n")); }}>去修改</Button> : <Button size="sm" disabled={busy || modifying || !!blockedReason || !message.trim() && !pending.length} onClick={() => void submit()}>{busy ? "正在发送…" : modifying ? "Agent 正在修改…" : "发送并修改"}</Button>}
        </div>
        {submission && <p role="status" className="flex items-center gap-2 text-sm text-primary">{submission.working && <LoaderCircle size={15} className="animate-spin" />}{submission.status_label}</p>}
        {!comments && blockedReason && <p className="text-sm text-muted-foreground">{blockedReason}</p>}
        {!comments && modifying && <p className="text-sm text-muted-foreground">本轮正在处理，可先保存意见，完成后再发送。</p>}
        <div className="knowledge-review-note-list">{current.map(note => <article key={note.id} className="border-b border-line py-3 text-sm">
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><span>{note.operator}</span><span>{note.status === "resolved" ? "已处理" : note.status === "submitted" ? "已交给 Agent" : "待处理"}</span>{note.status !== "resolved" && <Button size="sm" variant="ghost" className="ml-auto" disabled={busy} onClick={() => void resolve(note.id)}>标记已处理</Button>}</div>
          {note.scope === "line" && <p className="mt-2 text-xs text-muted-foreground">第 {note.line}{note.line_end && note.line_end !== note.line ? `–${note.line_end}` : ""} 行</p>}
          {note.quote && <blockquote className="mt-1 border-l-2 border-line pl-3 text-muted-foreground whitespace-pre-wrap">{note.quote}</blockquote>}<p className="mt-2 whitespace-pre-wrap">{note.note}</p>
        </article>)}{!current.length && <p className="py-4 text-sm text-muted-foreground">暂无意见</p>}</div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </section>
    </DialogContent></Dialog>
    {error && !open && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
  </div>;
}
