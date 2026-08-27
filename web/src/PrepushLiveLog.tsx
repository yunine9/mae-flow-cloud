/**
 * 推送前验证实时过程(用户点名的可观测性缺口:编译过程、执行命令必须
 * 看得见)。只渲染服务端事件不做推断;验证进行中订阅 SSE,收口后保留
 * 末尾现场供回看。换轮由服务端切文件从头重放,前端只管去重与渲染。
 */

import { useEffect, useRef, useState } from "react";
import {
  tailPrepushEvents,
  type SemanticEvent,
  type SseConnectionState,
} from "./api";

const MAX_LINES = 400;
const RESULT_TAIL_LINES = 12;

interface LiveLine {
  key: string;
  kind: "cmd" | "out" | "err" | "note";
  text: string;
}

function clip(value: string, limit: number): string {
  const normalized = value.replace(/\r/g, "");
  return normalized.length > limit
    ? `${normalized.slice(0, limit)}…` : normalized;
}

function linesOf(event: SemanticEvent): LiveLine[] {
  const payload = event.payload as {
    name?: unknown;
    input?: { command?: unknown; path?: unknown; file_path?: unknown };
    result?: unknown;
    is_error?: unknown;
    text?: unknown;
  };
  const key = `${event.sessionId ?? "main"}:${event.eventId}`;
  switch (event.kind) {
    case "tool_requested": {
      const name = String(payload.name ?? "");
      if (/^bash$/i.test(name)) {
        return [{
          key, kind: "cmd",
          text: `$ ${clip(String(payload.input?.command ?? ""), 600)}`,
        }];
      }
      if (/^(edit|write)$/i.test(name)) {
        const path = payload.input?.path ?? payload.input?.file_path ?? "";
        return [{ key, kind: "note", text: `✎ 修改 ${clip(String(path), 200)}` }];
      }
      return [];
    }
    case "tool_finished": {
      if (!/^bash$/i.test(String(payload.name ?? ""))) return [];
      // 全量输出在轮目录的 bash 日志里;这里给结尾片段够定位即可。
      const tail = clip(String(payload.result ?? ""), 4_000)
        .split("\n").filter((line) => line.trim()).slice(-RESULT_TAIL_LINES);
      return tail.map((line, index) => ({
        key: `${key}:${index}`,
        kind: payload.is_error ? "err" as const : "out" as const,
        text: line,
      }));
    }
    case "assistant_message": {
      const text = String(payload.text ?? "").trim();
      return text
        ? [{ key, kind: "note", text: clip(text, 300) }] : [];
    }
    default:
      return [];
  }
}

export function PrepushLiveLog({
  taskId,
  active,
  source = tailPrepushEvents,
  title = "编译过程",
  emptyText = "等待编译 Agent 的第一条命令……",
}: {
  taskId: string;
  /** 验证是否进行中:进行中订阅;结束后不再订阅但保留已收现场。 */
  active: boolean;
  /** 事件源(默认 prepush;环境预热等同构流复用本组件时替换)。 */
  source?: typeof tailPrepushEvents;
  title?: string;
  emptyText?: string;
}) {
  const [lines, setLines] = useState<LiveLine[]>([]);
  const [state, setState] = useState<SseConnectionState>("connecting");
  const seen = useRef(new Set<string>());
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    seen.current = new Set();
    setLines([]);
    return source(taskId, (event) => {
      // EventSource 断线重连时服务端整文件重放:按事件锚去重。
      const anchor = `${event.sessionId ?? "main"}:${event.eventId}`;
      if (seen.current.has(anchor)) return;
      seen.current.add(anchor);
      const next = linesOf(event);
      if (next.length) {
        setLines((current) => [...current, ...next].slice(-MAX_LINES));
      }
    }, setState);
  }, [taskId, active]);
  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines]);
  if (!active && lines.length === 0) return null;
  return <div className="prepush-live" aria-label="推送前编译实时过程">
    <div className="prepush-live-head">
      <strong>{title}</strong>
      {active
        ? <span className={`prepush-live-state is-${state}`}>{
          state === "live" ? "实时"
            : state === "connecting" ? "连接中" : "重连中"}</span>
        : <span className="prepush-live-state is-done">已结束,保留末尾现场</span>}
    </div>
    <div className="prepush-live-body" ref={scroller}>
      {lines.length === 0
        && <p className="prepush-live-empty">{emptyText}</p>}
      {lines.map((line) => <pre
        key={line.key} className={`line-${line.kind}`}>{line.text}</pre>)}
    </div>
  </div>;
}

/** 与服务端 prepush.state 对齐的"进行中"集合;PrepushStatus 的文案
 * 已各自描述,这里只回答要不要开实时流。 */
export function prepushActive(state?: string): boolean {
  return ["queued", "preparing", "compiling", "testing", "unit_testing",
    "ut", "repairing"].includes(String(state ?? ""));
}
