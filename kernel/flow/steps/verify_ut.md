先直接尝试 done：没有源码、测试或构建入口变更时证据层自动放行，不生成任务卡、不运行 UT。
需要 UT 时先执行 `python "{MAEFLOW_PATH}" agent-task ut`。Harness 根据本次修改函数生成自适应任务卡。
每批先审计并复用已有测试；已有断言完整覆盖就不改文件，只有覆盖缺口才新增/修改测试：
小范围由一个 ut-generator-agent 一次完成；大范围由 Harness 按每批 3-5 个方法签发任务卡，每个实例只完成
任务卡当前这一批。返回后主会话再次执行 `agent-task ut`，Harness 自动签发下一批；禁止 Agent 自行跨批扩展。
各批属于同一 UT 会话，允许累积本轮未提交测试文件；禁止逐批 commit、禁止逐批询问用户、禁止重复读取全部
Spec/Story/领域文档。
{{#LOCAL_UT_RUN}}
所有生成批结束后再启动一个「收口批」实例，只运行配置的全量 UT 命令。
{{/LOCAL_UT_RUN}}
{{#PIPELINE_UT_RUN}}
所有编写批真实返回后直接执行 `done`；内核登记待权威流水线核销的 UT 运行义务，
不再签发一个在本机注定跑不了的“最终运行批”。UT 编写 Agent 仍必须真实执行；
宿主固化 inspected_existing、added/modified test paths、test digest 与 coverage targets，审计复用本身就是合法产物。
{{/PIPELINE_UT_RUN}}
本步在 Ponytail/CodeCheck 之后,代码形态已定稿,UT 针对最终代码补测,不会因后续重构失效。
本步 gate 始终只放行测试路径写入：优先使用 config 或 `.mae-flow-defaults.json` 的「测试路径」，未配置时使用 tests/、test/、src/test/、*_test.*、*Test.java 等保守默认规则。非标准目录应先补仓库配置。这拦的是"未经用户裁决自行改被测源码",不是死禁——裁决通道见下方 SUSPECTED_BUGS 处理。
{{#LOCAL_UT_RUN}}PASS→done(codecheck 不检查测试文件,无需对测试代码补查);{{/LOCAL_UT_RUN}}
{{#PIPELINE_UT_RUN}}编写批完成→done（这里只完成测试编写，运行结果由流水线裁决）;{{/PIPELINE_UT_RUN}}
NEEDS_INPUT→展示 PENDING_QUESTIONS 等用户答复后二轮启动;
FAIL→按 Fallback(隔离失败 UT,展示 KNOWN_FAILURES 等用户裁决)。
**SUSPECTED_BUGS 非空(可伴随任一状态)→ 这是"UT 测出代码可能有问题"的正规通道,逐项处理**:
UT 发现真缺陷是它的价值所在,不是异常。逐项用 AskUserQuestion 呈用户裁决,每项必须呈现 agent 的
自查报告(失败用例、期望 vs 实际、spec 依据、自查过程、倾向判断)——没有自查报告的项先打回 agent 补查。
三个选项与去向:
- **确认代码缺陷,本单修** → 先执行 `python "{MAEFLOW_PATH}" messages` 取得当前回答 ID，再执行
  `python "{MAEFLOW_PATH}" unlock source --reason "<第N项:结论>" --message-id "<消息ID>"`
  (解锁仅本步有效)→ 修复源码 → 执行 done。Harness 会保持未提交改动，
  {{#LOCAL_COMPILE}}回流 compile-agent 和统一用户检视；{{/LOCAL_COMPILE}}
  {{#PIPELINE_COMPILE}}刷新外部 COMPILE 义务并进入统一用户检视；{{/PIPELINE_COMPILE}}
  确认提交后从 CodeCheck 继续，Ponytail 不会重跑。
- **判定 UT 理解有误,修测试** → 重启 agent 修订该用例(把用户结论原文带给它,作为修订授权);
- **本单不修(另立单)** → 记录裁决与理由,该用例按 KNOWN_FAILURES 隔离,提醒用户另立 DTS 单跟踪。
中断恢复:UT 文件和会话状态在盘上,报告在会话里——先执行 current/doctor 核对生命周期和真实执行证据；
已有 started 但返回事件缺失时禁止自动重派。仅在确认没有未闭合调用、也没有当前任务输入下的有效执行后，
才可新派无状态幂等实例（已有 UT 应识别复用而不重写）。用户明确裁决“修测试”时的授权重派不受此限制。
(本步无固定报告文件证据——PreToolUse 记录启动，SubagentStop 与 Agent PostToolUse 幂等记录返回；
{{#LOCAL_UT_RUN}}done 另行核对与当前任务输入匹配的真实 UT 命令成功执行。{{/LOCAL_UT_RUN}}
{{#PIPELINE_UT_RUN}}done 核对所有 UT 编写批真实返回，并登记外部 UT 运行义务。{{/PIPELINE_UT_RUN}}
返回自然语言仅供展示，不参与验签。)
