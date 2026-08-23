import { useEffect, useState } from "react";
import {
  createTask,
  getLaunchOptions,
  type AuthUser,
  type LaunchOptions,
} from "./api";
import {
  EMPTY_REPOSITORY_SKILL_SELECTION,
  RepositorySkillPicker,
  type RepositorySkillSelection,
} from "./RepositorySkillPicker";

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
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState("");
  // 任务级可填项(2026-08-18 重定口径):交付仓**必填**、交付方式、修复轮
  // 预算。模型不给选——管理员统一配一个,这里只显示"这单用谁跑"。
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const [repos, setRepos] = useState([""]);
  // 单号/基线分支:内核配置确认要的两项事实,下单一并收齐——
  // 不让模型开工后再逐项来问(用户 2026-08-19 拍板,基线默认 master)。
  const [ticket, setTicket] = useState("");
  const [baseline, setBaseline] = useState("");
  // 交付方式下单就定(用户拍板:不让 agent 再问一遍);选项与默认值
  // 都来自内核,空串=等 options 到了再取第一项。
  const [lane, setLane] = useState("");
  const [repairRounds, setRepairRounds] = useState("");
  const [repositorySkillSelection, setRepositorySkillSelection] =
    useState<RepositorySkillSelection>(EMPTY_REPOSITORY_SKILL_SELECTION);
  // 配置没配齐不让下单:缺项来自后端(服务级+个人级),前端只负责
  // 摆在明面上。后端同样硬拦——绕过界面打接口一样被 409 挡住。
  const blockers = options?.blockers ?? [];
  const blocked = optionsLoading || blockers.length > 0 || !!optionsError;

  useEffect(() => {
    let alive = true;
    void getLaunchOptions().then((result) => {
      if (alive) setOptions(result);
    }).catch(() => {
      if (alive) setOptionsError("未能读取任务配置，请刷新后重试");
    }).finally(() => {
      if (alive) setOptionsLoading(false);
    });
    return () => { alive = false; };
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

  function invalidateSkillCatalog() {
    setRepositorySkillSelection(EMPTY_REPOSITORY_SKILL_SELECTION);
  }

  function changeRepository(index: number, value: string) {
    invalidateSkillCatalog();
    setRepos((current) => current.map(
      (item, itemIndex) => itemIndex === index ? value : item));
  }

  function addRepository() {
    invalidateSkillCatalog();
    setRepos((current) => [...current, ""]);
  }

  function removeRepository(index: number) {
    invalidateSkillCatalog();
    setRepos((current) => current.filter(
      (_, itemIndex) => itemIndex !== index));
  }

  function changeBaseline(value: string) {
    invalidateSkillCatalog();
    setBaseline(value);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !requirement.trim() || submitting || blocked
        || repositorySkillSelection.scanning) return;
    setSubmitting(true);
    setError("");
    try {
      await createTask(
        requirement.trim(),
        session.username,   // 归属人=本人;管理员不发起任务(入口已隐藏)
        {
          title: title.trim(),
          repo: repos[0]?.trim() || undefined,
          repos: repos.map((item) => item.trim()).filter(Boolean),
          // select 虽然会视觉显示第一项，但用户没手动切换时 state 仍是
          // 空串；提交必须使用屏幕上真正显示的默认项。
          lane: lane || options?.workflows[0]?.label,
          ticket: ticket.trim() || undefined,
          baseline: baseline.trim() || undefined,
          repairRounds: repairRounds.trim() === ""
            ? undefined : Number(repairRounds),
          repositorySkillCatalogToken:
            repositorySkillSelection.selectedIds.length > 0
              ? repositorySkillSelection.catalogToken : undefined,
          selectedRepositorySkillIds:
            repositorySkillSelection.selectedIds.length > 0
              ? repositorySkillSelection.selectedIds : undefined,
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
          <aside className="launch-copy">
            <span className="section-kicker">CREATE WORK</span>
            <h2 id="launch-title">描述要交付的结果</h2>
            <p>任务会自动归入你的工作台，人工节点也会回到你的待核对列表。</p>
            <ol className="launch-guide" aria-label="创建任务步骤">
              <li><i>1</i><span><strong>说清结果</strong><small>描述完成标准，不必编排 Agent 步骤</small></span></li>
              <li><i>2</i><span><strong>圈定范围</strong><small>填写一个或多个相关代码仓</small></span></li>
              <li><i>3</i><span><strong>确认执行</strong><small>负责人和交付方式一次选好</small></span></li>
            </ol>
            <small className="launch-copy-foot">提交后可在“我的工作”持续跟进和控制任务。</small>
          </aside>

          <div className="launch-form-shell">
            <div className="launch-form-intro">
              <div><span>NEW DELIVERY</span><strong>填写任务信息</strong></div>
              <small><i aria-hidden /> 必填项请一次填完整</small>
            </div>

            {optionsLoading && <div className="launch-loading">正在读取任务配置…</div>}
            {optionsError && <div className="launch-blockers" role="alert"><strong>暂时无法发起</strong><p>{optionsError}</p></div>}
            {!optionsLoading && blockers.length > 0 && (
              <div className="launch-blockers" role="alert">
                <div className="launch-blocker-head">
                  <span aria-hidden>!</span>
                  <div><strong>还差 {blockers.length} 项配置</strong><small>补齐后即可发起任务</small></div>
                </div>
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
                <p>个人凭据只能由本人在“个人设置”配置，密钥不会回显。</p>
              </div>
            )}

            <form className="composer launch-composer" onSubmit={submit}>
              <section className="launch-form-section launch-requirement-section">
                <div className="launch-section-head"><i>01</i><div><strong>任务与需求</strong><small>名称用于快速识别，需求文档完整交给 Agent</small></div><em>必填</em></div>
                <label className="account-field launch-title-field">
                  <span>任务名称</span>
                  <input type="text" value={title} maxLength={80}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="例如：修复通知模板变量缺失"
                    autoFocus required />
                  <small>用于任务卡、通知和团队总览，不会替代需求文档</small>
                </label>
                <label className="requirement-field">
                  <span>需求文档</span>
                  <textarea
                    value={requirement}
                    onChange={(event) => setRequirement(event.target.value)}
                    placeholder="粘贴完整需求说明、背景、范围和验收标准；支持 Markdown"
                    rows={10}
                    required
                  />
                  <small>{requirement
                    ? `${requirement.split(/\r?\n/).length} 行 · ${requirement.length} 字符，原文将完整保留`
                    : "这里是 Agent 实际接收的完整原文，不会被截成标题"}</small>
                </label>
              </section>

              {options && (options.repo.enabled || options.ticket.enabled || options.baseline.enabled) && (
                <section className="launch-form-section">
                  <div className="launch-section-head"><i>02</i><div><strong>交付定位</strong><small>Agent 据此进入正确仓库和分支</small></div></div>
                  {options.repo.enabled && (
                    <div className="repo-field">
                      <div className="repo-field-title">
                        <span>涉及代码仓{options.repo.required ? "（至少一个）" : ""}</span>
                        <small>单仓与多仓使用同一条需求交付流程</small>
                      </div>
                      <div className="repo-list">
                        {repos.map((value, index) => (
                          <div className="repo-row" key={index}>
                            <span>{String(index + 1).padStart(2, "0")}</span>
                            <input type="text" value={value}
                              onChange={(event) => changeRepository(index, event.target.value)}
                              placeholder="https://codehub…/team/project.git"
                              spellCheck={false}
                              required={options.repo.required} />
                            {repos.length > 1 && <button type="button"
                              aria-label={`移除第 ${index + 1} 个仓库`}
                              onClick={() => removeRepository(index)}>×</button>}
                          </div>
                        ))}
                      </div>
                      <button type="button" className="repo-add"
                        onClick={addRepository}>
                        <span>＋</span> 添加代码仓
                      </button>
                      <small className="repo-field-note">
                        {repos.length > 1
                          ? `已选择 ${repos.length} 个仓库；系统会先分析职责、接口与开发依赖，人工确认后再拆分交付。`
                          : "一个仓库就是只有一个交付节点的需求；需要跨仓时继续添加。"}
                      </small>
                    </div>
                  )}
                  <div className="launch-field-grid">
                    {options.ticket.enabled && (
                      <label className="account-field">
                        <span>需求/问题单号{options.ticket.required ? "（必填）" : ""}</span>
                        <input type="text" value={ticket}
                          onChange={(event) => setTicket(event.target.value)}
                          placeholder="REQ2026xxxx / DTS2026xxxx" spellCheck={false}
                          required={options.ticket.required} />
                      </label>
                    )}
                    {options.baseline.enabled && (
                      <label className="account-field">
                        <span>基线分支</span>
                        <input type="text" value={baseline}
                          onChange={(event) => changeBaseline(event.target.value)}
                          placeholder={`默认 ${options.baseline.default}`} spellCheck={false} />
                      </label>
                    )}
                  </div>
                </section>
              )}
              {options?.repo.enabled && (
                <RepositorySkillPicker
                  key={JSON.stringify([repos, baseline])}
                  repositories={repos}
                  baseline={baseline}
                  onSelectionChange={setRepositorySkillSelection}
                />
              )}
              <section className="launch-form-section">
                <div className="launch-section-head"><i>03</i><div><strong>执行设置</strong><small>选定交付方式和修复预算;任务自动归属你本人</small></div></div>
                <div className="launch-field-grid launch-settings-grid">
                  {(options?.workflows.length ?? 0) > 0 && (
                    <label className="account-field">
                      <span>交付方式</span>
                      <select className="launch-model-select"
                        value={lane || options!.workflows[0].label}
                        onChange={(event) => setLane(event.target.value)}>
                        {options!.workflows.map((item) => (
                          <option key={item.key} value={item.label}>
                            {item.label}
                            {item.steps !== undefined
                              ? `（${item.steps} 步 · 拍板 ${item.acks} 次）` : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {options && (
                    <label className="account-field repair-field">
                      <span>修复轮预算</span>
                      <input type="text" inputMode="numeric" value={repairRounds}
                        onChange={(event) => setRepairRounds(event.target.value)}
                        placeholder={options.repair_rounds !== undefined
                          ? `默认 ${options.repair_rounds}（0=关）`
                          : "默认不限轮（0=关）"} />
                    </label>
                  )}
                </div>
              </section>

              {error && <div className="composer-error" role="alert">{error}</div>}
              <footer className="launch-submit-bar">
                <div><strong>{blocked
                  ? "暂时不能发起"
                  : repositorySkillSelection.scanning
                    ? "正在读取仓内能力"
                    : "信息确认后即可启动"}</strong><small>{blocked
                  ? "请先处理上方配置项"
                  : repositorySkillSelection.scanning
                    ? "读取完成后可确认选择并启动"
                    : "任务创建后会自动进入你的工作台"}</small></div>
                <button type="submit" disabled={submitting || blocked
                  || repositorySkillSelection.scanning}>
                  <span>{submitting
                    ? "正在发起"
                    : optionsLoading
                      ? "读取配置中"
                      : blocked
                        ? "配置未完成"
                        : repositorySkillSelection.scanning
                          ? "读取能力中"
                          : "确认发起"}</span>
                  <svg viewBox="0 0 20 20" aria-hidden><path d="M4 10h11M11 6l4 4-4 4" /></svg>
                </button>
              </footer>
            </form>
          </div>
        </section>
      </main>
    </section>
  );
}
