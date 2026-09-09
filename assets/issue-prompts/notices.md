<!--
平台主动通知文案(ADR-0016):闸门裁决后的交接词、流水线结果通知、
催办词、环境通知。锚点命名 <域>.<名>[.<变体>],锚点是代码协议。
{{var}} 由代码注入:{{supplement}}/{{note}} 这类可为空(代码传空串)。
-->

## nudge.body

平台催办(第 {{attempt}}/{{budget}} 次): 本阶段还没申报完成你就结束了回合,这不算完成——完成与否按上面的完成标准判定。
{{stage_brief}}
继续推进。除非正在等用户作答或确需用户决策,不要停下;再无故停下 {{remain}} 次平台将不再催办,转为等你人工指令。

## restart.resume

平台通知: 服务重启,平台自动续跑,接着当前阶段继续,不重复已完成的工作。

## gate.analysis_confirm.confirm

用户已确认问题分析报告,进入「{{stage}}」阶段。{{supplement}}请按已确认的方案实施修复,完成后调用 complete_stage。

## gate.analysis_confirm.supplement

用户对分析报告提出补充意见,仍在「{{stage}}」阶段:{{decision}}{{supplement}}
请按意见完善 issue-analysis.md 后重新 submit_analysis 提交。

## gate.conclude.rework

用户对分析结论提出意见,回到「{{stage}}」阶段:{{decision}}{{supplement}}
请继续查证,完善 issue-analysis.md 后重新 submit_analysis 提交结论。

## gate.push.grant

用户已看过本次变更并确认推送(推送确认)。令牌已生效——请重新调用 push_branch 完成推送(令牌用一次就失效,之后的每次推送都会重新发卡确认)。{{supplement}}

## gate.push.hold

用户选择暂不推送,本次变更未获放行:{{decision}}{{supplement}}
请不要推送——先按用户意见调整,调整好后再重新发起推送确认。

## gate.verify.fail

用户在环境验证发现问题,已退回「问题分析」阶段(第 {{round}} 轮)。{{reason}}
请基于新一轮的情况重新分析(前几轮的修复还在分支上,不要推倒重来),分析完成后重新 submit_analysis。

## gate.evidence.header

平台通知: 人工已把交付平台上的流水线报错原文贴进会话(仓 {{repo}},第 {{reds}}/{{max}} 次红灯,仍在「提交 MR·跑绿」阶段)。

## gate.evidence.dims

缺口所在维度({{dims}})按下面的原文定位修复,不许猜改。

## gate.evidence.source

人工贴进来的报错原文:

## gate.evidence.tail

失败产物(若已镜像)在会话工作区 pipeline/ 目录,可用 Bash 读全文。
请按原文修复后同分支 push_branch 再 create_mr(同一 MR 会自动跟新提交),平台会重新监看。

## env.configured

平台通知: 网管环境已配置(凭据已入 vault;调 get_issue_meta 可查登记元信息全量)。请重试刚才的操作——按技能 issue-ops 抓取日志。

## env.refused

平台通知: 用户已确认无需{{scope}}(拒绝了网管环境配置请求)。请基于现有证据继续,不要再次请求网管环境;如证据不足,在分析报告里如实说明证据局限。{{note}}

## mr_review

平台通知: CodeHub MR 收到 {{count}} 条检视意见,请逐条处理:
{{list}}
逐条修复后,在同一修复分支追加提交,用 push_branch 重推、create_mr 重建 MR,再调 complete_stage 重新申报验绿。每条处理完,把回复写进工作区文件 mr-review-replies.json(JSON 数组,元素形如 {"discussion_id": "意见id", "body": "回复正文"}),平台会代为发布回 CodeHub。

## pipeline.green.remind

平台通知: 全部 MR 流水线已跑绿({{repos}}),请调 complete_stage(带 mrs 参数申报 MR 清单)完成「提交 MR·跑绿」阶段申报。

## pipeline.green.others_red

平台通知: 仓 {{repo}} 流水线已全绿,但仍有 MR 未跑绿(仍在「提交 MR·跑绿」阶段)。请核实各仓流水线状态,需要的仓修复后同分支 push_branch 再 create_mr。

## pipeline.red.header

平台通知: 流水线未通过(仓 {{repo}},第 {{reds}}/{{max}} 次红灯,仍在「提交 MR·跑绿」阶段)。
