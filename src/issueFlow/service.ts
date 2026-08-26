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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CloudSession, type Outcome } from "../sessionDriver.ts";
import { EventLog } from "../semanticEvents.ts";
import { TranscriptStore } from "../transcriptStore.ts";
import { GateService } from "../gateService.ts";
import { HumanGate, renderDecision, type WaitingRecord } from "../humanGate.ts";
import { IssueEnvironmentVault } from "../issueEnvironment.ts";
import { TaskContainer, taskContainerInstance } from "../containerRuntime.ts";
import { repairContainerMutationOwnership } from "../containerOwnership.ts";
import {
  isTerminal,
  loadState,
  saveState,
  summarize,
  type IssueConclusionKind,
  type IssueSource,
  type IssueStage,
  type IssueStatus,
  type IssueSummary,
  type IssueSessionState,
} from "./state.ts";
import {
  cloneRepository,
  validateRepoUrl,
  type GitCredential,
} from "./issueGit.ts";
import type { IssueOpsTools } from "./opsTools.ts";
import type { DtsGateway, CodehubGateway } from "./gateways.ts";
import { createIssueTools, type IssueToolContext } from "./tools.ts";
import { issueOpeningPrompt, issueResumePrompt, materializeIssueSkills } from "./prompt.ts";

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
  baseline?: string;
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
  };
  gitCredential?: (account: string) =>
    (GitCredential & { email?: string }) | undefined;
  opsTools?: IssueOpsTools;
  dts?: DtsGateway;
  codehub?: CodehubGateway;
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
      this.live.set(state.id, {
        id: state.id, root, state,
        humanGate: new HumanGate(join(root, "waiting.json")),
      });
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
    messages: IssueMessage[];
    has_analysis: boolean;
  } {
    const live = this.require(id);
    const waiting = live.humanGate.pending()[0];
    return {
      ...summarize(live.state),
      waiting,
      messages: this.messages(id),
      has_analysis: existsSync(join(live.root, "issue-analysis.md")),
    };
  }

  /** 会话消息(事件账本投影):user/assistant/decision 三类,尾部截断。 */
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
    const repoUrl = input.repoUrl?.trim() || undefined;
    if (repoUrl) validateRepoUrl(repoUrl);
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
    const state: IssueSessionState = {
      id,
      account,
      created_at: now,
      updated_at: now,
      title,
      description: input.description?.trim() ?? "",
      source: input.source ?? "manual",
      ...(ticket ? { ticket } : {}),
      ...(repoUrl ? { repo_url: repoUrl } : {}),
      ...(input.baseline?.trim() ? { baseline: input.baseline.trim() } : {}),
      ...(environment ? { environment } : {}),
      status: "queued",
      stage: "registered",
      stage_note: "已登记,准备开始首轮研究",
      stage_at: now,
    };
    saveState(root, state);
    this.live.set(id, {
      id, root, state,
      humanGate: new HumanGate(join(root, "waiting.json")),
    });
    this.log(`[issue-flow] ${id} 已登记(${ticket ?? "无单号"}): ${title}`);
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

  /** 并发额度:同时进行的回合数(等待用户/闲置的会话不占额度)。 */
  private async pump(): Promise<void> {
    for (const live of this.live.values()) {
      if (this.turning.size >= (this.options.maxConcurrentTurns ?? 2)) break;
      if (live.state.status !== "queued" || this.turning.has(live.id)) continue;
      this.turning.add(live.id);
      live.state.status = "running";
      saveState(live.root, live.state);
      void this.runTurn(live, async () => {
        await this.ensureCloned(live);
        const driver = await this.openDriver(live);
        return driver.start(issueOpeningPrompt(live.state));
      }).finally(() => {
        this.turning.delete(live.id);
        void this.pump();
      });
    }
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
    if (!state.repo_url) return;
    const repoDir = join(live.root, "repo");
    if (existsSync(join(repoDir, ".git"))) return;
    this.log(`[issue-flow] ${live.id} 克隆代码仓: ${state.repo_url}`);
    await cloneRepository({
      dataDir: this.options.dataDir,
      targetDir: repoDir,
      repoUrl: state.repo_url,
      ...(state.baseline ? { baseline: state.baseline } : {}),
      credential: this.options.gitCredential?.(state.account),
    });
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
      codehub: this.options.codehub,
      environmentPassword: () => {
        const ref = live.state.environment?.credential_ref;
        return ref
          ? service.vault.credential(live.id, ref, "sopuser")?.password
          : undefined;
      },
      gitCredential: () =>
        this.options.gitCredential?.(live.state.account),
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

  reply(id: string, text: string): IssueSummary {
    const live = this.require(id);
    const status = live.state.status;
    if (status === "waiting_user") {
      throw new IssueControlError("会话在等你对问题卡的答复,请回答问题卡而不是发消息");
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
    live.state.ticket = value;
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
        ?? (live.state.mr ? "delivered"
          : live.state.push ? "fixed" : "non_issue");
      live.state.conclusion = {
        kind,
        summary: input.summary?.trim() || live.state.last_reply
          || live.state.stage_note || "(无补充说明)",
        at: now,
      };
      live.state.status = "archived";
      live.state.stage = "concluded";
      live.state.stage_at = now;
    }
    saveState(live.root, live.state);
    void live.driver?.abort().catch(() => undefined);
    this.releaseDriver(live);
    this.stopContainer(live);
    this.vault.remove(live.id);
    this.log(`[issue-flow] ${id} ${input.action === "cancel" ? "取消" : "归档"}`);
    return summarize(live.state);
  }

  // ---- DTS 拉单(页面列表用) ----

  async listDts(account: string) {
    if (!this.options.dts) {
      throw new IssueControlError("DTS 网关未配置(部署需 --dts-mcp-url 与 token)");
    }
    return this.options.dts.listByOwner(account);
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
