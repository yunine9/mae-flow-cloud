/**
 * 问题会话的状态模型(问题流 v2)。
 *
 * 问题流与需求内核是两个范式:内核是固定阶段状态机,真相在
 * .mae-flow.json;问题流是"AI 在阶段内自主作业的多轮对话",
 * 平台承载阶段机与运行显示。这里的状态文件是问题域自己的账本——
 * 阶段真相在宿主(fixedAdvance 等机械操作是唯一写手,Agent 对
 * issue.json 只读),显示层 fail-open(与"前端不推断状态"同一纪律)。
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
import type { FeedbackRecord } from "../feedbackStore.ts";
import { IssueControlError } from "./errors.ts";
import type { IssueWarmupReceipt } from "./warmup.ts";
import { validateRepoUrl } from "./issueGit.ts";
import {
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

/** 固定流程的两大场景:有单走五阶段,无单走三节点(结论后可挂起)。 */
export type IssueScenario = "ticket" | "no_ticket";

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

/** 阶段转移日志:Agent 声明(source=agent)与平台机械事实(source=
 * platform,如推送成功/建 MR/绑单号)同账收记,各是各的真相——显示层
 * 只认 state.stage,这里只服务审计与排障("为什么卡在对齐方案三小时")。 */
export interface StageTransition {
  at: string;
  source: "agent" | "platform";
  stage?: FixedStage;
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
  | "env_needed"       // 网管环境:拉日志/换库缺地址与密码时现场补配(2026-08-28)
  | "push_confirm"     // 推送前过目(ADR-0009):push_branch 的交付轴硬闸,
                       // 确认产一次性令牌放行一次推送;不绑阶段。
  | "skill_select"     // skill 圈选(ADR-0011):analyze 入口的多选闸,
                       // 月光关档由归属人圈定业务仓 skill 必读集合;
                       // 作答走 selection 专用口(与 env_needed 表单同款)。
  | "pipeline_unfixable" // 流水线不可修告警(2026-09-01,票 03):红灯失败项
                         // 全是不可自动修复的工具告警——人在交付平台处理/
                         // 豁免后于卡上作答,平台重置监看账重看同一 SHA;
                         // 问的是人工处理事实,月光永不代答。
  | "pipeline_evidence"; // 流水线证据回灌(同票):红灯但没有一条可定位的
                         // 具体报错,为免猜改停机——请人把报错原文粘贴进
                         // 作答(自由文本),作答即证据回灌+续跑修复回合。

/** env_needed 闸的用途面:决策卡据此给表单文案,服务端清闸后提示重试。 */
export type IssueGateScope = "logs" | "deploy";

/** 用途面的人话(拒绝按钮文案/转移账/平台通知按它分叉,票 93)。
 *  service 与 tools 两处消费,单一来源在此——不许各写一份漂移。 */
export const ENV_SCOPE_LABELS: Record<IssueGateScope, string> = {
  logs: "拉日志",
  deploy: "换库部署",
};

/** 环境拒绝台账(2026-09-03,票 93):归属人在 env_needed 卡上拒绝
 * 拉日志/换库——这是人的硬裁定。字段在场=清单里的 scope 已被拒:
 * 同 scope 工具再调不再举闸(防纠缠),配置环境成功即整册清除
 * (解锢,见 attachEnvironment)。不上 wire(与 mr_gate 同为流程机制
 * 状态,前端镜像没有这个字段)。 */
export interface IssueEnvDeclined {
  /** 已拒的用途面。 */
  scopes: IssueGateScope[];
  /** 最近一次拒绝的时刻(同 scope 重复拒绝刷新清单与时刻)。 */
  at: string;
}

/** skill 圈选清单里的一项(ADR-0011):扫描已拉仓 `.cac/skills/` 所得。
 * path 是会话工作区相对路径(repo/<仓名>/.cac/skills/<名>/SKILL.md),
 * 天然唯一——多仓同名 skill 靠仓段区分;repo 是仓地址(分组展示用)。 */
export interface IssueSkillChoice {
  path: string;
  repo: string;
  name: string;
  description: string;
}

/** 圈选台账(ADR-0011):字段在场=归属人已作答(skills 空=明确"都不用",
 * AI 按取用次序自主)。重走 analyze 不重举的判据就是它在不在。 */
export interface IssueSkillSelection {
  at: string;
  skills: IssueSkillChoice[];
}

/** 业务知识台账的单项(ADR-0012):团队资产库按绑定模块定格的已发布
 * 知识资产,只读投影在 .mae-flow-work/business-modules/ 下。 */
export interface IssueBusinessKnowledgeEntry {
  id: string;
  module_id: string;
  module_name: string;
  title: string;
  summary: string;
  when_to_use: string;
  form: string;
  version: number;
  /** 会话工作区相对路径(渲染业务知识地图直接用)。 */
  relative_path: string;
}

/** 业务知识台账(ADR-0012):字段在场=进入 analyze 时已按当时的绑定
 * 模块定格过;重启/续聊按它渲染地图,版本不随发布库中途更新漂移
 * (与需求侧"按任务固定版本"同一纪律)。entries 空=绑定的模块没有
 * 已发布资产(或会话没绑模块——整个字段缺席)。 */
export interface IssueBusinessKnowledge {
  at: string;
  entries: IssueBusinessKnowledgeEntry[];
}

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
  /** 仅 skill_select:扫描所得的圈选清单(动态数据,不是文案——文案
   * 仍在 GATE_OPTIONS)。作答的 selection 必须是这里 path 的子集,
   * 浏览器自报路径一律拒绝(与需求侧仓内能力发现同一纪律)。 */
  skills?: IssueSkillChoice[];
  /** 仅 pipeline_unfixable/pipeline_evidence:闸属于哪个仓的哪次提交
   * (作答后续跑按它重置监看账/注入证据——同 SHA 重新监看或带着人工
   * 原文开修复回合)。卡面(卡面与作答协议)见 stageRegistry 码表。 */
  pipeline?: { repo: string; sha: string };
  /** 机器可读提案(结论闸带 AI 的结论与摘要,用户过目后确认)。 */
  proposal?: {
    conclusion?: "issue" | "non_issue";
    summary?: string;
    report?: string;
    /** 置信度自报(ADR-0006):无单结论闸的月光代答消费——non_issue
     * 且 high 才自动闭环;缺省按置信度不足处理,宁人工勿猜。 */
    confidence?: "high" | "medium" | "low";
  };
  created_at: string;
}

/** UT 验证上报(修复阶段内,事实上报):平台只记账留痕,不推进、不设门——
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
  /** 本仓累计红灯次数(绿了清零):与需求侧修复轮预算同语义——超过
   *  repair_rounds 就停止自动回灌修复,留痕请人工。 */
  reds?: number;
  /** 证据重试窗(票 82):红灯证据全缺/盲输入时不立即举卡,先记下
   *  取证截止时间,定时器每隔一段重拉镜像重新评估——产物晚到在窗内
   *  自愈(自动派修,人无感),到点仍缺才举 pipeline_evidence 卡。
   *  字段在场=重试窗在途;随 issue.json 落盘,重启凭它续算(不重置
   *  截止、不白等),新流水线重挂表时不随迁(旧窗随旧提交作废)。 */
  evidence_retry_deadline?: string;
  /** 重试窗内已做的重评次数(留痕/排障用,不作收手判据)。 */
  evidence_retry_attempts?: number;
  /** 进窗那次红灯的失败摘要原文(截断防膨胀):重启续算时重评的
   *  failureSummary 输入——结算现场的 run 不跨进程,落盘才评得动。 */
  evidence_failure_log?: string;
  /** 上次派修的提交(票 82 同提交刹车):红灯 SHA===它=修了没出新
   *  提交,停机不派(reds 不变),会话最后发言作诊断。派修时写入,
   *  跨重挂表保留(刹车判据必须跨 push/re-arm 存活),绿了清账。 */
  last_repair_sha?: string;
  /** 上轮报错摘要(维度点名+报错节选,截断防膨胀):下轮派修拼进
   *  回合提示词,附"同一处必须换思路"纪律(需求流 loop.failure 同
   *  语义);与 last_repair_sha 同拍写入、同拍清理。 */
  last_failure_summary?: string;
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
  /** 人工预绑锁(spec #57):模块来自人在发起时的显式选择(DTS 列表
   * 预绑或登记页手工选)即烙印,AI 的 bind_module 对此拒绝改绑——
   * 模块绑定权在人,AI 发现不符只能 AskUserQuestion。缺省=未锁
   * (AI 运行时自己绑的可改绑,维持现状)。 */
  module_locked?: true;
  environment?: IssueEnvironmentConfig;
  /** 固定流程的场景。 */
  scenario?: IssueScenario;
  /** 固定流程每阶段执行状态,与 scenario 阶段表对齐。 */
  stage_states?: StageState[];
  /** 验证回退轮次(fixed 用;回退问题分析时 +1,分支/MR 延用)。 */
  round?: number;
  /** 检视回合进行中(ADR-0007):检视意见已提交、整体回退到分析重跑,
   * 期间不可再叠加检视;submit_analysis 重新举确认卡时清除。 */
  review_active?: boolean;
  /** skill 圈选台账(ADR-0011):analyze 入口圈选的必读集合。字段在场
   * =已作答(skills 空=明确跳过,AI 自主);重走不重举的判据。 */
  skill_selection?: IssueSkillSelection;
  /** 业务知识台账(ADR-0012):进入 analyze 时按绑定模块定格的资产库
   * 知识,只读投影在 .mae-flow-work/business-modules/。字段在场=已
   * 定格,不随发布库中途更新漂移。 */
  business_knowledge?: IssueBusinessKnowledge;
  /** 平台问题卡在场即 waiting_user 由闸门挂起(与 humanGate 并行)。 */
  gate?: IssueGate;
  /** 环境拒绝台账(票 93):env_needed 卡上「拒绝」的硬裁定——同
   * scope 工具再调不再举闸(防纠缠);attachEnvironment 成功即整册
   * 清除(解锢)。不上 wire,与 mr_gate 同罪同罚。 */
  env_declined?: IssueEnvDeclined;
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
  stage: FixedStage;
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
  /** 一次性推送确认令牌(ADR-0009):push_confirm 闸答「确认推送」时
   * 写入(带确认时刻与决策留痕),push_branch 成功即消费(删除)——
   * 下一次推送重新过目,防盲签。head=过目那一刻的分支 tip:确认的
   * 对象是"当时看到的那份变更",重推时 tip 变了(过目后又有新提交)
   * 令牌即作废重新举卡。随 issue.json 持久化,重启恢复路径(recover)
   * 不清它:已过目的确认不因重启要求重复点。summarize 不上 wire(与
   * mr_gate 同为流程机制状态,前端镜像没有这个字段)。 */
  push_token?: { at: string; decision: string; head?: string };
  /** 举 push_confirm 闸时记下的待推送 tip(过目对象的身份):确认时
   * 并进 push_token.head。不上 wire,与 push_token 同罪同罚。 */
  push_review_head?: string;
  /** 本回合已用催办次数(模型提前收嘴的自动续跑)。每个新回合起点清零;
   * 落在状态里是为了重启后不重复催办。 */
  nudges?: number;
  /** 环境预热收据(2026-09-04,需求侧 baseline_build 的问题流形态):
   * 拉仓完成进 analyze 时后台预热专员的状态。幂等判据=finished_at;
   * warmup 模块权威,前端镜像没有这个字段。类型与收据写入方共用
   * IssueWarmupReceipt,防两侧 status 联合各自漂移。 */
  warmup?: IssueWarmupReceipt;
  error?: string;
  last_reply?: string;
}

export interface IssueSummary extends IssueSessionState {
  has_environment: boolean;
  /** 进入代码交付后的持续检视投影；原始流水线/MR 账仍各自权威。 */
  feedback?: FeedbackRecord[];
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
  // 先补 web/src/api.ts 镜像与样例。push_token(推送过目的一次性
  // 令牌)与 push_review_head(举闸时记的过目对象 tip)同罪同罚:
  // 它们的效力只在服务端 push_branch 消费口,不是前端要渲染的状态。
  // env_declined(环境拒绝台账,票 93)同理:效力只在服务端工具层
  // (同 scope 不再举闸),前端镜像没有这个字段。warmup(环境预热
  // 收据,2026-09-04)也是服务端流程机制状态:修复 Agent 经文件系统
  // 读 build-notes,前端不需要渲染它。
  const { mr_gate: _gate, push_token: _pushToken,
    push_review_head: _pushReviewHead, env_declined: _envDeclined,
    warmup: _warmup, ...rest } = state;
  return {
    ...rest,
    has_environment: Boolean(state.environment),
  };
}

export function loadState(root: string): IssueSessionState | undefined {
  const path = join(root, "issue.json");
  if (!existsSync(path)) return undefined;
  const state = JSON.parse(readFileSync(path, "utf-8")) as IssueSessionState;
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

/** 催办谓词:回合正常收口时,流程还没走到"可以停"的程度吗?
 * 四种情况算"可以停",不催:
 * - 会话没有场景阶段(转正前的存量现场,停机合法性无从机械判定,不催);
 * - 当前阶段已收口(stage_states 里本阶段 done——如环境验证通过待归档);
 * - 流水线在途(MR 已建、平台还在监看——停等流水线是出口的一部分);
 * - MR 验绿门已受理申报(mr_green 阶段 complete_stage 申报后等绿,
 *   同"停等流水线"的合法停机;推进/回退即清,不会滞留)。
 * 其余一律催:阶段没走完,模型收嘴就是提前收嘴。 */
export function shouldNudgeFixed(state: IssueSessionState): boolean {
  if (!state.scenario) return false;
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
  push_confirm: "推送确认",
  skill_select: "skill 圈选",
  pipeline_unfixable: "流水线不可修告警",
  pipeline_evidence: "流水线报错回灌",
};

export function raiseGate(
  state: IssueSessionState,
  kind: IssueGateKind,
  question: string,
  proposal?: IssueGate["proposal"],
  context?: string,
  scope?: IssueGateScope,
  /** 仅 skill_select:扫描所得的圈选清单(动态数据,非文案——选项
   * 码表照旧出自 GATE_OPTIONS)。其余闸不传,在场即阶段配置错误。 */
  skills?: IssueSkillChoice[],
  /** 仅 pipeline_unfixable/pipeline_evidence:闸归属的仓与提交
   * (作答续跑的重新监看/证据注入按它定位)。 */
  pipeline?: IssueGate["pipeline"],
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
    ...(skills ? { skills } : {}),
    ...(pipeline ? { pipeline } : {}),
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
