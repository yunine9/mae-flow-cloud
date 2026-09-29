# 组件正文与结构化产物协议

## 写作工具输入

research_document section 字段：id（严格等于 task.id）、title、repository_ids、content、interfaces、integration、example、related_ids、paradigm。example 包含真实代码块和是否编译验证的说明。sources 是平台内部追溯字段，不追加到 Markdown，也不由模型另写一份。

paradigm 字段全部必填，空集合用 []：

| 字段 | 类型与要求 |
|---|---|
| kind | contracts / paradigm / pitfalls / index，等于任务阶段 |
| component | task.component 的稳定编号 |
| language | 当前研究语言 |
| status | recommended / legacy / unverified |
| need | 开发者要完成的具体工作，不写成“某 API 的用法” |
| api | 真实关键符号的字符串列表；paradigm 至少一项 |
| applicability | 适用场景、依赖和版本条件；未知处如实写明 |
| replaces | identifiers、imports、patterns 三个字符串列表 |
| evidence | 至少一条基础仓代码引用，见下 |
| usage_evidence | 实际展开并回读的 everycode-* 编号列表 |
| open_questions | 未确认问题列表 |

基础仓引用：repository_id、path、revision、start、end。revision 使用上下文固定值；行号从 1 开始，必须真实读过全部范围。不能引用目录、旧知识文档或 Agent 指令。范式推荐状态还需要实际展开的调用证据，暂无调用时保留 unverified 草稿。

replaces.identifiers 写精确符号，如 std::thread、Executors.newFixedThreadPool；imports 写实际导入对象；patterns 写不能可靠机械匹配的写法描述。有合法用途的原生 API 不可笼统列为禁用项，具体例外写入 applicability。legacy 不进入推荐选择表或规则。没有 replaces 的推荐能力仍进入选择表。

## 导出的文件与程序读取

每份正文有独立路径：components/<component>/<task.id>.md，推荐用法放在 paradigms/ 子目录。Markdown 不带 frontmatter 和来源清单，只含可读的知识正文、接口、接入依赖与完整示例。

同路径的 <task.id>.metadata.json 保存 schema="mfc.component-paradigm/v2"、id、title、revision 和全部 paradigm 字段。证据、内部状态及调查缺口只放结构化字段。正文与元数据共同构成一份产物，不另写第二份知识。

平台导出后重新读取每对文件，生成 derived/catalog.json、derived/mapping-table.md、derived/rule-candidates.json，以及适用语言的 ast-grep 规则、正反样例和报告。规则状态由平台管理；自然语言 patterns 不伪装为可执行规则。模型不手工维护派生文件。

catalog 的 path 指向实际 Markdown。元数据缺失、非法字段、孤立元数据或重复编号均报错，不静默输出半份结果。旧版 frontmatter 文档仍可读取，新导出使用正文与 JSON 分开的格式。

联合 Markdown 下载同样只含知识。Git 归档提交两份配套文件：指南 .md 与同名 .metadata.json（mfc.component-guide/v2，包含 component_paradigms 和正文摘要 content_sha256）。合入后读取同一 Git 版本的这两份文件并校验一致性，再恢复正式知识的内部结构；文件缺失或正文摘要不一致时提示同步失败，不使用错配的规则。正式入库仍保留现有内部格式以兼容检索与规则消费；其中的机器字段不属于阅读和下载正文。包内 evidence/everycode.json 保存原始调用代码，完整产物通过结构化产物入口取得。

独立重提取命令：`node --import tsx scripts/derive-component-knowledge.ts <导出的JSON包或解包目录> [输出目录]`。无输出目录时仅校验和输出摘要；错误输入非零退出，不覆盖已有结果；重复生成会移除上次清单中的过期规则。

## 正式知识如何用于开发

草稿导出仍是预览。人工采纳或 MR 归档同步为启用的正式知识后，平台从正式 Markdown 提取范式，按任务仓库、模块、语言及明确声明的产品版本选择。选型映射和派生规则分别维护启用策略；新内容默认为 shadow，只记录命中，不向开发 Agent 提示。文档采纳不等于规则启用。

组件知识工作台以文档阅读为入口，代码检查设置和实际命中按需打开。负责人可启用 warning、限定路径或设为 off；平台不提供阻断提交的 error 级别。人工策略存于 component-governance/rule-policy.json，开发工具不能修改。

组件选择沿用 component-plan Skill 和统一 knowledge 工具：按需检索卡片、读取完整知识、核对实施计划。同一份正式知识产生检索卡片和检查规则，不另建一套知识入口。新规则默认为 shadow，只记录命中；人工启用后才提供提示。

编辑/写入和 Bash 工具结束后，平台检查新增代码；宿主推送前按真实提交与目标分支共同祖先检查。两处使用同一派生器，排除组件自身实现。报告区分完成、无适用规则和未完成；候选观察仅供工作台查看。程序故障不会伪造通过，不改变需求状态或自动重试。

源范式正文、接口或范围变化后，旧启用决定回到候选；其他章节修订不影响本项。人工停用继续保留。误报反馈需具体理由，只豁免同仓、同规则版本、同代码内容及位置的后续提示。反馈统计按去重样本计算，评审退回不自动视为知识有害；反例和质量错误进入复查列表，不自动修改策略。

反例研究使用单独的新会话，只读取基础仓与 everycode；寻找合理保留原生 API 的场景，输出证据、反例或证据不足。结果不能直接采纳为范式，也不会自动启用规则。文档抽查每个组件随机选择至多 2 篇已采纳范式；连续发现错误时调整萃取方法并重新研究该组件。
