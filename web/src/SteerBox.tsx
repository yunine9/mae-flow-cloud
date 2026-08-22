/**
 * 顺便说一句(btw)框:任务在跑的时候,人随时能捎句话。
 *
 * 定位是用户定的:"随时打断的功能其实定位应该有点像 btw"。这比早先的
 * "发送即打断"更诚实——机制上它从来就不是 ESC:pi 把话压进队列,模型
 * **忙完手头那步才读到**,当前命令不会被掐掉。像对旁边干活的同事说
 * "对了,掩码要留后四位",他手上的活不停,抬头时听见了。文案照这个口吻,
 * 别摆出"提交一份补充说明"的架势。
 *
 * 一条纪律:发出去之后不假装它已生效。模型是把手头这一轮的工具调用做完
 * 才收到,可能是几秒也可能是一条长命令的几分钟;这里如实说"忙完这步就会
 * 看到",不写"已送达"。
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
          顺便说一句
        </label>
        <span>它在跑也能说</span>
      </div>
      <p className="steer-copy">想到什么随时捎给它——不打断手头的操作，忙完这一步就会看到。</p>
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
            ? "已捎过去，它忙完这步就会看到"
            : "⌘/Ctrl + Enter 发送"}
        </span>
        <button
          type="button"
          className="steer-send"
          disabled={busy || !text.trim()}
          onClick={() => void send()}
        >
          {busy ? "发送中…" : "发送"}
        </button>
      </div>
      {error && <div className="alert">{error}</div>}
      {history.length > 0 && (
        <ol className="steer-log" aria-label="捎过去的话">
          {history.slice(-4).reverse().map((item, at) => (
            <li key={`${item.at}-${at}`}
                className={item.delivered ? "done" : "waiting"}>
              <span className="steer-log-state">
                {item.delivered ? "已读取" : "待读取"}
              </span>
              <span className="steer-log-text">{item.text}</span>
              {/* 只报"已读取"而不给下文,提问就永远没有答案。这里给的是
                  时间顺序上的下文,不敢叫"回复"——见 listInterrupts 注释。 */}
              {item.said.length > 0 && (
                <span className="steer-said">
                  <em>你说完之后它说的:</em>
                  {item.said.map((said, index) => (
                    <span key={`${said.at}-${index}`}>{said.text}</span>
                  ))}
                </span>
              )}
              {item.delivered && !item.said.length && (
                <span className="steer-said quiet">
                  它读到了,但之后还没说过话——可能正埋头执行,
                  过程记录里能看到它在干什么。
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
