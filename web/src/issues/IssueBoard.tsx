/**
 * 问题处理页(问题流 v2 的唯一入口)。
 *
 * 与"我的需求"完全隔离:独立分包、独立轮询、独立 API 命名空间。
 * 本文件只剩列表与组装(spec #2 按域拆分):登记在 Registration.tsx,
 * 会话工作台在 SessionView.tsx,材料页签在 MaterialsPane.tsx,现场
 * 页签在 EventsPane.tsx,协作流在 IssueConversationStream.tsx,
 * 决策卡在 IssueDecisionCard.tsx。页面两块:上方登记(手工登记/DTS
 * 列表),下方"我的问题"会话列表;点开进入会话工作台(studio 骨架:
 * 头部进度 + 左栏五标签 + 右栏协作对话框;旧右栏 NEXT ACTION 侧栏
 * 已随 #127 拆除)。前端不推断状态:一切文案来自 /issues API 镜像。
 */
import { useEffect, useState } from "react";
import {
  ISSUE_STATUS_TEXT,
  controlIssue,
  getIssue,
  issueStageText,
  listIssues,
  type AuthUser,
  type IssueDetail,
  type IssueStatus,
  type IssueSummary,
} from "../api";
import { confirmDialog } from "../ConfirmDialog";
import { Spinner } from "@/components/Spinner";
import { startVisiblePolling } from "../visiblePolling";
import { formatLocalDateTime } from "../time";
import { repoName } from "./perRepo";
import { dtsTicketUrl } from "./dtsTicket";
import { IssueRegistration } from "./Registration";
import { IssueFixedProgress, IssueSessionView } from "./SessionView";
import { Card } from "../components/ui/card";
import { cn } from "cn";

/** 列表状态筛选:默认"进行中"(只藏已归档/已取消两个收口终态——failed
 * 虽也是终态但属于"需介入",照常露面),另支持按单个状态标签过滤与全量。
 * idle 的展示已归一进「等你答复」(2026-09-08 拍板):不设独立筛选项,
 * 选「等你答复」时两者一起命中。 */
type IssueListFilter = "active" | IssueStatus | "all";
const ISSUE_FILTER_STORAGE_KEY = "mae-flow:issue-list-filter";
const ISSUE_FILTER_STATUSES: IssueStatus[] = [
  "waiting_user", "running", "queued", "suspended", "failed",
  "archived", "canceled",
];

function readIssueListFilter(): IssueListFilter {
  try {
    const saved = localStorage.getItem(ISSUE_FILTER_STORAGE_KEY);
    if (saved === "idle") return "waiting_user";
    if (saved === "active" || saved === "all") return saved;
    if (saved && ISSUE_FILTER_STATUSES.includes(saved as IssueStatus)) {
      return saved as IssueStatus;
    }
  } catch { /* localStorage 不可用(隐私模式等)就回默认,不拦列表 */ }
  return "active";
}

/** 问题处理导航的子页签(2026-09-11 拍板,spec #171):问题会话是缺省
 * 落点、排导航首位;问题登记/DTS 列表是发起域的两个面板。App 侧边栏
 * 展开组持有选择,本组件按它承接右侧页面。 */
export type IssueChildTab = "sessions" | "register" | "dts";

export function IssueBoard({ viewer, onNavigateProfile, initialOpenId = "",
  onOpenIssue, onCloseIssue, childTab, onChildTabChange }: {
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
  /** 当前子页签(App 持有并持久化;admin 恒为 sessions)。 */
  childTab: IssueChildTab;
  /** 子页签选择上报(App 写状态/持久化/历史快照)。 */
  onChildTabChange?: (tab: IssueChildTab) => void;
}) {
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [openId, setOpenId] = useState(initialOpenId);
  // App 快照是工作台开关的唯一真相:URL 侧关闭(点子页签离开、浏览器
  // 后退)同步收掉本地 openId,导航与右侧内容不错位。
  useEffect(() => { setOpenId(initialOpenId); }, [initialOpenId]);
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
    issue.status === "waiting_user" || issue.status === "idle").length;
  const interventionCount = issues.filter((issue) =>
    issue.status === "failed").length;

  const statusCounts = new Map<IssueStatus, number>();
  for (const issue of issues) {
    statusCounts.set(issue.status, (statusCounts.get(issue.status) ?? 0) + 1);
  }
  // 「等你答复」选项的计数含 idle(展示归一,计数同步归一)。
  const filterOptionCount = (status: IssueStatus) =>
    status === "waiting_user"
      ? (statusCounts.get("waiting_user") ?? 0) + (statusCounts.get("idle") ?? 0)
      : statusCounts.get(status) ?? 0;
  const visibleIssues = statusFilter === "all" ? issues
    : statusFilter === "active"
      ? issues.filter((issue) =>
          issue.status !== "archived" && issue.status !== "canceled")
      : issues.filter((issue) => statusFilter === "waiting_user"
          ? issue.status === "waiting_user" || issue.status === "idle"
          : issue.status === statusFilter);

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
        403),管理视角的这块板只读——列表全员可见,会话点开落查看模式。
        两面板常驻(visible 隐藏切换):「问题会话」子页签下也不卸载,
        表单/勾选/搜索状态跨子页签驻留(spec #171)。 */}
    {viewer.role !== "admin" && <IssueRegistration
      viewer={viewer}
      issues={issues}
      visible={childTab !== "sessions"}
      panel={childTab === "dts" ? "dts" : "manual"}
      onCreated={(created) => {
        refreshList();
        openIssue(created.id);
      }}
      onError={setError}
      onNavigateProfile={onNavigateProfile}
    />}
    <section className="issue-section" aria-labelledby="issue-mine-title"
      hidden={childTab !== "sessions"}>
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
                  {ISSUE_STATUS_TEXT[status]}({filterOptionCount(status)})
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
          <Spinner aria-hidden className="size-3 shrink-0" />
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
              onSettled={refreshList}
            />)}
          </div>}
    </section>
  </div>;
}

/** 问题列表卡(2026-09-11 拍板):点击整卡直达问题工作台——列表不再
 * 就地展开(现场直播/耗时卡点随展开移除,现场只在工作台看),右侧无
 * 展开箭头,meta 行只留直达终止(2026-09-08)与 MR/推送事实。
 * 皮肤换 shadcn Card + Tailwind 令牌工具类,与需求侧 task-card 骨架
 * 分道(混合列表口子一并撤销);内部行(overline/焦点行/阶段条)沿用
 * 既有独立类,issue-card-large 类保留作问题域胶囊配色与等待光效的
 * 锚点。焦点行只复述 API 字段(stage/round/stage_note),前端不推断状态。 */
function IssueCard({ issue, active, onOpen, onSettled }: {
  issue: IssueSummary;
  active?: boolean;
  onOpen: () => void;
  /** 终止成功后通知列表刷新(2026-09-08:列表卡直达终止,不再进工作台)。 */
  onSettled?: () => void;
}) {
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState("");
  const stageLine = [
    issueStageText(issue),
    issue.round && issue.round > 1 ? ` · 第 ${issue.round} 轮` : "",
    issue.stage_note ? ` · ${issue.stage_note} ` : "",
  ].join("");
  // 终态(已归档/已取消)没有可终止的东西,按钮不渲染;failed 仍可终止
  // 清理——与工作台头部「终止会话」同一口径。
  const terminatable = issue.status !== "archived" && issue.status !== "canceled";

  async function terminate() {
    if (!await confirmDialog({
      title: "终止会话",
      message: `将终止 ${issue.id} 并清理现场，此操作不可撤销。`,
      confirmLabel: "终止会话",
      danger: true,
    })) return;
    setStopping(true); setStopError("");
    try {
      await controlIssue(issue.id, { action: "cancel" });
      onSettled?.();
    } catch (cause) {
      setStopError(String((cause as Error).message ?? cause));
    } finally { setStopping(false); }
  }

  // 状态轨颜色:问题域状态 → 令牌工具类(旧 .status-* rail 规则随
  // task-card 皮退役;suspended 收编为令牌 --suspended,替代旧内联
  // #3b83d5;queued/archived/canceled 无轨,与旧规则一致)。
  const railClass = {
    running: "bg-active",
    waiting_user: "bg-attention",
    idle: "bg-ink",
    suspended: "bg-suspended",
    failed: "bg-danger",
  }[issue.status as "running" | "waiting_user" | "idle" | "suspended" | "failed"]
    ?? "bg-transparent";

  return <Card id={`issue-${issue.id}`}
    className={cn(
      "issue-card-large",
      `status-${issue.status}`,
      "relative overflow-hidden rounded-lg",
      "transition-colors hover:border-line-strong",
      // 边框色互斥二选一(cn 无 tailwind-merge,同类工具类不能共存,
      // 谁赢看 emit 序):focused 用强线,常态用常规线。
      active ? "border-text-strong" : "border-line",
    )}>
    <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", railClass)} />
    <button type="button" className="task-summary" onClick={onOpen}
      title="进入问题工作台">
      <span className="task-summary-body">
        <span className="task-overline">
          {/* 单号直达 DTS 门户:React 走 DOM API 建树,a 嵌在 button 里
              可用(HTML 解析禁令只管字符串建档);stopPropagation 拦住
              冒泡,点单号不会顺带打开工作台。 */}
          {issue.ticket
            ? <a className="task-ticket" href={dtsTicketUrl(issue.ticket)}
                target="_blank" rel="noreferrer"
                title={`在 DTS 门户打开 ${issue.ticket}`}
                onClick={(event) => event.stopPropagation()}>
              {issue.ticket}
            </a>
            : <span className="task-ticket empty">未绑单</span>}
          <span className="task-id" title="会话编号">{issue.id}</span>
          <span className={`pill ${issue.status}`}>
            <i aria-hidden />{ISSUE_STATUS_TEXT[issue.status]}
          </span>
          <span className="task-created">{formatLocalDateTime(issue.updated_at)}</span>
        </span>
        <strong className="task-title line-clamp-1">{issue.title}</strong>
        <span className="task-ownership">
          <span>处理人 · {issue.account}</span>
          <span>{issue.source === "dts" ? "DTS 单" : "自研问题"}</span>
        </span>
        <span className={`task-focus task-focus-${issue.stage}`}>
          <i aria-hidden />
          <strong className="font-semibold">{stageLine}</strong>
          {issue.conclusion && <span>结论 · {issueConclusionText(issue)}</span>}
        </span>
        <IssueFixedProgress issue={issue} />
      </span>
    </button>

    <div className="task-meta">
      {/* 列表直达终止(2026-09-08):不必进工作台再点;确认话术与
          工作台头部「终止会话」同款。终态卡不渲染。 */}
      {terminatable && <button type="button" className="ui-btn flat danger"
        disabled={stopping} onClick={() => void terminate()}>
        {stopping ? "终止中…" : "终止"}</button>}
      {stopError && <span className="form-message error">{stopError}</span>}
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
  </Card>;
}

function issueConclusionText(issue: IssueSummary): string {
  const kind = issue.conclusion?.kind;
  // 口径按合入事实(ADR-0022):delivered=全部 MR 已合入才记;
  // 建了 MR 未全合的 fixed 显示"已修复未合入",纯推送的显示"已修复"。
  return kind === "non_issue" ? "非问题"
    : kind === "delivered" ? "已交付"
    : kind === "converted" ? "已转正"
    : kind === "issue" ? "问题成立"
    : issue.mrs?.length ? "已修复未合入" : "已修复";
}
