import { ResizableKnowledgePanes } from "./ResizableKnowledgePanes";
import { useKnowledgeStudio } from "./KnowledgeStudioContext";
import { KnowledgeReadingFrame } from "./KnowledgeReadingFrame";
import { KnowledgeResearchProgress } from "./KnowledgeResearchProgress";
import { KnowledgeSourceCleanup, type KnowledgeCleanupDraft } from "./KnowledgeSourceCleanup";
import { DomainKnowledgeArchiveTargets } from "./DomainKnowledgeArchiveTargets";
import { DomainKnowledgeFileTree } from "./DomainKnowledgeFileTree";
import { DomainKnowledgeConfirmation } from "./DomainKnowledgeConfirmation";
import { DomainKnowledgePublicationStatus } from "./DomainKnowledgePublicationStatus";
import { KnowledgeReviewNotes } from "./KnowledgeReviewNotes";
import { KnowledgeContentSearch } from "./KnowledgeContentSearch";
import { KnowledgeBackButton } from "./KnowledgeBackButton";
import { KnowledgeTaskReady, KnowledgeTaskTabs } from "./KnowledgeTaskNavigation";
import { confirmDomainPublication, domainDocumentHasChanges, domainProposalProblem, domainPublicationInput, domainReviewDocument, latestDomainProposal } from "./domainKnowledgePublication";
import { KnowledgeMarkdown, type KnowledgeFocus } from "./KnowledgeMarkdown";
import { resolveKnowledgeReference } from "./knowledgeStructure";
import { getBusinessModules, type BusinessModule } from "./api";
import { useEffect, useRef, useState } from "react";
import { diffLines } from "diff";
import { MoreHorizontal, Send, FileText, ArrowUpRight } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KnowledgeExtractionWorkspace } from "./KnowledgeExtractionWorkspace";
import { ExtractionSkillEditor, openExtractionSkill } from "./ExtractionSkillEditor";
import { KnowledgeMaterialUpload, type MaterialSummary } from "./KnowledgeMaterialUpload";
import { componentRequest } from "./componentResearchApi";
import { Markdown } from "./markdown";
import type { DomainKnowledgeJob, DomainDocument } from "../../src/domainKnowledgeTypes";

const body = (doc: { content: string; sources: string }) => doc.content;
export function DomainKnowledgeExtraction({ focusId, surface, onViewKnowledge, onBack, focused = false, cleanupDraft, onCleanupDraftChange }: { focusId?: string; surface?: "knowledge" | "workbench"; onViewKnowledge?: (documentId: string) => void; onBack?: () => void; focused?: boolean; cleanupDraft?: KnowledgeCleanupDraft; onCleanupDraftChange?: (draft: KnowledgeCleanupDraft) => void }) {
  const studio = useKnowledgeStudio();
  const [instructions, setInstructions] = useState("");
  const [records, setRecords] = useState<DomainKnowledgeJob[]>([]), [job, setJob] = useState<DomainKnowledgeJob>(), [selected, setSelected] = useState(() => {
    const params = new URLSearchParams(location.search);
    return params.get("kbKind") === "domain" ? params.get("kbTask") ?? "" : "";
  });
  const selectedRef = useRef(selected);
  const searchableContent = useRef<HTMLDivElement>(null);
  const [notesToolbar, setNotesToolbar] = useState<HTMLSpanElement | null>(null);
  const [notesOpenRequest, setNotesOpenRequest] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [modules, setModules] = useState<BusinessModule[]>([]), [moduleId, setModuleId] = useState("");
  const [issueNo, setIssueNo] = useState(""), [issueDescription, setIssueDescription] = useState("");
  const [baselineBranch, setBaselineBranch] = useState("master");
  const module = modules.find(item => item.id === moduleId);
  const [materials, setMaterials] = useState<MaterialSummary[]>([]), [uploading, setUploading] = useState(false);
  const [extraMaterials, setExtraMaterials] = useState<MaterialSummary[]>([]);
  const [archiveOpenRequest, setArchiveOpenRequest] = useState(0);
  const [knowledgeFocus, setKnowledgeFocus] = useState<KnowledgeFocus>();
  const [related, setRelated] = useState(false), [showDiscussion, setShowDiscussion] = useState(false);
  const [documentId, setDocumentId] = useState(() => new URLSearchParams(location.search).get("knowledgeDocument") ?? ""), [tab, setTab] = useState<"content" | "diff" | "history" | "sources">("content"), [stage, setStage] = useState("review");
  const [message, setMessage] = useState(""), [latest, setLatest] = useState(false), [edit, setEdit] = useState<DomainDocument>();
  const [workDocumentId, setWorkDocumentId] = useState("");
  const waiting = job?.status === "paused" ? job.turns.at(-1)?.waiting : undefined;
  const preparingCleanup = !!job?.source_cleanup && !job.source_cleanup.started;
  const currentStage = preparingCleanup ? "progress" : stage;
  useEffect(() => { if (new URLSearchParams(location.search).get("kbStage") === "publish") setArchiveOpenRequest(value => value + 1); else setArchiveOpenRequest(0); if (surface) setStage(surface === "knowledge" ? "review" : "progress"); }, [surface, focusId]);
  const active = job?.production?.working, document = job?.documents.find(d => d.id === documentId) ?? job?.documents[0];
  const workDocument = job?.work_documents?.find(item => `${item.turn_id}:${item.id}` === workDocumentId) ?? (!document ? job?.work_documents?.[0] : undefined);
  useEffect(() => {
    const first = job?.work_documents?.[0];
    if (!workDocumentId && !document && first) setWorkDocumentId(`${first.turn_id}:${first.id}`);
  }, [job?.id, job?.work_documents, document, workDocumentId]);
  const turns = job?.turns.filter(t => t.document_ids.includes(document?.id ?? "")) ?? [];
  const pending = job && document ? latestDomainProposal(job, document.id) : undefined;
  const proposalTurn = pending?.turn, proposal = pending?.proposal;
  const reviewDocument = job && document ? domainReviewDocument(job, document) : undefined;
  const proposalProblem = job && document ? domainProposalProblem(job, document) : undefined;
  const publication = job ? domainPublicationInput(job) : { document_ids: [], expected_revisions: {} };
  const publicationCount = publication.document_ids.length;
  const publishedRevision = job && document ? job.production?.documents.find(item => item.id === document.id)?.published_revision : undefined;
  const changed = !!job && !!document && domainDocumentHasChanges(job, document);
  const publicationProblem = job?.documents.filter(doc => doc.selected).map(doc => domainProposalProblem(job, doc)).find(Boolean);
  const lifecycle = job?.production?.status_label ?? "";
  function navigateKnowledge(id: string, line?: number, anchor?: string) {
    if (edit?.id === id && (line !== undefined || !!anchor)) { setError("请先保存或取消当前编辑，再跳转章节。"); return; }
    setWorkDocumentId(""); setDocumentId(id); setTab("content"); setMessage(""); setError("");
    setKnowledgeFocus(old => ({ line, anchor, token: (old?.token ?? 0) + 1 }));
  }
  function changeView(next: "progress" | "review") {
    if (edit) { setError("请先保存或取消正文编辑，再切换视图。"); return; }
    setStage(next);
    if (job && studio) next === "review" ? studio.openResult("domain", job.id) : studio.openExecution("domain", job.id);
  }
  function readWorkDocument(turnId: string, id: string) {
    if (edit) { setError("请先保存或取消当前编辑，再查看过程文稿。"); return; }
    setWorkDocumentId(`${turnId}:${id}`); setShowDiscussion(false); setTab("content"); changeView("review");
  }
  async function refreshList() { const result = await componentRequest<{ records: DomainKnowledgeJob[] }>("/domain-extraction"); setRecords(result.records); }
  useEffect(() => { void getBusinessModules().then(result => setModules(result.modules.filter(m => m.status === "active"))).catch(e => setError(e.message)); void refreshList().catch(e => setError(e.message)); }, []);
  useEffect(() => {
    if (!selected || busy) return; let live = true;
    const load = async () => { try { const next = await componentRequest<DomainKnowledgeJob>(`/domain-extraction/${selected}`); if (live && selectedRef.current === selected) setJob(next); } catch (e) { if (live && selectedRef.current === selected) setError((e as Error).message); } };
    void load(); const timer = setInterval(() => void load(), 4000); return () => { live = false; clearInterval(timer); };
  }, [selected, busy]);
  function select(id: string) {
    const url = new URL(location.href);
    selectedRef.current = id; setDeleting(false); setSelected(id); setJob(undefined); setDocumentId(url.searchParams.get("kbTask") === id ? url.searchParams.get("knowledgeDocument") ?? "" : ""); setWorkDocumentId(""); setEdit(undefined); setMessage(""); setExtraMaterials([]);
    url.searchParams.set("kbPage", id ? "task" : "research");
    url.searchParams.set("kbKind", "domain");
    if (id) url.searchParams.set("kbTask", id);
    else { url.searchParams.delete("kbTask"); url.searchParams.delete("kbReview"); }
    history.replaceState(history.state, "", url);
  }
  useEffect(() => { if (focusId === "new") { if (surface === "workbench") setOpen(true); } else if (focusId) { if (focusId !== selectedRef.current) select(focusId); setOpen(false); } }, [focusId, surface]);
  async function action(name: string, input: unknown = {}) {
    if (!job) return false; setBusy(true); setError("");
    try { setJob(await componentRequest<DomainKnowledgeJob>(`/domain-extraction/${job.id}/${name}`, input)); await refreshList(); return true; }
    catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  }
  async function publishSelected() {
    if (!job || !publicationCount || busy || active || edit) return;
    setBusy(true); setError("");
    try {
      const published = await confirmDomainPublication(job, async (name, input) => {
        const next = await componentRequest<DomainKnowledgeJob>(`/domain-extraction/${job.id}/${name}`, input);
        setJob(next); return next;
      });
      setJob(published); setStage("review"); setTab("content"); await refreshList();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!job) return;
    const id = job.id; setBusy(true); setError("");
    try {
      await componentRequest<{ deleted: boolean }>(`/domain-extraction/${id}/delete`, {});
      if (selectedRef.current === id) select("");
      setRecords(current => current.filter(record => record.id !== id));
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  async function run(mode: "discuss" | "revise" | "update") {
    if (document && await action("run", { mode, document_ids: related ? job!.documents.filter(d => d.selected).map(d => d.id) : [document.id], message, use_latest_skill: latest })) setMessage("");
  }
  return <KnowledgeExtractionWorkspace hideHeader={!!job} title="领域知识萃取" onNew={() => setOpen(true)} onClose={onBack} backLabel="任务中心" actions={<ExtractionSkillEditor kind="domain" />}
    sidebar={focused || surface === "knowledge" ? undefined : <div className="space-y-2">{records.map(record => <button key={record.id} className={`w-full rounded-lg border p-3 text-left ${selected === record.id ? "border-primary bg-primary/5" : "border-line"}`} onClick={() => select(record.id)}><strong className="block">{record.title}</strong><span className="mt-2 block text-sm text-muted-foreground">{record.repositories.length} 个业务仓 · {record.stage}</span></button>)}{!records.length && <p className="text-muted-foreground">暂无领域萃取记录</p>}</div>}>
    {!job && error && <p role="alert" className="mb-3 text-danger">{error}</p>}
    {job ? <><header className={`studio-result-toolbar${focused ? " domain-focused-toolbar" : ""}`}>
      {onBack && <KnowledgeBackButton onClick={onBack} destination="任务中心" />}
      <FileText size={21} /><strong title={job.title}>{job.title}</strong><span className={`studio-job-status ${active ? "is-active" : ""}`}>{lifecycle}</span>
      {!preparingCleanup && <KnowledgeTaskTabs value={currentStage} onChange={changeView} documentCount={job.documents.length + (job.work_documents?.length ?? 0)} view={job.production} disabled={!!edit} />}
      <div className="studio-result-actions">
        <DomainKnowledgePublicationStatus compact job={job} disabled={busy || !!edit} openRequest={archiveOpenRequest} onConfigure={() => setStage("publish")} onChanged={() => {
          void componentRequest<DomainKnowledgeJob>(`/domain-extraction/${job.id}`, undefined, AbortSignal.timeout(30_000))
            .then(next => { if (selectedRef.current === job.id) setJob(next); }).catch(reason => { if (selectedRef.current === job.id) setError(reason.message); });
        }} />
        {job.production?.research_actions.map(item => item.id === "stop" ? <Button key={item.id} variant="outline" disabled={busy} onClick={() => void action("stop")}>{item.label}</Button> : item.id === "resume" ? <Button key={item.id} disabled={busy} onClick={() => { void action("resume", { use_latest_skill: latest || !job.turns.at(-1)?.research }); changeView("progress"); }}>{item.label}</Button> : currentStage === "review" && (item.id === "update" ? <Button key={item.id} disabled={busy || !document} onClick={() => { setTab("content"); setNotesOpenRequest(value => value + 1); }}>{item.label}</Button> : <Button key={item.id} disabled={busy || !!edit || !publicationCount || !!publicationProblem} title={publicationProblem} onClick={() => void publishSelected()}><ArrowUpRight size={17} />{busy ? "正在发布…" : `${item.label}（${publicationCount}）`}</Button>))}
        <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多萃取操作" />}><MoreHorizontal size={20} /></DropdownMenuTrigger><DropdownMenuContent align="end">
          {!preparingCleanup && <DropdownMenuItem onClick={() => setStage("inputs")}>资料</DropdownMenuItem>}
          {!active && job.status === "done" && job.turns.at(-1)?.mode === "extract" && <DropdownMenuItem disabled={busy} onClick={() => { void action("resume", { use_latest_skill: latest || !job.turns.at(-1)?.research }); changeView("progress"); }}>继续深入研究</DropdownMenuItem>}
          <DropdownMenuItem onClick={() => openExtractionSkill("domain")}>查看 Skill</DropdownMenuItem>
          <DropdownMenuItem onClick={() => { studio?.openExecution("domain"); setOpen(true); }}>新建萃取任务</DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onClick={() => { setError(""); setDeleting(true); }}>删除任务</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
      </div>
    </header>
      {!preparingCleanup && <KnowledgeTaskReady value={currentStage} onChange={changeView} view={job.production} disabled={!!edit} />}
      {!preparingCleanup && waiting && <DomainKnowledgeConfirmation key={`${job.id}:${waiting.id}`} job={job} waiting={waiting} compact={currentStage !== "progress"} disabled={busy || !!edit} onRead={id => { navigateKnowledge(id); changeView("review"); }} onReadWork={readWorkDocument} onShow={() => changeView("progress")} onReply={reply => action("resume", { request_id: waiting.id, message: reply })} />}
      {error && <p role="alert" className="shrink-0 px-4 py-2 text-sm text-danger">{error}</p>}
      {!preparingCleanup && job.production?.platform_message && <p className="shrink-0 px-4 py-2 text-xs text-muted-foreground">{job.production.platform_message}</p>}
      {currentStage === "review" && publicationProblem && <p role="alert" className="shrink-0 px-4 py-2 text-sm text-amber-700">{publicationProblem}</p>}
      {job.error && <p className="mb-3 text-danger">{job.error}</p>}
      {currentStage === "inputs" && <div className="knowledge-task-progress space-y-4"><p>{job.scope}</p>{job.instructions && <div><h4 className="font-medium">本次要求</h4><p className="mt-2 whitespace-pre-wrap break-words">{job.instructions}</p></div>}{(job.source_repositories ?? job.repositories).map(repo => <div key={repo.id} className="rounded border border-line p-3 text-sm"><strong>{repo.name}</strong><p className="break-all">{repo.repository} · {repo.branch} · {repo.path || "全仓"}</p><p>读取版本：{job.revisions[repo.id]?.slice(0, 12) ?? "未读取"}</p></div>)}<p>已关联 {job.material_ids.length} 份上传资料</p><KnowledgeMaterialUpload materials={extraMaterials} onChange={setExtraMaterials} onBusy={setUploading} /><Button disabled={busy || uploading || active || !document} onClick={() => void action("run", { mode: "update", document_ids: job.documents.map(d => d.id), message: "核对补充资料与当前来源，更新受影响文档；未变化内容保留", material_ids: [...new Set([...job.material_ids, ...extraMaterials.map(m => m.id)])], use_latest_skill: latest })}>用补充资料生成更新建议</Button></div>}
      <div hidden={currentStage !== "progress"} className="knowledge-task-progress space-y-4">{preparingCleanup ? <KnowledgeSourceCleanup key={job.id} task={job} draft={cleanupDraft} onDraftChange={onCleanupDraftChange} onBusy={value => { if (selectedRef.current === job.id) setBusy(value); }} onChange={next => { if (selectedRef.current === next.id) setJob(next); }} /> : <>{!!job.turns.at(-1)?.research?.capabilities.length && <details className="rounded border border-line p-3"><summary className="cursor-pointer text-sm">{job.production?.review.progress_message}</summary><ul className="mt-3 list-none space-y-2 p-0 text-sm">{job.turns.at(-1)!.research!.capabilities.map(c => <li key={c.id}><strong>{c.title}</strong> · {job.production?.review.capabilities.find(item => item.id === c.id)?.status_label}{c.findings && <p className="whitespace-pre-wrap text-muted-foreground">{c.findings}</p>}</li>)}</ul></details>}{!!job.work_documents?.length && <section aria-label="已生成的过程文稿" className="rounded border border-line p-3"><strong className="text-sm">已生成的过程文稿</strong><div className="mt-2 flex flex-wrap gap-2">{job.work_documents.map(item => <Button key={`${item.turn_id}:${item.id}`} size="sm" variant="outline" onClick={() => readWorkDocument(item.turn_id, item.id)}>{item.title}</Button>)}</div></section>}{!!job.turns.at(-1)?.human_replies?.length && <details className="rounded border border-line p-3"><summary className="text-sm">已提交的答复</summary>{job.turns.at(-1)!.human_replies!.map(item => <article key={item.request_id} className="mt-3 text-sm"><p className="text-muted-foreground">{item.operator} · {new Date(item.at).toLocaleString()}</p><p className="whitespace-pre-wrap break-words">{item.message}</p></article>)}</details>}<KnowledgeResearchProgress key={job.id} evidence={job.evidence} /></>}</div>
      <div hidden={currentStage !== "review"} className="knowledge-task-review" style={currentStage === "review" ? { display: "flex", flex: "1 1 0", minHeight: 0, flexDirection: "column", overflow: "hidden" } : undefined}><KnowledgeReadingFrame focused={focused} sidePanelOpen={showDiscussion} documentActions={workDocument ? <KnowledgeContentSearch contentRef={searchableContent} contentKey={`${job.id}:${workDocument.turn_id}:${workDocument.id}:${workDocument.content}`} contentSelector=".md" /> : <><span ref={setNotesToolbar} className="flex items-center" />{document && tab === "content" && edit?.id !== document.id && <KnowledgeContentSearch contentRef={searchableContent} contentKey={`${job.id}:${document.id}:${document.revision}:${proposalTurn?.id ?? ""}:${reviewDocument?.content ?? ""}`} contentSelector=".md" />}<Button size="sm" variant="ghost" onClick={() => setTab("content")}>正文</Button><Button size="sm" variant="ghost" disabled={!document || busy || active || !!proposal} title={proposal ? "当前修改待确认，可提意见继续调整，或放弃修改后人工编辑。" : undefined} onClick={() => { setEdit(structuredClone(document)); setTab("content"); }}>{document?.knowledge_document_id ? "修改为新稿" : "编辑"}</Button><DropdownMenu><DropdownMenuTrigger render={<Button size="icon" variant="ghost" aria-label="更多领域文档操作" />}><MoreHorizontal size={18} /></DropdownMenuTrigger><DropdownMenuContent align="end">{([["diff", "修订差异"], ["sources", "来源"], ["history", "历史版本"]] as const).map(([value, label]) => <DropdownMenuItem key={value} onClick={() => setTab(value)}>{label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></>} title={workDocument?.title ?? document?.path.split("/").at(-1) ?? "知识文档"} actions={<><KnowledgeReviewNotes refreshToken={job} kind="domain" jobId={job.id} documentId="" scope="study" working={!!active} blockedReason={waiting ? "请先答复任务上方的待确认内容，再发送意见。" : undefined} />{workDocument ? <Button size="sm" variant="ghost" onClick={() => changeView("progress")}>返回研究过程</Button> : <Button size="sm" variant="ghost" onClick={() => setShowDiscussion(!showDiscussion)}>{showDiscussion ? "收起讨论" : "讨论与修订"}</Button>}</>}><ResizableKnowledgePanes className="research-review-panes">
        <DomainKnowledgeFileTree job={job} currentId={workDocument ? undefined : document?.id} currentWorkId={workDocument ? `${workDocument.turn_id}:${workDocument.id}` : undefined} onWorkNavigate={readWorkDocument} onNavigate={navigateKnowledge} disabled={busy || active} onSelection={(id, selected) => void action("selection", { ids: [id], selected })} onSelections={(ids, selected) => void action("selection", { ids, selected })} />
        <div className="research-reader" style={{ gridTemplateColumns: showDiscussion ? "minmax(0, 1fr) 300px" : "minmax(0, 1fr)" }}>{workDocument ? <div className="research-document-content studio-paper"><p className="mb-3 text-sm text-muted-foreground">过程文稿</p><div ref={searchableContent}><KnowledgeMarkdown text={workDocument.content} /></div></div> : document ? <><div className="research-document-content studio-paper">
          <div className={focused ? "domain-review-document-meta flex items-center gap-2 text-xs text-muted-foreground" : "mb-4 flex flex-wrap items-center gap-2 border-b border-line pb-3 text-xs text-muted-foreground"} title={document.path}>
            {!focused && <span className="break-all">{document.path}</span>}<span>{proposal && !proposalProblem ? "修改结果" : `草稿 v${document.revision}`}</span>{publishedRevision !== undefined && <span>· 已发布基线 v{publishedRevision}</span>}<strong className={changed ? "text-amber-700" : "text-emerald-700"} title={document.knowledge_document_id && changed ? "当前修订尚未发布，Agent 继续使用上一份正式知识。" : undefined}>{job.production?.documents.find(item => item.id === document.id)?.status_label}</strong>{document.knowledge_document_id && onViewKnowledge && <Button size="sm" variant="link" onClick={() => onViewKnowledge(document.knowledge_document_id!)}>查看正式知识</Button>}
          </div>
          {!focused && document.knowledge_document_id && changed && <p className="mb-3 text-xs text-muted-foreground">当前修订尚未发布，Agent 继续使用上一份正式知识。</p>}
          {tab === "content" && (edit?.id === document.id ? <div className="space-y-3"><Input aria-label="文档标题" value={edit.title} onChange={e => setEdit({ ...edit, title: e.target.value })} /><Textarea aria-label="编辑领域文档" rows={20} value={edit.content} onChange={e => setEdit({ ...edit, content: e.target.value })} /><Textarea aria-label="编辑文档来源" rows={5} value={edit.sources} onChange={e => setEdit({ ...edit, sources: e.target.value })} /><Button disabled={busy} onClick={async () => { if (await action("edit", { document: edit, base_revision: edit.revision })) setEdit(undefined); }}>保存人工版本</Button><Button variant="outline" onClick={() => setEdit(undefined)}>取消</Button></div> : <KnowledgeReviewNotes refreshToken={job} kind="domain" jobId={job.id} documentId={document.id} toolbarTarget={notesToolbar} working={!!active} blockedReason={waiting ? "请先答复任务上方的待确认内容，再发送意见。" : undefined} openRequest={notesOpenRequest}><div ref={searchableContent}><KnowledgeMarkdown text={reviewDocument?.content ?? document.content} focus={knowledgeFocus} onReference={href => {
            const found = resolveKnowledgeReference(job.documents, reviewDocument ?? document, href);
            if (!found) return false; navigateKnowledge(found.item.id, undefined, found.anchor); return true;
          }} /></div></KnowledgeReviewNotes>)}
          {tab === "sources" && <Markdown text={reviewDocument?.sources ?? document.sources} />}
          {tab === "diff" && (proposal ? <><p className={`mb-3 text-sm ${proposalProblem ? "text-amber-700" : "text-muted-foreground"}`}>{proposalProblem ?? "正文已展示这份修改结果，检视后可在顶部确认并发布。"}</p><pre className="whitespace-pre-wrap break-words text-sm">{diffLines(body(document), body(proposal.document)).map((part, i) => <span key={i} className={part.added ? "bg-green-500/15" : part.removed ? "bg-red-500/15 line-through" : ""}>{part.value}</span>)}</pre><div className="mt-4 flex gap-2"><Button variant="outline" disabled={busy || active} onClick={() => void action("proposal", { turn_id: proposalTurn!.id, document_id: document.id, decision: "discard" })}>放弃本次修改</Button></div></> : <p>没有待确认的修改。</p>)}
          {tab === "history" && <div className="space-y-3">{[...document.history].reverse().map(h => <details key={h.revision}><summary>v{h.revision} · {h.operator} · {new Date(h.at).toLocaleString()}</summary><Markdown text={body(h)} /><Button disabled={busy} onClick={() => void action("restore", { document_id: document.id, revision: h.revision, base_revision: document.revision })}>恢复为新版本</Button></details>)}{!document.history.length && <p>尚无历史版本。</p>}</div>}
        </div>{showDiscussion && <section className="research-discussion"><h4 className="font-semibold">与 AI 讨论 · {document.title}</h4><p className="mt-2 text-sm text-muted-foreground">讨论保留原稿。修改完成后直接检视新稿，确认发布后生效。</p><div className="my-4 space-y-4">{turns.map(turn => <article key={turn.id} className="border-b border-line pb-3 text-sm"><p className="mb-1 text-xs text-muted-foreground">{turn.operator} · {({ discuss: "讨论", revise: "生成修订建议", update: "核对来源更新", extract: "研究" } as Record<string, string>)[turn.mode] ?? turn.mode} · {new Date(turn.created_at).toLocaleString()}{turn.skill && ` · Skill ${turn.skill.digest.slice(0, 8)}`}</p><p className="whitespace-pre-wrap">{turn.message}</p>{turn.reply && <Markdown text={turn.reply} />}{turn.error && <p className="text-danger">{turn.error}</p>}<p className="text-muted-foreground">{job.production?.review.turns.find(item => item.id === turn.id)?.status_label}</p>{turn.proposals.some(p => p.document.id === document.id && p.status === "pending") && <Button variant="link" onClick={() => setTab("diff")}>查看修改差异</Button>}</article>)}</div><label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={latest} onChange={e => setLatest(e.target.checked)} />下一轮用最新领域 Skill</label><label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={related} onChange={e => setRelated(e.target.checked)} />同时处理已勾选的关联文档</label><Textarea aria-label="领域知识修订意见" rows={5} value={message} onChange={e => setMessage(e.target.value)} placeholder="补充问题、纠正业务规则或说明更新范围…" /><div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" disabled={busy || active || !message.trim()} onClick={() => void run("discuss")}>仅讨论</Button><Button disabled={busy || active || !message.trim()} onClick={() => void run("revise")}>生成建议</Button><Button variant="outline" disabled={busy || active || !message.trim()} onClick={() => void run("update")}>核对来源更新</Button></div></section>}</> : <p className="p-5">研究完成的文档会逐步显示在这里。</p>}</div>
      </ResizableKnowledgePanes>{!focused && document && !showDiscussion && <form className="studio-refine-bar" onSubmit={event => { event.preventDefault(); if (!busy && !active && message.trim()) { void run("revise"); setShowDiscussion(true); } }}>
        <Textarea aria-label="快速修订知识" rows={1} value={message} onChange={event => setMessage(event.target.value)} placeholder="补充或修改这份知识…" />
        <Button type="submit" size="icon" aria-label="生成修订建议" disabled={busy || active || !message.trim()}><Send size={18} /></Button>
      </form>}</KnowledgeReadingFrame></div>
      {currentStage === "publish" && <div className="knowledge-task-progress space-y-4"><div className="flex items-start justify-between gap-4"><h3 className="font-semibold">Git 归档设置</h3><KnowledgeBackButton onClick={() => changeView("review")} destination="文稿" /></div><DomainKnowledgeArchiveTargets job={job} disabled={busy || active || !!edit} onChange={setJob} />{edit && <p className="text-sm text-muted-foreground">请先保存或取消正文编辑，再调整归档位置。</p>}</div>}
    </> : <p className="p-8 text-muted-foreground">{selected ? "正在加载任务…" : "选择历史任务，或新建领域萃取。"}</p>}
    <Dialog open={deleting} onOpenChange={setDeleting}><DialogContent className="tw-root sm:max-w-[480px]"><DialogHeader><DialogTitle>删除领域萃取任务？</DialogTitle></DialogHeader><p className="font-medium">{job?.title}</p><p className="text-sm text-muted-foreground">{job?.deletion?.message}</p>{job?.deletion?.archive_batches.map(batch => <div key={batch.id} className="rounded border border-line p-3 text-sm"><strong>{batch.id}</strong>{batch.error && <p className="text-danger">{batch.error}</p>}<ul>{batch.documents.map(document => <li key={document.id}>{document.title} · {document.path}</li>)}</ul>{batch.publications.map(publication => <p key={`${publication.target_id}:${publication.branch}`}>{publication.error}{publication.url && <a className="ml-2 text-primary underline" href={publication.url} target="_blank" rel="noreferrer">查看 MR</a>}</p>)}</div>)}{error && <p role="alert" className="text-danger">{error}</p>}<div className="flex justify-end gap-3"><Button variant="outline" disabled={busy} onClick={() => setDeleting(false)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>确认删除</Button></div></DialogContent></Dialog>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="tw-root sm:max-w-[850px] max-h-[90vh] overflow-auto"><DialogHeader><DialogTitle>新建领域知识萃取</DialogTitle></DialogHeader>{error && <p role="alert" className="text-danger">{error}</p>}<div className="space-y-5"><label className="grid gap-2">业务模块<select aria-label="萃取业务模块" className="rounded border border-line bg-surface p-2" value={moduleId} onChange={e => setModuleId(e.target.value)}><option value="">请选择业务模块</option>{modules.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{module && <p className="text-sm">{module.name} · 已关联 {module.repositories.length} 个代码仓</p>}<label className="grid gap-2">统一基准分支<Input aria-label="统一基准分支" value={baselineBranch} onChange={e => setBaselineBranch(e.target.value)} placeholder="master" /><span className="text-sm text-muted-foreground">本次关联仓库统一读取此分支。</span></label><><div className="grid grid-cols-[240px_minmax(0,1fr)] gap-3"><label className="grid gap-2">关联单号（必填）<Input aria-label="领域萃取关联单号" required maxLength={120} value={issueNo} onChange={e => setIssueNo(e.target.value)} placeholder="填写本次知识归档关联的需求或问题单号" /><span className="text-sm text-muted-foreground">本任务创建的所有 MR 关联此单号。</span></label><label className="grid gap-2">单号描述（必填）<Input aria-label="领域萃取单号描述" required maxLength={2000} value={issueDescription} onChange={e => setIssueDescription(e.target.value)} placeholder="从关联单据复制准确描述" /><span className="text-sm text-muted-foreground">从关联单据复制准确描述，将原样用作 MR 标题</span></label></div><p className="text-sm text-muted-foreground">归档仓和文档目录可在「Git 归档设置」调整，系统会带出默认位置。</p></><label className="grid gap-2">本次要求（可选）<Textarea aria-label="本次萃取要求" rows={4} maxLength={20000} value={instructions} onChange={e => setInstructions(e.target.value)} placeholder={"例如：只萃取订单模块的退款流程；不要读取 docs/ 和 legacy/payment.ts；用业务人员能看懂的语言说明规则。"} /></label><KnowledgeMaterialUpload materials={materials} onChange={setMaterials} onBusy={setUploading} /><Button disabled={busy || uploading || !issueNo.trim() || !issueDescription.trim() || !module || (!!module.repositories.length && !baselineBranch.trim())} onClick={async () => { setBusy(true); setError(""); try { const next = await componentRequest<DomainKnowledgeJob>("/domain-extraction", { issue_no: issueNo, issue_description: issueDescription, module_id: moduleId, instructions: instructions.trim() || undefined, baseline_branch: baselineBranch, material_ids: materials.map(m => m.id) }); select(next.id); setJob(next); setStage("progress"); setOpen(false); setInstructions(""); await refreshList(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>开始萃取</Button></div></DialogContent></Dialog>
  </KnowledgeExtractionWorkspace>;
}
