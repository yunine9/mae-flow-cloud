/**
 * 问题处理页(问题流 v2 的唯一入口)。
 *
 * 与"我的需求"完全隔离:独立分包、独立轮询、独立 API 命名空间。
 * 页面两块:上方登记(DTS 拉单/手工登记),下方"我的问题"会话列表;
 * 点开进入会话详情——决策-centric 双栏:顶部阶段英雄轨 + 耗时卡点折叠条,
 * 左栏是内容(对话/结论文档页签),右栏常驻 NEXT ACTION(待答复/运行中/
 * 空闲/被打断/已出结论 五态互斥)+ 底部固死的归档与取消。
 * 前端不推断状态:一切文案来自 /issues API 镜像。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ISSUE_STATUS_TEXT,
  associateIssueTicket,
  bindIssueTicket,
  answerIssue,
  controlIssue,
  createIssue,
  fixedStageList,
  getBusinessModules,
  getDtsTicketDetail,
  getIssue,
  getIssueAnalysis,
  getIssueTimeline,
  issueStageText,
  listDtsTickets,
  listIssues,
  replyIssue,
  steerIssue,
  tailIssueEvents,
  type AuthUser,
  type BusinessModule,
  type DtsTicketBrief,
  type DtsTicketDetail,
  type IssueDetail,
  type IssueStageState,
  type IssueSummary,
  type IssueTimeline,
  type SemanticEvent,
} from "../api";
import { Markdown } from "../markdown";
import { formatWait } from "../taskTime";
import { startVisiblePolling } from "../visiblePolling";
import { formatLocalClock, formatLocalDateTime } from "../time";
import { IssueRail, RailInput } from "./IssueRail";

export function IssueBoard({ viewer, onNavigateProfile }: {
  viewer: AuthUser;
  onNavigateProfile?: () => void;
}) {
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  const [openId, setOpenId] = useState("");
  const [detail, setDetail] = useState<IssueDetail | undefined>();
  const [error, setError] = useState("");
  // SSE 事件账(按 eventId 去重累积):会话线程的实时源。
  const [liveEvents, setLiveEvents] = useState<SemanticEvent[]>([]);

  const refreshList = () => {
    void listIssues().then(setIssues).catch(() => undefined);
  };
  useEffect(() => startVisiblePolling(refreshList, 5000, document), []);

  // 打开会话时跟读详情(消息流贴着 AI 的节奏走);列表照常低频轮询。
  useEffect(() => {
    if (!openId) {
      setDetail(undefined);
      setLiveEvents([]);
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

  // 会话线程改走 SSE:服务端从头重放 events.jsonl 再 300ms 增量跟进,
  // AI 回复生成完的瞬间即到;连接前/断连时回落到 detail.messages。
  // 终态(archived/canceled/failed)服务端会收口 SSE,前端跟着停,
  // 免得 EventSource 自动重连空转。
  const live = !!openId && !!detail
    && !["archived", "canceled", "failed"].includes(detail.status);
  useEffect(() => {
    if (!live || !openId) return;
    return tailIssueEvents(openId, (event) => {
      setLiveEvents((previous) => previous.some((item) => (
        item.eventId === event.eventId && item.sessionId === event.sessionId))
        ? previous
        : [...previous, event]);
    });
  }, [live, openId]);

  const liveMessages = useMemo(
    () => issueThreadFromEvents(liveEvents), [liveEvents]);
  // 运行中的"活着"指示:工具动静一有就说,纯生成期给一句诚实的"处理中"。
  const activity = useMemo(() => {
    if (detail?.status !== "running") return "";
    const last = liveEvents[liveEvents.length - 1];
    if (!last) return "";
    if (last.kind === "tool_requested") {
      const name = String(last.payload?.name ?? "");
      return name ? `正在执行 ${name}…` : "";
    }
    return "AI 正在处理…";
  }, [detail?.status, liveEvents]);

  // 详情轮询降为兜底:SSE 管消息新鲜度,这里只刷状态/阶段/待办卡。
  useEffect(() => startVisiblePolling(() => {
    if (!openId) return;
    void getIssue(openId).then(setDetail).catch(() => undefined);
  }, 10000, document), [openId]);

  if (openId && detail) {
    return <IssueSessionView
      detail={detail}
      messages={liveMessages.length ? liveMessages : detail.messages}
      activity={activity}
      onBack={() => { setOpenId(""); setDetail(undefined); }}
      onChanged={(next) => setDetail(next)}
      onListRefresh={refreshList}
      onError={setError}
      onNavigateProfile={onNavigateProfile}
      onOpenIssue={(id) => { setOpenId(id); setLiveEvents([]); }}
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
        {issueStageText(issue)}
        {issue.mode === "fixed" && issue.round && issue.round > 1
          ? ` · 第 ${issue.round} 轮` : ""}
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
          : issue.conclusion.kind === "delivered" ? "已提 MR"
          : issue.conclusion.kind === "converted" ? "已转正"
          : issue.conclusion.kind === "issue" ? "问题成立" : "已修复"}
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
  // 多仓登记:首个=主仓(交付仓),其余参考仓。选模块自动带出,可增删改。
  const [repoUrls, setRepoUrls] = useState<string[]>([""]);
  // 业务模块:目录非空时是选择器(无单必选),目录空/加载失败回退自由文本。
  const [moduleId, setModuleId] = useState("");
  const [moduleName, setModuleName] = useState("");
  const [modules, setModules] = useState<BusinessModule[] | undefined>();
  const [envOpen, setEnvOpen] = useState(false);
  const [envHosts, setEnvHosts] = useState("");
  const [envPassword, setEnvPassword] = useState("");
  const [busy, setBusy] = useState(false);
  // 探索方式(个人设置,缺省固定流程):只影响本次登记的会话形态。
  const fixed = viewer.issue_flow !== "free";
  const draftKey = `mae-flow:issue:draft:${viewer.username}`;
  const moduleCatalog = useMemo(
    () => (modules ?? []).filter((module) => module.status === "active"),
    [modules]);
  const selectedModule = moduleCatalog.find((module) => module.id === moduleId);
  useEffect(() => {
    let alive = true;
    // 目录读不到按空处理:回退手填仓,不让模块库故障堵死问题发起。
    getBusinessModules()
      .then((catalog) => { if (alive) setModules(catalog.modules); })
      .catch(() => { if (alive) setModules([]); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) ?? "null");
      if (saved) {
        setTitle(saved.title ?? "");
        setDescription(saved.description ?? "");
        setRepoUrls(Array.isArray(saved.repoUrls) && saved.repoUrls.length
          ? saved.repoUrls.map(String)
          : saved.repoUrl ? [String(saved.repoUrl)] : [""]);
        setModuleId(typeof saved.moduleId === "string" ? saved.moduleId : "");
        setModuleName(typeof saved.moduleName === "string" ? saved.moduleName : "");
      }
    } catch { /* 草稿是旁路,坏了就坏了吧 */ }
  }, [draftKey]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({
          title, description, repoUrls, moduleId, moduleName,
        }));
      } catch { /* 同上 */ }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draftKey, title, description, repoUrls, moduleId, moduleName]);

  /** 选模块即带仓:用模块绑定整表替换仓库行(可删可改);清空模块回到单行。
   * 模块绑定可能过期,所以带出后仍然全部可编辑。 */
  function changeModule(nextId: string) {
    setModuleId(nextId);
    const module = moduleCatalog.find((item) => item.id === nextId);
    setRepoUrls(nextId && module?.repositories.length
      ? [...module.repositories]
      : [""]);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim()) {
      onError("问题标题必填——一句话说清现象");
      return;
    }
    if (fixed && !ticket.trim() && moduleCatalog.length > 0 && !moduleId) {
      onError("无单场景必须先选业务模块——平台按模块绑定的代码仓拉取现场。"
        + "模块不在列表?先到「知识飞轮 → 业务模块」登记,或填写单号按有单流程走");
      return;
    }
    const repos = [...new Set(repoUrls.map((url) => url.trim()).filter(Boolean))];
    if (fixed && !repos.length) {
      onError("固定流程在登记时就要确定代码仓(拉取代码仓是必经节点)——"
        + "选择业务模块自动带出,或填代码仓地址;也可到「个人设置」切回自由探索");
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
        ...(repos.length ? { repo_urls: repos } : {}),
        ...(moduleId ? { module_id: moduleId } : {}),
        ...(!moduleId && moduleName.trim() ? { module: moduleName.trim() } : {}),
        ...(environment ? { environment } : {}),
      });
      setTitle(""); setDescription(""); setTicket("");
      setRepoUrls([""]); setModuleId(""); setModuleName("");
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
      <span>DTS 单号 <i>{fixed ? "无单场景可留空" : "可后补"}</i></span>
      <input value={ticket} placeholder={fixed
        ? "测试/开发自行定位可留空;结论后可关联转正"
        : "先研究后提单可留空"}
        onChange={(event) => setTicket(event.target.value)} />
    </label>
    <label className="issue-field">
      <span>业务模块 <i>{fixed && moduleCatalog.length > 0 ? "无单必选" : "可选"}</i></span>
      {moduleCatalog.length > 0
        ? <select value={moduleId}
            onChange={(event) => changeModule(event.target.value)}>
            <option value="">不选择模块(手动填仓)</option>
            {moduleCatalog.map((module) => (
              <option key={module.id} value={module.id}>
                {module.name}(绑 {module.repositories.length} 个仓)
              </option>
            ))}
          </select>
        : <input value={moduleName} maxLength={60}
            placeholder="如:媒体中心(仅展示与报告引用)"
            onChange={(event) => setModuleName(event.target.value)} />}
      {selectedModule && !selectedModule.repositories.length && (
        <small>该模块未绑定代码仓,请手动填写仓库地址</small>
      )}
    </label>
    <div className="issue-field">
      <span>代码仓地址 <i>{fixed
        ? selectedModule?.repositories.length ? "模块带出,可增删改" : "至少一个"
        : "可选"}</i></span>
      <div className="issue-repo-rows">
        {repoUrls.map((url, index) => (
          <div className="issue-repo-row" key={index}>
            <input value={url} spellCheck={false}
              placeholder="https://codehub.../repo.git"
              onChange={(event) => setRepoUrls((current) => current.map(
                (item, itemIndex) => itemIndex === index
                  ? event.target.value : item))} />
            {repoUrls.length > 1 && (
              <button type="button" aria-label={`移除第 ${index + 1} 个仓库`}
                onClick={() => setRepoUrls((current) => current.filter(
                  (_, itemIndex) => itemIndex !== index))}>×</button>
            )}
          </div>
        ))}
      </div>
      <button type="button" className="issue-repo-add"
        onClick={() => setRepoUrls((current) => [...current, ""])}>＋ 添加代码仓</button>
    </div>
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
        {busy ? "登记中…" : "登记并开始处理"}
      </button>
      <span className="issue-form-hint">
        {fixed
          ? "固定流程:有单走七阶段,无单先定位出结论(是问题→挂起,关联单号后转正继续)。"
          : "自由探索:AI 先做只读研究;非问题也是合法结论,不强制走编码。"}
        (探索方式在「个人设置」切换)
      </span>
    </div>
  </form>;
}

/** 将 DTS 描述中的 <img src="https://dts-xxx/..."> 或 <img src="/v1/nfs/...">
 *  重写为本地代理 URL /issues/dts-file?path=...,避免跨域无 cookie 问题。 */
function resolveDtsImages(html: string | undefined): string {
  if (!html) return "";
  // 匹配绝对路径: src="https://dts-szv.clouddragon.huawei.com/v1/nfs/..."
  html = html.replace(
    /(<img\s[^>]*src=")https?:\/\/[^/"]*(\/[^"]*)(")/gi,
    `$1/issues/dts-file?path=$2$3`,
  );
  // 兜底匹配相对路径: src="/v1/nfs/..."
  html = html.replace(
    /(<img\s[^>]*src=")(\/v1\/[^"]*)(")/gi,
    `$1/issues/dts-file?path=$2$3`,
  );
  return html;
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
  const [repoUrl, setRepoUrl] = useState("");
  const [moduleName, setModuleName] = useState("");
  const [envHosts, setEnvHosts] = useState("");
  const [envPassword, setEnvPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const fixed = viewer.issue_flow !== "free";

  // 模糊搜索:单号/标题/版本,大小写不敏感。
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    if (!tickets) return undefined;
    const q = query.trim().toLowerCase();
    if (!q) return tickets;
    return tickets.filter((t) =>
      t.ticket.toLowerCase().includes(q)
      || t.title.toLowerCase().includes(q)
      || (t.version && t.version.toLowerCase().includes(q))
    );
  }, [tickets, query]);

  // 展开详情:同一张单只拉一次(缓存),失败不影响列表已有字段展示。
  const [expandedTicket, setExpandedTicket] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, DtsTicketDetail>>({});
  const [detailLoading, setDetailLoading] = useState(false);

  async function load() {
    setLoading(true);
    setNote("");
    setQuery("");
    setExpandedTicket(null);
    try {
      setTickets(await listDtsTickets());
    } catch (reason) {
      setTickets(undefined);
      setNote(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setLoading(false);
    }
  }

  async function toggleExpand(ticketNo: string) {
    if (expandedTicket === ticketNo) {
      setExpandedTicket(null);
      return;
    }
    setExpandedTicket(ticketNo);
    if (!detailCache[ticketNo]) {
      setDetailLoading(true);
      try {
        const detail = await getDtsTicketDetail(ticketNo);
        setDetailCache((prev) => ({ ...prev, [ticketNo]: detail }));
      } catch {
        // 详情获取失败不影响展示列表中已有的字段
      } finally {
        setDetailLoading(false);
      }
    }
  }

  async function launch() {
    if (!selected || busy) return;
    if (fixed && !repoUrl.trim()) {
      onError("固定流程在登记时就要确定代码仓——填代码仓地址后再发起");
      return;
    }
    const ticket = tickets?.find((item) => item.ticket === selected);
    setBusy(true);
    try {
      const hosts = envHosts.split(/[,，\s]+/).map((host) => host.trim()).filter(Boolean);
      const environment = hosts.length && envPassword
        ? { hosts, password: envPassword } : undefined;
      const created = await createIssue({
        title: ticket?.title || selected,
        source: "dts",
        ticket: selected,
        description: ticket?.title || undefined,
        repo_url: repoUrl.trim() || undefined,
        ...(moduleName.trim() ? { module: moduleName.trim() } : {}),
        ...(environment ? { environment } : {}),
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
    {tickets && tickets.length > 0 && <>
      <div className="issue-dts-search">
        <input
          type="search"
          value={query}
          placeholder="搜索问题单号、标题、版本…"
          onChange={(e) => setQuery(e.target.value)}
        />
        {query && <span className="issue-dts-search-count">
          {filtered?.length ?? 0} / {tickets.length} 条
        </span>}
      </div>
      <div className="issue-dts-list" role="table">
        {filtered && filtered.length > 0
          ? filtered.map((ticket) => {
            const isExpanded = expandedTicket === ticket.ticket;
            const detail = detailCache[ticket.ticket];
            return <div key={ticket.ticket}
              className={`issue-dts-row${selected === ticket.ticket ? " on" : ""}${isExpanded ? " expanded" : ""}`}>
              <label className="issue-dts-row-main">
                <input type="checkbox" checked={selected === ticket.ticket}
                  onChange={(event) => setSelected(event.target.checked ? ticket.ticket : "")} />
                <span className="issue-dts-ticket">{ticket.ticket}</span>
                <span className="issue-dts-title">{ticket.title || "(无标题)"}</span>
                {ticket.status && <span className="issue-dts-status">{ticket.status}</span>}
                <button type="button" className="issue-dts-expand"
                  aria-expanded={isExpanded}
                  onClick={(e) => { e.preventDefault(); toggleExpand(ticket.ticket); }}>
                  {isExpanded ? "▼" : "▶"}
                </button>
              </label>
              {isExpanded && <div className="issue-dts-detail">
                {detailLoading && <span className="issue-dts-detail-loading">加载详情…</span>}
                <dl className="issue-dts-detail-fields">
                  <div>
                    <dt>问题级别</dt>
                    <dd>{detail?.severity || ticket.severity || "—"}</dd>
                  </div>
                  <div>
                    <dt>问题版本</dt>
                    <dd>{detail?.version || ticket.version || "—"}</dd>
                  </div>
                  <div>
                    <dt>问题链接</dt>
                    <dd>{(detail?.url || ticket.url)
                      ? <a href={detail?.url || ticket.url} target="_blank" rel="noreferrer">
                          {detail?.url || ticket.url}
                        </a>
                      : "—"}</dd>
                  </div>
                  <div>
                    <dt>提单人</dt>
                    <dd>{detail?.submitter || ticket.submitter || "—"}</dd>
                  </div>
                  <div>
                    <dt>问题描述</dt>
                    <dd className="issue-dts-detail-html"
                      dangerouslySetInnerHTML={{
                        __html: resolveDtsImages(detail?.description || ticket.description)
                          || "(暂无描述)",
                      }}
                    />
                  </div>
                </dl>
              </div>}
            </div>;
          })
          : <p className="issue-dts-hint">没有匹配的问题单。</p>
        }
        <p className="issue-dts-hint">
          勾选要发起的问题单(当前一次一张,批量处理即将开放)。
        </p>
      </div>
    </>}
    {tickets && tickets.length === 0 && <p className="issue-dts-hint">
      你的名下当前没有问题单。
    </p>}
    {/* 登记即定仓与模块(固定流程的有单七阶段从拉单详情开始,仓在阶段2
        就要克隆);网管环境换库验证要用,登记时一并带上。 */}
    <div className="issue-dts-fields">
      <label className="issue-field">
        <span>代码仓地址 <i>{fixed ? "必填" : "可选"}</i></span>
        <input value={repoUrl} placeholder="https://codehub.../repo.git"
          onChange={(event) => setRepoUrl(event.target.value)} />
      </label>
      <label className="issue-field">
        <span>业务模块 <i>可选</i></span>
        <input value={moduleName} maxLength={60}
          placeholder="如:媒体中心(仅展示与报告引用)"
          onChange={(event) => setModuleName(event.target.value)} />
      </label>
      <label className="issue-field">
        <span>网管服务器(可多个,逗号分隔;换库验证用)<i>可选</i></span>
        <input value={envHosts} placeholder="60.14.46.16, 60.14.46.17"
          onChange={(event) => setEnvHosts(event.target.value)} />
      </label>
      <label className="issue-field">
        <span>共用密码(sopuser/ossuser/ossadm)<i>可选</i></span>
        <input type="password" value={envPassword} autoComplete="new-password"
          onChange={(event) => setEnvPassword(event.target.value)} />
      </label>
    </div>
  </div>;
}

function IssueSessionView({
  detail,
  messages,
  activity,
  onBack,
  onChanged,
  onListRefresh,
  onError,
  onNavigateProfile,
  onOpenIssue,
}: {
  detail: IssueDetail;
  /** 会话线程:SSE 直播投影优先,断连兜底 detail.messages。 */
  messages: IssueDetail["messages"];
  /** 运行中的活动指示(工具名/处理中);空串不渲染。 */
  activity: string;
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
  // 左栏页签:默认"有结论文档先看结论",用户手选优先(换会话才重置);
  // undefined 表示尚未手选,渲染时按当前 has_analysis 兜底。
  const [pickedTab, setPickedTab] = useState<"chat" | "doc" | undefined>(undefined);
  const threadRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 消息流贴底:线程有新内容(SSE 直播或详情兜底)就滚到最新。
    const thread = threadRef.current;
    if (thread) thread.scrollTop = thread.scrollHeight;
  }, [messages.length, activity]);

  useEffect(() => {
    // 换一个会话就丢弃手选页签,回到默认入口。
    setPickedTab(undefined);
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

  const tab = pickedTab ?? (detail.has_analysis ? "doc" : "chat");
  // 等待卡两源:平台闸(固定流程的人工硬闸)优先,Agent 问题卡兜底;
  // 决策卡只在 status=waiting_user 且卡在场时画,轮询半拍不画。
  const gateCard = detail.status === "waiting_user" && detail.gate
    ? {
        waiting_id: detail.gate.id,
        state_version: detail.gate.state_version,
        question: detail.gate.question,
        context: detail.gate.context,
        created_at: detail.gate.created_at,
      }
    : undefined;
  const waiting = gateCard
    ?? (detail.status === "waiting_user" ? detail.waiting : undefined);
  // 阶段轨迹:按转移账实际发生顺序画——问题阶段是动态的,这是一条
  // "旅程线"而非"计划线":只画走过的节点,不补未来占位。
  const trail = (detail.transitions ?? []).filter((entry) => entry.stage);

  async function answer(decision: string, notes?: string): Promise<boolean> {
    if (!waiting) return false;
    return perform(() => answerIssue(detail.id, {
      state_version: waiting.state_version,
      decision,
      ...(notes ? { notes } : {}),
    }));
  }
  const sendReply = (text: string) => perform(() => replyIssue(detail.id, text));
  const sendSteer = (text: string) => perform(() => steerIssue(detail.id, text));
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
  function archive() {
    if (window.confirm("归档后 会话收口不可续聊,凭据将清理。确认归档?")) {
      void perform(() => controlIssue(detail.id, { action: "archive" }));
    }
  }
  function cancelSession() {
    if (window.confirm("取消将终止会话并清理现场,确认?")) {
      void perform(() => controlIssue(detail.id, { action: "cancel" }));
    }
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
      </div>
      <div className="issue-session-ticket">
        {detail.ticket
          ? <span className="issue-ticket">{detail.ticket}</span>
          : detail.mode === "fixed"
            // 固定流程没有"中途绑单":无单会话走结论→挂起→关联转正。
            ? <span className="issue-ticket empty">无单场景</span>
            : <span className="issue-bind">
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
      </div>
    </div>

    <div className="issue-workspace-body">
    {/* 固定流程:阶段进度条(计划线,含继承/待重做态);自由模式仍是
        旅程线(走过的才画)。两条线各自独立,不互相替代。 */}
    {detail.mode === "fixed"
      && <IssueFixedProgress issue={detail} />}
    {/* 阶段英雄轨:独立整行(旅程线),压在耗时折叠条之上 */}
    <IssueJourneyTrail trail={trail} />

    {/* done ≠ 归档的引导迁到右栏绿卡;顶部横幅随之删除(决策-centric)。 */}
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

    {/* 决策-centric 双栏:左=内容(页签),右=下一步动作。窄屏单列时
        右栏靠 order 提到内容之上,见 style.css 的 1100px 断点。 */}
    <div className="issue-two-pane">
      <section className="issue-main-pane" aria-label="会话内容">
        <IssuePaneTabs tab={tab} hasAnalysis={detail.has_analysis}
          onPick={(next) => setPickedTab(next)} />
        {tab === "chat"
          ? <div className="issue-thread" ref={threadRef}>
              {messages.map((message, index) => <div
                key={`${message.ts}-${index}`}
                className={`issue-message role-${message.role}`}>
                <span className="issue-message-role">
                  {message.role === "user"
                    ? "我" : message.role === "assistant" ? "AI" : "决定"}
                </span>
                <FoldableMessageBody text={message.text} />
              </div>)}
              {messages.length === 0 && !activity && <p className="issue-thread-empty">
                会话刚建立,AI 正在启动首轮研究。
              </p>}
              {activity && <p className="issue-activity" role="status">
                <i aria-hidden />{activity}
              </p>}
              {/* stage=done 时右栏被归档卡占据,续聊入口退回对话流末尾,
                  与右栏"左侧对话页签发言"的引导文案互相印证。 */}
              {!waiting && detail.stage === "done" && detail.status === "idle"
                && <RailInput kind="reply" disabled={busy}
                  placeholder="继续追问:补充信息、调整方向,或让 AI 继续"
                  actionLabel="发送" submit={sendReply} />}
            </div>
          : <>
              {/* 结论文档按 updated_at 缓存:文档可能被 AI 续写,状态一动就该重读。 */}
              <IssueConclusionDoc id={detail.id} updatedAt={detail.updated_at} />
            </>}
      </section>
      <IssueRail
        detail={detail}
        busy={busy}
        waiting={waiting}
        onAnswer={answer}
        onReply={sendReply}
        onSteer={sendSteer}
        onArchive={archive}
        onCancel={cancelSession}
        onOpenDoc={() => setPickedTab("doc")}
        onAssociate={associate}
      />
    </div>
    </div>
  </section>;
}

/** 固定流程的阶段进度条(计划线):按 scenario 的阶段序列画节点,
 * stage_states 决定形态(pending 空心/in_progress 亮/done 实/redo 警示
 * /inherited 弱化+标"继承");轮次>1 加轮次徽标(验证回退的重走记号)。 */
function IssueFixedProgress({ issue }: { issue: IssueSummary }) {
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
      && <span className="issue-round-badge">第 {issue.round} 轮</span>}
    {stages.map((stage, index) => {
      const state = states[index] ?? "pending";
      const current = state === "in_progress";
      return <span key={stage}
        className={`issue-fixed-step state-${state}${current ? " current" : ""}`}
        title={`${labels[state]}${current ? "(当前)" : ""}`}>
        <i className="issue-fixed-dot" aria-hidden />
        <span className="issue-fixed-name">
          {issueStageText({ mode: "fixed", scenario: issue.scenario, stage })}
        </span>
        {state === "inherited" && <em className="issue-fixed-tag">继承</em>}
        {state === "redo" && <em className="issue-fixed-tag">重做</em>}
      </span>;
    })}
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

/** 对话长文折叠:>600 字的消息先展示前 280 字 + 展开按钮,防止一段长
 * 日志把整个时间线顶走(口径参考任务侧 EventValue 的 details 折叠)。 */
function FoldableMessageBody({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const folded = text.length > 600;
  if (!folded) {
    return <div className="issue-message-body">{text}</div>;
  }
  return <div className="issue-message-body is-folded">
    {open ? text : `${text.slice(0, 280)}…`}
    <button type="button" className="issue-message-expand"
      onClick={() => setOpen((value) => !value)}>
      {open ? "收起" : `展开全部 ${text.length} 字`}
    </button>
  </div>;
}

/** 对话 / 结论文档 的轻量页签(左栏头;默认口在 IssueSessionView 里定:
 * 有结论文档先看结论,手选保持到换会话)。 */
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
  return issueStageText({ stage: event.title as never });
}

/** 事件账 → 会话线程投影:与后端 service.messages 同一规则
 * (user/assistant/decision 三类,尾部 300 条截断)。SSE 重放给的是
 * 全量事件,这里照抄后端口径,长会话内存可控。 */
function issueThreadFromEvents(
  events: SemanticEvent[],
): IssueDetail["messages"] {
  const messages: IssueDetail["messages"] = [];
  for (const event of events) {
    const payload = event.payload ?? {};
    if (event.kind === "user_message") {
      messages.push({
        role: "user", text: String(payload.text ?? ""), ts: String(event.ts ?? ""),
      });
    } else if (event.kind === "assistant_message") {
      messages.push({
        role: "assistant", text: String(payload.text ?? ""), ts: String(event.ts ?? ""),
      });
    } else if (event.kind === "human_decision") {
      messages.push({
        role: "decision",
        text: `用户决定: ${String(payload.decision ?? "")}`,
        ts: String(event.ts ?? ""),
      });
    }
  }
  return messages.slice(-300);
}
