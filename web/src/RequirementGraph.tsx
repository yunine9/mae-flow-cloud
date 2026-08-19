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
  const [expanded, setExpanded] = useState(true);
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
  const remaining = new Set(graph.repositories.map((repository) => repository.id));
  const stages: typeof graph.repositories[] = [];
  while (remaining.size) {
    const ready = graph.repositories.filter((repository) => remaining.has(repository.id)
      && graph.dependencies.filter((edge) => edge.to === repository.id)
        .every((edge) => !remaining.has(edge.from)));
    // Agent 产物若暂时成环，先如实放在同一阶段；确认时服务端会阻止落单。
    const current = ready.length ? ready
      : graph.repositories.filter((repository) => remaining.has(repository.id));
    stages.push(current);
    current.forEach((repository) => remaining.delete(repository.id));
  }
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
  return <details className="requirement-graph" open={expanded}
    onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>
      <div>
        <span>CHAIN OVERVIEW</span>
        <strong id="requirement-graph-title">仓间开发依赖</strong>
      </div>
      <small>{graph.repositories.length} 个仓库 · {graph.dependencies.length} 条硬依赖</small>
      <i className="requirement-toggle" aria-hidden />
    </summary>
    <div className="requirement-graph-body">
      <div className="requirement-stages" aria-labelledby="requirement-graph-title">
        {stages.map((repositories, stage) => <div className="requirement-stage"
          key={repositories.map((repository) => repository.id).join("-")}>
          <small>{stage === 0 ? "可先行" : `第 ${stage + 1} 阶段`}</small>
          <div>
            {repositories.map((repository) => {
              const parents = graph.dependencies.filter((edge) => edge.to === repository.id);
              return <article key={repository.id}
                className={parents.length ? "has-prerequisite" : "ready"}
                title={repository.url}>
                <div className="repo-node-head">
                  <i aria-hidden />
                  <strong>{repository.name}</strong>
                  {repository.task_id && <button type="button"
                    onClick={() => onOpenTask?.(repository.task_id!)}>打开任务</button>}
                </div>
                {repository.responsibility && <p>{repository.responsibility}</p>}
                {parents.length > 0 && <span className="repo-prerequisite">
                  等待 {parents.map((edge) => repoName(edge.from, task)).join("、")}
                </span>}
              </article>;
            })}
          </div>
        </div>)}
      </div>
      {graph.dependencies.length > 0 && <div className="requirement-edges">
        {graph.dependencies.map((edge, index) => <div key={`${edge.from}-${edge.to}-${index}`}>
          <span><strong>{repoName(edge.from, task)}</strong><i>→</i>
            <strong>{repoName(edge.to, task)}</strong></span>
          {edge.reason && <small>{edge.reason}</small>}
        </div>)}
      </div>}
      {needsConfirmation && <div className="requirement-graph-confirm">
        <p className="requirement-graph-note">
          先核对下方 Chain 正文；确认后，平台才会按以上顺序生成各仓交付任务。
        </p>
        <button type="button" disabled={busy || !canConfirm}
          onClick={() => void confirm()}>
          {busy ? "确认中…" : !canConfirm ? "分析完成后可确认"
            : pending ? "确认方案并开始各仓交付" : "完成方案确认"}
        </button>
        {error && <p className="requirement-graph-error" role="alert">{error}</p>}
      </div>}
    </div>
  </details>;
}
