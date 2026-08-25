import { useEffect, useState } from "react";
import {
  createTask,
  getLaunchOptions,
  type AuthUser,
  type IssueEnvironmentInput,
  type LaunchOptions,
} from "./api";
import {
  EMPTY_REPOSITORY_SKILL_SELECTION,
  RepositorySkillPicker,
  type RepositorySkillSelection,
} from "./RepositorySkillPicker";

type EntryKind = "requirement" | "dts";
const MAX_MARKDOWN_BYTES = 512 * 1024;
const INLINE_MARKDOWN_BYTES = 32 * 1024;
const LAUNCH_DRAFT_VERSION = 1;
type LaunchDraft = {
  version: 1;
  updatedAt: string;
  entryKind: EntryKind;
  title: string;
  requirement: string;
  requirementDocumentName: string;
  repos: string[];
  ticket: string;
  baseline: string;
  lane: string;
  repairRounds: string;
  advancedOpen: boolean;
};
type LaunchPreferences = {
  recentRepos: string[];
  entryKind?: EntryKind;
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
type EnvironmentAccountDraft = {
  id: string;
  username: string;
  password: string;
};
type EnvironmentDraft = Omit<IssueEnvironmentInput, "port" | "accounts"> & {
  id: string;
  port: string;
  accounts: EnvironmentAccountDraft[];
};

function environmentAccountDraft(username: string): EnvironmentAccountDraft {
  return { id: crypto.randomUUID(), username, password: "" };
}

function environmentDraft(purpose: "logs" | "deploy"): EnvironmentDraft {
  return {
    id: crypto.randomUUID(),
    name: "",
    purpose,
    host: "",
    port: "22",
    accounts: ["sopuser", "ossuser", "ossadm"].map(environmentAccountDraft),
  };
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
    ? restoredDraft : undefined;
  const [entryKind, setEntryKind] = useState<EntryKind>(
    validDraft?.entryKind ?? savedPreferences?.entryKind ?? "requirement");
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
  const [advancedOpen, setAdvancedOpen] = useState(
    validDraft?.advancedOpen ?? false);
  const [draftSavedAt, setDraftSavedAt] = useState(
    validDraft?.updatedAt ?? "");
  const [issueEnvironments, setIssueEnvironments] =
    useState<EnvironmentDraft[]>([]);
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
    const timer = window.setTimeout(() => {
      const draft: LaunchDraft = {
        version: LAUNCH_DRAFT_VERSION,
        updatedAt: new Date().toISOString(),
        entryKind,
        title,
        requirement,
        requirementDocumentName,
        repos,
        ticket,
        baseline,
        lane,
        repairRounds,
        advancedOpen,
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
  }, [entryKind, title, requirement, requirementDocumentName, repos, ticket,
    baseline, lane, repairRounds, advancedOpen, session.username]);

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

  function changeEntryKind(kind: EntryKind) {
    setEntryKind(kind);
    setError("");
    if (kind === "dts") {
      setRepos((current) => [current[0] ?? ""]);
    }
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

  function updateEnvironment(
    id: string,
    patch: Partial<EnvironmentDraft>,
  ) {
    setIssueEnvironments((current) => current.map(
      (item) => item.id === id ? { ...item, ...patch } : item));
  }

  function updateEnvironmentAccount(
    environmentId: string,
    accountId: string,
    patch: Partial<EnvironmentAccountDraft>,
  ) {
    setIssueEnvironments((current) => current.map((environment) =>
      environment.id !== environmentId ? environment : {
        ...environment,
        accounts: environment.accounts.map((account) =>
          account.id === accountId ? { ...account, ...patch } : account),
      }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !requirement.trim() || submitting || blocked
        || repositorySkillSelection.scanning) return;
    setSubmitting(true);
    setError("");
    try {
      if (entryKind === "dts" && !ticket.trim()) {
        throw new Error("请填写 DTS 问题单号");
      }
      if (entryKind === "dts" && repos.filter((item) => item.trim()).length !== 1) {
        throw new Error("DTS 最小流程需要明确填写一个代码仓");
      }
      const issueLane = options?.workflows.find((item) => item.key === "hotfix")?.label;
      await createTask(
        requirement.trim(),
        session.username,   // 归属人=本人;管理员不发起任务(入口已隐藏)
        {
          title: title.trim(),
          repo: repos[0]?.trim() || undefined,
          repos: repos.map((item) => item.trim()).filter(Boolean),
          entryKind,
          issueEnvironments: entryKind === "dts"
            ? issueEnvironments.map((item) => ({
                name: item.name,
                purpose: item.purpose,
                host: item.host,
                accounts: item.accounts.map((account) => ({
                  username: account.username,
                  password: account.password,
                })),
                port: Number(item.port || 22),
              }))
            : undefined,
          // select 虽然会视觉显示第一项，但用户没手动切换时 state 仍是
          // 空串；提交必须使用屏幕上真正显示的默认项。
          lane: entryKind === "dts"
            ? issueLane : lane || options?.workflows[0]?.label,
          ticket: ticket.trim() || undefined,
          baseline: baseline.trim() || undefined,
          repairRounds: repairRounds.trim() === ""
            ? undefined : Number(repairRounds),
          repositorySkillCatalogToken:
            repositorySkillSelection.scanned
              ? repositorySkillSelection.catalogToken : undefined,
          selectedRepositorySkillIds:
            repositorySkillSelection.scanned
              ? repositorySkillSelection.selectedIds : undefined,
          selectedRepositoryKnowledgeIds:
            repositorySkillSelection.scanned
              ? repositorySkillSelection.selectedKnowledgeIds : undefined,
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
            entryKind,
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
            <h2 id="launch-title">选择任务入口</h2>
            <p>{entryKind === "dts"
              ? "先把问题诊断清楚，再由 Mae-Flow 接管正式代码交付。"
              : "任务会自动归入你的工作台，人工节点也会回到待核对列表。"}</p>
            <div className="launch-entry-switch" role="tablist" aria-label="任务入口">
              <button type="button" role="tab"
                aria-selected={entryKind === "requirement"}
                className={entryKind === "requirement" ? "active" : ""}
                onClick={() => changeEntryKind("requirement")}>
                <i>01</i><span><strong>需求入口</strong><small>功能建设、重构与一般修改</small></span>
              </button>
              <button type="button" role="tab"
                aria-selected={entryKind === "dts"}
                className={entryKind === "dts" ? "active issue" : "issue"}
                onClick={() => changeEntryKind("dts")}>
                <i>02</i><span><strong>DTS 问题单入口</strong><small>日志诊断、根因确认与修复交付</small></span>
              </button>
            </div>
            <ol className="launch-guide" aria-label="创建任务步骤">
              {entryKind === "dts" ? <>
                <li><i>1</i><span><strong>提供现场</strong><small>问题描述、代码仓与相关环境</small></span></li>
                <li><i>2</i><span><strong>确认根因</strong><small>Agent 结合代码和日志逐题核实</small></span></li>
                <li><i>3</i><span><strong>修复交付</strong><small>确认后进入内核 hotfix 与流水线</small></span></li>
              </> : <>
                <li><i>1</i><span><strong>说清结果</strong><small>描述完成标准，不必编排 Agent 步骤</small></span></li>
                <li><i>2</i><span><strong>圈定范围</strong><small>填写一个或多个相关代码仓</small></span></li>
                <li><i>3</i><span><strong>确认执行</strong><small>负责人和交付方式一次选好</small></span></li>
              </>}
            </ol>
            <small className="launch-copy-foot">提交后可在“我的工作”持续跟进和控制任务。</small>
          </aside>

          <div className="launch-form-shell">
            <div className="launch-form-intro">
              <div><span>{entryKind === "dts" ? "DTS REPAIR" : "NEW DELIVERY"}</span>
                <strong>{entryKind === "dts" ? "填写问题单信息" : "填写任务信息"}</strong></div>
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
                <div className="launch-section-head"><i>01</i><div><strong>{entryKind === "dts" ? "问题单与现象" : "任务与需求"}</strong><small>{entryKind === "dts" ? "原始问题会先进入只读诊断，不会直接修改代码" : "名称用于快速识别，需求文档完整交给 Agent"}</small></div><em>必填</em></div>
                <label className="account-field launch-title-field">
                  <span>{entryKind === "dts" ? "问题标题" : "任务名称"}</span>
                  <input type="text" value={title} maxLength={80}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder={entryKind === "dts"
                      ? "例如：播放器启动后偶发黑屏"
                      : "例如：修复通知模板变量缺失"}
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
                      {entryKind === "dts" ? "问题单描述" : "需求文档"}
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
                    placeholder={entryKind === "dts"
                      ? "粘贴问题现象、复现条件、影响范围和已有排查结论；支持 Markdown"
                      : "粘贴完整需求说明、背景、范围和验收标准；支持 Markdown"}
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

              {options && (options.repo.enabled || options.ticket.enabled || options.baseline.enabled) && (
                <section className="launch-form-section">
                  <div className="launch-section-head"><i>02</i><div><strong>交付定位</strong><small>Agent 据此进入正确仓库和分支</small></div></div>
                  {options.repo.enabled && (
                    <div className="repo-field">
                    <div className="repo-field-title">
                        <span>{entryKind === "dts" ? "问题代码仓" : "涉及代码仓"}
                          {options.repo.required ? "（至少一个）" : ""}</span>
                        <small>{entryKind === "dts"
                          ? "第一版由你明确指定，不让 Agent 猜仓库"
                          : "单仓与多仓使用同一条需求交付流程"}</small>
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
                            {entryKind !== "dts" && repos.length > 1 && <button type="button"
                              aria-label={`移除第 ${index + 1} 个仓库`}
                              onClick={() => removeRepository(index)}>×</button>}
                          </div>
                        ))}
                      </div>
                      {entryKind !== "dts" && <button type="button" className="repo-add"
                        onClick={addRepository}>
                        <span>＋</span> 添加代码仓
                      </button>}
                      <small className="repo-field-note">
                        {entryKind === "dts"
                          ? "问题诊断阶段只读分析该仓；确认根因后，同一任务进入正式修复流程。"
                          : repos.length > 1
                          ? `已选择 ${repos.length} 个仓库；系统会先分析职责、接口与开发依赖，人工确认后再拆分交付。`
                          : "一个仓库就是只有一个交付节点的需求；需要跨仓时继续添加。"}
                      </small>
                      <datalist id="launch-recent-repositories">
                        {(savedPreferences?.recentRepos ?? []).map((repo) => (
                          <option key={repo} value={repo} />
                        ))}
                      </datalist>
                    </div>
                  )}
                  {(advancedOpen || entryKind === "dts") && <div className="launch-field-grid">
                    {options.ticket.enabled && (
                      <label className="account-field">
                        <span>{entryKind === "dts" ? "DTS 问题单号" : "需求/问题单号"}
                          {(entryKind === "dts" || options.ticket.required) ? "（必填）" : ""}</span>
                        <input type="text" value={ticket}
                          onChange={(event) => setTicket(event.target.value)}
                          placeholder={entryKind === "dts"
                            ? "DTS2026xxxx" : "REQ2026xxxx / DTS2026xxxx"}
                          spellCheck={false}
                          required={entryKind === "dts" || options.ticket.required} />
                      </label>
                    )}
                    {advancedOpen && options.baseline.enabled && (
                      <label className="account-field">
                        <span>基线分支</span>
                        <input type="text" value={baseline}
                          onChange={(event) => changeBaseline(event.target.value)}
                          placeholder={`默认 ${options.baseline.default}`} spellCheck={false} />
                      </label>
                    )}
                  </div>}
                </section>
              )}
              <button type="button" className="launch-advanced-toggle"
                aria-expanded={advancedOpen}
                onClick={() => setAdvancedOpen((open) => !open)}>
                <span><strong>高级设置</strong><small>基线、仓内知识与 Skill、交付方式、修复预算及 DTS 环境</small></span>
                <i aria-hidden>{advancedOpen ? "收起" : "展开"}</i>
              </button>
              {advancedOpen && <>
              {entryKind === "dts" && (
                <section className="launch-form-section issue-environments-section">
                  <div className="launch-section-head"><i>03</i><div>
                    <strong>环境信息</strong>
                    <small>最多一个日志环境、一个换库环境；每个环境包含三套固定账号</small>
                  </div><em>可选</em></div>
                  {issueEnvironments.length === 0 ? (
                    <div className="issue-environment-empty">
                      <strong>暂未添加环境</strong>
                      <p>不影响问题单发起；未接环境适配器时，Agent 会根据描述和代码先完成诊断。</p>
                    </div>
                  ) : (
                    <div className="issue-environment-list">
                      {issueEnvironments.map((environment, index) => (
                        <article className="issue-environment-card" key={environment.id}>
                          <header><span>{environment.purpose === "logs"
                            ? "日志环境" : "换库环境"}</span>
                            <button type="button" aria-label={`移除环境 ${index + 1}`}
                              onClick={() => setIssueEnvironments((current) =>
                                current.filter((item) => item.id !== environment.id))}>移除</button>
                          </header>
                          <div className="issue-environment-grid">
                            <label className="account-field"><span>环境名称</span>
                              <input value={environment.name} required
                                placeholder={environment.purpose === "logs"
                                  ? "例如：问题日志环境" : "例如：验证换库环境"}
                                onChange={(event) => updateEnvironment(environment.id,
                                  { name: event.target.value })} /></label>
                            <label className="account-field"><span>用途</span>
                              <input value={environment.purpose === "logs"
                                ? "拉取日志" : "换库验证"} disabled /></label>
                            <label className="account-field issue-env-host"><span>主机地址</span>
                              <input value={environment.host} required spellCheck={false}
                                placeholder="hostname 或 IP"
                                onChange={(event) => updateEnvironment(environment.id,
                                  { host: event.target.value })} /></label>
                            <label className="account-field"><span>SSH 端口</span>
                              <input value={environment.port} required inputMode="numeric"
                                placeholder="22"
                                onChange={(event) => updateEnvironment(environment.id,
                                  { port: event.target.value })} /></label>
                            <div className="issue-environment-accounts">
                              <span>环境账号</span>
                              <small>三套密码分别加密保存，Agent 只能看到用户名</small>
                              {environment.accounts.map((account) => (
                                <div className="issue-environment-account" key={account.id}>
                                  <div className="issue-environment-account-name">
                                    <span>登录用户</span><code>{account.username}</code>
                                  </div>
                                  <label className="account-field"><span>密码</span>
                                    <input type="password" value={account.password} required
                                      autoComplete="new-password"
                                      placeholder={`${account.username || "该账号"} 密码`}
                                      onChange={(event) => updateEnvironmentAccount(
                                        environment.id, account.id,
                                        { password: event.target.value })} /></label>
                                </div>
                              ))}
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                  <div className="issue-environment-actions">
                    <button type="button" className="repo-add issue-environment-add"
                      disabled={issueEnvironments.some((item) => item.purpose === "logs")}
                      onClick={() => setIssueEnvironments((current) =>
                        [...current, environmentDraft("logs")])}>
                      <span>＋</span> 添加日志环境
                    </button>
                    <button type="button" className="repo-add issue-environment-add"
                      disabled={issueEnvironments.some((item) => item.purpose === "deploy")}
                      onClick={() => setIssueEnvironments((current) =>
                        [...current, environmentDraft("deploy")])}>
                      <span>＋</span> 添加换库环境
                    </button>
                  </div>
                  <small className="issue-environment-note">两个环境都可选；每个环境固定填写 sopuser、ossuser、ossadm。日志适配器接入后可自动拉取，换库与回滚在对应适配器接入后启用。任务结束后临时密码自动清除。</small>
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
                <div className="launch-section-head"><i>{entryKind === "dts" ? "04" : "03"}</i><div><strong>执行设置</strong><small>{entryKind === "dts" ? "诊断确认后自动进入已定位问题修复" : "选定交付方式和修复预算;任务自动归属你本人"}</small></div></div>
                <div className="launch-field-grid launch-settings-grid">
                  {entryKind === "dts" ? (
                    <div className="issue-flow-summary">
                      <span>执行路径</span>
                      <strong>Cloud 根因诊断 → 人工确认 → Mae-Flow 问题修复</strong>
                      <small>诊断阶段不进入内核、不修改代码；确认后无需重新下单。</small>
                    </div>
                  ) : (options?.workflows.length ?? 0) > 0 && (
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
              </>}

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
