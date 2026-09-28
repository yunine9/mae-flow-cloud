> 平台适配：本文中的 `_work/`、`spec` 和输出文件是研究内容的组织说明。实际任务从当前上下文与 `knowledge_work` 读取；中间发现用 `knowledge_work_result` 保存，最终正文用 `knowledge_draft` 保存到平台给出的目标和 docs_path。不得自行写本地文件。输出协议以 [平台执行协议](platform-pipeline.md) 为准。

# 汇总阶段

任务 spec 中的 `subtask` 决定你做哪一项。三项分别由三个独立会话完成。

## subtask = glossary → `knowledge/glossary.md`

输入：`_work/glossary/` 下所有术语候选文件。

1. 合并去重。同一业务术语对应多个代码命名时保留全部，并说明各自的使用范围。
2. 候选之间矛盾时，打开出处核实。
3. 按模块分组，模块内按业务术语排序。公共术语放在最前面。
4. 使用模板 `glossary.md`。每一行保留一个代表性出处。

## subtask = questions → `open-questions.md`

输入：`_work/questions/` 下所有待确认问题文件。这份清单会被直接分发给各领域专家，质量很重要。

1. **剔除已解决的**：对每个问题，检查最终文档（`knowledge/`、`repos/*/docs/`）是否已经回答了它（后续任务可能查到了答案）。已回答的删除。
2. **合并重复和相近的问题**，保留信息最全的表述，合并"已知"部分。
3. **按模块分组**，模块内按"建议请教"的角色分组，方便分发。
4. **标注优先级**：高 = 答案影响改动的正确性或安全性；中 = 影响理解；低 = 背景信息。高优先级排前。
5. 每个问题保留原编号，便于回溯到来源任务。
6. 使用模板 `open-questions.md`，开头写一段统计：问题总数、按模块和优先级的分布。

## subtask = index → 导航文件

1. **`knowledge/AGENTS.md`**（上层知识库的全局地图，Agent 进入时首先读它）：
   - 有哪些代码仓，各自负责什么（一两句）。
   - 模块表：模块、类型（公共/业务）、一句话说明、链接到 `chains/<模块>/README.md`。
   - 跨模块链路与跨仓契约的列表和链接。
   - 术语表与待确认问题的位置。
   - 使用约定：改某模块代码前先读该模块 README；跨模块改动先查 `chains/_cross/` 与 `contracts/`。
   - 保持简短，100 行以内，它是地图不是百科。
2. **`knowledge/chains/README.md`**：所有模块及跨模块链路的索引。
3. **`repos/<仓名>/docs/README.md`**（每个仓一个）：本仓 `docs/modules/` 下的文档索引；说明跨仓知识在上层知识库（写"上层知识库的 chains/ 目录"，不要写本机绝对路径）；列出本仓参与的模块。

frontmatter 中 `type` 分别为 `index`，`related_code` 可以是仓根目录级别的 glob（如 `backend:src/**`）。
