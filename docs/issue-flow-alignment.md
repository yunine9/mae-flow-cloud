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

附带:61a1a6f "reduced kernel authority" 解释了 2026-09-10 遗留的
5 个红测试(kernelCommitRedirect 拦截可能是被有意裁掉的内核权限),
需与廖翔对契约后再定测试归宿。

- [ ] 拍板(grill)
- [ ] 实施(或纯自查结论)

## ④ 恢复健壮性自查(源:4e51c0d/f207475)

按需求侧验收标准自查问题侧重启恢复:核验故障不误报无授权、收据/
账目中断可恢复、排除项不阻断恢复。

- [ ] 拍板(grill)
- [ ] 实施(或纯自查结论)

## ⑤ 构建日志直播+分批回放按需取用(源:f0bde69/0c47a1c)

问题侧环境预热(warmup)不直播编译过程;若接,复用需求侧
executionEventBuffer 分批回放模式(EventsPane 已有分批装载底子)。
UT 聚焦提示词(816e51b):问题侧 briefs.md 已有 TDD 节奏,最多补一句
"聚焦函数与模块 UT 不跑全量"。

- [ ] 拍板(grill)
- [ ] 实施(可能拍板为暂不做)
