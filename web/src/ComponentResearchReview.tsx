import { ComponentDocumentReader } from "./ComponentDocumentReader";
import { KnowledgeOutline } from "./KnowledgeOutline";
import { KnowledgeMarkdown, type KnowledgeFocus } from "./KnowledgeMarkdown";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Layers, FileText, Download } from "lucide-react";
import { diffLines } from "diff";
import { Markdown } from "./markdown";
import { componentRequest, type ComponentResearchRecord, type ComponentResearchSection } from "./componentResearchApi";

function sectionMarkdown(section: ComponentResearchSection, includeMetadata = true) {
  return [...(/^\s*#\s/.test(section.content) ? [] : [`# ${section.title}`]), ...(includeMetadata && section.paradigm ? [`**状态：${({ recommended: "推荐", legacy: "历史写法", unverified: "待核实" } as Record<string, string>)[section.paradigm.status] ?? section.paradigm.status}**\n\n**需求：** ${section.paradigm.need}\n\n**适用条件：** ${section.paradigm.applicability}`] : []), section.content, "### 公共接口", section.interfaces || "待研究",
    "### 集成产物与依赖", section.integration || "待研究", "### 最佳示例", section.example || "待补充（本项尚未完成）",
    "### 来源", section.sources || "待研究"].join("\n\n");
}
export function ComponentResearchReview({ record, onChanged, readerHeight = "calc(100dvh - 300px)" }: {
  readerHeight?: string; record: ComponentResearchRecord; onChanged: (record: ComponentResearchRecord) => void;
}) {
  const sections = record.document!.sections;
  const documentTitle = record.document!.overview.match(/^#\s+(.+)$/m)?.[1] ?? record.topic;
  const reader = useRef<HTMLDivElement>(null);
  const [reviewing, setReviewing] = useState(false);
  const [selected, setSelected] = useState(sections[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [knowledgeFocus, setKnowledgeFocus] = useState<KnowledgeFocus>();
  const [view, setView] = useState<"component" | "document">("component");
  const [editor, setEditor] = useState<ComponentResearchSection>();
  const [useLatestSkill, setUseLatestSkill] = useState(false);
  const [detailTab, setDetailTab] = useState<"content" | "changes" | "history">("content");
  const [artifacts, setArtifacts] = useState<{ mapping: string; rules: unknown[]; files: Record<string, string> }>();
  const [metadataText, setMetadataText] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const active = ["queued", "running"].includes(record.status);
  const readonly = !!record.document_id;
  const section = sections.find(item => item.id === selected) ?? sections[0];
  const proposal = [...(record.review_turns ?? [])].reverse().find(turn => turn.section_id === section?.id && turn.proposal?.status === "pending");
  const versions = (record.section_history ?? []).filter(h => h.section.id === section?.id);
  const turns = (record.review_turns ?? []).filter(turn => turn.section_id === section?.id);
  useEffect(() => { setArtifacts(undefined); }, [record.id, sections.map(s => `${s.id}:${s.revision}:${s.selected}`).join("|")]);
  useEffect(() => { setSelected(""); setReviewing(false); setMessage(""); setError(""); setView("component"); setEditor(undefined); }, [record.id]);
  function navigateKnowledge(id: string, line?: number) {
    if (editor?.id === id && line !== undefined) { setError("请先保存或取消当前编辑，再跳转章节。"); return; }
    setSelected(id); setMessage(""); setError(""); setDetailTab("content");
    setKnowledgeFocus(old => ({ line, token: (old?.token ?? 0) + 1 }));
  }
  const outlineItems = sections.map(item => ({ id: item.id, title: item.title, content: sectionMarkdown(item), selected: item.selected,
    status: item.revision ? `${item.selected ? "已纳入" : "未纳入"} · 修订 ${item.revision}` : "正在萃取" }));
  async function request(action: string, body: unknown) {
    setBusy(true); setError("");
    try { onChanged(await componentRequest<ComponentResearchRecord>(`/component-research/${record.id}/${action}`, body)); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  }
  async function send(mode: "discuss" | "rework" | "update") {
    if (section && await request("review", { section_id: section.id, mode, message, use_latest_skill: useLatestSkill })) setMessage("");
  }
  if (!reviewing) return <section aria-label="组件萃取文档">
    <ComponentDocumentReader height={readerHeight} selected={selected || "overview"} onSelect={setSelected}
      files={[{ id: "overview", path: [documentTitle, "总览.md"], content: record.document!.overview }, ...sections.map(s => ({ id: s.id, path: s.paradigm ? [documentTitle, s.paradigm.component, `${sections.filter(other => other.paradigm?.component === s.paradigm?.component && other.paradigm?.kind === s.paradigm?.kind).length > 1 ? s.title : ({ contracts: "使用契约", paradigm: "推荐用法", pitfalls: "误用与边界", index: "使用导航" } as Record<string, string>)[s.paradigm.kind] ?? s.title}.md`] : [documentTitle, `${s.title}.md`], content: sectionMarkdown(s, false), searchText: s.title, metadata: s.paradigm ? JSON.stringify(s.paradigm, null, 2) : undefined }))]}
      actions={<><Button variant="ghost" onClick={() => setReviewing(true)}>审阅与修订</Button><a className="px-2 text-sm text-primary" href={`/component-research/${record.id}/document`} download>下载 Markdown</a></>} />
  </section>;
  return <section aria-label="组件审核工作区" className="research-review">
    <div className="research-review-toolbar">
      <Button variant="ghost" onClick={() => setReviewing(false)}>返回文档</Button>
      <div className="mr-auto min-w-0"><strong className="flex items-center gap-2"><Layers size={18} />{sections.length} 项可复用能力</strong><p className="mt-1 text-sm text-muted-foreground">已完成 {sections.filter(s => s.revision > 0).length} 项 · 已勾选 {sections.filter(s => s.selected).length} 项，采纳为一篇 Markdown</p></div>
      <div className="research-review-views" role="group" aria-label="审查视图"><Button aria-pressed={view === "component"} variant={view === "component" ? "default" : "outline"} onClick={() => setView("component")}>逐项审核</Button>
      <Button aria-pressed={view === "document"} variant={view === "document" ? "default" : "outline"} onClick={() => setView("document")}>完整文档</Button></div>
      {sections.some(s => s.paradigm) && <Button variant="outline" disabled={active} onClick={async () => { try { setArtifacts(await componentRequest(`/component-research/${record.id}/artifacts`)); } catch (e) { setError((e as Error).message); } }}>查看派生产物</Button>}
      <a className="research-download" href={`/component-research/${record.id}/document`} download><Download size={16} />下载 Markdown</a>
    </div>
    {artifacts && <section aria-label="组件派生产物" className="m-3 max-h-96 overflow-auto rounded border border-line p-4"><div className="flex gap-3"><strong>派生预览 · 规则未启用</strong><Button variant="outline" size="sm" onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(artifacts, null, 2)], { type: "application/json" })); const a = document.createElement("a"); a.href = url; a.download = "component-artifacts.json"; a.click(); URL.revokeObjectURL(url); }}>下载结构化产物</Button><Button variant="outline" size="sm" onClick={() => setArtifacts(undefined)}>关闭预览</Button></div><Markdown text={artifacts.mapping} /><p>{Object.keys(artifacts.files).length} 个文件 · {artifacts.rules.length} 条规则候选</p><details><summary>文件与程序提取结果</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(artifacts, null, 2)}</pre></details></section>}
    {error && <p role="alert" className="text-danger">{error}</p>}
    {view === "document" ? <div className="research-review-panes">
      <KnowledgeOutline title={record.topic} items={outlineItems} currentId={section?.id} onNavigate={navigateKnowledge} label="文档组件目录" />
      <div ref={reader} tabIndex={0} aria-label="完整文档阅读区" className="research-reader research-full-document"><p className="mb-4 text-sm text-muted-foreground">完整萃取成果（含未勾选项）；下载与入库仅包含勾选项。</p>
        <Markdown text={`# ${record.topic}\n\n${record.document!.overview || "正在联合研究，章节将逐步保存…"}`} />
        {sections.map(item => <section key={item.id} className="mt-6 border-t border-line pt-4"><KnowledgeMarkdown text={sectionMarkdown(item)} focus={item.id === section?.id ? knowledgeFocus : undefined} />
          {!!item.related_ids.length && <p className="mt-3 text-sm">关联知识：{item.related_ids.map(id => <button key={id} className="knowledge-inline-link" onClick={() => navigateKnowledge(id)}>{sections.find(s => s.id === id)?.title ?? id}</button>)}</p>}
        </section>)}
      </div>
    </div>
      : <div className="research-review-panes">
        <KnowledgeOutline title={record.topic} items={outlineItems} currentId={section?.id} onNavigate={navigateKnowledge} onSelection={(id, selected) => void request("selection", { ids: [id], selected })} disabled={busy || active || readonly} label="组件能力目录" actions={<>
          <button disabled={busy || active || readonly || !sections.length} className="text-primary disabled:opacity-40 hover:underline" onClick={() => void request("selection", { ids: sections.map(s => s.id), selected: true })}>全选</button>
          <button disabled={busy || active || readonly || !sections.length} className="text-primary disabled:opacity-40 hover:underline" onClick={() => void request("selection", { ids: sections.map(s => s.id), selected: false })}>全不选</button>
        </>} />
        <div className="research-reader">
          {section ? <>
            <div ref={reader} tabIndex={0} aria-label="组件详细文档" className="research-document-content">
              <div className="research-document-eyebrow"><FileText size={16} />组件使用指南</div>
              <p className="mb-3 text-sm text-muted-foreground">{section.title} · {section.selected ? "已纳入文档" : "未纳入文档"}</p>
              <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="章节内容视图">
                {([["content", "正文"], ["changes", "修订差异"], ["history", "历史版本"]] as const).map(([value, label]) => <Button key={value} size="sm" variant={detailTab === value ? "default" : "outline"} onClick={() => setDetailTab(value)}>{label}</Button>)}
                {!readonly && <Button size="sm" variant="outline" onClick={() => { setEditor(structuredClone(section)); setMetadataText(section.paradigm ? JSON.stringify(section.paradigm, null, 2) : ""); setDetailTab("content"); }}>人工编辑</Button>}
              </div>
              {detailTab === "content" && (editor?.id === section.id ? <div className="grid gap-3">
                {([['title', '标题'], ['content', '用法'], ['interfaces', '公共接口'], ['integration', '集成与依赖'], ['example', '示例'], ['sources', '来源']] as const).map(([key, label]) => <label key={key} className="grid gap-1">{label}<Textarea aria-label={`编辑${label}`} value={editor[key]} rows={key === "title" ? 1 : 6} disabled={key === "sources" && !!editor.paradigm} onChange={e => setEditor({ ...editor, [key]: e.target.value })} /></label>)}
                {editor.paradigm && <label className="grid gap-1">范式结构化字段（与正文同版本保存）<Textarea aria-label="编辑范式字段" rows={16} value={metadataText} onChange={e => setMetadataText(e.target.value)} /></label>}
                <div className="flex gap-2"><Button disabled={busy} onClick={async () => { try { const updated = editor.paradigm ? { ...editor, paradigm: JSON.parse(metadataText) } : editor; if (await request("edit-section", { section: updated, base_revision: editor.revision })) { setEditor(undefined); setArtifacts(undefined); } } catch { setError("范式字段必须是有效 JSON"); } }}>保存人工版本</Button><Button variant="outline" onClick={() => setEditor(undefined)}>取消编辑</Button></div>
              </div> : <KnowledgeMarkdown text={sectionMarkdown(section)} focus={knowledgeFocus} />)}
              {detailTab === "changes" && (proposal?.proposal ? <div>
                <p className="mb-3 text-sm">建议基于修订 {proposal.proposal.base_revision}，当前修订 {section.revision}。{proposal.proposal.base_revision !== section.revision && "正文已变化，请重新生成建议或手工合并。"}</p>
                <pre className="whitespace-pre-wrap break-words rounded border border-line p-3 text-sm">{diffLines(sectionMarkdown(section), sectionMarkdown(proposal.proposal.section)).map((part, i) => <span key={i} className={part.added ? "bg-green-500/15" : part.removed ? "bg-red-500/15 line-through" : ""}>{part.value}</span>)}</pre>
                {!readonly && <div className="mt-3 flex gap-2"><Button disabled={busy || proposal.proposal.base_revision !== section.revision || proposal.status !== "done"} onClick={() => void request("proposal", { turn_id: proposal.id, decision: "accept" })}>采纳此建议</Button><Button variant="outline" disabled={busy} onClick={() => void request("proposal", { turn_id: proposal.id, decision: "discard" })}>放弃建议</Button></div>}
              </div> : <p className="text-muted-foreground">没有待采纳建议。可在右侧提交修订意见。</p>)}
              {detailTab === "history" && <div className="space-y-3">{versions.length ? [...versions].reverse().map(h => <details key={h.section.revision} className="rounded border border-line p-3"><summary>修订 {h.section.revision} · {h.operator} · {new Date(h.at).toLocaleString()}</summary><Markdown text={sectionMarkdown(h.section)} />{!readonly && <Button disabled={busy} onClick={() => void request("restore-section", { section_id: section.id, revision: h.section.revision, base_revision: section.revision })}>恢复为新版本</Button>}</details>) : <p className="text-muted-foreground">尚无历史版本。</p>}</div>}

              {!!section.related_ids.length && <div className="mt-4 border-t border-line pt-3"><strong className="text-sm">关联组件</strong><div className="mt-2 flex flex-wrap gap-2">{section.related_ids.map(id => <Button key={id} variant="outline" size="sm" onClick={() => navigateKnowledge(id)}>{sections.find(s => s.id === id)?.title ?? id}</Button>)}</div></div>}
            </div>
            <section aria-label="组件专家对话" className="research-discussion">
              <h3 className="font-semibold">与 AI 讨论 · {section.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">可追问依据、指出遗漏或要求补充示例。“仅讨论”保留原稿；“生成修订建议”保留原稿，比较差异后再采纳。</p>
              <div className="my-4 max-h-[360px] space-y-4 overflow-auto" aria-live="polite">
                {turns.map(turn => <article key={turn.id} className="space-y-2 border-b border-line pb-3">
                  <p className="text-xs text-muted-foreground">{turn.operator} · {turn.mode === "rework" ? "要求本项返工" : "讨论"} · {new Date(turn.created_at).toLocaleString()}{turn.skill && ` · Skill ${turn.skill.digest.slice(0, 8)}`}</p>
                  <p className="whitespace-pre-wrap break-words">{turn.message}</p>
                  {turn.proposal && <p className="text-sm text-primary">{turn.proposal.status === "pending" ? "已生成建议，原稿保留" : turn.proposal.status === "accepted" ? "建议已采纳" : "建议已放弃"}{turn.proposal.status === "pending" && <Button variant="link" onClick={() => setDetailTab("changes")}>比较差异</Button>}</p>}
                  {turn.reply ? <div className="rounded-md bg-surface p-3"><Markdown text={turn.reply} /></div> : <p className={turn.error ? "text-danger" : "text-muted-foreground"}>{turn.error ?? ({ queued: "等待处理…", running: "正在查阅资料并处理…", cancelled: "本轮已停止，原稿保留", failed: "本轮失败，原稿保留", done: "本轮已完成" }[turn.status])}</p>}
                </article>)}
                {!turns.length && <p className="text-sm text-muted-foreground">此组件尚无讨论记录。</p>}
              </div>
              {!readonly && <><label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={useLatestSkill} onChange={e => setUseLatestSkill(e.target.checked)} />下一轮使用最新组件萃取 Skill</label><Textarea aria-label="组件讨论或返工意见" rows={4} placeholder="例如：请拆清同步与异步用法，补充错误处理示例，并核对头文件实际对应的库。" value={message} onChange={e => setMessage(e.target.value)} maxLength={20000} />
                <div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" disabled={busy || active || !message.trim()} onClick={() => void send("discuss")}>仅讨论</Button><Button disabled={busy || active || !message.trim()} onClick={() => void send("rework")}>生成修订建议</Button><Button variant="outline" disabled={busy || active || !message.trim()} onClick={() => void send("update")}>核对来源更新</Button></div>
                {active && <p className="mt-2 text-sm text-muted-foreground">本轮正在执行，可先填写下一条意见；完成或停止后继续发送。</p>}
              </>}
            </section>
          </> : <div className="rounded-lg border border-line p-5"><Markdown text={record.document!.overview || "正在联合阅读组件仓，梳理公开接口、构建目标与调用关系。"} /></div>}
        </div>
      </div>}
  </section>;
}
