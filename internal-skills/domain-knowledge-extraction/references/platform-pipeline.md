# 平台执行协议

本包改编自 [Issue 440](https://github.com/yunine9/mae-flow-cloud/issues/440) 附件 kb-builder。沿用小任务、独立评审、真实引用、显式未知的研究方法；调度由 Cloud 的 TypeScript 宿主完成，不依赖 Claude CLI 或 Python。

## 输入和工具

- 上下文中的 task 是唯一当前任务，spec 为具体问题，depends_on 是已完成依赖。用 knowledge_work 提供 id 读取结果；省略 id 按 start/count 分页看任务摘要。不要把所有历史灌入当前会话。
- knowledge_structure 分页读取宿主静态扫描的 CMake/Maven/npm 构建单元和依赖候选；不执行构建或解析条件表达式。
- component_source 按仓编号读取固定版本源码，分页 list、search、read；结构清单仅定位，不替代构建依赖核对。
- knowledge_material 读取上传资料、章节及图片。business_knowledge 调用无线豆包。knowledge_evidence 回读已持久保存的原始资料与查询，跨会话复用时仍需读正文。
- knowledge_draft read 查看草稿；save 保存正文，使用 archive_targets 中的 id 和 docs_path。文件里的示例 knowledge/ 和 repos/*/docs/ 要映射到这些真实目标，不能直接照搬。
- knowledge_work_result 提交当前任务结果。findings 写具体证据、文档片段、覆盖范围、排除项和依据；document_ids 只填本会话保存的草稿；open_questions 逐项写清问题、已知证据、影响、建议请教角色及优先级。

## 阶段输出

- inventory：modules 每项有 id、title、kind（public/business）、depends_on（模块编号）、scope。scope 写实际仓编号、路径、业务资料对应章节和排除依据。无引用的目录猜测不算盘点。
- plan：subfeatures 每项有 id、title、hops；每段有 id、title、questions。questions 写入口、出口、边界、3～6 个具体问题和代码/资料起点。宿主据此生成研究、公共提炼、组装与模块收尾任务。
- hop：findings 保存代码追踪、业务资料与豆包证据、约束、易错点和可供组装的段落。可不建最终文档；不要把中间笔记直接冒充已入库知识。
- common/assemble/wrap/cross/synthesis：用 knowledge_draft 保存最终草稿，再提交结果。没有公共段或跨功能影响时写检查过的候选与结论，不能虚构。
- cross-plan：cross_items 每项 id、title、questions；问题中标明链路或契约及涉及模块。确实没有时可为空，findings 要说明检查范围与依据。
- synthesis：术语任务对照业务、代码和协议术语；问题任务读取各阶段 open_questions 按模块/角色/优先级去重；索引任务列文档地图、实际覆盖及未覆盖范围。报告不宣称已合入。

## 独立评审

评审没有保存文档权限。先读取全部待评审草稿和 findings，按 phase-review.md 回查关键源码、原始上传资料和豆包证据，检查每个问题是否回答或列为待确认。代码行存在只能证明引用有效，不能证明结论正确。资料版本、截断、解析缺失和冲突必须可见。

knowledge_work_result 用 pass 和 feedback 返回结论。退回时写具体位置、问题和可执行修正意见。通过前必须打开支撑关键结论的来源；来源少于三处时全部核对，不虚构抽查。规划任务也要评审覆盖、依赖和问题粒度，不能仅凭格式正确通过。

任务结果与评审意见保存在任务数据目录。人不需要准备配置文件、安装 Claude 或复制本地知识目录；继续使用平台现有审查、修订、人工采纳与 MR 归档。
