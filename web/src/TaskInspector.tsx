import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { TaskSummary } from "./api";
import { ExecutionPanel, TaskTimeline } from "./TaskCard";
import { TokenUsage } from "./TokenUsage";
import { WarmupPanel } from "./WarmupPanel";
import { WorkflowProfileCard } from "./WorkflowProfileCard";

export type TaskInspectorKind = "usage" | "environment" | "logs" | "timing";
const titles: Record<TaskInspectorKind, string> = {
  usage: "模型用量", environment: "环境与执行配置",
  logs: "执行日志", timing: "耗时分析",
};
export function TaskInspector({ task, kind, onClose }: { task: TaskSummary; kind: TaskInspectorKind; onClose: () => void }) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    return () => trigger?.focus();
  }, []);
  return createPortal(<div className="task-inspector-backdrop" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}><section className={`task-inspector inspector-${kind}`} role="dialog" aria-modal="true" aria-labelledby="task-inspector-title"
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.stopPropagation(); if (!document.querySelector(".warmup-overlay")) onClose(); }
      if (event.key === "Tab") {
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]')).filter((item) => item.getClientRects().length > 0);
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <header><div><small>{task.ticket || task.id}</small><h2 id="task-inspector-title">{titles[kind]}</h2></div>
      <button type="button" aria-label="关闭任务详情" ref={closeButton} onClick={onClose}>×</button></header>
    <div className="task-inspector-body">
      {kind === "logs" && <ExecutionPanel task={task} defaultOpen />}
      {kind === "timing" && <><p className="inspector-note">按已记录的事件估算历史耗时；任务当前状态以工作台为准。</p><TaskTimeline taskId={task.id} defaultOpen /></>}
      {kind === "usage" && (task.token_usage ? <TokenUsage usage={task.token_usage} placement="detail" />
        : <p className="inspector-note">模型提供方暂未返回用量，不能据此认为消耗为零。</p>)}
      {kind === "environment" && <><WarmupPanel task={task} />
        {!task.baseline_build && <p className="inspector-note">本任务没有环境预热记录。</p>}
        {task.workflow_profile ? <WorkflowProfileCard profile={task.workflow_profile} warning={task.workflow_profile_warning} />
          : <p className="inspector-note">本任务没有记录执行配置。</p>}
        {(task.execution_plan_alerts ?? []).map((line, index) => <p className="inspector-note" key={index}>{line}</p>)}
      </>}
    </div>
  </section></div>, document.body);
}
