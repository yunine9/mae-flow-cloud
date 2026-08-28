/**
 * 登记域:发起问题会话的两个页签(手工登记 / DTS 列表)。
 *
 * 从 IssueBoard.tsx 原文搬移(spec #2 按域拆分,纯搬移零行为变化):
 * 两个子面板常驻(隐藏切换),表单/勾选/搜索状态跨页签驻留。
 * DTS 文本/版本/候选纯函数在 dtsText.ts,单据 HTML 的图片代理重写与
 * 白名单消毒在 dtsHtml.ts,这里只引用不重复。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createIssue,
  getBusinessModules,
  getDtsTicketDetail,
  listDtsTickets,
  type AuthUser,
  type BusinessModule,
  type DtsTicketBrief,
  type DtsTicketDetail,
  type IssueSummary,
} from "../api";
import { prepareDtsHtml } from "./dtsHtml";
import {
  DTS_ACTIONABLE_STATUS,
  dtsNoCandidates,
  dtsVersionKey,
  isActionableDts,
  sortDtsVersionsDesc,
} from "./dtsText";

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

export function IssueRegistration({
  viewer,
  issues,
  onCreated,
  onError,
  onNavigateProfile,
}: {
  viewer: AuthUser;
  /** 我的会话列表:DTS 批量发起的前端查重用(服务端同样机械拦)。 */
  issues: IssueSummary[];
  onCreated: (issue: IssueSummary) => void;
  onError: (message: string) => void;
  onNavigateProfile?: () => void;
}) {
  const [tab, setTab] = useState<"dts" | "manual">("manual");
  // 两个子面板常驻(隐藏切换):DTS 列表、勾选与表单状态跨页签驻留,
  // 首开「DTS 列表」自动拉取一次,之后靠「刷新」手动更新。
  return <section className="issue-section" aria-labelledby="issue-register-title">
    <div className="section-head">
      <div>
        <span className="section-kicker">发起会话</span>
        <h2 id="issue-register-title">登记问题</h2>
      </div>
      <div className="issue-register-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "manual"}
          className={tab === "manual" ? "on" : ""}
          onClick={() => setTab("manual")}>手工登记</button>
        <button type="button" role="tab" aria-selected={tab === "dts"}
          className={tab === "dts" ? "on" : ""}
          onClick={() => setTab("dts")}>DTS 列表</button>
      </div>
    </div>
    <div hidden={tab !== "manual"}>
      <ManualRegister viewer={viewer} onCreated={onCreated} onError={onError}
        onNavigateProfile={onNavigateProfile} />
    </div>
    <div hidden={tab !== "dts"}>
      <DtsRegister viewer={viewer} issues={issues} active={tab === "dts"}
        onCreated={onCreated} onError={onError}
        onNavigateProfile={onNavigateProfile} />
    </div>
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

  // 个人凭据前置门禁(2026-08-28 拍板):这单填了远端仓就得先有 Git
  // 身份。登记不再强制带仓(代码仓可推迟到「拉取代码仓」阶段由平台闸
  // 补定),门只拦"真要碰远端"的登记;服务端在 create 里机械拦,这里
  // 把拦截面提前到表单,少撞一次墙。
  const touchRemoteRepo = repoUrls.some((url) => /^https?:\/\//i.test(url.trim()));
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
    // 固定流程不再强制登记带仓(2026-08-28):缺仓时平台会在「拉取代码
    // 仓」阶段举卡让你补定(AI 识别/填地址/跳过三选一),这里不拦。
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
      <input value={title} placeholder="一句话说清现象,如:播放器偶发黑屏"
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
        ? selectedModule?.repositories.length ? "模块带出,可增删改" : "可选,可后补(拉取代码仓阶段再定)"
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

function DtsRegister({
  viewer,
  issues,
  active,
  onCreated,
  onError,
  onNavigateProfile,
}: {
  viewer: AuthUser;
  /** 我的会话列表:发起前按单查重(服务端 create 同样机械拦)。 */
  issues: IssueSummary[];
  /** 页签是否激活:首次激活自动拉取一次名下问题单,之后手动刷新。 */
  active: boolean;
  onCreated: (issue: IssueSummary) => void;
  onError: (message: string) => void;
  onNavigateProfile?: () => void;
}) {
  const [tickets, setTickets] = useState<DtsTicketBrief[] | undefined>();
  // 外部开发模式(--dts-mock):单据为模拟数据,页签挂 DEV 徽标防误认。
  const [dtsMock, setDtsMock] = useState(false);
  const [loading, setLoading] = useState(false);
  // 批量发起(2026-08-28):勾选多张,逐张独立发起工作流。
  const [selected, setSelected] = useState<string[]>([]);
  // 登记不再强制带仓:留空=发起后由「拉取代码仓」阶段的平台闸补定。
  const [repoUrl, setRepoUrl] = useState("");
  // 业务模块:与手工登记同款选择器(选中自动带出主仓);目录空回退自由文本。
  const [moduleId, setModuleId] = useState("");
  const [moduleName, setModuleName] = useState("");
  const [modules, setModules] = useState<BusinessModule[] | undefined>();
  const [envHosts, setEnvHosts] = useState("");
  const [envPassword, setEnvPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const fixed = viewer.issue_flow !== "free";
  const moduleCatalog = useMemo(
    () => (modules ?? []).filter((module) => module.status === "active"),
    [modules]);
  const selectedModule = moduleCatalog.find((module) => module.id === moduleId);
  useEffect(() => {
    let alive = true;
    // 目录读不到按空处理:回退手填,不让模块库故障堵死问题发起。
    getBusinessModules()
      .then((catalog) => { if (alive) setModules(catalog.modules); })
      .catch(() => { if (alive) setModules([]); });
    return () => { alive = false; };
  }, []);
  // 个人凭据前置门禁:只有真填了远端仓才要 Git 身份(登记不强制带仓,
  // 缺仓由拉取代码仓阶段的平台闸补定,与手工登记同语义)。
  const touchRemoteRepo = /^https?:\/\//i.test(repoUrl.trim());
  const credentialBlocked = touchRemoteRepo
    && (!viewer.git_token_hint || !viewer.git_email);

  /** 选模块即带仓(与手工登记 changeModule 同款):单仓字段取主仓。 */
  function changeModule(nextId: string) {
    setModuleId(nextId);
    const module = moduleCatalog.find((item) => item.id === nextId);
    if (module?.repositories.length) setRepoUrl(module.repositories[0]);
  }

  // 模糊搜索:单号/标题/版本,大小写不敏感;版本多选过滤叠加其上。
  const [query, setQuery] = useState("");
  const [selectedVersions, setSelectedVersions] = useState<string[]>([]);
  // 版本下拉多选框的展开态;点面板外或 Esc 关闭。
  const [versionOpen, setVersionOpen] = useState(false);
  const versionBoxRef = useRef<HTMLDivElement | null>(null);
  // 可发起的单 = 状态为"开发人员实施修改"的;其余状态不展示。
  const actionable = useMemo(() =>
    tickets?.filter(isActionableDts) ?? undefined, [tickets]);
  const fuzzyMatches = useMemo(() => {
    if (!actionable) return undefined;
    const q = query.trim().toLowerCase();
    if (!q) return actionable;
    return actionable.filter((t) =>
      t.ticket.toLowerCase().includes(q)
      || t.title.toLowerCase().includes(q)
      || (t.version && t.version.toLowerCase().includes(q))
    );
  }, [actionable, query]);

  // 版本过滤:把可发起单的版本汇总去重,按 R 版降序、R 同比 C 版。
  const versions = useMemo(() => {
    const set = new Set<string>();
    actionable?.forEach((t) => { if (t.version) set.add(t.version); });
    return sortDtsVersionsDesc([...set]);
  }, [actionable]);

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
  // 远程结果随 effect 复位消失,恢复展示名下全部问题单。远程命中的单
  // 也只展示可发起状态;被状态挡下的汇总一条提示,不让用户以为单号不存在。
  const remoteTickets = remote.tickets;
  const hiddenRemote = remoteTickets.filter((t) => !isActionableDts(t));
  const display = useMemo(() => {
    const list = versionFiltered ?? [];
    const extra = remoteTickets.filter((r) =>
      isActionableDts(r) && !list.some((item) => item.ticket === r.ticket));
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
    setSelected([]);
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

  // 首次激活自动拉取:点开「DTS 列表」直接见列表,不再多一次点击;
  // 之后列表靠「刷新」手动更新(面板常驻,换页签不清状态)。
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (!active || autoLoaded.current) return;
    autoLoaded.current = true;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

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

  /** 批量发起(2026-08-28):每单一个独立工作流,共享模块/环境/可选仓
   * 等登记信息;逐张串行 create,单张失败不拖垮整批。已有进行中会话的
   * 单跳过并计入失败(服务端 create 的同单查重也会兜一道)。结束后
   * 一条汇总横幅:成功 N 张 + 失败 M 张(单号 → 原因);有成功的跳进
   * 第一张的会话。 */
  async function launch() {
    if (!selected.length || busy) return;
    const hosts = envHosts.split(/[,，\s]+/).map((host) => host.trim()).filter(Boolean);
    const environment = hosts.length && envPassword
      ? { hosts, password: envPassword } : undefined;
    setBusy(true);
    const launched: string[] = [];
    const failures: string[] = [];
    let first: IssueSummary | undefined;
    try {
      for (const ticketNo of selected) {
        const clash = issues.find((item) => item.ticket === ticketNo
          && !["archived", "canceled", "failed"].includes(item.status));
        if (clash) {
          failures.push(`${ticketNo} → 已有进行中的问题会话(${clash.id})`);
          continue;
        }
        // 远程补查的单也能发起:标题从远程详情里取。
        const ticket = tickets?.find((item) => item.ticket === ticketNo)
          ?? remote.tickets.find((item) => item.ticket === ticketNo);
        try {
          const created = await createIssue({
            title: ticket?.title || ticketNo,
            source: "dts",
            ticket: ticketNo,
            description: ticket?.title || undefined,
            repo_url: repoUrl.trim() || undefined,
            ...(moduleId ? { module_id: moduleId } : {}),
            ...(!moduleId && moduleName.trim() ? { module: moduleName.trim() } : {}),
            ...(environment ? { environment } : {}),
          });
          launched.push(created.id);
          first ??= created;
        } catch (reason) {
          failures.push(`${ticketNo} → ${
            String(reason instanceof Error ? reason.message : reason)}`);
        }
      }
    } finally {
      setBusy(false);
    }
    if (first) onCreated(first);
    if (failures.length) {
      onError(`成功 ${launched.length} 张${launched.length ? `:${launched.join("、")}` : ""};`
        + `失败 ${failures.length} 张:${failures.join(";")}`);
    } else {
      setNote(`成功发起 ${launched.length} 张:${launched.join("、")}`
        + (selected.length > 1 ? "(每单一个独立工作流)" : ""));
      setSelected([]);
    }
  }

  return <div className="issue-dts">
    {dtsMock && <p className="issue-dts-mock-banner" role="note">
      DEV·模拟 DTS:外部开发模式,单据为本地模拟数据(--dts-mock),
      不是真实问题单;流程与真实模式完全一致。
    </p>}
    <div className="issue-dts-toolbar">
      <div className="issue-dts-toolbar-side">
        <button type="button" className="issue-dts-refresh" onClick={load}
          disabled={loading}
          title="重新拉取名下问题单(勾选与搜索会重置)">
          {loading ? (tickets === undefined ? "拉取中…" : "刷新中…") : "↻ 刷新"}
        </button>
        {note && <span className="issue-dts-note">{note}</span>}
      </div>
      <button type="button" className="primary"
        disabled={!selected.length || busy || credentialBlocked}
        title={selected.length > 1 ? `将逐张发起 ${selected.length} 个独立工作流` : undefined}
        onClick={launch}>
        {busy ? "发起中…" : selected.length > 1 ? `发起处理(${selected.length} 张)` : "发起处理"}
      </button>
    </div>
    {tickets === undefined && loading && <p className="issue-dts-hint">
      正在拉取 {viewer.username} 名下的问题单…
    </p>}
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
              {display.length} / {actionable?.length ?? 0} 条
            </span>}
      </div>
      {hiddenRemote.length > 0 && <div className="issue-dts-note">
        {hiddenRemote.map((t) => t.ticket).join("、")} 存在,但状态不是
        "{DTS_ACTIONABLE_STATUS}",不在可拉取范围。
      </div>}
      <div className="issue-dts-list" role="table">
        {display.length > 0
          ? display.map((ticket) => {
            const isRemote = remote.tickets.some((item) => item.ticket === ticket.ticket);
            const isExpanded = expandedTicket === ticket.ticket;
            const detail = detailCache[ticket.ticket];
            return <div key={ticket.ticket}
              className={`issue-dts-row${selected.includes(ticket.ticket) ? " on" : ""}${isExpanded ? " expanded" : ""}`}>
              <label className="issue-dts-row-main">
                <input type="checkbox" checked={selected.includes(ticket.ticket)}
                  onChange={(event) => setSelected((current) => event.target.checked
                    ? [...current, ticket.ticket]
                    : current.filter((item) => item !== ticket.ticket))} />
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
                        __html: prepareDtsHtml(detail?.description || ticket.description)
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
          勾选要发起的问题单(可多选,每单一个独立工作流)。
        </p>
      </div>
    </>}
    {tickets && tickets.length === 0 && <p className="issue-dts-hint">
      你的名下当前没有问题单。
    </p>}
    {tickets && tickets.length > 0 && (actionable?.length ?? 0) === 0
      && <p className="issue-dts-hint">
        名下问题单里没有"{DTS_ACTIONABLE_STATUS}"状态的——其他状态不可发起。
      </p>}
    <CredentialGate viewer={viewer} needRepo={touchRemoteRepo}
      onNavigateProfile={onNavigateProfile} />
    {/* 登记不卡仓(2026-08-28):仓可选,留空时由「拉取代码仓」阶段的
        平台闸补定(AI 识别/填地址/跳过);业务模块选中即带出主仓;网管
        环境换库验证要用,登记时一并带上(缺了也会在用时现场举闸补配)。 */}
    <div className="issue-dts-fields">
      <label className="issue-field">
        <span>代码仓地址 <i>{fixed ? "可选,可后补(拉取代码仓阶段再定)" : "可选"}</i></span>
        <input value={repoUrl} placeholder="https://codehub.../repo.git"
          onChange={(event) => setRepoUrl(event.target.value)} />
      </label>
      <label className="issue-field">
        <span>业务模块 <i>可选{selectedModule ? "(已带出主仓)" : moduleCatalog.length ? "(选中自动带仓)" : ""}</i></span>
        {moduleCatalog.length > 0
          ? <select value={moduleId}
              onChange={(event) => changeModule(event.target.value)}>
              <option value="">不选择模块</option>
              {moduleCatalog.map((module) => (
                <option key={module.id} value={module.id}>
                  {module.name}(绑 {module.repositories.length} 个仓)
                </option>
              ))}
            </select>
          : <input value={moduleName} maxLength={60}
              placeholder="如:媒体中心(仅展示与报告引用)"
              onChange={(event) => setModuleName(event.target.value)} />}
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
