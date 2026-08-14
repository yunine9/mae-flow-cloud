/**
 * 单个任务卡:状态、交付事实、通知失败红条、审批卡、台账、过程记录。
 * 全部是服务端镜像的呈现,没有一处前端自己的状态推断。
 *
 * 折叠语义:列表里默认只露头两行(状态/标题/一条 meta),点头部
 * 展开完整视图;"等你决定"的任务自动展开——需要人的时刻不许藏。
 */

import { useEffect, useRef, useState } from "react";
import {
  decide,
  listActions,
  retryTask,
  STATUS_TEXT,
  tailEvents,
  type ExternalAction,
  type SemanticEvent,
  type TaskSummary,
} from "./api";

export function TaskCard({
  task,
  onChanged,
}: {
  task: TaskSummary;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(
    task.status === "waiting_for_human");
  // 轮询中途转入"等你决定"也要弹开:初始值只算一次,这里补上。
  useEffect(() => {
    if (task.status === "waiting_for_human") setExpanded(true);
  }, [task.status]);

  return (
    <div className={"task" + (expanded ? " expanded" : "")}>
      <div
        className="task-toggle"
        onClick={() => setExpanded((open) => !open)}
      >
        <div className="task-head">
          <span className="task-id">{task.id}</span>
          <span className={`pill ${task.status}`}>
            {STATUS_TEXT[task.status] ?? task.status}
          </span>
          <span className="chevron">▸</span>
        </div>
        <div className="task-title">{task.requirement}</div>
      </div>
      <div className="task-meta">
        {task.status !== "queued" && (
          <a href={`/tasks/${task.id}/panel`} target="_blank" rel="noreferrer">
            现场面板 ↗
          </a>
        )}
        {task.delivery?.mr_url && (
          <span>
            合入请求:
            <a href={task.delivery.mr_url} target="_blank" rel="noreferrer">
              {task.delivery.mr_url}
            </a>
            ({task.delivery.mr_state})
          </span>
        )}
        {task.delivery?.skipped && (
          <span>交付情况:{task.delivery.skipped}</span>
        )}
      </div>
      {expanded && (
        <>
          {task.status === "failed" && task.detail && (
            <div className="alert">出错原因:{task.detail}</div>
          )}
          {task.notify && !task.notify.delivered
            && task.notify.attempts > 0 && (
            <div className="alert">
              ⚠ 小鲁班通知没送到(已试 {task.notify.attempts} 次)
              ——待办仍在,请在本页处理。
            </div>
          )}
          {(task.status === "failed" || task.status === "completed") && (
            <RetryButton taskId={task.id} onDone={onChanged} />
          )}
          {task.status === "waiting_for_human" && task.waiting && (
            <WaitingCard task={task} onDecided={onChanged} />
          )}
          {task.delivery && <ActionLedger taskId={task.id} />}
          <EventTail taskId={task.id} />
        </>
      )}
    </div>
  );
}

/** 审批卡:每题点选,答满才能提交;409 把服务端的话原样呈现。
 * 选项两种排布:全短 → 行内紧凑;有长文案(run7 风险卡实测整段
 * 长文)→ 通栏卡片式,整块可点、自然换行。 */
function WaitingCard({
  task,
  onDecided,
}: {
  task: TaskSummary;
  onDecided: () => void;
}) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState("");
  const questions = task.waiting?.question?.questions ?? [];
  const ready = questions.every((item) => picked[item.question]);

  async function submit() {
    const result = await decide(
      task.id, task.waiting!.state_version, picked);
    if (result.conflict) setConflict(result.conflict);
    onDecided();
  }

  return (
    <div className="waiting">
      <div className="waiting-title">
        等你决定{task.waiting?.step ? ` · ${task.waiting.step}` : ""}
      </div>
      {questions.map((item) => {
        const longform = (item.options ?? [])
          .some((option) => option.length > 24)
          || (item.question ?? "").length > 60;
        return (
          <div className="question" key={item.question}>
            <div className="question-text">
              {item.question || "需要你确认"}
            </div>
            <div className={"options " + (longform ? "longform" : "compact")}>
              {(item.options ?? []).map((option) => (
                <button
                  key={option}
                  className={
                    "option"
                    + (picked[item.question] === option ? " picked" : "")}
                  onClick={() =>
                    setPicked({ ...picked, [item.question]: option })}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      <button className="submit" disabled={!ready} onClick={submit}>
        提交决定
      </button>
      {conflict && <div className="alert">{conflict}</div>}
    </div>
  );
}

/** 重跑续推:环境故障被迫收口后,修好环境点一下,任务续接内核
 * 当前步骤。服务端拒绝时把解释原样呈现。 */
function RetryButton({
  taskId,
  onDone,
}: {
  taskId: string;
  onDone: () => void;
}) {
  const [error, setError] = useState("");
  return (
    <div>
      <button className="retry" onClick={async () => {
        const result = await retryTask(taskId);
        setError(result.error ?? "");
        onDone();
      }}>↻ 重跑续推</button>
      {error && <div className="alert">{error}</div>}
    </div>
  );
}

/** 外部动作台账(审计读侧):展开才查;没配 --pg 时把服务端的
 * 解释原样呈现,不装作"没有动作"。 */
function ActionLedger({ taskId }: { taskId: string }) {
  const [rows, setRows] = useState<ExternalAction[]>();
  const [unavailable, setUnavailable] = useState("");

  async function load() {
    const result = await listActions(taskId);
    if (result.unavailable) setUnavailable(result.unavailable);
    else setRows(result.actions ?? []);
  }

  return (
    <details onToggle={(toggle) => {
      if ((toggle.target as HTMLDetailsElement).open) void load();
    }}>
      <summary>外部动作台账(MR / 流水线)</summary>
      {unavailable && <div className="note">{unavailable}</div>}
      {rows && rows.length === 0 && (
        <div className="note">还没有外部动作。</div>
      )}
      {rows && rows.length > 0 && (
        <pre>{rows.map((row) =>
          `${row.kind}  ${row.idemKey}  ` +
          `${row.finishedAt ? "已完成" : "进行中"}` +
          `${row.sha ? `  sha=${row.sha.slice(0, 8)}` : ""}\n` +
          `  结果: ${JSON.stringify(row.result ?? "(未回填)")}`,
        ).join("\n")}</pre>
      )}
    </details>
  );
}

/** 过程记录:展开才建 SSE 连接,收起后保留已收内容。 */
function EventTail({ taskId }: { taskId: string }) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const pre = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!open) return;
    const stop = tailEvents(taskId, (event: SemanticEvent) => {
      setLines((prev) => [
        ...prev,
        `${event.kind}  ${JSON.stringify(event.payload).slice(0, 160)}`,
      ]);
    });
    return stop;
  }, [open, taskId]);

  useEffect(() => {
    pre.current?.scrollTo(0, pre.current.scrollHeight);
  }, [lines]);

  return (
    <details onToggle={(toggle) =>
      setOpen((toggle.target as HTMLDetailsElement).open)}>
      <summary>过程记录</summary>
      <pre ref={pre}>{lines.join("\n")}</pre>
    </details>
  );
}
