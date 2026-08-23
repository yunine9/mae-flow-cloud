export type EventFilter = "all" | "messages" | "tools" | "errors";

export interface FilterableEvent {
  kind: string;
  payload: Record<string, unknown>;
}

export function isErrorEvent(event: FilterableEvent): boolean {
  return event.payload.is_error === true || /error|failed/i.test(event.kind);
}

export function matchesEventFilter(
  event: FilterableEvent,
  filter: EventFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "errors") return isErrorEvent(event);
  if (filter === "messages") {
    return event.kind === "user_message" || event.kind === "assistant_message";
  }
  return event.kind === "tool_requested" || event.kind === "tool_finished";
}

export function filterEvents<T extends FilterableEvent>(
  events: T[],
  filter: EventFilter,
): T[] {
  return filter === "all"
    ? events
    : events.filter((event) => matchesEventFilter(event, filter));
}

/** 事件完整保留，只限制一次挂进 DOM 的数量；用户可逐批查看更早记录。 */
export function eventWindow<T>(
  events: T[],
  limit: number,
): { items: T[]; hidden: number } {
  const size = Math.max(1, Math.floor(limit));
  const hidden = Math.max(0, events.length - size);
  return { items: events.slice(hidden), hidden };
}

export function eventFilterCounts(
  events: FilterableEvent[],
): Record<EventFilter, number> {
  return {
    all: events.length,
    messages: events.filter((event) => matchesEventFilter(event, "messages")).length,
    tools: events.filter((event) => matchesEventFilter(event, "tools")).length,
    errors: events.filter(isErrorEvent).length,
  };
}
