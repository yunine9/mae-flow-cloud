import { useEffect, useState } from "react";
import {
  createTask,
  getLaunchOptions,
  type AuthUser,
  type LaunchOptions,
} from "./api";

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
  // 任务级可选项(用户拍板只有这两个):模型选择、修复轮预算。
  // 拉不到数据源就不展示——表单退回最简形态,发单不受影响(fail-open)。
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const [repo, setRepo] = useState("");
  // 车道下单就定(用户拍板:不让 agent 来问),默认慢速。
  const [lane, setLane] = useState("慢速");
  const [modelKey, setModelKey] = useState("");
  const [repairRounds, setRepairRounds] = useState("");

  useEffect(() => {
    getLaunchOptions().then(setOptions).catch(() => setOptions(null));
  }, []);

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
      // 模型 id 里可能有 "/"(如 org/model),只切第一段作 provider。
      const slash = modelKey.indexOf("/");
      const provider = modelKey.slice(0, slash);
      const model = modelKey.slice(slash + 1);
      await createTask(
        requirement.trim(),
        session.role === "admin" ? account.trim() || undefined : session.username,
        {
          repo: repo.trim() || undefined,
          lane,
          model: modelKey ? { provider, model } : undefined,
          repairRounds: repairRounds.trim() === ""
            ? undefined : Number(repairRounds),
        },
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
            {options?.repo.enabled && (
              <label className="repo-field">
                <span>交付代码仓</span>
                <input
                  type="text"
                  value={repo}
                  onChange={(event) => setRepo(event.target.value)}
                  placeholder={options.repo.default
                    ? `默认：${options.repo.default}`
                    : "代码仓地址（如 https://codehub…/xxx.git）"}
                  spellCheck={false}
                />
                <small className="repo-field-note">
                  留空用服务默认仓；地址不要带账号密码，推送鉴权走个人
                  Git 令牌。
                </small>
              </label>
            )}
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
              <label className="account-field">
                <span>工作流车道</span>
                <select
                  className="launch-model-select"
                  value={lane}
                  onChange={(event) => setLane(event.target.value)}
                >
                  <option value="慢速">慢速（完整流程，默认）</option>
                  <option value="快速">快速（轻量流程）</option>
                </select>
              </label>
              {options && options.models.length > 1 && (
                <label className="account-field">
                  <span>模型</span>
                  <select
                    className="launch-model-select"
                    value={modelKey}
                    onChange={(event) => setModelKey(event.target.value)}
                  >
                    <option value="">
                      默认{options.default.model
                        ? `（${options.default.model}）` : ""}
                    </option>
                    {options.models.map((item) => (
                      <option
                        key={`${item.provider}/${item.model}`}
                        value={`${item.provider}/${item.model}`}
                      >
                        {item.model}（{item.provider}）
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {options && (
                <label className="account-field repair-field">
                  <span>修复轮预算</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={repairRounds}
                    onChange={(event) => setRepairRounds(event.target.value)}
                    placeholder={options.repair_rounds !== undefined
                      ? `默认 ${options.repair_rounds}（0=关）`
                      : "默认不限轮（0=关）"}
                  />
                </label>
              )}
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
