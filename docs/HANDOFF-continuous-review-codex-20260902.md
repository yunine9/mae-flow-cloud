# 交接:持续检视收据链——给 codex(2026-09-02)

用户拍板后由 Claude 代为转达。两件事,一件是决定,一件是动手前必看。

## 1. 决定:「检视意见确认绑死代码版本」不合入

你工作副本里未提交的那组改动(server.ts `await service.verifyAnnotation`、
taskService 里 verifyAnnotation 对 fixed_sha / HEAD / push_review.head_sha
的比对 → StateConflictError、decide() 的 CLOUD_PUSH_CONFIRM_STEP head 校验、
MR 检视发送重排,以及 annotations / mrLoop / pushConfirmation / reviewReceipt
四个测试)——用户明确不要:

> "代码一直在变,搞这么严干啥?"

持续检视的目标是把来自四面八方的检视意见修完、直到 MR 合入,不是把
agent 当犯人管。意见确认绑死到某个 SHA,代码每往前走一步就要重新确认,
是给自己加摩擦。请撤掉这组改动,不要推。

## 2. 动手前必看:你的现场基于旧 356f9de,main 已经走到 db7b078

今天 main 上落了四笔,都是持续检视链的死锁/停摆修复,和你的改动区域重叠:

| 提交 | 内容 |
|---|---|
| 6a561a9 | 内核六处死锁修复收编进 kernel/(mae-flow@092fad5),Cloud 收据契约镜像对齐 |
| 8125d05 | 流水线登记失败一次只准挂起重试,不许误诊成"索引损坏"停摆 |
| eda5537 | delivery 宿主命令补三次基础设施重试,每次换新凭据 |
| db7b078 | **收据核对收回内核 `delivery attest`,Cloud 侧镜像整段删除**(mae-flow@97b7752) |

你的分支基于 356f9de(旧 topic 分支,已被 main 取代并删除),rebase 到
db7b078 时会撞到这些:

- **`src/kernelDelivery.ts` 导出变了**:`trustedKernelHostProjection`、
  `kernelHostLifecycleProjection` 已不存在;`trustedKernelHostLifecycle` /
  `trustedKernelHostActiveBatch` 的入参改为 `{ host, cwd, actions, state? }`
  (不再要 workspace / taskId,内核自己从 cwd 解析信任根与任务号)。
  taskService 里凡引用这几个的 import 与调用都会冲突。
- **`tests/pushConfirmation*.test.ts` 夹具**:main 上的夹具已按新内核契约
  走真 `pipeline record --host-proof` 铺链(见 `tests/kernelHostFixture.ts`
  的 `sealPipelineLifecycle`),手写 `.mae-flow.json` 不再算前序。
- **本仓不许再有一行收据核对逻辑**:`tests/kernelHostAttest.test.ts` 静态
  断言 `kernelDelivery.ts` 里不出现投影 schema / 收据前缀 / 摘要字段。
  要核对收据,只能走 `attestKernelHost` → 内核 `delivery attest`。
- **kernel/ 快照必须是 97b7752**:你的测试若跑在旧快照上,`delivery attest`
  不存在,三个 trusted* 门恒假。改内核宿主命令形状时同一提交跑
  `harness/sync-kernel.sh` 并改 Cloud 调用方,这条纪律不变。

建议顺序:先撤第 1 节那组改动 → `git fetch` → 把剩余改动 rebase 到
`origin/main`(db7b078)→ `npm run typecheck` → `npm test`。README
「2026-09-02 持续检视宿主收据链的死锁排查」一节有五条改动的来龙去脉。

## 3. 进度条词表(2026-09-02 晚,main@1357c13)——前端不许再写阶段名

用户实锤"每个任务进度条都不一样、点阶段名弹黄字不匹配",根因是三套词表
打架(内核看板 / `project()` 进入持续检视后强换五段 / 前端兜底七段)。
现在:

- 词表只有内核 `flow/phases.json` 一份,七段:启动 / 澄清需求 / 定规格 /
  写设计 / 写代码 / 检视与验证 / 已合入。用户拍板**环节不减**,只把原「交付」
  改叫「检视与验证」、末尾加终态「已合入」;前台尽量不感知内核能力扩展。
- 前端只吃任务 API 的 `progress`;`workspaceProgress` 的三套字面量、
  `TaskProgress` 里追加"完成"和"交付→验证与交付"的改写都已删除。
  `tests/progressVocabulary.test.ts` 静态断言 `TaskWorkspace.tsx` /
  `TaskCard.tsx` / `taskService.ts` 里不出现任何阶段名——你改这几个文件时
  别再写阶段字面量,需要占位找服务端 `placeholderProgress`。
- 你 `4081e72` 的下单页改动已和我的三处修法(多仓隐藏"大需求"开关、名单
  读不到清空邀请、重跑沿用参与人)合在 `84f132a`,全量绿。
