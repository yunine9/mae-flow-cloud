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

一个连续会话贯穿到底,但**阶段真相在宿主**(固定模式不注册
report_stage):目标驱动自报推进(2026-08-28 拍板,ADR 0002)——每阶段
声明目标与唯一出口,拉单/拉仓/修改/UT/提交MR 五个阶段由 AI 判断达成后
调 `complete_stage` 自报收口(平台不核实工作事实),问题分析/无单结论/
换库验证三阶段的出口是卡工具本身(卡即出口,没有 complete_stage 可绕)。
平台只守两道核验:人工闸(用户确认)与 MR 验绿门。工具按阶段开放,
越权调用在 execute 入口被拒(提示词的工具清单只是引导层,工具门禁才是
权威层,两者同源于阶段注册表的 tools 列)。

**有单七阶段**:`dts_info 获取DTS单信息 → prep_repo 拉取代码仓·建分支
→ analyze 问题分析 → fix 问题修改 → ut UT验证 → mr_green 提交MR·跑绿
→ deploy_verify 换库环境验证`。已有单从 DTS 列表独立发起，登记页不再
预填仓、模块或环境；工作台随后按问题单事实触发模块识别、拉仓和环境闸。
分支 `master_工号_单号` 由**宿主**在阶段2创建(不交给 AI 起名)。

**无单三节点**:`prep_repo 拉取代码仓(不建分支——分支名规范需要单号)
→ analyze 问题分析 → conclude 确定结论`。面向测试/开发自行定位:
结论"是问题"→ **挂起(suspended)** 等提单;"非问题"→ 直接闭环归档
(报告仍落 issue-analysis.md 留痕)。

**两个人工硬闸 + MR 验绿门**(2026-08-28 拍板:平台只守它比 AI 强的
核验,其余出口 AI 自报):

- 分析报告确认(analyze→fix):AI 调 `submit_analysis`(以报告文件在场
  为门票)→ 平台举闸,用户过目确认才放行修改;无单场景同一入口带结论
  (issue/non_issue)。
- 换库环境验证(deploy_verify):`build_deploy` 成功 → 平台举闸,
  用户**真实验证**;通过→待手动归档,有问题→**一律回退 analyze**
  (轮次+1,fix 起各阶段标 redo,分支/MR 延用同分支追加,UT 上报/流水线
  监看/MR 申报账作废重来)。
- UT 事实上报(2026-08-28 降级):AI 跑完测试**自愿**调 `report_ut`
  如实上报,平台只记账(台账+事件流+现场记录)——不再是出口、不再是
  建 MR 前置;UT 阶段出口= `complete_stage` 自报(硬验证在流水线,
  UT 本身也在流水线里跑)。
- MR 验绿门(mr_green 阶段的 complete_stage):AI 建齐 MR(create_mr
  自动记账进台账)后调 complete_stage **申报 MR 清单**(mrs 参数,MR
  链接或仓地址),平台程序化验绿——清单=台账(少报/多报点名打回,
  空=空合法)+ 台账每 MR 最新推送 SHA 的流水线全绿,三态裁决:全绿
  当场放行进换库验证;有红当场打回携失败项(同分支修复再推、重建 MR、
  重新申报);在跑受理(申报账 mr_gate),宿主监看器(公共
  pipelineClient,触发+轮询,预算内不弃看)等绿自动放行、红携失败
  checks 开回合;全绿未申报只开回合提醒申报,不推进(不变量:进
  deploy_verify 当且仅当"已申报且全绿");预算耗尽如实停表请人工。

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

- 登记有两个独立入口。**手工登记只用于无单问题**:标题、现象描述、
  业务模块、网管环境四项(IP、页面账号、页面密码、后台密码)全部必填，
  页面账号默认 admin 可改；业务模块从 active 且已绑仓的团队目录中
  必选，代码仓由模块绑定自动带出并只读展示，不允许回退手填。模块目录
  读取失败会明确报错并允许重试；目录确实为空则指路「团队资产 → 业务
  模块」。**已有 DTS 单据**从 DTS 列表页签勾选发起。该列表只展示
  "开发人员实施修改"状态的单(其他状态不可发起);支持单号/标题/版本模糊搜索与
  版本多选过滤(按 B 版之前的版本段分组,默认勾选最高 R/C 组),输入
  完整单号可自动远程补查;行内展开可查问题级别、问题版本(B版)、
  提单人、问题链接与描述全文——描述里的内嵌图由宿主带同源 token 经
  `/issues/dts-file` 代理回取,浏览器不直连内网域。页签只管挑单与发起
  (2026-08-29 拍板):多选场景下预填仓/模块/网管环境价值不大,不再
  提供——发起后由工作台从问题单获取这些信息(模块识别/拉仓闸/环境闸
  按需补定);批量发起每单一个独立工作流。
- 会话 = 一条多轮对话 + 一个工作区(`dataDir/issues/<id>/`,克隆固定在
  `repo/`,日志落在 `local-logs/`,结论文档 `issue-analysis.md`,
  DTS 内嵌截图落 `ticket-images/<单号>/`——只有 dts_get_ticket 按需
  下载(#42,内容哈希去重、失败标记不再重试),前端展示仍走
  `/issues/dts-file` 代理,转正/导出不携带这些二进制)。
- 三条用户输入通道,全部复用 CloudSession 原语:
  - **问题卡作答**:AI 用 AskUserQuestion 挂起(自由模式的人工闸门),
    或平台闸(固定模式,同组件渲染);页面选项/自由作答后回合续跑;
  - **补充**:运行中 steer,当前工具调用完成后送达;
  - **续聊**:回合结束(idle)后发消息,`continueWith` / `startResume`
    续上现场;服务重启则由平台自动续跑(2026-08-29 拍板,#27:正在跑/
    排队的会话恢复时重新入队,并发额度泵以续聊回合逐个续跑,开场带
    重启平台通知),没有等人发消息救活的"打断"滞留态。
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

- **平台凭据止步宿主**:Git 令牌、DTS/Codehub 的 x-auth-token 不进
  模型上下文，由宿主工具桥接并在协议边界消费。**网管环境口令的契约
  不同**:浏览器草稿不保存，服务端 vault 加密落盘；但为让 Agent 操作
  页面、抓日志和换库，会以明文进入当前问题的 AI 上下文；不会出现在
  会话列表、状态摘要或事件流中。因此只能使用脱敏演示/现场专用口令，禁止
  个人复用或生产口令；前端、帮助中心和部署说明都必须如实提示，不能
  笼统声称“密码不进上下文”。
- **Agent 推不动代码**:克隆 pushurl 指向 /dev/null;推送必须走
  `push_branch` 宿主工具(safeGit 只读视图 + 临时 bare 传输仓 +
  ls-remote 复核)。
- **单号门禁是机械的**:未绑定单号时 `push_branch`/`create_mr` 直接
  拒绝;分支名必须 `master_<工号>_<单号>`。研究免单号,提 MR 前必须
  有——规则写在工具里,不在提示词里。固定流程的关联转正还要过 DTS
  存在性校验。
- **个人凭据前置门禁**(2026-08-28 拍板,需求侧 /launch-options 同款
  语义):登记要碰**远端仓**(http/https,含模块带出)时,发起人必须
  已配 Git 令牌与邮箱——克隆/推送用他的身份,提交署名按邮箱对人;
  没配就在 create 拒绝并指路个人设置,不让"发起后才在克隆期失败"
  (那是终态,整单作废)。file:// 本地仓与不碰仓的纯研究不拦;前端
  在表单上同步禁用提交并给出跳转,服务端是权威。
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
结论,以报告在场为门票,触发人工闸)/ `report_ut`(UT 结果事实上报,
只记账——不是出口、不是建 MR 前置)/ `complete_stage`(拉单/拉仓/
修改/UT/提交MR 五个阶段的自报出口;提交 MR 阶段必带 mrs 申报 MR 清单,
平台验绿放行)。阶段门禁以阶段注册表(src/issueFlow/stageRegistry.ts)
的 tools 列为唯一事实源:dts_get_ticket、fetch_logs 全程开放(工读类),
create_mr 仅 mr_green,push_branch 自 fix 起,build_deploy 仅
deploy_verify,submit_analysis 仅 analyze,report_ut 仅 ut。

技能(每次会话物化到 `skills/`,改编自 playbook):issue-playbook(路线
图)、issue-research(研究方法与非问题出口)、issue-delivery(分支/提交
格式 `[单号][类型] 描述`/推送/MR)、issue-ops(环境工具用法)。工号 =
登录账号,不再从 $HOME 猜。

## DTS 列表页签(工具对拍与文件代理)

拉单/查单走宿主侧 McpGateway(streamable HTTP),工具名与返回形状已按
真实华为网关对拍固化(`src/issueFlow/gateways.ts`):

| 能力 | 工具 | 关键返回字段 |
| --- | --- | --- |
| 名下列表 | `listByVersionAndHead`(14 参按声明序 arg0-arg13,查本人用 otherConditions.currentHandler=EqualName) | dtsBizNo / briefDesc / dtsStatusName / sProdBNoName(B版本) / serverityNoName(级别) / creator(提单人) / outerLinkUrl |
| 单张详情 | `batchQueryTicket`(dtsNos/fields/attachmentView) | 同上 + detailDesc(完整 HTML 描述,仅此接口有) |

页面路由(`/issues/dts*`):

- `GET /issues/dts`:本人名下列表;前端模糊搜索单号/标题/版本。
- `GET /issues/dts/:ticket`:单张详情;detailDesc 里 `<img>` 的站内
  相对路径先按 outerLinkUrl 的 origin 补全为绝对地址再下发。
- `GET /issues/dts-file?path=/v1/nfs/…`:描述内嵌图代理——后端带同一
  x-auth-token 回取二进制,浏览器只见本站 URL,没有跨域无 cookie 问题;
  path 只收 `/` 开头的站内路径。

列表字段已够展示时优先用列表数据,详情接口只补描述全文;详情拉取失败
不影响展开面板里已有的字段。DTS 文件域当前硬编码为
`https://dts-szv.clouddragon.huawei.com`(McpDtsGateway 常量),多文件域
部署时再升配置。

### 搜索、版本过滤与状态口径

- **状态口径**:拉单列表只展示"开发人员实施修改"状态的单——其他
  状态不可发起,直接不展示(本地拉取与远程补查同规);被状态挡下的
  远程单号会汇总一条人话提示,不静默消失。状态常量
  `DTS_ACTIONABLE_STATUS` 集中在 IssueBoard.tsx,放开其他状态改一处。
- **版本多选过滤(按 B 版前的版本段分组,2026-08-29)**:问题单版本
  动辄几十个 B 版构建号,按完整版本过滤要大量勾选。过滤项是剥掉尾部
  B 段后的组前缀(`V100R025C10SPC010B009` → `V100R025C10SPC010`,
  `dtsVersionGroup` 集中在 dtsText.ts),按 R 版降序、R 同比 C 版降序
  (解析不出的垫底);勾一个组,组内全部 B 版单据一并命中。**默认勾选
  并列最高 R/C 的全部组**,之后勾选/取消由用户接管。
- **远程查单**:本地搜索无命中且输入像 DTS 单号(字母开头+含数字,
  总长 ≥5,支持逗号分隔多个)时,防抖 500ms 自动调单张详情远程补查
  (序号守卫丢弃过期响应);命中的单带"远程"角标入列,详情直入缓存
  (展开零等待);计数位显示"远程查单中…";清空搜索框即清远程结果
  恢复全量,查不到如实显示无匹配。

## 会话材料与执行现场(材料/现场页签)

会话主栏两页签:**材料** / **现场**。这是任务工作台"交付材料、执行
现场"两个板块引入问题域的落点——数据全部旁路 fail-open,任何一块失败
给空态,不拖垮会话。对话不单设页签:发言入口收拢在右栏 NEXT ACTION
(六态互斥,含收口后的续聊),对话内容本身就在现场的「消息」筛选里;
结论文档是会话产出的一份材料,归入材料页签的子视图。

**材料页签**(`src/issueFlow/materials.ts`,路由 `/issues/:id/materials*`):

- DTS 单据卡片:复用 DTS 列表页签的字段对拍与图片代理,会话绑了单号即可展开。
- 结论文档:`issue-analysis.md` 即写即读,AI 续写后随状态自动重读;
  右栏"结论文档已产出"一键跳入该子视图。
- 工作区变更:diff 对 HEAD(未提交改动 + 未跟踪新文件按全文 diff),
  是"修改完成后检视并快速调整"的主视图。
- **快速修改**:问题流唯一的人工写口。点文件直接编辑保存,仅放开
  `repo/` 内已有文件(`.git` 与会话账本永不可写,新建文件交给 AI),
  路径解析双保险防穿越。保存即入会话私有台账 `manual-edits.jsonl`,
  并可一键"请 AI 复核"——运行中走插话、空闲走续聊,复用现有通道,
  不开第二个干预口。这是开发协作的折中:**人可动手,介入入账,门禁
  照旧**(推送仍走 `push_branch` 单号闸;不做 Pi 接管,避免与宿主
  编排的阶段账打架)。
- 拉取日志:`local-logs/` 清单与只读视图,超长读尾部。
- AI 运行中编辑有被覆盖的风险,页签上有明示;建议空闲/等待时改。

**现场页签**:`GET /issues/:id/materials/events` 只读 `events.jsonl`
尾窗(默认 200 条),原始事件只陈列不解读——阶段推断仍是宿主账本的事。

git 读取优先 safeGit 零信任视图;Windows 无符号链接权限的环境降级为
普通 git 只读(禁 pager;残余风险与"AI 会话本就能在该工作区跑 bash"
同权,见 materials.ts 注释,任务侧内核闸不受影响)。

## 部署配置(问题流相关)

```json
{
  "issue-max-turns": 2
}
```

- **DTS 网关零配置**:网关地址是站点固定值,已内置为代码缺省
  (2026-08-28 拍板,"值是死的就硬编码"),token 文件缺省路径
  `/etc/mae-flow-cloud/mcp-token` 也是内置的——**正式服务器放好
  token 文件,DTS 链即自动接线,serve.json 一个键都不用写**。
  缺省地址只在 token 文件在场时生效(开发机/演示形态不受影响);
  `--dts-mcp-url`/serve.json 可覆盖。token 文件权限 600。
- DTS 网关未配置时(无 token 文件的形态)拉单/查单/关联转正
  fail-loud(如实报"未配置",不静默降级)。
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

- 【2026-08-27 已落地】DTS 拉单(`listByVersionAndHead`)与查单
  (`batchQueryTicket`)已按真实网关对拍并固化(见「DTS 列表页签」
  一节);解析保留通用 fallback(parseTicketList),形状再变时如实
  报错而非静默给空列表。外部环境无真网关时用 `--dts-mock`(确定性
  假单据)跑全流程。
- 问题 MR 不接平台的检视意见闭环/冲突修复/合入监视(用户拍板"合并
  的事情不用管,只把代码提交好");固定流程只盯**流水线绿**(宿主
  轮询,红了喂给 AI 修)。需求侧的修复环仍在 taskService,本期未
  并轨到 pipelineClient(避免无谓回归面)。
- 崩溃恢复是摘要式(重启后按 issue.json + issue-analysis.md 重播种),
  不是上下文无缝续接——与任务侧同一约束(Pi 会话内存驻留);固定
  流水线监看(watching=true)重启后会重新挂表,预算沿用原 deadline。
- 台账保护覆盖文件工具;bash 内 `echo > issue.json` 这类路径未防
  (重启加载时无篡改校验)。单号门禁不受影响(推送查的是宿主侧状态)。
- 批量处理:列表多选已就位(每单一个独立工作流,服务端同单同账号
  查重,客户端逐单汇总结果);页签不预填仓/模块/环境,由工作台补定。
- build-deploy 的回滚能力二进制未提供;换库验证依赖人工闸门兜底。
- 固定流程的人工闸是平台卡(复用问题卡渲染),与 Agent 的
  AskUserQuestion 并行两套机制;AI 举问题卡与平台闸同场时平台闸优先。
- 模块→代码仓映射已经接入手工登记：业务模块必选且自动带出绑定仓，
  登记页只读展示；目录失败可重试，空目录不回退为手填仓。
