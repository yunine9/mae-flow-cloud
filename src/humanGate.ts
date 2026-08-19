/**
 * AskUserQuestion → WAITING_FOR_HUMAN(详设 §5/D4)。
 *
 * Agent 按步骤文档提问,问题被自定义工具接住变成结构化 Web 待办;
 * 决定回来后以工具结果按 call_id 回注,Agent 视角与旧插件完全一致。
 *
 * 并发规则:第一个匹配状态版本的决定生效,后到的抛 StateConflictError
 * ——两个浏览器同时审批,不覆盖先到决定。写入用临时文件+rename 保原子。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export class StateConflictError extends Error {}

export interface WaitingRecord {
  waiting_id: string;
  task_id: string;
  step: string;
  call_id: string;
  question: Record<string, unknown>;
  /** 提问前模型的最后一段话:审批卡的上下文。"编译与 UT 命令如上表"
   * 这类指代,表就在这里——不带上它,卡在页面上就是悬空的
   * (真人实战第一单实测)。 */
  context?: string;
  state_version: number;
  status: "waiting" | "resolved";
  decision: string;
  /** 结构化回答(问题→选项)。多问题卡必填;单问题卡可由 decision 派生。 */
  answers?: Record<string, string>;
  notes: string;
  created_at: string;
  resolved_at: string;
  reminders: number;
}

interface Store {
  records: Record<string, WaitingRecord>;
}

function now(): string {
  // 必须保留 Z。旧实现把 UTC 的 T/Z 剥掉，浏览器会把它当成本地时间，
  // 在东八区一张刚生成的卡会立刻显示“等你 8 小时”。
  return new Date().toISOString();
}

export class HumanGate {
  constructor(readonly path: string) {}

  private load(): Store {
    if (!existsSync(this.path)) return { records: {} };
    return JSON.parse(readFileSync(this.path, "utf-8")) as Store;
  }

  private save(store: Store): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = this.path + ".tmp";
    writeFileSync(temporary, JSON.stringify(store, null, 1), "utf-8");
    renameSync(temporary, this.path);
  }

  /** 同一 call_id 幂等返回已有记录:恢复重放不得生成第二张待办。 */
  createWaiting(options: {
    taskId: string;
    step: string;
    callId: string;
    questionInput: Record<string, unknown>;
    context?: string;
  }): WaitingRecord {
    const waitingId = `${options.taskId}:${options.callId}`;
    const store = this.load();
    const existing = store.records[waitingId];
    if (existing) return { ...existing };
    const record: WaitingRecord = {
      waiting_id: waitingId,
      task_id: options.taskId,
      step: options.step,
      call_id: options.callId,
      question: options.questionInput,
      context: options.context || undefined,
      state_version: 1,
      status: "waiting",
      decision: "",
      notes: "",
      created_at: now(),
      resolved_at: "",
      reminders: 0,
    };
    store.records[waitingId] = record;
    this.save(store);
    return { ...record };
  }

  pending(): WaitingRecord[] {
    return Object.values(this.load().records)
      .filter((record) => record.status === "waiting")
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** 消费决定;版本不匹配或已被抢先,抛 StateConflictError。 */
  resolve(
    waitingId: string,
    options: {
      stateVersion: number;
      decision: string;
      answers?: Record<string, string>;
      notes?: string;
    },
  ): WaitingRecord {
    const store = this.load();
    const record = store.records[waitingId];
    if (!record) throw new StateConflictError(`待办 ${waitingId} 不存在`);
    if (record.status !== "waiting") {
      throw new StateConflictError(
        `任务状态已变化:待办 ${waitingId} 已由先到决定完成`);
    }
    if (record.state_version !== options.stateVersion) {
      throw new StateConflictError(
        `任务状态已变化:待办 ${waitingId} 版本不匹配`);
    }
    record.status = "resolved";
    record.decision = String(options.decision);
    if (options.answers && Object.keys(options.answers).length) {
      record.answers = { ...options.answers };
    }
    record.notes = String(options.notes ?? "");
    record.state_version += 1;
    record.resolved_at = now();
    this.save(store);
    return { ...record };
  }
}

/**
 * 决定 → 回注文本。决定顶行,备注跟在后面——旧插件捕获路径吃的
 * 就是这个形状(XXX_RESULT 同款纪律:不挤掉首行)。
 */
export function renderDecision(record: {
  decision: string;
  answers?: Record<string, string>;
  notes?: string;
}): string {
  const answers = record.answers ?? {};
  const decision = Object.keys(answers).length
    ? Object.values(answers).join("\n")
    : String(record.decision ?? "");
  const notes = String(record.notes ?? "");
  return notes ? `${decision}\n${notes}` : decision;
}
