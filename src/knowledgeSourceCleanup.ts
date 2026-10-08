import type { KnowledgeMrPublisher } from "./knowledgeMrPublisher.ts";
import type { DomainKnowledgeJob, KnowledgeCleanupPlan, KnowledgeCleanupPublication } from "./domainKnowledgeTypes.ts";

/** 清理只由人触发；预览和每仓结果留在原萃取任务中，不另起研究或跟踪 MR。 */
export class KnowledgeSourceCleanup {
  constructor(private publisher: Pick<KnowledgeMrPublisher, "previewCleanup" | "publishCleanup">) {}
  async action(job: DomainKnowledgeJob, action: string, input: any, operator: string, save: () => void, signal: AbortSignal) {
    const state = job.source_cleanup;
    if (!state || state.started) throw new Error("当前任务不在萃取前清理阶段");
    const values = action === "preview" ? input.paths_by_target : input.selected_paths_by_target;
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("请提供各仓的清理路径");
    if (action === "preview") {
      const plans: KnowledgeCleanupPlan[] = [];
      for (const target of state.repositories) {
        if (state.publications.some(publication => publication.target_id === target.id && (publication.url || publication.revision || publication.mr_attempted))) throw new Error("清理分支已经推送，请先完成原清理 MR");
        plans.push(await this.publisher.previewCleanup(target, values[target.id] ?? [], operator, signal));
      }
      state.plans = plans; state.publications = []; save();
      return;
    }
    if (action !== "publish") throw new Error("未知清理操作");
    // 先校验整批选择再进行外部操作，不能前一个仓推送后才发现后一个仓的输入无效。
    for (const target of state.repositories) {
      const plan = state.plans.find(plan => plan.target_id === target.id), selected = values[target.id];
      if (!plan || !Array.isArray(selected) || selected.some(path => typeof path !== "string" || !plan.entries.some(entry => entry.path === path))) throw new Error("清理预览或文件选择无效，请重新预览");
      const previous = state.publications.find(publication => publication.target_id === target.id);
      if (previous && (previous.revision || previous.mr_attempted || previous.url) && JSON.stringify(previous.removed_paths) !== JSON.stringify([...new Set(selected)].sort())) throw new Error("原清理分支已确定删除范围，请按原范围重试");
      plan.selected_paths = [...new Set(selected)].sort();
    }
    save();
    for (const target of state.repositories) {
      signal.throwIfAborted();
      const plan = state.plans.find(plan => plan.target_id === target.id)!;
      const previous = state.publications.find(publication => publication.target_id === target.id);
      if (previous?.url || !plan.selected_paths!.length) continue;
      const persist = (publication: KnowledgeCleanupPublication) => {
        signal.throwIfAborted();
        state.publications = [...state.publications.filter(item => item.target_id !== target.id), structuredClone(publication)]; save();
      };
      try { persist(await this.publisher.publishCleanup(job, target, plan, plan.selected_paths, previous, operator, persist, signal)); }
      catch (error) {
        signal.throwIfAborted();
        const latest = state.publications.find(publication => publication.target_id === target.id);
        persist({ target_id: target.id, cleanup_plan_id: plan.id, removed_paths: plan.selected_paths!, branch: `codex/knowledge-${job.id}-cleanup-${target.id}-${plan.id}`, documents: [], ...latest,
          state: "failed", error: error instanceof Error ? error.message : "清理 MR 创建失败" });
      }
    }
  }
}
