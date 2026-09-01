/**
 * 语义事件:Pi 事件进内核前的唯一形状(详设 §2)。
 *
 * 事件日志是追加式 JSONL,PostgreSQL 投影与恢复重放都以它为源;
 * `.mae-flow.json` 仍是阶段真相,事件日志不是第二个状态机。
 * 幂等锚是任务内单调递增的 eventId:重放同一事件是 no-op,
 * 乱序/回退的 eventId 被拒收。
 *
 * 服务是单 Node 进程,追加天然串行,不需要跨进程文件锁——
 * 这是从 Python 版(多进程 Hook 场景)迁移时被删掉的机制,不是遗漏。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type SemanticEventKind =
  | "session_started"
  | "user_message"
  | "assistant_message"
  | "tool_requested"
  | "tool_output"
  | "tool_finished"
  | "agent_spawned"
  | "agent_finished"
  | "turn_finished"
  | "session_ended"
  | "human_decision"
  /** 检视提交(问题域,ADR-0007):用户对分析报告的检视意见清单落账
   * ——过程问答投影靠它呈现"这轮为什么重跑"。 */
  | "review_submitted";

export interface SemanticEvent {
  eventId: number;
  taskId: string;
  sessionId: string;
  ts: string;
  kind: SemanticEventKind;
  payload: Record<string, unknown>;
}

/** 每种事件 payload 的最小充分集——字段名对齐内核消费的真实名字(详设 §1)。 */
const REQUIRED_PAYLOAD: Record<SemanticEventKind, readonly string[]> = {
  session_started: ["resume"],
  user_message: ["text"],
  assistant_message: ["text"],
  tool_requested: ["call_id", "name", "input"],
  tool_output: ["name", "text", "log_path"],
  tool_finished: ["call_id", "name", "input", "is_error", "result"],
  agent_spawned: [
    "call_id", "agent_type", "description", "prompt", "child_session_id"],
  agent_finished: ["call_id", "child_session_id", "lifecycle", "final_text"],
  turn_finished: ["reason"],
  session_ended: ["reason", "detail"],
  human_decision: ["waiting_id", "state_version", "decision", "notes"],
  review_submitted: ["count", "text"],
};

export function validateEvent(event: SemanticEvent): string {
  if (!(event.kind in REQUIRED_PAYLOAD)) return `未知事件种类: ${event.kind}`;
  if (!Number.isInteger(event.eventId) || event.eventId <= 0) {
    return "eventId 必须是正整数";
  }
  if (!event.taskId) return "缺少 taskId";
  const missing = REQUIRED_PAYLOAD[event.kind].filter(
    (name) => !(name in event.payload));
  if (missing.length) return `${event.kind} 缺少字段: ${missing.join("、")}`;
  return "";
}

export class EventLogError extends Error {}

/**
 * 追加式任务事件日志。append 语义:
 * - eventId > last:写入,返回 true;
 * - eventId <= last:重放,no-op 返回 false(恢复时安全重灌);
 * - 畸形事件:抛 EventLogError——静默丢事件会让投影缺页还查不出来。
 */
export class EventLog {
  private last: number | null = null;

  /** mirror:每条新写入事件的旁路投影(PostgreSQL 等)。只在真正
   * 追加成功后调用;重放 no-op 不触发。旁路自己 fail-open,
   * 这里不 await——投影永远不能拖慢或拖垮事件落盘。 */
  constructor(
    readonly path: string,
    private mirror?: (event: SemanticEvent) => void,
  ) {}

  lastEventId(): number {
    if (this.last === null) {
      this.last = 0;
      for (const row of this.rows()) {
        this.last = Math.max(this.last, Number(row.eventId ?? 0));
      }
    }
    return this.last;
  }

  append(event: SemanticEvent): boolean {
    const error = validateEvent(event);
    if (error) throw new EventLogError(error);
    if (event.eventId <= this.lastEventId()) return false;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(event) + "\n", "utf-8");
    this.last = event.eventId;
    try {
      this.mirror?.(event);
    } catch {
      // 旁路失败=没投影,由旁路自己记日志;事件已落盘,追加语义不受影响。
    }
    return true;
  }

  replay(): SemanticEvent[] {
    return this.rows() as unknown as SemanticEvent[];
  }

  private rows(): Array<Record<string, unknown>> {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line, index) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch (cause) {
          throw new EventLogError(
            `事件日志损坏(${this.path} 第 ${index + 1} 行): ${cause}`);
        }
      });
  }
}
