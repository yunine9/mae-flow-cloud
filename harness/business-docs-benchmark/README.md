# 业务文档 Skill 固定小样本验证

直接调用生产 `DomainKnowledgeExtraction`、`runDomainKnowledge` 与真实 Pi 会话。两个临时真实 Git 仓及上传业务资料全部为合成数据；不读取私有源码，不访问内网，不发布知识或 Git 变更。真实模型调用使用指定本地配置中的模型服务，会产生模型费用。无线豆包在评测进程内禁用。

## 准备与运行

只准备固定输入，不调用模型：

```bash
node --import tsx harness/business-docs-benchmark/run.ts \
  --prepare-only --output .local/business-docs-benchmark/prepared
```

3–5 分钟小规模尝试，生成三篇指定文稿：跨仓订单生命周期、订单仓模块、库存仓模块。预算用完保留部分产物并报告 `budget_exhausted`，不把超时算成通过。

```bash
node --import tsx harness/business-docs-benchmark/run.ts \
  --models .local/models.json --provider glm --model glm-5.3-flash \
  --profile small --budget-ms 300000 \
  --output .local/business-docs-benchmark/small-first
```

如需更充分完成这三篇及独立评审，可将预算改为 `900000`。实际完成时间取决于模型和返工次数，预算不是完成承诺。完整模板另用 `--profile full`，需按任务规模给出预算；三篇通过不能代表完整模板体系已通过。

`--output` 必填且不得已存在。`--models` 在真实运行时必填；默认 provider/model 是 `glm/glm-5.3-flash`。`--skill` 默认 `internal-skills/business-docs-generator`，可指定原附件解压后的 Skill 根目录，用相同输入作基线对照：

```bash
node --import tsx harness/business-docs-benchmark/run.ts \
  --skill /absolute/path/business-docs-generator \
  --models .local/models.json --provider glm --model glm-5.3-flash \
  --profile small --budget-ms 900000 \
  --output .local/business-docs-benchmark/original-baseline
```

对照须保持 `fixture_digest`、profile、模型和预算相同。Skill 摘要应不同。第一次真实运行前冻结输入和判定规则；看到失败后不能修改事实或放宽检查来增加通过率。若评分器误判，保留原报告、说明修订原因，再回放原产物；不能称为新的模型样本。

## 输入与验收边界

固定源码包含：技术目录横跨同一业务功能、跨仓预留与释放、400 行后的支付结果未知分支、无 HTTP 入口的定时释放、旧业务建议撤销及现行例外。`reserve` 特意先检查可售余量、再复用已有编号，因此重复预留在余量不足时仍失败；不能把它写成无条件幂等。`release` 的重复调用不会重复减少 allocated。自动测试直接执行这些源码，保证样例行为和预期相符。

评分答案只存在评测器和报告中，不进入研究任务上下文；研究工具只允许读两个固定源码根目录及上传资料。自然语言业务资料是正常输入，不能把有业务依据误称为答案泄漏。

报告区分：

- **覆盖和执行事实**：指定文稿是否齐全、步骤是否完成、独立评审是否真实回读最新文稿、源码和资料；是否读到 400 行后的逻辑和次要入口。
- **固定事实关系检查**：检查条件与结论关系，遇到已知倒置、扩大为无条件规则或冲突陈述判失败。正确句子不能抵消另一处错误。只出现全部关键词不会通过；未识别的改写保留 `unverified`，需要人工判断。
- **引用和图**：使用现有固定版本代码引用校验与真实 PlantUML 渲染。缺少 Java、渲染超时或 `--no-diagrams` 均明确未验证，不能视为图通过。路径和语法有效不能证明结论及图中调用顺序正确。
- **语义正确性**：始终保留 `quality_verified: false` 与 `semantic_review_required: true`。复核者须对照源码、资料和全文填写 `semantic-review.json`；自动检查通过或模型自评都不代表真实质量认可。

可加 `--restart-after-documents 1`，在第一篇文稿保存后正常关闭服务并重建，保留重启前快照。该模式测试受控关停恢复，不是 SIGKILL，也不是 48 小时稳定性验收。它不会自动答复人工确认，也不会恢复已失败任务来掩盖失败。真实强杀应单独使用仓库的独立进程恢复夹具验证。

## 留存与退出

结果目录保留：`fixture-manifest.json`、两个完整 Git 源码仓、业务资料、固定 Skill 快照、输入、完整知识文稿和过程文稿、生产事件/会话日志、任务状态、`report.json`、待填写语义复核表。返工历史来自真实文稿 history；未发生返工时不能声称返工已验证。

模型配置只在私有临时运行目录使用，不导出 `models.json`、`models-store.json` 或 `auth.json`；导出文本再次清除配置凭据。正常退出、中断或失败都会先停止研究服务，再导出无凭据状态并删除临时运行目录。整体预算到期停止模型，清理仍受生产服务自身的有限关停预算约束。不要对运行进程直接删目录。

退出码 0 表示准备成功或自动契约检查通过；真实运行的 0 仍需语义复核。退出码 1 包含运行异常、预算耗尽、检查失败及未验证项。所有失败与部分产物保留原样，不删除后只汇报成功轮次。

定向验证：

```bash
node --import tsx --test tests/businessDocsBenchmark.test.ts
npx tsc -p harness/business-docs-benchmark/tsconfig.json
```
