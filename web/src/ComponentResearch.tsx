import { useKnowledgeStudio } from "./KnowledgeStudioContext";
import { MoreHorizontal, FileText, History, Settings2 } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { KnowledgeResearchProgress } from "./KnowledgeResearchProgress";
import { ComponentKnowledgeArchive } from "./ComponentKnowledgeArchive";
import { KnowledgeBackButton } from "./KnowledgeBackButton";
import { KnowledgeTaskNavigation } from "./KnowledgeTaskNavigation";
import { KnowledgeExtractionWorkspace, KnowledgeExtractionStages } from "./KnowledgeExtractionWorkspace";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { KNOWLEDGE_LANGUAGE_OPTIONS, knowledgeLanguageLabel } from "./KnowledgeLanguages";
import {
  componentRequest,
  type ComponentRepository,
  type ComponentResearchRecord,
} from "./componentResearchApi";
import { getBusinessModules, type BusinessModule } from "./api";
import { Markdown } from "./markdown";
import { ComponentResearchReview, latestComponentProposal } from "./ComponentResearchReview";
import type { DomainKnowledgeJob } from "../../src/domainKnowledgeTypes";
function Choice({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: string;
  items: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <label className="grid gap-2">
      {label}
      <Select
        value={value}
        items={items}
        onValueChange={(v) => onChange(v ?? "")}
      >
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue placeholder="请选择" />
        </SelectTrigger>
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value}>
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
export function ComponentResearch({
  open,
  focused = false,
  compact = false,
  focusId,
  surface,
  onClose,
  backLabel = "知识文档",
  onAdopt,
}: {
  open: boolean;
  focused?: boolean;
  compact?: boolean;
  focusId?: string;
  surface?: "knowledge" | "workbench";
  onClose: () => void;
  backLabel?: string;
  onAdopt: (id: string) => void;
}) {
  const [components, setComponents] = useState<ComponentRepository[]>([]),
    [records, setRecords] = useState<ComponentResearchRecord[]>([]),
    [modules, setModules] = useState<BusinessModule[]>([]);
  const [language, setLanguage] = useState(""), [topic, setTopic] = useState("");
  const [mode, setMode] = useState<"all" | "topic">("all");
  const [selected, setSelected] = useState(() => {
      const params = new URLSearchParams(location.search);
      return params.get("kbKind") === "component" ? params.get("kbTask") ?? "" : "";
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(""),
    [title, setTitle] = useState(""),
    [editing, setEditing] = useState(false),
    [scope, setScope] = useState("platform"),
    [module, setModule] = useState(""),
    [repos, setRepos] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [reviewBlocked, setReviewBlocked] = useState(false);
  const [archiveRefresh, setArchiveRefresh] = useState(0);
  const [archiveOpenRequest, setArchiveOpenRequest] = useState(0);
  const [publishSettingsOpen, setPublishSettingsOpen] = useState(false);
  const publishing = useRef(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const studio = useKnowledgeStudio();
  const [stage, setStage] = useState("review");
  useEffect(() => {
    const archiveStage = new URLSearchParams(location.search).get("kbStage");
    if (archiveStage === "publish" || archiveStage === "remote") { setStage("review"); setArchiveOpenRequest(value => value + 1); }
    else if (surface) setStage(surface === "knowledge" ? "review" : "progress");
  }, [surface, focusId]);
  const [componentsLoaded, setComponentsLoaded] = useState(false);
  const [detail, setDetail] = useState<ComponentResearchRecord>();
  const current = detail?.id === selected ? detail : undefined;
  const matchingComponents = components.filter(c => c.enabled && c.languages.includes(language));
  const load = async () => {
    const result = await componentRequest<{
      records: ComponentResearchRecord[];
    }>("/component-research");
    setRecords(result.records);
  };
  useEffect(() => {
    if (!open) return;
    let active = true;
    const refresh = async () => {
      try {
        const result = await componentRequest<{
          records: ComponentResearchRecord[];
        }>("/component-research");
        if (active) setRecords(result.records);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void refresh();
    void componentRequest<{ components: ComponentRepository[] }>(
      "/component-repositories",
    )
      .then((r) => {
        if (active) { setComponents(r.components); setComponentsLoaded(true); }
      })
      .catch((e) => setError(e.message));
    void getBusinessModules()
      .then((r) => {
        if (active) setModules(r.modules);
      })
      .catch((e) => setError(e.message));
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open]);
  useEffect(() => {
    if (!open || !selected || ["new", "history"].includes(selected)) return;
    let active = true;
    const refresh = async () => {
      try {
        const result = await componentRequest<ComponentResearchRecord>(
          `/component-research/${encodeURIComponent(selected)}`,
        );
        if (active) setDetail(result);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open, selected]);
  useEffect(() => {
    setTitle(
      current?.update_metadata?.title ?? (current
        ? `${knowledgeLanguageLabel(current.language)} · ${current.topic}`.slice(0, 160)
        : ""),
    );
    setEditing(false);
    setScope(current?.update_metadata?.scope ?? "platform");
    setModule(current?.update_metadata?.module_ids[0] ?? "");
    setRepos(current?.update_metadata?.repositories.join("\n") ?? "");
  }, [selected, current?.id, current?.update_document_revision]);
  useEffect(() => {
    if (!editing) setDraft(current?.draft ?? "");
  }, [current?.draft, editing]);
  function selectRecord(id: string) {
    const archiveStage = new URLSearchParams(location.search).get("kbStage");
    setSelected(id); setStage(archiveStage === "publish" || archiveStage === "remote" ? "review" : surface === "workbench" ? "progress" : "review");
    const url = new URL(location.href);
    if (id === "history") {
      url.searchParams.set("kbPage", "tasks");
      url.searchParams.delete("kbKind"); url.searchParams.delete("kbTask"); url.searchParams.delete("kbReview");
    } else {
      url.searchParams.set("kbPage", id && id !== "new" ? "task" : "research");
      url.searchParams.set("kbKind", "component");
      if (id && id !== "new") url.searchParams.set("kbTask", id);
      else { url.searchParams.delete("kbTask"); url.searchParams.delete("kbReview"); }
    }
    history.replaceState(history.state, "", url);
  }
  useEffect(() => { if (focusId) selectRecord(focusId); }, [focusId]);
  async function start() {
    setBusy(true);
    setError("");
    try {
      const r = await componentRequest<ComponentResearchRecord>(
        "/component-research",
        { language, mode, ...(mode === "topic" ? { topic } : {}) },
      );
      await load();
      setDetail(r);
      selectRecord(r.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function manage(action: "stop" | "delete" | "retry" | "begin-update") {
    if (!current) return;
    setBusy(true); setError("");
    try {
      const result = await componentRequest<ComponentResearchRecord>(`/component-research/${current.id}/${action}`, {});
      if (action === "delete") { setDeleting(false); setDetail(undefined); selectRecord("history"); }
      else { setDetail(result); selectRecord(result.id); if (action === "begin-update") studio?.openResult("component", result.id); }
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function publishKnowledge() {
    if (!current || publishing.current) return;
    publishing.current = true;
    setBusy(true); setError("");
    try {
      let prepared = await componentRequest<ComponentResearchRecord>(`/component-research/${current.id}`);
      if (prepared.status !== "done") throw new Error("请等待本轮研究完成后确认并发布");
      const selectedSections = prepared.document?.sections.filter(section => section.selected) ?? [];
      const inspectedSections = current.document?.sections.filter(section => section.selected) ?? [];
      if (prepared.document_id !== current.document_id || selectedSections.length !== inspectedSections.length || selectedSections.some(section => {
        const inspected = inspectedSections.find(item => item.id === section.id);
        return !inspected || inspected.revision !== section.revision
          || latestComponentProposal(current, section.id)?.id !== latestComponentProposal(prepared, section.id)?.id;
      })) {
        setDetail(prepared);
        throw new Error("文稿已有新修改，请重新检视后发布");
      }
      const proposals = selectedSections.flatMap(section => {
        const turn = latestComponentProposal(prepared, section.id);
        if (!turn?.proposal) return [];
        if (turn.status !== "done") throw new Error(`“${section.title}”的修改尚未完成，请先查看研究过程`);
        if (turn.proposal.base_revision !== section.revision) throw new Error(`“${section.title}”已发生变化，请先查看修订差异，处理冲突后再发布`);
        return [turn];
      });
      // Validate the entire selection before accepting any candidate.
      for (const turn of proposals) {
        prepared = await componentRequest<ComponentResearchRecord>(`/component-research/${prepared.id}/proposal`, { turn_id: turn.id, decision: "accept" });
        setDetail(prepared);
      }
      await componentRequest<{ id: string }>(`/component-research/${prepared.id}/adopt`, {
        title, ...(prepared.document ? {} : { content: draft }), scope,
        module_ids: module ? [module] : [], repositories: repos.split("\n").map(s => s.trim()).filter(Boolean),
      });
      setDetail(await componentRequest<ComponentResearchRecord>(`/component-research/${prepared.id}`));
      // Knowledge is already live. Archive failures must not turn this into a failed publication.
      try {
        const endpoint = `/component-research/${current.id}/archive`;
        const result = await componentRequest<{ archive: DomainKnowledgeJob | null }>(endpoint);
        const reusesMr = result.archive?.production?.archive.issue_description_required === false;
        if (result.archive?.issue_no && (result.archive.issue_description || reusesMr) && result.archive.knowledge_target.repository) {
          const archive = await componentRequest<DomainKnowledgeJob>(endpoint, {
            title, ...(current.document ? {} : { content: draft }),
            target: result.archive.knowledge_target,
            filename: result.archive.documents[0]?.path.split("/").at(-1),
            issue_no: result.archive.issue_no, issue_description: result.archive.issue_description, base_revision: result.archive.documents[0]?.revision,
          });
          await componentRequest<DomainKnowledgeJob>(`${endpoint}/publish`, {
            document_ids: archive.documents.map(d => d.id),
            expected_revisions: Object.fromEntries(archive.documents.map(d => [d.id, d.revision])),
          });
        }
      } catch (e) { setError((e as Error).message); }
      setArchiveRefresh(value => value + 1);
      void load().catch(() => {});
    } catch (e) { setError((e as Error).message); }
    finally { publishing.current = false; setBusy(false); }
  }
  const switchTaskView = (next: "progress" | "review") => {
    setStage(next);
    if (current && studio) {
      if (next === "review") studio.openResult("component", current.id);
      else studio.openExecution("component", current.id);
    }
  };
  if (surface && current) return <section className="tw-root component-knowledge-review" aria-label="组件文稿审查" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden" }}>
    <header className="knowledge-reading-toolbar flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
      <KnowledgeBackButton onClick={onClose} destination={backLabel} />
      <div className="flex min-w-0 flex-1 items-center gap-3"><h2 className="truncate text-base font-semibold" title={current.topic}>{current.topic}</h2>
        <span className={`shrink-0 text-sm ${current.production?.group === "attention" ? "text-amber-700" : "text-muted-foreground"}`}>{current.production?.status_label}</span></div>
      <div hidden={stage !== "review"} className="flex shrink-0 items-center gap-2">
        {current.production?.archive.visible && <ComponentKnowledgeArchive key={`archive:${current.id}`} record={current} title={title} content={draft} compact refreshKey={archiveRefresh} openRequest={archiveOpenRequest} compareDocumentId={new URLSearchParams(location.search).get("kbStage") === "remote" ? new URLSearchParams(location.search).get("knowledgeDocument") ?? undefined : undefined} onOpenKnowledge={onAdopt} />}
        {current.production?.research_actions.filter(action => ["publish", "update"].includes(action.id)).map(action => action.id === "update"
          ? <Button key={action.id} variant="outline" disabled={busy} onClick={() => void manage("begin-update")}>{action.label}</Button>
          : <span key={action.id} className="flex items-center gap-2"><Button variant="ghost" onClick={() => setPublishSettingsOpen(true)}><Settings2 size={16} />发布设置</Button><Button disabled={busy || reviewBlocked || !title.trim() || (current.document ? !current.document.sections.some(s => s.selected) : !draft.trim()) || (scope === "module" && !module) || (scope === "repository" && !repos.trim())} onClick={() => void publishKnowledge()}>{busy ? "正在发布…" : action.label}</Button></span>)}
        {current.production?.knowledge_document_id && <Button onClick={() => onAdopt(current.production!.knowledge_document_id!)}>查看知识</Button>}
      </div>
    </header>
    <KnowledgeTaskNavigation value={stage} onChange={switchTaskView} documentCount={current.document || current.draft ? 1 : 0} view={current.production} disabled={busy} />
    {error && <p role="alert" className="shrink-0 px-4 py-2 text-danger">{error}</p>}
    <Dialog open={publishSettingsOpen} onOpenChange={setPublishSettingsOpen}><DialogContent className="tw-root max-h-[85dvh] overflow-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>发布设置</DialogTitle></DialogHeader>
      <div className="grid grid-cols-2 gap-4">
        <label className="col-span-2 grid gap-2">知识名称<Input value={title} onChange={e => setTitle(e.target.value)} /></label>
        <Choice label="适用范围" value={scope} onChange={setScope} items={[{value:"platform",label:"平台通用"},{value:"module",label:"业务模块"},{value:"repository",label:"特定代码仓"}]} />
        {scope === "module" && <Choice label="业务模块" value={module} onChange={setModule} items={modules.filter(m => m.status === "active").map(m => ({value:m.id,label:m.name}))} />}
        {scope === "repository" && <label className="grid gap-2">适用代码仓（每行一个）<Textarea value={repos} onChange={e => setRepos(e.target.value)} /></label>}
        <p className="col-span-2 text-sm text-muted-foreground">勾选的能力合成一篇知识。未选内容保留在本任务中；更新时以完整所选章节替换这篇知识。</p>
      </div>
      <Button className="justify-self-end" onClick={() => setPublishSettingsOpen(false)}>完成</Button>
    </DialogContent></Dialog>
    <div hidden={stage !== "review"} className="min-h-0 flex-1" style={{ display: stage === "review" ? "flex" : "none", flexDirection: "column" }}>
      {current.production?.platform_message && <p className="shrink-0 border-b border-line px-4 py-1.5 text-sm text-muted-foreground">{current.production.platform_message}</p>}
      {current.document ? <ComponentResearchReview key={`review:${current.id}`} record={current} unified onBlockedChange={setReviewBlocked} onChanged={record => { setDetail(record); void load(); }} readerHeight="100%" />
        : current.draft ? <section className="min-h-0 flex-1 overflow-auto p-6"><div className="mb-3 flex justify-between"><strong>{current.production?.status_label}</strong>{!current.document_id && <Button variant="outline" onClick={() => setEditing(!editing)}>{editing ? "预览文稿" : "编辑文稿"}</Button>}</div>{editing ? <Textarea aria-label="知识文稿" rows={16} value={draft} onChange={e => setDraft(e.target.value)} /> : <Markdown text={draft} />}</section>
        : <p className="p-6 text-muted-foreground">文稿生成后可在这里检视。</p>}
    </div>
    <div hidden={stage !== "progress"} className="min-h-0 flex-1 overflow-auto p-5">
      <div className="mb-4 flex items-center gap-3 text-sm"><span className="mr-auto text-muted-foreground">{current.components?.length ?? 1} 个组件仓 · {knowledgeLanguageLabel(current.language)} · {current.operator}</span>
        {current.production?.research_actions.filter(action => ["stop", "resume"].includes(action.id)).map(action => <Button key={action.id} variant="outline" disabled={busy} onClick={() => void manage(action.id === "resume" ? "retry" : "stop")}>{action.label}</Button>)}
        <details className="relative"><summary className="cursor-pointer text-muted-foreground">来源范围</summary><div className="absolute right-0 z-10 mt-2 w-[480px] max-w-[80vw] rounded-lg border border-line bg-surface p-4 shadow-lg">{(current.components ?? [current.component]).map(component => <p key={component.id} className="mb-2 break-all">{component.name} · {component.repository} · {component.branch} · {component.path || "根目录"}<br />读取版本：{current.revisions?.[component.id] ?? (current.components ? "尚未读取" : current.revision ?? "尚未读取")}</p>)}</div></details>
      </div>
      {current.error && <p role="alert" className="mb-4 text-danger">{current.error}</p>}
      {current.pipeline && <p className="mb-4 text-sm text-muted-foreground">分项研究与独立评审：{current.pipeline.tasks.filter(task => task.status === "done").length}/{current.pipeline.tasks.length} 项通过</p>}
      <KnowledgeResearchProgress key={`progress:${current.id}`} evidence={current.evidence} />
    </div>
  </section>;
  if (compact && current?.document && stage === "review") return <section className="tw-root space-y-3" aria-label="萃取结果阅读页">
    <header className="flex items-center gap-3 pr-8">
      <KnowledgeBackButton onClick={() => selectRecord("history")} destination="萃取记录" />
      <h2 className="min-w-0 flex-1 truncate text-lg font-semibold" title={current.topic}>{current.document.overview.match(/^#\s+(.+)$/m)?.[1] ?? "萃取结果"}</h2>
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" aria-label="萃取结果操作" />}><MoreHorizontal size={20} /></DropdownMenuTrigger><DropdownMenuContent align="end" className="tw-root">
        <DropdownMenuItem onClick={() => setStage("progress")}>执行详情</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setStage("inputs")}>来源范围</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setStage("publish")}>入库与更新</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>
      {current.document_id ? <Button onClick={() => onAdopt(current.document_id!)}>查看已采纳知识</Button> : <Button disabled={busy || ["queued", "running"].includes(current.status)} onClick={() => setStage("publish")}>采纳知识</Button>}
    </header>
    {error && <p role="alert" className="text-danger">{error}</p>}
    <ComponentResearchReview key={`review:${current.id}`} record={current} onChanged={record => { setDetail(record); void load(); }} readerHeight="calc(96dvh - 110px)" />
  </section>;
  return (
    <KnowledgeExtractionWorkspace hideHeader={surface === "knowledge" && !!current} codeOnly title={focused ? "本篇文档的萃取过程" : "基础组件萃取"} onClose={onClose} backLabel={backLabel}
      onNew={focused ? undefined : () => { selectRecord("new"); setError(""); }}
      sidebar={!focused && surface !== "knowledge" ? <div>
            <Choice label="任务状态" value={statusFilter} onChange={setStatusFilter} items={[{value:"all",label:"全部任务"},{value:"active",label:"进行中"},{value:"done",label:"已完成"},{value:"failed",label:"失败"},{value:"cancelled",label:"已停止"}]} />
            {records.filter(r => statusFilter === "all" || (statusFilter === "active" ? ["queued", "running"].includes(r.status) : r.status === statusFilter)).map((r) => (
              <button
                key={r.id}
                className={`mb-2 w-full rounded-lg border p-3 text-left ${selected === r.id ? "border-primary bg-primary/5" : "border-line"}`}
                onClick={() => {
                  setDetail(undefined);
                  selectRecord(r.id);
                  setError("");
                }}
              >
                <strong className="line-clamp-2" title={r.topic}>{r.topic}</strong>
                <span className="mt-2 block text-sm text-muted-foreground">
                  {knowledgeLanguageLabel(r.language)} · {r.components?.length ?? 1} 个组件仓
                </span>
                <span className="mt-1 block text-sm">{r.stage}</span><time className="mt-1 block text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</time>
              </button>
            ))}
            {!records.length && (
              <p className="text-muted-foreground">暂无萃取记录</p>
            )}
          </div> : undefined}>
          <main className="min-w-0 pr-2 text-base">
            {error && (
              <p role="alert" className="mb-3 text-danger">
                {error}
              </p>
            )}
            {!selected || selected === "history" ? <div className="p-8 text-muted-foreground">选择一条萃取记录查看进度与草稿，或发起新的萃取。</div> : selected !== "new" && !current ? <p className="p-8" role="status">正在加载萃取记录…</p> : !current ? (
              <p className="p-8 text-muted-foreground">在左侧选择任务，查看进度、来源证据和草稿。</p>
            ) : (
              <>
                {surface === "knowledge" ? <header className="studio-result-toolbar">
                  <KnowledgeBackButton onClick={onClose} destination={backLabel} />
                  <FileText size={21} /><strong title={current.topic}>{current.topic}</strong><span className="studio-job-status">{current.production?.status_label}</span>
                  <div className="studio-result-actions"><Button variant="ghost" onClick={() => { studio?.openExecution("component", current.id); setStage("progress"); }}><History size={16} />萃取过程</Button>
                    {stage !== "review" && <Button variant="ghost" onClick={() => setStage("review")}>阅读成果</Button>}
                    <Button onClick={() => setStage("publish")}>Git 归档</Button>
                    <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多组件萃取操作" />}><MoreHorizontal size={20} /></DropdownMenuTrigger><DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setStage("inputs")}>资料</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => { studio?.openExecution("component"); selectRecord("new"); }}>新建萃取任务</DropdownMenuItem>
                      {!focused && <DropdownMenuItem disabled={busy} onClick={() => setDeleting(true)}>删除任务</DropdownMenuItem>}
                    </DropdownMenuContent></DropdownMenu>
                  </div>
                </header> : <div className="studio-run-toolbar"><header className="studio-execution-summary mb-5">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="line-clamp-2 flex-1 text-xl font-semibold" title={current.topic}>{current.topic}</h2>
                    {!focused && current.production?.research_actions.filter(action => ["stop", "resume"].includes(action.id)).map(action => <Button key={action.id} variant="outline" disabled={busy} onClick={() => void manage(action.id === "resume" ? "retry" : "stop")}>{action.label}</Button>)}
                    {!focused && <Button variant="outline" disabled={busy} onClick={() => setDeleting(true)}>删除任务</Button>}
                  </div>
                  <p className="mt-2 text-muted-foreground">
                    {current.components?.length ?? 1} 个组件仓 ·{" "}
                    {knowledgeLanguageLabel(current.language)} ·{" "}
                    {current.operator}
                  </p>
                  {current.pipeline && <p className="mt-2 text-sm text-muted-foreground">分项研究与独立评审：{current.pipeline.tasks.filter(t => t.status === "done").length}/{current.pipeline.tasks.length} 项通过</p>}
                  <p className="mt-3 font-medium text-primary">
                    {current.stage}
                  </p>
                  {current.error && (
                    <p role="alert" className="mt-3 text-danger">
                      {current.error}
                    </p>
                  )}
                </header>
                {surface === "workbench" ? <nav className="mb-4 flex gap-2" aria-label="组件研究详情">{([['progress','研究过程'],['inputs','来源范围']] as const).map(([value,label]) => <Button key={value} size="sm" variant={stage === value ? "secondary" : "ghost"} onClick={() => setStage(value)}>{label}</Button>)}<Button size="sm" variant="outline" disabled={!current.draft && !current.document} onClick={() => studio ? studio.openResult("component", current.id) : setStage("review")}>文稿审查</Button></nav> : compact ? <label className="mb-4 flex items-center gap-3">查看<select className="rounded-md border border-line bg-surface px-3 py-2" aria-label="查看萃取内容" value={stage} onChange={e => setStage(e.target.value)}><option value="review">萃取结果</option><option value="progress">执行详情</option><option value="inputs">来源范围</option><option value="publish">采纳知识</option></select></label> : <KnowledgeExtractionStages codeOnly value={stage} onChange={setStage} label="组件萃取阶段" />}</div>}
                {current.document && <div hidden={stage !== "review"}><ComponentResearchReview key={`review:${current.id}`} record={current} onChanged={record => { setDetail(record); void load(); }} /></div>}
                {stage === "inputs" && <details open className="mb-5 rounded-lg border border-line p-4">
                  <summary className="cursor-pointer font-medium">
                    源码范围与调用来源
                  </summary>
                  {stage === "inputs" && (current.components ?? [current.component]).map(c => <p key={c.id} className="mt-3 break-all text-sm">{c.name} · {c.repository} · {c.branch} · {c.path || "根目录"}<br/>读取版本：{current.revisions?.[c.id] ?? (current.components ? "尚未读取" : current.revision ?? "尚未读取")}</p>)}
                  {stage === "inputs" && <p className="mt-3 text-sm">来源限定为基础仓固定版本代码与 everycode 真实调用。{current.material_ids?.length ? "此历史记录曾关联上传资料，重新研究须新建任务。" : ""}</p>}
                </details>}
                {stage === "progress" && <KnowledgeResearchProgress key={`progress:${current.id}`} evidence={current.evidence} />}
                {current.draft && ["review", "publish"].includes(stage) && (
                  <>
                    {stage === "review" && !current.document && <><div className="mb-3 flex items-center justify-between">
                      <h3 className="font-semibold">
                        {current.document_id
                          ? "原始萃取草稿"
                          : "知识草稿 · 待人工审查"}
                      </h3>
                      <Button
                        variant="outline"
                        disabled={!!current.document_id}
                        onClick={() => setEditing(!editing)}
                      >
                        {editing ? "预览" : "编辑草稿"}
                      </Button>
                    </div>
                    {editing ? (
                      <Textarea
                        aria-label="知识草稿"
                        className="min-h-[360px] font-mono text-sm"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                    ) : (
                      <Markdown text={draft} />
                    )}</>}
                    {stage === "publish" && <ComponentKnowledgeArchive key={`archive:${current.id}`} record={current} title={title} content={draft} />}
                    {stage === "publish" && (current.document_id ? (
                      <div className="mt-5 flex gap-3"><Button variant="outline" disabled={busy} onClick={() => void manage("begin-update")}>更新这篇文档</Button><Button
                        className="mt-5"
                        onClick={() => onAdopt(current.document_id!)}
                      >
                        查看已采纳知识
                      </Button></div>
                    ) : (
                      <section className="mt-5 grid gap-4 rounded-lg border border-line bg-surface-2 p-4">
                        <label className="grid gap-2">
                          知识名称
                          <Input
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                          />
                        </label>
                        <Choice
                          label="采纳后的适用范围"
                          value={scope}
                          onChange={setScope}
                          items={[
                            { value: "platform", label: "平台通用" },
                            { value: "module", label: "业务模块" },
                            { value: "repository", label: "特定代码仓" },
                          ]}
                        />
                        {scope === "module" && (
                          <Choice
                            label="业务模块"
                            value={module}
                            onChange={setModule}
                            items={modules
                              .filter((m) => m.status === "active")
                              .map((m) => ({ value: m.id, label: m.name }))}
                          />
                        )}
                        {scope === "repository" && (
                          <label className="grid gap-2">
                            适用代码仓（每行一个地址）
                            <Textarea
                              value={repos}
                              onChange={(e) => setRepos(e.target.value)}
                            />
                          </label>
                        )}
                        <Button
                          disabled={
                            busy ||
                            current.status !== "done" ||
                            (!!current.document && !current.document.sections.some(section => section.selected)) ||
                            !draft.trim() ||
                            !title.trim() ||
                            (scope === "module" && !module) ||
                            (scope === "repository" && !repos.trim())
                          }
                          onClick={async () => {
                            setBusy(true);
                            setError("");
                            try {
                              const doc = await componentRequest<{
                                id: string;
                              }>(`/component-research/${current.id}/adopt`, {
                                title,
                                ...(current.document ? {} : { content: draft }),
                                scope,
                                module_ids: module ? [module] : [],
                                repositories: repos
                                  .split("\n")
                                  .map((s) => s.trim())
                                  .filter(Boolean),
                              });
                              await load();
                              onAdopt(doc.id);
                            } catch (e) {
                              setError((e as Error).message);
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          {current.document ? `确认采纳 ${current.document.sections.filter(section => section.selected).length} 项为一篇知识文档` : "确认采纳到知识库"}
                        </Button>
                      </section>
                    ))}
                  </>
                )}
              </>
            )}
          </main>

      <Dialog open={selected === "new"} onOpenChange={open => { if (!open) selectRecord("history"); }}>
        <DialogContent className="tw-root sm:max-w-[640px] max-h-[85vh] overflow-auto">
          <DialogHeader><DialogTitle>新建萃取任务</DialogTitle></DialogHeader>
          {error && <p role="alert" className="text-danger">{error}</p>}
              <div className="mx-auto grid max-w-2xl gap-5 py-4">
                <Choice label="萃取语言" value={language} onChange={setLanguage}
                  items={KNOWLEDGE_LANGUAGE_OPTIONS.filter(l => l.id !== "agnostic").map(l => ({value: l.id, label: l.label}))} />
                <div className="grid grid-cols-2 gap-3" role="group" aria-label="萃取方式">
                  {([['all', '全部基础组件'], ['topic', '指定主题']] as const).map(([value, label]) => <button type="button" key={value} aria-pressed={mode === value} className={`rounded-xl border p-4 text-left ${mode === value ? "border-primary bg-primary/5" : "border-line"}`} onClick={() => setMode(value)}><strong className="block">{label}</strong></button>)}
                </div>
                <p className="text-muted-foreground">{!componentsLoaded ? "正在读取组件仓配置…" : language ? matchingComponents.length ? `覆盖 ${matchingComponents.length} 个已启用的 ${knowledgeLanguageLabel(language)} 组件仓` : `尚未配置已启用的 ${knowledgeLanguageLabel(language)} 组件仓，请先到配置中心添加。` : "请选择需要萃取的语言。"}</p>
                <a className="text-primary underline" href="/configuration?tab=components">维护基础组件仓 ↗</a>
                {mode === "topic" && <label className="grid gap-2">
                  研究主题
                  <Textarea
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="例如：文件组件的句柄归属、异常清理及 UT Mock 方式"
                  />
                </label>}
                <Button
                  disabled={busy || !componentsLoaded || !matchingComponents.length || !language || (mode === "topic" && !topic.trim())}
                  onClick={() => void start()}
                >
                  {busy ? "发起中…" : mode === "all" ? "一键萃取全部组件" : "开始后台萃取"}
                </Button>
              </div>
        </DialogContent>
      </Dialog>
      <Dialog open={deleting} onOpenChange={setDeleting}><DialogContent className="tw-root sm:max-w-[480px]"><DialogHeader><DialogTitle>删除萃取任务？</DialogTitle></DialogHeader>{error && <p role="alert" className="text-danger">{error}</p>}<p>正在执行的任务会停止。已经采纳的知识文档和来源记录会保留。</p><div className="flex justify-end gap-3"><Button variant="outline" onClick={() => setDeleting(false)}>取消</Button><Button disabled={busy} onClick={() => void manage("delete")}>确认删除</Button></div></DialogContent></Dialog>
    </KnowledgeExtractionWorkspace>
  );
}
