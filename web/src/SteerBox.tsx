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
  getDeveloperAssistant,
  interruptTask,
  listInterrupts,
  returnDeveloperAssistant,
  startDeveloperAssistant,
  stopDeveloperAssistant,
  type DeveloperAssistantView,
  type InterruptRecord,
  type TaskSummary,
} from "./api";
import { atBottom } from "./follow";
import { formatLocalDateTime } from "./time";
import { startVisiblePolling } from "./visiblePolling";
import "./steer.css";

type CollaborationMode = "steer" | "assistant";

const EMPTY_ASSISTANT: DeveloperAssistantView = {
  state: "idle",
  messages: [],
  tools: [],
  availability: {
    available: false,
    code: "core_unavailable",
    mode: "unavailable",
    reason: "正在确认当前内核步骤…",
  },
};

const ASSISTANT_STATE: Record<DeveloperAssistantView["state"], string> = {
  idle: "等待接管",
  acquiring: "正在接管主现场",
  working: "正在工作",
  ready: "CLI 已就绪",
  returning: "正在交还主任务",
  running: "正在工作",
  completed: "CLI 已就绪",
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
  steerOnly = false,
  onChanged,
}: {
  task: TaskSummary;
  /** 跨仓分析主任务是共享讨论室，没有可编辑的单仓代码现场。 */
  steerOnly?: boolean;
  onChanged?: () => void;
}) {
  const [mode, setMode] = useState<CollaborationMode>(
    steerOnly || task.status === "running" ? "steer" : "assistant",
  );
  const [steerText, setSteerText] = useState("");
  const [assistantText, setAssistantText] = useState("");
  const [steerBusy, setSteerBusy] = useState(false);
  const [assistantRequestBusy, setAssistantRequestBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [history, setHistory] = useState<InterruptRecord[]>([]);
  const [assistant, setAssistant] =
    useState<DeveloperAssistantView>(EMPTY_ASSISTANT);
  const lastAssistantUpdate = useRef("");
  const assistantPollSequence = useRef(0);
  const conversationRef = useRef<HTMLDivElement>(null);
  const conversationPinned = useRef(true);
  const onChangedRef = useRef(onChanged);

  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);

  useEffect(() => {
    setMode(steerOnly || task.status === "running" ? "steer" : "assistant");
    conversationPinned.current = true;
  }, [task.id, steerOnly]);

  const lastMessageId = assistant.messages.at(-1)?.id;
  useEffect(() => {
    const node = conversationRef.current;
    if (node && conversationPinned.current) {
      node.scrollTo({ top: node.scrollHeight });
    }
  }, [lastMessageId]);

  useEffect(() => {
    if (["acquiring", "working", "ready", "returning", "running", "completed"]
        .includes(assistant.state) || assistant.handoff?.state === "running") {
      setMode("assistant");
    }
  }, [assistant.state, assistant.handoff?.state]);

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
    const load = () => {
      const sequence = ++assistantPollSequence.current;
      void getDeveloperAssistant(task.id)
      .then((view) => {
        if (!alive || sequence !== assistantPollSequence.current) return;
        setAssistant(view);
        if (view.updated_at && view.updated_at !== lastAssistantUpdate.current) {
          if (["completed", "failed", "interrupted"].includes(view.state)) {
            onChangedRef.current?.();
          }
          lastAssistantUpdate.current = view.updated_at;
        }
      })
      .catch((cause) => {
        if (alive && sequence === assistantPollSequence.current) {
          setError(errorMessage(cause));
        }
      });
    };
    const stop = startVisiblePolling(load, 1500, document);
    return () => { alive = false; stop(); };
  }, [task.id]);

  async function sendSteer() {
    const message = steerText.trim();
    if (!message || steerBusy) return;
    setSteerBusy(true);
    setError("");
    const result = await interruptTask(task.id, message);
    setSteerBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setSteerText("");
    setSent(true);
    onChangedRef.current?.();
  }

  async function sendAssistant() {
    const message = assistantText.trim();
    if (!message || assistantRequestBusy) return;
    if (!assistant.availability.available) {
      setError(assistant.availability.reason);
      return;
    }
    setMode("assistant");
    conversationPinned.current = true;
    setAssistantRequestBusy(true);
    setError("");
    try {
      const view = await startDeveloperAssistant(task.id, message);
      setAssistant(view);
      setAssistantText("");
      onChangedRef.current?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAssistantRequestBusy(false);
    }
  }

  async function stopAssistant() {
    if (assistantRequestBusy) return;
    setAssistantRequestBusy(true);
    setError("");
    try {
      setAssistant(await stopDeveloperAssistant(task.id));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAssistantRequestBusy(false);
    }
  }

  async function resumeMainTask() {
    if (assistantRequestBusy) return;
    setAssistantRequestBusy(true);
    setError("");
    try {
      await returnDeveloperAssistant(task.id);
      onChangedRef.current?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAssistantRequestBusy(false);
    }
  }

  const assistantWorking = ["acquiring", "working", "returning", "running"]
    .includes(assistant.state);
  const takeoverActive = ["acquiring", "working", "ready", "returning", "running",
    "completed"].includes(assistant.state)
    || assistant.handoff?.state === "running";
  const canSteer = task.status === "running" && !takeoverActive;
  const assistantAvailable = assistant.availability.available;
  const canReturn = task.status === "paused"
    && !["acquiring", "working", "returning", "running"].includes(assistant.state);

  return (
    <section className="steer" aria-label="开发协作">
      <div className="steer-head">
        <div>
          <strong>开发协作</strong>
          <span>{steerOnly
            ? "主责人与各仓责任人在这里共同澄清，再由主责人拍板分工"
            : "既能补充主任务，也能直接处理代码现场"}</span>
        </div>
        <em className={takeoverActive ? "active"
          : assistantAvailable ? "available" : "unavailable"}>
          {takeoverActive ? "主现场由你接管"
            : assistantAvailable ? "现在可接管" : "当前不可接管"}
        </em>
      </div>

      <div className="collaboration-tabs" role="tablist" aria-label="协作方式">
        <button type="button" role="tab" aria-selected={mode === "steer"}
          className={mode === "steer" ? "active" : ""}
          disabled={takeoverActive}
          onClick={() => { if (!takeoverActive) setMode("steer"); }}>
          <strong>补充给主任务</strong>
          <small>不打断，忙完这步就会看到</small>
        </button>
        {!steerOnly && <button type="button" role="tab" aria-selected={mode === "assistant"}
          className={mode === "assistant" ? "active" : ""}
          onClick={() => setMode("assistant")}>
          <strong>开发助手</strong>
          <small>你主动接管现场，直接查代码、跑命令、修改</small>
        </button>}
      </div>

      {mode === "steer" || steerOnly ? (
        <>
          <p className="steer-copy">
            想到什么随时捎给主任务。当前命令不会被掐断，模型读到后会继续按 Mae-Flow 流程推进。
          </p>
          <textarea id={`steer-${task.id}`} className="steer-input"
            value={steerText} disabled={!canSteer || steerBusy}
            placeholder={canSteer
              ? "例如：掩码保留后四位，不要处理区号"
              : steerOnly && task.status === "waiting_for_human"
                ? "方案正在等主责人确认；请在材料上圈批注，意见会随最终决定送给 AI"
                : steerOnly
                  ? "主任务当前未运行，暂不能追加给 AI"
                  : "主任务暂停时，请切到“开发助手”直接处理代码现场"}
            rows={3} onChange={(event) => {
              setSteerText(event.target.value);
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
              {sent && !steerText ? "已捎过去，待读取状态会在下方更新" : "⌘/Ctrl + Enter 发送"}
            </span>
            <button type="button" className="steer-send"
              disabled={steerBusy || !steerText.trim() || !canSteer}
              onClick={() => void sendSteer()}>
              {steerBusy ? "发送中…" : "发送补充"}
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
          <div className={`assistant-state ${assistant.state}`
            + `${assistantAvailable ? " available" : " unavailable"}`}>
            <div>
              <i aria-hidden />
              <strong>{ASSISTANT_STATE[assistant.state]}</strong>
            </div>
            <span>
              {!assistantAvailable
                ? assistant.availability.reason
                : assistant.state === "acquiring"
                  ? "正在收好主任务当前动作，消息已经可靠保存"
                  : ["working", "running"].includes(assistant.state)
                    ? "输出、工具和代码变化持续记录；可随时追加指令"
                    : assistant.state === "returning"
                      ? "正在释放开发会话并与内核核对现场"
                      : takeoverActive
                        ? "主任务保持暂停；继续输入，或明确交还主任务"
                        : "发出第一条指令后自动安全接管主现场"}
            </span>
          </div>

          <p className="steer-copy assistant-copy">
            这是一个持续的开发 CLI：接管一次后可多轮排查、修改和运行命令。
            主任务在后台保持暂停；只有你点击“交还主任务”才退出本次接管。
          </p>

          {assistant.handoff && assistant.handoff.state !== "running" && (
            <div className={`assistant-handoff ${assistant.handoff.state === "blocked"
              ? "changed" : assistant.handoff.state}`}>
              <div>
                <i aria-hidden />
                <strong>{assistant.handoff.state === "changed"
                  ? "有修改，等待交还"
                  : assistant.handoff.state === "unchanged"
                    ? "无代码变化"
                    : assistant.handoff.state === "returned"
                      ? "已交给主任务"
                      : "现场将重新读取"}</strong>
              </div>
              <p>{assistant.handoff.message}</p>
              {!!assistant.handoff.changed_paths?.length && (
                <details>
                  <summary>{assistant.handoff.changed_paths.length} 个变更文件</summary>
                  <ul>
                    {assistant.handoff.changed_paths.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {assistant.messages.length > 0 && (
            <div ref={conversationRef} className="assistant-conversation"
              aria-label="开发助手对话" role="log" aria-live="polite"
              aria-relevant="additions text"
              onScroll={(event) => {
                conversationPinned.current = atBottom(event.currentTarget);
              }}>
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
            value={assistantText}
            disabled={assistantRequestBusy || !assistantAvailable
              || assistant.state === "returning"}
            placeholder={assistantAvailable
              ? "例如：帮我定位这个空指针，跑一下相关 UT，能修就直接修"
              : assistant.availability.reason}
            rows={4} onChange={(event) => setAssistantText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void sendAssistant();
              }
            }} />
          <div className="steer-actions assistant-actions">
            <div>
              <span className="steer-hint">
                {assistantWorking
                  ? "当前轮执行中；新输入会在安全边界追加给助手"
                  : takeoverActive
                    ? "CLI 已保持现场和上下文，继续输入下一步"
                    : "⌘/Ctrl + Enter 接管主现场"}
              </span>
              {assistant.error && <small>{assistant.error}</small>}
            </div>
            <div className="assistant-buttons">
              {["acquiring", "working", "running"].includes(assistant.state) && (
                <button type="button" className="assistant-return"
                  disabled={assistantRequestBusy}
                  onClick={() => void stopAssistant()}>
                  停止当前动作
                </button>
              )}
              {canReturn && takeoverActive && (
                <button type="button" className="assistant-return"
                  disabled={assistantRequestBusy}
                  onClick={() => void resumeMainTask()}>
                  交还主任务
                </button>
              )}
              <button type="button" className="steer-send"
                disabled={assistantRequestBusy || !assistantAvailable
                  || assistant.state === "returning" || !assistantText.trim()}
                onClick={() => void sendAssistant()}>
                {assistantRequestBusy ? "发送中…"
                  : ["working", "running", "acquiring"].includes(assistant.state)
                    ? "追加指令" : takeoverActive ? "继续" : "接管并执行"}
              </button>
            </div>
          </div>
        </>
      )}

      {error && <div className="alert">{error}</div>}
    </section>
  );
}
