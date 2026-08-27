/**
 * 问题处理页(问题流 v2 的唯一入口)。
 *
 * 与"我的需求"完全隔离:独立分包、独立轮询、独立 API 命名空间。
 * 页面两块:上方登记(DTS 拉单/手工登记),下方"我的问题"会话列表;
 * 点开进入会话详情(消息流 + 问题卡作答 + 阶段显示 + 归档)。
 * 前端不推断状态:一切文案来自 /issues API 镜像。
 */
import { useEffect, useRef, useState } from "react";
import {
  ISSUE_STAGE_TEXT,
  ISSUE_STATUS_TEXT,
  type AuthUser,
  type DtsTicketBrief,
  type IssueDetail,
  type IssueStage,
  type IssueSummary,
  type IssueTimeline,
  answerIssue,
  bindIssueTicket,
  controlIssue,
  createIssue,
  getIssue,
  getIssueAnalysis,
  getIssueTimeline,
  listDtsTickets,
  listIssues,
  replyIssue,
  steerIssue,
} from "../api";
import { Markdown } from "../markdown";
import { formatWait } from "../taskTime";
import { startVisiblePolling } from "../visiblePolling";
import { formatLocalClock, formatLocalDateTime } from "../time";

export function IssueBoard({ viewer, onNavigateProfile }: {
  viewer: AuthUser;
  onNavigateProfile?: () => void;
}) {
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [openId, setOpenId] = useState("");
  const [detail, setDetail] = useState<IssueDetail | undefined>();
  const [error, setError] = useState("");

  const refreshList = () => {
    void listIssues().then(setIssues).catch(() => undefined);
  };
  useEffect(() => startVisiblePolling(refreshList, 5000, document), []);

  // 打开会话时跟读详情(消息流贴着 AI 的节奏走);列表照常低频轮询。
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

  useEffect(() => startVisiblePolling(() => {
    if (!openId) return;
    void getIssue(openId).then(setDetail).catch(() => undefined);
  }, 2000, document), [openId]);

  if (openId && detail) {
    return <IssueSessionView
      detail={detail}
      onBack={() => { setOpenId(""); setDetail(undefined); }}
      onChanged={(next) => setDetail(next)}
      onListRefresh={refreshList}
      onError={setError}
      onNavigateProfile={onNavigateProfile}
    />;
  }

  return <div className="issue-board">
    {error && <div className="issue-error" role="alert">
      <span>{error}</span>
      <button type="button" onClick={() => setError("")}>知道了</button>
    </div>}
    <IssueRegistration
      viewer={viewer}
      onCreated={(created) => {
        refreshList();
        setOpenId(created.id);
      }}
      onError={setError}
    />
    <section className="issue-section" aria-labelledby="issue-mine-title">
      <div className="section-head">
        <div>
          <span className="section-kicker">MY ISSUES</span>
          <h2 id="issue-mine-title">我的问题</h2>
        </div>
        <span className="section-count">共 {issues.length} 个</span>
      </div>
      {issues.length === 0
        ? <div className="review-clear current-work-empty"><span aria-hidden>✓</span><div>
            <strong>还没有问题会话</strong>
            <p>从上方登记一个"我的问题",或从 DTS 拉取问题单发起处理;
            研究结论是非问题也可以直接归档收口。</p>
          </div></div>
        : <div className="issue-list">
            {issues.map((issue) => <IssueCard
              key={issue.id}
              issue={issue}
              onOpen={() => { setOpenId(issue.id); }}
            />)}
          </div>}
    </section>
  </div>;
}

function IssueCard({ issue, onOpen }: { issue: IssueSummary; onOpen: () => void }) {
  return <button type="button" className={`issue-card status-${issue.status}`}
    onClick={onOpen}>
    <div className="issue-card-head">
      <span className={`issue-status status-${issue.status}`}>
        {ISSUE_STATUS_TEXT[issue.status]}
      </span>
      <span className="issue-stage">
        {ISSUE_STAGE_TEXT[issue.stage]}
        {issue.stage_note ? ` · ${issue.stage_note}` : ""}
      </span>
      {issue.ticket
        ? <span className="issue-ticket">{issue.ticket}</span>
        : <span className="issue-ticket empty">未绑单</span>}
    </div>
    <strong className="issue-title">{issue.title}</strong>
    <div className="issue-card-foot">
      <span>{issue.source === "dts" ? "DTS 单" : "自研问题"}</span>
      <span>{formatLocalDateTime(issue.updated_at)}</span>
      {issue.conclusion && <span className="issue-conclusion">
        {issue.conclusion.kind === "non_issue" ? "非问题"
          : issue.conclusion.kind === "delivered" ? "已提 MR" : "已修复"}
      </span>}
    </div>
  </button>;
}

function IssueRegistration({
  viewer,
  onCreated,
  onError,
}: {
  viewer: AuthUser;
  onCreated: (issue: IssueSummary) => void;
  onError: (message: string) => void;
}) {
  const [tab, setTab] = useState<"dts" | "manual">("manual");
  return <section className="issue-section" aria-labelledby="issue-register-title">
    <div className="section-head">
      <div>
        <span className="section-kicker">REGISTER</span>
        <h2 id="issue-register-title">登记问题</h2>
      </div>
      <div className="issue-register-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "manual"}
          className={tab === "manual" ? "on" : ""}
          onClick={() => setTab("manual")}>手工登记</button>
        <button type="button" role="tab" aria-selected={tab === "dts"}
          className={tab === "dts" ? "on" : ""}
          onClick={() => setTab("dts")}>从 DTS 拉单</button>
      </div>
    </div>
    {tab === "manual"
      ? <ManualRegister viewer={viewer} onCreated={onCreated} onError={onError} />
      : <DtsRegister viewer={viewer} onCreated={onCreated} onError={onError} />}
  </section>;
}

function ManualRegister({
  viewer,
  onCreated,
  onError,
}: {
  viewer: AuthUser;
  onCreated: (issue: IssueSummary) => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [ticket, setTicket] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [envOpen, setEnvOpen] = useState(false);
  const [envHosts, setEnvHosts] = useState("");
  const [envPassword, setEnvPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const draftKey = `mae-flow:issue:draft:${viewer.username}`;
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) ?? "null");
      if (saved) {
        setTitle(saved.title ?? "");
        setDescription(saved.description ?? "");
        setRepoUrl(saved.repoUrl ?? "");
      }
    } catch { /* 草稿是旁路,坏了就坏了吧 */ }
  }, [draftKey]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({ title, description, repoUrl }));
      } catch { /* 同上 */ }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draftKey, title, description, repoUrl]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim()) {
      onError("问题标题必填——一句话说清现象");
      return;
    }
    setBusy(true);
    try {
      const hosts = envOpen
        ? envHosts.split(/[,，\s]+/).map((host) => host.trim()).filter(Boolean)
        : [];
      const environment = envOpen && hosts.length && envPassword
        ? { hosts, password: envPassword }
        : undefined;
      const created = await createIssue({
        title: title.trim(),
        description: description.trim() || undefined,
        ticket: ticket.trim() || undefined,
        repo_url: repoUrl.trim() || undefined,
        ...(environment ? { environment } : {}),
      });
      setTitle(""); setDescription(""); setTicket("");
      setEnvHosts(""); setEnvPassword("");
      onCreated(created);
    } catch (reason) {
      onError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(false);
    }
  }

  return <form className="issue-form" onSubmit={submit}>
    <label className="issue-field wide">
      <span>问题标题 <i>必填</i></span>
      <input value={title} maxLength={120} placeholder="一句话说清现象,如:播放器偶发黑屏"
        onChange={(event) => setTitle(event.target.value)} />
    </label>
    <label className="issue-field wide">
      <span>现象描述</span>
      <textarea rows={3} value={description}
        placeholder="发生条件、影响范围、复现步骤;有日志片段也可以贴进来"
        onChange={(event) => setDescription(event.target.value)} />
    </label>
    <label className="issue-field">
      <span>DTS 单号 <i>可后补</i></span>
      <input value={ticket} placeholder="先研究后提单可留空"
        onChange={(event) => setTicket(event.target.value)} />
    </label>
    <label className="issue-field">
      <span>代码仓地址 <i>可选</i></span>
      <input value={repoUrl} placeholder="https://codehub.../repo.git"
        onChange={(event) => setRepoUrl(event.target.value)} />
    </label>
    <div className="issue-field wide">
      <button type="button" className="issue-env-toggle"
        aria-expanded={envOpen}
        onClick={() => setEnvOpen((open) => !open)}>
        网管环境(拉日志/换库){envOpen ? " −" : " +"}
      </button>
      {envOpen && <div className="issue-env-fields">
        <label className="issue-field">
          <span>服务器地址(可多个,逗号分隔)</span>
          <input value={envHosts} placeholder="60.14.46.16, 60.14.46.17"
            onChange={(event) => setEnvHosts(event.target.value)} />
        </label>
        <label className="issue-field">
          <span>共用密码(sopuser/ossuser/ossadm)</span>
          <input type="password" value={envPassword} autoComplete="new-password"
            onChange={(event) => setEnvPassword(event.target.value)} />
        </label>
      </div>}
    </div>
    <div className="issue-form-actions">
      <button type="submit" className="primary" disabled={busy}>
        {busy ? "登记中…" : "登记并开始研究"}
      </button>
      <span className="issue-form-hint">
        登记后 AI 先做只读研究;非问题也是合法结论,不强制走编码。
      </span>
    </div>
  </form>;
}

function DtsRegister({
  viewer,
  onCreated,
  onError,
}: {
  viewer: AuthUser;
  onCreated: (issue: IssueSummary) => void;
  onError: (message: string) => void;
}) {
  const [tickets, setTickets] = useState<DtsTicketBrief[] | undefined>();
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function load() {
    setLoading(true);
    setNote("");
    try {
      setTickets(await listDtsTickets());
    } catch (reason) {
      setTickets(undefined);
      setNote(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setLoading(false);
    }
  }

  async function launch() {
    if (!selected || busy) return;
    const ticket = tickets?.find((item) => item.ticket === selected);
    setBusy(true);
    try {
      const created = await createIssue({
        title: ticket?.title || selected,
        source: "dts",
        ticket: selected,
        description: ticket?.title || undefined,
      });
      onCreated(created);
    } catch (reason) {
      onError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(false);
    }
  }

  return <div className="issue-dts">
    <div className="issue-dts-toolbar">
      <button type="button" onClick={load} disabled={loading}>
        {loading ? "拉取中…" : `拉取 ${viewer.username} 的问题单`}
      </button>
      <button type="button" className="primary" disabled={!selected || busy}
        title={tickets && tickets.length > 1 && selected
          ? "当前版本一次只发起一张;批量处理即将开放" : undefined}
        onClick={launch}>
        {busy ? "发起中…" : "发起处理"}
      </button>
      {note && <span className="issue-dts-note">{note}</span>}
    </div>
    {tickets && tickets.length > 0 && <div className="issue-dts-list" role="table">
      {tickets.map((ticket) => <label key={ticket.ticket}
        className={`issue-dts-row${selected === ticket.ticket ? " on" : ""}`}>
        <input type="checkbox" checked={selected === ticket.ticket}
          onChange={(event) => setSelected(event.target.checked ? ticket.ticket : "")} />
        <span className="issue-dts-ticket">{ticket.ticket}</span>
        <span className="issue-dts-title">{ticket.title || "(无标题)"}</span>
        {ticket.status && <span className="issue-dts-status">{ticket.status}</span>}
      </label>)}
      <p className="issue-dts-hint">
        勾选要发起的问题单(当前一次一张,批量处理即将开放)。
      </p>
    </div>}
    {tickets && tickets.length === 0 && <p className="issue-dts-hint">
      你的名下当前没有问题单。
    </p>}
  </div>;
}

function IssueSessionView({
  detail,
  onBack,
  onChanged,
  onListRefresh,
  onError,
  onNavigateProfile,
}: {
  detail: IssueDetail;
  onBack: () => void;
  onChanged: (detail: IssueDetail) => void;
  onListRefresh: () => void;
  onError: (message: string) => void;
  onNavigateProfile?: () => void;
}) {
  const [replyText, setReplyText] = useState("");
  const [steerText, setSteerText] = useState("");
  const [answer, setAnswer] = useState("");
  const [ticket, setTicket] = useState("");
  const [busy, setBusy] = useState(false);
  // 主面板双页签:对话是默认;结论文档(issue-analysis.md)按需再取。
  const [tab, setTab] = useState<"chat" | "doc">("chat");
  const threadRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 消息流贴底:详情刷新后滚到最新一条。
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [detail.messages.length]);

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      const next = await getIssue(detail.id);
      onChanged(next);
      onListRefresh();
    } catch (reason) {
      onError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(false);
    }
  }

  const waiting = detail.waiting;
  const questions = waiting?.question?.questions ?? [];
  const canChat = detail.status === "idle" || detail.status === "interrupted";
  // 阶段轨迹:按转移账实际发生的顺序画,不预设流程。节点 = 有 stage 的
  // 转移(agent 声明 + 平台事实),末位即当前;无转移(刚登记)不渲染。
  const trail = (detail.transitions ?? []).filter((entry) => entry.stage);

  return <div className="issue-session">
    <div className="issue-session-head">
      <button type="button" className="issue-back" onClick={onBack}>
        ← 返回我的问题
      </button>
      <div className="issue-session-title">
        <strong>{detail.title}</strong>
        <span className={`issue-status status-${detail.status}`}>
          {ISSUE_STATUS_TEXT[detail.status]}
        </span>
        <span className="issue-stage">
          {ISSUE_STAGE_TEXT[detail.stage]}
          {detail.stage_note ? ` · ${detail.stage_note}` : ""}
        </span>
      </div>
      {trail.length > 0 && <nav className="stage-trail" aria-label="处理阶段轨迹">
        {trail.map((entry, index) => {
          const last = index === trail.length - 1;
          return <span
            key={`${entry.at}-${index}`}
            className={`stage-node source-${entry.source}${last ? " current" : ""}`}
            title={`${entry.source === "agent" ? "AI 上报" : "平台事实"} · ${entry.note}`}>
            {entry.stage ? ISSUE_STAGE_TEXT[entry.stage] : entry.note}
          </span>;
        })}
      </nav>}
      <div className="issue-session-ticket">
        {detail.ticket
          ? <span className="issue-ticket">{detail.ticket}</span>
          : <span className="issue-bind">
              <input value={ticket} placeholder="绑定 DTS 单号"
                onChange={(event) => setTicket(event.target.value)} />
              <button type="button" disabled={!ticket.trim() || busy}
                onClick={() => run(() => bindIssueTicket(detail.id, ticket.trim()))}>
                绑定
              </button>
            </span>}
        <span className="issue-bind-hint" title="推送与提 MR 的门票是单号;研究阶段不需要">
          {detail.ticket ? "" : "提 MR 前必须绑定单号"}
        </span>
      </div>
    </div>

    {detail.stage === "done" && detail.status === "idle"
      && <div className="issue-done-hint">
        AI 已给出结论——点下方「归档收口」正式关闭;若要继续追问也可以,
        AI 会把阶段从「结束」切回对应环节。
      </div>}
    {detail.error && <div className="issue-session-error" role="alert">
      <span>{detail.error}</span>
      {/* 「Git 令牌」是后端认证类报错的锚点(issueGit.ts),命中即给
          一键跳转;其余错误只展示原文。 */}
      {onNavigateProfile && detail.error.includes("Git 令牌")
        && <button type="button" className="issue-error-action"
          onClick={onNavigateProfile}>去个人设置配置令牌</button>}
    </div>}
    {detail.mr && <div className="issue-session-mr">
      MR:{detail.mr.url
        ? <a href={detail.mr.url} target="_blank" rel="noreferrer">{detail.mr.url}</a>
        : detail.mr.title}
      (分支 {detail.mr.branch})
    </div>}
    {detail.push && !detail.mr && <div className="issue-session-mr">
      已推送 {detail.push.branch} @ {detail.push.sha.slice(0, 12)}
    </div>}

    <IssueCostPanel id={detail.id} />

    {tab === "chat"
      ? <>
          <IssuePaneTabs tab="chat" hasAnalysis={detail.has_analysis} onPick={setTab} />
          <div className="issue-thread" ref={threadRef}>
            {detail.messages.map((message, index) => <div
              key={`${message.ts}-${index}`}
              className={`issue-message role-${message.role}`}>
              <span className="issue-message-role">
                {message.role === "user"
                  ? "我" : message.role === "assistant" ? "AI" : "决定"}
              </span>
              <div className="issue-message-body">{message.text}</div>
            </div>)}
            {detail.messages.length === 0 && <p className="issue-thread-empty">
              会话刚建立,AI 正在启动首轮研究。
            </p>}
          </div>
        </>
      : <>
          <IssuePaneTabs tab="doc" hasAnalysis={detail.has_analysis} onPick={setTab} />
          {/* 结论文档按 updated_at 缓存:文档可能被 AI 续写,状态一动就该重读。 */}
          <IssueConclusionDoc
            id={detail.id}
            updatedAt={detail.updated_at}
          />
        </>}

    {waiting && <div className="issue-waiting">
      <strong>AI 的提问(等你的答复)</strong>
      {waiting.context && <p className="issue-waiting-context">{waiting.context}</p>}
      {questions.map((question, index) => <div key={index} className="issue-question">
        <p>{question.question}</p>
        <div className="issue-question-options">
          {question.options.map((option) => <button key={option} type="button"
            disabled={busy}
            onClick={() => run(() => answerIssue(detail.id, {
              state_version: waiting.state_version,
              decision: option,
            }))}>{option}</button>)}
        </div>
      </div>)}
      <div className="issue-waiting-free">
        <input value={answer} placeholder="或自由作答"
          onChange={(event) => setAnswer(event.target.value)} />
        <button type="button" disabled={!answer.trim() || busy}
          onClick={() => run(async () => {
            await answerIssue(detail.id, {
              state_version: waiting.state_version,
              decision: answer.trim(),
            });
            setAnswer("");
          })}>提交答复</button>
      </div>
    </div>}

    <div className="issue-composer">
      {detail.status === "running" && <div className="issue-composer-row">
        <input value={steerText} placeholder="会话运行中——插话(当前工具调用完成后送达)"
          onChange={(event) => setSteerText(event.target.value)} />
        <button type="button" disabled={!steerText.trim() || busy}
          onClick={() => run(async () => {
            await steerIssue(detail.id, steerText.trim());
            setSteerText("");
          })}>插话</button>
      </div>}
      {canChat && <div className="issue-composer-row">
        <textarea rows={2} value={replyText}
          placeholder={detail.status === "interrupted"
            ? "服务重启打断了会话——发消息即可从现场续聊"
            : "继续对话:补充信息、调整方向,或让 AI 继续"}
          onChange={(event) => setReplyText(event.target.value)} />
        <button type="button" className="primary" disabled={!replyText.trim() || busy}
          onClick={() => run(async () => {
            await replyIssue(detail.id, replyText.trim());
            setReplyText("");
          })}>发送</button>
      </div>}
      <div className="issue-composer-actions">
        <button type="button" disabled={busy || ["archived", "canceled", "failed"]
          .includes(detail.status)}
          onClick={() => {
            if (window.confirm("归档后 会话收口不可续聊,凭据将清理。确认归档?")) {
              void run(() => controlIssue(detail.id, { action: "archive" }));
            }
          }}>归档收口</button>
        <button type="button" className="danger" disabled={busy
          || ["archived", "canceled", "failed"].includes(detail.status)}
          onClick={() => {
            if (window.confirm("取消将终止会话并清理现场,确认?")) {
              void run(() => controlIssue(detail.id, { action: "cancel" }));
            }
          }}>取消</button>
        {detail.has_analysis && <button type="button" className="issue-analysis-flag"
          title="查看结论文档"
          onClick={() => setTab("doc")}>
          结论文档 issue-analysis.md 已产出 →
        </button>}
      </div>
    </div>
  </div>;
}

/** 对话 / 结论文档 的轻量页签(默认对话;文档按需再取)。 */
function IssuePaneTabs({
  tab,
  hasAnalysis,
  onPick,
}: {
  tab: "chat" | "doc";
  hasAnalysis: boolean;
  onPick: (tab: "chat" | "doc") => void;
}) {
  return <div className="issue-pane-tabs" role="tablist"
    aria-label="会话内容视图">
    <button type="button" role="tab" aria-selected={tab === "chat"}
      className={tab === "chat" ? "on" : ""}
      onClick={() => onPick("chat")}>对话</button>
    <button type="button" role="tab" aria-selected={tab === "doc"}
      className={tab === "doc" ? "on" : ""}
      onClick={() => onPick("doc")}>
      结论文档{!hasAnalysis && <i>(未生成)</i>}
    </button>
  </div>;
}

/** 结论文档(issue-analysis.md):激活页签时才取;状态一动(updated_at
 * 变化)自动重读,让 AI 续写的内容能贴着节奏刷新。 */
function IssueConclusionDoc({ id, updatedAt }: { id: string; updatedAt: string }) {
  const [docKey, setDocKey] = useState("");
  const [content, setContent] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const result = await getIssueAnalysis(id);
      if (result.unavailable) {
        setNote(result.unavailable);
        setContent("");
      } else {
        setNote("");
        setContent(result.content ?? "");
      }
      // 只在拿到响应后记账:半路失败下次仍会重试。
      setDocKey(updatedAt);
    } catch (reason) {
      setNote(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (docKey !== updatedAt) void load();
    // docKey 有意不在依赖里:刷新按钮要的是无视缓存的重取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updatedAt]);

  return <div className="issue-thread issue-doc">
    {loading && <p className="issue-thread-empty">正在读取结论文档…</p>}
    {!loading && note && <div className="issue-doc-empty">
      <strong>还没有结论文档</strong>
      <p>{note}——AI 研究中会把结论写入 issue-analysis.md,生成后这里直接可读。</p>
    </div>}
    {!loading && !note && content && <>
      <div className="issue-doc-toolbar">
        <span>研究现场落盘的 markdown · 即写即读</span>
        <button type="button" onClick={() => void load()}>刷新</button>
      </div>
      <article className="issue-doc-body">
        <Markdown text={content} />
      </article>
    </>}
  </div>;
}

/** 耗时与卡点:问题域版的 CostBreakdown。服务端(sessionView.ts)已经
 * 把消息账与转移账归纳成结论,前端只呈现,不再二次解读;展开才查,
 * 视觉分量压低——它是仪表,不是流水账。 */
function IssueCostPanel({ id }: { id: string }) {
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
  return ISSUE_STAGE_TEXT[event.title as IssueStage] ?? event.title;
}
