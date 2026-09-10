/**
 * 会话域:会话工作台全屏视图(头部 / 阶段线 / 逐仓交付 / 耗时卡点 / 双栏)。
 *
 * 从 IssueBoard.tsx 原文搬移(spec #2 按域拆分,纯搬移零行为变化):
 * 工作台无条件画固定流程计划线(IssueFixedProgress,列表卡也复用;
 * #98 单路径化:不再感知"模式",自由旅程线已删)。左栏(#123 拍平)
 * 是五个一级标签直排——页签条在本文件,四个材料子视图内容免壳直渲自
 * MaterialsPane.tsx、现场直播在 EventsPane.tsx。右栏旧 NEXT ACTION 侧栏
 * 已随 #127 整体拆除:归档/终止入头部控件区、挂起转正卡入协作流顶部、
 * 状态说明由头部徽标与协作流承载。
 *
 * 查看模式(docs/issue-session-view-mode.md):登录用户 ≠ 会话归属人
 * 即只读围观——四个信息面(概要+时间线、材料只读浏览、事件流直播、
 * 耗时卡点——已随 2026-09-11 拍板退役,见文件尾注释)完整保留,全部
 * 操作控件不渲染(不是点了报错),顶部一条
 * 「查看模式」标识。归属人打开自己的会话零行为变化。
 */
import { useEffect, useMemo, useState } from "react";
import {
  GIT_AUTH_ERROR_TAG,
  ISSUE_STATUS_TEXT,
  addIssueTakeoverNote,
  answerIssue,
  associateIssueTicket,
  attachIssueEnvironment,
  controlIssue,
  fixedStageList,
  getIssue,
  issueMergeStatus,
  issueStageText,
  replyIssue,
  resumeIssueTakeover,
  steerIssue,
  takeoverIssue,
  type DtsTicketDetail,
  type IssueDetail,
  type IssueEnvironmentForm,
  type IssueStageState,
  type IssueSummary,
} from "../api";
import { confirmDialog } from "../ConfirmDialog";
import {
  repoDeliveryRows,
  repoPipelineBadge,
  repoRole,
  type RepoDeliveryRow,
  type RepoLedgerInput,
} from "./perRepo";
import { IssueWaitingFacts } from "./IssueWaitingFacts";
import { IssueWarmupLive } from "./IssueWarmupLive";
import { IssueAssociateCard, IssueAssociateFacts } from "./IssueAssociateCard";
import { IssueDecisionCard } from "./IssueDecisionCard";
import { IssueConversationStream } from "./IssueConversationStream";
import { IssueMaterialsPane } from "./MaterialsPane";
import { IssueEventsPane } from "./EventsPane";
import { FeedbackPanel } from "../TaskWorkspace";

/** 左栏六个一级标签(#123 拍平 + 用户走查反馈):对话现场是默认入口
 * 放首位,中间四签是原"材料"面板的二级页签升格,逐仓交付收编为末签
 * (原悬在页签条上方的大卡区,2026-09-07 走查拍板:信息尽可能收进
 * 页签圈,上方不占纵向空间)。页签条复用任务侧 ws-pane-head >
 * ws-source-switch 同构,一签一色走 --workspace-tab-color。 */
const ISSUE_MAIN_TABS = [
  { key: "events", label: "对话现场" },
  { key: "dts", label: "DTS单据" },
  { key: "doc", label: "过程文档" },
  { key: "changes", label: "工作区变更" },
  { key: "logs", label: "拉取日志" },
  { key: "repos", label: "逐仓交付" },
] as const;
type IssueMainTab = (typeof ISSUE_MAIN_TABS)[number]["key"];

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
  const [busy, setBusy] = useState(false);
  // 卡座 dock(#125):输入区 ws-reply-dock 容器的节点。dockRef 交给右栏
  // 协作区,节转成 footerTarget 发给当前卡——卡的提交区(附言+提交/
  // 拒绝按钮)经 portal 挂进输入区;无卡/查看模式时它保持 null,提交区
  // 原位渲染或干脆不出(查看模式事实卡无提交区)。
  const [decisionFooterTarget, setDecisionFooterTarget] =
    useState<HTMLDivElement | null>(null);
  // 左栏页签(#123 五选一):默认"对话现场"(AI 干活的直播面),用户
  // 手选优先;换会话重置。发言不靠页签——右栏输入区常驻(运行中=插话/
  // 空闲=续聊),对话现场只管看。
  const [tab, setTab] = useState<IssueMainTab>("events");

  useEffect(() => {
    // 换一个会话就丢弃手选页签,回到默认入口(对话现场)。
    setTab("events");
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
  // 决策卡在卡在场时画。闸卡的分寸(2026-09-08):env_needed 在工具
  // 举起闸的瞬间就出卡,不等回合收口的状态翻转——模型收口后仍可继续
  // 不需要环境的工作,用户填卡/拒绝与它并行;其余闸都在阶段边界举起、
  // 状态随即翻转,照旧只在 waiting_user 画。终态/挂起不出现卡。
  // gate_kind/scope 随卡带给决策卡:env_needed 换专用环境表单,
  // skill_select 换多选圈选卡(ADR-0011),pipeline_unfixable/
  // pipeline_evidence 换流水线红灯人工卡(票 03),gate_pipeline 带
  // 闸归属的仓与提交。
  const envGateLive = detail.gate?.kind === "env_needed"
    && ["running", "idle", "waiting_user"].includes(detail.status);
  const gateCard = (detail.status === "waiting_user" || envGateLive)
    && detail.gate
    ? {
        waiting_id: detail.gate.id,
        state_version: detail.gate.state_version,
        question: detail.gate.question,
        context: detail.gate.context,
        created_at: detail.gate.created_at,
        gate_kind: detail.gate.kind,
        gate_scope: detail.gate.scope,
        gate_skills: detail.gate.skills,
        gate_pipeline: detail.gate.pipeline,
      }
    : undefined;
  const waiting = gateCard
    ?? (detail.status === "waiting_user" ? detail.waiting : undefined);

  /** 问题卡作答:decision=人话文本;code=平台闸决策码(裁决协议);
   * answers=Agent 卡逐题作答(码或自由文本);selection=skill 圈选闸
   * 的勾选清单(ADR-0011)。统一经 answerIssue 提交。 */
  async function answer(
    decision: string,
    code?: string,
    answers?: Record<string, string>,
    notes?: string,
    selection?: string[],
  ): Promise<boolean> {
    if (!waiting) return false;
    return perform(() => answerIssue(detail.id, {
      state_version: waiting.state_version,
      decision,
      ...(code ? { code } : {}),
      ...(answers ? { answers } : {}),
      ...(notes ? { notes } : {}),
      ...(selection ? { selection } : {}),
    }));
  }
  /** env_needed 闸的专用提交口(POST /issues/:id/environment):密码只在
   * 这一次请求里过网、只进服务端 vault,成功后 perform 会带新详情回来。 */
  const attachEnvironment = (input: IssueEnvironmentForm) =>
    perform(() => attachIssueEnvironment(detail.id, input));
  const sendReply = (text: string) => perform(() => replyIssue(detail.id, text));
  const sendSteer = (text: string) => perform(() => steerIssue(detail.id, text));
  /** 人工接管三回调(2026-09-07 走查拍板)。接管/交还走 perform:成功
   * 后带新详情回来(徽标与输入区模式随之翻转);人工记录不走 perform
   * ——perform 会吞错,记录失败要让输入区当场报错保字。 */
  const takeoverNow = () => perform(() => takeoverIssue(detail.id));
  const sendTakeoverNote = (text: string) =>
    addIssueTakeoverNote(detail.id, text).then(() => undefined);
  const resumeTakeover = (note?: string) =>
    perform(() => resumeIssueTakeover(detail.id, note));
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
    let message = "归档后会话收口不可续聊，凭据将清理。";
    // 合入事实摆明(ADR-0022):有 MR 的会话先现扫一次平台事实,结论
    // 按合入记账——全合入=已交付,未全合=已推送未合入。平台暂不可得
    // 不堵归档(软闸),用通用文案;服务端归档时仍会核对。
    if (detail.mrs?.length) {
      try {
        const status = await issueMergeStatus(detail.id);
        const lines = status.mrs.map((mr) => {
          const name = mr.repo.split("/").pop() || mr.repo;
          return mr.state === "merged"
            ? `✓ 已合入 ${name}${mr.merged_sha ? `（${mr.merged_sha.slice(0, 8)}）` : ""}`
            : mr.state === "closed"
              ? `✗ 被关闭 ${name}——可续聊返工，或直接归档`
              : `… 合入中 ${name}`;
        });
        message = `归档后会话收口不可续聊，凭据将清理。\n逐仓 MR 合入状态：\n${lines.join("\n")}\n结论将记为：${status.all_merged ? "已交付（全部 MR 已合入）" : "已修复（推送/建 MR 未全部合入）"}`;
      } catch { /* 平台暂不可得:软闸不堵,交服务端归档时核对 */ }
    }
    if (!await confirmDialog({
      title: "归档会话",
      message,
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

  // 全屏工作台(ADR-0018 骨架对齐):复用任务侧 studio 骨架——ws-head
  // 头部(返回/身份/进度/操作)+ ws-body 两栏(左 ws-evidence 工作区、
  // 右 ws-side 协作)。主题走问题域变量(见 style.css 的 .issue-workspace
  // 覆写):同构不同色。左栏已按 #123 拍平成五个一级标签,右栏是 #124
  // 的协作对话框(会话流+输入区);旧 NEXT ACTION 侧栏已按 #127 拆除。
  return <section
    className="workspace-overlay issue-workspace task-workspace-v2 workspace-studio"
    role="dialog" aria-modal="true" aria-label={`问题会话:${detail.title}`}>
    <header className="ws-head">
      <button type="button" className="ws-back" onClick={onBack}
        title="返回我的问题(Esc)" aria-label="返回我的问题(Esc)">←</button>
      <div className="ws-identity">
        <strong>{detail.title}</strong>
        <div className="ws-identity-line">
          {/* 查看模式标识(非归属人围观):徽标样式沿用状态徽标的
              身份徽标语言,文本即 aria 信息(读屏直读 span 文本)。 */}
          {!canOperate && <span className="issue-view-mode" role="status"
            title="你正在查看归属人的问题会话:操作控件已隐藏,信息面完整可看">
            查看模式:归属人 {detail.account} 的会话
          </span>}
          <span className={`issue-status status-${detail.status}`}>
            {ISSUE_STATUS_TEXT[detail.status]}
          </span>
          {/* 人工接管徽标(2026-09-07 走查拍板):横幅态独立于六态——
              在场即「AI 已暂停、人工作业中」,排在状态徽标之后。 */}
          {detail.takeover
            && <span className="issue-status status-takingover">人工接管中</span>}
          <span className="issue-stage">
            {issueStageText(detail)}
            {detail.round && detail.round > 1 ? `(第 ${detail.round} 轮)` : ""}
            {detail.stage_note ? ` · ${detail.stage_note}` : ""}
          </span>
          {/* 登记元信息的网管环境常驻上屏(问"问题发生在哪个网管"不用翻
              现场;密码本体只在 vault)。 */}
          {detail.environment && <span className="issue-stage"
            title={detail.environment.environment_source_ip
              ? "来自环境管理台账的选定时点快照(密码在平台加密保管,不上屏)"
              : "登记元信息里的网管环境(密码在平台加密保管,不上屏)"}>
            {detail.environment.environment_source_ip ? "来自环境管理" : "网管环境"}
            {` ${detail.environment.hosts.join("、")}`}
            {` · 端口 ${detail.environment.port}`}
          </span>}
          {detail.ticket
            ? <span className="issue-ticket">{detail.ticket}</span>
            : <span className="issue-ticket empty">无单场景</span>}
        </div>
      </div>
      <div className="ws-progress">
        <IssueWorkspaceProgress issue={detail} />
      </div>
      <div className="ws-head-controls">
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
        {/* 归档/终止(#127 自右栏侧栏栏脚迁入,与导出并列):confirmDialog
            确认语义、按状态禁用与 failed 例外(失败没有结论可归档,只能
            终止清理)原样保留;都是写操作,查看模式整组不渲染。 */}
        {canOperate && <>
          <button type="button" disabled={busy
            || ["archived", "canceled", "failed"].includes(detail.status)}
            title={detail.status === "failed"
              ? "失败的会话没有结论可归档——用「终止会话」清理" : undefined}
            onClick={archive}>归档收口</button>
          <button type="button" className="danger" disabled={busy
            || ["archived", "canceled"].includes(detail.status)}
            onClick={cancelSession}>终止会话</button>
        </>}
      </div>
    </header>

    <div className="ws-body">
      <section className="ws-evidence" aria-label="会话工作区">
        {/* 错误横幅:认证类报错带一键跳转(查看模式不渲染)。 */}
        {detail.error && <div className="issue-session-error" role="alert">
          <span>{detail.error}</span>
          {/* 认证类报错带机器标记(issueGit.ts 的 GIT_AUTH_ERROR_TAG,常量
              镜像在 api.ts):命中即给一键跳转;人话改字不影响识别。
              跳转修的是归属人的凭据,查看模式不渲染这条补救入口。 */}
          {canOperate && onNavigateProfile
            && detail.error.includes(GIT_AUTH_ERROR_TAG)
            && <button type="button" className="issue-error-action"
              onClick={onNavigateProfile}>去个人设置配置令牌</button>}
        </div>}
        {/* 逐仓交付已收编为「逐仓交付」页签(2026-09-07 走查拍板:上方
            不再放大卡区,信息尽可能收进页签圈);检视反馈仅在库时显示。 */}
        {Boolean(detail.feedback?.length)
          && <FeedbackPanel feedback={detail.feedback!} />}

        {/* 左栏内容(#123 拍平 + #127 走查反馈):六个一级标签直排——
            对话现场(默认入口)放首位,逐仓交付收编为末签。页签条是
            任务侧左栏同款 ws-pane-head > ws-source-switch(role=tablist),
            页签一签一色走问题域变量 --workspace-tab-color。 */}
        <section className="issue-main-pane" aria-label="会话内容">
          <div className="ws-pane-head" aria-label="问题工作台视图">
            <div><strong>{
              ISSUE_MAIN_TABS.find((item) => item.key === tab)?.label
            }</strong></div>
            <div className="ws-source-switch" role="tablist"
              aria-label="会话工作区内容">
              {ISSUE_MAIN_TABS.map(({ key, label }) => (
                <button type="button" key={key} role="tab"
                  aria-selected={tab === key}
                  className={tab === key ? "on" : ""}
                  disabled={key === "dts" && !detail.ticket}
                  title={key === "dts" && !detail.ticket
                    ? "无单场景:还没有关联的 DTS 单据" : undefined}
                  onClick={() => setTab(key)}>
                  <span>{label}</span>
                  {/* 分析报告在库:过程文档页签挂脉冲点——报告是主交付物,
                      入口要找得到(原材料页签的同一引导,随升格迁来)。 */}
                  {key === "doc" && detail.has_analysis
                    && <i className="ws-tab-dot" aria-hidden />}
                </button>
              ))}
            </div>
          </div>
          {tab === "events"
            ? <>
              <IssueWarmupLive id={detail.id} warmup={detail.warmup} />
              <IssueEventsPane id={detail.id} active />
            </>
            : tab === "repos"
            ? <IssueWorkspaceRepos detail={detail} />
            : <IssueMaterialsPane detail={detail} busy={busy} view={tab}
                onNotifyAI={notifyAI} canOperate={canOperate} />}
        </section>
      </section>
      <section className="ws-side" aria-label="与 Agent 协作">
        {/* #125 右栏协作对话框:协作头 + 会话流(聚合接口
            GET /issues/:id/conversation + 可见轮询)+ 输入区。当前等待卡
            由卡座钉在流末尾的 Agent 气泡内(waitingId 供流内同卡投影
            去重),提交区经 portal 挂进输入区 dock(dockRef→footerTarget);
            查看模式渲染只读事实卡、不出 dock。挂起会话(#127)的关联转正
            卡走 suspendedCard 槽,渲染在协作头之下、流之上——rail 拆除后
            转正入口的唯一家。 */}
        <IssueConversationStream
          key={detail.id}
          issueId={detail.id}
          status={detail.status}
          waiting={Boolean(waiting)}
          waitingId={waiting?.waiting_id}
          waitingTs={waiting?.created_at}
          canOperate={canOperate}
          busy={busy}
          owner={detail.account}
          viewerUsername={viewerUsername}
          takeover={Boolean(detail.takeover)}
          currentCard={waiting ? (canOperate
            ? <IssueDecisionCard waiting={waiting} busy={busy}
                footerTarget={decisionFooterTarget}
                onAnswer={answer} onEnvironment={attachEnvironment} />
            : <IssueWaitingFacts waiting={waiting} />)
            : undefined}
          suspendedCard={detail.status === "suspended" ? (canOperate
            ? <IssueAssociateCard busy={busy} onAssociate={associate} />
            : <IssueAssociateFacts />)
            : undefined}
          dockRef={setDecisionFooterTarget}
          onSteer={sendSteer}
          onReply={sendReply}
          onTakeover={takeoverNow}
          onTakeoverNote={sendTakeoverNote}
          onResumeTakeover={resumeTakeover}
          onOpenEvents={() => setTab("events")}
        />
      </section>
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

/** 「逐仓交付」页签内容:有登记仓时渲染逐仓交付卡组,无仓给一句空态
 * (发起时登记的模块决定关联仓,这里不是登记入口)。 */
function IssueWorkspaceRepos({ detail }: { detail: IssueDetail }) {
  if (!(detail.repo_urls?.length ?? 0) && !detail.repo_url) {
    return <div className="issue-repos-empty">
      会话没有登记代码仓——发起时登记的业务模块决定关联仓;
      逐仓交付与流水线状态会在这里展示。
    </div>;
  }
  return <IssueRepoDelivery detail={detail} />;
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
        const label = issueStageText({ scenario: issue.scenario, stage });
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

/** 工作台头部进度(ADR-0018 骨架对齐):视觉复用任务侧 task-progress
 * (caption+phase-track,节点上词签下、当前脉冲),数据仍是问题域
 * stage_states;不做任务侧的"点阶段弹方案"——问题侧没有阶段计划。
 * 无单三节点与有单五阶段同一条渲染路;inherited 弱化、redo 警示、
 * 轮次>1 带轮次徽标。列表卡仍用 IssueFixedProgress,两份并存。 */
function IssueWorkspaceProgress({ issue }: { issue: IssueSummary }) {
  const stages = fixedStageList(issue.scenario);
  const states = issue.stage_states ?? [];
  const currentIndex = Math.max(0, stages.findIndex((_, index) =>
    (states[index] ?? "pending") === "in_progress"));
  const done = stages.every((_, index) =>
    (states[index] ?? "pending") === "done"
    || (states[index] ?? "pending") === "inherited");
  return <span className="task-progress"
    aria-label={`当前阶段:${issueStageText(issue)}`}>
    <span className="task-progress-caption">
      <span>当前进度</span>
      <strong>{issueStageText(issue)}</strong>
      <em className="task-progress-count">
        {done ? stages.length : currentIndex + 1}/{stages.length}
      </em>
      {(issue.round ?? 1) > 1
        && <em className="issue-round-badge">第 {issue.round} 轮</em>}
    </span>
    <span className="task-phase-track">
      {stages.map((stage, index) => {
        const state = states[index] ?? "pending";
        const phaseClass = state === "in_progress" ? "current"
          : state === "redo" ? "attention"
          : state === "done" || state === "inherited" ? "past is-done"
          : index < currentIndex ? "past" : "future";
        const label = issueStageText({ scenario: issue.scenario, stage });
        return <span key={stage} className={`task-phase ${phaseClass}`}
          title={`${label} · ${state === "inherited" ? "已继承"
            : state === "redo" ? "待重做" : state === "done" ? "已完成"
            : state === "in_progress" ? "进行中(当前)" : "未开始"}`}>
          <i aria-hidden />
          <span>{label}</span>
        </span>;
      })}
    </span>
  </span>;
}

/** 耗时与卡点面板(2026-09-11 退役):原是工作台的耗时仪表,2026-09-07
 * 走查反馈迁到列表卡展开态;展开交互随「点击直达工作台」拍板移除后,
 * 它失去最后一个使用点,连面板一起删。数据面 timeline 接口(服务端投影)
 * 仍在,api.getIssueTimeline 是它的客户端镜像;以后要在工作台补看耗时,
 * 接回它即可。 */
