评审意见处理阶段的独立规范检查。主会话只负责触发机器首检和呈报裁决，**禁止亲自修告警**。

1. 先直接尝试 done；没有业务代码变更时机器自动放行，不运行 CodeCheck。若提示需要首检，
   再执行 `python "{MAEFLOW_PATH}" codecheck-scan`。该命令按返工基点只检查本轮业务代码，并记录首检 HEAD/告警数。
   若列出 W1/W2 等“归属不确定”候选，必须用 AskUserQuestion 分批让用户确认哪些涉及本轮返工，
   再按输出执行 `codecheck-scope --include ...` 或 `codecheck-scope --none`；机器不得自行排除。
2. 首检 0 告警 → 不派 agent，直接 done；首检后源码若变化，done 会判首检过期并要求重扫。
3. 首检有告警 → 执行 `python "{MAEFLOW_PATH}" agent-task codecheck`，把输出的唯一启动话术原样交给 codecheck-fix-agent。禁止主会话代修；任务卡已包含范围、配置和编译方式。
   整个需求最多两轮 CodeCheck。Agent 修复源码后保持未提交，done 自动进入 compile-agent 和统一用户检视；
   确认提交后回到本步骤复验，轮次不重置。
4. agent 返回 REMAINING 时展示一次遗留摘要，作为建议项进入交付报告，然后直接 done；
   第二轮后仍有告警同样只留痕，不逐项询问、不要求插件内豁免、不重启长任务。
5. done 只核对首检/Agent 证据仍绑定当前源码，不再第三次现场重跑 CodeCheck。

CodeCheck CLI 成功返回码不稳定，harness 从报告汇总表/提示文案取告警数，不再只认「共有 N 条告警」一句话。
如果 CLI 已完成但新版本输出仍无法解析，完整现场会保存在 `.mae-flow-work/codecheck-diagnostics/`。
解析失败时保留诊断并绑定当前 HEAD，按工具建议项直接继续；源码变化即失效并重新尝试一次。
`codecheck-scan` 会同时打印详细日志路径，其中保留每批实际命令、退出码、原始输出、
用户范围裁决、Agent 工具结果与真实 Git diff。发生误拦或工具异常时优先提供该日志。
日志只在 `.mae-flow-work/` 留存，不提交；日志故障本身不阻断流程。
不要把解析问题误当告警，更不要为了继续流程随便填 0。
