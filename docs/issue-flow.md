# 问题流 v2:我的问题会话(与需求内核分离)

问题单处理与需求开发是**两个范式**:需求是目标明确的固定交付流水线,
由内核(`kernel/`,flow.json 状态机)裁决;问题是"路线图式"的动态研究——
可能只定位一下就结束,可能是非问题,可能先研究后补单号,确认要修才进入
编码。因此问题流**刻意不进内核**(这是设计不是缺口,别"修"回去),由
`src/issueFlow/` 独立承载,与 taskService/kernel 零 import。

范式来源:every-skill 仓的 playbook(拿单→建分支→拉日志→对齐→实施→
提交→换库→验证→提MR 的原子能力菜单)。平台做三件事:**承载运行、
显示阶段、守住门禁**。

## 探索方式:固定流程 / 自由探索(2026-08-27 领导拍板)

个人设置(「个人设置 → 问题处理探索方式」,缺省**固定流程**)决定
**新会话**的烙印;进行中会话不迁移。自由探索路径从未被删改——这就是
"将来一键切回"的保证。`mode` 落盘在 issue.json,旧现场缺字段读作自由。

### 固定流程:宿主权威阶段机 + 工具门禁(方案 B)

一个连续会话贯穿到底,但**阶段真相在宿主**:AI 上报不算数(固定模式不
注册 report_stage),推进只发生在三处——机械推进(拉单成功/UT 通过/
流水线全绿)、人工闸(用户确认)、AI 自报(仅"问题修改完成"一处)。
工具按阶段开放,越权调用在 execute 入口被拒(提示词的工具清单只是
引导层,工具门禁才是权威层)。

**有单七阶段**:`dts_info 获取DTS单信息 → prep_repo 拉取代码仓·建分支
→ analyze 问题分析 → fix 问题修改 → ut UT验证 → mr_green 提交MR·跑绿
→ deploy_verify 换库环境验证`。登记时必须填代码仓(阶段1拉仓是必经
节点);分支 `master_工号_单号` 由**宿主**在阶段2创建(不交给 AI 起名)。

**无单三节点**:`prep_repo 拉取代码仓(不建分支——分支名规范需要单号)
→ analyze 问题分析 → conclude 确定结论`。面向测试/开发自行定位:
结论"是问题"→ **挂起(suspended)** 等提单;"非问题"→ 直接闭环归档
(报告仍落 issue-analysis.md 留痕)。

**两个人工硬闸 + 两个机械闸**:

- 分析报告确认(analyze→fix):AI 调 `submit_analysis`(以报告文件在场
  为门票)→ 平台举闸,用户过目确认才放行修改;无单场景同一入口带结论
  (issue/non_issue)。
- 换库环境验证(deploy_verify):`build_deploy` 成功 → 平台举闸,
  用户**真实验证**;通过→待手动归档,有问题→**一律回退 analyze**
  (轮次+1,fix 起各阶段标 redo,分支/MR 延用同分支追加,UT/监看作废)。
- UT 闸:没报 UT 通过(`report_ut passed=true`)不准 create_mr——
  拦"上报"不拦"真相",硬验证在流水线(UT 本身也在流水线里跑)。
- MR 绿闸:create_mr 后**宿主监看流水线**(公共 pipelineClient,触发+
  轮询,预算内不弃看):红→携失败 checks 开回合让 AI 修(同分支再推,
  MR 自动跟新提交),绿→自动进换库验证;预算耗尽如实停表请人工。

平台闸写进 issue.json(`gate` 字段),Agent 对该文件只读——AI 推不动
闸,这是"固定"的强制度所在;渲染复用问题卡组件。

### 无单挂起 → 关联单号转正

挂起会话在右栏输单号 → 平台经 DTS 网关校验**存在性**(查无即拒,
单据详情给用户过目)→ 确认转正:**新会话**继承工作区(repo/ 整目录+
issue-analysis.md,免二次克隆)、环境凭据(vault 复制后销毁旧的),
阶段 1-3 标 `inherited`,直接进 fix;旧会话归档(结论 converted,
互相链接)。同用户+同单号至多一个活跃会话。转正不可逆——单号是新
会话的身份(分支名/MR/台账都带)。两段式接口:`POST /issues/:id/
associate {ticket, confirm?}`。

### 自由探索

原范式不变:AI 按 playbook 自主编排,`report_stage` 上报阶段,阶段可
跳可回,绑定单号随时绑/解(bindTicket),人工闸交给 AskUserQuestion。

## 生命周期

- 登记:「问题处理」页手工登记(有单填单号走七阶段,无单留空走三节点;
  固定流程必须填代码仓,业务模块是自由文本标签——模块→仓映射配置另
  有团队在做),或从 DTS 拉单勾选发起(当前一次一张,批量只留了 UI
  口子;固定流程在此页签补填仓/模块/网管环境)。
- 会话 = 一条多轮对话 + 一个工作区(`dataDir/issues/<id>/`,克隆固定在
  `repo/`,日志落在 `local-logs/`,结论文档 `issue-analysis.md`)。
- 三条用户输入通道,全部复用 CloudSession 原语:
  - **问题卡作答**:AI 用 AskUserQuestion 挂起(自由模式的人工闸门),
    或平台闸(固定模式,同组件渲染);页面选项/自由作答后回合续跑;
  - **插话**:运行中 steer,当前工具调用完成后送达;
  - **续聊**:回合结束(idle)或重启中断(interrupted)后发消息,
    `continueWith` / `startResume` 续上现场。
- 终态:`archived`(结论:非问题/已修复/已提MR/问题成立/已转正)、
  `canceled`、`failed`;`suspended` 是挂起中间态(只能关联转正或归档,
  不能续聊)。**非问题是一等结论**——研究判定误报就出结论归档,
  不强制走编码交付。

## 阶段显示

自由模式:阶段由 AI 通过 `report_stage` 工具**上报**(枚举 + 一句话
note),宿主校验落 `issue.json`,前端纯镜像不推断。

固定模式:阶段进度条(计划线,per-stage 状态:pending/in_progress/
done/inherited/redo)+ 旅程线(transitions 账)并存。真相链:
`issue.json` + `events.jsonl`(SSE 尾随与任务侧同款)。

## 安全边界(比照需求流的同款纪律)

- **秘密止步宿主**:网管环境密码(vault 加密存取)、Git 令牌、DTS/
  Codehub 的 x-auth-token 都只在宿主进程;不进容器、不进模型上下文、
  不进事件流。Pi 运行时本身无 MCP——"AI 调 DTS/Codehub MCP" 由宿主
  工具桥接(协议在宿主终结)。
- **Agent 推不动代码**:克隆 pushurl 指向 /dev/null;推送必须走
  `push_branch` 宿主工具(safeGit 只读视图 + 临时 bare 传输仓 +
  ls-remote 复核)。
- **单号门禁是机械的**:未绑定单号时 `push_branch`/`create_mr` 直接
  拒绝;分支名必须 `master_<工号>_<单号>`。研究免单号,提 MR 前必须
  有——规则写在工具里,不在提示词里。固定流程的关联转正还要过 DTS
  存在性校验。
- 台账保护:GateService 把 `issue.json`、`skills/` 列为宿主账本,
  文件工具拒写(bash 路径的残余风险见诚实清单)。平台闸/阶段状态/
  UT 上报都在 issue.json 里——Agent 想改也改不动。

## 宿主工具与会话技能

自由模式工具(会话内):`report_stage` / `fetch_logs`(宿主跑
fetch-logs 二进制,产物落工作区,Agent grep 真实文件)/ `build_deploy`
(宿主跑 build-deploy,成功哨兵校验)/ `dts_get_ticket` / `push_branch`
/ `create_mr`(经公共 mrClient → 交付平台适配层 → codehub CLI,
单号自动关联)。

固定模式工具:去掉 report_stage,新增 `submit_analysis`(提交分析/
结论,以报告在场为门票,触发人工闸)/ `report_ut`(UT 结果上报,
passed 才放行 MR)/ `complete_stage`(仅"问题修改完成"自报);阶段
门禁:dts_get_ticket 仅 dts_info、build_deploy 仅 deploy_verify、
create_mr 仅 mr_green 且 UT 已过、push_branch 自 fix 起、fetch_logs
自 analyze 起(含回退轮)。

技能(每次会话物化到 `skills/`,改编自 playbook):issue-playbook(路线
图)、issue-research(研究方法与非问题出口)、issue-delivery(分支/提交
格式 `[单号][类型] 描述`/推送/MR)、issue-ops(环境工具用法)。工号 =
登录账号,不再从 $HOME 猜。

## 部署配置(问题流相关)

```json
{
  "dts-mcp-url": "<DTS MCP 网关地址>",
  "mcp-token-file": "/etc/mae-flow-cloud/mcp-token",
  "issue-max-turns": 2
}
```

- token 文件权限 600。DTS 网关未配置时拉单/查单/关联转正 fail-loud
  (如实报"未配置",不静默降级)。
- **过渡期 mock**:`--dts-mock` 接确定性假单据(DTS-2026-1001~1005,
  与 --dts-mcp-url 互斥),供外部环境在真 MCP 接入前跑通全流程;真实
  网关实现完整在位,等 URL/工具名即通。
- **MR 与流水线不走 MCP**:问题流与需求交付共用同一个交付平台适配层
  (`--platform`,src/platformAdapter.ts → codehub CLI),公共客户端在
  src/mrClient.ts(MR)与 src/pipelineClient.ts(触发/状态,固定流程
  的 MR 跑绿监看用它)——同格式、同身份头(x-mfc-git-token)、同单号
  关联(dts_no → --e2e-issues)。
- 拉日志/换库依赖 `assets/ops-tools` 二进制在场(linux 产物带执行位)。

## 问题流专用部署(--issue-only):需求依赖不阻塞问题流

隔离的落点在启动面:需求流程的重依赖(内核 python、交付平台、prepush、
容器镜像守卫、通知端点)**全部按需加载**;`--issue-only`(或配置文件
`"issue-only": true`)声明本部署只服务问题处理:

- 内核模式整体不启用——缺 `--platform`/`--isolate-image` 的 exit(2)
  守卫不再触发(那是给内核模式部署的 fail-loud,不是给问题流的);
- 需求任务发起被 API 层拒绝,`launch-options` 的 blockers 把停用状态
  摆在明面(前端现有拦截渲染直接复用);
- 在途需求任务不拉起(pump 熔断),台账可读、用完整部署重启同一
  数据目录即自动续跑;
- 通知假件起不来也不阻塞启动(完整部署仍 fail-loud)。

问题流自身的最小依赖只有:模型网关配置、登录、数据目录。`--issue-only`
启动后「问题处理」全功能可用(冒烟:演示模型可跑通登记→首轮→举卡)。

## 与旧 DTS triage 流的关系

旧的"同任务双阶段 triage→hotfix"路径(入口在发起表单的 DTS 页签)
已被本流程**整体取代并删除**(系统未上线,无在途数据,不留遗骸):
entry_kind/issue_context 字段、finishIssueTriage 硬接线、
IssueEnvironmentAdapter 适配器接口与 Go 适配器、旧测试全部移除。
保留的共享基建:凭据保险箱(`.issue-environments/`,两个域按
task-/issue- 前缀互不碰撞)与 assets/ops-tools 二进制(改由问题流的
宿主工具消费)。

## 已知边界(诚实清单)

- 【遗留,待用户提供后接线】DTS MCP 的工具名与返回形状未对拍:
  `src/issueFlow/gateways.ts` 的解析留了显式缝,形状不符会如实报错。
  过渡期用 `--dts-mock` 在外部环境跑全流程。
- 问题 MR 不接平台的检视意见闭环/冲突修复/合入监视(用户拍板"合并
  的事情不用管,只把代码提交好");固定流程只盯**流水线绿**(宿主
  轮询,红了喂给 AI 修)。需求侧的修复环仍在 taskService,本期未
  并轨到 pipelineClient(避免无谓回归面)。
- 崩溃恢复是摘要式(重启后按 issue.json + issue-analysis.md 重播种),
  不是上下文无缝续接——与任务侧同一约束(Pi 会话内存驻留);固定
  流水线监看(watching=true)重启后会重新挂表,预算沿用原 deadline。
- 台账保护覆盖文件工具;bash 内 `echo > issue.json` 这类路径未防
  (重启加载时无篡改校验)。单号门禁不受影响(推送查的是宿主侧状态)。
- 批量处理:列表勾选已就位,当前强制单选。
- build-deploy 的回滚能力二进制未提供;换库验证依赖人工闸门兜底。
- 固定流程的人工闸是平台卡(复用问题卡渲染),与 Agent 的
  AskUserQuestion 并行两套机制;AI 举问题卡与平台闸同场时平台闸优先。
- 模块→代码仓映射配置由另一团队在建,问题流的"业务模块"字段目前
  仅是展示标签;映射就绪后接入登记表单。
