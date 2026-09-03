/**
 * 问题流服务:与需求任务并行的独立会话域。
 *
 * 范式差异(有意为之,别"修"回内核):需求走内核固定流水线,问题走
 * "AI 按 playbook 自主编排的多轮对话"。本服务只做三件事:
 * 1. 承载会话(克隆/容器/CloudSession,不挂任何内核 hook);
 * 2. 显示(状态文件 + 事件账本,阶段由 Agent 上报,平台不推断);
 * 3. 门禁(推送/提MR 的单号闸;秘密止步宿主)。
 *
 * 会话真相在 dataDir/issues/<id>/(issue.json + events.jsonl +
 * transcript.jsonl + waiting.json),API 是投影;服务重启后正在跑/
 * 排队的会话重新入队,由并发额度泵以续聊回合自动续跑——需求侧断点
 * 续跑的同款语义(2026-08-29 拍板),不再有等人发消息救活的滞留态。
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { CloudSession, type Outcome } from "../sessionDriver.ts";
import type { VisionCapabilityConfig, VisionModelChoice } from "../visionCapability.ts";
import type { Notifier, NotifyQuestion } from "../notifier.ts";
import { EventLog, type SemanticEvent } from "../semanticEvents.ts";
import { TranscriptStore } from "../transcriptStore.ts";
import { GateService } from "../gateService.ts";
import { HumanGate, renderDecision, type WaitingRecord } from "../humanGate.ts";
import {
  IssueEnvironmentVault,
  type IssueEnvironmentInput as VaultEnvironmentInput,
} from "../issueEnvironment.ts";
import {
  TaskContainer,
  taskContainerInstance,
  type TaskContainerLimits,
} from "../containerRuntime.ts";
import {
  isBlindPipelineInput,
  mirrorPipelineArtifacts,
} from "../pipelineMirror.ts";
import { repairBudget } from "./pipelineRepair.ts";
import { perRepoBuildCacheMounts } from "../buildCacheMounts.ts";
import {
  prepareContainerHostPaths,
  repairContainerCloneOwnership,
  repairContainerMutationOwnership,
  type ContainerOwnershipRuntime,
} from "../containerOwnership.ts";
import {
  fixedAdvance,
  fixedComplete,
  fixedRollback,
  fixedStageIndex,
  fixedStages,
  initStageStates,
  isTerminal,
  issueRepoWorkspaces,
  loadState,
  normalizeIssueRepos,
  raiseGate,
  recordTransition,
  saveState,
  shouldNudgeFixed,
  summarize,
  type FixedStage,
  type IssueBusinessKnowledge,
  type IssueBusinessKnowledgeEntry,
  type IssueConclusionKind,
  type IssueEnvironmentConfig,
  type IssueFlowMode,
  type IssueGate,
  type IssueScenario,
  type IssueSkillChoice,
  type IssueSource,
  type IssueStage,
  type IssueStatus,
  type IssueSummary,
  type IssueSessionState,
} from "./state.ts";
import { businessKnowledgeLines } from "./businessKnowledge.ts";
import {
  materializeBusinessModuleKnowledge,
  snapshotBusinessModules,
} from "../businessModuleRuntime.ts";
import {
  buildWorksiteRecord,
  type WorksiteRecord,
} from "./worksiteExport.ts";
import {
  cloneRepository,
  currentHead,
  divergedRemoteBranch,
  ensureBranch,
  validateRepoUrl,
  type GitCredential,
} from "./issueGit.ts";
import { readBusinessModule } from "../businessModuleLibrary.ts";
import { type ModelsSettings } from "../settings.ts";
import { createGoOpsTools, type ContainerExec, type IssueOpsTools } from "./opsTools.ts";
import {
  DtsGatewayUnconfiguredError,
  IssueControlError,
  IssueNotFoundError,
} from "./errors.ts";
import type { DtsGateway, DtsTicketDetail } from "./gateways.ts";
import { createIssueTools, expectedBranch, type IssueToolContext } from "./tools.ts";
import {
  buildIssueTimeline,
  type IssueSessionTimeline,
} from "./sessionView.ts";
import {
  fixedAdvanceNotice,
  fixedNudgeNotice,
  issueFixedOpeningPrompt,
  issueOpeningPrompt,
  issueResumePrompt,
  materializeIssueSkills,
  type IssueEnvCredentials,
} from "./prompt.ts";
import {
  orderAnnotations,
  type AnchorCheck,
  type Annotation,
} from "../annotations.ts";
import {
  addReview,
  anchorChecks,
  dropReview,
  renderReviewNotes,
  reviewStore,
  submitReviews as submitReviewLedger,
} from "./reviews.ts";
import {
  GATE_OPTIONS,
  fixedStageLabel,
  gateOptionLabel,
  gateVerdict,
  stageEntryGate,
  stageGateRoute,
} from "./stageRegistry.ts";
import {
  describePipelineRun,
  getPipelineStatus,
  triggerPipeline,
  type PipelineRun,
} from "../pipelineClient.ts";
import {
  onlyUnfixableToolFailures,
  PIPELINE_DIMENSIONS,
  summarizeFailedChecks,
  type PipelineCheck,
  type PipelineDimension,
} from "../pipelineContract.ts";
import {
  assessPipelineRepairEvidence,
  PIPELINE_DIMENSION_TEXT,
  type PipelineArtifactText,
  type PipelineEvidenceAssessment,
} from "../pipelineEvidence.ts";
import { syncIssueImagesToWorkspace } from "./issueImages.ts";
import { FeedbackStore, type FeedbackRecord } from "../feedbackStore.ts";

// ---- 举卡作答的机器可读协议 ----

/** Agent 问题卡(AskUserQuestion)选项的决策码:选项措辞是 Agent 现场
 * 自由给的,没有领域码表可查,就按「题号-序号」机械派码(opt-0-1)。
 * 投影时派码(前端渲染 label、提交 code),作答时按同一张码表把码
 * 还原成选项原文——Agent 看到的永远是自己的措辞,行为零变化。 */
function agentOptionCode(questionIndex: number, optionIndex: number): string {
  return `opt-${questionIndex}-${optionIndex}`;
}

const AGENT_OPTION_CODE = /^opt-(\d+)-(\d+)$/;

/** Agent 卡问题清单(AskUserQuestion 的原始形状;读不出来的当没有)。 */
function agentCardQuestions(record: WaitingRecord): Array<{
  question?: string;
  options?: string[];
  recommended?: string;
}> {
  return (record.question as { questions?: Array<{
    question?: string;
    options?: string[];
    recommended?: string;
  }> })?.questions ?? [];
}

/** 「AI 推荐」的命中尺:trim 后逐字命中选项原文,返回下标(-1=没有)。
 * 投影(推荐原文换投影码)与月光代答(按推荐作答)共用同一把——
 * 卡上标的推荐与代答认的推荐永远同一判定,不会各说各话。 */
function recommendedIndex(
  options: string[] | undefined,
  recommended: string | undefined,
): number {
  const wanted = recommended?.trim() ?? "";
  if (!wanted) return -1;
  return (options ?? []).findIndex((option) => option.trim() === wanted);
}

/** 投影:给 Agent 卡的字符串选项派发决策码(get 的 waiting 出口)。
 * 平台闸不走这里——它的码表就是 stageRegistry 的 GATE_OPTIONS,
 * 举闸时已带码落盘。没有在等的卡原样返回 undefined。 */
function withAgentOptionCodes(
  record: WaitingRecord | undefined,
): WaitingRecord | undefined {
  if (!record) return undefined;
  const questions = agentCardQuestions(record);
  if (!questions.length) return record;
  return {
    ...record,
    question: {
      ...record.question,
      questions: questions.map((item, questionIndex) => {
        const options = (item.options ?? []).map((option, optionIndex) => ({
          code: agentOptionCode(questionIndex, optionIndex),
          label: option,
        }));
        // 推荐协议(ADR-0004):推荐原文换算成命中选项的投影码随卡
        // 下发(questions[].recommended),前端按码标「AI 推荐」——
        // 与选项同一条码表,文案改字零协议后果。校验器保证必命中;
        // 万一没命中(卡先于校验落盘的旧现场)不带该键,不造悬空码。
        const { recommended: rawRecommended, ...rest } = item;
        const hit = recommendedIndex(item.options, rawRecommended);
        return {
          ...rest,
          options,
          ...(hit >= 0 ? { recommended: options[hit].code } : {}),
        };
      }),
    },
  };
}

/** Agent 卡作答的归码还原:answers(键=题号)里的决策码还原成选项
 * 原文,自由作答原样保留,拼回与旧协议一致的换行合并 decision——
 * humanGate 记录与 Agent 上下文看到的文本,与文字作答时代逐字节相同。
 * 没带 answers(直调/自由文本旧形态)返回 undefined,由调用方透传
 * decision。码对不上(卡已换)当自由作答,不静默吃掉用户的选择。 */
function decodeAgentDecision(
  record: WaitingRecord,
  answers: Record<string, string> | undefined,
): string | undefined {
  if (!answers || !Object.keys(answers).length) return undefined;
  const questions = agentCardQuestions(record);
  const lines = questions.map((item, questionIndex) => {
    const raw = answers[String(questionIndex)]?.trim() ?? "";
    if (!raw) return "";
    const match = AGENT_OPTION_CODE.exec(raw);
    const option = match && Number(match[1]) === questionIndex
      ? item.options?.[Number(match[2])]
      : undefined;
    return option ?? raw;
  });
  const joined = lines.filter(Boolean).join("\n");
  return joined || undefined;
}

export interface IssueEnvironmentInput {
  name?: string;
  hosts: string[];
  port?: number;
  /** 页面账号(网管页面登录名;缺省 admin,非密随配置落 issue.json)。 */
  pageAccount?: string;
  /** 页面密码(vault 加密落盘,并按 ADR-0003 进入当前问题的 AI 上下文;
   * 不出现在会话列表、状态摘要或事件流)。 */
  pagePassword?: string;
  /** 网管后台密码(playbook 契约:sopuser/ossuser/ossadm 同密码)。 */
  backendPassword: string;
}

/** 四件套的机械校验与归一(登记与 env_needed 闸作答共用同一把尺,差别
 * 只在页面密码是否必填:闸是拉日志/换库的现场补配,那些流程碰不到
 * 网管页面)。归一在落盘前跑,半截登记不许烧掉会话号。 */
function normalizeEnvironmentInput(
  input: IssueEnvironmentInput,
  withPage: boolean,
): {
  hosts: string[];
  name: string;
  port: number;
  pageAccount: string;
  pagePassword?: string;
  backendPassword: string;
} {
  const hosts = input.hosts.map((host) => host.trim()).filter(Boolean);
  if (!hosts.length) {
    throw new IssueControlError("网管环境至少要有一个服务器地址");
  }
  const backendPassword = input.backendPassword?.trim();
  if (!backendPassword) {
    throw new IssueControlError("配置了网管环境就必须填写网管后台密码");
  }
  const pagePassword = input.pagePassword?.trim();
  if (withPage && !pagePassword) {
    throw new IssueControlError("配置了网管环境就必须填写页面密码");
  }
  return {
    hosts,
    name: input.name?.trim() || hosts[0],
    port: input.port ?? 22,
    pageAccount: input.pageAccount?.trim() || "admin",
    ...(pagePassword ? { pagePassword } : {}),
    backendPassword,
  };
}

/** 问题域知识上下文(ADR-0005):货架 skill 匹配问题会话用的画像=
 * 登记的关联仓 + 绑定的业务模块。纯函数单源,openDriver 装配与测试
 * 共用——改口径只动这里。 */
export function issueKnowledgeContext(state: IssueSessionState): {
  repositories: string[];
  technologies: string[];
  businessModuleIds: string[];
} {
  return {
    repositories: state.repo_urls?.length
      ? [...state.repo_urls]
      : state.repo_url ? [state.repo_url] : [],
    technologies: [],
    businessModuleIds: state.module_id ? [state.module_id] : [],
  };
}

/** vault 行·后台凭据:playbook 契约三个系统账号同密码,按形状存三套,
 * vault 校验与工具取密(sopuser)都不用特判。 */
function backendVaultRow(
  name: string,
  host: string,
  port: number,
  password: string,
): VaultEnvironmentInput {
  return {
    name,
    purpose: "both",
    host,
    port,
    accounts: ["sopuser", "ossuser", "ossadm"].map((username) =>
      ({ username, password })),
  };
}

/** vault 行·页面凭据:单账号独立成组(purpose=page),与后台凭据
 * 互不混存——environmentCredentials 按自己的组解到当前问题的
 * AI 上下文,页面操作不借用 SSH 三账号那把钥匙。 */
function pageVaultRow(
  name: string,
  host: string,
  port: number,
  account: string,
  password: string,
): VaultEnvironmentInput {
  return {
    name: `${name}·页面`,
    purpose: "page",
    host,
    port,
    username: account,
    password,
  };
}

export interface IssueCreateInput {
  account: string;
  title: string;
  description?: string;
  source?: IssueSource;
  ticket?: string;
  repoUrl?: string;
  /** 多仓登记(模块带仓是常态):与 repoUrl 合并去重;repo_url 兼容
   * 别名取首个,仓彼此平等。 */
  repoUrls?: string[];
  baseline?: string;
  /** 业务模块自由文本标签(仅展示/报告引用,不承载判定)。 */
  module?: string;
  /** 登记选定的业务模块 ID:校验存在且 active,名称派生 module 标签。 */
  moduleId?: string;
  /** 人工预绑锁(spec #57):路由层只在模块 id 来自人的显式选择时
   * 置真(DTS 预绑/登记页手工选;服务端 matchDtsToModule 自动匹配
   * 不算,那仍是机器猜测,不锁)。 */
  moduleLocked?: boolean;
  /** 显式指定模式(转正建新会话用);缺省走 issueFlowMode 回调。 */
  mode?: IssueFlowMode;
  environment?: IssueEnvironmentInput;
}

export interface IssueIsolation {
  image: string;
  volumes: string[];
  /** 分仓构建缓存根(与 taskService isolation.cacheRoot 同款);
   *  有值时 ensureContainer 按 repo URL 创建分仓缓存,挂载 /cache/maven
   *  等并设 MAVEN_OPTS——容器内 mvn 能找到 parent POM。 */
  cacheRoot?: string;
  memory: string;
  cpus: string;
  user?: string;
  pidsLimit: number;
  network: string;
  /** 向容器注入的额外环境变量(与 taskService isolation.environment 同款);
   *  ensureContainer 先继承这里,再追加缓存相关变量(MAVEN_OPTS 等)。 */
  environment?: NodeJS.ProcessEnv;
  /** 窄测试注入口(与 taskService isolation.containerFactory 同款意图):
   *  生产缺席时始终 new TaskContainer;测试注入它,无 daemon 环境也能
   *  证明容器生命周期契约(回合收口不停、终态必停)。 */
  containerFactory?: (build: IssueContainerBuild) => TaskContainer;
}

/** ensureContainer 组装容器时的全部入参(与 TaskContainer 构造同形),
 *  抽成对象是为了上面的 containerFactory 注入口。 */
export interface IssueContainerBuild {
  image: string;
  workspace: string;
  name: string;
  log?: (message: string) => void;
  volumes: string[];
  limits: TaskContainerLimits;
  options: {
    network: string;
    environment?: NodeJS.ProcessEnv;
    labels: Record<string, string>;
  };
}

export interface IssueFlowOptions {
  dataDir: string;
  provider: string;
  model: string;
  modelsJson: Record<string, unknown>;
  settings?: {
    models(): ModelsSettings;
    /** 流水线监看的轮询节奏(与需求侧同一份运行参数);其中的
     *  issue_max_turns 是问题流回合并发额度(管理页「问题单并发数」,
     *  泵现读现判,优先于 maxConcurrentTurns 部署旗)。 */
    runtime?(): {
      poll_interval_s?: number; poll_timeout_s?: number;
      issue_max_turns?: number;
      /** 红灯修复轮预算(与需求侧同一旋钮,缺省 20;0=关掉自动修复)。 */
      repair_rounds?: number;
      /** 证据重试窗(票 82,分钟):红灯证据全缺/盲输入先定时重拉
       *  镜像重评,到点仍缺才举 pipeline_evidence 卡。缺省 15;0=关闭
       *  (回到立即举卡的现状);允许小数(亚分钟窗口,测试用)。 */
      evidence_retry_minutes?: number;
    };
  };
  /** 不可自动修复工具名单(--unfixable-tools,与需求交付同一面旗):
   *  流水线红灯的失败项全部是这些工具的 CODECHECK 告警时,修复回合
   *  改代码解决不了(要人在交付平台处理/豁免)——不派回合,停表请人。
   *  缺席=不分诊,红灯照旧派修,行为与现状一致。 */
  unfixableTools?: string[];
  /** 探索方式烙印(个人设置,缺省固定流程)。回调缺席按自由模式——
   * 这是裸构造(测试/旧部署)的兼容缺省;正式接线在 serve 层,那里的
   * auth.issueFlowMode 对真人缺省返回 fixed。 */
  issueFlowMode?: (account: string) => IssueFlowMode;
  /** 月光免审批(个人设置「人工介入程度」的过程轴,现读现判):开着时
   * 分析结论闸由系统代答——analysis_confirm 全量;conclude 仅提案
   * non_issue 且自报高置信;Agent 自举的纯选项题问答卡按推荐项整卡
   * 代答(开放题/混卡/检视回合永不,ADR-0006)。
   * env_needed/env_verify 问的是用户事实,永不代答。
   * 回调缺席或返回非真=关闭,行为与现状一致。 */
  moonlight?: (account?: string) => boolean | undefined;
  /** 推送前过目(个人设置「人工介入程度」的交付轴,现读现判):开着时
   * push_branch 无一次性令牌即被拒并举 push_confirm 闸(带服务端生成
   * 的变更摘要),用户确认产令牌放行一次推送;月光永不代这张闸——
   * 过目是用户显式开启的意志,更具体的意志赢(ADR-0009,与需求流
   * push 前确认同一裁定)。回调缺席或返回非真=直推,行为与现状一致
   * (裸构造兼容缺省;正式接线在 serve 层的 auth.pushConfirmationEnabled)。 */
  pushConfirmation?: (account?: string) => boolean | undefined;
  gitCredential?: (account: string) =>
    (GitCredential & { email?: string }) | undefined;
  opsTools?: IssueOpsTools;
  /** ops 二进制目录(宿主 assets/ops-tools);有 isolation 时按会话
   * 构造容器内执行的 ops 工具,比全局 opsTools 更优先。 */
  opsToolsDir?: string;
  dts?: DtsGateway;
  /** 交付平台适配层(--platform):MR 创建与需求交付共用同一端点。 */
  platformUrl?: string;
  vault?: IssueEnvironmentVault;
  /** 回合并发额度的部署缺省(--issue-max-turns):泵先读管理页运行时
   *  旋钮 issue_max_turns,缺席才用这里;两边都缺省时是 5。 */
  maxConcurrentTurns?: number;
  /** 可选的专用视觉模型角色(与需求侧 TaskService 同形)。openDriver
   * 组装会话时按同款逻辑变成 VisionCapabilityConfig,主会话由此获得
   * inspect_image 工具;缺席则工具不出现,行为照旧。 */
  vision?: VisionModelChoice;
  /** 小鲁班通知(公共能力,与需求侧同一实例):AI 举卡等决策时提醒
   * 归属用户。缺席(演示形态)不通知,流程照走——通知是旁路,不是
   * 问题流的启动依赖。 */
  notifier?: Notifier;
  /** 通知链接的对外入口(--public-url):深链落到问题会话工作台
   * /issues/<id>,与需求侧 /work/<id> 同一地位。 */
  linkBase?: string;
  isolation?: IssueIsolation;
  /** 容器属主判定的运行时形态:生产缺席即按进程真实形态判定(非 root
   * 部署守卫直接 false,零开销);只有测试注入它来模拟 root 宿主。 */
  ownershipRuntime?: ContainerOwnershipRuntime;
  log?: (message: string) => void;
  /** 正式服务需要先清扫上次进程遗留的容器，再恢复问题会话。缺省仍在
   * 构造时恢复，保持独立使用与既有测试兼容；serve 显式延后并调用
   * start()，从启动顺序上消掉“新容器被孤儿清扫误杀”的竞态。 */
  deferRecovery?: boolean;
}

interface LiveIssue {
  id: string;
  root: string;
  state: IssueSessionState;
  humanGate: HumanGate;
  /** 用户取消会递增；旧回合稍后返回时凭此识别自己已经失效，不能把
   * canceled 覆盖回 failed/idle。 */
  controlEpoch: number;
  driver?: CloudSession;
  container?: TaskContainer;
  toolContext?: IssueToolContext;
  /** 重启续跑的待递话:恢复路径把会话重新入队时放上平台通知,泵点火
   * 时消费——续跑与用户续聊共用同一条重建回合体,只差这句开场。 */
  resumeMessage?: string;
}

export interface IssueMessage {
  role: "user" | "assistant" | "decision";
  text: string;
  ts: string;
}

const TICKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** 催办续跑预算:每个用户/平台回合最多自动推回模型这么多次,再收嘴就
 * 落 idle 交还人工——催办是纠偏不是永动机,连收嘴说明模型真不想干了。 */
const NUDGE_BUDGET = 2;

/** 重启续跑的开场通知(#27):续跑回合以它为用户消息,落事件流——
 * 重启这件事在会话时间线里可查,不落 stage_note(那是显示层的现场
 * 说明,盖掉就丢了恢复前的阶段语境,续聊提示词还要用它)。 */
const RESTART_RESUME_NOTICE =
  "平台通知: 服务重启,平台自动续跑,接着当前阶段继续,不重复已完成的工作。";

/** SKILL.md frontmatter 的 description(没有就空串):只认文件开头
 * `---` 包围块里的 description 行,多余内容一律不猜——清单卡上的
 * 描述只是展示,真相始终在文件本体,Agent 圈选后要读的也是本体。 */
function skillDescription(path: string): string {
  try {
    const head = readFileSync(path, "utf-8").split("---", 3);
    if (head.length < 3 || head[0].trim() !== "") return "";
    const match = head[1].match(/^description:\s*(.+)$/m);
    return match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  } catch {
    return "";
  }
}

/** skill 圈选扫描的两个固定目录(2026-09-03 拍板):数组序即优先级,
 * `.cac` 在前(存量团队行为不变),`.agents` 补位;pi/.claude 不进
 * 问题流扫描(与需求流 REPOSITORY_SKILL_ROOTS 四根刻意不同)。 */
const SKILL_SCAN_ROOTS = [
  { dir: join(".cac", "skills"), label: ".cac/skills" },
  { dir: join(".agents", "skills"), label: ".agents/skills" },
] as const;

/** 不可修分诊命中时,给通知文案列人话工具名(失败项里落在名单内的
 *  工具,保原大小写)。与 onlyUnfixableToolFailures 同源的收集口径:
 *  check.tool + details[].tool,名单内的才列。 */
function unfixableToolNames(
  checks: PipelineCheck[] | undefined,
  unfixableTools: string[] | undefined,
): string[] {
  const list = new Set((unfixableTools ?? []).map((tool) =>
    tool.trim().toLowerCase()).filter(Boolean));
  const names = new Set<string>();
  for (const check of checks ?? []) {
    if (check.status !== "failed") continue;
    for (const tool of [check.tool ?? "",
      ...(check.details ?? []).map((defect) => defect.tool ?? "")]) {
      const key = tool.trim().toLowerCase();
      if (key && list.has(key)) names.add(tool.trim());
    }
  }
  return [...names];
}

/** 维度的人话名(展示用):COMPILE→编译/构建。 */
function dimensionLabels(dimensions: PipelineDimension[]): string {
  return dimensions.map((item) => PIPELINE_DIMENSION_TEXT[item]).join("、");
}

/** 缺口维度的人话原因(assess 已给每个缺口维度兜了底,这里只取用)。 */
function evidenceGapReasons(assessment: PipelineEvidenceAssessment): string[] {
  return assessment.missingDimensions.flatMap((dimension) => {
    const reasons = assessment.reasons[dimension] ?? [];
    return reasons.length ? reasons
      : [`${PIPELINE_DIMENSION_TEXT[dimension]}:未拿到具体报错`];
  });
}

/** 失败维度的人话名(去重,保持 PIPELINE_DIMENSIONS 的自然顺序)。 */
function failedDimensionLabels(checks: PipelineCheck[] | undefined): string {
  const failed = new Set((checks ?? [])
    .filter((check) => check.status === "failed")
    .map((check) => check.dimension));
  const ordered = PIPELINE_DIMENSIONS.filter((dimension) =>
    failed.has(dimension));
  return dimensionLabels(ordered);
}

/** 本轮红灯的人话摘要(票 82 派修留账用):维度点名+失败摘要节选,
 *  截断防膨胀。下一轮派修时作为"上轮报错"拼进回合提示词,让会话
 *  对比是否同一处再决定换不换思路(需求流 loop.failure 同语义)。 */
function pipelineFailureDigest(
  run: PipelineRun,
  checks: PipelineCheck[] | undefined,
): string {
  const dims = failedDimensionLabels(checks);
  const log = (run.log ?? "").trim();
  const parts = [
    dims ? `失败维度: ${dims}` : "",
    log ? log.slice(0, 400) : "",
  ].filter(Boolean);
  return (parts.join(";") || "(平台未给出失败详情)").slice(0, 600);
}

export class IssueFlowService {
  /** 公开只读:管理页服务设置的 defaults 要展示部署层并发缺省
   *  (与 TaskService.options 公开同一理由)。 */
  readonly options: IssueFlowOptions;
  private readonly vault: IssueEnvironmentVault;
  private readonly issuesRoot: string;
  private readonly live = new Map<string, LiveIssue>();
  private readonly turning = new Set<string>();
  private recoveryStarted = false;
  /** 证据重试窗的在途定时器(键=会话 id+仓地址,票 82):一仓一表,
   *  重排前清旧,关停统一清——unref 不阻进程,但不留重复轮。 */
  private readonly evidenceRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 数据目录(业务模块库等子系统的根),供路由层读取。 */
  readonly dataDir: string;

  constructor(options: IssueFlowOptions) {
    this.options = options;
    this.dataDir = options.dataDir;
    this.vault = options.vault
      ?? new IssueEnvironmentVault(options.dataDir);
    this.issuesRoot = join(options.dataDir, "issues");
    mkdirSync(this.issuesRoot, { recursive: true });
    if (!options.deferRecovery) this.start();
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /** 重启恢复(#27,与需求侧断点续跑同语义):正在跑的会话重新入队,
   * 由并发额度泵逐个自动续跑(现场 driver 不在就重建,续聊提示词交给
   * 重建的上下文);排队中的保持 queued 原样开跑;旧版本盖在盘上的
   * interrupted 戳(词表已退役)按 running 同一条路处理。
   * waiting_user/suspended 照旧等家人,终态不动。恢复完成补一脚泵——
   * 泵原本只在回合点火/收口被调,启动期没有调用点,不补则重新入队的
   * 会话永远坐着。
   *
   * 正式服务在遗留容器清扫完成后显式调用；幂等避免
   * 启动接线或测试重复调用时把同一问题会话恢复两次。 */
  start(): void {
    if (this.recoveryStarted) return;
    this.recoveryStarted = true;
    this.recover();
  }

  private recover(): void {
    let requeued = 0;
    let keptQueued = 0;
    for (const name of readdirSync(this.issuesRoot)) {
      if (!name.startsWith("issue-")) continue;
      const root = join(this.issuesRoot, name);
      const state = loadState(root);
      if (!state) continue;
      // 旧值按字符串比(interrupted 已不在词表里,类型层面不认它)。
      const diskStatus: string = state.status;
      const resuming = diskStatus === "running" || diskStatus === "interrupted";
      if (resuming) {
        state.status = "queued";
        // 阶段语境(stage/note)原样保留:续聊提示词的「最近阶段」
        // 靠它把现场交给重建的上下文;重启事实走转移台账与开场通知。
        recordTransition(state, {
          source: "platform",
          note: "服务重启,重新入队,平台自动续跑",
        });
        saveState(root, state);
        requeued += 1;
      } else if (state.status === "queued") {
        keptQueued += 1;
      }
      const live: LiveIssue = {
        id: state.id, root, state,
        humanGate: new HumanGate(join(root, "waiting.json")),
        controlEpoch: 0,
        ...(resuming ? { resumeMessage: RESTART_RESUME_NOTICE } : {}),
      };
      this.live.set(state.id, live);
      // 流水线监看续表:deadline 还是原来那张(重启不白送预算);
      // watching=false 的(终态/耗尽)不重挂。多仓各自挂各自的表。
      for (const [repo, watch] of Object.entries(state.pipelines ?? {})) {
        if (state.mode !== "fixed") continue;
        if (watch.watching) {
          this.log(`[issue-flow] ${state.id} 恢复流水线监看(${repo})`
            + ` @ ${watch.sha.slice(0, 12)}`);
          void this.watchPipeline(live, repo, watch.sha);
        } else if (watch.evidence_retry_deadline && !state.gate) {
          // 证据重试窗续算(票 82):截止时间落盘原样——不重置、不白等,
          // 恢复后从剩余时间继续定时重评;到点仍缺才举卡。已举卡(闸在
          // 场)不续算;其余守卫(取消/终态/等作答/换提交)在重评入口。
          this.log(`[issue-flow] ${state.id} 恢复证据重试窗(${repo})`
            + ` @ ${watch.sha.slice(0, 12)},截止 ${watch.evidence_retry_deadline}`);
          this.scheduleEvidenceRetry(live, repo, watch.sha, {
            status: "failed",
            ...(watch.evidence_failure_log
              ? { log: watch.evidence_failure_log } : {}),
          });
        }
      }
    }
    if (requeued || keptQueued) {
      this.log(`[issue-flow] 重启恢复: 续跑 ${requeued} 个、`
        + `排队 ${keptQueued} 个问题会话`);
      // 台账行之后立即点火:构造函数不能 await,泵与 create()/associate()
      // 同款 void 火力——同步段把首批额度占上,余下的在收口时再泵。
      void this.pump();
    }
  }

  // ---- 查询 ----

  list(account?: string): IssueSummary[] {
    const rows = [...this.live.values()].map((item) => this.project(item));
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return account ? rows.filter((row) => row.account === account) : rows;
  }

  /** 容器探活(供工作区回收等外部清扫方做保险判断):会话容器当前
   *  是否在运行。终态会话容器应已停,此探活是 belt-and-suspenders。 */
  hasRunningContainer(id: string): boolean {
    return !!this.live.get(id)?.container?.isAlive;
  }

  private require(id: string): LiveIssue {
    const live = this.live.get(id);
    if (!live) throw new IssueNotFoundError(id);
    return live;
  }

  /** Issue Flow 的前置分析仍独立；进入代码交付后，反馈索引与需求交付
   * 共用同一份 append-only 模型，页面和恢复不再认识第二套状态词。 */
  private feedbackStore(live: LiveIssue): FeedbackStore {
    return new FeedbackStore(join(live.root, "feedback", "index.jsonl"));
  }

  private project(live: LiveIssue): IssueSummary {
    const feedback = this.feedbackStore(live).list();
    return {
      ...summarize(live.state),
      ...(feedback.length ? { feedback } : {}),
    };
  }

  private resolveIssuePipelineFeedback(
    live: LiveIssue,
    repo: string,
    status: FeedbackRecord["status"],
    resolution: string,
  ): void {
    const store = this.feedbackStore(live);
    for (const record of store.list()) {
      if (record.source === "pipeline"
          && record.source_id.startsWith(`${repo}@`)
          && record.status !== "closed") {
        store.resolve(record.id, status, resolution);
      }
    }
  }

  get(id: string): IssueSummary & {
    waiting?: WaitingRecord;
    has_analysis: boolean;
  } {
    const live = this.require(id);
    return {
      ...this.project(live),
      // Agent 卡选项投影时派决策码(前端认码不认文案);平台闸的卡
      // 自带 GATE_OPTIONS 的码,原样在 state.gate 里。
      waiting: withAgentOptionCodes(live.humanGate.pending()[0]),
      has_analysis: existsSync(join(live.root, "issue-analysis.md")),
    };
  }

  /** 会话消息(事件账本投影):user/assistant/decision 三类,尾部截断。
   * 唯一消费者是「耗时与卡点」视图(timeline);详情响应不携带它——
   * 前端的对话内容直接来自现场页签的事件流。 */
  messages(id: string): IssueMessage[] {
    const live = this.require(id);
    const path = join(live.root, "events.jsonl");
    if (!existsSync(path)) return [];
    const messages: IssueMessage[] = [];
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      if (event.kind === "user_message") {
        messages.push({
          role: "user", text: String(payload.text ?? ""), ts: String(event.ts ?? ""),
        });
      } else if (event.kind === "assistant_message") {
        messages.push({
          role: "assistant", text: String(payload.text ?? ""), ts: String(event.ts ?? ""),
        });
      } else if (event.kind === "human_decision") {
        messages.push({
          role: "decision",
          text: `用户决定: ${String(payload.decision ?? "")}`,
          ts: String(event.ts ?? ""),
        });
      }
    }
    return messages.slice(-300);
  }

  /** 会话现场定位(收窄票 #7):材料/事件旁路改由路由直连各自模块后,
   * 这里是路由拿到"哪个会话、现场在哪"的唯一入口。未知会话抛
   * IssueNotFoundError——与原先各透传方法里的 require 同一 404 语义。
   * state 是活引用:材料旁路只读;快速修改写的是仓内文件与人工台账,
   * 不动台账本身。 */
  session(id: string): { state: IssueSessionState; root: string } {
    const live = this.require(id);
    return { state: live.state, root: live.root };
  }

  /** 解压日志档案的属主交接参数(#47):isolation.user 与运行时形态只有
   * 服务知道,而材料路由直连 materials.ts 不经服务转手——写口(解压)
   * 需要交接容器属主时从这里取,与拉仓收口同一来源。 */
  logOwnershipInputs(): {
    user?: string;
    runtime?: ContainerOwnershipRuntime;
  } {
    return {
      user: this.options.isolation?.user,
      runtime: this.options.ownershipRuntime,
    };
  }

  // ---- 视图旁路:耗时与卡点(只读,fail-open);过程文档数据面在 documents.ts ----

  /** 「耗时与卡点」视图:纯函数归纳(见 sessionView.ts),这里只负责
   * 把消息账、状态与在等的问题卡喂给它——面板没有自己的真相。 */
  timeline(id: string): IssueSessionTimeline {
    const live = this.require(id);
    return buildIssueTimeline({
      state: live.state,
      messages: this.messages(id),
      waiting: live.humanGate.pending()[0],
    });
  }

  /** 现场记录导出:事件流逐字 + issue.json 台账 → 单文件 Markdown
   * (人粗读 + 喂 AI 精读复盘,2026-08-28 拍板)。事件流读取容错:
   * 半行/坏行跳过——导出是排障工具,不能自己是第一个炸点。 */
  exportWorksite(id: string): WorksiteRecord {
    const live = this.require(id);
    const path = join(live.root, "events.jsonl");
    const events: SemanticEvent[] = [];
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as SemanticEvent);
        } catch {
          // 写入方可能还在写:宁缺毋炸,坏行跳过。
        }
      }
    }
    return buildWorksiteRecord({ state: live.state, events });
  }

  // ---- 登记 ----

  create(input: IssueCreateInput): IssueSummary {
    const account = input.account?.trim();
    if (!account) throw new IssueControlError("缺少归属账号(工号)");
    const title = input.title?.trim() ?? "";
    // 长度上限已按用户拍板(2026-08-28)去掉:标题只要求必填,长标题
    // 由各消费面(列表卡/通知)自行单行截断;MR 标题遇平台限制再说。
    if (!title) {
      throw new IssueControlError("问题标题必填");
    }
    const ticket = input.ticket?.trim() || undefined;
    if (ticket && !TICKET_PATTERN.test(ticket)) {
      throw new IssueControlError("单号只能是字母数字下划线连字符(如 DTS2026082001317)");
    }
    const explicitRepos = normalizeIssueRepos(input.repoUrl, input.repoUrls);
    const mode: IssueFlowMode =
      input.mode ?? this.options.issueFlowMode?.(account) ?? "free";
    const scenario: IssueScenario | undefined =
      mode === "fixed" ? (ticket ? "ticket" : "no_ticket") : undefined;
    // 模块是一等实体:module_id 必须真实存在且在架,名称由模块库派生
    // (前端传来的 module 文本在带 moduleId 时让位,标签不出现两个真相)。
    let moduleName = input.module?.trim() || undefined;
    let moduleRepos: string[] | undefined;
    const moduleId = input.moduleId?.trim() || undefined;
    // 登记门禁(无单定位的机械真相):无单号登记必须指名业务模块并带上
    // 网管环境——仓的唯一来源是模块绑定,现场凭据发起时就要齐,固定/
    // 自由两模式同等。有单号登记(DTS 页签)不拦:单据自带现场线索,
    // 环境可以在会话内经 env_needed 闸现场补。
    if (!ticket && !moduleId) {
      throw new IssueControlError(
        "无单号登记必须指定业务模块:代码仓从模块绑定带出,"
          + "请回登记页选择模块后再发起");
    }
    if (moduleId) {
      try {
        const module = readBusinessModule(this.options.dataDir, moduleId);
        if (module.status !== "active") {
          throw new IssueControlError(
            `业务模块「${module.name}」已归档,不能用于新问题会话`);
        }
        if (!module.repositories.length) {
          throw new IssueControlError(
            `业务模块「${module.name}」还没有绑定代码仓,请先补绑定再发起`);
        }
        moduleName = module.name;
        moduleRepos = module.repositories;
      } catch (error) {
        if (error instanceof IssueControlError) throw error;
        throw new IssueControlError(
          `业务模块 ${moduleId} 不存在或元数据不可读,请刷新模块列表后重试`);
      }
    }
    if (!ticket && !input.environment) {
      throw new IssueControlError(
        "无单号登记必须配置网管环境"
          + "(地址、页面账号密码与网管后台密码)");
    }
    // 模块带仓:只登记模块没给仓时,按模块绑定整表带出(同样过协议
    // 校验与上限)。"选模块→带仓"在服务端同样成立,不是前端专属糖。
    const repoUrls = !explicitRepos.length && moduleRepos?.length
      ? normalizeIssueRepos(undefined, moduleRepos)
      : explicitRepos;
    // 同账号+同单号至多一个进行中的固定流程会话(2026-08-28 批量发起的
    // 配套守卫):双发起 fail-loud 到具体单,而不是静默开出第二条平行
    // 工作流(分支/MR/流水线监看都会打架)。与 associate() 的单号查重
    // 同一口径。
    if (mode === "fixed" && ticket) {
      const clash = [...this.live.values()].find((item) =>
        item.state.account === account
        && item.state.ticket === ticket
        && !isTerminal(item.state.status));
      if (clash) {
        throw new IssueControlError(
          `该单号已有进行中的问题会话 ${clash.id},同一单号不能重复发起`);
      }
    }
    // 个人凭据前置门禁(2026-08-28 拍板,需求侧 /launch-options 的同款
    // 语义收窄到"这单真的会碰远端仓"):克隆与推送都用发起人身份,
    // 没配令牌就让登记过门,失败发生在首轮回合准备期——那是终态,
    // 整单作废。门关在前面:file:// 本地仓与不碰仓的纯研究不拦
    // (拦了就是误伤),令牌在而邮箱缺同样拦(提交署名与平台归属
    // 都按邮箱对人,缺了它推上去的提交是无主的)。无仓登记(代码仓
    // 推迟到拉取代码仓阶段)自然不拦——闸门补填时会再过同一道检查。
    this.requireGitIdentity(account, repoUrls);
    // 四件套校验先行: mkdir/占号之前打回,半截登记不落任何盘。
    if (input.environment) normalizeEnvironmentInput(input.environment, true);

    const id = this.nextId();
    const root = join(this.issuesRoot, id);
    mkdirSync(root, { recursive: true });
    // 现象描述内嵌截图:把 staging 里的图片复制到会话工作区 issue-images/,
    // description 里的相对路径引用原样保留——AI 侧 inspect_image 直接可用。
    // 同步在状态落盘前:失败只跳过(fail-open),不阻断登记。
    const descriptionText = input.description?.trim() ?? "";
    if (descriptionText) {
      syncIssueImagesToWorkspace({
        description: descriptionText,
        dataDir: this.options.dataDir,
        workspace: root,
        log: (message) => this.log(message),
      });
    }
    const environment = input.environment
      ? this.storeEnvironment(id, input.environment, true)
      : undefined;
    const now = new Date().toISOString();
    const firstStage: FixedStage | "registered" = scenario
      ? fixedStages(scenario)[0]
      : "registered";
    const state: IssueSessionState = {
      id,
      account,
      created_at: now,
      updated_at: now,
      title,
      description: input.description?.trim() ?? "",
      source: input.source ?? "manual",
      ...(ticket ? { ticket } : {}),
      ...(repoUrls.length
        ? { repo_url: repoUrls[0], repo_urls: repoUrls }
        : {}),
      ...(input.baseline?.trim() ? { baseline: input.baseline.trim() } : {}),
      ...(moduleName ? { module: moduleName } : {}),
      ...(moduleId ? { module_id: moduleId } : {}),
      ...(moduleId && input.moduleLocked ? { module_locked: true } : {}),
      ...(environment ? { environment } : {}),
      // 模式一律烙印落盘(free 也记):审计要看"当时是什么模式",
      // 旧现场缺字段读作自由(兼容),不等于新会话不记。
      mode,
      ...(scenario
        ? {
          scenario,
          round: 1,
          // 首阶段直接 in_progress:登记即入场,等 complete_stage 收口
          // 后由 fixedAdvance 接管后续;全 pending 会让进度条首节点
          // 不亮,当前感无处安放。
          stage_states: initStageStates(scenario, 0)
            .map((entry, index) =>
              index === 0 ? "in_progress" as const : entry),
        }
        : {}),
      status: "queued",
      stage: firstStage,
      stage_note: mode === "fixed"
        ? "已登记,固定流程启动"
        : "已登记,准备开始首轮研究",
      stage_at: now,
    };
    if (mode === "fixed" && scenario) {
      recordTransition(state, {
        source: "platform", stage: firstStage,
        note: `固定流程会话已登记(${scenario === "ticket" ? "有单六阶段" : "无单三节点"})`,
      });
    }
    saveState(root, state);
    this.live.set(id, {
      id, root, state,
      humanGate: new HumanGate(join(root, "waiting.json")),
      controlEpoch: 0,
    });
    this.log(`[issue-flow] ${id} 已登记(${ticket ?? "无单号"},${mode === "fixed" ? "固定流程" : "自由探索"}): ${title}`);
    void this.pump();
    return summarize(state);
  }

  private nextId(): string {
    let max = 0;
    for (const name of readdirSync(this.issuesRoot)) {
      const match = /^issue-(\d+)$/.exec(name);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `issue-${max + 1}`;
  }

  /** 个人凭据前置门禁的判定本体:这批仓里只要碰远端(http),发起人
   * 就必须有 Git 令牌与署名邮箱。登记(create)与闸门补填(resolveGate
   * 的 repo_needed 手填路)共用——同一道门不该有两套文案。 */
  private requireGitIdentity(account: string, repoUrls: string[]): void {
    const remoteRepos = repoUrls.filter((url) => /^https?:\/\//i.test(url));
    if (!remoteRepos.length) return;
    const credential = this.options.gitCredential?.(account);
    if (!credential) {
      throw new IssueControlError(
        "Git 令牌未配置(个人设置 → 个人接入):这单要拉取代码仓,"
          + "克隆与推送都用你的身份——配好令牌后再发起");
    }
    if (!credential.email) {
      throw new IssueControlError(
        "个人邮箱未配置(个人设置 → 个人接入):Git 提交署名与平台"
          + "归属都按邮箱对人——配好邮箱后再发起");
    }
  }

  /** 网管环境落盘的唯一路径:两组凭据只进 vault(AES-GCM 按会话隔离的
   * 加密文件),issue.json/公开 API/事件只有引用；随后
   * environmentCredentials 会按 ADR-0003 解密到当前问题的 AI 上下文。
   * 后台凭据(both)供 fetch_logs/build_deploy 消费；页面凭据(page)供
   * 页面操作消费,两组各自成行、可分别解出。登记(withPage)与
   * env_needed 闸作答(只收地址+后台密码,页面字段即便递了也不认)
   * 共用本路径,秘密纪律只有一份。 */
  private storeEnvironment(
    id: string,
    input: IssueEnvironmentInput,
    withPage: boolean,
  ): IssueEnvironmentConfig {
    const parts = normalizeEnvironmentInput(input, withPage);
    const rows = [
      backendVaultRow(parts.name, parts.hosts[0], parts.port,
        parts.backendPassword),
      ...(parts.pagePassword
        ? [pageVaultRow(parts.name, parts.hosts[0], parts.port,
          parts.pageAccount, parts.pagePassword)]
        : []),
    ];
    const refs = this.vault.store(id, rows);
    return {
      credential_ref: refs[0]?.id ?? "",
      name: parts.name,
      hosts: parts.hosts,
      port: parts.port,
      ...(parts.pagePassword
        ? {
          page_account: parts.pageAccount,
          page_credential_ref: refs[1]?.id ?? "",
        }
        : {}),
    };
  }

  /** 登记元信息的网管凭据明文(ADR-0003:网管口令允许进 AI 上下文):
   * 开场词/续聊词的渲染与 get_issue_meta 工具共用同一解密路——后台
   * 凭据按 sopuser 解、页面凭据按组首账号解;解不出(闸未补配/缺组)
   * 按缺省,字段不出现。 */
  private environmentCredentials(live: LiveIssue): IssueEnvCredentials {
    const env = live.state.environment;
    if (!env) return {};
    const backend = env.credential_ref
      ? this.vault.credential(live.id, env.credential_ref, "sopuser")?.password
      : undefined;
    const page = env.page_credential_ref
      ? this.vault.credential(live.id, env.page_credential_ref)?.password
      : undefined;
    return {
      ...(backend ? { backend } : {}),
      ...(page ? { page } : {}),
    };
  }

  /** 网管环境配置(问题卡 env_needed 闸的作答口,POST
   * /issues/:id/environment):登记时没配环境,拉日志/换库的工具现场
   * 举闸后,用户在这里补地址与网管后台密码。密码进 vault 后即清闸并开
   * 平台回合,让 Agent 重试刚才的操作。 */
  attachEnvironment(
    id: string,
    input: IssueEnvironmentInput,
  ): IssueSummary {
    const live = this.require(id);
    const { state } = live;
    const environment = this.storeEnvironment(id, input, false);
    state.environment = environment;
    if (state.gate?.kind === "env_needed") {
      // 闸清在 issue.json(与 answer() 的闸裁决同一纪律)。清闸后
      // waiting_user 的理由消失,状态回落 idle,由平台回合接管。
      delete state.gate;
      if (state.status === "waiting_user") state.status = "idle";
    }
    recordTransition(state, {
      source: "platform",
      note: `网管环境已配置(${environment.hosts.join(", ")})`,
    });
    saveState(live.root, state);
    this.log(`[issue-flow] ${id} 网管环境已配置(${environment.name})`);
    this.startPlatformTurn(live,
      "平台通知: 网管环境已配置(凭据已入 vault;调 get_issue_meta 可查"
        + "登记元信息全量)。请重试刚才的操作——拉日志用 fetch_logs,"
        + "换库部署用 build_deploy。");
    return summarize(state);
  }

  // ---- 会话驱动 ----

  /** 回合启动单点(收窄票 #7):新回合的共有不变量只有这一份——
   * turning 互斥占位、status=running、催办预算清零(预算永不跨回合
   * 传染)、落盘、调度 runTurn、finally 收口+再泵。各入口(登记点火/
   * 作答/闸门裁决/续聊/平台通知)只保留差异部分:开场词、续聊词、
   * 作答重放。入口冲突判守(409 打回/挂便签/排队跳过)留在调用点:
   * 出路语义各不相同,收进来反而要改行为。settle 里的催办/补发续跑
   * 不走这里——那是同一回合的延续,turning 还握着,预算也不清。 */
  private beginTurn(live: LiveIssue, body: () => Promise<Outcome>): void {
    const epoch = live.controlEpoch;
    this.turning.add(live.id);
    live.state.status = "running";
    live.state.nudges = 0;
    saveState(live.root, live.state);
    void this.runTurn(live, body, epoch).finally(() => {
      this.turning.delete(live.id);
      void this.pump();
    });
  }

  /** 续聊形态的回合入口:现场(driver)在场就把话递进去;进程重启后
   * 重建会话,以续聊提示词把话交给重建的上下文。用户主动续聊与平台
   * 通知共用;重启自动续跑(#27)是同一回合体的另一条点火路径,走
   * 泵(见 pump),不在这里——它必须排队等并发额度。 */
  private continueTurn(live: LiveIssue, message: string): void {
    this.beginTurn(live, () => this.resumeTurnBody(live, message));
  }

  /** 续聊/续跑共用的回合体:话递给在场 driver,或重建后以续聊提示词
   * 开回合(issueResumePrompt 带登记元信息与最近阶段,上下文不流失)。 */
  private async resumeTurnBody(
    live: LiveIssue,
    message: string,
  ): Promise<Outcome> {
    await this.ensureContainer(live);
    if (live.driver) return live.driver.continueWith(message);
    const driver = await this.openDriver(live);
    return driver.startResume(issueResumePrompt(live.state, message,
      this.environmentCredentials(live),
      { moonlight: this.moonlightOn(live), workspace: live.root }));
  }

  /** 并发额度:同时进行的回合数(等待用户/闲置/挂起的会话不占额度)。
   *  现读现判:管理页「问题单并发数」旋钮(issue_max_turns)每次点火
   *  都读,改完即生效;缺席退回部署旗 --issue-max-turns,再退缺省 5。 */
  private async pump(): Promise<void> {
    const budget = this.options.settings?.runtime?.().issue_max_turns
      ?? this.options.maxConcurrentTurns ?? 5;
    for (const live of this.live.values()) {
      if (this.turning.size >= budget) break;
      if (live.state.status !== "queued" || this.turning.has(live.id)) continue;
      // 重启续跑与首轮开跑共用同一份额度:带待递话的(恢复路径重新
      // 入队的)走续聊回合体,开场是平台通知;纯排队的是登记首轮,
      // 仍走开场词。待递话消费即清,再泵不重放。
      const resumeMessage = live.resumeMessage;
      live.resumeMessage = undefined;
      this.beginTurn(live, async () => {
        if (resumeMessage) return this.resumeTurnBody(live, resumeMessage);
        // 2026-08-28 拍板:克隆不再是回合前的自动动作——登记的仓由
        // Agent 在「拉取代码仓」阶段调 pull_repo 逐个落地(开场词有令)。
        const driver = await this.openDriver(live);
        return driver.start(live.state.mode === "fixed"
          ? issueFixedOpeningPrompt(live.state,
            this.environmentCredentials(live),
            { moonlight: this.moonlightOn(live), workspace: live.root })
          : issueOpeningPrompt(live.state,
            this.environmentCredentials(live)));
      });
    }
  }

  /** 拉仓(pull_repo 工具的宿主实现;2026-08-28 拍板:克隆是 Agent 的
   * 显式动作,平台只代劳凭据与机械步骤)。登记合并 → 带凭据克隆到
   * repo/<仓名>/ →(有单场景)切好修复分支。回执只含事实;基线分支
   * 缺失不炸——如实报 baselineMiss 退回默认分支,由 Agent 裁决。 */
  private async pullRepoFor(
    live: LiveIssue,
    rawUrl: string,
  ): Promise<{
    dir: string; cloned: boolean; branch?: string;
    head: string; baselineMiss?: string;
  }> {
    const { state } = live;
    const url = validateRepoUrl(rawUrl);
    this.requireGitIdentity(state.account, [url]);
    // 登记合并:与登记/模块绑定同一把尺,超上限整次打回。
    const merged = normalizeIssueRepos(undefined,
      [...(state.repo_urls ?? []), url]);
    state.repo_urls = merged;
    state.repo_url ??= merged[0];
    const repo = issueRepoWorkspaces(state, live.root)
      .find((item) => item.url === url)!;
    let baselineMiss: string | undefined;
    const cloned = !existsSync(join(repo.dir, ".git"));
    if (cloned) {
      this.log(`[issue-flow] ${live.id} 拉仓: ${url}`);
      const common = {
        dataDir: this.options.dataDir,
        targetDir: repo.dir,
        repoUrl: url,
        credential: this.options.gitCredential?.(state.account),
      };
      try {
        await cloneRepository({
          ...common,
          ...(state.baseline ? { baseline: state.baseline } : {}),
        });
      } catch (error) {
        if (!state.baseline) throw error;
        // 基线分支可能不存在(参考 Q7 拍板):退回默认分支克隆,
        // 事实回报,不替 Agent 拍板。
        baselineMiss = state.baseline;
        this.log(`[issue-flow] ${live.id} 基线 ${state.baseline} 不可用,`
          + `退回默认分支克隆 ${url}: ${String(error)}`);
        await cloneRepository(common);
      }
    }
    // 有单场景:修复分支统一由宿主切好(分支名烧着单号,不交给起名);
    // 基线缺失时不建分支,让 Agent 先裁决基线对不对。
    let branch: string | undefined;
    if (!baselineMiss && state.scenario === "ticket" && state.ticket) {
      branch = expectedBranch(state);
      await ensureBranch({
        dataDir: this.options.dataDir,
        repoDir: repo.dir,
        branch,
      });
    }
    // 同单重跑的遗留检测(2026-08-28 事故):上次运行停止/取消前可能
    // 已把同名修复分支推上远端,克隆把它带成 origin/<branch>,而本地
    // 从基线另起——分叉一路憋到 push 才炸。这里把事实带进回执,让
    // Agent 拉仓当下就向用户报告处置,而不是中途回一句"分支已存在"
    // 让人摸不着头脑。
    const remoteBranch = branch
      ? await divergedRemoteBranch(repo.dir, branch)
      : undefined;
    const head = await currentHead(repo.dir);
    // 克隆与切分支都以宿主身份落盘,而容器已经在跑:不把整棵仓交回容器
    // 用户,容器内 git add/commit 就是 Permission denied。收口必须压在
    // 全部宿主 git 写之后(切分支的 checkout 会重写 .git 内部,提前
    // chown 会被原样污染回去),也只能在这里无条件做而不按 cloned 门——
    // 存量 root 仓在下次拉取时顺带修好,幂等 walk 对属主已对的 inode
    // 零写入;非 root 部署守卫直接 false,零开销。
    repairContainerCloneOwnership({
      workspace: live.root,
      dir: repo.dir,
      user: this.options.isolation?.user,
      runtime: this.options.ownershipRuntime,
    });
    return {
      dir: relative(live.root, repo.dir) || repo.dir,
      cloned,
      ...(branch ? { branch } : {}),
      head,
      ...(baselineMiss ? { baselineMiss } : {}),
      ...(remoteBranch ? { remoteBranch } : {}),
    };
  }

  /** 单回合执行骨架:统一失败收口,绝不把异常闷成悬挂状态。
   *
   *  容器生命周期(2026-09-01 拍板,对齐需求流"随任务起、随收口停"):
   *  回合收口**不停容器**——容器随会话存活到终态,回合间隙(idle/
   *  waiting_user)保持原实例,续聊/作答直接复用,消掉两件事:跨回合
   *  "容器已停止"的重建开销与失败面;催办/补发插话同回合接力时
   *  "收口停"与续跑 ensureContainer 的重建竞态。容器自身故障有自愈
   *  闭环:exec 超时/中止由 TaskContainer 销毁自身,外部死亡(OOM)被
   *  exec 前的 assertRunning 探活标 failed——下回合 ensureContainer
   *  检 isAlive 重建。真正的停点只在终态:取消/归档(control)、非问题
   *  归档、挂起、转正收口、服务关停。 */
  private async runTurn(
    live: LiveIssue,
    body: () => Promise<Outcome>,
    epoch: number,
  ): Promise<void> {
    try {
      const outcome = await body();
      if (live.controlEpoch !== epoch) return;
      this.settle(live, outcome);
    } catch (error) {
      if (live.controlEpoch !== epoch) return;
      const detail = error instanceof Error ? error.message : String(error);
      if (live.state.gate) {
        // 举闸异常:gate 在场说明是 raiseEnvNeededGate 抛的,
        // 容器必须保留(用户配好环境后 AI 要重试)。
        live.state.status = "waiting_user";
        live.state.last_reply = live.driver?.finalReply() ?? live.state.last_reply;
      } else {
        live.state.status = "failed";
        live.state.error = detail;
        this.releaseDriver(live);
      }
      saveState(live.root, live.state);
      this.log(`[issue-flow] ${live.id} 回合失败: ${detail}`);
    }
  }

  private settle(live: LiveIssue, outcome: Outcome): void {
    const { state } = live;
    if (outcome.status === "waiting_for_human") {
      state.status = "waiting_user";
    } else if (outcome.status === "turn_finished") {
      // 平台闸在场:回合定格等用户,闸比一切优先(补发插话让位——
      // 闸挂起时 steer 本就进不来)。
      if (state.gate) {
        state.status = "waiting_user";
        state.last_reply = live.driver?.finalReply() ?? state.last_reply;
      } else {
        // 撞在回合间隙的插话可能没送进模型——收口前补发一次。
        const late = live.driver?.takeUndeliveredSteers() ?? [];
        if (late.length) {
          this.log(`[issue-flow] ${live.id} 补发未送达插话 ${late.length} 条`);
          live.state.status = "running";
          saveState(live.root, live.state);
          void this.runTurn(live, async () =>
            live.driver!.continueWith(late.join("\n\n")), live.controlEpoch);
          return;
        }
        // 催办续跑(2026-08-28 拍板 A):模型提前收嘴不等于阶段完成,
        // 阶段真相在平台——没走到出口就把阶段简报砸回去推它继续,
        // 预算内自动续跑,耗尽才落 idle 交还人工。需求流同款机制的移植。
        if (shouldNudgeFixed(state)) {
          state.nudges = (state.nudges ?? 0) + 1;
          if (state.nudges <= NUDGE_BUDGET) {
            this.log(`[issue-flow] ${live.id} 模型提前收嘴,`
              + `第 ${state.nudges}/${NUDGE_BUDGET} 次催办续跑(阶段 ${state.stage})`);
            state.status = "running";
            saveState(live.root, live.state);
            void this.runTurn(live, async () => {
              await this.ensureContainer(live);
              return live.driver!.continueWith(
                fixedNudgeNotice(state, state.nudges!, NUDGE_BUDGET));
            }, live.controlEpoch);
            return;
          }
          state.status = "idle";
          state.stage_note = `模型连续 ${NUDGE_BUDGET} 次提前收嘴,已停机`
            + "——发送「继续」或补充指示,平台才会再推进";
          state.last_reply = live.driver?.finalReply() ?? state.last_reply;
          this.log(`[issue-flow] ${live.id} 催办预算耗尽,转人工(阶段 ${state.stage})`);
        } else {
          state.status = "idle";
          state.last_reply = live.driver?.finalReply() ?? state.last_reply;
        }
      }
    } else {
      state.status = "failed";
      state.error = outcome.detail ?? outcome.reason ?? "会话异常结束";
      this.releaseDriver(live);
    }
    saveState(live.root, live.state);
    // AI 要人拍板才通知(对齐需求侧公共能力);suspended/idle/终态是
    // 结论后的动作与正常交还,不催人。
    if (state.status === "waiting_user") {
      this.notifyWaitingCard(live);
      this.maybeAutoAnswerGate(live);
      // 闸缺席才轮到 Agent 卡(闸优先,两路互斥不重复作答)。
      this.maybeAutoAnswerAgentCard(live);
    }
    if (isTerminal(state.status)) this.releaseDriver(live);
  }

  /** 等待卡 → 小鲁班(需求侧 notifyWaiting 的同款公共能力)。两条纪律:
   * - 旁路 fail-open:投递失败只记日志,回合状态一字不动;
   * - 幂等靠 notifier 按 waiting_id 去重,恢复重放不重复轰炸。
   * 闸卡与 Agent 卡并存时闸优先——与作答分派(answer)同一优先级;
   * 通知里只给人话文案:决策码是页面作答协议,发给用户只会把人看懵。 */
  private notifyWaitingCard(live: LiveIssue): void {
    const { notifier } = this.options;
    if (!notifier) return;
    const { state } = live;
    const gate = state.gate;
    const record = gate ? undefined : live.humanGate.pending()[0];
    if (!gate && !record) return;
    const questions: NotifyQuestion[] = gate
      ? gate.question.questions.map((item) => ({
          question: item.question,
          options: item.options.map((option) => option.label),
        }))
      : agentCardQuestions(record!).map((item) => ({
          question: String(item.question ?? ""),
          options: (item.options ?? []).map(String),
        }));
    notifier.notifyWaiting({
      waitingId: gate ? gate.id : record!.waiting_id,
      stateVersion: gate ? gate.state_version : record!.state_version,
      taskId: live.id,
      subject: this.issueSubject(live),
      account: state.account,
      step: state.stage_note || state.stage,
      context: gate ? gate.context : record?.context,
      questions,
      summary: "问题处理需要你决策",
      link: this.issueLink(live.id),
    }).catch((error) =>
      this.log(`[issue-flow] ${live.id} 等待卡通知失败(旁路,流程照走): `
        + String(error)));
  }

  /** 月光轴现读现判:会话开/续聊渲染节奏、闸代答判定都读当下值,
   * 用户改设置即刻生效(与需求流"每张卡到达时现读"同纪律)。 */
  private moonlightOn(live: LiveIssue): boolean {
    return this.options.moonlight?.(live.state.account) === true;
  }

  /** 会话工作台深链(等待卡/代答的小鲁班通知共用;尾部斜杠归一)。 */
  private issueLink(issueId: string): string {
    return `${(this.options.linkBase ?? "").replace(/\/+$/, "")}`
      + `/issues/${encodeURIComponent(issueId)}`;
  }

  /** skill 圈选入口闸(ADR-0011):complete_stage 推进进 analyze 时由
   * 工具层调用。现读现判五条件:固定流程 + 注册表声明本阶段有入口闸
   * + 月光关 + 台账未圈选过 + 盘上无其他闸;再扫描已拉仓的
   * `.cac/skills/` 与 `.agents/skills/`(.cac 同名优先,见扫描处),
   * 非空才真举。同名跳过/扫描为空都留一行转移账(现场可查),不举卡
   * ——浪费用户一次点击的卡不是好卡。返回是否举了(工具回执据此叫
   * Agent 停回合)。 */
  private raiseSkillSelectionGate(live: LiveIssue): boolean {
    const { state } = live;
    if (state.mode !== "fixed" || !state.scenario) return false;
    if (stageEntryGate(state.stage as FixedStage) !== "skill_select") {
      return false;
    }
    if (this.moonlightOn(live)) return false;
    if (state.skill_selection) return false;
    if (state.gate) return false;
    const { choices: skills, warnings } = this.scanBusinessSkills(live);
    // 跨目录同名跳过必须留痕(2026-09-03 拍板,不静默):转移账一行
    // + 平台日志,团队得能从现场账查到".agents 里那个为什么没上清单"。
    if (warnings.length) {
      recordTransition(state, {
        source: "platform",
        note: `skill 扫描告警:${warnings.join(";")}`,
      });
      for (const warning of warnings) {
        this.log(`[issue-flow] ${live.id} skill 扫描告警: ${warning}`);
      }
    }
    if (!skills.length) {
      recordTransition(state, {
        source: "platform",
        note: "进入问题分析:已拉仓内未发现业务 skill"
          + "(.cac/skills、.agents/skills),AI 按取用次序自主定位",
      });
      return false;
    }
    raiseGate(
      state,
      "skill_select",
      "进入问题分析:勾选要 AI 必读的仓内排障知识(可多选)",
      undefined,
      "以下是从已拉取的仓里扫描到的业务 skill(.cac/skills 与"
        + ".agents/skills,同名按 .cac 优先)。勾选的会成为 AI 的必读"
        + "材料;一个都不选则 AI 按方法论取用次序自主决定。",
      undefined,
      skills,
    );
    this.log(`[issue-flow] ${live.id} 举 skill 圈选闸:`
      + ` ${skills.map((skill) => skill.name).join("、")}`);
    return true;
  }

  /** 扫描已拉仓工作区里的业务 skill(ADR-0011):repo/<仓名>/ 下的
   * `.cac/skills/<名>/SKILL.md` 与 `.agents/skills/<名>/SKILL.md`
   * 标准一层目录(2026-09-03 拍板扩为两根,pi/.claude 不进问题流)。
   * 固定优先级 **`.cac` 优先**(存量团队行为不变),`.agents` 补位:
   * 同仓内跨目录同名时 `.cac` 版本胜出,`.agents` 版本跳过并出告警
   * (warnings,由调用方留痕,不静默)。本地文件系统扫描,零新增网络
   * 路径——仓已落地,这就是 Agent 视角的同一份事实(需求侧走网络
   * 发现是因为下单时仓还没 clone,威胁模型不同)。 */
  private scanBusinessSkills(
    live: LiveIssue,
  ): { choices: IssueSkillChoice[]; warnings: string[] } {
    const choices: IssueSkillChoice[] = [];
    const warnings: string[] = [];
    for (const repo of issueRepoWorkspaces(live.state, live.root)) {
      const claimed = new Set<string>();
      for (const root of SKILL_SCAN_ROOTS) {
        const skillsRoot = join(repo.dir, root.dir);
        let entries: import("node:fs").Dirent[];
        try {
          entries = readdirSync(skillsRoot, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillFile = join(skillsRoot, entry.name, "SKILL.md");
          if (!existsSync(skillFile)) continue;
          if (claimed.has(entry.name)) {
            warnings.push(`技能 ${entry.name} 在 ${root.label}`
              + ` 有同名定义,按 .cac 优先已跳过`
              + `(${SKILL_SCAN_ROOTS[0].label} 版本生效;仓 ${repo.url})`);
            continue;
          }
          claimed.add(entry.name);
          choices.push({
            path: relative(live.root, skillFile).split("\\").join("/"),
            repo: repo.url,
            name: entry.name,
            description: skillDescription(skillFile),
          });
        }
      }
    }
    return { choices, warnings };
  }

  /** 业务知识资产定格(ADR-0012):进入 analyze 时按**当时**的绑定
   * 模块从发布库选取并只读投影(.mae-flow-work/business-modules/),
   * 清单落台账——重启/续聊按台账渲染地图,版本不随发布库中途更新
   * 漂移(与需求侧"按任务固定版本"同一纪律)。与 skill 圈选闸同一
   * 扫描点但**不分介入档**:它不举卡、不等人,月光开档照常定格。
   * 没绑模块=静默缺席;模块库故障 fail-open(知识旁路不能卡会话),
   * 留一行转移账。返回是否定格到了资产。 */
  private freezeBusinessKnowledge(live: LiveIssue): boolean {
    const { state } = live;
    if (state.mode !== "fixed" || !state.scenario) return false;
    if (state.stage !== "analyze") return false;
    if (state.business_knowledge) return false;
    const repositories = state.repo_urls?.length
      ? [...state.repo_urls]
      : state.repo_url ? [state.repo_url] : [];
    try {
      const selected = snapshotBusinessModules({
        dataDir: this.options.dataDir,
        taskWorkspace: live.root,
        moduleIds: state.module_id ? [state.module_id] : [],
        repositories,
      });
      const materialized = materializeBusinessModuleKnowledge({
        selected,
        taskWorkspace: live.root,
        runtimeWorkspace: live.root,
      });
      const entries: IssueBusinessKnowledgeEntry[] = materialized.entries
        .map(({ path: _path, ...rest }) => rest);
      state.business_knowledge = {
        at: new Date().toISOString(),
        entries,
      };
      if (entries.length) {
        recordTransition(state, {
          source: "platform",
          note: `进入问题分析:业务知识资产已定格(${entries.length} 项,`
            + `绑定模块 ${selected.map((module) => module.name).join("、")})`,
        });
      }
      for (const warning of materialized.warnings) {
        this.log(`[issue-flow] ${live.id} 业务知识投影告警: ${warning}`);
      }
      return entries.length > 0;
    } catch (error) {
      recordTransition(state, {
        source: "platform",
        note: `业务知识资产定格失败(旁路,不挡分析): ${
          error instanceof Error ? error.message : String(error)}`,
      });
      this.log(`[issue-flow] ${live.id} 业务知识定格失败: `
        + String(error instanceof Error ? error.message : error));
      return false;
    }
  }

  /** 月光免审批的闸代答(ADR-0006):只代答"确认类"闸——
   * analysis_confirm 全量(推荐码表定死 confirm);conclude 仅提案
   * non_issue 且自报高置信(闭环无下游闸,分级保守)。env_needed/
   * env_verify 问的是用户的事实(环境配置/验证结果),永不代答;
   * push_confirm 是用户显式开启的过目意志,同样永不代答(ADR-0009);
   * pipeline_unfixable/pipeline_evidence 问的是"人是否已在交付平台
   * 处理/豁免"与"报错原文"——都是只有人拿得到的人工事实(票 03),
   * 与 env_needed/env_verify 同类,永不代答。
   * 作答 defer 到回合收口(turning 释放)之后,走 answer() 同一裁决
   * 通道——现场账、通知、续跑与真人作答同款,事后可经现有回退推翻。 */
  private maybeAutoAnswerGate(live: LiveIssue): void {
    const { state } = live;
    const gate = state.gate;
    if (!gate) return;
    // push_confirm 永不代答(ADR-0009,显式裁定):推送过目是用户显式
    // 开启的"我要亲自看一眼"——更具体的意志赢过月光的免审批,与需求
    // 流 push 前确认同一裁定。守卫放在月光判定之前:这条路径连"读
    // 设置"都不必,过目卡在任何介入档位都只等真人。
    if (gate.kind === "push_confirm") return;
    // skill_select 永不代答(ADR-0011):多选圈选卡只在月光关时举起,
    // 推荐项代答只认单选选项题(ADR-0006 整卡纪律)——这里显式守卫,
    // 防月光中途打开时把已挂起的圈选卡追溯代答掉。
    if (gate.kind === "skill_select") return;
    // 流水线人工闸永不代答(票 03):不可修卡问的是"人处理/豁免了没"
    // ——答"已处理"就是人工事实声明,月光代答等于机器替人声明平台侧
    // 已处理;证据回灌卡的报错原文只有人粘贴得出来。两类都放在月光
    // 判定之前,任何介入档位都只等真人(与 push_confirm 同款守卫位)。
    if (gate.kind === "pipeline_unfixable") return;
    if (gate.kind === "pipeline_evidence") return;
    if (!this.moonlightOn(live)) return;
    // 检视回合的确认卡永不代答(ADR-0007):用户提了意见、agent 按意见
    // 修订重提,这张卡就是"意见是否被吸收"的复核点——代答放行等于
    // 检视闭环被架空。普通流程(无检视回合)不受影响。
    if (state.review_active === true) return;
    let code: string | undefined;
    if (gate.kind === "analysis_confirm") code = "confirm";
    else if (gate.kind === "conclude"
        && gate.proposal?.conclusion === "non_issue"
        && gate.proposal?.confidence === "high") code = "non_issue";
    if (!code) return;
    const issueId = live.id;
    const version = gate.state_version;
    const kind = gate.kind;
    this.log(`[issue-flow] ${issueId} 月光免审批:闸 ${kind} 自动作答(${code})`);
    setTimeout(() => {
      try {
        const summary = this.answer(issueId, {
          state_version: version,
          code,
          decision: `月光免审批自动确认(${gateOptionLabel(kind, code)})`,
        });
        void this.options.notifier?.notifyOutcome({
          taskId: issueId,
          account: state.account,
          status: summary.status,
          summary: `月光免审批:分析结论已自动确认(${gateOptionLabel(kind, code)})`,
          link: this.issueLink(issueId),
        }).catch(() => undefined);
      } catch (error) {
        this.log(`[issue-flow] ${issueId} 月光自动作答失败(旁路,卡留待人): `
          + String(error instanceof Error ? error.message : error));
      }
    }, 0);
  }

  /** 月光免审批的 Agent 卡代答(ADR-0006 口径从平台闸扩至问答卡):
   * Agent 自举的 AskUserQuestion 卡,卡上每题都是选项题且都带
   * recommended(ADR-0004 的「AI 推荐」——校验层保证选项题必带、
   * trim 后逐字命中)时,按推荐项的决策码整卡代答。整卡纪律:含
   * 开放题、recommended 缺失/不命中(历史卡防身,新卡进不来)一律
   * 整卡等人,不做半卡代答——机器只复述 AI 明示的推荐,不替人拼凑
   * 方案;开放题与"问用户事实"的闸同则,永不代答。
   * 守卫顺序:平台闸优先(盘上有闸走 maybeAutoAnswerGate,与 answer()
   * 的作答分派同一优先级)→ 月光现读现判 → 检视回合整段跳过
   * (ADR-0007 口径延伸:检视回合的卡是"意见是否被吸收"的复核点)。
   * 只在卡落地的 settle 时刻判定一次:已挂起的卡不追溯代答,月光
   * 中途打开对存量卡无效(与需求流同口径)。作答走 answer() 同一
   * 通道——状态版本先到生效、decodeAgentDecision 还原选项原文入账、
   * 续跑、事后可经现有回退推翻;defer 到回合收口(turning 释放)之后,
   * 失败旁路 fail-open,卡留待人。留痕落 notes:decision 位被 answers
   * 的码还原结果占用(与真人页面作答同形),notes 是本次入账唯一
   * 空着的留痕位,过程问答与现场导出都投影它。 */
  private maybeAutoAnswerAgentCard(live: LiveIssue): void {
    const { state } = live;
    if (state.gate) return;
    if (!this.moonlightOn(live)) return;
    if (state.review_active === true) return;
    const record = live.humanGate.pending()[0];
    if (!record) return;
    const questions = agentCardQuestions(record);
    if (!questions.length) return;
    const answers: Record<string, string> = {};
    const recommended: string[] = [];
    for (let index = 0; index < questions.length; index += 1) {
      const item = questions[index];
      const options = item.options ?? [];
      // 开放题(无 options)整卡等人:机器不替人写自由文本。
      if (!options.length) return;
      // 推荐必须命中(recommendedIndex 与投影层同一把尺);缺失或
      // 不命中整卡等人,宁人工勿猜。
      const hit = recommendedIndex(item.options, item.recommended);
      if (hit < 0) return;
      answers[String(index)] = agentOptionCode(index, hit);
      recommended.push(options[hit]);
    }
    const issueId = live.id;
    const version = record.state_version;
    const trace = `月光免审批自动作答(推荐项:${recommended.join("、")})`;
    this.log(`[issue-flow] ${issueId} 月光免审批:问题卡 ${record.waiting_id}`
      + ` 按推荐项自动作答(${recommended.join("、")})`);
    setTimeout(() => {
      try {
        const summary = this.answer(issueId, {
          state_version: version,
          answers,
          notes: trace,
        });
        void this.options.notifier?.notifyOutcome({
          taskId: issueId,
          account: state.account,
          status: summary.status,
          summary: `月光免审批:问题卡已按推荐项自动作答`
            + `(${recommended.join("、")})`,
          link: this.issueLink(issueId),
        }).catch(() => undefined);
      } catch (error) {
        this.log(`[issue-flow] ${issueId} 月光自动作答失败(旁路,卡留待人): `
          + String(error instanceof Error ? error.message : error));
      }
    }, 0);
  }

  private releaseDriver(live: LiveIssue): void {
    live.driver?.dispose();
    live.driver = undefined;
  }

  /** 确认容器真正删除后才清句柄。失败时保留句柄，取消/关停可以重试，
   * 不能先把内存引用扔掉再把“已取消”返回给用户。 */
  private async stopContainer(live: LiveIssue): Promise<void> {
    const container = live.container;
    if (!container) return;
    await container.stop();
    if (live.container === container) live.container = undefined;
  }

  /** 阶段自然收口仍不阻塞业务答复，但失败必须留住句柄并明确记账；服务
   * 关停或用户取消会再次回收。 */
  private stopContainerInBackground(live: LiveIssue, reason: string): void {
    void this.stopContainer(live).catch((error) =>
      this.log(`[issue-flow] ${live.id} ${reason}容器停止失败(保留待重试): ${
        String(error)}`));
  }

  private modelChoice(): { provider: string; model: string; json: Record<string, unknown> } {
    const fromSettings = this.options.settings?.models() ?? {};
    return {
      provider: fromSettings.provider ?? this.options.provider,
      model: fromSettings.model ?? this.options.model,
      json: fromSettings.json ?? this.options.modelsJson,
    };
  }

  /** 当前生效的视觉角色(TaskService.activeVisionChoice 的同款组装):角色必须
   * 指向 models.json 中明确声明支持图片的模型,配置漂移时宁可不暴露
   * 工具,也不把图片误发给文本模型。缓存落会话工作区(与需求侧
   * workspace/vision-cache 同一约定;代码仓在其下的 repo/ 子目录,
   * 缓存不会被推送或结论文档卷走)。
   *
   * 来源优先级与 TaskService 一致:管理页 settings.vision 优先于部署旗标
   * --vision-provider/--vision-model。管理页配的视觉模型必须对问题流生效,
   * 否则问题会话的 inspect_image 永远不注入(用户配了却看不到工具)。 */
  private visionCapability(workspace: string): VisionCapabilityConfig | undefined {
    const choice = this.options.settings?.models().vision ?? this.options.vision;
    if (!choice?.provider || !choice?.model) return undefined;
    const spec = (this.modelChoice().json as {
      providers?: Record<string, { models?: Array<{
        id?: string; input?: string[];
      }> }>;
    }).providers?.[choice.provider]?.models?.find((item) =>
      String(item?.id ?? "") === choice.model);
    return Array.isArray(spec?.input) && spec.input.includes("image")
      ? { choice, cacheDir: join(workspace, "vision-cache"), timeoutMs: 45_000 }
      : undefined;
  }

  /**
   * 把 ops 二进制复制到会话工作区 .ops-tools/(workspace 同路径挂载进容器,
   * 容器内就能直接执行)。只在有 isolation 且配了 opsToolsDir 时做。
   */
  private stageOpsBinaries(live: LiveIssue): void {
    const toolsDir = this.options.opsToolsDir;
    if (!toolsDir || !this.options.isolation) return;
    const destDir = join(live.root, ".ops-tools");
    mkdirSync(destDir, { recursive: true });
    const binName = process.platform === "win32"
      ? ["fetch-logs.exe", "build-deploy.exe"]
      : process.arch === "arm64"
        ? ["fetch-logs-linux-arm64", "build-deploy-linux-arm64"]
        : ["fetch-logs-linux-amd64", "build-deploy-linux-amd64"];
    for (const name of binName) {
      const src = join(toolsDir, name);
      if (!existsSync(src)) continue;
      const dest = join(destDir, name);
      copyFileSync(src, dest);
      chmodSync(dest, 0o755);
    }
  }

  /**
   * 为会话构造容器内执行的 ops 工具。把 live.container.exec 包装成
   * ContainerExec 接口(收集 stdout/stderr),再交给 createGoOpsTools。
   */
  private createSessionOps(live: LiveIssue): IssueOpsTools | undefined {
    const toolsDir = this.options.opsToolsDir;
    if (!toolsDir || !live.container) return this.options.opsTools;
    // 不捕获容器快照:容器可能因超时/OOM 停掉后被 ensureContainer 重建,
    // live.container 指向新实例。闭包捕获旧引用会永远调已死的容器。
    // 每次 exec 动态读 live.container,拿到当前实例。
    const containerExec: ContainerExec = {
      async exec(command, cwd, opts) {
        const container = live.container;
        if (!container) {
          throw new Error("会话容器已释放,无法执行运维命令");
        }
        let stdout = "";
        let stderr = "";
        const { exitCode } = await container.exec(command, cwd, {
          onData: (data: Buffer) => {
            const text = data.toString("utf-8");
            // docker exec 的 stdout/stderr 混在一起,靠前缀粗分。
            // ops 二进制输出量不大(8MB 上限),收集完整文本够用。
            stdout += text;
          },
          ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
          ...(opts.privilegedEnv ? { privilegedEnv: opts.privilegedEnv } : {}),
        });
        return { exitCode, stdout, stderr };
      },
    };
    return createGoOpsTools({
      toolsDir,
      containerExec,
      workspace: live.root,
      log: (message) => this.log(message),
    });
  }

  private async ensureContainer(live: LiveIssue): Promise<void> {
    if (!this.options.isolation) return;
    // 容器可能因为超时/OOM/外部因素已 stopped——引用还在但 lifecycle
    // 不再 running。检查并重建,避免后续 exec 报"容器未运行"。
    if (live.container && live.container.isAlive) return;
    if (live.container) {
      this.log(`[issue-container] ${live.id} 容器已停(lifecycle≠running),重建`);
      live.container = undefined;
    }
    const isolation = this.options.isolation;
    const instance = taskContainerInstance(this.options.dataDir);
    // 分仓构建缓存挂载:与需求侧共用 perRepoBuildCacheMounts
    // (2026-09-03, issue #78 抽取;防覆盖守卫、合并顺序、touch/mkdir
    // 时机都在共享函数里,两侧不再各养一份)。issueFlow 容器内要跑
    // mvn clean package(build_deploy 工具),没有 Maven 仓库挂载就找
    // 不到 parent POM。cacheKey 按会话首个仓,缺了退会话 id。
    const mounts = perRepoBuildCacheMounts({
      cacheRoot: isolation.cacheRoot,
      cacheKeySource: live.state.repo_url
        ?? live.state.repo_urls?.[0] ?? live.id,
      volumes: isolation.volumes,
      seedEnvironment: isolation.environment,
      // C++ Maven 插件约定 ${project.basedir}/../cpp_sdk_repository;
      // issueFlow 仓在 live.root/repo/<仓名>/,所以 SDK 缓存挂在
      // live.root/repo/cpp_sdk_repository,多仓场景所有仓共享同一处
      // ——与单仓语义天然一致。
      cppSdkDestination: join(live.root, "repo", "cpp_sdk_repository"),
      ccacheBaseDirSource: live.root,
      // 问题流没有宿主身份透传、防覆盖报错回显去尾斜杠形态:
      // 两个旗子都缺席,正是抽取前这里的既有行为。
    });
    const volumes = mounts.volumes;
    const environment = mounts.environment;
    const build: IssueContainerBuild = {
      image: isolation.image,
      workspace: live.root,
      name: `mfc-${instance.namePrefix}-${live.id}`,
      log: (message) => this.log(`[issue-container] ${message}`),
      volumes,
      // user 必须随 limits 传到 docker run(2026-08-29 真实环境实测:
      // 漏传使容器落回镜像默认用户,安全自检"Config.User 为空或为
      // root/0"拒绝运行——需求侧同环境能跑正是它传了)。
      limits: {
        memory: isolation.memory,
        cpus: isolation.cpus,
        pidsLimit: isolation.pidsLimit,
        user: isolation.user,
      },
      options: {
        network: isolation.network,
        ...(Object.keys(environment).length > 0 ? { environment } : {}),
        // ownership 标签与需求侧 createTaskContainer 同一套。少了它们,
        // kill -9 后的启动清扫(按 instance 指纹过滤)整批看不见 issue
        // 容器——每次硬重启漏一批,宿主内存被静默吃光(2026-08-29
        // 部署审计实锤)。role=issue 已列入清扫白名单 MANAGED_ROLES。
        labels: {
          "com.mae-flow-cloud.instance": instance.fingerprint,
          "com.mae-flow-cloud.role": "issue",
          "com.mae-flow-cloud.task": live.id,
        },
      },
    };
    const container = isolation.containerFactory
      ? isolation.containerFactory(build)
      : new TaskContainer(build.image, build.workspace, build.name,
          build.log, build.volumes, build.limits, build.options);
    // root 守护进程 + 非 root 容器用户时,把工作区属主在 docker run
    // 前交给容器用户(与需求侧同款;非 root 服务自判 active:false 跳过)。
    const prepared = prepareContainerHostPaths({
      workspace: live.root,
      volumes: volumes,
      user: isolation.user,
      markerRoot: join(this.options.dataDir, ".container-ownership"),
      // cacheRoot 在场时,缓存目录会被 chown 给容器用户——不加这行
      // /cache/maven 属主留 root,mfc 无法创建 repository 子目录。
      ...(isolation.cacheRoot ? { cacheRoot: isolation.cacheRoot } : {}),
    });
    if (prepared.active
        && (prepared.workspaceEntries || prepared.cacheTrees)) {
      this.log(`[issue-container] ${live.id} 属主准备: `
        + `workspace=${prepared.workspaceEntries},`
        + `owner=${prepared.owner!.uid}:${prepared.owner!.gid}`);
    }
    // Maven settings.xml 通常以只读 volume 挂入容器。如果宿主文件是
    // 640 root:root,容器用户 mfc 读不了——entrypoint 的 [ -r ] 检查
    // 失败,不创建 ~/.m2/settings.xml 软链,Maven 找不到内部仓库配置,
    // parent POM 不可解析。服务以 root 运行,启动前确保世界可读。
    const mavenSettingsVolume = volumes.find(
      (v) => v.split(":")[1]?.replace(/\/+$/, "") === "/etc/mae-flow/maven/settings.xml",
    );
    if (mavenSettingsVolume) {
      const settingsPath = mavenSettingsVolume.split(":")[0];
      if (existsSync(settingsPath)) {
        const stat = statSync(settingsPath);
        if (!(stat.mode & 0o044)) {
          chmodSync(settingsPath, stat.mode | 0o044);
          this.log(`[issue-container] ${live.id} Maven settings.xml 权限修正: `
            + `${settingsPath} 添加世界可读(原 0${(stat.mode & 0o777).toString(8)})`);
        }
      }
    }
    await container.start();
    live.container = container;
    // /etc/profile.d/mfc-env.sh 把 TMPDIR 设成 /tmp/mae-flow-build,但该
    // 目录不存在。登录 shell(sh -lc)会 source profile 导致 TMPDIR 指向
    // 不存在的路径,build-deploy 二进制用 TMPDIR 创建临时目录时 stat 失败。
    // 容器启动后通过 exec 建出这个目录(tmpfs 不在 workspace 挂载内,宿主
    // 侧无法直接 mkdir)。
    try {
      await container.exec(
        "mkdir -p /tmp/mae-flow-build",
        live.root,
        { onData: () => {}, timeout: 5 },
      );
    } catch { /* best-effort; 目录可能已存在或容器未启用 exec */ }
    // ops 二进制分发到 workspace(容器内同路径可执行)
    this.stageOpsBinaries(live);
  }

  private async openDriver(live: LiveIssue): Promise<CloudSession> {
    if (live.driver) return live.driver;
    await this.ensureContainer(live);
    const agentDir = join(live.root, "pi-agent");
    mkdirSync(agentDir, { recursive: true });
    const model = this.modelChoice();
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.json), {
      mode: 0o600,
    });
    const skillPaths = materializeIssueSkills(live.root);
    this.log(`[issue-flow] ${live.id} 装载技能: ${
      skillPaths.map((path) => path.split("/").at(-2)).join(", ")}`);
    const service = this;
    // 团队货架 skill 进问题会话(ADR-0005):问题域知识上下文=登记的
    // 关联仓 + 绑定的业务模块;匹配走 issue 口径(通用工程知识豁免、
    // 技术栈维度不参与)。部署源与需求侧同一个 dataDir/skills。
    const knowledgeContext = issueKnowledgeContext(live.state);
    const context: IssueToolContext = {
      state: live.state,
      workspace: live.root,
      dataRoot: this.options.dataDir,
      persist: () => saveState(live.root, live.state),
      ops: this.createSessionOps(live) ?? this.options.opsTools,
      dts: this.options.dts,
      platformUrl: this.options.platformUrl,
      environmentPassword: () => {
        const ref = live.state.environment?.credential_ref;
        return ref
          ? service.vault.credential(live.id, ref, "sopuser")?.password
          : undefined;
      },
      // 登记元信息的页面密码(ADR-0003 明文进上下文;闸补配的环境
      // 没有页面凭据组,按缺省)。
      pagePassword: () => {
        const ref = live.state.environment?.page_credential_ref;
        return ref
          ? service.vault.credential(live.id, ref)?.password
          : undefined;
      },
      gitCredential: () =>
        this.options.gitCredential?.(live.state.account),
      // 推送前过目(交付轴,现读现判):工具执行点读当下设置,用户改
      // 设置即刻生效(与月光同一纪律)。
      pushConfirmation: () =>
        this.options.pushConfirmation?.(live.state.account) === true,
      // 月光现值(过程轴,现读现判):skill 圈选入口闸的举卡条件之一。
      moonlight: () => this.moonlightOn(live),
      // skill 圈选入口闸(ADR-0011):complete_stage 推进进 analyze 时
      // 调用,service 现读现判决定举不举(见 raiseSkillSelectionGate)。
      raiseSkillSelection: () => this.raiseSkillSelectionGate(live),
      // 业务知识资产定格(ADR-0012):进 analyze 时按绑定模块定格资产
      // 库知识并落台账;不分介入档,缺席静默(见 freezeBusinessKnowledge)。
      freezeBusinessKnowledge: () => this.freezeBusinessKnowledge(live),
      // 业务知识地图(ADR-0012):analyze 回执注入段——台账资产 + 仓内
      // docs/ 现扫,两源皆空为空串。
      businessKnowledgeBrief: () =>
        businessKnowledgeLines(live.state, live.root).join("\n"),
      // 拉仓工具的宿主实现(克隆+登记+建分支,凭据止步宿主)。
      pullRepo: (url: string) => service.pullRepoFor(live, url),
      // 固定流程:MR 建成→对该仓启动流水线监看(多仓各自挂表)。
      onMrCreated: (repo: string) => service.armPipelineWatch(live, repo),
      log: (message) => this.log(message),
    };
    live.toolContext = context;
    const isolation = this.options.isolation;
    const bashOperations: import("@earendil-works/pi-coding-agent").BashOperations | undefined =
      isolation
        ? {
            exec: (command, dir, execOptions) => {
              if (!live.container) {
                throw new Error("会话容器不在场,拒绝执行(回合开始前应已拉起)");
              }
              return live.container.exec(command, dir, execOptions);
            },
          }
        : undefined;
    const sessionOptions: import("../sessionDriver.ts").CloudSessionOptions = {
      taskId: live.id,
      workspace: live.root,
      agentDir,
      // 改编版 playbook 技能(精确到 SKILL.md 文件的 allowlist 形态)。
      repositorySkillPaths: skillPaths,
      // 团队货架 skill(通用定位类知识的问题会话供给线,ADR-0005)。
      hostSkillsDir: join(this.options.dataDir, "skills"),
      knowledgeContext,
      knowledgeScope: "issue",
      provider: model.provider,
      model: model.model,
      eventLog: new EventLog(join(live.root, "events.jsonl")),
      transcript: new TranscriptStore(join(live.root, "transcript.jsonl"), "main"),
      gate: new GateService({
        // 问题会话的可达边界=整个会话工作区(代码仓 + local-logs +
        // issue-analysis.md 都在里面)。台账类文件由 GateService 的
        // 宿主账本规则拒写;问题域追加自己的账本与技能目录——
        // issue.json 是推送门禁的依据,skills/ 是行为契约,都不能
        // 让 Agent 自己改;货架 skill 快照(.mae-flow-work/host-skills)
        // 与业务知识投影(.mae-flow-work/business-modules,ADR-0012)
        // 同罪:只读投影,Agent 没有写它的理由。
        workspace: live.root,
        cwd: live.root,
        extraLedgerFiles: ["issue.json", "issue.json.tmp"],
        extraLedgerDirs: ["skills", ".mae-flow-work/host-skills",
          ".mae-flow-work/business-modules"],
        failClosed: false,
        log: (message) => this.log(`[issue-gate] ${message}`),
      }),
      humanGate: live.humanGate,
      allowHumanQuestions: true,
      allowSubagents: false,
      extraTools: createIssueTools(context),
      // 视觉旁路(与需求侧同一套配置语义):配了有效角色才注入
      // inspect_image,主上下文只收文字结论。
      vision: this.visionCapability(live.root),
      currentStep: () => live.state.stage_note || live.state.stage,
      compactAnchor: () => `问题会话「${live.state.title}」;`
        + `阶段 ${live.state.stage};单号 ${live.state.ticket ?? "未绑定"}`,
      ...(bashOperations ? { bashOperations } : {}),
      ...(isolation?.user
        ? {
            afterFileMutation: (path: string) => {
              repairContainerMutationOwnership({
                workspace: live.root, path, user: isolation.user,
              });
            },
          }
        : {}),
      log: (message) => this.log(`[issue-session] ${message}`),
    };
    const driver = await CloudSession.create(sessionOptions);
    live.driver = driver;
    return driver;
  }

  // ---- 用户输入三通道:作答 / 插话 / 续聊 ----

  answer(id: string, input: {
    state_version: number;
    /** 人话答复:现场账与续聊提示词的显示/自由作答文本;闸卡按码作答
     * 时可缺席(码能从注册表反查文案)。 */
    decision?: string;
    /** 平台闸的决策码(单题卡):裁决按它单点分派,文案不是匹配键。 */
    code?: string;
    /** Agent 问题卡逐题作答:键=题号,值=决策码或自由作答文本。 */
    answers?: Record<string, string>;
    /** skill 圈选闸(ADR-0011)的勾选清单:必须是闸上 skills path 的
     * 子集;缺席/空=「都不用」,AI 按取用次序自主。 */
    selection?: string[];
    notes?: string;
  }): IssueSummary {
    const live = this.require(id);
    if (live.state.status !== "waiting_user") {
      throw new IssueControlError(
        `当前状态 ${live.state.status} 没有等待中的问题卡`);
    }
    // 平台闸(固定流程的人工硬闸)优先于 Agent 问题卡:闸在 state 里,
    // 分派语义在服务,不进模型。
    if (live.state.gate) {
      return this.resolveGate(live, {
        stateVersion: input.state_version,
        decision: input.decision ?? "",
        // 闸卡恒为单题:code 缺席时兼容逐题通道(同一提交协议)。
        code: input.code?.trim()
          || Object.values(input.answers ?? {}).find((value) => value.trim()),
        ...(input.selection !== undefined ? { selection: input.selection } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      });
    }
    const waiting = live.humanGate.pending()[0];
    if (!waiting) throw new IssueControlError("盘上没有等待中的问题卡(状态不一致)");
    const record = live.humanGate.resolve(waiting.waiting_id, {
      stateVersion: input.state_version,
      // 决策码还原成选项原文再入账:Agent 看到的文本与文字作答时代一致。
      decision: decodeAgentDecision(waiting, input.answers)
        ?? input.decision ?? "",
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    if (this.turning.has(live.id)) {
      throw new IssueControlError("会话正在处理上一条输入,稍候再试");
    }
    this.beginTurn(live, async () => {
      await this.ensureContainer(live);
      if (live.driver) {
        return live.driver.resumeWithDecision(record);
      }
      // 进程重启后的作答:重开 会话,决定先补登记(审计),再以
      // 续聊提示词把答案交给重建的上下文。
      const driver = await this.openDriver(live);
      driver.injectDecision(record);
      return driver.startResume(issueResumePrompt(live.state,
        `用户对问题卡的答复:\n${renderDecision(record)}`,
        this.environmentCredentials(live),
        { moonlight: this.moonlightOn(live), workspace: live.root }));
    });
    return summarize(live.state);
  }

  /** 会话事件补记:服务侧发生的事实(如闸作答)落进事件账本,与
   * driver 记的模型侧事件共用一个幂等序列。 */
  private appendSessionEvent(
    live: LiveIssue,
    kind: SemanticEvent["kind"],
    payload: Record<string, unknown>,
  ): void {
    try {
      const eventLog = new EventLog(join(live.root, "events.jsonl"));
      eventLog.append({
        eventId: eventLog.lastEventId() + 1,
        taskId: live.id,
        sessionId: live.id,
        ts: new Date().toISOString(),
        kind,
        payload,
      });
    } catch (cause) {
      this.log?.(`[issue-flow] ${live.id} 事件补记失败(${kind}): `
        + String(cause instanceof Error ? cause.message : cause));
    }
  }

  // ---- 固定流程:平台闸的裁决与阶段机联动 ----

  /** 平台闸作答分派:按决策码单点分派(gateVerdict 纯函数,语义与
   * 分派规则都住在 stageRegistry),中文文案不再是匹配键——改决策卡
   * 文案零协议后果。decision 只进现场账与续聊提示词(显示语义):
   * 按码作答时可缺席,从注册表码表反查人话;自由作答原样入账。
   * 确认后推进到哪、补充意见后回流到哪,是阶段知识,查阶段注册表
   * 的出口闸声明(stageGateRoute),不在裁决代码里写死。 */
  private resolveGate(live: LiveIssue, input: {
    stateVersion: number;
    decision: string;
    code?: string;
    selection?: string[];
    notes?: string;
  }): IssueSummary {
    const { state } = live;
    const gate = state.gate!;
    if (input.stateVersion !== gate.state_version) {
      throw new IssueControlError("问题卡状态已变化,请刷新后重试");
    }
    if (this.turning.has(live.id)) {
      throw new IssueControlError("会话正在处理上一条输入,稍候再试");
    }
    if (gate.kind === "env_needed") {
      // 环境闸的作答口是 POST /issues/:id/environment(问题卡上的专用
      // 表单),不是选项卡:走错口不动状态,如实指路。
      throw new IssueControlError(
        "网管环境请在问题卡的配置表单里填写服务器地址与网管后台密码后提交");
    }
    if (gate.kind === "skill_select") {
      // skill 圈选闸的作答口是 selection 专用口(ADR-0011,与 env_needed
      // 表单同款的多选协议),不走单码分派。
      return this.resolveSkillSelection(live, gate, input);
    }
    const route = stageGateRoute(gate.kind);
    const stageName = (stage: FixedStage): string =>
      fixedStageLabel(state.scenario ?? "ticket", stage);
    const rawDecision = input.decision?.trim() ?? "";
    const notes = input.notes?.trim() ?? "";
    let code = input.code?.trim() ?? "";
    // 证据回灌闸的主通道是自由文本:只贴了原文没带码也算作答(码从
    // 文本在场归码)——前端证据卡提交"文本+码",直调/旧客户端只给
    // 文本时同样受理,不留死协议口。
    if (gate.kind === "pipeline_evidence" && !code
        && (rawDecision || notes)) {
      code = "supply";
    }
    // 显示语义的 decision:提交带了人话就原样用;只带码就从码表反查;
    // 认不得的码原样示人(409 的现场账要能看到交上来的到底是什么)。
    const decision = rawDecision
      || (code ? gateOptionLabel(gate.kind, code) : "");
    const supplement = notes ? `\n用户补充说明: ${notes}` : "";
    // 先裁决后动手:认不得的答复在状态未动前打回(不留下"闸已清、
    // 转移已记"的半截账)。
    const verdict = gateVerdict(gate.kind, code);
    if (gate.kind === "pipeline_evidence" && !(rawDecision || notes)) {
      // 证据卡的特殊空答:码到了但原文没贴——卡片协议要的是文本本体,
      // 选项标签不是证据,专项打回并把要求说全。
      throw new IssueControlError(
        "请把平台上失败项的报错原文(带文件/行号/堆栈)粘贴进作答再提交"
          + "——空答复无法作为修复证据");
    }
    if (verdict === "unrecognized") {
      throw new IssueControlError(
        `无法识别的验证答复:「${decision.slice(0, 40)}」,请通过问题卡的选项作答`);
    }
    delete state.gate;
    recordTransition(state, {
      source: "platform",
      note: `用户作答(${gate.kind}): ${decision.split("\n")[0]}${notes ? `;补充: ${notes.split("\n")[0]}` : ""}`,
    });
    // 闸作答补记 human_decision:CONTEXT 对"现场记录"的定义是"事件流
    // 含用户决策",而闸作答此前只进转移账,过程问答(事件账本投影)里
    // 固定流程的关键问答会缺用户那一半。失败 fail-open:账少一条不挡
    // 闸裁决——闸的真相在 issue.json,事件账是投影不是第二状态机。
    // 问句快照随事件落账(ADR-0008):闸答完即从 issue.json 消失,
    // 历史闸的"问"半边投影时无处合成,只能在这里随事件走。
    this.appendSessionEvent(live, "human_decision", {
      waiting_id: gate.id,
      state_version: gate.state_version,
      decision,
      ...(notes ? { notes } : { notes: "" }),
      gate: {
        kind: gate.kind,
        questions: gate.question.questions.map((item) => ({
          question: item.question,
          options: item.options.map((option) => option.label),
        })),
      },
    });

    if (verdict === "advance") {
      // analysis_confirm 确认:推进到注册表声明的 confirmTo。
      const target = route?.confirmTo;
      if (!target) {
        throw new IssueControlError(
          "阶段注册表缺少分析确认闸的推进目标(阶段配置错误)");
      }
      fixedAdvance(state, target,
        `用户确认分析报告,进入${stageName(target)}`);
      saveState(live.root, state);
      this.continueTurn(live, fixedAdvanceNotice(state,
        `用户已确认问题分析报告,进入「${stageName(target)}」阶段。${supplement}`
          + "请按已确认的方案实施修复,完成后调用 complete_stage。"));
      return summarize(state);
    }

    if (verdict === "archive") {
      // conclude 确认非问题:闭环归档(非问题也留报告,测试拿去留痕)。
      const now = new Date().toISOString();
      fixedComplete(state, "结论:非问题,已闭环归档");
      state.conclusion = {
        kind: "non_issue",
        summary: gate.proposal?.summary
          ? `${gate.proposal.summary}${notes ? `;${notes}` : ""}`
          : decision,
        at: now,
      };
      state.status = "archived";
      saveState(live.root, state);
      this.releaseDriver(live);
      this.stopContainerInBackground(live, "非问题归档");
      this.vault.remove(live.id);
      this.log(`[issue-flow] ${live.id} 结论非问题,已闭环归档`);
      return summarize(state);
    }

    if (verdict === "suspend") {
      // conclude 确认是问题:挂起等用户关联 DTS 单号(关联即转正)。
      fixedComplete(state, "结论:是问题,挂起等待关联单号");
      state.status = "suspended";
      state.stage_note = "结论为「是问题」——请关联 DTS 单号转正,或直接归档";
      saveState(live.root, state);
      this.releaseDriver(live);
      this.stopContainerInBackground(live, "问题挂起");
      this.log(`[issue-flow] ${live.id} 结论是问题,已挂起待关联单号`);
      return summarize(state);
    }

    if (verdict === "pass") {
      // env_verify 通过:本阶段收尾,待手动归档。
      fixedComplete(state, "用户环境验证通过,待归档收口");
      state.status = "idle";
      state.stage_note = "环境验证通过——确认 MR 合入后可归档收口";
      saveState(live.root, state);
      return summarize(state);
    }

    if (verdict === "fail") {
      // env_verify 不通过:回退问题分析(轮次+1,回退细节在 fixedRollback)。
      const reason = notes || decision;
      fixedRollback(state, `用户环境验证发现问题:${reason.split("\n")[0]}`);
      saveState(live.root, state);
      this.continueTurn(live, fixedAdvanceNotice(state,
        `用户在环境验证发现问题,已回退到「问题分析」阶段(第 ${state.round} 轮)。`
          + `${supplement || `\n用户描述: ${reason}`}\n`
          + "请带着新一轮的现场重新分析(前几轮的修复在分支上,不要推倒重来),"
          + "分析完成后重新 submit_analysis。"));
      return summarize(state);
    }

    if (verdict === "grant_push") {
      // push_confirm 确认(ADR-0009):一次性令牌写入会话状态(带确认
      // 时刻与决策留痕,并记下举闸时的分支 tip 作为过目对象的身份——
      // 重推时 tip 变了令牌即作废重举),随 issue.json 持久化,recover
      // 不清它。闸已在上面落掉、原阶段续跑——Agent 重试 push_branch 即
      // 放行,成功后令牌被消费,再推重新过目(每次过目,防盲签)。
      state.push_token = {
        at: new Date().toISOString(),
        decision,
        ...(state.push_review_head
          ? { head: state.push_review_head } : {}),
      };
      delete state.push_review_head;
      saveState(live.root, state);
      this.continueTurn(live,
        `用户已过目本次变更并确认推送(推送确认)。令牌已生效——请重新调用`
          + ` push_branch 完成推送(成功后令牌即消费,之后的每次推送都会重新`
          + `举卡过目)。${supplement}`);
      return summarize(state);
    }

    if (verdict === "hold_push") {
      // 暂不推送(含自由作答):不产令牌,原阶段续跑。决策与意见已在
      // 上面入账(human_decision 事件+转移账),Agent 能看到用户意见。
      saveState(live.root, state);
      this.continueTurn(live,
        `用户选择暂不推送,本次变更未获放行:${decision}${supplement}\n`
          + "请不要推送——先按用户意见调整,调整好后再推(届时会重新举"
          + "推送确认卡过目)。");
      return summarize(state);
    }

    if (verdict === "resume_watch") {
      // pipeline_unfixable 已答「已在平台处理/豁免」:重置该仓监看账
      // (deadline 重置、watching=true、清上一轮红灯账)并重新监看同一
      // SHA——平台侧已处理则这次就绿(走 success 结算:提醒重新申报/
      // 进验证),仍红则重新走分诊(可能变成可修,照常派回合;仍不可修
      // 则再次举卡)。不开 AI 回合:监看是宿主的事,结算路径自会开回合;
      // 会话随之落 idle(等监看结果,人可照常续聊)。
      const target = gate.pipeline;
      if (!target) {
        throw new IssueControlError("闸缺少流水线定位(举闸配置错误)");
      }
      const watch = state.pipelines?.[target.repo];
      if (!watch || watch.sha !== target.sha) {
        throw new IssueControlError("流水线监看账已变化,请刷新后重试");
      }
      const now = Date.now();
      const { budgetMs } = this.pipelineKnobs();
      watch.status = "running";
      watch.watching = true;
      watch.started_at = new Date(now).toISOString();
      watch.deadline = new Date(now + budgetMs).toISOString();
      delete watch.checks;
      delete watch.last_error;
      // 证据重试窗字段一并清(票 82):人在平台处理后的重看是新一轮
      // 取证,旧窗作废;守卫(闸在场)也已随作答清场。
      this.clearEvidenceRetry(watch);
      state.status = "idle";
      state.stage_note = `已按人工答复重新监看流水线(${target.repo})`
        + `@ ${target.sha.slice(0, 12)},等结果`;
      saveState(live.root, state);
      this.log(`[issue-flow] ${live.id} 不可修闸已答,重置监看账`
        + `(${target.repo}) @ ${target.sha.slice(0, 12)}`);
      void this.watchPipeline(live, target.repo, target.sha);
      return summarize(state);
    }

    if (verdict === "human_evidence") {
      // pipeline_evidence 已贴原文:原文作为人工证据注入下一修复回合
      // (回合文案带「人工从平台回灌的报错原文」段),该轮才消耗修复轮
      // 预算(reds+1,与"派了回合才记账"同口径);续跑走 continueTurn
      // → beginTurn,与全部闸作答同一并发语义。预算已耗尽就不再派回合
      // ——证据已入账(human_decision 事件+转移账),诚实停机请人工。
      const target = gate.pipeline;
      if (!target) {
        throw new IssueControlError("闸缺少流水线定位(举闸配置错误)");
      }
      const watch = state.pipelines?.[target.repo];
      if (!watch || watch.sha !== target.sha) {
        throw new IssueControlError("流水线监看账已变化,无法按原闸回灌证据");
      }
      const evidence = rawDecision || notes;
      const max = repairBudget(this.options.settings);
      const reds = (watch.reds ?? 0) + 1;
      watch.reds = reds;
      const dims = failedDimensionLabels(watch.checks);
      // 回灌路也是派修(票 82):同拍写入刹车账——人工回灌的原文就是
      // "上轮报错",AI 修完没出新提交再红灯时刹车要认账;重试窗字段
      // (若有)清掉,证据已由人供给,循环使命完成。
      const previousSha = watch.last_repair_sha;
      const previousSummary = watch.last_failure_summary;
      watch.last_repair_sha = target.sha;
      watch.last_failure_summary =
        `人工回灌的报错原文(节选): ${evidence.slice(0, 500)}`;
      this.clearEvidenceRetry(watch);
      this.log(`[issue-flow] ${live.id} 证据回灌闸已答(${target.repo}),`
        + `第 ${reds}/${max} 轮修复预算`);
      if (reds > max) {
        state.stage_note = `流水线连续 ${reds} 次红灯,修复轮预算(${max} 轮)`
          + "已耗尽——人工回灌的报错原文已入账,请人工处理后再继续";
        saveState(live.root, state);
        return summarize(state);
      }
      saveState(live.root, state);
      this.continueTurn(live, [
        `平台通知: 人工已从交付平台回灌流水线红灯的报错原文(仓 `
          + `${target.repo},第 ${reds}/${max} 次红灯,仍在「提交 MR·跑绿」`
          + "阶段)。",
        `缺口维度(${dims})按下面的原文定位修复,不许猜改。`,
        "",
        "人工从平台回灌的报错原文:",
        evidence,
        "",
        ...(watch.checks?.length
          ? [describePipelineRun({ status: watch.status, checks: watch.checks }),
            ""]
          : []),
        ...(previousSha && previousSummary
          ? [`上一轮(提交 ${previousSha.slice(0, 12)})红灯的报错摘要如下,`,
            "先对比是否同一处:", previousSummary,
            "纪律:同一处必须换思路,换思路也解决不了就直说修不了,",
            "不许重复同样的修改。", ""]
          : []),
        "失败产物(若已镜像)在会话工作区 pipeline/ 目录,可用 Bash 读全文。",
        "请按原文修复后同分支 push_branch 再 create_mr(同一 MR 会自动跟"
          + "新提交),平台会重新监看。",
      ].join("\n"));
      return summarize(state);
    }

    // verdict === "rework":补充意见/自由作答。两类闸的去向不同——
    // analysis_confirm 留在分析阶段完善重提;conclude 重置回分析继续查证。
    if (gate.kind === "conclude") {
      const owner = route?.stage;
      if (!owner || !route?.reworkTo) {
        throw new IssueControlError(
          "阶段注册表缺少结论闸的归属阶段或回流目标(阶段配置错误)");
      }
      const ownerIndex = state.scenario
        ? fixedStageIndex(state.scenario, owner) : -1;
      if (ownerIndex >= 0
          && (state.stage_states?.[ownerIndex] ?? "pending") !== "pending") {
        (state.stage_states ??= [])[ownerIndex] = "pending";
      }
      const rework = route.reworkTo;
      fixedAdvance(state, rework, "用户对结论有补充意见,继续分析");
      saveState(live.root, state);
      this.continueTurn(live,
        `用户对分析结论提出意见,回到「${stageName(rework)}」阶段:${decision}${supplement}\n`
          + "请继续查证,完善 issue-analysis.md 后重新 submit_analysis 提交结论。");
      return summarize(state);
    }
    // analysis_confirm 的补充意见:留在分析阶段继续完善,改完重新提交。
    state.stage_note = "用户对分析报告有补充意见,继续分析";
    saveState(live.root, state);
    this.continueTurn(live,
      `用户对分析报告提出补充意见,仍在「${stageName(state.stage as FixedStage)}」阶段:${decision}${supplement}\n`
        + "请按意见完善 issue-analysis.md 后重新 submit_analysis 提交。");
    return summarize(state);
  }

  /** skill 圈选闸的裁决(ADR-0011):selection 必须是闸上 skills path
   * 的子集(浏览器自报路径一律拒绝,与需求侧仓内能力发现同一纪律);
   * 空选=「都不用」,AI 按取用次序自主。选定集合写台账(skill_selection
   * 字段在场=已作答,重走 analyze 不重举的判据),续跑消息带必读清单
   * 与 analyze 阶段简报。留痕与真人作答同形:human_decision 事件带
   * 问句快照与勾选结果,转移账记人话。 */
  private resolveSkillSelection(
    live: LiveIssue,
    gate: IssueGate,
    input: { decision: string; code?: string; selection?: string[]; notes?: string },
  ): IssueSummary {
    const { state } = live;
    const offered = new Map((gate.skills ?? []).map((skill) =>
      [skill.path, skill]));
    const selection = [...new Set((input.selection ?? [])
      .map((path) => String(path).trim()).filter(Boolean))];
    const unknown = selection.filter((path) => !offered.has(path));
    if (unknown.length) {
      throw new IssueControlError(
        `勾选了清单之外的 skill 路径:${unknown.join("、")}`
          + "——只能勾选问题卡上列出的项");
    }
    const skills = selection.map((path) => offered.get(path)!);
    const decision = input.decision?.trim()
      || (skills.length
        ? `圈选必读 skill:${skills.map((skill) => skill.name).join("、")}`
        : gateOptionLabel("skill_select", "skip"));
    const notes = input.notes?.trim() ?? "";
    state.skill_selection = { at: new Date().toISOString(), skills };
    delete state.gate;
    recordTransition(state, {
      source: "platform",
      note: `用户作答(skill_select): ${decision.split("\n")[0]}`
        + `${notes ? `;补充: ${notes.split("\n")[0]}` : ""}`,
    });
    this.appendSessionEvent(live, "human_decision", {
      waiting_id: gate.id,
      state_version: gate.state_version,
      decision,
      ...(notes ? { notes } : { notes: "" }),
      gate: {
        kind: gate.kind,
        questions: gate.question.questions.map((item) => ({
          question: item.question,
          options: item.options.map((option) => option.label),
        })),
        ...(gate.skills ? {
          offered: gate.skills.map((skill) => `${skill.repo} → ${skill.name}`),
        } : {}),
      },
      ...(skills.length ? {
        selection: skills.map((skill) => skill.path),
      } : {}),
    });
    saveState(live.root, state);
    const lines = skills.length
      ? ["用户已圈选以下业务 skill 为**必读**(分析前先读;"
          + "路径相对会话工作区):",
        ...skills.map((skill) =>
          `- ${skill.path}${skill.description ? ` — ${skill.description}` : ""}`),
        "读完它们再继续问题分析;读完仍可按方法论取用次序补充其他材料。"]
      : ["用户未圈选任何业务 skill——按方法论取用次序自主定位"
          + "(业务仓 .cac/skills 与 .agents/skills、货架通用 skill、"
          + "issue-research、自行取证)。"];
    this.continueTurn(live, [
      ...lines,
      "",
      fixedAdvanceNotice(state,
        `用户已完成 skill 圈选,继续「${fixedStageLabel(
          state.scenario ?? "ticket", state.stage as FixedStage)}」阶段。`
        + (notes ? `\n用户补充说明: ${notes}` : "")),
    ].join("\n"));
    return summarize(state);
  }

  reply(id: string, text: string): IssueSummary {
    const live = this.require(id);
    const status = live.state.status;
    if (status === "waiting_user") {
      throw new IssueControlError("会话在等你对问题卡的答复,请回答问题卡而不是发消息");
    }
    if (status === "suspended") {
      throw new IssueControlError(
        "会话挂起中(结论已是问题):请在右侧关联 DTS 单号转正,或直接归档收口");
    }
    if (status === "queued") {
      throw new IssueControlError("首轮研究还在排队启动,请稍候再发消息");
    }
    if (status === "running" || this.turning.has(live.id)) {
      throw new IssueControlError("会话正在运行,请用「补充」(运行中输入会在当前步骤完成后送达)");
    }
    if (isTerminal(status)) {
      throw new IssueControlError(`会话已${status === "archived" ? "归档" : "结束"},不能再续聊`);
    }
    const content = text?.trim();
    if (!content) throw new IssueControlError("消息内容不能为空");
    this.continueTurn(live, content);
    return summarize(live.state);
  }

  steer(id: string, text: string): IssueSummary {
    const live = this.require(id);
    const content = text?.trim();
    if (!content) throw new IssueControlError("补充内容不能为空");
    if (live.state.status !== "running" || !live.driver) {
      throw new IssueControlError("会话不在运行中,补充无处送达");
    }
    void live.driver.steer(content).catch((error) =>
      this.log(`[issue-flow] ${id} 插话失败: ${String(error)}`));
    return summarize(live.state);
  }

  // ---- 检视(ADR-0007:人工意见触发整体回退,闭环靠分析确认卡) ----

  /** 检视的会话级门槛(记账与提交共用):固定流程、未终态、分析段
   * 不是转正继承——转正继承的分析报告是上一会话已确认的结论,
   * 重跑会污染继承账(ADR-0007 拍板的边界)。 */
  private requireReviewable(live: LiveIssue): void {
    const { state } = live;
    if (state.mode !== "fixed" || !state.scenario) {
      throw new IssueControlError(
        "检视重跑只支持固定流程会话(自由模式请直接发消息补充意见)");
    }
    if (isTerminal(state.status)) {
      throw new IssueControlError("会话已结束,不能再检视");
    }
    const analyzeIndex = fixedStageIndex(state.scenario, "analyze");
    if (analyzeIndex >= 0
        && (state.stage_states?.[analyzeIndex] ?? "") === "inherited") {
      throw new IssueControlError(
        "转正继承的分析报告不可检视重跑");
    }
  }

  /** 检视面板的数据面:意见清单 + 锚点检测(原文还在/已被改动)+
   * 回合标记。读类,查看模式下登录即可读(写仍仅归属人)。 */
  listReviews(id: string): {
    reviews: Annotation[];
    checks: AnchorCheck[];
    review_active: boolean;
  } {
    const live = this.require(id);
    return {
      reviews: orderAnnotations(reviewStore(live.root).visible()),
      checks: anchorChecks(live.root),
      review_active: live.state.review_active === true,
    };
  }

  /** 记一条检视草稿(悬停圈注的落账口)。作者恒为会话归属人——
   * 问题会话没有协作检视,谁的问题谁提意见。 */
  addReview(id: string, input: {
    line: number; anchor: string; note: string;
  }): Annotation {
    const live = this.require(id);
    this.requireReviewable(live);
    const note = input.note?.trim() ?? "";
    const anchor = input.anchor?.trim() ?? "";
    if (!note) throw new IssueControlError("检视意见不能为空");
    if (!anchor) throw new IssueControlError("缺少原文快照,意见无从定位");
    const line = Number(input.line);
    return addReview(live.root, {
      author: live.state.account,
      line: Number.isFinite(line) ? Math.max(0, Math.trunc(line)) : 0,
      anchor,
      note,
    });
  }

  /** 移除一条意见(账本软删,jsonl 留痕)。 */
  dropReview(id: string, reviewId: string): Annotation {
    const live = this.require(id);
    this.requireReviewable(live);
    return dropReview(live.root, reviewId, live.state.account);
  }

  /** 提交检视 = 整体回退的人工触发源(ADR-0007):作废挂起的 Agent
   * 问题卡(supersede:撤下待办、留审计原因),清掉平台闸(fixedRollback
   * 自会清),意见标记送出、报告留版本快照,整体回退到「问题分析」
   * (round+1、其后阶段标 redo、申报账作废、分支与 MR 延用),意见清单
   * 注入新一轮分析。落账 review_submitted 事件——过程问答里"这轮
   * 为什么重跑"靠它。 */
  submitReviews(id: string): IssueSummary {
    const live = this.require(id);
    const { state } = live;
    this.requireReviewable(live);
    if (state.review_active) {
      throw new IssueControlError(
        "上一轮检视的修订还没有重新提交分析报告,不能叠加检视");
    }
    if (this.turning.has(live.id)) {
      throw new IssueControlError("会话正在运行,等当前回合收口后再提交检视");
    }
    if (state.status !== "waiting_user" && state.status !== "idle") {
      throw new IssueControlError(
        `当前状态 ${state.status} 不能提交检视(意见可以先记成草稿,`
          + "等 AI 停机或举卡等你时再提交)");
    }
    if (!reviewStore(live.root).drafts().length) {
      throw new IssueControlError("没有待提交的检视意见");
    }
    // 挂起的 Agent 问题卡先作废(有账的撤下,不是替用户作答);冲突
    // 说明卡刚被答过/状态已变,如实打回。
    let supersededCard = false;
    const waiting = live.humanGate.pending()[0];
    if (waiting) {
      try {
        live.humanGate.supersede(waiting.waiting_id, {
          stateVersion: waiting.state_version,
          notes: "用户提交检视意见,本卡作废,工作流回退问题分析",
        });
        supersededCard = true;
      } catch {
        throw new IssueControlError("问题卡状态已变化,请刷新后重试");
      }
    }
    const sent = submitReviewLedger(live.root);
    fixedRollback(state,
      `用户检视分析报告,提交 ${sent.length} 条修订意见`);
    state.review_active = true;
    saveState(live.root, state);
    const notes = renderReviewNotes(sent, state.title, state.round ?? 1);
    // 检视意见落账为用户回合(ADR-0008 口径里的"检视意见"),清单
    // 原文随事件走:它同时是给下一轮分析的注入词,复盘与重跑看同一份。
    this.appendSessionEvent(live, "review_submitted", {
      count: sent.length,
      text: notes,
    });
    this.log(`[issue-flow] ${id} 检视提交 ${sent.length} 条意见,`
      + `回退问题分析(第 ${state.round} 轮)`);
    // 挂 Agent 卡的现场,提问的 await 已被 supersede 悬死:释放后由
    // 续聊路径重建上下文(issueResumePrompt 把意见清单带给重建现场);
    // 闸等待/闲置现场 driver 无悬挂,续聊直递现有上下文。
    if (supersededCard) this.releaseDriver(live);
    this.continueTurn(live, fixedAdvanceNotice(state, [
      `用户检视了分析报告,提出 ${sent.length} 条修订意见,`
        + `已回退到「问题分析」阶段(第 ${state.round} 轮)。`,
      "",
      notes,
      "",
      ...(state.pushes?.length
        ? ["注: 前几轮的修复已提交在分支上,不要推倒重来。"]
        : []),
    ].join("\n")));
    return summarize(state);
  }

  // ---- 台面动作 ----

  bindTicket(id: string, ticket: string): IssueSummary {
    const live = this.require(id);
    const value = ticket?.trim() ?? "";
    if (!TICKET_PATTERN.test(value)) {
      throw new IssueControlError("单号只能是字母数字下划线连字符");
    }
    if (live.state.mode === "fixed") {
      throw new IssueControlError(
        "固定流程的会话不直接绑定单号:无单场景结论后挂起,经「关联单号」校验 DTS "
          + "存在后转正为新会话(带分析报告进入问题修改)");
    }
    live.state.ticket = value;
    recordTransition(live.state, {
      source: "platform", note: `单号已绑定 ${value}(用户操作)`,
    });
    saveState(live.root, live.state);
    this.log(`[issue-flow] ${id} 绑定单号 ${value}`);
    if (live.driver && live.state.status === "running") {
      void live.driver.steer(
        `用户已在平台绑定单号 ${value};后续分支/提交/推送请使用该单号。`)
        .catch(() => undefined);
    }
    return summarize(live.state);
  }

  async control(id: string, input: {
    action: "cancel" | "archive";
    kind?: IssueConclusionKind;
    summary?: string;
  }): Promise<IssueSummary> {
    const live = this.require(id);
    if (isTerminal(live.state.status)
      && live.state.status !== "failed") {
      throw new IssueControlError(`会话已处于终态 ${live.state.status}`);
    }
    if (live.state.status === "failed" && input.action !== "cancel") {
      // failed 曾是"死胡同终态":不能续聊、不能归档、不能取消,出错
      // 的会话永远占着列表(2026-09-02 用户实锤难受)。出口定为取消——
      // 归档需要结论,结论词表里没有"失败"语义,强归档只能落到
      // "非问题",那是撒谎;取消=放弃这单,错误信息与账目都还在。
      throw new IssueControlError(
        "已失败的会话没有结论可归档,只能取消清理");
    }
    if (this.turning.has(live.id) && input.action !== "cancel") {
      throw new IssueControlError("会话正在运行；如需立即停止，请先取消会话");
    }
    // 先停净再写终态。过去先清 live.container、异步 stop，接口已经回了
    // “取消成功”但 Docker 仍在；失败后也没有句柄可重试。
    const previousStatus = live.state.status;
    if (input.action === "cancel") live.controlEpoch += 1;
    void live.driver?.abort().catch(() => undefined);
    this.releaseDriver(live);
    try {
      await this.stopContainer(live);
    } catch (error) {
      if (input.action === "cancel" && previousStatus === "running") {
        live.state.status = "idle";
        live.state.error = `取消时容器回收失败：${String(error)}`;
        saveState(live.root, live.state);
      }
      throw new IssueControlError(
        `容器未能确认回收，${input.action === "cancel" ? "取消" : "归档"}`
          + `尚未完成，请重试：${String(error)}`);
    }
    const now = new Date().toISOString();
    if (input.action === "cancel") {
      live.state.status = "canceled";
    } else {
      const kind = input.kind
        ?? (live.state.status === "suspended" ? "issue"
          : live.state.mrs?.length ? "delivered"
          : live.state.pushes?.length ? "fixed" : "non_issue");
      live.state.conclusion = {
        kind,
        summary: input.summary?.trim() || live.state.last_reply
          || live.state.stage_note || "(无补充说明)",
        at: now,
      };
      live.state.status = "archived";
      // 固定流程留在自己的词表里(进度条按 scenario 对齐);自由模式
      // 沿用 done。
      if (live.state.mode === "fixed" && live.state.scenario) {
        fixedComplete(live.state, "会话已归档收口(用户操作)");
      } else {
        live.state.stage = "done";
        live.state.stage_at = now;
        recordTransition(live.state, {
          source: "platform", stage: "done", note: "会话已归档收口(用户操作)",
        });
      }
    }
    saveState(live.root, live.state);
    this.vault.remove(live.id);
    this.log(`[issue-flow] ${id} ${input.action === "cancel" ? "取消" : "归档"}`);
    return summarize(live.state);
  }

  // ---- 固定流程:流水线监看(阶段6:已申报且全绿才放行换库) ----

  private pipelineKnobs(): { pollMs: number; budgetMs: number } {
    const knobs = this.options.settings?.runtime?.() ?? {};
    return {
      pollMs: Math.max(1_000, (knobs.poll_interval_s ?? 10) * 1000),
      budgetMs: Math.max(60_000, (knobs.poll_timeout_s ?? 1_800) * 1000),
    };
  }

  /** MR 建成即挂表监看:触发流水线 → 轮询到终态。绿→已申报则自动进
   * 换库验证(未申报则提示 AI 申报);红→携失败项开回合让 AI 修
   * (同分支再推,MR 自动跟新提交)。幂等:同 SHA 在盯则跳过
   * (MR 幂等重建会重复触发本钩子)。 */
  armPipelineWatch(live: LiveIssue, repo: string): void {
    const state = live.state;
    const platformUrl = this.options.platformUrl;
    const sha = state.pushes?.find((item) => item.repo === repo)?.sha;
    if (!platformUrl || !sha || state.mode !== "fixed") return;
    const watching = state.pipelines?.[repo];
    if (watching?.watching && watching.sha === sha) return;
    if (watching?.sha && watching.sha !== sha) {
      this.resolveIssuePipelineFeedback(live, repo, "addressed",
        `已产生新提交 ${sha.slice(0, 12)}，等待新流水线核验`);
    }
    const now = Date.now();
    const { budgetMs } = this.pipelineKnobs();
    (state.pipelines ??= {})[repo] = {
      sha,
      status: "running",
      watching: true,
      started_at: new Date(now).toISOString(),
      deadline: new Date(now + budgetMs).toISOString(),
      round: state.round ?? 1,
      // 红灯计数跨 SHA 累计(绿了才清零):修复轮预算是每仓总量,
      // 换 SHA 不重置——与需求侧修复环"同任务总量"同一口径。
      ...(watching?.reds ? { reds: watching.reds } : {}),
      // 刹车账跨重挂表保留(票 82):同 SHA 重推/重建 MR 后重看,刹车
      // 判据(last_repair_sha)必须活着;证据重试窗字段不随迁——新提交
      // 是新流水线,旧窗随旧提交作废。
      ...(watching?.last_repair_sha
        ? { last_repair_sha: watching.last_repair_sha } : {}),
      ...(watching?.last_failure_summary
        ? { last_failure_summary: watching.last_failure_summary } : {}),
    };
    recordTransition(state, {
      source: "platform",
      note: `流水线监看已启动(${repo})@ ${sha.slice(0, 12)}`,
    });
    saveState(live.root, state);
    void this.watchPipeline(live, repo, sha);
  }

  private async watchPipeline(
    live: LiveIssue,
    repo: string,
    sha: string,
  ): Promise<void> {
    const { state } = live;
    const platformUrl = this.options.platformUrl;
    if (!platformUrl) return;
    const { pollMs } = this.pipelineKnobs();
    const call = () => ({
      platformUrl,
      sha,
      repo,
      // 状态命令模板可能引用 {mr},缺了每轮 502、监看永远等不到绿
      // (2026-08-28 真实环境事故)。iid 按 repo 现查现用——MR 重建后
      // 下一轮自然带上新 id。
      mr: state.mrs?.find((item) => item.repo === repo)?.iid,
      credential: this.options.gitCredential?.(state.account),
    });
    // 触发(假件必须显式触发;真件幂等无害)。触发响应可能已是终态。
    try {
      const first = await triggerPipeline(call());
      if (first.status !== "running") {
        await this.settlePipeline(live, repo, sha, first);
        return;
      }
    } catch (error) {
      // 触发失败不弃看:适配层可能已因建 MR 自动触发,状态查询照走。
      this.log(`[issue-flow] ${live.id} 流水线触发失败(继续查状态): ${String(error)}`);
    }
    while (
      state.pipelines?.[repo]?.sha === sha
      && state.pipelines[repo].watching
      && !isTerminal(state.status)
      && Date.now() < Date.parse(state.pipelines[repo].deadline)
    ) {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, pollMs);
        timer.unref?.();
      });
      if (state.pipelines?.[repo]?.sha !== sha
          || !state.pipelines[repo].watching) return;
      try {
        const status = await getPipelineStatus(call());
        // 与申报门同一口径：runs.at(-1) 才是当前 run。历史终态不能
        // 越过后触发且仍在 running 的新 run，让监看器提前收口。
        const latest = status.runs.at(-1);
        if (latest && latest.status !== "running") {
          await this.settlePipeline(live, repo, sha, latest);
          return;
        }
      } catch (error) {
        this.log(`[issue-flow] ${live.id} 流水线查询失败(继续轮): ${String(error)}`);
      }
    }
    // 预算耗尽:如实停表,不阻塞会话——用户可人工查看后发消息继续。
    if (state.pipelines?.[repo]?.sha === sha && state.pipelines[repo].watching) {
      state.pipelines[repo].watching = false;
      state.pipelines[repo].last_error = "轮询预算耗尽,请人工查看流水线";
      state.stage_note = "流水线轮询预算耗尽——请人工查看 MR/流水线,再发消息继续";
      saveState(live.root, state);
      this.log(`[issue-flow] ${live.id} 流水线监看预算耗尽(${repo})`
        + ` @ ${sha.slice(0, 12)}`);
      // 放弃点通知(票 81):机器等不起了就是需要人的时刻,主动喊人,
      // 不让用户靠刷网页发现停机。幂等见 notifyPipelineStopped。
      this.notifyPipelineStopped(live,
        `pipeline_watch_timeout:${repo}:${sha}`,
        `${this.issueSubject(live)}:仓 ${repo} 流水线轮询预算耗尽`
          + `(第 ${state.pipelines[repo].round ?? 1} 轮验证,`
          + `提交 ${sha.slice(0, 12)}),流水线在预算内迟迟未出结果,`
          + "自动监看已停止。请人工查看 MR/流水线,处理后发消息继续");
    }
  }

  private async settlePipeline(
    live: LiveIssue,
    repo: string,
    sha: string,
    run: PipelineRun,
  ): Promise<void> {
    const { state } = live;
    const watch = state.pipelines?.[repo];
    if (watch?.sha !== sha) return;
    watch.status = run.status;
    watch.watching = false;
    if (run.checks) watch.checks = run.checks;
    if (run.status === "success") {
      watch.reds = 0;
      // 绿了清账:刹车账(last_repair_sha/last_failure_summary)与证据
      // 重试窗字段随红灯环一起作废——下一轮红灯从干净账起算。
      this.clearRepairLedger(watch);
      this.resolveIssuePipelineFeedback(live, repo, "closed",
        `新提交 ${sha.slice(0, 12)} 的权威流水线已通过`);
      recordTransition(state, {
        source: "platform", note: `流水线全绿(${repo})@ ${sha.slice(0, 12)}`,
      });
      // 多仓语义(2026-08-28 拍板):AI 已建的 MR 各自跑流水线,全部
      // 跑绿才进换库验证;还有在途/未绿的就等齐,不抢跑。放行还要过
      // MR 验绿门的申报半边(不变量:进 deploy_verify 当且仅当
      // "已申报且全绿"):AI 没申报就不推进,开回合提醒它 complete_stage。
      const mrs = state.mrs ?? [];
      const allGreen = mrs.length > 0 && mrs.every((mr) =>
        state.pipelines?.[mr.repo]?.status === "success");
      const anyWatching = Object.values(state.pipelines ?? {})
        .some((item) => item.watching);
      if (allGreen && !anyWatching && state.mr_gate) {
        delete state.mr_gate;
        fixedAdvance(state, "deploy_verify",
          `全部 ${mrs.length} 个 MR 流水线跑绿,进入换库环境验证`);
        saveState(live.root, state);
        this.startPlatformTurn(live, fixedAdvanceNotice(state,
          `全部 MR 流水线已跑绿(${mrs.map((mr) => mr.repo).join(", ")}),`
            + "进入「换库环境验证」阶段。请调用 build_deploy 部署到网管环境"
            + "(多仓时指定要部署的仓);部署完成后平台会举验证卡,等用户真实验证。"));
      } else if (allGreen && !anyWatching && state.stage === "mr_green") {
        // 全绿但 AI 还没申报清单:不推进(申报是 mr_green 的出口半边),
        // 提醒它调 complete_stage 完成收口。(已在验绿门当场放行的滞后
        // 结算不进这里——阶段守卫挡住,不发过时的申报提醒。)
        saveState(live.root, state);
        this.startPlatformTurn(live,
          `平台通知: 全部 MR 流水线已跑绿(${mrs.map((mr) => mr.repo).join(", ")}),`
          + "请调 complete_stage(带 mrs 参数申报 MR 清单)完成"
          + "「提交 MR·跑绿」阶段收口。");
      } else if (!anyWatching && mrs.length > 0) {
        // 有 MR 未绿且没表在跑:那就是失败了,带回失败项让 AI 修。
        saveState(live.root, state);
        this.startPlatformTurn(live,
          `平台通知: 仓 ${repo} 流水线已全绿,但仍有 MR 未跑绿`
          + "(仍在「提交 MR·跑绿」阶段)。请核实各仓流水线状态,"
          + "需要的仓修复后同分支 push_branch 再 create_mr。");
      }
      return;
    }
    recordTransition(state, {
      source: "platform", note: `流水线失败(${repo})@ ${sha.slice(0, 12)}`,
    });
    // 红=申报打回:清掉申报账,修复后要重新申报再过验绿门。
    delete state.mr_gate;
    // 取证增强:平台失败产物全文镜像进会话工作区 pipeline/,AI 用
    // Bash 读全文再修,而不是只看状态响应里截断 1500 字的摘要。
    // 镜像失败不拦主链路——按摘要修复,文案如实说明没有产物。
    const artifacts = await this.mirrorPipelineArtifactsFor(live, repo, sha);
    const feedbackId = `issue-pipeline:${repo}:${sha}`;
    this.feedbackStore(live).upsert([{
      id: feedbackId,
      batch_id: feedbackId,
      source: "pipeline",
      source_id: `${repo}@${sha}`,
      source_revision: watch.round,
      observed_sha: sha,
      summary: describePipelineRun(run).slice(0, 1000),
      verification: "pipeline",
      status: "repairing",
      updated_at: new Date().toISOString(),
    }]);
    // ---- 红灯分诊(需求流 dispatchCiRepair 同款判定次序): ----
    // 先判"改代码有没有用",再评"证据够不够修";两条停机路都不消耗
    // 修复轮预算——reds 只在实际派出修复回合时 +1,与需求侧"未派
    // Agent 未消耗修复轮次"同一口径。
    const checks = run.checks ?? watch.checks;
    // ① 不可修工具分诊(--unfixable-tools 名单,2026-09-01 接入问题流):
    // 失败项全部是名单内工具的 CODECHECK 告警=修复 Agent 改代码解决
    // 不了(要人在交付平台处理/豁免),派回合就是白烧一轮。名单缺席
    // 时判定恒 false——不分诊,行为照旧。票 03 起,停机升级为平台闸:
    // 卡面给失败摘要/逐维度明细/产物位置/处置指引,人处理完在卡上
    // 作答,平台重置监看账重看同一 SHA(见 resolveGate 的 resume_watch)。
    if (onlyUnfixableToolFailures(checks, this.options.unfixableTools)) {
      const tools = unfixableToolNames(checks, this.options.unfixableTools);
      const sha12 = sha.slice(0, 12);
      const note = `流水线红灯全部来自不可自动修复的工具(${tools.join("、")})`
        + "——已举卡等人工:在交付平台处理/豁免后于卡上作答继续";
      watch.last_error = note;
      state.stage_note = note;
      const raised = this.raisePipelineGate(live, repo, sha,
        "pipeline_unfixable",
        `流水线红灯(${failedDimensionLabels(checks)})全部来自不可自动修复的`
          + `工具告警(${tools.join("、")})——请在交付平台处理/豁免后作答,`
          + "平台会重新监看同一提交",
        [
          "**失败摘要**",
          "",
          describePipelineRun(run),
          "",
          "**逐维度明细**(含工具)",
          "",
          ...summarizeFailedChecks(checks),
          "",
          "**镜像产物**",
          "",
          artifacts.length
            ? `失败产物全文已镜像到会话工作区 pipeline/ 目录(${artifacts.join("、")})。`
            : "平台未返回本次失败产物,可到交付平台的 MR/流水线页面查看详情。",
          "",
          "**处置指引**",
          "",
          "1. 这类工具告警改代码解决不了,请到交付平台(MR/流水线页面)"
            + "处理或豁免上述告警;",
          "2. 处理完成后回到本卡选「已在平台处理/豁免,重新监看」——平台会"
            + `重置监看账,重新监看同一提交(${sha12});平台侧已处理则这次就绿,`
            + "告警仍在则再次举卡。",
        ].join("\n"));
      if (!raised) saveState(live.root, state);
      this.log(`[issue-flow] ${live.id} 流水线红灯不可修(${repo},工具 `
        + `${tools.join("、")})@ ${sha12},${raised ? "举卡等人" : "已有闸,留痕停机"}`);
      return;
    }
    // ② 证据评估:逐维度三路取证(失败摘要/checks 结构化明细/镜像
    // 产物文本),回合指令按结果分级——缺口维度明示"不许猜改"。
    const assessment = assessPipelineRepairEvidence({
      checks,
      artifacts: this.pipelineArtifactTexts(live),
      failureSummary: run.log,
    });
    // ③ 全缺证据:有失败维度但一条可定位的报错都没拿到——派修只会
    // 猜改,不开回合。票 82 起先进证据重试窗(定时重拉镜像重评,产物
    // 晚到在窗内自愈),到点仍缺才举 pipeline_evidence 平台闸(票 03):
    // 卡面列缺口维度与原因,请人把报错原文粘贴进卡上的自由文本作答;
    // 作答即证据回灌(注入下一修复回合,该轮才消耗修复轮预算,见
    // resolveGate 的 human_evidence),人发的普通消息不再是回灌通道。
    if (assessment.failedDimensions.length
        && assessment.availableDimensions.length === 0) {
      this.handleMissingEvidence(live, repo, sha, run, artifacts,
        assessment, false);
      return;
    }
    // ③′ 盲输入闸(票 81):平台没给 checks(failedDimensions 为空,
    // 上面的全缺分支够不着)、失败摘要抠掉链接后没有诊断内容、镜像产物
    // 又是零——公共判据 isBlindPipelineInput 三条件同时成立才拦(触发
    // 面收窄:产物在场/摘要真实内容/checks 结构化明细一律放行)。此时
    // 修复会话手里没有任何可信失败证据,派修只会猜改:并入"证据全缺"
    // 同一条 pipeline_evidence 举卡路(票 82 起同样先过证据重试窗),
    // 请人把报错原文粘贴进卡上作答。与全缺同纪律:不派回合、不耗预算
    // (reds 只在真派回合时 +1)。
    if (assessment.failedDimensions.length === 0
        && isBlindPipelineInput(run.log ?? "", artifacts.length > 0)) {
      this.handleMissingEvidence(live, repo, sha, run, artifacts,
        assessment, true);
      return;
    }
    // ④ 派修(票 82 抽出):同提交刹车 → 修复轮预算 → 分级回合指令。
    this.dispatchPipelineRepair(live, repo, sha, run, artifacts, assessment);
  }

  /** 失败产物的平台侧镜像(结算与重试窗重评共用):晚到自愈靠它重拉
   *  ——每轮重评都从平台重新取一次产物,再落会话工作区 pipeline/。 */
  private mirrorPipelineArtifactsFor(
    live: LiveIssue,
    repo: string,
    sha: string,
  ): Promise<string[]> {
    if (!this.options.platformUrl) return Promise.resolve([]);
    const mrUrl = live.state.mrs?.find((item) => item.repo === repo)?.url;
    return mirrorPipelineArtifacts({
      platformUrl: this.options.platformUrl,
      sha, repo, mrUrl,
      dir: join(live.root, "pipeline"),
      headers: this.platformHeaders(live.state.account),
      log: (message) => this.log(`[issue-flow] ${live.id} ${message}`),
    }).catch(() => [] as string[]);
  }

  // ---- 证据重试窗(票 82):全缺/盲输入先重试取证,防"再等两分钟 ----
  // ---- 就自愈"的假卡。三不红线:不耗 reds、不重复通知、不白等。 ----

  /** 证据重试窗旋钮(现读现判,管理页运行时参数):缺省 15 分钟;
   *  0=关闭(回到立即举卡的现状);负值/非数按缺省。允许小数——
   *  亚分钟窗口是测试验证时序的正当形态,不取整。 */
  private evidenceRetryKnobs(): { windowMs: number; tickMs: number } {
    const knobs = this.options.settings?.runtime?.() ?? {};
    const raw = knobs.evidence_retry_minutes;
    const minutes = typeof raw === "number" && Number.isFinite(raw) && raw >= 0
      ? raw : 15;
    const windowMs = minutes * 60_000;
    // 重评节拍=窗口的 1/5(缺省窗即 3 分钟一轮,与需求流
    // scheduleRepairEvidenceRetry 的 3 分钟同量级),下限 500ms 防热转。
    return { windowMs, tickMs: Math.max(500, Math.floor(windowMs / 5)) };
  }

  private clearEvidenceRetry(watch: NonNullable<
    IssueSessionState["pipelines"]>[string]): void {
    delete watch.evidence_retry_deadline;
    delete watch.evidence_retry_attempts;
    delete watch.evidence_failure_log;
  }

  /** 派修账与重试窗字段的清理(绿了清账):刹车账随红灯环作废,重试
   *  窗字段同理——下一轮红灯从干净账起算。 */
  private clearRepairLedger(watch: NonNullable<
    IssueSessionState["pipelines"]>[string]): void {
    delete watch.last_repair_sha;
    delete watch.last_failure_summary;
    this.clearEvidenceRetry(watch);
  }

  /** 证据全缺/盲输入的共同处置路(票 82 重试窗):旋钮开着先不举卡——
   *  记下取证截止时间落盘、排定时器重拉镜像重评(产物晚到自愈),
   *  到点仍缺才举 pipeline_evidence 卡(T1a 文案不变,通知只此一次);
   *  旋钮 0=关立即举卡(现状)。重试全程不耗 reds、不发停机通知。 */
  private handleMissingEvidence(
    live: LiveIssue,
    repo: string,
    sha: string,
    run: PipelineRun,
    artifacts: string[],
    assessment: PipelineEvidenceAssessment,
    blind: boolean,
  ): void {
    const { state } = live;
    const watch = state.pipelines?.[repo];
    if (!watch) return;
    const { windowMs } = this.evidenceRetryKnobs();
    if (state.gate) {
      // 已有闸在场(重复结算撞上已举卡):不重复进窗、不重复举卡。
      this.log(`[issue-flow] ${live.id} 证据暂缺但已有闸在场(${repo}),`
        + `留痕停机 @ ${sha.slice(0, 12)}`);
      return;
    }
    if (windowMs > 0) {
      const parsed = watch.evidence_retry_deadline
        ? Date.parse(watch.evidence_retry_deadline) : NaN;
      if (!Number.isFinite(parsed)) {
        // 首次进窗:记截止时间+失败摘要落盘,排定时器,不举卡不通知。
        const dims = dimensionLabels(assessment.missingDimensions);
        watch.evidence_retry_deadline =
          new Date(Date.now() + windowMs).toISOString();
        watch.evidence_retry_attempts = 0;
        watch.evidence_failure_log = (run.log ?? "").slice(0, 2000);
        const note = blind
          ? "流水线红灯但平台失败摘要只有链接(无 checks 明细)且无镜像产物"
            + "——证据重试窗进行中,平台定时重拉产物重评;到点仍缺才举卡"
            + "请人贴报错原文"
          : `流水线红灯(维度: ${dims})但暂无可定位的具体报错——证据重试窗`
            + "进行中,平台定时重拉产物重评;到点仍缺才举卡请人贴报错原文";
        watch.last_error = note;
        state.stage_note = `${note}(截止 ${watch.evidence_retry_deadline});`
          + "重试不消耗修复轮预算";
        saveState(live.root, state);
        this.log(`[issue-flow] ${live.id} 流水线红灯证据暂缺(${repo},`
          + `${blind ? "盲输入" : "维度 " + dims})进重试窗 @ ${sha.slice(0, 12)}`
          + `,截止 ${watch.evidence_retry_deadline}`);
        this.scheduleEvidenceRetry(live, repo, sha, run);
        return;
      }
      if (Date.now() < parsed) {
        // 窗内再结算(如恢复重放):只把表重新挂上,不重置截止时间。
        this.scheduleEvidenceRetry(live, repo, sha, run);
        return;
      }
      // 到点仍缺:清窗再举卡(T1a 文案),留痕带上已试次数。
      const attempts = watch.evidence_retry_attempts ?? 0;
      this.clearEvidenceRetry(watch);
      const note = `证据重试窗(重评 ${attempts} 次)到点仍无可定位报错——`
        + "已举卡请人把报错原文粘贴进会话,作答后带着证据继续修复";
      watch.last_error = note;
      state.stage_note = note;
      this.raiseEvidenceCard(live, repo, sha, artifacts, assessment, blind);
      return;
    }
    // 旋钮 0=关:立即举卡(票 82 之前的现状行为)。
    this.raiseEvidenceCard(live, repo, sha, artifacts, assessment, blind);
  }

  /** pipeline_evidence 举卡(票 03/81 的卡面文案,逐字保持):卡面区分
   *  盲输入/普通全缺两种情形;等待通知走 notifyWaitingCard——整个重试
   *  窗生命周期里人只在这一刻被通知一次。 */
  private raiseEvidenceCard(
    live: LiveIssue,
    repo: string,
    sha: string,
    artifacts: string[],
    assessment: PipelineEvidenceAssessment,
    blind: boolean,
  ): void {
    const { state } = live;
    if (blind) {
      const raised = this.raisePipelineGate(live, repo, sha,
        "pipeline_evidence",
        "流水线红灯,但平台摘要只有链接且无产物——请把平台上失败项的"
          + "报错原文粘贴进本卡作答,平台会带着证据继续修复",
        [
          "**盲输入原因**",
          "",
          "平台摘要只有链接且无产物:平台没有给出 checks 结构化明细,"
            + "失败摘要抠掉链接后没有可定位的报错,失败产物也没有镜像"
            + "下来——修复会话手里没有任何可信失败证据,派修只会猜改。",
          "",
          "**镜像产物**",
          "",
          artifacts.length
            ? `失败产物全文已镜像到会话工作区 pipeline/ 目录(${artifacts.join("、")})。`
            : "平台未返回本次失败产物,可到交付平台的 MR/流水线页面查看详情。",
          "",
          "**怎么办**",
          "",
          "把平台上失败项的报错原文(带文件/行号/堆栈)直接粘贴进本卡的"
            + "输入框提交。平台会把原文作为人工证据注入下一修复回合(该轮"
            + "会消耗修复轮预算),AI 按原文定位修复后同分支再推,流水线"
            + "重新监看。空答复无法作为修复证据。",
        ].join("\n"));
      if (!raised) saveState(live.root, state);
      this.log(`[issue-flow] ${live.id} 流水线红灯盲输入(${repo})`
        + ` @ ${sha.slice(0, 12)},${raised ? "举卡请人贴原文" : "已有闸,留痕停机"}`);
      return;
    }
    const dims = dimensionLabels(assessment.missingDimensions);
    const reasons = evidenceGapReasons(assessment).join(";").slice(0, 600);
    const raised = this.raisePipelineGate(live, repo, sha,
      "pipeline_evidence",
      `流水线红灯(维度: ${dims}),但没有可定位的具体报错——请把平台上`
        + "失败项的报错原文粘贴进本卡作答,平台会带着证据继续修复",
      [
        "**缺口维度与原因**",
        "",
        ...evidenceGapReasons(assessment).map((reason) => `- ${reason}`),
        "",
        "**镜像产物**",
        "",
        artifacts.length
          ? `失败产物全文已镜像到会话工作区 pipeline/ 目录(${artifacts.join("、")}),但其中没有可定位的报错原文。`
          : "平台未返回本次失败产物,可到交付平台的 MR/流水线页面查看详情。",
        "",
        "**怎么办**",
        "",
        "把平台上失败项的报错原文(带文件/行号/堆栈)直接粘贴进本卡的"
          + `输入框提交(缺口原因: ${reasons})。平台会把原文作为人工证据`
          + "注入下一修复回合(该轮会消耗修复轮预算),AI 按原文定位修复后"
          + "同分支再推,流水线重新监看。空答复无法作为修复证据。",
      ].join("\n"));
    if (!raised) saveState(live.root, state);
    this.log(`[issue-flow] ${live.id} 流水线红灯证据全缺(${repo},维度 `
      + `${dims})@ ${sha.slice(0, 12)},${raised ? "举卡请人贴原文" : "已有闸,留痕停机"}`);
  }

  /** 重试窗的一拍:清旧表→按剩余时间排下一评。delay=min(节拍,距截止
   *  剩余)——到点那一拍准时落,不重置截止;unref 不阻进程关停。 */
  private scheduleEvidenceRetry(
    live: LiveIssue,
    repo: string,
    sha: string,
    run: PipelineRun,
  ): void {
    const key = `${live.id}:${repo}`;
    const prior = this.evidenceRetryTimers.get(key);
    if (prior) clearTimeout(prior);
    const watch = live.state.pipelines?.[repo];
    if (!watch || watch.sha !== sha || !watch.evidence_retry_deadline
        || live.state.gate || isTerminal(live.state.status)) return;
    const remaining =
      Date.parse(watch.evidence_retry_deadline) - Date.now();
    const { tickMs } = this.evidenceRetryKnobs();
    const timer = setTimeout(() => {
      this.evidenceRetryTimers.delete(key);
      void this.evaluateEvidenceRetry(live, repo, sha, run);
    }, Math.max(0, Math.min(tickMs, remaining)));
    timer.unref?.();
    this.evidenceRetryTimers.set(key, timer);
  }

  /** 重试窗重评:重拉镜像(产物晚到自愈)→重跑证据评估。证据出现→
   *  走正常派修路径(含既有分级文案);到点仍缺→举卡一次。每轮重评
   *  前查会话状态(票 82 红线):取消/终态/已举卡/等作答/换提交即收手。 */
  private async evaluateEvidenceRetry(
    live: LiveIssue,
    repo: string,
    sha: string,
    run: PipelineRun,
  ): Promise<void> {
    const { state } = live;
    const watch = state.pipelines?.[repo];
    if (!watch || watch.sha !== sha || !watch.evidence_retry_deadline
        || state.gate || state.status === "waiting_user"
        || isTerminal(state.status)) {
      if (watch?.sha === sha) {
        // 收手即清账落盘:取消/举卡/等作答后盘上不留悬空的窗。
        this.clearEvidenceRetry(watch);
        saveState(live.root, state);
      }
      return;
    }
    // 重评即重拉+重读盘+重跑 assess(镜像委托每次都从平台重新取)。
    const artifacts = await this.mirrorPipelineArtifactsFor(live, repo, sha);
    const assessment = assessPipelineRepairEvidence({
      checks: run.checks ?? watch.checks,
      artifacts: this.pipelineArtifactTexts(live),
      failureSummary: run.log ?? watch.evidence_failure_log,
    });
    const missing = (assessment.failedDimensions.length > 0
      && assessment.availableDimensions.length === 0)
      || (assessment.failedDimensions.length === 0
        && isBlindPipelineInput(run.log ?? watch.evidence_failure_log ?? "",
          artifacts.length > 0));
    if (!missing) {
      // 证据出现:清窗,走正常派修路径(刹车/预算/分级文案都在里面)。
      this.log(`[issue-flow] ${live.id} 证据重试窗内取到证据(${repo})`
        + ` @ ${sha.slice(0, 12)},自动派修(人无感)`);
      this.clearEvidenceRetry(watch);
      saveState(live.root, state);
      this.dispatchPipelineRepair(live, repo, sha, run, artifacts, assessment);
      return;
    }
    watch.evidence_retry_attempts = (watch.evidence_retry_attempts ?? 0) + 1;
    const remaining = Date.parse(watch.evidence_retry_deadline) - Date.now();
    if (remaining <= 0) {
      // 到点仍缺:清窗再举卡(通知只此一次),留痕带上已试次数。
      const attempts = watch.evidence_retry_attempts ?? 0;
      this.clearEvidenceRetry(watch);
      const note = `证据重试窗(重评 ${attempts} 次)到点仍无可定位报错——`
        + "已举卡请人把报错原文粘贴进会话,作答后带着证据继续修复";
      watch.last_error = note;
      state.stage_note = note;
      saveState(live.root, state);
      this.raiseEvidenceCard(live, repo, sha, artifacts, assessment,
        assessment.failedDimensions.length === 0);
      return;
    }
    saveState(live.root, state);
    this.scheduleEvidenceRetry(live, repo, sha, run);
  }

  /** 派修路(票 82 从结算抽出):同提交刹车 → 修复轮预算 → 分级回合
   *  指令。进入前证据评估已通过(全缺/盲输入走了重试窗路)。 */
  private dispatchPipelineRepair(
    live: LiveIssue,
    repo: string,
    sha: string,
    run: PipelineRun,
    artifacts: string[],
    assessment: PipelineEvidenceAssessment,
  ): void {
    const { state } = live;
    const watch = state.pipelines?.[repo];
    if (!watch) return;
    const max = repairBudget(this.options.settings);
    // 同提交刹车(票 82,需求流 last_sha===sha→halted 同语义):红灯
    // 还是上次派修的同一提交=修了没出新提交,再派只会原地打转——停机
    // 不派:reds 不变(不耗预算),会话最后一次发言(AI 的诊断)写进
    // 留痕与通知,"把 AI 的诊断交给我"。
    if (watch.last_repair_sha && watch.last_repair_sha === sha) {
      const diagnosis = (state.last_reply ?? "").trim();
      const note = `流水线红灯仍是上次派修的同一提交(${sha.slice(0, 12)})`
        + "——修复没有产出新提交,已停机不再派修,请人工处理";
      // 刹车停机同时清重试窗字段(窗内重评若撞上刹车情形,同样收手):
      // last_repair_sha 留着——人回复后 AI 再重推同一提交仍要再刹。
      this.clearEvidenceRetry(watch);
      watch.last_error = note;
      state.stage_note = diagnosis
        ? `${note};AI 最后诊断: ${diagnosis.slice(0, 300)}`
        : `${note}(会话没有留下诊断发言)`;
      recordTransition(state, {
        source: "platform",
        note: diagnosis
          ? `同提交刹车(${repo})@ ${sha.slice(0, 12)}:自动修复停机,`
            + `AI 诊断: ${diagnosis.slice(0, 300)}`
          : `同提交刹车(${repo})@ ${sha.slice(0, 12)}:自动修复停机`
            + "(会话没有留下诊断发言)",
      });
      saveState(live.root, state);
      this.log(`[issue-flow] ${live.id} 同提交刹车(${repo})`
        + ` @ ${sha.slice(0, 12)},reds 保持 ${watch.reds ?? 0},`
        + `${diagnosis ? "带 AI 诊断停机" : "无诊断发言停机"}`);
      this.notifyPipelineStopped(live,
        `pipeline_repair_brake:${repo}:${sha}`,
        `${this.issueSubject(live)}:仓 ${repo} 流水线红灯仍是上次派修的`
          + `同一提交(${sha.slice(0, 12)}),修复没有产出新提交,自动修复`
          + "已暂停。"
          + (diagnosis
            ? `修复会话的诊断: ${diagnosis.slice(0, 600)}`
            : "修复会话没有留下诊断发言。")
          + "请人工查看 MR/流水线,处理后发消息继续");
      return;
    }
    // 修复轮预算(与需求侧同一管理页旋钮 repair_rounds,缺省 20):
    // 走到这里都是"可修"的红灯(不可修/证据全缺已在上面停表),派
    // 修复回合前才记一轮,绿了清零;超限停止自动回灌修复——留痕(上面的
    // 反馈账)照记,但不再开回合让 AI 空转,请人工处理后发消息继续
    // (与需求侧"红灯即留痕请人工"同一诚实语义)。预算 0 时第一次
    // 可修红灯也在此停机。
    const reds = (watch.reds ?? 0) + 1;
    watch.reds = reds;
    if (reds > max) {
      watch.last_error =
        `流水线红灯修复轮预算耗尽(${max} 轮),请人工查看流水线`;
      state.stage_note = `流水线连续 ${reds} 次红灯,修复轮预算(${max} 轮)`
        + "已耗尽——请人工查看 MR/流水线;处理后发消息继续";
      saveState(live.root, state);
      this.log(`[issue-flow] ${live.id} 流水线修复轮预算耗尽(${repo},`
        + `${reds}/${max}) @ ${sha.slice(0, 12)}`);
      // 放弃点通知(票 81,需求侧 notifyRepairStopped 同语义):预算烧完
      // 就是"机器放弃、该人接手"的时刻,主动喊人。同因(同仓同提交)
      // 再停机凭 outcome 通道幂等不重发。
      this.notifyPipelineStopped(live,
        `pipeline_repair_exhausted:${repo}:${sha}`,
        `${this.issueSubject(live)}:流水线连续 ${reds} 次红灯,修复轮预算`
          + `(${max} 轮)已耗尽,自动修复已放弃。请人工查看 MR/流水线,`
          + "处理后发消息继续");
      return;
    }
    // 派修即记账(票 82):本轮提交与红灯摘要落账——下一轮"换新提交"
    // 红灯时作为上轮报错拼进回合提示词(先写账再开回合,进程死在两行
    // 之间也只是多记一轮,不会把账记到没派过的提交头上)。
    const previousSha = watch.last_repair_sha;
    const previousSummary = watch.last_failure_summary;
    watch.last_repair_sha = sha;
    watch.last_failure_summary =
      pipelineFailureDigest(run, run.checks ?? watch.checks);
    // ④ 分级回合指令:全部维度有证据=照常派修并点名维度;部分缺=
    // 缺口维度点名"不许猜改"并同时请人补原文;checks 缺席(没有任何
    // 失败维度信息)=按原盲修复路径派修,不加分级段(文案已有
    // "平台未返回产物"分支兜底)。
    let graded = "";
    if (assessment.failedDimensions.length
        && assessment.missingDimensions.length === 0) {
      graded = `本次红灯维度(${dimensionLabels(assessment.failedDimensions)})`
        + "都有可定位的具体报错,按证据照常修复。\n";
    } else if (assessment.missingDimensions.length) {
      graded = `有证据的维度(${dimensionLabels(assessment.availableDimensions)})`
        + `照常修复;缺口维度(${dimensionLabels(assessment.missingDimensions)})`
        + "平台没有给出可定位的报错原文,不许猜改。\n"
        + `缺口原因: ${evidenceGapReasons(assessment).join(";")}。\n`
        + "同时请人工把平台上对应失败项的报错原文(带文件/行号/堆栈)"
        + "直接粘贴到会话,下一轮修复会作为证据使用。\n";
    }
    // 维度归类错配的兜底(见 pipelineEvidence 跨维度兜底):明示按内容
    // 采信了哪份日志,修复侧以日志原文为准定位,别被维度标签带偏。
    const mismatch = assessment.fallbackSources.length
      ? `证据备注: 平台维度归类与日志内容不一致,已按内容采信——`
        + `${assessment.fallbackSources.join(";")}。以日志原文为准定位。\n`
      : "";
    // 上轮报错对比段(票 82,需求流 previousFailure 同语义):机制是
    // 代码(账在上面),纪律是提示词(下面这段),缺一不可。
    const previousFailure = previousSha && previousSummary
      ? `上一轮(提交 ${previousSha.slice(0, 12)})红灯的报错摘要如下,`
        + "先对比是否同一处:\n"
        + `${previousSummary}\n`
        + "纪律:同一处必须换思路,换思路也解决不了就直说修不了,"
        + "不许重复同样的修改。\n"
      : "";
    saveState(live.root, state);
    this.startPlatformTurn(live,
      `平台通知: 流水线未通过(仓 ${repo},第 ${reds}/${max} 次红灯,`
        + "仍在「提交 MR·跑绿」阶段)。\n"
        + `${describePipelineRun(run)}\n`
        + (artifacts.length
          ? `失败产物全文已镜像到会话工作区 pipeline/ 目录`
            + `(${artifacts.join("、")}),先用 Bash 读全文定位,再修。\n`
          : "平台未返回本次失败产物,请按上方摘要与各维度链接定位。\n")
        + graded
        + mismatch
        + previousFailure
        + "请修复后同分支 push_branch 再 create_mr(同一 MR 会自动跟新提交),"
        + "平台会重新监看。");
  }

  /** 红灯取证的评估输入:把刚镜像到会话工作区 pipeline/ 的产物读回
   *  文本(镜像委托返回的是文件名清单,逐维度评估需要内容;直接读盘,
   *  不动公共委托的签名)。读不出的产物(二进制等)当没有,不拦主链路。 */
  private pipelineArtifactTexts(live: LiveIssue): PipelineArtifactText[] {
    const dir = join(live.root, "pipeline");
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const texts: PipelineArtifactText[] = [];
    for (const name of names) {
      try {
        texts.push({ name, text: readFileSync(join(dir, name), "utf-8") });
      } catch {
        // 单个产物读不出只损失它自己的取证路,其余照评。
      }
    }
    return texts;
  }

  /** 问题的人话称呼(通知共用的展示形态):绑了单号就带单号,没绑
   *  就裸标题。 */
  private issueSubject(live: LiveIssue): string {
    const { state } = live;
    return state.ticket
      ? `${state.title}(单号 ${state.ticket})` : state.title;
  }

  /** 放弃点 → 小鲁班(票 81,需求侧 notifyRepairStopped 同语义):
   * 预算烧完/轮询超时这类"机器放弃、需要人接手"的时刻必须主动喊人,
   * 不能等人自己刷网页。两条纪律:
   * - 幂等靠 outcome 通道既有机制(键=会话:原因:仓:提交,taskId 已含
   *   会话 id),同因重复停机/恢复重放只发一条,不自造去重;
   * - 旁路 fail-open:投递失败只记日志,停机留痕一字不动。
   * 只在放弃点调用——开始派修/修复进行中不通知(2026-09-03 拍板)。 */
  private notifyPipelineStopped(
    live: LiveIssue,
    status: string,
    summary: string,
  ): void {
    const { notifier } = this.options;
    if (!notifier) return;
    void notifier.notifyOutcome({
      taskId: live.id,
      account: live.state.account,
      status,
      summary,
      link: this.issueLink(live.id),
    }).catch((error) =>
      this.log(`[issue-flow] ${live.id} 停机通知失败(旁路,留痕照旧): `
        + String(error)));
  }

  /** 红灯停机升级为平台闸(票 03):把"stage_note 停机请人"升级成可
   *  作答的结构化卡(与 analysis_confirm/env_verify 同一闸管道:码表
   *  出自 stageRegistry,作答走 resolveGate,等待通知走 notifyWaitingCard
   *  ——小鲁班的通知由它顺带承担,不再单发停机通知)。waiting_user 的
   *  定格与 raiseGate 纪律一致:回合还在收尾(turning 在握)时只落闸,
   *  由 settle 在回合终点凭 state.gate 定格并通知;监看器后台结算(常态)
   *  则当场定格 waiting_user 并通知。盘上已有别的闸时不覆盖(先到的卡
   *  优先),返回 false 由调用方退回纯留痕停机。 */
  private raisePipelineGate(
    live: LiveIssue,
    repo: string,
    sha: string,
    kind: "pipeline_unfixable" | "pipeline_evidence",
    question: string,
    context: string,
  ): boolean {
    const { state } = live;
    if (state.gate) return false;
    raiseGate(state, kind, question, undefined, context, undefined, undefined,
      { repo, sha });
    // waiting_user 的定格与 raiseGate 纪律一致:回合还在收尾(turning
    // 在握)时只落闸——settle 在回合终点凭 state.gate 定格;监看器后台
    // 结算(常态)则当场定格 waiting_user 并通知。落闸即落盘(与工具层
    // 举闸后的 persist 同一纪律,进程不在两件事之间丢闸)。
    if (!this.turning.has(live.id)) state.status = "waiting_user";
    saveState(live.root, state);
    if (state.status === "waiting_user") this.notifyWaitingCard(live);
    return true;
  }

  /** 平台身份头(与 pipelineClient 的 pipelineHeaders 完全同形):
   *  产物端点与状态端点同一鉴权形态,凭据止步宿主。 */
  private platformHeaders(account: string): Record<string, string> {
    const credential = this.options.gitCredential?.(account);
    return credential
      ? {
          "x-mfc-git-user": encodeURIComponent(credential.username),
          "x-mfc-git-token": encodeURIComponent(credential.password),
        }
      : {};
  }

  /** 平台侧开回合(闸门裁决/流水线结果的交接词)。会话正忙(等用户/
   * 运行中/终态)时不抢方向盘:通知挂到 stage_note,续聊提示词会带上。 */
  private startPlatformTurn(live: LiveIssue, message: string): void {
    const { state } = live;
    if (isTerminal(state.status) || this.turning.has(live.id)
        || state.status === "waiting_user") {
      state.stage_note = message.split("\n")[0].slice(0, 120);
      saveState(live.root, state);
      return;
    }
    this.continueTurn(live, message);
  }

  // ---- 无单挂起 → 关联单号转正(2026-08-27 拍板) ----

  /** 两段式:不带 confirm → 只做 DTS 存在性校验并把单据详情给用户
   * 过目;带 confirm → 转正:新会话继承工作区与分析报告直接进「问题
   * 修改」,旧会话归档(结论 converted)。同用户+同单号至多一个活跃
   * 会话。转正后不可逆——单号是新会话的身份(分支名/MR/台账都带)。 */
  async associate(id: string, input: {
    ticket: string;
    confirm?: boolean;
  }): Promise<{ ticket_detail?: DtsTicketDetail; converted?: IssueSummary }> {
    const live = this.require(id);
    const { state } = live;
    if (state.mode !== "fixed" || state.scenario !== "no_ticket") {
      throw new IssueControlError("只有无单固定流程的挂起会话才能关联转正");
    }
    if (state.status !== "suspended") {
      throw new IssueControlError(
        `当前状态 ${state.status} 不能关联转正(要走完问题分析并确认是问题、挂起后再来)`);
    }
    const ticket = input.ticket?.trim() ?? "";
    if (!TICKET_PATTERN.test(ticket)) {
      throw new IssueControlError("单号只能是字母数字下划线连字符");
    }
    if (!this.options.dts) {
      throw new DtsGatewayUnconfiguredError(
        "DTS 网关未配置,无法校验单号(部署需 --dts-mcp-url 或 --dts-mock)");
    }
    const clash = [...this.live.values()].find((item) =>
      item.id !== id
      && item.state.account === state.account
      && item.state.ticket === ticket
      && !isTerminal(item.state.status));
    if (clash) {
      throw new IssueControlError(
        `单号 ${ticket} 已有活跃会话 ${clash.id},同一单号不能重复关联`);
    }
    // 网关失败不再本地包成控制错误(#9 单点映射):网关查询失败
    // (含查无此单)按 McpGatewayError 原样上抛,路由层统一译成 502,
    // 与拉单/详情/图代理同一出口。
    const detail = await this.options.dts.detail(ticket);
    if (!input.confirm) {
      return { ticket_detail: detail };
    }

    // ---- 转正:新会话继承现场 ----
    const newId = this.nextId();
    const newRoot = join(this.issuesRoot, newId);
    mkdirSync(newRoot, { recursive: true });
    // 工作区复制:repo/(平铺的全部代码仓)+ 分析报告(skills 由
    // openDriver 重物化,local-logs 不带——新一轮要拉新日志)。老会话
    // 遗留的 ref/ 目录(平铺前的参考仓)原样跟走,读代码不受影响。
    if (existsSync(join(live.root, "repo"))) {
      cpSync(join(live.root, "repo"), join(newRoot, "repo"), { recursive: true });
    }
    if (existsSync(join(live.root, "ref"))) {
      cpSync(join(live.root, "ref"), join(newRoot, "ref"), { recursive: true });
    }
    if (existsSync(join(live.root, "issue-analysis.md"))) {
      cpSync(join(live.root, "issue-analysis.md"),
        join(newRoot, "issue-analysis.md"));
    }
    // 环境凭据:两组各自解出、各自给新会话存一份自己的(vault 按会话 id
    // 隔离;先复制后销毁旧的,顺序不能反)。解不出的组优雅缺省——后台
    // 是消费方在场的依据,页面只是记录,谁解不出来就只缺谁,不炸转正。
    const oldEnvironment = state.environment;
    let environment: IssueEnvironmentConfig | undefined;
    if (oldEnvironment) {
      const backendPassword = this.vault.credential(
        id, oldEnvironment.credential_ref, "sopuser")?.password;
      const page = oldEnvironment.page_credential_ref
        ? this.vault.credential(id, oldEnvironment.page_credential_ref)
        : undefined;
      const rows: VaultEnvironmentInput[] = [];
      if (backendPassword) {
        rows.push(backendVaultRow(oldEnvironment.name, oldEnvironment.hosts[0],
          oldEnvironment.port, backendPassword));
      }
      if (page) {
        rows.push(pageVaultRow(oldEnvironment.name, oldEnvironment.hosts[0],
          oldEnvironment.port, page.username, page.password));
      }
      if (rows.length) {
        const refs = this.vault.store(newId, rows);
        environment = {
          credential_ref: backendPassword ? refs[0]?.id ?? "" : "",
          name: oldEnvironment.name,
          hosts: oldEnvironment.hosts,
          port: oldEnvironment.port,
          ...(page
            ? {
              page_account: page.username,
              page_credential_ref:
                refs[backendPassword ? 1 : 0]?.id ?? "",
            }
            : {}),
        };
      }
    }
    const now = new Date().toISOString();
    const converted: IssueSessionState = {
      id: newId,
      account: state.account,
      created_at: now,
      updated_at: now,
      title: state.title,
      description: state.description,
      source: "dts",
      ticket,
      ...(state.repo_urls?.length ? { repo_urls: state.repo_urls } : {}),
      ...(state.repo_url ? { repo_url: state.repo_url } : {}),
      ...(state.baseline ? { baseline: state.baseline } : {}),
      ...(state.module ? { module: state.module } : {}),
      ...(state.module_id ? { module_id: state.module_id } : {}),
      // 锁随模块走:老会话的模块是人工选的,转正后仍是人工的意志(spec #57)。
      ...(state.module_locked ? { module_locked: true } : {}),
      ...(environment ? { environment } : {}),
      mode: "fixed",
      scenario: "ticket",
      round: 1,
      // 继承段 3 个(inherited),当前 fix 段直接 in_progress(同 create
      // 的首阶段理由:转正即入场,进度条当前节点必须亮)。
      stage_states: initStageStates("ticket", 3)
        .map((entry, index) =>
          index === 3 ? "in_progress" as const : entry),
      converted_from: id,
      // 逐仓交付账只读引用(#31):账不拷贝,指向旧会话——旧会话归档但
      // issue.json 原样在,前端仓卡按引用读旧账标注「转正前」;新会话
      // 自己的 pushes/mrs/pipelines 只记新交付,两本账不混。
      inherited_accounts: { issue: id },
      status: "queued",
      stage: "fix",
      stage_note: `转正自 ${id}:分析报告已继承,直接进入问题修改`,
      stage_at: now,
      transitions: [],
    };
    recordTransition(converted, {
      source: "platform", stage: "fix",
      note: `由 ${id} 关联单号 ${ticket} 转正,分析报告已继承`,
    });
    // 继承仓全部切好转正分支(仓平等:每个在场仓都建,建不动的如实留日志)。
    for (const repo of issueRepoWorkspaces(converted, newRoot)) {
      if (!existsSync(join(repo.dir, ".git"))) continue;
      try {
        await ensureBranch({
          dataDir: this.options.dataDir,
          repoDir: repo.dir,
          branch: expectedBranch(converted),
        });
      } catch (error) {
        this.log(`[issue-flow] ${newId} 转正建分支失败(${repo.url}): ${String(error)}`);
      }
    }
    saveState(newRoot, converted);
    this.live.set(newId, {
      id: newId, root: newRoot, state: converted,
      humanGate: new HumanGate(join(newRoot, "waiting.json")),
      controlEpoch: 0,
    });
    // 旧会话收口(不经 control:结论与链接有专属语义)。
    state.conclusion = {
      kind: "converted",
      summary: `已关联单号 ${ticket},转正为 ${newId}`,
      at: now,
    };
    state.converted_to = newId;
    state.status = "archived";
    recordTransition(state, {
      source: "platform", note: `关联单号 ${ticket} 转正为 ${newId},本会话收口`,
    });
    saveState(live.root, state);
    this.releaseDriver(live);
    this.stopContainerInBackground(live, "关联单号转正");
    this.vault.remove(id);
    this.log(`[issue-flow] ${id} 关联 ${ticket} 转正为 ${newId}`);
    void this.pump();
    return { converted: summarize(converted) };
  }

  // ---- 关停 ----

  async shutdown(): Promise<void> {
    // 证据重试窗的在途定时器一并清(票 82):unref 本不阻进程,但显式
    // 清掉才不会有关停后仍触发的重评(测试 --force-exit 也干净)。
    for (const timer of this.evidenceRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.evidenceRetryTimers.clear();
    const work = [...this.live.values()].map(async (live) => {
      await live.driver?.abort().catch(() => undefined);
      this.releaseDriver(live);
      await this.stopContainer(live);
    });
    const settled = await Promise.allSettled(work);
    const failures = settled
      .filter((item): item is PromiseRejectedResult => item.status === "rejected")
      .map((item) => item.reason);
    if (failures.length) {
      throw new AggregateError(failures,
        `问题会话关停时有 ${failures.length} 个容器未能确认回收`);
    }
  }
}

/** 供 server 路由做类型收窄的状态导出。 */
export type { IssueStatus, IssueStage, IssueSummary };
