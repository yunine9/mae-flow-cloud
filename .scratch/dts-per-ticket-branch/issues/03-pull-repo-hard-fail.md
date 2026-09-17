# 03: 拉仓硬失败:基线分支缺失不再退默认分支

**What to build:** 会话基线分支在远端仓不存在时,pull_repo 返回明确失败事实(附分支名),AI 如实上报、会话停在拉仓阶段;废除"退回默认分支继续"的 baselineMiss 降级,相关注释语义一并反转。无基线(无单/自研)路径不受影响,仍走默认分支。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] 基线分支在远端仓不存在:pull_repo 失败事实含分支名,不产生默认分支克隆
- [ ] 无基线的会话仍按默认分支克隆
- [ ] 行为测试用临时 bare 仓覆盖(先例:issueFlowFixed.part2 的 git 行为测试)
