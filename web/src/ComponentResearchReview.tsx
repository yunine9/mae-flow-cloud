import { componentKnowledgeMarkdown } from "../../src/componentKnowledgeMarkdown";
import { ComponentDocumentReader } from "./ComponentDocumentReader";
import { KnowledgeOutline } from "./KnowledgeOutline";
import { KnowledgeMarkdown, type KnowledgeFocus } from "./KnowledgeMarkdown";
import { KnowledgeReviewNotes } from "./KnowledgeReviewNotes";
import { KnowledgeContentSearch } from "./KnowledgeContentSearch";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { FileText, Download, MoreHorizontal, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { diffLines } from "diff";
import { Markdown } from "./markdown";
import { componentRequest, type ComponentResearchRecord, type ComponentResearchSection } from "./componentResearchApi";

function sectionMarkdown(section: ComponentResearchSection, includeMetadata = true) {
  return [...(/^\s*#\s/.test(section.content) ? [] : [`# ${section.title}`]), ...(includeMetadata && section.paradigm ? [`**状态：${({ recommended: "推荐", legacy: "历史写法", unverified: "待核实" } as Record<string, string>)[section.paradigm.status] ?? section.paradigm.status}**\n\n**需求：** ${section.paradigm.need}\n\n**适用条件：** ${section.paradigm.applicability}`] : []), componentKnowledgeMarkdown(section.content), "### 公共接口", componentKnowledgeMarkdown(section.interfaces) || "待研究",
    "### 集成产物与依赖", componentKnowledgeMarkdown(section.integration) || "待研究", "### 最佳示例", componentKnowledgeMarkdown(section.example) || "待补充（本项尚未完成）"].join("\n\n");
}
export function latestComponentProposal(record: ComponentResearchRecord, sectionId: string) {
  return [...(record.review_turns ?? [])].reverse().find(turn => turn.section_id === sectionId && turn.proposal?.status === "pending");
}
export function ComponentResearchReview({ record, onChanged, unified = false, onBlockedChange, readerHeight = "calc(100dvh - 300px)" }: {
  unified?: boolean; onBlockedChange?: (blocked: boolean) => void;
  readerHeight?: string; record: ComponentResearchRecord; onChanged: (record: ComponentResearchRecord) => void;
}) {
  const sections = record.document!.sections;
  const documentTitle = record.document!.overview.match(/^#\s+(.+)$/m)?.[1] ?? record.topic;
  const reader = useRef<HTMLDivElement>(null);
  const searchableContent = useRef<HTMLDivElement>(null);
  const [notesToolbar, setNotesToolbar] = useState<HTMLSpanElement | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [showDiscussion, setShowDiscussion] = useState(false);
  const [treeVisible, setTreeVisible] = useState(true);
  const [selected, setSelected] = useState(sections[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [knowledgeFocus, setKnowledgeFocus] = useState<KnowledgeFocus>();
  const [view, setView] = useState<"component" | "document">("component");
  const [editor, setEditor] = useState<ComponentResearchSection>();
  const [detailTab, setDetailTab] = useState<"content" | "changes" | "history">("content");
  const [artifacts, setArtifacts] = useState<{ mapping: string; rules: unknown[]; files: Record<string, string> }>();
  const [metadataText, setMetadataText] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const active = record.production?.working;
  const readonly = record.production?.review.readonly;
  const section = sections.find(item => item.id === selected) ?? sections[0];
  const proposal = section && latestComponentProposal(record, section.id);
  const previewSections = sections.map(item => {
    const candidate = latestComponentProposal(record, item.id);
    return !readonly && record.production?.review.sections.find(section => section.id === item.id)?.proposal_message && candidate?.proposal
      ? { ...candidate.proposal.section, id: item.id, revision: item.revision, selected: item.selected } : item;
  });
  const previewSection = previewSections.find(item => item.id === section?.id);
  const showingProposal = !!section && previewSection !== section;
  const versions = (record.section_history ?? []).filter(h => h.section.id === section?.id);
  const turns = (record.review_turns ?? []).filter(turn => turn.section_id === section?.id);
  const searchKey = view === "document" ? `${record.id}:document:${record.topic}:${record.document!.overview}:${previewSections.map(item => `${item.id}:${item.revision}:${item.content}`).join("|")}` : `${record.id}:component:${section?.id}:${section?.revision}:${proposal?.id}:${proposal?.status}:${proposal?.proposal?.status}`;
  const sectionPreview = previewSection && <div ref={searchableContent}><KnowledgeMarkdown text={sectionMarkdown(previewSection)} focus={knowledgeFocus} /></div>;
  useEffect(() => { onBlockedChange?.(busy || active || !!editor); return () => onBlockedChange?.(false); }, [busy, active, editor, onBlockedChange]);
  useEffect(() => { setArtifacts(undefined); }, [record.id, sections.map(s => `${s.id}:${s.revision}:${s.selected}`).join("|")]);
  useEffect(() => { setSelected(""); setReviewing(false); setMessage(""); setError(""); setView("component"); setEditor(undefined); }, [record.id]);
  function navigateKnowledge(id: string, line?: number) {
    if (editor && (editor.id !== id || line !== undefined)) { setError("请先保存或取消当前编辑，再跳转章节。"); return; }
    setSelected(id); setMessage(""); setError(""); setDetailTab("content");
    setKnowledgeFocus(old => ({ line, token: (old?.token ?? 0) + 1 }));
  }
  const outlineItems = previewSections.map(item => ({ id: item.id, title: item.title, content: sectionMarkdown(item), selected: item.selected,
    status: record.production?.review.sections.find(section => section.id === item.id)?.status_label }));
  async function request(action: string, body: unknown) {
    setBusy(true); setError("");
    try { onChanged(await componentRequest<ComponentResearchRecord>(`/component-research/${record.id}/${action}`, body)); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  }
  async function send(mode: "discuss" | "rework" | "update") {
    if (section && await request("review", { section_id: section.id, mode, message })) setMessage("");
  }
  if (!unified && !reviewing) return <section aria-label="组件萃取文档">
    <ComponentDocumentReader height={readerHeight} selected={selected || "overview"} onSelect={setSelected}
      files={[{ id: "overview", path: [documentTitle, "总览.md"], content: componentKnowledgeMarkdown(record.document!.overview) }, ...sections.map(s => ({ id: s.id, path: s.paradigm ? [documentTitle, s.paradigm.component, `${sections.filter(other => other.paradigm?.component === s.paradigm?.component && other.paradigm?.kind === s.paradigm?.kind).length > 1 ? s.title : ({ contracts: "使用契约", paradigm: "推荐用法", pitfalls: "误用与边界", index: "使用导航" } as Record<string, string>)[s.paradigm.kind] ?? s.title}.md`] : [documentTitle, `${s.title}.md`], content: sectionMarkdown(s, false), searchText: s.title, metadata: s.paradigm ? JSON.stringify(s.paradigm, null, 2) : undefined }))]}
      actions={<><Button variant="ghost" onClick={() => setReviewing(true)}>审阅与修订</Button><a className="px-2 text-sm text-primary" href={`/component-research/${record.id}/document`} download>下载 Markdown</a></>} />
  </section>;
  return <section aria-label="组件审核工作区" className="research-review" style={unified ? { flex: "1 1 0", height: readerHeight, minHeight: 0, margin: 0, border: 0, borderRadius: 0 } : undefined}>
    <div className="research-review-toolbar" style={unified ? { padding: "7px 16px", gap: 8, flexWrap: "nowrap" } : undefined}>
      {!unified && <Button variant="ghost" onClick={() => setReviewing(false)}>返回文档</Button>}
      <Button variant="ghost" size="sm" aria-expanded={treeVisible} onClick={() => setTreeVisible(value => !value)}>{treeVisible ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}{treeVisible ? "收起目录" : "展开目录"}</Button>
      <strong className="mr-auto flex min-w-0 items-center gap-2 text-sm" title={record.production?.review.selection_message}><FileText size={16} className="shrink-0" /><span className="truncate">{view === "document" ? "完整文档" : section?.title || documentTitle}</span></strong>
      {(view === "document" || !!section && detailTab === "content" && editor?.id !== section.id) && <KnowledgeContentSearch contentRef={searchableContent} contentKey={searchKey} contentSelector=".md" />}
      <div className="research-review-views shrink-0" role="group" aria-label="审查视图"><Button size="sm" aria-pressed={view === "component"} variant={view === "component" ? "secondary" : "ghost"} onClick={() => setView("component")}>{unified ? "逐项审查" : "逐项审核"}</Button>
        <Button size="sm" aria-pressed={view === "document"} variant={view === "document" ? "secondary" : "ghost"} onClick={() => setView("document")}>完整文档</Button></div>
      {unified && view === "component" && <Button size="sm" variant="ghost" aria-expanded={showDiscussion} onClick={() => setShowDiscussion(value => !value)}>研究对话{showDiscussion ? " · 收起" : ""}</Button>}
      {unified && <span ref={setNotesToolbar} className="flex items-center" />}
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="文稿更多操作" />}><MoreHorizontal size={18} /></DropdownMenuTrigger><DropdownMenuContent align="end" className="tw-root">
        {sections.some(s => s.paradigm) && <DropdownMenuItem disabled={active} onClick={async () => { try { setArtifacts(await componentRequest(`/component-research/${record.id}/artifacts`)); } catch (e) { setError((e as Error).message); } }}>查看派生产物</DropdownMenuItem>}
        <DropdownMenuItem render={<a href={`/component-research/${record.id}/document`} download />}><Download size={16} />下载 Markdown</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>
    </div>
    <Dialog open={!!artifacts} onOpenChange={open => { if (!open) setArtifacts(undefined); }}><DialogContent className="tw-root max-h-[88dvh] overflow-auto sm:max-w-4xl">
      <DialogHeader><DialogTitle>派生预览 · 规则未启用</DialogTitle></DialogHeader>
      {artifacts && <section aria-label="组件派生产物"><Button variant="outline" size="sm" onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(artifacts, null, 2)], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = "component-artifacts.json"; a.click(); URL.revokeObjectURL(url); }}>下载结构化产物</Button><Markdown text={artifacts.mapping} /><p>{Object.keys(artifacts.files).length} 个文件 · {artifacts.rules.length} 条规则候选</p><details><summary>文件与程序提取结果</summary><pre className="whitespace-pre-wrap break-all text-sm">{JSON.stringify(artifacts, null, 2)}</pre></details></section>}
    </DialogContent></Dialog>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {view === "document" ? <div className="research-review-panes" style={!treeVisible ? { gridTemplateColumns: "minmax(0, 1fr)" } : undefined}>
      {treeVisible && <KnowledgeOutline title={record.topic} items={outlineItems} currentId={section?.id} onNavigate={navigateKnowledge} label="文档组件目录" itemLabel={unified ? "能力" : undefined} itemUnit={unified ? "项" : undefined} />}
      <div ref={reader} tabIndex={0} aria-label="完整文档阅读区" className="research-reader research-full-document studio-paper"><p className="mb-4 text-sm text-muted-foreground">完整萃取成果（含未勾选项）；下载与入库仅包含勾选项。</p>
        <div ref={searchableContent}><Markdown text={`# ${record.topic}\n\n${record.document!.overview || "正在联合研究，章节将逐步保存…"}`} />
        {previewSections.map(item => <section key={item.id} className="mt-6 border-t border-line pt-4"><KnowledgeMarkdown text={sectionMarkdown(item)} focus={item.id === section?.id ? knowledgeFocus : undefined} />
          {!!item.related_ids.length && <p className="mt-3 text-sm">关联知识：{item.related_ids.map(id => <button key={id} className="knowledge-inline-link" onClick={() => navigateKnowledge(id)}>{sections.find(s => s.id === id)?.title ?? id}</button>)}</p>}
        </section>)}</div>
      </div>
    </div>
      : <div className="research-review-panes" style={!treeVisible ? { gridTemplateColumns: "minmax(0, 1fr)" } : undefined}>
        {treeVisible && <KnowledgeOutline title={record.topic} items={outlineItems} currentId={section?.id} onNavigate={navigateKnowledge} onSelection={readonly ? undefined : (id, selected) => void request("selection", { ids: [id], selected })} disabled={busy || active || !!editor} label="组件能力目录" itemLabel={unified ? "能力" : undefined} itemUnit={unified ? "项" : undefined} actions={!readonly && <>
          <button disabled={busy || active || readonly || !!editor || !sections.length} className="text-primary disabled:opacity-40 hover:underline" onClick={() => void request("selection", { ids: sections.map(s => s.id), selected: true })}>全选</button>
          <button disabled={busy || active || readonly || !!editor || !sections.length} className="text-primary disabled:opacity-40 hover:underline" onClick={() => void request("selection", { ids: sections.map(s => s.id), selected: false })}>全不选</button>
        </>} />}
        <div className="research-reader" style={unified ? { display: "grid", gridTemplateColumns: showDiscussion ? "minmax(0, 1fr) 280px" : "minmax(0, 1fr)", padding: 0, overflow: "hidden" } : undefined}>
          {section ? <>
            <div ref={reader} tabIndex={0} aria-label="组件详细文档" className="research-document-content studio-paper" style={unified ? { padding: "16px 28px 28px", overflow: "auto", minWidth: 0, minHeight: 0 } : undefined}>
              <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="章节内容视图">
                <span className="mr-auto text-sm text-muted-foreground">{record.production?.review.sections.find(item => item.id === section.id)?.proposal_message ?? record.production?.review.sections.find(item => item.id === section.id)?.status_label}{!readonly && !showingProposal && record.production?.review.sections.find(item => item.id === section.id)?.proposal_problem && <span className="text-warning"> · {record.production.review.sections.find(item => item.id === section.id)?.proposal_problem}</span>}</span>
                {([["content", "正文"], ["changes", "修订差异"], ["history", "历史版本"]] as const).map(([value, label]) => <Button key={value} size="sm" variant={detailTab === value ? "secondary" : "ghost"} onClick={() => setDetailTab(value)}>{label}</Button>)}
                {!readonly && <Button size="sm" variant="outline" disabled={busy || active || !!proposal} title={proposal ? "请先在修订差异中放弃当前修改，再人工编辑" : undefined} onClick={() => { setEditor(structuredClone(section)); setMetadataText(section.paradigm ? JSON.stringify(section.paradigm, null, 2) : ""); setDetailTab("content"); }}>人工编辑</Button>}
              </div>
              {detailTab === "content" && (editor?.id === section.id ? <div className="grid gap-3">
                {([['title', '标题'], ['content', '用法'], ['interfaces', '公共接口'], ['integration', '集成与依赖'], ['example', '示例'], ['sources', '来源']] as const).map(([key, label]) => <label key={key} className="grid gap-1">{label}<Textarea aria-label={`编辑${label}`} value={editor[key]} rows={key === "title" ? 1 : 6} disabled={key === "sources" && !!editor.paradigm} onChange={e => setEditor({ ...editor, [key]: e.target.value })} /></label>)}
                {editor.paradigm && <label className="grid gap-1">范式结构化字段（与正文同版本保存）<Textarea aria-label="编辑范式字段" rows={16} value={metadataText} onChange={e => setMetadataText(e.target.value)} /></label>}
                <div className="flex gap-2"><Button disabled={busy} onClick={async () => { try { const updated = editor.paradigm ? { ...editor, paradigm: JSON.parse(metadataText) } : editor; if (await request("edit-section", { section: updated, base_revision: editor.revision })) { setEditor(undefined); setArtifacts(undefined); } } catch { setError("范式字段必须是有效 JSON"); } }}>保存人工版本</Button><Button variant="outline" onClick={() => setEditor(undefined)}>取消编辑</Button></div>
              </div> : unified ? <KnowledgeReviewNotes kind="component" jobId={record.id} documentId={section.id} commentOnly={readonly} toolbarTarget={notesToolbar} working={active}>{sectionPreview}</KnowledgeReviewNotes> : sectionPreview)}
              {detailTab === "changes" && (proposal?.proposal ? <div>
                <p className="mb-3 text-sm">建议基于修订 {proposal.proposal.base_revision}，当前修订 {section.revision}。{proposal.proposal.base_revision !== section.revision && "正文已变化，请重新生成建议或手工合并。"}</p>
                <pre className="whitespace-pre-wrap break-words rounded border border-line p-3 text-sm">{diffLines(sectionMarkdown(section), sectionMarkdown(proposal.proposal.section)).map((part, i) => <span key={i} className={part.added ? "bg-green-500/15" : part.removed ? "bg-red-500/15 line-through" : ""}>{part.value}</span>)}</pre>
                {!readonly && <div className="mt-3 flex items-center gap-2">{unified ? <span className="mr-auto text-sm text-muted-foreground">确认并发布时会一并应用本轮修改。</span> : <Button disabled={busy || proposal.proposal.base_revision !== section.revision || proposal.status !== "done"} onClick={() => void request("proposal", { turn_id: proposal.id, decision: "accept" })}>采纳此建议</Button>}<Button variant="outline" disabled={busy} onClick={() => void request("proposal", { turn_id: proposal.id, decision: "discard" })}>放弃建议</Button></div>}
              </div> : <p className="text-muted-foreground">没有待采纳建议。可在右侧提交修订意见。</p>)}
              {detailTab === "history" && <div className="space-y-3">{versions.length ? [...versions].reverse().map(h => <details key={h.section.revision} className="rounded border border-line p-3"><summary>修订 {h.section.revision} · {h.operator} · {new Date(h.at).toLocaleString()}</summary><Markdown text={sectionMarkdown(h.section)} />{!readonly && <Button disabled={busy} onClick={() => void request("restore-section", { section_id: section.id, revision: h.section.revision, base_revision: section.revision })}>恢复为新版本</Button>}</details>) : <p className="text-muted-foreground">尚无历史版本。</p>}</div>}

              {!!section.related_ids.length && <div className="mt-4 border-t border-line pt-3"><strong className="text-sm">关联组件</strong><div className="mt-2 flex flex-wrap gap-2">{section.related_ids.map(id => <Button key={id} variant="outline" size="sm" onClick={() => navigateKnowledge(id)}>{sections.find(s => s.id === id)?.title ?? id}</Button>)}</div></div>}
            </div>
            {(!unified || showDiscussion) && <section aria-label="组件专家对话" className="research-discussion" style={unified ? { margin: 0, overflow: "auto", minHeight: 0 } : undefined}>
              <h3 className="font-semibold">与 AI 讨论 · {section.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">可追问依据、指出遗漏或要求补充示例。修改完成后直接检视文稿，确认并发布后生效。</p>
              <div className="my-4 max-h-[360px] space-y-4 overflow-auto" aria-live="polite">
                {turns.map(turn => <article key={turn.id} className="space-y-2 border-b border-line pb-3">
                  <p className="text-xs text-muted-foreground">{turn.operator} · {turn.mode === "rework" ? "要求本项返工" : "讨论"} · {new Date(turn.created_at).toLocaleString()}{turn.skill && ` · Skill ${turn.skill.digest.slice(0, 8)}`}</p>
                  <p className="whitespace-pre-wrap break-words">{turn.message}</p>
                  {turn.proposal && <p className="text-sm text-primary">{record.production?.review.turns.find(item => item.id === turn.id)?.proposal_status_label}{turn.proposal.status === "pending" && <Button variant="link" onClick={() => setDetailTab("changes")}>比较差异</Button>}</p>}
                  {turn.reply ? <div className="rounded-md bg-surface p-3"><Markdown text={turn.reply} /></div> : <p className={turn.error ? "text-danger" : "text-muted-foreground"}>{turn.error ?? record.production?.review.turns.find(item => item.id === turn.id)?.status_label}</p>}
                </article>)}
                {!turns.length && <p className="text-sm text-muted-foreground">此组件尚无讨论记录。</p>}
              </div>
              {!readonly && <><Textarea aria-label="组件讨论或返工意见" rows={4} placeholder="例如：请拆清同步与异步用法，补充错误处理示例，并核对头文件实际对应的库。" value={message} onChange={e => setMessage(e.target.value)} maxLength={20000} />
                <div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" disabled={busy || active || !message.trim()} onClick={() => void send("discuss")}>仅讨论</Button><Button disabled={busy || active || !message.trim()} onClick={() => void send("rework")}>生成修订建议</Button><Button variant="outline" disabled={busy || active || !message.trim()} onClick={() => void send("update")}>核对来源更新</Button></div>
                {record.production?.review.active_message && <p className="mt-2 text-sm text-muted-foreground">{record.production.review.active_message}</p>}
              </>}
            </section>}
          </> : <div className="rounded-lg border border-line p-5"><Markdown text={record.document!.overview || "正在联合阅读组件仓，梳理公开接口、构建目标与调用关系。"} /></div>}
        </div>
      </div>}
  </section>;
}
