# 问题流程对齐需求流程——工作清单(2026-09-10 立)

来源:廖翔 2026-09-08~09-09 需求流程 64 提交的分析结论。逐项走
"grill-with-docs 拍板 → 实施"循环,做完一项勾一项。拍板结论与实施
细节记在各节,不另开新文档。

## ① 外部合入终态(源:2b4797e,docs/task4-domain-and-external-merge.md)

问题侧现状:mr_green 全绿即收口(ADR-0013),MR 是否真的被合入平台
不跟踪,stage_note 只提醒人"确认 MR 合入后可归档收口"
(service.ts:4681)。验绿≠合入是团队看板问题域绩效的口径洞。

需求侧契约要点:完成依据=远端 MR 的 merged 事实+源提交 SHA(存
delivery.merged_sha);不要求与旧验证 SHA 相同;先停 Agent/Build-Fix/
容器再收口;回执发布失败不阻止读取平台合入事实;分支变化暂停交付但
不退出监听。

问题侧现成基础:pollMrDiscussions 轮询循环(service.ts:3824)、
fetchMrDiscussions 凭据链、state.mrs/pushes 账目。

- [x] 拍板(grill,2026-09-10):①软闸·事实记账——归档不堵,kind 按
  合入事实记(全 merged→delivered;有 MR 未全合→fixed),对话框摆明
  每仓状态;②双轨跟踪——closeMrGreen 后起合入监听循环(fetchMrGates),
  归档时再核一次(竞态守卫);③全部 merged 才算 delivered;④MR 被关
  →通知+stage_note,不自动返工;⑤无 MR 路径(non_issue/converted)不核;
  ⑥IssueMrRecord 逐 MR 增 merged_at/merged_sha/closed_at,SHA 漂移接受
  (合入的是 merge/squash 产物,不必等于验绿 SHA);⑦团队看板问题域
  "已交付"口径同步按 delivered(全 merged)计,fixed 单列。
- [ ] 实施

## ② 检视回执三连修对照自查(源:6ee679c/2a26c64/0c10f9a)

问题侧同构链路:absorbMrDiscussions → feedbackStore →
stageMrReviewReplies/flushMrReviewReplies(service.ts:3824 起)。

需求侧修的三类病,逐条对照:
- 投递失败有没有重试(6ee679c:补齐 MR 回执重试);
- 逐条回复会不会错配(6ee679c:防逐条回复错配);
- 重启后"已投递但平台未显示"半场会不会重投(0c10f9a:隔离消费防串单/
  重复续跑)。

问题侧已有优势:observedSha 观察基准、known-set 去重。
验收句照抄:"同一意见重复出现不新增处理轮次""回执发布失败不阻止
读取平台事实"。

- [x] 拍板(grill,2026-09-10):①recover() 续挂检视监看 + 待注入标志
  落盘化(重启不丢);②版本对不上的回复条目直接标失败("代码已更新,
  请重写回复"),失败不挡新草稿自愈;③记账分家——回复投递成功→意见
  转"已回复,待检视人核验"(addressed);讨论消失时按投递记录归因
  (AI resolve=true →"Agent 回复并解决",否则"检视人已解决");
  平台自身的 MR 合入规则不归我们管;④同讨论编号、版本号变了且未了结
  = 新追问,重新通知;⑤AI 一次通知后不自动再催(与需求侧"不重复续跑"
  对齐,人是驱动源);⑥投递队列文件读不动记错误日志,行为照旧。
- [x] 实施(2026-09-10):recover 续挂检视监看+标志落盘(mr-review-notify.
  json);漂移即 failed+重挂注入自愈;投递成功→addressed、消失归因分家
  (投递账查 resolve=true);追问=版本号变化重触发(batch_id 带版本,
  upsert 刷新);staging 加"回合中不装箱"守卫(绑稳定 SHA);信箱损坏
  记日志+新草稿自愈重写。测试:issueReviewLoopHardening 5 场景 +
  issueMrDiscussions 漂移块改语义,回归 32/32+6/6+3/3 全绿。

## ③ ADR-0020 验收标准当问题侧体检表(源:cf4e063)

问题流程本来就是 Cloud-owned 工作流(自有阶段机、无 Python 权威),
是 ADR-0020 目标形态的现成样板;其完成标准反过来逐条照问题侧:
- "不得把『Agent 报告已处理』冒充『检视人已验收』"——feedbackStore
  的 resolve 语义(Agent 修复完≠检视人在 CodeHub 点解决)、reviews
  闭环判定;
- "排队期间重启、回执已落盘但投影未更新、决定已执行但响应丢失,都能
  续接且不重复执行"——LiveIssue 重启重建路径。

附带(2026-09-10 勘定):kernelCommitRedirect 与 mrLoop 四条红测试是
**需求侧**的债(测的是需求流程的内核宿主守卫与交付环),不属于本
清单处置范围——待与内核同步(61a1a6f)的行为取舍对齐后另行处理。

- [x] 拍板(2026-09-10):与④合并一轮体检,小洞顺手修、大洞回 grill;
  范围锁死 src/issueFlow(需求侧红测试已勘定出清)。
- [x] 实施(2026-09-10,三子 Agent 深扫+高洞亲验):

**判定通过(证据在代码,不复述)**:重启续跑副作用幂等(容器/克隆/
推送/建 MR 先查后建);waiting_user 卡与 state_version 跨重启连续;
闸通知不重复轰炸;warmup fail-open;两类 deadline(证据重试窗/流水线
预算)重启后正确结算;vault 取回与三路终态清理;takeover 落盘可续;
saveState 原子写+serve 实例锁防双进程;决定卡/reply 双击被状态闸+同步
beginTurn 封死;pushes/mrs/流水线表账面幂等;档位×闸全表一致
(push_confirm 三档才举是 ADR-0009 刻意保留);权限面 18 写路由全 own()
+admin 403。

**本轮修复(带测试,tests/issueTerminalHardening)**:
- 高(C-H1/C-H2):取消撞监看迭代→settlePipeline 入口/raisePipelineGate/
  睡眠后复查/预算块全补终态守卫——canceled 不再被覆写成 waiting_user
  (原可经 answer 复活已取消会话),不再给终态会话写停机 note/发催人通知;
- C-H3:attachEnvironment 补终态/挂起守卫(防 API 级复活);
- C-H5:armReviewNotify/flushMrReviewReplies/syncMergeFacts 终态守卫
  (不投递、不落孤儿标记);
- C-H6:control 收口清面——平台闸删除、未决 Agent 卡逐条 supersede,
  终态不再投影死卡;
- B-H4:两路档位代答通知换独立状态词"已代答"(原共用 running 幂等键,
  第二次代答通知被吞);
- C-H9:materials/file 与 log-extract 补 admin 403(与其余写路由同款);
- C-H7:wire 剥离 module_locked 与 pipelines 五个重试/刹车子字段。

**遗留(按严重度,回 grill 排期)**:
- A-H1(中)作答内容跨重启丢失:answer 落账后、送达前崩溃,恢复回合
  不回灌决定文本——涉续聊提示词结构,单独立项;
- B-H1(中)associate 并发竞态可建两个转正会话:需互斥设计拍板;
- B-H2(中)追问检测单点押平台递增 revision;body 变 revision 不变时
  静默丢——updated_at 兜底,需先核实适配层配置是否映射 revision;
- A-H5(低中)检视回复信箱与 mr_green 阶段绑死:回退/非 mr_green 重启
  时 pending 停投——投不投是设计决策;
- A-H2/A-H3(低)全自动档代答不重启恢复、孤儿 Agent 卡(与 A-H1 同片
  代码,合并处理);
- C-H8(低)vault.remove 无兜底(两行间崩溃留孤儿密文),recover 无
  孤儿对账;
- 低危杂项登记不修:真平台 mr_lookup 未配时建 MR 幂等依赖平台(B-H3,
  部署配置项)、收口后重建 MR 的误导通知(A-H8)、注入标志删除与开
  回合间崩溃窗(B-H9)、environment 重复 POST 无害(B-H7)、live Map
  与终态磁盘无回收(长期卫生)。

## ④ 恢复健壮性自查(源:4e51c0d/f207475)

按需求侧验收标准自查问题侧重启恢复——已并入③同轮体检(③的"判定
通过/修复/遗留"三节即本项产出;重启续接专项见③判定通过节前六条)。

- [x] 拍板(并入③)
- [x] 实施(并入③)

## ⑤ 预热直播+UT 提示词(源:f0bde69/816e51b)

- [x] 拍板(2026-09-10):(c) 全套直播+回看(用户裁定——两侧编译同样的
  仓,时长假设无依据;SSE 语义与组件共享,成本低);UT 聚焦一句补
  briefs.md;遗留六洞全修(决定回灌/associate收尾重查/正文兜底/信箱
  离场作废/vault启动对账/代答恢复+孤儿卡)。
- [ ] 实施。**平移清单(子 Agent 已核实,数据已在盘上)**:
  1. routes.ts:注册 GET /issues/:id/warmup/events;streamIssueEvents
     (:171)路径改 per-tick resolver(文件未建先心跳、建了从头重放),
     读 session(id).root/warmup/events.jsonl;
  2. service.ts:warmup CloudSession.create(~:2613)加 streamBashOutput:
     true(否则直播无命令输出);
  3. state.ts:summarize 停剥 warmup 收据+web api.ts IssueSummary 补
     warmup 镜像+契约样例;
  4. web:tailIssueWarmupEvents(克隆 api.ts:3078);SessionView events
     页签(:408)内 running 时嵌 PrepushLiveLog(source 注入,域中立,
     无需改);仿 WarmupPanel 收口折叠。
  六洞实施进度:H1(决定回灌)已落工作树未提交;H3/H4/H5/H6 的
  python 补丁因锚点被 b1e9f46 破坏未打入,待恢复后重打;H2(associate
  收尾重查)未动。

## ⚠️ 事故记录(2026-09-10):b1e9f46 误剔已提交实现

并行会话提交 b1e9f46("剔除 #155 误卷入的协作者在途改动")时,把本清单
①②③④已提交(c5b5b07/5f74607/43f59ab)的 service.ts 实现整块回退
(421 行):合入监看全套(watchMergeStates/syncMergeFacts/mergeStatus/
notifyMrGreenClosed 点火/recover 续挂)、检视闭环六项(armReviewNotify/
漂移终态/归因分家/追问/回合不装箱守卫/信箱日志)、体检守卫
(settlePipeline/raisePipelineGate/watchPipeline/attachEnvironment/
收口清面/已代答通知词)。state.ts/tools.ts/routes.ts/web 未受影响
(routes 仍调 mergeStatus → HEAD 类型红)。**恢复计划**:以 43f59ab 的
service.ts 我的区块为源,在 HEAD 上重放(A~P 清单见会话记录);并行会话
在途的页面凭据重构(sessionDriver/semanticEvents/page_account 一串)
属其自有工作,不卷入。

## ⑤原始条目

问题侧环境预热(warmup)不直播编译过程;若接,复用需求侧
executionEventBuffer 分批回放模式(EventsPane 已有分批装载底子)。
UT 聚焦提示词(816e51b):问题侧 briefs.md 已有 TDD 节奏,最多补一句
"聚焦函数与模块 UT 不跑全量"。

- [ ] 拍板(grill)
- [ ] 实施(可能拍板为暂不做)
