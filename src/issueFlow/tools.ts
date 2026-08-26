/**
 * 问题会话的宿主工具集(递给 Agent 的平台原子能力)。
 *
 * 设计立场:秘密(环境密码、git/MCP token)止步于宿主,Agent 只拿到
 * 工具语义与结果文本。"提 MR 前必须有单号"在这里是机械门禁——
 * push_branch / create_mr 查不到绑定单号直接拒绝,提示词管不住的
 * 侥幸在工具层过不去。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  ISSUE_STAGES,
  type IssueSessionState,
} from "./state.ts";
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

export function createIssueTools(ctx: IssueToolContext): unknown[] {
  const tools: unknown[] = [];

  tools.push(defineTool({
    name: "report_stage",
    label: "Report Stage",
    description:
      "向平台上报当前处理阶段。每进入新环节(拿单/拉日志/分析/对齐/编码/"
      + "提交/换库/验证/提MR/出结论)调用一次,note 用一句话说明现场。"
      + `合法阶段: ${ISSUE_STAGES.join(" / ")}`,
    parameters: Type.Object({
      stage: Type.Union(ISSUE_STAGES.map((stage) => Type.Literal(stage)), {
        description: "当前阶段",
      }),
      note: Type.String({ description: "一句话现场说明(做了什么/发现了什么)" }),
    }),
    async execute(_toolCallId: string, params: any) {
      ctx.state.stage = params.stage;
      ctx.state.stage_note = String(params.note ?? "");
      ctx.state.stage_at = new Date().toISOString();
      ctx.persist();
      return ok(`阶段已更新为 ${params.stage}:${params.note}`);
    },
  }));

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
      hosts: Type.Array(Type.String(), {
        description: "网管服务器 IP(可多台串行抓取);缺省用会话环境配置",
      }),
    }),
    async execute(_toolCallId: string, params: any) {
      if (!ctx.ops) fail("宿主未部署运维工具(assets/ops-tools),无法拉日志");
      const password = ctx.environmentPassword?.();
      if (!password) {
        fail("本会话未配置网管环境(地址+密码)。请向用户说明:需要在登记问题时"
          + "填写网管环境;纯代码分析可继续,缺日志证据时明确提问");
      }
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
      return ok(result.summary);
    },
  }));

  tools.push(defineTool({
    name: "build_deploy",
    label: "Build And Deploy",
    description:
      "把工作区代码仓(含 deployment/pom.xml)构建并部署到网管服务器,"
      + "自动备份当前版本。仅页面/前后端改动不要加 include_lib;"
      + "仅当 pom.xml 依赖版本变更时才加。部署后必须停下等用户验证。",
    parameters: Type.Object({
      hosts: Type.Array(Type.String(), {
        description: "目标服务器 IP(可多台);缺省用会话环境配置",
      }),
      include_lib: Type.Boolean({
        description: "同时更新 lib 目录;仅 pom.xml 依赖变更时为 true",
      }),
    }),
    async execute(_toolCallId: string, params: any) {
      if (!ctx.ops) fail("宿主未部署运维工具(assets/ops-tools),无法换库");
      const password = ctx.environmentPassword?.();
      if (!password) fail("本会话未配置网管环境,无法换库部署");
      const repoDir = join(ctx.workspace, "repo");
      if (!existsSync(join(repoDir, ".git"))) fail("代码克隆不存在,无法部署");
      const hosts = (params.hosts as string[] | undefined)?.length
        ? params.hosts as string[]
        : ctx.state.environment?.hosts ?? [];
      const result = await ctx.ops.buildDeploy({
        projectPath: repoDir,
        hosts,
        password,
        includeLib: Boolean(params.include_lib),
      });
      return ok(result.summary
        + "\n部署完成——请用 AskUserQuestion 请用户在环境上验证,等结果再继续。");
    },
  }));

  tools.push(defineTool({
    name: "dts_get_ticket",
    label: "Get DTS Ticket",
    description:
      "按单号查 DTS 问题单详情(现象/影响/处理历史)。单号缺省用会话已"
      + "绑定的单号。注意:绑定单号是用户动作——查到的单号要用于推送/提MR,"
      + "需请用户在页面完成绑定。",
    parameters: Type.Object({
      ticket: Type.Optional(Type.String({ description: "DTS 问题单号;缺省用会话绑定单号" })),
    }),
    async execute(_toolCallId: string, params: any) {
      if (!ctx.dts) fail("DTS 网关未配置,无法查单(部署需 --dts-mcp-url)");
      const ticket = String(params.ticket ?? "").trim() || ctx.state.ticket;
      if (!ticket) fail("没有单号:请提供 ticket 参数,或请用户先绑定单号");
      const detail = await ctx.dts.detail(ticket);
      return ok(`问题单 ${detail.ticket} 详情:\n${detail.content}`);
    },
  }));

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
    }),
    async execute(_toolCallId: string, params: any) {
      const state = ctx.state;
      if (!state.ticket) {
        fail("单号门禁:会话尚未绑定 DTS 单号。请请用户在页面「绑定单号」后重试"
          + "——推送与提 MR 都以单号为门票");
      }
      const repoDir = join(ctx.workspace, "repo");
      if (!existsSync(join(repoDir, ".git"))) fail("代码克隆不存在,无法推送");
      if (!state.repo_url) fail("会话没有权威代码仓地址,拒绝推送");
      const branch = String(params.branch ?? "").trim()
        || await currentBranch(repoDir);
      if (!branch) fail("没有可推送的分支(缺 branch 参数且当前不在分支上)");
      const expected = expectedBranch(state);
      if (branch !== expected) {
        fail(`分支名不符合交付规则: 应为 ${expected},实际 ${branch}。`
          + "修复分支命名固定为 master_<工号>_<单号>");
      }
      const receipt = await pushFromIssueWorkspace({
        dataDir: ctx.dataRoot,
        repoDir,
        repoUrl: state.repo_url,
        branch,
        credential: ctx.gitCredential?.(),
      });
      state.push = {
        branch: receipt.branch,
        sha: receipt.sha,
        at: new Date().toISOString(),
      };
      ctx.persist();
      return ok(`已推送 ${receipt.branch} @ ${receipt.sha.slice(0, 12)}`);
    },
  }));

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
    }),
    async execute(_toolCallId: string, params: any) {
      const state = ctx.state;
      if (!state.ticket) {
        fail("单号门禁:会话尚未绑定 DTS 单号,不能创建 MR");
      }
      if (!state.push) {
        fail("分支还没有推送记录:请先调用 push_branch,再创建 MR");
      }
      const platformUrl = ctx.platformUrl;
      if (!platformUrl) {
        fail("交付平台未配置(部署需 --platform 接适配层),无法创建 MR");
      }
      if (!state.repo_url) fail("会话没有权威代码仓地址,拒绝创建 MR");
      const target = String(params.target_branch ?? "").trim() || "master";
      const title = String(params.title ?? "").trim()
        || `[${state.ticket}] ${state.title}`;
      const receipt = await createMergeRequest({
        platformUrl,
        repo: state.repo_url,
        sourceBranch: state.push.branch,
        targetBranch: target,
        title,
        dtsNo: state.ticket,
        credential: ctx.gitCredential?.(),
      });
      state.mr = {
        branch: state.push.branch,
        title,
        url: receipt.url,
        ...(receipt.id !== undefined ? { iid: String(receipt.id) } : {}),
        at: new Date().toISOString(),
      };
      ctx.persist();
      return ok(`MR 已创建: ${receipt.url}\n(source ${state.push.branch} → ${target},`
        + `关联单号 ${state.ticket})。合入由用户在门禁通过后决定。`);
    },
  }));

  return tools;
}
