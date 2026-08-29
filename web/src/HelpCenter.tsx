import { useEffect, useMemo, useRef, useState } from "react";
import type { AuthUser } from "./api";
import {
  canViewHelpItem,
  filterVisibleHelpItems,
  resolveVisibleHelpItem,
  visibleHelpItemsById,
  type HelpAudience,
} from "./helpAccess";
import { Markdown } from "./markdown";

export type HelpGroup = "快速开始" | "需求与问题" | "团队协作" | "团队资产" | "设置与排障";

export interface HelpScreenshot {
  src: string;
  alt: string;
  caption: string;
}

export interface HelpArticle {
  id: string;
  group: HelpGroup;
  title: string;
  summary: string;
  audience: HelpAudience;
  minutes: number;
  keywords: string[];
  steps: Array<{ title: string; detail: string }>;
  body: string;
  screenshots?: HelpScreenshot[];
  related?: string[];
}

const SHOT_ROOT = "/help";

/**
 * 帮助内容和页面骨架放在一起维护：新增功能时必须同时说明“入口、动作、
 * 后续行为、异常提示”，不能只写按钮说明。截图来自独立演示环境，不含
 * 生产任务、账号或代码内容。
 */
export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: "getting-started",
    group: "快速开始",
    title: "先认识 Mae-Flow",
    summary: "两类工作、两种角色和一条最重要的使用原则。",
    audience: "所有人",
    minutes: 3,
    keywords: ["首页", "导航", "角色", "需求", "问题", "新手"],
    steps: [
      { title: "选对工作入口", detail: "要开发一个需求，就进“我的需求”；要查线上问题或 DTS 问题单，就进“问题处理”。" },
      { title: "先看待我处理", detail: "数字角标和顶部待办会把真正需要你行动的事项排在前面。" },
      { title: "不确定就看明确提示", detail: "Mae-Flow 不替你猜模糊决定；处理不了时会说明原因和下一步。" },
    ],
    body: `## Mae-Flow 是什么
Mae-Flow 是团队的软件交付工作台。开发助手写代码，平台盯住流程和质量，需要你拍板时再来找你。整个过程都能查到，不用在聊天记录里翻来翻去。

| 你要做的事 | 从哪里进入 | 平台负责什么 |
|---|---|---|
| 交付一个明确需求 | **我的需求** | 从澄清、实现、验证推进到交付与合入 |
| 研究一个现象或 DTS 问题单 | **问题处理** | 先查清原因，再判断要不要建单或改代码 |
| 看团队全局 | **团队任务** | 汇总当前现场、阻塞、责任人与交付档案 |
| 沉淀可复用能力 | **团队资产** | 管理知识、业务模块和工作流方案 |

> 核心原则：遇到说不准的事，平台{{red|不会偷偷替你猜}}；做不了的事，也{{red|不会假装做完了}}。需要你决定、运行环境不可用或测试结果不够时，页面会直接告诉你哪里有问题、接下来能怎么做。

## 两种角色
- **开发成员**：发起自己的任务、处理待办、检视协作任务、维护个人接入。
- **管理员**：查看和兜底团队任务，治理团队资产、账号和运行设置。

## 状态怎么看
{{blue|“自动推进中”}}表示开发助手正在工作；{{blue|“待我核对”}}表示任务停在需要你确认的地方；{{red|“需要介入 / 已暂停”}}表示运行出了问题，或者你主动按了暂停；{{green|“待合入 / 完成”}}表示代码和测试结果已经准备好。`,
    screenshots: [{
      src: `${SHOT_ROOT}/01-overview.png`,
      alt: "Mae-Flow 开发成员首页，标注了我的需求、问题处理和待办入口",
      caption: "开发成员首页：①需求交付入口；②问题研究入口；③真正需要行动的待办。",
    }],
    related: ["launch-requirement", "handle-waiting"],
  },
  {
    id: "launch-requirement",
    group: "需求与问题",
    title: "发起一个需求任务",
    summary: "用尽量少的必填信息启动任务，知识自动匹配，工作流按需定制。",
    audience: "开发成员",
    minutes: 4,
    keywords: ["发起", "需求", "代码仓", "模块", "语言", "知识", "工作流", "高级设置"],
    steps: [
      { title: "说清目标与代码仓", detail: "填写要解决的问题、验收预期，并选择本次涉及的代码仓。" },
      { title: "确认业务模块与技术语言", detail: "首次选择会保存在系统里；它们用于自动匹配团队知识。" },
      { title: "按需选择工作流", detail: "普通任务直接采用平台默认；明确知道阶段能力编排时再选择团队工作流。" },
      { title: "启动并等待现场形成", detail: "创建后进入“我的需求”，平台会克隆仓库、准备环境并开始推进。" },
    ],
    body: `## 必填信息为什么不折叠
任务目标、代码仓、业务模块和技术语言会直接影响执行与知识匹配，因此它们始终在主流程里展示。补充说明和工作流选择属于按需项，不会挡住普通用户直接启动。

## 知识如何进入任务
团队知识{{blue|不需要手工一条条勾选}}。创建任务时，平台会根据业务模块和开发语言自动挑选相关知识，先给开发助手一份简短目录，里面只有标题、说明和打开方式。真正需要哪一篇，开发助手再去读正文，{{green|不会一上来把所有文档全塞进去}}。

任务创建后，这份知识名单就不再变化。以后恢复、重跑或拆分任务，仍用原来的名单，避免做到一半突然换了一套知识。

## 工作流什么时候选
- 不知道要怎么定制：直接用平台默认流程，它会保证基本步骤和质量检查都在。
- 团队已经有合适方案：直接选它。任务会记住你当时选的是哪个版本。
- 你很清楚每一步该怎么做：先复制一份方案，再安排每个阶段要用的提示、知识、工具和可直接执行的做法（Skill）。

> 工作流定制{{red|不能跳过}}必须做的步骤、真实测试和需要人确认的决定，也不能越过代码仓权限。`,
    screenshots: [{
      src: `${SHOT_ROOT}/02-launch.png`,
      alt: "发起新任务界面，标注需求信息、代码仓与自动知识匹配区域",
      caption: "发起任务：①描述目标；②选择真实代码仓；③确认匹配依据；④普通任务可直接启动。",
    }],
    related: ["knowledge-assets", "workflow-assets", "requirement-workspace"],
  },
  {
    id: "requirement-workspace",
    group: "需求与问题",
    title: "读懂需求任务工作台",
    summary: "在一个页面看进度、文档、代码、检视意见、测试和交付结果。",
    audience: "开发成员",
    minutes: 5,
    keywords: ["任务", "工作台", "进度", "材料", "代码", "diff", "暂停", "继续", "交付"],
    steps: [
      { title: "先看当前状态", detail: "页头说明现在进行到哪里，以及系统是在执行、等待你，还是需要介入。" },
      { title: "沿阶段轨迹定位", detail: "阶段轨迹展示已完成、当前和后续节点，不用翻聊天记录猜进度。" },
      { title: "在材料区做决定", detail: "方案、文档、代码差异、测试与交付清单都在同一工作台审阅。" },
      { title: "暂停后等明确回执", detail: "点击暂停会先显示“正在暂停”，服务端确认后显示“已暂停”，不会把等待误装成卡死。" },
    ],
    body: `## 工作台不是聊天窗口
聊天内容只是开发助手的过程说明。判断任务有没有真的做完，要看当前做到哪一步、页面里的文档和代码、真实测试结果以及你的批注。

## 你能在这里做什么
- 查看需求文档、方案、流程图、代码差异、测试结果和流水线状态。
- 对具体段落或代码行加批注，开发助手会知道你说的是哪一段、哪一行。
- 需要你确认时，可以选现成答案，也可以自己写清楚要求。
- 可以主动暂停、恢复、从头重跑，或邀请代码检视人帮你看。

## “继续”之后会怎样
确认没问题后，开发助手会进入下一步；如果你提交了批注或补充说明，它会先按意见修改，再把新结果交给你检查。最终要提交的文件发生变化时，平台会重新问你，不能拿之前的确认继续放行。

> 不要用“继续”表达新的修改意见。先写批注或补充说明再提交，页面会明确显示意见是否送达。`,
    screenshots: [{
      src: `${SHOT_ROOT}/03-task-workspace.png`,
      alt: "需求任务工作台，标注状态、阶段轨迹、材料页签和操作区",
      caption: "任务工作台：①当前状态；②阶段轨迹；③材料与检视；④暂停、继续和交付操作。",
    }],
    related: ["handle-waiting", "review-and-notify", "team-dashboard"],
  },
  {
    id: "handle-waiting",
    group: "需求与问题",
    title: "处理待办、批注与自由回复",
    summary: "明确区分选择、补充意见和模糊表达，保证决定真的生效。",
    audience: "开发成员",
    minutes: 4,
    keywords: ["待办", "决定", "批注", "自由回复", "继续", "确认", "提交不了", "状态变化"],
    steps: [
      { title: "逐题检查待办", detail: "多项问题会完整展示并逐项收集答案，不会只提交第一题。" },
      { title: "选项不合适就自由回复", detail: "选择“自由回复”并写清具体答案或修改要求。" },
      { title: "有意见就先写清楚", detail: "批注和补充说明会先送给开发助手；它改完以后，再回来请你确认。" },
      { title: "状态冲突时刷新事实", detail: "别人已经决定或任务已经推进时，页面会保留你的文字并说明最新状态，而不是吞掉提交。" },
    ],
    body: `## 选择和意见是两种不同动作
{{blue|选择}}决定任务接下来往哪走；{{blue|批注 / 补充说明}}是让开发助手修改当前结果。提交意见后，系统会先安排修改，{{green|不会把这次提交当成“确认通过”}}。

## 多个问题如何回答
页面逐题展示全部问题；小鲁班文本入口也会逐题收集，全部答完后一次提交。全是选项题时可按提示一次回复多个序号。

## 自由回复
当预设选项表达不了你的意思时，切换自由回复并写出明确结论。平台不会猜“差不多”“你看着办”等模糊表达；它会保留原话并提示怎样补充到可执行。

## 为什么会提示“任务状态已变化”
人工决定采用先到生效。若另一个页面、通知入口或协作者已经完成同一待办，旧页面不能覆盖新事实。刷新后会展示最新决定；尚未送达的补充意见会保留，允许按新的任务状态重新提交。`,
    screenshots: [{
      src: `${SHOT_ROOT}/04-decision.png`,
      alt: "人工决定卡片，标注问题列表、自由回复和提交区域",
      caption: "需要你确认时：①检查问题；②选择现成选项；③选项不合适就自己写；④提交这次决定。",
    }],
    related: ["review-and-notify", "requirement-workspace"],
  },
  {
    id: "issue-flow",
    group: "需求与问题",
    title: "处理问题与 DTS 问题单",
    summary: "先研究事实，再决定建单、修复或给出“不是问题”的结论。",
    audience: "开发成员",
    minutes: 4,
    keywords: ["问题", "DTS", "日志", "定位", "固定流程", "自由探索"],
    steps: [
      { title: "从问题处理发起", detail: "描述现象、影响和已有线索；有 DTS 单号时一并提供。" },
      { title: "选择怎么查", detail: "默认按固定步骤查问题；你对排查方法很熟时，可以在个人设置里切换为自由探索。" },
      { title: "补充真实材料", detail: "按提示提供日志、环境、复现路径或选择目标代码仓。" },
      { title: "接受诚实结论", detail: "定位结果可以是缺陷、配置、使用问题，也可以是证据表明“不是问题”。" },
    ],
    body: `## 它和需求交付有什么不同
需求通常从目标出发推进实现；问题处理从现象出发探索原因。Mae-Flow 不要求一开始就假定必须改代码，也不会为了“有结果”强行建问题单。

## 两种探索方式
- **固定流程（默认）**：平台按研究阶段推进，在关键节点等你确认，适合大多数问题。
- **自由探索**：开发助手自己安排排查顺序，适合已经很清楚该从哪里查起的人。

切换只影响之后新建的问题会话，进行中的会话不会中途变轨。

## 工具与权限
拉日志、构建部署、读取 DTS 和代码仓，都通过平台提供的专用工具完成。密码不会出现在聊天内容里；工具失败时，页面会显示真实原因，并告诉你还缺什么。`,
    screenshots: [{
      src: `${SHOT_ROOT}/05-issues.png`,
      alt: "问题处理页面，标注新建问题、会话列表和当前研究现场",
      caption: "问题处理：①发起研究；②从会话列表回到现场；③按事实补充材料或确认研究结论。",
    }],
    related: ["personal-settings", "troubleshooting"],
  },
  {
    id: "review-and-notify",
    group: "团队协作",
    title: "邀请检视与小鲁班通知",
    summary: "让意见可靠送达，让手机回复不会因为插件未激活而悄悄失效。",
    audience: "开发成员",
    minutes: 4,
    keywords: ["检视", "review", "Committer", "小鲁班", "通知", "/mfc", "手机", "回复"],
    steps: [
      { title: "在任务中邀请检视", detail: "选择代码检视人后，任务会进入对方的“待我检视”，页面也会告诉你通知有没有送到。" },
      { title: "检视人提交意见", detail: "可以在具体内容上批注，也可以写一段整体意见；意见会先交给开发助手修改。" },
      { title: "手机先激活插件", detail: "每条通知都会提示先输入 /mfc 激活；未激活的普通回复不会进入 Mae-Flow。" },
      { title: "按上下文回复", detail: "唯一待办可直接回复；多项待办按通知中的审批码选择，模糊输入会得到明确提示。" },
    ],
    body: `## 检视闭环
责任人发出邀请后，代码检视人会在“我的需求 → 待我检视”看到任务。批注提前送达，或者在最终确认时又补了新意见，都能正常交给开发助手。即使原来的确认已经被别人点过，也不会因此把新意见丢掉。

## 小鲁班手机回复的前置条件
手机端{{red|必须先输入 /mfc}}激活 Mae-Flow 插件。通知正文固定包含这条提示；如果内网插件还没接通回复能力，通知只提供网页入口，{{green|不会谎称“回复 1 即可”}}。

## 多项待办和自由回复
- 只有一项待办：激活后可回复选项序号、确认语句或具体修改意见。
- 多项待办：先选择任务，或携带通知中的审批码。
- 多问题卡：逐题收集，全部答完后才提交。
- 选项不合适：回复通知提示中的“自由回复”格式。

> 无法唯一理解时，插件不会猜测或伪造成功，会明确列出仍缺什么。`,
    related: ["handle-waiting", "personal-settings"],
  },
  {
    id: "team-dashboard",
    group: "团队协作",
    title: "查看团队任务与交付档案",
    summary: "用当前现场管理行动，用交付档案回看结果。",
    audience: "所有人",
    minutes: 3,
    keywords: ["团队", "动态", "阶段", "筛选", "负责人", "档案", "MR"],
    steps: [
      { title: "当前现场看行动", detail: "优先关注等待决定、阻塞和异常任务，不把已完成记录铺满首页。" },
      { title: "点击阶段做筛选", detail: "阶段分布可以直接筛出对应任务，避免图表只看不能用。" },
      { title: "打开任务看详情", detail: "管理员可以进入任意任务帮忙处理；普通成员也能查看团队进展，但不能替别人做决定。" },
      { title: "交付档案看结果", detail: "等待合并、已经完成、失败和取消的任务集中放在这里，并保留合并申请和过程记录。" },
    ],
    body: `## 两个视图各回答一个问题
- **当前现场**：现在谁在做什么、哪里卡住、下一步谁行动。
- **交付档案**：最后交付了什么、测试和合并申请在哪里、为什么失败或取消。

首页不会平铺所有动态。阶段分布承担筛选入口，任务列表承担行动，档案承担追溯，三者避免重复展示同一份信息。

## 权限
所有成员都可以了解团队任务；真正影响任务走向的决定，仍然只有责任人和管理员能提交。别人发给你一个任务链接，并不会让你突然拥有操作权限。`,
    screenshots: [{
      src: `${SHOT_ROOT}/06-team-dashboard.png`,
      alt: "团队任务页面，标注当前现场、阶段筛选和交付档案",
      caption: "团队任务：①当前现场；②阶段与行动筛选；③需要行动的任务；④交付档案。",
    }],
    related: ["requirement-workspace", "knowledge-assets"],
  },
  {
    id: "knowledge-assets",
    group: "团队资产",
    title: "治理知识与业务模块",
    summary: "平台管理团队知识和业务模块；代码仓里的文档仍然跟着代码一起管理。",
    audience: "所有人",
    minutes: 5,
    keywords: ["知识", "Skill", "文档", "业务", "工程", "模块", "语言", "作用域", "仓内"],
    steps: [
      { title: "先判断知识性质", detail: "每项知识必须且只能属于“业务”或“工程”，混合内容应拆分。" },
      { title: "填写强制作用域", detail: "业务知识选择一个或多个业务模块；工程知识选择一种或多种语言。" },
      { title: "发布后自动匹配", detail: "业务模块或开发语言对得上的知识会自动进入任务，不用发起人一条条勾选。" },
      { title: "根据真实使用继续改", detail: "管理员可以看哪些知识被找到、被读过、有没有帮助，修改后再发布；老任务继续用原来的版本。" },
    ],
    body: `## 一个统一的知识资产模型
每项资产都有两个正交维度：

| 维度 | 可选值 | 用来回答什么 |
|---|---|---|
| 性质 | 业务 / 工程 | 这份知识在解释业务，还是指导技术实现 |
| 形式 | 文档 / Skill / 规则 / 示例 | 开发助手应该怎么使用它 |

业务知识必须选择业务模块（支持多选）；工程知识必须选择语言（支持多选）。标签不完整的历史资产会显示“未治理 · 不会匹配”，直到管理员补齐。

## 模块是一个抽屉
业务模块维护模块语义、边界和相关业务知识；某项知识若只适用于特定代码仓，还可以带代码仓范围。模块本身不是工程分类，Java、C++、JavaScript 等属于工程语言维度。

## 仓内知识不归平台管
业务仓里的 AGENTS.md、docs、.claude、.cac 等内容跟着代码仓自己管理。Mae-Flow 不扫描、不收进团队资产，也不会让发起人再选一遍；开发助手进入代码仓后，按仓库里的说明自己查找和使用。

## Skill 只是知识的一种用法
Skill 可以理解为“能直接交给开发助手照着做的知识”。它可以只讲业务，也可以只讲工程做法。如果一个 Skill 同时把业务规则和代码实现绑死在一起，应该拆成两份，让平台根据任务把它们组合起来。`,
    screenshots: [{
      src: `${SHOT_ROOT}/07-assets.png`,
      alt: "团队资产页面，标注知识资产、业务模块和工作流方案三个抽屉",
      caption: "团队资产：①知识及使用效果；②业务模块语义；③可复用工作流方案。",
    }, {
      src: `${SHOT_ROOT}/07-knowledge-form.png`,
      alt: "知识编辑表单，标注知识性质、业务模块或开发语言、呈现形式和治理提示",
      caption: "知识入库：①业务和工程二选一；②选择业务模块或开发语言；③选择呈现形式；④标签没填全就不会自动匹配。",
    }],
    related: ["launch-requirement", "workflow-assets"],
  },
  {
    id: "workflow-assets",
    group: "团队资产",
    title: "创建、发布和复用工作流",
    summary: "平台默认流程保证基本质量；熟悉流程的人可以把每一步安排得更细。",
    audience: "所有人",
    minutes: 6,
    keywords: ["工作流", "定制", "复制", "保存", "发布", "删除", "归档", "阶段", "Skill", "工具"],
    steps: [
      { title: "从现有方案复制", detail: "优先复制平台或团队现有方案，再在自己的草稿里修改，不用从空白开始。" },
      { title: "把每一步安排清楚", detail: "明确这一阶段要用哪些提示、知识、工具和可直接执行的做法（Skill）。" },
      { title: "预览顺序和前后关系", detail: "编辑页先给你看大致结果；创建任务时，平台还会再做一次完整检查。" },
      { title: "检查后发布", detail: "发布过的版本不能覆盖；不用的方案可以归档，老任务仍然能查到它。" },
    ],
    body: `## 定制面向谁
普通用户不需要打开工作流编辑器，直接用默认流程就行。只有当你非常清楚每个阶段要做什么、用什么知识和工具时，才需要自己定制。

## 默认和定制如何相处
定制不会简单地和默认内容堆在一起，也不能把平台的基本流程换掉。必须经过哪些阶段、做到什么才算完成、要跑哪些真实检查、谁有权限做决定，这些底线不能改。你只能在允许的范围里安排每一步怎么做。两边有冲突时，页面会直接指出来。

## 一个方案有四种常见操作
- **保存草稿**：可以反复修改。两个页面同时编辑时，平台会阻止旧页面覆盖新内容。
- **发布版本**：发布后内容不再改变，新任务可以选择它。
- **复制方案**：完整复制出一份新草稿，同时记住它是从哪里复制来的。
- **归档方案**：新任务不再看到它，但老任务和历史版本仍然保留。

## 为什么没有直接删除已发布方案
已发布的工作流可能已经被任务用过。如果直接删掉，以后就说不清老任务当时按什么做的，所以页面提供“归档”。只有从未发布、也从未被任务使用的草稿，才适合彻底删除。`,
    screenshots: [{
      src: `${SHOT_ROOT}/08-workflows.png`,
      alt: "工作流方案页面，标注方案列表、复制编辑入口和发布状态",
      caption: "工作流资产：①搜索或选择方案；②复制成新草稿；③查看版本状态；④进入详情或编辑。",
    }, {
      src: `${SHOT_ROOT}/08-workflow-editor.png`,
      alt: "工作流编辑页面，标注阶段列表、阶段能力、顺序预览和保存发布操作",
      caption: "工作流编辑：①选择阶段；②安排本阶段要用的能力；③检查前后顺序；④保存草稿或发布版本。",
    }],
    related: ["launch-requirement", "knowledge-assets"],
  },
  {
    id: "wish-wall",
    group: "团队协作",
    title: "在许愿墙提出诉求或问题",
    summary: "让建议从“有人提过”走到接纳、实施和闭环。",
    audience: "所有人",
    minutes: 3,
    keywords: ["许愿墙", "问题", "诉求", "图片", "粘贴", "接纳", "闭环"],
    steps: [
      { title: "选择诉求或问题", detail: "先分类，便于维护者区分能力建议和真实使用故障。" },
      { title: "写清场景与影响", detail: "说明你当时要做什么、发生了什么、期望怎样。" },
      { title: "直接粘贴截图", detail: "在编辑区粘贴剪贴板图片，提交前可预览和移除。" },
      { title: "跟踪处理状态", detail: "待接纳、已接纳、已闭环和未接纳都会保留明确说明。" },
    ],
    body: `## 什么适合放在许愿墙
- 让工作更顺手的产品诉求。
- 遇到的错误、卡顿、提示不明确或流程割裂。
- 对任务执行安排的反馈；从任务工作台发起时，平台会自动带上当时使用的方案、阶段和版本。

## 好反馈的三个要素
1. 当时想完成什么。
2. 实际发生了什么，造成什么影响。
3. 你期待的行为是什么。

截图可以直接粘贴并预览。不要上传密码、访问凭据、客户数据或没有隐去敏感内容的生产日志。

## 状态不是装饰
{{blue|待接纳}}表示正在评估；{{blue|已接纳}}表示方向确认但未必已经上线；{{green|已闭环}}表示已经有可验证结果；{{red|未接纳}}必须附理由。评论和状态变化都会留在同一张卡片上。`,
    screenshots: [{
      src: `${SHOT_ROOT}/09-wish-wall.png`,
      alt: "许愿墙页面，标注创建入口、图片粘贴区和状态筛选",
      caption: "许愿墙：①选择诉求或问题；②写清场景、实际与期望；③粘贴截图；④按状态跟踪。",
    }],
    related: ["troubleshooting", "workflow-assets"],
  },
  {
    id: "personal-settings",
    group: "设置与排障",
    title: "配置个人接入与人工介入程度",
    summary: "一次设置好确认频率、代码仓身份、小鲁班通知和查问题的方式。",
    audience: "开发成员",
    minutes: 4,
    keywords: ["个人设置", "人工介入", "月光", "全自动", "Git", "CodeHub", "小鲁班", "Token"],
    steps: [
      { title: "选择人工介入程度", detail: "从全程把关到全自动，一处设置控制之后新节点的停留方式。" },
      { title: "配置代码身份", detail: "提交邮箱和 CodeHub 访问凭据用于拉代码、提交、创建合并申请和确认检视身份。" },
      { title: "配置小鲁班", detail: "保存个人通知凭据并测试送达；手机回复仍需先 /mfc 激活插件。" },
      { title: "选择问题探索方式", detail: "默认固定流程，需要时切换自由探索；只影响新问题会话。" },
    ],
    body: `## 人工介入程度
四档设置其实只回答两个问题：任务做到中间要不要停下来问你，推送前要不要让你确认最终要提交的文件。无论选哪一档，流水线都必须检查当前这版代码，合并申请也仍然要由人来合并。“全自动”不会关掉这些基本检查。

切换到自动时，默认只影响后续节点。若当前已有可处理待办，页面会明确询问是否一并处理；含检视意见的待办不会自动放行。

## 个人接入
- **CodeHub**：用于拉代码、提交、推送、创建合并申请和确认检视人；页面只会显示隐去敏感内容后的提示。
- **小鲁班**：用于待办与状态通知；测试通知只验证送达，不代表手机回复插件已经激活。

凭据保存失败、权限不足或服务端能力未配置时，发起入口会明确指出缺少哪一项，并提供返回个人设置的快捷入口。`,
    screenshots: [{
      src: `${SHOT_ROOT}/10-personal-settings.png`,
      alt: "个人设置页面，标注人工介入程度、问题探索方式和个人接入",
      caption: "个人设置：①选择人工介入程度；②选择问题探索方式；③配置 CodeHub；④配置小鲁班通知。",
    }],
    related: ["review-and-notify", "troubleshooting"],
  },
  {
    id: "administration",
    group: "设置与排障",
    title: "管理账号与服务设置",
    summary: "管理员集中维护账号、模型、运行策略和能力自检。",
    audience: "管理员",
    minutes: 4,
    keywords: ["管理员", "账号", "密码", "模型", "服务设置", "图片识别", "部署", "团队约定"],
    steps: [
      { title: "账号管理", detail: "创建开发或管理员账号、重置密码，离职账号按提示安全移除。" },
      { title: "模型与图片识别", detail: "配置主模型和独立视觉模型后，用页面自检验证真实能力。" },
      { title: "团队运行策略", detail: "维护团队级执行约定、保留期、缓存与部署相关设置。" },
      { title: "先自检再开放", detail: "配置存在不等于能力可用，页面以真实探测结果决定是否就绪。" },
    ],
    body: `## 账号管理
管理员创建本地账号并分配角色。开发账号进入个人工作台；管理员进入团队全局。重置密码不要求旧密码，因此只应授予可信管理员。

## 服务设置
服务设置管的是整个平台，不管个人账号的访问凭据。主模型、图片识别模型、团队统一约定，以及任务文件保留多久，都在这里维护。页面会实际检查服务能不能用，不能只看“已经填了配置”。

## 设置的生效范围
页面会说明一项设置是立刻生效、只影响以后新建的任务，还是需要重启服务。已经进行中的任务尽量沿用创建时的设置，避免管理员改了全局配置后，任务做到一半突然换规则。`,
    screenshots: [{
      src: `${SHOT_ROOT}/11-administration.png`,
      alt: "管理员服务设置页面，标注模型能力自检、团队约定和文件保留设置",
      caption: "服务设置：①配置模型和图片识别；②用真实检查确认能用；③维护团队统一约定；④设置任务文件和构建缓存保留时间。",
    }],
    related: ["team-dashboard", "knowledge-assets"],
  },
  {
    id: "troubleshooting",
    group: "设置与排障",
    title: "常见问题与自助排障",
    summary: "先判断是在安全等待、环境失败，还是需要补充明确输入。",
    audience: "所有人",
    minutes: 5,
    keywords: ["FAQ", "排障", "卡死", "暂停", "超时", "编译", "编译超时", "知识", "回复", "流程图", "PlantUML"],
    steps: [
      { title: "先看页面写了什么", detail: "页面会分清正在处理、已经暂停、正在自动工作、等你确认和运行失败，不需要靠转圈动画猜。" },
      { title: "打开任务现场", detail: "查看最近事件、工具结果和明确错误，不把一条通知当完整诊断。" },
      { title: "按提示补充最小事实", detail: "缺仓库、模块、语言、日志或唯一决定时，只补它明确要求的内容。" },
      { title: "仍不合理就投许愿墙", detail: "带上任务链接、发生时间和脱敏截图，维护者可以追到同一现场。" },
    ],
    body: `## 点击暂停后像卡住了
暂停需要等当前安全边界确认。按钮会先显示“正在暂停”，成功后显示“已暂停”；如果请求失败，会恢复可点击并展示原因。不要连续刷新或重复点击制造更多请求。

## C++ 全量编译超过 600 秒
这通常不是“服务器坏了”，而是给这次编译的时间不够。平台应该保留能继续使用的运行环境，并说明编译还在进行，还是已经超时。这个代码仓可以单独设置更长时间、只编译受影响模块，或提前把依赖下载好。只把报错写清楚，还不算解决问题。

## 团队知识没有自动匹配
检查这份知识是否已经发布、是否明确选了“业务”或“工程”、业务模块或开发语言有没有填完整，以及创建任务时选的模块和语言能不能对上。标签没补齐的知识不会参加匹配；任务开始后再改标签，也不会中途换掉它原来的知识名单。

## 小鲁班回复没有生效
先确认手机端已经输入 **/mfc** 激活插件，再检查是否有多个待办需要审批码。网页里查看决定是否已经由其他入口先提交；模糊回复不会被静默当成成功。

## PlantUML 显示语法不支持
活动图和用例图可能都包含 actor 等语句，不能只按关键字武断分类。页面会尝试受支持的 4+1 视图渲染；无法安全识别时保留源码并显示具体不支持的行，避免画错图。`,
    related: ["wish-wall", "personal-settings", "handle-waiting"],
  },
];

export function findHelpArticle(
  id: string | undefined,
  audience?: AuthUser["role"],
): HelpArticle {
  return resolveVisibleHelpItem(HELP_ARTICLES, id, audience) ?? HELP_ARTICLES[0];
}

export function filterHelpArticles(query: string, audience?: AuthUser["role"]): HelpArticle[] {
  const needle = query.trim().toLocaleLowerCase();
  return filterVisibleHelpItems(HELP_ARTICLES, audience).filter((article) => {
    if (!needle) return true;
    return [article.title, article.summary, article.group, article.body,
      ...article.keywords, ...article.steps.flatMap((step) => [step.title, step.detail])]
      .join("\n").toLocaleLowerCase().includes(needle);
  });
}

const GROUPS: HelpGroup[] = ["快速开始", "需求与问题", "团队协作", "团队资产", "设置与排障"];

const QUICK_LINKS = [
  { id: "launch-requirement", number: "01", title: "我要发起需求", detail: "从描述目标到启动任务" },
  { id: "handle-waiting", number: "02", title: "我要处理待办", detail: "选择、批注与自由回复" },
  { id: "knowledge-assets", number: "03", title: "我要治理资产", detail: "知识、模块与工作流" },
];

function SearchIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden><circle cx="8.5" cy="8.5" r="5.5" /><path d="m12.5 12.5 4 4" /></svg>;
}

function ArticleScreenshot({ shot }: { shot: HelpScreenshot }) {
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setExpanded(false);
      } else if (event.key === "Tab") {
        // 预览里只有一个可操作控件；把焦点留在关闭按钮上，避免键盘
        // 用户误入被遮罩的页面内容。
        event.preventDefault();
        closeButtonRef.current?.focus();
      }
    }
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      openButtonRef.current?.focus();
    };
  }, [expanded]);

  function hideOnError() {
    setExpanded(false);
    setFailed(true);
  }

  if (failed) return null;
  return <>
    <figure className="help-shot">
      <button ref={openButtonRef} type="button" className="help-shot-frame"
        onClick={() => setExpanded(true)} aria-label={`放大查看：${shot.alt}`}>
        <img src={shot.src} alt={shot.alt} loading="lazy" onError={hideOnError} />
        <span className="help-shot-zoom" aria-hidden>放大查看</span>
      </button>
      <figcaption><span aria-hidden>↳</span>{shot.caption}</figcaption>
    </figure>

    {expanded && <div className="help-lightbox-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) setExpanded(false);
      }}>
      <section className="help-lightbox" role="dialog" aria-modal="true"
        aria-label={`图片预览：${shot.alt}`}>
        <header>
          <div><strong>图片预览</strong><small>点击背景或按 Esc 关闭</small></div>
          <button ref={closeButtonRef} type="button" className="help-lightbox-close"
            onClick={() => setExpanded(false)} aria-label="关闭图片预览">×</button>
        </header>
        <div className="help-lightbox-image">
          <img src={shot.src} alt={shot.alt} onError={hideOnError} />
        </div>
        <p>{shot.caption}</p>
      </section>
    </div>}
  </>;
}

export function HelpCenter({ viewer, initialArticleId, onArticleChange }: {
  viewer: AuthUser;
  initialArticleId?: string;
  onArticleChange?: (articleId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(
    () => findHelpArticle(initialArticleId, viewer.role).id);
  const articles = useMemo(
    () => filterHelpArticles(query, viewer.role), [query, viewer.role]);
  const article = findHelpArticle(selectedId, viewer.role);
  const quickLinks = QUICK_LINKS.filter((item) => {
    const target = HELP_ARTICLES.find((candidate) => candidate.id === item.id);
    return target && canViewHelpItem(target, viewer.role);
  });
  const relatedArticles = visibleHelpItemsById(
    HELP_ARTICLES, article.related ?? [], viewer.role);

  // App 的 popstate 会更新 initialArticleId；组件必须跟着切文章，不能只在
  // 第一次挂载时读一次。无权限或坏 id 同时规范成该角色可见的安全回退。
  useEffect(() => {
    const next = findHelpArticle(initialArticleId, viewer.role);
    setSelectedId(next.id);
    if (initialArticleId && initialArticleId !== next.id
        && /^\/help(?:\/|$)/.test(location.pathname)) {
      history.replaceState({}, "", `/help/${encodeURIComponent(next.id)}`);
    }
  }, [initialArticleId, viewer.role]);

  function select(id: string) {
    const next = findHelpArticle(id, viewer.role);
    setSelectedId(next.id);
    setQuery("");
    onArticleChange?.(next.id);
    document.querySelector(".workspace")?.scrollTo({ top: 0, behavior: "smooth" });
  }

  return <section className="help-center" aria-label="Mae-Flow 使用帮助">
    <div className="help-hero">
      <div>
        <span className="section-kicker">FAQ &amp; PRODUCT GUIDE</span>
        <h2>从“我现在要做什么”开始</h2>
        <p>功能说明、真实界面和异常处理都在这里。搜索动作、状态或你看到的提示。</p>
      </div>
      <label className="help-search">
        <SearchIcon />
        <span className="sr-only">搜索使用帮助</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder="例如：暂停、/mfc、自动匹配、工作流…" />
        {query && <button type="button" onClick={() => setQuery("")}
          aria-label="清空搜索">×</button>}
      </label>
    </div>

    {!query && <div className="help-quick" aria-label="常用帮助">
      {quickLinks.map((item) => <button type="button" key={item.id}
        onClick={() => select(item.id)}>
        <span>{item.number}</span><strong>{item.title}</strong><small>{item.detail}</small>
      </button>)}
    </div>}

    <div className="help-layout">
      <aside className="help-index" aria-label="帮助目录">
        {query ? <>
          <div className="help-index-heading"><span>搜索结果</span><b>{articles.length}</b></div>
          {articles.length === 0 && <div className="help-no-result">
            <strong>没有直接匹配</strong>
            <p>试试更短的词，或到许愿墙描述你遇到的场景。</p>
          </div>}
          {articles.map((item) => <button type="button" key={item.id}
            onClick={() => select(item.id)} className={item.id === article.id ? "active" : ""}>
            <strong>{item.title}</strong><small>{item.summary}</small>
          </button>)}
        </> : GROUPS.map((group) => {
          const items = articles.filter((item) => item.group === group);
          if (items.length === 0) return null;
          return <div className="help-index-group" key={group}>
            <div className="help-index-heading"><span>{group}</span><b>{items.length}</b></div>
            {items.map((item) => <button type="button" key={item.id}
              onClick={() => select(item.id)} className={item.id === article.id ? "active" : ""}>
              <strong>{item.title}</strong>
            </button>)}
          </div>;
        })}
      </aside>

      <article className="help-article">
        <header className="help-article-head">
          <div className="help-breadcrumb"><span>{article.group}</span><i>／</i><span>{article.audience}</span></div>
          <h2>{article.title}</h2>
          <p>{article.summary}</p>
          <div className="help-meta"><span>{article.minutes} 分钟读完</span><span>{article.steps.length} 个关键步骤</span></div>
        </header>

        {article.screenshots?.map((shot) => <ArticleScreenshot key={shot.src} shot={shot} />)}

        <section className="help-steps" aria-labelledby="help-steps-title">
          <div className="help-section-title"><span>照着做</span><h3 id="help-steps-title">关键步骤</h3></div>
          <ol>{article.steps.map((step, index) => <li key={step.title}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div><strong>{step.title}</strong><p>{step.detail}</p></div>
          </li>)}</ol>
        </section>

        <div className="help-rich-text"><Markdown text={article.body} /></div>

        {relatedArticles.length > 0 && <footer className="help-related">
          <span>接着看</span>
          <div>{relatedArticles.map((related) => {
            return <button type="button" key={related.id}
              onClick={() => select(related.id)}>
              <strong>{related.title}</strong><small>{related.summary}</small><i aria-hidden>→</i>
            </button>;
          })}</div>
        </footer>}
      </article>

      <aside className="help-toc" aria-label="本页重点">
        <span>本页重点</span>
        <ol>{article.steps.map((step, index) => <li key={step.title}>
          <i>{index + 1}</i><span>{step.title}</span>
        </li>)}</ol>
        <div className="help-principle"><strong>还是处理不了？</strong><p>到许愿墙提交场景、任务链接和脱敏截图。平台会明确标记是否接纳与何时闭环。</p></div>
      </aside>
    </div>
  </section>;
}
