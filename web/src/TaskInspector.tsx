import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { statusText, type TaskSummary } from "./api";
import { formatLocalDateTime } from "./time";
import { ExecutionPanel, TaskTimeline } from "./TaskCard";
import { TokenUsage } from "./TokenUsage";
import { WarmupPanel } from "./WarmupPanel";
import { WorkflowProfileCard } from "./WorkflowProfileCard";

export type TaskInspectorKind = "details" | "usage" | "environment" | "logs" | "timing";
const titles: Record<TaskInspectorKind, string> = {
  details: "任务详情",
  usage: "模型用量", environment: "环境与执行配置",
  logs: "执行日志", timing: "耗时分析",
};
export function TaskInspector({ task, kind, onClose, onInspect, onOpenProcess }: {
  task: TaskSummary; kind: TaskInspectorKind; onClose: () => void;
  onInspect: (kind: TaskInspectorKind) => void; onOpenProcess: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    return () => trigger?.focus();
  }, []);
  useEffect(() => { closeButton.current?.focus(); }, [kind]);
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
    <header><div>
      {(kind === "usage" || kind === "environment") && <button type="button" className="inspector-back"
        onClick={() => onInspect("details")}>← 返回任务详情</button>}
      <small>{task.ticket || task.id}</small><h2 id="task-inspector-title">{titles[kind]}</h2></div>
      <button type="button" className="inspector-close" aria-label="关闭任务详情" ref={closeButton} onClick={onClose}>×</button></header>
    <div className="task-inspector-body">
      {kind === "details" && <div className="inspector-facts">
        <h3 className="inspector-task-title">{task.title ?? task.requirement}</h3>
        <dl className="inspector-fact-grid">
          <div><dt>负责人</dt><dd>{task.luban_account ?? "未指定"}</dd></div>
          <div><dt>任务状态</dt><dd>{statusText(task)}</dd></div>
          <div><dt>任务编号</dt><dd><code>{task.id}</code></dd></div>
          <div><dt>创建时间</dt><dd>{formatLocalDateTime(task.created_at, { year: true })}</dd></div>
          {task.updated_at && <div><dt>最近更新</dt><dd>{formatLocalDateTime(task.updated_at, { year: true })}</dd></div>}
          {task.completed_at && <div><dt>完成时间</dt><dd>{formatLocalDateTime(task.completed_at, { year: true })}</dd></div>}
        </dl>
        <section className="inspector-fact-section"><h3>进度与交付</h3>
          <dl className="inspector-fact-lines">
            <div><dt>当前步骤</dt><dd>{task.progress?.step || task.detail || "暂无步骤记录"}</dd></div>
            {task.progress?.milestone && <div><dt>子任务里程碑</dt><dd>{task.progress.milestone.title} · {task.progress.milestone.event}
              {task.progress.milestone.reason && ` · ${task.progress.milestone.reason}`}</dd></div>}
            <div><dt>合入请求</dt><dd>{task.delivery?.mr_url ? <a href={task.delivery.mr_url} target="_blank" rel="noreferrer">
              打开合入请求 · {task.delivery.mr_state || "查看状态"} ↗</a> : "尚未记录合入请求"}</dd></div>
            {task.delivery?.pipeline && <div><dt>流水线</dt><dd>{task.delivery.pipeline}</dd></div>}
            {task.delivery?.loop?.failure && <div><dt>流水线失败原文</dt><dd className="inspector-failure">{task.delivery.loop.failure}</dd></div>}
            {task.workspace_reclaimed_at && <div><dt>现场回收</dt><dd>{formatLocalDateTime(task.workspace_reclaimed_at, { year: true })}
              <p>过程记录、交付账本、流水线证据与批注仍保留，代码差异不再可看。</p></dd></div>}
          </dl>
          <button type="button" className="inspector-text-action" onClick={onOpenProcess}>查看工作过程 →</button>
        </section>
        <nav className="inspector-resource-links" aria-label="任务执行信息">
          <button type="button" onClick={() => onInspect("usage")}><span><strong>模型用量</strong>
            <small>{task.token_usage ? `累计 ${task.token_usage.total_tokens.toLocaleString()} Token` : "提供方暂未返回用量"}</small></span><i aria-hidden>→</i></button>
          <button type="button" onClick={() => onInspect("environment")}><span><strong>环境与执行配置</strong>
            <small>查看预热记录和本次执行方案</small></span><i aria-hidden>→</i></button>
        </nav>
      </div>}
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
