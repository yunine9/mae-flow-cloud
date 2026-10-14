# 文稿默认目录

以下是新任务的目录基址。knowledge_layout 为 module-v1 时，平台按稳定 module_id 生成独占目录：领域默认 domain-docs/<module_id>，仓级默认 docs/knowledge/<module_id>。工具上下文的 target.docs_path 已是最终目录，Agent 不再拼接 module_id；每个目标以该目录 README.md 为入口，领域详细索引用 index.md，不生成子目录 AGENTS.md，仓根公共 AGENTS.md 不属于模块任务产物。

其他布局的研究继续使用任务保存的原包与当前路径。有 module_id 的旧任务在确认并发布时自动整理路径和 Markdown 链接，将模块级 AGENTS 成果转为 README.md/index.md；保留全部正文、原 ID、调查、历史与固定 Skill，不重新研究。目录与其他模块已登记目录重叠时自动选用独立目录；文件重名或被其他正式文稿占用时，以稳定文稿 ID 后缀、必要时序号避让，不覆盖其正文。平台同步链接，在已有 README.md/index.md 或选定的现有文稿中保留可读清单，不额外新建文稿。只有本次选中的文稿发布新版本，未选草稿不因整理自动发布。归档设置仅供可选查看或自定义，无需手工修复重名；未配置 Git 仓也能发布到平台。正式版本过期及并发修改仍可能阻止发布，不由路径避让绕过。查看任务或发起 Git 归档不触发自动整理；Git 归档仍须单独发起，已有批次重试保持原记录，没有 module_id 不猜测归属。module-v1 根 AGENTS.md 由平台每次归档完整重建，只提供可读指引，不写机器标记，旧正文保存在 Git 历史。具体映射与边界见 [规划与路径](platform-execution.md#规划与路径)。

```json
{"domain_directory":"domain-docs","repository_directory":"docs/knowledge"}
```
