# 文稿默认目录

directory-v1 的每个目标默认使用 `docs/<业务名称>`。平台按业务名称和配置生成最终 target.docs_path；代码仓使用 docs/ 下的业务目录，领域知识仓使用用户保存的非根目录。下面 JSON 仅保留兼容旧方法读取器所需的目录基准，模型产物路径以任务返回的 target.docs_path 为准。

```json
{"domain_directory":"docs","repository_directory":"docs"}
```

路径映射、避让、平台生成的 AGENTS.md 和旧批次重试见 [规划与路径](platform-execution.md#规划与路径)。
