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

export function GitTokenCard({
  session,
  onChanged,
}: {
  session: AuthUser;
  onChanged?: (credential: { git_token_hint?: string; git_email?: string }) => void;
}) {
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
      onChanged?.({
        git_token_hint: result.git_token_hint,
        git_email: result.git_email,
      });
      setToken("");
      setMessage(clear
        ? "CodeHub 配置已清除。"
        : "已保存，下一次任务将使用你的身份提交代码。");
      if (clear) { setOpen(false); setGitEmail(""); }
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
    } finally { setBusy(false); }
  }

  return <section className={`credential-card${hint ? " is-ready" : ""}`} aria-label="CodeHub 提交身份">
    <header className="credential-card-head">
      <span className="credential-icon codehub" aria-hidden>
        <svg viewBox="0 0 24 24"><path d="M8 7.5h8M8 12h8M8 16.5h5"/><path d="M5 3.5h14v17H5z"/></svg>
      </span>
      <div>
        <span className="section-kicker">CODEHUB</span>
        <strong>CodeHub 提交身份</strong>
      </div>
      <span className="credential-state"><i aria-hidden />{hint ? "已配置" : "待配置"}</span>
    </header>
    <p className="credential-summary">用于拉取、推送代码，并把 Git 提交正确归属到你。</p>

    <dl className="credential-facts">
      <div><dt>个人邮箱</dt><dd>{email || "未设置"}</dd></div>
      <div><dt>CodeHub Token</dt><dd>{hint ? <code>{hint}</code> : "未设置"}</dd></div>
    </dl>

    <div className="credential-card-actions">
      {message && <span className="credential-feedback success">{message}</span>}
      {error && <span className="credential-feedback error">{error}</span>}
      {!open && <div className="credential-buttons">
        <button type="button" className="credential-primary" onClick={() => {
          setOpen(true); setMessage(""); setError("");
        }}>{hint ? "更新配置" : "配置 CodeHub"}</button>
        {hint && <button type="button" className="credential-text danger" disabled={busy}
          onClick={() => void save(true)}>清除</button>}
      </div>}
    </div>

    {open && <form className="credential-form" onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}>
        <label><span>个人邮箱</span>
          <input type="email" value={gitEmail} required autoComplete="off"
            placeholder="name@company.com"
            onChange={(event) => setGitEmail(event.target.value)} />
          <small>用于 Git commit 署名和 CodeHub 归属。</small>
        </label>
        <label><span>CodeHub Token</span>
          <input type="password" value={token} required autoComplete="new-password"
            placeholder="粘贴 CodeHub 访问 Token"
            onChange={(event) => setToken(event.target.value)} />
          <small>仅用于代码仓访问；保存后不会回显完整内容。</small>
        </label>
        <footer>
          <button type="button" className="credential-secondary" disabled={busy}
            onClick={() => { setOpen(false); setToken(""); setError(""); }}>取消</button>
          <button type="submit" className="credential-primary"
            disabled={busy || !token.trim() || !gitEmail.trim()}>
            {busy ? "保存中…" : "保存配置"}</button>
        </footer>
      </form>}
  </section>;
}
