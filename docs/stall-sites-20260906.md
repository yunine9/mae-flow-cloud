# 自动验证停摆点盘账(2026-09-06)

背景:近十天 204 笔 fix 里最大一桶(52 笔)是"门禁/证据误判",根子之一是
`markVerificationStalled` 有 24 个调用点、各带一句中文原因,没有类别,
只有 2 处经过唯一分类处 `classifyDeliveryFailure`。本表是查实结论,
供决定"最小修补"还是"引入停摆类别"。行号以 main@338d662 为准。

## 三条横切事实

1. **6 处把内核一次没答直接判停摆。** 15/19/21/22/24 号(打开反馈批次、
   登记 close 失败)与 1 号(迁移失败)都是 `catch (error)` 后立刻停,不经
   分类器。内核抖一下就停摆喊人,正是分析里点名的误诊形态。
2. **多数停摆没人被通知。** 停摆后只调 `notifyRepairStopped`,而它在
   `delivery.loop` 缺席时直接返回。24 处里只有修复环上下文里的停摆会发
   通知,其余停摆只在页面亮牌子。`stalled` 字段注释写的"通知发出"没有
   兑现。
3. **页面对所有停摆说同一句话。** 焦点一律"查看失败原因并重跑续推";任务
   卡的提示对没有修复环的停摆一律写"确认外部平台恢复后,点「重新尝试
   交付」"。对 SHA 对不上、外来提交这类完整性停摆,这句话是在劝人跳过
   核实直接重试。

## 逐点表

| # | 行 | 所在方法 | 触发原因 | 带预算重试 | 经分类器 | 建议类别 |
|---|---|---|---|---|---|---|
| 1 | 8907 | recover | 持续检视迁移无法安全完成 | 无 | 无 | 需分类(infra/contract) |
| 2 | 9041 | recover | 持续检视索引损坏或不可写 | 无(outbox 有探测续接) | 无 | infrastructure |
| 3 | 13467 | syncFeedbackStoreFromKernel | 同上 | 无(KernelUnavailable 已上抛) | 无 | infrastructure |
| 4 | 14647 | holdWithRecovery | 自愈预算耗尽 | 有 | 由调用方 | infrastructure |
| 5 | 14714 | runDeliveryRecovery | 回执材料不合格 | 有 | 有(receipt) | evidence_invalid |
| 6 | 14722 | runDeliveryRecovery | 交付重试预算耗尽 | 有 | 部分 | infrastructure |
| 7 | 14765 | schedulePipelineEvidenceRetry | 证据核销预算耗尽 | 有 | 无 | evidence_missing |
| 8 | 14917 | commitPolicyFailure(5 个调用方) | 工作区缺失/提交策略 | 无 | 无 | contract |
| 9 | 16192 | pushConfirmationSatisfied | 任务基线不可读 | 无 | 无 | contract |
| 10 | 16364 | deliverySelectionAllowsPush | 当前 HEAD 无 Build-Fix 收据 | 无 | 无 | evidence_missing |
| 11 | 16416 | reconcileFrozenBaselineAncestry | 定格基线祖先不一致 | 无 | 无 | safety |
| 12 | 16536 | deliveryScopeAllowsPush | 越界改动 | 无 | 无 | safety |
| 13 | 16899 | tryDeliver | external_verify 未配置平台 | 无(刻意) | 无 | contract |
| 14 | 17188 | tryDeliver | 交付动作失败判 stall | 有 | 有 | 由分类器给 |
| 15 | 17777 | dispatchCiRepair | 内核未能打开反馈批次 | 无 | 无 | 需分类 |
| 16 | 18028 | settleMergeState | 合入 SHA≠验证过的 SHA | 无 | 无 | safety |
| 17 | 18036 | settleMergeState | 平台未回源提交 SHA | 无 | 无 | evidence_missing |
| 18 | 18068 | settleMergeState | 在途执行者未确认停止 | 无 | 无 | infrastructure |
| 19 | 18082 | settleMergeState | 内核未能登记可信 close | 无 | 无 | 需分类 |
| 20 | 18196 | watchMerge | MR 源分支指向未验证提交 | 无 | 无 | safety |
| 21 | 18829 | dispatchReviewRepair | 内核未能打开持续检视批次 | 无 | 无 | 需分类 |
| 22 | 18959 | dispatchWorkspaceReviewRepair | 同上(工作台批注) | 无 | 无 | 需分类 |
| 23 | 19104 | absorbForeignRemoteCommits | 外来提交判 blocked | 无 | 无 | safety |
| 24 | 19308 | dispatchConflictRepair | 内核未能打开反馈批次 | 无 | 无 | 需分类 |

类别按"人接手要做什么"分:infrastructure 等环境恢复再重跑;evidence_missing
把缺的材料补齐;evidence_invalid 让 Agent 重做或补说明;contract 修配置或
提交;safety 先人工核实、绝不自动重试。

## 两种收法(待拍板)

- **最小修补(不加字段)**:6 个 catch 点先过分类器,判"重放有意义"的走既有
  带预算挂起(拿得到 epoch 的 5 处),其余照旧停;停摆一律发通知;删掉
  任务卡那句写死的"确认外部平台恢复后点重新尝试交付"。
- **引入类别(新字段 `delivery.stall_class`)**:每个停摆点声明类别,TS 强制
  24 处一个都逃不掉;焦点与任务卡按类别给"去哪、做什么";通知带类别标签。
  代价是一个新字段、一张策略表、契约测试一份。
