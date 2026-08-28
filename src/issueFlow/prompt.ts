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
import { issueRepoWorkspaces } from "./state.ts";
import {
  FIXED_STAGE_LABELS,
  STAGE_LABELS,
  fixedStages,
  type FixedStage,
} from "./state.ts";

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
  if (!state.environment) {
    return "未配置网管环境——需要拉日志/换库时直接调工具,平台会向用户发起"
      + "环境配置请求(密码只进平台,不经你手)。";
  }
  return `网管环境「${state.environment.name}」: ${state.environment.hosts.join(", ")}`;
}

/** 多仓清单块:主仓=交付仓(repo/),其余参考仓(ref/<仓名>/)。
 * 路径相对会话工作区(Agent 的 cwd 就是工作区根)。清单以可读的
 * 工作区路径开头——登记地址(尤其本地路径仓)只作"克隆自"注脚:
 * 本地路径与本机真实目录同名同在,放前面会被 Agent 当可读路径去
 * 撞工作区护栏(实测 issue-24 踩坑)。空清单返回空串,由调用方给
 * "未登记"文案。 */
function repoLines(state: IssueSessionState): string {
  const repos = issueRepoWorkspaces(state, "");
  if (!repos.length) return "";
  const lines = repos.map((repo, index) => {
    const role = index === 0
      ? "交付仓:推送/MR/部署都在这里"
      : "参考仓:只读分析";
    const source = /^https?:\/\//i.test(repo.url)
      ? `克隆自 ${repo.url}`
      : `克隆自本地路径 ${repo.url}(那是工作区外的源,不可直接读,`
        + `读代码用 ${repo.dir}/ 下的相对路径)`;
    return `  - ${repo.dir}/ —— ${role};${source}`;
  });
  return `- 代码仓(${repos.length} 个,已克隆;读代码一律用下列`
    + `工作区相对路径):\n${lines.join("\n")}`;
}

/** 阶段名(自由/固定两套词表都认)。 */
export function stageLabelOf(state: IssueSessionState): string {
  if (state.mode === "fixed" && state.scenario) {
    return FIXED_STAGE_LABELS[state.scenario][state.stage as FixedStage]
      ?? String(state.stage);
  }
  return STAGE_LABELS[state.stage as keyof typeof STAGE_LABELS]
    ?? String(state.stage);
}

// ---- 固定流程(2026-08-27 拍板:宿主权威阶段机,Agent 只在阶段内干活) ----

/** 各阶段的目标与可用工具(提示词的引导层;权威层在工具 execute 门禁)。 */
const FIXED_STAGE_BRIEFS: Record<FixedStage, { goal: string; tools: string }> = {
  dts_info:
    { goal: "调 dts_get_ticket 拉全单据详情,通读现象与处理历史", tools: "dts_get_ticket" },
  prep_repo:
    { goal: "确定代码仓:登记时未带仓,平台已举「代码仓确认」卡等用户作答"
      + "(填地址/AI 识别/跳过)。用户选 AI 识别后:用 lookup_modules 按问题单"
      + "描述的业务关键词检索业务模块,命中且带仓就 bind_module 绑定——平台"
      + "随即克隆并推进到问题分析;检索不到就 AskUserQuestion 问用户要业务"
      + "模块或代码仓地址",
      tools: "lookup_modules、bind_module" },
  analyze:
    { goal: "对齐现象-根因-方案,产出 issue-analysis.md,然后 submit_analysis 提交"
      + "(无单场景 submit_analysis 需带结论 issue/non_issue)",
      tools: "fetch_logs、dts_get_ticket(需要时重查单据)、submit_analysis" },
  fix:
    { goal: "按已确认的方案实施修复;改完自检通过后 complete_stage 自报完成",
      tools: "fetch_logs(补证据)、bash 改码、complete_stage" },
  ut:
    { goal: "在代码仓里跑单元测试;全绿后 report_ut(passed=true)上报",
      tools: "bash 跑测、report_ut" },
  mr_green:
    { goal: "push_branch 推送修复分支,create_mr 建 MR(须先有 UT 通过记录);"
      + "平台监看流水线,红了会带回失败项,修完同分支再推,直到全绿",
      tools: "push_branch、create_mr" },
  deploy_verify:
    { goal: "调 build_deploy 换库部署;部署完成平台举验证卡,停下等用户真实验证",
      tools: "build_deploy" },
  conclude:
    { goal: "submit_analysis 提交结论(是问题/非问题)——本场景没有修改与交付环节",
      tools: "fetch_logs、submit_analysis" },
};

export function issueFixedOpeningPrompt(state: IssueSessionState): string {
  const scenario = state.scenario ?? "ticket";
  const stages = fixedStages(scenario).map((stage) =>
    FIXED_STAGE_LABELS[scenario][stage]).join(" → ");
  const current = state.stage as FixedStage;
  const brief = FIXED_STAGE_BRIEFS[current];
  const inheritedNote = state.converted_from
    ? `\n- 本会话由 ${state.converted_from} 转正而来:分析报告(issue-analysis.md)已继承,`
      + "前三个阶段视为已完成,直接从「问题修改」开始——先读报告再动手,不要重新分析。"
    : "";
  return [
    "你是本问题会话的处理 Agent。本会话走**固定流程**:阶段由平台推进与把关,"
      + "你只在当前阶段内干活。研究方法参考技能 issue-research/issue-ops,交付参考 issue-delivery。",
    "",
    "## 问题事实",
    `- 标题: ${state.title}`,
    `- 描述: ${state.description || "(无补充描述)"}`,
    `- 单号: ${state.ticket ?? "(无单号场景:测试/开发自行定位,结论后由用户决定挂起提单或闭环)"}`,
    `- 工号: ${state.account}`,
    repoLines(state) || "- 代码仓: (未登记)",
    ...(scenario === "ticket" && state.ticket
      ? [`- 修复分支 master_${state.account}_${state.ticket} 由平台在主仓创建`]
      : []),
    `- ${envLine(state)}`,
    inheritedNote,
    "",
    `## 阶段路线(${scenario === "ticket" ? "有单七阶段" : "无单三节点"})`,
    stages,
    "",
    "## 阶段机契约(平台机械执行,说了算)",
    "1. 阶段真相在平台:你能用哪些工具由当前阶段决定,越权调用会被直接拒绝。",
    `2. 当前阶段「${FIXED_STAGE_LABELS[scenario][current]}」:${brief.goal}。可用工具:${brief.tools}。`,
    "3. 平台闸:代码仓确认(拉取代码仓阶段缺仓时)、分析报告确认(有单)"
      + "/结论确认(无单)、网管环境配置(拉日志/换库缺环境时)、换库后"
      + "环境验证——平台举卡等用户,你不要替用户猜结果,举卡后立即结束回合。",
    "4. UT 全绿才能建 MR;MR 建后平台监看流水线,红了会带回失败项让你修,"
      + "同分支修复再推,直到全绿自动进入换库验证。",
    "5. 用户环境验证不通过会整体回退到「问题分析」重走(轮次+1),这是正常节奏不是事故。",
    "6. 秘密边界:环境密码与各 token 由平台保管,不向用户索要、不猜测、不讨论。",
    "7. 持续维护 issue-analysis.md(现象-根因-方案),它是本会话的核心交付物。",
    "",
    "现在开始:先复述你对问题现象的理解与当前阶段要做的事,然后推进。"
      + (scenario === "ticket" && current === "dts_info"
        ? "第一步固定是 dts_get_ticket 拉单据详情。" : ""),
  ].filter(Boolean).join("\n");
}

/** 固定流程的平台推进通知(continueWith 注入):带上下文的阶段交接词。 */
export function fixedAdvanceNotice(
  state: IssueSessionState,
  message: string,
): string {
  const scenario = state.scenario ?? "ticket";
  const current = state.stage as FixedStage;
  const brief = FIXED_STAGE_BRIEFS[current];
  return [
    `平台通知: ${message}`,
    `当前阶段「${FIXED_STAGE_LABELS[scenario][current]}」: ${brief.goal}`,
    `可用工具: ${brief.tools}`,
  ].join("\n");
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
    repoLines(state)
      || "- 代码仓: (未登记——需要读代码时请用户提供仓库地址,由用户在页面补充登记)",
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
    `- 最近阶段: ${stageLabelOf(state)}(${state.stage_note || "无说明"})`,
    state.push ? `- 已推送: ${state.push.branch} @ ${state.push.sha.slice(0, 12)}` : "",
    state.mr ? `- 已建 MR: ${state.mr.url}` : "",
    "",
    `用户的最新输入:\n\n${userText}`,
  ].filter(Boolean).join("\n");
}
