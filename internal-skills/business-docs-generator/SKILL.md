---
name: business-docs-generator
description: 从多个代码仓生成完整业务文档体系：先穷举仓、业务域、接口、外部系统和业务功能，再逐篇深读源码、按模板写作并独立评审，自动修订后接续。
execution: reviewed-document-plan
---

# 多仓业务文档生成

保留领域层与仓级文档两套模板。领域层解释跨仓业务链路，仓级解释内部类与方法的完整交互。全部图表使用 PlantUML；方法、参数、分支和配置值来自实际读取的源码。上传资料与无线豆包遵循平台系统提示中的来源规则。

## 先确定本会话的工作

先读 [平台执行与交付约定](references/platform-execution.md)。以本轮上下文的 step 区分职责：

- **没有 step：主协调会话。** 按下方流程规划和安排工作，读取每步结果并维护完整清单。
- **有 step：独立工作会话。** 只处理 step.instructions 指定的规划核查、文稿写作、评审或修订。读取其中指定的提示词、模板及规划条目，完成后调用 knowledge_work_result。后续步骤由主会话或本步骤的独立评审机制安排。
- **只读评审会话：** 读取指定规划或全部待评文稿，按 [评审提示词](prompts/verify-doc.md) 检查，回读原始依据后提交 review: { pass, feedback }。只读会话不保存或修改文稿。

## 首次生成

1. **先盘点范围。** 读取 [规划方法](prompts/plan.md) 与 [规划模板](prompts/plan-template.md)，查看全部来源仓、用户范围、构建文件和目录入口。主会话在此只识别调查分工，不先通读全仓业务实现。
2. **分开调查。** 按仓、业务入口和完整场景登记 readonly=true 的独立调查步骤，沿源码识别业务功能、跨仓接口和外部系统。互不依赖的调查并行，调查之间需要结果时声明 depends_on。每个单元将发现和证据索引持久保存到 knowledge_work_result 的 summary/data，document_ids=[]；只读单元不保存过程文稿。主会话按编号读取必要结果，仅保留短摘要与引用。可直接照用的平台示例见 [独立调查](references/platform-execution.md#独立调查)。
3. **汇总完整规划。** 根据调查结果识别全部仓、业务域、跨仓接口、外部系统和业务功能；范围仍不清楚时继续拆出具体调查，不把全部源码搬回主会话。把完整规划保存为 knowledge_work 过程文稿 current-plan，再以 action=plan、work_document_id=current-plan、document_ids=全部规划文稿编号登记完整输出清单。规划正文、逐篇路径与结构化清单应一一对应。
4. **独立核查规划。** 登记 readonly=true 的步骤，要求读取 current-plan、knowledge_work read_plan 的全部分页、调查结果索引、规划提示词、模板与各仓真实入口，对照业务页面、公开接口、定时任务和事件处理检查遗漏。运行并读取 review 结论。未通过时修订规划，补全 plan 清单，再用新编号安排核查；通过后开始写作。此阶段自动进行，无需用户确认。
5. **登记完整文档计划。** 将每篇文档登记为一个写作步骤，填写 expected_document_ids 和 review.instructions。写作与评审说明只传本项范围、文稿编号/目标/路径、方法入口、证据索引和具体问题，不复制其他单元的全文。需要先读取的文稿或研究结果必须声明 depends_on，独立项保持无依赖，必要时每批最多 100 项。全部条目登记完后，knowledge_work run 省略 id 执行；本方法默认最多三个独立单元并行，可用 concurrency=1～4 调整。每个单元的写作与独立评审仍按次序完成。
6. **逐篇生成与独立评审。** 领域文档读取 [领域写作方法](prompts/generate-domain.md)，仓级文档读取 [仓级写作方法](prompts/generate-repo.md)。每步只生成本篇完整候选文稿，及时保存。平台按本步骤的 review 说明启动独立评审，退回时携带反馈继续修订，最多尝试三轮；只有通过的步骤才完成。
7. **接续未完成工作。** run 返回后检查摘要，按步骤 id 回读必要结果、候选和反馈。已有新调查结论、确需改变说明时创建新编号并在规划中关联；恢复原步骤时按原编号运行。三轮后仍无进展时保留阻塞，不换编号重复同一工作；先完成独立条目。新发现先补规划正文和 plan；确实不适用的旧条目在 plan.exclusions 中逐项说明证据或用户范围变化，不能把写不完作为排除理由。
8. **最终同步导航。** 单独安排带独立评审的最终导航步骤，depends_on 列出该导航覆盖的全部文稿写作及最后修订步骤，包含导航自身的初次生成步骤；相关文稿全部完成后才运行。领域导航同步根 AGENTS.md 与 domain-docs/AGENTS.md，仓级导航同步该仓 AGENTS.md 与 docs/module-map.md，expected_document_ids 覆盖实际修改的每份文稿。不同仓导航可独立执行。最后回读最新规划、全部文档路径和评审结果，检查链接、覆盖范围和最新版是否通过；后续新增或修订影响导航时再次安排对应同步步骤。
9. **如实结束。** 所有适用规划条目都有真实文稿、完整内容和最新版通过的独立评审，且导航一致时，提交 status=complete。summary 写实际覆盖、文档数量和具体未知，document_ids 列出本轮全部完成文稿，work_document_ids 引用 current-plan。未完成时保留进度并提交 paused，说明阻塞条目、已尝试措施和接续条件；不把部分成果描述成全套完成。

## 文档类型与阅读顺序

1. 根 AGENTS.md，随后持续回填领域关键词路由。
2. domain-docs/AGENTS.md、domain-docs/glossary.md、domain-docs/architecture.md。
3. domain-docs/domains/ 下逐业务域文稿，穷举每个独立场景。
4. domain-docs/interfaces/ 下逐有真实交互的仓对的接口契约。
5. domain-docs/external/ 下逐实际依赖系统的画像。
6. 各仓 AGENTS.md、docs/module-map.md、docs/rules/coding-conventions.md、docs/rules/business-rules.md。
7. 各仓 docs/modules/ 下逐业务功能文稿，覆盖该仓全部范围内功能。
8. 各模块 experience/ 下的机制文稿：仅在本次有真实排查案例时生成；初次研究不编造经验。

这是读者查阅文档的层级，不是整包串行执行顺序，也不是固定数量。只有确实读取其他文稿或研究结果的步骤才建立 depends_on；基于独立源码范围的文稿可以并行。初次导航可引用规划中确定的后续路径，最终导航同步须等相关文稿完成并核对实际路径。用户要求“仅生成领域知识”时仅安排领域层；“生成模块文档”时按指定仓和模块安排，关联文档按实际范围核对。逻辑工作区路径到平台目标仓的对应关系见平台执行约定。

## 讨论、局部修改与增量更新

- discuss：回读选中文稿、源码和资料，回答问题并保存结果；保持文稿只读。
- revise：按反馈定位受影响内容，保存原编号的修订建议，安排独立评审。尊重人工编辑和平台的建议采纳流程。
- update：先用 knowledge_source_changes 确认来源变化，更新受影响的完整业务场景、文稿及导航；已有文稿保持稳定编号。无变化时说明依据。

接续先读保存的规划、步骤和文稿，不重新初始化清单。是否有用户确认以 human_replies 原话为准；continued 仅表示接续次数。本 Skill 不在文档之间主动要求确认，也不自动发布、采纳建议或创建归档 MR。
