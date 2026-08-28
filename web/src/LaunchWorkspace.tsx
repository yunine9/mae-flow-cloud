import { useEffect, useMemo, useState } from "react";
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
import {
  asRepositoryProfiles,
  RepositoryTechnologyPicker,
  type RepositoryTechnologyDraft,
} from "./RepositoryTechnologyPicker";
import { KnowledgeLanguageTags } from "./KnowledgeLanguages";

const MAX_MARKDOWN_BYTES = 512 * 1024;
const INLINE_MARKDOWN_BYTES = 32 * 1024;
const LAUNCH_DRAFT_VERSION = 1;
type LaunchDraft = {
  version: 1;
  updatedAt: string;
  title: string;
  requirement: string;
  requirementDocumentName: string;
  repos: string[];
  ticket: string;
  baseline: string;
  lane: string;
  repairRounds: string;
  taskInstructions?: string;
  selectedBusinessModuleIds?: string[];
};
type LaunchPreferences = {
  recentRepos: string[];
  baseline?: string;
  lane?: string;
  repairRounds?: string;
};

function storageKey(kind: "draft" | "preferences", account: string): string {
  return `mae-flow:launch:${kind}:${account}`;
}

function readStored<T>(key: string): T | undefined {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : undefined;
  } catch {
    return undefined;
  }
}

function repositoryIdentity(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}
export function LaunchWorkspace({
  session,
  onCreated,
  onClose,
}: {
  session: AuthUser;
  onCreated: () => Promise<void>;
  onClose: () => void;
}) {
  const [restoredDraft] = useState(() =>
    readStored<LaunchDraft>(storageKey("draft", session.username)));
  const [savedPreferences] = useState(() =>
    readStored<LaunchPreferences>(storageKey("preferences", session.username)));
  const validDraft = restoredDraft?.version === LAUNCH_DRAFT_VERSION
      && (restoredDraft as LaunchDraft & { entryKind?: string }).entryKind !== "dts"
    ? restoredDraft : undefined;
  const [requirement, setRequirement] = useState(
    validDraft?.requirement ?? "");
  const [requirementDocumentName, setRequirementDocumentName] = useState(
    validDraft?.requirementDocumentName ?? "");
  const [documentError, setDocumentError] = useState("");
  const [draggingDocument, setDraggingDocument] = useState(false);
  const [title, setTitle] = useState(validDraft?.title ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState("");
  // 任务级可填项(2026-08-18 重定口径):交付仓**必填**、交付方式、修复轮
  // 预算。模型不给选——管理员统一配一个,这里只显示"这单用谁跑"。
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const [repos, setRepos] = useState(validDraft?.repos?.length
    ? validDraft.repos
    : savedPreferences?.recentRepos?.[0]
      ? [savedPreferences.recentRepos[0]] : [""]);
  // 单号/基线分支:内核配置确认要的两项事实,下单一并收齐——
  // 不让模型开工后再逐项来问(用户 2026-08-19 拍板,基线默认 master)。
  const [ticket, setTicket] = useState(validDraft?.ticket ?? "");
  const [baseline, setBaseline] = useState(
    validDraft?.baseline ?? savedPreferences?.baseline ?? "");
  // 交付方式下单就定(用户拍板:不让 agent 再问一遍);选项与默认值
  // 都来自内核,空串=等 options 到了再取第一项。
  const [lane, setLane] = useState(
    validDraft?.lane ?? savedPreferences?.lane ?? "");
  const [repairRounds, setRepairRounds] = useState(
    validDraft?.repairRounds ?? savedPreferences?.repairRounds ?? "");
  const [taskInstructions, setTaskInstructions] = useState(
    validDraft?.taskInstructions ?? "");
  const [selectedBusinessModuleIds, setSelectedBusinessModuleIds] = useState(
    validDraft?.selectedBusinessModuleIds ?? []);
  const [moduleSelectionNotice, setModuleSelectionNotice] = useState("");
  const [draftSavedAt, setDraftSavedAt] = useState(
    validDraft?.updatedAt ?? "");
  const [repositorySkillSelection, setRepositorySkillSelection] =
    useState<RepositorySkillSelection>(EMPTY_REPOSITORY_SKILL_SELECTION);
  const [repositoryTechnologies, setRepositoryTechnologies] =
    useState<RepositoryTechnologyDraft[]>([]);
  const [selectedEngineeringKnowledgeIds, setSelectedEngineeringKnowledgeIds] =
    useState<string[]>([]);
  const [engineeringSelectionTouched, setEngineeringSelectionTouched] =
    useState(false);
  // 配置没配齐不让下单:缺项来自后端(服务级+个人级),前端只负责
  // 摆在明面上。后端同样硬拦——绕过界面打接口一样被 409 挡住。
  const blockers = options?.blockers ?? [];
  const blocked = optionsLoading || blockers.length > 0 || !!optionsError;
  const businessModules = useMemo(() => {
    const wantedRepos = new Set(repos.map(repositoryIdentity).filter(Boolean));
    return [...(options?.business_modules ?? [])].sort((left, right) => {
      const leftMatch = left.repositories.some((repo) =>
        wantedRepos.has(repositoryIdentity(repo)));
      const rightMatch = right.repositories.some((repo) =>
        wantedRepos.has(repositoryIdentity(repo)));
      return Number(rightMatch) - Number(leftMatch)
        || left.name.localeCompare(right.name);
    });
  }, [options, repos]);
  const matchingEngineeringKnowledge = useMemo(() => {
    const repositorySet = new Set(repos.map(repositoryIdentity).filter(Boolean));
    const technologies = new Set(repositoryTechnologies
      .flatMap((item) => item.technologies));
    return (options?.engineering_knowledge ?? []).filter((item) =>
      (!item.repositories.length || item.repositories.some((repository) =>
        repositorySet.has(repositoryIdentity(repository))))
      && (!item.technologies.length || item.technologies.some((technology) =>
        technologies.has(technology)))
      && (!item.business_module_ids.length || item.business_module_ids.some((id) =>
        selectedBusinessModuleIds.includes(id))));
  }, [options, repos, repositoryTechnologies, selectedBusinessModuleIds]);
  const deliveryLocationVisible = !!options
    && (options.repo.enabled || options.ticket.enabled || options.baseline.enabled);
  const executionSectionNumber = deliveryLocationVisible ? "03" : "02";
  const moduleSectionNumber = String(
    Number(executionSectionNumber) + 1).padStart(2, "0");

  useEffect(() => {
    let alive = true;
    void getLaunchOptions().then((result) => {
      if (!alive) return;
      setOptions(result);
      setBaseline((current) => current.trim()
        || (result.baseline.enabled ? result.baseline.default : ""));
      setLane((current) => current || result.workflows[0]?.label || "");
    }).catch(() => {
      if (alive) setOptionsError("未能读取任务配置，请刷新后重试");
    }).finally(() => {
      if (alive) setOptionsLoading(false);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const draft: LaunchDraft = {
        version: LAUNCH_DRAFT_VERSION,
        updatedAt: new Date().toISOString(),
        title,
        requirement,
        requirementDocumentName,
        repos,
        ticket,
        baseline,
        lane,
        repairRounds,
        taskInstructions,
        selectedBusinessModuleIds,
      };
      try {
        localStorage.setItem(storageKey("draft", session.username),
          JSON.stringify(draft));
        setDraftSavedAt(draft.updatedAt);
      } catch {
        // 草稿是体验增强；浏览器禁用存储时不阻止发起任务。
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [title, requirement, requirementDocumentName, repos, ticket,
    baseline, lane, repairRounds, taskInstructions, selectedBusinessModuleIds,
    session.username]);

  useEffect(() => {
    if (!options) return;
    const available = new Set(options.business_modules.map((item) => item.id));
    setSelectedBusinessModuleIds((current) => {
      const removed = current.filter((id) => !available.has(id));
      if (removed.length) {
        setModuleSelectionNotice(
          `草稿中的 ${removed.length} 个业务模块已归档或不可用，已从本次任务移除。`);
      }
      return current.filter((id) => available.has(id)).slice(0, 4);
    });
  }, [options]);

  useEffect(() => {
    if (!engineeringSelectionTouched) {
      setSelectedEngineeringKnowledgeIds(
        matchingEngineeringKnowledge.map((item) => item.id));
      return;
    }
    const available = new Set(matchingEngineeringKnowledge.map((item) => item.id));
    setSelectedEngineeringKnowledgeIds((current) =>
      current.filter((id) => available.has(id)));
  }, [matchingEngineeringKnowledge, engineeringSelectionTouched]);

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

  async function loadMarkdown(file: File | undefined) {
    if (!file) return;
    setDocumentError("");
    if (!file.name.toLowerCase().endsWith(".md")) {
      setDocumentError("仅支持 .md 格式的 Markdown 文档");
      return;
    }
    if (file.size > MAX_MARKDOWN_BYTES) {
      setDocumentError("文档不能超过 512 KiB；请拆成主设计文档与仓内参考资料");
      return;
    }
    try {
      const content = await file.text();
      if (!content.trim()) {
        setDocumentError("这个 Markdown 文件没有可用正文");
        return;
      }
      if (content.includes("\0")) {
        setDocumentError("文件包含二进制内容，请上传 UTF-8 编码的 Markdown 文档");
        return;
      }
      setRequirement(content);
      setRequirementDocumentName(file.name);
    } catch {
      setDocumentError("文件读取失败，请确认文件可访问后重试");
    }
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
          taskInstructions: taskInstructions.trim() || undefined,
          repositorySkillCatalogToken:
            repositorySkillSelection.scanned
              ? repositorySkillSelection.catalogToken : undefined,
          selectedRepositorySkillIds:
            repositorySkillSelection.scanned
              ? repositorySkillSelection.selectedIds : undefined,
          selectedBusinessModuleIds,
          selectedEngineeringKnowledgeIds,
          repositoryProfiles: asRepositoryProfiles(repositoryTechnologies),
          requirementDocumentName: requirementDocumentName || undefined,
        },
      );
      const usedRepos = repos.map((item) => item.trim()).filter(Boolean);
      const recentRepos = [...new Set([
        ...usedRepos,
        ...(savedPreferences?.recentRepos ?? []),
      ])].slice(0, 5);
      try {
        localStorage.setItem(storageKey("preferences", session.username),
          JSON.stringify({
            recentRepos,
            baseline: baseline.trim(),
            lane: lane || options?.workflows[0]?.label,
            repairRounds,
          } satisfies LaunchPreferences));
        localStorage.removeItem(storageKey("draft", session.username));
      } catch {
        // 不影响已经成功创建的任务。
      }
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
            <h2 id="launch-title">发起交付任务</h2>
            <p>任务会自动归入你的工作台，人工节点也会回到待核对列表。</p>
            <ol className="launch-guide" aria-label="创建任务步骤">
              <li><i>1</i><span><strong>说清结果</strong><small>描述完成标准，不必编排 Agent 步骤</small></span></li>
              <li><i>2</i><span><strong>圈定范围</strong><small>填写一个或多个相关代码仓</small></span></li>
              <li><i>3</i><span><strong>确认执行</strong><small>单号、基线和交付方式一次确认</small></span></li>
            </ol>
            <small className="launch-copy-foot">提交后可在“我的工作”持续跟进和控制任务。</small>
          </aside>

          <div className="launch-form-shell">
            <div className="launch-form-intro">
              <div><span>NEW DELIVERY</span>
                <strong>填写任务信息</strong></div>
              <small><i aria-hidden /> 必填项请一次填完整</small>
            </div>
            {(title.trim() || requirement.trim() || repos.some((repo) => repo.trim()))
              && draftSavedAt && <div className="launch-draft-state" role="status">
                <span>草稿已自动保存 · {new Date(draftSavedAt).toLocaleTimeString([], {
                  hour: "2-digit", minute: "2-digit",
                })}</span>
                <button type="button" onClick={() => {
                  setTitle("");
                  setRequirement("");
                  setRequirementDocumentName("");
                  setRepos([""]);
                  setTicket("");
                  setSelectedBusinessModuleIds([]);
                  setError("");
                  try { localStorage.removeItem(storageKey("draft", session.username)); } catch { /* noop */ }
                }}>清空草稿</button>
              </div>}

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
                <div className={`requirement-field${draggingDocument ? " is-dragging" : ""}`}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                    setDraggingDocument(true);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setDraggingDocument(false);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDraggingDocument(false);
                    void loadMarkdown(event.dataTransfer.files[0]);
                  }}>
                  <div className="requirement-field-head">
                    <label htmlFor="launch-requirement">
                      需求文档
                    </label>
                    <label className="markdown-upload-action">
                      <input type="file" accept=".md,text/markdown"
                        onChange={(event) => {
                          void loadMarkdown(event.target.files?.[0]);
                          event.target.value = "";
                        }} />
                      <svg viewBox="0 0 20 20" aria-hidden><path d="M10 13V4m0 0L6.5 7.5M10 4l3.5 3.5M4 12.5v2.25A1.25 1.25 0 0 0 5.25 16h9.5A1.25 1.25 0 0 0 16 14.75V12.5" /></svg>
                      选择 .md 文件
                    </label>
                  </div>
                  <div className="markdown-drop-hint" aria-hidden>
                    <svg viewBox="0 0 24 24"><path d="M7 18.5h10a4 4 0 0 0 .7-7.94A6 6 0 0 0 6.2 9.2 4.5 4.5 0 0 0 7 18.5Z" /><path d="m12 9-3 3m3-3 3 3m-3-3v6" /></svg>
                    <span><strong>拖拽 Markdown 设计文档到这里</strong><small>仅支持 .md · 最大 512 KiB · 上传后仍可继续编辑正文</small></span>
                  </div>
                  <textarea
                    id="launch-requirement"
                    value={requirement}
                    onChange={(event) => {
                      setRequirement(event.target.value);
                      setDocumentError("");
                      if (!event.target.value) setRequirementDocumentName("");
                    }}
                    placeholder="粘贴完整需求说明、背景、范围和验收标准；支持 Markdown"
                    rows={10}
                    required
                  />
                  {requirementDocumentName && <div className="markdown-file-state">
                    <span aria-hidden>MD</span>
                    <strong title={requirementDocumentName}>{requirementDocumentName}</strong>
                    <small>{new Blob([requirement]).size > INLINE_MARKDOWN_BYTES
                      ? "长文档 · 原文完整保留，Agent 按章节分段读取"
                      : "已载入 · 正文会完整交给 Agent"}</small>
                    <button type="button" onClick={() => {
                      setRequirement(""); setRequirementDocumentName("");
                      setDocumentError("");
                    }}>移除</button>
                  </div>}
                  {documentError && <div className="markdown-upload-error" role="alert">{documentError}</div>}
                  <small>{requirement
                    ? `${requirement.split(/\r?\n/).length} 行 · ${requirement.length} 字符，原文将完整保留`
                    : "这里是 Agent 实际接收的完整原文，不会被截成标题"}</small>
                </div>
              </section>

              {options && deliveryLocationVisible && (
                <section className="launch-form-section">
                  <div className="launch-section-head"><i>02</i><div><strong>交付定位</strong><small>Agent 据此进入正确仓库、单号和基线</small></div><em>必填</em></div>
                  {options.repo.enabled && (
                    <div className="repo-field">
                    <div className="repo-field-title">
                        <span>涉及代码仓
                          {options.repo.required ? "（至少一个）" : ""}</span>
                        <small>单仓与多仓使用同一条需求交付流程</small>
                      </div>
                      <div className="repo-list">
                        {repos.map((value, index) => (
                          <div className="repo-row" key={index}>
                            <span>{String(index + 1).padStart(2, "0")}</span>
                            <input type="text" value={value}
                              onChange={(event) => changeRepository(index, event.target.value)}
                              placeholder="https://codehub…/team/project.git"
                              list="launch-recent-repositories"
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
                      <datalist id="launch-recent-repositories">
                        {(savedPreferences?.recentRepos ?? []).map((repo) => (
                          <option key={repo} value={repo} />
                        ))}
                      </datalist>
                      <RepositoryTechnologyPicker repositories={repos}
                        value={repositoryTechnologies}
                        onChange={setRepositoryTechnologies} />
                    </div>
                  )}
                  {(options.ticket.enabled || options.baseline.enabled) && (
                    <div className="launch-field-grid launch-required-delivery-grid">
                      {options.ticket.enabled && (
                        <label className="account-field">
                          <span>需求单号
                            {options.ticket.required ? "（必填）" : ""}</span>
                          <input type="text" value={ticket}
                            onChange={(event) => setTicket(event.target.value)}
                            placeholder="REQ2026xxxx"
                            spellCheck={false}
                            required={options.ticket.required} />
                        </label>
                      )}
                      {options.baseline.enabled && (
                        <label className="account-field">
                          <span>基线分支（必填）</span>
                          <input type="text" value={baseline}
                            onChange={(event) => changeBaseline(event.target.value)}
                            placeholder={options.baseline.default} spellCheck={false}
                            required />
                        </label>
                      )}
                    </div>
                  )}
                </section>
              )}
              {options && <section className="launch-form-section launch-execution-settings">
                <div className="launch-section-head"><i>{executionSectionNumber}</i><div><strong>执行设置</strong><small>交付方式需要确认；修复轮预算可按需覆盖团队默认</small></div>
                  {options.workflows.length > 0 && <em>交付方式必填</em>}
                </div>
                <div className="launch-field-grid launch-settings-grid">
                  {options.workflows.length > 0 && (
                    <fieldset className="delivery-mode-field">
                      <legend><strong>交付方式</strong>
                        <small>选最像你现在这件事的情况</small></legend>
                      <div className="delivery-mode-options">
                        {options.workflows.map((item) => (
                          <label key={item.key}
                            className={`delivery-mode-option${(lane
                              || options.workflows[0].label) === item.label
                              ? " selected" : ""}`}>
                            <input type="radio" name="delivery-workflow"
                              value={item.label}
                              checked={(lane || options.workflows[0].label)
                                === item.label}
                              onChange={() => setLane(item.label)} required />
                            <span className="delivery-mode-radio" aria-hidden />
                            <span><strong>{item.label}</strong>
                              {item.description
                                && <small>{item.description}</small>}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  )}
                  <label className="account-field repair-field">
                    <span>修复轮预算（可选）</span>
                    <input type="number" inputMode="numeric" min={0} step={1}
                      value={repairRounds}
                      onChange={(event) => setRepairRounds(event.target.value)}
                      placeholder={options.repair_rounds !== undefined
                        ? `沿用团队默认 ${options.repair_rounds}（0=关闭）`
                        : "沿用团队默认：不限轮（0=关闭）"} />
                    <small>留空沿用团队设置；只有需要限制或关闭自动修复时才填写。</small>
                  </label>
                  <label className="account-field task-instructions-field">
                    <span>本任务执行补充（可选）</span>
                    <textarea value={taskInstructions} maxLength={2000}
                      onChange={(event) => setTaskInstructions(event.target.value)}
                      placeholder="例如：先核对兼容旧数据的风险；接口命名尽量沿用现有模块；不确定时明确说明，不要猜。" />
                    <small>
                      只写关注点、先后偏好或协作要求，不必重复需求。它会随任务固定并进入每个阶段，但不能关闭质量验证、人工决定或交付权限。
                    </small>
                    <em>{taskInstructions.length}/2000</em>
                  </label>
                </div>
              </section>}
              {options && businessModules.length > 0 && (
                <section className="launch-form-section business-module-picker">
                  <div className="launch-section-head"><i>{moduleSectionNumber}</i><div>
                    <strong>业务范围</strong>
                    <small>关联本次任务涉及的业务模块，并固定各模块当时的知识版本</small>
                  </div><em>可选 · 最多 4 个</em></div>
                  <div className="business-module-picker-list">
                    {businessModules.map((module) => {
                      const selectedIndex = selectedBusinessModuleIds.indexOf(module.id);
                      const selected = selectedIndex >= 0;
                      const recommended = module.repositories.some((repo) =>
                        repos.some((item) => repositoryIdentity(item)
                          === repositoryIdentity(repo)));
                      const disabled = !selected && selectedBusinessModuleIds.length >= 4;
                      return <label key={module.id}
                        className={`business-module-option${selected ? " selected" : ""}${disabled ? " disabled" : ""}`}>
                        <input type="checkbox" checked={selected} disabled={disabled}
                          onChange={() => setSelectedBusinessModuleIds((current) =>
                            selected
                              ? current.filter((id) => id !== module.id)
                              : [...current, module.id])} />
                        <span className="business-module-check" aria-hidden>{selected ? "✓" : ""}</span>
                        <span className="business-module-option-copy">
                          <span><strong>{module.name}</strong>
                            {selectedIndex === 0 && <em>主模块</em>}
                            {recommended && <em className="recommended">仓库匹配</em>}
                          </span>
                          <small>{module.description}</small>
                          <span className="business-module-meta">
                            Owner {module.owner} · {module.assets} 项知识 · revision {module.revision}
                          </span>
                        </span>
                      </label>;
                    })}
                  </div>
                  {moduleSelectionNotice && <p className="business-module-picker-notice"
                    role="status">{moduleSelectionNotice}</p>}
                  <p className="business-module-picker-note">
                    不选择也能正常发起；第一项作为主业务模块，最多再关联 3 个相关模块。系统只推荐仓库匹配项，不会替你勾选。
                  </p>
                </section>
              )}
              {options && <section className="launch-form-section engineering-knowledge-picker">
                <div className="launch-section-head"><i>知</i><div>
                  <strong>团队工程知识</strong>
                  <small>按仓库、首次确认的技术栈和业务模块上下文匹配</small>
                </div><em>匹配项默认选中</em></div>
                {matchingEngineeringKnowledge.length ? <div
                  className="engineering-knowledge-options">
                  {matchingEngineeringKnowledge.map((item) => {
                    const selected = selectedEngineeringKnowledgeIds.includes(item.id);
                    return <label key={item.id}
                      className={`engineering-knowledge-option${selected ? " selected" : ""}`}>
                      <input type="checkbox" checked={selected} onChange={() => {
                        setEngineeringSelectionTouched(true);
                        setSelectedEngineeringKnowledgeIds((current) => selected
                          ? current.filter((id) => id !== item.id)
                          : [...current, item.id]);
                      }} />
                      <span className="business-module-check" aria-hidden>
                        {selected ? "✓" : ""}</span>
                      <span><span><strong>{item.title}</strong>
                        <em>{{ document: "文档", rule: "规则",
                          example: "示例" }[item.form]}</em></span>
                        <small>{item.summary}</small>
                        <span className="engineering-knowledge-meta">
                          {item.when_to_use}
                          <KnowledgeLanguageTags languages={item.technologies}
                            empty="技术无关" />
                        </span>
                      </span>
                    </label>;
                  })}
                </div> : <div className="engineering-knowledge-empty">
                  <strong>当前没有匹配的团队工程知识</strong>
                  <span>{repositoryTechnologies.some((item) => item.confirmed)
                    ? "仍会正常使用业务模块知识和代码仓 Skill。"
                    : "首次确认仓库技术栈后会出现更准确的匹配；这不影响继续下单。"}</span>
                </div>}
                <p className="business-module-picker-note">
                  默认选中只表示加入本任务知识索引；正文必须按需读取，不把“选中”冒充“已使用”，也不形成流程门禁。
                </p>
              </section>}
              {options?.repo.enabled && (
                <RepositorySkillPicker
                  key={JSON.stringify([repos, baseline])}
                  repositories={repos}
                  baseline={baseline}
                  onSelectionChange={setRepositorySkillSelection}
                />
              )}
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
