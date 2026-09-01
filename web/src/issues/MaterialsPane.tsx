/**
 * 材料域:会话材料页签(DTS 单据 / 过程文档 / 工作区变更含快速修改 /
 * 拉取日志)。
 *
 * 从 IssueBoard.tsx 原文搬移(spec #2 按域拆分,纯搬移零行为变化):
 * 结构照搬任务工作台交付材料页(ws-pane-head + ws-source-switch +
 * ws-doc),diff 用同一把 GitDiff 渲染。合并视图直接渲染聚合 diff
 * (服务端自带「===== 仓库 =====」分段标记,GitDiff 按元信息行呈现);
 * 逐仓视图走 ?repo= 服务端切片(#32),每仓独立请求,不再前端解析
 * 分段标记。过程文档子视图(IssueProcessDocs,原结论文档升级:
 * 多页签 = 分析报告 + 过程问答 + Agent 落的其他 .md,页签样式同任务
 * 侧 ws-tabs)只有材料页签渲染,随本文件走。
 * 快速修改是问题流唯一的人工写口——只改 repo/ 内已有文件,保存入
 * 人工台账,"请 AI 复核"走现有插话/续聊通道。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  extractIssueLog,
  addIssueReview,
  dropIssueReview,
  getDtsTicketDetail,
  getIssueDocument,
  getIssueDocuments,
  getIssueDialogue,
  getIssueFileDiff,
  getIssueMaterialLog,
  getIssueMaterials,
  getIssueReviews,
  getIssueWorkspaceFile,
  saveIssueWorkspaceFile,
  sendIssueReviews,
  type DtsTicketDetail,
  type IssueDetail,
  type IssueDialogueTurn,
  type IssueDocMeta,
  type IssueLogEntry,
  type IssueMaterials,
  type IssueReview,
  type IssueReviewCheck,
} from "../api";
import { Annotatable } from "../Annotatable";
import { Markdown } from "../markdown";
import { GitDiff } from "../GitDiff";
import { confirmDialog } from "../ConfirmDialog";
import { formatLocalDateTime } from "../time";
import { prepareDtsHtml } from "./dtsHtml";

/** 分析报告的文件名(与服务端 documents.ts 的常量镜像:前端不拼路径,
 * 只用它认页签)。 */
const ANALYSIS_DOC = "issue-analysis.md";
/** 过程问答的页签键(不是文件名,.md 文件撞不到它)。 */
const DIALOGUE_TAB = "dialogue";
/** 检视面板的页签键(同上;ADR-0007)。 */
const REVIEW_TAB = "review";

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---- 拉取日志树(#47):扁平清单按路径组树,目录展开/收起,压缩包行带解压 ----

interface LogTreeNode {
  name: string;
  /** local-logs 相对路径(/ 分隔,与服务端清单同键)。 */
  path: string;
  type: "file" | "dir";
  size: number;
  archive: boolean;
  children: LogTreeNode[];
}

/** 扁平清单 → 目录树:服务端新→旧序就是兄弟序,组树不重排,保住
 * "新东西在上"的直觉;文件先于其目录条目出现时按需补目录节点。 */
function buildLogTree(entries: IssueLogEntry[]): LogTreeNode[] {
  const roots: LogTreeNode[] = [];
  const dirs = new Map<string, LogTreeNode>();
  const childrenOf = (dirPath: string): LogTreeNode[] => {
    if (!dirPath) return roots;
    const hit = dirs.get(dirPath);
    if (hit) return hit.children;
    const segments = dirPath.split("/");
    const node: LogTreeNode = {
      name: segments.at(-1) ?? dirPath,
      path: dirPath,
      type: "dir",
      size: 0,
      archive: false,
      children: [],
    };
    childrenOf(segments.slice(0, -1).join("/")).push(node);
    dirs.set(dirPath, node);
    return node.children;
  };
  for (const entry of entries) {
    const segments = entry.path.split("/");
    if (entry.type === "dir") {
      childrenOf(entry.path);
      continue;
    }
    childrenOf(segments.slice(0, -1).join("/")).push({
      name: segments.at(-1) ?? entry.path,
      path: entry.path,
      type: "file",
      size: entry.size,
      archive: entry.archive,
      children: [],
    });
  }
  return roots;
}

/** 把一条路径连同全部祖先目录加进展开集(解压后要一眼看到新目录)。 */
function expandWithAncestors(prev: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(prev);
  const segments = path.split("/");
  for (let i = 1; i <= segments.length; i++) {
    next.add(segments.slice(0, i).join("/"));
  }
  return next;
}

/** 树行渲染:目录行点击收/展,文件行点击进查看器,压缩包行多一枚解压
 * 按钮。缩进按深度手排(树是自绘的,不引第三方依赖)。 */
function LogTreeRows({ nodes, depth, expanded, activeLog, extracting, onToggle, onOpen, onExtract }: {
  nodes: LogTreeNode[];
  depth: number;
  expanded: ReadonlySet<string>;
  activeLog?: string;
  extracting: string;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onExtract: (path: string) => void;
}) {
  return <>
    {nodes.map((node) => node.type === "dir"
      ? <Fragment key={node.path}>
          <button type="button" role="listitem"
            className="issue-materials-file issue-log-dir"
            style={{ paddingLeft: 10 + depth * 18 }}
            aria-expanded={expanded.has(node.path)}
            onClick={() => onToggle(node.path)}>
            <span className="p">{expanded.has(node.path) ? "▾" : "▸"} {node.name}/</span>
          </button>
          {expanded.has(node.path) && <LogTreeRows
            nodes={node.children} depth={depth + 1} expanded={expanded}
            activeLog={activeLog} extracting={extracting}
            onToggle={onToggle} onOpen={onOpen} onExtract={onExtract} />}
        </Fragment>
      : <div key={node.path} className="issue-log-row"
          style={{ paddingLeft: 10 + depth * 18 }}>
          <button type="button" role="listitem"
            className={`issue-materials-file${activeLog === node.path ? " on" : ""}`}
            onClick={() => onOpen(node.path)}>
            <span className="p">{node.name}</span>
            <span className="num">{sizeText(node.size)}</span>
          </button>
          {node.archive && <button type="button" className="issue-log-extract"
            disabled={extracting !== ""}
            title={`解压到同目录 ${node.name
              .replace(/\.(tar\.gz|tar\.bz2|tgz|tar|zip)$/i, "")}-extracted/`}
            onClick={() => onExtract(node.path)}>
            {extracting === node.path ? "解压中…" : "解压"}
          </button>}
        </div>)}
  </>;
}

/** 过程问答(对话气泡):复盘阅读面(ADR-0008 口径)——问答卡、用户
 * 决策(卡答与闸答,闸答带合成的问句)、用户主动输入、检视意见按
 * 时间序陈列;agent 的过程性发言不进。现场页签仍是原始事件直播,
 * 两不替代。 */
function IssueDialogue({ turns, truncated }: {
  turns: IssueDialogueTurn[];
  truncated: boolean;
}) {
  if (turns.length === 0) {
    return <div className="issue-doc-empty">
      <strong>还没有问答</strong>
      <p>会话开始后,Agent 的提问卡、你的答复与检视意见会按时间序出现在这里。</p>
    </div>;
  }
  return <div className="issue-dialogue">
    {truncated && <div className="utility-note">回合较多,只显示最近的 500 条。</div>}
    {turns.map((turn, index) => <IssueDialogueTurnView key={index} turn={turn} />)}
  </div>;
}

function IssueDialogueTurnView({ turn }: { turn: IssueDialogueTurn }) {
  const time = turn.ts
    ? formatLocalDateTime(turn.ts, { seconds: true }) : "";
  if (turn.kind === "card") {
    return <div className="issue-dialogue-turn card">
      <span className="issue-dialogue-meta"><b>Agent 问答卡</b>
        <time>{time}</time></span>
      <div className="issue-dialogue-bubble">
        {(turn.questions ?? []).map((question, index) => <div
          key={index} className="issue-dialogue-q">
          <p>{question.question}</p>
          {question.options.length > 0 && <ul className="issue-dialogue-opts">
            {question.options.map((option, index) => <li key={index}>{option}</li>)}
          </ul>}
        </div>)}
      </div>
    </div>;
  }
  if (turn.kind === "decision") {
    return <div className="issue-dialogue-turn decision">
      <span className="issue-dialogue-meta"><b>用户决策</b>
        <time>{time}</time></span>
      <div className="issue-dialogue-bubble">
        {/* 平台闸的问句快照(闸答完即从状态里消失,只能随事件走);
            Agent 卡的问在前一张问答卡里,不重复。 */}
        {(turn.questions ?? []).map((question, index) => <div
          key={index} className="issue-dialogue-q">
          <p>{question.question}</p>
          {question.options.length > 0 && <ul className="issue-dialogue-opts">
            {question.options.map((option, index) => <li key={index}>{option}</li>)}
          </ul>}
        </div>)}
        {turn.decision || "(无文字答复)"}
        {turn.notes && <span className="issue-dialogue-notes">补充:{turn.notes}</span>}
      </div>
    </div>;
  }
  if (turn.kind === "review") {
    return <div className="issue-dialogue-turn review">
      <span className="issue-dialogue-meta"><b>检视意见({turn.count ?? 0} 条)</b>
        <time>{time}</time></span>
      <div className="issue-dialogue-bubble issue-dialogue-review">
        <pre>{turn.text}</pre>
      </div>
    </div>;
  }
  return <div className="issue-dialogue-turn user">
    <span className="issue-dialogue-meta">
      <b>用户{turn.via === "interrupt" ? "(插话)" : ""}</b>
      <time>{time}</time>
    </span>
    <div className="issue-dialogue-bubble">{turn.text}</div>
  </div>;
}

/** 过程文档子视图:多页签(分析报告固定首页 + 过程问答 + 检视 +
 * Agent 落的其他 .md)。激活页签才取内容;状态一动(updated_at 变化)
 * 自动重读,让 AI 续写的内容能贴着节奏刷新。
 * 检视(ADR-0007):分析报告按块悬停圈注意见(交互与需求流批注同一套),
 * 「检视」页签攒草稿、一次提交触发整体回退重跑。 */
function IssueProcessDocs({ detail }: { detail: IssueDetail }) {
  const id = detail.id;
  const [docs, setDocs] = useState<IssueDocMeta[]>([]);
  const [active, setActive] = useState(ANALYSIS_DOC);
  const [content, setContent] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [turns, setTurns] = useState<IssueDialogueTurn[]>([]);
  const [turnsTruncated, setTurnsTruncated] = useState(false);
  // 检视账本(轻量):随会话动态重读——锚点检测按当前报告现算,
  // AI 一改报告,徽标就贴着 updated_at 的节奏刷新。
  const [reviews, setReviews] = useState<IssueReview[]>([]);
  const [checks, setChecks] = useState<IssueReviewCheck[]>([]);
  // 已加载基准 = 会话动态 + 激活页签:两者任一变化就重取;只在响应到手
  // 后记账,半路失败下次仍会重试。
  const refreshKey = `${detail.updated_at}|${active}`;
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

  async function loadActive() {
    setLoading(true);
    try {
      if (active === DIALOGUE_TAB) {
        const result = await getIssueDialogue(id);
        setTurns(result.turns ?? []);
        setTurnsTruncated(result.truncated === true);
        setNote("");
      } else if (active === REVIEW_TAB) {
        // 检视面板的数据由 loadReviews 随会话动态取,这里只清残留空态。
        setNote("");
        setContent("");
      } else {
        const result = await getIssueDocument(id, active);
        if (result.unavailable) {
          setNote(active === ANALYSIS_DOC
            ? "AI 研究中会把结论写入 issue-analysis.md,生成后这里直接可读。"
            : result.unavailable);
          setContent("");
        } else {
          setNote("");
          setContent(result.content ?? "");
          setTruncated(result.truncated === true);
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.updated_at]);
  useEffect(() => {
    if (loadedKey !== refreshKey) void loadActive();
    // loadedKey 有意不在依赖里:刷新按钮要的是无视缓存的重取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  /** 检视面板 → 分析报告的锚点定位:切页签、等渲染、滚动 + 闪烁。 */
  async function locate(line: number) {
    setActive(ANALYSIS_DOC);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((done) => setTimeout(done, 150));
      const node = document.querySelector<HTMLElement>(
        `.issue-doc-body [data-l="${line}"]`);
      if (node) {
        node.scrollIntoView({ block: "center" });
        node.classList.add("annot-flash");
        window.setTimeout(() => node.classList.remove("annot-flash"), 1700);
        return;
      }
    }
  }

  // 检视入口的会话级门槛(与服务端 requireReviewable 同口径的显示面):
  // 固定流程、未终态、无转正继承段(转正继承的报告不可检视)、检视
  // 回合未在进行中。后端仍逐项把门,这里只管把按钮放对位置。
  const reviewEnabled = detail.mode === "fixed"
    && !["archived", "canceled", "failed"].includes(detail.status)
    && !detail.stage_states?.some((state) => state === "inherited")
    && detail.review_active !== true;
  const draftCount = reviews.filter((item) => item.status === "draft").length;

  const analysisMeta = docs.find((doc) => doc.name === ANALYSIS_DOC);
  const tabs = [
    { key: ANALYSIS_DOC, label: "分析报告",
      hint: analysisMeta ? sizeText(analysisMeta.bytes) : "未生成" },
    { key: DIALOGUE_TAB, label: "过程问答",
      hint: turns.length ? `${turns.length} 回合` : "" },
    ...(detail.mode === "fixed"
      ? [{ key: REVIEW_TAB, label: "检视",
        hint: draftCount ? `${draftCount} 条待提交` : "" }]
      : []),
    ...docs.filter((doc) => doc.name !== ANALYSIS_DOC)
      .map((doc) => ({ key: doc.name, label: doc.label, hint: sizeText(doc.bytes) })),
  ];

  return <div className={`issue-thread issue-doc${fullscreen ? " is-fullscreen" : ""}`}>
    <div className="issue-doc-view-actions">
      <span>{fullscreen ? "全屏阅读过程文档" : ""}</span>
      <button type="button" className="primary"
        disabled={!docs.length || downloading}
        title={docs.length
          ? `下载全部 ${docs.length} 份 Markdown 过程文档(完整原文件)`
          : "还没有可下载的过程文档"}
        onClick={() => void downloadDocuments()}>
        {downloading ? "打包中…" : "打包下载"}
      </button>
      <button type="button" onClick={() => setFullscreen((current) => !current)}>
        {fullscreen ? "退出全屏" : "全屏查看"}
      </button>
    </div>
    {downloadError && <div className="utility-note" role="alert">
      打包下载失败：{downloadError}
    </div>}
    {tabs.length > 1 && <div className="ws-tabs" role="tablist"
        aria-label="过程文档页签">
      {tabs.map((tab) => (
        <button key={tab.key} role="tab" aria-selected={active === tab.key}
          className={"ws-tab" + (active === tab.key ? " on" : "")}
          onClick={() => setActive(tab.key)}>
          <span>{tab.label}</span>{tab.hint && <i>{tab.hint}</i>}
        </button>
      ))}
    </div>}
    {loading && <p className="issue-thread-empty">正在读取…</p>}
    {!loading && note && <div className="issue-doc-empty">
      <strong>{active === ANALYSIS_DOC ? "还没有分析报告" : "读不到这份文档"}</strong>
      <p>{note}</p>
    </div>}
    {!loading && !note && active === DIALOGUE_TAB
      && <IssueDialogue turns={turns} truncated={turnsTruncated} />}
    {!loading && !note && active === REVIEW_TAB
      && <IssueReviewPanel detail={detail} reviews={reviews} checks={checks}
        reviewEnabled={reviewEnabled}
        onReload={() => void loadReviews()} onLocate={(line) => void locate(line)} />}
    {!loading && !note && active !== DIALOGUE_TAB && active !== REVIEW_TAB
      && content && <>
      <div className="issue-doc-toolbar">
        <span>研究现场落盘的 markdown · 即写即读{truncated ? " · 内容超长已截断" : ""}</span>
        <button type="button" onClick={() => void loadActive()}>刷新</button>
      </div>
      <article className="issue-doc-body">
        {active === ANALYSIS_DOC && reviewEnabled
          ? <Annotatable taskId={id} artifact={ANALYSIS_DOC}
              fallbackFile={ANALYSIS_DOC} kind="doc" items={reviews}
              onAdded={() => void loadReviews()}
              addDraft={async ({ line, anchor, note: text }) => {
                try {
                  await addIssueReview(id, { line, anchor, note: text });
                  void loadReviews();
                  return {};
                } catch (reason) {
                  return {
                    error: String(reason instanceof Error ? reason.message : reason),
                  };
                }
              }}>
              <Markdown text={content} />
            </Annotatable>
          : <Markdown text={content} />}
      </article>
    </>}
  </div>;
}

/** 锚点检测徽标(ADR-0007 Q13):gone = 已被改动(唯一判据),原文
 * 还在 = 黄灯提醒"这条可能还没被吸收"。人工改动引发的失配同理可见。 */
function IssueReviewBadge({ check }: { check?: IssueReviewCheck }) {
  if (!check) return null;
  if (check.state === "gone") {
    return <span className="issue-review-badge gone">已被改动·请你确认</span>;
  }
  if (check.state === "moved") {
    return <span className="issue-review-badge warn"
      title="原文还在,只是行号漂移">已移至第 {check.line} 行</span>;
  }
  if (check.state === "ambiguous") {
    return <span className="issue-review-badge warn"
      title="原文多处命中,点行号自行核对">多处命中</span>;
  }
  return <span className="issue-review-badge hit"
    title="这条意见对应的原文还在报告里——可能还没被吸收,点行号核对">
    原文仍在</span>;
}

function IssueReviewItem({ item, check, onLocate, onRemove }: {
  item: IssueReview;
  check?: IssueReviewCheck;
  onLocate: (line: number) => void;
  onRemove?: () => void;
}) {
  return <li className="issue-review-item">
    <div className="issue-review-item-head">
      <button type="button" className="link"
        onClick={() => onLocate(item.line)}>第 {item.line} 行</button>
      {item.status === "sent" && <IssueReviewBadge check={check} />}
      <time>{formatLocalDateTime(item.created_at, { seconds: true })}</time>
      {onRemove && <button type="button" className="ghost"
        onClick={onRemove}>移除</button>}
    </div>
    <blockquote className="issue-review-anchor">针对 {item.anchor}</blockquote>
    <p className="issue-review-note">{item.note}</p>
  </li>;
}

/** 检视面板:草稿攒批、一次提交触发整体回退(轻量确认列明后果);
 * 已提交的意见带锚点徽标,服务于下一轮对照。 */
function IssueReviewPanel({ detail, reviews, checks, reviewEnabled, onReload, onLocate }: {
  detail: IssueDetail;
  reviews: IssueReview[];
  checks: IssueReviewCheck[];
  reviewEnabled: boolean;
  onReload: () => void;
  onLocate: (line: number) => void;
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

  return <div className="issue-review">
    {detail.review_active && <div className="utility-note">
      上一轮检视意见已提交,AI 正在按意见修订分析报告;修订重新提交后这里恢复圈注。
    </div>}
    {drafts.length === 0 && sent.length === 0 && <div className="issue-doc-empty">
      <strong>还没有检视意见</strong>
      <p>到「分析报告」页签,把鼠标停在要提意见的那一行,点行尾的 ✎ 记一条;
      攒多条后在这里一次提交——AI 会按意见修订报告,并从「问题分析」重新执行。</p>
    </div>}
    {note && <div className="utility-note">{note}</div>}
    {drafts.length > 0 && <section className="issue-review-group">
      <h4>待提交({drafts.length})</h4>
      <ul className="issue-review-list">
        {drafts.map((item) => <IssueReviewItem key={item.id} item={item}
          check={checkOf(item.id)} onLocate={onLocate}
          onRemove={reviewEnabled ? () => void remove(item.id) : undefined} />)}
      </ul>
      <div className="issue-review-actions">
        <button type="button" className="primary"
          disabled={busy || !reviewEnabled || detail.status === "running"}
          title={!reviewEnabled
            ? "当前会话状态不能提交检视(转正继承/检视回合进行中/会话已结束)"
            : detail.status === "running"
              ? "AI 正在运行——等它停机或举卡等你时再提交"
              : "提交后工作流从问题分析重新执行"}
          onClick={() => void submit()}>
          {busy ? "提交中…" : `提交 ${drafts.length} 条意见并重跑分析`}
        </button>
      </div>
    </section>}
    {sent.length > 0 && <section className="issue-review-group">
      <h4>已提交({sent.length})</h4>
      <ul className="issue-review-list">
        {sent.map((item) => <IssueReviewItem key={item.id} item={item}
          check={checkOf(item.id)} onLocate={onLocate} />)}
      </ul>
    </section>}
  </div>;
}

/** 会话材料(材料页签):DTS 单据 / 过程文档 / 工作区变更 / 拉取日志。
 * 数据全部旁路:任何一块失败给空态。
 * 子视图状态在会话层(右栏"分析报告已产出"要能一步跳进来)。 */
export function IssueMaterialsPane({ detail, busy, view, onView, onNotifyAI }: {
  detail: IssueDetail;
  busy: boolean;
  view: "dts" | "changes" | "logs" | "doc";
  onView: (view: "dts" | "changes" | "logs" | "doc") => void;
  onNotifyAI: (text: string) => Promise<boolean>;
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
  const [logView, setLogView] = useState<{ path: string; content: string }>();
  // 拉取日志树(#47):展开的目录集合 + 解压中的包路径(busy 态)。
  // 缺省展开第一层只补一次(首次清单到手时),此后尊重用户的收/展动作,
  // 刷新不强行重开用户收起的目录。
  const [expandedDirs, setExpandedDirs] = useState<ReadonlySet<string>>(new Set());
  const [extracting, setExtracting] = useState("");
  const defaultExpandedDone = useRef(false);
  // 过程文档清单(开关角标用):随会话动态轻量重读(只扫顶层 .md)。
  const [docCount, setDocCount] = useState(0);

  async function load() {
    try {
      // 聚合 diff 一次拿全(合并视图用);逐仓切片由下面的 effect 按
      // 选仓独立取,两份数据互不依赖。
      const [materials, diff] = await Promise.all([
        getIssueMaterials(detail.id),
        getIssueFileDiff(detail.id),
      ]);
      setData(materials);
      setAllDiff(diff.diff);
      // 缺省展开第一层(顶层目录):只在首次清单到手时补,之后不动。
      if (!defaultExpandedDone.current) {
        defaultExpandedDone.current = true;
        setExpandedDirs(new Set(materials.logs.entries
          .filter((entry) => entry.type === "dir" && !entry.path.includes("/"))
          .map((entry) => entry.path)));
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
    // 清单独立取(旁路):失败只是角标停在旧值,不拖累上面的主数据。
    try {
      const docs = await getIssueDocuments(detail.id);
      setDocCount((docs.documents ?? []).length);
    } catch {
      // 角标口径照旧,fail-open。
    }
  }

  useEffect(() => {
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

  async function openLog(path: string) {
    try {
      const log = await getIssueMaterialLog(detail.id, path);
      setLogView({ path, content: log.content });
    } catch (reason) {
      setNote(String(reason instanceof Error ? reason.message : reason));
    }
  }

  /** 解压压缩包(#47):成功后刷新清单并展开新目录(连同祖先),让人
   * 一步看到包里内容;重复解压服务端幂等,文案如实说"复用"。 */
  async function extractArchive(path: string) {
    if (extracting) return;
    setExtracting(path);
    setNote("");
    try {
      const result = await extractIssueLog(detail.id, path);
      await load();
      setExpandedDirs((prev) => expandWithAncestors(prev, result.path));
      setNote(result.reused
        ? `${result.path} 已经解压过,直接复用,没有重解。`
        : `解压完成:${result.path}`);
    } catch (reason) {
      setNote(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setExtracting("");
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
  const logTree = useMemo(
    () => buildLogTree(data?.logs.entries ?? []), [data]);

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

  return <div className="issue-materials">
    <div className="ws-pane-head">
      <div><span>材料清单</span><strong>会话材料</strong></div>
      <div className="ws-source-switch" aria-label="材料类型">
        <button className={view === "dts" ? "on" : ""}
          disabled={!data?.ticket} onClick={() => onView("dts")}>
          <span>DTS 单据</span><i>{data?.ticket ? "1" : "0"}</i>
        </button>
        <button className={view === "doc" ? "on" : ""}
          onClick={() => onView("doc")}>
          <span>过程文档</span><i>{docCount + 1}</i>
        </button>
        <button className={view === "changes" ? "on" : ""}
          onClick={() => onView("changes")}>
          <span>工作区变更</span><i>{changes.length}</i>
        </button>
        <button className={view === "logs" ? "on" : ""}
          onClick={() => onView("logs")}>
          <span>拉取日志</span><i>{data?.logs.entries.length ?? 0}</i>
        </button>
      </div>
    </div>
    {note && <div className="utility-note">{note}</div>}
      {view === "changes" && <>
        {detail.status === "running" && <div className="utility-note">
          AI 正在运行:此刻的编辑可能被它覆盖,建议空闲/等待时再改。
        </div>}
        {diffRepos.length > 1 && <div className="issue-diff-repo-switch" role="group"
            aria-label="按仓查看工作区变更">
          <button type="button" className={diffRepo === "" ? "on" : ""}
            onClick={() => setDiffRepo("")}>全部合并</button>
          {diffRepos.map((name) => (
            <button type="button" key={name}
              className={diffRepo === name ? "on" : ""}
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
            __html: prepareDtsHtml(dtsDetail.description || dtsDetail.content)
              || "(无描述)",
          }}
        />
      </> : <div className="utility-note">正在读取单据详情…</div>}
    </div>}
    {view === "doc" && <>
      {/* 过程文档(分析报告 + 过程问答 + 检视 + 动态文档)按 updated_at
          缓存:文档可能被 AI 续写,状态一动就该重读。 */}
      <IssueProcessDocs detail={detail} />
    </>}
    {view === "logs" && <div className="ws-doc">
      {data && data.logs.entries.length === 0 && <div className="utility-note">
        本会话还没有拉取过日志。
      </div>}
      {data?.logs.truncated && <div className="utility-note">
        日志条目超过上限(2000),清单已截断,可能不完整。
      </div>}
      <div className="issue-materials-files" role="list">
        <LogTreeRows nodes={logTree} depth={0} expanded={expandedDirs}
          activeLog={logView?.path} extracting={extracting}
          onToggle={(path) => setExpandedDirs((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path); else next.add(path);
            return next;
          })}
          onOpen={(path) => void openLog(path)}
          onExtract={(path) => void extractArchive(path)} />
      </div>
      {logView && <>
        <div className="issue-doc-toolbar">
          <span>{logView.path}</span>
          <button type="button" onClick={() => void openLog(logView.path)}>刷新</button>
        </div>
        <pre className="issue-materials-diff">{logView.content}</pre>
      </>}
    </div>}
  </div>;
}
