import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import type { CodeOrigin, DeliveryAnalysisReport, DeliveryAnalysisRow, OriginCounts } from "../../src/deliveryAnalyticsTypes";
import { aggregateDelivery, sumOrigins } from "../../src/deliveryAnalyticsSummary";

const categories: Array<{ key: CodeOrigin; label: string; color: string }> = [
  { key: "first", label: "首次提交保留", color: "#0d9488" },
  { key: "pipeline", label: "流水线修复", color: "#8b5cf6" },
  { key: "review", label: "检视意见修改", color: "#d97706" },
  { key: "other", label: "其他 / 混合 / 未归因", color: "#94a3b8" },
];
const num = (value: number) => value.toLocaleString("zh-CN");
const percent = (value: number | null) => value === null ? "—" : `${value.toFixed(1)}%`;
function Donut({ counts }: { counts: OriginCounts }) {
  const total = sumOrigins(counts);
  let offset = 0;
  return <div className="delivery-donut-wrap"><div className="delivery-donut">
    <svg viewBox="0 0 200 200" role="img" aria-label={`最终保留代码 ${total} 行，首次提交占比 ${percent(total ? counts.first / total * 100 : null)}`}>
      <circle cx="100" cy="100" r="78" fill="none" stroke="var(--line)" strokeWidth="22" />
      {categories.map(c => { const size = total ? counts[c.key] / total * 100 : 0, start = offset; offset += size;
        return <circle key={c.key} cx="100" cy="100" r="78" fill="none" stroke={c.color} strokeWidth="22" pathLength="100"
          style={{ strokeLinecap: "butt" }} strokeDasharray={`${size} ${100 - size}`} strokeDashoffset={-start} transform="rotate(-90 100 100)"><title>{c.label}：{num(counts[c.key])} 行</title></circle>; })}
    </svg><div className="delivery-donut-center"><strong>{percent(total ? counts.first / total * 100 : null)}</strong><span>首次提交保留占比</span></div>
  </div><div className="delivery-legend">{categories.map(c => <div key={c.key}><i style={{ background: c.color }} /><span>{c.label}</span><b>{num(counts[c.key])} 行</b><small>{percent(total ? counts[c.key] / total * 100 : null)}</small></div>)}</div></div>;
}
function Rework({ counts }: { counts: OriginCounts }) {
  const total = sumOrigins(counts);
  return <><div className="delivery-rework-total"><strong>{num(total)}</strong><span>行</span></div><div className="delivery-stacked">{categories.filter(c => c.key !== "first").map(c => <span key={c.key} title={`${c.label}：${num(counts[c.key])}`} style={{ background: c.color, width: `${total ? counts[c.key] / total * 100 : 0}%` }} />)}</div><div className="delivery-rework-legend">{categories.filter(c => c.key !== "first").map(c => <span key={c.key}><i style={{ background: c.color }} />{c.label}<b>{num(counts[c.key])}</b></span>)}</div></>;
}
function TaskMetricRow({ id, title, tasks, child, parent, onSelect }: { id: string; title: string; tasks: DeliveryAnalysisRow[]; child?: boolean; parent?: boolean; onSelect: (id: string) => void }) {
  const values = aggregateDelivery(tasks);
  return <tr className={child ? "delivery-child-row" : undefined}><td><button className="delivery-task-link" onClick={() => onSelect(id)}><b>{id}</b><span>{title}</span></button></td><td>{parent ? <>已合入子任务 {tasks.filter(t => t.merged).length}/{tasks.length}{tasks.some(t => !t.merged) && <small>含未合入暂计</small>}</> : tasks.every(t => t.merged) ? "已合入" : "进行中 · 暂计"}</td><td>{values.available ? `${num(values.total)} 行` : "—"}</td><td className="delivery-accent">{percent(values.firstPercent)}</td><td>{values.available ? `${num(sumOrigins(values.rework))} 行` : "—"}</td><td>{values.available}/{tasks.length}{!values.available && <small>待取证</small>}</td></tr>;
}
export function DeliveryAnalytics() {
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const [report, setReport] = useState<DeliveryAnalysisReport>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [repo, setRepo] = useState(""); const [module, setModule] = useState("");
  const [page, setPage] = useState(0);
  const [days, setDays] = useState("90"); const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(new URLSearchParams(location.search).get("deliveryTask"));
  async function refresh(retry = false) {
    setBusy(true); setError("");
    try { const response = await fetch(`/delivery-analytics${retry ? "?refresh=1" : ""}`); if (!response.ok) throw new Error(response.status === 401 ? "请先登录后查看交付分析" : "交付分析加载失败"); setReport(await response.json()); }
    catch (e) { setError(e instanceof Error ? e.message : "加载失败"); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);
  const rows = useMemo(() => (report?.rows ?? []).filter(row => (!repo || row.repo === repo) && (!module || row.modules.includes(module))
    && (!days || new Date(row.at).getTime() >= Date.now() - Number(days) * 86400000)
    && (!query || `${row.id} ${row.parent_id ?? ""} ${row.parent_title ?? ""} ${row.title}`.toLowerCase().includes(query.toLowerCase()))), [report, repo, module, days, query]);
  const merged = rows.filter(row => row.merged), summary = aggregateDelivery(merged);
  const groupRows = useMemo(() => { const groups = new Map<string, DeliveryAnalysisRow[]>(); for (const row of rows) { const key = row.parent_id ?? row.id; groups.set(key, [...(groups.get(key) ?? []), row]); } return [...groups]; }, [rows]);
  useEffect(() => setPage(0), [repo, module, days, query]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(groupRows.length / 10) - 1));
  const selectedParent = (report?.rows ?? []).some(row => row.parent_id === selected);
  const detailRows = (report?.rows ?? []).filter(row => row.id === selected || row.parent_id === selected && rows.some(r => r.id === row.id));
  const detail = aggregateDelivery(detailRows);
  return <div className="delivery-analysis">
    <div className="delivery-toolbar"><div className="delivery-tabs"><strong>需求交付</strong><span title="后续接入问题单分析">问题处理 · 待开放</span></div><Button variant="outline" onClick={() => void refresh(true)} disabled={busy}><RefreshCw className={busy ? "animate-spin" : ""} />{busy ? "正在读取" : "刷新数据"}</Button></div>
    <div className="delivery-filters"><label>时间<select value={days} onChange={e => setDays(e.target.value)}><option value="30">近 30 天</option><option value="90">近 90 天</option><option value="">全部时间</option></select></label><label>代码仓<select value={repo} onChange={e => setRepo(e.target.value)}><option value="">全部代码仓</option>{[...new Set(report?.rows.map(r => r.repo).filter(Boolean))].map(r => <option key={r}>{r}</option>)}</select></label><label>业务模块<select value={module} onChange={e => setModule(e.target.value)}><option value="">全部模块</option>{[...new Set(report?.rows.flatMap(r => r.modules))].map(m => <option key={m}>{m}</option>)}</select></label><input aria-label="搜索任务" placeholder="搜索 task ID 或需求名称" value={query} onChange={e => setQuery(e.target.value)} /></div>
    {error && <p role="alert" className="delivery-error">{error}</p>}
    <div className="delivery-scope"><BarChart3 size={18} /><span>团队汇总仅计已合入交付 · {summary.available} / {merged.length} 个交付任务有统计证据 · 仅统计实际交付任务，主任务不重复计数</span></div>
    <div className="delivery-top-grid"><section className="delivery-card"><h2>最终代码来源 <span>{num(summary.total)} 行</span></h2><Donut counts={summary.retained} /><p className="delivery-muted">以最终交付差异中的新增/修改行为分母，追溯最后修改它的提交。最终差异删除行另计 {num(summary.deleted)} 行。</p></section><section className="delivery-card"><h2>累计修改行数</h2><Rework counts={summary.rework} /></section></div>
    <section className="delivery-card"><h2>任务明细 <span>点击查看代码来源、修改量与提交记录</span></h2><div className="delivery-table-scroll"><table><thead><tr><th>需求 / 任务</th><th>状态</th><th>最终代码</th><th>首次保留</th><th>累计修改行数</th><th>统计覆盖</th></tr></thead><tbody>{groupRows.slice(currentPage * 10, currentPage * 10 + 10).map(([id, tasks]) => {
      const parent = tasks.some(t => t.parent_id === id);
      return <Fragment key={id}>{parent && <TaskMetricRow id={id} title={`${tasks[0].parent_title ?? "主任务"} · 子任务汇总`} tasks={tasks} parent onSelect={setSelected} />}{tasks.map(row => <TaskMetricRow key={row.id} id={row.id} title={row.title} tasks={[row]} onSelect={setSelected} child={parent} />)}</Fragment>;
    })}</tbody></table></div>{groupRows.length > 10 && <div className="delivery-pagination"><span>第 {currentPage + 1} / {Math.ceil(groupRows.length / 10)} 页</span><Button variant="outline" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</Button><Button variant="outline" disabled={(currentPage + 1) * 10 >= groupRows.length} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>}{!rows.length && <p className="delivery-empty">{busy ? "正在读取交付记录…" : "当前条件下没有需求任务"}</p>}</section>
    <details className="delivery-method"><summary>统计口径与数据边界</summary><p>首次提交是任务基线之后的第一个非合并提交，不是第一次推送。仅统计源码、测试及脚本；文档、配置、锁文件、常见生成目录和二进制不进入代码分母。首次提交只含文档时，保留代码可以为零。</p><p>流水线 / 检视归因来自宿主实际修复轮次及前后提交范围。混合修改、外来提交和缺失证据归“其他”；不会分析提交标题猜测原因。历史改写或缺少合入前快照时，该任务暂不纳入汇总。合并提交不计入返工量（避免把上游改动当作返工），其中的冲突解决目前不计入行；纯重命名不算返工，修改一行按删除旧行 + 新增新行计 2 行。</p><p>这不是代码质量评分；不同任务规模与范围不同。覆盖不足时请结合任务明细解读统计。采集在推送后后台进行，稍后刷新可查看结果，不阻塞开发交付。</p></details>
    <Sheet open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }}><SheetContent initialFocus={detailTitle} className="delivery-detail-sheet bg-(--surface) gap-0 data-[side=right]:w-[min(760px,58vw)] data-[side=right]:sm:max-w-[min(760px,58vw)]"><SheetHeader><SheetTitle ref={detailTitle} tabIndex={-1}>{selected} · {selectedParent ? "子任务汇总" : "交付分析"}</SheetTitle><SheetDescription>{selectedParent ? `${detailRows[0]?.parent_title ?? "主任务"} · 当前筛选范围内 ${detailRows.length} 个子任务` : detailRows[0]?.title ?? "交付记录"}</SheetDescription></SheetHeader><div className="delivery-detail-body">{!detailRows.length ? <p>未找到该任务的交付记录。</p> : <><p className="delivery-scope">{selectedParent ? `已合入子任务 ${detailRows.filter(r => r.merged).length}/${detailRows.length}${detailRows.some(r => !r.merged) ? " · 含未合入暂计" : ""}` : detailRows.every(r => r.merged) ? "已合入" : "进行中，以下为最近推送版本的暂计数据"} · 证据覆盖 {detail.available}/{detail.tasks}</p><section className="delivery-card"><h2>最终代码来源</h2><Donut counts={detail.retained} /></section><section className="delivery-card"><h2>累计修改行数</h2><Rework counts={detail.rework} /></section>{detailRows.map(row => <section className="delivery-card" key={row.id}><div className="delivery-detail-heading"><h2>{row.id} · 提交记录</h2><a href={`/work/${encodeURIComponent(row.id)}`} target="_blank" rel="noreferrer">工作台 <ExternalLink size={14} /></a>{row.mr_url && <a href={row.mr_url} target="_blank" rel="noreferrer">MR <ExternalLink size={14} /></a>}</div>{row.unavailable && <p className="delivery-note">{row.unavailable}</p>}{row.metric && <><p className="delivery-muted">比较 {row.metric.base.slice(0, 8)} → {row.metric.head.slice(0, 8)} · 排除 {row.metric.excluded_files} 个非代码文本文件</p><ol className="delivery-timeline">{row.metric.commits.map(c => <li key={c.sha}><i style={{ background: categories.find(k => k.key === c.origin)?.color }} /><div><strong>{categories.find(k => k.key === c.origin)?.label}</strong><span className="delivery-commit-size">+{num(c.additions)} / −{num(c.deletions)}</span><p>{c.subject}</p>{c.origin_evidence?.length ? <details><summary>分类依据</summary>{c.origin_evidence.map((text, index) => <p key={index}>{text}</p>)}</details> : null}<small>{c.sha.slice(0, 10)} · {new Date(c.at).toLocaleString("zh-CN")}</small></div></li>)}</ol></>}</section>)}</>}</div></SheetContent></Sheet>
  </div>;
}
