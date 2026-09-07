# Agent 材料路径横向排查（2026-09-07）

## task-2 回执循环

服务端始终消费任务根下的 `reviews/local-receipts.json`。原提示词部分调用按
会话 cwd 换算，部分直接写 `../reviews`；在仓根、分析产物目录和 Bash cd
之后，会得到不同落点。分析文件门禁又只允许写分析产物，正确回执也可能被拒。

修复为所有派单、人工补交、检视修复和重建会话统一下发消费者确定的绝对地址。
分析门禁只额外开放这一份回执。旧位置的副本不自动合并，避免把过期意见回应
当成当前轮完成；补交提示要求核对后仅补回执，不重复修改业务文件。

注意：从 `task-2/repositories/` 按标准路径规则解析 `../reviews` 本应得到
`task-2/reviews`。若落在 `repositories/reviews` 或 `.mae-flow-work/reviews`，
说明实际执行目录/写入参数与这条假设不同；绝对地址消除对这项假设的依赖。

## 横向检查结果

以下路径的任务根统一为 `task.summary.workspace`，主会话启动时再次明确，
覆盖持久化使命中的旧相对写法。容器使用同路径挂载。

| 场景 | 服务端读写位置（相对任务根） | 修复/检查 |
| --- | --- | --- |
| 工作台批注、最终确认前处理回执 | `reviews/local-receipts.json` | 全部提示用绝对路径；分析门禁精确放行；reviews 可写挂载 |
| MR 讨论原始材料 | `reviews/discussions.json` | 提示和反馈材料地址绝对化；刷新时保留目录 inode、附件与其他回执 |
| MR 逐条回复 | `review_replies.md` | 提示/消费同址；预建并单文件可写挂载；消费后原地清空，保留 inode |
| 持续检视机器反馈 | `feedback/result-<batch digest>.json` | 提示/消费同址；沿用当前批次单文件挂载，不开放可信索引 |
| 流水线失败材料 | `pipeline/` | 使命与材料地址绝对化；沿用稳定只读目录挂载 |
| Build-Fix 执行记录 | `prepush/round-<round>-<sha>/` | 反馈材料地址绝对化；主容器补充只读挂载 |
| 需求预检修订 | `requirement-review/<revision>/requirement.md`、`receipts.json` | 已使用同一个固定 reviewRoot；禁用 Bash，文件工具 cwd 固定；原文附件与检视图片均物化到副本目录 |
| 模块拆分方案 | 会话目录下 `.mae-flow-work/<ticket>/` | 产物使命已有明确路径；投影每次重新读盘，未缓存 SHA 失败 |
| 问题流材料 | 问题会话根中的 `repo/`、`pipeline/` | 固定会话根、已有工作区挂载；没有需求流的硬编码 `../reviews` 提示 |

宿主 Write/Edit 完成后，逐条回执、MR 回复和当前机器反馈文件逐个交接给容器用户，
避免宿主 root 新建文件后容器只能读不能继续写。不会因此递归 chown 任务控制根。
文件门禁改用 lstat 识别悬空软链接，不能把它当作普通待创建文件绕过真实路径边界。

`chain_sha256` 仍检查当前 CHAIN 字节与 JSON 的一致性。回归覆盖“缺字段并连续
轮询失败 → 原地补齐 → ready 且清除 projection_error”；历史日志不能证明当前仍失败。

## 验收与部署

本机使用脚本模型和真实 SDK 文件工具验证嵌套分析目录：错误位置的回执不算闭环，
第一次确认卡被拦，同一会话写入正确文件后第二次确认卡通过。另覆盖普通插话与
工作台检视两条消费链、MR/流水线修复和文件边界。

真实容器专项回归由 `tests/taskAgentContainerPaths.test.ts` 承载，设置
`MFC_PATH_CONTAINER_IMAGE` 后运行；需要时用 `MFC_PATH_CONTAINER_USER` 指定
镜像数字用户。本次用本地 `mae-flow-task-builder:e2e-colima`（arm64、501:20）实际通过。
未设置镜像时明确 skip。其内容是嵌套目录下读写与宿主互通、
宿主写后容器续写以及控制文件不可见，不代替内网业务编译验收。

更新服务后，新建或正常恢复的会话获得新路径提示与挂载。本次未连接内网、
未移动 task-2 的任何文件、未替用户重跑已在等待确认的任务。已正常举卡的任务
继续由人确认；不要为了清理旧位置副本重新执行业务修改。
