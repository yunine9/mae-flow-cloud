/**
 * 问题处理页(问题流 v2 的唯一入口)。
 *
 * 与"我的需求"完全隔离:独立分包、独立轮询、独立 API 命名空间。
 * 页面两块:上方登记(DTS 拉单/手工登记),下方"我的问题"会话列表;
 * 点开进入会话详情——决策-centric 双栏:顶部阶段英雄轨 + 耗时卡点折叠条,
 * 左栏是内容(材料/现场 两页签:现场=执行事件直播,对话内容在「消息」
 * 筛选;结论文档归入材料),右栏常驻 NEXT ACTION(待答复/运行中/
 * 空闲/被打断/已出结论 五态互斥,发言入口都在这里)+ 底部固死的归档与取消。
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
  getIssueMaterials,
  getIssueTimeline,
  getIssueWorkspaceFile,
  getIssueMaterialLog,
  getIssueFileDiff,
  issueStageText,
  listDtsTickets,
  listIssues,
  replyIssue,
  saveIssueWorkspaceFile,
  steerIssue,
  tailIssueEvents,
  type AuthUser,
  type BusinessModule,
  type DtsTicketBrief,
  type DtsTicketDetail,
  type IssueDetail,
  type IssueMaterials,
  type IssueStageState,
  type IssueSummary,
  type IssueTimeline,
  type SemanticEvent,
} from "../api";
import { Markdown } from "../markdown";
import { GitDiff } from "../GitDiff";
import {
  eventFilterCounts,
  eventWindow,
  filterEvents,
  isErrorEvent,
  type EventFilter,
} from "../eventView";
import { atBottom, backlog } from "../follow";
import { formatWait } from "../taskTime";
import { startVisiblePolling } from "../visiblePolling";
import { formatLocalClock, formatLocalDateTime } from "../time";
import { IssueRail } from "./IssueRail";

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

/** 发起前置门禁条(与需求侧 /launch-options 个人缺项同款语义):这单
 * 会碰远端仓就得先有 Git 身份——令牌管克隆/推送,邮箱管提交署名与
 * 平台归属。服务端 create 里机械拦(needRepo 判定同源),这里只把
 * 拦截面提前到表单:按钮禁用 + 指路个人设置,配完回来即解锁。 */
function CredentialGate({ viewer, needRepo, onNavigateProfile }: {
  viewer: AuthUser;
  needRepo: boolean;
  onNavigateProfile?: () => void;
}) {
  if (!needRepo) return null;
  const missing: string[] = [];
  if (!viewer.git_token_hint) missing.push("Git 令牌");
  else if (!viewer.git_email) missing.push("个人邮箱");
  if (!missing.length) return null;
  return <div className="issue-credential-gate" role="alert">
    <span>发起前先配置<b>{missing.join(" 与 ")}</b>(个人设置 → 个人接入):
      拉取代码仓与推送提交都用你的身份,配置完成即可发起。</span>
    {onNavigateProfile && <button type="button" onClick={onNavigateProfile}>
      去个人设置配置
    </button>}
  </div>;
}

function IssueRegistration({
  viewer,
  onCreated,
  onError,
  onNavigateProfile,
}: {
  viewer: AuthUser;
  onCreated: (issue: IssueSummary) => void;
  onError: (message: string) => void;
  onNavigateProfile?: () => void;
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
      ? <ManualRegister viewer={viewer} onCreated={onCreated} onError={onError}
          onNavigateProfile={onNavigateProfile} />
      : <DtsRegister viewer={viewer} onCreated={onCreated} onError={onError}
          onNavigateProfile={onNavigateProfile} />}
  </section>;
}

function ManualRegister({
  viewer,
  onCreated,
  onError,
  onNavigateProfile,
}: {
  viewer: AuthUser;
  onCreated: (issue: IssueSummary) => void;
  onError: (message: string) => void;
  onNavigateProfile?: () => void;
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

  // 个人凭据前置门禁(2026-08-28 拍板,需求侧同款):这单会碰远端仓
  // 就得先有 Git 身份。固定流程仓必填→恒需;自由探索按已填的 http 仓判。
  // 服务端在 create 里机械拦,这里把拦截面提前到表单,少撞一次墙。
  const touchRemoteRepo = fixed
    || repoUrls.some((url) => /^https?:\/\//i.test(url.trim()));
  const credentialBlocked = touchRemoteRepo
    && (!viewer.git_token_hint || !viewer.git_email);

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
    <CredentialGate viewer={viewer} needRepo={touchRemoteRepo}
      onNavigateProfile={onNavigateProfile} />
    <div className="issue-form-actions">
      <button type="submit" className="primary"
        disabled={busy || credentialBlocked}>
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

/** 从版本串里解 (R 版, C 版),如 "MAE-Access V100R025C10SPC210B002"
 * → [25, 10]。解不出的返回 undefined(排序时垫底)。 */
function dtsVersionKey(version: string): [number, number] | undefined {
  const match = /R0*(\d+)C0*(\d+)/i.exec(version);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/** 版本降序:先比 R 版,R 同再比 C 版;都解不出的按字典序垫底。 */
function sortDtsVersionsDesc(versions: string[]): string[] {
  return [...versions].sort((a, b) => {
    const ka = dtsVersionKey(a);
    const kb = dtsVersionKey(b);
    if (ka && kb) return (kb[0] - ka[0]) || (kb[1] - ka[1]);
    if (ka) return -1;
    if (kb) return 1;
    return a.localeCompare(b);
  });
}

/** 输入是否像 DTS 单号(字母开头 + 含数字,总长 >=5),支持逗号/空格
 * 分隔多个,如 "DTS2026082671269" 或 "DTS123,DTS456"。 */
function dtsNoCandidates(query: string): string[] {
  return query.split(/[,，、\s]+/).map((token) => token.trim())
    .filter((token) => /^[A-Za-z][A-Za-z0-9_-]{4,}$/.test(token)
      && /\d/.test(token));
}

function DtsRegister({
  viewer,
  onCreated,
  onError,
  onNavigateProfile,
}: {
  viewer: AuthUser;
  onCreated: (issue: IssueSummary) => void;
  onError: (message: string) => void;
  onNavigateProfile?: () => void;
}) {
  const [tickets, setTickets] = useState<DtsTicketBrief[] | undefined>();
  // 外部开发模式(--dts-mock):单据为模拟数据,页签挂 DEV 徽标防误认。
  const [dtsMock, setDtsMock] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [moduleName, setModuleName] = useState("");
  const [envHosts, setEnvHosts] = useState("");
  const [envPassword, setEnvPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const fixed = viewer.issue_flow !== "free";
  // 个人凭据前置门禁:有单登记必碰仓(固定流程仓必填),同 ManualRegister。
  const touchRemoteRepo = fixed
    || /^https?:\/\//i.test(repoUrl.trim());
  const credentialBlocked = touchRemoteRepo
    && (!viewer.git_token_hint || !viewer.git_email);

  // 模糊搜索:单号/标题/版本,大小写不敏感;版本多选过滤叠加其上。
  const [query, setQuery] = useState("");
  const [selectedVersions, setSelectedVersions] = useState<string[]>([]);
  // 版本下拉多选框的展开态;点面板外或 Esc 关闭。
  const [versionOpen, setVersionOpen] = useState(false);
  const versionBoxRef = useRef<HTMLDivElement | null>(null);
  const fuzzyMatches = useMemo(() => {
    if (!tickets) return undefined;
    const q = query.trim().toLowerCase();
    if (!q) return tickets;
    return tickets.filter((t) =>
      t.ticket.toLowerCase().includes(q)
      || t.title.toLowerCase().includes(q)
      || (t.version && t.version.toLowerCase().includes(q))
    );
  }, [tickets, query]);

  // 版本过滤:拉取后把所有单的版本汇总去重,按 R 版降序、R 同比 C 版。
  const versions = useMemo(() => {
    const set = new Set<string>();
    tickets?.forEach((t) => { if (t.version) set.add(t.version); });
    return sortDtsVersionsDesc([...set]);
  }, [tickets]);

  // 默认勾选最高 R/C 版本(列表已降序):R/C 相同的多个版本串视为
  // 并列最高,一并勾选;拉到单就先看最新一版,之后勾选/取消全由用户
  // 接管,这里不再插手。
  useEffect(() => {
    if (versions.length === 0) {
      setSelectedVersions([]);
      return;
    }
    const maxKey = dtsVersionKey(versions[0]);
    setSelectedVersions(maxKey
      ? versions.filter((version) => {
          const key = dtsVersionKey(version);
          return Boolean(key) && key![0] === maxKey[0] && key![1] === maxKey[1];
        })
      : [versions[0]]);
  }, [versions]);

  const versionFiltered = useMemo(() => {
    const list = fuzzyMatches;
    if (!list) return undefined;
    if (selectedVersions.length === 0) return list;
    return list.filter((t) => t.version && selectedVersions.includes(t.version));
  }, [fuzzyMatches, selectedVersions]);

  // 远程查单:本地搜索为空且输入像 DTS 单号(字母开头+数字,长 >=5,
  // 支持逗号分隔多个)时,自动远程查详情并作为结果入列。防抖 500ms +
  // 序号守卫:慢响应回来时若输入已变则丢弃,不与本地搜索抢戏。
  const [remote, setRemote] = useState<{ loading: boolean; tickets: DtsTicketBrief[] }>(
    { loading: false, tickets: [] });
  const remoteSeq = useRef(0);
  const fuzzyEmpty = (fuzzyMatches?.length ?? 0) === 0;

  useEffect(() => {
    const q = query.trim();
    const candidates = dtsNoCandidates(q);
    if (!tickets || !q || candidates.length === 0 || !fuzzyEmpty) {
      setRemote({ loading: false, tickets: [] });
      return;
    }
    const seq = ++remoteSeq.current;
    setRemote({ loading: true, tickets: [] });
    const timer = setTimeout(async () => {
      const results = await Promise.all(candidates.map((no) =>
        getDtsTicketDetail(no)
          .then((detail) => ({ no, detail }) as const)
          .catch(() => undefined)));
      if (remoteSeq.current !== seq) return;
      const found = results.filter((item): item is { no: string; detail: DtsTicketDetail } =>
        Boolean(item));
      // 远程查到的单直接入详情缓存:展开零等待,不再二次请求。
      setDetailCache((prev) => {
        const next = { ...prev };
        for (const { no, detail } of found) {
          const key = detail.ticket || no;
          if (!next[key]) next[key] = detail;
        }
        return next;
      });
      setRemote({ loading: false, tickets: found.map(({ no, detail }) => ({
        ticket: detail.ticket || no,
        title: detail.title,
        severity: detail.severity,
        version: detail.version,
        url: detail.url,
        description: detail.description,
      })) });
    }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tickets, fuzzyEmpty]);

  // 列表 = 本地命中(版本过滤后) + 远程补查命中(去重);清空搜索框时
  // 远程结果随 effect 复位消失,恢复展示名下全部问题单。
  const remoteTickets = remote.tickets;
  const display = useMemo(() => {
    const list = versionFiltered ?? [];
    const extra = remoteTickets.filter((r) =>
      !list.some((item) => item.ticket === r.ticket));
    return [...list, ...extra];
  }, [versionFiltered, remoteTickets]);

  // 版本下拉:点面板外或 Esc 收起。
  useEffect(() => {
    if (!versionOpen) return;
    const onDoc = (event: MouseEvent) => {
      if (!versionBoxRef.current?.contains(event.target as Node)) {
        setVersionOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setVersionOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [versionOpen]);

  // 展开详情:同一张单只拉一次(缓存),失败不影响列表已有字段展示。
  const [expandedTicket, setExpandedTicket] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, DtsTicketDetail>>({});
  const [detailLoading, setDetailLoading] = useState(false);

  async function load() {
    setLoading(true);
    setNote("");
    setQuery("");
    setSelectedVersions([]);
    setVersionOpen(false);
    setExpandedTicket(null);
    try {
      const result = await listDtsTickets();
      setTickets(result.tickets);
      setDtsMock(result.mock);
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
    // 远程补查的单也能发起:标题从远程详情里取。
    const ticket = tickets?.find((item) => item.ticket === selected)
      ?? remote.tickets.find((item) => item.ticket === selected);
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
    {dtsMock && <p className="issue-dts-mock-banner" role="note">
      DEV·模拟 DTS:外部开发模式,单据为本地模拟数据(--dts-mock),
      不是真实问题单;流程与真实模式完全一致。
    </p>}
    <div className="issue-dts-toolbar">
      <button type="button" onClick={load} disabled={loading}>
        {loading ? "拉取中…" : `拉取 ${viewer.username} 的问题单`}
      </button>
      <button type="button" className="primary"
        disabled={!selected || busy || credentialBlocked}
        title={tickets && tickets.length > 1 && selected
          ? "当前版本一次只发起一张;批量处理即将开放" : undefined}
        onClick={launch}>
        {busy ? "发起中…" : "发起处理"}
      </button>
      {note && <span className="issue-dts-note">{note}</span>}
    </div>
    {tickets && tickets.length > 0 && <>
      {versions.length > 0 && <div className="issue-dts-versions" ref={versionBoxRef}>
        <button type="button"
          className={`issue-dts-version-trigger${selectedVersions.length ? " on" : ""}`}
          aria-expanded={versionOpen}
          onClick={() => setVersionOpen((open) => !open)}>
          <span>{selectedVersions.length
            ? `版本过滤(已选 ${selectedVersions.length})` : "版本过滤(全部)"}</span>
          <i aria-hidden>{versionOpen ? "▴" : "▾"}</i>
        </button>
        {selectedVersions.length > 0 && <button type="button"
          className="issue-dts-version-clear"
          onClick={() => setSelectedVersions([])}>清除</button>}
        {versionOpen && <div className="issue-dts-version-menu" role="group"
          aria-label="选择要过滤的版本">
          {versions.map((version) => <label key={version}
            className={`issue-dts-version-option${selectedVersions.includes(version) ? " on" : ""}`}>
            <input type="checkbox"
              checked={selectedVersions.includes(version)}
              onChange={(event) => setSelectedVersions((prev) => event.target.checked
                ? [...prev, version]
                : prev.filter((item) => item !== version))} />
            <span>{version}</span>
          </label>)}
          {selectedVersions.length > 0 && <button type="button"
            className="issue-dts-version-clear-all"
            onClick={() => setSelectedVersions([])}>清除全部筛选</button>}
        </div>}
      </div>}
      <div className="issue-dts-search">
        <input
          type="search"
          value={query}
          placeholder="搜索单号、标题、版本;输入完整单号可远程查单"
          onChange={(e) => setQuery(e.target.value)}
        />
        {remote.loading
          ? <span className="issue-dts-search-count remote">远程查单中…</span>
          : (query || selectedVersions.length > 0) && <span className="issue-dts-search-count">
              {display.length} / {tickets.length} 条
            </span>}
      </div>
      <div className="issue-dts-list" role="table">
        {display.length > 0
          ? display.map((ticket) => {
            const isRemote = remote.tickets.some((item) => item.ticket === ticket.ticket);
            const isExpanded = expandedTicket === ticket.ticket;
            const detail = detailCache[ticket.ticket];
            return <div key={ticket.ticket}
              className={`issue-dts-row${selected === ticket.ticket ? " on" : ""}${isExpanded ? " expanded" : ""}`}>
              <label className="issue-dts-row-main">
                <input type="checkbox" checked={selected === ticket.ticket}
                  onChange={(event) => setSelected(event.target.checked ? ticket.ticket : "")} />
                <span className="issue-dts-ticket">{ticket.ticket}</span>
                {isRemote && <span className="issue-dts-remote">远程</span>}
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
          : remote.loading
            ? <p className="issue-dts-hint">远程查单中…</p>
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
    <CredentialGate viewer={viewer} needRepo={touchRemoteRepo}
      onNavigateProfile={onNavigateProfile} />
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
  onBack,
  onChanged,
  onListRefresh,
  onError,
  onNavigateProfile,
  onOpenIssue,
}: {
  detail: IssueDetail;
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
  // 材料子视图提到会话层:右栏"结论文档已产出"要能一步跳到该子视图。
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
    {/* 固定流程:只留计划线——全阶段一条,走到哪亮到哪,当前阶段脉冲
        呼吸(2026-08-28 拍板:固定流程下旅程线与计划线信息重复,省一行);
        自由模式仍是旅程线(走过的才画——账实序是自由模式唯一真相)。 */}
    {detail.mode === "fixed"
      ? <IssueFixedProgress issue={detail} />
      : <IssueJourneyTrail trail={trail} />}

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
        <IssuePaneTabs tab={tab} onPick={setTab} />
        {tab === "materials"
          ? <IssueMaterialsPane detail={detail} busy={busy} view={materialsView}
              onView={setMaterialsView} onNotifyAI={notifyAI} />
          : <IssueEventsPane id={detail.id} active />}
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
        onOpenDoc={() => { setTab("materials"); setMaterialsView("doc"); }}
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

/** 材料 / 现场 的页签栏(左栏头;默认口在 IssueSessionView 里定:
 * 打开会话先看现场直播,手选保持到换会话)。对话不设页签——发言走
 * 右栏 NEXT ACTION,对话内容本身就在现场的「消息」筛选里。 */
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
    ["materials", "材料", "DTS 单据、结论文档、工作区变更与拉取日志"],
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

/** 会话材料(材料页签):DTS 单据 / 结论文档 / 工作区变更 / 拉取日志。
 * 结构照搬任务工作台交付材料页(ws-pane-head + ws-source-switch + ws-doc),
 * diff 用同一把 GitDiff 渲染。数据全部旁路:任何一块失败给空态。
 * 快速修改是问题流唯一的人工写口——只改 repo/ 内已有文件,保存入
 * 人工台账,"请 AI 复核"走现有插话/续聊通道。
 * 子视图状态在会话层(右栏"结论文档已产出"要能一步跳进来)。 */
function IssueMaterialsPane({ detail, busy, view, onView, onNotifyAI }: {
  detail: IssueDetail;
  busy: boolean;
  view: "dts" | "changes" | "logs" | "doc";
  onView: (view: "dts" | "changes" | "logs" | "doc") => void;
  onNotifyAI: (text: string) => Promise<boolean>;
}) {
  const [data, setData] = useState<IssueMaterials>();
  const [note, setNote] = useState("");
  const [allDiff, setAllDiff] = useState("");
  // 快速修改:选中文件 → 编辑器;undefined 表示未选中。
  const [activeFile, setActiveFile] = useState<string>();
  const [content, setContent] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [dtsDetail, setDtsDetail] = useState<DtsTicketDetail>();
  const [logView, setLogView] = useState<{ name: string; content: string }>();

  async function load() {
    try {
      const [materials, diff] = await Promise.all([
        getIssueMaterials(detail.id),
        getIssueFileDiff(detail.id),
      ]);
      setData(materials);
      setAllDiff(diff.diff);
      setNote("");
    } catch (reason) {
      setNote(String(reason instanceof Error ? reason.message : reason));
    }
  }

  useEffect(() => {
    void load();
    // 会话状态一动(AI 可能改了工作区)就刷新;id 变化由父层换页签兜底。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.updated_at]);

  async function editFile(path: string) {
    setActiveFile(path);
    setContent(undefined);
    try {
      const file = await getIssueWorkspaceFile(detail.id, path);
      setContent(file.content);
    } catch (reason) {
      setNote(String(reason instanceof Error ? reason.message : reason));
    }
  }

  async function save() {
    if (!activeFile || content === undefined || saving) return;
    setSaving(true);
    try {
      await saveIssueWorkspaceFile(detail.id, activeFile, content);
      setNote(`已保存 ${activeFile}。改动建议让 AI 复核一次。`);
      await load();
    } catch (reason) {
      setNote(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setSaving(false);
    }
  }

  async function openLog(name: string) {
    try {
      const log = await getIssueMaterialLog(detail.id, name);
      setLogView({ name, content: log.content });
    } catch (reason) {
      setNote(String(reason instanceof Error ? reason.message : reason));
    }
  }

  useEffect(() => {
    if (view === "dts" && data?.ticket && !dtsDetail) {
      getDtsTicketDetail(data.ticket)
        .then(setDtsDetail)
        .catch((reason) => {
          setNote(String(reason instanceof Error ? reason.message : reason));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, data?.ticket]);

  const changes = data?.changes ?? [];

  return <div className="issue-materials">
    <div className="ws-pane-head">
      <div><span>ISSUE MATERIALS</span><strong>会话材料</strong></div>
      <div className="ws-source-switch" aria-label="材料类型">
        <button className={view === "dts" ? "on" : ""}
          disabled={!data?.ticket} onClick={() => onView("dts")}>
          <span>DTS 单据</span><i>{data?.ticket ? "1" : "0"}</i>
        </button>
        <button className={view === "doc" ? "on" : ""}
          disabled={!detail.has_analysis} onClick={() => onView("doc")}>
          <span>结论文档</span><i>{detail.has_analysis ? "1" : "0"}</i>
        </button>
        <button className={view === "changes" ? "on" : ""}
          onClick={() => onView("changes")}>
          <span>工作区变更</span><i>{changes.length}</i>
        </button>
        <button className={view === "logs" ? "on" : ""}
          onClick={() => onView("logs")}>
          <span>拉取日志</span><i>{data?.logs.length ?? 0}</i>
        </button>
      </div>
    </div>
    {note && <div className="utility-note">{note}</div>}
    {view === "changes" && <>
      {detail.status === "running" && <div className="utility-note">
        AI 正在运行:此刻的编辑可能被它覆盖,建议空闲/等待时再改。
      </div>}
      <div className="ws-doc">
        {allDiff
          ? <GitDiff text={allDiff} hideKey={detail.id} />
          : <div className="utility-note">工作区当前没有改动。</div>}
      </div>
      <div className="issue-materials-editor">
        <div className="issue-materials-editor-bar">
          <strong>快速修改</strong>
          <select value={activeFile ?? ""}
            onChange={(event) => {
              const path = event.target.value;
              if (path) void editFile(path);
            }}>
            <option value="">选择要修改的文件…</option>
            {changes.map((change) => <option key={change.path}
              value={change.path}>{change.path}</option>)}
          </select>
          <button type="button" className="primary" disabled={saving
            || !activeFile || content === undefined} onClick={save}>
            {saving ? "保存中…" : "保存修改"}
          </button>
          <button type="button" disabled={busy || saving || !activeFile}
            title="把这次人工改动告知 AI,请它复核后继续"
            onClick={() => activeFile && onNotifyAI(
              `[人工修改] 我直接改了 ${activeFile},请复核这份改动,与你的方案不一致时先说明再继续。`)}>
            请 AI 复核
          </button>
        </div>
        {activeFile && (content !== undefined
          ? <textarea value={content} spellCheck={false}
              onChange={(event) => setContent(event.target.value)} />
          : <p className="issue-materials-empty">读取中…</p>)}
      </div>
      <section className="issue-materials-block">
        <h4>人工修改记录({data?.manual_edits.length ?? 0})</h4>
        {data?.manual_edits.length === 0 && <p className="issue-materials-empty">
          还没有人工改动——从上方选择文件编辑保存后会记在这里。
        </p>}
        <ul className="issue-materials-edits">
          {data?.manual_edits.slice().reverse().map((edit, index) => <li
            key={`${edit.ts}-${index}`}>
            <span>{new Date(edit.ts).toLocaleTimeString()}</span>
            <span className="p">{edit.path}</span>
          </li>)}
        </ul>
      </section>
    </>}
    {view === "dts" && <div className="ws-doc">
      {dtsDetail ? <>
        <p className="issue-materials-dts-head">
          <strong>{dtsDetail.title || "(无标题)"}</strong>
          {dtsDetail.severity && <span>级别:{dtsDetail.severity}</span>}
          {dtsDetail.version && <span>版本:{dtsDetail.version}</span>}
          {dtsDetail.submitter && <span>提单:{dtsDetail.submitter}</span>}
          {dtsDetail.url && <a href={dtsDetail.url} target="_blank" rel="noreferrer">原始单</a>}
        </p>
        <div className="issue-materials-html issue-dts-detail-html"
          dangerouslySetInnerHTML={{
            __html: resolveDtsImages(dtsDetail.description || dtsDetail.content)
              || "(无描述)",
          }}
        />
      </> : <div className="utility-note">正在读取单据详情…</div>}
    </div>}
    {view === "doc" && <>
      {/* 结论文档按 updated_at 缓存:文档可能被 AI 续写,状态一动就该重读。 */}
      <IssueConclusionDoc id={detail.id} updatedAt={detail.updated_at} />
    </>}
    {view === "logs" && <div className="ws-doc">
      {data && data.logs.length === 0 && <div className="utility-note">
        本会话还没有拉取过日志。
      </div>}
      <div className="issue-materials-files" role="list">
        {data?.logs.map((log) => <button type="button" role="listitem"
          key={log.name}
          className={`issue-materials-file${logView?.name === log.name ? " on" : ""}`}
          onClick={() => openLog(log.name)}>
          <span className="p">{log.name}</span>
          <span className="num">{(log.size / 1024).toFixed(1)} KB</span>
        </button>)}
      </div>
      {logView && <pre className="issue-materials-diff">{logView.content}</pre>}
    </div>}
  </div>;
}

/** 现场(执行现场页签):结构照搬任务侧 EventTail——筛选器 + 贴底
 * 跟随 + 色调标记,一种读法。数据源换成问题流的 SSE
 * (tailIssueEvents),只陈列不解读。 */
const ISSUE_EVENT_KIND_LABEL: Record<string, string> = {
  session_started: "会话开始",
  user_message: "用户指令",
  assistant_message: "Agent 回复",
  tool_requested: "调用工具",
  tool_finished: "工具结果",
  turn_finished: "本轮结束",
  session_ended: "会话结束",
  human_decision: "人工决策",
  report_stage: "阶段上报",
  task_status_changed: "状态变化",
};

const ISSUE_EVENT_FIELD_LABEL: Record<string, string> = {
  text: "内容",
  name: "工具",
  input: "输入",
  result: "结果",
  reason: "原因",
  answers: "答复",
  is_error: "执行异常",
  resume: "恢复会话",
  call_id: "调用编号",
  detail: "详情",
};

function issueEventTone(event: SemanticEvent): string {
  if (isErrorEvent(event)) return "danger";
  if (event.kind === "tool_finished" || event.kind === "turn_finished") {
    return "success";
  }
  if (event.kind === "assistant_message") return "agent";
  if (event.kind === "user_message") return "user";
  return "neutral";
}

function IssueEventValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    if (value.length > 480) {
      return <details className="event-value-expand">
        <summary>
          <span>{value.slice(0, 180).trim()}…</span>
          <small>展开完整内容 · {value.length} 字</small>
        </summary>
        <pre>{value}</pre>
      </details>;
    }
    return <span className="event-value-text">{value || "（空）"}</span>;
  }
  if (typeof value === "boolean") {
    return <code className="event-value-atom">{value ? "是" : "否"}</code>;
  }
  if (value === null || value === undefined || typeof value === "number") {
    return <code className="event-value-atom">{String(value)}</code>;
  }
  const structured = JSON.stringify(value, null, 2);
  return <details className="event-value-expand structured">
    <summary>
      <span>结构化内容</span>
      <small>展开查看 · {structured.split("\n").length} 行</small>
    </summary>
    <pre>{structured}</pre>
  </details>;
}

function IssueEventRecord({ event }: { event: SemanticEvent }) {
  const fields = Object.entries(event.payload ?? {});
  return (
    <article className={`event-record ${issueEventTone(event)}`}>
      <header>
        <span className="event-record-dot" aria-hidden />
        <strong>{ISSUE_EVENT_KIND_LABEL[event.kind] ?? event.kind}</strong>
        <code>#{event.eventId}</code>
        <time dateTime={event.ts}
          title={formatLocalDateTime(event.ts, { seconds: true, year: true })}>
          {formatLocalDateTime(event.ts, { seconds: true })}
        </time>
      </header>
      {fields.length === 0 ? (
        <div className="event-record-empty">本事件没有附加内容</div>
      ) : (
        <dl>
          {fields.map(([field, value]) => (
            <div key={field}>
              <dt>{ISSUE_EVENT_FIELD_LABEL[field] ?? field}</dt>
              <dd><IssueEventValue value={value} /></dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

function IssueEventsPane({ id, active }: { id: string; active: boolean }) {
  const PAGE_SIZE = 120;
  const [events, setEvents] = useState<SemanticEvent[]>([]);
  const [connection, setConnection] = useState<
    "connecting" | "live" | "reconnecting">("connecting");
  const [filter, setFilter] = useState<EventFilter>("all");
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const filtered = filterEvents(events, filter);
  const visible = eventWindow(filtered, visibleLimit);
  const counts = eventFilterCounts(events);
  const follow = useIssueStickyBottom<HTMLDivElement>(filtered.length);

  useEffect(() => {
    setEvents([]);
    setConnection("connecting");
    setVisibleLimit(PAGE_SIZE);
  }, [id]);

  useEffect(() => setVisibleLimit(PAGE_SIZE), [filter]);

  useEffect(() => {
    if (!active) return;
    const stop = tailIssueEvents(id, (event: SemanticEvent) => {
      setEvents((previous) => previous.some((item) => (
        item.eventId === event.eventId
      )) ? previous : [...previous, event]);
    }, setConnection);
    return stop;
  }, [active, id]);

  return (
    <div className="event-panel-body">
      <div className={`event-live-state ${connection}`}>
        <i aria-hidden />
        <span>{!active ? "实时连接已暂停"
          : connection === "live" ? "实时接收中"
            : connection === "reconnecting" ? "连接中断,正在自动重连"
              : "正在连接问题现场"} · {events.length} 条
          {follow.paused ? " · 已暂停跟随" : ""}
        </span>
      </div>
      <div className="event-filters" role="group" aria-label="筛选原始事件">
        {([
          ["all", "全部"],
          ["messages", "消息"],
          ["tools", "工具"],
          ["errors", "异常"],
        ] as Array<[EventFilter, string]>).map(([value, label]) => (
          <button type="button" key={value}
            className={filter === value ? "active" : ""}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}>
            {label}<span>{counts[value]}</span>
          </button>
        ))}
      </div>
      {follow.paused && (
        <div className="event-follow">
          <span>已暂停跟随,你正在往回看——新事件仍在接收。</span>
          <button type="button" className="follow-resume" onClick={follow.toBottom}>
            {follow.behind > 0 ? `↓ ${follow.behind} 条新的` : "↓ 回到最新"}
          </button>
        </div>
      )}
      <div ref={follow.ref} className="event-stream"
           onScroll={follow.onScroll}>
        {visible.hidden > 0 && (
          <button type="button" className="event-load-earlier"
            onClick={() => setVisibleLimit((current) => current + PAGE_SIZE)}>
            查看更早的 {Math.min(PAGE_SIZE, visible.hidden)} 条
            <small>仍有 {visible.hidden} 条未挂载</small>
          </button>
        )}
        {events.length === 0 && (
          <div className="event-empty">
            <span aria-hidden />
            <strong>正在连接问题现场</strong>
            <small>新的执行动作会实时出现在这里。</small>
          </div>
        )}
        {events.length > 0 && filtered.length === 0 && (
          <div className="event-empty filtered">
            <strong>这个筛选下没有事件</strong>
            <small>原始事件没有丢失,可以切回"全部"继续查看。</small>
          </div>
        )}
        {visible.items.map((event) => (
          <IssueEventRecord event={event} key={event.eventId} />
        ))}
      </div>
    </div>
  );
}

/** 贴底跟随(与任务侧 useStickyBottom 同语义,问题流本地实现):
 * 用户往上翻就暂停跟随并计数积压,回底即清零。 */
function useIssueStickyBottom<T extends HTMLElement>(count: number) {
  const ref = useRef<T>(null);
  const pinned = useRef(true);
  const mark = useRef(count);
  const [behind, setBehind] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (pinned.current) {
      node.scrollTo({ top: node.scrollHeight });
      mark.current = count;
      setBehind(0);
    } else {
      setBehind(backlog(count, mark.current));
    }
  }, [count]);

  const onScroll = () => {
    const node = ref.current;
    if (!node) return;
    const bottom = atBottom(node);
    if (bottom === pinned.current) return;
    pinned.current = bottom;
    if (bottom) { mark.current = count; setBehind(0); }
  };

  const toBottom = () => {
    const node = ref.current;
    if (!node) return;
    pinned.current = true;
    mark.current = count;
    setBehind(0);
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  };

  return { ref, behind, paused: !pinned.current, onScroll, toBottom };
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
