/**
 * 任务工作台:决策发生在哪里,证据就在哪里。
 *
 * 用户实测的摩擦:审批卡问"本地 Spec 确认",spec.md 却只在内核
 * 现场面板(另一套 UI 的 iframe)里能看——读材料要跳出决策上下文。
 * 这里把两半合成一屏:左证据(产物页签,我们自己的排版渲染)、
 * 右决策(审批卡原样搬来)、下面是耗时/台账/事件。
 *
 * 内核面板不再是主路径,降级为「内核原生视图」外链(排障用)——
 * 它是内核为"人坐在终端旁"生成的单文件 HTML,嵌进来永远是两套。
 */

import { useEffect, useState } from "react";
import { Markdown } from "./markdown";
import {
  listArtifacts,
  readArtifact,
  STATUS_TEXT,
  type ArtifactMeta,
  type TaskSummary,
} from "./api";
import {
  ActionLedger,
  RetryButton,
  TaskProgress,
  TaskTimeline,
  WaitBadge,
  WaitingCard,
} from "./TaskCard";

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function TaskWorkspace({
  task,
  canOperate,
  onChanged,
  onClose,
}: {
  task: TaskSummary;
  canOperate: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<ArtifactMeta[]>();
  const [unavailable, setUnavailable] = useState("");
  const [active, setActive] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", escape);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", escape);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  // 产物列表按最近修改倒序(服务端排好),默认打开第一份——
  // "哪一步该看哪个文件"是内核语义,前端不复刻,只用修改时间定位。
  useEffect(() => {
    let alive = true;
    void listArtifacts(task.id).then((result) => {
      if (!alive) return;
      setUnavailable(result.unavailable ?? "");
      setItems(result.items);
      if (result.items?.length) setActive(result.items[0].name);
    });
    return () => { alive = false; };
  }, [task.id]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setLoading(true);
    void readArtifact(task.id, active).then((result) => {
      if (!alive) return;
      setContent(result.content ?? result.unavailable ?? "");
      setLoading(false);
    });
    return () => { alive = false; };
  }, [task.id, active]);

  const activeMeta = items?.find((item) => item.name === active);
  const waiting = task.status === "waiting_for_human" && task.waiting;

  return (
    <section className="workspace-overlay" role="dialog" aria-modal="true">
      <header className="ws-head">
        <button type="button" className="ws-back" onClick={onClose} autoFocus>
          <svg viewBox="0 0 20 20" aria-hidden><path d="m12.5 5-5 5 5 5" /></svg>
          <span>返回列表</span>
        </button>
        <div className="ws-identity">
          <div className="ws-identity-line">
            <code>{task.id}</code>
            <span className={`pill ${task.status}`}>
              <i aria-hidden />{STATUS_TEXT[task.status] ?? task.status}
            </span>
            <WaitBadge task={task} personal={canOperate} />
          </div>
          <strong>{task.requirement}</strong>
        </div>
        <a className="ws-native" href={`/tasks/${task.id}/panel`} target="_blank" rel="noreferrer">
          内核原生视图
          <svg viewBox="0 0 16 16" aria-hidden><path d="M6 3.5h6.5V10M12.25 3.75 5 11" /></svg>
        </a>
      </header>

      {task.progress && (
        <div className="ws-progress">
          <TaskProgress progress={task.progress} showDetailedStep />
        </div>
      )}

      <div className="ws-body">
        <section className="ws-evidence" aria-label="待检视材料">
          <div className="ws-tabs">
            {items?.map((item) => (
              <button
                key={item.name}
                className={"ws-tab" + (item.name === active ? " on" : "")}
                onClick={() => setActive(item.name)}
              >
                <span>{item.label}</span>
                <i>{sizeText(item.bytes)}</i>
              </button>
            ))}
          </div>
          <div className="ws-doc">
            {unavailable && <div className="utility-note">{unavailable}</div>}
            {!unavailable && !items && <div className="utility-note">正在读取现场…</div>}
            {items?.length === 0 && (
              <div className="utility-note">这一单还没有可检视的产物。</div>
            )}
            {loading && <div className="utility-note">正在打开 {activeMeta?.label}…</div>}
            {!loading && content && (
              activeMeta?.kind === "diff"
                ? <pre className="ws-diff">{content}</pre>
                : <Markdown text={content} />
            )}
          </div>
        </section>

        <aside className="ws-decision" aria-label="决策与账目">
          {waiting && canOperate && (
            <WaitingCard task={task} onDecided={onChanged} />
          )}
          {waiting && !canOperate && (
            <div className="read-only-notice">
              该事项由 {task.luban_account ?? "其他成员"} 核对；
              你可以查看全部材料，但不能代为提交决定。
            </div>
          )}
          {!waiting && (
            <div className="ws-idle">
              <strong>当前没有待你决定的事项</strong>
              <p>
                {task.status === "running"
                  ? "模型正在推进这一步，材料会随进展刷新。"
                  : "左侧是这一单已产出的全部材料。"}
              </p>
              {canOperate && (task.status === "failed" || task.status === "completed") && (
                <RetryButton taskId={task.id} onDone={onChanged} />
              )}
            </div>
          )}
          {task.status === "failed" && task.detail && (
            <div className="alert">
              <strong>任务执行失败</strong>
              <span>{task.detail}</span>
            </div>
          )}
          <div className="task-utilities">
            <TaskTimeline taskId={task.id} />
            {task.delivery && <ActionLedger taskId={task.id} />}
          </div>
        </aside>
      </div>
    </section>
  );
}
