/**
 * 问题处理页(问题流 v2 的唯一入口)。
 *
 * 与"我的需求"完全隔离:独立分包、独立轮询、独立 API 命名空间。
 * 本文件只剩列表与组装(spec #2 按域拆分):登记在 Registration.tsx,
 * 会话工作台在 SessionView.tsx,材料页签在 MaterialsPane.tsx,现场
 * 页签在 EventsPane.tsx;IssueRail / IssueDecisionCard 本就是独立文件。
 * 页面两块:上方登记(手工登记/DTS 列表),下方"我的问题"会话列表;
 * 点开进入会话详情——决策-centric 双栏(顶部阶段线 + 耗时卡点折叠条,
 * 左栏内容页签,右栏常驻 NEXT ACTION + 底部固死的归档与取消)。
 * 前端不推断状态:一切文案来自 /issues API 镜像。
 */
import { useEffect, useState } from "react";
import {
  ISSUE_STATUS_TEXT,
  getIssue,
  issueStageText,
  listIssues,
  type AuthUser,
  type IssueDetail,
  type IssueSummary,
} from "../api";
import { startVisiblePolling } from "../visiblePolling";
import { formatLocalDateTime } from "../time";
import { repoName } from "./perRepo";
import { IssueRegistration } from "./Registration";
import { IssueCostPanel, IssueFixedProgress, IssueSessionView } from "./SessionView";
import { IssueEventsPane } from "./EventsPane";

export function IssueBoard({ viewer, onNavigateProfile }: {
  viewer: AuthUser;
  onNavigateProfile?: () => void;
}) {
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [openId, setOpenId] = useState("");
  const [detail, setDetail] = useState<IssueDetail | undefined>();
  const [error, setError] = useState("");

  // 聚合徽章(与任务侧"当前任务"同款语义):待答复置前,需介入报警。
  const waitingCount = issues.filter((issue) =>
    issue.status === "waiting_user").length;
  const interventionCount = issues.filter((issue) =>
    issue.status === "failed").length;

  const refreshList = () => {
    void listIssues().then(setIssues).catch(() => undefined);
  };
  useEffect(() => startVisiblePolling(refreshList, 5000, document), []);

  // 打开会话时跟读详情;列表照常低频轮询。
  useEffect(() => {
    if (!openId) {
      setDetail(undefined);
      return;
    }
    let alive = true;
    const refresh = () => {
      void getIssue(openId).then((next) => {
        if (alive) setDetail(next);
      }).catch((reason) => {
        if (alive) setError(String(reason instanceof Error ? reason.message : reason));
      });
    };
    refresh();
    return () => {
      alive = false;
    };
  }, [openId]);

  // 状态/阶段/待办卡的低频刷新;执行过程的实时跟随在现场页签自己订 SSE。
  useEffect(() => startVisiblePolling(() => {
    if (!openId) return;
    void getIssue(openId).then(setDetail).catch(() => undefined);
  }, 10000, document), [openId]);

  if (openId && detail) {
    return <IssueSessionView
      detail={detail}
      onBack={() => { setOpenId(""); setDetail(undefined); }}
      onChanged={(next) => setDetail(next)}
      onListRefresh={refreshList}
      onError={setError}
      onNavigateProfile={onNavigateProfile}
      onOpenIssue={(id) => setOpenId(id)}
    />;
  }

  return <div className="issue-board">
    {error && <div className="issue-error" role="alert">
      <span>{error}</span>
      {onNavigateProfile && /未配置/.test(error)
        && <button type="button" onClick={onNavigateProfile}>
          去个人设置配置
        </button>}
      <button type="button" onClick={() => setError("")}>知道了</button>
    </div>}
    <IssueRegistration
      viewer={viewer}
      issues={issues}
      onCreated={(created) => {
        refreshList();
        setOpenId(created.id);
      }}
      onError={setError}
      onNavigateProfile={onNavigateProfile}
    />
    <section className="issue-section" aria-labelledby="issue-mine-title">
      <div className="section-head">
        <div>
          <span className="section-kicker">问题处理</span>
          <h2 id="issue-mine-title">我的问题</h2>
        </div>
        {/* 聚合徽章与任务侧"当前任务"同款语义:待答复置前,需介入报警。 */}
        <span className="current-work-counts">
          {waitingCount > 0 && <span className="section-count attention">
            {waitingCount} 项待答复</span>}
          {interventionCount > 0 && <span className="section-count danger">
            {interventionCount} 项需介入</span>}
          <span className="section-count">共 {issues.length} 个</span>
        </span>
      </div>
      {issues.length === 0
        ? <div className="review-clear current-work-empty"><span aria-hidden>✓</span><div>
            <strong>还没有问题会话</strong>
            <p>从上方登记一个"我的问题",或从 DTS 拉取问题单发起处理;
            研究结论是非问题也可以直接归档收口。</p>
          </div></div>
        : <div className="task-list">
            {issues.map((issue) => <IssueCard
              key={issue.id}
              issue={issue}
              active={openId === issue.id}
              onOpen={() => { setOpenId(issue.id); }}
            />)}
          </div>}
    </section>
  </div>;
}

/** 问题列表卡:骨架/交互与任务侧 TaskCard 同款(状态轨 + overline +
 * 焦点行 + 阶段进度 + meta 动作行 + 展开态),为将来"我的问题 × 当前
 * 任务"混合列表留口子——两张卡共用 task-* 全局类,同列渲染视觉一致。
 * 点击卡片=展开摘要;进会话走 meta 行「进入问题工作台」。
 * 焦点行只复述 API 字段(stage/round/stage_note),前端不推断状态。 */
function IssueCard({ issue, active, onOpen }: {
  issue: IssueSummary;
  active?: boolean;
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const doneIdle = issue.status === "idle" && issue.stage === "done";
  const stageLine = [
    issueStageText(issue),
    issue.mode === "fixed" && issue.round && issue.round > 1
      ? ` · 第 ${issue.round} 轮` : "",
    issue.stage_note ? ` · ${issue.stage_note}` : "",
  ].join("");

  return <article id={`issue-${issue.id}`}
    className={`task-card issue-card-large status-${issue.status}`
      + `${expanded ? " expanded" : ""}${active ? " focused" : ""}`}>
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
          {issue.status === "waiting_user" && <span className="task-created">
            等你答复</span>}
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
          {issue.conclusion && <span>结论 · {issueConclusionText(issue)}</span>}
        </span>
        {issue.mode === "fixed" && <IssueFixedProgress issue={issue} />}
      </span>
      <span className="task-chevron" aria-hidden>
        <svg viewBox="0 0 20 20">
          <path d="m7.5 5 5 5-5 5" />
        </svg>
      </span>
    </button>

    <div className="task-meta">
      <button type="button" className="panel-link" onClick={onOpen}>
        <span>进入问题工作台</span>
        <svg viewBox="0 0 16 16" aria-hidden>
          <path d="M6 3.5h6.5V10M12.25 3.75 5 11" />
        </svg>
      </button>
      {/* 多 MR 摘要:一仓一 MR,每个仓的 MR 各占一个链接(仓名 + iid),
          不再只显首个;没拿到 url 的(创建中途)如实落回文本。 */}
      {issue.mrs?.map((mr) => {
        const label = `${repoName(mr.repo)}${mr.iid ? ` !${mr.iid}` : ""}`;
        return mr.url
          ? <a key={mr.repo} href={mr.url} target="_blank" rel="noreferrer"
              title={`${mr.title}(分支 ${mr.branch})`}>
              <span>MR · {label}</span>
              <svg viewBox="0 0 16 16" aria-hidden>
                <path d="M6 3.5h6.5V10M12.25 3.75 5 11" />
              </svg>
            </a>
          : <span key={mr.repo} className="meta-fact"
              title={mr.title}>MR · {label}(分支 {mr.branch})</span>;
      })}
      {(issue.pushes?.length ?? 0) > 0 && <span className="meta-fact">
        {issue.pushes!.length === 1
          ? `已推送 · ${issue.pushes![0].branch}@${issue.pushes![0].sha.slice(0, 10)}`
          : `已推送 · ${issue.pushes!.length} 个仓`}</span>}
      {issue.error && <span className="meta-fact">{issue.error.slice(0, 80)}</span>}
    </div>

    {expanded && <div className="task-detail-body">
      {issue.status === "failed" && issue.error && (
        <div className="alert">
          <strong>会话执行失败</strong>
          <span>{issue.error}</span>
        </div>
      )}
      {doneIdle && <div className="verify-waiting">
        <strong>收口提醒</strong>
        <span>结论已出——确认 MR 合入后在会话内归档收口。</span>
      </div>}
      {issue.status === "waiting_user" && <div className="verify-waiting">
        <strong>等你处理</strong>
        <span>进入问题工作台答复问题卡 / 平台闸,会话才会继续跑。</span>
      </div>}
      <div className="task-utilities">
        <IssueEventsPane id={issue.id} active={expanded} />
        <IssueCostPanel id={issue.id} />
      </div>
    </div>}
  </article>;
}

function issueConclusionText(issue: IssueSummary): string {
  const kind = issue.conclusion?.kind;
  return kind === "non_issue" ? "非问题"
    : kind === "delivered" ? "已提 MR"
    : kind === "converted" ? "已转正"
    : kind === "issue" ? "问题成立" : "已修复";
}
