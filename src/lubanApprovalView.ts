/** 小鲁班纯文本审批的展示层；不持有会话或审批状态。 */

import type { WaitingRecord } from "./humanGate.ts";
import type { TaskSummary } from "./taskService.ts";

export interface LubanApprovalQuestion {
  question: string;
  options: string[];
}

const MAX_RESPONSE_CHARS = 3_800;

function oneLine(value: string, limit = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > limit
    ? normalized.slice(0, limit - 1) + "…" : normalized;
}

function excerpt(value: string, limit: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized.length > limit
    ? normalized.slice(0, limit - 1) + "…" : normalized;
}

function capReply(text: string): string {
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  return text.slice(0, MAX_RESPONSE_CHARS - 24) + "\n\n内容较长，已截断。";
}

function taskLabel(task: TaskSummary): string {
  if (task.entry_kind === "dts") {
    return `问题单 ${task.ticket ?? task.id} · ${task.id}`;
  }
  return task.ticket ? `需求 ${task.ticket} · ${task.id}` : task.id;
}

export function questionsOf(waiting: WaitingRecord): LubanApprovalQuestion[] {
  const raw = (waiting.question as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): LubanApprovalQuestion[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as { question?: unknown; options?: unknown };
    const question = String(record.question ?? "").trim();
    if (!question) return [];
    const options = Array.isArray(record.options)
      ? record.options.map(String).map((value) => value.trim()).filter(Boolean)
      : [];
    return [{ question, options }];
  });
}

export function renderLubanHelp(): string {
  return [
    "Mae-Flow 手机审批指令：",
    "mae-flow 待审批（直接展示唯一待办的完整详情）",
    "选项合适回复序号；不合适回复“自由回复：你的答案或修改要求”",
    "多题卡会逐题记录，全部答完后一次提交",
    "全是选项题时可用斜杠一次回复，如三题回复 1/2/1",
    "答错可回复“重答上一题”",
    "mae-flow 详情 <审批码>",
    "mae-flow 选择 <审批码> <选项序号>",
    "mae-flow 通过 <审批码>",
    "mae-flow 退回 <审批码> <意见>",
  ].join("\n");
}

export function renderLubanTaskList(tasks: TaskSummary[], total: number): string {
  const lines = [`你有 ${total} 项待审批：`];
  tasks.forEach((task, index) => {
    const waiting = task.waiting!;
    const questions = questionsOf(waiting);
    lines.push("", `${index + 1}. ${taskLabel(task)} · ${oneLine(task.title ?? task.requirement, 80)}`);
    lines.push(`阶段：${oneLine(waiting.step || "当前步骤", 50)}`);
    lines.push(`事项：${oneLine(questions[0]?.question ?? "需要你确认", 110)}`);
    if (questions.length > 1) {
      lines.push(`提示：包含 ${questions.length} 个问题，选择任务后可逐题处理`);
    }
  });
  lines.push("", "直接回复任务序号查看完整详情。" );
  if (total > tasks.length) {
    lines.push("", `另有 ${total - tasks.length} 项，请处理后再次查询。`);
  }
  return capReply(lines.join("\n"));
}

export function renderLubanDetail(
  task: TaskSummary,
  code: string,
  currentQuestion = 0,
): string {
  const waiting = task.waiting!;
  const questions = questionsOf(waiting);
  const lines = [
    `【${code}】${taskLabel(task)} · ${oneLine(task.title ?? task.requirement, 100)}`,
    `阶段：${oneLine(waiting.step || "当前步骤", 80)}`,
  ];
  if (questions.length > 1) {
    lines.push(currentQuestion > 0
      ? `共 ${questions.length} 个问题；已记录 ${currentQuestion} 个，全部答完后统一提交。`
      : `共 ${questions.length} 个问题；将按顺序逐题记录，全部答完后统一提交。`);
  }
  if (waiting.context?.trim()) {
    lines.push("", "审批上下文：", excerpt(waiting.context, 1_000));
  }
  if (!questions.length) {
    lines.push("", "当前待办没有可读取的问题，请在电脑端处理。" );
    return capReply(lines.join("\n"));
  }
  questions.forEach((question, index) => {
    lines.push("", `${questions.length > 1 ? `问题 ${index + 1}：` : "问题："}${question.question}`);
    question.options.forEach((option, optionIndex) =>
      lines.push(`${optionIndex + 1}. ${option}`));
  });
  if (questions.length > 1) {
    const index = Math.min(currentQuestion, questions.length - 1);
    lines.push("", `${currentQuestion > 0 ? "请继续" : "请先"}回答问题 ${index + 1}，随后会提示下一题。` );
    lines.push("回复方式：", "- 选项合适：回复序号", "- 选项不合适：回复“自由回复：你的答案或修改要求”");
    if (questions.every((question) => question.options.length)) {
      const example = Array.from(
        { length: questions.length - index }, () => "1").join("/");
      lines.push(`也可一次回复剩余各题的选项序号，如“${example}”（仅为格式示例）。`);
    }
    lines.push("答错可回复“重答上一题”。" );
  } else if (questions[0].options.length) {
    lines.push("", "回复方式：", "- 选项合适：回复序号", "- 选项不合适：回复“自由回复：你的答案或修改要求”" );
    lines.push(`无上下文备用：mae-flow 选择 ${code} <序号>`);
  } else {
    lines.push("", "直接回复你的答复。" );
    lines.push(`无上下文备用：mae-flow 回复 ${code} <答复>`);
  }
  return capReply(lines.join("\n"));
}

/** 多题会话每次只追问当前一题，避免各题都从 1 编号时发生答案错配。 */
export function renderLubanQuestionPrompt(
  question: LubanApprovalQuestion,
  index: number,
  total: number,
): string {
  const lines = [`问题 ${index + 1}/${total}：${question.question}`];
  question.options.forEach((option, optionIndex) =>
    lines.push(`${optionIndex + 1}. ${option}`));
  if (question.options.length) {
    lines.push("回复方式：", "- 选项合适：回复序号", "- 选项不合适：回复“自由回复：你的答案或修改要求”");
  } else {
    lines.push("请直接自由回复当前问题的答案。" );
  }
  if (index > 0) lines.push("答错可回复“重答上一题”。" );
  return capReply(lines.join("\n"));
}
