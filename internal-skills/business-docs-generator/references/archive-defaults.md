# 文稿默认目录

以下是新任务的目录基址。knowledge_layout 为 module-v1 时，平台按稳定 module_id 生成独占目录：领域默认 domain-docs/<module_id>，仓级默认 docs/knowledge/<module_id>。工具上下文的 target.docs_path 已是最终目录，Agent 不再拼接 module_id；每个目标以该目录 README.md 为入口，领域详细索引用 index.md，不生成子目录 AGENTS.md，仓根公共 AGENTS.md 不属于模块任务产物。

其他布局的研究继续使用任务保存的原包与当前路径。已有 module_id 的旧任务在新归档前由维护人显式整理目录、核对并确认发布，不自动发布未确认草稿；已有批次重试保持原记录，没有 module_id 不猜测归属。整理将模块级 AGENTS 成果移至 README.md/index.md，不要求重新研究。module-v1 根 AGENTS.md 由平台每次归档完整重建，旧正文保存在 Git 历史。具体映射与边界见 [规划与路径](platform-execution.md#规划与路径)。

```json
{"domain_directory":"domain-docs","repository_directory":"docs/knowledge"}
```
