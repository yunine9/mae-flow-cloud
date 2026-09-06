/**
 * 问题域协作流投影(ADR-0018):events.jsonl 账本 → 任务侧
 * ConversationItem 同形状的条目数组,供「与 Agent 协作」对话框消费。
 *
 * 与过程问答投影(documents.ts 的 projectDialogue)是同一条现场记录的
 * 两个投影:过程问答是复盘阅读(只留问答与用户输入,ADR-0008),本投影
 * 是协作流回放(回合/卡/裁决/插话/检视/回执六类),口径不同互不替代。
 *
 * 纪律同全部投影:旁路、fail-open、只追加——坏事件跳过,缺账本给空,
 * 绝不抛错拖垮页面;触顶保留最新并如实标注。
 */

/** 一条事件账本行(只取投影消费的字段,写入方见 service.appendSessionEvent
 * 与 driver 的事件落账;形状对齐 semanticEvents.SemanticEvent)。 */
export interface IssueConversationEvent {
  eventId?: number;
  ts?: string;
  kind?: string;
  payload?: Record<string, unknown>;
}

export interface IssueConversationQuestion {
  question: string;
  options: string[];
}

/** 任务侧 ConversationItem(web/api)的问题域子集+扩展:字段名与任务
 * 侧同名的成员(session/turn/card/decision/steer)保持逐字段兼容,前端
 * 会话流组件可按同一条渲染路径走;receipts 是问题域扩展(平台工具回执
 * 的流内留痕,任务侧同名的检视闭环成员在问题域无对应物)。 */
export type IssueConversationItem =
  | { kind: "session"; id: string; ts: string;
      phase: "started" | "ended"; resume?: boolean; detail?: string }
  | { kind: "turn"; id: string; ts: string; end_ts?: string;
      texts: Array<{ ts: string; text: string;
        role: "narration" | "handoff" }>;
      steps: IssueConversationSteps; open: boolean }
  | { kind: "card"; id: string; ts: string; waiting_id?: string; step?: string;
      purpose: "confirmation" | "clarification";
      questions: IssueConversationQuestion[];
      status: "waiting" | "resolved" }
  | { kind: "decision"; id: string; ts: string; waiting_id?: string; by?: string;
      decision: string; notes?: string;
      purpose: "confirmation" | "clarification";
      questions?: IssueConversationQuestion[] }
  | { kind: "steer"; id: string; ts: string; text: string; delivered: boolean }
  | { kind: "review"; id: string; ts: string; count: number; text: string }
  | { kind: "receipts"; id: string; ts: string;
      items: Array<{ name: string; outcome: "success" | "error"; summary: string }> };

/** 回合步骤计数(形状对齐任务侧 ConversationSteps)。 */
export interface IssueConversationSteps {
  calls: number;
  errors: number;
  bash: number;
  sample: Array<{ kind: "bash" | "tool"; subject: string }>;
}

export interface IssueConversationView {
  items: IssueConversationItem[];
  /** 账本里读到的全部事件行数(含被投影跳过的)——前端"已读水位"。 */
  events_seen: number;
  truncated: boolean;
}

export interface IssueConversationOptions {
  /** 会话是否运行中:悬置回合照常呈现为 open,在场闸投影为 waiting 卡。 */
  running?: boolean;
  /** 当前在场未作答的平台闸(从会话状态来,不在账本里):投影为流末尾
   * 的 waiting 卡。 */
  waitingCard?: {
    waiting_id?: string;
    step?: string;
    question?: string;
    options?: string[];
  };
  /** 条目数上限(触顶保留最新)。 */
  maxItems?: number;
}

const DEFAULT_MAX_ITEMS = 800;
const STEP_SAMPLE_LIMIT = 8;
const RECEIPTS_SUMMARY_LIMIT = 120;

/** 一行结果文本 → 回执摘要(首行,截断)。 */
function receiptSummary(result: unknown): string {
  const firstLine = String(result ?? "").split("\n")[0]?.trim() ?? "";
  return firstLine.length > RECEIPTS_SUMMARY_LIMIT
    ? firstLine.slice(0, RECEIPTS_SUMMARY_LIMIT) + "…"
    : firstLine;
}

/** AskUserQuestion 入参 → 问题清单(形状读不出来当没有;选项兼容
 * 字符串与 {code,label} 两种现场,码是投影层的事,人看文案)。 */
function cardQuestions(input: unknown): IssueConversationQuestion[] {
  const questions = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.map((item) => {
    const record = (item ?? {}) as { question?: unknown; options?: unknown };
    const options = Array.isArray(record.options)
      ? record.options
        .map((option) => typeof option === "string"
          ? option
          : String((option as { label?: unknown })?.label ?? ""))
        .filter(Boolean)
      : [];
    return { question: String(record.question ?? ""), options };
  });
}

/** 事件账本 → 协作流条目。纯函数:不读盘、不改状态,事件行由调用方
 * 给(service 从账本读,测试直接构造)。 */
export function issueConversation(
  events: IssueConversationEvent[],
  options: IssueConversationOptions = {},
): IssueConversationView {
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const items: IssueConversationItem[] = [];

  /** 当前悬置回合(assistant 发言与工具步骤的聚合容器)。 */
  let turn: Extract<IssueConversationItem, { kind: "turn" }> | undefined;
  const closeTurn = () => {
    if (!turn) return;
    turn.open = false;
    turn.end_ts = turn.texts.at(-1)?.ts ?? turn.ts;
    // 收口语:收口前的最后一句 agent 发言是交接语,其余是过程话。
    if (turn.texts.length > 0) {
      turn.texts[turn.texts.length - 1].role = "handoff";
    }
    turn = undefined;
  };

  for (const event of events) {
    const kind = String(event?.kind ?? "");
    const payload = (event?.payload ?? {}) as Record<string, unknown>;
    const ts = String(event?.ts ?? "");
    const id = String(event?.eventId ?? ts);

    switch (kind) {
      case "session_started":
        closeTurn();
        items.push({ kind: "session", id, ts, phase: "started",
          ...(payload.resume === true ? { resume: true } : {}) });
        break;
      case "session_ended":
        closeTurn();
        items.push({ kind: "session", id, ts, phase: "ended",
          ...(payload.detail ? { detail: String(payload.detail) } : {}) });
        break;
      case "assistant_message": {
        if (!turn) {
          turn = { kind: "turn", id, ts, texts: [],
            steps: { calls: 0, errors: 0, bash: 0, sample: [] },
            open: true };
          items.push(turn);
        }
        turn.texts.push({ ts, text: String(payload.text ?? ""), role: "narration" });
        break;
      }
      case "tool_requested": {
        const name = String(payload.name ?? "");
        if (name === "AskUserQuestion") {
          items.push({ kind: "card", id, ts, purpose: "clarification",
            questions: cardQuestions(payload.input), status: "resolved" });
          break;
        }
        if (!turn) {
          turn = { kind: "turn", id, ts, texts: [],
            steps: { calls: 0, errors: 0, bash: 0, sample: [] },
            open: true };
          items.push(turn);
        }
        turn.steps.calls += 1;
        if (name === "bash") {
          turn.steps.bash += 1;
          if (turn.steps.sample.length < STEP_SAMPLE_LIMIT) {
            const input = (payload.input ?? {}) as { command?: unknown };
            turn.steps.sample.push({ kind: "bash",
              subject: String(input.command ?? "").slice(0, 60) });
          }
        } else if (turn.steps.sample.length < STEP_SAMPLE_LIMIT) {
          turn.steps.sample.push({ kind: "tool", subject: name });
        }
        break;
      }
      case "tool_finished": {
        // 工具结果只补错误计数(调用本身在 tool_requested 已计);平台
        // 工具回执另出 receipts 条目留痕,相邻回执聚成一组,不刷屏。
        const name = String(payload.name ?? "");
        const error = payload.is_error === true;
        if (turn && error) turn.steps.errors += 1;
        if (name && name !== "AskUserQuestion") {
          const entry = { name, outcome: error ? "error" as const : "success" as const,
            summary: receiptSummary(payload.result) };
          const last = items.at(-1);
          if (last?.kind === "receipts") last.items.push(entry);
          else items.push({ kind: "receipts", id, ts, items: [entry] });
        }
        break;
      }
      case "user_message":
        closeTurn();
        items.push({ kind: "steer", id, ts,
          text: String(payload.text ?? ""), delivered: true });
        break;
      case "human_decision":
        closeTurn();
        items.push({ kind: "decision", id, ts,
          waiting_id: String(payload.waiting_id ?? ""),
          decision: String(payload.decision ?? ""),
          ...(payload.notes ? { notes: String(payload.notes) } : {}),
          // 平台闸作答带问句快照(闸答完即从 issue.json 消失,问句只能
          // 随事件走)——快照在场即平台确认,缺席是 Agent 卡的澄清答复。
          ...((payload.gate as { questions?: unknown } | undefined)?.questions
            ? { purpose: "confirmation" as const,
              questions: cardQuestions(payload.gate) }
            : { purpose: "clarification" as const }) });
        break;
      case "review_submitted":
        items.push({ kind: "review", id, ts,
          count: Number(payload.count ?? 0),
          text: String(payload.text ?? "") });
        break;
      case "turn_finished":
        closeTurn();
        break;
      default:
        break; // agent_spawned/session 之外的过程事件不进协作流
    }
  }

  // 在场未作答的平台闸:不在账本里(答了才落账),从会话状态投影为
  // waiting 卡,钉在流末尾——协作流的"现在进行时"。闸在场即等待,
  // 不看运行位。
  if (options.waitingCard) {
    items.push({ kind: "card", id: options.waitingCard.waiting_id || "live",
      ts: "", waiting_id: options.waitingCard.waiting_id,
      step: options.waitingCard.step,
      purpose: "confirmation",
      questions: options.waitingCard.question
        ? [{ question: options.waitingCard.question,
          options: options.waitingCard.options ?? [] }]
        : [],
      status: "waiting" });
  }

  const truncated = items.length > maxItems;
  return {
    items: truncated ? items.slice(-maxItems) : items,
    events_seen: events.length,
    truncated,
  };
}
