/**
 * 团队看板里的问题会话卡片:IssueCard 的轻量子集,只为团队看板的
 * 扫读态服务——不拉 IssueBoard 的重组件(Registration/SessionView/
 * EventsPane),不破坏问题处理页的懒加载分包。
 *
 * 与 TaskCard 共用 task-overview-row class,列表混排视觉一致;
 * 整行可点,点击由父级接管(切到问题处理 tab + 设路由)。
 */
import { TaskOverviewRow } from "../TaskOverviewRow";
import { ISSUE_STATUS_TEXT, issueStageText, type IssueSummary } from "../api";

export function TeamIssueCard({ issue, onOpen }: {
  issue: IssueSummary;
  onOpen: () => void;
}) {
  const stageLine = [
    issueStageText(issue),
    issue.round && issue.round > 1 ? ` · 第 ${issue.round} 轮` : "",
    issue.stage_note ? ` · ${issue.stage_note}` : "",
  ].join("");
  return <TaskOverviewRow issue id={issue.id} ticket={issue.ticket}
    title={issue.title} status={issue.status} statusLabel={ISSUE_STATUS_TEXT[issue.status]}
    owner={issue.account} updatedAt={issue.updated_at} detail={stageLine} onOpen={onOpen} />;
}
