import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "./markdown";
import { componentRequest, type ComponentResearchRecord, type ComponentResearchSection } from "./componentResearchApi";

function sectionMarkdown(section: ComponentResearchSection) {
  return [`## ${section.title}`, section.content, "### 公共接口", section.interfaces || "待研究",
    "### 集成产物与依赖", section.integration || "待研究", "### 最佳示例", section.example || "待补充（本项尚未完成）",
    "### 来源", section.sources || "待研究"].join("\n\n");
}
export function ComponentResearchReview({ record, onChanged }: {
  record: ComponentResearchRecord; onChanged: (record: ComponentResearchRecord) => void;
}) {
  const sections = record.document!.sections;
  const [selected, setSelected] = useState(sections[0]?.id ?? "");
  const [query, setQuery] = useState(""), [message, setMessage] = useState("");
  const [view, setView] = useState<"component" | "document">("component");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const active = ["queued", "running"].includes(record.status);
  const readonly = !!record.document_id;
  const section = sections.find(item => item.id === selected) ?? sections[0];
  const turns = (record.review_turns ?? []).filter(turn => turn.section_id === section?.id);
  useEffect(() => { setSelected(""); setQuery(""); setMessage(""); setError(""); setView("component"); }, [record.id]);
  async function request(action: string, body: unknown) {
    setBusy(true); setError("");
    try { onChanged(await componentRequest<ComponentResearchRecord>(`/component-research/${record.id}/${action}`, body)); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  }
  async function send(mode: "discuss" | "rework") {
    if (section && await request("review", { section_id: section.id, mode, message })) setMessage("");
  }
  return <section aria-label="组件审核工作区" className="mb-5 space-y-4">
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2 p-4">
      <div className="mr-auto"><strong>{sections.length} 项可复用能力</strong><p className="mt-1 text-sm text-muted-foreground">已完成 {sections.filter(s => s.revision > 0).length} 项 · 已勾选 {sections.filter(s => s.selected).length} 项，采纳为一篇 Markdown</p></div>
      <Button variant={view === "component" ? "default" : "outline"} onClick={() => setView("component")}>逐项审核</Button>
      <Button variant={view === "document" ? "default" : "outline"} onClick={() => setView("document")}>完整文档</Button>
      <a className="text-sm text-primary underline" href={`/component-research/${record.id}/document`} download>下载已勾选内容 .md</a>
    </div>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {view === "document" ? <div className="rounded-lg border border-line p-5"><p className="mb-4 text-sm text-muted-foreground">完整研究草稿（含未勾选项）；下载与采纳仅包含勾选项，跨仓概述保留。</p>
      <Markdown text={`# ${record.topic}\n\n${record.document!.overview || "正在联合研究，章节将逐步保存…"}`} />
      <nav aria-label="文档组件目录" className="my-4 flex flex-wrap gap-2">{sections.map(item => <Button key={item.id} variant="outline" size="sm" onClick={() => document.getElementById(`research-section-${item.id}`)?.scrollIntoView({block:"start"})}>{item.title}</Button>)}</nav>
      {sections.map(item => <section key={item.id} id={`research-section-${item.id}`} className="mt-6 border-t border-line pt-4"><Markdown text={sectionMarkdown(item)} />
        {!!item.related_ids.length && <p className="mt-3 text-sm">关联组件：{item.related_ids.map(id => sections.find(s => s.id === id)?.title ?? id).join("、")}</p>}
      </section>)}
    </div>
      : <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4">
        <aside className="min-w-0 rounded-lg border border-line p-3">
          <Input aria-label="筛选组件能力" placeholder="搜索能力名称…" value={query} onChange={e => setQuery(e.target.value)} />
          <div className="my-3 flex gap-3 text-sm">
            <button disabled={busy || active || readonly || !sections.length} className="text-primary disabled:opacity-40" onClick={() => void request("selection", { ids: sections.map(s => s.id), selected: true })}>全选</button>
            <button disabled={busy || active || readonly || !sections.length} className="text-primary disabled:opacity-40" onClick={() => void request("selection", { ids: sections.map(s => s.id), selected: false })}>全不选</button>
          </div>
          <div className="max-h-[600px] space-y-1 overflow-auto">
            {sections.filter(s => s.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(item => <div key={item.id} className={`flex items-start gap-2 rounded-md border p-2 ${section?.id === item.id ? "border-primary bg-primary/5" : "border-transparent"}`}>
              <input type="checkbox" className="mt-1 shrink-0" aria-label={`纳入 ${item.title}`} checked={item.selected} disabled={busy || active || readonly}
                onChange={e => void request("selection", { ids: [item.id], selected: e.target.checked })} />
              <button className="min-w-0 flex-1 text-left" onClick={() => { setSelected(item.id); setMessage(""); setError(""); }} aria-pressed={section?.id === item.id}>
                <span className="block break-words text-sm font-medium">{item.title}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{item.revision ? `${readonly ? (item.selected ? "已采纳" : "未采纳") : "待审查"} · 修订 ${item.revision}` : "尚未完成"}{item.repository_ids.length > 1 ? ` · 跨 ${item.repository_ids.length} 仓` : ""}</span>
              </button>
            </div>)}
            {!sections.length && <p className="py-5 text-sm text-muted-foreground">正在梳理跨仓关系与细粒度能力，发现的组件会列在这里，默认全选。</p>}
          </div>
        </aside>
        <div className="min-w-0 space-y-4">
          {section ? <>
            <div className="rounded-lg border border-line p-5">
              <p className="mb-3 text-sm text-muted-foreground">{section.repository_ids.map(id => record.components?.find(c => c.id === id)?.name ?? id).join(" · ")} · {section.selected ? "已纳入文档" : "未纳入文档"}</p>
              <Markdown text={sectionMarkdown(section)} />
              {!!section.related_ids.length && <div className="mt-4 border-t border-line pt-3"><strong className="text-sm">关联组件</strong><div className="mt-2 flex flex-wrap gap-2">{section.related_ids.map(id => <Button key={id} variant="outline" size="sm" onClick={() => { setSelected(id); setMessage(""); }}>{sections.find(s => s.id === id)?.title ?? id}</Button>)}</div></div>}
            </div>
            <section aria-label="组件专家对话" className="rounded-lg border border-line bg-surface-2 p-4">
              <h3 className="font-semibold">与 AI 讨论 · {section.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">可追问依据、指出遗漏或要求补充示例。“仅讨论”保留原稿；“按意见返工”只更新这一项，其他组件不变。</p>
              <div className="my-4 max-h-[360px] space-y-4 overflow-auto" aria-live="polite">
                {turns.map(turn => <article key={turn.id} className="space-y-2 border-b border-line pb-3">
                  <p className="text-xs text-muted-foreground">{turn.operator} · {turn.mode === "rework" ? "要求本项返工" : "讨论"} · {new Date(turn.created_at).toLocaleString()}</p>
                  <p className="whitespace-pre-wrap break-words">{turn.message}</p>
                  {turn.reply ? <div className="rounded-md bg-surface p-3"><Markdown text={turn.reply} /></div> : <p className={turn.error ? "text-danger" : "text-muted-foreground"}>{turn.error ?? ({ queued: "等待处理…", running: "正在查阅资料并处理…", cancelled: "本轮已停止，原稿保留", failed: "本轮失败，原稿保留", done: "本轮已完成" }[turn.status])}</p>}
                </article>)}
                {!turns.length && <p className="text-sm text-muted-foreground">此组件尚无讨论记录。</p>}
              </div>
              {!readonly && <><Textarea aria-label="组件讨论或返工意见" rows={4} placeholder="例如：请拆清同步与异步用法，补充错误处理示例，并核对头文件实际对应的库。" value={message} onChange={e => setMessage(e.target.value)} maxLength={20000} />
                <div className="mt-3 flex justify-end gap-3"><Button variant="outline" disabled={busy || active || !message.trim()} onClick={() => void send("discuss")}>仅讨论</Button><Button disabled={busy || active || !message.trim()} onClick={() => void send("rework")}>按意见返工此组件</Button></div>
                {active && <p className="mt-2 text-sm text-muted-foreground">本轮正在执行，可先填写下一条意见；完成或停止后继续发送。</p>}
              </>}
            </section>
          </> : <div className="rounded-lg border border-line p-5"><Markdown text={record.document!.overview || "正在联合阅读组件仓，梳理公开接口、构建目标与调用关系。"} /></div>}
        </div>
      </div>}
  </section>;
}
