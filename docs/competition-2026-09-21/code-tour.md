# 现场代码演示：只打开这六个文件

先用 Archify 图讲清核心循环，再用三段代码证明，最后展示三份真正给 Agent 使用的 Markdown。无需逐行讲实现，也无需遍历 Cloud 功能。

## 三段代码，约两分半

路径以仓库根目录为起点，行号核对自 `b0c012e0`。演示前在编辑器预先打开这些位置。

| 时间 | 打开位置 | 只讲这一件事 |
| --- | --- | --- |
| 0:00–0:50 | [current.py](../../kernel/scripts/mae_flow_core/cli_commands/current.py)，148–193 行，`_step_md_text` | 当前任务到哪一步，就组装那一步的 Markdown；本地编译还是流水线编译、宿主推送还是本地推送，由实际配置选取。 |
| 0:50–1:40 | [advancement.py](../../kernel/scripts/mae_flow_core/cli_commands/advancement.py)，127–159 行 | 追加历史、计算下一步、保存 `current`，再输出下一步指令。流程位置落在持久状态里，续跑有明确入口。 |
| 1:40–2:30 | [guard/bash.py](../../kernel/scripts/mae_flow_core/guard/bash.py)，135–148 行，`_post_early` | 以强推保护为例：执行前识别实际 Git push 参数，拒绝 `-f`、`--force` 和 `+refspec`。必要的危险操作边界由程序检查。 |

可以直接这样串起来说：

> 第一段决定“当前该做什么”；第二段记住“实际走到哪里”；第三段限制“哪些危险操作不能自动做”。工作方法主要放在 Markdown，必须一致执行的少量边界放在代码。

第三段是实际使用的调用链：`cli_commands/gate.py` 调用 `decide_post_commit`，进入 `guard/bash.py` 的 `_post_early`。这只是一个具体安全控制例子，不代表完整的沙箱或对任意命令都安全的承诺。

## 三份 Markdown，约一分钟

| 文件 | 看哪里 | 展示价值 |
| --- | --- | --- |
| [mae-flow/SKILL.md](../../kernel/skills/mae-flow/SKILL.md) | 16–28 行 | Agent 的主循环很短：`current → 执行 → done`；已有任务从状态继续。 |
| [IMPLEMENTATION-TEMPLATE.md](../../kernel/skills/mae-flow/assets/IMPLEMENTATION-TEMPLATE.md) | 13–25 行 | 把可维护性变成具体思考：按职责拆分、删除测试、以独立可验证的交付物划分任务。 |
| [ut-generator-agent.md](../../kernel/agents/ut-generator-agent.md) | 24–40 行 | 要测真实业务逻辑；明确 Mock 与实际验证的区别；未验证和失败如实报告，不拿用例数量代替质量。 |

这些文件是实际指令来源；Cloud 运行时还会按配置组合上下文、工具与宿主补充指令，文件全文不等于某个会话的完整系统提示词。提示词提供工作方法，不保证模型每次都执行正确。

## 被追问时再打开

- **状态怎么可靠保存？** [state_store.py](../../kernel/scripts/mae_flow_core/state_store.py)，224–257 行：锁、版本检查和原子写入。它保护本地状态一致性，不等于外部操作不会中断。
- **是不是检查越多越好？** [done_status.py](../../kernel/scripts/mae_flow_core/cli_commands/done_status.py)，88–111 行：区分建议检查与必要检查；建议保留结果，但不都作为否决条件。对应 [authority.py](../../kernel/scripts/mae_flow_core/workflow/authority.py) 中的分类。
- **怎么接到实际 Agent？** [sessionDriver.ts](../../src/sessionDriver.ts)，1254–1275 行：Pi 的上下文、工具调用和结果钩子；[kernelHost.ts](../../src/kernelHost.ts) 负责内核桥接。

## 图怎么用

打开 [Archify 架构图](mae-flow-architecture.html)，切换右上角“演示”。顶部三个视角分别用于讲核心循环、工具与安全、人与交付反馈；“播放故事”按节点依次聚焦。点击节点可查看源码依据。

图是**职责与信息流示意**，不把每根箭头解释为直接函数调用或同步调用顺序。例如“事实依据”表示推进参考执行结果，“知识与仓库约定”由 Cloud 按需加入 Agent 上下文，并非由模板模块负责检索。

图中的 Cloud 工作台、反馈处理和外部集成属于宿主能力；参赛核心仍是 MAE Flow。静态备份见 [PNG](mae-flow-architecture.png)，可缩放版本见 [SVG](mae-flow-architecture.svg)。

## 重新生成

```bash
node docs/competition-2026-09-21/build-archify.mjs
```

生成 JSON 和 HTML；使用仓内 Archify 原生渲染器，验证节点来源和布局，不改运行时代码。PNG / SVG 通过 HTML 的“导出”菜单生成。图中源码链接固定到 `b0c012e0`，避免现场演示时随 main 漂移。
