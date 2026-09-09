# 03: 检视回复发布(回得上)

**What to build:** 修复会话把逐条检视回复起草进工作区文件(如 `reviews/review_replies.md`:每条 = discussion id + 回复正文);回合收口后问题域 outbox 向适配层 `POST /mr/discussions/:id/reply` 投递。两条铁不变量(需求侧同款,2026-09-08 对齐):**Idempotency-Key** 防重放(远端成功本地未落账的窗口不许双回复);**expected_sha 绑定**——远端推送收据 SHA 必须等于回复起草时的代码版本,不匹配保持 pending,绝不借另一版代码说"已修"。默认不代点"已解决"(检视人职责,报告 D3);部署旗可开(需 discussion_resolve 命令)。

**Blocked by:** 02-inject-and-fix.md(已完成)

**Status:** done

- [x] 修复会话按注入清单逐条起草回复,落工作区文件 `mr-review-replies.json`(数组,元素 discussion_id+body;注入通知文案里写明格式)
- [x] 草稿即消费:监看器解析入出站信箱 `mr-review-outbox.json`(工作区,宿主投递账),expected_sha=入箱时该仓最新推送收据;引用未知意见的草稿行点名跳过
- [x] 投递 POST /mr/discussions/:id/reply 带 repo/body/resolve/idempotency_key + `Idempotency-Key` 头(item.id 稳定)
- [x] expected_sha 绑定:与最新推送收据不符 → 保持 pending + last_error,绝不投递;修回绑定后自动续投(测试:漂移拒投 → 恢复续投)
- [x] 默认不代 resolve;`--resolve-discussions` 部署旗开启才代点(serve → service 已接线)
- [x] 失败容忍:投递失败退避重试(attempts 上限 5 → failed 交人工);会话终态即停
- [x] 测试:投递一次 → 重放无双发 → 漂移拒投 → 恢复续投(假件驱动,幂等键由假平台兑现)

**边界:** 不抽需求侧 taskService 的 outbox 公共件——问题域落简版,遵守同一条不变量集合;出现第三个消费方再议抽取(expand-contract)。
