import { useEffect, useMemo, useRef, useState } from "react";
import {
  createTask,
  getLaunchKnowledgePreview,
  getLaunchOptions,
  listCollaborationAssignees,
  listWorkflowAssets,
  previewRequirementBundle,
  probeRepositories,
  type AuthUser,
  type CollaborationAssignee,
  type LaunchKnowledgeMatchedScope,
  type LaunchKnowledgePreview,
  type LaunchOptions,
  type RepositoryProbeResult,
  type RequirementBundlePreview,
  type TaskSummary,
  type WorkflowAssetSummary,
} from "./api";
import {
  asRepositoryProfiles,
  RepositoryTechnologyPicker,
  type RepositoryTechnologyDraft,
} from "./RepositoryTechnologyPicker";
import { knowledgeLanguageLabel } from "./KnowledgeLanguages";
import {
  knowledgeAssetPath,
  type KnowledgeAssetFocus,
} from "./knowledgeNavigation";
import {
  SchemeSelector,
  type WorkflowSchemeSelection,
} from "./workflows";
import { Markdown } from "./markdown";

// 问题单入口已迁往「问题处理」页(/issues,见 web/src/issues/):
// 问题流是"先研究后补单"的动态对话,与需求的固定交付流水线分属
// 两个范式,不再共用发起表单。这里只保留需求入口。
const MAX_MARKDOWN_BYTES = 512 * 1024;
const INLINE_MARKDOWN_BYTES = 32 * 1024;
const MAX_REQUIREMENT_BUNDLE_BYTES = 30 * 1024 * 1024;
const LAUNCH_DRAFT_VERSION = 1;
type LaunchDraft = {
  version: 1;
  updatedAt: string;
  title: string;
  requirement: string;
  requirementDocumentName: string;
  repos: string[];
  repositoryTickets?: string[];
  repositoryAssignees?: string[];
  ticket: string;
  baseline: string;
  lane: string;
  repairRounds: string;
  taskInstructions?: string;
  selectedBusinessModuleIds?: string[];
  moduleSelectionTouched?: boolean;
  workflowSelection?: WorkflowSchemeSelection;
  repositoryTechnologies?: RepositoryTechnologyDraft[];
};
type LaunchPreferences = {
  recentRepos: string[];
  baseline?: string;
  lane?: string;
};

type RequirementBundleDraft = {
  name: string;
  contentBase64: string;
  preview: RequirementBundlePreview;
};

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`读取 ${file.name || "文件"} 失败`));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      const comma = value.indexOf(",");
      if (comma < 0) reject(new Error("文件编码失败"));
      else resolve(value.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

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

function restoredRepositoryTechnologies(
  value: unknown,
): RepositoryTechnologyDraft[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const item = candidate as Record<string, unknown>;
    const repository = typeof item.repository === "string"
      ? item.repository.trim() : "";
    if (!repository || !Array.isArray(item.technologies)) return [];
    return [{
      repository,
      technologies: item.technologies.filter((technology): technology is string =>
        typeof technology === "string").slice(0, 50),
      confirmed: item.confirmed === true,
      ...(typeof item.remembered === "boolean"
        ? { remembered: item.remembered } : {}),
    }];
  });
}

function repositoryIdentity(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

const KNOWLEDGE_FORM_LABEL = {
  document: "文档",
  skill: "Skill",
  rule: "规则",
  example: "示例",
} as const;

/** 站内打开只接管普通点击；Cmd/Ctrl/Shift/Alt 点击保留浏览器原生的
 * 新标签页、新窗口等行为，知识链接因此既能直达也能按用户习惯打开。 */
export function isPlainKnowledgeActivation(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}

function LaunchKnowledgeRow({ form, title, summary, whenToUse, scope, version,
  href, onOpen }: {
  form: keyof typeof KNOWLEDGE_FORM_LABEL;
  title: string;
  summary: string;
  whenToUse: string;
  scope: string;
  version?: string;
  href: string;
  onOpen: () => void;
}) {
  return <a className="launch-knowledge-row" href={href}
    aria-label={`查看全文：${title}${version ? `，${version}` : ""}，命中依据：${scope}`}
    title={`到团队资产查看全文：${title}`}
    onClick={(event) => {
      if (!isPlainKnowledgeActivation(event)) return;
      event.preventDefault();
      onOpen();
    }}>
    <span className={`launch-knowledge-form ${form}`}>
      {KNOWLEDGE_FORM_LABEL[form]}</span>
    <span className="launch-knowledge-copy">
      <span className="launch-knowledge-titleline">
        <strong title={title}>{title}</strong>
        {version && <code>{version}</code>}
      </span>
      <small title={summary || whenToUse}>{summary || whenToUse || "暂无说明"}</small>
      {summary && whenToUse && <em title={whenToUse}>适合：{whenToUse}</em>}
    </span>
    <span className="launch-knowledge-scope">
      <small>命中依据</small><strong title={scope}>{scope}</strong>
      <em>查看全文 <span aria-hidden>→</span></em>
    </span>
  </a>;
}

export function LaunchWorkspace({
  session,
  onCreated,
  onClose,
  onOpenWorkflowAssets,
  onOpenKnowledgeAsset,
}: {
  session: AuthUser;
  /** 创建成功的任务摘要交给调用方,当场打开/高亮,下单不再零反馈。 */
  onCreated: (task: TaskSummary) => void | Promise<void>;
  onClose: () => void;
  onOpenWorkflowAssets?: (workflowId?: string) => void;
  onOpenKnowledgeAsset: (target: KnowledgeAssetFocus) => void;
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
  const [requirementBundle, setRequirementBundle] =
    useState<RequirementBundleDraft>();
  const [documentLoading, setDocumentLoading] = useState(false);
  const [draggingDocument, setDraggingDocument] = useState(false);
  const [title, setTitle] = useState(validDraft?.title ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState("");
  // 任务级可填项(2026-08-18 重定口径):交付仓**必填**、交付方式、修复轮
  // 预算。模型不给选——管理员统一配一个,这里只显示"这单用谁跑"。
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const initialRepos = validDraft?.repos?.length
    ? validDraft.repos
    : savedPreferences?.recentRepos?.[0]
      ? [savedPreferences.recentRepos[0]] : [""];
  const [repos, setRepos] = useState(initialRepos);
  const [repositoryTickets, setRepositoryTickets] = useState(() =>
    initialRepos.map((_, index) => validDraft?.repositoryTickets?.[index]
      ?? validDraft?.ticket ?? ""));
  const [repositoryAssignees, setRepositoryAssignees] = useState(() =>
    initialRepos.map((_, index) => validDraft?.repositoryAssignees?.[index]
      ?? session.username));
  const [collaborationAssignees, setCollaborationAssignees] =
    useState<CollaborationAssignee[]>([]);
  const [collaborationAssigneesLoaded, setCollaborationAssigneesLoaded] =
    useState(false);
  const [repositoryProbeResults, setRepositoryProbeResults] =
    useState<RepositoryProbeResult[]>([]);
  const [repositoryProbeKey, setRepositoryProbeKey] = useState("");
  const [repositoryProbeLoading, setRepositoryProbeLoading] = useState(false);
  const [repositoryProbeError, setRepositoryProbeError] = useState("");
  const repositoryProbeRequest = useRef(0);
  // 单号/基线分支:内核配置确认要的两项事实,下单一并收齐——
  // 不让模型开工后再逐项来问(用户 2026-08-19 拍板,基线默认 master)。
  const [ticket, setTicket] = useState(validDraft?.ticket ?? "");
  const [baseline, setBaseline] = useState(
    validDraft?.baseline ?? savedPreferences?.baseline ?? "");
  // 交付方式下单就定(用户拍板:不让 agent 再问一遍);选项与默认值
  // 都来自内核,空串=等 options 到了再取第一项。
  const [lane, setLane] = useState(
    validDraft?.lane ?? savedPreferences?.lane ?? "");
  // 修复轮数是“关闭自动修复”级别的任务手刹，不能像仓库/基线一样
  // 跨任务记忆。旧实现把一次填写的 0 存成长期偏好，下一单即使没有
  // 打开折叠区也会静默提交 repair_rounds=0；跨仓拆单还会把它复制给
  // 每个子任务。只恢复当前未提交草稿，成功下单后下一单重新留空。
  const [repairRounds, setRepairRounds] = useState(
    validDraft?.repairRounds ?? "");
  const [taskInstructions, setTaskInstructions] = useState(
    validDraft?.taskInstructions ?? "");
  // 单仓大需求先分析拆分(docs/delivery-unit-split-design.md):默认不勾,
  // 小需求照旧直干;勾了走多仓同款的 Chain 分析,把一个仓拆成多个交付单元。
  const [requirementAnalysis, setRequirementAnalysis] = useState(false);
  const [selectedBusinessModuleIds, setSelectedBusinessModuleIds] = useState(
    validDraft?.selectedBusinessModuleIds ?? []);
  const [moduleSelectionNotice, setModuleSelectionNotice] = useState("");
  const [draftSavedAt, setDraftSavedAt] = useState(
    validDraft?.updatedAt ?? "");
  const [repositoryTechnologies, setRepositoryTechnologies] =
    useState<RepositoryTechnologyDraft[]>(() =>
      restoredRepositoryTechnologies(validDraft?.repositoryTechnologies));
  const [moduleSelectionTouched, setModuleSelectionTouched] = useState(
    validDraft?.moduleSelectionTouched === true);
  const [workflowAssets, setWorkflowAssets] = useState<WorkflowAssetSummary[]>([]);
  const [workflowAssetsLoaded, setWorkflowAssetsLoaded] = useState(false);
  const [workflowSelection, setWorkflowSelection] = useState<WorkflowSchemeSelection | undefined>(
    validDraft?.workflowSelection);
  const [workflowSelectionNotice, setWorkflowSelectionNotice] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(() => Boolean(
    validDraft?.workflowSelection
    || validDraft?.taskInstructions?.trim()
    || validDraft?.repairRounds?.trim(),
  ));
  const [knowledgePreview, setKnowledgePreview] =
    useState<LaunchKnowledgePreview>();
  const [knowledgePreviewLoading, setKnowledgePreviewLoading] = useState(true);
  const [knowledgePreviewError, setKnowledgePreviewError] = useState("");
  const [knowledgePreviewKey, setKnowledgePreviewKey] = useState("");
  const knowledgePreviewRequest = useRef(0);
  const [knowledgePreviewRefresh, setKnowledgePreviewRefresh] = useState(0);
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
  const businessModuleNames = useMemo(() => new Map(
    businessModules.map((module) => [module.id, module.name])),
  [businessModules]);
  // 固定仓部署不渲染仓库输入,预览/提交也一并按 enabled 裁字段——
  // 隐藏控件不等于字段不存在(MFC-033)。
  const repoFieldsEnabled = options?.repo.enabled !== false;
  // 勾了"先分析拆分":下单不填单号,单号在拆分确认卡上逐单元收
  // (拆完才知道有几个交付,每个交付一个单号)。
  const analysisEligible = repoFieldsEnabled
    && repos.map((item) => item.trim()).filter(Boolean).length === 1;
  const ticketsDeferred = requirementAnalysis && analysisEligible;
  const repositoriesToProbe = useMemo(() => [...new Set(
    repos.map((item) => item.trim()).filter(Boolean),
  )], [repos]);
  const multiRepository = repositoriesToProbe.length > 1;
  const expectedRepositoryProbeKey = JSON.stringify(repositoriesToProbe);
  const repositoryProbeByUrl = useMemo(() => new Map(
    repositoryProbeResults.map((item) => [item.repository, item]),
  ), [repositoryProbeResults]);
  const repositoryProbeSettled = repositoryProbeKey
    === expectedRepositoryProbeKey;
  const repositoryProbeBlocked = repoFieldsEnabled
    && repositoriesToProbe.length > 0
    && (repositoryProbeLoading || !repositoryProbeSettled
      || !!repositoryProbeError
      || repositoryProbeResults.some((item) => !item.reachable));
  const repositoryTicketBlocked = Boolean(options?.ticket.enabled)
    && (repoFieldsEnabled
      ? repos.some((repo, index) => {
          if (!repo.trim()) return false;
          const value = repositoryTickets[index]?.trim() ?? "";
          return (options?.ticket.required && !value) || /\s/.test(value);
        })
      : (options?.ticket.required && !ticket.trim()) || /\s/.test(ticket.trim()));
  const repositoryAssigneeBlocked = repoFieldsEnabled
    && repos.some((repo, index) => {
      if (!repo.trim()) return false;
      const account = repositoryAssignees[index]?.trim() ?? "";
      const known = collaborationAssignees.find((item) =>
        item.username === account);
      return !account || !collaborationAssigneesLoaded || known?.ready !== true;
    });
  const previewInput = useMemo(() => ({
    repos: repoFieldsEnabled
      ? repos.map((item) => item.trim()).filter(Boolean) : [],
    selectedBusinessModuleIds,
    repositoryProfiles: repoFieldsEnabled && repositoryTechnologies.length > 0
        && repositoryTechnologies.every((item) => item.confirmed)
      ? asRepositoryProfiles(repositoryTechnologies) : undefined,
    workflowSelection,
  }), [repoFieldsEnabled, repos, selectedBusinessModuleIds,
    repositoryTechnologies, workflowSelection]);
  const expectedKnowledgePreviewKey = JSON.stringify(previewInput);
  const matchingModuleKnowledge = knowledgePreview?.business_knowledge ?? [];
  const matchingEngineeringKnowledge = knowledgePreview?.engineering_knowledge ?? [];
  const matchingTeamSkills = knowledgePreview?.team_skills ?? [];
  const repositoryName = (value: string) => value.replace(/\/+$/, "")
    .split("/").at(-1)?.replace(/\.git$/i, "") || value;
  const describeMatchedScope = (item: LaunchKnowledgeMatchedScope) => {
    const scopes = item.matched_business_module_ids.map((id) =>
      `模块：${businessModuleNames.get(id) ?? id}`);
    scopes.push(...item.matched_technologies.map((technology) =>
      `语言：${knowledgeLanguageLabel(technology)}`));
    scopes.push(...item.matched_repositories.map((repository) =>
      `仓库：${repositoryName(repository)}`));
    return scopes.join(" · ") || "团队通用";
  };
  const matchedTeamKnowledgeCount = matchingEngineeringKnowledge.length
    + matchingTeamSkills.length;
  const deliveryLocationVisible = !!options
    && (options.repo.enabled || options.ticket.enabled || options.baseline.enabled);
  const selectedModuleKnowledgeCount = matchingModuleKnowledge.length;
  const selectedKnowledgeCount = selectedModuleKnowledgeCount
    + matchedTeamKnowledgeCount;
  const previewBusinessModuleIds = knowledgePreview?.scope.business_module_ids
    ?? selectedBusinessModuleIds;
  const knowledgeNotices = [
    ...(knowledgePreview?.errors ?? []),
    ...(knowledgePreview?.warnings ?? []),
  ];
  // 明确选中的知识无法固定才阻塞。自动目录是可选增强：读不到时把
  // 降级清单和原因摊给人看，仍允许发起；创建现场继续用 digest 对拍，
  // 目录若恢复或变化会要求刷新，绝不会静默换一份名单。
  const blockers = options?.blockers ?? [];
  const previewSettled = knowledgePreviewKey === expectedKnowledgePreviewKey;
  const knowledgeBlocked = knowledgePreviewLoading || !previewSettled
    || !!knowledgePreviewError || !knowledgePreview?.complete;
  const blocked = optionsLoading || documentLoading
    || blockers.length > 0 || !!optionsError
    || knowledgeBlocked || repositoryProbeBlocked || repositoryTicketBlocked
    || repositoryAssigneeBlocked;

  useEffect(() => {
    let alive = true;
    void getLaunchOptions().then((result) => {
      if (!alive) return;
      setOptions(result);
      // 固定仓部署(repo.enabled=false)只是不渲染仓库输入框,但草稿/
      // 最近使用里恢复的旧仓值仍在 state 里,提交时会被暗带上——服务端
      // 虽会拒绝,用户却在一个没有仓库输入框的页面上收到"仓库不对"
      // (MFC-033 实证)。拿到配置就把不该存在的字段清干净。
      if (!result.repo.enabled) {
        setRepos([""]);
        setRepositoryTickets([""]);
        setRepositoryAssignees([session.username]);
        setRepositoryTechnologies([]);
      }
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
    if (multiRepository) return;
    setRepositoryAssignees((current) => current.map((account, index) =>
      repos[index]?.trim() ? session.username : account));
  }, [multiRepository, repos, session.username]);

  useEffect(() => {
    let alive = true;
    void listCollaborationAssignees().then((items) => {
      if (alive) setCollaborationAssignees(items);
    }).catch(() => {
      // 无法核对责任人存在性/个人接入时宁可阻止创建；草稿仍保留。
      if (alive) setCollaborationAssignees([]);
    }).finally(() => {
      if (alive) setCollaborationAssigneesLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!options?.repo.enabled || repositoriesToProbe.length === 0) {
      setRepositoryProbeResults([]);
      setRepositoryProbeKey(expectedRepositoryProbeKey);
      setRepositoryProbeLoading(false);
      setRepositoryProbeError("");
      return;
    }
    const request = ++repositoryProbeRequest.current;
    const key = expectedRepositoryProbeKey;
    const controller = new AbortController();
    setRepositoryProbeLoading(true);
    setRepositoryProbeError("");
    const timer = window.setTimeout(() => {
      void probeRepositories(repositoriesToProbe, controller.signal)
        .then((result) => {
          if (repositoryProbeRequest.current !== request) return;
          setRepositoryProbeResults(result);
          setRepositoryProbeKey(key);
        }).catch((cause) => {
          if (repositoryProbeRequest.current !== request) return;
          if (cause instanceof DOMException && cause.name === "AbortError") return;
          setRepositoryProbeResults([]);
          setRepositoryProbeKey(key);
          setRepositoryProbeError(cause instanceof Error
            ? cause.message : "仓库地址暂时无法检查");
        }).finally(() => {
          if (repositoryProbeRequest.current === request) {
            setRepositoryProbeLoading(false);
          }
        });
    }, 420);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (repositoryProbeRequest.current === request) {
        repositoryProbeRequest.current += 1;
      }
    };
  }, [expectedRepositoryProbeKey, options?.repo.enabled]);

  useEffect(() => {
    if (!options) return;
    const request = ++knowledgePreviewRequest.current;
    const key = expectedKnowledgePreviewKey;
    const controller = new AbortController();
    setKnowledgePreviewLoading(true);
    setKnowledgePreviewError("");
    // 仓库、模块和语言选择都可能连续变化；短防抖只发最后一次权威预览。
    // 序号同时让已经在途但无法 Abort 的旧响应失效。
    const timer = window.setTimeout(() => {
      void getLaunchKnowledgePreview(previewInput, controller.signal).then((result) => {
        if (knowledgePreviewRequest.current !== request) return;
        setKnowledgePreview(result);
        setKnowledgePreviewKey(key);
      }).catch((cause) => {
        if (knowledgePreviewRequest.current !== request) return;
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setKnowledgePreview(undefined);
        setKnowledgePreviewKey(key);
        setKnowledgePreviewError(cause instanceof Error
          ? cause.message : "自动匹配清单暂时无法核对");
      }).finally(() => {
        if (knowledgePreviewRequest.current === request) {
          setKnowledgePreviewLoading(false);
        }
      });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (knowledgePreviewRequest.current === request) {
        knowledgePreviewRequest.current += 1;
      }
    };
  }, [expectedKnowledgePreviewKey, options, knowledgePreviewRefresh]);

  // 工作流资产是可选增强：目录暂时不可用时仍可用 Mae-Flow 标准方案
  // 正常下单，不能把团队资产读失败升级成新门禁。
  useEffect(() => {
    let alive = true;
    void listWorkflowAssets().then((result) => {
      if (!alive) return;
      setWorkflowAssets(result.items);
      setWorkflowAssetsLoaded(true);
      if (result.warnings.length) {
        setWorkflowSelectionNotice(`部分工作流暂不可见：${result.warnings.join("；")}`);
      }
    }).catch(() => {
      if (!alive) return;
      setWorkflowAssetsLoaded(true);
      setWorkflowSelectionNotice("工作流资产目录暂不可用，本次继续采用 Mae-Flow 标准方案。");
    });
    return () => { alive = false; };
  }, []);

  const persistDraft = () => {
    // ZIP 图片不塞进 localStorage。刷新后让用户重新选择材料包，避免只
    // 恢复 Markdown 却把图片静默丢掉。
    if (requirementBundle) {
      try { localStorage.removeItem(storageKey("draft", session.username)); }
      catch { /* 草稿旁路不影响当前材料包 */ }
      return;
    }
    const draft: LaunchDraft = {
      version: LAUNCH_DRAFT_VERSION,
      updatedAt: new Date().toISOString(),
      title,
      requirement,
      requirementDocumentName,
      repos,
      repositoryTickets,
      repositoryAssignees,
      ticket,
      baseline,
      lane,
      repairRounds,
      taskInstructions,
      selectedBusinessModuleIds,
      moduleSelectionTouched,
      workflowSelection,
      repositoryTechnologies: repositoryTechnologies.map((item) => ({
        ...item, technologies: [...item.technologies],
      })),
    };
    try {
      localStorage.setItem(storageKey("draft", session.username),
        JSON.stringify(draft));
      setDraftSavedAt(draft.updatedAt);
    } catch {
      // 草稿是体验增强；浏览器禁用存储时不阻止发起任务。
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(persistDraft, 300);
    return () => window.clearTimeout(timer);
  }, [title, requirement, requirementDocumentName, repos, repositoryTickets,
    repositoryAssignees, ticket,
    baseline, lane, repairRounds, taskInstructions,
    selectedBusinessModuleIds, moduleSelectionTouched,
    workflowSelection, repositoryTechnologies, requirementBundle,
    session.username]);

  useEffect(() => {
    if (!workflowAssetsLoaded || !workflowSelection) return;
    const selected = workflowAssets.find((item) => item.id === workflowSelection.id);
    if (!selected?.selectable_for_tasks) {
      setWorkflowSelection(undefined);
      setWorkflowSelectionNotice(
        "草稿中选择的工作流已归档、未发布或不可见，已明确回退到 Mae-Flow 标准方案。");
    }
  }, [workflowAssets, workflowAssetsLoaded, workflowSelection]);

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

  // 关联仓库能够说明业务范围时直接替用户勾好匹配模块；这是推荐默认值，
  // 用户一旦手动调整就不再追着仓库输入改选择。模块只带出平台管理的
  // 模块知识，绝不扫描或收编 Git 仓库里的文档与 Skill。
  useEffect(() => {
    if (!options || moduleSelectionTouched) return;
    const wantedRepos = new Set(repos.map(repositoryIdentity).filter(Boolean));
    const matched = businessModules.filter((module) =>
      module.repositories.some((repository) =>
        wantedRepos.has(repositoryIdentity(repository))))
      .map((module) => module.id)
      .slice(0, 4);
    setSelectedBusinessModuleIds(matched);
  }, [options, businessModules, repos, moduleSelectionTouched]);

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

  function changeRepository(index: number, value: string) {
    setRepos((current) => current.map(
      (item, itemIndex) => itemIndex === index ? value : item));
  }

  function addRepository() {
    setRepos((current) => [...current, ""]);
    setRepositoryTickets((current) => [...current, ""]);
    setRepositoryAssignees((current) => [...current, session.username]);
  }

  function removeRepository(index: number) {
    setRepos((current) => current.filter(
      (_, itemIndex) => itemIndex !== index));
    setRepositoryTickets((current) => current.filter(
      (_, itemIndex) => itemIndex !== index));
    setRepositoryAssignees((current) => current.filter(
      (_, itemIndex) => itemIndex !== index));
  }

  function changeRepositoryTicket(index: number, value: string) {
    setRepositoryTickets((current) => current.map(
      (item, itemIndex) => itemIndex === index ? value : item));
  }

  function changeRepositoryAssignee(index: number, value: string) {
    setRepositoryAssignees((current) => current.map(
      (item, itemIndex) => itemIndex === index ? value : item));
  }

  function changeBaseline(value: string) {
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
      setRequirementBundle(undefined);
    } catch {
      setDocumentError("文件读取失败，请确认文件可访问后重试");
    }
  }

  async function loadRequirementBundle(file: File): Promise<void> {
    setDocumentError("");
    if (file.size > MAX_REQUIREMENT_BUNDLE_BYTES) {
      setDocumentError("需求材料包不能超过 30 MB");
      return;
    }
    setDocumentLoading(true);
    try {
      const contentBase64 = await fileBase64(file);
      const preview = await previewRequirementBundle(file.name, contentBase64);
      setRequirement(preview.requirement);
      setRequirementDocumentName(preview.document_name);
      setRequirementBundle({ name: file.name, contentBase64, preview });
    } catch (cause) {
      setDocumentError(cause instanceof Error ? cause.message : "材料包解析失败");
    } finally {
      setDocumentLoading(false);
    }
  }

  function loadRequirementFile(file: File | undefined): void {
    if (!file) return;
    if (file.name.toLowerCase().endsWith(".zip")) {
      void loadRequirementBundle(file);
    } else {
      void loadMarkdown(file);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !requirement.trim() || submitting || blocked) return;
    setSubmitting(true);
    setError("");
    try {
      const created = await createTask(
        requirement.trim(),
        session.username,   // 归属人=本人;管理员不发起任务(入口已隐藏)
        {
          title: title.trim(),
          repo: repoFieldsEnabled ? repos[0]?.trim() || undefined : undefined,
          repos: repoFieldsEnabled
            ? repos.map((item) => item.trim()).filter(Boolean) : [],
          repositoryTickets: repoFieldsEnabled && options?.ticket.enabled
              && !ticketsDeferred
            ? Object.fromEntries(repos.flatMap((repo, index) => {
                const normalized = repo.trim();
                return normalized
                  ? [[normalized, repositoryTickets[index]?.trim() ?? ""]] : [];
              })) : undefined,
          repositoryAssignees: repoFieldsEnabled
            ? Object.fromEntries(repos.flatMap((repo, index) => {
                const normalized = repo.trim();
                return normalized
                  ? [[normalized, repositoryAssignees[index]?.trim()
                    || session.username]] : [];
              })) : undefined,
          // select 虽然会视觉显示第一项，但用户没手动切换时 state 仍是
          // 空串；提交必须使用屏幕上真正显示的默认项。
          lane: lane || options?.workflows[0]?.label,
          ticket: ticketsDeferred ? undefined : ((repoFieldsEnabled
            ? repositoryTickets.find((_, index) => repos[index]?.trim())
            : ticket) ?? "").trim() || undefined,
          baseline: baseline.trim() || undefined,
          repairRounds: repairRounds.trim() === ""
            ? undefined : Number(repairRounds),
          // 精确工作流与自由补充不叠加，避免用户选了一个方案，Agent
          // 又同时收到另一套阶段指令。特殊要求写在需求正文即可。
          taskInstructions: workflowSelection
            ? undefined : taskInstructions.trim() || undefined,
          workflowSelection,
          selectedBusinessModuleIds,
          knowledgePreviewDigest: knowledgePreview?.selection_digest,
          // 团队通用知识不由下单人逐项治理。字段始终缺席，服务端按
          // 仓库、技术栈和业务模块在创建现场自动匹配并固定版本。
          repositoryProfiles: repoFieldsEnabled
              && repositoryTechnologies.length > 0
              && repositoryTechnologies.every((item) => item.confirmed)
            ? asRepositoryProfiles(repositoryTechnologies) : undefined,
          // 只在单仓时传:多仓本来就走分析拆分,重复传会误导服务端语义。
          requirementAnalysis: requirementAnalysis && repoFieldsEnabled
              && repos.map((item) => item.trim()).filter(Boolean).length === 1
            ? true : undefined,
          requirementDocumentName: requirementDocumentName || undefined,
          requirementBundle: requirementBundle
            ? {
                name: requirementBundle.name,
                contentBase64: requirementBundle.contentBase64,
              }
            : undefined,
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
          } satisfies LaunchPreferences));
        localStorage.removeItem(storageKey("draft", session.username));
      } catch {
        // 不影响已经成功创建的任务。
      }
      await onCreated(created);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error
        ? reason.message
        : "任务没有发起成功，请检查服务后重试。");
      // 目录可能恰在预览后发生了版本变化。任何创建失败都重新核对一次，
      // 尤其让 selection_digest 冲突恢复成可见的新清单，而不是反复提交旧版。
      setKnowledgePreviewLoading(true);
      setKnowledgePreviewKey("");
      setKnowledgePreviewRefresh((current) => current + 1);
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
      <header className="ws-head launch-head">
        <button type="button" className="launch-close" onClick={onClose}
          disabled={submitting} aria-label="取消创建任务">
          <svg viewBox="0 0 20 20" aria-hidden><path d="m6 6 8 8M14 6l-8 8" /></svg>
          <span>取消</span>
        </button>
        <div className="ws-identity">
          <div className="ws-identity-line"><code>NEW DELIVERY</code></div>
          <strong id="launch-workspace-title">创建交付任务</strong>
        </div>
        <span className="launch-head-note"><i aria-hidden />草稿自动保存</span>
      </header>

      <main className="launch-workspace-body">
        <section className="launch-panel" aria-labelledby="launch-title">
          <div className="launch-form-shell">
            <div className="launch-form-intro">
              <div><span>CREATE WORK</span>
                <strong id="launch-title">说清任务，确认交付位置</strong>
                <p>必填信息都在当前页面；工作流与知识清单仅在需要时调整。</p>
              </div>
              <small><i aria-hidden /> 必填项始终可见</small>
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
                  setRepositoryTickets([""]);
                  setRepositoryAssignees([session.username]);
                  setTicket("");
                  setSelectedBusinessModuleIds([]);
                  setModuleSelectionTouched(false);
                  setRepositoryTechnologies([]);
                  // 清空必须清干净:执行补充/交付方式/基线/修复轮/工作流
                  // 选择原来被留着,上一单的指示会悄悄跟进下一单,而且
                  // 下一拍自动保存又把它们写回草稿(2026-08-30 审计)。
                  setTaskInstructions("");
                  setWorkflowSelection(undefined);
                  setLane("");
                  setBaseline("");
                  setRepairRounds("");
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
                <div className="launch-section-head"><i>1</i><div><strong>任务与需求</strong><small>说清目标、范围和完成标准即可</small></div><em>必填</em></div>
                <label className="account-field launch-title-field">
                  <span>任务名称</span>
                  <input type="text" value={title} maxLength={80}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="例如：修复通知模板变量缺失"
                    autoFocus required />
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
                    loadRequirementFile(event.dataTransfer.files[0]);
                  }}>
                  <div className="requirement-field-head">
                    {requirementBundle
                      ? <span className="requirement-field-label">需求文档</span>
                      : <label htmlFor="launch-requirement">需求文档</label>}
                    <label className="markdown-upload-action">
                      <input type="file" accept=".md,.zip,text/markdown,application/zip"
                        onChange={(event) => {
                          loadRequirementFile(event.target.files?.[0]);
                          event.target.value = "";
                        }} />
                      <svg viewBox="0 0 20 20" aria-hidden><path d="M10 13V4m0 0L6.5 7.5M10 4l3.5 3.5M4 12.5v2.25A1.25 1.25 0 0 0 5.25 16h9.5A1.25 1.25 0 0 0 16 14.75V12.5" /></svg>
                      选择 .md / .zip
                    </label>
                  </div>
                  {!requirementBundle && <textarea
                    id="launch-requirement"
                    value={requirement}
                    onChange={(event) => {
                      setRequirement(event.target.value);
                      setDocumentError("");
                      if (!event.target.value) setRequirementDocumentName("");
                    }}
                    placeholder="粘贴完整需求说明、背景、范围和验收标准；支持 Markdown"
                    rows={12}
                    required
                  />}
                  {requirementDocumentName && <div className="markdown-file-state">
                    <span aria-hidden>{requirementBundle ? "ZIP" : "MD"}</span>
                    <strong title={requirementBundle?.name ?? requirementDocumentName}>
                      {requirementBundle?.name ?? requirementDocumentName}
                    </strong>
                    <small>{requirementBundle
                      ? `${requirementBundle.preview.assets.length} 张图片 · 已通过材料包校验`
                      : new Blob([requirement]).size > INLINE_MARKDOWN_BYTES
                      ? "长文档 · 原文完整保留，Agent 按章节分段读取"
                      : "已载入 · 正文会完整交给 Agent"}</small>
                    <button type="button" onClick={() => {
                      setRequirement(""); setRequirementDocumentName("");
                      setRequirementBundle(undefined);
                      setDocumentError("");
                    }}>移除</button>
                  </div>}
                  {requirementBundle && <div className="requirement-bundle-preview">
                    <div><strong>材料包预览</strong><small>图片能正常显示后再发起任务</small></div>
                    <Markdown text={requirementBundle.preview.requirement}
                      resolveImage={(path) => {
                        const asset = requirementBundle.preview.assets.find(
                          (item) => item.path === path);
                        return asset
                          ? `data:${asset.mime_type};base64,${asset.content_base64}`
                          : undefined;
                      }} />
                  </div>}
                  {documentError && <div className="markdown-upload-error" role="alert">{documentError}</div>}
                  <small>{documentLoading
                    ? "正在校验并生成预览…"
                    : requirementBundle
                      ? `当前采用 ${requirementBundle.preview.document_name}；需要修改请重新打包上传`
                    : requirement
                    ? `${requirement.split(/\r?\n/).length} 行 · ${requirement.length} 字符，原文将完整保留`
                    : "可直接粘贴或导入 .md；图文需求可导入 ZIP 材料包"}</small>
                </div>
              </section>

              {options && deliveryLocationVisible && (
                <section className="launch-form-section launch-delivery-section">
                  <div className="launch-section-head"><i>2</i><div><strong>交付定位</strong><small>让 Agent 进入正确仓库和基线</small></div><em>必填</em></div>
                  {options.repo.enabled && (
                    <div className="repo-field">
                      <div className="repo-field-title">
                        <span>代码仓与对应 AR 单号{options.repo.required ? "（至少一个）" : ""}</span>
                        <small>一个仓一行，单号和责任人随该仓进入后续交付</small>
                      </div>
                      <div className="repo-list">
                        {repos.map((value, index) => (
                          <div className={`repo-row with-assignee ${
                            options.ticket.enabled && !ticketsDeferred
                              ? "with-ticket" : ""}`} key={index}>
                            <span>{String(index + 1).padStart(2, "0")}</span>
                            <input type="text" value={value}
                              onChange={(event) => changeRepository(index, event.target.value)}
                              placeholder="https://codehub…/team/project.git"
                              aria-label={`第 ${index + 1} 个代码仓地址`}
                              list="launch-recent-repositories"
                              spellCheck={false}
                              aria-invalid={Boolean(value.trim()
                                && repositoryProbeSettled
                                && repositoryProbeByUrl.get(value.trim())
                                  ?.reachable === false)}
                              required={options.repo.required} />
                            {options.ticket.enabled && !ticketsDeferred
                              && <input type="text"
                              value={repositoryTickets[index] ?? ""}
                              onChange={(event) => changeRepositoryTicket(
                                index, event.target.value)}
                              placeholder="该仓对应的 AR 单号"
                              aria-label={`第 ${index + 1} 个仓库的 AR 单号`}
                              aria-invalid={Boolean((repositoryTickets[index] ?? "").trim()
                                && /\s/.test((repositoryTickets[index] ?? "").trim()))}
                              spellCheck={false}
                              required={options.ticket.required && Boolean(value.trim())} />}
                            <select value={repositoryAssignees[index] ?? session.username}
                              aria-label={`第 ${index + 1} 个仓库的责任人`}
                              disabled={!multiRepository}
                              onChange={(event) => changeRepositoryAssignee(
                                index, event.target.value)}>
                              {collaborationAssignees.length === 0
                                ? <option value={session.username}>{session.username}（自己）</option>
                                : collaborationAssignees.map((person) => (
                                  <option key={person.username} value={person.username}
                                    disabled={!person.ready}>
                                    {person.username === session.username
                                      ? `${person.username}（自己）` : person.username}
                                    {person.ready ? "" : ` · 未就绪`}
                                  </option>
                                ))}
                            </select>
                            {repos.length > 1 && <button type="button"
                              aria-label={`移除第 ${index + 1} 个仓库`}
                              onClick={() => removeRepository(index)}>×</button>}
                            {value.trim() && <small className={`repo-probe-state ${
                              repositoryProbeLoading || !repositoryProbeSettled
                                ? "checking"
                                : repositoryProbeByUrl.get(value.trim())?.reachable
                                  ? "success" : "error"}`}
                              role={repositoryProbeSettled
                                && repositoryProbeByUrl.get(value.trim())?.reachable === false
                                ? "alert" : "status"}>
                              {repositoryProbeLoading || !repositoryProbeSettled
                                ? "正在检查仓库地址…"
                                : repositoryProbeByUrl.get(value.trim())?.message
                                  ?? repositoryProbeError
                                  ?? "仓库地址暂时无法检查"}
                            </small>}
                          </div>
                        ))}
                      </div>
                      <button type="button" className="repo-add"
                        onClick={addRepository}>
                        <span>＋</span> 添加代码仓
                      </button>
                      <small className="repo-field-note">
                        请填写每个仓自己的 AR 对应 REQ 单号，不要填 FuR；两者格式相同，系统无法自动识别。
                      </small>
                      {analysisEligible && (
                        <label className={`repo-analysis-toggle ${
                          requirementAnalysis ? "selected" : ""}`}>
                          <input type="checkbox" checked={requirementAnalysis}
                            aria-label="大需求先分析再拆分"
                            onChange={(event) =>
                              setRequirementAnalysis(event.target.checked)} />
                          <span className="repo-analysis-copy">
                            <span className="repo-analysis-title">
                              <em>大需求</em>
                              <strong>先分析，再拆分</strong>
                            </span>
                            <small>先确认改动面与拆分方案，再逐单元创建任务；
                              AR 单号在拆分确认时填写。</small>
                          </span>
                          <span className="repo-analysis-switch" aria-hidden="true" />
                        </label>
                      )}
                      <datalist id="launch-recent-repositories">
                        {(savedPreferences?.recentRepos ?? []).map((repo) => (
                          <option key={repo} value={repo} />
                        ))}
                      </datalist>
                    </div>
                  )}
                  {((options.ticket.enabled && !options.repo.enabled)
                    || options.baseline.enabled) && (
                    <div className="launch-field-grid launch-required-delivery-grid">
                      {options.ticket.enabled && !options.repo.enabled && (
                        <label className="account-field">
                          <span>AR 对应的 REQ 单号
                            {options.ticket.required ? "（必填）" : ""}</span>
                          <input type="text" value={ticket}
                            onChange={(event) => setTicket(event.target.value)}
                            placeholder="例如：REQ2026xxxx"
                            spellCheck={false}
                            required={options.ticket.required} />
                          <small className="ticket-ar-hint">
                            请确认这是 AR 对应的 REQ 单号，不要填写 FuR 对应的 REQ 单号；
                            两者格式相同，系统无法自动识别。
                          </small>
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
                  {businessModules.length > 0 && <details
                    className="launch-module-context">
                    <summary>
                      <span><strong>业务模块</strong><small>
                        {selectedBusinessModuleIds.length
                          ? selectedBusinessModuleIds.map((id) =>
                              businessModules.find((item) => item.id === id)?.name)
                            .filter(Boolean).join("、")
                          : "尚未关联；可选择本任务涉及的业务抽屉"}
                      </small></span>
                      <em>{selectedBusinessModuleIds.length
                        ? `${selectedBusinessModuleIds.length} 个已关联` : "选择"}</em>
                      <svg viewBox="0 0 20 20" aria-hidden><path d="m6 8 4 4 4-4" /></svg>
                    </summary>
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
                            onChange={() => {
                              setModuleSelectionTouched(true);
                              setSelectedBusinessModuleIds((current) => selected
                                ? current.filter((id) => id !== module.id)
                                : [...current, module.id]);
                            }} />
                          <span className="business-module-check" aria-hidden>{selected ? "✓" : ""}</span>
                          <span className="business-module-option-copy">
                            <span><strong>{module.name}</strong>
                              {selectedIndex === 0 && <em>主模块</em>}
                              {recommended && <em className="recommended">仓库匹配</em>}
                            </span>
                            <small>{module.description}</small>
                            <span className="business-module-meta">
                              {module.assets} 项模块知识 · {module.owner} 维护
                            </span>
                          </span>
                        </label>;
                      })}
                    </div>
                    {moduleSelectionNotice && <p className="business-module-picker-notice"
                      role="status">{moduleSelectionNotice}</p>}
                    <p className="business-module-picker-note">
                      仓库匹配项会默认勾选；你手动调整后系统不再改动。这里只带出 Mae-Flow 平台管理的业务知识。
                    </p>
                  </details>}
                </section>
              )}
              {options && options.workflows.length > 0 &&
                <section className={`launch-form-section launch-delivery-mode-section${
                  deliveryLocationVisible ? "" : " launch-delivery-mode-only"}`}>
                  <div className="launch-section-head"><i>3</i><div><strong>交付方式</strong>
                    <small>选择最接近本次任务的交付规模</small></div><em>必填</em></div>
                  <fieldset className="delivery-mode-field">
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
                            {item.description && <small>{item.description}</small>}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                </section>}

              {options && <section className={`launch-knowledge-quick${
                knowledgePreview?.degraded ? " degraded" : ""}${
                knowledgePreview && !knowledgePreview.complete ? " blocked" : ""}`}
                aria-label="自动匹配的平台知识清单">
                <header>
                  <div><span>自动匹配</span><strong>平台管理的本任务知识</strong>
                    <small>按业务模块、代码仓、语言和工作流匹配平台知识；无需手工勾选</small></div>
                  <em>{knowledgePreviewLoading || !previewSettled
                    ? "核对中…"
                    : knowledgePreviewError ? "暂不可用"
                      : `${selectedKnowledgeCount} 项`}</em>
                </header>
                <p className="business-module-picker-note launch-knowledge-boundary-note">
                  下单页只展示 Mae-Flow 平台管理的业务知识、工程知识和 Skill；仓库里的 <code>AGENTS.md</code>、仓内文档、项目规则等仍由 Agent 运行时自行读取，但不在下单界面列出或包装成“本任务知识”。
                </p>
                {knowledgePreviewLoading || !previewSettled ? (
                  <div className="launch-knowledge-quick-loading">正在核对知识名称、版本与作用域…</div>
                ) : knowledgePreviewError ? (
                  <div className="launch-knowledge-quick-message error">
                    <strong>知识清单暂时无法核对</strong><span>{knowledgePreviewError}</span>
                  </div>
                ) : <>
                  {knowledgePreview?.degraded && (
                    <div className={`launch-knowledge-quick-message${
                      knowledgePreview.complete ? " warning" : " error"}`}>
                      <strong>{knowledgePreview.complete
                        ? "部分可选知识暂不可用，本次按下面的可用清单继续"
                        : "明确选择的知识暂时无法固定"}</strong>
                      <span>{knowledgeNotices.map((notice) => notice.message)
                        .slice(0, 2).join("；")}</span>
                    </div>
                  )}
                  {selectedKnowledgeCount > 0 ? (
                    <div className="launch-knowledge-quick-list">
                      {matchingModuleKnowledge.map((item) => (
                        <a key={`business/${item.module_id}/${item.id}`}
                          href={knowledgeAssetPath({ kind: "business",
                            moduleId: item.module_id, assetId: item.id,
                            version: item.version, digest: item.digest })}
                          onClick={(event) => {
                            if (!isPlainKnowledgeActivation(event)) return;
                            event.preventDefault(); persistDraft();
                            onOpenKnowledgeAsset({ kind: "business",
                              moduleId: item.module_id, assetId: item.id,
                              version: item.version, digest: item.digest });
                          }}>
                          <b>业务</b><span><strong>{item.title}</strong>
                            <small>{describeMatchedScope(item)}</small></span>
                        </a>
                      ))}
                      {matchingEngineeringKnowledge.map((item) => (
                        <a key={`engineering/${item.id}`}
                          href={knowledgeAssetPath({ kind: "engineering",
                            candidateId: item.id, digest: item.digest })}
                          onClick={(event) => {
                            if (!isPlainKnowledgeActivation(event)) return;
                            event.preventDefault(); persistDraft();
                            onOpenKnowledgeAsset({ kind: "engineering",
                              candidateId: item.id, digest: item.digest });
                          }}>
                          <b>工程</b><span><strong>{item.title}</strong>
                            <small>{describeMatchedScope(item)}</small></span>
                        </a>
                      ))}
                      {matchingTeamSkills.map((item) => (
                        <a key={`skill/${item.path}`}
                          href={knowledgeAssetPath({ kind: "skill",
                            directory: item.path.split("/")[0] || item.path,
                            digest: item.digest,
                            packageDigest: item.package_digest })}
                          onClick={(event) => {
                            if (!isPlainKnowledgeActivation(event)) return;
                            event.preventDefault(); persistDraft();
                            onOpenKnowledgeAsset({ kind: "skill",
                              directory: item.path.split("/")[0] || item.path,
                              digest: item.digest,
                              packageDigest: item.package_digest });
                          }}>
                          <b>平台 Skill</b><span><strong>{item.name}</strong>
                            <small>{describeMatchedScope(item)}</small></span>
                        </a>
                      ))}
                    </div>
                  ) : (
                    <div className="launch-knowledge-quick-empty">
                      当前没有匹配到 Mae-Flow 平台管理的知识；不影响发起。
                    </div>
                  )}
                </>}
              </section>}

              {options && <details className="launch-advanced" open={advancedOpen}
                onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
                <summary>
                  <span className="launch-advanced-icon" aria-hidden>
                    <svg viewBox="0 0 20 20"><path d="M4 5h12M7 10h9M4 15h12M7 3v4M13 8v4M9 13v4" /></svg>
                  </span>
                  <span className="launch-advanced-copy"><strong>按需配置</strong>
                    <small>工作流、技术画像和 Mae-Flow 平台知识清单</small></span>
                  <span className="launch-advanced-summary">
                    <b>{workflowSelection ? "定制工作流" : "标准工作流"}</b>
                    {knowledgePreviewLoading || !previewSettled
                      ? <b>知识核对中</b>
                      : selectedKnowledgeCount > 0
                        ? <b>{selectedKnowledgeCount} 项平台知识</b>
                        : <b>无平台知识</b>}
                    {knowledgePreview?.degraded && <b className="attention">{
                      knowledgePreview.complete ? "知识已降级" : "知识需处理"}</b>}
                    {repairRounds && <b className={repairRounds === "0"
                      ? "attention" : undefined}>{repairRounds === "0"
                        ? "自动修复已关闭" : `${repairRounds} 轮修复`}</b>}
                    {repositoryTechnologies.some((item) => !item.confirmed)
                      && <b className="attention">技术栈待确认</b>}
                  </span>
                  <svg className="launch-advanced-chevron" viewBox="0 0 20 20" aria-hidden>
                    <path d="m6 8 4 4 4-4" /></svg>
                </summary>
                <div className="launch-advanced-body">
                  <section className="launch-form-section launch-execution-settings">
                    <div className="launch-section-head"><i>流</i><div><strong>工作流与执行提醒</strong>
                      <small>只有对阶段编排有明确要求时才调整</small></div></div>
                    <SchemeSelector workflows={workflowAssets} value={workflowSelection}
                      disabled={!workflowAssetsLoaded}
                      onChange={(selection) => {
                        setWorkflowSelection(selection);
                        setWorkflowSelectionNotice("");
                      }}
                      onOpenEditor={(workflowId) => {
                        persistDraft();
                        onOpenWorkflowAssets?.(workflowId);
                      }} />
                    {workflowSelectionNotice && <p className="workflow-selection-notice"
                      role="status">{workflowSelectionNotice}</p>}
                    <div className="launch-field-grid launch-settings-grid">
                      <label className="account-field repair-field">
                        <span>修复轮预算</span>
                        <input type="text" inputMode="numeric" pattern="[0-9]*"
                          value={repairRounds}
                          onChange={(event) => {
                            const value = event.target.value.trim();
                            if (/^\d*$/.test(value)) setRepairRounds(value);
                          }}
                          placeholder={options.repair_rounds !== undefined
                            ? `留空=团队默认 ${options.repair_rounds} 轮；填 0=关闭`
                            : "留空=不限轮（自动修复开启）；填 0=关闭"} />
                        <small className={repairRounds === "0" ? "field-warning" : undefined}>
                          {repairRounds === "0"
                            ? "本任务已关闭自动修复；检视、冲突或流水线失败将等人处理。"
                            : "留空沿用团队设置；只有明确要关闭自动修复时才填 0。"}
                        </small>
                      </label>
                      {!workflowSelection && <label className="account-field task-instructions-field">
                        <span>给标准方案的补充提醒</span>
                        <textarea value={taskInstructions} maxLength={2000}
                          onChange={(event) => setTaskInstructions(event.target.value)}
                          placeholder="例如：不确定时明确说明，不要猜；优先兼容旧数据。" />
                        <small>选择定制工作流后不再叠加，避免两套指令摩擦。</small>
                        <em>{taskInstructions.length}/2000</em>
                      </label>}
                    </div>
                  </section>
                  {options.repo.enabled && <section className="launch-form-section launch-technology-section">
                    <div className="launch-section-head"><i>技</i><div><strong>仓库技术栈</strong>
                      <small>首次确认后系统会记住，用于匹配工程知识</small></div></div>
                    <RepositoryTechnologyPicker repositories={repos}
                      value={repositoryTechnologies}
                      onChange={setRepositoryTechnologies} />
                  </section>}
              {options && <section className="launch-form-section launch-task-resources">
                <div className="launch-section-head"><i>知</i><div>
                  <strong>平台管理的本任务知识</strong>
                  <small>仅展示业务知识、工程知识与平台团队 Skill；逐项可进入团队资产查看全文</small>
                </div><em>{knowledgePreviewLoading || !previewSettled
                  ? "核对中" : knowledgePreview?.complete
                    ? knowledgePreview.degraded ? "部分降级" : "权威预览"
                    : "需要处理"}</em></div>
                <div className="launch-resource-summary">
                  <span><strong>{selectedModuleKnowledgeCount}</strong>
                    <small>模块知识</small></span>
                  <span><strong>{matchedTeamKnowledgeCount}</strong>
                    <small>平台团队资产</small></span>
                  <p>{previewBusinessModuleIds.length
                    ? `来自 ${previewBusinessModuleIds.map((id) =>
                        businessModules.find((item) => item.id === id)?.name)
                      .filter(Boolean).join("、")} 等已关联抽屉${
                        knowledgePreview?.scope.workflow_business_module_ids.length
                          ? "（含工作流带入）" : ""}`
                    : "尚未关联业务模块；仍会使用匹配的工程知识和平台团队 Skill"}</p>
                </div>
                {(knowledgePreviewError || knowledgeNotices.length > 0)
                  && <div className={`launch-knowledge-notices${
                    knowledgePreview?.complete ? " warning" : " error"}`}
                    role={knowledgePreview?.complete ? "status" : "alert"}>
                    <strong>{knowledgePreview?.complete
                      ? knowledgePreview.degraded
                        ? "部分可选知识已降级，本次按当前清单继续"
                        : "自动匹配已应用容量规则"
                      : "明确选择的知识暂时不能固定"}</strong>
                    {knowledgePreviewError && <span>{knowledgePreviewError}</span>}
                    {knowledgeNotices.map((notice, index) => <span
                      key={`${notice.source}/${notice.code}/${index}`}>
                      {notice.message}</span>)}
                  </div>}
                <div className="launch-knowledge-list" aria-label="自动匹配的平台知识清单">
                  <div className="launch-knowledge-list-head">
                    <strong>发起前固定清单</strong>
                    <span>{knowledgePreviewLoading || !previewSettled
                      ? "正在由服务端核对"
                      : selectedKnowledgeCount
                        ? `共 ${selectedKnowledgeCount} 项` : "没有匹配项"}</span>
                  </div>
                  {!knowledgePreviewLoading && previewSettled
                    && matchingModuleKnowledge.length > 0 && <section
                    className="launch-knowledge-group">
                    <header><strong>业务知识</strong>
                      <em>{matchingModuleKnowledge.length} 项</em></header>
                    {matchingModuleKnowledge.map((item) =>
                      <LaunchKnowledgeRow key={`${item.module_id}/${item.id}`}
                        form={item.form} title={item.title}
                        summary={item.summary} whenToUse={item.when_to_use}
                        version={`v${item.version}`}
                        scope={describeMatchedScope(item)}
                        href={knowledgeAssetPath({ kind: "business",
                          moduleId: item.module_id, assetId: item.id,
                          version: item.version, digest: item.digest })}
                        onOpen={() => {
                          persistDraft();
                          onOpenKnowledgeAsset({ kind: "business",
                            moduleId: item.module_id, assetId: item.id,
                            version: item.version, digest: item.digest });
                        }} />)}
                  </section>}
                  {!knowledgePreviewLoading && previewSettled
                    && matchingEngineeringKnowledge.length > 0 && <section
                    className="launch-knowledge-group">
                    <header><strong>工程知识</strong>
                      <em>{matchingEngineeringKnowledge.length} 项</em></header>
                    {matchingEngineeringKnowledge.map((item) =>
                      <LaunchKnowledgeRow key={item.id} form={item.form}
                        title={item.title} summary={item.summary}
                        whenToUse={item.when_to_use}
                        version={`版本 ${item.digest.slice(0, 8)}`}
                        scope={describeMatchedScope(item)}
                        href={knowledgeAssetPath({ kind: "engineering",
                          candidateId: item.id, digest: item.digest })}
                        onOpen={() => {
                          persistDraft();
                          onOpenKnowledgeAsset({ kind: "engineering",
                            candidateId: item.id, digest: item.digest });
                        }} />)}
                  </section>}
                  {!knowledgePreviewLoading && previewSettled
                    && matchingTeamSkills.length > 0 && <section
                    className="launch-knowledge-group">
                    <header><strong>平台团队 Skill</strong>
                      <em>{matchingTeamSkills.length} 项</em></header>
                    {matchingTeamSkills.map((item) =>
                      <LaunchKnowledgeRow key={item.path} form="skill"
                        title={item.name} summary={item.description}
                        whenToUse=""
                        version={`版本 ${item.digest.slice(0, 8)}`}
                        scope={describeMatchedScope(item)}
                        href={knowledgeAssetPath({ kind: "skill",
                          directory: item.path.split("/")[0] || item.path,
                          digest: item.digest,
                          packageDigest: item.package_digest })}
                        onOpen={() => {
                          persistDraft();
                          onOpenKnowledgeAsset({ kind: "skill",
                            directory: item.path.split("/")[0] || item.path,
                            digest: item.digest,
                            packageDigest: item.package_digest });
                        }} />)}
                  </section>}
                  {!knowledgePreviewLoading && previewSettled
                    && !knowledgePreviewError && selectedKnowledgeCount === 0 && <div
                    className="launch-knowledge-empty">
                    没有匹配到 Mae-Flow 平台管理的知识；不影响发起。
                  </div>}
                </div>
                <div className="launch-resource-boundary">
                  <strong>{knowledgePreviewLoading || !previewSettled
                    ? "正在核对最终名单"
                    : selectedKnowledgeCount
                      ? `将固定 ${selectedKnowledgeCount} 项平台知识` : "将固定 0 项平台知识"}</strong>
                  <span>{knowledgePreview?.complete
                    ? knowledgePreview.degraded
                      ? "可选目录的降级原因已明确列出；创建时仍按本清单指纹核对，目录变化会要求刷新。"
                      : "清单与任务创建复用同一套选择器和容量规则；点击任一项可查看当前全文与版本。"
                    : "明确选择的资产无法固定前不会发起，避免定制工作流缺能力却假装生效。"}</span>
                </div>
              </section>}
                </div>
              </details>}
              {error && <div className="composer-error" role="alert">{error}</div>}
              <footer className="launch-submit-bar">
                <div><strong>{blocked
                  ? repositoryAssigneeBlocked
                    ? "逐仓责任人尚未就绪"
                  : repositoryTicketBlocked
                    ? "请补齐逐仓 AR 单号"
                  : repositoryProbeBlocked
                    ? repositoryProbeLoading || !repositoryProbeSettled
                      ? "正在检查代码仓"
                      : "代码仓暂不可用"
                  : knowledgePreviewLoading || !previewSettled
                    ? "正在核对知识清单"
                    : knowledgePreviewError || !knowledgePreview?.complete
                      ? "知识清单尚未核对完整"
                      : "暂时不能发起"
                  : "信息确认后即可启动"}</strong><small>{blocked
                  ? repositoryAssigneeBlocked
                    ? "请为每个代码仓选择已完成个人接入的责任人"
                  : repositoryTicketBlocked
                    ? "每个已填写的代码仓都需要自己的 AR 单号，且单号不能含空格"
                  : repositoryProbeBlocked
                    ? repositoryProbeLoading || !repositoryProbeSettled
                      ? "正在确认地址与当前 Git 身份是否真的可访问"
                      : "请根据仓库地址下方的原因修正后再发起"
                  : knowledgePreviewLoading || !previewSettled
                    ? "服务端正在固定本次任务会使用的全文与版本"
                    : knowledgePreviewError || !knowledgePreview?.complete
                      ? "请查看“本任务知识”中的明确原因后重试"
                      : "请先处理上方配置项"
                  : "任务创建后会自动进入你的工作台"}</small></div>
                <button type="submit" disabled={submitting || blocked}>
                  <span>{submitting
                    ? "正在发起"
                    : optionsLoading
                      ? "读取配置中"
                    : repositoryAssigneeBlocked
                      ? "逐仓责任人未完成"
                    : repositoryTicketBlocked
                      ? "逐仓单号未完成"
                    : repositoryProbeBlocked
                      ? repositoryProbeLoading || !repositoryProbeSettled
                        ? "检查仓库中"
                        : "仓库不可用"
                      : knowledgePreviewLoading || !previewSettled
                        ? "核对知识中"
                        : knowledgePreviewError || !knowledgePreview?.complete
                          ? "知识预览未完成"
                      : blocked
                        ? "配置未完成"
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
