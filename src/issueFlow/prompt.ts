/**
 * 问题会话的首轮提示词与 playbook 改编技能。
 *
 * 技能源头是仓内静态目录 assets/issue-skills/<name>/SKILL.md(标准
 * skill 目录形态),从 every-skill 仓的 playbook 改编而来,适配云上:
 * - 工号不再是 $HOME 目录名,而是平台注入的登录账号;
 * - 二进制/MCP 不由 Agent 直调,换成宿主工具(fetch_logs/build_deploy/
 *   push_branch/create_mr/dts_get_ticket);
 * - 新增"非问题出口":研究结论可以就是终点,不强制进编码交付。
 * 每次会话启动时从源目录整读、物化到工作区 skills/ 下(幂等重写)。
 * 技能文本与它引用的宿主工具同仓同版本演进——改工具就得同 commit
 * 改技能,评审看得见;想直接改文案就编辑 md 文件,不再碰 TS 字符串。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IssueSessionState } from "./state.ts";
import { STAGE_LABELS } from "./state.ts";

/** 技能源目录:标准 skill 目录,每个子目录一个 SKILL.md(测试对源断言用)。 */
export const SKILL_SOURCE_DIR = resolve(
  fileURLToPath(import.meta.url), "..", "..", "..",
  "assets", "issue-skills");

/** 把改编技能物化到工作区(幂等重写),返回 SKILL.md 精确路径。
 * 源目录缺失或缺 SKILL.md 都 fail-loud:技能是行为契约,静默少一个
 * 等于让 Agent 少一条规矩,不如启动就响。 */
export function materializeIssueSkills(workspace: string): string[] {
  if (!existsSync(SKILL_SOURCE_DIR)) {
    throw new Error(`问题会话技能源目录缺失: ${SKILL_SOURCE_DIR}`);
  }
  const entries = readdirSync(SKILL_SOURCE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (!entries.length) {
    throw new Error(`技能源目录为空: ${SKILL_SOURCE_DIR}`);
  }
  const paths: string[] = [];
  for (const name of entries) {
    const source = join(SKILL_SOURCE_DIR, name, "SKILL.md");
    if (!existsSync(source)) {
      throw new Error(
        `技能目录 ${name} 缺 SKILL.md(源: ${SKILL_SOURCE_DIR})`);
    }
    const dir = join(workspace, "skills", name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    writeFileSync(path, readFileSync(source, "utf-8"), "utf-8");
    paths.push(path);
  }
  return paths;
}

function envLine(state: IssueSessionState): string {
  if (!state.environment) return "未配置网管环境(不能拉日志/换库;纯代码分析可继续)。";
  return `网管环境「${state.environment.name}」: ${state.environment.hosts.join(", ")}`;
}

export function issueOpeningPrompt(state: IssueSessionState): string {
  return [
    "你是本问题会话的研究与处理 Agent。工作方式见技能 issue-playbook(路线图)、"
    + "issue-research(研究方法)、issue-delivery(交付)、issue-ops(环境操作)。",
    "",
    "## 问题事实",
    `- 标题: ${state.title}`,
    `- 描述: ${state.description || "(无补充描述)"}`,
    `- 单号: ${state.ticket ?? "(尚未绑定——先研究后补单是正常形态;推送/提MR前必须请用户在页面绑定)"}`,
    `- 工号: ${state.account}`,
    `- 代码仓: ${state.repo_url ? `${state.repo_url}(已克隆到 repo/)` : "(未登记——需要读代码时请用户提供仓库地址,由用户在页面补充登记)"}`,
    `- ${envLine(state)}`,
    "",
    "## 行为契约",
    "1. 阶段上报:每进入新环节调 report_stage——平台显示你正在干什么,全靠它。",
    "2. 人工闸门:对齐方案、部署后验证,必须 AskUserQuestion 停下等用户,绝不自作主张。",
    "3. 非问题是一等结论:研究判定非问题就出结论收口,不强制编码。",
    "4. 秘密边界:环境密码与各 token 由平台保管,不向用户索要、不猜测、不讨论。",
    "5. 结论文档持续维护 issue-analysis.md,它是本会话的核心交付物。",
    "",
    "现在开始:先复述你对问题现象的理解,给出研究计划(打算看什么、拉什么日志、"
    + "问用户什么),然后按计划推进。",
  ].join("\n");
}

/** 续聊提示词(重启/归档前的下一轮):锚定已有现场,不从头推翻。 */
export function issueResumePrompt(
  state: IssueSessionState,
  userText: string,
): string {
  return [
    "服务重启/续聊后继续同一问题会话。已有现场(不要从头推翻,先读 "
    + "issue-analysis.md 与 skills/ 提示,再继续):",
    `- 标题: ${state.title}`,
    `- 单号: ${state.ticket ?? "(未绑定)"}`,
    `- 最近阶段: ${STAGE_LABELS[state.stage]}(${state.stage_note || "无说明"})`,
    state.push ? `- 已推送: ${state.push.branch} @ ${state.push.sha.slice(0, 12)}` : "",
    state.mr ? `- 已建 MR: ${state.mr.url}` : "",
    "",
    `用户的最新输入:\n\n${userText}`,
  ].filter(Boolean).join("\n");
}
