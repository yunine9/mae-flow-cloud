import { deliveryChangeSnapshot } from "./artifacts.ts";
import type { HostOperation, TaskHostRuntime } from "./taskHostTools.ts";

/** 会话退出后，复用普通交付的同步入口；排队之后的任意本地改动仍需重新申请。 */
export async function prepareHostPush(host: Pick<TaskHostRuntime, "cwd" | "summary" | "assertActive">,
  operation: HostOperation, absorb: (branch: string) => Promise<"ok" | "absorbed" | "blocked">): Promise<void> {
  if (!host.cwd) throw new Error("任务没有代码现场");
  const before = await deliveryChangeSnapshot(host.cwd);
  host.assertActive();
  if (!before || before.head !== operation.sha) {
    throw new Error("待推送 HEAD 已变化，旧请求不能发布新的本地提交");
  }
  const outcome = await absorb(operation.branch!);
  host.assertActive();
  if (outcome === "blocked") throw new Error(host.summary.delivery?.stalled ?? "远端分支同步失败，请处理冲突后重新推送");
  if (outcome !== "absorbed") return;
  const after = await deliveryChangeSnapshot(host.cwd);
  host.assertActive();
  if (!after) throw new Error("同步远端后无法核对提交");
  if (operation.push_confirmed) throw new Error("远端新增提交已同步，原确认 SHA 已变化，请重新发起推送确认");
  const excluded = new Set(host.summary.delivery_selection?.excluded_paths ?? []);
  if (after.committed_paths.some(path => excluded.has(path))) throw new Error("同步后的提交包含已排除文件，请先整理交付范围");
  operation.sha = after.head;
}
