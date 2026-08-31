/**
 * 任务编排(主 spec §5.2 的任务 API + 流程编排两个模块的骨架)。
 *
 * 一个任务 = 一个工作区 + 一个进程内 pi 会话 + 三份现场文件
 * (events.jsonl / transcript.jsonl / waiting.json)。状态由 outcome
 * 驱动,不由 Web 推断(主 spec §5.1:Web 只承担交互与展示)。
 *
 * 并发受限:超出 maxConcurrent 的任务排队(§4 受限并发任务队列)。
 * 决定消费走 HumanGate 的先到生效语义,冲突原样抛给 API 层变 409。
 */

import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import {
  AnnotationPermissionError,
  AnnotationStore,
  TASK_REQUIREMENT_ARTIFACT,
  reanchor,
  renderAnnotations,
  type Annotation,
  type AnchorCheck,
  type AnnotationInput,
  type SentVia,
} from "./annotations.ts";
import {
  blockingAnnotations,
  parseWorkspaceReviewReceipts,
  unansweredAnnotations,
  workspaceReviewReceiptInstructions,
} from "./feedbackPolicy.ts";
import {
  pushReviewCallId,
  pushReviewReceiptCovers,
} from "./pushReviewPolicy.ts";
import {
  DeliveryOutbox,
  parseReviewReplies,
  type DeliveryOutboxItem,
} from "./deliveryOutbox.ts";
import {
  compareDeliveryRevisions,
  deliveryChangeSnapshot,
  frozenTaskBaseline,
  DIFF_NAME,
  readArtifact,
  readArtifactAsync,
  resolveArtifactRoot,
  type DeliveryRevisionComparison,
} from "./artifacts.ts";
import { KernelHost } from "./kernelHost.ts";
import {
  collectTaskDiagnostics,
  writeTaskDiagnostics,
  type DiagnosticsInput,
} from "./taskDiagnostics.ts";
import {
  matchesStepChoice,
  stepChoiceEffects,
  stepReviewSurface,
  workflowChoices,
  workflowLabel,
  type StepChoiceEffect,
} from "./kernelChoices.ts";
import {
  readCurrentExecutionPlanReading,
  readExecutionPlaybookOptions,
  type ExecutionPlan,
  type ExecutionPlaybookOption,
} from "./executionPlan.ts";
import {
  buildTaskSupplements,
  normalizeTaskExecutionInstructions,
  resolveRepositorySupplement,
} from "./executionProfile.ts";
import { compileWorkflow } from "./workflowCompiler.ts";
import { readWorkflowStandardSnapshot } from "./workflowCatalog.ts";
import {
  materializeWorkflowProfile,
  reconcileWorkflowProfileAssets,
  withWorkflowSupplements,
  workflowProfilePrompt,
} from "./workflowProfileRuntime.ts";
import {
  resolveWorkflowAssets,
} from "./workflowAssetResolution.ts";
import type {
  WorkflowExecutionProfileV2,
  WorkflowResolvedAsset,
  WorkflowSourceRef,
  WorkflowStandardSnapshot,
} from "./workflowDefinition.ts";
import {
  probeDeliveryPlatform,
  type DeliveryPlatformCheck,
} from "./deliveryPlatformProbe.ts";
import type { DeploymentRuntimeCheck } from "./deploymentPreflight.ts";

/**
 * 任务快照会把知识与 Skill 包设成只读；直接 rm -r 时，macOS 会因为
 * 只读子目录无法摘除目录项而报 ENOTEMPTY。清理前只在已校验的任务树
 * 内恢复目录权限，遇到软链接只删除链接本身，绝不跟随到任务外。
 */
function removeTaskTree(path: string): void {
  const makeRemovable = (current: string): void => {
    if (!existsSync(current)) return;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) return;
    if (!stat.isDirectory()) {
      chmodSync(current, 0o600);
      return;
    }
    chmodSync(current, 0o700);
    for (const entry of readdirSync(current)) {
      makeRemovable(join(current, entry));
    }
  };
  makeRemovable(path);
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
}
import {
  AGENT_REQUIREMENT_DOCUMENT,
  MAX_REQUIREMENT_DOCUMENT_BYTES,
  STORED_REQUIREMENT_DOCUMENT,
  materializeRequirementDocument,
  requirementContext,
  requirementDocumentMeta,
  storeRequirementDocument,
  type RequirementDocumentMeta,
} from "./requirementDocument.ts";
import { readJson } from "./jsonBody.ts";
import type {
  Notifier,
  NotifyQuestion,
  NotifyRecord,
} from "./notifier.ts";
import { EventLog } from "./semanticEvents.ts";
import {
  buildActivity, readActivityEvents, type ActivityView,
} from "./activity.ts";
import { TranscriptStore } from "./transcriptStore.ts";
import { GateService, type GateContract } from "./gateService.ts";
import {
  HumanGate,
  StateConflictError,
  renderDecision,
  type WaitingRecord,
} from "./humanGate.ts";
import { CloudSession, type Outcome } from "./sessionDriver.ts";
import {
  probeVisionCapability,
  type VisionModelChoice,
  type VisionProbeResult,
} from "./visionCapability.ts";
import {
  TaskContainer,
  TaskContainerExecTimeoutError,
  TaskContainerUnavailableError,
  sweepManagedTaskContainers,
  taskContainerInstance,
  type DockerRunner,
  type TaskContainerLimits,
  type TaskContainerMetadata,
  type TaskContainerOptions,
} from "./containerRuntime.ts";
import {
  prepareContainerHostPaths,
  repairContainerKernelOwnership,
  repairContainerMutationOwnership,
} from "./containerOwnership.ts";
import type { ExternalAction, PgProjection } from "./projection.ts";
import type { RuntimeSettings } from "./settings.ts";
import { ReviewStore, type ReviewRequest } from "./reviews.ts";
import {
  onlyUnfixableToolFailures,
  parsePipelineChecks,
  selectTerminalRun,
  summarizeFailedChecks,
  type PipelineCheck,
  type PipelineDimension,
} from "./pipelineContract.ts";
import {
  assessPipelineRepairEvidence,
  PIPELINE_DIMENSION_TEXT,
  type PipelineArtifactText,
  type PipelineEvidenceAssessment,
} from "./pipelineEvidence.ts";
import {
  inspectKernelCompletion,
  type KernelCompletionAttestation,
} from "./terminalAttestation.ts";
import {
  materializeRepositorySkills,
  type SelectedRepositorySkill,
  validRepositorySkillPath,
} from "./repositorySkillRuntime.ts";
import { listBusinessModules } from "./businessModuleLibrary.ts";
import {
  materializeBusinessModuleKnowledge,
  copyBusinessModuleSnapshots,
  snapshotBusinessModules,
  type MaterializedBusinessModuleKnowledge,
  type SelectedBusinessModule,
} from "./businessModuleRuntime.ts";
import {
  resolveRepositoryProfiles,
  type RepositoryProfile,
} from "./repositoryProfiles.ts";
import {
  copyEngineeringKnowledgeSnapshots,
  materializeEngineeringKnowledge,
  publishedEngineeringKnowledge,
  snapshotEngineeringKnowledge,
  type SelectedEngineeringKnowledge,
} from "./engineeringKnowledgeRuntime.ts";
import {
  effectiveLaunchKnowledgeSelections,
  previewLaunchKnowledge,
  type LaunchKnowledgePreview,
  type LaunchKnowledgePreviewInput,
} from "./launchKnowledgePreview.ts";
import {
  discoverRepositorySkills,
  type RepositorySkillCatalog,
  type RepositorySkillDescriptor,
} from "./repositorySkills.ts";
import {
  KnowledgeTrace,
  knowledgeUsageSnapshot,
  type KnowledgeResourceRef,
  type TaskKnowledgeUsage,
} from "./knowledgeTrace.ts";
import {
  buildHostSkillEffects,
  buildTeamKnowledgeInsights,
  type HostSkillEffect,
  type KnowledgeInsightTask,
  type TeamKnowledgeInsights,
} from "./knowledgeInsights.ts";
import {
  listHostSkillShelf,
  listHostSkillShelfRoot,
  type HostSkillShelf,
  type HostSkillShelfEntry,
} from "./hostSkillShelf.ts";
import { materializeHostSkills } from "./hostSkillRuntime.ts";
import {
  buildDistillPrompt,
  collectSkillEvidence,
  draftWithModel,
  listSkillCandidates,
  parseDraft,
  saveSkillCandidate,
  type SkillCandidateRecord,
} from "./skillDistiller.ts";

/** 货架条目在读侧的完整形态:资产事实+效果账+待裁决候选数。 */
export type DecoratedHostSkillShelf = HostSkillShelf & {
  skills: Array<HostSkillShelfEntry
    & { effect?: HostSkillEffect; candidates: number }>;
};
import {
  buildFixScopeReview,
  createPrePushGateContract,
  parsePrePushAgentReport,
  prePushMission,
  verifyPrePushEvidence,
  type PrePushAgentReport,
  type PrePushRunRequest,
  type PrePushRunResult,
  type PrePushRunner,
} from "./prepushAgent.ts";
import {
  parseWarmupReport,
  warmupMission,
  type WarmupRunRequest,
  type WarmupRunResult,
  type WarmupRunner,
} from "./warmupAgent.ts";
import {
  detectPrePushBuildProfile,
  prePushCommandTimeoutSeconds,
  resolvePrePushExecutionBudget,
} from "./prepushBuildPlaybook.ts";
import {
  hasContainerVolumeDestination,
  inspectPrePushEnvironment,
  prePushEnvironmentCommand,
} from "./prepushEnvironment.ts";
import {
  PRE_PUSH_EXECUTION_SCHEMA,
  attestPrePushExecution,
  beginPrePushAttempt,
  createPrePushVerification,
  failPrePushEnvironment,
  getReusablePushReceipt,
  observePrePushRevision,
  recordPrePushReport,
  retryPrePushVerification,
  restorePrePushVerification,
  sameRevision,
  type PrePushExecutionAttestation,
  type PrePushReport,
  type PrePushRevision,
  type PrePushVerificationState,
} from "./prePushVerification.ts";
import {
  emptyTokenUsageState,
  recordTokenUsage,
  restoreTokenUsageState,
  tokenUsageSnapshot,
  type ModelTokenUsageSample,
  type TaskTokenUsage,
  type TokenUsageState,
} from "./tokenUsage.ts";
import {
  createSafeGitView,
  runSafeWorktreeGitAsync,
  safeGitEnvironment,
} from "./safeGit.ts";
import {
  AGENT_PLATFORM_LOCAL_EXCLUDES,
  AGENT_PLATFORM_PATHSPECS,
  describeAgentPlatformRoots,
  isAgentPlatformPath,
} from "./agentPlatformPaths.ts";
import {
  humanBytes,
  judgeReclaim,
  reclaimWorkspace,
} from "./workspaceReclaim.ts";
import {
  buildCacheKey,
  cacheKeyFromPath,
  inspectBuildCaches,
  reclaimBuildCaches,
  touchBuildCache,
  type BuildCacheReclaimResult,
  type BuildCacheStatus,
} from "./buildCache.ts";
import {
  IssueEnvironmentVault,
  type IssueEnvironmentInput,
  type IssueEnvironmentRef,
} from "./issueEnvironment.ts";
import { projectTaskFocus, type TaskFocus } from "./taskFocus.ts";
import { createMergeRequest } from "./mrClient.ts";
import {
  DEVELOPER_ASSISTANT_SESSION,
  appendDeveloperAssistantMessage,
  developerAssistantConversation,
  developerAssistantGateContract,
  developerAssistantHandoffPrompt,
  developerAssistantMission,
  developerAssistantTools,
  writeDeveloperAssistant,
  interruptDeveloperAssistant,
  readDeveloperAssistant,
  type DeveloperAssistantView,
} from "./developerAssistant.ts";
import {
  beginDeveloperAssistantHandoff,
  captureDeveloperAssistantWorktree,
  finishDeveloperAssistantHandoff,
  inspectDeveloperAssistantAvailability,
  markDeveloperAssistantReturned,
  summarizeDeveloperAssistantChangedPaths,
  type DeveloperAssistantAvailability,
  type DeveloperAssistantHandoff,
} from "./developerAssistantHandoff.ts";

/** 现场保留期默认两周(用户 2026-08-22 拍板)。 */
export const DEFAULT_WORKSPACE_RETENTION_DAYS = 14;
/** 构建缓存比任务现场更值得复用，但也必须有自动止涨边界。 */
export const DEFAULT_BUILD_CACHE_RETENTION_DAYS = 30;
export const DEFAULT_BUILD_CACHE_MAX_GB = 100;

/** 交付失败在页面上的人话。原始异常仍进服务日志/诊断包；任务摘要只
 * 保留用户能据此行动的结论，避免 TypeError 和宿主绝对路径外泄。 */
export function userFacingDeliveryFailure(error: unknown): string {
  const raw = String(error).replace(/^(Error:\s*)+/, "").trim();
  if (/\bfetch failed\b/i.test(raw)) {
    return "交付平台暂时连接不上，请检查平台地址或网络";
  }
  if (/平台返回里没有 MR 链接/i.test(raw)) {
    return "交付平台响应不完整，未返回 MR 链接";
  }
  if (/remote unpack failed:\s*unable to create temporary object directory/i
    .test(raw)) {
    return "宿主推送失败：远端代码仓暂时无法写入，请检查仓库服务或存储权限";
  }
  return raw.replace(
    /failed to push some refs to\s+(['"])[^'"]+\1/gi,
    "未能更新远端分支",
  );
}

/** 这类失败是平台契约接错/损坏，原样重放不会自愈；网络错误、限流和
 * 超时不在这里，仍由既有恢复预算自动续推。 */
export function deterministicDeliveryFailure(cause: string): boolean {
  return cause.startsWith("交付平台响应不完整")
    || cause.startsWith("流水线返回未知状态");
}

export type TaskStatus =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "waiting_for_human"
  | "completed"
  | "verifying"      // MR 已建,权威流水线未过(主 spec §10:不能标完成)
  | "await_merge"    // 流水线通过,等待人工合入;系统不自动合并
  | "canceled"
  | "failed";

/** prepush 领域台账之外的进程活性投影。它只回答当前 serve 是否真的
 * 持有执行权，不写进 task.json，也不能被当作验证结论。 */
export type PrePushRuntimeState =
  | "running"
  | "recovering"
  | "interrupted"
  | "stopped"
  | "idle";

const HARD_DELETE_STATUSES: readonly TaskStatus[] = [
  "completed", "failed", "canceled",
];

export interface TaskDeletionResult {
  id: string;
  deleted: true;
  local_task: boolean;
  projection_task: boolean;
  reviews_removed: number;
  notifications_removed: number;
}

export interface TaskProgress {
  /** 与内核现场看板同源的展示阶段；这里只镜像，不参与流程判定。 */
  phases: string[];
  current_index: number;
  current_phase: string;
  /** 内核步骤稳定 ID，仅供宿主读取 flow.json 契约；step 是给人看的标题，
   * 两者不可混用（标题可本地化，也可能随文案迭代变化）。 */
  step_id?: string;
  step?: string;
  revision?: number;
  /** build 内的非门禁观察事件；不改变阶段、不参与完成判定。 */
  milestone?: {
    task_id: string;
    title: string;
    event: "started" | "completed" | "blocked";
    reason?: string;
  };
}

export interface RequirementRepository {
  id: string;
  name: string;
  url: string;
  responsibility?: string;
  /** 人工委派的逐仓责任人。只保存稳定账号名，个人凭据仍按启动时现取。 */
  assignee?: string;
  task_id?: string;
}

export interface RequirementDependency {
  /** 依赖方。语义是 `from 依赖 to`，因此 from 必须等待 to。 */
  from: string;
  /** 被依赖的前置仓库。 */
  to: string;
  reason?: string;
}

interface RawRequirementDependency {
  /** 新格式：字段本身就说明方向。 */
  dependent?: string;
  prerequisite?: string;
  /** 旧格式：历史约定是 from 先于 to，但早期模型偶尔会按自然语言写反。 */
  from?: string;
  to?: string;
  reason?: string;
}

function dependencyStatement(
  reason: string | undefined,
  dependent: RequirementRepository | undefined,
  prerequisite: RequirementRepository | undefined,
): boolean {
  if (!reason || !dependent || !prerequisite) return false;
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dependentNames = [...new Set([dependent.id, dependent.name])];
  const prerequisiteNames = [...new Set([prerequisite.id, prerequisite.name])];
  return dependentNames.some((left) => prerequisiteNames.some((right) =>
    new RegExp(`${escaped(left)}.{0,32}(?:依赖|等待|晚于|后于).{0,32}${escaped(right)}`, "i")
      .test(reason)));
}

/** Cloud 的质量动作分工是部署事实，不由用户或每单参数选择。 */
const CLOUD_EXECUTION_CONTRACT = {
  schema: "mae-flow-execution/1",
  host: "cloud",
  compile: "pipeline",
  ut_write: "agent",
  ut_run: "pipeline",
  codecheck: "pipeline",
  git_push: "host",
} as const;

/** 找到本次会话真正能装载的宿主 Skill 名。名称必须由 Pi 自己解析：
 * frontmatter name 可以和目录名不同；缺 name 时 Pi 才以目录名兜底，
 * 解析失败/缺 description 时则与运行时一样不算可加载 Skill。
 * CloudSession 也把整个宿主 skills 根交给同一个 loader，因此这里会
 * 同样覆盖递归、ignore、符号链接和根目录 Markdown 的发现语义。 */
function hostSkillNames(dataDir: string): string[] {
  const root = join(dataDir, "skills");
  try {
    return loadSkills({
      cwd: dataDir,
      agentDir: dataDir,
      skillPaths: [root],
      includeDefaults: false,
    }).skills.map((skill) => skill.name);
  } catch {
    // Skill 装载本身是 fail-open；catalog 同样不因宿主目录损坏而失败。
    return [];
  }
}

function taskHostSkillsDir(dataDir: string, summary: TaskSummary): string {
  return summary.host_skills_pinned
    ? join(summary.workspace, "host-skill-snapshot")
    : join(dataDir, "skills");
}

function availableUtGenerationMethod(
  dataDir: string,
  loadedRepositorySkillNames: string[] = [],
): string {
  const unique = [...new Set([
    ...hostSkillNames(dataDir),
    ...loadedRepositorySkillNames,
  ].filter((name) =>
    /(?:^|[-_])(?:java[-_])?(?:auto)?ut(?:$|[-_])/i.test(name)
      || /ut[-_]generator/i.test(name)))];
  const rank = (name: string): number => {
    const normalized = name.toLowerCase();
    if (normalized === "java-autout") return 0;
    if (normalized === "autout") return 1;
    return 2;
  };
  unique.sort((left, right) => rank(left) - rank(right)
    || left.localeCompare(right));
  return unique[0] ?? "仓内既有写法";
}

function validateRepositoryAddress(candidate: string): void {
  if (/\s/.test(candidate)) {
    throw new Error("代码仓地址不能含空白字符");
  }
  if (!candidate || candidate.startsWith("-") || /[\0\r\n]/.test(candidate)) {
    throw new Error("代码仓地址不能含控制字符或以 - 开头");
  }
  if (/^(?:ssh:\/\/|git\+ssh:\/\/|[\w.-]+@[\w.-]+:)/i.test(candidate)) {
    throw new Error(
      `代码仓请填 HTTPS 地址(收到 SSH 形式: ${candidate})。`
      + `宿主推送与 MR 用个人令牌走 HTTPS,SSH 没有可用凭据,`
      + `会在交付推送时 Permission denied`);
  }
  if (/^https?:\/\//i.test(candidate)) {
    const parsed = new URL(candidate);
    if (parsed.username || parsed.password) {
      throw new Error("代码仓 URL 不许携带账号密码——鉴权使用个人 CodeHub Token");
    }
  }
}

/** 所有需求都是一张仓库交付图：单仓只是只有一个节点、没有边。 */
export interface RequirementGraph {
  stage: "analysis" | "confirmed";
  repositories: RequirementRepository[];
  dependencies: RequirementDependency[];
}

export interface CrossRepositoryUpdate {
  id: string;
  parent_task_id: string;
  source_task_id: string;
  source_repository?: string;
  author: string;
  text: string;
  target_task_ids: string[];
  created_at: string;
}

/** push 前检视的阅读导航。它解释“这次为什么又来检视、先看哪里”，
 * 但不新增审批状态：真正授权仍只认 delivery_selection 绑定的完整
 * HEAD + 文件集合。 */
export interface PushReviewPresentation {
  kind: "delivery" | "feedback" | "pipeline" | "conflict" | "rework";
  title: string;
  description: string;
  base_sha: string;
  baseline_sha: string;
  head_sha: string;
  has_focused_changes: boolean;
  file_count: number;
  additions: number;
  deletions: number;
  /** 逐行统计不可得的原因(如提交历史与对比基点不连续)。设置时
   * additions/deletions 是占位 0,界面必须显示这句话而不是 +0/−0
   * ——文件数有值、行数假零的混合结果比没有更误导(MFC-040)。 */
  stats_unavailable_reason?: string;
  commits: Array<{ sha: string; subject: string }>;
  /** 完整工作区变化用来初始化勾选器；committed_paths 才是当前 HEAD
   * 真正会随 push 带走的默认范围。 */
  all_paths: string[];
  committed_paths: string[];
  agent_note?: string;
  verification?: string;
}

export interface TaskSummary {
  id: string;
  /** 扫读标题:需求原文仍完整保留在 requirement。旧任务缺席时由读侧
   * 从需求首行生成,不要求迁移现场文件。 */
  title?: string;
  requirement: string;
  /** 用户上传或因过长而转为按段读取的 Markdown 原文。requirement 仍
   * 完整保留用于界面查看；这个字段决定 Agent 是否直接内联全文。 */
  requirement_document?: RequirementDocumentMeta;
  status: TaskStatus;
  /** 执行队列位次(1 起,读侧投影,不落盘):排队的单必须能回答
   * "排到哪了",否则陈旧 detail 会让它看起来像在推进。 */
  queue_position?: number;
  /** 读侧统一投影：只解释当前事实，不参与流程迁移或门禁。 */
  focus?: TaskFocus;
  waiting?: WaitingRecord & {
    /** 推荐先看的证据面，由内核 approval_subject 或 Cloud 原生分析类型投影。 */
    recommended_view?: "source" | "doc" | "chain" | "diff";
    /** 只读投影：选项会关闭检视，还是进入/留在意见处理步骤。前端据此
     * 提示未闭环意见，不能在 TS 里手写内核步骤分支表。 */
    choice_effects?: Array<{
      key: string;
      answers: string[];
      allows_source_edit: boolean;
      handles_feedback: boolean;
      closes_feedback: boolean;
    }>;
  };
  detail?: string;
  created_at: string;
  /** 任务运营时间:updated_at 是任意任务事实最近变更,last_progress_at
   * 只在状态/阶段推进时变化,领导据此识别“长时间没有有效进展”。 */
  updated_at?: string;
  last_progress_at?: string;
  completed_at?: string;
  /** 模型提供方真实上报的任务级累计与最近一分钟吞吐。主/子/prepush
   * Agent 统一计入；缺席表示网关没有可靠 usage，绝不按字符数估算。 */
  token_usage?: TaskTokenUsage;
  /** 环境预热编译(观测旁路,fail-open):现场就绪后专职会话在编码
   * 容器里编译基线——验环境+焐缓存+沉淀构建入口。收据绑起跑 SHA,
   * 基线红=环境/上游的锅;结果绝不构成交付证据(核销在 prepush+
   * 流水线)。 */
  baseline_build?: {
    status: "running" | "passed" | "failed" | "infrastructure_failure";
    sha: string;
    detail?: string;
    build_command?: string;
    started_at: string;
    finished_at?: string;
  };
  /** 下单事实里的「UT生成方式」镜像。实锤(2026-08-27 内网):这个值
   * 原来只活在工作区 .mae-flow.json,内网按 task.json 排查 UT skill
   * 为什么没被消费,四个人对着空气找。等于"仓内既有写法"= 没指向
   * 任何团队 Skill(货架为空或命名没命中 UT 模式),skill 不被读是
   * 正确行为不是 bug——这句话必须能在界面上看到。 */
  ut_generation_method?: string;
  workspace: string;
  /** 现场被回收的时刻(ISO)。有值 = 克隆等重货已删,台账还在。
   * 它还是一道闸:恢复时**不许再拿内核状态重新裁决这单**——原件已经
   * 不在了,再量一遍只会把收好口的老单翻成"验证中"甚至重新推分支
   * (同一个坑 settledBeforeContract 已经踩过一次)。 */
  workspace_reclaimed_at?: string;
  /** 小鲁班通知账号(任务创建时填写,主 spec §5.1)。 */
  luban_account?: string;
  /** 跨仓主任务的共同开发者。主责任人仍由 luban_account 唯一确定；
   * 协作者可参与分析讨论与送出批注，但不能提交最终决定或控制任务。 */
  collaborators?: string[];
  /** 单任务审批方式。缺席=继承个人设置；manual 可压过全局月光模式，
   * moonlight 仅放行本任务。 */
  approval_mode?: "inherit" | "manual" | "moonlight";
  /** 下单时填的交付代码仓;缺席=部署仓(--repo)。记在任务上:
   * 重启续跑同仓不漂移,MR/流水线请求也带它给平台适配层。 */
  repo_url?: string;
  /** 需求影响的全部仓库。repo_url 保留为单仓交付兼容字段。 */
  repositories?: string[];
  /** 首次人工确认的仓库技术画像在下单时固定，后续修改只影响新任务。 */
  repository_profiles?: RepositoryProfile[];
  /** Git 仓库原生 Skill 的固定快照。字段缺席表示尚未进入代码现场；
   * 首次 clone 后只发现 Git 已跟踪内容并立即固化，平台不提供发布、
   * 编辑或知识入库。空数组表示该 commit 没有可用仓内 Skill。 */
  repository_skills?: SelectedRepositorySkill[];
  /** 本任务从团队知识货架固定的 Skill 形态资产；正文位于任务快照，
   * 页面只展示元数据，Agent 仍通过 Skill 索引按需读取。 */
  team_skills?: HostSkillShelfEntry[];
  /** 用户下单时明确选择的业务模块及不可变知识快照。只把标题、摘要、
   * 适用场景和任务内路径目录交给 Agent，正文必须按需读取；模块后来
   * 更新不会改写运行中或历史任务。 */
  business_modules?: SelectedBusinessModule[];
  /** 下单时匹配/选择并固定的团队工程知识（Skill 由团队 Skill 货架承载）。 */
  engineering_knowledge?: SelectedEngineeringKnowledge[];
  /** 任务详情读侧投影：提供/加载/阅读的宿主事实，不参与任务落盘。 */
  knowledge_usage?: TaskKnowledgeUsage;
  /** 多仓时由 Chain 产物投影；单仓时是一个节点的退化图。 */
  requirement_graph?: RequirementGraph;
  /** 确认 Chain 方案后生成的普通仓库交付任务关系。 */
  parent_task_id?: string;
  blocked_by?: string[];
  /** 分工后的接口/契约变化回流主任务，并复制给直接相关上下游子任务。 */
  cross_repository_updates?: CrossRepositoryUpdate[];
  /** 交付方式(用户拍板:下单就选好,不让 agent 来问)。取值是**内核
   * flow.json 里 workflow_select 的选项原文**(完整开发/已定位问题修复/
   * 局部修改/处理评审意见),不是宿主自造的词——自造过一次,结果是
   * 卡来了永远对不上、用户在流程里被重复问一遍(2026-08-18 内网实测)。
   * 内核仍会举卡(流程规则是内核的,宿主不删它的问题),对得上就自动
   * 交卷(预答,不是代判)。 */
  lane?: string;
  /** 需求/问题单号(REQ/DTS)。下单就给(用户 2026-08-19 拍板),
   * 开场当事实喂给模型——配置确认不再为它开口问。 */
  ticket?: string;
  /** 基线分支,默认 master(同一次拍板)。 */
  baseline?: string;
  /** 下单时选的模型;缺席=跟随服务当前默认(设置层/部署层)。
   * 记在任务上是为了两件事:重启续跑不漂移、页面能说清"谁跑的"。 */
  model_choice?: { provider: string; model: string };
  /** 下单时的修复轮预算;缺席=跟随服务当前默认。0=本单关掉修复环。 */
  repair_rounds?: number;
  /** 代码仓执行约定已完成首次解析并固定进 workflow_profile.supplements;
   * 即使仓内没有配置或配置损坏,也要固定这次结果——恢复/重跑不能从
   * 后来变化的仓库文件偷偷换方案。(v1 execution_profile 三字段已随
   * v1 退役删除,2026-08-29 无存量窗口统一。) */
  repository_supplement_resolved?: boolean;
  /** 专业用户选定/定制的结构化工作流。base 与 final 都在下单时固定，
   * 任务只执行 final_snapshot；恢复、修复和历史查看不追随目录升级。 */
  workflow_profile?: WorkflowExecutionProfileV2;
  /** 标准目录暂不可读等非阻断降级；不能静默假装定制已生效。 */
  workflow_profile_warning?: string;
  /** 活方案对拍告警(详情投影时算):内核 stderr 的 ⚠、执行方案里的
   * profile_invalid 诊断、以及"任务定了格但活方案没吃到定格"的失配。
   * 曾经整条链路静默——界面展示创建时定格副本,Agent 实际跑平台默认,
   * 无人被通知(2026-08-30 审计 P0-1)。有值必须标红呈现。 */
  execution_plan_alerts?: string[];
  /** 新任务在创建时固定团队 Skill；旧任务缺席时才兼容读取实时货架。 */
  host_skills_pinned?: boolean;
  host_skill_snapshot_warnings?: string[];
  /** 最近一张待办的通知投递事实(失败标红的依据,不影响流程)。 */
  notify?: Pick<NotifyRecord, "delivered" | "attempts" | "last_error">;
  /** Git 交付事实(§10):MR 链接/状态、流水线结果、或没交付的原因。
   * sha = 流水线绑定的代码版本,也是重启后续轮的锚。 */
  delivery?: {
    mr_url?: string;
    /** MR 标识(平台返回的 id/iid):门禁与讨论查询要带回去。 */
    mr_id?: number | string;
    /** 交付分支对(门禁查询与冲突修复都要用,重启后不靠重读状态文件)。 */
    source_branch?: string;
    target_branch?: string;
    mr_state?: string;
    pipeline?: string;
    /** 平台按质量维度返回的 Job 结果（可选诊断增强）。契约已声明三项
     * 均由该权威流水线覆盖时，总体 success 可聚合核销；若逐项明确
     * failed / pending，内核仍以更精确事实裁决 RED / INCOMPLETE。 */
    checks?: PipelineCheck[];
    /** Cloud 在 Agent 会话释放后完成的推送收据；内核要求它与流水线
     * SHA、工作区 HEAD 三者一致，避免模型接触个人 Token。 */
    git_push?: {
      sha: string;
      ref: string;
      remote: string;
      url?: string;
    };
    /** Cloud 在每次新 HEAD 推送前运行的独立编译/UT 会话。它不是
     * Mae-Flow 步骤或审批门禁；PASS 收据只负责避免把明显红灯送去慢
     * 流水线，并按 SHA + 工作区指纹支持纯网络重试复用。 */
    prepush?: PrePushVerificationState;
    /** 读侧活性事实，不落盘。prepush.state=preparing 只表示领域阶段，
     * 不能再被页面误当成当前进程确实持有 runner/容器。 */
    prepush_runtime?: {
      state: PrePushRuntimeState;
      message: string;
    };
    /** 当前 push 检视卡的只读说明与比较锚。卡片销毁即清除。 */
    push_review?: PushReviewPresentation;
    /** 最近一次**人真正看过**的 HEAD:push 确认卡被解决(通过或返工)
     * 时钉住,复检轮"这次修改"的基点从这里取。delivery_selection.head
     * 只在通过时才换,返工多轮后会指到更早的卡,不能表达这个语义
     * (MFC-035 实证:复检卡因此只剩"完整交付")。 */
    last_reviewed_head?: string;
    sha?: string;
    skipped?: string;
    /** 内核对流水线证据的裁决戳(如 "PASS@abc123456789"):终态时宿主
     * 把平台事实喂给内核 `pipeline record`,内核绑工作区 HEAD 裁决并
     * 写进 .mae-flow.json 的 quality.pipeline——这里只是那份现场记录
     * 的镜像。"未裁决(...)"= 登记失败留痕，并阻止进入 await_merge。 */
    attested?: string;
    /** 挂起等待的人话(等审批/等投票……):MR 闭环里"没人动它"和
     * "出了问题"必须让人一眼分得开。 */
    waiting_on?: string;
    /** 外部验证自愈预算的到期时刻(ISO)。重启后照旧对表,不重新开表
     * ——否则每重启一次就白送半小时。 */
    verify_deadline?: string;
    /** 自愈已停,等人工介入的原因。设了它:retry 放行、页面亮牌子、
     * 通知发出。这是"验证中"这潭水里唯一诚实的出口——没有它的时候
     * 任务会既不完成也不失败也不重试,人连重跑都点不动(实测)。 */
    stalled?: string;
    /** 红灯维度缺少具体报错时的宿主级取证状态。它不属于内核流程，
     * 不消耗修复 round；平台证据恢复或人工批注回灌后自动清除。 */
    evidence_gap?: {
      sha: string;
      state: "retrying" | "waiting_human" | "partial";
      missing_dimensions: PipelineDimension[];
      available_dimensions: PipelineDimension[];
      reasons: string[];
      attempts: number;
      failure_log?: string;
      retry_deadline?: string;
      notified_at?: string;
      human_evidence?: string;
      human_dimensions?: PipelineDimension[];
    };
    /** 修复环账本(小状态机):MR 全绿合入是最终目标(用户拍板
     * "不该有最大轮数限制,都该尽力修好")。失败先分类再派单
     * (检视>冲突>CI,同时多项只修最高优先级那一路——冲突不解 CI
     * 白跑);round 只数 CI 修复(检视/冲突触发时清零,流程性问题
     * 不许耗掉代码修复的额度);max 缺席=不限轮,数字=可配手刹。
     * 真正的收敛刹车按类分:CI/冲突=同 SHA 不二修(没新提交即停),
     * 检视=同一批讨论 id 修过一轮仍未解决即停;加上提示词里的
     * "原地打转必须换思路或出诊断"。
     * diagnosis=修复会话停下时留给人的话(缺什么、去哪配)。 */
    loop?: {
      round: number;
      max?: number;
      /** repairing 只表示修复 Agent 本身正在运行；会话收口后进入
       * verifying，覆盖新 SHA 的 prepush、push 与权威流水线验证。 */
      state: "repairing" | "verifying" | "green" | "exhausted" | "halted";
      /** 最近一次派的修复类型:回程(settle 后)按它走收尾动作。 */
      kind?: "ci" | "review" | "conflict";
      /** review 的来源决定是否还需要人裁决：MR 讨论只是别人提的意见，
       * workspace 则是任务责任人已经在工作台明确提交的修改要求。 */
      review_source?: "platform" | "workspace";
      /** 本地检视可能并入正在运行的 CI/冲突会话；独立标记让 push 边界
       * 知道这一轮新增业务文件也已由用户的修改要求授权。 */
      workspace_review_pending?: boolean;
      /** 人工意见引发的修改必须回到人手里复检；纯流水线修复不设置。 */
      workspace_review_recheck_required?: boolean;
      /** 本轮需要逐条闭环的批注。空数组表示只有整体补充说明，仍需总检。 */
      workspace_review_annotation_ids?: string[];
      failure?: string;
      last_sha?: string;
      /** 检视修复的刹车锚:上一轮处理的讨论 id 集(排序拼接)。 */
      review_ids?: string;
      /** 已把回复发布到平台的讨论 id 集。与 review_ids 相等 = 这批
       * 意见都答复过了,门禁还红只是检视人没点"已解决"——那是等人,
       * 不是修不动(报告 D3:既有框架刻意不代检视人 resolve)。 */
      replied_ids?: string;
      diagnosis?: string;
    };
  };
  /** 人工在代码检视卡上签下的 push 收据。requested 表示已经作为
   * 返工要求发给 Agent；confirmed 只授权当时精确的 head + paths。
   * 后续任何修复产生新 HEAD，都必须先 Build-Fix、再重新检视；完全
   * 相同 HEAD 的网络重试才复用这张收据。第一次与后续 push 同口径。 */
  delivery_selection?: {
    paths: string[];
    observed_paths: string[];
    excluded_paths: string[];
    status: "requested" | "confirmed";
    waiting_id: string;
    head: string;
    baseline?: string;
    updated_at: string;
  };
  /** push 前人工确认交付范围(任务级显式开关;缺省由个人设置决定)。
   * 开着时宿主在 prepush 收敛后挂云端原生 diff 卡:确认→按白名单
   * 推送;返工→带清单契约的修复会话整理提交后重新确认。这是宿主对
   * 自己动作(push)设的闸,不碰内核流程。 */
  push_confirmation?: boolean;
  /** 从现场看板的 panel-pulse.js/panel.html 读取的进度摘要。 */
  progress?: TaskProgress;
  /** 内核对当前阶段默认做法的只读解释；不参与状态迁移或完成裁决。 */
  execution_plan?: ExecutionPlan;
  /** 人工控制台账。paused_from 是恢复时的扳道锚点：等待决定、流水线
   * 验证和普通执行的恢复方式不同，不能靠前端猜。 */
  control?: {
    last_action: "pause" | "resume" | "cancel";
    actor: string;
    at: string;
    paused_from?: TaskStatus;
  };
}

export interface TaskServiceOptions {
  dataDir: string;
  provider: string;
  model: string;
  /** 每个任务 agent 目录的 models.json 内容(生产=GLM 网关,演练=剧本假模型)。 */
  modelsJson: Record<string, unknown>;
  /** serve 启动时采集的 Linux/容器信号事实；直接构造的测试形态可缺席。 */
  deploymentRuntime?: DeploymentRuntimeCheck;
  /** 问题流专用部署(--issue-only):需求流程整体停用——内核/交付
   * 平台/prepush 不加载,create() 直接拒绝,launchOptions 摆出明面
   * 的 blocker。历史任务台账仍可读(管理/兜底不受影响)。 */
  requirementDisabled?: boolean;
  /** 可选的专用视觉模型角色。模型定义位于同一份 models.json，主 Agent
   * 仅通过 InspectImage Tool 调用它，不切换主会话模型。 */
  vision?: VisionModelChoice;
  maxConcurrent?: number;
  /** 现场保留期(天)。终态任务过期后回收克隆等重货,台账原样留下;
   * 0 = 永不回收。部署值,可被管理页运行时设置压过。默认见 serve.ts。 */
  workspaceRetentionDays?: number;
  /** 仓库级构建缓存连续未使用多少天后回收；0 = 不按时间回收。 */
  buildCacheRetentionDays?: number;
  /** 构建缓存总容量上限(GB)，超出后按最久未用优先回收；0 = 不限。 */
  buildCacheMaxGb?: number;
  contract?: GateContract;
  /** 内核模式(阶段 1 纵向闭环):任务=克隆 repoPath → 内核 bootstrap
   * (sessionstart+userprompt 捕获需求、铺转发壳)→ 深层门禁与证据
   * 全部经 kernelHost 走内核 dispatch。不配则为纯会话模式(演练)。 */
  /** repoPath 仅用于 --repo 钉死单仓的演示/测试形态；正式下单逐单填仓。 */
  host?: {
    kernelRoot: string;
    repoPath?: string;
    python?: string;
    /** serve 部署以 --repo 钉死单仓时置真:逐单 repo 被拒、表单不再
     * 收仓库地址(MFC-024)。直接构造 TaskService 的测试/试跑 harness
     * 不置,repoPath 仍只是缺省克隆源。 */
    repoPinned?: boolean;
  };
  /** Cloud 工作流资产使用的只读目录根；不会开启代码仓、内核执行或交付。
   * 演示形态也可据此创建、发布并真实编译工作流方案。 */
  workflowCatalogRoot?: string;
  /** 小鲁班通知(内网能力,外部用 FakeLubanServer 模拟)。 */
  notifier?: Notifier;
  /** Git 交付(§10):平台 API 地址(外部=FakeGitPlatform)。
   * 配了它,任务收轮后由服务账号建 MR + 触发权威流水线。
   * 真实流水线是异步的:触发后 running,由带预算的轮询收敛
   * (poll* 两个旋钮给测试和内网调参;预算耗尽留痕请人工,不卡死)。 */
  delivery?: {
    platformUrl: string;
    pollIntervalMs?: number;
    pollTimeoutMs?: number;
    /** 红灯详细证据暂不可得时的跨请求重试间隔。不与状态轮询
     * 共用：采集 artifacts 较重，默认每 3 分钟重试一次。 */
    evidenceRetryMs?: number;
    /** 流水线红灯的修复轮预算(默认 2;0 = 关掉修复环,红灯即留痕请人工)。
     * 每轮 = 一次专职修复会话 + 一次新流水线;耗尽如实停在 verifying。 */
    repairRounds?: number;
    /** 发布检视回复时顺手标"已解决"。默认关——内网既有框架的实证
     * (报告 D3):平台文化是"回复归作者,resolve 归检视人",代点
     * 是越权。平台/团队明确允许代点的部署再打开。 */
    resolveDiscussions?: boolean;
    /** 不可自动修复的质量工具名单(toolkit 的 UNFIXABLE_TOOLS 对齐,
     * 如 ["SuperChecker"]):CODECHECK 红灯全部来自这些工具时不派修复
     * 会话,直接如实等人——派了也是白烧一轮(2026-08-28 对比报告)。
     * 判定要有 tool 证据且全体命中才生效,拿不准照常派修。 */
    unfixableTools?: string[];
  };
  /** 环境预热编译专员(观测旁路)。**缺席即不启用**——serve/pilot 在
   * 隔离模式下显式开启;隐式默认开曾把 prepushIntegration 的 linear
   * 剧本搅乱(预热会话偷吃场景),测试形态必须零意外会话。runner 是
   * 测试注入口,生产走编码容器里的独立 Pi 会话。 */
  warmup?: {
    enabled?: boolean;
    runner?: WarmupRunner;
    /** 专员会话墙钟预算,超时如实记 infrastructure_failure(默认 25 分钟)。 */
    attemptTimeoutMs?: number;
  };
  /** 推送前的 Cloud-native 编译/UT Agent。生产 serve 默认启用；测试、
   * pilot 或渐进部署不配时保持旧交付路径。runner 是窄测试/私有执行器
   * 注入口，缺席时使用独立 Pi 会话，明确不挂 Mae-Flow Hooks。 */
  prepush?: {
    enabled?: boolean;
    runner?: PrePushRunner;
    /** 编译属于重资源动作，和普通 Agent 并发分开计数。默认只放行一单，
     * 避免同一台内网宿主被多个 Maven/C++ 进程瞬间打满。 */
    buildSlots?: number;
    /** 单次 prepush Agent 的墙钟预算。命令各自有 timeout 仍不够：模型可
     * 在多个失败命令之间无限换策略。普通仓默认 30 分钟，含 C++ 的仓库
     * 默认 60 分钟；超时明确收口并销毁 attempt 容器。 */
    attemptTimeoutMs?: number;
    /** Maven/CMake/Make 等重型构建的单命令预算。模型给出的更短 timeout
     * 会被提升到这里，避免已知慢仓被随手填的 600 秒截断。普通仓默认
     * 20 分钟，含 C++ 的仓库默认 45 分钟。 */
    buildCommandTimeoutMs?: number;
  };
  /** DTS 日志/换库/回滚的部署适配器。缺席时问题单仍可按手填材料完成
   * 诊断和代码交付，绝不能因为尚未接内部环境系统而卡死。 */
  /** 审批链接的前缀(通知里带的 URL),如 http://host:port。 */
  linkBase?: string;
  /** PostgreSQL 投影(主 spec §11):看板/审计/恢复引导的读侧。
   * 纯旁路——写失败不改流程,不配则一切照旧(文件即真相)。 */
  projection?: PgProjection;
  /** 主动压缩节奏:事件量每涨这么多,在下一个回合间隙以内核锚点
   * 压缩会话(0 = 关)。被动保底(pi 自动压缩)始终开着,这里是
   * "注意力不许飘"的主动档。 */
  compactEveryEvents?: number;
  /** 容器隔离(设计文档):bash 命令进任务专属容器执行,镜像按
   * 试点仓选。容器起不来任务如实 failed,不静默降级回宿主。
   * volumes = 额外挂载,"宿主:容器" 形状;
   * memory/cpus/user = 资源限额与身份映射,不配即不限。 */
  isolation?: {
    image: string;
    volumes?: string[];
    /** 构建缓存宿主根目录。平台按仓库 URL 的哈希自动分区，绝不让
     * Maven/npm/ccache 在无关业务仓之间共享同一份可写缓存。 */
    cacheRoot?: string;
    memory?: string;
    cpus?: string;
    user?: string;
    pidsLimit?: number;
    labels?: Record<string, string>;
    readOnlyRoot?: boolean;
    tmpfsHome?: string | false;
    tmpfsTmp?: string | false;
    network?: string;
    environment?: NodeJS.ProcessEnv;
    forwardEnvironment?: readonly string[];
    stopGraceSeconds?: number;
    managementTimeoutMs?: number;
    /** Docker CLI 注入口，仅供无 daemon 单测和受控运行时适配。 */
    runner?: DockerRunner;
    /** 窄测试/运行时适配注入口。生产不配置时始终使用 TaskContainer；
     * 结构化接口让测试能证明普通会话与 prepush 都没有宿主 Bash 回退。 */
    containerFactory?: TaskContainerFactory;
  };
  /** 提交信息规范(部署级一句话,进每个会话的开场)。
   *
   * **业务提交的格式权威在内核**(`[<单号>][feat|fix]描述`,内核门禁
   * 直接 block),平台 pre-receive 钩子的正则是它的超集,天然兼容
   * ——这个旗子不是用来改写内核规则的,配成别的格式只会让 agent 写出
   * 内核当场拒收的信息(反例见部署手册)。
   *
   * 它存在是为了内核管不到的那部分:合并提交(冲突修复产生、由宿主
   * 直接推送)、revert、或某些仓额外要求的前缀——平台钩子照样会按
   * 正则拒收 push,而那时代码早写完了,重来一遍纯浪费。 */
  commitConvention?: string;
  /** 运行时设置覆盖(管理页):并发/修复轮/轮询/通知/模型网关。
   * 部署配置是底,这层是热改;各消费点即时读,生效边界见 settings.ts。 */
  settings?: RuntimeSettings;
  /** 按任务归属人取个人 Git 凭据(serve 接 LocalAuth.gitCredential)。
   * 有凭据→只在宿主 clone/push 的短生命周期 helper 中使用；Agent
   * 目录与仓库配置永远不落 token/helper。没有→维持部署级访问方式
   * (服务账号/开放内网)。 */
  gitCredential?: (
    account?: string,
  ) => { username: string; password: string; email?: string } | undefined;
  /** 月光模式(免审批)查询口:按任务归属人现读现判(serve 接
   * LocalAuth.moonlightEnabled)。开着时该用户任务的人工节点由
   * 系统代答放行,答复里写明预授权与复盘要求;随时可开可关。 */
  moonlight?: (account?: string) => boolean;
  /** push 前人工确认(交付清单过目)查询口:与 moonlight 同纪律,
   * 按任务归属人现读现判(serve 接 LocalAuth.pushConfirmationEnabled,
   * 真人缺省即开)。任务级显式设置(setPushConfirmation)优先于它。 */
  pushConfirmation?: (account?: string) => boolean;
  /** 跨仓委派的服务端就绪校验。生产接 LocalAuth 的窄视图；测试/纯
   * 会话形态可缺席，保持既有 TaskService 单元测试不依赖账号库。 */
  collaborationAssigneeReadiness?: (
    account: string,
  ) => { ready: boolean; missing: string[] };
  log?: (message: string) => void;
  /** 服务日志环形缓冲的读口(serve 注入)。诊断包用它切最近日志;
   * 缺席时诊断包只是少一节,采集本身照常。 */
  recentLog?: () => string[];
}

export interface TaskCommandContainer {
  /** 真 Docker 后端在 start 后提供；测试/私有执行器可不实现。 */
  readonly metadata?: TaskContainerMetadata;
  start(): Promise<void>;
  exec(
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null }>;
  stop(): Promise<void>;
}

export interface TaskContainerFactoryInput {
  image: string;
  workspace: string;
  name: string;
  log?: (message: string) => void;
  volumes: string[];
  limits: TaskContainerLimits;
  options: TaskContainerOptions;
}

export type TaskContainerFactory = (
  input: TaskContainerFactoryInput,
) => TaskCommandContainer;

/** MR 合并门禁的分类表(照内网既有框架的实证结论,
 * docs/mr-loop-adaptation.md §4)。三项可修按优先级排:数字小=先修,
 * 同时多项失败只派最高优先级那一路——冲突不解 CI 白跑,检视优先于
 * 代码问题。其余六项(审批/投票/WIP/e2e/自定义/评估)只能等人:
 * 系统保持监控、通知归属人,不派 agent 不扣重试。认不出的名字一律
 * 按等人处理并把名字留痕——瞎修比不修危险。 */
const REPAIRABLE_GATES: Record<
  string,
  { kind: "review" | "conflict" | "ci"; priority: number }
> = {
  resolve_discussion_passed: { kind: "review", priority: 10 },
  conflict_passed: { kind: "conflict", priority: 15 },
  ci_state_passed: { kind: "ci", priority: 20 },
  // 代码质量门禁(内网 2026-08-18 首次拿到真实门禁集才发现有这一项)。
  // 它是**改代码能解决的**——CodeCheck/CodeCC 那类扫描结论,正是 CI
  // 修复使命里"按类分诊"已经覆盖的一类。归到等人的话,MR 卡在这里
  // 永远没人动,任务干等到监控预算耗尽(逮住时它正是 false)。
  // 与 ci_state_passed 同一路(同一个修复会话一次修完),排在其后:
  // 流水线红通常连带质量红,先看流水线原文更全。
  codequality_passed: { kind: "ci", priority: 25 },
};

/** 等人门禁的人话。名字缺席不影响判定(认不出=等人),只影响文案:
 * 界面上"等 approval_reviewers_required_passed"没人看得懂,而这些
 * 名字来自内网真实 MR(2026-08-18 selftest 实测的 19 项)。 */
const HUMAN_GATE_TEXT: Record<string, string> = {
  approvers_passed: "等审批",
  vote_passed: "等投票",
  work_in_progress_passed: "等摘除 WIP 标记",
  e2e_check_passed: "等 e2e 检查",
  custom_ctrl_items_passed: "等自定义门禁",
  evaluation_passed: "等评估",
  approval_approvers_required_passed: "等必需审批人审批",
  approval_reviewers_required_passed: "等必需检视人检视",
  committer_must_cast_two_votes_passed: "等提交人以外的两票",
  merge_by_self_passed: "等他人代为合入(不允许自己合自己的单)",
  merged_by_user_passed: "等有权限的人点合入(目标分支受保护)",
  mr_state_passed: "等 MR 回到可合入状态",
  no_commits_passed: "等分支上出现提交",
  branch_missing_passed: "等分支恢复(远端分支不见了)",
  // 非快进:平台要求线性历史。宿主的冲突修复走 merge(会产生合并
  // 提交),对"必须快进"的仓解不了;真解法是变基后强推,而强推是
  // 内核明令禁止的不可逆动作——所以这一项如实挂等人,交给人裁决。
  non_ff_passed: "等处理非快进(需变基,自动修复不做强推)",
};

interface GateItem {
  name: string;
  passed: boolean;
  detail?: string;
}

interface GateView {
  mrState: "opened" | "merged" | "closed";
  gates: GateItem[];
  /** 平台报告的 MR 源分支当前提交。MFC-038:合入监控必须核对它与本
   * 任务验证过的 delivery.sha 一致,否则旧绿灯/旧人审在背书别的代码。
   * 旧平台契约没有该字段时为 undefined——无法核对,保持旧行为并留痕。 */
  sourceSha?: string;
}

/** 失败分类:可修的按优先级排序(全部返回——高优先级不可派时要能
 * 落到下一路,如"检视已回复等确认"时 CI 还得修);等人的翻成人话。 */
function classifyGates(gates: GateItem[]): {
  repairs: Array<{ kind: "review" | "conflict" | "ci"; gate: GateItem;
                   priority: number }>;
  waiting: string[];
} {
  const repairs: Array<{ kind: "review" | "conflict" | "ci";
                         gate: GateItem; priority: number }> = [];
  const waiting: string[] = [];
  for (const gate of gates) {
    if (gate.passed) continue;
    const known = REPAIRABLE_GATES[gate.name];
    if (known) repairs.push({ ...known, gate });
    else waiting.push(HUMAN_GATE_TEXT[gate.name] ?? `等 ${gate.name}`);
  }
  repairs.sort((a, b) => a.priority - b.priority);
  return { repairs, waiting };
}

/** 检视意见(适配层契约形状,宿主只读这些字段)。 */
interface DiscussionItem {
  id: string;
  file?: string;
  line?: number;
  severity?: string;
  author?: string;
  body?: string;
}

/** 小鲁班链接必须落到前端任务工作台，而不是 /tasks/:id 的 JSON API。
 * 身份只认登录会话，URL 只承载任务定位；每个任务因此也有可复制、
 * 可刷新、可从通知直接进入的稳定页面地址。 */
function personalTaskLink(
  linkBase: string | undefined,
  _account: string,
  taskId: string,
): string {
  const root = (linkBase ?? "").replace(/\/+$/, "");
  return `${root}/work/${encodeURIComponent(taskId)}`;
}

function reviewTaskLink(
  linkBase: string | undefined,
  taskId: string,
  reviewId: string,
): string {
  const root = (linkBase ?? "").replace(/\/+$/, "");
  return `${root}/work/${encodeURIComponent(taskId)}`
    + `/review/${encodeURIComponent(reviewId)}`;
}

export type SystemCheckStatus = "ok" | "warning" | "error";
export interface SystemCheckItem {
  key: string;
  label: string;
  status: SystemCheckStatus;
  detail: string;
  suggestion?: string;
}
export interface SystemCheckResult {
  checked_at: string;
  overall: SystemCheckStatus;
  items: SystemCheckItem[];
}

/** 自由需求原文 → 可扫读标题。它只是展示摘要,不改需求输入；按首个非空
 * 行截断,避免把一整段需求塞进团队列表。 */
function taskTitle(requirement: string): string {
  const first = requirement.split(/\r?\n/)
    .map((line) => line.trim()).find(Boolean) ?? "未命名任务";
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

/** 重启前发出、但很可能没送到模型的插话。
 *
 * 插话走 pi 的 steer,消息压在**进程内存**队列里,进程一死就没了;事件
 * 日志是唯一跨进程活下来的账。判据很朴素:最后一次 turn_finished 之后
 * 出现的插话,还没有任何一个回合消化过它。
 *
 * 取舍写在明处:回合跑到一半被杀时,已经送进上下文的那条也会被算成
 * "没送到",于是重建会话里出现两遍。**宁可重复也不能吞掉**——重复顶多
 * 让模型多确认一句,吞掉则是人说过的话凭空消失。
 *
 * 读不动就当没有(旁路一律 fail-open,绝不能挡住任务重建)。
 */
function undeliveredInterrupts(workspace: string): string[] {
  try {
    const events = new EventLog(join(workspace, "events.jsonl")).replay();
    let since = -1;
    events.forEach((event, at) => {
      if (event.kind === "turn_finished") since = at;
    });
    return events.slice(since + 1)
      .filter((event) => event.kind === "user_message"
        && event.payload?.via === "interrupt")
      .map((event) => String(event.payload?.text ?? ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 读取内核定义的 append-only build 观察事件。坏文件只影响这一行进度，
 * 不能拖住任务列表，更不能被 Cloud 当成第二套流程状态。 */
function latestBuildMilestone(text: string): TaskProgress["milestone"] {
  if (!text) return undefined;
  try {
    const rows = JSON.parse(text)?.events;
    if (!Array.isArray(rows)) return undefined;
    const row = [...rows].reverse().find((item) => item
      && typeof item === "object"
      && ["started", "completed", "blocked"].includes(String(item.event))
      && String(item.task_id ?? "").trim()
      && String(item.task_title ?? "").trim());
    if (!row) return undefined;
    return {
      task_id: String(row.task_id),
      title: String(row.task_title),
      event: String(row.event) as "started" | "completed" | "blocked",
      ...(String(row.reason ?? "").trim()
        ? { reason: String(row.reason).trim() } : {}),
    };
  } catch {
    return undefined;
  }
}

interface TaskState {
  summary: TaskSummary;
  /** 持久化在 task.json 的内部台账；不属于流程状态，也不更新推进时间。 */
  tokenUsage: TokenUsageState;
  driver?: CloudSession;
  humanGate: HumanGate;
  /** 任务代码工作区(host 模式=仓库克隆目录),交付模块读内核状态用。 */
  cwd?: string;
  /** 活的通知记录:后台退避重试会原地更新,查询时投影最新事实。 */
  notifyRecord?: NotifyRecord;
  /** 催办账本:上次催办时内核停在哪一步 + 累计次数。
   * 同一步催过没动弹就不再催(催办只对"忘了继续"有效,
   * 对"推不动"无效);累计上限防对话式空转。 */
  nudgedStep?: string;
  nudgeCount?: number;
  /** 任务专属容器(隔离模式):随任务起,随收口停。人工等待期间保持
   * 原实例不动，保证 Agent 的 HOME、/tmp 与执行环境连续。 */
  container?: TaskCommandContainer;
  /** 容器该挂哪个目录。需求理解单挂 repositories/,普通单挂仓根。 */
  containerWorkspace?: string;
  /** 防御性重建的防重入:一个回合里并发的多条 Bash 只开一个容器。 */
  containerReopen?: Promise<TaskCommandContainer>;
  /** 合入监控环的防重入锁(内存态):一任务只挂一环。 */
  mergeWatchActive?: boolean;
  /** 流水线轮询按 SHA 防重入；新 SHA 可以立刻接棒，旧轮醒来后自退。 */
  pipelinePollSha?: string;
  /** 流水线证据核销重试的防重入锁。纯宿主 timer，不占 Agent 会话。 */
  evidenceRetryActive?: boolean;
  /** 红灯具体报错采集的防重入锁；与绿灯核销证据不是同一条链。 */
  repairEvidenceRetryActive?: boolean;
  deliveryRecoveryActive?: boolean;
  /** 检视回复账本投递的单飞锁；恢复、交付与合入 watcher 共用。 */
  reviewOutboxFlush?: Promise<boolean>;
  /** 环境预热的防重入锁(内存态):一任务只跑一个预热专员。 */
  warmupActive?: boolean;
  /** 所有 push 入口共享同一个异步准备动作；避免恢复轮询与会话收口
   * 同时撞进来，为同一 HEAD 启两个编译 Agent。 */
  prepushActive?: Promise<boolean>;
  /** 启动恢复的防重锁。它覆盖 tryDeliver 进入 prepushActive 之前的异步
   * 对账窗口，避免两条恢复旁路同时看到“还没有在跑”而各起一轮。 */
  prepushRecoveryActive?: boolean;
  /** prepush 回合的宿主中断信号。Pi 的 abort 偶尔只回到 idle、没有让
   * 已返回给调用方的 turn Promise 收口；这条信号用于结束宿主等待，
   * 容器销毁仍是进程树终止的安全边界。 */
  prepushAbort?: AbortController;
  /** 上次主动压缩时的事件水位(事件量是上下文增长的诚实代理)。 */
  lastCompactAt?: number;
  /** 已自动采集过诊断包的事故键(内存态)。同一事故只落一份,
   * 重复 persist 不刷屏;文件名里的 hash 负责跨重启去重。 */
  lastDiagnosticsKey?: string;
  /** 恢复标记:launch 走重建会话路径(不重克隆、内核 current 续跑)。 */
  resume?: boolean;
  /** 恢复期收到的人工决定:重建会话就绪后由 driver 补登记再续跑。 */
  pendingResume?: WaitingRecord;
  /** 已由内核接纳且严格写入 task.json 的用户介入 id；只供崩溃重放。 */
  appliedDeveloperInterventionId?: string;
  /** task.json 先隐藏、waiting.json 后作废的那一张旧卡。 */
  obsoleteDeveloperWaiting?: {
    waitingId: string;
    stateVersion: number;
  };
  /** 专项使命(修复环):下次会话的压轴指令,消费即清。
   * 要随 task.json 落盘——修复会话跑一半被重启,使命不能丢。 */
  mission?: string;
  /** 会话收口时的最后发言(内存态):修复会话不提交时它就是诊断,
   * halted 裁决把它带给人。不落盘——窗口极窄,时间线里也有原文。 */
  lastReply?: string;
  /** 避免列表轮询反复解析未变化的现场面板。 */
  progressPulse?: string;
  progressCache?: TaskProgress;
  /** persist 用来识别真正的状态推进,避免普通元数据更新冒充进展。 */
  lastPersistedStatus?: TaskStatus;
  /** 每次取消/即时暂停/恢复都会换代。异步回调只允许修改启动时那一代，
   * 防止“取消后又被旧回调写成完成”。进程重启后旧 Promise 已不存在。 */
  controlEpoch: number;
  /** running 的暂停不截断当前工具，等 settle 的安全边界收口。 */
  pauseRequested?: boolean;
  /** 用户主动召唤的旁路开发助手。它只在主任务 paused 时运行，不参与
   * 内核状态迁移；Promise 只代表当前一轮，ready 时会话和容器继续保留。 */
  assistantActive?: Promise<void>;
  /** 开发助手回合换代号。停止当前动作只终止旁路回合，不改主任务 epoch。 */
  assistantEpoch?: number;
  /** 暂停边界从 Pi 内存队列取回的主任务补充。恢复主会话前一直保留，
   * listInterrupts 也据此如实维持“待读取”。 */
  pendingMainSteers?: string[];
  /** 开发助手交还给重建主会话的一次性现场摘要。它不是内核证据；
   * 必须持久化，避免服务死在 resume→launch 之间把用户改动上下文丢掉。 */
  pendingAssistantHandoff?: string;
  /** 交付失败日志聚合:同一指纹只全文记一次,其后按计数聚合
   * (MFC-020:同文 MR-400 曾刷 86 条)。进程内即可,不持久化。 */
  deliveryFailureLog?: { fingerprint: string; count: number };
}

interface PrePushBuildWaiter {
  task: TaskState;
  epoch: number;
  resolve: (release: (() => void) | undefined) => void;
}

interface PipelineAttestation {
  verdict: string;
  sha?: string;
  reason?: string;
  checks?: Record<string, unknown>;
}

interface UserInterventionReconciliation {
  id: string;
  changed: boolean;
  from: string;
  target: string;
}

interface GitPushReceipt {
  sha: string;
  ref: string;
  remote: string;
  url?: string;
}

interface RepositorySkillCatalogTicket {
  account?: string;
  repositories: string[];
  baseline?: string;
  expiresAt: number;
  catalogs: RepositorySkillCatalog[];
}

export interface RepositorySkillCatalogResponse {
  catalog_token: string;
  repositories: RepositorySkillCatalog[];
}

export interface RepositoryProbeResult {
  repository: string;
  reachable: boolean;
  message: string;
}

export interface RepositoryProbeResponse {
  repositories: RepositoryProbeResult[];
}

/** 所有审批入口共用的决定契约。
 *
 * selected_options 只承载内核选项原文；free_responses 承载开放题答案或
 * 选择题的补充说明，永远不参与流程分支匹配。decision/answers/notes 仅
 * 保留给旧调用方兼容，进入 HumanGate 前仍会执行同样的菜单校验。 */
export interface DecisionSubmission {
  /** 页面看到的待办身份。只靠 state_version=1 无法区分两张先后生成的
   * 卡，也无法在任务概要已推进后识别同一次网络重试。 */
  waiting_id?: string;
  state_version: number;
  selected_options?: Record<string, string>;
  free_responses?: Record<string, string>;
  comment?: string;
  decision?: string;
  answers?: Record<string, string>;
  notes?: string;
  annotation_ids?: string[];
  repository_skill_catalog_token?: string;
  selected_repository_skill_ids?: string[];
  /** Chain 确认与逐仓委派同一次乐观锁提交，键是需求图 repository.id。 */
  repository_assignees?: Record<string, string>;
  /** 代码检视时用户勾选的最终交付文件。字段缺席表示该入口没有修改
   * 清单；空数组有业务含义，不能折叠成 undefined。 */
  delivery_paths?: string[];
  /** 操作人(HTTP 层从登录会话注入,自动交卷不填)。只入审计账,
   * 不参与请求指纹——同内容的网络重试无论谁发都幂等。 */
  actor?: string;
}

/** 脏路径给人看的形态:前几条点名,余量说总数——三万个产物文件不能
 * 整版倒进 detail,但"哪个目录在渗产物"必须一眼可见。 */
function describeDirtyPaths(paths: string[]): string {
  const shown = paths.slice(0, 5).join("、");
  return paths.length > 5 ? `${shown} 等 ${paths.length} 个路径` : shown;
}

function normalizedDeliveryPaths(values: string[]): string[] {
  const paths = values.map((value) => String(value).trim()
    .replace(/\\/g, "/").replace(/^(?:\.\/)+/, "")).filter(Boolean);
  for (const path of paths) {
    if (path.startsWith("/") || path === ".." || path.startsWith("../")
        || path.includes("/../") || /[\0\r\n]/.test(path)) {
      throw new TaskControlError(`交付清单包含不安全路径：${path}`);
    }
  }
  return [...new Set(paths)].sort((left, right) => left.localeCompare(right));
}

function samePaths(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((path, index) => path === right[index]);
}

function orderedRecord(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value) return undefined;
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, String(item)] as const)
    .sort(([left], [right]) => left.localeCompare(right)));
}

/** 浏览器重试/双击的稳定身份。它只判断“是不是完全同一份提交”，
 * 不承担业务校验；业务校验仍由 normalizeDecisionSubmission 完成。 */
function decisionRequestDigest(
  waitingId: string,
  input: DecisionSubmission,
): string {
  const normalized = {
    waiting_id: waitingId,
    state_version: input.state_version,
    selected_options: orderedRecord(input.selected_options),
    free_responses: orderedRecord(input.free_responses),
    comment: input.comment?.trim() || undefined,
    decision: input.decision?.trim() || undefined,
    answers: orderedRecord(input.answers),
    notes: input.notes?.trim() || undefined,
    annotation_ids: input.annotation_ids
      ? [...new Set(input.annotation_ids.map(String))].sort() : undefined,
    repository_skill_catalog_token:
      input.repository_skill_catalog_token || undefined,
    selected_repository_skill_ids: input.selected_repository_skill_ids
      ? [...new Set(input.selected_repository_skill_ids.map(String))].sort()
      : undefined,
    repository_assignees: orderedRecord(input.repository_assignees),
    delivery_paths: input.delivery_paths
      ? [...new Set(input.delivery_paths.map(String))].sort() : undefined,
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** push 前确认卡的云端原生步骤名与选项原文。步骤不在内核流程里,
 * stepReviewSurface 对未知步骤默认给 "diff",勾选 UI 自动开放。 */
const CLOUD_PUSH_CONFIRM_STEP = "cloud_push_confirm";
const PUSH_CONFIRM_ACCEPT = "确认按清单推送";
const PUSH_CONFIRM_REWORK = "需要调整代码（按清单返工）";

function deliverySelectionNote(
  paths: string[],
  excluded: string[],
): string {
  const limit = 300;
  const selected = paths.slice(0, limit).map((path) => `- ${path}`);
  if (paths.length > limit) selected.push(`- …其余 ${paths.length - limit} 个文件`);
  return [
    "<delivery-selection schema=\"mae-flow-delivery-selection/1\" mode=\"allowlist\">",
    `用户通过文件勾选器确认：只交付以下 ${paths.length} 个文件。`,
    ...(selected.length ? selected : ["- （不交付任何文件）"]),
    `当前另有 ${excluded.length} 个文件未勾选；它们不得进入提交。`,
    "若当前 commit 与该清单不一致，请调整暂存/提交后重新进入代码检视；不要自行扩大清单。",
    "</delivery-selection>",
  ].join("\n");
}

interface AsyncGitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error?: Error;
}

/** 宿主网络 Git 的异步执行边界。timeout 时杀整个进程组，避免只杀 git
 * 却留下 ssh/credential 子进程；输出有界，远端异常也不能撑爆服务。 */
function runGitProcess(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxBuffer?: number;
  },
): Promise<AsyncGitResult> {
  return new Promise((resolveResult) => {
    const detached = process.platform !== "win32";
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached,
    });
    const maxBuffer = options.maxBuffer ?? 20 * 1024 * 1024;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow: Error | undefined;
    let timedOut = false;
    let spawnError: Error | undefined;
    const append = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
      const current = stream === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = maxBuffer - current;
      if (remaining <= 0) {
        overflow ??= new Error(`git ${stream} 超过 ${maxBuffer} bytes`);
        return;
      }
      const kept = chunk.subarray(0, remaining);
      target.push(kept);
      if (stream === "stdout") stdoutBytes += kept.length;
      else stderrBytes += kept.length;
      if (kept.length < chunk.length) {
        overflow ??= new Error(`git ${stream} 超过 ${maxBuffer} bytes`);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk, "stderr"));
    const killGroup = () => {
      try {
        if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // 进程可能恰好已经退出。
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolveResult({
        status: (spawnError || overflow || timedOut) ? null : status,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
        ...((spawnError ?? overflow) ? { error: spawnError ?? overflow } : {}),
      });
    });
  });
}

export class TaskService {
  /** 没有部署级 public URL 时，记住最近一次已登录用户实际访问的地址。
   * 通知由该次请求触发时即可带上同事能访问的内网 Host，而不是回环地址。 */
  private observedLinkBase?: string;
  private tasks = new Map<string, TaskState>();
  private runningCount = 0;
  private queue: string[] = [];
  private counter = 0;
  /** 编译槽与普通 Agent 并发彻底分账。槽位释放才唤醒下一单，等待者
   * 仍保留在任务现场里，可暂停/取消，不靠不可见的 Promise 排队。 */
  private activePrePushBuilds = 0;
  private prePushBuildQueue: PrePushBuildWaiter[] = [];
  /** 所有已创建且尚未确认删除的容器。任务字段只指向“当前”一个，
   * 这个集合还能覆盖 system-check 与正在 finally 清理的旧 attempt。 */
  private activeContainers = new Set<TaskCommandContainer>();
  private activeContainerContexts = new Map<TaskCommandContainer, {
    name: string;
    image: string;
    role: string;
    taskId: string;
    cacheKeys: string[];
  }>();
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private reviews: ReviewStore;
  private repositorySkillCatalogs =
    new Map<string, RepositorySkillCatalogTicket>();
  /** 逐任务决定锁：交付清单快照读取是异步的，两次点击会在真正落锁前
   * 同时越过校验。相同请求共享结果，不同请求仍由先到决定语义拒绝。 */
  private activeDecisions = new Map<string, {
    waitingId: string;
    digest: string;
    promise: Promise<TaskSummary>;
  }>();
  /** 原位重跑与彻底删除共享同一把逐任务锁，防止两个破坏性请求在
   * projection await 期间都拿着旧 TaskState 继续执行。 */
  private historyMutationActive = new Set<string>();
  /** 每次体积扫描都可能很重；自动回收与管理员手动回收不许重叠。 */
  private buildCacheReclaimActive = false;
  /** 平台探测是异步的，launchOptions 只消费最近一次事实。serve 在开放
   * HTTP 前先探一次，管理页每次“重新检查”都会刷新。 */
  private deliveryPlatformCheck?: DeliveryPlatformCheck;

  constructor(readonly options: TaskServiceOptions) {
    this.reviews = new ReviewStore(join(options.dataDir, "reviews.jsonl"));
    // 被彻底删除的最高编号不能在重启后复用；否则旧通知/浏览器收藏会
    // 悄悄指向一张毫不相关的新任务。水位单独留在 dataDir，不属于任
    // 何任务历史，因此硬删除不会碰它。
    try {
      const value = Number(readFileSync(
        join(options.dataDir, ".task-sequence"), "utf-8").trim());
      if (Number.isSafeInteger(value) && value >= 0) this.counter = value;
    } catch {
      // 旧部署没有水位文件；recover 会从仍在盘上的 task-N 补出起点。
    }
    // 桌面通知只有 serve --desktop-notify 显式要了才开(它会设
    // MAE_FLOW_DESKTOP_NOTIFY);其余一切宿主进程——测试、probe、pilot——
    // 一律静音。少了这道闸,npm test 拉起真内核当裁判时会把用户的 mac
    // 弹一串"需要你确认"(实锤弹过);环境变量随子进程继承,一处设置全链生效。
    if (!process.env.MAE_FLOW_DESKTOP_NOTIFY) {
      process.env.MAE_FLOW_NO_NOTIFY ??= "1";
    }
  }

  async refreshDeliveryPlatformCheck(): Promise<DeliveryPlatformCheck | undefined> {
    const platform = this.effectivePlatformUrl();
    if (!platform) {
      this.deliveryPlatformCheck = undefined;
      return undefined;
    }
    this.deliveryPlatformCheck = await probeDeliveryPlatform(platform);
    return this.deliveryPlatformCheck;
  }

  observeLinkBase(base: string | undefined): void {
    if (this.options.linkBase || !base) return;
    // 回环地址永不入账:它只对本机成立,发给别人就是死链(内网实锤:
    // 邀请检视的链接是 127.0.0.1)。管理员在服务器本机或经 SSH 隧道
    // (Host 就是 127.0.0.1)登录一次,不该把全体人的通知地址带沟里——
    // 学过的可用地址也不许被回环访问冲掉。
    try {
      const host = new URL(base).hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1"
          || host === "::1" || host === "[::1]") {
        return;
      }
    } catch {
      return;   // 解析不了的地址不入账
    }
    this.observedLinkBase = base.replace(/\/+$/, "");
  }

  private notificationLinkBase(): string | undefined {
    return this.options.linkBase ?? this.observedLinkBase;
  }

  private createTaskContainer(
    input: TaskContainerFactoryInput,
  ): TaskCommandContainer {
    if (this.shuttingDown) {
      throw new Error("服务正在关闭，拒绝创建新的任务容器");
    }
    const instance = taskContainerInstance(this.options.dataDir);
    const ownedInput: TaskContainerFactoryInput = {
      ...input,
      options: {
        ...input.options,
        runner: input.options.runner ?? this.options.isolation?.runner,
        labels: {
          ...(input.options.labels ?? {}),
          // 完整 dataDir 指纹是跨重启 ownership；短名字只供人辨认。
          "com.mae-flow-cloud.instance": instance.fingerprint,
        },
      },
    };
    const created = this.options.isolation?.containerFactory?.(ownedInput)
      ?? new TaskContainer(
        ownedInput.image,
        ownedInput.workspace,
        ownedInput.name,
        ownedInput.log,
        ownedInput.volumes,
        ownedInput.limits,
        ownedInput.options,
      );
    const service = this;
    let startPromise: Promise<void> | undefined;
    const tracked: TaskCommandContainer = {
      get metadata() { return created.metadata; },
      start: async () => {
        if (service.shuttingDown) {
          await created.stop();
          service.activeContainers.delete(tracked);
          service.activeContainerContexts.delete(tracked);
          throw new Error("服务正在关闭，拒绝启动新的任务容器");
        }
        if (!startPromise) {
          const attempt = Promise.resolve().then(() => {
            // Root 守护进程 + 非 root 容器时，clone、内核 bootstrap 和
            // 宿主文件工具留下的是 root 属主。必须在真正 docker run 前
            // 统一交给容器用户；只在 clone 后做一次会漏掉随后生成的
            // .mae-flow 状态，靠 umask 0000 又会把现场开放给所有用户。
            const prepared = prepareContainerHostPaths({
              workspace: ownedInput.workspace,
              volumes: ownedInput.volumes,
              user: ownedInput.limits.user,
              cacheRoot: service.options.isolation?.cacheRoot,
              markerRoot: join(
                service.options.dataDir, ".container-ownership"),
            });
            if (prepared.active
                && (prepared.workspaceEntries || prepared.cacheTrees)) {
              service.options.log?.(
                `[container-ownership] ${ownedInput.name}: `
                + `workspace=${prepared.workspaceEntries},`
                + `cache-trees=${prepared.cacheTrees},`
                + `owner=${prepared.owner!.uid}:${prepared.owner!.gid}`,
              );
            }
            return created.start();
          });
          startPromise = attempt.then(async () => {
            // docker run/inspect 在 await 期间收到 SIGTERM：容器可能刚刚
            // 出现。必须先确认删除，再让 start 以关闭错误返回。
            if (service.shuttingDown) {
              await created.stop();
              service.activeContainers.delete(tracked);
              service.activeContainerContexts.delete(tracked);
              throw new Error("服务关闭期间任务容器完成启动，已立即回收");
            }
          }).finally(() => { startPromise = undefined; });
        }
        return startPromise;
      },
      exec: (command, cwd, options) => {
        if (service.shuttingDown) {
          return Promise.reject(new Error(
            "服务正在关闭，拒绝向任务容器下发新的命令"));
        }
        return created.exec(command, cwd, options);
      },
      stop: async () => {
        // 不与 docker run/inspect 对冲；让启动动作先取得明确结果，再按
        // ownership 执行 TERM→KILL→rm。否则可能“先查不存在、后 run 出来”。
        if (startPromise) await startPromise.catch(() => undefined);
        await created.stop();
        service.activeContainers.delete(tracked);
        service.activeContainerContexts.delete(tracked);
      },
    };
    this.activeContainers.add(tracked);
    const cacheKeys = [...new Set(ownedInput.volumes
      .map((volume) => volume.split(":")[0])
      .map((source) => service.options.isolation?.cacheRoot
        ? cacheKeyFromPath(service.options.isolation.cacheRoot, source)
        : undefined)
      .filter((key): key is string => !!key))];
    this.activeContainerContexts.set(tracked, {
      name: ownedInput.name,
      image: ownedInput.image,
      role: ownedInput.options.labels?.["com.mae-flow-cloud.role"] ?? "unknown",
      taskId: ownedInput.options.labels?.["com.mae-flow-cloud.task"] ?? "system",
      cacheKeys,
    });
    return tracked;
  }

  /**
   * 起一个普通编码任务容器并等它就绪。
   *
   * 抽出来让会话开场与活会话缺失容器时的防御性重建共用同一套挂载、
   * 限额与 label，不能在恢复路径上悄悄换掉隔离参数。
   */
  private async startCodingContainer(
    task: TaskState,
    safety: {
      gitReadOnly?: boolean;
      /** 主任务的流水线修复会话需要通过 Bash 读取 ../pipeline/。默认
       * 开启；开发助手等旁路角色必须显式关闭，不能顺手获得任务材料。 */
      pipelineArtifacts?: boolean;
    } = {},
  ): Promise<TaskCommandContainer> {
    const isolation = this.options.isolation;
    if (!isolation) throw new Error("未配置任务容器隔离");
    const cwd = task.containerWorkspace;
    if (!cwd) throw new Error("任务容器工作区未知，拒绝按猜测挂载");
    const {
      image, volumes, memory, cpus, user, pidsLimit, labels,
      readOnlyRoot, tmpfsHome, tmpfsTmp, network,
      forwardEnvironment, stopGraceSeconds, managementTimeoutMs,
    } = isolation;
    // 容器名带数据目录指纹:同 dataDir 重启后同名(孤儿可清扫),
    // 不同实例(测试与试跑并行)绝不同名——只按任务 id 命名时,
    // 另一实例的 rm -f 会把这边活着的容器当孤儿误杀(实测:
    // run7 续跑期间并行跑隔离测试,容器被杀,模型如实报告
    // "执行容器丢失",整单被迫收口)。
    const instance = taskContainerInstance(this.options.dataDir).namePrefix;
    // host 模式的两条硬依赖也要进容器:内核插件根(转发壳硬编码
    // 其绝对路径,只读)与 Git 远端——但只有本地路径仓(演示裸仓)
    // 才需要挂载;URL 仓走网络,拿路径当挂载参数只会喂 docker 垃圾。
    const effectiveRepo =
      task.summary.repo_url ?? this.effectiveDefaultRepo();
    const hostMounts = this.options.host
      ? [
          `${this.options.host.kernelRoot}:${this.options.host.kernelRoot}:ro`,
          ...(effectiveRepo && existsSync(effectiveRepo)
            // 本地裸仓只供演练/离线环境读取。Agent 的 push 已由宿主
            // 统一执行，不能因“这是本地路径”就把远端仓 RW 交给容器。
            ? [`${effectiveRepo}:${effectiveRepo}:ro`] : []),
        ]
      : [];
    const gitPath = join(cwd, ".git");
    const pipelineArtifacts = resolve(task.summary.workspace, "pipeline");
    const mountPipelineArtifacts = safety.pipelineArtifacts ?? true;
    if (mountPipelineArtifacts) {
      // 容器通常早于首轮权威流水线启动。bind 源必须现在就存在，后续
      // mirrorPipelineArtifacts 只原地刷新内容，运行中的容器即可看到。
      mkdirSync(pipelineArtifacts, { recursive: true });
    }
    const mounts = this.taskContainerMounts(task, [
      ...hostMounts,
      ...(volumes ?? []),
      ...(mountPipelineArtifacts
        ? [`${pipelineArtifacts}:${pipelineArtifacts}:ro`] : []),
      ...(safety.gitReadOnly && existsSync(gitPath)
        ? [`${gitPath}:${gitPath}:ro`] : []),
    ]);
    const container = this.createTaskContainer({
      image,
      workspace: cwd,
      name: `mfc-${instance}-${task.summary.id}`,
      log: this.options.log,
      volumes: mounts.volumes,
      limits: { memory, cpus, user, pidsLimit },
      options: {
        labels: {
          ...(labels ?? {}),
          "com.mae-flow-cloud.task": task.summary.id,
          "com.mae-flow-cloud.role": "coding",
        },
        readOnlyRoot,
        tmpfsHome,
        tmpfsTmp,
        network,
        environment: mounts.environment,
        forwardEnvironment,
        stopGraceSeconds,
        managementTimeoutMs,
      },
    });
    await container.start();
    return container;
  }

  /**
   * 取得可用的任务容器:正常会话始终复用原实例；句柄异常缺失时才
   * 防御性重建。人工等待本身绝不走这里的重建分支。
   *
   * 开不起来一律抛给调用方 → 变成这条 Bash 的执行失败。这里绝不
   * 能退回宿主执行:那是"要隔离就真隔离"红线的正面。
   */
  private async activeTaskContainer(
    task: TaskState,
  ): Promise<TaskCommandContainer> {
    if (task.container) return task.container;
    const epoch = task.controlEpoch;
    if (!task.containerReopen) {
      // 重开是异步的,期间用户完全可能按下暂停/取消——那条路径刚
      // 停完容器就把 task.container 置空,我们再挂一个上去就是无主
      // 泄漏。拿 epoch 当凭证:换了就地自毁,不往任务上挂。
      task.containerReopen = this.startCodingContainer(task)
        .then(async (container) => {
          if (!this.current(task, epoch)) {
            await container.stop().catch(() => undefined);
            throw new Error("任务容器重开期间任务已暂停或取消，已就地回收");
          }
          if (task.container) {
            await container.stop().catch(() => undefined);
            return task.container;
          }
          task.container = container;
          this.options.log?.(
            `任务 ${task.summary.id} 收到新命令,任务容器已重新开起`);
          return container;
        })
        .finally(() => { task.containerReopen = undefined; });
    }
    return task.containerReopen;
  }

  /** recover 前调用：只清扫完整 dataDir ownership 指纹匹配的遗留容器。 */
  async sweepOrphanContainers(): Promise<{ found: number; removed: string[] }> {
    const isolation = this.options.isolation;
    if (!isolation) return { found: 0, removed: [] };
    const instance = taskContainerInstance(this.options.dataDir);
    return sweepManagedTaskContainers({
      instanceFingerprint: instance.fingerprint,
      namePrefix: instance.namePrefix,
      stopGraceSeconds: isolation.stopGraceSeconds,
      managementTimeoutMs: isolation.managementTimeoutMs,
      runner: isolation.runner,
      log: this.options.log,
    });
  }

  /**
   * 进程级优雅关闭。只换掉内存 epoch、停调度并释放资源，不改写任务
   * 业务状态；下次启动仍由 recover 按原来的 task.json 续跑。
   */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      this.queue = [];
      const waiters = this.prePushBuildQueue.splice(0);
      for (const waiter of waiters) waiter.resolve(undefined);

      const drivers = new Map<CloudSession, string>();
      const backgroundWork: Array<{
        taskId: string;
        role: string;
        work: Promise<unknown>;
      }> = [];
      for (const task of this.tasks.values()) {
        // 旧回调即使稍后返回，也不能在关机窗口改写业务状态。
        task.controlEpoch += 1;
        task.assistantEpoch = (task.assistantEpoch ?? 0) + 1;
        task.pauseRequested = false;
        task.prepushAbort?.abort();
        task.prepushAbort = undefined;
        if (task.driver) drivers.set(task.driver, task.summary.id);
        task.driver = undefined;
        task.container = undefined;
        if (task.prepushActive) {
          backgroundWork.push({
            taskId: task.summary.id,
            role: "prepush",
            work: task.prepushActive,
          });
        }
        if (task.reviewOutboxFlush) {
          // 回复请求已经可能到达外部平台，不能在 shutdown 返回后仍让
          // 旧进程追加账本/持久化，与随后启动的新进程恢复链并发。
          backgroundWork.push({
            taskId: task.summary.id,
            role: "review-outbox",
            work: task.reviewOutboxFlush,
          });
        }
        if (task.assistantActive) {
          interruptDeveloperAssistant(
            task.summary.workspace,
            "服务关闭中断了本轮开发助手，可在重启后重新发起",
          );
          backgroundWork.push({
            taskId: task.summary.id,
            role: "developer-assistant",
            work: task.assistantActive,
          });
        }
      }

      const cleanup: Array<{ label: string; work: Promise<unknown> }> = [];
      for (const [driver, taskId] of drivers) {
        cleanup.push({ label: `phase=abort-session task=${taskId}`,
          work: driver.abort() });
      }
      for (const container of this.activeContainers) {
        const metadata = container.metadata;
        const planned = this.activeContainerContexts.get(container);
        const role = metadata?.labels["com.mae-flow-cloud.role"]
          ?? planned?.role ?? "unknown";
        const taskId = metadata?.labels["com.mae-flow-cloud.task"]
          ?? planned?.taskId ?? "system";
        const name = metadata?.name ?? planned?.name ?? "unknown";
        const id = metadata?.containerId.slice(0, 12) ?? "unknown";
        const image = metadata?.immutableImageReference
          ?? planned?.image ?? "unknown";
        const label = `phase=remove-container role=${role} task=${taskId}`
          + ` name=${name} id=${id} image=${image}`;
        this.options.log?.(`服务关闭 ${label}`);
        cleanup.push({ label, work: container.stop() });
      }
      for (const background of backgroundWork) {
        cleanup.push({
          label: `phase=await-${background.role} task=${background.taskId}`,
          work: background.work,
        });
      }
      const contextual = cleanup.map(({ label, work }) => work.catch((cause) => {
        throw new Error(`${label}: ${String(cause)}`, { cause });
      }));
      const settled = await Promise.allSettled(contextual);
      for (const driver of drivers.keys()) driver.dispose();
      this.activePrePushBuilds = 0;
      const failures = settled
        .filter((item): item is PromiseRejectedResult => item.status === "rejected")
        .map((item) => item.reason);
      if (failures.length) {
        throw new AggregateError(failures,
          `服务关闭时有 ${failures.length} 项资源未能确认释放: `
            + failures.map(String).join(" | "));
      }
      this.options.log?.(`服务关闭完成: ${cleanup.length} 项会话/容器资源已释放`);
    })();
    return this.shutdownPromise;
  }

  private taskContainerMounts(
    task: TaskState,
    volumes: string[],
  ): { volumes: string[]; environment: NodeJS.ProcessEnv } {
    const repository = task.summary.repo_url
      ?? this.effectiveDefaultRepo()
      ?? task.cwd
      ?? task.summary.id;
    return this.containerMountsForRepository(repository, volumes, task.cwd);
  }

  private containerMountsForRepository(
    repository: string,
    volumes: string[],
    /**
     * 正式任务是 <任务目录>/<仓名>。部分内部 C++ Maven 插件约定
     * ${project.basedir}/../cpp_sdk_repository；因此 SDK 缓存必须作为
     * 仓库同级目录挂入，不能拍扁到 /workspace 或镜像根目录。
     */
    workspace?: string,
  ): { volumes: string[]; environment: NodeJS.ProcessEnv } {
    const isolation = this.options.isolation;
    const environment: NodeJS.ProcessEnv = { ...(isolation?.environment ?? {}) };
    // 宿主身份必须跟进容器:内核靠 MAE_FLOW_HOST 区分"用户是否坐在终端
    // 前",漏传时容器里的 current 按本地宿主渲染,云端确认类步骤的
    // --auto 路径整个失效(run8b 实测:领域归档在云端又弹了人工卡)。
    if (process.env.MAE_FLOW_HOST && !environment.MAE_FLOW_HOST) {
      environment.MAE_FLOW_HOST = process.env.MAE_FLOW_HOST;
    }
    if (!isolation?.cacheRoot) return { volumes, environment };

    const cppSdkDestination = workspace
      ? join(dirname(resolve(workspace)), "cpp_sdk_repository")
      : undefined;
    const destinations = new Set([
      "/cache/maven", "/cache/npm", "/cache/ccache", "/cache/xdg",
      ...(cppSdkDestination ? [cppSdkDestination] : []),
    ]);
    for (const volume of volumes) {
      const destination = volume.split(":")[1];
      if (destination && destinations.has(destination.replace(/\/+$/, ""))) {
        throw new Error(
          `自定义挂载不能覆盖平台的分仓缓存目录: ${destination}`,
        );
      }
    }
    const { base: cacheBase } = touchBuildCache(isolation.cacheRoot, repository);
    const caches = [
      ["maven", "/cache/maven"],
      ["npm", "/cache/npm"],
      ["ccache", "/cache/ccache"],
      ["xdg", "/cache/xdg"],
      ...(cppSdkDestination
        ? [["cpp-sdk", cppSdkDestination] as const]
        : []),
    ] as const;
    for (const [name] of caches) mkdirSync(join(cacheBase, name), { recursive: true });
    const mavenOptions = String(environment.MAVEN_OPTS ?? "").trim();
    return {
      volumes: [
        ...volumes,
        ...caches.map(([name, destination]) =>
          `${join(cacheBase, name)}:${destination}`),
      ],
      environment: {
        ...environment,
        MAVEN_OPTS: [mavenOptions,
          "-Dmaven.repo.local=/cache/maven/repository"]
          .filter(Boolean).join(" "),
        npm_config_cache: "/cache/npm",
        CCACHE_DIR: "/cache/ccache",
        XDG_CACHE_HOME: "/cache/xdg",
        // ccache 真正接线(内网五项取证实锤:装了、CCACHE_DIR 也对,
        // 但缓存 0 文件——编译器从没被包过,C++ 每轮全量冷编)。CMake
        // 在 configure 时认这两个环境变量;部署基线镜像必装 ccache
        // (playbook 基础设施预检同款清单),对 Java/JS 构建惰性无害。
        CMAKE_C_COMPILER_LAUNCHER: "ccache",
        CMAKE_CXX_COMPILER_LAUNCHER: "ccache",
        // 跨任务也要命中:不同任务克隆路径不同(task-N/仓名),按绝对
        // 路径做 key 永远 miss。以任务目录为基准做相对化——克隆与
        // cpp_sdk_repository 都在其下,相对布局跨任务恒定。
        ...(workspace
          ? { CCACHE_BASEDIR: dirname(resolve(workspace)) } : {}),
        CCACHE_NOHASHDIR: "1",
        // 30w 行 C++ 仓一轮对象 5.7G(内网实测),默认 5G 上限会被
        // 自己的下一轮淘汰光;分仓缓存目录彼此隔离,放大到 20G。
        CCACHE_MAXSIZE: "20G",
      },
    };
  }

  private prePushBuildSlotCount(): number {
    const configured = Number(this.options.prepush?.buildSlots ?? 1);
    return Number.isFinite(configured)
      ? Math.max(1, Math.floor(configured)) : 1;
  }

  private releasePrePushBuildSlot(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activePrePushBuilds = Math.max(0, this.activePrePushBuilds - 1);
      this.drainPrePushBuildQueue();
    };
  }

  private drainPrePushBuildQueue(): void {
    if (this.shuttingDown) {
      const waiters = this.prePushBuildQueue.splice(0);
      for (const waiter of waiters) waiter.resolve(undefined);
      return;
    }
    const slots = this.prePushBuildSlotCount();
    while (this.activePrePushBuilds < slots
        && this.prePushBuildQueue.length) {
      const waiter = this.prePushBuildQueue.shift()!;
      if (!this.current(waiter.task, waiter.epoch)
          || waiter.task.summary.status === "paused"
          || waiter.task.summary.status === "pausing") {
        waiter.resolve(undefined);
        continue;
      }
      this.activePrePushBuilds += 1;
      waiter.task.summary.detail = `已获得 Build-Fix 构建资源（`
        + `${this.activePrePushBuilds}/${slots} 使用中）`;
      // 出队时把排队文案换掉,否则整轮编译期间气泡都还挂着"排队等待"。
      const granted = waiter.task.summary.delivery?.prepush;
      if (granted?.state === "preparing") {
        this.setPrePushState(waiter.task, {
          ...granted,
          message: "已获得编译槽位，正在启动 Build-Fix",
          updated_at: new Date().toISOString(),
        });
      }
      this.persist(waiter.task);
      waiter.resolve(this.releasePrePushBuildSlot());
    }
  }

  private acquirePrePushBuildSlot(
    task: TaskState,
    epoch: number,
  ): Promise<(() => void) | undefined> {
    if (this.shuttingDown) return Promise.resolve(undefined);
    if (!this.current(task, epoch)) return Promise.resolve(undefined);
    const slots = this.prePushBuildSlotCount();
    if (this.activePrePushBuilds < slots) {
      this.activePrePushBuilds += 1;
      return Promise.resolve(this.releasePrePushBuildSlot());
    }
    task.summary.detail = `等待 Build-Fix 构建资源（${this.activePrePushBuilds}/`
      + `${slots} 使用中，按任务顺序排队）`;
    // 排队真相也要进 prepush 现场:气泡读的是 prepush.message 不是任务
    // detail,不写这里用户看到的就是一动不动的"准备"(实锤被当成卡死)。
    const waiting = task.summary.delivery?.prepush;
    if (waiting?.state === "preparing") {
      this.setPrePushState(task, {
        ...waiting,
        message: `排队等待编译槽位（${this.activePrePushBuilds}/${slots} `
          + "使用中，前面的构建结束后自动开始）",
        updated_at: new Date().toISOString(),
      });
    }
    this.persist(task);
    return new Promise((resolve) => {
      this.prePushBuildQueue.push({ task, epoch, resolve });
    });
  }

  private removePrePushBuildWaiter(task: TaskState): void {
    const kept: PrePushBuildWaiter[] = [];
    for (const waiter of this.prePushBuildQueue) {
      if (waiter.task === task) waiter.resolve(undefined);
      else kept.push(waiter);
    }
    this.prePushBuildQueue = kept;
  }

  list(): TaskSummary[] {
    return [...this.tasks.values()]
      .map((task) => this.project(task))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /** 团队知识运营读模型。独立接口按需计算，避免把所有任务足迹塞进
   * 1.5 秒一次的任务列表轮询。任何建议都不参与流程或质量裁决。 */
  knowledgeInsights(): TeamKnowledgeInsights & { host_skills: HostSkillShelf } {
    // 货架(部署态资产)与足迹(消费聚合)同口径一次给全:足迹只看得见
    // 被任务带过的资源,放坏了的 skill 在足迹里隐形,货架把它照出来。
    const projected = [...this.tasks.values()]
      .map((task) => this.project(task, true));
    return {
      ...buildTeamKnowledgeInsights(projected),
      host_skills: this.decorateHostSkillShelf(projected),
    };
  }

  /** 货架 + 效果账(飞轮第 3 步):每个条目带消费率与 prepush 一次过
   * 对照,低消费/高摩擦亮修订信号。/skills 管理接口与知识效能页共用
   * 这一份,数字口径不许有两套。 */
  hostSkillShelf(): DecoratedHostSkillShelf {
    return this.decorateHostSkillShelf([...this.tasks.values()]
      .map((task) => this.project(task, true)));
  }

  private decorateHostSkillShelf(
    tasks: KnowledgeInsightTask[],
  ): DecoratedHostSkillShelf {
    const shelf = listHostSkillShelf(this.options.dataDir);
    const effects = buildHostSkillEffects(tasks);
    return {
      ...shelf,
      skills: shelf.skills.map((skill) => {
        const directory = skill.path.includes("/")
          ? skill.path.split("/")[0] : undefined;
        return {
          ...skill,
          effect: effects.get(skill.name),
          candidates: directory
            ? listSkillCandidates(this.options.dataDir, directory)
              .filter((item) => item.status === "drafted").length
            : 0,
        };
      }),
    };
  }

  /** 沉淀环(roadmap §9):从读过该 skill 的任务现场起草修订稿,
   * 落候选区等管理员裁决。旁路纪律:单发模型调用带硬超时,同一时刻
   * 只跑一份,失败如实报错;绝不自动上架。 */
  async distillSkillDraft(
    directory: string,
    operator: string,
  ): Promise<SkillCandidateRecord> {
    if (this.distillActive) {
      throw new TaskControlError("已有一份修订稿在起草中,请稍候");
    }
    const shelf = listHostSkillShelf(this.options.dataDir);
    const entry = shelf.skills.find((skill) =>
      skill.path.split("/")[0] === directory);
    if (!entry) {
      throw new TaskControlError(`货架上没有这个 skill: ${directory}`);
    }
    const active = this.activeModelChoice();
    if (!active) {
      throw new TaskControlError("模型网关未配置,无法起草(管理页 → 模型网关)");
    }
    const projected = [...this.tasks.values()]
      .map((task) => this.project(task, true));
    const evidence = collectSkillEvidence(projected, entry.name);
    if (!evidence.taskIds.length) {
      throw new TaskControlError(
        "还没有任务真正读过这个 skill,证据不足以起草——先让它被用起来");
    }
    const skillContent = readFileSync(
      join(this.options.dataDir, "skills", ...entry.path.split("/")), "utf-8");
    const prompt = buildDistillPrompt({
      skillName: entry.name,
      skillContent,
      effect: buildHostSkillEffects(projected).get(entry.name),
      evidenceText: evidence.text,
    });
    this.distillActive = true;
    try {
      const raw = await draftWithModel({
        modelsJson: this.activeModelsJson(),
        provider: active.provider,
        model: active.model,
        system: prompt.system,
        user: prompt.user,
      });
      const draft = parseDraft(raw);
      return saveSkillCandidate(this.options.dataDir, directory, {
        skill: draft.skill,
        notes: draft.notes,
        evidence: evidence.text,
      }, evidence.taskIds, operator);
    } finally {
      this.distillActive = false;
    }
  }
  private distillActive = false;

  get(id: string): TaskSummary | undefined {
    const task = this.tasks.get(id);
    return task ? this.project(task, true) : undefined;
  }

  historyMutationInProgress(id: string): boolean {
    return this.historyMutationActive.has(id);
  }

  /** 责任人主动发出的 Committer 检视邀请。邀请先落盘，再投递；通知
   * 失败也不会把“有人应当检视”这个事实弄丢。 */
  async requestReview(
    id: string,
    requester: string,
    committer: string,
  ): Promise<ReviewRequest> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const notifier = this.options.notifier;
    if (!notifier) throw new Error("本部署未接通知器");
    const review = this.reviews.create({
      taskId: id,
      taskTitle: task.summary.title ?? taskTitle(task.summary.requirement),
      requester,
      committer,
    });
    const result = await notifier.notifyReview({
      taskId: id,
      senderAccount: requester,
      account: committer,
      summary: review.task_title,
      link: reviewTaskLink(this.notificationLinkBase(), id, review.id),
    });
    return this.reviews.delivery(review.id, result);
  }

  listReviewsFor(committer: string): ReviewRequest[] {
    return this.reviews.forCommitter(committer);
  }

  listTaskReviews(taskId: string): ReviewRequest[] {
    if (!this.tasks.has(taskId)) throw new NotFoundError(`任务 ${taskId} 不存在`);
    return this.reviews.forTask(taskId);
  }

  completeReview(id: string, committer: string): ReviewRequest {
    const current = this.reviews.list().find((item) => item.id === id);
    if (!current) throw new Error(`检视邀请 ${id} 不存在`);
    if (current.committer !== committer) {
      throw new Error("只能完成邀请给自己的检视");
    }
    const task = this.tasks.get(current.task_id);
    if (!task) throw new Error(`任务 ${current.task_id} 不存在`);
    const mine = this.annotations(task).visible().filter((item) =>
      item.author === committer);
    const drafts = mine.filter((item) => item.status === "draft");
    const open = mine.filter((item) => item.status === "sent");
    if (drafts.length || open.length) {
      throw new Error([
        drafts.length ? `还有 ${drafts.length} 条草稿尚未提交或删除` : "",
        open.length ? `还有 ${open.length} 条已提交意见尚未确认闭环` : "",
      ].filter(Boolean).join("；"));
    }
    const record = this.reviews.complete(id, committer);
    // 收口回执:发起人在等这个信号——不发,他只能反复刷页面或线下问
    // (2026-08-30 审计:检视完成静默,两边互等)。纯旁路,失败只留日志。
    if (this.options.notifier && record.requester
        && record.requester !== committer) {
      this.bypass(undefined, "检视完成回执", this.options.notifier.notifyOutcome({
        taskId: record.task_id,
        account: record.requester,
        status: `review-completed:${record.id}`,
        summary: `${committer} 已完成对「${record.task_title}」的检视,`
          + "可以继续推进任务",
        link: personalTaskLink(
          this.notificationLinkBase(), record.requester, record.task_id),
      }));
    }
    return record;
  }

  /** 启动一次与真实任务同约束的短命容器，验证的不是宿主 PATH，而是
   * 真正会承载 Agent 命令的镜像、挂载、身份和工具链。 */
  private async probeTaskContainerToolchain(): Promise<{
    ready: boolean;
    detail: string;
    suggestion?: string;
  }> {
    const isolation = this.options.isolation;
    if (!isolation) {
      return {
        ready: false,
        detail: "未配置统一任务容器",
        suggestion: "启动时加 --isolate-image <统一构建镜像>",
      };
    }
    // 自检也使用真实的“父目录/仓名”包络，避免工具链全绿、内部 C++
    // 项目却因 build/../../ 被拍扁到根目录而失败。
    const workspaceRoot = join(this.options.dataDir, "system-check-container");
    const workspace = join(workspaceRoot, "MfcProbeRepository");
    mkdirSync(workspace, { recursive: true });
    const kernelRoot = this.options.host?.kernelRoot;
    const mounted = this.containerMountsForRepository(
      "mae-flow-cloud/system-check",
      [
        ...(isolation.volumes ?? []),
        ...(kernelRoot ? [`${kernelRoot}:${kernelRoot}:ro`] : []),
      ],
      workspace,
    );
    const expectsMavenSettings = hasContainerVolumeDestination(
      mounted.volumes,
      "/etc/mae-flow/maven/settings.xml",
    );
    const instance = taskContainerInstance(this.options.dataDir).namePrefix;
    const containerName = `mfc-${instance}-system-check-${randomUUID().slice(0, 8)}`;
    const container = this.createTaskContainer({
      image: isolation.image,
      workspace,
      name: containerName,
      log: this.options.log,
      volumes: mounted.volumes,
      limits: {
        memory: isolation.memory,
        cpus: isolation.cpus,
        user: isolation.user,
        pidsLimit: isolation.pidsLimit,
      },
      options: {
        labels: {
          ...(isolation.labels ?? {}),
          "com.mae-flow-cloud.role": "system-check",
        },
        readOnlyRoot: isolation.readOnlyRoot,
        tmpfsHome: isolation.tmpfsHome,
        tmpfsTmp: isolation.tmpfsTmp,
        network: isolation.network,
        environment: {
          ...mounted.environment,
          ...(kernelRoot ? { MFC_KERNEL_ROOT: kernelRoot } : {}),
          ...(expectsMavenSettings ? { MFC_EXPECT_MAVEN_SETTINGS: "1" } : {}),
        },
        forwardEnvironment: isolation.forwardEnvironment,
        stopGraceSeconds: isolation.stopGraceSeconds,
        managementTimeoutMs: isolation.managementTimeoutMs,
      },
    });
    let output = "";
    let failure: unknown;
    let failurePhase = "start";
    let detail = "";
    try {
      await container.start();
      failurePhase = "toolchain-exec";
      const command = [
        "set -eu",
        // 写入真正的 bind-mounted workspace，避免“只在 /tmp 能编译”
        // 的坏镜像通过自检。EXIT trap 保证失败路径也不留探针文件。
        'scratch="$PWD/.mfc-self-check-$$"',
        'trap \'rm -rf "$scratch"\' EXIT',
        'mkdir -p "$scratch"',
        'test -w "$PWD"',
        // Maven 会从 passwd 数据库而非 $HOME 发现用户目录；两者漂移时
        // settings 明明挂好了也会被 Maven 静默忽略。
        'passwd_home="$(awk -F: -v uid="$(id -u)" \'$3 == uid { print $6; exit }\' /etc/passwd)"',
        'test -n "$passwd_home"',
        'test "$passwd_home" = "$HOME"',
        // 五类缓存都必须是实际可写挂载；逐个写读删，不只看目录权限位。
        'sdk_cache="$(dirname "$PWD")/cpp_sdk_repository"',
        'for cache in /cache/maven /cache/npm /cache/ccache /cache/xdg "$sdk_cache"; do test -d "$cache"; probe="$cache/.mfc-self-check-$$"; printf cache-ok > "$probe"; test "$(cat "$probe")" = cache-ok; rm -f "$probe"; done',
        // 复现内部 C++ 仓 svc_profile.sh 的路径算法：仓库 build/../../
        // 必须回到聚合根，聚合根/<仓名> 必须就是当前仓库。
        'mkdir -p "$PWD/build"',
        'envelope_root="$(cd "$PWD/build/../.." && pwd)"',
        'test "$envelope_root/$(basename "$PWD")" = "$PWD"',
        // 内部基础镜像曾把 profile、平台 CLI 和 CA 路径做成 0750
        // root:root；root 阶段 docker build 全绿，10001 真跑却全拒绝。
        'for script in /etc/profile.d/*.sh; do test ! -e "$script" || test -r "$script"; done',
        'for directory in /etc/pki /etc/pki/tls /etc/pki/tls/certs; do test ! -e "$directory" || test -x "$directory"; done',
        'for ca in /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/certs/ca-certificates.crt; do test ! -e "$ca" || test -r "$ca"; done',
        'for optional in codehub-cli spes; do path="$(command -v "$optional" 2>/dev/null || true)"; test -z "$path" || test -x "$path"; done',
        // 真任务会把内核根只读挂入；父目录 0750 时工具链自检会绿，
        // mae-flow 第一条命令却 Permission denied。这里必须同形验证。
        'if test -n "${MFC_KERNEL_ROOT:-}"; then test -x "$MFC_KERNEL_ROOT"; test -r "$MFC_KERNEL_ROOT/scripts/mae-flow.py"; fi',
        "java -version 2>&1",
        "java -version 2>&1 | grep -Eq 'version \\\"21([.]|\\\"| )'",
        'mvn_info="$(mvn --version 2>&1)"',
        'printf \'%s\\n\' "$mvn_info"',
        'printf \'%s\\n\' "$mvn_info" | grep -Eq \'Java version: 21([., ]|$)\'',
        'mvn_java_home="$(printf \'%s\\n\' "$mvn_info" | sed -n \'s/^.*runtime: \\([^,]*\\).*$/\\1/p\' | head -n 1)"',
        'test -n "$mvn_java_home"',
        'test -r "$mvn_java_home/lib/security/cacerts"',
        'if test "${MFC_EXPECT_MAVEN_SETTINGS:-}" = 1; then test -r /etc/mae-flow/maven/settings.xml; test -r "$HOME/.m2/settings.xml"; fi',
        "node --version",
        'test "$(node -p \'Number(process.versions.node.split(\".\")[0])\')" -ge 18',
        "npm --version",
        'test "$(npm --version | cut -d. -f1)" -ge 9',
        "c++ --version",
        "ar --version",
        "bison --version",
        "flex --version",
        "ccache --version",
        "git --version",
        "python3 --version",
        // Cloud 的真正第一步不是“Python 能启动”，而是托管任务能在同一
        // 容器挂载/用户下完成 init，并在 config_confirm 拒绝源码写入。
        // 过去自检全绿但 init 失败后 INACTIVE 继续放行，正是因为只测了
        // 文件可读，从未打过这条真实入口。
        'if test -n "${MFC_KERNEL_ROOT:-}"; then flow_probe="$scratch/managed-flow"; mkdir -p "$flow_probe"; cd "$flow_probe"; git init -q; git config user.name mfc-probe; git config user.email mfc-probe@localhost; printf \'export const probe = 1;\\n\' > main.ts; git add main.ts; git commit -qm initial; printf \'%s\\n\' \'{"execution_contract":{"schema":"mae-flow-execution/1","host":"cloud","compile":"pipeline","ut_write":"agent","ut_run":"pipeline","codecheck":"pipeline","git_push":"host"},"UT生成方式":"仓内写法"}\' > .mae-flow-order.json; MAE_FLOW_HOST=cloud python3 "$MFC_KERNEL_ROOT/scripts/mae-flow.py" init > init.log; test -s .mae-flow.json; MAE_FLOW_HOST=cloud python3 "$MFC_KERNEL_ROOT/scripts/mae-flow.py" current > current.log; grep -q \'config_confirm\\|配置确认\' current.log; if MAE_FLOW_HOST=cloud python3 "$MFC_KERNEL_ROOT/scripts/mae-flow.py" gate edit main.ts > gate.log 2>&1; then echo \'managed flow edit gate unexpectedly allowed source write\' >&2; exit 41; fi; grep -q \'交付方式尚未选定\' gate.log; cd "$OLDPWD"; fi',
        'printf \'class MfcSelfCheck { public static void main(String[] a) { System.out.print("java-ok"); } }\\n\' > "$scratch/MfcSelfCheck.java"',
        'javac -d "$scratch" "$scratch/MfcSelfCheck.java"',
        'java -cp "$scratch" MfcSelfCheck',
        'printf \'#include <iostream>\\nint main(){std::cout<<" cpp-ok";}\\n\' > "$scratch/check.cpp"',
        'c++ "$scratch/check.cpp" -o "$scratch/check"',
        '"$scratch/check"',
        "node -e 'process.stdout.write(\" node-ok\")'",
        'printf \' __MFC_CONTAINER_TOOLCHAIN_OK__\\n\'',
      ].join("; ");
      const result = await container.exec(command, workspace, {
        timeout: 60,
        onData: (chunk) => { output += chunk.toString(); },
      });
      if (result.exitCode !== 0
          || !output.includes("__MFC_CONTAINER_TOOLCHAIN_OK__")) {
        throw new Error(`容器工具链自检退出码 ${result.exitCode}`);
      }
      failurePhase = "verify-metadata";
      const immutable = container.metadata?.immutableImageReference
        ?? isolation.image;
      detail = `镜像 ${immutable} 已真实启动；passwd HOME 与容器 HOME 一致，`
        + `Maven 实际运行于 JDK 21 且 JVM cacerts 可读${expectsMavenSettings
          ? "、部署 Maven settings 已接入" : ""}；bind 工作区可写并以 JDK 21/Maven、`
        + "C/C++ 完成编译执行，Maven/npm/ccache/XDG 缓存均可写；"
        + "Node 18+/npm 9+、Git、Python 工具及 profile/CA/可选平台 CLI"
        + `${kernelRoot ? "、Mae-Flow 内核挂载" : ""}权限通过`;
      if (kernelRoot) {
        detail += "；容器内托管任务 init/current 与配置阶段源码写入拦截通过";
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        await container.stop();
      } catch (error) {
        failurePhase = failure ? `${failurePhase}+cleanup` : "cleanup";
        failure = failure
          ? new AggregateError([failure, error], "自检容器执行及清理均失败")
          : error;
      }
    }
    if (!failure) return { ready: true, detail };
    const tail = output.trim().split("\n").slice(-8).join(" | ");
    const metadata = container.metadata;
    const context = `phase=${failurePhase} role=system-check name=${containerName}`
      + ` id=${metadata?.containerId.slice(0, 12) ?? "unknown"}`
      + ` image=${metadata?.immutableImageReference ?? isolation.image}`;
    return {
      ready: false,
      detail: "统一任务容器或其工具链不可用",
      suggestion: `${context}: ${String(failure)}`
        + `${tail ? `；末段输出: ${tail}` : ""}`,
    };
  }

  /** 管理员部署自检：不发送测试消息、不创建业务任务，也不改变运行配置；
   * 会启动并销毁一个短命构建容器，以免把宿主工具链误报成任务可用。 */
  async systemCheck(): Promise<SystemCheckResult> {
    const items: SystemCheckItem[] = [];
    const runtime = this.options.deploymentRuntime;
    items.push(runtime
      ? { key: "runtime", label: "Linux 部署", ...runtime }
      : { key: "runtime", label: "Linux 部署", status: "warning",
          detail: "当前调用形态没有部署运行信息",
          suggestion: "请从正式 serve 入口运行部署自检" });
    try {
      accessSync(this.options.dataDir, constants.R_OK | constants.W_OK);
      items.push({ key: "data", label: "任务数据", status: "ok",
        detail: "数据目录可读写" });
    } catch (error) {
      items.push({ key: "data", label: "任务数据", status: "error",
        detail: "数据目录不可读写", suggestion: String(error) });
    }

    const active = this.launchOptions().model;
    items.push(active
      ? { key: "model", label: "模型网关", status: "ok",
          detail: `${active.provider}/${active.model} 已配置` }
      : { key: "model", label: "模型网关", status: "error",
          detail: "没有可用模型",
          suggestion: "管理页 → 模型网关：填写网关地址、API Key 和模型名称" });

    const vision = this.activeVisionChoice();
    items.push(vision
      ? { key: "vision", label: "图片识别", status: "ok",
          detail: `${vision.provider}/${vision.model} 已配置（未做实时调用）`,
          suggestion: "可在管理页点击“测试识图能力”做真实端到端验证" }
      : { key: "vision", label: "图片识别", status: "warning",
          detail: "尚未配置专用图片识别模型",
          suggestion: "管理页 → 图片识别：配置内部多模态模型网关；不影响纯文本任务" });

    const notify = this.options.notifier?.health();
    items.push(!notify?.configured
      ? { key: "notify", label: "消息通知", status: "warning",
          detail: "通知通道未配置",
          suggestion: "这是部署项；成员只需在个人设置中填写自己的小鲁班 Token" }
      : notify.last_error
        ? { key: "notify", label: "消息通知", status: "warning",
            detail: "已配置，但最近一次投递失败", suggestion: notify.last_error }
        : { key: "notify", label: "消息通知", status: "ok",
            detail: "小鲁班通知通道已就绪" });

    // 通知链接地址:2026-08-19 内网实锤——没配 --public-url,发起人又
    // 只从回环地址(本机/SSH 隧道)访问,通知里的链接别人打不开。回环
    // 已不入账,所以这里能如实分三种:显式配置 > 已自学 > 还没着落。
    const linkBase = this.notificationLinkBase();
    items.push(this.options.linkBase
      ? { key: "link", label: "通知链接地址", status: "ok",
          detail: `固定为 ${this.options.linkBase}(--public-url)` }
      : linkBase
        ? { key: "link", label: "通知链接地址", status: "ok",
            detail: `已从内网访问自学:${linkBase}`,
            suggestion: "建议启动时加 --public-url 固定,不依赖谁先登录" }
        : { key: "link", label: "通知链接地址", status: "warning",
            detail: "尚无可用地址:未配 --public-url,也还没有人从内网地址"
              + "访问过(回环地址不算——发给别人打不开)",
            suggestion: "启动加 --public-url http://<内网IP>:<端口>,"
              + "或先用内网地址打开一次本页面" });

    const projection = this.options.projection
      ? await this.options.projection.health() : undefined;
    items.push(!projection
      ? { key: "postgres", label: "PostgreSQL", status: "warning",
          detail: "未配置历史投影", suggestion: "任务仍可运行，但无跨生命周期历史" }
      : !projection.reachable
        ? { key: "postgres", label: "PostgreSQL", status: "error",
            detail: "数据库不可达", suggestion: projection.last_error }
        : projection.last_error
          ? { key: "postgres", label: "PostgreSQL", status: "warning",
              detail: "连接正常，但最近有投影写入失败", suggestion: projection.last_error }
          : { key: "postgres", label: "PostgreSQL", status: "ok",
              detail: "连接与投影正常" });

    const platform = this.effectivePlatformUrl();
    const platformCheck = platform
      ? await this.refreshDeliveryPlatformCheck() : undefined;
    items.push(!this.options.host
      ? { key: "git", label: "Git 交付", status: "warning",
          detail: "当前是纯会话模式", suggestion: "交付代码前启用内核模式与代码仓" }
      : !platform
        ? { key: "git", label: "Git 交付", status: "error",
            detail: "MR / 流水线服务未就绪",
            suggestion: "请部署维护人员检查平台适配服务" }
        : !platformCheck?.ready
          ? { key: "git", label: "Git 交付", status: "error",
              detail: platformCheck?.detail ?? "平台能力预检未完成",
              suggestion: platformCheck?.suggestion }
          : { key: "git", label: "Git 交付", status: "ok",
              detail: platformCheck.detail });

    const containerProbe = await this.probeTaskContainerToolchain();
    items.push(!this.options.prepush?.enabled
      ? { key: "prepush", label: "Build-Fix", status: "warning",
          detail: "当前部署未启用 Build-Fix" }
      : !containerProbe.ready
        ? { key: "prepush", label: "Build-Fix", status: "error",
            detail: "已启用，但任务构建环境未通过真实自检",
            suggestion: containerProbe.suggestion }
        : { key: "prepush", label: "Build-Fix", status: "ok",
            detail: "已启用；每次 push 前在独立容器执行编译与 UT，构建槽位 "
              + `${this.prePushBuildSlotCount()}` });

    if (!this.options.isolation) {
      items.push({ key: "container", label: "统一任务容器",
        status: this.options.host ? "error" : "warning",
        detail: "未启用任务容器",
        suggestion: "正式部署必须配置 --isolate-image；业务命令不会回退宿主" });
    } else {
      items.push(containerProbe.ready
        ? { key: "container", label: "统一任务容器", status: "ok",
            detail: containerProbe.detail }
        : { key: "container", label: "统一任务容器", status: "error",
            detail: containerProbe.detail, suggestion: containerProbe.suggestion });
    }

    const overall: SystemCheckStatus = items.some((item) => item.status === "error")
      ? "error" : items.some((item) => item.status === "warning") ? "warning" : "ok";
    return { checked_at: new Date().toISOString(), overall, items };
  }

  private project(task: TaskState, includeKnowledgeUsage = false): TaskSummary {
    this.refreshRequirementGraph(task);
    const record = task.notifyRecord;
    const progress = this.taskProgress(task);
    const summary = task.summary;
    const planReading = includeKnowledgeUsage
      ? readCurrentExecutionPlanReading({
          kernelRoot: this.options.host?.kernelRoot,
          workspace: task.cwd ?? summary.workspace,
          python: this.options.host?.python,
        })
      : undefined;
    const executionPlan = planReading?.plan;
    // 活方案对拍(审计 P0-1):定制链路上任何一环退化都必须走到人眼前。
    const planAlerts: string[] = [];
    if (planReading) {
      planAlerts.push(...planReading.kernel_warnings);
      for (const diag of executionPlan?.customization.diagnostics ?? []) {
        if (diag.code === "profile_invalid") {
          planAlerts.push(`⚠ ${diag.message}`);
        }
      }
      if (!planAlerts.length && summary.workflow_profile && executionPlan
          && executionPlan.customization.effective_source
            !== "compiled_final_plan") {
        // 实测(MFC-010)这种差异更多是"定格投影没落盘/没被读到",内核
        // 仍按平台默认+overrides 正常编译——不是 Agent 违规。措辞按
        // 事实说:方案投影缺失,给出实际来源;真要追责先核对两侧 hash。
        planAlerts.push(
          "⚠ 本任务下单时定格的工作流方案投影缺失或未被内核读到"
          + `(内核实际执行来源: ${executionPlan.customization.effective_source})`
          + "——通常为投影缺失而非执行偏离;若需确认,请核对任务详情中的方案指纹。");
      }
    }
    const contractStep = this.reviewContractStep(task, summary.waiting);
    // cloud_push_confirm 是 Cloud 自己生成的卡，不在内核 flow.json 里。
    // 之前这里只问内核要效果，结果这张卡永远没有 choice_effects：页面
    // 明明看得到“需要调整”，却不知道它是返工分支，只能错误提示用户
    // 去写自定义答复。云端原生卡的选项与服务端处理本就由本文件定义，
    // 在同一处把关闭/返工语义投影出去，历史待办读取时也能立即恢复。
    const choiceEffects: StepChoiceEffect[] =
      summary.waiting?.step === CLOUD_PUSH_CONFIRM_STEP
        ? [{
            key: "confirm",
            answers: [PUSH_CONFIRM_ACCEPT],
            allowsSourceEdit: false,
            handlesFeedback: false,
            closesFeedback: true,
          }, {
            key: "rework",
            answers: [PUSH_CONFIRM_REWORK],
            allowsSourceEdit: true,
            handlesFeedback: true,
            closesFeedback: false,
          }]
        : stepChoiceEffects(
            this.options.host?.kernelRoot,
            contractStep,
          );
    const recommendedView: "source" | "doc" | "chain" | "diff" | undefined =
      this.isRequirementAnalysis(task)
      ? "chain"
      // 云端原生步骤的检视面由云端自己钉死,不搭内核映射的兜底便车。
      : summary.waiting?.step === CLOUD_PUSH_CONFIRM_STEP
        ? "diff"
        : stepReviewSurface(
            this.options.host?.kernelRoot,
            contractStep,
          );
    // 排队位次投影:status=queued 时人第一想知道的是"排到哪了"。
    const queueIndex = summary.status === "queued"
      ? this.queue.indexOf(summary.id) : -1;
    const projectedDelivery = summary.delivery
      ? {
          ...summary.delivery,
          ...(summary.delivery.prepush ? {
            prepush_runtime: this.prePushRuntime(task),
          } : {}),
        }
      : undefined;
    const projected = {
      ...summary,
      delivery: projectedDelivery,
      // 开发助手占场时,"从当前现场恢复"是条死路(resume 会 409 让人
      // 去交还)——focus 必须知道占场事实才能指对路(MFC-029)。
      ...(task.assistantActive ? { assistant_engaged: true } : {}),
      ...(queueIndex >= 0 ? { queue_position: queueIndex + 1 } : {}),
      title: summary.title ?? taskTitle(summary.requirement),
      updated_at: summary.updated_at ?? summary.created_at,
      last_progress_at: summary.last_progress_at
        ?? summary.updated_at ?? summary.created_at,
      notify: record
        ? {
            delivered: record.delivered,
            attempts: record.attempts,
            last_error: record.last_error,
          }
        : undefined,
      progress,
      execution_plan: executionPlan,
      ...(planAlerts.length ? { execution_plan_alerts: planAlerts } : {}),
      token_usage: tokenUsageSnapshot(task.tokenUsage),
      waiting: summary.waiting
        ? {
            ...summary.waiting,
            ...(recommendedView ? { recommended_view: recommendedView } : {}),
            ...(choiceEffects.length ? {
              choice_effects: choiceEffects.map((effect) => ({
                key: effect.key,
                answers: effect.answers,
                allows_source_edit: effect.allowsSourceEdit,
                handles_feedback: effect.handlesFeedback,
                closes_feedback: effect.closesFeedback,
              })),
            } : {}),
          }
        : undefined,
      knowledge_usage: includeKnowledgeUsage
        ? knowledgeUsageSnapshot({
            workspace: task.summary.workspace,
            selectedSkills: summary.repository_skills,
            businessModules: summary.business_modules,
            engineeringKnowledge: summary.engineering_knowledge,
          })
        : undefined,
    };
    return { ...projected, focus: projectTaskFocus(projected) };
  }

  /** 知识足迹是 Cloud 观测旁路：阶段只读内核投影，写失败不影响任务。 */
  private knowledgeTrace(task: TaskState, cwd: string): KnowledgeTrace {
    return new KnowledgeTrace(
      join(task.summary.workspace, "knowledge-events.jsonl"),
      task.summary.id,
      cwd,
      () => this.taskProgress(task)?.step ?? "",
      this.options.log,
    );
  }

  private isRequirementAnalysis(task: TaskState): boolean {
    return (task.summary.repositories?.length ?? 0) > 1
      && !task.summary.parent_task_id;
  }

  private taskProgress(task: TaskState): TaskProgress | undefined {
    return this.readProgress(task);
  }

  private currentStepLabel(task: TaskState): string {
    return this.taskProgress(task)?.step ?? "";
  }

  /** WaitingRecord.step 是通知与页面共用的人话标题；流程契约必须读 pulse
   * 里的稳定步骤 ID。旧任务或纯会话模式没有 pulse 时才兼容原字段。 */
  private reviewContractStep(
    task: TaskState,
    waiting: Pick<WaitingRecord, "step"> | undefined,
  ): string | undefined {
    return this.taskProgress(task)?.step_id ?? waiting?.step;
  }

  /** Agent 写结构化投影，Markdown 仍是给人检视的正文。读失败只是不展示图。 */
  private refreshRequirementGraph(task: TaskState): void {
    if (!this.isRequirementAnalysis(task) || !task.cwd) return;
    const ticket = task.summary.ticket ?? task.summary.id;
    const path = join(task.cwd, ".mae-flow-work", ticket,
      "requirement-graph.json");
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
        repositories?: RequirementRepository[];
        dependencies?: RawRequirementDependency[];
      };
      const expected = task.summary.repositories ?? [];
      const repositories = Array.isArray(parsed.repositories)
        ? parsed.repositories.filter((item) => item && expected.includes(item.url))
            .map((item) => {
              const known = task.summary.requirement_graph?.repositories
                .find((candidate) => candidate.id === item.id
                  || candidate.url === item.url);
              return {
                ...item,
                assignee: known?.assignee,
                task_id: known?.task_id,
              };
            })
        : [];
      if (repositories.length !== expected.length) return;
      const ids = new Set(repositories.map((item) => item.id));
      // 新产物使用 dependent/prerequisite 消除歧义。旧版契约原本是
      // from 先于 to；若 reason 明确写了“A 依赖 B”，则以人工看到的
      // 说明为准，兼容早期模型把旧字段按自然语言填写的任务。
      const dependencies = Array.isArray(parsed.dependencies)
        ? parsed.dependencies.map((edge) => {
            if (edge.dependent && edge.prerequisite) return {
              from: edge.dependent, to: edge.prerequisite, reason: edge.reason,
            };
            const legacyFrom = edge.from ?? "";
            const legacyTo = edge.to ?? "";
            const fromRepository = repositories.find((item) => item.id === legacyFrom);
            const toRepository = repositories.find((item) => item.id === legacyTo);
            const reasonUsesNaturalDirection = dependencyStatement(
              edge.reason, fromRepository, toRepository);
            return reasonUsesNaturalDirection
              ? { from: legacyFrom, to: legacyTo, reason: edge.reason }
              : { from: legacyTo, to: legacyFrom, reason: edge.reason };
          }).filter((edge) =>
            ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to)
        : [];
      task.summary.requirement_graph = {
        stage: task.summary.requirement_graph?.stage ?? "analysis",
        repositories,
        dependencies,
      };
    } catch (error) {
      this.options.log?.(`任务 ${task.summary.id} 需求图读取失败: ${String(error)}`);
    }
  }

  /** 列表里的阶段轨道必须与现场看板同源，不能在 Web 复刻状态机。
   * pulse 给当前阶段/步骤，panel.html 给阶段顺序；pulse 未变化就复用缓存。 */
  private readProgress(task: TaskState): TaskProgress | undefined {
    if (!task.cwd) return undefined;
    const pulsePath = join(task.cwd, ".mae-flow-work", "panel-pulse.js");
    const panelPath = join(task.cwd, ".mae-flow-work", "panel.html");
    if (!existsSync(pulsePath) || !existsSync(panelPath)) return undefined;
    try {
      const pulseText = readFileSync(pulsePath, "utf-8");
      const milestonePath = join(task.cwd, ".mae-flow.json.build-milestones");
      const milestoneText = existsSync(milestonePath)
        ? readFileSync(milestonePath, "utf-8") : "";
      const progressSource = `${pulseText}\0${milestoneText}`;
      if (progressSource === task.progressPulse) return task.progressCache;
      const first = pulseText.indexOf("{");
      const last = pulseText.lastIndexOf("}");
      if (first < 0 || last <= first) return undefined;
      const pulse = JSON.parse(pulseText.slice(first, last + 1));
      const html = readFileSync(panelPath, "utf-8");
      const nodes = [...html.matchAll(
        /<span class="phase-node\s+(past|current|future)">([^<]+)<\/span>/g,
      )];
      const phases = nodes.map((match) => match[2].trim());
      const currentByClass = nodes.findIndex((match) => match[1] === "current");
      const currentPhase = String(pulse.phase ?? "").trim();
      const currentIndex = currentByClass >= 0
        ? currentByClass : phases.indexOf(currentPhase);
      if (phases.length === 0 || currentIndex < 0) return undefined;
      const milestone = String(pulse.step ?? "") === "build"
        ? latestBuildMilestone(milestoneText) : undefined;
      const progress: TaskProgress = {
        phases,
        current_index: currentIndex,
        current_phase: currentPhase || phases[currentIndex],
        step_id: pulse.step ? String(pulse.step) : undefined,
        step: pulse.step_title ? String(pulse.step_title) : undefined,
        revision: Number.isFinite(Number(pulse.revision))
          ? Number(pulse.revision) : undefined,
        ...(milestone ? { milestone } : {}),
      };
      task.progressPulse = progressSource;
      task.progressCache = progress;
      const now = new Date().toISOString();
      task.summary.last_progress_at = now;
      task.summary.updated_at = now;
      return progress;
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 进度摘要读取失败: ${String(error)}`);
      return undefined;
    }
  }

  eventLogPath(id: string): string {
    return join(this.tasks.get(id)!.summary.workspace, "events.jsonl");
  }

  /** 最新一轮推送前验证的事件日志路径(轮号最大者)。还没有任何轮目录
   * 时返回 undefined——SSE 端每拍重解析,等它出现;换轮(修复后新
   * HEAD 再验)时路径变化,SSE 端据此重置偏移从头放新一轮。
   * 用户点名的可观测性缺口:prepush 会话的事件一直落在轮目录里,
   * 但没有任何接口流出去,页面只有粗粒度 state。 */
  prePushEventLogPath(id: string): string | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const root = join(task.summary.workspace, "prepush");
    let best: { round: number; dir: string } | undefined;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const match = /^round-(\d+)-/.exec(entry.name);
        if (!match) continue;
        const round = Number(match[1]);
        if (!best || round > best.round) {
          best = { round, dir: join(root, entry.name) };
        }
      }
    } catch {
      return undefined; // prepush/ 还没建:本任务尚未走到推送前验证
    }
    return best ? join(best.dir, "events.jsonl") : undefined;
  }

  warmupEventLogPath(id: string): string | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const path = join(task.summary.workspace, "warmup", "events.jsonl");
    return existsSync(path) ? path : undefined;
  }

  /** 环境预热编译(观测旁路,fail-open):现场就绪即后台开跑,与主
   * Agent 的需求澄清并行——那段时间没人动代码,墙钟是免费的。任何
   * 失败只记账+留日志,绝不影响任务状态;"不许卡死"红线下它连等待
   * 都不引入。 */
  private startBaselineWarmup(task: TaskState, epoch: number): void {
    try {
      const configured = this.options.warmup;
      if (!configured || configured.enabled === false) return;
      // 原生路径要真容器;测试注入 runner 时放行。
      if (!configured.runner && !this.options.isolation) return;
      if (this.isRequirementAnalysis(task)) return; // 分析单没有可编译的仓
      if (!task.cwd || task.warmupActive) return;
      // 恢复续跑的单不预热:Agent 可能已经在写代码,此时编译的是
      // 半成品,报出来的"基线红"是冤案(内网实锤:恢复单把 Agent
      // 在写的 ProbeTestService 编了,报基线缺 import)。缓存反正
      // 已在此前的编译里焐热,恢复场景预热没有增量价值。
      if (task.resume) return;
      // 收过口的收据不重跑(重启恢复同理:缓存已经热了);
      // "running" 而无 finished_at 是崩溃残留,重跑并覆盖。
      if (task.summary.baseline_build?.finished_at) return;
      task.warmupActive = true;
      void this.performBaselineWarmup(task, epoch)
        .catch((error) => this.options.log?.(
          `任务 ${task.summary.id} 环境预热异常(fail-open): ${String(error)}`))
        .finally(() => { task.warmupActive = false; });
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 环境预热启动失败(fail-open): ${String(error)}`);
    }
  }

  private async performBaselineWarmup(
    task: TaskState,
    epoch: number,
  ): Promise<void> {
    const head = await runSafeWorktreeGitAsync(
      task.cwd!, ["rev-parse", "--verify", "HEAD"], { timeoutMs: 30_000 });
    const sha = String(head.stdout ?? "").trim();
    const startedAt = new Date().toISOString();
    if (head.status !== 0 || !sha) {
      task.summary.baseline_build = {
        status: "infrastructure_failure", sha: "",
        detail: `读取基线 HEAD 失败: ${String(head.stderr ?? "").slice(0, 200)}`,
        started_at: startedAt, finished_at: new Date().toISOString(),
      };
      this.persist(task);
      return;
    }
    // 工作区已有业务改动 = 这不再是基线,预热收据会把半成品的编译错
    // 扣到"环境/上游"头上——宁可不预热,不出冤案。不落收据:没跑
    // 就是没跑,不伪装成基础设施故障。
    const dirty = await this.prePushDirtyPaths(task);
    if (dirty.length) {
      this.options.log?.(
        `任务 ${task.summary.id} 工作区已有改动(${dirty.length} 处),`
        + "跳过基线预热——预热只评判基线代码");
      return;
    }
    task.summary.baseline_build = {
      status: "running", sha, started_at: startedAt,
    };
    this.persist(task);
    this.options.log?.(
      `任务 ${task.summary.id} 环境预热开跑(基线 ${sha.slice(0, 12)})`);
    const request: WarmupRunRequest = {
      taskId: task.summary.id, workspace: task.cwd!, sha,
    };
    let result: WarmupRunResult;
    try {
      result = await (this.options.warmup?.runner
        ? this.options.warmup.runner(request)
        : this.runCloudWarmupAgent(task, request));
    } catch (error) {
      result = {
        status: "infrastructure_failure",
        message: String(
          error instanceof Error ? error.message : error).slice(0, 300),
      };
    }
    if (!this.tasks.has(task.summary.id)) return;
    task.summary.baseline_build = {
      status: result.status,
      sha,
      ...(result.message ? { detail: result.message.slice(0, 600) } : {}),
      ...(result.build_command
        ? { build_command: result.build_command } : {}),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    };
    this.persist(task);
    void epoch; // 收据不锁 epoch:会话重建了,预热事实照样成立。
    this.options.log?.(
      `任务 ${task.summary.id} 环境预热收口: ${result.status}`
      + (result.message ? ` — ${result.message.slice(0, 120)}` : ""));
  }

  /** 预热原生执行器:编码容器里的独立 Pi 会话。与 prepush 同构但更简
   * ——不修复、不建容器、不产证据。同一容器两个会话不违反"两个容器
   * 不写同一工作区";此刻主 Agent 还在需求澄清,工作区没人写。 */
  private async runCloudWarmupAgent(
    task: TaskState,
    request: WarmupRunRequest,
  ): Promise<WarmupRunResult> {
    if (!task.cwd) throw new Error("环境预热缺少代码工作区");
    const agentDir = join(task.summary.workspace, "pi-agent");
    mkdirSync(agentDir, { recursive: true });
    this.hardenAgentGitBoundary(agentDir, task.cwd);
    // 同 prepush:build-notes 目录宿主预建,Agent 只写放行的那个文件。
    mkdirSync(join(task.cwd, ".mae-flow-work"), { recursive: true });
    const modelOverride = this.options.settings?.models() ?? {};
    writeFileSync(join(agentDir, "models.json"),
      JSON.stringify(modelOverride.json ?? this.options.modelsJson));
    const runRoot = join(task.summary.workspace, "warmup");
    mkdirSync(runRoot, { recursive: true });
    const eventLog = new EventLog(join(runRoot, "events.jsonl"));
    const transcript = new TranscriptStore(
      join(runRoot, "transcript.jsonl"), "main");
    const attemptTimeoutMs =
      this.options.warmup?.attemptTimeoutMs ?? 25 * 60_000;
    let timedOut = false;
    const driver = await CloudSession.create({
      taskId: `${task.summary.id}:warmup`,
      workspace: task.cwd,
      agentDir,
      hostSkillsDir: taskHostSkillsDir(this.options.dataDir, task.summary),
      knowledgeContext: task.summary.host_skills_pinned ? undefined : {
        repositories: task.summary.repositories ?? [],
        technologies: [...new Set((task.summary.repository_profiles ?? [])
          .flatMap((profile) => profile.technologies))],
        businessModuleIds: (task.summary.business_modules ?? [])
          .map((module) => module.id),
      },
      repositorySkillPaths: [],
      repositorySkillResources: [],
      knowledgeTrace: this.knowledgeTrace(task, task.cwd),
      provider: task.summary.model_choice?.provider
        ?? modelOverride.provider ?? this.options.provider,
      model: task.summary.model_choice?.model
        ?? modelOverride.model ?? this.options.model,
      eventLog,
      transcript,
      gate: new GateService({
        contract: createPrePushGateContract(this.options.contract),
        workspace: task.cwd,
        cwd: task.cwd,
        log: this.options.log,
        failClosed: Boolean(this.options.host),
      }),
      humanGate: task.humanGate,
      allowHumanQuestions: false,
      streamBashOutput: true,
      sessionId: "warmup",
      currentStep: () => "环境预热编译",
      compactAnchor: () =>
        `环境预热编译任务(基线 ${request.sha.slice(0, 12)})`,
      onTokenUsage: (sample) => this.recordTaskTokenUsage(task, sample),
      bashOperations: this.options.isolation
        ? {
            exec: async (command, dir, execOptions) =>
              (await this.activeTaskContainer(task))
                .exec(command, dir, execOptions),
          }
        : undefined,
      afterFileMutation: this.options.isolation
        ? (path) => {
          repairContainerMutationOwnership({
            workspace: task.cwd!,
            path,
            user: this.options.isolation?.user,
          });
        }
        : undefined,
      log: this.options.log,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      void driver.abort().catch(() => undefined);
    }, attemptTimeoutMs);
    timer.unref?.();
    try {
      let outcome = await driver.start(warmupMission(
        request, Math.round(attemptTimeoutMs / 60_000)));
      for (let correction = 0; correction < 2; correction += 1) {
        if (timedOut) {
          return {
            status: "infrastructure_failure",
            message: `环境预热超过 ${Math.ceil(attemptTimeoutMs / 60_000)} `
              + "分钟预算,已安全停止;不代表基线编译失败",
          };
        }
        if (outcome.status === "session_ended") {
          return {
            status: "infrastructure_failure",
            message: outcome.detail ?? outcome.reason ?? "预热会话异常结束",
          };
        }
        const report = parseWarmupReport(driver.finalReply());
        if (report) return report;
        // 报告缺失只是格式问题,给一次补交机会,别把整轮预热判死。
        outcome = await driver.continueWith(
          "预热尚未收口:请按任务说明输出单行 JSON 的 <warmup-result> 结构。");
      }
      return {
        status: "infrastructure_failure",
        message: "预热会话未产出合法的 <warmup-result> 报告",
      };
    } finally {
      clearTimeout(timer);
      driver.dispose();
    }
  }

  /** 行为摘要(只读旁路):事件流折叠成"此刻在干嘛/干了什么/有什么
   * 值得看"。每次现算,不留第二份状态;10~20 人规模下逐行读一遍
   * 事件账本毫无压力,先别上缓存。 */
  activity(id: string): ActivityView {
    const task = this.tasks.get(id)!;
    return buildActivity(readActivityEvents(this.eventLogPath(id)), {
      running: task.summary.status === "running",
    });
  }

  /** 内核现场面板文件(panel.html / panel-pulse.js / panel-stamp.js)。
   * 名字白名单由路由把守,这里只按任务工作区定位;不存在返回 undefined。 */
  panelFile(id: string, name: string): string | undefined {
    const task = this.tasks.get(id);
    if (!task?.cwd) return undefined;
    const file = join(task.cwd, ".mae-flow-work", name);
    return existsSync(file) ? file : undefined;
  }

  /** 检视产物的根:与 /artifacts 路由同一口径——批注重锚定回头读的
   * 必须是人当初圈的那份材料,两处口径分家就会出现"页面上有、重锚定
   * 说没有"。 */
  artifactRoot(id: string): string | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const panel = this.panelFile(id, "panel.html")
      ?? this.panelFile(id, "panel-pulse.js");
    return resolveArtifactRoot(
      task.summary.workspace, panel ? dirname(dirname(panel)) : undefined);
  }

  /** 当前 push 检视卡的代码比较。scope 只在服务端已经固化的两个锚中
   * 二选一，浏览器不能提交任意 Git ref；HEAD 一旦变化，旧链接立即
   * 失效并等新卡，避免人在旧 diff 上签新代码。 */
  async pushReviewDiff(
    id: string,
    scope: "changes" | "full",
  ): Promise<{ content: string; branch?: string; truncated?: boolean } | undefined> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const review = task.summary.delivery?.push_review;
    if (!task.cwd || !review
        || task.summary.waiting?.step !== CLOUD_PUSH_CONFIRM_STEP) {
      return undefined;
    }
    const snapshot = await deliveryChangeSnapshot(task.cwd);
    if (!snapshot || snapshot.head !== review.head_sha) return undefined;
    if (scope === "full") {
      // push 卡已经有权威 cwd，优先直接读它；纯会话/旧任务再沿用普通
      // 产物定位。不能因此改变 /artifacts 的兼容扫描口径。
      const root = resolveArtifactRoot(task.summary.workspace, task.cwd)
        ?? this.artifactRoot(id);
      return root ? readArtifactAsync(root, DIFF_NAME) : undefined;
    }
    return compareDeliveryRevisions(task.cwd, review.base_sha, review.head_sha);
  }

  private annotations(task: TaskState): AnnotationStore {
    return new AnnotationStore(
      join(task.summary.workspace, "annotations.jsonl"));
  }

  /** 批注靶子既可能是真实产物，也可能是任务快照里的需求原文。 */
  private annotationArtifactContent(
    task: TaskState,
    artifact: string,
  ): string | undefined {
    if (artifact === TASK_REQUIREMENT_ARTIFACT) {
      return task.summary.requirement;
    }
    const root = this.artifactRoot(task.summary.id);
    return root ? readArtifact(root, artifact)?.content : undefined;
  }

  private async annotationArtifactContentAsync(
    task: TaskState,
    artifact: string,
  ): Promise<string | undefined> {
    if (artifact === TASK_REQUIREMENT_ARTIFACT) {
      return task.summary.requirement;
    }
    const root = this.artifactRoot(task.summary.id);
    return root ? (await readArtifactAsync(root, artifact))?.content : undefined;
  }

  /** 单号来自内核状态文件;拿不到就退回任务号——不为抬头编内容。 */
  private ticketOf(task: TaskState): string {
    try {
      const statePath = join(task.cwd ?? "", ".mae-flow.json");
      if (task.cwd && existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        const ticket = String(state?.config?.["单号"] ?? "").trim();
        if (ticket) return ticket;
      }
    } catch {
      // 读不到就用任务号,批注照样送得出去。
    }
    return task.summary.id;
  }

  /** 批注清单(草稿 + 已送出)+ 每条的锚点现状。
   *
   * 已送出的不下架:人得看得见"这条提过没有、它动了没有"。而"动了没有"
   * 我们只报事实不下结论——锚点原文还在原处,就是它还没碰这里;原文不见
   * 了,就是这处已经被改动。是不是**照你说的**改的,由你看了再说,系统
   * 不替你判断"已采纳"(那是推断,不是事实)。
   *
   * 锚点检查是旁路:读不到材料按"还在"放行,绝不因为它挡住人送意见。
   */
  listAnnotations(id: string): {
    items: Annotation[];
    checks: AnchorCheck[];
    reply?: { texts: string[]; truncated: boolean };
  } {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    this.reconcileResolvedDecisionAnnotations(task);
    const items = this.annotations(task).visible();
    const checks = reanchor(items, (artifact) =>
      this.annotationArtifactContent(task, artifact));
    return { items, checks, reply: this.annotationReply(task, items) };
  }

  /** 工作台轮询专用异步读侧。先按 artifact 去重读取，再用同一份快照
   * 重锚定，避免 N 条代码批注触发 N 次完整 Git diff。 */
  async listAnnotationsAsync(id: string): Promise<{
    items: Annotation[];
    checks: AnchorCheck[];
    reply?: { texts: string[]; truncated: boolean };
  }> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    this.reconcileResolvedDecisionAnnotations(task);
    const items = this.annotations(task).visible();
    const contents = new Map<string, string | undefined>();
    await Promise.all([...new Set(items.map((item) => item.artifact))]
      .map(async (artifact) => {
        contents.set(artifact,
          await this.annotationArtifactContentAsync(task, artifact));
      }));
    const checks = reanchor(items, (artifact) => contents.get(artifact));
    return { items, checks, reply: this.annotationReply(task, items) };
  }

  /** 最后一批批注送出之后,主会话 AI 说过的话——原样带给面板。
   *
   * 刻意不做逐条对应:从自由文本里猜"第几段对应第几条",配错了就把
   * "AI 不同意"错挂到别的批注上,比不显示更害人(与"不推断已采纳"同根)。
   * 用户拍板走轻的:"就把 ai 的话展示出来就行",对不对应人自己看。 */
  private annotationReply(
    task: TaskState,
    items: Annotation[],
  ): { texts: string[]; truncated: boolean } | undefined {
    const sentTimes = items
      .map((item) => item.sent_at ? +new Date(item.sent_at) : NaN)
      .filter((at) => Number.isFinite(at));
    if (!sentTimes.length) return undefined;
    const lastSent = Math.max(...sentTimes);
    try {
      // 新事件是完整 ISO；旧事件是去掉 T/Z 的 UTC 裸串。只给旧格式补 Z，
      // 不能给新格式再拼一个 Z（会得到 ...ZZ，整批回话因此被过滤掉）。
      const instant = (ts: unknown) => {
        const raw = String(ts ?? "").trim();
        const candidate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
          ? `${raw.replace(" ", "T")}Z`
          : raw;
        return new Date(candidate).getTime();
      };
      const texts = new EventLog(join(task.summary.workspace, "events.jsonl"))
        .replay()
        .filter((event) => event.kind === "assistant_message"
          && String(event.sessionId ?? "main") === "main"
          && instant(event.ts) > lastSent)
        .map((event) => String(event.payload?.text ?? "").trim())
        .filter(Boolean);
      if (!texts.length) return undefined;
      // 面板不是会话流,给个够看的量就好;截了要说,别装完整。
      const kept = texts.slice(0, 8)
        .map((text) => text.length > 1500 ? text.slice(0, 1500) + "…" : text);
      return {
        texts: kept,
        truncated: texts.length > 8
          || texts.slice(0, 8).some((text) => text.length > 1500),
      };
    } catch {
      return undefined;   // 读不动就不带:旁路绝不挡住清单本身
    }
  }

  /** 发过的插话 + 送达与否。
   *
   * "我发了然后就没了,咋知道它消费了没"——发出去没有回执,等于让人对着
   * 空气说话。送达是可观测的:pi 把消息移出 steering 队列的那一刻,就是
   * 它进入模型上下文的那一刻。这里只报这个事实,不替人判断"它照做了没"
   * ——那要看它后面干了什么,判断权是人的。
   *
   * said:捎话之后模型说的话。用户 2026-08-22 原话:"有时我是问了个问题,
   * 有时我是下达了个指令,我看不到 agent 的回复"——只报"已读取"而不给
   * 下文,提问就永远没有答案,那这个框一半是废的。
   *
   * 口径仍是事实而非推断:**这些是你说完之后它说的话,不是"对你的回复"**。
   * 我们没法证明哪句是答你的(steer 在回合间隙送达,模型可能先把手头
   * 那段话说完),所以只按时间切片给到下一条插话为止,标签也这么写。 */
  listInterrupts(id: string): Array<{
    text: string; at: string; delivered: boolean;
    said: Array<{ text: string; at: string }>;
  }> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const pending = new Set([
      ...(task.driver?.pendingSteers() ?? []),
      ...(task.pendingMainSteers ?? []),
    ]);
    try {
      const rows: Array<{
        text: string; at: string; delivered: boolean;
        said: Array<{ text: string; at: string }>;
      }> = [];
      for (const event of new EventLog(
        join(task.summary.workspace, "events.jsonl"),
      ).replay()) {
        if (event.kind === "user_message"
            && event.payload?.via === "interrupt") {
          const text = String(event.payload?.text ?? "");
          rows.push({
            text, at: String(event.ts ?? ""),
            delivered: !pending.has(text), said: [],
          });
          continue;
        }
        // 还没有人捎过话,前面的说明与这个框无关,不收。
        if (event.kind !== "assistant_message" || !rows.length) continue;
        const said = String(event.payload?.text ?? "").trim();
        // 一条插话下面挂太多段就成了第二个过程记录,收前 4 段够看趋势;
        // 想看全的在「过程记录」里,那才是原话的正本。
        if (said && rows[rows.length - 1].said.length < 4) {
          rows[rows.length - 1].said.push({
            text: said, at: String(event.ts ?? ""),
          });
        }
      }
      return rows;
    } catch {
      return [];      // 读不动就当没有:旁路绝不挡住页面
    }
  }

  addAnnotation(id: string, input: AnnotationInput): Annotation {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (task.summary.status === "canceled") {
      throw new TaskControlError("任务已由用户停止，不能再新增批注");
    }
    return this.annotations(task).add(input);
  }

  dropAnnotation(
    id: string,
    annotationId: string,
    by: string,
    override = false,
  ): Annotation {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const annotations = this.annotations(task);
    const item = annotations.list().find((one) => one.id === annotationId);
    const adminOverride = override && !!item && item.author !== by;
    if (adminOverride) {
      this.assertCurrentWorkspaceReviewAdminOverride(task, item);
    }
    const dropped = annotations.drop(annotationId, by, adminOverride);
    // 拿掉一条未闭环批注也可能让本轮复检全部闭环,和 verify 同口径刷新。
    this.refreshWorkspaceReviewClosure(task);
    return dropped;
  }

  editAnnotation(
    id: string,
    annotationId: string,
    note: string,
    by: string,
  ): Annotation {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    return this.annotations(task).edit(annotationId, note, by);
  }

  /** 检视闭环的裁决半边:确认通过。override=管理员代闭环(死锁出路)。 */
  verifyAnnotation(
    id: string,
    annotationId: string,
    by: string,
    override = false,
  ): Annotation {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const annotations = this.annotations(task);
    const item = annotations.list().find((one) => one.id === annotationId);
    const adminOverride = override && !!item && item.author !== by;
    if (adminOverride) {
      this.assertCurrentWorkspaceReviewAdminOverride(task, item);
    }
    const loop = task.summary.delivery?.loop;
    const currentCycle = loop?.review_source === "workspace"
      && loop.workspace_review_recheck_required
      && (loop.workspace_review_annotation_ids ?? []).includes(annotationId);
    if (currentCycle) {
      if (item && item.author !== by && !adminOverride) {
        throw new AnnotationPermissionError(
          `这条是 ${item.author} 写的，只能由他裁决`,
        );
      }
      if (!item?.response
          || item.response.revision !== (item.rework ?? 0)) {
        throw new TaskControlError(
          "Agent 还没有对这条意见留下当前轮的逐条回应，暂时不能确认通过",
        );
      }
      if (item.response.outcome === "needs_clarification") {
        throw new TaskControlError(
          "Agent 说明这条意见仍有歧义，请补充说明并重新提交，不能直接当作已修复",
        );
      }
    }
    const verified = annotations.verify(annotationId, by, adminOverride);
    this.refreshWorkspaceReviewClosure(task);
    return verified;
  }

  /** 管理员代办不是一张全局“替别人签字”通行证，只解决当前 push 复检
   * 中作者暂时不在场造成的死锁。路由读到 admin 角色后仍必须在服务层
   * 重新核对全部当前事实；校验与 append 同步完成，避免页面两次点击间
   * 阶段已经切换却仍修改历史批注。管理员处理自己的意见走普通作者路径。 */
  private assertCurrentWorkspaceReviewAdminOverride(
    task: TaskState,
    item: Annotation,
  ): void {
    const loop = task.summary.delivery?.loop;
    const current = task.summary.status === "waiting_for_human"
      && task.summary.waiting?.step === CLOUD_PUSH_CONFIRM_STEP
      && loop?.kind === "review"
      && loop.review_source === "workspace"
      && loop.workspace_review_recheck_required === true
      && (loop.workspace_review_annotation_ids ?? []).includes(item.id);
    if (!current) {
      throw new TaskControlError(
        "管理员代办只限当前人工检视的 push 确认卡；任务阶段或复检批次已变化，请刷新后再检查",
      );
    }
    if (item.status !== "sent") {
      throw new TaskControlError(
        "管理员只能代办当前复检中已送达且尚未闭环的他人意见",
      );
    }
  }

  /** 裁决另半边:返工。锚点若已失效,趁重锚定结果在手边把它换成当前
   * 原文——不换的话,退回的草稿定位还是指着一段已经不存在的文字。
   * 异步读产物:代码批注锚在完整 diff 上,同步读等于在 HTTP 路由里
   * 现算全工作区 diff(内网实锤:大仓上一次就是主线程堵 20 秒)。 */
  async reopenAnnotation(
    id: string, annotationId: string, by: string,
  ): Promise<Annotation> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const store = this.annotations(task);
    const item = store.list().find((one) => one.id === annotationId);
    let update: { line?: number; anchor?: string } | undefined;
    if (item) {
      const content = await this.annotationArtifactContentAsync(
        task, item.artifact);
      const [check] = reanchor([item], () => content);
      if (check?.state === "moved") update = { line: check.line };
      if (check?.state === "gone" && check.now) {
        update = { line: item.line, anchor: check.now };
      }
    }
    return store.reopen(annotationId, by, update);
  }

  /** 把批注渲染成模型清单。ids 省略=全部待送出的。
   * 只渲染不落状态——决定卡要先给人看一眼再决定送不送。 */
  previewAnnotations(id: string, ids?: string[]): string {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const picked = this.pickDrafts(task, ids);
    return renderAnnotations(picked, this.ticketOf(task));
  }

  /** 送批注:走插话通道,当场发给正在跑的模型。
   * 送达之后才标 sent——先标后发会留下"提过了"的假账,而人会据此
   * 以为说过了。 */
  async sendAnnotations(id: string, ids?: string[], actor?: string): Promise<{
    sent: string[]; text: string;
  }> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (["completed", "canceled"].includes(task.summary.status)) {
      throw new TaskControlError(task.summary.status === "completed"
        ? "MR 已合入，任务已经结束，不能再提交批注"
        : "任务已由用户停止，不能再提交批注");
    }
    const picked = this.pickDrafts(task, ids, actor);
    const text = renderAnnotations(picked, this.ticketOf(task));
    const gap = task.summary.delivery?.evidence_gap;
    // 有证据缺口时不能把任何批注都武断地解释成“流水线日志”。用户也
    // 可能正在代码 diff 上提功能意见；那一类必须走 MR 检视修复，不能
    // 被塞进 CI 取证字段后悄悄丢失。只有批注落在流水线材料上才回灌。
    const pipelineEvidence = Boolean(gap?.missing_dimensions.length)
      && picked.every((item) => /(?:pipeline|build|compile|codecheck|\but\b|日志|流水线)/i
        .test(`${item.artifact}\n${item.file}`));
    if (gap?.missing_dimensions.length && pipelineEvidence) {
      const combined = [gap.human_evidence, text]
        .map((item) => String(item ?? "").trim()).filter(Boolean)
        .join("\n\n").slice(0, 12_000);
      gap.human_evidence = combined;
      gap.human_dimensions = [...new Set([
        ...(gap.human_dimensions ?? []), ...gap.missing_dimensions,
      ])];
      // 活的修复会话直接收到；尚未启动的队列使命原位补充；全缺证据
      // 停在 verifying 时则重新分诊并自动派修。三种状态共用一条批注账。
      if (task.summary.status === "running" && task.driver) {
        await task.driver.steer(text);
      } else if (["queued", "running"].includes(task.summary.status)
          && task.mission) {
        task.mission += "\n\n- 人工刚从工作台回灌的流水线报错原文：\n"
          + text;
      } else if (task.summary.status === "verifying") {
        task.summary.detail = "已收到人工流水线报错，正在自动恢复修复分诊";
        task.summary.delivery!.waiting_on = undefined;
        const loop = task.summary.delivery?.loop;
        if (loop?.kind === "ci" && loop.last_sha === gap.sha) {
          // 部分证据派修后，会话可能在人工回灌到达前因“缺信息且无新
          // 提交”停下。同 SHA 刹车防的是拿同一份输入空转，不该挡住
          // 新到的人类证据。把它作为原修复轮的续段重开，round 不加一。
          loop.last_sha = undefined;
          loop.round = Math.max(0, loop.round - 1);
          loop.state = "verifying";
          loop.diagnosis = undefined;
        }
        const max = task.summary.repair_rounds
          ?? this.options.settings?.runtime().repair_rounds
          ?? this.options.delivery?.repairRounds;
        const sha = gap.sha;
        const log = gap.failure_log ?? "";
        setImmediate(() => this.bypass(task, "人工流水线证据回灌",
          this.dispatchCiRepair(task, sha, log, max, task.controlEpoch)));
      } else {
        throw new NotFoundError(
          `任务 ${id} 当前是 ${task.summary.status}，不能恢复流水线修复`);
      }
      this.annotations(task).markSent(
        picked.map((item) => item.id), "pipeline_evidence");
      this.persist(task);
      return { sent: picked.map((item) => item.id), text };
    }
    if (this.hasOpenMergeRequest(task)) {
      return this.sendMergeRequestReview(task, picked, text);
    }
    // 任务正等人决定时,插话通道不可用——但检视人(批注作者≠决定人)
    // 在这窗口里必须有合法提交路径,否则责任人一放行意见就落空
    // (MFC-022)。此时先把意见转成团队事实(sent,阻塞关闭检视),
    // 正文由下一次决定的 continuation 送达 Agent。
    if (task.summary.status === "waiting_for_human") {
      this.annotations(task).markSent(
        picked.map((item) => item.id), "queued_decision");
      this.persist(task);
      return { sent: picked.map((item) => item.id), text };
    }
    await this.interrupt(id, text);
    this.annotations(task).markSent(picked.map((item) => item.id), "interrupt");
    return { sent: picked.map((item) => item.id), text };
  }

  /** MR 已经存在但尚未合入时，本地批注不是“给旧会话插句话”，而是
   * 当前 MR 的下一轮修改要求。运行中的修复会话直接合并处理；没有活
   * 会话时开启内核正式的 review 轮。始终复用原分支、原 MR。 */
  private async sendMergeRequestReview(
    task: TaskState,
    picked: Annotation[],
    text: string,
  ): Promise<{ sent: string[]; text: string }> {
    // await_merge 的页面与平台“刚刚点合入”可能竞态。能查询到终态就
    // 先如实收口；平台不支持门禁契约则 fail-open，后续 push 仍会以
    // 远端事实失败，不拿一次查询抖动阻塞人的意见。
    if (["await_merge", "verifying"].includes(task.summary.status)) {
      const view = await this.fetchGates(task);
      if (view?.mrState === "merged" || view?.mrState === "closed") {
        this.settleMergeState(task, view.mrState, view.sourceSha);
        throw new TaskControlError(view.mrState === "merged"
          ? "MR 已合入，当前任务已经结束；如需继续修改，请创建后续任务"
          : "MR 已关闭，不能再向原 MR 提交修改；请重新打开 MR 或创建后续任务");
      }
    }
    if (!this.hasOpenMergeRequest(task)) {
      throw new TaskControlError(
        "当前 MR 已结束，不能再向原分支提交检视修改");
    }

    const delivered = this.mergeRequestReviewPrompt(text, picked);
    // prepush 是另一只专项 Agent，也会暂时占用 task.driver。把功能检视
    // steer 给它会与“只做编译/UT”使命打架。安全中止旧验证（不清现场），
    // 换代 epoch 让旧回调失去写状态权，再开正式 review 轮；新轮结束后
    // 会从头对新 HEAD 做 prepush，证据不会复用旧结果。
    if (task.prepushActive) {
      task.controlEpoch += 1;
      const active = task.prepushActive;
      task.prepushAbort?.abort();
      await active.catch(() => undefined);
      if (task.prepushActive === active) task.prepushActive = undefined;
    }

    if (task.summary.status === "running") {
      // status 会在 launch 入口先切 running，driver 稍后才就绪。这个短窗
      // 不能误判成“没有会话”再开第二只 Agent；先等就绪，仍没就绪就
      // 持久化到 pendingMainSteers，由 launch 在 start 后补送。
      const deadline = Date.now() + 10_000;
      while (task.summary.status === "running" && !task.driver
          && Date.now() < deadline) {
        await new Promise((tick) => setTimeout(tick, 25));
      }
      if (task.summary.status === "running" && task.driver) {
        await task.driver.steer(delivered);
      } else if (task.summary.status === "running") {
        task.pendingMainSteers = [...new Set([
          ...(task.pendingMainSteers ?? []), delivered,
        ])];
      } else {
        // 等待 driver 的几毫秒里旧会话可能刚好收口。此时再走一次本方法
        // 的状态分支，仍只会开一轮正式 review，不会与旧 writer 重叠。
        return this.sendMergeRequestReview(task, picked, text);
      }
      this.rememberWorkspaceReview(task, picked);
      this.persist(task);
    } else if (task.summary.status === "queued" && task.mission) {
      // 还没拿到并发槽，直接把意见并进同一份持久使命；不会多起一轮。
      task.mission += `\n\n${delivered}`;
      this.rememberWorkspaceReview(task, picked);
      this.persist(task);
    } else if (task.summary.status === "waiting_for_human") {
      throw new TaskControlError(
        "Agent 正在等你回答当前问题。这批批注已保存，请在当前决定卡提交；系统会把批注一并交给 Agent");
    } else if (["paused", "pausing"].includes(task.summary.status)) {
      throw new TaskControlError(
        "任务当前已暂停，批注已经保存；恢复任务后即可提交给 Agent 继续修改");
    } else {
      // 终止旧 SHA 的流水线/合入监控写权限，平台上的旧流水线可以自然
      // 跑完，但它再也不能把新开的检视轮状态覆盖回去。
      task.controlEpoch += 1;
      this.dispatchWorkspaceReviewRepair(task, picked, text);
    }
    this.annotations(task).markSent(
      picked.map((item) => item.id), "review_repair");
    return { sent: picked.map((item) => item.id), text };
  }

  private hasOpenMergeRequest(task: TaskState): boolean {
    const delivery = task.summary.delivery;
    if (!delivery?.mr_url) return false;
    if (["completed", "canceled"].includes(task.summary.status)) {
      return false;
    }
    return !String(delivery.mr_state ?? "").startsWith("已合入")
      && delivery.mr_state !== "已关闭";
  }

  private mergeRequestReviewPrompt(text: string, annotations: Annotation[]): string {
    return [
      "[MR 本地检视 · 用户已明确提交]",
      "这批意见是当前 MR 的修改要求，优先级高于正在进行的流水线修复；不要另起分支或 MR。",
      text,
      "逐条核对并处理：要求明确就直接修改，不要再问一次‘是否接纳’；只有语义确实不清、不同理解会造成不同代码结果时才举卡，并把歧义说具体。",
      workspaceReviewReceiptInstructions(annotations),
      "若本轮同时有流水线问题，两类问题合并进同一次 commit；完成后回到原使命收口。不要自行 push，Cloud 宿主会统一推送原 MR 分支并重新验证。",
    ].filter(Boolean).join("\n\n");
  }

  /** 人工意见与正在运行的 CI 修复并流时，仍要留下独立的回检账。
   * “责任人让 Agent 继续”只会推进修改，不能覆盖意见作者的裁决权。 */
  private rememberWorkspaceReview(
    task: TaskState,
    annotations: Annotation[],
  ): void {
    const delivery = task.summary.delivery;
    if (!delivery) return;
    const max = task.summary.repair_rounds
      ?? this.options.settings?.runtime().repair_rounds
      ?? this.options.delivery?.repairRounds;
    const loop = delivery.loop
      ?? (delivery.loop = { round: 0, max, state: "repairing" as const });
    const startsNewCycle = !loop.workspace_review_recheck_required;
    loop.kind = "review";
    loop.review_source = "workspace";
    loop.workspace_review_pending = true;
    loop.workspace_review_recheck_required = true;
    loop.workspace_review_annotation_ids = [...new Set([
      ...(loop.workspace_review_annotation_ids ?? []),
      ...annotations.map((item) => item.id),
    ])];
    if (startsNewCycle || !loop.review_ids) {
      loop.review_ids = `workspace:${annotations.map((item) =>
        `${item.id}:r${item.rework ?? 0}`).sort().join(",")}:${Date.now()}`;
    }
    // 意见可能并入正在跑的 CI/冲突会话，不一定经过独立 review 派单。
    // 因此材料必须在登记 review cycle 的同一处落盘，不能只靠
    // dispatchWorkspaceReviewRepair 的旁支写文件。
    try {
      const reviewsDir = join(task.summary.workspace, "reviews");
      mkdirSync(reviewsDir, { recursive: true });
      const wanted = new Set(loop.workspace_review_annotation_ids ?? []);
      const current = this.annotations(task).list().filter((item) =>
        wanted.has(item.id));
      writeFileSync(join(reviewsDir, "local-annotations.json"), JSON.stringify({
        task_id: task.summary.id,
        mr_url: delivery.mr_url,
        submitted_at: new Date().toISOString(),
        annotations: current,
      }, null, 2));
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 本地检视材料落盘失败(使命正文仍可用): ${String(error)}`);
    }
    // 同一任务上一轮的回执不能被下一轮误消费。删除的是仓外派生文件，
    // append-only 批注账里的历史回应仍完整保留。
    if (startsNewCycle) {
      try {
        rmSync(join(task.summary.workspace, "reviews", "local-receipts.json"),
          { force: true });
      } catch { /* 下轮缺文件会明确停下，不拿清理故障挡住意见送达 */ }
    }
  }

  /** 消费本地检视 Agent 的结构化逐条回执。机器回应只写回批注账，不
   * 自动 verify；作者仍要看新代码后亲自裁决。 */
  private async consumeWorkspaceReviewReceipts(task: TaskState): Promise<{
    ok: boolean;
    detail?: string;
  }> {
    const loop = task.summary.delivery?.loop;
    if (loop?.review_source !== "workspace") return { ok: true };
    const wanted = new Set(loop.workspace_review_annotation_ids ?? []);
    if (!wanted.size) return { ok: true }; // 只有整体说明，由最终总检卡闭环
    const expected = this.annotations(task).list().filter((item) =>
      wanted.has(item.id) && item.status === "sent");
    if (!expected.length) return { ok: true };
    const path = join(task.summary.workspace, "reviews", "local-receipts.json");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf-8"));
    } catch (error) {
      return {
        ok: false,
        detail: `Agent 没有留下逐条检视回执（缺 ${expected.map((item) => item.id)
          .join("、")}）。已停在现场，不能拿总体回复冒充逐条闭环。`,
      };
    }
    const parsed = parseWorkspaceReviewReceipts(raw, expected);
    if (parsed.errors.length || parsed.missing_ids.length
        || parsed.unexpected_ids.length) {
      const facts = [
        parsed.missing_ids.length
          ? `缺少 ${parsed.missing_ids.join("、")}` : "",
        parsed.unexpected_ids.length
          ? `多出 ${parsed.unexpected_ids.join("、")}` : "",
        ...parsed.errors,
      ].filter(Boolean);
      return {
        ok: false,
        detail: `逐条检视回执不完整：${facts.join("；")}。已停下等待明确处理。`,
      };
    }
    const sha = task.cwd ? (await this.prePushRevision(task)).sha : undefined;
    for (const receipt of parsed.receipts) {
      this.annotations(task).respond(receipt.annotation_id, {
        revision: receipt.revision,
        outcome: receipt.outcome,
        summary: receipt.summary,
        evidence: receipt.evidence ?? [],
        fixed_sha: sha,
      });
    }
    const clarification = parsed.receipts.filter((receipt) =>
      receipt.outcome === "needs_clarification");
    if (clarification.length) {
      return {
        ok: false,
        detail: `Agent 对 ${clarification.map((item) => item.annotation_id)
          .join("、")} 仍需你补充说明。逐条回应已经保留，请修改对应批注后重新提交；系统不会猜着改，也不会进入 push。`,
      };
    }
    return { ok: true };
  }

  /** 人工意见修复完以后，意见作者是唯一裁决人。最后一条点通过时只
   * 解除“逐条意见未闭环”这一层，不替任务责任人点击最终 push 卡。
   * 两层职责分开，既不会被责任人越权代签，也不会因为旧卡状态互相
   * 覆盖而出现“都通过了仍提交不了”。 */
  private refreshWorkspaceReviewClosure(task: TaskState): void {
    const loop = task.summary.delivery?.loop;
    if (loop?.review_source !== "workspace"
        || !loop.workspace_review_recheck_required) return;
    const wanted = new Set(loop.workspace_review_annotation_ids ?? []);
    if (!wanted.size) return; // 只有整体说明，由最终总检卡闭环
    const pending = this.annotations(task).list().filter((item) =>
      wanted.has(item.id)
      && (item.status === "draft" || item.status === "sent"));
    if (task.summary.waiting?.step === CLOUD_PUSH_CONFIRM_STEP) {
      task.summary.detail = pending.length
        ? `等待 ${pending.length} 条检视意见由提出人确认`
        : "检视意见已全部闭环，等待责任人确认推送";
      this.persist(task);
    }
    if (pending.length || task.summary.waiting?.step !== CLOUD_PUSH_CONFIRM_STEP) {
      return;
    }
    const account = task.summary.luban_account;
    const notifier = this.options.notifier;
    if (!account || !notifier) return;
    const cycle = createHash("sha256")
      .update(loop.review_ids ?? [...wanted].sort().join(","))
      .digest("hex").slice(0, 16);
    this.bypass(task, "检视意见全部闭环通知", notifier.notifyOutcome({
      taskId: task.summary.id,
      account,
      status: `review-ready-to-push:${cycle}`,
      summary: "本轮人工检视意见已全部由提出人确认，可以打开任务完成最终确认并推送。",
      link: personalTaskLink(
        this.notificationLinkBase(), account, task.summary.id),
    }));
  }

  private pickDrafts(
    task: TaskState,
    ids?: string[],
    actor?: string,
  ): Annotation[] {
    const allDrafts = this.annotations(task).drafts();
    const drafts = actor
      ? allDrafts.filter((item) => item.author === actor) : allDrafts;
    if (!ids?.length) {
      if (!drafts.length) throw new NotFoundError("没有待送出的批注");
      return drafts;
    }
    const wanted = new Set(ids);
    const picked = drafts.filter((item) => wanted.has(item.id));
    if (picked.length !== wanted.size) {
      throw new NotFoundError(actor
        ? "有批注不存在、已经送出，或不是你写的"
        : "有批注不存在或已经送出去了");
    }
    return picked;
  }

  /** 决定卡与“主动送批注”不是同一种提交语义。
   *
   * 页面打开后，批注可能先通过插话通道从 draft 变成 sent；随后提交的
   * 决定仍携带旧 ID。它已经送达，不该重复发送，更不能因此拦住本次新写
   * 的补充说明。存在但已 sent/verified/dropped 的条目幂等跳过；真正不
   * 存在的 ID 仍拒绝，避免把跨任务或损坏的引用静默吞掉。 */
  private pickDecisionDrafts(
    task: TaskState,
    ids: string[],
    actor?: string,
  ): Annotation[] {
    const wanted = new Set(ids);
    const items = this.annotations(task).list();
    const found = new Set(items.map((item) => item.id));
    if ([...wanted].some((id) => !found.has(id))) {
      throw new NotFoundError("有批注不存在，请刷新后重试");
    }
    if (actor && items.some((item) => wanted.has(item.id)
        && item.status === "draft" && item.author !== actor)) {
      throw new AnnotationPermissionError("只能随决定提交自己写的批注");
    }
    return items.filter((item) =>
      item.status === "draft" && wanted.has(item.id)
        && (!actor || item.author === actor));
  }

  /** MR/流水线连接是部署基础设施，管理员页面只读自检、不暴露地址。 */
  private effectivePlatformUrl(): string | undefined {
    return this.options.delivery?.platformUrl;
  }

  private effectiveDefaultRepo(): string | undefined {
    return this.options.host?.repoPath;
  }

  /** 生效的提交信息规范(设置层压部署层)。平台钩子按正则拒收不合规
   * 提交(内网实测),这条规矩要在每个会话开场就给——包括修复会话。 */
  private effectiveCommitConvention(): string | undefined {
    const text = this.options.commitConvention;
    const trimmed = String(text ?? "").trim();
    return trimmed || undefined;
  }

  /** 当前生效的 models.json 同形内容(设置层压部署层)——
   * 下单模型选项和校验共用这一个口径。 */
  private activeModelsJson(): Record<string, unknown> {
    return (this.options.settings?.models().json ?? this.options.modelsJson
      ?? {}) as Record<string, unknown>;
  }

  /** 当前生效的视觉角色。角色必须指向 models.json 中明确声明支持图片
   * 的模型；配置漂移时宁可不暴露 Tool，也不把图片误发给文本模型。 */
  private activeVisionChoice(): VisionModelChoice | undefined {
    const choice = this.options.settings?.models().vision ?? this.options.vision;
    if (!choice?.provider || !choice?.model) return undefined;
    const spec = (this.activeModelsJson() as {
      providers?: Record<string, { models?: Array<{
        id?: string; input?: string[];
      }> }>;
    }).providers?.[choice.provider]?.models?.find((item) =>
      String(item?.id ?? "") === choice.model);
    return Array.isArray(spec?.input) && spec.input.includes("image")
      ? choice : undefined;
  }

  private taskVision(task: TaskState) {
    const choice = this.activeVisionChoice();
    return choice ? {
      choice,
      cacheDir: join(task.summary.workspace, "vision-cache"),
      timeoutMs: 45_000,
    } : undefined;
  }

  /** 管理页的一键实测：系统色块图 → 当前视觉模型角色 → 语义校验。
   * 不创建任务、不读取业务图片、不修改配置。 */
  async testVisionCapability(): Promise<VisionProbeResult> {
    const choice = this.activeVisionChoice();
    if (!choice) {
      return {
        status: "failed",
        provider: this.options.settings?.models().vision?.provider
          ?? this.options.vision?.provider ?? "",
        model: this.options.settings?.models().vision?.model
          ?? this.options.vision?.model ?? "",
        latency_ms: 0,
        error: "图片识别模型未完整配置，或模型未声明支持 image 输入",
      };
    }
    return probeVisionCapability({
      modelsJson: this.activeModelsJson(),
      choice,
      timeoutMs: 45_000,
    });
  }

  /** 发起页只读预匹配；不创建 task id、不写任务现场、不返回正文。 */
  previewLaunchKnowledge(
    input: LaunchKnowledgePreviewInput,
  ): LaunchKnowledgePreview {
    return previewLaunchKnowledge(this.options.dataDir, input);
  }

  /** 下单表单的数据源。
   *
   * 口径(用户 2026-08-18 拍板,按内网实战定的):
   * - **交付仓必填**,没有"默认仓"这回事——一个部署要服务很多个仓,
   *   默认仓只会让人漏看一眼就把单下错地方;
   * - **模型不给选**:管理员统一配一个,所有人用同一个。选择权留给
   *   人只会制造"为什么他的比我快"的困惑,也让成本不可控;
   * - 交付方式与修复轮预算仍按单可选(前者决定走哪条链,后者是钱);
   *   交付方式的选项**现读内核 flow.json**,前端与本文件都不另抄一份。
   *
   * `model` 字段仍然返回当前生效的那一个——不是给人选,是给界面显示
   * "这单会用谁跑",让人心里有数。 */
  launchOptions(): {
    /** 当前生效的模型(展示用,下单表单不提供选择)。 */
    model?: { provider: string; model: string };
    /** 当前默认修复轮:数字=手刹上限;缺席=不限轮(默认形态)。 */
    repair_rounds?: number;
    repo: { enabled: boolean; required: boolean };
    /** 单号/基线分支:内核配置确认要的两项事实,表单下单就收——
     * 和交付方式同一逻辑,不让模型开工后逐项来问。 */
    ticket: { enabled: boolean; required: boolean };
    baseline: { enabled: boolean; default: string };
    /** 交付方式选项:**现读内核 flow.json**,不在 TS 侧另抄一份。
     * 空数组=读不到内核定义,表单就别摆出选择(下单不预选,卡到时
     * 老老实实问人)。 */
    workflows: Array<
      { key: string; label: string; description?: string;
        steps?: number; acks?: number }>;
    /** 阶段内可组合项与能力偏好，和 Agent 消费的是同一份内核目录。 */
    execution_playbooks: ExecutionPlaybookOption[];
    /** 专业编辑器的精确标准基线；缺席时隐藏定制入口，不影响普通下单。 */
    workflow_standard?: WorkflowStandardSnapshot;
    /** 显式发布的业务模块目录。这里只给下单所需摘要，不含知识正文。 */
    business_modules: Array<{
      id: string;
      name: string;
      description: string;
      owner: string;
      repositories: string[];
      revision: number;
      assets: number;
      knowledge: Array<{
        id: string;
        title: string;
        summary: string;
        when_to_use: string;
        form: "document" | "skill" | "rule" | "example";
        repositories: string[];
        version: number;
      }>;
      updated_at: string;
    }>;
    engineering_knowledge: Array<{
      id: string; title: string; summary: string; when_to_use: string;
      form: "document" | "rule" | "example";
      business_module_ids: string[]; repositories: string[];
      technologies: string[];
    }>;
    /** 团队管理的 Skill 形态知识目录；正文不随下单接口返回。 */
    team_skills: HostSkillShelfEntry[];
    /** 服务级缺的配置(管理员去补)。非空=不给下单。 */
    blockers: Array<{ key: string; label: string; where: "admin" | "me" }>;
    /** 本部署要不要这两把个人令牌(由形态决定,见下方注释)。 */
    needs: { git_token: boolean; luban_token: boolean };
  } {
    const active = this.activeModelChoice();
    const blockers: Array<
      { key: string; label: string; where: "admin" | "me" }> = [];
    let businessModules: Array<{
      id: string; name: string; description: string; owner: string;
      repositories: string[]; revision: number; assets: number;
      knowledge: Array<{
        id: string; title: string; summary: string; when_to_use: string;
        form: "document" | "skill" | "rule" | "example";
        repositories: string[]; version: number;
      }>;
      updated_at: string;
    }> = [];
    let engineeringKnowledge: ReturnType<typeof publishedEngineeringKnowledge>
      = [];
    let teamSkills: HostSkillShelfEntry[] = [];
    const workflowCatalogRoot = this.options.host?.kernelRoot
      ?? this.options.workflowCatalogRoot;
    const executionPlaybooks = readExecutionPlaybookOptions(
      workflowCatalogRoot);
    const workflowStandard = readWorkflowStandardSnapshot(
      workflowCatalogRoot);
    try {
      businessModules = listBusinessModules(this.options.dataDir).modules
        .filter((module) => module.status === "active")
        .map((module) => {
          const knowledge = module.assets
            .filter((asset) => asset.status === "published")
            .map((asset) => ({
              id: asset.id,
              title: asset.title,
              summary: asset.summary,
              when_to_use: asset.when_to_use,
              form: asset.form,
              repositories: [...asset.repositories],
              version: asset.version,
            }));
          return {
            id: module.id,
            name: module.name,
            description: module.description,
            owner: module.owner,
            repositories: module.repositories,
            revision: module.revision,
            assets: knowledge.length,
            knowledge,
            updated_at: module.updated_at,
          };
        });
    } catch (error) {
      // 模块知识是可选上下文；目录损坏要告警，但不能让所有人无法下单。
      this.options.log?.(`[business-modules] 下单目录读取失败(fail-open): ${error}`);
    }
    if (this.options.requirementDisabled) {
      blockers.push({ key: "requirement_disabled", where: "admin",
        label: "本部署为问题流专用(--issue-only),需求流程未启用;"
          + "处理问题请前往「问题处理」页" });
    }
    try {
      engineeringKnowledge = publishedEngineeringKnowledge(this.options.dataDir);
    } catch (error) {
      this.options.log?.(
        `[engineering-knowledge] 下单目录读取失败(fail-open): ${String(error)}`);
    }
    try {
      teamSkills = listHostSkillShelf(this.options.dataDir).skills
        .filter((skill) => skill.loadable
          && skill.nature !== "unclassified");
    } catch (error) {
      this.options.log?.(
        `[team-skills] 下单目录读取失败(fail-open): ${String(error)}`);
    }
    // 每条缺项**只在它真会咬人时才拦**:纯会话形态(不接代码仓)拦
    // Git 令牌毫无道理,没接通知端点拦通知令牌也一样——一刀切的门禁
    // 会把用不上那件东西的部署一起挡在门外。
    if (!active) {
      blockers.push({ key: "model", where: "admin",
        label: "模型网关未配置(管理页 → 模型网关,填写地址、API Key 和模型名称)"
          + ";没有它任何任务都跑不起来" });
    }
    if (this.options.host && !this.effectivePlatformUrl()) {
      blockers.push({ key: "platform", where: "admin",
        label: "交付基础设施未就绪；代码暂时无法交付，请联系部署维护人员检查 MR / 流水线服务" });
    }
    if (this.options.host && this.deliveryPlatformCheck
        && !this.deliveryPlatformCheck.ready) {
      blockers.push({ key: "platform_unhealthy", where: "admin",
        label: `交付平台预检未通过：${this.deliveryPlatformCheck.detail}` });
    }
    if (this.options.host && this.options.deploymentRuntime?.status === "error") {
      blockers.push({ key: "deployment_runtime", where: "admin",
        label: `部署自检未通过：${this.options.deploymentRuntime.detail}` });
    }
    return {
      model: active,
      repair_rounds: this.options.settings?.runtime().repair_rounds
        ?? this.options.delivery?.repairRounds,
      // 没接内核模式=任务不碰代码仓,表单别摆出输入框骗人。
      // 钉死单仓部署(serve --repo,repoPinned)不收逐单仓:字段直接
      // 不启用,别让人填一个注定被拒/被换掉的地址(MFC-024;假平台
      // 部署曾因此推错仓)。required 与 create() 的实际校验同口径——
      // 曾经 UI 宣称必填、API 却放行空白,required 成了摆设。
      repo: {
        enabled: !!this.options.host && !this.options.host.repoPinned,
        required: !!this.options.host && !this.options.host.repoPath,
      },
      ticket: {
        enabled: !!this.options.host,
        required: !!this.options.host && !this.options.host.repoPath,
      },
      baseline: { enabled: !!this.options.host, default: "master" },
      workflows: workflowChoices(workflowCatalogRoot),
      execution_playbooks: executionPlaybooks,
      workflow_standard: workflowStandard,
      business_modules: businessModules,
      engineering_knowledge: engineeringKnowledge
        .map((item) => ({
          id: item.id,
          title: item.title,
          summary: item.summary,
          when_to_use: item.when_to_use,
          form: item.form as "document" | "rule" | "example",
          business_module_ids: item.business_module_ids,
          repositories: item.repositories,
          technologies: item.technologies,
        })),
      team_skills: teamSkills,
      blockers,
      needs: {
        // 个人令牌该不该要,由部署形态决定(同上:只拦真会咬人的)。
        git_token: !!this.options.host,
        // 假小鲁班不索令牌(没人消费它);切了真端点要求立刻恢复。
        // 判定在 Notifier 里,跟着生效端点走——内网 agent 实测在演示
        // 形态被"先配令牌"挡住,那是一道谁也过不去也不必过的假门。
        luban_token: this.options.notifier?.needsPersonalToken() ?? false,
      },
    };
  }

  /** 当前生效的模型:设置层显式配的 > models.json 里的第一个 >
   * 部署参数。**自动兜底那一步是有意的**——管理员贴完 models.json
   * 就能用,不必再手打一遍 provider/model(实测:服务起来后表单是空的,
   * 人不知道还差一步)。 */
  private activeModelChoice(): { provider: string; model: string } | undefined {
    const override = this.options.settings?.models() ?? {};
    const providers = (this.activeModelsJson() as {
      providers?: Record<string, { models?: Array<{ id?: string }> }>;
    }).providers ?? {};
    const firstProvider = Object.keys(providers)[0];
    const provider = override.provider || this.options.provider || firstProvider;
    const listed = (providers[provider ?? ""]?.models ?? [])
      .map((item) => String(item?.id ?? "")).filter(Boolean);
    const model = override.model || listed[0] || this.options.model;
    return provider && model ? { provider, model } : undefined;
  }

  /**
   * 用户在下单页显式触发的只读目录发现。令牌把“谁、哪些仓、哪条
   * 基线、当时看到的 Skill”绑在一起；创建任务只交所选 id，不接受
   * 浏览器自报路径或正文。
   */
  async scanRepositorySkills(input: {
    repositories: string[];
    baseline?: string;
    account?: string;
  }): Promise<RepositorySkillCatalogResponse> {
    if (!this.options.host) throw new Error("本部署未接代码仓，无法读取仓内能力");
    const repositories = input.repositories
      .map((item) => String(item).trim()).filter(Boolean)
      .filter((item, index, all) => all.indexOf(item) === index);
    if (!repositories.length) throw new Error("请先填写至少一个代码仓");
    if (repositories.length > 12) throw new Error("一次最多读取 12 个代码仓");
    repositories.forEach(validateRepositoryAddress);
    const baseline = input.baseline?.trim() || "master";
    if (/\s/.test(baseline)) throw new Error("基线分支不能含空白字符");

    const credential = this.options.gitCredential?.(input.account);
    // 只读发现同样带着用户的个人令牌上网,和 clone/push 用同一套加固
    // 沙箱:部署机全局配置里的 insteadOf 改道不能把令牌带去别处。
    const prepared = credential
      ? this.prepareHostGitSandbox(credential) : undefined;
    const catalogs: RepositorySkillCatalog[] = [];
    try {
      for (const repository of repositories) {
        const discovered = await discoverRepositorySkills({
          repository,
          baseline,
          credentialHelper: prepared?.helper,
          credentialArgs: prepared?.args,
          credentialEnv: prepared?.env,
          timeoutMs: 30_000,
        });
        catalogs.push(this.catalogWithConflicts({
          ...discovered,
          // 服务端选择与任务 summary 均使用用户输入的规范化字符串；
          // 发现器内部即使为本地相对路径做了绝对化，也不能让 key 漂移。
          repository,
        }));
      }
    } finally {
      this.cleanupHostGitCredential(prepared);
    }

    const now = Date.now();
    for (const [key, value] of this.repositorySkillCatalogs) {
      if (value.expiresAt <= now) this.repositorySkillCatalogs.delete(key);
    }
    while (this.repositorySkillCatalogs.size >= 64) {
      const oldest = this.repositorySkillCatalogs.keys().next().value;
      if (!oldest) break;
      this.repositorySkillCatalogs.delete(oldest);
    }
    const catalogToken = randomUUID();
    this.repositorySkillCatalogs.set(catalogToken, {
      account: input.account,
      repositories,
      baseline,
      expiresAt: now + 10 * 60_000,
      catalogs,
    });
    return { catalog_token: catalogToken, repositories: catalogs };
  }

  /**
   * 下单前的轻量可达性探测。这里只问远端“能否读取引用”，不 clone、
   * 不扫描内容，也不在浏览器里碰个人令牌。与真正 clone/push 共用同一
   * 套临时凭据和隔离 Git 环境，避免表单探测绿、真正执行却因身份不同红。
   */
  async probeRepositories(input: {
    repositories: string[];
    account?: string;
  }): Promise<RepositoryProbeResponse> {
    if (!this.options.host) {
      throw new Error("本部署未接代码仓，无法探测仓库地址");
    }
    const repositories = input.repositories
      .map((item) => String(item).trim()).filter(Boolean)
      .filter((item, index, all) => all.indexOf(item) === index);
    if (repositories.length > 12) throw new Error("一次最多探测 12 个代码仓");
    const credential = this.options.gitCredential?.(input.account);
    const sandbox = this.prepareHostGitSandbox(credential);
    try {
      const results = await Promise.all(repositories.map(async (repository) => {
        try {
          validateRepositoryAddress(repository);
          const windowsDrive = /^[a-z]:[\\/]/i.test(repository);
          if (!windowsDrive
              && /^[a-z][a-z\d+.-]*:/i.test(repository)
              && !/^(?:https?|file):\/\//i.test(repository)) {
            throw new Error("代码仓传输协议不受支持，只允许 HTTPS 或本地仓");
          }
          const remote = /^(?:https?|file):\/\//i.test(repository)
            ? repository : resolve(repository);
          const checked = await runGitProcess([
            ...sandbox.args, "ls-remote", "--symref", remote, "HEAD",
          ], {
            timeoutMs: 8_000,
            maxBuffer: 64 * 1024,
            env: sandbox.env,
          });
          if (checked.status === 0 && !checked.error && !checked.timedOut) {
            return { repository, reachable: true,
              message: "地址有效，仓库可访问" };
          }
          const detail = `${checked.stderr}\n${checked.error?.message ?? ""}`;
          const message = checked.timedOut
            ? "连接超时，请检查仓库服务或网络"
            : /authentication|authorization|access denied|forbidden|403|401|could not read username|terminal prompts disabled/i.test(detail)
              ? "仓库需要权限，请检查个人 Git Token"
              : /not found|does not exist|repository.*not found|no such file|not a git repository|does not appear to be a git repository/i.test(detail)
                ? "仓库不存在或地址填写有误"
                : /could not resolve host|name or service not known/i.test(detail)
                  ? "无法解析仓库主机，请检查域名"
                  : /failed to connect|couldn't connect|connection refused|network is unreachable/i.test(detail)
                    ? "无法连接仓库服务，请检查网络或地址"
                    : "仓库无法访问，请检查地址和个人 Git Token";
          return { repository, reachable: false, message };
        } catch (error) {
          return { repository, reachable: false,
            message: error instanceof Error ? error.message : "仓库地址无效" };
        }
      }));
      return { repositories: results };
    } finally {
      this.cleanupHostGitCredential(sandbox);
    }
  }

  private catalogWithConflicts(
    catalog: RepositorySkillCatalog,
  ): RepositorySkillCatalog {
    const hostNames = new Set(
      hostSkillNames(this.options.dataDir).map((name) => name.toLowerCase()));
    const counts = new Map<string, number>();
    for (const skill of catalog.skills) {
      const key = skill.name.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const reserved = (name: string) => name === "mae-flow"
      || name === "build-fix"
      || /^(?:comet|openspec|ponytail)(?:-|$)/.test(name);
    const skills = catalog.skills.map((skill): RepositorySkillDescriptor => {
      const name = skill.name.toLowerCase();
      const conflict = hostNames.has(name)
        ? "与平台常驻 Skill 同名"
        : reserved(name)
          ? "与 Mae-Flow 平台能力重名"
          : (counts.get(name) ?? 0) > 1
            ? "本仓存在同名 Skill，无法确定应加载哪一个"
            : undefined;
      return conflict
        ? { ...skill, selectable: false, warning: conflict }
        : skill;
    });
    return { ...catalog, skills };
  }

  private selectedResourcesFromCatalog(options: {
    catalogToken?: string;
    selectedSkillIds?: string[];
    repositories: string[];
    baseline?: string;
    account?: string;
    /** Chain 检视重新读取目录时，不能因单个仓临时扫描失败
     * 就把父任务上已经确认的 Skill 清掉。仅该场景传入旧值；
     * 新下单仍不会从扫描失败的仓带入任何选择。 */
    preserveSkillsForErroredRepositories?: SelectedRepositorySkill[];
  }): {
    skills: SelectedRepositorySkill[];
  } {
    const skillIds = [...new Set((options.selectedSkillIds ?? []).map(String))];
    if (!skillIds.length && !options.catalogToken) {
      return { skills: [] };
    }
    if (!options.catalogToken) throw new Error("选择仓内能力前请重新读取 Skill 目录");
    const ticket = this.repositorySkillCatalogs.get(options.catalogToken);
    if (!ticket || ticket.expiresAt <= Date.now()) {
      this.repositorySkillCatalogs.delete(options.catalogToken);
      throw new Error("仓内能力目录已过期，请重新读取后再发起任务");
    }
    if (ticket.account !== options.account) {
      throw new Error("仓内能力目录不属于当前登录用户");
    }
    if (JSON.stringify(ticket.repositories) !== JSON.stringify(options.repositories)
        || ticket.baseline !== options.baseline) {
      throw new Error("代码仓或基线已变化，请重新读取仓内能力");
    }
    if (skillIds.length > 20) throw new Error("每个任务最多选择 20 个仓内 Skill");
    const skillsById = new Map<string, {
      catalog: RepositorySkillCatalog;
      skill: RepositorySkillDescriptor;
    }>();
    const successfulRepositories = new Set(
      ticket.catalogs.filter((catalog) => !catalog.error)
        .map((catalog) => catalog.repository));
    for (const catalog of ticket.catalogs) {
      // 失败目录不参与 ID 还原。即使未来某个发现器在
      // error 上还附了部分 skills，也不能把不完整快照当成可选清单。
      if (catalog.error) continue;
      for (const skill of catalog.skills) {
        skillsById.set(skill.id, { catalog, skill });
      }
    }
    const selectedSkills = skillIds.map((id): SelectedRepositorySkill => {
      const found = skillsById.get(id);
      if (!found || !found.skill.selectable) {
        throw new Error("所选仓内 Skill 不存在或不可由 Agent 自主使用，请重新读取");
      }
      if (!validRepositorySkillPath(found.skill.relative_path)) {
        throw new Error("仓内 Skill 路径不合法");
      }
      return {
        id: found.skill.id,
        repository: found.catalog.repository,
        revision: found.catalog.revision,
        name: found.skill.name,
        description: found.skill.description,
        relative_path: found.skill.relative_path,
        source: found.skill.source,
        digest: found.skill.digest,
      };
    });
    const mergedSkills = options.preserveSkillsForErroredRepositories === undefined
      ? selectedSkills
      : ticket.repositories.flatMap((repository) => {
          if (successfulRepositories.has(repository)) {
            // 成功仓以本次 IDs 为准；没选中任何项就是显式清空。
            return selectedSkills.filter((skill) => skill.repository === repository);
          }
          // catalog.error（以及防御性的目录缺失）保留该仓旧值，
          // 不影响其他成功仓的更新。
          return options.preserveSkillsForErroredRepositories!
            .filter((skill) => skill.repository === repository)
            .map((skill) => ({ ...skill }));
        });
    if (mergedSkills.length > 20) {
      throw new Error("每个任务最多选择 20 个仓内 Skill");
    }
    this.repositorySkillCatalogs.delete(options.catalogToken);
    return { skills: mergedSkills };
  }

  /** 仓内知识的事实源只有 Git。首次进入 checkout 时把发现到的精确
   * commit/path/digest 固定到任务；MFC 不产生自己的发布版本，也不在
   * 后续会话重新扫描已经被 Agent 修改过的工作区。 */
  private freezeRepositoryNativeSkills(
    task: TaskState,
    materialized: ReturnType<typeof materializeRepositorySkills>,
  ): void {
    if (task.summary.repository_skills !== undefined) return;
    task.summary.repository_skills = materialized.entries
      .map(({ skill }) => ({ ...skill }));
    this.persist(task);
  }

  create(
    requirement: string,
    options: {
      /** 用户明确填写的任务名称：只用于列表/通知/搜索，不替代需求原文。 */
      title?: string;
      account?: string;
      repo?: string;
      repos?: string[];
      lane?: string;
      /** 需求/问题单号(REQ/DTS):内核配置确认的"单号"项,下单就给,
       * 不让模型开工后再来问一遍(用户 2026-08-19 拍板)。 */
      ticket?: string;
      /** 基线分支,默认 master(同一次拍板)。 */
      baseline?: string;
      model?: { provider: string; model: string };
      repairRounds?: number;
      /** 任务级低优先级执行补充；详细需求仍放 requirement。编译进
       * workflow_profile.supplements(v1 execution-profile 已退役)。 */
      taskInstructions?: string;
      /** 仅供原位重跑继承「代码仓约定已解析」的事实。 */
      repositorySupplementResolved?: boolean;
      /** 专业模式提交结构化编辑；普通用户缺席即保持既有 Mae-Flow。 */
      workflowDefinition?: unknown;
      /** 保存的工作流/任务复制由服务端资产路由传入；普通 API 不自报。 */
      workflowSource?: WorkflowSourceRef;
      workflowResolvedAssets?: WorkflowResolvedAsset[];
      /** 仅供原位重跑、跨仓拆单复制已经固定的完整最终方案。 */
      workflowProfile?: WorkflowExecutionProfileV2;
      workflowProfileWarning?: string;
      /** 重跑/拆单从父现场复制已经固定的团队 Skill，而不是重新读货架。 */
      hostSkillSnapshotSourceWorkspace?: string;
      /** 浏览器上传的原始文件名；正文仍由 requirement 统一承载。 */
      requirementDocumentName?: string;
      /** Chain 拆单内部会把原文与逐仓说明拼接，允许多一份原文大小的
       * 安全余量；外部下单绝不设置。 */
      internalRequirement?: boolean;
      /** Chain 确认后生成的仓库交付任务使用；不暴露给普通 API。 */
      parentTaskId?: string;
      blockedBy?: string[];
      /** 仅供原位从头重跑：复用已删除的 task-N，并等清理完成后再入队。 */
      reuseTaskId?: string;
      deferQueue?: boolean;
      /** 普通 API 只提交短期目录令牌和所选 id；服务端把它还原为
       * 已验证清单。repositorySkills 只供 Chain 拆单内部透传。 */
      repositorySkillCatalogToken?: string;
      selectedRepositorySkillIds?: string[];
      repositorySkills?: SelectedRepositorySkill[];
      /** 内部复制/旧客户端的精确团队 Skill 清单；普通下单页面不暴露
       * 选择，字段缺席时由服务端按任务范围自动匹配全部。工作流精确
       * 引用的 Skill 会在服务端强制并入。 */
      selectedHostSkillPaths?: string[];
      /** 普通下单只提交正式模块 ID；服务端在创建现场时固定当时的已发布
       * 资产版本与正文快照，浏览器不能自报内容。 */
      selectedBusinessModuleIds?: string[];
      /** 前端首次人工确认并由服务端验过的技术画像；知识旁路字段。 */
      repositoryProfiles?: RepositoryProfile[];
      /** 内部复制/旧客户端兼容；普通下单缺席并由服务端自动匹配。 */
      selectedEngineeringKnowledgeIds?: string[];
      /** 发起页服务端预览的有序清单指纹；不一致时拒绝静默换名单。 */
      knowledgePreviewDigest?: string;
      /** 仅供跨仓拆单复制父任务已固定版本。 */
      engineeringKnowledge?: SelectedEngineeringKnowledge[];
      engineeringKnowledgeSourceWorkspace?: string;
      /** 仅供跨仓拆单：从父任务复制已经固定的模块版本与正文。 */
      businessModules?: SelectedBusinessModule[];
      businessModuleSourceWorkspace?: string;
      /** 仅供旧跨仓父任务拆单：旧现场没有 repository_skills 字段时，
       * 子任务必须继续保留 undefined，让物化器走旧版全量加载兼容；
       * 不能与新下单的“明确未选择”空数组混为一谈。 */
      preserveUndefinedRepositorySkills?: boolean;
    } = {},
  ): TaskSummary {
    if (this.options.requirementDisabled) {
      throw new Error(
        "本部署为问题流专用(--issue-only),需求流程未启用;"
        + "处理问题请前往「问题处理」页");
    }
    const explicitTitle = options.title?.trim().replace(/\s+/g, " ") || undefined;
    if (explicitTitle && explicitTitle.length > 80) {
      throw new Error("任务名称不能超过 80 个字符");
    }
    const requirementDocument = requirementDocumentMeta(
      requirement, options.requirementDocumentName,
      options.internalRequirement
        ? MAX_REQUIREMENT_DOCUMENT_BYTES * 2
        : MAX_REQUIREMENT_DOCUMENT_BYTES);
    // 交付方式:选项是内核的领地,现读它的 flow.json 校验
    // (2026-08-18 修正:此前 TS 侧自造"快速/慢速",与内核的
    // full/hotfix/tweak/review 对不上,预选永远匹配不上内核举的卡,
    // 用户下单答过一次、页面上还要再答一次)。读不到内核定义时不校验
    // ——宁可放行也不拿一套猜出来的选项挡人。
    const workflowCatalogRoot = this.options.host?.kernelRoot
      ?? this.options.workflowCatalogRoot;
    const workflowCatalog = workflowChoices(workflowCatalogRoot);
    const laneChoices = workflowCatalog.map((item) => item.label);
    const requestedLane = options.lane?.trim() || undefined;
    if (requestedLane !== undefined && laneChoices.length
        && !laneChoices.includes(requestedLane)) {
      throw new Error(
        `交付方式只能是 ${laneChoices.join("/")},收到: ${requestedLane}`);
    }
    // 单号/基线分支:内核配置确认要的两项事实,下单就收齐(和交付方式
    // 同一逻辑:能在表单上一次给完的,不让模型开工后逐项来问)。单号
    // 只在内核模式必填——纯会话形态没有配置确认这回事。校验只做"像不
    // 像个单号"的最低限(非空、无空白);REQ→feat/DTS→fix 的推导是
    // 内核的判定,宿主不代判。
    const ticket = (options.ticket ?? "").trim() || undefined;
    if (ticket && /\s/.test(ticket)) {
      throw new Error("单号不能含空白字符");
    }
    if (!ticket && this.options.host && !this.options.host.repoPath) {
      throw new Error("请填写需求/问题单号(REQ/DTS)——分支名和提交信息都要用它");
    }
    const baseline = (options.baseline ?? "").trim()
      || (this.options.host ? "master" : undefined);
    if (baseline && /\s/.test(baseline)) {
      throw new Error("基线分支不能含空白字符");
    }
    const repositories = (options.repos?.length
      ? options.repos : options.repo ? [options.repo] : [])
      .map((item) => String(item).trim()).filter(Boolean)
      .filter((item, index, all) => all.indexOf(item) === index);
    // 同(单号,归属人,仓)重复下单会派生出**同名分支**:第二单非快进
    // 推送失败烧完预算 stalled,报错还是裸 git stderr;同分支对的 MR
    // 又是幂等复用,两单互相污染检视与门禁(2026-08-30 审计,"跑挂了
    // 不管旧单直接重下"是最常见操作)。在途旧单存在时如实拒绝并指路;
    // 终态(completed/failed/canceled)不拦——重来是合法的。内部创建
    // (跨仓拆单/原位重跑)豁免:父单在途是拆单的前提,不是撞单。
    if (ticket && !options.internalRequirement) {
      const account = options.account?.trim() || undefined;
      const duplicate = [...this.tasks.values()].find((existing) => {
        const summary = existing.summary;
        if (["completed", "failed", "canceled"].includes(summary.status)) {
          return false;
        }
        if ((summary.ticket ?? "") !== ticket) return false;
        if ((summary.luban_account ?? "") !== (account ?? "")) return false;
        const existingRepositories = [...new Set([
          ...(summary.repositories ?? []),
          ...(summary.repo_url ? [summary.repo_url] : []),
        ].map((item) => String(item).trim()).filter(Boolean))];
        return existingRepositories.length === 0 || repositories.length === 0
          || existingRepositories.some((repository) =>
            repositories.includes(repository));
      });
      if (duplicate) {
        throw new TaskControlError(
          `单号 ${ticket} 已有在途任务 ${duplicate.summary.id}`
          + `(状态 ${duplicate.summary.status})。同单号重复下单会派生`
          + "同名分支互相覆盖;请在旧任务上继续(重跑/答卡),或先取消"
          + "它再重新发起");
      }
    }
    const repo = repositories[0];
    // 交付仓必填(用户 2026-08-18 拍板:没有"默认仓"这回事)。一个
    // 部署要服务很多个仓,兜底一个默认值只会让人漏看一眼就把单下错
    // 地方——宁可当场拒绝,也不替人猜他要交到哪儿。
    // 唯一豁免:部署显式用 `--repo` 钉死了单仓(演示/试跑/测试的
    // harness 形态,那是命令行不是产品面)。生产按 `--kernel-mode`
    // 不带 `--repo` 起,于是每单都必须写明。
    if (!repo && this.options.host && !this.options.host.repoPath) {
      throw new Error(
        "请填写交付代码仓——本部署不设默认仓,每单都要写明交到哪个仓");
    }
    for (const candidate of repositories) {
      if (!this.options.host) {
        throw new Error("本部署未接内核模式,任务不克隆代码仓");
      }
      // SSH、明文 userinfo 与控制字符的口径同时服务任务创建和 Skill
      // 目录扫描，不能让“能列出、却注定无法交付”的仓进入下一步。
      validateRepositoryAddress(candidate);
    }
    // 钉死单仓部署(serve --repo/假平台,repoPinned)不接受逐单仓:
    // 任务会克隆用户填的地址、把分支推到那里,而交付平台盯的是部署仓
    // ——推送与 MR 各查各的,走到最后一步才 MR 400,整单白烧
    // (e2e-picky-20260830 实锤,MFC-004/024)。与部署仓相同的写法
    // 放行;直接构造 TaskService 的测试/试跑不置 repoPinned,不受限。
    const pinnedRepo = this.options.host?.repoPinned
      ? this.options.host.repoPath : undefined;
    if (pinnedRepo && repositories.length && !options.internalRequirement) {
      const normalize = (value: string) =>
        /^(https?|ssh|git):\/\//i.test(value) ? value : resolve(value);
      const pinnedNormalized = normalize(pinnedRepo);
      const mismatched = repositories.filter((candidate) =>
        normalize(candidate) !== pinnedNormalized);
      if (mismatched.length) {
        throw new Error(
          `本部署已用固定交付仓启动,不接受逐单代码仓(${mismatched[0]})。`
          + "留空即使用部署仓;需要逐单交付请以 --kernel-mode(不带 --repo)部署");
      }
    }
    if (options.model) {
      // 下单不再给选模型(用户拍板:管理员统一配一个)。这条通路留给
      // 试跑器/测试显式指定,仍然当场校验存在性——选了不存在的模型,
      // 晚到会话启动才炸是坑人。
      const providers = (this.activeModelsJson() as {
        providers?: Record<string, { models?: Array<{ id?: string }> }>;
      }).providers ?? {};
      const listed = (providers[options.model.provider]?.models ?? [])
        .map((item) => String(item?.id ?? ""));
      if (!listed.includes(options.model.model)) {
        throw new Error(
          `没有模型 ${options.model.provider}/${options.model.model}`);
      }
    }
    if (options.repairRounds !== undefined
        && (!Number.isFinite(options.repairRounds)
            || options.repairRounds < 0)) {
      throw new Error("修复轮预算必须是 ≥0 的数字");
    }
    // 先校验再分配 task id，避免一个超长输入白白消耗任务序号。
    const taskInstructions = normalizeTaskExecutionInstructions(
      options.taskInstructions);
    const directResources = options.repositorySkills !== undefined;
    const explicitCatalogSelection = options.repositorySkillCatalogToken !== undefined
      || options.selectedRepositorySkillIds !== undefined;
    const selectedResources = !options.preserveUndefinedRepositorySkills
        && !directResources && explicitCatalogSelection
      ? this.selectedResourcesFromCatalog({
          catalogToken: options.repositorySkillCatalogToken,
          selectedSkillIds: options.selectedRepositorySkillIds,
          repositories,
          baseline,
          account: options.account,
        })
      : undefined;
    const repositorySkills = options.preserveUndefinedRepositorySkills
      ? undefined
      : directResources
        ? (options.repositorySkills ?? []).map((skill) => {
            if (!repositories.includes(skill.repository)
                || !validRepositorySkillPath(skill.relative_path)) {
              throw new Error(`仓内 Skill ${skill.name} 不属于本任务代码仓`);
            }
            return { ...skill };
          })
      : selectedResources?.skills;
    if ((repositorySkills?.length ?? 0) > 20) {
      throw new Error("每个任务最多选择 20 个仓内 Skill");
    }
    const effectiveKnowledgeSelections = effectiveLaunchKnowledgeSelections({
      selectedBusinessModuleIds: options.selectedBusinessModuleIds,
      selectedEngineeringKnowledgeIds: options.selectedEngineeringKnowledgeIds,
      workflowDefinition: !options.workflowProfile
        ? options.workflowDefinition : undefined,
    });
    const workflowSelections = effectiveKnowledgeSelections.workflow;
    const selectedBusinessModuleIds =
      effectiveKnowledgeSelections.businessModuleIds;
    const selectedEngineeringKnowledgeIds =
      effectiveKnowledgeSelections.engineeringKnowledgeIds;
    let expectedKnowledgePreview:
      ReturnType<typeof previewLaunchKnowledge> | undefined;
    if (options.knowledgePreviewDigest) {
      const currentPreview = previewLaunchKnowledge(this.options.dataDir, {
        repositories,
        selectedBusinessModuleIds: options.selectedBusinessModuleIds,
        selectedEngineeringKnowledgeIds: options.selectedEngineeringKnowledgeIds,
        selectedHostSkillPaths: options.selectedHostSkillPaths,
        repositoryProfiles: options.repositoryProfiles,
        workflowDefinition: !options.workflowProfile
          ? options.workflowDefinition : undefined,
      });
      if (!currentPreview.complete) {
        throw new Error("发起前知识清单暂时无法完整核对，请稍后重试");
      }
      if (currentPreview.selection_digest !== options.knowledgePreviewDigest) {
        throw new Error("发起前知识清单已变化，请核对更新后的清单再发起");
      }
      expectedKnowledgePreview = currentPreview;
    }
    const id = options.reuseTaskId ?? this.allocateTaskId();
    if (options.reuseTaskId && (!/^task-\d+$/.test(id)
        || this.tasks.has(id) || existsSync(join(this.options.dataDir, id)))) {
      throw new TaskControlError(`任务 ${id} 不能安全地原位重建`);
    }
    const workspace = join(this.options.dataDir, id);
    let workflowProfileWarning = options.workflowProfileWarning;
    let workflowProfile = options.workflowProfile
      ? structuredClone(options.workflowProfile) : undefined;
    mkdirSync(workspace, { recursive: true });
    let repositoryProfiles = options.repositoryProfiles ?? [];
    if (options.repositoryProfiles === undefined && repositories.length) {
      try {
        repositoryProfiles = resolveRepositoryProfiles(
          this.options.dataDir, repositories)
          .flatMap((item) => item.profile ? [{ ...item.profile }] : []);
      } catch (error) {
        this.options.log?.(
          `[repository-profiles] 任务 ${id} 读取失败，已退化为按仓库匹配（不影响下单）：${String(error)}`);
      }
    }
    const profileTechnologies = [...new Set(repositoryProfiles
      .flatMap((profile) => profile.technologies))];
    let issueEnvironments: IssueEnvironmentRef[] = [];
    let businessModules: SelectedBusinessModule[] = [];
    let engineeringKnowledge: SelectedEngineeringKnowledge[] = [];
    let teamSkills: HostSkillShelfEntry[] = [];
    let hostSkillSnapshotWarnings: string[] = [];
    try {
      if (options.businessModules !== undefined) {
        if (!options.businessModuleSourceWorkspace) {
          throw new Error("复制业务模块快照时缺少父任务现场");
        }
        businessModules = copyBusinessModuleSnapshots({
          selected: options.businessModules,
          sourceTaskWorkspace: options.businessModuleSourceWorkspace,
          targetTaskWorkspace: workspace,
          repositories,
        });
      } else {
        businessModules = snapshotBusinessModules({
          dataDir: this.options.dataDir,
          taskWorkspace: workspace,
          moduleIds: selectedBusinessModuleIds,
          repositories,
        });
      }
      try {
        if (options.engineeringKnowledge !== undefined) {
          if (!options.engineeringKnowledgeSourceWorkspace) {
            throw new Error("复制团队工程知识快照时缺少父任务现场");
          }
          engineeringKnowledge = copyEngineeringKnowledgeSnapshots({
            selected: options.engineeringKnowledge,
            sourceTaskWorkspace: options.engineeringKnowledgeSourceWorkspace,
            targetTaskWorkspace: workspace,
            repository: repositories.length === 1 ? repositories[0] : undefined,
          });
        } else {
          engineeringKnowledge = snapshotEngineeringKnowledge({
            dataDir: this.options.dataDir,
            taskWorkspace: workspace,
            repositories,
            technologies: profileTechnologies,
            businessModuleIds: businessModules.map((module) => module.id),
            selectedIds: selectedEngineeringKnowledgeIds,
          });
        }
      } catch (error) {
        engineeringKnowledge = [];
        this.options.log?.(
          `[engineering-knowledge] 任务 ${id} 快照失败，已退化为无团队工程知识（不影响下单）：${String(error)}`);
      }
      const hostSkillSnapshotRoot = join(workspace, "host-skill-snapshot");
      mkdirSync(hostSkillSnapshotRoot, { recursive: true, mode: 0o750 });
      const hostSkillSourceRoot = options.hostSkillSnapshotSourceWorkspace
        ? join(options.hostSkillSnapshotSourceWorkspace, "host-skill-snapshot")
        : join(this.options.dataDir, "skills");
      let selectedHostSkillPaths = options.selectedHostSkillPaths === undefined
          && workflowSelections.teamSkillIds.length === 0
        ? undefined : [...new Set((options.selectedHostSkillPaths ?? [])
          .map((item) => String(item).trim()).filter(Boolean))];
      // 专业工作流是用户明确编排，引用的团队 Skill 不能被普通清单里的
      // 一次取消勾选悄悄拿掉；核心流程仍不依赖任何知识资产。
      if (selectedHostSkillPaths && workflowSelections.teamSkillIds.length
          && !options.hostSkillSnapshotSourceWorkspace) {
        try {
          const shelf = listHostSkillShelf(this.options.dataDir);
          const required = shelf.skills.filter((skill) =>
            workflowSelections.teamSkillIds.includes(
              (skill.source_path ?? skill.path).split("/")[0]))
            .map((skill) => skill.path);
          selectedHostSkillPaths = [...new Set([
            ...selectedHostSkillPaths, ...required,
          ])];
        } catch (error) {
          this.options.log?.(
            `[host-skill-snapshot] 工作流团队 Skill 目录解析失败(fail-open): ${String(error)}`);
        }
      }
      const hostSkillSnapshot = materializeHostSkills({
        sourceRoot: hostSkillSourceRoot,
        workspaceRoot: workspace,
        snapshotRoot: hostSkillSnapshotRoot,
        selectedSourcePaths: options.hostSkillSnapshotSourceWorkspace
          ? undefined : selectedHostSkillPaths,
        // 新任务在这里自动匹配一次并固定版本；重跑/拆单复制的已经是
        // 父任务快照，不能因画像字段迁移或后续治理变化再次筛掉。
        context: options.hostSkillSnapshotSourceWorkspace ? undefined : {
          repositories, technologies: profileTechnologies,
          businessModuleIds: businessModules.map((module) => module.id),
        },
      });
      hostSkillSnapshotWarnings = hostSkillSnapshot.warnings;
      try {
        teamSkills = listHostSkillShelfRoot(hostSkillSnapshotRoot).skills;
      } catch (error) {
        hostSkillSnapshotWarnings.push(`团队 Skill 清单读取失败：${String(error)}`);
      }
      for (const warning of hostSkillSnapshotWarnings) {
        this.options.log?.(
          `[host-skill-snapshot] 任务 ${id}: ${warning}`);
      }
      if (expectedKnowledgePreview) {
        const expectedBusiness = expectedKnowledgePreview.business_knowledge
          .map((item) => ({
            module_id: item.module_id,
            module_revision: item.module_revision,
            id: item.id,
            version: item.version,
            digest: item.digest,
          }));
        const actualBusiness = businessModules.flatMap((module) =>
          module.assets.map((asset) => ({
            module_id: module.id,
            module_revision: module.revision,
            id: asset.id,
            version: asset.version,
            digest: asset.digest,
          })));
        const expectedEngineering = expectedKnowledgePreview
          .engineering_knowledge.map((item) => ({
            id: item.id, digest: item.digest,
          }));
        const actualEngineering = engineeringKnowledge.map((item) => ({
          id: item.id, digest: item.digest,
        }));
        const expectedSkills = expectedKnowledgePreview.team_skills
          .map((item) => ({
            path: item.path,
            digest: item.digest,
            package_digest: item.package_digest,
          }));
        const actualSkills = teamSkills.map((item) => ({
          path: item.source_path ?? item.path,
          digest: item.digest,
          package_digest: item.package_digest,
        }));
        if (JSON.stringify({ business: actualBusiness,
          engineering: actualEngineering, skills: actualSkills })
            !== JSON.stringify({ business: expectedBusiness,
              engineering: expectedEngineering, skills: expectedSkills })) {
          throw new Error(
            "发起前知识清单未能按核对版本完整固定，请重新核对后再发起");
        }
      }
      storeRequirementDocument(workspace, requirement, requirementDocument);
    } catch (error) {
      removeTaskTree(workspace);
      throw error;
    }
    if (!workflowProfile && options.workflowDefinition !== undefined) {
      const standard = readWorkflowStandardSnapshot(
        workflowCatalogRoot);
      if (!standard) {
        workflowProfileWarning = [
          workflowProfileWarning,
          "工作流标准目录暂不可读，已采用既有 Mae-Flow 默认流程；本次定制未生效",
        ].filter(Boolean).join("；");
      } else {
        workflowProfile = compileWorkflow({
          baseSnapshot: standard,
          definition: options.workflowDefinition,
          source: options.workflowSource ?? { kind: "task", id },
          resolvedAssets: options.workflowResolvedAssets
            ?? resolveWorkflowAssets({
              definition: options.workflowDefinition,
              dataDir: this.options.dataDir,
              repositories,
              technologies: profileTechnologies,
              businessModules,
              engineeringKnowledge,
              repositorySkills,
              hostSkillSnapshotRoot: join(workspace, "host-skill-snapshot"),
            }),
        });
      }
    }
    // 文字建议层(任务补充+团队约定)并入定格方案;没选工作流也一样
    // ——产出 supplement-only 档,内核只认这一个文件(v1 退役)。
    // 原位重跑/拆单传入的 workflowProfile 已带 supplements,不重复叠。
    if (!options.workflowProfile) {
      const supplements = buildTaskSupplements(
        id, taskInstructions,
        this.options.settings?.executionPolicy().team_instructions);
      if (supplements.length) {
        workflowProfile = withWorkflowSupplements(
          workflowProfile, supplements);
      }
    }
    const summary: TaskSummary = {
      id,
      // 旧调用方/历史兼容仍可从首行生成；产品下单界面会明确收任务名称，
      // 不再让用户输入的长需求文档悄悄承担标题职责。
      title: explicitTitle ?? taskTitle(requirement),
      requirement,
      requirement_document: requirementDocument,
      status: "queued",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_progress_at: new Date().toISOString(),
      workspace,
      luban_account: options.account || undefined,
      repo_url: repo,
      repositories: repositories.length ? repositories : undefined,
      repository_profiles: repositories.length
        ? repositoryProfiles
          .filter((profile) => repositories.some((repository) =>
            repository.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase()
            === profile.repository.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase()))
        : undefined,
      repository_skills: repositorySkills,
      team_skills: teamSkills.length ? teamSkills : undefined,
      business_modules: businessModules.length ? businessModules : undefined,
      engineering_knowledge: engineeringKnowledge.length
        ? engineeringKnowledge : undefined,
      requirement_graph: repositories.length
        ? {
            stage: repositories.length > 1 ? "analysis" : "confirmed",
            repositories: repositories.map((url, index) => ({
              id: `repo-${index + 1}`,
              name: basename(url).replace(/\.git$/, "") || `仓库 ${index + 1}`,
              url,
            })),
            dependencies: [],
          }
        : undefined,
      parent_task_id: options.parentTaskId,
      blocked_by: options.blockedBy?.length ? [...options.blockedBy] : undefined,
      // 用户拍板:交付方式下单就定,不让 agent 再问一遍。默认取内核
      // 选项里的第一项(通常是"完整开发"),读不到内核就不预选。
      lane: requestedLane ?? laneChoices[0],
      ticket,
      baseline,
      model_choice: options.model,
      repair_rounds: options.repairRounds,
      repository_supplement_resolved: options.repositorySupplementResolved,
      workflow_profile: workflowProfile,
      workflow_profile_warning: workflowProfileWarning,
      host_skills_pinned: true,
      host_skill_snapshot_warnings: hostSkillSnapshotWarnings.length
        ? hostSkillSnapshotWarnings : undefined,
    };
    const task: TaskState = {
      summary,
      tokenUsage: emptyTokenUsageState(),
      humanGate: new HumanGate(join(workspace, "waiting.json")),
      lastPersistedStatus: summary.status,
      controlEpoch: 0,
    };
    this.tasks.set(id, task);
    try {
      this.persist(task);
    } catch (error) {
      // 任务事实落不了盘就不能留下半个现场:没有 task.json 的工作区
      // 谁也回收不了。这里必须走 removeTaskTree——知识与 Skill 快照
      // 是只读的,裸 rmSync 会 ENOTEMPTY(见该函数头注释),回滚二次
      // 抛错反而把真正的落盘错误盖掉。
      this.tasks.delete(id);
      removeTaskTree(workspace);
      throw error;
    }
    if (!options.deferQueue) {
      this.queue.push(id);
      this.bypass(undefined, "任务泵", this.pump());
    }
    return { ...summary };
  }

  private allocateTaskId(): string {
    this.counter += 1;
    try {
      this.persistTaskSequence();
    } catch (error) {
      this.counter -= 1;
      throw error;
    }
    return `task-${this.counter}`;
  }

  private persistTaskSequence(): void {
    mkdirSync(this.options.dataDir, { recursive: true });
    const path = join(this.options.dataDir, ".task-sequence");
    const temporary = `${path}.tmp`;
    try {
      writeFileSync(temporary, `${this.counter}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  private writeTaskState(task: TaskState, strict = false): boolean {
    try {
      const path = join(task.summary.workspace, "task.json");
      writeFileSync(path + ".tmp", JSON.stringify({
        summary: task.summary,
        cwd: task.cwd,
        mission: task.mission,
        assistant_handoff: task.pendingAssistantHandoff,
        pending_main_steers: task.pendingMainSteers,
        applied_developer_intervention_id:
          task.appliedDeveloperInterventionId,
        obsolete_developer_waiting: task.obsoleteDeveloperWaiting,
        token_usage_state: task.tokenUsage,
        notify_record: task.notifyRecord,
      }, null, 1));
      renameSync(path + ".tmp", path);
      return true;
    } catch (error) {
      this.options.log?.(`任务 ${task.summary.id} 落盘失败: ${String(error)}`);
      if (strict) {
        throw new TaskControlError(
          `任务现场未能可靠落盘，已停止本次交还，可直接重试：${String(error)}`,
        );
      }
      return false;
    }
  }

  private recordTaskTokenUsage(
    task: TaskState,
    sample: ModelTokenUsageSample,
  ): void {
    task.tokenUsage = recordTokenUsage(task.tokenUsage, sample);
    // Token 流量不是阶段推进，不能刷新 updated_at / 卡点时钟。
    this.writeTaskState(task);
  }

  /** 任务事实落盘(原子写):进程可死,任务不能死。
   * summary+cwd 就是重启后重建 TaskState 需要的全部——待办在
   * waiting.json、事件在 events.jsonl、流程真相在内核状态文件。 */
  private persist(task: TaskState, strict = false): void {
    const now = new Date().toISOString();
    if (task.lastPersistedStatus !== undefined
        && task.lastPersistedStatus !== task.summary.status) {
      task.summary.last_progress_at = now;
    }
    if (task.summary.status === "completed") {
      task.summary.completed_at ??= now;
    } else {
      delete task.summary.completed_at;
    }
    task.summary.updated_at = now;
    task.lastPersistedStatus = task.summary.status;
    this.writeTaskState(task, strict);
    // 文件先落袋(它才是真相),投影旁路跟进;失败由投影自己 fail-open。
    this.bypass(task, "投影 upsert",
      this.options.projection?.upsertTask(this.project(task)));
    this.maybeCaptureDiagnostics(task);
  }

  /** 任务一进事故态(failed / 交付停摆)就自动落一份诊断包——第一
   * 时间抓现场,人来看时不用再翻七八处。纯旁路:采集失败只记日志,
   * 绝不影响任务;同一事故(状态+原因)只落一份。 */
  private maybeCaptureDiagnostics(task: TaskState): void {
    const stalled = task.summary.delivery?.stalled ?? "";
    const key = task.summary.status === "failed"
      ? `failed:${task.summary.detail ?? ""}`
      : stalled ? `stalled:${stalled}` : "";
    if (!key || task.lastDiagnosticsKey === key) return;
    task.lastDiagnosticsKey = key;
    this.bypass(task, "诊断包采集", writeTaskDiagnostics({
      ...this.diagnosticsInput(task),
      reason: key.startsWith("failed:")
        ? `任务失败:${task.summary.detail ?? ""}`
        : `交付停摆:${stalled}`,
      dedupeKey: key,
    }).then(({ path, skipped }) => {
      if (!skipped) {
        this.options.log?.(`任务 ${task.summary.id} 已自动落诊断包:${path}`);
      }
    }));
  }

  private diagnosticsInput(task: TaskState): DiagnosticsInput {
    const meta = task.container?.metadata;
    return {
      taskId: task.summary.id,
      workspace: task.summary.workspace,
      ...(task.cwd ? { cwd: task.cwd } : {}),
      ...(this.options.recentLog
        ? { serviceLogTail: this.options.recentLog() } : {}),
      ...(meta ? { container: {
        name: meta.name, containerId: meta.containerId } } : {}),
      dataDir: this.options.dataDir,
    };
  }

  /** 人工导出诊断包(页面按钮/HTTP):现采现回,同时落盘留档。 */
  async exportDiagnostics(
    id: string,
  ): Promise<{ path: string; content: string }> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const input = { ...this.diagnosticsInput(task), reason: "人工导出" };
    const content = await collectTaskDiagnostics(input);
    const dir = join(task.summary.workspace, "diagnostics");
    mkdirSync(dir, { recursive: true });
    const path = join(dir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-manual.md`);
    writeFileSync(path, content);
    return { path, content };
  }

  /** 服务重启后恢复任务(服务启动时调用一次):
   * - 终态任务(completed/failed/verifying/await_merge)只重建索引;
   * - waiting_for_human 原地挂起,决定到来时走重建会话续跑;
   * - 崩溃时在跑/在排队的任务重新入队,以内核 current 为锚续跑。 */
  recover(): { restored: number; requeued: number } {
    let restored = 0;
    let requeued = 0;
    if (!existsSync(this.options.dataDir)) return { restored, requeued };
    // 按任务号数值排序,不是字典序:task-10 若排在 task-2 前面,重启后
    // 重建的等待队列会悄悄插队(2026-08-29 部署审计实锤)。
    for (const name of readdirSync(this.options.dataDir).sort((a, b) => {
      const [na, nb] = [a, b].map((item) =>
        /^task-\d+$/.test(item) ? Number(item.slice(5)) : Number.NaN);
      return Number.isNaN(na) || Number.isNaN(nb)
        ? a.localeCompare(b) : na - nb;
    })) {
      const workspace = join(this.options.dataDir, name);
      const path = join(workspace, "task.json");
      if (!/^task-\d+$/.test(name) || !existsSync(path)
          || this.tasks.has(name)) {
        continue;
      }
      try {
        const saved = JSON.parse(readFileSync(path, "utf-8"));
        const summary = saved.summary as TaskSummary;
        // 旧版遗留的交付方式("快速/慢速"是宿主自造的词,内核不认):
        // 留着它,预答会永远命中不了内核举的卡——续跑的老单看起来就是
        // "更新了还在中途问交付方式"。清掉+留痕,让老单诚实地走真等人。
        const laneChoices = workflowChoices(this.options.host?.kernelRoot)
          .map((item) => item.label);
        if (summary.lane && laneChoices.length
            && !laneChoices.includes(summary.lane)) {
          this.options.log?.(
            `任务 ${summary.id} 的交付方式「${summary.lane}」不在内核选项`
            + `(${laneChoices.join("/")})里——旧版自造的词,已清除;`
            + `流程举卡时将真等人,答卡请选内核选项原文`);
          summary.lane = undefined;
        }
        const task: TaskState = {
          summary,
          tokenUsage: restoreTokenUsageState(saved.token_usage_state),
          humanGate: new HumanGate(join(workspace, "waiting.json")),
          cwd: typeof saved.cwd === "string" ? saved.cwd : undefined,
          resume: true,
          mission: typeof saved.mission === "string"
            ? saved.mission : undefined,
          pendingAssistantHandoff:
            typeof saved.assistant_handoff === "string"
              ? saved.assistant_handoff : undefined,
          pendingMainSteers: Array.isArray(saved.pending_main_steers)
            ? saved.pending_main_steers.map(String).filter(Boolean) : undefined,
          assistantEpoch: 0,
          appliedDeveloperInterventionId:
            typeof saved.applied_developer_intervention_id === "string"
              ? saved.applied_developer_intervention_id : undefined,
          obsoleteDeveloperWaiting:
            saved.obsolete_developer_waiting
              && typeof saved.obsolete_developer_waiting.waitingId === "string"
              && Number.isInteger(saved.obsolete_developer_waiting.stateVersion)
              ? saved.obsolete_developer_waiting : undefined,
          lastPersistedStatus: summary.status,
          // 上一段进程记下的通知投递结果(含"没送到"红旗)要跟着回来,
          // 页面才不会把投递失败演成"通知过了"。
          notifyRecord: saved.notify_record
              && typeof saved.notify_record.waiting_id === "string"
            ? saved.notify_record as NotifyRecord : undefined,
          controlEpoch: 0,
        };
        this.tasks.set(summary.id, task);
        this.reconcileResolvedDecisionAnnotations(task);
        const authoritativeWaiting = summary.waiting
          ? task.humanGate.get(summary.waiting.waiting_id) : undefined;
        // 旧版本把 repairing 一直保留到流水线最终绿灯。若修复使命已经
        // 消费完，真实当前动作其实是 prepush/流水线验证；恢复时同步
        // 校正，不能让重新部署后的老任务继续同时显示两种当前阶段。
        if (this.enterRepairVerification(task)) this.persist(task);
        const assistantSnapshot = readDeveloperAssistant(workspace);
        if (assistantSnapshot.handoff?.id
            && assistantSnapshot.handoff.state !== "returned"
            && task.appliedDeveloperInterventionId
              === assistantSnapshot.handoff.id) {
          const obsolete = task.obsoleteDeveloperWaiting;
          if (obsolete) {
            this.supersedeWaitingForUserIntervention(task, {
              waiting_id: obsolete.waitingId,
              state_version: obsolete.stateVersion,
            });
          }
          this.markPreparedDeveloperAssistantReturned(task);
        }
        this.counter = Math.max(
          this.counter, Number(name.slice("task-".length)) || 0);
        restored += 1;
        let terminalMismatch = false;
        // 现场回收过的单:内核状态原件已经删了,再对账一次必然"读不到证据"
        // → 老单被翻成验证中,tryDeliver 甚至会把早已合入的分支重新推回去。
        // 这正是"老单不被新尺子重新量"那条教训的同一个坑,只是这回尺子
        // 是我们自己弄丢的。回收 = 台账封存,不再重新裁决。
        if (["completed", "await_merge"].includes(summary.status)
            && !summary.workspace_reclaimed_at
            && !this.settledBeforeContract(task)) {
          const attestation = this.completionAttestation(task);
          if (attestation && !attestation.complete) {
            terminalMismatch = true;
            delete summary.completed_at;
            if (attestation.kind === "external_verify"
                || (attestation.terminal && attestation.external_required)) {
              // 进程可能死在“平台已回结果→内核登记→状态投影”之间。
              // 恢复只重做对账/核销，不拿旧 task.json 直接放行。
              summary.status = "verifying";
              summary.detail = `恢复对账：${attestation.reason}`;
              summary.delivery = {
                ...summary.delivery,
                mr_state: "验证中",
                waiting_on: attestation.reason,
              };
            } else {
              summary.status = "queued";
              summary.detail = `恢复对账发现伪终态：${attestation.reason}，`
                + "将从内核 current 继续";
              task.resume = true;
            }
            this.persist(task);
          }
        }
        this.replayProjection(task);
        const reviewOutboxStalled = this.reviewReplyOutboxStalled(task);
        if (!["completed", "canceled"].includes(summary.status)
            && summary.status !== "await_merge"
            && !reviewOutboxStalled
            && summary.delivery?.git_push?.sha) {
          this.bypass(task, "检视回复 outbox 恢复",
            this.flushReviewReplyOutbox(task));
        }
        // 服务在“正在暂停”窗口退出时，所有执行资源已经随进程消失；
        // 恢复为 paused 比擅自续跑更符合用户最后一次明确指令。
        if (summary.status === "pausing") {
          summary.status = "paused";
          summary.detail = "服务重启时已完成暂停";
          summary.control = {
            ...(summary.control ?? {
              last_action: "pause",
              actor: "系统",
              at: new Date().toISOString(),
            }),
            last_action: "pause",
            paused_from: summary.control?.paused_from ?? "running",
          };
          this.persist(task);
        }
        if (summary.status === "paused"
            && readDeveloperAssistant(workspace).state === "acquiring") {
          this.activatePendingDeveloperAssistant(task);
        }
        const prepushRecovery = this.reconcileInterruptedPrePush(task);
        if (prepushRecovery !== "none") {
          if (prepushRecovery === "scheduled") requeued += 1;
          // prepush 是独立交付会话；已经接管或明确停机后，不得再掉进
          // 通用 verifying/任务队列分支启动第二条恢复链。
          continue;
        }
        // 进程可死,轮询不死:重启前在等流水线的任务续轮
        // (锚是 delivery.sha,结果仍只认绑定版本)。
        if (summary.status === "verifying" && reviewOutboxStalled) {
          // delivery-outbox.jsonl 是可由管理员原地修复的持久化账本。
          // 修复后须在本进程续接 tryDeliver，不能只清掉 stalled 后等
          // 第二次重启才继续交付。
          this.scheduleDeliveryRecovery(task, task.controlEpoch);
        } else if (summary.status === "verifying"
            && summary.delivery?.evidence_gap
            && summary.delivery.sha) {
          // 红灯证据缺口是交付侧等待，不是内核编码会话停机。进程重启后
          // 继续从同一 SHA 取证/分诊；不能走 tryDeliver 重做 prepush，
          // 更不能把主 Agent 从 current 重新拉起来猜改。
          const gap = summary.delivery.evidence_gap;
          const max = summary.repair_rounds
            ?? this.options.settings?.runtime().repair_rounds
            ?? this.options.delivery?.repairRounds;
          this.bypass(task, "流水线失败证据恢复",
            this.dispatchCiRepair(task, summary.delivery.sha,
              gap.failure_log ?? "", max, task.controlEpoch));
        } else if (summary.status === "verifying"
            && summary.delivery?.pipeline?.startsWith("running")) {
          // 前缀匹配而非全等:预算耗尽/拒陈灯会把 pipeline 写成
          // "running(轮询预算耗尽…)" 之类带注记的形态。它们语义上仍是
          // "远端在跑/该继续盯",全等匹配会把这类任务漏到下面的
          // tryDeliver 兜底里重建 MR + 同 SHA 重触发流水线
          // (2026-08-29 部署审计实锤:每次重启白烧一条)。重启=新预算,
          // 续轮即可,终态自然落袋。
          this.bypass(task, "流水线轮询",
            this.pollPipeline(task, task.controlEpoch));
        } else if (summary.status === "verifying"
            && summary.delivery?.pipeline === "success"
            && summary.delivery.sha) {
          // 平台已绿但内核还没 PASS（进程可能死在登记窗口，或当时逐项
          // 结果不完整）：重启只重做核销，不重复触发同 SHA 流水线。
          this.bypass(task, "流水线证据核销",
            this.tryDeliver(task, task.controlEpoch));
        } else if (summary.status === "verifying"
            && !summary.delivery?.stalled) {
          // 没有可续轮的旧平台状态也不能静默蹲住；让 tryDeliver 查远端
          // 分支并触发/恢复权威验证，仍由内核裁决是否能到 end。
          // 这一支原来只认 terminalMismatch(落盘是 completed/await_merge
          // 的伪终态),于是"落盘就是 verifying、连平台状态都没有"的那类
          // ——推送失败停在等待点的——重启后一行代码都不碰它,永远蹲着
          // (实测)。已经如实停摆的不动:那是在等人,不是在等机器。
          this.bypass(task, "验证恢复对账",
            this.tryDeliver(task, task.controlEpoch));
        }
        // 合入监控同理续:重启前在等合入/等审批的接着盯(平台不支持
        // 门禁契约的,watchMerge 一轮就退,行为与旧版完全一致)。
        if (summary.status === "await_merge") {
          this.bypass(task, "合入监控",
            this.watchMerge(task, task.controlEpoch));
        }
        // 旧版本可能把一个已经 resolved 的 WaitingRecord 再次写成
        // waiting_for_human(重建会话重放同 call_id 时发生)。这是矛盾
        // 状态:人已经答过,页面却还在催人。恢复时以 waiting.json 的
        // resolved 事实为准,自动续跑并把原决定带回重建会话。
        if (summary.status === "waiting_for_human"
            && authoritativeWaiting?.status === "resolved") {
          // task.json 只是页面投影副本，真正的决定在 waiting.json。
          // 旧代码检查 summary.waiting.status，恰好检查了崩溃前的 stale
          // 副本，注释写着“以 waiting.json 为准”却从未读它。
          this.bypass(task, "已决待办恢复对账",
            this.resumeResolvedDecision(task, authoritativeWaiting));
          requeued += 1;
        } else if (summary.status === "running" || summary.status === "queued") {
          summary.status = "queued";
          summary.detail = this.options.requirementDisabled
            ? "问题流专用部署(--issue-only),需求流程未加载;"
              + "用完整部署重启后自动续跑"
            : (terminalMismatch ? summary.detail : "服务重启,等待续跑");
          this.persist(task);
          this.queue.push(summary.id);
          requeued += 1;
        }
      } catch (error) {
        this.options.log?.(`恢复 ${name} 失败: ${String(error)}`);
      }
    }
    if (this.counter > 0) {
      try {
        this.persistTaskSequence();
      } catch (error) {
        this.options.log?.(`任务编号水位落盘失败: ${String(error)}`);
      }
    }
    if (requeued) this.bypass(undefined, "任务泵", this.pump());
    return { restored, requeued };
  }

  /** 现场保留期(天):管理页运行时设置 > 部署值 > 默认 14 天。
   * 0 = 永不回收(诚实的"关掉",不是偷偷不干活)。 */
  workspaceRetentionDays(): number {
    const runtime = this.options.settings?.runtime().workspace_retention_days;
    const value = runtime ?? this.options.workspaceRetentionDays
      ?? DEFAULT_WORKSPACE_RETENTION_DAYS;
    return Number.isFinite(value) && value >= 0
      ? value : DEFAULT_WORKSPACE_RETENTION_DAYS;
  }

  buildCacheRetentionDays(): number {
    const runtime = this.options.settings?.runtime().build_cache_retention_days;
    const value = runtime ?? this.options.buildCacheRetentionDays
      ?? DEFAULT_BUILD_CACHE_RETENTION_DAYS;
    return Number.isFinite(value) && value >= 0
      ? value : DEFAULT_BUILD_CACHE_RETENTION_DAYS;
  }

  buildCacheMaxGb(): number {
    const runtime = this.options.settings?.runtime().build_cache_max_gb;
    const value = runtime ?? this.options.buildCacheMaxGb
      ?? DEFAULT_BUILD_CACHE_MAX_GB;
    return Number.isFinite(value) && value >= 0
      ? value : DEFAULT_BUILD_CACHE_MAX_GB;
  }

  /**
   * 真正占用缓存的容器 + 仍可能继续执行的任务共同构成租约。
   * 后者覆盖服务刚恢复、任务已入队但容器尚未创建的窄竞态。
   */
  private activeBuildCacheKeys(): Set<string> {
    const keys = new Set<string>();
    for (const context of this.activeContainerContexts.values()) {
      context.cacheKeys.forEach((key) => keys.add(key));
    }
    if (!this.options.isolation?.cacheRoot) return keys;
    for (const task of this.tasks.values()) {
      if (HARD_DELETE_STATUSES.includes(task.summary.status)) continue;
      const repository = task.summary.repo_url
        ?? this.effectiveDefaultRepo()
        ?? task.cwd
        ?? task.summary.id;
      keys.add(buildCacheKey(repository));
    }
    return keys;
  }

  async buildCacheStatus(): Promise<BuildCacheStatus> {
    return inspectBuildCaches({
      cacheRoot: this.options.isolation?.cacheRoot,
      activeKeys: this.activeBuildCacheKeys(),
      retentionDays: this.buildCacheRetentionDays(),
      maxBytes: this.buildCacheMaxGb() * 1024 ** 3,
    });
  }

  async reclaimIdleBuildCaches(options: {
    allUnused?: boolean;
    now?: number;
  } = {}): Promise<BuildCacheReclaimResult> {
    if (this.buildCacheReclaimActive) {
      throw new TaskControlError("构建缓存正在清理，请稍后重试");
    }
    this.buildCacheReclaimActive = true;
    try {
      const result = await reclaimBuildCaches({
        cacheRoot: this.options.isolation?.cacheRoot,
        activeKeys: () => this.activeBuildCacheKeys(),
        retentionDays: this.buildCacheRetentionDays(),
        maxBytes: this.buildCacheMaxGb() * 1024 ** 3,
        allUnused: options.allUnused,
        now: options.now,
      });
      if (result.reclaimed || result.failed.length || result.skipped_active) {
        this.options.log?.(`[build-cache] 回收 ${result.reclaimed} 个分区，释放 `
          + `${humanBytes(result.freed_bytes)}`
          + `${result.skipped_active ? `，跳过占用中 ${result.skipped_active} 个` : ""}`
          + `${result.failed.length ? `，失败 ${result.failed.length} 个` : ""}`);
      }
      return result;
    } finally {
      this.buildCacheReclaimActive = false;
    }
  }

  /**
   * 扫一遍终态任务,回收过了保留期的现场(纯旁路,fail-open)。
   *
   * 由 serve 定时驱动,不在这里起 setInterval——TaskService 一直没有自己的
   * 定时器,加一个就多一个重启后忘了清的句柄。
   *
   * 只删克隆等能再生的重货,台账原样留下(见 workspaceReclaim.ts)。
   * 回收后把 workspace_reclaimed_at 记进 task.json:页面据此如实说
   * "现场已回收",恢复时据此**不再重新裁决**这单。
   */
  reclaimIdleWorkspaces(now = Date.now()): {
    reclaimed: number; freed: number;
  } {
    const retentionDays = this.workspaceRetentionDays();
    let reclaimed = 0;
    let freed = 0;
    for (const task of this.tasks.values()) {
      const summary = task.summary;
      const verdict = judgeReclaim({
        id: summary.id,
        status: summary.status,
        workspace: summary.workspace,
        completed_at: summary.completed_at,
        updated_at: summary.updated_at,
        created_at: summary.created_at,
        workspace_reclaimed_at: summary.workspace_reclaimed_at,
      }, {
        now,
        retentionDays,
        // 状态是收口那一刻写的,清理和收尾可能正擦肩而过:句柄还在就不碰。
        busy: !!task.driver || !!task.container || !!task.containerReopen,
      });
      if (!verdict.reclaim) continue;
      try {
        const result = reclaimWorkspace(summary.workspace, {
          cwd: task.cwd,
          // 现场路径是任务创建时写死的绝对路径,现场目录被拷走/搬走之后
          // 它会指向别处——删除动作必须自己验边界,不能信这个字段。
          dataDir: this.options.dataDir,
        });
        if (result.refused) {
          this.options.log?.(`回收现场 ${summary.id} 被边界拦下: ${result.refused}`);
          continue;
        }
        summary.workspace_reclaimed_at = new Date(now).toISOString();
        this.persist(task);
        reclaimed += 1;
        freed += result.freed;
        this.options.log?.(
          `回收现场 ${summary.id}(${verdict.reason}):释放 `
          + `${humanBytes(result.freed)},删除 ${result.removed.join("、") || "无"}`
          + `;台账与证据保留${result.snapshotted ? ",内核阶段已留档" : ""}`);
      } catch (error) {
        // 回收是旁路:删不动就是磁盘没省下来,绝不许它影响任务读写。
        this.options.log?.(`回收现场 ${summary.id} 失败: ${String(error)}`);
      }
    }
    return { reclaimed, freed };
  }

  /** 恢复重放投影(§11):以现场文件为源补齐读侧——摘要整行覆盖,
   * 事件副本重灌((taskId,eventId) 幂等锚把重复兜成 no-op)。
   * 现场文件损坏只影响投影补齐,不影响任务恢复本身。 */
  private replayProjection(task: TaskState): void {
    const projection = this.options.projection;
    if (!projection) return;
    this.bypass(task, "投影 upsert",
      projection.upsertTask(this.project(task)));
    try {
      const log = new EventLog(
        join(task.summary.workspace, "events.jsonl"));
      for (const event of log.replay()) {
        this.bypass(task, "投影事件", projection.appendEvent(event));
      }
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 投影重放失败: ${String(error)}`);
    }
  }

  /** 重跑一单:completed/failed 的任务重新入队,host 模式以内核
   * current 为锚续跑。用于环境修复后续推(run7-resume 实测:容器
   * 被并行实例误杀,整单被迫收口,内核还停在 verify_ut——环境
   * 修好后流程应当接着推,而不是从头再来)。
   *
   * verifying 的准入按事实收窄:只有修复环停机(halted/exhausted)
   * 或轮询预算耗尽的才许重跑——在途轮询/修复中点重跑只会重复烧
   * 流水线。停机重跑=人工背书"外部的事我办完了/值得再试":清掉
   * 停机账本,同 SHA 也给全新的修复机会(halted 的 last_sha 刹车
   * 挡的是"机器无人看管地空转",不该挡人工明确授权的再来一次)。 */
  /** 用户显式跳过推送前验证(仅失败停机后可用)。本地验证是省流水线
   * 的前闸,不是权威——权威裁决在绑 SHA 流水线,所以这是"fail-closed
   * 停下后由人接手"的合法出路,不是自动降级。跳过绑当下 HEAD:之后
   * 出现新提交,跳过即失效,重新走真验证(旧拍板不背书新代码)。 */
  async skipPrePushVerification(
    id: string,
    actor?: string,
  ): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (task.prepushActive) {
      throw new TaskControlError("Build-Fix 正在进行中，不能跳过");
    }
    const prepush = task.summary.delivery?.prepush;
    if (!prepush
        || !["blocked", "environment_error"].includes(prepush.state)) {
      throw new TaskControlError(
        "只有 Build-Fix 失败停机后才能跳过；当前没有可跳过的失败验证");
    }
    if (!task.cwd) {
      throw new TaskControlError("代码现场不可用,无法绑定跳过时刻的 HEAD");
    }
    const revision = await this.prePushRevision(task);
    this.setPrePushState(task, {
      ...prepush,
      state: "user_skipped",
      // 恒填(无鉴权部署记"用户"):它同时是 MR 标记的判据——只有
      // "编译失败后人工跳过"这条路打标,清单整理的 user_skipped 不打
      // (那是 prepush 已通过后的机械调整,恐吓性标记会误伤常规流)。
      skipped_by: actor ?? "用户",
      sha: revision.sha,
      workspace_fingerprint: revision.workspace_fingerprint,
      message: `${actor ?? "用户"}选择跳过本地验证,`
        + "编译与 UT 交由权威流水线裁决",
      updated_at: new Date().toISOString(),
    });
    this.persist(task);
    // 复用「重跑续推」的恢复链路续接交付;交付环走到 preparePush 时
    // 命中同 HEAD 的跳过放行,不再起验证 Agent。
    return this.retry(id, actor);
  }

  /** 用户显式重跑推送前编译。实锤场景(2026-08-27 内网):部署重启杀掉
   * 在途编译轮后,任务停在 verifying、prepush 停在 preparing,而
   * 「重跑续推」按 verifying 在途拒绝——人对着僵尸现场没有任何出路。
   * 这个口子同时是活性探针:真在跑时 prepushActive 挡住并明说
   * "正在进行",人立刻知道不是卡死。只动 prepush,不重排内核会话。 */
  async retryPrePush(id: string, actor?: string): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (task.prepushActive) {
      throw new TaskControlError(
        "Build-Fix 正在进行中（本进程内有在途轮），不是卡死；"
        + "等本轮收口或失败停机后再重跑");
    }
    if (task.driver || task.container) {
      throw new TaskControlError(
        "任务的执行资源尚未释放（会话或容器仍在），不能重跑 Build-Fix");
    }
    const prepush = task.summary.delivery?.prepush;
    if (!prepush) {
      throw new TaskControlError("该任务还没有 Build-Fix 现场，无可重跑");
    }
    if (prepush.state === "passed") {
      throw new TaskControlError(
        "Build-Fix 已通过，收据仍绑定当前 HEAD，无需重跑");
    }
    if (!task.cwd) {
      throw new TaskControlError("代码现场不可用，无法重跑 Build-Fix");
    }
    if (!["verifying", "failed"].includes(task.summary.status)) {
      throw new TaskControlError(
        `任务状态是 ${task.summary.status},只有 verifying/failed 的任务`
        + "能重跑 Build-Fix");
    }
    const epoch = task.controlEpoch;
    task.summary.status = "verifying";
    task.summary.detail = actor
      ? `人工重跑 Build-Fix(${actor})` : "人工重跑 Build-Fix";
    this.persist(task);
    // 交付链自己会收口僵尸 attempt(restore 的 recovered 转移)并起新轮;
    // 这里只负责把链路重新踢活。
    this.bypass(task, "Build-Fix 人工重跑",
      this.resumePrePushVerification(task, epoch));
    return this.project(task);
  }

  /** 用户主动停止在途的推送前编译并直推流水线(2026-08-27 用户拍板:
   * "把停止变为停止并直推流水线")。语义是两步一次点完:先中止本轮
   * (在跑的走 prepushAbort;还在排编译槽位队的直接出队——这条路不
   * 经过 runner 收口,得在这里如实补账,否则留下 preparing 僵尸),
   * 收口成失败停机后立刻走跳过链路(绑当下 HEAD 的 user_skipped,
   * 编译与 UT 交由权威流水线裁决,任务自动续跑)。不是静默放行:
   * 停机账、跳过拍板都如实落在现场里。两个例外:本轮在停止瞬间已经
   * 通过的,按通过继续推,不冤枉它;暂停中的任务只停不推——暂停是
   * 用户更早的明确指令,不许被顺手续跑。 */
  async stopPrePush(id: string, actor?: string): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const active = task.prepushActive;
    if (!active) {
      throw new TaskControlError(
        "当前没有在途的 Build-Fix；失败停机后请用重跑或跳过");
    }
    // 中止要反复补刀直到本轮真正收口:prepushAbort 在拿到编译槽位后
    // 才创建、排队 waiter 也是晚注册的,单发 abort 会打空(竞态)。
    // 这个等待有出路——attempt 预算兜底,绝不会无限等。
    const closed = active.then(() => true, () => true);
    for (;;) {
      this.removePrePushBuildWaiter(task);
      task.prepushAbort?.abort();
      const done = await Promise.race([
        closed,
        new Promise<false>((tick) => setTimeout(() => tick(false), 200)),
      ]);
      if (done) break;
    }
    const prepush = task.summary.delivery?.prepush;
    if (prepush && !["passed", "blocked", "environment_error", "user_skipped"]
      .includes(prepush.state)) {
      // 排队被打断的路径没有 runner 报告,补一笔如实的停机账。
      this.setPrePushState(task, {
        ...prepush,
        state: "environment_error",
        active_attempt: undefined,
        message: `${actor ?? "用户"}停止了本轮 Build-Fix，直推流水线裁决`,
        updated_at: new Date().toISOString(),
      });
    }
    // 停止瞬间恰好收口通过的:交付链已按收据继续推,别再动它。
    const closedState = task.summary.delivery?.prepush?.state;
    if (closedState === "passed") {
      this.persist(task);
      return this.project(task);
    }
    if (["paused", "pausing", "canceled"].includes(task.summary.status)) {
      // 暂停/取消是用户更早的明确指令,只停编译,不顺手续跑去推。
      task.summary.detail = "Build-Fix 已由用户停止";
      this.persist(task);
      return this.project(task);
    }
    task.summary.status = "failed";
    task.summary.detail = "Build-Fix 已由用户停止，转直推流水线";
    this.persist(task);
    // 停止并直推:失败停机后立刻走既有跳过链路(绑 HEAD 的
    // user_skipped + retry 续跑),语义与人分两步点完全一致。
    return this.skipPrePushVerification(id, actor);
  }

  retry(id: string, actor?: string): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const { status, delivery } = task.summary;
    // stalled = 外部验证的自愈预算已经烧完并如实停下(推送一直失败、
    // 流水线迟迟不给可核销结果……)。它必须和修复环停机同等对待:
    // 那种状态下没有任何东西在收敛,再拦着人重跑就是把任务锁死。
    const evidenceStopped = delivery?.evidence_gap?.state === "waiting_human";
    const repairStopped = delivery?.loop?.state === "halted"
      || delivery?.loop?.state === "exhausted"
      || Boolean(delivery?.stalled)
      || evidenceStopped
      || (delivery?.pipeline ?? "").includes("轮询预算耗尽");
    if (status === "verifying" && !repairStopped) {
      throw new NotFoundError(
        `任务 ${id} 流水线验证还在进行中,重跑会重复烧流水线;` +
        `等它收敛或停机后再说`);
    }
    if (!["completed", "failed", "verifying"].includes(status)) {
      throw new NotFoundError(
        `任务 ${id} 状态是 ${status},只有 completed/failed/停机的 verifying 可重跑`);
    }
    if (task.container || task.driver) {
      throw new TaskControlError(
        `任务 ${id} 上一次执行资源尚未确认释放，拒绝重跑；`
        + "请先取消重试或重启服务触发 ownership 清扫",
      );
    }
    if (status === "verifying" && evidenceStopped && delivery?.evidence_gap) {
      // 人点“重试”只重新打开平台取证预算；它不是授权主 Agent 在没有
      // 报错时重跑编码，也不应凭空消耗 CI 修复轮次。
      const gap = delivery.evidence_gap;
      gap.state = "retrying";
      gap.attempts = 0;
      gap.retry_deadline = new Date(
        Date.now() + this.repairEvidenceBudgetMs()).toISOString();
      gap.notified_at = undefined;
      delivery.pipeline = "failed(人工要求重新取证)";
      delivery.waiting_on = "正在重新拉取流水线具体报错，尚未派 Agent";
      task.summary.detail = delivery.waiting_on;
      this.persist(task);
      const max = task.summary.repair_rounds
        ?? this.options.settings?.runtime().repair_rounds
        ?? this.options.delivery?.repairRounds;
      this.bypass(task, "人工重试流水线失败证据",
        this.dispatchCiRepair(task, gap.sha, gap.failure_log ?? "",
          max, task.controlEpoch));
      return { ...task.summary };
    }
    // 检视轮因缺逐条回执停机时,generic retry 曾把 loop 连同批注 id、
    // review_source 一起清空——批注停在 sent、恢复意图全丢,唯一出路
    // 变成删批注(e2e-picky-20260830 双复现,MFC-003)。这里改成保留
    // 检视账,派一条"只补回执"的窄使命,不清 loop、不烧无关修复。
    if (status === "verifying") {
      const loop = task.summary.delivery?.loop;
      const pendingReview = loop?.kind === "review"
        && loop.review_source === "workspace"
        ? unansweredAnnotations(this.annotations(task).list(),
            loop.workspace_review_annotation_ids ?? [])
        : [];
      if (loop && pendingReview.length) {
        loop.state = "repairing";
        loop.diagnosis = undefined;
        task.summary.delivery!.stalled = undefined;
        task.summary.delivery!.waiting_on = undefined;
        task.summary.delivery!.verify_deadline = undefined;
        task.summary.delivery!.pipeline = "人工重跑,补齐检视回执";
        this.enqueueRepair(task, [
          "上一轮检视修改已经完成,但缺少机器可核对的逐条回执,系统据此停下。",
          "本次使命只有一件事:复核当前 HEAD 上这些意见的落实情况并补写回执;",
          "不要重新修改代码,除非复核发现某条意见确实没有落实。",
          workspaceReviewReceiptInstructions(pendingReview),
        ].join("\n"), "人工重跑:复核当前 HEAD 并补齐逐条检视回执");
        return { ...task.summary };
      }
    }
    // 外部交付接口停机只需要宿主重试 MR / 流水线。旧实现把任务重新
    // 入 Agent 队列，模型醒来后只能读到 external_verify 再原样结束：
    // 用户白等一轮还多烧 token。没有修复环、没有证据缺口时，清掉
    // 上一轮事故牌并直接踢活交付链。
    if (status === "verifying" && delivery?.stalled
        && !delivery.loop && !delivery.evidence_gap) {
      delivery.pipeline = "人工重跑,待重新验证";
      delivery.stalled = undefined;
      delivery.verify_deadline = undefined;
      delivery.skipped = undefined;
      delivery.waiting_on = undefined;
      task.summary.detail = actor
        ? `人工重新尝试交付(${actor})` : "人工重新尝试交付";
      this.persist(task);
      this.bypass(task, "人工重新尝试交付",
        this.tryDeliver(task, task.controlEpoch));
      return this.project(task);
    }
    if (status === "verifying" && task.summary.delivery) {
      task.summary.delivery.loop = undefined;
      task.summary.delivery.evidence_gap = undefined;
      task.summary.delivery.pipeline = "人工重跑,待重新验证";
      // 人工背书"再试一次":停摆账本清掉,自愈预算重新开表。
      task.summary.delivery.stalled = undefined;
      task.summary.delivery.verify_deadline = undefined;
      // 失败原因属于上一轮事故；续推已经受理后继续把它渲染成
      // “交付已阻止”，会与正在运行的新状态互相矛盾。历史仍在诊断包
      // 与服务日志里，当前态只保留这一轮的事实。
      task.summary.delivery.skipped = undefined;
      task.summary.delivery.waiting_on = undefined;
    }
    task.summary.status = "queued";
    delete task.summary.completed_at;
    task.summary.detail = actor
      ? `人工重跑(${actor}),续接内核当前步骤` : "人工重跑,续接内核当前步骤";
    task.resume = true;
    this.persist(task);
    this.queue.push(id);
    this.bypass(undefined, "任务泵", this.pump());
    return { ...task.summary };
  }

  /** 从头重跑不是 retry：它原位覆盖同一个 task-N，只继承下单配置与
   * 结构关系，不继承工作区、流程进度、人工卡、交付结果或检视记录。 */
  async rerunFromStart(id: string): Promise<TaskSummary> {
    const release = this.beginHistoryMutation(id);
    try {
      return await this.rerunFromStartLocked(id);
    } finally {
      release();
    }
  }

  private async rerunFromStartLocked(id: string): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (!HARD_DELETE_STATUSES.includes(task.summary.status)) {
      throw new TaskControlError(
        `任务 ${id} 当前是 ${task.summary.status}，只有 completed/failed/canceled`
        + " 的任务可以从头重跑",
      );
    }
    if (task.driver || task.container || task.containerReopen
        || task.prepushActive || task.assistantActive
        || task.mergeWatchActive || task.evidenceRetryActive
        || task.repairEvidenceRetryActive
        || task.deliveryRecoveryActive || task.reviewOutboxFlush) {
      throw new TaskControlError(
        `任务 ${id} 仍有执行资源或后台收尾动作，暂不能从头重跑`,
      );
    }
    const generatedChildren = task.summary.requirement_graph?.repositories
      .flatMap((repository) => repository.task_id ? [repository.task_id] : [])
      ?? [];
    if (generatedChildren.length) {
      throw new TaskControlError(
        `该跨仓父任务已生成子任务 ${generatedChildren.join("、")}；`
        + "原位重跑会造成重复拆单，请在对应子任务上分别从头重跑",
      );
    }
    const source = task.summary;
    const preserveUndefinedRepositorySkills =
      source.repository_skills === undefined;
    const workspace = resolve(this.options.dataDir, id);
    const dataRoot = resolve(this.options.dataDir);
    const backup = join(dataRoot, `.${id}.rerun-${randomUUID()}`);
    const createOptions = {
      title: source.title,
      account: source.luban_account,
      repo: source.repo_url,
      repos: source.repositories ? [...source.repositories] : undefined,
      lane: source.lane,
      ticket: source.ticket,
      baseline: source.baseline,
      model: source.model_choice ? { ...source.model_choice } : undefined,
      repairRounds: source.repair_rounds,
      repositorySupplementResolved: source.repository_supplement_resolved,
      workflowProfile: source.workflow_profile,
      workflowProfileWarning: source.workflow_profile_warning,
      requirementDocumentName: source.requirement_document?.name,
      internalRequirement: Boolean(source.parent_task_id),
      parentTaskId: source.parent_task_id,
      blockedBy: source.blocked_by ? [...source.blocked_by] : undefined,
      repositorySkills: preserveUndefinedRepositorySkills
        ? undefined
        : source.repository_skills!.map((item) => ({ ...item })),
      businessModules: (source.business_modules ?? []).map((module) => ({
        ...module,
        assets: module.assets.map((asset) => ({ ...asset })),
      })),
      businessModuleSourceWorkspace: backup,
      repositoryProfiles: source.repository_profiles?.map((item) => ({ ...item })),
      engineeringKnowledge: (source.engineering_knowledge ?? [])
        .map((item) => ({ ...item })),
      engineeringKnowledgeSourceWorkspace: backup,
      hostSkillSnapshotSourceWorkspace: backup,
      preserveUndefinedRepositorySkills,
      reuseTaskId: id,
      deferQueue: true,
    };

    if (dirname(workspace) !== dataRoot) {
      throw new TaskControlError(`任务 ${id} 的重建路径越过数据目录边界`);
    }
    if (existsSync(workspace) && !lstatSync(workspace).isSymbolicLink()) {
      const realRoot = realpathSync(dataRoot);
      const realWorkspace = realpathSync(workspace);
      if (dirname(realWorkspace) !== realRoot) {
        throw new TaskControlError(`任务 ${id} 的真实路径越过数据目录边界`);
      }
    }
    const hadWorkspace = existsSync(workspace);
    let movedWorkspace = false;

    try {
      if (this.options.projection) {
        await this.options.projection.deleteTask(id, true);
      }
      // 数据库事务期间原现场保持原位；这样进程若在 await 中退出，重启
      // 仍能从 task.json 恢复并重放投影。其后的替换均为同步文件操作。
      if (hadWorkspace) {
        renameSync(workspace, backup);
        movedWorkspace = true;
      }
      this.removeFromQueue(id);
      this.tasks.delete(id);
      const replacement = this.create(source.requirement, createOptions);
      this.reviews.purgeTask(id);
      this.options.notifier?.purgeTask(id);
      if (hadWorkspace) removeTaskTree(backup);
      this.queue.push(id);
      this.bypass(undefined, "任务泵", this.pump());
      return replacement;
    } catch (error) {
      this.removeFromQueue(id);
      this.tasks.delete(id);
      removeTaskTree(workspace);
      if (movedWorkspace && existsSync(backup)) renameSync(backup, workspace);
      this.tasks.set(id, task);
      this.persist(task);
      throw error;
    }
  }

  /** 管理员彻底删除一张真终态历史。外部 Git/MR 本身不属于 Cloud
   * 存储，不在此处远程销毁；Cloud 内的工作区、凭据、检视、引用和
   * PostgreSQL 投影全部清理。 */
  async hardDeleteHistory(id: string): Promise<TaskDeletionResult> {
    const release = this.beginHistoryMutation(id);
    try {
      return await this.hardDeleteHistoryLocked(id);
    } finally {
      release();
    }
  }

  private async hardDeleteHistoryLocked(id: string): Promise<TaskDeletionResult> {
    const taskNumber = /^task-(\d+)$/.exec(id)?.[1];
    const numericId = Number(taskNumber);
    if (!taskNumber || !Number.isSafeInteger(numericId) || numericId < 1) {
      throw new NotFoundError(`任务 ${id} 不存在`);
    }
    const task = this.tasks.get(id);
    if (task && !HARD_DELETE_STATUSES.includes(task.summary.status)) {
      throw new TaskControlError(
        `任务 ${id} 当前是 ${task.summary.status}，只能彻底删除 `
        + "completed/failed/canceled 的历史任务",
      );
    }
    if (task && (task.driver || task.container || task.containerReopen
        || task.prepushActive || task.assistantActive
        || task.mergeWatchActive || task.evidenceRetryActive
        || task.repairEvidenceRetryActive
        || task.deliveryRecoveryActive || task.reviewOutboxFlush)) {
      throw new TaskControlError(
        `任务 ${id} 仍有执行资源或后台收尾动作，拒绝彻底删除`,
      );
    }
    const liveReferences = [...this.tasks.values()].filter((other) =>
      other !== task && !HARD_DELETE_STATUSES.includes(other.summary.status)
      && (other.summary.parent_task_id === id
        || other.summary.blocked_by?.includes(id)));
    if (liveReferences.length) {
      throw new TaskControlError(
        `任务 ${id} 仍被未终止任务 ${liveReferences
          .map((item) => item.summary.id).join("、")} 引用，`
        + "请先让关联任务收口或取消，拒绝删除后改变其调度语义",
      );
    }

    // 先把删除目标解析到 dataDir 的直属 task-N；绝不信 task.json 里的
    // workspace 字段。目录若是软链，后续只 unlink 软链本身，不跟出去。
    const dataRoot = resolve(this.options.dataDir);
    const workspace = resolve(dataRoot, id);
    if (dirname(workspace) !== dataRoot) {
      throw new TaskControlError(`任务 ${id} 的删除路径越过数据目录边界`);
    }
    if (existsSync(workspace) && !lstatSync(workspace).isSymbolicLink()) {
      const realRoot = realpathSync(dataRoot);
      const realWorkspace = realpathSync(workspace);
      if (dirname(realWorkspace) !== realRoot) {
        throw new TaskControlError(`任务 ${id} 的真实路径越过数据目录边界`);
      }
    }

    // projection-only 的历史编号也可能高于本机仍保留的现场。先封存水
    // 位再删，避免下一次重启把已经发出去过的永久链接复用给别的任务。
    this.counter = Math.max(this.counter, numericId);
    this.persistTaskSequence();

    const projection = this.options.projection;
    const projected = projection
      ? await projection.deleteTask(id, Boolean(task))
      : { found: false, deleted: false };
    if (!task && !projected.found) {
      throw new NotFoundError(`任务 ${id} 不存在`);
    }
    if (projected.found && !projected.deleted) {
      throw new TaskControlError(
        `任务 ${id} 的历史状态是 ${projected.status}，只能彻底删除 `
        + "completed/failed/canceled 的历史任务",
      );
    }

    const reviewsRemoved = this.reviews.purgeTask(id);
    const notificationsRemoved = this.options.notifier?.purgeTask(id) ?? 0;
    this.removeFromQueue(id);

    // 清除其余现场对这张任务的结构化引用，避免看板留下点不开的父子
    // 链。逐张严格落盘；失败时保留源任务在内存，管理员可原样重试。
    for (const other of this.tasks.values()) {
      if (other === task) continue;
      let changed = false;
      if (other.summary.parent_task_id === id) {
        delete other.summary.parent_task_id;
        changed = true;
      }
      if (other.summary.blocked_by?.includes(id)) {
        const kept = other.summary.blocked_by.filter((item) => item !== id);
        other.summary.blocked_by = kept.length ? kept : undefined;
        changed = true;
      }
      for (const repository of
        other.summary.requirement_graph?.repositories ?? []) {
        if (repository.task_id === id) {
          delete repository.task_id;
          changed = true;
        }
      }
      if (changed) this.persist(other, true);
    }

    removeTaskTree(workspace);
    this.tasks.delete(id);
    return {
      id,
      deleted: true,
      local_task: Boolean(task),
      projection_task: projected.found,
      reviews_removed: reviewsRemoved,
      notifications_removed: notificationsRemoved,
    };
  }

  private beginHistoryMutation(id: string): () => void {
    if (this.historyMutationActive.has(id)) {
      throw new TaskControlError(`任务 ${id} 正在执行清空重跑或彻底删除，请勿重复操作`);
    }
    this.historyMutationActive.add(id);
    return () => this.historyMutationActive.delete(id);
  }

  /** 需求图体检(只验不建):图齐不齐、依赖合不合法、有没有环。
   * 单独成函数的原因是 decide() 的顺序纪律——校验必须在决定落袋
   * (humanGate.resolve 的乐观锁)之前,建任务必须在之后;原来两件事
   * 挤在一个函数里,版本冲突 409 时子任务已经先落地了。 */
  private requirementGraphPlan(task: TaskState): {
    graph: RequirementGraph;
    order: string[];
    incoming: Map<string, string[]>;
  } {
    this.refreshRequirementGraph(task);
    const graph = task.summary.requirement_graph;
    if (!graph || graph.repositories.length !== task.summary.repositories?.length) {
      throw new NotFoundError("需求图尚未生成完整，请先让 Agent 补齐分析产物");
    }
    const ticket = task.summary.ticket ?? task.summary.id;
    const artifact = task.cwd
      ? readArtifact(task.cwd, `${ticket}/CHAIN-${ticket}.md`)
      : undefined;
    if (!artifact?.content.trim()) {
      throw new NotFoundError("跨仓方案正文尚未生成，请先让 Agent 补齐 Chain 文档");
    }
    const ids = new Set(graph.repositories.map((repository) => repository.id));
    const prerequisites = new Map<string, string[]>();
    for (const id of ids) prerequisites.set(id, []);
    for (const edge of graph.dependencies) {
      if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) {
        throw new NotFoundError("需求图包含无效依赖，请让 Agent 修正后再确认");
      }
      // `from 依赖 to`：from 的前置项是 to。
      prerequisites.get(edge.from)!.push(edge.to);
    }
    const remaining = new Set(ids);
    const order: string[] = [];
    while (remaining.size) {
      const ready = [...remaining].filter((id) =>
        (prerequisites.get(id) ?? []).every((parent) => !remaining.has(parent)));
      if (!ready.length) throw new NotFoundError("仓库依赖存在循环，不能生成任务");
      ready.forEach((id) => { remaining.delete(id); order.push(id); });
    }
    return { graph, order, incoming: prerequisites };
  }

  /** 主任务采用“一个主责任人 + 多位共同开发者”。协作者参与澄清，
   * 但最终确认和任务控制仍只有主责任人，避免多人同时改写结论。 */
  setRequirementCollaborators(
    id: string,
    accounts: string[],
  ): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (!this.isRequirementAnalysis(task)) {
      throw new NotFoundError("只有跨仓需求主任务可以邀请共同开发者");
    }
    this.refreshRequirementGraph(task);
    const graph = task.summary.requirement_graph;
    if (!graph || graph.repositories.length < 2) {
      throw new NotFoundError("需求图尚未生成，暂不能邀请共同开发者");
    }
    if (graph.stage === "confirmed"
        || graph.repositories.some((repository) => repository.task_id)) {
      throw new TaskControlError("仓库任务已经生成，主任务协作成员不能再调整");
    }
    const owner = task.summary.luban_account;
    const normalized = [...new Set(accounts.map((account) => account.trim())
      .filter((account) => account && account !== owner))];
    if (normalized.length > 20) {
      throw new TaskControlError("一个跨仓主任务最多邀请 20 位共同开发者");
    }
    for (const account of normalized) {
      const readiness = this.options.collaborationAssigneeReadiness?.(account);
      if (readiness && !readiness.ready) {
        throw new TaskControlError(
          `${account} 的个人设置尚未就绪：${readiness.missing.join("、")}`,
        );
      }
    }
    task.summary.collaborators = normalized;
    this.persist(task);
    return { ...task.summary };
  }

  /** 人工分工是主任务契约的一部分，不是 create 子任务时临时拼的参数。
   * 全量提交避免半张图新、半张图旧；就绪校验失败时一项都不落盘。 */
  assignRequirementRepositories(
    id: string,
    assignments: Record<string, string>,
  ): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (!this.isRequirementAnalysis(task)) {
      throw new NotFoundError("只有跨仓需求主任务可以委派逐仓责任人");
    }
    this.refreshRequirementGraph(task);
    const graph = task.summary.requirement_graph;
    if (!graph || graph.repositories.length < 2) {
      throw new NotFoundError("需求图尚未生成，暂不能分工");
    }
    if (graph.stage === "confirmed"
        || graph.repositories.some((repository) => repository.task_id)) {
      throw new TaskControlError("仓库任务已经生成，责任人不能在主任务上改派");
    }
    const ids = new Set(graph.repositories.map((repository) => repository.id));
    const submitted = Object.keys(assignments);
    const unknown = submitted.filter((repositoryId) => !ids.has(repositoryId));
    const missingRepositories = [...ids].filter((repositoryId) =>
      !Object.prototype.hasOwnProperty.call(assignments, repositoryId));
    if (unknown.length || missingRepositories.length) {
      throw new TaskControlError("请为需求图中的每个仓库完整选择责任人后再保存");
    }
    const normalized = new Map<string, string>();
    for (const repository of graph.repositories) {
      const account = String(assignments[repository.id] ?? "").trim();
      if (!account) {
        throw new TaskControlError(`仓库 ${repository.name} 尚未选择责任人`);
      }
      const readiness = this.options.collaborationAssigneeReadiness?.(account);
      if (readiness && !readiness.ready) {
        throw new TaskControlError(
          `${account} 的个人设置尚未就绪：${readiness.missing.join("、")}`,
        );
      }
      normalized.set(repository.id, account);
    }
    for (const repository of graph.repositories) {
      repository.assignee = normalized.get(repository.id)!;
    }
    this.persist(task);
    return { ...task.summary };
  }

  /** 子任务发现跨仓影响时回流大任务，并把同一条结构化消息投给依赖图
   * 上直接相邻的上下游。运行中的 Agent 立即 steer；排队/暂停/等人
   * 的任务由 launch/decision 注入，消息先落盘所以不会因会话状态丢失。 */
  async publishCrossRepositoryUpdate(
    id: string,
    author: string,
    text: string,
  ): Promise<CrossRepositoryUpdate> {
    const source = this.tasks.get(id);
    if (!source) throw new NotFoundError(`任务 ${id} 不存在`);
    const message = text.trim();
    if (!message) throw new TaskControlError("请写清楚发生了什么变化或哪里不确定");
    if (message.length > 8_000) {
      throw new TaskControlError("单条跨仓同步不能超过 8000 字");
    }
    const parentId = source.summary.parent_task_id;
    const parent = parentId ? this.tasks.get(parentId) : undefined;
    const graph = parent?.summary.requirement_graph;
    if (!parent || !graph) {
      throw new NotFoundError("该任务不隶属于可协作的跨仓大任务");
    }
    const sourceRepository = graph.repositories.find((repository) =>
      repository.task_id === source.summary.id);
    if (!sourceRepository) throw new NotFoundError("主任务中找不到当前仓库节点");
    const relatedRepositoryIds = new Set(graph.dependencies.flatMap((edge) => {
      if (edge.from === sourceRepository.id) return [edge.to];
      if (edge.to === sourceRepository.id) return [edge.from];
      return [];
    }));
    const targetTaskIds = graph.repositories
      .filter((repository) => relatedRepositoryIds.has(repository.id)
        && repository.task_id && repository.task_id !== source.summary.id)
      .map((repository) => repository.task_id!);
    const update: CrossRepositoryUpdate = {
      id: `cross-${randomUUID()}`,
      parent_task_id: parentId!,
      source_task_id: source.summary.id,
      source_repository: sourceRepository.name,
      author,
      text: message,
      target_task_ids: targetTaskIds,
      created_at: new Date().toISOString(),
    };
    parent.summary.cross_repository_updates = [
      ...(parent.summary.cross_repository_updates ?? []), update,
    ].slice(-100);
    this.persist(parent);
    for (const targetId of targetTaskIds) {
      const target = this.tasks.get(targetId);
      if (!target) continue;
      target.summary.cross_repository_updates = [
        ...(target.summary.cross_repository_updates ?? []), update,
      ].slice(-30);
      this.persist(target);
      if (target.summary.status === "running" && target.driver) {
        const delivered = [
          `[跨仓影响同步 · ${author} · ${sourceRepository.name}]`,
          message,
          "请立即核对它是否影响当前仓的接口、设计或实现；有冲突就举卡，",
          "并把结论回报跨仓主任务，不要静默猜测。",
        ].join("\n");
        await target.driver.steer(delivered).catch((cause) => {
          this.options.log?.(
            `[cross-repo-update] ${update.id} 即时投递 ${targetId} 失败，已落盘待后续注入: ${cause}`);
        });
      }
    }
    return update;
  }

  /** 人工确认 Chain 产物后，把图上的节点落成现有普通任务。
   * 可重入:已有 task_id 的仓跳过(第 N 个仓 create 抛错或中途重启后
   * 重试,不许把前面的仓再建一遍);每建一个就 persist——task_id 只写
   * 内存的话,重启即失忆,重试必出重复任务。 */
  private createRepositoryDeliveries(task: TaskState): void {
    const { graph, order, incoming } = this.requirementGraphPlan(task);
    if (graph.repositories.every((repository) => repository.task_id)) return;
    const artifact = task.cwd
      ? readArtifact(task.cwd,
          `${task.summary.ticket ?? task.summary.id}/CHAIN-${task.summary.ticket ?? task.summary.id}.md`)
      : undefined;
    const taskIds = new Map<string, string>();
    for (const repository of graph.repositories) {
      if (repository.task_id) taskIds.set(repository.id, repository.task_id);
    }
    for (const id of order) {
      const repository = graph.repositories.find((item) => item.id === id)!;
      if (repository.task_id) continue;
      const blockers = (incoming.get(id) ?? [])
        .map((parent) => taskIds.get(parent)).filter(Boolean) as string[];
      // 方案正文**不进需求原文**(2026-08-19 内网实锤:整份方案含
      // "逐仓启动说明"塞进 prompt,模型把它当实施计划直接开写代码,
      // 跳过 init→配置确认整个流程头部)。方案落到子任务工作区文件,
      // launch 时进克隆并经下单事实把「需求文档」指过去——模型按内核
      // 流程在配置阶段读它,而不是开场就被它牵着跑。
      const requirement = [
        task.summary.requirement,
        "本需求已跨仓分析并经人工检视确认。完整跨仓方案(仓库职责、"
          + "接口契约、依赖关系)在工作区文件 .mae-flow-chain.md,"
          + "配置确认的「需求文档」会自动指向它——按内核流程推进,"
          + "在需求/设计阶段读它,不要跳过流程直接实施。只交付当前仓"
          + "职责;发现方案不够用时停止并报告,不要自行改变跨仓契约。",
        `当前仓库:${repository.name}\n当前职责:${repository.responsibility ?? "见方案正文"}`,
      ].filter(Boolean).join("\n\n");
      const preserveUndefinedRepositorySkills =
        task.summary.repository_skills === undefined;
      const parentWorkflow = task.summary.workflow_profile;
      const child = this.create(requirement, {
        title: taskTitle(
          `${task.summary.title ?? taskTitle(task.summary.requirement)} · ${repository.name}`),
        account: repository.assignee ?? task.summary.luban_account,
        repo: repository.url,
        lane: task.summary.lane,
        ticket: task.summary.ticket,
        baseline: task.summary.baseline,
        model: task.summary.model_choice,
        repairRounds: task.summary.repair_rounds,
        // 父任务的文字补充随拆单下传(团队约定会按当前设置重建,
        // 仓库约定由子任务自己的首次 clone 重新解析)。
        taskInstructions: parentWorkflow?.supplements
          ?.find((item) => item.scope === "task")?.instructions,
        // 子任务的仓库、技术和可用 Skill 已经变窄，不能整份照搬父任务
        // 的最终方案；用父 profile 保存的 base+edits 在子任务快照上重编，
        // 不适用资产逐项回退，平台流程继续。supplement-only 档没有
        // base_snapshot,无结构可重编。
        workflowDefinition: parentWorkflow?.base_snapshot ? {
          schema: "mae-flow-workflow-definition/1",
          base: {
            standard_id: parentWorkflow.base_snapshot.standard_id,
            standard_version: parentWorkflow.base_snapshot.standard_version,
            catalog_digest: parentWorkflow.base_snapshot.catalog_digest,
          },
          applicability: {
            business_module_ids: (task.summary.business_modules ?? [])
              .map((module) => module.id),
            repositories: [repository.url],
            technologies: (task.summary.repository_profiles ?? [])
              .filter((profile) => profile.repository === repository.url)
              .flatMap((profile) => profile.technologies),
          },
          edits: structuredClone(parentWorkflow.edits),
        } : undefined,
        workflowSource: parentWorkflow?.base_snapshot
          ? structuredClone(parentWorkflow.source) : undefined,
        workflowProfileWarning: task.summary.workflow_profile_warning,
        hostSkillSnapshotSourceWorkspace: task.summary.workspace,
        parentTaskId: task.summary.id,
        internalRequirement: true,
        blockedBy: blockers,
        repositorySkills: preserveUndefinedRepositorySkills
          ? undefined
          : task.summary.repository_skills!.filter(
              (skill) => skill.repository === repository.url),
        businessModules: (task.summary.business_modules ?? [])
          .map((module) => ({
            ...module,
            assets: module.assets.map((asset) => ({ ...asset })),
          })),
        businessModuleSourceWorkspace: task.summary.workspace,
        repositoryProfiles: (task.summary.repository_profiles ?? [])
          .filter((profile) => profile.repository === repository.url),
        engineeringKnowledge: task.summary.engineering_knowledge,
        engineeringKnowledgeSourceWorkspace: task.summary.workspace,
        preserveUndefinedRepositorySkills,
      });
      // 方案文档放子任务 workspace 根(不删现场,重启/重建都在);
      // launch 每次把它带进仓库克隆。写不进去不拦拆单——launch 侧
      // 缺文件时子任务照常走流程,只是配置阶段要人补需求文档。
      try {
        writeFileSync(join(child.workspace, "chain-plan.md"), [
          artifact?.content ?? "",
          `\n\n---\n当前仓库:${repository.name}\n`
            + `当前职责:${repository.responsibility ?? "见方案正文"}\n`,
        ].join(""));
      } catch (cause) {
        this.options.log?.(
          `任务 ${child.id} 方案文档落盘失败(fail-open): ${String(cause)}`);
      }
      repository.task_id = child.id;
      taskIds.set(id, child.id);
      this.persist(task);
    }
    graph.stage = "confirmed";
    task.summary.detail = `需求方案已确认，已生成 ${order.length} 个仓库交付任务`;
    this.persist(task);
  }

  /** 有依赖的子任务启动时，把“上游实际交付”而非最初计划交给它。
   * 这是 Cloud 编排上下文，不是内核步骤/完成证据；读取失败 fail-open，
   * 但文件一旦生成就进入 prompt 硬要求，避免接口已经变了下游还按旧
   * Chain 猜。 */
  private async materializeDependencyHandoff(
    task: TaskState,
    cwd: string,
  ): Promise<boolean> {
    const blockers = task.summary.blocked_by ?? [];
    if (!blockers.length) return false;
    const parent = task.summary.parent_task_id
      ? this.tasks.get(task.summary.parent_task_id) : undefined;
    const graph = parent?.summary.requirement_graph;
    const currentRepository = graph?.repositories.find((repository) =>
      repository.task_id === task.summary.id);
    const sections: string[] = [];
    for (const blockerId of blockers) {
      const predecessor = this.tasks.get(blockerId);
      if (!predecessor) continue;
      const predecessorRepository = graph?.repositories.find((repository) =>
        repository.task_id === blockerId);
      const edge = currentRepository && predecessorRepository
        ? graph?.dependencies.find((candidate) =>
            candidate.from === currentRepository.id
            && candidate.to === predecessorRepository.id)
        : undefined;
      const snapshot = predecessor.cwd && existsSync(predecessor.cwd)
        ? await deliveryChangeSnapshot(predecessor.cwd).catch(() => undefined)
        : undefined;
      let assistantSummary = "";
      try {
        const messages = new EventLog(join(
          predecessor.summary.workspace, "events.jsonl")).replay()
          .filter((event) => event.kind === "assistant_message"
            && String(event.sessionId ?? "main") === "main")
          .map((event) => String(event.payload?.text ?? "").trim())
          .filter(Boolean);
        assistantSummary = messages.slice(-2).join("\n\n").slice(0, 3500);
      } catch {
        // 交接的其他事实仍可用，事件旁路损坏不拦下游启动。
      }
      const delivery = predecessor.summary.delivery;
      sections.push([
        `## ${predecessorRepository?.name ?? predecessor.summary.repo_url ?? blockerId}`,
        `- 前置任务：${blockerId}`,
        `- 责任人：${predecessor.summary.luban_account ?? "未记录"}`,
        `- 当前状态：${predecessor.summary.status}`,
        edge?.reason ? `- 依赖原因：${edge.reason}` : "",
        delivery?.sha ? `- 交付 SHA：${delivery.sha}` : "",
        delivery?.mr_url ? `- 合并请求：${delivery.mr_url}` : "",
        snapshot?.committed_paths.length
          ? `- 实际改动文件：\n${snapshot.committed_paths
              .map((path) => `  - ${path}`).join("\n")}`
          : "- 实际改动文件：现场未提供可证明的提交清单，请不要据此猜接口未变",
        assistantSummary
          ? `\n### 上游 AI 收口说明\n\n${assistantSummary}` : "",
      ].filter(Boolean).join("\n"));
    }
    if (!sections.length) return false;
    writeFileSync(join(cwd, ".mae-flow-dependencies.md"), [
      "# 跨仓前置交接（平台生成）",
      "",
      "以下内容来自前置仓的真实交付现场，优先用于核对最初 Chain 契约。",
      "开始设计或修改接口前必须阅读；若实际交付与 Chain 文档、当前仓实现",
      "不一致，停止猜测并向责任人举卡，把冲突回报跨仓主任务。",
      "",
      ...sections,
      "",
    ].join("\n"));
    return true;
  }

  /** 需求图面板不是第二套审批:分析会话正在等人时,这颗结构化按钮
   * 先消费当前 HumanGate 决定、恢复同一会话,再幂等生成各仓普通任务。
   * 这样不会出现“子任务已经生成,父分析单却还在等确认”的双状态。
   * 已经收尾的旧单仍允许从图面板补建,用于兼容历史现场。 */
  async confirmRequirementGraph(
    id: string,
    skillSelection?: {
      catalog_token?: string;
      selected_ids?: string[];
      repository_assignees?: Record<string, string>;
    },
  ): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (!this.isRequirementAnalysis(task)) {
      throw new NotFoundError("该任务不是多仓需求分析单,没有需求图可确认");
    }
    this.requirementGraphPlan(task);
    const alreadyGenerated = task.summary.requirement_graph?.repositories
      .every((repository) => repository.task_id) ?? false;
    if (alreadyGenerated && task.summary.status !== "waiting_for_human") {
      return { ...task.summary };
    }
    if (task.summary.status === "waiting_for_human" && task.summary.waiting) {
      const questions = (
        (task.summary.waiting.question as any)?.questions ?? []
      ) as Array<{ question?: string }>;
      if (questions.length !== 1) {
        throw new NotFoundError(
          "仍有多项需求问题待澄清，请先逐题处理，再确认跨仓方案",
        );
      }
      await this.decide(id, {
        state_version: task.summary.waiting.state_version,
        decision: "确认并生成任务",
        repository_skill_catalog_token: skillSelection?.catalog_token,
        selected_repository_skill_ids: skillSelection?.selected_ids,
        repository_assignees: skillSelection?.repository_assignees,
        // 收尾令随决定送达:确认后父会话再举卡会被系统代答赶下台
        // (autoAnswerFor 的分析单兜底),但第一选择是它自己别举。
        notes: "各仓交付任务由平台自动生成与调度,不归本会话跟进;"
          + "请写一段简短收尾说明后立即结束,不要再提问。",
      });
      // decide 会在标准选项命中时生成任务；这里再走一次幂等兜底，
      // 让模型即使把选项写成“方案通过”也不会丢掉拆单动作。
      this.createRepositoryDeliveries(task);
      return { ...task.summary };
    }
    if (!["completed", "failed", "canceled"].includes(task.summary.status)) {
      throw new NotFoundError("需求分析尚未进入人工检视，暂不能确认方案");
    }
    if (skillSelection?.repository_assignees) {
      this.assignRequirementRepositories(id, skillSelection.repository_assignees);
    }
    this.createRepositoryDeliveries(task);
    this.bypass(undefined, "任务泵", this.pump());
    return { ...task.summary };
  }

  /** 父分析单确认即硬收口(用户拍板 2026-08-19:拆单后它的使命就
   * 结束了)。不等模型自觉写收尾:并发槽让给子任务,"确认后又举卡"
   * 的窗口彻底关死。会话直接终止没有可丢的——CHAIN 方案在盘上,
   * 子任务已生成,决定也已落袋(waiting.json)。teardown 与 cancel
   * 同款:先涨 controlEpoch 让在途 settle 对不上暗号,不回写状态。 */
  private async finishRequirementAnalysis(task: TaskState): Promise<void> {
    task.controlEpoch += 1;
    task.pauseRequested = false;
    this.removeFromQueue(task.summary.id);
    task.summary.status = "completed";
    task.summary.completed_at = new Date().toISOString();
    task.mission = undefined;
    this.persist(task);
    const driver = task.driver;
    const container = task.container;
    const prepushAbort = task.prepushAbort;
    prepushAbort?.abort();
    const cleanup = await Promise.allSettled([
      driver?.abort() ?? Promise.resolve(),
      container?.stop() ?? Promise.resolve(),
    ]);
    if (cleanup[0].status === "fulfilled" && task.driver === driver) {
      task.driver = undefined;
      driver?.dispose();
    }
    if (cleanup[1].status === "fulfilled" && task.container === container) {
      task.container = undefined;
    }
    if (task.prepushAbort === prepushAbort) task.prepushAbort = undefined;
    const failures = cleanup.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${index === 0 ? "会话中止" : "容器回收"}: ${String(result.reason)}`]
        : []);
    if (failures.length) {
      task.summary.detail = "需求分析已完成，但执行资源未能确认释放："
        + failures.join("；") + "。服务重启会按 ownership 再清扫";
      this.persist(task);
      this.options.log?.(`任务 ${task.summary.id} 分析收口清理不完整: `
        + failures.join(" | "));
    }
    this.notifyOutcome(task);
    this.bypass(undefined, "任务泵", this.pump());
  }

  private normalizeDecisionSubmission(
    waiting: WaitingRecord,
    input: DecisionSubmission,
  ): {
    decision: string;
    answers: Record<string, string>;
    notes?: string;
  } {
    const questions = (((waiting.question as {
      questions?: unknown;
    } | undefined)?.questions) ?? []) as Array<{
      question?: unknown;
      options?: unknown;
    }>;
    const menu = questions.map((item) => ({
      question: String(item?.question ?? "").trim(),
      options: Array.isArray(item?.options)
        ? item.options.map(String).map((value) => value.trim()).filter(Boolean)
        : [],
    })).filter((item) => item.question);
    const usesStructuredContract = input.selected_options !== undefined
      || input.free_responses !== undefined
      || input.comment !== undefined;
    const answers: Record<string, string> = {};
    const notes = [input.comment, input.notes]
      .map((value) => String(value ?? "").trim()).filter(Boolean);

    if (usesStructuredContract) {
      const selected = input.selected_options ?? {};
      const free = input.free_responses ?? {};
      const known = new Set(menu.map((item) => item.question));
      for (const key of [...Object.keys(selected), ...Object.keys(free)]) {
        if (!known.has(key)) {
          throw new TaskControlError(`决定包含未知问题：${key}`);
        }
      }
      for (const item of menu) {
        const selectedOption = String(selected[item.question] ?? "").trim();
        const freeResponse = String(free[item.question] ?? "").trim();
        const optional = /可忽略|若上题|如无|可跳过|可不填/.test(item.question);
        if (item.options.length) {
          if (selectedOption) {
            if (!item.options.includes(selectedOption)) {
              throw new TaskControlError(
                `“${item.question}”必须选择卡片中的结构化选项，不能把自由说明当作流程分支`,
              );
            }
            answers[item.question] = selectedOption;
          }
          if (freeResponse) {
            if (selectedOption) {
              notes.push(`问题“${item.question}”的补充说明：${freeResponse}`);
            } else {
              // 模型给出的选项可能不完备。强迫用户任选一个再补充会把
              // 错误分支写进内核收据；没有选项时，自由回复就是主答案。
              answers[item.question] = freeResponse;
            }
          }
          if (!selectedOption && !freeResponse && !optional) {
            throw new TaskControlError(
              `“${item.question}”尚未选择选项或填写自定义答复`);
          }
        } else {
          if (selectedOption) {
            throw new TaskControlError(`“${item.question}”是开放题，不接受结构化选项`);
          }
          if (freeResponse) answers[item.question] = freeResponse;
          if (!freeResponse && !optional) {
            throw new TaskControlError(`“${item.question}”尚未填写开放题答案`);
          }
        }
      }
    } else if (input.answers && Object.keys(input.answers).length) {
      Object.assign(answers, input.answers);
      for (const item of menu) {
        const value = String(answers[item.question] ?? "").trim();
        if (value && item.options.length && !item.options.includes(value)) {
          throw new TaskControlError(
            `“${item.question}”必须选择卡片中的结构化选项；自由说明请使用 comment`,
          );
        }
      }
    }

    let decision = String(
      input.decision ?? Object.values(answers).join("\n"),
    ).trim();
    if (!usesStructuredContract && menu.length > 1) {
      for (const item of menu) {
        if (/可忽略|若上题|如无|可跳过|可不填/.test(item.question)) continue;
        if (!String(answers[item.question] ?? "").trim()) {
          throw new TaskControlError(`“${item.question}”尚未填写决定`);
        }
      }
    }
    if (!Object.keys(answers).length && decision && menu.length === 1
        && menu[0].options.length && !menu[0].options.includes(decision)) {
      throw new TaskControlError(
        `“${menu[0].question}”必须选择卡片中的结构化选项；自由说明请使用 comment`,
      );
    }
    if (!decision && Object.keys(answers).length) {
      decision = Object.values(answers).join("\n").trim();
    }
    if (!decision) {
      throw new NotFoundError(
        "决定不能为空：选择题请提交 selected_options，开放题请提交 free_responses",
      );
    }
    return {
      decision,
      answers,
      notes: notes.length ? notes.join("\n\n") : undefined,
    };
  }

  private unresolvedAnnotations(task: TaskState): Annotation[] {
    return blockingAnnotations(
      this.annotations(task).visible(),
      task.summary.luban_account,
    );
  }

  private async deliverySelectionForDecision(
    task: TaskState,
    waiting: WaitingRecord,
    input: DecisionSubmission,
    closesFeedback: boolean,
    /** push 前确认卡:没显式勾选就按"当前 commit 全量"确认。确认
     * 同时绑定 HEAD 与路径集合；任何修复生成新 HEAD 都会重新检视，
     * 即便文件名完全没变。只有同一 HEAD 的网络重试才复用收据。 */
    defaultToCommitted = false,
  ): Promise<{
    record: NonNullable<TaskSummary["delivery_selection"]>;
    note: string;
  } | undefined> {
    const explicit = input.delivery_paths !== undefined;
    const previous = task.summary.delivery_selection;
    const values = explicit
      ? input.delivery_paths!
      : previous?.status === "requested" ? previous.paths
        : defaultToCommitted ? "committed" as const : undefined;
    if (values === undefined) return undefined;
    const surface = waiting.step === CLOUD_PUSH_CONFIRM_STEP
      ? "diff"
      : stepReviewSurface(
          this.options.host?.kernelRoot,
          this.reviewContractStep(task, waiting),
        );
    if (surface !== "diff") {
      if (explicit) {
        throw new TaskControlError("只有代码变更检视可以提交交付文件清单");
      }
      return undefined;
    }
    if (!task.cwd) {
      throw new TaskControlError("代码现场尚未就绪，不能确认交付文件");
    }
    const snapshot = await deliveryChangeSnapshot(task.cwd);
    if (!snapshot?.baseline) {
      throw new TaskControlError("无法读取任务基线，暂不能确认交付文件");
    }
    let paths = normalizedDeliveryPaths(
      values === "committed" ? snapshot.committed_paths : values);
    const visible = new Set(snapshot.workspace_paths);
    const unknown = paths.filter((path) => !visible.has(path));
    let vanishedNote = "";
    if (unknown.length) {
      // 勾选期间现场变了不再整单打回让人重勾(2026-08-28 用户点破
      // 太严):路径从现场消失=该文件已与基线一致,本来就无可交付,
      // 自动移出清单并留痕即可。只有勾选的文件一个不剩才是真冲突。
      const remaining = paths.filter((path) => visible.has(path));
      if (!remaining.length) {
        throw new StateConflictError(
          `工作区变更已经更新，勾选的 ${describeDirtyPaths(unknown)} 均已不在当前现场，请刷新后重新确认`,
        );
      }
      paths = remaining;
      vanishedNote = `\n(勾选中的 ${describeDirtyPaths(unknown)} 已与基线一致`
        + "、无内容可交付,已自动移出清单)";
    }
    const committed = normalizedDeliveryPaths(snapshot.committed_paths);
    const excluded = snapshot.workspace_paths.filter((path) =>
      !paths.includes(path));
    if (closesFeedback && !samePaths(paths, committed)) {
      // 清单调整仍是宿主机械活，不打回 Agent 猜。但它会产生新 HEAD，
      // 所以旧 Build-Fix 收据必须作废；调整后重新验证，再让人看最终
      // HEAD。绝不能把“人选了文件”偷换成“用户同意跳过编译”。
      const mustRemove = committed.filter((path) => !paths.includes(path));
      const mustAdd = paths.filter((path) => !committed.includes(path));
      await this.applyDeliverySelectionAdjustment(
        task, snapshot.baseline, mustRemove, mustAdd);
      const adjusted = await deliveryChangeSnapshot(task.cwd);
      if (!adjusted?.baseline) {
        throw new TaskControlError("清单整理提交后读取现场失败,请重试");
      }
      const adjustedExcluded = adjusted.workspace_paths.filter((path) =>
        !paths.includes(path));
      const actions = [
        mustRemove.length ? `剔除 ${describeDirtyPaths(mustRemove)}` : "",
        mustAdd.length ? `补入 ${describeDirtyPaths(mustAdd)}` : "",
      ].filter(Boolean).join(";");
      this.registerAgentPlatformLocalExcludes(task.cwd, adjustedExcluded);
      return {
        record: {
          paths,
          observed_paths: adjusted.workspace_paths,
          excluded_paths: adjustedExcluded,
          status: "requested",
          waiting_id: waiting.waiting_id,
          head: adjusted.head,
          baseline: adjusted.baseline,
          updated_at: new Date().toISOString(),
        },
        note: `${deliverySelectionNote(paths, adjustedExcluded)}\n`
          + `(宿主已按清单机械整理提交:${actions};新 HEAD 将重新执行`
          + ` Build-Fix，并在通过后展示最终检视卡)${vanishedNote}`,
      };
    }
    if (closesFeedback) {
      this.registerAgentPlatformLocalExcludes(task.cwd, excluded);
    }
    return {
      record: {
        paths,
        observed_paths: snapshot.workspace_paths,
        excluded_paths: excluded,
        status: closesFeedback ? "confirmed" : "requested",
        waiting_id: waiting.waiting_id,
        head: snapshot.head,
        baseline: snapshot.baseline,
        updated_at: new Date().toISOString(),
      },
      note: deliverySelectionNote(paths, excluded) + vanishedNote,
    };
  }

  /** 按用户选择的清单机械整理提交。剔除≠销毁(用户点名"直接回退太极端"):
   * 只把改动请出提交与索引,工作区内容原样保留——基线里有的先按
   * 基线版本入索引、提交后再把原内容写回工作区(变成未暂存改动);
   * 基线里没有的 git rm --cached,文件原地变回未跟踪。补入=git add
   * 工作区已有改动。整理产生新 HEAD 后，旧 Build-Fix 收据立即作废，
   * 下一次 tryDeliver 会对新现场重新验证。 */
  private async applyDeliverySelectionAdjustment(
    task: TaskState,
    baseline: string,
    remove: string[],
    add: string[],
  ): Promise<void> {
    const cwd = task.cwd!;
    const run = async (args: string[], what: string) => {
      const result = await runSafeWorktreeGitAsync(cwd, args, {
        timeoutMs: 60_000,
        configs: [
          ["user.name", "mae-flow-cloud"],
          ["user.email", "cloud@mae-flow.local"],
        ],
      });
      if (result.status !== 0) {
        throw new TaskControlError(`按清单${what}失败: `
          + String(result.stderr || result.error || "").slice(0, 300));
      }
      return result;
    };
    const preserved = new Map<string, Buffer>();
    for (const path of remove) {
      const absolute = join(cwd, path);
      const inBaseline = await runSafeWorktreeGitAsync(cwd,
        ["cat-file", "-e", `${baseline}:${path}`], { timeoutMs: 30_000 });
      if (inBaseline.status === 0) {
        if (existsSync(absolute)) preserved.set(path, readFileSync(absolute));
        await run(["checkout", baseline, "--", path], `回退提交内容 ${path}`);
      } else {
        await run(["rm", "--cached", "-q", "--", path], `移出索引 ${path}`);
      }
    }
    if (add.length) await run(["add", "--", ...add], "补入勾选文件");
    const staged = await runSafeWorktreeGitAsync(cwd,
      ["diff", "--cached", "--quiet"], { timeoutMs: 30_000 });
    if (staged.status !== 0) {
      const summary = [
        remove.length ? `剔除 ${remove.length} 个未勾选文件` : "",
        add.length ? `补入 ${add.length} 个勾选文件` : "",
      ].filter(Boolean).join("、");
      await run(["commit", "-m",
        `chore: 按最终人工检视整理交付清单——${summary}`], "整理提交");
    }
    // 提交落定后把被剔除文件的原内容写回工作区:改动只是"不交付",
    // 不是"被销毁";它们成为未暂存改动留在现场,脏区检查放行已确认
    // 剔除的路径(prePushDirtyPaths 同口径)。
    for (const [path, content] of preserved) {
      writeFileSync(join(cwd, path), content);
    }
    const at = new Date().toISOString();
    const revision = await this.prePushRevision(task);
    const pending = createPrePushVerification(revision, at);
    pending.message = "交付清单已机械整理为新 HEAD，等待重新执行 Build-Fix";
    this.setPrePushState(task, pending);
    this.persist(task);
  }

  private pushConfirmationAccepted(waiting: WaitingRecord): boolean {
    return [waiting.decision, ...Object.values(waiting.answers ?? {})]
      .some((answer) => answer.includes(PUSH_CONFIRM_ACCEPT));
  }

  private continuationDeliverySelection(
    waiting: WaitingRecord,
  ): NonNullable<TaskSummary["delivery_selection"]> | undefined {
    const value = waiting.continuation?.delivery_selection as
      Partial<NonNullable<TaskSummary["delivery_selection"]>> | undefined;
    if (!value || !Array.isArray(value.paths)
        || !Array.isArray(value.observed_paths)
        || !Array.isArray(value.excluded_paths)
        || !["requested", "confirmed"].includes(String(value.status))
        || typeof value.waiting_id !== "string"
        || typeof value.head !== "string"
        || typeof value.updated_at !== "string") {
      return undefined;
    }
    return {
      paths: value.paths.map(String),
      observed_paths: value.observed_paths.map(String),
      excluded_paths: value.excluded_paths.map(String),
      status: value.status as "requested" | "confirmed",
      waiting_id: value.waiting_id,
      head: value.head,
      ...(typeof value.baseline === "string"
        ? { baseline: value.baseline } : {}),
      updated_at: value.updated_at,
    };
  }

  /** 修复前的 resolved 记录没有 continuation。返工清单正文已经作为
   * 结构化块写进 notes，完整时可无损恢复；确认分支在 resolve 前已
   * 机械整理 commit，因此实时 committed 集合就是用户确认的集合。 */
  private legacyDeliveryPaths(waiting: WaitingRecord): string[] | undefined {
    const block = waiting.notes.match(
      /<delivery-selection\b[^>]*>([\s\S]*?)<\/delivery-selection>/);
    const count = block?.[1].match(/只交付以下\s+(\d+)\s+个文件/)?.[1];
    if (!block || count === undefined) return undefined;
    const expected = Number(count);
    if (expected === 0) return [];
    const paths = block[1].split("\n")
      .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1] ?? "")
      .filter((line) => line && !line.startsWith("…")
        && line !== "（不交付任何文件）");
    return paths.length === expected
      ? normalizedDeliveryPaths(paths) : undefined;
  }

  private async resolvedPushSelection(
    task: TaskState,
    waiting: WaitingRecord,
  ): Promise<NonNullable<TaskSummary["delivery_selection"]>> {
    const durable = this.continuationDeliverySelection(waiting);
    if (durable) return durable;
    if (!task.cwd) throw new TaskControlError(
      "已收到最终确认，但代码现场不可用，无法恢复交付清单");
    const snapshot = await deliveryChangeSnapshot(task.cwd);
    if (!snapshot?.baseline) throw new TaskControlError(
      "已收到最终确认，但任务基线不可读，无法恢复交付清单");
    const committed = normalizedDeliveryPaths(snapshot.committed_paths);
    const paths = this.pushConfirmationAccepted(waiting)
      ? committed
      : this.legacyDeliveryPaths(waiting)
        ?? task.summary.delivery_selection?.paths
        ?? committed;
    return {
      paths,
      observed_paths: snapshot.workspace_paths,
      excluded_paths: snapshot.workspace_paths.filter((path) =>
        !paths.includes(path)),
      status: this.pushConfirmationAccepted(waiting)
        ? "confirmed" : "requested",
      waiting_id: waiting.waiting_id,
      head: snapshot.head,
      baseline: snapshot.baseline,
      updated_at: waiting.resolved_at || new Date().toISOString(),
    };
  }

  private markResolvedDecisionAnnotations(
    task: TaskState,
    waiting: WaitingRecord,
  ): void {
    try {
      const drafts = this.annotations(task).drafts();
      const durableIds = waiting.continuation?.annotation_ids;
      const ids = Array.isArray(durableIds)
        ? durableIds.map(String)
        // 新记录明确没带 annotation_ids 就是真的没选，不能因为自由说明
        // 恰好重复了批注原文而误标。只有修复前的旧账才走正文反推。
        : waiting.request_digest
          ? []
          // 兼容修复前已 resolved、却死在 markSent 前的记录。旧账没有
          // id，只认 resolved_at 之前且“要求+原文”都逐字进入决定 notes
          // 的草稿；后来新圈的意见绝不能被旧决定顺手标成已发送。
          : drafts.filter((item) => item.created_at <= waiting.resolved_at
            && waiting.notes.includes(item.note)
            && waiting.notes.includes(item.anchor)).map((item) => item.id);
      if (!ids.length) return;
      const draftIds = new Set(drafts.map((item) => item.id));
      const pending = ids.filter((id) => draftIds.has(id));
      if (pending.length) this.annotations(task).markSent(pending, "decision");
    } catch (error) {
      // waiting.json 已经把决定、批注 id 和完整原文一起落袋。批注账只是
      // 展示投影，写坏不能把已经生效的决定伪装成“提交失败”；重启或
      // 同请求重放会继续尝试对账。
      this.options.log?.(`任务 ${task.summary.id} 批注送达状态暂未落盘: ${String(error)}`);
    }
  }

  /** 决定事实和批注展示是两个 append-only 账。若进程死在两次写之间，
   * 任务可能已经继续、summary.waiting 也已清空；因此不能只在“当前卡”
   * 恢复时对账。任务恢复和批注读侧都用全部 resolved 收据补投影。 */
  private reconcileResolvedDecisionAnnotations(task: TaskState): void {
    try {
      if (!this.annotations(task).drafts().length) return;
      for (const waiting of task.humanGate.resolved()) {
        this.markResolvedDecisionAnnotations(task, waiting);
      }
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 批注送达投影暂无法对账: ${String(error)}`);
    }
  }

  /** push 卡没有挂起的 Agent 工具调用，必须由宿主消费 resolved 收据。
   * 这一个函数同时服务正常提交、完全相同的网络重放和崩溃恢复。 */
  private finishResolvedPushConfirmation(
    task: TaskState,
    waiting: WaitingRecord,
    selection: NonNullable<TaskSummary["delivery_selection"]>,
  ): void {
    task.summary.delivery_selection = selection;
    task.summary.waiting = undefined;
    // 人解决这张卡(不论通过还是返工)就是"看过了这个 HEAD":钉住它,
    // 复检轮的"这次修改"从这里起算(MFC-035)。
    if (selection.head) {
      task.summary.delivery = {
        ...task.summary.delivery,
        last_reviewed_head: selection.head,
      };
    }
    if (task.summary.delivery) delete task.summary.delivery.push_review;
    if (this.pushConfirmationAccepted(waiting)) {
      const loop = task.summary.delivery?.loop;
      if (loop?.workspace_review_recheck_required) {
        loop.workspace_review_recheck_required = false;
        loop.workspace_review_annotation_ids = undefined;
      }
      task.summary.status = "verifying";
      task.summary.detail = "交付清单已确认,继续推送";
      this.persist(task);
      this.bypass(task, "push 确认续推",
        this.tryDeliver(task, task.controlEpoch));
      return;
    }
    const review = waiting.notes.trim();
    const annotationIds = Array.isArray(waiting.continuation?.annotation_ids)
      ? waiting.continuation.annotation_ids.map(String) : [];
    const annotations = this.annotations(task).list().filter((item) =>
      annotationIds.includes(item.id));
    // 即使只有补充说明、没有逐行批注，也要回到同一张总检卡；有逐行
    // 批注时则必须由各自作者逐条裁决，责任人的“继续”不能代点通过。
    this.rememberWorkspaceReview(task, annotations);
    // push 确认卡上的整体返工没有逐行批注，也必须真正开启 review 新轮。
    // rememberWorkspaceReview 还服务“意见并入正在运行的会话”，不能在
    // helper 内无条件改状态；但这里旧会话已收口，若仍沿用 verifying，
    // reviewRoundLane() 会返回空，Agent 只看到 external_verify 的等待指令
    // 并原样交回同一 HEAD，形成假返工闭环。
    if (task.summary.delivery?.loop) {
      task.summary.delivery.loop.state = "repairing";
      task.summary.delivery.loop.round = 0;
    }
    this.enqueueRepair(task, [
      "用户在 push 前确认交付清单时要求按清单返工,整理提交是你此刻唯一的使命:",
      review
        ? "- 用户本次确认的交付范围、补充说明与检视批注（完整原文）：\n"
          + review
        : "- 用户未填写额外说明；严格按结构化交付清单处理。",
      "- 把不在清单里却已进入提交的文件从提交中移出(优先 git rm --cached 后追加提交);",
      "  文件本身要不要保留在工作区,按它的性质与用户意见判断,不确定就保留并说明。",
      // MFC-036 实锤:Agent 为整理清单 rebase 到定格基线的父提交,最终
      // 树看似正确但基线祖先关系断裂,MR 永远无法快进合入。硬边界写死。
      "- 硬边界:任何 reset/rebase/amend 都不得触及任务基线及更早的提交;",
      "  只允许在任务自己新增的提交范围内整理。历史乱了就在当前 HEAD 上",
      "  追加修正提交,绝不重写基线之前的历史。",
      "- 清单内缺失的文件补进提交;不许为凑清单制造空改动。",
      "- 入场后先执行 current，严格按当前 review 步骤顺序推进；交付清单尚未由流程确认前，不要直接 git add/commit。",
      "- 若清单包含领域真相文档，不要直接编辑 docs 下的正式文件；只修改 domain-archive prepare 生成的候选，再由 apply 机械落到正式路径。",
      "- 整理完按仓库提交规范收口(单条 Bash 只做一个 commit);",
      `  完成后系统会按新 HEAD 重新验证并再次请用户确认(当前清单 ${selection.paths.length} 个文件)。`,
      // 回执契约必须与 post-MR review 同一份:少了它,Agent 改完代码
      // 也不知道要写 local-receipts.json,收口时被回执门禁如实拦下,
      // 形成"改了却过不去"的死锁(e2e-picky-20260830 双复现,MFC-002)。
      workspaceReviewReceiptInstructions(annotations),
    ].filter(Boolean).join("\n"), "按交付清单整理提交中");
  }

  private async resumeResolvedDecision(
    task: TaskState,
    waiting: WaitingRecord,
  ): Promise<void> {
    // 正常卡和 push 卡都可能死在 waiting.json 已落袋、批注投影尚未
    // markSent 的窗口。恢复动作首先对账，不能只让 Agent 收到正文却在
    // 页面继续显示“待提交”。失败会由 helper 记日志并保持流程可继续。
    this.markResolvedDecisionAnnotations(task, waiting);
    if (waiting.step === CLOUD_PUSH_CONFIRM_STEP) {
      try {
        const selection = await this.resolvedPushSelection(task, waiting);
        this.finishResolvedPushConfirmation(task, waiting, selection);
      } catch (error) {
        task.summary.waiting = undefined;
        task.summary.status = "failed";
        task.summary.detail = error instanceof Error ? error.message : String(error);
        this.persist(task);
      }
      return;
    }
    task.summary.waiting = undefined;
    if (task.driver) {
      task.summary.status = "running";
      this.persist(task);
      this.bypass(task, "已决待办自愈续跑",
        this.settle(task, task.driver.resumeWithDecision(waiting)));
      return;
    }
    task.pendingResume = waiting;
    task.resume = true;
    task.summary.status = "queued";
    task.summary.detail = "检测到已完成的决定，等待重建会话续跑";
    this.persist(task);
    if (!this.queue.includes(task.summary.id)) this.queue.push(task.summary.id);
    this.bypass(undefined, "任务泵", this.pump());
  }

  private resolvedRequestMatches(
    waiting: WaitingRecord,
    input: DecisionSubmission,
    digest: string,
  ): boolean {
    if (waiting.request_digest) return waiting.request_digest === digest;
    // 兼容这次修复前已经落袋的决定：旧记录没有请求指纹，只能用结构
    // 化答案 + 补充说明对拍。不能仅看 state_version（每张卡都从 1
    // 开始），也不能把不同的后到决定误当重试吞掉。
    try {
      const normalized = this.normalizeDecisionSubmission(waiting, input);
      const answers = orderedRecord(normalized.answers) ?? {};
      const recorded = orderedRecord(waiting.answers) ?? {};
      if (normalized.decision !== waiting.decision
          || JSON.stringify(answers) !== JSON.stringify(recorded)) {
        return false;
      }
      return !normalized.notes || waiting.notes.includes(normalized.notes);
    } catch {
      return false;
    }
  }

  /** 所有入口的决定都在这里收口。异步读取 diff 发生在 HumanGate 落锁
   * 之前，所以需要一把逐任务锁；否则一次双击会启动两条相同请求，
   * 后一条只看到“先到决定完成”，把已经成功伪装成失败。 */
  async decide(
    id: string,
    input: DecisionSubmission,
  ): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const waitingId = input.waiting_id
      ?? task.summary.waiting?.waiting_id;
    if (!waitingId) {
      throw new NotFoundError(`任务 ${id} 当前没有待人工决定`);
    }
    const digest = decisionRequestDigest(waitingId, input);
    const active = this.activeDecisions.get(id);
    if (active) {
      if (active.waitingId === waitingId && active.digest === digest) {
        return active.promise;
      }
      throw new StateConflictError(
        `任务状态已变化:待办 ${waitingId} 已有另一份决定正在提交`);
    }
    // resolved 分叉自愈也必须进入同一把锁：若两个网络重试同时命中
    // waiting.json 已决、task.json 未推进的窗口，仍只能恢复一次。
    const promise = this.decideUnderLock(
      id, input, waitingId, digest);
    this.activeDecisions.set(id, { waitingId, digest, promise });
    try {
      return await promise;
    } finally {
      const latest = this.activeDecisions.get(id);
      if (latest?.promise === promise) this.activeDecisions.delete(id);
    }
  }

  private async decideUnderLock(
    id: string,
    input: DecisionSubmission,
    waitingId: string,
    digest: string,
  ): Promise<TaskSummary> {
    const task = this.tasks.get(id)!;
    const authoritative = task.humanGate.get(waitingId);
    if (authoritative?.status === "resolved") {
      if (!this.resolvedRequestMatches(authoritative, input, digest)) {
        throw new StateConflictError(
          `任务状态已变化:待办 ${waitingId} 已由先到决定完成`);
      }
      if (task.summary.waiting?.waiting_id === waitingId) {
        await this.resumeResolvedDecision(task, authoritative);
      }
      return { ...task.summary };
    }
    if (authoritative?.status === "superseded") {
      throw new StateConflictError(`任务状态已变化:待办 ${waitingId} 已失效`);
    }
    const current = task.summary.waiting;
    if (task.summary.status !== "waiting_for_human" || !current) {
      throw new NotFoundError(`任务 ${id} 当前没有待人工决定`);
    }
    if (current.waiting_id !== waitingId) {
      throw new StateConflictError(
        `任务状态已变化:当前待办是 ${current.waiting_id},不是 ${waitingId}`);
    }
    return this.decideOnce(id, input, waitingId, digest);
  }

  private async decideOnce(
    id: string,
    input: DecisionSubmission,
    waitingId: string,
    requestDigest: string,
  ): Promise<TaskSummary> {
    const task = this.tasks.get(id)!;
    const waiting = task.summary.waiting;
    if (task.summary.status !== "waiting_for_human" || !waiting) {
      throw new NotFoundError(`任务 ${id} 当前没有待人工决定`);
    }
    if (waiting.waiting_id !== waitingId) {
      throw new StateConflictError(
        `任务状态已变化:当前待办是 ${waiting.waiting_id},不是 ${waitingId}`);
    }
    const normalized = this.normalizeDecisionSubmission(waiting, input);
    const { answers, decision } = normalized;
    // 多仓确认的顺序纪律:图的体检放在决定落袋**之前**(图不完整就报
    // 错,决定不消费,agent 继续等,用户看得到原因);建任务放在落袋
    // **之后**(乐观锁 409 时不许先把子任务生出来)。字符串匹配只是
    // "模型把选项原文写对了"的顺路便车,正门是需求图面板的确认按钮
    // (confirmRequirementGraph)——选项文字漂了也不丢单。
    const confirmingGraph = this.isRequirementAnalysis(task)
      && Object.values(answers).concat(decision).some((answer) =>
        answer.includes("确认并生成任务"));
    if (input.repository_assignees && !confirmingGraph) {
      throw new NotFoundError("逐仓责任人只能随“确认并生成任务”提交");
    }
    if (confirmingGraph) {
      this.requirementGraphPlan(task);
      if (input.repository_assignees) {
        if (waiting.state_version !== input.state_version
            || waiting.status !== "waiting") {
          throw new StateConflictError(
            `任务状态已变化:待办 ${waiting.waiting_id} 版本不匹配`);
        }
        this.assignRequirementRepositories(id, input.repository_assignees);
      }
    }
    const updatesRepositorySkills =
      input.repository_skill_catalog_token !== undefined
      || input.selected_repository_skill_ids !== undefined;
    if (updatesRepositorySkills) {
      if (!this.isRequirementAnalysis(task)) {
        throw new NotFoundError("只有跨仓方案检视可以在决定时调整仓内 Skill");
      }
      // 只允许在图已经可供检视、且 HumanGate 仍是当前版本时换选择。
      // 先验版本检查避免陈旧页面消费 catalog token、覆盖较新的选择；
      // 本方法到 humanGate.resolve 之间没有 await，单进程内不会被另一
      // 个决定插入。
      if (waiting.state_version !== input.state_version
          || waiting.status !== "waiting") {
        throw new StateConflictError(`任务状态已变化:待办 ${waiting.waiting_id} 版本不匹配`);
      }
      this.requirementGraphPlan(task);
      const resources = this.selectedResourcesFromCatalog({
        catalogToken: input.repository_skill_catalog_token,
        selectedSkillIds: input.selected_repository_skill_ids,
        repositories: task.summary.repositories ?? [],
        baseline: task.summary.baseline,
        account: task.summary.luban_account,
        preserveSkillsForErroredRepositories:
          task.summary.repository_skills ?? [],
      });
      task.summary.repository_skills = resources.skills;
      // 必须先于 humanGate.resolve/createRepositoryDeliveries 落盘：确认
      // 后父会话会立刻收口，重启也只能从 task.json 恢复这份选择。
      this.persist(task);
    }
    // 待修改批注与“确认关闭检视”是矛盾事实。结构化返工从内核
    // next → clear_hint/allow_source_edit 推导；Spec/Story 等原步修改则
    // 以 confirmation_answers 识别关闭答案。Cloud 不认识任何步骤名。
    const effects = stepChoiceEffects(
      this.options.host?.kernelRoot,
      this.reviewContractStep(task, waiting),
    );
    const closingEffects = effects.filter((effect) => effect.closesFeedback);
    const submitted = Object.keys(answers).length
      ? Object.values(answers) : [decision];
    const closesFeedback = closingEffects.length > 0
      && submitted.some((answer) => closingEffects.some((effect) =>
        matchesStepChoice(effect, answer)));
    // push 前确认卡是云端原生步骤(不在内核流程里,effects 为空),
    // 关闭语义由选项原文判定;确认视同关闭检视——未闭环批注同样拦。
    const pushConfirmCard = waiting.step === CLOUD_PUSH_CONFIRM_STEP;
    const confirmingPush = pushConfirmCard
      && submitted.some((answer) => answer.includes(PUSH_CONFIRM_ACCEPT));
    const handlesFeedback = effects.some((effect) => effect.handlesFeedback
      && submitted.some((answer) => matchesStepChoice(effect, answer)))
      // 云端 push 卡不在内核 effect 契约里；除明确确认外都意味着进入
      // 新修复会话。这里必须由服务端认定为“处理意见”，不能依赖网页
      // 携带 annotation_ids——小鲁班回复只有选项和说明。
      || (pushConfirmCard && !confirmingPush);
    const unresolved = this.unresolvedAnnotations(task);
    if (unresolved.length && (closesFeedback || confirmingPush)) {
      const menuQuestions = Array.isArray(waiting.question?.questions)
        ? waiting.question.questions as Array<{ options?: string[] }> : [];
      const menuOptions = menuQuestions
        .flatMap((question) => question.options ?? []);
      const handled = effects.filter((effect) => effect.handlesFeedback)
        .flatMap((effect) => effect.answers)
        .find((answer) => menuOptions.includes(answer));
      const nonClosing = menuOptions.filter((option) =>
        !closingEffects.some((effect) => matchesStepChoice(effect, option)));
      const recommended = handled
        ?? nonClosing.find((option) => /需要.*(?:调整|修改)|返工|补充/.test(option))
        ?? nonClosing[0]
        ?? "需要调整";
      // 必须在整理提交、消费待办之前拒绝。旧顺序先机械改 commit 再报
      // “意见未闭环”，责任人一次误点就会让现场变化、卡片变旧，形成
      // 明明后来全点通过却仍提交不了的假死。
      throw new TaskControlError(
        `当前仍有 ${unresolved.length} 条检视意见未闭环，不能继续放行。`
        + `责任人的“继续提交”不能代替意见提出人确认。建议选择“${recommended}”`
        + "继续处理；若已经修好，请由每条意见的提出人逐条确认通过。",
      );
    }
    const deliverySelection = await this.deliverySelectionForDecision(
      task, waiting, input, closesFeedback || confirmingPush, pushConfirmCard);
    if (pushConfirmCard && !deliverySelection) {
      throw new TaskControlError(
        "push 前确认必须基于当前变更快照,请刷新后重试");
    }
    // 决定只能携带决定者自己的草稿。旁观者可以先记，但“记录权”不能
    // 在手机端/月光模式或返工卡里悄悄升级为“送达 Agent 的权力”。
    // 无 actor 的旧回调按任务责任人收口；旧单也没有责任人时才保留
    // 原单用户兼容语义。
    const draftAuthor = input.actor ?? task.summary.luban_account;
    const allDrafts = this.annotations(task).drafts();
    const drafts = draftAuthor
      ? allDrafts.filter((item) => item.author === draftAuthor) : allDrafts;
    const deliverableUnresolved = unresolved.filter((item) =>
      item.status !== "draft" || !draftAuthor || item.author === draftAuthor);
    // 等待期间经 queued_decision 提交的意见:状态是 sent,但正文还没
    // 送到过任何 Agent——随这次决定一并送达,送完转正常 decision 账。
    const queued = this.annotations(task).list().filter((item) =>
      item.status === "sent" && item.sent_via === "queued_decision"
      && item.response?.revision !== (item.rework ?? 0));
    const localReviewRound = task.summary.delivery?.loop?.kind === "review"
      && task.summary.delivery.loop.review_source === "workspace"
      && task.summary.delivery.loop.state === "repairing";
    const picked = handlesFeedback
      // 普通检视仍回到同一会话，sent 已经在上下文里，不重复送；push
      // 返工会开一只全新会话，必须把 draft + sent 的全部未闭环意见
      // 都带过去，否则“提前主动送达”的意见会断在上一只 Agent 里。
      ? pushConfirmCard ? deliverableUnresolved : [...queued, ...drafts]
      // 本地 review 轮里若 Agent 因真实歧义举卡，用户在等待期间新圈的
      // 批注随这张卡一并回注；不能让人答完歧义后还要再点一次提交。
      : localReviewRound ? [...queued, ...drafts]
      : input.annotation_ids?.length
        ? this.pickDecisionDrafts(task, input.annotation_ids, draftAuthor)
        : queued;
    // 批注与自由说明都进 notes，不污染内核用于 choice receipt 的选项。
    const notes = [
      normalized.notes,
      task.summary.cross_repository_updates?.length
        ? "跨仓协作最新同步（需核对后继续）：\n"
          + task.summary.cross_repository_updates.slice(-5)
            .map((update) => `- ${update.source_repository ?? update.source_task_id}`
              + ` / ${update.author}：${update.text}`).join("\n")
        : undefined,
      deliverySelection?.note,
      picked.length ? renderAnnotations(picked, this.ticketOf(task)) : undefined,
    ].filter(Boolean).join("\n\n") || undefined;
    const resolved = task.humanGate.resolve(waiting.waiting_id, {
      stateVersion: input.state_version,
      decision,
      answers: Object.keys(answers).length ? answers : undefined,
      notes,
      requestDigest,
      decidedBy: input.actor,
      continuation: {
        ...(deliverySelection
          ? { delivery_selection: deliverySelection.record } : {}),
        ...(picked.length
          ? { annotation_ids: picked.map((item) => item.id) } : {}),
      },
    });
    if (deliverySelection) {
      task.summary.delivery_selection = deliverySelection.record;
    }
    // 决定已经落袋(waiting.json 写完),批注才算送出去。
    this.markResolvedDecisionAnnotations(task, resolved);
    // 等待期入队的意见随这次决定完成送达:账目从 queued_decision 转
    // "decision",下一张卡不再重复携带同一份正文。
    const queuedDelivered = picked
      .filter((item) => item.sent_via === "queued_decision")
      .map((item) => item.id);
    if (queuedDelivered.length) {
      this.annotations(task).markSent(queuedDelivered, "decision");
    }
    // 决定生效之后才生子任务(体检在落袋前做过,这里不会因图不齐半途
    // 而废)。建任务失败不回滚决定——决定是用户的事实;失败原因写进
    // detail,面板确认按钮随时可重试(可重入)。
    if (confirmingGraph) {
      try {
        this.createRepositoryDeliveries(task);
        // 拆单成功=父分析单使命结束(用户拍板 2026-08-19):确认即
        // 硬收口,不等模型自觉写完——省下并发槽给子任务,也彻底关掉
        // "确认后又举卡让人检视子任务"的窗口(预答兜底退居末防线)。
        // 会话直接终止:CHAIN 方案在盘上、子任务已生成,没有可丢的。
        task.summary.waiting = undefined;
        // 决定必须先回注再掐会话:会话此刻停在 AskUserQuestion 工具里
        // 等这份决定,不解开它 abort 会一直等回合收束(实测挂死——
        // 等待必须带出路,不许无限等的红线在自己身上也成立)。回注是
        // 同步解扣,后续回合不等,收口里的 abort 负责掐断。
        if (task.driver) {
          this.bypass(task, "分析收口回注",
            task.driver.resumeWithDecision(resolved).then(() => undefined));
        }
        await this.finishRequirementAnalysis(task);
        return { ...task.summary };
      } catch (cause) {
        task.summary.detail =
          `确认已收到,但生成仓库任务失败:${String(cause)}。`
          + "可在需求图面板重试「确认并生成任务」";
        this.options.log?.(`任务 ${id} 生成仓库交付失败: ${String(cause)}`);
      }
    }
    // push 前确认卡:没有会话停在 AskUserQuestion 里等这份决定(卡由
    // 宿主在 push 路径上自己挂的),所以不回注会话、更不重建会话——
    // 确认就接着推,返工就开一只带清单契约的修复会话整理提交。
    if (pushConfirmCard) {
      this.finishResolvedPushConfirmation(
        task, resolved, task.summary.delivery_selection!);
      return { ...task.summary };
    }
    task.summary.waiting = undefined;
    if (task.driver) {
      task.summary.status = "running";
      this.persist(task);
      // 决定之后的这一轮是即发即忘:settle 自己会把异常收成"任务
      // failed",这里再兜一层——连收口都失败时,宁可只丢一条日志,
      // 也不许一个没人接的 rejection 掀掉整台服务(内网实测的死法)。
      this.bypass(task, "决定后续跑",
        this.settle(task, task.driver.resumeWithDecision(resolved)));
    } else {
      // 恢复场景:旧会话死于服务重启,决定先落袋(waiting.json 已
      // resolved),任务入队走重建会话——launch 会补登记这份决定。
      task.summary.status = "queued";
      task.summary.detail = "决定已收到,等待重建会话续跑";
      task.pendingResume = resolved;
      task.resume = true;
      this.persist(task);
      this.queue.push(task.summary.id);
      this.bypass(undefined, "任务泵", this.pump());
    }
    return { ...task.summary };
  }

  /** 跑动中插话:发送即打断。模型把手头这一轮的工具调用做完就收到,
   * 不会在半截处被掐断。
   *
   * 两条边界:
   * - 等人决定时不许走这条路——那时该说的话就是决定本身,从决定卡走,
   *   否则同一件事有两个入口,内核台账上却只认一个。
   * - 正好撞在回合间隙的插话 pi 收下却永远不送(它的队列没人取),
   *   由 settle 在回合收口时取回来补发。人说过的话被系统吞掉,比慢
   *   一拍严重得多。
   */
  async interrupt(
    id: string,
    text: string,
    actor?: string,
  ): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const message = text.trim();
    if (!message) throw new NotFoundError("插话内容不能为空");
    if (task.summary.status === "waiting_for_human") {
      throw new TaskControlError("这一单正等你的决定,请在决定卡里回答");
    }
    if (task.summary.status !== "running" || !task.driver) {
      throw new TaskControlError(
        `任务 ${id} 当前是 ${task.summary.status},没有在跑的会话可插话`);
    }
    // 前缀只标"谁在说话",不标"什么场景":这里是普通插话通道,单仓
    // 任务也走它。曾经无条件写"[跨仓协作 · x]",单仓插话被模型当成
    // 跨仓消息记进了交付件(spec 里出现"用户跨仓消息补充",MFC-021)。
    // 真正的跨仓同步走 /cross-repository-update,自带跨仓抬头。
    const delivered = actor
      ? (actor === task.summary.luban_account
          ? `[责任人 ${actor} 插话] ${message}`
          : `[协作者 ${actor} 插话] ${message}`)
      : message;
    await task.driver.steer(delivered);
    this.options.log?.(`任务 ${id} 已插话(本轮工具调用结束后送达)`);
    return { ...task.summary };
  }

  /** 旁路开发助手的读侧：回复来自助手快照，命令/文件工具结果来自
   * 任务 SSE 正本。服务重启后没有活会话却仍写 running 时如实改中断。 */
  developerAssistant(id: string): DeveloperAssistantView {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    let snapshot = readDeveloperAssistant(task.summary.workspace);
    if (["working", "running"].includes(snapshot.state)
        && !task.assistantActive) {
      snapshot = interruptDeveloperAssistant(task.summary.workspace);
    }
    const events = new EventLog(
      join(task.summary.workspace, "events.jsonl"),
    ).replay();
    return {
      ...snapshot,
      messages: developerAssistantConversation(snapshot, events),
      tools: developerAssistantTools(events),
      availability: this.developerAssistantAvailability(task),
    };
  }

  private developerAssistantAvailability(
    task: TaskState,
  ): DeveloperAssistantAvailability {
    if (!this.options.isolation) {
      return {
        available: false,
        code: "core_unavailable",
        mode: "unavailable",
        reason: "当前部署未启用任务隔离容器，开发接管不可用",
      };
    }
    if (this.isRequirementAnalysis(task)) {
      return {
        available: false,
        code: "not_editable",
        mode: "unavailable",
        reason: "需求理解阶段请继续使用检视与批注；开发接管只处理具体代码仓任务",
      };
    }
    if (!task.cwd || task.summary.workspace_reclaimed_at) {
      return {
        available: false,
        code: "core_unavailable",
        mode: "unavailable",
        reason: "代码现场尚未就绪或已回收，暂不能接管",
      };
    }
    if (["completed", "await_merge", "canceled", "failed"]
        .includes(task.summary.status)) {
      return {
        available: false,
        code: "not_editable",
        mode: "unavailable",
        reason: `任务当前是 ${task.summary.status}，没有可接管的活动代码现场`,
      };
    }
    return inspectDeveloperAssistantAvailability(
      task.cwd,
      this.options.host?.kernelRoot,
    );
  }

  /**
   * 用户发给开发接管会话的每条消息都先持久化。首次消息由服务端负责
   * 安全暂停主任务，后续消息复用同一 Pi 会话；working 期间的新消息走
   * steer，和本地 CLI 一样在当前工具结束后送达。
   */
  startDeveloperAssistant(
    id: string,
    text: string,
    actor: string,
  ): DeveloperAssistantView {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const message = text.trim();
    if (!message) throw new TaskControlError("请告诉开发助手要检查或处理什么");
    if (message.length > 12_000) {
      throw new TaskControlError("开发助手单条要求不能超过 12000 字");
    }
    const availability = this.developerAssistantAvailability(task);
    if (!availability.available) {
      throw new TaskControlError(availability.reason);
    }
    const workspace = task.summary.workspace;
    let previous = readDeveloperAssistant(workspace);
    if (["working", "running"].includes(previous.state)
        && !task.assistantActive) {
      previous = interruptDeveloperAssistant(
        workspace, "上一轮开发会话已不在运行，本条指令将重建会话");
    }
    if (previous.state === "returning") {
      throw new TaskControlError("开发现场正在交还主任务，请等待交还完成");
    }

    if (["working", "running"].includes(previous.state)) {
      appendDeveloperAssistantMessage(workspace, "user", message, "working");
      // 首轮容器/会话还在启动时先落盘；mission 会在会话
      // 真正就绪后读到它。会话已就绪则直接 steer。
      if (task.assistantActive && !task.driver) {
        return this.developerAssistant(id);
      }
      if (!task.driver || !task.assistantActive) {
        throw new TaskControlError("开发会话正在恢复，请稍后重试本条指令");
      }
      void task.driver.steer(message).catch((error) => {
        const current = readDeveloperAssistant(workspace);
        const state = task.assistantActive
          && ["working", "running"].includes(current.state)
          ? "working" : current.state;
        appendDeveloperAssistantMessage(
          workspace, "assistant", `追加指令未能送达：${String(error)}`,
          state, String(error));
      });
      return this.developerAssistant(id);
    }

    if (previous.state === "acquiring") {
      appendDeveloperAssistantMessage(workspace, "user", message, "acquiring");
      return this.developerAssistant(id);
    }

    // 首次接管时，running / waiting_for_human 本来就可能占有主
    // 会话和容器。它们是 pause 要在安全边界收好的正常资源，
    // 不能当成开发助手残留而拒绝。
    if (task.summary.status !== "paused") {
      appendDeveloperAssistantMessage(workspace, "user", message, "acquiring");
      this.options.log?.(`任务 ${id} 开发现场由 ${actor} 请求接管`);
      void this.pause(id, actor).then(() => {
        this.activatePendingDeveloperAssistant(task);
      }).catch((error) => {
        appendDeveloperAssistantMessage(
          workspace, "assistant", `未能接管主现场：${String(error)}`,
          "failed", String(error));
      });
      return this.developerAssistant(id);
    }

    if (task.driver && task.container) {
      appendDeveloperAssistantMessage(workspace, "user", message, "working");
      this.launchDeveloperAssistantTurn(task, message, true);
      return this.developerAssistant(id);
    }

    if (task.driver || task.container) {
      throw new TaskControlError("主任务正在进入安全暂停边界，请稍后重试");
    }

    appendDeveloperAssistantMessage(workspace, "user", message, "acquiring");
    this.options.log?.(`任务 ${id} 开发现场由 ${actor} 请求接管`);
    this.activatePendingDeveloperAssistant(task);
    return this.developerAssistant(id);
  }

  private activatePendingDeveloperAssistant(task: TaskState): void {
    const workspace = task.summary.workspace;
    const previous = readDeveloperAssistant(workspace);
    if (task.summary.status !== "paused" || previous.state !== "acquiring"
        || task.assistantActive || task.driver || task.container) return;
    const availability = this.developerAssistantAvailability(task);
    if (!availability.available || !task.cwd) {
      appendDeveloperAssistantMessage(
        workspace, "assistant", availability.reason, "failed",
        availability.reason);
      return;
    }
    let handoff: DeveloperAssistantHandoff | undefined;
    if (this.options.host && task.cwd) {
      let initial;
      try {
        initial = captureDeveloperAssistantWorktree(task.cwd);
      } catch (error) {
        // 现场摘要只用于帮助主 Agent 少做一次扫描，不是运行门禁。
        // Git/哈希读取偶发失败时仍允许助手工作，恢复后由主 Agent
        // 重新读取 current 与工作区，避免把任务永久留在暂停态。
        this.options.log?.(
          `任务 ${task.summary.id} 开发助手起点摘要不可用，将在交还时刷新: ${String(error)}`,
        );
        initial = {
          sha: "unavailable",
          fingerprint: "unavailable",
          paths: [],
          path_fingerprints: {},
        };
      }
      handoff = beginDeveloperAssistantHandoff(
        previous.handoff,
        availability,
        initial,
      );
    }
    writeDeveloperAssistant(workspace, {
      ...previous,
      state: "working",
      ...(handoff ? { handoff } : {}),
    });
    const latest = [...previous.messages].reverse()
      .find((item) => item.role === "user")?.text ?? "继续检查当前现场";
    this.launchDeveloperAssistantTurn(task, latest, false);
  }

  private launchDeveloperAssistantTurn(
    task: TaskState,
    message: string,
    continued: boolean,
  ): void {
    if (task.assistantActive) {
      throw new TaskControlError("开发助手仍在处理上一轮输入");
    }
    const epoch = (task.assistantEpoch ?? 0) + 1;
    task.assistantEpoch = epoch;
    const work = this.runDeveloperAssistant(task, epoch, message, continued);
    task.assistantActive = work;
    void work.catch((error) => {
      this.options.log?.(
        `任务 ${task.summary.id} 开发助手异常: ${String(error)}`);
    }).finally(() => {
      if (task.assistantActive === work) task.assistantActive = undefined;
    });
  }

  private async runDeveloperAssistant(
    task: TaskState,
    epoch: number,
    message: string,
    continued: boolean,
  ): Promise<void> {
    const workspace = task.summary.workspace;
    let driver: CloudSession | undefined;
    let container: TaskCommandContainer | undefined;
    let keepSession = false;
    let businessModuleKnowledge: MaterializedBusinessModuleKnowledge = {
      entries: [], skill_paths: [], warnings: [],
    };
    let engineeringKnowledge: ReturnType<typeof materializeEngineeringKnowledge>
      = { entries: [], warnings: [] };
    try {
      if (!task.cwd) throw new Error("开发助手缺少代码工作区");
      if (continued) {
        if (!task.driver || !task.container) {
          throw new Error("开发会话资源已经释放，将在下一条指令时重建");
        }
        driver = task.driver;
        container = task.container;
        const outcome = await driver.continueWith(message);
        await this.settleDeveloperAssistantTurn(task, epoch, driver, outcome);
        keepSession = true;
        return;
      }
      // 必须在容器 start 之前物化：root 宿主会在 start 前把整棵 bind
      // 工作区交给非 root 容器用户。若反过来，0440 的模块正文会在容器
      // 启动后由 root 新建，Agent 的 Read/Grep 反而读不到。
      businessModuleKnowledge = materializeBusinessModuleKnowledge({
        selected: task.summary.business_modules,
        taskWorkspace: workspace,
        runtimeWorkspace: task.cwd,
      });
      for (const warning of businessModuleKnowledge.warnings) {
        this.options.log?.(
          `[developer-assistant-business-module] 任务 ${task.summary.id}: ${warning}`);
      }
      engineeringKnowledge = materializeEngineeringKnowledge({
        selected: task.summary.engineering_knowledge,
        taskWorkspace: workspace,
        runtimeWorkspace: task.cwd,
      });
      for (const warning of engineeringKnowledge.warnings) {
        this.options.log?.(
          `[developer-assistant-engineering-knowledge] 任务 ${task.summary.id}: ${warning}`);
      }
      task.containerWorkspace = task.cwd;
      container = await this.startCodingContainer(task, {
        gitReadOnly: true,
        // 开发助手只处理代码现场，不参与流水线修复；任务级 pipeline
        // 材料不应因它复用 Coding 容器实现而越过角色边界。
        pipelineArtifacts: false,
      });
      if (!this.developerAssistantCurrent(task, epoch)) {
        throw new Error("开发助手启动期间任务状态已变化");
      }
      task.container = container;

      const agentDir = join(workspace, "pi-agent");
      mkdirSync(agentDir, { recursive: true });
      this.hardenAgentGitBoundary(agentDir, task.cwd);
      const modelOverride = this.options.settings?.models() ?? {};
      writeFileSync(join(agentDir, "models.json"),
        JSON.stringify(modelOverride.json ?? this.options.modelsJson), {
          mode: 0o600,
        });

      let repositorySkillPaths: string[] = [];
      let repositorySkillResources: Array<KnowledgeResourceRef & {
        actual_path: string;
      }> = [];
      const repository = task.summary.repo_url ?? this.effectiveDefaultRepo();
      if (repository) {
        const materialized = materializeRepositorySkills({
          selected: task.summary.repository_skills,
          bindings: [{ repository, workspace: task.cwd }],
          snapshotRoot: join(task.cwd, ".mae-flow-work", "repository-skills"),
          reservedNames: hostSkillNames(this.options.dataDir),
        });
        this.freezeRepositoryNativeSkills(task, materialized);
        repositorySkillPaths = materialized.paths;
        repositorySkillResources = materialized.entries.map(({ path, skill }) => ({
          id: skill.id,
          kind: "skill" as const,
          name: skill.name,
          path: skill.relative_path,
          repository: skill.repository,
          description: skill.description,
          digest: skill.digest,
          selected: true,
          actual_path: path,
        }));
        for (const warning of materialized.warnings) {
          this.options.log?.(
            `[developer-assistant-skill] 任务 ${task.summary.id}: ${warning}`);
        }
      }
      const eventLog = new EventLog(
        join(workspace, "events.jsonl"),
        (event) => this.bypass(
          task, "投影开发助手事件", this.options.projection?.appendEvent(event)),
      );
      const transcriptRoot = join(workspace, "developer-assistant");
      mkdirSync(transcriptRoot, { recursive: true });
      driver = await CloudSession.create({
        taskId: task.summary.id,
        workspace: task.cwd,
        agentDir,
        hostSkillsDir: taskHostSkillsDir(this.options.dataDir, task.summary),
        knowledgeContext: task.summary.host_skills_pinned ? undefined : {
          repositories: task.summary.repositories ?? [],
          technologies: [...new Set((task.summary.repository_profiles ?? [])
            .flatMap((profile) => profile.technologies))],
          businessModuleIds: (task.summary.business_modules ?? [])
            .map((module) => module.id),
        },
        repositorySkillPaths,
        repositorySkillResources,
        businessModuleKnowledge,
        engineeringKnowledge,
        knowledgeTrace: this.knowledgeTrace(task, task.cwd),
        provider: task.summary.model_choice?.provider
          ?? modelOverride.provider ?? this.options.provider,
        model: task.summary.model_choice?.model
          ?? modelOverride.model ?? this.options.model,
        eventLog,
        transcript: new TranscriptStore(
          join(transcriptRoot, "transcript.jsonl"),
          DEVELOPER_ASSISTANT_SESSION,
        ),
        gate: new GateService({
          contract: developerAssistantGateContract(this.options.contract),
          // 文件工具只够得着代码仓；任务台账、流水线材料和助手快照
          // 位于仓外，旁路会话没有读取或改写它们的理由。
          workspace: task.cwd,
          cwd: task.cwd,
          log: this.options.log,
          failClosed: true,
        }),
        humanGate: task.humanGate,
        allowHumanQuestions: false,
        allowSubagents: false,
        sessionId: DEVELOPER_ASSISTANT_SESSION,
        currentStep: () => this.currentStepLabel(task),
        compactAnchor: () => `开发助手只处理当前代码现场：${requirementContext(
          task.summary.requirement,
          task.summary.requirement_document,
          AGENT_REQUIREMENT_DOCUMENT,
        )}`,
        onTokenUsage: (sample) => this.recordTaskTokenUsage(task, sample),
        vision: this.taskVision(task),
        bashOperations: {
          exec: (command, dir, execOptions) =>
            container!.exec(command, dir, execOptions),
        },
        afterFileMutation: this.options.isolation
          ? (path) => {
            repairContainerMutationOwnership({
              workspace: task.cwd!,
              path,
              user: this.options.isolation?.user,
            });
          }
          : undefined,
        log: this.options.log,
      });
      if (!this.developerAssistantCurrent(task, epoch)) {
        throw new Error("开发助手会话就绪前任务状态已变化");
      }
      task.driver = driver;
      const snapshot = readDeveloperAssistant(workspace);
      const outcome = await driver.start(developerAssistantMission(
        requirementContext(
          task.summary.requirement,
          task.summary.requirement_document,
          AGENT_REQUIREMENT_DOCUMENT,
        ),
        snapshot.messages,
        this.developerAssistantAvailability(task),
      ));
      await this.settleDeveloperAssistantTurn(task, epoch, driver, outcome);
      keepSession = true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (this.developerAssistantCurrent(task, epoch)) {
        appendDeveloperAssistantMessage(
          workspace,
          "assistant",
          `本轮未能完成：${detail}`,
          "failed",
          detail,
        );
      }
    } finally {
      if (keepSession) return;
      if (driver && task.driver === driver) task.driver = undefined;
      driver?.dispose();
      if (container && task.container === container) task.container = undefined;
      if (container) {
        try {
          await container.stop();
        } catch (error) {
          const detail = `开发助手容器未能确认释放：${String(error)}`;
          appendDeveloperAssistantMessage(
            workspace, "assistant", detail, "failed", detail);
        }
      }
    }
  }

  private developerAssistantCurrent(task: TaskState, epoch: number): boolean {
    return this.tasks.get(task.summary.id) === task
      && task.assistantEpoch === epoch
      && task.summary.status === "paused";
  }

  private async settleDeveloperAssistantTurn(
    task: TaskState,
    epoch: number,
    driver: CloudSession,
    first: Awaited<ReturnType<CloudSession["continueWith"]>>,
  ): Promise<void> {
    let outcome = first;
    while (true) {
      if (!this.developerAssistantCurrent(task, epoch)) return;
      if (outcome.status !== "turn_finished") {
        throw new Error(outcome.detail ?? outcome.reason
          ?? "开发助手会话异常结束");
      }
      const late = driver.takeUndeliveredSteers();
      if (late.length) {
        outcome = await driver.continueWith(late.join("\n\n"));
        continue;
      }
      const reply = driver.finalReply().trim();
      if (!reply) throw new Error("开发助手没有返回可展示的处理结果");
      appendDeveloperAssistantMessage(
        task.summary.workspace, "assistant", reply, "ready");
      return;
    }
  }

  /** 停止当前开发动作但不交还主现场。下一条消息会在同一接管上下文里
   * 懒重建会话，避免 Pi abort 后复用一个不确定的 session。 */
  async stopDeveloperAssistant(
    id: string,
    actor: string,
  ): Promise<DeveloperAssistantView> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const snapshot = readDeveloperAssistant(task.summary.workspace);
    if (snapshot.state === "acquiring") {
      appendDeveloperAssistantMessage(
        task.summary.workspace, "assistant",
        `已由 ${actor} 停止本次接管启动；主任务保持暂停，可以继续输入或交还。`,
        "ready");
      return this.developerAssistant(id);
    }
    if (!["working", "running"].includes(snapshot.state)) {
      return this.developerAssistant(id);
    }
    task.assistantEpoch = (task.assistantEpoch ?? 0) + 1;
    const driver = task.driver;
    const container = task.container;
    const cleanup = await Promise.allSettled([
      driver?.abort() ?? Promise.resolve(),
      container?.stop() ?? Promise.resolve(),
    ]);
    if (cleanup[0].status === "fulfilled" && task.driver === driver) {
      task.driver = undefined;
      driver?.dispose();
    }
    if (cleanup[1].status === "fulfilled" && task.container === container) {
      task.container = undefined;
    }
    const failures = cleanup.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${index === 0 ? "会话中止" : "容器回收"}: ${String(result.reason)}`]
        : []);
    if (failures.length) {
      const detail = `停止当前开发动作时资源未能确认释放：${failures.join("；")}`;
      appendDeveloperAssistantMessage(
        task.summary.workspace, "assistant", detail, "failed", detail);
      throw new TaskControlError(detail);
    }
    appendDeveloperAssistantMessage(
      task.summary.workspace, "assistant",
      `当前动作已由 ${actor} 停止。代码现场仍由你接管，可以继续输入下一条指令。`,
      "ready");
    return this.developerAssistant(id);
  }

  /** 显式退出 vibe-coding 接管：先停净旁路会话/容器，再冻结一次工作区
   * 差异并走既有内核 reconcile，最后才允许主任务重建。 */
  async returnDeveloperAssistant(
    id: string,
    actor: string,
  ): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (task.summary.status !== "paused") {
      throw new TaskControlError("只有已接管并暂停的主现场可以交还");
    }
    const snapshot = readDeveloperAssistant(task.summary.workspace);
    if (["acquiring", "working", "running"].includes(snapshot.state)) {
      throw new TaskControlError("开发助手仍在工作；请先停止当前动作再交还");
    }
    if (task.assistantActive) await task.assistantActive;
    writeDeveloperAssistant(task.summary.workspace, {
      ...readDeveloperAssistant(task.summary.workspace),
      state: "returning",
    });
    task.assistantEpoch = (task.assistantEpoch ?? 0) + 1;
    const driver = task.driver;
    const container = task.container;
    const cleanup = await Promise.allSettled([
      driver?.abort() ?? Promise.resolve(),
      container?.stop() ?? Promise.resolve(),
    ]);
    if (cleanup[0].status === "fulfilled" && task.driver === driver) {
      task.driver = undefined;
      driver?.dispose();
    }
    if (cleanup[1].status === "fulfilled" && task.container === container) {
      task.container = undefined;
    }
    const failures = cleanup.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${index === 0 ? "会话中止" : "容器回收"}: ${String(result.reason)}`]
        : []);
    if (failures.length) {
      const detail = `交还前资源未能确认释放：${failures.join("；")}`;
      writeDeveloperAssistant(task.summary.workspace, {
        ...readDeveloperAssistant(task.summary.workspace),
        state: "failed",
        error: detail,
      });
      throw new TaskControlError(detail);
    }
    this.finishDeveloperAssistantHandoff(task);
    writeDeveloperAssistant(task.summary.workspace, {
      ...readDeveloperAssistant(task.summary.workspace),
      state: "ready",
    });
    const resumed = this.resume(id, actor);
    writeDeveloperAssistant(task.summary.workspace, {
      ...readDeveloperAssistant(task.summary.workspace),
      state: "idle",
    });
    return resumed;
  }

  private finishDeveloperAssistantHandoff(task: TaskState): void {
    const snapshot = readDeveloperAssistant(task.summary.workspace);
    if (!snapshot.handoff || !task.cwd
        || snapshot.handoff.state === "returned") return;
    try {
      const handoff = finishDeveloperAssistantHandoff(
        snapshot.handoff,
        captureDeveloperAssistantWorktree(task.cwd),
      );
      writeDeveloperAssistant(task.summary.workspace, { ...snapshot, handoff });
    } catch (error) {
      const detail = `现场摘要暂时不可读，主任务恢复后会自行重新扫描：${String(error)}`;
      writeDeveloperAssistant(task.summary.workspace, {
        ...snapshot,
        handoff: {
          ...snapshot.handoff,
          state: "changed",
          finished_at: new Date().toISOString(),
          paths_truncated: true,
          derived_only: false,
          message: detail,
        },
      });
    }
  }

  /** 安全暂停：排队/等待人工/验证中可立即停；正在执行时只登记请求，
   * 当前工具完成并回到回合边界后再释放会话和容器。 */
  async pause(id: string, actor: string): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const status = task.summary.status;
    if (status === "paused" || status === "pausing") {
      return { ...task.summary };
    }
    if (["completed", "await_merge", "failed", "canceled"].includes(status)) {
      throw new TaskControlError(`任务 ${id} 当前是 ${status}，不能暂停`);
    }
    task.summary.control = {
      last_action: "pause",
      actor,
      at: new Date().toISOString(),
      paused_from: status,
    };
    if (status === "running") {
      task.pauseRequested = true;
      task.summary.status = "pausing";
      const prepushRunning = Boolean(
        task.summary.delivery?.prepush?.active_attempt,
      );
      task.summary.detail = prepushRunning
        ? "正在终止 Build-Fix 容器，随后可从本轮验证恢复"
        : "正在完成当前操作，随后暂停";
      this.persist(task);
      if (prepushRunning) {
        // 编译可能持续数十分钟，暂停不能等 Maven/C++ 自己收口。换代使
        // 在途结果失去回写权，再销毁整个 attempt 容器及进程树。清理
        // 最坏会经历多轮 Docker 超时；控制接口先返回 pausing，页面靠
        // 状态轮询看到最终结果，不能让一次安全清理表现成按钮卡死。
        task.controlEpoch += 1;
        this.removePrePushBuildWaiter(task);
        void this.finishPause(task, "running").catch((error) => {
          this.options.log?.(
            `任务 ${task.summary.id} 后台暂停收口异常: ${String(error)}`);
          // cancel/其他控制动作已经换走状态时，旧暂停没有最终解释权。
          if (task.summary.status !== "pausing") return;
          task.summary.status = "failed";
          task.summary.detail = `暂停失败，后台清理未能完成：${String(error)}`;
          this.persist(task);
          this.notifyOutcome(task);
        });
      }
      return { ...task.summary };
    }
    task.controlEpoch += 1;
    this.removeFromQueue(id);
    await this.finishPause(task, status);
    return { ...task.summary };
  }

  /** 只允许 paused 恢复。等待人工回到决定卡，验证中回到流水线轮询，
   * 其余状态重建会话并从已有工作区/内核 current 续跑。 */
  resume(id: string, actor: string): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (task.summary.status !== "paused") {
      throw new TaskControlError(
        `任务 ${id} 当前是 ${task.summary.status}，只有已暂停任务可以恢复`);
    }
    const assistantSnapshot = readDeveloperAssistant(task.summary.workspace);
    if (task.assistantActive || task.driver || task.container
        || ["acquiring", "working", "returning", "running"]
          .includes(assistantSnapshot.state)
        || assistantSnapshot.handoff?.state === "running") {
      throw new TaskControlError(
        "开发接管会话仍占有主现场，请从开发协作面板执行“交还主任务”");
    }
    const beforeSummary = JSON.parse(JSON.stringify(task.summary)) as TaskSummary;
    const beforeHandoffPrompt = task.pendingAssistantHandoff;
    const beforePersistedStatus = task.lastPersistedStatus;
    const beforeAppliedIntervention = task.appliedDeveloperInterventionId;
    const beforeObsoleteWaiting = task.obsoleteDeveloperWaiting;
    let intervention: UserInterventionReconciliation | undefined;
    try {
      intervention = this.prepareDeveloperAssistantReturn(task, actor);
    } catch (error) {
      task.summary = beforeSummary;
      task.pendingAssistantHandoff = beforeHandoffPrompt;
      task.lastPersistedStatus = beforePersistedStatus;
      task.appliedDeveloperInterventionId = beforeAppliedIntervention;
      task.obsoleteDeveloperWaiting = beforeObsoleteWaiting;
      throw error;
    }
    const persistReturn = (): void => {
      try {
        this.persist(task, Boolean(intervention));
      } catch (error) {
        task.summary = beforeSummary;
        task.pendingAssistantHandoff = beforeHandoffPrompt;
        task.lastPersistedStatus = beforePersistedStatus;
        task.appliedDeveloperInterventionId = beforeAppliedIntervention;
        task.obsoleteDeveloperWaiting = beforeObsoleteWaiting;
        throw error;
      }
    };
    const markReturned = (): void =>
      this.markPreparedDeveloperAssistantReturned(task);
    const from = task.summary.control?.paused_from ?? "running";
    task.controlEpoch += 1;
    task.pauseRequested = false;
    task.summary.control = {
      last_action: "resume",
      actor,
      at: new Date().toISOString(),
      paused_from: from,
    };
    if (from === "waiting_for_human" && task.summary.waiting) {
      if (intervention?.changed) {
        const obsoleteWaiting = { ...task.summary.waiting };
        task.summary.waiting = undefined;
        task.obsoleteDeveloperWaiting = {
          waitingId: obsoleteWaiting.waiting_id,
          stateVersion: obsoleteWaiting.state_version,
        };
        task.summary.status = "queued";
        task.summary.detail = "用户介入已接纳，等待主任务承接当前代码现场";
        task.resume = true;
        task.pendingResume = undefined;
        persistReturn();
        this.supersedeWaitingForUserIntervention(task, obsoleteWaiting);
        markReturned();
        this.queue.push(id);
        this.bypass(undefined, "任务泵", this.pump());
        return { ...task.summary };
      }
      task.summary.status = "waiting_for_human";
      task.summary.detail = "已恢复，等待你的决定";
      persistReturn();
      markReturned();
      return { ...task.summary };
    }
    if (from === "verifying" && task.summary.delivery?.sha
        && !intervention?.changed) {
      task.summary.status = "verifying";
      task.summary.detail = "已恢复流水线状态跟踪";
      persistReturn();
      markReturned();
      this.bypass(task, "流水线轮询",
        this.pollPipeline(task, task.controlEpoch));
      return { ...task.summary };
    }
    if (task.summary.delivery?.prepush?.active_attempt && task.cwd) {
      // 暂停杀掉的是一次可重建的构建 attempt，不是编码上下文。恢复时
      // 直接回交付入口，restorePrePushVerification 会清理旧 attempt
      // 并对同一 SHA 重跑；绝不再起一轮普通编码 Agent。
      task.summary.status = "verifying";
      task.summary.detail = "已恢复，等待重新执行 Build-Fix";
      persistReturn();
      markReturned();
      this.bypass(task, "Build-Fix 恢复",
        this.resumePrePushVerification(task, task.controlEpoch));
      return { ...task.summary };
    }
    task.summary.status = "queued";
    task.summary.detail = intervention?.changed
      ? `用户介入已接纳，内核将从「${intervention.target}」重新读取现场`
      : "已恢复，等待续跑";
    task.resume = from !== "queued";
    persistReturn();
    markReturned();
    this.queue.push(id);
    this.bypass(undefined, "任务泵", this.pump());
    return { ...task.summary };
  }

  private prepareDeveloperAssistantReturn(
    task: TaskState,
    actor: string,
  ): UserInterventionReconciliation | undefined {
    this.finishDeveloperAssistantHandoff(task);
    const snapshot = readDeveloperAssistant(task.summary.workspace);
    const handoff = snapshot.handoff;
    if (!handoff) return undefined;
    if (handoff.state === "returned") return undefined;
    if (handoff.state === "running") {
      throw new TaskControlError("开发助手现场仍在收口，请稍后再交还主任务");
    }
    // revision / HEAD / 摘要哈希只帮助诊断，绝不作为恢复门禁。
    // 恢复后的主 Agent 会重新执行 mae-flow current 并扫描工作区，以
    // 内核和 Git 的最新事实继续；旧助手结论不会被当成批准或证据。
    let reconciled = handoff.state === "blocked"
      ? {
          ...handoff,
          state: "changed" as const,
          message: "旧版现场核对曾失败；已改为交由主任务重新读取，不再阻塞恢复",
        }
      : handoff;
    const pathSummary = summarizeDeveloperAssistantChangedPaths(
      reconciled.changed_paths ?? [],
    );
    if (reconciled.state === "changed"
        && (reconciled.derived_only || pathSummary.derivedOnly)) {
      reconciled = {
        ...reconciled,
        state: "unchanged" as const,
        message: "本轮只产生了可识别的构建/依赖产物，没有业务代码变化",
      };
    }
    const events = new EventLog(
      join(task.summary.workspace, "events.jsonl"),
    ).replay();
    const tools = developerAssistantTools(events);
    const changed = reconciled.state === "changed";
    let coreReconciliation: UserInterventionReconciliation | undefined;
    if (changed && task.cwd && this.options.host) {
      coreReconciliation = this.reconcileDeveloperAssistantWithCore(
        task,
        actor,
        { ...snapshot, handoff: reconciled },
        tools,
      );
      task.appliedDeveloperInterventionId = coreReconciliation.id;
      if (coreReconciliation.changed) {
        this.invalidateDeliveryAfterUserIntervention(task);
      }
    }
    const prompt = developerAssistantHandoffPrompt(
      { ...snapshot, handoff: reconciled }, tools,
    );
    if (prompt) {
      task.pendingAssistantHandoff = [task.pendingAssistantHandoff, prompt]
        .filter(Boolean).join("\n\n---\n\n");
    }
    const id = reconciled.id ?? reconciled.started_at;
    return coreReconciliation ?? {
      id,
      changed,
      from: reconciled.core?.step ?? "",
      target: reconciled.core?.step ?? "",
    };
  }

  private supersedeWaitingForUserIntervention(
    task: TaskState,
    waiting: Pick<WaitingRecord, "waiting_id" | "state_version">,
  ): void {
    try {
      task.humanGate.supersede(waiting.waiting_id, {
        stateVersion: waiting.state_version,
        notes: "用户主动接管代码现场，旧问题绑定的内容已经失效。",
      });
    } catch (error) {
      // task.json 已先原子落成 queued 且不再引用这张卡；这里失败最多
      // 留下一条不可见审计孤儿，不能让主任务重新卡回旧 waiting。
      this.options.log?.(
        `任务 ${task.summary.id} 关闭旧开发助手待办失败(不阻塞恢复): ${String(error)}`,
      );
    }
  }

  private markPreparedDeveloperAssistantReturned(task: TaskState): void {
    try {
      const snapshot = readDeveloperAssistant(task.summary.workspace);
      if (!snapshot.handoff || snapshot.handoff.state === "running"
          || snapshot.handoff.state === "returned") return;
      writeDeveloperAssistant(task.summary.workspace, {
        ...snapshot,
        handoff: markDeveloperAssistantReturned(snapshot.handoff),
      });
    } catch (error) {
      // task.json 与内核已经安全落盘。标记仅用于展示，恢复时会补做。
      this.options.log?.(
        `任务 ${task.summary.id} 开发助手交还标记待恢复补写: ${String(error)}`,
      );
    }
  }

  /** 把用户要求、助手结论、真实工具结果和变更文件交给内核的正式入口。
   * 内核只允许保持/回退步骤并作废旧证据，不会把这些内容判成 PASS。 */
  private reconcileDeveloperAssistantWithCore(
    task: TaskState,
    actor: string,
    snapshot: ReturnType<typeof readDeveloperAssistant>,
    tools: ReturnType<typeof developerAssistantTools>,
  ): UserInterventionReconciliation {
    if (!task.cwd || !this.options.host) {
      throw new TaskControlError("用户介入现场缺少内核工作区，暂不能交还");
    }
    const user = [...snapshot.messages].reverse()
      .find((message) => message.role === "user")?.text ?? "";
    const assistant = [...snapshot.messages].reverse()
      .find((message) => message.role === "assistant")?.text ?? "";
    const changedPaths = summarizeDeveloperAssistantChangedPaths(
      snapshot.handoff?.changed_paths ?? [],
    );
    const interventionId = snapshot.handoff?.id
      ?? snapshot.handoff?.started_at ?? randomUUID();
    const factsPath = join(task.summary.workspace, "user-intervention.json");
    writeFileSync(factsPath, JSON.stringify({
      schema: "mae-flow-user-intervention/1",
      intervention_id: interventionId,
      actor: actor.slice(0, 100),
      request: user.slice(0, 2_000),
      assistant_summary: assistant.slice(0, 4_000),
      changed: true,
      changed_paths: changedPaths.paths,
      changed_paths_total: changedPaths.total,
      paths_truncated: Boolean(
        snapshot.handoff?.paths_truncated || changedPaths.truncated),
      derived_only: Boolean(
        snapshot.handoff?.derived_only || changedPaths.derivedOnly),
      executions: tools.filter((tool) => tool.state !== "running")
        .slice(-8).map((tool) => ({
          name: tool.name.slice(0, 80),
          state: tool.state.slice(0, 24),
          result: (tool.result ?? "").slice(0, 800),
        })),
    }, null, 2), { mode: 0o600 });
    chmodSync(factsPath, 0o600);
    const gitView = createSafeGitView(task.cwd);
    try {
      const result = spawnSync(
        this.options.host.python ?? "python3",
        [join(this.options.host.kernelRoot, "scripts", "mae-flow.py"),
         "intervention", "reconcile", "--file", factsPath],
        {
          cwd: task.cwd,
          encoding: "utf-8",
          env: gitView.environment(),
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      const line = String(result.stdout ?? "").trim().split("\n").at(-1) ?? "";
      let record: Partial<UserInterventionReconciliation> = {};
      try { record = JSON.parse(line); } catch { /* 下面统一报人话 */ }
      if (result.status !== 0 || typeof record.target !== "string"
          || typeof record.from !== "string") {
        throw new Error(
          String(result.stderr ?? result.stdout ?? "内核没有返回接管位置").trim(),
        );
      }
      return {
        id: interventionId,
        changed: record.changed === true,
        from: record.from,
        target: record.target,
      };
    } catch (error) {
      throw new TaskControlError(
        `内核暂未接纳用户介入现场，可直接重试“交还主任务”：${String(error)}`,
      );
    } finally {
      gitView.cleanup();
    }
  }

  private invalidateDeliveryAfterUserIntervention(task: TaskState): void {
    const delivery = task.summary.delivery;
    if (!delivery) return;
    task.summary.delivery = {
      mr_url: delivery.mr_url,
      mr_id: delivery.mr_id,
      source_branch: delivery.source_branch,
      target_branch: delivery.target_branch,
      mr_state: delivery.mr_state,
    };
  }

  /** 取消是不可恢复终态。先换代并落盘，再中止会话/容器；因此即使
   * 清理期间旧请求返回，读侧也会立即看到 canceled，旧回调也无权改写。 */
  async cancel(id: string, actor: string): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    let status = task.summary.status;
    if (status === "canceled" && !task.driver && !task.container) {
      return { ...task.summary };
    }
    if (status === "completed") {
      throw new TaskControlError(`任务 ${id} 已经结束，不能再停止`);
    }
    // 人点停止与平台刚合入可能竞态。能查到已合入就先按平台事实收口，
    // 不能把一单已经合入的交付反写成“用户取消”。查询不可得时仍允许
    // 用户停止，符合明确控制指令。
    if (task.summary.delivery?.mr_url
        && ["await_merge", "verifying"].includes(status)) {
      const view = await this.fetchGates(task);
      if (view?.mrState === "merged") {
        this.settleMergeState(task, "merged", view.sourceSha);
        throw new TaskControlError(`任务 ${id} 的 MR 已合入，任务已经结束`);
      }
      status = task.summary.status;
    }
    task.controlEpoch += 1;
    task.pauseRequested = false;
    this.removeFromQueue(id);
    this.removePrePushBuildWaiter(task);
    task.summary.status = "canceled";
    task.summary.detail = `已由 ${actor} 取消`;
    task.summary.control = {
      last_action: "cancel",
      actor,
      at: new Date().toISOString(),
      paused_from: status === "paused"
        ? task.summary.control?.paused_from : status,
    };
    task.summary.waiting = undefined;
    task.mission = undefined;
    task.pendingAssistantHandoff = undefined;
    task.pendingMainSteers = undefined;
    interruptDeveloperAssistant(
      task.summary.workspace,
      `任务已由 ${actor} 取消，开发助手同时终止`,
    );
    this.persist(task);
    const driver = task.driver;
    const container = task.container;
    const prepushAbort = task.prepushAbort;
    prepushAbort?.abort();
    const cleanup = await Promise.allSettled([
      driver?.abort() ?? Promise.resolve(),
      container?.stop() ?? Promise.resolve(),
    ]);
    if (cleanup[0].status === "fulfilled") {
      if (task.driver === driver) {
        task.driver = undefined;
        driver?.dispose();
      }
    }
    if (cleanup[1].status === "fulfilled" && task.container === container) {
      task.container = undefined;
    }
    if (task.prepushAbort === prepushAbort) task.prepushAbort = undefined;
    const failures = cleanup.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${index === 0 ? "会话中止" : "容器回收"}: ${String(result.reason)}`]
        : []);
    if (failures.length) {
      task.summary.detail = `已由 ${actor} 取消，但执行资源未能确认释放：`
        + failures.join("；")
        + "。同任务禁止重跑；服务重启会按 ownership 再清扫";
      this.persist(task);
      this.options.log?.(`任务 ${id} 取消清理不完整: ${failures.join(" | ")}`);
    }
    // 等它的任务不许无限等(取消是终态):立刻跑一遍泵,把 blocked_by
    // 指向本单的排队任务如实清账,而不是等下一次碰巧有人触发泵。
    this.bypass(undefined, "任务泵", this.pump());
    return { ...task.summary };
  }

  private removeFromQueue(id: string): void {
    this.queue = this.queue.filter((queued) => queued !== id);
  }

  /** 暂停返回时旧 prepush Promise 可能还在跑 finally(销毁容器/释放槽)。
   * 直接 tryDeliver 会被 preparePush 的防重锁认成“旧动作仍在处理”并
   * 复用一个注定返回 false 的 Promise，之后再没人唤醒。先等旧锁自然
   * 清掉，再以恢复后的 epoch 启动新 attempt。 */
  private async resumePrePushVerification(
    task: TaskState,
    epoch: number,
  ): Promise<void> {
    const interrupted = task.prepushActive;
    if (interrupted) await interrupted.catch(() => false);
    if (!this.current(task, epoch)
        || task.summary.status === "paused"
        || task.summary.status === "pausing") return;
    await this.tryDeliver(task, epoch);
  }

  private current(task: TaskState, epoch: number): boolean {
    return !this.shuttingDown
      && task.controlEpoch === epoch
      && task.summary.status !== "canceled";
  }

  /**
   * completed/await_merge/blocked_by 共用的内核终态证明。
   *
   * 多仓分析单是 Cloud 自己的前置会话，本来就没有 mae-flow 状态；纯
   * 会话演练同理。除此之外一律不能拿 task.json.status 自证完成。
   */
  /** 这一单是不是在"外部验证契约"存在之前就已经收口的。
   *
   * 踩过的坑(读代码逮住,第一次重启就会发生):恢复时对每个落盘为
   * completed/await_merge 的任务重做终态对账,而老单的现场里根本没有
   * execution_contract——判据于是按"云端默认三项交流水线"取,老单永远
   * 拿不出流水线逐项 PASS,被一律判成伪终态:状态翻回验证中,接着
   * tryDeliver 真的执行 git push。已合入、远端分支早删掉的老单会被
   * **重新推回去**,任务列表里一堆历史单变"验证中"。
   *
   * 老单是按当时的规矩收的口,不该用后来的尺子重新量。判据取两条
   * 机械事实:现场没有 execution_contract(新单必然有,内核从下单事实
   * 写入),且从来没有过外部验证记录;或者交付账本已经记了合入。 */
  private settledBeforeContract(task: TaskState): boolean {
    const delivery = task.summary.delivery;
    if (delivery?.mr_state === "已合入") return true;
    if (!task.cwd) return false;
    try {
      const statePath = join(task.cwd, ".mae-flow.json");
      if (!existsSync(statePath)) return false;
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      return !state?.execution_contract
        && !state?.quality?.external_verification;
    } catch {
      // 读不出来就不敢断言"老单",走原有对账(宁可多查一次)。
      return false;
    }
  }

  private completionAttestation(
    task: TaskState,
  ): KernelCompletionAttestation | undefined {
    if (!this.options.host || this.isRequirementAnalysis(task)) return undefined;
    return inspectKernelCompletion(
      task.cwd,
      this.options.host.kernelRoot,
      true,
    );
  }

  private dependencyCompleted(task: TaskState | undefined): boolean {
    if (!task || task.summary.status !== "completed") return false;
    return this.completionAttestation(task)?.complete ?? true;
  }

  /** 终止/失败分支也必须串行确认容器删除。失败时保留 task.container，
   * retry 会据此拒绝覆盖句柄，cancel/shutdown 仍可重试回收。 */
  private async stopTaskContainer(
    task: TaskState,
    context: string,
  ): Promise<string | undefined> {
    const container = task.container;
    if (!container) return undefined;
    try {
      await container.stop();
      if (task.container === container) task.container = undefined;
      return undefined;
    } catch (error) {
      const detail = `${context}容器未能确认释放: ${String(error)}`;
      this.options.log?.(`任务 ${task.summary.id} ${detail}`);
      return detail;
    }
  }

  private async finishPause(
    task: TaskState,
    from: TaskStatus,
  ): Promise<void> {
    const epoch = task.controlEpoch;
    const driver = task.driver;
    const container = task.container;
    const prepushAbort = task.prepushAbort;
    task.pauseRequested = false;
    const undelivered = (driver as CloudSession | undefined)
      ?.takeUndeliveredSteers?.() ?? [];
    if (undelivered.length) {
      task.pendingMainSteers = [...new Set([
        ...(task.pendingMainSteers ?? []), ...undelivered,
      ])];
      this.options.log?.(
        `任务 ${task.summary.id} 暂停前保全 ${undelivered.length} 条未送达补充`);
    }
    prepushAbort?.abort();
    const cleanup = await Promise.allSettled([
      driver?.abort() ?? Promise.resolve(),
      container?.stop() ?? Promise.resolve(),
    ]);
    if (cleanup[0].status === "fulfilled") {
      if (task.driver === driver) {
        task.driver = undefined;
        driver?.dispose();
      }
    }
    if (cleanup[1].status === "fulfilled" && task.container === container) {
      task.container = undefined;
    }
    if (task.prepushAbort === prepushAbort) task.prepushAbort = undefined;
    // pause 等待资源清理期间可能又收到 cancel。后者换了 epoch 并拥有
    // 最终状态解释权；旧 pause 绝不能把 canceled 覆盖回 paused。
    if (task.controlEpoch !== epoch || task.summary.status === "canceled") return;
    const failures = cleanup.flatMap((result, index) =>
      result.status === "rejected"
        ? [`${index === 0 ? "会话中止" : "容器回收"}: ${String(result.reason)}`]
        : []);
    if (failures.length) {
      task.summary.status = "failed";
      task.summary.detail = "暂停失败，执行资源未能确认释放："
        + failures.join("；")
        + "。同任务禁止重跑；可取消后重试清理或重启服务";
      this.persist(task);
      this.notifyOutcome(task);
      this.options.log?.(`任务 ${task.summary.id} 暂停清理失败: `
        + failures.join(" | "));
      return;
    }
    task.summary.status = "paused";
    task.summary.detail = from === "waiting_for_human"
      ? "已暂停，恢复后继续等待决定"
      : from === "verifying"
        ? "已暂停状态跟踪，外部流水线不会被中止"
        : "已安全暂停，可从当前进度恢复";
    task.summary.control = {
      ...(task.summary.control ?? {
        last_action: "pause",
        actor: "系统",
        at: new Date().toISOString(),
      }),
      last_action: "pause",
      paused_from: from,
    };
    this.persist(task);
    this.activatePendingDeveloperAssistant(task);
  }

  private async pump(): Promise<void> {
    if (this.shuttingDown) return;
    // 问题流专用部署:需求任务一律不拉起。恢复的单子留在队列里
    // (状态如实显示排队中),用完整部署重启同一数据目录即自动续跑。
    if (this.options.requirementDisabled) return;
    const max = this.options.settings?.runtime().max_concurrent
      ?? this.options.maxConcurrent ?? 2;
    // 前置死透的排队任务先清账,不许无限等(哪怕队列里还有别的活可干,
    // 也不能让它静默蹲着):
    // - 前置**已取消**是用户意志的终态,等它=永远等——本任务如实
    //   failed,说明白是替谁陪葬;
    // - 前置**失败**还有救(可重试),继续排队但把话写在 detail 上,
    //   人知道该去修谁或者干脆取消本单。
    for (const queued of [...this.queue]) {
      const candidate = this.tasks.get(queued);
      if (!candidate?.summary.blocked_by?.length) continue;
      const gone = candidate.summary.blocked_by.filter((dependency) => {
        const status = this.tasks.get(dependency)?.summary.status;
        // 不存在的前置和取消一样是死透:没人能把它变回 completed。
        return status === "canceled" || status === undefined;
      });
      if (gone.length) {
        this.queue.splice(this.queue.indexOf(queued), 1);
        candidate.summary.status = "failed";
        candidate.summary.detail =
          `前置任务 ${gone.join("、")} 已取消或不存在,本任务不会启动`;
        this.persist(candidate);
        continue;
      }
      const stuck = candidate.summary.blocked_by.filter((dependency) =>
        this.tasks.get(dependency)?.summary.status === "failed");
      if (stuck.length) {
        const detail = `前置任务 ${stuck.join("、")} 失败,`
          + "重试它后本任务自动启动;不打算修就取消本任务";
        if (candidate.summary.detail !== detail) {
          candidate.summary.detail = detail;
          this.persist(candidate);
        }
      }
    }
    while (this.runningCount < max && this.queue.length) {
      const readyIndex = this.queue.findIndex((queued) => {
        const candidate = this.tasks.get(queued);
        if (!candidate) return true;
        return (candidate.summary.blocked_by ?? []).every((dependency) =>
          this.dependencyCompleted(this.tasks.get(dependency)));
      });
      if (readyIndex < 0) {
        for (const queued of this.queue) {
          const candidate = this.tasks.get(queued);
          if (!candidate?.summary.blocked_by?.length) continue;
          const waiting = candidate.summary.blocked_by.filter((dependency) =>
            !this.dependencyCompleted(this.tasks.get(dependency)));
          const detail = `等待前置任务 ${waiting.join("、")} 完成`;
          if (candidate.summary.detail !== detail
              && !candidate.summary.detail?.startsWith("前置任务")) {
            candidate.summary.detail = detail;
            this.persist(candidate);
          }
        }
        break;
      }
      const [id] = this.queue.splice(readyIndex, 1);
      const task = this.tasks.get(id);
      // 控制动作可能已经把重复/陈旧队列项暂停或取消。
      if (!task || task.summary.status !== "queued") continue;
      this.runningCount += 1;
      task.summary.status = "running";
      this.persist(task);
      const epoch = task.controlEpoch;
      this.bypass(task, "任务启动", this.launch(task, epoch).finally(() => {
        this.runningCount -= 1;
        this.bypass(undefined, "任务泵", this.pump());
      }));
    }
  }

  private async launch(task: TaskState, epoch: number): Promise<void> {
    const { workspace } = task.summary;
    try {
      const agentDir = join(workspace, "pi-agent");
      mkdirSync(agentDir, { recursive: true });
      // 兼容旧版本现场：明文凭据/helper 曾落在 agentDir。任何模型文件
      // 与 CloudSession 创建之前先机械清掉，避免恢复任务把旧秘密重新
      // 暴露给 Agent。
      this.hardenAgentGitBoundary(agentDir);
      // 模型网关热改边界:在这里生效——每个新会话起时现读设置,
      // 在跑的会话不换血(管理页如实写明了这一条)。
      const modelOverride = this.options.settings?.models() ?? {};
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify(modelOverride.json ?? this.options.modelsJson));
      // 个人 Git 身份每次启动现读。用户名/邮箱只用于 commit 署名；
      // token 仅在宿主 clone/push 的同步窗口进入 0700 临时目录，绝不
      // 进入 agentDir、仓库配置或 Agent 会话。
      const gitIdentity =
        this.options.gitCredential?.(task.summary.luban_account);
      const transcriptPath = join(workspace, "transcript.jsonl");
      // 恢复=工作区(仓库克隆)还在;克隆丢了就只能从头来。
      // savedCwd 必须先落袋:下面 task.cwd 会被暂写成 workspace,
      // 晚一步读就是把重建会话跑进任务根目录(实测:内核找不到
      // 状态文件,messages 报"未初始化")。
      const savedCwd = task.cwd;
      const requirementAnalysis = this.isRequirementAnalysis(task);
      const analysisOnly = requirementAnalysis;
      const resuming = task.resume === true
        && !!savedCwd && savedCwd !== workspace && existsSync(savedCwd);
      let cwd = workspace;
      let requirementPath = task.summary.requirement_document?.context_mode === "file"
        ? STORED_REQUIREMENT_DOCUMENT : undefined;
      let prompt = requirementContext(
        task.summary.requirement,
        task.summary.requirement_document,
        requirementPath,
      );
      let hostHooks;
      let repositorySkillPaths: string[] = [];
      let loadedRepositorySkillNames: string[] = [];
      let repositorySkillResources: Array<KnowledgeResourceRef & {
        actual_path: string;
      }> = [];
      let businessModuleKnowledge: MaterializedBusinessModuleKnowledge = {
        entries: [], skill_paths: [], warnings: [],
      };
      let engineeringKnowledge: ReturnType<typeof materializeEngineeringKnowledge>
        = { entries: [], warnings: [] };
      let hasDependencyHandoff = false;
      let knowledgeMaterialized = false;
      let activeWorkflowProfile = task.summary.workflow_profile;
      let workflowProfileMaterialized = !activeWorkflowProfile;
      const reviewLane = this.reviewRoundLane(task);
      let promptSteerCount = 0;
      task.cwd = cwd;
      if (this.options.host && analysisOnly) {
        const analysisRoot = resuming ? savedCwd! : join(workspace, "repositories");
        if (!resuming) {
          mkdirSync(analysisRoot, { recursive: true });
          const prepared = gitIdentity
            ? this.prepareHostGitSandbox(gitIdentity) : undefined;
          try {
            // for...of 而不是 forEach:cloneRepo 已异步,forEach 不等
            // async 回调,凭据会在克隆进行中被 finally 清掉。
            const repositories = task.summary.repositories ?? [];
            for (const [index, repository] of repositories.entries()) {
              // readonly:分析现场推送硬禁用(没有内核门禁兜底,禁令
              // 不能只写在 prompt 里)。
              await this.cloneRepo(analysisRoot, prepared, gitIdentity,
                repository, task.summary.baseline,
                `${index + 1}-${basename(repository).replace(/\.git$/, "") || "repo"}`,
                true);
            }
          } finally {
            this.cleanupHostGitCredential(prepared);
          }
          const ticket = task.summary.ticket ?? task.summary.id;
          const artifactDir = join(analysisRoot, ".mae-flow-work", ticket);
          mkdirSync(artifactDir, { recursive: true });
          writeFileSync(join(artifactDir, ".ticket-id"), `${ticket}\n`);
        }
        cwd = analysisRoot;
        task.cwd = cwd;
        requirementPath = materializeRequirementDocument(
          cwd, task.summary.requirement, task.summary.requirement_document);
        // 恢复旧分析现场时也清除曾经持久化的 helper；每个仓仍可正常
        // fetch/read，但 pushurl 固定为不可写地址。
        (task.summary.repositories ?? []).forEach((repository, index) => {
          const repoDir = join(analysisRoot,
            `${index + 1}-${basename(repository).replace(/\.git$/, "") || "repo"}`);
          this.hardenAgentGitBoundary(agentDir, repoDir);
        });
        const bindings = (task.summary.repositories ?? []).map(
          (repository, index) => ({
            repository,
            workspace: join(analysisRoot,
              `${index + 1}-${basename(repository).replace(/\.git$/, "") || "repo"}`),
          }));
        const materialized = materializeRepositorySkills({
          selected: task.summary.repository_skills,
          bindings,
          snapshotRoot: join(analysisRoot, ".mae-flow-work", "repository-skills"),
          reservedNames: hostSkillNames(this.options.dataDir),
        });
        this.freezeRepositoryNativeSkills(task, materialized);
        repositorySkillPaths = materialized.paths;
        loadedRepositorySkillNames = materialized.names;
        repositorySkillResources = materialized.entries.map(({ path, skill }) => ({
          id: skill.id,
          kind: "skill" as const,
          name: skill.name,
          path: skill.relative_path,
          repository: skill.repository,
          description: skill.description,
          digest: skill.digest,
          selected: true,
          actual_path: path,
        }));
        for (const warning of materialized.warnings) {
          this.options.log?.(
            `[repository-resource] 任务 ${task.summary.id}: ${warning}`);
        }
        prompt = this.requirementAnalysisPrompt(task, cwd, requirementPath);
        if (resuming) {
          prompt = [
            prompt,
            "服务重启后继续需求理解；已有分析产物和代码现场都在，"
              + "不要从头推翻，先读取现有 Chain 文档并继续。",
            task.pendingResume
              ? "用户对上一个检视问题的答复如下，连同批注一起处理：\n\n"
                + renderDecision(task.pendingResume)
              : "",
            undeliveredInterrupts(workspace).length
              ? "重启前用户还补充了：\n\n"
                + undeliveredInterrupts(workspace).join("\n\n")
              : "",
          ].filter(Boolean).join("\n\n");
        }
      } else if (this.options.host) {
        if (resuming) {
          cwd = savedCwd!;
        } else {
          const prepared = gitIdentity
            ? this.prepareHostGitSandbox(gitIdentity) : undefined;
          try {
            cwd = await this.cloneRepo(workspace, prepared, gitIdentity,
              task.summary.repo_url, task.summary.baseline);
          } finally {
            this.cleanupHostGitCredential(prepared);
          }
        }
        task.cwd = cwd;
        requirementPath = materializeRequirementDocument(
          cwd, task.summary.requirement, task.summary.requirement_document);
        this.hardenAgentGitBoundary(agentDir, cwd);
        try {
          hasDependencyHandoff = await this.materializeDependencyHandoff(task, cwd);
        } catch (cause) {
          this.options.log?.(
            `[cross-repo-handoff] 任务 ${task.summary.id} 交接生成失败(fail-open): ${cause}`);
        }
        const activeRepository = task.summary.repo_url
          ?? this.effectiveDefaultRepo();
        if (activeRepository) {
          const materialized = materializeRepositorySkills({
            selected: task.summary.repository_skills,
            bindings: [{ repository: activeRepository, workspace: cwd }],
            snapshotRoot: join(cwd, ".mae-flow-work", "repository-skills"),
            reservedNames: hostSkillNames(this.options.dataDir),
          });
          this.freezeRepositoryNativeSkills(task, materialized);
          repositorySkillPaths = materialized.paths;
          loadedRepositorySkillNames = materialized.names;
          repositorySkillResources = materialized.entries.map(({ path, skill }) => ({
            id: skill.id,
            kind: "skill" as const,
            name: skill.name,
            path: skill.relative_path,
            repository: skill.repository,
            description: skill.description,
            digest: skill.digest,
            selected: true,
            actual_path: path,
          }));
          for (const warning of materialized.warnings) {
            this.options.log?.(`[repository-skill] 任务 ${task.summary.id}: ${warning}`);
          }
        }
        // 先把任务固定知识投影到代码现场，再让内核 current 展示最终
        // 方案。否则 current 会点名一个尚不存在、甚至已损坏的路径。
        businessModuleKnowledge = materializeBusinessModuleKnowledge({
          selected: task.summary.business_modules,
          taskWorkspace: workspace,
          runtimeWorkspace: cwd,
        });
        for (const warning of businessModuleKnowledge.warnings) {
          this.options.log?.(
            `[business-module-knowledge] 任务 ${task.summary.id}: ${warning}`);
        }
        engineeringKnowledge = materializeEngineeringKnowledge({
          selected: task.summary.engineering_knowledge,
          taskWorkspace: workspace,
          runtimeWorkspace: cwd,
        });
        for (const warning of engineeringKnowledge.warnings) {
          this.options.log?.(
            `[engineering-knowledge] 任务 ${task.summary.id}: ${warning}`);
        }
        knowledgeMaterialized = true;
        // 仓库可在受版本控制的 .mae-flow-defaults.json 里声明一条
        // 「执行补充」。只在首次 clone 后读取一次,作为 repository 层
        // supplement 固定进 workflow_profile 并回写 task.json;之后
        // 恢复/重跑都沿用快照,不随仓库或管理设置漂移。坏配置只明确
        // 降级,不阻塞任务。必须先于 reconcile:两者都改 profile,
        // 后写会覆盖前写。(v1 独立文件通道已退役。)
        if (!task.summary.repository_supplement_resolved) {
          const resolved = resolveRepositorySupplement({
            workspace: cwd,
            repositoryId: activeRepository ?? task.summary.id,
          });
          if (resolved.supplement) {
            const others = (task.summary.workflow_profile?.supplements ?? [])
              .filter((item) => item.scope !== "repository");
            task.summary.workflow_profile = withWorkflowSupplements(
              task.summary.workflow_profile,
              [...others, resolved.supplement]);
          }
          task.summary.repository_supplement_resolved = true;
          if (resolved.warning) {
            task.summary.workflow_profile_warning = [
              task.summary.workflow_profile_warning, resolved.warning,
            ].filter(Boolean).join("；");
            this.options.log?.(
              `[workflow-profile] 任务 ${task.summary.id}: `
              + resolved.warning);
          }
          this.persist(task);
        }
        activeWorkflowProfile = reconcileWorkflowProfileAssets(
          task.summary.workflow_profile,
          [...businessModuleKnowledge.entries.map((item) => item.relative_path),
            ...engineeringKnowledge.entries.map((item) => item.relative_path)],
        );
        // 定格方案必须先于 bootstrapManaged 落地：bootstrap 会机械执行
        // init/current，内核要在第一条阶段指令里就读到它。文件是下单时
        // 固定的快照，不依赖 Cloud DB；失败不假装生效，后面会把同一份
        // 内容作为显式 prompt 兜底并留下日志。
        try {
          materializeWorkflowProfile(cwd, activeWorkflowProfile);
          workflowProfileMaterialized = true;
        } catch (cause) {
          this.options.log?.(
            `[workflow-profile] 任务 ${task.summary.id} 最终方案投影失败，`
            + `已退回显式 prompt（不影响开工）：${cause}`);
        }
        // 下单事实(.mae-flow-order.json,内核契约):表单收齐的单号/
        // 基线分支/工号/交付方式机械交给内核——config-review 拿它补
        // 缺省、确认卡不再问交付方式、workflow_select 免卡直接 done。
        // 光写进 prompt 靠模型转述不够:弱模型会漏、会把交付方式折成
        // 是/否卡再问一遍(车道实战教训)。交付方式写选项原文(label),
        // 内核认代号或原文全等。每次启动都重写(含重建会话):值来自
        // summary,幂等;fail-open——写不进去只记日志,流程退回转述
        // 老路,绝不拦启动。
        try {
          const utGenerationMethod = availableUtGenerationMethod(
            this.options.dataDir, loadedRepositorySkillNames);
          // 镜像到任务台账:让"UT skill 有没有被指向"在界面可查,
          // 不用翻工作区内核文件。回退仓内写法且货架非空时点名说破
          // ——skill 上架了但命名没命中 UT 模式,是最隐蔽的一种失配。
          task.summary.ut_generation_method = utGenerationMethod;
          if (utGenerationMethod === "仓内既有写法") {
            const shelf = hostSkillNames(this.options.dataDir);
            if (shelf.length) {
              this.options.log?.(
                `[ut-skill] 任务 ${task.summary.id}:货架有 Skill`
                + `(${shelf.join("、")})但没有命中 UT 命名模式,`
                + "「UT生成方式」回退为仓内既有写法;若这里面有 UT skill,"
                + "请改名为形如 java-autout/autout/xx-ut 的名字再上架");
            }
          }
          const order: Record<string, unknown> = {
            execution_contract: { ...CLOUD_EXECUTION_CONTRACT },
            "UT生成方式": utGenerationMethod,
          };
          if (requirementPath) order["需求文档"] = requirementPath;
          if (task.summary.ticket) order["单号"] = task.summary.ticket;
          if (task.summary.baseline) {
            order["基线分支"] = task.summary.baseline;
          }
          const badge = gitIdentity?.username ?? task.summary.luban_account;
          if (badge) order["工号"] = badge;
          // 检视意见修复轮:交付方式换成内核的「处理评审意见」,让这一轮
          // 开出来的是一张真正的 review 单,而不是往终态旧单上打补丁。
          // 单号/基线分支/工号照旧沿用——内核按这三项派生分支名
          // ({基线分支}_{工号}_{单号}),沿用就派生出同一个 MR 分支,
          // review 的 branch_create 于是原地冻结 HEAD 当增量基点,不另建。
          // 问不到内核选项原文就退回本单原交付方式(fail-open 到老路)。
          const lane = reviewLane || task.summary.lane;
          if (lane) order["交付方式"] = lane;
          // 跨仓拆单的方案文档:拆单时落在任务 workspace 根,这里带进
          // 克隆并经下单事实把「需求文档」指过去——方案经内核流程在
          // 配置/需求阶段被读,而不是塞进开场 prompt 被模型当实施计划
          // 直接开写(2026-08-19 内网实锤)。每次启动重拷,幂等。
          const planSource = join(workspace, "chain-plan.md");
          if (existsSync(planSource)) {
            writeFileSync(join(cwd, ".mae-flow-chain.md"),
              readFileSync(planSource, "utf-8"));
            order["需求文档"] = ".mae-flow-chain.md";
          }
          writeFileSync(join(cwd, ".mae-flow-order.json"),
            JSON.stringify(order, null, 2) + "\n");
          // 平台的现场文件不该混进交付提交:登记进 .git/info/exclude
          // (不动仓里的 .gitignore——那是用户的文件)。
          const infoDir = join(cwd, ".git", "info");
          if (existsSync(infoDir)) {
            const excludePath = join(infoDir, "exclude");
            const current = existsSync(excludePath)
              ? readFileSync(excludePath, "utf-8") : "";
            // 内核会话产物也在此登记——不能指望业务仓的 .gitignore 认识
            // mae-flow(run9 实测:openspec/config.yaml 不在忽略里,prepush
            // 修复 Agent 为了收干净工作区,把它提交进了**用户的 .gitignore**
            // 并随 MR 推走,平台关切污染了用户仓)。
            const missing = [
              ".mae-flow-order.json", ".mae-flow-chain.md",
              ".mae-flow-dependencies.md", ".mae-flow-issue.md",
              AGENT_REQUIREMENT_DOCUMENT,
              ".mae-flow.json", ".mae-flow.json.exited",
              ".mae-flow-history.jsonl", ".mae-flow-work/",
              "openspec/config.yaml",
            ]
              .filter((entry) => !current.includes(entry));
            if (missing.length) {
              writeFileSync(excludePath,
                `${current}${current && !current.endsWith("\n") ? "\n" : ""}`
                + missing.join("\n") + "\n");
            }
          }
        } catch (cause) {
          this.options.log?.(
            `[order] 下单事实写入失败(fail-open,退回 prompt 转述): ${cause}`);
        }
        const kernel = new KernelHost({
          kernelRoot: this.options.host.kernelRoot,
          workspace: cwd,
          fileAccessRoot: workspace,
          transcriptPath,
          taskId: task.summary.id,
          python: this.options.host.python,
          log: this.options.log,
        });
        // 首条 prompt = 需求 + 内核自己的开工引导(转发壳/init 指引),
        // 不由云端复述内核该说的话。重启后的 sessionstart 对内核是
        // 常态(老宿主重启会话同款),ACTIVE 状态下引导即当前步指引。
        const requirementForAgent = requirementContext(
          task.summary.requirement,
          task.summary.requirement_document,
          requirementPath,
        );
        const repairKernelOwnership = () => {
          if (!this.options.isolation) return;
          repairContainerKernelOwnership({
            workspace: cwd,
            user: this.options.isolation.user,
          });
        };
        // Cloud 已经明确创建了交付任务：宿主先机械 init/current，再让
        // 模型入场。不能把“第一步是否执行 init”交给模型概率，更不能
        // 在 INACTIVE 全放行窗口里让它先写代码。检视意见是内核定义的
        // 新 review 轮，允许从上一轮 terminal 机械滚动；CI/冲突轻修
        // 维持既有轻量语义，不擅自重开完整流程。
        const guidance = await kernel.bootstrapManaged(
          requirementForAgent,
          { rolloverTerminal: Boolean(reviewLane) },
        );
        repairKernelOwnership();
        if (!this.current(task, epoch)) return;
        prompt = guidance
          ? `${requirementForAgent}\n\n${guidance}`
          : requirementForAgent;
        if (resuming) {
          // 重启期间收到的决定,正文必须随重建会话一起给模型。
          //
          // 踩过的坑(用户实测):批注随决定提交后,模型回来说"你上次点了
          // 需要调整代码,但具体意见没有落盘"。查下来是真的:injectDecision
          // 只把答复写进事件日志/transcript(我们的账)并经 posttooluse 交给
          // 内核,而内核那条通道只认结构化选项;`messages` 看的是
          // UserPromptSubmit 捕获的普通用户消息,工具答复的正文不在里面。
          // 重建会话又没有挂起的工具调用可 resolve——于是选项到了、理由丢了,
          // 模型只能空手回来再问一遍。用户的话必须由我们自己送到。
          const answered = task.pendingResume
            ? renderDecision(task.pendingResume) : "";
          const unsaid = undeliveredInterrupts(workspace);
          prompt = [
            guidance,
            "云端服务重启,本会话为重建会话:此前对话不在上下文里," +
            "流程真相以内核状态为准。执行 current 查看当前步骤;" +
            "此前向用户的提问均已答复并录入台账(执行 messages 查看)," +
            "不要重复提问;继续推进直到流程 end。",
            answered
              ? "用户对上一个问题的答复原文如下,按它继续,不要再问一遍:\n\n"
                + answered
              : "",
            unsaid.length
              ? "重启前用户还插话说了下面这些,一并按它办:\n\n"
                + unsaid.join("\n\n")
              : "",
          ].filter(Boolean).join("\n\n");
        }
        hostHooks = {
          preTool: async (event) => {
            const result = await kernel.preTool(event);
            repairKernelOwnership();
            return result;
          },
          postTool: async (event) => {
            const result = await kernel.postTool(event);
            repairKernelOwnership();
            return result;
          },
          flush: kernel.flush.bind(kernel),
        };
      } else if (resuming || task.resume) {
        // 非内核模式(演练/测试)同样不许丢话:重建会话没有挂起的工具
        // 调用可 resolve,决定正文只能由这条 prompt 送到模型眼前。
        prompt = [
          `服务重启,继续任务:${requirementContext(
            task.summary.requirement,
            task.summary.requirement_document,
            requirementPath,
          )}`,
          task.pendingResume
            ? "用户对上一个问题的答复原文如下,按它继续,不要再问一遍:\n\n"
              + renderDecision(task.pendingResume)
            : "",
          ...(undeliveredInterrupts(workspace).length
            ? ["重启前用户还插话说了下面这些,一并按它办:\n\n"
               + undeliveredInterrupts(workspace).join("\n\n")]
            : []),
        ].filter(Boolean).join("\n\n");
      }
      if (!knowledgeMaterialized) {
        businessModuleKnowledge = materializeBusinessModuleKnowledge({
          selected: task.summary.business_modules,
          taskWorkspace: workspace,
          runtimeWorkspace: cwd,
        });
        for (const warning of businessModuleKnowledge.warnings) {
          this.options.log?.(
            `[business-module-knowledge] 任务 ${task.summary.id}: ${warning}`);
        }
        engineeringKnowledge = materializeEngineeringKnowledge({
          selected: task.summary.engineering_knowledge,
          taskWorkspace: workspace,
          runtimeWorkspace: cwd,
        });
        for (const warning of engineeringKnowledge.warnings) {
          this.options.log?.(
            `[engineering-knowledge] 任务 ${task.summary.id}: ${warning}`);
        }
        activeWorkflowProfile = reconcileWorkflowProfileAssets(
          task.summary.workflow_profile,
          [...businessModuleKnowledge.entries.map((item) => item.relative_path),
            ...engineeringKnowledge.entries.map((item) => item.relative_path)],
        );
      }
      const workflowSupplement = workflowProfilePrompt(
        activeWorkflowProfile);
      if (workflowSupplement
          && (analysisOnly || !this.options.host
              || !workflowProfileMaterialized)) {
        prompt = `${prompt}\n\n${workflowSupplement}`;
      }
      if (task.summary.workflow_profile_warning) {
        prompt = `${prompt}\n\n⚠ ${task.summary.workflow_profile_warning}`;
      }
      // 2026-08-25 编排瘦身:编码期不再禁止编译/自测——用户给了容器
      // 构建环境,就让 agent 自由用起来验证自己;但本地绿不构成交付
      // 证据,真验收固定三道(prepush 专项会话、绑 SHA 的权威流水线、
      // MR 检视),这个口径必须开场钉死,防模型拿自测结果顶账。
      if (this.options.host && !analysisOnly) {
        const utGenerationMethod = availableUtGenerationMethod(
          this.options.dataDir, loadedRepositorySkillNames);
        task.summary.ut_generation_method = utGenerationMethod;
        prompt = `${prompt}\n\nCloud 执行契约(宿主事实):你的 Bash 在隔离容器中执行,`
          + `容器里可以自由编译、运行单测来验证自己的改动——有构建链就`
          + `尽管用,没有就如实说明留给流水线,不要为编译环境卡住。`
          + `这些本地结果只用于自查,**不构成任何交付证据**。真验收有三道:`
          + `每次 push 前 Cloud 另起专项 Agent 在构建容器完成编译、UT 与`
          + `必要修复;权威流水线绑提交 SHA 复核(编译、UT 运行、CodeCheck);`
          + `MR 检视人裁决。可用的 UT 编写方式是「${utGenerationMethod}」,`
          + `写测试前先按它读取对应 skill 或仓内写法。不要编造命令、结果、`
          + `数量或绿灯。完成实现与 UT 编写后按内核流程提交;不要读取或`
          + `索要个人 Git 令牌,也不要 push,Agent 会话释放后由 Cloud 宿主`
          + `统一推送并复核远端 SHA。流水线失败时,只依据该次流水线证据`
          + `定位并修复。`;
      }
      if (hasDependencyHandoff) {
        prompt = `${prompt}\n\n本任务有跨仓前置交付。开始设计、改接口或实现前，`
          + `必须先读取 .mae-flow-dependencies.md，并用它核对最初 Chain 契约。`
          + `发现上游实际交付、当前实现或契约互相冲突时，停止猜测并举卡，`
          + `明确写出受影响的仓库、接口与需要谁确认；不要自行发明兼容方案。`;
      }
      if (!analysisOnly && task.summary.cross_repository_updates?.length) {
        prompt = `${prompt}\n\n跨仓主任务在分工后又收到以下影响同步。逐条核对它们`
          + `是否改变当前仓的接口、设计或实现；有冲突就举卡并回报主任务，`
          + `不要静默猜测：\n`
          + task.summary.cross_repository_updates.slice(-10)
            .map((update) => `- [${update.source_repository ?? update.source_task_id}`
              + ` / ${update.author}] ${update.text}`).join("\n");
      }
      if (!analysisOnly && loadedRepositorySkillNames.length) {
        prompt = `${prompt}\n\n本单已启用仓库自带 Skill：`
          + `${loadedRepositorySkillNames.join("、")}。它们是可选工作指南，`
          + `请根据系统能力目录中的 description 自行判断何时读取；不要求`
          + `逐个使用，也不得用 Skill 改写 Mae-Flow 当前步骤、文件边界、`
          + `Git 权限、Cloud 执行契约或任何验证/交付证据。`;
      }
      if (!analysisOnly) {
        prompt = `${prompt}\n\n仓库根目录下的 Agent 平台目录（`
          + `${describeAgentPlatformRoots()}）可能由中心能力服务在 clone 后`
          + `临时注入，只供本工作区运行。可以读取系统明确装载的 Skill，`
          + `但不要修改、删除、强制 git add 或提交这些目录，也不要为了`
          + `隐藏它们修改业务仓 .gitignore；Cloud 已登记本地忽略并会在`
          + `push 前复核整个提交历史。`;
      }
      // 提交信息规范(部署级):平台的 pre-receive 钩子会按正则拒收不
      // 合规的提交信息——内网实测被拒过一次("does not match the
      // regular-expression"),而那时代码早已写完,重来一遍是纯浪费。
      // 规矩必须开场就给,每个会话都带:修复会话同样要提交。
      const convention = this.effectiveCommitConvention();
      if (!analysisOnly && convention) {
        prompt = `${prompt}\n\n提交信息规范(平台钩子会按它校验,不合规`
          + `直接拒收 push,请第一次就写对):${convention}`;
      }
      // 交付方式的预答契约要**开场就告诉模型**:预答机制只认"标准卡"
      // (选项原文里含有用户选的那一项)。不说这句,模型有它自己的好心
      // ——从需求原文猜到用户想局部修改,就自造一张"是否选择局部修改?"
      // 的是/否卡(内网实测),而是/否里没有选项原文,预答对不上号,
      // 卡真去等人:用户明明下单时答过,中途又被问一遍。宿主不替内核
      // 判卡(是/否算不算数是内核的事),但可以不让模型把卡出歪。
      // 配置事实(用户下单时已给):单号/基线分支/工号不再让模型开口
      // 问——配置确认"一次问一项事实"的前提是事实缺席,这些没缺。取值
      // 口径仍归内核(REQ→feat/DTS→fix 的推导、分支名派生都是它的判定,
      // 宿主只递事实);确认卡照出,用户最终把关的那一道不省。
      const facts: string[] = [];
      if (task.summary.ticket) facts.push(`单号:${task.summary.ticket}`);
      if (task.summary.baseline) {
        facts.push(`基线分支:${task.summary.baseline}`);
      }
      if (gitIdentity) {
        facts.push(`工号(git 用户名,已写进仓库配置):${gitIdentity.username}`);
      }
      if (!analysisOnly && this.options.host && facts.length) {
        prompt = `${prompt}\n\n配置事实(用户下单时已提供,配置确认直接`
          + `采用,不要再逐项询问):${facts.join(";")}。其余配置项照`
          + `内核口径取值或询问。`;
      }
      // 交付方式已由下单事实文件交给内核:内核 current 会自己下指令
      // (已选定则"直接 done --choice 不出卡";旧快照没这契约则照旧
      // 举卡)。prompt 只补一句立场,具体怎么走听内核的——两种内核
      // 版本都不矛盾。唯一要钉死的是不许自造"是/否"卡:选项原文对
      // 不上号,预答接不住,只能真去等人(内网实测)。
      const activeLane = reviewLane || task.summary.lane;
      if (!analysisOnly && this.options.host && activeLane) {
        prompt = `${prompt}\n\n交付方式用户已在下单时选定:`
          + `${activeLane}(已写入工作区下单事实,内核能读到)。`
          + `流程走到交付方式选择时**严格照内核指令执行**:内核说直接`
          + ` done --choice 就直接执行,内核要求出卡就**原样列出标准`
          + `选项**(系统会替用户选中含「${activeLane}」的那一`
          + `项)。禁止自造"是/否"确认卡,禁止替用户改选。`;
      }
      if (task.pendingAssistantHandoff) {
        prompt = `${prompt}\n\n${task.pendingAssistantHandoff}`;
      }
      if (task.pendingMainSteers?.length) {
        promptSteerCount = task.pendingMainSteers.length;
        prompt = `${prompt}\n\n主任务在暂停前尚未读取的用户补充（按原始顺序优先处理）：\n`
          + task.pendingMainSteers.map((text) => `- ${text}`).join("\n");
      }
      // 专项使命(修复环)压轴:模型最后读到的最要紧。这里只用不清——
      // 修复会话跑一半被重启,使命要跟着 task.json 回来再喂一遍;
      // 清账在 settle 收口处,会话真做完了才算消费掉。
      if (task.mission) prompt = `${prompt}\n\n${task.mission}`;
      // 容器隔离:bash 进任务专属容器(工作区同路径挂载),
      // 起不来直接抛=任务 failed——静默降级回宿主是假隔离。
      if (this.options.isolation) {
        // 工作区记在任务上:防御性重建必须挂回同一个目录，需求理解单
        // 的 cwd 是 repositories/，普通任务则是仓库根。
        task.containerWorkspace = cwd;
        task.container = await this.startCodingContainer(task);
        if (!this.current(task, epoch)) {
          await task.container.stop().catch(() => undefined);
          task.container = undefined;
          return;
        }
      }
      task.driver = await CloudSession.create({
        taskId: task.summary.id,
        workspace: cwd,
        agentDir,
        // 宿主级 skill:<数据目录>/skills 放一次,每个任务都带
        // (团队的 UT 写法指南在内网,老宿主靠手动集成进子 agent)。
        hostSkillsDir: taskHostSkillsDir(this.options.dataDir, task.summary),
        knowledgeContext: task.summary.host_skills_pinned ? undefined : {
          repositories: task.summary.repositories ?? [],
          technologies: [...new Set((task.summary.repository_profiles ?? [])
            .flatMap((profile) => profile.technologies))],
          businessModuleIds: (task.summary.business_modules ?? [])
            .map((module) => module.id),
        },
        repositorySkillPaths,
        repositorySkillResources,
        businessModuleKnowledge,
        engineeringKnowledge,
        knowledgeTrace: this.knowledgeTrace(task, cwd),
        currentStep: () => this.currentStepLabel(task),
        // 上下文撑爆时自愈压缩用的锚:与主动压缩同一个内核现场,
        // 摘要围绕"当前步骤+已确认配置"组织,不由云端编造。
        compactAnchor: () => this.kernelAnchor(task),
        onTokenUsage: (sample) => this.recordTaskTokenUsage(task, sample),
        vision: this.taskVision(task),
        // 任务级选择 > 设置层默认 > 部署默认;任务级的记在 summary 上,
        // 重启续跑/会话重建都不漂移(设置层后来改了也不影响本单)。
        provider: task.summary.model_choice?.provider
          ?? modelOverride.provider ?? this.options.provider,
        model: task.summary.model_choice?.model
          ?? modelOverride.model ?? this.options.model,
        eventLog: new EventLog(
          join(workspace, "events.jsonl"),
          (event) => this.bypass(
            task, "投影事件", this.options.projection?.appendEvent(event))),
        transcript: new TranscriptStore(transcriptPath, "main"),
        gate: new GateService({
          contract: this.options.contract,
          // 边界=整个任务工作区(修复材料在仓外的 ../pipeline、../reviews);
          // 相对路径仍按会话 cwd(代码仓)解析。
          workspace,
          cwd,
          log: this.options.log,
          failClosed: Boolean(this.options.host),
        }),
        humanGate: task.humanGate,
        hostHooks,
        bashOperations: task.container
          ? {
              // 不锁死开场那个容器实例:等人期间它会被释放,这里必须
              // 每次现取,取不到就现开(开不起来照样抛,不回宿主)。
              exec: async (command, dir, execOptions) =>
                (await this.activeTaskContainer(task))
                  .exec(command, dir, execOptions),
            }
          : undefined,
        afterFileMutation: this.options.isolation
          ? (path) => {
            repairContainerMutationOwnership({
              workspace: cwd,
              path,
              user: this.options.isolation?.user,
            });
          }
          : undefined,
        log: this.options.log,
      });
      if (!this.current(task, epoch)) {
        task.driver.dispose();
        task.driver = undefined;
        await (task.container?.stop() ?? Promise.resolve())
          .catch(() => undefined);
        task.container = undefined;
        return;
      }
      if (task.pauseRequested || task.summary.status === "pausing") {
        await this.finishPause(task, "running");
        return;
      }
      // 环境预热与主 Agent 并行:此刻它在需求澄清,没人动代码。
      this.startBaselineWarmup(task, epoch);
      // 重建会话:恢复期收到的决定先补登记(tool_result 与崩溃前的
      // tool_use 行 join,答案进内核台账),再从内核 current 续跑。
      // 内核模式下克隆丢失=现场没了,决定无处可注,只能从头来。
      const rebuild = task.resume === true
        && (resuming || !this.options.host);
      const pending = task.pendingResume;
      task.resume = false;
      task.pendingResume = undefined;
      if (rebuild && pending) {
        task.driver.injectDecision(pending);
      } else if (pending) {
        this.options.log?.(
          `任务 ${task.summary.id} 工作区丢失,决定无法回注,从头执行`);
      }
      const turn = rebuild
        ? task.driver.startResume(prompt)
        : task.driver.start(prompt);
      // prompt 构造之后、driver 就绪之前仍可能收到人工检视。构造前已有
      // 的内容已经随 prompt 送达；窗口内新到的内容在同一只 Agent 上
      // steer，不能因为启动竞态再开第二只会话抢工作区。
      const lateSteers = (task.pendingMainSteers ?? []).slice(promptSteerCount);
      // start/startResume 已同步把 prompt 交给会话；到这里才消费一次性
      // 交还摘要。若此前进程退出，task.json 仍保留它，下次不会丢。
      if (task.pendingAssistantHandoff || task.pendingMainSteers?.length) {
        task.pendingAssistantHandoff = undefined;
        task.pendingMainSteers = undefined;
        this.writeTaskState(task);
      }
      for (const message of lateSteers) {
        await task.driver.steer(message);
      }
      await this.settle(task, turn, epoch);
    } catch (error) {
      if (!this.current(task, epoch)) return;
      const driver = task.driver;
      if (task.driver === driver) task.driver = undefined;
      driver?.dispose();
      const cleanupFailure = await this.stopTaskContainer(task, "启动失败后");
      if (!this.current(task, epoch)) return;
      task.summary.status = "failed";
      task.summary.detail = [String(error), cleanupFailure]
        .filter(Boolean).join("；");
      this.persist(task);
      this.options.log?.(`任务 ${task.summary.id} 启动失败: ${String(error)}`);
    }
  }

  /** 平台请求的个人身份头:适配层拿它调 CLI,MR 发起人=任务归属人;
   * 没配令牌的回落适配层的服务账号。percent 编码防非 ASCII 撞 HTTP
   * 头限制;**令牌只进请求头,绝不进请求体**——体会被外部动作台账
   * 原样记进投影,头不会。 */
  private platformIdentity(task: TaskState): Record<string, string> {
    const credential =
      this.options.gitCredential?.(task.summary.luban_account);
    if (!credential) return {};
    return {
      "x-mfc-git-user": encodeURIComponent(credential.username),
      "x-mfc-git-token": encodeURIComponent(credential.password),
    };
  }

  /** external_verify 之后的异常不是“交付旁路失败也算完成”。内核正在
   * 明确等待宿主核销三项质量义务，任何缺口都只能留在 verifying。 */
  private holdExternalVerification(task: TaskState, reason: string): void {
    task.summary.status = "verifying";
    task.summary.detail = reason;
    task.summary.delivery = {
      ...task.summary.delivery,
      mr_state: task.summary.delivery?.mr_state ?? "验证中",
      waiting_on: reason,
    };
    this.persist(task);
  }

  /** 外部验证的自愈预算:第一次挂起时开表,之后每次续命都对表。
   *
   * 为什么要有:等待点上的每一次挂起都可能是暂时的(内网 push 504、
   * MR 网关抖、内核登记撞上并发),值得自己再试;但"再试"没有尽头就
   * 是死等——本仓的红线写死了凡等待必须带预算。预算沿用轮询那一档
   * (默认 30 分钟),不另立旋钮。 */
  private verificationDeadline(task: TaskState): number {
    const delivery = task.summary.delivery;
    const existing = delivery?.verify_deadline
      ? Date.parse(delivery.verify_deadline) : NaN;
    if (Number.isFinite(existing)) return existing;
    const knobs = this.options.settings?.runtime() ?? {};
    const budget = (knobs.poll_timeout_s !== undefined
      ? knobs.poll_timeout_s * 1000 : undefined)
      ?? this.options.delivery?.pollTimeoutMs ?? 30 * 60_000;
    const deadline = Date.now() + budget;
    task.summary.delivery = {
      ...delivery,
      verify_deadline: new Date(deadline).toISOString(),
    };
    return deadline;
  }

  /** 自愈到头了:如实停下、写清原因、喊人。任务留在 verifying(代码
   * 确实已提交,不能假装 failed 也不能假装完成),但从此 retry 放行、
   * 页面亮牌子——人办完外部的事点「重跑续推」,机器接着干。 */
  private markVerificationStalled(task: TaskState, reason: string): void {
    const delivery = task.summary.delivery;
    if (delivery?.stalled) return; // 幂等:同一次停摆只喊一次
    task.summary.status = "verifying";
    task.summary.detail = `自动验证已停,需要你介入:${reason}`;
    task.summary.delivery = {
      ...delivery,
      mr_state: delivery?.mr_state ?? "验证中",
      waiting_on: reason,
      stalled: reason,
      verify_deadline: undefined,
    };
    this.persist(task);
    this.notifyRepairStopped(task);
  }

  /** 挂起=先自愈再说:排一次带预算的重试;预算到了就停下喊人。
   * 停摆之后不再自动重排——人点了「重跑续推」才重新开表。 */
  private holdWithRecovery(
    task: TaskState,
    reason: string,
    epoch: number,
  ): void {
    if (task.summary.delivery?.stalled) {
      this.holdExternalVerification(task, reason);
      return;
    }
    const deadline = this.verificationDeadline(task);
    this.holdExternalVerification(task, reason);
    if (Date.now() >= deadline) {
      this.markVerificationStalled(task, reason);
      return;
    }
    this.scheduleDeliveryRecovery(task, epoch);
  }

  /** 交付侧的带预算重试(推送/MR/流水线触发失败走这条)。
   *
   * 对表由这条循环自己拿着,不能指望 tryDeliver:内核停在 end 时它
   * 的 catch 根本不挂起(那是 external_verify 才走的分支),于是只会
   * 试一次就散——测试逮住过。 */
  private scheduleDeliveryRecovery(task: TaskState, epoch: number): void {
    if (task.deliveryRecoveryActive) return;
    task.deliveryRecoveryActive = true;
    const knobs = this.options.settings?.runtime() ?? {};
    const delay = Math.max(50,
      (knobs.poll_interval_s !== undefined
        ? knobs.poll_interval_s * 1000 : undefined)
      ?? this.options.delivery?.pollIntervalMs ?? 10_000);
    const timer = setTimeout(() => {
      task.deliveryRecoveryActive = false;
      this.bypass(task, "交付自愈重试", this.runDeliveryRecovery(task, epoch));
    }, delay);
    timer.unref();
  }

  private async runDeliveryRecovery(
    task: TaskState,
    epoch: number,
  ): Promise<void> {
    if (!this.recoveryStillNeeded(task, epoch)) return;
    if (this.reviewReplyOutboxStalled(task)) {
      const readable = await this.flushReviewReplyOutbox(task);
      if (!readable || this.reviewReplyOutboxStalled(task)) {
        // 账本损坏不是一次性网络抖动，也不受普通验证超时预算限制；
        // 管理员可原地修复，服务在同一进程持续探测并自动续接。
        this.scheduleDeliveryRecovery(task, epoch);
        return;
      }
      if (this.current(task, epoch)
          && task.summary.status === "verifying") {
        await this.tryDeliver(task, epoch);
      }
      return;
    }
    await this.tryDeliver(task, epoch);
    if (!this.recoveryStillNeeded(task, epoch)) return;
    if (Date.now() >= this.verificationDeadline(task)) {
      this.markVerificationStalled(task, this.stallReason(task));
      return;
    }
    this.scheduleDeliveryRecovery(task, epoch);
  }

  /** 停摆要说病因不是症状:"权威流水线尚未逐项通过"是症状,
   * "宿主推送失败: fatal: ..." 才是人能拿着去办的那句。交付成功时
   * delivery 会整份换掉,skipped 不会残留成假线索。 */
  private stallReason(task: TaskState): string {
    const delivery = task.summary.delivery;
    return delivery?.skipped ?? delivery?.waiting_on
      ?? task.summary.detail ?? "外部验证迟迟没有结果";
  }

  /** 还该不该我管:别人在盯的(流水线轮询、证据核销重试)让它盯,
   * 已经走出验证中或已如实停摆的收手——两条自愈链不许互相踩。 */
  private recoveryStillNeeded(task: TaskState, epoch: number): boolean {
    return this.current(task, epoch)
      && task.summary.status === "verifying"
      && (!task.summary.delivery?.stalled
        || this.reviewReplyOutboxStalled(task))
      && task.summary.delivery?.pipeline !== "running"
      && !task.evidenceRetryActive
      && !task.repairEvidenceRetryActive;
  }

  /** INCOMPLETE / STALE / 登记抖动都是宿主等待，不得把 Agent 催回来
   * “补证据”。同 SHA 只刷新平台事实并重做内核 record；仅 STALE（本地
   * HEAD 已变化）回 tryDeliver，让宿主推新 HEAD 并启动对应的新流水线。
   * timer unref，不吊住进程；重启由 recover 的 verifying+success 分支
   * 重新挂起。 */
  private schedulePipelineEvidenceRetry(
    task: TaskState,
    sha: string,
    epoch: number,
    stale: boolean,
  ): void {
    if (task.evidenceRetryActive) return;
    if (task.summary.delivery?.stalled) return;
    // 核销重试也吃同一份预算:平台把某个 job 报成 skipped/manual 时
    // 它永远不会变绿,原来会每 10 秒拉一个内核子进程一直转到天荒地老。
    if (Date.now() >= this.verificationDeadline(task)) {
      this.markVerificationStalled(task, this.stallReason(task));
      return;
    }
    task.evidenceRetryActive = true;
    const knobs = this.options.settings?.runtime() ?? {};
    const delay = Math.max(50,
      (knobs.poll_interval_s !== undefined
        ? knobs.poll_interval_s * 1000 : undefined)
      ?? this.options.delivery?.pollIntervalMs
      ?? 10_000);
    const timer = setTimeout(() => {
      task.evidenceRetryActive = false;
      if (!this.current(task, epoch)
          || task.summary.status !== "verifying"
          || task.summary.delivery?.sha !== sha
          || task.summary.delivery?.pipeline !== "success") return;
      this.bypass(task, "流水线证据自动重试", stale
        ? this.tryDeliver(task, epoch)
        : this.retryPipelineEvidence(task, sha, epoch));
    }, delay);
    timer.unref();
  }

  /** 同 SHA 只查已有 run 并重做 record，绝不 POST trigger。查询短暂失败
   * 时仍可用上次已落袋的整体状态重试登记。 */
  private async retryPipelineEvidence(
    task: TaskState,
    sha: string,
    epoch: number,
  ): Promise<void> {
    if (!this.current(task, epoch)
        || task.summary.status !== "verifying"
        || task.summary.delivery?.sha !== sha) return;
    let status: "success" | "failed" = "success";
    let checks = task.summary.delivery.checks;
    let log = "";
    try {
      const repo = encodeURIComponent(
        task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "");
      const mrId = task.summary.delivery?.mr_id;
      const result = await fetch(
        `${this.effectivePlatformUrl()}/pipeline/status`
        + `?sha=${sha}&repo=${repo}`
        + (mrId !== undefined
          ? `&mr=${encodeURIComponent(String(mrId))}` : ""),
        { headers: this.platformIdentity(task) }).then((r) => readJson(r));
      if (!this.current(task, epoch)
          || task.summary.status !== "verifying") return;
      // 与主轮询同一道防陈灯核验:重试登记也不许拿别的提交的灯凑数。
      const allRuns = Array.isArray(result.runs) ? result.runs : [];
      const latestRuns = allRuns.length ? [allRuns.at(-1)!] : [];
      const terminal = selectTerminalRun<Record<string, unknown> & {
        status?: string; sha?: string; is_valid?: boolean;
      }>(latestRuns, sha).run;
      if (allRuns.length && !terminal) {
        // 查询成功且最新 run 明确尚未形成可接收终态时，不能回退复用
        // 上一次 success；把任务重新交给常规轮询，等这次最新 run。
        task.summary.delivery = {
          ...task.summary.delivery,
          pipeline: "running",
        };
        this.persist(task);
        this.bypass(task, "流水线轮询", this.pollPipeline(task, epoch));
        return;
      }
      if (terminal) {
        status = terminal.status === "failed" ? "failed" : "success";
        checks = parsePipelineChecks(terminal.checks);
        log = String(terminal.log ?? "");
        task.summary.delivery = {
          ...task.summary.delivery,
          pipeline: status,
          ...(checks !== undefined ? { checks } : {}),
        };
      }
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 流水线证据刷新失败(仍重试登记): ${String(error)}`);
    }
    await this.pipelineVerdict(task, sha, status, log, checks, epoch);
  }

  /** 读取真正准备传输的 Git 提交。git push 只传 HEAD 可达对象，工作区
   * 的未提交/未跟踪文件不会进入远端；PASS 因此只绑定 SHA，不再用
   * `git status` 把编译产物误当成 push 阻断条件。 */
  private async prePushRevision(task: TaskState): Promise<PrePushRevision> {
    if (!task.cwd) throw new Error("任务没有代码工作区，不能执行 Build-Fix");
    const head = await runSafeWorktreeGitAsync(
      task.cwd, ["rev-parse", "--verify", "HEAD"], { timeoutMs: 30_000 });
    const sha = String(head.stdout ?? "").trim();
    if (head.status !== 0 || !sha) {
      throw new Error(`Build-Fix 读取 HEAD 失败: ${String(head.stderr ?? "")}`);
    }
    return {
      sha,
      workspace_fingerprint: createHash("sha256")
        .update(sha).digest("hex"),
    };
  }

  /** 脏路径清单(空数组=clean)。为什么要路径不只要布尔(2026-08-25
   * 内网事故复盘):构建在同挂载工作区里落产物时,"工作区仍有未提交
   * 业务改动"这句既没告诉模型该清什么,也没告诉人该 gitignore 什么,
   * 每一轮验证都在同一处失败还说不出原因。git 读不到时返回哨兵行——
   * 判 dirty 并把原因说出来,不许把"读不到"伪装成"干净"。 */
  private async prePushDirtyPaths(task: TaskState): Promise<string[]> {
    if (!task.cwd) return ["(任务没有代码工作区)"];
    const status = await runSafeWorktreeGitAsync(
      task.cwd, [
        "status", "--porcelain=v1", "--untracked-files=all", "--", ".",
        ":(exclude).mae-flow.json", ":(exclude).mae-flow-*",
        ":(exclude).mae-flow-work/**", ":(exclude).codecheckcli/**",
        ...AGENT_PLATFORM_PATHSPECS,
      ], { timeoutMs: 30_000 });
    if (status.status !== 0) {
      return [`(git status 读取失败: ${
        String(status.stderr ?? status.error ?? "").trim().slice(0, 200)})`];
    }
    // porcelain v1:两位状态 + 空格 + 路径;改名行取箭头右侧。
    // 用户在推送确认时拍板剔除的文件是"确认不交付"的改动,留在工作区
    // 不算脏账——不放行的话,后续每一轮 prepush 都会被它们绊倒。
    const sanctioned = new Set(
      task.summary.delivery_selection?.excluded_paths ?? []);
    return String(status.stdout ?? "").split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => line.slice(3).split(" -> ").pop() ?? line)
      .filter((path) => !sanctioned.has(path));
  }

  private setPrePushState(
    task: TaskState,
    state: PrePushVerificationState,
  ): void {
    task.summary.delivery = { ...task.summary.delivery, prepush: state };
  }

  /** 领域状态说“准备中”不等于进程还活着。页面和投影只通过这里读取
   * 当前 serve 的真实所有权，绝不再拿持久化阶段猜 runner/容器活性。 */
  private prePushRuntime(task: TaskState): {
    state: PrePushRuntimeState;
    message: string;
  } {
    const prepush = task.summary.delivery?.prepush;
    if (!prepush) return { state: "idle", message: "尚未开始 Build-Fix" };
    if (task.prepushActive) {
      return { state: "running", message: "当前服务正在执行这轮 Build-Fix" };
    }
    if (task.prepushRecoveryActive) {
      return { state: "recovering", message: "服务正在恢复上次中断的 Build-Fix" };
    }
    if (["passed", "user_skipped"].includes(prepush.state)) {
      return { state: "idle", message: "Build-Fix 已经收口" };
    }
    if (["blocked", "environment_error"].includes(prepush.state)
        || prepush.state === "repairing"
        || ["paused", "pausing", "canceled"].includes(task.summary.status)
        || Boolean(task.summary.delivery?.stalled)) {
      return { state: "stopped", message: "当前服务没有运行这轮 Build-Fix" };
    }
    return {
      state: "interrupted",
      message: "上次 Build-Fix 已经中断，当前服务没有对应的执行会话",
    };
  }

  /** 恢复前置条件坏了必须把 preparing 收成明确环境异常。继续保留一个
   * 没有 owner 的“准备中”，页面和运维都会被同一份假活性误导。 */
  private failPendingPrePush(task: TaskState, reason: string): void {
    const prepush = task.summary.delivery?.prepush;
    if (!prepush || ["passed", "user_skipped", "blocked", "environment_error"]
      .includes(prepush.state)) return;
    const message = `Build-Fix 无法恢复：${reason}`;
    this.setPrePushState(task, failPrePushEnvironment(
      prepush, new Date().toISOString(), message));
    task.summary.status = "failed";
    task.summary.detail = message;
    delete task.summary.completed_at;
    this.persist(task);
  }

  /** 启动期对账独立 prepush。旧容器已经由 serve 的 ownership 清扫收口，
   * 这里只重建业务 attempt；绝不尝试把新进程接到旧 driver/container。 */
  private reconcileInterruptedPrePush(
    task: TaskState,
  ): "none" | "scheduled" | "blocked" {
    const delivery = task.summary.delivery;
    const prepush = delivery?.prepush;
    if (!prepush || ["passed", "user_skipped", "blocked", "environment_error"]
      .includes(prepush.state)) return "none";
    if (delivery?.pipeline === "running"
        || (delivery?.pipeline === "success" && delivery.sha)
        || delivery?.evidence_gap) return "none";
    if (["paused", "pausing", "waiting_for_human", "canceled", "await_merge"]
      .includes(task.summary.status) || delivery?.stalled) return "none";

    // active_attempt 是上一进程留下的确凿中断证据；没有 attempt 的
    // preparing 也可能是进程死在恢复过渡窗口，活动交付态同样要接回。
    const canRestartUnownedStage = Boolean(this.options.prepush?.enabled && task.cwd);
    const interrupted = Boolean(prepush.active_attempt)
      || (canRestartUnownedStage && prepush.state === "preparing"
        && ["running", "queued", "verifying", "completed", "failed"]
          .includes(task.summary.status))
      || (canRestartUnownedStage && prepush.state === "repairing"
        && ["running", "queued", "verifying", "completed"]
          .includes(task.summary.status));
    if (!interrupted) return "none";
    if (!this.options.prepush?.enabled) {
      this.failPendingPrePush(task, "当前部署未启用 Build-Fix 能力");
      return "blocked";
    }
    if (!task.cwd || !existsSync(task.cwd)) {
      this.failPendingPrePush(task, "代码现场不存在或尚未挂载");
      return "blocked";
    }
    if (task.prepushRecoveryActive || task.prepushActive) return "scheduled";

    task.prepushRecoveryActive = true;
    task.summary.status = "verifying";
    task.summary.detail = "服务重启，正在恢复未完成的 Build-Fix";
    delete task.summary.completed_at;
    this.persist(task);
    const epoch = task.controlEpoch;
    const work = this.resumePrePushVerification(task, epoch).finally(() => {
      task.prepushRecoveryActive = false;
      this.bypass(task, "Build-Fix 活性投影",
        this.options.projection?.upsertTask(this.project(task)));
    });
    this.bypass(task, "Build-Fix 恢复", work);
    return "scheduled";
  }

  private prePushDomainReport(result: PrePushRunResult): PrePushReport {
    const failed = result.status === "infrastructure_failure"
      ? "infrastructure_failure" as const : "code_failure" as const;
    const map = (check: PrePushAgentReport["compile"]) => ({
      outcome: check.status === "passed"
        ? "passed" as const
        : check.status === "failed"
          ? failed
          : result.status === "infrastructure_failure"
            ? "infrastructure_failure" as const
            : "not_run" as const,
      ...(check.summary ? { message: check.summary } : {}),
    });
    if (result.report) {
      return {
        compile: map(result.report.compile),
        unit_test: map(result.report.unit_test),
      };
    }
    if (result.status === "passed") {
      return {
        compile: { outcome: "passed", message: result.message },
        unit_test: { outcome: "passed", message: result.message },
      };
    }
    return {
      compile: { outcome: failed, message: result.message },
      unit_test: { outcome: "not_run", message: result.message },
    };
  }

  /** 默认执行器：与普通编码会话使用同一模型、工作区和显式 Skill，
   * 但不创建 KernelHost、不挂 hostHooks，也不提供人工问答工具。 */
  private async runCloudPrePushAgent(
    task: TaskState,
    request: PrePushRunRequest,
    epoch: number,
    attemptId: string,
  ): Promise<PrePushRunResult> {
    if (!task.cwd) throw new Error("Build-Fix 缺少代码工作区");
    if (task.driver) throw new Error("已有 Agent 会话在运行，不能启动 Build-Fix");
    // 用户排除过的未跟踪过程件直接登记到 clone 本地 exclude。专项
    // Agent 看不到这些噪声，就不需要靠“别提交”门禁反复纠偏；已跟踪
    // 文件仍由下面的交付契约与宿主收口处理。
    this.registerAgentPlatformLocalExcludes(
      task.cwd,
      request.deliverySelection?.excludedPaths ?? [],
    );
    const isolation = this.options.isolation;
    if (!isolation) {
      throw new Error(
        "Build-Fix 必须在任务容器中执行；当前未配置隔离镜像，"
        + "已拒绝回退宿主机",
      );
    }
    const profile = detectPrePushBuildProfile(task.cwd);
    const executionBudget = resolvePrePushExecutionBudget(profile, {
      attemptTimeoutMs: this.options.prepush?.attemptTimeoutMs,
      buildCommandTimeoutMs: this.options.prepush?.buildCommandTimeoutMs,
    });

    // 正常收口路径会在 tryDeliver 前串行停净普通编码容器；恢复/异常
    // 路径也在这里再兜一次。绝不能让两个容器同时写同一工作区。
    const previousContainer = task.container;
    if (previousContainer) {
      await previousContainer.stop();
      if (task.container === previousContainer) task.container = undefined;
    }
    if (!this.current(task, epoch)) {
      throw new Error("任务已停止，拒绝启动 Build-Fix 容器");
    }

    const agentDir = join(task.summary.workspace, "pi-agent");
    mkdirSync(agentDir, { recursive: true });
    this.hardenAgentGitBoundary(agentDir, task.cwd);
    // build-notes 的目录由宿主预建:安全层只放行那一个文件,mkdir
    // .mae-flow-work 本身会被拦——使命让写、闸不让建目录,Agent 没出路。
    mkdirSync(join(task.cwd, ".mae-flow-work"), { recursive: true });
    const modelOverride = this.options.settings?.models() ?? {};
    writeFileSync(join(agentDir, "models.json"),
      JSON.stringify(modelOverride.json ?? this.options.modelsJson));

    let repositorySkillPaths: string[] = [];
    let repositorySkillResources: Array<KnowledgeResourceRef & {
      actual_path: string;
    }> = [];
    const activeRepository = task.summary.repo_url ?? this.effectiveDefaultRepo();
    if (activeRepository) {
      const materialized = materializeRepositorySkills({
        selected: task.summary.repository_skills,
        bindings: [{ repository: activeRepository, workspace: task.cwd }],
        snapshotRoot: join(task.cwd, ".mae-flow-work", "repository-skills"),
        reservedNames: hostSkillNames(this.options.dataDir),
      });
      this.freezeRepositoryNativeSkills(task, materialized);
      repositorySkillPaths = materialized.paths;
      repositorySkillResources = materialized.entries.map(({ path, skill }) => ({
        id: skill.id,
        kind: "skill" as const,
        name: skill.name,
        path: skill.relative_path,
        repository: skill.repository,
        description: skill.description,
        digest: skill.digest,
        selected: true,
        actual_path: path,
      }));
      for (const warning of materialized.warnings) {
        this.options.log?.(
          `[prepush-skill] 任务 ${task.summary.id}: ${warning}`);
      }
    }

    const runRoot = join(
      task.summary.workspace, "prepush",
      `round-${request.round}-${request.sha.slice(0, 12)}`);
    mkdirSync(runRoot, { recursive: true });
    const eventLog = new EventLog(join(runRoot, "events.jsonl"));
    const transcript = new TranscriptStore(
      join(runRoot, "transcript.jsonl"), "main");
    const instance = taskContainerInstance(this.options.dataDir).namePrefix;
    const attempt = `r${request.round}-${request.sha.slice(0, 12)}`
      .replace(/[^a-zA-Z0-9_.-]/g, "-");
    const mounts = this.taskContainerMounts(task, isolation.volumes ?? []);
    const container = this.createTaskContainer({
      image: isolation.image,
      workspace: task.cwd,
      // 名字按任务稳定：进程死在 attempt 中间，下一次启动/恢复会先
      // ownership 复验并清掉同名残留；round/SHA 只进 label 与收据。
      name: `mfc-${instance}-${task.summary.id}-prepush`,
      log: this.options.log,
      volumes: mounts.volumes,
      limits: {
        memory: isolation.memory,
        cpus: isolation.cpus,
        user: isolation.user,
        pidsLimit: isolation.pidsLimit,
      },
      options: {
        labels: {
          ...(isolation.labels ?? {}),
          "com.mae-flow-cloud.task": task.summary.id,
          "com.mae-flow-cloud.role": "prepush",
          "com.mae-flow-cloud.prepush-round": String(request.round),
          "com.mae-flow-cloud.sha": request.sha,
        },
        readOnlyRoot: isolation.readOnlyRoot,
        tmpfsHome: isolation.tmpfsHome,
        tmpfsTmp: isolation.tmpfsTmp,
        network: isolation.network,
        environment: mounts.environment,
        forwardEnvironment: isolation.forwardEnvironment,
        stopGraceSeconds: isolation.stopGraceSeconds,
        managementTimeoutMs: isolation.managementTimeoutMs,
      },
    });
    task.container = container;
    const abortController = new AbortController();
    task.prepushAbort = abortController;
    let infrastructureFailure = "";
    let resolveInfrastructure!: () => void;
    const infrastructureFailed = new Promise<void>((resolveFailure) => {
      resolveInfrastructure = resolveFailure;
    });
    const failInfrastructure = (detail: string) => {
      if (infrastructureFailure) return;
      infrastructureFailure = detail;
      resolveInfrastructure();
      // 先发布结构化失败再中止容器；waitForTurn 即使同时收到 interrupted，
      // 也会以下面的 infrastructureFailure 事实为准。
      abortController.abort();
    };
    const interrupted = new Promise<Outcome>((resolve) => {
      const finish = () => resolve({
        status: "session_ended",
        reason: "prepush_interrupted",
        detail: "Build-Fix 已由任务控制操作终止",
      });
      if (abortController.signal.aborted) finish();
      else abortController.signal.addEventListener("abort", finish, { once: true });
    });
    const waitForTurn = (turn: Promise<Outcome>) =>
      Promise.race([
        turn,
        interrupted,
        infrastructureFailed.then((): Outcome => ({
          status: "session_ended",
          reason: "prepush_infrastructure_failure",
          detail: infrastructureFailure,
        })),
      ]);
    let driver: CloudSession | undefined;
    const attemptTimeoutMs = executionBudget.attemptTimeoutMs;
    const attemptTimer = setTimeout(() => failInfrastructure(
      `Build-Fix 超过 ${Math.ceil(attemptTimeoutMs / 60_000)} 分钟，已终止本轮`,
    ), attemptTimeoutMs);
    attemptTimer.unref?.();
    const withExecution = (result: PrePushRunResult): PrePushRunResult => {
      const metadata = container.metadata;
      if (!metadata) return result;
      const execution: PrePushExecutionAttestation = {
        schema: PRE_PUSH_EXECUTION_SCHEMA,
        attempt_id: attemptId,
        sha: result.sha,
        container_id: metadata.containerId,
        image_reference: metadata.imageReference,
        image_id: metadata.imageId,
        image_digest: metadata.imageDigest,
        network: metadata.network,
        read_only_root: metadata.readOnlyRoot,
        pids_limit: metadata.pidsLimit,
        ...(metadata.memoryBytes !== undefined
          ? { memory_bytes: metadata.memoryBytes } : {}),
        ...(metadata.nanoCpus !== undefined
          ? { nano_cpus: metadata.nanoCpus } : {}),
        ...(metadata.user ? { user: metadata.user } : {}),
        ...(metadata.startedAt ? { started_at: metadata.startedAt } : {}),
        mount_destinations: metadata.mounts.map((mount) => mount.destination),
      };
      return { ...result, execution };
    };
    try {
      await container.start();
      if (!this.current(task, epoch)) {
        throw new Error("任务已停止，Build-Fix 容器不再执行命令");
      }
      // 先验证确定性的本地环境事实，再花模型额度。settings、Maven 实际
      // JDK、JVM cacerts、缓存或 C++ 拓扑不对时直接给出基础设施结论，
      // 不让 Agent curl 盲探几分钟后才猜到部署缺项。
      const preflightCommand = prePushEnvironmentCommand({
        profile,
        requireMavenSettings: hasContainerVolumeDestination(
          mounts.volumes,
          "/etc/mae-flow/maven/settings.xml",
        ),
      });
      let preflightOutput = "";
      const preflightRun = await container.exec(preflightCommand, task.cwd, {
        timeout: 45,
        signal: abortController.signal,
        onData: (chunk) => {
          preflightOutput = `${preflightOutput}${chunk.toString()}`.slice(-64 * 1024);
        },
      });
      const preflight = inspectPrePushEnvironment(
        preflightRun.exitCode,
        preflightOutput,
      );
      if (!preflight.ready) {
        this.options.log?.(
          `[prepush-environment] 任务 ${task.summary.id}: ${preflight.detail}`,
        );
        return withExecution({
          status: "infrastructure_failure",
          sha: (await this.prePushRevision(task)).sha,
          message: preflight.detail,
        });
      }
      driver = await CloudSession.create({
        taskId: `${task.summary.id}:prepush:${request.round}`,
        workspace: task.cwd,
        agentDir,
        hostSkillsDir: taskHostSkillsDir(this.options.dataDir, task.summary),
        knowledgeContext: task.summary.host_skills_pinned ? undefined : {
          repositories: task.summary.repositories ?? [],
          technologies: [...new Set((task.summary.repository_profiles ?? [])
            .flatMap((profile) => profile.technologies))],
          businessModuleIds: (task.summary.business_modules ?? [])
            .map((module) => module.id),
        },
        repositorySkillPaths,
        repositorySkillResources,
        knowledgeTrace: this.knowledgeTrace(task, task.cwd),
        provider: task.summary.model_choice?.provider
          ?? modelOverride.provider ?? this.options.provider,
        model: task.summary.model_choice?.model
          ?? modelOverride.model ?? this.options.model,
        eventLog,
        transcript,
        gate: new GateService({
          contract: createPrePushGateContract(this.options.contract),
          workspace: task.cwd,
          cwd: task.cwd,
          log: this.options.log,
          failClosed: Boolean(this.options.host),
        }),
        humanGate: task.humanGate,
        allowHumanQuestions: false,
        streamBashOutput: true,
        sessionId: `prepush-${request.round}`,
        currentStep: () => this.currentStepLabel(task),
        compactAnchor: () => `Build-Fix 任务: ${requirementContext(
          task.summary.requirement,
          task.summary.requirement_document,
          AGENT_REQUIREMENT_DOCUMENT,
        )}`,
        onTokenUsage: (sample) => this.recordTaskTokenUsage(task, sample),
        bashOperations: {
          exec: async (command, dir, execOptions) => {
            try {
              const timeout = prePushCommandTimeoutSeconds(
                command,
                execOptions.timeout,
                executionBudget,
              );
              return await container.exec(command, dir, {
                ...execOptions,
                timeout,
              });
            } catch (error) {
              if (error instanceof TaskContainerExecTimeoutError) {
                failInfrastructure(
                  `Build-Fix 命令运行 ${Math.ceil(error.timeoutSeconds / 60)} 分钟`
                    + "仍未完成，已安全停止本轮；这是验证预算耗尽，不代表代码编译失败",
                );
              } else if (error instanceof TaskContainerUnavailableError) {
                failInfrastructure(
                  `Build-Fix 容器不可用（${error.kind}）：${error.message}`,
                );
              }
              throw error;
            }
          },
        },
        afterFileMutation: (path) => {
          repairContainerMutationOwnership({
            workspace: task.cwd!,
            path,
            user: isolation.user,
          });
        },
        log: this.options.log,
      });
      if (!this.current(task, epoch) || abortController.signal.aborted) {
        driver.dispose();
        throw new Error("任务已停止，Build-Fix Agent 不再启动");
      }
      task.driver = driver;
      let outcome = await waitForTurn(driver.start(prePushMission(
        request,
        executionBudget,
      )));
      for (let correction = 0; correction < 3; correction += 1) {
        if (infrastructureFailure) {
          await driver.abort().catch((error) => this.options.log?.(
            `任务 ${task.summary.id} prepush 基础设施熔断后会话中止失败: ${String(error)}`,
          ));
          return withExecution({
            status: "infrastructure_failure",
            sha: (await this.prePushRevision(task)).sha,
            message: infrastructureFailure,
          });
        }
        if (outcome.status === "session_ended") {
          return withExecution({
            status: "infrastructure_failure",
            sha: (await this.prePushRevision(task)).sha,
            message: outcome.detail ?? outcome.reason ?? "Build-Fix 会话异常结束",
          });
        }
        const report = parsePrePushAgentReport(driver.finalReply());
        if (report && report.status !== "passed") {
          return withExecution({
            status: report.status,
            sha: (await this.prePushRevision(task)).sha,
            message: report.summary,
            report,
          });
        }
        const evidence = report
          ? verifyPrePushEvidence(eventLog.replay(), report)
          : "收口缺少合法的 <prepush-result> 结构";
        const finalSha = (await this.prePushRevision(task)).sha;
        if (report && !evidence) {
          // 未提交文件只提示不拦截(用户拍板"不能卡死"):push 只传
          // HEAD,它们进不了交付;但把清单如实写进收据——产物该
          // .gitignore 的提出来让用户加规则(留着别删,增量编译要用),
          // 万一里面混着漏提交的业务改动,人在推送确认时能看见。
          const leftover = await this.prePushDirtyPaths(task);
          const leftoverNote = leftover.length
            ? `。工作区尚有未提交/未跟踪文件(${describeDirtyPaths(leftover)}`
              + ")——push 只传 HEAD,它们不进交付,也不影响通过。构建产物"
              + "请保留勿删;想让它们以后不再列出,让 Agent 把路径补进仓库 "
              + ".gitignore 随单交付即可(普通代码改动,MR 检视可见)。"
              + "若其中有本单业务改动,请在推送确认时核对是否遗漏。"
            : "";
          return withExecution({
            status: "passed",
            sha: finalSha,
            message: report.summary + leftoverNote,
            report,
          });
        }
        if (correction === 2) {
          return withExecution({
            status: "code_failure",
            sha: (await this.prePushRevision(task)).sha,
            message: evidence,
          });
        }
        outcome = await waitForTurn(driver.continueWith([
          "Build-Fix 尚不能签发 PASS，请在当前专项会话继续处理。",
          evidence,
          "不要只重写结论；两项命令必须在最后一次代码修改后真实成功。",
        ].filter(Boolean).join("\n")));
      }
      throw new Error("Build-Fix 会话超过收口预算");
    } finally {
      clearTimeout(attemptTimer);
      if (driver && task.driver === driver) task.driver = undefined;
      if (task.prepushAbort === abortController) task.prepushAbort = undefined;
      driver?.dispose();
      if (task.container === container) task.container = undefined;
      // 这是业务执行面的硬边界：无论模型成功、失败、暂停还是异常，
      // 都等容器真正退出后才允许宿主进入 push。
      await container.stop();
    }
  }

  private async performPrePush(
    task: TaskState,
    branch: string,
    baseline: string,
    epoch: number,
  ): Promise<boolean> {
    const at = new Date().toISOString();
    const initialRevision = await this.prePushRevision(task);
    let state = restorePrePushVerification(
      task.summary.delivery?.prepush, initialRevision, at);
    this.setPrePushState(task, state);
    if (getReusablePushReceipt(state, initialRevision)) {
      this.persist(task);
      return true;
    }
    if (["blocked", "environment_error"].includes(state.state)) {
      state = retryPrePushVerification(
        state, at, "重新执行 Build-Fix");
    }
    state = beginPrePushAttempt(state, at);
    const attemptId = state.active_attempt?.id;
    if (!attemptId) {
      throw new Error(`Build-Fix 无法启动，当前状态: ${state.state}`);
    }
    this.setPrePushState(task, state);
    const previousStatus = task.summary.status;
    task.summary.status = "running";
    task.summary.detail = state.message;
    this.persist(task);

    const deliverySnapshot = await deliveryChangeSnapshot(task.cwd!);
    const changeScope = buildFixScopeReview(
      deliverySnapshot?.committed_paths ?? []);
    const request: PrePushRunRequest = {
      taskId: task.summary.id,
      workspace: task.cwd!,
      sha: initialRevision.sha,
      round: state.round,
      requirement: requirementContext(
        task.summary.requirement,
        task.summary.requirement_document,
        AGENT_REQUIREMENT_DOCUMENT,
      ),
      branch,
      baseline,
      ...(changeScope ? { changeScope } : {}),
      ...(task.summary.delivery_selection ? {
        deliverySelection: {
          paths: [...task.summary.delivery_selection.paths],
          excludedPaths: [...task.summary.delivery_selection.excluded_paths],
        },
      } : {}),
    };
    let result: PrePushRunResult;
    const releaseBuildSlot = await this.acquirePrePushBuildSlot(task, epoch);
    if (!releaseBuildSlot || !this.current(task, epoch)) {
      releaseBuildSlot?.();
      return false;
    }
    try {
      result = await (this.options.prepush?.runner
        ?? ((input) => this.runCloudPrePushAgent(
          task, input, epoch, attemptId)))(request);
    } catch (error) {
      result = {
        status: "infrastructure_failure",
        sha: (await this.prePushRevision(task)).sha,
        message: `Build-Fix 执行失败: ${String(error)}`,
      };
    } finally {
      releaseBuildSlot();
    }
    if (!this.current(task, epoch)) return false;

    const finalRevision = await this.prePushRevision(task);
    if (state.sha !== finalRevision.sha
        || state.workspace_fingerprint !== finalRevision.workspace_fingerprint) {
      state = observePrePushRevision(
        state, finalRevision, new Date().toISOString());
      state = beginPrePushAttempt(
        state, new Date().toISOString(), attemptId);
    }
    if (result.sha !== finalRevision.sha) {
      result = {
        status: "infrastructure_failure",
        sha: finalRevision.sha,
        message: `验证结果绑定 ${result.sha.slice(0, 12)}，但当前 HEAD 是 `
          + `${finalRevision.sha.slice(0, 12)}，拒绝复用陈旧结论`,
      };
    }
    state = recordPrePushReport(
      state, attemptId, this.prePushDomainReport(result),
      new Date().toISOString());
    if (state.state === "passed" && result.execution) {
      state = attestPrePushExecution(state, result.execution);
    }
    this.setPrePushState(task, state);
    const passed = Boolean(getReusablePushReceipt(state, finalRevision));
    if (passed) {
      task.summary.status = previousStatus;
      task.summary.detail = "Build-Fix 已通过，等待最终人工检视";
      if (task.summary.delivery) delete task.summary.delivery.skipped;
    } else {
      task.summary.status = "failed";
      task.summary.detail = `Build-Fix 未通过：${state.message}`;
      task.summary.delivery = {
        ...task.summary.delivery,
        skipped: task.summary.detail,
      };
    }
    this.persist(task);
    if (task.pauseRequested && this.current(task, epoch)) {
      await this.finishPause(task, previousStatus);
      return false;
    }
    return passed;
  }

  private async preparePush(
    task: TaskState,
    branch: string,
    baseline: string,
    epoch: number,
  ): Promise<boolean> {
    if (!this.options.prepush?.enabled) return true;
    if (task.prepushActive) return task.prepushActive;
    // 用户显式拍板跳过本地验证:绑 HEAD 放行,交由权威流水线裁决。
    // HEAD 变了(修复/新提交)跳过即失效,重新走真验证——旧拍板不
    // 背书新代码,与收据同一条纪律。
    const skipped = task.summary.delivery?.prepush;
    if (skipped?.state === "user_skipped") {
      const revision = await this.prePushRevision(task);
      if (sameRevision(skipped, revision)) {
        this.options.log?.(
          `任务 ${task.summary.id} 按用户决定跳过 Build-Fix`
          + `(HEAD ${revision.sha.slice(0, 12)}),交由流水线裁决`);
        return true;
      }
    }
    const running = this.performPrePush(task, branch, baseline, epoch);
    task.prepushActive = running;
    try {
      return await running;
    } finally {
      if (task.prepushActive === running) task.prepushActive = undefined;
    }
  }

  /** push 前人工确认不区分“第一次/后续”：每个待推送 HEAD 都先完成
   * Build-Fix，再拿最终代码给人检视。人工意见还要先由提出人逐条裁决；
   * 任务责任人只在逐条闭环后签本次 HEAD。完全相同 HEAD 的网络重试
   * 幂等复用，HEAD 变化则旧收据立即失效。 */
  private concisePushReviewNote(task: TaskState): string | undefined {
    const text = String(task.lastReply ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/^```[a-z0-9_-]*\s*$/gim, "")
      .replace(/<\/?[a-z][^>]*>/gi, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text) return undefined;
    // 默认态已经折成一行；展开后保留 Agent 原本的段落/清单结构，
    // 不能再把整段 Markdown 压成一条 360 字的“电报”。
    return text.length > 720 ? `${text.slice(0, 717).trimEnd()}…` : text;
  }

  private async buildPushReviewPresentation(
    task: TaskState,
    snapshot: NonNullable<Awaited<ReturnType<typeof deliveryChangeSnapshot>>>,
    recheckRequired: boolean,
  ): Promise<PushReviewPresentation> {
    const delivery = task.summary.delivery;
    const selection = task.summary.delivery_selection;
    const hasPriorReview = Boolean(selection?.head
      && selection.head !== snapshot.head);
    const kind: PushReviewPresentation["kind"] = recheckRequired
      ? "feedback"
      : delivery?.loop?.kind === "ci" ? "pipeline"
      : delivery?.loop?.kind === "conflict" ? "conflict"
      : hasPriorReview ? "rework"
      : "delivery";
    const copy = {
      delivery: {
        title: "完整交付内容",
        description: "这是当前待推送的全部代码，确认后会直接推送并创建或更新 MR。",
      },
      feedback: {
        title: "按检视意见修改",
        description: "Agent 已处理这批检视意见，建议先核对这次处理，再决定是否通过。",
      },
      pipeline: {
        title: "流水线修复内容",
        description: "流水线修复产生了新提交，建议先核对这次修复，再决定是否通过。",
      },
      conflict: {
        title: "冲突处理内容",
        description: "Agent 已处理分支冲突，建议先核对冲突处理结果，再决定是否通过。",
      },
      rework: {
        title: "按上次检视调整",
        description: "Agent 已按你上次的交付范围和说明调整，建议先核对调整结果。",
      },
    } satisfies Record<PushReviewPresentation["kind"], {
      title: string; description: string;
    }>;

    // 基点优先级:最近一次人真正看过的 HEAD > 上次通过确认的 HEAD >
    // 上次推送。selection.head 返工多轮不更新,单靠它复检卡会退化成
    // 只有"完整交付"(MFC-035)。
    const preferred = [
      delivery?.last_reviewed_head,
      selection?.head,
      delivery?.git_push?.sha,
    ].filter((sha): sha is string => Boolean(sha)
        && sha !== snapshot.head && sha !== snapshot.baseline);
    let focused: DeliveryRevisionComparison | undefined;
    for (const base of [...new Set(preferred)]) {
      focused = await compareDeliveryRevisions(task.cwd!, base, snapshot.head);
      if (focused) break;
    }
    const comparison = focused ?? await compareDeliveryRevisions(
      task.cwd!, snapshot.baseline!, snapshot.head);
    const base = focused?.from ?? snapshot.baseline!;
    const prepush = delivery?.prepush;
    const verification = prepush?.state === "passed"
      ? "Build-Fix 已通过"
      : prepush?.state === "user_skipped"
        ? "本轮已按决定跳过 Build-Fix"
        : undefined;
    const agentNote = this.concisePushReviewNote(task);
    return {
      kind,
      ...copy[kind],
      base_sha: base,
      baseline_sha: snapshot.baseline!,
      head_sha: snapshot.head,
      has_focused_changes: base !== snapshot.baseline,
      file_count: comparison?.paths.length ?? snapshot.committed_paths.length,
      additions: comparison?.additions ?? 0,
      deletions: comparison?.deletions ?? 0,
      // 连基线比较都不可得(祖先关系断/提交不可见)时不许装作 +0/−0:
      // MFC-036 门禁通常会在这之前拦下,这里是最后的诚实兜底。
      ...(comparison ? {} : { stats_unavailable_reason:
        "提交历史与任务基线不再连续,无法计算逐行统计;"
        + "请先处理基线偏离,再核对完整交付视图" }),
      commits: comparison?.commits ?? [],
      all_paths: normalizedDeliveryPaths(snapshot.workspace_paths),
      committed_paths: normalizedDeliveryPaths(snapshot.committed_paths),
      ...(agentNote ? { agent_note: agentNote } : {}),
      ...(verification ? { verification } : {}),
    };
  }

  private async pushConfirmationSatisfied(
    task: TaskState,
    branch: string,
  ): Promise<boolean> {
    const loop = task.summary.delivery?.loop;
    const recheckRequired = loop?.review_source === "workspace"
      && loop.workspace_review_recheck_required === true;
    const required = recheckRequired || (task.summary.push_confirmation
      ?? this.options.pushConfirmation?.(task.summary.luban_account)
      ?? Boolean(task.summary.delivery_selection));
    if (!required || !task.cwd) return true;
    const snapshot = await deliveryChangeSnapshot(task.cwd);
    if (!snapshot?.baseline) {
      this.markVerificationStalled(task,
        "开启了 push 前人工确认,但任务基线不可读,无法生成交付清单");
      return false;
    }
    const committed = normalizedDeliveryPaths(snapshot.committed_paths);
    const selection = task.summary.delivery_selection;
    if (!recheckRequired && pushReviewReceiptCovers(selection && {
      status: selection.status,
      head: selection.head,
      paths: normalizedDeliveryPaths(selection.paths),
    }, { head: snapshot.head, paths: committed })) {
      return true;
    }
    const cycleToken = selection?.status === "requested"
      ? selection.waiting_id
      : recheckRequired ? loop?.review_ids : undefined;
    const callId = pushReviewCallId({
      head: snapshot.head,
      paths: committed,
    }, cycleToken);
    const waiting = task.summary.waiting;
    if (waiting?.step === CLOUD_PUSH_CONFIRM_STEP) {
      if (waiting.call_id === callId) return false; // 同一集合的卡已在等人
      task.humanGate.supersede(waiting.waiting_id, {
        stateVersion: waiting.state_version,
        notes: "交付文件集合已变化,旧确认卡作废,按最新范围重新确认",
      });
    }
    // 重复确认时把文件范围变化说成人话。例如只补了一个 .gitignore，
    // 人看一行就能拍板，不用整单重看；“增量 diff”这类实现词不露出。
    const previous = selection?.status === "confirmed"
      ? normalizedDeliveryPaths(selection.paths) : undefined;
    const addedPaths = previous
      ? committed.filter((path) => !previous.includes(path)) : [];
    const removedPaths = previous
      ? previous.filter((path) => !committed.includes(path)) : [];
    const deltaLines = previous && (addedPaths.length || removedPaths.length)
      ? [
        `**文件范围变化：${[
          addedPaths.length ? `新增 ${describeDirtyPaths(addedPaths)}` : "",
          removedPaths.length ? `移除 ${describeDirtyPaths(removedPaths)}` : "",
        ].filter(Boolean).join(";")};其余 ${
          committed.filter((path) => previous.includes(path)).length
        } 个文件与上次确认一致,可只检视变化部分。**`,
      ] : [];
    const extras = snapshot.workspace_paths
      .filter((path) => !committed.includes(path));
    // 只在 Build-Fix 收敛后举卡。卡同时固化最终 HEAD 与文件集合：
    // 后续任何修复都会产生新 HEAD，因此一律重新检视；同一 HEAD 的
    // 传输重试才幂等复用，不按“第一次/后续”另开两套规则。
    const reviewAnnotationIds = new Set(
      loop?.workspace_review_annotation_ids ?? []);
    const reviewItems = recheckRequired
      ? this.annotations(task).list().filter((item) =>
          reviewAnnotationIds.has(item.id))
      : [];
    const pendingReviewItems = reviewItems.filter((item) =>
      item.status === "draft" || item.status === "sent");
    const pushReview = await this.buildPushReviewPresentation(
      task, snapshot, recheckRequired);
    task.summary.delivery = {
      ...task.summary.delivery,
      push_review: pushReview,
    };
    const reviewContext = recheckRequired ? [
      "**这是人工意见修改后的复检，不是按 push 次数重复询问。**",
      reviewItems.length
        ? `本轮关联 ${reviewItems.length} 条检视意见，目前还有 ${pendingReviewItems.length} 条待提出人确认。`
        : "本轮是整体检视意见返工，请在最终代码上确认修改结果。",
      ...(pendingReviewItems.length ? [
        "意见提出人请逐条点“确认已修复”或“仍需调整”；任务责任人的“确认推送”不能代替提出人签字。",
      ] : ["逐条意见已经闭环，任务责任人可确认本次最终代码并推送。"]),
    ] : [];
    const context = [
      "**最终代码检视：Build-Fix 已收敛。确认后将直接推送并创建或更新 MR。**",
      `**${pushReview.title}：${pushReview.file_count} 个文件，+${pushReview.additions} / -${pushReview.deletions}。**`,
      ...reviewContext,
      ...deltaLines,
      // 名字必须与界面一字不差:页签叫「交付材料」、按钮叫「工作区
      // 变更」。此前写「检视材料 → 本任务变更」,界面上根本没有这两个
      // 词,新人在唯一的人审闸口满屏找不到入口(2026-08-30 审计)。
      "完整代码变化在「交付材料 → 工作区变更」逐文件查看;发现问题可在"
      + "代码行上留批注,选「需要调整代码」让 Agent 修改。",
      "文件树左侧勾选框决定交付范围:取消勾选=该文件不推送。确认后,"
      + "若 Agent 继续修改并生成新 HEAD,系统会在 Build-Fix 通过后展示"
      + "新一轮检视;完全相同的 HEAD 重试不会重复打扰。",
      "",
      `即将向分支 ${branch} 推送以下 ${committed.length} 个文件`
      + `(自基线 ${snapshot.baseline.slice(0, 12)} 起;内容以检视材料实时为准):`,
      ...committed.slice(0, 20).map((path) => `- ${path}`),
      ...(committed.length > 20
        ? [`- …其余 ${committed.length - 20} 个文件请在完整交付内容中查看`] : []),
      ...(extras.length ? [
        `另有 ${extras.length} 个工作区文件不在本次提交中(未跟踪/未暂存),`
        + "不会被推送。"] : []),
    ].join("\n");
    task.summary.waiting = task.humanGate.createWaiting({
      taskId: task.summary.id,
      step: CLOUD_PUSH_CONFIRM_STEP,
      callId,
      questionInput: { questions: [{
        question: `交付范围确认:请检视当前待推送代码(${committed.length} 个文件 → ${branch}),是否通过并按清单推送?`,
        options: [PUSH_CONFIRM_ACCEPT, PUSH_CONFIRM_REWORK],
      }] },
      context,
    });
    task.summary.status = "waiting_for_human";
    task.summary.detail = recheckRequired
      ? pendingReviewItems.length
        ? `等待 ${pendingReviewItems.length} 条检视意见由提出人确认`
        : "检视意见已闭环，等待责任人确认推送"
      : "等待确认最终交付范围";
    this.persist(task);
    if (recheckRequired) {
      this.notifyWorkspaceReviewReady(task, snapshot.head);
    } else {
      this.notifyWaiting(task);
    }
    this.options.log?.(
      `任务 ${task.summary.id} push 前确认卡已生成(HEAD ${snapshot.head.slice(0, 12)})`);
    return false;
  }

  private async deliverySelectionAllowsPush(
    task: TaskState,
    branch: string,
  ): Promise<boolean> {
    const selection = task.summary.delivery_selection;
    if (!selection) return true;
    let reason = "";
    if (selection.status !== "confirmed") {
      reason = "交付文件清单仍在等待 Agent 整理并重新确认";
    } else if (!task.cwd) {
      reason = "代码现场不可用，无法复核交付文件清单";
    } else {
      const snapshot = await deliveryChangeSnapshot(task.cwd);
      if (!snapshot?.baseline) {
        reason = "任务基线不可读，无法复核交付文件清单";
      } else {
        const current = normalizedDeliveryPaths(snapshot.committed_paths);
        const expected = normalizedDeliveryPaths(selection.paths);
        if (!samePaths(current, expected)) {
          const unexpected = current.filter((path) => !expected.includes(path));
          const missing = expected.filter((path) => !current.includes(path));
          reason = [
            unexpected.length
              ? `新增了未确认文件 ${describeDirtyPaths(unexpected)}` : "",
            missing.length
              ? `已确认文件不再提交 ${describeDirtyPaths(missing)}` : "",
          ].filter(Boolean).join("；") || "提交文件集合已经变化";
        }
      }
    }
    if (!reason) return true;
    const detail = `最终确认后现场又发生变化：${reason}。旧确认已自动作废，`
      + "正在按最新 HEAD 重新生成检视卡；不用重跑任务。";
    task.summary.status = "verifying";
    task.summary.detail = detail;
    if (task.summary.delivery) delete task.summary.delivery.skipped;
    this.persist(task);
    this.options.log?.(`任务 ${task.summary.id} ${detail}`);
    await this.pushConfirmationSatisfied(task, branch);
    return false;
  }

  /** MFC-036:交付历史必须生长在任务定格基线之上。Agent 整理清单时
   * reset/rebase 到基线父提交后,最终树可以看似正确,但祖先关系已断,
   * MR 永远无法快进合入,下游"这次修改"diff/统计也全部失真。这里在
   * Build-Fix 之前机械把净改动重放回定格基线(commit-tree 以旧 HEAD 的
   * 树为内容、定格基线为父,重放前后树逐字节一致),而不是等远端 409。
   * repair=false 用于推送前的最终复核:那时再脱离只如实停下,不改写。 */
  private async reconcileFrozenBaselineAncestry(
    task: TaskState,
    repair: boolean,
  ): Promise<"ok" | "repaired" | "blocked"> {
    if (!task.cwd) return "ok";
    const cwd = task.cwd;
    const frozen = await frozenTaskBaseline(cwd);
    // 旧现场没记录定格基线时无法裁决;不猜、不拿自愈回退假装校验过。
    if (!frozen) return "ok";
    const stall = (detail: string): "blocked" => {
      this.markVerificationStalled(task, detail);
      return "blocked";
    };
    const git = (args: string[]) => runSafeWorktreeGitAsync(cwd, args, {
      timeoutMs: 60_000,
      configs: [
        ["user.name", "mae-flow-cloud"],
        ["user.email", "cloud@mae-flow.local"],
      ],
    });
    const exists = await git(["cat-file", "-e", `${frozen}^{commit}`]);
    if (exists.status !== 0) {
      return stall(`任务定格基线 ${frozen.slice(0, 7)} 在当前仓库已不可见,`
        + "无法核对交付历史是否仍生长在基线之上;请人工确认现场。");
    }
    const headResult = await git(["rev-parse", "--verify", "HEAD"]);
    const head = String(headResult.stdout ?? "").trim();
    if (headResult.status !== 0 || !head) {
      return stall("读取当前 HEAD 失败,无法核对定格基线祖先关系。");
    }
    const ancestor = await git(["merge-base", "--is-ancestor", frozen, head]);
    if (ancestor.status === 0) return "ok";
    if (!repair) {
      return stall(`推送前复核发现提交历史脱离任务定格基线 ${
        frozen.slice(0, 7)}(疑似验证期间又被改写);已停止推送,请人工确认。`);
    }
    // 只在 Agent 已用 commit 收口时重放;未提交的改动不能被宿主猜着处理。
    const unstaged = await git(["diff", "--quiet"]);
    const staged = await git(["diff", "--cached", "--quiet"]);
    if (unstaged.status !== 0 || staged.status !== 0) {
      return stall(`提交历史已脱离任务定格基线 ${frozen.slice(0, 7)},同时`
        + "工作区还有未提交改动;平台不猜着整理,请在代码检视中确认处理。");
    }
    const replay = await git(["commit-tree", `${head}^{tree}`, "-p", frozen,
      "-m", "chore: 按任务定格基线重放净改动——历史重排已被平台整理"]);
    const replayed = String(replay.stdout ?? "").trim();
    if (replay.status !== 0 || !replayed) {
      return stall(`按定格基线重放净改动失败:${String(
        replay.stderr || replay.error || "").trim().slice(0, 200)}`);
    }
    const moved = await git(["reset", "--soft", replayed]);
    if (moved.status !== 0) {
      return stall(`按定格基线重放后切换 HEAD 失败:${String(
        moved.stderr || moved.error || "").trim().slice(0, 200)}`);
    }
    // 重放合同:树逐字节一致 + 基线恢复为祖先。任一不成立都回到原 HEAD
    // 如实停下,绝不带着可疑历史继续交付。
    const sameTree = await git(["diff", "--quiet", head, "HEAD"]);
    const nowAncestor = await git(["merge-base", "--is-ancestor",
      frozen, "HEAD"]);
    if (sameTree.status !== 0 || nowAncestor.status !== 0) {
      await git(["reset", "--soft", head]);
      return stall("按定格基线重放后复核未通过(树不一致或祖先关系仍断);"
        + "已回到原 HEAD 停下,请人工确认。");
    }
    this.options.log?.(`任务 ${task.summary.id} 提交历史曾脱离定格基线 ${
      frozen.slice(0, 7)},已机械重放净改动(${head.slice(0, 7)} → ${
      replayed.slice(0, 7)}),树内容未变。`);
    return "repaired";
  }

  /** 流水线/prepush 修复不得把用户已经排除的文件“顺手带回来”。这不再
   * 交给 Agent 撞一道新门禁：若变化只涉及已明确排除的路径（或中心注入
   * 目录），宿主以最近一次已推送的干净 SHA 为锚，把修复中的已确认文件
   * 机械重组为一个提交。被排除内容仍留在工作区，但污染提交从可达历史中
   * 消失；真正新增的业务文件不在这里猜，由首次范围确认或用户明确提交
   * 的 MR 检视授权决定。 */
  private async reconcileConfirmedDeliveryBoundary(
    task: TaskState,
  ): Promise<"unchanged" | "changed" | "blocked"> {
    const selection = task.summary.delivery_selection;
    if (selection?.status !== "confirmed" || !task.cwd) return "unchanged";
    const cwd = task.cwd;
    const snapshot = await deliveryChangeSnapshot(cwd);
    if (!snapshot?.baseline) return "unchanged";
    const current = normalizedDeliveryPaths(snapshot.committed_paths);
    const expected = normalizedDeliveryPaths(selection.paths);
    const rejected = new Set(normalizedDeliveryPaths(selection.excluded_paths));
    const unexpected = current.filter((path) => !expected.includes(path));
    const platformHistory = normalizedDeliveryPaths(
      snapshot.added_agent_platform_paths ?? []);
    const knownRejected = unexpected.filter((path) => rejected.has(path)
      || isAgentPlatformPath(path));
    if (!platformHistory.length && !knownRejected.length) return "unchanged";
    // 已排除内容与真正的新业务文件同时出现时，也只机械剔除前者、保留
    // 后者。旧实现要求“所有新增都属于已排除项”才清理，结果一条正常
    // 新测试文件会让 .claude/.cac 等污染跟着回到确认门禁，修复 Agent
    // 反复撞墙。目标集合只由事实分类，不猜新业务文件该不该留。
    const targetPaths = current.filter((path) => !isAgentPlatformPath(path)
      && !rejected.has(path));

    const run = async (args: string[], action: string) => {
      const result = await runSafeWorktreeGitAsync(cwd, args, {
        timeoutMs: 60_000,
        configs: [
          ["user.name", "mae-flow-cloud"],
          ["user.email", "cloud@mae-flow.local"],
        ],
      });
      if (result.status !== 0) {
        throw new Error(`${action}失败：${String(
          result.stderr || result.error || "").trim().slice(0, 300)}`);
      }
      return String(result.stdout ?? "").trim();
    };
    const head = await run(["rev-parse", "--verify", "HEAD"], "读取当前 HEAD");
    const candidates = [
      task.summary.delivery?.git_push?.sha,
      selection.head,
      // 历史刚被按定格基线重放过时,旧 push/selection SHA 都不再是
      // HEAD 祖先;定格基线本身永远是合法的收口锚,兜在最后。
      await frozenTaskBaseline(cwd),
    ].map((value) => String(value ?? "").trim()).filter(Boolean);
    let anchor = "";
    for (const candidate of candidates) {
      const ancestor = await runSafeWorktreeGitAsync(cwd,
        ["merge-base", "--is-ancestor", candidate, head], { timeoutMs: 30_000 });
      if (ancestor.status === 0 && candidate !== head) {
        anchor = candidate;
        break;
      }
    }
    if (!anchor) {
      const detail = "检测到修复重新带入了已排除文件，但找不到最近一次已推送的"
        + "干净提交作为自动整理锚点。未改写历史，请在代码检视中确认处理。";
      task.summary.status = "failed";
      task.summary.detail = detail;
      task.summary.delivery = { ...task.summary.delivery, skipped: detail };
      this.persist(task);
      return "blocked";
    }

    // 只在 Agent 已经用 commit 收口时机械重组。未提交的业务改动不能被
    // 宿主猜着一起提交；这种模糊现场停下给明确提示即可。
    const unstaged = await runSafeWorktreeGitAsync(cwd,
      ["diff", "--quiet"], { timeoutMs: 30_000 });
    const staged = await runSafeWorktreeGitAsync(cwd,
      ["diff", "--cached", "--quiet"], { timeoutMs: 30_000 });
    if (unstaged.status !== 0 || staged.status !== 0) {
      const detail = "检测到修复重新带入了已排除文件，同时还有未提交的业务"
        + "改动；平台不会猜着整理或循环撞门禁。请在代码检视中确认处理。";
      task.summary.status = "failed";
      task.summary.detail = detail;
      task.summary.delivery = { ...task.summary.delivery, skipped: detail };
      this.persist(task);
      return "blocked";
    }

    // 平台目录即便先提交后删除，blob 仍在历史里。以干净锚重组而不是补
    // 一个“删除提交”，才能保证远端不可达。已确认范围之外若出现真正的
    // 新业务文件保留在 targetPaths；后面由 review 授权继承或首次确认卡
    // 决定。这里始终只移除用户已排除项与平台目录。
    const stagePaths = [...new Set([
      ...targetPaths,
      ...expected,
    ].filter((path) => !isAgentPlatformPath(path)
      && !rejected.has(path)))].sort((left, right) => left.localeCompare(right));
    try {
      await run(["reset", "--mixed", anchor], "回到最近干净提交");
      if (stagePaths.length) {
        await run(["add", "-A", "--", ...stagePaths], "重组已确认文件");
      }
      const hasStaged = await runSafeWorktreeGitAsync(cwd,
        ["diff", "--cached", "--quiet"], { timeoutMs: 30_000 });
      if (hasStaged.status !== 0) {
        await run([
          "commit", "-m",
          "chore: 按已确认推送范围收口流水线修复",
        ], "提交整理后的修复");
      }
    } catch (error) {
      // reset --mixed 不会破坏工作区内容；尽力把分支引用与索引恢复到
      // 原 HEAD，失败时仍以明确诊断停下，绝不自动重试成循环。
      await runSafeWorktreeGitAsync(cwd,
        ["reset", "--mixed", head], { timeoutMs: 30_000 });
      const detail = `按已确认范围自动整理失败：${String(error)}`;
      task.summary.status = "failed";
      task.summary.detail = detail;
      task.summary.delivery = { ...task.summary.delivery, skipped: detail };
      this.persist(task);
      return "blocked";
    }

    this.registerAgentPlatformLocalExcludes(cwd, selection.excluded_paths);
    const after = await deliveryChangeSnapshot(cwd);
    if (!after || after.added_agent_platform_paths.length
        || !samePaths(
          normalizedDeliveryPaths(after.committed_paths), targetPaths)) {
      const detail = "按已确认范围自动整理后复核未通过；平台已停止继续推送，"
        + "请在代码检视中确认，不会让 Agent 循环尝试。";
      task.summary.status = "failed";
      task.summary.detail = detail;
      task.summary.delivery = { ...task.summary.delivery, skipped: detail };
      this.persist(task);
      return "blocked";
    }
    this.options.log?.(
      `任务 ${task.summary.id} 已自动移除修复重新带入的排除内容：${
        describeDirtyPaths([...new Set([...unexpected, ...platformHistory])])}`);
    return "changed";
  }

  /** 用户在 MR 工作台点“提交并继续修改”，已经授权 Agent 为落实这些
   * 意见调整当前 MR 的业务文件集合。既有人工排除仍是硬边界，平台目录
   * 仍由宿主硬剔除；其余必要的新源码/测试先继承到候选集合，再由本轮
   * 人工意见复检卡统一确认，不因为文件集合变化额外制造第二张卡。 */
  private async inheritWorkspaceReviewDeliverySelection(
    task: TaskState,
  ): Promise<void> {
    const loop = task.summary.delivery?.loop;
    const selection = task.summary.delivery_selection;
    if (!loop?.workspace_review_pending) return;
    if (selection?.status !== "confirmed" || !task.cwd) {
      loop.workspace_review_pending = false;
      this.persist(task);
      return;
    }
    const snapshot = await deliveryChangeSnapshot(task.cwd);
    if (!snapshot?.baseline) return;
    const paths = normalizedDeliveryPaths(snapshot.committed_paths);
    const rejected = new Set(normalizedDeliveryPaths(selection.excluded_paths));
    // 这两类绝不靠“用户提交了检视意见”放宽。正常情况下前面的机械
    // 清理已经移除；若仍在，保留 pending 让既有门禁明确停下。
    if (paths.some((path) => rejected.has(path) || isAgentPlatformPath(path))) {
      return;
    }
    task.summary.delivery_selection = {
      ...selection,
      paths,
      observed_paths: snapshot.workspace_paths,
      head: snapshot.head,
      baseline: snapshot.baseline,
      updated_at: new Date().toISOString(),
    };
    loop.workspace_review_pending = false;
    this.persist(task);
    this.options.log?.(
      `任务 ${task.summary.id} 本地 MR 检视已更新本轮候选交付集合(${paths.length} 个文件)，等待同一轮人工复检`);
  }

  /** 中心能力注入目录绝不能靠 Agent 自觉。info/exclude 防普通 add，
   * 这里复核从任务基线到 HEAD 的整个提交历史，连“先提交、后删除”也
   * 拦住——删除后的 blob 仍会随分支传到远端，最终树干净不代表安全。 */
  private async agentPlatformChangesAllowPush(task: TaskState): Promise<boolean> {
    if (!task.cwd) return false;
    const snapshot = await deliveryChangeSnapshot(task.cwd);
    const paths = snapshot?.added_agent_platform_paths ?? [];
    if (!paths.length) return true;
    const detail = "已阻止 push：本任务提交历史包含 Agent 平台本地目录 "
      + `${describeDirtyPaths(paths)}。这些目录可能由中心服务注入，只供当前`
      + "工作区使用，不能进入业务仓；请从本任务提交历史中移除这些路径后"
      + "重新提交（不要修改业务仓 .gitignore）。";
    task.summary.status = "failed";
    task.summary.detail = detail;
    task.summary.delivery = { ...task.summary.delivery, skipped: detail };
    this.persist(task);
    this.options.log?.(`任务 ${task.summary.id} ${detail}`);
    return false;
  }

  /** Git 交付(§10):任务收轮并释放 Agent 后,由宿主推送并反查远端
   * SHA，再建 MR——不信任务自己的说法，也不让 Agent 接触 token。
   * MR 成功≠完成:流水线过了才"等待合入",否则停在"验证中"。
   * 交付失败不吞:原因写进 summary.delivery,任务保持 completed。 */
  private async tryDeliver(
    task: TaskState,
    epoch: number,
  ): Promise<"review_reply_blocked" | undefined> {
    // 多仓父任务只负责需求理解和人工检视，不产生分支/MR。
    if (this.isRequirementAnalysis(task)) return;
    // settle 在调用交付前已经释放修复会话并清空 mission。此刻开始处理
    // 的是修复结果验证，不再是“Agent 正在修复”；prepush 可能耗时很长，
    // 这条转换必须在任何外部 I/O 之前持久化，重启和页面才能同一口径。
    if (this.enterRepairVerification(task)) this.persist(task);
    // 本地 prepush 不依赖 MR/流水线服务。部署窗口里外部平台暂未就绪时
    // 仍应先把被重启打断的本地验证接回来，不能卡在 preparing 假装在跑。
    const platformUrl = this.effectivePlatformUrl();
    const prepush = task.summary.delivery?.prepush;
    const pendingPrePush = Boolean(prepush
      && !["passed", "user_skipped", "blocked", "environment_error"]
        .includes(prepush.state));
    if ((!platformUrl || !this.options.host) && !pendingPrePush) {
      if (this.atExternalVerificationWait(task)) {
        this.holdWithRecovery(
          task, "等待权威流水线：MR / 流水线服务未就绪", epoch);
      }
      return;
    }
    if (!task.cwd) {
      // active_attempt 是死进程留下的确证；启用 prepush 的当前部署也有
      // 责任说清环境缺口。两者都没有时可能只是旧版只读台账，保持兼容。
      if (task.summary.delivery?.prepush?.active_attempt
          || this.options.prepush?.enabled) {
        this.failPendingPrePush(task, "代码现场路径缺失");
      }
      return;
    }
    try {
      const statePath = join(task.cwd, ".mae-flow.json");
      if (!existsSync(statePath)) {
        const reason = "流程未初始化,无可交付";
        task.summary.delivery = { ...task.summary.delivery, skipped: reason };
        if (task.summary.delivery.prepush
            && !["passed", "user_skipped", "blocked", "environment_error"]
              .includes(task.summary.delivery.prepush.state)) {
          this.failPendingPrePush(task, reason);
        } else {
          this.persist(task);
        }
        return;
      }
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      const branch = String(state?.config?.["分支名"] ?? "");
      const baseline = String(state?.config?.["基线分支"] ?? "");
      if (!branch || !baseline) {
        const reason = "配置未确认,无分支可交付";
        task.summary.delivery = { ...task.summary.delivery, skipped: reason };
        if (state.current === "external_verify") {
          // 这一条重试没有意义:配置不会自己长出来。直接如实停下喊人,
          // 别用预算空转半小时再说同一句话。
          this.markVerificationStalled(task, reason);
        } else if (task.summary.delivery.prepush
            && !["passed", "user_skipped", "blocked", "environment_error"]
              .includes(task.summary.delivery.prepush.state)) {
          this.failPendingPrePush(task, reason);
        } else {
          this.persist(task);
        }
        return;
      }
      // 定格基线祖先门禁必须走在一切交付动作(Build-Fix/范围整理/推送)
      // 之前:历史脱离基线时后面每一步都在错的合同上白烧。
      const baselineGate =
        await this.reconcileFrozenBaselineAncestry(task, true);
      if (baselineGate === "blocked") return;
      // 流水线修复若只把用户明确排除的过程件带回提交，宿主先机械收口，
      // 不新增一道让 Agent 反复碰撞的门禁；真正的新业务文件仍在后面的
      // 最终范围卡确认。第一遍也避免在已知污染 HEAD 上白烧编译。
      const beforePrePush = await this.reconcileConfirmedDeliveryBoundary(task);
      if (beforePrePush === "blocked") return;
      if (!await this.agentPlatformChangesAllowPush(task)) return;
      if (!await this.preparePush(task, branch, baseline, epoch)) return;
      if (!this.current(task, epoch)) return;
      // prepush Agent 本身可能修代码并产生新提交。若它误带回的仍只是既有
      // 排除项，机械重组后需要让新 SHA 再验一次；最多这一次回补，不循环。
      const afterPrePush = await this.reconcileConfirmedDeliveryBoundary(task);
      if (afterPrePush === "blocked") return;
      if (afterPrePush === "changed") {
        if (!await this.preparePush(task, branch, baseline, epoch)) return;
        if (!this.current(task, epoch)) return;
      }
      if (!await this.agentPlatformChangesAllowPush(task)) return;
      await this.inheritWorkspaceReviewDeliverySelection(task);
      if (!this.current(task, epoch)) return;
      // 平台检视回复必须在 Build-Fix 以及交付范围机械整理全部收敛后
      // 才绑定最终 HEAD 入 outbox。此前在普通 Agent 收口时就入队，
      // prepush 若继续修码产生新提交，回复会错误地借后一个 SHA 投递。
      if (task.summary.delivery?.loop?.kind === "review"
          && task.summary.delivery.loop.review_source === "platform") {
        const staged = await this.stageReviewReplies(task);
        if (!staged.ok) {
          const loop = task.summary.delivery.loop;
          loop.state = "halted";
          loop.diagnosis = staged.detail;
          task.summary.status = "verifying";
          task.summary.detail = staged.detail ?? "MR 逐条回复不完整";
          task.summary.delivery.stalled = task.summary.detail;
          this.persist(task);
          this.notifyRepairStopped(task);
          return "review_reply_blocked";
        }
        if (!this.current(task, epoch)) return;
      }
      // 从这里开始才需要外部交付平台。prepush 已经有明确收口，不会因
      // 平台配置在部署窗口暂缺而留下“准备中但没有 owner”的僵尸状态。
      if (!platformUrl || !this.options.host) {
        const reason = "等待权威流水线：MR / 流水线服务未就绪";
        if (this.atExternalVerificationWait(task)) {
          this.holdWithRecovery(task, reason, epoch);
        } else {
          task.summary.delivery = {
            ...task.summary.delivery,
            skipped: reason,
          };
          this.persist(task);
        }
        return;
      }
      // 人工只看 prepush 收敛后的最终范围，避免“刚确认就因验证修复
      // 换了 HEAD 又确认一次”。之后仍由实时路径复核守住白名单；若
      // 自动修复越界增删/重命名文件，下一次续推会重新举卡。
      // 把已通过的 Build-Fix/人工确认绑定到一个不可变 SHA。后续门禁
      // 与真实 push 之间即便有外部进程移动工作区 HEAD，pushFromHost
      // 也只接受这里钉死的提交，不会把未检视的新 HEAD 顺手送上远端。
      const observedRevision = await this.prePushRevision(task);
      const authorizedPrePush = task.summary.delivery?.prepush;
      const expectedPushSha = this.options.prepush?.enabled
          && authorizedPrePush?.sha
          && ["passed", "user_skipped"].includes(authorizedPrePush.state)
        ? authorizedPrePush.sha : observedRevision.sha;
      if (!await this.pushConfirmationSatisfied(task, branch)) return;
      if (!await this.deliverySelectionAllowsPush(task, branch)) return;
      // 推送前最后一道基线复核:Build-Fix/确认期间若历史又被改写,
      // 只如实停下(fail-closed),不在这个时点做任何机械改写。
      if (await this.reconcileFrozenBaselineAncestry(task, false)
          === "blocked") return;
      const previous = task.summary.delivery;
      const pushReceipt = await this.pushFromHost(
        task, branch, expectedPushSha);
      const sha = pushReceipt.sha;
      if (previous) previous.git_push = pushReceipt;
      else task.summary.delivery = { git_push: pushReceipt };
      // push 已经发生就先落账；即使随后 MR/流水线接口抖动，恢复时也能
      // 复核同一 SHA，不会把传输事实误当成 Agent 自述。
      this.persist(task);
      // 检视回复只能在对应代码可从远端看见后投递。部分失败保留在
      // outbox，后续监控/重启继续；不重派 Agent、不删除失败项。
      if (!await this.flushReviewReplyOutbox(task)) {
        this.scheduleDeliveryRecovery(task, epoch);
        return "review_reply_blocked";
      }
      if (!this.current(task, epoch)) return;
      // 修复回程的岔路:SHA 没变说明本轮没有新代码(检视修复只回复
      // 不改码、或修复会话判断无需改动)。这时**绝不再触发流水线**
      // ——远端每跑一条流水线都是钱,同 SHA 重跑还是同一个结果。
      // 上一轮绿 → 直接回门禁监控;上一轮红 → 重新分类裁决
      // (检视清了之后可能轮到 CI 修,brake 按类各管各的)。
      if (previous?.sha === sha && previous.pipeline) {
        if (previous.pipeline === "success") {
          // 同 SHA 的总体绿灯只复用事实，不复用结论。进程可能上次死在
          // 内核登记前也可能进程退出；重新核销但绝不重跑同 SHA 流水线。
          task.summary.status = "verifying";
          await this.pipelineVerdict(task, sha, "success", "",
            previous.checks, epoch);
          return;
        }
        if (previous.pipeline.startsWith("failed")) {
          // 老路径里状态由触发块扳到 verifying,这条岔路必须自己扳——
          // 不扳的话 settle 会把还红着的任务误收成 completed(实测)。
          task.summary.status = "verifying";
          await this.pipelineVerdict(task, sha, "failed",
            previous.loop?.failure ?? "", previous.checks, epoch);
          return;
        }
        if (previous.pipeline.startsWith("running")) {
          // 同 SHA 上次还挂着"运行中"(含预算耗尽/拒陈灯注记):流水线
          // 大概率仍在远端跑或早已出结果只是没人盯。跌进下面的触发块
          // 就是重建 MR + 同 SHA 重触发——远端每条流水线都是钱。
          // 唯一正确动作:带新预算续轮,已终态的第一轮查询就能收口。
          task.summary.status = "verifying";
          this.persist(task);
          this.bypass(task, "流水线轮询", this.pollPipeline(task, epoch));
          return;
        }
      }
      // 外部动作台账(§11):请求先落一行(带幂等键),结果回来再补
      // 结果侧——恢复时"先查远端真实状态"就有底账可对。纯旁路。
      const ledger = (action: Omit<ExternalAction, "taskId">) =>
        this.bypass(task, "投影动作", this.options.projection?.recordAction(
          { taskId: task.summary.id, ...action }));
      const mrRequest = {
        // 任务级仓进了场,适配层必须知道这单落在哪个仓——
        // repo 字段随 MR/流水线请求走,假件(单仓)忽略它无害。
        repo: task.summary.repo_url ?? this.effectiveDefaultRepo(),
        source_branch: branch,
        target_branch: baseline,
        // 编译失败后人工跳过的交付,标记必须跟着 MR 走到平台上:检视
        // 人在 CodeHub 里看不见云端工作台,不标就是让他在不知情下背书
        // 一份从未编译过的代码(云端契约里编译全托给流水线,2026-08-30
        // 审计)。判据是 skipped_by(只有失败跳过路落它)——清单整理的
        // user_skipped 是 prepush 通过后的机械调整,不打标。MR 幂等复用
        // 时旧标题不更新,尽力而为。
        title: `${state?.config?.["单号"] ?? branch}: ${
          task.summary.title ?? taskTitle(task.summary.requirement)}${
          task.summary.delivery?.prepush?.state === "user_skipped"
            && task.summary.delivery.prepush.skipped_by
            ? `【未经本地编译验证,${
              task.summary.delivery.prepush.skipped_by}跳过】`
            : ""}`,
        // E2E 单号关联(内网诉求 2026-08-19):单号只拼进 title 平台看
        // 不见,要走 codehub-cli 的 --e2e-issues 才可追踪。取值优先
        // **用户下单填的需求号**(用户拍板"直接关联开始填入的那个"),
        // 回落内核配置确认的定稿(老单/无表单形态);REQ/DTS 都走这个
        // 参数,平台不区分类型(toolkit 源码里两类混传)。字段名跟
        // 内网 adapter.json 已定的 {dts_no} 占位符,不折腾他们返工。
        dts_no: task.summary.ticket
          ?? String(state?.config?.["单号"] ?? ""),
      };
      const mrKey = `mr:${branch}->${baseline}`;
      const mrStarted = new Date().toISOString();
      ledger({ idemKey: mrKey, kind: "mr_create", request: mrRequest,
               sha, startedAt: mrStarted });
      // MR 创建走公共客户端(与问题流共用同一格式):适配层负责
      // codehub CLI、单号关联与输出抽取,这里只递身份与事实。
      const mr = await createMergeRequest({
        platformUrl,
        repo: mrRequest.repo ?? pushReceipt.url ?? undefined,
        sourceBranch: branch,
        targetBranch: baseline,
        title: mrRequest.title,
        ...(mrRequest.dts_no ? { dtsNo: mrRequest.dts_no } : {}),
        credential: this.options.gitCredential?.(task.summary.luban_account),
      });
      if (!this.current(task, epoch)) return;
      ledger({ idemKey: mrKey, kind: "mr_create", request: mrRequest,
               sha, startedAt: mrStarted,
               // 入账用平台的原始响应,不是抽剩的 url/id:台账是恢复时
               // "先查远端真实状态"的底账,裁字段等于自断证据。
               result: mr.raw,
               finishedAt: new Date().toISOString() });
      const runKey = `pipeline:${sha}`;
      const runStarted = new Date().toISOString();
      const runRequest = { sha, repo: mrRequest.repo };
      ledger({ idemKey: runKey, kind: "pipeline_trigger",
               request: runRequest, sha, startedAt: runStarted });
      const run = await fetch(`${platformUrl}/pipeline/trigger`, {
        method: "POST",
        headers: this.platformIdentity(task),
        body: JSON.stringify(runRequest),
      }).then((r) => readJson(r));
      if (!this.current(task, epoch)) return;
      if (!["success", "failed", "running"].includes(String(run.status))) {
        throw new Error(`流水线返回未知状态: ${String(run.status ?? "(empty)")}`);
      }
      const checks = parsePipelineChecks(run.checks);
      ledger({ idemKey: runKey, kind: "pipeline_trigger",
               request: runRequest, sha, startedAt: runStarted, result: run,
               finishedAt: new Date().toISOString() });
      task.summary.delivery = {
        ...(task.summary.delivery?.loop
          ? { loop: task.summary.delivery.loop } : {}),
        ...(task.summary.delivery?.prepush
          ? { prepush: task.summary.delivery.prepush } : {}),
        git_push: pushReceipt,
        mr_url: mr.url,
        // 平台给了 MR 标识就记下:门禁/讨论查询要带回去(假件给 id,
        // codehubcli 给 iid;没有也不碍事,适配层还能按分支对查)。
        ...(mr.id !== undefined ? { mr_id: mr.id } : {}),
        source_branch: branch,
        target_branch: baseline,
        mr_state: "验证中",
        pipeline: run.status,
        ...(checks !== undefined ? { checks } : {}),
        sha,
      };
      task.summary.status = "verifying";
      // 终态当场裁决;running 不是结局,由带预算的轮询收敛后再裁。
      if (run.status === "running") {
        this.bypass(task, "流水线轮询", this.pollPipeline(task, epoch));
      } else {
        await this.pipelineVerdict(task, sha,
          run.status === "success" ? "success" : "failed",
          String(run.log ?? ""), checks, epoch);
      }
    } catch (error) {
      if (!this.current(task, epoch)) return;
      // 嵌套的 "Error: Error: …" 前缀对人是噪声,剥掉再进卡片/日志。
      const rawCause = String(error).replace(/^(Error:\s*)+/, "");
      const cause = userFacingDeliveryFailure(error);
      if (cause !== rawCause) {
        this.options.log?.(`任务 ${task.summary.id} 交付原始异常:${rawCause}`);
      }
      const reason = `交付动作失败: ${cause}`;
      task.summary.delivery = { ...task.summary.delivery, skipped: reason };
      const prepush = task.summary.delivery.prepush;
      if (prepush
          && !["passed", "user_skipped", "blocked", "environment_error"]
            .includes(prepush.state)) {
        this.failPendingPrePush(task, cause);
        this.options.log?.(`任务 ${task.summary.id} ${reason}`);
        return;
      }
      if (this.atExternalVerificationWait(task)) {
        // push 504 / MR 网关 500 这类多半是一阵子的事,自己再试几轮;
        // 预算用完就停下说人话,而不是永远停在"验证中"没人管
        // (实测过:那种状态既没定时器、重启也不复活、连重跑都被拒)。
        // 确定性 4xx(分支不存在、参数错……)例外:同一请求再发一百次
        // 还是 4xx,不烧重试预算,当场如实停摆喊人(MFC-020 实测同文
        // MR-400 以 poll_interval 节拍刷了 86 条日志、两轮预算)。
        // 408/429 是超时/限流,仍按瞬时故障自愈。
        const contractBroken = deterministicDeliveryFailure(cause);
        if (/HTTP 4(?!08\b|29\b)\d\d\b/.test(cause) || contractBroken) {
          this.markVerificationStalled(task, `等待权威流水线：${reason}`);
        } else {
          const retrying = cause.startsWith("交付平台暂时连接不上")
            ? "交付平台连接异常，系统正在自动重试，暂时无需操作"
            : `等待权威流水线：${reason}`;
          this.holdWithRecovery(task, retrying, epoch);
        }
      }
      this.logDeliveryFailure(task, reason);
    }
  }

  /** 同因交付失败按指纹聚合:首次全文,其后每 10 次记一条计数——
   * 排障要的是"发生了什么、重复了多少次",不是 86 条同文刷屏。 */
  private logDeliveryFailure(task: TaskState, reason: string): void {
    const fingerprint = reason.slice(0, 200);
    const last = task.deliveryFailureLog;
    if (last?.fingerprint === fingerprint) {
      last.count += 1;
      if (last.count % 10 === 0) {
        this.options.log?.(`任务 ${task.summary.id} 交付失败已重复 `
          + `${last.count} 次(同一原因,已聚合): ${fingerprint.slice(0, 80)}…`);
      }
      return;
    }
    task.deliveryFailureLog = { fingerprint, count: 1 };
    this.options.log?.(`任务 ${task.summary.id} ${reason}`);
  }

  /** 修复会话 → 修复结果验证的唯一状态交接。
   *
   * mission 仍在表示专职修复 Agent 尚未完成，绝不能提前切；没有 mission
   * 且任务仍在活动交付态时，repairing 已经是旧版遗留或刚收口的陈旧值。
   * 返回是否发生转换，由调用方在自己的原子边界持久化。 */
  private enterRepairVerification(task: TaskState): boolean {
    const loop = task.summary.delivery?.loop;
    if (loop?.state !== "repairing" || task.mission) return false;
    if (!["queued", "running", "pausing", "verifying"]
      .includes(task.summary.status)) return false;
    loop.state = "verifying";
    task.summary.detail = task.summary.delivery?.prepush
      ? "修复会话已完成，正在验证修复后的提交"
      : "修复会话已完成，等待验证修复后的提交";
    return true;
  }

  /** 流水线异步收敛:轮询 status?sha= 直到终态或任务真正结束。
   * - 结果只认绑定 SHA 的运行(旧绿灯不背书新代码);
   * - 查询失败 fail-open 继续轮；MR 合入/用户取消前不因时间预算失联;
   * - 终态落袋:状态/台账/通知一次收口,幂等锚是任务当前状态。 */
  private async pollPipeline(task: TaskState, epoch: number): Promise<void> {
    const delivery = this.options.delivery;
    const sha = task.summary.delivery?.sha;
    if (!this.effectivePlatformUrl() || !sha) return;
    if (task.pipelinePollSha === sha) return;
    task.pipelinePollSha = sha;
    try {
    if (task.summary.delivery?.pipeline?.startsWith("running(")) {
      // 旧版本可能留下“预算耗尽”的求助台词；现在监听跟任务同寿命，
      // 重建后复位成真实的 running。
      // 复位成裸 running,后续事实由本轮如实写。
      task.summary.delivery = { ...task.summary.delivery, pipeline: "running" };
      this.persist(task);
    }
    const knobs = this.options.settings?.runtime() ?? {};
    const interval = (knobs.poll_interval_s !== undefined
      ? knobs.poll_interval_s * 1000 : undefined)
      ?? delivery?.pollIntervalMs ?? 10_000;
    while (true) {
      // unref:轮询是旁路,不许它吊着进程不退(进程要退就让它退,
      // 重启后 recover 会以 delivery.sha 为锚续轮)。
      await new Promise((tick) => setTimeout(tick, interval).unref());
      if (!this.current(task, epoch)
          || task.summary.status !== "verifying"
          || task.summary.delivery?.sha !== sha) return; // 已被别处推进/新 SHA 接棒
      let terminal;
      try {
        const repo = encodeURIComponent(
          task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "");
        const mrId = task.summary.delivery?.mr_id;
        const status = await fetch(
          `${this.effectivePlatformUrl()}/pipeline/status`
          + `?sha=${sha}&repo=${repo}`
          + (mrId !== undefined
            ? `&mr=${encodeURIComponent(String(mrId))}` : ""),
          { headers: this.platformIdentity(task) })
          .then((r) => readJson(r));
        if (!this.current(task, epoch)
            || task.summary.status !== "verifying"
            || task.summary.delivery?.sha !== sha) return;
        // 防陈灯机械核验(2026-08-28 对比报告头号根因):is_valid=false
        // 或 run 绑着别的 SHA 的一律不认——旧绿灯不背书新代码,旧红灯
        // 也不背书。被拒原因写进现场,人能看见"为什么还在等"。
        const allRuns = Array.isArray(status.runs) ? status.runs : [];
        const picked = selectTerminalRun(
          allRuns.length ? [allRuns.at(-1)!] : [], sha);
        terminal = picked.run;
        if (!terminal && picked.rejected.length) {
          const why = picked.rejected[picked.rejected.length - 1];
          task.summary.delivery = {
            ...task.summary.delivery,
            pipeline: `running(等待绑定本次提交的流水线;已拒陈灯: ${why})`,
          };
          this.options.log?.(
            `任务 ${task.summary.id} 拒收陈灯流水线: ${picked.rejected.join("; ")}`);
        }
      } catch (error) {
        this.options.log?.(
          `任务 ${task.summary.id} 流水线查询失败(继续轮): ${String(error)}`);
        continue;
      }
      if (!terminal) continue;
      const checks = parsePipelineChecks(terminal.checks);
      task.summary.delivery = {
        ...task.summary.delivery,
        pipeline: terminal.status,
        mr_state: "验证中",
        ...(checks !== undefined ? { checks } : {}),
      };
      task.summary.status = "verifying";
      this.bypass(task, "投影动作", this.options.projection?.recordAction({
        taskId: task.summary.id,
        idemKey: `pipeline:${sha}`,
        kind: "pipeline_trigger",
        request: { sha },
        result: terminal,
        sha,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }));
      // 终态交给裁决点:绿=收口通知;红=修复环决定下一步。
      // (persist/notify 都在裁决点里,别在这儿重复收口。)
      await this.pipelineVerdict(task, sha,
        terminal.status === "success" ? "success" : "failed",
        String(terminal.log ?? ""), checks, epoch);
      return;
    }
    } finally {
      if (task.pipelinePollSha === sha) task.pipelinePollSha = undefined;
    }
  }

  /**
   * 流水线终态裁决点(小状态机)——"流水线直至全绿是最终目标"(用户拍板)。
   *
   * 两个入口(触发即终态 / 轮询收敛到终态)都汇到这里,转移规则:
   *   绿 → 内核按 execution_contract 核销 COMPILE/UT/CODECHECK，只有
   *       PASS 才 loop.state=green + await_merge；typed checks 是可选的
   *       诊断增强，明确 pending/failed/过期仍 verifying/RED;
   *   红 → 同一 SHA 修过一轮又红 = 修复会话没产生新提交 → halted,
   *       会话的收口发言当诊断带给人(它判了"改代码解决不了");
   *       修复轮预算(可配手刹,默认不限)耗尽 → exhausted 请人工;
   *       否则派专职修复会话:使命=分诊后按类修绿(可派专职子 agent),
   *       任务重入队,修完 settle→tryDeliver 自然触发新 SHA 的新流水线
   *       ——环由现有机械闭合,这里只记账和扳道岔。
   * 常规收口通知仍归两个调用方;halted/exhausted 例外,在这儿主动
   * 喊人(带独立幂等键)——轮询路径收敛到停机时没有别的收口点。
   */
  private async pipelineVerdict(
    task: TaskState,
    sha: string,
    status: "success" | "failed",
    log: string,
    checks: PipelineCheck[] | undefined,
    epoch: number,
  ): Promise<void> {
    if (!this.current(task, epoch)) return;
    const delivery = task.summary.delivery;
    if (!delivery) return;
    if (status === "success") {
      // 平台总体 success 绑定精确 SHA，且 execution_contract 已声明该
      // 权威流水线覆盖三项时可以聚合核销。typed checks 若存在则提供更
      // 精确裁决；登记失败、pending、STALE 仍一律不放行。
      const attestation = await this.recordPipelineEvidence(
        task, sha, status, checks);
      if (!this.current(task, epoch)) return;
      if (attestation?.verdict === "RED") {
        // overall 与逐项结果矛盾时，裁决权仍在内核。typed RED 进入与
        // 常规红灯完全相同的轻量修复环，不挂一张人工 Diff 卡。
        delivery.pipeline = "failed(逐项质量结果未通过)";
        await this.handlePipelineRed(
          task, sha, attestation.reason ?? log, epoch);
        return;
      }
      if (attestation?.verdict !== "PASS") {
        const verdict = attestation?.verdict;
        const reason = attestation?.reason
          ?? (checks === undefined
            ? "内核未完成整体流水线核销；逐项 Job 未配置，仅影响诊断"
            : "内核未能登记流水线逐项结果");
        const waiting = verdict
          ? `等待流水线证据核销：${verdict} · ${reason}`
          : `等待流水线证据核销：${reason}`;
        task.summary.status = "verifying";
        delivery.mr_state = "验证中";
        delivery.waiting_on = waiting;
        task.summary.detail = waiting;
        this.persist(task);
        this.schedulePipelineEvidenceRetry(
          task, sha, epoch, verdict === "STALE");
        return;
      }
      const terminal = this.completionAttestation(task);
      if (terminal && !terminal.complete) {
        // `pipeline record` 的返回值不能单独成为 Cloud 终态。必须重新读
        // 内核落盘现场，确认 command 已把 external_verify 推到 flow 的
        // terminal，且 PASS 仍绑定当前 HEAD；这样 hook/保存/推进任一
        // 处失败都不会从返回字符串的空窗里漏进 await_merge。
        this.holdExternalVerification(
          task, `等待内核终态对账：${terminal.reason}`);
        this.schedulePipelineEvidenceRetry(task, sha, epoch, false);
        return;
      }
      if (delivery.loop) delivery.loop.state = "green";
      delivery.mr_state = "等待合入";
      delivery.waiting_on = undefined;
      task.summary.status = "await_merge";
      task.summary.detail = "编译、UT 运行与 CodeCheck 均已由权威流水线核销";
      this.persist(task);
      // 流水线绿≠赢了:九项门禁全过 + 合入才是终点(内网既有框架的
      // 实证)。支持门禁契约的平台接着盯;不支持的(fetchGates 回
      // undefined)保持旧语义——await_merge 即收口,一字不变。
      this.bypass(task, "合入监控", this.watchMerge(task, epoch));
      return;
    }
    // 红灯也过证据口：先留绑定 SHA 的逐项物证，再进同一轻量修复环。
    await this.recordPipelineEvidence(task, sha, status, checks);
    if (!this.current(task, epoch)) return;
    await this.handlePipelineRed(task, sha, log, epoch);
  }

  /** 内核裁成 RED 后的唯一处理器。来源可以是总体 failed，也可以是
   * “总体 success、某个 typed check failed”的矛盾平台响应；两者都只
   * 派轻量修复会话，不回人工 Diff、不重放内核完整质量链。 */
  private async handlePipelineRed(
    task: TaskState,
    sha: string,
    log: string,
    epoch: number,
  ): Promise<void> {
    if (!this.current(task, epoch)) return;
    const delivery = task.summary.delivery;
    if (!delivery) return;
    task.summary.status = "verifying";
    delivery.mr_state = "验证中";
    delivery.waiting_on = undefined;
    // 三层覆盖:任务 > 设置 > 部署;全都没配 = 不限轮(用户拍板
    // "不该有最大轮数限制"),0 = 关。真正兜住无限的是收敛刹车:
    // 没新提交即停 + 无进展必须换思路或出诊断(使命里的纪律)。
    const max = task.summary.repair_rounds
      ?? this.options.settings?.runtime().repair_rounds
      ?? this.options.delivery?.repairRounds;
    // repairRounds=0 = 关掉修复环:保持旧语义(红灯留痕请人工),不记环账。
    if (max === 0 && !delivery.loop) {
      this.persist(task);
      return;
    }
    // 失败先分类再派单(检视>冲突>CI,同时多项只修最高优先级那一路)。
    // 门禁不可得(平台不支持/查询失败)时按 CI 处理——正是旧语义。
    const view = await this.fetchGates(task);
    if (!this.current(task, epoch)) return;
    if (view?.mrState === "merged" || view?.mrState === "closed") {
      this.settleMergeState(task, view.mrState, view.sourceSha);
      return;
    }
    const sorted = view
      ? classifyGates(view.gates) : { repairs: [], waiting: [] };
    // 按优先级顺序找第一条派得出去的路。检视"已回复等检视人确认"
    // 不占路(报告 D3:平台不代人 resolve,红着只是没人点)——落到
    // 下一优先级继续,别让等人把 CI 修复堵死。
    for (const candidate of sorted.repairs) {
      if (candidate.kind === "review") {
        const outcome = await this.dispatchReviewRepair(task, max, epoch);
        if (!this.current(task, epoch)) return;
        if (outcome === "waiting" || outcome === "skip") continue;
        return; // dispatched/halted 都已各自收口
      }
      if (candidate.kind === "conflict") {
        if (await this.dispatchConflictRepair(task, sha, max, epoch)) return;
        continue;
      }
      await this.dispatchCiRepair(task, sha,
        log || (candidate.gate.detail ?? ""), max, epoch);
      return;
    }
    // 没有可派的修复路(门禁不可得,或可修门禁都在等人):按旧语义
    // 走 CI 修复——流水线红是实锤,同 SHA 刹车会兜住原地打转。
    await this.dispatchCiRepair(task, sha, log, max, epoch);
  }

  private pipelineArtifactTexts(
    task: TaskState,
    names: string[],
  ): PipelineArtifactText[] {
    const dir = join(task.summary.workspace, "pipeline");
    return names.flatMap((raw): PipelineArtifactText[] => {
      const name = basename(raw);
      if (!name || name !== raw) return [];
      try {
        return [{ name, text: readFileSync(join(dir, name), "utf-8") }];
      } catch {
        return [];
      }
    });
  }

  private repairEvidenceBudgetMs(): number {
    const knobs = this.options.settings?.runtime() ?? {};
    return (knobs.poll_timeout_s !== undefined
      ? knobs.poll_timeout_s * 1000 : undefined)
      ?? this.options.delivery?.pollTimeoutMs ?? 30 * 60_000;
  }

  private repairEvidenceDelayMs(waitingHuman: boolean): number {
    void waitingHuman;
    // 重采 artifacts 比查状态重得多，且 token 可能由外部 5
    // 分钟刷新脚本维护。单次调用立即刷新/重试一次；仍不可用
    // 则退出当前请求，由这个定时器每 3 分钟发起新一轮。
    return Math.max(50,
      this.options.delivery?.evidenceRetryMs ?? 3 * 60_000);
  }

  private scheduleRepairEvidenceRetry(
    task: TaskState,
    sha: string,
    log: string,
    max: number | undefined,
    epoch: number,
    waitingHuman: boolean,
  ): void {
    if (task.repairEvidenceRetryActive) return;
    task.repairEvidenceRetryActive = true;
    const timer = setTimeout(() => {
      task.repairEvidenceRetryActive = false;
      if (!this.current(task, epoch)
          || task.summary.status !== "verifying"
          || task.summary.delivery?.sha !== sha
          || !task.summary.delivery?.pipeline?.startsWith("failed")
          || task.summary.delivery?.loop?.state === "repairing") return;
      this.bypass(task, "流水线失败证据重试",
        this.dispatchCiRepair(task, sha, log, max, epoch));
    }, this.repairEvidenceDelayMs(waitingHuman));
    timer.unref();
  }

  private evidenceGapReasons(
    assessment: PipelineEvidenceAssessment,
  ): string[] {
    return assessment.missingDimensions.flatMap((dimension) => {
      const reasons = assessment.reasons[dimension] ?? [];
      return reasons.length
        ? reasons.map((reason) =>
            `${PIPELINE_DIMENSION_TEXT[dimension]}：${reason}`)
        : [`${PIPELINE_DIMENSION_TEXT[dimension]}：未拿到具体报错`];
    });
  }

  private writePipelineEvidenceGapMaterial(
    task: TaskState,
    assessment: PipelineEvidenceAssessment,
  ): void {
    const dir = join(task.summary.workspace, "pipeline");
    mkdirSync(dir, { recursive: true });
    const dimensions = assessment.missingDimensions
      .map((item) => PIPELINE_DIMENSION_TEXT[item]).join("、");
    const content = [
      "# 流水线证据缺口",
      "",
      `提交版本：${task.summary.delivery?.sha ?? "未知"}`,
      `缺少具体报错的维度：${dimensions}`,
      "",
      "系统已经确认这些维度红灯，但降级取证链没有返回可定位的报错原文：",
      ...this.evidenceGapReasons(assessment).map((reason) => `- ${reason}`),
      "",
      "请在平台打开对应失败项，复制包含文件、行号、错误信息或堆栈的原文，",
      "然后在本材料上添加批注并点击“回灌报错”。Agent 只会据此处理，",
      "不会把本说明本身当成流水线错误证据。",
      "",
    ].join("\n");
    try {
      writeFileSync(join(dir, "流水线证据缺口.md"), content, { mode: 0o444 });
    } catch (error) {
      // 这份材料是人工入口的可用性增强；落不下不能反过来改写交付
      // 判定，小鲁班与任务 waiting_on 仍是完整的降级入口。
      this.options.log?.(
        `任务 ${task.summary.id} 证据缺口材料写入失败: ${String(error)}`);
    }
  }

  private notifyPipelineEvidenceGap(
    task: TaskState,
    assessment: PipelineEvidenceAssessment,
    partial: boolean,
  ): void {
    const { notifier } = this.options;
    const account = task.summary.luban_account;
    const delivery = task.summary.delivery;
    if (!notifier || !account || !delivery?.sha
        || !assessment.missingDimensions.length) return;
    const dimensions = assessment.missingDimensions
      .map((item) => PIPELINE_DIMENSION_TEXT[item]).join("、");
    const reasons = this.evidenceGapReasons(assessment).join("；").slice(0, 900);
    const action = "请打开任务工作台，在《流水线证据缺口》材料上添加批注，"
      + "把平台页面的具体报错原文粘贴进去并提交；系统会自动回灌给 Agent。";
    this.bypass(task, "流水线证据缺口通知", notifier.notifyOutcome({
      taskId: task.summary.id,
      account,
      status: `pipeline_evidence_${delivery.sha.slice(0, 12)}_`
        + assessment.missingDimensions.join("_").toLowerCase(),
      summary: partial
        ? `流水线 ${dimensions} 红灯但具体报错缺失；Agent 会先修已有证据的部分。`
          + `${reasons}。${action}`
        : `流水线 ${dimensions} 红灯，但取证重试后仍没有具体报错，`
          + `为避免猜改已暂停自动修复。${reasons}。${action}`,
      link: personalTaskLink(
        this.notificationLinkBase(), account, task.summary.id),
    }));
  }

  /** CI 修复派单(修复环的老主路):同 SHA 不二修、轮数预算、
   * 分诊+定位使命。唯一会累加 round 的一路——检视/冲突是流程性
   * 问题,不许耗掉代码修复的额度。 */
  private async dispatchCiRepair(
    task: TaskState,
    sha: string,
    log: string,
    max: number | undefined,
    epoch: number,
  ): Promise<void> {
    if (!this.current(task, epoch)) return;
    const delivery = task.summary.delivery!;
    // 不可修工具前置分诊(toolkit UNFIXABLE_TOOLS 对齐):红灯全部来自
    // SuperChecker 类工具时,修复会话改代码解决不了——不派单不烧轮,
    // 如实挂"等人",人处理/豁免后重跑流水线即可回本环。
    if (onlyUnfixableToolFailures(
        delivery.checks, this.options.delivery?.unfixableTools)) {
      delivery.pipeline = "failed(仅剩不可自动修复工具的告警,等人处理)";
      delivery.waiting_on =
        "CODECHECK 红灯全部来自不可自动修复的工具(部署配置的"
        + " unfixable_tools 名单)。请在平台上处理或豁免这些告警后"
        + "重跑流水线;修复 Agent 改代码解决不了这类问题,不派单。";
      task.summary.detail = delivery.waiting_on;
      this.persist(task);
      this.notifyRepairStopped(task);
      return;
    }
    const existingLoop = delivery.loop;
    if (existingLoop?.kind === "ci" && existingLoop.last_sha === sha) {
      // 修复会话没产生新提交 = 会话自己判了"改代码解决不了"。
      // 它的收口发言就是诊断(缺什么、去哪配),原文带给人,
      // 别让人拿着一句"已停"再去翻日志猜。
      existingLoop.state = "halted";
      const diagnosis = (task.lastReply ?? "").trim();
      if (diagnosis) existingLoop.diagnosis = diagnosis.slice(0, 2000);
      delivery.pipeline = "failed(自动修复已停,需人工)";
      task.summary.detail = diagnosis
        ? `自动修复停下,修复会话的诊断:${diagnosis.slice(0, 600)}`
        : "修复会话未产生新提交,流水线仍红,请人工查看流水线日志";
      this.persist(task);
      this.notifyRepairStopped(task);
      return;
    }
    // 先采证再创建/累加 loop：若红灯的具体报错全缺，根本没有派 Agent，
    // 这一轮不能凭空扣掉修复预算。
    const artifacts = await this.mirrorPipelineArtifacts(task);
    if (!this.current(task, epoch)) return;
    const previousGap = delivery.evidence_gap?.sha === sha
      ? delivery.evidence_gap : undefined;
    const humanEvidence = previousGap?.human_evidence?.trim()
      ? {
          dimensions: previousGap.human_dimensions
            ?? previousGap.missing_dimensions,
          text: previousGap.human_evidence,
        }
      : undefined;
    const assessment = assessPipelineRepairEvidence({
      checks: delivery.checks,
      artifacts: this.pipelineArtifactTexts(task, artifacts),
      failureSummary: log,
      humanEvidence,
    });
    const hasDimensionFacts = assessment.failedDimensions.length > 0;
    if (hasDimensionFacts && assessment.missingDimensions.length) {
      this.writePipelineEvidenceGapMaterial(task, assessment);
      const allMissing = assessment.availableDimensions.length === 0;
      const reasons = this.evidenceGapReasons(assessment);
      const now = Date.now();
      const priorDeadline = previousGap?.retry_deadline
        ? Date.parse(previousGap.retry_deadline) : NaN;
      const deadline = Number.isFinite(priorDeadline)
        ? priorDeadline : now + this.repairEvidenceBudgetMs();
      const attempts = (previousGap?.attempts ?? 0) + 1;
      if (allMissing) {
        const waitingHuman = now >= deadline;
        delivery.evidence_gap = {
          sha,
          state: waitingHuman ? "waiting_human" : "retrying",
          missing_dimensions: assessment.missingDimensions,
          available_dimensions: [],
          reasons,
          attempts,
          failure_log: log.slice(0, 2000),
          retry_deadline: new Date(deadline).toISOString(),
          ...(previousGap?.notified_at
            ? { notified_at: previousGap.notified_at } : {}),
          ...(previousGap?.human_evidence
            ? { human_evidence: previousGap.human_evidence } : {}),
          ...(previousGap?.human_dimensions
            ? { human_dimensions: previousGap.human_dimensions } : {}),
        };
        const dimensions = assessment.missingDimensions
          .map((item) => PIPELINE_DIMENSION_TEXT[item]).join("、");
        delivery.pipeline = waitingHuman
          ? `failed(${dimensions} 具体报错缺失,等人工回灌)`
          : `failed(${dimensions} 具体报错缺失,第 ${attempts} 次取证重试)`;
        delivery.waiting_on = waitingHuman
          ? `${dimensions} 红灯，但取证降级链均未给出可定位的具体报错。`
            + "请在工作台对应材料上添加批注，粘贴平台报错原文并提交；"
            + "平台证据若恢复，系统也会自动继续。"
          : `${dimensions} 红灯但具体报错暂缺，系统正在有限重试取证，`
            + "尚未派 Agent、未消耗修复轮次。";
        task.summary.detail = delivery.waiting_on;
        if (waitingHuman && !delivery.evidence_gap.notified_at) {
          delivery.evidence_gap.notified_at = new Date().toISOString();
          this.notifyPipelineEvidenceGap(task, assessment, false);
        }
        this.persist(task);
        this.scheduleRepairEvidenceRetry(
          task, sha, log, max, epoch, waitingHuman);
        return;
      }
      // 部分维度有证据：能修的马上修，缺的同时求人，不互相等待。
      delivery.evidence_gap = {
        sha,
        state: "partial",
        missing_dimensions: assessment.missingDimensions,
        available_dimensions: assessment.availableDimensions,
        reasons,
        attempts,
        failure_log: log.slice(0, 2000),
        notified_at: previousGap?.notified_at ?? new Date().toISOString(),
        ...(previousGap?.human_evidence
          ? { human_evidence: previousGap.human_evidence } : {}),
        ...(previousGap?.human_dimensions
          ? { human_dimensions: previousGap.human_dimensions } : {}),
      };
      if (!previousGap?.notified_at) {
        this.notifyPipelineEvidenceGap(task, assessment, true);
      }
      delivery.waiting_on = undefined;
    } else if (hasDimensionFacts) {
      delivery.evidence_gap = undefined;
      delivery.waiting_on = undefined;
    }

    const loop = delivery.loop
      ?? (delivery.loop = { round: 0, max, state: "repairing" as const });
    if (loop.max !== undefined && loop.round >= loop.max) {
      loop.state = "exhausted";
      delivery.pipeline = `failed(${loop.max} 轮修复预算用完,请人工)`;
      task.summary.detail =
        `${loop.max} 轮修复预算用完,流水线仍红,请人工`;
      this.persist(task);
      this.notifyRepairStopped(task);
      return;
    }
    // 上一轮的失败详情留一份给新使命对比——"和上轮同一处打转"是
    // 换思路/出诊断的触发条件,这个判断只有会话自己做得可靠。
    const previousFailure = loop.round > 0 ? loop.failure : undefined;
    loop.round += 1;
    loop.last_sha = sha;
    loop.kind = "ci";
    loop.state = "repairing";
    loop.failure = log.slice(0, 2000) || "(平台未提供失败详情)";
    // 批2 双通道:摘要进使命(下面),完整日志已在逐维度判定前落盘到
    // 工作区外 pipeline/，让修复会话自读。
    // 输入可信度:log 是纯链接或干脆缺席、又没有镜像材料时,修复会话
    // 手里没有任何失败证据。内网实锤:适配层把 log 填成流水线页面链接
    // (会话没有登录态,打不开),使命却把它包装成"失败详情(平台原文)"
    // ——会话以为自己有输入,硬着头皮定位→修改→提交,看着专业实为
    // 猜改,烧流水线还烧不出结论。证据缺席必须明说,行为才会从"猜改
    // 凑提交"变成"能自证的修、不能自证的走诊断出口停下喊人"。
    // 判据不能只认裸链接:内网真实形态是"标签 + 链接"
    // (`FAILED stage=CodeCCP2.0 job=CodeCCP2.0  detail: https://…`),
    // 只认裸链接的第一版正好漏掉了它要防的那个场景(2026-08-21 读进场
    // 报告逮住)。改判"把链接抠掉之后还剩多少诊断内容":剩下的只有
    // stage/job 标签 = 链接在替内容站岗。没有链接则不论长短都是平台
    // 给的真内容(如 "BUILD FAILURE: 模块 x 编译失败"),不算无证据。
    const withoutLinks = loop.failure.replace(/https?:\/\/\S+/g, "").trim();
    const blindInput = !artifacts.length
      && (loop.failure === "(平台未提供失败详情)"
        || (withoutLinks.length < loop.failure.trim().length
          && withoutLinks.length < 120));
    const roundText = loop.max !== undefined
      ? `第 ${loop.round}/${loop.max} 轮` : `第 ${loop.round} 轮`;
    delivery.pipeline = `failed(${roundText}修复中)`;
    // 逐项事实单独进使命(2026-08-21 内网数据逼出来的):平台的 log 详细
    // 程度按维度不均——CODECHECK 给到了文件行号规则,COMPILE 只有一句
    // "构建失败=1"。只喂 log,模型会照着详细那一维修完就交,另一维照旧
    // 红,又是白烧一轮。checks 是结构化的平台事实,把失败维度点名列出,
    // 模型才知道本轮的完整战场;某一维没有细节就明说去要,别默默漏掉。
    const failedDimensions = (delivery.checks ?? [])
      .filter((check) => check.status === "failed")
      .map((check) => check.dimension + (check.job ? `(${check.job})` : ""));
    // stage/job/工具/缺陷定位的结构化明细(适配层给到多细这里就有多细,
    // toolkit 对齐):有它,定位从"对着日志猜"变成"照单点名"。
    const structuredFailures = summarizeFailedChecks(delivery.checks);
    const unfixableSet = new Set(
      (this.options.delivery?.unfixableTools ?? [])
        .map((tool) => tool.trim().toLowerCase()).filter(Boolean));
    const unfixableHit = (delivery.checks ?? []).some((check) =>
      check.status === "failed" && [
        ...(check.tool ? [check.tool] : []),
        ...(check.details ?? []).map((defect) => defect.tool ?? ""),
      ].some((tool) => unfixableSet.has(tool.toLowerCase())));
    task.mission = [
      `流水线红了,把它修到绿是你此刻唯一的使命(${roundText}修复):`,
      ...(failedDimensions.length ? [
        `- 本轮失败的维度(平台逐项事实,权威):`
        + `${failedDimensions.join("、")}。**每一维都要收拾**,`
        + `不要只修下面日志里讲得细的那一维就交差——日志的详细程度`
        + `按维度不均,讲得少不等于没红。某一维在日志和 ../pipeline/ 里`
        + `都找不到细节时,不许猜改,把"缺哪一维的失败原文"写进收口发言。`,
      ] : []),
      ...(structuredFailures.length ? [
        `- 结构化失败明细(哪个 stage 的哪个 job 的哪个工具,含缺陷定位):`,
        ...structuredFailures.map((line) => `  ${line}`),
      ] : []),
      ...(assessment.missingDimensions.length ? [
        `- 证据缺口(系统已并行求助人工):${assessment.missingDimensions
          .map((dimension) => PIPELINE_DIMENSION_TEXT[dimension]).join("、")}`
          + " 红灯，但平台取证没有给出可定位原文。只修已有证据的维度，"
          + "缺口维度不许猜改；人工补充会通过工作台批注送达。",
        ...this.evidenceGapReasons(assessment)
          .map((reason) => `  - ${reason}`),
      ] : []),
      ...(humanEvidence?.text ? [
        "- 人工从工作台回灌的流水线报错原文（按人的原话定位，不扩大解释）：",
        humanEvidence.text.slice(0, 12_000),
      ] : []),
      ...(unfixableHit ? [
        `- 其中不可自动修复工具(部署 unfixable_tools 名单)产生的告警`
        + `**不要硬修**——那要人工在平台处理/豁免;修好其余问题后,`
        + `在收口发言里把这类告警单独点名留给人工。`,
      ] : []),
      ...(blindInput ? [
        `- 分支上提交 ${sha} 的权威流水线结果是 failed,**但平台没有给出`
        + `失败日志原文**(只给了: ${loop.failure})。你手里没有可信的`
        + `失败证据,本轮第一要务是取证,不是动手改。`,
        `- 证据纪律:只修你能在工作区自证的问题(通读代码找得到、`
        + `lightcheck 报得出的,并写明依据);自证不了的不许猜改碰运气`
        + `——把"平台未提供失败日志,适配层需补 log 原文与`
        + ` pipeline_artifacts 端点"写成诊断,不提交,系统会带着你的`
        + `诊断如实停下请人工,这比猜改一轮更有价值。`,
      ] : [
        `- 分支上提交 ${sha} 的权威流水线结果是 failed。失败详情(平台原文):`,
        loop.failure,
      ]),
      ...(artifacts.length ? [
        `- 完整失败材料已镜像到 ../pipeline/(仓库外,不会进提交),`
        + `分诊与定位先读它们,别只凭上面的摘要猜:`,
        ...artifacts.map((name) => `  ../pipeline/${name}`),
      ] : []),
      ...(previousFailure ? [
        `- 上一轮修复后流水线仍红,上一轮的失败详情如下,先对比再动手:`
        + `若与本轮是同一处原地打转,说明上轮改法无效,必须换思路;`
        + `换思路也解决不了的,走下面的诊断出口,不许重复同样的修改。`,
        previousFailure,
      ] : []),
      ...(task.summary.delivery_selection?.status === "confirmed" ? [
        "- 本轮继承用户已经确认的最终推送范围。修流水线不是重新选文件：",
        deliverySelectionNote(
          task.summary.delivery_selection.paths,
          task.summary.delivery_selection.excluded_paths,
        ),
        "  已确认文件可以正常修改并提交；此前排除的文件留在本地即可，"
          + "不得为了清空 git status 重新提交。确需新增、删除或重命名业务"
          + "文件时可以做，Cloud 会只为新的业务范围重新请用户确认一次。",
      ] : []),
      `- 先分诊再动手:通读日志,列出本轮暴露的全部问题类别`
      + `(编译报错/编译告警/UT 失败/UT 覆盖率不够/CodeCheck/其他),`
      + `一轮把能修的全修完,不留尾巴等下一轮。`,
      // 定位先于修改(Agentless 的固定管线在修 bug 上打赢自由 agent
      // 循环):逼一句"依据"出来,是为了让定位错当场暴露——说不出
      // 依据的定位多半是猜的,猜着改就是拿流水线当调试器。
      `- 定位先于修改:每一类问题先落到具体文件与函数/测试用例,`
      + `并写明定位依据(日志里的哪一行、堆栈的哪一帧、覆盖率报告的`
      + `哪个类)。依据说不出来就说明还没定位到,继续查,不许凭猜改;`
      + `日志指向的位置与真正的病根不一致时,以病根为准并说明推断链。`,
      // 2026-08-25 编排瘦身后,内核在交付主流程里不再签发
      // COMPILE/UT/CODECHECK 质量任务卡(卡只留给 standalone 工具单)。
      // 历史教训仍然成立:原文让它"派专职子 agent",模型照做就撞死路
      // (拿不到卡 → agent-task 被打回 → 来回空转)。修复轮里改代码
      // 这件事由本会话自己做。
      `- 按类分头修:编译类、UT/覆盖率类、检视类各修各的,互不搅和。`
      + `**本轮不要找内核要 COMPILE/UT/CODECHECK 任务卡或派专职质量子`
      + ` agent**——交付流程里没有那些卡,要了也拿不到,白烧回合。`
      + `补测试、改代码都由你自己动手(UT 的写法照常按已装载的`
      + ` UT skill 走);确需并行时只派不带任务卡的通用子 agent,`
      + `并把定位到的文件与依据一并交给它,别让它从头再查。`,
      `- 修复纪律:补覆盖率要写真测试,不许凑数骗指标;CodeCheck 修问题`
      + `本身,不许加抑制注释糊弄;编译告警要消除,不是关闭告警。`,
      `- 全部修完凑成一次提交。不要读取或索要个人 Git 令牌，`
      + `也不要 push；会话释放后 Cloud 宿主会统一推送并复核远端 SHA。`
      + `别的都不要动,顺手的重构、无关的优化一律不做。`,
      `- 诊断出口:凡不是本仓代码能修的(外部平台的配置、权限、环境、`
      + `流水线自身的问题),那一类不要硬改碰运气;若所有问题都不可修,`
      + `不要提交,把诊断写清楚:缺什么、要去哪配、配好之后如何重跑`
      + `——没有新提交时系统会带着你的诊断如实停下请人工,`
      + `这是正确结局之一,不是失败。`,
      // 插话纪律(内网实锤):一轮修复被"补文档章节"的插话整轮占满,
      // 没碰流水线也没提交,刹车把它的文档汇报当成了诊断——人看着
      // "自动修复已停"配一段章节标题,完全接不上。插话照办是对的
      // (人的话优先),但收口不回到使命就是把本轮白丢。
      `- 插话纪律:会话中途收到的插话(人的补充要求、[mae-flow] 的`
      + `纠偏提示)照办,但办完必须回到本使命;收口发言必须以流水线`
      + `失败的定位结论收尾——本轮确实没碰流水线,就明说"本轮未处理`
      + `流水线"及原因,不许拿无关的汇报顶替诊断。`,
    ].join("\n");
    task.summary.status = "queued";
    task.summary.detail = assessment.missingDimensions.length
      ? `流水线红,${roundText}修复排队中；${assessment.missingDimensions
          .map((item) => PIPELINE_DIMENSION_TEXT[item]).join("、")}`
        + " 的具体报错缺失，已并行求助人工"
      : `流水线红,${roundText}修复排队中`;
    task.resume = true;
    this.persist(task);
    this.queue.push(task.summary.id);
    // 不能当场 pump:这里可能正处在 settle→tryDeliver 的调用链里,而
    // pump 会同步把状态置成 running,settle 随后那句"running→completed"
    // 就把修复轮当场盖掉(读代码逮住的竞态)。setImmediate 排到微任务链
    // 之后,settle 收完自己的账、原会话的 finally 归还并发额度,再派单。
    setImmediate(() => this.bypass(undefined, "任务泵", this.pump()));
  }

  /** 门禁视图:平台不支持(404/没配分支对)或查询失败一律回
   * undefined——调用方按"旧语义"处理,绝不让门禁查询卡死闭环。
   * 形状校验从严:name/passed 类型不对的项直接丢弃,宿主不猜。 */
  private async fetchGates(task: TaskState): Promise<GateView | undefined> {
    const platformUrl = this.effectivePlatformUrl();
    const delivery = task.summary.delivery;
    if (!platformUrl || !delivery?.source_branch
        || !delivery.target_branch) {
      return undefined;
    }
    try {
      const params = new URLSearchParams({
        repo: task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "",
        source_branch: delivery.source_branch,
        target_branch: delivery.target_branch,
      });
      if (delivery.mr_id !== undefined) {
        params.set("mr", String(delivery.mr_id));
      }
      const response = await fetch(
        `${platformUrl}/mr/gates?${params}`,
        { headers: this.platformIdentity(task) });
      if (response.status === 404) return undefined; // 平台不支持门禁契约
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await readJson(response);
      const gates: GateItem[] = (Array.isArray(body.gates) ? body.gates : [])
        .filter((gate: any) => typeof gate?.name === "string"
          && typeof gate?.passed === "boolean")
        .map((gate: any) => ({
          name: gate.name,
          passed: gate.passed,
          ...(gate.detail ? { detail: String(gate.detail) } : {}),
        }));
      const mrState = body.mr_state === "merged" || body.mr_state === "closed"
        ? body.mr_state : "opened";
      const sourceSha = typeof body.sha === "string" && body.sha.trim()
        ? body.sha.trim() : undefined;
      return { mrState, gates, ...(sourceSha ? { sourceSha } : {}) };
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 门禁查询失败(按不可得处理): ${String(error)}`);
      return undefined;
    }
  }

  /** MR 平台侧状态:merged 才是任务真正结束。closed 只是一个需要人
   * 处理的等待态：MR 可能被误关后重开，不能替用户把整个任务判死。
   * observedSourceSha 是平台报告的 MR 源提交:与本任务验证过的
   * delivery.sha 不一致时绝不能 completed——流水线绿灯、prepush 收据
   * 与人工检视全部绑定旧 SHA,拿它们背书别的提交是交付完整性漏洞
   * (MFC-038 实证:夹具换 SHA 合入,MFC 仍拿旧验证宣告完成)。 */
  private settleMergeState(
    task: TaskState,
    state: "merged" | "closed",
    observedSourceSha?: string,
  ): void {
    const delivery = task.summary.delivery!;
    if (state === "merged") {
      const verified = String(delivery.sha ?? "").trim();
      const observed = String(observedSourceSha ?? "").trim();
      if (verified && observed && verified !== observed) {
        this.markVerificationStalled(task,
          `平台实际合入的提交 ${observed.slice(0, 7)} 与本任务验证过的 ${
            verified.slice(0, 7)} 不一致;流水线与人工检视只背书后者,`
          + "不能标记完成。请人工核实分支是否被平台侧改写。");
        return;
      }
      const attestation = this.completionAttestation(task);
      if (attestation && !attestation.complete) {
        // 远端 MR 状态不能反向篡改内核流程真相。即使有人在平台上手工
        // 合入，也只有内核 terminal + 当前 HEAD 的逐项 PASS 才能解锁
        // 下游；恢复会再次对账并把该任务续到正确锚点。
        delivery.mr_state = "已合入（内核终态待对账）";
        delivery.waiting_on = attestation.reason;
        task.summary.status = "verifying";
        task.summary.detail = `MR 已合入，但不能标记完成：${attestation.reason}`;
        this.persist(task);
        return;
      }
      if (delivery.loop) delivery.loop.state = "green";
      delivery.mr_state = "已合入";
      delivery.waiting_on = undefined;
      task.summary.status = "completed";
      task.summary.detail = "MR 已合入,交付完成";
      this.persist(task);
      this.bypass(undefined, "依赖任务解锁", this.pump());
      const account = task.summary.luban_account;
      if (this.options.notifier && account) {
        this.bypass(task, "收口通知", this.options.notifier.notifyOutcome({
          taskId: task.summary.id,
          account,
          status: "merged",
          summary: `MR 已合入`
            + (delivery.mr_url ? `:${delivery.mr_url}` : ""),
          link: personalTaskLink(
            this.notificationLinkBase(), account, task.summary.id),
        }));
      }
      return;
    }
    const changed = delivery.mr_state !== "已关闭"
      || delivery.waiting_on !== "MR 已关闭，请重新打开或由任务责任人主动停止任务";
    delivery.mr_state = "已关闭";
    delivery.waiting_on = "MR 已关闭，请重新打开或由任务责任人主动停止任务";
    task.summary.status = "await_merge";
    task.summary.detail = "MR 已关闭但任务尚未结束；系统继续监听，重开后自动恢复";
    if (changed) this.persist(task);
  }

  /** 合入监控环:流水线绿之后接着盯门禁与 MR 状态,直到合入、用户取消
   * 或出现可修失败。内网既有框架的"挂起等待"语义在这里:
   * 等审批/投票不是异常,保持监控、告诉人卡在哪,不空转不扣重试。
   * 绿灯不是终态：目标分支、检视或平台状态随后变化，都要重新响应。 */
  private async watchMerge(task: TaskState, epoch: number): Promise<void> {
    if (task.mergeWatchActive) return; // 防重入:一任务一环
    task.mergeWatchActive = true;
    try {
      const knobs = this.options.settings?.runtime() ?? {};
      const interval = (knobs.poll_interval_s !== undefined
        ? knobs.poll_interval_s * 1000 : undefined)
        ?? this.options.delivery?.pollIntervalMs ?? 10_000;
      while (true) {
        if (!this.current(task, epoch)
            || task.summary.status !== "await_merge") return;
        if (!await this.flushReviewReplyOutbox(task)) {
          await new Promise((tick) => setTimeout(tick, interval).unref());
          continue;
        }
        if (!this.current(task, epoch)
            || task.summary.status !== "await_merge") return;
        const view = await this.fetchGates(task);
        if (!this.current(task, epoch)
            || task.summary.status !== "await_merge") return;
        if (!view) {
          // 平台暂不可得也不能永久丢掉监听；等待下一拍。timer unref，
          // 服务退出时不会被后台监控吊住，重启恢复会重新挂环。
          await new Promise((tick) => setTimeout(tick, interval).unref());
          continue;
        }
        if (view.mrState === "merged") {
          this.settleMergeState(task, "merged", view.sourceSha);
          return;
        }
        if (view.mrState === "closed") {
          this.settleMergeState(task, "closed");
          await new Promise((tick) => setTimeout(tick, interval).unref());
          continue;
        }
        // MFC-038:MR 还开着但源提交已不是本任务验证过的那一个——
        // 有人在平台侧改写了分支。旧绿灯不背书新代码,立即停摆喊人;
        // 在途修复不会走到这里(派修复即离开 await_merge,回来前会
        // 重新对齐 MR 与 delivery.sha)。
        {
          const verified = String(task.summary.delivery?.sha ?? "").trim();
          const observed = String(view.sourceSha ?? "").trim();
          if (verified && observed && verified !== observed) {
            this.markVerificationStalled(task,
              `MR 源分支已指向未经本任务验证的提交 ${observed.slice(0, 7)}`
              + `(已验证的是 ${verified.slice(0, 7)});已停止自动合入`
              + "监控,请人工核实分支是否被平台侧改写。");
            return;
          }
        }
        if (task.summary.delivery?.mr_state === "已关闭") {
          task.summary.delivery.mr_state = "等待合入";
          task.summary.delivery.waiting_on = undefined;
          task.summary.detail = "MR 已重新打开，继续监听流水线与合入状态";
          this.persist(task);
        }
        const sorted = classifyGates(view.gates);
        if (sorted.repairs.length) {
          // 绿灯后门禁又亮红:检视/冲突照常派;CI 红说明平台侧又跑了
          // 一条流水线(目标分支动了之类),失败详情用门禁给的话。
          // 检视"已回复等检视人确认"不派单也不停环——归入等待名单,
          // 继续盯下一优先级和 MR 状态(报告 D3 的语义)。
          const max = task.summary.repair_rounds
            ?? this.options.settings?.runtime().repair_rounds
            ?? this.options.delivery?.repairRounds;
          if (max === 0) {
            // 关闭的是“自动修”，不是“持续观察”。旧实现直接 return，
            // 任务从此再也不知道门禁恢复、MR 被关/重开或最终合入。
            // 留在同一个监控环，只把当前红项如实交给人。
            const names = sorted.repairs.map((candidate) =>
              candidate.kind === "review" ? "检视意见"
                : candidate.kind === "conflict" ? "代码冲突" : "流水线红灯");
            sorted.waiting.push(
              `自动修复已关闭，请人工处理${[...new Set(names)].join("、")}`);
          } else {
            const sha = task.summary.delivery?.sha ?? "";
            for (const candidate of sorted.repairs) {
              if (candidate.kind === "review") {
                const outcome =
                  await this.dispatchReviewRepair(task, max, epoch);
                if (!this.current(task, epoch)
                    || task.summary.status !== "await_merge") return;
                if (outcome === "waiting") {
                  sorted.waiting.push("等检视人确认已回复的意见");
                  continue;
                }
                if (outcome === "skip") continue;
                return; // dispatched/halted 都已各自收口
              }
              if (candidate.kind === "conflict") {
                if (await this.dispatchConflictRepair(task, sha, max, epoch)) return;
                continue;
              }
              await this.dispatchCiRepair(task, sha,
                candidate.gate.detail ?? "门禁 ci_state_passed 未通过",
                max, epoch);
              return;
            }
          }
        }
        const waitingText = sorted.waiting.join("、");
        if (waitingText !== (task.summary.delivery?.waiting_on ?? "")) {
          task.summary.delivery!.waiting_on = waitingText || undefined;
          task.summary.detail = waitingText
            ? `门禁与流水线已过,MR 在${waitingText}`
            : "门禁全绿,等待合入";
          this.persist(task);
          // 等人的事要告诉人(幂等键=门禁集合,同一批等待只提醒一次;
          // 换了一批等待项才再响)。
          const account = task.summary.luban_account;
          if (waitingText && this.options.notifier && account) {
            this.bypass(task, "等待通知",
              this.options.notifier.notifyOutcome({
              taskId: task.summary.id,
              account,
              status: `waiting:${sorted.waiting.sort().join("+")}`,
              summary: `MR 在${waitingText},需要相关人处理`
                + (task.summary.delivery?.mr_url
                  ? `:${task.summary.delivery.mr_url}` : ""),
              link: personalTaskLink(
                this.notificationLinkBase(), account, task.summary.id),
            }));
          }
        }
        await new Promise((tick) => setTimeout(tick, interval).unref());
      }
    } finally {
      task.mergeWatchActive = false;
    }
  }

  /** 检视意见修复轮在飞时,本轮该用的交付方式(内核选项原文)。
   *
   * 为什么要开新单而不是在旧单上改(2026-08-20 查实):内核的 end =
   * "推送 + 流水线绿",而云端的交付完成 = 合入。中间等合入这段冒出来
   * 的检视意见,原来是往**终态**工作区塞个 mission 重新入队——`current`
   * 还停在 end,Hook 门禁整体旁路,修复会话全程裸奔。
   *
   * 内核对这段早有designed的路,而且是机读契约:workflow_select 的
   * choices 里有 review,但 new_order_choices 没有它(「review 仅限
   * 已交付单」)。走这条路修复要重新过 build/delivery_review,
   * push 之后还自动进 external_verify 复验——修复本身也要流水线判绿
   * 才算数。
   *
   * 只认 state="repairing":轮次判绿或刹车后就该恢复本单原交付方式,
   * 否则下次重建会话会莫名其妙又开一张 review 单。 */
  private reviewRoundLane(task: TaskState): string {
    const loop = task.summary.delivery?.loop;
    if (loop?.kind !== "review" || loop.state !== "repairing") return "";
    return workflowLabel(this.options.host?.kernelRoot, "review");
  }

  /** 检视修复派单(批3):拉未解决讨论→落盘 reviews/→专职会话逐条
   * 处理并写 ../review_replies.md→收口后宿主发布回复(默认不代
   * resolve,报告 D3)。不扣 CI 重试且清零(流程性问题不许耗掉代码
   * 修复额度)。同一批讨论 id 分两种结局:回复都发布过了=等检视人
   * 确认(waiting,调用方落到下一优先级继续);一条都没答复=会话
   * 没干活,真刹车(halted)。 */
  private async dispatchReviewRepair(
    task: TaskState,
    max: number | undefined,
    epoch: number,
  ): Promise<"dispatched" | "waiting" | "halted" | "skip"> {
    if (!this.current(task, epoch)) return "skip";
    const delivery = task.summary.delivery!;
    const loop = delivery.loop
      ?? (delivery.loop = { round: 0, max, state: "repairing" as const });
    const discussions = await this.fetchDiscussions(task);
    if (!this.current(task, epoch)) return "skip";
    if (!discussions.length) {
      // 门禁说未解决但明细拉不到:可能是刚解决的竞态,别硬派——
      // 让调用方落到下一优先级,下一轮监控再看这路。
      this.options.log?.(
        `任务 ${task.summary.id} 检视门禁未过但拉不到未解决讨论,等下一轮`);
      return "skip";
    }
    const ids = discussions.map((item) => item.id).sort().join(",");
    // 答复台账跨批次继承。"未解决集合"随检视人点掉/新增而变,但已经
    // 答复过的讨论不因此变回未答复——原来换批清账重派,会对同一条讨论
    // 重复回复(2026-08-30 探针实锤:两条意见解决一条,另一条被复读),
    // 检视人视角就是机器人刷屏,还白烧一只修复会话。
    const replied = new Set(
      loop.kind === "review" && loop.review_source === "platform"
        && loop.replied_ids
        ? loop.replied_ids.split(",").filter(Boolean) : []);
    const pending = discussions.filter((item) => !replied.has(item.id));
    const pushedSha = task.summary.delivery?.git_push?.sha;
    const queuedReplyIds = new Set(this.deliveryOutbox(task)
      // 旧提交的 pending 回复不能让新提交永久停在“正在重试”。它仍
      // 留在 outbox 审计并由 flush fail-closed，但只有当前远端 push
      // 收据对应的动作才可代表本轮已经排队。
      .pendingReviewReplies(pushedSha)
      .map((item) => item.payload.discussion_id));
    if (pending.length
        && pending.every((item) => queuedReplyIds.has(item.id))) {
      // Agent 已逐条答完，当前只是在重试外部投递。把它当“没干活”再派
      // Agent 会重复改代码/刷回复；保持监控即可。
      return "waiting";
    }
    if (loop.kind === "review" && loop.review_ids === ids) {
      if (loop.replied_ids === ids) {
        // 这批意见的回复都发布过了,门禁红只是检视人还没点"已解决"
        // ——那是等人,不是修不动。不派单不停环,调用方把它记进
        // waiting_on 继续盯。
        return "waiting";
      }
      loop.state = "halted";
      const diagnosis = (task.lastReply ?? "").trim();
      if (diagnosis) loop.diagnosis = diagnosis.slice(0, 2000);
      // 点名没答复的是哪几条:不点名,人只能去 MR 上逐条对台账。
      const unanswered = discussions.map((item) => item.id)
        .filter((one) => !replied.has(one));
      task.summary.detail =
        `同一批检视意见处理过一轮仍未答复完(未答复: ${
          unanswered.slice(0, 8).join(", ")}${
          unanswered.length > 8 ? ` 等 ${unanswered.length} 条` : ""
        }),请人工查看 MR 讨论`;
      this.persist(task);
      this.notifyRepairStopped(task);
      return "halted";
    }
    if (loop.kind === "review" && loop.review_source === "platform"
        && !pending.length) {
      // 集合变了但没有要新答的(检视人解决了部分):同步台账口径到
      // 当前集合,继续等人——绝不重新派单。
      loop.review_ids = ids;
      loop.replied_ids = ids;
      this.persist(task);
      return "waiting";
    }
    loop.kind = "review";
    loop.review_source = "platform";
    loop.round = 0; // 检视触发清零 CI 重试(内网框架的实证语义)
    loop.review_ids = ids;
    // 换批只继承仍在场的答复记录,不清零(见上);离场的 id 出账,
    // 免得台账无限膨胀。
    loop.replied_ids = [...replied]
      .filter((one) => discussions.some((item) => item.id === one))
      .sort().join(",") || undefined;
    loop.state = "repairing";
    // 意见落盘 reviews/(仓库外):原始数据给 agent 自读,摘要进使命。
    const reviewsDir = join(task.summary.workspace, "reviews");
    try {
      rmSync(reviewsDir, { recursive: true, force: true });
      mkdirSync(reviewsDir, { recursive: true });
      writeFileSync(join(reviewsDir, "discussions.json"),
        JSON.stringify(discussions, null, 2));
    } catch {
      /* 落盘失败不拦路:使命里的摘要仍然够用 */
    }
    const lines = pending.map((item) =>
      `  [${item.id}] ${item.file ?? "(整体意见)"}`
      + `${item.line !== undefined ? `:${item.line}` : ""}`
      + `${item.severity ? ` (${item.severity})` : ""}`
      + `${item.author ? ` ${item.author}` : ""}:`
      + ` ${String(item.body ?? "").slice(0, 300)}`);
    this.enqueueRepair(task,
      [
        `MR 上有 ${pending.length} 条检视意见待处理,`
        + `逐条处理它们是你此刻唯一的使命:`,
        ...lines,
        ...(discussions.length > pending.length ? [
          `- 另有 ${discussions.length - pending.length} 条此前已答复、`
          + `在等检视人确认,**不要**再答复它们。`,
        ] : []),
        `- Cloud 宿主已在你入场前机械开启「处理评审意见」新轮，`
        + `**不要再次 init、不要 exit/goto/skip**；先执行 current，`
        + `随后严格按本步指引走到 end。分支不会新建，内核按本单单号`
        + `派生的就是当前 MR 分支。`,
        `- 为什么要走这张新单:它让本轮修改继续受内核门禁和证据台账`
        + `约束，并在提交后重新进入流水线验证；不能在上一轮 end 上裸改。`,
        `- 原始数据在 ../reviews/discussions.json(仓库外),需要完整`
        + `上下文时自己读。`,
        `- 意见对的就改代码,意见基于误解的不改——但必须说清依据,`
        + `不许含糊带过;不确定的按意见改(检视人对本仓比你熟)。`,
        `- 把逐条回复写到 ../review_replies.md(仓库外,不会进提交),`
        + `格式严格如下,每条以方括号 id 单独一行开头:`,
        `  [${pending[0].id}]`,
        `  <这条的回复:改了什么/为什么不改,一两句讲清>`,
        `- 改动在 build 步收口前如实 commit(按 current 的指引),`
        + `不要自己另起一套；不要读取或索要个人 Git 令牌,也不要 push,`
        + `Cloud 宿主会在会话释放后统一推送。`,
        `- 全部是解释、没有代码改动也是正常结局:照样按 current 走完,`
        + `在对应步骤如实说明本轮无代码改动,不要为了凑步骤改代码。`,
        `- 系统会把你的回复发布到对应讨论(是否代点"已解决"由部署配置`
        + `决定,默认留给检视人点),回复写给检视人看,说人话,`
        + `别写流程黑话。`,
      ].join("\n"),
      `检视意见 ${pending.length} 条,专职会话处理中`);
    return "dispatched";
  }

  /** 工作台本地检视修复：用户点“提交并继续修改”本身就是逐条修复授权，
   * 与“MR 上别人留了一条意见、需要责任人先裁决”不是同一种输入。
   * 仍走内核 review 正路，但不让 Agent 再问一遍“这些意见接不接纳”。 */
  private dispatchWorkspaceReviewRepair(
    task: TaskState,
    annotations: Annotation[],
    rendered: string,
  ): void {
    const delivery = task.summary.delivery!;
    const max = task.summary.repair_rounds
      ?? this.options.settings?.runtime().repair_rounds
      ?? this.options.delivery?.repairRounds;
    const previousFailure = delivery.loop?.failure;
    const loop = delivery.loop
      ?? (delivery.loop = { round: 0, max, state: "repairing" as const });
    loop.kind = "review";
    loop.review_source = "workspace";
    loop.workspace_review_pending = true;
    loop.workspace_review_recheck_required = true;
    loop.workspace_review_annotation_ids = [...new Set([
      ...(loop.workspace_review_annotation_ids ?? []),
      ...annotations.map((item) => item.id),
    ])];
    loop.round = 0;
    loop.max = max;
    loop.review_ids = `workspace:${annotations.map((item) =>
      `${item.id}:r${item.rework ?? 0}`).sort().join(",")}:${Date.now()}`;
    loop.replied_ids = undefined;
    loop.state = "repairing";
    loop.diagnosis = undefined;

    // 旧 SHA 的取证/停机状态不能卡住人的新修改。旧失败摘要留在使命里，
    // 让这一轮能顺手一起处理；最终结论只认新提交重新跑出的流水线。
    delivery.waiting_on = undefined;
    delivery.stalled = undefined;
    delivery.verify_deadline = undefined;
    delivery.evidence_gap = undefined;

    const reviewsDir = join(task.summary.workspace, "reviews");
    try {
      mkdirSync(reviewsDir, { recursive: true });
      writeFileSync(join(reviewsDir, "local-annotations.json"), JSON.stringify({
        task_id: task.summary.id,
        mr_url: delivery.mr_url,
        submitted_at: new Date().toISOString(),
        annotations,
      }, null, 2));
      // 本地检视没有 MR discussion 回复；残留的旧回复绝不能在本轮结束
      // 时被误发到平台。
      rmSync(join(task.summary.workspace, "review_replies.md"), { force: true });
      rmSync(join(reviewsDir, "local-receipts.json"), { force: true });
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 本地检视材料落盘失败(使命正文仍可用): ${String(error)}`);
    }
    const priorPipeline = previousFailure
      ? [
          "- 当前 MR 同时还有上一轮流水线失败。人的检视优先，但不要丢掉已知 CI 问题；两类修改合进同一次提交：",
          previousFailure,
          "  完整流水线材料若存在，仍在 ../pipeline/；新提交会重新跑权威流水线。",
        ]
      : [];
    this.enqueueRepair(task, [
      `任务责任人在工作台明确提交了 ${annotations.length} 条当前 MR 检视意见。`
        + "逐条落实并更新原 MR，是你此刻唯一的使命：",
      rendered,
      "- Cloud 宿主已在你入场前机械开启「处理评审意见」新轮。不要再次 init，"
        + "不要 exit/goto/skip；先执行 current，随后按内核指引走到 end。",
      "- 这些不是待你猜测是否接纳的外部建议：用户点击“提交并继续修改”已经明确授权"
        + "逐条修复。先查代码事实，要求明确就直接在 review.md 记为“修复(已确认)”并处理，"
        + "不要再举卡重复问‘是否修复’。",
      "- 若内核只因本轮没有重复 AskUserQuestion 而缺 ASKUSER 证据，按 current 给出的"
        + "受控出口执行一次 accept-risk askuser，并把理由写成“用户已在工作台逐条提交修改要求”；"
        + "这只豁免重复询问，不豁免 review.md、查证、实现、检视、提交或流水线。",
      "- 只有意见本身确实模糊、不同理解会造成不同代码结果时才 AskUserQuestion；"
        + "问题里必须点明歧义和不同结果，不能用泛泛的‘请确认’把工作退回用户。",
      ...priorPipeline,
      workspaceReviewReceiptInstructions(annotations),
      "- 在当前 MR 分支修改必要的源码和测试，遵守 current 的提交清单与 commit 指引。"
        + "不要读取或索要个人 Git 令牌，不要自行 push；Cloud 会统一推送到原分支、"
        + "更新原 MR，并对新 SHA 重新执行 Build-Fix 与权威流水线。",
    ].join("\n"), `收到 ${annotations.length} 条本地检视意见，正在修改当前 MR`);
  }

  /** 冲突修复派单(批4):宿主先 merge 目标分支**故意把冲突标记留在
   * 工作区**,让 agent 在真实冲突上下文里解,而不是凭描述想象
   * (内网框架里最值得抄的一条)。merge 干净=没有真冲突,交回统一的
   * host push 链，不烧会话。刹车=同 SHA 不二修。 */
  private async dispatchConflictRepair(
    task: TaskState,
    sha: string,
    max: number | undefined,
    epoch: number,
  ): Promise<boolean> {
    if (!this.current(task, epoch)) return true;
    const delivery = task.summary.delivery!;
    const target = delivery.target_branch;
    if (!task.cwd || !target) return true;
    const loop = delivery.loop
      ?? (delivery.loop = { round: 0, max, state: "repairing" as const });
    if (loop.kind === "conflict" && loop.last_sha === sha) {
      loop.state = "halted";
      const diagnosis = (task.lastReply ?? "").trim();
      if (diagnosis) loop.diagnosis = diagnosis.slice(0, 2000);
      task.summary.detail =
        "冲突修复会话没有产生新提交,冲突仍在,请人工处理";
      this.persist(task);
      this.notifyRepairStopped(task);
      return true;
    }
    const cwd = task.cwd;
    let remoteUrl: string;
    try {
      const configured = task.summary.repo_url ?? this.effectiveDefaultRepo();
      if (!configured) throw new Error("任务没有权威代码仓地址");
      validateRepositoryAddress(configured);
      if (/^[a-z][a-z\d+.-]*:/i.test(configured)
          && !/^(?:https?|file):\/\//i.test(configured)) {
        throw new Error("只允许 HTTPS 或本地仓传输");
      }
      remoteUrl = /^(?:https?|file):\/\//i.test(configured)
        ? configured : resolve(configured);
    } catch (error) {
      task.summary.detail = `冲突修复准备失败: ${String(error)}`;
      this.persist(task);
      return true;
    }
    const credential = this.options.gitCredential?.(
      task.summary.luban_account);
    let sandbox: ReturnType<TaskService["prepareHostGitSandbox"]>;
    try {
      sandbox = this.prepareHostGitSandbox(credential);
    } catch (error) {
      task.summary.detail = `冲突修复 Git 沙箱创建失败: ${String(error)}`;
      this.persist(task);
      return true;
    }
    let gitView: ReturnType<typeof createSafeGitView>;
    try {
      gitView = createSafeGitView(cwd);
    } catch (error) {
      this.cleanupHostGitCredential(sandbox);
      task.summary.detail = `冲突修复安全 Git 视图创建失败: ${String(error)}`;
      this.persist(task);
      return true;
    }
    const identityName = credential?.username
      ?? task.summary.luban_account ?? "mae-flow-cloud";
    const identityEmail = credential?.email
      ?? `${identityName.replace(/[^a-zA-Z0-9_.+-]/g, "-")}@localhost`;
    const worktreeArgs = [
      ...sandbox.args,
      "-c", `safe.directory=${resolve(cwd)}`,
      "-c", "core.fsmonitor=false",
      "-c", "commit.gpgSign=false",
      "-c", `user.name=${identityName}`,
      "-c", `user.email=${identityEmail}`,
    ];
    // fetch/merge 看真实 refs/index/objects，但 config 来自空代理 gitdir。
    // 因而 Agent 写入的 fsmonitor、filter、merge driver、url.insteadOf 与
    // credential helper 都不可能在带宿主权限/短期令牌的进程里执行。
    const worktreeEnv = gitView.environment(sandbox.env);
    // 异步 + 预算(2026-08-25 卡死事故同病类):fetch 走网络、merge
    // 碰大仓索引,同步执行会把事件循环冻住整段时间。
    const git = (...args: string[]) => runGitProcess(
      [...worktreeArgs, ...args], {
        cwd, env: worktreeEnv,
        timeoutMs: args[0] === "fetch" || args[0] === "merge"
          ? 5 * 60_000 : 30_000,
      });
    try {
      const targetCheck = await git("check-ref-format", "--branch", target);
      if (targetCheck.status !== 0) {
        task.summary.detail = `冲突修复准备失败:目标分支名不合法 ${target}`;
        this.persist(task);
        return true;
      }
      const fetched = await git(
        "fetch", "--no-tags", "--no-recurse-submodules", remoteUrl,
        `+refs/heads/${target}:refs/remotes/origin/${target}`);
      if (fetched.status !== 0) {
        task.summary.detail = `冲突修复准备失败(fetch ${target}):`
          + `${String(fetched.stderr || "").slice(0, 300)}`;
        this.persist(task);
        return true; // 环境问题不硬闯,留痕等人(或下一轮监控重试)
      }
      const beforeMerge = String(
        (await git("rev-parse", "HEAD")).stdout || "").trim();
      const merged = await git("merge", "--no-edit", `origin/${target}`);
      if (merged.status === 0) {
        const afterMerge = String(
          (await git("rev-parse", "HEAD")).stdout || "").trim();
        if (beforeMerge && afterMerge === beforeMerge) {
          // 新提交已经包含目标分支，但平台的 conflict gate 可能还没刷新。
          // 这不是“修复会话没有提交”：不写 last_sha、不退出监控，让
          // watchMerge 按原轮询节奏继续看门禁/MR。
          task.summary.detail = "本地已无冲突，等待平台刷新冲突门禁";
          this.persist(task);
          return false;
        }
        // 干净合并:没有真冲突(门禁可能滞后)。统一交给 tryDeliver 的
        // host-only 推送与远端 SHA 复核，避免另开无收据旁路。
        loop.kind = "conflict";
        loop.last_sha = sha;
        task.summary.detail = "与目标分支干净合并,等待宿主推送并触发新流水线";
        this.persist(task);
        setImmediate(() => void this.tryDeliver(task, epoch));
        return true;
      }
      const conflicted = String((await git(
        "diff", "--no-ext-diff", "--no-textconv",
        "--name-only", "--diff-filter=U")).stdout || "")
        .trim().split("\n").filter(Boolean);
      if (!conflicted.length) {
        // merge 失败却没有冲突文件 = 环境怪状(本地脏文件之类),
        // 别把 agent 派进一个说不清的现场。
        await git("merge", "--abort");
        task.summary.detail = "merge 失败但无冲突文件,请人工:"
          + `${String(merged.stderr || "").slice(0, 300)}`;
        this.persist(task);
        return true;
      }
      // merge 的 config 必须隔离，但冲突会话随后使用真实 `.git`。将 Git
      // 在可信代理 gitdir 中生成的最小 merge 状态复制回真实 gitdir；
      // index/objects/refs 本来就绑定真实仓。若目标被 Agent 换成软链，
      // 先在代理视图里 abort，再 fail-closed，绝不跟随它写宿主文件。
      try {
        for (const name of [
          "MERGE_HEAD", "MERGE_MODE", "MERGE_MSG", "ORIG_HEAD",
        ]) {
          const source = join(gitView.proxyGitDir, name);
          if (!existsSync(source)) continue;
          const sourceInfo = lstatSync(source);
          if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
            throw new Error(`代理 Git 状态 ${name} 不是普通文件`);
          }
          const targetPath = join(gitView.repositoryGitDir, name);
          if (existsSync(targetPath)) {
            const targetInfo = lstatSync(targetPath);
            if (!targetInfo.isFile() || targetInfo.isSymbolicLink()) {
              throw new Error(`任务 Git 状态 ${name} 不是普通文件`);
            }
          }
          writeFileSync(targetPath, readFileSync(source), { mode: 0o600 });
        }
      } catch (error) {
        await git("merge", "--abort");
        task.summary.detail = `冲突现场安全落盘失败: ${String(error)}`;
        this.persist(task);
        return true;
      }
      loop.kind = "conflict";
      loop.round = 0; // 冲突触发同样清零 CI 重试
      loop.last_sha = sha;
      loop.state = "repairing";
      this.enqueueRepair(task,
        [
          `MR 与目标分支 ${target} 冲突,解决它是你此刻唯一的使命:`,
          `- 宿主已在安全 Git 沙箱中准备 origin/${target} 的真实冲突现场,`,
          `  冲突标记(<<<<<<< ======= >>>>>>>)位于:`,
          ...conflicted.map((file) => `  ${file}`),
          `- 逐个文件解决:保留双方必要改动,把标记删干净;拿不准语义时`
          + `读两边的提交历史(git log)再定,不许无脑选一边。`,
          `- 解完 git add 全部冲突文件,git commit 完成合并提交`
          + `(用默认合并信息即可)。不要读取或索要个人 Git 令牌，也不要`
          + ` push；Cloud 宿主会在会话释放后统一推送。`,
          `- 不要 rebase、不要 force push、不要动无关文件。`,
        ].join("\n"),
        `与 ${target} 冲突(${conflicted.length} 个文件),专职会话解决中`);
      return true;
    } finally {
      gitView.cleanup();
      this.cleanupHostGitCredential(sandbox);
    }
  }

  private deliveryOutbox(task: TaskState): DeliveryOutbox {
    return new DeliveryOutbox(
      join(task.summary.workspace, "delivery-outbox.jsonl"));
  }

  /** Build-Fix 收敛后把逐条回复按最终 SHA 可靠入队，不做网络动作。
   * 代码尚未 push，此时先去 MR 上说“已修复”会让检视人看到旧代码；
   * 更不能部分成功后删除草稿。缺任何一条就明确停下，不能拿总体发言
   * 冒充逐条答复。 */
  private async stageReviewReplies(task: TaskState): Promise<{
    ok: boolean;
    detail?: string;
  }> {
    const loop = task.summary.delivery?.loop;
    if (loop?.review_source === "workspace" || loop?.kind !== "review") {
      return { ok: true };
    }
    const repliesPath = join(task.summary.workspace, "review_replies.md");
    const alreadyReplied = new Set(
      loop.replied_ids?.split(",").filter(Boolean) ?? []);
    let known = loop.review_ids?.split(",").filter(Boolean) ?? [];
    try {
      const rows = JSON.parse(readFileSync(
        join(task.summary.workspace, "reviews", "discussions.json"), "utf-8"));
      if (Array.isArray(rows)) {
        const ids = rows.map((item) =>
          String((item as { id?: unknown })?.id ?? "")).filter(Boolean);
        if (ids.length) known = ids;
      }
    } catch { /* review_ids 是持久化兜底 */ }
    const expected = [...new Set(known)]
      .filter((id) => !alreadyReplied.has(id));
    let sourceSha: string;
    try {
      if (!task.cwd) throw new Error("代码现场不可用");
      sourceSha = (await this.prePushRevision(task)).sha;
    } catch (error) {
      return {
        ok: false,
        detail: `MR 回复无法绑定最终提交：${String(error)}`,
      };
    }
    const outbox = this.deliveryOutbox(task);
    const staged = new Set(outbox.list()
      .filter((item) => item.kind === "review_reply"
        && item.payload.expected_sha === sourceSha)
      .map((item) => item.payload.discussion_id));
    const uncovered = expected.filter((id) => !staged.has(id));
    if (!uncovered.length) return { ok: true };
    if (!existsSync(repliesPath)) {
      return {
        ok: false,
        detail: `Agent 没有留下 MR 逐条回复（缺 ${uncovered.join("、")}）。`
          + "已保留代码现场，补齐答复前不会 push。",
      };
    }
    let text: string;
    try {
      text = readFileSync(repliesPath, "utf-8");
    } catch (error) {
      return { ok: false, detail: `读取 MR 逐条回复失败：${String(error)}` };
    }
    const parsed = parseReviewReplies(text, uncovered);
    if (parsed.missing_ids.length) {
      return {
        ok: false,
        detail: `MR 逐条回复不完整，缺 ${parsed.missing_ids.join("、")}。`
          + "已保留代码现场，不能用总体回复糊弄过去。",
      };
    }
    const repo = task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "";
    const resolve = this.options.delivery?.resolveDiscussions ?? false;
    try {
      for (const reply of parsed.replies) {
        outbox.enqueueReviewReply({
          discussion_id: reply.id,
          body: reply.body,
          repo,
          mr: task.summary.delivery?.mr_id,
          resolve,
          expected_sha: sourceSha,
        });
      }
    } catch (error) {
      return {
        ok: false,
        detail: `MR 回复进入可靠投递账失败：${String(error)}。`
          + "草稿仍保留，未继续 push。",
      };
    }
    try { rmSync(repliesPath, { force: true }); } catch {
      // outbox 已是权威事实；残留草稿下次会幂等入同一动作，不会重复。
    }
    return { ok: true };
  }

  /** 只在宿主已经拿到 push 收据后投递。单条失败只留它自己 pending；
   * 后续监控/重启继续，不重派 Agent，也不把整批误记成已回复。 */
  private reviewReplyOutboxStalled(task: TaskState): boolean {
    return task.summary.delivery?.stalled
      ?.startsWith("检视回复投递账不可读") === true;
  }

  private markReviewReplyOutboxUnreadable(
    task: TaskState,
    error: unknown,
  ): false {
    const detail = "检视回复投递账不可读，已停止自动回复；"
      + "请管理员修复任务现场中的 delivery-outbox.jsonl 后重试。"
      + `原因：${String(error).slice(0, 500)}`;
    task.summary.detail = detail;
    task.summary.delivery = {
      ...task.summary.delivery,
      stalled: detail,
      waiting_on: detail,
    };
    if (!["await_merge", "waiting_for_human", "paused", "canceled"]
      .includes(task.summary.status)) {
      task.summary.status = "verifying";
    }
    this.persist(task);
    this.options.log?.(`任务 ${task.summary.id} ${detail}`);
    return false;
  }

  private async flushReviewReplyOutbox(task: TaskState): Promise<boolean> {
    if (task.reviewOutboxFlush) return task.reviewOutboxFlush;
    const running = this.flushReviewReplyOutboxOnce(task);
    task.reviewOutboxFlush = running;
    try {
      return await running;
    } finally {
      if (task.reviewOutboxFlush === running) {
        task.reviewOutboxFlush = undefined;
      }
    }
  }

  private async flushReviewReplyOutboxOnce(task: TaskState): Promise<boolean> {
    const platformUrl = this.effectivePlatformUrl();
    const pushedSha = task.summary.delivery?.git_push?.sha;
    if (!platformUrl || !pushedSha) return true;
    const outbox = this.deliveryOutbox(task);
    let pending: DeliveryOutboxItem[];
    try {
      pending = outbox.pendingReviewReplies();
    } catch (error) {
      return this.markReviewReplyOutboxUnreadable(task, error);
    }
    for (const item of pending) {
      if (item.payload.expected_sha !== pushedSha) {
        const reason = `拒绝投递：回复绑定 ${item.payload.expected_sha.slice(0, 12)}`
          + `，当前远端推送收据是 ${pushedSha.slice(0, 12)}`;
        try {
          if (item.last_error !== reason) {
            // 这不是一次远端 attempt；只落失败原因，保持 pending，等对应
            // SHA 的真实 push 收据恢复后再投，绝不能借另一版代码发“已修”。
            outbox.markFailed(item.id, reason);
          }
        } catch (error) {
          return this.markReviewReplyOutboxUnreadable(task, error);
        }
        this.options.log?.(
          `任务 ${task.summary.id} 检视回复 SHA 不匹配，${reason}`);
        continue;
      }
      try {
        outbox.markAttempt(item.id);
        const response = await fetch(
          `${platformUrl}/mr/discussions/${
            encodeURIComponent(item.payload.discussion_id)}/reply`, {
            method: "POST",
            headers: {
              ...this.platformIdentity(task),
              "Idempotency-Key": item.id,
            },
            body: JSON.stringify({
              repo: item.payload.repo,
              mr: item.payload.mr ?? task.summary.delivery?.mr_id,
              body: item.payload.body,
              resolve: item.payload.resolve,
              idempotency_key: item.id,
            }),
          });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        outbox.markDelivered(item.id);
        this.bypass(task, "投影动作", this.options.projection?.recordAction({
          taskId: task.summary.id,
          idemKey: item.id,
          kind: "review_reply",
          request: {
            id: item.payload.discussion_id,
            body: item.payload.body.slice(0, 500),
          },
          startedAt: item.created_at,
          finishedAt: new Date().toISOString(),
        }));
      } catch (error) {
        try { outbox.markFailed(item.id, String(error)); } catch (ledgerError) {
          // 多进程或旧恢复链可能已经把同一动作落成 delivered。此时本轮
          // 的失败落账冲突不是账损坏；重新读权威 append-only 状态即可。
          try {
            const current = outbox.list().find((one) => one.id === item.id);
            if (current?.state === "delivered") continue;
          } catch (readError) {
            return this.markReviewReplyOutboxUnreadable(task, readError);
          }
          return this.markReviewReplyOutboxUnreadable(task, ledgerError);
        }
        this.options.log?.(
          `任务 ${task.summary.id} 检视回复待重试(讨论 ${
            item.payload.discussion_id}): ${String(error)}`);
      }
    }
    let delivered: string[];
    try {
      delivered = outbox.list().filter((item) =>
        item.kind === "review_reply" && item.state === "delivered")
        .map((item) => item.payload.discussion_id);
    } catch (error) {
      return this.markReviewReplyOutboxUnreadable(task, error);
    }
    const loop = task.summary.delivery?.loop;
    if (loop?.kind === "review" && delivered.length) {
      // replied_ids 描述“当前仍未解决的讨论里哪些已回复”，不是无限历史。
      // 检视人解决一条后，旧 outbox 的 delivered 事实仍保留审计，但不能
      // 把已离场 id 重新塞回当前集合，否则 d-b 与 d-a,d-b 永远不相等，
      // 下一拍会误判“处理过仍没答完”而停环。
      const current = new Set(loop.review_ids?.split(",").filter(Boolean) ?? []);
      const existing = (loop.replied_ids?.split(",").filter(Boolean) ?? [])
        .filter((id) => current.has(id));
      const next = [...new Set([...existing,
        ...delivered.filter((id) => current.has(id))])]
        .sort().join(",");
      const normalizedNext = next || undefined;
      if (normalizedNext !== loop.replied_ids) {
        loop.replied_ids = normalizedNext;
        this.persist(task);
      }
    }
    const stalled = task.summary.delivery?.stalled;
    if (stalled?.startsWith("检视回复投递账不可读")) {
      delete task.summary.delivery!.stalled;
      if (task.summary.delivery?.waiting_on === stalled) {
        task.summary.delivery.waiting_on = undefined;
      }
      if (task.summary.detail === stalled) {
        task.summary.detail = task.summary.status === "await_merge"
          ? "检视回复投递账已恢复，继续等待 MR 检视与合入"
          : "检视回复投递账已恢复，继续交付验证";
      }
      this.persist(task);
    }
    return true;
  }

  /** 流水线证据口:终态时把平台事实(sha/status/可选 checks/来源)写成文件喂给
   * 内核仓的 `pipeline record`,内核绑工作区当前 HEAD 裁决并把结论写
   * 进 .mae-flow.json 的 quality.external_verification——判定一行不在
   * 本仓(红线:内核唯一权威;宿主只递事实)。delivery.attested 是那份
   * 现场记录的镜像戳。30s 预算；登记失败返回 undefined，总体绿灯
   * 必须 fail-closed 留在 verifying，红灯仍可进入轻量修复环。 */
  private async recordPipelineEvidence(
    task: TaskState,
    sha: string,
    status: "success" | "failed",
    checks: PipelineCheck[] | undefined,
  ): Promise<PipelineAttestation | undefined> {
    const kernelRoot = this.options.host?.kernelRoot;
    const delivery = task.summary.delivery;
    if (!kernelRoot || !task.cwd || !delivery) return undefined;
    const factsPath = join(task.summary.workspace, "pipeline-facts.json");
    try {
      writeFileSync(factsPath, JSON.stringify({
        sha,
        status,
        ...(checks !== undefined ? { checks } : {}),
        ...(delivery.git_push ? { git_push: delivery.git_push } : {}),
        source: this.effectivePlatformUrl() ?? "",
        url: delivery.mr_url ?? "",
      }, null, 2));
      const gitView = createSafeGitView(task.cwd);
      const result = await new Promise<
        { code: number | null; out: string; err: string }>(
        (resolve) => {
          const child = spawn(this.options.host!.python ?? "python3",
            [join(kernelRoot, "scripts", "mae-flow.py"),
             "pipeline", "record", "--file", factsPath],
            {
              cwd: task.cwd!,
              stdio: ["ignore", "pipe", "pipe"],
              env: gitView.environment(),
            });
          let out = "";
          let err = "";
          child.stdout.setEncoding("utf-8");
          child.stderr.setEncoding("utf-8");
          child.stdout.on("data", (chunk: string) => (out += chunk));
          child.stderr.on("data", (chunk: string) => (err += chunk));
          const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
          timer.unref();
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, out, err });
          });
          child.on("error", () => {
            clearTimeout(timer);
            resolve({ code: null, out, err });
          });
        }).finally(() => gitView.cleanup());
      // 内核约定:末行是机器可读的裁决 JSON(quality.pipeline 原文)。
      const lastLine = result.out.trim().split("\n").at(-1) ?? "";
      let record: Record<string, unknown> | undefined;
      try {
        record = JSON.parse(lastLine);
      } catch {
        record = undefined;
      }
      if (result.code === 0 && typeof record?.verdict === "string") {
        delivery.attested =
          `${record.verdict}@${String(record.sha ?? sha).slice(0, 12)}`;
        return {
          verdict: record.verdict,
          sha: typeof record.sha === "string" ? record.sha : sha,
          reason: typeof record.reason === "string" ? record.reason : undefined,
          checks: record.checks && typeof record.checks === "object"
            ? record.checks as Record<string, unknown> : undefined,
        };
      } else {
        delivery.attested = "未裁决(内核登记失败,详见服务日志)";
        this.options.log?.(
          `任务 ${task.summary.id} 流水线证据登记失败(code `
          + `${result.code ?? "spawn-error"}): ${result.out.slice(0, 300)} `
          + result.err.slice(0, 300));
      }
    } catch (error) {
      delivery.attested = "未裁决(登记异常,详见服务日志)";
      this.options.log?.(
        `任务 ${task.summary.id} 流水线证据登记异常: ${String(error)}`);
    }
    return undefined;
  }

  /** 批2 落盘通道:拉平台的失败材料镜像到工作区外 pipeline/。
   * 每轮先清空内容再重下(给 agent 的必须是最新一轮),但绝不删除
   * pipeline 根目录——它是运行中 Coding 容器的只读 bind 源；替换根
   * 目录会让容器继续看到旧 inode。平台不支持(404)或失败回空数组,
   * 修复照走摘要通道。 */
  private async mirrorPipelineArtifacts(task: TaskState): Promise<string[]> {
    const platformUrl = this.effectivePlatformUrl();
    const sha = task.summary.delivery?.sha;
    if (!platformUrl || !sha) return [];
    try {
      const repo = encodeURIComponent(
        task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "");
      // artifacts 编排器是 MR-first，第四参契约是完整 MR URL（SSE 的
      // query_mr_info 直接消费它），不是 status 主路使用的 MR iid。
      const mrUrl = task.summary.delivery?.mr_url;
      const response = await fetch(
        `${platformUrl}/pipeline/artifacts?sha=${sha}&repo=${repo}`
        + (mrUrl
          ? `&mr=${encodeURIComponent(mrUrl)}` : ""),
        { headers: this.platformIdentity(task) });
      if (response.status === 404) return [];
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await readJson(response);
      const files = (Array.isArray(body.files) ? body.files : [])
        .filter((file: any) => typeof file?.name === "string"
          && typeof file?.text === "string");
      const dir = join(task.summary.workspace, "pipeline");
      mkdirSync(dir, { recursive: true });
      for (const entry of readdirSync(dir)) {
        rmSync(join(dir, entry), { recursive: true, force: true });
      }
      // 成功查询但本轮没有材料，也必须把上一轮清空；否则修复会话会
      // 在稳定挂载里读到旧 SHA 的日志，按错误现场继续改代码。
      if (!files.length) return [];
      const written: string[] = [];
      for (const file of files) {
        // 路径穿越防线:文件名只留基名,别让平台字段写出目录外。
        const name = basename(String(file.name));
        if (!name || name === "." || name === "..") continue;
        const target = join(dir, name);
        const temporary = join(
          dir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
        writeFileSync(temporary, String(file.text).slice(0, 512 * 1024), {
          mode: 0o444,
          flag: "wx",
        });
        renameSync(temporary, target);
        written.push(name);
      }
      return written;
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 流水线材料镜像失败(走摘要通道): `
        + String(error));
      return [];
    }
  }

  private async fetchDiscussions(task: TaskState): Promise<DiscussionItem[]> {
    const platformUrl = this.effectivePlatformUrl();
    const delivery = task.summary.delivery;
    if (!platformUrl || !delivery) return [];
    try {
      const params = new URLSearchParams({
        repo: task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "",
      });
      if (delivery.mr_id !== undefined) {
        params.set("mr", String(delivery.mr_id));
      }
      const response = await fetch(
        `${platformUrl}/mr/discussions?${params}`,
        { headers: this.platformIdentity(task) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await readJson(response);
      return (Array.isArray(body.discussions) ? body.discussions : [])
        .filter((item: any) => typeof item?.id === "string" && item.id);
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 检视讨论拉取失败: ${String(error)}`);
      return [];
    }
  }

  /** 修复派单的共同尾巴:使命上膛、任务重排队,setImmediate 避开
   * settle 链上的状态竞态(同 dispatchCiRepair 里那条注释)。 */
  private enqueueRepair(
    task: TaskState,
    mission: string,
    detail: string,
  ): void {
    task.mission = mission;
    task.summary.status = "queued";
    task.summary.detail = detail;
    task.resume = true;
    this.persist(task);
    this.queue.push(task.summary.id);
    setImmediate(() => this.bypass(undefined, "任务泵", this.pump()));
  }

  private moonlightEnabledFor(task: TaskState, force = false): boolean {
    if (task.summary.approval_mode === "manual") return false;
    if (task.summary.approval_mode === "moonlight") return true;
    if (force) return true;
    return this.options.moonlight?.(task.summary.luban_account) ?? false;
  }

  /** 人工节点的"现成答案":有则自动交卷,没有才真等人。两个来源:
   * - **下单预选(交付方式)**:内核仍举卡(流程规则归内核,宿主不删
   *   它的问题),但答案用户下单时已给——卡上出现了用户选定的那个
   *   **内核选项**就把它交上去。这是送达用户早给的答案,不是宿主代做
   *   判断;对不上就退回真等人,fail-open 到人工;
   * - **月光模式**:用户显式开启免审批,其余问题一律代答"预授权放行,
   *   按最稳妥判断继续,理由写明供复盘"。
   * 混合卡(既有交付方式又有别的问题)只在月光开着时整卡交,否则等人。 */
  private autoAnswerFor(task: TaskState, forceMoonlight = false): {
    why: string;
    answers: Record<string, string>;
    notes: string;
  } | undefined {
    const waiting = task.summary.waiting;
    const questions = ((waiting?.question as any)?.questions ?? []) as Array<{
      question?: string;
      options?: string[];
    }>;
    if (!waiting || questions.length === 0) return undefined;
    // push 前确认卡是用户**显式开启**的"我要亲自看一眼",月光免审批
    // 不得代答它——两者都是用户意志,更具体的那个赢。
    if (waiting.step === CLOUD_PUSH_CONFIRM_STEP) return undefined;
    // 分析单已确认拆单完毕,父会话再举的任何卡都不该到人(内网实锤:
    // task-5 确认后模型"好心"又举卡让人检视 task-6 的事——子任务有
    // 自己的检视闸,父单的活到确认就结束了)。整卡代答,催它收尾。
    const graph = task.summary.requirement_graph;
    if (this.isRequirementAnalysis(task) && graph?.stage === "confirmed"
        && graph.repositories.every((repository) => repository.task_id)) {
      const answers: Record<string, string> = {};
      for (const item of questions) {
        answers[String(item.question ?? "")] = item.options?.[0]
          ?? "跨仓方案已确认，各仓交付任务已生成；分析会话请收尾结束。";
      }
      return {
        why: "分析单已确认拆单,父会话不再举卡",
        answers,
        notes: "系统自动交卷(分析已确认,子任务各有检视闸),非人工答复",
      };
    }
    const moonlight = this.moonlightEnabledFor(task, forceMoonlight);
    const hasUnresolvedAnnotations = this.unresolvedAnnotations(task).length > 0;
    const contractStep = this.reviewContractStep(task, waiting);
    const effects = stepChoiceEffects(
      this.options.host?.kernelRoot,
      contractStep,
    );
    // review 修复轮的下单事实已经切成内核定义的 review 选项，预答也
    // 必须认同一份事实。继续拿原单“完整开发”去匹配，会让新轮卡在
    // 交付方式选择上，形成“用户明明提交了检视意见又被问一遍”。
    const reviewLane = this.reviewRoundLane(task);
    const lane = reviewLane || task.summary.lane;
    const localReviewConfig = contractStep === "config_confirm"
      && task.summary.delivery?.loop?.kind === "review"
      && task.summary.delivery.loop.review_source === "workspace"
      && task.summary.delivery.loop.state === "repairing";
    const reasons = new Set<string>();
    const answers: Record<string, string> = {};
    for (const item of questions) {
      const text = String(item.question ?? "");
      // 认卡不靠问题措辞,靠**选项**:内核举的卡里出现了用户下单时选
      // 的那一项,就是这张卡在问交付方式。此前按"车道"二字匹配,而内核
      // 的问题里根本没有这两个字(它问"交付方式?"),于是预选形同虚设
      // ——措辞是内核的自由,选项才是双方共用的语言。
      const preselected = lane
        ? (item.options ?? []).find((option) => option === lane
            || option.includes(lane))
        : undefined;
      if (preselected) {
        answers[text] = preselected;
        reasons.add(`下单预选交付方式:${lane}`);
      } else if (localReviewConfig) {
        // 工作台提交已经授权“继续修改当前 MR”，新 review 轮又完整沿用
        // 原单号/分支/需求事实，因此配置卡只是在重复确认同一份事实。
        // 只命中明确的肯定选项；形状漂移就退回人，不猜。
        const confirmed = (item.options ?? []).find((option) =>
          /确认.*(?:配置|以上)|配置.*(?:正确|无误)|全部.*(?:正确|无误)/
            .test(option)
          && !/修改|调整|错误|不正确|有误/.test(option));
        if (!confirmed) {
          this.options.log?.(
            `任务 ${task.summary.id} 本地检视轮配置卡缺少明确确认选项，退回人工`);
          return undefined;
        }
        answers[text] = confirmed;
        reasons.add("本地检视沿用原单已确认配置");
      } else if (moonlight) {
        // 有检视意见时绝不自动放行；开放题也必须由人明确填写。月光只
        // 能提交真实选项，不能再拿一段自由文本冒充内核分支值。
        if (hasUnresolvedAnnotations || !(item.options?.length)) {
          return undefined;
        }
        const closing = effects.filter((effect) => effect.closesFeedback);
        const chosen = item.options.find((option) => closing.some((effect) =>
          matchesStepChoice(effect, option)))
          ?? item.options.find((option) =>
            /通过|确认|同意|接受|批准|继续|无需|无须/.test(option)
            && !/不通过|打回|退回|拒绝|修改|调整|返工/.test(option));
        if (!chosen) {
          // 兜底选第一项曾在这里:选项顺序一变就可能替人选中"打回"
          // 之类的反向分支(2026-08-30 审计)。月光只代答认得出的
          // "通过"类选项;认不出=形状漂移,整卡退回人,不猜。
          this.options.log?.(
            `任务 ${task.summary.id} 月光模式认不出明确的通过类选项`
            + `(${(item.options ?? []).join("/")}),整卡退回等人`);
          return undefined;
        }
        answers[text] = chosen;
        reasons.add(`月光模式选择:${chosen}`);
      } else {
        // 答不上,整卡留给人。但有一种"答不上"必须留明账:问题**正文**
        // 里带着用户选的交付方式,选项里却没有——十有八九是模型自造了
        // "是否选择局部修改?"式的是/否卡(内网实测)。宿主不替内核判
        // 是/否算不算数,但要把"预答为什么没接住"写清楚,不然现场只看到
        // "又在等人",查不到为什么。
        if (lane && text.includes(lane)) {
          this.options.log?.(
            `任务 ${task.summary.id} 交付方式卡不是标准形状:问题提到`
            + `「${lane}」但选项(${(item.options ?? []).join("/")})里没有`
            + `它,预答无法命中,退回等人——多半是模型自造了是/否确认卡`);
        }
        return undefined; // 有答不上的问题,整卡留给人
      }
    }
    return {
      why: [...reasons].join(" + "),
      answers,
      notes: `系统自动交卷(${[...reasons].join(";")}),非人工现场答复；`
        + "已提交结构化选项，供事后人工复盘",
    };
  }

  /** 自动交卷:走人工决定同一条通路(decide),内核台账、事件、
   * 竞态语义一字不差;人若抢先答了(409/状态翻篇)就当没发生。 */
  private async autoDecide(
    task: TaskState,
    auto: { answers: Record<string, string>; notes: string },
  ): Promise<void> {
    const waiting = task.summary.waiting;
    if (task.summary.status !== "waiting_for_human" || !waiting) return;
    try {
      const questions = (((waiting.question as any)?.questions ?? []) as Array<{
        question?: string;
        options?: string[];
      }>);
      const selectedOptions: Record<string, string> = {};
      const freeResponses: Record<string, string> = {};
      for (const question of questions) {
        const key = String(question.question ?? "");
        const answer = auto.answers[key];
        if (!answer) continue;
        if (question.options?.includes(answer)) selectedOptions[key] = answer;
        else freeResponses[key] = answer;
      }
      await this.decide(task.summary.id, {
        state_version: waiting.state_version,
        selected_options: selectedOptions,
        free_responses: freeResponses,
        comment: auto.notes,
      });
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 自动交卷未生效(可能人已答): ${String(error)}`);
    }
  }

  previewMoonlight(account: string): {
    waiting: number;
    eligible: number;
    blocked_annotations: number;
    blocked_other: number;
  } {
    let waiting = 0;
    let eligible = 0;
    let blockedAnnotations = 0;
    for (const task of this.tasks.values()) {
      if (task.summary.status !== "waiting_for_human"
          || task.summary.luban_account !== account) continue;
      waiting += 1;
      if (this.unresolvedAnnotations(task).length) {
        blockedAnnotations += 1;
        continue;
      }
      if (this.autoAnswerFor(task, true)) eligible += 1;
    }
    return {
      waiting,
      eligible,
      blocked_annotations: blockedAnnotations,
      blocked_other: waiting - eligible - blockedAnnotations,
    };
  }

  /** push 前人工确认开关。普通确认可关闭；人工意见触发的复检属于
   * 意见闭环，不是偏好开关，不能靠关开关绕过。 */
  setPushConfirmation(id: string, on: boolean): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const status = task.summary.status;
    if (on && ["await_merge", "completed", "failed", "canceled"]
      .includes(status)) {
      throw new TaskControlError(
        `任务已${status === "await_merge" ? "推送" : "收口"},push 前确认点已经过去`);
    }
    const loop = task.summary.delivery?.loop;
    if (!on && loop?.review_source === "workspace"
        && loop.workspace_review_recheck_required) {
      throw new TaskControlError(
        "本轮修改来自人工检视意见，必须完成复检后才能推送；不能关闭确认绕过。",
      );
    }
    task.summary.push_confirmation = on || undefined;
    const waiting = task.summary.waiting;
    if (!on && waiting?.step === CLOUD_PUSH_CONFIRM_STEP) {
      task.humanGate.supersede(waiting.waiting_id, {
        stateVersion: waiting.state_version,
        notes: "用户关闭 push 前确认,卡作废,继续推送",
      });
      task.summary.waiting = undefined;
      if (task.summary.delivery) delete task.summary.delivery.push_review;
      task.summary.status = "verifying";
      task.summary.detail = "已关闭 push 前确认,继续推送";
      this.bypass(task, "关闭确认续推",
        this.tryDeliver(task, task.controlEpoch));
    }
    this.persist(task);
    return { ...task.summary };
  }

  setTaskApprovalMode(
    id: string,
    mode: "inherit" | "manual" | "moonlight",
    includeCurrent = false,
  ): { task: TaskSummary; swept: number; blocked_annotations: number } {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    task.summary.approval_mode = mode === "inherit" ? undefined : mode;
    this.persist(task);
    const blockedAnnotations = this.unresolvedAnnotations(task).length;
    let swept = 0;
    if (mode === "moonlight" && includeCurrent
        && task.summary.status === "waiting_for_human"
        && !blockedAnnotations) {
      const auto = this.autoAnswerFor(task);
      if (auto) {
        swept = 1;
        void this.autoDecide(task, auto);
      }
    }
    return {
      task: { ...task.summary },
      swept,
      blocked_annotations: blockedAnnotations,
    };
  }

  /** 仅在调用方明确选择“同时处理当前待办”后清场。默认启用月光模式
   * 不会调用这里，因此只影响后续节点。 */
  sweepMoonlight(account: string): number {
    let swept = 0;
    for (const task of this.tasks.values()) {
      if (task.summary.status !== "waiting_for_human") continue;
      if (task.summary.luban_account !== account) continue;
      const auto = this.autoAnswerFor(task);
      if (auto) {
        swept += 1;
        void this.autoDecide(task, auto);
      }
    }
    return swept;
  }

  /** 待办 → 小鲁班。投递失败不改流程状态;结果回填 summary.notify
   * 供页面标红。未配置通知器或未填账号时静默跳过(演示模式)。 */
  private notifyWaiting(task: TaskState): void {
    const { notifier } = this.options;
    const waiting = task.summary.waiting;
    const account = task.summary.luban_account;
    if (!notifier || !waiting || !account) return;
    const questions =
      ((waiting.question as any)?.questions ?? []) as Array<{
        question?: string;
        options?: string[];
      }>;
    this.bypass(task, "待办通知", notifier
      .notifyWaiting({
        waitingId: waiting.waiting_id,
        stateVersion: waiting.state_version,
        taskId: task.summary.id,
        subject: task.summary.title ?? task.summary.requirement,
        account,
        step: waiting.step,
        context: waiting.context,
        questions: questions.map((item): NotifyQuestion => ({
          question: String(item.question ?? ""),
          options: Array.isArray(item.options) ? item.options.map(String) : [],
        })),
        summary: "需要你确认",
        link: personalTaskLink(
          this.notificationLinkBase(),
          account,
          task.summary.id,
        ),
      })
      .then((record) => {
        task.notifyRecord = record;
        // 投递结果(尤其"没送到")要活过重启:不落盘的话,重启后页面
        // 红旗消失,"通知失败"从可见事实变成不可见事实(2026-08-29
        // 部署审计实锤)。写盘失败由 writeTaskState 自己记日志,纯旁路。
        this.writeTaskState(task);
      }));
  }

  /** Host Git 动作使用的短生命周期 helper。目录/脚本仅活在一次
   * clone 或 push 的受控调用窗口，绝不进入 agentDir，也不写进仓库
   * config；调用方必须 finally cleanupHostGitCredential。 */
  private prepareHostGitCredential(
    credential: { username: string; password: string },
  ): { dir: string; helper: string } {
    // 可执行 helper 不能放系统 /tmp：生产宿主通常将 /tmp 挂成 noexec。
    // 使用 Cloud 数据目录下 0700 的控制面运行目录，仍与任务工作区隔离。
    const dir = this.createHostGitRuntimeDirectory();
    chmodSync(dir, 0o700);
    const file = join(dir, "credential");
    writeFileSync(file,
      `username=${credential.username}\npassword=${credential.password}\n`);
    chmodSync(file, 0o600);
    const script = join(dir, "helper.sh");
    writeFileSync(script, [
      "#!/bin/sh",
      'if [ "$1" = "get" ]; then',
      '  cat "$(dirname "$0")/credential"',
      "fi",
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(script, 0o700);
    return { dir, helper: script };
  }

  private cleanupHostGitCredential(
    prepared: { dir: string } | undefined,
  ): void {
    if (!prepared) return;
    try {
      rmSync(prepared.dir, { recursive: true, force: true });
    } catch (error) {
      this.options.log?.(
        `临时 Git 凭据目录清理失败 ${prepared.dir}: ${String(error)}`);
    }
  }

  /** Host push/ls-remote 不得继承 Agent 可写的仓库配置或部署机用户配置。
   *
   * 工作区里的 .git/config、hooks、origin 都属于不可信输入：Agent 为了
   * 正常开发必须能写它们，但宿主传输不能因此执行 hook、credential
   * helper、ext remote helper，或被 url.*.insteadOf 改道。这里给一次
   * 交付动作建全新的 HOME/全局配置/askpass 边界；真正的 push 还会从
   * 一个临时 bare 仓发起，从物理上不读取工作区 .git/config。 */
  private prepareHostGitSandbox(
    credential: { username: string; password: string } | undefined,
  ): {
    dir: string;
    helper?: string;
    args: string[];
    env: NodeJS.ProcessEnv;
  } {
    const prepared = credential
      ? this.prepareHostGitCredential(credential) : undefined;
    const dir = prepared?.dir ?? this.createHostGitRuntimeDirectory();
    chmodSync(dir, 0o700);
    const home = join(dir, "home");
    const xdg = join(dir, "xdg");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(xdg, { mode: 0o700 });
    const globalConfig = join(dir, "global.gitconfig");
    const systemConfig = join(dir, "system.gitconfig");
    writeFileSync(globalConfig, "");
    writeFileSync(systemConfig, "");
    chmodSync(globalConfig, 0o600);
    chmodSync(systemConfig, 0o600);
    const askpass = join(dir, "reject-askpass.sh");
    writeFileSync(askpass, "#!/bin/sh\nexit 1\n");
    chmodSync(askpass, 0o700);

    const env: NodeJS.ProcessEnv = { ...process.env };
    // Git 的环境配置注入优先级高于文件配置。部署进程若意外带了这些
    // 变量，不能让它们越过下面的 -c 硬边界；工作区定位类变量同理。
    for (const key of Object.keys(env)) {
      if (/^GIT_CONFIG$/i.test(key)
          || /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/i.test(key)
          || /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GIT_SSH|GIT_SSH_COMMAND|GIT_PROXY_COMMAND)$/i.test(key)) {
        delete env[key];
      }
    }
    Object.assign(env, {
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: systemConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: askpass,
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: "never",
      GCM_INTERACTIVE: "Never",
    });
    const args = [
      "-c", "core.hooksPath=/dev/null",
      "-c", "protocol.ext.allow=never",
      // 空项先清除任何低优先级 helper；个人令牌只交给本次临时 helper。
      "-c", "credential.helper=",
      ...(prepared ? ["-c", `credential.helper=${prepared.helper}`] : []),
    ];
    return { dir, helper: prepared?.helper, args, env };
  }

  /** 一次 Host Git 动作一个私有目录。拒绝符号链接，防止控制面 helper
   * 被 Agent 或同机用户引到任务工作区；操作结束仍由既有 cleanup 删除。 */
  private createHostGitRuntimeDirectory(): string {
    const configuredDataRoot = resolve(this.options.dataDir);
    mkdirSync(configuredDataRoot, { recursive: true });
    const dataRoot = realpathSync(configuredDataRoot);
    const runtime = join(dataRoot, ".runtime");
    const gitRoot = join(runtime, "host-git");
    for (const directory of [runtime, gitRoot]) {
      if (existsSync(directory)) {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`Host Git 运行目录不是可信普通目录: ${directory}`);
        }
      } else {
        mkdirSync(directory, { mode: 0o700 });
      }
      chmodSync(directory, 0o700);
      const actual = realpathSync(directory);
      if (actual !== directory
          || !(actual === dataRoot || actual.startsWith(`${dataRoot}/`))) {
        throw new Error(`Host Git 运行目录越出 Cloud 数据目录: ${directory}`);
      }
    }
    const operation = mkdtempSync(join(gitRoot, "operation-"));
    chmodSync(operation, 0o700);
    return operation;
  }

  /** 把 Coding Agent / 中心能力服务注入目录登记为当前 clone 的本地
   * 运行资产。只写 .git/info/exclude，不改业务仓 .gitignore；仓库原本
   * 已跟踪的 Skill 不受 exclude 影响，仍可按目录发现与读取。 */
  private registerAgentPlatformLocalExcludes(
    cwd: string,
    deliveryExcludedPaths: string[] = [],
  ): void {
    try {
      const view = createSafeGitView(cwd);
      const gitDir = view.repositoryGitDir;
      view.cleanup();
      const infoDir = join(gitDir, "info");
      if (!existsSync(infoDir)) mkdirSync(infoDir, { mode: 0o700 });
      const info = lstatSync(infoDir);
      if (!info.isDirectory() || info.isSymbolicLink()
          || realpathSync(infoDir) !== infoDir) {
        throw new Error("Git info 目录不是任务仓内的真实目录");
      }
      const excludePath = join(infoDir, "exclude");
      if (existsSync(excludePath)) {
        const exclude = lstatSync(excludePath);
        if (!exclude.isFile() || exclude.isSymbolicLink()
            || realpathSync(excludePath) !== excludePath) {
          throw new Error("Git 本地排除文件不是普通文件");
        }
      }
      const current = existsSync(excludePath)
        ? readFileSync(excludePath, "utf-8") : "";
      const lines = new Set(current.split("\n").map((line) => line.trim()));
      const deliveryExcludes = normalizedDeliveryPaths(deliveryExcludedPaths)
        .map((path) => `/${path}`);
      const missing = [
        ...AGENT_PLATFORM_LOCAL_EXCLUDES,
        "docs/req/",
        ...deliveryExcludes,
      ]
        .filter((entry) => !lines.has(entry));
      if (!missing.length) return;
      writeFileSync(excludePath,
        `${current}${current && !current.endsWith("\n") ? "\n" : ""}`
        + "# mae-flow: local assets excluded from this delivery\n"
        + missing.join("\n") + "\n");
    } catch (error) {
      // 本地 ignore 是第一道减噪，不是唯一安全边界；push 前提交历史
      // 仍会硬校验。这里说清楚但不阻塞任务启动。
      this.options.log?.(
        `[git-exclude] Agent 平台目录登记失败(推送硬闸仍生效): ${String(error)}`);
    }
  }

  /** 新任务和旧任务恢复都执行：清掉历史版本留在 agentDir / repo config
   * 的 helper，并把 origin pushurl 改成必失败地址。Agent 可以读写/提交，
   * 但拿不到凭据也无法传输；宿主 push 使用显式干净 URL，不走 pushurl。 */
  private hardenAgentGitBoundary(agentDir: string, cwd?: string): void {
    for (const name of ["git-credential", "git-credential.sh"]) {
      rmSync(join(agentDir, name), { force: true });
    }
    if (!cwd || !existsSync(join(cwd, ".git"))) return;
    const view = createSafeGitView(cwd);
    const configPath = join(view.repositoryGitDir, "config");
    view.cleanup();
    const configInfo = lstatSync(configPath);
    if (!configInfo.isFile() || configInfo.isSymbolicLink()
        || realpathSync(configPath) !== configPath) {
      throw new Error("Git config 不是任务仓内的普通文件，拒绝宿主改写");
    }
    // `git config --file` 不做仓库发现，也不读取 include；相比 --local /
    // `git remote`，不会触发 Agent 写入的 fsmonitor/filter/url.* 配置。
    const config = (...args: string[]) => spawnSync(
      "git", ["config", "--file", configPath, ...args], {
        encoding: "utf-8",
        env: safeGitEnvironment(),
      });
    config("--unset-all", "credential.helper");
    // clone 会照录带 userinfo 的 URL；即便部署误把 token 写进 repo_url，
    // 也必须在 Agent 进入前从 repo config 擦掉。
    const origin = config("--get", "remote.origin.url");
    const rawOrigin = String(origin.stdout ?? "").trim();
    if (origin.status === 0 && rawOrigin) {
      const cleanOrigin = this.cleanRemoteUrl(rawOrigin);
      if (cleanOrigin !== rawOrigin) {
        config("--replace-all", "remote.origin.url", cleanOrigin);
      }
    }
    const existingPush = config("--get-all", "remote.origin.pushurl");
    // 跨仓分析克隆已有更强的只读标记；不能用“宿主可推”的普通执行
    // 标记覆盖它。两者都指向 /dev/null，但语义必须保留下来供恢复和
    // 部署自检区分。
    if (!String(existingPush.stdout ?? "").includes("mae-flow-readonly")) {
      config("--replace-all", "remote.origin.pushurl",
        "/dev/null/mae-flow-host-owned");
    }
    this.registerAgentPlatformLocalExcludes(cwd);
  }

  private cleanRemoteUrl(raw: string): string {
    try {
      const parsed = new URL(raw);
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    } catch {
      return raw;
    }
  }

  /** Agent 会话已释放后由宿主完成唯一一次传输，并立刻从远端反查 SHA。
   * 返回值既是 TaskSummary 现场，也是 `pipeline record` 的内核收据。 */
  private async pushFromHost(
    task: TaskState,
    branch: string,
    expectedSha?: string,
  ): Promise<GitPushReceipt> {
    if (task.driver) {
      throw new Error("安全拒绝：Agent 会话仍在，不能执行宿主 Git 推送");
    }
    if (!task.cwd) throw new Error("任务没有代码工作区，不能推送");
    const deliverySnapshot = await deliveryChangeSnapshot(task.cwd);
    if (deliverySnapshot?.added_agent_platform_paths.length) {
      throw new Error(
        "安全拒绝：待推送提交历史包含 Agent 平台本地目录 "
        + describeDirtyPaths(deliverySnapshot.added_agent_platform_paths));
    }
    // 交付目标是下单/部署事实，不是 Agent 可改的 remote.origin.url。
    // 无 scheme 的本地演示仓按服务进程 cwd 解析，避免切到临时 bare 仓
    // 后相对路径含义漂移。
    const configuredRemote = task.summary.repo_url
      ?? this.effectiveDefaultRepo();
    if (!configuredRemote) throw new Error("任务没有权威代码仓地址，拒绝推送");
    validateRepositoryAddress(configuredRemote);
    // Windows 盘符路径(C:\…)长得像 "scheme:" 会撞上下面的协议白名单
    // 正则——先按本地路径放行(2026-08-25 开发者模式通了 symlink 后,
    // 本机 Windows 首次真跑宿主推送时在这里被误杀)。
    const windowsDrive = /^[a-z]:[\\/]/i.test(configuredRemote);
    if (!windowsDrive
        && /^[a-z][a-z\d+.-]*:/i.test(configuredRemote)
        && !/^(?:https?|file):\/\//i.test(configuredRemote)) {
      throw new Error("代码仓传输协议不受支持，宿主只允许 HTTPS 或本地仓");
    }
    const remoteUrl = /^(?:https?|file):\/\//i.test(configuredRemote)
      ? configuredRemote : resolve(configuredRemote);
    const credential = this.options.gitCredential?.(
      task.summary.luban_account);
    const sandbox = this.prepareHostGitSandbox(credential);
    let gitView: ReturnType<typeof createSafeGitView> | undefined;
    const ref = `refs/heads/${branch}`;
    try {
      gitView = createSafeGitView(task.cwd);
      const transportGit = (
        args: string[], extraEnv?: NodeJS.ProcessEnv,
      ) => runGitProcess([...sandbox.args, ...args], {
          timeoutMs: 30_000,
          env: { ...sandbox.env, ...extraEnv },
        });
      const worktreeGit = (args: string[]) => runGitProcess(
        [...sandbox.args, ...args], {
          cwd: task.cwd,
          timeoutMs: 30_000,
          env: gitView!.environment(sandbox.env),
        });
      const checked = await transportGit(["check-ref-format", "--branch", branch]);
      if (checked.status !== 0) {
        throw new Error(`分支名不合法，拒绝推送: ${branch}`);
      }
      // 只从工作区读取要交付的对象/HEAD；传输在新建 bare 仓中进行，
      // 因而工作区 hooks、origin、url.*、protocol.*、helper 全部不生效。
      const head = await worktreeGit(["rev-parse", "--verify", "HEAD"]);
      const sha = String(head.stdout ?? "").trim();
      if (head.status !== 0 || !sha) {
        throw new Error(`读取待推送 HEAD 失败: ${String(head.stderr ?? "")}`);
      }
      if (expectedSha && sha !== expectedSha) {
        throw new Error(
          `安全拒绝：待推送 HEAD 已从已验证的 ${expectedSha.slice(0, 12)}`
          + ` 变为 ${sha.slice(0, 12)}，旧确认不可复用`);
      }
      const objects = gitView.objectDirectory;
      const staging = join(sandbox.dir, "transport.git");
      const initialized = await transportGit(["init", "--quiet", "--bare", staging]);
      if (initialized.status !== 0) {
        throw new Error(`创建宿主传输仓失败: ${String(initialized.stderr ?? "")}`);
      }
      const objectEnv = { GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
      const objectCheck = await transportGit([
        `--git-dir=${staging}`, "cat-file", "-e", `${sha}^{commit}`,
      ], objectEnv);
      if (objectCheck.status !== 0) {
        throw new Error("待推送 HEAD 不是可读取的提交对象");
      }
      const pushed = await runGitProcess([
        ...sandbox.args, `--git-dir=${staging}`, "push", "--no-verify",
        "--porcelain", remoteUrl, `${sha}:${ref}`,
      ], {
        timeoutMs: 5 * 60_000,
        env: { ...sandbox.env, ...objectEnv },
      });
      if (pushed.status !== 0) {
        const stderrText = pushed.timedOut
          ? "超过 5 分钟，已终止 git/ssh 进程组"
          : String(pushed.stderr || pushed.stdout || pushed.error);
        throw new Error(`宿主推送失败: ${stderrText}`);
      }
      const verified = await runGitProcess([
        ...sandbox.args, `--git-dir=${staging}`,
        "ls-remote", "--heads", remoteUrl, ref,
      ], {
        timeoutMs: 60_000,
        env: sandbox.env,
      });
      const remoteSha = String(verified.stdout ?? "").trim().split(/\s+/)[0];
      if (verified.status !== 0 || remoteSha !== sha) {
        throw new Error(
          `远端 SHA 复核失败: 本地 ${sha.slice(0, 12)}，远端 `
          + `${remoteSha ? remoteSha.slice(0, 12) : "缺失"}`);
      }
      return {
        sha, ref, remote: "origin", url: this.cleanRemoteUrl(remoteUrl),
      };
    } finally {
      gitView?.cleanup();
      this.cleanupHostGitCredential(sandbox);
    }
  }

  private requirementAnalysisPrompt(
    task: TaskState,
    cwd: string,
    requirementPath?: string,
  ): string {
    const ticket = task.summary.ticket ?? task.summary.id;
    const repositories = (task.summary.repositories ?? []).map((url, index) => {
      const path = join(cwd,
        `${index + 1}-${basename(url).replace(/\.git$/, "") || "repo"}`);
      return `- repo-${index + 1} | ${url} | ${path}`;
    }).join("\n");
    const artifactDir = join(cwd, ".mae-flow-work", ticket);
    return [
      `需求原文:\n${requirementContext(
        task.summary.requirement,
        task.summary.requirement_document,
        requirementPath,
      )}`,
      // 措辞纠偏:这是**平台的**跨仓分析前置阶段,不是内核流程——
      // 内核的交付流程(init/配置确认/门禁/MR)在确认后的各仓子任务里
      // 才开始,别让模型以为此刻该跑 mae-flow 命令。
      `你正在执行云端平台的跨仓需求分析(交付前置阶段):把一个需求在`
        + `${task.summary.repositories?.length ?? 0} 个仓库间的职责与依赖`
        + `理清楚,供人检视。注意:此阶段**不在 Mae-Flow 内核流程里**,`
        + `不要执行任何 mae-flow 命令;各仓的正式交付流程会在方案确认后`
        + `的独立任务中由内核主导。此阶段只读分析,禁止修改业务代码、`
        + `提交或启动交付;工作区已在 git 配置层禁用推送,push 必然失败。`,
      `仓库清单（ID | 原始地址 | 本地只读分析路径）:\n${repositories}`,
      "请亲自阅读各仓代码，从关键词、接口调用链、配置路由三条路径核查。"
        + "每个触点必须给出仓库、文件、符号、相关原因和置信度；"
        + "拿不准的事项使用 AskUserQuestion 逐题询问，不能猜。"
        + "逐题确认仓库职责、接口形态/字段/错误语义，以及依赖方向和可并行范围。",
      "只有全部不确定事项都已经逐题确认后，才能生成以下两份最终产物。",
      `把供人检视的完整方案写到 ${join(artifactDir, `CHAIN-${ticket}.md`)}。`
        + "正文必须包含需求理解、仓库职责、带证据触点、接口契约、"
        + "依赖关系与交付顺序、逐仓启动说明。依赖图使用 Mermaid。",
      `同时把机器可读投影写到 ${join(artifactDir, "requirement-graph.json")}，`
        + "格式严格为 "
        + `{"repositories":[{"id":"repo-1","name":"名称","url":"原始地址",`
        + `"responsibility":"职责"}],"dependencies":[{`
        + `"dependent":"repo-2","prerequisite":"repo-1",`
        + `"reason":"为什么 dependent 必须等待 prerequisite"}]}。`
        + "repositories 必须覆盖上方全部仓库且 url 原样照录；"
        + "dependencies 的语义必须是 dependent 依赖 prerequisite，"
        + "也就是 prerequisite 先开发、dependent 后开发；"
        + "只有确实不能并行的硬依赖才写，禁止循环依赖。",
      "方案写完后必须调用 AskUserQuestion，请用户选择「需要修改」或"
        + "「确认并生成任务」。用户选择需要修改时，结合随决定提交的批注"
        + "继续修订同一份方案，再次发起检视；确认前不得收尾。"
        + "用户确认后：各仓交付任务由平台自动生成与调度，**不归你跟进**"
        + "——写一段简短收尾说明后立即结束，禁止再调用 AskUserQuestion、"
        + "禁止替用户检视或跟进任何子任务。",
    ].join("\n\n");
  }

  private async cloneRepo(
    workspace: string,
    /** 带个人令牌时必须传加固沙箱(prepareHostGitSandbox),不能只给
     * helper 路径——见下面 useCredential 分支的注释。 */
    sandbox?: { helper?: string; args: string[]; env: NodeJS.ProcessEnv },
    identity?: { username: string; email?: string },
    repoUrl?: string,
    /** 下单时明确的代码基线。新克隆必须直接检出它，不能先落到远端
     * 默认分支再让后续流程纠正：仓内 Skill 会在内核 bootstrap 前
     * 物化，错一拍就会把“已选择”变成 digest 不符而静默跳过。 */
    baseline?: string,
    targetName?: string,
    /** 只读分析现场(多仓需求理解):克隆后在 git 配置层禁用推送。
     * 分析会话没有内核 preTool 门禁兜底,"禁止推送"不能只靠 prompt
     * 嘱咐——pushurl 指向不存在的路径 + 不登记 credential helper,
     * 模型真去 push 只会得到一个诚实的失败。 */
    readonly = false,
  ): Promise<string> {
    // 任务级仓(正式下单)> 部署 --repo(仅单仓试跑);都没有就如实失败，
    // 不猜一个仓出来。任务仓记在 summary，重启续跑仍使用同一地址。
    const source = repoUrl ?? this.effectiveDefaultRepo();
    if (!source) {
      throw new Error(
        "这单没有代码仓：请在发起任务时填写「交付代码仓」");
    }
    const checkoutBaseline = baseline?.trim() || undefined;
    if (checkoutBaseline && (checkoutBaseline.length > 255
        || checkoutBaseline.startsWith("-")
        || /[\0\r\n\s\\]/.test(checkoutBaseline))) {
      throw new Error(`基线分支格式不合法，无法克隆：${checkoutBaseline}`);
    }
    // 裸仓 origin.git → 工作区目录名去掉 .git 后缀,免得像个裸仓。
    const target = join(
      workspace, targetName ?? (basename(source).replace(/\.git$/, "") || "repo"));
    // 普通仓有 .git 子目录;裸仓自己就是 git 目录(HEAD+objects)。
    // 只认 .git 会把裸仓误判成普通目录,把仓库内脏拷贝成"工作区"(实测)。
    const isGit = existsSync(join(source, ".git"))
      || (existsSync(join(source, "HEAD"))
          && existsSync(join(source, "objects")));
    // 凭据只对 http(s) 远端有意义;本地路径克隆(演示/试跑)不掺和。
    const useCredential = !!sandbox?.helper && /^https?:\/\//i.test(source);
    if (isGit || /^(?:https?|ssh|git|file):\/\//i.test(source)) {
      // 空 helper 在前=清空继承的 helper 列表(系统钥匙串之流):
      // 个人令牌只从我们的脚本来,也不许被别的 helper 顺手存走
      // (git 会对列表里所有 helper 广播 store——实测令牌进过
      // macOS 钥匙串,测试负例因此假绿)。没有个人凭据时不动列表,
      // 部署机自己的服务账号 helper 照常工作。
      //
      // 带个人令牌时还必须走 push/ls-remote 同一套加固沙箱。理由是
      // 我们的 helper 是"问什么都答"的——它不看 git 传进来的 host。
      // 部署机 ~/.gitconfig 或 /etc/gitconfig 里一条
      // `url.<别处>.insteadOf` 就能把这次 clone 改道到另一台主机,
      // 而 helper 会照样把用户的个人 CodeHub 令牌交出去。沙箱把
      // HOME/全局/系统配置全部换成空的,改道的配置来源就不存在了;
      // 顺带关掉 ext 传输、仓库 hooks 与交互式 askpass。
      const hardened = useCredential ? sandbox! : undefined;
      // 异步 + 预算(2026-08-25 卡死事故的同病类):同步克隆内网大仓
      // 会把整个事件循环冻住几分钟——每发起一单,全站页面/SSE/审批
      // 全部无响应。runGitProcess 超时杀整个进程组,ssh/credential
      // 子进程不残留。
      const cloned = await runGitProcess(
        [
          ...(hardened
            ? [...hardened.args,
               "-c", "credential.helper=",
               "-c", `credential.helper=${hardened.helper}`]
            : []),
          // --no-local:本地路径 clone 默认 hardlink 复用 .git/objects,
          // 任务对象与源仓/兄弟任务共享 inode——任务 cwd 又整目录 RW
          // bind 进容器,任务侧 chmod/truncate 直接打在源仓对象上
          // (e2e-picky-20260830 实锤:任务对象 nlink=2452,容器内
          // mmap EACCES)。URL 仓不受此 flag 影响,统一加无副作用。
          "clone", "--quiet", "--no-local",
          ...(checkoutBaseline ? ["--branch", checkoutBaseline] : []),
          "--", source, target,
        ],
        {
          timeoutMs: 30 * 60_000,
          // 子进程没有终端,git 想问密码只会把任务挂死——明令禁问,
          // 缺凭据就地失败,错误如实上浮(不卡死红线)。
          env: hardened
            ? { ...hardened.env, GIT_TERMINAL_PROMPT: "0" }
            : { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
      if (cloned.status !== 0) {
        const detail = cloned.timedOut
          ? "克隆超过 30 分钟已终止"
          : String(cloned.stderr || cloned.error || "").trim().slice(0, 500);
        if (checkoutBaseline) {
          throw new Error(
            `仓库克隆失败：代码仓基线「${checkoutBaseline}」不存在或不可访问`
            + (detail ? `：${detail}` : ""));
        }
        throw new Error(`仓库克隆失败${detail ? `：${detail}` : ""}`);
      }
    } else {
      cpSync(source, target, {
        recursive: true,
        filter: (path) => !path.includes(".mae-flow-work")
          && !path.endsWith(".mae-flow.json"),
      });
    }
    // clone 一落地就登记，早于任何 Agent 会话和构建预热。中心服务随后
    // 往这些目录注入 Skill 时，普通 `git add .` 天然看不见它们。
    if (existsSync(join(target, ".git"))) {
      this.registerAgentPlatformLocalExcludes(target);
    }
    // 只读现场的推送硬禁用:pushurl 指向必然不存在的路径,git push
    // 走到传输层就死,与是否配了 helper 无关(本地路径克隆连凭据都
    // 不需要,所以只拦 helper 拦不住)。fetch/log/grep 一概不受影响。
    if (readonly && existsSync(join(target, ".git"))) {
      await runGitProcess(
        ["config", "remote.origin.pushurl", "/dev/null/mae-flow-readonly"],
        { cwd: target, timeoutMs: 30_000 });
    }
    // 署名与传输方式无关(本地路径克隆的演练也该署对名):配了就写,
    // 邮箱没填只写名字——平台认领靠邮箱,表单里已经把话说明白。
    // 会话重建复用旧克隆,署名改动生效边界=下一次新克隆。
    if (identity && existsSync(join(target, ".git"))) {
      await runGitProcess(["config", "user.name", identity.username],
        { cwd: target, timeoutMs: 30_000 });
      if (identity.email) {
        await runGitProcess(["config", "user.email", identity.email],
          { cwd: target, timeoutMs: 30_000 });
      }
    }
    return target;
  }

  /** 自动修复停下(halted/exhausted)→ 小鲁班。这是修复环里唯一
   * 真正需要人的时刻,必须主动喊人,不能等人自己来看页面。
   * 幂等键带 loop 状态,与早先发过的"验证中"收口通知不同键——
   * 那条说的是"机器在干活",这条说的是"机器干不动了,该你了"。 */
  private notifyRepairStopped(task: TaskState): void {
    const { notifier } = this.options;
    const account = task.summary.luban_account;
    const loop = task.summary.delivery?.loop;
    if (!notifier || !account || !loop) return;
    const why = loop.state === "halted"
      ? (loop.diagnosis
          ? `修复会话判断需人工处理:${loop.diagnosis.slice(0, 200)}`
          : "修复会话未产生新提交,请人工查看流水线日志")
      : `${loop.max} 轮修复预算用完,流水线仍红`;
    this.bypass(task, "修复停摆通知", notifier.notifyOutcome({
      taskId: task.summary.id,
      account,
      status: `repair_${loop.state}`,
      summary: `流水线自动修复已停,需要你介入——${why}`,
      link: personalTaskLink(
        this.notificationLinkBase(), account, task.summary.id),
    }));
  }

  /** Agent 已按人工意见完成修改且 Build-Fix 收敛：把复检待办直接发给
   * 每条意见的作者，不再只喊任务责任人。通知只负责提醒，权威状态仍
   * 是批注账 + 最终确认卡；失败不会阻塞任务，恢复重放也不会重复发。 */
  private notifyWorkspaceReviewReady(task: TaskState, sha: string): void {
    const notifier = this.options.notifier;
    const owner = task.summary.luban_account;
    const loop = task.summary.delivery?.loop;
    if (!notifier || !owner || loop?.review_source !== "workspace"
        || !loop.workspace_review_recheck_required) return;
    const wanted = new Set(loop.workspace_review_annotation_ids ?? []);
    const pending = this.annotations(task).list().filter((item) =>
      wanted.has(item.id)
      && (item.status === "draft" || item.status === "sent"));
    const byAuthor = new Map<string, number>();
    for (const item of pending) {
      byAuthor.set(item.author, (byAuthor.get(item.author) ?? 0) + 1);
    }
    // 只有整体补充说明时没有逐条作者，最终总检仍由任务责任人完成。
    if (!byAuthor.size) byAuthor.set(owner, 0);
    const revisionKey = createHash("sha256")
      .update(`${loop.review_ids ?? "workspace"}:${sha}`)
      .digest("hex").slice(0, 20);
    for (const [account, count] of byAuthor) {
      const summary = count
        ? `Agent 已处理你提出的 ${count} 条检视意见，Build-Fix 已通过。请打开任务逐条点“确认已修复”或“仍需调整”；未全部闭环前不会推送。`
        : "Agent 已按本轮整体检视意见完成修改，Build-Fix 已通过。请打开任务复检最终代码；确认前不会推送。";
      this.bypass(task, `邀请 ${account} 复检`, notifier.notifyReviewReady({
        taskId: task.summary.id,
        senderAccount: owner,
        account,
        summary,
        link: personalTaskLink(
          this.notificationLinkBase(), account, task.summary.id),
        revisionKey,
      }));
    }
  }

  /** 任务收口 → 小鲁班(说人话)。语义同待办通知:失败不改流程,
   * 同任务同状态幂等。没配通知器或没填账号静默跳过。 */
  private notifyOutcome(task: TaskState): void {
    const { notifier } = this.options;
    const account = task.summary.luban_account;
    if (!notifier || !account) return;
    const { status, delivery, detail, id } = task.summary;
    const text: Record<string, string> = {
      await_merge: `已提合入请求,流水线通过,等待合入`
        + (delivery?.mr_url ? `:${delivery.mr_url}` : ""),
      verifying: "代码已提交,流水线验证中",
      completed: "已完成"
        + (delivery?.skipped ? `(${delivery.skipped})` : ""),
      failed: `出错了:${detail || "原因见任务页"}`,
    };
    if (!text[status]) return;
    this.bypass(task, "收口通知", notifier.notifyOutcome({
      taskId: id,
      account,
      status,
      summary: text[status],
      link: personalTaskLink(this.notificationLinkBase(), account, id),
    }));
  }

  /** 主动压缩(用户关切:长编码阶段注意力漂移):事件量每涨
   * compactEveryEvents,在回合间隙以内核锚点压缩会话。事件量是
   * 上下文增长的诚实代理——不复刻 token 计数,也不猜阶段语义。 */
  private async maybeCompact(task: TaskState): Promise<void> {
    const every = this.options.compactEveryEvents ?? 0;
    if (!every || !task.driver) return;
    let level = 0;
    try {
      level = new EventLog(
        join(task.summary.workspace, "events.jsonl")).lastEventId();
    } catch {
      return;
    }
    if (level - (task.lastCompactAt ?? 0) < every) return;
    task.lastCompactAt = level;
    await task.driver.compactAnchored(this.kernelAnchor(task));
  }

  /** 压缩锚点:内核状态文件的 current/config 原文;没有内核现场
   * 就退到需求原话——锚永远来自权威,不由云端编造。 */
  private kernelAnchor(task: TaskState): string {
    try {
      const statePath = join(task.cwd ?? "", ".mae-flow.json");
      if (task.cwd && existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        return `内核当前步骤: ${state.current}\n`
          + `已确认配置: ${JSON.stringify(state.config ?? {})}\n`
          + `需求: ${requirementContext(
            task.summary.requirement,
            task.summary.requirement_document,
            AGENT_REQUIREMENT_DOCUMENT,
          )}`;
      }
    } catch {
      // 读不到就用需求兜底,不为锚编内容。
    }
    return `需求: ${requirementContext(
      task.summary.requirement,
      task.summary.requirement_document,
      AGENT_REQUIREMENT_DOCUMENT,
    )}`;
  }

  /** 内核视角的"流程还没走完":current 不是 end;状态文件不存在=
   * 连 init 都没走(run4 实测:空转回合把未 init 的任务标成 completed),
   * 同样算卡壳。非内核模式(无 host)不判——演练剧本自己收口。 */
  private stalledStep(task: TaskState): string | undefined {
    if (!this.options.host || !task.cwd) return undefined;
    try {
      const statePath = join(task.cwd, ".mae-flow.json");
      if (!existsSync(statePath)) return "init(尚未初始化)";
      const current = String(
        JSON.parse(readFileSync(statePath, "utf-8"))?.current ?? "");
      // external_verify 是 flow.json 明示的宿主等待点。Agent 到这里结束
      // 回合就是正确行为：不能再催它本地编译/跑 UT，更不能连催五轮。
      // settle 随后会释放会话并调用 tryDeliver，由宿主触发权威流水线。
      if (current === "external_verify") return undefined;
      return current && current !== "end" ? current : undefined;
    } catch {
      return undefined;
    }
  }

  private atExternalVerificationWait(task: TaskState): boolean {
    if (!task.cwd) return false;
    try {
      const statePath = join(task.cwd, ".mae-flow.json");
      return existsSync(statePath)
        && String(JSON.parse(readFileSync(statePath, "utf-8"))?.current ?? "")
          === "external_verify";
    } catch {
      return false;
    }
  }

  /** 旁路的即发即忘统一走这里:**抛了就记账,绝不带走进程**。
   *
   * `void 某个异步旁路()` 是本仓的常用写法(通知、投影、流水线轮询、
   * 合入监控、容器清理),但 Node 从 15 起未处理的 rejection 默认终止
   * 进程——于是"PG 抖一下""docker 没了""平台 502"这类旁路故障,后果
   * 是整台服务连着所有在跑的任务一起没。红线写得很清楚:旁路一律
   * fail-open。这个壳子就是那条红线在代码里的落点,别再裸 void。 */
  private bypass(
    task: TaskState | undefined,
    what: string,
    work: Promise<unknown> | undefined,
  ): void {
    if (!work) return;
    void work.catch((error) => {
      const who = task ? `任务 ${task.summary.id} ` : "";
      this.options.log?.(
        `${who}旁路「${what}」出错(fail-open,流程照走): ${String(error)}`);
    });
  }

  /** outcome → 任务状态。等待人工不占并发额度之外的资源,会话原地挂起。
   *
   * **一整条链都在 try 里**,这不是防御性编程的洁癖:decide 那头是
   * `void this.settle(...)`——人点了"通过",模型跑一轮,这条链上任何
   * 一处抛异常都是一个没人接的 Promise,Node 默认直接杀进程。内网反复
   * 报的"serve 莫名其妙挂了、一点错误输出都没有",症状(人工审批通过、
   * 模型跑完一轮后进程退出)与它严丝合缝。
   *
   * 进程级兜底(serve 的 guardProcess)拦得住"死",拦不住"哑":异常
   * 被吞了,任务会永远停在 running,人在页面上等一个不会来的结果。所以
   * 这里如实收口——任务 failed,原因写进 detail,通知照发。 */
  private async settle(
    task: TaskState,
    turn: Promise<Outcome>,
    epoch = task.controlEpoch,
  ): Promise<void> {
    try {
      await this.settleTurn(task, turn, epoch);
    } catch (error) {
      if (!this.current(task, epoch)) return;
      const driver = task.driver;
      if (task.driver === driver) task.driver = undefined;
      driver?.dispose();
      const cleanupFailure = await this.stopTaskContainer(task, "收口异常后");
      if (!this.current(task, epoch)) return;
      task.summary.status = "failed";
      task.summary.detail = `本轮收口时出错: ${String(error)}`
        + (cleanupFailure ? `；${cleanupFailure}` : "");
      this.persist(task);
      this.notifyOutcome(task);
      this.options.log?.(
        `任务 ${task.summary.id} 收口时抛异常(任务如实 failed,服务继续): `
        + String(error));
    }
  }

  private async settleTurn(
    task: TaskState,
    turn: Promise<Outcome>,
    epoch = task.controlEpoch,
  ): Promise<void> {
    const outcome = await turn;
    if (!this.current(task, epoch)) return;
    switch (outcome.status) {
      case "waiting_for_human": {
        task.summary.waiting = outcome.waiting;
        if (task.pauseRequested || task.summary.status === "pausing") {
          await this.finishPause(task, "waiting_for_human");
          break;
        }
        task.summary.status = "waiting_for_human";
        // 人工节点=流程真实活动,催办账本清零:答复之后若再停在
        // 同名步骤,那是新一次卡壳,应当再催。
        task.nudgedStep = undefined;
        this.persist(task);
        // 先看有没有现成答案(下单预选/月光模式):有就自动交卷,
        // 不通知不打扰;没有才是真·等人。setImmediate 让本轮 settle
        // 先收完账再交卷——decide 会立刻把状态翻回 running。
        const auto = this.autoAnswerFor(task);
        if (auto) {
          this.options.log?.(
            `任务 ${task.summary.id} 人工节点自动交卷(${auto.why})`);
          // 自动交卷=马上就要接着跑,别做"停了再开"的无用功。
          setImmediate(() => void this.autoDecide(task, auto));
        } else {
          // 真·等人时会话与容器是一个连续执行现场。8g 是上限而非预占；
          // 为省空闲资源销毁容器会丢 HOME、/tmp，并让续跑撞上重建竞态。
          this.notifyWaiting(task);
        }
        break;
      }
      case "turn_finished": {
        if (task.pauseRequested) {
          await this.finishPause(task, "running");
          break;
        }
        // 主动压缩:回合间隙是唯一安全的压缩点(等待人工时压会
        // 打断挂起的人工节点)。以内核锚点组织摘要,注意力不许飘。
        await this.maybeCompact(task);
        if (!this.current(task, epoch)) break;
        if (task.pauseRequested) {
          await this.finishPause(task, "running");
          break;
        }
        // 回合收口时 steer 队列还压着货 = 那条插话从没送到(撞在回合
        // 间隙,pi 收下却不会自己送)。取回来补发,而且排在催办和收工
        // 之前:人说的话优先于系统催办,更不能因为"流程刚好走完了"被吞掉。
        const late = task.driver?.takeUndeliveredSteers() ?? [];
        if (late.length && task.driver) {
          this.options.log?.(
            `任务 ${task.summary.id} 补发 ${late.length} 条未送达的插话`);
          await this.settle(
            task, task.driver.continueWith(late.join("\n\n")), epoch);
          break;
        }
        // 回合结束≠流程走完:模型可能提前收嘴(run3 实测停在
        // delivery_review)。内核 current 不在终态且催办还有效时,
        // 同一会话催办续跑,而不是把半截流程标成 completed。
        const stalled = this.stalledStep(task);
        if (stalled && task.nudgedStep !== stalled) {
          // 换了步骤才重置预算；同一步第二次 end_turn 不能因为“已经催过”
          // 就越过内核直接交付。最多催五次，之后如实停机等重跑。
          task.nudgedStep = stalled;
          task.nudgeCount = 0;
        }
        if (stalled && task.driver && (task.nudgeCount ?? 0) < 5) {
          task.nudgeCount = (task.nudgeCount ?? 0) + 1;
          this.options.log?.(
            `任务 ${task.summary.id} 催办续跑(流程停在 ${stalled})`);
          await this.settle(task, task.driver.continueWith(
            `流程尚未走完:内核当前步骤是 ${stalled},不是 end。` +
            `尚未 init 就按开工引导先执行 init;否则执行 current ` +
            `查看本步指引并继续,直到流程 end。` +
            `已答复过的确认项不要重复提问。`), epoch);
          break;
        }
        const beforeDelivery = this.completionAttestation(task);
        if (beforeDelivery
            && beforeDelivery.kind !== "terminal"
            && beforeDelivery.kind !== "external_verify") {
          // end_turn 是模型会话事实，不是内核流程事实。催办用尽、driver
          // 消失或状态损坏时宁可显式失败，也不能 tryDeliver 后把 running
          // 兜成 completed。failed 可由人工重跑从 current 原地恢复。
          task.lastReply = task.driver?.finalReply();
          const earlyDriver = task.driver;
          if (task.driver === earlyDriver) task.driver = undefined;
          earlyDriver?.dispose();
          const cleanupFailure = await this.stopTaskContainer(
            task, "Agent 提前结束后");
          if (!this.current(task, epoch)) break;
          task.mission = undefined;
          task.summary.status = "failed";
          task.summary.detail = `Agent 提前结束，${beforeDelivery.reason}`
            + (cleanupFailure ? `；${cleanupFailure}` : "");
          this.persist(task);
          this.notifyOutcome(task);
          break;
        }
        // 收口发言先落袋:修复会话"判断修不了"时这就是给人的诊断,
        // 下面 tryDeliver→pipelineVerdict 的 halted 分支要用。
        task.lastReply = task.driver?.finalReply();
        task.driver?.dispose();
        // host push 的硬前提：不仅调用 dispose，还要先从任务状态移除
        // 会话句柄，还要串行停净普通编码容器。异步 fire-and-forget 会
        // 让旧容器和紧接着启动的 prepush attempt 同时写一个 workspace。
        task.driver = undefined;
        const completedContainer = task.container;
        await (completedContainer?.stop() ?? Promise.resolve());
        if (task.container === completedContainer) task.container = undefined;
        if (!this.current(task, epoch)) break;
        // 专项使命到这儿才算消费掉:会话真做完了。早清会让"修一半
        // 被重启"的重建会话拿不到使命。
        task.mission = undefined;
        // 本地人工意见必须逐条有机器回执，才能进入 Build-Fix 和作者复检。
        // 这一步在 push 前、容器停净后执行：回执对应的正是当前本地 HEAD。
        if (task.summary.delivery?.loop?.review_source === "workspace") {
          const receipts = await this.consumeWorkspaceReviewReceipts(task);
          if (!receipts.ok) {
            const loop = task.summary.delivery.loop!;
            loop.state = "halted";
            loop.diagnosis = receipts.detail;
            task.summary.status = "verifying";
            task.summary.detail = receipts.detail ?? "逐条检视回执不完整";
            task.summary.delivery.stalled = task.summary.detail;
            this.persist(task);
            this.notifyRepairStopped(task);
            break;
          }
        }
        // 终态在交付判定之后才定:先标 completed 再改,轮询会撞见
        // 中间态(实测竞态)。交付把状态升为 verifying/await_merge,
        // 没交付动作时才落 completed。
        const deliveryResult = await this.tryDeliver(task, epoch);
        if (deliveryResult === "review_reply_blocked") break;
        if (!this.current(task, epoch)) break;
        // 交付请求本身也可能耗时；用户若在这段窗口点了暂停，外部流水线
        // 已触发就停在 verifying 跟踪点，否则停在普通执行点。若已经绿灯
        // 进入 await_merge，则任务事实上已完成交付，无需再造 paused 中间态。
        if (task.pauseRequested && task.summary.status !== "await_merge") {
          await this.finishPause(task,
            task.summary.status === "verifying" ? "verifying" : "running");
          break;
        }
        task.pauseRequested = false;
        const afterDelivery = this.completionAttestation(task);
        if (afterDelivery && !afterDelivery.complete
            && ["running", "completed", "await_merge"].includes(
              task.summary.status)) {
          // tryDeliver 是 I/O 编排，不拥有终态解释权。无论它从哪个旁路
          // 返回，只要内核还没 terminal + PASS，就只能继续验证/显式失败。
          if (afterDelivery.kind === "external_verify"
              || (afterDelivery.terminal && afterDelivery.external_required)) {
            // 这里是"交付这一轮没能把义务核销掉"的总收口——推送失败、
            // MR 建不起来、内核登记没成,最后都落到这一句。挂起必须带
            // 自愈预算:原来它只写个状态就散场,于是任务既没人再推它、
            // 重启也不管它、连重跑都被拒(实测的那潭死水)。
            this.holdWithRecovery(task, afterDelivery.reason, epoch);
          } else {
            task.summary.status = "failed";
            task.summary.detail = `不能完成任务：${afterDelivery.reason}`;
          }
        } else if (task.summary.status === "running") {
          task.summary.status = "completed";
        }
        this.persist(task);
        this.notifyOutcome(task);
        break;
      }
      case "session_ended":
        if (task.pauseRequested || task.summary.status === "pausing") {
          await this.finishPause(task, "running");
          break;
        }
        const endedDriver = task.driver;
        if (task.driver === endedDriver) task.driver = undefined;
        endedDriver?.dispose();
        const cleanupFailure = await this.stopTaskContainer(task, "会话异常结束后");
        if (!this.current(task, epoch)) break;
        task.summary.status = "failed";
        task.summary.detail = (outcome.detail ?? outcome.reason)
          + (cleanupFailure ? `；${cleanupFailure}` : "");
        this.persist(task);
        this.notifyOutcome(task);
        break;
    }
  }
}

export class NotFoundError extends Error {}
export class TaskControlError extends Error {}
