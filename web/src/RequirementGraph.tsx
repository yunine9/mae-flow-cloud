import { useState } from "react";
import type { TaskSummary } from "./api";

function repoName(id: string, task: TaskSummary): string {
  return task.requirement_graph?.repositories.find((item) => item.id === id)?.name ?? id;
}

export function RequirementGraph({
  task,
  onOpenTask,
}: {
  task: TaskSummary;
  onOpenTask?: (taskId: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const graph = task.requirement_graph;
  if (!graph || graph.repositories.length < 2) return null;
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
      {task.status === "waiting_for_human" && <p className="requirement-graph-note">
        核对完成后，请在右侧决策卡统一选择“确认并生成任务”或“需要修改”。
      </p>}
    </div>
  </details>;
}
