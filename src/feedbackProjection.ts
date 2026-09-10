/** Read-side projection of the Kernel-owned feedback loop. Owner closure is
 * reconciled separately; a scheduling defer never masquerades as PASS. */
import { FeedbackStore, type FeedbackRecord, type FeedbackSource } from "./feedbackStore.ts";

export function projectKernelFeedback(state: Record<string, any>, store: FeedbackStore, existing: FeedbackRecord[]): void {
  const batches = Array.isArray(state.delivery_loop?.batches) ? state.delivery_loop.batches : [];
  const current = new Map(existing.map((item) => [item.id, item]));
  const statuses: Record<string, FeedbackRecord["status"]> = {
    queued: "open",
    repairing: "repairing",
    addressed: "addressed",
    awaiting_verification: "awaiting_verification",
    closed: "closed",
    needs_human: "needs_human",
    deferred: "deferred",
  };
  const sources = new Set<FeedbackSource>([
    "workspace", "build_fix", "pipeline", "mr_discussion",
    "conflict", "scope", "push_confirmation",
  ]);
  for (const batch of batches) {
    const status = statuses[String(batch?.status ?? "")];
    if (!status || !Array.isArray(batch?.items)) continue;
    const results = new Map((Array.isArray(batch.results)
      ? batch.results : []).map((item: any) => [String(item?.id ?? ""), item]));
    for (const item of batch.items) {
      const id = String(item?.id ?? "");
      let existing = current.get(id);
      const source = String(item?.source ?? "") as FeedbackSource;
      const sourceNeedsHumanAuthority = source === "workspace"
        || source === "mr_discussion"
        || source === "push_confirmation";
      const projected = state.delivery_loop?.deferred_feedback?.[id] ? "deferred" : status === "closed" && sourceNeedsHumanAuthority
        ? "awaiting_verification" : status;
      const result: any = results.get(id);
      const resolution = String(state.delivery_loop?.deferred_feedback?.[id]?.reason ?? result?.summary ?? "")
        || (projected === "closed" ? "权威核验已通过"
          : projected === "awaiting_verification" ? "Agent 已处理，等待来源方核验"
          : `状态更新为 ${projected}`);
      if (!existing && id && sources.has(source)) {
        const restored: FeedbackRecord = {
          id,
          batch_id: String(batch?.batch_id ?? ""),
          source,
          source_id: String(item?.source_id ?? ""),
          source_revision: Number(item?.source_revision ?? 0),
          observed_sha: String(batch?.base_sha ?? ""),
          summary: String(item?.summary ?? "反馈内容缺失"),
          ...(item?.material ? { material: String(item.material) } : {}),
          ...(item?.file ? { file: String(item.file) } : {}),
          ...(item?.line !== undefined ? { line: Number(item.line) } : {}),
          verification: String(item?.verification ?? "unknown"),
          status: projected,
          ...(result?.summary ? { resolution } : {}),
          updated_at: String(batch?.opened_at ?? new Date().toISOString()),
        };
        store.upsert([restored]);
        current.set(id, restored);
        existing = restored;
      }
      if (!existing || existing.status === "closed") continue;
      // 内核的 closed 表示“本批代码已通过机器核验”，不能越权代替
      // 批注作者、MR 检视人或 push 卡责任人作最终裁决。这三类先停在
      // 待核验；只有各自来源的权威事件才会调用 resolveFeedbackRecords
      // 真正关闭。机器来源仍由内核 PASS 直接闭环。
      if (existing.status === projected) continue;
      store.resolve(id, projected, resolution);
    }
  }
}
