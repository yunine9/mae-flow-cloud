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
import { basename, dirname, join } from "node:path";
import {
  AnnotationStore,
  reanchor,
  renderAnnotations,
  type Annotation,
  type AnchorCheck,
  type AnnotationInput,
  type SentVia,
} from "./annotations.ts";
import { readArtifact, resolveArtifactRoot } from "./artifacts.ts";
import { KernelHost } from "./kernelHost.ts";
import type { Notifier, NotifyRecord } from "./notifier.ts";
import { EventLog } from "./semanticEvents.ts";
import { TranscriptStore } from "./transcriptStore.ts";
import { GateService, type GateContract } from "./gateService.ts";
import { HumanGate, renderDecision, type WaitingRecord } from "./humanGate.ts";
import { CloudSession, type Outcome } from "./sessionDriver.ts";
import { TaskContainer } from "./containerRuntime.ts";
import type { ExternalAction, PgProjection } from "./projection.ts";
import type { RuntimeSettings } from "./settings.ts";

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_for_human"
  | "completed"
  | "verifying"      // MR 已建,权威流水线未过(主 spec §10:不能标完成)
  | "await_merge"    // 流水线通过,等待人工合入;系统不自动合并
  | "failed";

export interface TaskProgress {
  /** 与内核现场看板同源的展示阶段；这里只镜像，不参与流程判定。 */
  phases: string[];
  current_index: number;
  current_phase: string;
  step?: string;
  revision?: number;
}

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
    /** 修复环账本(小状态机):流水线直至全绿是最终目标(用户拍板)。
     * 红灯→专职修复会话→推新提交→新流水线,循环受 max 预算约束;
     * last_sha 防"没产生新提交还烧一轮"。全部是事实记账,页面可见。 */
    loop?: {
      round: number;
      max: number;
      state: "repairing" | "green" | "exhausted" | "halted";
      failure?: string;
      last_sha?: string;
    };
  };
  /** 从现场看板的 panel-pulse.js/panel.html 读取的进度摘要。 */
  progress?: TaskProgress;
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
    /** 流水线红灯的修复轮预算(默认 2;0 = 关掉修复环,红灯即留痕请人工)。
     * 每轮 = 一次专职修复会话 + 一次新流水线;耗尽如实停在 verifying。 */
    repairRounds?: number;
  };
  /** 审批链接的前缀(通知里带的 URL),如 http://host:port。 */
  linkBase?: string;
  /** PostgreSQL 投影(主 spec §11):看板/审计/恢复引导的读侧。
   * 纯旁路——写失败不改流程,不配则一切照旧(文件即真相)。 */
  projection?: PgProjection;
  /** 主动压缩节奏:事件量每涨这么多,在下一个回合间隙以内核锚点
   * 压缩会话(0 = 关)。被动保底(pi 自动压缩)始终开着,这里是
   * "注意力不许飘"的主动档。 */
  compactEveryEvents?: number;
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
  /** 本地不做编译/UT,流水线是唯一裁判(用户拍板:"先不编译了,直接上
   * 流水线";"慢点就慢点,反正人也不需要介入")。宿主没有构建链时,
   * 让 agent 在本机撞编译只会烧轮次;云端台账门禁已放开,done 不拦。
   * 这个旗子做的唯一一件事:把环境事实写进每次会话的开场,别让模型猜。
   * 慢的代价由修复环扛(红灯自动派修复会话),不占人的时间。 */
  verifyViaPipeline?: boolean;
  /** 运行时设置覆盖(管理页):并发/修复轮/轮询/通知/模型网关。
   * 部署配置是底,这层是热改;各消费点即时读,生效边界见 settings.ts。 */
  settings?: RuntimeSettings;
  log?: (message: string) => void;
}

/** 小鲁班链接必须落到个人处置台，而不是 /tasks/:id 的 JSON API。
 * account 让无登录态的内网 MVP 也能直接筛出本人任务，task 用于
 * 自动定位并展开目标卡；二者只承载展示定位，不参与任务判定。 */
function personalTaskLink(
  linkBase: string | undefined,
  account: string,
  taskId: string,
): string {
  const root = (linkBase ?? "").replace(/\/+$/, "");
  return `${root}/?account=${encodeURIComponent(account)}`
    + `&task=${encodeURIComponent(taskId)}`;
}

/** 重启前发出、但很可能没送到模型的插话。
 *
 * 插话走 pi 的 steer,消息压在**进程内存**队列里,进程一死就没了;事件
 * 日志是唯一跨进程活下来的账。判据很朴素:最后一次 turn_finished 之后
 * 出现的插话,还没有任何一个回合消化过它。
 *
 * 取舍写在明处:回合跑到一半被杀时,已经送进上下文的那条也会被算成
 * "没送到",于是重建会话里出现两遍。**宁可重复也不能吞掉**——重复顶多
 * 让模型多确认一句,吞掉则是人说过的话凭空消失。
 *
 * 读不动就当没有(旁路一律 fail-open,绝不能挡住任务重建)。
 */
function undeliveredInterrupts(workspace: string): string[] {
  try {
    const events = new EventLog(join(workspace, "events.jsonl")).replay();
    let since = -1;
    events.forEach((event, at) => {
      if (event.kind === "turn_finished") since = at;
    });
    return events.slice(since + 1)
      .filter((event) => event.kind === "user_message"
        && event.payload?.via === "interrupt")
      .map((event) => String(event.payload?.text ?? ""))
      .filter(Boolean);
  } catch {
    return [];
  }
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
  /** 上次主动压缩时的事件水位(事件量是上下文增长的诚实代理)。 */
  lastCompactAt?: number;
  /** 恢复标记:launch 走重建会话路径(不重克隆、内核 current 续跑)。 */
  resume?: boolean;
  /** 恢复期收到的人工决定:重建会话就绪后由 driver 补登记再续跑。 */
  pendingResume?: WaitingRecord;
  /** 专项使命(修复环):下次会话的压轴指令,消费即清。
   * 要随 task.json 落盘——修复会话跑一半被重启,使命不能丢。 */
  mission?: string;
  /** 避免列表轮询反复解析未变化的现场面板。 */
  progressPulse?: string;
  progressCache?: TaskProgress;
}

export class TaskService {
  private tasks = new Map<string, TaskState>();
  private runningCount = 0;
  private queue: string[] = [];
  private counter = 0;

  constructor(readonly options: TaskServiceOptions) {
    // 桌面通知只有 serve --desktop-notify 显式要了才开(它会设
    // MAE_FLOW_DESKTOP_NOTIFY);其余一切宿主进程——测试、probe、pilot——
    // 一律静音。少了这道闸,npm test 拉起真内核当裁判时会把用户的 mac
    // 弹一串"需要你确认"(实锤弹过);环境变量随子进程继承,一处设置全链生效。
    if (!process.env.MAE_FLOW_DESKTOP_NOTIFY) {
      process.env.MAE_FLOW_NO_NOTIFY ??= "1";
    }
  }

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
      progress: this.readProgress(task),
    };
  }

  /** 列表里的阶段轨道必须与现场看板同源，不能在 Web 复刻状态机。
   * pulse 给当前阶段/步骤，panel.html 给阶段顺序；pulse 未变化就复用缓存。 */
  private readProgress(task: TaskState): TaskProgress | undefined {
    if (!task.cwd) return undefined;
    const pulsePath = join(task.cwd, ".mae-flow-work", "panel-pulse.js");
    const panelPath = join(task.cwd, ".mae-flow-work", "panel.html");
    if (!existsSync(pulsePath) || !existsSync(panelPath)) return undefined;
    try {
      const pulseText = readFileSync(pulsePath, "utf-8");
      if (pulseText === task.progressPulse) return task.progressCache;
      const first = pulseText.indexOf("{");
      const last = pulseText.lastIndexOf("}");
      if (first < 0 || last <= first) return undefined;
      const pulse = JSON.parse(pulseText.slice(first, last + 1));
      const html = readFileSync(panelPath, "utf-8");
      const nodes = [...html.matchAll(
        /<span class="phase-node\s+(past|current|future)">([^<]+)<\/span>/g,
      )];
      const phases = nodes.map((match) => match[2].trim());
      const currentByClass = nodes.findIndex((match) => match[1] === "current");
      const currentPhase = String(pulse.phase ?? "").trim();
      const currentIndex = currentByClass >= 0
        ? currentByClass : phases.indexOf(currentPhase);
      if (phases.length === 0 || currentIndex < 0) return undefined;
      const progress: TaskProgress = {
        phases,
        current_index: currentIndex,
        current_phase: currentPhase || phases[currentIndex],
        step: pulse.step_title ? String(pulse.step_title) : undefined,
        revision: Number.isFinite(Number(pulse.revision))
          ? Number(pulse.revision) : undefined,
      };
      task.progressPulse = pulseText;
      task.progressCache = progress;
      return progress;
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 进度摘要读取失败: ${String(error)}`);
      return undefined;
    }
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

  /** 检视产物的根:与 /artifacts 路由同一口径——批注重锚定回头读的
   * 必须是人当初圈的那份材料,两处口径分家就会出现"页面上有、重锚定
   * 说没有"。 */
  artifactRoot(id: string): string | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const panel = this.panelFile(id, "panel.html")
      ?? this.panelFile(id, "panel-pulse.js");
    return resolveArtifactRoot(
      task.summary.workspace, panel ? dirname(dirname(panel)) : undefined);
  }

  private annotations(task: TaskState): AnnotationStore {
    return new AnnotationStore(
      join(task.summary.workspace, "annotations.jsonl"));
  }

  /** 单号来自内核状态文件;拿不到就退回任务号——不为抬头编内容。 */
  private ticketOf(task: TaskState): string {
    try {
      const statePath = join(task.cwd ?? "", ".mae-flow.json");
      if (task.cwd && existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        const ticket = String(state?.config?.["单号"] ?? "").trim();
        if (ticket) return ticket;
      }
    } catch {
      // 读不到就用任务号,批注照样送得出去。
    }
    return task.summary.id;
  }

  /** 批注清单(草稿 + 已送出)+ 每条的锚点现状。
   *
   * 已送出的不下架:人得看得见"这条提过没有、它动了没有"。而"动了没有"
   * 我们只报事实不下结论——锚点原文还在原处,就是它还没碰这里;原文不见
   * 了,就是这处已经被改动。是不是**照你说的**改的,由你看了再说,系统
   * 不替你判断"已采纳"(那是推断,不是事实)。
   *
   * 锚点检查是旁路:读不到材料按"还在"放行,绝不因为它挡住人送意见。
   */
  listAnnotations(id: string): {
    items: Annotation[];
    checks: AnchorCheck[];
    reply?: { texts: string[]; truncated: boolean };
  } {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const items = this.annotations(task).visible();
    const root = this.artifactRoot(id);
    const checks = reanchor(items, (artifact) =>
      root ? readArtifact(root, artifact)?.content : undefined);
    return { items, checks, reply: this.annotationReply(task, items) };
  }

  /** 最后一批批注送出之后,主会话 AI 说过的话——原样带给面板。
   *
   * 刻意不做逐条对应:从自由文本里猜"第几段对应第几条",配错了就把
   * "AI 不同意"错挂到别的批注上,比不显示更害人(与"不推断已采纳"同根)。
   * 用户拍板走轻的:"就把 ai 的话展示出来就行",对不对应人自己看。 */
  private annotationReply(
    task: TaskState,
    items: Annotation[],
  ): { texts: string[]; truncated: boolean } | undefined {
    const sentTimes = items
      .map((item) => item.sent_at ? +new Date(item.sent_at) : NaN)
      .filter((at) => Number.isFinite(at));
    if (!sentTimes.length) return undefined;
    const lastSent = Math.max(...sentTimes);
    try {
      // 事件 ts 是去掉 T/Z 的 UTC 裸串(sessionDriver 的 toISOString 截断),
      // 直接 new Date() 会按本地时区解析——差 8 小时,所有回话都被误判成
      // 发生在送出之前。补回 Z 按 UTC 读。
      const utc = (ts: unknown) =>
        +new Date(String(ts ?? "").replace(" ", "T") + "Z");
      const texts = new EventLog(join(task.summary.workspace, "events.jsonl"))
        .replay()
        .filter((event) => event.kind === "assistant_message"
          && String(event.sessionId ?? "main") === "main"
          && utc(event.ts) > lastSent)
        .map((event) => String(event.payload?.text ?? "").trim())
        .filter(Boolean);
      if (!texts.length) return undefined;
      // 面板不是会话流,给个够看的量就好;截了要说,别装完整。
      const kept = texts.slice(0, 8)
        .map((text) => text.length > 1500 ? text.slice(0, 1500) + "…" : text);
      return {
        texts: kept,
        truncated: texts.length > 8
          || texts.slice(0, 8).some((text) => text.length > 1500),
      };
    } catch {
      return undefined;   // 读不动就不带:旁路绝不挡住清单本身
    }
  }

  /** 发过的插话 + 送达与否。
   *
   * "我发了然后就没了,咋知道它消费了没"——发出去没有回执,等于让人对着
   * 空气说话。送达是可观测的:pi 把消息移出 steering 队列的那一刻,就是
   * 它进入模型上下文的那一刻。这里只报这个事实,不替人判断"它照做了没"
   * ——那要看它后面干了什么,判断权是人的。 */
  listInterrupts(id: string): Array<{ text: string; at: string; delivered: boolean }> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const pending = new Set(task.driver?.pendingSteers() ?? []);
    try {
      return new EventLog(join(task.summary.workspace, "events.jsonl"))
        .replay()
        .filter((event) => event.kind === "user_message"
          && event.payload?.via === "interrupt")
        .map((event) => ({
          text: String(event.payload?.text ?? ""),
          at: String(event.ts ?? ""),
          delivered: !pending.has(String(event.payload?.text ?? "")),
        }));
    } catch {
      return [];      // 读不动就当没有:旁路绝不挡住页面
    }
  }

  addAnnotation(id: string, input: AnnotationInput): Annotation {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    return this.annotations(task).add(input);
  }

  dropAnnotation(id: string, annotationId: string, by: string): Annotation {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    return this.annotations(task).drop(annotationId, by);
  }

  /** 检视闭环的裁决半边:确认通过。 */
  verifyAnnotation(id: string, annotationId: string, by: string): Annotation {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    return this.annotations(task).verify(annotationId, by);
  }

  /** 裁决另半边:返工。锚点若已失效,趁重锚定结果在手边把它换成当前
   * 原文——不换的话,退回的草稿定位还是指着一段已经不存在的文字。 */
  reopenAnnotation(id: string, annotationId: string, by: string): Annotation {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const store = this.annotations(task);
    const item = store.list().find((one) => one.id === annotationId);
    let update: { line?: number; anchor?: string } | undefined;
    if (item) {
      const root = this.artifactRoot(id);
      const [check] = reanchor([item], (artifact) =>
        root ? readArtifact(root, artifact)?.content : undefined);
      if (check?.state === "moved") update = { line: check.line };
      if (check?.state === "gone" && check.now) {
        update = { line: item.line, anchor: check.now };
      }
    }
    return store.reopen(annotationId, by, update);
  }

  /** 把批注渲染成模型清单。ids 省略=全部待送出的。
   * 只渲染不落状态——决定卡要先给人看一眼再决定送不送。 */
  previewAnnotations(id: string, ids?: string[]): string {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const picked = this.pickDrafts(task, ids);
    return renderAnnotations(picked, this.ticketOf(task));
  }

  /** 送批注:走插话通道,当场发给正在跑的模型。
   * 送达之后才标 sent——先标后发会留下"提过了"的假账,而人会据此
   * 以为说过了。 */
  async sendAnnotations(id: string, ids?: string[]): Promise<{
    sent: string[]; text: string;
  }> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const picked = this.pickDrafts(task, ids);
    const text = renderAnnotations(picked, this.ticketOf(task));
    await this.interrupt(id, text);
    this.annotations(task).markSent(picked.map((item) => item.id), "interrupt");
    return { sent: picked.map((item) => item.id), text };
  }

  private pickDrafts(task: TaskState, ids?: string[]): Annotation[] {
    const drafts = this.annotations(task).drafts();
    if (!ids?.length) {
      if (!drafts.length) throw new NotFoundError("没有待送出的批注");
      return drafts;
    }
    const wanted = new Set(ids);
    const picked = drafts.filter((item) => wanted.has(item.id));
    if (picked.length !== wanted.size) {
      throw new NotFoundError("有批注不存在或已经送出去了");
    }
    return picked;
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
        { summary: task.summary, cwd: task.cwd, mission: task.mission },
        null, 1));
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
          mission: typeof saved.mission === "string"
            ? saved.mission : undefined,
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
      /** 随这次决定一起提交的批注:圈过的几处就是"需要修改"的理由,
       * 不用人再复述一遍。 */
      annotation_ids?: string[];
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
    // 批注进 notes 而不是 decision:内核按选项标签给这次选择记账
    // (choice receipts),往 decision 里塞正文会让它对不上原选项。
    // notes 是自由正文,本来就是给"为什么打回"用的。
    const picked = input.annotation_ids?.length
      ? this.pickDrafts(task, input.annotation_ids) : [];
    const notes = picked.length
      ? [input.notes, renderAnnotations(picked, this.ticketOf(task))]
        .filter(Boolean).join("\n\n")
      : input.notes;
    const resolved = task.humanGate.resolve(waiting.waiting_id, {
      stateVersion: input.state_version,
      decision,
      answers: Object.keys(answers).length ? answers : undefined,
      notes,
    });
    // 决定已经落袋(waiting.json 写完),批注才算送出去。
    if (picked.length) {
      this.annotations(task).markSent(picked.map((item) => item.id), "decision");
    }
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

  /** 跑动中插话:发送即打断。模型把手头这一轮的工具调用做完就收到,
   * 不会在半截处被掐断。
   *
   * 两条边界:
   * - 等人决定时不许走这条路——那时该说的话就是决定本身,从决定卡走,
   *   否则同一件事有两个入口,内核台账上却只认一个。
   * - 正好撞在回合间隙的插话 pi 收下却永远不送(它的队列没人取),
   *   由 settle 在回合收口时取回来补发。人说过的话被系统吞掉,比慢
   *   一拍严重得多。
   */
  async interrupt(id: string, text: string): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const message = text.trim();
    if (!message) throw new NotFoundError("插话内容不能为空");
    if (task.summary.status === "waiting_for_human") {
      throw new NotFoundError("这一单正等你的决定,请在决定卡里回答");
    }
    if (task.summary.status !== "running" || !task.driver) {
      throw new NotFoundError(
        `任务 ${id} 当前是 ${task.summary.status},没有在跑的会话可插话`);
    }
    await task.driver.steer(message);
    this.options.log?.(`任务 ${id} 已插话(本轮工具调用结束后送达)`);
    return { ...task.summary };
  }

  private async pump(): Promise<void> {
    const max = this.options.settings?.runtime().max_concurrent
      ?? this.options.maxConcurrent ?? 2;
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
      // 模型网关热改边界:在这里生效——每个新会话起时现读设置,
      // 在跑的会话不换血(管理页如实写明了这一条)。
      const modelOverride = this.options.settings?.models() ?? {};
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify(modelOverride.json ?? this.options.modelsJson));
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
          // 重启期间收到的决定,正文必须随重建会话一起给模型。
          //
          // 踩过的坑(用户实测):批注随决定提交后,模型回来说"你上次点了
          // 需要调整代码,但具体意见没有落盘"。查下来是真的:injectDecision
          // 只把答复写进事件日志/transcript(我们的账)并经 posttooluse 交给
          // 内核,而内核那条通道只认结构化选项;`messages` 看的是
          // UserPromptSubmit 捕获的普通用户消息,工具答复的正文不在里面。
          // 重建会话又没有挂起的工具调用可 resolve——于是选项到了、理由丢了,
          // 模型只能空手回来再问一遍。用户的话必须由我们自己送到。
          const answered = task.pendingResume
            ? renderDecision(task.pendingResume) : "";
          const unsaid = undeliveredInterrupts(workspace);
          prompt = [
            guidance,
            "云端服务重启,本会话为重建会话:此前对话不在上下文里," +
            "流程真相以内核状态为准。执行 current 查看当前步骤;" +
            "此前向用户的提问均已答复并录入台账(执行 messages 查看)," +
            "不要重复提问;继续推进直到流程 end。",
            answered
              ? "用户对上一个问题的答复原文如下,按它继续,不要再问一遍:\n\n"
                + answered
              : "",
            unsaid.length
              ? "重启前用户还插话说了下面这些,一并按它办:\n\n"
                + unsaid.join("\n\n")
              : "",
          ].filter(Boolean).join("\n\n");
        }
        hostHooks = {
          preTool: kernel.preTool.bind(kernel),
          postTool: kernel.postTool.bind(kernel),
        };
      } else if (resuming || task.resume) {
        // 非内核模式(演练/测试)同样不许丢话:重建会话没有挂起的工具
        // 调用可 resolve,决定正文只能由这条 prompt 送到模型眼前。
        prompt = [
          `服务重启,继续任务:${task.summary.requirement}`,
          task.pendingResume
            ? "用户对上一个问题的答复原文如下,按它继续,不要再问一遍:\n\n"
              + renderDecision(task.pendingResume)
            : "",
          ...(undeliveredInterrupts(workspace).length
            ? ["重启前用户还插话说了下面这些,一并按它办:\n\n"
               + undeliveredInterrupts(workspace).join("\n\n")]
            : []),
        ].filter(Boolean).join("\n\n");
      }
      // 流水线代行验证:环境事实进开场白。每次会话(首跑/重建/修复)都
      // 要带——重建会话没有旧上下文,不带它就会再去撞一遍编译。
      if (this.options.verifyViaPipeline) {
        prompt = `${prompt}\n\n环境事实(宿主声明):本机没有编译/测试工具链,`
          + `也不提供容器构建,不要在本机尝试编译或运行 UT——只会浪费轮次。`
          + `CodeCheck 亦不在本机执行(内核在云端会如实记账并交由流水线)。`
          + `凡流程要求本地编译/UT 的环节,如实注明「本地验证由流水线代行」`
          + `并继续推进(云端已放行对应机器证据)。编码完成后按流程提交并`
          + `推送,权威流水线是唯一裁判;红灯会由专职修复会话跟进。`;
      }
      // 专项使命(修复环)压轴:模型最后读到的最要紧。这里只用不清——
      // 修复会话跑一半被重启,使命要跟着 task.json 回来再喂一遍;
      // 清账在 settle 收口处,会话真做完了才算消费掉。
      if (task.mission) prompt = `${prompt}\n\n${task.mission}`;
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
        provider: modelOverride.provider ?? this.options.provider,
        model: modelOverride.model ?? this.options.model,
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
        ...(task.summary.delivery?.loop
          ? { loop: task.summary.delivery.loop } : {}),
        mr_url: mr.url,
        mr_state: run.status === "success" ? "等待合入" : "验证中",
        pipeline: run.status,
        sha,
      };
      task.summary.status =
        run.status === "success" ? "await_merge" : "verifying";
      // 终态当场裁决;running 不是结局,由带预算的轮询收敛后再裁。
      if (run.status === "running") {
        void this.pollPipeline(task);
      } else {
        this.pipelineVerdict(task, sha,
          run.status === "success" ? "success" : "failed",
          String(run.log ?? ""));
      }
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
    const knobs = this.options.settings?.runtime() ?? {};
    const interval = (knobs.poll_interval_s !== undefined
      ? knobs.poll_interval_s * 1000 : undefined)
      ?? delivery.pollIntervalMs ?? 10_000;
    const deadline = Date.now() + ((knobs.poll_timeout_s !== undefined
      ? knobs.poll_timeout_s * 1000 : undefined)
      ?? delivery.pollTimeoutMs ?? 30 * 60_000);
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
      // 终态交给裁决点:绿=收口通知;红=修复环决定下一步。
      // (persist/notify 都在裁决点里,别在这儿重复收口。)
      this.pipelineVerdict(task, sha,
        terminal.status === "success" ? "success" : "failed",
        String(terminal.log ?? ""));
      return;
    }
    if (task.summary.status !== "verifying") return;
    task.summary.delivery = {
      ...task.summary.delivery,
      pipeline: "running(轮询预算耗尽,请人工查看流水线)",
    };
    this.persist(task);
  }

  /**
   * 流水线终态裁决点(小状态机)——"流水线直至全绿是最终目标"(用户拍板)。
   *
   * 两个入口(触发即终态 / 轮询收敛到终态)都汇到这里,转移规则:
   *   绿 → loop.state=green,收口(await_merge 由调用方已置);
   *   红 → 同一 SHA 修过一轮又红 = 修复会话没产生新提交 → halted 请人工;
   *       修复轮预算耗尽 → exhausted 请人工;
   *       否则派专职修复会话:使命=拿失败日志把流水线修绿,任务重入队,
   *       修完 settle→tryDeliver 自然触发新 SHA 的新流水线——环由现有
   *       机械闭合,这里只记账和扳道岔。
   * 通知不在这儿发:两个调用方各自收口,免得一条消息发两遍。
   */
  private pipelineVerdict(
    task: TaskState,
    sha: string,
    status: "success" | "failed",
    log: string,
  ): void {
    const delivery = task.summary.delivery;
    if (!delivery) return;
    if (status === "success") {
      if (delivery.loop) delivery.loop.state = "green";
      this.persist(task);
      return;
    }
    const max = this.options.settings?.runtime().repair_rounds
      ?? this.options.delivery?.repairRounds ?? 2;
    // repairRounds=0 = 关掉修复环:保持旧语义(红灯留痕请人工),不记环账。
    if (max === 0 && !delivery.loop) {
      this.persist(task);
      return;
    }
    const loop = delivery.loop
      ?? (delivery.loop = { round: 0, max, state: "repairing" as const });
    if (loop.last_sha === sha) {
      loop.state = "halted";
      delivery.pipeline = "failed(修复会话未产生新提交,请人工)";
      this.persist(task);
      return;
    }
    if (loop.round >= loop.max) {
      loop.state = "exhausted";
      delivery.pipeline = `failed(${loop.max} 轮修复预算用完,请人工)`;
      this.persist(task);
      return;
    }
    loop.round += 1;
    loop.last_sha = sha;
    loop.state = "repairing";
    loop.failure = log.slice(0, 2000) || "(平台未提供失败详情)";
    delivery.pipeline = `failed(第 ${loop.round}/${loop.max} 轮修复中)`;
    task.mission = [
      `流水线红了,把它修到绿是你此刻唯一的使命(第 ${loop.round}/${loop.max} 轮修复):`,
      `- 分支上提交 ${sha} 的权威流水线结果是 failed。`,
      `- 失败详情(平台原文,截断到 2000 字):`,
      loop.failure,
      `- 只修让流水线变红的问题;修完在同一分支提交并 push。`,
      `- 别的都不要动;顺手的重构、无关的优化一律不做。`,
      `- 如果你判断修不了或不该修(比如失败与代码无关),说明理由后停下,`
      + `不要硬改——没有新提交时系统会如实停下请人工,这是正确结局之一。`,
    ].join("\n");
    task.summary.status = "queued";
    task.summary.detail = `流水线红,第 ${loop.round}/${loop.max} 轮修复排队中`;
    task.resume = true;
    this.persist(task);
    this.queue.push(task.summary.id);
    // 不能当场 pump:这里可能正处在 settle→tryDeliver 的调用链里,而
    // pump 会同步把状态置成 running,settle 随后那句"running→completed"
    // 就把修复轮当场盖掉(读代码逮住的竞态)。setImmediate 排到微任务链
    // 之后,settle 收完自己的账、原会话的 finally 归还并发额度,再派单。
    setImmediate(() => void this.pump());
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
        link: personalTaskLink(
          this.options.linkBase,
          account,
          task.summary.id,
        ),
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
      link: personalTaskLink(this.options.linkBase, account, id),
    });
  }

  /** 主动压缩(用户关切:长编码阶段注意力漂移):事件量每涨
   * compactEveryEvents,在回合间隙以内核锚点压缩会话。事件量是
   * 上下文增长的诚实代理——不复刻 token 计数,也不猜阶段语义。 */
  private async maybeCompact(task: TaskState): Promise<void> {
    const every = this.options.compactEveryEvents ?? 0;
    if (!every || !task.driver) return;
    let level = 0;
    try {
      level = new EventLog(
        join(task.summary.workspace, "events.jsonl")).lastEventId();
    } catch {
      return;
    }
    if (level - (task.lastCompactAt ?? 0) < every) return;
    task.lastCompactAt = level;
    await task.driver.compactAnchored(this.kernelAnchor(task));
  }

  /** 压缩锚点:内核状态文件的 current/config 原文;没有内核现场
   * 就退到需求原话——锚永远来自权威,不由云端编造。 */
  private kernelAnchor(task: TaskState): string {
    try {
      const statePath = join(task.cwd ?? "", ".mae-flow.json");
      if (task.cwd && existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        return `内核当前步骤: ${state.current}\n`
          + `已确认配置: ${JSON.stringify(state.config ?? {})}\n`
          + `需求: ${task.summary.requirement}`;
      }
    } catch {
      // 读不到就用需求兜底,不为锚编内容。
    }
    return `需求: ${task.summary.requirement}`;
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
        // 主动压缩:回合间隙是唯一安全的压缩点(等待人工时压会
        // 打断挂起的人工节点)。以内核锚点组织摘要,注意力不许飘。
        await this.maybeCompact(task);
        // 回合收口时 steer 队列还压着货 = 那条插话从没送到(撞在回合
        // 间隙,pi 收下却不会自己送)。取回来补发,而且排在催办和收工
        // 之前:人说的话优先于系统催办,更不能因为"流程刚好走完了"被吞掉。
        const late = task.driver?.takeUndeliveredSteers() ?? [];
        if (late.length && task.driver) {
          this.options.log?.(
            `任务 ${task.summary.id} 补发 ${late.length} 条未送达的插话`);
          await this.settle(task, task.driver.continueWith(late.join("\n\n")));
          break;
        }
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
        // 专项使命到这儿才算消费掉:会话真做完了。早清会让"修一半
        // 被重启"的重建会话拿不到使命。
        task.mission = undefined;
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
