---
name: component-knowledge-extraction
description: 仅从基础组件仓代码与 everycode 真实调用，分任务萃取组件契约、推荐范式和误用陷阱，独立评审后生成可程序解析的知识草稿与派生预览。
---

# 组件范式萃取

研究使用方需要什么能力、应如何接入以及哪些写法有问题。方法改编自 Issue 444 的 paradigm-builder，由平台 CloudSession 执行；不启动 Claude CLI 或 Python 调度器。

## 来源与判断

事实来源只有基础仓代码及 everycode 实际展开的调用代码。接口、实现、测试、构建和发布配置用于核对能力与约束；跨仓调用用于发现场景、变体与误用。调用多不等于推荐，公开声明不等于受支持入口。平台不提供上传资料或无线豆包。

首先读 [平台协议](references/platform-pipeline.md) 和 [产物格式](references/schema.md)。核对接口与示例时读 [接口边界](references/api-boundary.md) 和 [组件研究](references/component.md)。阶段分别读 [盘点](references/phase-inventory.md)、[规划](references/phase-plan.md)、[契约](references/phase-contracts.md)、[范式](references/phase-paradigm.md)、[陷阱](references/phase-pitfalls.md)、[导航](references/phase-index.md)、[汇总](references/phase-synthesis.md)。独立评审读 [评审标准](references/phase-review.md)。范式正文参考 [模板](assets/templates/paradigm.md)。保存与修订遵循 [草稿约定](references/draft-contract.md)。

## 执行范围

只处理上下文中的当前小任务。指定主题只研究相关能力，全量研究按已盘点能力逐项完成；不把整个仓当作一个组件，也不把每个内部函数拆成独立能力。通过 component_work 读取必要的依赖结果，避免重复研究。

每个任务使用新会话，程序校验结构和代码引用后再独立评审。具体待确认问题必须说明已知线索、缺失证据和受影响的结论；未核实的能力标记 unverified，不能写成已确认推荐。

## 输出与修订

通过 research_document 保存结构化字段和正文，component_work_result 提交任务结果。平台将字段导出为版本化 frontmatter + Markdown，并从实际导出的文档程序化提取索引、选择表和规则候选。不要另写或手工维护派生文件。

讨论只回答问题；修订/增量更新先读取当前章节，围绕反馈与新旧源码版本核对，保留人工内容。建议等待人工采纳，不直接替换正式知识。归档仍使用平台现有工作台，默认位置见 [归档设置](references/archive-defaults.md)。草稿完成不等于入库，规则候选不等于已启用检查。
