本步骤只生成本单本地 Spec，不创建或提交 OpenSpec 产物。

1. 执行 `python "{MAEFLOW_PATH}" local-spec init`，取得 `.mae-flow-work/{单号}/spec.md`。
2. 读取 `.mae-flow-work/{单号}/grill.md`、需求原文和 `.mae-flow-work/{单号}/survey.md`。
3. 从需求原文提取 1～3 个领域关键词，分别执行 `python "{MAEFLOW_PATH}" domain-docs context --term "<需求关键词>"`，只读取输出列出的相关 `docs/specs/*.md`；不得用单号代替关键词，也不得全量加载领域文档。
4. 填写范围、可观察行为、验收条件、不在范围和 Grill 决策。每条 Grill 决定必须在 Spec 中可追踪。
5. 执行 `python "{MAEFLOW_PATH}" local-spec validate`。校验失败时修改本地 Spec 后重试，不提交该文件。
6. 展示简洁 Spec 摘要，让用户执行本步骤唯一一次确认；确认后直接进入 Story。

Spec 永远留在 `.mae-flow-work/{单号}/spec.md`。本步骤禁止 `git add` Spec，也禁止另建编码前计划过程件。
