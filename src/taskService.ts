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
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
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
import { workflowChoices } from "./kernelChoices.ts";
import { buildRepoMap } from "./repoMap.ts";
import { collectKnowledge } from "./knowledgeBlocks.ts";
import { readJson } from "./jsonBody.ts";
import type { Notifier, NotifyRecord } from "./notifier.ts";
import { EventLog } from "./semanticEvents.ts";
import { TranscriptStore } from "./transcriptStore.ts";
import { GateService, type GateContract } from "./gateService.ts";
import { HumanGate, renderDecision, type WaitingRecord } from "./humanGate.ts";
import { CloudSession, type Outcome } from "./sessionDriver.ts";
import { dockerAvailable, TaskContainer } from "./containerRuntime.ts";
import type { ExternalAction, PgProjection } from "./projection.ts";
import type { RuntimeSettings } from "./settings.ts";
import { ReviewStore, type ReviewRequest } from "./reviews.ts";

export type TaskStatus =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "waiting_for_human"
  | "completed"
  | "verifying"      // MR 已建,权威流水线未过(主 spec §10:不能标完成)
  | "await_merge"    // 流水线通过,等待人工合入;系统不自动合并
  | "canceled"
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
  /** 扫读标题:需求原文仍完整保留在 requirement。旧任务缺席时由读侧
   * 从需求首行生成,不要求迁移现场文件。 */
  title?: string;
  requirement: string;
  status: TaskStatus;
  waiting?: WaitingRecord;
  detail?: string;
  created_at: string;
  /** 任务运营时间:updated_at 是任意任务事实最近变更,last_progress_at
   * 只在状态/阶段推进时变化,领导据此识别“长时间没有有效进展”。 */
  updated_at?: string;
  last_progress_at?: string;
  completed_at?: string;
  workspace: string;
  /** 小鲁班通知账号(任务创建时填写,主 spec §5.1)。 */
  luban_account?: string;
  /** 下单时填的交付代码仓;缺席=部署仓(--repo)。记在任务上:
   * 重启续跑同仓不漂移,MR/流水线请求也带它给平台适配层。 */
  repo_url?: string;
  /** 交付方式(用户拍板:下单就选好,不让 agent 来问)。取值是**内核
   * flow.json 里 workflow_select 的选项原文**(完整开发/已定位问题修复/
   * 局部修改/处理评审意见),不是宿主自造的词——自造过一次,结果是
   * 卡来了永远对不上、用户在流程里被重复问一遍(2026-08-18 内网实测)。
   * 内核仍会举卡(流程规则是内核的,宿主不删它的问题),对得上就自动
   * 交卷(预答,不是代判)。 */
  lane?: string;
  /** 下单时选的模型;缺席=跟随服务当前默认(设置层/部署层)。
   * 记在任务上是为了两件事:重启续跑不漂移、页面能说清"谁跑的"。 */
  model_choice?: { provider: string; model: string };
  /** 下单时的修复轮预算;缺席=跟随服务当前默认。0=本单关掉修复环。 */
  repair_rounds?: number;
  /** 最近一张待办的通知投递事实(失败标红的依据,不影响流程)。 */
  notify?: Pick<NotifyRecord, "delivered" | "attempts" | "last_error">;
  /** Git 交付事实(§10):MR 链接/状态、流水线结果、或没交付的原因。
   * sha = 流水线绑定的代码版本,也是重启后续轮的锚。 */
  delivery?: {
    mr_url?: string;
    /** MR 标识(平台返回的 id/iid):门禁与讨论查询要带回去。 */
    mr_id?: number | string;
    /** 交付分支对(门禁查询与冲突修复都要用,重启后不靠重读状态文件)。 */
    source_branch?: string;
    target_branch?: string;
    mr_state?: string;
    pipeline?: string;
    sha?: string;
    skipped?: string;
    /** 内核对流水线证据的裁决戳(如 "PASS@abc123456789"):终态时宿主
     * 把平台事实喂给内核 `pipeline record`,内核绑工作区 HEAD 裁决并
     * 写进 .mae-flow.json 的 quality.pipeline——这里只是那份现场记录
     * 的镜像。"未裁决(...)"= 登记失败留痕(fail-open,不拦收口)。 */
    attested?: string;
    /** 挂起等待的人话(等审批/等投票……):MR 闭环里"没人动它"和
     * "出了问题"必须让人一眼分得开。 */
    waiting_on?: string;
    /** 修复环账本(小状态机):MR 全绿合入是最终目标(用户拍板
     * "不该有最大轮数限制,都该尽力修好")。失败先分类再派单
     * (检视>冲突>CI,同时多项只修最高优先级那一路——冲突不解 CI
     * 白跑);round 只数 CI 修复(检视/冲突触发时清零,流程性问题
     * 不许耗掉代码修复的额度);max 缺席=不限轮,数字=可配手刹。
     * 真正的收敛刹车按类分:CI/冲突=同 SHA 不二修(没新提交即停),
     * 检视=同一批讨论 id 修过一轮仍未解决即停;加上提示词里的
     * "原地打转必须换思路或出诊断"。
     * diagnosis=修复会话停下时留给人的话(缺什么、去哪配)。 */
    loop?: {
      round: number;
      max?: number;
      state: "repairing" | "green" | "exhausted" | "halted";
      /** 最近一次派的修复类型:回程(settle 后)按它走收尾动作。 */
      kind?: "ci" | "review" | "conflict";
      failure?: string;
      last_sha?: string;
      /** 检视修复的刹车锚:上一轮处理的讨论 id 集(排序拼接)。 */
      review_ids?: string;
      /** 已把回复发布到平台的讨论 id 集。与 review_ids 相等 = 这批
       * 意见都答复过了,门禁还红只是检视人没点"已解决"——那是等人,
       * 不是修不动(报告 D3:既有框架刻意不代检视人 resolve)。 */
      replied_ids?: string;
      diagnosis?: string;
    };
  };
  /** 从现场看板的 panel-pulse.js/panel.html 读取的进度摘要。 */
  progress?: TaskProgress;
  /** 人工控制台账。paused_from 是恢复时的扳道锚点：等待决定、流水线
   * 验证和普通执行的恢复方式不同，不能靠前端猜。 */
  control?: {
    last_action: "pause" | "resume" | "cancel";
    actor: string;
    at: string;
    paused_from?: TaskStatus;
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
  /** repoPath 缺席=部署没给默认仓:默认仓从管理页(settings.service)
   * 来,或者每单下单时填——两头都没有的任务如实失败。 */
  host?: { kernelRoot: string; repoPath?: string; python?: string };
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
    /** 发布检视回复时顺手标"已解决"。默认关——内网既有框架的实证
     * (报告 D3):平台文化是"回复归作者,resolve 归检视人",代点
     * 是越权。平台/团队明确允许代点的部署再打开。 */
    resolveDiscussions?: boolean;
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
  /** 提交信息规范(部署级一句话,进每个会话的开场)。
   *
   * **业务提交的格式权威在内核**(`[<单号>][feat|fix]描述`,内核门禁
   * 直接 block),平台 pre-receive 钩子的正则是它的超集,天然兼容
   * ——这个旗子不是用来改写内核规则的,配成别的格式只会让 agent 写出
   * 内核当场拒收的信息(反例见部署手册)。
   *
   * 它存在是为了内核管不到的那部分:合并提交(冲突修复产生、由宿主
   * 直接推送)、revert、或某些仓额外要求的前缀——平台钩子照样会按
   * 正则拒收 push,而那时代码早写完了,重来一遍纯浪费。 */
  commitConvention?: string;
  /** 运行时设置覆盖(管理页):并发/修复轮/轮询/通知/模型网关。
   * 部署配置是底,这层是热改;各消费点即时读,生效边界见 settings.ts。 */
  settings?: RuntimeSettings;
  /** 按任务归属人取个人 Git 凭据(serve 接 LocalAuth.gitCredential)。
   * 有凭据→经 credential helper 注入 clone/push;没有→维持部署级
   * 访问方式(服务账号/开放内网)。生效边界=下一次任务启动/会话重建。 */
  gitCredential?: (
    account?: string,
  ) => { username: string; password: string; email?: string } | undefined;
  /** 月光模式(免审批)查询口:按任务归属人现读现判(serve 接
   * LocalAuth.moonlightEnabled)。开着时该用户任务的人工节点由
   * 系统代答放行,答复里写明预授权与复盘要求;随时可开可关。 */
  moonlight?: (account?: string) => boolean;
  log?: (message: string) => void;
}

/** MR 合并门禁的分类表(照内网既有框架的实证结论,
 * docs/mr-loop-adaptation.md §4)。三项可修按优先级排:数字小=先修,
 * 同时多项失败只派最高优先级那一路——冲突不解 CI 白跑,检视优先于
 * 代码问题。其余六项(审批/投票/WIP/e2e/自定义/评估)只能等人:
 * 系统保持监控、通知归属人,不派 agent 不扣重试。认不出的名字一律
 * 按等人处理并把名字留痕——瞎修比不修危险。 */
const REPAIRABLE_GATES: Record<
  string,
  { kind: "review" | "conflict" | "ci"; priority: number }
> = {
  resolve_discussion_passed: { kind: "review", priority: 10 },
  conflict_passed: { kind: "conflict", priority: 15 },
  ci_state_passed: { kind: "ci", priority: 20 },
  // 代码质量门禁(内网 2026-08-18 首次拿到真实门禁集才发现有这一项)。
  // 它是**改代码能解决的**——CodeCheck/CodeCC 那类扫描结论,正是 CI
  // 修复使命里"按类分诊"已经覆盖的一类。归到等人的话,MR 卡在这里
  // 永远没人动,任务干等到监控预算耗尽(逮住时它正是 false)。
  // 与 ci_state_passed 同一路(同一个修复会话一次修完),排在其后:
  // 流水线红通常连带质量红,先看流水线原文更全。
  codequality_passed: { kind: "ci", priority: 25 },
};

/** 等人门禁的人话。名字缺席不影响判定(认不出=等人),只影响文案:
 * 界面上"等 approval_reviewers_required_passed"没人看得懂,而这些
 * 名字来自内网真实 MR(2026-08-18 selftest 实测的 19 项)。 */
const HUMAN_GATE_TEXT: Record<string, string> = {
  approvers_passed: "等审批",
  vote_passed: "等投票",
  work_in_progress_passed: "等摘除 WIP 标记",
  e2e_check_passed: "等 e2e 检查",
  custom_ctrl_items_passed: "等自定义门禁",
  evaluation_passed: "等评估",
  approval_approvers_required_passed: "等必需审批人审批",
  approval_reviewers_required_passed: "等必需检视人检视",
  committer_must_cast_two_votes_passed: "等提交人以外的两票",
  merge_by_self_passed: "等他人代为合入(不允许自己合自己的单)",
  merged_by_user_passed: "等有权限的人点合入(目标分支受保护)",
  mr_state_passed: "等 MR 回到可合入状态",
  no_commits_passed: "等分支上出现提交",
  branch_missing_passed: "等分支恢复(远端分支不见了)",
  // 非快进:平台要求线性历史。宿主的冲突修复走 merge(会产生合并
  // 提交),对"必须快进"的仓解不了;真解法是变基后强推,而强推是
  // 内核明令禁止的不可逆动作——所以这一项如实挂等人,交给人裁决。
  non_ff_passed: "等处理非快进(需变基,自动修复不做强推)",
};

interface GateItem {
  name: string;
  passed: boolean;
  detail?: string;
}

interface GateView {
  mrState: "opened" | "merged" | "closed";
  gates: GateItem[];
}

/** 失败分类:可修的按优先级排序(全部返回——高优先级不可派时要能
 * 落到下一路,如"检视已回复等确认"时 CI 还得修);等人的翻成人话。 */
function classifyGates(gates: GateItem[]): {
  repairs: Array<{ kind: "review" | "conflict" | "ci"; gate: GateItem;
                   priority: number }>;
  waiting: string[];
} {
  const repairs: Array<{ kind: "review" | "conflict" | "ci";
                         gate: GateItem; priority: number }> = [];
  const waiting: string[] = [];
  for (const gate of gates) {
    if (gate.passed) continue;
    const known = REPAIRABLE_GATES[gate.name];
    if (known) repairs.push({ ...known, gate });
    else waiting.push(HUMAN_GATE_TEXT[gate.name] ?? `等 ${gate.name}`);
  }
  repairs.sort((a, b) => a.priority - b.priority);
  return { repairs, waiting };
}

/** 检视意见(适配层契约形状,宿主只读这些字段)。 */
interface DiscussionItem {
  id: string;
  file?: string;
  line?: number;
  severity?: string;
  author?: string;
  body?: string;
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

function reviewTaskLink(
  linkBase: string | undefined,
  taskId: string,
  reviewId: string,
): string {
  const root = (linkBase ?? "").replace(/\/+$/, "");
  return `${root}/?task=${encodeURIComponent(taskId)}`
    + `&review=${encodeURIComponent(reviewId)}`;
}

export type SystemCheckStatus = "ok" | "warning" | "error";
export interface SystemCheckItem {
  key: string;
  label: string;
  status: SystemCheckStatus;
  detail: string;
  suggestion?: string;
}
export interface SystemCheckResult {
  checked_at: string;
  overall: SystemCheckStatus;
  items: SystemCheckItem[];
}

/** 自由需求原文 → 可扫读标题。它只是展示摘要,不改需求输入；按首个非空
 * 行截断,避免把一整段需求塞进团队列表。 */
function taskTitle(requirement: string): string {
  const first = requirement.split(/\r?\n/)
    .map((line) => line.trim()).find(Boolean) ?? "未命名任务";
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
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
  /** 合入监控环的防重入锁(内存态):一任务只挂一环。 */
  mergeWatchActive?: boolean;
  /** 上次主动压缩时的事件水位(事件量是上下文增长的诚实代理)。 */
  lastCompactAt?: number;
  /** 恢复标记:launch 走重建会话路径(不重克隆、内核 current 续跑)。 */
  resume?: boolean;
  /** 恢复期收到的人工决定:重建会话就绪后由 driver 补登记再续跑。 */
  pendingResume?: WaitingRecord;
  /** 专项使命(修复环):下次会话的压轴指令,消费即清。
   * 要随 task.json 落盘——修复会话跑一半被重启,使命不能丢。 */
  mission?: string;
  /** 会话收口时的最后发言(内存态):修复会话不提交时它就是诊断,
   * halted 裁决把它带给人。不落盘——窗口极窄,时间线里也有原文。 */
  lastReply?: string;
  /** 避免列表轮询反复解析未变化的现场面板。 */
  progressPulse?: string;
  progressCache?: TaskProgress;
  /** persist 用来识别真正的状态推进,避免普通元数据更新冒充进展。 */
  lastPersistedStatus?: TaskStatus;
  /** 每次取消/即时暂停/恢复都会换代。异步回调只允许修改启动时那一代，
   * 防止“取消后又被旧回调写成完成”。进程重启后旧 Promise 已不存在。 */
  controlEpoch: number;
  /** running 的暂停不截断当前工具，等 settle 的安全边界收口。 */
  pauseRequested?: boolean;
}

export class TaskService {
  private tasks = new Map<string, TaskState>();
  private runningCount = 0;
  private queue: string[] = [];
  private counter = 0;
  private reviews: ReviewStore;

  constructor(readonly options: TaskServiceOptions) {
    this.reviews = new ReviewStore(join(options.dataDir, "reviews.jsonl"));
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

  /** 责任人主动发出的 Committer 检视邀请。邀请先落盘，再投递；通知
   * 失败也不会把“有人应当检视”这个事实弄丢。 */
  async requestReview(
    id: string,
    requester: string,
    committer: string,
  ): Promise<ReviewRequest> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const notifier = this.options.notifier;
    if (!notifier) throw new Error("本部署未接通知器");
    const review = this.reviews.create({
      taskId: id,
      taskTitle: task.summary.title ?? taskTitle(task.summary.requirement),
      requester,
      committer,
    });
    const result = await notifier.notifyReview({
      taskId: id,
      account: committer,
      summary: review.task_title,
      link: reviewTaskLink(this.options.linkBase, id, review.id),
    });
    return this.reviews.delivery(review.id, result);
  }

  listReviewsFor(committer: string): ReviewRequest[] {
    return this.reviews.forCommitter(committer);
  }

  listTaskReviews(taskId: string): ReviewRequest[] {
    if (!this.tasks.has(taskId)) throw new NotFoundError(`任务 ${taskId} 不存在`);
    return this.reviews.forTask(taskId);
  }

  completeReview(id: string, committer: string): ReviewRequest {
    return this.reviews.complete(id, committer);
  }

  /** 管理员部署自检：只做只读、有限时的探测，不发送测试消息，
   * 不创建任务，也不改变任何运行配置。 */
  async systemCheck(): Promise<SystemCheckResult> {
    const items: SystemCheckItem[] = [];
    try {
      accessSync(this.options.dataDir, constants.R_OK | constants.W_OK);
      items.push({ key: "data", label: "任务数据", status: "ok",
        detail: "数据目录可读写" });
    } catch (error) {
      items.push({ key: "data", label: "任务数据", status: "error",
        detail: "数据目录不可读写", suggestion: String(error) });
    }

    const active = this.launchOptions().model;
    items.push(active
      ? { key: "model", label: "模型网关", status: "ok",
          detail: `${active.provider}/${active.model} 已配置` }
      : { key: "model", label: "模型网关", status: "error",
          detail: "没有可用模型",
          suggestion: "管理页 → 模型网关:贴 models.json 同形内容" });

    const notify = this.options.notifier?.health();
    items.push(!notify?.configured
      ? { key: "notify", label: "通知服务", status: "warning",
          detail: "未配置通知端点", suggestion: "配置后可用测试消息验证连通" }
      : notify.last_error
        ? { key: "notify", label: "通知服务", status: "warning",
            detail: "已配置，但最近一次投递失败", suggestion: notify.last_error }
        : { key: "notify", label: "通知服务", status: "ok",
            detail: "通知端点已配置" });

    const projection = this.options.projection
      ? await this.options.projection.health() : undefined;
    items.push(!projection
      ? { key: "postgres", label: "PostgreSQL", status: "warning",
          detail: "未配置历史投影", suggestion: "任务仍可运行，但无跨生命周期历史" }
      : !projection.reachable
        ? { key: "postgres", label: "PostgreSQL", status: "error",
            detail: "数据库不可达", suggestion: projection.last_error }
        : projection.last_error
          ? { key: "postgres", label: "PostgreSQL", status: "warning",
              detail: "连接正常，但最近有投影写入失败", suggestion: projection.last_error }
          : { key: "postgres", label: "PostgreSQL", status: "ok",
              detail: "连接与投影正常" });

    const platform = this.effectivePlatformUrl();
    items.push(!this.options.host
      ? { key: "git", label: "Git 交付", status: "warning",
          detail: "当前是纯会话模式", suggestion: "交付代码前启用内核模式与代码仓" }
      : !platform
        ? { key: "git", label: "Git 交付", status: "warning",
            detail: "未配置 MR / 流水线平台", suggestion: "在交付与形态中配置平台地址" }
        : { key: "git", label: "Git 交付", status: "ok",
            detail: "平台已配置;代码仓逐单填写(本部署不设默认仓)" });

    if (!this.options.isolation) {
      items.push({ key: "container", label: "容器隔离", status: "warning",
        detail: "未启用任务容器", suggestion: "内网多人使用前建议配置隔离镜像" });
    } else {
      const available = await dockerAvailable();
      items.push(available
        ? { key: "container", label: "容器隔离", status: "ok",
            detail: `Docker 可用，镜像 ${this.options.isolation.image}` }
        : { key: "container", label: "容器隔离", status: "error",
            detail: "Docker daemon 不可用", suggestion: "启动 Docker 并确认服务账号有权限" });
    }

    const overall: SystemCheckStatus = items.some((item) => item.status === "error")
      ? "error" : items.some((item) => item.status === "warning") ? "warning" : "ok";
    return { checked_at: new Date().toISOString(), overall, items };
  }

  private project(task: TaskState): TaskSummary {
    const record = task.notifyRecord;
    const progress = this.readProgress(task);
    const summary = task.summary;
    return {
      ...summary,
      title: summary.title ?? taskTitle(summary.requirement),
      updated_at: summary.updated_at ?? summary.created_at,
      last_progress_at: summary.last_progress_at
        ?? summary.updated_at ?? summary.created_at,
      notify: record
        ? {
            delivered: record.delivered,
            attempts: record.attempts,
            last_error: record.last_error,
          }
        : undefined,
      progress,
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
      const now = new Date().toISOString();
      task.summary.last_progress_at = now;
      task.summary.updated_at = now;
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

  /** 服务形态的三个热改项(管理页压部署 flag):平台地址、默认仓、
   * 免编译。各消费点现读现用,生效边界=下一次交付动作/新会话。 */
  private effectivePlatformUrl(): string | undefined {
    return this.options.settings?.service().platform_url
      ?? this.options.delivery?.platformUrl;
  }

  private effectiveDefaultRepo(): string | undefined {
    return this.options.settings?.service().default_repo
      ?? this.options.host?.repoPath;
  }

  private effectiveVerifyViaPipeline(): boolean {
    return this.options.settings?.service().verify_via_pipeline
      ?? this.options.verifyViaPipeline ?? false;
  }

  /** 生效的提交信息规范(设置层压部署层)。平台钩子按正则拒收不合规
   * 提交(内网实测),这条规矩要在每个会话开场就给——包括修复会话。 */
  private effectiveCommitConvention(): string | undefined {
    const text = this.options.settings?.service().commit_convention
      ?? this.options.commitConvention;
    const trimmed = String(text ?? "").trim();
    return trimmed || undefined;
  }

  /** 当前生效的 models.json 同形内容(设置层压部署层)——
   * 下单模型选项和校验共用这一个口径。 */
  private activeModelsJson(): Record<string, unknown> {
    return (this.options.settings?.models().json ?? this.options.modelsJson
      ?? {}) as Record<string, unknown>;
  }

  /** 下单表单的数据源。
   *
   * 口径(用户 2026-08-18 拍板,按内网实战定的):
   * - **交付仓必填**,没有"默认仓"这回事——一个部署要服务很多个仓,
   *   默认仓只会让人漏看一眼就把单下错地方;
   * - **模型不给选**:管理员统一配一个,所有人用同一个。选择权留给
   *   人只会制造"为什么他的比我快"的困惑,也让成本不可控;
   * - 交付方式与修复轮预算仍按单可选(前者决定走哪条链,后者是钱);
   *   交付方式的选项**现读内核 flow.json**,前端与本文件都不另抄一份。
   *
   * `model` 字段仍然返回当前生效的那一个——不是给人选,是给界面显示
   * "这单会用谁跑",让人心里有数。 */
  launchOptions(): {
    /** 当前生效的模型(展示用,下单表单不提供选择)。 */
    model?: { provider: string; model: string };
    /** 当前默认修复轮:数字=手刹上限;缺席=不限轮(默认形态)。 */
    repair_rounds?: number;
    repo: { enabled: boolean; required: boolean };
    /** 交付方式选项:**现读内核 flow.json**,不在 TS 侧另抄一份。
     * 空数组=读不到内核定义,表单就别摆出选择(下单不预选,卡到时
     * 老老实实问人)。 */
    workflows: Array<{ key: string; label: string }>;
    /** 服务级缺的配置(管理员去补)。非空=不给下单。 */
    blockers: Array<{ key: string; label: string; where: "admin" | "me" }>;
    /** 本部署要不要这两把个人令牌(由形态决定,见下方注释)。 */
    needs: { git_token: boolean; luban_token: boolean };
  } {
    const active = this.activeModelChoice();
    const blockers: Array<
      { key: string; label: string; where: "admin" | "me" }> = [];
    // 每条缺项**只在它真会咬人时才拦**:纯会话形态(不接代码仓)拦
    // Git 令牌毫无道理,没接通知端点拦通知令牌也一样——一刀切的门禁
    // 会把用不上那件东西的部署一起挡在门外。
    if (!active) {
      blockers.push({ key: "model", where: "admin",
        label: "模型网关未配置(管理页 → 模型网关,贴 models.json 同形内容)"
          + ";没有它任何任务都跑不起来" });
    }
    if (this.options.host && !this.effectivePlatformUrl()) {
      blockers.push({ key: "platform", where: "admin",
        label: "交付平台未配置(管理页 → 服务形态 → 平台地址)"
          + ";没有它代码交付不出去" });
    }
    return {
      model: active,
      repair_rounds: this.options.settings?.runtime().repair_rounds
        ?? this.options.delivery?.repairRounds,
      // 没接内核模式=任务不碰代码仓,表单别摆出输入框骗人。
      repo: { enabled: !!this.options.host, required: !!this.options.host },
      workflows: workflowChoices(this.options.host?.kernelRoot),
      blockers,
      needs: {
        // 个人令牌该不该要,由部署形态决定(同上:只拦真会咬人的)。
        git_token: !!this.options.host,
        luban_token: !!this.options.notifier,
      },
    };
  }

  /** 当前生效的模型:设置层显式配的 > models.json 里的第一个 >
   * 部署参数。**自动兜底那一步是有意的**——管理员贴完 models.json
   * 就能用,不必再手打一遍 provider/model(实测:服务起来后表单是空的,
   * 人不知道还差一步)。 */
  private activeModelChoice(): { provider: string; model: string } | undefined {
    const override = this.options.settings?.models() ?? {};
    const providers = (this.activeModelsJson() as {
      providers?: Record<string, { models?: Array<{ id?: string }> }>;
    }).providers ?? {};
    const firstProvider = Object.keys(providers)[0];
    const provider = override.provider || this.options.provider || firstProvider;
    const listed = (providers[provider ?? ""]?.models ?? [])
      .map((item) => String(item?.id ?? "")).filter(Boolean);
    const model = override.model || listed[0] || this.options.model;
    return provider && model ? { provider, model } : undefined;
  }

  create(
    requirement: string,
    options: {
      account?: string;
      repo?: string;
      lane?: string;
      model?: { provider: string; model: string };
      repairRounds?: number;
    } = {},
  ): TaskSummary {
    // 交付方式:选项是内核的领地,现读它的 flow.json 校验
    // (2026-08-18 修正:此前 TS 侧自造"快速/慢速",与内核的
    // full/hotfix/tweak/review 对不上,预选永远匹配不上内核举的卡,
    // 用户下单答过一次、页面上还要再答一次)。读不到内核定义时不校验
    // ——宁可放行也不拿一套猜出来的选项挡人。
    const laneChoices = workflowChoices(this.options.host?.kernelRoot)
      .map((item) => item.label);
    if (options.lane !== undefined && laneChoices.length
        && !laneChoices.includes(options.lane)) {
      throw new Error(
        `交付方式只能是 ${laneChoices.join("/")},收到: ${options.lane}`);
    }
    const repo = (options.repo ?? "").trim() || undefined;
    // 交付仓必填(用户 2026-08-18 拍板:没有"默认仓"这回事)。一个
    // 部署要服务很多个仓,兜底一个默认值只会让人漏看一眼就把单下错
    // 地方——宁可当场拒绝,也不替人猜他要交到哪儿。
    // 唯一豁免:部署显式用 `--repo` 钉死了单仓(演示/试跑/测试的
    // harness 形态,那是命令行不是产品面)。生产按 `--kernel-mode`
    // 不带 `--repo` 起,于是每单都必须写明。
    if (!repo && this.options.host && !this.options.host.repoPath) {
      throw new Error(
        "请填写交付代码仓——本部署不设默认仓,每单都要写明交到哪个仓");
    }
    if (repo) {
      if (!this.options.host) {
        throw new Error("本部署未接内核模式,任务不克隆代码仓");
      }
      if (/\s/.test(repo)) throw new Error("代码仓地址不能含空白字符");
      if (/^https?:\/\//i.test(repo)) {
        // 明文凭据拼 URL 是我们刚堵死的洞,这里不许再开:
        // 鉴权走个人令牌的 credential helper,URL 保持干净。
        const parsed = new URL(repo);
        if (parsed.username || parsed.password) {
          throw new Error("代码仓 URL 不许携带账号密码——鉴权走个人 Git 令牌");
        }
      }
    }
    if (options.model) {
      // 下单不再给选模型(用户拍板:管理员统一配一个)。这条通路留给
      // 试跑器/测试显式指定,仍然当场校验存在性——选了不存在的模型,
      // 晚到会话启动才炸是坑人。
      const providers = (this.activeModelsJson() as {
        providers?: Record<string, { models?: Array<{ id?: string }> }>;
      }).providers ?? {};
      const listed = (providers[options.model.provider]?.models ?? [])
        .map((item) => String(item?.id ?? ""));
      if (!listed.includes(options.model.model)) {
        throw new Error(
          `没有模型 ${options.model.provider}/${options.model.model}`);
      }
    }
    if (options.repairRounds !== undefined
        && (!Number.isFinite(options.repairRounds)
            || options.repairRounds < 0)) {
      throw new Error("修复轮预算必须是 ≥0 的数字");
    }
    this.counter += 1;
    const id = `task-${this.counter}`;
    const workspace = join(this.options.dataDir, id);
    mkdirSync(workspace, { recursive: true });
    const summary: TaskSummary = {
      id,
      title: taskTitle(requirement),
      requirement,
      status: "queued",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_progress_at: new Date().toISOString(),
      workspace,
      luban_account: options.account || undefined,
      repo_url: repo,
      // 用户拍板:交付方式下单就定,不让 agent 再问一遍。默认取内核
      // 选项里的第一项(通常是"完整开发"),读不到内核就不预选。
      lane: options.lane ?? laneChoices[0],
      model_choice: options.model,
      repair_rounds: options.repairRounds,
    };
    const task: TaskState = {
      summary,
      humanGate: new HumanGate(join(workspace, "waiting.json")),
      lastPersistedStatus: summary.status,
      controlEpoch: 0,
    };
    this.tasks.set(id, task);
    this.persist(task);
    this.queue.push(id);
    this.bypass(undefined, "任务泵", this.pump());
    return { ...summary };
  }

  /** 任务事实落盘(原子写):进程可死,任务不能死。
   * summary+cwd 就是重启后重建 TaskState 需要的全部——待办在
   * waiting.json、事件在 events.jsonl、流程真相在内核状态文件。 */
  private persist(task: TaskState): void {
    const now = new Date().toISOString();
    if (task.lastPersistedStatus !== undefined
        && task.lastPersistedStatus !== task.summary.status) {
      task.summary.last_progress_at = now;
    }
    if (["completed", "await_merge"].includes(task.summary.status)) {
      task.summary.completed_at ??= now;
    }
    task.summary.updated_at = now;
    task.lastPersistedStatus = task.summary.status;
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
    this.bypass(task, "投影 upsert",
      this.options.projection?.upsertTask(this.project(task)));
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
          lastPersistedStatus: summary.status,
          controlEpoch: 0,
        };
        this.tasks.set(summary.id, task);
        this.counter = Math.max(
          this.counter, Number(name.slice("task-".length)) || 0);
        restored += 1;
        this.replayProjection(task);
        // 服务在“正在暂停”窗口退出时，所有执行资源已经随进程消失；
        // 恢复为 paused 比擅自续跑更符合用户最后一次明确指令。
        if (summary.status === "pausing") {
          summary.status = "paused";
          summary.detail = "服务重启时已完成暂停";
          summary.control = {
            ...(summary.control ?? {
              last_action: "pause",
              actor: "系统",
              at: new Date().toISOString(),
            }),
            last_action: "pause",
            paused_from: summary.control?.paused_from ?? "running",
          };
          this.persist(task);
        }
        // 进程可死,轮询不死:重启前在等流水线的任务续轮
        // (锚是 delivery.sha,结果仍只认绑定版本)。
        if (summary.status === "verifying"
            && summary.delivery?.pipeline === "running") {
          this.bypass(task, "流水线轮询",
            this.pollPipeline(task, task.controlEpoch));
        }
        // 合入监控同理续:重启前在等合入/等审批的接着盯(平台不支持
        // 门禁契约的,watchMerge 一轮就退,行为与旧版完全一致)。
        if (summary.status === "await_merge") {
          this.bypass(task, "合入监控",
            this.watchMerge(task, task.controlEpoch));
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
    if (requeued) this.bypass(undefined, "任务泵", this.pump());
    return { restored, requeued };
  }

  /** 恢复重放投影(§11):以现场文件为源补齐读侧——摘要整行覆盖,
   * 事件副本重灌((taskId,eventId) 幂等锚把重复兜成 no-op)。
   * 现场文件损坏只影响投影补齐,不影响任务恢复本身。 */
  private replayProjection(task: TaskState): void {
    const projection = this.options.projection;
    if (!projection) return;
    this.bypass(task, "投影 upsert",
      projection.upsertTask(this.project(task)));
    try {
      const log = new EventLog(
        join(task.summary.workspace, "events.jsonl"));
      for (const event of log.replay()) {
        this.bypass(task, "投影事件", projection.appendEvent(event));
      }
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 投影重放失败: ${String(error)}`);
    }
  }

  /** 重跑一单:completed/failed 的任务重新入队,host 模式以内核
   * current 为锚续跑。用于环境修复后续推(run7-resume 实测:容器
   * 被并行实例误杀,整单被迫收口,内核还停在 verify_ut——环境
   * 修好后流程应当接着推,而不是从头再来)。
   *
   * verifying 的准入按事实收窄:只有修复环停机(halted/exhausted)
   * 或轮询预算耗尽的才许重跑——在途轮询/修复中点重跑只会重复烧
   * 流水线。停机重跑=人工背书"外部的事我办完了/值得再试":清掉
   * 停机账本,同 SHA 也给全新的修复机会(halted 的 last_sha 刹车
   * 挡的是"机器无人看管地空转",不该挡人工明确授权的再来一次)。 */
  retry(id: string): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const { status, delivery } = task.summary;
    const repairStopped = delivery?.loop?.state === "halted"
      || delivery?.loop?.state === "exhausted"
      || (delivery?.pipeline ?? "").includes("轮询预算耗尽");
    if (status === "verifying" && !repairStopped) {
      throw new NotFoundError(
        `任务 ${id} 流水线验证还在进行中,重跑会重复烧流水线;` +
        `等它收敛或停机后再说`);
    }
    if (!["completed", "failed", "verifying"].includes(status)) {
      throw new NotFoundError(
        `任务 ${id} 状态是 ${status},只有 completed/failed/停机的 verifying 可重跑`);
    }
    if (status === "verifying" && task.summary.delivery) {
      task.summary.delivery.loop = undefined;
      task.summary.delivery.pipeline = "人工重跑,待重新验证";
    }
    task.summary.status = "queued";
    delete task.summary.completed_at;
    task.summary.detail = "人工重跑,续接内核当前步骤";
    task.resume = true;
    this.persist(task);
    this.queue.push(id);
    this.bypass(undefined, "任务泵", this.pump());
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
    this.warnOffMenuAnswer(task, waiting, Object.keys(answers).length
      ? Object.values(answers) : [decision]);
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
      // 决定之后的这一轮是即发即忘:settle 自己会把异常收成"任务
      // failed",这里再兜一层——连收口都失败时,宁可只丢一条日志,
      // 也不许一个没人接的 rejection 掀掉整台服务(内网实测的死法)。
      this.bypass(task, "决定后续跑",
        this.settle(task, task.driver.resumeWithDecision(resolved)));
    } else {
      // 恢复场景:旧会话死于服务重启,决定先落袋(waiting.json 已
      // resolved),任务入队走重建会话——launch 会补登记这份决定。
      task.summary.status = "queued";
      task.summary.detail = "决定已收到,等待重建会话续跑";
      task.pendingResume = resolved;
      task.resume = true;
      this.persist(task);
      this.queue.push(task.summary.id);
      this.bypass(undefined, "任务泵", this.pump());
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

  /** 安全暂停：排队/等待人工/验证中可立即停；正在执行时只登记请求，
   * 当前工具完成并回到回合边界后再释放会话和容器。 */
  async pause(id: string, actor: string): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const status = task.summary.status;
    if (status === "paused" || status === "pausing") {
      return { ...task.summary };
    }
    if (["completed", "await_merge", "failed", "canceled"].includes(status)) {
      throw new TaskControlError(`任务 ${id} 当前是 ${status}，不能暂停`);
    }
    task.summary.control = {
      last_action: "pause",
      actor,
      at: new Date().toISOString(),
      paused_from: status,
    };
    if (status === "running") {
      task.pauseRequested = true;
      task.summary.status = "pausing";
      task.summary.detail = "正在完成当前操作，随后暂停";
      this.persist(task);
      return { ...task.summary };
    }
    task.controlEpoch += 1;
    this.removeFromQueue(id);
    await this.finishPause(task, status);
    return { ...task.summary };
  }

  /** 只允许 paused 恢复。等待人工回到决定卡，验证中回到流水线轮询，
   * 其余状态重建会话并从已有工作区/内核 current 续跑。 */
  resume(id: string, actor: string): TaskSummary {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (task.summary.status !== "paused") {
      throw new TaskControlError(
        `任务 ${id} 当前是 ${task.summary.status}，只有已暂停任务可以恢复`);
    }
    const from = task.summary.control?.paused_from ?? "running";
    task.controlEpoch += 1;
    task.pauseRequested = false;
    task.summary.control = {
      last_action: "resume",
      actor,
      at: new Date().toISOString(),
      paused_from: from,
    };
    if (from === "waiting_for_human" && task.summary.waiting) {
      task.summary.status = "waiting_for_human";
      task.summary.detail = "已恢复，等待你的决定";
      this.persist(task);
      return { ...task.summary };
    }
    if (from === "verifying" && task.summary.delivery?.sha) {
      task.summary.status = "verifying";
      task.summary.detail = "已恢复流水线状态跟踪";
      this.persist(task);
      this.bypass(task, "流水线轮询",
        this.pollPipeline(task, task.controlEpoch));
      return { ...task.summary };
    }
    task.summary.status = "queued";
    task.summary.detail = "已恢复，等待续跑";
    task.resume = from !== "queued";
    this.persist(task);
    this.queue.push(id);
    this.bypass(undefined, "任务泵", this.pump());
    return { ...task.summary };
  }

  /** 取消是不可恢复终态。先换代并落盘，再中止会话/容器；因此即使
   * 清理期间旧请求返回，读侧也会立即看到 canceled，旧回调也无权改写。 */
  async cancel(id: string, actor: string): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    const status = task.summary.status;
    if (status === "canceled") return { ...task.summary };
    if (["completed", "await_merge"].includes(status)) {
      throw new TaskControlError(`任务 ${id} 已交付，不能取消`);
    }
    task.controlEpoch += 1;
    task.pauseRequested = false;
    this.removeFromQueue(id);
    task.summary.status = "canceled";
    task.summary.detail = `已由 ${actor} 取消`;
    task.summary.control = {
      last_action: "cancel",
      actor,
      at: new Date().toISOString(),
      paused_from: status === "paused"
        ? task.summary.control?.paused_from : status,
    };
    task.summary.waiting = undefined;
    task.mission = undefined;
    this.persist(task);
    const driver = task.driver;
    const container = task.container;
    task.driver = undefined;
    task.container = undefined;
    await Promise.allSettled([
      driver?.abort() ?? Promise.resolve(),
      container?.stop() ?? Promise.resolve(),
    ]);
    driver?.dispose();
    return { ...task.summary };
  }

  private removeFromQueue(id: string): void {
    this.queue = this.queue.filter((queued) => queued !== id);
  }

  private current(task: TaskState, epoch: number): boolean {
    return task.controlEpoch === epoch && task.summary.status !== "canceled";
  }

  private async finishPause(
    task: TaskState,
    from: TaskStatus,
  ): Promise<void> {
    const driver = task.driver;
    const container = task.container;
    task.driver = undefined;
    task.container = undefined;
    task.pauseRequested = false;
    driver?.dispose();
    await (container?.stop() ?? Promise.resolve()).catch(() => undefined);
    task.summary.status = "paused";
    task.summary.detail = from === "waiting_for_human"
      ? "已暂停，恢复后继续等待决定"
      : from === "verifying"
        ? "已暂停状态跟踪，外部流水线不会被中止"
        : "已安全暂停，可从当前进度恢复";
    task.summary.control = {
      ...(task.summary.control ?? {
        last_action: "pause",
        actor: "系统",
        at: new Date().toISOString(),
      }),
      last_action: "pause",
      paused_from: from,
    };
    this.persist(task);
  }

  private async pump(): Promise<void> {
    const max = this.options.settings?.runtime().max_concurrent
      ?? this.options.maxConcurrent ?? 2;
    while (this.runningCount < max && this.queue.length) {
      const id = this.queue.shift()!;
      const task = this.tasks.get(id);
      // 控制动作可能已经把重复/陈旧队列项暂停或取消。
      if (!task || task.summary.status !== "queued") continue;
      this.runningCount += 1;
      task.summary.status = "running";
      this.persist(task);
      const epoch = task.controlEpoch;
      this.bypass(task, "任务启动", this.launch(task, epoch).finally(() => {
        this.runningCount -= 1;
        this.bypass(undefined, "任务泵", this.pump());
      }));
    }
  }

  private async launch(task: TaskState, epoch: number): Promise<void> {
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
      // 个人 Git 凭据:每次启动(含会话重建)现读现写——换了令牌,
      // 下一次启动就用新的;凭据文件在 agentDir,不进仓库克隆。
      // 凭据也带 commit 署名(用户名/邮箱),克隆时写进仓库配置。
      const gitIdentity =
        this.options.gitCredential?.(task.summary.luban_account);
      const gitHelper = gitIdentity
        ? this.prepareGitCredential(agentDir, gitIdentity) : undefined;
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
        cwd = resuming
          ? savedCwd!
          : this.cloneRepo(workspace, gitHelper, gitIdentity,
              task.summary.repo_url);
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
        if (!this.current(task, epoch)) return;
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
      if (this.effectiveVerifyViaPipeline()) {
        prompt = `${prompt}\n\n环境事实(宿主声明):本机没有编译/测试工具链,`
          + `也不提供容器构建,不要在本机尝试编译或运行 UT——只会浪费轮次。`
          + `本会话已带的 UT skill(如 autout/java-autout,见系统提示里的`
          + `可用 skill 清单)是**写法指南,照用**`
          + `——按它的方法写测试;只是它里面"编译通过""执行构建"那类段落`
          + `在这台机器上做不到,跳过即可,不要为此找工具。`
          + `build-fix 这类纯构建 skill 云端用不上,不要调用;`
          + `CodeCheck 亦不在本机执行。内核在云端形态下(MAE_FLOW_HOST=cloud)`
          + `不再要求这些本地执行证据,报告如实写「本地未编译/未运行,`
          + `交流水线」即可放行。`
          + `**没跑就不许报数字**:不要编造 BUILD_ERRORS 或 `
          + `TESTS_TOTAL/PASSED/FAILED——编了就是谎,门禁另有守卫。`
          + `UT 该写还得写(生成测试是本机做得了、也最值钱的部分),`
          + `只是不在本机跑。编码完成后按流程提交并推送,`
          + `权威流水线是唯一裁判;红灯会由专职修复会话跟进。`;
      }
      // 提交信息规范(部署级):平台的 pre-receive 钩子会按正则拒收不
      // 合规的提交信息——内网实测被拒过一次("does not match the
      // regular-expression"),而那时代码早已写完,重来一遍是纯浪费。
      // 规矩必须开场就给,每个会话都带:修复会话同样要提交。
      const convention = this.effectiveCommitConvention();
      if (convention) {
        prompt = `${prompt}\n\n提交信息规范(平台钩子会按它校验,不合规`
          + `直接拒收 push,请第一次就写对):${convention}`;
      }
      // 仓库地图(加餐):大仓里模型乱 grep 烧轮次,开场先给一张按被
      // 引用程度排序的路标。只在内核模式生成(有真克隆才有仓可画);
      // 每次会话都重画——修复/重建会话面对的是改动后的工作区,旧图作废。
      // fail-open:空地图不上桌,带预算绝不拖住启动(不卡死红线)。
      if (this.options.host) {
        const repoMap = buildRepoMap(cwd);
        if (repoMap.markdown) prompt = `${prompt}\n\n${repoMap.markdown}`;
        // 仓里的知识块:命中触发词才注入(知识在仓不在平台,换个仓
        // 就是换套知识)。匹配语料 = 需求原文 + 本轮失败详情——修复
        // 会话该被日志里的关键词(如 flyway/覆盖率)召唤出对应规矩。
        const knowledge = collectKnowledge(
          cwd,
          [task.summary.requirement,
           task.summary.delivery?.loop?.failure ?? ""]
            .join("\n"),
        );
        if (knowledge.markdown) prompt = `${prompt}\n\n${knowledge.markdown}`;
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
        // 其绝对路径,只读)与 Git 远端——但只有本地路径仓(演示裸仓)
        // 才需要挂载;URL 仓走网络,拿路径当挂载参数只会喂 docker 垃圾。
        const effectiveRepo =
          task.summary.repo_url ?? this.effectiveDefaultRepo();
        const hostMounts = this.options.host
          ? [
              `${this.options.host.kernelRoot}:${this.options.host.kernelRoot}:ro`,
              ...(effectiveRepo && existsSync(effectiveRepo)
                ? [`${effectiveRepo}:${effectiveRepo}`] : []),
            ]
          : [];
        task.container = new TaskContainer(
          image, cwd, `mfc-${instance}-${task.summary.id}`,
          this.options.log,
          [...hostMounts, ...(volumes ?? [])], { memory, cpus, user });
        await task.container.start();
        if (!this.current(task, epoch)) {
          await task.container.stop().catch(() => undefined);
          task.container = undefined;
          return;
        }
      }
      task.driver = await CloudSession.create({
        taskId: task.summary.id,
        workspace: cwd,
        agentDir,
        // 宿主级 skill:<数据目录>/skills 放一次,每个任务都带
        // (团队的 UT 写法指南在内网,老宿主靠手动集成进子 agent)。
        hostSkillsDir: join(this.options.dataDir, "skills"),
        // 上下文撑爆时自愈压缩用的锚:与主动压缩同一个内核现场,
        // 摘要围绕"当前步骤+已确认配置"组织,不由云端编造。
        compactAnchor: () => this.kernelAnchor(task),
        // 任务级选择 > 设置层默认 > 部署默认;任务级的记在 summary 上,
        // 重启续跑/会话重建都不漂移(设置层后来改了也不影响本单)。
        provider: task.summary.model_choice?.provider
          ?? modelOverride.provider ?? this.options.provider,
        model: task.summary.model_choice?.model
          ?? modelOverride.model ?? this.options.model,
        eventLog: new EventLog(
          join(workspace, "events.jsonl"),
          (event) => this.bypass(
            task, "投影事件", this.options.projection?.appendEvent(event))),
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
      if (!this.current(task, epoch)) {
        task.driver.dispose();
        task.driver = undefined;
        await (task.container?.stop() ?? Promise.resolve())
          .catch(() => undefined);
        task.container = undefined;
        return;
      }
      if (task.pauseRequested || task.summary.status === "pausing") {
        await this.finishPause(task, "running");
        return;
      }
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
        : task.driver.start(prompt), epoch);
    } catch (error) {
      if (!this.current(task, epoch)) return;
      task.summary.status = "failed";
      task.summary.detail = String(error);
      this.bypass(task, "容器清理", task.container?.stop());
      this.persist(task);
      this.options.log?.(`任务 ${task.summary.id} 启动失败: ${String(error)}`);
    }
  }

  /** 平台请求的个人身份头:适配层拿它调 CLI,MR 发起人=任务归属人;
   * 没配令牌的回落适配层的服务账号。percent 编码防非 ASCII 撞 HTTP
   * 头限制;**令牌只进请求头,绝不进请求体**——体会被外部动作台账
   * 原样记进投影,头不会。 */
  private platformIdentity(task: TaskState): Record<string, string> {
    const credential =
      this.options.gitCredential?.(task.summary.luban_account);
    if (!credential) return {};
    return {
      "x-mfc-git-user": encodeURIComponent(credential.username),
      "x-mfc-git-token": encodeURIComponent(credential.password),
    };
  }

  /** Git 交付(§10):任务收轮后,分支已推到远端才建 MR——交付事实
   * 全部来自远端真实状态(ls-remote),不信任务自己的说法。
   * MR 成功≠完成:流水线过了才"等待合入",否则停在"验证中"。
   * 交付失败不吞:原因写进 summary.delivery,任务保持 completed。 */
  private async tryDeliver(task: TaskState, epoch: number): Promise<void> {
    // 平台地址热改(管理页压部署 flag):每次交付动作现读现用。
    const platformUrl = this.effectivePlatformUrl();
    if (!platformUrl || !this.options.host || !task.cwd) return;
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
      // 修复回程的岔路:SHA 没变说明本轮没有新代码(检视修复只回复
      // 不改码、或修复会话判断无需改动)。这时**绝不再触发流水线**
      // ——远端每跑一条流水线都是钱,同 SHA 重跑还是同一个结果。
      // 上一轮绿 → 直接回门禁监控;上一轮红 → 重新分类裁决
      // (检视清了之后可能轮到 CI 修,brake 按类各管各的)。
      const previous = task.summary.delivery;
      if (previous?.sha === sha && previous.pipeline) {
        if (previous.pipeline === "success") {
          task.summary.status = "await_merge";
          this.persist(task);
          this.bypass(task, "合入监控", this.watchMerge(task, epoch));
          return;
        }
        if (previous.pipeline.startsWith("failed")) {
          // 老路径里状态由触发块扳到 verifying,这条岔路必须自己扳——
          // 不扳的话 settle 会把还红着的任务误收成 completed(实测)。
          task.summary.status = "verifying";
          await this.pipelineVerdict(task, sha, "failed",
            previous.loop?.failure ?? "", epoch);
          return;
        }
      }
      // 外部动作台账(§11):请求先落一行(带幂等键),结果回来再补
      // 结果侧——恢复时"先查远端真实状态"就有底账可对。纯旁路。
      const ledger = (action: Omit<ExternalAction, "taskId">) =>
        this.bypass(task, "投影动作", this.options.projection?.recordAction(
          { taskId: task.summary.id, ...action }));
      const mrRequest = {
        // 任务级仓进了场,适配层必须知道这单落在哪个仓——
        // repo 字段随 MR/流水线请求走,假件(单仓)忽略它无害。
        repo: task.summary.repo_url ?? this.effectiveDefaultRepo(),
        source_branch: branch,
        target_branch: baseline,
        title: `${state?.config?.["单号"] ?? branch}: ${task.summary.requirement.slice(0, 60)}`,
      };
      const mrKey = `mr:${branch}->${baseline}`;
      const mrStarted = new Date().toISOString();
      ledger({ idemKey: mrKey, kind: "mr_create", request: mrRequest,
               sha, startedAt: mrStarted });
      const mr = await fetch(`${platformUrl}/mr`, {
        method: "POST",
        headers: this.platformIdentity(task),
        body: JSON.stringify(mrRequest),
      }).then((r) => {
        if (!r.ok) throw new Error(`MR 创建失败 HTTP ${r.status}`);
        return readJson(r);
      });
      if (!this.current(task, epoch)) return;
      ledger({ idemKey: mrKey, kind: "mr_create", request: mrRequest,
               sha, startedAt: mrStarted, result: mr,
               finishedAt: new Date().toISOString() });
      const runKey = `pipeline:${sha}`;
      const runStarted = new Date().toISOString();
      const runRequest = { sha, repo: mrRequest.repo };
      ledger({ idemKey: runKey, kind: "pipeline_trigger",
               request: runRequest, sha, startedAt: runStarted });
      const run = await fetch(`${platformUrl}/pipeline/trigger`, {
        method: "POST",
        headers: this.platformIdentity(task),
        body: JSON.stringify(runRequest),
      }).then((r) => readJson(r));
      if (!this.current(task, epoch)) return;
      ledger({ idemKey: runKey, kind: "pipeline_trigger",
               request: runRequest, sha, startedAt: runStarted, result: run,
               finishedAt: new Date().toISOString() });
      task.summary.delivery = {
        ...(task.summary.delivery?.loop
          ? { loop: task.summary.delivery.loop } : {}),
        mr_url: mr.url,
        // 平台给了 MR 标识就记下:门禁/讨论查询要带回去(假件给 id,
        // codehubcli 给 iid;没有也不碍事,适配层还能按分支对查)。
        ...(mr.id !== undefined ? { mr_id: mr.id } : {}),
        source_branch: branch,
        target_branch: baseline,
        mr_state: run.status === "success" ? "等待合入" : "验证中",
        pipeline: run.status,
        sha,
      };
      task.summary.status =
        run.status === "success" ? "await_merge" : "verifying";
      // 终态当场裁决;running 不是结局,由带预算的轮询收敛后再裁。
      if (run.status === "running") {
        this.bypass(task, "流水线轮询", this.pollPipeline(task, epoch));
      } else {
        await this.pipelineVerdict(task, sha,
          run.status === "success" ? "success" : "failed",
          String(run.log ?? ""), epoch);
      }
    } catch (error) {
      if (!this.current(task, epoch)) return;
      task.summary.delivery = { skipped: `交付动作失败: ${String(error)}` };
      this.options.log?.(`任务 ${task.summary.id} 交付失败: ${String(error)}`);
    }
  }

  /** 流水线异步收敛:轮询 status?sha= 直到终态或预算耗尽。
   * - 结果只认绑定 SHA 的运行(旧绿灯不背书新代码);
   * - 查询失败 fail-open 继续轮,预算兜底——绝不无限等(红线);
   * - 预算耗尽留痕请人工,任务停在 verifying,不假装有结论;
   * - 终态落袋:状态/台账/通知一次收口,幂等锚是任务当前状态。 */
  private async pollPipeline(task: TaskState, epoch: number): Promise<void> {
    const delivery = this.options.delivery;
    const sha = task.summary.delivery?.sha;
    if (!this.effectivePlatformUrl() || !sha) return;
    const knobs = this.options.settings?.runtime() ?? {};
    const interval = (knobs.poll_interval_s !== undefined
      ? knobs.poll_interval_s * 1000 : undefined)
      ?? delivery?.pollIntervalMs ?? 10_000;
    const deadline = Date.now() + ((knobs.poll_timeout_s !== undefined
      ? knobs.poll_timeout_s * 1000 : undefined)
      ?? delivery?.pollTimeoutMs ?? 30 * 60_000);
    while (Date.now() < deadline) {
      // unref:轮询是旁路,不许它吊着进程不退(进程要退就让它退,
      // 重启后 recover 会以 delivery.sha 为锚续轮)。
      await new Promise((tick) => setTimeout(tick, interval).unref());
      if (!this.current(task, epoch)
          || task.summary.status !== "verifying") return; // 已被别处推进
      let terminal;
      try {
        const repo = encodeURIComponent(
          task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "");
        const status = await fetch(
          `${this.effectivePlatformUrl()}/pipeline/status`
          + `?sha=${sha}&repo=${repo}`,
          { headers: this.platformIdentity(task) })
          .then((r) => readJson(r));
        if (!this.current(task, epoch)
            || task.summary.status !== "verifying") return;
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
      this.bypass(task, "投影动作", this.options.projection?.recordAction({
        taskId: task.summary.id,
        idemKey: `pipeline:${sha}`,
        kind: "pipeline_trigger",
        request: { sha },
        result: terminal,
        sha,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }));
      // 终态交给裁决点:绿=收口通知;红=修复环决定下一步。
      // (persist/notify 都在裁决点里,别在这儿重复收口。)
      await this.pipelineVerdict(task, sha,
        terminal.status === "success" ? "success" : "failed",
        String(terminal.log ?? ""), epoch);
      return;
    }
    if (!this.current(task, epoch)
        || task.summary.status !== "verifying") return;
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
   *   红 → 同一 SHA 修过一轮又红 = 修复会话没产生新提交 → halted,
   *       会话的收口发言当诊断带给人(它判了"改代码解决不了");
   *       修复轮预算(可配手刹,默认不限)耗尽 → exhausted 请人工;
   *       否则派专职修复会话:使命=分诊后按类修绿(可派专职子 agent),
   *       任务重入队,修完 settle→tryDeliver 自然触发新 SHA 的新流水线
   *       ——环由现有机械闭合,这里只记账和扳道岔。
   * 常规收口通知仍归两个调用方;halted/exhausted 例外,在这儿主动
   * 喊人(带独立幂等键)——轮询路径收敛到停机时没有别的收口点。
   */
  private async pipelineVerdict(
    task: TaskState,
    sha: string,
    status: "success" | "failed",
    log: string,
    epoch: number,
  ): Promise<void> {
    if (!this.current(task, epoch)) return;
    const delivery = task.summary.delivery;
    if (!delivery) return;
    if (status === "success") {
      if (delivery.loop) delivery.loop.state = "green";
      this.persist(task);
      // 证据口在状态转移之后:平台事实喂给内核绑 HEAD 裁决
      // (PASS/RED/STALE),"编译/UT 推迟给流水线"的承诺从此有物证。
      // 记账是旁路——绿灯不等记账,先扳道再登记(先登记的话轮询侧
      // 已置 await_merge,外面会在记账空窗里看到半新不旧的环账,实测
      // 逮过);内核调不动只留痕"未裁决",绝不拦收口。
      await this.recordPipelineEvidence(task, sha, status);
      if (!this.current(task, epoch)) return;
      this.persist(task);
      // 流水线绿≠赢了:九项门禁全过 + 合入才是终点(内网既有框架的
      // 实证)。支持门禁契约的平台接着盯;不支持的(fetchGates 回
      // undefined)保持旧语义——await_merge 即收口,一字不变。
      this.bypass(task, "合入监控", this.watchMerge(task, epoch));
      return;
    }
    // 红灯也过证据口(RED/STALE 照记):留的是最近一次终态的物证。
    await this.recordPipelineEvidence(task, sha, status);
    if (!this.current(task, epoch)) return;
    // 三层覆盖:任务 > 设置 > 部署;全都没配 = 不限轮(用户拍板
    // "不该有最大轮数限制"),0 = 关。真正兜住无限的是收敛刹车:
    // 没新提交即停 + 无进展必须换思路或出诊断(使命里的纪律)。
    const max = task.summary.repair_rounds
      ?? this.options.settings?.runtime().repair_rounds
      ?? this.options.delivery?.repairRounds;
    // repairRounds=0 = 关掉修复环:保持旧语义(红灯留痕请人工),不记环账。
    if (max === 0 && !delivery.loop) {
      this.persist(task);
      return;
    }
    // 失败先分类再派单(检视>冲突>CI,同时多项只修最高优先级那一路)。
    // 门禁不可得(平台不支持/查询失败)时按 CI 处理——正是旧语义。
    const view = await this.fetchGates(task);
    if (!this.current(task, epoch)) return;
    if (view?.mrState === "merged" || view?.mrState === "closed") {
      this.settleMergeState(task, view.mrState);
      return;
    }
    const sorted = view
      ? classifyGates(view.gates) : { repairs: [], waiting: [] };
    // 按优先级顺序找第一条派得出去的路。检视"已回复等检视人确认"
    // 不占路(报告 D3:平台不代人 resolve,红着只是没人点)——落到
    // 下一优先级继续,别让等人把 CI 修复堵死。
    for (const candidate of sorted.repairs) {
      if (candidate.kind === "review") {
        const outcome = await this.dispatchReviewRepair(task, max, epoch);
        if (!this.current(task, epoch)) return;
        if (outcome === "waiting" || outcome === "skip") continue;
        return; // dispatched/halted 都已各自收口
      }
      if (candidate.kind === "conflict") {
        this.dispatchConflictRepair(task, sha, max, epoch);
        return;
      }
      await this.dispatchCiRepair(task, sha,
        log || (candidate.gate.detail ?? ""), max, epoch);
      return;
    }
    // 没有可派的修复路(门禁不可得,或可修门禁都在等人):按旧语义
    // 走 CI 修复——流水线红是实锤,同 SHA 刹车会兜住原地打转。
    await this.dispatchCiRepair(task, sha, log, max, epoch);
  }

  /** CI 修复派单(修复环的老主路):同 SHA 不二修、轮数预算、
   * 分诊+定位使命。唯一会累加 round 的一路——检视/冲突是流程性
   * 问题,不许耗掉代码修复的额度。 */
  private async dispatchCiRepair(
    task: TaskState,
    sha: string,
    log: string,
    max: number | undefined,
    epoch: number,
  ): Promise<void> {
    if (!this.current(task, epoch)) return;
    const delivery = task.summary.delivery!;
    const loop = delivery.loop
      ?? (delivery.loop = { round: 0, max, state: "repairing" as const });
    if (loop.kind === "ci" && loop.last_sha === sha) {
      // 修复会话没产生新提交 = 会话自己判了"改代码解决不了"。
      // 它的收口发言就是诊断(缺什么、去哪配),原文带给人,
      // 别让人拿着一句"已停"再去翻日志猜。
      loop.state = "halted";
      const diagnosis = (task.lastReply ?? "").trim();
      if (diagnosis) loop.diagnosis = diagnosis.slice(0, 2000);
      delivery.pipeline = "failed(自动修复已停,需人工)";
      task.summary.detail = diagnosis
        ? `自动修复停下,修复会话的诊断:${diagnosis.slice(0, 600)}`
        : "修复会话未产生新提交,流水线仍红,请人工查看流水线日志";
      this.persist(task);
      this.notifyRepairStopped(task);
      return;
    }
    if (loop.max !== undefined && loop.round >= loop.max) {
      loop.state = "exhausted";
      delivery.pipeline = `failed(${loop.max} 轮修复预算用完,请人工)`;
      task.summary.detail =
        `${loop.max} 轮修复预算用完,流水线仍红,请人工`;
      this.persist(task);
      this.notifyRepairStopped(task);
      return;
    }
    // 上一轮的失败详情留一份给新使命对比——"和上轮同一处打转"是
    // 换思路/出诊断的触发条件,这个判断只有会话自己做得可靠。
    const previousFailure = loop.round > 0 ? loop.failure : undefined;
    loop.round += 1;
    loop.last_sha = sha;
    loop.kind = "ci";
    loop.state = "repairing";
    loop.failure = log.slice(0, 2000) || "(平台未提供失败详情)";
    // 批2 双通道:摘要进使命(下面),完整日志落盘工作区外 pipeline/
    // 让修复会话自读——2000 字摘要装不下多类问题并发的全部原料。
    const artifacts = await this.mirrorPipelineArtifacts(task);
    if (!this.current(task, epoch)) return;
    const roundText = loop.max !== undefined
      ? `第 ${loop.round}/${loop.max} 轮` : `第 ${loop.round} 轮`;
    delivery.pipeline = `failed(${roundText}修复中)`;
    task.mission = [
      `流水线红了,把它修到绿是你此刻唯一的使命(${roundText}修复):`,
      `- 分支上提交 ${sha} 的权威流水线结果是 failed。失败详情(平台原文):`,
      loop.failure,
      ...(artifacts.length ? [
        `- 完整失败材料已镜像到 ../pipeline/(仓库外,不会进提交),`
        + `分诊与定位先读它们,别只凭上面的摘要猜:`,
        ...artifacts.map((name) => `  ../pipeline/${name}`),
      ] : []),
      ...(previousFailure ? [
        `- 上一轮修复后流水线仍红,上一轮的失败详情如下,先对比再动手:`
        + `若与本轮是同一处原地打转,说明上轮改法无效,必须换思路;`
        + `换思路也解决不了的,走下面的诊断出口,不许重复同样的修改。`,
        previousFailure,
      ] : []),
      `- 先分诊再动手:通读日志,列出本轮暴露的全部问题类别`
      + `(编译报错/编译告警/UT 失败/UT 覆盖率不够/CodeCheck/其他),`
      + `一轮把能修的全修完,不留尾巴等下一轮。`,
      // 定位先于修改(Agentless 的固定管线在修 bug 上打赢自由 agent
      // 循环):逼一句"依据"出来,是为了让定位错当场暴露——说不出
      // 依据的定位多半是猜的,猜着改就是拿流水线当调试器。
      `- 定位先于修改:每一类问题先落到具体文件与函数/测试用例,`
      + `并写明定位依据(日志里的哪一行、堆栈的哪一帧、覆盖率报告的`
      + `哪个类)。依据说不出来就说明还没定位到,继续查,不许凭猜改;`
      + `日志指向的位置与真正的病根不一致时,以病根为准并说明推断链。`,
      `- 按类修复,能派专职子 agent 的派专职去修:编译类、UT/覆盖率类、`
      + `检视类各修各的,互不搅和;派单时把上面定位到的文件与依据`
      + `一并交给它,别让它从头再查一遍。`,
      `- 修复纪律:补覆盖率要写真测试,不许凑数骗指标;CodeCheck 修问题`
      + `本身,不许加抑制注释糊弄;编译告警要消除,不是关闭告警。`,
      `- 全部修完凑成一次提交,收尾时一次 push(不 push 等于没修):`
      + `远端每收到一次 push 就要烧一整条流水线,修一个推一个`
      + `等于拿流水线当调试器——中途绝不 push。`
      + `别的都不要动,顺手的重构、无关的优化一律不做。`,
      `- 诊断出口:凡不是本仓代码能修的(外部平台的配置、权限、环境、`
      + `流水线自身的问题),那一类不要硬改碰运气;若所有问题都不可修,`
      + `不要提交,把诊断写清楚:缺什么、要去哪配、配好之后如何重跑`
      + `——没有新提交时系统会带着你的诊断如实停下请人工,`
      + `这是正确结局之一,不是失败。`,
    ].join("\n");
    task.summary.status = "queued";
    task.summary.detail = `流水线红,${roundText}修复排队中`;
    task.resume = true;
    this.persist(task);
    this.queue.push(task.summary.id);
    // 不能当场 pump:这里可能正处在 settle→tryDeliver 的调用链里,而
    // pump 会同步把状态置成 running,settle 随后那句"running→completed"
    // 就把修复轮当场盖掉(读代码逮住的竞态)。setImmediate 排到微任务链
    // 之后,settle 收完自己的账、原会话的 finally 归还并发额度,再派单。
    setImmediate(() => this.bypass(undefined, "任务泵", this.pump()));
  }

  /** 门禁视图:平台不支持(404/没配分支对)或查询失败一律回
   * undefined——调用方按"旧语义"处理,绝不让门禁查询卡死闭环。
   * 形状校验从严:name/passed 类型不对的项直接丢弃,宿主不猜。 */
  private async fetchGates(task: TaskState): Promise<GateView | undefined> {
    const platformUrl = this.effectivePlatformUrl();
    const delivery = task.summary.delivery;
    if (!platformUrl || !delivery?.source_branch
        || !delivery.target_branch) {
      return undefined;
    }
    try {
      const params = new URLSearchParams({
        repo: task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "",
        source_branch: delivery.source_branch,
        target_branch: delivery.target_branch,
      });
      if (delivery.mr_id !== undefined) {
        params.set("mr", String(delivery.mr_id));
      }
      const response = await fetch(
        `${platformUrl}/mr/gates?${params}`,
        { headers: this.platformIdentity(task) });
      if (response.status === 404) return undefined; // 平台不支持门禁契约
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await readJson(response);
      const gates: GateItem[] = (Array.isArray(body.gates) ? body.gates : [])
        .filter((gate: any) => typeof gate?.name === "string"
          && typeof gate?.passed === "boolean")
        .map((gate: any) => ({
          name: gate.name,
          passed: gate.passed,
          ...(gate.detail ? { detail: String(gate.detail) } : {}),
        }));
      const mrState = body.mr_state === "merged" || body.mr_state === "closed"
        ? body.mr_state : "opened";
      return { mrState, gates };
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 门禁查询失败(按不可得处理): ${String(error)}`);
      return undefined;
    }
  }

  /** MR 平台侧终态:merged=任务真正的赢(比 await_merge 更进一步),
   * closed=被人关掉(不是系统能修的,如实 failed 请人看)。 */
  private settleMergeState(
    task: TaskState,
    state: "merged" | "closed",
  ): void {
    const delivery = task.summary.delivery!;
    if (state === "merged") {
      if (delivery.loop) delivery.loop.state = "green";
      delivery.mr_state = "已合入";
      delivery.waiting_on = undefined;
      task.summary.status = "completed";
      task.summary.detail = "MR 已合入,交付完成";
      this.persist(task);
      const account = task.summary.luban_account;
      if (this.options.notifier && account) {
        this.bypass(task, "收口通知", this.options.notifier.notifyOutcome({
          taskId: task.summary.id,
          account,
          status: "merged",
          summary: `MR 已合入`
            + (delivery.mr_url ? `:${delivery.mr_url}` : ""),
          link: personalTaskLink(
            this.options.linkBase, account, task.summary.id),
        }));
      }
      return;
    }
    delivery.mr_state = "已关闭";
    task.summary.status = "failed";
    task.summary.detail = "MR 被关闭(未合入),请人工确认原因";
    this.persist(task);
    this.notifyOutcome(task);
  }

  /** 合入监控环:流水线绿之后接着盯门禁与 MR 状态,直到合入/关闭/
   * 出现可修失败/预算耗尽。内网既有框架的"挂起等待"语义在这里:
   * 等审批/投票不是异常,保持监控、告诉人卡在哪,不空转不扣重试。
   * 平台不支持门禁契约时本方法一轮就退——await_merge 即收口(旧语义)。 */
  private async watchMerge(task: TaskState, epoch: number): Promise<void> {
    if (task.mergeWatchActive) return; // 防重入:一任务一环
    task.mergeWatchActive = true;
    try {
      const knobs = this.options.settings?.runtime() ?? {};
      const interval = (knobs.poll_interval_s !== undefined
        ? knobs.poll_interval_s * 1000 : undefined)
        ?? this.options.delivery?.pollIntervalMs ?? 10_000;
      const deadline = Date.now() + ((knobs.poll_timeout_s !== undefined
        ? knobs.poll_timeout_s * 1000 : undefined)
        ?? this.options.delivery?.pollTimeoutMs ?? 30 * 60_000);
      while (Date.now() < deadline) {
        if (!this.current(task, epoch)
            || task.summary.status !== "await_merge") return;
        const view = await this.fetchGates(task);
        if (!this.current(task, epoch)
            || task.summary.status !== "await_merge") return;
        if (!view) return; // 平台不支持/暂不可得:保持旧语义收口
        if (view.mrState === "merged" || view.mrState === "closed") {
          this.settleMergeState(task, view.mrState);
          return;
        }
        const sorted = classifyGates(view.gates);
        if (sorted.repairs.length) {
          // 绿灯后门禁又亮红:检视/冲突照常派;CI 红说明平台侧又跑了
          // 一条流水线(目标分支动了之类),失败详情用门禁给的话。
          // 检视"已回复等检视人确认"不派单也不停环——归入等待名单,
          // 继续盯下一优先级和 MR 状态(报告 D3 的语义)。
          const max = task.summary.repair_rounds
            ?? this.options.settings?.runtime().repair_rounds
            ?? this.options.delivery?.repairRounds;
          if (max === 0) return; // 修复环关着:留在 await_merge 请人工
          const sha = task.summary.delivery?.sha ?? "";
          for (const candidate of sorted.repairs) {
            if (candidate.kind === "review") {
              const outcome =
                await this.dispatchReviewRepair(task, max, epoch);
              if (!this.current(task, epoch)
                  || task.summary.status !== "await_merge") return;
              if (outcome === "waiting") {
                sorted.waiting.push("等检视人确认已回复的意见");
                continue;
              }
              if (outcome === "skip") continue;
              return; // dispatched/halted 都已各自收口
            }
            if (candidate.kind === "conflict") {
              this.dispatchConflictRepair(task, sha, max, epoch);
              return;
            }
            await this.dispatchCiRepair(task, sha,
              candidate.gate.detail ?? "门禁 ci_state_passed 未通过",
              max, epoch);
            return;
          }
        }
        const waitingText = sorted.waiting.join("、");
        if (waitingText !== (task.summary.delivery?.waiting_on ?? "")) {
          task.summary.delivery!.waiting_on = waitingText || undefined;
          task.summary.detail = waitingText
            ? `门禁与流水线已过,MR 在${waitingText}`
            : "门禁全绿,等待合入";
          this.persist(task);
          // 等人的事要告诉人(幂等键=门禁集合,同一批等待只提醒一次;
          // 换了一批等待项才再响)。
          const account = task.summary.luban_account;
          if (waitingText && this.options.notifier && account) {
            this.bypass(task, "等待通知",
              this.options.notifier.notifyOutcome({
              taskId: task.summary.id,
              account,
              status: `waiting:${sorted.waiting.sort().join("+")}`,
              summary: `MR 在${waitingText},需要相关人处理`
                + (task.summary.delivery?.mr_url
                  ? `:${task.summary.delivery.mr_url}` : ""),
              link: personalTaskLink(
                this.options.linkBase, account, task.summary.id),
            }));
          }
        }
        await new Promise((tick) => setTimeout(tick, interval).unref());
      }
      // 预算耗尽:不是错误(MR 还开着),但监控停了要明说。
      if (this.current(task, epoch)
          && task.summary.status === "await_merge") {
        task.summary.detail =
          `合入监控预算耗尽,MR 仍未合入(${task.summary.delivery?.waiting_on
            ?? "原因见平台"}),请人工留意`;
        this.persist(task);
      }
    } finally {
      task.mergeWatchActive = false;
    }
  }

  /** 检视修复派单(批3):拉未解决讨论→落盘 reviews/→专职会话逐条
   * 处理并写 ../review_replies.md→收口后宿主发布回复(默认不代
   * resolve,报告 D3)。不扣 CI 重试且清零(流程性问题不许耗掉代码
   * 修复额度)。同一批讨论 id 分两种结局:回复都发布过了=等检视人
   * 确认(waiting,调用方落到下一优先级继续);一条都没答复=会话
   * 没干活,真刹车(halted)。 */
  private async dispatchReviewRepair(
    task: TaskState,
    max: number | undefined,
    epoch: number,
  ): Promise<"dispatched" | "waiting" | "halted" | "skip"> {
    if (!this.current(task, epoch)) return "skip";
    const delivery = task.summary.delivery!;
    const loop = delivery.loop
      ?? (delivery.loop = { round: 0, max, state: "repairing" as const });
    const discussions = await this.fetchDiscussions(task);
    if (!this.current(task, epoch)) return "skip";
    if (!discussions.length) {
      // 门禁说未解决但明细拉不到:可能是刚解决的竞态,别硬派——
      // 让调用方落到下一优先级,下一轮监控再看这路。
      this.options.log?.(
        `任务 ${task.summary.id} 检视门禁未过但拉不到未解决讨论,等下一轮`);
      return "skip";
    }
    const ids = discussions.map((item) => item.id).sort().join(",");
    if (loop.kind === "review" && loop.review_ids === ids) {
      if (loop.replied_ids === ids) {
        // 这批意见的回复都发布过了,门禁红只是检视人还没点"已解决"
        // ——那是等人,不是修不动。不派单不停环,调用方把它记进
        // waiting_on 继续盯。
        return "waiting";
      }
      loop.state = "halted";
      const diagnosis = (task.lastReply ?? "").trim();
      if (diagnosis) loop.diagnosis = diagnosis.slice(0, 2000);
      task.summary.detail =
        "同一批检视意见处理过一轮仍未答复完,请人工查看 MR 讨论";
      this.persist(task);
      this.notifyRepairStopped(task);
      return "halted";
    }
    loop.kind = "review";
    loop.round = 0; // 检视触发清零 CI 重试(内网框架的实证语义)
    loop.review_ids = ids;
    loop.replied_ids = undefined; // 新一批意见,答复台账从零记
    loop.state = "repairing";
    // 意见落盘 reviews/(仓库外):原始数据给 agent 自读,摘要进使命。
    const reviewsDir = join(task.summary.workspace, "reviews");
    try {
      rmSync(reviewsDir, { recursive: true, force: true });
      mkdirSync(reviewsDir, { recursive: true });
      writeFileSync(join(reviewsDir, "discussions.json"),
        JSON.stringify(discussions, null, 2));
    } catch {
      /* 落盘失败不拦路:使命里的摘要仍然够用 */
    }
    const lines = discussions.map((item) =>
      `  [${item.id}] ${item.file ?? "(整体意见)"}`
      + `${item.line !== undefined ? `:${item.line}` : ""}`
      + `${item.severity ? ` (${item.severity})` : ""}`
      + `${item.author ? ` ${item.author}` : ""}:`
      + ` ${String(item.body ?? "").slice(0, 300)}`);
    this.enqueueRepair(task,
      [
        `MR 上有 ${discussions.length} 条检视意见未解决,`
        + `逐条处理它们是你此刻唯一的使命:`,
        ...lines,
        `- 原始数据在 ../reviews/discussions.json(仓库外),需要完整`
        + `上下文时自己读。`,
        `- 意见对的就改代码,意见基于误解的不改——但必须说清依据,`
        + `不许含糊带过;不确定的按意见改(检视人对本仓比你熟)。`,
        `- 把逐条回复写到 ../review_replies.md(仓库外,不会进提交),`
        + `格式严格如下,每条以方括号 id 单独一行开头:`,
        `  [${discussions[0].id}]`,
        `  <这条的回复:改了什么/为什么不改,一两句讲清>`,
        `- 有代码改动就凑成一次提交并 push(一次修全一次推);`
        + `全部是解释、没有代码改动就不提交——这也是正常结局。`,
        `- 系统会把你的回复发布到对应讨论(是否代点"已解决"由部署配置`
        + `决定,默认留给检视人点),回复写给检视人看,说人话,`
        + `别写流程黑话。`,
      ].join("\n"),
      `检视意见 ${discussions.length} 条,专职会话处理中`);
    return "dispatched";
  }

  /** 冲突修复派单(批4):宿主先 merge 目标分支**故意把冲突标记留在
   * 工作区**,让 agent 在真实冲突上下文里解,而不是凭描述想象
   * (内网框架里最值得抄的一条)。merge 干净=没有真冲突,宿主直接
   * push 合并提交回监控,不烧会话。刹车=同 SHA 不二修。 */
  private dispatchConflictRepair(
    task: TaskState,
    sha: string,
    max: number | undefined,
    epoch: number,
  ): void {
    if (!this.current(task, epoch)) return;
    const delivery = task.summary.delivery!;
    const target = delivery.target_branch;
    if (!task.cwd || !target) return;
    const loop = delivery.loop
      ?? (delivery.loop = { round: 0, max, state: "repairing" as const });
    if (loop.kind === "conflict" && loop.last_sha === sha) {
      loop.state = "halted";
      const diagnosis = (task.lastReply ?? "").trim();
      if (diagnosis) loop.diagnosis = diagnosis.slice(0, 2000);
      task.summary.detail =
        "冲突修复会话没有产生新提交,冲突仍在,请人工处理";
      this.persist(task);
      this.notifyRepairStopped(task);
      return;
    }
    const git = (...args: string[]) => spawnSync(
      "git", args, { cwd: task.cwd, encoding: "utf-8" });
    const fetched = git("fetch", "origin", target);
    if (fetched.status !== 0) {
      task.summary.detail =
        `冲突修复准备失败(fetch ${target}):${(fetched.stderr || "").slice(0, 300)}`;
      this.persist(task);
      return; // 环境问题不硬闯,留痕等人(或下一轮监控重试)
    }
    const merged = git("merge", "--no-edit", `origin/${target}`);
    if (merged.status === 0) {
      // 干净合并:没有真冲突(门禁可能滞后)。宿主直接推合并提交——
      // 纯机械动作,不含判定;推完回交付链跑新流水线。
      const pushed = git("push", "origin", "HEAD");
      if (pushed.status === 0) {
        loop.kind = "conflict";
        loop.last_sha = sha;
        task.summary.detail = "与目标分支干净合并,已推送,等新流水线";
        this.persist(task);
        setImmediate(() => void this.tryDeliver(task, epoch));
      } else {
        git("merge", "--abort");
        task.summary.detail =
          `合并提交推送失败:${(pushed.stderr || "").slice(0, 300)}`;
        this.persist(task);
      }
      return;
    }
    const conflicted = (git(
      "diff", "--name-only", "--diff-filter=U").stdout || "")
      .trim().split("\n").filter(Boolean);
    if (!conflicted.length) {
      // merge 失败却没有冲突文件 = 环境怪状(本地脏文件之类),
      // 别把 agent 派进一个说不清的现场。
      git("merge", "--abort");
      task.summary.detail =
        `merge 失败但无冲突文件,请人工:${(merged.stderr || "").slice(0, 300)}`;
      this.persist(task);
      return;
    }
    loop.kind = "conflict";
    loop.round = 0; // 冲突触发同样清零 CI 重试
    loop.last_sha = sha;
    loop.state = "repairing";
    this.enqueueRepair(task,
      [
        `MR 与目标分支 ${target} 冲突,解决它是你此刻唯一的使命:`,
        `- 宿主已在工作区执行 git merge origin/${target},`
        + `真实的冲突标记(<<<<<<< ======= >>>>>>>)已经在下列文件里:`,
        ...conflicted.map((file) => `  ${file}`),
        `- 逐个文件解决:保留双方必要改动,把标记删干净;拿不准语义时`
        + `读两边的提交历史(git log)再定,不许无脑选一边。`,
        `- 解完 git add 全部冲突文件,git commit 完成合并提交`
        + `(用默认合并信息即可),然后 push。`,
        `- 不要 rebase、不要 force push、不要动无关文件。`,
      ].join("\n"),
      `与 ${target} 冲突(${conflicted.length} 个文件),专职会话解决中`);
  }

  /** 检视回复发布(批3 收尾):修复会话收口后,把 ../review_replies.md
   * 逐条发到平台并标已解决。发布失败 fail-open 留痕——回复发不出去
   * 顶多门禁下一轮还红,再走一次刹车判定,绝不卡死收口。 */
  private async publishReviewReplies(task: TaskState): Promise<void> {
    const platformUrl = this.effectivePlatformUrl();
    const repliesPath = join(task.summary.workspace, "review_replies.md");
    if (!platformUrl || !existsSync(repliesPath)) return;
    let text = "";
    try {
      text = readFileSync(repliesPath, "utf-8");
    } catch {
      return;
    }
    // 解析:每条以 [id] 单独成行开头,正文到下一个 [id] 行为止。
    const replies: Array<{ id: string; body: string }> = [];
    let current: { id: string; body: string[] } | undefined;
    for (const line of text.split("\n")) {
      const head = line.trim().match(/^\[([^\]\s]+)\]$/);
      if (head) {
        if (current) {
          replies.push({ id: current.id,
                         body: current.body.join("\n").trim() });
        }
        current = { id: head[1], body: [] };
      } else if (current) {
        current.body.push(line);
      }
    }
    if (current) {
      replies.push({ id: current.id, body: current.body.join("\n").trim() });
    }
    const repo = task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "";
    // 默认只回复不代点"已解决"——内网既有框架的实证(报告 D3):
    // resolve 是检视人的职责,代点是越权。开关给明确允许的部署。
    const resolve = this.options.delivery?.resolveDiscussions ?? false;
    const posted: string[] = [];
    for (const item of replies) {
      if (!item.body) continue;
      try {
        const response = await fetch(
          `${platformUrl}/mr/discussions/${encodeURIComponent(item.id)}/reply`,
          {
            method: "POST",
            headers: this.platformIdentity(task),
            body: JSON.stringify({
              repo,
              mr: task.summary.delivery?.mr_id,
              body: item.body,
              resolve,
            }),
          });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        posted.push(item.id);
        this.bypass(task, "投影动作", this.options.projection?.recordAction({
          taskId: task.summary.id,
          idemKey: `review-reply:${item.id}`,
          kind: "review_reply",
          request: { id: item.id, body: item.body.slice(0, 500) },
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        }));
      } catch (error) {
        this.options.log?.(
          `任务 ${task.summary.id} 检视回复发布失败(讨论 ${item.id}): `
          + String(error));
      }
    }
    // 记下"哪些讨论答复过了":与 review_ids 比对是"等检视人确认"
    // 和"会话没干活"的分界线。只发出去一部分就只记一部分——漏答的
    // 下一轮按真刹车处理,不许拿半份回复冒充全答。
    const loop = task.summary.delivery?.loop;
    if (loop?.kind === "review" && posted.length) {
      const already = loop.replied_ids ? loop.replied_ids.split(",") : [];
      loop.replied_ids =
        [...new Set([...already, ...posted])].sort().join(",");
      this.persist(task);
    }
    // 消费掉:下一轮修复(如果有)重写,不重复发布旧回复。
    try {
      rmSync(repliesPath, { force: true });
    } catch { /* 删不掉顶多下轮重发,幂等键兜着 */ }
  }

  /** 流水线证据口:终态时把平台事实(sha/status/来源)写成文件喂给
   * 内核仓的 `pipeline record`,内核绑工作区当前 HEAD 裁决并把结论写
   * 进 .mae-flow.json 的 quality.pipeline——判定一行不在本仓(红线:
   * 内核唯一权威;宿主只递事实)。delivery.attested 是那份现场记录的
   * 镜像戳。纯旁路:内核调不动/退非零只留痕"未裁决",30s 预算,
   * 绝不拦收口(fail-open 红线)。 */
  private async recordPipelineEvidence(
    task: TaskState,
    sha: string,
    status: "success" | "failed",
  ): Promise<void> {
    const kernelRoot = this.options.host?.kernelRoot;
    const delivery = task.summary.delivery;
    if (!kernelRoot || !task.cwd || !delivery) return;
    const factsPath = join(task.summary.workspace, "pipeline-facts.json");
    try {
      writeFileSync(factsPath, JSON.stringify({
        sha,
        status,
        source: this.effectivePlatformUrl() ?? "",
        url: delivery.mr_url ?? "",
      }, null, 2));
      const result = await new Promise<
        { code: number | null; out: string; err: string }>(
        (resolve) => {
          const child = spawn(this.options.host!.python ?? "python3",
            [join(kernelRoot, "scripts", "mae-flow.py"),
             "pipeline", "record", "--file", factsPath],
            { cwd: task.cwd!, stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          let err = "";
          child.stdout.setEncoding("utf-8");
          child.stderr.setEncoding("utf-8");
          child.stdout.on("data", (chunk: string) => (out += chunk));
          child.stderr.on("data", (chunk: string) => (err += chunk));
          const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
          timer.unref();
          child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, out, err });
          });
          child.on("error", () => {
            clearTimeout(timer);
            resolve({ code: null, out, err });
          });
        });
      // 内核约定:末行是机器可读的裁决 JSON(quality.pipeline 原文)。
      const lastLine = result.out.trim().split("\n").at(-1) ?? "";
      let record: { verdict?: unknown; sha?: unknown } | undefined;
      try {
        record = JSON.parse(lastLine);
      } catch {
        record = undefined;
      }
      if (result.code === 0 && typeof record?.verdict === "string") {
        delivery.attested =
          `${record.verdict}@${String(record.sha ?? sha).slice(0, 12)}`;
      } else {
        delivery.attested = "未裁决(内核登记失败,详见服务日志)";
        this.options.log?.(
          `任务 ${task.summary.id} 流水线证据登记失败(code `
          + `${result.code ?? "spawn-error"}): ${result.out.slice(0, 300)} `
          + result.err.slice(0, 300));
      }
    } catch (error) {
      delivery.attested = "未裁决(登记异常,详见服务日志)";
      this.options.log?.(
        `任务 ${task.summary.id} 流水线证据登记异常: ${String(error)}`);
    }
  }

  /** 批2 落盘通道:拉平台的失败材料镜像到工作区外 pipeline/。
   * 每轮先清空再重下(给 agent 的必须是最新一轮);平台不支持
   * (404)或失败回空数组,修复照走摘要通道。 */
  private async mirrorPipelineArtifacts(task: TaskState): Promise<string[]> {
    const platformUrl = this.effectivePlatformUrl();
    const sha = task.summary.delivery?.sha;
    if (!platformUrl || !sha) return [];
    try {
      const repo = encodeURIComponent(
        task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "");
      const response = await fetch(
        `${platformUrl}/pipeline/artifacts?sha=${sha}&repo=${repo}`,
        { headers: this.platformIdentity(task) });
      if (response.status === 404) return [];
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await readJson(response);
      const files = (Array.isArray(body.files) ? body.files : [])
        .filter((file: any) => typeof file?.name === "string"
          && typeof file?.text === "string");
      if (!files.length) return [];
      const dir = join(task.summary.workspace, "pipeline");
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const written: string[] = [];
      for (const file of files) {
        // 路径穿越防线:文件名只留基名,别让平台字段写出目录外。
        const name = basename(String(file.name));
        if (!name) continue;
        writeFileSync(join(dir, name), String(file.text).slice(0, 512 * 1024));
        written.push(name);
      }
      return written;
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 流水线材料镜像失败(走摘要通道): `
        + String(error));
      return [];
    }
  }

  private async fetchDiscussions(task: TaskState): Promise<DiscussionItem[]> {
    const platformUrl = this.effectivePlatformUrl();
    const delivery = task.summary.delivery;
    if (!platformUrl || !delivery) return [];
    try {
      const params = new URLSearchParams({
        repo: task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "",
      });
      if (delivery.mr_id !== undefined) {
        params.set("mr", String(delivery.mr_id));
      }
      const response = await fetch(
        `${platformUrl}/mr/discussions?${params}`,
        { headers: this.platformIdentity(task) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await readJson(response);
      return (Array.isArray(body.discussions) ? body.discussions : [])
        .filter((item: any) => typeof item?.id === "string" && item.id);
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 检视讨论拉取失败: ${String(error)}`);
      return [];
    }
  }

  /** 修复派单的共同尾巴:使命上膛、任务重排队,setImmediate 避开
   * settle 链上的状态竞态(同 dispatchCiRepair 里那条注释)。 */
  private enqueueRepair(
    task: TaskState,
    mission: string,
    detail: string,
  ): void {
    task.mission = mission;
    task.summary.status = "queued";
    task.summary.detail = detail;
    task.resume = true;
    this.persist(task);
    this.queue.push(task.summary.id);
    setImmediate(() => this.bypass(undefined, "任务泵", this.pump()));
  }

  /** 人工节点的"现成答案":有则自动交卷,没有才真等人。两个来源:
   * - **下单预选(交付方式)**:内核仍举卡(流程规则归内核,宿主不删
   *   它的问题),但答案用户下单时已给——卡上出现了用户选定的那个
   *   **内核选项**就把它交上去。这是送达用户早给的答案,不是宿主代做
   *   判断;对不上就退回真等人,fail-open 到人工;
   * - **月光模式**:用户显式开启免审批,其余问题一律代答"预授权放行,
   *   按最稳妥判断继续,理由写明供复盘"。
   * 混合卡(既有交付方式又有别的问题)只在月光开着时整卡交,否则等人。 */
  private autoAnswerFor(task: TaskState): {
    why: string;
    answers: Record<string, string>;
    notes: string;
  } | undefined {
    const waiting = task.summary.waiting;
    const questions = ((waiting?.question as any)?.questions ?? []) as Array<{
      question?: string;
      options?: string[];
    }>;
    if (!waiting || questions.length === 0) return undefined;
    const moonlight =
      this.options.moonlight?.(task.summary.luban_account) ?? false;
    const lane = task.summary.lane;
    const reasons = new Set<string>();
    const answers: Record<string, string> = {};
    for (const item of questions) {
      const text = String(item.question ?? "");
      // 认卡不靠问题措辞,靠**选项**:内核举的卡里出现了用户下单时选
      // 的那一项,就是这张卡在问交付方式。此前按"车道"二字匹配,而内核
      // 的问题里根本没有这两个字(它问"交付方式?"),于是预选形同虚设
      // ——措辞是内核的自由,选项才是双方共用的语言。
      const preselected = lane
        ? (item.options ?? []).find((option) => option === lane
            || option.includes(lane))
        : undefined;
      if (preselected) {
        answers[text] = preselected;
        reasons.add(`下单预选交付方式:${lane}`);
      } else if (moonlight) {
        answers[text] =
          "【月光模式代答】用户已开启免审批预授权:按工程上最稳妥的" +
          "判断替用户选择并继续推进,拿不准的选保守项;把你的选择和" +
          "理由写清楚,供事后人工复盘。";
        reasons.add("月光模式免审批");
      } else {
        return undefined; // 有答不上的问题,整卡留给人
      }
    }
    return {
      why: [...reasons].join(" + "),
      answers,
      notes: `系统自动交卷(${[...reasons].join(";")}),非人工现场答复`,
    };
  }

  /** 选项卡上交了"不在菜单里"的答复:**记一条明账,不拦**。
   *
   * 内核按选项原文对账(choice receipts),交上去的词不在选项里,它就
   * 判"没有检测到本步骤的真实选项回答"——报错落在几步之后的 done 上,
   * 现场看起来像流程卡死。内网实测吃过:有人绕开界面直接打接口,交了
   * 个自造的 "approve",真正的选择写在备注里,内核当然不认。
   *
   * 为什么只警告不拦:界面本来就允许"自定义答复"(打回、补充要求),
   * 那是合法用法;判定哪种自由文本算数是内核的事,宿主不许替它判——
   * 拦下去就是在 TS 侧复刻判定。这里只负责让因果在同一处可见。 */
  private warnOffMenuAnswer(
    task: TaskState,
    waiting: { question?: unknown },
    values: string[],
  ): void {
    const questions = ((waiting.question as any)?.questions ?? []) as Array<{
      options?: string[];
    }>;
    const menu = questions.flatMap((item) => item.options ?? []);
    if (!menu.length) return;   // 开放题:本来就没有菜单
    const offMenu = values.filter((value) => {
      const text = value.trim();
      return text && !menu.some((option) =>
        option === text || option.includes(text) || text.includes(option));
    });
    if (!offMenu.length) return;
    this.options.log?.(
      `任务 ${task.summary.id} 的答复不在选项原文里(${offMenu.join(" / ")});`
      + `本卡选项:${menu.join(" / ")}。若内核随后报"没有检测到本步骤的`
      + `真实选项回答",原因就在这里——交回选项原文即可。`);
  }

  /** 自动交卷:走人工决定同一条通路(decide),内核台账、事件、
   * 竞态语义一字不差;人若抢先答了(409/状态翻篇)就当没发生。 */
  private async autoDecide(
    task: TaskState,
    auto: { answers: Record<string, string>; notes: string },
  ): Promise<void> {
    const waiting = task.summary.waiting;
    if (task.summary.status !== "waiting_for_human" || !waiting) return;
    try {
      const single = Object.values(auto.answers);
      await this.decide(task.summary.id, {
        state_version: waiting.state_version,
        ...(single.length === 1
          ? { decision: single[0] }
          : { answers: auto.answers }),
        notes: auto.notes,
      });
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 自动交卷未生效(可能人已答): ${String(error)}`);
    }
  }

  /** 月光模式开启的即时清场:把该用户当前所有等人的卡就地代答——
   * "随时开启"就该对已经在等的卡立刻生效,不是只管以后的。 */
  sweepMoonlight(account: string): number {
    let swept = 0;
    for (const task of this.tasks.values()) {
      if (task.summary.status !== "waiting_for_human") continue;
      if (task.summary.luban_account !== account) continue;
      const auto = this.autoAnswerFor(task);
      if (auto) {
        swept += 1;
        void this.autoDecide(task, auto);
      }
    }
    return swept;
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
    this.bypass(task, "待办通知", notifier
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
      }));
  }

  /** 个人 Git 凭据落地为 credential helper 三件套:
   * - agentDir/git-credential(0600):明文凭据,git 凭据格式;
   * - agentDir/git-credential.sh(0700):只答 get,现读同目录凭据文件;
   * - .git/config 里只记脚本路径,**明文永不进 .git/config 或远端 URL**
   *   (令牌拼 URL 会原样留在 config 里,等着被 cat 出来)。
   * 容器隔离下工作区按原路径挂载(containerRuntime -v ws:ws),
   * 绝对路径在容器内照样成立。没有凭据返回 undefined,一切如旧。 */
  private prepareGitCredential(
    agentDir: string,
    credential: { username: string; password: string },
  ): string {
    const file = join(agentDir, "git-credential");
    writeFileSync(file,
      `username=${credential.username}\npassword=${credential.password}\n`);
    chmodSync(file, 0o600);
    const script = join(agentDir, "git-credential.sh");
    writeFileSync(script, [
      "#!/bin/sh",
      "# git credential helper:只答 get;凭据与本脚本同目录,0600。",
      "# store/erase 一律无视并成功返回,免得 git 刷警告。",
      'if [ "$1" = "get" ]; then',
      '  cat "$(dirname "$0")/git-credential"',
      "fi",
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(script, 0o700);
    return script;
  }

  /** 仓库进工作区:git 仓走 clone(历史/分支语义齐全),
   * 非 git 目录降级复制并剔除旧现场(.mae-flow-work 不跨任务串场)。
   * identity = commit 署名:令牌只管推送鉴权,"commit 是谁的"平台按
   * commit email 映射——两码事,都得写。 */
  private cloneRepo(
    workspace: string,
    gitHelper?: string,
    identity?: { username: string; email?: string },
    repoUrl?: string,
  ): string {
    // 任务级仓(下单填的)> 管理页默认仓 > 部署 --repo;都没有=如实
    // 失败,不猜一个仓出来。记在 summary,重启续跑同仓。
    const source = repoUrl ?? this.effectiveDefaultRepo();
    if (!source) {
      throw new Error(
        "这单没有代码仓:下单时填「交付代码仓」,或让管理员在服务设置里配默认仓");
    }
    // 裸仓 origin.git → 工作区目录名去掉 .git 后缀,免得像个裸仓。
    const target = join(
      workspace, basename(source).replace(/\.git$/, "") || "repo");
    // 普通仓有 .git 子目录;裸仓自己就是 git 目录(HEAD+objects)。
    // 只认 .git 会把裸仓误判成普通目录,把仓库内脏拷贝成"工作区"(实测)。
    const isGit = existsSync(join(source, ".git"))
      || (existsSync(join(source, "HEAD"))
          && existsSync(join(source, "objects")));
    // 凭据只对 http(s) 远端有意义;本地路径克隆(演示/试跑)不掺和。
    const useCredential = !!gitHelper && /^https?:\/\//i.test(source);
    if (isGit || /^(https?|ssh|git):\/\//i.test(source)) {
      // 空 helper 在前=清空继承的 helper 列表(系统钥匙串之流):
      // 个人令牌只从我们的脚本来,也不许被别的 helper 顺手存走
      // (git 会对列表里所有 helper 广播 store——实测令牌进过
      // macOS 钥匙串,测试负例因此假绿)。没有个人凭据时不动列表,
      // 部署机自己的服务账号 helper 照常工作。
      const cloned = spawnSync(
        "git",
        [
          ...(useCredential
            ? ["-c", "credential.helper=",
               "-c", `credential.helper=${gitHelper}`]
            : []),
          "clone", "--quiet", source, target,
        ],
        {
          encoding: "utf-8",
          // 子进程没有终端,git 想问密码只会把任务挂死——明令禁问,
          // 缺凭据就地失败,错误如实上浮(不卡死红线)。
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
      if (cloned.status !== 0) {
        throw new Error(`仓库克隆失败: ${cloned.stderr}`);
      }
      if (useCredential) {
        // 会话里的 push/fetch 也走同一个 helper:写进克隆自己的
        // config(记的是脚本路径,不是明文);同样先清列表再登记。
        spawnSync("git",
          ["config", "credential.helper", ""],
          { cwd: target, encoding: "utf-8" });
        spawnSync("git",
          ["config", "--add", "credential.helper", gitHelper!],
          { cwd: target, encoding: "utf-8" });
      }
    } else {
      cpSync(source, target, {
        recursive: true,
        filter: (path) => !path.includes(".mae-flow-work")
          && !path.endsWith(".mae-flow.json"),
      });
    }
    // 署名与传输方式无关(本地路径克隆的演练也该署对名):配了就写,
    // 邮箱没填只写名字——平台认领靠邮箱,表单里已经把话说明白。
    // 会话重建复用旧克隆,署名改动生效边界=下一次新克隆(与凭据一致)。
    if (identity && existsSync(join(target, ".git"))) {
      spawnSync("git", ["config", "user.name", identity.username],
        { cwd: target, encoding: "utf-8" });
      if (identity.email) {
        spawnSync("git", ["config", "user.email", identity.email],
          { cwd: target, encoding: "utf-8" });
      }
    }
    return target;
  }

  /** 自动修复停下(halted/exhausted)→ 小鲁班。这是修复环里唯一
   * 真正需要人的时刻,必须主动喊人,不能等人自己来看页面。
   * 幂等键带 loop 状态,与早先发过的"验证中"收口通知不同键——
   * 那条说的是"机器在干活",这条说的是"机器干不动了,该你了"。 */
  private notifyRepairStopped(task: TaskState): void {
    const { notifier } = this.options;
    const account = task.summary.luban_account;
    const loop = task.summary.delivery?.loop;
    if (!notifier || !account || !loop) return;
    const why = loop.state === "halted"
      ? (loop.diagnosis
          ? `修复会话判断需人工处理:${loop.diagnosis.slice(0, 200)}`
          : "修复会话未产生新提交,请人工查看流水线日志")
      : `${loop.max} 轮修复预算用完,流水线仍红`;
    this.bypass(task, "修复停摆通知", notifier.notifyOutcome({
      taskId: task.summary.id,
      account,
      status: `repair_${loop.state}`,
      summary: `流水线自动修复已停,需要你介入——${why}`,
      link: personalTaskLink(
        this.options.linkBase, account, task.summary.id),
    }));
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
    this.bypass(task, "收口通知", notifier.notifyOutcome({
      taskId: id,
      account,
      status,
      summary: text[status],
      link: personalTaskLink(this.options.linkBase, account, id),
    }));
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

  /** 旁路的即发即忘统一走这里:**抛了就记账,绝不带走进程**。
   *
   * `void 某个异步旁路()` 是本仓的常用写法(通知、投影、流水线轮询、
   * 合入监控、容器清理),但 Node 从 15 起未处理的 rejection 默认终止
   * 进程——于是"PG 抖一下""docker 没了""平台 502"这类旁路故障,后果
   * 是整台服务连着所有在跑的任务一起没。红线写得很清楚:旁路一律
   * fail-open。这个壳子就是那条红线在代码里的落点,别再裸 void。 */
  private bypass(
    task: TaskState | undefined,
    what: string,
    work: Promise<unknown> | undefined,
  ): void {
    if (!work) return;
    void work.catch((error) => {
      const who = task ? `任务 ${task.summary.id} ` : "";
      this.options.log?.(
        `${who}旁路「${what}」出错(fail-open,流程照走): ${String(error)}`);
    });
  }

  /** outcome → 任务状态。等待人工不占并发额度之外的资源,会话原地挂起。
   *
   * **一整条链都在 try 里**,这不是防御性编程的洁癖:decide 那头是
   * `void this.settle(...)`——人点了"通过",模型跑一轮,这条链上任何
   * 一处抛异常都是一个没人接的 Promise,Node 默认直接杀进程。内网反复
   * 报的"serve 莫名其妙挂了、一点错误输出都没有",症状(人工审批通过、
   * 模型跑完一轮后进程退出)与它严丝合缝。
   *
   * 进程级兜底(serve 的 guardProcess)拦得住"死",拦不住"哑":异常
   * 被吞了,任务会永远停在 running,人在页面上等一个不会来的结果。所以
   * 这里如实收口——任务 failed,原因写进 detail,通知照发。 */
  private async settle(
    task: TaskState,
    turn: Promise<Outcome>,
    epoch = task.controlEpoch,
  ): Promise<void> {
    try {
      await this.settleTurn(task, turn, epoch);
    } catch (error) {
      if (!this.current(task, epoch)) return;
      task.summary.status = "failed";
      task.summary.detail = `本轮收口时出错: ${String(error)}`;
      task.driver?.dispose();
      this.bypass(task, "容器清理", task.container?.stop());
      this.persist(task);
      this.notifyOutcome(task);
      this.options.log?.(
        `任务 ${task.summary.id} 收口时抛异常(任务如实 failed,服务继续): `
        + String(error));
    }
  }

  private async settleTurn(
    task: TaskState,
    turn: Promise<Outcome>,
    epoch = task.controlEpoch,
  ): Promise<void> {
    const outcome = await turn;
    if (!this.current(task, epoch)) return;
    switch (outcome.status) {
      case "waiting_for_human": {
        task.summary.waiting = outcome.waiting;
        if (task.pauseRequested || task.summary.status === "pausing") {
          await this.finishPause(task, "waiting_for_human");
          break;
        }
        task.summary.status = "waiting_for_human";
        // 人工节点=流程真实活动,催办账本清零:答复之后若再停在
        // 同名步骤,那是新一次卡壳,应当再催。
        task.nudgedStep = undefined;
        this.persist(task);
        // 先看有没有现成答案(下单预选/月光模式):有就自动交卷,
        // 不通知不打扰;没有才是真·等人。setImmediate 让本轮 settle
        // 先收完账再交卷——decide 会立刻把状态翻回 running。
        const auto = this.autoAnswerFor(task);
        if (auto) {
          this.options.log?.(
            `任务 ${task.summary.id} 人工节点自动交卷(${auto.why})`);
          setImmediate(() => void this.autoDecide(task, auto));
        } else {
          this.notifyWaiting(task);
        }
        break;
      }
      case "turn_finished": {
        if (task.pauseRequested) {
          await this.finishPause(task, "running");
          break;
        }
        // 主动压缩:回合间隙是唯一安全的压缩点(等待人工时压会
        // 打断挂起的人工节点)。以内核锚点组织摘要,注意力不许飘。
        await this.maybeCompact(task);
        if (!this.current(task, epoch)) break;
        if (task.pauseRequested) {
          await this.finishPause(task, "running");
          break;
        }
        // 回合收口时 steer 队列还压着货 = 那条插话从没送到(撞在回合
        // 间隙,pi 收下却不会自己送)。取回来补发,而且排在催办和收工
        // 之前:人说的话优先于系统催办,更不能因为"流程刚好走完了"被吞掉。
        const late = task.driver?.takeUndeliveredSteers() ?? [];
        if (late.length && task.driver) {
          this.options.log?.(
            `任务 ${task.summary.id} 补发 ${late.length} 条未送达的插话`);
          await this.settle(
            task, task.driver.continueWith(late.join("\n\n")), epoch);
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
            `已答复过的确认项不要重复提问。`), epoch);
          break;
        }
        // 收口发言先落袋:修复会话"判断修不了"时这就是给人的诊断,
        // 下面 tryDeliver→pipelineVerdict 的 halted 分支要用。
        task.lastReply = task.driver?.finalReply();
        task.driver?.dispose();
        this.bypass(task, "容器清理", task.container?.stop());
        // 专项使命到这儿才算消费掉:会话真做完了。早清会让"修一半
        // 被重启"的重建会话拿不到使命。
        task.mission = undefined;
        // 检视修复的回程票:把会话写的逐条回复发到平台并标已解决,
        // 必须在 tryDeliver 之前——门禁的下一次判定要看到"已解决"。
        if (task.summary.delivery?.loop?.kind === "review") {
          await this.publishReviewReplies(task);
          if (!this.current(task, epoch)) break;
        }
        // 终态在交付判定之后才定:先标 completed 再改,轮询会撞见
        // 中间态(实测竞态)。交付把状态升为 verifying/await_merge,
        // 没交付动作时才落 completed。
        await this.tryDeliver(task, epoch);
        if (!this.current(task, epoch)) break;
        // 交付请求本身也可能耗时；用户若在这段窗口点了暂停，外部流水线
        // 已触发就停在 verifying 跟踪点，否则停在普通执行点。若已经绿灯
        // 进入 await_merge，则任务事实上已完成交付，无需再造 paused 中间态。
        if (task.pauseRequested && task.summary.status !== "await_merge") {
          await this.finishPause(task,
            task.summary.status === "verifying" ? "verifying" : "running");
          break;
        }
        task.pauseRequested = false;
        if (task.summary.status === "running") {
          task.summary.status = "completed";
        }
        this.persist(task);
        this.notifyOutcome(task);
        break;
      }
      case "session_ended":
        if (task.pauseRequested || task.summary.status === "pausing") {
          await this.finishPause(task, "running");
          break;
        }
        task.summary.status = "failed";
        task.summary.detail = outcome.detail ?? outcome.reason;
        task.driver?.dispose();
        this.bypass(task, "容器清理", task.container?.stop());
        this.persist(task);
        this.notifyOutcome(task);
        break;
    }
  }
}

export class NotFoundError extends Error {}
export class TaskControlError extends Error {}
