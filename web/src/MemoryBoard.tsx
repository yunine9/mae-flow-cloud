/** 经验沉淀的唯一审查入口：候选留档、人工采纳与使用足迹集中展示。 */
import { useEffect, useMemo, useState } from "react";
import { getMemoryInsights, readMemoryInsight, type MemoryInsights, type MemoryRecord } from "./api";
import { memoryPreparation, memorySearchPresentation } from "./memoryPresentation";
import { MemoryReviewEditor } from "./MemoryReviewEditor";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

const scopes = { local: "本仓相关位置", general: "本仓通用", platform: "跨仓通用", one_off: "仅检索参考" };
export function MemoryBoard({ onOpenTask }: { onOpenTask?: (taskId: string) => void }) {
  const [insights, setInsights] = useState<MemoryInsights>();
  const [error, setError] = useState("");
  const [tab, setTab] = useState("pending");
  const [query, setQuery] = useState("");
  const [sourceTask, setSourceTask] = useState(() => new URLSearchParams(location.search).get("source_task") ?? "");
  const [selected, setSelected] = useState<{ record: MemoryRecord; content: string }>();
  const [dirty, setDirty] = useState(false);
  const [opening, setOpening] = useState(false);
  const [page, setPage] = useState(0);
  async function load() { setInsights(await getMemoryInsights()); setError(""); }
  useEffect(() => {
    let alive = true;
    const refresh = () => getMemoryInsights().then(value => { if (alive) { setInsights(value); setError(""); } })
      .catch(reason => { if (alive) setError(String(reason)); });
    void refresh(); const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 15_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  const rows = useMemo(() => (insights?.memories ?? []).filter(row => (tab === "all" || (!row.withdrawn && !row.superseded_by && !row.archived))
    && (!sourceTask || row.task === sourceTask)
    && (tab === "all" || (row.review?.status ?? "pending") === tab)
    && (tab !== "pending" || row.can_review)
    && (!query.trim() || `${row.trigger} ${row.conclusion} ${row.repo}`.includes(query.trim()))), [insights, sourceTask, tab, query]);
  const pending = (insights?.memories ?? []).filter(row => row.can_review && !row.withdrawn && !row.superseded_by && !row.archived && (row.review?.status ?? "pending") === "pending").length;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 10) - 1));
  function dismiss() { if (!dirty || window.confirm("尚未采纳的编辑将被放弃，继续吗？")) { setSelected(undefined); setDirty(false); } }
  async function open(id: string) {
    if (opening) return;
    setOpening(true); setError("");
    try { const value = await readMemoryInsight(id); if (!value) throw new Error("记录已不可用，请刷新"); setSelected(value); setDirty(false); }
    catch (reason) { setError(String(reason)); } finally { setOpening(false); }
  }
  return <section className="grid gap-4 rounded-xl border border-border bg-surface p-5" aria-label="经验沉淀">
    <header className="flex items-start justify-between gap-4">
      <div><h2 className="text-xl font-semibold">{selected ? "审查经验候选" : "经验沉淀"}</h2>
        <p className="mt-1 text-sm text-muted-foreground">Agent 自动整理，人在这里集中确认。采纳后按范围复用，不影响原任务继续。</p></div>
      {selected ? <Button variant="outline" onClick={dismiss}>返回候选列表</Button>
        : <Button variant="outline" onClick={() => void load().catch(reason => setError(String(reason)))}>刷新</Button>}
    </header>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {selected ? <>
      <div className="flex items-center justify-between rounded-md bg-muted p-3 text-sm"><span>{selected.record.trigger} · {memoryPreparation(selected.record).label}</span>
        <Button variant="outline" size="sm" onClick={() => { if (onOpenTask) onOpenTask(selected.record.task); else location.assign(`/work/${encodeURIComponent(selected.record.task)}`); }}>查看来源任务 {selected.record.task}</Button></div>
      <div className="grid grid-cols-[220px_minmax(0,1fr)] items-start gap-4">
      <aside className="grid max-h-[650px] gap-2 overflow-auto rounded-xl border border-border bg-muted/30 p-3" aria-label="经验候选列表">
        <h3 className="p-2 font-semibold">{tab === "pending" ? `待我确认 · ${pending}` : "经验列表"}</h3>
        {rows.map(row => <Button key={row.id} variant={row.id === selected.record.id ? "secondary" : "ghost"}
          className="h-auto min-h-16 justify-start whitespace-normal p-3 text-left" disabled={opening}
          onClick={() => { if (row.id !== selected.record.id && (!dirty || window.confirm("切换候选将放弃尚未采纳的编辑，继续吗？"))) void open(row.id); }}>
          <span><span className="line-clamp-2">{row.trigger}</span><span className="mt-1 block text-sm font-normal text-muted-foreground">{row.task} · {row.repo}</span></span>
        </Button>)}
      </aside>
      <MemoryReviewEditor key={`${selected.record.id}:${selected.record.revision ?? 1}`} taskId={selected.record.task} record={selected.record}
        onDirty={setDirty} onDismiss={dismiss} onChanged={async () => { await load(); setSelected(undefined); }} />
      </div>
      <details className="text-sm"><summary className="cursor-pointer">完整留档与来源标识</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3">{selected.content}</pre></details>
    </> : <>
      <div className="flex items-center gap-2" aria-label="经验状态">
        {[["pending", `待我确认 ${pending}`], ["accepted", "已采纳"], ["rejected", "不采纳"], ["all", "全部记录"]].map(([value, label]) =>
          <Button key={value} variant={tab === value ? "default" : "outline"} size="sm" onClick={() => { setTab(value); setPage(0); }}>{label}</Button>)}
      </div>
      <div className="flex items-center gap-3"><Input className="max-w-lg" aria-label="搜索经验" placeholder="搜索经验、代码仓" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
        {sourceTask && <Button variant="outline" size="sm" onClick={() => { setSourceTask(""); setPage(0); const url = new URL(location.href); url.searchParams.delete("source_task"); history.replaceState(history.state, "", url); }}>{sourceTask} · 清除来源筛选</Button>}
        <span className="ml-auto text-sm text-muted-foreground">{memorySearchPresentation(insights?.sidecar).label}</span></div>
      <div className="grid gap-2">{rows.slice(currentPage * 10, (currentPage + 1) * 10).map(row => <article key={row.id} className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
        <div className="min-w-0"><h3 className="text-base font-medium">{row.trigger}</h3><p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{row.conclusion}</p>
          <p className="mt-2 text-sm text-muted-foreground">{row.task} · {row.repo} · {scopes[row.scope]} · {row.archived ? "已归档" : row.withdrawn || row.superseded_by ? "已撤回" : memoryPreparation(row).label}</p>
          {row.review?.status === "accepted" && <p className="mt-1 text-sm text-muted-foreground">已提供 {row.pushes} 次 · 检索/展开 {row.hits} 次；这些数字不代表质量提升</p>}</div>
        <Button variant="outline" className="shrink-0" disabled={opening} onClick={() => void open(row.id)}>{row.can_review && !row.archived && !row.withdrawn && !row.superseded_by && row.review?.status !== "accepted" ? "查看并审查" : "查看经验"}</Button>
      </article>)}</div>
      {!rows.length && <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">{!insights ? "正在加载…" : "当前没有符合条件的记录"}</p>}
      {rows.length > 10 && <div className="flex items-center justify-end gap-3 text-sm"><Button variant="outline" size="sm" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</Button>
        {currentPage + 1} / {Math.ceil(rows.length / 10)}<Button variant="outline" size="sm" disabled={(currentPage + 1) * 10 >= rows.length} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>}
    </>}
  </section>;
}
