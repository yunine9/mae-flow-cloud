# 测试全量审计与提速(2026-09-11)

全量基线(dev @ c1965c0):319 文件 / 2173 用例,2092 过 / 50 败 / 31 跳过,
墙钟 **667s(11.1 分钟)**,串行用例总耗时 2124.7s——并发 12 只跑出
**3.18× 有效并行**。本文记录失败归因、耗时分布与已落地的提速改动。

## 一、50 个失败的归因(全部存量,实证过)

| 组 | 数量 | 根因 | 证据 |
|---|---|---|---|
| 协作检视线欠账 | ~46 | #202/#203(交付依赖排除/检视意见携带)及 9/9-9/11 一串协作修复(f6b3e76/88e78db/8505d05/6ea651a/404d8ec/1053dd5)改了行为、测试没跟:检视意见 owner 权限墙(annotationConcurrency×2、decisionAnnotationReplay×2、requirementReviewAcceptance×3、reviewParticipation、reviewReceipt、requirementEditing×2、reviewReworkShortcut)、锚条文案漂移(conversationStream:「N 条意见等你逐条确认」→实际渲染「N 条意见待你处理」)、UI 契约漂移(issueUiContracts×6、issueNavUi×2、environmentRegistryUi、usabilityTweaks、hostSkills、issueBusinessKnowledge、compaction)、e2e 流程断言(mrLoop×4、prepush×3、pipelineEvidenceFallback×2、deliverySelection×4、pushConfirmation、taskHostSession、kernelCommitRedirect、overallStory、issueLubanApproval、issueFlowFixed) | 快组在 746aad4(当日所有会话提交之前)重跑同样红;重型组 4 路低并发批验 37/35 复现;单跑「检视优先于 CI」等也红 |
| 磁盘治理欠账 | 1 | 229e65e 把「取消不清现场」改成「取消即回收」,issueRerunIsolation「取消后重跑同单」断言过时 | 纯 HEAD 即红 |
| 独立存量 | 3 | issueMergeFact 的「mr_green 验绿收口」超时 | 摘除当日改动后依旧失败 |

修法方向:**按新行为更新断言**(这些用例编码的是协作线契约,删了就丢覆盖),
归属协作线(检视/交付)的负责人。

## 二、耗时分布(基线)

- 分布长尾:≥30s×9,10-30s×45,3-10s×102,1-3s×92,0.3-1s×260,<0.3s×1634
- **54 个 ≥10s 用例(占数量 2.5%)吃掉 56.5% 串行时间**
- 文件聚合(≥3s 用例口径):mrLoop 557s ≫ prepushIntegration 141s >
  issueFlowFixed 129s > delivery.part1-6 共 ~330s > serveConfig 73s
- 单用例 TOP:97.2s(prepush 网络重试,失败用例)、79.6s(检视优先于 CI,
  失败)、75.0s(单 writer steer 撞派单,失败)、68.3s、60.4s

## 三、已落地:三个巨文件拆分(2026-09-11)

node:test **按文件并行、文件内串行**——单文件串行耗时就是全量墙钟的地板,
12 个工人陪一个 9 分钟的巨文件跑完是 3.18× 有效并行的直接原因。照
delivery.part1-6 的既有先例拆分:

| 原文件 | 拆成 | 单文件耗时 | 验证 |
|---|---|---|---|
| mrLoop.test.ts(557s,26 用例) | mrLoop.part1-6(共享夹具 tests/mrLoop.helpers.ts) | 40~117s | 26 用例、同样 4 败 22 过,行为零变化 |
| prepushIntegration.test.ts(141s,6 用例) | part1-2(tests/prepushIntegration.helpers.ts) | ~106s / ~35s | 6 用例、同样 1 败 5 过 |
| issueFlowFixed.test.ts(129s,59 用例) | part1-2(tests/issueFlowFixed.helpers.ts) | ~67s / ~62s | 59 用例、同样 1 败 58 过 |
| delivery.part3.test.ts(80s,4 用例) | parta/partb(共用既有 delivery.helpers.ts) | ~46s / ~34s | 4 用例全过 |
| serveConfig.test.ts(73s,13 用例) | part1-2(tests/serveConfig.helpers.ts) | ~40s / ~34s | 13 用例全过 |
| prepushContainerIntegration.test.ts(63s,10 用例) | part1-2(tests/prepushContainerIntegration.helpers.ts) | ~35s / ~28s | 10 用例、同样 1 败 1 跳过 |
| issueLubanApproval.test.ts(61s,4 用例) | part1-2(tests/issueLubanApproval.helpers.ts) | ~60s / <1s | 4 用例、同样 1 败 |

拆分纪律(同 delivery 先例):helpers 不带 .test.ts 后缀不被执行;各 part
头注注明主题与「断言与测试行为零变化」;test:fast 排除表按子串匹配,
mrLoop/issueFlowFixed 的新 part 文件名自动继承排除。

**拆后实测(同日,两轮)**:第一轮(拆三巨文件,并发 12)全量墙钟
**667s → 299s(2.23×)**;第二轮(再拆 delivery.part3/serveConfig/
issueLubanApproval/prepushContainerIntegration 四个 60s+ 文件,并发
提到 20)**→ 241s(累计 2.77×)**,有效并行 3.18× → **8.8×**;用例
总数与逐用例结果零变化(期间合入的 f4daf56 shadcn 化提交自身
-3 Modal 用例 +2 Dialog 用例,与拆分无关)。并发度改为环境变量
`MFC_TEST_CONCURRENCY` 可覆盖、缺省 20(本机 20 核;弱机可调低)。
**超核并发实测反效果**:24 路(20 核)墙钟劣化到 483s 且失败 50→60
——资源争抢让时序敏感的 e2e 抖动,并发度以核数为上限。

剩余墙钟构成:最慢文件 mrLoop.part1(~117s,内含 79.6s 的失败用例
烧满超时)与 prepush.part1(~106s,内含 96s 失败用例)是地板——
**修失败用例是下一个最大杠杆**(超时税消失后地板降到 ~50s 级)。

## 四、重复/无效用例排查结论

- 跨文件同名用例:**0**;文件内重名:**0**;显式 `test.skip`:**0**
- 31 个 skipped 全是环境条件跳过(projection 缺 pg、容器缺镜像/docker、
  memsearch 缺 venv、平台专属二进制)——是健康分层,不是死用例
- 结论:**没有机械意义上的重复/无效用例可删**;「错误用例」即第一节
  的 50 个过时断言,处置是更新而非删除

## 五、后续提效建议(按收益排序)

1. **修失败用例顺带省超时税**:50 个失败里大量是 15~96s 等待超时烧满才红
   (prepush 网络重试一条就 96s)。按第一节归因更新断言后,这部分墙钟
   直接消失——修正确性和提速是同一件事。
2. **until() 识别相反终态 fast-fail**:等「绿灯/收口」的轮询里,先看到
   终局错误(如 status=failed、明确异常态)就立即抛,不等烧满预算。
   全绿无感,失败轮省几分钟。
3. **e2e fixture 复用**(中期):97 个文件起 ScriptedModelServer(临时端口,
   无冲突)、116 个起 TaskService,每用例独立 git 裸仓(init/clone/push
   10~25 次 spawn)。文件内共享 seed 仓 + `clone --shared` 可省一批进程
   冷启;改动面大,收益中等,不急。
4. **真容器路径分档**(可选):prepushContainerIntegration/containerSystemCheck
   等有 REAL_DOCKER 分支(60s+),CI 可给容器用例单独标记分层。
5. **不建议**:关进程隔离换启动速度——319 文件×~0.5s 的 tsx 启动已被
   并行摊薄,换共享状态风险不值。
