import { KnowledgeCleanupOptions } from "./KnowledgeCleanupOptions";
import { useEffect, useState } from "react";
import { diffLines } from "diff";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { GitBranch, LoaderCircle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "./markdown";
import { componentRequest, type ComponentResearchRecord } from "./componentResearchApi";
import type { DomainKnowledgeJob, DomainDocument } from "../../src/domainKnowledgeTypes";

export function ComponentKnowledgeArchive({ record, title, content, compact = false, refreshKey = 0, notice, onOpenKnowledge, onArchiveAction }: { record: ComponentResearchRecord; title: string; content: string; compact?: boolean; refreshKey?: number; notice?: string; onOpenKnowledge?: (id: string) => void; onArchiveAction?: () => void }) {
  const endpoint = `/component-research/${record.id}/archive`;
  const [cleanupBlocked, setCleanupBlocked] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [archive, setArchive] = useState<DomainKnowledgeJob>();
  const [repository, setRepository] = useState(""), [branch, setBranch] = useState("master"), [directory, setDirectory] = useState("docs/components");
  const [filename, setFilename] = useState("component-guide.md"), [issue, setIssue] = useState(""), [issueDescription, setIssueDescription] = useState("");
  const [editor, setEditor] = useState<DomainDocument>(), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState("");
  const [view, setView] = useState<"diff" | "preview" | "edit">("diff");
  function receive(job: DomainKnowledgeJob, initialize = false) {
    setArchive(job); setEditor(structuredClone(job.documents[0]));
    if (initialize && job.documents[0]) {
      setRepository(job.knowledge_target.repository); setBranch(job.knowledge_target.branch); setDirectory(job.knowledge_target.docs_path);
      setFilename(job.documents[0].path.split("/").at(-1)!); setIssue(job.issue_no ?? ""); setIssueDescription(job.issue_description ?? "");
    }
  }
  useEffect(() => {
    let live = true;
    setLoaded(false);
    void componentRequest<{ archive: DomainKnowledgeJob | null; defaults?: { repository: string; branch: string; directory: string; filename: string } }>(endpoint).then(result => { if (live) {
      if (result.archive) receive(result.archive, true);
      else if (result.defaults) { setRepository(result.defaults.repository); setBranch(result.defaults.branch); setDirectory(result.defaults.directory); setFilename(result.defaults.filename); }
      setLoaded(true);
    } }).catch(e => { if (live) { setError(e.message); setLoaded(true); } });
    return () => { live = false; };
  }, [endpoint, refreshKey]);
  const latestBatch = archive?.archive_batches?.at(-1);
  const archiving = latestBatch?.state === "pending" || latestBatch?.state === "running";
  useEffect(() => {
    if (!archiving) return;
    let live = true;
    const timer = setInterval(() => {
      void componentRequest<{ archive: DomainKnowledgeJob | null }>(endpoint).then(result => { if (live && result.archive) receive(result.archive); }).catch(e => { if (live) setError(e.message); });
    }, 2500);
    return () => { live = false; clearInterval(timer); };
  }, [endpoint, archiving]);
  const document = archive?.documents[0], publication = archive?.publications[0];
  const remote = document?.remote_review;
  const dirty = !!document && editor?.content !== document.content;
  const locked = !!archive?.publications.length;
  const reusesMr = [...(archive?.publications ?? []), ...(latestBatch?.publications ?? [])].some(item => !["closed", "merged"].includes(item.state) && (item.url || item.mr_id));
  const issueReady = !!issue.trim() && (reusesMr || !!issueDescription.trim());
  const issueChanged = !!archive && (issue.trim() !== (archive.issue_no ?? "") || issueDescription.trim() !== (archive.issue_description ?? ""));
  const changedTarget = !!archive && (repository !== archive.knowledge_target.repository || branch !== archive.knowledge_target.branch || directory !== archive.knowledge_target.docs_path || filename !== document?.path.split("/").at(-1) || issueChanged);
  const targetContent = remote?.target_content ?? "";
  const remoteExists = remote?.target_content != null || remote?.branch_content != null;
  const needsReview = !!remote && remoteExists && !remote.reviewed && (document?.content !== remote.target_content || (remote.branch_content != null && document?.content !== remote.branch_content));
  async function act(action: string, input: unknown = {}) {
    setBusy(true); setError("");
    try { receive(await componentRequest<DomainKnowledgeJob>(`${endpoint}${action ? `/${action}` : ""}`, input)); onArchiveAction?.(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function prepare() {
    setBusy(true); setError("");
    try {
      receive(await componentRequest<DomainKnowledgeJob>(endpoint, { title, ...(record.document ? {} : { content }),
        target: { repository, branch, docs_path: directory, name: "组件知识归档仓" }, filename, issue_no: issue, issue_description: issueDescription.trim() || undefined, base_revision: document?.revision }), true);
      onArchiveAction?.();
    } catch (e) {
      setError((e as Error).message);
      // Preparation is persisted before the remote read, so network failures can be retried.
      try { const result = await componentRequest<{ archive: DomainKnowledgeJob | null }>(endpoint); if (result.archive) receive(result.archive, true); } catch { /* Preserve the first error. */ }
    } finally { setBusy(false); }
  }
  const panel = <section className="mt-3 space-y-4 rounded-lg border border-line bg-surface-2 p-4" aria-label="组件知识代码仓归档">
    <div><h3 className="font-semibold">Git 归档</h3><p className="mt-1 text-sm text-muted-foreground">将组件知识归档到代码仓。已有同名文档会展示原文与差异，归档失败不影响已发布知识。</p></div>
    {error && <p role="alert" className="text-danger">{error}</p>}
    <div className="grid grid-cols-2 gap-3">
      <label className="col-span-2 grid gap-1">目标仓地址<Input disabled={busy || locked} value={repository} onChange={e => setRepository(e.target.value)} placeholder="https://…/knowledge.git" /></label>
      <label className="grid gap-1">目标分支<Input disabled={busy || locked} value={branch} onChange={e => setBranch(e.target.value)} /></label>
      <label className="grid gap-1">关联单号（必填）<Input aria-label="组件归档关联单号" disabled={busy || locked && !!archive?.issue_no} maxLength={120} value={issue} onChange={e => { setIssue(e.target.value); setIssueDescription(""); }} /></label>
      {(!reusesMr || issueDescription) && <label className="col-span-2 grid gap-1">单号描述{!reusesMr && "（必填）"}<Input aria-label="组件归档单号描述" required={!reusesMr} disabled={busy || reusesMr && !!archive?.issue_description} maxLength={2000} value={issueDescription} onChange={e => setIssueDescription(e.target.value)} placeholder="从关联单据复制准确描述" /><span className="text-xs text-muted-foreground">从关联单据复制准确描述，将原样用作 MR 标题</span></label>}
      <label className="grid gap-1">归档目录<Input disabled={busy || locked} value={directory} onChange={e => setDirectory(e.target.value)} placeholder="docs/components" /></label>
      <label className="grid gap-1">Markdown 文件名<Input disabled={busy || locked} value={filename} onChange={e => setFilename(e.target.value)} placeholder="component-guide.md" /></label>
    </div>
    {archive && issueChanged && <Button size="sm" variant="outline" disabled={busy || dirty || !issueReady} onClick={() => void act("issue", { issue_no: issue, issue_description: issueDescription.trim() || undefined })}>保存关联信息</Button>}
    <p className="break-all text-sm text-muted-foreground">目标路径：{directory.replace(/\/$/, "")}/{filename}。更新已有文档时，填写它的目录与文件名。</p>
    <Button variant="outline" disabled={!loaded || busy || dirty || record.status !== "done" || !title.trim() || !repository.trim() || !branch.trim() || !directory.trim() || !filename.trim() || !issueReady} onClick={() => void prepare()}>{archive ? "重新载入最新萃取结果并比较" : "准备提交并检查已有文档"}</Button>
    {archive && document && editor && <>
      <p className="text-sm">提交稿 v{document.revision} · {archive.issue_no}{remote && (remoteExists ? " · 仓内已有文档，请核对差异" : " · 目标路径为新文档")}</p>
      <div className="flex flex-wrap gap-2">{([["diff", "与仓内文档比较"], ["preview", "预览提交稿"], ["edit", "编辑合并稿"]] as const).map(([value, label]) => <Button key={value} variant={view === value ? "default" : "outline"} onClick={() => setView(value)}>{label}</Button>)}
        <Button variant="outline" disabled={busy || dirty || changedTarget} onClick={() => void act("remote", { document_id: document.id })}>重新读取远端版本</Button>
      </div>
      {view === "diff" && <div className="grid grid-cols-2 gap-3">
        <div className="min-w-0"><h4 className="mb-2 font-medium">目标分支原文</h4><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-line p-3 text-sm">{remote ? remote.target_content ?? "目标分支不存在此文件" : "尚未读取远端，请重新读取"}</pre></div>
        <div className="min-w-0"><h4 className="mb-2 font-medium">提交稿与目标分支的差异</h4><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-line p-3 text-sm">{diffLines(targetContent, editor.content).map((part, i) => <span key={i} className={part.added ? "bg-success/15 text-success" : part.removed ? "bg-danger/15 text-danger" : ""}>{part.value}</span>)}</pre></div>
        {remote?.branch_content != null && <div className="col-span-2 min-w-0"><h4 className="mb-2 font-medium">当前 MR 分支原文</h4><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-line p-3 text-sm">{remote.branch_content}</pre></div>}
        {(remote?.target_metadata != null || remote?.branch_metadata != null) && <details className="col-span-2"><summary className="cursor-pointer">查看配套检查文件</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-line p-3 text-sm">{diffLines(remote.branch_metadata ?? remote.target_metadata ?? "", editor.component_metadata ?? "").map((part, i) => <span key={i} className={part.added ? "bg-success/15 text-success" : part.removed ? "bg-danger/15 text-danger" : ""}>{part.value}</span>)}</pre></details>}
      </div>}
      {view === "preview" && <div className="max-h-[480px] overflow-auto rounded border border-line p-4"><Markdown text={editor.content} /></div>}
      {view === "edit" && <Textarea aria-label="组件归档合并稿" rows={16} value={editor.content} onChange={e => setEditor({ ...editor, content: e.target.value })} />}
      {remote?.target_content != null && <Button variant="outline" disabled={busy || changedTarget} onClick={() => { setEditor({ ...editor, content: remote.target_content! }); setView("edit"); }}>使用目标分支原文作为合并稿</Button>}
      <KnowledgeCleanupOptions job={archive} target={archive.knowledge_target} endpoint={endpoint} disabled={busy || dirty || changedTarget} onChange={job => receive(job)} onBlockedChange={setCleanupBlocked} />
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" disabled={busy || changedTarget || !editor.content.trim() || (!dirty && !needsReview)} onClick={() => void act(remote ? "reconcile" : "edit", { document: editor, base_revision: document.revision, ...(remote ? { snapshot_id: remote.id } : {}) })}>{remote ? "保存提交稿并确认远端版本" : "保存提交稿"}</Button>
        <Button disabled={busy || archiving || dirty || changedTarget || !issueReady || cleanupBlocked || !remote || needsReview} onClick={() => void act("publish", { document_ids: [document.id], expected_revisions: { [document.id]: document.revision } })}>{compact ? "提交 Git 归档" : "创建或更新 MR"}</Button>
        {publication && <Button variant="outline" disabled={busy || dirty} onClick={() => void act("refresh")}>刷新 MR 状态</Button>}
      </div>
      {dirty && <p className="text-sm text-muted-foreground">合并稿尚未保存，保存后才能提交。</p>}
      {changedTarget && <p className="text-sm text-muted-foreground">归档设置已改变，请重新准备提交稿。</p>}
      {publication && <div className="rounded border border-line p-3 text-sm">
        <p>{publication.state === "opened" ? "MR 已创建，本次提交完成" : publication.state === "unchanged" ? "内容相同，无需创建 MR" : publication.state === "merged" ? "MR 已合并" : publication.state === "closed" ? "MR 已关闭" : publication.state === "failed" ? "提交失败，可重试" : "正在准备提交"}</p>
        {publication.url && <a className="text-primary underline" href={publication.url} target="_blank" rel="noreferrer">打开 MR</a>}
        {publication.error && <p className="mt-2 text-danger">{publication.error}</p>}
        {publication.sync_state && <p>知识库同步：{publication.sync_state === "done" ? "已完成" : publication.sync_state === "failed" ? "失败，可刷新重试" : publication.sync_state === "diverged" ? "归档仓文档在合入后被修改，请读取远端核对" : "等待同步"}</p>}
        {publication.sync_error && <p className="text-danger">{publication.sync_error}</p>}
      </div>}
      {!!document.history.length && <details><summary className="cursor-pointer text-sm">查看提交稿历史</summary>{[...document.history].reverse().map(entry => <div key={entry.revision} className="mt-2 flex items-center gap-3 text-sm"><span>v{entry.revision} · {entry.operator} · {new Date(entry.at).toLocaleString()}</span><Button size="sm" variant="outline" disabled={busy || dirty} onClick={() => void act("restore", { document_id: document.id, revision: entry.revision, base_revision: document.revision })}>恢复此版</Button></div>)}</details>}
    </>}
  </section>;
  if (!compact) return panel;
  const currentPublication = latestBatch?.publications[0] ?? publication;
  const formalId = document?.knowledge_document_id ?? record.document_id;
  const status = archiving ? "后台归档中…" : latestBatch?.state === "superseded" ? "已由新版替代，无需归档" : latestBatch?.state === "failed" ? "归档失败，知识已生效" : currentPublication?.state === "opened" ? `MR ${currentPublication.mr_id ? `!${currentPublication.mr_id}` : ""} · 待合入` : currentPublication?.state === "merged" ? "MR 已合入" : currentPublication?.state === "closed" ? "MR 已关闭" : currentPublication?.state === "unchanged" ? "内容一致，无需新建 MR" : currentPublication?.state === "failed" ? "归档失败，知识已生效" : "待归档";
  const failed = latestBatch?.state === "failed" || currentPublication?.state === "failed" || !!error;
  return <>
    <Button variant="ghost" onClick={() => setDetailsOpen(true)} aria-label="Git 归档状态与设置" title={status}>
      {archiving ? <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" /> : <GitBranch size={16} />}Git 归档{failed && <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-label="归档待处理" />}
    </Button>
    {currentPublication?.url && <a className="whitespace-nowrap text-sm font-medium text-primary hover:underline" href={currentPublication.url} target="_blank" rel="noreferrer">打开 MR ↗</a>}
    <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}><DialogContent className="tw-root max-h-[88dvh] overflow-auto sm:max-w-4xl">
      <DialogHeader><DialogTitle>Git 归档</DialogTitle></DialogHeader>
      <section aria-label="组件知识发布归档状态" className="space-y-3">
        <p className="text-sm text-muted-foreground">{status}</p>
        {notice && <p className="text-sm text-muted-foreground">{notice}</p>}
        <div className="flex items-center gap-3">
          {currentPublication?.url && <a className="font-medium text-primary underline" href={currentPublication.url} target="_blank" rel="noreferrer">打开 MR ↗</a>}
          {failed && <Button size="sm" variant="outline" disabled={busy || !issueReady || issueChanged} onClick={() => void act("archive-retry")}>重试归档</Button>}
          {formalId && onOpenKnowledge && <Button size="sm" variant="ghost" onClick={() => onOpenKnowledge(formalId)}>查看知识</Button>}
        </div>
        {(latestBatch?.error || currentPublication?.error || error) && <p role="alert" className="text-sm text-danger">{latestBatch?.error || currentPublication?.error || error}</p>}
        {panel}
      </section>
    </DialogContent></Dialog>
  </>;
}
