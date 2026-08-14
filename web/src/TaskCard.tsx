/**
 * 单个任务卡:状态、交付事实、通知失败红条、审批卡、过程记录。
 * 全部是服务端镜像的呈现,没有一处前端自己的状态推断。
 */

import { useEffect, useRef, useState } from "react";
import {
  decide,
  listActions,
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
  return (
    <div className="task">
      <b>{task.id}</b>{" "}
      <span className="status">{STATUS_TEXT[task.status] ?? task.status}</span>
      <div className="muted">{task.requirement}</div>
      {task.status === "failed" && task.detail && (
        <div className="muted">原因:{task.detail}</div>
      )}
      {task.delivery?.mr_url && (
        <div>
          合入请求:
          <a href={task.delivery.mr_url} target="_blank" rel="noreferrer">
            {task.delivery.mr_url}
          </a>
          ({task.delivery.mr_state})
        </div>
      )}
      {task.delivery?.skipped && (
        <div className="muted">交付情况:{task.delivery.skipped}</div>
      )}
      {task.notify && !task.notify.delivered && task.notify.attempts > 0 && (
        <div className="alert">
          ⚠ 小鲁班通知没送到(已试 {task.notify.attempts} 次)
          ——待办仍在,请在本页处理。
        </div>
      )}
      {task.status !== "queued" && (
        <div>
          <a href={`/tasks/${task.id}/panel`} target="_blank" rel="noreferrer">
            打开现场面板
          </a>
          <span className="muted">(检视材料都在里面)</span>
        </div>
      )}
      {task.status === "waiting_for_human" && task.waiting && (
        <WaitingCard task={task} onDecided={onChanged} />
      )}
      {task.delivery && <ActionLedger taskId={task.id} />}
      <EventTail taskId={task.id} />
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
      <summary className="muted">外部动作台账(MR/流水线)</summary>
      {unavailable && <div className="muted">{unavailable}</div>}
      {rows && rows.length === 0 && (
        <div className="muted">还没有外部动作。</div>
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

/** 审批卡:每题点选,答满才能提交;409 把服务端的话原样呈现。 */
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
      {questions.map((item) => (
        <div key={item.question}>
          <div><b>{item.question || "需要你确认"}</b></div>
          {(item.options ?? []).map((option) => (
            <button
              key={option}
              className={picked[item.question] === option ? "picked" : ""}
              onClick={() =>
                setPicked({ ...picked, [item.question]: option })}
            >
              {option}
            </button>
          ))}
        </div>
      ))}
      <button disabled={!ready} onClick={submit}>提交决定</button>
      {conflict && <div className="alert">{conflict}</div>}
    </div>
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
      <summary className="muted">过程记录</summary>
      <pre ref={pre}>{lines.join("\n")}</pre>
    </details>
  );
}
