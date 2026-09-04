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
  type IssueStatus,
  type IssueSummary,
} from "../api";
import { startVisiblePolling } from "../visiblePolling";
import { formatLocalDateTime } from "../time";
import { repoName } from "./perRepo";
import { IssueRegistration } from "./Registration";
import { IssueCostPanel, IssueFixedProgress, IssueSessionView } from "./SessionView";
import { IssueEventsPane } from "./EventsPane";

/** 列表状态筛选:默认"进行中"(只藏已归档/已取消两个收口终态——failed
 * 虽也是终态但属于"需介入",照常露面),另支持按单个状态标签过滤与全量。 */
type IssueListFilter = "active" | IssueStatus | "all";
const ISSUE_FILTER_STORAGE_KEY = "mae-flow:issue-list-filter";
const ISSUE_FILTER_STATUSES: IssueStatus[] = [
  "waiting_user", "running", "idle", "queued", "suspended", "failed",
  "archived", "canceled",
];

function readIssueListFilter(): IssueListFilter {
  try {
    const saved = localStorage.getItem(ISSUE_FILTER_STORAGE_KEY);
    if (saved === "active" || saved === "all") return saved;
    if (saved && ISSUE_FILTER_STATUSES.includes(saved as IssueStatus)) {
      return saved as IssueStatus;
    }
  } catch { /* localStorage 不可用(隐私模式等)就回默认,不拦列表 */ }
  return "active";
}

export function IssueBoard({ viewer, onNavigateProfile, initialOpenId = "",
  onOpenIssue, onCloseIssue }: {
  viewer: AuthUser;
  onNavigateProfile?: () => void;
  /** 深链 /issues/:id 带进来的会话(小鲁班通知点开即达):作 openId 初值,
   * 浏览器后退/前进时也同步过来。初值由 App 层按当前 URL 对表后下发。 */
  initialOpenId?: string;
  /** 写穿归一:点卡/页内切会话与「返回列表」都交给 App 层统一写
   * issueRouteId + URL(pushState/replaceState),本组件不再直接操作
   * history——App 快照、Board openId、URL 三处状态由此保持一致。 */
  onOpenIssue: (id: string) => void;
  onCloseIssue: () => void;
}) {
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [openId, setOpenId] = useState(initialOpenId);
  const [detail, setDetail] = useState<IssueDetail | undefined>();
  /** 详情拉取是否失败过(当前 openId):失败只置横幅不清输入,加载
   * 指示停转;再点同一张卡由 detailRetry 强制重试。 */
  const [detailFailed, setDetailFailed] = useState(false);
  /** 详情强制重试计数:openIssue 点到同一张卡时 +1,并入详情 effect
   * 依赖——effect 只靠 [openId] 时同卡重复点击不会重跑,也就无从重试。 */
  const [detailRetry, setDetailRetry] = useState(0);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState<IssueListFilter>(readIssueListFilter);

  const changeStatusFilter = (next: IssueListFilter) => {
    setStatusFilter(next);
    try { localStorage.setItem(ISSUE_FILTER_STORAGE_KEY, next); } catch { /* 同上,存不进就算了 */ }
  };

  // 聚合徽章(与任务侧"当前任务"同款语义):待答复置前,需介入报警。
  // 按全量算,不跟着筛选走——告警不该因为翻历史就消失。
  const waitingCount = issues.filter((issue) =>
    issue.status === "waiting_user").length;
  const interventionCount = issues.filter((issue) =>
    issue.status === "failed").length;

  const statusCounts = new Map<IssueStatus, number>();
  for (const issue of issues) {
    statusCounts.set(issue.status, (statusCounts.get(issue.status) ?? 0) + 1);
  }
  const visibleIssues = statusFilter === "all" ? issues
    : statusFilter === "active"
      ? issues.filter((issue) =>
          issue.status !== "archived" && issue.status !== "canceled")
      : issues.filter((issue) => issue.status === statusFilter);

  const refreshList = () => {
    void listIssues().then(setIssues).catch(() => undefined);
  };
  useEffect(() => startVisiblePolling(refreshList, 5000, document), []);

  // 打开会话时跟读详情;列表照常低频轮询。openId 变化即清旧 detail
  // (上一会话的内容不许顶在新 URL 下),detailRetry 并入依赖——同一张
  // 卡重复点击也强制重拉。失败只置横幅 + detailFailed(加载指示停转),
  // 用户再点同卡即重试。
  useEffect(() => {
    if (!openId) {
      setDetail(undefined);
      setDetailFailed(false);
      return;
    }
    let alive = true;
    setDetail(undefined);
    setDetailFailed(false);
    void getIssue(openId).then((next) => {
      if (alive) setDetail(next);
    }).catch((reason) => {
      if (alive) {
        setError(String(reason instanceof Error ? reason.message : reason));
        setDetailFailed(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [openId, detailRetry]);

  // 状态/阶段/待办卡的低频刷新;执行过程的实时跟随在现场页签自己订 SSE。
  useEffect(() => startVisiblePolling(() => {
    if (!openId) return;
    void getIssue(openId).then(setDetail).catch(() => undefined);
  }, 10000, document), [openId]);

  // 浏览器后退/前进时同步 URL → openId(与任务侧 popstate 同步同款)。
  // pushState 不触发 popstate,只有用户手动后退/前进才走这里,不会反馈循环。
  useEffect(() => {
    const sync = () => {
      const match = location.pathname.match(/^\/issues\/([^/]+)\/?$/);
      let next = "";
      if (match) {
        try { next = decodeURIComponent(match[1]); }
        catch { next = match[1]; } // 坏编码按字面当 id:后端会 404,交给错误横幅
      }
      setOpenId((current) => current === next ? current : next);
    };
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);

  /** 打开会话:设本地 state,URL 与 App 层快照交给 onOpenIssue 统一写。
   * 点到已打开的同一张卡不静默返回——上一轮详情可能拉取失败
   * (effect 依赖里没有"点击"这个输入,自己不会重跑),强制重试一次。 */
  const openIssue = (id: string) => {
    if (id === openId) {
      setDetailRetry((count) => count + 1);
    }
    setOpenId(id);
    onOpenIssue(id);
  };

  /** 返回列表:清本地 state,URL 归位交给 onCloseIssue 统一写。 */
  const backToList = () => {
    setOpenId("");
    setDetail(undefined);
    onCloseIssue();
  };

  // 渲染门要求内容匹配:URL 指向的会话与已加载的 detail 必须是同一个,
  // 否则宁可回列表显示加载态——根绝"URL 是 Y、页面渲染的是 X"的错位。
  if (openId && detail?.id === openId) {
    return <IssueSessionView
      detail={detail}
      viewerUsername={viewer.username}
      onBack={backToList}
      onChanged={(next) => setDetail(next)}
      onListRefresh={refreshList}
      onError={setError}
      onNavigateProfile={onNavigateProfile}
      onOpenIssue={openIssue}
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
    {/* 发起入口仅开发者:管理员不发起问题会话(服务端对 admin POST 直接
        403),管理视角的这块板只读——列表全员可见,会话点开落查看模式。 */}
    {viewer.role !== "admin" && <IssueRegistration
      viewer={viewer}
      issues={issues}
      onCreated={(created) => {
        refreshList();
        openIssue(created.id);
      }}
      onError={setError}
      onNavigateProfile={onNavigateProfile}
    />}
    <section className="issue-section" aria-labelledby="issue-mine-title">
      <div className="section-head">
        <div>
          {/* kicker 不再重复页首大标题「问题处理」;列表区自己只有标题。 */}
          <h2 id="issue-mine-title">{viewer.role === "admin" ? "全部问题" : "我的问题"}</h2>
        </div>
        {/* 聚合徽章与任务侧"当前任务"同款语义:待答复置前,需介入报警。 */}
        <span className="current-work-counts">
          <label className="issue-list-filter">
            <span>状态</span>
            <select value={statusFilter} aria-label="按状态筛选问题会话"
              onChange={(event) =>
                changeStatusFilter(event.target.value as IssueListFilter)}>
              <option value="active">
                进行中({issues.length - (statusCounts.get("archived") ?? 0)
                  - (statusCounts.get("canceled") ?? 0)})
              </option>
              {ISSUE_FILTER_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {ISSUE_STATUS_TEXT[status]}({statusCounts.get(status) ?? 0})
                </option>
              ))}
              <option value="all">全部({issues.length})</option>
            </select>
          </label>
          {waitingCount > 0 && <span className="section-count attention">
            {waitingCount} 项待答复</span>}
          {interventionCount > 0 && <span className="section-count danger">
            {interventionCount} 项需介入</span>}
          <span className="section-count">共 {visibleIssues.length} 个</span>
          {statusFilter === "active" && issues.length > visibleIssues.length
            && <span className="section-count"
              title="已归档/已取消默认收起,把状态切到对应标签或「全部」可查看">
              已收起 {issues.length - visibleIssues.length} 个</span>}
        </span>
      </div>
      {/* 打开过渡态:openId 已设而匹配的详情未到(首次拉取中或重试中)
          时在列表位置给出明确指示,不再无声停在列表;失败后停转让位给
          顶部错误横幅,再点同一张卡即可重试。 */}
      {openId && detail?.id !== openId && !detailFailed
        && <div className="issue-open-loading" role="status">
          <i aria-hidden />
          <span>正在打开问题工作台…</span>
        </div>}
      {issues.length === 0
        ? <div className="review-clear current-work-empty"><span aria-hidden>✓</span><div>
            <strong>{viewer.role === "admin" ? "团队还没有问题会话" : "还没有问题会话"}</strong>
            <p>{viewer.role === "admin"
              ? "开发成员从各自的问题处理页发起后,这里会汇总全员会话供查看。"
              : "从上方登记一个\"我的问题\",或从 DTS 拉取问题单发起处理;研究结论是非问题也可以直接归档收口。"}</p>
          </div></div>
        : visibleIssues.length === 0
          ? <div className="review-clear current-work-empty"><span aria-hidden>✓</span><div>
              <strong>{statusFilter === "active"
                ? "没有进行中的问题会话" : "这个状态下没有问题会话"}</strong>
              <p>{statusFilter === "active"
                ? "已归档与已取消默认收起;要翻历史,把上方状态切到对应标签或「全部」。"
                : "可以切回「全部」继续查看,会话没有丢。"}</p>
            </div></div>
          : <div className="task-list">
            {visibleIssues.map((issue) => <IssueCard
              key={issue.id}
              issue={issue}
              active={openId === issue.id}
              onOpen={() => { openIssue(issue.id); }}
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
  const stageLine = [
    issueStageText(issue),
    issue.round && issue.round > 1 ? ` · 第 ${issue.round} 轮` : "",
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
        <IssueFixedProgress issue={issue} />
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
