import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stepChoiceEffects } from "./kernelChoices.ts";
import { REVIEW_ADJUST, REVIEW_HOLD } from "./reviewDecisionContract.ts";
import type { HumanGate } from "./humanGate.ts";

/** 只消费内核显式要求重确认的事实，不把普通阶段变化或日志文案当成
 * 新审批。同一内容对应同一个 waiting ID，重放不会重复索取决定。 */
export function pendingKernelReview(cwd: string, kernelRoot: string, gate: HumanGate, taskId: string) {
  const path = join(cwd, ".mae-flow.json");
  if (!existsSync(path)) return;
  const state = JSON.parse(readFileSync(path, "utf8"));
  const request = state.approval_request, subject = state.approval_subject;
  if (!request || request.step !== state.current || subject?.step !== request.step
      || request.subject_id !== subject.id || !/^[a-f0-9]{16}$/.test(subject.id)) return;
  const callId = `kernel-review-${request.step}-${subject.id}`;
  const previous = gate.get(`${taskId}:${callId}`);
  if (previous?.status === "resolved" || previous?.status === "superseded") return;
  const confirmation = stepChoiceEffects(kernelRoot, request.step)
    .find(effect => effect.closesFeedback)?.answers[0];
  if (!confirmation) throw new Error(`内核要求重确认，但步骤 ${request.step} 缺少确认契约`);
  return { callId, input: {
    purpose: "confirmation", context: "检视内容在上次确认后发生变化，请核对更新后的材料。",
    questions: [{ question: "更新后的检视内容是否确认？", options: [confirmation, REVIEW_ADJUST, REVIEW_HOLD], recommended: REVIEW_HOLD }],
  } };
}
