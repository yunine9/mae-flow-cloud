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

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
}

export interface TaskServiceOptions {
  dataDir: string;
  provider: string;
  model: string;
  /** 每个任务 agent 目录的 models.json 内容(生产=GLM 网关,演练=剧本假模型)。 */
  modelsJson: Record<string, unknown>;
  maxConcurrent?: number;
  contract?: GateContract;
  log?: (message: string) => void;
}

interface TaskState {
  summary: TaskSummary;
  driver?: CloudSession;
  humanGate: HumanGate;
}

export class TaskService {
  private tasks = new Map<string, TaskState>();
  private runningCount = 0;
  private queue: string[] = [];
  private counter = 0;

  constructor(readonly options: TaskServiceOptions) {}

  list(): TaskSummary[] {
    return [...this.tasks.values()]
      .map((task) => ({ ...task.summary }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  get(id: string): TaskSummary | undefined {
    const task = this.tasks.get(id);
    return task ? { ...task.summary } : undefined;
  }

  eventLogPath(id: string): string {
    return join(this.tasks.get(id)!.summary.workspace, "events.jsonl");
  }

  create(requirement: string): TaskSummary {
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
    };
    this.tasks.set(id, {
      summary,
      humanGate: new HumanGate(join(workspace, "waiting.json")),
    });
    this.queue.push(id);
    void this.pump();
    return { ...summary };
  }

  /** Web 决定:先到生效;冲突抛 StateConflictError 由 API 层变 409。 */
  async decide(
    id: string,
    input: { state_version: number; decision: string; notes?: string },
  ): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const waiting = task.summary.waiting;
    if (task.summary.status !== "waiting_for_human" || !waiting) {
      throw new NotFoundError(`任务 ${id} 当前没有待人工决定`);
    }
    const resolved = task.humanGate.resolve(waiting.waiting_id, {
      stateVersion: input.state_version,
      decision: input.decision,
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
      task.driver = await CloudSession.create({
        taskId: task.summary.id,
        workspace,
        agentDir,
        provider: this.options.provider,
        model: this.options.model,
        eventLog: new EventLog(join(workspace, "events.jsonl")),
        transcript: new TranscriptStore(
          join(workspace, "transcript.jsonl"), "main"),
        gate: new GateService({
          contract: this.options.contract,
          log: this.options.log,
        }),
        humanGate: task.humanGate,
        log: this.options.log,
      });
      await this.settle(task, task.driver.start(task.summary.requirement));
    } catch (error) {
      task.summary.status = "failed";
      task.summary.detail = String(error);
      this.options.log?.(`任务 ${task.summary.id} 启动失败: ${String(error)}`);
    }
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
