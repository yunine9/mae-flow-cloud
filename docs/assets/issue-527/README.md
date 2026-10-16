# 需求交付实战流程

![把需求交付的每一步展开](delivery-collaboration.png)

- [高清 PNG](delivery-collaboration.png)：3840 × 2160，16:9，可直接插入演示文稿。
- [可编辑 SVG](delivery-collaboration.svg)：1920 × 1080 矢量源文件。

按 [Issue 527 的新增检视意见](https://github.com/yunine9/mae-flow-cloud/issues/527#issuecomment-6209227861)，将原来的五段概览展开为 12 项具体工作：需求澄清、确认需求说明、Story 设计、架构与任务拆分编码、专项编译、CodeCheck、UT、需求实现对照、MR 推送、独立 Agent 检视、意见修复、再次推送。每项说明执行角色、具体动作和产出；底部保留需求、代码、测试、知识四类成果。

## 图示口径

这是工作内容的展开，不是每项任务必须经过的固定审批链。架构与任务边界在 Story 和实施附录中形成；图中将其与编码衔接展示。本地编译、UT 用于自查；CodeCheck 与最终验证由推送后的流水线完成，结果只对应实际验证过的版本。第 06 项按工作内容列在验证部分，并用“推送后”标明实际执行时间；专项编译子 Agent 只读返回结果，修复由主 Agent 完成。Story 及实施附录经独立检视和主 Agent 修正后，由责任人确认进入编码。用户确认的修改沿原任务、原分支与原 MR 接续，最终合入由人审批。

**第 10 步“自动检视”标为待接入，相关箭头为虚线。** 用户明确希望这里表示 Mae-Flow 内部的独立代码检视 Agent。本次核对 `main` 的 `792552815bed2d6fe2721c3e65d808a34a615f0b`（2026-10-16）：仓库保留了需求符合性与工程质量两个代码检视视角的角色说明，但普通需求流程中已接通的是 Story 设计检视；尚未找到 MR 推送后自动调用该代码检视角色的入口。因此，图中该环节及“新提交再次独立检视”的循环表示目标流程，不作为现有自动能力的证明。本次仅优化材料，没有实现或部署此入口。

## 代码依据

- [需求澄清](https://github.com/yunine9/mae-flow-cloud/blob/792552815bed2d6fe2721c3e65d808a34a615f0b/kernel/flow/steps/grill.md)、[Story 生成与独立设计检视](https://github.com/yunine9/mae-flow-cloud/blob/792552815bed2d6fe2721c3e65d808a34a615f0b/kernel/flow/steps/story.md#L6)、[编码与针对性验证](https://github.com/yunine9/mae-flow-cloud/blob/792552815bed2d6fe2721c3e65d808a34a615f0b/kernel/flow/steps/build.md#L1)。
- [检视角色说明](https://github.com/yunine9/mae-flow-cloud/blob/792552815bed2d6fe2721c3e65d808a34a615f0b/kernel/agents/craft-reviewer-agent.md#L24)与[当前可调用的角色入口](https://github.com/yunine9/mae-flow-cloud/blob/792552815bed2d6fe2721c3e65d808a34a615f0b/kernel/scripts/mae_flow_core/quality/role_tasks.py#L4)：区分角色说明与实际接线。
- [推送后流水线验证](https://github.com/yunine9/mae-flow-cloud/blob/792552815bed2d6fe2721c3e65d808a34a615f0b/kernel/flow/steps/external_verify.md#L1)、[已授权检视意见修复与原 MR 更新](https://github.com/yunine9/mae-flow-cloud/blob/792552815bed2d6fe2721c3e65d808a34a615f0b/src/taskService.ts#L18668)、[真实合入状态](https://github.com/yunine9/mae-flow-cloud/blob/792552815bed2d6fe2721c3e65d808a34a615f0b/src/mergeWatch.ts#L129)。

图中文字使用 PingFang SC / Microsoft YaHei 等系统字体。编辑环境缺少相应字体时可替换为可用中文字体；直接展示建议使用 PNG。
