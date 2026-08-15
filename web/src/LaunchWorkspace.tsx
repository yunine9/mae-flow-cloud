import { useEffect, useState } from "react";
import { createTask, type AuthUser } from "./api";

export function LaunchWorkspace({
  session,
  onCreated,
  onClose,
}: {
  session: AuthUser;
  onCreated: () => Promise<void>;
  onClose: () => void;
}) {
  const [requirement, setRequirement] = useState("");
  const [account, setAccount] = useState(session.username);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, submitting]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!requirement.trim() || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await createTask(
        requirement.trim(),
        session.role === "admin" ? account.trim() || undefined : session.username,
      );
      await onCreated();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error
        ? reason.message
        : "任务没有发起成功，请检查服务后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      className="workspace-overlay launch-workspace"
      role="dialog"
      aria-modal="true"
      aria-labelledby="launch-workspace-title"
    >
      <header className="ws-head">
        <button type="button" className="ws-back" onClick={onClose} disabled={submitting} autoFocus>
          <svg viewBox="0 0 20 20" aria-hidden><path d="m12.5 5-5 5 5 5" /></svg>
          <span>返回我的工作</span>
        </button>
        <div className="ws-identity">
          <div className="ws-identity-line"><code>NEW TASK</code></div>
          <strong id="launch-workspace-title">发起新任务</strong>
        </div>
      </header>

      <main className="launch-workspace-body">
        <section className="launch-panel" aria-labelledby="launch-title">
          <div className="launch-copy">
            <span className="section-kicker">CREATE WORK</span>
            <h2 id="launch-title">描述要交付的结果</h2>
            <p>{session.role === "admin"
              ? "创建任务并指定负责人；提交后回到个人待办继续跟进。"
              : "任务会自动归入你的工作台，人工节点也会回到你的待核对列表。"}</p>
          </div>
          <form className="composer" onSubmit={submit}>
            <label className="requirement-field">
              <span>任务需求</span>
              <textarea
                value={requirement}
                onChange={(event) => setRequirement(event.target.value)}
                placeholder="例如：交付 REQ2026xxxx，修复通知模板变量缺失问题并补齐单元测试"
                rows={5}
                autoFocus
                required
              />
            </label>
            <div className="composer-actions">
              <label className="account-field">
                <span>{session.role === "admin" ? "任务负责人" : "任务归属"}</span>
                <input
                  type="text"
                  value={session.role === "admin" ? account : session.username}
                  onChange={(event) => setAccount(event.target.value)}
                  placeholder="本地账号"
                  readOnly={session.role !== "admin"}
                />
              </label>
              <button type="submit" disabled={submitting}>
                <span>{submitting ? "正在发起" : "确认发起"}</span>
                <svg viewBox="0 0 20 20" aria-hidden><path d="M4 10h11M11 6l4 4-4 4" /></svg>
              </button>
            </div>
            {error && <div className="composer-error" role="alert">{error}</div>}
          </form>
        </section>
      </main>
    </section>
  );
}
