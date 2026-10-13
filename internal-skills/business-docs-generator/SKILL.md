---
name: business-docs-generator
description: 从关联源码仓生成完整业务文档体系：先穷举范围内的仓、业务域、接口、外部系统和业务功能，再逐篇深读源码、按模板写作并独立评审，自动修订后接续。
execution: reviewed-document-plan
---

# 多仓业务文档生成

保留领域层与仓级文档两套模板。领域层解释完整业务链路及各仓职责，仓级解释内部模块、类或函数的完整交互。单仓业务仍按实际场景组织，不为凑跨仓链路制造调用。全部图表使用 PlantUML；方法、参数、分支和配置值来自实际读取的源码。上传资料与无线豆包遵循平台系统提示中的来源规则。

## 先确定本会话的工作

先读 [平台执行与交付约定](references/platform-execution.md)，按以下顺序确定职责，不能把 readonly 调查误当成文稿评审：

- **reviewing=true：独立文稿评审。** 按 [评审提示词](prompts/verify-doc.md) 读取全部 expected_document_ids 的当前正文、真实图表校验报告与原始依据，提交顶层 review: { pass, feedback }；不修改正文或过程文稿。
- **有 step 且 readonly=true：只读调查或规划核查。** 以 step.instructions 明确的任务为准。调查提交 summary/data 与 document_ids=[]；规划核查额外提交 review。它们不调用 save_document，不安排后续步骤。
- **有 step 且 readonly=false：写作、修订或导航同步。** 只修改 expected_document_ids，读取本项方法、模板和证据，提交已保存的候选编号；平台按登记的 review 配置启动独立评审。写作者不能自行提交通过结论。
- **没有 step：主协调会话。** 根据 mode 执行首次生成、讨论或限定范围的修改；只有主会话登记计划和独立步骤、维护共享规划、判断最终完成或暂停。

## 首次生成

1. **先盘点范围。** 读取 [规划方法](prompts/plan.md) 与 [规划模板](prompts/plan-template.md)，查看全部来源仓、用户范围、构建文件和目录入口。主会话在此只识别调查分工，不先通读全仓业务实现。
2. **分开调查。** 按仓、业务入口和完整场景登记 readonly=true 的独立调查步骤，沿源码识别业务功能、跨仓接口和外部系统。互不依赖的调查并行，调查之间需要结果时声明 depends_on。每个单元将发现和证据索引持久保存到 knowledge_work_result 的 summary/data，document_ids=[]；只读单元不保存过程文稿。主会话按编号读取必要结果，仅保留短摘要与引用。可直接照用的平台示例见 [独立调查](references/platform-execution.md#独立调查)。
3. **汇总完整规划。** 根据调查结果识别全部仓、业务域、跨仓接口、外部系统和业务功能；范围仍不清楚时继续拆出具体调查，不把全部源码搬回主会话。把完整规划保存为过程文稿 current-plan，用 knowledge_diagram_check({work_document_id:"current-plan"}) 校验其中图表，再以 knowledge_work action=plan、work_document_id=current-plan、document_ids=全部规划文稿编号登记输出清单。图错误修正后重查；缺少校验依赖时保留规划与阻碍，不伪装成知识文稿。规划正文、路径与结构化清单一一对应。
4. **独立核查规划。** 登记 readonly=true 的步骤，要求读取 current-plan 及其真实图表报告、knowledge_work read_plan 全部分页、调查结果索引、规划提示词与各仓入口，对照页面/API/定时/事件检查遗漏。主会话读取 review.pass，不能把该步骤的 done 当成通过。未通过时按明确遗漏修订正文和 plan，以新编号核查；范围过大可分仓/业务域核查，全部通过后开始写作。相同阻碍没有新证据时停止重复核查，先推进其他独立调查并记录缺口；无需用户确认。
5. **登记完整文档计划。** 将每篇文档登记为一个写作步骤，填写 expected_document_ids 和 review.instructions。写作与评审说明只传本项范围、文稿编号/目标/路径、方法入口、证据索引和具体问题，不复制其他单元的全文。需要先读取的文稿或研究结果必须声明 depends_on，独立项保持无依赖，必要时每批最多 100 项。全部条目登记完后，knowledge_work run 省略 id 执行；本方法默认最多三个独立单元并行，可用 concurrency=1～4 调整。每个单元的写作与独立评审仍按次序完成。
6. **逐篇生成、查图与独立评审。** 领域文稿读取 [领域写作方法](prompts/generate-domain.md)，仓级文稿读取 [仓级写作方法](prompts/generate-repo.md)。每步生成本篇完整候选，保存后用 knowledge_diagram_check 查当前版本，按实际错误修正；绘图或有错误时按需读 [PlantUML 指南](references/plantuml.md)。平台在候选后先校验图，再按 review 启动独立语义评审；语法或业务错误携带具体反馈继续修订，最多自动三轮。校验 unavailable 保留候选并停止该项，不消耗修订次数，也不算通过；主会话继续其他独立项后报告实际阻碍。
7. **接续未完成工作。** run 返回后检查摘要，按步骤 id 回读必要结果、候选和反馈。已有新调查结论、确需改变说明时创建新编号并在规划中关联；恢复原步骤时按原编号运行。三轮后仍无进展时保留阻塞，不换编号重复同一工作；先完成独立条目。新发现先补规划正文和 plan；确实不适用的旧条目在 plan.exclusions 中逐项说明证据或用户范围变化，不能把写不完作为排除理由。
8. **最终同步导航。** 单独安排带独立评审的最终导航步骤，depends_on 列出该导航覆盖的全部文稿写作及最后修订步骤；导航已有初稿时也依赖初稿步骤。相关文稿全部完成后才运行。可在其他文稿完成后直接首次生成最终导航，不要求先生成一版空导航。领域导航同步根 AGENTS.md 与 domain-docs/AGENTS.md，仓级导航同步该仓 AGENTS.md 与 docs/module-map.md，expected_document_ids 覆盖实际修改的每份文稿。根导航若列出各仓 AGENTS.md，也等待这些实际目标完成。不同仓导航可独立执行，彼此不要形成循环依赖。最后检查最新规划、全部文档路径和最新版评审；后续新增或修订影响导航时再次安排对应同步。
9. **如实结束。** 所有适用规划条目都有真实文稿、完整内容和最新版通过的独立评审，且导航一致时，提交 status=complete。summary 写实际覆盖、文档数量和具体未知，document_ids 列出本轮全部完成文稿，work_document_ids 引用 current-plan。未完成时保留进度并提交 paused，说明阻塞条目、已尝试措施和接续条件；不把部分成果描述成全套完成。

## 文档类型与阅读顺序

1. 根 AGENTS.md，提供仓与领域关键词路由。
2. domain-docs/AGENTS.md、domain-docs/glossary.md、domain-docs/architecture.md。
3. domain-docs/domains/ 下逐业务域文稿，穷举每个独立场景。
4. domain-docs/interfaces/ 下逐有真实交互的仓对的接口契约。
5. domain-docs/external/ 下逐实际依赖系统的画像。
6. 各仓 AGENTS.md、docs/module-map.md、docs/rules/coding-conventions.md、docs/rules/business-rules.md。
7. 各仓 docs/modules/ 下逐业务功能文稿，覆盖该仓全部范围内功能。
8. 各模块 experience/ 下的机制文稿：仅在本次有真实排查案例时生成；初次研究不编造经验。

这是读者查阅文档的层级，不是整包串行执行顺序，也不是固定数量。只有确实读取其他文稿或研究结果的步骤才建立 depends_on；基于独立源码范围的文稿可以并行。初次导航可引用规划中确定的后续路径，最终导航同步须等相关文稿完成并核对实际路径。用户要求“仅生成领域知识”时仅安排领域层；“生成模块文档”时按指定仓和模块安排，关联文档按实际范围核对。逻辑工作区路径到平台目标仓的对应关系见平台执行约定。

## 讨论、局部修改与增量更新

- discuss：回读相关文稿、源码和资料，只提交回答及引用的真实文稿编号，不保存知识文稿或过程文稿；没有文稿时 document_ids=[]。
- revise：按反馈定位受影响内容，为所需修改登记写作与独立评审步骤，保留原文稿编号。尊重人工编辑和平台的建议采纳流程；本轮只修指定问题，不重新要求生成全套文档。
- update：逐相关仓用 knowledge_source_changes 确认变化，结合本轮新增资料，更新受影响的完整场景、文稿及导航。没有比较基线或工具失败不等于无变化；按当前来源核实并说明限制。已有文稿保持稳定编号，确无受影响内容时说明核对范围与依据。

接续先读保存的规划、步骤和文稿，不重新初始化清单。是否有用户确认以 human_replies 原话为准；continued 仅表示接续次数。本 Skill 不在文档之间主动要求确认，也不自动发布、采纳建议或创建归档 MR。
