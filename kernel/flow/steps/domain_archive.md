实现与定稿已经完成。现在只把本次最终代码中已经确认、实现并验证的长期知识归档到领域真相源；Spec、Grill、Story、实施附录与过程件都留在 `.mae-flow-work/{单号}/`，不得提交。

先按 `docs/specs/index.md` 判断本次涉及的领域。每个领域分别执行：

`python "{MAEFLOW_PATH}" domain-archive prepare --domain "<领域>" --keyword "<关键词>"`

首次执行只会在本单 `domain-archive/` 下初始化候选。根据本地 Spec、Grill、Story、实施附录、最终代码和测试补充长期事实，删除模板草稿标记，然后原样重跑该命令。多个领域逐个准备；没有任何长期知识变化时执行：

`python "{MAEFLOW_PATH}" domain-archive prepare --unchanged`

用 `python "{MAEFLOW_PATH}" domain-archive show` 展示归档结论和 diff。
{{#CLOUD_HOST}}
云端宿主无人值守：根据最终 Spec、代码、测试和既有领域索引保守填写候选，不确定内容不编造。
完成 prepare/show 后执行 `python "{MAEFLOW_PATH}" domain-archive apply --auto`，
禁止 AskUserQuestion 或伪造消息 ID；归档结论用户会在工作台与 MR 上看到。
{{/CLOUD_HOST}}
{{#LOCAL_HOST}}
月光宝盒模式同样保守填写候选、不确定内容写入晨间待办，完成后执行
`python "{MAEFLOW_PATH}" domain-archive apply --auto`。
普通终端模式只向用户确认一次：收到回答后先执行 `python "{MAEFLOW_PATH}" messages`
取得当前回答 ID，再执行 `python "{MAEFLOW_PATH}" domain-archive apply --message-id "<消息ID>"`。
{{/LOCAL_HOST}}

候选过期只重新 prepare，不回退编码或验证。命令失败时执行 `python "{MAEFLOW_PATH}" domain-archive status`，按输出的唯一恢复动作处理；禁止猜参数、循环重试或改写流程状态。应用完成后 done。
