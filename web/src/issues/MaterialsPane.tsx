import { AnnotationExcerpt } from "../AnnotationExcerpt";
import { resolvedAnnotationRange, annotationLocationRow } from "../annotateTargets";
/**
 * 材料域:会话材料内容(DTS 单据 / 过程文档 / 工作区变更含快速修改;
 * 拉取日志视图已随 #267 退役,ADR-0026——日志的人读面收敛为元信息
 * 页签网管环境区的「下载日志」整包 zip,AI 读日志不经页面)。
 *
 * 从 IssueBoard.tsx 原文搬移(spec #2 按域拆分,纯搬移零行为变化):
 * diff 用任务侧同一把 GitDiff 渲染。合并视图直接渲染聚合 diff(服务端
 * 自带「===== 仓库 =====」分段标记,GitDiff 按元信息行呈现);逐仓视图
 * 走 ?repo= 服务端切片(#32),每仓独立请求,不再前端解析分段标记。
 * #123 拍平:面板壳(头部页签条)上收为会话层的一级标签
 * (SessionView 直排),本组件改为免壳直渲——只按会话层下发的
 * view 渲染对应内容,三类内容与整包下载原样;分析报告子视图
 * (#260 页签收敛,原 IssueProcessDocs 多页签 = 分析报告 + 过程问答 +
 * 检视 + Agent 落的其他 .md)只剩报告本身,检视内联进正文下方。
 * 快速修改是问题流唯一的人工写口——只改 repo/ 内已有文件,保存入
 * 人工台账,"请 AI 复核"走现有插话/续聊通道。
 * 查看模式(canOperate=false,非归属人围观):写口全部不渲染——快速
 * 修改编辑器、检视(行尾圈注与正文下方的草稿/提交区);文件/diff/
 * 文档的只读浏览完整保留,已提交的检视意见清单照看(纯读,#259
 * story 23)。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addIssueReview,
  dropIssueReview,
  getDtsTicketDetail,
  getIssueAnalysisVersion,
  getIssueAnalysisVersions,
  getIssueDocument,
  getIssueDocuments,
  getIssueFileDiff,
  getIssueMaterials,
  getIssueReviews,
  getIssueWorkspaceFile,
  saveIssueWorkspaceFile,
  sendIssueReviews,
  type DtsTicketDetail,
  type IssueAnalysisVersion,
  type IssueDetail,
  type IssueDocMeta,
  type IssueMaterials,
  type IssueReview,
  type IssueReviewCheck,
} from "../api";
import { Annotatable } from "../Annotatable";
import { Markdown } from "../markdown";
import { GitDiff } from "../GitDiff";
import { confirmDialog } from "../ConfirmDialog";
import { Empty, EmptyTitle, EmptyDescription } from "@/components/Empty";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "cn";
import { formatLocalDateTime } from "../time";
import { prepareDtsHtml } from "./dtsHtml";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

/** 分析报告的文件名(与服务端 documents.ts 的常量镜像:前端不拼路径,
 * 只认这一份报告)。 */
const ANALYSIS_DOC = "issue-analysis.md";

/** #230 去 legacy:材料/检视域的皮肤类换工具类。检视卡是共用版式,
 * 先落成词典;颜色全部经语义令牌或 var() 简写取 tokens,不再按家族
 * 复制配方。 */
const REVIEW_ITEM = "rounded-[10px] border border-line bg-surface px-3 py-2 text-[13px] leading-[1.6]";
const NOTE_HEAD = "m-0 text-[13px] font-bold text-muted-foreground";

/** 分析报告视图(#260 页签收敛,ADR-0025):「分析报告」页签下只留
 * 报告本身——过程问答/检视/动态 md 子页签退役,检视的圈注写口保留在
 * 行尾,草稿与提交链路内联到正文下方。状态一动(updated_at 变化)
 * 自动重读,让 AI 续写的内容能贴着节奏刷新;其他 .md 不再单页呈现,
 * 仍可整包下载。
 * 版本(#262,ADR-0025):平台在检视提交时冻结快照,报告按「初版/
 * 修订N」出版本页签条(多版才渲染),缺省选中最新版;最新版是干净
 * 纸面(已提交意见不再标记在 live 上,行尾只剩草稿),冻结版只读、
 * 该批提交意见的锚点标记画在它的冻结版上。
 * 检视(ADR-0007):报告按行悬停圈注意见(交互与需求流批注同一套),
 * 草稿攒在正文下方、一次提交触发整体回退重跑。写口(行尾圈注、草稿
 * 编辑、提交)只在归属操作权(canOperate)下渲染;已提交意见清单是
 * 纯读面,登录只读访问者也可见(spec #259 story 23),文档照读。 */
function IssueAnalysisReport({ detail, canOperate }: {
  detail: IssueDetail;
  canOperate: boolean;
}) {
  const id = detail.id;
  const [docs, setDocs] = useState<IssueDocMeta[]>([]);
  const [content, setContent] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  // 检视账本(轻量):随会话动态重读——锚点检测按当前报告现算,
  // AI 一改报告,徽标就贴着 updated_at 的节奏刷新。
  const [reviews, setReviews] = useState<IssueReview[]>([]);
  const locationRequest = useRef(0);
  const [locationExcerpt, setLocationExcerpt] = useState<IssueReview>();
  const [locationMessage, setLocationMessage] = useState("");
  const [checks, setChecks] = useState<IssueReviewCheck[]>([]);
  // 版本页签(#262,ADR-0025):清单推导自检视提交时平台冻结的快照,
  // live 恒为最新版。activeName="" 是"最新版"哨兵(缺省,即默认选中
  // 最新);选了冻结版就按需取那份快照内容,冻结稿永不随会话动态重读。
  const [versions, setVersions] = useState<IssueAnalysisVersion[]>([]);
  const [activeName, setActiveName] = useState("");
  const [frozen, setFrozen] = useState<{ content: string; truncated: boolean }>();
  const [frozenNote, setFrozenNote] = useState("");
  const versionRequest = useRef(0);
  // 已加载基准 = 会话动态:状态一动就重取;只在响应到手后记账,半路
  // 失败下次仍会重试。
  const refreshKey = detail.updated_at;
  const [loadedKey, setLoadedKey] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");

  useEffect(() => {
    if (!fullscreen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [fullscreen]);

  async function loadList() {
    try {
      const result = await getIssueDocuments(id);
      setDocs(result.documents ?? []);
    } catch {
      // 清单失败不动内容区:材料域 fail-open,不给会话页添堵。
    }
  }

  async function loadReviews() {
    try {
      const result = await getIssueReviews(id);
      setReviews(result.reviews ?? []);
      setChecks(result.checks ?? []);
    } catch {
      // 检视数据缺席只让它自己空着,不拖垮文档页。
    }
  }

  async function loadVersions() {
    try {
      const result = await getIssueAnalysisVersions(id);
      const list = result.versions ?? [];
      setVersions(list);
      // 选中项消失(新一轮提交使序号重排/同文去重折并)就回最新版;
      // "" 本就是最新版哨兵,原样保留。
      setActiveName((current) =>
        current && list.some((entry) => entry.name === current) ? current : "");
    } catch {
      // 版本清单缺席只让页签条空着:材料域 fail-open,不给会话页添堵。
    }
  }

  /** 切版本页签("" = 回最新版/live):冻结稿按需取,响应竞态用请求号
      压住——快速连点页签时旧响应不得覆盖新选中版。 */
  async function openVersion(name: string) {
    const request = ++versionRequest.current;
    setActiveName(name);
    setFrozen(undefined);
    setFrozenNote("");
    if (!name) return;
    try {
      const result = await getIssueAnalysisVersion(id, name);
      if (request !== versionRequest.current) return;
      if (result.unavailable) setFrozenNote(result.unavailable);
      else setFrozen({
        content: result.content ?? "",
        truncated: result.truncated === true,
      });
    } catch (reason) {
      if (request !== versionRequest.current) return;
      setFrozenNote(String(reason instanceof Error ? reason.message : reason));
    }
  }

  async function loadActive() {
    setLoading(true);
    try {
      const result = await getIssueDocument(id, ANALYSIS_DOC);
      if (result.unavailable) {
        setNote("AI 研究中会把结论写入 issue-analysis.md,生成后这里直接可读。");
        setContent("");
      } else {
        setNote("");
        setContent(result.content ?? "");
        setTruncated(result.truncated === true);
      }
      setLoadedKey(refreshKey);
    } catch (reason) {
      setNote(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setLoading(false);
    }
  }

  async function downloadDocuments() {
    if (!docs.length || downloading) return;
    setDownloading(true);
    setDownloadError("");
    try {
      const response = await fetch(
        `/issues/${encodeURIComponent(id)}/documents/archive`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: unknown };
        throw new Error(String(body.error ?? `打包下载失败(${response.status})`));
      }
      const blobUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = blobUrl;
      anchor.download = `${id}-过程文档-`
        + `${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    } catch (reason) {
      setDownloadError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setDownloading(false);
    }
  }

  useEffect(() => {
    void loadList();
    void loadReviews();
    void loadVersions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.updated_at]);
  useEffect(() => {
    if (loadedKey !== refreshKey) void loadActive();
    // loadedKey 有意不在依赖里:刷新按钮要的是无视缓存的重取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  /** 检视意见 → 报告正文的锚点定位:等渲染、滚动 + 闪烁(报告就在
      本视图,不再需要切页签)。 */
  async function locate(item: IssueReview) {
    const request = ++locationRequest.current;
    setLocationExcerpt(item);
    setLocationMessage("正在核对当前位置…");
    let fresh;
    try { fresh = await getIssueReviews(id); } catch {
      if (request !== locationRequest.current) return;
      setLocationMessage("暂时无法核对当前位置，先展示批注时原文。"); return;
    }
    if (request !== locationRequest.current) return;
    const check = fresh.checks.find(row => row.id === item.id);
    const range = resolvedAnnotationRange(item, check);
    if (!range) {
      setLocationMessage(check?.state === "ambiguous" ? "原文有多处匹配，先展示批注时原文。" : "原文已变化或暂不能定位，先展示批注时原文。"); return;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((done) => setTimeout(done, 150));
      if (request !== locationRequest.current) return;
      const node = annotationLocationRow([...document.querySelectorAll<HTMLElement>(".issue-doc-body [data-l]")], range.line);
      if (node) {
        setLocationExcerpt(undefined); setLocationMessage("");
        node.scrollIntoView({ block: "center" });
        node.classList.add("annot-flash");
        window.setTimeout(() => node.classList.remove("annot-flash"), 1700);
        return;
      }
    }
    setLocationMessage("当前版本没有对应位置，先展示批注时原文。");
  }

  // 检视入口的会话级门槛(与服务端 requireReviewable 同口径的显示面):
  // 未终态、无转正继承段(转正继承的报告不可检视)、检视回合未在进行中
  // (#98 单路径化:不再按模式判定,一切会话都是固定流程)。后端仍逐项
  // 把门,这里只管把按钮放对位置。
  const reviewEnabled = !["archived", "canceled", "failed"].includes(detail.status)
    && !detail.stage_states?.some((state) => state === "inherited")
    && detail.review_active !== true;

  // 版本页签的选中态(#262):""=最新版。最新版是干净纸面——已提交
  // (sent)的意见不再画在 live 上,行尾只剩草稿标记;冻结版(该批意见
  // 提交时冻结的快照)按版本清单给的 review_ids 画该批的提交意见标记,
  // 纯只读(Annotatable enabled=false 只剩标记层,无任何写口)。
  const viewingLatest = !versions.some(
    (entry) => entry.name === activeName && !entry.latest);
  const drafts = reviews.filter((item) => item.status === "draft");
  const frozenReviews = viewingLatest ? [] : reviews.filter((item) =>
    versions.find((entry) => entry.name === activeName)?.review_ids
      .includes(item.id) ?? false);

  // #230:报告壳换工具类。常态=面板内自滚的网格(problem 域灰底);
  // 全屏=固定定底盘的纵向 flex,正文+内联检视区接管余量自滚——
  // 旧 .issue-thread/.is-fullscreen 后代选择器按分支直译成分支上的变体。
  return <div
    className={`issue-doc${fullscreen ? " is-fullscreen fixed inset-[14px] z-[720] flex flex-col overflow-hidden rounded-[14px] border border-line bg-surface p-[18px_22px] text-foreground shadow-[0_24px_90px_rgba(0,0,0,0.45)] max-[760px]:inset-1 max-[760px]:rounded-[9px] max-[760px]:p-3" : " grid content-start gap-3 overflow-y-auto rounded-xl border border-line bg-surface-muted p-3.5"}`}>
    <div className="flex min-h-[30px] items-center justify-end gap-3">
      <span className="mr-auto text-xs text-faint">{fullscreen ? "全屏阅读分析报告" : ""}</span>
      <Button type="button" size="sm"
        disabled={!docs.length || downloading}
        title={docs.length
          ? `下载全部 ${docs.length} 份 Markdown 过程文档(完整原文件)`
          : "还没有可下载的过程文档"}
        onClick={() => void downloadDocuments()}>
        {downloading ? "打包中…" : "打包下载"}
      </Button>
      <Button type="button" variant="outline" size="sm"
        onClick={() => setFullscreen((current) => !current)}>
        {fullscreen ? "退出全屏" : "全屏查看"}
      </Button>
    </div>
    {downloadError && <div className="utility-note" role="alert">
      打包下载失败：{downloadError}
    </div>}
    {loading && <p className="m-0 text-[13px] text-faint">正在读取…</p>}
    {!loading && note && <Empty className="border py-4.5">
      <EmptyTitle>还没有分析报告</EmptyTitle>
      <EmptyDescription>{note}</EmptyDescription>
    </Empty>}
    {!loading && !note && content && <div className={cn("flex flex-col gap-3",
      fullscreen && "mx-auto min-h-0 w-full max-w-[1760px] flex-1 overflow-auto px-[clamp(20px,3vw,48px)] pb-20 pt-[22px] [&_.mermaid-figure]:overflow-x-hidden [&_.mermaid-diagram]:w-full [&_.mermaid-diagram]:min-w-0 [&_.mermaid-diagram]:max-w-full [&_.puml-diagram]:w-full [&_.puml-diagram]:min-w-0 [&_.puml-diagram]:max-w-full")}>
      {/* 版本页签条(#262):多版才渲染,缺省选中最新版;只有初版时
          不出条,正文即全部。手搓 button 药丸沿用本文件既有先例
          (「工作区变更」的逐仓切换药丸,见下方 diffRepos):版本是
          平铺的筛选态,没有面板体要挂,不走 Tabs 原语——同 #123 的
          拍平口径,页签容器语义会凭空多出一层壳。 */}
      {versions.length > 1 && <div className="flex flex-wrap gap-1.5"
          role="group" aria-label="分析报告版本">
        {versions.map((entry) => (
          <button type="button" key={entry.name}
            className={cn("cursor-pointer rounded-full border px-3 py-1 text-[13px] font-semibold transition-colors",
              (entry.latest ? viewingLatest : activeName === entry.name)
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-line bg-surface text-muted-foreground hover:border-primary/40")}
            title={entry.latest
              ? "最新版:AI 的当前稿,干净纸面"
              : "检视提交时冻结的快照,只读"}
            onClick={() => void openVersion(entry.latest ? "" : entry.name)}>
            {entry.name}
          </button>
        ))}
      </div>}
      <div className="flex items-center justify-between gap-2.5 text-xs text-faint">
        <span>{viewingLatest
          ? `研究现场落盘的 markdown · 即写即读${truncated ? " · 内容超长已截断" : ""}`
          : `检视提交时冻结的快照 · 只读${frozen?.truncated ? " · 内容超长已截断" : ""}`}</span>
        {viewingLatest && <Button type="button" variant="outline" size="xs"
          onClick={() => void loadActive()}>刷新</Button>}
      </div>
      {locationExcerpt && <><p role="status">{locationMessage}</p><AnnotationExcerpt item={locationExcerpt} onOpen={() => { locationRequest.current++; setLocationExcerpt(undefined); }} /></>}
      {viewingLatest ? <>
        <article className="issue-doc-body text-[13px] leading-[1.75] text-text-strong [overflow-wrap:anywhere]">
          {/* 圈注意见是写口(addIssueReview):查看模式落回纯 Markdown,
              不给行尾 ✎。items 只带草稿:最新版是干净纸面,已提交的
              意见不再标记在 live 上(它们锚在自己批次的冻结版上)。 */}
          {reviewEnabled && canOperate
            ? <Annotatable taskId={id} artifact={ANALYSIS_DOC}
                fallbackFile={ANALYSIS_DOC} kind="doc" items={drafts}
                onAdded={() => void loadReviews()}
                addDraft={async (input) => {
                  try {
                    await addIssueReview(id, input);
                    void loadReviews();
                    return {};
                  } catch (reason) {
                    return {
                      error: String(reason instanceof Error ? reason.message : reason),
                    };
                  }
                }}>
                <Markdown showLineNumbers text={content} />
              </Annotatable>
            : <Markdown showLineNumbers text={content} />}
        </article>
        {/* 检视区常驻正文下方(#260 收敛,原「检视」页签):不再整块挂
            canOperate——已提交意见清单是纯读面,登录只读访问者也可见
            (spec #259 story 23,服务端本就登录可读);草稿/提交写口
            在面板内收闸。只随最新版出现——冻结版是历史纸面,不收新
            意见(#262)。 */}
        <IssueReviewPanel detail={detail} reviews={reviews}
          checks={checks} reviewEnabled={reviewEnabled}
          canOperate={canOperate}
          onReload={() => void loadReviews()} onLocate={(item) => void locate(item)} />
      </> : <article className="issue-doc-body text-[13px] leading-[1.75] text-text-strong [overflow-wrap:anywhere]">
        {frozenNote && <div className="utility-note mb-2" role="alert">{frozenNote}</div>}
        {frozen ? <>
          {/* 该批已提交意见的锚点标记画在它们的冻结版上:Annotatable
              关着(enabled=false)只剩标记层,悬停无写口。 */}
          <Annotatable taskId={id} artifact={ANALYSIS_DOC}
            fallbackFile={ANALYSIS_DOC} kind="doc" enabled={false}
            items={frozenReviews} onAdded={() => {}}>
            <Markdown showLineNumbers text={frozen.content} />
          </Annotatable>
        </> : <p className="m-0 text-[13px] text-faint">正在读取该版快照…</p>}
      </article>}
    </div>}
  </div>;
}

/** 锚点检测徽标(ADR-0007 Q13):gone = 已被改动(唯一判据),原文
 * 还在 = 黄灯提醒"这条可能还没被吸收"。人工改动引发的失配同理可见。
 * 只服务草稿(ADR-0025「新版干净纸面」):sent 意见锚在自己批次的
 * 冻结版上,冻结文本永不漂移,不再出检测、不再带徽标。
 * (#230 换 Badge 皮:gone 保留主动作紫提请注意,其余中性灰。) */
function IssueReviewBadge({ check }: { check?: IssueReviewCheck }) {
  if (!check) return null;
  if (check.state === "gone") {
    return <Badge variant="brand">已被改动·请你确认</Badge>;
  }
  if (check.state === "moved") {
    return <Badge variant="neutral"
      title="原文还在,只是行号漂移">已移至第 {check.line} 行</Badge>;
  }
  if (check.state === "ambiguous") {
    return <Badge variant="neutral"
      title="原文多处命中,点行号自行核对">多处命中</Badge>;
  }
  return <Badge variant="neutral"
    title="这条意见对应的原文还在报告里——可能还没被吸收,点行号核对">
    原文仍在</Badge>;
}

function IssueReviewItem({ item, check, onLocate, onRemove }: {
  item: IssueReview;
  check?: IssueReviewCheck;
  onLocate: (item: IssueReview) => void;
  onRemove?: () => void;
}) {
  return <li className={REVIEW_ITEM}>
    <div className="flex items-baseline gap-2">
      {/* 「意见N」是唯一对外标识(#261):台账 an- id 不出面;意见号是
          落账硬要求(ADR-0025),不存在无号意见,不给降级也不给假号。 */}
      <span className="shrink-0 text-[13px] font-bold text-text-strong">
        意见{item.seq}
      </span>
      <Button type="button" variant="link" size="xs" className="h-auto px-0"
        onClick={() => onLocate(item)}>查看原文</Button>
      {/* 漂移徽标只服务草稿(ADR-0025「新版干净纸面」):sent 意见锚在
          自己批次的冻结版上,冻结文本永不漂移,徽标无意义。 */}
      {item.status === "draft" && check && <IssueReviewBadge check={check} />}
      <time className="text-xs text-faint">{formatLocalDateTime(item.created_at, { seconds: true })}</time>
      {onRemove && <Button type="button" variant="ghost" size="xs" className="ml-auto"
        onClick={onRemove}>移除</Button>}
    </div>
    <blockquote className="my-1 border-l-[3px] border-line pl-2 text-muted-foreground [overflow-wrap:anywhere]">针对 {item.anchor}</blockquote>
    <p className="m-0 text-text-strong [overflow-wrap:anywhere]">{item.note}</p>
  </li>;
}

/** 检视区(#260 内联,原「检视」页签):草稿攒批、一次提交触发整体
 * 回退(轻量确认列明后果)。常驻分析报告正文下方,不再是独立页签。
 * 可见性分两层(spec #259 story 23):已提交意见清单是纯读面,登录
 * 访问者都可看;草稿编辑/移除/提交是写口,整段收在 canOperate——
 * 服务端本就登录可读、写仅归属人,这里只管把写控件放对位置。 */
function IssueReviewPanel({ detail, reviews, checks, reviewEnabled, canOperate, onReload, onLocate }: {
  detail: IssueDetail;
  reviews: IssueReview[];
  checks: IssueReviewCheck[];
  reviewEnabled: boolean;
  /** 归属操作权(查看模式=false):已提交清单照看,草稿写口不渲染。 */
  canOperate: boolean;
  onReload: () => void;
  onLocate: (item: IssueReview) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const id = detail.id;
  const drafts = reviews.filter((item) => item.status === "draft");
  const sent = reviews.filter((item) => item.status === "sent");
  const checkOf = (reviewId: string) =>
    checks.find((check) => check.id === reviewId);

  async function remove(reviewId: string) {
    setBusy(true);
    try {
      await dropIssueReview(id, reviewId);
      onReload();
    } catch (reason) {
      setNote(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!await confirmDialog({
      title: `提交 ${drafts.length} 条检视意见并重跑分析`,
      message: <ul>
        <li>当前等你回答的问题卡(如有)将作废</li>
        <li>工作流从「问题分析」重新执行，其后阶段标记重做(轮次 +1)</li>
        <li>已申报的 UT/流水线/MR 账作废；分支与 MR 延用，同分支追加修复</li>
      </ul>,
      confirmLabel: "提交并重跑",
    })) return;
    setBusy(true);
    try {
      await sendIssueReviews(id);
      setNote("检视意见已提交,工作流已回退到「问题分析」,AI 正在按意见修订。");
      onReload();
    } catch (reason) {
      setNote(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(false);
    }
  }

  return <div className="flex flex-col gap-3">
    {detail.review_active && <div className="utility-note">
      上一轮检视意见已提交,AI 正在按意见修订分析报告;修订重新提交后这里恢复圈注。
    </div>}
    {canOperate && drafts.length === 0 && sent.length === 0 && <Empty className="border py-4.5">
      <EmptyTitle>还没有检视意见</EmptyTitle>
      <EmptyDescription>把鼠标停在上方报告要提意见的那一行,点行尾的 ✎ 记一条;
      攒多条后在这里一次提交——AI 会按意见修订报告,并从「问题分析」重新执行。</EmptyDescription>
    </Empty>}
    {note && <div className="utility-note">{note}</div>}
    {canOperate && drafts.length > 0 && <section>
      <h4 className={NOTE_HEAD}>待提交({drafts.length})</h4>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {drafts.map((item) => <IssueReviewItem key={item.id} item={item}
          check={checkOf(item.id)} onLocate={onLocate}
          onRemove={reviewEnabled ? () => void remove(item.id) : undefined} />)}
      </ul>
      <div className="mt-2 flex items-center gap-2.5">
        <Button type="button" size="sm"
          disabled={busy || !reviewEnabled || detail.status === "running"}
          title={!reviewEnabled
            ? "当前会话状态不能提交检视(转正继承/检视回合进行中/会话已结束)"
            : detail.status === "running"
              ? "AI 正在运行——等它停机或举卡等你时再提交"
              : "提交后工作流从问题分析重新执行"}
          onClick={() => void submit()}>
          {busy ? "提交中…" : `提交 ${drafts.length} 条意见并重跑分析`}
        </Button>
      </div>
    </section>}
    {/* 已提交清单(spec #259 story 23):纯读,登录只读访问者也可见。 */}
    {sent.length > 0 && <section>
      <h4 className={NOTE_HEAD}>已提交({sent.length})</h4>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {sent.map((item) => <IssueReviewItem key={item.id} item={item}
          check={checkOf(item.id)} onLocate={onLocate} />)}
      </ul>
    </section>}
  </div>;
}

/** 会话材料内容(免壳直渲,#123 拍平):DTS 单据 / 过程文档 / 工作区
 * 变更三个子视图(拉取日志视图已随 #267 退役,ADR-0026);面板壳
 * (头部页签条)已上收为会话层的一级标签——本组件只按 view 直渲
 * 对应内容,不再自带头部页签条。
 * 数据全部旁路:任何一块失败给空态。view 由会话层标签下发(右栏
 * "分析报告已产出"跳「分析报告」即 tab="doc")。
 * 查看模式(canOperate=false):快速修改编辑器写口不渲染,diff/单据/
 * 文档的只读浏览完整保留。 */
export function IssueMaterialsPane({ detail, busy, view, onNotifyAI, canOperate }: {
  detail: IssueDetail;
  busy: boolean;
  view: "dts" | "doc" | "changes";
  onNotifyAI: (text: string) => Promise<boolean>;
  /** 归属操作权(查看模式=false):材料内容只留只读浏览。 */
  canOperate: boolean;
}) {
  const [data, setData] = useState<IssueMaterials>();
  const [note, setNote] = useState("");
  const [allDiff, setAllDiff] = useState("");
  // 逐仓视图(#32):?repo= 服务端切片,每仓独立请求,不解析聚合里
  // 的分段标记;"" = 合并视图(缺省,用聚合 diff)。undefined = 读取中。
  const [repoDiff, setRepoDiff] = useState<string>();
  const [diffRepo, setDiffRepo] = useState("");
  // 快速修改:选中文件 → 编辑器;undefined 表示未选中。
  const [activeFile, setActiveFile] = useState<string>();
  const [content, setContent] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [dtsDetail, setDtsDetail] = useState<DtsTicketDetail>();

  async function load() {
    try {
      // 聚合 diff 一次拿全(合并视图用);逐仓切片由下面的 effect 按
      // 选仓独立取,两份数据互不依赖。现场已回收(磁盘治理)时 diff
      // 以 repo 为源必失败——只跳它,清单其余数据源照常加载。
      const materials = await getIssueMaterials(detail.id);
      setData(materials);
      if (!detail.repo_reclaimed_at) {
        const diff = await getIssueFileDiff(detail.id);
        setAllDiff(diff.diff);
      }
      // 手选的仓刷新后仍在变更清单里才保留;仓的改动清零了就回合并视图。
      setDiffRepo((current) => current
        && materials.changes.some((change) =>
          change.path.split(/[\\/]/)[0] === current)
        ? current : "");
      setNote("");
    } catch (reason) {
      setNote(String(reason instanceof Error ? reason.message : reason));
    }
  }

  useEffect(() => {
    // 现场已回收(磁盘治理):materials/diff 都以 repo 为源,取了必失败
    // ——不再发请求,页签上给如实降级文案。
    if (detail.repo_reclaimed_at) return;
    void load();
    // 会话状态一动(AI 可能改了工作区)就刷新;id 变化由父层换页签兜底。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.updated_at]);

  // 逐仓 diff 随选仓与会话刷新取(#32):服务端切片,与聚合各走各的
  // 请求。alive 防竞态:快速切仓时旧响应不得覆盖新仓的内容。
  useEffect(() => {
    if (!diffRepo) return;
    let alive = true;
    setRepoDiff(undefined);
    getIssueFileDiff(detail.id, undefined, diffRepo)
      .then((result) => {
        if (alive) setRepoDiff(result.diff);
      })
      .catch((reason) => {
        if (!alive) return;
        setNote(String(reason instanceof Error ? reason.message : reason));
        setRepoDiff("");
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffRepo, detail.updated_at]);

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

  // 可切的仓 = 变更清单路径首段(服务端 listMaterials 给每条变更加
  // <仓名>/ 前缀)。前端不猜仓清单;逐仓 diff 本体由 ?repo= 按需取。
  const diffRepos = useMemo(() => {
    const names: string[] = [];
    for (const change of changes) {
      const head = change.path.split(/[\\/]/)[0];
      if (head && !names.includes(head)) names.push(head);
    }
    return names;
  }, [changes]);
  const activeDiff = diffRepo ? repoDiff ?? "" : allDiff;

  // 免壳直渲(#123):没有面板壳,失败备注顶格示人,其余按 view 出内容。
  // 拉伸契约原住在 issue-workspace 家族(#231 退役),flex/自滚配方落为
  // 本根节点的工具类——三个材料页签根节点同构拉伸并自滚,长文档不撑破面板。
  return <div className="issue-materials grid content-start gap-3.5 min-h-0 flex-1 overflow-y-auto">
    {note && <div className="utility-note">{note}</div>}
      {view === "changes" && detail.repo_reclaimed_at && <>
        {/* 磁盘治理:终态单的代码现场已被清扫器回收(取消/归档后无
            消费方)——如实说明,不给一个必然失败的文件视图。 */}
        <div className="utility-note">
          代码现场已回收（磁盘纪律：取消/归档的问题单不再保留 repo 克隆，
          源码可随时重新拉取）。分析报告与过程对话不受影响，在各自页签
          查看；拉取的日志可在「元信息」页签整包下载。
        </div>
      </>}
      {view === "changes" && !detail.repo_reclaimed_at && <>
        {/* 编辑时机提醒只跟编辑器走:查看模式没有编辑器,也就不需要。 */}
        {canOperate && detail.status === "running" && <div className="utility-note">
          AI 正在运行:此刻的编辑可能被它覆盖,建议空闲/等待时再改。
        </div>}
        {diffRepos.length > 1 && <div className="mb-2 flex flex-wrap gap-1.5" role="group"
            aria-label="按仓查看工作区变更">
          <button type="button"
            className={cn("cursor-pointer rounded-full border px-3 py-1 text-[13px] font-semibold transition-colors",
              diffRepo === ""
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-line bg-surface text-muted-foreground hover:border-primary/40")}
            onClick={() => setDiffRepo("")}>全部合并</button>
          {diffRepos.map((name) => (
            <button type="button" key={name}
              className={cn("cursor-pointer rounded-full border px-3 py-1 text-[13px] font-semibold transition-colors",
                diffRepo === name
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-line bg-surface text-muted-foreground hover:border-primary/40")}
              onClick={() => setDiffRepo(name)}>{name}</button>
          ))}
        </div>}
        <div className="ws-doc">
          {activeDiff
            ? <GitDiff text={activeDiff} hideKey={detail.id} />
            : <div className="utility-note">
                {diffRepo
                  ? (repoDiff === undefined
                    ? "正在读取该仓变更…"
                    : "该仓当前没有可展示的改动。")
                  : "工作区当前没有改动。"}
              </div>}
        </div>
        {/* 快速修改(问题流唯一的人工写口):查看模式整块不渲染——
            选文件/保存/请 AI 复核都是写路径。人工修改记录(账)照常示人。 */}
        {canOperate && <div className="issue-materials-editor mt-1 grid gap-2">
          <div className="flex flex-wrap items-center gap-2.5">
            <strong className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-text-strong">快速修改</strong>
            <Select value={activeFile ?? ""}
              items={[{ value: "", label: "选择要修改的文件…" },
                ...changes.map((change) => ({ value: change.path, label: change.path }))]}
              onValueChange={(value) => {
                const path = value ?? "";
                if (path) void editFile(path);
              }}>
              <SelectTrigger className="min-w-44 max-w-72" aria-label="选择要修改的文件">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="">选择要修改的文件…</SelectItem>
                  {changes.map((change) => <SelectItem key={change.path}
                    value={change.path}>{change.path}</SelectItem>)}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button type="button" size="sm" disabled={saving
              || !activeFile || content === undefined} onClick={save}>
              {saving ? "保存中…" : "保存修改"}
            </Button>
            <Button type="button" variant="outline" size="sm"
              disabled={busy || saving || !activeFile}
              title="把这次人工改动告知 AI,请它复核后继续"
              onClick={() => activeFile && onNotifyAI(
                `[人工修改] 我直接改了 ${activeFile},请复核这份改动,与你的方案不一致时先说明再继续。`)}>
              请 AI 复核
            </Button>
          </div>
          {activeFile && (content !== undefined
            ? <Textarea className="min-h-[260px] max-h-[480px] resize-y bg-surface font-mono text-[13px]" value={content} spellCheck={false}
                onChange={(event) => setContent(event.target.value)} />
            : <p className="m-0 mt-1 text-[13px] text-faint">读取中…</p>)}
        </div>}
      <section className="grid gap-2 rounded-[10px] border border-line bg-surface-muted px-3.5 py-3">
        <h4 className={NOTE_HEAD}>人工修改记录({data?.manual_edits.length ?? 0})</h4>
        {data?.manual_edits.length === 0 && <Empty className="py-2 text-left">
          还没有人工改动——从上方选择文件编辑保存后会记在这里。
        </Empty>}
        <ul className="m-0 grid list-none gap-1 p-0">
          {data?.manual_edits.slice().reverse().map((edit, index) => <li
            key={`${edit.ts}-${index}`} className="grid grid-cols-[auto_1fr] items-baseline gap-2.5 text-xs text-faint">
            <span>{new Date(edit.ts).toLocaleTimeString()}</span>
            <span className="truncate font-mono text-muted-foreground">{edit.path}</span>
          </li>)}
        </ul>
      </section>
    </>}
    {view === "dts" && <div className="ws-doc">
      {dtsDetail ? <>
        <p className="m-0 flex flex-wrap items-baseline gap-3">
          <strong>{dtsDetail.title || "(无标题)"}</strong>
          {dtsDetail.severity && <span className="text-xs text-muted-foreground">级别:{dtsDetail.severity}</span>}
          {dtsDetail.version && <span className="text-xs text-muted-foreground">版本:{dtsDetail.version}</span>}
          {dtsDetail.submitter && <span className="text-xs text-muted-foreground">提单:{dtsDetail.submitter}</span>}
          {dtsDetail.url && <a className="text-primary" href={dtsDetail.url} target="_blank" rel="noreferrer">原始单</a>}
        </p>
        <div className="issue-dts-detail-html"
          dangerouslySetInnerHTML={{
            __html: prepareDtsHtml(dtsDetail.description || dtsDetail.content)
              || "(无描述)",
          }}
        />
      </> : <div className="utility-note">正在读取单据详情…</div>}
    </div>}
    {view === "doc" && <>
      {/* 分析报告(#260 收敛:单报告直渲,检视内联)按 updated_at
          缓存:报告可能被 AI 续写,状态一动就该重读。 */}
      <IssueAnalysisReport detail={detail} canOperate={canOperate} />
    </>}
  </div>;
}
