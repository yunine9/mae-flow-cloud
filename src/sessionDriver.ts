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
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
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
  private toolArgs = new Map<string, Record<string, unknown>>();
  private lastAssistantText = new Map<string, string>();
  private childCount = 0;
  readonly sessionId = "main";

  private constructor(private readonly options: CloudSessionOptions) {}

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
      ts: new Date().toISOString().replace("T", " ").slice(0, 19),
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
    this.emit("user_message", this.sessionId, { text: userMessage });
    this.waitingSignal = deferred<Outcome>();
    this.pendingTurn = this.session
      .prompt(userMessage)
      .then((): Outcome => {
        this.emit("turn_finished", this.sessionId, { reason: "end_turn" });
        return { status: "turn_finished", reason: "end_turn" };
      })
      .catch((error): Outcome => {
        this.emit("session_ended", this.sessionId, {
          reason: "failed", detail: String(error),
        });
        return { status: "session_ended", reason: "failed", detail: String(error) };
      });
    return Promise.race([this.pendingTurn, this.waitingSignal.promise]);
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
    void this.options.hostHooks?.postTool?.(finished);
    this.hostAnswered.add(waiting.call_id);
    this.decisionResolvers.delete(waiting.call_id);
    this.waitingRecord = undefined;
    this.waitingSignal = deferred<Outcome>();
    resolver(renderDecision(record));
    return Promise.race([this.pendingTurn!, this.waitingSignal.promise]);
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
    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir,
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
    const { session } = await createAgentSession({
      cwd: workspace,
      agentDir,
      model: resolved,
      modelRuntime: this.modelRuntime,
      resourceLoader: loader,
      customTools: config.customTools as any,
      sessionManager: SessionManager.inMemory(),
    });
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
      ts: new Date().toISOString().replace("T", " ").slice(0, 19),
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
      const text = (Array.isArray(message.content) ? message.content : [])
        .filter((block: any) => block?.type === "text")
        .map((block: any) => String(block.text ?? ""))
        .join("");
      if (!text) return;
      this.lastAssistantText.set(sessionId, text);
      this.emit("assistant_message", sessionId, { text });
      return;
    }
    if (kind === "tool_execution_start") {
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
        ts: new Date().toISOString().replace("T", " ").slice(0, 19),
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
      void this.options.hostHooks?.postTool?.(semantic);
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
        "(如配置确认 + 交付方式合并成一次提问)。",
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
        });
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
    void this.options.hostHooks?.postTool?.({
      eventId: this.options.eventLog.lastEventId(),
      taskId: this.options.taskId,
      sessionId: this.sessionId,
      ts: "",
      kind: "tool_finished",
      payload: {
        call_id: callId, name: "Task", input: params,
        is_error: lifecycle !== "returned", result: finalText,
      },
    });
    if (lifecycle !== "returned") {
      throw new Error(finalText || "子 Agent 中断,无最终报告");
    }
    return finalText;
  }
}
