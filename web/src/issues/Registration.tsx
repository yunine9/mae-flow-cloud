import { RepositoryResourceNotice } from "../RepositoryResourceNotice";
/**
 * 登记域:发起问题会话的两个页签(登记问题 / DTS 列表)。
 *
 * 从 IssueBoard.tsx 原文搬移(spec #2 按域拆分,纯搬移零行为变化):
 * 两个子面板常驻(隐藏切换),表单/勾选/搜索状态跨页签驻留。
 * DTS 文本/版本/候选纯函数在 dtsText.ts,单据 HTML 的图片代理重写与
 * 白名单消毒在 dtsHtml.ts,这里只引用不重复。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ChevronRight } from "lucide-react";
import {
  createIssue,
  getBusinessModules,
  getDtsModuleBindings,
  getDtsTicketDetail,
  issueImageUrl,
  listDtsTickets,
  polishIssueDescription,
  putDtsModuleBinding,
  uploadIssueImage,
  type AuthUser,
  type BusinessModule,
  type DtsModuleBindingEntry,
  type DtsTicketBrief,
  type DtsTicketDetail,
  type EnvironmentView,
  type IssuePolishResult,
  type IssueSummary,
} from "../api";
import { EnvironmentPicker } from "../EnvironmentPicker";
import { Markdown } from "../markdown";
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
  panel,
  visible = true,
}: {
  viewer: AuthUser;
  /** 我的会话列表:DTS 批量发起的前端查重用(服务端同样机械拦)。 */
  issues: IssueSummary[];
  onCreated: (issue: IssueSummary) => void;
  onError: (message: string) => void;
  onNavigateProfile?: () => void;
  /** 面板受控态(必传):当前面板由导航子页签决定——「问题登记/DTS列表」
   * 两个子页签各接管一个面板,内部不再自持页签按钮。 */
  panel: "dts" | "manual";
  /** 整域显隐(默认可见):导航切到「问题会话」时隐藏但**不卸载**——
   * 表单、勾选与搜索状态跨子页签驻留。 */
  visible?: boolean;
}) {
  // 两个子面板常驻(隐藏切换):DTS 列表、勾选与表单状态跨页签驻留,
  // 首开「DTS 列表」自动拉取一次,之后靠「刷新」手动更新。
  return <section className="issue-section" aria-label="发起问题会话"
    hidden={!visible}>
    <div hidden={panel !== "manual"}>
      <ManualRegister viewer={viewer} onCreated={onCreated} onError={onError}
        onNavigateProfile={onNavigateProfile} />
    </div>
    <div hidden={panel !== "dts"}>
      <DtsRegister viewer={viewer} issues={issues} active={panel === "dts"}
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
  // 网管环境(2026-09-10 走查裁定「只选不手填」):唯一作答面是台账
  // 快选(EnvironmentPicker 可搜索下拉,搜不到弹框新建并自动选中),
  // 后台密码用台账已存值(前端永远拿不到)。页面凭据已整体废弃
  // (2026-09-10:流程不登录网管页面,登记不再收页面账号/密码)。
  // 从环境管理选(#150,ADR-0020):选中即定,提交只带 environment_id——
  // 服务端以选定时点的台账值快照进会话。
  const [pickedEnv, setPickedEnv] = useState<EnvironmentView | null>(null);
  const [busy, setBusy] = useState(false);
  // AI 润色(#184):润色请求进行态 + 确认弹窗的润色稿(服务端不落库,
  // 放弃即丢弃)。建议标题在弹窗内可改,替换时随描述一起写回。
  const [polishing, setPolishing] = useState(false);
  const [polishResult, setPolishResult] = useState<IssuePolishResult | null>(null);
  const [adoptTitle, setAdoptTitle] = useState("");
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
  // 草稿纪律(spec #15):只存 标题/现象/模块;密码绝不进 localStorage
  // ——共机不残留凭据。
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) ?? "null");
      if (saved) {
        setTitle(saved.title ?? "");
        setDescription(saved.description ?? "");
        setModuleId(typeof saved.moduleId === "string" ? saved.moduleId : "");
      }
    } catch { /* 草稿是旁路,坏了就坏了吧 */ }
  }, [draftKey]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({
          title, description, moduleId,
        }));
      } catch { /* 同上 */ }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draftKey, title, description, moduleId]);

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

  // 从环境管理选(#150):选中即定,不再有手填回退——IP 即名字,
  // 搜不到走选择器内置的「新增环境」弹框(录完自动选中)。
  function pickEnv(entry: EnvironmentView) {
    setPickedEnv(entry);
  }

  function clearPickedEnv() {
    setPickedEnv(null);
  }

  /** AI 润色(#184):把随意的 标题+描述 整理成标准提单格式。识图观察由
   * 服务端组装(截图内容补充进润色稿);结果只进确认弹窗——替换前
   * 原稿一动不动。 */
  async function polish() {
    if (polishing || !description.trim()) return;
    setPolishing(true);
    try {
      const result = await polishIssueDescription({
        title: title.trim(),
        description,
        ...(selectedModule ? { module: selectedModule.name } : {}),
        ...(pickedEnv ? { environment: pickedEnv.ip } : {}),
      });
      setAdoptTitle(result.title);
      setPolishResult(result);
    } catch (reason) {
      onError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setPolishing(false);
    }
  }

  /** 弹窗里「替换」:标题(可改)与描述一起写回;「放弃」只关弹窗。 */
  function adoptPolish() {
    if (!polishResult) return;
    if (adoptTitle.trim()) setTitle(adoptTitle.trim());
    setDescription(polishResult.description);
    setPolishResult(null);
  }

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
    if (!pickedEnv) {
      onError("请从环境管理选择网管环境——搜不到就点下拉里的「新增环境」录一条");
      return;
    }
    setBusy(true);
    try {
      const created = await createIssue({
        title: title.trim(),
        description: description.trim(),
        module_id: moduleId,
        // 快选(#150):只带台账条目 id,值由服务端解密快照(前端零密码)。
        environment: { environment_id: pickedEnv.id },
      });
      setTitle(""); setDescription(""); setModuleId("");
      clearPickedEnv();
      onCreated(created);
    } catch (reason) {
      onError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(false);
    }
  }

  return <form className="issue-form" onSubmit={submit}>
    <RepositoryResourceNotice repositories={selectedModule?.repositories ?? []} />
    <div className="issue-group wide">
      <span className="issue-group-title">问题信息</span>
      <div className="issue-group-body">
        <label className="issue-field wide">
          <span>问题标题 <i className="req">*</i></span>
          <input value={title} placeholder="一句话说清现象,如:播放器偶发黑屏"
            onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="issue-field wide">
          <span className="issue-field-head">
            <span>现象描述 <i className="req">*</i></span>
            {/* AI 润色(#184):描述为空不可点,润色中防重复提交。 */}
            <button type="button" className="issue-polish-btn"
              disabled={!description.trim() || polishing}
              title="用 AI 把描述整理成标准提单格式(含截图内容识读)"
              onClick={() => void polish()}>
              {polishing ? "润色中…" : "AI 润色"}
            </button>
          </span>
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
        {/* 从环境管理选(#150,ADR-0020;2026-09-10 走查裁定「只选不
            手填」):可搜索下拉挑台账条目,搜不到点「新增环境」弹共用
            表单、录完自动选中;后台密码用台账已存值(前端拿不到)。 */}
        <div className="col-span-full">
          <EnvironmentPicker
            selectedId={pickedEnv?.id ?? null} onPick={pickEnv} />
        </div>
        {pickedEnv && <small className="issue-group-note col-span-full" role="status">
          将使用「环境管理」里 <span className="font-mono">{pickedEnv.ip}</span> 的已存密码
          (以选定时为准),无需在此填写。
        </small>}

      </div>
    </div>
    <CredentialGate viewer={viewer} needRepo={touchRemoteRepo}
      onNavigateProfile={onNavigateProfile} />
    <div className="issue-form-actions">
      <button type="submit" className="primary" disabled={submitDisabled}>
        {busy ? "分析中…" : "开始分析"}
      </button>
    </div>
    {/* 润色确认弹窗(#184):润色稿经预览才落地——替换前原稿一动不动;
        红色「待补充」(md-pending)提示页面没采集到的信息,不编造。 */}
    {polishResult && <Dialog open onOpenChange={(open) => {
      if (!open) setPolishResult(null);
    }}>
      <DialogContent className="issue-polish-dialog">
        <DialogHeader>
          <DialogTitle>AI 润色预览</DialogTitle>
          <DialogDescription>
            核对润色稿后选择替换或放弃;红色「待补充」是登记页没采集到的信息,可替换后在描述里补齐。
          </DialogDescription>
        </DialogHeader>
        {polishResult.vision_note && <p className="issue-polish-note" role="alert">
          {polishResult.vision_note}
        </p>}
        <label className="issue-field">
          <span>建议标题</span>
          <input value={adoptTitle}
            onChange={(event) => setAdoptTitle(event.target.value)} />
        </label>
        <div className="issue-polish-preview" aria-label="润色后描述预览">
          <Markdown text={polishResult.description}
            resolveImage={(path) => issueImageUrl(path)} />
        </div>
        <DialogFooter>
          <button type="button" onClick={() => setPolishResult(null)}>放弃</button>
          <button type="button" className="primary" onClick={adoptPolish}>
            替换原稿
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>}
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
      {/* 列表体:shadcn Table(2026-09-11 迁移,spec #171 评审后拍板——
          旧 div 行布局退役,样式允许变更)。单号独立成格:勾选 checkbox
          在首格,拖选复制单号不会误勾选。子树挂 tw-root 走新轨道。 */}
      <div className="tw-root">
        {display.length === 0
          ? (remote.loading
            ? <p className="issue-dts-hint">远程查单中…</p>
            : <p className="issue-dts-hint">没有匹配的问题单。</p>)
          : <Table aria-label="名下问题单">
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">
                  <div className="flex items-center gap-2">
                    <Checkbox aria-label="全选展示中的问题单"
                      checked={displayedTickets.length > 0
                        && allDisplayedSelected}
                      indeterminate={!allDisplayedSelected
                        && displayedSelectedCount > 0}
                      onCheckedChange={() => toggleSelectAll()} />
                    <span className="whitespace-nowrap text-xs font-normal
                      text-muted-foreground">
                      已选 {displayedSelectedCount} / {displayedTickets.length} 张
                    </span>
                  </div>
                </TableHead>
                <TableHead>单号</TableHead>
                <TableHead className="w-full">标题</TableHead>
                <TableHead>状态</TableHead>
                {moduleCol && <TableHead className="w-56">所属模块</TableHead>}
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {display.map((ticket) => {
                const isRemote = remote.tickets.some((item) =>
                  item.ticket === ticket.ticket);
                const isExpanded = expandedTicket === ticket.ticket;
                const detail = detailCache[ticket.ticket];
                const detailId =
                  `issue-dts-detail-${encodeURIComponent(ticket.ticket)}`;
                const colCount = moduleCol ? 6 : 5;
                return <Fragment key={ticket.ticket}>
                  <TableRow
                    data-state={selected.includes(ticket.ticket)
                      ? "selected" : undefined}>
                    <TableCell>
                      <Checkbox checked={selected.includes(ticket.ticket)}
                        aria-label={`选择 ${ticket.ticket}`}
                        onCheckedChange={(checked) => setSelected((current) =>
                          checked
                            ? [...current, ticket.ticket]
                            : current.filter((item) => item !== ticket.ticket))} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {/* 单号独立成格(勾选在首格):拖选复制单号不会误
                          勾选——单号是绑单/推送分支名的关键操作对象,
                          复制是高频动作。 */}
                      <span className="issue-dts-ticket font-mono text-sm
                        font-medium text-primary">
                        {ticket.ticket}
                      </span>
                      {isRemote && <Badge variant="outline" className="ml-1.5">
                        远程
                      </Badge>}
                    </TableCell>
                    <TableCell className="max-w-0">
                      <span className="block truncate"
                        title={ticket.title || undefined}>
                        {ticket.title || "(无标题)"}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {ticket.status
                        && <Badge variant="secondary">{ticket.status}</Badge>}
                    </TableCell>
                    {moduleCol && <TableCell>
                      <Select
                        value={bindings[ticket.ticket]?.module_id ?? "__none"}
                        disabled={bindingTicket === ticket.ticket}
                        items={[
                          { value: "__none", label: "未选择(AI 运行时识别)" },
                          ...moduleCatalog.map((module) => ({
                            value: module.id, label: module.name,
                          })),
                        ]}
                        onValueChange={(value) =>
                          void bindModule(ticket.ticket,
                            value === "__none" || value == null
                              ? "" : value)}>
                        <SelectTrigger
                          className="h-8 w-full text-xs"
                          aria-label={`${ticket.ticket} 所属业务模块`}
                          title="人工预绑这张单所属的业务模块;发起分析时直接带出,AI 不再识别">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="tw-root">
                          <SelectItem value="__none">
                            未选择(AI 运行时识别)
                          </SelectItem>
                          {moduleCatalog.map((module) => (
                            <SelectItem key={module.id} value={module.id}>
                              {module.name}
                            </SelectItem>))}
                        </SelectContent>
                      </Select>
                      {bindFail?.ticket === ticket.ticket
                        && <p className="mt-1 text-xs text-destructive" role="alert">
                          {bindFail.message}
                        </p>}
                    </TableCell>}
                    <TableCell className="text-right">
                      <button type="button"
                        aria-expanded={isExpanded}
                        aria-controls={detailId}
                        aria-label={`${isExpanded ? "收起" : "展开"} ${ticket.ticket} 详情`}
                        onClick={() => void toggleExpand(ticket.ticket)}
                        className="inline-flex size-9 items-center justify-center
                          rounded-sm text-muted-foreground transition-colors
                          hover:bg-accent hover:text-foreground">
                        <ChevronRight aria-hidden
                          className={`size-4 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                      </button>
                    </TableCell>
                  </TableRow>
                  {isExpanded && <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={colCount} className="bg-muted/30 p-0">
                      <div id={detailId} className="px-10 py-3">
                        {detailLoading
                          && <span className="text-xs text-muted-foreground">
                            加载详情…
                          </span>}
                        <dl className="grid grid-cols-[max-content_1fr]
                          items-baseline gap-x-4 gap-y-1 text-sm">
                          <dt className="text-muted-foreground">问题级别</dt>
                          <dd>{detail?.severity || ticket.severity || "—"}</dd>
                          <dt className="text-muted-foreground">问题版本</dt>
                          <dd className="font-mono text-xs">
                            {detail?.version || ticket.version || "—"}</dd>
                          <dt className="text-muted-foreground">问题链接</dt>
                          <dd>{(detail?.url || ticket.url)
                            ? <a className="text-primary underline underline-offset-2"
                                href={detail?.url || ticket.url}
                                target="_blank" rel="noreferrer">
                              {detail?.url || ticket.url}
                            </a>
                            : "—"}</dd>
                          <dt className="text-muted-foreground">提单人</dt>
                          <dd>{detail?.submitter || ticket.submitter || "—"}</dd>
                          <dt className="text-muted-foreground">问题描述</dt>
                          <dd className="issue-dts-detail-html"
                            dangerouslySetInnerHTML={{
                              __html: prepareDtsHtml(
                                detail?.description || ticket.description)
                                || "(暂无描述)",
                            }}
                          />
                        </dl>
                      </div>
                    </TableCell>
                  </TableRow>}
                </Fragment>;
              })}
            </TableBody>
          </Table>}
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
