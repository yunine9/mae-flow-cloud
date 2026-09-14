/**
 * 元信息域(#239 只读版;#266 场景化平铺):问题会话工作台首签「元信息」。
 *
 * 上半区只读平铺元信息字段,无「登记信息」壳(ADR-0026):标题、
 * 问题描述全文仅无单会话渲染——有单会话(detail.ticket 在场)看
 * 「DTS单据」页签,那是唯一权威出处,DTS 发起时描述只是单据标题的
 * 抄本,陈列它等于同一信息两处且其中一处是错的;业务模块名、网管
 * 环境(名称 + IP + 端口 + 形态;形态中文沿用环境域口径「虚拟化/
 * 容器化」,见 EnvironmentEditorDialog 的页面文案)两场景都显,环境
 * 未配置如实示「尚未配置」加引导(运行中 AI 举卡回填),不设第二
 * 编辑入口。凭据类字段绝不出现:凭据只以服务端 vault 引用的形式存
 * 在于 wire 上,本面板连引用都不渲染。空值如实说「(未填)」,不编
 * 占位内容。
 *
 * 下半区陈列会话全部关联仓(仓名 + 完整 URL,一仓一行);模块绑定仓
 * (团队资产目录里该 module_id 的 repositories)带「模块绑定」标识。
 * 绑定集合在本组件内经 getBusinessModules 异步解析:目录加载失败/
 * 未登记 module_id/模块不在册一律降级为不出标识,仓清单照列——绑定
 * 标是加分信息,不是清单的前提。
 *
 * repo_reclaimed_at 在场(磁盘治理:终态单的 repo/ 被清扫器回收)时,
 * 清单区如实标注「现场已回收」,不冒充在场。
 *
 * #241 编辑区(文末挂载点,受终态闸门控制):关联仓清单的增删编辑器。
 * 项目原则——不涉及安全风险时一切交给 Agent,UI 只做状态显示:人的裁定
 * 先进本地缓冲(增/删两组),「确定」时一次 POST 交给 Agent 执行,清单
 * **不乐观更新**,数据源始终是 detail;成功只清缓冲并如实提示「已通知
 * Agent 处理,清单将在 Agent 执行后更新」,清单随既有事件流(SSE)自刷。
 * 移除是人裁定该仓与问题无关的严肃操作,按钮只把意图移入缓冲,成功
 * 提示只说「已通知」,绝口不提清单已改;模块绑定仓是团队资产,行内连
 * 移除按钮都不渲染(不是置灰)。
 * 新增输入行带与后端同款口径的即时校验(https:// 前缀/不重复/合并计数
 * ≤ 上限),错误就地小字,别等服务端打回。终态会话(archived/canceled,
 * failed 按会话域既有终局口径一并算)永远不渲染任何编辑入口。
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  getBusinessModules,
  getIssueMaterials,
  requestIssueLogFetch,
  requestIssueRepoChanges,
  type IssueDetail,
} from "../api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription } from "@/components/Empty";
import { formatLocalDateTime } from "../time";
import { repoName } from "./perRepo";
import { ENVIRONMENT_FORM_TEXT } from "../EnvironmentEditorDialog";

/** 空值口径:登记面没填的字段如实示人,不编内容。 */
const UNFILLED = "(未填)";

function envTypeText(envType: "virtualized" | "k8s" | undefined): string {
  // 形态中文与编辑弹框同源(ENVIRONMENT_FORM_TEXT:虚拟化/容器化)。
  return envType ? ENVIRONMENT_FORM_TEXT[envType] : "形态未填";
}

/** 绑定比对与后端工具层门禁同一把尺(repositoryIdentity):trim/去尾
 * 斜杠/去 .git/小写——模块目录里的地址与登记仓的 .git 尾缀写法可能
 * 有差异,原样字符串比对会漏标。 */
function repoIdentity(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

/** 终态口径:与会话域既有判断同尺(MaterialsPane 的 reviewEnabled、
 * 协作流的 ended 都是 archived/canceled/failed 三值,#239 票面的
 * canceled/archived 是其子集)。终态会话整页只读——本票的面板本来
 * 零写口,这道闸是给 #241 编辑器预立的结构位。 */
const TERMINAL_STATUSES = ["archived", "canceled", "failed"] as const;

/** 一个问题会话的合并仓上限(与后端 state.ts 的 MAX_ISSUE_REPOS 同一口
 * 径):新增输入的即时校验先行同款,别等服务端打回。 */
const MAX_ISSUE_REPOS = 8;

export function IssueMetaPane({ detail, canOperate }: {
  detail: IssueDetail;
  /** 归属操作权(查看模式=false):触发 AI 拉日志是写口(意图递交),
   * 只归归属人;下载是纯读,不收闸。 */
  canOperate: boolean;
}) {
  // 模块绑定仓集合(团队资产目录按 module_id 解析)。undefined = 还没
  // 取到/取不到/没登记模块——绑定标一律不出,仓清单不依赖它。
  const [boundRepos, setBoundRepos] = useState<readonly string[]>();
  useEffect(() => {
    if (!detail.module_id) return;
    let alive = true;
    getBusinessModules()
      .then((catalog) => {
        if (!alive) return;
        const bound = catalog.modules.find(
          (module) => module.id === detail.module_id,
        )?.repositories ?? [];
        setBoundRepos(bound);
      })
      .catch(() => {
        // 目录读不到:绑定标降级缺席,仓清单照列,不给会话页添堵。
        if (alive) setBoundRepos([]);
      });
    return () => { alive = false; };
  }, [detail.module_id]);

  // ---- 日志下载(#267,ADR-0026):日志的人读面只有下载一途(在线
  // 树/查看器/解压已随「拉取日志」页签退役)。「拉取过没拉取过」没有
  // 独立状态位,判定信号就是材料清单里有没有日志文件;清单随 updated_at
  // 的既有节奏重取,失败按无日志降级(按钮缺席即可,不给会话页添堵)。 ----
  const [logFileCount, setLogFileCount] = useState(0);
  const [downloadingLogs, setDownloadingLogs] = useState(false);
  const [logDownloadNote, setLogDownloadNote] = useState("");
  useEffect(() => {
    let alive = true;
    getIssueMaterials(detail.id)
      .then((materials) => {
        if (alive) setLogFileCount(materials.logs.entries
          .filter((entry) => entry.type === "file").length);
      })
      .catch(() => {
        if (alive) setLogFileCount(0);
      });
    return () => { alive = false; };
  }, [detail.id, detail.updated_at]);

  /** 整包下载拉取日志(zip;与过程文档打包下载同一套浏览器取流法)。
   * 服务端空/缺给 404 人话——按钮本就不渲染,这里防的是竞态空包。 */
  async function downloadLogs() {
    if (downloadingLogs) return;
    setDownloadingLogs(true);
    setLogDownloadNote("");
    try {
      const response = await fetch(
        `/issues/${encodeURIComponent(detail.id)}/materials/logs/archive`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        throw new Error(String(body.error ?? `下载失败(${response.status})`));
      }
      const blobUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = `${detail.id}-拉取日志-`
        + `${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    } catch (reason) {
      setLogDownloadNote(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setDownloadingLogs(false);
    }
  }

  // ---- 主动拉取(#268,ADR-0026):按钮不执行任何事,只把拉取意图
  // 递给 Agent(Agent 主理第二例,与「调整关联仓」同一递交通道)——
  // AI 按技能 issue-ops 拉取,缺环境自然举环境闸。无日志的非终态会话
  // 才出钮(有日志后被「下载日志」替代);AI 运行中不禁用——运行中
  // 点击经插话队列在当前步骤结束后送达,是正当语义。 ----
  const [requestingFetch, setRequestingFetch] = useState(false);
  const [fetchNotice, setFetchNotice] = useState("");
  async function requestLogFetchIntent() {
    if (requestingFetch) return;
    setRequestingFetch(true);
    setFetchNotice("");
    try {
      await requestIssueLogFetch(detail.id);
      setFetchNotice(
        "已通知 Agent 拉取,完成后日志清单自动更新;"
        + "排队与 SSH 拉取可能需要几分钟");
    } catch (reason) {
      setFetchNotice(
        String(reason instanceof Error ? reason.message : reason));
    } finally {
      setRequestingFetch(false);
    }
  }

  // ---- #241 编辑缓冲:增/删两组,「确定」时一次提交。清单数据源始终
  // 是 detail(不乐观更新);缓冲属于当前会话的裁定,换会话即弃。 ----
  const [pendingRepoAdd, setPendingRepoAdd] = useState<string[]>([]);
  const [pendingRepoRemove, setPendingRepoRemove] = useState<string[]>([]);
  const [repoInput, setRepoInput] = useState("");
  const [repoSubmitting, setRepoSubmitting] = useState(false);
  const [repoNotice, setRepoNotice] = useState<string>();
  const [repoSubmitError, setRepoSubmitError] = useState<string>();
  useEffect(() => {
    setPendingRepoAdd([]);
    setPendingRepoRemove([]);
    setRepoInput("");
    setRepoNotice(undefined);
    setRepoSubmitError(undefined);
  }, [detail.id]);

  // 全部关联仓:repo_urls 为骨架(彼此平等),repo_url 是单仓旧形状的
  // 兼容位(与逐仓交付 repoDeliveryRows 同一条取数口径)。
  const repos = detail.repo_urls?.length
    ? detail.repo_urls
    : detail.repo_url ? [detail.repo_url] : [];
  const isTerminal =
    (TERMINAL_STATUSES as readonly string[]).includes(detail.status);

  // 缓冲 diff 门禁:增删皆空 = 无可提交(「确定」禁用)。
  const repoDiffEmpty =
    pendingRepoAdd.length === 0 && pendingRepoRemove.length === 0;

  /** 新增输入的就地即时校验(与后端同款口径,别等服务端打回):
   * https:// 前缀、不与现清单/待新增重复、合并计数 ≤ 上限。
   * 空输入 = 还没写,不算错。 */
  function repoInputIssue(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (!trimmed.toLowerCase().startsWith("https://")) {
      return "只接受 https:// 开头的代码仓地址";
    }
    const identity = repoIdentity(trimmed);
    if (repos.some((url) => repoIdentity(url) === identity)
      || pendingRepoAdd.some((url) => repoIdentity(url) === identity)) {
      return "该仓已在关联仓清单里,不重复添加";
    }
    // 上限口径与后端一致:移除不抵扣(current + 新增 ≤ 上限)——
    // 先拉后删的执行时序下抵扣不成立,后端按不抵扣校验,前端同尺
    // 预判,否则前端放行、后端 409。
    const projected = repos.length + pendingRepoAdd.length + 1;
    if (projected > MAX_ISSUE_REPOS) {
      return `一个问题会话最多拉取 ${MAX_ISSUE_REPOS} 个代码仓`
        + `(现有 ${repos.length} 个,再新增将达 ${projected} 个),`
        + "请分多次提交";
    }
    return undefined;
  }
  const repoAddIssue = repoInputIssue(repoInput);

  function queueRepoAdd() {
    const value = repoInput.trim();
    if (!value || repoInputIssue(value)) return;
    setPendingRepoAdd([...pendingRepoAdd, value]);
    setRepoInput("");
  }

  /** 提交:把缓冲 diff 一次性通知给 Agent。成功只清缓冲 + 状态提示
   * (清单不乐观更新,随既有事件流自刷);失败就地示错,缓冲保留可重试。
   * 执行者是 Agent,不是这个按钮——提示只说已通知,不说清单已改。 */
  async function submitRepoChanges() {
    if (repoDiffEmpty || repoSubmitting) return;
    setRepoSubmitting(true);
    setRepoSubmitError(undefined);
    try {
      await requestIssueRepoChanges(detail.id, {
        add: pendingRepoAdd,
        remove: pendingRepoRemove,
      });
      setPendingRepoAdd([]);
      setPendingRepoRemove([]);
      setRepoNotice("已通知 Agent 处理,清单将在 Agent 执行后更新");
    } catch (reason) {
      setRepoSubmitError(
        String(reason instanceof Error ? reason.message : reason));
    } finally {
      setRepoSubmitting(false);
    }
  }

  return <div className="grid min-h-0 flex-1 content-start gap-3.5 overflow-y-auto">
    {/* 元信息字段(只读平铺,ADR-0026):无壳直列。标题/问题描述挂
        detail.ticket 门——与头部单号徽标、「DTS单据」页签禁用同一条
        判定词,有单即隐藏,场景只有一种来源不搞两套口径。 */}
    {!detail.ticket && <>
      <MetaField label="标题">{detail.title}</MetaField>
      <MetaField label="问题描述">
        <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">
          {detail.description || UNFILLED}
        </span>
      </MetaField>
    </>}
    <MetaField label="业务模块">{detail.module || UNFILLED}</MetaField>
    <MetaField label="网管环境">
      <span className="grid content-start gap-1.5">
        {detail.environment
          ? <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span>{detail.environment.name}</span>
              <span className="font-mono text-[13px]">
                {detail.environment.hosts.join("、") || UNFILLED}
              </span>
              <span>端口 {detail.environment.port}</span>
              <span>{envTypeText(detail.environment.env_type)}</span>
            </span>
        : <span className="text-muted-foreground">
            尚未配置——运行中 AI 举卡询问网管环境,回填后在此显示。
          </span>}
        {/* 日志的人读出口(#267):拉取过(logs 清单有文件)才显示,
            终态会话照常可下(与导出现场记录同口径);下载是纯读,
            查看模式不收闸。 */}
        {logFileCount > 0 && <span className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="xs"
            disabled={downloadingLogs}
            onClick={() => void downloadLogs()}>
            {downloadingLogs ? "打包中…" : "下载日志"}
          </Button>
          <span className="text-xs text-muted-foreground">
            共 {logFileCount} 个日志文件,整包下载
          </span>
        </span>}
        {/* 主动拉取(#268):无日志的非终态会话才出钮(与下载互补,
            有日志后由下载替代);环境未配置也显示——点击后 AI 按技能
            举环境闸要环境,一条链走完;写口只归归属人。 */}
        {!isTerminal && canOperate && logFileCount === 0
          && <span className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="xs"
              disabled={requestingFetch}
              onClick={() => void requestLogFetchIntent()}>
              {requestingFetch ? "已递交…" : "拉取日志"}
            </Button>
            <span className="text-xs text-muted-foreground">
              还没有拉取过日志,可请 AI 去网管侧拉取
            </span>
          </span>}
        {fetchNotice && <span className="utility-note" role="status">
          {fetchNotice}
        </span>}
        {logDownloadNote && <span className="text-xs text-danger" role="alert">
          {logDownloadNote}
        </span>}
      </span>
    </MetaField>
    {/* 关联仓清单区(只读):全部登记仓,仓名 + 完整 URL;模块绑定仓
        带标识;现场已回收时如实标注(回收时刻一并示人)。 */}
    <section aria-label="关联仓清单"
      className="grid content-start gap-2 rounded-xl border border-border bg-surface px-3.5 py-3">
      <div className="flex flex-wrap items-baseline gap-2.5">
        <strong className="text-sm font-bold">关联仓清单</strong>
        <span className="text-xs text-faint">发起时登记的全部代码仓,一仓一行</span>
      </div>
      {detail.repo_reclaimed_at && <div className="utility-note" role="status">
        现场已回收({formatLocalDateTime(detail.repo_reclaimed_at)}):
        取消/归档的问题单不再保留 repo 克隆(磁盘纪律),源码可随时重新拉取。
      </div>}
      {repos.length === 0
        ? <Empty className="border py-4.5">
            <EmptyDescription>会话没有登记代码仓——发起时登记的业务模块决定关联仓。</EmptyDescription>
          </Empty>
        : <ul className="m-0 grid list-none content-start gap-2 p-0">
            {repos.map((url) => {
              const bound = (boundRepos ?? [])
                .some((item) => repoIdentity(item) === repoIdentity(url));
              const queued = pendingRepoRemove.includes(url);
              return <li key={url}
                className={"grid content-start gap-0.5 rounded-lg border border-line bg-(--surface-muted) px-3 py-2 text-sm"
                  + (queued ? " opacity-60" : "")}>
                <div className="flex flex-wrap items-center gap-2">
                  <strong title={url}
                    className="font-mono text-[13px] font-semibold text-text-strong [overflow-wrap:anywhere]">
                    {repoName(url)}
                  </strong>
                  {bound && <Badge variant="neutral"
                    title="该仓在业务模块的绑定仓清单里(团队资产目录)">模块绑定</Badge>}
                  {queued && <Badge variant="warning"
                    title="已入本次移除缓冲,点「确定」后才交给 Agent">将移除</Badge>}
                  {/* #241:移除 = 人裁定该仓与问题无关的严肃操作——按钮
                      只把意图移入缓冲,不就地改清单;模块绑定仓是团队资产,
                      连按钮都不渲染(不是置灰)。 */}
                  {!isTerminal && !bound && (queued
                    ? <Button variant="outline" size="xs" className="ml-auto"
                      onClick={() => setPendingRepoRemove(
                        pendingRepoRemove.filter((item) => item !== url))}>
                      撤销移除
                    </Button>
                    : <Button variant="destructive" size="xs" className="ml-auto"
                      onClick={() => setPendingRepoRemove(
                        [...pendingRepoRemove, url])}>
                      移除
                    </Button>)}
                </div>
                <span className="select-text font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {url}
                </span>
              </li>;
            })}
          </ul>}
    </section>
    {/* #241 编辑区:增删裁定先入本地缓冲,「确定」一次提交给 Agent 执行。
        清单不乐观更新(数据源仍是 detail),提交成功只清缓冲并如实告知,
        清单随既有事件流自刷;终态会话整段不渲染(上面的终态闸)。 */}
    {!isTerminal && <section aria-label="调整关联仓"
      className="grid content-start gap-2.5 rounded-xl border border-border bg-surface px-3.5 py-3">
      <div className="flex flex-wrap items-baseline gap-2.5">
        <strong className="text-sm font-bold">调整关联仓</strong>
        <span className="text-xs text-faint">
          增删会交给 Agent 执行,确定后清单自动更新
        </span>
      </div>
      {/* 新增输入行:即时校验(前缀/重复/合并上限),错误就地小字。 */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={repoInput}
          placeholder="https://git.example.com/team/repo.git"
          aria-label="新增代码仓地址"
          className="min-w-60 flex-1 font-mono text-[13px]"
          onChange={(event) => setRepoInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") queueRepoAdd();
          }}
        />
        <Button variant="outline" size="sm"
          disabled={!repoInput.trim() || !!repoAddIssue}
          onClick={queueRepoAdd}>添加到清单</Button>
      </div>
      {repoAddIssue && <p className="text-xs text-danger" role="alert">
        {repoAddIssue}
      </p>}
      {pendingRepoAdd.length > 0 && <ul
        className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0">
        {pendingRepoAdd.map((url) => <li key={url}
          className="flex items-center gap-1 rounded-lg border border-line bg-(--surface-muted) px-2 py-0.5 text-xs">
          <span className="font-mono [overflow-wrap:anywhere]">
            {repoName(url)}
          </span>
          <Button variant="ghost" size="xs"
            aria-label={`撤回新增 ${repoName(url)}`}
            onClick={() => setPendingRepoAdd(
              pendingRepoAdd.filter((item) => item !== url))}>撤销</Button>
        </li>)}
      </ul>}
      {/* 缓冲摘要 + 确定门禁:diff 为空(无可提交)或提交中一律禁用。 */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-xs text-muted-foreground">
          {repoDiffEmpty
            ? "还没有待提交的增删"
            : `将新增 ${pendingRepoAdd.length} 个、移除 ${pendingRepoRemove.length} 个`}
        </span>
        <Button size="sm" disabled={repoDiffEmpty || repoSubmitting}
          onClick={submitRepoChanges}>确定</Button>
      </div>
      {repoNotice && <p className="utility-note" role="status">{repoNotice}</p>}
      {repoSubmitError && <p className="text-xs text-danger" role="alert">
        {repoSubmitError}
      </p>}
    </section>}
  </div>;
}

/** 登记信息的一行:标签在上、值在下(只读陈列,无输入控件)。 */
function MetaField({ label, children }: {
  label: string;
  children: ReactNode;
}) {
  return <div className="grid content-start gap-0.5 text-sm">
    <span className="text-xs font-semibold text-muted-foreground">{label}</span>
    <div className="leading-[1.6] text-text-strong">{children}</div>
  </div>;
}
