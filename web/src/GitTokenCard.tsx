/**
 * 个人 Git 令牌(收进"我的工作"页的一根细条)。
 * 只写不读:输入框永远从空白开始,已配置与否只看服务端给的掩码提示;
 * 生效边界=下一次任务启动/会话重建(在跑的任务不换凭据)。
 */

import { useState } from "react";
import { putGitToken, type AuthUser } from "./api";

export function GitTokenCard({ session }: { session: AuthUser }) {
  const [hint, setHint] = useState(session.git_token_hint);
  const [identity, setIdentity] = useState({
    username: session.git_username,
    email: session.git_email,
  });
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [gitUsername, setGitUsername] = useState(session.git_username ?? "");
  const [gitEmail, setGitEmail] = useState(session.git_email ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save(clear = false) {
    setBusy(true); setMessage(""); setError("");
    try {
      const result = await putGitToken(
        clear ? "" : token,
        clear ? undefined : gitUsername || undefined,
        clear ? undefined : gitEmail || undefined);
      setHint(result.git_token_hint);
      setIdentity({
        username: result.git_username,
        email: result.git_email,
      });
      setToken("");
      setMessage(clear
        ? "已删除;之后的任务回到服务级 Git 访问方式。"
        : "已保存;下一次任务启动开始用你的身份推代码、署名提交。");
      if (clear) { setOpen(false); setGitUsername(""); setGitEmail(""); }
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
    } finally { setBusy(false); }
  }

  return <section className="git-token-bar" aria-label="个人 Git 令牌">
    <div className="git-token-copy">
      <span className="section-kicker">GIT CREDENTIAL</span>
      <strong>个人 Git 令牌</strong>
      <small>
        {hint
          ? <>已配置(<code>{hint}</code>
              {identity.username ? <> · {identity.username}</> : null}
              {identity.email ? <> · {identity.email}</> : null}
              ),任务以你的身份推代码并署名提交。
              {!identity.email && "没填邮箱,commit 归属可能认不到你——平台按邮箱认人。"}</>
          : "未配置;任务用服务级方式访问代码仓。"}
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
          placeholder="粘贴平台访问令牌(PAT)"
          onChange={(event) => setToken(event.target.value)} />
        <input value={gitUsername} autoComplete="off"
          placeholder="平台用户名(默认=登录账号)"
          onChange={(event) => setGitUsername(event.target.value)} />
        <input type="email" value={gitEmail} autoComplete="off"
          placeholder="平台邮箱(commit 按它归属到你)"
          onChange={(event) => setGitEmail(event.target.value)} />
        <button type="submit" disabled={busy || !token.trim()}>
          {busy ? "保存中…" : "保存"}</button>
        <button type="button" className="ghost" disabled={busy}
          onClick={() => { setOpen(false); setToken(""); setGitUsername(""); }}>
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
