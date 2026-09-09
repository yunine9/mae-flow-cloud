# 03: 检视回复发布(回得上)

**What to build:** 修复会话把逐条检视回复起草进工作区文件(如 `reviews/review_replies.md`:每条 = discussion id + 回复正文);回合收口后问题域 outbox 向适配层 `POST /mr/discussions/:id/reply` 投递。两条铁不变量(需求侧同款,2026-09-08 对齐):**Idempotency-Key** 防重放(远端成功本地未落账的窗口不许双回复);**expected_sha 绑定**——远端推送收据 SHA 必须等于回复起草时的代码版本,不匹配保持 pending,绝不借另一版代码说"已修"。默认不代点"已解决"(检视人职责,报告 D3);部署旗可开(需 discussion_resolve 命令)。

**Blocked by:** 02-inject-and-fix.md

**Status:** ready-for-agent

- [ ] 修复会话按注入的意见清单逐条起草回复(含"已按意见修改"的事实指针:提交/文件),落工作区文件
- [ ] 回合收口后宿主读取并投递:POST reply 带 repo/mr/body/resolve/idempotency_key,`Idempotency-Key` 头稳定
- [ ] expected_sha 绑定:推送收据 SHA 不匹配 → 不投递、落失败原因、保持 pending,对应 SHA 推送恢复后自动续投
- [ ] 投递结果入账(pending/attempt/delivered/failed),重放安全:同一 key 重复投递不产生第二条 CodeHub 回复
- [ ] 默认不代 resolve;部署旗开启且适配层配了 discussion_resolve 才代点
- [ ] 失败容忍:投递网络失败退避重试,不阻塞会话收口;会话取消/归档时 pending 回复如实标注不再投递
- [ ] 测试:起草 → 投递一次 → SHA 漂移拒投 → SHA 恢复续投 → 重放无双发,全链路(假件驱动)

**边界:** 不抽需求侧 taskService 的 outbox 公共件——问题域落简版,遵守同一条不变量集合;出现第三个消费方再议抽取(expand-contract)。
