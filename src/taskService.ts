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
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkills } from "@earendil-works/pi-coding-agent";
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
import { workflowChoices, workflowLabel } from "./kernelChoices.ts";
import { buildRepoMap } from "./repoMap.ts";
import { collectKnowledge } from "./knowledgeBlocks.ts";
import { readJson } from "./jsonBody.ts";
import type { Notifier, NotifyRecord } from "./notifier.ts";
import { EventLog } from "./semanticEvents.ts";
import {
  buildActivity, readActivityEvents, type ActivityView,
} from "./activity.ts";
import { TranscriptStore } from "./transcriptStore.ts";
import { GateService, type GateContract } from "./gateService.ts";
import {
  HumanGate,
  StateConflictError,
  renderDecision,
  type WaitingRecord,
} from "./humanGate.ts";
import { CloudSession, type Outcome } from "./sessionDriver.ts";
import { dockerAvailable, TaskContainer } from "./containerRuntime.ts";
import type { ExternalAction, PgProjection } from "./projection.ts";
import type { RuntimeSettings } from "./settings.ts";
import { ReviewStore, type ReviewRequest } from "./reviews.ts";
import {
  parsePipelineChecks,
  type PipelineCheck,
} from "./pipelineContract.ts";
import {
  inspectKernelCompletion,
  type KernelCompletionAttestation,
} from "./terminalAttestation.ts";
import {
  materializeRepositorySkills,
  type SelectedRepositorySkill,
  validRepositorySkillPath,
} from "./repositorySkillRuntime.ts";
import {
  discoverRepositorySkills,
  type RepositorySkillCatalog,
  type RepositorySkillDescriptor,
} from "./repositorySkills.ts";

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
  /** build 内的非门禁观察事件；不改变阶段、不参与完成判定。 */
  milestone?: {
    task_id: string;
    title: string;
    event: "started" | "completed" | "blocked";
    reason?: string;
  };
}

export interface RequirementRepository {
  id: string;
  name: string;
  url: string;
  responsibility?: string;
  task_id?: string;
}

export interface RequirementDependency {
  /** 依赖方。语义是 `from 依赖 to`，因此 from 必须等待 to。 */
  from: string;
  /** 被依赖的前置仓库。 */
  to: string;
  reason?: string;
}

interface RawRequirementDependency {
  /** 新格式：字段本身就说明方向。 */
  dependent?: string;
  prerequisite?: string;
  /** 旧格式：历史约定是 from 先于 to，但早期模型偶尔会按自然语言写反。 */
  from?: string;
  to?: string;
  reason?: string;
}

function dependencyStatement(
  reason: string | undefined,
  dependent: RequirementRepository | undefined,
  prerequisite: RequirementRepository | undefined,
): boolean {
  if (!reason || !dependent || !prerequisite) return false;
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dependentNames = [...new Set([dependent.id, dependent.name])];
  const prerequisiteNames = [...new Set([prerequisite.id, prerequisite.name])];
  return dependentNames.some((left) => prerequisiteNames.some((right) =>
    new RegExp(`${escaped(left)}.{0,32}(?:依赖|等待|晚于|后于).{0,32}${escaped(right)}`, "i")
      .test(reason)));
}

/** Cloud 的质量动作分工是部署事实，不由用户或每单参数选择。 */
const CLOUD_EXECUTION_CONTRACT = {
  schema: "mae-flow-execution/1",
  host: "cloud",
  compile: "pipeline",
  ut_write: "agent",
  ut_run: "pipeline",
  codecheck: "pipeline",
  git_push: "host",
} as const;

/** 找到本次会话真正能装载的宿主 Skill 名。名称必须由 Pi 自己解析：
 * frontmatter name 可以和目录名不同；缺 name 时 Pi 才以目录名兜底，
 * 解析失败/缺 description 时则与运行时一样不算可加载 Skill。
 * CloudSession 也把整个宿主 skills 根交给同一个 loader，因此这里会
 * 同样覆盖递归、ignore、符号链接和根目录 Markdown 的发现语义。 */
function hostSkillNames(dataDir: string): string[] {
  const root = join(dataDir, "skills");
  try {
    return loadSkills({
      cwd: dataDir,
      agentDir: dataDir,
      skillPaths: [root],
      includeDefaults: false,
    }).skills.map((skill) => skill.name);
  } catch {
    // Skill 装载本身是 fail-open；catalog 同样不因宿主目录损坏而失败。
    return [];
  }
}

function availableUtGenerationMethod(
  dataDir: string,
  loadedRepositorySkillNames: string[] = [],
): string {
  const unique = [...new Set([
    ...hostSkillNames(dataDir),
    ...loadedRepositorySkillNames,
  ].filter((name) =>
    /(?:^|[-_])(?:java[-_])?(?:auto)?ut(?:$|[-_])/i.test(name)
      || /ut[-_]generator/i.test(name)))];
  const rank = (name: string): number => {
    const normalized = name.toLowerCase();
    if (normalized === "java-autout") return 0;
    if (normalized === "autout") return 1;
    return 2;
  };
  unique.sort((left, right) => rank(left) - rank(right)
    || left.localeCompare(right));
  return unique[0] ?? "仓内既有写法";
}

function validateRepositoryAddress(candidate: string): void {
  if (/\s/.test(candidate)) {
    throw new Error("代码仓地址不能含空白字符");
  }
  if (!candidate || candidate.startsWith("-") || /[\0\r\n]/.test(candidate)) {
    throw new Error("代码仓地址不能含控制字符或以 - 开头");
  }
  if (/^(?:ssh:\/\/|git\+ssh:\/\/|[\w.-]+@[\w.-]+:)/i.test(candidate)) {
    throw new Error(
      `代码仓请填 HTTPS 地址(收到 SSH 形式: ${candidate})。`
      + `宿主推送与 MR 用个人令牌走 HTTPS,SSH 没有可用凭据,`
      + `会在交付推送时 Permission denied`);
  }
  if (/^https?:\/\//i.test(candidate)) {
    const parsed = new URL(candidate);
    if (parsed.username || parsed.password) {
      throw new Error("代码仓 URL 不许携带账号密码——鉴权使用个人 CodeHub Token");
    }
  }
}

/** 所有需求都是一张仓库交付图：单仓只是只有一个节点、没有边。 */
export interface RequirementGraph {
  stage: "analysis" | "confirmed";
  repositories: RequirementRepository[];
  dependencies: RequirementDependency[];
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
  /** 需求影响的全部仓库。repo_url 保留为单仓交付兼容字段。 */
  repositories?: string[];
  /** 用户在下单时从各业务仓能力目录中明确选中的 Skill。空数组表示
   * 新任务明确不加载仓内 Skill；字段缺席仅用于兼容旧任务此前的全量
   * 自动加载。Skill 是建议上下文，不是流程步骤或完成证据。 */
  repository_skills?: SelectedRepositorySkill[];
  /** 多仓时由 Chain 产物投影；单仓时是一个节点的退化图。 */
  requirement_graph?: RequirementGraph;
  /** 确认 Chain 方案后生成的普通仓库交付任务关系。 */
  parent_task_id?: string;
  blocked_by?: string[];
  /** 交付方式(用户拍板:下单就选好,不让 agent 来问)。取值是**内核
   * flow.json 里 workflow_select 的选项原文**(完整开发/已定位问题修复/
   * 局部修改/处理评审意见),不是宿主自造的词——自造过一次,结果是
   * 卡来了永远对不上、用户在流程里被重复问一遍(2026-08-18 内网实测)。
   * 内核仍会举卡(流程规则是内核的,宿主不删它的问题),对得上就自动
   * 交卷(预答,不是代判)。 */
  lane?: string;
  /** 需求/问题单号(REQ/DTS)。下单就给(用户 2026-08-19 拍板),
   * 开场当事实喂给模型——配置确认不再为它开口问。 */
  ticket?: string;
  /** 基线分支,默认 master(同一次拍板)。 */
  baseline?: string;
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
    /** 平台按质量维度返回的 Job 结果（可选诊断增强）。契约已声明三项
     * 均由该权威流水线覆盖时，总体 success 可聚合核销；若逐项明确
     * failed / pending，内核仍以更精确事实裁决 RED / INCOMPLETE。 */
    checks?: PipelineCheck[];
    /** Cloud 在 Agent 会话释放后完成的推送收据；内核要求它与流水线
     * SHA、工作区 HEAD 三者一致，避免模型接触个人 Token。 */
    git_push?: {
      sha: string;
      ref: string;
      remote: string;
      url?: string;
    };
    sha?: string;
    skipped?: string;
    /** 内核对流水线证据的裁决戳(如 "PASS@abc123456789"):终态时宿主
     * 把平台事实喂给内核 `pipeline record`,内核绑工作区 HEAD 裁决并
     * 写进 .mae-flow.json 的 quality.pipeline——这里只是那份现场记录
     * 的镜像。"未裁决(...)"= 登记失败留痕，并阻止进入 await_merge。 */
    attested?: string;
    /** 挂起等待的人话(等审批/等投票……):MR 闭环里"没人动它"和
     * "出了问题"必须让人一眼分得开。 */
    waiting_on?: string;
    /** 外部验证自愈预算的到期时刻(ISO)。重启后照旧对表,不重新开表
     * ——否则每重启一次就白送半小时。 */
    verify_deadline?: string;
    /** 自愈已停,等人工介入的原因。设了它:retry 放行、页面亮牌子、
     * 通知发出。这是"验证中"这潭水里唯一诚实的出口——没有它的时候
     * 任务会既不完成也不失败也不重试,人连重跑都点不动(实测)。 */
    stalled?: string;
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
  /** repoPath 仅用于 --repo 钉死单仓的演示/测试形态；正式下单逐单填仓。 */
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
   * volumes = 额外挂载,"宿主:容器" 形状;
   * memory/cpus/user = 资源限额与身份映射,不配即不限。 */
  isolation?: {
    image: string;
    volumes?: string[];
    memory?: string;
    cpus?: string;
    user?: string;
  };
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
   * 有凭据→只在宿主 clone/push 的短生命周期 helper 中使用；Agent
   * 目录与仓库配置永远不落 token/helper。没有→维持部署级访问方式
   * (服务账号/开放内网)。 */
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

/** 小鲁班链接必须落到前端任务工作台，而不是 /tasks/:id 的 JSON API。
 * 身份只认登录会话，URL 只承载任务定位；每个任务因此也有可复制、
 * 可刷新、可从通知直接进入的稳定页面地址。 */
function personalTaskLink(
  linkBase: string | undefined,
  _account: string,
  taskId: string,
): string {
  const root = (linkBase ?? "").replace(/\/+$/, "");
  return `${root}/work/${encodeURIComponent(taskId)}`;
}

function reviewTaskLink(
  linkBase: string | undefined,
  taskId: string,
  reviewId: string,
): string {
  const root = (linkBase ?? "").replace(/\/+$/, "");
  return `${root}/work/${encodeURIComponent(taskId)}`
    + `/review/${encodeURIComponent(reviewId)}`;
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

/** 读取内核定义的 append-only build 观察事件。坏文件只影响这一行进度，
 * 不能拖住任务列表，更不能被 Cloud 当成第二套流程状态。 */
function latestBuildMilestone(text: string): TaskProgress["milestone"] {
  if (!text) return undefined;
  try {
    const rows = JSON.parse(text)?.events;
    if (!Array.isArray(rows)) return undefined;
    const row = [...rows].reverse().find((item) => item
      && typeof item === "object"
      && ["started", "completed", "blocked"].includes(String(item.event))
      && String(item.task_id ?? "").trim()
      && String(item.task_title ?? "").trim());
    if (!row) return undefined;
    return {
      task_id: String(row.task_id),
      title: String(row.task_title),
      event: String(row.event) as "started" | "completed" | "blocked",
      ...(String(row.reason ?? "").trim()
        ? { reason: String(row.reason).trim() } : {}),
    };
  } catch {
    return undefined;
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
  /** 流水线证据核销重试的防重入锁。纯宿主 timer，不占 Agent 会话。 */
  evidenceRetryActive?: boolean;
  deliveryRecoveryActive?: boolean;
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

interface PipelineAttestation {
  verdict: string;
  sha?: string;
  reason?: string;
  checks?: Record<string, unknown>;
}

interface GitPushReceipt {
  sha: string;
  ref: string;
  remote: string;
  url?: string;
}

interface RepositorySkillCatalogTicket {
  account?: string;
  repositories: string[];
  baseline?: string;
  expiresAt: number;
  catalogs: RepositorySkillCatalog[];
}

export interface RepositorySkillCatalogResponse {
  catalog_token: string;
  repositories: RepositorySkillCatalog[];
}

export class TaskService {
  /** 没有部署级 public URL 时，记住最近一次已登录用户实际访问的地址。
   * 通知由该次请求触发时即可带上同事能访问的内网 Host，而不是回环地址。 */
  private observedLinkBase?: string;
  private tasks = new Map<string, TaskState>();
  private runningCount = 0;
  private queue: string[] = [];
  private counter = 0;
  private reviews: ReviewStore;
  private repositorySkillCatalogs =
    new Map<string, RepositorySkillCatalogTicket>();

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

  observeLinkBase(base: string | undefined): void {
    if (this.options.linkBase || !base) return;
    // 回环地址永不入账:它只对本机成立,发给别人就是死链(内网实锤:
    // 邀请检视的链接是 127.0.0.1)。管理员在服务器本机或经 SSH 隧道
    // (Host 就是 127.0.0.1)登录一次,不该把全体人的通知地址带沟里——
    // 学过的可用地址也不许被回环访问冲掉。
    try {
      const host = new URL(base).hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1"
          || host === "::1" || host === "[::1]") {
        return;
      }
    } catch {
      return;   // 解析不了的地址不入账
    }
    this.observedLinkBase = base.replace(/\/+$/, "");
  }

  private notificationLinkBase(): string | undefined {
    return this.options.linkBase ?? this.observedLinkBase;
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
      senderAccount: requester,
      account: committer,
      summary: review.task_title,
      link: reviewTaskLink(this.notificationLinkBase(), id, review.id),
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
          suggestion: "管理页 → 模型网关：填写网关地址、API Key 和模型名称" });

    const notify = this.options.notifier?.health();
    items.push(!notify?.configured
      ? { key: "notify", label: "消息通知", status: "warning",
          detail: "通知通道未配置",
          suggestion: "这是部署项；成员只需在个人设置中填写自己的小鲁班 Token" }
      : notify.last_error
        ? { key: "notify", label: "消息通知", status: "warning",
            detail: "已配置，但最近一次投递失败", suggestion: notify.last_error }
        : { key: "notify", label: "消息通知", status: "ok",
            detail: "小鲁班通知通道已就绪" });

    // 通知链接地址:2026-08-19 内网实锤——没配 --public-url,发起人又
    // 只从回环地址(本机/SSH 隧道)访问,通知里的链接别人打不开。回环
    // 已不入账,所以这里能如实分三种:显式配置 > 已自学 > 还没着落。
    const linkBase = this.notificationLinkBase();
    items.push(this.options.linkBase
      ? { key: "link", label: "通知链接地址", status: "ok",
          detail: `固定为 ${this.options.linkBase}(--public-url)` }
      : linkBase
        ? { key: "link", label: "通知链接地址", status: "ok",
            detail: `已从内网访问自学:${linkBase}`,
            suggestion: "建议启动时加 --public-url 固定,不依赖谁先登录" }
        : { key: "link", label: "通知链接地址", status: "warning",
            detail: "尚无可用地址:未配 --public-url,也还没有人从内网地址"
              + "访问过(回环地址不算——发给别人打不开)",
            suggestion: "启动加 --public-url http://<内网IP>:<端口>,"
              + "或先用内网地址打开一次本页面" });

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
            detail: "MR / 流水线服务未就绪",
            suggestion: "请部署维护人员检查平台适配服务" }
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
    this.refreshRequirementGraph(task);
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

  private isRequirementAnalysis(task: TaskState): boolean {
    return (task.summary.repositories?.length ?? 0) > 1
      && !task.summary.parent_task_id;
  }

  /** Agent 写结构化投影，Markdown 仍是给人检视的正文。读失败只是不展示图。 */
  private refreshRequirementGraph(task: TaskState): void {
    if (!this.isRequirementAnalysis(task) || !task.cwd) return;
    const ticket = task.summary.ticket ?? task.summary.id;
    const path = join(task.cwd, ".mae-flow-work", ticket,
      "requirement-graph.json");
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
        repositories?: RequirementRepository[];
        dependencies?: RawRequirementDependency[];
      };
      const expected = task.summary.repositories ?? [];
      const repositories = Array.isArray(parsed.repositories)
        ? parsed.repositories.filter((item) => item && expected.includes(item.url))
            .map((item) => ({
              ...item,
              task_id: task.summary.requirement_graph?.repositories
                .find((known) => known.id === item.id)?.task_id,
            }))
        : [];
      if (repositories.length !== expected.length) return;
      const ids = new Set(repositories.map((item) => item.id));
      // 新产物使用 dependent/prerequisite 消除歧义。旧版契约原本是
      // from 先于 to；若 reason 明确写了“A 依赖 B”，则以人工看到的
      // 说明为准，兼容早期模型把旧字段按自然语言填写的任务。
      const dependencies = Array.isArray(parsed.dependencies)
        ? parsed.dependencies.map((edge) => {
            if (edge.dependent && edge.prerequisite) return {
              from: edge.dependent, to: edge.prerequisite, reason: edge.reason,
            };
            const legacyFrom = edge.from ?? "";
            const legacyTo = edge.to ?? "";
            const fromRepository = repositories.find((item) => item.id === legacyFrom);
            const toRepository = repositories.find((item) => item.id === legacyTo);
            const reasonUsesNaturalDirection = dependencyStatement(
              edge.reason, fromRepository, toRepository);
            return reasonUsesNaturalDirection
              ? { from: legacyFrom, to: legacyTo, reason: edge.reason }
              : { from: legacyTo, to: legacyFrom, reason: edge.reason };
          }).filter((edge) =>
            ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to)
        : [];
      task.summary.requirement_graph = {
        stage: task.summary.requirement_graph?.stage ?? "analysis",
        repositories,
        dependencies,
      };
    } catch (error) {
      this.options.log?.(`任务 ${task.summary.id} 需求图读取失败: ${String(error)}`);
    }
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
      const milestonePath = join(task.cwd, ".mae-flow.json.build-milestones");
      const milestoneText = existsSync(milestonePath)
        ? readFileSync(milestonePath, "utf-8") : "";
      const progressSource = `${pulseText}\0${milestoneText}`;
      if (progressSource === task.progressPulse) return task.progressCache;
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
      const milestone = ["build", "build_rework"].includes(
        String(pulse.step ?? ""))
        ? latestBuildMilestone(milestoneText) : undefined;
      const progress: TaskProgress = {
        phases,
        current_index: currentIndex,
        current_phase: currentPhase || phases[currentIndex],
        step: pulse.step_title ? String(pulse.step_title) : undefined,
        revision: Number.isFinite(Number(pulse.revision))
          ? Number(pulse.revision) : undefined,
        ...(milestone ? { milestone } : {}),
      };
      task.progressPulse = progressSource;
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

  /** 行为摘要(只读旁路):事件流折叠成"此刻在干嘛/干了什么/有什么
   * 值得看"。每次现算,不留第二份状态;10~20 人规模下逐行读一遍
   * 事件账本毫无压力,先别上缓存。 */
  activity(id: string): ActivityView {
    const task = this.tasks.get(id)!;
    return buildActivity(readActivityEvents(this.eventLogPath(id)), {
      running: task.summary.status === "running",
    });
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
      // 新事件是完整 ISO；旧事件是去掉 T/Z 的 UTC 裸串。只给旧格式补 Z，
      // 不能给新格式再拼一个 Z（会得到 ...ZZ，整批回话因此被过滤掉）。
      const instant = (ts: unknown) => {
        const raw = String(ts ?? "").trim();
        const candidate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
          ? `${raw.replace(" ", "T")}Z`
          : raw;
        return new Date(candidate).getTime();
      };
      const texts = new EventLog(join(task.summary.workspace, "events.jsonl"))
        .replay()
        .filter((event) => event.kind === "assistant_message"
          && String(event.sessionId ?? "main") === "main"
          && instant(event.ts) > lastSent)
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

  editAnnotation(
    id: string,
    annotationId: string,
    note: string,
    by: string,
  ): Annotation {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    return this.annotations(task).edit(annotationId, note, by);
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

  /** MR/流水线连接是部署基础设施，管理员页面只读自检、不暴露地址。 */
  private effectivePlatformUrl(): string | undefined {
    return this.options.delivery?.platformUrl;
  }

  private effectiveDefaultRepo(): string | undefined {
    return this.options.host?.repoPath;
  }

  /** 生效的提交信息规范(设置层压部署层)。平台钩子按正则拒收不合规
   * 提交(内网实测),这条规矩要在每个会话开场就给——包括修复会话。 */
  private effectiveCommitConvention(): string | undefined {
    const text = this.options.commitConvention;
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
    /** 单号/基线分支:内核配置确认要的两项事实,表单下单就收——
     * 和交付方式同一逻辑,不让模型开工后逐项来问。 */
    ticket: { enabled: boolean; required: boolean };
    baseline: { enabled: boolean; default: string };
    /** 交付方式选项:**现读内核 flow.json**,不在 TS 侧另抄一份。
     * 空数组=读不到内核定义,表单就别摆出选择(下单不预选,卡到时
     * 老老实实问人)。 */
    workflows: Array<
      { key: string; label: string; steps?: number; acks?: number }>;
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
        label: "模型网关未配置(管理页 → 模型网关,填写地址、API Key 和模型名称)"
          + ";没有它任何任务都跑不起来" });
    }
    if (this.options.host && !this.effectivePlatformUrl()) {
      blockers.push({ key: "platform", where: "admin",
        label: "交付基础设施未就绪；代码暂时无法交付，请联系部署维护人员检查 MR / 流水线服务" });
    }
    return {
      model: active,
      repair_rounds: this.options.settings?.runtime().repair_rounds
        ?? this.options.delivery?.repairRounds,
      // 没接内核模式=任务不碰代码仓,表单别摆出输入框骗人。
      repo: { enabled: !!this.options.host, required: !!this.options.host },
      ticket: { enabled: !!this.options.host, required: !!this.options.host },
      baseline: { enabled: !!this.options.host, default: "master" },
      workflows: workflowChoices(this.options.host?.kernelRoot),
      blockers,
      needs: {
        // 个人令牌该不该要,由部署形态决定(同上:只拦真会咬人的)。
        git_token: !!this.options.host,
        // 假小鲁班不索令牌(没人消费它);切了真端点要求立刻恢复。
        // 判定在 Notifier 里,跟着生效端点走——内网 agent 实测在演示
        // 形态被"先配令牌"挡住,那是一道谁也过不去也不必过的假门。
        luban_token: this.options.notifier?.needsPersonalToken() ?? false,
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

  /**
   * 用户在下单页显式触发的只读目录发现。令牌把“谁、哪些仓、哪条
   * 基线、当时看到的 Skill”绑在一起；创建任务只交所选 id，不接受
   * 浏览器自报路径或正文。
   */
  async scanRepositorySkills(input: {
    repositories: string[];
    baseline?: string;
    account?: string;
  }): Promise<RepositorySkillCatalogResponse> {
    if (!this.options.host) throw new Error("本部署未接代码仓，无法读取仓内能力");
    const repositories = input.repositories
      .map((item) => String(item).trim()).filter(Boolean)
      .filter((item, index, all) => all.indexOf(item) === index);
    if (!repositories.length) throw new Error("请先填写至少一个代码仓");
    if (repositories.length > 12) throw new Error("一次最多读取 12 个代码仓");
    repositories.forEach(validateRepositoryAddress);
    const baseline = input.baseline?.trim() || "master";
    if (/\s/.test(baseline)) throw new Error("基线分支不能含空白字符");

    const credential = this.options.gitCredential?.(input.account);
    const prepared = credential
      ? this.prepareHostGitCredential(credential) : undefined;
    const catalogs: RepositorySkillCatalog[] = [];
    try {
      for (const repository of repositories) {
        const discovered = await discoverRepositorySkills({
          repository,
          baseline,
          credentialHelper: prepared?.helper,
          timeoutMs: 30_000,
        });
        catalogs.push(this.catalogWithConflicts({
          ...discovered,
          // 服务端选择与任务 summary 均使用用户输入的规范化字符串；
          // 发现器内部即使为本地相对路径做了绝对化，也不能让 key 漂移。
          repository,
        }));
      }
    } finally {
      this.cleanupHostGitCredential(prepared);
    }

    const now = Date.now();
    for (const [key, value] of this.repositorySkillCatalogs) {
      if (value.expiresAt <= now) this.repositorySkillCatalogs.delete(key);
    }
    while (this.repositorySkillCatalogs.size >= 64) {
      const oldest = this.repositorySkillCatalogs.keys().next().value;
      if (!oldest) break;
      this.repositorySkillCatalogs.delete(oldest);
    }
    const catalogToken = randomUUID();
    this.repositorySkillCatalogs.set(catalogToken, {
      account: input.account,
      repositories,
      baseline,
      expiresAt: now + 10 * 60_000,
      catalogs,
    });
    return { catalog_token: catalogToken, repositories: catalogs };
  }

  private catalogWithConflicts(
    catalog: RepositorySkillCatalog,
  ): RepositorySkillCatalog {
    const hostNames = new Set(
      hostSkillNames(this.options.dataDir).map((name) => name.toLowerCase()));
    const counts = new Map<string, number>();
    for (const skill of catalog.skills) {
      const key = skill.name.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const reserved = (name: string) => name === "mae-flow"
      || name === "build-fix"
      || /^(?:comet|openspec|ponytail)(?:-|$)/.test(name);
    const skills = catalog.skills.map((skill): RepositorySkillDescriptor => {
      const name = skill.name.toLowerCase();
      const conflict = hostNames.has(name)
        ? "与平台常驻 Skill 同名"
        : reserved(name)
          ? "与 Mae-Flow 平台能力重名"
          : (counts.get(name) ?? 0) > 1
            ? "本仓存在同名 Skill，无法确定应加载哪一个"
            : undefined;
      return conflict
        ? { ...skill, selectable: false, warning: conflict }
        : skill;
    });
    return { ...catalog, skills };
  }

  private selectedSkillsFromCatalog(options: {
    catalogToken?: string;
    selectedIds?: string[];
    repositories: string[];
    baseline?: string;
    account?: string;
    /** Chain 检视重新读取目录时，不能因单个仓临时扫描失败
     * 就把父任务上已经确认的 Skill 清掉。仅该场景传入旧值；
     * 新下单仍不会从扫描失败的仓带入任何选择。 */
    preserveForErroredRepositories?: SelectedRepositorySkill[];
  }): SelectedRepositorySkill[] {
    const ids = [...new Set((options.selectedIds ?? []).map(String))];
    if (!ids.length && !options.catalogToken) return [];
    if (!options.catalogToken) throw new Error("选择仓内能力前请重新读取 Skill 目录");
    const ticket = this.repositorySkillCatalogs.get(options.catalogToken);
    if (!ticket || ticket.expiresAt <= Date.now()) {
      this.repositorySkillCatalogs.delete(options.catalogToken);
      throw new Error("仓内能力目录已过期，请重新读取后再发起任务");
    }
    if (ticket.account !== options.account) {
      throw new Error("仓内能力目录不属于当前登录用户");
    }
    if (JSON.stringify(ticket.repositories) !== JSON.stringify(options.repositories)
        || ticket.baseline !== options.baseline) {
      throw new Error("代码仓或基线已变化，请重新读取仓内能力");
    }
    if (ids.length > 20) throw new Error("每个任务最多选择 20 个仓内 Skill");
    const byId = new Map<string, {
      catalog: RepositorySkillCatalog;
      skill: RepositorySkillDescriptor;
    }>();
    const successfulRepositories = new Set(
      ticket.catalogs.filter((catalog) => !catalog.error)
        .map((catalog) => catalog.repository));
    for (const catalog of ticket.catalogs) {
      // 失败目录不参与 ID 还原。即使未来某个发现器在
      // error 上还附了部分 skills，也不能把不完整快照当成可选清单。
      if (catalog.error) continue;
      for (const skill of catalog.skills) byId.set(skill.id, { catalog, skill });
    }
    const selected = ids.map((id): SelectedRepositorySkill => {
      const found = byId.get(id);
      if (!found || !found.skill.selectable) {
        throw new Error("所选仓内 Skill 不存在或不可由 Agent 自主使用，请重新读取");
      }
      if (!validRepositorySkillPath(found.skill.relative_path)) {
        throw new Error("仓内 Skill 路径不合法");
      }
      return {
        id: found.skill.id,
        repository: found.catalog.repository,
        revision: found.catalog.revision,
        name: found.skill.name,
        description: found.skill.description,
        relative_path: found.skill.relative_path,
        source: found.skill.source,
        digest: found.skill.digest,
      };
    });
    const merged = options.preserveForErroredRepositories === undefined
      ? selected
      : ticket.repositories.flatMap((repository) => {
          if (successfulRepositories.has(repository)) {
            // 成功仓以本次 IDs 为准；没选中任何项就是显式清空。
            return selected.filter((skill) => skill.repository === repository);
          }
          // catalog.error（以及防御性的目录缺失）保留该仓旧值，
          // 不影响其他成功仓的更新。
          return options.preserveForErroredRepositories!
            .filter((skill) => skill.repository === repository)
            .map((skill) => ({ ...skill }));
        });
    if (merged.length > 20) {
      throw new Error("每个任务最多选择 20 个仓内 Skill");
    }
    this.repositorySkillCatalogs.delete(options.catalogToken);
    return merged;
  }

  create(
    requirement: string,
    options: {
      /** 用户明确填写的任务名称：只用于列表/通知/搜索，不替代需求原文。 */
      title?: string;
      account?: string;
      repo?: string;
      repos?: string[];
      lane?: string;
      /** 需求/问题单号(REQ/DTS):内核配置确认的"单号"项,下单就给,
       * 不让模型开工后再来问一遍(用户 2026-08-19 拍板)。 */
      ticket?: string;
      /** 基线分支,默认 master(同一次拍板)。 */
      baseline?: string;
      model?: { provider: string; model: string };
      repairRounds?: number;
      /** Chain 确认后生成的仓库交付任务使用；不暴露给普通 API。 */
      parentTaskId?: string;
      blockedBy?: string[];
      /** 普通 API 只提交短期目录令牌和所选 id；服务端把它还原为
       * 已验证清单。repositorySkills 只供 Chain 拆单内部透传。 */
      repositorySkillCatalogToken?: string;
      selectedRepositorySkillIds?: string[];
      repositorySkills?: SelectedRepositorySkill[];
      /** 仅供旧跨仓父任务拆单：旧现场没有 repository_skills 字段时，
       * 子任务必须继续保留 undefined，让物化器走旧版全量加载兼容；
       * 不能与新下单的“明确未选择”空数组混为一谈。 */
      preserveUndefinedRepositorySkills?: boolean;
    } = {},
  ): TaskSummary {
    const explicitTitle = options.title?.trim().replace(/\s+/g, " ") || undefined;
    if (explicitTitle && explicitTitle.length > 80) {
      throw new Error("任务名称不能超过 80 个字符");
    }
    // 交付方式:选项是内核的领地,现读它的 flow.json 校验
    // (2026-08-18 修正:此前 TS 侧自造"快速/慢速",与内核的
    // full/hotfix/tweak/review 对不上,预选永远匹配不上内核举的卡,
    // 用户下单答过一次、页面上还要再答一次)。读不到内核定义时不校验
    // ——宁可放行也不拿一套猜出来的选项挡人。
    const laneChoices = workflowChoices(this.options.host?.kernelRoot)
      .map((item) => item.label);
    const requestedLane = options.lane?.trim() || undefined;
    if (requestedLane !== undefined && laneChoices.length
        && !laneChoices.includes(requestedLane)) {
      throw new Error(
        `交付方式只能是 ${laneChoices.join("/")},收到: ${requestedLane}`);
    }
    // 单号/基线分支:内核配置确认要的两项事实,下单就收齐(和交付方式
    // 同一逻辑:能在表单上一次给完的,不让模型开工后逐项来问)。单号
    // 只在内核模式必填——纯会话形态没有配置确认这回事。校验只做"像不
    // 像个单号"的最低限(非空、无空白);REQ→feat/DTS→fix 的推导是
    // 内核的判定,宿主不代判。
    const ticket = (options.ticket ?? "").trim() || undefined;
    if (ticket && /\s/.test(ticket)) {
      throw new Error("单号不能含空白字符");
    }
    if (!ticket && this.options.host && !this.options.host.repoPath) {
      throw new Error("请填写需求/问题单号(REQ/DTS)——分支名和提交信息都要用它");
    }
    const baseline = (options.baseline ?? "").trim()
      || (this.options.host ? "master" : undefined);
    if (baseline && /\s/.test(baseline)) {
      throw new Error("基线分支不能含空白字符");
    }
    const repositories = (options.repos?.length
      ? options.repos : options.repo ? [options.repo] : [])
      .map((item) => String(item).trim()).filter(Boolean)
      .filter((item, index, all) => all.indexOf(item) === index);
    const repo = repositories[0];
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
    for (const candidate of repositories) {
      if (!this.options.host) {
        throw new Error("本部署未接内核模式,任务不克隆代码仓");
      }
      // SSH、明文 userinfo 与控制字符的口径同时服务任务创建和 Skill
      // 目录扫描，不能让“能列出、却注定无法交付”的仓进入下一步。
      validateRepositoryAddress(candidate);
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
    const repositorySkills = options.preserveUndefinedRepositorySkills
      ? undefined
      : options.repositorySkills !== undefined
        ? options.repositorySkills.map((skill) => {
            if (!repositories.includes(skill.repository)
                || !validRepositorySkillPath(skill.relative_path)) {
              throw new Error(`仓内 Skill ${skill.name} 不属于本任务代码仓`);
            }
            return { ...skill };
          })
        : this.selectedSkillsFromCatalog({
            catalogToken: options.repositorySkillCatalogToken,
            selectedIds: options.selectedRepositorySkillIds,
            repositories,
            baseline,
            account: options.account,
          });
    if ((repositorySkills?.length ?? 0) > 20) {
      throw new Error("每个任务最多选择 20 个仓内 Skill");
    }
    this.counter += 1;
    const id = `task-${this.counter}`;
    const workspace = join(this.options.dataDir, id);
    mkdirSync(workspace, { recursive: true });
    const summary: TaskSummary = {
      id,
      // 旧调用方/历史兼容仍可从首行生成；产品下单界面会明确收任务名称，
      // 不再让用户输入的长需求文档悄悄承担标题职责。
      title: explicitTitle ?? taskTitle(requirement),
      requirement,
      status: "queued",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_progress_at: new Date().toISOString(),
      workspace,
      luban_account: options.account || undefined,
      repo_url: repo,
      repositories: repositories.length ? repositories : undefined,
      repository_skills: repositorySkills,
      requirement_graph: repositories.length
        ? {
            stage: repositories.length > 1 ? "analysis" : "confirmed",
            repositories: repositories.map((url, index) => ({
              id: `repo-${index + 1}`,
              name: basename(url).replace(/\.git$/, "") || `仓库 ${index + 1}`,
              url,
            })),
            dependencies: [],
          }
        : undefined,
      parent_task_id: options.parentTaskId,
      blocked_by: options.blockedBy?.length ? [...options.blockedBy] : undefined,
      // 用户拍板:交付方式下单就定,不让 agent 再问一遍。默认取内核
      // 选项里的第一项(通常是"完整开发"),读不到内核就不预选。
      lane: requestedLane ?? laneChoices[0],
      ticket,
      baseline,
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
        // 旧版遗留的交付方式("快速/慢速"是宿主自造的词,内核不认):
        // 留着它,预答会永远命中不了内核举的卡——续跑的老单看起来就是
        // "更新了还在中途问交付方式"。清掉+留痕,让老单诚实地走真等人。
        const laneChoices = workflowChoices(this.options.host?.kernelRoot)
          .map((item) => item.label);
        if (summary.lane && laneChoices.length
            && !laneChoices.includes(summary.lane)) {
          this.options.log?.(
            `任务 ${summary.id} 的交付方式「${summary.lane}」不在内核选项`
            + `(${laneChoices.join("/")})里——旧版自造的词,已清除;`
            + `流程举卡时将真等人,答卡请选内核选项原文`);
          summary.lane = undefined;
        }
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
        let terminalMismatch = false;
        if (["completed", "await_merge"].includes(summary.status)
            && !this.settledBeforeContract(task)) {
          const attestation = this.completionAttestation(task);
          if (attestation && !attestation.complete) {
            terminalMismatch = true;
            delete summary.completed_at;
            if (attestation.kind === "external_verify"
                || (attestation.terminal && attestation.external_required)) {
              // 进程可能死在“平台已回结果→内核登记→状态投影”之间。
              // 恢复只重做对账/核销，不拿旧 task.json 直接放行。
              summary.status = "verifying";
              summary.detail = `恢复对账：${attestation.reason}`;
              summary.delivery = {
                ...summary.delivery,
                mr_state: "验证中",
                waiting_on: attestation.reason,
              };
            } else {
              summary.status = "queued";
              summary.detail = `恢复对账发现伪终态：${attestation.reason}，`
                + "将从内核 current 继续";
              task.resume = true;
            }
            this.persist(task);
          }
        }
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
        } else if (summary.status === "verifying"
            && summary.delivery?.pipeline === "success"
            && summary.delivery.sha) {
          // 平台已绿但内核还没 PASS（进程可能死在登记窗口，或当时逐项
          // 结果不完整）：重启只重做核销，不重复触发同 SHA 流水线。
          this.bypass(task, "流水线证据核销",
            this.tryDeliver(task, task.controlEpoch));
        } else if (summary.status === "verifying"
            && !summary.delivery?.stalled) {
          // 没有可续轮的旧平台状态也不能静默蹲住；让 tryDeliver 查远端
          // 分支并触发/恢复权威验证，仍由内核裁决是否能到 end。
          // 这一支原来只认 terminalMismatch(落盘是 completed/await_merge
          // 的伪终态),于是"落盘就是 verifying、连平台状态都没有"的那类
          // ——推送失败停在等待点的——重启后一行代码都不碰它,永远蹲着
          // (实测)。已经如实停摆的不动:那是在等人,不是在等机器。
          this.bypass(task, "验证恢复对账",
            this.tryDeliver(task, task.controlEpoch));
        }
        // 合入监控同理续:重启前在等合入/等审批的接着盯(平台不支持
        // 门禁契约的,watchMerge 一轮就退,行为与旧版完全一致)。
        if (summary.status === "await_merge") {
          this.bypass(task, "合入监控",
            this.watchMerge(task, task.controlEpoch));
        }
        // 旧版本可能把一个已经 resolved 的 WaitingRecord 再次写成
        // waiting_for_human(重建会话重放同 call_id 时发生)。这是矛盾
        // 状态:人已经答过,页面却还在催人。恢复时以 waiting.json 的
        // resolved 事实为准,自动续跑并把原决定带回重建会话。
        if (summary.status === "waiting_for_human"
            && summary.waiting?.status === "resolved") {
          task.pendingResume = { ...summary.waiting };
          summary.waiting = undefined;
          summary.status = "queued";
          summary.detail = "检测到已完成的重复决策卡，自动恢复续跑";
          this.persist(task);
          this.queue.push(summary.id);
          requeued += 1;
        } else if (summary.status === "running" || summary.status === "queued") {
          summary.status = "queued";
          if (!terminalMismatch) summary.detail = "服务重启,等待续跑";
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
    // stalled = 外部验证的自愈预算已经烧完并如实停下(推送一直失败、
    // 流水线迟迟不给可核销结果……)。它必须和修复环停机同等对待:
    // 那种状态下没有任何东西在收敛,再拦着人重跑就是把任务锁死。
    const repairStopped = delivery?.loop?.state === "halted"
      || delivery?.loop?.state === "exhausted"
      || Boolean(delivery?.stalled)
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
      // 人工背书"再试一次":停摆账本清掉,自愈预算重新开表。
      task.summary.delivery.stalled = undefined;
      task.summary.delivery.verify_deadline = undefined;
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

  /** 需求图体检(只验不建):图齐不齐、依赖合不合法、有没有环。
   * 单独成函数的原因是 decide() 的顺序纪律——校验必须在决定落袋
   * (humanGate.resolve 的乐观锁)之前,建任务必须在之后;原来两件事
   * 挤在一个函数里,版本冲突 409 时子任务已经先落地了。 */
  private requirementGraphPlan(task: TaskState): {
    graph: RequirementGraph;
    order: string[];
    incoming: Map<string, string[]>;
  } {
    this.refreshRequirementGraph(task);
    const graph = task.summary.requirement_graph;
    if (!graph || graph.repositories.length !== task.summary.repositories?.length) {
      throw new NotFoundError("需求图尚未生成完整，请先让 Agent 补齐分析产物");
    }
    const ticket = task.summary.ticket ?? task.summary.id;
    const artifact = task.cwd
      ? readArtifact(task.cwd, `${ticket}/CHAIN-${ticket}.md`)
      : undefined;
    if (!artifact?.content.trim()) {
      throw new NotFoundError("跨仓方案正文尚未生成，请先让 Agent 补齐 Chain 文档");
    }
    const ids = new Set(graph.repositories.map((repository) => repository.id));
    const prerequisites = new Map<string, string[]>();
    for (const id of ids) prerequisites.set(id, []);
    for (const edge of graph.dependencies) {
      if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) {
        throw new NotFoundError("需求图包含无效依赖，请让 Agent 修正后再确认");
      }
      // `from 依赖 to`：from 的前置项是 to。
      prerequisites.get(edge.from)!.push(edge.to);
    }
    const remaining = new Set(ids);
    const order: string[] = [];
    while (remaining.size) {
      const ready = [...remaining].filter((id) =>
        (prerequisites.get(id) ?? []).every((parent) => !remaining.has(parent)));
      if (!ready.length) throw new NotFoundError("仓库依赖存在循环，不能生成任务");
      ready.forEach((id) => { remaining.delete(id); order.push(id); });
    }
    return { graph, order, incoming: prerequisites };
  }

  /** 人工确认 Chain 产物后，把图上的节点落成现有普通任务。
   * 可重入:已有 task_id 的仓跳过(第 N 个仓 create 抛错或中途重启后
   * 重试,不许把前面的仓再建一遍);每建一个就 persist——task_id 只写
   * 内存的话,重启即失忆,重试必出重复任务。 */
  private createRepositoryDeliveries(task: TaskState): void {
    const { graph, order, incoming } = this.requirementGraphPlan(task);
    if (graph.repositories.every((repository) => repository.task_id)) return;
    const artifact = task.cwd
      ? readArtifact(task.cwd,
          `${task.summary.ticket ?? task.summary.id}/CHAIN-${task.summary.ticket ?? task.summary.id}.md`)
      : undefined;
    const taskIds = new Map<string, string>();
    for (const repository of graph.repositories) {
      if (repository.task_id) taskIds.set(repository.id, repository.task_id);
    }
    for (const id of order) {
      const repository = graph.repositories.find((item) => item.id === id)!;
      if (repository.task_id) continue;
      const blockers = (incoming.get(id) ?? [])
        .map((parent) => taskIds.get(parent)).filter(Boolean) as string[];
      // 方案正文**不进需求原文**(2026-08-19 内网实锤:整份方案含
      // "逐仓启动说明"塞进 prompt,模型把它当实施计划直接开写代码,
      // 跳过 init→配置确认整个流程头部)。方案落到子任务工作区文件,
      // launch 时进克隆并经下单事实把「需求文档」指过去——模型按内核
      // 流程在配置阶段读它,而不是开场就被它牵着跑。
      const requirement = [
        task.summary.requirement,
        "本需求已跨仓分析并经人工检视确认。完整跨仓方案(仓库职责、"
          + "接口契约、依赖关系)在工作区文件 .mae-flow-chain.md,"
          + "配置确认的「需求文档」会自动指向它——按内核流程推进,"
          + "在需求/设计阶段读它,不要跳过流程直接实施。只交付当前仓"
          + "职责;发现方案不够用时停止并报告,不要自行改变跨仓契约。",
        `当前仓库:${repository.name}\n当前职责:${repository.responsibility ?? "见方案正文"}`,
      ].filter(Boolean).join("\n\n");
      const preserveUndefinedRepositorySkills =
        task.summary.repository_skills === undefined;
      const child = this.create(requirement, {
        title: taskTitle(
          `${task.summary.title ?? taskTitle(task.summary.requirement)} · ${repository.name}`),
        account: task.summary.luban_account,
        repo: repository.url,
        lane: task.summary.lane,
        ticket: task.summary.ticket,
        baseline: task.summary.baseline,
        model: task.summary.model_choice,
        repairRounds: task.summary.repair_rounds,
        parentTaskId: task.summary.id,
        blockedBy: blockers,
        repositorySkills: preserveUndefinedRepositorySkills
          ? undefined
          : task.summary.repository_skills!.filter(
              (skill) => skill.repository === repository.url),
        preserveUndefinedRepositorySkills,
      });
      // 方案文档放子任务 workspace 根(不删现场,重启/重建都在);
      // launch 每次把它带进仓库克隆。写不进去不拦拆单——launch 侧
      // 缺文件时子任务照常走流程,只是配置阶段要人补需求文档。
      try {
        writeFileSync(join(child.workspace, "chain-plan.md"), [
          artifact?.content ?? "",
          `\n\n---\n当前仓库:${repository.name}\n`
            + `当前职责:${repository.responsibility ?? "见方案正文"}\n`,
        ].join(""));
      } catch (cause) {
        this.options.log?.(
          `任务 ${child.id} 方案文档落盘失败(fail-open): ${String(cause)}`);
      }
      repository.task_id = child.id;
      taskIds.set(id, child.id);
      this.persist(task);
    }
    graph.stage = "confirmed";
    task.summary.detail = `需求方案已确认，已生成 ${order.length} 个仓库交付任务`;
    this.persist(task);
  }

  /** 需求图面板不是第二套审批:分析会话正在等人时,这颗结构化按钮
   * 先消费当前 HumanGate 决定、恢复同一会话,再幂等生成各仓普通任务。
   * 这样不会出现“子任务已经生成,父分析单却还在等确认”的双状态。
   * 已经收尾的旧单仍允许从图面板补建,用于兼容历史现场。 */
  async confirmRequirementGraph(
    id: string,
    skillSelection?: {
      catalog_token?: string;
      selected_ids?: string[];
    },
  ): Promise<TaskSummary> {
    const task = this.tasks.get(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    if (!this.isRequirementAnalysis(task)) {
      throw new NotFoundError("该任务不是多仓需求分析单,没有需求图可确认");
    }
    this.requirementGraphPlan(task);
    const alreadyGenerated = task.summary.requirement_graph?.repositories
      .every((repository) => repository.task_id) ?? false;
    if (alreadyGenerated && task.summary.status !== "waiting_for_human") {
      return { ...task.summary };
    }
    if (task.summary.status === "waiting_for_human" && task.summary.waiting) {
      const questions = (
        (task.summary.waiting.question as any)?.questions ?? []
      ) as Array<{ question?: string }>;
      if (questions.length !== 1) {
        throw new NotFoundError(
          "仍有多项需求问题待澄清，请先逐题处理，再确认跨仓方案",
        );
      }
      await this.decide(id, {
        state_version: task.summary.waiting.state_version,
        decision: "确认并生成任务",
        repository_skill_catalog_token: skillSelection?.catalog_token,
        selected_repository_skill_ids: skillSelection?.selected_ids,
        // 收尾令随决定送达:确认后父会话再举卡会被系统代答赶下台
        // (autoAnswerFor 的分析单兜底),但第一选择是它自己别举。
        notes: "各仓交付任务由平台自动生成与调度,不归本会话跟进;"
          + "请写一段简短收尾说明后立即结束,不要再提问。",
      });
      // decide 会在标准选项命中时生成任务；这里再走一次幂等兜底，
      // 让模型即使把选项写成“方案通过”也不会丢掉拆单动作。
      this.createRepositoryDeliveries(task);
      return { ...task.summary };
    }
    if (!["completed", "failed", "canceled"].includes(task.summary.status)) {
      throw new NotFoundError("需求分析尚未进入人工检视，暂不能确认方案");
    }
    this.createRepositoryDeliveries(task);
    this.bypass(undefined, "任务泵", this.pump());
    return { ...task.summary };
  }

  /** 父分析单确认即硬收口(用户拍板 2026-08-19:拆单后它的使命就
   * 结束了)。不等模型自觉写收尾:并发槽让给子任务,"确认后又举卡"
   * 的窗口彻底关死。会话直接终止没有可丢的——CHAIN 方案在盘上,
   * 子任务已生成,决定也已落袋(waiting.json)。teardown 与 cancel
   * 同款:先涨 controlEpoch 让在途 settle 对不上暗号,不回写状态。 */
  private async finishRequirementAnalysis(task: TaskState): Promise<void> {
    task.controlEpoch += 1;
    task.pauseRequested = false;
    this.removeFromQueue(task.summary.id);
    task.summary.status = "completed";
    task.summary.completed_at = new Date().toISOString();
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
    this.notifyOutcome(task);
    this.bypass(undefined, "任务泵", this.pump());
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
      /** Chain 检视卡上可在同一次决定里调整按仓 Skill。服务端先把
       * 选择绑定到父分析单并落盘，再生成子任务；这不是第二张审批卡。 */
      repository_skill_catalog_token?: string;
      selected_repository_skill_ids?: string[];
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
    // 多仓确认的顺序纪律:图的体检放在决定落袋**之前**(图不完整就报
    // 错,决定不消费,agent 继续等,用户看得到原因);建任务放在落袋
    // **之后**(乐观锁 409 时不许先把子任务生出来)。字符串匹配只是
    // "模型把选项原文写对了"的顺路便车,正门是需求图面板的确认按钮
    // (confirmRequirementGraph)——选项文字漂了也不丢单。
    const confirmingGraph = this.isRequirementAnalysis(task)
      && Object.values(answers).concat(decision).some((answer) =>
        answer.includes("确认并生成任务"));
    if (confirmingGraph) this.requirementGraphPlan(task);
    const updatesRepositorySkills =
      input.repository_skill_catalog_token !== undefined
      || input.selected_repository_skill_ids !== undefined;
    if (updatesRepositorySkills) {
      if (!this.isRequirementAnalysis(task)) {
        throw new NotFoundError("只有跨仓方案检视可以在决定时调整仓内 Skill");
      }
      // 只允许在图已经可供检视、且 HumanGate 仍是当前版本时换选择。
      // 先验版本检查避免陈旧页面消费 catalog token、覆盖较新的选择；
      // 本方法到 humanGate.resolve 之间没有 await，单进程内不会被另一
      // 个决定插入。
      if (waiting.state_version !== input.state_version
          || waiting.status !== "waiting") {
        throw new StateConflictError(`任务状态已变化:待办 ${waiting.waiting_id} 版本不匹配`);
      }
      this.requirementGraphPlan(task);
      task.summary.repository_skills = this.selectedSkillsFromCatalog({
        catalogToken: input.repository_skill_catalog_token,
        selectedIds: input.selected_repository_skill_ids,
        repositories: task.summary.repositories ?? [],
        baseline: task.summary.baseline,
        account: task.summary.luban_account,
        preserveForErroredRepositories: task.summary.repository_skills ?? [],
      });
      // 必须先于 humanGate.resolve/createRepositoryDeliveries 落盘：确认
      // 后父会话会立刻收口，重启也只能从 task.json 恢复这份选择。
      this.persist(task);
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
    // 决定生效之后才生子任务(体检在落袋前做过,这里不会因图不齐半途
    // 而废)。建任务失败不回滚决定——决定是用户的事实;失败原因写进
    // detail,面板确认按钮随时可重试(可重入)。
    if (confirmingGraph) {
      try {
        this.createRepositoryDeliveries(task);
        // 拆单成功=父分析单使命结束(用户拍板 2026-08-19):确认即
        // 硬收口,不等模型自觉写完——省下并发槽给子任务,也彻底关掉
        // "确认后又举卡让人检视子任务"的窗口(预答兜底退居末防线)。
        // 会话直接终止:CHAIN 方案在盘上、子任务已生成,没有可丢的。
        task.summary.waiting = undefined;
        // 决定必须先回注再掐会话:会话此刻停在 AskUserQuestion 工具里
        // 等这份决定,不解开它 abort 会一直等回合收束(实测挂死——
        // 等待必须带出路,不许无限等的红线在自己身上也成立)。回注是
        // 同步解扣,后续回合不等,收口里的 abort 负责掐断。
        if (task.driver) {
          this.bypass(task, "分析收口回注",
            task.driver.resumeWithDecision(resolved).then(() => undefined));
        }
        await this.finishRequirementAnalysis(task);
        return { ...task.summary };
      } catch (cause) {
        task.summary.detail =
          `确认已收到,但生成仓库任务失败:${String(cause)}。`
          + "可在需求图面板重试「确认并生成任务」";
        this.options.log?.(`任务 ${id} 生成仓库交付失败: ${String(cause)}`);
      }
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
    // 等它的任务不许无限等(取消是终态):立刻跑一遍泵,把 blocked_by
    // 指向本单的排队任务如实清账,而不是等下一次碰巧有人触发泵。
    this.bypass(undefined, "任务泵", this.pump());
    return { ...task.summary };
  }

  private removeFromQueue(id: string): void {
    this.queue = this.queue.filter((queued) => queued !== id);
  }

  private current(task: TaskState, epoch: number): boolean {
    return task.controlEpoch === epoch && task.summary.status !== "canceled";
  }

  /**
   * completed/await_merge/blocked_by 共用的内核终态证明。
   *
   * 多仓分析单是 Cloud 自己的前置会话，本来就没有 mae-flow 状态；纯
   * 会话演练同理。除此之外一律不能拿 task.json.status 自证完成。
   */
  /** 这一单是不是在"外部验证契约"存在之前就已经收口的。
   *
   * 踩过的坑(读代码逮住,第一次重启就会发生):恢复时对每个落盘为
   * completed/await_merge 的任务重做终态对账,而老单的现场里根本没有
   * execution_contract——判据于是按"云端默认三项交流水线"取,老单永远
   * 拿不出流水线逐项 PASS,被一律判成伪终态:状态翻回验证中,接着
   * tryDeliver 真的执行 git push。已合入、远端分支早删掉的老单会被
   * **重新推回去**,任务列表里一堆历史单变"验证中"。
   *
   * 老单是按当时的规矩收的口,不该用后来的尺子重新量。判据取两条
   * 机械事实:现场没有 execution_contract(新单必然有,内核从下单事实
   * 写入),且从来没有过外部验证记录;或者交付账本已经记了合入。 */
  private settledBeforeContract(task: TaskState): boolean {
    const delivery = task.summary.delivery;
    if (delivery?.mr_state === "已合入") return true;
    if (!task.cwd) return false;
    try {
      const statePath = join(task.cwd, ".mae-flow.json");
      if (!existsSync(statePath)) return false;
      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      return !state?.execution_contract
        && !state?.quality?.external_verification;
    } catch {
      // 读不出来就不敢断言"老单",走原有对账(宁可多查一次)。
      return false;
    }
  }

  private completionAttestation(
    task: TaskState,
  ): KernelCompletionAttestation | undefined {
    if (!this.options.host || this.isRequirementAnalysis(task)) return undefined;
    return inspectKernelCompletion(
      task.cwd,
      this.options.host.kernelRoot,
      true,
    );
  }

  private dependencyCompleted(task: TaskState | undefined): boolean {
    if (!task || task.summary.status !== "completed") return false;
    return this.completionAttestation(task)?.complete ?? true;
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
    // 前置死透的排队任务先清账,不许无限等(哪怕队列里还有别的活可干,
    // 也不能让它静默蹲着):
    // - 前置**已取消**是用户意志的终态,等它=永远等——本任务如实
    //   failed,说明白是替谁陪葬;
    // - 前置**失败**还有救(可重试),继续排队但把话写在 detail 上,
    //   人知道该去修谁或者干脆取消本单。
    for (const queued of [...this.queue]) {
      const candidate = this.tasks.get(queued);
      if (!candidate?.summary.blocked_by?.length) continue;
      const gone = candidate.summary.blocked_by.filter((dependency) => {
        const status = this.tasks.get(dependency)?.summary.status;
        // 不存在的前置和取消一样是死透:没人能把它变回 completed。
        return status === "canceled" || status === undefined;
      });
      if (gone.length) {
        this.queue.splice(this.queue.indexOf(queued), 1);
        candidate.summary.status = "failed";
        candidate.summary.detail =
          `前置任务 ${gone.join("、")} 已取消或不存在,本任务不会启动`;
        this.persist(candidate);
        continue;
      }
      const stuck = candidate.summary.blocked_by.filter((dependency) =>
        this.tasks.get(dependency)?.summary.status === "failed");
      if (stuck.length) {
        const detail = `前置任务 ${stuck.join("、")} 失败,`
          + "重试它后本任务自动启动;不打算修就取消本任务";
        if (candidate.summary.detail !== detail) {
          candidate.summary.detail = detail;
          this.persist(candidate);
        }
      }
    }
    while (this.runningCount < max && this.queue.length) {
      const readyIndex = this.queue.findIndex((queued) => {
        const candidate = this.tasks.get(queued);
        if (!candidate) return true;
        return (candidate.summary.blocked_by ?? []).every((dependency) =>
          this.dependencyCompleted(this.tasks.get(dependency)));
      });
      if (readyIndex < 0) {
        for (const queued of this.queue) {
          const candidate = this.tasks.get(queued);
          if (!candidate?.summary.blocked_by?.length) continue;
          const waiting = candidate.summary.blocked_by.filter((dependency) =>
            !this.dependencyCompleted(this.tasks.get(dependency)));
          const detail = `等待前置任务 ${waiting.join("、")} 完成`;
          if (candidate.summary.detail !== detail
              && !candidate.summary.detail?.startsWith("前置任务")) {
            candidate.summary.detail = detail;
            this.persist(candidate);
          }
        }
        break;
      }
      const [id] = this.queue.splice(readyIndex, 1);
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
      // 兼容旧版本现场：明文凭据/helper 曾落在 agentDir。任何模型文件
      // 与 CloudSession 创建之前先机械清掉，避免恢复任务把旧秘密重新
      // 暴露给 Agent。
      this.hardenAgentGitBoundary(agentDir);
      // 模型网关热改边界:在这里生效——每个新会话起时现读设置,
      // 在跑的会话不换血(管理页如实写明了这一条)。
      const modelOverride = this.options.settings?.models() ?? {};
      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify(modelOverride.json ?? this.options.modelsJson));
      // 个人 Git 身份每次启动现读。用户名/邮箱只用于 commit 署名；
      // token 仅在宿主 clone/push 的同步窗口进入 0700 临时目录，绝不
      // 进入 agentDir、仓库配置或 Agent 会话。
      const gitIdentity =
        this.options.gitCredential?.(task.summary.luban_account);
      const transcriptPath = join(workspace, "transcript.jsonl");
      // 恢复=工作区(仓库克隆)还在;克隆丢了就只能从头来。
      // savedCwd 必须先落袋:下面 task.cwd 会被暂写成 workspace,
      // 晚一步读就是把重建会话跑进任务根目录(实测:内核找不到
      // 状态文件,messages 报"未初始化")。
      const savedCwd = task.cwd;
      const requirementAnalysis = this.isRequirementAnalysis(task);
      const resuming = task.resume === true
        && !!savedCwd && savedCwd !== workspace && existsSync(savedCwd);
      let cwd = workspace;
      let prompt = task.summary.requirement;
      let hostHooks;
      let repositorySkillPaths: string[] = [];
      let loadedRepositorySkillNames: string[] = [];
      task.cwd = cwd;
      if (this.options.host && requirementAnalysis) {
        const analysisRoot = resuming ? savedCwd! : join(workspace, "repositories");
        if (!resuming) {
          mkdirSync(analysisRoot, { recursive: true });
          const prepared = gitIdentity
            ? this.prepareHostGitCredential(gitIdentity) : undefined;
          try {
            (task.summary.repositories ?? []).forEach((repository, index) => {
              // readonly:分析现场推送硬禁用(没有内核门禁兜底,禁令
              // 不能只写在 prompt 里)。
              this.cloneRepo(analysisRoot, prepared?.helper, gitIdentity,
                repository, task.summary.baseline,
                `${index + 1}-${basename(repository).replace(/\.git$/, "") || "repo"}`,
                true);
            });
          } finally {
            this.cleanupHostGitCredential(prepared);
          }
          const ticket = task.summary.ticket ?? task.summary.id;
          const artifactDir = join(analysisRoot, ".mae-flow-work", ticket);
          mkdirSync(artifactDir, { recursive: true });
          writeFileSync(join(artifactDir, ".ticket-id"), `${ticket}\n`);
        }
        cwd = analysisRoot;
        task.cwd = cwd;
        // 恢复旧分析现场时也清除曾经持久化的 helper；每个仓仍可正常
        // fetch/read，但 pushurl 固定为不可写地址。
        (task.summary.repositories ?? []).forEach((repository, index) => {
          const repoDir = join(analysisRoot,
            `${index + 1}-${basename(repository).replace(/\.git$/, "") || "repo"}`);
          this.hardenAgentGitBoundary(agentDir, repoDir);
        });
        prompt = this.requirementAnalysisPrompt(task, cwd);
        if (resuming) {
          prompt = [
            prompt,
            "服务重启后继续需求理解；已有分析产物和代码现场都在，"
              + "不要从头推翻，先读取现有 Chain 文档并继续。",
            task.pendingResume
              ? "用户对上一个检视问题的答复如下，连同批注一起处理：\n\n"
                + renderDecision(task.pendingResume)
              : "",
            undeliveredInterrupts(workspace).length
              ? "重启前用户还补充了：\n\n"
                + undeliveredInterrupts(workspace).join("\n\n")
              : "",
          ].filter(Boolean).join("\n\n");
        }
      } else if (this.options.host) {
        if (resuming) {
          cwd = savedCwd!;
        } else {
          const prepared = gitIdentity
            ? this.prepareHostGitCredential(gitIdentity) : undefined;
          try {
            cwd = this.cloneRepo(workspace, prepared?.helper, gitIdentity,
              task.summary.repo_url, task.summary.baseline);
          } finally {
            this.cleanupHostGitCredential(prepared);
          }
        }
        task.cwd = cwd;
        this.hardenAgentGitBoundary(agentDir, cwd);
        const activeRepository = task.summary.repo_url
          ?? this.effectiveDefaultRepo();
        if (activeRepository) {
          const materialized = materializeRepositorySkills({
            selected: task.summary.repository_skills,
            bindings: [{ repository: activeRepository, workspace: cwd }],
            snapshotRoot: join(cwd, ".mae-flow-work", "repository-skills"),
            reservedNames: hostSkillNames(this.options.dataDir),
          });
          repositorySkillPaths = materialized.paths;
          loadedRepositorySkillNames = materialized.names;
          for (const warning of materialized.warnings) {
            this.options.log?.(`[repository-skill] 任务 ${task.summary.id}: ${warning}`);
          }
        }
        // 下单事实(.mae-flow-order.json,内核契约):表单收齐的单号/
        // 基线分支/工号/交付方式机械交给内核——config-review 拿它补
        // 缺省、确认卡不再问交付方式、workflow_select 免卡直接 done。
        // 光写进 prompt 靠模型转述不够:弱模型会漏、会把交付方式折成
        // 是/否卡再问一遍(车道实战教训)。交付方式写选项原文(label),
        // 内核认代号或原文全等。每次启动都重写(含重建会话):值来自
        // summary,幂等;fail-open——写不进去只记日志,流程退回转述
        // 老路,绝不拦启动。
        try {
          const utGenerationMethod = availableUtGenerationMethod(
            this.options.dataDir, loadedRepositorySkillNames);
          const order: Record<string, unknown> = {
            execution_contract: { ...CLOUD_EXECUTION_CONTRACT },
            "UT生成方式": utGenerationMethod,
          };
          if (task.summary.ticket) order["单号"] = task.summary.ticket;
          if (task.summary.baseline) {
            order["基线分支"] = task.summary.baseline;
          }
          const badge = gitIdentity?.username ?? task.summary.luban_account;
          if (badge) order["工号"] = badge;
          // 检视意见修复轮:交付方式换成内核的「处理评审意见」,让这一轮
          // 开出来的是一张真正的 review 单,而不是往终态旧单上打补丁。
          // 单号/基线分支/工号照旧沿用——内核按这三项派生分支名
          // ({基线分支}_{工号}_{单号}),沿用就派生出同一个 MR 分支,
          // review 的 branch_create 于是原地冻结 HEAD 当增量基点,不另建。
          // 问不到内核选项原文就退回本单原交付方式(fail-open 到老路)。
          const reviewLane = this.reviewRoundLane(task);
          const lane = reviewLane || task.summary.lane;
          if (lane) order["交付方式"] = lane;
          // 跨仓拆单的方案文档:拆单时落在任务 workspace 根,这里带进
          // 克隆并经下单事实把「需求文档」指过去——方案经内核流程在
          // 配置/需求阶段被读,而不是塞进开场 prompt 被模型当实施计划
          // 直接开写(2026-08-19 内网实锤)。每次启动重拷,幂等。
          const planSource = join(workspace, "chain-plan.md");
          if (existsSync(planSource)) {
            writeFileSync(join(cwd, ".mae-flow-chain.md"),
              readFileSync(planSource, "utf-8"));
            order["需求文档"] = ".mae-flow-chain.md";
          }
          writeFileSync(join(cwd, ".mae-flow-order.json"),
            JSON.stringify(order, null, 2) + "\n");
          // 平台的现场文件不该混进交付提交:登记进 .git/info/exclude
          // (不动仓里的 .gitignore——那是用户的文件)。
          const infoDir = join(cwd, ".git", "info");
          if (existsSync(infoDir)) {
            const excludePath = join(infoDir, "exclude");
            const current = existsSync(excludePath)
              ? readFileSync(excludePath, "utf-8") : "";
            const missing = [".mae-flow-order.json", ".mae-flow-chain.md"]
              .filter((entry) => !current.includes(entry));
            if (missing.length) {
              writeFileSync(excludePath,
                `${current}${current && !current.endsWith("\n") ? "\n" : ""}`
                + missing.join("\n") + "\n");
            }
          }
        } catch (cause) {
          this.options.log?.(
            `[order] 下单事实写入失败(fail-open,退回 prompt 转述): ${cause}`);
        }
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
          flush: kernel.flush.bind(kernel),
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
      // Cloud 固有执行契约:每次代码会话(首跑/重建/修复)都带。它说明
      // 能力边界，不替内核宣告放行，更不把模型自述当质量证据。
      if (this.options.host && !requirementAnalysis) {
        const utGenerationMethod = availableUtGenerationMethod(
          this.options.dataDir, loadedRepositorySkillNames);
        prompt = `${prompt}\n\nCloud 执行契约(宿主事实):本机只负责代码与单元测试的编写。`
          + `编译、单元测试运行和 CodeCheck 统一由绑定当前提交 SHA 的`
          + `权威流水线执行。可用的 UT 编写方式是「${utGenerationMethod}」;`
          + `已装载的 UT skill 只用于指导编写或修改测试，不负责运行测试，`
          + `也不能证明测试通过。不要在本机调用编译、测试运行、CodeCheck`
          + `或相关构建修复能力，不要编造命令、结果、数量或绿灯。`
          + `完成实现与 UT 编写后按内核流程提交；不要读取或索要个人`
          + `Git 令牌，也不要 push，Agent 会话释放后由 Cloud 宿主统一`
          + `推送并复核远端 SHA。流水线失败时，`
          + `只依据该次流水线证据定位并修复。`;
      }
      if (!requirementAnalysis && loadedRepositorySkillNames.length) {
        prompt = `${prompt}\n\n本单已启用仓库自带 Skill：`
          + `${loadedRepositorySkillNames.join("、")}。它们是可选工作指南，`
          + `请根据系统能力目录中的 description 自行判断何时读取；不要求`
          + `逐个使用，也不得用 Skill 改写 Mae-Flow 当前步骤、文件边界、`
          + `Git 权限、Cloud 执行契约或任何验证/交付证据。`;
      }
      // 提交信息规范(部署级):平台的 pre-receive 钩子会按正则拒收不
      // 合规的提交信息——内网实测被拒过一次("does not match the
      // regular-expression"),而那时代码早已写完,重来一遍是纯浪费。
      // 规矩必须开场就给,每个会话都带:修复会话同样要提交。
      const convention = this.effectiveCommitConvention();
      if (!requirementAnalysis && convention) {
        prompt = `${prompt}\n\n提交信息规范(平台钩子会按它校验,不合规`
          + `直接拒收 push,请第一次就写对):${convention}`;
      }
      // 交付方式的预答契约要**开场就告诉模型**:预答机制只认"标准卡"
      // (选项原文里含有用户选的那一项)。不说这句,模型有它自己的好心
      // ——从需求原文猜到用户想局部修改,就自造一张"是否选择局部修改?"
      // 的是/否卡(内网实测),而是/否里没有选项原文,预答对不上号,
      // 卡真去等人:用户明明下单时答过,中途又被问一遍。宿主不替内核
      // 判卡(是/否算不算数是内核的事),但可以不让模型把卡出歪。
      // 配置事实(用户下单时已给):单号/基线分支/工号不再让模型开口
      // 问——配置确认"一次问一项事实"的前提是事实缺席,这些没缺。取值
      // 口径仍归内核(REQ→feat/DTS→fix 的推导、分支名派生都是它的判定,
      // 宿主只递事实);确认卡照出,用户最终把关的那一道不省。
      const facts: string[] = [];
      if (task.summary.ticket) facts.push(`单号:${task.summary.ticket}`);
      if (task.summary.baseline) {
        facts.push(`基线分支:${task.summary.baseline}`);
      }
      if (gitIdentity) {
        facts.push(`工号(git 用户名,已写进仓库配置):${gitIdentity.username}`);
      }
      if (!requirementAnalysis && this.options.host && facts.length) {
        prompt = `${prompt}\n\n配置事实(用户下单时已提供,配置确认直接`
          + `采用,不要再逐项询问):${facts.join(";")}。其余配置项照`
          + `内核口径取值或询问。`;
      }
      // 交付方式已由下单事实文件交给内核:内核 current 会自己下指令
      // (已选定则"直接 done --choice 不出卡";旧快照没这契约则照旧
      // 举卡)。prompt 只补一句立场,具体怎么走听内核的——两种内核
      // 版本都不矛盾。唯一要钉死的是不许自造"是/否"卡:选项原文对
      // 不上号,预答接不住,只能真去等人(内网实测)。
      if (!requirementAnalysis && this.options.host && task.summary.lane) {
        prompt = `${prompt}\n\n交付方式用户已在下单时选定:`
          + `${task.summary.lane}(已写入工作区下单事实,内核能读到)。`
          + `流程走到交付方式选择时**严格照内核指令执行**:内核说直接`
          + ` done --choice 就直接执行,内核要求出卡就**原样列出标准`
          + `选项**(系统会替用户选中含「${task.summary.lane}」的那一`
          + `项)。禁止自造"是/否"确认卡,禁止替用户改选。`;
      }
      // 仓库地图(加餐):大仓里模型乱 grep 烧轮次,开场先给一张按被
      // 引用程度排序的路标。只在内核模式生成(有真克隆才有仓可画);
      // 每次会话都重画——修复/重建会话面对的是改动后的工作区,旧图作废。
      // fail-open:空地图不上桌,带预算绝不拖住启动(不卡死红线)。
      if (!requirementAnalysis && this.options.host) {
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
        repositorySkillPaths,
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
          // 边界=整个任务工作区(修复材料在仓外的 ../pipeline、../reviews);
          // 相对路径仍按会话 cwd(代码仓)解析。
          workspace,
          cwd,
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

  /** external_verify 之后的异常不是“交付旁路失败也算完成”。内核正在
   * 明确等待宿主核销三项质量义务，任何缺口都只能留在 verifying。 */
  private holdExternalVerification(task: TaskState, reason: string): void {
    task.summary.status = "verifying";
    task.summary.detail = reason;
    task.summary.delivery = {
      ...task.summary.delivery,
      mr_state: task.summary.delivery?.mr_state ?? "验证中",
      waiting_on: reason,
    };
    this.persist(task);
  }

  /** 外部验证的自愈预算:第一次挂起时开表,之后每次续命都对表。
   *
   * 为什么要有:等待点上的每一次挂起都可能是暂时的(内网 push 504、
   * MR 网关抖、内核登记撞上并发),值得自己再试;但"再试"没有尽头就
   * 是死等——本仓的红线写死了凡等待必须带预算。预算沿用轮询那一档
   * (默认 30 分钟),不另立旋钮。 */
  private verificationDeadline(task: TaskState): number {
    const delivery = task.summary.delivery;
    const existing = delivery?.verify_deadline
      ? Date.parse(delivery.verify_deadline) : NaN;
    if (Number.isFinite(existing)) return existing;
    const knobs = this.options.settings?.runtime() ?? {};
    const budget = (knobs.poll_timeout_s !== undefined
      ? knobs.poll_timeout_s * 1000 : undefined)
      ?? this.options.delivery?.pollTimeoutMs ?? 30 * 60_000;
    const deadline = Date.now() + budget;
    task.summary.delivery = {
      ...delivery,
      verify_deadline: new Date(deadline).toISOString(),
    };
    return deadline;
  }

  /** 自愈到头了:如实停下、写清原因、喊人。任务留在 verifying(代码
   * 确实已提交,不能假装 failed 也不能假装完成),但从此 retry 放行、
   * 页面亮牌子——人办完外部的事点「重跑续推」,机器接着干。 */
  private markVerificationStalled(task: TaskState, reason: string): void {
    const delivery = task.summary.delivery;
    if (delivery?.stalled) return; // 幂等:同一次停摆只喊一次
    task.summary.status = "verifying";
    task.summary.detail = `自动验证已停,需要你介入:${reason}`;
    task.summary.delivery = {
      ...delivery,
      mr_state: delivery?.mr_state ?? "验证中",
      waiting_on: reason,
      stalled: reason,
      verify_deadline: undefined,
    };
    this.persist(task);
    this.notifyRepairStopped(task);
  }

  /** 挂起=先自愈再说:排一次带预算的重试;预算到了就停下喊人。
   * 停摆之后不再自动重排——人点了「重跑续推」才重新开表。 */
  private holdWithRecovery(
    task: TaskState,
    reason: string,
    epoch: number,
  ): void {
    if (task.summary.delivery?.stalled) {
      this.holdExternalVerification(task, reason);
      return;
    }
    const deadline = this.verificationDeadline(task);
    this.holdExternalVerification(task, reason);
    if (Date.now() >= deadline) {
      this.markVerificationStalled(task, reason);
      return;
    }
    this.scheduleDeliveryRecovery(task, epoch);
  }

  /** 交付侧的带预算重试(推送/MR/流水线触发失败走这条)。
   *
   * 对表由这条循环自己拿着,不能指望 tryDeliver:内核停在 end 时它
   * 的 catch 根本不挂起(那是 external_verify 才走的分支),于是只会
   * 试一次就散——测试逮住过。 */
  private scheduleDeliveryRecovery(task: TaskState, epoch: number): void {
    if (task.deliveryRecoveryActive) return;
    task.deliveryRecoveryActive = true;
    const knobs = this.options.settings?.runtime() ?? {};
    const delay = Math.max(50,
      (knobs.poll_interval_s !== undefined
        ? knobs.poll_interval_s * 1000 : undefined)
      ?? this.options.delivery?.pollIntervalMs ?? 10_000);
    const timer = setTimeout(() => {
      task.deliveryRecoveryActive = false;
      this.bypass(task, "交付自愈重试", this.runDeliveryRecovery(task, epoch));
    }, delay);
    timer.unref();
  }

  private async runDeliveryRecovery(
    task: TaskState,
    epoch: number,
  ): Promise<void> {
    if (!this.recoveryStillNeeded(task, epoch)) return;
    await this.tryDeliver(task, epoch);
    if (!this.recoveryStillNeeded(task, epoch)) return;
    if (Date.now() >= this.verificationDeadline(task)) {
      this.markVerificationStalled(task, this.stallReason(task));
      return;
    }
    this.scheduleDeliveryRecovery(task, epoch);
  }

  /** 停摆要说病因不是症状:"权威流水线尚未逐项通过"是症状,
   * "宿主推送失败: fatal: ..." 才是人能拿着去办的那句。交付成功时
   * delivery 会整份换掉,skipped 不会残留成假线索。 */
  private stallReason(task: TaskState): string {
    const delivery = task.summary.delivery;
    return delivery?.skipped ?? delivery?.waiting_on
      ?? task.summary.detail ?? "外部验证迟迟没有结果";
  }

  /** 还该不该我管:别人在盯的(流水线轮询、证据核销重试)让它盯,
   * 已经走出验证中或已如实停摆的收手——两条自愈链不许互相踩。 */
  private recoveryStillNeeded(task: TaskState, epoch: number): boolean {
    return this.current(task, epoch)
      && task.summary.status === "verifying"
      && !task.summary.delivery?.stalled
      && task.summary.delivery?.pipeline !== "running"
      && !task.evidenceRetryActive;
  }

  /** INCOMPLETE / STALE / 登记抖动都是宿主等待，不得把 Agent 催回来
   * “补证据”。同 SHA 只刷新平台事实并重做内核 record；仅 STALE（本地
   * HEAD 已变化）回 tryDeliver，让宿主推新 HEAD 并启动对应的新流水线。
   * timer unref，不吊住进程；重启由 recover 的 verifying+success 分支
   * 重新挂起。 */
  private schedulePipelineEvidenceRetry(
    task: TaskState,
    sha: string,
    epoch: number,
    stale: boolean,
  ): void {
    if (task.evidenceRetryActive) return;
    if (task.summary.delivery?.stalled) return;
    // 核销重试也吃同一份预算:平台把某个 job 报成 skipped/manual 时
    // 它永远不会变绿,原来会每 10 秒拉一个内核子进程一直转到天荒地老。
    if (Date.now() >= this.verificationDeadline(task)) {
      this.markVerificationStalled(task, this.stallReason(task));
      return;
    }
    task.evidenceRetryActive = true;
    const knobs = this.options.settings?.runtime() ?? {};
    const delay = Math.max(50,
      (knobs.poll_interval_s !== undefined
        ? knobs.poll_interval_s * 1000 : undefined)
      ?? this.options.delivery?.pollIntervalMs
      ?? 10_000);
    const timer = setTimeout(() => {
      task.evidenceRetryActive = false;
      if (!this.current(task, epoch)
          || task.summary.status !== "verifying"
          || task.summary.delivery?.sha !== sha
          || task.summary.delivery?.pipeline !== "success") return;
      this.bypass(task, "流水线证据自动重试", stale
        ? this.tryDeliver(task, epoch)
        : this.retryPipelineEvidence(task, sha, epoch));
    }, delay);
    timer.unref();
  }

  /** 同 SHA 只查已有 run 并重做 record，绝不 POST trigger。查询短暂失败
   * 时仍可用上次已落袋的整体状态重试登记。 */
  private async retryPipelineEvidence(
    task: TaskState,
    sha: string,
    epoch: number,
  ): Promise<void> {
    if (!this.current(task, epoch)
        || task.summary.status !== "verifying"
        || task.summary.delivery?.sha !== sha) return;
    let status: "success" | "failed" = "success";
    let checks = task.summary.delivery.checks;
    let log = "";
    try {
      const repo = encodeURIComponent(
        task.summary.repo_url ?? this.effectiveDefaultRepo() ?? "");
      const result = await fetch(
        `${this.effectivePlatformUrl()}/pipeline/status`
        + `?sha=${sha}&repo=${repo}`,
        { headers: this.platformIdentity(task) }).then((r) => readJson(r));
      if (!this.current(task, epoch)
          || task.summary.status !== "verifying") return;
      const terminal = (Array.isArray(result.runs) ? result.runs : [])
        .findLast((run: { status?: string }) =>
          run.status === "success" || run.status === "failed");
      if (terminal) {
        status = terminal.status === "failed" ? "failed" : "success";
        checks = parsePipelineChecks(terminal.checks);
        log = String(terminal.log ?? "");
        task.summary.delivery = {
          ...task.summary.delivery,
          pipeline: status,
          ...(checks !== undefined ? { checks } : {}),
        };
      }
    } catch (error) {
      this.options.log?.(
        `任务 ${task.summary.id} 流水线证据刷新失败(仍重试登记): ${String(error)}`);
    }
    await this.pipelineVerdict(task, sha, status, log, checks, epoch);
  }

  /** Git 交付(§10):任务收轮并释放 Agent 后,由宿主推送并反查远端
   * SHA，再建 MR——不信任务自己的说法，也不让 Agent 接触 token。
   * MR 成功≠完成:流水线过了才"等待合入",否则停在"验证中"。
   * 交付失败不吞:原因写进 summary.delivery,任务保持 completed。 */
  private async tryDeliver(task: TaskState, epoch: number): Promise<void> {
    // 多仓父任务只负责需求理解和人工检视，不产生分支/MR。
    if (this.isRequirementAnalysis(task)) return;
    // 平台地址由部署固定注入；每次交付动作使用同一条基础设施链路。
    const platformUrl = this.effectivePlatformUrl();
    if (!platformUrl || !this.options.host || !task.cwd) {
      if (this.atExternalVerificationWait(task)) {
        this.holdWithRecovery(
          task, "等待权威流水线：MR / 流水线服务未就绪", epoch);
      }
      return;
    }
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
        const reason = "配置未确认,无分支可交付";
        task.summary.delivery = { ...task.summary.delivery, skipped: reason };
        if (state.current === "external_verify") {
          // 这一条重试没有意义:配置不会自己长出来。直接如实停下喊人,
          // 别用预算空转半小时再说同一句话。
          this.markVerificationStalled(task, reason);
        }
        return;
      }
      const previous = task.summary.delivery;
      const pushReceipt = this.pushFromHost(task, branch);
      const sha = pushReceipt.sha;
      if (previous) previous.git_push = pushReceipt;
      else task.summary.delivery = { git_push: pushReceipt };
      // push 已经发生就先落账；即使随后 MR/流水线接口抖动，恢复时也能
      // 复核同一 SHA，不会把传输事实误当成 Agent 自述。
      this.persist(task);
      // 修复回程的岔路:SHA 没变说明本轮没有新代码(检视修复只回复
      // 不改码、或修复会话判断无需改动)。这时**绝不再触发流水线**
      // ——远端每跑一条流水线都是钱,同 SHA 重跑还是同一个结果。
      // 上一轮绿 → 直接回门禁监控;上一轮红 → 重新分类裁决
      // (检视清了之后可能轮到 CI 修,brake 按类各管各的)。
      if (previous?.sha === sha && previous.pipeline) {
        if (previous.pipeline === "success") {
          // 同 SHA 的总体绿灯只复用事实，不复用结论。进程可能上次死在
          // 内核登记前也可能进程退出；重新核销但绝不重跑同 SHA 流水线。
          task.summary.status = "verifying";
          await this.pipelineVerdict(task, sha, "success", "",
            previous.checks, epoch);
          return;
        }
        if (previous.pipeline.startsWith("failed")) {
          // 老路径里状态由触发块扳到 verifying,这条岔路必须自己扳——
          // 不扳的话 settle 会把还红着的任务误收成 completed(实测)。
          task.summary.status = "verifying";
          await this.pipelineVerdict(task, sha, "failed",
            previous.loop?.failure ?? "", previous.checks, epoch);
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
        title: `${state?.config?.["单号"] ?? branch}: ${
          task.summary.title ?? taskTitle(task.summary.requirement)}`,
        // E2E 单号关联(内网诉求 2026-08-19):单号只拼进 title 平台看
        // 不见,要走 codehub-cli 的 --e2e-issues 才可追踪。取值优先
        // **用户下单填的需求号**(用户拍板"直接关联开始填入的那个"),
        // 回落内核配置确认的定稿(老单/无表单形态);REQ/DTS 都走这个
        // 参数,平台不区分类型(toolkit 源码里两类混传)。字段名跟
        // 内网 adapter.json 已定的 {dts_no} 占位符,不折腾他们返工。
        dts_no: task.summary.ticket
          ?? String(state?.config?.["单号"] ?? ""),
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
      if (!["success", "failed", "running"].includes(String(run.status))) {
        throw new Error(`流水线返回未知状态: ${String(run.status ?? "(empty)")}`);
      }
      const checks = parsePipelineChecks(run.checks);
      ledger({ idemKey: runKey, kind: "pipeline_trigger",
               request: runRequest, sha, startedAt: runStarted, result: run,
               finishedAt: new Date().toISOString() });
      task.summary.delivery = {
        ...(task.summary.delivery?.loop
          ? { loop: task.summary.delivery.loop } : {}),
        git_push: pushReceipt,
        mr_url: mr.url,
        // 平台给了 MR 标识就记下:门禁/讨论查询要带回去(假件给 id,
        // codehubcli 给 iid;没有也不碍事,适配层还能按分支对查)。
        ...(mr.id !== undefined ? { mr_id: mr.id } : {}),
        source_branch: branch,
        target_branch: baseline,
        mr_state: "验证中",
        pipeline: run.status,
        ...(checks !== undefined ? { checks } : {}),
        sha,
      };
      task.summary.status = "verifying";
      // 终态当场裁决;running 不是结局,由带预算的轮询收敛后再裁。
      if (run.status === "running") {
        this.bypass(task, "流水线轮询", this.pollPipeline(task, epoch));
      } else {
        await this.pipelineVerdict(task, sha,
          run.status === "success" ? "success" : "failed",
          String(run.log ?? ""), checks, epoch);
      }
    } catch (error) {
      if (!this.current(task, epoch)) return;
      const reason = `交付动作失败: ${String(error)}`;
      task.summary.delivery = { ...task.summary.delivery, skipped: reason };
      if (this.atExternalVerificationWait(task)) {
        // push 504 / MR 网关 500 这类多半是一阵子的事,自己再试几轮;
        // 预算用完就停下说人话,而不是永远停在"验证中"没人管
        // (实测过:那种状态既没定时器、重启也不复活、连重跑都被拒)。
        this.holdWithRecovery(task, `等待权威流水线：${reason}`, epoch);
      }
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
      const checks = parsePipelineChecks(terminal.checks);
      task.summary.delivery = {
        ...task.summary.delivery,
        pipeline: terminal.status,
        mr_state: "验证中",
        ...(checks !== undefined ? { checks } : {}),
      };
      task.summary.status = "verifying";
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
        String(terminal.log ?? ""), checks, epoch);
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
   *   绿 → 内核按 execution_contract 核销 COMPILE/UT/CODECHECK，只有
   *       PASS 才 loop.state=green + await_merge；typed checks 是可选的
   *       诊断增强，明确 pending/failed/过期仍 verifying/RED;
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
    checks: PipelineCheck[] | undefined,
    epoch: number,
  ): Promise<void> {
    if (!this.current(task, epoch)) return;
    const delivery = task.summary.delivery;
    if (!delivery) return;
    if (status === "success") {
      // 平台总体 success 绑定精确 SHA，且 execution_contract 已声明该
      // 权威流水线覆盖三项时可以聚合核销。typed checks 若存在则提供更
      // 精确裁决；登记失败、pending、STALE 仍一律不放行。
      const attestation = await this.recordPipelineEvidence(
        task, sha, status, checks);
      if (!this.current(task, epoch)) return;
      if (attestation?.verdict === "RED") {
        // overall 与逐项结果矛盾时，裁决权仍在内核。typed RED 进入与
        // 常规红灯完全相同的轻量修复环，不挂一张人工 Diff 卡。
        delivery.pipeline = "failed(逐项质量结果未通过)";
        await this.handlePipelineRed(
          task, sha, attestation.reason ?? log, epoch);
        return;
      }
      if (attestation?.verdict !== "PASS") {
        const verdict = attestation?.verdict;
        const reason = attestation?.reason
          ?? (checks === undefined
            ? "内核未完成整体流水线核销；逐项 Job 未配置，仅影响诊断"
            : "内核未能登记流水线逐项结果");
        const waiting = verdict
          ? `等待流水线证据核销：${verdict} · ${reason}`
          : `等待流水线证据核销：${reason}`;
        task.summary.status = "verifying";
        delivery.mr_state = "验证中";
        delivery.waiting_on = waiting;
        task.summary.detail = waiting;
        this.persist(task);
        this.schedulePipelineEvidenceRetry(
          task, sha, epoch, verdict === "STALE");
        return;
      }
      const terminal = this.completionAttestation(task);
      if (terminal && !terminal.complete) {
        // `pipeline record` 的返回值不能单独成为 Cloud 终态。必须重新读
        // 内核落盘现场，确认 command 已把 external_verify 推到 flow 的
        // terminal，且 PASS 仍绑定当前 HEAD；这样 hook/保存/推进任一
        // 处失败都不会从返回字符串的空窗里漏进 await_merge。
        this.holdExternalVerification(
          task, `等待内核终态对账：${terminal.reason}`);
        this.schedulePipelineEvidenceRetry(task, sha, epoch, false);
        return;
      }
      if (delivery.loop) delivery.loop.state = "green";
      delivery.mr_state = "等待合入";
      delivery.waiting_on = undefined;
      task.summary.status = "await_merge";
      task.summary.detail = "编译、UT 运行与 CodeCheck 均已由权威流水线核销";
      this.persist(task);
      // 流水线绿≠赢了:九项门禁全过 + 合入才是终点(内网既有框架的
      // 实证)。支持门禁契约的平台接着盯;不支持的(fetchGates 回
      // undefined)保持旧语义——await_merge 即收口,一字不变。
      this.bypass(task, "合入监控", this.watchMerge(task, epoch));
      return;
    }
    // 红灯也过证据口：先留绑定 SHA 的逐项物证，再进同一轻量修复环。
    await this.recordPipelineEvidence(task, sha, status, checks);
    if (!this.current(task, epoch)) return;
    await this.handlePipelineRed(task, sha, log, epoch);
  }

  /** 内核裁成 RED 后的唯一处理器。来源可以是总体 failed，也可以是
   * “总体 success、某个 typed check failed”的矛盾平台响应；两者都只
   * 派轻量修复会话，不回人工 Diff、不重放内核完整质量链。 */
  private async handlePipelineRed(
    task: TaskState,
    sha: string,
    log: string,
    epoch: number,
  ): Promise<void> {
    if (!this.current(task, epoch)) return;
    const delivery = task.summary.delivery;
    if (!delivery) return;
    task.summary.status = "verifying";
    delivery.mr_state = "验证中";
    delivery.waiting_on = undefined;
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
        if (this.dispatchConflictRepair(task, sha, max, epoch)) return;
        continue;
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
    // 输入可信度:log 是纯链接或干脆缺席、又没有镜像材料时,修复会话
    // 手里没有任何失败证据。内网实锤:适配层把 log 填成流水线页面链接
    // (会话没有登录态,打不开),使命却把它包装成"失败详情(平台原文)"
    // ——会话以为自己有输入,硬着头皮定位→修改→提交,看着专业实为
    // 猜改,烧流水线还烧不出结论。证据缺席必须明说,行为才会从"猜改
    // 凑提交"变成"能自证的修、不能自证的走诊断出口停下喊人"。
    // 判据不能只认裸链接:内网真实形态是"标签 + 链接"
    // (`FAILED stage=CodeCCP2.0 job=CodeCCP2.0  detail: https://…`),
    // 只认裸链接的第一版正好漏掉了它要防的那个场景(2026-08-21 读进场
    // 报告逮住)。改判"把链接抠掉之后还剩多少诊断内容":剩下的只有
    // stage/job 标签 = 链接在替内容站岗。没有链接则不论长短都是平台
    // 给的真内容(如 "BUILD FAILURE: 模块 x 编译失败"),不算无证据。
    const withoutLinks = loop.failure.replace(/https?:\/\/\S+/g, "").trim();
    const blindInput = !artifacts.length
      && (loop.failure === "(平台未提供失败详情)"
        || (withoutLinks.length < loop.failure.trim().length
          && withoutLinks.length < 120));
    const roundText = loop.max !== undefined
      ? `第 ${loop.round}/${loop.max} 轮` : `第 ${loop.round} 轮`;
    delivery.pipeline = `failed(${roundText}修复中)`;
    // 逐项事实单独进使命(2026-08-21 内网数据逼出来的):平台的 log 详细
    // 程度按维度不均——CODECHECK 给到了文件行号规则,COMPILE 只有一句
    // "构建失败=1"。只喂 log,模型会照着详细那一维修完就交,另一维照旧
    // 红,又是白烧一轮。checks 是结构化的平台事实,把失败维度点名列出,
    // 模型才知道本轮的完整战场;某一维没有细节就明说去要,别默默漏掉。
    const failedDimensions = (delivery.checks ?? [])
      .filter((check) => check.status === "failed")
      .map((check) => check.dimension + (check.job ? `(${check.job})` : ""));
    task.mission = [
      `流水线红了,把它修到绿是你此刻唯一的使命(${roundText}修复):`,
      ...(failedDimensions.length ? [
        `- 本轮失败的维度(平台逐项事实,权威):`
        + `${failedDimensions.join("、")}。**每一维都要收拾**,`
        + `不要只修下面日志里讲得细的那一维就交差——日志的详细程度`
        + `按维度不均,讲得少不等于没红。某一维在日志和 ../pipeline/ 里`
        + `都找不到细节时,不许猜改,把"缺哪一维的失败原文"写进收口发言。`,
      ] : []),
      ...(blindInput ? [
        `- 分支上提交 ${sha} 的权威流水线结果是 failed,**但平台没有给出`
        + `失败日志原文**(只给了: ${loop.failure})。你手里没有可信的`
        + `失败证据,本轮第一要务是取证,不是动手改。`,
        `- 证据纪律:只修你能在工作区自证的问题(通读代码找得到、`
        + `lightcheck 报得出的,并写明依据);自证不了的不许猜改碰运气`
        + `——把"平台未提供失败日志,适配层需补 log 原文与`
        + ` pipeline_artifacts 端点"写成诊断,不提交,系统会带着你的`
        + `诊断如实停下请人工,这比猜改一轮更有价值。`,
      ] : [
        `- 分支上提交 ${sha} 的权威流水线结果是 failed。失败详情(平台原文):`,
        loop.failure,
      ]),
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
      // 内核在 external_verify 不签发质量任务卡(EXPECTED_STEPS 里
      // COMPILE/UT/CODECHECK 只挂在各自的验证步)。原文让它"派专职子
      // agent",模型照做就撞三连死路:拿旧卡被拦 → 按提示 agent-task ut
      // 被"当前步骤不允许生成"打回 → current 说在等流水线,来回空转。
      // 交付后的流水线修复轮里,改代码这件事由本会话自己做。
      `- 按类分头修:编译类、UT/覆盖率类、检视类各修各的,互不搅和。`
      + `**本轮不要派 COMPILE/UT/CODECHECK 专职子 agent**——那些任务卡`
      + `只在对应的验证步签发,交付后的流水线修复轮拿不到卡,派了必被`
      + `内核拦回,白烧回合。补测试、改代码都由你自己动手(UT 的写法`
      + `照常按已装载的 UT skill 走);确需并行时只派不带任务卡的通用`
      + `子 agent,并把定位到的文件与依据一并交给它,别让它从头再查。`,
      `- 修复纪律:补覆盖率要写真测试,不许凑数骗指标;CodeCheck 修问题`
      + `本身,不许加抑制注释糊弄;编译告警要消除,不是关闭告警。`,
      `- 全部修完凑成一次提交。不要读取或索要个人 Git 令牌，`
      + `也不要 push；会话释放后 Cloud 宿主会统一推送并复核远端 SHA。`
      + `别的都不要动,顺手的重构、无关的优化一律不做。`,
      `- 诊断出口:凡不是本仓代码能修的(外部平台的配置、权限、环境、`
      + `流水线自身的问题),那一类不要硬改碰运气;若所有问题都不可修,`
      + `不要提交,把诊断写清楚:缺什么、要去哪配、配好之后如何重跑`
      + `——没有新提交时系统会带着你的诊断如实停下请人工,`
      + `这是正确结局之一,不是失败。`,
      // 插话纪律(内网实锤):一轮修复被"补文档章节"的插话整轮占满,
      // 没碰流水线也没提交,刹车把它的文档汇报当成了诊断——人看着
      // "自动修复已停"配一段章节标题,完全接不上。插话照办是对的
      // (人的话优先),但收口不回到使命就是把本轮白丢。
      `- 插话纪律:会话中途收到的插话(人的补充要求、[mae-flow] 的`
      + `纠偏提示)照办,但办完必须回到本使命;收口发言必须以流水线`
      + `失败的定位结论收尾——本轮确实没碰流水线,就明说"本轮未处理`
      + `流水线"及原因,不许拿无关的汇报顶替诊断。`,
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
      const attestation = this.completionAttestation(task);
      if (attestation && !attestation.complete) {
        // 远端 MR 状态不能反向篡改内核流程真相。即使有人在平台上手工
        // 合入，也只有内核 terminal + 当前 HEAD 的逐项 PASS 才能解锁
        // 下游；恢复会再次对账并把该任务续到正确锚点。
        delivery.mr_state = "已合入（内核终态待对账）";
        delivery.waiting_on = attestation.reason;
        task.summary.status = "verifying";
        task.summary.detail = `MR 已合入，但不能标记完成：${attestation.reason}`;
        this.persist(task);
        return;
      }
      if (delivery.loop) delivery.loop.state = "green";
      delivery.mr_state = "已合入";
      delivery.waiting_on = undefined;
      task.summary.status = "completed";
      task.summary.detail = "MR 已合入,交付完成";
      this.persist(task);
      this.bypass(undefined, "依赖任务解锁", this.pump());
      const account = task.summary.luban_account;
      if (this.options.notifier && account) {
        this.bypass(task, "收口通知", this.options.notifier.notifyOutcome({
          taskId: task.summary.id,
          account,
          status: "merged",
          summary: `MR 已合入`
            + (delivery.mr_url ? `:${delivery.mr_url}` : ""),
          link: personalTaskLink(
            this.notificationLinkBase(), account, task.summary.id),
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
              if (this.dispatchConflictRepair(task, sha, max, epoch)) return;
              continue;
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
                this.notificationLinkBase(), account, task.summary.id),
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

  /** 检视意见修复轮在飞时,本轮该用的交付方式(内核选项原文)。
   *
   * 为什么要开新单而不是在旧单上改(2026-08-20 查实):内核的 end =
   * "推送 + 流水线绿",而云端的交付完成 = 合入。中间等合入这段冒出来
   * 的检视意见,原来是往**终态**工作区塞个 mission 重新入队——`current`
   * 还停在 end,Hook 门禁整体旁路,修复会话全程裸奔。
   *
   * 内核对这段早有designed的路,而且是机读契约:workflow_select 的
   * choices 里有 review,但 new_order_choices 没有它(「review 仅限
   * 已交付单」)。走这条路修复要重新过 rf_codecheck/rf_ut/delivery_review,
   * push 之后还自动进 external_verify 复验——修复本身也要流水线判绿
   * 才算数。
   *
   * 只认 state="repairing":轮次判绿或刹车后就该恢复本单原交付方式,
   * 否则下次重建会话会莫名其妙又开一张 review 单。 */
  private reviewRoundLane(task: TaskState): string {
    const loop = task.summary.delivery?.loop;
    if (loop?.kind !== "review" || loop.state !== "repairing") return "";
    return workflowLabel(this.options.host?.kernelRoot, "review");
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
        `- **第一件事:执行 init --new 开这一轮的单**。上一单已交付到`
        + `终态,内核会把它归一化成"终态换轮"并自动归档,不需要`
        + `exit/goto/skip。交付方式已由下单事实给定(处理评审意见),`
        + `选卡会自动通过;分支不会新建,内核按本单单号派生的就是当前`
        + `这个 MR 分支。开单之后一律按 current 的本步指引走到 end,`
        + `不要跳步、不要自己拼流程。`,
        `- 为什么必须开单:不开单的话流程停在 end,门禁全部旁路——`
        + `你这一轮的改动没人裁决、没人记账,改完也不会被流水线复验。`,
        `- 原始数据在 ../reviews/discussions.json(仓库外),需要完整`
        + `上下文时自己读。`,
        `- 意见对的就改代码,意见基于误解的不改——但必须说清依据,`
        + `不许含糊带过;不确定的按意见改(检视人对本仓比你熟)。`,
        `- 把逐条回复写到 ../review_replies.md(仓库外,不会进提交),`
        + `格式严格如下,每条以方括号 id 单独一行开头:`,
        `  [${discussions[0].id}]`,
        `  <这条的回复:改了什么/为什么不改,一两句讲清>`,
        `- 提交按内核 build_commit 步的指引做,不要自己另起一套；`
        + `不要读取或索要个人 Git 令牌,也不要 push,`
        + `Cloud 宿主会在会话释放后统一推送。`,
        `- 全部是解释、没有代码改动也是正常结局:照样按 current 走完,`
        + `在对应步骤如实说明本轮无代码改动,不要为了凑步骤改代码。`,
        `- 系统会把你的回复发布到对应讨论(是否代点"已解决"由部署配置`
        + `决定,默认留给检视人点),回复写给检视人看,说人话,`
        + `别写流程黑话。`,
      ].join("\n"),
      `检视意见 ${discussions.length} 条,专职会话处理中`);
    return "dispatched";
  }

  /** 冲突修复派单(批4):宿主先 merge 目标分支**故意把冲突标记留在
   * 工作区**,让 agent 在真实冲突上下文里解,而不是凭描述想象
   * (内网框架里最值得抄的一条)。merge 干净=没有真冲突,交回统一的
   * host push 链，不烧会话。刹车=同 SHA 不二修。 */
  private dispatchConflictRepair(
    task: TaskState,
    sha: string,
    max: number | undefined,
    epoch: number,
  ): boolean {
    if (!this.current(task, epoch)) return true;
    const delivery = task.summary.delivery!;
    const target = delivery.target_branch;
    if (!task.cwd || !target) return true;
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
      return true;
    }
    const git = (...args: string[]) => spawnSync(
      "git", args, { cwd: task.cwd, encoding: "utf-8" });
    const fetched = git("fetch", "origin", target);
    if (fetched.status !== 0) {
      task.summary.detail =
        `冲突修复准备失败(fetch ${target}):${(fetched.stderr || "").slice(0, 300)}`;
      this.persist(task);
      return true; // 环境问题不硬闯,留痕等人(或下一轮监控重试)
    }
    const beforeMerge = (git("rev-parse", "HEAD").stdout || "").trim();
    const merged = git("merge", "--no-edit", `origin/${target}`);
    if (merged.status === 0) {
      const afterMerge = (git("rev-parse", "HEAD").stdout || "").trim();
      if (beforeMerge && afterMerge === beforeMerge) {
        // 新提交已经包含目标分支，但平台的 conflict gate 可能还没刷新。
        // 这不是“修复会话没有提交”：不写 last_sha、不退出监控，让
        // watchMerge 按原轮询节奏继续看门禁/MR。旧实现会把当前 SHA
        // 记成已修，再下一拍误命中同 SHA 刹车，导致合入后无人收口。
        task.summary.detail = "本地已无冲突，等待平台刷新冲突门禁";
        this.persist(task);
        return false;
      }
      // 干净合并:没有真冲突(门禁可能滞后)。统一交给 tryDeliver 的
      // host-only 推送与远端 SHA 复核，避免这里另开一条无收据的旁路。
      loop.kind = "conflict";
      loop.last_sha = sha;
      task.summary.detail = "与目标分支干净合并,等待宿主推送并触发新流水线";
      this.persist(task);
      setImmediate(() => void this.tryDeliver(task, epoch));
      return true;
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
      return true;
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
        + `(用默认合并信息即可)。不要读取或索要个人 Git 令牌，也不要`
        + ` push；Cloud 宿主会在会话释放后统一推送。`,
        `- 不要 rebase、不要 force push、不要动无关文件。`,
      ].join("\n"),
      `与 ${target} 冲突(${conflicted.length} 个文件),专职会话解决中`);
    return true;
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

  /** 流水线证据口:终态时把平台事实(sha/status/可选 checks/来源)写成文件喂给
   * 内核仓的 `pipeline record`,内核绑工作区当前 HEAD 裁决并把结论写
   * 进 .mae-flow.json 的 quality.external_verification——判定一行不在
   * 本仓(红线:内核唯一权威;宿主只递事实)。delivery.attested 是那份
   * 现场记录的镜像戳。30s 预算；登记失败返回 undefined，总体绿灯
   * 必须 fail-closed 留在 verifying，红灯仍可进入轻量修复环。 */
  private async recordPipelineEvidence(
    task: TaskState,
    sha: string,
    status: "success" | "failed",
    checks: PipelineCheck[] | undefined,
  ): Promise<PipelineAttestation | undefined> {
    const kernelRoot = this.options.host?.kernelRoot;
    const delivery = task.summary.delivery;
    if (!kernelRoot || !task.cwd || !delivery) return undefined;
    const factsPath = join(task.summary.workspace, "pipeline-facts.json");
    try {
      writeFileSync(factsPath, JSON.stringify({
        sha,
        status,
        ...(checks !== undefined ? { checks } : {}),
        ...(delivery.git_push ? { git_push: delivery.git_push } : {}),
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
      let record: Record<string, unknown> | undefined;
      try {
        record = JSON.parse(lastLine);
      } catch {
        record = undefined;
      }
      if (result.code === 0 && typeof record?.verdict === "string") {
        delivery.attested =
          `${record.verdict}@${String(record.sha ?? sha).slice(0, 12)}`;
        return {
          verdict: record.verdict,
          sha: typeof record.sha === "string" ? record.sha : sha,
          reason: typeof record.reason === "string" ? record.reason : undefined,
          checks: record.checks && typeof record.checks === "object"
            ? record.checks as Record<string, unknown> : undefined,
        };
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
    return undefined;
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
    // 分析单已确认拆单完毕,父会话再举的任何卡都不该到人(内网实锤:
    // task-5 确认后模型"好心"又举卡让人检视 task-6 的事——子任务有
    // 自己的检视闸,父单的活到确认就结束了)。整卡代答,催它收尾。
    const graph = task.summary.requirement_graph;
    if (this.isRequirementAnalysis(task) && graph?.stage === "confirmed"
        && graph.repositories.every((repository) => repository.task_id)) {
      const answers: Record<string, string> = {};
      for (const item of questions) {
        answers[String(item.question ?? "")] =
          "跨仓方案已确认,各仓交付任务已由平台生成并自动调度,不归本"
          + "会话跟进。分析工作到此为止:请立即收尾结束,不要再提问。";
      }
      return {
        why: "分析单已确认拆单,父会话不再举卡",
        answers,
        notes: "系统自动交卷(分析已确认,子任务各有检视闸),非人工答复",
      };
    }
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
        // 答不上,整卡留给人。但有一种"答不上"必须留明账:问题**正文**
        // 里带着用户选的交付方式,选项里却没有——十有八九是模型自造了
        // "是否选择局部修改?"式的是/否卡(内网实测)。宿主不替内核判
        // 是/否算不算数,但要把"预答为什么没接住"写清楚,不然现场只看到
        // "又在等人",查不到为什么。
        if (lane && text.includes(lane)) {
          this.options.log?.(
            `任务 ${task.summary.id} 交付方式卡不是标准形状:问题提到`
            + `「${lane}」但选项(${(item.options ?? []).join("/")})里没有`
            + `它,预答无法命中,退回等人——多半是模型自造了是/否确认卡`);
        }
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
          this.notificationLinkBase(),
          account,
          task.summary.id,
        ),
      })
      .then((record) => {
        task.notifyRecord = record;
      }));
  }

  /** Host Git 动作使用的短生命周期 helper。目录/脚本仅活在一次
   * clone 或 push 的同步调用窗口，绝不进入 agentDir，也不写进仓库
   * config；调用方必须 finally cleanupHostGitCredential。 */
  private prepareHostGitCredential(
    credential: { username: string; password: string },
  ): { dir: string; helper: string } {
    // 系统临时目录避免 helper 路径中出现工作区空格，也让凭据天然位于
    // Agent 工作区之外。
    const dir = mkdtempSync(join(tmpdir(), "mae-flow-git-"));
    chmodSync(dir, 0o700);
    const file = join(dir, "credential");
    writeFileSync(file,
      `username=${credential.username}\npassword=${credential.password}\n`);
    chmodSync(file, 0o600);
    const script = join(dir, "helper.sh");
    writeFileSync(script, [
      "#!/bin/sh",
      'if [ "$1" = "get" ]; then',
      '  cat "$(dirname "$0")/credential"',
      "fi",
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(script, 0o700);
    return { dir, helper: script };
  }

  private cleanupHostGitCredential(
    prepared: { dir: string; helper: string } | undefined,
  ): void {
    if (!prepared) return;
    try {
      rmSync(prepared.dir, { recursive: true, force: true });
    } catch (error) {
      this.options.log?.(
        `临时 Git 凭据目录清理失败 ${prepared.dir}: ${String(error)}`);
    }
  }

  /** 新任务和旧任务恢复都执行：清掉历史版本留在 agentDir / repo config
   * 的 helper，并把 origin pushurl 改成必失败地址。Agent 可以读写/提交，
   * 但拿不到凭据也无法传输；宿主 push 使用显式干净 URL，不走 pushurl。 */
  private hardenAgentGitBoundary(agentDir: string, cwd?: string): void {
    for (const name of ["git-credential", "git-credential.sh"]) {
      rmSync(join(agentDir, name), { force: true });
    }
    if (!cwd || !existsSync(join(cwd, ".git"))) return;
    spawnSync("git", ["config", "--local", "--unset-all", "credential.helper"],
      { cwd, encoding: "utf-8" });
    // clone 会照录带 userinfo 的 URL；即便部署误把 token 写进 repo_url，
    // 也必须在 Agent 进入前从 repo config 擦掉。
    const origin = spawnSync("git", ["remote", "get-url", "origin"],
      { cwd, encoding: "utf-8" });
    const rawOrigin = String(origin.stdout ?? "").trim();
    if (origin.status === 0 && rawOrigin) {
      const cleanOrigin = this.cleanRemoteUrl(rawOrigin);
      if (cleanOrigin !== rawOrigin) {
        spawnSync("git", ["remote", "set-url", "origin", cleanOrigin],
          { cwd, encoding: "utf-8" });
      }
    }
    const existingPush = spawnSync(
      "git", ["config", "--local", "--get-all", "remote.origin.pushurl"],
      { cwd, encoding: "utf-8" });
    // 跨仓分析克隆已有更强的只读标记；不能用“宿主可推”的普通执行
    // 标记覆盖它。两者都指向 /dev/null，但语义必须保留下来供恢复和
    // 部署自检区分。
    if (!String(existingPush.stdout ?? "").includes("mae-flow-readonly")) {
      spawnSync("git", ["config", "--local", "remote.origin.pushurl",
        "/dev/null/mae-flow-host-owned"], { cwd, encoding: "utf-8" });
    }
  }

  private cleanRemoteUrl(raw: string): string {
    try {
      const parsed = new URL(raw);
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    } catch {
      return raw;
    }
  }

  /** Agent 会话已释放后由宿主完成唯一一次传输，并立刻从远端反查 SHA。
   * 返回值既是 TaskSummary 现场，也是 `pipeline record` 的内核收据。 */
  private pushFromHost(task: TaskState, branch: string): GitPushReceipt {
    if (task.driver) {
      throw new Error("安全拒绝：Agent 会话仍在，不能执行宿主 Git 推送");
    }
    if (!task.cwd) throw new Error("任务没有代码工作区，不能推送");
    const checked = spawnSync(
      "git", ["check-ref-format", "--branch", branch],
      { cwd: task.cwd, encoding: "utf-8" });
    if (checked.status !== 0) {
      throw new Error(`分支名不合法，拒绝推送: ${branch}`);
    }
    const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"],
      { cwd: task.cwd, encoding: "utf-8" });
    const sha = String(head.stdout ?? "").trim();
    if (head.status !== 0 || !sha) {
      throw new Error(`读取待推送 HEAD 失败: ${String(head.stderr ?? "")}`);
    }
    const remoteResult = spawnSync("git", ["remote", "get-url", "origin"],
      { cwd: task.cwd, encoding: "utf-8" });
    const remoteUrl = String(remoteResult.stdout ?? "").trim();
    if (remoteResult.status !== 0 || !remoteUrl) {
      throw new Error(`读取 origin 地址失败: ${String(remoteResult.stderr ?? "")}`);
    }
    const credential = this.options.gitCredential?.(
      task.summary.luban_account);
    const prepared = credential
      ? this.prepareHostGitCredential(credential)
      : undefined;
    const authArgs = prepared
      ? ["-c", "credential.helper=", "-c",
         `credential.helper=${prepared.helper}`]
      : [];
    const ref = `refs/heads/${branch}`;
    try {
      const pushed = spawnSync("git", [
        ...authArgs, "push", "--porcelain", remoteUrl, `HEAD:${ref}`,
      ], {
        cwd: task.cwd,
        encoding: "utf-8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      if (pushed.status !== 0) {
        const stderrText = String(pushed.stderr ?? pushed.stdout);
        // 老单的 origin 若是 SSH 地址,报错原文是一句和凭据链对不上的
        // "publickey"——把因果说全,省得排障从零猜起(内网实锤:查了
        // 半天才发现是下单时填了 SSH 地址)。新单已在下单口拒收 SSH。
        const sshHint = /publickey/i.test(stderrText)
            && !/^https?:\/\//i.test(remoteUrl)
          ? "(origin 是 SSH 地址,而宿主凭据是 HTTPS 个人令牌——在任务"
            + "工作区把 origin 改成 HTTPS 地址后重跑;新单请直接填 HTTPS)"
          : "";
        throw new Error(`宿主推送失败: ${stderrText}${sshHint}`);
      }
      const verified = spawnSync("git", [
        ...authArgs, "ls-remote", "--heads", remoteUrl, ref,
      ], {
        cwd: task.cwd,
        encoding: "utf-8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      const remoteSha = String(verified.stdout ?? "").trim().split(/\s+/)[0];
      if (verified.status !== 0 || remoteSha !== sha) {
        throw new Error(
          `远端 SHA 复核失败: 本地 ${sha.slice(0, 12)}，远端 `
          + `${remoteSha ? remoteSha.slice(0, 12) : "缺失"}`);
      }
      return {
        sha, ref, remote: "origin", url: this.cleanRemoteUrl(remoteUrl),
      };
    } finally {
      this.cleanupHostGitCredential(prepared);
    }
  }

  private requirementAnalysisPrompt(task: TaskState, cwd: string): string {
    const ticket = task.summary.ticket ?? task.summary.id;
    const repositories = (task.summary.repositories ?? []).map((url, index) => {
      const path = join(cwd,
        `${index + 1}-${basename(url).replace(/\.git$/, "") || "repo"}`);
      return `- repo-${index + 1} | ${url} | ${path}`;
    }).join("\n");
    const artifactDir = join(cwd, ".mae-flow-work", ticket);
    return [
      `需求原文:\n${task.summary.requirement}`,
      // 措辞纠偏:这是**平台的**跨仓分析前置阶段,不是内核流程——
      // 内核的交付流程(init/配置确认/门禁/MR)在确认后的各仓子任务里
      // 才开始,别让模型以为此刻该跑 mae-flow 命令。
      `你正在执行云端平台的跨仓需求分析(交付前置阶段):把一个需求在`
        + `${task.summary.repositories?.length ?? 0} 个仓库间的职责与依赖`
        + `理清楚,供人检视。注意:此阶段**不在 Mae-Flow 内核流程里**,`
        + `不要执行任何 mae-flow 命令;各仓的正式交付流程会在方案确认后`
        + `的独立任务中由内核主导。此阶段只读分析,禁止修改业务代码、`
        + `提交或启动交付;工作区已在 git 配置层禁用推送,push 必然失败。`,
      `仓库清单（ID | 原始地址 | 本地只读分析路径）:\n${repositories}`,
      "请亲自阅读各仓代码，从关键词、接口调用链、配置路由三条路径核查。"
        + "每个触点必须给出仓库、文件、符号、相关原因和置信度；"
        + "拿不准的事项使用 AskUserQuestion 逐题询问，不能猜。"
        + "逐题确认仓库职责、接口形态/字段/错误语义，以及依赖方向和可并行范围。",
      "只有全部不确定事项都已经逐题确认后，才能生成以下两份最终产物。",
      `把供人检视的完整方案写到 ${join(artifactDir, `CHAIN-${ticket}.md`)}。`
        + "正文必须包含需求理解、仓库职责、带证据触点、接口契约、"
        + "依赖关系与交付顺序、逐仓启动说明。依赖图使用 Mermaid。",
      `同时把机器可读投影写到 ${join(artifactDir, "requirement-graph.json")}，`
        + "格式严格为 "
        + `{"repositories":[{"id":"repo-1","name":"名称","url":"原始地址",`
        + `"responsibility":"职责"}],"dependencies":[{`
        + `"dependent":"repo-2","prerequisite":"repo-1",`
        + `"reason":"为什么 dependent 必须等待 prerequisite"}]}。`
        + "repositories 必须覆盖上方全部仓库且 url 原样照录；"
        + "dependencies 的语义必须是 dependent 依赖 prerequisite，"
        + "也就是 prerequisite 先开发、dependent 后开发；"
        + "只有确实不能并行的硬依赖才写，禁止循环依赖。",
      "方案写完后必须调用 AskUserQuestion，请用户选择「需要修改」或"
        + "「确认并生成任务」。用户选择需要修改时，结合随决定提交的批注"
        + "继续修订同一份方案，再次发起检视；确认前不得收尾。"
        + "用户确认后：各仓交付任务由平台自动生成与调度，**不归你跟进**"
        + "——写一段简短收尾说明后立即结束，禁止再调用 AskUserQuestion、"
        + "禁止替用户检视或跟进任何子任务。",
    ].join("\n\n");
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
    /** 下单时明确的代码基线。新克隆必须直接检出它，不能先落到远端
     * 默认分支再让后续流程纠正：仓内 Skill 会在内核 bootstrap 前
     * 物化，错一拍就会把“已选择”变成 digest 不符而静默跳过。 */
    baseline?: string,
    targetName?: string,
    /** 只读分析现场(多仓需求理解):克隆后在 git 配置层禁用推送。
     * 分析会话没有内核 preTool 门禁兜底,"禁止推送"不能只靠 prompt
     * 嘱咐——pushurl 指向不存在的路径 + 不登记 credential helper,
     * 模型真去 push 只会得到一个诚实的失败。 */
    readonly = false,
  ): string {
    // 任务级仓(正式下单)> 部署 --repo(仅单仓试跑);都没有就如实失败，
    // 不猜一个仓出来。任务仓记在 summary，重启续跑仍使用同一地址。
    const source = repoUrl ?? this.effectiveDefaultRepo();
    if (!source) {
      throw new Error(
        "这单没有代码仓：请在发起任务时填写「交付代码仓」");
    }
    const checkoutBaseline = baseline?.trim() || undefined;
    if (checkoutBaseline && (checkoutBaseline.length > 255
        || checkoutBaseline.startsWith("-")
        || /[\0\r\n\s\\]/.test(checkoutBaseline))) {
      throw new Error(`基线分支格式不合法，无法克隆：${checkoutBaseline}`);
    }
    // 裸仓 origin.git → 工作区目录名去掉 .git 后缀,免得像个裸仓。
    const target = join(
      workspace, targetName ?? (basename(source).replace(/\.git$/, "") || "repo"));
    // 普通仓有 .git 子目录;裸仓自己就是 git 目录(HEAD+objects)。
    // 只认 .git 会把裸仓误判成普通目录,把仓库内脏拷贝成"工作区"(实测)。
    const isGit = existsSync(join(source, ".git"))
      || (existsSync(join(source, "HEAD"))
          && existsSync(join(source, "objects")));
    // 凭据只对 http(s) 远端有意义;本地路径克隆(演示/试跑)不掺和。
    const useCredential = !!gitHelper && /^https?:\/\//i.test(source);
    if (isGit || /^(?:https?|ssh|git|file):\/\//i.test(source)) {
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
          "clone", "--quiet",
          ...(checkoutBaseline ? ["--branch", checkoutBaseline] : []),
          "--", source, target,
        ],
        {
          encoding: "utf-8",
          // 子进程没有终端,git 想问密码只会把任务挂死——明令禁问,
          // 缺凭据就地失败,错误如实上浮(不卡死红线)。
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
      if (cloned.status !== 0) {
        const detail = String(cloned.stderr || "").trim().slice(0, 500);
        if (checkoutBaseline) {
          throw new Error(
            `仓库克隆失败：代码仓基线「${checkoutBaseline}」不存在或不可访问`
            + (detail ? `：${detail}` : ""));
        }
        throw new Error(`仓库克隆失败${detail ? `：${detail}` : ""}`);
      }
    } else {
      cpSync(source, target, {
        recursive: true,
        filter: (path) => !path.includes(".mae-flow-work")
          && !path.endsWith(".mae-flow.json"),
      });
    }
    // 只读现场的推送硬禁用:pushurl 指向必然不存在的路径,git push
    // 走到传输层就死,与是否配了 helper 无关(本地路径克隆连凭据都
    // 不需要,所以只拦 helper 拦不住)。fetch/log/grep 一概不受影响。
    if (readonly && existsSync(join(target, ".git"))) {
      spawnSync("git",
        ["config", "remote.origin.pushurl", "/dev/null/mae-flow-readonly"],
        { cwd: target, encoding: "utf-8" });
    }
    // 署名与传输方式无关(本地路径克隆的演练也该署对名):配了就写,
    // 邮箱没填只写名字——平台认领靠邮箱,表单里已经把话说明白。
    // 会话重建复用旧克隆,署名改动生效边界=下一次新克隆。
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
        this.notificationLinkBase(), account, task.summary.id),
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
      link: personalTaskLink(this.notificationLinkBase(), account, id),
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
      // external_verify 是 flow.json 明示的宿主等待点。Agent 到这里结束
      // 回合就是正确行为：不能再催它本地编译/跑 UT，更不能连催五轮。
      // settle 随后会释放会话并调用 tryDeliver，由宿主触发权威流水线。
      if (current === "external_verify") return undefined;
      return current && current !== "end" ? current : undefined;
    } catch {
      return undefined;
    }
  }

  private atExternalVerificationWait(task: TaskState): boolean {
    if (!task.cwd) return false;
    try {
      const statePath = join(task.cwd, ".mae-flow.json");
      return existsSync(statePath)
        && String(JSON.parse(readFileSync(statePath, "utf-8"))?.current ?? "")
          === "external_verify";
    } catch {
      return false;
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
        if (stalled && task.nudgedStep !== stalled) {
          // 换了步骤才重置预算；同一步第二次 end_turn 不能因为“已经催过”
          // 就越过内核直接交付。最多催五次，之后如实停机等重跑。
          task.nudgedStep = stalled;
          task.nudgeCount = 0;
        }
        if (stalled && task.driver && (task.nudgeCount ?? 0) < 5) {
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
        const beforeDelivery = this.completionAttestation(task);
        if (beforeDelivery
            && beforeDelivery.kind !== "terminal"
            && beforeDelivery.kind !== "external_verify") {
          // end_turn 是模型会话事实，不是内核流程事实。催办用尽、driver
          // 消失或状态损坏时宁可显式失败，也不能 tryDeliver 后把 running
          // 兜成 completed。failed 可由人工重跑从 current 原地恢复。
          task.lastReply = task.driver?.finalReply();
          task.driver?.dispose();
          this.bypass(task, "容器清理", task.container?.stop());
          task.mission = undefined;
          task.summary.status = "failed";
          task.summary.detail = `Agent 提前结束，${beforeDelivery.reason}`;
          this.persist(task);
          this.notifyOutcome(task);
          break;
        }
        // 收口发言先落袋:修复会话"判断修不了"时这就是给人的诊断,
        // 下面 tryDeliver→pipelineVerdict 的 halted 分支要用。
        task.lastReply = task.driver?.finalReply();
        task.driver?.dispose();
        // host push 的硬前提：不仅调用 dispose，还要先从任务状态移除
        // 会话句柄。pushFromHost 会再次校验，防未来改动把传输挪回会话期。
        task.driver = undefined;
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
        const afterDelivery = this.completionAttestation(task);
        if (afterDelivery && !afterDelivery.complete
            && ["running", "completed", "await_merge"].includes(
              task.summary.status)) {
          // tryDeliver 是 I/O 编排，不拥有终态解释权。无论它从哪个旁路
          // 返回，只要内核还没 terminal + PASS，就只能继续验证/显式失败。
          if (afterDelivery.kind === "external_verify"
              || (afterDelivery.terminal && afterDelivery.external_required)) {
            // 这里是"交付这一轮没能把义务核销掉"的总收口——推送失败、
            // MR 建不起来、内核登记没成,最后都落到这一句。挂起必须带
            // 自愈预算:原来它只写个状态就散场,于是任务既没人再推它、
            // 重启也不管它、连重跑都被拒(实测的那潭死水)。
            this.holdWithRecovery(task, afterDelivery.reason, epoch);
          } else {
            task.summary.status = "failed";
            task.summary.detail = `不能完成任务：${afterDelivery.reason}`;
          }
        } else if (task.summary.status === "running") {
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
