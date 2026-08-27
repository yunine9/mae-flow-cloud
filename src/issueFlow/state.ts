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

export type IssueSource = "manual" | "dts";

/** 会话生命周期。idle = 回合结束、对话仍开放,用户随时可以继续说;
 * 这是问题流与任务队列的根本差异——"聊完这轮"不等于"办完了"。 */
export type IssueStatus =
  | "queued"         // 已登记,首轮还没排上(并发额度)
  | "running"        // Agent 回合进行中
  | "waiting_user"   // Agent 举了 AskUserQuestion(或平台闸门),等用户作答
  | "idle"           // 回合结束,等用户下一句话
  | "interrupted"    // 服务重启打断,用户发消息即可续聊
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

// ---- 固定流程阶段词表(自由探索那套 ISSUE_STAGES 原样保留) ----

/** 固定流程的阶段键。与自由词表刻意不同名:两套语义并存,UI 按
 * 会话模式选词表渲染,不互相污染。 */
export const FIXED_TICKET_STAGES = [
  "dts_info",      // 获取 DTS 单信息(工具拉详情,成功即机械推进)
  "prep_repo",     // 拉取代码仓+创建分支(宿主代劳,机械推进)
  "analyze",       // 问题分析:对齐现象-根因-方案,产出分析报告(submit_analysis 触发人工闸)
  "fix",           // 问题修改(complete_stage 自报完成)
  "ut",            // UT 验证(report_ut 上报,passed 才放行 MR)
  "mr_green",      // 提交 MR+流水线跑绿(宿主监看,红→AI 修→再推)
  "deploy_verify", // 换库环境验证(部署后平台闸等用户真实验证)
] as const;

/** 无单场景三节点:测试/开发自行定位用,结论"是问题"→挂起待关联。 */
export const FIXED_NO_TICKET_STAGES = [
  "prep_repo",     // 拉取代码仓(无单不建分支——分支名规范需要单号)
  "analyze",       // 问题分析(同有单,产出报告)
  "conclude",      // 确定结论(平台闸:是问题→挂起 / 非问题→闭环)
] as const;

export type FixedStage =
  | (typeof FIXED_TICKET_STAGES)[number]
  | (typeof FIXED_NO_TICKET_STAGES)[number];

/** 自由/固定两套词表共用 state.stage 字段。 */
export type AnyIssueStage = IssueStage | FixedStage;

export const FIXED_STAGE_LABELS: Record<IssueScenario, Record<FixedStage, string>> = {
  ticket: {
    dts_info: "获取 DTS 单信息",
    prep_repo: "拉取代码仓·建分支",
    analyze: "问题分析",
    fix: "问题修改",
    ut: "UT 验证",
    mr_green: "提交 MR·跑绿",
    deploy_verify: "换库环境验证",
    conclude: "确定结论",
  },
  no_ticket: {
    dts_info: "获取 DTS 单信息",
    prep_repo: "拉取代码仓",
    analyze: "问题分析",
    fix: "问题修改",
    ut: "UT 验证",
    mr_green: "提交 MR·跑绿",
    deploy_verify: "换库环境验证",
    conclude: "确定结论",
  },
};

export function fixedStages(scenario: IssueScenario): readonly FixedStage[] {
  return scenario === "ticket" ? FIXED_TICKET_STAGES : FIXED_NO_TICKET_STAGES;
}

export function fixedStageIndex(
  scenario: IssueScenario, stage: AnyIssueStage,
): number {
  return fixedStages(scenario).indexOf(stage as FixedStage);
}

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
}

export interface IssueConclusion {
  kind: IssueConclusionKind;
  summary: string;
  at: string;
}

export interface IssueMrRecord {
  branch: string;
  title: string;
  url?: string;
  iid?: string;
  at: string;
}

export interface IssuePushRecord {
  branch: string;
  sha: string;
  at: string;
}

/** 平台问题卡(固定流程的人工闸)。与 Agent 的 AskUserQuestion 挂起
 * (humanGate/waiting.json)是并行的两条机制:平台闸由宿主写进
 * issue.json——Agent 对该文件只读,推不动闸门,这正是"固定流程"
 * 的强制度所在。渲染层复用问题卡组件(形状与 waiting 卡同构)。 */
export type IssueGateKind =
  | "analysis_confirm" // 报告确认:放行进入问题修改
  | "conclude"         // 无单结论:是问题→挂起 / 非问题→闭环
  | "env_verify";      // 换库验证:通过→待归档 / 有问题→回退问题分析

export interface IssueGate {
  id: string;
  kind: IssueGateKind;
  /** 作答幂等基准:创建时的 transitions 长度,对不上即状态已变。 */
  state_version: number;
  question: { questions: Array<{ question: string; options: string[] }> };
  context?: string;
  /** 机器可读提案(结论闸带 AI 的结论与摘要,用户过目后确认)。 */
  proposal?: {
    conclusion?: "issue" | "non_issue";
    summary?: string;
    report?: string;
  };
  created_at: string;
}

/** UT 验证上报(阶段5)。宿主拦的是"上报"不拦"真相":passed 才放行
 * create_mr,但真正的硬验证在阶段6流水线(UT 本身也在流水线里跑)。 */
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
  repo_url?: string;
  baseline?: string;
  /** 业务模块自由文本标签(仅展示/报告引用;模块→仓映射配置另有团队
   * 在做,接入前不承载任何判定)。 */
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
  /** 平台问题卡在场即 waiting_user 由闸门挂起(与 humanGate 并行)。 */
  gate?: IssueGate;
  ut?: IssueUtRecord;
  pipeline?: IssuePipelineWatch;
  /** 转正来源:本会话由哪个无单挂起会话转正而来(带报告继承)。 */
  converted_from?: string;
  /** 转正去向:本会话(无单挂起)转正生成的新会话 id。 */
  converted_to?: string;
  status: IssueStatus;
  stage: AnyIssueStage;
  stage_note: string;
  stage_at: string;
  /** 阶段转移审计日志(Agent 声明 + 平台机械事实)。只增不改。 */
  transitions?: StageTransition[];
  conclusion?: IssueConclusion;
  push?: IssuePushRecord;
  mr?: IssueMrRecord;
  error?: string;
  last_reply?: string;
}

export interface IssueSummary extends IssueSessionState {
  has_environment: boolean;
}

export function summarize(state: IssueSessionState): IssueSummary {
  return {
    ...state,
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
 * 推不动闸。 */
const GATE_NAMES: Record<IssueGateKind, string> = {
  analysis_confirm: "分析报告确认",
  conclude: "结论确认",
  env_verify: "环境验证",
};

export function raiseGate(
  state: IssueSessionState,
  kind: IssueGateKind,
  question: string,
  options: string[],
  proposal?: IssueGate["proposal"],
  context?: string,
): void {
  state.gate = {
    id: `gate-${state.id}-${Date.now().toString(36)}`,
    kind,
    state_version: state.transitions?.length ?? 0,
    question: { questions: [{ question, options }] },
    ...(proposal ? { proposal } : {}),
    ...(context ? { context } : {}),
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
 * CodeHub MR 自动跟新提交);UT 上报与流水线监看作废重来。 */
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
  delete state.pipeline;
  delete state.gate;
  recordTransition(state, {
    source: "platform", stage: "analyze",
    note: `第 ${state.round} 轮:${reason}`,
  });
}
