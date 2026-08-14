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
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { KernelHost } from "./kernelHost.ts";
import type { Notifier, NotifyRecord } from "./notifier.ts";
import { EventLog } from "./semanticEvents.ts";
import { TranscriptStore } from "./transcriptStore.ts";
import { GateService, type GateContract } from "./gateService.ts";
import { HumanGate, type WaitingRecord } from "./humanGate.ts";
import { CloudSession, type Outcome } from "./sessionDriver.ts";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_for_human"
  | "completed"
  | "verifying"      // MR 已建,权威流水线未过(主 spec §10:不能标完成)
  | "await_merge"    // 流水线通过,等待人工合入;系统不自动合并
  | "failed";

export interface TaskSummary {
  id: string;
  requirement: string;
  status: TaskStatus;
  waiting?: WaitingRecord;
  detail?: string;
  created_at: string;
  workspace: string;
  /** 小鲁班通知账号(任务创建时填写,主 spec §5.1)。 */
  luban_account?: string;
  /** 最近一张待办的通知投递事实(失败标红的依据,不影响流程)。 */
  notify?: Pick<NotifyRecord, "delivered" | "attempts" | "last_error">;
  /** Git 交付事实(§10):MR 链接/状态、流水线结果、或没交付的原因。 */
  delivery?: {
    mr_url?: string;
    mr_state?: string;
    pipeline?: string;
    skipped?: string;
  };
}

export interface TaskServiceOptions {
  dataDir: string;
  provider: string;
  model: string;
  /** 每个任务 agent 目录的 models.json 内容(生产=GLM 网关,演练=剧本假模型)。 */
  modelsJson: Record<string, unknown>;
  maxConcurrent?: number;
  contract?: GateContract;
  /** 内核模式(阶段 1 纵向闭环):任务=克隆 repoPath → 内核 bootstrap
   * (sessionstart+userprompt 捕获需求、铺转发壳)→ 深层门禁与证据
   * 全部经 kernelHost 走内核 dispatch。不配则为纯会话模式(演练)。 */
  host?: { kernelRoot: string; repoPath: string; python?: string };
  /** 小鲁班通知(内网能力,外部用 FakeLubanServer 模拟)。 */
  notifier?: Notifier;
  /** Git 交付(§10):平台 API 地址(外部=FakeGitPlatform)。
   * 配了它,任务收轮后由服务账号建 MR + 触发权威流水线。 */
  delivery?: { platformUrl: string };
  /** 审批链接的前缀(通知里带的 URL),如 http://host:port。 */
  linkBase?: string;
  log?: (message: string) => void;
}

interface TaskState {
  summary: TaskSummary;
  driver?: CloudSession;
  humanGate: HumanGate;
  /** 任务代码工作区(host 模式=仓库克隆目录),交付模块读内核状态用。 */
  cwd?: string;
  /** 活的通知记录:后台退避重试会原地更新,查询时投影最新事实。 */
  notifyRecord?: NotifyRecord;
}

export class TaskService {
  private tasks = new Map<string, TaskState>();
  private runningCount = 0;
  private queue: string[] = [];
  private counter = 0;

  constructor(readonly options: TaskServiceOptions) {}

  list(): TaskSummary[] {
    return [...this.tasks.values()]
      .map((task) => this.project(task))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  get(id: string): TaskSummary | undefined {
    const task = this.tasks.get(id);
    return task ? this.project(task) : undefined;
  }

  private project(task: TaskState): TaskSummary {
    const record = task.notifyRecord;
    return {
      ...task.summary,
      notify: record
        ? {
            delivered: record.delivered,
            attempts: record.attempts,
            last_error: record.last_error,
          }
        : undefined,
    };
  }

  eventLogPath(id: string): string {
    return join(this.tasks.get(id)!.summary.workspace, "events.jsonl");
  }

  create(
    requirement: string,
    options: { account?: string } = {},
  ): TaskSummary {
    this.counter += 1;
    const id = `task-${this.counter}`;
    const workspace = join(this.options.dataDir, id);
    mkdirSync(workspace, { recursive: true });
    const summary: TaskSummary = {
      id,
      requirement,
      status: "queued",
      created_at: new Date().toISOString(),
      workspace,
      luban_account: options.account || undefined,
    };
    this.tasks.set(id, {
      summary,
      humanGate: new HumanGate(join(workspace, "waiting.json")),
    });
    this.queue.push(id);
    void this.pump();
    return { ...summary };
  }

  /** Web 决定:先到生效;冲突抛 StateConflictError 由 API 层变 409。
   * 多问题卡必须给 answers(问题→选项);单问题卡给 decision 即可。 */
  async decide(
    id: string,
    input: {
      state_version: number;
      decision?: string;
      answers?: Record<string, string>;
      notes?: string;
    },
  ): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const waiting = task.summary.waiting;
    if (task.summary.status !== "waiting_for_human" || !waiting) {
      throw new NotFoundError(`任务 ${id} 当前没有待人工决定`);
    }
    const answers = input.answers ?? {};
    const decision = String(
      input.decision ?? Object.values(answers).join("\n"));
    if (!decision.trim()) {
      throw new NotFoundError("决定不能为空:给 decision 或 answers");
    }
    const resolved = task.humanGate.resolve(waiting.waiting_id, {
      stateVersion: input.state_version,
      decision,
      answers: Object.keys(answers).length ? answers : undefined,
      notes: input.notes,
    });
    task.summary.status = "running";
    task.summary.waiting = undefined;
    void this.settle(task, task.driver!.resumeWithDecision(resolved));
    return { ...task.summary };
  }

  private async pump(): Promise<void> {
    const max = this.options.maxConcurrent ?? 2;
    while (this.runningCount < max && this.queue.length) {
      const id = this.queue.shift()!;
      const task = this.tasks.get(id)!;
      this.runningCount += 1;
      task.summary.status = "running";
      void this.launch(task).finally(() => {
        this.runningCount -= 1;
        void this.pump();
      });
    }
  }

  private async launch(task: TaskState): Promise<void> {
    const { workspace } = task.summary;
    try {
      const agentDir = join(workspace, "pi-agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify(this.options.modelsJson));
      const transcriptPath = join(workspace, "transcript.jsonl");
      let cwd = workspace;
      let prompt = task.summary.requirement;
      let hostHooks;
      task.cwd = cwd;
      if (this.options.host) {
        cwd = this.cloneRepo(workspace);
        task.cwd = cwd;
        const kernel = new KernelHost({
          kernelRoot: this.options.host.kernelRoot,
          workspace: cwd,
          transcriptPath,
          taskId: task.summary.id,
          python: this.options.host.python,
          log: this.options.log,
        });
        // 首条 prompt = 需求 + 内核自己的开工引导(转发壳/init 指引),
        // 不由云端复述内核该说的话。
        const guidance = await kernel.bootstrap(task.summary.requirement);
        prompt = guidance
          ? `${task.summary.requirement}\n\n${guidance}`
          : task.summary.requirement;
        hostHooks = {
          preTool: kernel.preTool.bind(kernel),
          postTool: kernel.postTool.bind(kernel),
        };
      }
      task.driver = await CloudSession.create({
        taskId: task.summary.id,
        workspace: cwd,
        agentDir,
        provider: this.options.provider,
        model: this.options.model,
        eventLog: new EventLog(join(workspace, "events.jsonl")),
        transcript: new TranscriptStore(transcriptPath, "main"),
        gate: new GateService({
          contract: this.options.contract,
          log: this.options.log,
        }),
        humanGate: task.humanGate,
        hostHooks,
        log: this.options.log,
      });
      await this.settle(task, task.driver.start(prompt));
    } catch (error) {
      task.summary.status = "failed";
      task.summary.detail = String(error);
      this.options.log?.(`任务 ${task.summary.id} 启动失败: ${String(error)}`);
    }
  }

  /** Git 交付(§10):任务收轮后,分支已推到远端才建 MR——交付事实
   * 全部来自远端真实状态(ls-remote),不信任务自己的说法。
   * MR 成功≠完成:流水线过了才"等待合入",否则停在"验证中"。
   * 交付失败不吞:原因写进 summary.delivery,任务保持 completed。 */
  private async tryDeliver(task: TaskState): Promise<void> {
    const delivery = this.options.delivery;
    if (!delivery || !this.options.host || !task.cwd) return;
    try {
      const statePath = join(task.cwd, ".mae-flow.json");
      if (!existsSync(statePath)) {
        task.summary.delivery = { skipped: "流程未初始化,无可交付" };
        return;
      }
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      const branch = String(state?.config?.["分支名"] ?? "");
      const baseline = String(state?.config?.["基线分支"] ?? "");
      if (!branch || !baseline) {
        task.summary.delivery = { skipped: "配置未确认,无分支可交付" };
        return;
      }
      const remote = spawnSync(
        "git", ["ls-remote", "--heads", "origin", branch],
        { cwd: task.cwd, encoding: "utf-8" });
      const line = (remote.stdout || "").trim();
      if (!line) {
        task.summary.delivery = {
          skipped: `分支 ${branch} 未推送到远端,流程停在 ${state.current}`,
        };
        return;
      }
      const sha = line.split(/\s+/)[0];
      const mr = await fetch(`${delivery.platformUrl}/mr`, {
        method: "POST",
        body: JSON.stringify({
          source_branch: branch,
          target_branch: baseline,
          title: `${state?.config?.["单号"] ?? branch}: ${task.summary.requirement.slice(0, 60)}`,
        }),
      }).then((r) => {
        if (!r.ok) throw new Error(`MR 创建失败 HTTP ${r.status}`);
        return r.json();
      });
      const run = await fetch(`${delivery.platformUrl}/pipeline/trigger`, {
        method: "POST", body: JSON.stringify({ sha }),
      }).then((r) => r.json());
      task.summary.delivery = {
        mr_url: mr.url,
        mr_state: run.status === "success" ? "等待合入" : "验证中",
        pipeline: run.status,
      };
      task.summary.status =
        run.status === "success" ? "await_merge" : "verifying";
    } catch (error) {
      task.summary.delivery = { skipped: `交付动作失败: ${String(error)}` };
      this.options.log?.(`任务 ${task.summary.id} 交付失败: ${String(error)}`);
    }
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
      }>;
    void notifier
      .notifyWaiting({
        waitingId: waiting.waiting_id,
        taskId: task.summary.id,
        account,
        step: waiting.step,
        summary: String(questions[0]?.question ?? "需要你确认"),
        link: `${this.options.linkBase ?? ""}/tasks/${task.summary.id}`,
      })
      .then((record) => {
        task.notifyRecord = record;
      });
  }

  /** 仓库进工作区:git 仓走 clone(历史/分支语义齐全),
   * 非 git 目录降级复制并剔除旧现场(.mae-flow-work 不跨任务串场)。 */
  private cloneRepo(workspace: string): string {
    const source = this.options.host!.repoPath;
    // 裸仓 origin.git → 工作区目录名去掉 .git 后缀,免得像个裸仓。
    const target = join(
      workspace, basename(source).replace(/\.git$/, "") || "repo");
    // 普通仓有 .git 子目录;裸仓自己就是 git 目录(HEAD+objects)。
    // 只认 .git 会把裸仓误判成普通目录,把仓库内脏拷贝成"工作区"(实测)。
    const isGit = existsSync(join(source, ".git"))
      || (existsSync(join(source, "HEAD"))
          && existsSync(join(source, "objects")));
    if (isGit) {
      const cloned = spawnSync(
        "git", ["clone", "--quiet", source, target], { encoding: "utf-8" });
      if (cloned.status !== 0) {
        throw new Error(`仓库克隆失败: ${cloned.stderr}`);
      }
    } else {
      cpSync(source, target, {
        recursive: true,
        filter: (path) => !path.includes(".mae-flow-work")
          && !path.endsWith(".mae-flow.json"),
      });
    }
    return target;
  }

  /** outcome → 任务状态。等待人工不占并发额度之外的资源,会话原地挂起。 */
  private async settle(
    task: TaskState,
    turn: Promise<Outcome>,
  ): Promise<void> {
    const outcome = await turn;
    switch (outcome.status) {
      case "waiting_for_human":
        task.summary.status = "waiting_for_human";
        task.summary.waiting = outcome.waiting;
        this.notifyWaiting(task);
        break;
      case "turn_finished":
        task.driver?.dispose();
        // 终态在交付判定之后才定:先标 completed 再改,轮询会撞见
        // 中间态(实测竞态)。交付把状态升为 verifying/await_merge,
        // 没交付动作时才落 completed。
        await this.tryDeliver(task);
        if (task.summary.status === "running") {
          task.summary.status = "completed";
        }
        break;
      case "session_ended":
        task.summary.status = "failed";
        task.summary.detail = outcome.detail ?? outcome.reason;
        task.driver?.dispose();
        break;
    }
  }
}

export class NotFoundError extends Error {}
