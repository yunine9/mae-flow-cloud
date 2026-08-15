/**
 * 插话框:任务在跑的时候,人随时能说话。
 *
 * 本地 CLI 里这件事是 ESC + 打字。网页上没有"要抢回输入行"这回事,
 * 所以没有"打断"这个单独动作——**发送本身就是打断**。文案也照这个说,
 * 别让人先想"我要不要先按个什么"。
 *
 * 一条纪律:发出去之后不假装它已生效。模型是把手头这一轮的工具调用做完
 * 才收到,可能是几秒也可能是一条长命令的几分钟;这里如实说"做完手头这件
 * 事就会收到",不写"已送达"。
 */

import { useEffect, useState } from "react";
import { interruptTask, listInterrupts, type InterruptRecord } from "./api";
import "./steer.css";

export function SteerBox({
  taskId,
  onSent,
}: {
  taskId: string;
  onSent?: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [history, setHistory] = useState<InterruptRecord[]>([]);

  // 发完就没了、不知道它读没读到,等于对着空气说话。送达是可观测的:
  // 消息离开 pi 的待送队列 = 已进入模型上下文。5 秒跟一次。
  useEffect(() => {
    let alive = true;
    const load = () => void listInterrupts(taskId).then((rows) => {
      if (alive) setHistory(rows);
    });
    load();
    const timer = window.setInterval(load, 5000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [taskId, sent]);

  async function send() {
    const message = text.trim();
    if (!message || busy) return;
    setBusy(true);
    setError("");
    const result = await interruptTask(taskId, message);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    // 话已交出去,输入框清空;人接着看材料、接着圈下一处。
    setText("");
    setSent(true);
    onSent?.();
  }

  return (
    <div className="steer">
      <div className="steer-head">
        <label className="steer-label" htmlFor={`steer-${taskId}`}>
          补充任务说明
        </label>
        <span>执行中可发送</span>
      </div>
      <p className="steer-copy">补充约束或修正方向，任务会在当前操作结束后读取。</p>
      <textarea
        id={`steer-${taskId}`}
        className="steer-input"
        value={text}
        placeholder="例如：掩码保留后四位，不要处理区号"
        rows={3}
        onChange={(event) => {
          setText(event.target.value);
          if (sent) setSent(false);
        }}
        onKeyDown={(event) => {
          // Cmd/Ctrl+Enter 发送:回车留给换行,意见常常不止一行。
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void send();
          }
        }}
      />
      <div className="steer-actions">
        <span className="steer-hint">
          {sent && !text
            ? "已发送，等待任务读取"
            : "⌘/Ctrl + Enter 发送"}
        </span>
        <button
          type="button"
          className="steer-send"
          disabled={busy || !text.trim()}
          onClick={() => void send()}
        >
          {busy ? "发送中…" : "发送补充说明"}
        </button>
      </div>
      {error && <div className="alert">{error}</div>}
      {history.length > 0 && (
        <ol className="steer-log" aria-label="已发送的补充说明">
          {history.slice(-4).reverse().map((item, at) => (
            <li key={`${item.at}-${at}`}
                className={item.delivered ? "done" : "waiting"}>
              <span className="steer-log-state">
                {item.delivered ? "已读取" : "待读取"}
              </span>
              <span className="steer-log-text">{item.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
