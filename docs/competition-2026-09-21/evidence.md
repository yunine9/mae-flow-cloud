# 准备材料的事实核对

核对日期：2026-09-20。代码基准：`49d7a2f5`。只读本地代码与文档，未访问内网生产。比赛中展示的实际需求尚未指定，不编造任务数据。

架构页是职责示意图，不是每个矩形对应一个独立进程或已经完全拆开的服务。MAE Flow 的核心方法与状态能力，和 Cloud 提供的宿主、团队交互、平台集成，应在口述中区分。

| 讲述点 | 核对入口 | 允许表达与边界 |
| --- | --- | --- |
| 方法与执行事实分开 | `kernel/docs/kernel-authority.md`、`AGENTS.md` | 方法交给 Prompt/Skill，人判断质量，程序记录决定与实际结果。不说所有形式检查都已从每条链路移除。 |
| Agent 及宿主执行 | `src/sessionDriver.ts`、`src/taskHostTools.ts`、`src/executionRuntime.ts` | Cloud 承接 Agent 执行和宿主操作。不能把全部 Cloud 能力归于插件本体。 |
| 会话保存与恢复 | `docs/execution-continuity.md` | 原会话恢复、状态留存有实现。Web 重启不中断执行要求独立部署，执行器退出仍可能中断命令。 |
| 客观失败与检视意见分流 | `src/mergeWatch.ts`、`src/externalReviewInbox.ts` | CI/代码质量/可处理冲突属于自动修复候选，检视意见交责任人。是否启动还取决于任务状态、配置与证据，不能说所有红灯都立即自动修好。 |
| 人工意见统一送达 | `src/annotationSubmissionView.ts`、`src/taskService.ts` | 正式检视卡提交修改可沿调整路径继续。暂停只排队，澄清不代答，已完成任务有不同限制。 |
| 平台差异适配 | `src/platformAdapter.ts`、`deploy/adapter-config/` | 适配命令、抽取返回字段，有清晰入口。不能宣称换任意平台都零代码。 |
| 取消、接管和危险操作边界 | `kernel/docs/kernel-authority.md`、`src/gateService.ts` | 有既有控制和权限边界。不宣称能阻止所有危险指令、零数据泄露或具备独立安全认证。 |
| 维护与流程简化 | `AGENTS.md`、`kernel/docs/kernel-authority.md` | 讲清删除重复检查的原则和已落地例子。不把流程越少等同于质量越高。 |

本轮保留现有 `docs/mae-flow-external-sharing.md` 和 `docs/mae-flow-external-sharing-evidence.md` 的未提交修改，作为参考阅读，没有覆盖它们。

不使用提交数量、代码行数或工程规模证明质量。没有核对同口径实测数据，不声称节省百分之多少人力、提效多少倍。代码与文档证明设计存在，生产案例才支撑现场运行效果。
