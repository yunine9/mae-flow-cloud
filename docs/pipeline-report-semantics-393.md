# Issue #393：报告状态与测试结果分开

CodeHub 的 `Review Tips / CPP_UT / success` 如果只有 `ut_json` 报告地址，
只说明报告生成成功，不能转换成 UT 执行通过，更不能声称覆盖率达标。

## 修改范围

- `pipeline-status.sh` 与 `pipeline-status-mcp.py` 共用 `pipeline_checks.py`。
  Review Tips 和仅含报告链接的质量条目保留说明，不生成测试通过状态。
  CPP_UT 只有工具状态、没有测试指标时也不推断通过。
- REST 路径读取实际 jobs；MCP 路径继续读取 stages/jobs。实际 UT 的
  success/failed/skipped/not_run 原样归一，编译失败不会覆盖独立 UT。
  没有执行证据时不凭编译失败推断 UT 未执行，也不制造成功。
- 质量指标进入 checks.details。同维度、同状态也合并明细；明确超限
  不被工具总体 success 掩盖。模板适配模式默认读取同名 stage/tool/details，
  老配置不必添加字段；有特殊字段路径时可配置 check_details。
- 修复摘要优先完整列出超限指标，普通缺陷继续使用摘要预算。
  指标超限本身不冒充可定位的源码错误，不会因此放宽修复证据判断。
- 实际 CI 修复使命说明：报告生成、测试通过、覆盖率达标不能相互推导；
  DT 等未知指标保留原名和数值，不猜测试类型或失败用例数。

没有新增审批、执行阶段或重试机制，也没有修改内核源码。

## 验证与部署

本地使用 Issue 的数据形状构造夹具，不是访问内网生产：

- 运行真实 shell 脚本和本地模拟 CodeHub/CLI；报告成功不能生成 UT 成功。
- 编译失败但独立 UT 成功、UT 跳过、未执行、失败分别保留实际状态。
- MCP 同状态合并保留构建失败与 DT 两项指标；重复采集不重复添加明细。
- 模板适配器把指标传给宿主；真实 dispatchCiRepair 构造的使命包含 DT 和表述规则。
- 原有流水线排序、MCP 参数契约、失败证据与模板/contract 适配测试保持通过。

部署时更新整个 deploy/adapter-tools 目录（包括新共用模块），并更新、重启
Cloud 和 adapter。旧任务持久化的 checks 和正在运行会话里的旧文字不会被
这次代码更新追溯改写；下一次实际查询及修复会话使用新语义。不要手动写成功状态。
