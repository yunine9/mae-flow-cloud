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

/** Agent 上报的处理阶段(枚举宽松,note 承载细节)。 */
export const ISSUE_STAGES = [
  "registered",      // 已登记,尚未开工
  "ticket_fetched",  // 拿到问题单详情
  "logs_fetched",    // 日志已拉取
  "analyzing",       // 分析问题现象/根因
  "aligning",        // 与用户对齐方案(通常伴随 waiting_user)
  "implementing",    // 编码实现
  "committing",      // 提交变更
  "deploying",       // 换库部署
  "verifying",       // 验证中(含等用户验证结果)
  "submitting_mr",   // 提交 MR
  "concluded",       // 已出结论(非问题/待归档)
] as const;

export type IssueStage = (typeof ISSUE_STAGES)[number];

export const STAGE_LABELS: Record<IssueStage, string> = {
  registered: "已登记",
  ticket_fetched: "拿单",
  logs_fetched: "拉日志",
  analyzing: "分析问题现象",
  aligning: "对齐方案",
  implementing: "编码实现",
  committing: "提交变更",
  deploying: "换库部署",
  verifying: "验证",
  submitting_mr: "提交 MR",
  concluded: "已出结论",
};

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
  return JSON.parse(readFileSync(path, "utf-8")) as IssueSessionState;
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
