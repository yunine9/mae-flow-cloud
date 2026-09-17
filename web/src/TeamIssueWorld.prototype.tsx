/**
 * 【原型·随时可扔】团队DTS 问题处理概览·按特性分类。
 *
 * 要回答的问题:概览已有总量统计,每个特性(业务模块)的数据以什么形态
 * 进概览。三个结构不同的变体挂在 TeamIssueWorld 现有概览位,仅 dev 构建
 * 且 URL 带 ?variant=A|B|C 时现身;页底浮动切换条(←/→ 键或点击)切换。
 *
 *   A 特性格行 —— 概览格加第三行「特性」,一格一特性,与阶段/状态格同
 *              配方同交互(单选格:点特性与点阶段/状态互斥);最贴现有
 *              版式 DNA,规模最省。
 *   B 特性矩阵 —— 特性为行、指标为列的多列表(处理中/待答复/需介入/
 *              已闭环/合计),列头点击排序,行点击筛选队列;特性优先的
 *              信息层级,一屏比对多特性。
 *   C 特性钻取 —— 特性 chips 置顶,选中后整个概览(规模数字+阶段/状态
 *              格)按该特性现算;特性筛选走独立 feature 状态,与阶段/
 *              状态格筛选叠加生效(不与单选格互斥)。
 *   D 特性总账 —— 表格形态:第一行=全部特性总账,后面每行一个特性;
 *              默认只显首行,点展开元素看全部特性行,再点收起
 *              (2026-09-18 按反馈拍板方向:A/B 一眼横向对比不足)。
 *
 * 分类维度口径:问题会话上持久化的是 module(业务模块,登记必选;DTS
 * 拉单时特性/模块名经 matchDtsToModule 折算进模块),空值归「未分类」。
 * 若将来要按 DTS 原始特性名(sFeatureNoName)分类,需服务端拉单时把
 * featureName 持久化到会话——本原型先按 module 验形态。
 *
 * 每特性指标复用 teamOps 的 issueDeliveryBreakdown(与概览总数同一
 * 口径,零再推导);胜出变体定稿后折进 TeamIssueWorld 并删除本文件。
 */
import { cn } from "cn";
import { useEffect, useState } from "react";
import {
  ISSUE_STATUS_TEXT,
  issueStageText,
  type FixedIssueStage,
  type IssueOnceRate,
  type IssueStatus,
  type IssueSummary,
} from "./api";
import {
  issueDeliveryBreakdown,
  type IssueDeliveryBreakdown,
} from "./teamOps";

/** 问题会话的特性归类键(module 空白归「未分类」,与卡片/队列同源)。 */
export function moduleOf(issue: { module?: string }): string {
  return issue.module?.trim() || "未分类";
}

export interface FeatureStat {
  module: string;
  total: number;
  active: number;
  waiting: number;
  failed: number;
  closed: number;
}

/** 按特性聚合(只收未取消会话;指标与概览口径同源)。 */
export function featureStats(issues: IssueSummary[]): FeatureStat[] {
  const groups = new Map<string, IssueSummary[]>();
  for (const issue of issues) {
    if (issue.status === "canceled") continue;
    const key = moduleOf(issue);
    const bucket = groups.get(key);
    if (bucket) bucket.push(issue);
    else groups.set(key, [issue]);
  }
  return [...groups.entries()].map(([module, items]) => {
    const breakdown = issueDeliveryBreakdown(items);
    return {
      module,
      total: breakdown.total,
      active: breakdown.active,
      waiting: breakdown.waiting,
      failed: breakdown.failed,
      closed: breakdown.closed,
    };
  }).sort((a, b) => b.active - a.active || b.total - a.total
    || a.module.localeCompare(b.module, "zh-Hans-CN"));
}

// ---- 浮动切换条(仅 dev 构建;生产 import.meta.env.DEV=false 直接消失) ----

export const PROTOTYPE_VARIANTS = [
  { key: "A", name: "特性格行" },
  { key: "B", name: "特性矩阵" },
  { key: "C", name: "特性钻取" },
  { key: "D", name: "特性总账" },
] as const;

const VARIANT_EVENT = "issue-overview-prototype-variant";

function readVariant(): string | null {
  if (!import.meta.env.DEV) return null;
  const value = new URLSearchParams(window.location.search).get("variant");
  return PROTOTYPE_VARIANTS.some((entry) => entry.key === value)
    ? value : null;
}

/** 当前原型变体(无 ?variant= 或生产构建 → null=默认概览)。 */
export function usePrototypeVariant(): string | null {
  const [variant, setVariant] = useState<string | null>(readVariant);
  useEffect(() => {
    const sync = () => setVariant(readVariant());
    window.addEventListener("popstate", sync);
    window.addEventListener(VARIANT_EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(VARIANT_EVENT, sync);
    };
  }, []);
  return variant;
}

function setPrototypeVariant(key: string) {
  const url = new URL(window.location.href);
  if (key) url.searchParams.set("variant", key);
  else url.searchParams.delete("variant");
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new CustomEvent(VARIANT_EVENT));
}

export function IssuePrototypeSwitcher({ current }: { current: string }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT"
        || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const index = PROTOTYPE_VARIANTS.findIndex((v) => v.key === current);
      const delta = event.key === "ArrowRight" ? 1 : PROTOTYPE_VARIANTS.length - 1;
      const next = PROTOTYPE_VARIANTS[(index + delta) % PROTOTYPE_VARIANTS.length];
      setPrototypeVariant(next.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);
  const currentName = PROTOTYPE_VARIANTS
    .find((entry) => entry.key === current)?.name ?? current;
  return <div role="toolbar" aria-label="原型变体切换"
    className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-neutral-900/95 py-2 pl-2 pr-3 text-[13px] font-medium text-white shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
    <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-semibold text-white/80">原型</span>
    <button type="button" aria-label="上一个变体"
      className="cursor-pointer rounded-full px-2 py-0.5 hover:bg-white/15"
      onClick={() => {
        const index = PROTOTYPE_VARIANTS.findIndex((v) => v.key === current);
        setPrototypeVariant(PROTOTYPE_VARIANTS[
          (index + PROTOTYPE_VARIANTS.length - 1) % PROTOTYPE_VARIANTS.length].key);
      }}>←</button>
    <span className="min-w-[110px] text-center tabular-nums">
      {current} · {currentName}</span>
    <button type="button" aria-label="下一个变体"
      className="cursor-pointer rounded-full px-2 py-0.5 hover:bg-white/15"
      onClick={() => {
        const index = PROTOTYPE_VARIANTS.findIndex((v) => v.key === current);
        setPrototypeVariant(PROTOTYPE_VARIANTS[(index + 1) % PROTOTYPE_VARIANTS.length].key);
      }}>→</button>
    <button type="button" aria-label="退出原型(回到当前概览)"
      className="ml-1 cursor-pointer rounded-full px-1.5 text-white/60 hover:bg-white/15 hover:text-white"
      onClick={() => setPrototypeVariant("")}>✕</button>
  </div>;
}

// ---- 变体共用件(复制自 TeamIssueWorld 的格配方与指标瓦片,原型期不抽公共) ----

const CELL_BASE = "flex min-h-[38px] w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border border-line bg-surface px-[11px] py-1.5 text-left text-text transition-colors hover:border-primary/40 hover:bg-primary/5 disabled:cursor-default disabled:opacity-55";
const CELL_SELECTED = "flex min-h-[38px] w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border border-primary/60 bg-primary/10 px-[11px] py-1.5 text-left text-primary transition-colors";

function rateText(rate: number | null | undefined): string {
  return rate == null ? "—" : `${rate}%`;
}

function MetricStrip({ stats, onceRates }: {
  stats: IssueDeliveryBreakdown;
  onceRates?: IssueOnceRate;
}) {
  const onceRateTitle = (axis: "localization" | "repair"): string => {
    if (!onceRates) return "一次率统计暂不可用";
    const passed = onceRates[axis].passed;
    return axis === "localization"
      ? `一次定位 ${passed} / 完成交付 ${onceRates.total}`
        + "——分析报告只生成一版即一次定位；检视提出修改会生成新版本。"
      : `一次修复 ${passed} / 完成交付 ${onceRates.total}`
        + "——点过「验证发现问题」即非一次修复。";
  };
  return <div className="flex flex-none items-center gap-[18px]"
    aria-label={`问题总数 ${stats.total} 项，处理中 ${stats.active} 项，待答复 ${stats.waiting} 项，需介入 ${stats.failed} 项，已闭环 ${stats.closed} 项，一次定位成功率 ${rateText(onceRates?.localization.rate)}，一次修复成功率 ${rateText(onceRates?.repair.rate)}`}>
    <span className="grid min-w-[62px] justify-items-end gap-0.5" title="不含已取消会话"><strong>{stats.total}</strong><small className="whitespace-nowrap text-xs font-semibold text-muted-foreground">问题总数</small></span>
    <i aria-hidden className="h-[30px] w-px bg-line" />
    <span className="grid min-w-[62px] justify-items-end gap-0.5"><strong className="text-[25px] leading-none tracking-[-0.035em] tabular-nums text-active">{stats.active}</strong><small className="whitespace-nowrap text-xs font-semibold text-muted-foreground">处理中</small></span>
    <i aria-hidden className="h-[30px] w-px bg-line" />
    <span className="grid min-w-[62px] justify-items-end gap-0.5"><strong className={cn("text-[25px] leading-none tracking-[-0.035em] tabular-nums text-active", stats.waiting && "text-attention")}>{stats.waiting}</strong><small className="whitespace-nowrap text-xs font-semibold text-muted-foreground">待答复</small></span>
    <i aria-hidden className="h-[30px] w-px bg-line" />
    <span className="grid min-w-[62px] justify-items-end gap-0.5"><strong className={cn("text-[25px] leading-none tracking-[-0.035em] tabular-nums text-text-strong", stats.failed && "text-danger")}>{stats.failed}</strong><small className="whitespace-nowrap text-xs font-semibold text-muted-foreground">需介入</small></span>
    <i aria-hidden className="h-[30px] w-px bg-line" />
    <span className="grid min-w-[62px] justify-items-end gap-0.5"><strong className="text-[25px] leading-none tracking-[-0.035em] tabular-nums text-success">{stats.closed}</strong><small className="whitespace-nowrap text-xs font-semibold text-muted-foreground">已闭环</small></span>
    <i aria-hidden className="h-[30px] w-px bg-line" />
    <span className="grid min-w-[62px] justify-items-end gap-0.5" title={onceRateTitle("localization")}><strong className="text-[25px] leading-none tracking-[-0.035em] tabular-nums text-success">{rateText(onceRates?.localization.rate)}</strong><small className="whitespace-nowrap text-xs font-semibold text-muted-foreground">一次定位成功率</small></span>
    <i aria-hidden className="h-[30px] w-px bg-line" />
    <span className="grid min-w-[62px] justify-items-end gap-0.5" title={onceRateTitle("repair")}><strong className="text-[25px] leading-none tracking-[-0.035em] tabular-nums text-success">{rateText(onceRates?.repair.rate)}</strong><small className="whitespace-nowrap text-xs font-semibold text-muted-foreground">一次修复成功率</small></span>
  </div>;
}

/** 阶段/状态两行格(变体 A 原样、变体 C 按特性子集现算)。 */
function StageStatusRows({ stats, cell, onSelectCell }: {
  stats: IssueDeliveryBreakdown;
  cell: string;
  onSelectCell: (next: string) => void;
}) {
  const cellClass = (active: boolean) => active ? CELL_SELECTED : CELL_BASE;
  return <>
    <section aria-label="阶段" className="grid min-w-0 grid-cols-[102px_minmax(0,1fr)] items-center gap-3">
      <div className="grid gap-0.5"><strong className="text-[13.5px] text-text-strong">阶段</strong>
        <small className="text-[13px] text-muted-foreground">当前所处流程</small></div>
      <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(118px,1fr))] gap-[7px]">
        {stats.stages.map((entry) => (
          <button type="button" key={entry.key}
            className={cellClass(cell === `p:${entry.key}`)}
            disabled={entry.count === 0} aria-pressed={cell === `p:${entry.key}`}
            aria-controls="team-issue-queue"
            onClick={() => onSelectCell(`p:${entry.key}`)}>
            <span>{issueStageText({ stage: entry.key as FixedIssueStage })}</span>
            <strong>{entry.count}</strong>
          </button>
        ))}
      </div>
    </section>
    <section aria-label="任务状态" className="grid min-w-0 grid-cols-[102px_minmax(0,1fr)] items-center gap-3">
      <div className="grid gap-0.5"><strong className="text-[13.5px] text-text-strong">任务状态</strong>
        <small className="text-[13px] text-muted-foreground">当前运行情况</small></div>
      <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(118px,1fr))] gap-[7px]">
        {stats.statuses.map((entry) => (
          <button type="button" key={entry.key}
            className={cellClass(cell === `s:${entry.key}`)}
            disabled={entry.count === 0} aria-pressed={cell === `s:${entry.key}`}
            aria-controls="team-issue-queue"
            onClick={() => onSelectCell(`s:${entry.key}`)}>
            <span>{ISSUE_STATUS_TEXT[entry.key as IssueStatus]}</span>
            <strong>{entry.count}</strong>
          </button>
        ))}
      </div>
    </section>
  </>;
}

// ---- 变体 A:特性格行(概览格第三行,与阶段/状态格同配方同交互) ----

/** 特性格展示上限:超出折叠为「其他 N 项」汇总块,防长尾撑爆版面。 */
const FEATURE_CELL_CAP = 8;

export function PrototypeVariantCells({ issues, stats, onceRates, cell, onSelectCell }: {
  issues: IssueSummary[];
  stats: IssueDeliveryBreakdown;
  onceRates?: IssueOnceRate;
  cell: string;
  onSelectCell: (next: string) => void;
}) {
  const features = featureStats(issues);
  const shown = features.slice(0, FEATURE_CELL_CAP);
  const rest = features.slice(FEATURE_CELL_CAP);
  return <section className="mb-[22px] overflow-hidden rounded-[14px] border border-line bg-surface shadow-xs" aria-label="问题处理概览(原型A·特性格行)">
    <header className="flex items-center justify-between gap-8 px-5 py-[18px]">
      <div className="grid min-w-0 gap-[3px]">
        <h2 className="m-0 text-lg text-text-strong">问题处理概览</h2>
        <p className="mt-0.5 text-[13px] leading-[1.45] text-muted-foreground">点击阶段、状态或特性可筛选下方现场；已取消会话仅保留在成果档案。</p>
      </div>
      <MetricStrip stats={stats} onceRates={onceRates} />
    </header>
    <div className="grid gap-3 border-t border-line bg-surface-2/70 px-5 pt-[15px] pb-[18px]">
      <StageStatusRows stats={stats} cell={cell} onSelectCell={onSelectCell} />
      <section aria-label="特性" className="grid min-w-0 grid-cols-[102px_minmax(0,1fr)] items-center gap-3">
        <div className="grid gap-0.5"><strong className="text-[13.5px] text-text-strong">特性</strong>
          <small className="text-[13px] text-muted-foreground">按业务模块</small></div>
        <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(132px,1fr))] gap-[7px]">
          {shown.map((feature) => (
            <button type="button" key={feature.module}
              className={cell === `f:${feature.module}` ? CELL_SELECTED : CELL_BASE}
              disabled={feature.active === 0}
              aria-pressed={cell === `f:${feature.module}`}
              aria-controls="team-issue-queue"
              title={`${feature.module}：处理中 ${feature.active} · 待答复 ${feature.waiting} · 需介入 ${feature.failed} · 已闭环 ${feature.closed}`}
              onClick={() => onSelectCell(`f:${feature.module}`)}>
              <span className="min-w-0 flex-1 truncate">{feature.module}</span>
              <strong>{feature.active}</strong>
            </button>
          ))}
          {rest.length > 0 && <div className="flex min-h-[38px] items-center justify-between gap-2 rounded-lg border border-dashed border-line px-[11px] py-1.5 text-muted-foreground"
            title={`其余 ${rest.length} 个特性当前无处理中会话`}>
            <span className="min-w-0 truncate">其他 {rest.length} 项</span>
            <strong>{rest.reduce((sum, feature) => sum + feature.active, 0)}</strong>
          </div>}
        </div>
      </section>
    </div>
  </section>;
}

// ---- 变体 B:特性矩阵(特性为行、指标为列,列头排序,行点击筛选) ----

type MatrixSortKey = "module" | "active" | "waiting" | "failed" | "closed" | "total";

const MATRIX_COLUMNS: Array<{ key: MatrixSortKey; label: string }> = [
  { key: "module", label: "特性" },
  { key: "active", label: "处理中" },
  { key: "waiting", label: "待答复" },
  { key: "failed", label: "需介入" },
  { key: "closed", label: "已闭环" },
  { key: "total", label: "合计" },
];

export function PrototypeVariantMatrix({ issues, stats, onceRates, cell, onSelectCell }: {
  issues: IssueSummary[];
  stats: IssueDeliveryBreakdown;
  onceRates?: IssueOnceRate;
  cell: string;
  onSelectCell: (next: string) => void;
}) {
  const features = featureStats(issues);
  const [sort, setSort] = useState<{ key: MatrixSortKey; desc: boolean }>({
    key: "active", desc: true,
  });
  const sorted = [...features].sort((a, b) => {
    const direction = sort.desc ? -1 : 1;
    if (sort.key === "module") {
      return direction * a.module.localeCompare(b.module, "zh-Hans-CN");
    }
    return direction * (a[sort.key] - b[sort.key])
      || a.module.localeCompare(b.module, "zh-Hans-CN");
  });
  const th = (column: (typeof MATRIX_COLUMNS)[number]) => {
    const activeSort = sort.key === column.key;
    return <th key={column.key} scope="col" aria-sort={
      activeSort ? (sort.desc ? "descending" : "ascending") : undefined}
      className="p-0">
      <button type="button"
        className={cn("flex w-full cursor-pointer items-center gap-1 bg-transparent px-3 py-2 text-left text-[12.5px] font-semibold transition-colors hover:text-primary",
          column.key === "module" ? "" : "justify-end",
          activeSort ? "text-primary" : "text-muted-foreground")}
        onClick={() => setSort((current) => ({
          key: column.key,
          desc: current.key === column.key ? !current.desc : true,
        }))}>
        {column.label}{activeSort && <span aria-hidden>{sort.desc ? "↓" : "↑"}</span>}
      </button>
    </th>;
  };
  return <section className="mb-[22px] overflow-hidden rounded-[14px] border border-line bg-surface shadow-xs" aria-label="问题处理概览(原型B·特性矩阵)">
    <header className="flex items-center justify-between gap-8 px-5 py-[18px]">
      <div className="grid min-w-0 gap-[3px]">
        <h2 className="m-0 text-lg text-text-strong">问题处理概览</h2>
        <p className="mt-0.5 text-[13px] leading-[1.45] text-muted-foreground">一行一个特性，列头点击排序，点击行筛选下方现场。</p>
      </div>
      <MetricStrip stats={stats} onceRates={onceRates} />
    </header>
    <div className="border-t border-line bg-surface-2/70 px-5 pt-[13px] pb-[18px]">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line">{MATRIX_COLUMNS.map(th)}</tr>
        </thead>
        <tbody>
          {sorted.map((feature) => {
            const selected = cell === `f:${feature.module}`;
            return <tr key={feature.module}
              className={cn("cursor-pointer border-b border-line/60 transition-colors hover:bg-primary/5",
                selected && "bg-primary/10")}
              aria-pressed={selected}
              onClick={() => onSelectCell(`f:${feature.module}`)}>
              <td className={cn("max-w-[280px] truncate px-3 py-2 font-semibold",
                selected ? "text-primary" : "text-text-strong")}>{feature.module}</td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums">{feature.active}</td>
              <td className={cn("px-3 py-2 text-right tabular-nums", feature.waiting > 0 && "font-semibold text-attention")}>{feature.waiting}</td>
              <td className={cn("px-3 py-2 text-right tabular-nums", feature.failed > 0 && "font-semibold text-danger")}>{feature.failed}</td>
              <td className="px-3 py-2 text-right tabular-nums text-success">{feature.closed}</td>
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{feature.total}</td>
            </tr>;
          })}
        </tbody>
        <tfoot>
          <tr className="text-muted-foreground">
            <td className="px-3 py-2 text-[12.5px]">合计</td>
            <td className="px-3 py-2 text-right font-semibold tabular-nums">{stats.active}</td>
            <td className="px-3 py-2 text-right tabular-nums">{stats.waiting}</td>
            <td className="px-3 py-2 text-right tabular-nums">{stats.failed}</td>
            <td className="px-3 py-2 text-right tabular-nums">{stats.closed}</td>
            <td className="px-3 py-2 text-right tabular-nums">{stats.total}</td>
          </tr>
        </tfoot>
      </table>
      <div className="mt-4 grid gap-3 border-t border-line pt-3 opacity-90">
        <StageStatusRows stats={stats} cell={cell} onSelectCell={onSelectCell} />
      </div>
    </div>
  </section>;
}

// ---- 变体 D:特性总账(首行=总计,默认只显首行,展开看全部特性行) ----

export function PrototypeVariantLedger({ issues, stats, onceRates, cell, onSelectCell, initialExpanded = false }: {
  issues: IssueSummary[];
  stats: IssueDeliveryBreakdown;
  onceRates?: IssueOnceRate;
  cell: string;
  onSelectCell: (next: string) => void;
  /** 仅截图场景用:SSR 点不了展开,直接指认初始态。 */
  initialExpanded?: boolean;
}) {
  const features = featureStats(issues);
  const [expanded, setExpanded] = useState(initialExpanded);
  const toggle = () => setExpanded((value) => !value);
  return <section className="mb-[22px] overflow-hidden rounded-[14px] border border-line bg-surface shadow-xs" aria-label="问题处理概览(原型D·特性总账)">
    <header className="flex items-center justify-between gap-8 px-5 py-[18px]">
      <div className="grid min-w-0 gap-[3px]">
        <h2 className="m-0 text-lg text-text-strong">问题处理概览</h2>
        <p className="mt-0.5 text-[13px] leading-[1.45] text-muted-foreground">首行是全部特性的总账；展开逐特性对比，点击特性行筛选下方现场。</p>
      </div>
      <MetricStrip stats={stats} onceRates={onceRates} />
    </header>
    <div className="grid gap-3 border-t border-line bg-surface-2/70 px-5 pt-[15px] pb-[18px]">
      <section aria-label="特性总账" className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line bg-surface-2/70 text-left text-[12.5px] text-muted-foreground">
              <th scope="col" className="px-3 py-1.5 font-semibold">特性</th>
              <th scope="col" className="px-3 py-1.5 text-right font-semibold">处理中</th>
              <th scope="col" className="px-3 py-1.5 text-right font-semibold">待答复</th>
              <th scope="col" className="px-3 py-1.5 text-right font-semibold">需介入</th>
              <th scope="col" className="px-3 py-1.5 text-right font-semibold">已闭环</th>
              <th scope="col" className="px-3 py-1.5 text-right font-semibold">合计</th>
            </tr>
          </thead>
          <tbody>
            <tr className={cn("border-b border-line/60 transition-colors",
              features.length > 0 && "cursor-pointer hover:bg-primary/5")}
              onClick={() => features.length > 0 && toggle()}>
              <td className="px-3 py-2">
                <span className="flex items-center gap-1.5 font-semibold text-text-strong">
                  <button type="button" aria-expanded={expanded}
                    aria-label={expanded ? "收起特性明细" : `展开全部 ${features.length} 个特性`}
                    disabled={features.length === 0}
                    className="grid size-5 cursor-pointer place-items-center rounded text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:cursor-default disabled:opacity-40"
                    onClick={(event) => { event.stopPropagation(); toggle(); }}>
                    <svg viewBox="0 0 16 16" aria-hidden
                      className={cn("size-3.5 transition-transform", expanded && "rotate-180")}>
                      <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor"
                        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  全部特性
                  <span className="text-[12px] font-normal text-muted-foreground">{features.length} 个特性</span>
                </span>
              </td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums">{stats.active}</td>
              <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", stats.waiting > 0 && "text-attention")}>{stats.waiting}</td>
              <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", stats.failed > 0 && "text-danger")}>{stats.failed}</td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums text-success">{stats.closed}</td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums">{stats.total}</td>
            </tr>
            {expanded && features.map((feature) => {
              const selected = cell === `f:${feature.module}`;
              return <tr key={feature.module}
                className={cn("cursor-pointer border-b border-line/60 transition-colors last:border-b-0 hover:bg-primary/5",
                  selected && "bg-primary/10")}
                aria-pressed={selected}
                onClick={() => onSelectCell(`f:${feature.module}`)}>
                <td className={cn("max-w-[320px] truncate py-2 pl-10 pr-3",
                  selected ? "font-semibold text-primary" : "text-text-strong")}>{feature.module}</td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{feature.active}</td>
                <td className={cn("px-3 py-2 text-right tabular-nums", feature.waiting > 0 && "font-semibold text-attention")}>{feature.waiting}</td>
                <td className={cn("px-3 py-2 text-right tabular-nums", feature.failed > 0 && "font-semibold text-danger")}>{feature.failed}</td>
                <td className="px-3 py-2 text-right tabular-nums text-success">{feature.closed}</td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{feature.total}</td>
              </tr>;
            })}
          </tbody>
        </table>
      </section>
      <StageStatusRows stats={stats} cell={cell} onSelectCell={onSelectCell} />
    </div>
  </section>;
}

// ---- 变体 C:特性钻取(chips 置顶,选中后整个概览按该特性现算) ----

export function PrototypeVariantDrilldown({ issues, onceRates, feature, onSelectFeature, cell, onSelectCell }: {
  issues: IssueSummary[];
  onceRates?: IssueOnceRate;
  /** 当前钻取的特性(""=全部特性;独立于单选格,与阶段/状态格叠加)。 */
  feature: string;
  onSelectFeature: (next: string) => void;
  cell: string;
  onSelectCell: (next: string) => void;
}) {
  const features = featureStats(issues);
  const scope = feature
    ? issues.filter((issue) => moduleOf(issue) === feature)
    : issues;
  const scopeStats = issueDeliveryBreakdown(scope);
  // 「全部特性」chip 的徽标永远是全局口径(不受当前钻取影响)。
  const allStats = feature ? issueDeliveryBreakdown(issues) : scopeStats;
  const chip = (selected: boolean) => cn(
    "flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-medium transition-colors",
    selected
      ? "border-primary/60 bg-primary/10 text-primary"
      : "border-line bg-surface text-text hover:border-primary/40 hover:bg-primary/5");
  return <section className="mb-[22px] overflow-hidden rounded-[14px] border border-line bg-surface shadow-xs" aria-label="问题处理概览(原型C·特性钻取)">
    <header className="grid gap-3 px-5 pt-[16px] pb-[14px]">
      <div className="flex items-end justify-between gap-8">
        <div className="grid min-w-0 gap-[3px]">
          <h2 className="m-0 text-lg text-text-strong">问题处理概览</h2>
          <p className="mt-0.5 text-[13px] leading-[1.45] text-muted-foreground">
            {feature ? <>只看「{feature}」· 共 {scopeStats.total} 项，下方数字均为该特性口径；再点一次 chips 返回全部。</>
              : "选中特性后，整块概览与下方现场都切到该特性口径。"}</p>
        </div>
        <MetricStrip stats={scopeStats} onceRates={onceRates} />
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="特性钻取">
        <button type="button" className={chip(!feature)} aria-pressed={!feature}
          onClick={() => onSelectFeature("")}>全部特性<span className="tabular-nums opacity-70">{allStats.active}</span></button>
        {features.map((entry) => (
          <button type="button" key={entry.module}
            className={chip(feature === entry.module)}
            aria-pressed={feature === entry.module}
            title={`处理中 ${entry.active} · 待答复 ${entry.waiting} · 需介入 ${entry.failed} · 已闭环 ${entry.closed}`}
            onClick={() => onSelectFeature(feature === entry.module ? "" : entry.module)}>
            <span className="max-w-[180px] truncate">{entry.module}</span>
            <span className={cn("rounded-full px-1.5 text-[11.5px] font-semibold tabular-nums",
              entry.active > 0 ? "bg-active/15 text-active" : "bg-line/60 text-muted-foreground")}>{entry.active}</span>
          </button>
        ))}
      </div>
    </header>
    <div className="grid gap-3 border-t border-line bg-surface-2/70 px-5 pt-[15px] pb-[18px]">
      <StageStatusRows stats={scopeStats} cell={cell} onSelectCell={onSelectCell} />
    </div>
  </section>;
}
