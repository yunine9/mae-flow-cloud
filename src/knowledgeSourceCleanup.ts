import type { KnowledgeMrPublisher } from "./knowledgeMrPublisher.ts";
import type { KnowledgeSourceCleanupState, DomainKnowledgeJob, DomainPublication, KnowledgeRepository } from "./domainKnowledgeTypes.ts";

export interface SourceCleanupTask {
  id: string; issue_no?: string; operator: string; created_at: string;
  source_cleanup?: KnowledgeSourceCleanupState;
}
export class KnowledgeSourceCleanup {
  constructor(private publisher: Pick<KnowledgeMrPublisher, "previewCleanup" | "publish">) {}
  create(repositories: KnowledgeRepository[]): KnowledgeSourceCleanupState {
    return { repositories: structuredClone(repositories), plans: [], publications: [] };
  }
  private job(task: SourceCleanupTask): DomainKnowledgeJob {
    const state = task.source_cleanup;
    if (!state) throw new Error("此旧任务未经过萃取前清理，请新建任务，避免沿用受旧知识影响的草稿");
    return { id: `${task.id}-cleanup`, title: "萃取前旧知识清理", issue_no: task.issue_no, operator: task.operator, created_at: task.created_at,
      scope: "萃取前清理旧知识", cleanup_only: true, knowledge_target: state.repositories[0], repositories: state.repositories.slice(1),
      material_ids: [], ar_codes: [], use_wxdoubao: false, status: "idle", stage: "清理旧知识", revisions: {}, documents: [], turns: [], evidence: [],
      cleanup_plans: state.plans, publications: state.publications };
  }
  async action(task: SourceCleanupTask, action: string, input: any, operator: string, save: () => void) {
    const job = this.job(task), state = task.source_cleanup!;
    if (state.started) throw new Error("已经开始研究，不能修改清理范围；请新建任务重新清理和萃取");
    if (action === "preview") {
      const target = state.repositories.find(r => r.id === input.target_id);
      if (!target) throw new Error("请选择本任务的来源仓");
      const previous = state.publications.find(p => p.target_id === target.id);
      if (previous?.mr_attempted || previous?.url) throw new Error("清理 MR 已创建，请在 MR 中完成审查；如需改变清理范围，请新建任务");
      // New rules belong to the later knowledge MR; this operation only deletes.
      const plan = await this.publisher.previewCleanup(job, target, { paths: input.paths }, operator);
      state.plans = [...state.plans.filter(p => p.target_id !== target.id), plan];
      state.publications = state.publications.filter(p => p.target_id !== target.id); save();
    } else if (action === "confirm") {
      const plan = state.plans.find(p => p.id === input.plan_id);
      if (!plan || typeof input.confirmed !== "boolean") throw new Error("清理预览已变化，请重新预览");
      if (state.publications.some(p => p.target_id === plan.target_id && (p.mr_attempted || p.url))) throw new Error("清理已提交，请在 MR 中审查");
      const preserved = input.preserve_paths ?? plan.preserve_paths ?? [];
      if (!Array.isArray(preserved) || preserved.some(p => typeof p !== "string" || !plan.target_entries.some(e => e.path === p))) throw new Error("只能保留预览清单中的文件");
      plan.preserve_paths = [...new Set(preserved)] as string[]; plan.confirmed = input.confirmed; save();
    } else if (action === "publish") {
      if (!state.plans.some(p => p.confirmed)) throw new Error("请先预览并确认需要删除的文件");
      for (const target of state.repositories.filter(r => state.plans.some(p => p.target_id === r.id && p.confirmed))) {
        const previous = state.publications.find(p => p.target_id === target.id);
        if (previous?.url || previous?.state === "unchanged") continue;
        const persist = (publication: DomainPublication) => { state.publications = [...state.publications.filter(p => p.target_id !== target.id), structuredClone(publication)]; save(); };
        try {
          persist(await this.publisher.publish(this.job(task), target, previous, operator, persist));
        } catch (error) {
          const latest = state.publications.find(p => p.target_id === target.id);
          persist({ target_id: target.id, branch: `codex/knowledge-${task.id}-cleanup-${target.id}`, documents: [], ...latest, state: "failed", error: error instanceof Error ? error.message : "清理 MR 创建失败" });
        }
      }
    } else throw new Error("未知清理操作");
  }
}
