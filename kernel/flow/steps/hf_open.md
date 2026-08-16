已定位问题修复只维护本单本地 Spec，不创建或提交 OpenSpec 产物。

1. 执行 `python "{MAEFLOW_PATH}" local-spec init`，取得 `.mae-flow-work/{单号}/spec.md`；
2. 写清问题、根因、修复目标、范围、可观察行为、验收条件和不在范围；没有 Grill 时在“Grill 决策”说明依据；
3. 执行 `python "{MAEFLOW_PATH}" local-spec validate`；
4. 展示范围摘要，用本步骤唯一一次用户确认决定“确认范围并继续 / 需要调整”；确认后直接 done。

本地 Spec 永不上库。若触发升级条件（3 个以上业务文件、架构或数据库变化、新增 public API），展示事实并由用户决定升级完整开发或明确接受轻量范围风险；禁止自行升级、手写状态或创建 change 目录。
