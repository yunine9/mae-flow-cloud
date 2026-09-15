import { deliveryChangeSnapshot } from "./artifacts.ts";
import type { HostOperation, TaskHostRuntime } from "./taskHostTools.ts";

/** 排队请求仍指定待传输提交；宿主自身同步远端产生的新 SHA 沿用本次确认。 */
export async function prepareHostPush(host: Pick<TaskHostRuntime, "cwd" | "summary" | "assertActive">,
  operation: HostOperation, absorb: (branch: string) => Promise<"ok" | "absorbed" | "blocked">,
  reconcile: () => Promise<void>): Promise<void> {
  if (!host.cwd) throw new Error("任务没有代码现场");
  const before = await deliveryChangeSnapshot(host.cwd);
  host.assertActive();
  if (!before || before.head !== operation.sha) {
    throw new Error("待推送 HEAD 已变化，旧请求不能发布新的本地提交");
  }
  const outcome = await absorb(operation.branch!);
  host.assertActive();
  if (outcome === "blocked") throw new Error(host.summary.delivery?.stalled ?? "远端分支同步失败，请处理冲突后重新推送");
  // 自动交付与工具推送使用同一范围处理，且必须在同步之后、确认之前。
  await reconcile();
  host.assertActive();
  const after = await deliveryChangeSnapshot(host.cwd);
  host.assertActive();
  if (!after) throw new Error("同步远端后无法核对提交");
  operation.sha = after.head;
}
