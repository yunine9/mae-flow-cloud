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
import { join, resolve, sep } from "node:path";
import { CloudSession, type Outcome } from "../sessionDriver.ts";
import { EventLog } from "../semanticEvents.ts";
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
  recordTransition,
  saveState,
  summarize,
  type FixedStage,
  type IssueConclusionKind,
  type IssueFlowMode,
  type IssueScenario,
  type IssueSource,
  type IssueStage,
  type IssueStatus,
  type IssueSummary,
  type IssueSessionState,
} from "./state.ts";
import {
  cloneRepository,
  ensureBranch,
  validateRepoUrl,
  type GitCredential,
} from "./issueGit.ts";
import { readBusinessModule } from "../businessModuleLibrary.ts";
import type { IssueOpsTools } from "./opsTools.ts";
import type { DtsGateway, DtsTicketDetail } from "./gateways.ts";
import {
  listLogs,
  listManualEdits,
  listWorkspaceChanges,
  readLog,
  readWorkspaceFile,
  recentEvents,
  recordManualEdit,
  workspaceDiffAll,
  workspaceFileDiff,
  writeWorkspaceFile,
} from "./materials.ts";
import { createIssueTools, expectedBranch, GATE_OPTIONS, type IssueToolContext } from "./tools.ts";
import {
  buildIssueTimeline,
  type IssueSessionTimeline,
} from "./sessionView.ts";
import {
  fixedAdvanceNotice,
  issueFixedOpeningPrompt,
  issueOpeningPrompt,
  issueResumePrompt,
  materializeIssueSkills,
} from "./prompt.ts";
import {
  describePipelineRun,
  getPipelineStatus,
  triggerPipeline,
  type PipelineRun,
} from "../pipelineClient.ts";

export class IssueNotFoundError extends Error {
  constructor(id: string) {
    super(`问题会话 ${id} 不存在`);
  }
}

export class IssueControlError extends Error {}

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

/** 一个问题会话最多拉取的代码仓数。模块库允许一个模块绑 20 个仓,
 * 但问题会话一轮克隆 8 个已是分析上限——再多说明该拆会话了。 */
const MAX_ISSUE_REPOS = 8;

/** 登记仓清单:单仓(兼容字段)与多仓合并去重,逐个过协议校验。
 * 顺序即语义——首个是主仓(交付仓),其余是参考仓。 */
function normalizeIssueRepos(
  single: string | undefined,
  list: string[] | undefined,
): string[] {
  const unique: string[] = [];
  for (const raw of [single ?? "", ...(list ?? [])]) {
    const url = raw.trim();
    if (!url) continue;
    const validated = validateRepoUrl(url);
    if (!unique.includes(validated)) unique.push(validated);
  }
  if (unique.length > MAX_ISSUE_REPOS) {
    throw new IssueControlError(
      `一个问题会话最多拉取 ${MAX_ISSUE_REPOS} 个代码仓(当前 ${unique.length} 个);`
        + "请精简模块绑定或分多次分析");
  }
  return unique;
}

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
      // watching=false 的(终态/耗尽)不重挂。
      if (state.mode === "fixed" && state.pipeline?.watching) {
        this.log(`[issue-flow] ${state.id} 恢复流水线监看 @ ${state.pipeline.sha.slice(0, 12)}`);
        void this.watchPipeline(live, state.pipeline.sha);
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
    const waiting = live.humanGate.pending()[0];
    return {
      ...summarize(live.state),
      waiting,
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

  eventLogPath(id: string): string {
    return join(this.require(id).root, "events.jsonl");
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

  // ---- 登记 ----

  create(input: IssueCreateInput): IssueSummary {
    const account = input.account?.trim();
    if (!account) throw new IssueControlError("缺少归属账号(工号)");
    const title = input.title?.trim() ?? "";
    if (!title || title.length > 120) {
      throw new IssueControlError("问题标题必填且不超过 120 字");
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
    if (mode === "fixed" && !repoUrls.length) {
      throw new IssueControlError(
        "固定流程在登记时就要确定代码仓(阶段1拉取代码仓是必经节点),"
          + "请选择业务模块自动带出,或填写代码仓地址;自由探索模式才允许登记后再补");
    }
    // 个人凭据前置门禁(2026-08-28 拍板,需求侧 /launch-options 的同款
    // 语义收窄到"这单真的会碰远端仓"):克隆与推送都用发起人身份,
    // 没配令牌就让登记过门,失败发生在首轮回合准备期——那是终态,
    // 整单作废。门关在前面:file:// 本地仓与不碰仓的纯研究不拦
    // (拦了就是误伤),令牌在而邮箱缺同样拦(提交署名与平台归属
    // 都按邮箱对人,缺了它推上去的提交是无主的)。
    const remoteRepos = repoUrls.filter((url) => /^https?:\/\//i.test(url));
    if (remoteRepos.length) {
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
      // playbook 契约:三个账号共用一个密码。按旧形状存三套(sopuser/
      // ossuser/ossadm 同密码),vault 校验与工具取密(sopuser)都不用特判。
      const password = environmentPassword;
      const refs = this.vault.store(id, [{
        name: environment.name,
        purpose: "both",
        host: environment.hosts[0],
        port: environment.port,
        accounts: ["sopuser", "ossuser", "ossadm"].map((username) =>
          ({ username, password })),
      }]);
      environment.credential_ref = refs[0]?.id ?? "";
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

  // ---- 会话驱动 ----

  /** 并发额度:同时进行的回合数(等待用户/闲置/挂起的会话不占额度)。 */
  private async pump(): Promise<void> {
    for (const live of this.live.values()) {
      if (this.turning.size >= (this.options.maxConcurrentTurns ?? 2)) break;
      if (live.state.status !== "queued" || this.turning.has(live.id)) continue;
      this.turning.add(live.id);
      live.state.status = "running";
      saveState(live.root, live.state);
      void this.runTurn(live, async () => {
        await this.ensureCloned(live);
        await this.enterFixedStage(live, live.state.stage as FixedStage);
        const driver = await this.openDriver(live);
        return driver.start(live.state.mode === "fixed"
          ? issueFixedOpeningPrompt(live.state)
          : issueOpeningPrompt(live.state));
      }).finally(() => {
        this.turning.delete(live.id);
        void this.pump();
      });
    }
  }

  /** 固定流程的阶段进入钩子:prep_repo 在克隆就绪后由平台收口(有单
   * 场景还要宿主建分支——分支名规范烧着单号,交给 Agent 起名会漂)。
   * 克隆失败按回合异常走 failed(free/fixed 同语义)。 */
  private async enterFixedStage(
    live: LiveIssue,
    stage: FixedStage,
  ): Promise<void> {
    const { state } = live;
    if (state.mode !== "fixed" || !state.scenario || stage !== "prep_repo") {
      return;
    }
    if (!state.repo_urls?.length) {
      throw new Error("固定流程缺少代码仓地址(登记时校验过,这里是防御)");
    }
    const repoDir = join(live.root, "repo");
    if (!existsSync(join(repoDir, ".git"))) {
      await this.ensureCloned(live);
    }
    const branch = state.scenario === "ticket" && state.ticket
      ? expectedBranch(state)
      : undefined;
    if (branch) {
      await ensureBranch({
        dataDir: this.options.dataDir,
        repoDir,
        branch,
        ...(state.baseline ? { startPoint: state.baseline } : {}),
      });
    }
    const repoNote = state.repo_urls.length > 1
      ? `${state.repo_urls.length} 个代码仓已克隆(主仓 repo/,参考仓 ref/)`
      : "代码仓已克隆";
    fixedAdvance(state, "analyze", branch
      ? `${repoNote},修复分支 ${branch} 已创建(在主仓)`
      : `${repoNote}(无单场景不建分支)`);
    saveState(live.root, live.state);
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
        state.status = "idle";
        state.last_reply = live.driver?.finalReply() ?? state.last_reply;
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

  private async ensureCloned(live: LiveIssue): Promise<void> {
    const { state } = live;
    const repos = issueRepoWorkspaces(state, live.root);
    if (!repos.length) return;
    for (const [index, repo] of repos.entries()) {
      if (existsSync(join(repo.dir, ".git"))) continue;
      // baseline 是交付基线,只作用于主仓——参考仓跟自己的默认分支走,
      // 不因别的仓没有同名分支而炸。
      this.log(`[issue-flow] ${live.id} 克隆${index === 0 ? "主仓" : "参考仓"}: ${repo.url}`);
      try {
        await cloneRepository({
          dataDir: this.options.dataDir,
          targetDir: repo.dir,
          repoUrl: repo.url,
          ...(index === 0 && state.baseline ? { baseline: state.baseline } : {}),
          credential: this.options.gitCredential?.(state.account),
        });
      } catch (error) {
        throw new Error(`${index === 0 ? "主仓" : "参考仓"} ${repo.url}: `
          + (error instanceof Error ? error.message : String(error)));
      }
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
      // 固定流程的宿主钩子:MR 建成→启动流水线监看;进入新阶段→
      // 平台侧收口(prep_repo 的建分支/推进在这里做)。
      onMrCreated: () => service.armPipelineWatch(live),
      onStageEntered: async (stage) => {
        await service.enterFixedStage(live, stage);
      },
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
    decision: string;
    notes?: string;
    answers?: Record<string, string>;
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
        decision: input.decision,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      });
    }
    const waiting = live.humanGate.pending()[0];
    if (!waiting) throw new IssueControlError("盘上没有等待中的问题卡(状态不一致)");
    const record = live.humanGate.resolve(waiting.waiting_id, {
      stateVersion: input.state_version,
      decision: input.decision,
      ...(input.answers ? { answers: input.answers } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    if (this.turning.has(live.id)) {
      throw new IssueControlError("会话正在处理上一条输入,稍候再试");
    }
    this.turning.add(live.id);
    live.state.status = "running";
    saveState(live.root, live.state);
    void this.runTurn(live, async () => {
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
    }).finally(() => {
      this.turning.delete(live.id);
      void this.pump();
    });
    return summarize(live.state);
  }

  // ---- 固定流程:平台闸的裁决与阶段机联动 ----

  /** 平台闸作答分派。决策文本是闸门选项原文(前端决策卡不改动地
   * 传回),按 GATE_OPTIONS 的前缀锚匹配;notes 是用户的补充说明。 */
  private resolveGate(live: LiveIssue, input: {
    stateVersion: number;
    decision: string;
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
    const decision = input.decision ?? "";
    const notes = input.notes?.trim() ?? "";
    const supplement = notes ? `\n用户补充说明: ${notes}` : "";
    delete state.gate;
    recordTransition(state, {
      source: "platform",
      note: `用户作答(${gate.kind}): ${decision.split("\n")[0]}${notes ? `;补充: ${notes.split("\n")[0]}` : ""}`,
    });

    const startTurn = (message: string) => {
      this.turning.add(live.id);
      state.status = "running";
      saveState(live.root, state);
      void this.runTurn(live, async () => {
        await this.ensureContainer(live);
        if (live.driver) return live.driver.continueWith(message);
        const driver = await this.openDriver(live);
        return driver.startResume(issueResumePrompt(state, message));
      }).finally(() => {
        this.turning.delete(live.id);
        void this.pump();
      });
    };

    if (gate.kind === "analysis_confirm") {
      if (decision.startsWith(GATE_OPTIONS.analysis_confirm[0])) {
        fixedAdvance(state, "fix", "用户确认分析报告,进入问题修改");
        saveState(live.root, state);
        startTurn(fixedAdvanceNotice(state,
          `用户已确认问题分析报告,进入「问题修改」阶段。${supplement}`
            + "请按已确认的方案实施修复,完成后调用 complete_stage。"));
        return summarize(state);
      }
      // 有补充意见:留在分析阶段继续完善,改完重新提交。
      state.stage_note = "用户对分析报告有补充意见,继续分析";
      saveState(live.root, state);
      startTurn(
        `用户对分析报告提出补充意见,仍在「问题分析」阶段:${decision}${supplement}\n`
          + "请按意见完善 issue-analysis.md 后重新 submit_analysis 提交。");
      return summarize(state);
    }

    if (gate.kind === "conclude") {
      if (decision.includes("确认非问题")) {
        // 确认非问题:闭环归档(非问题也留报告,测试拿去留痕)。
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
      if (decision.includes("确认是问题")) {
        // 确认是问题:挂起等用户关联 DTS 单号(关联即转正)。
        fixedComplete(state, "结论:是问题,挂起等待关联单号");
        state.status = "suspended";
        state.stage_note = "结论为「是问题」——请关联 DTS 单号转正,或直接归档";
        saveState(live.root, state);
        this.releaseDriver(live);
        this.stopContainer(live);
        this.log(`[issue-flow] ${live.id} 结论是问题,已挂起待关联单号`);
        return summarize(state);
      }
      // 有补充意见:回到分析阶段继续查证(结论节点没走完,重置回未开始)。
      const concludeIndex = state.scenario
        ? fixedStageIndex(state.scenario, "conclude") : -1;
      if (concludeIndex >= 0
          && (state.stage_states?.[concludeIndex] ?? "pending") !== "pending") {
        (state.stage_states ??= [])[concludeIndex] = "pending";
      }
      fixedAdvance(state, "analyze", "用户对结论有补充意见,继续分析");
      saveState(live.root, state);
      startTurn(
        `用户对分析结论提出意见,回到「问题分析」阶段:${decision}${supplement}\n`
          + "请继续查证,完善 issue-analysis.md 后重新 submit_analysis 提交结论。");
      return summarize(state);
    }

    // env_verify:换库验证的裁决
    if (decision.startsWith("验证通过")) {
      fixedComplete(state, "用户环境验证通过,待归档收口");
      state.status = "idle";
      state.stage_note = "环境验证通过——确认 MR 合入后可归档收口";
      saveState(live.root, state);
      return summarize(state);
    }
    if (decision.includes("验证发现问题")) {
      const reason = notes || decision;
      fixedRollback(state, `用户环境验证发现问题:${reason.split("\n")[0]}`);
      saveState(live.root, state);
      startTurn(fixedAdvanceNotice(state,
        `用户在环境验证发现问题,已回退到「问题分析」阶段(第 ${state.round} 轮)。`
          + `${supplement || `\n用户描述: ${reason}`}\n`
          + "请带着新一轮的现场重新分析(前几轮的修复在分支上,不要推倒重来),"
          + "分析完成后重新 submit_analysis。"));
      return summarize(state);
    }
    throw new IssueControlError(
      `无法识别的验证答复:「${decision.slice(0, 40)}」,请通过问题卡的选项作答`);
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
    this.turning.add(live.id);
    live.state.status = "running";
    saveState(live.root, live.state);
    void this.runTurn(live, async () => {
      await this.ensureContainer(live);
      if (live.driver) {
        return live.driver.continueWith(content);
      }
      const driver = await this.openDriver(live);
      return driver.startResume(issueResumePrompt(live.state, content));
    }).finally(() => {
      this.turning.delete(live.id);
      void this.pump();
    });
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
          : live.state.mr ? "delivered"
          : live.state.push ? "fixed" : "non_issue");
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
  armPipelineWatch(live: LiveIssue): void {
    const state = live.state;
    const platformUrl = this.options.platformUrl;
    if (!platformUrl || !state.push || state.mode !== "fixed") return;
    const sha = state.push.sha;
    if (state.pipeline?.watching && state.pipeline.sha === sha) return;
    const now = Date.now();
    const { budgetMs } = this.pipelineKnobs();
    state.pipeline = {
      sha,
      status: "running",
      watching: true,
      started_at: new Date(now).toISOString(),
      deadline: new Date(now + budgetMs).toISOString(),
      round: state.round ?? 1,
    };
    recordTransition(state, {
      source: "platform",
      note: `流水线监看已启动 @ ${sha.slice(0, 12)}`,
    });
    saveState(live.root, state);
    void this.watchPipeline(live, sha);
  }

  private async watchPipeline(live: LiveIssue, sha: string): Promise<void> {
    const { state } = live;
    const platformUrl = this.options.platformUrl;
    if (!platformUrl) return;
    const { pollMs } = this.pipelineKnobs();
    const call = () => ({
      platformUrl,
      sha,
      ...(state.repo_url ? { repo: state.repo_url } : {}),
      credential: this.options.gitCredential?.(state.account),
    });
    // 触发(假件必须显式触发;真件幂等无害)。触发响应可能已是终态。
    try {
      const first = await triggerPipeline(call());
      if (first.status !== "running") {
        this.settlePipeline(live, sha, first);
        return;
      }
    } catch (error) {
      // 触发失败不弃看:适配层可能已因建 MR 自动触发,状态查询照走。
      this.log(`[issue-flow] ${live.id} 流水线触发失败(继续查状态): ${String(error)}`);
    }
    while (
      state.pipeline?.sha === sha
      && state.pipeline.watching
      && !isTerminal(state.status)
      && Date.now() < Date.parse(state.pipeline.deadline)
    ) {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, pollMs);
        timer.unref?.();
      });
      if (state.pipeline?.sha !== sha || !state.pipeline.watching) return;
      try {
        const status = await getPipelineStatus(call());
        const terminal = status.runs.findLast((run) => run.status !== "running");
        if (terminal) {
          this.settlePipeline(live, sha, terminal);
          return;
        }
      } catch (error) {
        this.log(`[issue-flow] ${live.id} 流水线查询失败(继续轮): ${String(error)}`);
      }
    }
    // 预算耗尽:如实停表,不阻塞会话——用户可人工查看后发消息继续。
    if (state.pipeline?.sha === sha && state.pipeline.watching) {
      state.pipeline.watching = false;
      state.pipeline.last_error = "轮询预算耗尽,请人工查看流水线";
      state.stage_note = "流水线轮询预算耗尽——请人工查看 MR/流水线,再发消息继续";
      saveState(live.root, state);
      this.log(`[issue-flow] ${live.id} 流水线监看预算耗尽 @ ${sha.slice(0, 12)}`);
    }
  }

  private settlePipeline(
    live: LiveIssue,
    sha: string,
    run: PipelineRun,
  ): void {
    const { state } = live;
    if (state.pipeline?.sha !== sha) return;
    state.pipeline.status = run.status;
    state.pipeline.watching = false;
    if (run.checks) state.pipeline.checks = run.checks;
    if (run.status === "success") {
      recordTransition(state, {
        source: "platform", note: `流水线全绿 @ ${sha.slice(0, 12)}`,
      });
      fixedAdvance(state, "deploy_verify", "流水线全绿,进入换库环境验证");
      saveState(live.root, state);
      this.startPlatformTurn(live, fixedAdvanceNotice(state,
        `流水线已全绿${state.mr ? `(MR: ${state.mr.url})` : ""},进入「换库环境验证」阶段。`
          + "请调用 build_deploy 部署到网管环境;部署完成后平台会举验证卡,等用户真实验证。"));
    } else {
      recordTransition(state, {
        source: "platform", note: `流水线失败 @ ${sha.slice(0, 12)}`,
      });
      saveState(live.root, state);
      this.startPlatformTurn(live,
        `平台通知: 流水线未通过(仍在「提交 MR·跑绿」阶段)。\n${describePipelineRun(run)}\n`
          + "请修复后同分支 push_branch 再 create_mr(同一 MR 会自动跟新提交),平台会重新监看。");
    }
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
    this.turning.add(live.id);
    state.status = "running";
    saveState(live.root, state);
    void this.runTurn(live, async () => {
      await this.ensureContainer(live);
      if (live.driver) return live.driver.continueWith(message);
      const driver = await this.openDriver(live);
      return driver.startResume(issueResumePrompt(state, message));
    }).finally(() => {
      this.turning.delete(live.id);
      void this.pump();
    });
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
    // 工作区复制:repo/(主仓)+ ref/(参考仓)整目录 + 分析报告
    // (skills 由 openDriver 重物化,local-logs 不带——新一轮要拉新日志)。
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
    if (converted.repo_url && existsSync(join(newRoot, "repo", ".git"))) {
      await ensureBranch({
        dataDir: this.options.dataDir,
        repoDir: join(newRoot, "repo"),
        branch: expectedBranch(converted),
        ...(converted.baseline ? { startPoint: converted.baseline } : {}),
      });
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

  // ---- DTS 拉单(页面列表用) ----

  async listDts(account: string) {
    if (!this.options.dts) {
      throw new IssueControlError("DTS 网关未配置(部署需 --dts-mcp-url 与 token)");
    }
    return this.options.dts.listByOwner(account);
  }

  /** 当前 DTS 是否为外部开发模式的模拟网关(--dts-mock)。前端据此
   * 在拉单页签挂 DEV 徽标,模拟单不被误当真实单据。 */
  get dtsMock(): boolean {
    return this.options.dts?.mock === true;
  }

  async getDtsDetail(ticket: string) {
    if (!this.options.dts) {
      throw new IssueControlError("DTS 网关未配置(部署需 --dts-mcp-url 与 token)");
    }
    return this.options.dts.detail(ticket);
  }

  async proxyDtsFile(path: string) {
    if (!this.options.dts) {
      throw new IssueControlError("DTS 网关未配置(部署需 --dts-mcp-url 与 token)");
    }
    return this.options.dts.proxyFile(path);
  }

  // ---- 会话材料(交付材料页签;全部只读旁路 + 快速修改唯一写口) ----

  listMaterials(id: string) {
    const live = this.require(id);
    return {
      ticket: live.state.ticket,
      push: live.state.push,
      analysis_available: existsSync(join(live.root, "issue-analysis.md")),
      changes: listWorkspaceChanges(join(live.root, "repo")),
      logs: listLogs(live.root),
      manual_edits: listManualEdits(live.root),
    };
  }

  readWorkspaceFile(id: string, rel: string) {
    return readWorkspaceFile(join(this.require(id).root, "repo"), rel);
  }

  /** 快速修改:写工作区文件并入人工台账(会话私有账本,不进语义事件)。 */
  saveWorkspaceFile(id: string, rel: string, content: string) {
    const live = this.require(id);
    const result = writeWorkspaceFile(join(live.root, "repo"), rel, content);
    recordManualEdit(live.root, rel, result.size);
    this.log(`[issue-flow] ${live.id} 人工修改 ${rel}(${result.size}B)`);
    return result;
  }

  workspaceFileDiff(id: string, rel: string) {
    return workspaceFileDiff(join(this.require(id).root, "repo"), rel);
  }

  workspaceDiffAll(id: string) {
    return workspaceDiffAll(join(this.require(id).root, "repo"));
  }

  listIssueLogs(id: string) {
    return listLogs(this.require(id).root);
  }

  readIssueLog(id: string, name: string) {
    return readLog(this.require(id).root, name);
  }

  recentEvents(id: string, limit?: number) {
    return recentEvents(this.require(id).root, limit);
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
