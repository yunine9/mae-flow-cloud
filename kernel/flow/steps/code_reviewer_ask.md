这是开场配置的最后一个短选择，必须在创建分支和开发前完成。用 AskUserQuestion 单选询问：

> 人工检视前，是否需要一次只读 CODE Agent 预检？

- 用户选“不需要 Agent 预检，我直接检视”：执行 `done --choice disabled`；
- 用户选“需要，人工检视前先由 Agent 预检”：执行 `done --choice enabled`。

跨文件、跨模块或涉及公共接口的改动推荐启用——Agent 预检按编码基准（code-taste-v1.md）挑顺应性问题，模型评审代码的能力强于生成，这一次派发性价比最高；单文件小改可不启用，由用户直接检视。
拿到按钮结果后同轮直接执行 done，不要再要求用户输入确认句。

关闭只跳过这一次 Craft Reviewer Agent 预检；用户对完整未提交 diff 的人工检视和后续质量链均保留。

月光宝盒自动使用 `enabled`，不增加人工停顿。旧版在途状态缺少该字段时也按 `enabled` 兼容。
