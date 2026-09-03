/**
 * 登记域:发起问题会话的两个页签(登记问题 / DTS 列表)。
 *
 * 从 IssueBoard.tsx 原文搬移(spec #2 按域拆分,纯搬移零行为变化):
 * 两个子面板常驻(隐藏切换),表单/勾选/搜索状态跨页签驻留。
 * DTS 文本/版本/候选纯函数在 dtsText.ts,单据 HTML 的图片代理重写与
 * 白名单消毒在 dtsHtml.ts,这里只引用不重复。
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  createIssue,
  getBusinessModules,
  getDtsModuleBindings,
  getDtsTicketDetail,
  issueImageUrl,
  listDtsTickets,
  putDtsModuleBinding,
  uploadIssueImage,
  type AuthUser,
  type BusinessModule,
  type DtsModuleBindingEntry,
  type DtsTicketBrief,
  type DtsTicketDetail,
  type IssueSummary,
} from "../api";
import { prepareDtsHtml } from "./dtsHtml";
import {
  DTS_ACTIONABLE_STATUS,
  dtsNoCandidates,
  dtsVersionGroup,
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

/** 网管常见默认口令(现场公开默认值,ADR-0003 裁定允许进上下文;与
 * 平台凭据是两回事):写死前端常量不做配置面(spec #15),PasswordCombo
 * 下拉一键填,特殊口令仍可自由手输。 */
const NETMAN_COMMON_PASSWORDS = [
  "Huawei_123",
  "Changeme_456",
  "Changeme_123",
  "Changeme_789",
  "Huawei_456",
  "Huawei_789",
  "Aa@12345678",
];

/** PasswordCombo:密码输入框 + 常见口令下拉,点选即填、也可自由手输。
 * 展开态交互沿 DTS 版本多选框的成熟模式:面板锚定在 wrapper 上,点
 * 面板外或 Esc 收起。零外部依赖;页面密码与后台密码各用一套实例,
 * 值由父级受控——父级保证密码不进草稿(共机不残留凭据)。 */
function PasswordCombo({ value, onChange, name }: {
  value: string;
  onChange: (next: string) => void;
  /** 无障碍名:输入框与触发钮的 aria-label 共用。 */
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listId = useId();

  function openAndFocus(index: number) {
    const next = Math.max(0, Math.min(index, NETMAN_COMMON_PASSWORDS.length - 1));
    setActiveIndex(next);
    setOpen(true);
    window.requestAnimationFrame(() => optionRefs.current[next]?.focus());
  }

  function closeAndFocusTrigger() {
    setOpen(false);
    window.requestAnimationFrame(() => toggleRef.current?.focus());
  }

  // 点面板外、Tab 到组件外或 Esc 收起(与 DTS 版本下拉同一套交互)。
  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onFocus = (event: FocusEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
    };
  }, [open]);
  return <div className="issue-password-combo" ref={boxRef}>
    <div className="issue-password-row">
      <input type="password" value={value} aria-label={name}
        aria-controls={listId} aria-expanded={open} aria-haspopup="listbox"
        autoComplete="new-password" placeholder="下拉选常见口令,或直接输入"
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openAndFocus(event.key === "ArrowDown" ? 0
              : NETMAN_COMMON_PASSWORDS.length - 1);
          }
        }}
        onChange={(event) => onChange(event.target.value)} />
      <button ref={toggleRef} type="button" className="issue-password-toggle"
        aria-label={`${name}常见口令`} aria-expanded={open}
        aria-controls={listId} aria-haspopup="listbox" title="常见默认口令"
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openAndFocus(event.key === "ArrowDown" ? 0
              : NETMAN_COMMON_PASSWORDS.length - 1);
          }
        }}
        onClick={() => {
          if (open) setOpen(false);
          else openAndFocus(Math.max(0, NETMAN_COMMON_PASSWORDS.indexOf(value)));
        }}>▾</button>
    </div>
    {open && <div id={listId} className="issue-password-menu" role="listbox"
      aria-label={`${name}的常见口令`}>
      {NETMAN_COMMON_PASSWORDS.map((password, index) => (
        <button type="button" key={password} role="option"
          ref={(node) => { optionRefs.current[index] = node; }}
          aria-selected={value === password}
          className={`issue-password-option${value === password ? " on" : ""}`}
          tabIndex={index === activeIndex ? 0 : -1}
          onFocus={() => setActiveIndex(index)}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              const next = event.key === "Home" ? 0
                : event.key === "End" ? NETMAN_COMMON_PASSWORDS.length - 1
                  : event.key === "ArrowDown"
                    ? (index + 1) % NETMAN_COMMON_PASSWORDS.length
                    : (index - 1 + NETMAN_COMMON_PASSWORDS.length)
                      % NETMAN_COMMON_PASSWORDS.length;
              setActiveIndex(next);
              optionRefs.current[next]?.focus();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeAndFocusTrigger();
            }
          }}
          onClick={() => {
            onChange(password);
            closeAndFocusTrigger();
          }}>
          {password}
        </button>
      ))}
    </div>}
  </div>;
}

/** 只读仓清单行的短名:剥协议取末段再去 .git(file:// 演示仓同样适用);
 * 全 URL 挂 title,悬停可见。 */
function repoLabel(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/)
    .filter(Boolean).pop() ?? url;
  return last.replace(/\.git$/i, "") || url;
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
  return <section className="issue-section" aria-label="发起问题会话">
    {/* 页签即区块头:两个页签各自表意(登记问题/DTS 列表),上面再压
        一层"发起会话/登记问题"标题是三重冗余,且对 DTS 页签名不副实。 */}
    <div className="section-head">
      <div className="issue-register-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "manual"}
          className={tab === "manual" ? "on" : ""}
          onClick={() => setTab("manual")}>登记问题</button>
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
        onCreated={onCreated} onError={onError} />
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
  const [imageUploading, setImageUploading] = useState(false);
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
  // 业务模块必选(spec #15):仓的唯一来源是模块绑定——手填仓、自由
  // 文本模块与 DTS 单号一并废除,无单场景只有一个入口:选模块。
  const [moduleId, setModuleId] = useState("");
  const [modules, setModules] = useState<BusinessModule[] | undefined>();
  const [moduleLoadError, setModuleLoadError] = useState("");
  const [moduleLoadAttempt, setModuleLoadAttempt] = useState(0);
  // 网管环境四件套常开必填(不再折叠):单个 IP/页面账号
  // (预填 admin 可改)/页面密码/网管后台密码。两个密码不进草稿。
  const [envHosts, setEnvHosts] = useState("");
  const [envPageAccount, setEnvPageAccount] = useState("admin");
  const [envPagePassword, setEnvPagePassword] = useState("");
  const [envBackendPassword, setEnvBackendPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const draftKey = `mae-flow:issue:draft:${viewer.username}`;
  // 下拉只收 active 且至少绑一个仓的模块:零仓存量模块发起必被服务端
  // 打回,不进下拉让它根本没有被选中的机会(spec #15)。
  const moduleCatalog = useMemo(() => (modules ?? []).filter((module) =>
    module.status === "active" && module.repositories.length > 0), [modules]);
  const selectedModule = moduleCatalog.find((module) => module.id === moduleId);
  useEffect(() => {
    let alive = true;
    setModules(undefined);
    setModuleLoadError("");
    // 加载失败和空目录是两种事实:前者给重试,后者指路团队资产。两种
    // 情况都不回退手填仓(spec #15:仓的唯一权威是模块绑定)。
    getBusinessModules()
      .then((catalog) => { if (alive) setModules(catalog.modules); })
      .catch((cause) => {
        if (!alive) return;
        setModuleLoadError(cause instanceof Error
          ? cause.message : "业务模块目录暂时无法读取");
      });
    return () => { alive = false; };
  }, [moduleLoadAttempt]);
  // 草稿纪律(spec #15):只存 标题/现象/模块/hosts/页面账号;两个密码
  // 绝不进 localStorage——刷新或换机后密码框为空,共机不残留凭据。
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) ?? "null");
      if (saved) {
        setTitle(saved.title ?? "");
        setDescription(saved.description ?? "");
        setModuleId(typeof saved.moduleId === "string" ? saved.moduleId : "");
        setEnvHosts(typeof saved.hosts === "string" ? saved.hosts : "");
        if (saved.pageAccount) setEnvPageAccount(String(saved.pageAccount));
      }
    } catch { /* 草稿是旁路,坏了就坏了吧 */ }
  }, [draftKey]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({
          title, description, moduleId,
          hosts: envHosts, pageAccount: envPageAccount,
        }));
      } catch { /* 同上 */ }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draftKey, title, description, moduleId, envHosts, envPageAccount]);

  // 现象描述内嵌截图:粘贴/拖拽图片 → 上传落 staging → 在光标处插入
  // ![截图](issue-images/<hash>.<ext>) 引用。图片本体不进 description,
  // 进的只有工作区相对路径引用(与 ticketImages 同款架构红线)。
  const ISSUE_IMAGE_PATTERN =
    /issue-images\/[0-9a-f]{16}\.[a-z]+/gi;

  function insertImageRef(ref: string) {
    const textarea = descriptionRef.current;
    const markdown = `![截图](${ref})`;
    if (!textarea) {
      setDescription((prev) => `${prev}${prev ? "\n" : ""}${markdown}`);
      return;
    }
    const start = textarea.selectionStart ?? description.length;
    const end = textarea.selectionEnd ?? description.length;
    const before = description.slice(0, start);
    const after = description.slice(end);
    const needPrefix = before.length > 0 && !before.endsWith("\n");
    const insert = `${needPrefix ? "\n" : ""}${markdown}${after.startsWith("\n") || after.length === 0 ? "" : "\n"}`;
    setDescription(before + insert + after);
    window.requestAnimationFrame(() => {
      const pos = (before + insert).length;
      textarea.focus();
      textarea.setSelectionRange(pos, pos);
    });
  }

  async function uploadAndInsert(file: File) {
    if (!file.type.startsWith("image/")) return;
    setImageUploading(true);
    try {
      const result = await uploadIssueImage(file);
      insertImageRef(result.path);
    } catch (reason) {
      onError(`图片上传失败:${String(reason instanceof Error ? reason.message : reason)}`);
    } finally {
      setImageUploading(false);
    }
  }

  function handleDescriptionPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) {
          event.preventDefault();
          void uploadAndInsert(file);
          return;
        }
      }
    }
  }

  function handleDescriptionDrop(event: React.DragEvent<HTMLTextAreaElement>) {
    const files = event.dataTransfer?.files;
    if (!files || !files.length) return;
    const image = Array.from(files).find((file) => file.type.startsWith("image/"));
    if (image) {
      event.preventDefault();
      void uploadAndInsert(image);
    }
  }

  // description 里的图片引用(缩略图条预览用)。
  const descriptionImages = useMemo(() => {
    if (!description) return [];
    const paths: string[] = [];
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    const pattern = new RegExp(ISSUE_IMAGE_PATTERN.source, "gi");
    while ((match = pattern.exec(description)) !== null) {
      const path = match[0];
      if (!seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
    return paths;
  }, [description]);

  // 个人凭据前置门禁:模块带出的仓一般是 https 远端,克隆与推送都用
  // 发起人身份——按模块绑定判断 needRepo;全本地仓(file:// 演示库)
  // 不拦。服务端 create 里机械拦(判定同源),这里把拦截面提前到表单。
  const touchRemoteRepo = (selectedModule?.repositories ?? [])
    .some((url) => /^https?:\/\//i.test(url));
  const credentialBlocked = touchRemoteRepo
    && (!viewer.git_token_hint || !viewer.git_email);

  // 发起按钮的灰化口径(spec 验收):目录为空/未选模块/凭据缺失/提交中。
  // 字段缺内容不灰按钮——提交时逐项给友好指路文案,让人知道卡在哪。
  const catalogEmpty = modules !== undefined && !moduleLoadError
    && moduleCatalog.length === 0;
  const submitDisabled = busy || credentialBlocked
    || moduleCatalog.length === 0 || !selectedModule;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || submitDisabled) return;
    if (!title.trim()) {
      onError("问题标题必填——一句话说清现象");
      return;
    }
    if (!description.trim()) {
      onError("现象描述必填——发生条件、影响范围、复现步骤,写得越具体 AI 少走弯路");
      return;
    }
    const host = envHosts.trim();
    if (!host) {
      onError("网管环境IP必填");
      return;
    }
    if (/[\s,，、]/.test(host)) {
      onError("网管环境IP一次只填一个，请不要输入逗号、空格或换行");
      return;
    }
    if (!envPageAccount.trim()) {
      onError("页面账号必填——默认 admin 可改,请填写网管页面登录名");
      return;
    }
    if (!envPagePassword.trim()) {
      onError("页面密码必填");
      return;
    }
    if (!envBackendPassword.trim()) {
      onError("网管后台密码必填");
      return;
    }
    setBusy(true);
    try {
      const created = await createIssue({
        title: title.trim(),
        description: description.trim(),
        module_id: moduleId,
        environment: {
          hosts: [host],
          page_account: envPageAccount.trim(),
          page_password: envPagePassword,
          backend_password: envBackendPassword,
        },
      });
      setTitle(""); setDescription(""); setModuleId("");
      setEnvHosts(""); setEnvPageAccount("admin");
      setEnvPagePassword(""); setEnvBackendPassword("");
      onCreated(created);
    } catch (reason) {
      onError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(false);
    }
  }

  return <form className="issue-form" onSubmit={submit}>
    <div className="issue-group wide">
      <span className="issue-group-title">问题信息</span>
      <div className="issue-group-body">
        <label className="issue-field wide">
          <span>问题标题 <i className="req">*</i></span>
          <input value={title} placeholder="一句话说清现象,如:播放器偶发黑屏"
            onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="issue-field wide">
          <span>现象描述 <i className="req">*</i></span>
          <textarea rows={3} value={description} ref={descriptionRef}
            placeholder="发生条件、影响范围、复现步骤;有日志片段也可以贴进来,粘贴或拖拽图片自动上传"
            onPaste={handleDescriptionPaste}
            onDrop={handleDescriptionDrop}
            onChange={(event) => setDescription(event.target.value)} />
          {(imageUploading || descriptionImages.length > 0) && (
            <div className="issue-image-bar">
              {imageUploading && <span className="issue-image-uploading">上传中…</span>}
              {descriptionImages.map((path) => (
                <img key={path} className="issue-image-thumb"
                  src={issueImageUrl(path)} alt="现象截图"
                  draggable={false} />
              ))}
            </div>
          )}
        </label>
        {/* 仓不占版面(拍板 2026-08-31):选中模块即带出绑定仓,清单
            收进悬停提示——悬停选择器或提示行就能看到将拉取哪些仓;
            要增删仓去「团队资产 → 业务模块」维护绑定,登记页不改。 */}
        <label className="issue-field wide">
          <span>业务模块 <i className="req">*</i></span>
          <span className="issue-module-wrap">
            <select value={moduleId}
              disabled={modules === undefined || !!moduleLoadError}
              onChange={(event) => setModuleId(event.target.value)}>
              <option value="" disabled>选择业务模块——决定关联代码仓</option>
              {moduleCatalog.map((module) => (
                <option key={module.id} value={module.id}>
                  {module.name}(绑 {module.repositories.length} 个仓)
                </option>
              ))}
            </select>
            {selectedModule && <>
              <small className="issue-module-hint">
                已带出 {selectedModule.repositories.length} 个代码仓,悬停查看
              </small>
              <span className="issue-module-tip" role="tooltip">
                <b>将拉取 {selectedModule.repositories.length} 个代码仓</b>
                <ul>
                  {selectedModule.repositories.map((url) => (
                    <li key={url} title={url}>{repoLabel(url)}</li>
                  ))}
                </ul>
              </span>
            </>}
          </span>
          {moduleLoadError && <small className="issue-module-load-error" role="alert">
            <span>业务模块加载失败：{moduleLoadError}</span>
            <button type="button" onClick={() => setModuleLoadAttempt((value) => value + 1)}>
              重试加载
            </button>
          </small>}
          {catalogEmpty && <small role="alert">
            模块目录为空——先到「团队资产 → 业务模块」登记并绑定代码仓,再回来发起。
          </small>}
        </label>
      </div>
    </div>
    <div className="issue-group wide">
      <span className="issue-group-title">网管环境</span>
      <div className="issue-group-body">
        <label className="issue-field">
          <span>网管环境IP <i className="req">*</i></span>
          <input value={envHosts} spellCheck={false}
            placeholder="60.14.46.16"
            onChange={(event) => setEnvHosts(event.target.value)} />
        </label>
        <label className="issue-field">
          <span>页面账号 <i className="req">*</i></span>
          <input value={envPageAccount} placeholder="admin" required
            onChange={(event) => setEnvPageAccount(event.target.value)} />
        </label>
        <div className="issue-field">
          <span>页面密码 <i className="req">*</i></span>
          <PasswordCombo name="页面密码" value={envPagePassword}
            onChange={setEnvPagePassword} />
        </div>
        <div className="issue-field">
          <span>网管后台密码 <i className="req">*</i></span>
          <PasswordCombo name="网管后台密码" value={envBackendPassword}
            onChange={setEnvBackendPassword} />
        </div>
        <small className="issue-group-note issue-privacy-note">
          口令由服务端加密保存，不会出现在会话列表、状态摘要或事件流中，
          但会以明文进入本问题的 AI 上下文；请勿填写个人复用或生产口令。
        </small>
      </div>
    </div>
    <CredentialGate viewer={viewer} needRepo={touchRemoteRepo}
      onNavigateProfile={onNavigateProfile} />
    <div className="issue-form-actions">
      <button type="submit" className="primary" disabled={submitDisabled}>
        {busy ? "分析中…" : "开始分析"}
      </button>
    </div>
  </form>;
}

function DtsRegister({
  viewer,
  issues,
  active,
  onCreated,
  onError,
}: {
  viewer: AuthUser;
  /** 我的会话列表:发起前按单查重(服务端 create 同样机械拦)。 */
  issues: IssueSummary[];
  /** 页签是否激活:首次激活自动拉取一次名下问题单,之后手动刷新。 */
  active: boolean;
  onCreated: (issue: IssueSummary) => void;
  onError: (message: string) => void;
}) {
  const [tickets, setTickets] = useState<DtsTicketBrief[] | undefined>();
  // 外部开发模式(--dts-mock):单据为模拟数据,页签挂 DEV 徽标防误认。
  const [dtsMock, setDtsMock] = useState(false);
  const [loading, setLoading] = useState(false);
  // 批量发起(2026-08-28):勾选多张,逐张独立发起工作流。
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // 人工预绑模块列(spec #57):单号→模块团队共享映射,选即存;发起
  // 时静默携带,服务端烙 module_locked 锁——AI 不得改绑。列可整体
  // 隐藏(纯 UI 偏好,localStorage 按用户记忆)。
  const moduleColKey = `mae-flow:dts-module-col:${viewer.username}`;
  const [moduleCol, setModuleCol] = useState(() => {
    try {
      return localStorage.getItem(moduleColKey) !== "hidden";
    } catch { return true; }
  });
  const [bindings, setBindings] = useState<Record<string, DtsModuleBindingEntry>>({});
  const [modules, setModules] = useState<BusinessModule[]>();
  // 行内保存反馈:哪张单正在存/哪张单存失败(失败显示原因,选择回滚)。
  const [bindingTicket, setBindingTicket] = useState("");
  const [bindFail, setBindFail] = useState<{ ticket: string; message: string }>();
  // 下拉目录与登记页同一把尺:active 且至少绑一个仓——绑了也没用的
  // 模块不给选。
  const moduleCatalog = useMemo(() => (modules ?? [])
    .filter((module) => module.status === "active"
      && module.repositories.length > 0),
  [modules]);

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

  // 版本过滤(2026-08-29 拍板):按 B 版之前的版本段分组汇总(如
  // V100R025C10SPC010B009 → V100R025C10SPC010),降序去重——B 版构建号
  // 非常多,按完整版本过滤要大量勾选;勾一个组,组内全部 B 版都命中。
  const versions = useMemo(() => {
    const set = new Set<string>();
    actionable?.forEach((t) => {
      if (t.version) set.add(dtsVersionGroup(t.version));
    });
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
    // 命中口径与汇总同尺:单据版本剥掉 B 段后落在勾选的组里即命中
    // (组内所有 B 版构建号一并带出)。
    return list.filter((t) => t.version
      && selectedVersions.includes(dtsVersionGroup(t.version)));
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
        // 状态不带入列,可拉取判定(isActionableDts)会把远程命中的单
        // 全部误判为"状态不可拉取"而不展示。
        status: detail.status,
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

  // 全选表头(三态):只作用于当前展示列表(搜索+版本过滤后)——全中时
  // 点击整体取消,部分或全无时一键勾满。已勾选但被过滤掉的单不在展示
  // 列表里,保持原样,发起时照常带上。
  const displayedTickets = display.map((t) => t.ticket);
  const displayedSelectedCount =
    displayedTickets.filter((no) => selected.includes(no)).length;
  const allDisplayedSelected = displayedTickets.length > 0
    && displayedSelectedCount === displayedTickets.length;
  function toggleSelectAll() {
    if (allDisplayedSelected) {
      const shown = new Set(displayedTickets);
      setSelected((current) => current.filter((no) => !shown.has(no)));
    } else {
      setSelected((current) =>
        [...new Set([...current, ...displayedTickets])]);
    }
  }

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
  // 之后列表靠「刷新」手动更新(面板常驻,换页签不清状态)。绑定映射
  // 与模块目录同一拍加载。
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (!active || autoLoaded.current) return;
    autoLoaded.current = true;
    void load();
    void getDtsModuleBindings().then(setBindings).catch(() => undefined);
    void getBusinessModules()
      .then((catalog) => setModules(catalog.modules))
      .catch(() => setModules([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /** 选即存:乐观更新本地映射,PUT 失败回滚并把原因落在那一行。 */
  async function bindModule(ticketNo: string, moduleId: string) {
    const previous = bindings[ticketNo];
    setBindingTicket(ticketNo);
    setBindFail(undefined);
    setBindings((current) => {
      const next = { ...current };
      if (moduleId) {
        next[ticketNo] = {
          module_id: moduleId,
          updated_by: viewer.username,
          updated_at: new Date().toISOString(),
        };
      } else {
        delete next[ticketNo];
      }
      return next;
    });
    try {
      await putDtsModuleBinding(ticketNo, moduleId || null);
    } catch (reason) {
      setBindings((current) => {
        const next = { ...current };
        if (previous) next[ticketNo] = previous;
        else delete next[ticketNo];
        return next;
      });
      setBindFail({
        ticket: ticketNo,
        message: String(reason instanceof Error ? reason.message : reason),
      });
    } finally {
      setBindingTicket("");
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

  /** 批量发起(2026-08-28):每单一个独立工作流;逐张串行 create,
   * 单张失败不拖垮整批。已有进行中会话的单跳过并计入失败(服务端
   * create 的同单查重也会兜一道)。结束后一条汇总横幅:成功 N 张 +
   * 失败 M 张(单号 → 原因);有成功的跳进第一张的会话。payload 带
   * 单号与标题;有人工预绑模块的一并带上——会话开场即带模块与仓,
   * AI 跳过识别且被锁死不得改绑(spec #57);没绑的照旧 AI 识别。 */
  async function launch() {
    if (!selected.length || busy) return;
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
        const binding = bindings[ticketNo];
        try {
          const created = await createIssue({
            title: ticket?.title || ticketNo,
            source: "dts",
            ticket: ticketNo,
            description: ticket?.title || undefined,
            ...(binding ? { module_id: binding.module_id } : {}),
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
            <svg viewBox="0 0 16 16" aria-hidden>
              <path d="M13.5 8a5.5 5.5 0 1 1-1.62-3.9M13.5 1.5v3h-3" />
            </svg>
            <span>{loading ? (tickets === undefined ? "拉取中…" : "刷新中…") : "刷新"}</span>
          </button>
          <button type="button" role="switch" aria-checked={moduleCol}
            className={`issue-dts-module-toggle${moduleCol ? " on" : ""}`}
            title="显示或隐藏「所属模块」列"
            onClick={() => {
              const next = !moduleCol;
              setModuleCol(next);
              try {
                localStorage.setItem(moduleColKey, next ? "shown" : "hidden");
              } catch { /* 旁路:存不下就本次会话内有效 */ }
            }}>
            模块列
          </button>
          {note && <span className="issue-dts-note">{note}</span>}
        </div>
      <button type="button" className="primary"
        disabled={!selected.length || busy}
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
          <i aria-hidden className={versionOpen ? "open" : undefined}>
            <svg viewBox="0 0 16 16"><path d="m4 6.5 4 4 4-4" /></svg>
          </i>
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
        {display.length > 0 && <div className="issue-dts-row issue-dts-selectall">
          <label className="issue-dts-selectall-main">
            <input type="checkbox" checked={allDisplayedSelected}
              ref={(node) => {
                if (node) node.indeterminate =
                  displayedSelectedCount > 0 && !allDisplayedSelected;
              }}
              onChange={toggleSelectAll} />
            <span className="issue-dts-selectall-label">全选</span>
            <span className="issue-dts-selectall-count">
              已选 {displayedSelectedCount} / {displayedTickets.length} 张
            </span>
          </label>
          {moduleCol && <span className="issue-dts-module-head">所属模块</span>}
        </div>}
        {display.length > 0
          ? display.map((ticket) => {
            const isRemote = remote.tickets.some((item) => item.ticket === ticket.ticket);
            const isExpanded = expandedTicket === ticket.ticket;
            const detail = detailCache[ticket.ticket];
            const detailId = `issue-dts-detail-${encodeURIComponent(ticket.ticket)}`;
            return <div key={ticket.ticket}
              className={`issue-dts-row${selected.includes(ticket.ticket) ? " on" : ""}${isExpanded ? " expanded" : ""}`}>
              <div className="issue-dts-row-control">
                {/* 单号在勾选 label 之外:拖选复制单号不会误勾选——单号
                    是绑单/推送分支名的关键操作对象,复制是高频动作。 */}
                <span className="issue-dts-identity">
                  <span className="issue-dts-ticket">{ticket.ticket}</span>
                  {isRemote && <span className="issue-dts-remote">远程</span>}
                </span>
                <label className="issue-dts-row-main">
                  <input type="checkbox" checked={selected.includes(ticket.ticket)}
                    onChange={(event) => setSelected((current) => event.target.checked
                      ? [...current, ticket.ticket]
                      : current.filter((item) => item !== ticket.ticket))} />
                  <span className="issue-dts-title">{ticket.title || "(无标题)"}</span>
                  {ticket.status && <span className="issue-dts-status">{ticket.status}</span>}
                </label>
                <button type="button" className="issue-dts-expand"
                  aria-expanded={isExpanded}
                  aria-controls={detailId}
                  aria-label={`${isExpanded ? "收起" : "展开"} ${ticket.ticket} 详情`}
                  onClick={() => void toggleExpand(ticket.ticket)}>
                  <svg viewBox="0 0 16 16" aria-hidden className={isExpanded ? "open" : undefined}>
                    <path d="m6 4 4 4-4 4" />
                  </svg>
                </button>
              </div>
              {moduleCol && <div className="issue-dts-module-cell">
                <select
                  value={bindings[ticket.ticket]?.module_id ?? ""}
                  disabled={bindingTicket === ticket.ticket}
                  aria-label={`${ticket.ticket} 所属业务模块`}
                  title="人工预绑这张单所属的业务模块;发起分析时直接带出,AI 不再识别"
                  onChange={(event) =>
                    void bindModule(ticket.ticket, event.target.value)}>
                  <option value="">未选择(AI 运行时识别)</option>
                  {moduleCatalog.map((module) => (
                    <option key={module.id} value={module.id}>
                      {module.name}
                    </option>))}
                </select>
                {bindFail?.ticket === ticket.ticket
                  && <span className="issue-dts-module-fail" role="alert">
                    {bindFail.message}
                  </span>}
              </div>}
              {isExpanded && <div id={detailId} className="issue-dts-detail">
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
  </div>;
}
