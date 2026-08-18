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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  // 任务级可填项(2026-08-18 重定口径):交付仓**必填**、交付方式、修复轮
  // 预算。模型不给选——管理员统一配一个,这里只显示"这单用谁跑"。
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const [repo, setRepo] = useState("");
  // 单号/基线分支:内核配置确认要的两项事实,下单一并收齐——
  // 不让模型开工后再逐项来问(用户 2026-08-19 拍板,基线默认 master)。
  const [ticket, setTicket] = useState("");
  const [baseline, setBaseline] = useState("");
  // 交付方式下单就定(用户拍板:不让 agent 再问一遍);选项与默认值
  // 都来自内核,空串=等 options 到了再取第一项。
  const [lane, setLane] = useState("");
  const [repairRounds, setRepairRounds] = useState("");
  // 配置没配齐不让下单:缺项来自后端(服务级+个人级),前端只负责
  // 摆在明面上。后端同样硬拦——绕过界面打接口一样被 409 挡住。
  const blockers = options?.blockers ?? [];
  const blocked = blockers.length > 0;

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
      await createTask(
        requirement.trim(),
        session.username,   // 归属人=本人;管理员不发起任务(入口已隐藏)
        {
          repo: repo.trim() || undefined,
          lane,
          ticket: ticket.trim() || undefined,
          baseline: baseline.trim() || undefined,
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
            <p>任务会自动归入你的工作台，人工节点也会回到你的待核对列表。</p>
          </div>
          {blocked && (
            <div className="launch-blockers" role="alert">
              <strong>先把配置补齐,才能下单</strong>
              <ul>
                {blockers.map((item) => (
                  <li key={item.key}>
                    <span className={`blocker-where blocker-${item.where}`}>
                      {item.where === "admin" ? "管理员" : "你自己"}
                    </span>
                    {item.label}
                  </li>
                ))}
              </ul>
              <small>
                这些都是"以谁的身份做事"的凭据:Git 令牌决定推送与 MR
                挂在谁名下,通知令牌决定消息以谁的身份发——密钥只写不读,
                管理员也代配不了,只能各人自己配一次。
              </small>
            </div>
          )}
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
                <span>交付代码仓{options.repo.required ? "（必填）" : ""}</span>
                <input
                  type="text"
                  value={repo}
                  onChange={(event) => setRepo(event.target.value)}
                  placeholder="代码仓地址（如 https://codehub…/xxx.git）"
                  spellCheck={false}
                  required={options.repo.required}
                />
                <small className="repo-field-note">
                  每单都要写明交到哪个仓（本部署不设默认仓，避免下错地方）；
                  地址不要带账号密码，推送鉴权走个人 Git 令牌。
                </small>
              </label>
            )}
            <div className="composer-actions">
              {/* 单号/基线分支:下单收齐,模型开工不再逐项来问。 */}
              {options?.ticket.enabled && (
                <label className="account-field">
                  <span>需求/问题单号{options.ticket.required ? "（必填）" : ""}</span>
                  <input
                    type="text"
                    value={ticket}
                    onChange={(event) => setTicket(event.target.value)}
                    placeholder="如 REQ2026xxxx / DTS2026xxxx"
                    spellCheck={false}
                    required={options.ticket.required}
                  />
                </label>
              )}
              {options?.baseline.enabled && (
                <label className="account-field">
                  <span>基线分支</span>
                  <input
                    type="text"
                    value={baseline}
                    onChange={(event) => setBaseline(event.target.value)}
                    placeholder={`默认 ${options.baseline.default}`}
                    spellCheck={false}
                  />
                </label>
              )}
              <label className="account-field">
                <span>任务归属</span>
                <input type="text" value={session.username} readOnly />
              </label>
              {(options?.workflows.length ?? 0) > 0 && (
                // 选项来自内核 flow.json(不在前端另抄一份):下单选定，
                // 流程里那张“交付方式”卡由系统拿这个答案自动交卷。
                <label className="account-field">
                  <span>交付方式</span>
                  <select
                    className="launch-model-select"
                    value={lane || options!.workflows[0].label}
                    onChange={(event) => setLane(event.target.value)}
                  >
                    {options!.workflows.map((item) => (
                      <option key={item.key} value={item.label}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {options?.model && (
                // 模型不给选(管理员统一配),只告诉人这单谁来跑。
                <label className="account-field">
                  <span>执行模型</span>
                  <input type="text" value={options.model.model} readOnly />
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
              <button type="submit" disabled={submitting || blocked}>
                <span>{submitting ? "正在发起"
                  : blocked ? "配置未完成" : "确认发起"}</span>
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
