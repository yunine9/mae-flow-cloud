import { PersonName } from "./People";
import { statusText, type TaskSummary } from "./api";
import { formatLocalDateTime } from "./time";
import { ExecutionPanel, TaskTimeline } from "./TaskCard";
import { TokenUsage } from "./TokenUsage";
import { WorkflowProfileCard } from "./WorkflowProfileCard";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "cn";

export type TaskInspectorKind = "details" | "usage" | "workflow" | "logs" | "timing";
const titles: Record<TaskInspectorKind, string> = {
  details: "任务详情",
  usage: "模型用量", workflow: "执行方案",
  logs: "执行日志", timing: "耗时分析",
};

/** 任务详情及其子页共用居中 Dialog，保留焦点管理与 Esc 关闭。 */
export function TaskInspector({ task, kind, onClose, onInspect, onOpenProcess }: {
  task: TaskSummary; kind: TaskInspectorKind; onClose: () => void;
  onInspect: (kind: TaskInspectorKind) => void; onOpenProcess: () => void;
}) {
  const dtc = "text-xs leading-[1.6] text-muted-foreground";
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent showCloseButton={false} aria-describedby={undefined}
      className={`task-inspector inspector-${kind} tw-root flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[800px]`}>
      <DialogHeader className="flex flex-row items-start justify-between gap-4 border-b border-line p-5">
        <div className="min-w-0">
          {(kind === "usage" || kind === "workflow") && <Button type="button"
            variant="outline" size="sm"
            className="mb-3 w-fit"
            onClick={() => onInspect("details")}>← 返回任务详情</Button>}
          <small className="block font-mono text-xs text-muted-foreground">{task.ticket || task.id}</small>
          <DialogTitle className="mt-1 text-lg">{titles[kind]}</DialogTitle>
        </div>
        <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="关闭任务详情" />}>
          <XIcon />
        </DialogClose>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {kind === "details" && <div>
          <h3 className="m-0 mb-5 text-lg leading-[1.6] [overflow-wrap:anywhere]">{task.title ?? task.requirement}</h3>
          <dl className="m-0 mb-5 grid grid-cols-3 gap-x-6 gap-y-4">
            <div><dt className={dtc}>负责人</dt><dd className="mt-1 text-base leading-[1.7] [overflow-wrap:anywhere]"><PersonName account={task.luban_account} /></dd></div>
            <div><dt className={dtc}>任务状态</dt><dd className="mt-1 text-base leading-[1.7] [overflow-wrap:anywhere]">{statusText(task)}</dd></div>
            <div><dt className={dtc}>任务编号</dt><dd className="mt-1 text-base leading-[1.7] [overflow-wrap:anywhere]"><code>{task.id}</code></dd></div>
            <div><dt className={dtc}>创建时间</dt><dd className="mt-1 text-base leading-[1.7] [overflow-wrap:anywhere]">{formatLocalDateTime(task.created_at, { year: true })}</dd></div>
            {task.updated_at && <div><dt className={dtc}>最近更新</dt><dd className="mt-1 text-base leading-[1.7] [overflow-wrap:anywhere]">{formatLocalDateTime(task.updated_at, { year: true })}</dd></div>}
            {task.completed_at && <div><dt className={dtc}>完成时间</dt><dd className="mt-1 text-base leading-[1.7] [overflow-wrap:anywhere]">{formatLocalDateTime(task.completed_at, { year: true })}</dd></div>}
          </dl>
          <section className="border-t border-line py-4"><h3 className="m-0 mb-3 text-sm">进度与交付</h3>
            <dl className="m-0 grid gap-3.5">
              <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-[18px]"><dt className={cn(dtc, "pt-[3px]")}>当前步骤</dt><dd className="m-0 text-base leading-[1.7] [overflow-wrap:anywhere]">{task.progress?.step || task.detail || "暂无步骤记录"}</dd></div>
              {task.progress?.milestone && <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-[18px]"><dt className={cn(dtc, "pt-[3px]")}>子任务里程碑</dt><dd className="m-0 text-base leading-[1.7] [overflow-wrap:anywhere]">{task.progress.milestone.title} · {task.progress.milestone.event}
                {task.progress.milestone.reason && ` · ${task.progress.milestone.reason}`}</dd></div>}
              <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-[18px]"><dt className={cn(dtc, "pt-[3px]")}>合入请求</dt><dd className="m-0 text-base leading-[1.7] [overflow-wrap:anywhere]">{task.delivery?.mr_url ? <Button variant="outline" size="sm" render={<a href={task.delivery.mr_url} target="_blank" rel="noreferrer" />}>
                打开合入请求 · {task.delivery.mr_state || "查看状态"} ↗</Button> : "尚未记录合入请求"}</dd></div>
              {task.delivery?.pipeline && <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-[18px]"><dt className={cn(dtc, "pt-[3px]")}>流水线</dt><dd className="m-0 text-base leading-[1.7] [overflow-wrap:anywhere]">{task.delivery.pipeline}</dd></div>}
              {task.delivery?.loop?.failure && <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-[18px]"><dt className={cn(dtc, "pt-[3px]")}>流水线失败原文</dt><dd className="m-0 whitespace-pre-wrap font-mono text-xs leading-[1.8]">{task.delivery.loop.failure}</dd></div>}
              {task.workspace_reclaimed_at && <div className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-[18px]"><dt className={cn(dtc, "pt-[3px]")}>现场回收</dt><dd className="m-0 text-base leading-[1.7] [overflow-wrap:anywhere]">{formatLocalDateTime(task.workspace_reclaimed_at, { year: true })}
                <p className="mt-1 text-xs text-muted-foreground">过程记录、交付账本、流水线证据与批注仍保留，代码差异不再可看。</p></dd></div>}
            </dl>
            <Button type="button" variant="outline" size="sm"
              className="mt-4 w-fit" onClick={onOpenProcess}>查看工作过程 →</Button>
          </section>
          <nav className="grid gap-3 border-t border-line pt-4 sm:grid-cols-2" aria-label="任务执行信息">
            <Button type="button" variant="outline"
              className="h-auto w-full justify-between gap-4 whitespace-normal px-4 py-3 text-left"
              onClick={() => onInspect("usage")}><span><strong className="text-sm font-semibold">模型用量</strong>
              <small className="mt-1 block text-xs text-muted-foreground">{task.token_usage ? `累计 ${task.token_usage.total_tokens.toLocaleString()} Token` : "提供方暂未返回用量"}</small></span><i className="not-italic text-ink" aria-hidden>→</i></Button>
            <Button type="button" variant="outline"
              className="h-auto w-full justify-between gap-4 whitespace-normal px-4 py-3 text-left"
              onClick={() => onInspect("workflow")}><span><strong className="text-sm font-semibold">执行方案</strong>
              <small className="mt-1 block text-xs text-muted-foreground">本任务采用的流程版本与定制</small></span><i className="not-italic text-ink" aria-hidden>→</i></Button>
          </nav>
        </div>}
        {kind === "logs" && <ExecutionPanel task={task} defaultOpen />}
        {kind === "timing" && <><p className="m-0 mb-5 text-sm leading-[1.7] text-muted-foreground">按已记录的事件估算历史耗时；任务当前状态以工作台为准。</p><TaskTimeline taskId={task.id} defaultOpen /></>}
        {kind === "usage" && (task.token_usage ? <TokenUsage usage={task.token_usage} placement="detail" />
          : <p className="m-0 mb-5 text-sm leading-[1.7] text-muted-foreground">模型提供方暂未返回用量，不能据此认为消耗为零。</p>)}
        {kind === "workflow" && <>
          {task.workflow_profile ? <WorkflowProfileCard profile={task.workflow_profile} warning={task.workflow_profile_warning} />
            : <p className="m-0 mb-5 text-sm leading-[1.7] text-muted-foreground">本任务没有记录执行方案。</p>}
          {(task.execution_plan_alerts ?? []).map((line, index) => <p className="m-0 mb-5 text-sm leading-[1.7] text-muted-foreground" key={index}>{line}</p>)}
        </>}
      </div>
    </DialogContent>
  </Dialog>;
}
