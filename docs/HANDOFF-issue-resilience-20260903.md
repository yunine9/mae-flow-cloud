# 问题单韧性七件套——实施上下文交接（2026-09-03）

> 本文是 spec yunine9/mae-flow-cloud#79 的实施上下文沉淀，目的：实现者（人或子 agent）
> **零对话上下文**也能安全开工。七项口径全部经过用户逐条拍板，本文记录口径、理由、
> 已核实的事实、代码锚点、红线与并行边界。开工前必读：spec #79 + 本文 + 所接工单正文。

## 一、来源与决策过程

2026-09-03 会话中，用户要求对比需求流（TaskService）与问题流（IssueFlowService）的能力差距。
两个只读探查代理产出能力清单后，汇总出七项差距，用户逐条拍板（详见 spec #79）。
关键转折：分析初期我曾误判"问题流容器可能没有编译工具链"，后经查证**两流容器镜像同源**
（同一 `--isolate-image`，问题流 build_deploy 已在容器内跑 mvn，构建缓存挂载 2026-09-01 已对齐），
该风险撤回。**教训：写风险结论前先查代码，探查报告的结论也要定点核实。**

## 二、已核实的事实（不要重新调查）

### 容器与工具链
- 两流容器镜像同源：serve.ts 同一份 `--isolate-image` 传给 taskService 与 issueFlow
  （serve.ts ~842-848）。问题流 build_deploy 在容器内跑 mvn；cacheRoot 与需求流同一份
  （2026-09-01 对齐，注释在 serve.ts isolate 配置处）。→ 提示词口径"推送前跑全量 UT"技术上可行。

### 公共件现状（2026-09-03 刚升级过，PR #74 已合 main）
- 盲输入判据：`pipelineMirror.isBlindPipelineInput`（src/pipelineMirror.ts）。语义：失败摘要抠掉
  链接后剩余 <120 字且变短 = 盲；有镜像产物不算盲；占位符算盲。**当前全仓唯一消费方是
  taskService**（dispatchCiRepair 内）——问题流接入是本批工单 T1a。
- 证据评估：`pipelineEvidence.assessPipelineRepairEvidence`（src/pipelineEvidence.ts）。
  已具备：前端 runner（Jest/Mocha/Vitest）UT 特征、build_log 内容嗅探为主+record-id 归类为弱提示
  （映射仅在嗅探非空时并入）、path:line 逐行归维（测试文件→UT）、跨维度兜底（带"归类错配"标注，
  出口 `fallbackSources`）、指标型缺陷信号（仅 codecheck_detail 的 indicatorName 字段）。
  两流共用；**本批不改动它**。
- 需求流先例（移植参照，均带测试）：
  - 停机通知 `notifyRepairStopped`（taskService.ts ~17462，halted/exhausted 分形态、幂等键含 loop.state）
  - 证据缺口重试窗：evidence_gap 状态机 retrying→waiting_human（taskService.ts ~14636-14676）、
    定时重采 `scheduleRepairEvidenceRetry`（~14470-14491，间隔默认 3 分钟，预算默认 30 分钟）
  - 同 SHA 刹车：`loop.last_sha === sha` → halted，会话最后发言存 diagnosis（~14595-14613）
  - 上轮失败对比段：`loop.failure` 留档，下轮使命拼入"同一处打转必须换思路"（~14836-14840）
  - 工作区回收 `reclaimIdleWorkspaces`（~7253-7300）：终态+保留期清重货留台账，fail-open；
    保留期旋钮分层：管理页设置 > 部署值 > DEFAULT_WORKSPACE_RETENTION_DAYS=14
    （`workspaceRetentionDays()` ~7159-7166）；serve 每日清扫 `sweepStorage`（serve.ts ~989-1019）

### 问题流现状锚点（src/issueFlow/service.ts）
- 红灯结算 `settlePipeline`（~2942-3175），开头即 `watch.watching = false`（~2952）。
  内部顺序：不可修分诊（~3040-3078，举 pipeline_unfixable 闸）→ 证据评估（~3082）→
  证据全缺举 pipeline_evidence 卡（~3092-3125）→ 修复轮预算（~3127-3145，reds+1、超限停机**不发通知**）→
  分级回合文案+派修（~3146-3174，`startPlatformTurn`）。
- 监看循环 `watchPipeline`（~2880-2940）：trigger→轮询→终态即结算；轮询预算耗尽停表
  （~2931-2939）只写 stage_note，**不发通知**。
- 人工回灌闸裁决 `resolveGate`：pipeline_evidence 的 supply 码（自由文本回灌，该轮才耗预算）。
- 通知器：仅 `notifyWaitingCard`（举卡时）与月光代答后的 `notifyOutcome`（~1605、~1671）在用。
  outcome 通道带幂等键，是 T1a 要复用的通道。
- 重启恢复 `start()/recover`（~631-685）：running→queued、waiting/suspended/终态不动、
  watching 仓逐仓重挂且 deadline 原样（不白送预算）。**重试窗的落盘字段要挂进这套续算。**
- 技能扫描：skill_select 入口闸只扫 `.cac/skills`（~1430-1491）；圈选写台账（~2485-2513）。
  需求流扫四根目录（`REPOSITORY_SKILL_ROOTS`，src/repositorySkills.ts ~22：.agents/.pi/.claude/.cac skills）。
- 多仓：`state.repo_urls`（上限 8）、pushes/mrs/pipelines 均按仓记账；监看账是 Record<repo>。
- state.ts：`IssuePipelineWatch`（sha/status/watching/started_at/deadline/round/reds/last_error）、
  `IssueGate.kind` 含 pipeline_unfixable/pipeline_evidence（带 pipeline:{repo,sha}）、
  `state.ut`（IssueUtRecord：passed/summary/log_path/round/at，report_ut 写入，tools.ts ~901-937）。

### 测试基建（tests/）
- `tests/issueFlowFixed.test.ts`：LoopPlatform（`firstFailure`{log,checks}、`firstFailureArtifacts`
  产物剧本）、seedMrGreenWatch（预置 mr_green 监看）、ScriptedModelServer、FakeLubanServer
  （messages 断言通知）。既有红灯用例：不可修分诊举卡、证据分级点名、证据全缺举卡（~2234）、
  UT+Jest 派修、issue-28 形态兜底派修、名单未配置照修。
- 契约测试模式：issueUiContracts 源码正则（钉前端/文案用）。
- 测试命令纪律：`npx tsx --test --test-timeout=60000（重承载 120000） --test-force-exit tests/<file>`；
  收尾全量 `npm test` + `npm run typecheck`（web 侧另 `cd web && npx tsc -b`）。

## 三、七项决策账本（口径 = 用户拍板，勿重开讨论）

| # | 口径 | 拍板要点 | 明确拒绝的替代项 |
|---|------|----------|------------------|
| 1 | 放弃时通知 | 仅预算烧完/轮询超时/同提交刹车三个放弃点；幂等键防重发；开始修/修复过程不通知 | 每轮修复都通知（太吵） |
| 2 | 盲输入闸 | 消费公共判据；只拦 checks 缺席+链接抠掉后内容不足+零产物；拦下后并入证据缺口处置 | 提示词约束（模型在"必须修"压力下劝不住） |
| 3 | 证据重试窗 | 全缺/盲输入先进重试窗（缺省 15 分钟，旋钮可配，**0=关**回到立即举卡），到点才举卡；不耗预算；落盘续算 | 立即举卡（假卡，现状）|
| 4 | 同提交刹车 | 红灯 SHA==上次派修 SHA→停机+会话最后发言作诊断+通知，不耗预算；派修回合带上轮报错段+换思路纪律；机制是代码、纪律是提示词 | 只靠预算兜底（现状） |
| 5 | 推送前 UT | **仅提示词强烈建议**全量 UT 全绿再推；不加台账闸、不上 prepush | 台账闸、容器专项验证（prepush 接入）——均已评估后放弃 |
| 6 | 工作区回收 | 保守四保险：只清终态+保留期后+清重货留台账+容器在跑跳过；保留期复用管理页既有旋钮 | 激进清理、新增独立旋钮 |
| 7 | 技能目录 | 问题流扩为 `.cac/skills`+`.agents/skills` 两个；`.cac` 优先，同名跳过留告警；需求流四目录不动 | pi/.claude 目录；需求流侧改造 |

## 四、红线与坑（实施必读，违者打回）

1. **盲输入闸的触发面必须收窄**：仅"平台没给 checks（failedDimensions 为空）&& 摘要抠链接后
   内容不足 && 零镜像产物"。三种"能修"情形零影响：产物在场（哪怕摘要只是链接）、摘要有真实内容
   （如 BUILD FAILURE: 模块 x 编译失败）、checks 有结构化明细。既有"证据全缺举卡"测试的假件产物名
   是 `build.log`（不带 `build_log_` 前缀）——不要动它的语义。
2. **重试窗三不**：不消耗 reds（只在真派回合时计数，现纪律）；不重复通知（举卡只发一次）；
   不白等（deadline 落盘，重启续算）。每轮重评前必须查会话状态：取消/终态/已举卡即收手。
3. **同提交刹车不耗预算**：刹车停机不改 reds；按仓独立记账；诊断取会话最后一次发言，
   写进留痕与通知——这是用户点名要的（"把 AI 的诊断交给我"）。
4. **通知幂等**：幂等键含会话 id+原因+提交；同因不重发。通知文案要含问题标题/单号、原因、
   轮次（x/max）、建议动作。
5. **UT 提示词是纯文案**：不动任何工具行为；用源码契约测试钉文案在场。别顺手加台账检查——
   用户明确拒绝了。
6. **回收的保守性是拍板核心**：终态（归档/取消/失败）之外一概不碰；重货白名单
   （repo/、ref/、pipeline/、现场目录），台账显式保留（issue.json、feedback/、events——
   **查看模式与复盘依赖它们**）；保留期复用既有旋钮（两流同口径，缺省 14 天，0=永不）；
   fail-open；挂 serve 既有每日清扫，不新起定时器。
7. **技能同名必须留痕**：`.cac` 优先是拍板（存量团队行为不变），`.agents` 同名跳过要写进
   圈选台账告警，不静默。需求流文件一行不动。
8. **需求流零变更是本批总红线**：全部改动限于 src/issueFlow/*、src/prompt 相关、serve 接线、
   新回收模块；taskService/repositorySkills 等只读参照，不修改。
9. **历史教训**：迁移垫片不留（CLAUDE.md 红线）；pkill 模式串用字符类防自杀
   （`serve[.]ts`）；并行子 agent 只在文件面互不相交时才并行（见下节）。

## 五、子 agent 并行边界（文件所有权）

| 工单 | 拥有文件 | 阻塞 |
|------|----------|------|
| T1a 停机通知+盲输入闸 | src/issueFlow/service.ts（settlePipeline/notify 区域） | 无 |
| T1b 重试窗+刹车 | src/issueFlow/service.ts（同区域）+ src/issueFlow/state.ts | T1a |
| T2 UT 提示词 | src/issueFlow/prompt.ts + src/issueFlow/tools.ts（仅文案） | 无 |
| T3 工作区回收 | 新模块 + src/serve.ts（清扫接线） | 无 |
| T4 技能目录扩展 | src/issueFlow/service.ts（skill_select 区域） | T1b |

并行面：T1a ∥ T2 ∥ T3 可同时开工（文件面互不相交）；T1b 串行在 T1a 后；
T4 串行在 T1b 后（同文件防冲突）。每张票实现完各自跑单文件测试，全部完成后
主线程统一跑全量 `npm test` + typecheck 再分票提交。

## 六、验收与提交纪律

- 每票：单文件测试绿 → typecheck 绿 → 分票提交（commit message 带工单号）。
- 全部完成后：全量 npm test 0 fail → code-review（两轴：规范/对 spec）→ 修 findings → pr（按
  CONTEXT.md「pr」词条：建 PR 即合入 main）→ 工单关账、spec #79 收口。
- 回归红线：issueFlowFixed 既有红灯系列（分诊/分级/全缺举卡/issue-28/UT jest）零回退。
