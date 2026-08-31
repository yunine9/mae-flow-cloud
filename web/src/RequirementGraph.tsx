import { useState } from "react";
import type { TaskSummary } from "./api";

function repoName(id: string, task: TaskSummary): string {
  return task.requirement_graph?.repositories.find((item) => item.id === id)?.name ?? id;
}

const childStatusText: Record<string, string> = {
  queued: "排队中", running: "执行中", pausing: "暂停中", paused: "已暂停",
  waiting_for_human: "待确认", verifying: "验证中", await_merge: "等待合入",
  completed: "已完成", stalled: "已停机", failed: "失败", canceled: "已取消",
};

export function RequirementGraph({
  task,
  onOpenTask,
}: {
  task: TaskSummary;
  onOpenTask?: (taskId: string) => void;
}) {
  const graph = task.requirement_graph;
  const [expanded, setExpanded] = useState(true);
  if (!graph || graph.repositories.length < 2) return null;
  const participantNames = [...new Set([
    ...(task.collaborators ?? []),
    ...graph.repositories.map((repository) => repository.assignee)
      .filter((account): account is string => !!account),
  ])].filter((account) => account !== task.luban_account);
  const generated = graph.repositories.filter((repository) => repository.task_id).length;
  const completed = graph.repositories.filter((repository) =>
    repository.task_status === "completed").length;
  const remaining = new Set(graph.repositories.map((repository) => repository.id));
  const stages: typeof graph.repositories[] = [];
  while (remaining.size) {
    const ready = graph.repositories.filter((repository) => remaining.has(repository.id)
      && graph.dependencies.filter((edge) => edge.from === repository.id)
        .every((edge) => !remaining.has(edge.to)));
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
        <strong id="requirement-graph-title">主任务与子任务进展</strong>
      </div>
      <small>{generated < graph.repositories.length
        ? `待拆分 · ${graph.repositories.length} 个仓库`
        : `${completed}/${graph.repositories.length} 个子任务已完成`}</small>
      <i className="requirement-toggle" aria-hidden />
    </summary>
    <div className="requirement-graph-body">
      <div className="requirement-root-task">
        <span>主任务</span>
        <div><strong>{task.title ?? task.requirement}</strong>
          <small>{task.ticket ?? task.id} · 统筹需求、依赖与各仓交付</small></div>
        <em className={task.status}>{childStatusText[task.status] ?? task.status}</em>
      </div>
      <div className="requirement-split-label">
        <span>{generated ? `已拆分为 ${generated} 个仓库子任务` : "确认方案后拆分仓库子任务"}</span>
      </div>
      <div className="requirement-main-team">
        <div><span>主任务团队</span>
          <small>1 位主责任人 · {participantNames.length} 位参与成员</small></div>
        <div className="requirement-team-pills">
          <strong>{task.luban_account ?? "本地主责任人"}<i>主责任人</i></strong>
          {participantNames.map((account) => <span key={account}>{account}
            <i>{task.collaborators?.includes(account) ? "共同开发" : "逐仓负责"}</i>
          </span>)}
          {participantNames.length === 0 && <em>尚未邀请共同开发者</em>}
        </div>
      </div>
      <div className="requirement-stages" aria-labelledby="requirement-graph-title">
        {stages.map((repositories, stage) => <div className="requirement-stage"
          key={repositories.map((repository) => repository.id).join("-")}>
          <small>{stage === 0 ? "可先行" : `第 ${stage + 1} 阶段`}</small>
          <div>
            {repositories.map((repository) => {
              const parents = graph.dependencies.filter((edge) => edge.from === repository.id);
              return <article key={repository.id}
                className={parents.length ? "has-prerequisite" : "ready"}
                title={repository.url}>
                <div className="repo-node-head">
                  <i aria-hidden />
                  <strong>{repository.name}</strong>
                  {repository.task_id && <button type="button"
                    onClick={() => onOpenTask?.(repository.task_id!)}>查看子任务</button>}
                </div>
                {repository.task_id && <span className={`repo-task-status ${
                  repository.task_status ?? "queued"}`}>
                  {childStatusText[repository.task_status ?? "queued"] ?? repository.task_status}
                  {repository.current_phase ? ` · ${repository.current_phase}` : ""}
                </span>}
                <span className="repo-assignee">
                  {repository.assignee ? `负责人 · ${repository.assignee}` : "负责人待确认"}
                </span>
                <span className="repo-ticket">
                  AR 单号 · {repository.ticket ?? task.ticket ?? "待确认"}
                </span>
                {repository.responsibility && <p>{repository.responsibility}</p>}
                {parents.length > 0 && <span className="repo-prerequisite">
                  等待 {parents.map((edge) => repoName(edge.to, task)).join("、")}
                </span>}
              </article>;
            })}
          </div>
        </div>)}
      </div>
      {graph.dependencies.length > 0 && <div className="requirement-edges">
        {graph.dependencies.map((edge, index) => <div key={`${edge.from}-${edge.to}-${index}`}>
          <span><strong>{repoName(edge.from, task)}</strong><i>依赖</i>
            <strong>{repoName(edge.to, task)}</strong></span>
          {edge.reason && <small>{edge.reason}</small>}
        </div>)}
      </div>}
      {(task.cross_repository_updates?.length ?? 0) > 0 && (
        <details className="cross-repository-ledger">
          <summary>分工后的跨仓影响 <b>{task.cross_repository_updates!.length}</b></summary>
          <ol>{task.cross_repository_updates!.slice(-10).reverse().map((update) => (
            <li key={update.id}>
              <div><strong>{update.source_repository ?? update.source_task_id}</strong>
                <span>{update.author}</span></div>
              <p>{update.text}</p>
            </li>
          ))}</ol>
        </details>
      )}
      {task.status === "waiting_for_human" && <p className="requirement-graph-note">
        核对完成后，请在右侧决策卡统一选择“确认并生成任务”或“需要修改”。
      </p>}
    </div>
  </details>;
}
