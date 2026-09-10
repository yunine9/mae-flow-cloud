import { createHash } from "node:crypto";
import type { HumanGate, WaitingRecord } from "./humanGate.ts";

export const MR_DESCRIPTION_STEP = "cloud_mr_description";
export function mrDescriptionCallId(ticket: string): string {
  return `mr-description-${createHash("sha256").update(ticket).digest("hex").slice(0, 24)}`;
}
export function mrDescriptionAnswer(waiting: WaitingRecord): string {
  return String(Object.values(waiting.answers ?? {})[0] ?? waiting.decision).trim();
}
export function savedMrDescription(gate: HumanGate, taskId: string, ticket: string): string | undefined {
  const record = gate.get(`${taskId}:${mrDescriptionCallId(ticket)}`);
  return record?.status === "resolved" ? mrDescriptionAnswer(record) || undefined : undefined;
}
export function askMrDescription(gate: HumanGate, taskId: string, ticket: string): WaitingRecord {
  return gate.createWaiting({ taskId, step: MR_DESCRIPTION_STEP, callId: mrDescriptionCallId(ticket),
    questionInput: { purpose: "clarification", questions: [{
      question: `请填写 AR 单号 ${ticket} 对应的准确描述（将原样用作 MR 标题）`, options: [],
    }] },
    context: "合入时要求 MR 标题与关联 AR 单的描述一致，平台暂时无法读取这段描述。请从 AR 单复制准确描述；填写后继续创建 MR，同一 AR 后续修复无需重复填写。",
  });
}
