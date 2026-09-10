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
import { useMemo, useRef, useState } from "react";
import {
  ISSUE_STATUS_TEXT,
  issueStageText,
  type FixedIssueStage,
  type IssueStatus,
  type IssueSummary,
} from "./api";
import { TeamIssueCard } from "./issues/TeamIssueCard";
import { STALE_AFTER_MS, issueDeliveryBreakdown } from "./teamOps";

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
 * 只按 conclusion.kind 分桶,不展开"未合入"细分——统计格要短标签)。 */
const CONCLUSION_TILES = [
  { kind: "", label: "全部闭环", tone: "neutral" },
  { kind: "delivered", label: "已交付", tone: "success" },
  { kind: "converted", label: "已转正", tone: "success" },
  { kind: "fixed", label: "已修复", tone: "active" },
  { kind: "issue", label: "问题成立", tone: "attention" },
  { kind: "non_issue", label: "非问题", tone: "neutral" },
  { kind: "canceled", label: "已取消", tone: "danger" },
] as const;

export function TeamIssueWorld({ issues, onOpenIssue }: {
  issues: IssueSummary[];
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
      className={cell === `p:${key}` ? "selected" : ""}
      disabled={count === 0} aria-pressed={cell === `p:${key}`}
      aria-controls="team-issue-queue" onClick={() => selectCell(`p:${key}`)}>
      <span>{issueStageText({ stage: key as FixedIssueStage })}</span>
      <strong>{count}</strong>
    </button>
  );
  const statusCell = (key: string, count: number) => (
    <button type="button" key={key}
      className={cell === `s:${key}` ? "selected" : ""}
      disabled={count === 0} aria-pressed={cell === `s:${key}`}
      aria-controls="team-issue-queue" onClick={() => selectCell(`s:${key}`)}>
      <span>{ISSUE_STATUS_TEXT[key as IssueStatus]}</span>
      <strong>{count}</strong>
    </button>
  );

  return <>
    <section className="team-delivery-overview" aria-label="问题处理概览">
      <header className="team-delivery-overview-head">
        <div className="team-delivery-overview-copy">
          <h2>问题处理概览</h2>
          <p>点击阶段或状态可筛选下方现场；已取消会话仅保留在成果档案。</p>
        </div>
        <div className="team-delivery-summary"
          aria-label={`问题总数 ${stats.total} 项，处理中 ${stats.active} 项，待答复 ${stats.waiting} 项，需介入 ${stats.failed} 项，已闭环 ${stats.closed} 项`}>
          <span className="summary-total" title="不含已取消会话"><strong>{stats.total}</strong><small>问题总数</small></span>
          <i aria-hidden />
          <span className="summary-active"><strong>{stats.active}</strong><small>处理中</small></span>
          <i aria-hidden />
          <span className="summary-active"><strong className={stats.waiting ? "text-attention" : undefined}>{stats.waiting}</strong><small>待答复</small></span>
          <i aria-hidden />
          <span className="summary-total"><strong className={stats.failed ? "text-danger" : undefined}>{stats.failed}</strong><small>需介入</small></span>
          <i aria-hidden />
          <span className="summary-complete"><strong>{stats.closed}</strong><small>已闭环</small></span>
        </div>
      </header>
      <div className="team-delivery-breakdown">
        <section aria-labelledby="issue-delivery-stage-title">
          <div className="delivery-breakdown-title"><strong id="issue-delivery-stage-title">阶段</strong>
            <small>当前所处流程</small></div>
          <div className="delivery-breakdown-cells">
            {stats.stages.map((entry) => stageCell(entry.key, entry.count))}
          </div>
        </section>
        <section aria-labelledby="issue-delivery-status-title">
          <div className="delivery-breakdown-title"><strong id="issue-delivery-status-title">任务状态</strong>
            <small>当前运行情况</small></div>
          <div className="delivery-breakdown-cells status-cells">
            {stats.statuses.map((entry) => statusCell(entry.key, entry.count))}
          </div>
        </section>
      </div>
    </section>

    <section className="task-section" id="team-issue-queue" ref={queueRef}
      aria-labelledby="team-issue-queue-title">
      <div className="section-head"><div>
        <h2 id="team-issue-queue-title">当前现场</h2></div>
        <span className={`section-count${anyFilter ? " active-filter" : ""}`}>
          {anyFilter ? "已筛选 · " : ""}{visible.length} / {active.length} 项
        </span>
      </div>
      <div className="task-filters" aria-label="筛选问题现场">
        <label className="task-search"><svg viewBox="0 0 18 18" aria-hidden><circle cx="8" cy="8" r="4.5" /><path d="m11.5 11.5 3 3" /></svg><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索问题、单号或负责人" /></label>
        <select aria-label="现场范围" value={scope}
          onChange={(event) => setScope(event.target.value as IssueScope)}>
          <option value="all">全部现场</option>
          <option value="action">需要处理</option>
          <option value="stale">停滞中</option>
          <option value="wip">正在推进</option>
          <option value="waiting">等你答复</option>
        </select>
        <select aria-label="责任人" value={owner}
          onChange={(event) => setOwner(event.target.value)}>
          <option value="">全部责任人</option>
          {owners.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        {anyFilter && <button type="button" className="filter-reset"
          onClick={() => { setQuery(""); setScope("all"); setOwner(""); setCell(""); }}>
          清除筛选</button>}
      </div>
      {visible.length === 0 && <div className="empty-state">
        <span className="empty-visual" aria-hidden><i /><i /><i /></span>
        <strong>{anyFilter ? "没有匹配的问题会话" : "还没有处理中的问题会话"}</strong>
        <p>{anyFilter ? "换关键词或清除筛选再看，会话没有丢。" : "登记问题或从 DTS 拉单后，现场会出现在这里。"}</p>
      </div>}
      <div className="task-list">{visible.map((issue) => (
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

  return <section className="history-board" aria-label="成果档案·问题闭环">
    <div className="history-intro">
      <div>
        <span className="section-kicker">ISSUE ARCHIVE</span>
        <h2>成果档案·问题闭环</h2>
        <p>这里保存已闭环与已取消的问题会话；处理中的回到「当前现场」查看。</p>
      </div>
    </div>
    {closed.length === 0
      ? <div className="board-empty">
          <span className="empty-database" aria-hidden><i /><i /><i /></span>
          <strong>还没有闭环的问题会话</strong>
          <p>非问题结论、修复交付与转正的会话，收口后都会归档到这里。</p>
        </div>
      : <>
        <div className="history-metrics" aria-label="问题闭环结论统计">
          {CONCLUSION_TILES.map((tile) => (
            <div className={`history-metric ${tile.tone}`} key={tile.kind || "all"}>
              <span><i aria-hidden />{tile.label}</span>
              <strong>{conclusionCount(tile.kind)}</strong>
            </div>
          ))}
        </div>
        <div className="task-list">{closed.map((issue) => (
          <TeamIssueCard key={issue.id} issue={issue}
            onOpen={() => onOpenIssue(issue.id)} />
        ))}</div>
      </>}
  </section>;
}
