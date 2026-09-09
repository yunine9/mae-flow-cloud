/**
 * 右栏协作对话框(#124):问题域「与 Agent 协作」的轻量会话流。
 *
 * ADR-0018:任务侧 ConversationStream 的形状是两域共同目标,但那个组件
 * 与任务域的批注账、线程视图、人员名录、开发助手耦合过深;问题域协作流
 * 只有六类成员(session/turn/card/decision/steer/review/receipts),且
 * 本票全部只读回放,所以在 issues 域落一个轻量适配器:消息气泡复用
 * conv-* 与 ws-stream 全套类(样式与任务侧同一份;长文量高折叠、步骤
 * 查看入口、流内筛选 2026-09-08 起也对齐同款),渲染纪律与任务侧一致
 * ——所有事实来自聚合接口,这里不推断状态,只排版。
 *
 * 数据:GET /issues/:id/conversation(getIssueConversation),会话视图
 * 可见时每 4 秒轮询一次(任务侧同款节奏),换会话重置(序号作废半拍
 * 旧响应);贴底跟随 + 「有新消息」行为照搬任务侧。
 *
 * 卡座与 dock(#125,ADR-0018 决策三「举卡入流」的通用模式,#126 照此
 * 铺其余三类卡):
 * - 卡座挂载点:当前等待卡永远钉在消息流末尾的 Agent 气泡内
 *   (conv-card current,任务侧同款),不随时间线被新条目埋掉;流内
 *   同卡(同 waiting_id)的投影副本按 id 去重防双卡,其余历史卡
 *   (含更早已决定/作废的 waiting 投影)照常只读回放。卡上只留
 *   题面/表单/选项。
 * - dock 目标:输入区在等卡分支预留 ws-reply-dock 容器(dockRef 回调
 *   把节点交给会话视图,会话视图把它作为 footerTarget 发给当前卡),
 *   卡的提交区(附言+提交/拒绝按钮)经 createPortal 挂进来——附言与
 *   决定一并提交,表单状态仍归卡组件(见 IssueDecisionCard)。
 * - 查看模式(canOperate=false):卡以只读事实面(IssueWaitingFacts)
 *   钉在流末尾,不出 dock,输入区只读。
 * - 无卡:输入区恢复普通输入(运行中=插话/idle=续聊),dock 容器不渲染。
 *
 * 输入区按会话状态分派(轻量仿制任务侧 ws-composer 的结构与类名):
 * 运行中=插话(steerIssue,不打断当前步骤)、空闲=续聊(replyIssue);
 * 人工接管中(2026-09-07 走查拍板,takeover=true)=人工驾驶:记录进
 * 现场账(addIssueTakeoverNote,只记账不投喂)或交还给 AI
 * (resumeIssueTakeover,以当前输入作交还说明);等卡/挂起/未启动/
 * 终态给原因说明,查看者(canOperate=false)只见只读提示——写口语义
 * 与拆栏前(#126 及更早)的 canOperate 门零变化。
 *
 * 挂起转正卡(#127):右栏 NEXT ACTION 侧栏拆除后,挂起
 * 会话的关联转正入口由会话视图组装(IssueAssociateCard / 查看模式
 * IssueAssociateFacts)经 suspendedCard 槽下传,渲染在「与 Agent 协作」
 * 头之下、流之上——协作流区顶部,不随流滚动。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  getIssueConversation,
  type IssueConversationItem,
  type IssueConversationSteps,
  type IssueStatus,
} from "../api";
import { atBottom } from "../follow";
import { conversationCardTitle } from "../ConversationStream";
import { ClampedText } from "../ClampedText";
import { Markdown } from "../markdown";
import { formatLocalClock, formatLocalDate, formatLocalDateTime } from "../time";
import { startVisiblePolling } from "../visiblePolling";

/** 一屏先渲最近这些条;更早的按需展开(与任务侧同款节奏)。 */
const INITIAL_LIMIT = 50;

function initial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? [...trimmed][0]!.toUpperCase() : "?";
}

/** 回合步骤一行话(口径与任务侧一致):改了什么、跑了什么,共几步。 */
function stepsLine(steps: IssueConversationSteps): string {
  const parts: string[] = [];
  for (const entry of steps.sample) {
    parts.push(entry.kind === "edit" ? `编辑 ${entry.subject}`
      : entry.kind === "bash" ? `运行 ${entry.subject}` : `派子任务 ${entry.subject}`);
  }
  const total = steps.calls + steps.agents;
  if (!parts.length && steps.reads) parts.push(`读取 ${steps.reads} 个文件`);
  const tail = `共 ${total} 步${steps.errors ? ` · ${steps.errors} 步失败` : ""}`;
  return parts.length ? `${parts.join(" · ")} · ${tail}` : tail;
}

/** 长交接语收折——直接用任务侧同款量高组件(ClampedText),折叠观感
 * 与任务侧一致;原按字数的简化版(2026-09-08 对齐拍板)已删。 */

export function IssueConversationStream({
  issueId,
  status,
  waiting,
  waitingId,
  waitingTs,
  canOperate,
  busy,
  owner,
  viewerUsername,
  takeover,
  currentCard,
  suspendedCard,
  dockRef,
  onSteer,
  onReply,
  onTakeover,
  onTakeoverNote,
  onResumeTakeover,
  onOpenEvents,
}: {
  issueId: string;
  /** 会话状态:输入区的插话/续聊/禁用分派只看它和 waiting。 */
  status: IssueStatus;
  /** 当前有等归属人的卡:真卡钉在流末尾的 Agent 气泡内(#125 卡座)。 */
  waiting: boolean;
  /** 当前卡的 waiting_id(卡座去重键):流内同卡投影按它摘除,防双卡。 */
  waitingId?: string;
  /** 当前卡的举起时刻(流内投影还没轮询到时给卡座气泡的时钟兜底)。 */
  waitingTs?: string;
  /** 归属操作权(查看模式=false):false 时输入区只读,流完整可见。 */
  canOperate: boolean;
  busy: boolean;
  /** 会话归属人名:裁决/检视的署名与查看模式文案用。 */
  owner: string;
  /** 当前登录用户名(缺席=auth 关闭的演示形态,按归属人渲染)。 */
  viewerUsername?: string;
  /** 人工接管中(2026-09-07 走查拍板):真=AI 已暂停,输入区换人工
   * 驾驶模式(记录/交还);分派优先级在插话/续聊之前。 */
  takeover: boolean;
  /** 当前待处理卡(IssueDecisionCard / 查看模式 IssueWaitingFacts),
   * 会话视图组装;卡座把它钉在流末尾的 Agent 气泡内(#125)。 */
  currentCard?: ReactNode;
  /** 挂起转正卡(#127):协作流区顶部(协作头之下、流之上)渲染,
   * 会话视图按 status === "suspended" 组装——归属人两段式转正卡,
   * 查看模式只读说明。 */
  suspendedCard?: ReactNode;
  /** 输入区 dock 容器的节点回调(#125):转交会话视图存为 footerTarget,
   * 当前卡的提交区经 portal 挂进 dock。 */
  dockRef?: (node: HTMLDivElement | null) => void;
  /** 运行中插话(SessionView 的 sendSteer → steerIssue)。 */
  onSteer: (text: string) => Promise<boolean>;
  /** 空闲续聊(SessionView 的 sendReply → replyIssue)。 */
  onReply: (text: string) => Promise<boolean>;
  /** 人工接管:打断 AI,现场交由人工(SessionView 包 perform)。 */
  onTakeover: () => Promise<boolean>;
  /** 接管期人工操作记录(不走 perform,失败原样抛回保字)。 */
  onTakeoverNote: (text: string) => Promise<void>;
  /** 交还:AI 带着人工记录继续;入参是可选的交还说明。 */
  onResumeTakeover: (note?: string) => Promise<boolean>;
  /** 「查看过程」入口(任务侧同款 conv-act):把左栏切到「对话现场」
   * 标签看每一步的原始事件(问题域没有「工作过程」视图)。 */
  onOpenEvents: () => void;
}) {
  const [view, setView] = useState<{
    items: IssueConversationItem[]; truncated: boolean;
    loaded: boolean; unavailable?: string;
  }>({ items: [], truncated: false, loaded: false });
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const [filter, setFilter] = useState<"all" | "mine">("all");
  const [hasNew, setHasNew] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastKey = useRef("");
  const sequence = useRef(0);

  const load = useCallback((id: string) => {
    const ticket = ++sequence.current;
    getIssueConversation(id).then((next) => {
      if (ticket !== sequence.current) return;
      setView({ items: next.items, truncated: next.truncated, loaded: true });
    }).catch((cause) => {
      if (ticket !== sequence.current) return;
      setView((current) => ({ ...current, loaded: true,
        unavailable: `协作流暂时读不到(${cause instanceof Error
          ? cause.message : String(cause)}),稍后自动重试。` }));
    });
  }, []);

  // 换会话重置:半拍旧响应按序号作废,流从空开始;可见才轮询,4 秒一拍。
  useEffect(() => {
    sequence.current += 1;
    setView({ items: [], truncated: false, loaded: false });
    const stop = startVisiblePolling(() => load(issueId), 4000, document);
    return () => { stop(); sequence.current += 1; };
  }, [issueId, load]);

  useEffect(() => {
    setLimit(INITIAL_LIMIT);
    pinned.current = true;
    setHasNew(false);
  }, [issueId]);

  // 卡座(#125):当前等待卡钉在流末尾的 Agent 气泡内;流内同卡(同
  // waiting_id)的投影副本按 id 摘除防双卡——不再整类过滤 waiting 投影,
  // 历史卡(已决定/作废)照常只读回放。等待说明(详情轮询)与协作流
  // (聚合轮询)节奏不同步的半拍,两源按 waiting_id 对齐。
  const projectedCurrent = useMemo(() => (waitingId
    ? view.items.find((item) =>
        item.kind === "card" && item.waiting_id === waitingId)
    : undefined), [view.items, waitingId]);
  const pinnedCard = Boolean(waiting && currentCard);
  const chronological = pinnedCard && waitingId
    ? view.items.filter((item) =>
        !(item.kind === "card" && item.waiting_id === waitingId))
    : view.items;
  const hidden = Math.max(0, chronological.length - limit);
  const limited = hidden ? chronological.slice(hidden) : chronological;
  // 「需要我的」= 此刻还等我动手的事(口径与任务侧 concernsViewer 一致):
  // 问题域里只有还开着的卡。当前卡本来钉在流末尾,不受筛选影响。
  const shown = filter === "mine"
    ? limited.filter((item) => item.kind === "card" && item.status === "waiting")
    : limited;

  // 新条目到达:贴底就跟着滚,离开底部就亮「有新消息」,不抢人正在读的位置。
  const streamKey = `${shown.at(-1)?.id ?? ""}:${shown.length}:${waitingId ?? ""}`;
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    if (pinned.current || !lastKey.current) {
      node.scrollTop = node.scrollHeight;
      const frame = window.requestAnimationFrame(() => { node.scrollTop = node.scrollHeight; });
      setHasNew(false);
      lastKey.current = streamKey;
      return () => window.cancelAnimationFrame(frame);
    } else if (lastKey.current !== streamKey) {
      setHasNew(true);
    }
    lastKey.current = streamKey;
  }, [streamKey, view.loaded]);

  function scrollToEnd() {
    const node = box.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    pinned.current = true;
    setHasNew(false);
  }

  const decisions = useMemo(() => {
    const map = new Map<string, Extract<IssueConversationItem, { kind: "decision" }>>();
    for (const item of view.items) {
      if (item.kind === "decision") map.set(item.waiting_id, item);
    }
    return map;
  }, [view.items]);

  const isViewer = Boolean(viewerUsername) && viewerUsername !== owner;
  const nameOf = (username: string | undefined) =>
    !username || username === viewerUsername ? "你" : username;

  /* ---- 单条渲染(历史卡/裁决/插话/检视/回执一律只读回放) ---- */
  function message(options: {
    key: string; who: "agent" | "you" | "person";
    name: string; ts: string; tag?: ReactNode; children: ReactNode;
  }) {
    const avatar = options.who === "agent" ? "A"
      : options.who === "you" ? "你" : initial(options.name);
    return (
      <article className={`conv-msg ${options.who}`} key={options.key}
        id={`conv-${options.key}`}>
        <span className={`conv-avatar ${options.who}`} aria-hidden>{avatar}</span>
        <div className="conv-body">
          <div className="conv-who">
            <b>{options.name}</b>
            {options.tag}
            <time dateTime={options.ts}
              title={formatLocalDateTime(options.ts, { seconds: true, year: true })}>
              {formatLocalClock(options.ts)}
            </time>
          </div>
          {options.children}
        </div>
      </article>
    );
  }

  function render(item: IssueConversationItem): ReactNode {
    switch (item.kind) {
      case "session":
        return (
          <div className="conv-divider" key={item.id} id={`conv-${item.id}`}>
            {item.phase === "started"
              ? (item.resume ? "会话从断点恢复" : "会话开始")
              : `会话结束${item.detail ? ` · ${item.detail}` : ""}`}
          </div>
        );
      case "turn": {
        // 交接语摊开(最后一段走任务侧同款量高折叠,此前的折叠);全是
        // 过程话时把最后一段当交接语;过程话折成一行计数。工具步骤是
        // conv-act 按钮(任务侧同款),点开切到左栏「对话现场」标签看
        // 每一步的原始事件(问题域没有「工作过程」视图)。
        const handoffs = item.texts.filter((text) => text.role === "handoff");
        const narrations = item.texts.filter((text) => text.role === "narration");
        const spoken = handoffs.length ? handoffs
          : (narrations.length ? [narrations[narrations.length - 1]] : []);
        const folded = narrations.filter((text) => !spoken.includes(text));
        const earlier = spoken.slice(0, -1);
        const last = spoken.at(-1);
        return message({
          key: item.id, who: "agent", name: "Agent", ts: item.ts,
          tag: item.open ? <em className="conv-tag ink">正在进行</em> : undefined,
          children: <>
            {folded.length > 0 && (
              <details className="conv-earlier narration">
                <summary>{folded.length} 段过程说明</summary>
                {folded.map((text, index) => (
                  <div className="conv-text" key={index}>
                    <Markdown text={text.text} />
                  </div>
                ))}
              </details>
            )}
            {earlier.length > 0 && (
              <details className="conv-earlier">
                <summary>此前 {earlier.length} 段</summary>
                {earlier.map((text, index) => (
                  <div className="conv-text" key={index}>
                    <Markdown text={text.text} />
                  </div>
                ))}
              </details>
            )}
            {last && <ClampedText text={last.text} />}
            {(item.steps.calls > 0 || item.steps.agents > 0) && (
              <button type="button" className="conv-act" onClick={onOpenEvents}
                title="到「对话现场」看每一步">
                <span aria-hidden>▸</span>{stepsLine(item.steps)}
              </button>
            )}
          </>,
        });
      }
      case "card": {
        const decision = decisions.get(item.waiting_id);
        return message({
          key: item.id, who: "agent", name: "Agent", ts: item.ts,
          tag: <em className={`conv-tag ${item.status === "waiting" ? "att" : "neutral"}`}>
            {item.status === "waiting" ? "等待决定"
              : item.status === "superseded" ? "已作废" : "已决定"}
          </em>,
          children: <div className={`conv-card ${item.status}`}>
            <div className="conv-card-head">
              <span className="conv-kicker">
                {item.purpose === "clarification" ? "追问" : "请你决定"}
              </span>
              <h4>{conversationCardTitle(item)}</h4>
            </div>
            {item.questions.map((question, index) => (
              <div className="conv-question" key={index}>
                {item.questions.length > 1 && <p>{question.question}</p>}
                {question.options.length > 0 && (
                  <ul className="conv-options">
                    {question.options.map((option) => {
                      // 裁决文本是提交时的选项原文(码还原后),逐行比对出勾。
                      const chosen = decision?.decision.split("\n").includes(option);
                      return <li key={option} className={chosen ? "chosen" : ""}>{option}</li>;
                    })}
                  </ul>
                )}
              </div>
            ))}
          </div>,
        });
      }
      case "decision": {
        const who = item.by ?? owner;
        return message({
          key: item.id, who: who === viewerUsername ? "you" : "person",
          name: who === viewerUsername ? "你" : (who || "归属人"), ts: item.ts,
          tag: <em className="conv-tag neutral">
            {item.purpose === "clarification" ? "答复了追问" : "作了决定"}
          </em>,
          children: <>
            <p className="conv-answer">{item.decision}</p>
            {item.notes && <p className="conv-notes">{item.notes}</p>}
          </>,
        });
      }
      case "steer":
        return message({
          key: item.id, who: "you", name: nameOf(owner), ts: item.ts,
          tag: <em className={`conv-tag ${item.delivered ? "ok" : "att"}`}>
            {item.delivered ? "已读取" : "待读取"}
          </em>,
          children: <p className="conv-answer">{item.text}</p>,
        });
      case "review":
        // 检视提交 = 整体打回重跑分析(ADR-0007):count 条修订意见随事件
        // 入账。渲染对齐任务侧批注批次卡(conv-lead 导语 + 正文)。
        return message({
          key: item.id, who: isViewer ? "person" : "you",
          name: isViewer ? (owner || "归属人") : "你", ts: item.ts,
          tag: <em className="conv-tag neutral">整体打回</em>,
          children: <>
            <p className="conv-lead">提交了 {item.count} 条检视意见给 Agent</p>
            <p className="conv-answer">{item.text}</p>
          </>,
        });
      case "receipts":
        // 平台工具回执(拉仓/推分支/建 MR/申报…)聚成一组留痕,不刷屏。
        return message({
          key: item.id, who: "agent", name: "Agent", ts: item.ts,
          tag: <em className="conv-tag neutral">平台回执 · {item.items.length} 项</em>,
          children: <ul className="conv-receipts">
            {item.items.map((entry, index) => (
              <li key={index}
                className={entry.outcome === "success" ? "fixed" : "not_fixed"}>
                <i aria-hidden>{entry.outcome === "success" ? "✓" : "✕"}</i>
                <div>
                  <b>{entry.name}</b>
                  {entry.summary && <small>{entry.summary}</small>}
                </div>
              </li>
            ))}
          </ul>,
        });
      default:
        return null;
    }
  }

  const rows: ReactNode[] = [];
  let lastDate = "";
  for (const item of shown) {
    const date = formatLocalDate(item.ts);
    if (date && date !== lastDate) {
      rows.push(<div className="conv-date" key={`date-${date}-${item.id}`}>{date}</div>);
      lastDate = date;
    }
    rows.push(render(item));
  }

  const nowTag = canOperate ? "等你决定" : "等归属人决定";

  return <>
    <div className="ws-stream-shell">
      <header className="ws-collaboration-head">
        <strong>与 Agent 协作</strong>
        {/* 流内筛选(任务侧同款 UI):阅读筛选,不是权限判断。 */}
        <div className="ws-stream-filters" role="tablist" aria-label="会话流筛选">
          {([["all", "全部"], ["mine", "需要我的"]] as const)
            .map(([key, label]) => (
              <button type="button" key={key} role="tab"
                aria-selected={filter === key}
                className={filter === key ? "on" : ""}
                onClick={() => setFilter(key)}>
                {label}
              </button>
            ))}
        </div>
        {view.truncated && <span>条目过多,只保留最近的;完整现场在左栏「对话现场」</span>}
      </header>
      {/* 挂起转正卡(#127):协作流区顶部,协作头之下、流之上——不进
          可滚流区,不会被贴底跟随滚出视野。 */}
      {suspendedCard && <div className="issue-conv-suspended">{suspendedCard}</div>}
      <div className="ws-stream" role="log" aria-live="polite" aria-relevant="additions"
        ref={box}
        onScroll={(event) => {
          pinned.current = atBottom(event.currentTarget);
          if (pinned.current) setHasNew(false);
        }}>
        {hidden > 0 && (
          <button type="button" className="conv-more"
            onClick={() => setLimit((value) => value + INITIAL_LIMIT)}>
            显示更早的 {hidden} 条
          </button>
        )}
        {view.unavailable && <div className="conv-problem" role="status">{view.unavailable}</div>}
        {!view.loaded && !view.unavailable && (
          <div className="conv-empty">正在读取协作记录…</div>
        )}
        {view.loaded && !shown.length && !currentCard && (
          <div className="conv-empty">
            还没有协作记录。Agent 开始干活、举卡,或你插话、续聊之后,会按时间出现在这里。
          </div>
        )}
        {rows}
        {/* 卡座(#125):当前等待卡永远钉在流末尾的 Agent 气泡内,举卡
            之后人再插话/裁决/回执它都不挪窝;流内同卡投影已按 waiting_id
            去重。查看模式钉的是只读事实卡,同样不出 dock。 */}
        {pinnedCard && message({
          key: `card-${waitingId ?? "current"}`, who: "agent", name: "Agent",
          ts: projectedCurrent?.ts ?? waitingTs ?? new Date().toISOString(),
          tag: <em className="conv-tag att">{nowTag}</em>,
          children: <div className="conv-card current">{currentCard}</div>,
        })}
      </div>
      {hasNew && (
        <button type="button" className="ws-stream-new" onClick={scrollToEnd}>有新消息 ↓</button>
      )}
    </div>
    <IssueCollaborationComposer
      key={issueId}
      status={status}
      waiting={waiting}
      canOperate={canOperate}
      busy={busy}
      owner={owner}
      takeover={takeover}
      dock={waiting && canOperate}
      dockRef={dockRef}
      onSteer={onSteer}
      onReply={onReply}
      onTakeover={onTakeover}
      onTakeoverNote={onTakeoverNote}
      onResumeTakeover={onResumeTakeover}
      onSent={() => load(issueId)}
    />
  </>;
}

/** 输入区(轻量仿制任务侧 ws-composer,类名同套):运行中=插话、空闲=
 * 续聊;人工接管中=人工驾驶(记录到现场/交还给 AI 两钮,2026-09-07
 * 走查拍板);等卡时让位给卡座 dock(卡的提交区经 portal 挂进
 * ws-reply-dock,附言与提交按钮就在输入区完成),挂起/未启动/终态给
 * 原因,查看者只读。发送走 SessionView 传入的 steerIssue/replyIssue
 * 通道,成功后立刻拉一次流让发言上屏。 */
function IssueCollaborationComposer({
  status,
  waiting,
  canOperate,
  busy,
  owner,
  takeover,
  dock,
  dockRef,
  onSteer,
  onReply,
  onTakeover,
  onTakeoverNote,
  onResumeTakeover,
  onSent,
}: {
  status: IssueStatus;
  waiting: boolean;
  canOperate: boolean;
  busy: boolean;
  owner: string;
  /** 人工接管中:真=人工驾驶模式(分派优先级在插话/续聊之前)。 */
  takeover: boolean;
  /** 卡座 dock 位(#125):归属人答卡时为真——输入区预留 ws-reply-dock
   * 容器,当前卡的提交区经 portal 挂进来;查看者/无卡时为假。 */
  dock: boolean;
  /** dock 容器节点回调(会话视图转交卡座,见本文件头部的模式说明)。 */
  dockRef?: (node: HTMLDivElement | null) => void;
  onSteer: (text: string) => Promise<boolean>;
  onReply: (text: string) => Promise<boolean>;
  /** 人工接管(打断 AI)/交还(AI 带记录继续):经 perform 包装,
   * 成功即有新详情回来,徽标与输入区模式随之翻转。 */
  onTakeover: () => Promise<boolean>;
  /** 人工操作记录:不走 perform(免吞错),失败原样抛到输入区报错。 */
  onTakeoverNote: (text: string) => Promise<void>;
  onResumeTakeover: (note?: string) => Promise<boolean>;
  /** 发送成功后立即刷新协作流(不等下一拍轮询)。 */
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  type Mode =
    | { kind: "readonly" }
    | { kind: "blocked"; title: string; hint: string }
    | { kind: "takeover" }
    | { kind: "steer" }
    | { kind: "reply" };
  const ended = ["archived", "canceled", "failed"].includes(status);
  const mode: Mode = !canOperate ? { kind: "readonly" }
    : waiting || status === "waiting_user" ? {
        kind: "blocked", title: "等你作答",
        hint: "卡在上方流末尾;补充说明与提交按钮就在下方,作答后一并交给 AI。",
      }
    : status === "queued" ? {
        kind: "blocked", title: "会话还没启动",
        hint: "Agent 启动后就能在这里插话或续聊。",
      }
    : status === "suspended" ? {
        kind: "blocked", title: "会话挂起中",
        hint: "在上方协作区关联 DTS 单号转正;转正后到新会话继续。",
      }
    : ended ? {
        kind: "blocked", title: "会话已结束",
        hint: "协作记录只读回放;结论与账单见左侧。",
      }
    // 人工驾驶(2026-09-07 走查拍板):接管在场即换模式,优先级压过
    // 插话/续聊;但让位给终局/等卡/挂起——收了口的会话不再给驾驶舱。
    : takeover === true ? { kind: "takeover" }
    : status === "running" ? { kind: "steer" }
    : { kind: "reply" };

  if (mode.kind === "readonly") {
    return <section className="ws-composer-readonly" aria-label="回复与提交(只读)">
      查看模式:协作记录完整可见;插话与续聊由归属人 {owner} 处理。
    </section>;
  }

  // 人工驾驶模式(2026-09-07 走查拍板):AI 已暂停,输入区只剩两件事
  // ——把人工操作记进现场账(可连续记多条),或连记录带说明一并交还
  // 给 AI。记录失败不吞错、不丢稿;交还成功后详情轮询带回新状态,
  // 输入区自动回到插话/续聊。
  if (mode.kind === "takeover") {
    async function recordNote() {
      const body = text.trim();
      if (!body || sending || busy) return;
      setSending(true);
      setError("");
      try {
        await onTakeoverNote(body);
        setText("");
        setSent(true);
        onSent();
      } catch (reason) {
        setError(String(reason instanceof Error ? reason.message : reason));
      } finally {
        setSending(false);
      }
    }
    async function handBack() {
      if (sending || busy) return;
      setSending(true);
      setError("");
      try {
        // 当前输入整段作交还说明(空=不带说明);perform 吞错回 false:
        // 失败保字,让用户重试不丢稿。
        const ok = await onResumeTakeover(text.trim() || undefined);
        if (ok) {
          setText("");
          onSent();
        } else {
          setError("交还未成功,请稍后重试");
        }
      } finally {
        setSending(false);
      }
    }
    return <section className="ws-composer takeover" aria-label="人工驾驶记录与交还">
      <div className="ws-composer-ctx">
        <span className={`ws-composer-mode ${busy ? "quiet" : "active"}`}>
          人工驾驶中——AI 已暂停
        </span>
        <span className="ws-composer-hint">
          记录到现场的每一条,交还时都会交给 AI
        </span>
      </div>
      <textarea className="steer-input" value={text} rows={3}
        disabled={sending || busy}
        placeholder="记录你的人工操作,交还时 AI 会看到这些记录"
        onChange={(event) => { setText(event.target.value); if (sent) setSent(false); }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void recordNote();
          }
        }} />
      <div className="ws-composer-row">
        <div className="ws-composer-left">
          <span className="steer-hint">
            {sent && !text ? "已记录到现场" : "⌘/Ctrl + Enter 记录"}
          </span>
        </div>
        <div className="issue-takeover-actions">
          <button type="button" className="issue-takeover-note"
            disabled={sending || busy || !text.trim()}
            onClick={() => void recordNote()}>
            {sending ? "处理中…" : "记录到现场"}
          </button>
          <button type="button" className="issue-takeover-resume"
            disabled={sending || busy}
            title="把当前输入作交还说明,连同接管期记录一并交给 AI"
            onClick={() => void handBack()}>
            交还给 AI 继续
          </button>
        </div>
      </div>
      {error && <div className="alert" role="alert">{error}</div>}
    </section>;
  }

  if (mode.kind === "blocked") {
    return <section className="ws-composer" aria-label="回复与提交">
      <div className="ws-composer-ctx">
        <span className="ws-composer-mode">{mode.title}</span>
        <span className="ws-composer-hint">{mode.hint}</span>
      </div>
      {/* 卡座 dock 位(#125):当前等待卡的提交区(附言+提交/拒绝按钮)
          经 portal 挂在这里。只在归属人答卡时预留;无卡(挂起/未启动/
          终态)不出容器——输入区保持纯状态说明,不出现空 dock。 */}
      {dock && <div className="ws-reply-dock" ref={dockRef} role="region"
        aria-label="决定的附言与提交" />}
    </section>;
  }

  const steer = mode.kind === "steer";
  async function send() {
    const body = text.trim();
    if (!body || sending || busy) return;
    setSending(true);
    setError("");
    try {
      // perform 通道吞错返回 false:失败保字,让用户重试不丢稿。
      const ok = steer ? await onSteer(body) : await onReply(body);
      if (ok) {
        setText("");
        setSent(true);
        onSent();
      } else {
        setError("发送未成功,请稍后重试");
      }
    } finally {
      setSending(false);
    }
  }

  return <section className="ws-composer" aria-label="回复与提交">
    <div className="ws-composer-ctx">
      <span className={`ws-composer-mode ${busy ? "quiet" : "active"}`}>
        {steer ? "说给 Agent · 插话" : "说给 Agent · 续聊"}
      </span>
      <span className="ws-composer-hint">
        {steer ? "不打断当前步骤,Agent 下一步执行前送达"
          : "会话空闲中,补充信息或调整方向后 AI 会接着推进"}
      </span>
      {/* 人工接管入口(2026-09-07 走查拍板):运行/空闲都可发起——打断
          AI、现场交由人工;接管后输入区换人工驾驶模式(记录/交还)。 */}
      {!busy && <button type="button" className="issue-takeover-start"
        title="打断 AI,现场交由人工操作;交还时 AI 会带着人工记录继续"
        onClick={() => void onTakeover().catch(() => undefined)}>
        接管现场
      </button>}
    </div>
    <textarea className="steer-input" value={text} rows={3}
      disabled={sending || busy}
      placeholder={steer
        ? "例如:日志先只拉网管侧,先别动库…"
        : "继续对话:补充信息、调整方向,或让 AI 继续…"}
      onChange={(event) => { setText(event.target.value); if (sent) setSent(false); }}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          void send();
        }
      }} />
    <div className="ws-composer-row">
      <div className="ws-composer-left">
        <span className="steer-hint">
          {sent && !text ? "已送到,发言出现在上面的流里" : "⌘/Ctrl + Enter 发送"}
        </span>
      </div>
      <button type="button" className="steer-send"
        disabled={sending || busy || !text.trim()}
        onClick={() => void send()}>
        {sending ? "发送中…" : steer ? "发送插话" : "发送"}
      </button>
    </div>
    {error && <div className="alert" role="alert">{error}</div>}
  </section>;
}
