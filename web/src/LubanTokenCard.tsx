/**
 * 个人通知令牌(小鲁班),与 Git 令牌并排的一根细条。
 *
 * 为什么按人配而不是服务级配一个:那个接口**以令牌对应的人的身份
 * 发消息**——服务号统一发,大家收到的都是同一个机器人;各人配自己
 * 的,就是自己发给自己,不必额外申请机器人账号(用户 2026-08-18 拍板)。
 * 同样只写不读:输入框永远从空白开始,配没配只看服务端给的掩码。
 */

import { useState } from "react";
import { putLubanToken, type AuthUser } from "./api";

export function LubanTokenCard({ session }: { session: AuthUser }) {
  const [hint, setHint] = useState(session.luban_token_hint);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save(clear = false) {
    setBusy(true); setMessage(""); setError("");
    try {
      const result = await putLubanToken(clear ? "" : token);
      setHint(result.luban_token_hint);
      setToken("");
      setMessage(clear
        ? "小鲁班通知已关闭。"
        : "已保存，任务需要你处理时会通过小鲁班提醒。");
      if (clear) setOpen(false);
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
    } finally { setBusy(false); }
  }

  return <section className={`credential-card${hint ? " is-ready" : ""}`} aria-label="小鲁班通知">
    <header className="credential-card-head">
      <span className="credential-icon luban" aria-hidden>
        <svg viewBox="0 0 24 24"><path d="M5 6.5h14v10H9l-4 3z"/><path d="M9 10h6M9 13h4"/></svg>
      </span>
      <div>
        <span className="section-kicker">XIAOLUBAN</span>
        <strong>小鲁班通知</strong>
      </div>
      <span className="credential-state"><i aria-hidden />{hint ? "已配置" : "待配置"}</span>
    </header>
    <p className="credential-summary">任务需要你确认、审批或处理异常时，及时发送消息提醒你。</p>

    <dl className="credential-facts single">
      <div><dt>小鲁班 Token</dt><dd>{hint ? <code>{hint}</code> : "未设置"}</dd></div>
    </dl>
    <div className="credential-howto">
      <span>如何获取</span>
      <p>向小鲁班发送：<code>“获取发送token”</code></p>
    </div>

    <div className="credential-card-actions">
      {message && <span className="credential-feedback success">{message}</span>}
      {error && <span className="credential-feedback error">{error}</span>}
      {!open && <div className="credential-buttons">
        <button type="button" className="credential-primary" onClick={() => {
          setOpen(true); setMessage(""); setError("");
        }}>{hint ? "更新 Token" : "配置小鲁班"}</button>
        {hint && <button type="button" className="credential-text danger" disabled={busy}
          onClick={() => void save(true)}>清除</button>}
      </div>}
    </div>

    {open && <form className="credential-form" onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}>
        <label><span>小鲁班 Token</span>
          <input type="password" value={token} required autoComplete="new-password"
            placeholder="粘贴小鲁班发送 Token"
            onChange={(event) => setToken(event.target.value)} />
          <small>保存后不会回显完整内容，仅显示末 4 位。</small>
        </label>
        <footer>
          <button type="button" className="credential-secondary" disabled={busy}
            onClick={() => { setOpen(false); setToken(""); setError(""); }}>取消</button>
          <button type="submit" className="credential-primary" disabled={busy || !token.trim()}>
            {busy ? "保存中…" : "保存配置"}</button>
        </footer>
      </form>}
  </section>;
}
