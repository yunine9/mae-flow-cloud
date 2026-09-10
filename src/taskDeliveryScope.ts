import { deliveryChangeSnapshot } from "./artifacts.ts";
import { reconcileKernelDeliverySelection } from "./kernelDelivery.ts";
import type { TaskHostRuntime, HostOperation } from "./taskHostTools.ts";

/** Restore only the paths named by the owner's new instruction. The signed
 * kernel API owns control-file updates; unrelated exclusions remain intact. */
export async function restoreDeliveryPaths(
  host: TaskHostRuntime, operation: HostOperation, actor: string,
): Promise<string> {
  const previous = host.summary.delivery_selection;
  if (!previous || !host.cwd || !host.kernel) throw new Error("当前没有可恢复的交付清单或内核现场");
  const restored = [...new Set(operation.input.paths ?? [])];
  if (!restored.length || restored.some(path => !path || path.startsWith("/")
      || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")
      || (!previous.excluded_paths.includes(path) && !previous.paths.includes(path)))) {
    throw new Error("请指定原交付清单中要恢复的准确文件路径");
  }
  const snapshot = await deliveryChangeSnapshot(host.cwd);
  if (!snapshot?.baseline || snapshot.head !== operation.sha) throw new Error("提交已变化，请重新发起恢复交付文件");
  const paths = [...new Set([...previous.paths, ...restored])];
  const excluded = previous.excluded_paths.filter(path => !restored.includes(path));
  host.assertActive();
  // Reconcile first. If persistence is interrupted, replay uses the same op/SHA
  // and the kernel's existing idempotency contract before updating Cloud.
  reconcileKernelDeliverySelection({ host: host.kernel, cwd: host.cwd,
    workspace: host.summary.workspace, taskId: host.summary.id,
    waitingId: operation.id, head: snapshot.head, paths, excludedPaths: excluded, actor });
  host.summary.delivery_selection = { ...previous, paths, excluded_paths: excluded,
    observed_paths: snapshot.workspace_paths, baseline: snapshot.baseline,
    head: snapshot.head, status: "requested", waiting_id: operation.id,
    confirmation_mode: undefined, confirmation_reason: undefined,
    updated_at: new Date().toISOString() };
  host.persist();
  return `已按责任人要求恢复交付文件：${restored.join("、")}。其他排除项保持不变；Cloud 与内核清单已同步，可继续提交和推送。`;
}
