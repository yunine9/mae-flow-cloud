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
        ? "已删除;之后任务要你决定时不会再通知到你。"
        : "已保存;下一条通知起以你的身份发给你。");
      if (clear) setOpen(false);
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
    } finally { setBusy(false); }
  }

  return <section className="git-token-bar" aria-label="个人通知令牌">
    <div className="git-token-copy">
      <span className="section-kicker">NOTIFY CREDENTIAL</span>
      <strong>个人通知令牌</strong>
      <small>
        {hint
          ? <>已配置(<code>{hint}</code>),任务停在等你决定或需要人工时
              会发消息找你。</>
          : "未配置;任务要你决定时没人喊得到你——下单前必须先配。"}
        令牌只写不读——保存后这里永远只显示末 4 位。
      </small>
    </div>
    <div className="git-token-actions">
      {message && <span className="git-token-note success">{message}</span>}
      {error && <span className="git-token-note error">{error}</span>}
      {open ? <form className="git-token-form" onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}>
        <input type="password" value={token} required autoComplete="new-password"
          placeholder="粘贴通知令牌"
          onChange={(event) => setToken(event.target.value)} />
        <button type="submit" disabled={busy || !token.trim()}>
          {busy ? "保存中…" : "保存"}</button>
        <button type="button" className="ghost" disabled={busy}
          onClick={() => { setOpen(false); setToken(""); }}>
          取消</button>
      </form> : <>
        <button type="button" className="ghost" onClick={() => setOpen(true)}>
          {hint ? "更换令牌" : "配置令牌"}</button>
        {hint && <button type="button" className="ghost danger" disabled={busy}
          onClick={() => void save(true)}>删除</button>}
      </>}
    </div>
  </section>;
}
