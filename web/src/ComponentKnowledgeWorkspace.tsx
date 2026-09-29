import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ComponentResearch } from "./ComponentResearch";
import { componentRequest } from "./componentResearchApi";
import { listTasks, type TaskSummary } from "./api";
import { Markdown } from "./markdown";
import type { ComponentPolicyLevel, ComponentFeedback, ComponentGovernanceSnapshot } from "../../src/componentKnowledgeTypes";

type Snapshot = ComponentGovernanceSnapshot;
const levels = { shadow: "候选 · 只记录", warning: "已启用提示", off: "已停用" };
const feedbackLabels = { useful: "建议适用", false_positive: "合理例外 / 误报", counterexample: "发现反例", quality_ok: "抽查正确", quality_error: "源知识有误" };
const field = "rounded-md border border-line bg-surface px-3 py-2 text-sm";

export function ComponentKnowledgeWorkspace({ open, focusId, onClose, onAdopt }: {
  open: boolean; focusId?: string; onClose: () => void; onAdopt: (id: string) => void;
}) {
  const [tab, setTab] = useState<"rule" | "mapping" | "quality" | "research">(focusId ? "research" : "rule");
  const [data, setData] = useState<Snapshot>(), [error, setError] = useState(""), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const [selected, setSelected] = useState(""), [query, setQuery] = useState(""), [filter, setFilter] = useState("all");
  const [tasks, setTasks] = useState<TaskSummary[]>([]), [task, setTask] = useState("");
  const [quality, setQuality] = useState<string[]>();
  const [level, setLevel] = useState<ComponentPolicyLevel>("shadow"), [owner, setOwner] = useState(""), [scope, setScope] = useState(""), [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState<ComponentFeedback["kind"]>("counterexample"), [note, setNote] = useState(""), [sampleId, setSampleId] = useState("");
  const item = data?.items.find(i => i.id === selected);
  async function refresh() { setData(await componentRequest<Snapshot>("/component-knowledge")); }
  useEffect(() => { if (focusId) setTab("research"); }, [focusId]);
  useEffect(() => {
    if (!open || tab === "research") return;
    let active = true;
    const load = () => componentRequest<Snapshot>("/component-knowledge").then(v => { if (active) setData(v); }).catch(e => { if (active) setError(e.message); });
    void load(); void listTasks().then(v => { if (active) setTasks(v.filter(t => t.repo_url || t.repositories?.length)); }).catch(() => {});
    const timer = setInterval(() => void load(), 10000); return () => { active = false; clearInterval(timer); };
  }, [open, tab]);
  useEffect(() => {
    setLevel(item?.policy.level ?? "shadow"); setOwner(item?.policy.owner ?? ""); setScope(item?.policy.scope.join("\n") ?? ""); setReason(""); setNote(""); setSampleId("");
  }, [item?.id, item?.source_digest, item?.policy.updated_at]);
  async function action(fn: () => Promise<unknown>, message: string) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); await refresh(); setNotice(message); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function sampleQuality() {
    const groups = new Map<string, string[]>();
    for (const row of data?.items.filter(i => i.kind === "mapping") ?? []) groups.set(row.paradigm.component, [...(groups.get(row.paradigm.component) ?? []), row.id]);
    const ids = [...groups.values()].flatMap(rows => {
      for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
      return rows.slice(0, 2);
    }); setQuality(ids); setSelected(ids[0] ?? "");
  }
  const rows = (data?.items ?? []).filter(i => i.kind === (tab === "rule" ? "rule" : "mapping") && (tab !== "quality" || !quality || quality.includes(i.id)))
    .filter(i => filter === "all" || (filter === "review" ? i.needs_review : i.policy.level === filter))
    .filter(i => `${i.paradigm.component} ${i.paradigm.need} ${i.paradigm.api.join(" ")} ${i.policy.owner}`.toLowerCase().includes(query.toLowerCase()));
  const challenges = data?.challenges.filter(c => c.challenge.item_id === item?.id) ?? [];
  return <section className="tw-root space-y-5" aria-label="组件知识工作台">
    <header className="flex items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">组件知识工作台</h2></div>
      <Button onClick={() => setTab("research")} variant="outline">萃取与修订</Button></header>
    <nav className="flex gap-2 border-b border-line pb-3" aria-label="组件知识视图">{([ ["rule", "替代规则"], ["mapping", "选型映射"], ["quality", "文档抽查"], ["research", "萃取记录"] ] as const).map(([id, label]) => <Button key={id} variant={tab === id ? "secondary" : "ghost"} onClick={() => { setTab(id); setSelected(""); }} aria-pressed={tab === id}>{label}</Button>)}</nav>
    {tab === "research" ? <ComponentResearch open={open} focusId={focusId} onClose={onClose} onAdopt={onAdopt} /> : <>
      {error && <p role="alert" className="text-danger">{error}</p>}{notice && <p role="status" className="text-primary">{notice}</p>}
      {data?.warnings.map((w, i) => <p key={i} className="text-attention">{w}</p>)}
      <div className="grid grid-cols-4 gap-3">{[["候选", data?.items.filter(i => i.policy.level === "shadow").length], ["已启用提示", data?.items.filter(i => i.policy.level === "warning").length], ["已停用", data?.items.filter(i => i.policy.level === "off").length], ["需要复查", data?.items.filter(i => i.needs_review).length]].map(([label, n]) => <div key={label} className="rounded-lg border border-line p-3"><p className="text-sm text-muted-foreground">{label}</p><strong className="text-2xl">{n ?? "—"}</strong></div>)}</div>
      <div className="flex flex-wrap gap-3"><Input className="max-w-sm" aria-label="查找组件知识" placeholder="搜索组件、需求、API 或负责人" value={query} onChange={e => setQuery(e.target.value)} />
        <select className={field} aria-label="启用状态" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部状态</option>{Object.entries(levels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}<option value="review">需要复查</option></select>
        <Button variant="outline" disabled={busy} onClick={() => void action(refresh, "已刷新当前策略与知识")}>刷新</Button>
        {tab === "quality" && <Button onClick={sampleQuality}>每个组件随机抽查 2 篇</Button>}</div>
      {tab === "rule" && <div className="flex items-center gap-3 rounded-lg bg-surface p-3"><label className="text-sm" htmlFor="component-sample-task">消费方代码</label><select id="component-sample-task" className={`${field} min-w-0 max-w-md flex-1`} value={task} onChange={e => setTask(e.target.value)}><option value="">选择已有代码工作区的需求任务</option>{tasks.map(t => <option key={t.id} value={t.id}>{t.title || t.id}</option>)}</select>
        <Button disabled={!task || busy} variant="outline" onClick={() => void action(async () => { const r = await componentRequest<{ status: string; warnings: string[] }>("/component-knowledge/sample", { task_id: task }); if (r.status === "incomplete") throw new Error(r.warnings.join("；") || "抽样未完成"); if (r.status === "not_applicable") throw new Error("该任务没有适用的组件规则"); }, "存量抽样已完成")}>抽取存量命中</Button></div>}
      <div className="grid grid-cols-[minmax(300px,0.9fr)_minmax(420px,1.3fr)] items-start gap-5">
        <div className="max-h-[680px] overflow-auto rounded-lg border border-line" aria-label="组件知识条目">
          {rows.map(row => <button key={row.id} onClick={() => setSelected(row.id)} className={`block w-full border-b border-line p-4 text-left last:border-0 ${selected === row.id ? "bg-primary/5" : "hover:bg-surface"}`}>
            <span className="text-xs text-muted-foreground">{row.paradigm.component} · {row.paradigm.language} · {levels[row.policy.level]}</span><strong className="mt-1 block">{row.paradigm.need}</strong>
            <span className="mt-1 block break-words text-sm">{row.kind === "rule" ? `${row.original ?? "原写法"} → ` : ""}{row.paradigm.api.join(" / ")}</span>
            <span className="mt-2 block text-xs text-muted-foreground">负责人：{row.policy.owner || "待指定"} · {row.stats.observed} 处观察</span>
            {row.needs_review && <span className="mt-2 block text-sm text-attention">需要复查：内容变化或收到具体反例</span>}
          </button>)}{!rows.length && <p className="p-6 text-sm text-muted-foreground">{data ? "暂无条目" : "正在读取组件知识…"}</p>}
        </div>
        {item ? <article key={item.id} className="min-w-0 space-y-5 rounded-lg border border-line p-5" aria-label="组件知识详情">
          <header><h3 className="font-semibold">{item.paradigm.title}</h3><p className="mt-2 text-sm">适用条件：{item.paradigm.applicability}</p><Button variant="link" className="mt-2 px-0" onClick={() => onAdopt(item.paradigm.document_id)}>查看并修正源文档 · 第 {item.paradigm.start_line} 行</Button><p className="text-xs text-muted-foreground">{item.policy.reason} {item.policy.operator && `· ${item.policy.operator}`}</p></header>
          <section className="space-y-3 border-t border-line pt-4"><h4 className="font-medium">人工启用策略</h4>
            <div className="flex gap-2">{Object.entries(levels).map(([id, label]) => <Button key={id} size="sm" variant={level === id ? "secondary" : "outline"} aria-pressed={level === id} onClick={() => setLevel(id as ComponentPolicyLevel)}>{label}</Button>)}</div>
            <Input aria-label="组件负责人" placeholder="组件负责人（启用提示时必填）" value={owner} onChange={e => setOwner(e.target.value)} />
            <Textarea aria-label="适用路径" placeholder="适用路径，如 src/**（留空为全部）" rows={2} value={scope} onChange={e => setScope(e.target.value)} />
            <Textarea aria-label="策略变更理由" placeholder="变更理由" rows={2} value={reason} onChange={e => setReason(e.target.value)} />
            <Button disabled={busy || !reason.trim() || (level === "warning" && !owner.trim())} onClick={() => void action(() => componentRequest(`/component-knowledge/${item.id}/policy`, { revision: data!.revision, source_digest: item.source_digest, level, owner, reason, scope: scope.split("\n").map(s => s.trim()).filter(Boolean) }), "策略已保存")}>保存策略</Button>
          </section>
          <details className="border-t border-line pt-4" open><summary className="cursor-pointer font-medium">命中样本与反馈 · {item.stats.observed} 处 / 已判断 {item.stats.reviewed} 处</summary>
            <p className="mt-2 text-xs text-muted-foreground">误报率（已判断样本）：{item.stats.exemption_rate === null ? "尚无数据" : `${Math.round(item.stats.exemption_rate * 100)}%`}</p>
            {item.samples.map(s => <div key={s.id} className="mt-3 rounded border border-line p-3"><p className="break-all text-sm">{s.repository} · {s.path}:{s.line}</p><pre className="mt-2 overflow-auto whitespace-pre-wrap break-words text-xs">{s.context}</pre><Button size="sm" className="mt-2" variant={sampleId === s.id ? "secondary" : "outline"} onClick={() => { setSampleId(s.id); setFeedback("false_positive"); }}>针对这处反馈</Button></div>)}
            {!item.samples.length && <p className="mt-2 text-sm text-muted-foreground">暂无命中样本</p>}
            <div className="mt-4 space-y-2"><select aria-label="反馈类型" className={field} value={feedback} onChange={e => setFeedback(e.target.value as ComponentFeedback["kind"])}>{Object.entries(feedbackLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select>{sampleId && <Button variant="ghost" size="sm" onClick={() => setSampleId("")}>取消样本关联</Button>}<Textarea aria-label="反馈依据" placeholder="代码位置与反馈理由" value={note} onChange={e => setNote(e.target.value)} />
              <Button disabled={busy || !note.trim()} variant="outline" onClick={() => void action(() => componentRequest(`/component-knowledge/${item.id}/feedback`, { source_digest: item.source_digest, kind: feedback, reason: note, observation_id: sampleId || undefined }), "反馈已记录")}>记录反馈</Button></div>
            {item.feedback.map(f => <p key={f.id} className="mt-3 border-t border-line pt-2 text-sm"><strong>{feedbackLabels[f.kind]}</strong> · {f.operator}<br />{f.reason}</p>)}
          </details>
          <section className="border-t border-line pt-4"><div className="flex items-center justify-between gap-2"><h4 className="font-medium">独立反例研究</h4><Button size="sm" variant="outline" disabled={busy || challenges.some(c => ["queued", "running"].includes(c.status))} onClick={() => void action(() => componentRequest(`/component-knowledge/${item.id}/challenge`, { source_digest: item.source_digest }), "反例研究已启动")}>寻找合理反例</Button></div>
            {challenges.map(c => <details key={c.id} className="mt-3"><summary className="cursor-pointer text-sm">{c.stage}{c.challenge.source_digest !== item.source_digest ? "（旧知识版本）" : ""}</summary>{c.error && <p className="text-danger">{c.error}</p>}{c.draft && <Markdown text={c.draft} />}{["queued", "running"].includes(c.status) && <Button size="sm" variant="outline" onClick={() => void action(() => componentRequest(`/component-research/${c.id}/stop`, {}), "反例研究已停止，不影响开发任务")}>停止研究</Button>}</details>)}
          </section>
          <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">来源证据</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify({ id: item.id, source_digest: item.source_digest, evidence: item.paradigm.evidence, usage_evidence: item.paradigm.usage_evidence, ...("rule" in item ? { rule: item.rule } : {}) }, null, 2)}</pre></details>
        </article> : <div className="rounded-lg border border-dashed border-line p-8 text-muted-foreground">选择一个条目</div>}
      </div>
    </>}
  </section>;
}
