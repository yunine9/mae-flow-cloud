/**
 * 会话域:会话工作台全屏视图(头部 / 阶段线 / 逐仓交付 / 耗时卡点 / 双栏)。
 *
 * 从 IssueBoard.tsx 原文搬移(spec #2 按域拆分,纯搬移零行为变化):
 * 固定流程画计划线(IssueFixedProgress,列表卡也复用),自由模式画
 * 旅程线(IssueJourneyTrail);右栏 NEXT ACTION 在 IssueRail(独立
 * 文件),左栏材料页签在 MaterialsPane.tsx、现场页签在 EventsPane.tsx。
 * 耗时卡点(IssueCostPanel)同时被列表卡的展开态复用,也从这里出。
 *
 * 查看模式(docs/issue-session-view-mode.md):登录用户 ≠ 会话归属人
 * 即只读围观——四个信息面(概要+时间线、材料只读浏览、事件流直播、
 * 耗时卡点)完整保留,全部操作控件不渲染(不是点了报错),顶部一条
 * 「查看模式」标识。归属人打开自己的会话零行为变化。
 */
import { useEffect, useMemo, useState } from "react";
import {
  GIT_AUTH_ERROR_TAG,
  ISSUE_STATUS_TEXT,
  answerIssue,
  associateIssueTicket,
  attachIssueEnvironment,
  bindIssueTicket,
  controlIssue,
  fixedStageList,
  getIssue,
  getIssueTimeline,
  issueStageText,
  replyIssue,
  steerIssue,
  type DtsTicketDetail,
  type IssueDetail,
  type IssueEnvironmentForm,
  type IssueStageState,
  type IssueSummary,
  type IssueTimeline,
} from "../api";
import { formatWait } from "../taskTime";
import { formatLocalClock } from "../time";
import { confirmDialog } from "../ConfirmDialog";
import {
  repoDeliveryRows,
  repoPipelineBadge,
  repoRole,
  type RepoDeliveryRow,
  type RepoLedgerInput,
} from "./perRepo";
import { IssueRail } from "./IssueRail";
import { IssueMaterialsPane } from "./MaterialsPane";
import { IssueEventsPane } from "./EventsPane";

export function IssueSessionView({
  detail,
  viewerUsername,
  onBack,
  onChanged,
  onListRefresh,
  onError,
  onNavigateProfile,
  onOpenIssue,
}: {
  detail: IssueDetail;
  /** 当前登录用户名:与会话归属人(detail.account)比对出查看模式。
   * 缺席(auth 关闭的演示形态)按可操作处理,保持既有行为。 */
  viewerUsername?: string;
  onBack: () => void;
  onChanged: (detail: IssueDetail) => void;
  onListRefresh: () => void;
  onError: (message: string) => void;
  onNavigateProfile?: () => void;
  /** 转正等场景直接跳到另一个会话(如新生的有单会话)。 */
  onOpenIssue: (id: string) => void;
}) {
  const [ticket, setTicket] = useState("");
  const [busy, setBusy] = useState(false);
  // 左栏页签:默认"现场"(AI 干活的直播面),用户手选优先;换会话重置。
  // 发言不靠页签——右栏 NEXT ACTION 六态常驻输入,现场只管看。
  const [tab, setTab] = useState<"materials" | "events">("events");
  // 材料子视图提到会话层:右栏"分析报告已产出"要能一步跳到该子视图。
  const [materialsView, setMaterialsView] = useState<
    "dts" | "changes" | "logs" | "doc">("changes");

  useEffect(() => {
    // 换一个会话就丢弃手选页签与材料子视图,回到默认入口。
    setTab("events");
    setMaterialsView("changes");
  }, [detail.id]);

  useEffect(() => {
    // 会话视图是全屏工作台(与任务侧 workspace-overlay 同款):锁页面
    // 滚动,Escape 直接回到列表——现场面积优先,少一次瞄准返回钮。
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [onBack]);

  // 查看模式判定:登录用户 ≠ 会话归属人即只读围观。口径是问题域自己的
  // 「人人可看、归属人操作」(CONTEXT.md「查看模式」),管理员不例外——
  // 「管理员不处理问题单」的边界不因可见性放开而变(与任务侧 canOperate
  // 的差异:那边管理员可操作,这边明说不写)。viewer 缺席(auth 关闭的
  // 演示形态)按可操作处理,保持既有行为。
  const canOperate = !viewerUsername || viewerUsername === detail.account;

  async function perform(action: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    try {
      await action();
      const next = await getIssue(detail.id);
      onChanged(next);
      onListRefresh();
      return true;
    } catch (reason) {
      onError(String(reason instanceof Error ? reason.message : reason));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // 等待卡两源:平台闸(固定流程的人工硬闸)优先,Agent 问题卡兜底;
  // 决策卡只在 status=waiting_user 且卡在场时画,轮询半拍不画。
  // gate_kind/scope 随卡带给决策卡:env_needed 在那里换专用环境表单。
  const gateCard = detail.status === "waiting_user" && detail.gate
    ? {
        waiting_id: detail.gate.id,
        state_version: detail.gate.state_version,
        question: detail.gate.question,
        context: detail.gate.context,
        created_at: detail.gate.created_at,
        gate_kind: detail.gate.kind,
        gate_scope: detail.gate.scope,
      }
    : undefined;
  const waiting = gateCard
    ?? (detail.status === "waiting_user" ? detail.waiting : undefined);
  // 阶段轨迹:按转移账实际发生顺序画——问题阶段是动态的,这是一条
  // "旅程线"而非"计划线":只画走过的节点,不补未来占位。
  const trail = (detail.transitions ?? []).filter((entry) => entry.stage);

  /** 问题卡作答:decision=人话文本;code=平台闸决策码(裁决协议);
   * answers=Agent 卡逐题作答(码或自由文本)。统一经 answerIssue 提交。 */
  async function answer(
    decision: string,
    code?: string,
    answers?: Record<string, string>,
    notes?: string,
  ): Promise<boolean> {
    if (!waiting) return false;
    return perform(() => answerIssue(detail.id, {
      state_version: waiting.state_version,
      decision,
      ...(code ? { code } : {}),
      ...(answers ? { answers } : {}),
      ...(notes ? { notes } : {}),
    }));
  }
  /** env_needed 闸的专用提交口(POST /issues/:id/environment):密码只在
   * 这一次请求里过网、只进服务端 vault,成功后 perform 会带新详情回来。 */
  const attachEnvironment = (input: IssueEnvironmentForm) =>
    perform(() => attachIssueEnvironment(detail.id, input));
  const sendReply = (text: string) => perform(() => replyIssue(detail.id, text));
  const sendSteer = (text: string) => perform(() => steerIssue(detail.id, text));
  /** 快速修改后请 AI 复核:运行中走插话,空闲走续聊——都走现有通道,
   * 不另开会话干预口。等待人工决策时不可用(先把卡答了)。 */
  const notifyAI = (text: string) => detail.status === "running"
    ? sendSteer(text) : sendReply(text);
  /** 挂起会话关联单号转正:两段式(校验过目 → 确认),转正后跳新会话。
   * 不走 perform:需要把 API 结果(单据详情/新会话)交回关联卡。 */
  async function associate(ticket: string, confirm: boolean):
      Promise<{ ticket_detail?: DtsTicketDetail; converted?: IssueSummary }> {
    if (busy) return {};
    setBusy(true);
    try {
      const result = await associateIssueTicket(detail.id, { ticket, confirm });
      if (result.converted) {
        onListRefresh();
        onOpenIssue(result.converted.id);
      } else {
        const next = await getIssue(detail.id);
        onChanged(next);
      }
      return result;
    } catch (reason) {
      onError(String(reason instanceof Error ? reason.message : reason));
      return {};
    } finally {
      setBusy(false);
    }
  }
  async function archive() {
    if (!await confirmDialog({
      title: "归档会话",
      message: "归档后会话收口不可续聊，凭据将清理。",
      confirmLabel: "归档",
    })) return;
    void perform(() => controlIssue(detail.id, { action: "archive" }));
  }
  async function cancelSession() {
    if (!await confirmDialog({
      title: "终止会话",
      message: "将终止会话并清理现场，此操作不可撤销。",
      confirmLabel: "终止会话",
      danger: true,
    })) return;
    void perform(() => controlIssue(detail.id, { action: "cancel" }));
  }

  // 全屏工作台(与任务侧 workspace-overlay 同款):头部之外全部进
  // 可滚动的现场体,横屏下信息面积拉满。
  return <section className="workspace-overlay issue-workspace" role="dialog"
    aria-modal="true" aria-label={`问题会话:${detail.title}`}>
    <div className="issue-session-head">
      <button type="button" className="issue-back" onClick={onBack}>
        ← 返回我的问题(Esc)
      </button>
      <div className="issue-session-title">
        <strong>{detail.title}</strong>
        {/* 查看模式标识(非归属人围观):徽标样式沿用 issue-mode 的
            身份徽标语言,文本即 aria 信息(读屏直读 span 文本)。 */}
        {!canOperate && <span className="issue-view-mode" role="status"
          title="你正在查看归属人的问题会话:操作控件已隐藏,信息面完整可看">
          查看模式:归属人 {detail.account} 的会话
        </span>}
        <span className={`issue-status status-${detail.status}`}>
          {ISSUE_STATUS_TEXT[detail.status]}
        </span>
        <span className={`issue-mode mode-${detail.mode ?? "free"}`}>
          {detail.mode === "fixed" ? "固定流程" : "自由探索"}
        </span>
        <span className="issue-stage">
          {issueStageText(detail)}
          {detail.mode === "fixed" && detail.round && detail.round > 1
            ? `(第 ${detail.round} 轮)` : ""}
          {detail.stage_note ? ` · ${detail.stage_note}` : ""}
        </span>
        {/* 登记元信息的网管环境常驻上屏(问"问题发生在哪个网管"不用翻
            现场;ADR-0003:账号非密可上屏,密码本体只在 vault)。样式借
            issue-stage 的行尾弱化文本。闸现场补配的环境没有页面凭据,
            页面账号缺席就不占位。 */}
        {detail.environment && <span className="issue-stage"
          title="登记元信息里的网管环境(密码在平台加密保管,不上屏)">
          网管环境 {detail.environment.hosts.join("、")}
          {` · 端口 ${detail.environment.port}`}
          {detail.environment.page_account
            ? ` · 页面账号 ${detail.environment.page_account}` : ""}
        </span>}
      </div>
      <div className="issue-session-ticket">
        {detail.ticket
          ? <span className="issue-ticket">{detail.ticket}</span>
          : detail.mode === "fixed"
            // 固定流程没有"中途绑单":无单会话走结论→挂起→关联转正。
            // 「无单场景」是状态说明不是控件,查看模式照常示人。
            ? <span className="issue-ticket empty">无单场景</span>
            // 绑单输入是写操作:查看模式整块不渲染(单号本身仍会
            // 在绑定后如实陈列)。
            : canOperate && <span className="issue-bind">
                <input value={ticket} placeholder="绑定 DTS 单号"
                  onChange={(event) => setTicket(event.target.value)} />
                <button type="button" disabled={!ticket.trim() || busy}
                  onClick={() => perform(() => bindIssueTicket(detail.id, ticket.trim()))}>
                  绑定
                </button>
              </span>}
        <span className="issue-bind-hint" title="推送与提 MR 的门票是单号;研究阶段不需要">
          {detail.ticket ? "" : detail.mode === "fixed"
            ? "结论为问题时挂起,关联单号后转正"
            : "提 MR 前必须绑定单号"}
        </span>
        <button type="button" className="issue-export" disabled={busy}
          title="导出现场记录(Markdown:人粗读 + AI 精读复盘)"
          onClick={() => {
            // 同源 GET 自带 cookie,download 属性强制落盘;文件名本地拼,
            // 服务端 disposition 只对 curl/直连生效。
            const anchor = document.createElement("a");
            anchor.href = `/issues/${detail.id}/export`;
            anchor.download = `${detail.id}-现场记录-`
              + `${new Date().toISOString().slice(0, 10)}.md`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
          }}>导出现场记录</button>
      </div>
    </div>

    <div className="issue-workspace-body">
    {/* 固定流程:只留计划线——全阶段一条,走到哪亮到哪,当前阶段脉冲
        呼吸(2026-08-28 拍板:固定流程下旅程线与计划线信息重复,省一行);
        自由模式仍是旅程线(走过的才画——账实序是自由模式唯一真相)。 */}
    {detail.mode === "fixed"
      ? <IssueFixedProgress issue={detail} />
      : <IssueJourneyTrail trail={trail} />}

    {/* done ≠ 归档的引导迁到右栏绿卡;顶部横幅随之删除(决策-centric)。 */}
    {detail.error && <div className="issue-session-error" role="alert">
      <span>{detail.error}</span>
      {/* 认证类报错带机器标记(issueGit.ts 的 GIT_AUTH_ERROR_TAG,常量
          镜像在 api.ts):命中即给一键跳转;人话改字不影响识别。
          跳转修的是归属人的凭据,查看模式不渲染这条补救入口。 */}
      {canOperate && onNavigateProfile && detail.error.includes(GIT_AUTH_ERROR_TAG)
        && <button type="button" className="issue-error-action"
          onClick={onNavigateProfile}>去个人设置配置令牌</button>}
    </div>}
    {/* 逐仓交付区:每个关联仓一张卡(仓名/角色/MR/分支/流水线状态)。
        事实全部由 perRepo.ts 从 API 字段派生,组件只渲染。 */}
    <IssueRepoDelivery detail={detail} />

    <IssueCostPanel id={detail.id} />

    {/* 决策-centric 双栏:左=内容(页签),右=下一步动作。窄屏单列时
        右栏靠 order 提到内容之上,见 style.css 的 1100px 断点。 */}
    <div className="issue-two-pane">
      <section className="issue-main-pane" aria-label="会话内容">
        <IssuePaneTabs tab={tab} onPick={setTab} />
        {tab === "materials"
          ? <IssueMaterialsPane detail={detail} busy={busy} view={materialsView}
              onView={setMaterialsView} onNotifyAI={notifyAI}
              canOperate={canOperate} />
          : <IssueEventsPane id={detail.id} active />}
      </section>
      <IssueRail
        detail={detail}
        busy={busy}
        canOperate={canOperate}
        waiting={waiting}
        onAnswer={answer}
        onReply={sendReply}
        onSteer={sendSteer}
        onArchive={archive}
        onCancel={cancelSession}
        onOpenDoc={() => { setTab("materials"); setMaterialsView("doc"); }}
        onAssociate={associate}
        onEnvironment={attachEnvironment}
      />
    </div>
    </div>
  </section>;
}

/** 转正前账的只读引用缓存(模块级,跨会话视图重挂载不重复请求):
 * converted 会话按 inherited_accounts 经既有详情接口读旧会话账(#31)。
 * 归档会话本就可只读(list/get 不拦终态,归属校验同账号放行),不另设
 * 端点。值:账对象=取到;null=取过但失败(旧会话被物理清理等)——
 * 失败一次就不再重试,仓卡静默退回现状,不报错、不空转。 */
const inheritedLedgerCache = new Map<string, RepoLedgerInput | null>();

/** 拉转正前账(按 inherited_accounts 只读引用旧会话详情):返回
 * undefined = 无引用 / 还没取到 / 已判缺失,仓卡一律按现状渲染。 */
function useInheritedLedger(
  ref: { issue: string } | undefined,
): RepoLedgerInput | undefined {
  const [ledger, setLedger] = useState<RepoLedgerInput | undefined>();
  const issueId = ref?.issue;
  useEffect(() => {
    if (!issueId) return;
    const cached = inheritedLedgerCache.get(issueId);
    // 缓存命中(null 含在内)不再发请求:详情 10s 轮询会反复走到这里。
    if (cached !== undefined) {
      setLedger(cached ?? undefined);
      return;
    }
    let alive = true;
    void getIssue(issueId).then((old) => {
      const account: RepoLedgerInput = {
        repo_urls: old.repo_urls,
        repo_url: old.repo_url,
        pushes: old.pushes,
        mrs: old.mrs,
        pipelines: old.pipelines,
      };
      inheritedLedgerCache.set(issueId, account);
      if (alive) setLedger(account);
    }).catch(() => {
      // 旧会话读不到(被清理/越权):静默缺省,失败一次不再重试。
      inheritedLedgerCache.set(issueId, null);
      if (alive) setLedger(undefined);
    });
    return () => {
      alive = false;
    };
  }, [issueId]);
  return ledger;
}

/** 逐仓交付区(一仓一 MR):每个关联仓一张卡——仓名/角色(变更仓·
 * 未交付)/MR 链接与分支/流水线状态徽标(绿/红含失败项/运行中)。
 * 角色与徽标的口径都出自 perRepo.ts(有推送记录=已交付;流水线只认
 * pipelines 该仓的 status),前端不推断、不硬造状态。
 * 转正而来的会话(#31):按 inherited_accounts 只读引用旧会话账,标注
 * 「转正前」并入各仓卡;本会话自己的账照常陈列,两本账不混。 */
function IssueRepoDelivery({ detail }: { detail: IssueDetail }) {
  const inherited = useInheritedLedger(detail.inherited_accounts);
  const rows = useMemo(
    () => repoDeliveryRows(detail, inherited), [detail, inherited]);
  if (rows.length === 0) return null;
  return <section className="issue-repo-delivery" aria-label="逐仓交付">
    <div className="issue-repo-delivery-head">
      <strong>逐仓交付</strong>
      <span>一仓一 MR:每个变更仓各自建分支、各自提 MR、各看流水线</span>
      {/* 旧账取到时如实说明来源;取不到(已清理)时退回"账在原会话"
          的现状文案——引用静默缺省,不报错。 */}
      {detail.converted_from && <span className="issue-repo-converted">
        转正自 {detail.converted_from}——{inherited
          ? "标注「转正前」的交付事实继承自原会话"
          : "原会话的逐仓交付账留在原会话"}
      </span>}
    </div>
    <div className="issue-repo-cards">
      {rows.map((row) => <RepoDeliveryCard key={row.repo} row={row} />)}
    </div>
  </section>;
}

function RepoDeliveryCard({ row }: { row: RepoDeliveryRow }) {
  const badge = repoPipelineBadge(row);
  const role = repoRole(row);
  const mrLabel = row.mr
    ? `${row.mr.iid ? `!${row.mr.iid} ` : ""}${row.mr.branch}`
    : "";
  const oldMrLabel = row.inherited?.mr
    ? `${row.inherited.mr.iid ? `!${row.inherited.mr.iid} ` : ""}${row.inherited.mr.branch}`
    : "";
  return <article className="issue-repo-card">
    <header>
      <strong className="issue-repo-name" title={row.repo}>{row.name}</strong>
      <span className={`issue-repo-role ${role.tone}`} title={role.title}>
        {role.tag}</span>
      {badge && <span className={`issue-repo-badge ${badge.tone}`}>
        <i aria-hidden />{badge.label}</span>}
    </header>
    <div className="issue-repo-facts">
      {row.mr && (row.mr.url
        ? <a href={row.mr.url} target="_blank" rel="noreferrer"
            title={row.mr.title}>MR {mrLabel}</a>
        : <span title={row.mr.title}>MR {mrLabel}</span>)}
      {row.push && <span>
        已推送 {row.push.branch}@{row.push.sha.slice(0, 10)}</span>}
      {!row.mr && !row.push && <span className="empty">
        该仓还没有推送与 MR 记录</span>}
    </div>
    {/* 转正前账(只读引用,旧会话数据):与本会话事实分区陈列,
        弱化样式 + 「转正前」前缀,不冒充本会话的交付。 */}
    {row.inherited && <div className="issue-repo-inherited">
      <em>转正前</em>
      {row.inherited.mr && (row.inherited.mr.url
        ? <a href={row.inherited.mr.url} target="_blank" rel="noreferrer"
            title={row.inherited.mr.title}>MR {oldMrLabel}</a>
        : <span title={row.inherited.mr.title}>MR {oldMrLabel}</span>)}
      {row.inherited.push && <span>
        已推送 {row.inherited.push.branch}@{row.inherited.push.sha.slice(0, 10)}</span>}
      {row.inherited.pipeline && <span>
        {row.inherited.pipeline.label}{row.inherited.pipeline.failedChecks.length
          ? `(失败项:${row.inherited.pipeline.failedChecks.join("、")})` : ""}</span>}
    </div>}
    {/* last_error 不只跟 failed 走:轮询预算耗尽时 status 仍是 running、
        但监看已停——两个字段都如实示人,不替服务端下结论。 */}
    {(row.pipeline?.last_error || (row.pipeline?.failedChecks.length ?? 0) > 0)
      && <div className="issue-repo-pipeline-error">
        {row.pipeline?.last_error && <span>{row.pipeline.last_error}</span>}
        {(row.pipeline?.failedChecks.length ?? 0) > 0
          && <span>失败项:{row.pipeline!.failedChecks.join("、")}</span>}
      </div>}
  </article>;
}

/** 固定流程的阶段管道(计划线):视觉对齐需求工作台的 task-phase-track
 * ——节点在上、词签在下、细连线串成一条管;走过的亮,当前阶段节点
 * 放大呼吸。stage_states 决定形态(pending 空心/in_progress 亮/done 实
 * /redo 警示/inherited 弱化+标"继承");轮次>1 加轮次徽标。 */
export function IssueFixedProgress({ issue }: { issue: IssueSummary }) {
  const stages = fixedStageList(issue.scenario);
  const states = issue.stage_states ?? [];
  const labels: Record<IssueStageState, string> = {
    pending: "未开始",
    in_progress: "进行中",
    done: "已完成",
    inherited: "已继承",
    redo: "待重做",
  };
  return <nav className="issue-fixed-progress" aria-label="固定流程阶段">
    {(issue.round ?? 1) > 1
      && <div className="issue-fixed-head">
        <span className="issue-round-badge">第 {issue.round} 轮</span>
      </div>}
    <span className="issue-fixed-track">
      {stages.map((stage, index) => {
        const state = states[index] ?? "pending";
        const current = state === "in_progress";
        const label = issueStageText({
          mode: "fixed", scenario: issue.scenario, stage });
        return <span key={stage}
          className={`issue-fixed-step state-${state}${current ? " current" : ""}`}
          title={`${label} · ${labels[state]}${current ? "(当前)" : ""}`}>
          <i aria-hidden />
          <span className="issue-fixed-name">{label}</span>
          {state === "inherited" && <em className="issue-fixed-tag">继承</em>}
          {state === "redo" && <em className="issue-fixed-tag">重做</em>}
        </span>;
      })}
    </span>
  </nav>;
}

/** 阶段英雄轨:旅程线(dates = transitions 账,走过才画)。
 * 节点是"点在上、词签在下"的小栈,节点间连条渐变着色(调色对抄自
 * ws-progress 的 nth-child);末位为当前节点——点放大描白边带双光晕,
 * 词签加粗。来源(AI 上报/平台事实)保留在 title 悬浮里,不参与配色。 */
function IssueJourneyTrail({ trail }: {
  trail: NonNullable<IssueDetail["transitions"]>;
}) {
  if (trail.length === 0) return null;
  return <nav className="stage-trail issue-journey" aria-label="处理阶段轨迹">
    {trail.map((entry, index) => {
      const last = index === trail.length - 1;
      return <span
        key={`${entry.at}-${index}`}
        className={`issue-jnode${last ? " current" : ""}`}
        data-source={entry.source}
        title={`${entry.source === "agent" ? "AI 上报" : "平台事实"} · ${entry.note}`}>
        <i aria-hidden />
        <b>{entry.stage ? issueStageText({ stage: entry.stage }) : entry.note}</b>
      </span>;
    })}
  </nav>;
}

/** 材料 / 现场 的页签栏(左栏头;默认口在 IssueSessionView 里定:
 * 打开会话先看现场直播,手选保持到换会话)。发言入口仍走右栏
 * NEXT ACTION;对话的复盘阅读面在材料的「过程文档 · 过程问答」,
 * 现场的「消息」筛选管原始事件,三者各司其职。 */
/** 页签栏:结构照搬任务工作台的 ws-workspace-nav(彩色卡 +
 * 主副两行文案),视觉与需求侧完全一致。 */
function IssuePaneTabs({
  tab,
  onPick,
}: {
  tab: "materials" | "events";
  onPick: (tab: "materials" | "events") => void;
}) {
  const views = [
    ["materials", "材料", "DTS 单据、过程文档、工作区变更与拉取日志"],
    ["events", "现场", "执行事件实时跟随,对话内容在「消息」筛选"],
  ] as const;
  return <nav className="ws-workspace-nav" aria-label="会话工作台视图">
    {views.map(([value, label, hint]) => (
      <button type="button" key={value}
        aria-selected={tab === value}
        className={tab === value ? "active" : ""}
        onClick={() => onPick(value)}>
        <strong>{label}</strong>
        <small>{hint}</small>
      </button>
    ))}
  </nav>;
}

/** 耗时与卡点:问题域版的 CostBreakdown。服务端(sessionView.ts)已经
 * 把消息账与转移账归纳成结论,前端只呈现,不再二次解读;展开才查,
 * 视觉分量压低——它是仪表,不是流水账。 */
export function IssueCostPanel({ id }: { id: string }) {
  const [expanded, setExpanded] = useState(false);
  const [timeline, setTimeline] = useState<IssueTimeline | undefined>();
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const result = await getIssueTimeline(id);
      setNote(result.unavailable ?? "");
      setTimeline(result.timeline);
    } catch (reason) {
      setNote(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && !timeline) void load();
  }

  const share = timeline?.human_wait_share ?? 0;
  const waits = timeline?.longest_waits ?? [];
  const events = (timeline?.events ?? []).slice(-12).reverse();

  return <section className={`issue-tl${expanded ? " is-open" : ""}`}>
    <button type="button" className="issue-tl-toggle" aria-expanded={expanded}
      onClick={toggle}>
      <span>
        <strong>耗时与卡点</strong>
        <small>时间去哪了 · 卡在谁身上</small>
      </span>
      <i aria-hidden />
    </button>
    {expanded && <div className="issue-tl-body">
      {loading && <div className="issue-tl-note">正在读取会话账本…</div>}
      {!loading && note && <div className="issue-tl-note">{note}</div>}
      {!loading && timeline && <>
        <div className="issue-tl-metrics">
          <div><span>总耗时</span><strong>{formatWait(timeline.span.ms)}</strong></div>
          <div><span>等人工</span><strong>{share}%</strong></div>
          <div><span>决策次数</span><strong>{timeline.decisions}</strong></div>
        </div>
        <div className="issue-tl-bar"
          role="img"
          aria-label={`人等待占 ${share}%`}>
          <span style={{ width: `${share}%` }} />
        </div>
        {(timeline.blocker || timeline.span.start) && <div className="issue-tl-blocker">
          {timeline.blocker
            ? <>当前卡点:{timeline.blocker}</>
            : <>时间区间 {formatLocalClock(timeline.span.start)}
              → {formatLocalClock(timeline.span.end)}(当前没有等待中的问题卡)</>}
        </div>}
        {waits.length > 0 && <ol className="issue-tl-waits">
          {waits.map((wait, index) => <li key={index}
            className={wait.open_ended ? "open" : ""}>
            <span className="issue-tl-rank">{String(index + 1).padStart(2, "0")}</span>
            <span className="issue-tl-question">{wait.question}</span>
            <span className="issue-tl-ms">
              {formatWait(wait.ms)}{wait.open_ended ? "(仍在等)" : ""}
            </span>
          </li>)}
        </ol>}
        {events.length > 0 && <ul className="issue-tl-events">
          {events.map((event, index) => <li key={index}
            className={`kind-${event.kind}`}>
            <time dateTime={event.ts}>{formatLocalClock(event.ts)}</time>
            {event.kind === "stage" && <em className={`src-${event.source}`}>
              {event.source === "platform" ? "平台" : "AI 上报"}
            </em>}
            <span>{event.kind === "stage"
              ? `阶段:${STAGE(event)}${event.detail ? ` · ${event.detail}` : ""}`
              : event.title}</span>
          </li>)}
        </ul>}
      </>}
    </div>}
  </section>;
}

/** 阶段事件标题出人话:标题是词表键(如 verify),认得就翻,不认识的
 * (未来词表扩充前的旧现场)原样示人——前端不猜。 */
function STAGE(event: { title: string }): string {
  return issueStageText({ stage: event.title as never });
}
