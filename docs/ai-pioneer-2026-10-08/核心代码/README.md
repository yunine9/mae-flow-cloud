# 核心代码导读

以下 5 段代码共 **493 行**，选取平台中与 AI 执行、人工控制、交付验证及知识管理直接相关的实现，供评审快速阅读。

所有选段均原样摘自提交 [`695104c9e02b981419a1063faf582b6c396bfded`](https://github.com/yunine9/mae-flow-cloud/commit/695104c9e02b981419a1063faf582b6c396bfded)，未改写为演示代码。部分文件只包含原函数的一段，依赖与上下文未打包，因此本目录不能独立运行；完整实现可通过原始位置链接查看。原代码中的注释和历史问题编号一并保留。

| 文件 | 原始位置 | 行数 | 重点看什么 |
| --- | --- | ---: | --- |
| [01-人工决策与会话恢复.ts](01-人工决策与会话恢复.ts) | [src/sessionDriver.ts · 1662–1728](https://github.com/yunine9/mae-flow-cloud/blob/695104c9e02b981419a1063faf582b6c396bfded/src/sessionDriver.ts#L1662-L1728) | 67 | 保存人工问题；复用已回答的决定；处理失效问题；等待人工决定后恢复执行。为 `CloudSession.askUser` 的后半段。 |
| [02-流水线失败处理.ts](02-流水线失败处理.ts) | [src/issueFlow/service.ts · 6580–6721](https://github.com/yunine9/mae-flow-cloud/blob/695104c9e02b981419a1063faf582b6c396bfded/src/issueFlow/service.ts#L6580-L6721) | 142 | 保存失败对应的提交和材料；将现场信息交给 AI；在同一提交反复失败或次数用尽时停止自动修复。为 `IssueFlowService.settlePipeline` 的失败分支。 |
| [03-代码推送与远端核验.ts](03-代码推送与远端核验.ts) | [src/issueFlow/issueGit.ts · 398–510](https://github.com/yunine9/mae-flow-cloud/blob/695104c9e02b981419a1063faf582b6c396bfded/src/issueFlow/issueGit.ts#L398-L510) | 113 | 实际执行推送；需要强制更新时使用带远端版本检查的方式；再次读取远端提交号验证结果；清理临时资源。包含完整 `pushFromIssueWorkspace` 函数。 |
| [04-组件研究与独立评审.ts](04-组件研究与独立评审.ts) | [src/componentResearchPipeline.ts · 1–78](https://github.com/yunine9/mae-flow-cloud/blob/695104c9e02b981419a1063faf582b6c396bfded/src/componentResearchPipeline.ts#L1-L78) | 78 | 拆分研究任务；按依赖执行；调用独立评审；限制单次运行的尝试次数；保存进度。包含 `ComponentResearchPipeline` 类。 |
| [05-知识发布与中断恢复.ts](05-知识发布与中断恢复.ts) | [src/componentResearch.ts · 676–768](https://github.com/yunine9/mae-flow-cloud/blob/695104c9e02b981419a1063faf582b6c396bfded/src/componentResearch.ts#L676-L768) | 93 | 检查选择内容、版本、最新建议及引用证据；先记录发布意图，再完成正式知识写入；恢复中断发布并保护他人修改。包含发布及恢复相关方法。 |

## 已有测试覆盖

下面列出仓库中的对应测试，便于进一步核查。本次材料整理没有重新执行这些测试。

| 对应代码 | 测试入口 | 已有测试关注点 |
| --- | --- | --- |
| 01 | [reviewDecisionContract.test.ts](https://github.com/yunine9/mae-flow-cloud/blob/695104c9e02b981419a1063faf582b6c396bfded/tests/reviewDecisionContract.test.ts#L223)、[recovery.test.ts](https://github.com/yunine9/mae-flow-cloud/blob/695104c9e02b981419a1063faf582b6c396bfded/tests/recovery.test.ts#L300) | 会话等待、人工作答后恢复，以及恢复时不重复询问。 |
| 02 | [issueRedCutover.test.ts](https://github.com/yunine9/mae-flow-cloud/blob/695104c9e02b981419a1063faf582b6c396bfded/tests/issueRedCutover.test.ts#L89) | 失败材料传入 AI、补充报错、人工处理、修复次数用尽及同提交重复失败。 |
| 03 | [issuePushBranch.test.ts](https://github.com/yunine9/mae-flow-cloud/blob/695104c9e02b981419a1063faf582b6c396bfded/tests/issuePushBranch.test.ts#L119) | 通过临时裸仓验证实际远端分支与返回记录的提交号，并检查强制更新行为。 |
| 04 | [componentResearchPipeline.test.ts](https://github.com/yunine9/mae-flow-cloud/blob/695104c9e02b981419a1063faf582b6c396bfded/tests/componentResearchPipeline.test.ts#L10)、[componentResearchPipelineAgent.test.ts](https://github.com/yunine9/mae-flow-cloud/blob/695104c9e02b981419a1063faf582b6c396bfded/tests/componentResearchPipelineAgent.test.ts#L13) | 尝试次数、已完成项接续、方法版本，以及来源隔离和独立评审。 |
| 05 | [knowledgeProductionComponentPublish.test.ts](https://github.com/yunine9/mae-flow-cloud/blob/695104c9e02b981419a1063faf582b6c396bfded/tests/knowledgeProductionComponentPublish.test.ts#L76)、[knowledgeProductionComponentIntentRollback.test.ts](https://github.com/yunine9/mae-flow-cloud/blob/695104c9e02b981419a1063faf582b6c396bfded/tests/knowledgeProductionComponentIntentRollback.test.ts#L60) | 发布预检、进程中断后的恢复，以及不覆盖人工修改或恢复历史。 |
