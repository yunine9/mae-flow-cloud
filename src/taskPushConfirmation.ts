import { deliveryChangeSnapshot } from "./artifacts.ts";
import { TaskHostLedger, type HostOperation } from "./taskHostTools.ts";
import type { TaskSummary } from "./taskService.ts";
import type { HumanGate } from "./humanGate.ts";

export const HOST_PUSH_CONFIRM_STEP = "host_push_confirm";
interface PushConfirmationHost {
  summary: TaskSummary;
  cwd?: string;
  humanGate: HumanGate;
  accountDefault(): boolean | undefined;
  contribution(snapshot: NonNullable<Awaited<ReturnType<typeof deliveryChangeSnapshot>>>): Promise<{ paths: string[] }>;
  persist(): void;
  notifyWaiting(): void;
}

/** Incremental publication asks only about this commit, without closing feedback.
 * The host ledger binds confirmation to the destination branch and commit SHA.
 */
export async function confirmHostPush(host: PushConfirmationHost, operation: HostOperation, assertActive: () => void): Promise<boolean> {
    const required = host.summary.push_confirmation
      ?? host.accountDefault() ?? false;
    if (!required || operation.push_confirmed) return true;
    const previouslyConfirmed = new TaskHostLedger(host.summary).read().operations.some(item =>
      item.push_confirmed && item.sha === operation.sha && item.branch === operation.branch);
    if (previouslyConfirmed) return true;
    const snapshot = host.cwd ? await deliveryChangeSnapshot(host.cwd) : undefined;
    if (!snapshot || snapshot.head !== operation.sha) {
      throw new Error("待推送内容已变化，请重新整理本次推送");
    }
    if (host.summary.waiting?.step === HOST_PUSH_CONFIRM_STEP
        && host.summary.waiting.call_id === operation.id) return false;
    const paths = snapshot.baseline
      ? (await host.contribution(snapshot)).paths : [];
    assertActive();
    host.summary.waiting = host.humanGate.createWaiting({
      taskId: host.summary.id, step: HOST_PUSH_CONFIRM_STEP, callId: operation.id,
      questionInput: { questions: [{ question: `推送到 ${operation.branch}？`,
        options: ["确认推送", "先调整"] }] },
      context: [operation.input.reason.slice(0, 500),
        paths.length ? `本次涉及 ${paths.length} 个文件：${paths.slice(0, 5).join("、")}${paths.length > 5 ? "等" : ""}` : "本次推送当前已提交的改动。",
        "完整改动可在「交付材料 → 工作区变更」查看。调整范围请选「先调整」并说明。未处理的意见保持原状。"].join("\n\n"),
    });
    host.summary.status = "waiting_for_human";
    host.summary.detail = "等待确认本次推送";
    host.persist();
    host.notifyWaiting();
    return false;
}
