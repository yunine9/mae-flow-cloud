---
name: component-knowledge-extraction
description: 依据基础组件仓代码与 everycode 真实调用，分任务萃取组件契约、推荐范式和误用陷阱，独立评审后生成可程序解析的知识草稿与派生预览。
---

# 组件范式萃取

研究使用方需要什么能力、应如何接入以及哪些写法有问题。方法改编自 Issue 444 的 paradigm-builder，由平台 CloudSession 执行；不启动 Claude CLI 或 Python 调度器。

## 来源与判断

依据基础仓代码及 everycode 实际展开的调用代码研究组件用法。接口、实现、测试、构建和发布配置用于核对能力与约束；跨仓调用用于发现场景、变体与误用。调用多不等于推荐，公开声明不等于受支持入口。

首先读 [平台协议](references/platform-pipeline.md) 和 [产物格式](references/schema.md)。核对接口与示例时读 [接口边界](references/api-boundary.md) 和 [组件研究](references/component.md)。阶段分别读 [盘点](references/phase-inventory.md)、[规划](references/phase-plan.md)、[契约](references/phase-contracts.md)、[范式](references/phase-paradigm.md)、[陷阱](references/phase-pitfalls.md)、[导航](references/phase-index.md)、[汇总](references/phase-synthesis.md)。独立评审读 [评审标准](references/phase-review.md)。范式正文参考 [模板](assets/templates/paradigm.md)。保存与修订遵循 [草稿约定](references/draft-contract.md)。

## 面向开发者写知识

Markdown 会独立上库，读者没有本平台、当前会话或研究任务的上下文。按第一次接触组件的开发者来写：说明组件名称、解决的问题、必要前提，再给完整用法。每篇都能独立阅读；跨篇依赖用明确的组件名称和有效的相对链接，不能写“见本轮结果”“使用上述仓库”“参考任务记录”。标题、概述、content、interfaces、integration、example 只写组件用途、接入方法、调用顺序、完整示例、必要约束与错误处理。先给可操作的用法，避免同一条件在概述、正文和示例前反复解释。

不要在这些文字里写来源章节、证据清单、仓库 UUID、提交哈希、源码行号、everycode 编号，以及 Agent、Skill、pipeline、task.id、recommended、unverified、shadow 等内部角色、状态或协议用语。不要写“本会话已回读”“通过独立评审”“待人工采纳”“规则未启用”“消费证据待补”等工作过程。API、头文件、构建目标、依赖包名和实际产品版本是使用知识，应保留。

依据仍须完整核实：代码位置与固定版本写 evidence，调用编号写 usage_evidence，调查缺口写 open_questions，执行说明写 component_work_result。正文解释约束本身，例如“所有任务结束后才能读取结果”，不附查证过程。缺少依据时降低结构化 status；若不确定性直接影响使用，用一句日常语言说清限制，例如“并发调用 submit 和 wait 的安全性尚未确认，请在停止提交后再等待”。示例未运行可简短注明“示例未运行验证”，不要把调查报告复制到正文。

保存前检查：读者是否能认出组件、是否能按文中的依赖和示例开始使用、是否还有一句话必须回到本平台才能看懂。删除工作过程与重复描述；影响正确使用的前提、限制和未验证事项必须保留。

## 执行范围

只处理上下文中的当前小任务。一次研究只针对一个组件，按已盘点能力逐项完成；能力按使用方的用途划分，不把每个内部函数拆成独立能力。通过 component_work 读取必要的依赖结果，避免重复研究。

每个任务使用新会话，程序校验结构和代码引用后再独立评审。具体待确认问题必须说明已知线索、缺失证据和受影响的结论；未核实的能力标记 unverified，不能写成已确认推荐。

## 输出与修订

通过 research_document 保存结构化字段和正文，component_work_result 提交任务结果。交付的 Markdown 只写知识正文；结构化字段与证据留在平台，由平台提取索引、选择表和规则候选。不要另写或手工维护派生文件。

讨论只回答问题；修订/增量更新先读取当前章节，围绕反馈与新旧源码版本核对，保留人工内容。补充遗漏能力（mode 为 supplement）先读目录确认确实缺失，只用新编号新增能力项，不改已有项与概述；查无依据就如实说明，不硬凑。建议等待人工采纳，不直接替换正式知识。一次研究只针对一个组件，审查发布后成为该组件的一篇知识；人手动归档时平台只提交这一篇 Markdown 正文，按知识标题命名。草稿完成不等于入库，规则候选不等于已启用检查。

## 规则可信度与反例研究

推荐写法不等于禁止其他写法。`replaces` 只列可检验的替代主张，明确依赖、生命周期和允许原生 API 的场景；证据不足保留待确认问题，不扩大禁用范围。规则与选型映射默认仅为候选，由组件负责人在知识工作台独立决定是否启用提示。不得写入启用策略。

收到“寻找合理反例”任务时，当前主张是待验证假设。独立读取基础仓实现与 everycode 消费方代码，寻找组件无法替代的合法场景；报告位置、版本和具体原因，区分找到反例、当前未找到和证据不足。此任务不修改范式、不启用规则。运行结果与反馈处理见 [产物格式与消费](references/schema.md)。
