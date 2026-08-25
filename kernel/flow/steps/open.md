本步骤只生成本单本地 Spec，不创建或提交 OpenSpec 产物。

1. 执行 `python "{MAEFLOW_PATH}" local-spec init`，取得 `.mae-flow-work/{单号}/spec.md`。
2. 读取 `.mae-flow-work/{单号}/grill.md`、需求原文和 `.mae-flow-work/{单号}/survey.md`。
3. 从需求原文提取 1～3 个领域关键词，分别执行 `python "{MAEFLOW_PATH}" domain-docs context --term "<需求关键词>"`，只读取输出列出的相关 `docs/specs/*.md`；不得用单号代替关键词，也不得全量加载领域文档。
4. 填写范围、可观察行为、验收条件、不在范围和 Grill 决策。每条 Grill 决定必须在 Spec 中可追踪。
5. 执行 `python "{MAEFLOW_PATH}" local-spec validate`。校验失败时修改本地 Spec 后重试，不提交该文件。
6. 展示简洁 Spec 摘要，用本步骤唯一一次确认卡明确分流：
   - `Spec 无需再调整，确认生成 Story`
   - `Spec 仍需调整（按当前检视意见修改）`
   选择调整时先留在本步落实意见、重新校验并再次展示；只有选择“无需再调整”
   才执行 `done` 进入 Story。不得把附带待处理意见的回答当作确认通过。

Spec 永远留在 `.mae-flow-work/{单号}/spec.md`。本步骤禁止 `git add` Spec，也禁止另建编码前计划过程件。
