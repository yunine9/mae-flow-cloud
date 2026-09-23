import { deliveryChangeSnapshot } from "./artifacts.ts";
import { TaskHostLedger, type HostOperation } from "./taskHostTools.ts";
import { normalizedDeliveryPaths, pushReviewCallId, hasPushApproval, samePaths } from "./pushReviewPolicy.ts";
import type { TaskSummary } from "./taskService.ts";
import type { HumanGate } from "./humanGate.ts";

export const HOST_PUSH_CHOICE_EFFECTS = [
  { key: "confirm", answers: ["确认推送"], allowsSourceEdit: false, handlesFeedback: false, closesFeedback: false },
  { key: "adjust", answers: ["先调整"], allowsSourceEdit: true, handlesFeedback: true, closesFeedback: false },
];
export const HOST_PUSH_CONFIRM_STEP = "host_push_confirm";
export const PUSH_SCOPE_GUIDANCE = "文件勾选只整理本次提交，不限制后续修复。确认后按需求和最新意见继续交付，不因文件增减、合并或 SHA 变化重复询问；明确要求调整和人工意见复检仍保留。";
interface PushConfirmationHost {
  summary: TaskSummary;
  cwd?: string;
  humanGate: HumanGate;
  accountDefault(): boolean | undefined;
  contribution(snapshot: NonNullable<Awaited<ReturnType<typeof deliveryChangeSnapshot>>>): Promise<{ paths: string[] }>;
  persist(): void;
  notifyWaiting(): void;
}

/** 两种推送入口复用同一个推送决定；实际发布 SHA 由准备和传输层取证。
 * 提前推送不代替逐条检视意见闭环，也不伪造流水线通过。 */
export async function confirmHostPush(host: PushConfirmationHost, operation: HostOperation, assertActive: () => void): Promise<boolean> {
  const required = host.summary.push_confirmation ?? host.accountDefault() ?? false;
  if (!required) return true;
  const snapshot = host.cwd ? await deliveryChangeSnapshot(host.cwd) : undefined;
  if (!snapshot || snapshot.head !== operation.sha) throw new Error("推送准备期间提交发生变化，请刷新待执行操作后继续");
  const paths = snapshot.baseline ? normalizedDeliveryPaths((await host.contribution(snapshot)).paths) : undefined;
  assertActive();
  const ledger = new TaskHostLedger(host.summary);
  const selection = host.summary.delivery_selection;
  const ownApproval = operation.push_confirmed;
  const sharedApproval = hasPushApproval(selection);
  // 旧台账没有范围，只能继承同分支同 SHA 的明确确认；新的确认统一写入 selection。
  const legacyApproval = !selection && ledger.read().operations.some(item =>
    item.push_confirmed && item.sha === operation.sha && item.branch === operation.branch
    && item.target_branch === operation.target_branch);
  if (ownApproval || sharedApproval || legacyApproval) {
    operation.push_confirmed = true;
    if (paths) {
      operation.push_paths = paths;
      if (!sharedApproval) host.summary.delivery_selection = {
        ...selection, paths, observed_paths: snapshot.workspace_paths,
        excluded_paths: normalizedDeliveryPaths([...(selection?.excluded_paths ?? []),
          ...snapshot.workspace_paths.filter(path => !paths.includes(path))]).filter(path => !paths.includes(path)),
        head: snapshot.head, baseline: snapshot.baseline!, status: "confirmed",
        waiting_id: operation.push_waiting_id ?? `${host.summary.id}:${operation.id}`,
        confirmation_mode: "human", confirmation_reason: "沿用责任人的推送确认；文件选择仅用于当次整理",
        updated_at: new Date().toISOString(),
      };
    }
    ledger.update(operation);
    const waiting = host.summary.waiting;
    if (waiting?.step === HOST_PUSH_CONFIRM_STEP
        && (waiting.call_id === operation.id || waiting.waiting_id === operation.push_waiting_id)) {
      if (waiting.status === "waiting") host.humanGate.supersede(waiting.waiting_id, {
        stateVersion: waiting.state_version, notes: "已有推送确认，沿用决定继续推送" });
      host.summary.waiting = undefined;
      host.summary.status = "running";
      host.summary.detail = "沿用推送确认，正在推送";
    }
    host.persist();
    return true;
  }
  operation.push_confirmed = false;
  const waiting = host.summary.waiting;
  const samePending = waiting?.step === HOST_PUSH_CONFIRM_STEP
    && (waiting.call_id === operation.id || waiting.waiting_id === operation.push_waiting_id)
    && waiting.status === "waiting";
  if (samePending && (!operation.push_paths || (paths && samePaths(operation.push_paths, paths)))) {
    host.summary.status = "waiting_for_human";
    host.summary.detail = "等待确认本次推送";
    host.persist();
    return false;
  }
  if (samePending) host.humanGate.supersede(waiting.waiting_id, {
    stateVersion: waiting.state_version, notes: "交付文件范围发生变化，展示更新后的范围" });
  const revision = host.humanGate.all().filter(row => row.call_id.startsWith(`${operation.id}:`)).length;
  const callId = paths ? `${operation.id}:${pushReviewCallId({ head: snapshot.head, paths })}:${revision}` : operation.id;
  operation.push_paths = paths;
  operation.push_waiting_id = `${host.summary.id}:${callId}`;
  ledger.update(operation);
  host.summary.waiting = host.humanGate.createWaiting({
    taskId: host.summary.id, step: HOST_PUSH_CONFIRM_STEP, callId,
    questionInput: { questions: [{ question: `推送到 ${operation.branch}？`, options: ["确认推送", "先调整"] }] },
    context: [operation.input.reason.slice(0, 500),
      paths?.length ? `本次涉及 ${paths.length} 个文件：${paths.slice(0, 5).join("、")}${paths.length > 5 ? "等" : ""}` : "本次推送当前已提交的改动。",
      "默认推送当前已提交的改动；可在「代码改动 → 全部改动」中按需剔除本次不交付的文件。需要 Agent 修改代码时请选择「先调整」。未处理的意见保持原状。",
      PUSH_SCOPE_GUIDANCE].join("\n\n"),
  });
  host.summary.status = "waiting_for_human";
  host.summary.detail = "等待确认本次推送";
  host.persist(); host.notifyWaiting();
  return false;
}
