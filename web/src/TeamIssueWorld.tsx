/**
 * 团队问题页·当前现场面板(2026-09-11 排版对齐:两域共用 App 的
 * TeamWorldTabs 页签骨架,本组件=概览+现场,成果档案拆到下方
 * TeamIssueArchive 由页签挂载;原型五稿确认形态折入)。
 *
 * 概览/队列复用需求侧 team-delivery-overview / task-section /
 * task-filters 的既有 class 体系(两域同一套版式,视觉零新债);卡片
 * 复用 TeamIssueCard(TaskOverviewRow 行形态)。概览数据走 teamOps 的
 * issueDeliveryBreakdown(与需求侧 teamDeliveryBreakdown 同构口径),
 * 阶段格出注册表全集、0 计数置灰(与需求侧同规则)。
 *
 * 队列筛选三件套与需求侧同款(搜索/现场范围/责任人),语义按问题域
 * 映射(f637a70 确认口径):需要处理=等你答复+异常;停滞中=推进中且
 * 超过 STALE_AFTER_MS 无进展;正在推进=排队+AI 处理中;等你答复含挂起。
 * 概览格筛选(阶段/状态)与之叠加生效。
 */
import { cn } from "cn";
import { useMemo, useRef, useState } from "react";
import {
  ISSUE_STATUS_TEXT,
  issueStageText,
  type FixedIssueStage,
  type IssueOnceRate,
  type IssueStatus,
  type IssueSummary,
} from "./api";
import { TeamIssueCard } from "./issues/TeamIssueCard";
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/Empty";
import { Database } from "lucide-react";
import { STALE_AFTER_MS, issueDeliveryBreakdown } from "./teamOps";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

/** 问题现场范围(需求侧 TeamScope 的问题域映射,选项语义见文件头)。 */
type IssueScope = "all" | "action" | "stale" | "wip" | "waiting";

const SCOPE_STALE_AFTER_MS = STALE_AFTER_MS;

function inScope(issue: IssueSummary, scope: IssueScope, now: number): boolean {
  if (scope === "action") {
    return ["waiting_user", "idle", "failed"].includes(issue.status);
  }
  if (scope === "stale") {
    return ["queued", "running"].includes(issue.status)
      && now - new Date(issue.updated_at).getTime() >= SCOPE_STALE_AFTER_MS;
  }
  if (scope === "wip") return ["queued", "running"].includes(issue.status);
  if (scope === "waiting") {
    return ["waiting_user", "idle", "suspended"].includes(issue.status);
  }
  return true;
}

/** 档案结论词表(镜像 IssueBoard 的 issueConclusionText 词汇,档案格
 * 只按 conclusion.kind 分桶——词表收敛后只有三档,ADR-0037)。 */
const CONCLUSION_TILES = [
  { kind: "", label: "全部闭环", tone: "neutral" },
  { kind: "delivered", label: "已交付", tone: "success" },
  { kind: "issue", label: "问题成立", tone: "attention" },
  { kind: "non_issue", label: "非问题", tone: "neutral" },
  { kind: "canceled", label: "已取消", tone: "danger" },
] as const;

/** 概览格按钮配方(原 .delivery-breakdown-cells button 家族)。 */
const CELL_BASE = "flex min-h-[38px] w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border border-line bg-surface px-[11px] py-1.5 text-left text-text transition-colors hover:border-primary/40 hover:bg-primary/5 disabled:cursor-default disabled:opacity-55";
const CELL_SELECTED = "flex min-h-[38px] w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border border-primary/60 bg-primary/10 px-[11px] py-1.5 text-left text-primary transition-colors";
/** 指标瓦片语调(原 .history-metric.{tone})。 */
const METRIC_TONE = {
  neutral: "text-muted-foreground",
  active: "text-active",
  attention: "text-attention",
  success: "text-success",
  danger: "text-danger",
} as const;

export function TeamIssueWorld({ issues, onceRates, onOpenIssue }: {
  issues: IssueSummary[];
  /** 一次率二轴(服务端 /issues/stats 聚合,前端零计算只渲染);
   * 缺席=统计暂不可用(接口失败/问题流未启用),统计格显示 —。 */
  onceRates?: IssueOnceRate;
  onOpenIssue: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<IssueScope>("all");
  const [owner, setOwner] = useState("");
  /** 概览格筛选:"p:<阶段>" | "s:<状态>"(空=不筛),与需求侧阶段/状态格同机制。 */
  const [cell, setCell] = useState("");
  const queueRef = useRef<HTMLElement>(null);
  const now = Date.now();

  const stats = useMemo(() => issueDeliveryBreakdown(issues), [issues]);
  // 现场队列只收处理中的会话:已闭环/已取消都只进档案(与需求侧
  // isCurrentTeamTask 的现场口径同构)——概览格计数(active)与队列行数
  // 因此严格一致,点格见几行就是几行。
  const active = useMemo(() => issues.filter((issue) =>
    issue.status !== "canceled" && issue.status !== "archived"), [issues]);
  const owners = useMemo(() =>
    [...new Set(active.map((issue) => issue.account))], [active]);

  // 一次率二轴瓦片:数字只来自端点(rate=null=分母 0,显示 —);
  // hover 给分子/分母与口径一句话(与既有 title 提示同款,不养弹层)。
  const rateText = (rate: number | null | undefined): string =>
    rate == null ? "—" : `${rate}%`;
  const onceRateTitle = (axis: "localization" | "repair"): string => {
    if (!onceRates) return "一次率统计暂不可用";
    const passed = onceRates[axis].passed;
    return axis === "localization"
      ? `一次定位 ${passed} / 完成交付 ${onceRates.total}`
        + "——分析报告只生成一版即一次定位；检视提出修改会生成新版本。"
      : `一次修复 ${passed} / 完成交付 ${onceRates.total}`
        + "——点过「验证发现问题」即非一次修复。";
  };

  const needle = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => active.filter((issue) => {
    if (cell) {
      if (cell.startsWith("s:")) {
        const status = cell.slice(2);
        if (!(status === "waiting_user"
          ? issue.status === "waiting_user" || issue.status === "idle"
          : issue.status === status)) return false;
      } else if (issue.stage !== cell.slice(2)) return false;
    }
    if (scope !== "all" && !inScope(issue, scope, now)) return false;
    if (owner && issue.account !== owner) return false;
    if (needle) {
      const haystack = `${issue.title} ${issue.ticket ?? ""} ${issue.account}`
        .toLocaleLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
    // now 刻意不进依赖:筛选语义跟渲染帧走,与需求侧同款(每次渲染重算)。
  }), [active, cell, scope, owner, needle]);
  const anyFilter = Boolean(cell || query || scope !== "all" || owner);

  /** 点概览格:选中/取消 + 联动滚动到队列(与需求侧 selectPhase 同款)。 */
  function selectCell(next: string) {
    setCell((current) => current === next ? "" : next);
    requestAnimationFrame(() => queueRef.current?.scrollIntoView({
      behavior: "smooth", block: "start",
    }));
  }

  const stageCell = (key: string, count: number) => (
    <button type="button" key={key}
      className={cell === `p:${key}` ? CELL_SELECTED : CELL_BASE}
      disabled={count === 0} aria-pressed={cell === `p:${key}`}
      aria-controls="team-issue-queue" onClick={() => selectCell(`p:${key}`)}>
      <span>{issueStageText({ stage: key as FixedIssueStage })}</span>
      <strong>{count}</strong>
    </button>
  );
  const statusCell = (key: string, count: number) => (
    <button type="button" key={key}
      className={cell === `s:${key}` ? CELL_SELECTED : CELL_BASE}
      disabled={count === 0} aria-pressed={cell === `s:${key}`}
      aria-controls="team-issue-queue" onClick={() => selectCell(`s:${key}`)}>
      <span>{ISSUE_STATUS_TEXT[key as IssueStatus]}</span>
      <strong>{count}</strong>
    </button>
  );

  return <>
    <section className="mb-[22px] overflow-hidden rounded-[14px] border border-line bg-surface shadow-xs" aria-label="问题处理概览">
      <header className="flex items-center justify-between gap-8 px-5 py-[18px]">
        <div className="grid min-w-0 gap-[3px]">
          <h2 className="m-0 text-lg text-text-strong">问题处理概览</h2>
          <p className="mt-0.5 text-[13px] leading-[1.45] text-muted-foreground">点击阶段或状态可筛选下方现场；已取消会话仅保留在成果档案。</p>
        </div>
        <div className="flex flex-none items-center gap-[18px]"
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
        </div>
      </header>
      <div className="grid gap-3 border-t border-line bg-surface-2/70 px-5 pt-[15px] pb-[18px]">
        <section aria-labelledby="issue-delivery-stage-title" className="grid min-w-0 grid-cols-[102px_minmax(0,1fr)] items-center gap-3">
          <div className="grid gap-0.5"><strong id="issue-delivery-stage-title" className="text-[13.5px] text-text-strong">阶段</strong>
            <small className="text-[13px] text-muted-foreground">当前所处流程</small></div>
          <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(118px,1fr))] gap-[7px]">
            {stats.stages.map((entry) => stageCell(entry.key, entry.count))}
          </div>
        </section>
        <section aria-labelledby="issue-delivery-status-title" className="grid min-w-0 grid-cols-[102px_minmax(0,1fr)] items-center gap-3">
          <div className="grid gap-0.5"><strong id="issue-delivery-status-title" className="text-[13.5px] text-text-strong">任务状态</strong>
            <small className="text-[13px] text-muted-foreground">当前运行情况</small></div>
          <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(118px,1fr))] gap-[7px]">
            {stats.statuses.map((entry) => statusCell(entry.key, entry.count))}
          </div>
        </section>
      </div>
    </section>

    <section className="mt-1" id="team-issue-queue" ref={queueRef}
      aria-labelledby="team-issue-queue-title">
      <div className="mb-3 flex items-baseline justify-between gap-4"><div>
        <h2 id="team-issue-queue-title" className="text-lg font-bold text-text-strong">当前现场</h2></div>
        <span className="text-[13px] font-medium tabular-nums text-muted-foreground">
          {anyFilter ? "已筛选 · " : ""}{visible.length} / {active.length} 项
        </span>
      </div>
      <div className="my-[13px] mb-[11px] flex items-center gap-[7px] rounded-[11px] border border-line bg-surface/90 p-2" aria-label="筛选问题现场">
        <label className="flex min-w-[220px] flex-1 items-center gap-2 px-[9px]"><svg viewBox="0 0 18 18" aria-hidden className="size-[15px] fill-none stroke-faint stroke-[1.5]"><circle cx="8" cy="8" r="4.5" /><path d="m11.5 11.5 3 3" /></svg><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索问题、单号或负责人" className="min-w-0 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:border-transparent focus-visible:ring-0" /></label>
        <Select value={scope}
          items={[{ value: "all", label: "全部现场" }, { value: "action", label: "需要处理" }, { value: "stale", label: "停滞中" }, { value: "wip", label: "正在推进" }, { value: "waiting", label: "等你答复" }]}
          onValueChange={(value) => setScope((value ?? "all") as IssueScope)}>
          <SelectTrigger className="min-w-28" aria-label="现场范围"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">全部现场</SelectItem>
              <SelectItem value="action">需要处理</SelectItem>
              <SelectItem value="stale">停滞中</SelectItem>
              <SelectItem value="wip">正在推进</SelectItem>
              <SelectItem value="waiting">等你答复</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select value={owner}
          items={[{ value: "", label: "全部责任人" },
            ...owners.map((name) => ({ value: name, label: name }))]}
          onValueChange={(value) => setOwner(value ?? "")}>
          <SelectTrigger className="min-w-28" aria-label="责任人"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="">全部责任人</SelectItem>
              {owners.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
            </SelectGroup>
          </SelectContent>
        </Select>
        {anyFilter && <button type="button"
          className="h-[34px] cursor-pointer rounded-[7px] border-0 bg-primary/10 px-[11px] text-[13px] font-bold text-primary"
          onClick={() => { setQuery(""); setScope("all"); setOwner(""); setCell(""); }}>
          清除筛选</button>}
      </div>
      {visible.length === 0 && <Empty className="py-11" role="status">
        <EmptyTitle>{anyFilter ? "没有匹配的问题会话" : "还没有处理中的问题会话"}</EmptyTitle>
        <EmptyDescription>{anyFilter ? "换关键词或清除筛选再看，会话没有丢。" : "登记问题或从 DTS 拉单后，现场会出现在这里。"}</EmptyDescription>
      </Empty>}
      <div className="grid gap-2">{visible.map((issue) => (
        <TeamIssueCard key={issue.id} issue={issue}
          onOpen={() => onOpenIssue(issue.id)} />
      ))}</div>
    </section>
  </>;
}

/** 成果档案·问题闭环(2026-09-11 排版对齐:骨架镜像需求侧 HistoryBoard
 * ——history-board + history-intro + history-metrics + 空态同款
 * board-empty;行仍用 TeamIssueCard,需求侧档案是逐任务表格行、问题侧
 * 是会话卡,内容差异,版式同构)。 */
export function TeamIssueArchive({ issues, onOpenIssue }: {
  issues: IssueSummary[];
  onOpenIssue: (id: string) => void;
}) {
  // 成果档案·问题闭环:conclusion 维度归档统计(已闭环 + 已取消)。
  const closed = useMemo(() => issues.filter((issue) =>
    issue.status === "archived" || issue.status === "canceled"), [issues]);
  const conclusionCount = (kind: string) => kind === ""
    ? closed.length
    : kind === "canceled"
      ? closed.filter((issue) => issue.status === "canceled").length
      : closed.filter((issue) => issue.conclusion?.kind === kind).length;

  return <section className="grid gap-4" aria-label="成果档案·问题闭环">
    <div className="flex items-center justify-between gap-6 rounded-xl border border-line
      bg-surface px-6 py-[22px] shadow-xs">
      <div>
        <h2 className="text-lg font-bold text-text-strong">成果档案·问题闭环</h2>
        <p className="mt-[7px] text-sm text-muted-foreground">这里保存已闭环与已取消的问题会话；处理中的回到「当前现场」查看。</p>
      </div>
    </div>
    {closed.length === 0
      ? <Empty className="min-h-[360px] border" role="status">
          <EmptyMedia variant="icon"><Database aria-hidden /></EmptyMedia>
          <EmptyTitle>还没有闭环的问题会话</EmptyTitle>
          <EmptyDescription>非问题结论、修复交付与转正的会话，收口后都会归档到这里。</EmptyDescription>
        </Empty>
      : <>
        <div className="mb-4 grid grid-cols-2 gap-2.5 min-[1081px]:grid-cols-5" aria-label="问题闭环结论统计">
          {CONCLUSION_TILES.map((tile) => (
            <div key={tile.kind || "all"}
              className={`flex min-h-[94px] flex-col justify-between rounded-lg border border-line bg-surface px-[15px] py-3.5 shadow-xs ${METRIC_TONE[tile.tone]}`}>
              <span className="flex items-center gap-[7px] text-[13px] font-semibold">
                <i aria-hidden className="size-2 rounded-full bg-current" />{tile.label}</span>
              <strong className="text-[27px] leading-none tabular-nums text-text-strong">{conclusionCount(tile.kind)}</strong>
            </div>
          ))}
        </div>
        <div className="grid gap-2">{closed.map((issue) => (
          <TeamIssueCard key={issue.id} issue={issue}
            onOpen={() => onOpenIssue(issue.id)} />
        ))}</div>
      </>}
  </section>;
}
