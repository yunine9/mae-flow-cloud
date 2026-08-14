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

import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  /** 审批链接的前缀(通知里带的 URL),如 http://host:port。 */
  linkBase?: string;
  log?: (message: string) => void;
}

interface TaskState {
  summary: TaskSummary;
  driver?: CloudSession;
  humanGate: HumanGate;
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
      if (this.options.host) {
        cwd = this.cloneRepo(workspace);
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
    const target = join(workspace, basename(source) || "repo");
    if (existsSync(join(source, ".git"))) {
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
        task.summary.status = "completed";
        task.driver?.dispose();
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
