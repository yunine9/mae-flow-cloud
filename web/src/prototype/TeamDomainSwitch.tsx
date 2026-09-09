/**
 * 【原型 · 用后即弃】团队任务页「领域即标题」(2026-09-08 四稿)。
 * 页头 h1 直接就是领域下拉(需求交付/问题处理,标题样式),内容区随域
 * 整体切换:需求域=真实页面;问题域 portal 到真实面板位,复用页面现有
 * class 与真实 TeamIssueCard,阶段/任务状态出注册表全集(0 禁用)。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ISSUE_STATUS_TEXT, type IssueSummary, type TaskSummary } from "../api";
import { TeamIssueCard } from "../issues/TeamIssueCard";

type Domain = "req" | "issue";

const ISSUE_STAGE_TEXT: Record<string, string> = {
  dts_info: "单据信息", prep_repo: "代码仓准备", analyze: "分析定位",
  fix: "修复", mr_green: "MR 跑绿", conclude: "确定结论",
};
const ISSUE_DOMAIN_COLOR = "#20a28f";
/** 注册表固定顺序的全集(有单 5 段 ∪ 无单 conclude):0 计数的也显示
 * 并禁用,与需求侧"阶段格全量出、0 禁用"同一规则。 */
const ALL_ISSUE_STAGES = [
  "dts_info", "prep_repo", "analyze", "fix", "mr_green", "conclude",
] as const;
/** idle 的展示已归一进「等你答复」:格子与计数都不再单列。 */
const ALL_ISSUE_STATUSES = [
  "queued", "running", "waiting_user", "suspended", "failed",
] as const;

function issueBreakdown(issues: IssueSummary[]) {
  const live = issues.filter((issue) => issue.status !== "canceled");
  const active = live.filter((issue) => issue.status !== "archived");
  const waitingOf = (items: IssueSummary[]) =>
    items.filter((issue) =>
      issue.status === "waiting_user" || issue.status === "idle").length;
  return {
    total: live.length,
    active: active.length,
    waiting: waitingOf(active),
    failed: active.filter((issue) => issue.status === "failed").length,
    closed: live.filter((issue) => issue.status === "archived").length,
    stages: ALL_ISSUE_STAGES.map((key) => ({
      key, count: active.filter((issue) => issue.stage === key).length,
    })),
    statuses: ALL_ISSUE_STATUSES.map((key) => ({
      key,
      count: key === "waiting_user"
        ? waitingOf(active)
        : active.filter((issue) => issue.status === key).length,
    })),
  };
}

/** 问题域世界:与真实页面同位同款——概览/队列复用现有 class 与真实卡片。 */
function IssueWorld({ issues, filter, onFilter }: {
  issues: IssueSummary[]; filter: string; onFilter: (next: string) => void;
}) {
  const stats = issueBreakdown(issues);
  const live = issues.filter((issue) => issue.status !== "canceled");
  const visible = !filter ? live
    : filter.startsWith("s:")
      ? issues.filter((issue) => filter.slice(2) === "waiting_user"
          ? issue.status === "waiting_user" || issue.status === "idle"
          : issue.status === filter.slice(2))
      : live.filter((issue) => issue.stage === filter.slice(2));
  const cell = (key: string, label: string, count: number) => (
    <button type="button" key={key}
      className={filter === key ? "selected" : ""}
      disabled={count === 0} aria-pressed={filter === key}
      onClick={() => onFilter(filter === key ? "" : key)}>
      <span>{label}</span><strong>{count}</strong>
    </button>
  );
  return <div>
    <section className="team-delivery-overview" aria-label="问题处理概览(原型)">
      <header className="team-delivery-overview-head">
        <div className="team-delivery-overview-copy">
          <h2>问题处理概览</h2>
          <p>点击阶段或状态可筛选下方现场;已取消会话仅保留在档案。</p>
        </div>
        <div className="team-delivery-summary"
          aria-label={`问题总数 ${stats.total} 项,处理中 ${stats.active} 项,待答复 ${stats.waiting} 项,需介入 ${stats.failed} 项,已闭环 ${stats.closed} 项`}>
          <span className="summary-total" title="不含已取消会话"><strong>{stats.total}</strong><small>问题总数</small></span>
          <i aria-hidden />
          <span className="summary-active"><strong>{stats.active}</strong><small>处理中</small></span>
          <i aria-hidden />
          <span className="summary-active"><strong style={stats.waiting ? { color: "var(--attention)" } : undefined}>{stats.waiting}</strong><small>待答复</small></span>
          <i aria-hidden />
          <span className="summary-total"><strong style={stats.failed ? { color: "var(--danger, #c94f4f)" } : undefined}>{stats.failed}</strong><small>需介入</small></span>
          <i aria-hidden />
          <span className="summary-complete"><strong>{stats.closed}</strong><small>已闭环</small></span>
        </div>
      </header>
      <div className="team-delivery-breakdown">
        <section aria-labelledby="proto-issue-stage-title">
          <div className="delivery-breakdown-title"><strong id="proto-issue-stage-title">阶段</strong>
            <small>当前所处流程</small></div>
          <div className="delivery-breakdown-cells">
            {stats.stages.map((entry) => cell(`p:${entry.key}`,
              ISSUE_STAGE_TEXT[entry.key] ?? entry.key, entry.count))}
          </div>
        </section>
        <section aria-labelledby="proto-issue-status-title">
          <div className="delivery-breakdown-title"><strong id="proto-issue-status-title">任务状态</strong>
            <small>当前运行情况</small></div>
          <div className="delivery-breakdown-cells status-cells">
            {stats.statuses.map((entry) => cell(`s:${entry.key}`,
              ISSUE_STATUS_TEXT[entry.key as keyof typeof ISSUE_STATUS_TEXT] ?? entry.key,
              entry.count))}
          </div>
        </section>
      </div>
    </section>
    <section className="task-section" aria-labelledby="proto-issue-queue">
      <div className="section-head"><div>
        <h2 id="proto-issue-queue">当前现场</h2></div>
        <span className={`section-count${filter ? " active-filter" : ""}`}>
          {filter ? "已筛选 · " : ""}{visible.length} / {live.length} 项
        </span>
      </div>
      {visible.length === 0
        ? <div className="review-clear current-work-empty"><span aria-hidden>✓</span><div>
            <strong>没有进行中的问题会话</strong>
            <p>可以切回「全部」继续查看,会话没有丢。</p></div></div>
        : <div className="task-list">{visible.map((issue) => (
            <TeamIssueCard compact key={issue.id} issue={issue}
              onOpen={() => { /* 原型:跳转不接 */ }} />
          ))}</div>}
    </section>
  </div>;
}

export function TeamDomainSwitchPrototype({ tasks, issues }: {
  tasks: TaskSummary[]; issues: IssueSummary[];
}) {
  const [domain, setDomain] = useState<Domain>("req");
  const [filter, setFilter] = useState("");
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [titleHost, setTitleHost] = useState<HTMLElement | null>(null);
  // 问题域:在真实页签之后安一个渲染位,真实面板隐藏(不卸载,切回即恢复)。
  useEffect(() => {
    if (domain !== "issue") { setPortalTarget(null); return; }
    const nav = document.querySelector(".team-tasks-workspace > nav.team-task-tabs");
    const panel = document.querySelector<HTMLElement>(
      ".team-tasks-workspace > div[role=\"tabpanel\"]");
    if (!nav) return;
    let host = document.getElementById("proto-issue-world");
    if (!host) {
      host = document.createElement("div");
      host.id = "proto-issue-world";
      nav.insertAdjacentElement("afterend", host);
    }
    host.style.display = "";
    if (panel) panel.style.display = "none";
    setPortalTarget(host);
    return () => {
      if (panel) panel.style.display = "";
      if (host) host.style.display = "none";
    };
  }, [domain]);
  // 领域选择器就是页面标题:接管 workspace-header 的 h1(离开时恢复原文)。
  useEffect(() => {
    const h1 = document.querySelector<HTMLElement>(".workspace-header h1");
    if (!h1) return;
    const original = h1.textContent ?? "";
    h1.textContent = "";
    setTitleHost(h1);
    return () => {
      if (h1.textContent === "") h1.textContent = original;
      setTitleHost(null);
    };
  }, []);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const reqStats = {
    delivering: tasks.filter((task) =>
      task.status !== "canceled" && task.status !== "completed").length,
    delivered: tasks.filter((task) => task.status === "completed").length,
  };
  const issStats = issueBreakdown(issues);
  const accent = domain === "req" ? "var(--accent)" : ISSUE_DOMAIN_COLOR;
  // 开着时:点外面/Esc 收起。
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!triggerRef.current?.parentElement?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const esc = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const option = (value: Domain, glyph: string, name: string,
    stats: string, dot: string) => {
    const selected = domain === value;
    return <button type="button" role="option" aria-selected={selected}
      onClick={() => { setDomain(value); setFilter(""); setOpen(false); }}
      style={{ display: "flex", alignItems: "center", gap: 12, width: "100%",
        padding: "10px 12px", border: "none", borderRadius: 10, cursor: "pointer",
        textAlign: "left",
        background: selected ? `color-mix(in srgb, ${dot} 9%, transparent)` : "transparent" }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background =
          `color-mix(in srgb, ${dot} ${selected ? 14 : 7}%, transparent)`;
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background =
          selected ? `color-mix(in srgb, ${dot} 9%, transparent)` : "transparent";
      }}>
      <span aria-hidden style={{ width: 34, height: 34, borderRadius: 9, flex: "none",
        display: "grid", placeItems: "center", fontSize: 15, fontWeight: 700,
        background: `color-mix(in srgb, ${dot} 13%, transparent)`, color: dot }}>
        {glyph}
      </span>
      <span style={{ display: "grid", gap: 1, minWidth: 0 }}>
        <strong style={{ fontSize: 13.5, color: "var(--text-strong)" }}>{name}</strong>
        <small style={{ fontSize: 12, color: "var(--muted)" }}>{stats}</small>
      </span>
      {selected && <span aria-hidden style={{ marginLeft: "auto", color: dot, fontSize: 15 }}>✓</span>}
    </button>;
  };
  return <>
    {/* 标题即切换器:portal 进页头 h1;胶囊底色 + 领域色块 + 箭头给可点暗示 */}
    {titleHost && createPortal(
      <span ref={triggerRef as never} style={{ position: "relative", display: "inline-flex" }}>
        <button type="button" aria-haspopup="listbox" aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          style={{ display: "inline-flex", alignItems: "center", gap: 10,
            border: "none", cursor: "pointer", font: "inherit", color: "var(--text-strong)",
            background: "color-mix(in srgb, var(--accent) 6%, transparent)",
            padding: "4px 14px 4px 10px", borderRadius: 12, transition: "background .15s" }}
          onMouseEnter={(event) => {
            event.currentTarget.style.background =
              `color-mix(in srgb, ${accent} 12%, transparent)`;
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.background =
              "color-mix(in srgb, var(--accent) 6%, transparent)";
          }}>
          <span aria-hidden style={{ width: 12, height: 12, borderRadius: 4, background: accent }} />
          <span style={{ fontWeight: 700 }}>
            {domain === "req" ? "需求交付" : "问题处理"}
          </span>
          <span aria-hidden style={{
            fontSize: "0.5em", color: "var(--muted)",
            transform: open ? "rotate(180deg)" : "none", transition: "transform .15s",
          }}>▼</span>
        </button>
        {open && <div role="listbox" aria-label="工作流领域" style={{
          position: "absolute", top: "calc(100% + 10px)", left: 0, zIndex: 60,
          width: 320, background: "var(--surface)", border: "1px solid var(--line)",
          borderRadius: 14, boxShadow: "0 16px 40px rgba(15,18,34,.18)", padding: 6,
        }}>
          {option("req", "需", "需求交付",
            `交付中 ${reqStats.delivering} · 已交付 ${reqStats.delivered}`, "var(--accent)")}
          {option("issue", "问", "问题处理",
            `处理中 ${issStats.active} · 待答复 ${issStats.waiting} · 已闭环 ${issStats.closed}`,
            ISSUE_DOMAIN_COLOR)}
        </div>}
      </span>, titleHost)}
    {portalTarget && createPortal(<IssueWorld
      issues={issues} filter={filter} onFilter={setFilter} />, portalTarget)}
  </>;
}
