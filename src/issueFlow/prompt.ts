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
  module?: { id: string; name: string };
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

/** 元信息的模块行(模块是登记必选,但 DTS 发起/未绑定的会话还没有)。 */
function moduleLine(meta: IssueRegistrationMeta): string {
  return meta.module
    ? `- 业务模块: ${meta.module.name}(id: ${meta.module.id})`
    : "";
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

export function issueFixedOpeningPrompt(
  state: IssueSessionState,
  credentials: IssueEnvCredentials = {},
): string {
  const scenario = state.scenario ?? "ticket";
  const stages = fixedStages(scenario).map((stage) =>
    FIXED_STAGE_LABELS[scenario][stage]).join(" → ");
  const current = state.stage as FixedStage;
  const inheritedNote = state.converted_from
    ? `\n- 本会话由 ${state.converted_from} 转正而来:分析报告(issue-analysis.md)已继承,`
      + "前三个阶段视为已完成,直接从「问题修改」开始——先读报告再动手,不要重新分析。"
    : "";
  const meta = issueRegistrationMeta(state, credentials);
  return [
    "你是本问题会话的处理 Agent。本会话走**固定流程**:每阶段给目标与唯一"
      + "出口,活干到你判断达标就调出口动作自报收口,平台只在用户决策卡与 "
      + "MR 验绿处设卡。研究方法参考技能 issue-research/issue-ops,交付参考 issue-delivery。",
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
    `## 阶段路线(${scenario === "ticket" ? "有单七阶段" : "无单三节点"})`,
    stages,
    "",
    "## 阶段机契约(平台机械执行,说了算)",
    "1. 阶段真相在平台:你能用哪些工具由当前阶段决定,越权调用会被直接拒绝。",
    `2. 当前阶段「${FIXED_STAGE_LABELS[scenario][current]}」:${fixedStageSpec(current).goal}。`
      + `出口(到什么程度算完):${fixedStageSpec(current).exit}。可用工具:${stageToolLine(current)}。`,
    "3. 停机白名单——回合只允许停在这三处,其余情况必须继续调工具推进,"
    + "阶段性总结不是停机理由:①举卡等用户(AskUserQuestion 或平台闸);"
    + "②出口动作已调用、平台交接词已到位(含 MR 清单申报受理后停等流水线);"
    + "③确需用户补充信息或决策才能继续。违反会收到平台催办,把你推回阶段。",
    "4. 代码仓你自己拉(pull_repo):登记在册的仓也要你逐个调它落地——拉过才在场,"
      + "中途发现缺仓随时补。对哪些仓推送/提 MR 由你裁决:**改过的仓各自交付,一仓一 MR**。",
    "5. 平台闸:分析报告确认(有单)/结论确认(无单)、网管环境配置"
      + "(拉日志/换库缺环境时)、换库后环境验证——平台举卡等用户,你不要替"
      + "用户猜结果,举卡后立即结束回合。",
    "6. UT 跑完可自愿调 report_ut 如实上报——平台只记账,它不是出口、也不是"
      + "建 MR 的前置,UT 阶段出口仍是 complete_stage。提交 MR 阶段:每个改过的"
      + "仓 push_branch + create_mr 后,调 complete_stage 申报 MR 清单(mrs 参数),"
      + "平台验绿(清单=台账、流水线全绿)才放行进换库验证——有红当场打回带"
      + "失败项:修复后同分支再推、重建 MR、重新申报;在跑则受理,你可停等,"
      + "绿了平台自动放行;全绿未申报平台只会开回合提醒你申报,不会替你推进。",
    "7. 用户环境验证不通过会整体回退到「问题分析」重走(轮次+1),这是正常节奏不是事故。",
    "8. 秘密边界:平台凭据(Git 令牌、登录口令)由平台保管,不向用户索要、"
      + "不猜测、不讨论;网管环境的账号密码是现场公开的出厂默认值,已明文"
      + "写在登记元信息里(拿不准调 get_issue_meta 重查),用户问起直接回答。",
    "9. 持续维护 issue-analysis.md(现象-根因-方案),它是本会话的核心交付物。",
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
  return [
    `平台催办(第 ${attempt}/${budget} 次): 你在阶段未收口时结束了回合,`
    + "这不算完成——阶段真相在平台,没走到出口就是没完。",
    ...stageBriefLines(scenario, current),
    "继续推进。除非举卡等用户或确需用户决策,不要停机;"
      + `再无故停机 ${budget - attempt + 1} 次平台将不再催办,转为等你人工指令。`,
  ].join("\n");
}

export function issueOpeningPrompt(
  state: IssueSessionState,
  credentials: IssueEnvCredentials = {},
): string {
  const meta = issueRegistrationMeta(state, credentials);
  return [
    "你是本问题会话的研究与处理 Agent。工作方式见技能 issue-playbook(路线图)、"
      + "issue-research(研究方法)、issue-delivery(交付)、issue-ops(环境操作)。",
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
    "1. 阶段上报:每进入新环节调 report_stage——平台显示你正在干什么,全靠它。",
    "2. 人工闸门:对齐方案、部署后验证,必须 AskUserQuestion 停下等用户,绝不自作主张。",
    "3. 非问题是一等结论:研究判定非问题就出结论收口,不强制编码。",
    "4. 代码仓你自己拉(pull_repo)、自己管:改过的仓各自交付,一仓一 MR。",
    "5. 停机纪律:研究中途不要输出阶段性总结后停机——要么继续查证,"
      + "要么 AskUserQuestion 问,要么出结论(submit_analysis)。停机只属于"
      + "举卡、结论收口、确需用户决策三种情况。",
    "6. 秘密边界:平台凭据(Git 令牌、登录口令)由平台保管,不向用户索要、"
      + "不猜测、不讨论;网管环境的账号密码是现场公开的出厂默认值,已明文"
      + "写在登记元信息里(拿不准调 get_issue_meta 重查),用户问起直接回答。",
    "7. 结论文档持续维护 issue-analysis.md,它是本会话的核心交付物。",
    "",
    "现在开始:先复述你对问题现象的理解,给出研究计划(打算看什么、拉什么日志、"
    + "问用户什么),然后按计划推进。",
  ].join("\n");
}

/** 续聊提示词(重启/归档前的下一轮):锚定已有现场,不从头推翻。
 * 登记元信息随现场一并重给(服务重启后模型上下文是重建的,元信息
 * 不随对话流失——含网管环境明文,与开场词同一事实源)。 */
export function issueResumePrompt(
  state: IssueSessionState,
  userText: string,
  credentials: IssueEnvCredentials = {},
): string {
  const meta = issueRegistrationMeta(state, credentials);
  return [
    "服务重启/续聊后继续同一问题会话。已有现场(不要从头推翻,先读 "
      + "issue-analysis.md 与 skills/ 提示,再继续):",
    `- 标题: ${meta.title}`,
    `- 单号: ${state.ticket ?? "(未绑定)"}`,
    moduleLine(meta),
    ...environmentLines(meta),
    `- 最近阶段: ${stageLabelOf(state)}(${state.stage_note || "无说明"})`,
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
