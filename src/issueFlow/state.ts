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
  | "waiting_user"   // Agent 举了 AskUserQuestion,等用户作答
  | "idle"           // 回合结束,等用户下一句话
  | "interrupted"    // 服务重启打断,用户发消息即可续聊
  | "archived"       // 已收口归档(结论见 conclusion)
  | "canceled"
  | "failed";

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
  stage?: IssueStage;
  note: string;
}

export type IssueConclusionKind =
  | "non_issue"   // 非问题(误报/需求误解/无法复现)
  | "fixed"       // 已修复(可能未走 MR,如仅换库验证)
  | "delivered";  // 已修复并提交 MR

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
  environment?: IssueEnvironmentConfig;
  status: IssueStatus;
  stage: IssueStage;
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
  // 不让显示层到处兜旧值。
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

/** 阶段上报的宿主侧校验:枚举之外的值原样打回,显示层不猜。 */
export function validStage(value: string): IssueStage | undefined {
  return (ISSUE_STAGES as readonly string[]).includes(value)
    ? value as IssueStage
    : undefined;
}

/** 追加一条转移日志(只增不改;调用方负责随 saveState 落盘)。 */
export function recordTransition(
  state: IssueSessionState,
  entry: Omit<StageTransition, "at">,
): void {
  (state.transitions ??= []).push({ at: new Date().toISOString(), ...entry });
}
