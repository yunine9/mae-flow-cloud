import { useKnowledgeStudio } from "./KnowledgeStudioContext";
import { KnowledgeReadingFrame } from "./KnowledgeReadingFrame";
import { KnowledgeSourceCleanup } from "./KnowledgeSourceCleanup";
import { KnowledgeResearchProgress } from "./KnowledgeResearchProgress";
import { DomainKnowledgeArchiveTargets } from "./DomainKnowledgeArchiveTargets";
import { DomainKnowledgeFileTree } from "./DomainKnowledgeFileTree";
import { DomainKnowledgePublicationStatus } from "./DomainKnowledgePublicationStatus";
import { KnowledgeReviewNotes } from "./KnowledgeReviewNotes";
import { KnowledgeContentSearch } from "./KnowledgeContentSearch";
import { KnowledgeBackButton } from "./KnowledgeBackButton";
import { KnowledgeTaskNavigation } from "./KnowledgeTaskNavigation";
import { confirmDomainPublication, domainDocumentHasChanges, domainProposalProblem, domainPublicationInput, domainReviewDocument, latestDomainProposal, publishedDomainRevision } from "./domainKnowledgePublication";
import { KnowledgeMarkdown, type KnowledgeFocus } from "./KnowledgeMarkdown";
import { resolveKnowledgeReference } from "./knowledgeStructure";
import { KnowledgeCleanupOptions } from "./KnowledgeCleanupOptions";
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
const ignoreCleanupState = () => {};
export function DomainKnowledgeExtraction({ focusId, surface, onViewKnowledge, onBack, focused = false }: { focusId?: string; surface?: "knowledge" | "workbench"; onViewKnowledge?: (documentId: string) => void; onBack?: () => void; focused?: boolean }) {
  const studio = useKnowledgeStudio();
  const [instructions, setInstructions] = useState("");
  const [records, setRecords] = useState<DomainKnowledgeJob[]>([]), [job, setJob] = useState<DomainKnowledgeJob>(), [selected, setSelected] = useState((new URLSearchParams(location.search).get("domainExtraction") === "new" ? "" : new URLSearchParams(location.search).get("domainExtraction")) ?? "");
  const selectedRef = useRef(selected);
  const searchableContent = useRef<HTMLDivElement>(null);
  const [notesToolbar, setNotesToolbar] = useState<HTMLSpanElement | null>(null);
  const [notesOpenRequest, setNotesOpenRequest] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [modules, setModules] = useState<BusinessModule[]>([]), [moduleId, setModuleId] = useState("");
  const [issueNo, setIssueNo] = useState(""), [issueDescription, setIssueDescription] = useState("");
  const [legacyIssueNo, setLegacyIssueNo] = useState<string>(), [legacyIssueDescription, setLegacyIssueDescription] = useState<string>();
  const [baselineBranch, setBaselineBranch] = useState("master");
  const module = modules.find(item => item.id === moduleId);
  const [materials, setMaterials] = useState<MaterialSummary[]>([]), [uploading, setUploading] = useState(false);
  const [extraMaterials, setExtraMaterials] = useState<MaterialSummary[]>([]);
  const [archiveBlocked, setArchiveBlocked] = useState(false);
  const [knowledgeFocus, setKnowledgeFocus] = useState<KnowledgeFocus>();
  const [related, setRelated] = useState(false), [showDiscussion, setShowDiscussion] = useState(false);
  const [documentId, setDocumentId] = useState(""), [tab, setTab] = useState<"content" | "diff" | "history" | "sources" | "remote">("content"), [stage, setStage] = useState("review");
  const [message, setMessage] = useState(""), [latest, setLatest] = useState(false), [edit, setEdit] = useState<DomainDocument>();
  const currentStage = stage;
  useEffect(() => { if (surface) setStage(surface === "knowledge" ? "review" : "progress"); }, [surface]);
  useEffect(() => { if (job?.source_cleanup && !job.source_cleanup.started) setStage("cleanup"); }, [job?.id]);
  const active = job && ["queued", "running"].includes(job.status), document = job?.documents.find(d => d.id === documentId) ?? job?.documents[0];
  const turns = job?.turns.filter(t => t.document_ids.includes(document?.id ?? "")) ?? [];
  const pending = job && document ? latestDomainProposal(job, document.id) : undefined;
  const proposalTurn = pending?.turn, proposal = pending?.proposal;
  const reviewDocument = job && document ? domainReviewDocument(job, document) : undefined;
  const proposalProblem = job && document ? domainProposalProblem(job, document) : undefined;
  const publication = job ? domainPublicationInput(job) : { document_ids: [], expected_revisions: {} };
  const publicationCount = publication.document_ids.length;
  const allPublished = !!job?.documents.length && job.documents.every(doc => !domainDocumentHasChanges(job, doc));
  const publishedRevision = job && document ? publishedDomainRevision(job, document) : undefined;
  const changed = !!job && !!document && domainDocumentHasChanges(job, document);
  const publicationProblem = job?.documents.filter(doc => doc.selected).map(doc => domainProposalProblem(job, doc)).find(Boolean);
  const hasPublished = !!job?.documents.some(doc => doc.knowledge_document_id);
  const modifying = !!job && (hasPublished || ["revise", "update"].includes(job.turns.at(-1)?.mode ?? ""));
  const lifecycle = !job ? "" : active ? modifying ? "修改中" : "研究中" : job.status === "failed" ? "执行失败" : job.status === "cancelled" ? "已停止" : allPublished ? "已发布" : job.documents.length ? hasPublished ? "更新待检视" : "待检视" : job.stage;
  const reusablePublications = job?.publications.filter(item => !["closed", "merged"].includes(item.state) && (item.url || item.mr_id)) ?? [];
  const archiveTargets = [...new Set(job?.documents.filter(item => item.selected).map(item => item.target_id) ?? [])];
  const reusesArchiveMrs = archiveTargets.length > 0 && archiveTargets.every(id => reusablePublications.some(item => item.target_id === id));
  const archiveIssueNo = legacyIssueNo ?? job?.issue_no ?? "", archiveIssueDescription = legacyIssueDescription ?? job?.issue_description ?? "";
  function navigateKnowledge(id: string, line?: number, anchor?: string) {
    if (edit?.id === id && (line !== undefined || !!anchor)) { setError("请先保存或取消当前编辑，再跳转章节。"); return; }
    setDocumentId(id); setTab("content"); setMessage(""); setError("");
    setKnowledgeFocus(old => ({ line, anchor, token: (old?.token ?? 0) + 1 }));
  }
  function changeView(next: "progress" | "review") {
    if (edit) { setError("请先保存或取消正文编辑，再切换视图。"); return; }
    setStage(next);
    if (job && studio) next === "review" ? studio.openResult("domain", job.id) : studio.openExecution("domain", job.id);
  }
  async function refreshList() { const results = await Promise.all(["/domain-extraction", "/domain-extraction/probes"].map(path => componentRequest<{ records: DomainKnowledgeJob[] }>(path))); setRecords(results.flatMap(result => result.records).sort((a, b) => b.created_at.localeCompare(a.created_at))); }
  useEffect(() => { void getBusinessModules().then(result => setModules(result.modules.filter(m => m.status === "active"))).catch(e => setError(e.message)); void refreshList().catch(e => setError(e.message)); }, []);
  useEffect(() => {
    if (!selected || busy) return; let live = true;
    const load = async () => { try { const next = await componentRequest<DomainKnowledgeJob>(`/domain-extraction/${selected}`); if (live && selectedRef.current === selected) setJob(next); } catch (e) { if (live && selectedRef.current === selected) setError((e as Error).message); } };
    void load(); const timer = setInterval(() => void load(), 4000); return () => { live = false; clearInterval(timer); };
  }, [selected, busy]);
  function select(id: string) { selectedRef.current = id; setDeleting(false); setSelected(id); setJob(undefined); setDocumentId(""); setEdit(undefined); setMessage(""); setExtraMaterials([]); setLegacyIssueNo(undefined); setLegacyIssueDescription(undefined); setArchiveBlocked(false); const url = new URL(location.href); url.searchParams.delete("knowledgeProbe"); if (id) url.searchParams.set("domainExtraction", id); else url.searchParams.delete("domainExtraction"); history.replaceState(history.state, "", url); }
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
  return <KnowledgeExtractionWorkspace hideHeader={!!job} cleanup={!!job?.source_cleanup && !job?.probe} draftOnly={!!job?.probe} title="领域知识萃取" onNew={() => setOpen(true)} onClose={onBack} backLabel="任务中心" actions={<ExtractionSkillEditor kind="domain" />}
    sidebar={focused || surface === "knowledge" ? undefined : <div className="space-y-2">{records.map(record => <button key={record.id} className={`w-full rounded-lg border p-3 text-left ${selected === record.id ? "border-primary bg-primary/5" : "border-line"}`} onClick={() => select(record.id)}><strong className="block">{record.title}</strong><span className="mt-2 block text-sm text-muted-foreground">{record.repositories.length} 个业务仓 · {record.stage}</span></button>)}{!records.length && <p className="text-muted-foreground">暂无领域萃取记录</p>}</div>}>
    {!job && error && <p role="alert" className="mb-3 text-danger">{error}</p>}
    {job ? <><header className={`studio-result-toolbar${focused ? " domain-focused-toolbar" : ""}`}>
      {onBack && <KnowledgeBackButton onClick={onBack} destination="任务中心" />}
      <FileText size={21} /><strong title={job.title}>{job.title}</strong><span className={`studio-job-status ${active ? "is-active" : ""}`}>{job.probe && job.status === "done" ? "验证完成" : lifecycle}</span>
      <div className="studio-result-actions">
        {!job.probe && <DomainKnowledgePublicationStatus compact job={job} disabled={busy || active} onAction={action} onConfigure={() => setStage("publish")} onViewKnowledge={onViewKnowledge} onCompare={id => { setDocumentId(id); setTab("remote"); setStage("review"); }} />}
        {active ? <Button variant="outline" disabled={busy} onClick={() => void action("stop")}>停止本轮</Button> : ["failed", "cancelled"].includes(job.status) ? <Button disabled={busy} onClick={() => { void action("resume", { use_latest_skill: latest || !job.turns.at(-1)?.research }); changeView("progress"); }}>继续研究</Button> : currentStage === "review" && !job.probe && (allPublished ? <Button disabled={busy || !document} onClick={() => { setTab("content"); setNotesOpenRequest(value => value + 1); }}>更新知识</Button> : <Button disabled={busy || !!edit || !publicationCount || !!publicationProblem} title={publicationProblem} onClick={() => void publishSelected()}><ArrowUpRight size={17} />{busy ? "正在发布…" : `确认并发布（${publicationCount}）`}</Button>)}
        <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多萃取操作" />}><MoreHorizontal size={20} /></DropdownMenuTrigger><DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setStage("inputs")}>资料</DropdownMenuItem>
          {!job.probe && <DropdownMenuItem onClick={() => setStage("publish")}>Git 归档设置</DropdownMenuItem>}
          {!active && !job.probe && job.status === "done" && job.turns.at(-1)?.mode === "extract" && <DropdownMenuItem disabled={busy} onClick={() => { void action("resume", { use_latest_skill: latest || !job.turns.at(-1)?.research }); changeView("progress"); }}>继续深入研究</DropdownMenuItem>}
          <DropdownMenuItem onClick={() => openExtractionSkill("domain")}>查看 Skill</DropdownMenuItem>
          <DropdownMenuItem onClick={() => { studio?.openExecution("domain"); setOpen(true); }}>新建萃取任务</DropdownMenuItem>
          {job.source_cleanup && !job.probe && <DropdownMenuItem onClick={() => setStage("cleanup")}>清理旧知识</DropdownMenuItem>}
          <DropdownMenuItem disabled={busy} onClick={() => { setError(""); setDeleting(true); }}>删除任务</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
      </div>
    </header>
      <KnowledgeTaskNavigation value={currentStage} onChange={changeView} documentCount={job.documents.length} working={!!active} status={job.status} modifying={modifying} published={allPublished} disabled={!!edit || busy} />
      {error && <p role="alert" className="shrink-0 px-4 py-2 text-sm text-danger">{error}</p>}
      {!!hasPublished && (active || !allPublished) && <p className="shrink-0 px-4 py-2 text-xs text-muted-foreground">修改期间继续使用已发布知识，确认发布后再更新。</p>}
      {currentStage === "review" && publicationProblem && <p role="alert" className="shrink-0 px-4 py-2 text-sm text-amber-700">{publicationProblem}</p>}
      {currentStage === "publish" && !job.probe && (!job.issue_no || !job.issue_description && !reusesArchiveMrs) && <div className="mb-4 grid grid-cols-[240px_minmax(0,1fr)_auto] items-end gap-3">
        <label className="grid gap-1 text-sm">关联单号<Input aria-label="归档关联单号" disabled={busy || !!reusablePublications.length && !!job.issue_no} value={archiveIssueNo} maxLength={120} onChange={e => setLegacyIssueNo(e.target.value)} placeholder="创建 MR 前请补充单号" /></label>
        <label className="grid gap-1 text-sm">单号描述<Input aria-label="归档单号描述" disabled={busy} required={!reusesArchiveMrs} value={archiveIssueDescription} maxLength={2000} onChange={e => setLegacyIssueDescription(e.target.value)} placeholder="从关联单据复制准确描述" /><span className="text-xs text-muted-foreground">从关联单据复制准确描述，将原样用作 MR 标题</span></label>
        <Button disabled={busy || !archiveIssueNo.trim() || !reusesArchiveMrs && !archiveIssueDescription.trim()} onClick={() => void action("issue", { issue_no: archiveIssueNo, issue_description: archiveIssueDescription.trim() || undefined })}>保存关联信息</Button>
      </div>}
      {job.error && <p className="mb-3 text-danger">{job.error}</p>}
      {job.probe && <p className="mb-3 rounded border border-line p-3 text-sm">临时验证模块：{job.probe.module}。已屏蔽源码仓的 docs/、AGENTS.md 和配置文档目录；无线豆包与本次上传资料可用。只保留验证草稿。</p>}
      {currentStage === "cleanup" && <KnowledgeSourceCleanup key={job.id} task={job} endpoint={`/domain-extraction/${job.id}`} onChange={setJob} onStarted={() => { setStage("progress"); void refreshList(); }} />}
      {currentStage === "inputs" && <div className="space-y-4"><p>{job.scope}</p>{job.instructions && <div><h4 className="font-medium">本次要求</h4><p className="mt-2 whitespace-pre-wrap break-words">{job.instructions}</p></div>}{(job.source_repositories ?? job.repositories).map(repo => <div key={repo.id} className="rounded border border-line p-3 text-sm"><strong>{repo.name}</strong><p className="break-all">{repo.repository} · {repo.branch} · {repo.path || "全仓"}</p><p>读取版本：{job.revisions[repo.id]?.slice(0, 12) ?? "未读取"}</p></div>)}<p>已关联 {job.material_ids.length} 份上传资料</p>{!job.probe && <><KnowledgeMaterialUpload materials={extraMaterials} onChange={setExtraMaterials} onBusy={setUploading} /><Button disabled={busy || uploading || active || !document} onClick={() => void action("run", { mode: "update", document_ids: job.documents.map(d => d.id), message: "核对补充资料与当前来源，更新受影响文档；未变化内容保留", material_ids: [...new Set([...job.material_ids, ...extraMaterials.map(m => m.id)])], ar_codes: job.ar_codes, use_latest_skill: latest })}>用补充资料生成更新建议</Button></>}</div>}
      <div hidden={currentStage !== "progress"} className="knowledge-task-progress space-y-4">{!!job.turns.at(-1)?.research?.capabilities.length && <details className="rounded border border-line p-3"><summary className="cursor-pointer text-sm">业务知识研究 · {job.turns.at(-1)!.research!.capabilities.filter(c => c.state === "researched").length} / {job.turns.at(-1)!.research!.capabilities.length} 项已研究</summary><ul className="mt-3 space-y-2 text-sm">{job.turns.at(-1)!.research!.capabilities.map(c => <li key={c.id}><strong>{c.title}</strong> · {{ pending: "待研究", researched: "已研究", blocked: "受阻" }[c.state]}{c.findings && <p className="whitespace-pre-wrap text-muted-foreground">{c.findings}</p>}</li>)}</ul></details>}<KnowledgeResearchProgress key={job.id} evidence={job.evidence} /></div>
      {(!job.source_cleanup || job.source_cleanup.started) && <div hidden={currentStage !== "review"} className="knowledge-task-review" style={currentStage === "review" ? { display: "flex", flex: "1 1 0", minHeight: 0, flexDirection: "column", overflow: "hidden" } : undefined}><KnowledgeReadingFrame focused={focused} documentActions={<><span ref={setNotesToolbar} className="flex items-center" />{document && tab === "content" && edit?.id !== document.id && <KnowledgeContentSearch contentRef={searchableContent} contentKey={`${job.id}:${document.id}:${document.revision}:${proposalTurn?.id ?? ""}:${reviewDocument?.content ?? ""}`} contentSelector=".md" />}<Button size="sm" variant="ghost" onClick={() => setTab("content")}>正文</Button><Button size="sm" variant="ghost" disabled={!document || busy || active || !!proposal} title={proposal ? "当前修改待确认，可提意见继续调整，或放弃修改后人工编辑。" : undefined} onClick={() => { setEdit(structuredClone(document)); setTab("content"); }}>{document?.knowledge_document_id ? "修改为新稿" : "编辑"}</Button><DropdownMenu><DropdownMenuTrigger render={<Button size="icon" variant="ghost" aria-label="更多领域文档操作" />}><MoreHorizontal size={18} /></DropdownMenuTrigger><DropdownMenuContent align="end">{([["diff", "修订差异"], ["sources", "来源"], ["history", "历史版本"], ["remote", "远端合并"]] as const).filter(([value]) => !job.probe || value !== "remote").map(([value, label]) => <DropdownMenuItem key={value} onClick={() => setTab(value)}>{label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></>} title={document?.path.split("/").at(-1) ?? "知识文档"} actions={!job.probe && <Button size="sm" variant="ghost" onClick={() => setShowDiscussion(!showDiscussion)}>{showDiscussion ? "收起讨论" : "讨论与修订"}</Button>}><div className="research-review-panes">
        <DomainKnowledgeFileTree job={job} currentId={document?.id} onNavigate={navigateKnowledge} disabled={busy || active} onSelection={(id, selected) => void action("selection", { ids: [id], selected })} onSelections={(ids, selected) => void action("selection", { ids, selected })} />
        <div className="research-reader" style={{ gridTemplateColumns: showDiscussion && !job.probe ? "minmax(0, 1fr) 300px" : "minmax(0, 1fr)" }}>{document ? <><div className="research-document-content studio-paper">
          <div className={focused ? "domain-review-document-meta flex items-center gap-2 text-xs text-muted-foreground" : "mb-4 flex flex-wrap items-center gap-2 border-b border-line pb-3 text-xs text-muted-foreground"} title={document.path}>
            {!focused && <span className="break-all">{document.path}</span>}<span>{proposal && !proposalProblem ? "修改结果" : `草稿 v${document.revision}`}</span>{publishedRevision !== undefined && <span>· 已发布基线 v{publishedRevision}</span>}<strong className={changed ? "text-amber-700" : "text-emerald-700"} title={document.knowledge_document_id && changed ? "当前修订尚未发布，Agent 继续使用上一份正式知识。" : undefined}>{changed ? document.knowledge_document_id ? "更新待检视" : "待检视" : "已发布"}</strong>{document.knowledge_document_id && onViewKnowledge && <Button size="sm" variant="link" onClick={() => onViewKnowledge(document.knowledge_document_id!)}>查看正式知识</Button>}
          </div>
          {!focused && document.knowledge_document_id && changed && <p className="mb-3 text-xs text-muted-foreground">当前修订尚未发布，Agent 继续使用上一份正式知识。</p>}
          {tab === "content" && (edit?.id === document.id ? <div className="space-y-3"><Input aria-label="文档标题" value={edit.title} onChange={e => setEdit({ ...edit, title: e.target.value })} /><Textarea aria-label="编辑领域文档" rows={20} value={edit.content} onChange={e => setEdit({ ...edit, content: e.target.value })} /><Textarea aria-label="编辑文档来源" rows={5} value={edit.sources} onChange={e => setEdit({ ...edit, sources: e.target.value })} /><Button disabled={busy} onClick={async () => { if (await action("edit", { document: edit, base_revision: edit.revision })) setEdit(undefined); }}>保存人工版本</Button><Button variant="outline" onClick={() => setEdit(undefined)}>取消</Button></div> : job.probe ? <div ref={searchableContent}><KnowledgeMarkdown text={reviewDocument?.content ?? document.content} focus={knowledgeFocus} /></div> : <KnowledgeReviewNotes kind="domain" jobId={job.id} documentId={document.id} toolbarTarget={notesToolbar} working={!!active} openRequest={notesOpenRequest}><div ref={searchableContent}><KnowledgeMarkdown text={reviewDocument?.content ?? document.content} focus={knowledgeFocus} onReference={href => {
            const found = resolveKnowledgeReference(job.documents, reviewDocument ?? document, href);
            if (!found) return false; navigateKnowledge(found.item.id, undefined, found.anchor); return true;
          }} /></div></KnowledgeReviewNotes>)}
          {tab === "sources" && <Markdown text={reviewDocument?.sources ?? document.sources} />}
          {tab === "remote" && <div className="space-y-4"><p className="text-sm">读取目标分支与当前 MR 的真实内容，核对后编辑合并稿。提交前会再次检查远端，新的修改仍会阻止覆盖。</p><Button variant="outline" disabled={busy} onClick={async () => { if (await action("remote", { document_id: document.id })) setEdit(current => current?.id === document.id ? current : structuredClone(document)); }}>读取远端版本并比较</Button>
            {document.remote_review && <><p className="text-xs text-muted-foreground">目标版本 {document.remote_review.target_revision.slice(0, 12)}{document.remote_review.branch_revision && ` · MR 版本 ${document.remote_review.branch_revision.slice(0, 12)}`} · {document.remote_review.reviewed ? "已人工核对" : "待人工核对"}</p>
              <details open><summary>目标分支与当前草稿的差异</summary><pre className="whitespace-pre-wrap break-words text-sm">{diffLines(document.remote_review.target_content ?? "", body(document)).map((part, i) => <span key={i} className={part.added ? "bg-green-500/15" : part.removed ? "bg-red-500/15 line-through" : ""}>{part.value}</span>)}</pre></details>
              {document.remote_review.branch && <details open><summary>当前 MR 分支原文</summary><pre className="whitespace-pre-wrap break-words text-sm">{document.remote_review.branch_content ?? "此文件不存在"}</pre></details>}
              <label className="grid gap-2">人工合并后的正文<Textarea aria-label="远端合并稿" rows={14} value={edit?.id === document.id ? edit.content : document.content} onChange={e => setEdit({ ...(edit?.id === document.id ? edit : structuredClone(document)), content: e.target.value })} /></label>
              <label className="grid gap-2">合并后的来源<Textarea aria-label="远端合并来源" rows={4} value={edit?.id === document.id ? edit.sources : document.sources} onChange={e => setEdit({ ...(edit?.id === document.id ? edit : structuredClone(document)), sources: e.target.value })} /></label>
              <Button disabled={busy} onClick={async () => { if (await action("reconcile", { document: edit?.id === document.id ? edit : document, base_revision: edit?.id === document.id ? edit.revision : document.revision, snapshot_id: document.remote_review!.id })) setEdit(undefined); }}>保存合并稿并确认远端版本</Button>
            </>}
          </div>}
          {tab === "diff" && (proposal ? <><p className={`mb-3 text-sm ${proposalProblem ? "text-amber-700" : "text-muted-foreground"}`}>{proposalProblem ?? "正文已展示这份修改结果，检视后可在顶部确认并发布。"}</p><pre className="whitespace-pre-wrap break-words text-sm">{diffLines(body(document), body(proposal.document)).map((part, i) => <span key={i} className={part.added ? "bg-green-500/15" : part.removed ? "bg-red-500/15 line-through" : ""}>{part.value}</span>)}</pre><div className="mt-4 flex gap-2"><Button variant="outline" disabled={busy || active} onClick={() => void action("proposal", { turn_id: proposalTurn!.id, document_id: document.id, decision: "discard" })}>放弃本次修改</Button></div></> : <p>没有待确认的修改。</p>)}
          {tab === "history" && <div className="space-y-3">{[...document.history].reverse().map(h => <details key={h.revision}><summary>v{h.revision} · {h.operator} · {new Date(h.at).toLocaleString()}</summary><Markdown text={body(h)} /><Button disabled={busy} onClick={() => void action("restore", { document_id: document.id, revision: h.revision, base_revision: document.revision })}>恢复为新版本</Button></details>)}{!document.history.length && <p>尚无历史版本。</p>}</div>}
        </div>{!job.probe && showDiscussion && <section className="research-discussion"><h4 className="font-semibold">与 AI 讨论 · {document.title}</h4><p className="mt-2 text-sm text-muted-foreground">讨论保留原稿。修改完成后直接检视新稿，确认发布后生效。</p><div className="my-4 space-y-4">{turns.map(turn => <article key={turn.id} className="border-b border-line pb-3 text-sm"><p className="mb-1 text-xs text-muted-foreground">{turn.operator}{turn.skill && ` · Skill ${turn.skill.digest.slice(0, 8)}`}</p><p className="whitespace-pre-wrap">{turn.message}</p>{turn.reply && <Markdown text={turn.reply} />}{turn.error && <p className="text-danger">{turn.error}</p>}<p className="text-muted-foreground">{turn.status === "running" ? "正在查证…" : turn.status === "queued" ? "等待执行" : turn.status === "done" ? "本轮完成" : turn.status === "cancelled" ? "已停止" : "本轮失败"}</p>{turn.proposals.some(p => p.document.id === document.id && p.status === "pending") && <Button variant="link" onClick={() => setTab("diff")}>查看修改差异</Button>}</article>)}</div><label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={latest} onChange={e => setLatest(e.target.checked)} />下一轮用最新领域 Skill</label><label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={related} onChange={e => setRelated(e.target.checked)} />同时处理已勾选的关联文档</label><Textarea aria-label="领域知识修订意见" rows={5} value={message} onChange={e => setMessage(e.target.value)} placeholder="补充问题、纠正业务规则或说明更新范围…" /><div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" disabled={busy || active || !message.trim()} onClick={() => void run("discuss")}>仅讨论</Button><Button disabled={busy || active || !message.trim()} onClick={() => void run("revise")}>生成建议</Button><Button variant="outline" disabled={busy || active || !message.trim()} onClick={() => void run("update")}>核对来源更新</Button></div></section>}</> : <p className="p-5">研究完成的文档会逐步显示在这里。</p>}</div>
      </div>{!focused && document && !job.probe && !showDiscussion && <form className="studio-refine-bar" onSubmit={event => { event.preventDefault(); if (!busy && !active && message.trim()) { void run("revise"); setShowDiscussion(true); } }}>
        <Textarea aria-label="快速修订知识" rows={1} value={message} onChange={event => setMessage(event.target.value)} placeholder="补充或修改这份知识…" />
        <Button type="submit" size="icon" aria-label="生成修订建议" disabled={busy || active || !message.trim()}><Send size={18} /></Button>
      </form>}</KnowledgeReadingFrame></div>}
      {currentStage === "publish" && !job.probe && <div className="space-y-4"><div className="flex items-start justify-between gap-4"><div><h3 className="font-semibold">Git 归档设置</h3><p className="mt-1 text-sm text-muted-foreground">知识发布后立即在本地生效。这里配置后台归档的位置，未配置或归档失败可稍后补齐。</p></div><KnowledgeBackButton onClick={() => changeView("review")} destination="文稿" /></div><DomainKnowledgeArchiveTargets job={job} disabled={busy || active || !!edit} onChange={setJob} onBlockedChange={setArchiveBlocked} onCompare={id => { setDocumentId(id); setTab("remote"); setStage("review"); }} />{edit && <p className="text-sm text-muted-foreground">请先保存或取消正文编辑，再调整归档位置。</p>}{[job.knowledge_target, ...job.repositories].filter(target => job.documents.some(doc => doc.selected && doc.target_id === target.id)).map(target => <KnowledgeCleanupOptions key={`${job.id}:${target.id}:${job.archive_revision ?? 0}`} job={job} target={target} endpoint={`/domain-extraction/${job.id}`} disabled={busy || active || archiveBlocked || job.archive_configured === false} onChange={setJob} onBlockedChange={ignoreCleanupState} />)}<p className="text-sm text-muted-foreground">按目标仓归档多份文稿；同仓 MR 未合入时后续批次继续更新该 MR。仅已确认发布的文稿会写入 Git。</p></div>}
    </> : <p className="p-8 text-muted-foreground">{selected ? "正在加载任务…" : "选择历史任务，或新建领域萃取。"}</p>}
    <Dialog open={deleting} onOpenChange={setDeleting}><DialogContent className="tw-root sm:max-w-[480px]"><DialogHeader><DialogTitle>删除领域萃取任务？</DialogTitle></DialogHeader><p className="font-medium">{job?.title}</p><p className="text-sm text-muted-foreground">任务及草稿将从萃取列表移除，正在执行的研究会停止。已创建的 MR、仓库文件和已入库的知识文档会保留，来源记录保留用于追溯。</p>{error && <p role="alert" className="text-danger">{error}</p>}<div className="flex justify-end gap-3"><Button variant="outline" disabled={busy} onClick={() => setDeleting(false)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>确认删除</Button></div></DialogContent></Dialog>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="tw-root sm:max-w-[850px] max-h-[90vh] overflow-auto"><DialogHeader><DialogTitle>新建领域知识萃取</DialogTitle></DialogHeader>{error && <p role="alert" className="text-danger">{error}</p>}<div className="space-y-5"><label className="grid gap-2">业务模块<select aria-label="萃取业务模块" className="rounded border border-line bg-surface p-2" value={moduleId} onChange={e => setModuleId(e.target.value)}><option value="">请选择业务模块</option>{modules.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{module && <p className="text-sm">{module.name} · 已关联 {module.repositories.length} 个代码仓</p>}<label className="grid gap-2">统一基准分支<Input aria-label="统一基准分支" value={baselineBranch} onChange={e => setBaselineBranch(e.target.value)} placeholder="master" /><span className="text-sm text-muted-foreground">本次关联仓库统一读取此分支。</span></label><><div className="grid grid-cols-[240px_minmax(0,1fr)] gap-3"><label className="grid gap-2">关联单号（必填）<Input aria-label="领域萃取关联单号" required maxLength={120} value={issueNo} onChange={e => setIssueNo(e.target.value)} placeholder="填写本次知识归档关联的需求或问题单号" /><span className="text-sm text-muted-foreground">本任务创建的所有 MR 关联此单号。</span></label><label className="grid gap-2">单号描述（必填）<Input aria-label="领域萃取单号描述" required maxLength={2000} value={issueDescription} onChange={e => setIssueDescription(e.target.value)} placeholder="从关联单据复制准确描述" /><span className="text-sm text-muted-foreground">从关联单据复制准确描述，将原样用作 MR 标题</span></label></div><p className="text-sm text-muted-foreground">归档仓和文档目录可在「Git 归档设置」调整，系统会带出默认位置。</p></><label className="grid gap-2">本次要求（可选）<Textarea aria-label="本次萃取要求" rows={4} maxLength={20000} value={instructions} onChange={e => setInstructions(e.target.value)} placeholder={"例如：只萃取订单模块的退款流程；不要读取 docs/ 和 legacy/payment.ts；用业务人员能看懂的语言说明规则。"} /></label><KnowledgeMaterialUpload materials={materials} onChange={setMaterials} onBusy={setUploading} /><Button disabled={busy || uploading || !issueNo.trim() || !issueDescription.trim() || !module || (!!module.repositories.length && !baselineBranch.trim())} onClick={async () => { setBusy(true); setError(""); try { const next = await componentRequest<DomainKnowledgeJob>("/domain-extraction", { issue_no: issueNo, issue_description: issueDescription, module_id: moduleId, instructions: instructions.trim() || undefined, baseline_branch: baselineBranch, material_ids: materials.map(m => m.id) }); select(next.id); setJob(next); setStage(next.source_cleanup ? "cleanup" : "progress"); setOpen(false); setInstructions(""); await refreshList(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>开始萃取</Button></div></DialogContent></Dialog>
  </KnowledgeExtractionWorkspace>;
}
