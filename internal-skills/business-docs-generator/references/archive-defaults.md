# 文稿默认目录

knowledge_layout 为 repository-v1 的新任务，领域目录由平台按业务名生成可读默认值，用户配置值作为最终仓根相对目录；仓级目标默认为仓根，首次仓级文稿使用 docs/ 下的目录，已有 docs/x.md 保留原位。module_id 仅表示业务归属，不加入目录。目标为 `.` 时，文稿 path 直接使用仓根相对路径，不加 `./` 或工作区仓名。

以工具返回的 target.docs_path 与当前文稿 path 为准。路径映射、碰撞避让、根 AGENTS.md 和旧批次重试规则统一见 [规划与路径](platform-execution.md#规划与路径)。

```json
{"domain_directory":"domain-docs","repository_directory":"."}
```
