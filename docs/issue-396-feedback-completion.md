# Issue 396：检视修复完成后交还宿主

## 事实与根因

更新后的 task-15 时间线证明：02:19 已到 external_verify；03:12 新工作台意见打开新批次，从 delivery_watch 回到 feedback_triage 是正常行为。04:10 Agent 答复 fixed、06:20 责任人闭环后，反馈批次仍 repairing，才是本次问题。

Cloud 在 turn_finished 中先按 current 催办、后登记反馈结果。反馈步骤需要登记结果才能离开，但催办提前返回，导致结果登记无法执行。即使登记成功，Cloud 管理的有代码变化批次原先仍被送回 build，要求 Agent 再走一轮步骤。

activeFeedbackResult 对纯工作台/MR 批次返回 undefined 是有意的：这两种来源已经有批注答复或 review_replies.md，不要求第二份 JSON。recordActiveFeedbackResult 独立读取活动批次，不依赖该函数；本次保留这个简化路径。

## 修改

- 在通用步骤催办之前消费逐条答复、登记本批结果；缺失答复仍走已有的一次补交，实际人工问题走明确的待判断路径。
- 作者已确认、撤回或已被新版本替代的旧意见直接记录其现有处置，不催 Agent 为它补写答复。
- Cloud 管理的活动批次进入 awaiting_verification 后，直接交给 external_verify，由现有宿主交付路径接手。不自动产生 PASS、不代替真实流水线结果或用户推送决定。
- 已登记结果但仍卡在旧写入步骤的任务，幂等重放原结果恢复交接，不修改原处理结论。
- 未处理的新批次、needs_human、终态以及独立运行的内核不适用上述自动交接。
- 工作台检视修复实际使命中说明：修改、必要验证与答复完成即可结束，不为推进步骤重复处理已闭环意见。

## 验证与部署

Cloud 的反馈来源、反馈循环、流水线交接、持续检视契约、内核暂时不可用恢复共 57 项通过；内核 continuous_review 共 39 项通过。真实调用内核的回归包含 20 条已闭环意见、Agent fixed 后责任人 fixed、旧任务结果重放和 needs_human 保留。

内核源仓提交 9f5096b，经 harness/sync-kernel.sh 同步快照。部署 Cloud 新版本后，仍活跃的修复会话在下一次收口时使用新逻辑；已因旧催办耗尽而停机的任务需要重跑一次。本地验证不代表生产 task-15 已恢复。
