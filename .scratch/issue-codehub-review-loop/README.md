# 问题流接入 CodeHub MR 检视意见闭环(2026-09-08 立项)

对齐结论(需求侧 dispatchReviewRepair 骨架的移植,触发/注入/回复三问已拍板):

- **触发**:发现器直拉 `GET /mr/discussions`(随监看节奏,增量按
  discussion id;评审修订:免 `mr_gates` 部署前置,门禁的语义消费归
  票 02);门禁红即注入修复。
- **注入**:不举卡,平台通知直接喂 AI(并行哲学:用户在 CodeHub 提意见、
  AI 同时修,互不阻塞);修复复用同分支重推/重建 MR/重新申报的现成返工路。
- **回复**:agent 起草进工作区文件,收口后 outbox 投递——Idempotency-Key
  + expected_sha 绑定双不变量;默认不代点"已解决"(检视人职责,部署旗可开)。
- **范围**:mr_green 监看期内(申报后 → 验绿收口;收口后新意见不追,
  追责在票 02 的注入语义);归档/取消即停。
- **部署前置**:票 02 起需 `discussion_reply`(回复投递);`mr_discussions`
  未配置时发现器 fail-open 静默降级。

依赖链:01(发现) → 02(修) → 03(回)。

- [01-discover-discussions.md](issues/01-discover-discussions.md)
- [02-inject-and-fix.md](issues/02-inject-and-fix.md)
- [03-publish-replies.md](issues/03-publish-replies.md)

GitHub 可达后按依赖序逐个发 issue(01 无阻塞可先发),并回填 issue 号。
