/**
 * 团队看板里的问题会话卡片:IssueCard 的轻量子集,只为团队看板的
 * 扫读态服务——不拉 IssueBoard 的重组件(Registration/SessionView/
 * EventsPane),不破坏问题处理页的懒加载分包。
 *
 * 与 TaskCard 共用 task-card 全系 class,列表混排视觉一致。收起态
 * 展示:状态轨/单号/pill/时间/标题/处理人/阶段线;展开态多一条
 * "进入问题工作台"入口。点击由父级接管(切到问题处理 tab + 设路由)。
 */
import { useState } from "react";
import {
  ISSUE_STATUS_TEXT,
  issueStageText,
  type IssueSummary,
} from "../api";
import { formatLocalDateTime } from "../time";

export function TeamIssueCard({ issue, onOpen }: {
  issue: IssueSummary;
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const stageLine = [
    issueStageText(issue),
    issue.round && issue.round > 1 ? ` · 第 ${issue.round} 轮` : "",
    issue.stage_note ? ` · ${issue.stage_note}` : "",
  ].join("");

  return <article id={`issue-${issue.id}`}
    className={`task-card issue-card-large status-${issue.status}`
      + `${expanded ? " expanded" : ""}`}>
    <button type="button" className="task-summary"
      onClick={() => setExpanded((open) => !open)} aria-expanded={expanded}>
      <span className="task-status-rail" aria-hidden />
      <span className="task-summary-body">
        <span className="task-overline">
          {issue.ticket
            ? <span className="task-ticket">{issue.ticket}</span>
            : <span className="task-ticket empty">未绑单</span>}
          <span className="task-id" title="会话编号">{issue.id}</span>
          <span className={`pill ${issue.status}`}>
            <i aria-hidden />{ISSUE_STATUS_TEXT[issue.status]}
          </span>
          <span className="task-created">{formatLocalDateTime(issue.updated_at)}</span>
        </span>
        <strong className="task-title">{issue.title}</strong>
        <span className="task-ownership">
          <span>处理人 · {issue.account}</span>
          <span>{issue.source === "dts" ? "DTS 单" : "自研问题"}</span>
        </span>
        <span className={`task-focus task-focus-${issue.stage}`}>
          <i aria-hidden />
          <strong>{stageLine}</strong>
          {issue.conclusion && <span>结论 · {issue.conclusion.kind === "non_issue" ? "非问题"
            : issue.conclusion.kind === "delivered" ? "已提 MR"
            : issue.conclusion.kind === "converted" ? "已转正"
            : issue.conclusion.kind === "issue" ? "问题成立" : "已修复"}</span>}
        </span>
      </span>
      <span className="task-chevron" aria-hidden>
        <svg viewBox="0 0 20 20"><path d="m7.5 5 5 5-5 5" /></svg>
      </span>
    </button>
    {expanded && <div className="task-meta">
      <button type="button" className="panel-link" onClick={onOpen}>
        <span>进入问题工作台</span>
        <svg viewBox="0 0 16 16" aria-hidden><path d="M6 3.5h6.5V10M12.25 3.75 5 11" /></svg>
      </button>
    </div>}
  </article>;
}
