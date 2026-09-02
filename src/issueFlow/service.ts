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
import { TaskContainer, taskContainerInstance } from "../containerRuntime.ts";
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
import type { IssueOpsTools } from "./opsTools.ts";
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
  memory: string;
  cpus: string;
  user?: string;
  pidsLimit: number;
  network: string;
}

export interface IssueFlowOptions {
  dataDir: string;
  provider: string;
  model: string;
  modelsJson: Record<string, unknown>;
  settings?: {
    models(): { json?: Record<string, unknown>; provider?: string; model?: string };
    /** 流水线监看的轮询节奏(与需求侧同一份运行参数)。 */
    runtime?(): { poll_interval_s?: number; poll_timeout_s?: number };
  };
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
  dts?: DtsGateway;
  /** 交付平台适配层(--platform):MR 创建与需求交付共用同一端点。 */
  platformUrl?: string;
  vault?: IssueEnvironmentVault;
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

export class IssueFlowService {
  private readonly options: IssueFlowOptions;
  private readonly vault: IssueEnvironmentVault;
  private readonly issuesRoot: string;
  private readonly live = new Map<string, LiveIssue>();
  private readonly turning = new Set<string>();
  private recoveryStarted = false;
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
        if (state.mode === "fixed" && watch.watching) {
          this.log(`[issue-flow] ${state.id} 恢复流水线监看(${repo})`
            + ` @ ${watch.sha.slice(0, 12)}`);
          void this.watchPipeline(live, repo, watch.sha);
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
    const rows = [...this.live.values()].map((item) => summarize(item.state));
    rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return account ? rows.filter((row) => row.account === account) : rows;
  }

  private require(id: string): LiveIssue {
    const live = this.live.get(id);
    if (!live) throw new IssueNotFoundError(id);
    return live;
  }

  get(id: string): IssueSummary & {
    waiting?: WaitingRecord;
    has_analysis: boolean;
  } {
    const live = this.require(id);
    return {
      ...summarize(live.state),
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
        note: `固定流程会话已登记(${scenario === "ticket" ? "有单七阶段" : "无单三节点"})`,
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
      { moonlight: this.moonlightOn(live) }));
  }

  /** 并发额度:同时进行的回合数(等待用户/闲置/挂起的会话不占额度)。 */
  private async pump(): Promise<void> {
    for (const live of this.live.values()) {
      if (this.turning.size >= (this.options.maxConcurrentTurns ?? 2)) break;
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
            { moonlight: this.moonlightOn(live) })
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

  /** 单回合执行骨架:统一失败收口,绝不把异常闷成悬挂状态。 */
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
      live.state.status = "failed";
      live.state.error = detail;
      saveState(live.root, live.state);
      this.releaseDriver(live);
      this.log(`[issue-flow] ${live.id} 回合失败: ${detail}`);
    } finally {
      // waiting_user 的回合还没真正结束(AskUserQuestion 挂起中,作答后
      // 还会在同一回合里继续用 bash)——容器必须留着。
      if (live.controlEpoch === epoch
          && live.state.status !== "waiting_user") {
        this.stopContainerInBackground(live, "回合收口");
      }
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
      subject: state.ticket
        ? `${state.title}(单号 ${state.ticket})` : state.title,
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
   * `.cac/skills/`,非空才真举。扫描为空留一行转移账(现场可查),
   * 不举卡——浪费用户一次点击的卡不是好卡。返回是否举了(工具回执
   * 据此叫 Agent 停回合)。 */
  private raiseSkillSelectionGate(live: LiveIssue): boolean {
    const { state } = live;
    if (state.mode !== "fixed" || !state.scenario) return false;
    if (stageEntryGate(state.stage as FixedStage) !== "skill_select") {
      return false;
    }
    if (this.moonlightOn(live)) return false;
    if (state.skill_selection) return false;
    if (state.gate) return false;
    const skills = this.scanBusinessSkills(live);
    if (!skills.length) {
      recordTransition(state, {
        source: "platform",
        note: "进入问题分析:已拉仓内未发现业务 skill(.cac/skills),"
          + "AI 按取用次序自主定位",
      });
      return false;
    }
    raiseGate(
      state,
      "skill_select",
      "进入问题分析:勾选要 AI 必读的仓内排障知识(可多选)",
      undefined,
      "以下是从已拉取的仓里扫描到的业务 skill(.cac/skills)。勾选的会"
        + "成为 AI 的必读材料;一个都不选则 AI 按方法论取用次序自主决定。",
      undefined,
      skills,
    );
    this.log(`[issue-flow] ${live.id} 举 skill 圈选闸:`
      + ` ${skills.map((skill) => skill.name).join("、")}`);
    return true;
  }

  /** 扫描已拉仓工作区里的业务 skill(ADR-0011):repo/<仓名>/.cac/
   * skills/<名>/SKILL.md 标准一层目录。本地文件系统扫描,零新增网络
   * 路径——仓已落地,这就是 Agent 视角的同一份事实(需求侧走网络
   * 发现是因为下单时仓还没 clone,威胁模型不同)。 */
  private scanBusinessSkills(live: LiveIssue): IssueSkillChoice[] {
    const choices: IssueSkillChoice[] = [];
    for (const repo of issueRepoWorkspaces(live.state, live.root)) {
      const skillsRoot = join(repo.dir, ".cac", "skills");
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
        choices.push({
          path: relative(live.root, skillFile).split("\\").join("/"),
          repo: repo.url,
          name: entry.name,
          description: skillDescription(skillFile),
        });
      }
    }
    return choices;
  }

  /** 月光免审批的闸代答(ADR-0006):只代答"确认类"闸——
   * analysis_confirm 全量(推荐码表定死 confirm);conclude 仅提案
   * non_issue 且自报高置信(闭环无下游闸,分级保守)。env_needed/
   * env_verify 问的是用户的事实(环境配置/验证结果),永不代答;
   * push_confirm 是用户显式开启的过目意志,同样永不代答(ADR-0009)。
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

  /** 当前生效的视觉角色(TaskService.taskVision 的同款组装):角色必须
   * 指向 models.json 中明确声明支持图片的模型,配置漂移时宁可不暴露
   * 工具,也不把图片误发给文本模型。缓存落会话工作区(与需求侧
   * workspace/vision-cache 同一约定;代码仓在其下的 repo/ 子目录,
   * 缓存不会被推送或结论文档卷走)。 */
  private visionCapability(workspace: string): VisionCapabilityConfig | undefined {
    const choice = this.options.vision;
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

  private async ensureContainer(live: LiveIssue): Promise<void> {
    if (!this.options.isolation || live.container) return;
    const isolation = this.options.isolation;
    const instance = taskContainerInstance(this.options.dataDir);
    const container = new TaskContainer(
      isolation.image,
      live.root,
      `mfc-${instance.namePrefix}-${live.id}`,
      (message) => this.log(`[issue-container] ${message}`),
      isolation.volumes,
      // user 必须随 limits 传到 docker run(2026-08-29 真实环境实测:
      // 漏传使容器落回镜像默认用户,安全自检"Config.User 为空或为
      // root/0"拒绝运行——需求侧同环境能跑正是它传了)。
      {
        memory: isolation.memory,
        cpus: isolation.cpus,
        pidsLimit: isolation.pidsLimit,
        user: isolation.user,
      },
      {
        network: isolation.network,
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
    );
    // root 守护进程 + 非 root 容器用户时,把工作区属主在 docker run
    // 前交给容器用户(与需求侧同款;非 root 服务自判 active:false 跳过)。
    const prepared = prepareContainerHostPaths({
      workspace: live.root,
      volumes: isolation.volumes,
      user: isolation.user,
      markerRoot: join(this.options.dataDir, ".container-ownership"),
    });
    if (prepared.active
        && (prepared.workspaceEntries || prepared.cacheTrees)) {
      this.log(`[issue-container] ${live.id} 属主准备: `
        + `workspace=${prepared.workspaceEntries},`
        + `owner=${prepared.owner!.uid}:${prepared.owner!.gid}`);
    }
    await container.start();
    live.container = container;
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
      ops: this.options.opsTools,
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
        // 同罪:只读投影,Agent 没有写它的理由。
        workspace: live.root,
        cwd: live.root,
        extraLedgerFiles: ["issue.json", "issue.json.tmp"],
        extraLedgerDirs: ["skills", ".mae-flow-work/host-skills"],
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
        { moonlight: this.moonlightOn(live) }));
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
    const code = input.code?.trim() ?? "";
    // 显示语义的 decision:提交带了人话就原样用;只带码就从码表反查;
    // 认不得的码原样示人(409 的现场账要能看到交上来的到底是什么)。
    const decision = input.decision?.trim()
      || (code ? gateOptionLabel(gate.kind, code) : "");
    const notes = input.notes?.trim() ?? "";
    const supplement = notes ? `\n用户补充说明: ${notes}` : "";
    // 先裁决后动手:认不得的答复在状态未动前打回(不留下"闸已清、
    // 转移已记"的半截账)。
    const verdict = gateVerdict(gate.kind, code);
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
          + "(业务仓 .cac/skills、货架通用 skill、issue-research、自行取证)。"];
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
   * 回合标记。读类,与管理员只读边界一致。 */
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
    if (isTerminal(live.state.status)) {
      throw new IssueControlError(`会话已处于终态 ${live.state.status}`);
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
    const now = Date.now();
    const { budgetMs } = this.pipelineKnobs();
    (state.pipelines ??= {})[repo] = {
      sha,
      status: "running",
      watching: true,
      started_at: new Date(now).toISOString(),
      deadline: new Date(now + budgetMs).toISOString(),
      round: state.round ?? 1,
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
        this.settlePipeline(live, repo, sha, first);
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
          this.settlePipeline(live, repo, sha, latest);
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
    }
  }

  private settlePipeline(
    live: LiveIssue,
    repo: string,
    sha: string,
    run: PipelineRun,
  ): void {
    const { state } = live;
    const watch = state.pipelines?.[repo];
    if (watch?.sha !== sha) return;
    watch.status = run.status;
    watch.watching = false;
    if (run.checks) watch.checks = run.checks;
    if (run.status === "success") {
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
    saveState(live.root, state);
    this.startPlatformTurn(live,
      `平台通知: 流水线未通过(仓 ${repo},仍在「提交 MR·跑绿」阶段)。\n`
        + `${describePipelineRun(run)}\n`
        + "请修复后同分支 push_branch 再 create_mr(同一 MR 会自动跟新提交),"
        + "平台会重新监看。");
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
