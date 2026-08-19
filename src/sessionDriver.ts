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
  createBashToolDefinition,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { EventLog, type SemanticEvent, type SemanticEventKind, validateEvent } from "./semanticEvents.ts";
import { TranscriptStore } from "./transcriptStore.ts";
import { GateService } from "./gateService.ts";
import { HumanGate, renderDecision, type WaitingRecord } from "./humanGate.ts";

/** pi 工具名 → 内核工具词汇表。不认识的原样透传(错认比不认更危险)。 */
const TOOL_NAME_MAP: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
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
  postTool?(event: SemanticEvent): Promise<void>;
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
  currentStep?: () => string;
  /** 容器隔离(设计文档):换掉内建 bash 的执行后端,命令进任务
   * 容器跑;工具仍叫 bash,门禁与 transcript 看到的世界不变。
   * 子会话经同一 openSession 装配,天然同套隔离。 */
  bashOperations?: BashOperations;
  /** 宿主级 skill 目录(部署时放一次,每个任务自动带)。团队的两个
   * UT skill 在内网、出不来仓,老宿主是"每次手动集成进 ut-generator
   * 子 agent";云端子 Agent 照样有(Task 工具),缺的是自动装载——
   * pi 的 includeDefaults=false,不喂路径就一个 skill 都不装。 */
  hostSkillsDir?: string;
  /** 上下文超限自愈用的锚点提供者(通常是内核现场 current/config)。
   * 不给就用需求原话兜底——锚永远来自权威,不由云端编造。 */
  compactAnchor?: () => string;
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
  /** 上下文超限只自愈一次(整条会话计):压完还爆是单轮输入本身过大,
   * 再压是空转——按预算纪律,补救必须有次数上限。 */
  private overflowRepaired = false;
  private toolArgs = new Map<string, Record<string, unknown>>();
  private lastAssistantText = new Map<string, string>();
  private childCount = 0;
  readonly sessionId = "main";

  private constructor(private readonly options: CloudSessionOptions) {}

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
      customTools: [driver.askTool(), driver.dispatchTool()],
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
    this.emit("session_started", this.sessionId, { resume: true });
    return this.turnWithOverflowRepair(userMessage);
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

  /** 进内核的登记是旁路:抛了记一笔,**绝不带走进程**。
   *
   * postTool 是即发即忘(证据登记不该拖慢模型这一轮),而 Node 里没人
   * 接的 rejection 默认终止进程——python 起不来、管道半路断掉,后果就
   * 是整台服务连着所有在跑的任务一起没。红线:旁路一律 fail-open。 */
  private kernelBypass(work: Promise<unknown> | undefined): void {
    if (!work) return;
    void work.catch((error) => {
      this.options.log?.(
        `任务 ${this.options.taskId} 内核登记失败(fail-open,流程照走): `
        + String(error));
    });
  }

  /** 发一条用户消息并跑完本轮,统一收口判定。 */
  private promptTurn(userMessage: string): Promise<Outcome> {
    this.emit("user_message", this.sessionId, { text: userMessage });
    this.turnActivity = 0;
    this.turnError = "";
    this.waitingSignal = deferred<Outcome>();
    this.pendingTurn = this.session
      .prompt(userMessage)
      .then((): Outcome => this.turnOutcome())
      .catch((error): Outcome => {
        this.emit("session_ended", this.sessionId, {
          reason: "failed", detail: String(error),
        });
        return { status: "session_ended", reason: "failed", detail: String(error) };
      });
    return Promise.race([this.pendingTurn, this.waitingSignal.promise]);
  }

  /** 回合收口:零活动+模型层错误 = 会话失败(把 pi 吞掉的 API 错误
   * 亮出来);零活动无错误 = 空转回合(交上层催办);否则正常收轮。 */
  private turnOutcome(): Outcome {
    if (!this.turnActivity && this.turnError) {
      const detail = `模型回合失败: ${this.turnError}`;
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
    await (this.session as any).abort();
  }

  dispose(): void {
    this.session.dispose();
  }

  // ---- pi 会话装配 ----

  private async openSession(config: {
    sessionId: string;
    customTools: unknown[];
  }) {
    const { workspace, agentDir, provider, model } = this.options;
    // Skill=写法指南(团队那两个 UT skill 讲"单测怎么写"),云端照用:
    // pi 把 SKILL.md 直接注进系统提示让模型读。云端对不上的只是"调用
    // Skill 工具"这个通道(pi 没有 skill 工具)和指南里"本地编译"那类段落。
    //
    // 两个来源,宿主级在前(部署放一次、每个任务都带——团队的 skill 在
    // 内网出不来仓,老宿主靠"每次手动集成进 ut-generator 子 agent",
    // 云端给它一个固定的家),仓内的次之(愿意随仓走的)。
    // 子 Agent 经同一 openSession 装配,自动同样带上这些 skill。
    // **必须显式喂路径**:pi 的 DefaultResourceLoader 是 includeDefaults
    // = false,不喂就一个 skill 都不装(读 SDK 才发现,不是放进去就生效)。
    const skillPaths = [
      this.options.hostSkillsDir,
      join(workspace, ".pi", "skills"),
      join(workspace, ".claude", "skills"), // 团队已有的 Claude 版同格式
    ].filter((path): path is string => !!path && existsSync(path));
    if (skillPaths.length) {
      this.options.log?.(
        `任务 ${this.options.taskId} 装载 skill 目录: ${skillPaths.join(", ")}`);
    }
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir,
      additionalSkillPaths: skillPaths,
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
    const resolved = this.modelRuntime.getModel(provider, model);
    if (!resolved) {
      throw new Error(`models.json 里找不到模型 ${provider}/${model}`);
    }
    // 容器隔离:注册执行后端进容器的同名 bash——SDK 的工具注册表
    // 同名 customTool 后写覆盖内建(agent-session._refreshToolRegistry),
    // 不能用 excludeTools(denylist 按名字生效,会连替换品一起杀,实测)。
    const isolatedTools = this.options.bashOperations
      ? [createBashToolDefinition(workspace, {
          operations: this.options.bashOperations,
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
        // 实战实测:正文预告"两个衍生题一次问完",工具调用只带了一题,
        // 另一题要么多花一轮补问,要么被自行拍板。预告即契约。
        "正文预告了几个问题,questions 就必须带几个——预告了却不发,"  +
        "等于把没问过的事当已确认。",
      // 形状对齐旧宿主(步骤文档假设的就是它):questions 数组,每项
      // question + options。回答按问题分开记录——内核"整份背书"判定
      // 依赖这个结构。
      parameters: Type.Object({
        questions: Type.Array(Type.Object({
          question: Type.String({ description: "问题正文" }),
          options: Type.Array(Type.String(),
            { description: "可选决定,至少一项" }),
        }), { description: "一张卡里的问题,通常 1-2 个" }),
      }),
      async execute(toolCallId: string, params: any) {
        const callId = String(toolCallId);
        driver.emit("tool_requested", driver.sessionId, {
          call_id: callId, name: "AskUserQuestion", input: params ?? {},
        });
        const record = driver.options.humanGate.createWaiting({
          taskId: driver.options.taskId,
          step: driver.options.currentStep?.() ?? "",
          callId,
          questionInput: params ?? {},
          context: driver.lastAssistantText.get(driver.sessionId),
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
        subagent_type: Type.String({ description: "子 Agent 类型,如 compile-agent" }),
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
    let lifecycle: "returned" | "interrupted" = "returned";
    try {
      await child.prompt(String(params.prompt ?? ""));
    } catch (error) {
      lifecycle = "interrupted";
      this.options.log?.(`子 Agent ${childId} 中断: ${String(error)}`);
    } finally {
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
