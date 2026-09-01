# Cloud 持续检视闭环设计

> 状态：CC 已检视通过，用户已拍板；批 1—6 已实现并进入最终验收
> （2026-09-01，拍板与修订见 §15，落地记录与勘误见 §16）。
>
> 核心原则：MR 创建只是一次普通交付动作。任务创建后只初始化一次；从开始产出代码到 MR 合入，Cloud 与内核始终维护同一个任务、代码现场、分支和 MR，并持续接收、修复、核验来自各处的检视意见。只有 MR 合入或用户主动停止，任务才真正结束。

## 1. 为什么必须改

当前 Cloud 已经能在 `await_merge` 持续监听 MR、流水线和门禁，但内核仍沿用本地插件的一次性交付模型：

```text
实现 → push → external_verify → end
```

这造成两个彼此矛盾的事实：

- Cloud 认为 MR 未合入，任务仍然活着；
- 内核认为本轮已经 `end`，Hook 和流程约束已经退出。

MR 创建后再收到意见时，Cloud 为了重新获得内核约束，只能执行一次 `init`，把原状态归档成 `.last`，重新生成从 `config_confirm` 开始的新流程。于是出现了已经确认的事故：

- 任务进度真实回到开头；
- 用户被重新询问配置和交付方式；
- 原任务被错误地表达成一张新单；
- 自动代答只能遮住部分卡片，不能修正错误生命周期；
- 测试夹具直接把第二轮状态改到 `build`，掩盖了真实的配置重问。

根因不是某个提示词，也不是 Agent 不听话，而是内核的结束边界落后于 Cloud 的产品边界。

### 1.1 当前代码里的完整因果链

这不是推测，现有实现可以逐段对上：

1. `kernel/flow/flow.json` 把 `push` 和 `external_verify` 的默认下一步都写成 `end`，而 `end` 是 terminal；
2. `kernel/scripts/mae_flow_core/cli_commands/pipeline_commands.py::_route_external_verification` 在 PASS 时明确执行 `external_verify → end`；
3. `src/taskService.ts::pipelineVerdict` 随后把 Cloud 任务设成 `await_merge` 并启动 `watchMerge`，所以同一时刻形成“Cloud 活动、内核终态”；
4. `src/taskService.ts::dispatchReviewRepair` 收到 MR 意见后把本轮标成 review repairing，`reviewRoundLane` 选择“处理评审意见”；
5. `src/taskService.ts` 启动修复会话时向 `KernelHost.bootstrapManaged` 传入 `rolloverTerminal: true`；
6. `src/kernelHost.ts::bootstrapManaged` 看到 terminal 后调用 `init`；内核 `standalone_commands.py` 会把旧状态归档为 `.mae-flow.json.last` 并从 `config_confirm` 建新单；
7. 给配置卡做自动代答，只能让部分用户暂时看不到重问，无法保住原内核状态、历史、证据和真实进度，因此不能作为根本修复。

这条链路必须从第 1、2 步改变终态定义，并在第 4、5 步改成正式的反馈命令；不能只在第 7 步继续补条件。

## 2. 产品边界

### 2.1 一次任务，持续协作

```text
首次配置与需求实现
        ↓
形成候选代码
        ↓
创建或更新 MR（普通动作）
        ↓
持续收集反馈 ───────────────────────────────┐
  - Cloud 工作台批注                         │
  - Build-Fix 发现的问题                     │
  - 权威流水线编译、UT、CodeCheck 告警       │
  - MR 检视意见                              │
  - 合并冲突和其他可修门禁                   │
  - 负责面越界裁决(打回=带文件面的反馈批次) │
  - push 前人工确认卡的返工(每轮 push 一环) │
        ↓                                    │
统一修复 → 新 HEAD → Build-Fix → push → 流水线 ┘
        ↓
MR 合入或用户主动停止
        ↓
真正结束
```

### 2.2 不变量

1. 一个 Cloud 任务只能执行一次 `init`。
2. MR 未合入前，不得因为任何反馈重新询问配置、交付方式或重新梳理原需求。
3. 任务号、仓库、基线、工作分支、MR、工作流快照、知识快照和责任人始终不变。
4. push、MR 创建、流水线变绿都不是任务终态。
5. 每个新 HEAD 的旧质量证据自动失效；同一 HEAD 的幂等重试可以复用已验证事实。
6. 同一任务同时最多只有一个可以写代码的执行者。新的人工反馈优先于正在运行的机器修复。
7. 每条反馈都必须有来源、对象、处理回执和核验方式，不能拿总体回复冒充逐条闭环。
8. 处理不了或语义确实模糊时，明确告诉用户卡在哪里；不猜、不糊弄、不无限空转。
9. 只有 MR 合入或用户主动停止，Cloud 任务和内核流程才一起进入真正终态。

## 3. 目标状态模型

### 3.1 内核新增 `delivery_watch`

Cloud 托管任务的流水线 PASS 不再从 `external_verify` 进入 `end`，而是进入非终态 `delivery_watch`：

```text
build
  → domain_archive
  → delivery_review
  → push
  → external_verify
  → delivery_watch
```

`delivery_watch` 的含义：当前 HEAD 已完成本轮交付验证，Cloud 正在持续监听 MR、检视、流水线和门禁；Agent 会话可以释放，但内核流程仍然活着。

本地 Mae-Flow 插件保持原语义：没有声明持续协作能力时，`external_verify/push` 仍可进入 `end`。这项变化只对 Cloud 执行契约生效。

### 3.2 正式的反馈回路

反馈回路不是“MR 创建后的尾巴”，而是首次配置完成、代码分支和任务上下文建立后，贯穿整个交付过程的一层长期能力。反馈可能在开发、交付检视、Build-Fix、流水线验证和等待合入中的任何时刻到达。

当内核处于宿主等待态时，Cloud 通过内核命令打开一轮反馈处理，内核保留既有配置并进入 `feedback_triage`，而不是 `init`：

```text
delivery_watch
  → feedback_triage
  → build
  → domain_archive
  → delivery_review
  → push
  → external_verify
  → delivery_watch
```

`external_verify` 收到流水线 RED、Build-Fix 失败或冲突时，也进入同一个 `feedback_triage`；不能先进入 `end` 再重新开单。

Agent 已在 `build` 或 `delivery_review` 写代码时，新反馈先持久化到当前任务：可以安全 steer 时追加给当前唯一 writer；不能安全 steer 时进入下一批。两种情况都不重置步骤，不重新询问配置，也不并发启动第二个修复 Agent。

若反馈只需要解释、不产生代码变化，则逐条回执成功后可以直接回到 `delivery_watch`，复用同一 HEAD 已有的质量结论，不重复触发流水线。

流水线 RED、Build-Fix 失败和冲突同样进入这套反馈回路。来源不同只影响材料与核验方式，不再创建互相竞争的流程。

### 3.3 真正终态

```text
delivery_watch --MR merged--> end
任意活动状态 --用户主动停止--> canceled/exit
```

`end` 不再表示“已 push”或“流水线绿”，只表示 Cloud 任务已经无法再向原 MR 继续交付。

MR 被关闭不是终态：保留 `delivery_watch`，继续监听重开或等待用户主动停止。

## 4. Cloud 与内核的正式契约

命令名可在实现时按内核风格调整，但必须具备以下三类语义，且只能由可信 Cloud 宿主调用。

“可信宿主”不是靠命令关键词判断。Cloud 每次调用都追加 `--host-proof`：私钥保存在
任务工作区之外，只把公钥固定进 `execution_contract.host_authority`；签名逐次绑定
任务、动作、完整载荷摘要、短时效和一次性 nonce。Hook 的命令识别只负责尽早给出
友好提示，真正授权由内核验签决定，因此拆词、变量、子 shell 等命令混淆也不能伪造
宿主动作。

### 4.1 打开或追加反馈批次

```text
mae-flow delivery feedback-open --file <batch.json>
```

输入建议：

```json
{
  "schema": "mae-flow-feedback-batch/1",
  "batch_id": "fb-task-30-0007",
  "task_id": "task-30",
  "base_sha": "...",
  "opened_at": "...",
  "items": [
    {
      "id": "mr:d-123",
      "source": "mr_discussion",
      "source_id": "d-123",
      "revision": 0,
      "kind": "code_review",
      "summary": "空值场景需要处理",
      "file": "src/a.ts",
      "line": 42,
      "material": "../feedback/fb-task-30-0007/mr-d-123.json",
      "verification": "reviewer"
    }
  ]
}
```

内核行为：

- 校验当前任务是 Cloud 持续协作任务；
- 校验 `base_sha` 与当前 HEAD/当前交付轮关系；
- 相同 `batch_id` 重放必须幂等；
- 保留 `config`、`choices`、分支、需求和完整历史；
- 增加 `delivery_round`，记录 `from_step`、`base_sha` 和反馈引用；
- 当前处于 `external_verify` 或 `delivery_watch` 等宿主等待态时，进入 `feedback_triage`；
- 当前已有唯一 writer 时，登记并追加当前批次或排入下一批，不强行跳转初始状态；
- 已有修复轮时追加或排到下一批，不允许开启第二个 writer；
- 不执行 `init`，不生成 `.last`，不清空原配置。

### 4.2 登记本轮处理结果

```text
mae-flow delivery feedback-result --file <result.json>
```

结果至少逐条包含：

- `fixed`：已修改代码；
- `explained`：代码无需修改，已给出依据；
- `needs_human`：不同理解会产生不同结果，需要人拍板；
- `not_applicable`：反馈不属于当前仓或已失效，并给出证据。

该结果只是处理回执，不是质量绿灯。流水线、Build-Fix 和人工核验仍由各自的权威来源闭环。

### 4.3 关闭任务

```text
mae-flow delivery close --reason merged --sha <merged-sha> --event-id <id>
```

内核校验并记录：

- 合入 SHA 与 Cloud 最近验证的 MR 源 SHA 一致；
- 相同 `event-id` 重放幂等；
- 正在运行的会话被 Cloud 先安全停止；
- 未推送的本地变化如实留痕，不能伪装成已交付；
- 最终从活动状态进入 `end`。

## 5. 统一反馈模型

现有数据不应一次性推翻：Cloud 批注账、MR discussion、流水线证据、Build-Fix 收据和 delivery outbox 继续作为各自来源的权威记录。新增一层轻量 `FeedbackItem` 索引，把它们组织成同一个修复批次，不复制或篡改原始事实。

建议的统一字段：

```text
id                Cloud 内稳定 ID
source            workspace | build_fix | pipeline | mr_discussion | conflict
source_id         来源系统原始 ID
source_revision   同一意见返工后的版本
observed_sha      意见针对的提交
location          文件、行号或整体意见
summary/material  人话摘要与完整材料路径
authority         human | machine
verification      author | reviewer | build_fix | pipeline | gate
status            open | repairing | addressed | awaiting_verification |
                  closed | needs_human
resolution        逐条处理结果和证据
```

### 5.1 各来源如何闭环

| 来源 | 何时算 Agent 已处理 | 何时真正闭环 |
|---|---|---|
| Cloud 工作台批注 | Agent 留下逐条回执 | 批注作者复检确认；需要 push 前闭环 |
| Build-Fix | 修复或给出不可处理诊断 | 同一新 HEAD 的 Build-Fix 通过 |
| 权威流水线 | 修复提交产生并重新 push | 新 HEAD 的对应流水线维度通过 |
| MR 检视意见 | 代码修改/解释并发布逐条回复 | MR 检视人确认或解决讨论 |
| 合并冲突 | 冲突标记被正确处理并提交 | 平台冲突门禁在新 HEAD 上通过 |

“Agent 说已处理”只能进入 `addressed`，不能直接进入 `closed`。

### 5.2 批次与并发

- 一个任务只有一个 `active_feedback_batch` 和一个代码 writer。
- 同一时刻到达的可修反馈尽量合入一批，一轮把已知问题处理完，不再只修最高优先级一项后丢掉其他已知输入。
- 人工反馈到达时，停止正在写代码的 Build-Fix/流水线修复执行权，将现有材料与人工意见合并给同一个主修复会话。
- Agent 正在正常修改时，新反馈可以持久化后 steer；无法安全 steer 时排到下一批，不能启动第二个 writer。
- 来源事件使用 `(source, source_id, source_revision, observed_sha)` 去重；重启和轮询不得重复派修。

## 6. 证据失效与复用

反馈到达不等于代码已经变化，因此不能一收到意见就无条件删掉全部历史证据。

规则如下：

1. 反馈批次打开后，未闭环反馈阻止最终完成，但保留旧 HEAD 的事实用于诊断。
2. Agent 只解释、HEAD 未变化时，可复用旧 HEAD 的 Build-Fix 与流水线结果。
3. 只要 HEAD 或工作区指纹变化：
   - 旧 Build-Fix 收据失效；
   - 旧 push 人工确认失效；
   - 旧流水线 PASS 不再背书新代码；
   - 重新计算本轮交付文件和增量 diff；
   - 重新完成 Build-Fix、必要人工检视、push 和权威流水线。
4. 原始需求、配置、知识、工作流快照、基线和历史轮次不失效。
5. 所有失效都由 SHA/指纹和内核状态机械判断，不能依赖 Agent 自述。

## 7. Cloud 侧改动

### 7.1 新模块，避免继续膨胀 `taskService.ts`

建议新增：

- `src/feedbackLoop.ts`：纯状态机、批次合并、来源优先级、闭环判定；
- `src/feedbackStore.ts`：追加式反馈索引与恢复；
- `src/kernelDelivery.ts`：Cloud 调用内核 feedback-open/result/close 的唯一适配层；
- 各来源只负责翻译为 `FeedbackItem`，不各自派 Agent。

`taskService.ts` 只负责总编排和任务状态投影，不继续堆一套新的反馈判断。

### 7.2 替换现有分叉

需要收敛的旧路径：

- 删除检视返工的 `reviewRoundLane → rolloverTerminal → init`；
- `dispatchWorkspaceReviewRepair`、`dispatchReviewRepair`、CI 修复和冲突修复改为统一反馈入口；
- `delivery.loop.kind` 不再决定启动哪套互斥流程，兼容期只做旧任务投影；
- Build-Fix 仍可使用专项构建容器，但不再拥有独立的任务生命周期；
- `watchMerge` 继续负责外部监听，只负责产生反馈事件或 close 事件。

### 7.3 拆开“可合入”与“已完成”证明

当前 `completionAttestation` 同时给 `await_merge` 和 `completed` 使用，要求内核 terminal，这是本次错位的重要来源。应拆成：

- `deliveryReadyAttestation`：内核在 `delivery_watch`，当前 SHA 的外部质量义务已通过，可以继续等待合入；
- `taskCompletionAttestation`：MR 已合入且内核已执行 `delivery close` 进入 terminal，任务才可以 `completed`。

恢复、依赖解锁、清理和通知分别使用正确的证明，不能再共用“end 即已交付”的旧尺子。

### 7.4 跨仓与 Issue Flow 的边界

持续反馈循环必须是 Cloud 的通用编排能力，不能只藏在某一个需求流程的分支里：

- 跨仓需求的每个子任务各自拥有仓库、分支、MR、HEAD、反馈批次和唯一 writer；
- 父任务只做汇总与依赖编排，不替子任务消费反馈，也不因一个子任务返工而重置其他子任务；
- 需求交付流程是第一条完整接入链路；Issue Flow 一旦进入代码交付并创建 MR，也必须复用同一个 `feedbackStore`、闭环判定和内核交付契约；
- Issue Flow 自己的建单、分析和分诊阶段不在本次重构范围内，不能为了复用交付循环把两类前置流程强行合并。

因此新模块和数据模型不得使用只属于单仓需求的命名或假设。正式灰度前，要至少补一条 Issue Flow 创建 MR 后收到反馈的契约测试，防止平台再次长出两套生命周期。

## 8. 内核侧改动与仓库边界

这部分属于 Cloud 特有生命周期，不直接污染 Mae-Flow 插件主线。
**落点已拍板(2026-09-01)**:先在 Mae-Flow 的 Cloud 专属分支实现
(进度优先);"并入主线+执行契约能力开关"记为路线图,时机由用户
另定——分支每欠一次主线 rebase 都是债,不许无限挂账：

1. 在独立 Mae-Flow Cloud 分支上实现，基线必须对应当前 vendored SHA；
2. 源码只在 Mae-Flow 仓修改；
3. 通过 `harness/sync-kernel.sh` 同步到本仓 `kernel/`；
4. `kernel/VENDORED` 必须记录准确来源分支与 commit；
5. 禁止在 Cloud 仓手改 vendored kernel 后忘记回源；
6. Cloud 启动自检必须探测 `continuous_review` 能力，不支持时拒绝以新契约开任务，不能静默退回旧的 `end/init` 行为。

内核预计涉及：

- `flow/flow.json`：新增 `delivery_watch`、`feedback_triage` 与回路；
- `workflow/execution_contract.py`：声明 Cloud 持续协作能力；
- `pipeline_commands.py`：Cloud PASS 进入 `delivery_watch`；
- 新的交付反馈命令与状态记录；
- 抽取并复用 `user_intervention` 的安全回退和证据清理能力；
- Git 授权从“仅流水线 RED”推广为“当前反馈批次精确授权”；必须完整
  继承 external_repair_gate 的严格度:精确集合、构建产物出账、缺少与
  夹带都逐项点名,推广不许把闸做松；
- panel/status/current：展示持续检视轮次，不再显示重新开单；
- Hook：尽早提示 Agent 不要调用宿主命令；内核再用工作区外私钥签发的一次性
  capability 验签，真正保护 feedback/close 不被 Agent 自行伪造。

## 9. 前端体验

页面不应把每轮返工画成重新走完整流程。高层进度保持稳定：

```text
配置与需求 → 方案 → 开发 → 持续检视 → 已合入
```

进入交付闭环后，高亮始终停在“持续检视”。它不是一个很快经过的尾部步骤，而是承载多轮反馈、验证和等待合入的稳定阶段；页面只在下面切换本轮活动：

- 等待 Build-Fix；
- 第 2 轮，正在处理 3 条意见；
- 已修改，等待批注作者确认；
- 流水线运行中；
- 门禁全绿，等待合入。

反馈列表必须可见，不能只显示数量。按来源分组，但共享一致状态词：待处理、处理中、待核验、已闭环、需要你决定。

任何后续修复都不得再次出现：

- 配置确认；
- 交付方式选择；
- “重新开始任务”；
- 新任务号、新分支或新 MR。

## 10. 恢复与迁移

上线必须覆盖在途任务，不能只保证新单。

### 10.1 新任务

下单事实写入持续协作执行契约；启动时确认内核能力，缺失则 fail-closed，明确提示部署版本不匹配。

### 10.2 已在 `await_merge` 且内核为 `end`

服务恢复时执行一次幂等迁移：保留配置、选择、历史、质量 PASS 和 HEAD，将内核从旧 `end` 转成 `delivery_watch`；不得启动 Agent、不得重跑流水线、不得重新通知用户。

### 10.3 已被错误重开到 `config_confirm/workflow_select`

若 Cloud 台账明确这是原任务的检视修复，且 `.last` 是同一任务、同一分支、同一基线的旧终态：

- 从 `.last` 恢复原配置和历史；
- 合并已经落盘的反馈批次；
- 进入 `feedback_triage`；
- 保留新轮已经产生的真实代码改动；
- 迁移无法证明安全时停止并给出明确诊断，不猜着覆盖现场。

本节是全方案风险最高的一段:测试不许只用构造现场,必须拿本次事故
留下的真实 `.mae-flow.json.last` 形态做夹具(现场在用户环境已保留)。

### 10.4 已在修复中或验证中

保持当前 writer/HEAD/反馈批次，按持久化 `batch_id`、`controlEpoch` 和 SHA 恢复；不得重复派 Agent、重复回复 MR、重复触发同 SHA 流水线。

### 10.5 已完成或用户已停止

不迁移、不重新度量、不重新 push。

## 11. 实施分批

所有代码先保持功能开关关闭，直到内核与 Cloud 契约、迁移和端到端全部就绪，避免发布半套生命周期。

### 批 0：冻结契约与失败用例

- 把本文不变量写成测试名称；
- 增加真实内核 `end → 收到意见` 的失败复现；
- 生命周期测试禁止使用会直接改 `.mae-flow.json` 的 `managedFlowFixture`；
- 固定现有事故：进度回到配置确认、平台 review 配置卡漏给用户。

### 批 1：Mae-Flow Cloud 分支

- `delivery_watch`、反馈打开/结果/关闭命令；
- 持续协作执行契约；
- 幂等、回退、证据和 Git 授权；
- 内核单测、自测和状态迁移。

### 批 2：同步 vendored kernel 与 Cloud 握手

- 用同步脚本更新 `kernel/` 和 `VENDORED`；
- Cloud 启动自检探测能力；
- 新旧执行契约明确分流，禁止静默降级。

### 批 3：Cloud 生命周期接线

- PASS 进入 `delivery_watch`；
- 拆分 ready/completion attestation；
- MR merged 调内核 close 后再 completed；
- 移除终态 rollover/init。**顺序纪律:拆旧路之前必须有能用的新路**
  ——本批先把现有 `dispatchReviewRepair` 最小化接到 feedback-open
  (不建统一 store),批 4 再泛化;不许出现"平台检视意见没人接"的
  中间态；
- 完成在途任务迁移和恢复。

### 批 4：统一反馈批次

- 建立 feedback store/state machine；
- 接入 Cloud 批注、Build-Fix、流水线、MR discussion 和冲突；
- 一个 writer、批次合并、逐条回执、不同来源的闭环策略；
- 保留旧来源台账和 outbox 的权威性。

### 批 5：前端和通知

- 高层进度固定为持续检视，不再回到配置；
- 展示自动匹配到的反馈明细与来源；
- 通知说清本轮做了什么、谁来核验、下一步是什么；
- 不把系统轮次、内核命令和机械状态甩给用户。

### 批 6：端到端与灰度

- 本地假平台覆盖全部竞态；
- 真实浏览器跑完整需求；
- 内网试点仓跑真实 Build-Fix、CodeHub MR、流水线和人工检视；
- 观察一个 MR 至少经历两轮不同来源反馈后合入；
- 灰度期间保留只读诊断，不保留回退到旧 `end/init` 的运行分支。

## 12. 必须通过的测试矩阵

### 内核契约

- Cloud 首轮只执行一次 init；本地插件旧语义不变；
- `external_verify PASS → delivery_watch`；
- `delivery_watch + feedback-open → feedback_triage`，配置、分支和历史逐字保持；
- 同一 `batch_id/event_id` 任意次重放只生效一次；
- 多轮 feedback 不生成 `.last`，不进入 `config_confirm`；
- 无代码变化复用同 SHA 证据；新 HEAD 让旧证据失效；
- Agent 不能伪造 feedback-open、pipeline record 或 delivery close；
- merged close 后才 terminal。

### Cloud 状态与恢复

- await_merge 重启后继续监听，不重新 init；
- 人工批注、MR 意见、流水线红和冲突同时到达时只有一个 writer；
- Build-Fix 运行中收到人工意见时，旧执行权失效且现场不丢；
- 任意持久化边界崩溃后不丢反馈、不重复回复、不重复 push、不重复流水线；
- MR 关闭后继续监听，重开后恢复；
- MR 合入竞态下停止 Agent，核对实际合入 SHA并诚实处理未推送现场；
- 跨仓子任务分别持续到各自 MR 合入，父任务只在全部子任务 completed 后完成。
- Issue Flow 进入代码交付后复用同一反馈循环，不另起一套修复 Agent 或终态规则。

### 逐条闭环

- 工作台批注必须由原作者核验；
- MR discussion 回复发布失败可恢复，不能冒充已送达；
- pipeline/build-fix 只认新 HEAD 的机器结果；
- needs_human 明确停下且问题包含具体歧义；
- Agent 总体回复不能替代缺失的逐条回执。

### 用户体验

- MR 创建后任何返工都不出现配置确认或交付方式选择；
- 进度始终位于“持续检视”，只切换本轮活动；
- 反馈明细可见，不只显示数量；
- 每轮说明“收到什么、改了什么、谁来确认、接下来做什么”；
- 手机通知保留 `/mfc` 激活说明，但页面本身不依赖手机能力。

## 13. 不做什么

- 不自动合入 MR；
- 不为每轮反馈创建新任务、新分支或新 MR；
- 不让用户每轮重新选工作流、知识或配置；
- 不把所有来源原始账本一次性迁到一个大 JSON；
- 不依赖提示词维持生命周期和证据安全；
- ~~不设置默认修复轮数上限~~ **已修订(2026-09-01 用户拍板)**:保留
  修复轮预算兜底,默认 20 轮——"每轮以不同方式红"会让"无新进展"判据
  永远检测不到收敛,无预算即违反"凡引入等待必须带预算或出路"红线;
  同 SHA/同反馈版本/明确诊断仍是主收敛判据,预算是最后的出路；
- 不直接在 Cloud 仓修改 vendored kernel 后遗忘回源。

## 14. CC 审视重点

请重点挑战以下问题：

1. `delivery_watch` 是否足以消除 Cloud 活着、内核已死的双状态；
2. ready/completion 两种证明是否还有混用入口；
3. 反馈批次追加、服务重启、Build-Fix 中断和 MR 合入竞态是否会产生第二个 writer；
4. 哪些证据应保留，哪些必须按新 HEAD 失效；
5. 旧 await_merge 和错误重开到 config_confirm 的任务能否安全迁移；
6. 本地 Mae-Flow 与 Cloud 分支是否真正隔离，vendored 来源是否可追溯；
7. 测试是否真实走内核命令，而不是再次由夹具代写状态文件掩盖问题。
8. 反馈在开发中、验证中和等待合入时到达，是否都能进入同一个任务且不抢占出第二个 writer。
9. 通用反馈引擎是否真正不依赖单仓需求假设，能覆盖跨仓子任务和 Issue Flow 的交付阶段。

## 15. 检视结论与拍板（2026-09-01）

CC 检视结论:方向与根因诊断通过,方案作为目标架构采纳。修订与拍板:

1. **内核落点**(用户拍板):先走 Mae-Flow Cloud 专属分支(进度优先);
   "并入主线 + 执行契约能力开关"列入路线图,后续择机做,分支欠主线的
   rebase 债要显式跟踪。
2. **修复轮预算**(用户拍板,必改项):默认 20 轮兜底,替换原"不设上限";
   理由见 §13 修订处。
3. **临时补丁**(用户拍板):平台检视轮配置卡预答的止血补丁**废弃不合入**,
   直接按目标态开发;批 0 照旧把"end→收到意见→重开"的真实内核失败
   复现固定成测试。
4. 执行层修订四条已回填正文:批 3 顺序纪律(§11)、反馈来源补越界裁决
   与 push 确认卡(§2.1)、授权闸严格度继承(§8)、迁移测试用真实
   `.last` 夹具(§10.3)。

## 16. 批 1—6 落地记录与显式勘误（2026-09-01）

### 16.1 落地结果

- **批 1，Mae-Flow 内核**：在 `cloud/continuous-review` 专属分支新增
  `delivery_watch`、`feedback_triage` 与三条宿主交付命令；本地插件未声明
  能力时仍按旧语义进入 `end`。feedback-open/base SHA/幂等、Agent 伪造保护、
  精确路径授权、构建产物出账以及缺失/夹带点名均有内核测试。
- **批 2，Cloud 握手**：发布件通过同步脚本回灌，`VENDORED` 记录来源 commit、
  分支和自动派生基线；服务启动探测 `continuous_review`，缺失或异常时拒绝以新
  契约开任务，不走旧生命周期兜底。
- **批 3，生命周期接线与迁移**：先把平台检视接到 feedback-open，再删除
  rollover/init 返工路；ready/completion 证明拆开，恢复、依赖解锁、通知和清理
  分别使用正确证明；MR merged 先停 writer、核对源 SHA、执行 delivery close，
  再把 Cloud 任务置为 completed。
- **批 4，统一反馈循环**：工作台批注、Build-Fix、流水线、MR discussion、冲突、
  负责面打回和 push 确认返工进入同一追加式反馈索引；只保留一个 writer，逐条
  回执与来源权威核验分开。默认自动修复预算 20 轮，耗尽按原停摆纪律喊人。
- **批 5，页面与通知**：高层进度稳定为“持续检视”，反馈按来源逐条可见；执行中
  的任务默认打开执行现场；返工文案不再出现重新配置、重新选交付方式、新任务、
  新分支或新 MR。
- **批 6，假平台 E2E**：覆盖内核契约、迁移、逐条闭环、四类 single-writer 竞态、
  MR 关闭/重开/合入竞态、跨仓子任务，以及同一 MR 经工作台意见和流水线反馈两轮
  后合入。Issue Flow 覆盖“同一 Issue Agent 创建 MR 后收到流水线反馈、修复并在
  同一 MR 闭环”。

### 16.2 勘误：设计与现有现实的最小偏离

1. **Issue Flow 没有 Mae-Flow 内核。** §7.4 原文要求 Issue Flow 复用“内核交付
   契约”，但现有 Issue Flow 在架构上是独立固定流程，前置和交付阶段都没有
   `.mae-flow.json` 或 KernelHost。为避免本批暗中重写整个 Issue Flow，本次只做
   最小偏离：MR 创建后复用同一 `FeedbackStore`、反馈状态词、来源核验、同一
   Issue writer 和同一 MR；没有伪造调用 delivery 命令。若要让 Issue Flow 也由
   Mae-Flow `delivery_watch` 托管，需要单独迁移其整个交付后半段。
2. **仓库里没有本次线上事故原文件。** §10.3 要求使用事故留下的真实 `.last`；
   当前工作区、`.pilot` 和用户开发目录中均未找到该任务文件。测试没有手写替代
   状态，而是用当前 vendored 的真实旧命令完整执行
   `init → 配置确认 → external_verify → pipeline PASS → end → 再次 init`，由内核
   自己生成真实 `.mae-flow.json.last + config_confirm`，再走生产迁移。它证明文件
   形态和因果链，但不是线上事故文件的逐字节副本；若后续取得原文件，应追加一条
   脱敏的 byte-for-byte fixture 回归，不替换现有真实命令链测试。

### 16.3 已验与未验

已验证：Cloud 全量测试（0 失败，环境项显式 skip）、主/contract 双 TypeScript、
Web 生产构建、Mae-Flow 全量 selftest、`npm run probe` 和 `git diff --check`。

未验证且不伪报：真浏览器交互、真模型长链、内网 CodeHub/真实流水线/真实 MR
检视。以上必须在用户部署环境演练；仓库测试只证明本地真实内核和假平台契约。

### 16.4 终审整改（同日）

CC 终审进一步发现并已收口这些接缝，均按原设计的“不阻塞、不糊弄”原则处理：

1. 宿主命令从“Hook 识别命令字符串”升级为 RSA 签名 capability；Agent 能执行同一
   CLI 也拿不到工作区外私钥，伪造、改载荷和重放均由内核拒绝。
2. MR 合入与 writer 停机竞态中，若本地已经多出未推送提交，`close` 仍以平台实际
   合入 SHA 完成终态，同时记录 `local_head`、未推送提交和未提交路径；终态核验不再
   错绑本地较新的 HEAD，也不会把这些本地内容冒充已交付。
3. 非工作台反馈不再根据总体回复或“HEAD 是否变化”代填回执。工作台使用
   `local-receipts.json`，MR discussion 使用逐条 `review_replies.md`，流水线、冲突等
   机器来源使用绑定 batch/id 的结构化 JSON；缺、重、旧、夹带都原地补交一次，仍不
   合格则明确保留现场停下。
4. MR discussion 的身份改为来源 ID + revision（平台没有 revision 时使用稳定内容
   指纹）+ observed SHA；同一评论编辑后形成新反馈和新回复，旧回复不能吞掉新内容。
5. FeedbackStore 只自动截掉崩溃留下的最后半行；中段或完整坏账 fail-closed 并点名。
   Cloud 索引缺记录时从内核 append-only 批次重建，避免写序中断后永久隐藏反馈。
6. capability 的信任根移到 Agent 工作区之外，并校验目录、文件、属主、权限、RSA
   强度和公私钥一致性；feedback-open/result、pipeline record、用户介入和 merged
   close 的权威投影都必须有宿主持久收据。`.mae-flow.json` 即使被伪造，也不能
   伪造反馈、绿灯或终态。中文摘要参与收据核验有专门回归，避免非 ASCII 比较异常。
7. 迁移改成可回滚事务：旧 `end` 先保留现场，adopt 失败即恢复原状态，重试仍可
   成功。反方向的崩溃窗也补齐：内核 close 已成功但 Cloud `task.json` 仍是
   `await_merge` 时，重启从可信 close 收据恢复 `completed`，不会再次 adopt。
8. FeedbackStore 除 JSON 语法外严格校验来源、状态、时间、revision、行号和
   resolve 引用；单任务坏账只在该任务展示错误，不拖垮 `/tasks`。重建只接受有
   宿主收据的内核批次；内核 result 成功、Cloud 索引落盘失败时，幂等重试会补齐
   状态与逐条 resolution，不会因 `result_digest` 已存在而永久早退。
9. MR discussion 接口失败与“确实没有未解决意见”分开表达。前者保持监听并明确显示
   “检视意见明细暂不可用，正在自动重试”，禁止用空数组把门禁误报为全绿。
10. `continuous_review` 的启用事实另存为按真实仓库路径绑定的工作区外宿主文件，
    Agent 删除 `host_authority` 或把可写状态改成 `false` 都不能降级回旧契约。ready、
    terminal 和反馈派单验签覆盖完整生命周期；处理期间只允许 `current` 正常推进，
    活动批次编号、内容和状态仍必须与最近宿主收据精确一致，不能把真实 PASS 与伪造
    批次拼接。FeedbackStore 对“最后一行是完整 JSON、但语义非法且没有换行”的情况
    同样 fail-closed；只有实际写断的 JSON 半行才允许恢复。
11. MR 合入事件可能与最后一条在途流水线记录同时落内核。Cloud 仅对内核明确
    返回的 revision 乐观锁冲突做有界幂等重试；每次都重新读状态、签宿主凭据，
    并复用同一 `event_id`。其他错误不重试、不降级，仍保留现场停下。
