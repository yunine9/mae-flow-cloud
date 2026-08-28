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
 * transcript.jsonl + waiting.json),API 是投影;服务重启后 running →
 * interrupted,用户发一句消息即从现场续聊。
 */

import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { CloudSession, type Outcome } from "../sessionDriver.ts";
import { EventLog, type SemanticEvent } from "../semanticEvents.ts";
import { TranscriptStore } from "../transcriptStore.ts";
import { GateService } from "../gateService.ts";
import { HumanGate, renderDecision, type WaitingRecord } from "../humanGate.ts";
import { IssueEnvironmentVault } from "../issueEnvironment.ts";
import { TaskContainer, taskContainerInstance } from "../containerRuntime.ts";
import { repairContainerMutationOwnership } from "../containerOwnership.ts";
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
  IssueControlError,
  type FixedStage,
  type IssueConclusionKind,
  type IssueEnvironmentConfig,
  type IssueFlowMode,
  type IssueScenario,
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
  ensureBranch,
  validateRepoUrl,
  type GitCredential,
} from "./issueGit.ts";
import { readBusinessModule } from "../businessModuleLibrary.ts";
import type { IssueOpsTools } from "./opsTools.ts";
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
} from "./prompt.ts";
import {
  GATE_OPTIONS,
  fixedStageLabel,
  gateOptionLabel,
  gateVerdict,
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
}> {
  return (record.question as { questions?: Array<{
    question?: string;
    options?: string[];
  }> })?.questions ?? [];
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
      questions: questions.map((item, questionIndex) => ({
        ...item,
        options: (item.options ?? []).map((option, optionIndex) => ({
          code: agentOptionCode(questionIndex, optionIndex),
          label: option,
        })),
      })),
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

export class IssueNotFoundError extends Error {
  constructor(id: string) {
    super(`问题会话 ${id} 不存在`);
  }
}

/** 控制类错误在校验发生地(state.ts)定义;这里转出,路由层的既有
 * import 面不变。 */
export { IssueControlError };

export interface IssueEnvironmentInput {
  name?: string;
  hosts: string[];
  port?: number;
  /** 单一共用密码(playbook 契约:sopuser/ossuser/ossadm 同密码)。 */
  password: string;
}

export interface IssueCreateInput {
  account: string;
  title: string;
  description?: string;
  source?: IssueSource;
  ticket?: string;
  repoUrl?: string;
  /** 多仓登记(模块带仓是常态):与 repoUrl 合并去重,首个=主仓。 */
  repoUrls?: string[];
  baseline?: string;
  /** 业务模块自由文本标签(仅展示/报告引用,不承载判定)。 */
  module?: string;
  /** 登记选定的业务模块 ID:校验存在且 active,名称派生 module 标签。 */
  moduleId?: string;
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
  gitCredential?: (account: string) =>
    (GitCredential & { email?: string }) | undefined;
  opsTools?: IssueOpsTools;
  dts?: DtsGateway;
  /** 交付平台适配层(--platform):MR 创建与需求交付共用同一端点。 */
  platformUrl?: string;
  vault?: IssueEnvironmentVault;
  maxConcurrentTurns?: number;
  isolation?: IssueIsolation;
  log?: (message: string) => void;
}

interface LiveIssue {
  id: string;
  root: string;
  state: IssueSessionState;
  humanGate: HumanGate;
  driver?: CloudSession;
  container?: TaskContainer;
  toolContext?: IssueToolContext;
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

/** 结论文档回传上限:一个巨型文档不能把页面拖死。 */
const ANALYSIS_MAX_BYTES = 512 * 1024;
const ANALYSIS_TRUNCATED_NOTE =
  "\n\n…(内容超过 512 KB,只回传前 512 KB;完整内容见会话工作区文件)";

/** 结论文档按字节帽读取。这是 artifacts.ts 里 cap/readCapped 的十行
 * 本地副本——问题流与需求流互不 import,不为一顶帽子引入跨域耦合。
 * 按字节切会把 UTF-8 多字节字符切一半,末尾的替换符直接抹掉——宁可
 * 少一个字,不给用户看乱码。 */
function capAnalysisText(text: string): {
  content: string;
  truncated: boolean;
} {
  if (Buffer.byteLength(text, "utf-8") <= ANALYSIS_MAX_BYTES) {
    return { content: text, truncated: false };
  }
  const clipped = Buffer.from(text, "utf-8")
    .subarray(0, ANALYSIS_MAX_BYTES)
    .toString("utf-8")
    .replace(/\uFFFD+$/, "");
  return { content: clipped + ANALYSIS_TRUNCATED_NOTE, truncated: true };
}

/** 读会话根目录的 issue-analysis.md。白名单即边界:文件名是服务自己
 * 的固定常量,不掺任何输入;读之前再核对解析后的路径仍在会话现场之
 * 下(双保险,与需求侧 artifacts.ts 同款纪律),越界一律 undefined。 */
function readAnalysisFile(
  root: string,
): { content: string; truncated: boolean } | undefined {
  const path = join(root, "issue-analysis.md");
  if (!existsSync(path)) return undefined;
  const boundary = resolve(root);
  if (!resolve(path).startsWith(boundary + sep)) return undefined;
  try {
    const info = statSync(path);
    if (info.size <= ANALYSIS_MAX_BYTES) {
      return capAnalysisText(readFileSync(path, "utf-8"));
    }
    const handle = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(ANALYSIS_MAX_BYTES);
      const read = readSync(handle, buffer, 0, ANALYSIS_MAX_BYTES, 0);
      const content = buffer.subarray(0, read).toString("utf-8")
        .replace(/\uFFFD+$/, "");
      return { content: content + ANALYSIS_TRUNCATED_NOTE, truncated: true };
    } finally {
      closeSync(handle);
    }
  } catch {
    // 文件在读取途中消失或不可读:当"还没生成",别让页面报错。
    return undefined;
  }
}

export class IssueFlowService {
  private readonly options: IssueFlowOptions;
  private readonly vault: IssueEnvironmentVault;
  private readonly issuesRoot: string;
  private readonly live = new Map<string, LiveIssue>();
  private readonly turning = new Set<string>();

  constructor(options: IssueFlowOptions) {
    this.options = options;
    this.vault = options.vault
      ?? new IssueEnvironmentVault(options.dataDir);
    this.issuesRoot = join(options.dataDir, "issues");
    mkdirSync(this.issuesRoot, { recursive: true });
    this.recover();
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private recover(): void {
    let interrupted = 0;
    for (const name of readdirSync(this.issuesRoot)) {
      if (!name.startsWith("issue-")) continue;
      const root = join(this.issuesRoot, name);
      const state = loadState(root);
      if (!state) continue;
      if (state.status === "running" || state.status === "queued") {
        state.status = "interrupted";
        state.stage_note = "服务重启打断,发消息即可续聊";
        saveState(root, state);
        interrupted += 1;
      }
      const live: LiveIssue = {
        id: state.id, root, state,
        humanGate: new HumanGate(join(root, "waiting.json")),
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
    if (interrupted) {
      this.log(`[issue-flow] 恢复: ${interrupted} 个问题会话标记为已中断(可续聊)`);
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

  // ---- 视图旁路:耗时与卡点 + 结论文档(只读,fail-open) ----

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

  /** 结论文档(issue-analysis.md):404 只发生在问题号未知;文档缺失
   * 返回 {unavailable}——那是"还没生成",不是"没有这个接口"。 */
  analysis(id: string): {
    content?: string;
    truncated?: boolean;
    unavailable?: string;
  } {
    const live = this.require(id);
    const read = readAnalysisFile(live.root);
    if (!read) return { unavailable: "尚未生成结论文档" };
    return {
      content: read.content,
      ...(read.truncated ? { truncated: true } : {}),
    };
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
    if (moduleId) {
      try {
        const module = readBusinessModule(this.options.dataDir, moduleId);
        if (module.status !== "active") {
          throw new IssueControlError(
            `业务模块「${module.name}」已归档,不能用于新问题会话`);
        }
        moduleName = module.name;
        moduleRepos = module.repositories;
      } catch (error) {
        if (error instanceof IssueControlError) throw error;
        throw new IssueControlError(
          `业务模块 ${moduleId} 不存在或元数据不可读,请刷新模块列表后重试`);
      }
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
    let environment;
    let environmentPassword: string | undefined;
    if (input.environment) {
      const hosts = input.environment.hosts.map((host) => host.trim()).filter(Boolean);
      if (!hosts.length) throw new IssueControlError("网管环境至少要有一个服务器地址");
      environmentPassword = input.environment.password;
      if (!environmentPassword?.trim()) {
        throw new IssueControlError("配置了网管环境就必须填写共用密码");
      }
      environment = {
        credential_ref: "", // 登记后由 vault 回填
        name: input.environment.name?.trim() || hosts[0],
        hosts,
        port: input.environment.port ?? 22,
      };
    }

    const id = this.nextId();
    const root = join(this.issuesRoot, id);
    mkdirSync(root, { recursive: true });
    if (environment && environmentPassword) {
      // 与「问题卡环境表单」(attachEnvironment)同一条 vault 路径:
      // 密码只进加密文件,issue.json 永远只有引用。
      environment = this.storeEnvironment(id, input.environment!);
    }
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
      ...(environment ? { environment } : {}),
      // 模式一律烙印落盘(free 也记):审计要看"当时是什么模式",
      // 旧现场缺字段读作自由(兼容),不等于新会话不记。
      mode,
      ...(scenario
        ? {
          scenario,
          round: 1,
          stage_states: initStageStates(scenario, 0),
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

  /** 网管环境落盘的唯一路径:密码只进 vault(AES-GCM 按会话隔离的
   * 加密文件),issue.json/事件/提示词永远只有 credential_ref。playbook
   * 契约:三个账号共用一个密码,按旧形状存三套(sopuser/ossuser/
   * ossadm 同密码),vault 校验与工具取密(sopuser)都不用特判。
   * 登记与 POST /issues/:id/environment 共用,秘密纪律只有一份。 */
  private storeEnvironment(
    id: string,
    input: IssueEnvironmentInput,
  ): IssueEnvironmentConfig {
    const hosts = input.hosts.map((host) => host.trim()).filter(Boolean);
    if (!hosts.length) {
      throw new IssueControlError("网管环境至少要有一个服务器地址");
    }
    const password = input.password;
    if (!password?.trim()) {
      throw new IssueControlError("配置了网管环境就必须填写共用密码");
    }
    const name = input.name?.trim() || hosts[0];
    const port = input.port ?? 22;
    const refs = this.vault.store(id, [{
      name,
      purpose: "both",
      host: hosts[0],
      port,
      accounts: ["sopuser", "ossuser", "ossadm"].map((username) =>
        ({ username, password })),
    }]);
    return { credential_ref: refs[0]?.id ?? "", name, hosts, port };
  }

  /** 网管环境配置(问题卡 env_needed 闸的作答口,POST
   * /issues/:id/environment):登记时没配环境,拉日志/换库的工具现场
   * 举闸后,用户在这里补地址与密码。密码进 vault 后即清闸并开平台
   * 回合,让 Agent 重试刚才的操作。 */
  attachEnvironment(
    id: string,
    input: IssueEnvironmentInput,
  ): IssueSummary {
    const live = this.require(id);
    const { state } = live;
    const environment = this.storeEnvironment(id, input);
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
      "平台通知: 网管环境已配置(密码由平台保管,不进入对话)。"
        + "请重试刚才的操作——拉日志用 fetch_logs,换库部署用 build_deploy。");
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
    this.turning.add(live.id);
    live.state.status = "running";
    live.state.nudges = 0;
    saveState(live.root, live.state);
    void this.runTurn(live, body).finally(() => {
      this.turning.delete(live.id);
      void this.pump();
    });
  }

  /** 续聊形态的回合体:现场(driver)在场就把话递进去;进程重启后
   * 重建会话,以续聊提示词把话交给重建的上下文。 */
  private continueTurn(live: LiveIssue, message: string): void {
    this.beginTurn(live, async () => {
      await this.ensureContainer(live);
      if (live.driver) return live.driver.continueWith(message);
      const driver = await this.openDriver(live);
      return driver.startResume(issueResumePrompt(live.state, message));
    });
  }

  /** 并发额度:同时进行的回合数(等待用户/闲置/挂起的会话不占额度)。 */
  private async pump(): Promise<void> {
    for (const live of this.live.values()) {
      if (this.turning.size >= (this.options.maxConcurrentTurns ?? 2)) break;
      if (live.state.status !== "queued" || this.turning.has(live.id)) continue;
      this.beginTurn(live, async () => {
        // 2026-08-28 拍板:克隆不再是回合前的自动动作——登记的仓由
        // Agent 在「拉取代码仓」阶段调 pull_repo 逐个落地(开场词有令)。
        const driver = await this.openDriver(live);
        return driver.start(live.state.mode === "fixed"
          ? issueFixedOpeningPrompt(live.state)
          : issueOpeningPrompt(live.state));
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
    const head = await currentHead(repo.dir);
    return {
      dir: relative(live.root, repo.dir) || repo.dir,
      cloned,
      ...(branch ? { branch } : {}),
      head,
      ...(baselineMiss ? { baselineMiss } : {}),
    };
  }

  /** 单回合执行骨架:统一失败收口,绝不把异常闷成悬挂状态。 */
  private async runTurn(
    live: LiveIssue,
    body: () => Promise<Outcome>,
  ): Promise<void> {
    try {
      const outcome = await body();
      this.settle(live, outcome);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      live.state.status = "failed";
      live.state.error = detail;
      saveState(live.root, live.state);
      this.releaseDriver(live);
      this.log(`[issue-flow] ${live.id} 回合失败: ${detail}`);
    } finally {
      // waiting_user 的回合还没真正结束(AskUserQuestion 挂起中,作答后
      // 还会在同一回合里继续用 bash)——容器必须留着。
      if (live.state.status !== "waiting_user") this.stopContainer(live);
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
            live.driver!.continueWith(late.join("\n\n")));
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
            });
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
    if (isTerminal(state.status)) this.releaseDriver(live);
  }

  private releaseDriver(live: LiveIssue): void {
    live.driver?.dispose();
    live.driver = undefined;
  }

  private stopContainer(live: LiveIssue): void {
    const container = live.container;
    live.container = undefined;
    if (container) {
      void container.stop().catch((error) =>
        this.log(`[issue-flow] ${live.id} 容器停止失败(继续): ${String(error)}`));
    }
  }

  private modelChoice(): { provider: string; model: string; json: Record<string, unknown> } {
    const fromSettings = this.options.settings?.models() ?? {};
    return {
      provider: fromSettings.provider ?? this.options.provider,
      model: fromSettings.model ?? this.options.model,
      json: fromSettings.json ?? this.options.modelsJson,
    };
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
      { memory: isolation.memory, cpus: isolation.cpus, pidsLimit: isolation.pidsLimit },
      { network: isolation.network },
    );
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
      gitCredential: () =>
        this.options.gitCredential?.(live.state.account),
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
      provider: model.provider,
      model: model.model,
      eventLog: new EventLog(join(live.root, "events.jsonl")),
      transcript: new TranscriptStore(join(live.root, "transcript.jsonl"), "main"),
      gate: new GateService({
        // 问题会话的可达边界=整个会话工作区(代码仓 + local-logs +
        // issue-analysis.md 都在里面)。台账类文件由 GateService 的
        // 宿主账本规则拒写;问题域追加自己的账本与技能目录——
        // issue.json 是推送门禁的依据,skills/ 是行为契约,都不能
        // 让 Agent 自己改。
        workspace: live.root,
        cwd: live.root,
        extraLedgerFiles: ["issue.json", "issue.json.tmp"],
        extraLedgerDirs: ["skills"],
        failClosed: false,
        log: (message) => this.log(`[issue-gate] ${message}`),
      }),
      humanGate: live.humanGate,
      allowHumanQuestions: true,
      allowSubagents: false,
      extraTools: createIssueTools(context),
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
        `用户对问题卡的答复:\n${renderDecision(record)}`));
    });
    return summarize(live.state);
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
        "网管环境请在问题卡的配置表单里填写服务器地址与共用密码后提交");
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
      this.stopContainer(live);
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
      this.stopContainer(live);
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
      throw new IssueControlError("会话正在运行,请用插话(interrupt)");
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
    if (!content) throw new IssueControlError("插话内容不能为空");
    if (live.state.status !== "running" || !live.driver) {
      throw new IssueControlError("会话不在运行中,插话无处送达");
    }
    void live.driver.steer(content).catch((error) =>
      this.log(`[issue-flow] ${id} 插话失败: ${String(error)}`));
    return summarize(live.state);
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

  control(id: string, input: {
    action: "cancel" | "archive";
    kind?: IssueConclusionKind;
    summary?: string;
  }): IssueSummary {
    const live = this.require(id);
    if (isTerminal(live.state.status)) {
      throw new IssueControlError(`会话已处于终态 ${live.state.status}`);
    }
    if (this.turning.has(live.id)) {
      throw new IssueControlError("会话正在运行,先等回合结束或直接取消");
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
    void live.driver?.abort().catch(() => undefined);
    this.releaseDriver(live);
    this.stopContainer(live);
    this.vault.remove(live.id);
    this.log(`[issue-flow] ${id} ${input.action === "cancel" ? "取消" : "归档"}`);
    return summarize(live.state);
  }

  // ---- 固定流程:流水线监看(阶段6,MR 全绿才放行换库) ----

  private pipelineKnobs(): { pollMs: number; budgetMs: number } {
    const knobs = this.options.settings?.runtime?.() ?? {};
    return {
      pollMs: Math.max(1_000, (knobs.poll_interval_s ?? 10) * 1000),
      budgetMs: Math.max(60_000, (knobs.poll_timeout_s ?? 1_800) * 1000),
    };
  }

  /** MR 建成即挂表监看:触发流水线 → 轮询到终态。绿→自动进换库验证;
   * 红→携失败项开回合让 AI 修(同分支再推,MR 自动跟新提交)。幂等:
   * 同 SHA 在盯则跳过(MR 幂等重建会重复触发本钩子)。 */
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
        const terminal = status.runs.findLast((run) => run.status !== "running");
        if (terminal) {
          this.settlePipeline(live, repo, sha, terminal);
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
      // 跑绿才进换库验证;还有在途/未绿的就等齐,不抢跑。
      const mrs = state.mrs ?? [];
      const allGreen = mrs.length > 0 && mrs.every((mr) =>
        state.pipelines?.[mr.repo]?.status === "success");
      const anyWatching = Object.values(state.pipelines ?? {})
        .some((item) => item.watching);
      if (allGreen && !anyWatching) {
        fixedAdvance(state, "deploy_verify",
          `全部 ${mrs.length} 个 MR 流水线跑绿,进入换库环境验证`);
        saveState(live.root, state);
        this.startPlatformTurn(live, fixedAdvanceNotice(state,
          `全部 MR 流水线已跑绿(${mrs.map((mr) => mr.repo).join(", ")}),`
            + "进入「换库环境验证」阶段。请调用 build_deploy 部署到网管环境"
            + "(多仓时指定要部署的仓);部署完成后平台会举验证卡,等用户真实验证。"));
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
      throw new IssueControlError(
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
    let detail: DtsTicketDetail;
    try {
      detail = await this.options.dts.detail(ticket);
    } catch (error) {
      throw new IssueControlError(
        `DTS 校验未通过: ${error instanceof Error ? error.message : String(error)}`);
    }
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
    // 环境凭据:解出旧密码,给新会话存一份自己的(vault 按会话 id 隔离;
    // 先复制后销毁旧的,顺序不能反)。
    let environment = state.environment ? { ...state.environment } : undefined;
    if (environment) {
      const password = this.vault.credential(
        id, state.environment!.credential_ref, "sopuser")?.password;
      if (password) {
        const refs = this.vault.store(newId, [{
          name: environment.name,
          purpose: "both",
          host: environment.hosts[0],
          port: environment.port,
          accounts: ["sopuser", "ossuser", "ossadm"].map((username) =>
            ({ username, password })),
        }]);
        environment = { ...environment, credential_ref: refs[0]?.id ?? "" };
      } else {
        environment = undefined;
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
      ...(environment ? { environment } : {}),
      mode: "fixed",
      scenario: "ticket",
      round: 1,
      stage_states: initStageStates("ticket", 3),
      converted_from: id,
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
    this.stopContainer(live);
    this.vault.remove(id);
    this.log(`[issue-flow] ${id} 关联 ${ticket} 转正为 ${newId}`);
    void this.pump();
    return { converted: summarize(converted) };
  }

  // ---- 关停 ----

  async shutdown(): Promise<void> {
    const work = [...this.live.values()].map(async (live) => {
      void live.driver?.abort().catch(() => undefined);
      this.releaseDriver(live);
      if (live.container) await live.container.stop().catch(() => undefined);
      live.container = undefined;
    });
    await Promise.allSettled(work);
  }
}

/** 供 server 路由做类型收窄的状态导出。 */
export type { IssueStatus, IssueStage, IssueSummary };
