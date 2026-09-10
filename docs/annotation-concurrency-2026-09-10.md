# 检视意见并发回归检查（2026-09-10）

任务责任人决定意见是否闭环；提出人可以提交、编辑自己的意见。后台执行与状态恢复不得把后来的人工作业覆盖成旧状态。本轮沿用该权限规则，不增加审批步骤。

## 确认并修复的问题

- 历史决定补账只有意见 ID，没有正文版本：刷新把退回后的草稿再次标成已发送。已在 `3fecd11` 绑定轮次与正文，并保护在途旧决定。
- 需求修订队列只按 ID 去重：同一意见在旧轮执行中退回重提，新轮被忽略。队列改按 ID、轮次与正文识别；旧轮失败只能重置旧版本。
- 发送请求、需求修订、整体 Story 修订在异步完成后直接按 ID 登记送达：会复活期间编辑、删除或退回的意见。共用 `AnnotationStore.markSentFor`，只更新实际处理过且尚未闭环的版本。新版本保持当前状态，旧回执不再引发已发布文档的整轮失败。
- 整体 Story 的责任人可见“仍需调整”，但底层沿用旧的处理中拒绝规则。允许经过服务端责任人核验的退回；旧轮完成不得覆盖该决定。

## 验证

85 项测试通过，类型检查通过。覆盖真实 HTTP 权限、正常意见提交、决定恢复、发送期间编辑或删除、责任人退回或延期后的晚到回执、同一意见重提入队、整体 Story 新旧轮连续执行，以及取消和重启后的旧队列回调。

相关回归：`annotationConcurrency.test.ts`、`decisionAnnotationReplay.test.ts`、`requirementReviewQueue.test.ts`、`requirementReviewAcceptance.test.ts`、`requirementReviewLifetime.test.ts`、`overallStory.test.ts`、`annotations.test.ts`、`ownerAnnotationResolution.test.ts`。

未连接内网服务，也未改写已有批注操作日志。部署后保护后续操作；已经生成的错误历史记录不自动删除或推断回滚。
