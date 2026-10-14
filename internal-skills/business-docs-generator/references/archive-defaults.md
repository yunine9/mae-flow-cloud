# 文稿默认目录

以下是新任务的目录基址。knowledge_layout 为 module-v1 时，平台按稳定 module_id 生成独占目录：领域默认 domain-docs/<module_id>，仓级默认 docs/knowledge/<module_id>。工具上下文的 target.docs_path 已是最终目录，Agent 不再拼接 module_id；每个目标以该目录 README.md 为入口，领域详细索引用 index.md，不生成子目录 AGENTS.md，仓根公共 AGENTS.md 不属于模块任务产物。

其他布局沿用任务保存的原包与原路径，即使已有 module_id 也不自动迁移。已完成旧任务的“按业务模块整理目录”由归档功能处理，不要求重新研究。具体映射见 [规划与路径](platform-execution.md#规划与路径)。

```json
{"domain_directory":"domain-docs","repository_directory":"docs/knowledge"}
```
