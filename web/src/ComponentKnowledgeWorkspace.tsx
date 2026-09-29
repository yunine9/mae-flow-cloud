import { useEffect, useState } from "react";
import { BookOpen, ChevronRight, Search, Settings2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ComponentKnowledgeArtifacts } from "./ComponentKnowledgeArtifacts";
import { ComponentResearch } from "./ComponentResearch";
import { componentRequest } from "./componentResearchApi";
import { documentRequest, type KnowledgeDocument } from "./knowledgeDocumentsApi";
import { listTasks, type TaskSummary } from "./api";
import { Markdown } from "./markdown";
import { knowledgeLanguageLabel } from "./KnowledgeLanguages";
import type { ComponentPolicyLevel, ComponentFeedback, ComponentGovernanceSnapshot, ComponentGovernanceItem } from "../../src/componentKnowledgeTypes";

type Item = ComponentGovernanceItem;
const feedbackLabels = { useful: "这处建议适用", false_positive: "这处提示有误", counterexample: "存在不适用的场景", quality_ok: "已核对内容正确", quality_error: "知识内容有误" };
const field = "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm";
const belongs = (a: Item, b: Item) => a.paradigm.document_id === b.paradigm.document_id && a.paradigm.start_line === b.paradigm.start_line;
const stateLabel = (item: Item) => item.policy.level === "warning" ? "记录并提示" : item.policy.level === "off" ? "不检查" : "仅记录";

export function ComponentKnowledgeWorkspace({ open, focusId, onClose: _onClose, onAdopt }: {
  open: boolean; focusId?: string; onClose: () => void; onAdopt: (id: string) => void;
}) {
  const [data, setData] = useState<ComponentGovernanceSnapshot>(), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [selected, setSelected] = useState(""), [query, setQuery] = useState("");
  const [policySnapshot, setPolicySnapshot] = useState({ revision: -1, digest: "" });
  const [feedbackDigest, setFeedbackDigest] = useState("");
  const [artifacts, setArtifacts] = useState("");
  const [research, setResearch] = useState(focusId || ""), [adopted, setAdopted] = useState("");
  const [document, setDocument] = useState<KnowledgeDocument>(), [documentError, setDocumentError] = useState("");
  const [settings, setSettings] = useState(false), [editId, setEditId] = useState(""), [feedbackId, setFeedbackId] = useState("");
  const [busy, setBusy] = useState(false), [dialogError, setDialogError] = useState("");
  const [tasks, setTasks] = useState<TaskSummary[]>([]), [task, setTask] = useState("");
  const [level, setLevel] = useState<ComponentPolicyLevel>("shadow"), [owner, setOwner] = useState(""), [scope, setScope] = useState(""), [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState<ComponentFeedback["kind"]>("quality_error"), [note, setNote] = useState(""), [sampleId, setSampleId] = useState("");
  const knowledge = (data?.items ?? []).filter(i => i.kind === "mapping");
  const visible = knowledge.filter(i => `${i.paradigm.component} ${i.paradigm.title} ${i.paradigm.need} ${i.paradigm.api.join(" ")}`.toLowerCase().includes(query.toLowerCase()));
  const components = [...new Set(visible.map(i => i.paradigm.component))];
  const item = knowledge.find(i => i.id === selected);
  const rules = item ? (data?.items ?? []).filter(i => i.kind === "rule" && belongs(i, item)) : [];
  const edit = data?.items.find(i => i.id === editId), feedbackItem = data?.items.find(i => i.id === feedbackId);
  async function refresh() { const next = await componentRequest<ComponentGovernanceSnapshot>("/component-knowledge"); setData(next); return next; }
  useEffect(() => { if (focusId) setResearch(focusId); }, [focusId]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = () => componentRequest<ComponentGovernanceSnapshot>("/component-knowledge").then(next => { if (live) { setData(next); setError(""); } }).catch(e => { if (live) setError(e.message); });
    void load(); const timer = setInterval(() => void load(), 10000);
    return () => { live = false; clearInterval(timer); };
  }, [open]);
  useEffect(() => {
    setSelected(previous => {
      const target = adopted && visible.find(i => i.paradigm.document_id === adopted);
      return target ? target.id : visible.some(i => i.id === previous) ? previous : visible[0]?.id ?? "";
    });
  }, [data, query, adopted]);
  useEffect(() => {
    let live = true; setDocument(undefined); setDocumentError("");
    if (item) void documentRequest<KnowledgeDocument>(`/${encodeURIComponent(item.paradigm.document_id)}`).then(doc => { if (live) setDocument(doc); }).catch(e => { if (live) setDocumentError(e.message); });
    return () => { live = false; };
  }, [item?.paradigm.document_id, item?.source_digest]);
  useEffect(() => {
    if (!settings) return;
    let live = true;
    void listTasks().then(rows => { if (live) setTasks(rows.filter(t => t.repo_url || t.repositories?.length)); }).catch(e => { if (live) setDialogError(e.message); });
    return () => { live = false; };
  }, [settings]);
  function openPolicy(row: Item) {
    setPolicySnapshot({ revision: data!.revision, digest: row.source_digest });
    setEditId(row.id); setLevel(row.policy.level); setOwner(row.policy.owner); setScope(row.policy.scope.join("\n")); setReason(""); setDialogError("");
  }
  function correct(row: Item, sample = "") {
    setFeedbackDigest(row.source_digest);
    setFeedbackId(row.id); setSampleId(sample); setFeedback(sample ? "false_positive" : "quality_error"); setNote(""); setDialogError("");
  }
  async function action(fn: () => Promise<unknown>, message: string, done?: () => void) {
    setBusy(true); setDialogError(""); setNotice("");
    try { await fn(); await refresh(); setNotice(message); done?.(); }
    catch (e) { setDialogError((e as Error).message); }
    finally { setBusy(false); }
  }
  function closeResearch() {
    setResearch(""); const url = new URL(location.href); url.searchParams.delete("componentResearch"); url.searchParams.delete("researchDocument"); history.replaceState(history.state, "", url);
    void refresh().catch(e => setError(e.message));
  }
  const content = item && document?.content?.split(/\r?\n/).slice(item.paradigm.start_line - 1, item.paradigm.end_line).join("\n").replace(/^<a id="component-[^"\n]+"><\/a>\s*/gm, "").trim().replace(/^#{1,2} [^\n]+\n/, "").replace(/^#{2,3} 来源\s*\n[\s\S]*$/m, "").trim();
  return <section className="tw-root space-y-4" aria-label="组件知识工作台">
    <header className="flex items-center justify-between gap-4">
      <h2 className="text-xl font-semibold">组件知识</h2>
      <div className="flex items-center gap-2"><Button variant="ghost" onClick={() => setResearch("history")}>查看萃取记录</Button><Button onClick={() => setResearch("new")}><Sparkles size={16} />萃取知识</Button></div>
    </header>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {notice && <p role="status" className="text-primary">{notice}</p>}
    {!!data?.warnings.length && <details className="rounded-lg border border-line p-3"><summary className="cursor-pointer text-attention">有 {data.warnings.length} 项知识未能完整读取</summary>{data.warnings.map((w, i) => <p key={i} className="mt-2 break-words">{w}</p>)}</details>}
    <div className="grid min-h-[620px] grid-cols-[260px_minmax(0,1fr)] overflow-hidden rounded-xl border border-line bg-surface">
      <aside className="border-r border-line bg-surface-2/40" aria-label="组件列表">
        <div className="relative border-b border-line p-4"><Search size={16} className="absolute left-7 top-7 text-muted-foreground" /><Input className="pl-9" aria-label="搜索组件知识" placeholder="搜索组件或能力" value={query} onChange={e => { setAdopted(""); setQuery(e.target.value); }} /></div>
        <div className="max-h-[720px] overflow-auto p-3">{components.map(component => <section key={component} className="mb-5">
          <h3 className="px-3 py-2 font-semibold">{component}</h3>
          {visible.filter(i => i.paradigm.component === component).map(row => <button key={row.id} aria-current={row.id === selected ? "true" : undefined} onClick={() => { setAdopted(""); setSelected(row.id); }} className={`flex w-full items-start gap-2 rounded-lg px-3 py-3 text-left text-sm ${row.id === selected ? "bg-primary/10 text-primary" : "hover:bg-surface-2"}`}><BookOpen size={16} className="mt-0.5 shrink-0" /><span className="min-w-0 flex-1 break-words">{row.paradigm.need}</span>{row.needs_review && <span aria-label="需要核对" title="需要核对" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-attention" />}</button>)}
        </section>)}{!components.length && <p className="px-3 py-8 text-sm text-muted-foreground">{!data ? "正在加载…" : query ? "没有匹配的知识" : "暂无组件知识"}</p>}</div>
      </aside>
      {item ? <article className="min-w-0" aria-label="组件知识详情">
        <header className="border-b border-line px-8 py-6">
          <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground"><span>{item.paradigm.component}</span><ChevronRight size={14} /><span>{knowledgeLanguageLabel(item.paradigm.language)}</span></div>
          <div className="flex items-start justify-between gap-6"><h3 className="text-2xl font-semibold leading-snug">{item.paradigm.title}</h3><div className="flex shrink-0 gap-1"><Button variant="ghost" onClick={() => correct(item)}>纠错</Button><Button variant="outline" onClick={() => { setSettings(true); setDialogError(""); }}><Settings2 size={16} />使用设置</Button></div></div>
          <div className="mt-4 flex flex-wrap gap-2">{item.paradigm.api.map(api => <code key={api} className="rounded-md bg-surface-2 px-2.5 py-1 text-sm">{api}</code>)}</div>
        </header>
        <div className="space-y-6 px-8 py-6">
          {item.needs_review && <p className="rounded-lg bg-attention/10 p-3 text-attention">这条知识有变更或纠错记录，需要重新核对。</p>}
          <section><h4 className="mb-2 font-semibold">适用条件</h4><p className="leading-relaxed">{item.paradigm.applicability}</p></section>
          <section aria-label="知识正文" className="min-w-0 overflow-x-auto">{documentError ? <div role="alert" className="text-danger">正文读取失败：{documentError}<Button variant="link" onClick={() => onAdopt(item.paradigm.document_id)}>打开源文档</Button></div> : !document ? <p className="text-muted-foreground">正在读取用法与示例…</p> : content ? <Markdown text={content} /> : <p className="text-muted-foreground">本条知识暂无可展示的正文。</p>}</section>
          <details className="border-t border-line pt-4"><summary className="cursor-pointer font-medium">代码检查 · {rules.length} 项</summary><div className="mt-4 flex items-center justify-between gap-3"><span>当前检查只提供提示，不拦截提交。</span><Button variant="outline" onClick={() => { setSettings(true); setDialogError(""); }}>查看检查与结果</Button></div><Button className="mt-3" variant="link" onClick={() => setArtifacts(item.id)}>查看程序化产物</Button></details>
          <details className="border-t border-line pt-4"><summary className="cursor-pointer font-medium">来源依据</summary><div className="mt-4 space-y-3">{item.paradigm.evidence.map((e, i) => <p key={i} className="break-all text-sm">{e.repository_id} / {e.path}:{e.start}–{e.end}<br /><span className="text-muted-foreground">版本 {e.revision}</span></p>)}{item.paradigm.usage_evidence.map((e, i) => <p className="break-words text-sm" key={i}>{e}</p>)}<Button variant="outline" onClick={() => onAdopt(item.paradigm.document_id)}>打开源文档</Button></div></details>
          {!!item.feedback.length && <details className="border-t border-line pt-4"><summary className="cursor-pointer font-medium">纠错记录 · {item.feedback.length}</summary>{item.feedback.map(f => <p key={f.id} className="mt-3 leading-relaxed"><strong>{feedbackLabels[f.kind]}</strong> · {f.operator}<br />{f.reason}</p>)}</details>}
        </div>
      </article> : <div className="flex min-h-[620px] flex-col items-center justify-center gap-5 p-10 text-center"><BookOpen size={36} className="text-muted-foreground" /><h3 className="text-lg font-medium">{!data ? "正在读取组件知识" : query ? "换个关键词试试" : "从基础组件开始积累知识"}</h3>{data && !query && <Button onClick={() => setResearch("new")}>萃取知识</Button>}</div>}
    </div>

    <ComponentKnowledgeArtifacts id={open ? artifacts : ""} onClose={() => setArtifacts("")} />
    <Dialog open={!!research && open} onOpenChange={value => { if (!value) closeResearch(); }}><DialogContent className="tw-root w-[94vw] max-w-none sm:max-w-none max-h-[92vh] overflow-auto"><DialogHeader><DialogTitle>萃取知识</DialogTitle></DialogHeader><ComponentResearch open={!!research && open} focusId={research} compact onClose={closeResearch} onAdopt={id => { setAdopted(id); setQuery(""); closeResearch(); }} /></DialogContent></Dialog>

    <Dialog open={settings && open} onOpenChange={value => { if (!busy) { setSettings(value); setDialogError(""); } }}><DialogContent className="tw-root sm:max-w-[760px] max-h-[85vh] overflow-auto"><DialogHeader><DialogTitle>使用设置 · {item?.paradigm.component}</DialogTitle></DialogHeader>
      {dialogError && !edit && !feedbackItem && <p role="alert" className="text-danger">{dialogError}</p>}
      {item && <>
        <section className="space-y-3"><div className="flex items-center justify-between"><h3 className="font-semibold">代码检查</h3><span className="rounded bg-surface-2 px-3 py-1 text-sm">不拦截提交</span></div>
          {!rules.length && <p className="rounded-lg border border-line p-4 text-muted-foreground">这条知识尚无可执行的代码检查。</p>}
          {rules.map(rule => <details key={rule.id} className="rounded-lg border border-line p-4"><summary className="cursor-pointer"><span className="font-medium">检查 {rule.original}</span><span className="ml-3 text-sm text-muted-foreground">{stateLabel(rule)}</span></summary><div className="mt-4 space-y-4">
            <p className="text-sm leading-relaxed">匹配到这类写法时，提示核对是否适合使用 {rule.paradigm.api.join("、")}。当前检查不判断调用顺序、参数或生命周期是否正确。</p>
            <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => openPolicy(rule)}>设置检查</Button><Button size="sm" variant="ghost" onClick={() => setArtifacts(rule.id)}>查看程序化产物</Button><Button size="sm" variant="ghost" onClick={() => correct(rule)}>报告检查问题</Button><Button size="sm" variant="ghost" disabled={busy || data?.challenges.some(c => c.challenge.item_id === rule.id && ["queued", "running"].includes(c.status))} onClick={() => void action(() => componentRequest(`/component-knowledge/${rule.id}/challenge`, { source_digest: rule.source_digest }), "已开始核对不适用的场景")}>核对例外</Button></div>
            {rule.samples.map(s => <div key={s.id} className="rounded-lg bg-surface-2 p-3"><p className="break-all text-sm">{s.path}:{s.line}</p>{[...rule.feedback].reverse().find(f => f.observation_id === s.id && ["useful", "false_positive"].includes(f.kind))?.kind === "false_positive" && <p className="mt-2 text-sm text-primary">已记录为合法例外</p>}<pre className="my-3 overflow-x-auto whitespace-pre-wrap break-words text-sm">{s.context}</pre><Button size="sm" variant="outline" onClick={() => correct(rule, s.id)}>这处提示有误</Button></div>)}
            {!rule.samples.length && <p className="text-sm text-muted-foreground">尚无检查结果</p>}
            {data?.challenges.filter(c => c.challenge.item_id === rule.id).map(c => <details key={c.id}><summary className="cursor-pointer">{c.stage}{c.challenge.source_digest !== rule.source_digest ? "（旧版本）" : ""}</summary>{c.error && <p className="text-danger">{c.error}</p>}{c.draft && <Markdown text={c.draft} />}{["queued", "running"].includes(c.status) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(() => componentRequest(`/component-research/${c.id}/stop`, {}), "核对已停止")}>停止核对</Button>}</details>)}
            {!!rule.feedback.length && <details><summary className="cursor-pointer">检查纠错记录</summary>{rule.feedback.map(f => <p key={f.id} className="mt-2 text-sm">{feedbackLabels[f.kind]}：{f.reason}</p>)}</details>}
          </div></details>)}
          {!!rules.length && <details className="pt-2"><summary className="cursor-pointer text-sm">在已有代码中试查</summary><div className="mt-3 flex gap-3"><select className={`${field} min-w-0 flex-1`} aria-label="消费方代码" value={task} onChange={e => setTask(e.target.value)}><option value="">选择需求任务</option>{tasks.map(t => <option key={t.id} value={t.id}>{t.title || t.id}</option>)}</select><Button disabled={!task || busy} variant="outline" onClick={() => void action(async () => { const r = await componentRequest<{ status: string; warnings: string[] }>("/component-knowledge/sample", { task_id: task }); if (r.status === "incomplete") throw new Error(r.warnings.join("；") || "检查未完成"); if (r.status === "not_applicable") throw new Error("该任务没有适用的组件检查"); }, "代码检查已完成")}>开始检查</Button></div></details>}
        </section>
      </>}
    </DialogContent></Dialog>

    <Dialog open={!!edit && open} onOpenChange={value => { if (!value && !busy) setEditId(""); }}><DialogContent className="tw-root sm:max-w-[500px]"><DialogHeader><DialogTitle>{edit ? `检查 ${edit.original}` : "检查设置"}</DialogTitle></DialogHeader>
      {dialogError && <p role="alert" className="text-danger">{dialogError}</p>}
      <div className="grid gap-4"><label className="grid gap-2">使用状态<select className={field} aria-label="使用状态" value={level} onChange={e => setLevel(e.target.value as ComponentPolicyLevel)}><option value="shadow">仅记录</option><option value="warning">记录并提示</option><option value="off">不检查</option></select></label>
        <label className="grid gap-2">负责人<Input aria-label="组件负责人" value={owner} onChange={e => setOwner(e.target.value)} placeholder="开启时必填" /></label>
        {edit?.kind === "rule" && <label className="grid gap-2">检查路径<Textarea aria-label="适用路径" value={scope} onChange={e => setScope(e.target.value)} placeholder="如 src/**，留空为全部" rows={2} /></label>}
        <label className="grid gap-2">变更原因<Textarea aria-label="策略变更理由" value={reason} onChange={e => setReason(e.target.value)} rows={2} /></label>
        <div className="flex justify-end gap-2"><Button disabled={busy} variant="ghost" onClick={() => setEditId("")}>取消</Button><Button disabled={busy || !reason.trim() || (level === "warning" && !owner.trim())} onClick={() => edit && void action(() => componentRequest(`/component-knowledge/${edit.id}/policy`, { revision: policySnapshot.revision, source_digest: policySnapshot.digest, level, owner, reason, scope: scope.split("\n").map(s => s.trim()).filter(Boolean) }), "使用设置已保存", () => setEditId(""))}>保存</Button></div>
      </div>
    </DialogContent></Dialog>

    <Dialog open={!!feedbackItem && open} onOpenChange={value => { if (!value && !busy) setFeedbackId(""); }}><DialogContent className="tw-root sm:max-w-[540px]"><DialogHeader><DialogTitle>{sampleId ? "纠正这处提示" : "纠正知识"}</DialogTitle></DialogHeader>
      {dialogError && <p role="alert" className="text-danger">{dialogError}</p>}
      <select aria-label="反馈类型" className={field} value={feedback} onChange={e => setFeedback(e.target.value as ComponentFeedback["kind"])}>{Object.entries(feedbackLabels).filter(([key]) => sampleId || !["useful", "false_positive"].includes(key)).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
      <Textarea aria-label="反馈依据" placeholder="哪里不对？请附上代码位置或正确用法。" rows={5} value={note} onChange={e => setNote(e.target.value)} />
      <div className="flex justify-end gap-2"><Button variant="ghost" disabled={busy} onClick={() => setFeedbackId("")}>取消</Button><Button disabled={busy || !note.trim()} onClick={() => feedbackItem && void action(() => componentRequest(`/component-knowledge/${feedbackItem.id}/feedback`, { source_digest: feedbackDigest, kind: feedback, reason: note, observation_id: sampleId || undefined }), "纠错已记录，使用设置未改变", () => setFeedbackId(""))}>提交纠错</Button></div>
    </DialogContent></Dialog>
  </section>;
}
