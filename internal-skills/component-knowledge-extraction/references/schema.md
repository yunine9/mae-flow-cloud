# 结构化产物协议 v1

## 写作工具输入

research_document section 字段：id（严格等于 task.id）、title、repository_ids、content、interfaces、integration、example、related_ids、paradigm。example 包含真实代码块和是否编译验证的说明。sources 由程序生成，不由模型另写一份。

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

每份产物有独立路径：components/<component>/<task.id>.md，范式放在 paradigms/ 子目录。第一段 frontmatter 使用 schema="mfc.component-paradigm/v1"，还包括 id、title、revision 和上述全部 paradigm 字段。

frontmatter 每行固定为 `字段名: JSON值`。字符串带双引号，列表和对象使用单行 JSON 表示；这是规范化的 YAML 子集，方便稳定解析。正文接标题、用法、公共接口、集成产物与依赖、完整示例、来源。禁止省略、重复或自造字段，格式升级需新 schema 版本。

平台导出后重新解析这些 Markdown，并生成 derived/catalog.json、derived/mapping-table.md、derived/rule-candidates.json，以及 C/C++/Java 的 ast-grep 候选规则、正反样例和规则报告。三者来自同一文档集合；规则 state=candidate、enabled=false。自然语言 patterns 仅作提示，不生成伪装为可执行的规则。

catalog 每项包含 path，指向包内实际 Markdown；选择表也链接该文件。输入文件枚举顺序不影响结果。解析失败时整次派生失败，不跳过坏文档后输出看似完整的结果。

联合文档下载仍保留审查视图，frontmatter 为 mfc.component-guide/v1，component_paradigms 保存所选章节元数据。包内 evidence/everycode.json 保留被引用的 everycode 原始代码，供离线追溯。完整的独立产物与派生文件通过“下载结构化产物”取得。

独立重提取命令：`node --import tsx scripts/derive-component-knowledge.ts <导出的JSON包或解包目录> [输出目录]`。无输出目录时仅校验和输出摘要；错误输入非零退出，不覆盖已有结果；重复生成会移除上次清单中的过期规则。

## 正式知识如何用于开发

草稿导出仍是预览。人工采纳或 MR 归档同步为启用的正式知识后，平台从正式 Markdown 提取范式，按任务仓库、模块、语言及明确声明的产品版本选择。选型映射和派生规则分别维护启用策略；新内容默认为 shadow，只记录命中，不向开发 Agent 提示。文档采纳不等于规则启用。

组件知识工作台提供替代规则、选型映射、文档抽查、萃取记录。负责人核对实际样本和反例后可启用 warning，按相对路径限定范围；off 立即停止该项提示。策略保存在宿主数据目录 component-governance/rule-policy.json，开发工具不能修改。当前平台不提供阻断提交的 error 级别。

主开发会话、组件分析子会话、开发助手和验证会话只收到人工启用的精简选择表；详细内容沿用 knowledge read，表中提供文档 ID、修订和原文行号。component_knowledge list 筛选及分页，check 主动检查；两者不暴露候选规则的提示。

编辑/写入和 Bash 工具结束后，平台检查新增代码；宿主推送前按真实提交与目标分支共同祖先检查。两处使用同一派生器，排除组件自身实现。报告区分完成、无适用规则和未完成；候选观察仅供工作台查看。程序故障不会伪造通过，不改变需求状态或自动重试。

源范式正文、接口或范围变化后，旧启用决定回到候选；其他章节修订不影响本项。人工停用继续保留。误报反馈需具体理由，只豁免同仓、同规则版本、同代码内容及位置的后续提示。反馈统计按去重样本计算，评审退回不自动视为知识有害；反例和质量错误进入复查列表，不自动修改策略。

反例研究使用单独的新会话，只读取基础仓与 everycode；寻找合理保留原生 API 的场景，输出证据、反例或证据不足。结果不能直接采纳为范式，也不会自动启用规则。文档抽查每个组件随机选择至多 2 篇已采纳范式；连续发现错误时调整萃取方法并重新研究该组件。
