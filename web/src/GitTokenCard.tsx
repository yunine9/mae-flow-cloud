/**
 * 个人 Git 令牌 + 署名邮箱(收进"我的工作"页的一根细条)。
 * 只写不读:令牌输入框永远从空白开始,已配置与否只看服务端给的掩码;
 * 生效边界=下一次任务启动/会话重建(在跑的任务不换凭据)。
 *
 * 口径(用户 2026-08-19 拍板):**邮箱必填**(commit 署名与平台对人都
 * 要它);**用户名不另配**——git 用户名就是登录账号名,账号由管理员按
 * 平台用户名建,再开一个字段只会造出两个可以互相不一致的真相。
 */

import { useState } from "react";
import { putGitToken, type AuthUser } from "./api";

export function GitTokenCard({ session }: { session: AuthUser }) {
  const [hint, setHint] = useState(session.git_token_hint);
  const [email, setEmail] = useState(session.git_email);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [gitEmail, setGitEmail] = useState(session.git_email ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save(clear = false) {
    setBusy(true); setMessage(""); setError("");
    try {
      const result = await putGitToken(
        clear ? "" : token,
        clear ? undefined : gitEmail || undefined);
      setHint(result.git_token_hint);
      setEmail(result.git_email);
      setToken("");
      setMessage(clear
        ? "已删除;之后的任务回到服务级 Git 访问方式。"
        : "已保存;下一次任务启动开始用你的身份推代码、署名提交。");
      if (clear) { setOpen(false); setGitEmail(""); }
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
    } finally { setBusy(false); }
  }

  return <section className="git-token-bar" aria-label="个人 Git 令牌">
    <div className="git-token-copy">
      <span className="section-kicker">GIT CREDENTIAL</span>
      <strong>个人 Git 令牌与署名</strong>
      <small>
        {hint
          ? <>已配置(<code>{hint}</code>
              {" · "}{session.username}
              {email ? <> · {email}</> : null}
              ),任务以你的身份推代码并署名提交。</>
          : "未配置;任务用服务级方式访问代码仓。"}
        {" git 用户名即登录账号;令牌只写不读——保存后这里永远只显示末 4 位。"}
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
          placeholder="粘贴平台访问令牌(PAT)"
          onChange={(event) => setToken(event.target.value)} />
        <input type="email" value={gitEmail} required autoComplete="off"
          placeholder="平台邮箱(必填,commit 按它归属到你)"
          onChange={(event) => setGitEmail(event.target.value)} />
        <button type="submit"
          disabled={busy || !token.trim() || !gitEmail.trim()}>
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
