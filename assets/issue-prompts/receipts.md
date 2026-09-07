<!--
工具回执与门禁拒绝文案(ADR-0016):平台工具调用的返回人话(模型可见)。
锚点命名 <工具>.<情形>,锚点是代码协议。{{var}} 由代码注入。
数据拼装段(文件清单/失败项明细/流水线描述)由代码算好经变量传入。
-->

## pull.guide.prep

拉仓指引:还有要用的仓继续调 pull_repo;都拉齐了就调 complete_stage 申报完成本阶段。
{{stage_brief}}

## pull.baseline_miss

注意: 该仓没有基线分支 {{baseline}},修复分支未创建、停在其默认分支——请核实基线是否正确,拿不准就用 AskUserQuestion 问用户。

## pull.remote_branch_warn

遗留警报: 远端已存在同名修复分支 {{branch}}@{{remote}},与本地(从基线另起)分叉——疑似上次运行停止/取消前推送的遗留。放着不管 push_branch 会被拒(非快进)。请用 AskUserQuestion 请用户拍板处置:在代码平台删除远端旧分支后重推,还是沿用旧分支。

## dts.module_hint

业务信息:特性={{feature}},模块={{module}}——请用这些关键词调 lookup_modules 检索业务模块

## dts.briefing

单据详情已获取——通读单据后调 complete_stage 申报完成,进入拉取代码仓:
{{stage_brief}}

## push.no_ticket

单号门禁:会话尚未绑定 DTS 单号。请用户在页面「绑定单号」后重试——推送与提 MR 都必须先绑定单号

## push.branch_mismatch

分支名不符合交付规则: 应为 {{expected}},实际 {{branch}}。修复分支命名固定为 master_<工号>_<单号>

## push.dirty

工作区有未提交改动,push 只推送已提交的历史——现在推只会推出旧提交(MR 将没有 diff)。先提交再重推:
  git add -A && git commit -m "[{{ticket}}] <改动说明>"
未提交的文件({{count}} 条):
{{files}}

## push.review.raised

{{lead}}已发起推送确认卡(带本次变更摘要),git push 未执行。请结束本回合等用户确认——确认后平台会通知你重新推送本分支;若用户答「暂不推送」,按其意见调整后再重新发起确认

## mr.no_ticket

单号门禁:会话尚未绑定 DTS 单号,不能创建 MR

## mr.no_push

仓 {{repo}} 还没有推送记录:请先对该仓调用 push_branch,再创建 MR(一仓一 MR,改过的仓各自交付)

## mr.receipt.fixed

平台已启动流水线监看:请结束本回合,等待流水线结果(红了平台会带回失败项让你修)。

## bind.locked

该会话的业务模块由人工预绑锁定,不能调用 bind_module 改绑。如你判断模块与单据明显不符,请用 AskUserQuestion 告知用户,由人在 DTS 列表改绑或提供代码仓地址;当前直接对已登记仓逐个 pull_repo 即可

## analysis.no_report

分析报告还没写出来:请先把报告写到工作区根目录 issue-analysis.md(问题现象/问题根因/修改方案/证据链/置信度五章节,首行一句话总结,模板见技能 issue-analysis),再提交

## analysis.missing_sections

分析报告缺必备章节:{{missing}}。按技能 issue-analysis 的模板补齐五章节再提交;轻量路径的简版报告也必须五章节齐全(内容可简,要素不缺)。

## analysis.submitted.no_ticket

分析报告已提交,平台已把确认卡转给用户。请结束本回合等待作答(用户将决定挂起等提单还是闭环归档)。

## analysis.submitted.ticket

分析报告已提交,平台已把确认卡转给用户。请结束本回合,等用户确认后进入问题修复。

## ut.recorded

UT 结果已记录(第 {{round}} 轮:通过)。report_ut 只记录结果、不推进阶段——自检与测试可接受就调 complete_stage 申报完成,进入「提交 MR·跑绿」。

## ut.failed

UT 未通过已记录(第 {{round}} 轮)——继续留在问题修复阶段:修复后重跑重报;测试结果可接受后调 complete_stage 申报完成。

## mrgate.mismatch

MR 清单与实际不符,不能通过:{{details}}
清单要和实际对得上:对每个改过的仓 push_branch + create_mr,然后把全部 MR(链接或仓地址)重新申报,一个都不能少、不能编。

## mrgate.empty_ok

MR 清单核验通过(没有改动、无需 MR),流程到此完成——等用户确认归档。

## mrgate.all_green

MR 核验通过({{repos}}):全部 MR 流水线跑绿,流程到此完成——等用户确认归档。

## mrgate.red

MR 核验不通过:有流水线未跑绿,还不能申报完成。
{{details}}
处置:修复后同分支 push_branch、重建 MR(create_mr),再调 complete_stage 重新申报。

## mrgate.awaiting

MR 清单已受理({{repos}})——流水线还在跑或暂无记录。全绿后平台自动完成收尾并通知用户,有红平台会把失败项带回;可结束本回合等结果。

## complete.stage_closed

阶段完成,平台推进到下一阶段——
{{stage_brief}}
