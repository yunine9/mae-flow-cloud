import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, ExternalLink, HelpCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { knowledgeLanguageLabel } from "../../src/knowledgeLanguages";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import type { CodeOrigin, DeliveryAnalysisReport, DeliveryAnalysisRow, DeliveryTaskTokens, OriginCounts } from "../../src/deliveryAnalyticsTypes";
import { aggregateDelivery, aggregateDeliveryModules, aggregateDeliveryTokens, sumOrigins } from "../../src/deliveryAnalyticsSummary";
import { cn } from "cn";
import { getIssueOnceGenerated, type IssueOnceGenerated, type IssueOnceGeneratedRepoRow, type IssueOnceGeneratedSessionRow } from "./api";
import { getIssueRegistrationStats, type IssueRegistrationSessionRow, type IssueRegistrationStats } from "./api";
import { TicketTemplateCard } from "./issues/TicketTemplateCard";
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

function sumLines(stats: IssueOnceGenerated | undefined): { first: number; total: number } {
  let first = 0; let total = 0;
  for (const row of stats?.per_session ?? []) {
    first += row.lines?.first ?? 0;
    total += (row.lines?.first ?? 0) + (row.lines?.rework ?? 0)
      + (row.lines?.external ?? 0);
  }
  return { first, total };
}
function weightedShare(stats: IssueOnceGenerated | undefined): number | null {
  const { first, total } = sumLines(stats);
  return total ? Math.round((first / total) * 1000) / 10 : null;
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

/** DTS 页签(原「问题处理」,ADR-0044,工单 #340):首次生成占比的
 *  每会话明细与特性聚合——读侧与团队问题页统计瓦片同一端点、同一
 *  数字;行点击下钻行归属证据(伴生快照原样)。人群=有单交付会话;
 *  无单会话在「登记问题」页签(ADR-0048)。纯呈现层,不建第二套口径。
 *  导出仅供视觉走查场景脚本挂载(与需求侧同款做法)。 */
export function IssueAnalyticsTab() {
  const [stats, setStats] = useState<IssueOnceGenerated>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState("");
  const [module, setModule] = useState("*");
  const [dim, setDim] = useState<"feature" | "session" | "repo">("feature");
  const [selected, setSelected] = useState<string | null>(null);
  const load = async (range: string) => {
    setBusy(true); setError("");
    try { setStats(await getIssueOnceGenerated(range ? Number(range) : undefined)); }
    catch (e) { setError(e instanceof Error ? e.message : "加载失败"); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(days); }, [days]);
  // 表格只呈现有统计数据的会话;pending/unsupported/no_code 计入范围计数。
  const rows = useMemo(() => (stats?.per_session ?? [])
    .filter((row) => row.state === "ok")
    .filter((row) => module === "*" || row.module === module),
    [stats, module]);
  const features = useMemo(() => onceGeneratedFeatureRows(
    rows.filter((row) => row.share !== undefined) as IssueOnceGeneratedSessionRow[]),
    [rows]);
  const repos = stats?.by_repo ?? [];
  const selectedRow = rows.find((row) => row.id === selected);
  const pct = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : `${value.toFixed(1)}%`;
  const delivered = stats?.delivered ?? 0;
  const tile = (label: string, rate: number | null | undefined, sub: string, tip: string) =>
    <div className="rounded-[14px] border border-line bg-surface px-5 py-4">
      <small className="mb-1.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
        {label}{help(tip)}
      </small>
      <strong className="block text-[32px] leading-none tracking-[-0.02em] tabular-nums text-text-strong">
        {pct(rate)}</strong>
      <span className="mt-2 block text-xs text-muted-foreground">{sub}</span>
    </div>;
  const help = (tip: string) =>
    <span className="help-tip" data-tip={tip}>
      <HelpCircle size={14} className="text-muted-foreground" />
    </span>;
  return <div className="grid gap-4">
    {error && <p role="alert" className="delivery-error">{error}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <AnalysisFilter label="时间" value={days} onChange={setDays}
        items={[{ value: "30", label: "近 30 天" }, { value: "90", label: "近 90 天" }, { value: "", label: "全部时间" }]} />
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <BarChart3 size={15} />完成交付 {delivered}
        {stats && stats.pending + stats.no_code + stats.unsupported > 0 &&
          <span className="help-tip" data-tip={`待算 ${stats.pending} · 无源码交付 ${stats.no_code} · 早于 ${stats.supported_since} 起算日 ${stats.unsupported} 个,均不进统计`}><HelpCircle size={14} className="text-muted-foreground" /></span>}
      </span>
    </div>
    <div className="grid grid-cols-[repeat(5,1fr)] gap-3.5">
      {tile("一次解决率", stats?.solved.rate,
        `${stats?.solved.passed ?? 0}/${delivered} 会话`,
        "报告一版过 且 验证不通过=0,两轴同时一次的会话占比。分母=完成交付会话。")}
      {tile("90%AI生成达标率", stats?.rate,
        `${stats?.passed ?? 0}/${stats?.total ?? 0} 会话 ≥ 90%`,
        "单会话首次生成占比 ≥ 达标线(参数,当前 90%)判达标;多仓会话按工作行加权合成。分母=有统计数据的完成交付会话。")}
      {tile("一次定位率", stats?.localization.rate,
        `${stats?.localization.passed ?? 0}/${stats?.localization.total ?? delivered} 会话`,
        "分析报告一版过即一次定位;检视提出修改会生成新版本。")}
      {tile("一次验证率", stats?.verify.rate,
        `${stats?.verify.passed ?? 0}/${delivered} 会话`,
        "验证不通过次数=0 即一次验证;未答卡=通过(合入即通过)。")}
      {tile("首次生成占比", weightedShare(stats),
        `首轮 ${num(sumLines(stats).first)} / 全部 ${num(sumLines(stats).total)} 行`,
        "首轮提交变更行 ÷ 全部提交变更行(增删行均计为正向工作量,源码白名单内);平台外(人工)改动计入分母;被强制覆盖(force push)的平台推送按原分类计入。跨会话按工作行加权。")}
    </div>
    <div className="inline-flex overflow-hidden rounded-[10px] border border-line" role="tablist" aria-label="观察维度">
      {([["feature", "按特性"], ["session", "按会话"], ["repo", "按代码仓"]] as const).map(([key, label]) =>
        <button key={key} type="button" aria-pressed={dim === key}
          className={cn("border-r border-line px-5 py-2 text-sm last:border-r-0",
            dim === key ? "bg-canvas font-semibold text-text-strong" : "text-muted-foreground hover:text-text-strong")}
          onClick={() => setDim(key)}>{label}</button>)}
    </div>
    {dim === "feature" && <section className="delivery-card"><h2 className="flex items-center gap-2">按特性
      {help("点特性名可筛选;定位/验证/解决按会话归属特性计,占比按工作行加权")}</h2>
      <div className="delivery-table-scroll"><table><thead><tr>
        <th>特性</th><th>会话数</th><th>一次解决率</th><th>90%AI生成达标率</th><th>一次定位率</th><th>一次验证率</th><th>首次生成占比</th>
      </tr></thead>
        <tbody>{features.map((feature: OnceGeneratedFeatureRow) => <tr key={feature.module}>
          <td><button className="delivery-task-link" aria-pressed={module === feature.module}
            onClick={() => setModule(module === feature.module ? "*" : feature.module)}><b>{feature.module}</b></button></td>
          <td>{feature.sessions}</td>
          <td className="pct">{pct(feature.solved_rate)}</td>
          <td className="pct">{pct(feature.pass_rate)}</td>
          <td className="pct">{pct(feature.localization_rate)}</td>
          <td className="pct">{pct(feature.verify_rate)}</td>
          <td className="delivery-accent pct">{pct(feature.share)}</td>
        </tr>)}</tbody></table></div>
      {!features.length && <p className="delivery-empty">{busy ? "正在读取统计…" : "范围内还没有完成交付的会话"}</p>}
    </section>}
    {dim === "session" && <section className="delivery-card"><h2 className="flex items-center gap-2">按会话
      {help("点行查看该会话的行归属证据;一次定位括号为报告版本数,一次验证✗为验证失败次数")}</h2>
      <div className="delivery-table-scroll"><table><thead><tr>
        <th>会话</th><th>特性</th><th>一次解决</th><th>90%AI生成达标</th><th>一次定位</th><th>一次验证</th><th>首次生成占比</th><th>首轮/返工/平台外(行)</th><th>收口时间</th>
      </tr></thead>
        <tbody>{rows.map((row: IssueOnceGeneratedSessionRow) => <tr key={row.id} style={{ cursor: "pointer" }}
          title="查看行归属证据" onClick={() => setSelected(row.id)}>
          <td><span className="delivery-task-link" style={{ cursor: "pointer" }}><b>{row.id}</b><span>{row.title}</span></span></td>
          <td>{row.module}</td>
          <td>{row.solved_pass ? <span className="font-semibold text-success">✓</span> : <span className="font-semibold text-danger">✗</span>}</td>
          <td>{row.pass ? <span className="font-semibold text-success">达标</span> : <span className="font-semibold text-danger">未达标</span>}</td>
          <td>{row.localization_pass ? <span className="text-success">✓ 一版</span> : <span className="text-danger">✗ 多版</span>}</td>
          <td>{row.verify_pass ? <span className="text-success">✓</span> : <span className="text-danger">✗</span>}</td>
          <td className="delivery-accent pct">{pct(row.share)}</td>
          <td className="pct">{num(row.lines?.first ?? 0)} / {num(row.lines?.rework ?? 0)} / {num(row.lines?.external ?? 0)}</td>
          <td className="text-muted-foreground">{new Date(row.concluded_at).toLocaleDateString("zh-CN")}</td>
        </tr>)}</tbody></table></div>
      {!rows.length && <p className="delivery-empty">{busy ? "正在读取统计…" : "范围内没有会话"}</p>}
    </section>}
    {dim === "repo" && <section className="delivery-card"><h2 className="flex items-center gap-2">按代码仓
      {help("过程率是会话级裁决,不设仓维度;多仓会话按仓各计一次;纯删除交付正常计分")}</h2>
      <div className="delivery-table-scroll"><table><thead><tr>
        <th>代码仓</th><th>涉及会话</th><th>首次生成占比</th><th>返工工作行</th><th>平台外工作行</th>
      </tr></thead>
        <tbody>{repos.map((repo: IssueOnceGeneratedRepoRow) => <tr key={repo.repo}>
          <td className="wrap"><b>{repo.repo}</b></td>
          <td>{repo.sessions}</td>
          <td className="delivery-accent pct">{pct(repo.share)}</td>
          <td>{num(repo.rework)}</td>
          <td className="text-muted-foreground">{num(repo.external)}</td>
        </tr>)}</tbody></table></div>
      {!repos.length && <p className="delivery-empty">{busy ? "正在读取统计…" : "范围内没有代码仓数据"}</p>}
    </section>}
    <details className="delivery-method" style={{ marginTop: 4 }}><summary style={{ cursor: "pointer" }}>统计口径</summary>
      <p>一次定位率=分析报告一版过;一次验证率=验证不通过 0 次(未答卡=通过);一次解决率=两者同时;分母均为完成交付会话。</p>
      <p>首次生成占比=首轮提交变更行 ÷ 全部提交变更行(增删行均计,源码白名单内);返工边界=首个反馈事件(检视/红灯/验证失败)回应的推送;平台外改动计入分母;被强制覆盖(force push)的平台推送按原分类计入,证据表里标「已覆盖」;现场取不到标「不可得」。收口后后台计算,稍后刷新可见。</p>
    </details>
    <Sheet open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }}>
      <SheetContent className="delivery-detail-sheet bg-(--surface) gap-0 data-[side=right]:w-[min(760px,58vw)] data-[side=right]:sm:max-w-[min(760px,58vw)]">
        <SheetHeader><SheetTitle>{selected} · 首次生成归属</SheetTitle>
          <SheetDescription>{selectedRow ? `${selectedRow.title} · 占比 ${pct(selectedRow.share)}` : "行归属证据"}</SheetDescription></SheetHeader>
        <div className="delivery-detail-body">{selected
          && <IssueCodeOriginPanel id={selected} threshold={stats?.threshold_percent} />}</div>
      </SheetContent>
    </Sheet>
  </div>;
}
/** 登记问题页签(ADR-0048):无单会话的结论漏斗与研究质量。只数
 *  结论已出的会话(非问题/确认是问题/取消),研究进行中与存量挂起
 *  一律不进;一次定位分母=非问题+确认是问题。纯呈现层,与登记问题
 *  统计端点同一数字;「确认是问题」行下钻报告版本账与提单模板卡。 */
export function RegistrationAnalyticsTab() {
  const [stats, setStats] = useState<IssueRegistrationStats>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState("");
  const [dim, setDim] = useState<"module" | "reporter" | "session">("module");
  const [module, setModule] = useState("*");
  const [selected, setSelected] = useState<IssueRegistrationSessionRow | null>(null);
  const load = async (range: string) => {
    setBusy(true); setError("");
    try { setStats(await getIssueRegistrationStats(range ? Number(range) : undefined)); }
    catch (e) { setError(e instanceof Error ? e.message : "加载失败"); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(days); }, [days]);
  const rows = useMemo(() => (stats?.per_session ?? [])
    .filter((row) => module === "*" || row.module === module), [stats, module]);
  const modules = stats?.by_module ?? [];
  const reporters = stats?.by_reporter ?? [];
  const pct = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : `${value.toFixed(1)}%`;
  const help = (tip: string) =>
    <span className="help-tip" data-tip={tip}>
      <HelpCircle size={14} className="text-muted-foreground" />
    </span>;
  const tile = (label: string, value: string, sub: string, tip: string) =>
    <div className="rounded-[14px] border border-line bg-surface px-5 py-4">
      <small className="mb-1.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
        {label}{help(tip)}
      </small>
      <strong className="block text-[32px] leading-none tracking-[-0.02em] tabular-nums text-text-strong">
        {value}</strong>
      <span className="mt-2 block text-xs text-muted-foreground">{sub}</span>
    </div>;
  const badge = (conclusion: IssueRegistrationSessionRow["conclusion"]) =>
    conclusion === "issue"
      ? <span className="inline-flex items-center rounded-full bg-active-soft px-2 py-0.5 text-xs font-medium text-active">确认是问题</span>
      : conclusion === "non_issue"
        ? <span className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted-foreground">非问题</span>
        : <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs text-faint">取消</span>;
  return <div className="grid gap-4">
    {error && <p role="alert" className="delivery-error">{error}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <AnalysisFilter label="时间" value={days} onChange={setDays}
        items={[{ value: "30", label: "近 30 天" }, { value: "90", label: "近 90 天" }, { value: "", label: "全部时间" }]} />
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <BarChart3 size={15} />研究完成 {stats?.total ?? 0}
        {help("结论已出的无单会话:非问题 + 确认是问题 + 取消。研究进行中与存量挂起一律不进任何数字。")}
      </span>
    </div>
    <div className="grid grid-cols-[repeat(4,1fr)] gap-3.5">
      {tile("登记总数", String(stats?.total ?? 0),
        `非问题 ${stats?.non_issue ?? 0} · 确认是问题 ${stats?.issue_confirmed ?? 0} · 取消 ${stats?.canceled ?? 0}`,
        "结论已出的无单(自研)问题会话数:研究进行中的暂不进,结论落地后自动计入;有单会话在 DTS 页签,不在此处。")}
      {tile("非问题闭环率", pct(stats ? stats.total ? stats.non_issue / stats.total * 100 : null : null),
        `${stats?.non_issue ?? 0}/${stats?.total ?? 0} 研究完成`,
        "研究结论为「非问题」的占比。分母=研究完成(非问题+确认是问题+取消);挂起与进行中不进。")}
      {tile("确认是问题率", pct(stats ? stats.total ? stats.issue_confirmed / stats.total * 100 : null : null),
        `${stats?.issue_confirmed ?? 0}/${stats?.total ?? 0} 研究完成`,
        "研究结论为「确认是问题」的占比:会话闭环并产出提单模板,测试拿模板去 DTS 提单后,新单号从 DTS 列表发起有单会话。分母同左。")}
      {tile("一次定位率", pct(stats?.localization.rate),
        `${stats?.localization.passed ?? 0}/${stats?.localization.total ?? 0} 会话`,
        "分析报告一版就收口即一次定位;检视提出修改会生成新版本。分母=非问题+确认是问题,取消不构成一次研究。")}
    </div>
    <div className="inline-flex overflow-hidden rounded-[10px] border border-line" role="tablist" aria-label="观察维度">
      {([["module", "按模块"], ["reporter", "按登记人"], ["session", "按会话"]] as const).map(([key, label]) =>
        <button key={key} type="button" aria-pressed={dim === key}
          className={cn("border-r border-line px-5 py-2 text-sm last:border-r-0",
            dim === key ? "bg-canvas font-semibold text-text-strong" : "text-muted-foreground hover:text-text-strong")}
          onClick={() => setDim(key)}>{label}</button>)}
    </div>
    {dim === "module" && <section className="delivery-card"><h2 className="flex items-center gap-2">按模块
      {help("无单会话按登记时所选业务模块聚合;点模块名可筛选按会话明细")}
    </h2>
      <div className="delivery-table-scroll"><table><thead><tr>
        <th>模块</th><th>登记数</th><th>非问题</th><th>确认是问题</th><th>取消</th><th>一次定位率</th>
      </tr></thead>
        <tbody>{modules.map((entry) => <tr key={entry.key}>
          <td><button className="delivery-task-link" aria-pressed={module === entry.key}
            onClick={() => setModule(module === entry.key ? "*" : entry.key)}><b>{entry.key}</b></button></td>
          <td>{entry.total}</td>
          <td>{entry.non_issue}</td>
          <td>{entry.issue_confirmed}</td>
          <td className="text-muted-foreground">{entry.canceled}</td>
          <td className="delivery-accent pct">{pct(entry.localization_rate)}</td>
        </tr>)}</tbody></table></div>
      {!modules.length && <p className="delivery-empty">{busy ? "正在读取统计…" : "范围内还没有登记问题"}</p>}
    </section>}
    {dim === "reporter" && <section className="delivery-card"><h2 className="flex items-center gap-2">按登记人
      {help("按登记时指派的登记人聚合;登记人缺席的老会话按归属兜底")}
    </h2>
      <div className="delivery-table-scroll"><table><thead><tr>
        <th>登记人</th><th>登记数</th><th>非问题</th><th>确认是问题</th><th>取消</th><th>一次定位率</th>
      </tr></thead>
        <tbody>{reporters.map((entry) => <tr key={entry.key}>
          <td className="wrap"><b>{entry.key}</b></td>
          <td>{entry.total}</td>
          <td>{entry.non_issue}</td>
          <td>{entry.issue_confirmed}</td>
          <td className="text-muted-foreground">{entry.canceled}</td>
          <td className="delivery-accent pct">{pct(entry.localization_rate)}</td>
        </tr>)}</tbody></table></div>
      {!reporters.length && <p className="delivery-empty">{busy ? "正在读取统计…" : "范围内还没有登记问题"}</p>}
    </section>}
    {dim === "session" && <section className="delivery-card"><h2 className="flex items-center gap-2">按会话
      {help("点「确认是问题」行查看报告版本账与提单模板卡")}
    </h2>
      <div className="delivery-table-scroll"><table><thead><tr>
        <th>会话</th><th>模块</th><th>登记人</th><th>责任人</th><th>结论</th><th>报告版本</th><th>一次定位</th><th>收口时间</th>
      </tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}
          style={{ cursor: row.conclusion === "issue" ? "pointer" : undefined }}
          title={row.conclusion === "issue" ? "查看报告版本账与提单模板" : undefined}
          onClick={row.conclusion === "issue" ? () => setSelected(row) : undefined}>
          <td><span className="delivery-task-link"><b>{row.id}</b><span>{row.title}</span></span></td>
          <td>{row.module}</td>
          <td>{row.reporter}</td>
          <td>{row.account}</td>
          <td>{badge(row.conclusion)}</td>
          <td className="pct">{row.conclusion === "canceled" ? "—" : `${row.report_version_count} 版`}</td>
          <td>{row.localization_pass === undefined
            ? <span className="text-muted-foreground">—</span>
            : row.localization_pass
              ? <span className="font-semibold text-success">✓ 一版</span>
              : <span className="font-semibold text-danger">✗ 多版</span>}</td>
          <td className="text-muted-foreground">{new Date(row.concluded_at).toLocaleDateString("zh-CN")}</td>
        </tr>)}</tbody></table></div>
      {!rows.length && <p className="delivery-empty">{busy ? "正在读取统计…" : "范围内没有登记问题"}</p>}
    </section>}
    <details className="delivery-method" style={{ marginTop: 4 }}><summary style={{ cursor: "pointer" }}>统计口径</summary>
      <p>本页只数结论已出的无单(自研)会话:非问题闭环率与确认是问题率的分母=研究完成(非问题+确认是问题+取消);一次定位率分母=非问题+确认是问题(取消不构成一次研究);研究进行中与存量挂起一律不进。</p>
      <p>一次定位率=分析报告一版过,检视提出修改会生成新版本。确认是问题即闭环归档并产出提单模板;提单在平台外完成(测试复制进 DTS 提单系统),新单号再从 DTS 列表发起有单会话完整重走。</p>
    </details>
    <Sheet open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }}>
      <SheetContent className="delivery-detail-sheet bg-(--surface) gap-0 data-[side=right]:w-[min(560px,46vw)] data-[side=right]:sm:max-w-[min(560px,46vw)]">
        <SheetHeader><SheetTitle>{selected?.title}</SheetTitle>
          <SheetDescription>{selected ? `${selected.module} · ${selected.reporter} 登记 · 报告 ${selected.report_version_count} 版` : "报告版本账与提单模板"}</SheetDescription></SheetHeader>
        <div className="delivery-detail-body">{selected && <>
          <section className="delivery-card"><h2>报告版本账
            <span>{selected.localization_pass
              ? "分析报告一版过,一次定位 ✓"
              : "检视提出修改生成新版本,一次定位 ✗"}</span></h2>
            <p className="delivery-muted">结论「{selected.conclusion === "issue" ? "确认是问题" : selected.conclusion === "non_issue" ? "非问题" : "取消"}」· 报告共 {selected.report_version_count} 版 · {new Date(selected.concluded_at).toLocaleDateString("zh-CN")} 收口</p>
          </section>
          {selected.conclusion === "issue" && <TicketTemplateCard issueId={selected.id} />}
        </>}</div>
      </SheetContent>
    </Sheet>
  </div>;
}
export function DeliveryAnalytics() {
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const [tab, setTab] = useState<"requirement" | "issue" | "registration">("requirement");
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
      {([["requirement", "需求交付"], ["issue", "DTS"], ["registration", "登记问题"]] as const).map(([key, label]) =>
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
    {tab === "registration" && <RegistrationAnalyticsTab />}
  </div>;
}
