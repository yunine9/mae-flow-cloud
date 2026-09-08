# task-4 领域归档对账恢复

修复来源：内核 `9807eb3`。这是恢复已有文件的正式归档入口，不是扩大交付白名单。

修复行为：

- `prepare --unchanged` 核对本轮已提交增量及未提交文件，实际存在领域文档变更时提前给出恢复提示。
- `prepare --domain <领域> --adopt-existing --keyword <关键词>` 从正式文档初始化候选；已有候选保留供核对。
  即使旧账已 applied 且输入未变，也允许显式重新准备。候选仍须通过现有文档校验。
- `show` 明确告知本次会重新写入已有文档；`apply` 仍核对候选新鲜度和授权，实际写入文档与索引后才登记路径。
- 交付对账失败转为正常命令错误，不再向界面抛裸 Python traceback。

## 给内网 Agent 的恢复指令

部署最新 Cloud main（包含同步的 kernel）后，在 task-4 **原 Agent 的业务仓工作目录**执行，
不要在服务仓运行，也不要修改 `.mae-flow.json` 或手填 `applied_paths`：

1. 读取当前 `docs/specs/cross-rat.md`、`docs/specs/index.md` 和既有归档候选，确认该领域文档属于本单交付。
2. 执行：

   ```sh
   python3 /data/mae-flow-cloud/repo/kernel/scripts/mae-flow.py domain-archive prepare --domain cross-rat --adopt-existing --keyword "跨制式"
   python3 /data/mae-flow-cloud/repo/kernel/scripts/mae-flow.py domain-archive show
   ```

   已有索引行的关键词会保留。若已有候选与当前正式文档不同，先核对并修正候选，再重跑 prepare。
3. 确认候选与预期交付一致后，沿 Cloud 原有授权方式执行：

   ```sh
   python3 /data/mae-flow-cloud/repo/kernel/scripts/mae-flow.py domain-archive apply --auto
   ```

4. 核对输出包含 `docs/specs/cross-rat.md` 和 `docs/specs/index.md`。
   若 Git 内容发生变化，按正常交付流程重新整理提交和对应验证，不用旧 SHA 的证据背书新版本。
   然后重新提交交付决定。

恢复只修领域归档，不重跑需求分析/Story/编码，也不执行 push 或擅自排除领域文档。

## 验证边界

真实临时 Git 仓覆盖：已提交/未跟踪领域文档、错误 unchanged、候选准备、授权 apply、交付 selection-reconcile；
确认拒绝、候选过期、不合法文档仍不能被登记。未连接内网 task-4，不能声称线上任务已经恢复。
