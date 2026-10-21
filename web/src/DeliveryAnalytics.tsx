import { useTechnologyStacks } from "./useTechnologyStacks";
import { CompletionDateFilter, completionDateRange, type CompletionDates } from "./CompletionDateFilter";
import { completedInRange } from "../../src/completionRange";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { BarChart3, ExternalLink, HelpCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { knowledgeLanguageLabel } from "./KnowledgeLanguages";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import type { CodeOrigin, DeliveryAnalysisReport, DeliveryAnalysisRow, DeliveryTaskTokens, OriginCounts } from "../../src/deliveryAnalyticsTypes";
import { KnowledgeInsightsPanel } from "./KnowledgeFlywheel";
import { aggregateDelivery, aggregateDeliveryModules, aggregateDeliveryTokens, sumOrigins } from "../../src/deliveryAnalyticsSummary";
import { cn } from "cn";
import { getIssueOnceGenerated, listPeople, type IssueCancelReason, type IssueOnceGenerated, type IssueOnceGeneratedRepoRow, type IssueOnceGeneratedSessionRow, type PersonIdentity } from "./api";
import { getIssueRegistrationStats, type IssueRegistrationSessionRow, type IssueRegistrationStats } from "./api";
import { TicketTemplateCard } from "./issues/TicketTemplateCard";
import { onceGeneratedFeatureRows, type OnceGeneratedFeatureRow } from "./teamOps";
import { IssueCodeOriginPanel } from "./issues/CodeOriginPanel";
import { displayPersonName } from "./AnnotationPanel";

/** 首做/返工/平台外工作行三分类的贯穿色:需求交付(交付代码来源)与
 *  DTS(生成工作行来源)两环同色系,调色单点在这里。 */
const donutColors = { first: "#0d9488", rework: "#8b5cf6", external: "#d97706" } as const;
const categories: Array<{ key: CodeOrigin; label: string; color: string }> = [
  { key: "first", label: "首次实现", color: donutColors.first },
  { key: "pipeline", label: "流水线修复", color: donutColors.rework },
  { key: "review", label: "检视意见修改", color: donutColors.external },
];
/** DTS 生成工作行三分类环的切片(2026-10-20 指标收敛,见 IssueAnalyticsTab 注)。 */
const worklineSlices = (lines: { first: number; rework: number; external: number }) => [
  { label: "首轮", color: donutColors.first, value: lines.first },
  { label: "返工", color: donutColors.rework, value: lines.rework },
  { label: "平台外", color: donutColors.external, value: lines.external },
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

function sumLineKinds(stats: IssueOnceGenerated | undefined): { first: number; rework: number; external: number; total: number } {
  let first = 0, rework = 0, external = 0;
  for (const row of stats?.per_session ?? []) {
    first += row.lines?.first ?? 0;
    rework += row.lines?.rework ?? 0;
    external += row.lines?.external ?? 0;
  }
  return { first, rework, external, total: first + rework + external };
}
function weightedShare(stats: IssueOnceGenerated | undefined): number | null {
  const { first, total } = sumLineKinds(stats);
  return total ? Math.round((first / total) * 1000) / 10 : null;
}

function Donut({ slices, unit, centerValue, centerLabel, ariaLabel }: {
  slices: Array<{ label: string; color: string; value: number }>;
  unit: string; centerValue: string; centerLabel: string; ariaLabel: string;
}) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  let offset = 0;
  return <div className="delivery-donut-wrap"><div className="delivery-donut">
    <svg viewBox="0 0 200 200" role="img" aria-label={ariaLabel}>
      <circle cx="100" cy="100" r="78" fill="none" stroke="var(--line)" strokeWidth="22" />
      {slices.map(s => { const size = total ? s.value / total * 100 : 0, start = offset; offset += size;
        return <circle key={s.label} cx="100" cy="100" r="78" fill="none" stroke={s.color} strokeWidth="22" pathLength="100"
          style={{ strokeLinecap: "butt" }} strokeDasharray={`${size} ${100 - size}`} strokeDashoffset={-start} transform="rotate(-90 100 100)"><title>{s.label}：{num(s.value)} {unit}</title></circle>; })}
    </svg><div className="delivery-donut-center"><strong>{centerValue}</strong><span>{centerLabel}</span></div>
  </div><div className="delivery-legend">{slices.map(s => <div key={s.label}><i style={{ background: s.color }} /><span>{s.label}</span><b>{num(s.value)} {unit}</b><small>{percent(total ? s.value / total * 100 : null)}</small></div>)}</div></div>;
}
/** 需求交付的交付代码来源环:工作行三分类(首次实现/流水线修复/检视意见修改)。 */
function OriginDonut({ counts }: { counts: OriginCounts }) {
  const total = sumOrigins(counts);
  const share = percent(total ? counts.first / total * 100 : null);
  return <Donut unit="行" centerValue={share} centerLabel="首次实现占比"
    ariaLabel={`交付代码行数 ${total} 行，首次实现占比 ${share}`}
    slices={categories.map(c => ({ label: c.label, color: c.color, value: counts[c.key] }))} />;
}
function TaskLanguages({ tasks }: { tasks: DeliveryAnalysisRow[] }) {
  useTechnologyStacks();
  const languages = [...new Set(tasks.flatMap(t => t.languages?.length ? t.languages : ["unknown"]))];
  return <span className="inline-flex flex-wrap gap-1.5" title="任务对应代码仓的技术栈">{languages.map(language =>
    <Badge key={language} variant="secondary" className="h-auto px-2 py-1 text-sm">{language === "unknown" ? "未标注" : knowledgeLanguageLabel(language)}</Badge>)}</span>;
}
function TaskMetricRow({ id, title, tasks, child, parent, onSelect, ledger }: { id: string; title: string; tasks: DeliveryAnalysisRow[]; child?: boolean; parent?: boolean; ledger?: DeliveryTaskTokens[]; onSelect: (id: string) => void }) {
  const values = aggregateDelivery(tasks);
  const tokens = aggregateDeliveryTokens(tasks.map(t => t.id), ledger, parent ? id : undefined);
  return <tr className={child ? "delivery-child-row" : undefined}><td><button className="delivery-task-link" onClick={() => onSelect(id)}><b>{id}</b><span>{title}</span></button></td><td><TaskLanguages tasks={tasks} /></td><td>{parent ? <>已合入交付 {tasks.filter(t => t.merged).length}/{tasks.length}{tasks.some(t => !t.merged) && <small>含未合入暂计</small>}</> : tasks.every(t => t.merged) ? "已合入" : "进行中 · 暂计"}</td><td>{values.available ? `${num(values.total)} 行` : "—"}</td><td className="delivery-accent">{percent(values.firstPercent)}</td><td title={tokens.available ? `已记录输入 ${num(tokens.input)} · 输出 ${num(tokens.output)}` : "没有模型用量记录"}><strong>{tokens.available ? num(tokens.total) : "—"}</strong>{tokens.available < tokens.tasks && <small>{tokens.available ? "部分用量已记录" : "暂无用量记录"}</small>}</td><td>{values.available}/{tasks.length}{!values.available && <small>待取证</small>}</td></tr>;
}

/** 终止原因中文词表(#543):稳定英文值是协议(服务端 state.ts 码表),
 *  界面渲染中文;与终止确认框(CancelSessionDialog 下拉)同一份语义。
 *  resolved=问题已处理不会出现在终止行(服务端不下发),入表只为词表
 *  完整、键型对齐。 */
const TERMINATE_REASON_LABELS: Record<IssueCancelReason, string> = {
  resolved: "问题已处理", inaccurate: "分析不准确", slow: "速度太慢",
  disobedient: "指令不遵从", other: "其他原因",
};
/** 终止原因徽标(#543):已定类原因(inaccurate/slow/disobedient)红色系
 *  「终止 · <中文原因>」;other 与缺席/未知(字段纪律缺省处理,#353)
 *  琥珀色系「其他 · <说明>」,超长 CSS 截断省略号,title 悬停看全文。 */
function TerminateReasonBadge({ row }: { row: IssueOnceGeneratedSessionRow }) {
  const text = (row.cancel_reason_text ?? "").trim();
  if (row.cancel_reason !== "inaccurate" && row.cancel_reason !== "slow"
    && row.cancel_reason !== "disobedient") {
    const label = text ? `其他 · ${text}` : "其他";
    return <span
      className="inline-block max-w-[240px] truncate align-bottom rounded-full bg-attention-soft px-2 py-0.5 text-xs font-medium text-attention"
      title={text || undefined}>{label}</span>;
  }
  return <span className="inline-block rounded-full bg-danger-soft px-2 py-0.5 text-xs font-medium text-danger">
    终止 · {TERMINATE_REASON_LABELS[row.cancel_reason]}</span>;
}
/** 终止行详情(#543):终止原因中文文案、「其他原因」完整原文与终止
 *  时刻的只读陈列。终止会话没有工作行事实,行归属证据面板不适用。 */
function TerminateReasonDetail({ row }: { row: IssueOnceGeneratedSessionRow }) {
  const text = (row.cancel_reason_text ?? "").trim();
  return <section className="delivery-card"><h2>终止原因
    <span>{new Date(row.concluded_at).toLocaleString("zh-CN")} 终止</span></h2>
    <p className="mt-3 text-sm">该会话由发起人主动终止,原因:
      <b className={row.cancel_reason === "other" ? "text-attention" : "text-danger"}>
        {TERMINATE_REASON_LABELS[row.cancel_reason ?? "other"]}</b></p>
    {row.cancel_reason === "other" && text
      ? <p className="delivery-muted">说明:{text}</p> : null}
    <p className="delivery-muted">终止会话没有工作行与定位/验证两轴事实,表中相关列以 — 占位;一次解决率分母计入并记未解决。</p>
  </section>;
}

/** DTS 页签(原「问题处理」,ADR-0044,工单 #340):首次生成占比的
 *  每会话明细与特性聚合——读侧与团队问题页统计瓦片同一端点、同一
 *  数字;行点击下钻行归属证据(伴生快照原样)。人群=有单交付会话;
 *  无单会话在「登记问题」页签(ADR-0048)。纯呈现层,不建第二套口径。
 *  2026-10-20 指标收敛(领导拍板):概览只留两图——一次解决率与首次
 *  生成占比(双环,样式与需求交付概览同款);90%AI生成达标率整档退场,
 *  一次定位/一次验证只在按会话表留 ✓/✗ 诊断列;后端端点零改动。
 *  #543:负面原因终止的会话以行进按会话表(一次解决 ✗、无事实列 —、
 *  末列终止原因徽标,点行看原因详情),发起人列显示姓名。
 *  导出仅供视觉走查场景脚本挂载(与需求侧同款做法)。 */
export function IssueAnalyticsTab() {
  const [stats, setStats] = useState<IssueOnceGenerated>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dates, setDates] = useState<CompletionDates>({ from: "", to: "" });
  const [module, setModule] = useState("*");
  const [dim, setDim] = useState<"feature" | "session" | "repo">("feature");
  const [selected, setSelected] = useState<string | null>(null);
  // 发起人姓名映射(#543):只是显示增强;读取失败静默退回工号显示,
  // 不 setError、不 busy,不挡表格首屏(先例 TaskWorkspace 同纪律)。
  const [people, setPeople] = useState<PersonIdentity[]>([]);
  useEffect(() => {
    let live = true;
    void listPeople().then((roster) => { if (live) setPeople(roster); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    let live = true;
    setStats(undefined); setError("");
    if (dates.from && dates.to && dates.from > dates.to) { setBusy(false); return; }
    setBusy(true);
    void getIssueOnceGenerated(undefined, completionDateRange(dates)).then(value => { if (live) setStats(value); })
      .catch(error => { if (live) setError(error instanceof Error ? error.message : "加载失败"); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [dates]);
  // 表格呈现完成交付会话与负面终止会话(#543);「问题已处理」取消与
  // 无原因历史取消服务端本就不下发行,前端不复判 cancel_reason(唯一
  // 口径在服务端);pending/unsupported/no_code 只计入范围计数,不进表。
  const rows = useMemo(() => (stats?.per_session ?? [])
    .filter((row) => row.state === "ok" || row.state === "canceled")
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
  const lines = sumLineKinds(stats);
  const terminated = stats?.terminated ?? 0;
  const solvedRate = pct(stats?.solved.rate);
  const shareRate = pct(weightedShare(stats));
  const help = (tip: string) =>
    <span className="help-tip" data-tip={tip}>
      <HelpCircle size={14} className="text-muted-foreground" />
    </span>;
  return <div className="grid gap-4">
    {error && <p role="alert" className="delivery-error">{error}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <CompletionDateFilter value={dates} onChange={setDates} />
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <BarChart3 size={15} />完成交付 {delivered}
        {stats && stats.pending + stats.no_code + stats.unsupported > 0 &&
          <span className="help-tip" data-tip={`待算 ${stats.pending} · 无源码交付 ${stats.no_code} · 早于 ${stats.supported_since} 起算日 ${stats.unsupported} 个,均不进统计`}><HelpCircle size={14} className="text-muted-foreground" /></span>}
      </span>
    </div>
    <div className="delivery-overview-grid">
      <section className="delivery-card"><h2>一次解决率 <span>{stats?.solved.passed ?? 0} / {stats?.solved.total ?? 0} 会话</span>{help("报告一版过 且 验证不通过=0,两轴同时一次的会话占比。分母=完成交付会话+主动终止(负面原因)会话,主动终止记一次失败;按会话表的定位/验证✓✗是它的两个因子,两轴分母仍只含完成交付。")}</h2>
        <Donut unit="会话" centerValue={solvedRate} centerLabel="一次解决率"
          ariaLabel={`一次解决 ${stats?.solved.passed ?? 0} / ${stats?.solved.total ?? 0} 会话，占比 ${solvedRate}`}
          slices={[
            { label: "一次解决", color: "var(--success)", value: stats?.solved.passed ?? 0 },
            { label: "未一次解决", color: "var(--line-strong)", value: Math.max(0, (stats?.solved.total ?? 0) - (stats?.solved.passed ?? 0) - terminated) },
            { label: "用户终止（负面原因）", color: "#d97706", value: terminated },
          ]} />
        <p className="mt-3 text-xs text-muted-foreground">口径标注：分母 = 完成交付会话 + 主动终止会话（自终止原因收集上线起）；终止时选「问题已处理」的会话不参与统计。</p>
      </section>
      <section className="delivery-card"><h2>首次生成占比 <span>交付代码行数：{num(lines.total)} 行</span>{help("首次生成占比=首轮提交变更行 ÷ 全部提交变更行(增删行均计为正向工作量,源码白名单内);平台外(人工)改动计入分母;被强制覆盖(force push)的平台推送按原分类计入。跨会话按工作行加权。")}</h2>
        <Donut unit="行" centerValue={shareRate} centerLabel="首次生成占比"
          ariaLabel={`生成工作行 ${num(lines.total)} 行，首次生成占比 ${shareRate}`}
          slices={worklineSlices(lines)} />
      </section>
    </div>
    <div className="inline-flex overflow-hidden rounded-[10px] border border-line" role="tablist" aria-label="观察维度">
      {([["feature", "按特性"], ["session", "按会话"], ["repo", "按代码仓"]] as const).map(([key, label]) =>
        <button key={key} type="button" aria-pressed={dim === key}
          className={cn("border-r border-line px-5 py-2 text-sm last:border-r-0",
            dim === key ? "bg-canvas font-semibold text-text-strong" : "text-muted-foreground hover:text-text-strong")}
          onClick={() => setDim(key)}>{label}</button>)}
    </div>
    {dim === "feature" && <section className="delivery-card"><h2 className="flex items-center gap-2">按特性
      {help("点特性名可筛选;一次解决按会话归属特性计,占比按工作行加权")}</h2>
      <div className="delivery-table-scroll"><table><thead><tr>
        <th>特性</th><th>会话数</th><th>一次解决率</th><th>首次生成占比</th>
      </tr></thead>
        <tbody>{features.map((feature: OnceGeneratedFeatureRow) => <tr key={feature.module}>
          <td><button className="delivery-task-link" aria-pressed={module === feature.module}
            onClick={() => setModule(module === feature.module ? "*" : feature.module)}><b>{feature.module}</b></button></td>
          <td>{feature.sessions}</td>
          <td className="pct">{pct(feature.solved_rate)}</td>
          <td className="delivery-accent pct">{pct(feature.share)}</td>
        </tr>)}</tbody></table></div>
      {!features.length && <p className="delivery-empty">{busy ? "正在读取统计…" : "范围内还没有完成交付的会话"}</p>}
    </section>}
    {dim === "session" && <section className="delivery-card"><h2 className="flex items-center gap-2">按会话
      {help("点行查看该会话的行归属证据,终止行点行看终止原因与说明;一次定位/一次验证✓✗只对完成交付会话判轴,终止行相关列以 — 占位")}</h2>
      <div className="delivery-table-scroll"><table><thead><tr>
        <th>会话</th><th>特性</th><th>一次解决</th><th>一次定位</th><th>一次验证</th><th>首次生成占比</th><th>首轮/返工/平台外(行)</th><th>发起人</th><th>收口时间</th><th>终止原因</th>
      </tr></thead>
        <tbody>{rows.map((row: IssueOnceGeneratedSessionRow) => {
          const canceledRow = row.state === "canceled";
          return <tr key={row.id} style={{ cursor: "pointer" }}
            title={canceledRow ? "查看终止原因" : "查看行归属证据"} onClick={() => setSelected(row.id)}>
          <td><span className="delivery-task-link" style={{ cursor: "pointer" }}><b>{row.id}</b><span>{row.title}</span></span></td>
          <td>{row.module}</td>
          <td>{row.solved_pass ? <span className="font-semibold text-success">✓</span> : <span className="font-semibold text-danger">✗</span>}</td>
          <td>{canceledRow ? "—" : row.localization_pass ? <span className="text-success">✓ 一版</span> : <span className="text-danger">✗ 多版</span>}</td>
          <td>{canceledRow ? "—" : row.verify_pass ? <span className="text-success">✓</span> : <span className="text-danger">✗</span>}</td>
          <td className="delivery-accent pct">{canceledRow ? "—" : pct(row.share)}</td>
          <td className="pct">{canceledRow ? "—" : `${num(row.lines?.first ?? 0)} / ${num(row.lines?.rework ?? 0)} / ${num(row.lines?.external ?? 0)}`}</td>
          <td>{row.reporter ? displayPersonName(row.reporter, people) : "—"}</td>
          <td className="text-muted-foreground">{new Date(row.concluded_at).toLocaleDateString("zh-CN")}</td>
          <td>{canceledRow ? <TerminateReasonBadge row={row} /> : "—"}</td>
        </tr>;
        })}</tbody></table></div>
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
      <p>概览只看两个指标:一次解决率=一次定位(分析报告一版过)且一次验证(验证不通过 0 次,未答卡=通过),分母=完成交付会话+主动终止(负面原因)会话,主动终止记一次失败,一次定位/一次验证两轴的分母仍只含完成交付(负面终止无法判轴);终止时选「问题已处理」的会话与无原因取消(历史数据)不参与统计,无单会话不进任何率;首次生成占比=首轮提交变更行 ÷ 全部提交变更行(增删行均计,源码白名单内)。</p>
      <p>首次生成占比的返工边界=首个反馈事件(检视/红灯/验证失败)回应的推送;平台外改动计入分母;被强制覆盖(force push)的平台推送按原分类计入,证据表里标「已覆盖」;现场取不到标「不可得」。收口后后台计算,稍后刷新可见。</p>
    </details>
    <Sheet open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }}>
      <SheetContent className="delivery-detail-sheet bg-(--surface) gap-0 data-[side=right]:w-[min(760px,58vw)] data-[side=right]:sm:max-w-[min(760px,58vw)]">
        <SheetHeader><SheetTitle>{selected} · {selectedRow?.state === "canceled" ? "终止详情" : "首次生成归属"}</SheetTitle>
          <SheetDescription>{selectedRow ? selectedRow.state === "canceled"
            ? `${selectedRow.title} · ${new Date(selectedRow.concluded_at).toLocaleDateString("zh-CN")} 终止`
            : `${selectedRow.title} · 占比 ${pct(selectedRow.share)}` : "行归属证据"}</SheetDescription></SheetHeader>
        <div className="delivery-detail-body">{selected
          && (selectedRow?.state === "canceled"
            ? <TerminateReasonDetail row={selectedRow} />
            : <IssueCodeOriginPanel id={selected} threshold={stats?.threshold_percent} />)}</div>
      </SheetContent>
    </Sheet>
  </div>;
}
/** 登记问题页签(ADR-0048;口径 2026-10-16 由 ADR-0064 收紧):无单
 *  会话的结论漏斗与研究质量。人群=研究结论已出(非问题/确认是问题);
 *  取消是退场、不算研究结论,与研究进行中一样不进任何数字。
 *  纯呈现层,与登记问题统计端点同一数字;「确认是问题」行下钻
 *  报告版本账与提单模板卡。 */
export function RegistrationAnalyticsTab() {
  const [stats, setStats] = useState<IssueRegistrationStats>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dates, setDates] = useState<CompletionDates>({ from: "", to: "" });
  const [dim, setDim] = useState<"module" | "reporter" | "session">("module");
  const [module, setModule] = useState("*");
  const [selected, setSelected] = useState<IssueRegistrationSessionRow | null>(null);
  useEffect(() => {
    let live = true;
    setStats(undefined); setError("");
    if (dates.from && dates.to && dates.from > dates.to) { setBusy(false); return; }
    setBusy(true);
    void getIssueRegistrationStats(undefined, completionDateRange(dates)).then(value => { if (live) setStats(value); })
      .catch(error => { if (live) setError(error instanceof Error ? error.message : "加载失败"); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [dates]);
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
      : <span className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted-foreground">非问题</span>;
  return <div className="grid gap-4">
    {error && <p role="alert" className="delivery-error">{error}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <CompletionDateFilter value={dates} onChange={setDates} />
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <BarChart3 size={15} />研究完成 {stats?.total ?? 0}
        {help("研究结论已出的无单会话:非问题 + 确认是问题。取消是退场不算研究结论,与研究进行中一样不进任何数字。")}
      </span>
    </div>
    <div className="grid grid-cols-[repeat(4,1fr)] gap-3.5">
      {tile("登记总数", String(stats?.total ?? 0),
        `非问题 ${stats?.non_issue ?? 0} · 确认是问题 ${stats?.issue_confirmed ?? 0}`,
        "研究结论已出的无单(自研)问题会话数:取消视为退场不计入;研究进行中的暂不进,结论落地后自动计入;有单会话在 DTS 页签,不在此处。")}
      {tile("非问题闭环率", pct(stats ? stats.total ? stats.non_issue / stats.total * 100 : null : null),
        `${stats?.non_issue ?? 0}/${stats?.total ?? 0} 研究完成`,
        "研究结论为「非问题」的占比。分母=研究完成(非问题+确认是问题);取消是退场不算研究结论,不进分母;进行中不进。")}
      {tile("确认是问题率", pct(stats ? stats.total ? stats.issue_confirmed / stats.total * 100 : null : null),
        `${stats?.issue_confirmed ?? 0}/${stats?.total ?? 0} 研究完成`,
        "研究结论为「确认是问题」的占比:会话闭环并产出提单模板,测试拿模板去 DTS 提单后,新单号从 DTS 列表发起有单会话。分母同左。")}
      {tile("一次定位率", pct(stats?.localization.rate),
        `${stats?.localization.passed ?? 0}/${stats?.localization.total ?? 0} 会话`,
        "分析报告一版就收口即一次定位;检视提出修改会生成新版本。分母=非问题+确认是问题。")}
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
        <th>模块</th><th>登记数</th><th>非问题</th><th>确认是问题</th><th>一次定位率</th>
      </tr></thead>
        <tbody>{modules.map((entry) => <tr key={entry.key}>
          <td><button className="delivery-task-link" aria-pressed={module === entry.key}
            onClick={() => setModule(module === entry.key ? "*" : entry.key)}><b>{entry.key}</b></button></td>
          <td>{entry.total}</td>
          <td>{entry.non_issue}</td>
          <td>{entry.issue_confirmed}</td>
          <td className="delivery-accent pct">{pct(entry.localization_rate)}</td>
        </tr>)}</tbody></table></div>
      {!modules.length && <p className="delivery-empty">{busy ? "正在读取统计…" : "范围内还没有登记问题"}</p>}
    </section>}
    {dim === "reporter" && <section className="delivery-card"><h2 className="flex items-center gap-2">按登记人
      {help("按登记时指派的登记人聚合;登记人缺席的老会话按归属兜底")}
    </h2>
      <div className="delivery-table-scroll"><table><thead><tr>
        <th>登记人</th><th>登记数</th><th>非问题</th><th>确认是问题</th><th>一次定位率</th>
      </tr></thead>
        <tbody>{reporters.map((entry) => <tr key={entry.key}>
          <td className="wrap"><b>{entry.key}</b></td>
          <td>{entry.total}</td>
          <td>{entry.non_issue}</td>
          <td>{entry.issue_confirmed}</td>
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
          <td className="pct">{row.report_version_count} 版</td>
          <td>{row.localization_pass
            ? <span className="font-semibold text-success">✓ 一版</span>
            : <span className="font-semibold text-danger">✗ 多版</span>}</td>
          <td className="text-muted-foreground">{new Date(row.concluded_at).toLocaleDateString("zh-CN")}</td>
        </tr>)}</tbody></table></div>
      {!rows.length && <p className="delivery-empty">{busy ? "正在读取统计…" : "范围内没有登记问题"}</p>}
    </section>}
    <details className="delivery-method" style={{ marginTop: 4 }}><summary style={{ cursor: "pointer" }}>统计口径</summary>
      <p>本页只数研究结论已出的无单(自研)会话,人群=非问题+确认是问题:三块比率的分母都是它;取消是退场、不算研究结论,与研究进行中一样不进任何数字(ADR-0064)。</p>
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
            <p className="delivery-muted">结论「{selected.conclusion === "issue" ? "确认是问题" : "非问题"}」· 报告共 {selected.report_version_count} 版 · {new Date(selected.concluded_at).toLocaleDateString("zh-CN")} 收口</p>
          </section>
          {selected.conclusion === "issue" && <TicketTemplateCard issueId={selected.id} />}
        </>}</div>
      </SheetContent>
    </Sheet>
  </div>;
}
export function DeliveryAnalytics({ onOpenTask, initialTab }: {
  onOpenTask: (taskId: string) => void;
  /** 入场页签(页内跳转指定落点,如团队DTS档案的「交付统计」直达
   * 「DTS」;缺席=需求交付)。本组件按视图条件挂载,每次进场重取。 */
  initialTab?: "requirement" | "issue" | "registration" | "knowledge";
}) {
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const [tab, setTab] = useState<"requirement" | "issue" | "registration" | "knowledge">(
    initialTab ?? "requirement");
  const [report, setReport] = useState<DeliveryAnalysisReport>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [repo, setRepo] = useState(""); const [module, setModule] = useState("*");
  const [page, setPage] = useState(0);
  const [dates, setDates] = useState<CompletionDates>({ from: "", to: "" }); const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(new URLSearchParams(location.search).get("deliveryTask"));
  async function refresh(retry = false) {
    setBusy(true); setError("");
    try { const response = await fetch(`/delivery-analytics${retry ? "?refresh=1" : ""}`); if (!response.ok) throw new Error(response.status === 401 ? "请先登录后查看交付分析" : "交付分析加载失败"); setReport(await response.json()); }
    catch (e) { setError(e instanceof Error ? e.message : "加载失败"); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);
  const rows = useMemo(() => (report?.rows ?? []).filter(row => (!repo || row.repo === repo) && (module === "*" || (row.business_module?.id ?? "") === module)
    && (!(dates.from && dates.to && dates.from > dates.to) && completedInRange(row.completed_at, completionDateRange(dates)))
    && (!query || `${row.id} ${row.parent_id ?? ""} ${row.parent_title ?? ""} ${row.title}`.toLowerCase().includes(query.toLowerCase()))), [report, repo, module, dates, query]);
  const merged = rows.filter(row => row.merged), summary = aggregateDelivery(merged);
  const moduleRows = useMemo(() => (report?.rows ?? []).filter(row => (!repo || row.repo === repo)
    && (!(dates.from && dates.to && dates.from > dates.to) && completedInRange(row.completed_at, completionDateRange(dates)))
    && (!query || `${row.id} ${row.parent_id ?? ""} ${row.parent_title ?? ""} ${row.title}`.toLowerCase().includes(query.toLowerCase()))), [report, repo, dates, query]);
  const moduleGroups = aggregateDeliveryModules(moduleRows);
  const groupRows = useMemo(() => { const groups = new Map<string, DeliveryAnalysisRow[]>(); for (const row of rows) { const key = row.parent_id ?? row.id; groups.set(key, [...(groups.get(key) ?? []), row]); } return [...groups]; }, [rows]);
  useEffect(() => setPage(0), [repo, module, dates, query]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(groupRows.length / 10) - 1));
  const selectedParent = (report?.rows ?? []).some(row => row.parent_id === selected);
  const detailRows = rows.filter(row => row.id === selected || row.parent_id === selected);
  const detail = aggregateDelivery(detailRows);
  const detailTokens = aggregateDeliveryTokens(detailRows.map(r => r.id), report?.task_tokens, selectedParent ? selected ?? undefined : undefined);
  return <div className="delivery-analysis">
    <div className="delivery-toolbar"><div className="delivery-tabs">
      {([["requirement", "需求交付"], ["issue", "DTS"], ["registration", "登记问题"], ["knowledge", "知识使用效能"]] as const).map(([key, label]) =>
        tab === key
          ? <strong key={key}>{label}</strong>
          : <button key={key} type="button" className="text-sm text-muted-foreground transition-colors hover:text-text-strong" aria-pressed={false} onClick={() => setTab(key)}>{label}</button>)}
    </div>{tab !== "knowledge" && <Button variant="outline" onClick={() => void refresh(true)} disabled={busy}><RefreshCw className={busy ? "animate-spin" : ""} />{busy ? "正在读取" : "刷新数据"}</Button>}</div>
    {tab === "requirement" && <>
    <div className="delivery-filters">
      <CompletionDateFilter value={dates} onChange={setDates} />
      <AnalysisFilter label="代码仓" value={repo} onChange={setRepo} items={[{value:"",label:"全部代码仓"}, ...[...new Set(report?.rows.map(r => r.repo).filter(Boolean))].map(r => ({value:r!,label:r!}))]} />
      <AnalysisFilter label="业务模块" value={module} onChange={setModule} items={[{value:"*",label:"全部模块"}, ...[...new Map((report?.rows ?? []).map(row => [row.business_module?.id ?? "", row.business_module?.name ?? "未关联模块"])).entries()].map(([value,label]) => ({value,label}))]} />
      <Input aria-label="搜索任务" placeholder="搜索 task ID 或需求名称" value={query} onChange={e => setQuery(e.target.value)} />
    </div>
    {error && <p role="alert" className="delivery-error">{error}</p>}
    <div className="delivery-scope"><BarChart3 size={18} /><span>团队汇总仅计已合入交付 · {summary.available} / {merged.length} 次交付有统计证据 · 按任务完成时间筛选，同一任务可多次交付，主任务不重复计数</span></div>
    <div className="delivery-overview-grid"><section className="delivery-card"><h2>交付代码来源 <span>交付代码行数：{num(summary.total)} 行</span></h2><OriginDonut counts={summary.retained} /></section>
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
      return <Fragment key={id}>{parent && <TaskMetricRow id={id} title={`${tasks[0].parent_title ?? "主任务"} · 主任务汇总`} tasks={tasks} ledger={report?.task_tokens} parent onSelect={setSelected} />}{[...new Set(tasks.map(row => row.id))].map(taskId => <TaskMetricRow key={taskId} id={taskId} title={tasks.find(row => row.id === taskId)!.title} tasks={tasks.filter(row => row.id === taskId)} ledger={report?.task_tokens} onSelect={setSelected} child={parent} />)}</Fragment>;
    })}</tbody></table></div>{groupRows.length > 10 && <div className="delivery-pagination"><span>第 {currentPage + 1} / {Math.ceil(groupRows.length / 10)} 页</span><Button variant="outline" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</Button><Button variant="outline" disabled={(currentPage + 1) * 10 >= groupRows.length} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>}{!rows.length && <p className="delivery-empty">{busy ? "正在读取交付记录…" : "当前条件下没有需求任务"}</p>}</section>
    <details className="delivery-method"><summary>统计口径与数据边界</summary><p>以最终交付差异中的新增/修改行为分母，追溯最后修改它的提交。最终差异删除行另计 {num(summary.deleted)} 行。</p><p>首次实现包含首次实际修复之前的多个提交；缺少记录时以第一条明确修复提交为界，没有修复迹象时暂按首轮实现统计。统计源码、测试、脚本及配置等交付文本；Markdown、二进制、依赖目录、构建产物和平台运行文件不计入。配置先提交也属于首轮实现。</p><p>流水线 / 检视归因来自宿主实际修复轮次及前后提交范围。能明确识别为流水线修复的归流水线，其余后续提交归检视修改；缺少记录时结合提交说明推断，并在分类依据中标明；已有明确分类不被推断覆盖。历史改写或缺少合入前快照时，该任务暂不纳入汇总。</p><p>Token 使用已有模型用量台账，输入与输出相加；主任务汇总包含自身分析及当前筛选范围的子任务，每个任务只计一次。不要求已推送或已有代码统计；没有上报的历史消耗显示暂无记录。</p><p>这不是代码质量评分；不同任务规模与范围不同。覆盖不足时请结合任务明细解读统计。采集在推送后后台进行，稍后刷新可查看结果，不阻塞开发交付。</p></details>
    <Sheet open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }}><SheetContent initialFocus={detailTitle} className="delivery-detail-sheet bg-(--surface) gap-0 data-[side=right]:w-[min(760px,58vw)] data-[side=right]:sm:max-w-[min(760px,58vw)]"><SheetHeader><SheetTitle ref={detailTitle} tabIndex={-1}>{selected} · {selectedParent ? "主任务汇总" : "交付分析"}</SheetTitle><SheetDescription>{selectedParent ? `${detailRows[0]?.parent_title ?? "主任务"} · 当前筛选范围内 ${new Set(detailRows.map(row => row.id)).size} 个子任务` : detailRows[0]?.title ?? "交付记录"}</SheetDescription></SheetHeader><div className="delivery-detail-body">{!detailRows.length ? <p>未找到该任务的交付记录。</p> : <><TaskLanguages tasks={detailRows} /><p className="delivery-scope">{selectedParent ? `已合入交付 ${detailRows.filter(r => r.merged).length}/${detailRows.length}${detailRows.some(r => !r.merged) ? " · 含未合入暂计" : ""}` : detailRows.every(r => r.merged) ? "已合入" : "进行中，以下为最近推送版本的暂计数据"} · 证据覆盖 {detail.available}/{detail.tasks}</p><section className="delivery-card"><h2>Token 消耗 <span>{selectedParent ? "含主任务自身及当前范围子任务" : "本任务累计用量"}</span></h2><div className="grid grid-cols-3 gap-4 py-4"><div>总计<strong className="block text-xl">{detailTokens.available ? num(detailTokens.total) : "—"}</strong></div><div>输入<strong className="block text-xl">{detailTokens.available ? num(detailTokens.input) : "—"}</strong></div><div>输出<strong className="block text-xl">{detailTokens.available ? num(detailTokens.output) : "—"}</strong></div></div>{detailTokens.available < detailTokens.tasks && <p className="delivery-muted">{detailTokens.available}/{detailTokens.tasks} 个任务有用量记录；未记录的历史消耗不估算。</p>}</section><section className="delivery-card"><h2>交付代码来源 <span>交付代码行数：{num(detail.total)} 行</span></h2><OriginDonut counts={detail.retained} /></section>{detailRows.map(row => <section className="delivery-card" key={`${row.id}:${row.delivery_id ?? "initial"}`}><div className="delivery-detail-heading"><h2>{row.id} · {new Date(row.at).toLocaleString("zh-CN")} · 提交记录</h2><a href={`/work/${encodeURIComponent(row.id)}`} target="_blank" rel="noreferrer">工作台 <ExternalLink size={14} /></a>{row.mr_url && <a href={row.mr_url} target="_blank" rel="noreferrer">MR <ExternalLink size={14} /></a>}</div>{row.unavailable && <p className="delivery-note">{row.unavailable}</p>}{row.metric && <><p className="delivery-muted">比较 {row.metric.base.slice(0, 8)} → {row.metric.head.slice(0, 8)} · 排除 {row.metric.excluded_files} 个非代码文本文件</p><ol className="delivery-timeline">{row.metric.commits.map(c => <li key={c.sha}><i style={{ background: categories.find(k => k.key === c.origin)?.color }} /><div><strong>{categories.find(k => k.key === c.origin)?.label}</strong><span className="delivery-commit-size">+{num(c.additions)} / −{num(c.deletions)}</span><p>{c.subject}</p>{c.origin_evidence?.length ? <details><summary>分类依据</summary>{c.origin_evidence.map((text, index) => <p key={index}>{text}</p>)}</details> : null}<small>{c.sha.slice(0, 10)} · {new Date(c.at).toLocaleString("zh-CN")}</small></div></li>)}</ol></>}</section>)}</>}</div></SheetContent></Sheet>
    </>}
    {tab === "issue" && <IssueAnalyticsTab />}
    {tab === "registration" && <RegistrationAnalyticsTab />}
    {tab === "knowledge" && <KnowledgeInsightsPanel onOpenTask={onOpenTask} />}
  </div>;
}
