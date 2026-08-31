# 架构重构分析报告(2026-08-30)

> 起因:用户判断"可扩展性太差,bug 太多",要一份完整、可执行、考虑
> 扩展性的重构分析。方法:两路只读深探(taskService 逐方法解剖 +
> 近 145 个 fix 提交根因考古 + 全仓依赖测绘),证据均带 file:line 或
> commit hash。本文只给有实锤的诊断和分批可停的执行计划,不做
> big-bang 方案。

## 一、诊断:数据说话

### 1. 病灶集中在一个文件

- `src/taskService.ts`:**约 13,500 行、类内 237 个方法、24 个关注点
  混居**(容器/队列/投影/知识/检视/创建/持久化/恢复/回收/prepush/
  跨仓/决定卡/开发助手/生命周期/会话收口/交付环/停滞取证/修复派单/
  月光/通知/HostGit……)。
- 近 10 天 310 个提交里 **110 个**改它——全仓最热改动点=最大单体,
  两个 AI 并行开发时同文件竞写冲突高发(实际发生过多次)。
- Top-10 巨型方法(`launch` 729 行、`create` 535、`runCloudPrePushAgent`
  386、`dispatchCiRepair` 316、`tryDeliver` 269……)合计约 3100 行,
  占全文件 23%。
- 对照:仓里其余模块普遍健康——`server.ts` 是纯路由表、`serve.ts`
  是唯一组装点、`containerRuntime`(1226 行)零依赖纯叶子、
  `prePushVerification` 是零 import 纯 reducer。**病不是弥漫性的,
  是一个器官肥大。**

### 2. bug 不是均匀长的:145 个 fix 提交的根因分布

| 根因模式 | 件数 | 代表 |
|---|---|---|
| ① 同一事实两份副本走散 | **30** | 15cdba3(服务端改了前端旧闸还拦)、9d15a44(词表双源)、0df44bd(投影 vs 现场) |
| ② 纯呈现/布局 | 25 | 4eb51b1、f2c252b |
| ③ 接线未测(纯函数绿≠生产通) | **22** | 72f9dbe(演示桩接在生产兜底位)、62c2946(ccache launcher 没注入)、a834d43(问题容器漏传 user) |
| ④ 单人假设撞多人现实 | 13 | 01721ee(邀请链接 127.0.0.1)、c16c76f(撞单) |
| ⑤ 适配层契约与云端错位 | 12 | e653012、1609311 |
| ⑥ 字符串状态匹配失误 | 11 | 4e541da(命令原文精确相等)、d45d7ca 系列前缀 bug |
| ⑦ 台账/幂等缺失 | 10 | 2cba307(检视复读)、ab61c84(台账裁字段) |
| ⑧ 主线程阻塞/进程自伤 | 9 | a2b5702(同步 git 堵 40 分钟)、86e756b(兜底自己成死因) |
| ⑨ 重启×在途 | 7 | 5f2c6d8、d45d7ca、815bf1a |
| ⑩ 前端状态推断 | 6 | 0754d42、b27e95d |

**三大 bug 工厂**(合计约占逻辑 bug 的 2/3),每个都能对应到一个
结构性缺陷:

- **工厂 A:多副本**(①+⑥+⑩ ≈ 47 件)。同一事实存在于服务端类型/
  前端手抄类型/字符串状态/UI 文案多个地方。铁证:`web/src/api.ts`
  3407 行、121 个手工镜像类型、**零 import**;唯一的契约对账测试只
  覆盖问题流六个类型,`TaskSummary`(前端 120 字段 vs 服务端 97)
  零对账;`ExecutionPlan` 已实际走散(服务端补了 `source:"platform"`
  前端没有,`stage_layers` 整块缺席);`SemanticEvent.kind` 被前端
  放宽成 `string`,服务端加事件种类前端永远不会编译报错。
- **工厂 B:上帝对象里关注点互踩**(⑦+⑨ 的大半)。`summary.status`
  被 60+ 处、跨十几个关注点组写入,**没有单一 owner**;
  `delivery.loop` 被交付环/派单/批注/恢复四组读写,"发批注"的方法
  直接推进交付状态机(taskService.ts:3449);修复环的
  `{round,max,state}` 初始化模板在**五处**重复——reducer 缺席的
  典型症状。
- **工厂 C:接线未测**(③ 22 件)。依赖全部藏在 `this.options.*` 和
  内联 fetch 里,链路无法在测试中替换验证,于是"单测全绿、生产断线"
  反复发生(演示桩、漏传参数、二进制没 +x)。

### 3. 字符串状态机:已定位的全部 8 处脆弱判定

全部集中在 `delivery.pipeline` 与 `delivery.mr_state`——**唯二没有
联合类型约束(裸 string)的状态字段**:

| 位置 | 判定 |
|---|---|
| taskService.ts:5000 | `pipeline?.startsWith("running")` |
| taskService.ts:10697 | `pipeline?.startsWith("running(")`(与上一条判据不一致!) |
| taskService.ts:10529/10537 | `startsWith("failed")` / `startsWith("running")` |
| taskService.ts:10976 | `!startsWith("failed")` |
| taskService.ts:5406 | `includes("轮询预算耗尽")`——**拿中文文案当状态** |
| taskService.ts:3564 | `mr_state.startsWith("已合入")` |
| taskService.ts:8336 | `detail?.startsWith("前置任务")`——**拿 UI 文案当阻塞判据** |

对照组:`prepush.state`/`loop.state`/`summary.status` 都有联合类型,
全部是全等判定,这三年零前缀 bug。**结论:类型约束到哪,这类 bug 就
消失到哪。**

### 4. issueFlow 与需求流的五处"复制而非复用"(已产出两起生产事故)

1. 容器构造手抄(issueFlow/service.ts:955 vs taskService 私有
   `createTaskContainer`)→ 直接导致 a834d43(漏 user)与 d45d7ca
   (漏 ownership 标签)两起事故;
2. 流水线调用两份实现(pipelineClient 自述"需求侧旧内联 fetch 本期
   不迁移");
3. 时间线两份(sessionView vs timeline);
4. diff 快照手拼(materials.ts:126,没继承"同步 diff 堵 20 秒"教训);
5. 人工台账两套。

## 二、宪法:重构不许动的东西

1. **内核唯一权威**——不因搬代码把任何判定逻辑复刻进新模块;
2. **文件即真相**——task.json/.mae-flow.json/waiting.json 的格式与
   语义不变(允许新增字段,读侧兼容旧档);
3. **fail-open 旁路 / fail-closed 门禁纪律**——57 处 `bypass` 调用
   就是已声明的可失败边界地图,搬家时边界跟着走;
4. **零构建**——tsx 直跑,不引 build 步、不引 DI/事件框架,模块化
   靠 import 和构造参数,不靠容器;
5. **前端零外部依赖、文案镜像任务 API**;
6. **测试即契约**——156 个测试文件/约 860 条用例是安全网;每一批
   重构的定义都是"行为零变化、全量绿"。

## 三、目标形态

```
入口层    serve.ts(组装,已干净)   server.ts(路由,已干净)
              │                          │
核心层    TaskService(退化为:任务注册表 + 组合根 + 门面转发,目标 ≤3000 行)
              │ 持有:tasks map / queue / persist / epoch 发放
              ├── deliveryEngine     交付环(push/MR/轮询/裁决/停滞取证/修复派单)
              ├── prepushOrchestrator Build-Fix 编排(状态机已是 reducer,搬编排)
              ├── decisionFlow       决定/确认卡/月光(humanGate 已独立)
              ├── chainOrchestrator  跨仓拆单
              ├── assistantFlow      开发助手(自带 assistantEpoch)
              └── recoveryPlan       恢复(按引擎分派 recover 钩子)
部件层    (已有)humanGate/annotations/reviews/notifier/containerRuntime/
          prePushVerification/projection/workflowAssetLibrary/pipelineClient
          (搬入)hostGit/taskProjection(读侧)/workspaceReclaim 调度/warmup
类型层    单源:web 直接 import type 服务端类型;状态字段全部联合类型
```

**引擎的统一形态**(照 `prePushVerification` 的成功样子推广):
`reducer(state, event) → state` 负责一切状态转移(联合类型、幂等、
可重放);`effects(ports)` 负责 IO,ports 是显式注入的窄接口
(platform fetch、git、kernel dispatch、notifier、ledger、persist、
clock、`isCurrent(task, epoch)` 谓词)。**ports 让"接线"本身变成可
测对象**——工厂 C 的根治手段。

## 四、分批执行计划

规则:每批独立可交付、可单独 revert;验收=typecheck 双配置绿 +
全量测试绿 + 该批点名的回归用例;批间可以停下来修线上 bug;
与并行开发者按批认领文件,不同批不碰同一文件。

### Batch 0 · 立规矩(半天,立即可做)
- 纪律成文:**新功能代码一律进新模块,不再往 taskService 添方法**
  (门面转发一行除外);
- 加一条"行数棘轮"测试:断言 `taskService.ts` 行数 ≤ 当前值,每批
  结束下调上限——只减不增有机器看着;
- 契约测试扩容第一步:把 `TaskSummary`/`SemanticEvent`/
  `ExecutionPlan` 三个高危类型纳入前后端逐字段对账(已走散的
  `ExecutionPlan` 顺手修正)。
- 验收:全量绿;走散字段清单归零。

### Batch 1 · 叶子搬家(1 天,零行为变化)
搬"易"评级组,每组本就单向依赖:
- C 读侧投影(19 方法,纯读)→ `taskProjection.ts`;
- X Host Git 操作(9 方法)→ `hostGit.ts`;
- L 工作区/缓存回收 → 并入 `workspaceReclaim.ts`;
- F 设置/能力探测、G 环境预热、W 通知文案模板 → 各自小模块;
- E 检视请求(已是 ReviewStore 薄壳)删壳直连。
- 预期:taskService −2500~3000 行;验收:全量绿+棘轮下调。

### Batch 2 · 字符串状态机治理(1 天,最高杠杆)
- `delivery.pipeline: string` → `{ state: "running"|"success"|"failed";
  note?: string }`;`mr_state` → 联合类型 + `note`;
- 8 处前缀/includes 判定全部改结构判定;pump 的 `detail` 判据
  (taskService.ts:8336)改结构字段 `blocked_by_dependency`;
- 兼容:读旧 task.json 时把带注记字符串解析成结构(一次性迁移
  函数+测试);投影层输出人话(前端 `pipelineLabel` 已就位);
- 回归:8-29/8-30 新增的重启续轮、检视复读用例全部改锚结构字段。
- 这一批直接注销工厂 A 的字符串半边和 6 处已知脆弱点。

### Batch 3 · loop 状态机 reducer 化(1 天)
- 仿 `prePushVerification` 写 `repairLoop.ts` 纯 reducer:五处重复
  初始化模板收敛为 `startCycle` 事件;批注组越界写 loop
  (taskService.ts:3442-3450、3590-3602)改为发事件;
- `replied_ids`/`review_ids` 台账语义进 reducer(8-30 的跨批继承
  修复成为 reducer 的测试用例);
- 验收:mrLoop/delivery 全套绿。

### Batch 4 · deliveryEngine 抽取(2-3 天,最大的一批)
- S 交付环 + T 停滞取证 + U 修复派单(约 34 个方法)整体迁入
  `deliveryEngine.ts`,ports 注入(platform/git/kernel/notifier/
  ledger/persist/isCurrent);
- `summary.status` 的交付段写权收进引擎(向"单一 owner"迈第一步);
- taskService 保留门面转发;`bypass` 边界原样带走。
- 回归重点:进程可死轮询不死、同 SHA 不重触发、检视台账、恢复矩阵。

### Batch 5 · prepush 编排 + 恢复分派(2 天)
- M 组编排(runCloudPrePushAgent 等)→ `prepushOrchestrator.ts`
  (编译槽账本一起走);
- `recover:4835`(237 行横切面最宽)拆成"注册表恢复 + 逐引擎
  recover 钩子",每个引擎自己声明"我这段状态怎么接手"——重启×在途
  这类 bug 从此有明确责任人。

### Batch 6 · decisionFlow + create 拆解(2 天)
- O 决定/确认卡 + V 月光 → `decisionFlow.ts`(activeDecisions 锁、
  digest 幂等、humanGate 编排同迁);
- `create:4209`(535 行)拆成校验→知识固定→装配三段流水线,
  I/D 两组解耦。

### Batch 7 · 类型单源(1 天)
- `web/src/api.ts` 的类型半边改为
  `import type { … } from "../../src/…"`(vite 纯类型导入无运行时
  代价;契约 tsc 已有 DOM 隔离先例),函数半边留在 api.ts;
- 手抄镜像只保留确需前端特化的少数视图类型;契约测试转为守护
  "特化类型 ⊆ 服务端类型"。
- 工厂 A 的另一半就此注销。

### Batch 8 · issueFlow 复制收敛(1 天)
- 容器构造:公开 `createOwnedTaskContainer` 工厂(ownership 标签/
  user/挂载一处生成),两流共用;
- taskService 旧内联流水线 fetch 迁到 `pipelineClient`;
- materials 的 diff 手拼换用 artifacts 的异步切分(顺带消掉
  "同步 diff 堵主线程"隐患)。

**合计约 10-12 个工作日的批次量,可穿插在日常修复之间,任何一批
之后停下来都是净改善。**

## 五、排期建议与风险

- **铺开第一周(本周)只做 Batch 0-1**:立规矩+零行为搬家,风险
  趋近于零;Batch 2 起第二周开始——状态机改造虽有兼容层,仍不该
  和"第一周现场问题"叠在一起。
- **与并行开发者(codex)的协调**:按批认领文件;当前它在批注回执
  车道(annotations/taskService H 组),因此 H 组相关的 Batch 3
  批注越界收口排在它合入之后。
- **明确不做**:不重写、不引框架、不改三个真相文件格式、不动内核
  边界、不为"优雅"而合并 issueFlow 与需求流(它们平级隔离是刻意
  设计,只收敛五处复制)。
- **度量**:每批结束记录 taskService 行数曲线;每周 fix 提交按十类
  根因归档一次——工厂 A/B/C 的件数下降才是重构生效的证据,行数
  只是代理指标。

## 六、预期收益(对着三大工厂说)

| 工厂 | 治理手段 | 批次 |
|---|---|---|
| A 多副本走散(47 件) | 类型单源 + 状态结构化 + 契约对账扩容 | 0/2/7 |
| B 关注点互踩(20+ 件) | 引擎拆分 + status/loop 单一 owner + reducer | 3/4/5/6 |
| C 接线未测(22 件) | ports 显式注入,链路本身可测 | 4/5/8 |
| 同文件竞写冲突 | 24 组→十几个文件,冲突面自然缩小 | 全部 |
