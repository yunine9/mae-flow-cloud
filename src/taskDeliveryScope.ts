import { deliveryChangeSnapshot } from "./artifacts.ts";
import { reconcileKernelDeliverySelection } from "./kernelDelivery.ts";
import type { TaskHostRuntime, HostOperation } from "./taskHostTools.ts";
import { isAgentPlatformPath } from "./agentPlatformPaths.ts";

/** 兼容旧会话的恢复操作，只更新选择记录；新修复不必先调用它扩清单。 */
export async function restoreDeliveryPaths(
  host: TaskHostRuntime, operation: HostOperation, actor: string,
): Promise<string> {
  const previous = host.summary.delivery_selection;
  if (!previous || !host.cwd || !host.kernel) throw new Error("当前没有可恢复的交付清单或内核现场");
  const snapshot = await deliveryChangeSnapshot(host.cwd);
  if (!snapshot?.baseline) throw new Error("无法读取当前交付现场");
  const restored = [...new Set(operation.input.paths ?? [])];
  if (!restored.length || restored.some(path => !path || path.startsWith("/")
      || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")
      || isAgentPlatformPath(path)
      || (!previous.excluded_paths.includes(path) && !previous.paths.includes(path) && !snapshot.workspace_paths.includes(path)))) {
    throw new Error("请指定当前任务中实际存在的准确业务文件路径");
  }
  const paths = [...new Set([...previous.paths, ...restored])];
  const excluded = previous.excluded_paths.filter(path => !restored.includes(path));
  host.assertActive();
  // 先更新内核记录，再保存 Cloud；恢复执行时按当前提交重放。
  reconcileKernelDeliverySelection({ host: host.kernel, cwd: host.cwd,
    workspace: host.summary.workspace, taskId: host.summary.id,
    waitingId: operation.id, head: snapshot.head, paths, excludedPaths: excluded, actor });
  host.summary.delivery_selection = { ...previous, paths, excluded_paths: excluded,
    observed_paths: snapshot.workspace_paths, baseline: snapshot.baseline,
    head: snapshot.head,
    updated_at: new Date().toISOString() };
  host.persist();
  return `已更新文件选择记录：${restored.join("、")}。文件清单只用于当次整理，后续必要修复可直接提交，无需反复扩清单或再次确认。`;
}
