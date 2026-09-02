/**
 * 进程内会话驱动(详设 §7 pi_session 的 TS 形态)。
 *
 * Pi 以 SDK 形式嵌入同一进程:tool_call 钩子即同步拦截(五问第 1 问),
 * 自定义工具的未 resolve Promise 即人工节点挂起(§5 挂起路线),
 * 子 Agent = 同进程再开一个 AgentSession(§6 平行会话)。
 * Python 版的 HTTP 环回桥与 RPC stdout 解析在这个形态下整层消失。
 *
 * 登记归属规则(防双行):谁执行谁登记——pi 真实执行的工具由
 * tool_execution_end 登记;宿主代演的(人工决定、子 Agent 结果)由
 * driver 自己 emit,pi 对这些 call_id 的回声一律丢弃。
 */

import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  createEditToolDefinition,
  createWriteToolDefinition,
  type BashOperations,
  type EditOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { constants, existsSync, readFileSync, statSync } from "node:fs";
import {
  access as fsAccess,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { EventLog, type SemanticEvent, type SemanticEventKind, validateEvent } from "./semanticEvents.ts";
import { TranscriptStore } from "./transcriptStore.ts";
import { GateService } from "./gateService.ts";
import { HumanGate, renderDecision, type WaitingRecord } from "./humanGate.ts";
import { createWorkspaceBashToolDefinition } from "./bashOutputMirror.ts";
import { materializeHostSkills } from "./hostSkillRuntime.ts";
import {
  modelTokenUsageSample,
  type ModelTokenUsageSample,
} from "./tokenUsage.ts";
import {
  KnowledgeTrace,
  type KnowledgeResourceRef,
} from "./knowledgeTrace.ts";
import type { MaterializedBusinessModuleKnowledge } from "./businessModuleRuntime.ts";
import type { MaterializedEngineeringKnowledge } from "./engineeringKnowledgeRuntime.ts";
import { materializeTaskKnowledgeIndex } from "./taskKnowledgeIndex.ts";
import {
  createInspectImageTool,
  createVisionToolState,
  type VisionCapabilityConfig,
} from "./visionCapability.ts";

/** pi 工具名 → 内核工具词汇表。不认识的原样透传(错认比不认更危险)。 */
const TOOL_NAME_MAP: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  inspect_image: "InspectImage",
};

/** 决定 → 结构化回答。显式 answers 优先;单问题卡由 decision 兜底
 * (问题文本作键,老宿主回传就是这个形状)。 */
export function answersOf(
  record: { decision: string; answers?: Record<string, string> },
  waiting: { question: Record<string, any> },
): Record<string, string> {
  if (record.answers && Object.keys(record.answers).length) {
    return record.answers;
  }
  const questions = Array.isArray(waiting.question?.questions)
    ? waiting.question.questions
    : [];
  if (questions.length === 1) {
    return { [String(questions[0]?.question ?? "问题")]: record.decision };
  }
  return { 最终确认: record.decision };
}

const HOST_TOOLS = new Set(["AskUserQuestion", "Task"]);

/** 有些模型在输出预算耗尽时已经吐出了工具调用开头，却没生成完整参数。
 * Pi 会把它记成一次普通 tool error，随后回合仍以 end_turn 收口；如果宿主
 * 不单独识别，任务就会在当前步骤反复催办，看起来永远“正在推进”。 */
export function fatalToolExecutionError(
  name: string,
  result: string,
  isError: boolean,
): string | undefined {
  if (!isError) return undefined;
  const text = result.trim();
  const outputLimit = /output token limit|maximum output tokens|max[_ -]?tokens|输出(?:长度|令牌|token)?.{0,8}(?:上限|限制)/i.test(text);
  const unexecuted = /not executed|was not run|未执行|没有执行/i.test(text);
  if (!outputLimit || !unexecuted) return undefined;
  return `模型回复超过输出上限，${name || "工具调用"}没有真正执行。`
    + "任务已停在可恢复位置，请点“重跑续推”继续；已有数据不会丢失。";
}

/** 模型网关的失败会直接进入任务卡。限流响应常夹带整段 JSON、内部错误
 * 类型与 request_id；这些对开发者没有行动价值，反而把真正的恢复时间
 * 淹没。只收敛已明确识别的 429/额度错误，其他故障仍保留原文供排查。 */
export function userFacingModelFailure(detail: string): string {
  const raw = detail.trim();
  if (!/(?:\b429\b|rate[_ ]limit|使用上限|限额.*重置|quota exhausted)/i
      .test(raw)) return raw;
  const reset = raw.match(/限额将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})\s*重置/)?.[1];
  return reset
    ? `模型额度已用完，将于 ${reset} 恢复。任务已停在可恢复位置；`
      + "额度恢复后点“重跑续推”，已有数据不会丢失。"
    : "模型服务当前限流（429）。任务已停在可恢复位置；稍后点“重跑续推”，"
      + "已有数据不会丢失。";
}

export function validateAskUserQuestionInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return "缺少 questions";
  const request = input as Record<string, unknown>;
  const extra = Object.keys(request)
    .filter((key) => key !== "questions" && key !== "context");
  if (extra.length) return `问题卡含不支持字段 ${extra.join("、")}`;
  if (request.context !== undefined
      && (typeof request.context !== "string" || !request.context.trim())) {
    return "context 必须是非空的用户可见说明";
  }
  if (typeof request.context === "string" && request.context.length > 2_000) {
    return "context 最多 2000 字符";
  }
  const questions = request.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return "questions 必须包含至少一个问题";
  }
  if (questions.length > 4) return `一张卡有 ${questions.length} 个问题，最多四个`;
  for (let index = 0; index < questions.length; index += 1) {
    const value = questions[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return `第 ${index + 1} 题不是问题对象`;
    }
    const question = value as Record<string, unknown>;
    const extra = Object.keys(question)
      .filter((key) => key !== "question" && key !== "options"
        && key !== "recommended");
    if (extra.length) {
      return `第 ${index + 1} 题含不支持字段 ${extra.join("、")}`;
    }
    if (typeof question.question !== "string" || !question.question.trim()) {
      return `第 ${index + 1} 题缺少问题正文`;
    }
    if (question.recommended !== undefined
        && typeof question.recommended !== "string") {
      return `第 ${index + 1} 题的 recommended 不是字符串`;
    }
    if (question.options === undefined) {
      // 推荐协议(ADR-0004):推荐挂在选项上,自由作答题带它是误用。
      if (question.recommended !== undefined) {
        return `第 ${index + 1} 题是自由作答题(未给 options),不能带 recommended`;
      }
      continue;
    }
    if (!Array.isArray(question.options)) {
      return `第 ${index + 1} 题的 options 不是数组`;
    }
    const options = question.options.map((option) =>
      typeof option === "string" ? option.trim() : "");
    if (options.length < 2) return `第 ${index + 1} 题只有 ${options.length} 个选项`;
    if (options.length > 6) return `第 ${index + 1} 题有 ${options.length} 个选项，最多六个`;
    if (options.some((option) => !option)) return `第 ${index + 1} 题含空选项`;
    if (new Set(options).size !== options.length) return `第 ${index + 1} 题含重复选项`;
    // 推荐是协议必填而非可选礼貌(将来无审批全自动模式要按它执行):
    // 必须给、trim 后与选项原文逐字命中。选项已去重,命中即唯一。
    const recommended = String(question.recommended ?? "").trim();
    if (!recommended) {
      return `第 ${index + 1} 题缺少推荐项:选项题必须带 recommended`
        + "(所推荐选项的原文)";
    }
    if (!options.includes(recommended)) {
      return `第 ${index + 1} 题的推荐项不在选项中:「${recommended.slice(0, 40)}」`
        + "须与 options 之一逐字一致(trim 后比对)";
    }
  }
  return undefined;
}

export interface Outcome {
  status: "turn_finished" | "waiting_for_human" | "session_ended";
  waiting?: WaitingRecord;
  reason?: string;
  detail?: string;
}

/** 深层宿主钩子(=内核 dispatch 合成,见 kernelHost.ts)。全部可选:
 * 不接时行为与演练模式一致,接上时内核契约成为真正的门禁与证据引擎。 */
export interface HostHooks {
  preTool?(event: SemanticEvent): Promise<{ action: string; reason?: string } | undefined>;
  /** 解析出字符串 = 内核退 2 的纠偏话,调用方须送回模型,不是失败。 */
  postTool?(event: SemanticEvent): Promise<void | string>;
  flush?(): Promise<void>;
}

export interface CloudSessionOptions {
  taskId: string;
  workspace: string;
  agentDir: string;
  provider: string;
  model: string;
  eventLog: EventLog;
  transcript: TranscriptStore;
  gate: GateService;
  humanGate: HumanGate;
  hostHooks?: HostHooks;
  /** 专项宿主会话可关闭人工问答工具。推送前编译/UT 会话必须自己收口，
   * 不能在交付临门一脚再生成一张脱离内核语义的等待卡。缺省保留原行为。 */
  allowHumanQuestions?: boolean;
  /** 专项旁路会话可关闭 Task，避免一个轻量助手再扩散出子 Agent 树。 */
  allowSubagents?: boolean;
  /** 编译专项会话把长 Bash 的 stdout 节流写入事件账，供独立 SSE 实时
   * 展示。普通编码会话默认关闭，避免把高频输出灌进主事件账。 */
  streamBashOutput?: boolean;
  /** 同一任务事件账里的会话身份；缺省 main，旁路助手使用独立身份。 */
  sessionId?: string;
  currentStep?: () => string;
  /** 容器隔离(设计文档):换掉内建 bash 的执行后端,命令进任务
   * 容器跑;工具仍叫 bash,门禁与 transcript 看到的世界不变。
   * 子会话经同一 openSession 装配,天然同套隔离。 */
  bashOperations?: BashOperations;
  /** root 宿主 + 非 root 容器时，内建 Write/Edit 成功落盘后立刻修正
   * bind 文件属主。回调失败会让本次工具调用失败，不把隐患拖到编译时。 */
  afterFileMutation?: (absolutePath: string) => void | Promise<void>;
  /** 宿主级 skill 源目录(部署时放一次,每个任务自动带)。运行时先把
   * 每个通过校验的完整 Skill 包只读投影到当前任务 .mae-flow-work，
   * 再把任务内路径交给 Pi，不能向 Agent 暴露部署数据目录的绝对路径。
   * 团队的两个
   * UT skill 在内网、出不来仓,老宿主是"每次手动集成进 ut-generator
   * 子 agent";云端子 Agent 照样有(Task 工具),缺的是自动装载——
   * pi 的 includeDefaults=false,不喂路径就一个 skill 都不装。 */
  hostSkillsDir?: string;
  /** 用任务固定的模块/仓库/语言画像筛选尚未定格的团队 Skill；新任务
   * 已在创建现场生成精确快照，后续会话不应重复匹配。 */
  knowledgeContext?: {
    repositories: string[];
    technologies: string[];
    businessModuleIds: string[];
  };
  /** 知识匹配口径:缺省 task;问题会话传 issue(ADR-0005)——未限定
   * 作用域的通用工程知识豁免进会话,技术栈维度不参与过滤。 */
  knowledgeScope?: "task" | "issue";
  /** 本单明确选中的仓库 Skill。每项必须是一个存在的 SKILL.md 文件；
   * 不能传 skills 目录，否则同目录下未选择的 Skill 也会被 Pi 扫入。
   * 跨仓时可同时传多个仓各自的文件，主/子 Agent 共用同一 allowlist。 */
  repositorySkillPaths?: string[];
  /** 与 repositorySkillPaths 一一对应的业务身份，仅用于知识足迹归因；
   * 缺失时仍能按实际 Skill 文件记录，不影响装载。 */
  repositorySkillResources?: Array<KnowledgeResourceRef & { actual_path: string }>;
  /** 会话专属宿主工具(defineTool 形状)。问题流这样的旁路会话用它把
   * 平台原子能力(报阶段/拉日志/受门禁的推送)递给 Agent——秘密留在
   * 宿主,Agent 只拿到工具语义。内核任务不传,行为不变。 */
  extraTools?: unknown[];
  /** 创建任务时固定的业务模块知识。非 Skill 只进入统一轻量索引；
   * 正文保留为工作区文件，由 Agent 使用 Read/Grep 按需读取。 */
  businessModuleKnowledge?: MaterializedBusinessModuleKnowledge;
  /** 已发布且与本任务画像匹配的团队工程文档、规则和示例；正文按需读。 */
  engineeringKnowledge?: MaterializedEngineeringKnowledge;
  knowledgeTrace?: KnowledgeTrace;
  /** 上下文超限自愈用的锚点提供者(通常是内核现场 current/config)。
   * 不给就用需求原话兜底——锚永远来自权威,不由云端编造。 */
  compactAnchor?: () => string;
  /** 模型提供方真实 usage 的旁路出口。统计失败不得影响会话。 */
  onTokenUsage?: (sample: ModelTokenUsageSample) => void;
  /** 专用图片理解模型。只给主开发/修复会话配置；子 Agent 经同一
   * openSession 继承，预热与 prepush 专项会话不隐式获得此能力。 */
  vision?: VisionCapabilityConfig;
  log?: (message: string) => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** 上下文撑爆的判据。各家网关文案不同,只认这几种说法的交集:
 * 内网网关实测 "input too long, exceed max input length, max input
 * length is 169984, current input length is 171308";Anthropic 系是
 * "prompt is too long"/context_length_exceeded;OpenAI 兼容网关是
 * "maximum context length"。**宁可漏判也不许误判**——把别的错误当
 * 超限去压缩,等于拿真错误当噪声吞掉(压完重试还是错,只是晚一步
 * 失败,但日志会误导人)。 */
export function looksLikeContextOverflow(detail: string): boolean {
  return /input too long|exceed(s)? max input length|context[_ ]length|maximum context|prompt is too long|too many tokens/i
    .test(detail);
}

/** 主动压缩的指令模板:摘要以内核锚点为纲——注意力飘不飘,锚说了算。 */
export function compactionInstructions(anchor: string): string {
  return [
    "以下是流程锚点,摘要必须围绕它组织:",
    anchor,
    "保留:当前步骤与其指引、已确认的配置与决策、未完成工作清单、",
    "最近一次错误与修复结论、正在编辑文件的关键内容。",
    "可丢弃:过程性探索、已解决问题的中间尝试、长命令输出原文(只留结论)。",
  ].join("\n");
}

/** 环回流量强制直连:pi-ai 会跟随代理环境变量,内网 Clash 实测把
 * 127.0.0.1 的模型/桥请求劫走回 502。生产同样成立——网关走代理可以,
 * 环回不行。 */
export function ensureLoopbackDirect(): void {
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const entries = (process.env[key] ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    for (const host of ["127.0.0.1", "localhost"]) {
      if (!entries.includes(host)) entries.push(host);
    }
    process.env[key] = entries.join(",");
  }
}

export class CloudSession {
  private session!: Awaited<ReturnType<typeof createAgentSession>>["session"];
  private modelRuntime!: Awaited<ReturnType<typeof ModelRuntime.create>>;
  private pendingTurn?: Promise<Outcome>;
  private waitingSignal = deferred<Outcome>();
  private decisionResolvers = new Map<string, (text: string) => void>();
  private waitingRecord?: WaitingRecord;
  private hostAnswered = new Set<string>();
  /** 主会话本轮活动量与模型层错误:pi 把 API 失败静默成
   * stopReason="error" 的空 assistant 消息(run4 实测,回合零活动
   * 直接 end_turn),宿主必须自己识别,否则空转被标成 completed。 */
  private turnActivity = 0;
  private turnError = "";
  private turnTerminalError = "";
  /** 上下文超限只自愈一次(整条会话计):压完还爆是单轮输入本身过大,
   * 再压是空转——按预算纪律,补救必须有次数上限。 */
  private overflowRepaired = false;
  private toolArgs = new Map<string, Record<string, unknown>>();
  private lastAssistantText = new Map<string, string>();
  private childCount = 0;
  private childSessions = new Map<string, any>();
  private pendingKernel = new Set<Promise<void>>();
  private kernelFailures: string[] = [];
  private readonly visionState = createVisionToolState();
  readonly sessionId: string;

  private constructor(private readonly options: CloudSessionOptions) {
    this.sessionId = options.sessionId ?? "main";
  }

  /** 主会话最后一段发言。修复会话不提交时,这就是它留给人的诊断
   * (缺什么、去哪配),halted 裁决原文上浮。 */
  finalReply(): string {
    return this.lastAssistantText.get(this.sessionId) ?? "";
  }

  static async create(options: CloudSessionOptions): Promise<CloudSession> {
    ensureLoopbackDirect();
    const driver = new CloudSession(options);
    driver.modelRuntime = await ModelRuntime.create({
      modelsPath: join(options.agentDir, "models.json"),
    });
    driver.session = await driver.openSession({
      sessionId: driver.sessionId,
      customTools: [
        ...(options.allowHumanQuestions === false ? [] : [driver.askTool()]),
        ...(options.allowSubagents === false ? [] : [driver.dispatchTool()]),
      ],
    });
    options.transcript.mainSessionId = driver.sessionId;
    return driver;
  }

  // ---- 事实登记(事件日志 → transcript,顺序固定) ----

  private emit(
    kind: SemanticEventKind,
    sessionId: string,
    payload: Record<string, unknown>,
  ): SemanticEvent {
    const event: SemanticEvent = {
      eventId: this.options.eventLog.lastEventId() + 1,
      taskId: this.options.taskId,
      sessionId,
      ts: new Date().toISOString(),
      kind,
      payload,
    };
    const error = validateEvent(event);
    if (error) throw new Error(error);
    this.options.eventLog.append(event);
    this.options.transcript.record(event);
    return event;
  }

  // ---- 生命周期 ----

  async start(userMessage: string): Promise<Outcome> {
    this.emit("session_started", this.sessionId, { resume: false });
    return this.turnWithOverflowRepair(userMessage);
  }

  /** 服务重启后的重建会话:pi 侧上下文不可恢复(inMemory),
   * 流程真相在内核状态文件与事件日志里——重建会话从内核 current
   * 续跑,这正是"裁决源在工作区"的红利。 */
  async startResume(userMessage: string): Promise<Outcome> {
    await this.reconcileInterruptedWork();
    this.emit("session_started", this.sessionId, { resume: true });
    return this.turnWithOverflowRepair(userMessage);
  }

  /** Close the lifecycle gap left by a process crash.
   *
   * A tool/child that has a durable start event but no finish event is not a
   * success and not safe to redispatch silently.  Recovery first records an
   * explicit interrupted result into the same transcript/Hook ledger, then
   * lets the new session consult the kernel current step and retry normally. */
  private async reconcileInterruptedWork(): Promise<void> {
    const events = this.options.eventLog.replay();
    for (const event of events) {
      if (event.kind !== "agent_spawned") continue;
      const payload = event.payload as Record<string, any>;
      const childId = String(payload.child_session_id ?? "");
      const callId = String(payload.call_id ?? "");
      if (childId && callId) {
        this.options.transcript.bindChild(childId, callId);
        const ordinal = /^child-(\d+)$/.exec(childId);
        if (ordinal) this.childCount = Math.max(
          this.childCount, Number(ordinal[1]));
      }
    }
    const finishedTools = new Set(events
      .filter((event) => event.kind === "tool_finished")
      .map((event) => `${event.sessionId}:${String(event.payload.call_id ?? "")}`));
    const finishedAgents = new Set(events
      .filter((event) => event.kind === "agent_finished")
      .map((event) => String(event.payload.call_id ?? "")));
    for (const event of events) {
      const payload = event.payload as Record<string, any>;
      if (event.kind === "tool_requested") {
        const callId = String(payload.call_id ?? "");
        const name = String(payload.name ?? "");
        if (!callId || name === "AskUserQuestion"
            || finishedTools.has(`${event.sessionId}:${callId}`)) continue;
        const interrupted = this.emit("tool_finished", event.sessionId, {
          call_id: callId, name, input: payload.input ?? {}, is_error: true,
          result: "服务重启时发现该工具没有可靠完成记录，已按 interrupted 登记",
        });
        this.kernelBypass(this.options.hostHooks?.postTool?.(interrupted));
      }
      if (event.kind === "agent_spawned") {
        const callId = String(payload.call_id ?? "");
        if (!callId || finishedAgents.has(callId)) continue;
        const childId = String(payload.child_session_id ?? "");
        this.emit("agent_finished", this.sessionId, {
          call_id: callId, child_session_id: childId,
          lifecycle: "interrupted",
          final_text: "服务重启时发现子 Agent 未返回，已登记中断；可按原任务卡受控重派",
        });
        this.kernelBypass(this.options.hostHooks?.postTool?.({
          eventId: this.options.eventLog.lastEventId(),
          taskId: this.options.taskId,
          sessionId: this.sessionId,
          ts: new Date().toISOString(),
          kind: "tool_finished",
          payload: {
            call_id: callId, name: "Task",
            input: {
              subagent_type: payload.agent_type,
              description: payload.description,
              prompt: payload.prompt,
            },
            is_error: true,
            result: "服务重启导致子 Agent 中断",
          },
        }));
      }
    }
    const failure = await this.flushKernel();
    if (failure) throw new Error(
      `恢复中断现场时内核登记失败，任务已安全停止: ${failure}`);
  }

  /** 恢复场景的决定回注:旧会话已死,没有挂起的工具调用可 resolve,
   * 但登记义务不变——宿主代演的工具结果由 driver 登记(tool_result
   * 与崩溃前落盘的 tool_use 行按 call_id join),答案走 posttooluse
   * 进内核台账,重建会话执行 messages 就能看到。 */
  injectDecision(record: WaitingRecord): void {
    this.emit("human_decision", this.sessionId, {
      waiting_id: record.waiting_id,
      state_version: record.state_version,
      decision: record.decision,
      notes: record.notes,
    });
    const finished = this.emit("tool_finished", this.sessionId, {
      call_id: record.call_id,
      name: "AskUserQuestion",
      input: record.question,
      is_error: false,
      result: renderDecision(record),
      answers: answersOf(record, record),
    });
    this.kernelBypass(this.options.hostHooks?.postTool?.(finished));
    this.hostAnswered.add(record.call_id);
  }

  /** Queue a Hook write without blocking the model, but never lose failure.
   *
   * The old fire-and-forget path kept the process alive by swallowing every
   * rejection.  That also let a task advance after its authorization/evidence
   * write had failed.  We now isolate the process in the same way, then flush
   * and adjudicate these writes before the turn can settle. */
  private kernelBypass(work: Promise<unknown> | undefined): void {
    if (!work) return;
    let tracked!: Promise<void>;
    tracked = work.then((feedback) => {
      // 解析出字符串 = 内核退 2 的纠偏话(补模板章节、对账不符)。那是
      // 让模型改的指令,不是登记失败——进 kernelFailures 会把"让模型改"
      // 升级成整单判死(内网实锤:IMPLEMENTATION 缺一节,任务 failed,
      // push/MR 全没发生,而模型全程没见过那句话)。
      if (typeof feedback === "string" && feedback.trim()) {
        this.relayKernelFeedback(feedback.trim());
      }
    }).catch((error) => {
      const detail = String(error);
      this.kernelFailures.push(detail);
      this.options.log?.(
        `任务 ${this.options.taskId} 内核授权/证据登记失败(fail-closed): `
        + detail);
    }).finally(() => this.pendingKernel.delete(tracked));
    this.pendingKernel.add(tracked);
  }

  /** 把内核 posttooluse 的纠偏话送回模型。单机形态里这段 stderr 由
   * harness 直接喂进上下文;云端的等价通道是 steer——当前工具调用一做完
   * 就送达,模型在同一轮里补。撞上回合收口没送到也不丢:settleTurn 的
   * "未送达插话补发"会连它一起取回补发。送达失败只记日志(fail-open):
   * 反馈丢了顶多这轮没纠,下次写同一文件内核还会再说一遍。 */
  private relayKernelFeedback(text: string): void {
    Promise.resolve()
      .then(() => (this.session as any).steer(text))
      .then(() => this.emit("user_message", this.sessionId,
        { text, via: "kernel" }))
      .catch((error) => this.options.log?.(
        `任务 ${this.options.taskId} 内核反馈未能送回会话(已丢弃): `
        + String(error)));
  }

  private async flushKernel(): Promise<string> {
    while (this.pendingKernel.size) {
      await Promise.all([...this.pendingKernel]);
    }
    try {
      await this.options.hostHooks?.flush?.();
    } catch (error) {
      this.kernelFailures.push(String(error));
    }
    const failures = this.kernelFailures.splice(0);
    return failures.join("；");
  }

  /** 发一条用户消息并跑完本轮,统一收口判定。 */
  private promptTurn(userMessage: string): Promise<Outcome> {
    this.emit("user_message", this.sessionId, { text: userMessage });
    this.turnActivity = 0;
    this.turnError = "";
    this.turnTerminalError = "";
    this.waitingSignal = deferred<Outcome>();
    this.pendingTurn = this.session
      .prompt(userMessage)
      .then(() => this.turnOutcome())
      .catch((error): Outcome => {
        const detail = userFacingModelFailure(String(error));
        this.emit("session_ended", this.sessionId, {
          reason: "failed", detail,
        });
        return { status: "session_ended", reason: "failed", detail };
      });
    return Promise.race([this.pendingTurn, this.waitingSignal.promise]);
  }

  /** 回合收口:零活动+模型层错误 = 会话失败(把 pi 吞掉的 API 错误
   * 亮出来);零活动无错误 = 空转回合(交上层催办);否则正常收轮。 */
  private async turnOutcome(): Promise<Outcome> {
    const kernelFailure = await this.flushKernel();
    if (kernelFailure) {
      const detail = `内核授权或证据登记未可靠落盘: ${kernelFailure}`;
      this.emit("session_ended", this.sessionId, {
        reason: "failed", detail,
      });
      return { status: "session_ended", reason: "failed", detail };
    }
    if (!this.turnActivity && this.turnError) {
      const detail = userFacingModelFailure(this.turnError);
      this.emit("session_ended", this.sessionId, {
        reason: "failed", detail,
      });
      return { status: "session_ended", reason: "failed", detail };
    }
    if (this.turnTerminalError) {
      const detail = this.turnTerminalError;
      this.emit("session_ended", this.sessionId, {
        reason: "failed", detail,
      });
      return { status: "session_ended", reason: "failed", detail };
    }
    const reason = this.turnActivity ? "end_turn" : "empty_turn";
    this.emit("turn_finished", this.sessionId, { reason });
    return { status: "turn_finished", reason };
  }

  /** 中途插话(本地 CLI 的 ESC 在云端的等价物)。
   *
   * 用 pi 的 steer 而不是 abort:steer 的语义是"当前这一轮的工具调用做完
   * 就送达",所以模型不会在文件写一半、构建杀一半的地方被掐断——那种半截
   * 现场比慢几秒麻烦得多。真要掐死一条卡住的长命令是另一回事(abortBash),
   * 不在这条路上。
   *
   * 这不绕过任何门禁:插话只改变模型下一步干什么,该过的证据一样得过。
   * 登记在 steer 成功之后——先记后发,发失败就会留下一条从未送达的假账。
   */
  async steer(text: string): Promise<void> {
    await (this.session as any).steer(text);
    // via 标记让重启后认得出"这条是插话":它可能还压在 pi 的内存队列里
    // 没送到,而队列随进程一起死。事件日志是唯一跨进程活下来的账。
    this.emit("user_message", this.sessionId, { text, via: "interrupt" });
  }

  /** 取走"发出去却没送到"的插话。
   *
   * 坑(读 pi 源码才发现):steer 从不抛错,它只是把消息压进内部队列。
   * 正好撞在回合间隙发出的插话,会静静躺在那儿永远没人送——靠 try/catch
   * 兜底是空想。真正可靠的判定是"回合都收口了队列还有货",那就是没送到。
   *
   * 用 clearQueue 而不是只读的 getSteeringMessages:它同时清掉 agent 侧
   * 队列,取走即归我,不会出现我补发一遍、pi 事后又送一遍。它连 followUp
   * 队列一并清空——我们从不用 followUp,清了无妨。
   */
  /** 还压在 pi 队列里、没进模型上下文的插话(只读)。
   *
   * pi 在真正开始那条用户消息时才把它移出队列,所以"不在队列里"就是
   * "模型已经读到了"——这是可观测的事实,不是推断。页面据此如实告诉人
   * "送达没有",省得他发完一句就石沉大海。 */
  /** 只记账不送达:等人决定/排队时的 @ 引用不走 steer,而是随决定或
   * 使命送达,但页面的「捎过去的话」只认事件账里的 via=interrupt。没这条
   * 账,人点完发送就石沉大海(用户 2026-09-02 实测)。必须走本会话的
   * emit——另开一个 EventLog 实例追加会让这里缓存的 lastEventId 落后,
   * 下一条真事件撞号被当重放 no-op 静默丢掉。 */
  noteUserMessage(text: string, extra: Record<string, unknown>): void {
    this.emit("user_message", this.sessionId, { text, via: "interrupt", ...extra });
  }

  pendingSteers(): string[] {
    try {
      const queue = (this.session as any).getSteeringMessages?.();
      return Array.isArray(queue) ? [...queue] : [];
    } catch {
      return [];
    }
  }

  takeUndeliveredSteers(): string[] {
    try {
      const queue = (this.session as any).clearQueue?.();
      return Array.isArray(queue?.steering) ? queue.steering : [];
    } catch {
      return [];      // 旁路一律 fail-open:取不回来也不许挡住收口
    }
  }

  /** 回合结束但流程未到终态时的催办续跑:同一会话追加一条用户消息。
   * 模型提前收嘴(run3 实测:拿到 message-id 后直接 end_turn)不等于
   * 任务完成——阶段真相只看内核状态,宿主负责把会话推回流程。 */
  async continueWith(text: string): Promise<Outcome> {
    return this.turnWithOverflowRepair(text);
  }

  /**
   * 上下文撑爆的自愈:压一次,原样重发,只补救一次。
   *
   * 为什么必须在这一层做:窗口是网关说了算的(内网实测 169984),而
   * pi 的自动压缩按它自己估的窗口走——网关比它以为的小,硬报错就漏
   * 到宿主,任务当场判死。这类失败的特点是**零活动**:模型一个字都
   * 没吐、一个工具都没调,所以原样重发是安全的,不会重做已完成的事。
   *
   * 三条边界(都是红线的直接推论):
   * - **只补救一次**。压完还爆说明不是"历史太长"而是单轮输入本身
   *   过大(比如一次贴进来一个巨型文件),再压也没用,如实失败;
   * - **压不动就如实失败**,不假装恢复;
   * - 判据从严(见 looksLikeContextOverflow):别的错误一律原样上抛,
   *   压缩不是万能兜底。
   */
  private async turnWithOverflowRepair(userMessage: string): Promise<Outcome> {
    const outcome = await this.promptTurn(userMessage);
    if (outcome.status !== "session_ended"
        || !looksLikeContextOverflow(outcome.detail ?? "")) {
      return outcome;
    }
    if (this.overflowRepaired) {
      this.options.log?.(
        `任务 ${this.options.taskId} 压缩后仍超限,如实失败(单轮输入过大?)`);
      return outcome;
    }
    this.overflowRepaired = true;
    this.options.log?.(
      `任务 ${this.options.taskId} 上下文超限,按内核锚点压缩后重试一次`);
    const anchor = this.options.compactAnchor?.()
      ?? "(无内核现场可锚,按当前任务需求组织摘要)";
    if (!await this.compactAnchored(anchor)) {
      // 压不动的最常见原因是"历史本来就不长"——那就说明撑爆的是
      // 单轮输入本身(一次贴进来的巨型文件/日志),压缩救不了。把这
      // 句话给人,别让他对着一行网关英文猜该改什么。
      return {
        ...outcome,
        detail: `${outcome.detail ?? ""}(已尝试压缩自愈但压不动:`
          + `多半是单轮输入过大而非历史太长——检查是不是把大文件或`
          + `长日志整段塞进了会话)`,
      };
    }
    return this.promptTurn(userMessage);
  }

  /** 把 Web 决定回注为 AskUserQuestion 的工具结果,继续本轮。 */
  async resumeWithDecision(record: WaitingRecord): Promise<Outcome> {
    const waiting = this.waitingRecord;
    if (!waiting) throw new Error("没有等待中的人工节点,无决定可回注");
    const resolver = this.decisionResolvers.get(waiting.call_id);
    if (!resolver) throw new Error(`没有挂起的决定通道: ${waiting.call_id}`);
    this.emit("human_decision", this.sessionId, {
      waiting_id: record.waiting_id,
      state_version: record.state_version,
      decision: record.decision,
      notes: record.notes,
    });
    // 宿主代演的工具结果由 driver 登记;pi 的回声按 hostAnswered 丢弃。
    // answers 是结构化回答(问题→选项):内核 ack 的"整份背书"判定看的是
    // 结构不是措辞——键是配置项名的只代表单项,独立确认题才能替整份背书。
    const finished = this.emit("tool_finished", this.sessionId, {
      call_id: waiting.call_id,
      name: "AskUserQuestion",
      input: waiting.question,
      is_error: false,
      result: renderDecision(record),
      answers: answersOf(record, waiting),
    });
    // 决定进内核:旧插件 posttooluse 捕获 AskUserQuestion 答案的同一路径。
    this.kernelBypass(this.options.hostHooks?.postTool?.(finished));
    this.hostAnswered.add(waiting.call_id);
    this.decisionResolvers.delete(waiting.call_id);
    this.waitingRecord = undefined;
    this.waitingSignal = deferred<Outcome>();
    resolver(renderDecision(record));
    return Promise.race([this.pendingTurn!, this.waitingSignal.promise]);
  }

  /** 主动压缩(用户关切:长编码阶段注意力漂移)。只许在回合间隙
   * 调用——pi 的 compact 会先中止进行中的 agent 运行,而"等待人工"
   * 的挂起 Promise 也算进行中,在那儿压会把人工节点打断。
   * 失败 fail-open:压不动就不压,流程照走(红线)。 */
  async compactAnchored(anchor: string): Promise<boolean> {
    try {
      await (this.session as any).compact(compactionInstructions(anchor));
      this.options.log?.(`任务 ${this.options.taskId} 会话主动压缩完成`);
      return true;
    } catch (error) {
      this.options.log?.(
        `任务 ${this.options.taskId} 主动压缩失败(不影响流程): ${String(error)}`);
      return false;
    }
  }

  /** 取消任务用的硬边界：中止当前 agent 回合并等它回到 idle。
   * 容器由 TaskService 同时停止，长 bash 不会遗留在隔离环境里。 */
  async abort(): Promise<void> {
    // Pi 的 abort 不会替宿主 resolve 自定义 AskUserQuestion 工具里的
    // Promise。若会话正停在人工卡，直接 await abort 会永久等待，导致
    // pause/cancel/SIGTERM 全部挂死。先只解开内存工具调用（不写人类决定
    // 事件；HumanGate 的 waiting 仍在盘上），再让 Pi 收束并中止回合。
    for (const [callId, resolver] of this.decisionResolvers) {
      this.hostAnswered.add(callId);
      resolver("[mae-flow-cloud] 会话已由宿主中止，人工待办仍保留");
    }
    this.decisionResolvers.clear();
    this.waitingRecord = undefined;
    await Promise.allSettled([
      (this.session as any).abort(),
      ...[...this.childSessions.values()].map((child) => child.abort()),
    ]);
    await this.flushKernel();
  }

  dispose(): void {
    for (const child of this.childSessions.values()) child.dispose();
    this.childSessions.clear();
    this.session.dispose();
  }

  // ---- pi 会话装配 ----

  private async openSession(config: {
    sessionId: string;
    customTools: unknown[];
  }) {
    const { workspace, agentDir, provider, model } = this.options;
    // Skill=写法指南(团队那两个 UT skill 只负责"单测怎么写"),云端照用:
    // Pi 只把 name/description/location 组成轻量可用 Skill 索引；模型判断
    // 相关后再用 Read 读取 SKILL.md 正文。它不承担 UT 运行，也不构成
    // 通过证据。正文里若含本地构建段落，以 Cloud 执行契约为准。
    //
    // 两个来源,宿主级在前(部署放一次、每个任务都带——团队的 skill 在
    // 内网出不来仓,老宿主靠"每次手动集成进 ut-generator 子 agent",
    // 云端给它一个固定的家)。仓内 Skill 只接受任务在首次 clone 后从
    // Git 已跟踪内容固定的精确 SKILL.md；平台不管理正文，也绝不能把
    // .pi/.claude 的 skills 目录整体交给 Pi，否则中心临时注入内容会
    // 静默进入模型上下文。
    // 宿主 Skill 会先按完整包投影进当前任务，所以正文引导的附件相对路径
    // 也在边界内；源目录绝对路径绝不进入 Pi。子 Agent 经同一 openSession
    // 装配,自动使用完全相同的 allowlist。
    // **必须显式喂路径**:pi 的 DefaultResourceLoader 是 includeDefaults
    // = false,不喂就一个 skill 都不装(读 SDK 才发现,不是放进去就生效)。
    const hostSkills = materializeHostSkills({
      sourceRoot: this.options.hostSkillsDir,
      workspaceRoot: workspace,
      snapshotRoot: join(workspace, ".mae-flow-work", "host-skills"),
      context: this.options.knowledgeContext,
      knowledgeScope: this.options.knowledgeScope,
    });
    for (const warning of hostSkills.warnings) {
      this.options.log?.(
        `[host-skill] 任务 ${this.options.taskId}: ${warning}`);
    }
    const repositorySkillPaths = (this.options.repositorySkillPaths ?? [])
      .filter((path) => {
        if (basename(path) !== "SKILL.md" || !existsSync(path)) return false;
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      });
    const skillPaths = [...new Set([
      ...hostSkills.paths,
      ...repositorySkillPaths,
      ...(this.options.businessModuleKnowledge?.skill_paths ?? []),
    ])];
    const engineeringKnowledgeEntries = (this.options.engineeringKnowledge?.entries ?? [])
      .filter((item) => existsSync(item.path) && statSync(item.path).isFile());
    const businessModuleKnowledge = this.options.businessModuleKnowledge;
    const moduleKnowledgeEntries = (businessModuleKnowledge?.entries ?? [])
      .filter((item) => {
        try {
          return existsSync(item.path) && statSync(item.path).isFile();
        } catch {
          return false;
        }
      });
    const knowledgeIndex = materializeTaskKnowledgeIndex({
      workspace,
      engineeringKnowledge: engineeringKnowledgeEntries,
      businessKnowledge: moduleKnowledgeEntries,
    });
    for (const warning of knowledgeIndex.warnings) {
      this.options.log?.(
        `[task-knowledge-index] 任务 ${this.options.taskId}: ${warning}`);
    }
    for (const item of engineeringKnowledgeEntries) {
      const resource: KnowledgeResourceRef = {
        id: item.id,
        kind: item.form === "rule" ? "rules" : "document",
        name: item.title,
        path: item.relative_path,
        description: item.summary,
        digest: item.digest,
        selected: true,
        scope: "team",
      };
      this.options.knowledgeTrace?.register(item.path, resource);
      this.options.knowledgeTrace?.record("available", config.sessionId, resource);
    }
    for (const item of moduleKnowledgeEntries) {
      const resource: KnowledgeResourceRef = {
        id: item.id,
        kind: item.form === "skill" ? "skill" : "document",
        name: item.title,
        path: item.relative_path,
        description: item.summary,
        digest: item.digest,
        selected: true,
        scope: "module",
        module_id: item.module_id,
        module_name: item.module_name,
        asset_version: item.version,
      };
      this.options.knowledgeTrace?.register(item.path, resource);
      this.options.knowledgeTrace?.record(
        "available", config.sessionId, resource);
    }
    for (const item of this.options.repositorySkillResources ?? []) {
      this.options.knowledgeTrace?.register(item.actual_path, {
        id: item.id,
        kind: item.kind,
        name: item.name,
        path: item.path,
        repository: item.repository,
        description: item.description,
        digest: item.digest,
        selected: item.selected,
        scope: "repository",
      }, true);
    }
    if (skillPaths.length) {
      const safeRepositoryNames = repositorySkillPaths.map((path) => {
        const fromWorkspace = relative(workspace, path);
        if (fromWorkspace && fromWorkspace !== ".."
            && !fromWorkspace.startsWith(`..${sep}`)
            && !isAbsolute(fromWorkspace)) {
          return fromWorkspace;
        }
        return join(basename(dirname(path)), "SKILL.md");
      });
      const labels = [
        ...hostSkills.names.map((name) => `宿主技能/${name}`),
        ...safeRepositoryNames,
      ];
      this.options.log?.(
        `任务 ${this.options.taskId} 装载 skill: ${labels.join(", ")}`);
    }
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir,
      // Pi 默认会经 package/settings 解析项目 .pi/skills；allowlist 模式
      // 必须关掉这条隐式来源。noSkills 仍会保留 additionalSkillPaths，
      // SDK 在该模式下的语义正是“只装显式路径”。
      noSkills: true,
      additionalSkillPaths: skillPaths,
      // 平台管理的非 Skill 知识统一走轻量目录：默认勾选只表示“本任务
      // 可用”，正文按需 Read。仓库自身资料不进入平台知识通路。
      agentsFilesOverride: (current) => ({
        agentsFiles: [
          ...current.agentsFiles,
          ...(knowledgeIndex.path && knowledgeIndex.content
            ? [{ path: knowledgeIndex.path, content: knowledgeIndex.content }]
            : []),
        ],
      }),
      extensionFactories: [
        {
          name: "mae-flow-gate",
          factory: (pi: any) => {
            pi.on("tool_call", async (event: any) =>
              this.onToolCall(config.sessionId, event));
          },
        } as any,
      ],
    });
    await loader.reload();
    const repositorySkillByPath = new Map(
      (this.options.repositorySkillResources ?? [])
        .map((item) => [resolve(item.actual_path), item] as const));
    const moduleSkillByPath = new Map(moduleKnowledgeEntries
      .filter((item) => item.form === "skill")
      .map((item) => [resolve(item.path), item] as const));
    for (const skill of loader.getSkills().skills) {
      const known = repositorySkillByPath.get(resolve(skill.filePath));
      const moduleKnown = moduleSkillByPath.get(resolve(skill.filePath));
      const displayPath = skill.filePath.includes(workspace)
        ? relative(workspace, skill.filePath).split(sep).join("/")
        : `宿主技能/${skill.name}/SKILL.md`;
      // actual_path 只用于宿主侧匹配，不能跟着知识事件/API 泄露快照
      // 的绝对宿主路径。
      const resource: KnowledgeResourceRef = known ? {
        id: known.id,
        kind: known.kind,
        name: known.name,
        path: known.path,
        repository: known.repository,
        description: known.description,
        digest: known.digest,
        selected: known.selected,
        scope: "repository",
      } : moduleKnown ? {
        id: moduleKnown.id,
        kind: "skill",
        name: moduleKnown.title,
        path: moduleKnown.relative_path,
        description: moduleKnown.summary,
        digest: moduleKnown.digest,
        selected: true,
        scope: "module",
        module_id: moduleKnown.module_id,
        module_name: moduleKnown.module_name,
        asset_version: moduleKnown.version,
      } : {
        id: `skill:${skill.name}:${displayPath}`,
        kind: "skill",
        name: skill.name,
        path: displayPath,
        description: skill.description,
        scope: "team",
      };
      this.options.knowledgeTrace?.register(skill.filePath, resource, true);
      this.options.knowledgeTrace?.record(
        "available", config.sessionId, resource);
    }
    for (const file of loader.getAgentsFiles().agentsFiles) {
      if (knowledgeIndex.path
          && resolve(file.path) === resolve(knowledgeIndex.path)) {
        continue;
      }
      const withinWorkspace = resolve(file.path).startsWith(`${resolve(workspace)}${sep}`)
        || resolve(file.path) === resolve(workspace);
      const display = withinWorkspace
        ? relative(workspace, file.path).split(sep).join("/")
        : file.path.split(sep).slice(-2).join("/");
      const resource: KnowledgeResourceRef = {
        id: `rules:${display}`,
        kind: "rules",
        name: display.split("/").at(-1) || "项目规则",
        path: display,
      };
      this.options.knowledgeTrace?.register(file.path, resource);
      this.options.knowledgeTrace?.record("loaded", config.sessionId, resource);
    }
    const resolved = this.modelRuntime.getModel(provider, model);
    if (!resolved) {
      throw new Error(`models.json 里找不到模型 ${provider}/${model}`);
    }
    // 容器隔离:注册执行后端进容器的同名 bash——SDK 的工具注册表
    // 同名 customTool 后写覆盖内建(agent-session._refreshToolRegistry),
    // 不能用 excludeTools(denylist 按名字生效,会连替换品一起杀,实测)。
    const isolatedTools = this.options.bashOperations
      ? [createWorkspaceBashToolDefinition(
          workspace,
          this.options.bashOperations,
          {
            // 每个主/子/prepush 会话各有自己的受控日志目录。所有命令仍由
            // 原容器 backend 执行；这层只镜像输出并把可达相对路径交给 Pi。
            workspace,
            taskId: this.options.taskId,
            sessionId: config.sessionId,
            log: this.options.log,
            onOutput: this.options.streamBashOutput
              ? ({ text, relativePath }) => {
                  this.emit("tool_output", config.sessionId, {
                    name: "Bash",
                    text,
                    log_path: relativePath,
                  });
                }
              : undefined,
          },
        )]
      : [];
    const ownedFileTools = this.options.afterFileMutation
      ? this.ownedFileTools(workspace, this.options.afterFileMutation)
      : [];
    const visionTools = this.options.vision
      ? [createInspectImageTool({
          runtime: this.modelRuntime,
          workspace,
          config: this.options.vision,
          state: this.visionState,
          sessionId: config.sessionId,
          onTokenUsage: this.options.onTokenUsage,
        })]
      : [];
    const { session } = await createAgentSession({
      cwd: workspace,
      agentDir,
      model: resolved,
      modelRuntime: this.modelRuntime,
      resourceLoader: loader,
      customTools: [
        ...(config.customTools as any[]),
        ...((this.options.extraTools ?? []) as any[]),
        ...visionTools,
        ...ownedFileTools,
        ...isolatedTools,
      ] as any,
      sessionManager: SessionManager.inMemory(),
    });
    // 被动保底:接近上下文上限时 pi 自动压缩(主动压缩另有节奏,
    // 见 compactAnchored/TaskService.maybeCompact)。
    (session as any).setAutoCompactionEnabled?.(true);
    session.subscribe((event: any) => this.onSessionEvent(config.sessionId, event));
    return session;
  }

  private ownedFileTools(
    workspace: string,
    afterMutation: (absolutePath: string) => void | Promise<void>,
  ): unknown[] {
    const finish = async (path: string, content: string): Promise<void> => {
      await fsWriteFile(path, content, "utf-8");
      await afterMutation(path);
    };
    const writeOperations: WriteOperations = {
      mkdir: (path) => fsMkdir(path, { recursive: true }).then(() => undefined),
      writeFile: finish,
    };
    const editOperations: EditOperations = {
      access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
      readFile: fsReadFile,
      writeFile: finish,
    };
    return [
      createWriteToolDefinition(workspace, { operations: writeOperations }),
      createEditToolDefinition(workspace, { operations: editOperations }),
    ];
  }

  // ---- 同步拦截(tool_call 钩子) ----

  private async onToolCall(sessionId: string, event: any) {
    const rawName = String(event.toolName ?? "");
    if (HOST_TOOLS.has(rawName)) return undefined; // 宿主工具在执行体内代演
    const name = TOOL_NAME_MAP[rawName] ?? rawName;
    const callId = String(event.toolCallId ?? "");
    const semantic: SemanticEvent = {
      eventId: this.options.eventLog.lastEventId() + 1,
      taskId: this.options.taskId,
      sessionId,
      ts: new Date().toISOString(),
      kind: "tool_requested",
      payload: { call_id: callId, name, input: event.input ?? {} },
    };
    this.options.eventLog.append(semantic);
    this.options.transcript.record(semantic);
    // 深层契约(内核 dispatch)先裁——它拦的是谎言与授权;
    // GateService 的注入契约(演练/附加规则)随后。任一 deny 即打回。
    const host = await this.options.hostHooks?.preTool?.(semantic);
    if (host?.action === "deny") {
      return { block: true, reason: host.reason ?? "被 mae-flow 门禁打回" };
    }
    const decision = this.options.gate.decide(semantic);
    if (decision.action === "deny") {
      return { block: true, reason: decision.reason ?? "被 mae-flow 门禁打回" };
    }
    return undefined;
  }

  // ---- 事实流(pi 会话事件 → 语义事件) ----

  private onSessionEvent(sessionId: string, event: any): void {
    const kind = String(event.type ?? "");
    if (kind === "message_end") {
      const message = event.message ?? {};
      if (message.role !== "assistant") return;
      const usage = modelTokenUsageSample(message, sessionId);
      if (usage) {
        try {
          this.options.onTokenUsage?.(usage);
        } catch (error) {
          this.options.log?.(
            `任务 ${this.options.taskId} Token 统计失败(不影响会话): ${String(error)}`);
        }
      }
      // 模型层错误藏在 stopReason 里(消息往往无文本,不能只看 text)。
      if (sessionId === this.sessionId
          && String(message.stopReason ?? "") === "error") {
        this.turnError = String(message.errorMessage ?? "未知模型错误");
      }
      const text = (Array.isArray(message.content) ? message.content : [])
        .filter((block: any) => block?.type === "text")
        .map((block: any) => String(block.text ?? ""))
        .join("");
      if (!text) return;
      if (sessionId === this.sessionId) this.turnActivity += 1;
      this.lastAssistantText.set(sessionId, text);
      this.emit("assistant_message", sessionId, { text });
      return;
    }
    if (kind === "tool_execution_start") {
      if (sessionId === this.sessionId) this.turnActivity += 1;
      this.toolArgs.set(String(event.toolCallId ?? ""), event.args ?? {});
      return;
    }
    if (kind === "tool_execution_end") {
      const callId = String(event.toolCallId ?? "");
      if (this.hostAnswered.delete(callId)) return; // 宿主已登记,回声丢弃
      const rawName = String(event.toolName ?? "");
      const input = this.toolArgs.get(callId) ?? {};
      this.toolArgs.delete(callId);
      const content = event.result?.content;
      const result = (Array.isArray(content) ? content : [])
        .filter((block: any) => block?.type === "text")
        .map((block: any) => String(block.text ?? ""))
        .join("\n");
      if (sessionId === this.sessionId) {
        this.turnTerminalError = fatalToolExecutionError(
          TOOL_NAME_MAP[rawName] ?? rawName,
          result,
          Boolean(event.isError),
        ) ?? this.turnTerminalError;
      }
      const semantic: SemanticEvent = {
        eventId: this.options.eventLog.lastEventId() + 1,
        taskId: this.options.taskId,
        sessionId,
        ts: new Date().toISOString(),
        kind: "tool_finished",
        payload: {
          call_id: callId,
          name: TOOL_NAME_MAP[rawName] ?? rawName,
          input,
          is_error: Boolean(event.isError),
          result,
        },
      };
      this.options.eventLog.append(semantic);
      this.options.transcript.record(semantic);
      this.options.knowledgeTrace?.observeTool(
        sessionId,
        String(semantic.payload.name ?? ""),
        input,
        Boolean(event.isError),
      );
      // 证据登记交内核(fire 进 KernelHost 的串行链,顺序由它保证)。
      this.kernelBypass(this.options.hostHooks?.postTool?.(semantic));
    }
  }

  // ---- 人工节点(§5 挂起路线) ----

  private askTool() {
    const driver = this;
    return defineTool({
      name: "AskUserQuestion",
      label: "Ask User Question",
      description:
        "向用户提出结构化问题并等待决定。需要用户确认或选择时必须调用本工具," +
        "不要在正文里描述问题然后自行假设答案。一张卡可含多个问题" +
        "(如配置确认 + 交付方式合并成一次提问)。" +
        "context 会原样显示为网页和小鲁班的‘决策背景’，请填写用户看得懂的" +
        "事实、证据或影响摘要；禁止填写 apply/git/Bash 等内部操作过程。" +
        // 实战实测:正文预告"两个衍生题一次问完",工具调用只带了一题,
        // 另一题要么多花一轮补问,要么被自行拍板。预告即契约。
        "正文预告了几个问题,questions 就必须带几个——预告了却不发,"  +
        "等于把没问过的事当已确认。",
      // 形状对齐旧宿主(步骤文档假设的就是它):questions 数组,每项
      // question + options。回答按问题分开记录——内核"整份背书"判定
      // 依赖这个结构。
      parameters: Type.Object({
        context: Type.Optional(Type.String({
          description: "用户可见的决策背景；只写事实、证据与影响，不写内部操作过程",
          minLength: 1,
          maxLength: 2000,
        })),
        questions: Type.Array(Type.Object({
          question: Type.String({ description: "问题正文" }),
          options: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
            description: "可选决定；选择题至少两项，开放题省略本字段",
            minItems: 2,
            maxItems: 6,
          })),
          recommended: Type.Optional(Type.String({
            description:
              "所推荐选项的原文(与 options 之一逐字一致)。选项题必填:"
              + "推荐要有依据(写进问题正文或 context),拿不准先补研究,"
              + "不要空着;开放题不得携带本字段",
          })),
        }, { additionalProperties: false }), {
          description: "一张卡里的问题；彼此独立的问题可合并，最多四个",
          minItems: 1,
          maxItems: 4,
        }),
      }, { additionalProperties: false }),
      async execute(toolCallId: string, params: any) {
        const callId = String(toolCallId);
        driver.emit("tool_requested", driver.sessionId, {
          call_id: callId, name: "AskUserQuestion", input: params ?? {},
        });
        const invalid = validateAskUserQuestionInput(params);
        if (invalid) {
          const text = "问题卡结构不完整，未向用户发送：" + invalid
            + "。选择题必须提供至少两个非空、互不重复的选项；"
            + "选项题必须带 recommended(所推荐选项的原文，须与选项逐字一致)；"
            + "若确实要自由回答，请省略 options，页面会显示答复输入框。"
            + "请修正后重试一次 AskUserQuestion，不要替用户猜答案。";
          const finished = driver.emit("tool_finished", driver.sessionId, {
            call_id: callId,
            name: "AskUserQuestion",
            input: params ?? {},
            is_error: true,
            result: text,
          });
          driver.kernelBypass(driver.options.hostHooks?.postTool?.(finished));
          driver.hostAnswered.add(callId);
          return {
            content: [{ type: "text", text }],
            details: {},
            isError: true,
          };
        }
        const explicitContext =
          typeof params.context === "string" && params.context.trim()
            ? params.context.trim() : undefined;
        const lastSaid = driver.lastAssistantText.get(driver.sessionId);
        const record = driver.options.humanGate.createWaiting({
          taskId: driver.options.taskId,
          step: driver.options.currentStep?.() ?? "",
          callId,
          questionInput: { questions: params.questions },
          context: explicitContext ?? lastSaid,
          // Agent 常在举卡前把完整清单说在正文里,卡的 context 只写
          // "以上/上述…"——卡上必须带得到那个"上述",不能让人回翻
          // 现场流水(MFC-028 盲签)。context 缺席时 lastSaid 已经当
          // context 用了,不重复。
          preface: explicitContext && lastSaid
            && lastSaid !== explicitContext ? lastSaid : undefined,
        });
        // 重建会话可能把同一个工具调用重放出来。waiting_id 以
        // task+call_id 幂等；若盘上的决定已经 resolved，就把原答案
        // 直接作为本次工具结果回放，绝不能再把它包装成一张新待办。
        // 用户实测的症状正是:子任务已生成，父分析单却又出现同一张卡。
        if (record.status === "resolved") {
          const finished = driver.emit("tool_finished", driver.sessionId, {
            call_id: callId,
            name: "AskUserQuestion",
            input: params ?? {},
            is_error: false,
            result: renderDecision(record),
            answers: answersOf(record, record),
          });
          driver.kernelBypass(driver.options.hostHooks?.postTool?.(finished));
          driver.hostAnswered.add(callId);
          driver.options.log?.(
            `任务 ${driver.options.taskId} 重放已完成待办 ${record.waiting_id},不重复举卡`);
          return {
            content: [{ type: "text", text: renderDecision(record) }],
            details: {},
          };
        }
        if (record.status === "superseded") {
          const text = "这张旧问题已因用户接管代码现场而失效。请重新读取 mae-flow current；"
            + "如果当前步骤仍需要确认，请基于最新现场重新提问。";
          const finished = driver.emit("tool_finished", driver.sessionId, {
            call_id: callId,
            name: "AskUserQuestion",
            input: params ?? {},
            is_error: true,
            result: text,
          });
          driver.kernelBypass(driver.options.hostHooks?.postTool?.(finished));
          driver.hostAnswered.add(callId);
          driver.options.log?.(
            `任务 ${driver.options.taskId} 拒绝重放已失效待办 ${record.waiting_id}`);
          return {
            content: [{ type: "text", text }],
            details: {},
            isError: true,
          };
        }
        driver.waitingRecord = record;
        const decision = new Promise<string>((resolve) =>
          driver.decisionResolvers.set(callId, resolve));
        driver.waitingSignal.resolve({
          status: "waiting_for_human", waiting: { ...record },
        });
        const text = await decision; // 会话挂起点:决定到达前 pi 停在这里
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  }

  // ---- 子 Agent(§6 平行会话;同进程) ----

  private dispatchTool() {
    const driver = this;
    return defineTool({
      name: "Task",
      label: "Dispatch Agent",
      description:
        "派发一个子 Agent 完成任务卡并返回其最终报告(等价旧插件的 Task 工具)。" +
        "子 Agent 不能提问、不能再派子 Agent。",
      parameters: Type.Object({
        subagent_type: Type.String({
          description: "子 Agent 类型,如 ut-generator-agent 或 reviewer-agent",
        }),
        description: Type.String({ description: "一句话任务描述" }),
        prompt: Type.String({ description: "完整任务卡内容" }),
      }),
      async execute(toolCallId: string, params: any) {
        const text = await driver.runSubagent(String(toolCallId), params ?? {});
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  }

  private refusalTool(
    sessionId: string,
    name: string,
    kernelName: string,
    label: string,
    reason: string,
  ) {
    const driver = this;
    return defineTool({
      name,
      label,
      description: `${label}(子 Agent 内不可用)`,
      parameters: Type.Object({}, { additionalProperties: true }),
      async execute(toolCallId: string, params: any) {
        // 打回也要先登记调用:tool_result 没有配对的 tool_use 行,
        // parse_transcript 按 id join 不上就整条蒸发——"被打回"这个
        // 事实必须留在证据里,不然嵌套封顶在审计中不可见。
        driver.emit("tool_requested", sessionId, {
          call_id: String(toolCallId), name: kernelName, input: params ?? {},
        });
        throw new Error(reason); // pi 只认 throw 作为工具失败信号
      },
    });
  }

  private async runSubagent(
    callId: string,
    params: Record<string, any>,
  ): Promise<string> {
    this.childCount += 1;
    const childId = `child-${this.childCount}`;
    // 派发意图先过内核 pretooluse:记 started 观察、验任务卡契约;
    // 内核打回即不派(打回文案原样返回给主 Agent)。
    const hostVerdict = await this.options.hostHooks?.preTool?.({
      eventId: this.options.eventLog.lastEventId(),
      taskId: this.options.taskId,
      sessionId: this.sessionId,
      ts: "",
      kind: "tool_requested",
      payload: { call_id: callId, name: "Task", input: params },
    });
    if (hostVerdict?.action === "deny") {
      throw new Error(hostVerdict.reason ?? "派发被 mae-flow 门禁打回");
    }
    this.emit("agent_spawned", this.sessionId, {
      call_id: callId,
      agent_type: String(params.subagent_type ?? ""),
      description: String(params.description ?? ""),
      prompt: String(params.prompt ?? ""),
      child_session_id: childId,
    });
    const refusal =
      "子 Agent 不设人工节点、不得再派子 Agent;" +
      "按任务卡既有信息完成或如实报告失败。";
    const child = await this.openSession({
      sessionId: childId,
      customTools: [
        this.refusalTool(childId, "AskUserQuestion",
          "AskUserQuestion", "Ask User Question", refusal),
        this.refusalTool(childId, "Task",
          "Task", "Dispatch Agent", refusal),
      ],
    });
    this.childSessions.set(childId, child);
    let lifecycle: "returned" | "interrupted" = "returned";
    try {
      await child.prompt(String(params.prompt ?? ""));
    } catch (error) {
      lifecycle = "interrupted";
      this.options.log?.(`子 Agent ${childId} 中断: ${String(error)}`);
    } finally {
      this.childSessions.delete(childId);
      child.dispose();
    }
    const finalText = this.lastAssistantText.get(childId) ?? "";
    this.emit("agent_finished", this.sessionId, {
      call_id: callId,
      child_session_id: childId,
      lifecycle,
      final_text: finalText,
    });
    this.hostAnswered.add(callId); // pi 对 dispatch_agent 的回声丢弃
    // 完成对账进内核:posttooluse(Task) 走 hook_agent_lifecycle 的
    // tool_use_id 绑定,子 transcript 布局与旧确定性解析一致。
    this.kernelBypass(this.options.hostHooks?.postTool?.({
      eventId: this.options.eventLog.lastEventId(),
      taskId: this.options.taskId,
      sessionId: this.sessionId,
      ts: "",
      kind: "tool_finished",
      payload: {
        call_id: callId, name: "Task", input: params,
        is_error: lifecycle !== "returned", result: finalText,
      },
    }));
    if (lifecycle !== "returned") {
      throw new Error(finalText || "子 Agent 中断,无最终报告");
    }
    return finalText;
  }
}
