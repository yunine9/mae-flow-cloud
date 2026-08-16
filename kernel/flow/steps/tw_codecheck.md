先直接尝试 done：纯文案、测试或构建配置改动由证据层自动放行，不启动 CodeCheck。
若 done 提示存在业务代码，再执行 `python "{MAEFLOW_PATH}" codecheck-scan`。
不再使用人工 `skip`；这样“小改”只要真改了业务代码，就不可能靠一句理由跳过检查。
若 scan 列出 W1/W2 等“归属不确定”候选，机器不能直接当存量排除：用 AskUserQuestion 分批展示，
让用户选择哪些涉及本次修改，再严格按输出执行 `codecheck-scope --include ...` 或
`codecheck-scope --none`。确认前禁止生成修复任务卡或 done。
**0 告警直接 done,不派 agent**(codecheck-fix-agent 是修复工,没告警别派它空跑);有告警才执行
`python "{MAEFLOW_PATH}" agent-task codecheck`，把唯一启动话术原样交给它。
整个需求最多两轮 CodeCheck。Agent 修复源码后保持未提交，done 自动进入 compile-agent 和统一用户检视；
确认提交后回到本步骤复验，轮次不重置。第二轮后仍有告警只留痕，不再循环。
可用性只认 `codecheck fullcheck` 能否跑,裸 codecheck 报"不可用"不算数、别据此派 agent。
REMAINING 时展示一次遗留摘要后直接 done，作为建议项进入交付报告；不逐条询问、不要求
插件内豁免、不重启长任务。done 不再第三次现场复核。解析失败时保存完整输出到
`.mae-flow-work/codecheck-diagnostics/` 并绑定当前源码，直接留痕继续。
`codecheck-scan` 还会打印本轮详细日志路径。日志记录每批实际命令、退出码、原始输出、
范围确认、Agent 工具结果和真实 Git diff；遇到误拦或工具异常时先把这份本地日志交给维护者，
不要靠回忆复述。日志位于 `.mae-flow-work/`，不进入业务提交，写日志失败也不会新增门禁。
