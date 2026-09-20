<!--
平台主动通知文案(ADR-0016):闸门裁决后的交接词、流水线结果通知、
催办词、环境通知。锚点命名 <域>.<名>[.<变体>],锚点是代码协议。
{{var}} 由代码注入:{{supplement}}/{{note}} 这类可为空(代码传空串)。
同步护栏:「请立即调 raise_gate(kind=env_verify)…结束本回合等待
用户作答」这句举卡指引散在 green.deliver / nudge.env_verify_owed 与
receipts 的 mrgate.all_green / empty_ok 四处——改措辞四处同步,
锚点是给不同场景的独立协议口,刻意不合并。
同步护栏②:「同分支 push_branch(已有 MR 自动跟新提交,平台按新提交
重新监看)」这句修复口径散在 red.deliver.guidance / gate.evidence.tail /
mr_review / pipeline.green.others_red 与 receipts 的 mrgate.red 五处
——改措辞五处同步;口径前提是推送事实即重挂监看(onBranchPushed
触发启动),动这句先核对机制还在。
-->

## nudge.body

平台催办(第 {{attempt}}/{{budget}} 次): 本阶段还没申报完成你就结束了回合,这不算完成——完成与否按上面的完成标准判定。
{{stage_brief}}
继续推进。除非正在等用户作答或确需用户决策,不要停下;再无故停下 {{remain}} 次平台将不再催办,转为等你人工指令。

## restart.resume

平台通知: 服务重启,平台自动续跑,接着当前阶段继续,不重复已完成的工作。

## rework.products_reclaimed

平台通知: 该单的构建产物(target/build/node_modules 等编译中间物)已按磁盘纪律回收,源码与依赖缓存完好。本次返工的首次编译是全量编译(依赖缓存热,无需重新下载),耗时会长于增量——按正常流程编译验证即可,不要把编译变慢当作环境故障排查。

## gate.analysis_confirm.confirm

用户已确认问题分析报告,进入「{{stage}}」阶段,按已确认的方案实施修复。{{supplement}}
修复以落盘报告为权威(上下文可能已压缩,过程性排查细节以报告为准):
报告: {{report_path}}
修改方案要点:
{{plan}}

## gate.analysis_confirm.supplement

用户对分析报告提出补充意见,仍在「{{stage}}」阶段:{{decision}}{{supplement}}
请按意见完善 issue-analysis.md 后重新 submit_analysis 提交。

## gate.conclude.rework

用户对分析结论提出意见,回到「{{stage}}」阶段:{{decision}}{{supplement}}
请继续查证,完善 issue-analysis.md 后重新 submit_analysis 提交结论。

## gate.verify.fail

用户在环境验证发现问题,已退回「问题分析」阶段(第 {{round}} 轮)。{{reason}}
先就问题理解与修改方向与用户对齐——有疑点用 AskUserQuestion 提问,不要自行猜;对齐后再重写分析报告并 submit_analysis。
前几轮的修复还在分支上,除非新分析推翻,否则不要推倒重来。

## gate.evidence.header

平台通知: 人工已把交付平台上的流水线报错原文贴进会话(仓 {{repo}},第 {{reds}}/{{max}} 次红灯,仍在「提交 MR·跑绿」阶段)。

## gate.evidence.dims

缺口所在维度({{dims}})按下面的原文定位修复,不许猜改。

## gate.evidence.source

人工贴进来的报错原文:

## gate.evidence.tail

失败产物(若已镜像)在会话工作区 pipeline/ 目录,可用 Bash 读全文。
请按原文修复后同分支 push_branch(已有 MR 自动跟新提交,平台按新提交重新监看;尚未建过 MR 的仓再 create_mr)。

## env.configured

平台通知: 网管环境已配置(凭据已入 vault;调 get_issue_meta 可查登记元信息全量)。请重试刚才的操作——按技能 issue-ops 抓取日志。

## env.refused

平台通知: 用户已确认无需{{scope}}(拒绝了网管环境配置请求)。请基于现有证据继续,不要再次请求网管环境;如证据不足,在分析报告里如实说明证据局限。{{note}}

## parked.replay

以下是平台此前发出、尚未送达你的通知,请一并纳入后续判断与动作:

{{items}}

## repos.changed.add

平台通知: 用户给本会话新增了代码仓({{repos}}),要求补充分析该仓。请调 pull_repo 逐个拉取落地,并把它纳入后续的分析与结论。

## repos.changed.remove

平台通知: 用户要求移除本会话的代码仓({{repos}})。用户主动移除=确认该仓与本问题无关,此前与之相悖的分析思路或结论应重新审视。请先重新审视与该仓相关的思路或结论、必要时修订,再调 remove_repo 逐个移除;若被平台门禁拦下(模块绑定仓/远端修复分支未清),如实向用户报告,不要强行绕过。

## logs.fetch

平台通知: 用户请求为本会话拉取网管侧日志(元信息页签「拉取日志」按钮递交的意图,平台不代拉,执行者是你)。请按技能 issue-ops 抓取日志——先 get_issue_meta 取网管环境与凭据;缺环境就按技能调 request_env 举卡请求配置,不要猜地址或两种形态都试。若本会话此前已拉取过日志、用户又没说明要拉哪些新日志,先向用户确认再动手,避免无谓的重复拉取。

## green.deliver

平台通知: 全部 MR 流水线已跑绿({{repos}})——「提交 MR·跑绿」阶段已收口。请立即调 raise_gate 工具(kind=env_verify)把环境验证卡交给用户,然后结束本回合等待用户验证(用户可不答——MR 全部合入即视为验证通过,发现问题才需要在卡上作答),不要自行继续,也不要做其他动作。

## nudge.env_verify_owed

平台催办(第 {{attempt}}/{{budget}} 次): 「提交 MR·跑绿」阶段已收口、全部流水线已跑绿,但环境验证卡还没有交给用户——请立即调 raise_gate 工具(kind=env_verify)举卡,然后结束回合等待用户验证(用户可不答——MR 全部合入即视为验证通过)。再无故停下 {{remain}} 次平台将不再催办,转为等你人工指令。

## mr_review

平台通知: CodeHub MR 收到 {{count}} 条检视意见,请逐条处理:
{{list}}
逐条修复后,在同一修复分支追加提交,用 push_branch 重推(已有 MR 自动跟新提交,平台按新提交重新监看),再调 complete_stage 重新申报验绿。每条处理完,把回复写进工作区文件 mr-review-replies.json(JSON 数组,元素形如 {"discussion_id": "意见id", "body": "回复正文"}),平台会代为发布回 CodeHub。

## pipeline.green.remind

平台通知: 全部 MR 流水线已跑绿({{repos}}),请调 complete_stage(带 mrs 参数申报 MR 清单)完成「提交 MR·跑绿」阶段申报。

## pipeline.green.others_red

平台通知: 仓 {{repo}} 流水线已全绿,但仍有 MR 未跑绿(仍在「提交 MR·跑绿」阶段)。请核实各仓流水线状态,需要的仓修复后同分支 push_branch(已有 MR 自动跟新提交,平台按新提交重新监看)。

## pipeline.green.head_moved

平台通知: 仓 {{repo}} 分支的最新提交已变为 {{sha}},刚才跑绿的提交已不是分支头——旧提交的绿灯背书不了会被合入的代码,本次不作阶段收口,环境验证卡先不举。平台会自动把检查目标切到新提交、等它的流水线结果,出新结果会另行通知;若新提交不是本会话推的,先拉取分支最新代码、看清它与你会话内代码的差异,再决定要不要跟进,不要按工作区里的旧代码继续。

## red.deliver.header

平台通知: 流水线未通过(仓 {{repo}},第 {{reds}}/{{max}} 轮红灯)。失败事实如下,怎么处置由你判断——平台不再替你分诊。

## red.deliver.guidance

处置三选一,按证据判断:
- 报错可定位:直接修复,修完同分支 push_branch——已有 MR 自动跟新提交,平台按新提交重新监看流水线;尚未建过 MR 的仓先 create_mr;
- 报错原文有缺口、无法定位:不要猜改,调 raise_gate(kind=pipeline_evidence, repo={{repo}}),把缺口维度与原因写进 supplement,请用户把平台上的报错原文粘贴进卡作答;
- 红灯全部来自改代码解决不了的平台侧工具告警:调 raise_gate(kind=pipeline_unfixable, repo={{repo}}),请用户到交付平台处理/豁免后在卡上作答。
举了卡就结束本回合等用户作答;直接修复则继续推进,不要空转收嘴。

## red.deliver.external_head

注意:分支最新提交 {{sha}} 不是本会话推的——分支头已被平台外的推送取代,现在检查的就是这个提交。先拉取分支最新代码、看清它与你会话内代码的差异,再决定怎么修;不要按工作区里的旧代码盲目改。


## advance.knowledge_remind

领域知识提示:本会话装载了团队知识仓(repo/{{name}}/,只读参考)。定位与改码中遇到代码和问题描述都解释不了的领域事实(概念、机理、术语、模块职责),先翻它的目录找对应领域:优先按业务模块名检索——模块名与缩写是第一线索(如「Access」故障管理助手 → 试 FMA),其次才是现象关键词;找到就读相关知识,引用时把文件路径写进证据链;知识仓里没有,再回代码自证,不要因缺知识停工。

## review.triage

[检视意见分诊] 用户对分析报告提交了 {{count}} 条检视意见(清单见下)。请逐条自判每条意见的类型,再按类型处理,不要不分类就整批重写:
- 回复型(澄清、追问、确认语义——用户在问问题、要解释、要补充信息,或只是求确认):调 respond_review 按意见号逐条回复,回复写完整话,不要只回"已知悉"。outcome 按语义选:需要用户补充说明=needs_clarification;解释说明、确认无需改动=not_fixed;确已因此改动=fixed(附依据)。回复型意见到此闭环:不改 issue-analysis.md、不调 submit_analysis、不申报回退。
- 修改型(需要改动分析报告内容本身:补证据、改结论、修方案):先把本批里的回复型意见逐条 respond_review 回复完,再调 declare_review_rework 申报修改(列出修改型意见号)。平台会整体回退重写并把意见清单重新注入,按清单修订好报告后,把修改型意见也逐条 respond_review 交代(说清改了什么,outcome=fixed 附依据),再重新 submit_analysis,确认卡照旧交用户。
- 检视回复只落在意见处(respond_review),报告正文不写「检视意见回应」之类的应答段——报告是交付物,重写版也保持干净纸面。
- 全批都是回复型就不申报、不出版本,逐条回复后结束本回合即可;报告未改动时不要重新 submit_analysis。
