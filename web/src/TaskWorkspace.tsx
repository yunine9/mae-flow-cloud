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
import { GitDiff } from "./GitDiff";
import { SteerBox } from "./SteerBox";
import { Annotatable } from "./Annotatable";
import { AnnotationPanel } from "./AnnotationPanel";
import { AttachedNotes } from "./AttachedNotes";
import {
  listAnnotations,
  listArtifacts,
  readArtifact,
  STATUS_TEXT,
  type AnchorCheck,
  type Annotation,
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
  const [notes, setNotes] = useState<Annotation[]>([]);
  const [checks, setChecks] = useState<AnchorCheck[]>([]);
  const [reply, setReply] =
    useState<{ texts: string[]; truncated: boolean } | undefined>();
  const [notesPulse, setNotesPulse] = useState(0);
  const [attachNotes, setAttachNotes] = useState(true);
  const [livePulse, setLivePulse] = useState(0);

  // 它在跑的时候材料是活的:界面上写着"材料会随进展刷新",那就得真刷。
  // 原来只在 task.id/status 变化时取一次,于是整段编码期页面一动不动,
  // 批注的"这处已被改动"也永远停在旧结论上。
  // 只在 running 时轮询,5 秒一次;拿到一样的内容就不 setState,免得
  // 正在写批注时被重渲染打断。
  useEffect(() => {
    if (task.status !== "running") return;
    const timer = window.setInterval(
      () => setLivePulse((tick) => tick + 1), 5000);
    return () => window.clearInterval(timer);
  }, [task.status]);

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
      // 列表可能随任务轮询/状态切换重新读取。默认项只用于首次进入；
      // 用户已经切到工作区变更时绝不能被后台刷新拽回最近文档。
      setActive((current) => result.items?.some((item) => item.name === current)
        ? current
        : result.items?.[0]?.name ?? "");
    });
    return () => { alive = false; };
  }, [task.id, livePulse]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setLoading((was) => was || !content);
    void readArtifact(task.id, active).then((result) => {
      if (!alive) return;
      const next = result.content ?? result.unavailable ?? "";
      // 内容没变就别 setState:轮询期间无谓重渲染会把正在写的批注打断。
      setContent((current) => current === next ? current : next);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [task.id, active, livePulse]);

  // 批注随任务加载,也随"圈了一条/送出一批/任务状态变了"重取——
  // 进展(那处动没动)是服务端现算的,前端不自己推断。
  useEffect(() => {
    let alive = true;
    void listAnnotations(task.id).then((result) => {
      if (!alive) return;
      setNotes(result.items);
      setChecks(result.checks);
      setReply(result.reply);
    });
    return () => { alive = false; };
  }, [task.id, task.status, notesPulse, livePulse]);

  const drafts = notes.filter((item) => item.status === "draft");
  const draftIds = drafts.map((item) => item.id);

  /** 回到被圈的那一行:换页签→等它渲染出来→滚过去并闪一下。
   * 改批注前人几乎总要再看一眼上下文,只报"第 23 行"等于让他自己找。
   * 等待有预算(2 秒封顶),找不到就算了——旁路不许把界面卡住。 */
  function locate(item: Annotation) {
    if (item.artifact !== active) setActive(item.artifact);
    let tries = 0;
    const seek = () => {
      const node = document.querySelector<HTMLElement>(
        `.ws-doc [data-l="${item.line}"]`);
      if (!node) {
        if (tries++ < 20) window.setTimeout(seek, 100);
        return;
      }
      node.scrollIntoView({ block: "center", behavior: "smooth" });
      node.classList.add("annot-flash");
      window.setTimeout(() => node.classList.remove("annot-flash"), 1700);
    };
    window.setTimeout(seek, item.artifact === active ? 0 : 120);
  }
  const activeMeta = items?.find((item) => item.name === active);
  const documents = items?.filter((item) => item.kind === "doc") ?? [];
  const changes = items?.filter((item) => item.kind === "diff") ?? [];
  const waiting = task.status === "waiting_for_human" && task.waiting;

  return (
    <section
      className="workspace-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="task-workspace-title"
    >
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
          <strong id="task-workspace-title">{task.requirement}</strong>
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

      <div className={`ws-body${waiting ? " has-decision" : ""}`}>
        <section className="ws-evidence" aria-label="待检视材料">
          <div className="ws-pane-head">
            <div>
              <span>{activeMeta?.kind === "diff" ? "WORKTREE CHANGES" : "WORK DOCUMENTS"}</span>
              <strong>{activeMeta?.kind === "diff" ? "工作区变更" : "过程文档"}</strong>
            </div>
            <small>{items ? `${documents.length} 份文档 · ${changes.length} 组变更` : "读取中"}</small>
          </div>
          <div className="ws-source-switch" aria-label="材料类型">
            <button className={activeMeta?.kind !== "diff" ? "on" : ""} onClick={() => documents[0] && setActive(documents[0].name)}>
              <span>过程文档</span><i>{documents.length}</i>
            </button>
            <button className={activeMeta?.kind === "diff" ? "on" : ""} onClick={() => changes[0] && setActive(changes[0].name)} disabled={!changes.length}>
              <span>工作区变更</span><i>{changes.length}</i>
            </button>
          </div>
          {activeMeta?.kind !== "diff" && (
            <div className="ws-tabs">
              {documents.map((item) => (
                <button key={item.name} className={"ws-tab" + (item.name === active ? " on" : "")} onClick={() => setActive(item.name)}>
                  <span>{item.label}</span><i>{sizeText(item.bytes)}</i>
                </button>
              ))}
            </div>
          )}
          <div className="ws-doc">
            {unavailable && <div className="utility-note">{unavailable}</div>}
            {!unavailable && !items && <div className="utility-note">正在读取现场…</div>}
            {items?.length === 0 && (
              <div className="utility-note">这一单还没有可检视的产物。</div>
            )}
            {loading && <div className="utility-note">正在打开 {activeMeta?.label}…</div>}
            {!loading && content && (
              <Annotatable
                taskId={task.id}
                artifact={active}
                fallbackFile={activeMeta?.label ?? active}
                kind={activeMeta?.kind === "diff" ? "code" : "doc"}
                items={notes}
                onAdded={() => setNotesPulse((tick) => tick + 1)}
              >
                {activeMeta?.kind === "diff"
                  ? <GitDiff text={content} />
                  : <Markdown text={content} />}
              </Annotatable>
            )}
          </div>
        </section>

        <aside className="ws-decision" aria-label="决策与账目">
          <div className="ws-pane-head ws-pane-head-side">
            <div><span>NEXT ACTION</span><strong>{waiting ? "当前需要处理" : "任务现场"}</strong></div>
            <small>{waiting ? "完成后流程继续" : "实时更新"}</small>
          </div>
          {waiting && canOperate && (
            /* 批注挂在提交按钮正上方(WaitingCard 内部),不放卡片外面:
               选项标签是内核的——它按标签给这次选择记账,前端改写会让
               记下的选择对不上用户点的(2026-08-09 实战事故)。所以
               "这次会带上哪几处"只能摆进人按下提交的那一眼里。 */
            <WaitingCard
              task={task}
              onDecided={() => { setNotesPulse((tick) => tick + 1); onChanged(); }}
              annotationIds={attachNotes ? draftIds : undefined}
              attachment={
                <AttachedNotes items={drafts} attached={attachNotes}
                               onToggle={setAttachNotes} onLocate={locate} />
              }
            />
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
          {/* 它在跑的时候人也能捎话——btw 定位:不打断手头操作,
              忙完这步就会看到。不用干等到它来问你。 */}
          {!waiting && canOperate && task.status === "running" && (
            <SteerBox taskId={task.id} onSent={onChanged} />
          )}
          {task.status === "failed" && task.detail && (
            <div className="alert">
              <strong>任务执行失败</strong>
              <span>{task.detail}</span>
            </div>
          )}
          <AnnotationPanel
            taskId={task.id}
            items={notes}
            checks={checks}
            reply={reply}
            canOperate={canOperate}
            running={task.status === "running"}
            onLocate={locate}
            onChanged={() => { setNotesPulse((tick) => tick + 1); onChanged(); }}
          />
          <div className="task-utilities">
            <TaskTimeline taskId={task.id} />
            {task.delivery && <ActionLedger taskId={task.id} />}
          </div>
        </aside>
      </div>
    </section>
  );
}
