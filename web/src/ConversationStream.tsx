/**
 * 会话流:右栏只回答"谁对谁说了什么、现在轮到谁"。
 *
 * 边界(2026-09-05 用户拍板):流里只有回合——Agent 说的话、举的卡、人的决定、
 * 插话、批注与回执、外部检视意见、会话起止;工具步骤折成回合下的一行
 * 计数,点开去「工作过程」看正本。定位靠 id 双向跳,不靠搜:批注抽屉
 * 里的一条意见 → 这里只看它的往来(线程视图);这里的一条意见 → 左侧
 * 材料原位 / 抽屉那条卡。
 *
 * 所有事实来自 /conversation 投影:这里不推断状态,只排版。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Markdown } from "./markdown";
import { atBottom } from "./follow";
import { displayPersonName } from "./AnnotationPanel";
import { formatLocalClock, formatLocalDate, formatLocalDateTime } from "./time";
import {
  TASK_REQUIREMENT_ARTIFACT,
  type Annotation,
  type ConversationItem,
  type ConversationSteps,
  type DeveloperAssistantToolRun,
  type FeedbackSource,
  type TaskSummary,
} from "./api";

export type StreamFilter = "all" | "mine";

/** 一屏先渲最近这些条;更早的按需展开(run7 真现场主会话 145 段话)。 */
const INITIAL_LIMIT = 50;


const SOURCE_LABEL: Record<FeedbackSource, string> = {
  workspace: "工作台批注",
  build_fix: "Build-Fix",
  pipeline: "流水线",
  mr_discussion: "CodeHub 检视",
  conflict: "合并冲突",
  scope: "越界改动",
  push_confirmation: "推送确认",
};

const FEEDBACK_STATUS_LABEL: Record<string, string> = {
  open: "待处理", repairing: "处理中", addressed: "已处理",
  awaiting_verification: "等验证", closed: "已闭环", needs_human: "需要人判断",
};

const OUTCOME_LABEL: Record<string, string> = {
  fixed: "已处理", not_fixed: "未处理", needs_clarification: "需要补充信息",
};

/** 一条流条目牵涉到哪些批注(线程视图与双向跳转都靠它)。 */
export function itemAnnotationIds(item: ConversationItem): string[] {
  switch (item.kind) {
    case "card":
    case "decision":
      return item.annotation_ids;
    case "annotations_sent":
    case "receipts":
      return item.items.map((entry) => entry.id);
    case "owner_reply":
    case "clarified":
    case "withdrawal_requested":
    case "verified":
    case "reopened":
    case "delivery_reset":
    case "revised":
      return [item.annotation.id];
    default:
      return [];
  }
}

/** "需要我的" = 此刻还等我动手的事,不是"跟我有关的历史"。原来把所有卡、决定、
 * 插话、我提过的意见全算进来,点开和「全部」几乎没区别(用户 2026-09-06 实锤,
 * fixture 里只少了会话开始和一段过程话)。现在只剩三类:还开着的卡;我提的意见
 * 收到了当前版本的回执、而那条意见还没闭环(要我确认修好 / 退回 / 补充说明);
 * 收到的上下游通知。这是阅读筛选,不是权限判断——能不能答卡由决定卡自己说。 */
function concernsViewer(
  item: ConversationItem,
  viewer: string,
  settled: ReadonlySet<string>,
  owner?: string,
): boolean {
  switch (item.kind) {
    case "card":
      return item.status === "waiting";
    case "sync":
      return item.direction === "received";
    case "receipts":
      return item.items.some((entry) => entry.current && (owner ?? entry.author) === viewer
        && !settled.has(entry.id));
    default:
      return false;
  }
}

export function visibleConversationItems(
  items: readonly ConversationItem[],
  options: {
    filter: StreamFilter; thread?: string; viewer: string;
    /** 已闭环(确认通过 / 删除)的意见 id:它们的回执不再需要我。 */
    settled?: ReadonlySet<string>;
    owner?: string;
  },
): ConversationItem[] {
  if (options.thread) {
    const thread = options.thread;
    return items.filter((item) => itemAnnotationIds(item).includes(thread));
  }
  if (options.filter === "mine") {
    const settled = options.settled ?? new Set<string>();
    return items.filter((item) => concernsViewer(item, options.viewer, settled, options.owner));
  }
  return [...items];
}

/** 卡的标题按卡类型说话,与 WaitingCard 的口径一致;认不出的类型用第一问。 */
export function conversationCardTitle(
  item: Extract<ConversationItem, { kind: "card" }>,
): string {
  if (item.purpose === "clarification") return "需要补充信息";
  if (item.step === "cloud_requirement_analysis_confirm") return "确认需求";
  if (item.step === "cloud_push_confirm") return "最终检视：确认这版代码可直接推送";
  return item.questions[0]?.question || "需要你的决策";
}

function shortPath(path: string): string {
  if (path === TASK_REQUIREMENT_ARTIFACT) return "需求原文";
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : parts.slice(-2).join("/");
}

/** "等你 22 小时"——relativeTime 带"前",接在"等你"后面会读成"等你 22 小时前"。 */
function waitedFor(since: string | undefined, now = Date.now()): string {
  const then = since ? new Date(since).getTime() : NaN;
  if (!Number.isFinite(then)) return "";
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return "刚刚举卡";
  if (minutes < 60) return `等你 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `等你 ${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}`;
  return `等你 ${Math.floor(hours / 24)} 天`;
}

function initial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? [...trimmed][0]!.toUpperCase() : "?";
}

function stepsLine(steps: ConversationSteps): string {
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

/** 长话按渲染高度折叠,不按字数切(工作过程页签踩过切坏 Markdown 的坑)。
 * 超过约 12 行收成固定高度加"展开全文";静态渲染(测试)下量不到高度,原样摊开。 */
const CLAMP_PX = 260;
function ClampedText({ text }: { text: string }) {
  const body = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const node = body.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => setOverflows(node.scrollHeight > CLAMP_PX + 24);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);
  return (
    <div className={`conv-text${overflows && !expanded ? " clamped" : ""}`}>
      <div className="conv-text-window"><div ref={body}><Markdown text={text} /></div></div>
      {overflows && (
        <button type="button" className="conv-expand" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起" : "展开全文"}
        </button>
      )}
    </div>
  );
}

/** 举卡前那段话就是卡的"决策背景",两处同一段字只留卡里那份。投影把话
 * 裁到 1600 字,比较按较短的一方对齐。 */
function sameSpeech(left: string, right: string): boolean {
  const a = left.replace(/\s+/g, " ").trim().replace(/…$/, "");
  const b = right.replace(/\s+/g, " ").trim();
  if (!a || !b) return false;
  const span = Math.min(a.length, b.length, 1500);
  return span >= 24 && a.slice(0, span) === b.slice(0, span);
}

export function ConversationStream({
  task,
  items,
  problems,
  loaded,
  unavailable,
  viewerUsername,
  people,
  filter,
  onFilterChange,
  thread,
  onThreadChange,
  annotations,
  decides,
  awaitingYou,
  fallbackHeadline,
  fallbackDetail,
  currentCard,
  tail,
  assistantTools,
  takeover,
  statusText,
  actor,
  onLocateAnnotation,
  onOpenReview,
  onOpenSteps,
}: {
  task: TaskSummary;
  items: readonly ConversationItem[];
  problems: readonly string[];
  loaded: boolean;
  unavailable?: string;
  viewerUsername: string;
  people: readonly { username: string; display_name?: string }[];
  filter: StreamFilter;
  onFilterChange: (filter: StreamFilter) => void;
  /** 线程视图:只看这条批注的处理记录。 */
  thread?: string;
  onThreadChange: (id?: string) => void;
  annotations: readonly Annotation[];
  /** 当前卡由这位读者答(责任人/协作者/被追问的意见作者)。 */
  decides: boolean;
  /** 等这位读者逐条确认的意见数(服务端 closures 的 mine 档)。 */
  awaitingYou: number;
  fallbackHeadline: string;
  fallbackDetail: string;
  /** 当前决定卡(WaitingCard)或只读说明;渲在流末尾的 Agent 气泡里。 */
  currentCard?: ReactNode;
  /** 非决定态的收口块(失败原因/重跑、验证中、等合入、子任务清单)。 */
  tail?: ReactNode;
  assistantTools?: readonly DeveloperAssistantToolRun[];
  takeover: boolean;
  /** 任务状态的人话(执行中/已暂停…)与责任("由你负责"):并进锚条那一行,
   * 不再单独占一行。 */
  statusText?: string;
  actor?: string;
  onLocateAnnotation: (id: string) => void;
  onOpenReview: (ids: string[]) => void;
  onOpenSteps: () => void;
}) {
  const [limit, setLimit] = useState(INITIAL_LIMIT);
  const [hasNew, setHasNew] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const lastKey = useRef("");

  useEffect(() => {
    setLimit(INITIAL_LIMIT);
    pinned.current = true;
    setHasNew(false);
  }, [task.id, filter, thread]);

  const settled = useMemo(() => new Set(annotations
    .filter((item) => item.status === "verified" || item.status === "dropped")
    .map((item) => item.id)), [annotations]);
  const visible = useMemo(() => visibleConversationItems(items, {
    filter, thread, viewer: viewerUsername, settled, owner: task.luban_account ?? "本地用户",
  }), [items, filter, thread, viewerUsername, settled, task.luban_account]);
  const decisions = useMemo(() => {
    const map = new Map<string, Extract<ConversationItem, { kind: "decision" }>>();
    for (const item of items) if (item.kind === "decision") map.set(item.waiting_id, item);
    return map;
  }, [items]);
  const waiting = task.status === "waiting_for_human" ? task.waiting : undefined;
  // 当前这张卡永远钉在流的末尾:它举卡之后人还会提批注、插话,按时间排它会
  // 被埋在这些条目上面,人得往回翻才找得到选项(fixture 实测)。时间线上
  // 它原来的位置不重复渲。线程视图也钉:卡的提交区经 portal 挂在输入框里,
  // 卡不渲输入框就只剩一句"等你在上面点一个选项"——用户 2026-09-05 点了
  // 「看处理记录」后实锤"说给 Agent 栏没了"。
  const pinnedCard = !!waiting && !!currentCard;
  const chronological = pinnedCard
    ? visible.filter((item) => !(item.kind === "card" && item.waiting_id === waiting.waiting_id))
    : visible;
  const hidden = Math.max(0, chronological.length - limit);
  const shown = hidden ? chronological.slice(hidden) : chronological;

  // 新条目到达:贴底就跟着滚,离开底部就亮"有新消息",不抢人正在读的位置。
  const streamKey = `${shown.at(-1)?.id ?? ""}:${shown.length}:${waiting?.waiting_id ?? ""}`;
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
  }, [streamKey, loaded]);

  function scrollToEnd() {
    const node = box.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    pinned.current = true;
    setHasNew(false);
  }

  const threadAnnotation = thread
    ? annotations.find((item) => item.id === thread) : undefined;
  const nameOf = (username?: string) => !username ? ""
    : username === viewerUsername ? "你" : displayPersonName(username, people);

  /* ---- 待你处理锚条:一句话说清现在轮到谁、点一下就到 ---- */
  const anchor = (() => {
    const join = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(" · ");
    if (waiting && decides) {
      const clarification = waiting.question?.purpose === "clarification";
      return {
        tone: "attention" as const,
        text: clarification ? "Agent 在追问，等你补充信息"
          : "等你决定",
        detail: join(waitedFor(waiting.created_at), actor),
        action: { label: "跳到卡片", onClick: scrollToEnd },
      };
    }
    if (awaitingYou > 0) {
      return {
        tone: "attention" as const,
        text: `${awaitingYou} 条意见等你逐条确认`,
        detail: "Agent 已登记回执，是否修好由你判断",
        action: { label: "打开检视意见", onClick: () => onOpenReview([]) },
      };
    }
    if (waiting) {
      return {
        tone: "neutral" as const,
        text: `等待 ${nameOf(task.luban_account) || "责任人"} 决定`,
        detail: "你可以继续在材料上批注，意见会随卡送到 Agent",
      };
    }
    return {
      tone: "neutral" as const,
      text: task.focus?.headline ?? fallbackHeadline,
      detail: join(statusText, actor, task.focus?.next_action ?? fallbackDetail),
    };
  })();

  /* ---- 单条渲染 ---- */
  function annotationChip(entry: { id: string; file: string; line: number; note: string }) {
    return (
      <button type="button" className="conv-quote" key={entry.id}
        title="回到材料上圈的那一行"
        onClick={() => onLocateAnnotation(entry.id)}>
        <code>{shortPath(entry.file)}:{entry.line}</code>
        <span>{entry.note}</span>
      </button>
    );
  }

  function threadButton(id: string) {
    if (thread === id) return null;
    return (
      <button type="button" className="conv-thread-link"
        onClick={() => onThreadChange(id)}>看这条的处理记录</button>
    );
  }

  function message(options: {
    key: string; who: "agent" | "you" | "person" | "system" | "external" | "assistant";
    name: string; ts: string; tag?: ReactNode; ids?: string[]; children: ReactNode;
  }) {
    const avatar = options.who === "agent" ? "A"
      : options.who === "assistant" ? "助"
      : options.who === "system" ? "⚙"
      : options.who === "you" ? "你" : initial(options.name);
    return (
      <article className={`conv-msg ${options.who}`} key={options.key}
        id={`conv-${options.key}`}
        data-annotation-ids={options.ids?.join(" ") || undefined}>
        <span className={`conv-avatar ${options.who}`} aria-hidden>{avatar}</span>
        <div className="conv-body">
          <div className="conv-who">
            <b>{options.name}</b>
            {options.tag}
            <time dateTime={options.ts} title={formatLocalDateTime(options.ts, { seconds: true, year: true })}>
              {formatLocalClock(options.ts)}
            </time>
          </div>
          {options.children}
        </div>
      </article>
    );
  }

  function render(item: ConversationItem): ReactNode {
    switch (item.kind) {
      case "session":
        return (
          <div className="conv-divider" key={item.id} id={`conv-${item.id}`}>
            {item.phase === "started"
              ? (item.resume ? "会话从断点恢复" : "会话开始")
              : `会话结束${item.reason ? ` · ${item.reason}` : ""}${item.detail ? ` · ${item.detail}` : ""}`}
          </div>
        );
      case "turn": {
        // 交接语摊开(最后一段全文,此前的折叠);过程话默认折成一行;举卡前那段
        // 与当前卡的决策背景重复的不再渲。回合全是过程话时把最后一段当交接语。
        const cardContext = pinnedCard ? (waiting?.context ?? "") : "";
        const handoffs = item.texts.filter((text) => text.role !== "narration"
          && !(cardContext && sameSpeech(text.text, cardContext)));
        const echoedByCard = item.texts.some((text) => text.role !== "narration"
          && cardContext && sameSpeech(text.text, cardContext));
        const narrations = item.texts.filter((text) => text.role === "narration");
        const spoken = handoffs.length ? handoffs
          : (!echoedByCard && narrations.length ? [narrations[narrations.length - 1]] : []);
        const folded = narrations.filter((text) => !spoken.includes(text));
        const last = spoken.at(-1);
        const earlier = spoken.slice(0, -1);
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
              <button type="button" className="conv-act" onClick={onOpenSteps}
                title="到「工作过程」看每一步">
                <span aria-hidden>▸</span>{stepsLine(item.steps)}
              </button>
            )}
          </>,
        });
      }
      case "card": {
        const isCurrent = !!waiting && waiting.waiting_id === item.waiting_id;
        if (isCurrent && currentCard && !pinnedCard) {
          return message({
            key: item.id, who: "agent", name: "Agent", ts: item.ts, ids: item.annotation_ids,
            tag: <em className="conv-tag att">{item.purpose === "clarification" ? "在追问" : "等你决定"}</em>,
            children: <div className="conv-card current">{currentCard}</div>,
          });
        }
        const decision = decisions.get(item.waiting_id);
        return message({
          key: item.id, who: "agent", name: "Agent", ts: item.ts, ids: item.annotation_ids,
          tag: <em className={`conv-tag ${item.status === "waiting" ? "att" : "neutral"}`}>
            {item.status === "waiting" ? "等待决定" : item.status === "resolved" ? "已决定" : "已作废"}
          </em>,
          children: <div className={`conv-card ${item.status}`}>
            <div className="conv-card-head">
              <span className="conv-kicker">{item.purpose === "clarification" ? "追问" : "请你决定"}</span>
              <h4>{conversationCardTitle(item)}</h4>
            </div>
            {item.questions.map((question, index) => (
              <div className="conv-question" key={index}>
                {item.questions.length > 1 && <p>{question.question}</p>}
                {question.options.length > 0 && (
                  <ul className="conv-options">
                    {question.options.map((option) => {
                      const chosen = decision?.answers?.[question.question] === option
                        || (!decision?.answers && decision?.decision.split("\n").includes(option));
                      return <li key={option} className={chosen ? "chosen" : ""}>{option}</li>;
                    })}
                  </ul>
                )}
              </div>
            ))}
            {item.annotation_ids.length > 0 && (
              <div className="conv-card-foot">
                针对 {item.annotation_ids.length} 条意见
                <button type="button" onClick={() => onOpenReview(item.annotation_ids)}>看这些意见</button>
              </div>
            )}
          </div>,
        });
      }
      case "decision": {
        const who = item.by ?? task.luban_account;
        const name = nameOf(who) || "责任人";
        const answers = item.answers ? Object.values(item.answers) : [item.decision];
        return message({
          key: item.id, who: who === viewerUsername ? "you" : "person", name, ts: item.ts,
          ids: item.annotation_ids,
          tag: <em className="conv-tag neutral">{item.purpose === "clarification" ? "答复了追问" : "作了决定"}</em>,
          children: <>
            {answers.filter(Boolean).map((answer, index) => (
              <p className="conv-answer" key={index}>{answer}</p>
            ))}
            {item.notes && <p className="conv-notes">{item.notes}</p>}
          </>,
        });
      }
      case "steer":
        return message({
          key: item.id, who: "you", name: "补充给 Agent", ts: item.ts,
          tag: <em className={`conv-tag ${item.delivered ? "ok" : "att"}`}>
            {item.delivered ? "已读取"
              : item.deferred === "decision" ? "随下一次决定送达"
              : item.deferred === "mission" ? "任务启动时送达" : "待读取"}
          </em>,
          children: <>
            <p className="conv-answer">{item.text}</p>
            {!!item.references?.length && (
              <div className="conv-refs">{item.references.map((label) => (
                <span key={label}>@ {label}</span>
              ))}</div>
            )}
          </>,
        });
      case "annotations_sent": {
        const who = item.by ?? item.items[0]?.author;
        if (!thread) {
          return message({
            key: item.id, who: who === viewerUsername ? "you" : "person",
            name: nameOf(who) || "检视人", ts: item.ts, ids: item.items.map((entry) => entry.id),
            children: digest(`提交了 ${item.items.length} 条意见给 Agent`, item.items.map((entry) => entry.id)),
          });
        }
        return message({
          key: item.id, who: who === viewerUsername ? "you" : "person",
          name: nameOf(who) || "检视人", ts: item.ts, ids: item.items.map((entry) => entry.id),
          children: <>
            <p className="conv-lead">提交了 {item.items.length} 条批注给 Agent</p>
            {item.items.map(annotationChip)}
            {item.items.length === 1 && threadButton(item.items[0].id)}
          </>,
        });
      }
      case "receipts": {
        if (!thread) {
          const current = item.items.filter((entry) => entry.current);
          const stale = item.items.length - current.length;
          const count = (outcome: string) => current.filter((entry) => entry.outcome === outcome).length;
          const parts = [
            count("fixed") ? `${count("fixed")} 条已处理` : "",
            count("not_fixed") ? `${count("not_fixed")} 条没有修改` : "",
            count("needs_clarification") ? `${count("needs_clarification")} 条需要补充说明` : "",
          ].filter(Boolean).join("、");
          return message({
            key: item.id, who: "agent", name: "Agent", ts: item.ts,
            ids: item.items.map((entry) => entry.id),
            children: digest(
              current.length
                ? `回了 ${current.length} 条意见的处理结果：${parts}`
                : `回了 ${item.items.length} 条意见的处理结果`,
              item.items.map((entry) => entry.id),
              stale ? `另 ${stale} 条是旧版本回执，不算数` : undefined),
          });
        }
        return message({
          key: item.id, who: "agent", name: "Agent", ts: item.ts,
          ids: item.items.map((entry) => entry.id),
          children: <>
            <p className="conv-lead">{item.items.length} 条意见的处理回执</p>
            <ul className="conv-receipts">
              {item.items.map((entry) => (
                <li key={`${entry.id}:${entry.revision}`} className={entry.outcome}>
                  <i aria-hidden>{entry.outcome === "fixed" ? "✓"
                    : entry.outcome === "not_fixed" ? "✕" : "?"}</i>
                  <div>
                    <button type="button" className="conv-receipt-title"
                      onClick={() => onLocateAnnotation(entry.id)}>
                      {entry.note}
                    </button>
                    <small>
                      <b>{OUTCOME_LABEL[entry.outcome] ?? entry.outcome}</b>
                      {entry.summary && <> · {entry.summary}</>}
                      {entry.fixed_sha && <> · <code>{entry.fixed_sha.slice(0, 8)}</code></>}
                    </small>
                    {!entry.current && <em className="conv-tag att">旧版本回执，不算数</em>}
                    {threadButton(entry.id)}
                  </div>
                </li>
              ))}
            </ul>
          </>,
        });
      }
      case "owner_reply":
        if (!thread) {
          return message({
            key: item.id, who: item.by === viewerUsername ? "you" : "person",
            name: nameOf(item.by) || "责任人", ts: item.ts, ids: [item.annotation.id],
            children: digest("答复了 1 条意见", [item.annotation.id]),
          });
        }
        return message({
          key: item.id, who: item.by === viewerUsername ? "you" : "person",
          name: nameOf(item.by) || "责任人", ts: item.ts, ids: [item.annotation.id],
          tag: <em className="conv-tag neutral">答复了意见</em>,
          children: <>
            {annotationChip(item.annotation)}
            <p className="conv-answer">{item.text}</p>
            {threadButton(item.annotation.id)}
          </>,
        });
      case "clarified": {
        const who = item.by ?? item.annotation.author;
        if (!thread) {
          return message({
            key: item.id, who: who === viewerUsername ? "you" : "person",
            name: nameOf(who) || "意见作者", ts: item.ts, ids: [item.annotation.id],
            children: digest("答复了 Agent 对 1 条意见的追问", [item.annotation.id]),
          });
        }
        return message({
          key: item.id, who: who === viewerUsername ? "you" : "person",
          name: nameOf(who) || "意见作者", ts: item.ts, ids: [item.annotation.id],
          tag: <em className="conv-tag neutral">答复了追问</em>,
          children: <>
            {annotationChip(item.annotation)}
            {item.question && <p className="conv-question-echo">Agent 问：{item.question}</p>}
            <p className="conv-answer">{item.answer}</p>
            {threadButton(item.annotation.id)}
          </>,
        });
      }
      case "withdrawal_requested":
        return message({
          key: item.id, who: item.by === viewerUsername ? "you" : "person",
          name: nameOf(item.by), ts: item.ts, ids: [item.annotation.id],
          children: <><p>申请撤回这条表达，等待责任人逐条处置。</p>{threadButton(item.annotation.id)}</>,
        });
      case "verified": {
        const label = item.resolution ? ({ fixed: "责任人确认已修复", not_adopted: "责任人不采纳",
          deferred: "责任人决定延期", accepted_risk: "责任人接受风险继续" })[item.resolution.outcome] : "确认通过";
        const who = item.by ?? item.annotation.author;
        if (!thread) {
          return message({
            key: item.id, who: who === viewerUsername ? "you" : "person",
            name: nameOf(who) || "意见作者", ts: item.ts, ids: [item.annotation.id],
            children: <>{digest(item.resolution ? label : "确认 1 条意见已修好", [item.annotation.id])}{item.resolution?.reason && <p>{item.resolution.reason}</p>}</>,
          });
        }
        return message({
          key: item.id, who: who === viewerUsername ? "you" : "person",
          name: nameOf(who) || "意见作者", ts: item.ts, ids: [item.annotation.id],
          tag: <em className="conv-tag ok">{label}</em>,
          children: <>{annotationChip(item.annotation)}{item.resolution?.reason && <p>{item.resolution.reason}</p>}{threadButton(item.annotation.id)}</>,
        });
      }
      case "delivery_reset":
        return message({
          key: item.id, who: "external", name: "系统", ts: item.ts, ids: [item.annotation.id],
          tag: <em className="conv-tag att">处理未完成 · 待重新提交</em>,
          children: <>
            <p>系统已将这条意见恢复为待提交，不计入人工退回次数。</p>
            <p>{item.reason}</p>
            {thread && annotationChip(item.annotation)}
            {threadButton(item.annotation.id)}
          </>,
        });
      case "reopened": {
        const who = item.by ?? item.annotation.author;
        if (!thread) {
          return message({
            key: item.id, who: who === viewerUsername ? "you" : "person",
            name: nameOf(who) || "意见作者", ts: item.ts, ids: [item.annotation.id],
            children: digest(`退回 1 条意见，第 ${item.returned} 次要求再改`, [item.annotation.id]),
          });
        }
        return message({
          key: item.id, who: who === viewerUsername ? "you" : "person",
          name: nameOf(who) || "意见作者", ts: item.ts, ids: [item.annotation.id],
          tag: <em className="conv-tag att">退回 · 第 {item.returned} 次</em>,
          children: <>
            {annotationChip(item.annotation)}
            {item.note && <p className="conv-answer">{item.note}</p>}
            {threadButton(item.annotation.id)}
          </>,
        });
      }
      case "revised": {
        const who = item.annotation.author;
        if (!thread) {
          return message({
            key: item.id, who: who === viewerUsername ? "you" : "person",
            name: nameOf(who) || "意见作者", ts: item.ts, ids: [item.annotation.id],
            children: digest("改写了 1 条意见，等重新提交", [item.annotation.id]),
          });
        }
        return message({
          key: item.id, who: who === viewerUsername ? "you" : "person",
          name: nameOf(who) || "意见作者", ts: item.ts, ids: [item.annotation.id],
          tag: <em className="conv-tag neutral">改了意见，待重新提交</em>,
          children: <>{annotationChip(item.annotation)}{threadButton(item.annotation.id)}</>,
        });
      }
      case "sync":
        // 跨仓通知:收到的按"谁 · 哪个仓"署名,发出的署名"你/某某"并说送到了几个仓
        return message({
          key: item.id, who: "external",
          name: item.direction === "received"
            ? `${nameOf(item.by)}${item.repository ? ` · ${item.repository} 仓` : ""}`
            : nameOf(item.by),
          ts: item.ts,
          tag: <em className={`conv-tag ${item.direction === "received" ? "att" : "src"}`}>
            {item.direction === "received" ? "子任务通知" : "已通知所有子任务"}
          </em>,
          children: <div className="conv-sync">
            <p>{item.text}</p>
            <small>{item.direction === "received"
              ? "同一需求的协作通知；Agent 运行或继续时核对影响，无关就继续，有歧义再提问。"
              : item.targets
                ? `已同步主任务和 ${item.targets} 个其他子任务；排队任务启动时读取`
                : "已同步主任务，后续创建的子任务也会收到"}</small>
          </div>,
        });
      case "external": {
        if (!thread) {
          const open = item.items.filter((entry) => entry.status !== "closed").length;
          return message({
            key: item.id, who: "external", name: item.author ?? SOURCE_LABEL[item.source] ?? item.source,
            ts: item.ts,
            tag: <em className="conv-tag src">{SOURCE_LABEL[item.source] ?? item.source}</em>,
            children: digest(
              `提了 ${item.items.length} 条意见${open ? `，${open} 条还没闭环` : "，已全部闭环"}`,
              []),
          });
        }
        return message({
          key: item.id, who: "external", name: item.author ?? SOURCE_LABEL[item.source] ?? item.source,
          ts: item.ts,
          tag: <em className="conv-tag src">{SOURCE_LABEL[item.source] ?? item.source}</em>,
          children: <ul className="conv-external">
            {item.items.map((entry) => (
              <li key={entry.id}>
                {entry.file && <code>{shortPath(entry.file)}{entry.line ? `:${entry.line}` : ""}</code>}
                <span>{entry.summary}</span>
                <em className={`conv-tag ${entry.status === "closed" ? "ok"
                  : entry.status === "needs_human" ? "att" : "neutral"}`}>
                  {FEEDBACK_STATUS_LABEL[entry.status] ?? entry.status}
                </em>
                {entry.resolution && <small>{entry.resolution}</small>}
              </li>
            ))}
          </ul>,
        });
      }
      case "assistant":
        return message({
          key: item.id, who: item.role === "user" ? "you" : "assistant",
          name: item.role === "user" ? "你" : "开发助手", ts: item.ts,
          tag: item.role === "user" ? <em className="conv-tag neutral">接管中</em> : undefined,
          children: <div className={item.role === "user" ? "conv-cli" : "conv-text"}>
            {item.role === "user" ? item.text : <Markdown text={item.text} />}
          </div>,
        });
      default:
        return null;
    }
  }

  /** 流里的意见类条目在非线程视图只留一行:详情在左边的「检视意见」抽屉,
   *  两边摊开同样的字是重复(用户 2026-09-06)。线程视图仍逐条完整。 */
  function digest(lead: string, ids: string[], note?: string): ReactNode {
    return (
      <p className="conv-digest">
        <span>{lead}</span>
        {note && <small>{note}</small>}
        <button type="button" className="conv-act" onClick={() => onOpenReview(ids)}>打开检视意见</button>
      </p>
    );
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

  const recentTools = takeover ? (assistantTools ?? []).slice(-8) : [];

  return (
    <div className="ws-stream-shell">
      {/* 栏头一行:标题 + 筛选;状态与"轮到谁"并成锚条一行。原来栏头、状态行、
          锚条、筛选四行摞着吃掉 180px,流只剩三百多像素(用户 2026-09-05:"都没
          空间显示文字了")。 */}
      <header className="ws-collaboration-head">
        <strong>与 Agent 协作</strong>
        <div className="ws-stream-filters" role="tablist" aria-label="会话流筛选">
          {([["all", "全部"], ["mine", "需要我的"]] as const)
            .map(([key, label]) => (
              <button type="button" key={key} role="tab"
                aria-selected={!thread && filter === key}
                className={!thread && filter === key ? "on" : ""}
                onClick={() => { onThreadChange(undefined); onFilterChange(key); }}>
                {label}
              </button>
            ))}
        </div>
      </header>
      <div className={`ws-anchor ${anchor.tone}`} role="status">
        <i aria-hidden />
        <span className="ws-anchor-text" title={[anchor.text, anchor.detail].filter(Boolean).join(" · ")}>
          <strong>{anchor.text}</strong>
          {anchor.detail && <small>{anchor.detail}</small>}
        </span>
        {anchor.action && (
          <button type="button" onClick={anchor.action.onClick}>{anchor.action.label}</button>
        )}
      </div>
      {thread && (
        <div className="ws-thread-head" role="note">
          <span>
            只看这条意见的处理记录
            {threadAnnotation && <code>{shortPath(threadAnnotation.file)}:{threadAnnotation.line}</code>}
            {threadAnnotation && <small>{threadAnnotation.note}</small>}
          </span>
          <button type="button" onClick={() => onThreadChange(undefined)} aria-label="关闭线程视图">×</button>
        </div>
      )}
      <div className="ws-stream" role="log" aria-live="polite" aria-relevant="additions"
        ref={box}
        onScroll={(event) => { pinned.current = atBottom(event.currentTarget); if (pinned.current) setHasNew(false); }}>
        {hidden > 0 && (
          <button type="button" className="conv-more"
            onClick={() => setLimit((value) => value + INITIAL_LIMIT)}>
            显示更早的 {hidden} 条
          </button>
        )}
        {unavailable && <div className="conv-problem" role="status">{unavailable}</div>}
        {problems.map((problem) => (
          <div className="conv-problem" role="status" key={problem}>{problem}</div>
        ))}
        {!loaded && !unavailable && <div className="conv-empty">正在读取记录…</div>}
        {loaded && !shown.length && !currentCard && (
          <div className="conv-empty">
            {thread ? "这条意见还没有处理记录。"
              : filter === "mine" ? "现在没有需要你处理的事。"
              : "还没有记录。Agent 开始说话、举卡或你提交批注后，会按时间出现在这里。"}
          </div>
        )}
        {rows}
        {pinnedCard && waiting && (
          message({
            key: `card-${waiting.waiting_id}`, who: "agent", name: "Agent",
            ts: waiting.created_at ?? new Date().toISOString(),
            tag: <em className="conv-tag att">{waiting.question?.purpose === "clarification" ? "在追问" : decides ? "等你决定" : "等待答复"}</em>,
            children: <div className="conv-card current">{currentCard}</div>,
          })
        )}
        {recentTools.length > 0 && (
          <details className="conv-tools">
            <summary>开发助手最近 {recentTools.length} 步</summary>
            {recentTools.map((tool) => (
              <div key={tool.call_id} className={`conv-tool ${tool.state}`}>
                <i aria-hidden />
                <b>{tool.name}</b>
                <span>{tool.state === "passed" ? "完成" : tool.state === "failed" ? "失败" : "执行中"}</span>
                {tool.input && <pre>{tool.input}</pre>}
              </div>
            ))}
          </details>
        )}
        {tail && !thread && <div className="conv-tail">{tail}</div>}
      </div>
      {hasNew && (
        <button type="button" className="ws-stream-new" onClick={scrollToEnd}>有新消息 ↓</button>
      )}
    </div>
  );
}
