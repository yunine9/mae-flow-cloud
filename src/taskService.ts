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
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { KernelHost } from "./kernelHost.ts";
import type { Notifier, NotifyRecord } from "./notifier.ts";
import { EventLog } from "./semanticEvents.ts";
import { TranscriptStore } from "./transcriptStore.ts";
import { GateService, type GateContract } from "./gateService.ts";
import { HumanGate, type WaitingRecord } from "./humanGate.ts";
import { CloudSession, type Outcome } from "./sessionDriver.ts";
import { TaskContainer } from "./containerRuntime.ts";
import type { ExternalAction, PgProjection } from "./projection.ts";

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
  /** Git 交付事实(§10):MR 链接/状态、流水线结果、或没交付的原因。
   * sha = 流水线绑定的代码版本,也是重启后续轮的锚。 */
  delivery?: {
    mr_url?: string;
    mr_state?: string;
    pipeline?: string;
    sha?: string;
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
   * 配了它,任务收轮后由服务账号建 MR + 触发权威流水线。
   * 真实流水线是异步的:触发后 running,由带预算的轮询收敛
   * (poll* 两个旋钮给测试和内网调参;预算耗尽留痕请人工,不卡死)。 */
  delivery?: {
    platformUrl: string;
    pollIntervalMs?: number;
    pollTimeoutMs?: number;
  };
  /** 审批链接的前缀(通知里带的 URL),如 http://host:port。 */
  linkBase?: string;
  /** PostgreSQL 投影(主 spec §11):看板/审计/恢复引导的读侧。
   * 纯旁路——写失败不改流程,不配则一切照旧(文件即真相)。 */
  projection?: PgProjection;
  /** 容器隔离(设计文档):bash 命令进任务专属容器执行,镜像按
   * 试点仓选。容器起不来任务如实 failed,不静默降级回宿主。
   * volumes = 额外挂载(构建缓存等),"宿主:容器" 形状;
   * memory/cpus/user = 资源限额与身份映射,不配即不限。 */
  isolation?: {
    image: string;
    volumes?: string[];
    memory?: string;
    cpus?: string;
    user?: string;
  };
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
  /** 催办账本:上次催办时内核停在哪一步 + 累计次数。
   * 同一步催过没动弹就不再催(催办只对"忘了继续"有效,
   * 对"推不动"无效);累计上限防对话式空转。 */
  nudgedStep?: string;
  nudgeCount?: number;
  /** 任务专属容器(隔离模式):随任务起,随收口停。 */
  container?: TaskContainer;
  /** 恢复标记:launch 走重建会话路径(不重克隆、内核 current 续跑)。 */
  resume?: boolean;
  /** 恢复期收到的人工决定:重建会话就绪后由 driver 补登记再续跑。 */
  pendingResume?: WaitingRecord;
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

  /** 内核现场面板文件(panel.html / panel-pulse.js / panel-stamp.js)。
   * 名字白名单由路由把守,这里只按任务工作区定位;不存在返回 undefined。 */
  panelFile(id: string, name: string): string | undefined {
    const task = this.tasks.get(id);
    if (!task?.cwd) return undefined;
    const file = join(task.cwd, ".mae-flow-work", name);
    return existsSync(file) ? file : undefined;
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
    const task: TaskState = {
      summary,
      humanGate: new HumanGate(join(workspace, "waiting.json")),
    };
    this.tasks.set(id, task);
    this.persist(task);
    this.queue.push(id);
    void this.pump();
    return { ...summary };
  }

  /** 任务事实落盘(原子写):进程可死,任务不能死。
   * summary+cwd 就是重启后重建 TaskState 需要的全部——待办在
   * waiting.json、事件在 events.jsonl、流程真相在内核状态文件。 */
  private persist(task: TaskState): void {
    try {
      const path = join(task.summary.workspace, "task.json");
      writeFileSync(path + ".tmp", JSON.stringify(
        { summary: task.summary, cwd: task.cwd }, null, 1));
      renameSync(path + ".tmp", path);
    } catch (error) {
      this.options.log?.(`任务 ${task.summary.id} 落盘失败: ${String(error)}`);
    }
    // 文件先落袋(它才是真相),投影旁路跟进;失败由投影自己 fail-open。
    void this.options.projection?.upsertTask(this.project(task));
  }

  /** 服务重启后恢复任务(服务启动时调用一次):
   * - 终态任务(completed/failed/verifying/await_merge)只重建索引;
   * - waiting_for_human 原地挂起,决定到来时走重建会话续跑;
   * - 崩溃时在跑/在排队的任务重新入队,以内核 current 为锚续跑。 */
  recover(): { restored: number; requeued: number } {
    let restored = 0;
    let requeued = 0;
    if (!existsSync(this.options.dataDir)) return { restored, requeued };
    for (const name of readdirSync(this.options.dataDir).sort()) {
      const workspace = join(this.options.dataDir, name);
      const path = join(workspace, "task.json");
      if (!/^task-\d+$/.test(name) || !existsSync(path)
          || this.tasks.has(name)) {
        continue;
      }
      try {
        const saved = JSON.parse(readFileSync(path, "utf-8"));
        const summary = saved.summary as TaskSummary;
        const task: TaskState = {
          summary,
          humanGate: new HumanGate(join(workspace, "waiting.json")),
          cwd: typeof saved.cwd === "string" ? saved.cwd : undefined,
          resume: true,
        };
        this.tasks.set(summary.id, task);
        this.counter = Math.max(
          this.counter, Number(name.slice("task-".length)) || 0);
        restored += 1;
        this.replayProjection(task);
        // 进程可死,轮询不死:重启前在等流水线的任务续轮
        // (锚是 delivery.sha,结果仍只认绑定版本)。
        if (summary.status === "verifying"
            && summary.delivery?.pipeline === "running") {
          void this.pollPipeline(task);
        }
        if (summary.status === "running" || summary.status === "queued") {
          summary.status = "queued";
          summary.detail = "服务重启,等待续跑";
          this.persist(task);
          this.queue.push(summary.id);
          requeued += 1;
        }
      } catch (error) {
        this.options.log?.(`恢复 ${name} 失败: ${String(error)}`);
      }
    }
    if (requeued) void this.pump();
    return { restored, requeued };
  }

  /** 恢复重放投影(§11):以现场文件为源补齐读侧——摘要整行覆盖,
   * 事件副本重灌((taskId,eventId) 幂等锚把重复兜成 no-op)。
   * 现场文件损坏只影响投影补齐,不影响任务恢复本身。 */
  private replayProjection(task: TaskState): void {
    const projection = this.options.projection;
    if (!projection) return;
    void projection.upsertTask(this.project(task));
    try {
      const log = new EventLog(
        join(task.summary.workspace, "events.jsonl"));
      for (const event of log.replay()) {
        void projection.appendEvent(event);
      }
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 投影重放失败: ${String(error)}`);
    }
  }

  /** 重跑一单:completed/failed 的任务重新入队,host 模式以内核
   * current 为锚续跑。用于环境修复后续推(run7-resume 实测:容器
   * 被并行实例误杀,整单被迫收口,内核还停在 verify_ut——环境
   * 修好后流程应当接着推,而不是从头再来)。 */
  retry(id: string): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (!["completed", "failed"].includes(task.summary.status)) {
      throw new NotFoundError(
        `任务 ${id} 状态是 ${task.summary.status},只有 completed/failed 可重跑`);
    }
    task.summary.status = "queued";
    task.summary.detail = "人工重跑,续接内核当前步骤";
    task.resume = true;
    this.persist(task);
    this.queue.push(id);
    void this.pump();
    return { ...task.summary };
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
    task.summary.waiting = undefined;
    if (task.driver) {
      task.summary.status = "running";
      this.persist(task);
      void this.settle(task, task.driver.resumeWithDecision(resolved));
    } else {
      // 恢复场景:旧会话死于服务重启,决定先落袋(waiting.json 已
      // resolved),任务入队走重建会话——launch 会补登记这份决定。
      task.summary.status = "queued";
      task.summary.detail = "决定已收到,等待重建会话续跑";
      task.pendingResume = resolved;
      task.resume = true;
      this.persist(task);
      this.queue.push(task.summary.id);
      void this.pump();
    }
    return { ...task.summary };
  }

  private async pump(): Promise<void> {
    const max = this.options.maxConcurrent ?? 2;
    while (this.runningCount < max && this.queue.length) {
      const id = this.queue.shift()!;
      const task = this.tasks.get(id)!;
      this.runningCount += 1;
      task.summary.status = "running";
      this.persist(task);
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
      // 恢复=工作区(仓库克隆)还在;克隆丢了就只能从头来。
      // savedCwd 必须先落袋:下面 task.cwd 会被暂写成 workspace,
      // 晚一步读就是把重建会话跑进任务根目录(实测:内核找不到
      // 状态文件,messages 报"未初始化")。
      const savedCwd = task.cwd;
      const resuming = task.resume === true
        && !!savedCwd && savedCwd !== workspace && existsSync(savedCwd);
      let cwd = workspace;
      let prompt = task.summary.requirement;
      let hostHooks;
      task.cwd = cwd;
      if (this.options.host) {
        cwd = resuming ? savedCwd! : this.cloneRepo(workspace);
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
        // 不由云端复述内核该说的话。重启后的 sessionstart 对内核是
        // 常态(老宿主重启会话同款),ACTIVE 状态下引导即当前步指引。
        const guidance = await kernel.bootstrap(task.summary.requirement);
        prompt = guidance
          ? `${task.summary.requirement}\n\n${guidance}`
          : task.summary.requirement;
        if (resuming) {
          prompt = [
            guidance,
            "云端服务重启,本会话为重建会话:此前对话不在上下文里," +
            "流程真相以内核状态为准。执行 current 查看当前步骤;" +
            "此前向用户的提问均已答复并录入台账(执行 messages 查看)," +
            "不要重复提问;继续推进直到流程 end。",
          ].filter(Boolean).join("\n\n");
        }
        hostHooks = {
          preTool: kernel.preTool.bind(kernel),
          postTool: kernel.postTool.bind(kernel),
        };
      } else if (resuming || task.resume) {
        prompt = `服务重启,继续任务:${task.summary.requirement}`;
      }
      // 容器隔离:bash 进任务专属容器(工作区同路径挂载),
      // 起不来直接抛=任务 failed——静默降级回宿主是假隔离。
      if (this.options.isolation) {
        const { image, volumes, memory, cpus, user } = this.options.isolation;
        // 容器名带数据目录指纹:同 dataDir 重启后同名(孤儿可清扫),
        // 不同实例(测试与试跑并行)绝不同名——只按任务 id 命名时,
        // 另一实例的 rm -f 会把这边活着的容器当孤儿误杀(实测:
        // run7 续跑期间并行跑隔离测试,容器被杀,模型如实报告
        // "执行容器丢失",整单被迫收口)。
        const instance = createHash("sha256")
          .update(this.options.dataDir).digest("hex").slice(0, 6);
        // host 模式的两条硬依赖也要进容器:内核插件根(转发壳硬编码
        // 其绝对路径,只读)与 Git 远端(裸仓是文件路径,push 要写)。
        const hostMounts = this.options.host
          ? [
              `${this.options.host.kernelRoot}:${this.options.host.kernelRoot}:ro`,
              `${this.options.host.repoPath}:${this.options.host.repoPath}`,
            ]
          : [];
        task.container = new TaskContainer(
          image, cwd, `mfc-${instance}-${task.summary.id}`,
          this.options.log,
          [...hostMounts, ...(volumes ?? [])], { memory, cpus, user });
        await task.container.start();
      }
      task.driver = await CloudSession.create({
        taskId: task.summary.id,
        workspace: cwd,
        agentDir,
        provider: this.options.provider,
        model: this.options.model,
        eventLog: new EventLog(
          join(workspace, "events.jsonl"),
          (event) => void this.options.projection?.appendEvent(event)),
        transcript: new TranscriptStore(transcriptPath, "main"),
        gate: new GateService({
          contract: this.options.contract,
          log: this.options.log,
        }),
        humanGate: task.humanGate,
        hostHooks,
        bashOperations: task.container
          ? {
              exec: (command, dir, execOptions) =>
                task.container!.exec(command, dir, execOptions),
            }
          : undefined,
        log: this.options.log,
      });
      // 重建会话:恢复期收到的决定先补登记(tool_result 与崩溃前的
      // tool_use 行 join,答案进内核台账),再从内核 current 续跑。
      // 内核模式下克隆丢失=现场没了,决定无处可注,只能从头来。
      const rebuild = task.resume === true
        && (resuming || !this.options.host);
      const pending = task.pendingResume;
      task.resume = false;
      task.pendingResume = undefined;
      if (rebuild && pending) {
        task.driver.injectDecision(pending);
      } else if (pending) {
        this.options.log?.(
          `任务 ${task.summary.id} 工作区丢失,决定无法回注,从头执行`);
      }
      await this.settle(task, rebuild
        ? task.driver.startResume(prompt)
        : task.driver.start(prompt));
    } catch (error) {
      task.summary.status = "failed";
      task.summary.detail = String(error);
      void task.container?.stop();
      this.persist(task);
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
      // 外部动作台账(§11):请求先落一行(带幂等键),结果回来再补
      // 结果侧——恢复时"先查远端真实状态"就有底账可对。纯旁路。
      const ledger = (action: Omit<ExternalAction, "taskId">) =>
        void this.options.projection?.recordAction(
          { taskId: task.summary.id, ...action });
      const mrRequest = {
        source_branch: branch,
        target_branch: baseline,
        title: `${state?.config?.["单号"] ?? branch}: ${task.summary.requirement.slice(0, 60)}`,
      };
      const mrKey = `mr:${branch}->${baseline}`;
      const mrStarted = new Date().toISOString();
      ledger({ idemKey: mrKey, kind: "mr_create", request: mrRequest,
               sha, startedAt: mrStarted });
      const mr = await fetch(`${delivery.platformUrl}/mr`, {
        method: "POST",
        body: JSON.stringify(mrRequest),
      }).then((r) => {
        if (!r.ok) throw new Error(`MR 创建失败 HTTP ${r.status}`);
        return r.json();
      });
      ledger({ idemKey: mrKey, kind: "mr_create", request: mrRequest,
               sha, startedAt: mrStarted, result: mr,
               finishedAt: new Date().toISOString() });
      const runKey = `pipeline:${sha}`;
      const runStarted = new Date().toISOString();
      ledger({ idemKey: runKey, kind: "pipeline_trigger",
               request: { sha }, sha, startedAt: runStarted });
      const run = await fetch(`${delivery.platformUrl}/pipeline/trigger`, {
        method: "POST", body: JSON.stringify({ sha }),
      }).then((r) => r.json());
      ledger({ idemKey: runKey, kind: "pipeline_trigger",
               request: { sha }, sha, startedAt: runStarted, result: run,
               finishedAt: new Date().toISOString() });
      task.summary.delivery = {
        mr_url: mr.url,
        mr_state: run.status === "success" ? "等待合入" : "验证中",
        pipeline: run.status,
        sha,
      };
      task.summary.status =
        run.status === "success" ? "await_merge" : "verifying";
      // 真实平台的流水线是异步的:running 不是结局,由带预算的
      // 轮询收敛到 绿→等待合入 / 红→验证中留痕。
      if (run.status === "running") void this.pollPipeline(task);
    } catch (error) {
      task.summary.delivery = { skipped: `交付动作失败: ${String(error)}` };
      this.options.log?.(`任务 ${task.summary.id} 交付失败: ${String(error)}`);
    }
  }

  /** 流水线异步收敛:轮询 status?sha= 直到终态或预算耗尽。
   * - 结果只认绑定 SHA 的运行(旧绿灯不背书新代码);
   * - 查询失败 fail-open 继续轮,预算兜底——绝不无限等(红线);
   * - 预算耗尽留痕请人工,任务停在 verifying,不假装有结论;
   * - 终态落袋:状态/台账/通知一次收口,幂等锚是任务当前状态。 */
  private async pollPipeline(task: TaskState): Promise<void> {
    const delivery = this.options.delivery;
    const sha = task.summary.delivery?.sha;
    if (!delivery || !sha) return;
    const interval = delivery.pollIntervalMs ?? 10_000;
    const deadline = Date.now() + (delivery.pollTimeoutMs ?? 30 * 60_000);
    while (Date.now() < deadline) {
      // unref:轮询是旁路,不许它吊着进程不退(进程要退就让它退,
      // 重启后 recover 会以 delivery.sha 为锚续轮)。
      await new Promise((tick) => setTimeout(tick, interval).unref());
      if (task.summary.status !== "verifying") return; // 已被别处推进
      let terminal;
      try {
        const status = await fetch(
          `${delivery.platformUrl}/pipeline/status?sha=${sha}`)
          .then((r) => r.json());
        terminal = (status.runs ?? []).findLast(
          (run: { status?: string }) =>
            run.status === "success" || run.status === "failed");
      } catch (error) {
        this.options.log?.(
          `任务 ${task.summary.id} 流水线查询失败(继续轮): ${String(error)}`);
        continue;
      }
      if (!terminal) continue;
      task.summary.delivery = {
        ...task.summary.delivery,
        pipeline: terminal.status,
        mr_state: terminal.status === "success" ? "等待合入" : "验证中",
      };
      if (terminal.status === "success") {
        task.summary.status = "await_merge";
      }
      this.persist(task);
      this.notifyOutcome(task);
      void this.options.projection?.recordAction({
        taskId: task.summary.id,
        idemKey: `pipeline:${sha}`,
        kind: "pipeline_trigger",
        request: { sha },
        result: terminal,
        sha,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      return;
    }
    if (task.summary.status !== "verifying") return;
    task.summary.delivery = {
      ...task.summary.delivery,
      pipeline: "running(轮询预算耗尽,请人工查看流水线)",
    };
    this.persist(task);
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

  /** 任务收口 → 小鲁班(说人话)。语义同待办通知:失败不改流程,
   * 同任务同状态幂等。没配通知器或没填账号静默跳过。 */
  private notifyOutcome(task: TaskState): void {
    const { notifier } = this.options;
    const account = task.summary.luban_account;
    if (!notifier || !account) return;
    const { status, delivery, detail, id } = task.summary;
    const text: Record<string, string> = {
      await_merge: `已提合入请求,流水线通过,等待合入`
        + (delivery?.mr_url ? `:${delivery.mr_url}` : ""),
      verifying: "代码已提交,流水线验证中",
      completed: "已完成"
        + (delivery?.skipped ? `(${delivery.skipped})` : ""),
      failed: `出错了:${detail || "原因见任务页"}`,
    };
    if (!text[status]) return;
    void notifier.notifyOutcome({
      taskId: id,
      account,
      status,
      summary: text[status],
      link: `${this.options.linkBase ?? ""}/tasks/${id}`,
    });
  }

  /** 内核视角的"流程还没走完":current 不是 end;状态文件不存在=
   * 连 init 都没走(run4 实测:空转回合把未 init 的任务标成 completed),
   * 同样算卡壳。非内核模式(无 host)不判——演练剧本自己收口。 */
  private stalledStep(task: TaskState): string | undefined {
    if (!this.options.host || !task.cwd) return undefined;
    try {
      const statePath = join(task.cwd, ".mae-flow.json");
      if (!existsSync(statePath)) return "init(尚未初始化)";
      const current = String(
        JSON.parse(readFileSync(statePath, "utf-8"))?.current ?? "");
      return current && current !== "end" ? current : undefined;
    } catch {
      return undefined;
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
        // 人工节点=流程真实活动,催办账本清零:答复之后若再停在
        // 同名步骤,那是新一次卡壳,应当再催。
        task.nudgedStep = undefined;
        this.persist(task);
        this.notifyWaiting(task);
        break;
      case "turn_finished": {
        // 回合结束≠流程走完:模型可能提前收嘴(run3 实测停在
        // delivery_review)。内核 current 不在终态且催办还有效时,
        // 同一会话催办续跑,而不是把半截流程标成 completed。
        const stalled = this.stalledStep(task);
        if (stalled && task.driver
            && task.nudgedStep !== stalled
            && (task.nudgeCount ?? 0) < 5) {
          task.nudgedStep = stalled;
          task.nudgeCount = (task.nudgeCount ?? 0) + 1;
          this.options.log?.(
            `任务 ${task.summary.id} 催办续跑(流程停在 ${stalled})`);
          await this.settle(task, task.driver.continueWith(
            `流程尚未走完:内核当前步骤是 ${stalled},不是 end。` +
            `尚未 init 就按开工引导先执行 init;否则执行 current ` +
            `查看本步指引并继续,直到流程 end。` +
            `已答复过的确认项不要重复提问。`));
          break;
        }
        task.driver?.dispose();
        void task.container?.stop();
        // 终态在交付判定之后才定:先标 completed 再改,轮询会撞见
        // 中间态(实测竞态)。交付把状态升为 verifying/await_merge,
        // 没交付动作时才落 completed。
        await this.tryDeliver(task);
        if (task.summary.status === "running") {
          task.summary.status = "completed";
        }
        this.persist(task);
        this.notifyOutcome(task);
        break;
      }
      case "session_ended":
        task.summary.status = "failed";
        task.summary.detail = outcome.detail ?? outcome.reason;
        task.driver?.dispose();
        void task.container?.stop();
        this.persist(task);
        this.notifyOutcome(task);
        break;
    }
  }
}

export class NotFoundError extends Error {}
