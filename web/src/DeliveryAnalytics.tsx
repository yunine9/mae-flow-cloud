import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { knowledgeLanguageLabel } from "../../src/knowledgeLanguages";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import type { CodeOrigin, DeliveryAnalysisReport, DeliveryAnalysisRow, DeliveryTaskTokens, OriginCounts } from "../../src/deliveryAnalyticsTypes";
import { aggregateDelivery, aggregateDeliveryModules, aggregateDeliveryTokens, sumOrigins } from "../../src/deliveryAnalyticsSummary";
import { getIssueOnceGenerated, type IssueOnceGenerated, type IssueOnceGeneratedSessionRow } from "./api";
import { onceGeneratedFeatureRows, type OnceGeneratedFeatureRow } from "./teamOps";
import { IssueCodeOriginPanel } from "./issues/CodeOriginPanel";

const categories: Array<{ key: CodeOrigin; label: string; color: string }> = [
  { key: "first", label: "首次实现", color: "#0d9488" },
  { key: "pipeline", label: "流水线修复", color: "#8b5cf6" },
  { key: "review", label: "检视意见修改", color: "#d97706" },
];
const num = (value: number) => value.toLocaleString("zh-CN");
const percent = (value: number | null) => value === null ? "—" : `${value.toFixed(1)}%`;
function AnalysisFilter({ label, value, onChange, items }: {
  label: string; value: string; onChange: (value: string) => void;
  items: Array<{ value: string; label: string }>;
}) {
  return <div className="flex min-w-0 items-center gap-2"><span>{label}</span>
    <Select value={value} onValueChange={next => { if (next !== null) onChange(next); }} items={items}>
      <SelectTrigger aria-label={label} className="min-w-36 max-w-72"><SelectValue /></SelectTrigger>
      <SelectContent>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
    </Select>
  </div>;
}
function Donut({ counts }: { counts: OriginCounts }) {
  const total = sumOrigins(counts);
  let offset = 0;
  return <div className="delivery-donut-wrap"><div className="delivery-donut">
    <svg viewBox="0 0 200 200" role="img" aria-label={`交付代码行数 ${total} 行，首次实现占比 ${percent(total ? counts.first / total * 100 : null)}`}>
      <circle cx="100" cy="100" r="78" fill="none" stroke="var(--line)" strokeWidth="22" />
      {categories.map(c => { const size = total ? counts[c.key] / total * 100 : 0, start = offset; offset += size;
        return <circle key={c.key} cx="100" cy="100" r="78" fill="none" stroke={c.color} strokeWidth="22" pathLength="100"
          style={{ strokeLinecap: "butt" }} strokeDasharray={`${size} ${100 - size}`} strokeDashoffset={-start} transform="rotate(-90 100 100)"><title>{c.label}：{num(counts[c.key])} 行</title></circle>; })}
    </svg><div className="delivery-donut-center"><strong>{percent(total ? counts.first / total * 100 : null)}</strong><span>首次实现占比</span></div>
  </div><div className="delivery-legend">{categories.map(c => <div key={c.key}><i style={{ background: c.color }} /><span>{c.label}</span><b>{num(counts[c.key])} 行</b><small>{percent(total ? counts[c.key] / total * 100 : null)}</small></div>)}</div></div>;
}
function TaskLanguages({ tasks }: { tasks: DeliveryAnalysisRow[] }) {
  const languages = [...new Set(tasks.flatMap(t => t.languages?.length ? t.languages : ["unknown"]))];
  return <span className="inline-flex flex-wrap gap-1.5" title="任务对应代码仓的技术栈">{languages.map(language =>
    <Badge key={language} variant="secondary" className="h-auto px-2 py-1 text-sm">{language === "unknown" ? "未标注" : knowledgeLanguageLabel(language)}</Badge>)}</span>;
}
function TaskMetricRow({ id, title, tasks, child, parent, onSelect, ledger }: { id: string; title: string; tasks: DeliveryAnalysisRow[]; child?: boolean; parent?: boolean; ledger?: DeliveryTaskTokens[]; onSelect: (id: string) => void }) {
  const values = aggregateDelivery(tasks);
  const tokens = aggregateDeliveryTokens(tasks.map(t => t.id), ledger, parent ? id : undefined);
  return <tr className={child ? "delivery-child-row" : undefined}><td><button className="delivery-task-link" onClick={() => onSelect(id)}><b>{id}</b><span>{title}</span></button></td><td><TaskLanguages tasks={tasks} /></td><td>{parent ? <>已合入子任务 {tasks.filter(t => t.merged).length}/{tasks.length}{tasks.some(t => !t.merged) && <small>含未合入暂计</small>}</> : tasks.every(t => t.merged) ? "已合入" : "进行中 · 暂计"}</td><td>{values.available ? `${num(values.total)} 行` : "—"}</td><td className="delivery-accent">{percent(values.firstPercent)}</td><td title={tokens.available ? `已记录输入 ${num(tokens.input)} · 输出 ${num(tokens.output)}` : "没有模型用量记录"}><strong>{tokens.available ? num(tokens.total) : "—"}</strong>{tokens.available < tokens.tasks && <small>{tokens.available ? "部分用量已记录" : "暂无用量记录"}</small>}</td><td>{values.available}/{tasks.length}{!values.available && <small>待取证</small>}</td></tr>;
}

/** 问题处理页签(ADR-0044,工单 #340):一次生成占比的每会话明细与
 *  特性聚合——读侧与团队问题页统计瓦片同一端点、同一数字;行点击
 *  下钻行归属证据(伴生快照原样)。纯呈现层,不建第二套口径。
 *  导出仅供视觉走查场景脚本挂载(与需求侧同款做法)。 */
export function IssueAnalyticsTab() {
  const [stats, setStats] = useState<IssueOnceGenerated>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [module, setModule] = useState("*");
  const [selected, setSelected] = useState<string | null>(null);
  const load = async () => {
    setBusy(true); setError("");
    try { setStats(await getIssueOnceGenerated()); }
    catch (e) { setError(e instanceof Error ? e.message : "加载失败"); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
  const rows = useMemo(() => (stats?.per_session ?? []).filter(row =>
    (module === "*" || row.module === module)
    && (!query || `${row.id} ${row.title} ${row.module}`.toLowerCase().includes(query.toLowerCase()))),
    [stats, module, query]);
  const features = useMemo(() => onceGeneratedFeatureRows(stats?.per_session ?? []), [stats]);
  const selectedRow = stats?.per_session.find(row => row.id === selected);
  const scopeTitle = stats
    ? `分母=有数据的完成交付会话(伴生快照在场且留存源码行>0):${stats.total} 个,其中 ${stats.passed} 个达标(单会话占比 ≥ ${stats.threshold_percent}%,线可配)。`
      + `占比=首轮生成且存活到合入的源码行 ÷ 全部留存源码行,返工行与平台外改的行都算 AI 没一次生成,多仓按行数加权。`
      + `${stats.pending} 个会话待算、${stats.unsupported} 个早于 ${stats.supported_since} 起算日不计入、${stats.no_code} 个无源码交付不计入。`
    : "";
  return <div className="grid gap-4">
    {error && <p role="alert" className="delivery-error">{error}</p>}
    <div className="delivery-scope" title={scopeTitle}><BarChart3 size={18} />
      <span>一次生成达标率 {percent(stats?.rate ?? null)} · 达标 {stats?.passed ?? 0}/{stats?.total ?? 0} 个有数据会话
        {stats ? <> · 待算 {stats.pending} · 不支持期 {stats.unsupported} 个不计入</> : null}</span>
      <small style={{ marginLeft: "auto" }}>口径与起算日期悬停查看</small>
    </div>
    <section className="delivery-card"><h2>特性聚合 <span>按业务模块标签归组,行数加权</span></h2>
      <div className="delivery-table-scroll"><table><thead><tr><th>特性</th><th>会话数</th><th>达标</th><th>会话达标率</th><th>一次生成占比(加权)</th><th>留存源码行</th></tr></thead>
        <tbody>{features.map((feature: OnceGeneratedFeatureRow) => <tr key={feature.module}>
          <td><button className="delivery-task-link" aria-pressed={module === feature.module}
            onClick={() => setModule(module === feature.module ? "*" : feature.module)}><b>{feature.module}</b></button></td>
          <td>{feature.sessions}</td><td>{feature.passed}</td>
          <td className="delivery-accent">{percent(feature.pass_rate)}</td>
          <td className="delivery-accent">{percent(feature.share)}</td>
          <td>{num(feature.total_lines)}</td>
        </tr>)}</tbody></table></div>
      {!features.length && <p className="delivery-empty">{busy ? "正在读取统计…" : "还没有有数据的完成交付会话"}</p>}
    </section>
    <section className="delivery-card"><h2>会话明细 <span>点击查看每仓行归属证据</span></h2>
      <div className="delivery-filters">
        <AnalysisFilter label="特性" value={module} onChange={setModule} items={[{ value: "*", label: "全部特性" },
          ...features.map(feature => ({ value: feature.module, label: feature.module }))]} />
        <Input aria-label="搜索会话" placeholder="搜索会话 ID、标题或特性" value={query} onChange={e => setQuery(e.target.value)} />
      </div>
      <div className="delivery-table-scroll"><table><thead><tr><th>会话</th><th>特性</th><th>一次生成占比</th><th>达标</th><th>首轮 / 返工 / 平台外(行)</th><th>收口时间</th></tr></thead>
        <tbody>{rows.map((row: IssueOnceGeneratedSessionRow) => <tr key={row.id}>
          <td><button className="delivery-task-link" onClick={() => setSelected(row.id)}><b>{row.id}</b><span>{row.title}</span></button></td>
          <td><button className="delivery-task-link" aria-pressed={module === row.module}
            onClick={() => setModule(module === row.module ? "*" : row.module)}>{row.module}</button></td>
          <td className="delivery-accent">{percent(row.share)}</td>
          <td>{row.pass ? "达标" : "未达标"}</td>
          <td>{num(row.lines.first)} / {num(row.lines.rework)} / {num(row.lines.external)}</td>
          <td>{new Date(row.concluded_at).toLocaleDateString("zh-CN")}</td>
        </tr>)}</tbody></table></div>
      {!rows.length && <p className="delivery-empty">{busy ? "正在读取统计…" : "当前条件下没有会话"}</p>}
    </section>
    <Sheet open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }}>
      <SheetContent className="delivery-detail-sheet bg-(--surface) gap-0 data-[side=right]:w-[min(760px,58vw)] data-[side=right]:sm:max-w-[min(760px,58vw)]">
        <SheetHeader><SheetTitle>{selected} · 一次生成归属</SheetTitle>
          <SheetDescription>{selectedRow ? `${selectedRow.title} · 占比 ${percent(selectedRow.share)}` : "行归属证据"}</SheetDescription></SheetHeader>
        <div className="delivery-detail-body">{selected
          && <IssueCodeOriginPanel id={selected} threshold={stats?.threshold_percent} />}</div>
      </SheetContent>
    </Sheet>
  </div>;
}
export function DeliveryAnalytics() {
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const [tab, setTab] = useState<"requirement" | "issue">("requirement");
  const [report, setReport] = useState<DeliveryAnalysisReport>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [repo, setRepo] = useState(""); const [module, setModule] = useState("*");
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
  const rows = useMemo(() => (report?.rows ?? []).filter(row => (!repo || row.repo === repo) && (module === "*" || (row.business_module?.id ?? "") === module)
    && (!days || new Date(row.at).getTime() >= Date.now() - Number(days) * 86400000)
    && (!query || `${row.id} ${row.parent_id ?? ""} ${row.parent_title ?? ""} ${row.title}`.toLowerCase().includes(query.toLowerCase()))), [report, repo, module, days, query]);
  const merged = rows.filter(row => row.merged), summary = aggregateDelivery(merged);
  const moduleRows = useMemo(() => (report?.rows ?? []).filter(row => (!repo || row.repo === repo)
    && (!days || new Date(row.at).getTime() >= Date.now() - Number(days) * 86400000)
    && (!query || `${row.id} ${row.parent_id ?? ""} ${row.parent_title ?? ""} ${row.title}`.toLowerCase().includes(query.toLowerCase()))), [report, repo, days, query]);
  const moduleGroups = aggregateDeliveryModules(moduleRows);
  const groupRows = useMemo(() => { const groups = new Map<string, DeliveryAnalysisRow[]>(); for (const row of rows) { const key = row.parent_id ?? row.id; groups.set(key, [...(groups.get(key) ?? []), row]); } return [...groups]; }, [rows]);
  useEffect(() => setPage(0), [repo, module, days, query]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(groupRows.length / 10) - 1));
  const selectedParent = (report?.rows ?? []).some(row => row.parent_id === selected);
  const detailRows = (report?.rows ?? []).filter(row => row.id === selected || row.parent_id === selected && rows.some(r => r.id === row.id));
  const detail = aggregateDelivery(detailRows);
  const detailTokens = aggregateDeliveryTokens(detailRows.map(r => r.id), report?.task_tokens, selectedParent ? selected ?? undefined : undefined);
  return <div className="delivery-analysis">
    <div className="delivery-toolbar"><div className="delivery-tabs">
      {([["requirement", "需求交付"], ["issue", "问题处理"]] as const).map(([key, label]) =>
        tab === key
          ? <strong key={key}>{label}</strong>
          : <button key={key} type="button" className="text-sm text-muted-foreground transition-colors hover:text-text-strong" aria-pressed={false} onClick={() => setTab(key)}>{label}</button>)}
    </div><Button variant="outline" onClick={() => void refresh(true)} disabled={busy}><RefreshCw className={busy ? "animate-spin" : ""} />{busy ? "正在读取" : "刷新数据"}</Button></div>
    {tab === "requirement" && <>
    <div className="delivery-filters">
      <AnalysisFilter label="时间" value={days} onChange={setDays} items={[{value:"30",label:"近 30 天"},{value:"90",label:"近 90 天"},{value:"",label:"全部时间"}]} />
      <AnalysisFilter label="代码仓" value={repo} onChange={setRepo} items={[{value:"",label:"全部代码仓"}, ...[...new Set(report?.rows.map(r => r.repo).filter(Boolean))].map(r => ({value:r!,label:r!}))]} />
      <AnalysisFilter label="业务模块" value={module} onChange={setModule} items={[{value:"*",label:"全部模块"}, ...[...new Map((report?.rows ?? []).map(row => [row.business_module?.id ?? "", row.business_module?.name ?? "未关联模块"])).entries()].map(([value,label]) => ({value,label}))]} />
      <Input aria-label="搜索任务" placeholder="搜索 task ID 或需求名称" value={query} onChange={e => setQuery(e.target.value)} />
    </div>
    {error && <p role="alert" className="delivery-error">{error}</p>}
    <div className="delivery-scope"><BarChart3 size={18} /><span>团队汇总仅计已合入交付 · {summary.available} / {merged.length} 个交付任务有统计证据 · 仅统计实际交付任务，主任务不重复计数</span></div>
    <div className="delivery-overview-grid"><section className="delivery-card"><h2>交付代码来源 <span>交付代码行数：{num(summary.total)} 行</span></h2><Donut counts={summary.retained} /></section>
    <section className="delivery-card"><h2>业务模块交付占比 <span>已合入需求的交付代码行数</span></h2>
      <div className="delivery-module-bars">{moduleGroups.map(group => <button key={group.id} className="delivery-module-row" aria-pressed={module === group.id}
        onClick={() => { setModule(module === group.id ? "*" : group.id); setPage(0); }}>
        <span className="delivery-module-name">{group.name}</span><strong>{percent(group.percent)}</strong>
        <span className="delivery-module-track"><span style={{ width: `${group.percent}%` }} /></span><span>{num(group.lines)} 行</span>
      </button>)}</div>
      {!moduleGroups.length && <p className="delivery-empty">暂无已合入交付数据</p>}
    </section></div>
    <section className="delivery-card"><h2>任务明细 <span>点击查看代码来源、Token 消耗与提交记录</span></h2><div className="delivery-table-scroll"><table><thead><tr><th>需求 / 任务</th><th>语言</th><th>状态</th><th>交付代码行数</th><th>首次实现占比</th><th>Token 消耗</th><th>统计覆盖</th></tr></thead><tbody>{groupRows.slice(currentPage * 10, currentPage * 10 + 10).map(([id, tasks]) => {
      const parent = tasks.some(t => t.parent_id === id);
      return <Fragment key={id}>{parent && <TaskMetricRow id={id} title={`${tasks[0].parent_title ?? "主任务"} · 主任务汇总`} tasks={tasks} ledger={report?.task_tokens} parent onSelect={setSelected} />}{tasks.map(row => <TaskMetricRow key={row.id} id={row.id} title={row.title} tasks={[row]} ledger={report?.task_tokens} onSelect={setSelected} child={parent} />)}</Fragment>;
    })}</tbody></table></div>{groupRows.length > 10 && <div className="delivery-pagination"><span>第 {currentPage + 1} / {Math.ceil(groupRows.length / 10)} 页</span><Button variant="outline" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</Button><Button variant="outline" disabled={(currentPage + 1) * 10 >= groupRows.length} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>}{!rows.length && <p className="delivery-empty">{busy ? "正在读取交付记录…" : "当前条件下没有需求任务"}</p>}</section>
    <details className="delivery-method"><summary>统计口径与数据边界</summary><p>以最终交付差异中的新增/修改行为分母，追溯最后修改它的提交。最终差异删除行另计 {num(summary.deleted)} 行。</p><p>首次实现包含首次实际修复之前的多个提交；缺少记录时以第一条明确修复提交为界，没有修复迹象时暂按首轮实现统计。统计源码、测试、脚本及配置等交付文本；Markdown、二进制、依赖目录、构建产物和平台运行文件不计入。配置先提交也属于首轮实现。</p><p>流水线 / 检视归因来自宿主实际修复轮次及前后提交范围。能明确识别为流水线修复的归流水线，其余后续提交归检视修改；缺少记录时结合提交说明推断，并在分类依据中标明；已有明确分类不被推断覆盖。历史改写或缺少合入前快照时，该任务暂不纳入汇总。</p><p>Token 使用已有模型用量台账，输入与输出相加；主任务汇总包含自身分析及当前筛选范围的子任务，每个任务只计一次。不要求已推送或已有代码统计；没有上报的历史消耗显示暂无记录。</p><p>这不是代码质量评分；不同任务规模与范围不同。覆盖不足时请结合任务明细解读统计。采集在推送后后台进行，稍后刷新可查看结果，不阻塞开发交付。</p></details>
    <Sheet open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }}><SheetContent initialFocus={detailTitle} className="delivery-detail-sheet bg-(--surface) gap-0 data-[side=right]:w-[min(760px,58vw)] data-[side=right]:sm:max-w-[min(760px,58vw)]"><SheetHeader><SheetTitle ref={detailTitle} tabIndex={-1}>{selected} · {selectedParent ? "主任务汇总" : "交付分析"}</SheetTitle><SheetDescription>{selectedParent ? `${detailRows[0]?.parent_title ?? "主任务"} · 当前筛选范围内 ${detailRows.length} 个子任务` : detailRows[0]?.title ?? "交付记录"}</SheetDescription></SheetHeader><div className="delivery-detail-body">{!detailRows.length ? <p>未找到该任务的交付记录。</p> : <><TaskLanguages tasks={detailRows} /><p className="delivery-scope">{selectedParent ? `已合入子任务 ${detailRows.filter(r => r.merged).length}/${detailRows.length}${detailRows.some(r => !r.merged) ? " · 含未合入暂计" : ""}` : detailRows.every(r => r.merged) ? "已合入" : "进行中，以下为最近推送版本的暂计数据"} · 证据覆盖 {detail.available}/{detail.tasks}</p><section className="delivery-card"><h2>Token 消耗 <span>{selectedParent ? "含主任务自身及当前范围子任务" : "本任务累计用量"}</span></h2><div className="grid grid-cols-3 gap-4 py-4"><div>总计<strong className="block text-xl">{detailTokens.available ? num(detailTokens.total) : "—"}</strong></div><div>输入<strong className="block text-xl">{detailTokens.available ? num(detailTokens.input) : "—"}</strong></div><div>输出<strong className="block text-xl">{detailTokens.available ? num(detailTokens.output) : "—"}</strong></div></div>{detailTokens.available < detailTokens.tasks && <p className="delivery-muted">{detailTokens.available}/{detailTokens.tasks} 个任务有用量记录；未记录的历史消耗不估算。</p>}</section><section className="delivery-card"><h2>交付代码来源 <span>交付代码行数：{num(detail.total)} 行</span></h2><Donut counts={detail.retained} /></section>{detailRows.map(row => <section className="delivery-card" key={row.id}><div className="delivery-detail-heading"><h2>{row.id} · 提交记录</h2><a href={`/work/${encodeURIComponent(row.id)}`} target="_blank" rel="noreferrer">工作台 <ExternalLink size={14} /></a>{row.mr_url && <a href={row.mr_url} target="_blank" rel="noreferrer">MR <ExternalLink size={14} /></a>}</div>{row.unavailable && <p className="delivery-note">{row.unavailable}</p>}{row.metric && <><p className="delivery-muted">比较 {row.metric.base.slice(0, 8)} → {row.metric.head.slice(0, 8)} · 排除 {row.metric.excluded_files} 个非代码文本文件</p><ol className="delivery-timeline">{row.metric.commits.map(c => <li key={c.sha}><i style={{ background: categories.find(k => k.key === c.origin)?.color }} /><div><strong>{categories.find(k => k.key === c.origin)?.label}</strong><span className="delivery-commit-size">+{num(c.additions)} / −{num(c.deletions)}</span><p>{c.subject}</p>{c.origin_evidence?.length ? <details><summary>分类依据</summary>{c.origin_evidence.map((text, index) => <p key={index}>{text}</p>)}</details> : null}<small>{c.sha.slice(0, 10)} · {new Date(c.at).toLocaleString("zh-CN")}</small></div></li>)}</ol></>}</section>)}</>}</div></SheetContent></Sheet>
    </>}
    {tab === "issue" && <IssueAnalyticsTab />}
  </div>;
}
