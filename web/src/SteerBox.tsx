/**
 * 开发协作入口。
 *
 * - 「补充给主任务」沿用 pi steer：不打断当前工具，下一回合送达。
 * - 「开发助手」先把主任务停在安全边界，再启动不挂 Mae-Flow
 *   KernelHost 的旁路会话。它能读写代码、执行构建/测试命令；容器、
 *   工作区、凭据与 Git 交付边界仍由服务端强制执行。
 */

import { useEffect, useRef, useState } from "react";
import {
  controlTask,
  getDeveloperAssistant,
  interruptTask,
  listInterrupts,
  startDeveloperAssistant,
  type DeveloperAssistantView,
  type InterruptRecord,
  type TaskSummary,
} from "./api";
import { formatLocalDateTime } from "./time";
import { startVisiblePolling } from "./visiblePolling";
import "./steer.css";

type CollaborationMode = "steer" | "assistant";

const EMPTY_ASSISTANT: DeveloperAssistantView = {
  state: "idle",
  messages: [],
  tools: [],
};

const ASSISTANT_STATE: Record<DeveloperAssistantView["state"], string> = {
  idle: "随时可用",
  running: "正在处理",
  completed: "本轮完成",
  failed: "本轮失败",
  interrupted: "已中断",
};

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toolState(state: string): string {
  if (state === "passed") return "完成";
  if (state === "failed") return "失败";
  return "执行中";
}

export function SteerBox({
  task,
  onChanged,
}: {
  task: TaskSummary;
  onChanged?: () => void;
}) {
  const [mode, setMode] = useState<CollaborationMode>(
    task.status === "paused" ? "assistant" : "steer",
  );
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [history, setHistory] = useState<InterruptRecord[]>([]);
  const [assistant, setAssistant] =
    useState<DeveloperAssistantView>(EMPTY_ASSISTANT);
  const [pendingAssistant, setPendingAssistant] = useState("");
  const startingAssistant = useRef(false);
  const lastAssistantUpdate = useRef("");
  const onChangedRef = useRef(onChanged);

  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);

  // 补充说明的「已读取」是模型上下文实际消费事实，不是假回执。
  useEffect(() => {
    let alive = true;
    const load = () => void listInterrupts(task.id).then((rows) => {
      if (alive) setHistory(rows);
    });
    const stop = startVisiblePolling(load, 5000, document);
    return () => { alive = false; stop(); };
  }, [task.id, sent]);

  // 助手回复和工具结果分别来自快照与 SSE 正本。隐藏页不轮询。
  useEffect(() => {
    let alive = true;
    const load = () => void getDeveloperAssistant(task.id)
      .then((view) => {
        if (!alive) return;
        setAssistant(view);
        if (view.updated_at && view.updated_at !== lastAssistantUpdate.current) {
          if (["completed", "failed", "interrupted"].includes(view.state)) {
            onChangedRef.current?.();
          }
          lastAssistantUpdate.current = view.updated_at;
        }
      })
      .catch((cause) => {
        if (alive) setError(errorMessage(cause));
      });
    const stop = startVisiblePolling(load, 1500, document);
    return () => { alive = false; stop(); };
  }, [task.id]);

  // 用户无需自己理解暂停语义：在运行中的任务上发给助手，界面先请求
  // 安全暂停；父组件刷新到 paused 后再真正启动，绝不并发写工作区。
  useEffect(() => {
    if (!pendingAssistant || task.status !== "paused"
        || startingAssistant.current) return;
    startingAssistant.current = true;
    setBusy(true);
    setError("");
    void startDeveloperAssistant(task.id, pendingAssistant)
      .then((view) => {
        setAssistant(view);
        setPendingAssistant("");
        setText("");
        onChangedRef.current?.();
      })
      .catch((cause) => {
        setPendingAssistant("");
        setError(errorMessage(cause));
      })
      .finally(() => {
        startingAssistant.current = false;
        setBusy(false);
      });
  }, [pendingAssistant, task.id, task.status]);

  async function sendSteer() {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError("");
    const result = await interruptTask(task.id, message);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setText("");
    setSent(true);
    onChangedRef.current?.();
  }

  async function sendAssistant() {
    const message = text.trim();
    if (!message || busy || assistant.state === "running") return;
    setMode("assistant");
    setPendingAssistant(message);
    setError("");
    if (task.status === "paused") return;
    setBusy(true);
    const result = await controlTask(task.id, "pause");
    setBusy(false);
    if (result.error) {
      setPendingAssistant("");
      setError(result.error);
      return;
    }
    onChangedRef.current?.();
  }

  async function resumeMainTask() {
    if (busy || assistant.state === "running") return;
    setBusy(true);
    setError("");
    const result = await controlTask(task.id, "resume");
    setBusy(false);
    if (result.error) setError(result.error);
    else onChangedRef.current?.();
  }

  const assistantBusy = assistant.state === "running" || !!pendingAssistant;
  const canSteer = task.status === "running";
  const waitingForPause = !!pendingAssistant && task.status !== "paused";

  return (
    <section className="steer" aria-label="开发协作">
      <div className="steer-head">
        <div>
          <strong>开发协作</strong>
          <span>既能补充主任务，也能直接处理代码现场</span>
        </div>
        <em className={assistantBusy ? "active" : ""}>
          {assistantBusy ? "助手工作中" : "你随时掌控"}
        </em>
      </div>

      <div className="collaboration-tabs" role="tablist" aria-label="协作方式">
        <button type="button" role="tab" aria-selected={mode === "steer"}
          className={mode === "steer" ? "active" : ""}
          onClick={() => setMode("steer")}>
          <strong>补充给主任务</strong>
          <small>不打断，忙完这步就会看到</small>
        </button>
        <button type="button" role="tab" aria-selected={mode === "assistant"}
          className={mode === "assistant" ? "active" : ""}
          onClick={() => setMode("assistant")}>
          <strong>开发助手</strong>
          <small>暂停主任务，直接查代码、跑命令、修改</small>
        </button>
      </div>

      {mode === "steer" ? (
        <>
          <p className="steer-copy">
            想到什么随时捎给主任务。当前命令不会被掐断，模型读到后会继续按 Mae-Flow 流程推进。
          </p>
          <textarea id={`steer-${task.id}`} className="steer-input"
            value={text} disabled={!canSteer || busy}
            placeholder={canSteer
              ? "例如：掩码保留后四位，不要处理区号"
              : "主任务暂停时，请切到“开发助手”直接处理代码现场"}
            rows={3} onChange={(event) => {
              setText(event.target.value);
              if (sent) setSent(false);
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void sendSteer();
              }
            }} />
          <div className="steer-actions">
            <span className="steer-hint">
              {sent && !text ? "已捎过去，待读取状态会在下方更新" : "⌘/Ctrl + Enter 发送"}
            </span>
            <button type="button" className="steer-send"
              disabled={busy || !text.trim() || !canSteer}
              onClick={() => void sendSteer()}>
              {busy ? "发送中…" : "发送补充"}
            </button>
          </div>
          {history.length > 0 && (
            <ol className="steer-log" aria-label="捎过去的话">
              {history.slice(-4).reverse().map((item, at) => (
                <li key={`${item.at}-${at}`}
                  className={item.delivered ? "done" : "waiting"}>
                  <span className="steer-log-state">
                    {item.delivered ? "已读取" : "待读取"}
                  </span>
                  <span className="steer-log-text">{item.text}</span>
                  {item.said.length > 0 && (
                    <span className="steer-said">
                      <em>你说完之后它说的</em>
                      {item.said.map((said, index) => (
                        <span key={`${said.at}-${index}`}>{said.text}</span>
                      ))}
                    </span>
                  )}
                  {item.delivered && !item.said.length && (
                    <span className="steer-said quiet">
                      它已读到，暂时还没有新的回复；执行现场可查看当前动作。
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      ) : (
        <>
          <div className={`assistant-state ${assistant.state}`}>
            <div>
              <i aria-hidden />
              <strong>{waitingForPause ? "正在安全暂停主任务" : ASSISTANT_STATE[assistant.state]}</strong>
            </div>
            <span>
              {waitingForPause
                ? "当前操作收口后自动启动助手"
                : task.status === "paused"
                  ? "主任务保持暂停，不会和助手同时改代码"
                  : "发送后会自动暂停主任务"}
            </span>
          </div>

          <p className="steer-copy assistant-copy">
            像本地 CLI 一样直接说要做什么。助手可读写当前仓、运行构建与测试；
            不推进 Mae-Flow、不提交或推送，所有修改稍后交还主任务统一检视。
          </p>

          {assistant.messages.length > 0 && (
            <div className="assistant-conversation" aria-label="开发助手对话">
              {assistant.messages.map((message) => (
                <article key={message.id} className={message.role}>
                  <header>
                    <strong>{message.role === "user" ? "你" : "开发助手"}</strong>
                    <time dateTime={message.at}>{formatLocalDateTime(message.at)}</time>
                  </header>
                  <p>{message.text}</p>
                </article>
              ))}
            </div>
          )}

          {assistant.tools.length > 0 && (
            <div className="assistant-tools" aria-label="开发助手执行结果">
              <header>
                <strong>执行结果</strong>
                <span>完整过程同步记录在下方“执行现场”</span>
              </header>
              {assistant.tools.slice(-8).reverse().map((tool) => (
                <details key={tool.call_id} open={tool.state === "failed"}>
                  <summary>
                    <i className={tool.state} aria-hidden />
                    <strong>{tool.name}</strong>
                    <span>{toolState(tool.state)}</span>
                  </summary>
                  {tool.input && <pre>{tool.input}</pre>}
                  {tool.result && <pre className="result">{tool.result}</pre>}
                </details>
              ))}
            </div>
          )}

          <textarea id={`assistant-${task.id}`} className="steer-input"
            value={text} disabled={busy || assistantBusy}
            placeholder="例如：帮我定位这个空指针，跑一下相关 UT，能修就直接修"
            rows={4} onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void sendAssistant();
              }
            }} />
          <div className="steer-actions assistant-actions">
            <div>
              <span className="steer-hint">
                {assistantBusy ? "回复和命令结果会实时出现在这里" : "⌘/Ctrl + Enter 交给助手"}
              </span>
              {assistant.error && <small>{assistant.error}</small>}
            </div>
            <div className="assistant-buttons">
              {task.status === "paused" && assistant.state !== "running" && (
                <button type="button" className="assistant-return"
                  disabled={busy} onClick={() => void resumeMainTask()}>
                  交还主任务
                </button>
              )}
              <button type="button" className="steer-send"
                disabled={busy || assistantBusy || !text.trim()}
                onClick={() => void sendAssistant()}>
                {waitingForPause ? "正在暂停…" : assistant.state === "running" ? "处理中…" : "让助手处理"}
              </button>
            </div>
          </div>
        </>
      )}

      {error && <div className="alert">{error}</div>}
    </section>
  );
}
