/**
 * 右栏协作对话框(#124):问题域「与 Agent 协作」的轻量会话流。
 *
 * ADR-0018:任务侧 ConversationStream 的形状是两域共同目标,但那个组件
 * 与任务域的批注账、线程视图、人员名录、开发助手耦合过深;问题域协作流
 * 只有六类成员(session/turn/card/decision/steer/review/receipts),且
 * 本票全部只读回放,所以在 issues 域落一个轻量适配器:消息气泡复用
 * conv-* 与 ws-stream 全套类(主题走 .issue-workspace 的问题域变量,同构
 * 不同色),渲染纪律与任务侧一致——所有事实来自聚合接口,这里不推断
 * 状态,只排版。
 *
 * 数据:GET /issues/:id/conversation(getIssueConversation),会话视图
 * 可见时每 4 秒轮询一次(任务侧同款节奏),换会话重置(序号作废半拍
 * 旧响应);贴底跟随 + 「有新消息」行为照搬任务侧。
 *
 * 当前等待卡不在流内渲染:会话视图把它作为 currentCard 挂在流上方
 * 「当前待你处理」容器里(临时形态,卡入流 + 输入区 dock 是 #125 的活);
 * 流内同卡的只读副本因此过滤,不重复呈现。
 *
 * 输入区按会话状态分派(轻量仿制任务侧 ws-composer 的结构与类名):
 * 运行中=插话(steerIssue,不打断当前步骤)、空闲=续聊(replyIssue);
 * 等卡/挂起/未启动/终态给原因说明,查看者(canOperate=false)只见只读
 * 提示——写口语义与 IssueRail 时代的 canOperate 门零变化。
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

/** 长交接语按字数收折(轻量适配器不做任务侧的量高 ResizeObserver;
 * 短文直出,超过约 1200 字给展开全文,渲染与阅读成本都可控)。 */
function TurnText({ text }: { text: string }) {
  if (text.length <= 1200) {
    return <div className="conv-text"><Markdown text={text} /></div>;
  }
  return <details className="conv-earlier">
    <summary>展开全文(约 {Math.round(text.length / 100) / 10}k 字)</summary>
    <div className="conv-text"><Markdown text={text} /></div>
  </details>;
}

export function IssueConversationStream({
  issueId,
  status,
  waiting,
  canOperate,
  busy,
  owner,
  viewerUsername,
  currentCard,
  onSteer,
  onReply,
}: {
  issueId: string;
  /** 会话状态:输入区的插话/续聊/禁用分派只看它和 waiting。 */
  status: IssueStatus;
  /** 当前有等归属人的卡(waiting 非 undefined):流内同卡只读副本过滤,
   * 真卡由会话视图经 currentCard 挂在流上方。 */
  waiting: boolean;
  /** 归属操作权(查看模式=false):false 时输入区只读,流完整可见。 */
  canOperate: boolean;
  busy: boolean;
  /** 会话归属人名:裁决/检视的署名与查看模式文案用。 */
  owner: string;
  /** 当前登录用户名(缺席=auth 关闭的演示形态,按归属人渲染)。 */
  viewerUsername?: string;
  /** 当前待处理卡(IssueDecisionCard / 查看模式 IssueWaitingFacts),
   * 会话视图组装;本票临时挂在流上方,#125 移入流末尾。 */
  currentCard?: ReactNode;
  /** 运行中插话(SessionView 的 sendSteer → steerIssue)。 */
  onSteer: (text: string) => Promise<boolean>;
  /** 空闲续聊(SessionView 的 sendReply → replyIssue)。 */
  onReply: (text: string) => Promise<boolean>;
}) {
  const [view, setView] = useState<{
    items: IssueConversationItem[]; truncated: boolean;
    loaded: boolean; unavailable?: string;
  }>({ items: [], truncated: false, loaded: false });
  const [limit, setLimit] = useState(INITIAL_LIMIT);
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

  // 当前等待卡的只读副本不进流(真卡在流上方),其余按投影给出的顺序排。
  const chronological = useMemo(() => waiting
    ? view.items.filter((item) => !(item.kind === "card" && item.status === "waiting"))
    : view.items, [view.items, waiting]);
  const hidden = Math.max(0, chronological.length - limit);
  const shown = hidden ? chronological.slice(hidden) : chronological;

  // 新条目到达:贴底就跟着滚,离开底部就亮「有新消息」,不抢人正在读的位置。
  const streamKey = `${shown.at(-1)?.id ?? ""}:${shown.length}`;
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
        // 交接语摊开(最后一段全文,此前的折叠);全是过程话时把最后一段
        // 当交接语;过程话折成一行计数。工具步骤只留一行只读计数——问题
        // 域没有「工作过程」视图,原始事件在「对话现场」标签。
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
            {last && <TurnText text={last.text} />}
            {(item.steps.calls > 0 || item.steps.agents > 0) && (
              <span className="issue-conv-steps"
                title="工具步骤的流内计数;每一步的原始事件在左栏「对话现场」标签">
                {stepsLine(item.steps)}
              </span>
            )}
          </>,
        });
      }
      case "card": {
        const decision = decisions.get(item.waiting_id);
        return message({
          key: item.id, who: "agent", name: "Agent", ts: item.ts,
          tag: <em className={`conv-tag ${item.status === "waiting" ? "att" : "neutral"}`}>
            {item.status === "waiting" ? "等待决定" : "已决定"}
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
        // 检视提交 = 整体打回重跑分析(ADR-0007):count 条修订意见随事件入账。
        return message({
          key: item.id, who: isViewer ? "person" : "you",
          name: isViewer ? (owner || "归属人") : "你", ts: item.ts,
          tag: <em className="conv-tag neutral">提交 {item.count} 条检视意见</em>,
          children: <p className="conv-answer">{item.text}</p>,
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

  const nowLabel = canOperate ? "当前待你处理" : "当前待归属人处理";

  return <>
    <div className="ws-stream-shell">
      <header className="ws-collaboration-head">
        <strong>与 Agent 协作</strong>
        {view.truncated && <span>条目过多,只保留最近的;完整现场在左栏「对话现场」</span>}
      </header>
      {/* 当前待处理卡:本票临时挂在流上方(容器即标注),保证作答链路
          不断;#125 卡入流后这个容器整体拆除。 */}
      {currentCard && <div className="issue-conv-now" role="region" aria-label={nowLabel}>
        <span className="issue-conv-now-label">{nowLabel}</span>
        {currentCard}
      </div>}
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
      onSteer={onSteer}
      onReply={onReply}
      onSent={() => load(issueId)}
    />
  </>;
}

/** 输入区(轻量仿制任务侧 ws-composer,类名同套):运行中=插话、空闲=
 * 续聊;等卡/挂起/未启动/终态给原因,查看者只读。发送走 SessionView
 * 传入的 steerIssue/replyIssue 通道,成功后立刻拉一次流让发言上屏。 */
function IssueCollaborationComposer({
  status,
  waiting,
  canOperate,
  busy,
  owner,
  onSteer,
  onReply,
  onSent,
}: {
  status: IssueStatus;
  waiting: boolean;
  canOperate: boolean;
  busy: boolean;
  owner: string;
  onSteer: (text: string) => Promise<boolean>;
  onReply: (text: string) => Promise<boolean>;
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
    | { kind: "steer" }
    | { kind: "reply" };
  const ended = ["archived", "canceled", "failed"].includes(status);
  const mode: Mode = !canOperate ? { kind: "readonly" }
    : waiting || status === "waiting_user" ? {
        kind: "blocked", title: "等你作答",
        hint: "先在上面的卡里作答;补充说明写在卡的「补充说明」里,随答复一起交给 AI。",
      }
    : status === "queued" ? {
        kind: "blocked", title: "会话还没启动",
        hint: "Agent 启动后就能在这里插话或续聊。",
      }
    : status === "suspended" ? {
        kind: "blocked", title: "会话挂起中",
        hint: "在下方「更多操作」里关联 DTS 单号转正;转正后到新会话继续。",
      }
    : ended ? {
        kind: "blocked", title: "会话已结束",
        hint: "协作记录只读回放;结论与账单见左侧。",
      }
    : status === "running" ? { kind: "steer" }
    : { kind: "reply" };

  if (mode.kind === "readonly") {
    return <section className="ws-composer-readonly" aria-label="回复与提交(只读)">
      查看模式:协作记录完整可见;插话与续聊由归属人 {owner} 处理。
    </section>;
  }

  if (mode.kind === "blocked") {
    return <section className="ws-composer" aria-label="回复与提交">
      <div className="ws-composer-ctx">
        <span className="ws-composer-mode">{mode.title}</span>
        <span className="ws-composer-hint">{mode.hint}</span>
      </div>
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
        {steer ? "插话给正在推进的 Agent" : "补充给 Agent"}
      </span>
      <span className="ws-composer-hint">
        {steer ? "不打断当前步骤,Agent 下一步执行前送达"
          : "会话空闲中,补充信息或调整方向后 AI 会接着推进"}
      </span>
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
