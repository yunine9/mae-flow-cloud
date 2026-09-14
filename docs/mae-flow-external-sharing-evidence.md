# 对外分享稿：内部核对底稿

本文件供维护者核对，不作为对外正文。正文见 [对外分享稿](mae-flow-external-sharing.md)。

## 核对范围

- 日期：2026-08-14 至 2026-09-14，按当前 checkout 可达历史、Git `--since/--until` 过滤；不是只统计 main 第一父链。
- 初次核对代码 HEAD：`c0b09be`。
- 上述时间范围初次统计非合并提交 1,265 条。包含不同开发分支可达记录，可能有同内容重复提交，因此正文不把数量当作成果或提效证明。
- 本次是代码、设计记录与提交历史梳理，没有连接生产系统，没有巡检生产任务，没有重跑测试，没有发布或部署。
- 默认读者：研发同行与技术负责人。此为撰稿假设，尚待分享者确认。
- 写作要求：用户明确要求“不能有 AI 味”，并进一步明确想法比功能介绍更重要、务虚部分可以更多。正文改为围绕工作单位、注意力、AI 自主权、流程收益、团队共同理解、知识积累与信任展开；重点保留全局设计与模块分工、检视与人工介入、交付反馈修复、知识资产与记忆；按用户要求不介绍问题单处理；功能用来解释观点如何落地，不展开完整清单。
- 文中的观点是基于代码取舍和用户方向整理的分享表达，不将其冒充逐字访谈记录；不新增未经核实的创始经历、客户案例或成效数字。

## 术语口径

用户要求使用专业术语，明确指出应使用 Skill。正文使用 Skill 与 Workflow 表达方法复用和工作组织，并采用 Prompt、Agent、Owner、Spec、Story、MR、CI、Code Review、Task Memory 等术语；按用户反馈移除 Playbook 与中英文括号释义。专业术语用于准确指代已有概念，不扩写尚未实现的技术能力。

## 用户确认的定位

用户原话：“平台的初衷 是。从个人提效 到组织提效的ai工程能力构建”。

正文据此将组织级 AI 工程能力设为主线；需求交付是切入点，方法共享、协作接续、知识积累与结果反馈是展开方向。组织提效是建设目标，不表述为已测量的成效。

## 正文主张与核对入口

| 主张 | 当前代码/文档入口 | 代表提交 |
| --- | --- | --- |
| 从云端会话接入到交付链路 | `src/sessionDriver.ts`、`src/taskService.ts`、`src/gitPlatform.ts` | `529025b`（8/14 Git 交付）、`df6c433`（8/17 MR 闭环） |
| 单仓与跨仓需求统一组织 | `src/taskService.ts`、`src/requirementPlan.ts` | `4517a64`（8/19 单多仓统一） |
| 全局 Story、模块拆分与责任人检视 | `src/requirementPlan.ts`、`src/overallStoryStore.ts`、`docs/module-delivery-redesign-2026-09-09.md` | `bfefe46`（9/9） |
| 路径是参考，公共准备按需安排 | 同上；README 最前方 9/9 更新 | `bfefe46` |
| 按影响提前启动子任务 | `src/dependencyScheduling.ts`、`src/taskService.ts`、`src/server.ts`、`docs/task-early-start.md` | `4ca0a81`（9/12）、`cc3d6f6`（恢复标记修复） |
| 用户原话进入后续任务上下文 | `docs/owner-decision-consistency.md`、`src/taskHostTools.ts` | `574abd0`（9/12）、`25fb7d3` |
| 意见回执与责任人处置区分 | `src/annotations.ts`、`src/feedbackPolicy.ts`、`src/taskHostTools.ts`、模块交付设计第 6 节 | `bfefe46`、`0135840`（9/12 统一检视决定） |
| 真实远端事实与 MR 持续检视 | `docs/remote-delivery-reconciliation.md`、`src/taskService.ts`、`src/feedbackStore.ts` | `4ff226d`（9/12）、`15b4680`（9/13） |
| 内核减权与形式检查删减 | `kernel/docs/kernel-authority.md`、`docs/requirement-form-checks-2026-09-13.md` | `61a1a6f`（9/9）、`fb4ff7c`（9/12）、`af273a7`（9/13） |
| 验证按影响执行，删除交付前强制 Build-Fix | `README.md` 对应 9/12 更新、`src/warmupAgent.ts` | `3bc59df`（9/12） |
| 分层知识与发布版本 | `src/knowledgeAssetModel.ts`、`src/knowledgeExtraction.ts`、`src/sessionDriver.ts`、`docs/business-module-knowledge-design.md` | `1e14173`（8/28） |
| 可保存的工作流资产 | `src/workflowAssetLibrary.ts`、`src/workflowProfileRuntime.ts` | 8/29 workflow 资产相关提交；正文仅概述，不宣称任意流程自由定制 |
| 当前调用前有界记忆召回 | `src/memoryContext.ts`、`src/sessionDriver.ts:1231` 附近、`src/taskService.ts:5447` 附近、`docs/knowledge-memory-design.md` 最后两节 | `feb4e6a`、`c0b09be`（9/14） |
| 独立问题处理与自主推进 | `src/issueFlow/`、`docs/issue-flow.md`、`CONTEXT.md`、`docs/adr/0002-goal-driven-stage-machine.md` | 8/26 独立问题流与 8/29 目标驱动推进相关提交 |
| Web 入口与执行器分离、原生会话恢复 | `src/serve.ts`、`src/executionRuntime.ts`、`docs/execution-continuity.md` | `997b7ac`（9/12） |
| Cloud 单仓单一运行时演进方向 | `docs/adr/0020-cloud-owned-workflow-migration.md` | 9/9 ADR；是逐步迁移方向，不能说已全面完成 |

## 容易因历史文档混杂而误写的地方

1. README 保留大量历史更新；旧段落中的强制门禁、负责面白名单、强制骨架先拆、独立 Build-Fix 要以后续更新为准。
2. 需求侧意见最终处置由当前任务责任人负责，不能沿用旧注释中的“提出人验收”概括现状；问题分析报告检视与需求批注的语义也不能完全混称。
3. 记忆旧设计包含开局、阶段、首次改目录三个注入点，以及“不给 Agent 写记忆工具”的旧约定。9/14 末节与当前代码已更新为调用前召回，主动 search/expand/write 保留。
4. 记忆自动入口已核对需求主会话与开发助手，不能扩展表述为所有问题流、子会话无差别接入，也不能称为已验证的召回质量提升。
5. 独立执行部署已经有代码；只有正确启用进程分离才获得 Web 入口重启不停止执行的能力。执行器本身退出仍可能中断在途工作。
6. 部分设计文档同时记载目标与已实现项。正文没有宣称完整跨模块验收统计、所有真实环境验证适配器或全面去 Python 已经完成。
7. 不把外部平台查询失败写成没有 MR/没有意见；不把本地测试或可控平台回归写成生产实测。
8. 正文不包含内网地址、凭据、真实客户问题、内部任务编号与部署操作细节。技术组件名与产品名保留。

## 可由分享者补充的内容

- 对外品牌是否继续使用 Mae-Flow Cloud，以及是否可以公开 Pi、内部平台适配等技术细节。
- 目标读者、分享场合和篇幅要求。
- 为什么最初决定做这个系统：一项可以公开的真实经历。
- 一项可公开的完整需求案例，最好包含原始任务、跨模块设计、一次人工改口、一次反馈修复和最终交付。
- 可核验的实际任务统计，如样本量、任务复杂度、人力投入、等待时间和交付缺陷。没有这些数据，不补写提效倍数。

没有把待确认信息嵌入对外正文，正文可独立阅读；补充后可以增强故事性与产品辨识度。
