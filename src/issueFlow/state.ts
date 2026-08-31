/**
 * 问题会话的状态模型(问题流 v2)。
 *
 * 问题流与需求内核是两个范式:内核是固定阶段状态机,真相在
 * .mae-flow.json;问题流是"AI 按 playbook 自主编排的多轮对话",
 * 平台只承载运行与显示。这里的状态文件是问题域自己的账本——
 * 阶段由 Agent 通过 report_stage 工具上报,宿主只做枚举校验,
 * 不推断(显示层 fail-open,与"前端不推断状态"同一纪律)。
 *
 * 秘密纪律:issue.json 里永远只有环境引用(id),密码在
 * IssueEnvironmentVault 的加密文件里;API/模型/事件流同此。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { IssueControlError } from "./errors.ts";
import { validateRepoUrl } from "./issueGit.ts";
import {
  FIXED_NO_TICKET_STAGES,
  FIXED_TICKET_STAGES,
  fixedStageIndex,
  fixedStages,
  GATE_OPTIONS,
  gateRecommendedCode,
  type FixedStage,
  type GateOption,
} from "./stageRegistry.ts";

// 固定流程的阶段词表、路线与显示名的定义在阶段注册表(stageRegistry.ts,
// 阶段规则的唯一事实源);这里沿用它一贯的导出面,老消费方不用改 import。
export {
  FIXED_NO_TICKET_STAGES,
  FIXED_TICKET_STAGES,
  FIXED_STAGE_LABELS,
  fixedStageIndex,
  fixedStages,
  type FixedStage,
} from "./stageRegistry.ts";

export type IssueSource = "manual" | "dts";

/** 会话生命周期。idle = 回合结束、对话仍开放,用户随时可以继续说;
 * 这是问题流与任务队列的根本差异——"聊完这轮"不等于"办完了"。
 * 没有"打断"态(2026-08-29 拍板):服务重启不是用户可停留的状态,
 * 正在跑的会话恢复时重新入队,由并发额度泵自动续跑。 */
export type IssueStatus =
  | "queued"         // 排队等并发额度(登记首轮与重启恢复共用)
  | "running"        // Agent 回合进行中
  | "waiting_user"   // Agent 举了 AskUserQuestion(或平台闸门),等用户作答
  | "idle"           // 回合结束,等用户下一句话
  | "suspended"      // 无单流程结论为"问题",挂起等用户关联 DTS 单号转正
  | "archived"       // 已收口归档(结论见 conclusion)
  | "canceled"
  | "failed";

/** 问题处理探索方式(2026-08-27 领导拍板):固定流程=宿主权威阶段机
 * +工具门禁;自由探索=AI 按 playbook 自主编排(本文件里 ISSUE_STAGES
 * 那套)。模式在会话创建时烙印,进行中会话不迁移——个人设置切换只
 * 影响新会话,这是"一键切换回来"承诺的底座。缺省视为 free(旧会话)。 */
export type IssueFlowMode = "fixed" | "free";

/** 固定流程的两大场景:有单走七阶段,无单走三节点(结论后可挂起)。 */
export type IssueScenario = "ticket" | "no_ticket";

/** Agent 上报的处理阶段(2026-08-27 用户拍板的词表)。流程动态:阶段
 * 可跳过、可回退(用户推翻结论继续查是正当的),平台只校验词表不排
 * 顺序。done ≠ 归档——它只表达"AI 已给出结论",正式收口走归档。 */
export const ISSUE_STAGES = [
  "registered",     // 已登记,尚未开工(平台写入,Agent 不上报)
  "fetch_detail",   // 获取 DTS 详情
  "align_issue",    // 对齐问题
  "locate_root",    // 分析根因
  "align_solution", // 对齐方案
  "modify_code",    // 实施修改
  "switch_db",      // 换库
  "verify",         // 验证
  "submit_mr",      // 提交 MR
  "done",           // 结束(AI 已给出结论;收口归档是另一个动作)
] as const;

export type IssueStage = (typeof ISSUE_STAGES)[number];

export const STAGE_LABELS: Record<IssueStage, string> = {
  registered: "已登记",
  fetch_detail: "获取 DTS 详情",
  align_issue: "对齐问题",
  locate_root: "分析根因",
  align_solution: "对齐方案",
  modify_code: "实施修改",
  switch_db: "换库",
  verify: "验证",
  submit_mr: "提交 MR",
  done: "问题闭环",
};

// ---- 固定流程阶段词表:定义与规则在阶段注册表(stageRegistry.ts) ----

/** 自由/固定两套词表共用 state.stage 字段。 */
export type AnyIssueStage = IssueStage | FixedStage;

/** 固定流程单个阶段的执行状态(inherited=转正继承,redo=回退待重做)。 */
export type StageState =
  | "pending"
  | "in_progress"
  | "done"
  | "inherited"
  | "redo";

export function initStageStates(
  scenario: IssueScenario, inherited: number,
): StageState[] {
  const total = fixedStages(scenario).length;
  return Array.from({ length: total }, (_, index) =>
    index < inherited ? "inherited" : "pending");
}

/** 2026-08-27 换词表前的旧值 → 新值。只在做读取迁移用,新代码不产旧值。 */
const LEGACY_STAGES: Record<string, IssueStage> = {
  ticket_fetched: "fetch_detail",
  logs_fetched: "locate_root",
  analyzing: "locate_root",
  aligning: "align_solution",
  implementing: "modify_code",
  committing: "modify_code",
  deploying: "switch_db",
  verifying: "verify",
  submitting_mr: "submit_mr",
  concluded: "done",
};

/** 阶段转移日志:Agent 声明(source=agent)与平台机械事实(source=
 * platform,如推送成功/建 MR/绑单号)同账收记,各是各的真相——显示层
 * 只认 state.stage,这里只服务审计与排障("为什么卡在对齐方案三小时")。 */
export interface StageTransition {
  at: string;
  source: "agent" | "platform";
  stage?: AnyIssueStage;
  note: string;
}

export type IssueConclusionKind =
  | "non_issue"   // 非问题(误报/需求误解/无法复现)
  | "fixed"       // 已修复(可能未走 MR,如仅换库验证)
  | "delivered"   // 已修复并提交 MR
  | "issue"       // 问题成立(无单挂起后未转正即收口)
  | "converted";  // 已关联单号转正为新会话(本会话到此为止)

export interface IssueEnvironmentConfig {
  /** 环境引用(vault 里的 id);凭据永不进状态文件。 */
  credential_ref: string;
  name: string;
  /** 网管服务器地址列表(playbook 二进制支持多台串行)。 */
  hosts: string[];
  port: number;
  /** 页面账号(登记元信息的一部分,非密;env_needed 闸现场补配的
   * 环境没有页面凭据,两键一并缺席,消费面按"没有"处理)。 */
  page_account?: string;
  /** 页面凭据组的 vault 引用(页面密码本体只在 vault;纯记录,本期
   * 无消费方,为页面自动化预留)。 */
  page_credential_ref?: string;
}

export interface IssueConclusion {
  kind: IssueConclusionKind;
  summary: string;
  at: string;
}

export interface IssueMrRecord {
  /** MR 所属仓(地址);多仓会话一仓一 MR,各记各的。 */
  repo: string;
  branch: string;
  title: string;
  url?: string;
  iid?: string;
  at: string;
}

export interface IssuePushRecord {
  repo: string;
  branch: string;
  sha: string;
  at: string;
}

/** 平台问题卡(固定流程的人工闸)。与 Agent 的 AskUserQuestion 挂起
 * (humanGate/waiting.json)是并行的两条机制:平台闸由宿主写进
 * issue.json——Agent 对该文件只读,推不动闸门,这正是"固定流程"
 * 的强制度所在。渲染层复用问题卡组件(形状与 waiting 卡同构)。
 * 代码仓缺口不走平台闸(2026-08-28 拍板退役 repo_needed):AI 用
 * lookup_modules/pull_repo/AskUserQuestion 自己闭环。 */
export type IssueGateKind =
  | "analysis_confirm" // 报告确认:放行进入问题修改
  | "conclude"         // 无单结论:是问题→挂起 / 非问题→闭环
  | "env_verify"       // 换库验证:通过→待归档 / 有问题→回退问题分析
  | "env_needed";      // 网管环境:拉日志/换库缺地址与密码时现场补配(2026-08-28)

/** env_needed 闸的用途面:决策卡据此给表单文案,服务端清闸后提示重试。 */
export type IssueGateScope = "logs" | "deploy";

export interface IssueGate {
  id: string;
  kind: IssueGateKind;
  /** 作答幂等基准:创建时的 transitions 长度,对不上即状态已变。 */
  state_version: number;
  /** 选项携带码+文案对(出自 stageRegistry 的 GATE_OPTIONS):前端
   * 渲染 label、提交 code,裁决按码单点分派——文案改字零协议后果。
   * recommended 是本闸的推荐码(ADR-0004,与 Agent 卡同一键):码表
   * 定死或从提案派生(gateRecommendedCode),宿主定不了的缺席。 */
  question: {
    questions: Array<{
      question: string;
      options: GateOption[];
      recommended?: string;
    }>;
  };
  context?: string;
  /** 仅 env_needed:闸为哪类动作而举(logs=拉日志 / deploy=换库部署)。 */
  scope?: IssueGateScope;
  /** 机器可读提案(结论闸带 AI 的结论与摘要,用户过目后确认)。 */
  proposal?: {
    conclusion?: "issue" | "non_issue";
    summary?: string;
    report?: string;
  };
  created_at: string;
}

/** UT 验证上报(阶段5,事实上报):平台只记账留痕,不推进、不设门——
 * 真正的硬验证在阶段6流水线(UT 本身也在流水线里跑),阶段出口是
 * complete_stage 自报。 */
export interface IssueUtRecord {
  passed: boolean;
  summary: string;
  log_path?: string;
  round: number;
  at: string;
}

/** 流水线监看账(阶段6,宿主轮询)。重启后 watching=true 的要重新挂表。 */
export interface IssuePipelineWatch {
  sha: string;
  status: "running" | "success" | "failed";
  /** true=宿主定时器还在盯;false=已出终态或预算耗尽。 */
  watching: boolean;
  started_at: string;
  /** 轮询预算到期时刻(ISO);预算内不重复开表。 */
  deadline: string;
  checks?: import("../pipelineContract.ts").PipelineCheck[];
  last_error?: string;
  round: number;
}

/** MR 验绿门的申报账(阶段6受理路):AI 调 complete_stage 申报清单时
 * 流水线还在跑/无记录,平台先受理——监看器验绿后凭"申报在场"放行。
 * 不变量:进 deploy_verify 当且仅当"已申报且全绿",全绿当场放行与
 * 回退都要清掉它(新一轮要重新申报)。 */
export interface IssueMrGateRecord {
  /** 受理时 AI 申报的 MR 清单(归一到仓地址,一仓一 MR 下与链接等价)。 */
  mrs: string[];
  at: string;
}

export interface IssueSessionState {
  id: string;
  account: string;
  created_at: string;
  updated_at: string;
  title: string;
  description: string;
  source: IssueSource;
  /** 可空:先研究后补单是问题流的一等场景。绑定前推送/MR 被机械拒绝。 */
  ticket?: string;
  /** 首个登记仓(兼容别名):推送/MR/部署缺省目标的权威地址,克隆在
   * repo/<仓名>/。与 repo_urls[0] 保持一致(dual-write),旧字段留给
   * 展示层与老会话。 */
  repo_url?: string;
  /** 全部目标代码仓(2026-08-28 拍板:彼此平等,都可读可改),克隆
   * 平铺在 repo/<仓名>/,由 Agent 调 pull_repo 逐个拉取。 */
  repo_urls?: string[];
  baseline?: string;
  /** 业务模块:module_id 是登记时选定的一等实体(带出 repo_urls 的
   * 来源留痕);module 是展示/报告用的名称标签,由模块名派生。 */
  module_id?: string;
  module?: string;
  environment?: IssueEnvironmentConfig;
  /** 探索方式:创建时烙印,会话中途不换。缺省视为 free(兼容旧会话)。 */
  mode?: IssueFlowMode;
  /** 固定流程的场景(fixed 模式必有)。 */
  scenario?: IssueScenario;
  /** 固定流程每阶段执行状态,与 scenario 阶段表对齐。 */
  stage_states?: StageState[];
  /** 验证回退轮次(fixed 用;回退问题分析时 +1,分支/MR 延用)。 */
  round?: number;
  /** 检视回合进行中(ADR-0007):检视意见已提交、整体回退到分析重跑,
   * 期间不可再叠加检视;submit_analysis 重新举确认卡时清除。 */
  review_active?: boolean;
  /** 平台问题卡在场即 waiting_user 由闸门挂起(与 humanGate 并行)。 */
  gate?: IssueGate;
  ut?: IssueUtRecord;
  /** 流水线监看账(按仓,键=仓地址;一仓一 MR 一流水线)。重启后
   * watching=true 的要逐仓重新挂表。 */
  pipelines?: Record<string, IssuePipelineWatch>;
  /** 转正来源:本会话由哪个无单挂起会话转正而来(带报告继承)。 */
  converted_from?: string;
  /** 转正去向:本会话(无单挂起)转正生成的新会话 id。 */
  converted_to?: string;
  /** 转正继承的交付账引用(#31 拍板:只读引用零拷贝):指向旧会话 id,
   * 旧账(pushes/mrs/pipelines)留在原地不搬运——服务端保持薄,前端
   * 仓卡渲染时经只读详情接口取回并标注「转正前」;旧会话被物理清理时
   * 引用静默缺省。 */
  inherited_accounts?: { issue: string };
  status: IssueStatus;
  stage: AnyIssueStage;
  stage_note: string;
  stage_at: string;
  /** 阶段转移审计日志(Agent 声明 + 平台机械事实)。只增不改。 */
  transitions?: StageTransition[];
  conclusion?: IssueConclusion;
  /** 推送账(按仓,一仓一分支):只增不删,重推同分支覆盖同仓旧账。 */
  pushes?: IssuePushRecord[];
  /** MR 账(按仓,一仓一 MR):AI 的"上报"即 create_mr 的调用记录。 */
  mrs?: IssueMrRecord[];
  /** MR 验绿门的申报账(受理路):complete_stage 申报时流水线在跑则
   * 记账停等,监看器全绿后凭它在场放行(见 IssueMrGateRecord)。 */
  mr_gate?: IssueMrGateRecord;
  /** 本回合已用催办次数(模型提前收嘴的自动续跑)。每个新回合起点清零;
   * 落在状态里是为了重启后不重复催办。 */
  nudges?: number;
  error?: string;
  last_reply?: string;
}

export interface IssueSummary extends IssueSessionState {
  has_environment: boolean;
}

// ---- 多仓工作区映射(克隆/工具/提示词共用,目录命名只写这一处) ----

/** 一个问题会话最多拉取的代码仓数。模块库允许一个模块绑 20 个仓,
 * 但问题会话一轮克隆 8 个已是分析上限——再多说明该拆会话了。 */
export const MAX_ISSUE_REPOS = 8;

/** 登记仓清单:单仓(兼容字段)与多仓合并去重,逐个过协议校验。
 * 顺序即语义——首个即 repo_url 兼容别名(推送/部署的缺省目标),
 * 仓彼此平等。登记(create)、
 * 闸门补填(resolveGate)与 Agent 绑模块(bind_module)三处共用同一
 * 把尺子,上限与协议规则不允许各自为政。 */
export function normalizeIssueRepos(
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

/** 会话登记仓 → 工作区克隆路径:全部平铺 repo/<仓名>/(2026-08-28
 * 拍板:仓平等——废除主仓 repo/ + 参考仓 ref/ 的等级布局,单仓多仓
 * 同构)。仓名取地址末段去 .git,重名追加序号;克隆一律由 Agent 调
 * pull_repo 工具发起,平台不自动克隆。 */
export function issueRepoWorkspaces(
  state: IssueSessionState,
  workspaceRoot: string,
): Array<{ url: string; dir: string }> {
  const repoUrls = state.repo_urls?.length
    ? state.repo_urls
    : state.repo_url ? [state.repo_url] : [];
  const taken = new Set<string>();
  return repoUrls.map((url) => {
    const tail = url.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    const name = tail.replace(/\.git$/i, "") || "repo";
    let candidate = name;
    let serial = 2;
    while (taken.has(candidate)) candidate = `${name}-${serial++}`;
    taken.add(candidate);
    return { url, dir: join(workspaceRoot, "repo", candidate) };
  });
}

export function summarize(state: IssueSessionState): IssueSummary {
  // mr_gate 是 MR 验绿门的内部受理账(流程机制状态):不上 wire——
  // 服务端投影多出前端镜像没有的字段会让契约对账当场红;要上前端
  // 先补 web/src/api.ts 镜像与样例。
  const { mr_gate: _gate, ...rest } = state;
  return {
    ...rest,
    has_environment: Boolean(state.environment),
  };
}

export function loadState(root: string): IssueSessionState | undefined {
  const path = join(root, "issue.json");
  if (!existsSync(path)) return undefined;
  const state = JSON.parse(readFileSync(path, "utf-8")) as IssueSessionState;
  // 旧词表迁移:在途问题带着旧阶段键落盘过,读进来就换成新键,
  // 不让显示层到处兜旧值。固定/自由两套词表都认。
  if (state.stage && !validStage(state.stage)) {
    state.stage = LEGACY_STAGES[state.stage] ?? "registered";
  }
  // 多仓迁移:repo_urls 是权威清单,repo_url 是单仓时代的兼容别名。
  // 老会话只有单仓字段,读进来就补齐另一侧,消费方不用两头兜底。
  if (state.repo_urls?.length) {
    state.repo_url ??= state.repo_urls[0];
  } else if (state.repo_url) {
    state.repo_urls = [state.repo_url];
  }
  // 推送/MR 账迁移:老会话的单数账(push/mr)读进来换成按仓数组
  // (repo 用当时的首个仓地址兜底),字段本身退役。
  const legacyPush = (state as { push?: IssuePushRecord }).push;
  if (!state.pushes?.length && legacyPush) {
    state.pushes = [{
      repo: state.repo_url ?? "",
      branch: legacyPush.branch,
      sha: legacyPush.sha,
      at: legacyPush.at,
    }];
  }
  const legacyMr = (state as { mr?: IssueMrRecord }).mr;
  if (!state.mrs?.length && legacyMr) {
    state.mrs = [{
      repo: state.repo_url ?? "",
      branch: legacyMr.branch,
      title: legacyMr.title,
      ...(legacyMr.url ? { url: legacyMr.url } : {}),
      ...(legacyMr.iid ? { iid: legacyMr.iid } : {}),
      at: legacyMr.at,
    }];
  }
  delete (state as { push?: unknown }).push;
  delete (state as { mr?: unknown }).mr;
  // 流水线账迁移:老单数 pipeline 读进来挂到当时首个仓(repo_url
  // 兼容别名)名下。
  const legacyPipeline = (state as { pipeline?: IssuePipelineWatch }).pipeline;
  if (legacyPipeline && !state.pipelines) {
    state.pipelines = { [state.repo_url ?? ""]: legacyPipeline };
  }
  delete (state as { pipeline?: unknown }).pipeline;
  return state;
}

/** 状态落盘:临时文件 + rename 保原子(与 waiting.json 同款纪律)。 */
export function saveState(root: string, state: IssueSessionState): void {
  mkdirSync(root, { recursive: true });
  state.updated_at = new Date().toISOString();
  const path = join(root, "issue.json");
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 1), "utf-8");
  renameSync(temporary, path);
}

export function isTerminal(status: IssueStatus): boolean {
  return status === "archived" || status === "canceled" || status === "failed";
}

/** 催办谓词(fixed 模式):回合正常收口时,流程还没走到"可以停"的程度吗?
 * 四种情况算"可以停",不催:
 * - 当前阶段已收口(stage_states 里本阶段 done——如环境验证通过待归档);
 * - 流水线在途(MR 已建、平台还在监看——停等流水线是出口的一部分);
 * - MR 验绿门已受理申报(mr_green 阶段 complete_stage 申报后等绿,
 *   同"停等流水线"的合法停机;推进/回退即清,不会滞留);
 * - 自由模式(无阶段真相,停机合法性无从机械判定,不催)。
 * 其余一律催:阶段没走完,模型收嘴就是提前收嘴。 */
export function shouldNudgeFixed(state: IssueSessionState): boolean {
  if (state.mode !== "fixed" || !state.scenario) return false;
  const index = fixedStageIndex(state.scenario, state.stage as FixedStage);
  if (index >= 0 && (state.stage_states?.[index] ?? "pending") === "done") {
    return false;
  }
  const pipelines = Object.values(state.pipelines ?? {});
  if ((state.mrs?.length ?? 0) > 0
      && pipelines.some((watch) => watch.watching || watch.status === "running")) {
    return false;
  }
  if (state.mr_gate) return false;
  return true;
}

/** 阶段上报的宿主侧校验:自由/固定两套词表之外的值原样打回,不猜。 */
export function validStage(value: string): AnyIssueStage | undefined {
  if ((ISSUE_STAGES as readonly string[]).includes(value)) {
    return value as IssueStage;
  }
  const fixed = [
    ...FIXED_TICKET_STAGES, ...FIXED_NO_TICKET_STAGES,
  ] as readonly string[];
  return fixed.includes(value) ? value as FixedStage : undefined;
}

/** 追加一条转移日志(只增不改;调用方负责随 saveState 落盘)。 */
export function recordTransition(
  state: IssueSessionState,
  entry: Omit<StageTransition, "at">,
): void {
  (state.transitions ??= []).push({ at: new Date().toISOString(), ...entry });
}

// ---- 固定流程的阶段机操作(工具与服务共用;真相只在这些函数里变) ----

/** 平台举闸(固定流程的人工硬闸)。只记"闸在场",**不动状态**:
 * 回合可能还在收尾,waiting_user 由 settle 在回合终点定格——中途置位
 * 会让作答撞上"正在处理上一条输入"的竞态。Agent 对 issue.json 只读,
 * 推不动闸。选项不接收参:码+文案对整表投影自 stageRegistry 的
 * GATE_OPTIONS——举卡方自带文案的旧路已废,文案定义地只剩注册表。
 * 推荐码同源:码表定死或按 AI 提案派生(gateRecommendedCode),
 * 随 questions[].recommended 落盘,与 Agent 卡的 wire 同形。 */
const GATE_NAMES: Record<IssueGateKind, string> = {
  analysis_confirm: "分析报告确认",
  conclude: "结论确认",
  env_verify: "环境验证",
  env_needed: "网管环境配置",
};

export function raiseGate(
  state: IssueSessionState,
  kind: IssueGateKind,
  question: string,
  proposal?: IssueGate["proposal"],
  context?: string,
  scope?: IssueGateScope,
): void {
  const recommended = gateRecommendedCode(kind, proposal);
  state.gate = {
    id: `gate-${state.id}-${Date.now().toString(36)}`,
    kind,
    state_version: state.transitions?.length ?? 0,
    question: {
      questions: [{
        question,
        options: GATE_OPTIONS[kind].options.map((option) => ({ ...option })),
        ...(recommended ? { recommended } : {}),
      }],
    },
    ...(proposal ? { proposal } : {}),
    ...(context ? { context } : {}),
    ...(scope ? { scope } : {}),
    created_at: new Date().toISOString(),
  };
  recordTransition(state, {
    source: "platform",
    note: `平台举闸:${GATE_NAMES[kind]}——等待用户作答`,
  });
}

/** 阶段推进:把 [当前+1 .. 目标-1] 一并标记完成(机械跳过的中间段),
 * 目标置 in_progress。继承段(inherited)不动——那是转正带来的既成
 * 事实,不是本轮做的。 */
export function fixedAdvance(
  state: IssueSessionState,
  to: FixedStage,
  note: string,
): void {
  const scenario = state.scenario;
  if (!scenario) return;
  const stages = fixedStages(scenario);
  const target = stages.indexOf(to);
  if (target < 0) return;
  const current = stages.indexOf(state.stage as FixedStage);
  if (current >= 0 && current < target) {
    for (let index = current; index < target; index += 1) {
      if (state.stage_states?.[index] === "inherited") continue;
      (state.stage_states ??= initStageStates(scenario, 0))[index] = "done";
    }
  }
  (state.stage_states ??= initStageStates(scenario, 0))[target] = "in_progress";
  state.stage = to;
  state.stage_note = note;
  state.stage_at = new Date().toISOString();
  recordTransition(state, { source: "platform", stage: to, note });
}

/** 当前阶段收尾(不再前进):换库验证通过后的终态用。 */
export function fixedComplete(state: IssueSessionState, note: string): void {
  const scenario = state.scenario;
  if (!scenario) return;
  const current = fixedStageIndex(scenario, state.stage);
  if (current < 0) return;
  (state.stage_states ??= initStageStates(scenario, 0))[current] = "done";
  state.stage_note = note;
  state.stage_at = new Date().toISOString();
  recordTransition(state, { source: "platform", stage: state.stage, note });
}

/** 验证不通过的一律回退(2026-08-27 拍板):回到问题分析,分析之后的
 * 阶段标 redo 待重做,轮次 +1;分支与 MR 记录延用(同分支追加修复,
 * CodeHub MR 自动跟新提交);UT 上报、流水线监看与 MR 申报账作废重来
 * (mr_gate 清掉——新一轮要重新申报)。 */
export function fixedRollback(
  state: IssueSessionState,
  reason: string,
): void {
  const scenario = state.scenario;
  if (!scenario) return;
  const analyzeIndex = fixedStageIndex(scenario, "analyze");
  if (analyzeIndex < 0) return;
  const current = fixedStageIndex(scenario, state.stage);
  const states = state.stage_states ??= initStageStates(scenario, 0);
  if (current > analyzeIndex) {
    for (let index = analyzeIndex + 1; index < states.length; index += 1) {
      if (states[index] === "inherited") continue;
      states[index] = "redo";
    }
  }
  states[analyzeIndex] = "in_progress";
  state.stage = "analyze";
  state.round = (state.round ?? 1) + 1;
  state.stage_note = reason;
  state.stage_at = new Date().toISOString();
  delete state.ut;
  delete state.pipelines;
  delete state.mr_gate;
  delete state.gate;
  recordTransition(state, {
    source: "platform", stage: "analyze",
    note: `第 ${state.round} 轮:${reason}`,
  });
}
