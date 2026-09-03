/**
 * 问题会话的首轮提示词与 playbook 改编技能。
 *
 * 技能源头是仓内静态目录 assets/issue-skills/<name>/SKILL.md(标准
 * skill 目录形态),从 every-skill 仓的 playbook 改编而来,适配云上:
 * - 工号不再是 $HOME 目录名,而是平台注入的登录账号;
 * - 二进制/MCP 不由 Agent 直调,换成宿主工具(fetch_logs/build_deploy/
 *   push_branch/create_mr/dts_get_ticket/get_issue_meta);
 * - 新增"非问题出口":研究结论可以就是终点,不强制进编码交付。
 * 每次会话启动时从源目录整读、物化到工作区 skills/ 下(幂等重写)。
 * 技能文本与它引用的宿主工具同仓同版本演进——改工具就得同 commit
 * 改技能,评审看得见;想直接改文案就编辑 md 文件,不再碰 TS 字符串。
 *
 * 开场/通知/回执的提示词文案同理外置于 assets/issue-prompts/(ADR-0015),
 * 由 promptCopy 挂载取段;本文件保留的是结构与插值(事实块、阶段简报、
 * 措辞已全部搬走的条文不再在此)。
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
  type IssueScenario,
} from "./state.ts";
import { fixedStageSpec, stageBriefLines, stageToolLine } from "./stageRegistry.ts";
import { businessKnowledgeLines } from "./businessKnowledge.ts";
import { promptCopy } from "./promptCopy.ts";

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

// ---- 登记元信息(提示词块与 get_issue_meta 工具的同一事实源) ----

/** 网管环境从 vault 解出的明文凭据。ADR-0003 裁定:网管口令是现场
 * 公开的出厂默认值,允许进 AI 上下文——"密码不进上下文"的铁律只
 * 覆盖平台凭据(Git 令牌、登录口令);vault 落盘的卫生不变,解密只
 * 由持有 vault 的服务层做,这里只收解出的明文。解不出(闸未补配/
 * 凭据组缺席)按缺省,对应字段不出现。 */
export interface IssueEnvCredentials {
  /** 网管后台密码(sopuser/ossuser/ossadm 共用)。 */
  backend?: string;
  /** 网管页面密码。 */
  page?: string;
}

/** 登记元信息:手工登记时人填的输入全量(标题/现象/模块/带出仓/
 * 网管环境)。module/environment 只在会话真带这些信息时出现——
 * DTS 页签发起的会话环境闸还没补配,键整段缺席,不造空壳。 */
export interface IssueRegistrationMeta {
  title: string;
  description: string;
  module?: { id: string; name: string; locked?: boolean };
  repos: string[];
  environment?: {
    name: string;
    hosts: string[];
    page_account?: string;
    page_password?: string;
    backend_password?: string;
  };
}

/** 元信息组装单源:开场词/续聊词的渲染与 get_issue_meta 的返回都
 * 从这里出,工具与提示词永不各说各话。 */
export function issueRegistrationMeta(
  state: IssueSessionState,
  credentials: IssueEnvCredentials = {},
): IssueRegistrationMeta {
  const env = state.environment;
  return {
    title: state.title,
    description: state.description,
    ...(state.module_id
      ? { module: {
        id: state.module_id,
        name: state.module || state.module_id,
        ...(state.module_locked ? { locked: true } : {}),
      } }
      : {}),
    repos: state.repo_urls?.length
      ? [...state.repo_urls]
      : state.repo_url ? [state.repo_url] : [],
    ...(env
      ? { environment: {
        name: env.name,
        hosts: [...env.hosts],
        ...(env.page_account ? { page_account: env.page_account } : {}),
        ...(credentials.page ? { page_password: credentials.page } : {}),
        ...(credentials.backend
          ? { backend_password: credentials.backend }
          : {}),
      } }
      : {}),
  };
}

/** 元信息的网管环境段(开场词/续聊词用):四件套明文(ADR-0003),
 * 没有环境整段缺席——闸未补配的会话不渲染空壳。 */
function environmentLines(meta: IssueRegistrationMeta): string[] {
  const env = meta.environment;
  if (!env) return [];
  return [
    `- 网管环境「${env.name}」(网管口令是现场公开的出厂默认值,凭据`
      + "明文如下,用户问起直接回答):",
    `    - 服务器地址: ${env.hosts.join(", ")}`,
    ...(env.page_account ? [`    - 页面账号: ${env.page_account}`] : []),
    ...(env.page_password ? [`    - 页面密码: ${env.page_password}`] : []),
    ...(env.backend_password
      ? [`    - 网管后台密码(sopuser/ossuser/ossadm 共用): ${env.backend_password}`]
      : []),
  ];
}

/** 元信息的模块行(模块是登记必选,但 DTS 发起/未绑定的会话还没有)。
 * 人工预绑锁(spec #57):锁定时明确"不得改绑、直接拉仓",AI 的唯一
 * 出路是把不符报告给人。 */
function moduleLine(meta: IssueRegistrationMeta): string {
  if (!meta.module) return "";
  const base = `- 业务模块: ${meta.module.name}(id: ${meta.module.id})`;
  return meta.module.locked
    ? base + "\n  - 该模块由人工在发起时预绑并锁定:不要调用 bind_module,"
      + "直接对已登记仓逐个 pull_repo;若你判断模块与单据明显不符,"
      + "用 AskUserQuestion 告知用户,由人改绑或提供仓地址"
    : base;
}

/** 多仓清单块:全部平铺 repo/<仓名>/(2026-08-28 拍板:仓平等,无主从)。
 * 路径相对会话工作区(Agent 的 cwd 就是工作区根)。清单以可读的工作区
 * 路径开头——登记地址(尤其本地路径仓)只作"克隆自"注脚:本地路径与
 * 本机真实目录同名同在,放前面会被 Agent 当可读路径去撞工作区护栏
 * (实测 issue-24 踩坑)。克隆由 Agent 自己调 pull_repo 完成,所以这里
 * 如实标注每个仓"已克隆/待拉取"。空清单返回空串,由调用方给"未登记"
 * 文案。 */
function repoLines(state: IssueSessionState): string {
  const repos = issueRepoWorkspaces(state, "");
  if (!repos.length) return "";
  const lines = repos.map((repo) => {
    const cloned = existsSync(join(repo.dir, ".git"));
    const source = /^https?:\/\//i.test(repo.url)
      ? `克隆自 ${repo.url}`
      : `克隆自本地路径 ${repo.url}(那是工作区外的源,不可直接读,`
        + `读代码用 repo/<仓名>/ 下的相对路径)`;
    const rel = repo.dir.replace(/^[\\/]/, "");
    return `  - ${rel}/ —— ${cloned ? "已克隆,可读写" : "待拉取(调 pull_repo 拉它)"};${source}`;
  });
  return `- 代码仓(${repos.length} 个,一律平铺在 repo/ 下,读改均走工作区`
    + `相对路径):\n${lines.join("\n")}`;
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

// 阶段简报(引导层)从阶段注册表生成:目标/出口/可用工具都是注册表的
// 一行声明,与工具门禁(权威层)同源——这里不再手工复写工具清单,
// 引导层说能用的与权威层放行的不会漂移。渲染函数 stageBriefLines 也
// 住在注册表:开场词/交接词/催办词/工具回执共用同一份三行简报。

/** 必读 skill 清单行(ADR-0011,已封存——ADR-0014 起不再产生新台账):
 * 仅存量会话的 skill_selection 在场时随 analyze 简报注入,开场词与
 * 续聊词共用,重启重建的上下文同样看得见历史圈选结果。 */
export function skillSelectionLines(state: IssueSessionState): string[] {
  const skills = state.skill_selection?.skills ?? [];
  if (state.stage !== "analyze" || !skills.length) return [];
  return [
    "必读 skill(用户圈选,分析前先读;路径相对会话工作区):",
    ...skills.map((skill) =>
      `- ${skill.path}${skill.description ? ` — ${skill.description}` : ""}`),
  ];
}

export function issueFixedOpeningPrompt(
  state: IssueSessionState,
  credentials: IssueEnvCredentials = {},
  /** 月光免审批档的节奏渲染(现读现判):开=少问、不中间简报、
   * 报告会被自动确认;关=高把关,主动问与对齐(ADR-0006)。
   * workspace 供业务知识地图现扫仓内 docs/(ADR-0012);缺席不注入。 */
  options: { moonlight?: boolean; workspace?: string } = {},
): string {
  const scenario = state.scenario ?? "ticket";
  const stages = fixedStages(scenario).map((stage) =>
    FIXED_STAGE_LABELS[scenario][stage]).join(" → ");
  const current = state.stage as FixedStage;
  // 文案在 assets/issue-prompts/opening.md(ADR-0015);结构与插值留代码。
  const inheritedNote = state.converted_from
    ? "\n- " + promptCopy("opening", "fixed.inherited",
      { from: state.converted_from })
    : "";
  const meta = issueRegistrationMeta(state, credentials);
  const skillLines = skillSelectionLines(state);
  const knowledgeLines = options.workspace
    ? businessKnowledgeLines(state, options.workspace)
    : [];
  const contract = promptCopy("opening", "fixed.contract", {
    stage_brief:
      `当前阶段「${FIXED_STAGE_LABELS[scenario][current]}」:${fixedStageSpec(current).goal}。`
      + `出口(到什么程度算完):${fixedStageSpec(current).exit}。可用工具:${stageToolLine(current)}。`,
    skill_lines: skillLines.length ? skillLines.join("\n") + "\n" : "",
    knowledge_lines: knowledgeLines.length
      ? knowledgeLines.join("\n") + "\n" : "",
    intervention: promptCopy("opening", options.moonlight
      ? "fixed.intervention.moonlight"
      : "fixed.intervention.guard"),
  });
  return [
    promptCopy("opening", "fixed.header"),
    "",
    "## 问题事实",
    `- 标题: ${meta.title}`,
    `- 描述: ${meta.description || "(无补充描述)"}`,
    moduleLine(meta),
    `- 单号: ${state.ticket ?? "(无单号场景:测试/开发自行定位,结论后由用户决定挂起提单或闭环)"}`,
    `- 工号: ${state.account}`,
    repoLines(state)
      || "- 代码仓: (未登记——用 lookup_modules 检索业务模块带出仓,或 AskUserQuestion 问用户要地址,再 pull_repo 拉取)",
    ...(scenario === "ticket" && state.ticket
      ? [`- 修复分支 master_${state.account}_${state.ticket}:pull_repo 拉每个仓时由平台自动切好`]
      : []),
    ...environmentLines(meta),
    inheritedNote,
    "",
    `## 阶段路线(${scenario === "ticket" ? "有单五阶段" : "无单三节点"})`,
    stages,
    "",
    "## 阶段机契约(平台机械执行,说了算)",
    contract,
    "",
    promptCopy("opening", "fixed.kickoff")
      + (scenario === "ticket" && current === "dts_info"
        ? promptCopy("opening", "fixed.first_step") : ""),
  ].filter(Boolean).join("\n");
}

/** 固定流程的平台推进通知(continueWith 注入):带上下文的阶段交接词。 */
export function fixedAdvanceNotice(
  state: IssueSessionState,
  message: string,
): string {
  const scenario = state.scenario ?? "ticket";
  const current = state.stage as FixedStage;
  return [
    `平台通知: ${message}`,
    ...stageBriefLines(scenario, current),
  ].join("\n");
}

/** 催办续跑通知:模型在阶段未收口时提前收嘴,把阶段简报原样砸回去。 */
export function fixedNudgeNotice(
  state: IssueSessionState,
  attempt: number,
  budget: number,
): string {
  const scenario = state.scenario ?? "ticket";
  const current = state.stage as FixedStage;
  return promptCopy("notices", "nudge.body", {
    attempt,
    budget,
    stage_brief: stageBriefLines(scenario, current).join("\n"),
    remain: budget - attempt + 1,
  });
}

export function issueOpeningPrompt(
  state: IssueSessionState,
  credentials: IssueEnvCredentials = {},
): string {
  const meta = issueRegistrationMeta(state, credentials);
  return [
    promptCopy("opening", "free.header"),
    "",
    "## 问题事实",
    `- 标题: ${meta.title}`,
    `- 描述: ${meta.description || "(无补充描述)"}`,
    moduleLine(meta),
    `- 单号: ${state.ticket ?? "(尚未绑定——先研究后补单是正常形态;推送/提MR前必须请用户在页面绑定)"}`,
    `- 工号: ${state.account}`,
    repoLines(state)
      || "- 代码仓: (未登记——可 lookup_modules 按业务关键词检索模块带出仓,"
      + "或问用户要地址;要用的仓自己 pull_repo 拉取,拉过才在场)",
    ...environmentLines(meta),
    "",
    "## 行为契约",
    promptCopy("opening", "free.contract"),
    "",
    promptCopy("opening", "free.kickoff"),
  ].join("\n");
}

/** 续聊提示词(重启/归档前的下一轮):锚定已有现场,不从头推翻。
 * 登记元信息随现场一并重给(服务重启后模型上下文是重建的,元信息
 * 不随对话流失——含网管环境明文,与开场词同一事实源)。 */
export function issueResumePrompt(
  state: IssueSessionState,
  userText: string,
  credentials: IssueEnvCredentials = {},
  options: { moonlight?: boolean; workspace?: string } = {},
): string {
  const meta = issueRegistrationMeta(state, credentials);
  return [
    promptCopy("opening", "resume.header"),
    `- 标题: ${meta.title}`,
    `- 单号: ${state.ticket ?? "(未绑定)"}`,
    moduleLine(meta),
    ...environmentLines(meta),
    `- 最近阶段: ${stageLabelOf(state)}(${state.stage_note || "无说明"})`,
    ...skillSelectionLines(state),
    ...(options.workspace
      ? businessKnowledgeLines(state, options.workspace)
      : []),
    ...(state.mode === "fixed"
      ? [promptCopy("opening", options.moonlight
        ? "resume.intervention.moonlight"
        : "resume.intervention.guard")]
      : []),
    state.pushes?.length
      ? `- 已推送: ${state.pushes.map((push) =>
          `${push.branch} @ ${push.sha.slice(0, 12)}`).join(";")}` : "",
    state.mrs?.length
      ? `- 已建 MR: ${state.mrs.map((mr) =>
          mr.url ?? mr.title).join(";")}` : "",
    "",
    `用户的最新输入:\n\n${userText}`,
  ].filter(Boolean).join("\n");
}
