import { pipelineLabel } from "./pipelinePresentation";
import { PersonName } from "./People";
import { statusText, type TaskSummary } from "./api";
import { formatLocalDateTime } from "./time";
import { ExecutionPanel, TaskTimeline } from "./TaskCard";
import { TokenUsage } from "./TokenUsage";
import { WorkflowProfileCard } from "./WorkflowProfileCard";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export type TaskInspectorKind = "details" | "usage" | "workflow" | "logs" | "timing";
const titles: Record<TaskInspectorKind, string> = {
  details: "任务详情",
  usage: "模型用量", workflow: "执行方案",
  logs: "执行日志", timing: "耗时分析",
};

/**
 * 任务检查器(#209 shadcn 化):旧手写 portal 弹层改右侧 Sheet(base-ui
 * Dialog 皮)。挂载即开,Esc 关闭、焦点圈、焦点归还都交给 Sheet;对外
 * props 与关闭回调语义不变(TaskWorkspace 的挂载条件照旧)。
 * `task-inspector`/`inspector-${kind}` 仍是样式钩子:执行面板自带开关的
 * 折叠、耗时页 cost-focus 的隐藏等存量规则挂在 .task-inspector 作用域下。
 * 弹层在 tw-root 归一子树内,存量类的盒模型(边距/边框)被剥,这里用
 * 工具类就地补齐;颜色、字阶只走令牌工具类(text-ink=旧 --accent 等)。
 */
export function TaskInspector({ task, kind, onClose, onInspect, onOpenProcess }: {
  task: TaskSummary; kind: TaskInspectorKind; onClose: () => void;
  onInspect: (kind: TaskInspectorKind) => void; onOpenProcess: () => void;
}) {
  return <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
    <SheetContent side="right" showCloseButton={false}
      className={`tw-root task-inspector inspector-${kind} gap-0 data-[side=right]:sm:max-w-2xl`}>
      <SheetHeader className="flex flex-row items-start justify-between gap-4 border-b border-line p-5">
        <div className="min-w-0">
          {(kind === "usage" || kind === "workflow") && <button type="button"
            className="mb-2 block text-xs text-ink hover:underline"
            onClick={() => onInspect("details")}>← 返回任务详情</button>}
          <small className="block font-mono text-xs text-muted-foreground">{task.ticket || task.id}</small>
          <SheetTitle className="mt-1 text-lg">{titles[kind]}</SheetTitle>
        </div>
        <SheetClose render={<Button variant="ghost" size="icon-sm" aria-label="关闭任务详情" />}>
          <XIcon />
        </SheetClose>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {kind === "details" && <div className="inspector-facts">
          <h3 className="inspector-task-title mb-5">{task.title ?? task.requirement}</h3>
          <dl className="inspector-fact-grid mb-5">
            <div><dt>负责人</dt><dd className="mt-1"><PersonName account={task.luban_account} /></dd></div>
            <div><dt>任务状态</dt><dd className="mt-1">{statusText(task)}</dd></div>
            <div><dt>任务编号</dt><dd className="mt-1"><code>{task.id}</code></dd></div>
            <div><dt>创建时间</dt><dd className="mt-1">{formatLocalDateTime(task.created_at, { year: true })}</dd></div>
            {task.updated_at && <div><dt>最近更新</dt><dd className="mt-1">{formatLocalDateTime(task.updated_at, { year: true })}</dd></div>}
            {task.completed_at && <div><dt>完成时间</dt><dd className="mt-1">{formatLocalDateTime(task.completed_at, { year: true })}</dd></div>}
          </dl>
          <section className="inspector-fact-section border-t border-line py-4"><h3 className="mb-3">进度与交付</h3>
            <dl className="inspector-fact-lines">
              <div><dt>当前步骤</dt><dd>{task.progress?.step || task.detail || "暂无步骤记录"}</dd></div>
              {task.progress?.milestone && <div><dt>子任务里程碑</dt><dd>{task.progress.milestone.title} · {task.progress.milestone.event}
                {task.progress.milestone.reason && ` · ${task.progress.milestone.reason}`}</dd></div>}
              <div><dt>合入请求</dt><dd>{task.delivery?.mr_url ? <a href={task.delivery.mr_url} target="_blank" rel="noreferrer">
                打开合入请求 · {task.delivery.mr_state || "查看状态"} ↗</a> : "尚未记录合入请求"}</dd></div>
              {task.delivery?.pipeline && <div><dt>流水线</dt><dd>{pipelineLabel(task.delivery.pipeline)}</dd></div>}
              {task.delivery?.loop?.failure && <div><dt>流水线失败原文</dt><dd className="inspector-failure">{task.delivery.loop.failure}</dd></div>}
              {task.workspace_reclaimed_at && <div><dt>现场回收</dt><dd>{formatLocalDateTime(task.workspace_reclaimed_at, { year: true })}
                <p className="mt-1">过程记录、交付账本、流水线证据与批注仍保留，代码差异不再可看。</p></dd></div>}
            </dl>
            <button type="button" className="inspector-text-action mt-4 text-sm text-ink" onClick={onOpenProcess}>查看工作过程 →</button>
          </section>
          <nav className="inspector-resource-links border-t border-line" aria-label="任务执行信息">
            <button type="button"
              className="flex w-full items-center justify-between gap-5 border-b border-line py-3 text-left text-text hover:bg-surface-2 hover:text-ink"
              onClick={() => onInspect("usage")}><span><strong>模型用量</strong>
              <small className="mt-1 block">{task.token_usage ? `累计 ${task.token_usage.total_tokens.toLocaleString()} Token` : "提供方暂未返回用量"}</small></span><i aria-hidden>→</i></button>
            <button type="button"
              className="flex w-full items-center justify-between gap-5 border-b border-line py-3 text-left text-text hover:bg-surface-2 hover:text-ink"
              onClick={() => onInspect("workflow")}><span><strong>执行方案</strong>
              <small className="mt-1 block">本任务采用的流程版本与定制</small></span><i aria-hidden>→</i></button>
          </nav>
        </div>}
        {kind === "logs" && <ExecutionPanel task={task} defaultOpen />}
        {kind === "timing" && <><p className="inspector-note mb-5">按已记录的事件估算历史耗时；任务当前状态以工作台为准。</p><TaskTimeline taskId={task.id} defaultOpen /></>}
        {kind === "usage" && (task.token_usage ? <TokenUsage usage={task.token_usage} placement="detail" />
          : <p className="inspector-note mb-5">模型提供方暂未返回用量，不能据此认为消耗为零。</p>)}
        {kind === "workflow" && <>
          {task.workflow_profile ? <WorkflowProfileCard profile={task.workflow_profile} warning={task.workflow_profile_warning} />
            : <p className="inspector-note mb-5">本任务没有记录执行方案。</p>}
          {(task.execution_plan_alerts ?? []).map((line, index) => <p className="inspector-note mb-5" key={index}>{line}</p>)}
        </>}
      </div>
    </SheetContent>
  </Sheet>;
}
