import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Check, ClipboardCheck, LoaderCircle, MessageSquare, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { componentRequest } from "./componentResearchApi";
import type { KnowledgeReviewNoteInput, KnowledgeReviewNotesResult } from "../../src/knowledgeReviewNoteTypes";

interface InspectionDraft { documentId: string; scope: "document" | "study"; message: string }
interface InspectionState { started: boolean; drafts: InspectionDraft[] }
const emptyResult = (): KnowledgeReviewNotesResult => ({ notes: [], submissions: {} });
const storageKey = (jobId: string) => `mfc:domain-inspection:${jobId}`;
function restore(jobId: string): InspectionState {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(jobId)) ?? "null");
    if (value && typeof value.started === "boolean" && Array.isArray(value.drafts)) return { started: value.started, drafts: value.drafts.filter((item: InspectionDraft) => typeof item.documentId === "string" && (item.scope === "study" || item.scope === "document") && typeof item.message === "string") };
  } catch { /* 浏览器禁止本地存储时，已保存到平台的意见仍可读取。 */ }
  return { started: false, drafts: [] };
}

export function useDomainKnowledgeInspection({ jobId, refreshToken, working, blockedReason, onSubmitted, onStarted, onEnded }: { jobId?: string; refreshToken?: unknown; working: boolean; blockedReason?: string; onSubmitted: () => void; onStarted?: () => void; onEnded?: () => void }) {
  const [state, setState] = useState<InspectionState>(() => jobId ? restore(jobId) : { started: false, drafts: [] });
  const [stateJob, setStateJob] = useState(jobId);
  const [result, setResult] = useState(emptyResult);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [loaded, setLoaded] = useState(false), [inlineEditing, setInlineEditing] = useState(false);
  const owner = useRef(jobId), requestVersion = useRef(0), operation = useRef(false);
  const draftsRef = useRef(state.drafts); draftsRef.current = state.drafts;
  const path = `/knowledge-review/domain/${encodeURIComponent(jobId ?? "")}`;
  useEffect(() => {
    owner.current = jobId; setStateJob(jobId); requestVersion.current++; setState(jobId ? restore(jobId) : { started: false, drafts: [] }); setResult(emptyResult()); setLoaded(false); setError(""); setBusy(false); setInlineEditing(false);
  }, [jobId]);
  useEffect(() => {
    if (!jobId) return;
    // 先恢复对应任务再写回，避免任务切换时把前一个任务的检视状态写入新任务。
    if (stateJob !== jobId) return;
    try { sessionStorage.setItem(storageKey(jobId), JSON.stringify(state)); } catch { /* 平台保存不依赖本地存储。 */ }
  }, [jobId, stateJob, state]);
  useEffect(() => {
    if (!jobId) return;
    let live = true; const version = requestVersion.current;
    void componentRequest<KnowledgeReviewNotesResult>(path).then(next => { if (live && owner.current === jobId && version === requestVersion.current) { setResult(next); setLoaded(true); } }).catch(reason => { if (live) setError(reason.message); });
    return () => { live = false; };
  }, [path, refreshToken]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (inlineEditing) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [inlineEditing]);
  function updateDraft(documentId: string, scope: "document" | "study", message: string) {
    setState(current => ({ ...current, drafts: [...current.drafts.filter(item => item.documentId !== documentId || item.scope !== scope), ...(message ? [{ documentId, scope, message }] : [])] }));
  }
  async function save(input: KnowledgeReviewNoteInput) {
    const version = ++requestVersion.current;
    const next = await componentRequest<KnowledgeReviewNotesResult>(path, input);
    if (owner.current === jobId && version === requestVersion.current) { setResult(next); setLoaded(true); }
    if (owner.current === jobId && input.scope !== "line") setState(current => ({ ...current, drafts: current.drafts.filter(item => item.documentId !== input.document_id || item.scope !== input.scope || item.message !== input.note) }));
    return next;
  }
  async function resolve(id: string) {
    const version = ++requestVersion.current;
    const next = await componentRequest<KnowledgeReviewNotesResult>(`${path}/resolve`, { note_ids: [id] });
    if (owner.current === jobId && version === requestVersion.current) setResult(next);
    return next;
  }
  const submission = Object.values(result.submissions).find(item => item.working);
  const modifying = working || !!submission;
  async function finish() {
    if (!jobId || operation.current || modifying || blockedReason || inlineEditing || !loaded) return;
    operation.current = true; setBusy(true); setError(""); requestVersion.current++;
    try {
      // 关闭弹窗不会丢掉输入；结束检视时先保存所有文稿中尚未点击保存的整篇/整体意见。
      for (const draft of [...draftsRef.current]) if (draft.message.trim()) await save({ document_id: draft.documentId, scope: draft.scope, note: draft.message });
      const latest = await componentRequest<KnowledgeReviewNotesResult>(path);
      if (owner.current !== jobId) return;
      const noteIds = latest.notes.filter(note => note.status === "open").map(note => note.id);
      if (noteIds.length) {
        const next = await componentRequest<KnowledgeReviewNotesResult>(`${path}/apply`, { note_ids: noteIds });
        if (owner.current !== jobId) return;
        requestVersion.current++; setResult(next); setState({ started: false, drafts: [] }); onEnded?.(); onSubmitted();
      } else { setResult(latest); setState({ started: false, drafts: [] }); onEnded?.(); }
    } catch (reason) { if (owner.current === jobId) setError((reason as Error).message); }
    finally { operation.current = false; if (owner.current === jobId) setBusy(false); }
  }
  return { jobId, started: state.started, drafts: state.drafts, result, loaded, busy, error, inlineEditing, modifying, blockedReason,
    pendingCount: result.notes.filter(note => note.status === "open").length,
    start: () => { setError(""); setState(current => ({ ...current, started: true })); onStarted?.(); }, updateDraft, save, resolve, finish, setInlineEditing };
}
export type DomainKnowledgeInspection = ReturnType<typeof useDomainKnowledgeInspection>;
export const DomainKnowledgeInspectionContext = createContext<DomainKnowledgeInspection | undefined>(undefined);
export const useKnowledgeInspection = () => useContext(DomainKnowledgeInspectionContext);

export function DomainKnowledgeInspectionBar({ inspection, onOverall, onProgress }: { inspection: DomainKnowledgeInspection; onOverall: () => void; onProgress: () => void }) {
  if (!inspection.started) return null;
  const drafts = inspection.drafts.filter(item => item.message.trim()).length;
  const reason = inspection.inlineEditing ? "请先记下或取消正在编辑的行意见。" : inspection.blockedReason ?? (inspection.modifying ? "任务正在处理，可继续保存意见，完成后再结束检视。" : undefined);
  return <section aria-label="文稿检视" className="domain-inspection-bar">
    <div className="domain-inspection-label"><span className="domain-inspection-icon"><ClipboardCheck size={18} /></span><div><strong>正在检视</strong><span>{inspection.pendingCount} 条已保存{drafts ? ` · ${drafts} 条待保存` : ""}<span className="domain-inspection-hint"> · 可切换文稿继续提意见</span></span></div></div>
    <div className="domain-inspection-actions"><Button size="sm" variant="ghost" disabled={inspection.busy} onClick={onOverall}><MessageSquare size={15} />整体意见</Button><Button size="sm" disabled={!inspection.loaded || inspection.busy || inspection.modifying || !!reason} title={reason} onClick={() => void inspection.finish()}>{inspection.busy ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}{inspection.busy ? "正在提交…" : inspection.pendingCount || drafts ? "结束检视并修改" : "结束检视"}</Button></div>
    {(reason || inspection.error) && <p role={inspection.error ? "alert" : "status"} className={inspection.error ? "text-danger" : "text-muted-foreground"}>{inspection.error || reason}{inspection.modifying && <button className="ml-2 text-primary underline-offset-4 hover:underline" onClick={onProgress}>查看研究过程</button>}</p>}
  </section>;
}
export function DomainKnowledgeInspectionStart({ inspection, disabled }: { inspection: DomainKnowledgeInspection; disabled?: boolean }) {
  if (inspection.started) return null;
  return <Button size="sm" variant="outline" disabled={disabled || inspection.busy || !inspection.loaded} onClick={inspection.start}><Play size={14} />开始检视{inspection.pendingCount ? <span className="domain-inspection-count">{inspection.pendingCount}</span> : null}</Button>;
}
