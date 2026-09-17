import { ProductVersionPicker } from "../ProductVersionPicker";
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Check, ChevronRight, Columns3, Copy, RotateCw } from "lucide-react";
import {
  createIssue,
  getBusinessModules,
  getDtsModuleBindings,
  getDtsTicketDetail,
  listAllIssues,
  listCollaborationAssignees,
  listDtsTickets,
  listPeople,
  putDtsModuleBinding,
  uploadIssueImage,
  type AuthUser,
  type BusinessModule,
  type CollaborationAssignee,
  type DtsModuleBindingEntry,
  type DtsTicketBrief,
  type DtsTicketDetail,
  type EnvironmentView,
  type IssueSummary,
  type PersonIdentity,
} from "../api";
import { userLabel, UserPicker, type UserOption } from "../UserPicker";
import { EnvironmentPicker } from "../EnvironmentPicker";
import { HeaderFilter } from "../HeaderFilter";
import { DescriptionEditor } from "./DescriptionEditor";
import { RichTextEditor } from "./RichTextEditor";
import { USE_RICH_TEXT_DESCRIPTION_EDITOR } from "./descriptionEditorChoice";
import {
  ISSUE_DESCRIPTION_TEMPLATE, isUntouchedTemplate,
} from "./descriptionTemplate";
import { resolveAssignee } from "./assigneeDefault";
import { copyIssueDescription } from "./copyIssueDescription";
import { prepareDtsHtml } from "./dtsHtml";
import {
  DTS_ACTIONABLE_STATUS,
  dtsNoCandidates,
  dtsVersionGroup,
  dtsVersionKey,
  isActionableDts,
  sortDtsVersionsDesc,
} from "./dtsText";
import { dtsTicketUrl } from "./dtsTicket";
import { cn } from "cn";

/** #230 去 legacy:登记域皮肤类换工具类。字段行是全表单共用版式,先落
 * 成一处词典;窄屏单列由 max-[680px] 变体直译旧 @media(原 680px 块随
 * 家族退役)。 */
const FIELD = "grid gap-[5px] text-[13px] text-muted-foreground max-[680px]:col-span-1 max-[680px]:min-w-0";
const GROUP = "col-span-full grid gap-3 rounded-[10px] border border-line bg-surface p-3.5 max-[680px]:px-2.5 max-[680px]:py-3";
const GROUP_BODY = "grid grid-cols-2 gap-3 max-[680px]:grid-cols-1";

/** 发起前置门禁条(ADR-0031 起查**责任人**的凭据):这单会碰远端仓,
 *  克隆与推送都用责任人的身份——责任人没配齐就拦在表单上,服务端
 *  create 里机械拦(判定同源)。分两种说法:责任人=自己(自登记)
 *  指路个人设置,自己配完即解锁;责任人=他人(登记指派)点名责任人,
 *  登记人改选已配齐的责任人或让责任人先配好。 */
function CredentialGate({ viewer, needRepo, assignee, readyKnown, ready,
  missing, onNavigateProfile }: {
  viewer: AuthUser;
  needRepo: boolean;
  /** 当前生效的责任人(空=未指派,不出这个门)。 */
  assignee: string;
  /** 就绪状态是否已知:候选没加载完/拉取失败/所选人不在候选里,都是
   * 未知——未知不出这个门(不谎报"未配齐"),服务端门禁兜底。 */
  readyKnown: boolean;
  /** 责任人凭据是否配齐(仅在已知时有意义)。 */
  ready: boolean;
  missing: string[];
  onNavigateProfile?: () => void;
}) {
  if (!needRepo || !assignee || !readyKnown || ready) return null;
  const self = assignee === viewer.username;
  // 走到这 ready=false ⟺ missing 非空(flow=issue 口径),detail 必有内容。
  const missingText = missing.join(" 与 ");
  return <div className="col-span-full mb-2.5 flex flex-wrap items-center justify-between gap-2.5 rounded-[10px] border border-attention/45 bg-[color-mix(in_srgb,var(--attention)_10%,var(--surface))] px-3.5 py-2.5 text-[13px] leading-normal text-attention" role="alert">
    {self
      ? <span>发起前先配置<b className="text-attention">{missingText}</b>(个人设置 → 个人接入):
          拉取代码仓与推送提交都用你的身份,配置完成即可发起。</span>
      : <span>责任人 <b className="text-attention">{assignee}</b>(缺 {missingText})的 Git 凭据未配齐——拉取代码仓与推送提交都用责任人的身份:
          改选已配齐的责任人,或让责任人配好后再登记。</span>}
    {self && onNavigateProfile && <Button type="button" size="sm" onClick={onNavigateProfile}>
      去个人设置配置
    </Button>}
  </div>;
}


/** 只读仓清单行的短名:剥协议取末段再去 .git(file:// 演示仓同样适用);
 * 全 URL 挂 title,悬停可见。 */
function repoLabel(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/)
    .filter(Boolean).pop() ?? url;
  return last.replace(/\.git$/i, "") || url;
}

/** 描述一键复制(登记侧出站口):写剪贴板双格式(纯文本 markdown 原文
 * + 渲染 HTML,截图内联 data URL)——富文本框直贴得排版与截图,纯文本
 * 框得原文。状态自持:成功/失败各 2 秒回落,失败可直接重试。 */
function CopyDescriptionButton({ markdown, disabled, variant, size, className }: {
  markdown: string;
  disabled?: boolean;
  variant: "ghost" | "outline";
  size: "xs" | "sm";
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  useEffect(() => {
    if (state !== "done" && state !== "error") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  async function copy() {
    setState("busy");
    try {
      await copyIssueDescription(markdown);
      setState("done");
    } catch {
      setState("error");
    }
  }
  return <Button type="button" variant={variant} size={size}
    className={className}
    disabled={disabled || state === "busy"}
    title="复制描述:贴进飞书/Word 等富文本框保留排版与截图,贴进纯文本框是 Markdown 原文"
    onClick={() => void copy()}>
    {state === "done" ? <Check aria-hidden /> : <Copy aria-hidden />}
    {state === "busy" ? "复制中…" : state === "done" ? "已复制"
      : state === "error" ? "复制失败" : "复制"}
  </Button>;
}

/** 名下进行中会话按单查重的唯一口径(「已发起」词条,CONTEXT.md):
 * 同单号且会话未到终态(归档/取消/失败)。发起前查重与列表的发起
 * 状态列/勾选禁用/默认过滤全走这一处——列上说"已发起"当且仅当此刻
 * 点发起会被拦;只有终态旧会话的单不算,可再次发起(与服务端 create
 * 守卫同尺)。终态三元组只住 isLiveIssue 一处。 */
function isLiveIssue(item: IssueSummary): boolean {
  return !["archived", "canceled", "failed"].includes(item.status);
}

function liveIssueFor(issues: IssueSummary[], ticketNo: string):
  IssueSummary | undefined {
  return issues.find((item) => item.ticket === ticketNo && isLiveIssue(item));
}

/** 进行中会话按单索引:徽标/过滤/拦截共吃一份,免得各自全表扫。 */
function liveIssuesByTicket(rows: IssueSummary[]):
  Map<string, IssueSummary> {
  const map = new Map<string, IssueSummary>();
  rows.forEach((item) => {
    if (item.ticket && isLiveIssue(item) && !map.has(item.ticket)) {
      map.set(item.ticket, item);
    }
  });
  return map;
}

export function IssueRegistration({
  viewer,
  issues,
  onCreated,
  onError,
  onNavigateProfile,
  onOpenIssue,
  panel,
  visible = true,
}: {
  viewer: AuthUser;
  /** 我的会话列表:DTS 批量发起的前端查重用(服务端同样机械拦);
   * 2026-09-14 起也是发起状态列/默认过滤的判定数据(liveIssueFor)。 */
  issues: IssueSummary[];
  onCreated: (issue: IssueSummary) => void;
  onError: (message: string) => void;
  onNavigateProfile?: () => void;
  /** 点「进行中」徽标跳进该单名下的进行中会话(IssueBoard 的 openIssue)。 */
  onOpenIssue?: (issueId: string) => void;
  /** 面板受控态(必传):当前面板由导航子页签决定——「问题登记/DTS列表」
   * 两个子页签各接管一个面板,内部不再自持页签按钮。 */
  panel: "dts" | "manual";
  /** 整域显隐(默认可见):导航切到「问题会话」时隐藏但**不卸载**——
   * 表单、勾选与搜索状态跨子页签驻留。 */
  visible?: boolean;
}) {
  // 两个子面板常驻(隐藏切换):DTS 列表、勾选与表单状态跨页签驻留,
  // 首开「DTS 列表」自动拉取一次,之后靠「刷新」手动更新。
  // (#230:.issue-section 卡壳换工具类;IssueBoard 侧同名壳不动。)
  return <section className="rounded-[14px] border border-line bg-surface px-[18px] py-4 max-[680px]:px-3 max-[680px]:py-[13px]" aria-label="发起问题会话"
    hidden={!visible}>
    <div hidden={panel !== "manual"}>
      <ManualRegister viewer={viewer} onCreated={onCreated} onError={onError}
        onNavigateProfile={onNavigateProfile} />
    </div>
    <div hidden={panel !== "dts"}>
      <DtsRegister viewer={viewer} issues={issues} active={panel === "dts"}
        onCreated={onCreated} onError={onError} onOpenIssue={onOpenIssue} />
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
  // 描述预填标准提单模板(#273):打开即照着填,格式合规靠阻力最小
  // 路径(ADR-0030);不想用模板整段删掉自由书写,必填校验照旧。
  const [description, setDescription] = useState(ISSUE_DESCRIPTION_TEMPLATE);
  // 业务模块必选(spec #15):仓的唯一来源是模块绑定——手填仓、自由
  // 文本模块与 DTS 单号一并废除,无单场景只有一个入口:选模块。
  const [productVersion, setProductVersion] = useState("");
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
  // 责任人(ADR-0031):登记完成即移交——displayed 值由 resolveAssignee
  // 裁决:未选模块置空,选了模块且未手选自动填模块责任人(换模块跟随),
  // 手选即冻结。候选=全部普通用户(flow=issue 口径,管理员天然不在),
  // 模块责任人与维护者置顶带标记;登记人自己不用配 Git 凭据。
  const [assigneeManual, setAssigneeManual] = useState("");
  const [candidates, setCandidates] = useState<CollaborationAssignee[] | undefined>();
  const [busy, setBusy] = useState(false);
  const draftKey = `mae-flow:issue:draft:${viewer.username}`;
  // 下拉只收 active 且至少绑一个仓的模块:零仓存量模块发起必被服务端
  // 打回,不进下拉让它根本没有被选中的机会(spec #15)。
  const moduleCatalog = useMemo(() => (modules ?? []).filter((module) =>
    module.status === "active" && module.repositories.length > 0), [modules]);
  const selectedModule = moduleCatalog.find((module) => module.id === moduleId);
  // 指派候选(flow=issue 固定口径:只认 Git 令牌+邮箱,不问小鲁班
  // 令牌)。拉取失败置空表——必填校验拦住提交,服务端门禁兜底。
  useEffect(() => {
    let alive = true;
    listCollaborationAssignees("issue")
      .then((rows) => { if (alive) setCandidates(rows); })
      .catch(() => { if (alive) setCandidates([]); });
    return () => { alive = false; };
  }, []);
  const candidateRows = candidates ?? [];
  const candidateByUsername = useMemo(
    () => new Map(candidateRows.map((row) => [row.username, row])),
    [candidateRows]);
  const selectedOwner = selectedModule?.owner;
  const assignee = resolveAssignee({
    manualPick: assigneeManual,
    moduleOwner: selectedOwner,
    ownerAssignable: Boolean(selectedOwner
      && candidateByUsername.has(selectedOwner)),
  });
  // 模块责任人与维护者置顶带标记:模块相关的人一眼可见(不在候选的
  // 管理员/停用账号跳过——候选接口本就不给)。
  const assigneeOptions = useMemo<UserOption[]>(() => {
    const pinned: UserOption[] = [];
    const picked = new Set<string>();
    for (const name of [selectedOwner, ...(selectedModule?.maintainers ?? [])]) {
      if (!name || picked.has(name)) continue;
      const row = candidateByUsername.get(name);
      if (!row) continue;
      picked.add(name);
      pinned.push({
        username: row.username,
        ...(row.display_name ? { display_name: row.display_name } : {}),
        detail: (name === selectedOwner ? "模块责任人" : "模块维护者")
          + (row.ready ? "" : "(未配 Git 凭据)"),
      });
    }
    return [...pinned, ...candidateRows
      .filter((row) => !picked.has(row.username))
      .map((row) => ({
        username: row.username,
        ...(row.display_name ? { display_name: row.display_name } : {}),
        ...(row.ready ? {} : { detail: "未配 Git 凭据" }),
      }))];
  }, [candidateRows, candidateByUsername, selectedOwner, selectedModule]);
  // 就绪三态:候选在册才谈配没配齐——候选没加载完/拉取失败/所选人
  // 不在册(管理员、目录失败)都是未知,门与提交拦截不出场,服务端
  // 门禁兜底,不谎报「未配齐」。
  const assigneeReadyKnown = Boolean(assignee && candidateByUsername.has(assignee));
  const assigneeReady = candidateByUsername.get(assignee)?.ready === true;
  /** 候选在册则「姓名(工号)」,不在册只显工号。 */
  const candidateLabel = (username: string): string => {
    const row = candidateByUsername.get(username);
    return userLabel({ username,
      ...(row?.display_name ? { display_name: row.display_name } : {}) });
  };
  useEffect(() => {
    let alive = true;
    setModules(undefined);
    setModuleLoadError("");
    // 加载失败和空目录是两种事实:前者给重试,后者指路配置中心。两种
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
        // 清空过的草稿(存的是空串)回读时不回灌空串——描述框只以
        // 模板或用户内容呈现,不出现空框(#273)。
        setDescription(saved.description || ISSUE_DESCRIPTION_TEMPLATE);
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

  // 现象描述内嵌截图(#184 票2):粘贴/拖拽由所见即所得编辑器接管——
  // 上传钩子落 staging 后返回相对引用,编辑器在光标位置插入并原地渲染。
  // 图片本体不进 description,进的只有 issue-images/ 相对引用(与
  // ticketImages 同款架构红线)。
  async function uploadIssueFile(file: File): Promise<string> {
    try {
      const result = await uploadIssueImage(file);
      return result.path;
    } catch (reason) {
      const message = `图片上传失败:${
        String(reason instanceof Error ? reason.message : reason)}`;
      onError(message);
      throw reason;
    }
  }

  // 个人凭据前置门禁(ADR-0031 起查责任人):模块带出的仓一般是
  // https 远端,克隆与推送都用责任人的身份——按模块绑定判断 needRepo;
  // 全本地仓(file:// 演示库)不拦。服务端 create 里机械拦(判定同源),
  // 这里把拦截面提前到表单。
  const touchRemoteRepo = (selectedModule?.repositories ?? [])
    .some((url) => /^https?:\/\//i.test(url));
  const credentialBlocked = Boolean(assignee) && touchRemoteRepo
    && assigneeReadyKnown && !assigneeReady;

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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || submitDisabled) return;
    if (!title.trim()) {
      onError("问题标题必填——一句话说清现象");
      return;
    }
    if (!description.trim()) {
      onError("问题描述必填——发生条件、影响范围、复现步骤,写得越具体 AI 少走弯路");
      return;
    }
    // 模板原样拦截(#273):预填后描述永不为空,空模板会绕过必填校验、
    // 登记后白跑一轮首轮会话;字段缺内容不灰按钮的口径同样适用——提交
    // 时给指路文案,不靠灰化猜。
    if (isUntouchedTemplate(description)) {
      onError("描述还是模板原样——把发生时间、触发步骤、实际现象填一填再发起;不想用模板就整段删掉自己写");
      return;
    }
    if (!pickedEnv) {
      onError("请从环境管理选择网管环境——搜不到就点下拉里的「新增环境」录一条");
      return;
    }
    if (!assignee) {
      onError("请选择责任人——登记完成后由责任人推进;选了业务模块会自动带上模块责任人");
      return;
    }
    if (touchRemoteRepo && assigneeReadyKnown && !assigneeReady) {
      onError(`责任人 ${candidateLabel(assignee)}` +
        " 的 Git 凭据未配齐——改选已配齐的责任人,或让责任人配好后再登记");
      return;
    }
    setBusy(true);
    try {
      const created = await createIssue({
        title: title.trim(),
        description: description.trim(),
        module_id: moduleId,
        product_version: productVersion || undefined,
        // 快选(#150):只带台账条目 id,值由服务端解密快照(前端零密码)。
        environment: { environment_id: pickedEnv.id },
        // 责任人(ADR-0031):登记完成即移交,归属与推进人。
        assignee,
      });
      // 重置回模板而非空串(#273):下一条登记仍从标准格式起步,两套
      // 空态不并存。
      setTitle(""); setDescription(ISSUE_DESCRIPTION_TEMPLATE); setModuleId("");
      setAssigneeManual("");
      clearPickedEnv();
      onCreated(created);
    } catch (reason) {
      onError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(false);
    }
  }

  return <form className="grid grid-cols-2 gap-3 max-[680px]:grid-cols-1" onSubmit={submit}>
    {/* 资源屏蔽提示跨全列(2026-09-14 设计审查 04):组件保持布局中性,
        落位由本域网格决定——不再首行右半空格。 */}
    <div className="col-span-full">
      <RepositoryResourceNotice repositories={selectedModule?.repositories ?? []} />
    </div>
    <div className={GROUP}>
      <span className="text-[13px] font-bold leading-tight text-primary">问题信息</span>
      <div className={GROUP_BODY}>
        <label className={cn(FIELD, "col-span-full")}>
          <span>问题标题 <i className="font-bold not-italic text-danger">*</i></span>
          <Input value={title} placeholder="一句话说清现象,如:播放器偶发黑屏"
            onChange={(event) => setTitle(event.target.value)} />
        </label>
        {/* 描述字段不用 label 包裹:label 的激活转发会把点进编辑区
            的动作转给区内第一个可激活元素,行为不可控(2026-09-11
            用户实测)。 */}
        <div className={cn(FIELD, "col-span-full")}>
          <span>问题描述 <i className="font-bold not-italic text-danger">*</i></span>
          {/* 选型在 descriptionEditorChoice:两壳同一 markdown 契约,
              翻转常量重新构建即回退,存储零迁移(#271)。 */}
          {USE_RICH_TEXT_DESCRIPTION_EDITOR
            ? <RichTextEditor value={description} onChange={setDescription}
              onUploadImage={uploadIssueFile} onError={onError}
              placeholderText="不想用模板就整段删掉,从这里自由书写;粘贴或拖拽截图自动上传并原地显示" />
            : <DescriptionEditor value={description} onChange={setDescription}
              onUploadImage={uploadIssueFile} onError={onError}
              placeholderText="不想用模板就整段删掉,从这里自由书写;粘贴或拖拽截图自动上传并原地显示" />}
          {/* 上传进行态指示住编辑器内右上角(DescriptionEditor 自持),
              页脚不再重复一份。 */}
          <div className="issue-desc-foot flex min-h-6 items-center justify-end gap-2.5">
            {/* 一键复制:描述写完想带走(贴工单/飞书)都不用手选全选;
                空描述不可点。 */}
            <CopyDescriptionButton markdown={description}
              disabled={!description.trim()} variant="ghost" size="xs" />
          </div>
        </div>
        {/* 仓不占版面(拍板 2026-08-31):选中模块即带出绑定仓,清单
            收进悬停提示——悬停选择器或提示行就能看到将拉取哪些仓;
            要增删仓去「配置中心 → 模块与代码仓」维护绑定,登记页不改。 */}
        <ProductVersionPicker value={productVersion}
          onChange={version => setProductVersion(version)} />
        <label className={cn(FIELD, "col-span-full")}>
          <span>业务模块 <i className="font-bold not-italic text-danger">*</i></span>
          <span className="issue-module-wrap group/mod relative grid gap-1.5">
            <Select value={moduleId}
              disabled={modules === undefined || !!moduleLoadError}
              items={[{ value: "", label: "选择业务模块——决定关联代码仓" },
                ...moduleCatalog.map((module) => ({
                  value: module.id,
                  label: `${module.name}(绑 ${module.repositories.length} 个仓)`,
                }))]}
              onValueChange={(value) => setModuleId(value ?? "")}>
              <SelectTrigger className="w-full" aria-label="业务模块">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="tw-root">
                <SelectGroup>
                  <SelectItem value="" disabled>选择业务模块——决定关联代码仓</SelectItem>
                  {moduleCatalog.map((module) => (
                    <SelectItem key={module.id} value={module.id}>
                      {module.name}(绑 {module.repositories.length} 个仓)
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {selectedModule && <>
              <small className="cursor-help text-muted-foreground">
                已带出 {selectedModule.repositories.length} 个代码仓,悬停查看
              </small>
              {/* 悬浮卡(#230 换工具类):悬停/键盘聚焦经 group 变体弹出,
                  键盘可达性不变;短名一行放下,全地址挂 title 悬停可见。 */}
              <span className="issue-module-tip absolute left-0 top-[calc(100%+6px)] z-40 hidden min-w-[min(440px,100%)] gap-2 rounded-[10px] border border-line bg-surface p-3 shadow-(--shadow-md) group-hover/mod:grid group-focus-within/mod:grid" role="tooltip">
                <b className="text-text-strong">将拉取 {selectedModule.repositories.length} 个代码仓</b>
                <ul className="m-0 grid list-none gap-1.5 p-0">
                  {selectedModule.repositories.map((url) => (
                    <li className="truncate rounded-lg border border-line bg-surface-muted px-2.5 py-1.5 font-mono text-xs text-text-strong" key={url} title={url}>{repoLabel(url)}</li>
                  ))}
                </ul>
              </span>
            </>}
          </span>
          {moduleLoadError && <small className="col-span-full flex items-center justify-between gap-2.5 rounded-lg border border-destructive/35 px-2.5 py-2 text-destructive max-[680px]:flex-col max-[680px]:items-stretch" role="alert">
            <span>业务模块加载失败:{moduleLoadError}</span>
            <Button type="button" variant="outline" size="sm" className="border-current text-inherit"
              onClick={() => setModuleLoadAttempt((value) => value + 1)}>
              重试加载
            </Button>
          </small>}
          {catalogEmpty && <small className="col-span-full" role="alert">
            模块目录为空——先到「配置中心 → 模块与代码仓」登记并绑定代码仓,再回来登记。
          </small>}
        </label>
        {/* 责任人(ADR-0031):登记完成即移交——模块责任人+维护者置顶
            带标记,选模块自动带上,手选即冻结。不用 label 包裹:label
            的激活转发会把点开选人框的动作转给区内首个可激活元素
            (同描述字段的走查结论)。 */}
        <div className={cn(FIELD, "col-span-full")}>
          <span>责任人 <i className="font-bold not-italic text-danger">*</i></span>
          <UserPicker value={assignee} options={assigneeOptions}
            onChange={setAssigneeManual} ariaLabel="责任人"
            emptyLabel="选择责任人——登记完成后由其推进" />
          {selectedModule?.owner && <small className="text-xs leading-normal text-faint">
            模块「{selectedModule.name}」的责任人是 {candidateLabel(selectedModule.owner)},
            未手选时自动带上
          </small>}
        </div>
      </div>
    </div>
    <div className={GROUP}>
      <span className="text-[13px] font-bold leading-tight text-primary">网管环境</span>
      <div className={GROUP_BODY}>
        {/* 从环境管理选(#150,ADR-0020;2026-09-10 走查裁定「只选不
            手填」):可搜索下拉挑台账条目,搜不到点「新增环境」弹共用
            表单、录完自动选中;后台密码用台账已存值(前端拿不到)。 */}
        <div className="col-span-full">
          <EnvironmentPicker
            selectedId={pickedEnv?.id ?? null} onPick={pickEnv} />
        </div>
        {pickedEnv && <small className="col-span-full m-0 text-xs leading-normal text-faint max-[680px]:min-w-0" role="status">
          将使用「环境管理」里 <span className="font-mono">{pickedEnv.ip}</span> 的已存密码
          (以选定时为准),无需在此填写。密码不会出现在页面或事件流,
          但会在执行问题处理时明文进入当前 AI 上下文。
        </small>}

      </div>
    </div>
    <CredentialGate viewer={viewer} needRepo={touchRemoteRepo}
      assignee={assignee} readyKnown={assigneeReadyKnown} ready={assigneeReady}
      missing={assignee ? candidateByUsername.get(assignee)?.missing ?? [] : []}
      onNavigateProfile={onNavigateProfile} />
    <div className="col-span-full flex items-center gap-3.5 max-[680px]:flex-col max-[680px]:items-stretch">
      <Button type="submit" disabled={submitDisabled} className="max-[680px]:min-h-11 max-[680px]:w-full">
        {busy ? "登记中…" : "登记问题"}
      </Button>
    </div>
  </form>;
}

function DtsRegister({
  viewer,
  issues,
  active,
  onCreated,
  onError,
  onOpenIssue,
}: {
  viewer: AuthUser;
  /** 我的会话列表:发起前按单查重(服务端 create 同样机械拦);
   * 发起状态列/默认过滤同尺共用(liveIssueFor)。 */
  issues: IssueSummary[];
  /** 页签是否激活:首次激活自动拉取一次名下问题单,之后手动刷新。 */
  active: boolean;
  onCreated: (issue: IssueSummary) => void;
  onError: (message: string) => void;
  onOpenIssue?: (issueId: string) => void;
}) {
  const [productVersion, setProductVersion] = useState("");
  const [tickets, setTickets] = useState<DtsTicketBrief[] | undefined>();
  // 协助处理(2026-09-17):名下视角可切换——默认看自己,选人后看别人
  // 名下的单(工具栏人员选择框)。换的是读侧视角,不发所有权:发起后
  // 的会话归属仍是登录人(分支名 master_{发起人}_{单号} 各归各,与对方
  // 已发起的会话互不打架),接管对方单子就从这里发起。
  const [owner, setOwner] = useState(viewer.username);
  const assistMode = owner !== viewer.username;
  // 人员候选来自 /auth/people(全员只读身份字段);没加载到就只有自己
  // 可选(选择框退化为摆设但不挡用)。
  const [people, setPeople] = useState<PersonIdentity[]>();
  // 协助视角的「发起状态」要认全团队会话:自己的会话列表只含归属或
  // 登记人是自己的,对方发起过的单在里面对不上号。?scope=all 读侧
  // 全员开放;回到自己名下即弃,不多占一份状态。
  const [teamIssues, setTeamIssues] = useState<IssueSummary[]>();
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

  // 模糊搜索:单号/标题/版本,大小写不敏感;列头过滤叠加其上。
  const [query, setQuery] = useState("");
  const [selectedVersions, setSelectedVersions] = useState<string[]>([]);
  // 列头包含式过滤(2026-09-13 表头化,单号/标题两枚漏斗;与工具栏
  // 搜索 AND 叠加,只作用于名下列表——远程补查单豁免)。版本过滤的
  // 入口同批迁进「版本」列表头漏斗,行为等价迁移。
  const [ticketFilter, setTicketFilter] = useState("");
  const [titleFilter, setTitleFilter] = useState("");
  // 发起过滤(2026-09-14 拍板):「发起状态」列表头漏斗,默认只看未
  // 发起的单——已发起(名下有进行中会话)的行默认滤掉且勾选禁用。
  // 两项全勾 = 全显 = 无过滤;打开/刷新回默认态,漏斗清空是全显。
  const [showUnlaunched, setShowUnlaunched] = useState(true);
  const [showLaunched, setShowLaunched] = useState(false);
  const launchFilterActive = !showUnlaunched || !showLaunched;
  // 进行中会话按单索引,两本名册各管一摊(口径都是 isLiveIssue 一处):
  // - 我的名册(issues):发起拦截与勾选禁用的唯一依据——同账号+同单号
  //   至多一个进行中(服务端 create 同尺兜底);
  // - 协助视角的名册(teamIssues):只喂徽标与发起过滤,不拦发起——
  //   对方已开了头正是接管的常见时机,分支按发起人隔离不冲突。
  const mineLiveByTicket = useMemo(() => liveIssuesByTicket(issues), [issues]);
  const teamLiveByTicket = useMemo(
    () => liveIssuesByTicket(teamIssues ?? []), [teamIssues]);
  // 徽标与发起过滤看展示口径:自己名下=我的会话;协助视角=全团队。
  const shownLiveByTicket = assistMode ? teamLiveByTicket : mineLiveByTicket;
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

  // 列头过滤谓词(单号/标题):包含匹配,大小写不敏感;与工具栏搜索
  // AND 叠加。只作用于名下列表,远程补查单不经这道筛。
  const columnFiltered = useMemo(() => {
    if (!fuzzyMatches) return undefined;
    const byTicket = ticketFilter.trim().toLowerCase();
    const byTitle = titleFilter.trim().toLowerCase();
    if (!byTicket && !byTitle) return fuzzyMatches;
    return fuzzyMatches.filter((t) =>
      (!byTicket || t.ticket.toLowerCase().includes(byTicket))
      && (!byTitle || t.title.toLowerCase().includes(byTitle)));
  }, [fuzzyMatches, ticketFilter, titleFilter]);

  const versionFiltered = useMemo(() => {
    const list = columnFiltered;
    if (!list) return undefined;
    if (selectedVersions.length === 0) return list;
    // 命中口径与汇总同尺:单据版本剥掉 B 段后落在勾选的组里即命中
    // (组内所有 B 版构建号一并带出)。
    return list.filter((t) => t.version
      && selectedVersions.includes(dtsVersionGroup(t.version)));
  }, [columnFiltered, selectedVersions]);

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

  // 列表 = 本地命中(版本过滤后) + 远程补查命中(去重),再过发起
  // 过滤(名下与远程补查单同尺适用)。清空搜索框时远程结果随 effect
  // 复位消失,恢复展示名下全部问题单。远程命中的单也只展示可发起状态;
  // 被状态挡下的汇总一条提示,不让用户以为单号不存在。
  const remoteTickets = remote.tickets;
  const hiddenRemote = remoteTickets.filter((t) => !isActionableDts(t));
  const display = useMemo(() => {
    const list = versionFiltered ?? [];
    const extra = remoteTickets.filter((r) =>
      isActionableDts(r) && !list.some((item) => item.ticket === r.ticket));
    const merged = [...list, ...extra];
    if (!launchFilterActive) return merged;
    return merged.filter((t) => shownLiveByTicket.has(t.ticket)
      ? showLaunched : showUnlaunched);
  }, [versionFiltered, remoteTickets, launchFilterActive, showUnlaunched,
    showLaunched, shownLiveByTicket]);

  // 全选表头(三态):只作用于当前展示列表中**可勾**的行——搜索+版本
  // 过滤划范围,发起过滤里已发起的行勾选禁用,不在全选之列。可勾行全
  // 中时点击整体取消,部分或全无时一键勾满。已勾选但被过滤掉的单不在
  // 展示列表里,保持原样,发起时照常带上。
  const selectableTickets = display
    .filter((t) => !mineLiveByTicket.has(t.ticket))
    .map((t) => t.ticket);
  const displayedSelectedCount =
    selectableTickets.filter((no) => selected.includes(no)).length;
  const allDisplayedSelected = selectableTickets.length > 0
    && displayedSelectedCount === selectableTickets.length;
  function toggleSelectAll() {
    if (allDisplayedSelected) {
      const shown = new Set(selectableTickets);
      setSelected((current) => current.filter((no) => !shown.has(no)));
    } else {
      setSelected((current) =>
        [...new Set([...current, ...selectableTickets])]);
    }
  }

  // 展开详情:同一张单只拉一次(缓存),失败不影响列表已有字段展示。
  const [expandedTicket, setExpandedTicket] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, DtsTicketDetail>>({});
  const [detailLoading, setDetailLoading] = useState(false);

  async function load(target?: string) {
    // 换人发起的重拉带着新名下进同一函数:target 在场以它为准,绕开
    // setState 后旧闭包读不到新值的时序。
    const account = target ?? owner;
    setLoading(true);
    setNote("");
    setQuery("");
    setSelected([]);
    setSelectedVersions([]);
    setTicketFilter("");
    setTitleFilter("");
    setShowUnlaunched(true);
    setShowLaunched(false);
    setExpandedTicket(null);
    try {
      const result = await listDtsTickets(account);
      setTickets(result.tickets);
      setDtsMock(result.mock);
    } catch (reason) {
      setTickets(undefined);
      setNote(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setLoading(false);
    }
    // 协助视角另拉全团队会话判「已发起」;自己名下用父层列表,不多拉。
    if (account !== viewer.username) {
      void listAllIssues().then(setTeamIssues)
        .catch(() => setTeamIssues([]));
    } else {
      setTeamIssues(undefined);
    }
  }

  /** 换视角:清空现场(勾选/搜索/过滤都在 load 里重置)再拉新名下。 */
  function pickOwner(next: string) {
    if (next === owner) return;
    setOwner(next);
    void load(next);
  }

  // 人员候选:全员名单没到就只剩自己可选(选择框退化为摆设不挡用)。
  const ownerOptions: UserOption[] = useMemo(() => {
    const rows = people ?? [{
      username: viewer.username,
      ...(viewer.display_name ? { display_name: viewer.display_name } : {}),
    }];
    return rows.map(({ username, display_name }) =>
      ({ username, display_name }));
  }, [people, viewer.username, viewer.display_name]);
  const ownerLabel = userLabel(ownerOptions.find((option) =>
    option.username === owner) ?? { username: owner });

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
    void listPeople().then(setPeople).catch(() => setPeople(undefined));
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
        // 查重与发起状态列同尺(liveIssueFor 一处口径):列上没标
        // 「进行中」的单,走到这里也不会被这条拦下。
        const clash = liveIssueFor(issues, ticketNo);
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
            product_version: productVersion || undefined,
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

  /** 发起钮文案与说明一处定义,顶部工具栏单点消费。浮动发起条(2026-09-14
   * 设计审查 03)与顶部钮双入口被判冗余,2026-09-15 退役:发起只留顶部
   * 一枚,未勾选时置灰但常驻——可发现性靠它常在,不靠浮现。 */
  const launchTitle = selected.length > 1
    ? `将逐张发起 ${selected.length} 个独立工作流` : undefined;
  const launchLabel = busy ? "发起中…"
    : selected.length > 1 ? `发起处理(${selected.length} 张)` : "发起处理";

  return <div className="tw-root flex flex-col gap-3 text-base text-foreground">
    {dtsMock && <p className="rounded-md border border-attention/40 bg-attention-soft px-3 py-2 text-sm text-ink" role="note">
      DEV 模拟 DTS:外部开发模式,单据为本地模拟数据(--dts-mock),
      不是真实问题单;流程与真实模式完全一致。
    </p>}
    <div className="max-w-md">
      <ProductVersionPicker value={productVersion} onChange={version => setProductVersion(version)} />
      <p className="mt-1 text-sm text-muted-foreground">批量发起可统一选择版本；未选择时，按单据版本精确匹配配置中心，未匹配则沿用问题流程原有基线处理。</p>
    </div>
    {/* 工具栏:搜索居左,刷新/主操作居右;筛选住各列表头的漏斗
        (2026-09-13 表头化,与环境管理台账同范式,旧「版本过滤」
        按钮随迁移退役)。 */}
    <div className="flex flex-wrap items-center gap-2">
      {/* 名下视角切换(2026-09-17 协助处理):默认自己,选人看别人名下
          的单;几十人直接搜索(UserPicker 同款 combobox)。发起后的
          会话仍归属自己,提示条在工具栏下说清。 */}
      <div className="w-44">
        <UserPicker value={owner} options={ownerOptions} ariaLabel="查看谁名下的问题单"
          onChange={pickOwner} placeholder="搜索姓名或工号" />
      </div>
      <Input type="search" className="h-9 w-full sm:w-80" value={query}
        aria-label="搜索问题单"
        placeholder="搜索单号、标题、版本;输入完整单号可远程查单"
        onChange={(e) => setQuery(e.target.value)} />
      {/* 列显示/隐藏(shadcn 惯用法):表格原语本身不带列开关,这里按
          Data Table 的列选择器形态用 Popover+Checkbox 承载,暂只有
          「所属模块」一列可选,后续加列在这里长。localStorage 按用户
          记忆(键沿用旧开关的,老用户偏好不丢)。 */}
      <Popover>
        <PopoverTrigger render={<Button type="button" variant="ghost" size="sm"
          aria-label="列设置"
          title="显示或隐藏「所属模块」列">
          <Columns3 aria-hidden className="size-3.5" />列
        </Button>} />
        <PopoverContent align="start" className="w-48 p-1">
          <label className="flex min-h-9 cursor-pointer items-center
            justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
            所属模块
            <Checkbox checked={moduleCol} onCheckedChange={(checked) => {
              setModuleCol(checked);
              try {
                localStorage.setItem(moduleColKey, checked ? "shown" : "hidden");
              } catch { /* 旁路:存不下就本次会话内有效 */ }
            }} />
          </label>
        </PopoverContent>
      </Popover>
      {remote.loading
        ? <span className="text-xs text-muted-foreground" role="status">远程查单中…</span>
        : (query || ticketFilter.trim() || titleFilter.trim()
          || selectedVersions.length > 0 || launchFilterActive) && <span
            className="text-xs text-muted-foreground">
          {display.length} / {actionable?.length ?? 0} 条
        </span>}
      <div className="grow" />
      {note && <span className="text-xs text-muted-foreground" role="status">{note}</span>}
      <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}
        title={`重新拉取 ${ownerLabel} 名下问题单(勾选与搜索会重置)`}>
        <RotateCw aria-hidden className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        {loading ? (tickets === undefined ? "拉取中…" : "刷新中…") : "刷新"}
      </Button>
      <Button size="sm" disabled={!selected.length || busy}
        title={launchTitle} onClick={launch}>
        {launchLabel}
      </Button>
    </div>
    {assistMode && <p className="rounded-md border border-line bg-muted/40
      px-3 py-2 text-xs leading-normal text-muted-foreground" role="note">
      正在查看 <b className="font-medium text-foreground">{ownerLabel}</b>
      名下的单子。发起处理的会话归属你自己名下推进(分支按发起人隔离,
      不动对方已发起的会话);别人发起过的单标「进行中」,点开是查看模式。
    </p>}
    {tickets === undefined && loading && <p className="text-sm text-muted-foreground">
      正在拉取 {ownerLabel} 名下的问题单…
    </p>}
    {hiddenRemote.length > 0 && <p className="rounded-md border border-line
      bg-muted/40 px-3 py-2 text-xs text-muted-foreground" role="note">
      {hiddenRemote.map((t) => t.ticket).join("、")} 存在,但状态不是
      「{DTS_ACTIONABLE_STATUS}」,不在可拉取范围。
    </p>}
    {tickets && tickets.length > 0 && <>
      {/* 列表体:shadcn Table(2026-09-11 迁移,spec #171 评审后拍板——
          旧 div 行布局退役,样式允许变更)。单号独立成格:勾选 checkbox
          在首格,拖选复制单号不会误勾选。子树挂 tw-root 走新轨道。 */}
      {display.length === 0
        ? (remote.loading
          ? <p className="text-sm text-muted-foreground" role="status">远程查单中…</p>
          : <div className="flex flex-col items-center gap-2 rounded-lg border
              border-dashed border-line px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">没有匹配的问题单。</p>
            {/* 清空 = 全显(发起过滤两项全勾),与版本过滤现行行为一致
                ——回到默认态(只看未发起)只发生在打开/刷新。 */}
            <Button variant="outline" size="sm"
              onClick={() => {
                setQuery("");
                setTicketFilter("");
                setTitleFilter("");
                setSelectedVersions([]);
                setShowUnlaunched(true);
                setShowLaunched(true);
              }}>
              清空搜索与筛选</Button>
          </div>)
        : <div className="overflow-x-auto rounded-lg border border-line">
          {/* 列表体:shadcn Table(2026-09-11 迁移,spec #171 评审后拍板——
              旧 div 行布局退役,样式允许变更)。单号独立成格:勾选 checkbox
              在首格,拖选复制单号不会误勾选。子树挂 tw-root 走新轨道。 */}
          <Table aria-label="名下问题单">
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">
                  <div className="flex items-center gap-2">
                    <Checkbox aria-label="全选展示中的问题单"
                      checked={selectableTickets.length > 0
                        && allDisplayedSelected}
                      indeterminate={!allDisplayedSelected
                        && displayedSelectedCount > 0}
                      onCheckedChange={() => toggleSelectAll()} />
                    <span className="whitespace-nowrap text-xs font-normal
                      text-muted-foreground">
                      已选 {displayedSelectedCount} / {selectableTickets.length} 张
                    </span>
                  </div>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    单号
                    <HeaderFilter label="单号" active={!!ticketFilter.trim()}
                      onClear={() => setTicketFilter("")}>
                      {() => <Input autoFocus
                        className="h-8 w-full rounded-md px-2 text-sm"
                        placeholder="包含单号片段…" aria-label="按单号过滤"
                        value={ticketFilter}
                        onChange={(event) => setTicketFilter(event.target.value)} />}
                    </HeaderFilter>
                  </span>
                </TableHead>
                <TableHead className="w-full">
                  <span className="inline-flex items-center gap-1">
                    标题
                    <HeaderFilter label="标题" active={!!titleFilter.trim()}
                      onClear={() => setTitleFilter("")}>
                      {() => <Input autoFocus
                        className="h-8 w-full rounded-md px-2 text-sm"
                        placeholder="包含标题片段…" aria-label="按标题过滤"
                        value={titleFilter}
                        onChange={(event) => setTitleFilter(event.target.value)} />}
                    </HeaderFilter>
                  </span>
                </TableHead>
                {/* 版本列(2026-09-13 表头化):展示含 B 版构建号的完整
                    版本(截断后悬停可见全串),过滤只认版本组——漏斗
                    弹层沿旧「版本过滤」的分组清单(勾组带全组 B 版),
                    44px 触控目标由选项行 min-h-11 保留。 */}
                <TableHead className="w-64">
                  <span className="inline-flex items-center gap-1">
                    版本
                    {versions.length > 0 && <HeaderFilter label="版本" contentClassName="w-72"
                      active={selectedVersions.length > 0}
                      onClear={() => setSelectedVersions([])}>
                      {() => <div className="flex flex-col">
                        {versions.map((version) => <label key={version}
                          className="flex min-h-11 cursor-pointer items-center gap-2.5
                            rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                          <Checkbox checked={selectedVersions.includes(version)}
                            onCheckedChange={(checked) => setSelectedVersions((prev) => checked
                              ? [...prev, version]
                              : prev.filter((item) => item !== version))} />
                          <span className="font-mono text-xs">{version}</span>
                        </label>)}
                      </div>}
                    </HeaderFilter>}
                  </span>
                </TableHead>
                <TableHead>状态</TableHead>
                {/* 发起状态列(2026-09-14):本平台有没有发起过——判定
                    与发起拦截同尺(liveIssueFor 一处口径),漏斗默认只
                    看未发起;徽标可点,跳进该单名下的进行中会话。 */}
                <TableHead className="w-24">
                  <span className="inline-flex items-center gap-1">
                    发起状态
                    <HeaderFilter label="发起状态" active={launchFilterActive}
                      onClear={() => {
                        setShowUnlaunched(true);
                        setShowLaunched(true);
                      }}>
                      {() => <div className="flex flex-col">
                        <label className="flex min-h-11 cursor-pointer items-center gap-2.5
                          rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                          <Checkbox checked={showUnlaunched}
                            onCheckedChange={(checked) => setShowUnlaunched(checked)} />
                          未发起
                        </label>
                        <label className="flex min-h-11 cursor-pointer items-center gap-2.5
                          rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                          <Checkbox checked={showLaunched}
                            onCheckedChange={(checked) => setShowLaunched(checked)} />
                          已发起(进行中)
                        </label>
                      </div>}
                    </HeaderFilter>
                  </span>
                </TableHead>
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
                // 发起状态两本账(2026-09-17 协助视角):拦截认我的名册
                // (同账号+同单号至多一个进行中,与服务端 create 同尺);
                // 徽标认展示名册——协助视角下别人发起过的单也标「进行中」,
                // 点开是查看模式,但勾选不禁、发起不拦(接管正是协助的
                // 用法,分支按发起人隔离不冲突)。
                const mineLive = mineLiveByTicket.get(ticket.ticket);
                const liveIssue = mineLive
                  ?? shownLiveByTicket.get(ticket.ticket);
                const liveTip = liveIssue
                  ? (liveIssue.account === viewer.username
                    ? `已发起:会话 ${liveIssue.id} 进行中`
                    : `已发起:${liveIssue.account} 的会话 ${liveIssue.id} 进行中`)
                  : "";
                const colCount = moduleCol ? 8 : 7;
                return <Fragment key={ticket.ticket}>
                  <TableRow
                    data-state={selected.includes(ticket.ticket)
                      ? "selected" : undefined}>
                    <TableCell>
                      <Checkbox checked={selected.includes(ticket.ticket)}
                        disabled={!!mineLive}
                        title={mineLive ? `${liveTip},不可重复发起` : undefined}
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
                      {/* 单号直达 DTS 门户(a { color: inherit } 全局兜底,
                          外观与原文字一致;新开页签,不带走列表现场)。 */}
                      <a className="issue-dts-ticket font-mono text-sm
                        font-medium text-primary underline-offset-2
                        hover:underline"
                        href={dtsTicketUrl(ticket.ticket)}
                        target="_blank" rel="noreferrer">
                        {ticket.ticket}
                      </a>
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
                    <TableCell className="max-w-0">
                      <span className="block truncate font-mono text-xs"
                        title={ticket.version}>
                        {ticket.version || "—"}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {ticket.status
                        && <Badge variant="secondary">{ticket.status}</Badge>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {liveIssue
                        ? <Button type="button" variant="ghost" size="xs"
                            className="group/live"
                            title={`${liveTip},${mineLive ? "点击打开" : "点击查看"}`}
                            aria-label={`${mineLive ? "打开" : "查看"} ${ticket.ticket} 的进行中会话`}
                            onClick={() => onOpenIssue?.(liveIssue.id)}>
                          <Badge>
                            {/* 徽标本体是静态胶囊(2026-09-14 设计审查:
                                悬停底色辨不出可点),内层文字挂链接级
                                下划线语言,与单号链接同款;下划线挂文字
                                所在的行内盒,穿透 inline-flex 不失效。
                                不加 offset:Badge overflow-hidden 且
                                h-5 贴边,默认位置最稳。 */}
                            <span className="group-hover/live:underline group-focus-visible/live:underline">进行中</span>
                          </Badge>
                        </Button>
                        : <span className="text-muted-foreground"
                            aria-label="未发起">—</span>}
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
                          title="人工预绑这张单所属的业务模块;发起处理时直接带出,AI 不再识别">
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
                          <dd className="min-w-0">{(detail?.url || ticket.url)
                            ? <a className="text-primary underline underline-offset-2 break-all"
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
          </Table>
        </div>}
    </>}
    {tickets && tickets.length === 0 && <div className="flex flex-col items-center
      gap-2 rounded-lg border border-dashed border-line px-6 py-12 text-center">
      <p className="text-base font-medium">
        {assistMode ? `${ownerLabel} 名下当前没有问题单` : "你的名下当前没有问题单"}
      </p>
      <p className="max-w-md text-sm text-muted-foreground">
        {assistMode
          ? "换回自己或选其他成员查看;发起处理会话归属你自己名下推进。"
          : "有新单落到你名下后,点「刷新」拉取;发起过的单在「问题会话」页签可见。"}
      </p>
    </div>}
    {tickets && tickets.length > 0 && (actionable?.length ?? 0) === 0
      && <div className="flex flex-col items-center gap-2 rounded-lg border
        border-dashed border-line px-6 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          名下问题单里没有「{DTS_ACTIONABLE_STATUS}」状态的——只有该状态可发起,
          其他状态不可拉取。
        </p>
      </div>}
  </div>;
}
