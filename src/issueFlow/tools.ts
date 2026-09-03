/**
 * 问题会话的宿主工具集(递给 Agent 的平台原子能力)。
 *
 * 设计立场:平台凭据(git/MCP token)止步于宿主,Agent 只拿到工具
 * 语义与结果文本;网管环境口令是例外——ADR-0003 裁定它是现场公开的
 * 出厂默认值,随登记元信息明文进上下文(get_issue_meta),vault 落盘
 * 的卫生不变。"提 MR 前必须有单号"在这里是机械门禁——
 * push_branch / create_mr 查不到绑定单号直接拒绝,提示词管不住的
 * 侥幸在工具层过不去。
 *
 * 固定流程(2026-08-27 拍板)在工具层叠加两件事:
 * - 阶段门禁:每个工具只在所属阶段开放,越权调用直接拒绝(双层
 *   门禁的权威层;提示词里的"本阶段工具清单"是引导层,两层的白名单
 *   同出阶段注册表 stageRegistry.ts,不会各说各话)。例外是
 *   工读类——fetch_logs 全程开放,dts_get_ticket 任意阶段可重查
 *   (2026-08-28 拍板:作业自由,门只守流程出口与出厂动作);
 * - 阶段推进(2026-08-28 目标驱动自报):四个阶段(拉单/拉仓/修改/
 *   提交MR)的出口是 complete_stage 自报收口,平台不核实 AI 的
 *   工作事实,只在提交 MR 阶段程序化验 MR 验绿门(清单=台账+流水线
 *   全绿);三个举卡阶段卡工具即出口,人工闸(报告确认/结论/环境
 *   验证)由工具举闸——raiseGate 写进 issue.json,Agent 对它只读,
 *   推不动。UT 属于问题修复阶段(TDD:先写复现单测再改码转绿),
 *   report_ut 是修复过程中的事实上报(只记账)。
 *
 * 自由探索模式保持原有工具集(report_stage + 五工具)零改动。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  ISSUE_STAGES,
  STAGE_LABELS,
  FIXED_STAGE_LABELS,
  fixedAdvance,
  fixedComplete,
  fixedStages,
  issueRepoWorkspaces,
  normalizeIssueRepos,
  raiseGate,
  recordTransition,
  validStage,
  type FixedStage,
  type IssueGateScope,
  type IssueSessionState,
} from "./state.ts";
import {
  stageAllowsTool,
  stagesAllowingTool,
  stageBriefLines,
} from "./stageRegistry.ts";
import {
  describePipelineRun,
  getPipelineStatus,
  type PipelineRun,
} from "../pipelineClient.ts";
import { readBusinessModule, listBusinessModules } from "../businessModuleLibrary.ts";
import type { IssueOpsTools } from "./opsTools.ts";
import type { DtsGateway } from "./gateways.ts";
import {
  applyTicketImageRewrites,
  renderTicketImageNote,
  syncTicketImages,
} from "./ticketImages.ts";
import { issueRegistrationMeta } from "./prompt.ts";
import {
  currentBranch,
  currentHead,
  dirtyWorktree,
  pushChangeSummary,
  pushFromIssueWorkspace,
  type GitCredential,
} from "./issueGit.ts";
import { createMergeRequest } from "../mrClient.ts";

export interface IssueToolContext {
  /** 活状态引用(服务持有,工具直接读)。 */
  state: IssueSessionState;
  /** 会话工作区根(session cwd)。 */
  workspace: string;
  /** 数据目录(凭据沙箱运行区挂这里,不进工作区)。 */
  dataRoot: string;
  /** 状态变更的持久化钩子(服务保证落盘)。 */
  persist(): void;
  ops?: IssueOpsTools;
  dts?: DtsGateway;
  /** 交付平台适配层地址(--platform);MR 创建走公共 mrClient。 */
  platformUrl?: string;
  /** 宿主侧解密后的环境密码;未配置环境时为 undefined。 */
  environmentPassword?(): string | undefined;
  /** 宿主侧解密后的网管页面密码(登记元信息用,ADR-0003 允许进
   * 上下文);环境未配页面凭据(如 env_needed 闸补配)时为 undefined。 */
  pagePassword?(): string | undefined;
  gitCredential?(): GitCredential | undefined;
  /** 推送前过目(个人设置的交付轴,ADR-0009,现读现判):开着时
   * push_branch 没有一次性确认令牌即拒绝并举 push_confirm 闸。回调
   * 缺席=直推(裸构造兼容缺省,与 moonlight「回调缺席按关闭」同一
   * 纪律;正式接线在 serve 层的 auth.pushConfirmationEnabled)。 */
  pushConfirmation?: () => boolean;
  /** 月光现值(个人设置的过程轴,ADR-0006,现读现判):回调
   * 缺席按关闭。 */
  moonlight?: () => boolean;
  /** skill 圈选闸已封存(ADR-0014):complete_stage 推进进 analyze 时
   * 调用,现在只做扫描留痕(发现清单进转移账),恒返回 false。回调
   * 名保留——存量挂起的圈选卡作答口径不变。 */
  raiseSkillSelection?: () => boolean;
  /** 业务知识资产定格(ADR-0012):推进进 analyze 时调用,按绑定模块
   * 从资产库定格并落台账;不分介入档,缺席/失败静默。返回是否定格到
   * 了资产。 */
  freezeBusinessKnowledge?: () => boolean;
  /** 业务知识地图(ADR-0012):analyze 简报的注入段(台账资产+仓内
   * docs/ 现扫);两源皆空为空串。 */
  businessKnowledgeBrief?: () => string;
  /** 拉仓(2026-08-28 拍板:克隆是 Agent 的工具,不是平台自动动作)。
   * 宿主实现:登记合并 → 带凭据克隆到 repo/<仓名>/ →(有单场景)
   * 尽力建修复分支。回执只含事实,凭据永不进结果。remoteBranch 非空
   * = 远端已有同名修复分支且与本地分叉(同单重跑的上次遗留)。 */
  pullRepo(url: string): Promise<{
    dir: string;
    cloned: boolean;
    branch?: string;
    head: string;
    baselineMiss?: string;
    remoteBranch?: string;
  }>;
  /** 固定流程:create_mr 成功后由服务启动流水线监看(触发+轮询)。 */
  onMrCreated?(repo: string): void;
  /** mr_green 即时收口的用户通知(complete_stage 验绿当场全绿/空清单
   * 时调;监看器滞后收口的通知在 service 侧,不经这里)。 */
  notifyMrGreen?(): void;
  log?: (message: string) => void;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function fail(text: string): never {
  throw new Error(text);
}

export function expectedBranch(state: IssueSessionState): string {
  return `master_${state.account}_${state.ticket}`;
}

/** 缺网管环境时的平台闸(拉日志/换库现场补配,2026-08-28):举闸后
 * 工具如实失败,让模型结束回合——不再让 AI 空口向用户要密码
 * (秘密纪律:密码只走 /environment 表单进 vault,不进对话)。 */
function raiseEnvNeededGate(
  ctx: IssueToolContext,
  scope: IssueGateScope,
): never {
  raiseGate(
    ctx.state,
    "env_needed",
    "获取日志/换库需要网管服务器地址与密码",
    undefined,
    undefined,
    scope,
  );
  ctx.persist();
  fail("已向用户发起网管环境配置请求,等待填写"
    + "(用户在问题卡提交后,平台会通知你重试刚才的操作)");
}

/** 分析报告的既定落点(prompt 行为契约要求 Agent 维护它,闸门以它
 * 为门票——报告不在场就举闸等于让用户对着空气确认)。 */
function analysisReportPath(ctx: IssueToolContext): string {
  return join(ctx.workspace, "issue-analysis.md");
}

/** 分析报告五章节(CONTEXT.md「分析报告」词条,模板在技能
 * issue-analysis):submit_analysis 的门票从"文件在场"升级为"章节
 * 齐全"——结论必附证据是分析质量的最后防线,提示词管不住的侥幸在
 * 工具层过不去。章节按标题行匹配(1~4 级),内容长短不管:轻量
 * 路径的报告照样五章节齐全,只是每节更短。首行是一句话总结(现象→
 * 根因→方案串联),不是章节。(2026-09-03 重构:现象-根因-方案
 * 三段式解禁,下一步建议并入修改方案——从可选建议升格为 fix 阶段
 * 的执行承诺。) */
export const ANALYSIS_REPORT_SECTIONS = [
  "问题现象", "问题根因", "修改方案", "证据链", "置信度",
] as const;

export function missingAnalysisSections(content: string): string[] {
  return ANALYSIS_REPORT_SECTIONS.filter((section) =>
    !new RegExp(`^#{1,4}\\s*${section}`, "m").test(content));
}

export function createIssueTools(ctx: IssueToolContext): unknown[] {
  const tools: unknown[] = [];
  const state = ctx.state;
  const fixed = state.mode === "fixed";
  const scenario = state.scenario;

  /** 会话仓定位:repo 参数(缺省首个登记仓)→ 克隆目录 + 权威地址。
   * 多仓会话全部平铺在 repo/<仓名>/(2026-08-28:仓平等,无主从);
   * 地址比对忽略 .git 后缀,没登记过的仓一律打回。 */
  const locateRepo = (requested: string | undefined): { url: string; dir: string } => {
    const repos = issueRepoWorkspaces(state, ctx.workspace);
    if (!repos.length) fail("会话没有登记代码仓地址");
    const wanted = requested?.trim();
    if (!wanted) return repos[0];
    const match = repos.find((repo) =>
      repo.url === wanted
      || repo.url.replace(/\.git$/i, "") === wanted.replace(/\.git$/i, ""));
    if (!match) {
      fail(`会话没有登记这个代码仓: ${wanted}。`
        + `已登记: ${repos.map((repo) => repo.url).join(", ")}`);
    }
    return match;
  };

  // ---- 阶段门禁(固定流程专属;自由模式直接放行) ----
  // 白名单查阶段注册表:每个阶段在注册表里声明自己开放哪些工具,
  // 简报(引导层)读同一列——这里不再各自硬编码,越权拒绝时反查
  // 注册表报出"允许的阶段"。

  const stageLabel = (): string =>
    scenario ? FIXED_STAGE_LABELS[scenario][state.stage as FixedStage] ?? String(state.stage)
      : STAGE_LABELS[state.stage as keyof typeof STAGE_LABELS] ?? String(state.stage);

  const gateStage = (tool: string): void => {
    if (!fixed || !scenario) return;
    // 存量 skill 圈选闸在场(ADR-0011 举起的历史卡;ADR-0014 起新卡
    // 永不举):先等用户答完再干活。守卫放在所有阶段门禁之前——闸
    // 举起后回执已叫 Agent 停回合,它若继续调平台工具,这里机械拦下。
    if (state.gate?.kind === "skill_select") {
      fail("skill 圈选卡正等用户作答(圈选必读的仓内排障知识)。"
        + "请立即结束本回合,用户圈选后平台会带着必读集合开新一轮");
    }
    if (stageAllowsTool(scenario, state.stage as FixedStage, tool)) return;
    const allowed = stagesAllowingTool(scenario, tool)
      .map((stage) => FIXED_STAGE_LABELS[scenario][stage]);
    fail(`阶段门禁:${tool} 在当前阶段「${stageLabel()}」不开放。`
      + `允许的阶段:${allowed.length ? allowed.join(" / ") : "无(本场景流程不含该工具)"}`
      + `。固定流程按阶段出口推进,请先完成本阶段工作`);
  };

  // ---- 自由探索:阶段自报工具(fixed 模式不注册——阶段真相在宿主) ----

  if (!fixed) {
    tools.push(defineTool({
      name: "report_stage",
      label: "Report Stage",
      description:
        "向平台上报当前处理阶段——状态条全靠它,每进入新环节调用一次,"
        + "note 用一句话说明现场。阶段含义:fetch_detail=获取 DTS 详情"
        + "(仅绑定了单号才有)/ align_issue=与用户对齐问题现象"
        + "/ locate_root=分析根因 / align_solution=对齐修复方案"
        + "/ modify_code=实施修改 / switch_db=换库 / verify=验证"
        + "/ submit_mr=提交 MR / done=问题闭环=已给出结论,界面显示「问题闭环」(非问题也走它)。"
        + "阶段可跳过、可回退:用户推翻结论继续查,就从 done 切回去。"
        + "done 只是'AI 已出结论',正式收口由用户归档,两者不是一回事。"
        + `合法阶段: ${ISSUE_STAGES.join(" / ")}`,
      parameters: Type.Object({
        stage: Type.Union(ISSUE_STAGES.map((stage) => Type.Literal(stage)), {
          description: "当前阶段",
        }),
        note: Type.String({ description: "一句话现场说明(做了什么/发现了什么)" }),
      }),
      async execute(_toolCallId: string, params: any) {
        if (!validStage(String(params.stage))) {
          fail(`非法阶段: ${params.stage}。合法值: ${ISSUE_STAGES.join(" / ")}`);
        }
        ctx.state.stage = params.stage;
        ctx.state.stage_note = String(params.note ?? "");
        ctx.state.stage_at = new Date().toISOString();
        recordTransition(ctx.state, {
          source: "agent", stage: params.stage, note: String(params.note ?? ""),
        });
        ctx.persist();
        return ok(`阶段已更新为 ${STAGE_LABELS[params.stage as keyof typeof STAGE_LABELS]}:${params.note}`);
      },
    }));
  }

  // ---- 运维:拉日志(两模式共用;fixed 自问题分析阶段起开放,含回退轮) ----

  tools.push(defineTool({
    name: "fetch_logs",
    label: "Fetch Logs",
    description:
      "从网管服务器抓取服务业务日志到工作区 local-logs/ 目录(完整目录结构,"
      + "之后可直接 grep/读文件)。hosts 缺省用会话配置的网管环境。"
      + "密码由平台自动带入,不需要你提供。",
    parameters: Type.Object({
      services: Type.Array(Type.String(), {
        description: "服务名列表(如 TranFmaWebsite),抓 /var/log/oss/MAE/<服务名> 全部内容",
      }),
      hosts: Type.Optional(Type.Array(Type.String(), {
        description: "网管服务器 IP(可多台串行抓取);缺省用会话环境配置",
      })),
    }),
    async execute(_toolCallId: string, params: any) {
      if (!ctx.ops) fail("宿主未部署运维工具(assets/ops-tools),无法拉日志");
      const password = ctx.environmentPassword?.();
      if (!password) raiseEnvNeededGate(ctx, "logs");
      const hosts = (params.hosts as string[] | undefined)?.length
        ? params.hosts as string[]
        : ctx.state.environment?.hosts ?? [];
      const localDir = join(ctx.workspace, "local-logs");
      const result = await ctx.ops.fetchLogs({
        hosts,
        services: params.services as string[],
        password,
        localDir,
      });
      recordTransition(ctx.state, {
        source: "platform",
        note: `日志已拉取:${result.summary.split("\n")[0]}`,
      });
      ctx.persist();
      return ok(result.summary);
    },
  }));

  // ---- 业务模块库检索(两模式共用;fixed 限拉取代码仓/问题分析阶段) ----
  // 把"问题单 → 业务模块 → 代码仓"的映射交给 Agent 现场查证:模块库
  // 是宿主数据目录里的显式发布实体,工具只读目录、只回 id/名称/仓清单,
  // 永不携带任何凭据。

  tools.push(defineTool({
    name: "lookup_modules",
    label: "Look Up Business Modules",
    description:
      "按关键词检索业务模块库(模块名称/ID/说明包含即命中,大小写不敏感),"
      + "返回命中的模块 ID、名称与绑定的代码仓清单。用于把问题单映射到业务模块:"
      + "先检索,命中后(fixed 流程)用 bind_module 绑定;检索不到就如实告知并"
      + "用 AskUserQuestion 问用户。",
    parameters: Type.Object({
      keyword: Type.String({
        description: "检索词:模块名称/ID/说明的子串(如「媒体」「pay」)",
      }),
    }),
    async execute(_toolCallId: string, params: any) {
      gateStage("lookup_modules");
      const keyword = String(params.keyword ?? "").trim().toLowerCase();
      if (!keyword) fail("keyword 不能为空:给一个模块名称/ID/说明的子串");
      const { modules } = listBusinessModules(ctx.dataRoot);
      const hits = modules.filter((module) =>
        module.status === "active"
        && (module.name.toLowerCase().includes(keyword)
          || module.id.toLowerCase().includes(keyword)
          || module.description.toLowerCase().includes(keyword)));
      if (!hits.length) return ok("无匹配业务模块");
      const lines = hits.map((module) => `- ${module.name}(id: ${module.id});`
        + `代码仓 ${module.repositories.length} 个${module.repositories.length
          ? `:\n    ${module.repositories.join("\n    ")}`
          : "(该模块未绑定代码仓)"}`);
      return ok(`命中 ${hits.length} 个业务模块:\n${lines.join("\n")}`
        + (fixed ? "\n\n要绑定其中某个模块请调用 bind_module(带模块 id)。"
          : "(自由探索模式仅供参考,不提供绑定)"));
    },
  }));

  // ---- 拉仓(两模式共用;2026-08-28 拍板:克隆是 Agent 的显式工具动作) ----

  tools.push(defineTool({
    name: "pull_repo",
    label: "Pull Repository",
    description:
      "把一个代码仓加入会话并克隆到 repo/<仓名>/(宿主带凭据执行,你只见"
      + "结果事实)。幂等:已克隆的仓直接回报。有单场景顺带尝试创建修复分支 "
      + "master_<工号>_<单号>(基线分支不存在时不建,如实回报由你裁决)。"
      + "发现缺仓就调它:lookup_modules 带出的仓、用户给的地址都经它落地。",
    parameters: Type.Object({
      url: Type.String({
        description: "代码仓地址(https 或本地路径);已在会话里的仓幂等回报",
      }),
    }),
    async execute(_toolCallId: string, params: any) {
      gateStage("pull_repo");
      const url = String(params.url ?? "").trim();
      if (!url) fail("url 不能为空:给要拉取的代码仓地址");
      const facts = await ctx.pullRepo(url);
      recordTransition(state, {
        source: "platform",
        note: `代码仓已拉取: ${facts.dir}${facts.cloned ? "(新克隆)" : "(已在场)"}`
          + `${facts.branch ? `,分支 ${facts.branch}` : ""}`
          + `${facts.remoteBranch
            ? `——⚠ 远端同名修复分支遗留@${facts.remoteBranch}(与本地分叉)`
            : ""}`,
      });
      ctx.persist();
      const baselineNote = facts.baselineMiss
        ? `\n注意: 该仓没有基线分支 ${facts.baselineMiss},修复分支未创建、`
          + "停在其默认分支——请核实基线是否正确,拿不准就用 AskUserQuestion 问用户。"
        : "";
      // 拉仓只落地,不再机械推进(2026-08-28 拍板:出口=complete_stage
      // 自报)。拉取阶段的回执带注册表简报指引:还有仓继续拉,拉齐了
      // complete_stage 收口;其余阶段的补仓只回事实,不催收口。
      const guide = fixed && scenario && state.stage === "prep_repo"
        ? "\n\n拉仓指引:还有要用的仓继续调 pull_repo;都拉齐了就调 "
          + "complete_stage 收口本阶段。\n"
          + stageBriefLines(scenario, "prep_repo").join("\n")
        : "";
      return ok(`代码仓就绪:\n- 工作区目录: ${facts.dir}\n`
        + `- HEAD: ${facts.head.slice(0, 12)}`
        + `${facts.branch ? `\n- 修复分支: ${facts.branch}(已切好)` : ""}`
        + `${facts.remoteBranch
          ? `\n- 遗留警报: 远端已存在同名修复分支 ${facts.branch}@${facts.remoteBranch},`
            + "与本地(从基线另起)分叉——疑似上次运行停止/取消前推送的遗留。"
            + "放着不管 push_branch 会被拒(非快进)。请用 AskUserQuestion "
            + "请用户拍板处置:在代码平台删除远端旧分支后重推,还是沿用旧分支。"
          : ""}`
        + `${baselineNote}${guide}`);
    },
  }));

  // ---- 运维:换库部署(2026-09-02 封存,ADR-0013:换库验证阶段下线,
  // 无阶段开放本工具,调用一律被阶段门禁拒绝;执行体与闸举升代码原地
  // 保留——重启换库时在注册表加回阶段行即可,见 ADR-0013) ----

  tools.push(defineTool({
    name: "build_deploy",
    label: "Build And Deploy",
    description:
      "(暂未启用:当前流程不含换库部署,调用会被拒绝)"
      + "把工作区代码仓(含 deployment/pom.xml)构建并部署到网管服务器,"
      + "自动备份当前版本。多仓会话用 repo 参数指定要部署的仓(缺省首个"
      + "登记仓)。仅页面/前后端改动不要加 include_lib;"
      + "仅当 pom.xml 依赖版本变更时才加。部署后平台会举验证卡,"
      + "必须停下等用户在真实环境验证。",
    parameters: Type.Object({
      repo: Type.Optional(Type.String({
        description: "要部署的代码仓地址;缺省首个登记仓(多仓时按需指定)",
      })),
      hosts: Type.Optional(Type.Array(Type.String(), {
        description: "目标服务器 IP(可多台);缺省用会话环境配置",
      })),
      include_lib: Type.Boolean({
        description: "同时更新 lib 目录;仅 pom.xml 依赖版本变更时为 true",
      }),
    }),
    async execute(_toolCallId: string, params: any) {
      gateStage("build_deploy");
      if (!ctx.ops) fail("宿主未部署运维工具(assets/ops-tools),无法换库");
      const password = ctx.environmentPassword?.();
      if (!password) raiseEnvNeededGate(ctx, "deploy");
      const repoDir = locateRepo(params.repo).dir;
      if (!existsSync(join(repoDir, ".git"))) fail("代码克隆不存在,无法部署(先 pull_repo)");
      const hosts = (params.hosts as string[] | undefined)?.length
        ? params.hosts as string[]
        : ctx.state.environment?.hosts ?? [];
      const result = await ctx.ops.buildDeploy({
        projectPath: repoDir,
        hosts,
        password,
        includeLib: Boolean(params.include_lib),
      });
      recordTransition(ctx.state, {
        source: "platform",
        note: `换库部署完成:${result.summary.split("\n")[0]}`,
      });
      if (fixed) {
        raiseGate(
          ctx.state,
          "env_verify",
          "换库部署已完成,请在目标环境验证问题是否修复",
          undefined,
          result.summary.split("\n")[0],
        );
        ctx.persist();
        return ok(result.summary
          + "\n平台已举出验证卡,请结束本回合等待用户验证结果——不要自行继续。");
      }
      ctx.persist();
      return ok(result.summary
        + "\n部署完成——请用 AskUserQuestion 请用户在环境上验证,等结果再继续。");
    },
  }));

  // ---- DTS 查单(工读类:任意阶段可重查;首查回执带注册表简报) ----

  tools.push(defineTool({
    name: "dts_get_ticket",
    label: "Get DTS Ticket",
    description:
      "按单号查 DTS 问题单详情(现象/影响/处理历史)。单号缺省用会话已"
      + "绑定的单号。任意阶段都可调用(重查单据不限阶段);在「获取单据"
      + "信息」阶段拉到详情后,通读单据调 complete_stage 收口进入拉取"
      + "代码仓。注意:绑定单号是用户动作——查到的单号要用于推送/提MR,"
      + "需请用户在页面完成绑定。",
    parameters: Type.Object({
      ticket: Type.Optional(Type.String({ description: "DTS 问题单号;缺省用会话绑定单号" })),
    }),
    async execute(_toolCallId: string, params: any) {
      if (!ctx.dts) fail("DTS 网关未配置,无法查单(部署需 --dts-mcp-url)");
      const ticket = String(params.ticket ?? "").trim() || ctx.state.ticket;
      if (!ticket) fail("没有单号:请提供 ticket 参数,或请用户先绑定单号");
      const detail = await ctx.dts.detail(ticket);
      // 内嵌截图落工作区(#42):描述里的 <img> 下载到 ticket-images/
      // 并把 AI 可见文本里的 URL 改写为工作区相对路径,随后可对本地
      // 路径调 inspect_image 识图。fail-open:下载是旁路,单图失败/
      // 超时/超限只标注缺失,详情照常返回,绝不因此堵住查单。
      let contentText = detail.content;
      let imageNote = "";
      const description = detail.description ?? detail.content;
      if (/<img\s[^>]*?src="/i.test(description)) {
        try {
          const outcome = await syncTicketImages({
            description,
            ticket: detail.ticket,
            workspace: ctx.workspace,
            gateway: ctx.dts,
            log: ctx.log,
          });
          contentText = applyTicketImageRewrites(contentText, outcome.downloads);
          imageNote = renderTicketImageNote(outcome);
        } catch (error) {
          const reason = String(error instanceof Error ? error.message : error);
          imageNote = `[内嵌图] 下载环节异常,本次未处理(详情照常): ${reason}`;
          ctx.log?.(`[issue-tools] 内嵌图处理失败(${detail.ticket}): ${reason}`);
        }
      }
      recordTransition(ctx.state, {
        source: "platform",
        note: `DTS 单 ${detail.ticket} 详情已获取`,
      });
      ctx.persist();
      // 首查不再机械推进:回执带注册表生成的下一阶段简报(交接文案与
      // 门禁同源),告知"读完单据 complete_stage 收口"。单据自带的业务
      // 关键词(特性/模块)附在简报前,帮 lookup_modules 精准匹配。
      const moduleHint = detail.featureName || detail.moduleName
        ? `\n\n业务信息:特性=${detail.featureName ?? "无"}`
          + `,模块=${detail.moduleName ?? "无"}`
          + "——请用这些关键词调 lookup_modules 检索业务模块"
        : "";
      const briefing = fixed && scenario && state.stage === "dts_info"
        ? "\n\n单据详情已获取——通读单据后调 complete_stage 收口本阶段,"
          + "进入拉取代码仓:\n"
          + stageBriefLines(scenario, "prep_repo").join("\n")
        : "";
      return ok(`问题单 ${detail.ticket} 详情:\n${contentText}`
        + (imageNote ? `\n\n${imageNote}` : "")
        + `${moduleHint}${briefing}`);
    },
  }));

  // ---- 登记元信息(工读类:任意阶段可查;与 dts_get_ticket 分工) ----
  // 人手工登记的输入全量(标题/现象/模块/仓/网管环境四件套),与提示词
  // 的元信息块同出 issueRegistrationMeta 一源;网管口令按 ADR-0003 明文
  // 返回。只读:不碰状态、不落盘、不推进阶段。

  tools.push(defineTool({
    name: "get_issue_meta",
    label: "Get Issue Meta",
    description:
      "获取本会话的登记元信息——手工登记时**人填的输入**全量:标题、现象"
      + "描述、业务模块、带出的代码仓、网管环境(地址/页面账号/页面密码/"
      + "网管后台密码,现场公开默认值,明文返回)。只读且不改任何状态;"
      + "任意阶段都可调用,长会话里随时重查,不必翻找历史上下文。与 "
      + "dts_get_ticket 的分工:登记元信息是人填的输入,查它用本工具;"
      + "按单号拉 DTS 单据详情(平台拉的)用 dts_get_ticket,两者不可混用。",
    parameters: Type.Object({}),
    async execute() {
      const meta = issueRegistrationMeta(state, {
        backend: ctx.environmentPassword?.(),
        page: ctx.pagePassword?.(),
      });
      return ok(JSON.stringify(meta, null, 2));
    },
  }));

  // ---- 推送(fixed 自问题修改阶段起;机械单号门禁两模式同在) ----

  tools.push(defineTool({
    name: "push_branch",
    label: "Push Branch (Host)",
    description:
      "把当前修复分支经宿主推送到远端(git push 在容器里是禁用的,必须走"
      + "本工具)。机械门禁:会话必须已绑定单号,分支名必须是 "
      + "master_<工号>_<单号>,且工作区不能有未提交改动(push 只推已提交"
      + "的历史——改完先 git add -A && git commit 再推)。推送前 UT 纪律:"
      + "调用本工具之前,先在该仓把单元测试完整跑一遍(按仓的实际构建"
      + "体系选回归命令,如 mvn test、npm test):改动相关用例必跑,时间"
      + "允许就跑全量回归;跑过的用例全绿才推,有挂测继续修,"
      + "不许跳过测试直接推。推送后返回 SHA。",
    parameters: Type.Object({
      branch: Type.Optional(Type.String({
        description: "要推送的分支;缺省取代码仓当前分支",
      })),
      repo: Type.Optional(Type.String({
        description:
          "目标代码仓地址;缺省首个登记仓。必须是会话登记过的仓"
          + "(多仓分析时其余关联仓也能推,分支命名规则不变)",
      })),
    }),
    async execute(_toolCallId: string, params: any) {
      gateStage("push_branch");
      const state = ctx.state;
      if (!state.ticket) {
        fail("单号门禁:会话尚未绑定 DTS 单号。请请用户在页面「绑定单号」后重试"
          + "——推送与提 MR 都以单号为门票");
      }
      const repo = locateRepo(params.repo);
      if (!existsSync(join(repo.dir, ".git"))) fail("代码克隆不存在,无法推送(先 pull_repo)");
      const branch = String(params.branch ?? "").trim()
        || await currentBranch(repo.dir);
      if (!branch) fail("没有可推送的分支(缺 branch 参数且当前不在分支上)");
      const expected = expectedBranch(state);
      if (branch !== expected) {
        fail(`分支名不符合交付规则: 应为 ${expected},实际 ${branch}。`
          + "修复分支命名固定为 master_<工号>_<单号>");
      }
      // 脏工作区熔断(2026-08-28 真实环境事故):AI 改了文件没 commit,
      // push 推的是 clone 时的旧 HEAD,MR 没有 diff。与其让空 MR 静默
      // 出厂,不如在这里点破并给出该做的事。
      const dirty = await dirtyWorktree(repo.dir);
      if (dirty.length) {
        fail("工作区有未提交改动,push 只推送已提交的历史——现在推只会"
          + `推出旧提交(MR 将没有 diff)。先提交再重推:\n`
          + `  git add -A && git commit -m "[${state.ticket}] <改动说明>"\n`
          + `未提交的文件(${dirty.length} 条):\n`
          + dirty.slice(0, 10).map((line) => `  ${line}`).join("\n")
          + (dirty.length > 10 ? `\n  …共 ${dirty.length} 条` : ""));
      }
      // 推送前过目闸(ADR-0009,交付轴):现读现判个人设置——关/回调
      // 缺席=直推(现状不变);开着就要有有效的一次性确认令牌才碰
      // git push,否则举起 push_confirm 闸(卡带服务端现查仓库生成的
      // 变更摘要,不靠 Agent 自报)并拒收。与阶段门禁(gateStage)正交:
      // 那道门管"什么阶段能推",这道管"推之前给不给人过目";固定与
      // 自由两模式同过。拒绝与 raiseEnvNeededGate 同款收口:工具如实
      // 失败让模型结束回合,waiting_user 由 settle 在回合终点定格。
      // 令牌绑定过目那一刻的分支 tip(push_review_head→push_token.head):
      // 确认之后又有新提交,重推对不上 tip 即作废重举——人看过的是
      // 哪份变更,放行的就是哪份,防盲签才是完整的。
      const raisePushReviewGate = async (why: string) => {
        const summary = await pushChangeSummary({
          repoDir: repo.dir,
          ...(state.baseline ? { baseline: state.baseline } : {}),
        });
        const head = await currentHead(repo.dir);
        if (head) state.push_review_head = head;
        else delete state.push_review_head;
        raiseGate(
          ctx.state,
          "push_confirm",
          `推送前过目:${why}以下变更将推送到远端,请过目后确认`,
          undefined,
          summary,
        );
        ctx.persist();
        fail(`${why ? why.replace(/,$/, "") + "——已重新举出推送确认卡" :
          "已向用户举出推送确认卡"}(带本次变更摘要),git push 未执行。`
          + "请结束本回合等待用户过目——确认后平台会通知你重新推送本分支;"
          + "若用户答「暂不推送」,请按其意见调整后再来征求确认");
      };
      if (ctx.pushConfirmation?.() === true) {
        if (!state.push_token) {
          await raisePushReviewGate("");
        } else {
          const head = await currentHead(repo.dir);
          if (state.push_token.head && head
            && head !== state.push_token.head) {
            delete state.push_token;
            await raisePushReviewGate("分支在过目后又有新提交,");
          }
        }
      }
      const receipt = await pushFromIssueWorkspace({
        dataDir: ctx.dataRoot,
        repoDir: repo.dir,
        repoUrl: repo.url,
        branch,
        credential: ctx.gitCredential?.(),
      });
      // 令牌一次性(ADR-0009):成功即消费,下次推送重新过目(防盲签
      // ——变更变了就要再看)。留痕进转移账,盘上不留已消费的令牌。
      const reviewed = Boolean(state.push_token);
      delete state.push_token;
      // 按仓记账(一仓一分支):重推同仓覆盖旧账,不同仓各记各的。
      const pushes = state.pushes ??= [];
      const record = {
        repo: repo.url, branch: receipt.branch,
        sha: receipt.sha, at: new Date().toISOString(),
      };
      const slot = pushes.findIndex((item) => item.repo === repo.url);
      if (slot >= 0) pushes[slot] = record; else pushes.push(record);
      recordTransition(state, {
        source: "platform",
        note: `分支已推送 ${repo.url} ${receipt.branch} @ ${receipt.sha.slice(0, 12)}`
          + (reviewed ? "(推送过目令牌已消费)" : ""),
      });
      ctx.persist();
      return ok(`已推送 ${receipt.branch} @ ${receipt.sha.slice(0, 12)}`
        + `(仓 ${repo.url})`);
    },
  }));

  // ---- MR 创建(fixed 仅提交MR·跑绿阶段;验绿由 complete_stage 的
  // MR 验绿门程序化把守,UT 不再是建 MR 前置) ----

  tools.push(defineTool({
    name: "create_mr",
    label: "Create Merge Request",
    description:
      "为已推送的修复分支创建合并请求(经交付平台适配层调 codehub CLI;"
      + "单号自动关联,合入由用户在门禁通过后决定)。前置:已绑定单号、"
      + "分支已 push_branch。title 缺省 [单号] 会话标题。",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "MR 标题;缺省 [单号] 问题标题" })),
      target_branch: Type.Optional(Type.String({
        description: "目标分支,缺省 master",
      })),
      repo: Type.Optional(Type.String({
        description: "目标代码仓地址;缺省首个登记仓。必须是会话登记过的仓",
      })),
    }),
    async execute(_toolCallId: string, params: any) {
      gateStage("create_mr");
      const state = ctx.state;
      if (!state.ticket) {
        fail("单号门禁:会话尚未绑定 DTS 单号,不能创建 MR");
      }
      const platformUrl = ctx.platformUrl;
      if (!platformUrl) {
        fail("交付平台未配置(部署需 --platform 接适配层),无法创建 MR");
      }
      // 按仓门禁与记账(2026-08-28 拍板:对哪些仓交付由 AI 裁决,平台
      // 只核"该仓自己推过分支"这一条机械事实)。
      const repo = locateRepo(params.repo);
      const pushRecord = state.pushes?.find((item) => item.repo === repo.url);
      if (!pushRecord) {
        fail(`仓 ${repo.url} 还没有推送记录:请先对该仓调用 push_branch,`
          + "再创建 MR(一仓一 MR,改过的仓各自交付)");
      }
      const target = String(params.target_branch ?? "").trim() || "master";
      const title = String(params.title ?? "").trim()
        || `[${state.ticket}] ${state.title}`;
      const receipt = await createMergeRequest({
        platformUrl,
        repo: repo.url,
        sourceBranch: pushRecord.branch,
        targetBranch: target,
        title,
        dtsNo: state.ticket,
        credential: ctx.gitCredential?.(),
      });
      const mrs = state.mrs ??= [];
      const record = {
        repo: repo.url, branch: pushRecord.branch, title,
        url: receipt.url,
        ...(receipt.id !== undefined ? { iid: String(receipt.id) } : {}),
        at: new Date().toISOString(),
      };
      const slot = mrs.findIndex((item) => item.repo === repo.url);
      if (slot >= 0) mrs[slot] = record; else mrs.push(record);
      recordTransition(state, {
        source: "platform",
        note: `MR 已创建: ${receipt.url}`,
      });
      ctx.persist();
      if (fixed) ctx.onMrCreated?.(repo.url);
      return ok(`MR 已创建: ${receipt.url}\n(source ${pushRecord.branch} → ${target},`
        + `仓 ${repo.url},关联单号 ${state.ticket})。${fixed
          ? "平台已启动流水线监看:请结束本回合,等待流水线结果(红了平台会带回失败项让你修)。"
          : "合入由用户在门禁通过后决定。"}`);
    },
  }));

  // ---- 以下三个工具仅固定流程注册 ----

  if (fixed && scenario) {
    // 绑定业务模块(拉取代码仓阶段的 AI 识别路):只记账不克隆——
    // 克隆是 pull_repo 的活(2026-08-28 拍板:AI 对拉仓效果保持认知)。
    tools.push(defineTool({
      name: "bind_module",
      label: "Bind Business Module",
      description:
        "把会话绑定到业务模块,并按模块绑定的代码仓清单补齐本会话的登记"
        + "(与已登记仓合并去重,不克隆)。先 lookup_modules 检索再调用;"
        + "绑定后请对模块带出的每个仓逐个调 pull_repo 拉取。重复调用=改绑"
        + "(更新模块标签);模块没绑代码仓会失败,此时用 AskUserQuestion"
        + "向用户要代码仓地址。",
      parameters: Type.Object({
        module_id: Type.String({
          description: "业务模块 ID(lookup_modules 返回的 id)",
        }),
      }),
      async execute(_toolCallId: string, params: any) {
        gateStage("bind_module");
        // 人工预绑锁(spec #57):模块是人在发起时显式选定的,绑定权
        // 在人——AI 不得改绑,发现不符只能 AskUserQuestion 报告给人。
        if (state.module_locked) {
          fail("该会话的业务模块由人工预绑锁定,不能调用 bind_module 改绑。"
            + "如你判断模块与单据明显不符,请用 AskUserQuestion 告知用户,"
            + "由人在 DTS 列表改绑或提供代码仓地址;当前直接对已登记仓"
            + "逐个 pull_repo 即可");
        }
        const moduleId = String(params.module_id ?? "").trim();
        if (!moduleId) fail("module_id 不能为空:先 lookup_modules 检索拿到模块 id");
        let module;
        try {
          module = readBusinessModule(ctx.dataRoot, moduleId);
        } catch (error) {
          fail(`业务模块 ${moduleId} 不存在或元数据不可读:`
            + (error instanceof Error ? error.message : String(error))
            + "。请用 lookup_modules 重新检索,或用 AskUserQuestion 问用户");
        }
        if (module.status !== "active") {
          fail(`业务模块「${module.name}」已归档,不能绑定`);
        }
        if (!module.repositories.length) {
          fail(`业务模块「${module.name}」没有绑定代码仓——请用 AskUserQuestion`
            + "向用户要代码仓地址");
        }
        // 模块仓与已登记仓合并去重(已在场的仓不动),与登记同一把尺;
        // 超上限整次打回,不留半绑定状态。
        const merged = normalizeIssueRepos(undefined,
          [...(state.repo_urls ?? []), ...module.repositories]);
        const rebind = state.module_id === module.id;
        const fresh = merged.filter((url) =>
          !(state.repo_urls ?? []).includes(url));
        state.module_id = module.id;
        state.module = module.name;
        state.repo_url = merged[0];
        state.repo_urls = merged;
        recordTransition(state, {
          source: "platform",
          note: rebind
            ? `业务模块改绑为「${module.name}」(代码仓 ${merged.length} 个)`
            : `已绑定业务模块「${module.name}」(代码仓 ${merged.length} 个)`,
        });
        ctx.persist();
        return ok(`已绑定业务模块「${module.name}」,会话登记代码仓 ${merged.length} 个`
          + (fresh.length
            ? `——新登记 ${fresh.length} 个,请逐个调用 pull_repo 拉取:\n`
              + fresh.map((url) => `  pull_repo(url: "${url}")`).join("\n")
            : "(全部已在会话里)"));
      },
    }));

    // 提交分析报告:人工闸的入口(有单=报告确认;无单=结论确认)
    tools.push(defineTool({
      name: "submit_analysis",
      label: "Submit Analysis Report",
      description:
        "宣布问题分析完成并提交分析报告(工作区根目录的 issue-analysis.md)。"
        + "调用前报告必须已写好——平台以文件在场且五章节齐全(问题现象/"
        + "问题根因/修改方案/证据链/置信度,首行一句话总结串联三者,"
        + "模板见技能 issue-analysis)为门票。提交后平台举"
        + "确认卡等用户过目:有单场景确认后进入问题修改;无单场景需给 conclusion"
        + "(issue=是问题/non_issue=非问题)由用户定夺挂起或闭环。"
        + "提交后请结束回合等待用户。",
      parameters: Type.Object({
        conclusion: Type.Optional(Type.Union(
          [Type.Literal("issue"), Type.Literal("non_issue")],
          { description: "分析结论(无单场景必填):issue=是问题 / non_issue=非问题" },
        )),
        confidence: Type.Optional(Type.Union(
          [Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")],
          { description: "结论置信度自报(无单场景消费:non_issue 且 high 在月光"
            + "免审批档自动闭环归档;缺省按置信度不足处理,人工裁决)" },
        )),
        summary: Type.String({
          description: "一段话结论摘要:根因与方向(或非问题的判定依据),会展示给用户",
        }),
      }),
      async execute(_toolCallId: string, params: any) {
        gateStage("submit_analysis");
        const report = analysisReportPath(ctx);
        if (!existsSync(report)) {
          fail(`分析报告还没落盘:请先把报告写到工作区根目录 issue-analysis.md`
            + `(问题现象/问题根因/修改方案/证据链/置信度五章节,首行一句话总结,模板见技能 issue-analysis),再提交`);
        }
        const missing = missingAnalysisSections(readFileSync(report, "utf-8"));
        if (missing.length) {
          fail(`分析报告缺必备章节:${missing.join("、")}。`
            + "按技能 issue-analysis 的模板补齐五章节再提交;轻量路径的简版"
            + "报告也必须五章节齐全(内容可简,要素不缺)。");
        }
        const summary = String(params.summary ?? "").trim();
        if (!summary) fail("summary 不能为空:给用户看的结论摘要");
        if (scenario === "no_ticket"
            && params.conclusion !== "issue" && params.conclusion !== "non_issue") {
          fail("无单场景必须给 conclusion(issue=是问题 / non_issue=非问题)");
        }
        const proposal = {
          ...(params.conclusion ? { conclusion: params.conclusion } : {}),
          ...(params.confidence ? { confidence: params.confidence } : {}),
          summary,
          report,
        };
        if (scenario === "no_ticket") {
          // 无单场景:结论的确认本身就是「确定结论」节点——先推进再举闸,
          // 进度条上用户看到的就是"正在等确认"。
          fixedAdvance(ctx.state, "conclude",
            `分析结论:${params.conclusion === "non_issue" ? "非问题" : "是问题"},等待用户确认`);
          raiseGate(
            ctx.state, "conclude",
            `分析结论:${params.conclusion === "non_issue" ? "非问题" : "是问题"}——${summary}`,
            proposal,
          );
        } else {
          raiseGate(
            ctx.state, "analysis_confirm",
            `问题分析报告已产出(${summary}),请查阅 issue-analysis.md 后确认`,
            proposal,
          );
        }
        // 检视回合收口(ADR-0007):新一轮报告提交即举确认卡,检视
        // 入口随之恢复——in-flight 标记在此清除。
        delete ctx.state.review_active;
        ctx.persist();
        return ok("分析报告已提交,平台已举确认卡。请结束本回合,等待用户确认"
          + (scenario === "no_ticket" ? "(用户将决定挂起等提单还是闭环归档)。" : "后进入问题修改。"));
      },
    }));

    // UT 事实上报(2026-09-02 并入问题修复:TDD 先写复现单测再改码,
    // 没有独立 UT 阶段)。只记账(台账+事件流+现场记录),不推进阶段、
    // 不设建 MR 门禁——出口是 complete_stage,硬验证在提交 MR 阶段的
    // 流水线验绿。
    tools.push(defineTool({
      name: "report_ut",
      label: "Report UT Result",
      description:
        "上报 UT 验证结果(在代码仓里实际跑的单测)。这是事实上报:平台只"
        + "记账留痕,不推进阶段、不设任何门禁。UT 属于问题修复阶段的一部分"
        + "(TDD:先写复现单测再改码转绿),修复过程中每轮都可上报。summary "
        + "带通过率与关键失败(如有),log_path 指向工作区内的测试报告/日志。"
        + "测试结果可接受后调 complete_stage 收口本阶段。",
      parameters: Type.Object({
        passed: Type.Boolean({ description: "本轮单测是否全部通过" }),
        summary: Type.String({ description: "一段话结果:跑了什么/通过率/关键失败" }),
        log_path: Type.Optional(Type.String({
          description: "测试输出落点(工作区内相对路径),供用户查证",
        })),
      }),
      async execute(_toolCallId: string, params: any) {
        gateStage("report_ut");
        const round = ctx.state.round ?? 1;
        ctx.state.ut = {
          passed: params.passed === true,
          summary: String(params.summary ?? ""),
          ...(params.log_path ? { log_path: String(params.log_path) } : {}),
          round,
          at: new Date().toISOString(),
        };
        recordTransition(ctx.state, {
          source: "agent",
          note: `UT 上报(第 ${round} 轮):${params.passed === true ? "通过" : "未通过"}`
            + ` — ${String(params.summary ?? "").split("\n")[0]}`,
        });
        ctx.persist();
        return ok(params.passed === true
          ? `UT 结果已记账(第 ${round} 轮:通过)。report_ut 只记账不推进——`
            + "本阶段出口是 complete_stage,自检与测试可接受就调它收口,"
            + "进入「提交 MR·跑绿」。"
          : `UT 未通过已记账(第 ${round} 轮)——继续留在问题修复阶段:`
            + "请修复后重跑重报;测试结果可接受后调 complete_stage 收口。");
      },
    }));

    /** MR 验绿门(mr_green 阶段的 complete_stage 契约):AI 申报的清单
     * 与台账(state.mrs,create_mr 自动记账)归一比对,少报多报都打回;
     * 再对台账每个 MR 的最新推送 SHA 查流水线,三态裁决——全绿当场
     * 放行、有红当场打回带失败项、在跑/无记录受理由监看器等绿放行
     * (受理账 state.mr_gate,进 deploy_verify 当且仅当"已申报且全绿")。 */
    const settleMrGate = async (
      declared: string[], note: string,
    ): Promise<ReturnType<typeof ok>> => {
      const ledger = state.mrs ?? [];
      // 归一:去空白/尾斜杠/.git 后缀。一仓一 MR 不变量下,MR 链接与
      // 仓地址都能定位同一条台账。
      const norm = (value: string) =>
        value.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
      const byRepo = new Map(ledger.map((record) => [norm(record.repo), record]));
      const byUrl = new Map(
        ledger.filter((record) => record.url)
          .map((record) => [norm(record.url!), record]));
      const declaredRepos: string[] = [];
      const unknown: string[] = [];
      for (const entry of declared.map(norm)) {
        if (!entry) continue;
        const record = byUrl.get(entry) ?? byRepo.get(entry);
        if (!record) {
          if (!unknown.includes(entry)) unknown.push(entry);
          continue;
        }
        if (!declaredRepos.includes(record.repo)) declaredRepos.push(record.repo);
      }
      const missing = ledger
        .map((record) => record.repo)
        .filter((repo) => !declaredRepos.includes(repo));
      if (missing.length || unknown.length) {
        fail("MR 清单与台账不一致,不能收口:"
          + (missing.length
            ? `\n- 少报(台账里有、清单没申报): ${missing.join(", ")}`
            : "")
          + (unknown.length
            ? `\n- 多报(清单里有、台账没有这个 MR): ${unknown.join(", ")}`
            : "")
          + "\n清单=台账:对每个改过的仓 push_branch + create_mr,然后把"
            + "全部 MR(链接或仓地址)重新申报,一个都不能少、不能编。");
      }
      // 空=空合法(无码修改路径):没有 MR 就没有可验的流水线,直接收口。
      if (!ledger.length) {
        fixedComplete(ctx.state, `无 MR 交付(空清单=空台账):${note}`);
        ctx.state.stage_note = "流程收口——确认后可归档";
        ctx.persist();
        ctx.notifyMrGreen?.();
        return ok(`MR 清单核验通过(空清单=空台账),流程收口——`
          + "全部工作已完成,等用户确认归档。");
      }
      const platformUrl = ctx.platformUrl;
      if (!platformUrl) {
        fail("交付平台未配置(部署需 --platform 接适配层),无法验绿 MR 流水线");
      }
      // 逐 MR 查最新推送 SHA 的流水线(验绿事实源,不新增按 MR id 查)。
      const runs: Array<{ repo: string; sha: string; run: PipelineRun }> = [];
      for (const record of ledger) {
        const sha = state.pushes?.find((item) => item.repo === record.repo)?.sha;
        if (!sha) {
          fail(`仓 ${record.repo} 的 MR 缺推送记录,无法验绿:`
            + "先对该仓 push_branch,再 create_mr,然后重新申报");
        }
        const status = await getPipelineStatus({
          platformUrl: platformUrl!,
          repo: record.repo,
          sha,
          // 适配层状态命令模板可能引用 {mr}(2026-08-28 真实环境 502:
          // 模板变量空串渲染失败)——台账里记了 iid,带上。
          ...(record.iid ? { mr: record.iid } : {}),
          credential: ctx.gitCredential?.(),
        });
        // runs 是同一 SHA 按时间顺序返回的运行历史，只有最后一条代表
        // 当前流水线。历史绿/红后又触发的新 run 仍在 running 时，绝不
        // 能拿旧终态提前放行或打回。
        const latest = status.runs.at(-1);
        runs.push({
          repo: record.repo,
          sha,
          run: latest ?? { status: status.status },
        });
      }
      const failed = runs.filter((item) => item.run.status === "failed");
      if (failed.length) {
        delete state.mr_gate;
        ctx.persist();
        fail("MR 验绿门:有流水线未通过,不能收口。\n"
          + failed.map((item) =>
            `- ${item.repo} @ ${item.sha.slice(0, 12)}\n  `
              + describePipelineRun(item.run)).join("\n")
          + "\n处置:修复后同分支 push_branch、重建 MR(create_mr),"
          + "再调 complete_stage 重新申报。");
      }
      if (runs.every((item) => item.run.status === "success")) {
        delete state.mr_gate;
        fixedComplete(ctx.state,
          `MR 验绿通过(${runs.length} 个 MR 全绿):${note}`);
        ctx.state.stage_note = "全部 MR 流水线已跑绿——确认合入后可归档收口";
        ctx.persist();
        ctx.notifyMrGreen?.();
        return ok(`MR 验绿通过(${runs.map((item) => item.repo).join(", ")}),`
          + "流程收口——全部 MR 流水线跑绿,等用户确认归档。");
      }
      // 在跑/无记录:受理——记申报账,监看器绿了收口、红了带回失败项。
      state.mr_gate = { mrs: declaredRepos, at: new Date().toISOString() };
      recordTransition(state, {
        source: "platform",
        note: `MR 清单已申报(${declaredRepos.length} 个),等流水线验绿`,
      });
      ctx.persist();
      return ok(`MR 清单已受理(${declaredRepos.join(", ")})——流水线还在跑或`
        + "暂无记录。绿了平台自动收口并通知用户,红了平台会把失败项带回;"
        + "可结束本回合停等。");
    };

    // 阶段自报出口(2026-08-28 目标驱动拍板):四个阶段(拉单/拉仓/
    // 修改/提交MR)的唯一出口。前三段只自报收口推进;提交MR
    // 段是 MR 验绿门(唯一带平台核验的出口)。
    tools.push(defineTool({
      name: "complete_stage",
      label: "Complete Current Stage",
      description:
        "宣布当前阶段目标已达成并收口——拉单/拉仓/修改/提交MR 四个"
        + "阶段的唯一出口。「获取单据信息」通读单据后调;「拉取代码仓」"
        + "把要用的仓拉齐后调(包括「本单无需代码仓」的跳过:研究结论不"
        + "涉及代码改动时,不拉任何仓直接调它过关);「问题修复」按 TDD "
        + "先写复现单测再改码转绿,自检与测试可接受后调(report_ut 只是"
        + "事实记账,不是出口);「提交 MR·跑绿」建齐 MR 后调,必带 mrs 参数"
        + "申报 MR 清单(每项是 MR 链接或对应仓地址)——平台按台账与流水"
        + "线验绿放行:全绿当场进下一阶段,有红当场打回,在跑受理等绿。"
        + "活干完再调,没干完不要调。",
      parameters: Type.Object({
        note: Type.String({ description: "一句话:做了什么(文件/要点),或为何无需代码仓" }),
        mrs: Type.Optional(Type.Array(Type.String(), {
          description: "提交MR阶段必填:申报的 MR 清单(MR 链接或对应仓地址),"
            + "必须与会话台账(create_mr 记的账)完全一致",
        })),
      }),
      async execute(_toolCallId: string, params: any) {
        gateStage("complete_stage");
        const firstLine = String(params.note ?? "").split("\n")[0];
        if (state.stage === "mr_green") {
          return settleMrGate(
            ((params.mrs as string[] | undefined) ?? []).map(String), firstLine);
        }
        // 前三段:纯自报推进,下一阶段指引全部由注册表生成。
        const to: FixedStage = state.stage === "dts_info" ? "prep_repo"
          : state.stage === "prep_repo" ? "analyze"
          : "mr_green";
        const note = state.stage === "prep_repo"
          ? ((state.repo_urls?.length ?? 0) > 0
            ? `拉取代码仓完成:${firstLine}`
            : `跳过拉取代码仓:${firstLine}`)
          : state.stage === "dts_info" ? `单据已通读:${firstLine}`
          : `问题修复完成:${firstLine}`;
        fixedAdvance(ctx.state, to, note);
        // analyze 入口(ADR-0012/0014):先定格业务知识资产(不分介入
        // 档,缺席静默;重走时台账已在,重复定格被台账判据挡住),再
        // 渲染地图(台账资产+仓内 docs/ 现扫,两源皆空为空),最后
        // 扫描仓内业务 skill 留痕(ADR-0014:圈选闸已封存,只记账
        // 不举卡,AI 按编排技能的索引纪律自主发现)。
        const enteredAnalyze = to === "analyze";
        const knowledgeBrief = enteredAnalyze
          ? (void ctx.freezeBusinessKnowledge?.(),
            ctx.businessKnowledgeBrief?.() ?? "")
          : "";
        void (enteredAnalyze
          ? ctx.raiseSkillSelection?.() : undefined);
        ctx.persist();
        return ok(`已收口,平台推进到下一阶段——\n`
          + stageBriefLines(scenario, to).join("\n")
          + (knowledgeBrief ? `\n\n${knowledgeBrief}` : ""));
      },
    }));

  }

  // 给模型的固定流程阶段速查(描述里说明,方便宿主提示词引用)
  if (fixed && scenario) {
    ctx.log?.(`[issue-tools] 固定流程工具集就绪(${scenario} 场景,`
      + `${fixedStages(scenario).length} 阶段;report_stage 已由平台接管)`);
  }
  return tools;
}
