import { useState } from "react";
import { confirmRequirementGraph, type TaskSummary } from "./api";

function repoName(id: string, task: TaskSummary): string {
  return task.requirement_graph?.repositories.find((item) => item.id === id)?.name ?? id;
}

export function RequirementGraph({
  task,
  onOpenTask,
  onConfirmed,
}: {
  task: TaskSummary;
  onOpenTask?: (taskId: string) => void;
  /** 确认成功后让宿主刷新任务镜像(子任务 ID 是服务端事实)。 */
  onConfirmed?: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const graph = task.requirement_graph;
  if (!graph || graph.repositories.length < 2) return null;
  // 平台自己的确认入口(结构化):Agent 卡上的「确认并生成任务」选项
  // 文字是模型写的,写漂了字符串就对不上——这颗按钮不经模型,直达
  // 服务端确认接口,漂了也不丢单。已全部生成任务后按钮退场。
  const pending = graph.repositories.some((repository) => !repository.task_id);
  // 兼容旧版本留下的现场:子任务已生成但父分析会话仍停在确认卡时，
  // 仍显示一次“完成确认”，让同一颗按钮把父会话续上。
  const needsConfirmation = pending || task.status === "waiting_for_human";
  const canConfirm = task.status === "waiting_for_human"
    || ["completed", "failed", "canceled"].includes(task.status);
  async function confirm() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await confirmRequirementGraph(task.id);
      await onConfirmed?.();
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
    } finally { setBusy(false); }
  }
  return <section className="requirement-graph" aria-labelledby="requirement-graph-title">
    <header>
      <div>
        <span>DELIVERY RELATION</span>
        <strong id="requirement-graph-title">仓间开发依赖</strong>
      </div>
      <small>{graph.repositories.length} 个仓库 · {graph.dependencies.length} 条硬依赖</small>
    </header>
    <div className="requirement-repos">
      {graph.repositories.map((repository) => {
        const parents = graph.dependencies.filter((edge) => edge.to === repository.id);
        const children = graph.dependencies.filter((edge) => edge.from === repository.id);
        return <article key={repository.id} className={parents.length ? "has-prerequisite" : "ready"}>
          <div className="repo-node-head">
            <i aria-hidden />
            <strong>{repository.name}</strong>
            <span>{parents.length ? "需等待前置" : "无前置依赖"}</span>
          </div>
          {repository.responsibility && <p>{repository.responsibility}</p>}
          <div className="repo-node-links">
            {parents.length > 0 && <span>依赖 {parents.map((edge) => repoName(edge.from, task)).join("、")}</span>}
            {children.length > 0 && <span>完成后解锁 {children.map((edge) => repoName(edge.to, task)).join("、")}</span>}
            {!parents.length && !children.length && <span>与其他仓可并行</span>}
          </div>
          {repository.task_id && <button type="button"
            onClick={() => onOpenTask?.(repository.task_id!)}>打开交付任务</button>}
        </article>;
      })}
    </div>
    {graph.dependencies.length > 0 && <div className="requirement-edges">
      {graph.dependencies.map((edge, index) => <div key={`${edge.from}-${edge.to}-${index}`}>
        <strong>{repoName(edge.from, task)}</strong><span>→</span><strong>{repoName(edge.to, task)}</strong>
        {edge.reason && <small>{edge.reason}</small>}
      </div>)}
    </div>}
    {needsConfirmation && <div className="requirement-graph-confirm">
      <p className="requirement-graph-note">
        这是 Agent 从 Chain 方案投影出的依赖关系。请结合下方方案正文检视；
        确认后，当前检视会结束，各仓交付任务将按上图依赖自动排队。
      </p>
      <button type="button" disabled={busy || !canConfirm}
        onClick={() => void confirm()}>
        {busy ? "确认中…" : !canConfirm ? "分析完成后可确认"
          : pending ? "确认方案并开始各仓交付" : "完成方案确认"}
      </button>
      {error && <p className="requirement-graph-error" role="alert">{error}</p>}
    </div>}
  </section>;
}
