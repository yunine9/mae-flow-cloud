**本步结构是"先检查、后按结果分岔"——codecheck-fix-agent 是修复工,不是检查工,没告警就别派它。**

先直接尝试 done：没有业务代码变更时证据层会自动放行，不执行 CodeCheck。
若 done 提示存在业务代码，再执行 `python "{MAEFLOW_PATH}" codecheck-scan`，由 harness 统一计算文件并运行检查：
- 算「变更业务代码文件清单」:git diff --name-only 基线...HEAD 过滤代码文件、排除测试文件;
  **清单为空(本单没改业务代码)→ 无需检查,直接 done**;
- harness 在项目根执行 `codecheck fullcheck -f <清单>`(禁 increcheck),随后**按覆盖口径过滤**:
  变更行±3 或同一变更函数内的告警由机器直接判为本次相关；其余只能标作“归属不确定”，**不得自动排除**。
  scan 会为这些候选编号并逐条展示；用 AskUserQuestion 分批让用户选择哪些涉及本次修改，
  再执行输出中的 `codecheck-scope --include ...` 或 `codecheck-scope --none`。
  用户确认前禁止生成修复任务卡，也不能 done。告警明细缺行号时无法安全预分类，保守全算并明示;
  月光宝盒禁止询问用户，因此把所有疑似范围外候选保守计入本次修复范围，不做自动排除;
  **可用性只认这一条命令能不能跑**——裸 `codecheck`、`codecheck --help` 之类报"不可用"一律不算数,
  别据此判定"codecheck 坏了"更别派 agent 去"修复 codecheck"(它是修代码规范的,不修工具);
  真的 `codecheck fullcheck` 本身跑不起来(报错/命令不存在)→ 保存诊断并按建议项留痕，
  不派 agent、不重复长跑，直接 done；源码变化后才重新尝试一次。
- 如果 CLI 完成了但输出格式暂时无法解析，harness 会把完整现场保存到
  `.mae-flow-work/codecheck-diagnostics/` 并绑定当前 HEAD。它属于工具兼容建议，
  不要求用户人工填数，也不因为解析器不认识新版本输出封死流程。
- 读输出的「共有 N 条告警」，完成必要的用户范围确认后:

**N = 0(干净)→ 不派任何 agent,直接 done**(源码变化会让首检失效)。
这是最常见的正常路径,别把它走成"派个 agent 空跑一趟"。

**N > 0(有告警)→ 才派 codecheck-fix-agent 去修**。整个需求最多执行两轮扫描/修复/复验：
执行 `python "{MAEFLOW_PATH}" agent-task codecheck`，把输出的唯一启动话术原样交给 agent；
传入单号类型、基线分支、编译方式配置原文、项目根绝对路径、测试路径配置(如有);
**喂到嘴边**:把上面算好的文件清单 + 首检告警明细直接附进任务提示(省它重算的轮次,与复核同口径);
任务卡会按 `docs/specs/index.md` 自动附上本需求相关领域真相；禁止全量读取领域文档或读取历史 delivery notes。
**大批量分批**:告警 >30 条或文件 >15 个 → 任务卡按文件划批，仍只派一轮修复；
不要为每条告警重启全新实例。
**本步不做"顺手精简"**:源码在这一步只因 CodeCheck 告警而改,由 codecheck-fix-agent 来改。
看到可删的死参数、可合的重复分支——记进最终交付说明,不在本步动手:Ponytail 已经过去,
现在改会让首检失效、门禁把 done 拦下,你会在"改—重扫—又改"里空转(实战撞过)。
(本步在 Ponytail 之后——不给已删代码修规范;在 UT 之前——CodeCheck 告警引出的重构在此定稿,
UT 才能覆盖到最终形态。)
(Agent 返回自然语言仅供展示，不再解析 FOUND/FIXED/REMAINING_COUNT 或固定状态行；
PreToolUse/SubagentStop/Agent PostToolUse 记录生命周期，harness 从真实 transcript 核对 fullcheck 调用和范围。
检测到 started 但返回事件缺失时禁止自动重派，先执行 doctor。)
CLEAN→done；修复产生源码改动时保持未提交，done 会先进入 compile-agent 和统一用户检视，确认提交后
回到 CodeCheck；已消耗轮次不会重置。两轮后仍有 REMAINING→展示一次遗留摘要并直接 done，写入最终交付风险，不逐条询问、
不要求插件内豁免、不重启长任务。FAIL 且没有留下未验证源码改动时同样作为工具建议项收尾；
若 FAIL 后留有源码变化，必须回退或完成编译后再收尾。
done 只核对首检/Agent 证据仍绑定当前源码，不再第三次现场重跑 CodeCheck。
首检会打印本轮 CodeCheck 详细日志路径；同一日志按时间追加实际命令、退出码、原始输出、
用户范围裁决、Agent 工具结果、报告和 Git diff。排查工具问题或误拦时优先提交这份日志，
不要让 Agent 猜现场。日志位于 `.mae-flow-work/`、不进入业务提交，日志失败不构成门禁。
