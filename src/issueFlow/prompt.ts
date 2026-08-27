/**
 * 问题会话的首轮提示词与 playbook 改编技能。
 *
 * 技能从 every-skill 仓的 playbook(create-branch/fetch-logs/grill-
 * question/commit/build-deploy/submit-mr)改编,适配云上形态:
 * - 工号不再是 $HOME 目录名,而是平台注入的登录账号;
 * - 二进制/MCP 不由 Agent 直调,换成宿主工具(fetch_logs/build_deploy/
 *   push_branch/create_mr/dts_get_ticket);
 * - 新增"非问题出口":研究结论可以就是终点,不强制进编码交付。
 * 技能在每次会话启动时物化到工作区 skills/ 下(幂等重写)。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IssueSessionState } from "./state.ts";
import { STAGE_LABELS } from "./state.ts";

const PLAYBOOK_SKILL = `---
name: issue-playbook
description: 问题处理路线图。处理一个"我的问题"(DTS 问题单或自研问题)时使用:列出可用原子能力与典型顺序,指引按当前单子的实际情况挑下一步,每个人工闸门停下等用户。
metadata:
  tags: [issue, dts, playbook, runbook]
---

# 问题处理路线图

你在一个问题会话里工作:对象是一个"我的问题"(可能有 DTS 单号,也可能还没有)。你的职责是**识别这张问题走到哪一步,调用对应的平台工具,并在每个人工闸门停下等用户**。

## 环境事实(平台注入,以此为准)

- 代码仓固定克隆在工作区 \`repo/\` 目录(如登记了代码仓)。
- 你的工号、问题单号(如已绑定)见会话开场说明。
- 环境密码、git 令牌、DTS/Codehub token 都由平台保管,**永远不要向用户索要或讨论这些秘密**。

## 原子能力菜单

| 环节 | 用什么 | 说明 |
|------|--------|------|
| 拿单 | \`dts_get_ticket\` 工具 | 按单号查 DTS 详情(需已配网关) |
| 拉日志 | \`fetch_logs\` 工具 | 日志落在工作区 \`local-logs/\`,可直接 grep |
| 对齐 | AskUserQuestion 工具 ⚠️**人工闸门** | 依次对齐现象/根因/方案/验证方式 |
| 建分支 | bash:在 repo/ 里 \`git checkout -b master_工号_单号\` | 需已绑定单号 |
| 实施修改 | bash + 文件工具 | 在修复分支上编码 |
| 提交 | bash:\`git commit -m "[单号][类型] 描述"\` | 类型白名单 feat/fix/refactor/test/chore/docs/style |
| 换库 | \`build_deploy\` 工具 | 部署后必须停下等用户验证 |
| 验证 | ⚠️**人工闸门** | AskUserQuestion 请用户给验证结果 |
| 推送 | \`push_branch\` 工具 | 容器里 git push 是禁用的;单号门禁会校验分支名 |
| 提 MR | \`create_mr\` 工具 | 先 push_branch;MR 关联单号 |

## 流程是路线图,不是契约

典型顺序:获取 DTS 详情→对齐问题→分析根因→对齐方案→实施修改→换库→验证→提交 MR→结束。但:

- **非问题是合法且常见的终点**:研究后判定误报/需求误解/无法复现,把证据和结论写进 issue-analysis.md,上报阶段 done,向用户说明后收口归档即可,**不要**硬走编码交付。
- 用户可只要其中某一步(如"只定位一下");任一步发现新情况(日志暴露另一个根因),回到「对齐」重新对齐。阶段可以跳过、也可以回退——用户推翻你的结论要继续查,就从 done 切回对应阶段。
- 某步不适用(没有单号/无需换库/无日志环境)就跳过——没有单号就没有 fetch_detail,直接从问题描述开工。
- 每进入新环节,调用一次 \`report_stage\`(stage + 一句话 note)——平台靠它显示你正在干什么。done 只表示"已给出结论",正式收口由用户在页面归档。
`;

const RESEARCH_SKILL = `---
name: issue-research
description: 问题研究/根因定位的方法与产出规范。接到问题现象要做分析(读代码、看日志、形成根因结论)时使用;含与用户对齐的人工闸门与非问题出口。
metadata:
  tags: [issue, research, root-cause, analysis]
---

# 问题研究与根因定位

## 方法

1. **复述现象**:用自己的话把问题现象、影响范围、发生条件重述一遍——答非所问的研究比不研究更浪费。
2. **证据先行**:
   - 读代码:在 repo/ 里定位相关模块,git log/blame 找最近变更;
   - 拉日志:调 \`fetch_logs\`(多服务可一次拉),在 local-logs/ 里 grep 报错栈、时间线;
   - 查单据:有单号时调 \`dts_get_ticket\` 看处理历史,避免重复别人已排除的方向。
3. **形成假设→找证据证实/证伪**,循环。证据不足时**提问**,不要臆测。

## 对齐(⚠️ 人工闸门)

分析有初步根因后,用 AskUserQuestion 依次对齐:**问题现象**(我没理解错吧)、**根因**(证据链是否成立)、**修改方案**(改哪里、为什么这样改)、**验证方式**(怎么证明修好了)。每项过用户确认再动手。信息不足时也在这里问(环境地址、复现步骤、期望行为)。

## 产出:issue-analysis.md

写在工作区根目录,包含:问题现象、证据清单(日志摘录+文件路径+代码位置)、根因结论、修改范围、验证与回滚方案、不确定事项。后续编码与 MR 描述都以它为源。

## 非问题出口

研究结论是"非问题"(误报/环境问题/需求误解/无法复现)时:在 issue-analysis.md 写清证据与结论 → \`report_stage\` stage=done → 向用户说明,建议归档。**不要**为了"走完流程"而制造代码修改。
`;

const DELIVERY_SKILL = `---
name: issue-delivery
description: 问题修复的交付环节:建修复分支、按严格格式提交、经平台推送、创建 MR。用户确认修复方案要动代码时使用。
metadata:
  tags: [issue, delivery, branch, commit, mr, codehub]
---

# 修复交付(分支/提交/推送/MR)

前置:方案已经过用户对齐确认,且**会话已绑定单号**(没绑定时请用户去页面绑定——推送和 MR 的机械门禁都查它)。

## 1. 建分支

在 repo/ 里:\`git checkout -b master_<工号>_<单号>\`(如 master_y00965296_DTS2026082001317)。工号/单号以会话开场说明为准。建前确认工作区干净。

## 2. 实施+提交

提交信息**必须**精确匹配 \`[单号][类型] 描述\`(CodeHub pre-receive 钩子会拒收不合规提交):
- 类型白名单:feat/fix/refactor/test/chore/docs/style(修 bug 用 fix);
- 例:\`[DTS2026082001317][fix] 修复登录超时\`;
- \`git add\` 只加本次范围的文件,禁用 \`git add -A\`。

## 3. 推送(平台工具)

\`git push\` 在容器里被禁用(pushurl 指向 /dev/null)——推送必须调 \`push_branch\` 工具。它会校验分支名必须是 master_<工号>_<单号>,从宿主完成传输并复核远端 SHA。

## 4. 换库验证后提 MR

如需环境验证:\`build_deploy\` 部署 → ⚠️停下用 AskUserQuestion 等用户验证结果 → 通过后 \`create_mr\`(title 缺省为 [单号] 问题标题,自动关联单号)。**合入不由你执行**——MR 门禁与合入是用户的决定。

## 边界

- 只改与这张单相关的代码;发现顺带问题,先问用户是另开问题还是本单处理。
- 提 MR 后上报 stage=submit_mr;会话收口由用户归档。
`;

const OPS_SKILL = `---
name: issue-ops
description: 网管环境的日志拉取与换库部署工具用法。需要 fetch_logs 或 build_deploy 时查看。
metadata:
  tags: [issue, ops, logs, deploy]
---

# 网管环境操作(宿主工具)

两个工具都在宿主侧执行,密码由平台保管;你只提供目标参数。

## fetch_logs(services, hosts?)

- 抓 \`/var/log/oss/MAE/<服务名>\` 的**全部内容**(含子目录)到 \`local-logs/<服务名>_<时间戳>/\`;
- hosts 缺省用会话配置的网管环境;
- 大目录耗时较长属正常;完成后直接在 local-logs/ 里 grep,不要把整个日志读进上下文。

## build_deploy(hosts?, include_lib?)

- 构建工作区 repo/ 并部署到目标服务器,部署前自动备份(版本号_bak时间戳);
- **默认只更新 webapps**;\`include_lib=true\` 仅当 pom.xml 依赖版本变更;
- 部署完成后**必须**停下(AskUserQuestion)请用户验证——"程序说部署成功"不等于"验证通过"。

## 失败处理

工具报错会带原始输出:如配置/密码/网络/服务器权限问题,如实呈现给用户,不要盲目重试(尤其部署)。
`;

const SKILLS: Array<{ name: string; body: string }> = [
  { name: "issue-playbook", body: PLAYBOOK_SKILL },
  { name: "issue-research", body: RESEARCH_SKILL },
  { name: "issue-delivery", body: DELIVERY_SKILL },
  { name: "issue-ops", body: OPS_SKILL },
];

/** 把改编技能物化到工作区(幂等重写),返回 SKILL.md 精确路径。 */
export function materializeIssueSkills(workspace: string): string[] {
  const paths: string[] = [];
  for (const skill of SKILLS) {
    const dir = join(workspace, "skills", skill.name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    writeFileSync(path, skill.body, "utf-8");
    paths.push(path);
  }
  return paths;
}

function envLine(state: IssueSessionState): string {
  if (!state.environment) return "未配置网管环境(不能拉日志/换库;纯代码分析可继续)。";
  return `网管环境「${state.environment.name}」: ${state.environment.hosts.join(", ")}`;
}

/** 首轮提示词:把平台注入的事实与行为契约一次说清。 */
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
