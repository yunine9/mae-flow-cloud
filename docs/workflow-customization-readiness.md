# 工作流定制端到端就绪度报告(2026-08-30 三路审计)

> 审计面:云端服务链路(server/taskService/编译/投影)、内核机制
> (kernel 分支 7c59b71)、前端体验(workflows/** + 弹层)。
> 方法:三个独立审计各自给 file:line 证据,本文只收有实锤的条目。

## 总评

**主链已真实接通,可以内部试点;上生产前必须清掉 5 个 P0。**
资产库(CRUD/生命周期/权限/乐观锁)→ 下单选方案(定版、归档拦截)→
创建时编译定格(final_snapshot + 资产正文快照)→ 每会话投影
`.mae-flow-work/workflow-profile.json` → 内核 execution-plan 消费 →
任务镜像下发前端——每一环都有 route/调用/测试,不是类型空壳。
纪律执行到位:定格后资产升级/改名对既有任务零影响;编译失败显式
warning 降级不假绿;三层 fail-open 保证 Agent 不卡死。

## P0(上生产前必须清)

1. **静默丢定制链(最重)**。`workflow-profile.json` 损坏时内核
   fail-open 回退平台默认,但警告只进 Agent stdout/CLI stderr;
   cloud `readCurrentExecutionPlan` 用 `stdio:["ignore","pipe","ignore"]`
   把 stderr 丢了,而 UI 展示的 workflow_profile 是**创建时的服务端
   副本**——用户看着"本任务定格方案",Agent 实际按平台默认在跑,
   无人被通知。呈现与实际不一致,正撞用户红线。
   **措施**:cloud 捕获 execution-plan 的 diagnostics/stderr 上浮为
   任务级 warning;活方案与创建副本对拍不一致时界面显式标红。
   (内核侧警告文案本身设计良好,直接复用,只修传播断链。)
2. **门禁漏保 `workflow-profile.json`**。guard/gate.py:73 与 cli
   gate.py:257 的只读保护正则只盖 v1 `execution-profile.json`;
   v2 定格方案文件 Agent 可改写(revision 是确定性 sha256 可重算,
   改完自洽),只剩 0o440 文件模式挡人。"任务只执行这一份"失去
   机器保证。**措施**:两处正则补 `workflow-profile\.json` + 篡改
   被拒的门禁测试(kernel 分支,一行改动量级)。
3. **阶段词表错位**。`archive/archive_confirm` 两步:panel PHASES
   归"定规格",playbooks.json 归"交付"——这期间进度条点"定规格"
   匹配不到活方案、点"交付"反而弹出,阶段错位必然发生。另:cloud
   通用 fallback 词表(已受理/需求理解/…)与 DTS 词表和内核六阶段
   完全不同,这两类任务的弹层永远落入底版/空目录兜底,是误导。
   **措施**:panel PHASES 对齐 playbooks("交付")+ 两词表一致性
   测试;StagePlanDialog 对非内核词表阶段直接不提供弹层(明示
   "该视图无对应内核阶段")。
4. **内核分支未合 main,快照来源脆弱**。cloud kernel/ 收编自
   `cloud/workflow-customization`;任何人从 kernel main 重新
   sync-kernel,workflow 模块整体消失,execution-plan 命令缺失→
   fail-open 静默退化,无人察觉。**措施**:分支尽快过审合 main;
   在此之前 preflight 校验 VENDORED 分支名与预期一致。
5. **前端"最终方案/依赖资产"两视图跑在本地预览上**。
   WorkflowAssetWorkspace 调编辑器从不传 profile,FinalPlanView
   永远走客户端 previewStages,diagnostics 恒空——"最终方案"实为
   本地预览冒充编译产物,与"呈现必须与实际一致"拍板抵触。
   **措施**:容器把已编译 profile 传入两视图;拿不到时明示
   "预览,非编译产物"。

## P1(尽快)

6. `cmd_execution_plan` 不捕获 ValueError → CLI 崩溃退非 0,cloud
   只见 plan=undefined,原因不可见(与 P0-1 同一盲区)。措施:
   捕获后输出带 diagnostics 的退化 JSON + CLI 退出码测试。
7. `structural_selection` 要求 stage.id 精确等于 playbook.id,失配
   直接 raise——cloud 编译器写 id、内核消费,跨仓硬耦合零测试。
   措施:失配降级为带 diagnostics 的 fallback + 失配用例。
8. 双 profile 并存(v1 execution-profile 有界偏好 + v2
   workflow-profile 结构化)命名相近、内核同时合并,认知成本高。
   措施:文档钉死分工与 v1 退役计划。
9. 方案选择器→"复制后编辑"无直达:onOpenEditor 的 id 被丢弃,
   只跳资产库首页,用户要自己找到再点复制。措施:携 id 定位并
   预发起复制。
10. 编辑冲突(revision_conflict)后本地未保存编辑无暂存/导出,
    重合并全靠人脑。措施:冲突时把本地 edits 暂存 localStorage
    或提供"导出我的改动"。
11. 内核内"步骤→阶段"映射有两份(panel PHASES 与 playbook.phase),
    与"映射不许有第二份"的红线精神相悖(词表错位正是因此漏进
    主干)。措施:内核内收敛单一来源,另一份生成。
12. 测试缺口四条:stage.id 失配路、CLI 崩溃路、词表一致性、
    workflow-profile 写保护(随 P0-2 补)。

## P2(排期)

13. set-default(设默认方案)从未实现——下单是显式选方案,无默认
    位;先确认要不要,要则 library+route 一起补。
14. 列表页不展示适用范围(Summary 不含 applicability);详情才有。
15. prepush/预热/修复前置会话不消费定制(零引用)。若属预期,
    README「已知边界」明记一句。
16. strategy.source 的 "platform" 值 cloud 类型联合未列(运行时
    透传不炸,类型失真)。
17. 呈现小噪声:编辑器五操作图例常驻(与按钮自带符号重复)、
    "3 个限定条件"式无信息量摘要、锁定项纪律文案逐项整段重渲。

## 与现有内核的摩擦盘点(专项回答)

- **"内核唯一权威"未破**:定制 instructions 是建议层,render 自带
  边界声明;locked floor 由内核独立复验;TS 侧无判定复刻。
- **moonlight/无人值守无摩擦**:执行方案文本照常注入,仅跳过
  approval_subject 绑定。
- **真摩擦三处**:门禁保护不对称(P0-2)、阶段词表双源错位
  (P0-3/P1-11)、投影故障传播断链(P0-1)。
- **修复/prepush 会话看不到定制**(P2-15):当前实现如此,需要
  拍板"是边界还是缺口"。

## 建议执行顺序

第一批(小改高收益,可立即做):P0-2(内核正则+测试)、
P0-3 词表对齐+测试、P0-5 前端传 profile、P1-6 CLI 不崩。
第二批:P0-1 诊断上浮与对拍标红(cloud 中等改动)、P1-7/9/10。
流程动作(需拍板):P0-4 内核分支合 main;P2-13 set-default 要不要;
P2-15 prepush 不见定制是否属预期。

## 修复落地(2026-08-29 全体修复轮,用户拍板"直接开工")

**内核侧(mae-flow main = 2ec675e,分支已合主干并推送)**:
- P0-2 ✅ guard/gate.py 与 cli gate.py 只读名单补 `workflow-profile.json`;
  Bash 侧正则提为 `INTERNAL_STATE_PATTERN` 常量,测试按同一份断言。
- P0-3 ✅ panel PHASES 的 archive/archive_confirm 归位"交付";新增
  playbook.phase↔phase_of 全量一致性断言,词表再分裂直接红。
- P1-7 ✅ structural_selection 的 stage.id 失配从 raise 改为退平台默认
  + `profile_invalid` diagnostics 留痕;mode/effective_source/strategy.source
  按退化后如实计算。
- P1-6 ✅ cmd_execution_plan 加 ValueError 兜底:丢定制重组平台默认、
  stderr 说人话、diagnostics 留痕;flow/catalog 真坏才照常抛。
- P1-12 ✅ 四条测试缺口全补(词表一致性/门禁双侧/失配降级/CLI 不崩),
  全量 4+13 与主干环境基线一致。
- P0-4 ✅ cloud/workflow-customization 快进合入 main 并推送;cloud
  kernel/ 重新收编,VENDORED 记 `分支: main`。

**云侧(本轮提交)**:
- P0-1 ✅ readCurrentExecutionPlanReading 捕获内核 stderr ⚠ 行;
  project() 汇总 stderr 告警 + profile_invalid 诊断 + "定了格但活方案
  effective_source ≠ compiled_final_plan"失配为任务级
  `execution_plan_alerts`;执行现场页签顶部红色 role=alert 呈现。
- P0-5 ✅ 按"编译是任务时事实"的结论修正为诚实标注:库级两视图明示
  "本地预览,非编译产物"(标签、横幅、依赖状态口径);任务侧真编译
  产物本就走 WorkflowProfileCard/StagePlanDialog。库级伪造编译(空
  任务上下文解析)会产出假 unavailable,比预览更失真,不做。
- P0-3(云半) ✅ 云端词表任务(需求受理/DTS)不再提供阶段弹层;
  目录为空时明说"该阶段没有对应的内核执行方案"。
- P1-9 ✅ 选择器"查看方案"带 id 直达资产详情(App workflowFocusId →
  WorkflowAssetWorkspace initialWorkflowId)。
- P1-10 ✅ revision_conflict 时本地编辑暂存 localStorage,重进编辑器
  横幅一键"恢复我的改动/丢弃暂存";保存成功自动清理。
- P2-14 ✅ 资产记录存 applicability 快照(创建/存草稿同步),列表页
  直答"适用于哪";旧资产缺席如实标"未声明"。
- P2-16 ✅ strategy.source 联合补 "platform"。
- P2-17 ✅ 三处噪声:操作图例撤除、"N 个限定条件"改说内容、锁定项
  纪律文案收成一行+悬停解释。
- P1-8/P2-15 ✅ README「已知边界」钉死双 profile 分工与"prepush/预热
  不消费定制"现状;v1 退役与 prepush 是否补齐待拍板。

**明确不做(未拍板)**:P2-13 set-default;P1-11 单一来源化重构
(已用一致性测试钉死,重构留内核侧专项)。
