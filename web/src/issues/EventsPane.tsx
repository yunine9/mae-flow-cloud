/**
 * 现场域:执行现场页签(SSE 直播)。
 *
 * 从 IssueBoard.tsx 原文搬移(spec #2 按域拆分,纯搬移零行为变化):
 * 结构照搬任务侧 EventTail——筛选器 + 贴底跟随 + 色调标记,一种读法。
 * 数据源换成问题流的 SSE(tailIssueEvents),只陈列不解读。贴底跟随
 * 用两域共用的 useStickyBottom(stickyBottom.ts,判据见 follow.ts),
 * 本地复刻已删除;事件筛选/窗口/计数在 eventView.ts。
 */
import { useEffect, useState } from "react";
import { tailIssueEvents, type SemanticEvent } from "../api";
import {
  eventFilterCounts,
  eventWindow,
  filterEvents,
  isErrorEvent,
  type EventFilter,
} from "../eventView";
import { formatLocalDateTime } from "../time";
import { useStickyBottom } from "../stickyBottom";

const ISSUE_EVENT_KIND_LABEL: Record<string, string> = {
  session_started: "会话开始",
  user_message: "用户指令",
  assistant_message: "Agent 回复",
  tool_requested: "调用工具",
  tool_finished: "工具结果",
  turn_finished: "本轮结束",
  session_ended: "会话结束",
  human_decision: "人工决策",
  task_status_changed: "状态变化",
};

const ISSUE_EVENT_FIELD_LABEL: Record<string, string> = {
  text: "内容",
  name: "工具",
  input: "输入",
  result: "结果",
  reason: "原因",
  answers: "答复",
  is_error: "执行异常",
  resume: "恢复会话",
  call_id: "调用编号",
  detail: "详情",
};

function issueEventTone(event: SemanticEvent): string {
  if (isErrorEvent(event)) return "danger";
  if (event.kind === "tool_finished" || event.kind === "turn_finished") {
    return "success";
  }
  if (event.kind === "assistant_message") return "agent";
  if (event.kind === "user_message") return "user";
  return "neutral";
}

function IssueEventValue({ value }: { value: unknown }) {
  if (typeof value === "string") {
    if (value.length > 480) {
      return <details className="event-value-expand">
        <summary>
          <span>{value.slice(0, 180).trim()}…</span>
          <small>展开完整内容 · {value.length} 字</small>
        </summary>
        <pre>{value}</pre>
      </details>;
    }
    return <span className="event-value-text">{value || "（空）"}</span>;
  }
  if (typeof value === "boolean") {
    return <code className="event-value-atom">{value ? "是" : "否"}</code>;
  }
  if (value === null || value === undefined || typeof value === "number") {
    return <code className="event-value-atom">{String(value)}</code>;
  }
  const structured = JSON.stringify(value, null, 2);
  return <details className="event-value-expand structured">
    <summary>
      <span>结构化内容</span>
      <small>展开查看 · {structured.split("\n").length} 行</small>
    </summary>
    <pre>{structured}</pre>
  </details>;
}

function IssueEventRecord({ event }: { event: SemanticEvent }) {
  const fields = Object.entries(event.payload ?? {});
  return (
    <article className={`event-record ${issueEventTone(event)}`}>
      <header>
        <span className="event-record-dot" aria-hidden />
        <strong>{ISSUE_EVENT_KIND_LABEL[event.kind] ?? event.kind}</strong>
        <code>#{event.eventId}</code>
        <time dateTime={event.ts}
          title={formatLocalDateTime(event.ts, { seconds: true, year: true })}>
          {formatLocalDateTime(event.ts, { seconds: true })}
        </time>
      </header>
      {fields.length === 0 ? (
        <div className="event-record-empty">本事件没有附加内容</div>
      ) : (
        <dl>
          {fields.map(([field, value]) => (
            <div key={field}>
              <dt>{ISSUE_EVENT_FIELD_LABEL[field] ?? field}</dt>
              <dd><IssueEventValue value={value} /></dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}

export function IssueEventsPane({ id, active }: { id: string; active: boolean }) {
  const PAGE_SIZE = 120;
  const [events, setEvents] = useState<SemanticEvent[]>([]);
  const [connection, setConnection] = useState<
    "connecting" | "live" | "reconnecting">("connecting");
  const [filter, setFilter] = useState<EventFilter>("all");
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const filtered = filterEvents(events, filter);
  const visible = eventWindow(filtered, visibleLimit);
  const counts = eventFilterCounts(events);
  const follow = useStickyBottom<HTMLDivElement>(filtered.length);

  // 挂载与切回现场页签时无条件回到最新:用户第一眼要看的是最新的消息,
  // 历史分批装载期间也钉住底部(人上翻才撒手,见 useStickyBottom)。
  useEffect(() => {
    if (active) follow.resync();
    // resync 闭包随渲染更新;这里只随面板挂载/激活触发。
  }, [active]);

  useEffect(() => {
    setEvents([]);
    setConnection("connecting");
    setVisibleLimit(PAGE_SIZE);
  }, [id]);

  useEffect(() => setVisibleLimit(PAGE_SIZE), [filter]);

  useEffect(() => {
    if (!active) return;
    const stop = tailIssueEvents(id, (event: SemanticEvent) => {
      setEvents((previous) => previous.some((item) => (
        item.eventId === event.eventId
      )) ? previous : [...previous, event]);
    }, setConnection);
    return stop;
  }, [active, id]);

  return (
    <div className="event-panel-body">
      <div className={`event-live-state ${connection}`}>
        <i aria-hidden />
        <span>{!active ? "实时连接已暂停"
          : connection === "live" ? "实时接收中"
            : connection === "reconnecting" ? "连接中断,正在自动重连"
              : "正在连接问题现场"} · {events.length} 条
          {follow.paused ? " · 已暂停跟随" : ""}
        </span>
      </div>
      <div className="event-filters" role="group" aria-label="筛选原始事件">
        {([
          ["all", "全部"],
          ["messages", "消息"],
          ["tools", "工具"],
          ["errors", "异常"],
        ] as Array<[EventFilter, string]>).map(([value, label]) => (
          <button type="button" key={value}
            className={filter === value ? "active" : ""}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}>
            {label}<span>{counts[value]}</span>
          </button>
        ))}
      </div>
      {follow.paused && (
        <div className="event-follow">
          <span>已暂停跟随,你正在往回看——新事件仍在接收。</span>
          <button type="button" className="follow-resume" onClick={follow.toBottom}>
            {follow.behind > 0 ? `↓ ${follow.behind} 条新的` : "↓ 回到最新"}
          </button>
        </div>
      )}
      <div ref={follow.ref} className="event-stream"
           onScroll={follow.onScroll}>
        {visible.hidden > 0 && (
          <button type="button" className="event-load-earlier"
            onClick={() => setVisibleLimit((current) => current + PAGE_SIZE)}>
            查看更早的 {Math.min(PAGE_SIZE, visible.hidden)} 条
            <small>仍有 {visible.hidden} 条未挂载</small>
          </button>
        )}
        {events.length === 0 && (
          <div className="event-empty">
            <span aria-hidden />
            <strong>正在连接问题现场</strong>
            <small>新的执行动作会实时出现在这里。</small>
          </div>
        )}
        {events.length > 0 && filtered.length === 0 && (
          <div className="event-empty filtered">
            <strong>这个筛选下没有事件</strong>
            <small>原始事件没有丢失,可以切回"全部"继续查看。</small>
          </div>
        )}
        {visible.items.map((event) => (
          <IssueEventRecord event={event} key={event.eventId} />
        ))}
      </div>
    </div>
  );
}
