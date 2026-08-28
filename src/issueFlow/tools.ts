/**
 * 问题会话的宿主工具集(递给 Agent 的平台原子能力)。
 *
 * 设计立场:秘密(环境密码、git/MCP token)止步于宿主,Agent 只拿到
 * 工具语义与结果文本。"提 MR 前必须有单号"在这里是机械门禁——
 * push_branch / create_mr 查不到绑定单号直接拒绝,提示词管不住的
 * 侥幸在工具层过不去。
 *
 * 固定流程(2026-08-27 拍板)在工具层叠加两件事:
 * - 阶段门禁:每个工具只在所属阶段开放,越权调用直接拒绝(双层
 *   门禁的权威层;提示词里的"本阶段工具清单"是引导层,两层的白名单
 *   同出阶段注册表 stageRegistry.ts,不会各说各话)。例外是
 *   工读类——fetch_logs 全程开放,dts_get_ticket 任意阶段可重查
 *   (2026-08-28 拍板:作业自由,门只守流程出口与出厂动作);
 * - 阶段推进:机械可判的推进(拉单成功/UT 通过)由工具直接记账,
 *   人工闸(报告确认/结论/环境验证)由工具举闸——raiseGate 写进
 *   issue.json,Agent 对它只读,推不动。
 *
 * 自由探索模式保持原有工具集(report_stage + 五工具)零改动。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  ISSUE_STAGES,
  STAGE_LABELS,
  FIXED_STAGE_LABELS,
  fixedAdvance,
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
} from "./stageRegistry.ts";
import { readBusinessModule, listBusinessModules } from "../businessModuleLibrary.ts";
import type { IssueOpsTools } from "./opsTools.ts";
import type { DtsGateway } from "./gateways.ts";
import {
  currentBranch,
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
  gitCredential?(): GitCredential | undefined;
  /** 拉仓(2026-08-28 拍板:克隆是 Agent 的工具,不是平台自动动作)。
   * 宿主实现:登记合并 → 带凭据克隆到 repo/<仓名>/ →(有单场景)
   * 尽力建修复分支。回执只含事实,凭据永不进结果。 */
  pullRepo(url: string): Promise<{
    dir: string;
    cloned: boolean;
    branch?: string;
    head: string;
    baselineMiss?: string;
  }>;
  /** 固定流程:create_mr 成功后由服务启动流水线监看(触发+轮询)。 */
  onMrCreated?(repo: string): void;
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
    if (stageAllowsTool(scenario, state.stage as FixedStage, tool)) return;
    const allowed = stagesAllowingTool(scenario, tool)
      .map((stage) => FIXED_STAGE_LABELS[scenario][stage]);
    fail(`阶段门禁:${tool} 在当前阶段「${stageLabel()}」不开放。`
      + `允许的阶段:${allowed.length ? allowed.join(" / ") : "无(本场景流程不含该工具)"}`
      + `。固定流程的阶段由平台推进,请先完成本阶段工作`);
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
      + "密码由平台保管,不需要也不允许出现在对话里。",
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
          + `${facts.branch ? `,分支 ${facts.branch}` : ""}`,
      });
      // 首仓落地且仍处拉取阶段 → 机械推进问题分析;后续仓在分析及之后
      // 随时可补(中途发现新仓是正当场景),不倒转阶段。
      let advance = "";
      if (fixed && scenario && state.stage === "prep_repo") {
        fixedAdvance(state, "analyze",
          `首个代码仓已就绪(${facts.dir}),进入问题分析`);
        advance = "\n平台已推进到「问题分析」阶段——还有要拉的仓继续调 pull_repo"
          + "(中途补仓随时可以),然后开始分析。";
      }
      ctx.persist();
      const baselineNote = facts.baselineMiss
        ? `\n注意: 该仓没有基线分支 ${facts.baselineMiss},修复分支未创建、`
          + "停在其默认分支——请核实基线是否正确,拿不准就用 AskUserQuestion 问用户。"
        : "";
      return ok(`代码仓就绪:\n- 工作区目录: ${facts.dir}\n`
        + `- HEAD: ${facts.head.slice(0, 12)}`
        + `${facts.branch ? `\n- 修复分支: ${facts.branch}(已切好)` : ""}`
        + `${baselineNote}${advance}`);
    },
  }));

  // ---- 运维:换库部署(fixed 仅换库验证阶段;成功即举环境验证闸) ----

  tools.push(defineTool({
    name: "build_deploy",
    label: "Build And Deploy",
    description:
      "把工作区代码仓(含 deployment/pom.xml)构建并部署到网管服务器,"
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

  // ---- DTS 查单(fixed 仅首阶段;成功即机械推进到拉代码仓) ----

  tools.push(defineTool({
    name: "dts_get_ticket",
    label: "Get DTS Ticket",
    description:
      "按单号查 DTS 问题单详情(现象/影响/处理历史)。单号缺省用会话已"
      + "绑定的单号。任意阶段都可调用(重查单据不限阶段);首次在"
      + "「获取单据信息」阶段调用时,平台会顺势推进到拉取代码仓。注意:"
      + "绑定单号是用户动作——查到的单号要用于推送/提MR,需请用户在页面"
      + "完成绑定。",
    parameters: Type.Object({
      ticket: Type.Optional(Type.String({ description: "DTS 问题单号;缺省用会话绑定单号" })),
    }),
    async execute(_toolCallId: string, params: any) {
      if (!ctx.dts) fail("DTS 网关未配置,无法查单(部署需 --dts-mcp-url)");
      const ticket = String(params.ticket ?? "").trim() || ctx.state.ticket;
      if (!ticket) fail("没有单号:请提供 ticket 参数,或请用户先绑定单号");
      const detail = await ctx.dts.detail(ticket);
      recordTransition(ctx.state, {
        source: "platform",
        note: `DTS 单 ${detail.ticket} 详情已获取`,
      });
      // 首查(dts_info 阶段)顺势推进;后续阶段重查只回内容——
      // fixedAdvance 会无条件置目标阶段,不设防会把阶段倒回 prep_repo。
      const firstPull = fixed && scenario && state.stage === "dts_info";
      if (firstPull) {
        fixedAdvance(ctx.state, "prep_repo",
          `DTS 详情已获取(单据 ${detail.ticket}),进入拉取代码仓阶段`);
      }
      ctx.persist();
      return ok(`问题单 ${detail.ticket} 详情:\n${detail.content}`
        + (firstPull
          ? "\n\n平台已推进到「拉取代码仓」阶段:先 lookup_modules 按单据里的"
            + "业务关键词检索模块,命中就 bind_module 登记它的代码仓,再逐个 "
            + "pull_repo 拉取;检索不到就 AskUserQuestion 问用户要仓地址;"
            + "本单无需代码改动则 complete_stage 跳过本阶段。"
          : ""));
    },
  }));

  // ---- 推送(fixed 自问题修改阶段起;机械单号门禁两模式同在) ----

  tools.push(defineTool({
    name: "push_branch",
    label: "Push Branch (Host)",
    description:
      "把当前修复分支经宿主推送到远端(git push 在容器里是禁用的,必须走"
      + "本工具)。机械门禁:会话必须已绑定单号,且分支名必须是 "
      + "master_<工号>_<单号>。推送后返回 SHA。",
    parameters: Type.Object({
      branch: Type.Optional(Type.String({
        description: "要推送的分支;缺省取代码仓当前分支",
      })),
      repo: Type.Optional(Type.String({
        description:
          "目标代码仓地址;缺省首个登记仓。必须是会话登记过的仓"
          + "(多仓分析时参考仓也能推,分支命名规则不变)",
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
      const receipt = await pushFromIssueWorkspace({
        dataDir: ctx.dataRoot,
        repoDir: repo.dir,
        repoUrl: repo.url,
        branch,
        credential: ctx.gitCredential?.(),
      });
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
        note: `分支已推送 ${repo.url} ${receipt.branch} @ ${receipt.sha.slice(0, 12)}`,
      });
      ctx.persist();
      return ok(`已推送 ${receipt.branch} @ ${receipt.sha.slice(0, 12)}`
        + `(仓 ${repo.url})`);
    },
  }));

  // ---- MR 创建(fixed 仅提交MR·跑绿阶段,且必须先过 UT 闸) ----

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
      if (fixed && state.ut?.passed !== true) {
        fail("UT 门禁:还没有 report_ut 上报通过记录,不能创建 MR。"
          + "请先在 UT 验证阶段跑完单测并用 report_ut 上报结果");
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
        + "调用前报告必须已写好——平台以文件在场为门票。提交后平台举确认卡"
        + "等用户过目:有单场景确认后进入问题修改;无单场景需给 conclusion"
        + "(issue=是问题/non_issue=非问题)由用户定夺挂起或闭环。"
        + "提交后请结束回合等待用户。",
      parameters: Type.Object({
        conclusion: Type.Optional(Type.Union(
          [Type.Literal("issue"), Type.Literal("non_issue")],
          { description: "分析结论(无单场景必填):issue=是问题 / non_issue=非问题" },
        )),
        summary: Type.String({
          description: "一段话结论摘要:现象-根因-方案(或非问题的判定依据),会展示给用户",
        }),
      }),
      async execute(_toolCallId: string, params: any) {
        gateStage("submit_analysis");
        const report = analysisReportPath(ctx);
        if (!existsSync(report)) {
          fail(`分析报告还没落盘:请先把报告写到工作区根目录 issue-analysis.md`
            + `(现象-根因-方案三段),再提交`);
        }
        const summary = String(params.summary ?? "").trim();
        if (!summary) fail("summary 不能为空:给用户看的结论摘要");
        if (scenario === "no_ticket"
            && params.conclusion !== "issue" && params.conclusion !== "non_issue") {
          fail("无单场景必须给 conclusion(issue=是问题 / non_issue=非问题)");
        }
        const proposal = {
          ...(params.conclusion ? { conclusion: params.conclusion } : {}),
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
        ctx.persist();
        return ok("分析报告已提交,平台已举确认卡。请结束本回合,等待用户确认"
          + (scenario === "no_ticket" ? "(用户将决定挂起等提单还是闭环归档)。" : "后进入问题修改。"));
      },
    }));

    // UT 上报:拦"上报"不拦"真相"(硬验证在阶段6流水线,UT 也在其中)
    tools.push(defineTool({
      name: "report_ut",
      label: "Report UT Result",
      description:
        "上报 UT 验证结果(在代码仓里实际跑的单测)。passed=true 才会推进到"
        + "提交 MR 阶段;失败就留在本阶段继续修,修完重跑重报。"
        + "summary 带通过率与关键失败(如有),log_path 指向工作区内的测试报告/日志。",
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
        if (params.passed === true) {
          fixedAdvance(ctx.state, "mr_green",
            `UT 通过(第 ${round} 轮),进入提交 MR·跑绿阶段`);
          ctx.persist();
          return ok("UT 通过已记账,平台已推进到「提交 MR·跑绿」阶段:"
            + "请推送修复分支(push_branch)并创建 MR(create_mr),"
            + "创建后平台会监看流水线。");
        }
        ctx.persist();
        return ok("UT 未通过已记账——继续留在 UT 验证阶段:请修复后重跑,"
          + "通过后再用 report_ut 重新上报。");
      },
    }));

    // 修改完成自报(fix → ut 的软推进;其余推进都是机械的)。
    // prep_repo → analyze 是它的第二职责:AI 宣布"本单无需代码仓"的
    // 跳过路(2026-08-28:repo_needed 闸退役,跳过也是 AI 的裁决)。
    tools.push(defineTool({
      name: "complete_stage",
      label: "Complete Current Stage",
      description:
        "宣布当前阶段完成。「问题修改」完成→推进 UT 验证;「拉取代码仓」"
        + "完成→推进问题分析(包括「本单无需代码仓」的跳过:研究结论不涉及"
        + "代码改动时,不拉任何仓直接调它过关)。只在这两处允许自报推进:"
        + "活干完再调,没干完不要调。",
      parameters: Type.Object({
        note: Type.String({ description: "一句话:做了什么(文件/要点),或为何无需代码仓" }),
      }),
      async execute(_toolCallId: string, params: any) {
        gateStage("complete_stage");
        const firstLine = String(params.note ?? "").split("\n")[0];
        if (state.stage === "prep_repo") {
          fixedAdvance(ctx.state, "analyze", `跳过拉取代码仓:${firstLine}`);
          ctx.persist();
          return ok("平台已推进到「问题分析」阶段:请基于单据/描述开展分析;"
            + "需要日志证据时调用 fetch_logs;中途发现需要代码仓,"
            + "随时 pull_repo 补上。");
        }
        fixedAdvance(ctx.state, "ut", `问题修改完成:${firstLine}`);
        ctx.persist();
        return ok("平台已推进到「UT 验证」阶段:请运行单元测试,"
          + "结束后用 report_ut 上报结果(passed=true 才能进 MR)。");
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
